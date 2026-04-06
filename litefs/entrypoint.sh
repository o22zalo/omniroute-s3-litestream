#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] INSTANCE_NAME=${INSTANCE_NAME:-unknown}"
echo "[entrypoint] INSTANCE_ADDR=${INSTANCE_ADDR:-unknown}"
echo "[entrypoint] CONSUL_HTTP_ADDR=${CONSUL_HTTP_ADDR:-unknown}"

mkdir -p /litefs
mkdir -p /var/lib/litefs

export DATA_DIR=/litefs
export PORT=20129
export HOST=0.0.0.0
export HOSTNAME=0.0.0.0
export BIND=0.0.0.0

exec litefs mount -config /etc/litefs.yml
