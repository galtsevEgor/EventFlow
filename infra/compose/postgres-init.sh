#!/usr/bin/env bash
set -euo pipefail

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SQL

for service in catalog booking payments tickets analytics waitlist keycloak; do
  password_key="${service^^}_DB_PASSWORD"
  psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
    --set database="$service" --set password="${!password_key}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'database', :'password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'database', :'database') \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'database') \gexec
\connect :database
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
done
