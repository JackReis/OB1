#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECIPE_DIR = path.resolve(SCRIPT_DIR, "..");
const OB1_ROOT = path.resolve(RECIPE_DIR, "../..");

const args = process.argv.slice(2);
const FLAG_JSON = args.includes("--json");
const LOCAL_API_URL = (process.env.AEGIS_LOCAL_BRAIN_URL || process.env.BRAIN_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const LOCAL_ENV_FILE = process.env.AEGIS_LOCAL_BRAIN_ENV || path.join(RECIPE_DIR, ".env");
const BRAIN_BACKUP_SCRIPT = path.resolve(process.env.BRAIN_BACKUP_SCRIPT || path.join(OB1_ROOT, "recipes/brain-backup/backup-brain.mjs"));
const BACKUP_DIR = process.env.BRAIN_BACKUP_DIR || path.join(OB1_ROOT, "recipes/brain-backup/backup");
const DASHBOARD_NEXT_ENV = process.env.DASHBOARD_NEXT_ENV || path.join(OB1_ROOT, "dashboards/open-brain-dashboard-next/.env.local");
const DASHBOARD_PRO_ENV = process.env.DASHBOARD_PRO_ENV || path.join(OB1_ROOT, "dashboards/open-brain-dashboard-pro/.env.local");
const HERMES_BRIDGE = process.env.HERMES_OPENBRAIN_BRIDGE || "/Users/hermes/.hermes/bin/openbrain-mcp-bridge.py";
const HERMES_WRAPPER = process.env.HERMES_OPENBRAIN_WRAPPER || "/Users/hermes/.hermes/bin/openbrain-mcp-wrapper.sh";
const CODEX_RULES_FILE = process.env.CODEX_RULES_FILE || "/Users/hermes/.codex/rules/default.rules";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "/Users/hermes/.hermes/node/bin/claude";
const CLAUDE_SETTINGS_FILE = process.env.CLAUDE_SETTINGS_FILE || "/Users/hermes/.claude/settings.json";
const CLAUDE_OB1_HOOK = process.env.CLAUDE_OB1_HOOK || "/Users/hermes/.claude/hooks/openbrain-turn-sync.py";
const KIMI_BIN = process.env.KIMI_BIN || "/Users/hermes/.kimi-code/bin/kimi";
const KIMI_AEGIS_BIN = process.env.KIMI_AEGIS_BIN || "/Users/hermes/.kimi-code/bin/kimi-aegis-ollama";
const ANTIGRAVITY_BIN = process.env.ANTIGRAVITY_BIN || "/Users/hermes/homebrew/bin/agy";
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "/Applications/Kimi.app/Contents/Resources/resources/gateway/node_modules/.bin/openclaw";
const OPENCLAW_PROFILE = process.env.OPENCLAW_PROFILE || "ob1-agent-memory";
const OPENCLAW_PLUGIN_ID = process.env.OPENCLAW_PLUGIN_ID || "nbj-ob1-agent-memory";
const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || "main";
const HOSTED_OPEN_BRAIN_HOST = "jhpuctiyosazlyrcnfuu.supabase.co";
const OPENBRAIN_PLUGIN_TOOLS = [
  "openbrain_recall",
  "openbrain_writeback",
  "openbrain_report_usage",
  "openbrain_inspect_memory",
  "openbrain_list_review_queue",
  "openbrain_review_memory",
  "openbrain_get_recall_trace",
];
const DEFAULT_AGENT_SPAWN_PATHS = [
  "/Users/hermes/.hermes/.env",
  "/Users/hermes/.hermes/config.yaml",
  "/Users/hermes/.hermes/plugins/ob1/__init__.py",
  "/Users/hermes/.hermes/plugins/ob1/plugin.yaml",
  "/Users/hermes/.hermes/profiles/aegis/.env",
  "/Users/hermes/.hermes/profiles/aegis/config.yaml",
  "/Users/hermes/.hermes/profiles/aegis/plugins/ob1/__init__.py",
  "/Users/hermes/.hermes/profiles/aegis/plugins/ob1/plugin.yaml",
  "/Users/hermes/.hermes/bin/openbrain-mcp-wrapper.sh",
  "/Users/hermes/.hermes/bin/openbrain-mcp-bridge.py",
  "/Users/hermes/.hermes/fleet/aegis-alignment.sh",
  "/Users/hermes/Library/LaunchAgents/ai.hermes.gateway.plist",
  "/Users/hermes/Library/LaunchAgents/ai.hermes.gateway-aegis.plist",
  "/Users/hermes/Library/LaunchAgents/ai.fleet.alignment-aegis.plist",
  "/Users/hermes/Library/LaunchAgents/com.echospringsdev.paperclip-bridge.plist",
  "/Users/hermes/.paperclip/instances/default/.env",
  "/Users/hermes/.paperclip/instances/default/config.json",
  "/Users/hermes/.codex/rules/default.rules",
  "/Users/hermes/.codex/superpowers/skills/ob1-lifecycle/SKILL.md",
  "/Users/hermes/.hermes/skills/note-taking/ob1-lifecycle/SKILL.md",
  "/Users/hermes/.hermes/skills/note-taking/ob1-lifecycle/references/ob1-mcp-api.md",
  "/Users/hermes/.hermes/skills/note-taking/ob1-personalization-checklist/SKILL.md",
  "/Users/hermes/.hermes/skills/devops/repair-openbrain-mcp/SKILL.md",
];

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function parseEnvFile(filePath) {
  const text = readIfExists(filePath);
  const vars = {};
  if (!text) return vars;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
  }
  return vars;
}

function fileMode(filePath) {
  try {
    return `0${(fs.statSync(filePath).mode & 0o777).toString(8)}`;
  } catch {
    return null;
  }
}

function hasHostedRefs(text) {
  if (!text) return false;
  return /supabase\.co|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|jhpuctiyosazlyrcnfuu/i.test(text);
}

function hasHostedRuntimeRef(text) {
  if (!text) return false;
  return new RegExp(HOSTED_OPEN_BRAIN_HOST.replace(/\./g, "\\."), "i").test(text)
    || /https?:\/\/[^"'\s]+\.supabase\.co\/functions\/v1\/(?:open-brain-mcp|open-brain-rest|agent-memory-api|ingest-thought)/i.test(text)
    || /SUPABASE_(?:URL|SERVICE_ROLE_KEY)\s*=/.test(text);
}

function configuredAgentSpawnPaths() {
  const override = process.env.AEGIS_AGENT_SPAWN_PATHS;
  const rawPaths = override ? override.split(path.delimiter) : DEFAULT_AGENT_SPAWN_PATHS;
  return [...new Set(rawPaths.map((entry) => entry.trim()).filter(Boolean))];
}

function runCommand(command, args, options = {}) {
  if (!fs.existsSync(command)) {
    return { ok: false, status: null, stdout: "", stderr: "", missing: true };
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd || RECIPE_DIR,
    encoding: "utf8",
    timeout: options.timeout || 5000,
    maxBuffer: options.maxBuffer || 1024 * 1024,
    env: process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    missing: false,
    timed_out: result.error?.code === "ETIMEDOUT",
    error: result.error?.message || null,
  };
}

function parseJsonPayload(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function commandSummary(command, result) {
  return {
    path: command,
    exists: !result.missing,
    exit_code: result.status,
    timed_out: result.timed_out === true,
  };
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, error: text.slice(0, 160) };
    }
    try {
      return { ok: true, status: response.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: response.status, error: "response was not JSON" };
    }
  } catch (err) {
    return { ok: false, status: null, error: err?.name === "AbortError" ? "timeout" : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkLocalApi() {
  const result = await fetchJson(`${LOCAL_API_URL}/health`);
  const body = result.body || {};
  return {
    ok: Boolean(result.ok && body.ok === true && body.status === "ok"),
    url: `${LOCAL_API_URL}/health`,
    status: result.status,
    service: body.service || null,
    embedding_model: body.embedding_model || null,
    embedding_dim: body.embedding_dim || null,
    error: result.error || null,
  };
}

function runBackupPreflight() {
  const result = spawnSync(process.execPath, [BRAIN_BACKUP_SCRIPT, "--preflight", "--json"], {
    cwd: path.dirname(BRAIN_BACKUP_SCRIPT),
    env: process.env,
    encoding: "utf8",
  });
  let body = null;
  try {
    body = JSON.parse(result.stdout || "{}");
  } catch {
    body = null;
  }
  return {
    ok: result.status === 0 && body?.ok === true,
    exit_code: result.status,
    hosted_request_attempted: body?.checks?.hosted_request_attempted === true,
    env_file_present: body?.checks?.env_file_present === true,
    has_supabase_url: body?.checks?.has_supabase_url === true,
    has_service_role_key: body?.checks?.has_service_role_key === true,
    backup_parent_writable: body?.checks?.backup_parent_writable === true,
    supabase_host: body?.supabase_host || null,
    missing: Array.isArray(body?.missing) ? body.missing : ["preflight_json_unavailable"],
    stderr_present: Boolean(result.stderr),
  };
}

function newestManifest() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const candidates = fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^manifest-.*\.json$/.test(name))
    .sort();
  return candidates.length ? path.join(BACKUP_DIR, candidates[candidates.length - 1]) : null;
}

function checkBackupManifest() {
  const manifestPath = newestManifest();
  if (!manifestPath) {
    return { ok: false, present: false, path: null, date: null, total_rows: 0, thought_rows: 0 };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const thoughts = Array.isArray(manifest.tables)
    ? manifest.tables.find((entry) => entry?.table === "thoughts")
    : null;
  return {
    ok: manifest.ok === true,
    present: true,
    path: manifestPath,
    date: manifest.date || null,
    total_rows: Number(manifest.total_rows || 0),
    thought_rows: Number(thoughts?.row_count || 0),
    failure_count: Number(manifest.failure_count || 0),
  };
}

function localAccessKey() {
  const localEnv = parseEnvFile(LOCAL_ENV_FILE);
  return process.env.BRAIN_ACCESS_KEY || localEnv.BRAIN_ACCESS_KEY || "";
}

async function checkLocalDatabaseCount(localApiHealth) {
  const accessKey = localAccessKey();
  if (!localApiHealth.ok) {
    return { ok: false, count: 0, skipped: true, reason: "local API health failed" };
  }
  if (!accessKey) {
    return { ok: false, count: 0, skipped: true, reason: "BRAIN_ACCESS_KEY unavailable" };
  }
  const result = await fetchJson(`${LOCAL_API_URL}/count`, {
    "x-brain-key": accessKey,
    accept: "application/json",
  });
  const body = result.body || {};
  const count = Number(body.count ?? body.total ?? body.total_thoughts ?? 0);
  return {
    ok: result.ok,
    count,
    status: result.status,
    error: result.error || null,
  };
}

async function checkImportedBackupCount(localApiHealth, localDatabaseCount) {
  const accessKey = localAccessKey();
  if (!localApiHealth.ok) {
    return { ok: false, count: 0, skipped: true, reason: "local API health failed" };
  }
  if (!localDatabaseCount.ok) {
    return { ok: false, count: 0, skipped: true, reason: "local database count failed" };
  }
  if (!accessKey) {
    return { ok: false, count: 0, skipped: true, reason: "BRAIN_ACCESS_KEY unavailable" };
  }
  const result = await fetchJson(`${LOCAL_API_URL}/count?migrated_from=open-brain-supabase-backup`, {
    "x-brain-key": accessKey,
    accept: "application/json",
  });
  const body = result.body || {};
  const count = Number(body.imported_count ?? body.filtered_count ?? body.count ?? 0);
  return {
    ok: result.ok,
    count,
    status: result.status,
    error: result.error || null,
  };
}

async function checkFirstClassSideTables(localApiHealth, localDatabaseCount) {
  const accessKey = localAccessKey();
  if (!localApiHealth.ok) {
    return { ok: false, skipped: true, reason: "local API health failed", counts: {} };
  }
  if (!localDatabaseCount.ok) {
    return { ok: false, skipped: true, reason: "local database count failed", counts: {} };
  }
  if (!accessKey) {
    return { ok: false, skipped: true, reason: "BRAIN_ACCESS_KEY unavailable", counts: {} };
  }
  const requiredTables = ["agent_memories", "agent_memory_audit_events"];
  const counts = {};
  const errors = {};
  for (const table of requiredTables) {
    const result = await fetchJson(`${LOCAL_API_URL}/backup/first-class/count?table=${encodeURIComponent(table)}`, {
      "x-brain-key": accessKey,
      accept: "application/json",
    });
    const body = result.body || {};
    counts[table] = Number(body.first_class_count ?? body.count ?? 0);
    if (!result.ok) errors[table] = result.error || `status ${result.status}`;
  }
  return {
    ok: Object.keys(errors).length === 0 && requiredTables.every((table) => counts[table] > 0),
    required_tables: requiredTables,
    counts,
    errors,
  };
}

function checkDashboardEnv(label, filePath, requiredKeys) {
  const text = readIfExists(filePath);
  const vars = parseEnvFile(filePath);
  return {
    label,
    path: filePath,
    exists: text != null,
    mode: fileMode(filePath),
    points_local: requiredKeys.every((key) => vars[key] === LOCAL_API_URL),
    hosted_refs_present: hasHostedRefs(text),
    stores_access_key: /BRAIN_ACCESS_KEY|MCP_ACCESS_KEY|SUPABASE_SERVICE_ROLE_KEY/.test(text || ""),
  };
}

function checkHermesBridge() {
  const bridge = readIfExists(HERMES_BRIDGE);
  const wrapper = readIfExists(HERMES_WRAPPER);
  const localMcpUrl = `${LOCAL_API_URL}/functions/v1/open-brain-mcp`;
  return {
    bridge_path: HERMES_BRIDGE,
    wrapper_path: HERMES_WRAPPER,
    bridge_exists: bridge != null,
    wrapper_exists: wrapper != null,
    points_local: Boolean((bridge || "").includes(localMcpUrl) || (wrapper || "").includes(localMcpUrl)),
    hosted_refs_present: hasHostedRuntimeRef(bridge) || hasHostedRuntimeRef(wrapper),
    bridge_mode: fileMode(HERMES_BRIDGE),
    wrapper_mode: fileMode(HERMES_WRAPPER),
  };
}

function checkCodexRules() {
  const text = readIfExists(CODEX_RULES_FILE);
  return {
    path: CODEX_RULES_FILE,
    exists: text != null,
    hosted_open_brain_allowed: Boolean((text || "").includes(HOSTED_OPEN_BRAIN_HOST)),
    local_wrapper_allowed: Boolean((text || "").includes(HERMES_WRAPPER)),
  };
}

function checkAgentSpawnPaths() {
  const paths = configuredAgentSpawnPaths();
  const checked = [];
  const missing = [];
  const hostedRefPaths = [];

  for (const filePath of paths) {
    const text = readIfExists(filePath);
    if (text == null) {
      missing.push(filePath);
      continue;
    }
    checked.push(filePath);
    if (hasHostedRuntimeRef(text)) hostedRefPaths.push(filePath);
  }

  return {
    ok: hostedRefPaths.length === 0,
    checked_count: checked.length,
    configured_count: paths.length,
    missing_count: missing.length,
    hosted_refs_present: hostedRefPaths.length > 0,
    hosted_ref_paths: hostedRefPaths,
    missing_paths: missing,
  };
}

function checkClaudeCodeSpawnRuntime() {
  const help = runCommand(CLAUDE_BIN, ["--help"]);
  const output = `${help.stdout}\n${help.stderr}`;
  const hasPrintMode = /(?:^|\s)-p,\s*--print|--print/.test(output);
  const hasAgents = /\bagents\b/.test(output);
  const settingsText = readIfExists(CLAUDE_SETTINGS_FILE);
  const hookText = readIfExists(CLAUDE_OB1_HOOK);
  let settings = null;
  try {
    settings = settingsText ? JSON.parse(settingsText) : null;
  } catch {
    settings = null;
  }
  const hookEvents = ["UserPromptSubmit", "Stop", "SubagentStop"];
  const configuredEvents = hookEvents.filter((event) => {
    const entries = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [];
    return entries.some((entry) => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      return hooks.some((hook) => String(hook?.command || "").includes(CLAUDE_OB1_HOOK));
    });
  });
  const hookScriptReady = hookText != null
    && hookText.includes(`${LOCAL_API_URL}/agent-memory-api`)
    && hookText.includes("openbrain.agent_memory.writeback.v1")
    && !hasHostedRuntimeRef(hookText);
  const ob1HookConfigured = configuredEvents.length === hookEvents.length && hookScriptReady;
  return {
    ready: help.ok && hasPrintMode && hasAgents && ob1HookConfigured,
    command: commandSummary(CLAUDE_BIN, help),
    print_mode_available: hasPrintMode,
    background_agents_available: hasAgents,
    settings_path: CLAUDE_SETTINGS_FILE,
    ob1_hook_path: CLAUDE_OB1_HOOK,
    ob1_hook_configured: ob1HookConfigured,
    ob1_hook_script_ready: hookScriptReady,
    ob1_hook_events: configuredEvents,
  };
}

function checkKimiCodeSpawnRuntime() {
  const doctor = runCommand(KIMI_BIN, ["doctor"]);
  const providers = runCommand(KIMI_BIN, ["provider", "list"]);
  const providerOutput = `${providers.stdout}\n${providers.stderr}`;
  const providersConfigured = providers.ok && !/No providers configured/i.test(providerOutput) && providerOutput.trim().length > 0;
  const wrapperText = readIfExists(KIMI_AEGIS_BIN);
  const wrapperMode = fileMode(KIMI_AEGIS_BIN);
  const localOllamaWrapperReady = wrapperText != null
    && /^07/.test(wrapperMode || "")
    && /KIMI_MODEL_PROVIDER_TYPE=openai/.test(wrapperText)
    && /KIMI_MODEL_BASE_URL=http:\/\/127\.0\.0\.1:11434\/v1/.test(wrapperText)
    && /KIMI_MODEL_API_KEY=ollama-local-dummy/.test(wrapperText)
    && /KIMI_MODEL_NAME=/.test(wrapperText)
    && !hasHostedRuntimeRef(wrapperText);
  return {
    ready: doctor.ok && (providersConfigured || localOllamaWrapperReady),
    command: commandSummary(KIMI_BIN, doctor),
    config_valid: doctor.ok,
    providers_configured: providersConfigured,
    local_ollama_wrapper_path: KIMI_AEGIS_BIN,
    local_ollama_wrapper_ready: localOllamaWrapperReady,
    local_ollama_wrapper_mode: wrapperMode,
    provider_list_exit_code: providers.status,
  };
}

function checkAntigravitySpawnRuntime() {
  const help = runCommand(ANTIGRAVITY_BIN, ["--help"]);
  const output = `${help.stdout}\n${help.stderr}`;
  const hasPrintMode = /(?:^|\s)-p,\s*--print|--print/.test(output);
  const hasPrintTimeout = /--print-timeout/.test(output);
  return {
    ready: help.ok && hasPrintMode,
    command: commandSummary(ANTIGRAVITY_BIN, help),
    print_mode_available: hasPrintMode,
    print_timeout_available: hasPrintTimeout,
  };
}

function checkOpenClawSpawnRuntime() {
  const baseArgs = ["--profile", OPENCLAW_PROFILE];
  const plugin = runCommand(OPENCLAW_BIN, [...baseArgs, "plugins", "info", OPENCLAW_PLUGIN_ID]);
  const agents = runCommand(OPENCLAW_BIN, [...baseArgs, "agents", "list"]);
  const models = runCommand(OPENCLAW_BIN, [...baseArgs, "models", "status", "--json"]);
  const status = runCommand(OPENCLAW_BIN, [...baseArgs, "status", "--json", "--timeout", "2500"], { timeout: 8000 });
  const agentHelp = runCommand(OPENCLAW_BIN, [...baseArgs, "agent", "--help"]);
  const pluginOutput = `${plugin.stdout}\n${plugin.stderr}`;
  const agentsOutput = `${agents.stdout}\n${agents.stderr}`;
  const agentHelpOutput = `${agentHelp.stdout}\n${agentHelp.stderr}`;
  const modelsJson = parseJsonPayload(`${models.stdout}\n${models.stderr}`);
  const statusJson = parseJsonPayload(`${status.stdout}\n${status.stderr}`);
  const missingProviders = Array.isArray(modelsJson?.auth?.missingProvidersInUse)
    ? modelsJson.auth.missingProvidersInUse
    : [];
  const providersInUse = modelsJson?.resolvedDefault ? [String(modelsJson.resolvedDefault).split("/")[0]] : [];
  const pluginLoaded = plugin.ok && /Status:\s*loaded/i.test(pluginOutput);
  const toolsRegistered = OPENBRAIN_PLUGIN_TOOLS.every((tool) => pluginOutput.includes(tool));
  const mainAgentPresent = new RegExp(`(^|\\n)-\\s+${OPENCLAW_AGENT_ID}\\b|["']?id["']?\\s*:\\s*["']${OPENCLAW_AGENT_ID}["']`).test(agentsOutput);
  const providerAuthAvailable = models.ok && missingProviders.length === 0 && modelsJson != null;
  const gatewayReachable = statusJson?.gateway?.reachable === true;
  const localAgentModeAvailable = agentHelp.ok && /--local\b/.test(agentHelpOutput);
  return {
    ready: pluginLoaded && toolsRegistered && mainAgentPresent && providerAuthAvailable && (gatewayReachable || localAgentModeAvailable),
    command: commandSummary(OPENCLAW_BIN, plugin),
    profile: OPENCLAW_PROFILE,
    agent_id: OPENCLAW_AGENT_ID,
    plugin_loaded: pluginLoaded,
    tools_registered: toolsRegistered,
    main_agent_present: mainAgentPresent,
    model_status_exit_code: models.status,
    default_model: modelsJson?.resolvedDefault || modelsJson?.defaultModel || null,
    providers_in_use: providersInUse,
    missing_provider_count: missingProviders.length,
    provider_auth_available: providerAuthAvailable,
    local_agent_mode_available: localAgentModeAvailable,
    gateway_status_exit_code: status.status,
    gateway_reachable: gatewayReachable,
    gateway_url: statusJson?.gateway?.url || null,
    gateway_service_installed: statusJson?.gatewayService?.installed === true,
  };
}

function checkAgentSpawnRuntime() {
  const claudeCode = checkClaudeCodeSpawnRuntime();
  const kimiCode = checkKimiCodeSpawnRuntime();
  const antigravity = checkAntigravitySpawnRuntime();
  const openclaw = checkOpenClawSpawnRuntime();
  const blockers = [];
  addBlocker(blockers, !claudeCode.ready, "Claude Code CLI is not ready for non-interactive agent dispatch");
  addBlocker(blockers, !kimiCode.ready, "Kimi Code has no configured provider/default model");
  addBlocker(blockers, !antigravity.ready, "Antigravity CLI print mode is not ready");
  addBlocker(blockers, !openclaw.plugin_loaded || !openclaw.tools_registered || !openclaw.main_agent_present, "OpenClaw OB1 plugin or main agent is not fully registered");
  addBlocker(blockers, !openclaw.provider_auth_available, "OpenClaw isolated agent provider auth is missing");
  addBlocker(blockers, !openclaw.gateway_reachable && !openclaw.local_agent_mode_available, "OpenClaw gateway is not reachable");
  return {
    ok: blockers.length === 0,
    blockers,
    claude_code: claudeCode,
    kimi_code: kimiCode,
    antigravity,
    openclaw,
  };
}

function addBlocker(blockers, condition, message) {
  if (condition) blockers.push(message);
}

async function main() {
  const localApiHealth = await checkLocalApi();
  const backupPreflight = runBackupPreflight();
  const backupManifest = checkBackupManifest();
  const localDatabaseCount = await checkLocalDatabaseCount(localApiHealth);
  const importedBackupCount = await checkImportedBackupCount(localApiHealth, localDatabaseCount);
  const firstClassSideTables = await checkFirstClassSideTables(localApiHealth, localDatabaseCount);
  const dashboardEnvs = [
    checkDashboardEnv("open-brain-dashboard-next", DASHBOARD_NEXT_ENV, ["NEXT_PUBLIC_API_URL", "AGENT_MEMORY_API_URL"]),
    checkDashboardEnv("open-brain-dashboard-pro", DASHBOARD_PRO_ENV, ["NEXT_PUBLIC_API_URL"]),
  ];
  const hermesBridge = checkHermesBridge();
  const codexRules = checkCodexRules();
  const agentSpawnPaths = checkAgentSpawnPaths();
  const agentSpawnRuntime = checkAgentSpawnRuntime();

  const blockers = [];
  addBlocker(blockers, !localApiHealth.ok, "local API health failed");
  addBlocker(blockers, !localDatabaseCount.ok, "local database count failed");
  addBlocker(blockers, !backupPreflight.ok, "hosted backup preflight not ready");
  addBlocker(blockers, backupPreflight.hosted_request_attempted, "backup preflight attempted hosted request");
  addBlocker(blockers, !backupManifest.ok, "hosted backup manifest missing or incomplete");
  addBlocker(blockers, !importedBackupCount.ok || importedBackupCount.count <= 0, "imported hosted thoughts not verified");
  addBlocker(blockers, !firstClassSideTables.ok, "first-class Agent Memory side tables not verified");
  addBlocker(blockers, dashboardEnvs.some((item) => !item.exists || !item.points_local || item.hosted_refs_present || item.stores_access_key), "dashboard env repointing incomplete");
  addBlocker(blockers, !hermesBridge.bridge_exists || !hermesBridge.wrapper_exists || !hermesBridge.points_local || hermesBridge.hosted_refs_present, "Hermes Open Brain bridge not fully local");
  addBlocker(blockers, !codexRules.exists || codexRules.hosted_open_brain_allowed || !codexRules.local_wrapper_allowed, "Codex rules still allow hosted Open Brain or do not allow local wrapper");
  addBlocker(blockers, !agentSpawnPaths.ok, "agent spawn path still references hosted Open Brain/Supabase");

  const hosted_cleanup_ready = blockers.length === 0;
  const agent_swarm_ready = agentSpawnRuntime.ok;
  const report = {
    ok: hosted_cleanup_ready,
    hosted_cleanup_ready,
    agent_swarm_ready,
    checked_at: new Date().toISOString(),
    docker_compose_required: false,
    local_api_url: LOCAL_API_URL,
    blockers,
    checks: {
      local_api_health: localApiHealth,
      local_database_count: localDatabaseCount,
      backup_preflight: backupPreflight,
      backup_manifest: backupManifest,
      imported_backup_count: importedBackupCount,
      first_class_side_tables: firstClassSideTables,
      dashboard_envs: dashboardEnvs,
      hermes_bridge: hermesBridge,
      codex_rules: codexRules,
      agent_spawn_paths: agentSpawnPaths,
      agent_spawn_runtime: agentSpawnRuntime,
    },
  };

  if (FLAG_JSON) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`Aegis local cutover readiness: ${hosted_cleanup_ready ? "READY" : "BLOCKED"}\n`);
    for (const blocker of blockers) process.stdout.write(`- ${blocker}\n`);
  }

  process.exit(hosted_cleanup_ready ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`cutover readiness failed: ${err?.message || err}\n`);
  process.exit(1);
});
