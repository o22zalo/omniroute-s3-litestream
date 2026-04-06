#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:20128}"

echo "Health..."
curl -fsS "$BASE_URL/api/storage/health"

echo "Models..."
curl -fsS "$BASE_URL/v1/models" >/dev/null

echo "Smoke OK"
