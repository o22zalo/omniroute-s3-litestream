#!/usr/bin/env node
'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');

const execFileAsync = promisify(execFile);

const RTDB_URL = process.env.RTDB_URL;
if (!RTDB_URL) {
  console.error('RTDB_URL is required');
  process.exit(1);
}

const [rtdbRawBase, rtdbQueryRaw = ''] = RTDB_URL.split('?');
const RTDB_BASE = rtdbRawBase.replace(/\/+$/, '').replace(/\.json$/, '');
const RTDB_QUERY = rtdbQueryRaw;

const LOCK_TTL = Number(process.env.LEADER_LOCK_TTL || 30);
const HEARTBEAT = Number(process.env.HEARTBEAT_INTERVAL || 10);
const projectRaw = process.env.COMPOSE_PROJECT_NAME || 'omniroute-s3-litestream';
const PROJECT = projectRaw
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/^-+/, '')
  .replace(/-+$/, '') || 'omniroute-s3-litestream';
const LOCK_KEY = process.env.LEADER_LOCK_KEY || `leader-lock-${PROJECT}`;

const ID_FILE = '/tmp/elector-instance-id';
let INSTANCE_ID = process.env.INSTANCE_ID || '';

const LEADER_SERVICES = ['litestream', 'omniroute', 'cloudflared'];
const FOLLOWER_STOP_ORDER = ['cloudflared', 'omniroute', 'litestream'];

let isLeader = false;
let rtdbErrCount = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[elector ${t}] ${msg}`);
}
function warn(msg) {
  console.error(`[elector ${new Date().toISOString().slice(11, 19)}] ⚠  ${msg}`);
}

if (process.env.COMPOSE_PROJECT_NAME === 'COMPOSE_PROJECT_NAME') {
  warn('COMPOSE_PROJECT_NAME đang là placeholder literal');
}
if (process.env.INSTANCE_ID === 'INSTANCE_ID') {
  warn('INSTANCE_ID đang là placeholder literal');
}

function buildUrl(path) {
  const base = `${RTDB_BASE}/${path}.json`;
  return RTDB_QUERY ? `${base}?${RTDB_QUERY}` : base;
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  return { res, text };
}

async function rtdbGet(path) {
  const { res, text } = await httpJson(buildUrl(path), {
    headers: { 'X-Firebase-ETag': 'true' }
  });
  return {
    ok: res.ok,
    status: res.status,
    etag: res.headers.get('etag') || '',
    body: text || 'null'
  };
}

async function rtdbPut(path, payload) {
  const { res } = await httpJson(buildUrl(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.status;
}

async function rtdbConditionalPut(path, payload, etag) {
  const { res } = await httpJson(buildUrl(path), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': etag ? `"${etag}"` : '""'
    },
    body: JSON.stringify(payload)
  });
  return res.status;
}

async function rtdbDelete(path) {
  await httpJson(buildUrl(path), { method: 'DELETE' });
}

async function docker(args, { ignoreError = false } = {}) {
  try {
    const { stdout } = await execFileAsync('docker', args, { maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    if (ignoreError) return '';
    throw err;
  }
}

async function getContainerName(service) {
  return docker([
    'ps', '-a',
    '--filter', `label=com.docker.compose.service=${service}`,
    '--filter', `label=com.docker.compose.project=${PROJECT}`,
    '--format', '{{.Names}}'
  ], { ignoreError: true }).then((o) => o.split('\n')[0] || '');
}

async function isRunning(service) {
  const c = await getContainerName(service);
  if (!c) return false;
  const out = await docker(['inspect', '-f', '{{.State.Running}}', c], { ignoreError: true });
  return out === 'true';
}

async function getHealth(service) {
  const c = await getContainerName(service);
  if (!c) return 'missing';
  const out = await docker([
    'inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}', c
  ], { ignoreError: true });
  return out || 'unknown';
}

async function svcStart(service) {
  const c = await getContainerName(service);
  if (!c) return warn(`Container không tìm thấy cho service: ${service}`);
  if (await isRunning(service)) return log(`ℹ  ${service} đã đang chạy`);
  log(`▶ Starting ${service} (${c})...`);
  await docker(['start', c], { ignoreError: true });
}

async function svcStop(service, timeout = 10) {
  const c = await getContainerName(service);
  if (!c) return;
  if (!(await isRunning(service))) return;
  log(`■ Stopping ${service} (grace=${timeout}s)...`);
  await docker(['stop', '-t', String(timeout), c], { ignoreError: true });
}

async function waitHealthy(service, timeout = 180) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeout) {
    const h = await getHealth(service);
    if (h === 'healthy' || h === 'no-healthcheck') return true;
    if (h === 'unhealthy' || h === 'missing') return false;
    await sleep(5000);
  }
  return false;
}

function makePayload() {
  const now = nowSec();
  return {
    instance_id: INSTANCE_ID,
    expires_at: now + LOCK_TTL,
    acquired_at: now
  };
}

async function tryAcquireLock() {
  try {
    const current = await rtdbGet(LOCK_KEY);
    if (current.status >= 500) throw new Error(`RTDB status ${current.status}`);
    rtdbErrCount = 0;

    const data = JSON.parse(current.body || 'null');
    const holder = data?.instance_id || '';
    const expires = Number(data?.expires_at || 0);

    if (holder === INSTANCE_ID) {
      await rtdbPut(LOCK_KEY, makePayload());
      return true;
    }

    if (!data || expires < nowSec()) {
      const code = await rtdbConditionalPut(LOCK_KEY, makePayload(), current.etag);
      if (code === 200) {
        log('ℹ  🏆 Thắng election (HTTP 200)');
        return true;
      }
      log(`ℹ  Thua election race (HTTP ${code}) — instance khác nhanh hơn`);
    }
    return false;
  } catch (e) {
    rtdbErrCount += 1;
    warn(`RTDB không phản hồi (lần ${rtdbErrCount}): ${e.message}`);
    return false;
  }
}

async function checkStillLeader() {
  try {
    const current = await rtdbGet(LOCK_KEY);
    const data = JSON.parse(current.body || 'null');
    const holder = data?.instance_id || '';
    const expires = Number(data?.expires_at || 0);
    if (holder === INSTANCE_ID && expires > nowSec()) return true;
    return false;
  } catch {
    rtdbErrCount += 1;
    warn(`RTDB unreachable trong heartbeat (${rtdbErrCount}/3)`);
    return rtdbErrCount < 3;
  }
}

async function releaseLock() {
  try {
    const current = await rtdbGet(LOCK_KEY);
    const data = JSON.parse(current.body || 'null');
    if (data?.instance_id === INSTANCE_ID) {
      await rtdbDelete(LOCK_KEY);
      log('🔓 Lock released');
    }
  } catch {
    // noop
  }
}

async function onBecomeLeader() {
  log('══════════════════════════════════════');
  log(`🎉 LEADER — ${INSTANCE_ID}`);
  log('══════════════════════════════════════');
  isLeader = true;

  await svcStart('litestream');
  const healthy = await waitHealthy('litestream', 180);
  if (!healthy) warn('Litestream chưa healthy — omniroute sẽ start nhưng backup có thể bị lag');
  await svcStart('omniroute');
  await svcStart('cloudflared');
}

async function onBecomeFollower() {
  log('══════════════════════════════════════');
  log(`📡 FOLLOWER — ${INSTANCE_ID}`);
  log('══════════════════════════════════════');
  isLeader = false;
  await svcStop('cloudflared', 10);
  await svcStop('omniroute', 35);
  await svcStop('litestream', 15);
}

async function ensureInstanceId() {
  try {
    INSTANCE_ID = (await fs.readFile(ID_FILE, 'utf8')).trim();
  } catch {
    const id = (process.env.INSTANCE_ID || randomUUID().replaceAll('-', '').slice(0, 16)).trim();
    await fs.writeFile(ID_FILE, id, 'utf8');
    INSTANCE_ID = id;
  }
}

async function cleanup() {
  log('🛑 Elector shutting down (signal received)...');
  if (isLeader) {
    await onBecomeFollower();
    await releaseLock();
  }
  log(`Goodbye from ${INSTANCE_ID}`);
  process.exit(0);
}

async function main() {
  await ensureInstanceId();

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  log('╔══════════════════════════════════════╗');
  log('║  Leader Elector starting             ║');
  log('╠══════════════════════════════════════╣');
  log(`║ Instance  : ${INSTANCE_ID}`);
  log(`║ Project   : ${PROJECT}`);
  log(`║ Lock key  : ${LOCK_KEY}`);
  log(`║ TTL       : ${LOCK_TTL}s`);
  log(`║ Heartbeat : ${HEARTBEAT}s`);
  log('╚══════════════════════════════════════╝');

  log('Init: stopping all managed services...');
  for (const svc of FOLLOWER_STOP_ORDER) {
    await svcStop(svc, 5);
  }
  log('Init complete — bắt đầu election loop');

  while (true) {
    if (isLeader) {
      if (await checkStillLeader()) {
        await rtdbPut(LOCK_KEY, makePayload());
        for (const svc of LEADER_SERVICES) {
          if (!(await isRunning(svc))) {
            warn(`${svc} crashed, restarting...`);
            await svcStart(svc);
          }
        }
        log(`💚 Heartbeat OK — leader=${INSTANCE_ID}`);
      } else {
        warn('❌ Mất leader lock!');
        await onBecomeFollower();
      }
    } else {
      if (await tryAcquireLock()) {
        await onBecomeLeader();
      } else {
        try {
          const cur = await rtdbGet(LOCK_KEY);
          const data = JSON.parse(cur.body || 'null');
          log(`👥 Follower — leader hiện tại: ${data?.instance_id || 'unknown'}`);
        } catch {
          log('👥 Follower — leader hiện tại: unknown');
        }
      }
    }

    await sleep(HEARTBEAT * 1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
