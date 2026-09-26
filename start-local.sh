#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${CODEX_RECORD_STATE_DIR:-$HOME/.cache/code8-30-b}"
PGDATA="$STATE_DIR/postgres-data"
DB_NAME="paper_book_traces"
REPORT_FILE="$ROOT/apps/web/reproduce-result.html"
API_PID=""
WEB_PID=""
POSTGRES_STARTED=0

mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/api-url" "$STATE_DIR/web-url" "$REPORT_FILE"

command -v node >/dev/null || { echo "Node.js is required" >&2; exit 1; }
command -v pg_ctl >/dev/null || { echo "PostgreSQL tools are required" >&2; exit 1; }
command -v initdb >/dev/null || { echo "PostgreSQL initdb is required" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22+ is required (found $(node --version))" >&2
  exit 1
fi

pick_port() {
  node -e 'const net=require("net"); const s=net.createServer(); s.unref(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

API_PORT="$(pick_port)"
while true; do WEB_PORT="$(pick_port)"; [[ "$WEB_PORT" != "$API_PORT" ]] && break; done
while true; do DB_PORT="$(pick_port)"; [[ "$DB_PORT" != "$API_PORT" && "$DB_PORT" != "$WEB_PORT" ]] && break; done

API_URL="http://127.0.0.1:${API_PORT}"
WEB_URL="http://127.0.0.1:${WEB_PORT}"

stop_tree() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  stop_tree "$API_PID"
  stop_tree "$WEB_PID"
  rm -f "$REPORT_FILE"
  if [[ "$POSTGRES_STARTED" -eq 1 ]]; then
    pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "[local] Node $(node --version)"
echo "[local] state: $STATE_DIR"
echo "[local] ports: api=$API_PORT web=$WEB_PORT db=$DB_PORT"

if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
  echo "[local] initializing workspace PostgreSQL cluster"
  initdb -D "$PGDATA" -U app --auth-local=trust --auth-host=trust --no-locale -E UTF8 >/dev/null
fi

if pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
fi

echo "[local] starting PostgreSQL"
pg_ctl -D "$PGDATA" -l "$STATE_DIR/postgres.log" -o "-p $DB_PORT -h 127.0.0.1 -k $STATE_DIR" -w start >/dev/null
POSTGRES_STARTED=1

export PGHOST=127.0.0.1
export PGPORT="$DB_PORT"
export PGUSER=app
dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true
createdb "$DB_NAME"

export NODE_ENV=development
export PORT="$API_PORT"
export DATABASE_URL="postgresql://app@127.0.0.1:${DB_PORT}/${DB_NAME}?schema=public"
export SESSION_SECRET="code8-30-record-session-secret-2026-local-only"
export SESSION_TTL_DAYS=30
export COOKIE_SECURE=false
export WEB_ORIGIN="$WEB_URL"
export EXPORT_MAX_ROWS=100000
export VITE_API_BASE_URL="${API_URL}/api/v1"
export TZ=Asia/Shanghai

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  echo "[local] installing dependencies"
  npm install
else
  echo "[local] reusing installed dependencies"
fi

echo "[local] generating Prisma client"
npm run db:generate >/dev/null
echo "[local] applying database migrations"
npm run db:migrate >/dev/null
npm run db:seed >/dev/null

echo "[local] starting API"
npm run dev -w @paper-book-traces/api >"$STATE_DIR/api.log" 2>&1 &
API_PID=$!

echo "[local] starting Web"
npm run dev -w @paper-book-traces/web -- --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$STATE_DIR/web.log" 2>&1 &
WEB_PID=$!

ready=0
for _ in $(seq 1 120); do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "[local] API exited unexpectedly; log follows" >&2
    tail -n 80 "$STATE_DIR/api.log" >&2 || true
    exit 1
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "[local] Web exited unexpectedly; log follows" >&2
    tail -n 80 "$STATE_DIR/web.log" >&2 || true
    exit 1
  fi
  if curl -fsS "$API_URL/health/ready" >/dev/null 2>&1 && curl -fsS "$WEB_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done

if [[ "$ready" -ne 1 ]]; then
  echo "[local] services did not become ready" >&2
  tail -n 80 "$STATE_DIR/api.log" >&2 || true
  tail -n 80 "$STATE_DIR/web.log" >&2 || true
  exit 1
fi

printf '%s\n' "$API_URL" >"$STATE_DIR/api-url"
printf '%s\n' "$WEB_URL" >"$STATE_DIR/web-url"
echo "[local] ready: $API_URL and $WEB_URL"

wait -n "$API_PID" "$WEB_PID"
