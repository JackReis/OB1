#!/bin/bash
set -e

: "${EMBED_DIM:?EMBED_DIM not set}"
: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"

echo "  [init/01] creating Open Brain schema with embedding vector(${EMBED_DIM})..."

psql -v ON_ERROR_STOP=1 \
     -v embed_dim="${EMBED_DIM}" \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" <<'EOSQL'

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.thoughts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(:embed_dim),
  metadata JSONB DEFAULT '{}'::jsonb,
  type TEXT DEFAULT 'observation',
  source_type TEXT DEFAULT 'unknown',
  importance INTEGER DEFAULT 50,
  quality_score INTEGER DEFAULT 50,
  sensitivity_tier TEXT DEFAULT 'standard',
  status TEXT,
  status_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  content_fingerprint TEXT
);

CREATE INDEX IF NOT EXISTS thoughts_embedding_hnsw_idx
  ON public.thoughts
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS thoughts_metadata_gin_idx
  ON public.thoughts USING gin (metadata);

CREATE INDEX IF NOT EXISTS thoughts_created_at_desc_idx
  ON public.thoughts (created_at DESC);

CREATE INDEX IF NOT EXISTS thoughts_type_idx
  ON public.thoughts (type);

CREATE INDEX IF NOT EXISTS thoughts_status_idx
  ON public.thoughts (status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_fingerprint
  ON public.thoughts (content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS thoughts_updated_at ON public.thoughts;
CREATE TRIGGER thoughts_updated_at
  BEFORE UPDATE ON public.thoughts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.thoughts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all ON public.thoughts;
CREATE POLICY service_role_all
  ON public.thoughts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thoughts TO service_role;

EOSQL

echo "  [init/01] done."
