#!/usr/bin/env bash
# Restore only into a NEW scratch database. Never drops databases or starts app/workers.
set -euo pipefail
dump=${1:?Provide a trusted absolute custom-format dump}
env_file=${2:?Provide the deployment env file}
project=${3:?Provide the Compose project name}
database=${4:?Provide a NEW scratch name beginning tl_restore_}
[[ $# -eq 4 && $dump = /* && -f $dump && $env_file = /* && -f $env_file ]] || exit 1
[[ $project =~ ^[a-z0-9][a-z0-9_-]*$ && $database =~ ^tl_restore_[a-z0-9_]{1,40}$ ]] || exit 1
dc=(docker compose --env-file "$env_file" --project-name "$project" -f "$(dirname "$0")/compose.yml")
# CREATE fails if the name exists. Ownership lets migrations and runtime retain their roles.
"${dc[@]}" exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE $database OWNER tessaloom_migrator" >/dev/null
"${dc[@]}" exec -T postgres pg_restore -U postgres -d "$database" \
  --role=tessaloom_migrator --no-owner --exit-on-error --single-transaction < "$dump"
"${dc[@]}" exec -T postgres psql -U postgres -d "$database" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE tessaloom_app;
SELECT count(*) AS projects FROM projects;
SELECT count(*) AS grants FROM demo_access_grants;
SELECT count(*) AS reservations FROM llm_spend_reservations;
RESET ROLE;
SELECT count(*) AS migrations FROM drizzle.__drizzle_migrations;
SQL
echo 'Scratch restore readable by runtime role. Compare counts/ledger with backup record; preserve source volume. No worker started.'
