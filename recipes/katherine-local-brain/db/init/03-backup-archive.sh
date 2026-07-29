#!/bin/bash
set -e

: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"

echo "  [init/03] creating hosted Open Brain backup archive..."

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" <<'EOSQL'

CREATE TABLE IF NOT EXISTS public.backup_archive_rows (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'hosted_open_brain',
  table_name TEXT NOT NULL,
  source_id TEXT NOT NULL,
  row_data JSONB NOT NULL,
  backup_file TEXT,
  imported_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source_system, table_name, source_id)
);

CREATE INDEX IF NOT EXISTS backup_archive_rows_table_idx
  ON public.backup_archive_rows (source_system, table_name);

CREATE INDEX IF NOT EXISTS backup_archive_rows_data_gin_idx
  ON public.backup_archive_rows USING gin (row_data);

ALTER TABLE public.backup_archive_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all ON public.backup_archive_rows;
CREATE POLICY service_role_all
  ON public.backup_archive_rows
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.backup_archive_rows TO service_role;

NOTIFY pgrst, 'reload schema';

EOSQL

echo "  [init/03] done."
