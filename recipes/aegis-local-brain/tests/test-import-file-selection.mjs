import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { newestBackupForTable, newestManifest } from "../scripts/import-supabase-backup.mjs";
import { makeTempDir, cleanupTempDir } from "./helpers.mjs";

test("newestBackupForTable: returns null for nonexistent dir", () => {
  assert.equal(newestBackupForTable("/nonexistent", "thoughts"), null);
});

test("newestBackupForTable: returns null for dir with no matching files", () => {
  const dir = makeTempDir();
  assert.equal(newestBackupForTable(dir, "thoughts"), null);
  cleanupTempDir(dir);
});

test("newestBackupForTable: returns newest file by lexicographic sort", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "thoughts-2026-06-28.json"), "[]");
  fs.writeFileSync(path.join(dir, "thoughts-2026-06-29.json"), "[]");
  fs.writeFileSync(path.join(dir, "thoughts-2026-06-27.json"), "[]");
  fs.writeFileSync(path.join(dir, "other-2026-06-29.json"), "[]");

  const result = newestBackupForTable(dir, "thoughts");
  assert.ok(result);
  assert.equal(path.basename(result), "thoughts-2026-06-29.json");
  cleanupTempDir(dir);
});

test("newestBackupForTable: returns null when dir is a file", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "notadir");
  fs.writeFileSync(filePath, "[]");
  assert.equal(newestBackupForTable(filePath, "thoughts"), null);
  cleanupTempDir(dir);
});

test("newestManifest: returns newest manifest file", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "manifest-2026-06-28.json"), "{}");
  fs.writeFileSync(path.join(dir, "manifest-2026-06-29.json"), "{}");
  fs.writeFileSync(path.join(dir, "thoughts-2026-06-29.json"), "[]");

  const result = newestManifest(dir);
  assert.ok(result);
  assert.equal(path.basename(result), "manifest-2026-06-29.json");
  cleanupTempDir(dir);
});

test("newestManifest: returns null for empty dir", () => {
  const dir = makeTempDir();
  assert.equal(newestManifest(dir), null);
  cleanupTempDir(dir);
});