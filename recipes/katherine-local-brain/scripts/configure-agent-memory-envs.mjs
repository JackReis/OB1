#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import os from "node:os";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECIPE_DIR = path.resolve(SCRIPT_DIR, "..");

function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(1));
  return p;
}

const DEFAULT_ENV_FILES = [
  "~/.hermes/.env",
  "~/.hermes/profiles/aegis/.env",
];

function usage() {
  return `Usage: configure-agent-memory-envs.mjs [options]

Options:
  --dry-run                    Show redacted changes without writing.
  --brain-env PATH             Source BRAIN_ACCESS_KEY/BRAIN_API_PORT from PATH.
  --env-file PATH              Target env file. May be repeated.
  --endpoint URL               Agent Memory endpoint.
  --workspace-id ID            OPENBRAIN_WORKSPACE_ID value.
  --project-id ID              OPENBRAIN_PROJECT_ID value.
  --workspace-mode MODE        OPENBRAIN_WORKSPACE_MODE value.
  --workspace-prefix PREFIX    OPENBRAIN_WORKSPACE_PREFIX value.
  --no-backup                  Do not create .bak-* files before writing.
`;
}

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    backup: true,
    brainEnv: path.join(RECIPE_DIR, ".env"),
    envFiles: [],
    endpoint: "",
    workspaceId: process.env.OPENBRAIN_WORKSPACE_ID || "aegis-local",
    projectId: process.env.OPENBRAIN_PROJECT_ID || "",
    workspaceMode: process.env.OPENBRAIN_WORKSPACE_MODE || "per-agent",
    workspacePrefix: process.env.OPENBRAIN_WORKSPACE_PREFIX || "aegis-",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--no-backup") {
      parsed.backup = false;
    } else if (arg === "--brain-env") {
      parsed.brainEnv = next();
    } else if (arg === "--env-file") {
      parsed.envFiles.push(next());
    } else if (arg === "--endpoint") {
      parsed.endpoint = next();
    } else if (arg === "--workspace-id") {
      parsed.workspaceId = next();
    } else if (arg === "--project-id") {
      parsed.projectId = next();
    } else if (arg === "--workspace-mode") {
      parsed.workspaceMode = next();
    } else if (arg === "--workspace-prefix") {
      parsed.workspacePrefix = next();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (parsed.envFiles.length === 0) parsed.envFiles = [...DEFAULT_ENV_FILES];
  return parsed;
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

function parseEnv(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
    vars[key] = value;
  }
  return vars;
}

function rejectUnsafeValue(key, value) {
  if (String(value).includes("\n") || String(value).includes("\r")) {
    throw new Error(`${key} must not contain newlines`);
  }
}

function envLine(key, value) {
  rejectUnsafeValue(key, value);
  return `${key}=${value}`;
}

function updateEnvText(existing, updates) {
  const keys = new Set(Object.keys(updates));
  const seen = new Set();
  const lines = existing ? existing.split(/\r?\n/) : [];
  const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === "";
  const body = trailingEmpty ? lines.slice(0, -1) : lines;
  const nextLines = [];

  for (const line of body) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !keys.has(match[1])) {
      nextLines.push(line);
      continue;
    }
    const key = match[1];
    if (!seen.has(key)) {
      nextLines.push(envLine(key, updates[key]));
      seen.add(key);
    }
  }

  const missing = Object.keys(updates).filter((key) => !seen.has(key));
  if (missing.length > 0) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") nextLines.push("");
    nextLines.push("# Local Aegis OB1 Agent Memory");
    for (const key of missing) nextLines.push(envLine(key, updates[key]));
  }

  return `${nextLines.join("\n")}\n`;
}

function backupFile(target) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${target}.bak-${stamp}-${process.pid}`;
}

function redactedValue(key, value) {
  return /(KEY|TOKEN|SECRET|PASSWORD)/.test(key) ? "<redacted>" : value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const brainVars = parseEnv(readIfExists(args.brainEnv));
  const accessKey = process.env.BRAIN_ACCESS_KEY || brainVars.BRAIN_ACCESS_KEY || "";
  if (!accessKey) throw new Error(`BRAIN_ACCESS_KEY not found in environment or ${args.brainEnv}`);

  const apiPort = process.env.BRAIN_API_PORT || brainVars.BRAIN_API_PORT || "8787";
  const endpoint = (args.endpoint || process.env.AEGIS_AGENT_MEMORY_ENDPOINT || `http://127.0.0.1:${apiPort}/agent-memory-api`).replace(/\/+$/, "");
  const updates = {
    OPENBRAIN_URL: endpoint,
    OPENBRAIN_KEY: accessKey,
    OPENBRAIN_WORKSPACE_ID: args.workspaceId,
    OPENBRAIN_WORKSPACE_MODE: args.workspaceMode,
    OPENBRAIN_WORKSPACE_PREFIX: args.workspacePrefix,
  };
  if (args.projectId) updates.OPENBRAIN_PROJECT_ID = args.projectId;

  let updated = 0;
  console.log("Agent Memory env configuration");
  console.log(`dry_run=${args.dryRun ? "true" : "false"}`);
  for (const [key, value] of Object.entries(updates)) {
    console.log(`${key}=${redactedValue(key, value)}`);
  }

  for (const target of args.envFiles) {
    const resolved = expandHome(path.resolve(target));
    const before = readIfExists(resolved);
    const after = updateEnvText(before, updates);
    const changed = before !== after;
    const backupPath = changed && args.backup && before ? backupFile(resolved) : "";
    if (changed) updated += 1;

    console.log(`target=${resolved} changed=${changed ? "true" : "false"} backup=${backupPath ? path.basename(backupPath) : "none"}`);

    if (!args.dryRun && changed) {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      if (backupPath) {
        fs.copyFileSync(resolved, backupPath);
        fs.chmodSync(backupPath, 0o600);
      }
      fs.writeFileSync(resolved, after, { mode: 0o600 });
      fs.chmodSync(resolved, 0o600);
    } else if (!args.dryRun && !fs.existsSync(resolved)) {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, after, { mode: 0o600 });
      fs.chmodSync(resolved, 0o600);
    }
  }

  console.log(`updated=${updated}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
