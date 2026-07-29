import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.POSTGREST_URL = "http://localhost:3000";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";

const { archiveSourceId } = await import("../api/server.mjs");

test("archiveSourceId: uses row.id when present", () => {
  assert.equal(archiveSourceId("agent_memories", { id: "abc-123" }, 0), "abc-123");
  assert.equal(archiveSourceId("thoughts", { id: 42 }, 5), "42");
});

test("archiveSourceId: uses row.id when non-empty string", () => {
  assert.equal(archiveSourceId("entities", { id: "ent-001" }, 0), "ent-001");
});

test("archiveSourceId: returns id even when empty string is explicitly set", () => {
  // row.id === "" falls through to other strategies
  assert.notEqual(archiveSourceId("agent_memories", { id: "" }, 0), "");
});

test("archiveSourceId: uses composite key for thought_entities", () => {
  const row = { thought_id: "t1", entity_id: "e1", mention_role: "subject", source: "ner" };
  const result = archiveSourceId("thought_entities", row, 0);
  assert.equal(result, "t1:e1:subject:ner");
});

test("archiveSourceId: uses composite key for thought_entities with empty optional fields", () => {
  const row = { thought_id: "t1", entity_id: "e1" };
  const result = archiveSourceId("thought_entities", row, 0);
  assert.equal(result, "t1:e1::");
});

test("archiveSourceId: generates deterministic hash-based id for rows without id", () => {
  const row = { name: "test", value: 123 };
  const result = archiveSourceId("entities", row, 3);
  const expectedHash = crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
  assert.equal(result, `entities:3:${expectedHash}`);
});

test("archiveSourceId: same row at different index produces different id", () => {
  const row = { name: "test" };
  const id0 = archiveSourceId("entities", row, 0);
  const id1 = archiveSourceId("entities", row, 1);
  assert.notEqual(id0, id1);
});

test("archiveSourceId: null id falls through to hash strategy", () => {
  const row = { id: null, name: "test" };
  const result = archiveSourceId("entities", row, 0);
  assert.ok(result.startsWith("entities:0:"));
});