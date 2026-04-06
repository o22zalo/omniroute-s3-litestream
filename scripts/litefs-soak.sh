#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:20128}"
DURATION_SECONDS="${2:-14400}"
INTERVAL_SECONDS="${3:-2}"

if ! [[ "$DURATION_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "DURATION_SECONDS phải là số nguyên dương"
  exit 1
fi

if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "INTERVAL_SECONDS phải là số nguyên dương"
  exit 1
fi

END_TS=$(( $(date +%s) + DURATION_SECONDS ))
TOTAL=0
FAIL=0

echo "[soak] BASE_URL=$BASE_URL"
echo "[soak] DURATION_SECONDS=$DURATION_SECONDS"
echo "[soak] INTERVAL_SECONDS=$INTERVAL_SECONDS"

while [ "$(date +%s)" -lt "$END_TS" ]; do
  TOTAL=$((TOTAL + 1))

  if curl -fsS "$BASE_URL/v1/models" >/dev/null; then
    echo "[$(date -Iseconds)] ok #$TOTAL"
  else
    FAIL=$((FAIL + 1))
    echo "[$(date -Iseconds)] fail #$TOTAL"
  fi

  sleep "$INTERVAL_SECONDS"
done

echo "[soak] total=$TOTAL fail=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
