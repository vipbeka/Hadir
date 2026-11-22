#!/usr/bin/env bash
# Local migration + RLS test on a throwaway Postgres (no Docker needed).
# Checks: migrations apply clean → RLS tests pass → rollback (down files
# in reverse) → migrations re-apply clean.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
WORK="${TMPDIR:-/tmp}/zh-pgtest-$$"
PORT=55432
mkdir -p "$WORK"
# Postgres refuses to run as root; use the postgres OS user when needed.
AS=()
if [ "$(id -u)" = 0 ]; then chown postgres "$WORK"; AS=(runuser -u postgres --); fi
"${AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" start >/dev/null
trap '"${AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" stop -m fast >/dev/null; rm -rf "$WORK"' EXIT
PSQL=(psql -h "$WORK" -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -f "$ROOT/tools/sql-test/supabase_stub.sql" >/dev/null
# files marked "-- @remote-only" need hosted extensions (pg_net, pg_cron, vault)
up() { for f in "$ROOT"/supabase/migrations/*.sql; do grep -q -- '-- @remote-only' "$f" && continue; "${PSQL[@]}" -f "$f" >/dev/null; done; }
down() { for f in $(ls "$ROOT"/supabase/rollback/*.down.sql | sort -r); do grep -q -- '-- @remote-only' "$f" && continue; "${PSQL[@]}" -f "$f" >/dev/null; done; }
echo "== apply migrations"; up
echo "== RLS tests"; { echo "begin;"; cat "$ROOT/supabase/tests/rls_test.sql"; echo "rollback;"; } | "${PSQL[@]}" 2>&1 | grep -E "ok:|PASSED|FAILED|ERROR" | sed 's/^NOTICE:  //'
echo "== engine tests"; { echo "begin;"; cat "$ROOT/supabase/tests/engine_test.sql"; echo "rollback;"; } | "${PSQL[@]}" 2>&1 | grep -E "ok:|PASSED|FAILED|ERROR" | sed 's/^NOTICE:  //'
echo "== rollback"; down
"${PSQL[@]}" -tAc "select 'tables left in public: ' || count(*) from information_schema.tables where table_schema='public'"
echo "== re-apply"; up
"${PSQL[@]}" -tAc "select 'tables: ' || count(*) from information_schema.tables where table_schema='public'"
echo "== all good"
