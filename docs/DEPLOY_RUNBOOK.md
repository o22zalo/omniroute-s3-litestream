# DEPLOY RUNBOOK — OmniRoute LiteFS + Consul (POC)

Tài liệu này là checklist triển khai theo từng bước, có tiêu chí **đúng/sai** và lệnh kiểm tra tương ứng.

---

## 0) Mục tiêu luồng đúng

Luồng đúng sau deploy:

1. `consul` chạy ổn định.
2. `omniroute-litefs` mount được FUSE + app chạy sau LiteFS proxy.
3. App phục vụ qua `:20128` (proxy), app thật ở `:20129`.
4. SQLite nằm trên `/litefs/storage.sqlite`.
5. Node 2 join được và không split-brain.
6. Chỉ sau khi pass bước 1-5 mới bật `cloudflared`.

---


## 0.1 Chạy nhanh bằng GitHub Actions

Repo đã có workflow `.github/workflows/deploy-litefs.yml` để bạn chỉ cần bấm chạy và kiểm tra.

Secrets tối thiểu cần set:

- `TS_AUTHKEY`
- `TS_TAILNET`
- `CONSUL_CANDIDATES`
- `NEXT_PUBLIC_BASE_URL`
- `JWT_SECRET`
- `API_KEY_SECRET`
- `MACHINE_ID_SALT`
- `STORAGE_ENCRYPTION_KEY`
- `INITIAL_PASSWORD`

Cách chạy:

1. Vào **Actions** -> `deploy-litefs`.
2. Chọn `node_slot` (1/2/3...) để workflow tự đặt hostname Tailscale ổn định.
3. Chọn `skip_cloudflared=true` cho lần chạy kiểm tra nội bộ trước.
4. Run workflow và xem bước `Wait for health` + `Smoke test`.

---

## 1) Preflight

## 1.1 Chuẩn bị env

```bash
cp .env.example .env
```

Điền tối thiểu trong `.env`:

- `NEXT_PUBLIC_BASE_URL`
- `INSTANCE_NAME`
- `JWT_SECRET`, `API_KEY_SECRET`, `MACHINE_ID_SALT`, `STORAGE_ENCRYPTION_KEY`, `INITIAL_PASSWORD`

Nếu node IP động:

```bash
export INSTANCE_ADDR=$(./scripts/resolve-instance-addr.sh)
export CONSUL_HTTP_ADDR=$(./scripts/resolve-consul-addr.sh)
```

### PASS
- `.env` tồn tại và có đủ secret bắt buộc.
- `INSTANCE_ADDR` resolve được.
- `CONSUL_HTTP_ADDR` resolve ra endpoint Consul đang có leader.

### FAIL
- Script resolve báo lỗi không tìm thấy DNS/Consul khỏe.

---

## 1.2 Kiểm tra môi trường runtime

```bash
test -e /dev/fuse && echo "fuse ok"
```

### PASS
- Có `/dev/fuse`.

### FAIL
- Không có `/dev/fuse` -> LiteFS không mount được.

---

## 2) Boot node 1 (single-node)

## 2.1 Start Consul

```bash
docker compose up -d consul
```

Kiểm tra:

```bash
curl -fsS ${CONSUL_HTTP_ADDR:-http://localhost:8500}/v1/status/leader
```

### PASS
- Trả về chuỗi địa chỉ leader (không rỗng, không `""`).

### FAIL
- Không có leader -> chưa nên start app.

---

## 2.2 Start omniroute-litefs

```bash
docker compose up -d --build omniroute-litefs
```

Kiểm tra health container:

```bash
docker compose ps omniroute-litefs
```

### PASS
- Trạng thái `running` và health `healthy`.

### FAIL
- `unhealthy` hoặc restart loop -> xem `docker compose logs omniroute-litefs`.

---

## 2.3 Verify app path/proxy đúng luồng

```bash
curl -fsS http://localhost:20128/api/storage/health
curl -fsS http://localhost:20128/v1/models >/dev/null
```

### PASS
- Cả 2 lệnh trả 2xx.

### FAIL
- Timeout/5xx -> kiểm tra logs LiteFS + app.

---

## 3) Migration DB từ hệ cũ (nếu có)

## 3.1 Chuẩn bị DB nguồn

Dừng ghi app cũ, lấy file `storage.sqlite` chuẩn.

## 3.2 Chạy migration + integrity check

```bash
./scripts/migrate-from-litestream.sh ./data/storage.sqlite ./bootstrap/storage.sqlite
```

### PASS
- Script in ra `PRAGMA integrity_check` kết quả `ok`.

### FAIL
- DB lỗi integrity -> dừng rollout, lấy bản DB khác.

---

## 4) Join node 2

Trên node 2:

1. Set `INSTANCE_NAME` khác node 1.
2. Resolve `INSTANCE_ADDR` + `CONSUL_HTTP_ADDR`.
3. `docker compose up -d --build omniroute-litefs`.

Kiểm tra từ node 2:

```bash
curl -fsS http://localhost:20128/api/storage/health
curl -fsS http://localhost:20128/v1/models >/dev/null
```

### PASS
- Node 2 phục vụ read bình thường.
- Không phát hiện split-brain (Consul chỉ có 1 leader lock).

### FAIL
- Node 2 không đọc được hoặc mất đồng bộ liên tục.

---

## 5) Kiểm thử song song 2 node + report

```bash
./scripts/litefs-two-node-report.sh \
  http://node1.internal:20128 \
  http://node2.internal:20128 \
  600 \
  5
```

### PASS
- Report tạo thành công trong `docs/reports/`.
- `Overall status` là `PASS` hoặc `WARN` thấp, tỷ lệ thành công cao.

### FAIL
- `FAIL_EVENTS` cao, tỷ lệ health/models thấp.

---

## 6) Bật cloudflared (chỉ sau khi pass)

```bash
docker compose up -d cloudflared
```

Kiểm tra:

- Truy cập public domain app.
- Theo dõi log cloudflared và omniroute-litefs.

### PASS
- Public domain trả về bình thường.

### FAIL
- 502/route lỗi -> rollback traffic về route cũ.

---

## 7) Smoke + Soak test sau cutover

Smoke:

```bash
./scripts/litefs-smoke.sh http://localhost:20128
```

Soak 2 giờ (ví dụ):

```bash
./scripts/litefs-soak.sh http://localhost:20128 7200 2
```

### PASS
- Smoke OK.
- Soak không có lỗi hoặc lỗi rất thấp theo ngưỡng chấp nhận.

### FAIL
- lỗi lặp lại -> dừng scale-out, kiểm tra lease/proxy/IO.

---

## 8) Tiêu chí chốt “đúng luồng”

Đánh dấu **DONE** khi đạt đủ:

- [ ] Consul có leader ổn định.
- [ ] Node 1 healthy, app qua proxy ổn định.
- [ ] DB migrate integrity OK (nếu có migration).
- [ ] Node 2 join thành công, không split-brain.
- [ ] Report 2-node hợp lệ và đạt ngưỡng.
- [ ] Cloudflared public traffic ổn định sau cutover.
- [ ] Smoke + soak đạt yêu cầu.

Nếu thiếu bất kỳ mục nào -> coi là rollout **chưa đạt**.
