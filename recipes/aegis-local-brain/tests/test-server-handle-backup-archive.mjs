import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POSTGREST_URL = "http://postgrest-test:3000";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";

// We need to test handleBackupArchive which calls postgrestPost internally.
// postgrestPost calls fetch() against POSTGREST_URL.
// We mock globalThis.fetch to intercept those calls.

let fetchCalls = [];

function mockFetchResponse({ status = 200, body = "", headers = {} } = {}) {
  const headerMap = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headerMap.get(name) || null },
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const originalFetch = globalThis.fetch;

test("handleBackupArchive: archives valid rows and promotes to side tables", async () => {
  fetchCalls = [];
  let archiveCallBody = null;
  let promoteCallBody = null;

  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, method: options?.method, body: options?.body });
    if (url.includes("/backup_archive_rows")) {
      archiveCallBody = JSON.parse(options.body);
      return mockFetchResponse({ status: 201, body: "[]", headers: {} });
    }
    if (url.includes("/agent_memories?on_conflict=source_id")) {
      promoteCallBody = JSON.parse(options.body);
      return mockFetchResponse({ status: 201, body: "[]", headers: {} });
    }
    return mockFetchResponse({ status: 200, body: "[]" });
  };

  const { handleBackupArchive } = await import("../api/server.mjs");

  const result = await handleBackupArchive({
    table: "agent_memories",
    rows: [
      { id: "m1", workspace_id: "ws-1", memory_type: "decision", summary: "test", content: "content" },
      { id: "m2", workspace_id: "ws-1", memory_type: "lesson", summary: "test2", content: "content2" },
    ],
    backup_file: "agent_memories-2026-06-29.json",
  });

  assert.equal(result.ok, true);
  assert.equal(result.table, "agent_memories");
  assert.equal(result.archived_count, 2);
  assert.equal(result.promoted_count, 2);
  assert.equal(result.skipped_count, 0);

  // Verify archive records have correct structure
  assert.ok(archiveCallBody);
  assert.equal(archiveCallBody.length, 2);
  assert.equal(archiveCallBody[0].source_system, "hosted_open_brain");
  assert.equal(archiveCallBody[0].table_name, "agent_memories");
  assert.equal(archiveCallBody[0].source_id, "m1");
  assert.equal(archiveCallBody[0].backup_file, "agent_memories-2026-06-29.json");

  // Verify promote call uses source_id conflict resolution
  assert.ok(promoteCallBody);
  assert.equal(promoteCallBody.length, 2);
  assert.equal(promoteCallBody[0].source_id, "m1");

  globalThis.fetch = originalFetch;
});

test("handleBackupArchive: rejects unsupported table", async () => {
  globalThis.fetch = async () => mockFetchResponse({ status: 200, body: "[]" });
  const { handleBackupArchive } = await import("../api/server.mjs");

  await assert.rejects(
    () => handleBackupArchive({ table: "invalid_table", rows: [] }),
    /unsupported archive table/
  );
  globalThis.fetch = originalFetch;
});

test("handleBackupArchive: handles empty rows array", async () => {
  fetchCalls = [];
  globalThis.fetch = async () => mockFetchResponse({ status: 200, body: "[]" });
  const { handleBackupArchive } = await import("../api/server.mjs");

  const result = await handleBackupArchive({
    table: "agent_memories",
    rows: [],
    backup_file: "test.json",
  });

  assert.equal(result.ok, true);
  assert.equal(result.archived_count, 0);
  assert.equal(result.promoted_count, 0);
  assert.equal(result.skipped_count, 0);
  // No fetch calls should be made for empty rows
  assert.equal(fetchCalls.length, 0);
  globalThis.fetch = originalFetch;
});

test("handleBackupArchive: skips non-object rows", async () => {
  fetchCalls = [];
  globalThis.fetch = async () => mockFetchResponse({ status: 201, body: "[]" });
  const { handleBackupArchive } = await import("../api/server.mjs");

  const result = await handleBackupArchive({
    table: "entities",
    rows: [
      { id: "e1", name: "Entity1" },
      null,
      "not-an-object",
      [1, 2, 3],
      { id: "e2", name: "Entity2" },
    ],
    backup_file: "entities-2026-06-29.json",
  });

  assert.equal(result.archived_count, 2); // only 2 valid objects
  assert.equal(result.skipped_count, 3);
  globalThis.fetch = originalFetch;
});