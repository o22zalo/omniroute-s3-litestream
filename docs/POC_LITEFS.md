# POC LiteFS cho OmniRoute (infra-only)

## 1) Mục tiêu

POC này thay thế mô hình `elector + litestream + follower stop/remove` bằng kiến trúc LiteFS:

- Wrapper image bọc `diegosouzapw/omniroute:latest`.
- LiteFS mount + LiteFS proxy.
- Consul làm lease/election.
- Mọi instance đều chạy app (không stop follower).
- Cloudflared luôn trỏ vào LiteFS proxy (`omniroute-litefs:20128`).

Phạm vi thay đổi chỉ ở **infra**, không chỉnh source app upstream.

---

## 2) Giải thích kiến trúc project

### 2.1 Sơ đồ logic

```text
Cloudflare Tunnel
   -> cloudflared
   -> LiteFS proxy (:20128)
   -> OmniRoute app thật (:20129)
   -> /litefs/storage.sqlite
   -> LiteFS replication primary/replica
```

### 2.2 Vai trò từng thành phần

- **consul**: cung cấp distributed lease cho LiteFS để xác định primary.
- **omniroute-litefs**:
  - mount FUSE tại `/litefs`.
  - chạy LiteFS HTTP API tại `:20202`.
  - chạy LiteFS proxy tại `:20128`.
  - chạy app OmniRoute thật tại `:20129` thông qua `exec` trong LiteFS.
- **cloudflared**: ingress công khai, forward vào `omniroute-litefs:20128`.
- **dozzle/filebrowser**: tiện ích quan sát/log/file.

### 2.3 Cấu trúc file chính

- `docker-compose.yml`: định nghĩa stack runtime POC.
- `cloudflared/config.yml`: ingress routing qua LiteFS proxy.
- `litefs/Dockerfile`: wrapper image từ upstream.
- `litefs/litefs.yml`: cấu hình mount/proxy/lease/exec.
- `litefs/entrypoint.sh`: ép app dùng `DATA_DIR=/litefs`.
- `litefs/healthcheck.sh`: kiểm tra service proxy + file DB.
- `scripts/migrate-from-litestream.sh`: migration DB một lần.
- `scripts/litefs-smoke.sh`: smoke test nhanh.
- `scripts/litefs-soak.sh`: soak test dài.
- `scripts/resolve-instance-addr.sh`: resolve `INSTANCE_ADDR` khi dùng Tailscale/IP động.
- `scripts/resolve-consul-addr.sh`: tự chọn `CONSUL_HTTP_ADDR` từ danh sách endpoint Consul động.

---

## 3) Hướng dẫn triển khai chi tiết

## 3.1 Chuẩn bị

1. Tạo `.env` từ `.env.example`.
2. Điền tối thiểu:
   - `NEXT_PUBLIC_BASE_URL`
   - `INSTANCE_NAME`
   - `INSTANCE_ADDR` (IP/VPN/Tailscale reachable nếu multi-host)
   - secret app (`JWT_SECRET`, `API_KEY_SECRET`, ...)
3. Đảm bảo host hỗ trợ:
   - `/dev/fuse`
   - quyền `SYS_ADMIN`
   - Docker/Compose khả dụng

Ví dụ:

```bash
cp .env.example .env
```


## 3.1.1 Node IP động (Tailscale/GitHub Actions)

Nếu runner không có IP cố định, **không nên** set `INSTANCE_ADDR` bằng IP runtime.
Ưu tiên dùng MagicDNS ổn định của Tailscale.

Thiết lập nhanh:

```bash
export INSTANCE_ADDR=$(./scripts/resolve-instance-addr.sh)
export CONSUL_HTTP_ADDR=$(./scripts/resolve-consul-addr.sh)
```

Xem hướng dẫn chi tiết tại `docs/TAISCALE_LITEFS.md`.

## 3.2 Boot node đầu tiên (single-node)

```bash
docker compose up -d consul
docker compose up -d --build omniroute-litefs
```

Kiểm tra nhanh:

```bash
curl -fsS http://localhost:20128/api/storage/health
curl -fsS http://localhost:20128/v1/models >/dev/null
```

## 3.3 Migration DB từ hệ Litestream cũ

1. Dừng ghi từ app cũ.
2. Lấy DB hoàn chỉnh `storage.sqlite`.
3. Chạy migration/check integrity:

```bash
./scripts/migrate-from-litestream.sh ./data/storage.sqlite ./bootstrap/storage.sqlite
```

4. Copy DB vào node primary LiteFS (đích cuối cùng phải là `/litefs/storage.sqlite`).
5. Start lại app qua LiteFS và xác nhận health.

## 3.4 Join node thứ 2

- Trên node 2, dùng cùng `CONSUL_HTTP_ADDR`.
- Set khác `INSTANCE_NAME`, `INSTANCE_ADDR`.
- Start `omniroute-litefs` như node 1.

Sau đó kiểm tra:

- đọc được `/v1/models`.
- ghi qua replica vẫn thành công (proxy forward về primary).
- không có split-brain.

## 3.5 Bật public traffic qua cloudflared

Chỉ thực hiện sau khi pass test replication/failover:

```bash
docker compose up -d cloudflared
```

---


## 3.6 Giả lập kiểm thử 2 node chạy song song + report trạng thái

Dùng script `scripts/litefs-two-node-report.sh` để lấy report định lượng cho 2 node đang chạy thực tế.

```bash
./scripts/litefs-two-node-report.sh   http://node1.internal:20128   http://node2.internal:20128   600   5
```

Ý nghĩa tham số:

1. URL app node 1 (qua LiteFS proxy, thường port `20128`).
2. URL app node 2.
3. Tổng thời gian kiểm thử (giây).
4. Khoảng nghỉ giữa các mẫu (giây).
5. (tuỳ chọn) thư mục output report, mặc định `docs/reports`.

Output:

- Script sinh file markdown `docs/reports/litefs-two-node-report-<timestamp>.md`.
- Report có `Overall status`, bảng tỉ lệ thành công cho `health/models` từng node, và phần diễn giải.
- Có sẵn report mẫu tại `docs/reports/SAMPLE_TWO_NODE_REPORT.md`.

## 4) So sánh kết quả với yêu cầu trong prompt

| Hạng mục yêu cầu | Trạng thái | Ghi chú |
|---|---|---|
| Bỏ elector khỏi runtime chính | ✅ Done | `docker-compose.yml` không còn service `elector`. |
| Bỏ litestream khỏi runtime chính | ✅ Done | `docker-compose.yml` không còn service `litestream`. |
| Wrapper image từ `diegosouzapw/omniroute:latest` | ✅ Done | Có `litefs/Dockerfile`. |
| LiteFS mount + proxy | ✅ Done | Có trong `litefs/litefs.yml`. |
| Consul lease/election | ✅ Done | `lease.type=consul`, `consul.url/key/ttl`. |
| Mọi instance đều chạy app | ✅ Done | Không còn cơ chế stop follower trong compose. |
| Cloudflared trỏ LiteFS proxy | ✅ Done | `cloudflared/config.yml` trỏ `omniroute-litefs:20128`. |
| Script migration/smoke/soak | ✅ Done | Đã thêm 3 scripts trong `scripts/`. |
| Tài liệu rollout POC | ✅ Done | File này mô tả rollout + checklist. |

---

## 5) Điểm cần cải thiện tiếp theo

1. **Compose profile cho multi-node local test**
   - Thêm profile `node2/node3` để mô phỏng failover ngay trên 1 host.
2. **Bổ sung script kiểm thử failover chủ động**
   - Tự động kill primary, đo downtime, ghi báo cáo thời gian lease/promote.
3. **Quan sát trạng thái LiteFS chi tiết hơn**
   - Thêm script gọi HTTP API `:20202` để assert role primary/replica.
4. **Hardening cloudflared rollout**
   - Thêm hướng dẫn rollback nhanh về route cũ nếu lỗi production.
5. **Runbook production**
   - Bổ sung SOP cho backup định kỳ, disk-full, và restore drill.

---

## 6) Checklist PASS/FAIL khi nghiệm thu POC

### PASS

- 2 node cùng chạy app ổn định.
- Chỉ 1 primary tại một thời điểm.
- Ghi qua replica thành công (được forward).
- Failover trong ngưỡng downtime chấp nhận.
- Không còn custom leader election/runtime restore S3.

### FAIL

- Còn phải stop follower mới chạy được.
- App còn ghi ngoài `/litefs`.
- Có split-brain.
- FUSE không ổn định trên môi trường deploy.
- Traffic public không phục hồi sau failover.
