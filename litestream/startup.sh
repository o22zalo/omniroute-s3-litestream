#!/bin/sh
# ══════════════════════════════════════════════════════════════════════
# litestream/startup.sh
#
# FIX: Phân biệt 3 trường hợp:
#   A) Không có replica trên S3 → start fresh (OK)
#   B) Có replica, restore thành công → start replicate (OK)
#   C) Có replica, restore THẤT BẠI → EXIT 1 (refuse to start!)
#      Lý do: tránh ghi đè data cũ bằng DB rỗng sau khi elector
#      restart và start litestream với credentials lỗi/network lỗi
# ══════════════════════════════════════════════════════════════════════
set -e

DB_PATH="/app/data/storage.sqlite"
CONFIG_PATH="/etc/litestream.yml"

echo "[startup] ════════════════════════════════════"
echo "[startup]  Litestream Startup"
echo "[startup]  DB        : ${DB_PATH}"
echo "[startup]  Bucket    : ${LITESTREAM_BUCKET:-<not set>}"
echo "[startup]  Supabase  : ${SUPABASE_PROJECT_REF:-<not set>}"
echo "[startup] ════════════════════════════════════"

# ── Validate config ───────────────────────────────────────────────────
if [ ! -f "${CONFIG_PATH}" ]; then
  echo "[startup] ✖ Config không tìm thấy: ${CONFIG_PATH}"
  exit 1
fi

# Tạo thư mục data nếu chưa có
mkdir -p "$(dirname "${DB_PATH}")"

# ── Quyết định restore hay không ─────────────────────────────────────
if [ -f "${DB_PATH}" ]; then
  # DB đã tồn tại locally → bỏ qua restore
  DB_SIZE=$(du -sh "${DB_PATH}" 2>/dev/null | cut -f1 || echo "?")
  echo "[startup] ✅ Local DB đã tồn tại (${DB_SIZE}) — bỏ qua restore"

else
  echo "[startup] Không có local DB — kiểm tra S3..."

  # ── CHECK: Có snapshot trên S3 không? ─────────────────────────────
  # 'litestream snapshots' liệt kê snapshots cho DB
  # Nếu không có gì → output rỗng
  SNAPSHOT_OUTPUT=$(litestream snapshots \
    -config "${CONFIG_PATH}" \
    "${DB_PATH}" 2>/dev/null || echo "")

  if echo "${SNAPSHOT_OUTPUT}" | grep -q .; then
    # CASE B/C: Có replica trên S3
    echo "[startup] ✅ Tìm thấy replica trên S3:"
    echo "${SNAPSHOT_OUTPUT}" | head -5

    echo "[startup] Đang restore từ S3..."

    # KHÔNG dùng -if-replica-exists vì chúng ta đã biết replica tồn tại
    # → Nếu restore fail = lỗi thực sự (credentials sai, network lỗi, v.v.)
    # → Exit 1 để elector không start omniroute với DB rỗng
    if litestream restore \
        -config "${CONFIG_PATH}" \
        -o "${DB_PATH}" \
        "${DB_PATH}"; then

      DB_SIZE=$(du -sh "${DB_PATH}" 2>/dev/null | cut -f1 || echo "?")
      echo "[startup] ✅ Restore thành công (${DB_SIZE})"

    else
      EXIT_CODE=$?
      echo "[startup] ════════════════════════════════════"
      echo "[startup] ✖ FATAL: Restore THẤT BẠI (exit ${EXIT_CODE})"
      echo "[startup]"
      echo "[startup] Replica tồn tại trên S3 nhưng không restore được."
      echo "[startup] Từ chối start để tránh ghi đè data cũ bằng DB rỗng."
      echo "[startup]"
      echo "[startup] Kiểm tra:"
      echo "[startup]   1. LITESTREAM_ACCESS_KEY_ID và SECRET có đúng không?"
      echo "[startup]   2. SUPABASE_PROJECT_REF có đúng không?"
      echo "[startup]   3. Network có reach được Supabase S3 endpoint không?"
      echo "[startup]   4. Bucket '${LITESTREAM_BUCKET:-?}' có tồn tại không?"
      echo "[startup] ════════════════════════════════════"
      exit 1
    fi

  else
    # CASE A: Không có replica → start fresh
    echo "[startup] Không tìm thấy replica trên S3 — bắt đầu với DB mới"
  fi
fi

# ── Start replication ─────────────────────────────────────────────────
echo "[startup] Khởi động Litestream replication..."
exec litestream replicate -config "${CONFIG_PATH}"
