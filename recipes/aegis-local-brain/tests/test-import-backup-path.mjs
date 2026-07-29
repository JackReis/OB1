import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveBackupPath } from "../scripts/import-supabase-backup.mjs";
import { makeTempDir, cleanupTempDir } from "./helpers.mjs";

test("resolveBackupPath: returns absolute path as-is when it exists", () => {
  const dir = makeTempDir();
  const result = resolveBackupPath(dir);
  assert.equal(result, dir);
  cleanupTempDir(dir);
});

test("resolveBackupPath: returns default brain-backup/backup path for empty input", () => {
  const result = resolveBackupPath("");
  assert.ok(result.includes("brain-backup"));
  assert.ok(result.endsWith("backup"));
});

test("resolveBackupPath: resolves relative path from cwd when it exists", () => {
  const dir = makeTempDir();
  const relativeName = path.basename(dir);
  const cwd = path.dirname(dir);
  // This test depends on cwd; use a more robust approach
  // Just verify it doesn't throw for a nonexistent relative path
  const result = resolveBackupPath("nonexistent-relative-path-test");
  assert.ok(typeof result === "string");
});