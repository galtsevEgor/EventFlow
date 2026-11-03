#!/usr/bin/env bash
set -euo pipefail
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set password="$RECOMMENDATIONS_DB_PASSWORD" <<'SQL'
CREATE EXTENSION vector;
SELECT format('CREATE ROLE recommendations LOGIN PASSWORD %L', :'password') \gexec
REVOKE ALL ON DATABASE recommendations FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE recommendations TO recommendations;
GRANT USAGE, CREATE ON SCHEMA public TO recommendations;
SQL
