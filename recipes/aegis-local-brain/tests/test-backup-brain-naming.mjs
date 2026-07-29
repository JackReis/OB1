import { test } from "node:test";
import assert from "node:assert/strict";
import { backupDir, today, humanSize, PAGE_SIZE, TABLES } from "../../brain-backup/backup-brain.mjs";

test("backupDir: returns path ending in 'backup'", () => {
  const dir = backupDir();
  assert.ok(dir.endsWith("backup"));
});

test("today: returns YYYY-MM-DD format", () => {
  const date = today();
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
});

test("humanSize: formats bytes correctly", () => {
  assert.equal(humanSize(0), "0 B");
  assert.equal(humanSize(512), "512 B");
  assert.equal(humanSize(1024), "1.0 KB");
  assert.equal(humanSize(1048576), "1.0 MB");
  assert.equal(humanSize(569462575), "543.1 MB");
});

test("PAGE_SIZE: is 200 (reduced from 1000 to avoid timeout)", () => {
  assert.equal(PAGE_SIZE, 200);
});

test("TABLES: contains exactly thoughts, agent_memories, agent_memory_audit_events", () => {
  const names = TABLES.map((t) => t.name);
  assert.deepEqual(names.sort(), ["agent_memories", "agent_memory_audit_events", "thoughts"]);
});

test("TABLES: each table has an orderBy field", () => {
  for (const t of TABLES) {
    assert.ok(t.orderBy, `table ${t.name} should have orderBy`);
  }
});