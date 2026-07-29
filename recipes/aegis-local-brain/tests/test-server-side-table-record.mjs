import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POSTGREST_URL = "http://localhost:3000";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";

const { sideTableRecord, ARCHIVE_SOURCE_SYSTEM } = await import("../api/server.mjs");

function makeArchiveRecord(rowData) {
  return {
    source_system: ARCHIVE_SOURCE_SYSTEM,
    source_id: "src-001",
    row_data: rowData,
    backup_file: "test-2026-06-29.json",
  };
}

test("sideTableRecord: base fields present for all table types", () => {
  for (const table of ["agent_memories", "agent_memory_audit_events", "entities",
    "edges", "thought_entities", "reflections", "ingestion_jobs", "ingestion_items"]) {
    const record = sideTableRecord(table, makeArchiveRecord({ created_at: "2026-01-01T00:00:00Z" }));
    assert.equal(record.source_system, ARCHIVE_SOURCE_SYSTEM);
    assert.equal(record.source_id, "src-001");
    assert.equal(record.backup_file, "test-2026-06-29.json");
    assert.equal(record.row_data.created_at, "2026-01-01T00:00:00Z");
  }
});

test("sideTableRecord: agent_memories maps all fields correctly", () => {
  const rowData = {
    thought_id: "t-uuid", workspace_id: "ws-1", project_id: "p-1",
    channel_kind: "telegram", channel_id: "ch-1", channel_thread_id: "th-1",
    visibility: "project", memory_type: "decision", summary: "decided X",
    content: "we decided X", lifecycle_status: "active", provenance_status: "observed",
    confidence: 0.85, created_by: "agent", runtime_name: "hermes",
    runtime_version: "1.0", provider: "ollama", model: "hermes-4",
    task_id: "task-1", flow_id: "flow-1",
    can_use_as_instruction: true, can_use_as_evidence: false,
    requires_user_confirmation: true, review_status: "confirmed",
    last_confirmed_at: "2026-01-01", stale_after: "2026-02-01",
    idempotency_key: "key-1", content_hash: "hash-1",
    metadata: { topic: "test" }, updated_at: "2026-01-02",
    created_at: "2026-01-01",
  };
  const record = sideTableRecord("agent_memories", makeArchiveRecord(rowData));
  assert.equal(record.thought_id, "t-uuid");
  assert.equal(record.workspace_id, "ws-1");
  assert.equal(record.memory_type, "decision");
  assert.equal(record.confidence, 0.85);
  assert.equal(record.can_use_as_instruction, true);
  assert.equal(record.can_use_as_evidence, false);
  assert.equal(record.requires_user_confirmation, true);
  assert.deepEqual(record.metadata, { topic: "test" });
});

test("sideTableRecord: agent_memory_audit_events maps fields", () => {
  const rowData = {
    event_type: "memory_written", workspace_id: "ws-1", project_id: "p-1",
    memory_id: "m-uuid", trace_id: "tr-uuid", actor_kind: "agent",
    actor_label: "hermes", runtime_name: "hermes", task_id: "task-1",
    payload: { action: "write" }, created_at: "2026-01-01",
  };
  const record = sideTableRecord("agent_memory_audit_events", makeArchiveRecord(rowData));
  assert.equal(record.event_type, "memory_written");
  assert.equal(record.memory_id, "m-uuid");
  assert.equal(record.actor_kind, "agent");
  assert.deepEqual(record.payload, { action: "write" });
});

test("sideTableRecord: entities maps name and aliases", () => {
  const rowData = {
    name: "OpenAI", normalized_name: "openai", canonical_name: "OpenAI Inc",
    type: "organization", aliases: ["OAI"], metadata: { sector: "ai" },
    created_at: "2026-01-01", updated_at: "2026-01-02",
  };
  const record = sideTableRecord("entities", makeArchiveRecord(rowData));
  assert.equal(record.name, "OpenAI"); // prefers row.name over normalized_name
  assert.equal(record.entity_type, "organization"); // maps row.type
  assert.deepEqual(record.aliases, ["OAI"]);
  assert.deepEqual(record.metadata, { sector: "ai" });
});

test("sideTableRecord: edges maps source/target entity and relation", () => {
  const rowData = {
    source_entity_id: "e1", from_entity_id: "e1-old",
    target_entity_id: "e2", to_entity_id: "e2-old",
    relation_type: "works_at", relation: "old_relation",
    confidence: 0.9, metadata: {}, created_at: "2026-01-01",
  };
  const record = sideTableRecord("edges", makeArchiveRecord(rowData));
  assert.equal(record.source_entity_id, "e1"); // prefers source_entity_id
  assert.equal(record.target_entity_id, "e2");
  assert.equal(record.relation_type, "works_at");
  assert.equal(record.confidence, 0.9);
});

test("sideTableRecord: thought_entities maps thought/entity/role/source", () => {
  const rowData = {
    thought_id: "t1", entity_id: "e1", mention_role: "subject",
    source: "ner", evidence: { score: 0.95 }, metadata: {},
    created_at: "2026-01-01",
  };
  const record = sideTableRecord("thought_entities", makeArchiveRecord(rowData));
  assert.equal(record.thought_id, "t1");
  assert.equal(record.entity_id, "e1");
  assert.equal(record.mention_role, "subject");
  assert.deepEqual(record.evidence, { score: 0.95 });
});

test("sideTableRecord: reflections maps content and metadata with extra fields", () => {
  const rowData = {
    thought_id: "t1", reflection_type: "daily", content: "good day",
    model: "hermes-4", metadata: { topic: "retro" },
    trigger_context: "daily trigger", options: ["a", "b"],
    factors: ["x"], conclusion: "all good", confidence: 0.8,
    created_at: "2026-01-01",
  };
  const record = sideTableRecord("reflections", makeArchiveRecord(rowData));
  assert.equal(record.thought_id, "t1");
  assert.equal(record.reflection_type, "daily");
  assert.equal(record.content, "good day");
  assert.equal(record.metadata.topic, "retro");
  assert.equal(record.metadata.trigger_context, "daily trigger");
  assert.deepEqual(record.metadata.options, ["a", "b"]); // array preserved
  assert.deepEqual(record.metadata.factors, ["x"]);
  assert.equal(record.metadata.conclusion, "all good");
  assert.equal(record.metadata.confidence, 0.8);
});

test("sideTableRecord: ingestion_jobs maps status, type, error", () => {
  const rowData = {
    status: "completed", job_type: "youtube", source_type: "youtube",
    source_kind: "video", created_by: "user",
    error_message: null, metadata: {}, created_at: "2026-01-01",
  };
  const record = sideTableRecord("ingestion_jobs", makeArchiveRecord(rowData));
  assert.equal(record.status, "completed");
  assert.equal(record.job_type, "youtube"); // prefers job_type
  assert.equal(record.source_kind, "video");
  assert.equal(record.created_by, "user");
});

test("sideTableRecord: ingestion_items maps job/thought/status/ref", () => {
  const rowData = {
    job_id: "j1", thought_id: "t1", result_thought_id: "t1-alt",
    status: "done", source_ref: "ref-1", extracted_content: "raw text",
    error_message: "", metadata: {}, created_at: "2026-01-01",
  };
  const record = sideTableRecord("ingestion_items", makeArchiveRecord(rowData));
  assert.equal(record.job_id, "j1");
  assert.equal(record.thought_id, "t1"); // prefers thought_id
  assert.equal(record.status, "done");
  assert.equal(record.source_ref, "ref-1"); // prefers source_ref
});

test("sideTableRecord: unknown table returns base only", () => {
  const record = sideTableRecord("unknown_table", makeArchiveRecord({ created_at: "2026-01-01" }));
  assert.equal(record.source_system, ARCHIVE_SOURCE_SYSTEM);
  assert.equal(record.source_id, "src-001");
  // base has: id, source_system, source_id, row_data, backup_file, created_at = 6 fields
  assert.equal(Object.keys(record).length, 6);
});