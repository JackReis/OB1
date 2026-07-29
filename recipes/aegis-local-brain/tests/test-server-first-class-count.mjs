import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POSTGREST_URL = "http://postgrest-test:3000";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";

const originalFetch = globalThis.fetch;

// Mock that returns different counts per table
function mockFetchPerTable(counts) {
  return async (url, options) => {
    // Extract table name from URL path (e.g., http://host:port/agent_memories?...)
    const urlObj = new URL(url);
    const pathSegments = urlObj.pathname.split("/").filter(Boolean);
    const table = pathSegments[0] || "";
    const count = counts[table] ?? 0;
    return {
      ok: true,
      status: 206,
      headers: { get: (name) => name === "content-range" ? `0-0/${count}` : null },
      json: async () => [],
      text: async () => "[]",
    };
  };
}

test("handleFirstClassSideTableCount: returns count for specific table", async () => {
  globalThis.fetch = mockFetchPerTable({ agent_memories: 15 });
  const { handleFirstClassSideTableCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/first-class/count?table=agent_memories");
  const result = await handleFirstClassSideTableCount(url);

  assert.equal(result.ok, true);
  assert.equal(result.table, "agent_memories");
  assert.equal(result.count, 15);
  assert.equal(result.first_class_count, 15);
  globalThis.fetch = originalFetch;
});

test("handleFirstClassSideTableCount: returns total count across all tables when no table specified", async () => {
  globalThis.fetch = mockFetchPerTable({
    agent_memories: 10, agent_memory_audit_events: 5,
    entities: 20, edges: 8, thought_entities: 3,
    reflections: 2, ingestion_jobs: 1, ingestion_items: 4,
  });
  const { handleFirstClassSideTableCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/first-class/count");
  const result = await handleFirstClassSideTableCount(url);

  assert.equal(result.ok, true);
  assert.equal(result.table, null);
  assert.equal(result.count, 10 + 5 + 20 + 8 + 3 + 2 + 1 + 4);
  assert.equal(result.first_class_count, result.count);
  assert.ok(result.counts);
  assert.equal(result.counts.agent_memories, 10);
  globalThis.fetch = originalFetch;
});

test("handleFirstClassSideTableCount: rejects unsupported table", async () => {
  globalThis.fetch = mockFetchPerTable({});
  const { handleFirstClassSideTableCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/first-class/count?table=invalid");
  await assert.rejects(
    () => handleFirstClassSideTableCount(url),
    /unsupported first-class table/
  );
  globalThis.fetch = originalFetch;
});