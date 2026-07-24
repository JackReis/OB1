# Aegis Local Brain Ingestion and Retrieval V2

**Status:** implementation complete on feature branch; production rollout blocked on review

## Locked decisions

- Keep Postgres 15, pgvector, PostgREST, Node 22, Ollama, the `thoughts` table, and the existing side tables.
- Keep `mxbai-embed-large` at 1024 dimensions. Standardize every new vector with L2 normalization and the version string `ollama:mxbai-embed-large:1024:v1`.
- Preserve the existing content fingerprint dedupe contract. Add a deterministic `ingest_key` for source/version/chunk idempotency.
- Ship retrieval v2 as `off`, then `shadow`, then `on`. Shadow mode computes hybrid results but returns the current semantic ranking.
- Do not rewrite the 159k-vector corpus during schema rollout. Backfill metadata first; re-embed only through a separately approved, resumable job.

## What changed

- Versioned embedding metadata and explicit storage columns.
- Deterministic ingestion job and item IDs derived from source URI, source version, and chunk index.
- Source allowlist, per-source rate limit, chunk limits, and persisted failure state.
- Source-aware bounded paragraph chunking.
- Hybrid lexical/vector retrieval with reciprocal-rank fusion.
- JSON operational metrics at authenticated `GET /metrics`.
- Additive migration and feature flags with default-off behavior.

## Rollout

1. Back up the database and record current row/index counts.
2. Apply `db/migrations/20260724-ingestion-v2.sql` in a transaction.
3. Install the updated RPCs from `db/init/02-open-brain-rpcs.sh` and reload PostgREST.
4. Restart with `INGEST_V2_ENABLED=0` and `RETRIEVAL_V2_MODE=off`; verify health and legacy capture/search.
5. Set `INGEST_V2_ENABLED=1` for one allowlisted source. Reprocess the same source/version twice and confirm stable row counts and thought IDs.
6. Set `RETRIEVAL_V2_MODE=shadow`; compare top IDs, latency, Recall@10, nDCG@10, and no-answer precision.
7. Promote retrieval to `on` only after the benchmark and seven-day canary pass.

## Verification gates

- Zero dimension mismatches and zero non-finite vectors.
- Every new vector has provider, model, dimension, version, normalization, and timestamp metadata.
- Replaying an identical source/version does not add rows.
- Source allowlist and rate-limit failures return 403/429 and mark ingest jobs failed where a job exists.
- Legacy capture/search behavior passes with both flags off.
- Hybrid mode improves the agreed benchmark without ACL or freshness regressions.

## Rollback

- Immediate: set `INGEST_V2_ENABLED=0` and `RETRIEVAL_V2_MODE=off`, then restart the API.
- Database: the migration is additive. Leave columns and indexes in place during rollback; old code ignores them.
- Data: restore from the pre-migration backup only if migration validation fails. Do not drop columns during an incident.

## Review gate

Do not merge or deploy until independent Claude Code and Gemini reviews are attached to the pull request and all blocking findings are resolved. Exact requested reviewer model aliases must be recorded; unavailable aliases are a blocker, not silently substituted.
