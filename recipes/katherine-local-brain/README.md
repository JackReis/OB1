# Katherine Local Brain

Self-hosted Open Brain for the Katherine lane without the hosted Supabase project or the self-hosted Supabase stack. This recipe keeps the small capture/search/list HTTP shape used by OB1 workers, but replaces the cloud quota dependency with:

- Postgres 15 plus pgvector for storage and similarity search
- PostgREST as an internal database facade
- a dependency-free Node API that calls local Ollama for embeddings
- a local access key named `BRAIN_ACCESS_KEY`

The default API bind is `127.0.0.1:8788`, so it is not exposed to the LAN unless you deliberately change `BRAIN_BIND_ADDR`.

## Status

This is the Katherine lane's local brain instance. It is intentionally separate from the Aegis local brain (port 8787) and Family local brain (port 8790).

## Setup

```sh
cd /Users/jack.reis/Projects/Sea\ Ranch\ AI/OB1/recipes/katherine-local-brain
./setup.sh
docker compose up -d
curl -fsS http://127.0.0.1:8788/health
```

`setup.sh` writes `.env` with mode `0600` and does not print secret values.

## Smoke Test

Read `BRAIN_ACCESS_KEY` from `.env`, then:

```sh
curl -fsS -X POST http://127.0.0.1:8788/functions/v1/capture \
  -H "x-brain-key: $BRAIN_ACCESS_KEY" \
  -H "content-type: application/json" \
  -d '{"content":"first Katherine local brain smoke thought","metadata":{"source":"smoke-test"}}'

curl -fsS -X POST http://127.0.0.1:8788/functions/v1/search \
  -H "x-brain-key: $BRAIN_ACCESS_KEY" \
  -H "content-type: application/json" \
  -d '{"query":"Katherine local brain","match_count":5,"match_threshold":0.5}'
```

## Local MCP Client Repointing

Hosted Supabase clients that currently call the Open Brain MCP Edge Function can be repointed to the Katherine-local endpoint:

```text
http://127.0.0.1:8788/functions/v1/open-brain-mcp
```

Use the local `BRAIN_ACCESS_KEY` from `.env` as the `x-brain-key` header. Do not use a hosted Supabase service-role key for this local API.

Read-only stats smoke test:

```sh
curl -fsS -X POST http://127.0.0.1:8788/functions/v1/open-brain-mcp \
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

Dashboard clients that previously used the hosted `open-brain-rest` Supabase Edge Function can point core pages at the Katherine brain:

```sh
NEXT_PUBLIC_API_URL=http://127.0.0.1:8788
```

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

For clients that keep the old Edge Function path in their base URL, the Katherine brain also accepts hosted-shape REST aliases such as `/functions/v1/open-brain-rest/health`, `/functions/v1/open-brain-rest/count`, and `/functions/v1/open-brain-rest/search`.

Reflection, graph, and ingestion routes now use the first-class local side tables where data exists. Graph connections fall back to local topic/text similarity when no `thought_entities` rows exist for a thought.

## Local Agent Memory Repointing

Dashboard Agent Memory pages that previously used the hosted `agent-memory-api` Supabase Edge Function can point at the Katherine brain too:

```sh
AGENT_MEMORY_API_URL=http://127.0.0.1:8788
```

Use the same local `BRAIN_ACCESS_KEY` as the Agent Memory API key. The server also accepts the old suffix form, `http://127.0.0.1:8788/agent-memory-api`, for clients that keep the Edge Function-style base URL.

For clients that keep a full hosted-style base path, the Katherine brain also accepts `/functions/v1/agent-memory-api/...` aliases.

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
