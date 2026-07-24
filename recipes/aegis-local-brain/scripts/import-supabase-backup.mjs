#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECIPE_DIR = path.resolve(SCRIPT_DIR, "..");

function loadEnvFile(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^['"]|['"]$/g, "");
  }
  return vars;
}

const envFile = loadEnvFile(path.join(RECIPE_DIR, ".env"));
const BRAIN_URL = (process.env.BRAIN_URL || envFile.BRAIN_URL || `http://127.0.0.1:${envFile.BRAIN_API_PORT || "8787"}`).replace(/\/$/, "");
const BRAIN_ACCESS_KEY = process.env.BRAIN_ACCESS_KEY || envFile.BRAIN_ACCESS_KEY || "";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const verify = args.includes("--verify");
const sideTablesOnly = args.includes("--side-tables-only");
export function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

const startAtSourceId = argValue("--start-at-source-id");
const inputArg = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--start-at-source-id");
const CAPTURE_MAX_ATTEMPTS = Number(process.env.CAPTURE_MAX_ATTEMPTS || "5");
export const SIDE_TABLES = [
  "entities",
  "edges",
  "thought_entities",
  "reflections",
  "ingestion_jobs",
  "ingestion_items",
  "agent_memories",
  "agent_memory_audit_events",
];

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain && !BRAIN_ACCESS_KEY && (!dryRun || verify)) {
  console.error("ERROR: BRAIN_ACCESS_KEY is required. Export it or run from the recipe with .env present.");
  process.exit(1);
}

export function newestBackupForTable(backupDir, tableName) {
  if (!backupDir || !fs.existsSync(backupDir) || !fs.statSync(backupDir).isDirectory()) return null;
  const pattern = new RegExp(`^${tableName}-.*\\.json$`);
  const candidates = fs.readdirSync(backupDir)
    .filter((name) => pattern.test(name))
    .sort();
  return candidates.length ? path.join(backupDir, candidates[candidates.length - 1]) : null;
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function newestManifest(backupDir) {
  if (!backupDir || !fs.existsSync(backupDir) || !fs.statSync(backupDir).isDirectory()) return null;
  const candidates = fs.readdirSync(backupDir)
    .filter((name) => /^manifest-.*\.json$/.test(name))
    .sort();
  return candidates.length ? path.join(backupDir, candidates[candidates.length - 1]) : null;
}

export function validateBackupManifest(backupDir) {
  const manifestPath = newestManifest(backupDir);
  if (!manifestPath) return null;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.ok !== true) {
    throw new Error(`backup manifest is not ok: ${path.basename(manifestPath)}`);
  }

  const entries = Array.isArray(manifest.tables) ? manifest.tables : [];
  for (const entry of entries) {
    if (!entry || !entry.file_name) continue;
    if (entry.ok === false) {
      throw new Error(`backup manifest table failed: ${entry.table || entry.file_name}`);
    }

    const filePath = path.join(backupDir, entry.file_name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`backup manifest file missing: ${entry.file_name}`);
    }

    if (entry.sha256) {
      const actual = sha256File(filePath);
      if (actual !== entry.sha256) {
        throw new Error(`backup manifest sha256 mismatch for ${entry.file_name}`);
      }
    }

    const stat = fs.statSync(filePath);
    if (entry.file_size != null && stat.size !== Number(entry.file_size)) {
      throw new Error(`backup manifest file_size mismatch for ${entry.file_name}`);
    }
  }

  return { manifestPath, manifest };
}

export function resolveBackupPath(inputPath) {
  if (!inputPath) return path.join(RECIPE_DIR, "../brain-backup/backup");
  if (path.isAbsolute(inputPath)) return inputPath;

  const cwdRelative = path.resolve(inputPath);
  if (fs.existsSync(cwdRelative)) return cwdRelative;

  const recipeRelative = path.resolve(RECIPE_DIR, inputPath);
  if (fs.existsSync(recipeRelative)) return recipeRelative;

  return cwdRelative;
}

export function resolveBackupInput(inputPath) {
  const resolved = resolveBackupPath(inputPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return { backupDir: path.dirname(resolved), thoughtsFile: resolved };
  }
  if (!fs.existsSync(resolved)) throw new Error(`backup path not found: ${resolved}`);
  const thoughtsFile = newestBackupForTable(resolved, "thoughts");
  if (!thoughtsFile) throw new Error(`no thoughts-*.json backup found in ${resolved}`);
  return { backupDir: resolved, thoughtsFile };
}

export function sourceMetadata(row) {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
  return {
    ...metadata,
    migrated_from: "open-brain-supabase-backup",
    source_id: row.id,
    source_created_at: row.created_at,
    source_updated_at: row.updated_at,
  };
}

export function contentFingerprint(content) {
  const normalized = String(content || "").replace(/\s+/g, " ").trim().toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function emptyImportPlan() {
  return {
    backup_rows: 0,
    importable_rows: 0,
    skipped_rows: 0,
    expected_unique_fingerprints: 0,
    duplicate_content_rows: 0,
    fingerprints: new Set(),
  };
}

export function addRowToImportPlan(plan, row) {
  plan.backup_rows += 1;
  if (!row || typeof row.content !== "string" || !row.content.trim()) {
    plan.skipped_rows += 1;
    return false;
  }
  plan.importable_rows += 1;
  const fingerprint = contentFingerprint(row.content);
  if (plan.fingerprints.has(fingerprint)) {
    plan.duplicate_content_rows += 1;
  } else {
    plan.fingerprints.add(fingerprint);
    plan.expected_unique_fingerprints = plan.fingerprints.size;
  }
  return true;
}

async function* streamThoughtRows(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 * 1024 });
  let rowText = "";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for await (const chunk of stream) {
    for (const char of chunk) {
      if (depth === 0) {
        if (char === "{") {
          rowText = char;
          depth = 1;
        }
        continue;
      }

      rowText += char;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          yield JSON.parse(rowText);
          rowText = "";
        }
      }
    }
  }

  if (depth !== 0) {
    throw new Error(`invalid thoughts backup JSON: unterminated object in ${filePath}`);
  }
}

async function* streamSelectedThoughtRows(filePath, { startAtSourceId = "" } = {}) {
  let started = !startAtSourceId;
  let found = false;
  for await (const row of streamThoughtRows(filePath)) {
    if (!started) {
      if (String(row?.id || "") !== startAtSourceId) continue;
      started = true;
      found = true;
    }
    yield row;
  }
  if (startAtSourceId && !found) {
    throw new Error(`resume source_id not found: ${startAtSourceId}`);
  }
}

async function buildImportPlan(thoughtsFile, options = {}) {
  const plan = emptyImportPlan();
  for await (const row of streamSelectedThoughtRows(thoughtsFile, options)) {
    addRowToImportPlan(plan, row);
  }
  return plan;
}

async function capture(row) {
  const response = await fetch(`${BRAIN_URL}/functions/v1/capture`, {
    method: "POST",
    headers: {
      "x-brain-key": BRAIN_ACCESS_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content: row.content,
      metadata: sourceMetadata(row),
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`capture failed for ${row.id}: ${response.status} ${body}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableCaptureError(error) {
  return /\b(500|502|503|504)\b|fetch failed|ECONNRESET|ETIMEDOUT|EPIPE/i.test(error?.message || "");
}

async function captureWithRetry(row) {
  let lastError = null;
  for (let attempt = 1; attempt <= CAPTURE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await capture(row);
    } catch (error) {
      lastError = error;
      if (attempt >= CAPTURE_MAX_ATTEMPTS || !retryableCaptureError(error)) break;
      const delayMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      process.stderr.write(`capture attempt ${attempt} failed for ${row.id}; retrying in ${delayMs}ms: ${error.message}\n`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function fetchJson(pathname) {
  const response = await fetch(`${BRAIN_URL}${pathname}`, {
    headers: {
      "x-brain-key": BRAIN_ACCESS_KEY,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`verification request failed: ${response.status} ${body}`.trim());
  }
  return response.json();
}

async function postJson(pathname, body) {
  const response = await fetch(`${BRAIN_URL}${pathname}`, {
    method: "POST",
    headers: {
      "x-brain-key": BRAIN_ACCESS_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new Error(`archive request failed: ${response.status} ${responseBody}`.trim());
  }
  return response.json();
}

async function verifyImport(plan) {
  const result = await fetchJson("/count?migrated_from=open-brain-supabase-backup");
  const importedCount = Number(result.imported_count ?? result.filtered_count ?? result.count ?? 0);
  console.log(`Verify imported_count: ${importedCount}`);
  console.log(`Verify expected_unique_fingerprints: ${plan.expected_unique_fingerprints}`);
  if (importedCount < plan.expected_unique_fingerprints) {
    throw new Error(
      `import verification failed: imported_count=${importedCount} expected_unique_fingerprints=${plan.expected_unique_fingerprints}`
    );
  }
  return { ...result, imported_count: importedCount };
}

async function archiveSideTables(backupDir) {
  const results = [];
  for (const table of SIDE_TABLES) {
    const filePath = newestBackupForTable(backupDir, table);
    if (!filePath) {
      results.push({ table, backup_file: null, row_count: 0, archived_count: 0, missing: true });
      console.log(`Archive ${table}: no backup file found`);
      continue;
    }
    const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const rowCount = Array.isArray(rows) ? rows.length : 0;
    console.log(`Archive ${table}: ${rowCount} rows`);
    if (dryRun) {
      results.push({ table, backup_file: path.basename(filePath), row_count: rowCount, archived_count: 0, dry_run: true });
      continue;
    }
    const result = await postJson("/backup/archive", {
      table,
      rows: Array.isArray(rows) ? rows : [],
      backup_file: path.basename(filePath),
    });
    results.push({
      table,
      backup_file: path.basename(filePath),
      row_count: rowCount,
      archived_count: result.archived_count || 0,
      promoted_count: result.promoted_count || 0,
    });
    console.log(`  archived ${result.archived_count || 0}/${rowCount}; promoted ${result.promoted_count || 0}/${rowCount}`);
  }
  return results;
}

async function verifyArchivedTables(results) {
  for (const result of results) {
    if (result.missing || result.dry_run) continue;
    const count = await fetchJson(`/backup/archive/count?table=${encodeURIComponent(result.table)}`);
    console.log(`Verify archive ${result.table}: ${count.count}`);
    if (Number(count.count || 0) < result.row_count) {
      throw new Error(`archive verification failed for ${result.table}: count=${count.count} expected=${result.row_count}`);
    }
  }
}

async function verifyFirstClassSideTables(results) {
  for (const result of results) {
    if (result.missing || result.dry_run) continue;
    const count = await fetchJson(`/backup/first-class/count?table=${encodeURIComponent(result.table)}`);
    const firstClassCount = Number(count.count || count.first_class_count || 0);
    console.log(`Verify first-class ${result.table}: ${firstClassCount}`);
    if (firstClassCount < result.row_count) {
      throw new Error(`first-class promotion verification failed for ${result.table}: first_class_count=${firstClassCount} expected=${result.row_count}`);
    }
  }
}

async function importThoughtRows(thoughtsFile, plan, options = {}) {
  let ok = 0;
  for await (const row of streamSelectedThoughtRows(thoughtsFile, options)) {
    if (!row || typeof row.content !== "string" || !row.content.trim()) continue;
    await captureWithRetry(row);
    ok += 1;
    if (ok % 50 === 0 || ok === plan.importable_rows) {
      process.stdout.write(`  captured ${ok}/${plan.importable_rows}\r`);
    }
  }
  process.stdout.write(`  captured ${ok}/${plan.importable_rows}\n`);
  return ok;
}

async function main() {
  const input = resolveBackupInput(inputArg);
  const manifestResult = validateBackupManifest(input.backupDir);
  if (manifestResult) {
    console.log(`Manifest: ${path.basename(manifestResult.manifestPath)} verified`);
  }
  const plan = await buildImportPlan(input.thoughtsFile, { startAtSourceId });
  const verifyPlan = verify && startAtSourceId ? await buildImportPlan(input.thoughtsFile) : plan;

  console.log(`Import source: ${input.thoughtsFile}`);
  if (startAtSourceId) console.log(`Resume source_id: ${startAtSourceId}`);
  console.log(`Backup rows:    ${plan.backup_rows}`);
  console.log(`Thought rows:   ${plan.importable_rows}`);
  console.log(`Skipped rows:   ${plan.skipped_rows}`);
  console.log(`expected_unique_fingerprints: ${plan.expected_unique_fingerprints}`);
  console.log(`duplicate_content_rows:       ${plan.duplicate_content_rows}`);
  console.log(`Target:         ${BRAIN_URL}`);
  const archiveResults = await archiveSideTables(input.backupDir);
  if (sideTablesOnly) {
    console.log("Side tables only: no thought rows captured.");
    if (verify) {
      await verifyArchivedTables(archiveResults);
      await verifyFirstClassSideTables(archiveResults);
    }
    return;
  }
  if (dryRun) {
    console.log("Dry run: no rows captured.");
    if (verify) await verifyImport(plan);
    return;
  }

  await importThoughtRows(input.thoughtsFile, plan, { startAtSourceId });
  if (verify) {
    await verifyImport(verifyPlan);
    await verifyArchivedTables(archiveResults);
    await verifyFirstClassSideTables(archiveResults);
  }
}

if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
