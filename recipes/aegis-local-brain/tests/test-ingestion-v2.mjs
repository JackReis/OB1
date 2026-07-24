import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POSTGREST_URL = "http://localhost:3000";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";
process.env.EMBED_NORMALIZE = "1";

const {
  embeddingMetadata,
  normalizeEmbedding,
  splitIngestContent,
  staleSourceFilter,
  stableIngestKey,
} = await import("../api/server.mjs");

test("normalizeEmbedding produces a unit vector", () => {
  const vector = normalizeEmbedding([3, 4]);
  assert.ok(Math.abs(vector[0] - 0.6) < 1e-12);
  assert.ok(Math.abs(vector[1] - 0.8) < 1e-12);
});

test("embeddingMetadata records the versioned embedding contract", () => {
  const metadata = embeddingMetadata("2026-07-24T00:00:00.000Z");
  assert.equal(metadata.embedding_provider, "ollama");
  assert.equal(metadata.embedding_model, "mxbai-embed-large");
  assert.equal(metadata.embedding_dimensions, 1024);
  assert.equal(metadata.embedding_normalized, true);
  assert.match(metadata.embedding_version, /mxbai-embed-large:1024/);
});

test("stableIngestKey is deterministic and version-sensitive", () => {
  const base = { source: "vault", sourceUri: "vault://note/1", sourceVersion: "v1", index: 0, content: "hello" };
  assert.equal(stableIngestKey(base), stableIngestKey(base));
  assert.notEqual(stableIngestKey(base), stableIngestKey({ ...base, sourceVersion: "v2" }));
});

test("splitIngestContent groups paragraphs within the configured size", () => {
  assert.deepEqual(splitIngestContent("one\n\ntwo\n\nthree", 8), ["one\n\ntwo", "three"]);
  assert.deepEqual(splitIngestContent("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("staleSourceFilter includes NULL and older source versions", () => {
  assert.equal(
    staleSourceFilter("vault://note/1", "v2"),
    "/thoughts?source_uri=eq.vault%3A%2F%2Fnote%2F1&or=(source_version.is.null,source_version.neq.v2)",
  );
});
