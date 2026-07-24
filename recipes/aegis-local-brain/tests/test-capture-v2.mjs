import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POSTGREST_URL = "http://postgrest.test";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";
process.env.INGEST_V2_ENABLED = "1";
process.env.EMBED_NORMALIZE = "1";
process.env.EMBED_DIM = "1024";

const { handleCapture } = await import("../api/server.mjs");

test("v2 capture routes through the versioned upsert RPC", async () => {
  let rpcBody;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/api/embed")) {
      return { ok: true, json: async () => ({ embeddings: [Array(1024).fill(0.01)] }) };
    }
    if (String(url).includes("/rpc/upsert_thought_v2")) {
      rpcBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: "thought-1", fingerprint: "fingerprint-1" }) };
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await handleCapture({ content: "hello", ingest_key: "stable-key", source_type: "vault" });
  assert.equal(result.id, "thought-1");
  assert.equal(rpcBody.p_ingest_key, "stable-key");
  assert.equal(rpcBody.p_metadata.embedding_version, "ollama:mxbai-embed-large:1024:v1");
  assert.equal(rpcBody.p_metadata.embedding_normalized, true);
});
