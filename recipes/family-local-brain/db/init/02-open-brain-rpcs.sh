#!/bin/bash
set -e

: "${EMBED_DIM:?EMBED_DIM not set}"
: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"

echo "  [init/02] creating Open Brain RPCs with embedding vector(${EMBED_DIM})..."

psql -v ON_ERROR_STOP=1 \
     -v embed_dim="${EMBED_DIM}" \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" <<'EOSQL'

CREATE OR REPLACE FUNCTION public.match_thoughts(
  query_embedding vector(:embed_dim),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  metadata JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> query_embedding) AS similarity,
    t.created_at
  FROM public.thoughts t
  WHERE t.embedding IS NOT NULL
    AND 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.match_thoughts(vector, FLOAT, INT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_thought(
  p_content TEXT,
  p_embedding vector(:embed_dim),
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $$
DECLARE
  v_fingerprint TEXT;
  v_id UUID;
  v_type TEXT;
  v_source_type TEXT;
  v_importance INTEGER;
  v_quality_score INTEGER;
  v_sensitivity_tier TEXT;
BEGIN
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
    'UTF8'
  )), 'hex');
  v_type := COALESCE(NULLIF(p_metadata->>'type', ''), 'observation');
  v_source_type := COALESCE(NULLIF(p_metadata->>'source_type', ''), NULLIF(p_metadata->>'source', ''), 'unknown');
  v_importance := COALESCE(NULLIF(p_metadata->>'importance', '')::INTEGER, 50);
  v_quality_score := COALESCE(NULLIF(p_metadata->>'quality_score', '')::INTEGER, 50);
  v_sensitivity_tier := COALESCE(NULLIF(p_metadata->>'sensitivity_tier', ''), 'standard');

  INSERT INTO public.thoughts (
    content,
    embedding,
    content_fingerprint,
    metadata,
    type,
    source_type,
    importance,
    quality_score,
    sensitivity_tier
  )
  VALUES (
    p_content,
    p_embedding,
    v_fingerprint,
    p_metadata,
    v_type,
    v_source_type,
    v_importance,
    v_quality_score,
    v_sensitivity_tier
  )
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
    SET updated_at = now(),
        embedding = EXCLUDED.embedding,
        metadata = public.thoughts.metadata || EXCLUDED.metadata,
        type = EXCLUDED.type,
        source_type = EXCLUDED.source_type,
        importance = EXCLUDED.importance,
        quality_score = EXCLUDED.quality_score,
        sensitivity_tier = EXCLUDED.sensitivity_tier
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION public.upsert_thought(TEXT, vector, JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';

EOSQL

echo "  [init/02] done."
