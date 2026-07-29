#!/bin/bash
set -e

: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"

echo "  [init/04] creating first-class hosted side tables..."

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" <<'EOSQL'

BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system TEXT NOT NULL DEFAULT 'hosted_open_brain',
  source_id TEXT NOT NULL UNIQUE,
  thought_id UUID REFERENCES public.thoughts(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  channel_kind TEXT,
  channel_id TEXT,
  channel_thread_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'project' CHECK (visibility IN ('personal', 'channel', 'project', 'workspace', 'organization')),
  memory_type TEXT NOT NULL CHECK (memory_type IN ('decision', 'output', 'lesson', 'constraint', 'open_question', 'failure', 'artifact_reference', 'work_log')),
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'stale', 'superseded', 'disputed', 'rejected')),
  provenance_status TEXT NOT NULL DEFAULT 'generated' CHECK (provenance_status IN ('observed', 'inferred', 'user_confirmed', 'imported', 'generated', 'superseded', 'disputed')),
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0.50 CHECK (confidence >= 0 AND confidence <= 1),
  created_by TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('user', 'agent', 'system', 'import')),
  runtime_name TEXT,
  runtime_version TEXT,
  provider TEXT,
  model TEXT,
  task_id TEXT,
  flow_id TEXT,
  can_use_as_instruction BOOLEAN NOT NULL DEFAULT false,
  can_use_as_evidence BOOLEAN NOT NULL DEFAULT true,
  requires_user_confirmation BOOLEAN NOT NULL DEFAULT true,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'confirmed', 'evidence_only', 'restricted', 'rejected', 'stale', 'merged')),
  last_confirmed_at TIMESTAMPTZ,
  stale_after TIMESTAMPTZ,
  idempotency_key TEXT,
  content_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_data JSONB NOT NULL,
  backup_file TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_at TIMESTAMPTZ DEFAULT now(),
  CHECK (can_use_as_instruction = false OR provenance_status IN ('user_confirmed', 'imported'))
);

CREATE TABLE IF NOT EXISTS public.agent_memory_recall_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  runtime_name TEXT,
  runtime_version TEXT,
  task_id TEXT,
  flow_id TEXT,
  channel_kind TEXT,
  channel_id TEXT,
  query TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_memory_recall_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID NOT NULL REFERENCES public.agent_memory_recall_traces(id) ON DELETE CASCADE,
  memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  similarity NUMERIC(5,4),
  ranking_score NUMERIC(7,4),
  returned BOOLEAN NOT NULL DEFAULT true,
  used BOOLEAN,
  ignored_reason TEXT,
  use_policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trace_id, memory_id)
);

CREATE TABLE IF NOT EXISTS public.agent_memory_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system TEXT NOT NULL DEFAULT 'hosted_open_brain',
  source_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'recall_requested',
      'memory_returned',
      'memory_used',
      'memory_ignored',
      'memory_written',
      'memory_confirmed',
      'memory_edited',
      'memory_rejected',
      'memory_superseded',
      'memory_disputed'
    )
  ),
  workspace_id TEXT,
  project_id TEXT,
  memory_id UUID REFERENCES public.agent_memories(id) ON DELETE SET NULL,
  trace_id UUID REFERENCES public.agent_memory_recall_traces(id) ON DELETE SET NULL,
  actor_kind TEXT NOT NULL DEFAULT 'system' CHECK (actor_kind IN ('user', 'agent', 'system', 'import')),
  actor_label TEXT,
  runtime_name TEXT,
  task_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_data JSONB NOT NULL,
  backup_file TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_memory_source_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  uri TEXT,
  title TEXT,
  source_timestamp TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_memory_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_memory_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  to_memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('related_to', 'supersedes', 'superseded_by', 'conflicts_with', 'merged_into')),
  confidence NUMERIC(3,2) DEFAULT 0.50 CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_memory_id, to_memory_id, relation),
  CHECK (from_memory_id <> to_memory_id)
);

CREATE TABLE IF NOT EXISTS public.agent_memory_review_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('confirm', 'edit', 'evidence_only', 'restrict_scope', 'mark_stale', 'merge', 'reject', 'dispute', 'supersede')),
  actor_id TEXT,
  actor_label TEXT,
  notes TEXT,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.entities (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'hosted_open_brain',
  source_id TEXT NOT NULL UNIQUE,
  name TEXT,
  canonical_name TEXT,
  entity_type TEXT,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_data JSONB NOT NULL,
  backup_file TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.edges (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'hosted_open_brain',
  source_id TEXT NOT NULL UNIQUE,
  source_entity_id TEXT,
  target_entity_id TEXT,
  relation_type TEXT,
  confidence DOUBLE PRECISION,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_data JSONB NOT NULL,
  backup_file TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.thought_entities (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'hosted_open_brain',
  source_id TEXT NOT NULL UNIQUE,
  thought_id TEXT,
  entity_id TEXT,
  mention_role TEXT,
  source TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_data JSONB NOT NULL,
  backup_file TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.reflections (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'hosted_open_brain',
  source_id TEXT NOT NULL UNIQUE,
  thought_id TEXT,
  reflection_type TEXT,
  content TEXT,
  model TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_data JSONB NOT NULL,
  backup_file TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ingestion_jobs (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'hosted_open_brain',
  source_id TEXT NOT NULL UNIQUE,
  status TEXT,
  job_type TEXT,
  source_kind TEXT,
  created_by TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_data JSONB NOT NULL,
  backup_file TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ingestion_items (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'hosted_open_brain',
  source_id TEXT NOT NULL UNIQUE,
  job_id TEXT,
  thought_id TEXT,
  status TEXT,
  source_ref TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_data JSONB NOT NULL,
  backup_file TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memories_idempotency_key ON public.agent_memories (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_memories_workspace_idx ON public.agent_memories (workspace_id, project_id, review_status, lifecycle_status);
CREATE INDEX IF NOT EXISTS agent_memories_task_idx ON public.agent_memories (task_id);
CREATE INDEX IF NOT EXISTS agent_memories_content_fts_idx ON public.agent_memories USING gin (to_tsvector('english', coalesce(summary, '') || ' ' || coalesce(content, '')));
CREATE INDEX IF NOT EXISTS agent_memories_side_table_row_data_gin_idx ON public.agent_memories USING gin (row_data);

CREATE INDEX IF NOT EXISTS agent_memory_recall_traces_scope_idx ON public.agent_memory_recall_traces (workspace_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_memory_recall_items_trace_idx ON public.agent_memory_recall_items (trace_id, rank);
CREATE INDEX IF NOT EXISTS agent_memory_recall_items_memory_idx ON public.agent_memory_recall_items (memory_id);

CREATE INDEX IF NOT EXISTS agent_memory_audit_events_memory_idx ON public.agent_memory_audit_events (memory_id, event_type);
CREATE INDEX IF NOT EXISTS agent_memory_audit_events_trace_idx ON public.agent_memory_audit_events (trace_id);
CREATE INDEX IF NOT EXISTS agent_memory_audit_events_side_table_row_data_gin_idx ON public.agent_memory_audit_events USING gin (row_data);

CREATE INDEX IF NOT EXISTS idx_agent_memory_source_refs_memory ON public.agent_memory_source_refs (memory_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_artifacts_memory ON public.agent_memory_artifacts (memory_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_review_actions_memory ON public.agent_memory_review_actions (memory_id, created_at DESC);

CREATE INDEX IF NOT EXISTS entities_name_idx ON public.entities (name);
CREATE INDEX IF NOT EXISTS entities_side_table_row_data_gin_idx ON public.entities USING gin (row_data);
CREATE INDEX IF NOT EXISTS edges_entity_idx ON public.edges (source_entity_id, target_entity_id);
CREATE INDEX IF NOT EXISTS edges_side_table_row_data_gin_idx ON public.edges USING gin (row_data);
CREATE INDEX IF NOT EXISTS thought_entities_thought_idx ON public.thought_entities (thought_id);
CREATE INDEX IF NOT EXISTS thought_entities_entity_idx ON public.thought_entities (entity_id);
CREATE INDEX IF NOT EXISTS thought_entities_side_table_row_data_gin_idx ON public.thought_entities USING gin (row_data);
CREATE INDEX IF NOT EXISTS reflections_thought_idx ON public.reflections (thought_id);
CREATE INDEX IF NOT EXISTS reflections_side_table_row_data_gin_idx ON public.reflections USING gin (row_data);
CREATE INDEX IF NOT EXISTS ingestion_jobs_status_idx ON public.ingestion_jobs (status);
CREATE INDEX IF NOT EXISTS ingestion_jobs_side_table_row_data_gin_idx ON public.ingestion_jobs USING gin (row_data);
CREATE INDEX IF NOT EXISTS ingestion_items_job_idx ON public.ingestion_items (job_id);
CREATE INDEX IF NOT EXISTS ingestion_items_side_table_row_data_gin_idx ON public.ingestion_items USING gin (row_data);

ALTER TABLE public.agent_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_recall_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_recall_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_source_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_review_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thought_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reflections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all ON public.agent_memories;
CREATE POLICY service_role_all ON public.agent_memories FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.agent_memory_recall_traces;
CREATE POLICY service_role_all ON public.agent_memory_recall_traces FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.agent_memory_recall_items;
CREATE POLICY service_role_all ON public.agent_memory_recall_items FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.agent_memory_audit_events;
CREATE POLICY service_role_all ON public.agent_memory_audit_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.agent_memory_source_refs;
CREATE POLICY service_role_all ON public.agent_memory_source_refs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.agent_memory_artifacts;
CREATE POLICY service_role_all ON public.agent_memory_artifacts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.agent_memory_relations;
CREATE POLICY service_role_all ON public.agent_memory_relations FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.agent_memory_review_actions;
CREATE POLICY service_role_all ON public.agent_memory_review_actions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.entities;
CREATE POLICY service_role_all ON public.entities FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.edges;
CREATE POLICY service_role_all ON public.edges FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.thought_entities;
CREATE POLICY service_role_all ON public.thought_entities FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.reflections;
CREATE POLICY service_role_all ON public.reflections FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.ingestion_jobs;
CREATE POLICY service_role_all ON public.ingestion_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.ingestion_items;
CREATE POLICY service_role_all ON public.ingestion_items FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_memories TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_memory_recall_traces TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_memory_recall_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_memory_audit_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_memory_source_refs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_memory_artifacts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_memory_relations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_memory_review_actions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.entities TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.edges TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thought_entities TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reflections TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ingestion_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ingestion_items TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

EOSQL

echo "  [init/04] done."
