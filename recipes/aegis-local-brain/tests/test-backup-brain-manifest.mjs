import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sha256File, writeManifest } from "../../brain-backup/backup-brain.mjs";
import { makeTempDir, cleanupTempDir } from "./helpers.mjs";

test("sha256File: returns correct hex digest for known content", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "test.json");
  fs.writeFileSync(filePath, "[]");
  // sha256 of "[]" = 273c41b6...
  const hash = sha256File(filePath);
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
  cleanupTempDir(dir);
});

test("sha256File: different content produces different hash", () => {
  const dir = makeTempDir();
  const f1 = path.join(dir, "a.json");
  const f2 = path.join(dir, "b.json");
  fs.writeFileSync(f1, "[]");
  fs.writeFileSync(f2, "[1]");
  assert.notEqual(sha256File(f1), sha256File(f2));
  cleanupTempDir(dir);
});

test("writeManifest: creates manifest file with correct structure", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";

  // Create a backup file
  const tableFile = path.join(dir, "agent_memories-2026-06-29.json");
  fs.writeFileSync(tableFile, JSON.stringify([{ id: 1 }]));

  const results = [
    { table: "agent_memories", rowCount: 1, filePath: tableFile, fileSize: fs.statSync(tableFile).size },
  ];

  const { manifest, manifestPath } = writeManifest({
    backupDir: dir,
    dateStr,
    results,
    totalRows: 1,
    totalSize: fs.statSync(tableFile).size,
  });

  assert.equal(manifest.ok, true);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.date, dateStr);
  assert.equal(manifest.table_count, 3); // TABLES.length
  assert.equal(manifest.success_count, 1);
  assert.equal(manifest.failure_count, 0);
  assert.equal(manifest.tables[0].table, "agent_memories");
  assert.equal(manifest.tables[0].ok, true);
  assert.equal(manifest.tables[0].row_count, 1);
  assert.equal(manifest.tables[0].file_name, "agent_memories-2026-06-29.json");
  assert.equal(manifest.tables[0].sha256, sha256File(tableFile));

  // Manifest file exists on disk
  assert.ok(fs.existsSync(manifestPath));
  const written = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(written.ok, true);

  cleanupTempDir(dir);
});

test("writeManifest: ok=false when any table has error", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";

  const results = [
    { table: "thoughts", rowCount: 0, filePath: null, fileSize: 0, error: "timeout" },
  ];

  const { manifest } = writeManifest({
    backupDir: dir,
    dateStr,
    results,
    totalRows: 0,
    totalSize: 0,
  });

  assert.equal(manifest.ok, false);
  assert.equal(manifest.failure_count, 1);
  assert.equal(manifest.tables[0].ok, false);
  assert.equal(manifest.tables[0].error, "timeout");
  assert.equal(manifest.tables[0].sha256, null);

  cleanupTempDir(dir);
});