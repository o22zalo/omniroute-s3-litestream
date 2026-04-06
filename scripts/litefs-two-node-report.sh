#!/usr/bin/env bash
set -euo pipefail

# LiteFS 2-node active checker & report generator.
# This script does not create containers; it validates two running nodes.

NODE1_APP="${1:-http://node1.local:20128}"
NODE2_APP="${2:-http://node2.local:20128}"
DURATION_SECONDS="${3:-180}"
INTERVAL_SECONDS="${4:-5}"
REPORT_DIR="${5:-docs/reports}"

if ! [[ "$DURATION_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "DURATION_SECONDS phải là số nguyên dương"
  exit 1
fi

if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "INTERVAL_SECONDS phải là số nguyên dương"
  exit 1
fi

mkdir -p "$REPORT_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
REPORT_PATH="$REPORT_DIR/litefs-two-node-report-$TS.md"

TOTAL=0
N1_HEALTH_OK=0
N2_HEALTH_OK=0
N1_MODELS_OK=0
N2_MODELS_OK=0
FAIL_EVENTS=0

check_ok() {
  local url="$1"
  if curl -fsS --max-time 5 "$url" >/dev/null; then
    return 0
  fi
  return 1
}

END_TS=$(( $(date +%s) + DURATION_SECONDS ))

while [ "$(date +%s)" -lt "$END_TS" ]; do
  TOTAL=$((TOTAL + 1))

  if check_ok "$NODE1_APP/api/storage/health"; then
    N1_HEALTH_OK=$((N1_HEALTH_OK + 1))
  else
    FAIL_EVENTS=$((FAIL_EVENTS + 1))
  fi

  if check_ok "$NODE2_APP/api/storage/health"; then
    N2_HEALTH_OK=$((N2_HEALTH_OK + 1))
  else
    FAIL_EVENTS=$((FAIL_EVENTS + 1))
  fi

  if check_ok "$NODE1_APP/v1/models"; then
    N1_MODELS_OK=$((N1_MODELS_OK + 1))
  else
    FAIL_EVENTS=$((FAIL_EVENTS + 1))
  fi

  if check_ok "$NODE2_APP/v1/models"; then
    N2_MODELS_OK=$((N2_MODELS_OK + 1))
  else
    FAIL_EVENTS=$((FAIL_EVENTS + 1))
  fi

  sleep "$INTERVAL_SECONDS"
done

pct() {
  local ok="$1"
  local total="$2"
  if [ "$total" -eq 0 ]; then
    echo "0.00"
  else
    awk -v a="$ok" -v b="$total" 'BEGIN { printf "%.2f", (a*100)/b }'
  fi
}

N1_HEALTH_PCT="$(pct "$N1_HEALTH_OK" "$TOTAL")"
N2_HEALTH_PCT="$(pct "$N2_HEALTH_OK" "$TOTAL")"
N1_MODELS_PCT="$(pct "$N1_MODELS_OK" "$TOTAL")"
N2_MODELS_PCT="$(pct "$N2_MODELS_OK" "$TOTAL")"

OVERALL="PASS"
if [ "$FAIL_EVENTS" -gt 0 ]; then
  OVERALL="WARN"
fi

cat > "$REPORT_PATH" <<MD
# LiteFS 2-node song song report

- Timestamp: $(date -Iseconds)
- Node 1 app URL: $NODE1_APP
- Node 2 app URL: $NODE2_APP
- Duration: ${DURATION_SECONDS}s
- Interval: ${INTERVAL_SECONDS}s
- Total samples: $TOTAL
- Overall status: **$OVERALL**

## Kết quả chi tiết

| Check | Node 1 | Node 2 |
|---|---:|---:|
| /api/storage/health (OK/Total) | $N1_HEALTH_OK/$TOTAL ($N1_HEALTH_PCT%) | $N2_HEALTH_OK/$TOTAL ($N2_HEALTH_PCT%) |
| /v1/models (OK/Total) | $N1_MODELS_OK/$TOTAL ($N1_MODELS_PCT%) | $N2_MODELS_OK/$TOTAL ($N2_MODELS_PCT%) |

## Diễn giải

- Nếu cả 2 node đều có tỉ lệ ~100% ở cả health + models: cụm chạy song song ổn định ở lớp phục vụ request.
- Nếu node phụ có models/health giảm mạnh: cần kiểm tra replicate state, lease Consul, và route tunnel.
- Nếu có FAIL_EVENTS > 0: nên chạy thêm soak dài (2-4h) + kịch bản kill primary để đo downtime failover thực tế.

## Raw summary

- FAIL_EVENTS: $FAIL_EVENTS
MD

echo "Report generated: $REPORT_PATH"
