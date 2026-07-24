# Review Gate

**Merge status:** blocked pending Gemini 3.1 Pro review

## Plan lock

The implementation specification was locked before coding against the verified live stack: Node 22, PostgREST, PostgreSQL 15/pgvector, `mxbai-embed-large` at 1024 dimensions, 159,772 embedded thoughts, and existing `thoughts`, `ingestion_jobs`, and `ingestion_items` tables. The requested GPT 5.6 Sol alias was not available in the agent runtime, so the active Codex reviewer performed the lock without claiming that model identity.

## Claude Code Fable 5

Claude Fable 5 completed two read-only reviews. The first pass found shadow-mode fault propagation, an ingest-key concurrency race, stale source versions, a blocking FTS index build, and missing flag-path tests. Those findings were fixed with:

- semantic fallback when shadow hybrid retrieval fails;
- a transaction-scoped advisory lock for deterministic ingest keys;
- superseding old and NULL-version chunks for the same source URI;
- `CREATE INDEX CONCURRENTLY` after the migration transaction;
- dedicated v2 capture, shadow fallback, and stale-version filter tests.

The second pass found one remaining NULL-filter bug in stale-version supersession. It was corrected and covered by a regression test. No Claude blocker remains.

## Gemini 3.1 Pro

The installed Gemini CLI rejected authentication because that client is no longer supported for the connected individual tier. The Antigravity bridge binary was present, but its local language-server address was not available in this background session. No substitute model was silently used.

The pull request must remain unmerged until Gemini 3.1 Pro completes a read-only review and any blocking findings are addressed.

## Verification receipts

- 18 targeted Node tests pass.
- Node syntax and shell syntax checks pass.
- The full database init and additive migration pass against a disposable `pgvector/pgvector:pg15` container.
- `git diff --check` passes.
- Production was not migrated, restarted, or re-embedded.
