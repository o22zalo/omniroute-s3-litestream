#!/bin/sh
# ══════════════════════════════════════════════════════════════════════
# litestream/startup.sh
#
# 3 trường hợp:
#   A) Local DB đã tồn tại → skip restore, replicate luôn
#   B) Không có local DB + không có replica S3 → start fresh
#   C) Không có local DB + có replica S3 → restore (fail hard nếu lỗi)
#
# FIX: bỏ flag -o (output path) để litestream tự quyết định path
#      từ config, tránh lỗi "output path already exists"
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

if [ ! -f "${CONFIG_PATH}" ]; then
  echo "[startup] ✖ Config không tìm thấy: ${CONFIG_PATH}"
  exit 1
fi

mkdir -p "$(dirname "${DB_PATH}")"

# ── CASE A: Local DB đã tồn tại → skip restore ───────────────────────
if [ -f "${DB_PATH}" ]; then
  DB_SIZE=$(du -sh "${DB_PATH}" 2>/dev/null | cut -f1 || echo "?")
  echo "[startup] ✅ Local DB đã tồn tại (${DB_SIZE}) — bỏ qua restore"

else
  # ── CASE B/C: Không có local DB ──────────────────────────────────
  echo "[startup] Không có local DB — kiểm tra S3..."

  SNAPSHOT_OUTPUT=$(litestream snapshots \
    -config "${CONFIG_PATH}" \
    "${DB_PATH}" 2>/dev/null || echo "")

  if echo "${SNAPSHOT_OUTPUT}" | grep -q .; then
    # CASE C: Có replica → restore bắt buộc thành công
    echo "[startup] ✅ Tìm thấy replica trên S3:"
    echo "${SNAPSHOT_OUTPUT}" | head -5
    echo "[startup] Đang restore từ S3..."

    # Restore vào file tạm rồi move về DB_PATH để tránh race:
    # - Nếu DB_PATH xuất hiện trong lúc restore, vẫn không làm lệnh fail.
    # - Tránh lỗi "output path already exists".
    # - Tránh replicate nhầm DB rỗng khi restore chưa hoàn tất.
    RESTORE_LOG="/tmp/litestream-restore.log"
    RESTORE_TMP="/tmp/storage.restore.$$.sqlite"
    rm -f "${RESTORE_LOG}"
    rm -f "${RESTORE_TMP}"

    if litestream restore \
        -config "${CONFIG_PATH}" \
        -if-replica-exists \
        -o "${RESTORE_TMP}" \
        "${DB_PATH}" >"${RESTORE_LOG}" 2>&1; then

      if [ ! -f "${RESTORE_TMP}" ]; then
        echo "[startup] ✖ Restore báo thành công nhưng không có file tạm: ${RESTORE_TMP}"
        sed 's/^/[startup] /' "${RESTORE_LOG}" || true
        exit 1
      fi

      rm -f "${DB_PATH}"
      mv "${RESTORE_TMP}" "${DB_PATH}"

      DB_SIZE=$(du -sh "${DB_PATH}" 2>/dev/null | cut -f1 || echo "?")
      echo "[startup] ✅ Restore thành công (${DB_SIZE})"

    else
      EXIT_CODE=$?
      echo "[startup] ════════════════════════════════════"
      echo "[startup] ✖ FATAL: Restore THẤT BẠI (exit ${EXIT_CODE})"
      sed 's/^/[startup] /' "${RESTORE_LOG}" || true
      echo "[startup]"
      echo "[startup] Kiểm tra:"
      echo "[startup]   1. LITESTREAM_ACCESS_KEY_ID và SECRET có đúng không?"
      echo "[startup]   2. SUPABASE_PROJECT_REF có đúng không?"
      echo "[startup]   3. Network có reach được Supabase S3 không?"
      echo "[startup]   4. Bucket '${LITESTREAM_BUCKET:-?}' có tồn tại không?"
      echo "[startup] ════════════════════════════════════"
      exit 1
    fi

  else
    # CASE B: Không có replica → start fresh
    echo "[startup] Không tìm thấy replica trên S3 — bắt đầu với DB mới"
  fi
fi

echo "[startup] Khởi động Litestream replication..."
exec litestream replicate -config "${CONFIG_PATH}"
