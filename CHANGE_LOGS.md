# Change Logs

## [2026-04-05] feat: multi-instance leader election + litestream restore hardening

### services/elector/ (NEW)
- **Dockerfile**: Alpine 3.19 + bash + curl + jq + docker-cli
- **elector.sh**: Leader election daemon dùng Firebase RTDB conditional PUT (If-Match ETag)
  - Unique INSTANCE_ID per container lifecycle (/proc/sys/kernel/random/uuid)
  - Docker Compose project name lowercase để match container labels chính xác
  - RTDB base/query URL separation để handle `?auth=TOKEN` trong URL
  - try_acquire_lock(): atomic compare-and-swap qua HTTP 200/412 response code
  - check_still_leader(): chịu đựng RTDB flaky tối đa 3 heartbeat trước khi demote
  - on_become_leader(): start thứ tự litestream → wait_healthy(180s) → omniroute → cloudflared
  - on_become_follower(): stop thứ tự cloudflared(10s) → omniroute(35s) → litestream(15s)
  - svc_ensure_running(): health monitor trong heartbeat loop, tự restart crashed services
  - cleanup trap: graceful shutdown — demote trước khi exit để leader mới không phải chờ TTL

### docker-compose.yml (MODIFIED)
- Thêm service `elector` với docker socket mount (/var/run/docker.sock)
- Đổi restart policy của litestream/omniroute/cloudflared → `restart: "no"`
  - Lý do: tránh race condition, elector là sole owner của start/stop
- Xóa depends_on omniroute → litestream (elector xử lý ordering)
- Thêm `INSTANCE_ID` env var cho elector
- Tăng litestream healthcheck start_period 30s → 120s
- Thêm logging config cho tất cả services (max-size: 10m)

### litestream/startup.sh (MODIFIED)
- Thay `-if-replica-exists` bằng 2-phase check:
  1. `litestream snapshots` để biết có replica không
  2. Nếu có → restore WITHOUT -if-replica-exists
  3. Nếu restore fail → **exit 1** (refuse to start với DB rỗng)
- Trước: silent fail → start với empty DB → mất data
- Sau: hard fail → elector retry → không bao giờ ghi đè data cũ

### .github/workflows/deploy.yml (MODIFIED)
- STEP 2b: Inject INSTANCE_ID = "{run_id}-{attempt}-{runner_name}"
- STEP 3: Force leader lock takeover trước deploy (DELETE RTDB lock)
  - Cho phép instance mới win election ngay, không phải chờ TTL 30s
- STEP 6: Poll RTDB confirm instance này đã là leader trước keepalive
