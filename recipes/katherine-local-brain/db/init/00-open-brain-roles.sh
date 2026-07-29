#!/bin/bash
set -e

: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"
: "${POSTGREST_DB_PASSWORD:?POSTGREST_DB_PASSWORD not set}"

echo "  [init/00] creating API roles..."

psql -v ON_ERROR_STOP=1 \
     -v postgrest_db_password="${POSTGREST_DB_PASSWORD}" \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" <<'EOSQL'

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END
$$;

ALTER ROLE authenticator WITH PASSWORD :'postgrest_db_password';
GRANT anon TO authenticator;
GRANT service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO service_role;

EOSQL

echo "  [init/00] done."
