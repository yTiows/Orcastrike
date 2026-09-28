#!/bin/sh
# Orcastrike for macOS/Linux: ./orcastrike.sh [start|stop|setup|update|doctor]  (default: start)
# Everything is done by scripts/orca.mjs (details: SETUP.md).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13 or newer is required: https://nodejs.org (LTS), or: brew install node" >&2
  exit 1
fi
[ "$#" -eq 0 ] && set -- start
exec node --disable-warning=ExperimentalWarning scripts/orca.mjs "$@"
