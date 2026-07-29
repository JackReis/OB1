# Aegis Local Brain

Self-hosted Open Brain for Aegis without the hosted Supabase project or the self-hosted Supabase stack. This recipe keeps the small capture/search/list HTTP shape used by OB1 workers, but replaces the cloud quota dependency with:

- Postgres 15 plus pgvector for storage and similarity search
- PostgREST as an internal database facade
- a dependency-free Node API that calls Aegis Ollama for embeddings
- a local access key named `BRAIN_ACCESS_KEY`

The default API bind is `127.0.0.1:8787`, so it is not exposed to the LAN unless you deliberately change `BRAIN_BIND_ADDR`.

## Status

This is the replacement lane for the over-quota hosted Open Brain database. It is intentionally separate from `local-brain-no-mcp`, which still runs the full Supabase Docker stack.

## Setup On Aegis

```sh
cd ~/Projects/Sea\ Ranch\ AI/OB1/recipes/aegis-local-brain
./setup.sh
docker compose up -d
curl -fsS http://127.0.0.1:8787/health
```

`setup.sh` writes `.env` with mode `0600` and does not print secret values.

## Smoke Test

Read `BRAIN_ACCESS_KEY` from `.env` on Aegis, then:

```sh
curl -fsS -X POST http://127.0.0.1:8787/functions/v1/capture \
  -H "x-brain-key: $BRAIN_ACCESS_KEY" \
  -H "content-type: application/json" \
  -d '{"content":"first Aegis local brain smoke thought","metadata":{"source":"smoke-test"}}'

curl -fsS -X POST http://127.0.0.1:8787/functions/v1/search \
  -H "x-brain-key: $BRAIN_ACCESS_KEY" \
  -H "content-type: application/json" \
  -d '{"query":"Aegis local brain","match_count":5,"match_threshold":0.5}'
```

## Local MCP Client Repointing

Hosted Supabase clients that currently call the Open Brain MCP Edge Function can be repointed to the Aegis-local endpoint:

```text
http://127.0.0.1:8787/functions/v1/open-brain-mcp
```

Use the local `BRAIN_ACCESS_KEY` from `.env` as the `x-brain-key` header. Do not use a hosted Supabase service-role key for this local API.

On Aegis, the Hermes Open Brain bridge is repointed to this local endpoint:

```text
~/.hermes/bin/openbrain-mcp-wrapper.sh
```

The wrapper runs the Hermes Python environment, calls `http://127.0.0.1:8787/functions/v1/open-brain-mcp`, and loads the local access key from this recipe's `.env` file at runtime. It does not embed the key.

Read-only stats smoke test:

```sh
curl -fsS -X POST http://127.0.0.1:8787/functions/v1/open-brain-mcp \
  -H "x-brain-key: $BRAIN_ACCESS_KEY" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"thought_stats","arguments":{}}}'
```

Implemented local tools:

- `search` and `fetch` for ChatGPT-style read-only connector compatibility
- `search_thoughts`
- `list_thoughts`
- `thought_stats`
- `capture_thought`

## Local Dashboard REST Repointing

Dashboard clients that previously used the hosted `open-brain-rest` Supabase Edge Function can point core pages at Aegis:

```sh
NEXT_PUBLIC_API_URL=http://127.0.0.1:8787
```

To write ignored local dashboard env files for the maintained Next dashboards:

```sh
node ~/Projects/Sea\ Ranch\ AI/OB1/recipes/aegis-local-brain/scripts/repoint-dashboard-envs.mjs
```

The script writes `open-brain-dashboard-next/.env.local` and `open-brain-dashboard-pro/.env.local` with `NEXT_PUBLIC_API_URL=http://127.0.0.1:8787`, generates `SESSION_SECRET`, and does not store `BRAIN_ACCESS_KEY`; enter the local key at dashboard login.

Use the same local `BRAIN_ACCESS_KEY` as the dashboard/API key. The server also accepts `x-ingest-key` as an alias for importers that already use that header name. Implemented REST compatibility routes:

| Endpoint | Method | Local support |
| --- | --- | --- |
| `/health` | GET | API health |
| `/count` | GET | Total count plus type/source counts; accepts `migrated_from` for migration verification |
| `/stats` | GET | Total count, type counts, top topics |
| `/thoughts` | GET | Paginated browse with core filters |
| `/thought/:id` | GET | Thought detail |
| `/thought/:id` | PUT | Local workflow/status/content update |
| `/thought/:id` | DELETE | Local thought delete |
| `/thought/:id/connections` | GET | First-class `thought_entities` graph connections when available; local topic/text fallback otherwise |
| `/thought/:id/reflection` | GET/POST | Persisted first-class reflection rows in `reflections` |
| `/capture` | POST | Single-thought capture |
| `/search` | POST | Semantic and text search |
| `/duplicates` | GET | Local token-similarity duplicate review |
| `/duplicates/resolve` | POST | Keep/delete/keep-both duplicate resolution |
| `/ingest` | POST | Dry-run by default; single/paragraph capture when `dry_run:false`, with persisted `ingestion_jobs` and `ingestion_items` rows |
| `/ingestion-jobs` | GET | Persisted first-class ingest job list |
| `/ingestion-jobs/:id` | GET | Persisted ingest job detail plus items |
| `/ingestion-jobs/:id/execute` | POST | Marks a persisted pending ingest job as running |
| `/backup/archive` | POST | Local archive for exported hosted side-table rows |
| `/backup/archive/count?table=entities` | GET | Count archived rows for a backup side table |
| `/backup/first-class/count?table=agent_memories` | GET | Count rows promoted into first-class local side tables |

For clients that keep the old Edge Function path in their base URL, Aegis also accepts hosted-shape REST aliases such as `/functions/v1/open-brain-rest/health`, `/functions/v1/open-brain-rest/count`, and `/functions/v1/open-brain-rest/search`.

Reflection, graph, and ingestion routes now use the first-class local side tables where data exists. Graph connections fall back to local topic/text similarity when no `thought_entities` rows exist for a thought.

## Local Agent Memory Repointing

Dashboard Agent Memory pages that previously used the hosted `agent-memory-api` Supabase Edge Function can point at Aegis too:

```sh
AGENT_MEMORY_API_URL=http://127.0.0.1:8787
```

Use the same local `BRAIN_ACCESS_KEY` as the Agent Memory API key. The server also accepts the old suffix form, `http://127.0.0.1:8787/agent-memory-api`, for clients that keep the Edge Function-style base URL.

For clients that keep a full hosted-style base path, Aegis also accepts `/functions/v1/agent-memory-api/...` aliases.

Implemented local Agent Memory compatibility routes:

| Endpoint | Method | Local support |
| --- | --- | --- |
| `/agent-memory-api/health` | GET | Agent Memory compatibility health |
| `/memories` | GET | Lists thoughts tagged as `agent_memory` |
| `/memories/review` | GET | Pending-review memory list |
| `/memories/:id` | GET | Memory detail reconstructed from thought metadata |
| `/memories/:id/review` | PATCH | Local metadata-backed review status update |
| `/recall` | POST | Local recall over agent-memory thoughts |
| `/writeback` | POST | Writes compact Agent Memory rows into first-class local tables |
| `/recall/:request_id/usage` | POST | Compatibility acknowledgement |
| `/recall-traces/:request_id` | GET | Persisted first-class recall trace and item detail |
| `/audit-events` | GET | Lists first-class Agent Memory audit events |

The local Agent Memory layer writes per-turn memory directly into first-class `agent_memories`, `agent_memory_recall_traces`, `agent_memory_recall_items`, and first-class `agent_memory_audit_events` tables, so turn sync does not depend on embedding availability. Set `AGENT_MEMORY_CAPTURE_THOUGHTS=1` only if you also want writeback rows captured into `thoughts` for legacy thought-search compatibility. The compatibility route names stay stable so hosted Edge Function clients can repoint without a route rewrite.

To repoint the two Aegis Hermes runtime env files without printing the key:

```sh
node ~/Projects/Sea\ Ranch\ AI/OB1/recipes/aegis-local-brain/scripts/configure-agent-memory-envs.mjs
```

Use `--dry-run` first when auditing. The script reads `BRAIN_ACCESS_KEY` from this recipe's `.env`, writes `OPENBRAIN_URL=http://127.0.0.1:8787/agent-memory-api`, stores `OPENBRAIN_KEY` only in the target env files, creates local backups, and prints `<redacted>` for secret values.

## Migration

First export the hosted Open Brain tables with `OB1/recipes/brain-backup/backup-brain.mjs`. Then replay the thoughts backup into Aegis:

```sh
cd ~/Projects/Sea\ Ranch\ AI/OB1/recipes/aegis-local-brain
node scripts/import-supabase-backup.mjs --dry-run ../brain-backup/backup
node scripts/import-supabase-backup.mjs --verify ../brain-backup/backup
curl -fsS "http://127.0.0.1:8787/count?migrated_from=open-brain-supabase-backup" \
  -H "x-brain-key: $BRAIN_ACCESS_KEY"
```

The importer re-embeds content with the local Ollama model and preserves the old row id and timestamps in metadata as `source_id`, `source_created_at`, and `source_updated_at`. It writes `metadata.migrated_from=open-brain-supabase-backup` so `/count?migrated_from=open-brain-supabase-backup` can verify the local imported count. Because the local write path keeps OB1's content-fingerprint dedupe behavior, the verifier compares against the backup's `expected_unique_fingerprints`, not raw JSON row count.

When `manifest-*.json` is present in the backup directory, the importer validates it before dry-run or import. It rejects incomplete manifests, missing files, file-size mismatches, and `sha256` mismatches before any local write is attempted.

The importer also archives non-thought backup tables (`entities`, `edges`, `thought_entities`, `reflections`, `ingestion_jobs`, `ingestion_items`, `agent_memories`, and `agent_memory_audit_events`) into `backup_archive_rows` and promotes those rows into first-class local side tables when matching backup files are present. The current 2026-06-29 backup includes `agent_memories` and `agent_memory_audit_events`; graph/reflection/ingestion first-class tables are present but naturally stay empty until those backup files exist.

Archive count smoke test:

```sh
curl -fsS "http://127.0.0.1:8787/backup/archive/count?table=entities" \
  -H "x-brain-key: $BRAIN_ACCESS_KEY"
curl -fsS "http://127.0.0.1:8787/backup/archive/count?table=agent_memories" \
  -H "x-brain-key: $BRAIN_ACCESS_KEY"
curl -fsS "http://127.0.0.1:8787/backup/first-class/count?table=agent_memories" \
  -H "x-brain-key: $BRAIN_ACCESS_KEY"
```

## Cutover Readiness Gate

Before proposing hosted Supabase cleanup, run the local readiness gate:

```sh
node ~/Projects/Sea\ Ranch\ AI/OB1/recipes/aegis-local-brain/scripts/cutover-readiness.mjs --json
```

The script does not require Docker Compose. It checks the Aegis-local HTTP health endpoint, hosted backup preflight metadata, latest backup manifest, imported backup count, dashboard `.env.local` repointing, the Hermes Open Brain bridge, and Codex rules. It prints safe metadata only and never prints `BRAIN_ACCESS_KEY` or `SUPABASE_SERVICE_ROLE_KEY`.

`hosted_cleanup_ready` must be `true` before any hosted Supabase cleanup proposal. If it is `false`, use the `blockers` array as the next-action list.

## Embedding Dimension

Default:

```sh
EMBED_MODEL=mxbai-embed-large
EMBED_DIM=1024
```

The vector dimension is baked into the Postgres volume on first boot. To switch models later, export the data, stop the stack, remove the database volume, update `.env`, start the stack, and re-import.

## What This Does Not Do Yet

- It does not delete or pause the hosted project.
- It imports `thoughts` into the local thoughts table, archives side-table rows in `backup_archive_rows`, and promotes available side-table backup files into first-class local tables.
- It implements the core dashboard REST routes plus local workflow update/delete, duplicate review, graph-backed connection hints with heuristic fallback, persisted reflections, persisted ingest jobs/items, and table-backed Agent Memory compatibility routes.
