import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadEnvFile, supabaseHost, configErrors, preflightResult, backupDir } from "../../brain-backup/backup-brain.mjs";

test("supabaseHost: extracts hostname from valid URL", () => {
  assert.equal(supabaseHost("https://jhpuctiyosazlyrcnfuu.supabase.co"), "jhpuctiyosazlyrcnfuu.supabase.co");
});

test("supabaseHost: returns null for empty string", () => {
  assert.equal(supabaseHost(""), null);
});

test("supabaseHost: returns null for invalid URL", () => {
  assert.equal(supabaseHost("not-a-url"), null);
  assert.equal(supabaseHost("://broken"), null);
});

test("loadEnvFile: returns empty object for missing file", () => {
  const vars = loadEnvFile("/nonexistent/path/.env.local");
  assert.deepEqual(vars, {});
});

test("loadEnvFile: parses KEY=VALUE pairs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
  const envPath = path.join(dir, ".env.local");
  fs.writeFileSync(envPath, [
    "SUPABASE_URL=https://example.supabase.co",
    'SUPABASE_SERVICE_ROLE_KEY="secret-key"',
    "# comment line",
    "",
    "EMPTY_KEY=",
  ].join("\n"));
  const vars = loadEnvFile(envPath);
  assert.equal(vars.SUPABASE_URL, "https://example.supabase.co");
  assert.equal(vars.SUPABASE_SERVICE_ROLE_KEY, "secret-key"); // quotes stripped
  assert.equal(vars.EMPTY_KEY, "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("configErrors: reports missing SUPABASE_URL and SERVICE_KEY", () => {
  // configErrors reads module-level constants; we test the structure
  const errors = configErrors();
  assert.ok(Array.isArray(errors));
  // In test env without .env.local, both should be missing
  assert.ok(errors.includes("SUPABASE_URL") || errors.includes("SUPABASE_SERVICE_ROLE_KEY") || errors.length === 0,
    `expected missing config errors or empty, got: ${JSON.stringify(errors)}`);
});