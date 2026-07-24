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

CREATE OR REPLACE FUNCTION public.upsert_thought_v2(
  p_content TEXT,
  p_embedding vector(:embed_dim),
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_ingest_key TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_fingerprint TEXT;
  v_id UUID;
BEGIN
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))), 'UTF8'
  )), 'hex');

  IF p_ingest_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_ingest_key, 0));
    SELECT t.id INTO v_id FROM public.thoughts t WHERE t.ingest_key = p_ingest_key LIMIT 1;
  END IF;

  IF v_id IS NOT NULL THEN
    UPDATE public.thoughts SET
      content = p_content,
      embedding = p_embedding,
      content_fingerprint = v_fingerprint,
      metadata = public.thoughts.metadata || p_metadata,
      source_version = NULLIF(p_metadata->>'source_version', ''),
      indexed_at = COALESCE(NULLIF(p_metadata->>'indexed_at', '')::TIMESTAMPTZ, now()),
      embedding_provider = NULLIF(p_metadata->>'embedding_provider', ''),
      embedding_model = NULLIF(p_metadata->>'embedding_model', ''),
      embedding_dimensions = NULLIF(p_metadata->>'embedding_dimensions', '')::INTEGER,
      embedding_version = NULLIF(p_metadata->>'embedding_version', ''),
      embedding_normalized = COALESCE(NULLIF(p_metadata->>'embedding_normalized', '')::BOOLEAN, false),
      embedded_at = COALESCE(NULLIF(p_metadata->>'embedded_at', '')::TIMESTAMPTZ, now()),
      updated_at = now()
    WHERE id = v_id;
    RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint, 'ingest_key', p_ingest_key);
  END IF;

  INSERT INTO public.thoughts (
    content, embedding, content_fingerprint, ingest_key, metadata,
    type, source_type, importance, quality_score, sensitivity_tier,
    source_uri, source_version, parent_id, chunk_kind, chunk_index, indexed_at,
    embedding_provider, embedding_model, embedding_dimensions, embedding_version,
    embedding_normalized, embedded_at
  ) VALUES (
    p_content, p_embedding, v_fingerprint, p_ingest_key, p_metadata,
    COALESCE(NULLIF(p_metadata->>'type', ''), 'observation'),
    COALESCE(NULLIF(p_metadata->>'source_type', ''), NULLIF(p_metadata->>'source', ''), 'unknown'),
    COALESCE(NULLIF(p_metadata->>'importance', '')::INTEGER, 50),
    COALESCE(NULLIF(p_metadata->>'quality_score', '')::INTEGER, 50),
    COALESCE(NULLIF(p_metadata->>'sensitivity_tier', ''), 'standard'),
    NULLIF(p_metadata->>'source_uri', ''), NULLIF(p_metadata->>'source_version', ''),
    NULLIF(p_metadata->>'parent_id', ''), NULLIF(p_metadata->>'chunk_kind', ''),
    NULLIF(p_metadata->>'chunk_index', '')::INTEGER,
    COALESCE(NULLIF(p_metadata->>'indexed_at', '')::TIMESTAMPTZ, now()),
    NULLIF(p_metadata->>'embedding_provider', ''), NULLIF(p_metadata->>'embedding_model', ''),
    NULLIF(p_metadata->>'embedding_dimensions', '')::INTEGER, NULLIF(p_metadata->>'embedding_version', ''),
    COALESCE(NULLIF(p_metadata->>'embedding_normalized', '')::BOOLEAN, false),
    COALESCE(NULLIF(p_metadata->>'embedded_at', '')::TIMESTAMPTZ, now())
  )
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE SET
    embedding = EXCLUDED.embedding,
    ingest_key = COALESCE(public.thoughts.ingest_key, EXCLUDED.ingest_key),
    metadata = public.thoughts.metadata || EXCLUDED.metadata,
    source_version = EXCLUDED.source_version,
    indexed_at = EXCLUDED.indexed_at,
    embedding_provider = EXCLUDED.embedding_provider,
    embedding_model = EXCLUDED.embedding_model,
    embedding_dimensions = EXCLUDED.embedding_dimensions,
    embedding_version = EXCLUDED.embedding_version,
    embedding_normalized = EXCLUDED.embedding_normalized,
    embedded_at = EXCLUDED.embedded_at,
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint, 'ingest_key', p_ingest_key);
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION public.upsert_thought_v2(TEXT, vector, JSONB, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.hybrid_search_thoughts(
  query_text TEXT,
  query_embedding vector(:embed_dim),
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id UUID, content TEXT, metadata JSONB, similarity FLOAT,
  lexical_score FLOAT, hybrid_score FLOAT, created_at TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  WITH vector_ranked AS (
    SELECT t.id, row_number() OVER (ORDER BY t.embedding <=> query_embedding) AS rank,
           1 - (t.embedding <=> query_embedding) AS similarity
    FROM public.thoughts t
    WHERE t.embedding IS NOT NULL AND (filter = '{}'::jsonb OR t.metadata @> filter)
    ORDER BY t.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 5, 50)
  ), lexical_ranked AS (
    SELECT t.id, row_number() OVER (ORDER BY ts_rank_cd(to_tsvector('english', t.content), websearch_to_tsquery('english', query_text)) DESC) AS rank,
           ts_rank_cd(to_tsvector('english', t.content), websearch_to_tsquery('english', query_text)) AS lexical_score
    FROM public.thoughts t
    WHERE websearch_to_tsquery('english', query_text) @@ to_tsvector('english', t.content)
      AND (filter = '{}'::jsonb OR t.metadata @> filter)
    ORDER BY lexical_score DESC
    LIMIT GREATEST(match_count * 5, 50)
  ), fused AS (
    SELECT COALESCE(v.id, l.id) AS id,
           COALESCE(v.similarity, 0)::FLOAT AS similarity,
           COALESCE(l.lexical_score, 0)::FLOAT AS lexical_score,
           (COALESCE(1.0 / (60 + v.rank), 0) + COALESCE(1.0 / (60 + l.rank), 0))::FLOAT AS hybrid_score
    FROM vector_ranked v FULL OUTER JOIN lexical_ranked l USING (id)
  )
  SELECT t.id, t.content, t.metadata, f.similarity, f.lexical_score, f.hybrid_score, t.created_at
  FROM fused f JOIN public.thoughts t USING (id)
  ORDER BY f.hybrid_score DESC, t.created_at DESC
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.hybrid_search_thoughts(TEXT, vector, INT, JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';

EOSQL

echo "  [init/02] done."
