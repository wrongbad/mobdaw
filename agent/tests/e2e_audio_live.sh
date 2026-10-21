#!/usr/bin/env bash
# Whole audio end-to-end run on a throwaway local server: own port, database and storage in a temp dir, a new user, then
# e2e_audio_live.py, then the server is stopped and the temp dir removed (KEEP=1 keeps it). Re-runnable; touches nothing else.
#
#   agent/tests/e2e_audio_live.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/mobdaw-e2e-XXXXXX")"
PORT="${PORT:-$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')}"
export PORT DB_PATH="$DIR/db.sqlite" STORAGE_DIR="$DIR/samples" PUBLIC_URL="http://localhost:$PORT" STORAGE_DRIVER=local
export MOBDAW_URL="http://localhost:$PORT" E2E_USER=e2e MOBDAW_PASSWORD=e2e-password-1234
unset DEV_NO_AUTH
SERVER_PID=
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null || true
  [ -n "${KEEP:-}" ] && echo "kept $DIR" || rm -rf "$DIR"
}
trap cleanup EXIT

cd "$ROOT/server"
node --disable-warning=ExperimentalWarning --import tsx scripts/admin.ts create-user "$E2E_USER"   # password from MOBDAW_PASSWORD
node --disable-warning=ExperimentalWarning --import tsx src/main.ts > "$DIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 100); do
  curl -s -o /dev/null "$MOBDAW_URL/api/me" && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$DIR/server.log"; exit 1; }
  sleep 0.2
done
echo "server on $MOBDAW_URL (pid $SERVER_PID, log $DIR/server.log)"
cd "$ROOT/agent"
python3 tests/e2e_audio_live.py "$@" || { echo "--- server log"; tail -20 "$DIR/server.log"; exit 1; }
