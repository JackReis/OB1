import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTempDir, cleanupTempDir, writeJsonFile, createMockBackup, buildManifest, writeManifest } from "./helpers.mjs";
import { today, writeManifest as backupWriteManifest, sha256File } from "../../brain-backup/backup-brain.mjs";
import { validateBackupManifest, newestBackupForTable, resolveBackupInput, emptyImportPlan, addRowToImportPlan, contentFingerprint } from "../scripts/import-supabase-backup.mjs";

test("round-trip: export creates manifest, import validates it", () => {
  const dir = makeTempDir();
  try {
    const dateStr = today();
    const tables = [
      { name: "thoughts", rows: [
        { id: "t1", content: "first thought", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
        { id: "t2", content: "second thought", created_at: "2026-01-01T01:00:00Z", updated_at: "2026-01-01T01:00:00Z" },
      ], orderBy: "created_at" },
      { name: "agent_memories", rows: [
        { id: "m1", thought_id: "t1", memory_type: "decision", created_at: "2026-01-01T00:00:00Z" },
      ], orderBy: "created_at" },
    ];

    // Simulate export: create backup files
    const results = createMockBackup(dir, dateStr, tables);
    const totalRows = results.reduce((s, r) => s + r.rowCount, 0);
    const totalSize = results.reduce((s, r) => s + r.fileSize, 0);

    // Write manifest using backup-brain's writeManifest
    const { manifest, manifestPath } = backupWriteManifest({ backupDir: dir, dateStr, results, totalRows, totalSize });

    // Verify manifest file exists and is valid JSON
    assert.ok(fs.existsSync(manifestPath));
    const manifestContent = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifestContent.schema_version, 1);
    assert.equal(manifestContent.ok, true);
    assert.equal(manifestContent.date, dateStr);
    assert.equal(manifestContent.total_rows, 3);

    // Now simulate import: validate the manifest
    const validation = validateBackupManifest(dir);
    assert.ok(validation); // not null
    assert.equal(validation.manifest.ok, true);
    assert.equal(validation.manifest.schema_version, 1);

    // Verify backup files can be found by import
    const thoughtsFile = newestBackupForTable(dir, "thoughts");
    assert.ok(thoughtsFile);
    assert.ok(thoughtsFile.includes("thoughts"));
  } finally {
    cleanupTempDir(dir);
  }
});

test("round-trip: import plan correctly counts rows from exported backup", () => {
  const dir = makeTempDir();
  try {
    const dateStr = today();
    const rows = [
      { id: "t1", content: "unique thought one", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: "t2", content: "unique thought two", created_at: "2026-01-01T01:00:00Z", updated_at: "2026-01-01T01:00:00Z" },
      { id: "t3", content: "unique thought one", created_at: "2026-01-01T02:00:00Z", updated_at: "2026-01-01T02:00:00Z" }, // duplicate content
      { id: "t4", content: "", created_at: "2026-01-01T03:00:00Z" }, // empty content, skipped
      { id: "t5", created_at: "2026-01-01T04:00:00Z" }, // no content field, skipped
    ];

    const tables = [{ name: "thoughts", rows, orderBy: "created_at" }];
    const results = createMockBackup(dir, dateStr, tables);

    // Build and write manifest
    const totalRows = results.reduce((s, r) => s + r.rowCount, 0);
    const totalSize = results.reduce((s, r) => s + r.fileSize, 0);
    const { manifestPath } = backupWriteManifest({ backupDir: dir, dateStr, results, totalRows, totalSize });

    // Read exported file and run import plan
    const backupFile = newestBackupForTable(dir, "thoughts");
    const exportedRows = JSON.parse(fs.readFileSync(backupFile, "utf8"));

    const plan = emptyImportPlan();
    for (const row of exportedRows) {
      addRowToImportPlan(plan, row);
    }

    assert.equal(plan.backup_rows, 5);
    assert.equal(plan.importable_rows, 3); // t1, t2, t3 have content
    assert.equal(plan.skipped_rows, 2); // t4 empty, t5 missing content
    assert.equal(plan.duplicate_content_rows, 1); // t3 duplicates t1
    assert.equal(plan.expected_unique_fingerprints, 2); // t1/t3 share fingerprint, t2 unique
  } finally {
    cleanupTempDir(dir);
  }
});

test("round-trip: content fingerprint is deterministic for same content", () => {
  const fp1 = contentFingerprint("Hello World");
  const fp2 = contentFingerprint("hello world");
  const fp3 = contentFingerprint("hello  world"); // extra space
  assert.equal(fp1, fp2); // case-insensitive
  assert.equal(fp1, fp3); // whitespace normalized
  assert.equal(fp1.length, 64); // sha256 hex
});

test("round-trip: resolveBackupInput finds thoughts file from export", () => {
  const dir = makeTempDir();
  try {
    const dateStr = today();
    const tables = [{ name: "thoughts", rows: [{ id: "t1", content: "test" }], orderBy: "created_at" }];
    const results = createMockBackup(dir, dateStr, tables);
    const { manifestPath } = backupWriteManifest({ backupDir: dir, dateStr, results, totalRows: 1, totalSize: results[0].fileSize });

    // resolveBackupInput should find the thoughts file
    const { backupDir: resolvedDir, thoughtsFile } = resolveBackupInput(dir);
    assert.equal(resolvedDir, dir);
    assert.ok(thoughtsFile);
    assert.ok(fs.existsSync(thoughtsFile));
  } finally {
    cleanupTempDir(dir);
  }
});