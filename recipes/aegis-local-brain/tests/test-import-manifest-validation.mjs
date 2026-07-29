import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateBackupManifest } from "../scripts/import-supabase-backup.mjs";
import { makeTempDir, cleanupTempDir } from "./helpers.mjs";

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("validateBackupManifest: returns null when no manifest exists", () => {
  const dir = makeTempDir();
  assert.equal(validateBackupManifest(dir), null);
  cleanupTempDir(dir);
});

test("validateBackupManifest: passes for valid manifest with matching files", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";

  // Create backup file
  const tableFile = path.join(dir, `agent_memories-${dateStr}.json`);
  const content = JSON.stringify([{ id: 1 }, { id: 2 }]);
  fs.writeFileSync(tableFile, content);
  const fileSize = fs.statSync(tableFile).size;

  const manifest = {
    schema_version: 1,
    ok: true,
    date: dateStr,
    tables: [
      {
        table: "agent_memories",
        ok: true,
        file_name: `agent_memories-${dateStr}.json`,
        file_size: fileSize,
        sha256: sha256File(tableFile),
      },
    ],
  };
  fs.writeFileSync(path.join(dir, `manifest-${dateStr}.json`), JSON.stringify(manifest));

  const result = validateBackupManifest(dir);
  assert.ok(result);
  assert.equal(result.manifest.ok, true);
  cleanupTempDir(dir);
});

test("validateBackupManifest: throws when manifest ok=false", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";
  const manifest = { ok: false, tables: [] };
  fs.writeFileSync(path.join(dir, `manifest-${dateStr}.json`), JSON.stringify(manifest));

  assert.throws(() => validateBackupManifest(dir), /not ok/);
  cleanupTempDir(dir);
});

test("validateBackupManifest: throws when referenced file is missing", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";
  const manifest = {
    ok: true,
    tables: [
      { table: "thoughts", ok: true, file_name: "thoughts-2026-06-29.json", sha256: "abc" },
    ],
  };
  fs.writeFileSync(path.join(dir, `manifest-${dateStr}.json`), JSON.stringify(manifest));

  assert.throws(() => validateBackupManifest(dir), /file missing/);
  cleanupTempDir(dir);
});

test("validateBackupManifest: throws on sha256 mismatch", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";

  const tableFile = path.join(dir, `agent_memories-${dateStr}.json`);
  fs.writeFileSync(tableFile, "[]");

  const manifest = {
    ok: true,
    tables: [
      {
        table: "agent_memories",
        ok: true,
        file_name: `agent_memories-${dateStr}.json`,
        file_size: 2,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    ],
  };
  fs.writeFileSync(path.join(dir, `manifest-${dateStr}.json`), JSON.stringify(manifest));

  assert.throws(() => validateBackupManifest(dir), /sha256 mismatch/);
  cleanupTempDir(dir);
});

test("validateBackupManifest: throws on file_size mismatch", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";

  const tableFile = path.join(dir, `agent_memories-${dateStr}.json`);
  fs.writeFileSync(tableFile, "[]");

  const manifest = {
    ok: true,
    tables: [
      {
        table: "agent_memories",
        ok: true,
        file_name: `agent_memories-${dateStr}.json`,
        file_size: 999, // wrong size
        sha256: sha256File(tableFile),
      },
    ],
  };
  fs.writeFileSync(path.join(dir, `manifest-${dateStr}.json`), JSON.stringify(manifest));

  assert.throws(() => validateBackupManifest(dir), /file_size mismatch/);
  cleanupTempDir(dir);
});

test("validateBackupManifest: skips entries with no file_name", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";
  const manifest = {
    ok: true,
    tables: [
      { table: "empty", ok: true, file_name: null, sha256: null },
    ],
  };
  fs.writeFileSync(path.join(dir, `manifest-${dateStr}.json`), JSON.stringify(manifest));

  // Should not throw
  const result = validateBackupManifest(dir);
  assert.ok(result);
  cleanupTempDir(dir);
});

test("validateBackupManifest: throws when table entry ok=false", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";
  const manifest = {
    ok: true,
    tables: [
      { table: "thoughts", ok: false, file_name: "thoughts-2026-06-29.json", error: "timeout" },
    ],
  };
  fs.writeFileSync(path.join(dir, `manifest-${dateStr}.json`), JSON.stringify(manifest));

  assert.throws(() => validateBackupManifest(dir), /table failed/);
  cleanupTempDir(dir);
});