#!/usr/bin/env bash
set -euo pipefail

curl -fsS http://127.0.0.1:20128/api/storage/health >/dev/null || exit 1
test -f /litefs/storage.sqlite || exit 1
exit 0
