# Open Brain REST Gateway

`open-brain-rest` is the Supabase Edge Function used by the Next.js dashboard for the non-Agent-Memory OB1 surfaces:

- Dashboard stats and recent thoughts
- Thoughts browse/detail/edit/delete
- Search
- Workflow kanban updates
- Duplicate review
- Audit review
- Add to Brain

Agent Memory stays in `integrations/agent-memory-api`. This gateway only handles the base `thoughts` operational surface.

## Required Secrets

Set these as Supabase function secrets:

| Secret | Use |
| --- | --- |
| `MCP_ACCESS_KEY` | Dashboard/API access key, sent as `x-brain-key` |
| `OPENROUTER_API_KEY` | Default OpenRouter embeddings plus metadata extraction. Optional for embeddings when `EMBEDDING_PROVIDER` points at a local provider, but still used for metadata extraction when configured and request metadata is not supplied. |
| `EMBEDDING_PROVIDER` | Optional embedding provider mode: `openai-compatible` (default) or `ollama`. |
| `EMBEDDING_BASE_URL` | Optional embedding base URL. Use an OpenAI-compatible `/v1` route or a native Ollama host. |
| `EMBEDDING_API_KEY` | Optional bearer token for a local/OpenAI-compatible embedding gateway. Do not set this if the local route is unauthenticated. |
| `EMBEDDING_MODEL` | Optional embedding model override. Defaults to `openai/text-embedding-3-small` or `nomic-embed-text` for Ollama. |
| `EMBEDDING_DIM` | Optional expected vector dimension. Defaults to 1536 for OpenAI-compatible embeddings, 768 for `nomic-embed-text`, and 1024 for `mxbai-embed-large`. |
| `OLLAMA_EMBED_PATH` | Optional native Ollama path. Defaults to `/api/embed`; set `/api/embeddings` for the legacy prompt-style endpoint. |
| `SUPABASE_URL` | Provided automatically by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Provided automatically by Supabase |

## Embedding Provider Routing

By default, semantic search and capture use the OpenRouter-compatible embedding path:

```sh
OPENROUTER_API_KEY=...
```

For a local or Caddy-fronted OpenAI-compatible embedding service, configure:

```sh
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=https://your-local-embedding-gateway.example/v1
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIM=1536
```

Set `EMBEDDING_API_KEY` only if that gateway expects a bearer token. The key is sent in the `Authorization` header and is never required for an unauthenticated loopback or private LAN route.

For native Ollama, configure:

```sh
EMBEDDING_PROVIDER=ollama
EMBEDDING_BASE_URL=http://ollama:11434
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIM=768
OLLAMA_EMBED_PATH=/api/embed
```

`OLLAMA_URL` can be used instead of `EMBEDDING_BASE_URL` for compatibility with the local-brain-no-mcp recipe. If you need Ollama's legacy endpoint, set `OLLAMA_EMBED_PATH=/api/embeddings`.

The local-brain-no-mcp aliases `EMBED_MODEL` and `EMBED_DIM` are also accepted when `EMBEDDING_MODEL` and `EMBEDDING_DIM` are not set.

Local embedding routing only covers vector generation. Capture metadata extraction still uses OpenRouter when `OPENROUTER_API_KEY` is configured and the `/capture` request does not supply metadata. To avoid OpenRouter during capture, leave metadata extraction unconfigured by omitting `OPENROUTER_API_KEY`, or supply metadata in the capture payload so extraction is bypassed for that request. When OpenRouter metadata is unconfigured or unavailable, the gateway uses fallback metadata.

### Vector Dimension Gate

The stored `thoughts.embedding` vector dimension must match the selected model. The default Open Brain setup commonly uses `vector(1536)` for `openai/text-embedding-3-small`. Aegis-local Ollama models currently include `nomic-embed-text` (768 dimensions) and `mxbai-embed-large` (1024 dimensions), which must not be mixed into an existing 1536-dimension corpus without an explicit schema migration and full re-embedding.

Before changing a deployed brain to 768- or 1024-dimension local embeddings, choose one of these paths:

- Use a 1536-dimension local/OpenAI-compatible embedding model.
- Migrate the pgvector schema and re-embed the corpus.
- Route to a separate local-brain stack already bootstrapped at the matching vector dimension.

## Required Database Shape

Apply the base OB1 schema plus:

- `schemas/enhanced-thoughts/schema.sql`
- `schemas/workflow-status/migration.sql`

The function expects `thoughts.id` to be a UUID. The dashboard now treats thought IDs as strings end to end.

## Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Auth/API health check |
| `/stats` | GET | Aggregate count, type, and topic stats |
| `/thoughts` | GET | Paginated thought browse with filters |
| `/thought/:id` | GET/PUT/DELETE | Detail, edit, delete |
| `/capture` | POST | Save one thought |
| `/search` | POST | Semantic or text search |
| `/duplicates` | GET | Near-duplicate scan |
| `/thought/:id/connections` | GET | Metadata-overlap connections |
| `/thought/:id/reflection` | GET/POST | Reflection reads/writes when the optional table exists |
| `/ingestion-jobs` | GET | Smart-ingest placeholder for dashboard compatibility |
| `/ingest` | POST | Current v1 fallback captures input as one thought |

## Deploy

From a Supabase workdir, copy or symlink this folder to `supabase/functions/open-brain-rest`, then deploy:

```bash
supabase functions deploy open-brain-rest --no-verify-jwt --use-api --project-ref YOUR_PROJECT_REF
```

The dashboard should point `NEXT_PUBLIC_API_URL` at:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-rest
```

## Smoke Test

Run the live smoke harness against a deployed function:

```bash
OB1_REST_URL="https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-rest" \
OB1_REST_KEY="YOUR_MCP_ACCESS_KEY" \
node integrations/open-brain-rest/smoke/live-smoke.mjs
```

The smoke creates three temporary rows, verifies health, capture, browse, stats, text search, workflow update, duplicate scan, and audit filtering, then deletes the rows. Pass `--keep` only when you intentionally want to inspect the created rows.

## Dashboard Demo Seed

To seed the same data story used by the screenshot/PDF/video walkthrough:

```bash
OB1_REST_URL="https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-rest" \
OB1_REST_KEY="YOUR_MCP_ACCESS_KEY" \
node integrations/open-brain-rest/smoke/seed-dashboard-demo.mjs --apply
```

Run without `--apply` first for a dry run. The seed writes through `/capture`, so it exercises the real dashboard gateway and embedding path.

## Notes

- Duplicate review uses a local token-similarity scan in v1. It is intentionally simple and cheap for solo/small-team OB1 deployments.
- Semantic search and capture require a working embedding route: default OpenRouter with `OPENROUTER_API_KEY`, an OpenAI-compatible local gateway, or native Ollama.
- Local embeddings do not require `OPENROUTER_API_KEY`; capture is only fully OpenRouter-free when metadata extraction is unconfigured or request metadata is supplied.
- Reflection and smart-ingest routes are compatibility surfaces. If the optional tables/workers are missing, the dashboard still works for the core thoughts/workflow/search/audit surfaces.
