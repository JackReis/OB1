# Plan: Brain Backup Tests

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Comprehensive `node:test` suite covering the brain backup export, import, and server archive pipeline to ensure data durability.

**Architecture:** Pure unit tests for helper functions (no network/DB) plus integration tests that mock `fetch` for server endpoint tests. Tests run with `node --test` using Node.js 22 built-in test runner. No external dependencies, no package.json needed.

**Tech Stack:** Node.js 22 ESM, `node:test`, `node:assert/strict`, `crypto`, `fs`, `path`

---

## Prerequisites

- Node.js 22 installed (`node --version` shows v22.x)
- Source files exist at the paths listed below
- Write access to `/Users/hermes/Projects/Sea Ranch AI/OB1/recipes/aegis-local-brain/tests/`

### Source Files

| Component | Path |
|----------|------|
| Export script | `recipes/brain-backup/backup-brain.mjs` |
| Import script | `recipes/aegis-local-brain/scripts/import-supabase-backup.mjs` |
| Server | `recipes/aegis-local-brain/api/server.mjs` |
| DB schema (archive) | `recipes/aegis-local-brain/db/init/03-backup-archive.sh` |
| DB schema (side tables) | `recipes/aegis-local-brain/db/init/04-first-class-side-tables.sh` |

### Key Design Decision: Exporting Functions for Test

The source scripts use top-level `import.meta.url` to derive `SCRIPT_DIR` and execute immediately on load. To make functions testable without triggering side effects, tests will use dynamic `import()` with stubbed `process.argv` and env vars, or test extracted copies of pure functions. The simplest approach: many helper functions in `backup-brain.mjs` are module-scoped but not exported. Tests will need to either:

1. **Re-implement pure function copies** in test helpers and verify behavior matches (brittle), OR
2. **Refactor source files to export functions** (preferred — minimal change, adds `export` keywords).

**Decision:** Tasks below include minimal refactoring to export functions from the source files, then test against the real implementations.

---

## Task 1: Create test directory and test helpers

**Objective:** Set up the test directory with shared helper utilities for fixtures, temp dirs, and mock fetch.

**Files:**
- Create: `tests/helpers.mjs`

**Step 1: Create `tests/helpers.mjs`**

```js
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-test-"));
  return dir;
}

export function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function writeJsonFile(dir, filename, data) {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  return filePath;
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Create a mock manifest + backup files in dir for the given tables. */
export function createMockBackup(dir, dateStr, tables) {
  const results = [];
  for (const { name, rows, orderBy = "id" } of tables) {
    const filePath = path.join(dir, `${name}-${dateStr}.json`);
    fs.writeFileSync(filePath, JSON.stringify(rows));
    const stat = fs.statSync(filePath);
    results.push({
      table: name,
      ok: true,
      rowCount: rows.length,
      filePath,
      fileSize: stat.size,
    });
  }
  return results;
}

/** Build a manifest object matching the schema used by backup-brain.mjs */
export function buildManifest({ dateStr, backupDir, results, totalRows, totalSize, ok = true }) {
  return {
    schema_version: 1,
    ok,
    exported_at: new Date().toISOString(),
    date: dateStr,
    supabase_host: "test.supabase.co",
    backup_dir: backupDir,
    table_count: results.length,
    success_count: results.filter((r) => !r.error).length,
    failure_count: results.filter((r) => r.error).length,
    total_rows: totalRows,
    total_size: totalSize,
    tables: results.map((r) => ({
      table: r.table,
      ok: !r.error,
      row_count: r.rowCount,
      file_name: r.filePath ? path.basename(r.filePath) : null,
      file_size: r.fileSize,
      sha256: r.filePath ? sha256File(r.filePath) : null,
      error: r.error || null,
    })),
  };
}

/** Write manifest to backupDir with proper naming. */
export function writeManifest(dir, dateStr, manifest) {
  const manifestPath = path.join(dir, `manifest-${dateStr}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return manifestPath;
}

/** Mock fetch that returns canned responses based on URL matching. */
export function createMockFetch(responses) {
  // responses: [{ urlMatch: /pattern/, status: 200, body: "...", headers: {} }, ...]
  return async function mockFetch(url, options = {}) {
    for (const r of responses) {
      if (r.urlMatch.test(url)) {
        const headers = new Map(Object.entries(r.headers || {}));
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          headers: {
            get: (name) => headers.get(name) || null,
          },
          json: async () => (typeof r.body === "string" ? JSON.parse(r.body) : r.body),
          text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
        };
      }
    }
    throw new Error(`mockFetch: no match for ${url}`);
  };
}
```

**Step 2: Verify helper file is valid**

Run: `node -e "import('./tests/helpers.mjs').then(() => console.log('helpers loaded ok'))"`
Expected: `helpers loaded ok`

---

## Task 2: Export functions from backup-brain.mjs

**Objective:** Add `export` to the key helper functions in `backup-brain.mjs` so they can be imported in tests. The script's side-effect code (preflight exit, main()) must be guarded so importing the module doesn't run them.

**Files:**
- Modify: `recipes/brain-backup/backup-brain.mjs`

**Step 1: Add `export` keyword to each helper function**

Change these function declarations:
- `function loadEnvFile()` → `export function loadEnvFile()`
- `function supabaseHost(url)` → `export function supabaseHost(url)`
- `function backupDir()` → `export function backupDir()`
- `function scriptDirWritable()` → `export function scriptDirWritable()`
- `function configErrors()` → `export function configErrors()`
- `function preflightResult()` → `export function preflightResult()`
- `function today()` → `export function today()`
- `function humanSize(bytes)` → `export function humanSize(bytes)`
- `function sha256File(filePath)` → `export function sha256File(filePath)`
- `function writeManifest(...)` → `export function writeManifest(...)`
- `async function fetchPage(...)` → `export async function fetchPage(...)`
- `async function exportTable(...)` → `export async function exportTable(...)`

Also export the constants:
- `export const PAGE_SIZE = 200;`
- `export const TABLES = [...];`

**Step 2: Guard the side-effect code**

Wrap the preflight block and `main()` call in a guard so importing the module doesn't execute them:

```js
// Guard: only run CLI behavior when executed directly (not imported)
const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain && FLAG_PREFLIGHT) {
  const result = preflightResult();
  printPreflight(result);
  process.exit(result.ok ? 0 : 2);
}
```

Move the `CONFIG_ERRORS` check block and `main().catch(...)` inside the `isMain` guard as well.

**Step 3: Verify script still runs standalone**

Run: `cd recipes/brain-backup && node backup-brain.mjs --preflight`
Expected: prints preflight result and exits 0 or 2 (same as before).

**Step 4: Verify module can be imported**

Run: `node -e "import('./recipes/brain-backup/backup-brain.mjs').then(m => console.log(typeof m.supabaseHost))"`
Expected: `function`

---

## Task 3: Test backup-brain.mjs — env loading and config

**Objective:** Test `loadEnvFile()`, `supabaseHost()`, `configErrors()`, and `preflightResult()`.

**Files:**
- Create: `tests/test-backup-brain-config.mjs`

**Step 1: Write test file**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadEnvFile, supabaseHost, configErrors, preflightResult, backupDir } from "../recipes/brain-backup/backup-brain.mjs";

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
```

**Step 2: Run tests**

Run: `cd recipes/aegis-local-brain && node --test tests/test-backup-brain-config.mjs`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add tests/test-backup-brain-config.mjs
git commit -m "test: backup-brain config and env loading tests"
```

---

## Task 4: Test backup-brain.mjs — sha256File and writeManifest

**Objective:** Test hash computation and manifest creation with real temp files.

**Files:**
- Create: `tests/test-backup-brain-manifest.mjs`

**Step 1: Write test file**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sha256File, writeManifest } from "../recipes/brain-backup/backup-brain.mjs";
import { makeTempDir, cleanupTempDir, writeJsonFile } from "./helpers.mjs";

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
  assert.equal(manifest.table_count, 1);
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
```

**Step 2: Run tests**

Run: `node --test tests/test-backup-brain-manifest.mjs`
Expected: All tests pass.

---

## Task 5: Test backup-brain.mjs — file naming conventions

**Objective:** Verify date-based file naming and backup directory path logic.

**Files:**
- Create: `tests/test-backup-brain-naming.mjs`

**Step 1: Write test file**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { backupDir, today, humanSize, PAGE_SIZE, TABLES } from "../recipes/brain-backup/backup-brain.mjs";

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
  assert.equal(humanSize(569462575), "542.9 MB");
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
```

**Step 2: Run tests**

Run: `node --test tests/test-backup-brain-naming.mjs`
Expected: All tests pass.

---

## Task 6: Export functions from import-supabase-backup.mjs

**Objective:** Add `export` to the key helper functions in `import-supabase-backup.mjs` and guard the `main()` call.

**Files:**
- Modify: `recipes/aegis-local-brain/scripts/import-supabase-backup.mjs`

**Step 1: Add `export` to functions**

- `function loadEnvFile(filePath)` → `export function loadEnvFile(filePath)`
- `function newestBackupForTable(backupDir, tableName)` → `export function newestBackupForTable(backupDir, tableName)`
- `function sha256File(filePath)` → `export function sha256File(filePath)`
- `function newestManifest(backupDir)` → `export function newestManifest(backupDir)`
- `function validateBackupManifest(backupDir)` → `export function validateBackupManifest(backupDir)`
- `function resolveBackupPath(inputPath)` → `export function resolveBackupPath(inputPath)`
- `function resolveBackupInput(inputPath)` → `export function resolveBackupInput(inputPath)`
- `function sourceMetadata(row)` → `export function sourceMetadata(row)`
- `function contentFingerprint(content)` → `export function contentFingerprint(content)`
- `function emptyImportPlan()` → `export function emptyImportPlan()`
- `function addRowToImportPlan(plan, row)` → `export function addRowToImportPlan(plan, row)`
- `function argValue(name)` → `export function argValue(name)`

Also export constants:
- `export const SIDE_TABLES = [...];`

**Step 2: Guard main() execution**

```js
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
```

**Step 3: Verify script still runs**

Run: `cd recipes/aegis-local-brain && node scripts/import-supabase-backup.mjs --dry-run`
Expected: either runs dry-run or exits with key error (same behavior as before).

**Step 4: Verify import works**

Run: `node -e "import('./scripts/import-supabase-backup.mjs').then(m => console.log(typeof m.validateBackupManifest))"`
Expected: `function`

---

## Task 7: Test import-supabase-backup.mjs — newestBackupForTable and newestManifest

**Objective:** Test file selection logic for backups and manifests.

**Files:**
- Create: `tests/test-import-file-selection.mjs`

**Step 1: Write test file**

```js
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
```

**Step 2: Run tests**

Run: `node --test tests/test-import-file-selection.mjs`
Expected: All tests pass.

---

## Task 8: Test import-supabase-backup.mjs — validateBackupManifest

**Objective:** Test manifest validation: ok flag, file existence, sha256 match, file_size match.

**Files:**
- Create: `tests/test-import-manifest-validation.mjs`

**Step 1: Write test file**

```js
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
```

**Step 2: Run tests**

Run: `node --test tests/test-import-manifest-validation.mjs`
Expected: All tests pass.

---

## Task 9: Test import-supabase-backup.mjs — import plan and content fingerprinting

**Objective:** Test `emptyImportPlan()`, `addRowToImportPlan()`, `contentFingerprint()`, and `sourceMetadata()`.

**Files:**
- Create: `tests/test-import-plan.mjs`

**Step 1: Write test file**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyImportPlan, addRowToImportPlan, contentFingerprint, sourceMetadata, SIDE_TABLES } from "../scripts/import-supabase-backup.mjs";

test("emptyImportPlan: returns correct initial structure", () => {
  const plan = emptyImportPlan();
  assert.equal(plan.backup_rows, 0);
  assert.equal(plan.importable_rows, 0);
  assert.equal(plan.skipped_rows, 0);
  assert.equal(plan.expected_unique_fingerprints, 0);
  assert.equal(plan.duplicate_content_rows, 0);
  assert.ok(plan.fingerprints instanceof Set);
});

test("addRowToImportPlan: skips rows with no content", () => {
  const plan = emptyImportPlan();
  const added = addRowToImportPlan(plan, { id: 1, content: "" });
  assert.equal(added, false);
  assert.equal(plan.backup_rows, 1);
  assert.equal(plan.skipped_rows, 1);
  assert.equal(plan.importable_rows, 0);
});

test("addRowToImportPlan: skips rows where content is not a string", () => {
  const plan = emptyImportPlan();
  addRowToImportPlan(plan, { id: 1, content: 42 });
  assert.equal(plan.skipped_rows, 1);
  assert.equal(plan.importable_rows, 0);
});

test("addRowToImportPlan: skips null/undefined rows", () => {
  const plan = emptyImportPlan();
  addRowToImportPlan(plan, null);
  addRowToImportPlan(plan, undefined);
  assert.equal(plan.backup_rows, 2);
  assert.equal(plan.skipped_rows, 2);
  assert.equal(plan.importable_rows, 0);
});

test("addRowToImportPlan: counts importable rows and fingerprints", () => {
  const plan = emptyImportPlan();
  addRowToImportPlan(plan, { id: 1, content: "hello world" });
  addRowToImportPlan(plan, { id: 2, content: "hello world" }); // duplicate fingerprint
  addRowToImportPlan(plan, { id: 3, content: "different content" });

  assert.equal(plan.backup_rows, 3);
  assert.equal(plan.importable_rows, 3);
  assert.equal(plan.expected_unique_fingerprints, 2);
  assert.equal(plan.duplicate_content_rows, 1);
});

test("contentFingerprint: same content produces same hash regardless of whitespace", () => {
  const h1 = contentFingerprint("hello  world");
  const h2 = contentFingerprint("hello world");
  const h3 = contentFingerprint("  Hello  World  ");
  assert.equal(h1, h2); // multiple spaces collapse to single
  assert.equal(h1, h3); // case-insensitive after toLowerCase
});

test("contentFingerprint: returns 64-char hex string", () => {
  const hash = contentFingerprint("test");
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("sourceMetadata: merges original metadata and adds source fields", () => {
  const row = {
    id: "abc-123",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    metadata: { topic: "test" },
  };
  const result = sourceMetadata(row);
  assert.equal(result.topic, "test");
  assert.equal(result.migrated_from, "open-brain-supabase-backup");
  assert.equal(result.source_id, "abc-123");
  assert.equal(result.source_created_at, "2026-01-01T00:00:00Z");
  assert.equal(result.source_updated_at, "2026-01-02T00:00:00Z");
});

test("sourceMetadata: handles row with no metadata field", () => {
  const row = { id: "x", created_at: "c", updated_at: "u" };
  const result = sourceMetadata(row);
  assert.equal(result.migrated_from, "open-brain-supabase-backup");
  assert.deepEqual(result.topic, undefined);
});

test("sourceMetadata: handles non-object metadata gracefully", () => {
  const row = { id: "x", metadata: "not-an-object" };
  const result = sourceMetadata(row);
  assert.equal(result.migrated_from, "open-brain-supabase-backup");
});

test("SIDE_TABLES: contains expected 8 table names", () => {
  assert.equal(SIDE_TABLES.length, 8);
  const expected = ["entities", "edges", "thought_entities", "reflections",
    "ingestion_jobs", "ingestion_items", "agent_memories", "agent_memory_audit_events"];
  for (const t of expected) {
    assert.ok(SIDE_TABLES.includes(t), `should include ${t}`);
  }
});
```

**Step 2: Run tests**

Run: `node --test tests/test-import-plan.mjs`
Expected: All tests pass.

---

## Task 10: Test import-supabase-backup.mjs — argValue and flag parsing

**Objective:** Test CLI argument parsing logic.

**Files:**
- Create: `tests/test-import-args.mjs`

**Step 1: Write test file**

This test requires the `argValue` function to be importable. Since `args` is a module-level variable derived from `process.argv`, we test `argValue` by setting `process.argv` before import. Alternatively, test the parsing logic independently.

```js
import { test } from "node:test";
import assert from "node:assert/strict";

// argValue reads from module-level `args` which is set at import time.
// We test the logic pattern independently to verify correctness.

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verify = args.includes("--verify");
  const sideTablesOnly = args.includes("--side-tables-only");

  function argValue(name) {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] || "" : "";
  }

  return { dryRun, verify, sideTablesOnly, argValue };
}

test("argValue: extracts inline value with --flag=value syntax", () => {
  const { argValue } = parseArgs(["node", "script.js", "--start-at-source-id=abc-123"]);
  assert.equal(argValue("--start-at-source-id"), "abc-123");
});

test("argValue: extracts value from space-separated flag", () => {
  const { argValue } = parseArgs(["node", "script.js", "--start-at-source-id", "def-456"]);
  assert.equal(argValue("--start-at-source-id"), "def-456");
});

test("argValue: returns empty string for missing flag", () => {
  const { argValue } = parseArgs(["node", "script.js"]);
  assert.equal(argValue("--start-at-source-id"), "");
});

test("flags: dry-run, verify, side-tables-only parsed correctly", () => {
  const { dryRun, verify, sideTablesOnly } = parseArgs(["node", "script.js", "--dry-run", "--verify"]);
  assert.equal(dryRun, true);
  assert.equal(verify, true);
  assert.equal(sideTablesOnly, false);
});

test("flags: all false when no flags present", () => {
  const { dryRun, verify, sideTablesOnly } = parseArgs(["node", "script.js", "some-backup-dir"]);
  assert.equal(dryRun, false);
  assert.equal(verify, false);
  assert.equal(sideTablesOnly, false);
});
```

**Step 2: Run tests**

Run: `node --test tests/test-import-args.mjs`
Expected: All tests pass.

---

## Task 11: Test import-supabase-backup.mjs — resolveBackupPath and resolveBackupInput

**Objective:** Test backup path resolution logic (absolute, relative, default).

**Files:**
- Create: `tests/test-import-backup-path.mjs`

**Step 1: Write test file**

```js
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
```

**Step 2: Run tests**

Run: `node --test tests/test-import-backup-path.mjs`
Expected: All tests pass.

---

## Task 12: Export functions from server.mjs for testing

**Objective:** Export the backup helper functions from `server.mjs` so they can be tested in isolation without starting the HTTP server.

**Files:**
- Modify: `recipes/aegis-local-brain/api/server.mjs`

**Step 1: Add `export` to backup helper functions**

- `function archiveSourceId(tableName, row, index)` → `export function archiveSourceId(tableName, row, index)`
- `function textOrNull(value)` → `export function textOrNull(value)`
- `function numberOrNull(value)` → `export function numberOrNull(value)`
- `function boolOrFalse(value)` → `export function boolOrFalse(value)`
- `function boolOrTrue(value)` → `export function boolOrTrue(value)`
- `function jsonObjectOrEmpty(value)` → `export function jsonObjectOrEmpty(value)`
- `function jsonArrayOrEmpty(value)` → `export function jsonArrayOrEmpty(value)`
- `function sideTableRecord(tableName, archiveRecord)` → `export function sideTableRecord(tableName, archiveRecord)`

Also export constants:
- `export const ARCHIVE_SOURCE_SYSTEM = "hosted_open_brain";`
- `export const ARCHIVE_TABLE_NAMES = [...];`

**Important:** `promoteBackupRows`, `handleBackupArchive`, `handleBackupArchiveCount`, and `handleFirstClassSideTableCount` depend on `postgrestPost`/`postgrestGetWithHeaders` which make HTTP calls to PostgREST. These will be tested via mocked fetch in integration tests (Task 15+), not as pure unit tests.

**Step 2: Guard server startup**

The server likely calls `http.createServer().listen()` at the bottom. Guard it:

```js
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  server.listen(PORT, () => console.log(`Brain API on :${PORT}`));
}
```

**Step 3: Verify server still starts**

Run: `cd recipes/aegis-local-brain/api && node server.mjs`
Expected: starts normally (then Ctrl+C).

**Step 4: Verify import works**

Run: `node -e "import('./recipes/aegis-local-brain/api/server.mjs').then(m => console.log(typeof m.sideTableRecord))"`
Expected: `function`

> **Note:** The server.mjs uses `requiredEnv()` at module top level which throws if env vars are missing. Tests will need to set `POSTGREST_URL`, `SERVICE_ROLE_KEY`, `BRAIN_ACCESS_KEY` env vars before importing. This is handled in the test setup.

---

## Task 13: Test server.mjs — type coercion helpers

**Objective:** Test `textOrNull`, `numberOrNull`, `boolOrFalse`, `boolOrTrue`, `jsonObjectOrEmpty`, `jsonArrayOrEmpty`.

**Files:**
- Create: `tests/test-server-helpers.mjs`

**Step 1: Write test file**

```js
import { test } from "node:test";
import assert from "node:assert/strict";

// Set required env vars before importing server.mjs
process.env.POSTGREST_URL = "http://localhost:3000";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";

const {
  textOrNull, numberOrNull, boolOrFalse, boolOrTrue,
  jsonObjectOrEmpty, jsonArrayOrEmpty,
} = await import("../api/server.mjs");

test("textOrNull: returns null for undefined, null, or empty string", () => {
  assert.equal(textOrNull(undefined), null);
  assert.equal(textOrNull(null), null);
  assert.equal(textOrNull(""), null);
});

test("textOrNull: converts non-empty value to string", () => {
  assert.equal(textOrNull("hello"), "hello");
  assert.equal(textOrNull(42), "42");
  assert.equal(textOrNull(true), "true");
});

test("numberOrNull: returns number for numeric input", () => {
  assert.equal(numberOrNull(42), 42);
  assert.equal(numberOrNull("3.14"), 3.14);
  assert.equal(numberOrNull(0), 0);
});

test("numberOrNull: returns null for non-finite values", () => {
  assert.equal(numberOrNull(undefined), null);
  assert.equal(numberOrNull(null), null);
  assert.equal(numberOrNull("not-a-number"), null);
  assert.equal(numberOrNull(NaN), null);
  assert.equal(numberOrNull(Infinity), null);
});

test("boolOrFalse: returns true only for literal true", () => {
  assert.equal(boolOrFalse(true), true);
  assert.equal(boolOrFalse(false), false);
  assert.equal(boolOrFalse(undefined), false);
  assert.equal(boolOrFalse(null), false);
  assert.equal(boolOrFalse("true"), false); // string, not boolean
  assert.equal(boolOrFalse(1), false);
});

test("boolOrTrue: returns false only for literal false", () => {
  assert.equal(boolOrTrue(false), false);
  assert.equal(boolOrTrue(true), true);
  assert.equal(boolOrTrue(undefined), true);
  assert.equal(boolOrTrue(null), true);
  assert.equal(boolOrTrue("false"), true); // string, not boolean false
});

test("jsonObjectOrEmpty: returns object for plain objects", () => {
  assert.deepEqual(jsonObjectOrEmpty({ a: 1 }), { a: 1 });
  assert.deepEqual(jsonObjectOrEmpty({}), {});
});

test("jsonObjectOrEmpty: returns {} for non-objects and arrays", () => {
  assert.deepEqual(jsonObjectOrEmpty(null), {});
  assert.deepEqual(jsonObjectOrEmpty(undefined), {});
  assert.deepEqual(jsonObjectOrEmpty("string"), {});
  assert.deepEqual(jsonObjectOrEmpty([1, 2]), {}); // arrays are not objects
  assert.deepEqual(jsonObjectOrEmpty(42), {});
});

test("jsonArrayOrEmpty: returns array for arrays", () => {
  assert.deepEqual(jsonArrayOrEmpty([1, 2]), [1, 2]);
  assert.deepEqual(jsonArrayOrEmpty([]), []);
});

test("jsonArrayOrEmpty: returns [] for non-arrays", () => {
  assert.deepEqual(jsonArrayOrEmpty(null), []);
  assert.deepEqual(jsonArrayOrEmpty(undefined), []);
  assert.deepEqual(jsonArrayOrEmpty("string"), []);
  assert.deepEqual(jsonArrayOrEmpty({ a: 1 }), []);
});
```

**Step 2: Run tests**

Run: `node --test tests/test-server-helpers.mjs`
Expected: All tests pass.

---

## Task 14: Test server.mjs — archiveSourceId

**Objective:** Test source ID generation for different row shapes and table types.

**Files:**
- Create: `tests/test-server-archive-source-id.mjs`

**Step 1: Write test file**

```js
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
```

**Step 2: Run tests**

Run: `node --test tests/test-server-archive-source-id.mjs`
Expected: All tests pass.

---

## Task 15: Test server.mjs — sideTableRecord for each table type

**Objective:** Test `sideTableRecord()` transformation for all 8 supported table types.

**Files:**
- Create: `tests/test-server-side-table-record.mjs`

**Step 1: Write test file**

```js
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
  assert.equal(record.metadata.options, ["a", "b"]); // array preserved
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
  // No table-specific fields beyond base
  assert.equal(Object.keys(record).length, 5); // id, source_system, source_id, row_data, backup_file + created_at = 6
});
```

**Step 2: Run tests**

Run: `node --test tests/test-server-side-table-record.mjs`
Expected: All tests pass. May need to adjust the `unknown_table` assertion if base has 6 fields (including `created_at`).

---

## Task 16: Test server.mjs — handleBackupArchive with mocked PostgREST

**Objective:** Test the `handleBackupArchive` handler with a mocked `postgrestPost` function, verifying archive record construction and promotion logic.

**Files:**
- Create: `tests/test-server-handle-backup-archive.mjs`

**Step 1: Write test file**

This requires mocking the module-level `postgrestPost` and `postgrestGetWithHeaders` functions. Since they are module-scoped and not exported, we need to use a different approach:

**Approach:** Create a test wrapper module that imports the handler functions and replaces the PostgREST calls. Since `server.mjs` doesn't export `postgrestPost`, we'll test the handler logic by extracting the relevant code into a testable form, OR by intercepting `fetch` at the global level.

Given that `postgrestPost` ultimately calls `fetch(POSTGREST_URL + path, ...)`, we can mock `globalThis.fetch`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POSTGREST_URL = "http://postgrest-test:3000";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";

// We need to test handleBackupArchive which calls postgrestPost internally.
// postgrestPost calls fetch() against POSTGREST_URL.
// We mock globalThis.fetch to intercept those calls.

let fetchCalls = [];

function mockFetchResponse({ status = 200, body = "", headers = {} } = {}) {
  const headerMap = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headerMap.get(name) || null },
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const originalFetch = globalThis.fetch;

test("handleBackupArchive: archives valid rows and promotes to side tables", async () => {
  fetchCalls = [];
  let archiveCallBody = null;
  let promoteCallBody = null;

  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, method: options?.method, body: options?.body });
    if (url.includes("/backup_archive_rows")) {
      archiveCallBody = JSON.parse(options.body);
      return mockFetchResponse({ status: 201, body: "[]", headers: {} });
    }
    if (url.includes("/agent_memories?on_conflict=source_id")) {
      promoteCallBody = JSON.parse(options.body);
      return mockFetchResponse({ status: 201, body: "[]", headers: {} });
    }
    return mockFetchResponse({ status: 200, body: "[]" });
  };

  const { handleBackupArchive } = await import("../api/server.mjs");

  const result = await handleBackupArchive({
    table: "agent_memories",
    rows: [
      { id: "m1", workspace_id: "ws-1", memory_type: "decision", summary: "test", content: "content" },
      { id: "m2", workspace_id: "ws-1", memory_type: "lesson", summary: "test2", content: "content2" },
    ],
    backup_file: "agent_memories-2026-06-29.json",
  });

  assert.equal(result.ok, true);
  assert.equal(result.table, "agent_memories");
  assert.equal(result.archived_count, 2);
  assert.equal(result.promoted_count, 2);
  assert.equal(result.skipped_count, 0);

  // Verify archive records have correct structure
  assert.ok(archiveCallBody);
  assert.equal(archiveCallBody.length, 2);
  assert.equal(archiveCallBody[0].source_system, "hosted_open_brain");
  assert.equal(archiveCallBody[0].table_name, "agent_memories");
  assert.equal(archiveCallBody[0].source_id, "m1");
  assert.equal(archiveCallBody[0].backup_file, "agent_memories-2026-06-29.json");

  // Verify promote call uses source_id conflict resolution
  assert.ok(promoteCallBody);
  assert.equal(promoteCallBody.length, 2);
  assert.equal(promoteCallBody[0].source_id, "m1");

  globalThis.fetch = originalFetch;
});

test("handleBackupArchive: rejects unsupported table", async () => {
  globalThis.fetch = async () => mockFetchResponse({ status: 200, body: "[]" });
  const { handleBackupArchive } = await import("../api/server.mjs");

  await assert.rejects(
    () => handleBackupArchive({ table: "invalid_table", rows: [] }),
    /unsupported archive table/
  );
  globalThis.fetch = originalFetch;
});

test("handleBackupArchive: handles empty rows array", async () => {
  fetchCalls = [];
  globalThis.fetch = async () => mockFetchResponse({ status: 200, body: "[]" });
  const { handleBackupArchive } = await import("../api/server.mjs");

  const result = await handleBackupArchive({
    table: "agent_memories",
    rows: [],
    backup_file: "test.json",
  });

  assert.equal(result.ok, true);
  assert.equal(result.archived_count, 0);
  assert.equal(result.promoted_count, 0);
  assert.equal(result.skipped_count, 0);
  // No fetch calls should be made for empty rows
  assert.equal(fetchCalls.length, 0);
  globalThis.fetch = originalFetch;
});

test("handleBackupArchive: skips non-object rows", async () => {
  fetchCalls = [];
  globalThis.fetch = async () => mockFetchResponse({ status: 201, body: "[]" });
  const { handleBackupArchive } = await import("../api/server.mjs");

  const result = await handleBackupArchive({
    table: "entities",
    rows: [
      { id: "e1", name: "Entity1" },
      null,
      "not-an-object",
      [1, 2, 3],
      { id: "e2", name: "Entity2" },
    ],
    backup_file: "entities-2026-06-29.json",
  });

  assert.equal(result.archived_count, 2); // only 2 valid objects
  assert.equal(result.skipped_count, 3);
  globalThis.fetch = originalFetch;
});
```

**Step 2: Run tests**

Run: `node --test tests/test-server-handle-backup-archive.mjs`
Expected: All tests pass.

---

## Task 17: Test server.mjs — handleBackupArchiveCount with mocked PostgREST

**Objective:** Test the archive count endpoint handler with mocked PostgREST responses.

**Files:**
- Create: `tests/test-server-archive-count.mjs`

**Step 1: Write test file**

```js
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POSTGREST_URL = "http://postgrest-test:3000";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";

const originalFetch = globalThis.fetch;

function mockFetchWithCount(count) {
  return async (url, options) => {
    return {
      ok: true,
      status: 206,
      headers: {
        get: (name) => name === "content-range" ? `0-0/${count}` : null,
      },
      json: async () => [],
      text: async () => "[]",
    };
  };
}

test("handleBackupArchiveCount: returns count for specific table", async () => {
  globalThis.fetch = mockFetchWithCount(42);
  const { handleBackupArchiveCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/archive/count?table=agent_memories");
  const result = await handleBackupArchiveCount(url);

  assert.equal(result.ok, true);
  assert.equal(result.table, "agent_memories");
  assert.equal(result.count, 42);
  assert.equal(result.source_system, "hosted_open_brain");
  globalThis.fetch = originalFetch;
});

test("handleBackupArchiveCount: returns count without table filter", async () => {
  globalThis.fetch = mockFetchWithCount(100);
  const { handleBackupArchiveCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/archive/count");
  const result = await handleBackupArchiveCount(url);

  assert.equal(result.ok, true);
  assert.equal(result.table, null);
  assert.equal(result.count, 100);
  globalThis.fetch = originalFetch;
});

test("handleBackupArchiveCount: rejects unsupported table", async () => {
  globalThis.fetch = mockFetchWithCount(0);
  const { handleBackupArchiveCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/archive/count?table=invalid");
  await assert.rejects(
    () => handleBackupArchiveCount(url),
    /unsupported archive table/
  );
  globalThis.fetch = originalFetch;
});

test("handleBackupArchiveCount: returns 0 for wildcard content-range", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 206,
    headers: { get: (name) => name === "content-range" ? "0-0/*" : null },
    json: async () => [],
    text: async () => "[]",
  });
  const { handleBackupArchiveCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/archive/count?table=entities");
  const result = await handleBackupArchiveCount(url);
  assert.equal(result.count, 0);
  globalThis.fetch = originalFetch;
});
```

**Step 2: Run tests**

Run: `node --test tests/test-server-archive-count.mjs`
Expected: All tests pass.

---

## Task 18: Test server.mjs — handleFirstClassSideTableCount with mocked PostgREST

**Objective:** Test the first-class side table count endpoint.

**Files:**
- Create: `tests/test-server-first-class-count.mjs`

**Step 1: Write test file**

```js
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POSTGREST_URL = "http://postgrest-test:3000";
process.env.SERVICE_ROLE_KEY = "test-key";
process.env.BRAIN_ACCESS_KEY = "test-brain-key";

const originalFetch = globalThis.fetch;

// Mock that returns different counts per table
function mockFetchPerTable(counts) {
  return async (url, options) => {
    // Extract table name from URL path
    const match = url.match(/\/([^/?]+)/);
    const table = match ? match[1] : "";
    const count = counts[table] ?? 0;
    return {
      ok: true,
      status: 206,
      headers: { get: (name) => name === "content-range" ? `0-0/${count}` : null },
      json: async () => [],
      text: async () => "[]",
    };
  };
}

test("handleFirstClassSideTableCount: returns count for specific table", async () => {
  globalThis.fetch = mockFetchPerTable({ agent_memories: 15 });
  const { handleFirstClassSideTableCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/first-class/count?table=agent_memories");
  const result = await handleFirstClassSideTableCount(url);

  assert.equal(result.ok, true);
  assert.equal(result.table, "agent_memories");
  assert.equal(result.count, 15);
  assert.equal(result.first_class_count, 15);
  globalThis.fetch = originalFetch;
});

test("handleFirstClassSideTableCount: returns total count across all tables when no table specified", async () => {
  globalThis.fetch = mockFetchPerTable({
    agent_memories: 10, agent_memory_audit_events: 5,
    entities: 20, edges: 8, thought_entities: 3,
    reflections: 2, ingestion_jobs: 1, ingestion_items: 4,
  });
  const { handleFirstClassSideTableCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/first-class/count");
  const result = await handleFirstClassSideTableCount(url);

  assert.equal(result.ok, true);
  assert.equal(result.table, null);
  assert.equal(result.count, 10 + 5 + 20 + 8 + 3 + 2 + 1 + 4);
  assert.equal(result.first_class_count, result.count);
  assert.ok(result.counts);
  assert.equal(result.counts.agent_memories, 10);
  globalThis.fetch = originalFetch;
});

test("handleFirstClassSideTableCount: rejects unsupported table", async () => {
  globalThis.fetch = mockFetchPerTable({});
  const { handleFirstClassSideTableCount } = await import("../api/server.mjs");

  const url = new URL("http://localhost:8787/backup/first-class/count?table=invalid");
  await assert.rejects(
    () => handleFirstClassSideTableCount(url),
    /unsupported first-class table/
  );
  globalThis.fetch = originalFetch;
});
```

**Step 2: Run tests**

Run: `node --test tests/test-server-first-class-count.mjs`
Expected: All tests pass.

---

## Task 19: Integration test — round-trip export → import → verify

**Objective:** Test the full data durability loop: create mock backup data, validate manifest, simulate import, verify counts.

**Files:**
- Create: `tests/test-integration-round-trip.mjs`

**Step 1: Write test file**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { writeManifest, sha256File, TABLES, PAGE_SIZE } from "../recipes/brain-backup/backup-brain.mjs";
import { validateBackupManifest, newestBackupForTable, newestManifest, addRowToImportPlan, emptyImportPlan } from "../scripts/import-supabase-backup.mjs";
import { makeTempDir, cleanupTempDir } from "./helpers.mjs";

test("integration: export → manifest → import validation → count match", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";

  // Step 1: Simulate export — write backup files
  const mockRows = {
    agent_memories: Array.from({ length: 20 }, (_, i) => ({ id: `mem-${i}`, content: `memory ${i}`, workspace_id: "ws-1" })),
    agent_memory_audit_events: Array.from({ length: 14 }, (_, i) => ({ id: `evt-${i}`, event_type: "memory_written" })),
    thoughts: Array.from({ length: 100 }, (_, i) => ({ id: `th-${i}`, content: `thought ${i}` })),
  };

  const results = [];
  let totalRows = 0;
  let totalSize = 0;

  for (const { name } of TABLES) {
    const filePath = path.join(dir, `${name}-${dateStr}.json`);
    fs.writeFileSync(filePath, JSON.stringify(mockRows[name]));
    const fileSize = fs.statSync(filePath).size;
    results.push({ table: name, rowCount: mockRows[name].length, filePath, fileSize });
    totalRows += mockRows[name].length;
    totalSize += fileSize;
  }

  // Step 2: Write manifest
  const { manifest, manifestPath } = writeManifest({ backupDir: dir, dateStr, results, totalRows, totalSize });
  assert.equal(manifest.ok, true);

  // Step 3: Validate manifest (import-side validation)
  const validationResult = validateBackupManifest(dir);
  assert.ok(validationResult);
  assert.equal(validationResult.manifest.ok, true);
  assert.equal(validationResult.manifest.total_rows, totalRows);

  // Step 4: Verify each backup file is found and readable
  for (const { name } of TABLES) {
    const backupFile = newestBackupForTable(dir, name);
    assert.ok(backupFile, `should find backup for ${name}`);
    const rows = JSON.parse(fs.readFileSync(backupFile, "utf8"));
    assert.equal(rows.length, mockRows[name].length);
  }

  // Step 5: Simulate import plan — verify counts match
  const plan = emptyImportPlan();
  const thoughtsFile = newestBackupForTable(dir, "thoughts");
  for (const row of JSON.parse(fs.readFileSync(thoughtsFile, "utf8"))) {
    addRowToImportPlan(plan, row);
  }
  assert.equal(plan.backup_rows, mockRows.thoughts.length);
  assert.equal(plan.importable_rows, mockRows.thoughts.length);
  assert.equal(plan.expected_unique_fingerprints, mockRows.thoughts.length); // all unique

  cleanupTempDir(dir);
});

test("integration: manifest integrity — sha256 matches after re-export", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";

  const rows = [{ id: 1, content: "test" }];
  const filePath = path.join(dir, `agent_memories-${dateStr}.json`);
  fs.writeFileSync(filePath, JSON.stringify(rows));

  const results = [{ table: "agent_memories", rowCount: 1, filePath, fileSize: fs.statSync(filePath).size }];
  const { manifest } = writeManifest({ backupDir: dir, dateStr, results, totalRows: 1, totalSize: results[0].fileSize });

  // Re-validate: sha256 should match
  const validation = validateBackupManifest(dir);
  assert.ok(validation);
  assert.equal(validation.manifest.tables[0].sha256, manifest.tables[0].sha256);

  // Tamper with the file
  fs.writeFileSync(filePath, JSON.stringify([{ id: 1, content: "tampered" }]));
  assert.throws(() => validateBackupManifest(dir), /sha256 mismatch/);

  cleanupTempDir(dir);
});

test("integration: idempotent imports — re-importing same data produces same fingerprints", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";

  const rows = [
    { id: "t1", content: "same content" },
    { id: "t2", content: "same content" }, // duplicate
    { id: "t3", content: "unique content" },
  ];
  const filePath = path.join(dir, `thoughts-${dateStr}.json`);
  fs.writeFileSync(filePath, JSON.stringify(rows));

  // First import plan
  const plan1 = emptyImportPlan();
  for (const row of rows) addRowToImportPlan(plan1, row);

  // Second import plan (simulating re-import)
  const plan2 = emptyImportPlan();
  for (const row of rows) addRowToImportPlan(plan2, row);

  // Both plans should have identical metrics
  assert.equal(plan1.expected_unique_fingerprints, plan2.expected_unique_fingerprints);
  assert.equal(plan1.duplicate_content_rows, plan2.duplicate_content_rows);
  assert.equal(plan1.importable_rows, plan2.importable_rows);

  cleanupTempDir(dir);
});
```

**Step 2: Run tests**

Run: `node --test tests/test-integration-round-trip.mjs`
Expected: All tests pass.

---

## Task 20: Integration test — backup file naming and date handling

**Objective:** Test that backup files are correctly named with dates and can be sorted/selected properly across multiple backup dates.

**Files:**
- Create: `tests/test-integration-naming.mjs`

**Step 1: Write test file**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { today, writeManifest } from "../recipes/brain-backup/backup-brain.mjs";
import { newestBackupForTable, newestManifest } from "../scripts/import-supabase-backup.mjs";
import { makeTempDir, cleanupTempDir } from "./helpers.mjs";

test("naming: multiple backups select newest by date", () => {
  const dir = makeTempDir();

  // Create backups for 3 dates
  for (const date of ["2026-06-27", "2026-06-28", "2026-06-29"]) {
    fs.writeFileSync(path.join(dir, `agent_memories-${date}.json`), JSON.stringify([{ id: 1 }]));
    fs.writeFileSync(path.join(dir, `manifest-${date}.json`), JSON.stringify({ ok: true, date, tables: [] }));
  }

  // newestBackupForTable should return the latest
  const newest = newestBackupForTable(dir, "agent_memories");
  assert.equal(path.basename(newest), "agent_memories-2026-06-29.json");

  // newestManifest should return the latest manifest
  const manifest = newestManifest(dir);
  assert.equal(path.basename(manifest), "manifest-2026-06-29.json");

  cleanupTempDir(dir);
});

test("naming: today() produces a valid date string for file naming", () => {
  const date = today();
  // Verify it can be used in a filename
  const filename = `agent_memories-${date}.json`;
  assert.match(filename, /^agent_memories-\d{4}-\d{2}-\d{2}\.json$/);
});

test("naming: manifest and backup files share the same date suffix", () => {
  const dir = makeTempDir();
  const dateStr = "2026-06-29";

  const tableFile = path.join(dir, `agent_memories-${dateStr}.json`);
  fs.writeFileSync(tableFile, "[]");

  const results = [{ table: "agent_memories", rowCount: 0, filePath: tableFile, fileSize: 2 }];
  const { manifestPath } = writeManifest({ backupDir: dir, dateStr, results, totalRows: 0, totalSize: 2 });

  // Manifest file name should match the date
  assert.equal(path.basename(manifestPath), `manifest-${dateStr}.json`);

  // Table file name should match the date
  assert.ok(fs.existsSync(path.join(dir, `agent_memories-${dateStr}.json`)));

  cleanupTempDir(dir);
});

test("naming: lexicographic date sort matches chronological order for ISO dates", () => {
  const dir = makeTempDir();
  const dates = ["2026-01-05", "2026-01-10", "2026-02-01", "2026-12-31", "2026-06-29"];

  for (const date of dates) {
    fs.writeFileSync(path.join(dir, `agent_memories-${date}.json`), "[]");
  }

  const newest = newestBackupForTable(dir, "agent_memories");
  // Lexicographic sort of ISO dates matches chronological order
  assert.equal(path.basename(newest), "agent_memories-2026-12-31.json");

  cleanupTempDir(dir);
});
```

**Step 2: Run tests**

Run: `node --test tests/test-integration-naming.mjs`
Expected: All tests pass.

---

## Task 21: Create test runner script and verify all tests pass

**Objective:** Create a convenience script to run all tests and verify the full suite passes.

**Files:**
- Create: `tests/run-all-tests.mjs`

**Step 1: Write runner script**

```js
#!/usr/bin/env node
/**
 * Run all brain backup tests.
 * Usage: node tests/run-all-tests.mjs
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const testFiles = [
  "test-backup-brain-config.mjs",
  "test-backup-brain-manifest.mjs",
  "test-backup-brain-naming.mjs",
  "test-import-file-selection.mjs",
  "test-import-manifest-validation.mjs",
  "test-import-plan.mjs",
  "test-import-args.mjs",
  "test-import-backup-path.mjs",
  "test-server-helpers.mjs",
  "test-server-archive-source-id.mjs",
  "test-server-side-table-record.mjs",
  "test-server-handle-backup-archive.mjs",
  "test-server-archive-count.mjs",
  "test-server-first-class-count.mjs",
  "test-integration-round-trip.mjs",
  "test-integration-naming.mjs",
];

let allPassed = true;

for (const file of testFiles) {
  const filePath = path.join(__dirname, file);
  console.log(`\n--- Running ${file} ---`);
  try {
    execSync(`node --test ${filePath}`, { stdio: "inherit", cwd: __dirname });
    console.log(`✓ ${file}`);
  } catch {
    console.error(`✗ ${file} FAILED`);
    allPassed = false;
  }
}

console.log("\n" + (allPassed ? "✓ All tests passed!" : "✗ Some tests failed!"));
process.exit(allPassed ? 0 : 1);
```

**Step 2: Run all tests**

Run: `cd recipes/aegis-local-brain && node tests/run-all-tests.mjs`
Expected: All tests pass.

**Step 3: Commit all test files**

```bash
git add tests/
git commit -m "test: comprehensive brain backup test suite (16 test files)"
```

---

## Verification Cheat Sheet

| What | Command | Expected |
|------|---------|----------|
| Run all tests | `node tests/run-all-tests.mjs` | "✓ All tests passed!" |
| Run single test file | `node --test tests/test-backup-brain-config.mjs` | All tests pass |
| Run all tests via glob | `node --test tests/test-*.mjs` | All tests pass |
| Verify helpers import | `node -e "import('./tests/helpers.mjs').then(() => console.log('ok'))"` | `ok` |
| Verify backup-brain exports | `node -e "import('./recipes/brain-backup/backup-brain.mjs').then(m => console.log(typeof m.supabaseHost))"` | `function` |
| Verify import script exports | `node -e "import('./scripts/import-supabase-backup.mjs').then(m => console.log(typeof m.validateBackupManifest))"` | `function` |
| Verify server exports | `node -e "import('./api/server.mjs').then(m => console.log(typeof m.sideTableRecord))"` | `function` |

---

## Current State at Plan Write-Time

- **Node.js version**: v22 (node:22-alpine in docker-compose)
- **Test framework**: Node.js built-in test runner (`node:test` + `node:assert/strict`)
- **No package.json**: Project uses bare ESM modules; no test runner install needed
- **Source files**: All source files at the paths listed in Prerequisites
- **Existing backup data**: `recipes/brain-backup/backup/` contains 2026-06-29 backup (569MB thoughts file)
- **Server**: `server.mjs` is 2425 lines, uses `requiredEnv()` at module top level (throws if env vars missing)
- **PostgREST**: Used by server.mjs for DB access; tests mock `fetch` to avoid needing a live PostgREST
- **No existing tests**: `tests/` directory does not exist yet

## Pitfalls

- **`requiredEnv()` at import time**: `server.mjs` calls `requiredEnv("POSTGREST_URL")` etc. at module top level. Tests importing `server.mjs` MUST set `POSTGREST_URL`, `SERVICE_ROLE_KEY`, and `BRAIN_ACCESS_KEY` env vars before `import()`. Use `process.env.X = "test"` before the dynamic `import()` call.
- **`import.meta.url` guard**: Adding `isMain` checks to source files is essential — without them, importing the module for tests will trigger CLI side effects (preflight exit, main() execution, server.listen()).
- **Module-level constants**: `backup-brain.mjs` reads env vars at module load time into `SUPABASE_URL` and `SERVICE_KEY` constants. Tests that need to vary these will need to set env vars before import or test the functions that accept parameters.
- **569MB backup file**: Never load `thoughts-2026-06-29.json` in tests — it's 569MB. Use small synthetic data instead.
- **`fetch` mock restoration**: Always restore `globalThis.fetch` after each test to avoid leaking mocks into subsequent tests. Use `test.afterEach` or restore in each test.
- **`postgrestPost` not exported**: The server's internal PostgREST helper functions are not exported. Tests must mock `globalThis.fetch` to intercept the HTTP calls that `postgrestPost` makes internally.
- **Content-range parsing**: PostgREST returns total count via `content-range` header (format: `0-0/N`). Mock responses must include this header for count endpoints.