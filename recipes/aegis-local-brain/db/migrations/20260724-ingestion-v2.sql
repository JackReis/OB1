BEGIN;

ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS ingest_key TEXT,
  ADD COLUMN IF NOT EXISTS source_uri TEXT,
  ADD COLUMN IF NOT EXISTS source_version TEXT,
  ADD COLUMN IF NOT EXISTS parent_id TEXT,
  ADD COLUMN IF NOT EXISTS chunk_kind TEXT,
  ADD COLUMN IF NOT EXISTS chunk_index INTEGER,
  ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS embedding_provider TEXT,
  ADD COLUMN IF NOT EXISTS embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER,
  ADD COLUMN IF NOT EXISTS embedding_version TEXT,
  ADD COLUMN IF NOT EXISTS embedding_normalized BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_ingest_key
  ON public.thoughts (ingest_key) WHERE ingest_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_source_version
  ON public.thoughts (source_type, source_uri, source_version);

-- Backfill embedding metadata in batches to avoid MVCC rewrite hazard
-- and WAL bloat from a single UPDATE over ~160k rows.
-- Each iteration updates at most 5000 rows; the loop exits when no
-- remaining rows match the WHERE predicate.
-- Functional equivalence: identical COALESCE semantics to the original
-- single UPDATE — same SET expressions, same WHERE clause.
DO $$
DECLARE
  batch_size CONSTANT INTEGER := 5000;
  rows_updated INTEGER;
BEGIN
  LOOP
    UPDATE public.thoughts
    SET embedding_provider = COALESCE(embedding_provider, 'ollama'),
        embedding_model = COALESCE(embedding_model, 'mxbai-embed-large'),
        embedding_dimensions = COALESCE(embedding_dimensions, 1024),
        embedding_version = COALESCE(embedding_version, 'ollama:mxbai-embed-large:1024:legacy'),
        embedding_normalized = COALESCE(embedding_normalized, false),
        embedded_at = COALESCE(embedded_at, updated_at, created_at),
        indexed_at = COALESCE(indexed_at, updated_at, created_at)
    WHERE embedding IS NOT NULL
      AND embedding_version IS NULL
    LIMIT batch_size;

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
  END LOOP;
END $$;

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS thoughts_content_fts_idx
  ON public.thoughts USING gin (to_tsvector('english', content));

-- Install the updated functions after this migration:
--   docker compose exec -T db bash /docker-entrypoint-initdb.d/02-open-brain-rpcs.sh
-- PostgREST must then receive: NOTIFY pgrst, 'reload schema';
