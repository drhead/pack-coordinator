#!/usr/bin/env bash
set -eo pipefail

# ==============================================================================
# CONFIGURATION & DEFAULTS
# ==============================================================================
SANDBOX_DB_SUFFIX="_perf_sandbox"
PROFILE_SQL="${PROFILE_SQL:-profile_suite.sql}"

# Parse optional connection flag before commands
# Usage: ./db-sandbox.sh [-c postgresql://user:pass@host:port/dbname] <command> [args]
RAW_CONN="${DATABASE_URL:-}"

while [[ "$#" -gt 0 ]]; do
    case "$1" in
        -c|--conn|--connection-string)
            RAW_CONN="$2"
            shift 2
            ;;
        *)
            break
            ;;
    esac
done

COMMAND="${1:-}"
EXTRA_ARG="${2:-}"

# Automatically source .env file if present in current or parent directory
if [[ -f ".env" ]]; then
    set -a
    source .env
    set +a
elif [[ -f "../.env" ]]; then
    set -a
    source ../.env
    set +a
fi

# Parse connection string or fallback to individual env vars
if [[ -n "$RAW_CONN" ]]; then
    # Use python to safely decompose standard PostgreSQL URI format
    eval "$(python3 -c '
import sys
from urllib.parse import urlparse, unquote

url = urlparse(sys.argv[1])
user = unquote(url.username or "")
password = unquote(url.password or "")
host = unquote(url.hostname or "localhost")
port = str(url.port or 5432)
dbname = unquote(url.path.lstrip("/") or "postgres")

print(f"PGUSER=\"{user}\"")
print(f"PGPASSWORD=\"{password}\"")
print(f"PGHOST=\"{host}\"")
print(f"PGPORT=\"{port}\"")
print(f"SOURCE_DB=\"{dbname}\"")
' "$RAW_CONN")"
else
    PGHOST="${PGHOST:-${POSTGRES_HOST:-localhost}}"
    PGPORT="${PGPORT:-${POSTGRES_PORT:-5432}}"
    PGUSER="${PGUSER:-${POSTGRES_USER:-coordinator}}"
    PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
    SOURCE_DB="${SOURCE_DB:-${POSTGRES_DB:-coordinator_db}}"
fi

SANDBOX_DB="${SOURCE_DB}${SANDBOX_DB_SUFFIX}"

# Export Postgres standard variables for psql
export PGHOST PGPORT PGUSER PGPASSWORD

usage() {
    cat << EOF
Usage: $0 [-c <connection_string>] [command] [options]

Options:
  -c, --conn <URI>    PostgreSQL connection string
                      (e.g., postgresql://user:pass@127.0.0.1:5432/coordinator_db)
                      Can also be provided via the DATABASE_URL environment variable.

Commands:
  clone               Create a fresh sandbox clone from '${SOURCE_DB}' -> '${SANDBOX_DB}'
  apply <file.sql>    Run a migration/DDL script against the active sandbox
  bench               Run the 5-second timeout benchmark suite against the sandbox
  psql                Open an interactive psql session inside the sandbox
  drop                Drop the sandbox database and terminate its connections
  test <file.sql>     One-shot: clone -> apply <file.sql> -> bench -> drop

Target Configuration:
  Host:               ${PGHOST}:${PGPORT}
  User:               ${PGUSER}
  Source DB:          ${SOURCE_DB}
  Sandbox DB:         ${SANDBOX_DB}
EOF
    exit 1
}

# Helper to run commands against the maintenance DB (postgres)
run_maint_query() {
    psql -q -d postgres -c "$1"
}

cmd_clone() {
    echo ">> Creating sandbox clone '${SANDBOX_DB}' from live '${SOURCE_DB}'..."
    run_maint_query "DROP DATABASE IF EXISTS ${SANDBOX_DB};"
    run_maint_query "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SOURCE_DB}' AND pid != pg_backend_pid();" > /dev/null 2>&1 || true
    run_maint_query "CREATE DATABASE ${SANDBOX_DB} WITH TEMPLATE ${SOURCE_DB};"
    echo ">> Sandbox '${SANDBOX_DB}' is ready."
}

cmd_apply() {
    local script="$1"
    if [[ -z "$script" || ! -f "$script" ]]; then
        echo "Error: Migration file '$script' not found."
        exit 1
    fi
    echo ">> Applying migration '${script}' to '${SANDBOX_DB}'..."
    psql -d "${SANDBOX_DB}" -v ON_ERROR_STOP=1 -f "${script}"
    echo ">> Migration applied successfully."
}

cmd_bench() {
    if [[ ! -f "$PROFILE_SQL" ]]; then
        echo "Error: Benchmark file '$PROFILE_SQL' not found."
        exit 1
    fi
    echo ">> Executing benchmark suite against '${SANDBOX_DB}'..."
    echo ">> Statement timeout enforced at 5000ms."
    echo "----------------------------------------------------------"
    
    psql -d "${SANDBOX_DB}" \
         -v ON_ERROR_STOP=1 \
         -v statement_timeout=5000 \
         -f "${PROFILE_SQL}"
}

cmd_psql() {
    psql -d "${SANDBOX_DB}"
}

cmd_drop() {
    echo ">> Tearing down sandbox '${SANDBOX_DB}'..."
    run_maint_query "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SANDBOX_DB}' AND pid != pg_backend_pid();" > /dev/null 2>&1 || true
    run_maint_query "DROP DATABASE IF EXISTS ${SANDBOX_DB};" > /dev/null 2>&1 || true
    echo ">> Sandbox dropped."
}

case "$COMMAND" in
    clone)
        cmd_clone
        ;;
    apply)
        cmd_apply "$EXTRA_ARG"
        ;;
    bench)
        cmd_bench
        ;;
    psql)
        cmd_psql
        ;;
    drop)
        cmd_drop
        ;;
    test)
        trap cmd_drop EXIT INT TERM
        cmd_clone
        cmd_apply "$EXTRA_ARG"
        cmd_bench
        ;;
    *)
        usage
        ;;
esac