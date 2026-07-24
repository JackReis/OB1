import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POSTGREST_URL = "http://postgrest-test:3000";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";

const originalFetch = globalThis.fetch;

function mockFetchWithCount(count) {
  return async (url, options) => {
    return {
      ok: true,
      status: 206,
      headers: {
        get: (name) => name === "content-range" ? `0-0/${count}` : null,
      },
      json: async () => [],
      text: async () => "[]",
    };
  };
}

test("handleBackupArchiveCount: returns count for specific table", async () => {
  globalThis.fetch = mockFetchWithCount(42);
  const { handleBackupArchiveCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/archive/count?table=agent_memories");
  const result = await handleBackupArchiveCount(url);

  assert.equal(result.ok, true);
  assert.equal(result.table, "agent_memories");
  assert.equal(result.count, 42);
  assert.equal(result.source_system, "hosted_open_brain");
  globalThis.fetch = originalFetch;
});

test("handleBackupArchiveCount: returns count without table filter", async () => {
  globalThis.fetch = mockFetchWithCount(100);
  const { handleBackupArchiveCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/archive/count");
  const result = await handleBackupArchiveCount(url);

  assert.equal(result.ok, true);
  assert.equal(result.table, null);
  assert.equal(result.count, 100);
  globalThis.fetch = originalFetch;
});

test("handleBackupArchiveCount: rejects unsupported table", async () => {
  globalThis.fetch = mockFetchWithCount(0);
  const { handleBackupArchiveCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/archive/count?table=invalid");
  await assert.rejects(
    () => handleBackupArchiveCount(url),
    /unsupported archive table/
  );
  globalThis.fetch = originalFetch;
});

test("handleBackupArchiveCount: returns 0 for wildcard content-range", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 206,
    headers: { get: (name) => name === "content-range" ? "0-0/*" : null },
    json: async () => [],
    text: async () => "[]",
  });
  const { handleBackupArchiveCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/archive/count?table=entities");
  const result = await handleBackupArchiveCount(url);
  assert.equal(result.count, 0);
  globalThis.fetch = originalFetch;
});