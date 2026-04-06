# Tailscale cho LiteFS khi node không có IP cố định

Tài liệu này mô tả cách giữ `INSTANCE_ADDR` ổn định cho LiteFS trong môi trường node IP động (đặc biệt GitHub Actions).

## Vấn đề

- LiteFS cần `advertise-url` ổn định để các node khác kết nối đúng.
- Nếu chỉ dùng IP private của runner thì mỗi lần job chạy IP đổi.
- Với Tailscale, DNS có thể bị tăng index (`-1`, `-2`, ... ) nếu hostname không cố định.

## Mục tiêu

- Luôn cấp cho node một định danh ổn định để điền `INSTANCE_ADDR`.
- Ưu tiên dùng **MagicDNS ổn định** thay vì IP.

---

## Cách 1 (khuyến nghị): đặt hostname Tailscale cố định theo slot node

Dùng `tailscale up --hostname <name-co-dinh>` để DNS name không drift theo index.

Ví dụ mapping slot:

- node A: `omniroute-node-1`
- node B: `omniroute-node-2`

Khi đó `INSTANCE_ADDR` có thể set thành:

- `omniroute-node-1.<tailnet>.ts.net`
- `omniroute-node-2.<tailnet>.ts.net`

### Ví dụ cho GitHub Actions (matrix 2 node)

```yaml
strategy:
  matrix:
    node_slot: [1, 2]

steps:
  - name: Connect Tailscale
    run: |
      sudo tailscale up \
        --authkey="${{ secrets.TS_AUTHKEY }}" \
        --hostname="omniroute-node-${{ matrix.node_slot }}" \
        --accept-dns=true \
        --reset

  - name: Resolve INSTANCE_ADDR
    run: |
      echo "TS_NODE_NAME=omniroute-node-${{ matrix.node_slot }}" >> $GITHUB_ENV
      echo "TAILSCALE_TAILNET=${{ secrets.TS_TAILNET }}" >> $GITHUB_ENV
      echo "INSTANCE_ADDR=$(./scripts/resolve-instance-addr.sh)" >> $GITHUB_ENV
```

> Lưu ý: để hostname reuse ổn định, runner cần quyền đăng ký thiết bị phù hợp policy tailnet.

---

## Cách 2: set thẳng `TS_DNS_NAME`

Nếu bạn đã biết chắc MagicDNS canonical của từng node, set trực tiếp:

```bash
export TS_DNS_NAME=omniroute-node-1.yourtailnet.ts.net
export INSTANCE_ADDR=$(./scripts/resolve-instance-addr.sh)
```

---

## Cách 3: fallback từ `tailscale status --json`

Script `scripts/resolve-instance-addr.sh` có fallback đọc `Self.DNSName` từ local daemon khi không có biến env.

```bash
INSTANCE_ADDR=$(./scripts/resolve-instance-addr.sh)
```

Ưu điểm: không cần hardcode. Nhược: nếu DNS name của node bị drift index thì kết quả cũng drift.

---

## Tích hợp với compose

Trước khi `docker compose up`, export `INSTANCE_ADDR` từ script:

```bash
export INSTANCE_ADDR=$(./scripts/resolve-instance-addr.sh)
docker compose up -d consul
docker compose up -d --build omniroute-litefs
```

LiteFS đọc `INSTANCE_ADDR` qua env và đưa vào `lease.advertise-url`.

---

## Khuyến nghị vận hành cho GitHub Actions

1. Dùng matrix slot cố định (`1`, `2`, `3`) tương ứng hostname cố định.
2. Không dùng hostname theo `run_id` nếu muốn cluster identity ổn định.
3. Nếu buộc phải ephemeral hostname, luôn resolve `INSTANCE_ADDR` mỗi run và đẩy vào env trước khi compose.
4. Theo dõi Consul key `litefs/omniroute/primary` khi deploy để đảm bảo không split-brain.
