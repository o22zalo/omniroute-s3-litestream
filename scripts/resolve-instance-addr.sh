#!/usr/bin/env bash
set -euo pipefail

# Resolve a stable advertise address for LiteFS lease/proxy discovery.
# Priority:
# 1) INSTANCE_ADDR (explicit override)
# 2) TS_DNS_NAME (explicit tailscale magicdns name)
# 3) TS_NODE_NAME + TAILSCALE_TAILNET -> <node>.<tailnet>
# 4) tailscale status --json .Self.DNSName (if tailscale cli exists)

if [ -n "${INSTANCE_ADDR:-}" ]; then
  echo "$INSTANCE_ADDR"
  exit 0
fi

if [ -n "${TS_DNS_NAME:-}" ]; then
  echo "$TS_DNS_NAME"
  exit 0
fi

if [ -n "${TS_NODE_NAME:-}" ] && [ -n "${TAILSCALE_TAILNET:-}" ]; then
  echo "${TS_NODE_NAME}.${TAILSCALE_TAILNET}"
  exit 0
fi

if command -v tailscale >/dev/null 2>&1; then
  DNS_NAME="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [ -n "$DNS_NAME" ]; then
    # tailscale status often returns trailing dot.
    echo "${DNS_NAME%.}"
    exit 0
  fi
fi

echo "Unable to resolve INSTANCE_ADDR. Set INSTANCE_ADDR or TS_DNS_NAME, or provide TS_NODE_NAME+TAILSCALE_TAILNET." >&2
exit 1
