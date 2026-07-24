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