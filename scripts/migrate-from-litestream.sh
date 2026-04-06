#!/usr/bin/env bash
set -euo pipefail

SRC_DB="${1:-./data/storage.sqlite}"
DST_DB="${2:-./bootstrap/storage.sqlite}"

if [ ! -f "$SRC_DB" ]; then
  echo "Source DB not found: $SRC_DB"
  exit 1
fi

mkdir -p "$(dirname "$DST_DB")"
cp "$SRC_DB" "$DST_DB"

echo "Running integrity check..."
sqlite3 "$DST_DB" "PRAGMA integrity_check;"

echo "Done: $DST_DB"
