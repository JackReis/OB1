import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POSTGREST_URL = "http://postgrest.test";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";
process.env.RETRIEVAL_V2_MODE = "shadow";
process.env.EMBED_DIM = "1024";

const { handleSearch } = await import("../api/server.mjs");

test("shadow retrieval degrades to semantic results when hybrid RPC fails", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/embed")) {
      return { ok: true, json: async () => ({ embeddings: [Array(1024).fill(0.01)] }) };
    }
    if (String(url).includes("/rpc/match_thoughts")) {
      return { ok: true, json: async () => ([{ id: "semantic-1", similarity: 0.8 }]) };
    }
    if (String(url).includes("/rpc/hybrid_search_thoughts")) {
      return { ok: false, status: 503, text: async () => "not ready" };
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await handleSearch({ query: "brain" });
  assert.equal(result.mode, "semantic");
  assert.equal(result.matches[0].id, "semantic-1");
  assert.equal(result.retrieval_v2.degraded, true);
});
