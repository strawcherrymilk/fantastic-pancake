#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi

if [ -f .env ]; then
  exec node --env-file=.env monitor.mjs
fi

exec node monitor.mjs
