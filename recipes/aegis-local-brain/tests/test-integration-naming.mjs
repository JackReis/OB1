import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTempDir, cleanupTempDir, createMockBackup } from "./helpers.mjs";
import { today, writeManifest, sha256File } from "../../brain-backup/backup-brain.mjs";
import { newestBackupForTable, newestManifest } from "../scripts/import-supabase-backup.mjs";

test("naming: backup file uses table-dateStr.json pattern", () => {
  const dir = makeTempDir();
  try {
    const dateStr = "2026-06-29";
    const tables = [
      { name: "thoughts", rows: [{ id: "t1", content: "x" }], orderBy: "id" },
      { name: "agent_memories", rows: [{ id: "m1" }], orderBy: "id" },
    ];
    const results = createMockBackup(dir, dateStr, tables);

    // Files should be named table-dateStr.json
    assert.ok(fs.existsSync(path.join(dir, "thoughts-2026-06-29.json")));
    assert.ok(fs.existsSync(path.join(dir, "agent_memories-2026-06-29.json")));
  } finally {
    cleanupTempDir(dir);
  }
});

test("naming: manifest file uses manifest-dateStr.json pattern", () => {
  const dir = makeTempDir();
  try {
    const dateStr = "2026-06-29";
    const tables = [{ name: "thoughts", rows: [{ id: "t1", content: "x" }], orderBy: "id" }];
    const results = createMockBackup(dir, dateStr, tables);
    const totalRows = 1;
    const totalSize = results[0].fileSize;
    const { manifestPath } = writeManifest({ backupDir: dir, dateStr, results, totalRows, totalSize });

    assert.equal(path.basename(manifestPath), "manifest-2026-06-29.json");
    assert.ok(fs.existsSync(manifestPath));
  } finally {
    cleanupTempDir(dir);
  }
});

test("naming: today() returns valid YYYY-MM-DD date", () => {
  const date = today();
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);

  // Verify it's a real date
  const parsed = new Date(date + "T00:00:00Z");
  assert.ok(!isNaN(parsed.getTime()));
});

test("naming: newestBackupForTable picks the most recent date file", () => {
  const dir = makeTempDir();
  try {
    // Create files with different dates
    createMockBackup(dir, "2026-06-28", [{ name: "thoughts", rows: [{ id: "old" }], orderBy: "id" }]);
    createMockBackup(dir, "2026-06-29", [{ name: "thoughts", rows: [{ id: "new" }], orderBy: "id" }]);
    createMockBackup(dir, "2026-06-27", [{ name: "thoughts", rows: [{ id: "oldest" }], orderBy: "id" }]);

    const newest = newestBackupForTable(dir, "thoughts");
    assert.ok(newest);
    assert.ok(newest.endsWith("thoughts-2026-06-29.json"));
  } finally {
    cleanupTempDir(dir);
  }
});

test("naming: newestManifest picks the most recent manifest", () => {
  const dir = makeTempDir();
  try {
    const tables = [{ name: "thoughts", rows: [{ id: "t1", content: "x" }], orderBy: "id" }];

    // Create manifests for different dates
    for (const dateStr of ["2026-06-27", "2026-06-28", "2026-06-29"]) {
      const results = createMockBackup(dir, dateStr, tables);
      writeManifest({ backupDir: dir, dateStr, results, totalRows: 1, totalSize: results[0].fileSize });
    }

    const manifestPath = newestManifest(dir);
    assert.ok(manifestPath);
    assert.ok(manifestPath.endsWith("manifest-2026-06-29.json"));
  } finally {
    cleanupTempDir(dir);
  }
});

test("naming: sha256 is consistent for same file content", () => {
  const dir = makeTempDir();
  try {
    const file1 = path.join(dir, "test1.json");
    const file2 = path.join(dir, "test2.json");
    fs.writeFileSync(file1, '{"a":1}');
    fs.writeFileSync(file2, '{"a":1}');

    assert.equal(sha256File(file1), sha256File(file2));
  } finally {
    cleanupTempDir(dir);
  }
});

test("naming: date in manifest matches dateStr used for export", () => {
  const dir = makeTempDir();
  try {
    const dateStr = "2026-06-29";
    const tables = [{ name: "thoughts", rows: [{ id: "t1", content: "x" }], orderBy: "id" }];
    const results = createMockBackup(dir, dateStr, tables);
    const { manifest } = writeManifest({ backupDir: dir, dateStr, results, totalRows: 1, totalSize: results[0].fileSize });

    assert.equal(manifest.date, "2026-06-29");
  } finally {
    cleanupTempDir(dir);
  }
});