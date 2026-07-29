import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyImportPlan, addRowToImportPlan, contentFingerprint, sourceMetadata, SIDE_TABLES } from "../scripts/import-supabase-backup.mjs";

test("emptyImportPlan: returns correct initial structure", () => {
  const plan = emptyImportPlan();
  assert.equal(plan.backup_rows, 0);
  assert.equal(plan.importable_rows, 0);
  assert.equal(plan.skipped_rows, 0);
  assert.equal(plan.expected_unique_fingerprints, 0);
  assert.equal(plan.duplicate_content_rows, 0);
  assert.ok(plan.fingerprints instanceof Set);
});

test("addRowToImportPlan: skips rows with no content", () => {
  const plan = emptyImportPlan();
  const added = addRowToImportPlan(plan, { id: 1, content: "" });
  assert.equal(added, false);
  assert.equal(plan.backup_rows, 1);
  assert.equal(plan.skipped_rows, 1);
  assert.equal(plan.importable_rows, 0);
});

test("addRowToImportPlan: skips rows where content is not a string", () => {
  const plan = emptyImportPlan();
  addRowToImportPlan(plan, { id: 1, content: 42 });
  assert.equal(plan.skipped_rows, 1);
  assert.equal(plan.importable_rows, 0);
});

test("addRowToImportPlan: skips null/undefined rows", () => {
  const plan = emptyImportPlan();
  addRowToImportPlan(plan, null);
  addRowToImportPlan(plan, undefined);
  assert.equal(plan.backup_rows, 2);
  assert.equal(plan.skipped_rows, 2);
  assert.equal(plan.importable_rows, 0);
});

test("addRowToImportPlan: counts importable rows and fingerprints", () => {
  const plan = emptyImportPlan();
  addRowToImportPlan(plan, { id: 1, content: "hello world" });
  addRowToImportPlan(plan, { id: 2, content: "hello world" }); // duplicate fingerprint
  addRowToImportPlan(plan, { id: 3, content: "different content" });

  assert.equal(plan.backup_rows, 3);
  assert.equal(plan.importable_rows, 3);
  assert.equal(plan.expected_unique_fingerprints, 2);
  assert.equal(plan.duplicate_content_rows, 1);
});

test("contentFingerprint: same content produces same hash regardless of whitespace", () => {
  const h1 = contentFingerprint("hello  world");
  const h2 = contentFingerprint("hello world");
  const h3 = contentFingerprint("  Hello  World  ");
  assert.equal(h1, h2); // multiple spaces collapse to single
  assert.equal(h1, h3); // case-insensitive after toLowerCase
});

test("contentFingerprint: returns 64-char hex string", () => {
  const hash = contentFingerprint("test");
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("sourceMetadata: merges original metadata and adds source fields", () => {
  const row = {
    id: "abc-123",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    metadata: { topic: "test" },
  };
  const result = sourceMetadata(row);
  assert.equal(result.topic, "test");
  assert.equal(result.migrated_from, "open-brain-supabase-backup");
  assert.equal(result.source_id, "abc-123");
  assert.equal(result.source_created_at, "2026-01-01T00:00:00Z");
  assert.equal(result.source_updated_at, "2026-01-02T00:00:00Z");
});

test("sourceMetadata: handles row with no metadata field", () => {
  const row = { id: "x", created_at: "c", updated_at: "u" };
  const result = sourceMetadata(row);
  assert.equal(result.migrated_from, "open-brain-supabase-backup");
  assert.deepEqual(result.topic, undefined);
});

test("sourceMetadata: handles non-object metadata gracefully", () => {
  const row = { id: "x", metadata: "not-an-object" };
  const result = sourceMetadata(row);
  assert.equal(result.migrated_from, "open-brain-supabase-backup");
});

test("SIDE_TABLES: contains expected 8 table names", () => {
  assert.equal(SIDE_TABLES.length, 8);
  const expected = ["entities", "edges", "thought_entities", "reflections",
    "ingestion_jobs", "ingestion_items", "agent_memories", "agent_memory_audit_events"];
  for (const t of expected) {
    assert.ok(SIDE_TABLES.includes(t), `should include ${t}`);
  }
});