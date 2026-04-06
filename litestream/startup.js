#!/usr/bin/env node
"use strict";

/**
 * litestream/startup.js
 *
 * Logic hiện tại:
 *   A) Luôn probe S3 (snapshots + generations)
 *   B) Nếu S3 đã có dữ liệu -> restore bắt buộc (kể cả local DB đã tồn tại)
 *   C) Nếu S3 chưa có dữ liệu -> dùng local DB (nếu có) hoặc start fresh
 *
 * Nếu S3 check bị lỗi (network/credentials) → hard exit, không start với DB rỗng.
 */

const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ──────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || "/app/data/storage.sqlite";
const CONFIG_PATH = process.env.LITESTREAM_CONFIG || "/etc/litestream.yml";

// ──────────────────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────────────────
const log = (...a) => console.log("[startup]", ...a);
const warn = (...a) => console.error("[startup] ⚠", ...a);
const fatal = (msg) => {
  console.error("[startup] ✖ FATAL:", msg);
  process.exit(1);
};

// ──────────────────────────────────────────────────────────────────────
// Shell helper — trả về { ok, stdout, stderr, exitCode }
// ──────────────────────────────────────────────────────────────────────
function run(cmd, args, { timeout = 300_000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024 });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    exitCode: r.status ?? -1,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Validate config
// ──────────────────────────────────────────────────────────────────────
function validateConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fatal(`Config không tìm thấy: ${CONFIG_PATH}`);
  }
  const cfgStat = fs.statSync(CONFIG_PATH);
  if (!cfgStat.isFile()) {
    fatal(`CONFIG_PATH là thư mục, không phải file: ${CONFIG_PATH}`);
  }
  // Đảm bảo thư mục chứa DB tồn tại
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

function nonEmptyLines(s) {
  return (s || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function extractGenerationId(line) {
  if (!line) return null;
  const m = line.match(/\b([a-f0-9]{16})\b/i);
  return m ? m[1] : null;
}

function moveFileSafely(src, dest) {
  try {
    fs.renameSync(src, dest);
    return;
  } catch (e) {
    // EXDEV: cross-device link (ví dụ /tmp và /app/data khác mount/device)
    if (e && e.code === "EXDEV") {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
      return;
    }
    throw e;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Case A: local DB đã tồn tại
// ──────────────────────────────────────────────────────────────────────
function localDbExists() {
  try {
    const stat = fs.statSync(DB_PATH);
    return stat.size > 0;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Case B/C: kiểm tra S3 có dữ liệu không
// Tiêu chí:
//   1) snapshots có dòng output
//   2) HOẶC generations có dòng output (theo path trên replica)
// Trả về object để log/debug chi tiết.
// ──────────────────────────────────────────────────────────────────────
function probeS3ReplicaState() {
  log("Không có local DB — kiểm tra S3 snapshot...");

  const snap = run("litestream", ["snapshots", "-config", CONFIG_PATH, DB_PATH]);
  if (snap.stderr) {
    snap.stderr.split("\n").forEach((line) => warn("[snapshots]", line));
  }

  if (!snap.ok) {
    log("════════════════════════════════════════");
    fatal(
      `litestream snapshots thất bại (exit ${snap.exitCode})\n` +
        `Không thể xác định trạng thái S3 — từ chối start với DB rỗng.\n` +
        `Nguyên nhân thường gặp:\n` +
        `  1. SUPABASE_PROJECT_REF sai hoặc chưa set\n` +
        `  2. LITESTREAM_ACCESS_KEY_ID / SECRET sai\n` +
        `  3. Bucket '${process.env.LITESTREAM_BUCKET || "?"}' chưa tạo trong Supabase Storage\n` +
        `  4. Endpoint S3 không đúng (kiểm tra litestream.yml)\n` +
        `  5. Network không reach được Supabase`,
    );
  }

  const snapshots = nonEmptyLines(snap.stdout);
  const hasSnapshot = snapshots.length > 0;

  // Kiểm tra thêm theo path/generation để debug rõ hơn.
  // Nếu command không support trong bản litestream hiện tại thì chỉ cảnh báo.
  const gen = run("litestream", ["generations", "-config", CONFIG_PATH, DB_PATH], { timeout: 120_000 });
  if (!gen.ok && gen.stderr) {
    warn(`[generations] exit ${gen.exitCode}: ${gen.stderr}`);
  }
  const generations = nonEmptyLines(gen.stdout);
  const hasGeneration = gen.ok && generations.length > 0;

  log(
    `S3 probe result: snapshots=${snapshots.length}, generations=${generations.length}, ` +
      `bucket=${process.env.LITESTREAM_BUCKET || "?"}, path=${process.env.LITESTREAM_PATH || "storage"}`,
  );

  if (snapshots.length) {
    log(`Snapshot mới nhất: ${snapshots[0]}`);
  }
  if (generations.length) {
    log(`Generation mới nhất: ${generations[0]}`);
    const genId = extractGenerationId(generations[0]);
    if (genId) {
      const prefix = process.env.LITESTREAM_PATH || "storage";
      log(`S3 breadcrumb: ${prefix} => generations => ${genId}`);
    }
  }

  return {
    hasData: hasSnapshot || hasGeneration,
    hasSnapshot,
    hasGeneration,
    snapshots,
    generations,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Restore từ S3
// ──────────────────────────────────────────────────────────────────────
function restoreFromS3() {
  log("✅ Tìm thấy snapshot trên S3 — bắt đầu restore...");

  const tmpPath = path.join(os.tmpdir(), `storage.restore.${process.pid}.sqlite`);

  // Dọn dẹp file tạm cũ nếu có
  try {
    fs.unlinkSync(tmpPath);
  } catch {}

  const r = run("litestream", ["restore", "-config", CONFIG_PATH, "-o", tmpPath, DB_PATH], { timeout: 600_000 }); // 10 phút — DB lớn cần thêm thời gian

  if (!r.ok) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    fatal(
      `Restore thất bại (exit ${r.exitCode})\n${r.stderr}\n` +
        `Kiểm tra:\n` +
        `  1. Credentials S3 có đúng không?\n` +
        `  2. Network có reach được Supabase không?\n` +
        `  3. Bucket '${process.env.LITESTREAM_BUCKET || "?"}' có tồn tại không?`,
    );
  }

  // Verify file tạm tồn tại và có dữ liệu
  let stat;
  try {
    stat = fs.statSync(tmpPath);
  } catch {
    fatal(`Restore báo thành công nhưng không tìm thấy file tạm: ${tmpPath}`);
  }
  if (stat.size === 0) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    fatal("Restore tạo ra file rỗng — có thể snapshot bị lỗi.");
  }

  // Atomic move về DB_PATH
  try {
    fs.unlinkSync(DB_PATH);
  } catch {}
  try {
    moveFileSafely(tmpPath, DB_PATH);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    fatal(`Không thể move DB restore về đích (${tmpPath} -> ${DB_PATH}): ${e.message}`);
  }

  const finalStat = fs.statSync(DB_PATH);
  log(`✅ Restore thành công (${(finalStat.size / 1024).toFixed(1)} KB)`);
}

// ──────────────────────────────────────────────────────────────────────
// Exec litestream replicate (replace current process)
// ──────────────────────────────────────────────────────────────────────
function startReplicate() {
  log("Khởi động Litestream replication...");

  // Dùng spawn thay vì spawnSync để không block + forward signals đúng
  const child = spawn("litestream", ["replicate", "-config", CONFIG_PATH], {
    stdio: "inherit",
    detached: false,
  });

  child.on("error", (e) => fatal(`Không thể start litestream replicate: ${e.message}`));
  child.on("exit", (code, signal) => {
    if (signal) {
      log(`litestream replicate kết thúc do signal: ${signal}`);
      process.exit(0);
    }
    log(`litestream replicate thoát với code: ${code}`);
    process.exit(code ?? 1);
  });

  // Forward signals xuống child
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      log(`Nhận ${sig} — forward xuống litestream`);
      child.kill(sig);
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────
function main() {
  log("════════════════════════════════════════");
  log(" Litestream Startup (Node.js)");
  log(` DB        : ${DB_PATH}`);
  log(` Config    : ${CONFIG_PATH}`);
  log(` Bucket    : ${process.env.LITESTREAM_BUCKET || "<not set>"}`);
  log(` Supabase  : ${process.env.SUPABASE_PROJECT_REF || "<not set>"}`);
  log(` S3 path   : ${process.env.LITESTREAM_PATH || "storage"}`);
  log("════════════════════════════════════════");

  validateConfig();

  const hasLocalDb = localDbExists();
  if (hasLocalDb) {
    const size = (fs.statSync(DB_PATH).size / 1024).toFixed(1);
    log(`✅ Local DB đã tồn tại (${size} KB)`);
  } else {
    log("ℹ Local DB chưa tồn tại.");
  }

  // Luôn probe S3 để tránh skip restore nhầm khi local DB tồn tại nhưng stale/rỗng logic.
  const probe = probeS3ReplicaState();

  if (probe.hasData) {
    // Nếu S3 đã có dữ liệu, luôn restore để đảm bảo node vào đúng shared state trước khi replicate.
    // Điều này ngăn trường hợp omniroute chạy trên local DB cũ/chưa đồng bộ.
    if (hasLocalDb) {
      log("S3 đã có dữ liệu => sẽ restore đè local DB để đảm bảo nhất quán trước khi start app.");
    }
    restoreFromS3();
  } else {
    // S3 kết nối OK nhưng chưa có data.
    if (hasLocalDb) {
      log("ℹ S3 chưa có dữ liệu — dùng local DB hiện có và bắt đầu replicate.");
    } else {
      log("ℹ Không tìm thấy snapshot/generation trên S3 (fresh install) — bắt đầu với DB mới");
    }
  }

  startReplicate();
}

main();
