#!/usr/bin/env bash
set -euo pipefail

# Resolve CONSUL_HTTP_ADDR when consul endpoints are dynamic (e.g. tailscale).
# Priority:
# 1) CONSUL_HTTP_ADDR if healthy
# 2) first healthy candidate from CONSUL_CANDIDATES (comma-separated)
#
# Candidate format examples:
#   consul-a.tailnet.ts.net
#   consul-b.tailnet.ts.net:8500
#   http://consul-c.tailnet.ts.net:8500

normalize_url() {
  local raw="$1"
  if [[ "$raw" =~ ^https?:// ]]; then
    echo "$raw"
  elif [[ "$raw" == *:* ]]; then
    echo "http://$raw"
  else
    echo "http://$raw:8500"
  fi
}

is_consul_healthy() {
  local base="$1"
  local leader
  leader="$(curl -fsS --max-time 3 "$base/v1/status/leader" 2>/dev/null || true)"
  # consul returns quoted address string when healthy, empty string when no leader
  if [ -n "$leader" ] && [ "$leader" != '""' ]; then
    return 0
  fi
  return 1
}

if [ -n "${CONSUL_HTTP_ADDR:-}" ]; then
  C_URL="$(normalize_url "$CONSUL_HTTP_ADDR")"
  if is_consul_healthy "$C_URL"; then
    echo "$C_URL"
    exit 0
  fi
fi

if [ -n "${CONSUL_CANDIDATES:-}" ]; then
  IFS=',' read -r -a arr <<< "$CONSUL_CANDIDATES"
  for item in "${arr[@]}"; do
    item="$(echo "$item" | xargs)"
    [ -z "$item" ] && continue
    C_URL="$(normalize_url "$item")"
    if is_consul_healthy "$C_URL"; then
      echo "$C_URL"
      exit 0
    fi
  done
fi

echo "Unable to resolve healthy CONSUL_HTTP_ADDR. Set CONSUL_HTTP_ADDR or CONSUL_CANDIDATES." >&2
exit 1
