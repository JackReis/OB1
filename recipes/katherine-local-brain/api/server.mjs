import crypto from "node:crypto";
import http from "node:http";

const PORT = numberEnv("PORT", 8787);
const POSTGREST_URL = requiredEnv("POSTGREST_URL").replace(/\/$/, "");
const SERVICE_ROLE_KEY = requiredEnv("SERVICE_ROLE_KEY");
const BRAIN_ACCESS_KEY = requiredEnv("BRAIN_ACCESS_KEY");
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://host.docker.internal:11434").replace(/\/$/, "");
const OLLAMA_EMBED_PATH = process.env.OLLAMA_EMBED_PATH || "/api/embed";
const EMBED_MODEL = process.env.EMBED_MODEL || "mxbai-embed-large";
const EMBED_DIM = numberEnv("EMBED_DIM", 1024);
const AGENT_MEMORY_CAPTURE_THOUGHTS = process.env.AGENT_MEMORY_CAPTURE_THOUGHTS === "1";
const ARCHIVE_SOURCE_SYSTEM = "hosted_open_brain";
const ARCHIVE_TABLE_NAMES = [
  "entities",
  "edges",
  "thought_entities",
  "reflections",
  "ingestion_jobs",
  "ingestion_items",
  "agent_memories",
  "agent_memory_audit_events",
];
const ARCHIVE_TABLES = new Set(ARCHIVE_TABLE_NAMES);
const FIRST_CLASS_ARCHIVE_TABLES = new Set(ARCHIVE_TABLE_NAMES);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function joinUrl(base, path) {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-brain-key, x-ingest-key, content-type, accept, mcp-session-id, mcp-protocol-version",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const auth = req.headers.authorization || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

function authenticated(req, url) {
  const provided = req.headers["x-brain-key"] || req.headers["x-ingest-key"] || bearerToken(req) || url.searchParams.get("key");
  return timingSafeEqualText(provided, BRAIN_ACCESS_KEY);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(httpError(413, "request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(httpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function publicError(error) {
  if (error?.payload) return error.payload;
  return {
    ok: false,
    error: error?.message || "unexpected error",
  };
}

function validateMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function metadataValue(metadata, key, fallback = null) {
  return metadata[key] === undefined || metadata[key] === null || metadata[key] === "" ? fallback : metadata[key];
}

function intFromSearch(url, name, fallback, min, max) {
  return clampInt(url.searchParams.get(name), fallback, min, max);
}

function textContent(text) {
  return [{ type: "text", text }];
}

function jsonRpcResult(id, content) {
  return {
    result: {
      content: typeof content === "string" ? textContent(content) : content,
    },
    jsonrpc: "2.0",
    id,
  };
}

function jsonRpcError(id, code, message) {
  return {
    error: { code, message },
    jsonrpc: "2.0",
    id,
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function getEmbedding(text) {
  const path = OLLAMA_EMBED_PATH.startsWith("/") ? OLLAMA_EMBED_PATH : `/${OLLAMA_EMBED_PATH}`;
  const legacyPromptEndpoint = path === "/api/embeddings";
  const response = await fetch(joinUrl(OLLAMA_URL, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      legacyPromptEndpoint
        ? { model: EMBED_MODEL, prompt: text }
        : { model: EMBED_MODEL, input: text }
    ),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw httpError(502, `Ollama embedding request failed: ${response.status} ${detail}`.trim());
  }
  const payload = await response.json();
  const embedding = Array.isArray(payload?.embeddings) ? payload.embeddings[0] : payload?.embedding;
  return validateEmbedding(embedding);
}

function validateEmbedding(value) {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => Number.isFinite(item))) {
    throw httpError(502, "Ollama did not return an embedding vector");
  }
  if (value.length !== EMBED_DIM) {
    throw httpError(
      502,
      `embedding-dim mismatch: EMBED_DIM=${EMBED_DIM} but ${EMBED_MODEL} returned ${value.length}`
    );
  }
  return value;
}

function embeddingToVectorLiteral(embedding) {
  return `[${embedding.map((value) => Number(value).toPrecision(12)).join(",")}]`;
}

async function postgrestRpc(name, body) {
  const response = await fetch(joinUrl(POSTGREST_URL, `/rpc/${name}`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw httpError(502, `PostgREST RPC ${name} failed: ${response.status} ${detail}`.trim());
  }
  return response.json();
}

async function postgrestGet(path) {
  const response = await fetch(joinUrl(POSTGREST_URL, path), {
    headers: {
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw httpError(502, `PostgREST request failed: ${response.status} ${detail}`.trim());
  }
  return response.json();
}

async function postgrestGetWithHeaders(path, headers = {}) {
  const response = await fetch(joinUrl(POSTGREST_URL, path), {
    headers: {
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      accept: "application/json",
      ...headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw httpError(502, `PostGREST request failed: ${response.status} ${detail}`.trim());
  }
  return response;
}

async function postgrestPatch(path, body) {
  const response = await fetch(joinUrl(POSTGREST_URL, path), {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      accept: "application/json",
      "content-type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw httpError(502, `PostgREST PATCH failed: ${response.status} ${detail}`.trim());
  }
  return response.json();
}

async function postgrestPost(path, body, headers = {}) {
  const response = await fetch(joinUrl(POSTGREST_URL, path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      accept: "application/json",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw httpError(502, `PostgREST POST failed: ${response.status} ${detail}`.trim());
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function postgrestDelete(path) {
  const response = await fetch(joinUrl(POSTGREST_URL, path), {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      accept: "application/json",
      Prefer: "return=representation",
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw httpError(502, `PostgREST DELETE failed: ${response.status} ${detail}`.trim());
  }
  return response.json();
}

async function handleCapture(body) {
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) throw httpError(400, "content is required");
  const requestedType = typeof body.type === "string" && body.type.trim() ? body.type.trim() : null;
  const requestedSource =
    typeof body.source_type === "string" && body.source_type.trim()
      ? body.source_type.trim()
      : typeof body.source === "string" && body.source.trim()
        ? body.source.trim()
        : null;
  const metadata = {
    source: "aegis-local-brain",
    ...(requestedType ? { type: requestedType } : {}),
    ...(requestedSource ? { source: requestedSource, source_type: requestedSource } : {}),
    ...validateMetadata(body.metadata),
  };
  const embedding = await getEmbedding(content);
  const result = await postgrestRpc("upsert_thought", {
    p_content: content,
    p_embedding: embeddingToVectorLiteral(embedding),
    p_metadata: metadata,
  });
  return {
    ok: true,
    id: result.id,
    thought_id: result.id,
    action: "created_or_updated",
    type: metadata.type || "observation",
    source_type: metadata.source_type || metadata.source || "aegis-local-brain",
    content_fingerprint: result.fingerprint,
    fingerprint: result.fingerprint,
    message: "Thought captured",
  };
}

async function handleSearch(body) {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) throw httpError(400, "query is required");
  const matchCount = clampInt(body.match_count, 10, 1, 100);
  const matchThreshold =
    typeof body.match_threshold === "number" && body.match_threshold >= 0 && body.match_threshold <= 1
      ? body.match_threshold
      : 0.7;
  const filter = validateMetadata(body.filter);
  const embedding = await getEmbedding(query);
  const matches = await postgrestRpc("match_thoughts", {
    query_embedding: embeddingToVectorLiteral(embedding),
    match_threshold: matchThreshold,
    match_count: matchCount,
    filter,
  });
  return { ok: true, matches };
}

async function handleList(url) {
  const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const thoughts = await listThoughtRows({ limit, offset });
  return { ok: true, thoughts };
}

function thoughtSelect() {
  return [
    "id",
    "content",
    "metadata",
    "created_at",
    "updated_at",
    "type",
    "source_type",
    "importance",
    "quality_score",
    "sensitivity_tier",
    "status",
    "status_updated_at",
  ].join(",");
}

function normalizeThought(row, extra = {}) {
  const metadata = validateMetadata(row.metadata);
  return {
    id: row.id,
    content: row.content,
    metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
    type: row.type || metadata.type || "observation",
    source_type: row.source_type || metadata.source_type || metadata.source || "unknown",
    importance: Number.isFinite(Number(row.importance)) ? Number(row.importance) : 50,
    quality_score: Number.isFinite(Number(row.quality_score)) ? Number(row.quality_score) : 50,
    sensitivity_tier: row.sensitivity_tier || metadata.sensitivity_tier || "standard",
    status: row.status || null,
    status_updated_at: row.status_updated_at || null,
    ...extra,
  };
}

function restFilterRows(rows, url) {
  const type = url.searchParams.get("type");
  const sourceType = url.searchParams.get("source_type") || url.searchParams.get("source");
  const status = url.searchParams.get("status");
  const qualityMax = url.searchParams.get("quality_score_max");
  const importanceMin = url.searchParams.get("importance_min");
  return rows.filter((row) => {
    const thought = normalizeThought(row);
    if (type && thought.type !== type) return false;
    if (sourceType && thought.source_type !== sourceType) return false;
    if (status && !status.split(",").includes(String(thought.status || ""))) return false;
    if (qualityMax !== null && thought.quality_score > Number(qualityMax)) return false;
    if (importanceMin !== null && thought.importance < Number(importanceMin)) return false;
    return true;
  });
}

async function listThoughtRows({ limit = 20, offset = 0 } = {}) {
  const select = thoughtSelect();
  return postgrestGet(
    `/thoughts?select=${encodeURIComponent(select)}&order=created_at.desc&limit=${limit}&offset=${offset}`
  );
}

async function listThoughtRowsWithCount({ limit = 20, offset = 0 } = {}) {
  const select = thoughtSelect();
  const response = await postgrestGetWithHeaders(
    `/thoughts?select=${encodeURIComponent(select)}&order=created_at.desc&limit=${limit}&offset=${offset}`,
    { Prefer: "count=exact", Range: `${offset}-${offset + limit - 1}` }
  );
  const rows = await response.json();
  const range = response.headers.get("content-range") || "";
  const total = range.match(/\/(\d+|\*)$/)?.[1];
  return { rows, total: total && total !== "*" ? Number(total) : rows.length };
}

async function listAllThoughtRows(limit = 1000) {
  const select = [
    "id",
    "content",
    "metadata",
    "created_at",
    "updated_at",
    "type",
    "source_type",
    "importance",
    "quality_score",
    "sensitivity_tier",
    "status",
    "status_updated_at",
  ].join(",");
  return postgrestGet(
    `/thoughts?select=${encodeURIComponent(select)}&order=created_at.desc&limit=${limit}&offset=0`
  );
}

async function getThoughtById(id) {
  const select = thoughtSelect();
  const rows = await postgrestGet(
    `/thoughts?select=${encodeURIComponent(select)}&id=eq.${encodeURIComponent(id)}&limit=1`
  );
  return rows[0] || null;
}

async function thoughtCount() {
  const response = await postgrestGetWithHeaders("/thoughts?select=id&limit=1", {
    Prefer: "count=exact",
    Range: "0-0",
  });
  const range = response.headers.get("content-range") || "";
  const total = range.match(/\/(\d+|\*)$/)?.[1];
  if (total && total !== "*") return Number(total);
  const rows = await response.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function thoughtCountByMetadata(metadata) {
  const encodedMetadata = encodeURIComponent(JSON.stringify(metadata));
  const response = await postgrestGetWithHeaders(`/thoughts?select=id&metadata=cs.${encodedMetadata}&limit=1`, {
    Prefer: "count=exact",
    Range: "0-0",
  });
  const range = response.headers.get("content-range") || "";
  const total = range.match(/\/(\d+|\*)$/)?.[1];
  if (total && total !== "*") return Number(total);
  const rows = await response.json();
  return Array.isArray(rows) ? rows.length : 0;
}

function thoughtTitle(content, createdAt) {
  const firstLine = String(content || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(id) {
  return `openbrain://thoughts/${id}`;
}

function archiveSourceId(tableName, row, index) {
  if (row?.id !== undefined && row?.id !== null && row.id !== "") return String(row.id);
  if (tableName === "thought_entities" && row?.thought_id !== undefined && row?.entity_id !== undefined) {
    return [row.thought_id, row.entity_id, row.mention_role || "", row.source || ""].join(":");
  }
  const digest = crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
  return `${tableName}:${index}:${digest}`;
}

function textOrNull(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolOrFalse(value) {
  return value === true;
}

function boolOrTrue(value) {
  return value !== false;
}

function jsonObjectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function jsonArrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function sideTableRecord(tableName, archiveRecord) {
  const row = archiveRecord.row_data;
  const base = {
    id: archiveRecord.source_id,
    source_system: archiveRecord.source_system || ARCHIVE_SOURCE_SYSTEM,
    source_id: archiveRecord.source_id,
    row_data: row,
    backup_file: archiveRecord.backup_file || null,
    created_at: textOrNull(row.created_at || row.first_seen_at),
  };

  if (tableName === "agent_memories") {
    return {
      ...base,
      thought_id: textOrNull(row.thought_id),
      workspace_id: textOrNull(row.workspace_id),
      project_id: textOrNull(row.project_id),
      channel_kind: textOrNull(row.channel_kind),
      channel_id: textOrNull(row.channel_id),
      channel_thread_id: textOrNull(row.channel_thread_id),
      visibility: textOrNull(row.visibility),
      memory_type: textOrNull(row.memory_type),
      summary: textOrNull(row.summary),
      content: textOrNull(row.content),
      lifecycle_status: textOrNull(row.lifecycle_status),
      provenance_status: textOrNull(row.provenance_status),
      confidence: numberOrNull(row.confidence),
      created_by: textOrNull(row.created_by),
      runtime_name: textOrNull(row.runtime_name),
      runtime_version: textOrNull(row.runtime_version),
      provider: textOrNull(row.provider),
      model: textOrNull(row.model),
      task_id: textOrNull(row.task_id),
      flow_id: textOrNull(row.flow_id),
      can_use_as_instruction: boolOrFalse(row.can_use_as_instruction),
      can_use_as_evidence: boolOrTrue(row.can_use_as_evidence),
      requires_user_confirmation: boolOrFalse(row.requires_user_confirmation),
      review_status: textOrNull(row.review_status),
      last_confirmed_at: textOrNull(row.last_confirmed_at),
      stale_after: textOrNull(row.stale_after),
      idempotency_key: textOrNull(row.idempotency_key),
      content_hash: textOrNull(row.content_hash),
      metadata: jsonObjectOrEmpty(row.metadata),
      updated_at: textOrNull(row.updated_at),
    };
  }

  if (tableName === "agent_memory_audit_events") {
    return {
      ...base,
      event_type: textOrNull(row.event_type),
      workspace_id: textOrNull(row.workspace_id),
      project_id: textOrNull(row.project_id),
      memory_id: textOrNull(row.memory_id),
      trace_id: textOrNull(row.trace_id),
      actor_kind: textOrNull(row.actor_kind),
      actor_label: textOrNull(row.actor_label),
      runtime_name: textOrNull(row.runtime_name),
      task_id: textOrNull(row.task_id),
      payload: jsonObjectOrEmpty(row.payload),
    };
  }

  if (tableName === "entities") {
    return {
      ...base,
      name: textOrNull(row.name || row.normalized_name),
      canonical_name: textOrNull(row.canonical_name),
      entity_type: textOrNull(row.entity_type || row.type),
      aliases: jsonArrayOrEmpty(row.aliases),
      metadata: jsonObjectOrEmpty(row.metadata),
      updated_at: textOrNull(row.updated_at || row.last_seen_at),
    };
  }

  if (tableName === "edges") {
    return {
      ...base,
      source_entity_id: textOrNull(row.source_entity_id || row.from_entity_id),
      target_entity_id: textOrNull(row.target_entity_id || row.to_entity_id),
      relation_type: textOrNull(row.relation_type || row.relation),
      confidence: numberOrNull(row.confidence),
      metadata: jsonObjectOrEmpty(row.metadata),
      updated_at: textOrNull(row.updated_at),
    };
  }

  if (tableName === "thought_entities") {
    return {
      ...base,
      thought_id: textOrNull(row.thought_id),
      entity_id: textOrNull(row.entity_id),
      mention_role: textOrNull(row.mention_role),
      source: textOrNull(row.source),
      evidence: jsonObjectOrEmpty(row.evidence),
      metadata: jsonObjectOrEmpty(row.metadata),
      updated_at: textOrNull(row.updated_at),
    };
  }

  if (tableName === "reflections") {
    return {
      ...base,
      thought_id: textOrNull(row.thought_id),
      reflection_type: textOrNull(row.reflection_type),
      content: textOrNull(row.content || row.conclusion),
      model: textOrNull(row.model),
      metadata: {
        ...jsonObjectOrEmpty(row.metadata),
        trigger_context: row.trigger_context,
        options: row.options,
        factors: row.factors,
        conclusion: row.conclusion,
        confidence: row.confidence,
      },
      updated_at: textOrNull(row.updated_at),
    };
  }

  if (tableName === "ingestion_jobs") {
    return {
      ...base,
      status: textOrNull(row.status),
      job_type: textOrNull(row.job_type || row.source_type),
      source_kind: textOrNull(row.source_kind || row.source_type),
      created_by: textOrNull(row.created_by),
      error_message: textOrNull(row.error_message),
      metadata: jsonObjectOrEmpty(row.metadata),
      updated_at: textOrNull(row.updated_at || row.completed_at),
    };
  }

  if (tableName === "ingestion_items") {
    return {
      ...base,
      job_id: textOrNull(row.job_id),
      thought_id: textOrNull(row.thought_id || row.result_thought_id || row.matched_thought_id),
      status: textOrNull(row.status),
      source_ref: textOrNull(row.source_ref || row.extracted_content),
      error_message: textOrNull(row.error_message),
      metadata: jsonObjectOrEmpty(row.metadata),
      updated_at: textOrNull(row.updated_at),
    };
  }

  return base;
}

async function promoteBackupRows(tableName, archiveRecords) {
  if (!FIRST_CLASS_ARCHIVE_TABLES.has(tableName) || archiveRecords.length === 0) return 0;
  const records = archiveRecords.map((record) => sideTableRecord(tableName, record));
  await postgrestPost(
    `/${tableName}?on_conflict=source_id`,
    records,
    { Prefer: "resolution=merge-duplicates,return=minimal" }
  );
  return records.length;
}

async function handleBackupArchive(body) {
  const tableName = typeof body.table === "string" ? body.table.trim() : "";
  if (!ARCHIVE_TABLES.has(tableName)) throw httpError(400, `unsupported archive table: ${tableName}`);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const backupFile = typeof body.backup_file === "string" ? body.backup_file : null;
  const records = rows
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row, index) => ({
      source_system: ARCHIVE_SOURCE_SYSTEM,
      table_name: tableName,
      source_id: archiveSourceId(tableName, row, index),
      row_data: row,
      backup_file: backupFile,
    }));
  let promotedCount = 0;
  if (records.length > 0) {
    await postgrestPost(
      "/backup_archive_rows?on_conflict=source_system,table_name,source_id",
      records,
      { Prefer: "resolution=merge-duplicates,return=minimal" }
    );
    promotedCount = await promoteBackupRows(tableName, records);
  }
  return {
    ok: true,
    table: tableName,
    archived_count: records.length,
    promoted_count: promotedCount,
    skipped_count: rows.length - records.length,
  };
}

async function handleBackupArchiveCount(url) {
  const tableName = url.searchParams.get("table") || "";
  if (tableName && !ARCHIVE_TABLES.has(tableName)) throw httpError(400, `unsupported archive table: ${tableName}`);
  const tableFilter = tableName ? `&table_name=eq.${encodeURIComponent(tableName)}` : "";
  const response = await postgrestGetWithHeaders(
    `/backup_archive_rows?select=id&source_system=eq.${ARCHIVE_SOURCE_SYSTEM}${tableFilter}&limit=1`,
    { Prefer: "count=exact", Range: "0-0" }
  );
  const range = response.headers.get("content-range") || "";
  const total = range.match(/\/(\d+|\*)$/)?.[1];
  const count = total && total !== "*" ? Number(total) : 0;
  return {
    ok: true,
    source_system: ARCHIVE_SOURCE_SYSTEM,
    table: tableName || null,
    count,
  };
}

async function countPostgrestTable(tableName, extraQuery = "") {
  const response = await postgrestGetWithHeaders(
    `/${tableName}?select=id${extraQuery}&limit=1`,
    { Prefer: "count=exact", Range: "0-0" }
  );
  const range = response.headers.get("content-range") || "";
  const total = range.match(/\/(\d+|\*)$/)?.[1];
  return total && total !== "*" ? Number(total) : 0;
}

async function handleFirstClassSideTableCount(url) {
  const tableName = url.searchParams.get("table") || "";
  if (tableName && !FIRST_CLASS_ARCHIVE_TABLES.has(tableName)) {
    throw httpError(400, `unsupported first-class table: ${tableName}`);
  }
  const tables = tableName ? [tableName] : [...FIRST_CLASS_ARCHIVE_TABLES];
  const counts = {};
  for (const table of tables) {
    counts[table] = await countPostgrestTable(table);
  }
  return {
    ok: true,
    table: tableName || null,
    count: tableName ? counts[tableName] : Object.values(counts).reduce((sum, count) => sum + count, 0),
    first_class_count: tableName ? counts[tableName] : Object.values(counts).reduce((sum, count) => sum + count, 0),
    counts,
  };
}

async function handleRestStats(url) {
  const rows = await listAllThoughtRows(1000);
  const total = await thoughtCount();
  const types = {};
  const topics = {};
  for (const row of rows) {
    const thought = normalizeThought(row);
    types[thought.type] = (types[thought.type] || 0) + 1;
    const metadata = validateMetadata(row.metadata);
    if (Array.isArray(metadata.topics)) {
      for (const topic of metadata.topics) topics[topic] = (topics[topic] || 0) + 1;
    }
  }
  return {
    total_thoughts: total,
    window_days: intFromSearch(url, "days", 0, 0, 3650) || "all",
    types,
    top_topics: Object.entries(topics)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([topic, count]) => ({ topic, count })),
  };
}

async function handleRestCount(url) {
  const migratedFrom = url.searchParams.get("migrated_from");
  const [total, rows, filteredCount] = await Promise.all([
    thoughtCount(),
    listAllThoughtRows(1000),
    migratedFrom ? thoughtCountByMetadata({ migrated_from: migratedFrom }) : Promise.resolve(null),
  ]);
  const types = {};
  const sourceTypes = {};
  for (const row of rows) {
    const thought = normalizeThought(row);
    types[thought.type] = (types[thought.type] || 0) + 1;
    sourceTypes[thought.source_type] = (sourceTypes[thought.source_type] || 0) + 1;
  }
  const count = filteredCount ?? total;
  return {
    ok: true,
    count,
    total,
    total_thoughts: total,
    types,
    source_types: sourceTypes,
    ...(migratedFrom
      ? {
          migrated_from: migratedFrom,
          filtered_count: filteredCount,
          imported_count: filteredCount,
        }
      : {}),
  };
}

async function handleRestThoughts(url) {
  const page = intFromSearch(url, "page", 1, 1, 100000);
  const perPage = intFromSearch(url, "per_page", 25, 1, 100);
  const offset = (page - 1) * perPage;
  const hasFilters = ["type", "source_type", "source", "status", "quality_score_max", "importance_min"].some((key) =>
    url.searchParams.has(key)
  );
  if (!hasFilters) {
    const result = await listThoughtRowsWithCount({ limit: perPage, offset });
    return {
      data: result.rows.map((row) => normalizeThought(row)),
      total: result.total,
      page,
      per_page: perPage,
    };
  }
  const rows = restFilterRows(await listAllThoughtRows(1000), url);
  return {
    data: rows.slice(offset, offset + perPage).map((row) => normalizeThought(row)),
    total: rows.length,
    page,
    per_page: perPage,
  };
}

async function handleRestThoughtById(id) {
  const row = await getThoughtById(id);
  if (!row) throw httpError(404, "thought not found");
  return normalizeThought(row);
}

function textSearchRows(rows, query) {
  const lower = query.toLowerCase();
  return rows.filter((row) => String(row.content || "").toLowerCase().includes(lower));
}

async function handleRestSearch(body) {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) throw httpError(400, "query is required");
  const page = clampInt(body.page, 1, 1, 100000);
  const limit = clampInt(body.limit, 10, 1, 100);
  const offset = (page - 1) * limit;
  if (body.mode === "text") {
    const rows = textSearchRows(await listAllThoughtRows(1000), query);
    return {
      results: rows.slice(offset, offset + limit).map((row, index) => normalizeThought(row, { rank: offset + index + 1 })),
      count: Math.min(limit, Math.max(0, rows.length - offset)),
      total: rows.length,
      page,
      per_page: limit,
      total_pages: Math.max(1, Math.ceil(rows.length / limit)),
      mode: "text",
    };
  }
  const result = await handleSearch({
    query,
    match_count: Math.min(100, Math.max(limit * page * 3, limit)),
    match_threshold: typeof body.threshold === "number" ? body.threshold : 0.5,
    filter: {},
  });
  const ordered = (result.matches || []).map((row, index) => normalizeThought(row, {
    similarity: row.similarity,
    rank: index + 1,
  }));
  return {
    results: ordered.slice(offset, offset + limit),
    count: Math.min(limit, Math.max(0, ordered.length - offset)),
    total: ordered.length,
    page,
    per_page: limit,
    total_pages: Math.max(1, Math.ceil(ordered.length / limit)),
    mode: "semantic",
  };
}

function contentFingerprint(content) {
  const normalized = String(content || "").replace(/\s+/g, " ").trim().toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function metadataArray(metadata, key) {
  return Array.isArray(metadata[key]) ? metadata[key].map((item) => String(item).trim()).filter(Boolean) : [];
}

function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{2,}/g) || []
  );
}

function tokenSimilarity(left, right) {
  const a = tokenize(left);
  const b = tokenize(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

function overlapScore(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  return intersection / Math.max(leftSet.size, rightSet.size);
}

async function handleRestThoughtUpdate(id, body) {
  const existing = await getThoughtById(id);
  if (!existing) throw httpError(404, "thought not found");

  const existingMetadata = validateMetadata(existing.metadata);
  const patch = {};
  if (typeof body.content === "string" && body.content.trim()) {
    const content = body.content.trim();
    patch.content = content;
    patch.embedding = embeddingToVectorLiteral(await getEmbedding(content));
    patch.content_fingerprint = contentFingerprint(content);
  }
  if (body.metadata !== undefined) patch.metadata = { ...existingMetadata, ...validateMetadata(body.metadata) };
  for (const field of ["type", "source_type", "sensitivity_tier", "status"]) {
    if (typeof body[field] === "string" && body[field].trim()) patch[field] = body[field].trim();
  }
  for (const field of ["importance", "quality_score"]) {
    if (body[field] !== undefined) patch[field] = clampInt(body[field], existing[field] || 50, 0, 100);
  }
  if (body.status !== undefined) patch.status_updated_at = new Date().toISOString();
  if (typeof body.status_updated_at === "string" && body.status_updated_at.trim()) {
    patch.status_updated_at = body.status_updated_at.trim();
  }
  if (!Object.keys(patch).length) throw httpError(400, "no update fields supplied");

  const rows = await postgrestPatch(`/thoughts?id=eq.${encodeURIComponent(id)}`, patch);
  const updated = rows[0];
  if (!updated) throw httpError(404, "thought not found");
  return {
    ok: true,
    id,
    thought_id: id,
    action: "updated",
    message: "Thought updated",
    thought: normalizeThought(updated),
  };
}

async function handleRestThoughtDelete(id) {
  const rows = await postgrestDelete(`/thoughts?id=eq.${encodeURIComponent(id)}`);
  if (!rows.length) throw httpError(404, "thought not found");
  return {
    ok: true,
    id,
    thought_id: id,
    action: "deleted",
    message: "Thought deleted",
  };
}

async function handleRestDuplicates(url) {
  const limit = intFromSearch(url, "limit", 100, 1, 500);
  const offset = intFromSearch(url, "offset", 0, 0, 1_000_000);
  const scanLimit = intFromSearch(url, "scan_limit", 500, 2, 1000);
  const threshold = Number.parseFloat(url.searchParams.get("threshold") || "0.85");
  const rows = (await listAllThoughtRows(scanLimit)).map((row) => normalizeThought(row));
  const pairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const similarity = tokenSimilarity(rows[i].content, rows[j].content);
      if (similarity >= threshold) {
        pairs.push({
          thought_id_a: rows[i].id,
          thought_id_b: rows[j].id,
          similarity,
          content_a: rows[i].content,
          content_b: rows[j].content,
          type_a: rows[i].type,
          type_b: rows[j].type,
          quality_a: rows[i].quality_score,
          quality_b: rows[j].quality_score,
          created_a: rows[i].created_at,
          created_b: rows[j].created_at,
          a: rows[i],
          b: rows[j],
        });
      }
    }
  }
  pairs.sort((a, b) => b.similarity - a.similarity);
  return {
    pairs: pairs.slice(offset, offset + limit),
    count: pairs.length,
    total: pairs.length,
    threshold,
    limit,
    offset,
    scan_limit: scanLimit,
  };
}

function requireThoughtId(value, name) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  throw httpError(400, `${name} is required`);
}

async function handleRestDuplicateResolve(body) {
  const action = typeof body.action === "string" ? body.action : "";
  if (!["keep_a", "keep_b", "keep_both"].includes(action)) throw httpError(400, "Invalid action");

  const idA = requireThoughtId(body.thought_id_a, "thought_id_a");
  const idB = requireThoughtId(body.thought_id_b, "thought_id_b");
  if (idA === idB) throw httpError(400, "thought_id_a and thought_id_b must differ");

  const [rowA, rowB] = await Promise.all([getThoughtById(idA), getThoughtById(idB)]);
  if (!rowA || !rowB) throw httpError(404, "thought not found");

  const reattached = { reflections: 0, thought_entities: 0 };
  if (action === "keep_both") {
    return {
      ok: true,
      action: "kept_both",
      survivor_id: null,
      loser_id: null,
      kept: [idA, idB],
      reattached,
    };
  }

  const thoughtA = normalizeThought(rowA);
  const thoughtB = normalizeThought(rowB);
  const minimumSimilarity =
    typeof body.threshold === "number" && body.threshold >= 0 && body.threshold <= 1 ? body.threshold : 0.8;
  const similarity = tokenSimilarity(thoughtA.content, thoughtB.content);
  if (similarity < minimumSimilarity) throw httpError(403, "Pair is not a recognized duplicate");

  const survivorId = action === "keep_a" ? idA : idB;
  const loserId = action === "keep_a" ? idB : idA;
  await handleRestThoughtDelete(loserId);
  return {
    ok: true,
    action: "resolved",
    survivor_id: survivorId,
    loser_id: loserId,
    kept: survivorId,
    deleted: loserId,
    reattached,
    similarity,
  };
}

async function handleRestThoughtConnections(id, url) {
  const target = await getThoughtById(id);
  if (!target) throw httpError(404, "thought not found");
  const limit = intFromSearch(url, "limit", 10, 1, 50);
  const graphRows = await graphThoughtConnections(id, limit);
  if (graphRows.length) {
    return { thought_id: id, connections: graphRows, count: graphRows.length, source: "first_class_graph" };
  }
  const targetThought = normalizeThought(target);
  const targetMetadata = validateMetadata(target.metadata);
  const targetTags = [
    ...metadataArray(targetMetadata, "topics"),
    ...metadataArray(targetMetadata, "people"),
    targetThought.type,
    targetThought.source_type,
  ].filter(Boolean);
  const rows = (await listAllThoughtRows(500))
    .filter((row) => row.id !== id)
    .map((row) => {
      const thought = normalizeThought(row);
      const metadata = validateMetadata(row.metadata);
      const tags = [
        ...metadataArray(metadata, "topics"),
        ...metadataArray(metadata, "people"),
        thought.type,
        thought.source_type,
      ].filter(Boolean);
      const metadata_score = overlapScore(targetTags, tags);
      const text_score = tokenSimilarity(targetThought.content, thought.content);
      return {
        ...thought,
        connection_score: Math.max(metadata_score, text_score),
        metadata_score,
        text_score,
      };
    })
    .filter((thought) => thought.connection_score > 0)
    .sort((a, b) => b.connection_score - a.connection_score)
    .slice(0, limit);
  return { thought_id: id, connections: rows, count: rows.length };
}

async function graphThoughtConnections(id, limit) {
  const mentions = await postgrestGet(
    `/thought_entities?select=*&thought_id=eq.${encodeURIComponent(id)}&limit=200`
  );
  const entityIds = new Set(mentions.map((row) => row.entity_id).filter(Boolean).map(String));
  if (!entityIds.size) return [];

  const allMentions = await postgrestGet("/thought_entities?select=*&limit=2000");
  const relatedByThought = new Map();
  for (const row of allMentions) {
    const thoughtId = textOrNull(row.thought_id);
    const entityId = textOrNull(row.entity_id);
    if (!thoughtId || thoughtId === id || !entityId || !entityIds.has(entityId)) continue;
    const entry = relatedByThought.get(thoughtId) || { thought_id: thoughtId, entity_ids: new Set(), mention_roles: new Set() };
    entry.entity_ids.add(entityId);
    if (row.mention_role) entry.mention_roles.add(row.mention_role);
    relatedByThought.set(thoughtId, entry);
  }
  if (!relatedByThought.size) return [];

  const thoughts = new Map((await listAllThoughtRows(1000)).map((row) => [String(row.id), normalizeThought(row)]));
  return [...relatedByThought.values()]
    .map((entry) => {
      const thought = thoughts.get(entry.thought_id) || { id: entry.thought_id };
      const sharedEntityCount = entry.entity_ids.size;
      return {
        ...thought,
        connection_score: sharedEntityCount,
        metadata_score: sharedEntityCount,
        text_score: 0,
        connection_source: "first_class_graph",
        entity_ids: [...entry.entity_ids],
        mention_roles: [...entry.mention_roles],
      };
    })
    .sort((a, b) => b.connection_score - a.connection_score)
    .slice(0, limit);
}

async function handleRestThoughtReflection(id, body = {}) {
  const thought = await getThoughtById(id);
  if (!thought) throw httpError(404, "thought not found");
  if (Object.keys(body).length) {
    const now = new Date().toISOString();
    const reflectionId = textOrNull(body.id) || `reflection-${crypto.randomUUID()}`;
    const content =
      typeof body.content === "string"
        ? body.content.trim()
        : typeof body.reflection === "string"
          ? body.reflection.trim()
          : body.reflection !== undefined
            ? JSON.stringify(body.reflection)
            : "";
    if (!content) throw httpError(400, "reflection or content is required");
    const metadata = {
      source: "aegis_local_brain",
      thought_id: id,
      ...validateMetadata(body.metadata),
    };
    await postgrestPost(
      "/reflections?on_conflict=source_id",
      [{
        id: reflectionId,
        source_system: "aegis_local_brain",
        source_id: reflectionId,
        thought_id: id,
        reflection_type: textOrNull(body.reflection_type || body.type) || "manual",
        content,
        model: textOrNull(body.model),
        metadata,
        row_data: { ...body, thought_id: id },
        created_at: textOrNull(body.created_at) || now,
        updated_at: now,
      }],
      { Prefer: "resolution=merge-duplicates,return=representation" }
    );
  }
  const rows = await postgrestGet(
    `/reflections?select=*&thought_id=eq.${encodeURIComponent(id)}&order=created_at.desc&limit=50`
  );
  return {
    thought_id: id,
    status: "ok",
    reflection: rows[0]?.content || null,
    reflections: rows,
    count: rows.length,
  };
}

function splitIngestContent(content) {
  const text = String(content || "").trim();
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  return paragraphs.length > 1 ? paragraphs.slice(0, 25) : [text];
}

async function handleRestIngest(body) {
  const content = typeof body.content === "string" ? body.content : typeof body.text === "string" ? body.text : "";
  const chunks = splitIngestContent(content);
  if (!chunks.length) throw httpError(400, "content or text is required");
  const dryRun = body.dry_run !== false;
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "local-ingest";
  const metadata = validateMetadata(body.metadata);
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      extracted: chunks.length,
      thoughts: chunks.map((chunk, index) => ({ index, content: chunk, source_type: source })),
    };
  }
  const now = new Date().toISOString();
  const jobId = textOrNull(body.job_id || body.id) || `ingest-${crypto.randomUUID()}`;
  await postgrestPost(
    "/ingestion_jobs?on_conflict=source_id",
    [{
      id: jobId,
      source_system: "aegis_local_brain",
      source_id: jobId,
      status: "running",
      job_type: textOrNull(body.job_type || body.type) || "direct_text",
      source_kind: source,
      created_by: textOrNull(body.created_by) || "agent",
      error_message: null,
      metadata: { ...metadata, extracted: chunks.length },
      row_data: { ...body, source, extracted: chunks.length },
      created_at: now,
      updated_at: now,
    }],
    { Prefer: "resolution=merge-duplicates,return=representation" }
  );
  const thoughts = [];
  const items = [];
  try {
    for (const [index, chunk] of chunks.entries()) {
      const captured = await handleCapture({
        content: chunk,
        source_type: source,
        metadata: {
          source,
          ingest: true,
          ingestion_job_id: jobId,
          ingestion_item_index: index,
          ...metadata,
        },
      });
      thoughts.push(captured);
      const itemId = `${jobId}:item:${index}`;
      items.push({
        id: itemId,
        source_system: "aegis_local_brain",
        source_id: itemId,
        job_id: jobId,
        thought_id: captured.thought_id,
        status: "complete",
        source_ref: `${source}#${index}`,
        error_message: null,
        metadata: { index, fingerprint: captured.fingerprint || captured.content_fingerprint || null },
        row_data: { index, content: chunk, thought_id: captured.thought_id },
        created_at: now,
        updated_at: new Date().toISOString(),
      });
    }
    if (items.length) {
      await postgrestPost(
        "/ingestion_items?on_conflict=source_id",
        items,
        { Prefer: "resolution=merge-duplicates,return=minimal" }
      );
    }
    await postgrestPatch(`/ingestion_jobs?id=eq.${encodeURIComponent(jobId)}`, {
      status: "complete",
      metadata: { ...metadata, extracted: chunks.length, captured: thoughts.length },
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    await postgrestPatch(`/ingestion_jobs?id=eq.${encodeURIComponent(jobId)}`, {
      status: "failed",
      error_message: error?.message || "ingest failed",
      updated_at: new Date().toISOString(),
    }).catch(() => {});
    throw error;
  }
  return { ok: true, dry_run: false, job_id: jobId, extracted: thoughts.length, thoughts, items };
}

async function handleRestIngestionJobs(url, id = null) {
  if (id) {
    const rows = await postgrestGet(`/ingestion_jobs?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    const job = rows[0];
    if (!job) throw httpError(404, "ingestion job not found");
    const items = await postgrestGet(
      `/ingestion_items?select=*&job_id=eq.${encodeURIComponent(id)}&order=created_at.asc&limit=500`
    );
    return {
      job,
      items,
      job_id: id,
      status: job.status || "unknown",
    };
  }
  const limit = url ? intFromSearch(url, "limit", 50, 1, 200) : 50;
  const offset = url ? intFromSearch(url, "offset", 0, 0, 1_000_000) : 0;
  const status = url?.searchParams.get("status");
  const filters = [
    "select=*",
    "order=created_at.desc",
    `limit=${limit}`,
    `offset=${offset}`,
  ];
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
  const jobs = await postgrestGet(`/ingestion_jobs?${filters.join("&")}`);
  return {
    jobs,
    count: jobs.length,
    status: "ok",
  };
}

async function handleRestIngestionJobExecute(id) {
  const rows = await postgrestGet(`/ingestion_jobs?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  const job = rows[0];
  if (!job) throw httpError(404, "ingestion job not found");
  if (["running", "complete", "failed"].includes(String(job.status || ""))) {
    return { job_id: id, status: job.status, job };
  }
  const patched = await postgrestPatch(`/ingestion_jobs?id=eq.${encodeURIComponent(id)}`, {
    status: "running",
    updated_at: new Date().toISOString(),
  });
  return { job_id: id, status: patched[0]?.status || "running", job: patched[0] || job };
}

function agentMemoryMetadata(row) {
  const metadata = validateMetadata(row.metadata);
  return validateMetadata(metadata.agent_memory);
}

function agentMemoryId(row) {
  return agentMemoryMetadata(row).memory_id || row.id;
}

function agentMemorySummary(row) {
  const metadata = validateMetadata(row.metadata);
  const agent = agentMemoryMetadata(row);
  return String(agent.summary || metadata.summary || row.content || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function isAgentMemoryThought(row) {
  const metadata = validateMetadata(row.metadata);
  return Boolean(
    metadata.agent_memory ||
      metadata.source === "agent_memory" ||
      metadata.source_type === "agent_memory" ||
      row.source_type === "agent_memory"
  );
}

function agentMemoryRecordFromThought(row) {
  const thought = normalizeThought(row);
  const metadata = validateMetadata(row.metadata);
  const agent = agentMemoryMetadata(row);
  const now = thought.created_at || new Date().toISOString();
  const reviewStatus = agent.review_status || "pending";
  const lifecycleStatus = agent.lifecycle_status || (reviewStatus === "rejected" ? "rejected" : "active");
  const provenanceStatus = agent.provenance_status || "observed";
  const confirmed = reviewStatus === "confirmed";
  return {
    id: agentMemoryId(row),
    thought_id: thought.id,
    workspace_id: agent.workspace_id || metadata.workspace_id || "ob1-staging",
    project_id: agent.project_id || metadata.project_id || null,
    channel_kind: agent.channel_kind || null,
    channel_id: agent.channel_id || null,
    channel_thread_id: agent.channel_thread_id || null,
    visibility: agent.visibility || (agent.project_id || metadata.project_id ? "project" : "personal"),
    memory_type: agent.memory_type || thought.type || "work_log",
    summary: agentMemorySummary(row),
    content: thought.content,
    lifecycle_status: lifecycleStatus,
    provenance_status: provenanceStatus,
    confidence: Number.isFinite(Number(agent.confidence)) ? Number(agent.confidence) : 0.5,
    created_by: agent.created_by || "agent",
    runtime_name: agent.runtime_name || null,
    runtime_version: agent.runtime_version || null,
    provider: agent.provider || null,
    model: agent.model || null,
    task_id: agent.task_id || metadata.task_id || null,
    flow_id: agent.flow_id || null,
    can_use_as_instruction: Boolean(agent.can_use_as_instruction ?? confirmed),
    can_use_as_evidence: agent.can_use_as_evidence !== false,
    requires_user_confirmation: Boolean(agent.requires_user_confirmation ?? !confirmed),
    review_status: reviewStatus,
    last_confirmed_at: agent.last_confirmed_at || null,
    stale_after: agent.stale_after || null,
    idempotency_key: agent.idempotency_key || null,
    content_hash: agent.content_hash || metadata.content_hash || null,
    metadata,
    created_at: now,
    updated_at: thought.updated_at || now,
    agent_memory_source_refs: Array.isArray(agent.source_refs) ? agent.source_refs.map((source, index) => ({
      id: `${agentMemoryId(row)}:source:${index}`,
      memory_id: agentMemoryId(row),
      source_kind: source.kind || source.source_kind || "unknown",
      uri: source.uri || null,
      title: source.title || null,
      source_timestamp: source.timestamp || source.source_timestamp || null,
      metadata: validateMetadata(source.metadata),
      created_at: now,
    })) : [],
    agent_memory_artifacts: Array.isArray(agent.artifacts) ? agent.artifacts.map((artifact, index) => ({
      id: `${agentMemoryId(row)}:artifact:${index}`,
      memory_id: agentMemoryId(row),
      artifact_kind: artifact.kind || artifact.artifact_kind || "artifact",
      uri: artifact.uri || "",
      description: artifact.description || null,
      metadata: validateMetadata(artifact.metadata),
      created_at: now,
    })) : [],
  };
}

function agentMemoryFromThought(row) {
  const memory = agentMemoryRecordFromThought(row);
  return {
    memory_id: memory.id,
    summary: memory.summary,
    content: memory.content,
    source: {
      kind: "agent_memory",
      uri: null,
      title: memory.summary,
      timestamp: memory.created_at,
    },
    provenance: {
      status: memory.provenance_status,
      confidence: memory.confidence,
      created_by: memory.created_by,
      model: memory.model,
      runtime: memory.runtime_name,
    },
    scope: {
      workspace_id: memory.workspace_id,
      project_id: memory.project_id,
      channel_id: memory.channel_id,
      visibility: memory.visibility,
    },
    use_policy: {
      can_use_as_instruction: memory.can_use_as_instruction,
      can_use_as_evidence: memory.can_use_as_evidence,
      requires_user_confirmation: memory.requires_user_confirmation,
    },
    freshness: {
      created_at: memory.created_at,
      last_confirmed_at: memory.last_confirmed_at,
      stale_after: memory.stale_after,
    },
    related_artifacts: memory.agent_memory_artifacts.map((artifact) => ({
      kind: artifact.artifact_kind,
      uri: artifact.uri,
    })),
  };
}

function agentMemoryFromRecord(memory) {
  const metadata = validateMetadata(memory.metadata);
  const agent = validateMetadata(metadata.agent_memory);
  const sourceRefs = Array.isArray(metadata.source_refs)
    ? metadata.source_refs
    : Array.isArray(agent.source_refs)
      ? agent.source_refs
      : [];
  const artifacts = Array.isArray(metadata.artifacts)
    ? metadata.artifacts
    : Array.isArray(agent.artifacts)
      ? agent.artifacts
      : [];
  return {
    memory_id: memory.id,
    summary: memory.summary || "",
    content: memory.content || "",
    source: {
      kind: "agent_memory",
      uri: sourceRefs[0]?.uri || null,
      title: memory.summary || null,
      timestamp: memory.created_at || null,
    },
    provenance: {
      status: memory.provenance_status || "observed",
      confidence: Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : 0.5,
      created_by: memory.created_by || "agent",
      model: memory.model || null,
      runtime: memory.runtime_name || null,
    },
    scope: {
      workspace_id: memory.workspace_id || "ob1-staging",
      project_id: memory.project_id || null,
      channel_id: memory.channel_id || null,
      visibility: memory.visibility || "project",
    },
    use_policy: {
      can_use_as_instruction: memory.can_use_as_instruction === true,
      can_use_as_evidence: memory.can_use_as_evidence !== false,
      requires_user_confirmation: memory.requires_user_confirmation !== false,
    },
    freshness: {
      created_at: memory.created_at || null,
      last_confirmed_at: memory.last_confirmed_at || null,
      stale_after: memory.stale_after || null,
    },
    related_artifacts: artifacts.map((artifact) => ({
      kind: artifact.kind || artifact.artifact_kind || "artifact",
      uri: artifact.uri || null,
    })),
  };
}

function agentMemoryTableRow(memory) {
  return {
    id: memory.id,
    source_system: memory.source_system || "aegis_local_brain",
    source_id: memory.source_id || memory.id,
    thought_id: textOrNull(memory.thought_id),
    workspace_id: textOrNull(memory.workspace_id) || "ob1-staging",
    project_id: textOrNull(memory.project_id),
    channel_kind: textOrNull(memory.channel_kind),
    channel_id: textOrNull(memory.channel_id),
    channel_thread_id: textOrNull(memory.channel_thread_id),
    visibility: textOrNull(memory.visibility) || "project",
    memory_type: textOrNull(memory.memory_type) || "work_log",
    summary: textOrNull(memory.summary) || "",
    content: textOrNull(memory.content) || "",
    lifecycle_status: textOrNull(memory.lifecycle_status) || "active",
    provenance_status: textOrNull(memory.provenance_status) || "generated",
    confidence: numberOrNull(memory.confidence) ?? 0.5,
    created_by: textOrNull(memory.created_by) || "agent",
    runtime_name: textOrNull(memory.runtime_name),
    runtime_version: textOrNull(memory.runtime_version),
    provider: textOrNull(memory.provider),
    model: textOrNull(memory.model),
    task_id: textOrNull(memory.task_id),
    flow_id: textOrNull(memory.flow_id),
    can_use_as_instruction: memory.can_use_as_instruction === true,
    can_use_as_evidence: memory.can_use_as_evidence !== false,
    requires_user_confirmation: memory.requires_user_confirmation !== false,
    review_status: textOrNull(memory.review_status) || "pending",
    last_confirmed_at: textOrNull(memory.last_confirmed_at),
    stale_after: textOrNull(memory.stale_after),
    idempotency_key: textOrNull(memory.idempotency_key),
    content_hash: textOrNull(memory.content_hash),
    metadata: validateMetadata(memory.metadata),
    row_data: memory.row_data || memory,
    backup_file: textOrNull(memory.backup_file),
    created_at: textOrNull(memory.created_at) || new Date().toISOString(),
    updated_at: textOrNull(memory.updated_at) || new Date().toISOString(),
  };
}

async function upsertAgentMemoryRecord(memory) {
  const rows = await postgrestPost(
    "/agent_memories?on_conflict=id",
    [agentMemoryTableRow(memory)],
    { Prefer: "resolution=merge-duplicates,return=representation" }
  );
  return rows?.[0] || agentMemoryTableRow(memory);
}

async function auditAgentMemory(eventType, payload) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const row = {
    id,
    source_system: "aegis_local_brain",
    source_id: id,
    event_type: eventType,
    workspace_id: textOrNull(payload.workspace_id),
    project_id: textOrNull(payload.project_id),
    memory_id: textOrNull(payload.memory_id),
    trace_id: textOrNull(payload.trace_id),
    actor_kind: textOrNull(payload.actor_kind) || "system",
    actor_label: textOrNull(payload.actor_label),
    runtime_name: textOrNull(payload.runtime_name),
    task_id: textOrNull(payload.task_id),
    payload,
    row_data: payload,
    created_at: now,
  };
  await postgrestPost(
    "/agent_memory_audit_events?on_conflict=source_id",
    [row],
    { Prefer: "resolution=merge-duplicates,return=minimal" }
  );
  return row;
}

function memoryVisibleForRecall(memory, body) {
  const scope = validateMetadata(body.scope);
  const includeUnconfirmed = scope.include_unconfirmed === true;
  const includeStale = scope.include_stale === true;
  const projectOnly = scope.project_only === true;
  if (memory.workspace_id !== (body.workspace_id || "ob1-staging")) return false;
  if (projectOnly && body.project_id && memory.project_id !== body.project_id) return false;
  if (body.project_id && memory.project_id && memory.project_id !== body.project_id) return false;
  if (!includeStale && ["stale", "superseded", "rejected"].includes(memory.lifecycle_status)) return false;
  if (!includeUnconfirmed && memory.review_status !== "confirmed" && memory.can_use_as_instruction !== true) return false;
  return true;
}

async function listRecallCandidateMemories(body) {
  const workspaceId = body.workspace_id || "ob1-staging";
  const params = [
    "select=*",
    `workspace_id=eq.${encodeURIComponent(workspaceId)}`,
    "order=created_at.desc",
    "limit=500",
  ];
  if (body.project_id) params.push(`project_id=eq.${encodeURIComponent(body.project_id)}`);
  return postgrestGet(`/agent_memories?${params.join("&")}`);
}

async function listAgentMemoryRows(url, { reviewOnly = false } = {}) {
  const workspaceId = url.searchParams.get("workspace_id");
  if (!workspaceId) throw httpError(400, "workspace_id is required");
  const projectId = url.searchParams.get("project_id");
  const reviewStatus = reviewOnly ? "pending" : url.searchParams.get("review_status");
  const lifecycleStatus = url.searchParams.get("lifecycle_status");
  const runtimeName = url.searchParams.get("runtime_name");
  const memoryType = url.searchParams.get("memory_type");
  const taskPrefix = url.searchParams.get("task_id_prefix");
  const limit = intFromSearch(url, "limit", 50, 1, 200);

  const params = [
    "select=*",
    `workspace_id=eq.${encodeURIComponent(workspaceId)}`,
    "order=created_at.desc",
    `limit=${limit}`,
  ];
  if (projectId) params.push(`project_id=eq.${encodeURIComponent(projectId)}`);
  if (reviewStatus) params.push(`review_status=eq.${encodeURIComponent(reviewStatus)}`);
  if (lifecycleStatus) params.push(`lifecycle_status=eq.${encodeURIComponent(lifecycleStatus)}`);
  if (runtimeName) params.push(`runtime_name=eq.${encodeURIComponent(runtimeName)}`);
  if (memoryType) params.push(`memory_type=eq.${encodeURIComponent(memoryType)}`);
  if (taskPrefix) params.push(`task_id=like.${encodeURIComponent(`${taskPrefix}%`)}`);
  return postgrestGet(`/agent_memories?${params.join("&")}`);
}

function handleAgentMemoryHealth() {
  return {
    ok: true,
    service: "aegis-local-agent-memory",
    backing_store: "agent_memories",
    trace_store: "agent_memory_recall_traces",
    audit_store: "agent_memory_audit_events",
    mode: "first_class_local",
  };
}

async function handleAgentMemories(url, opts = {}) {
  const rows = await listAgentMemoryRows(url, opts);
  return { memories: rows.map(agentMemoryFromRecord), count: rows.length };
}

async function findAgentMemoryRow(id) {
  const rows = await postgrestGet(`/agent_memories?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows[0] || null;
}

async function handleAgentMemoryById(id) {
  const row = await findAgentMemoryRow(id);
  if (!row) throw httpError(404, "memory not found");
  return { memory: row };
}

function unsafeReasons(text) {
  const reasons = [];
  if (/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/.test(text)) reasons.push("private_key");
  if (/(?:sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9_-]{20,})/.test(text)) reasons.push("api_key");
  if (/(?:password|passwd|secret|token)\s*[:=]\s*\S{12,}/i.test(text)) reasons.push("credential_like_string");
  if (text.length > 15000) reasons.push("oversized_memory");
  return reasons;
}

function agentMemoryPayloadRows(payload) {
  const memoryPayload = validateMetadata(payload.memory_payload);
  const rows = [];
  for (const [memory_type, key] of [
    ["decision", "decisions"],
    ["output", "outputs"],
    ["lesson", "lessons"],
    ["constraint", "constraints"],
    ["open_question", "unresolved_questions"],
    ["failure", "failures"],
  ]) {
    if (Array.isArray(memoryPayload[key])) {
      for (const content of memoryPayload[key]) rows.push({ memory_type, content: String(content || "").trim() });
    }
  }
  if (Array.isArray(memoryPayload.next_steps)) {
    for (const content of memoryPayload.next_steps) rows.push({ memory_type: "work_log", content: `Next step: ${content}`.trim() });
  }
  if (Array.isArray(memoryPayload.artifacts)) {
    for (const artifact of memoryPayload.artifacts) {
      const uri = String(artifact?.uri || "").trim();
      if (uri) rows.push({ memory_type: "artifact_reference", content: `${artifact.kind || "artifact"}: ${artifact.description || uri}\n${uri}` });
    }
  }
  return rows.filter((row) => row.content);
}

function agentMemoryResponseSchema(schemaVersion, kind) {
  const openclaw = String(schemaVersion || "").includes("openclaw");
  if (kind === "writeback") {
    return openclaw ? "openbrain.openclaw.writeback_response.v1" : "openbrain.agent_memory.writeback_response.v1";
  }
  return openclaw ? "openbrain.openclaw.recall_response.v1" : "openbrain.agent_memory.recall_response.v1";
}

async function handleAgentMemoryWriteback(body) {
  const rows = agentMemoryPayloadRows(body);
  if (!rows.length) throw httpError(400, "memory_payload produced no memory rows");
  const unsafe = rows.flatMap((row) => unsafeReasons(row.content).map((reason) => ({ reason, memory_type: row.memory_type })));
  if (unsafe.length) {
    await auditAgentMemory("memory_rejected", {
      workspace_id: body.workspace_id || "ob1-staging",
      project_id: body.project_id || null,
      runtime_name: validateMetadata(body.runtime).name || null,
      task_id: body.task_id || null,
      actor_kind: "system",
      reason: "unsafe_writeback",
      unsafe,
    });
    const error = httpError(422, "Unsafe write-back blocked");
    error.payload = { error: "Unsafe write-back blocked", unsafe };
    throw error;
  }

  const workspaceId = body.workspace_id || "ob1-staging";
  const projectId = body.project_id || null;
  const runtime = validateMetadata(body.runtime);
  const provenance = validateMetadata(body.provenance);
  const sourceRefs = Array.isArray(body.source_refs) ? body.source_refs : [];
  const modelsUsed = Array.isArray(body.models_used) ? body.models_used : [];
  const primaryModel = modelsUsed[0] || {};
  const memoryPayload = validateMetadata(body.memory_payload);
  const artifacts = Array.isArray(memoryPayload.artifacts) ? memoryPayload.artifacts : [];
  const memories = [];
  for (const [index, row] of rows.entries()) {
    const memoryId = crypto.randomUUID();
    const contentHash = crypto.createHash("sha256").update(`${row.memory_type}:${row.content}`).digest("hex");
    const reviewStatus = provenance.requires_review === false ? "confirmed" : "pending";
    const provenanceStatus = provenance.default_status || "generated";
    const createdBy = provenanceStatus === "imported" ? "import" : "agent";
    const canUseAsInstruction = ["user_confirmed", "imported"].includes(provenanceStatus) && provenance.requires_review === false;
    const now = new Date().toISOString();
    let thoughtId = null;
    if (AGENT_MEMORY_CAPTURE_THOUGHTS) {
      const capture = await handleCapture({
        content: row.content,
        type: row.memory_type,
        source_type: "agent_memory",
        metadata: {
          source: "agent_memory",
          source_type: "agent_memory",
          type: row.memory_type,
          workspace_id: workspaceId,
          project_id: projectId,
          task_id: body.task_id || null,
          content_hash: contentHash,
          agent_memory: { memory_id: memoryId },
        },
      });
      thoughtId = capture.id;
    }
    const directMemory = {
      id: memoryId,
      thought_id: thoughtId,
      workspace_id: workspaceId,
      project_id: projectId,
      channel_kind: validateMetadata(body.channel).kind || null,
      channel_id: validateMetadata(body.channel).id || null,
      channel_thread_id: validateMetadata(body.channel).thread_id || null,
      visibility: projectId ? "project" : "personal",
      memory_type: row.memory_type,
      summary: row.content.replace(/\s+/g, " ").trim().slice(0, 140),
      content: row.content,
      lifecycle_status: "active",
      provenance_status: provenanceStatus,
      confidence: Number.isFinite(Number(provenance.confidence)) ? Number(provenance.confidence) : 0.5,
      created_by: createdBy,
      runtime_name: runtime.name || null,
      runtime_version: runtime.version || null,
      provider: primaryModel.provider || null,
      model: primaryModel.model || null,
      task_id: body.task_id || null,
      flow_id: body.flow_id || null,
      can_use_as_instruction: canUseAsInstruction,
      can_use_as_evidence: true,
      requires_user_confirmation: provenance.requires_review !== false,
      review_status: reviewStatus,
      last_confirmed_at: reviewStatus === "confirmed" ? now : null,
      stale_after: null,
      idempotency_key: body.idempotency_key ? `${body.idempotency_key}:${index}` : null,
      content_hash: contentHash,
      created_at: now,
      updated_at: now,
      metadata: {
        source: "agent_memory",
        source_type: "agent_memory",
        source_refs: sourceRefs,
        artifacts,
        models_used: modelsUsed,
        retention: validateMetadata(body.retention),
        writeback_schema_version: body.schema_version || null,
      },
    };
    const memory = await upsertAgentMemoryRecord({
      ...directMemory,
      id: memoryId,
      source_system: "aegis_local_brain",
      source_id: memoryId,
      row_data: directMemory,
    });
    await auditAgentMemory("memory_written", {
      workspace_id: workspaceId,
      project_id: projectId,
      memory_id: memory.id,
      runtime_name: runtime.name || null,
      task_id: body.task_id || null,
      actor_kind: "agent",
      provenance_status: memory.provenance_status,
      review_status: memory.review_status,
    });
    memories.push(agentMemoryFromRecord(memory));
  }
  return {
    schema_version: agentMemoryResponseSchema(body.schema_version, "writeback"),
    memories,
  };
}

async function handleAgentMemoryRecall(body) {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) throw httpError(400, "query is required");
  const workspaceId = body.workspace_id || "ob1-staging";
  const maxItems = clampInt(validateMetadata(body.limits).max_items, 10, 1, 50);
  const rows = await listRecallCandidateMemories({ ...body, workspace_id: workspaceId });
  const ranked = rows
    .filter((memory) => memoryVisibleForRecall(memory, { ...body, workspace_id: workspaceId }))
    .map((memory) => {
      const similarity = tokenSimilarity(query, memory.content || memory.summary || "");
      const recency = memory.review_status === "confirmed" ? 0.2 : 0;
      return { memory, similarity, ranking_score: similarity + recency };
    })
    .sort((a, b) => b.ranking_score - a.ranking_score)
    .slice(0, maxItems);
  const traceId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const runtime = validateMetadata(body.runtime);
  const channel = validateMetadata(body.channel);
  await postgrestPost(
    "/agent_memory_recall_traces?on_conflict=request_id",
    [{
      id: traceId,
      request_id: requestId,
      workspace_id: workspaceId,
      project_id: body.project_id || null,
      runtime_name: runtime.name || null,
      runtime_version: runtime.version || null,
      task_id: body.task_id || null,
      flow_id: body.flow_id || null,
      channel_kind: channel.kind || null,
      channel_id: channel.id || null,
      query,
      schema_version: body.schema_version || "openbrain.agent_memory.recall.v1",
      request_payload: body,
      response_policy: {
        max_items: maxItems,
        include_unconfirmed: validateMetadata(body.scope).include_unconfirmed === true,
      },
    }],
    { Prefer: "resolution=merge-duplicates,return=minimal" }
  );
  if (ranked.length) {
    await postgrestPost(
      "/agent_memory_recall_items?on_conflict=trace_id,memory_id",
      ranked.map(({ memory, similarity, ranking_score }, index) => ({
        id: crypto.randomUUID(),
        trace_id: traceId,
        memory_id: memory.id,
        rank: index + 1,
        similarity,
        ranking_score,
        returned: true,
        use_policy_snapshot: {
          can_use_as_instruction: memory.can_use_as_instruction === true,
          can_use_as_evidence: memory.can_use_as_evidence !== false,
          requires_user_confirmation: memory.requires_user_confirmation !== false,
        },
      })),
      { Prefer: "resolution=merge-duplicates,return=minimal" }
    );
  }
  await auditAgentMemory("recall_requested", {
    workspace_id: workspaceId,
    project_id: body.project_id || null,
    trace_id: traceId,
    runtime_name: runtime.name || null,
    task_id: body.task_id || null,
    returned_count: ranked.length,
  });
  return {
    schema_version: agentMemoryResponseSchema(body.schema_version, "recall"),
    request_id: requestId,
    memories: ranked.map(({ memory }) => agentMemoryFromRecord(memory)),
  };
}

async function handleAgentMemoryReview(id, body) {
  const row = await findAgentMemoryRow(id);
  if (!row) throw httpError(404, "memory not found");
  const action = typeof body.action === "string" ? body.action : "";
  const updates = {
    review_status: row.review_status || "pending",
    lifecycle_status: row.lifecycle_status || "active",
  };
  if (action === "confirm") {
    updates.review_status = "confirmed";
    updates.provenance_status = "user_confirmed";
    updates.can_use_as_instruction = true;
    updates.requires_user_confirmation = false;
    updates.last_confirmed_at = new Date().toISOString();
  } else if (action === "evidence_only") {
    updates.review_status = "evidence_only";
    updates.can_use_as_instruction = false;
    updates.can_use_as_evidence = true;
    updates.requires_user_confirmation = false;
  } else if (action === "reject") {
    updates.review_status = "rejected";
    updates.lifecycle_status = "rejected";
    updates.can_use_as_instruction = false;
    updates.can_use_as_evidence = false;
  } else if (action === "mark_stale") {
    updates.review_status = "stale";
    updates.lifecycle_status = "stale";
    updates.can_use_as_instruction = false;
  } else if (action === "restrict_scope") {
    updates.review_status = "restricted";
    updates.visibility = body.visibility || "personal";
  } else if (action === "edit") {
    if (typeof body.content === "string" && body.content.trim()) updates.content = body.content.trim();
    if (typeof body.summary === "string" && body.summary.trim()) updates.summary = body.summary.trim();
  } else if (action === "dispute") {
    updates.lifecycle_status = "disputed";
    updates.provenance_status = "disputed";
    updates.can_use_as_instruction = false;
  } else if (!["merge", "supersede"].includes(action)) {
    throw httpError(400, "invalid review action");
  }
  const patched = await postgrestPatch(`/agent_memories?id=eq.${encodeURIComponent(row.id)}`, {
    ...updates,
    updated_at: new Date().toISOString(),
  });
  const after = patched[0] || row;
  const eventMap = {
    confirm: "memory_confirmed",
    edit: "memory_edited",
    reject: "memory_rejected",
    supersede: "memory_superseded",
    dispute: "memory_disputed",
  };
  await auditAgentMemory(eventMap[action] || "memory_edited", {
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    memory_id: row.id,
    actor_kind: "user",
    actor_label: body.actor_label || null,
    action,
    before: row,
    after,
  });
  return { memory: after };
}

async function handleAgentMemoryUsage(requestId, body) {
  const traces = await postgrestGet(
    `/agent_memory_recall_traces?select=*&request_id=eq.${encodeURIComponent(requestId)}&limit=1`
  );
  const trace = traces[0];
  if (!trace) throw httpError(404, "recall trace not found");
  const usedIds = Array.isArray(body.used_memory_ids) ? body.used_memory_ids.map(String) : [];
  const ignored = Array.isArray(body.ignored) ? body.ignored : [];
  for (const memoryId of usedIds) {
    await postgrestPatch(
      `/agent_memory_recall_items?trace_id=eq.${encodeURIComponent(trace.id)}&memory_id=eq.${encodeURIComponent(memoryId)}`,
      { used: true, ignored_reason: null }
    );
    await auditAgentMemory("memory_used", {
      workspace_id: trace.workspace_id,
      project_id: trace.project_id,
      trace_id: trace.id,
      memory_id: memoryId,
      runtime_name: trace.runtime_name,
      task_id: trace.task_id,
    });
  }
  for (const item of ignored) {
    const memoryId = textOrNull(item?.memory_id);
    if (!memoryId) continue;
    await postgrestPatch(
      `/agent_memory_recall_items?trace_id=eq.${encodeURIComponent(trace.id)}&memory_id=eq.${encodeURIComponent(memoryId)}`,
      { used: false, ignored_reason: textOrNull(item.reason) }
    );
    await auditAgentMemory("memory_ignored", {
      workspace_id: trace.workspace_id,
      project_id: trace.project_id,
      trace_id: trace.id,
      memory_id: memoryId,
      reason: textOrNull(item.reason),
    });
  }
  return { ok: true };
}

async function handleAgentMemoryTrace(requestId) {
  const traces = await postgrestGet(
    `/agent_memory_recall_traces?select=*&request_id=eq.${encodeURIComponent(requestId)}&limit=1`
  );
  const trace = traces[0];
  if (!trace) throw httpError(404, "recall trace not found");
  const items = await postgrestGet(
    `/agent_memory_recall_items?select=*&trace_id=eq.${encodeURIComponent(trace.id)}&order=rank.asc`
  );
  return { trace, items };
}

async function handleAgentMemoryAuditEvents(url) {
  const params = ["select=*", "order=created_at.desc", `limit=${intFromSearch(url, "limit", 50, 1, 200)}`];
  const workspaceId = url.searchParams.get("workspace_id");
  const projectId = url.searchParams.get("project_id");
  const memoryId = url.searchParams.get("memory_id");
  const traceId = url.searchParams.get("trace_id");
  const eventType = url.searchParams.get("event_type");
  if (workspaceId) params.push(`workspace_id=eq.${encodeURIComponent(workspaceId)}`);
  if (projectId) params.push(`project_id=eq.${encodeURIComponent(projectId)}`);
  if (memoryId) params.push(`memory_id=eq.${encodeURIComponent(memoryId)}`);
  if (traceId) params.push(`trace_id=eq.${encodeURIComponent(traceId)}`);
  if (eventType) params.push(`event_type=eq.${encodeURIComponent(eventType)}`);
  const events = await postgrestGet(`/agent_memory_audit_events?${params.join("&")}`);
  return { events, count: events.length };
}

function extractMcpArgs(body) {
  const params = validateMetadata(body.params);
  return validateMetadata(params.arguments);
}

function formatSearchMatches(query, matches) {
  if (!matches.length) return `No thoughts found matching "${query}".`;
  const results = matches.map((thought, index) => {
    const metadata = validateMetadata(thought.metadata);
    const parts = [
      `--- Result ${index + 1} (${(Number(thought.similarity || 0) * 100).toFixed(1)}% match) ---`,
      `Captured: ${thought.created_at ? new Date(thought.created_at).toLocaleDateString() : "unknown"}`,
      `Type: ${metadata.type || thought.type || "unknown"}`,
    ];
    if (Array.isArray(metadata.topics) && metadata.topics.length) parts.push(`Topics: ${metadata.topics.join(", ")}`);
    if (Array.isArray(metadata.people) && metadata.people.length) parts.push(`People: ${metadata.people.join(", ")}`);
    if (Array.isArray(metadata.action_items) && metadata.action_items.length) {
      parts.push(`Actions: ${metadata.action_items.join("; ")}`);
    }
    parts.push(`\n${thought.content}`);
    return parts.join("\n");
  });
  return `Found ${matches.length} thought(s):\n\n${results.join("\n\n")}`;
}

function thoughtMatchesFilters(thought, { type, topic, person, days }) {
  const metadata = validateMetadata(thought.metadata);
  if (type && metadata.type !== type && thought.type !== type) return false;
  if (topic && !(Array.isArray(metadata.topics) && metadata.topics.includes(topic))) return false;
  if (person && !(Array.isArray(metadata.people) && metadata.people.includes(person))) return false;
  if (days) {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    if (!thought.created_at || new Date(thought.created_at).getTime() < since) return false;
  }
  return true;
}

async function mcpSearch(args) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw httpError(400, "query is required");
  const result = await handleSearch({
    query,
    match_count: clampInt(args.limit, 10, 1, 100),
    match_threshold: typeof args.threshold === "number" ? args.threshold : 0.5,
    filter: validateMetadata(args.filter),
  });
  return formatSearchMatches(query, result.matches || []);
}

async function mcpList(args) {
  const limit = clampInt(args.limit, 10, 1, 100);
  const overFetch = Math.min(1000, Math.max(limit * 10, limit));
  const rows = await listThoughtRows({ limit: overFetch, offset: 0 });
  const filtered = rows
    .filter((thought) => thoughtMatchesFilters(thought, args))
    .slice(0, limit);
  if (!filtered.length) return "No thoughts found.";
  const results = filtered.map((thought, index) => {
    const metadata = validateMetadata(thought.metadata);
    const tags = Array.isArray(metadata.topics) ? metadata.topics.join(", ") : "";
    const type = metadata.type || thought.type || "??";
    const date = thought.created_at ? new Date(thought.created_at).toLocaleDateString() : "unknown";
    return `${index + 1}. [${date}] (${type}${tags ? " - " + tags : ""})\n   ${thought.content}`;
  });
  return `${filtered.length} recent thought(s):\n\n${results.join("\n\n")}`;
}

async function mcpStats() {
  const [total, rows] = await Promise.all([
    thoughtCount(),
    listThoughtRows({ limit: 1000, offset: 0 }),
  ]);
  const types = {};
  const topics = {};
  const people = {};
  for (const row of rows) {
    const metadata = validateMetadata(row.metadata);
    const type = metadata.type || row.type;
    if (type) types[type] = (types[type] || 0) + 1;
    if (Array.isArray(metadata.topics)) {
      for (const topic of metadata.topics) topics[topic] = (topics[topic] || 0) + 1;
    }
    if (Array.isArray(metadata.people)) {
      for (const person of metadata.people) people[person] = (people[person] || 0) + 1;
    }
  }
  const sortEntries = (entries) => Object.entries(entries).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const dated = rows.filter((row) => row.created_at);
  const oldest = dated[dated.length - 1]?.created_at;
  const newest = dated[0]?.created_at;
  const lines = [
    `Total thoughts: ${total}`,
    `Date range: ${oldest && newest ? `${new Date(oldest).toLocaleDateString()} → ${new Date(newest).toLocaleDateString()}` : "N/A"}`,
    "",
    "Types:",
    ...sortEntries(types).map(([key, value]) => `  ${key}: ${value}`),
  ];
  if (Object.keys(topics).length) {
    lines.push("", "Top topics:");
    for (const [key, value] of sortEntries(topics)) lines.push(`  ${key}: ${value}`);
  }
  if (Object.keys(people).length) {
    lines.push("", "People mentioned:");
    for (const [key, value] of sortEntries(people)) lines.push(`  ${key}: ${value}`);
  }
  return lines.join("\n");
}

async function mcpCapture(args) {
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) throw httpError(400, "content is required");
  const result = await handleCapture({
    content,
    metadata: {
      source: args.source || "mcp",
      task_id: args.task_id,
      ...validateMetadata(args.metadata),
    },
  });
  return `Captured as thought ${result.id}`;
}

async function mcpFetch(args) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) throw httpError(400, "id is required");
  const thought = await getThoughtById(id);
  if (!thought) return `Fetch error: thought ${id} not found`;
  return JSON.stringify({
    id: thought.id,
    title: thoughtTitle(thought.content, thought.created_at),
    text: thought.content,
    url: thoughtUrl(thought.id),
    metadata: {
      ...validateMetadata(thought.metadata),
      created_at: thought.created_at,
      updated_at: thought.updated_at,
    },
  });
}

async function mcpSearchCompat(args) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw httpError(400, "query is required");
  const result = await handleSearch({ query, match_count: 10, match_threshold: 0.5, filter: {} });
  const results = (result.matches || []).map((thought) => ({
    id: thought.id,
    title: thoughtTitle(thought.content, thought.created_at),
    url: thoughtUrl(thought.id),
  }));
  return JSON.stringify({ results });
}

function mcpToolList() {
  return {
    tools: [
      { name: "search", description: "Search Open Brain memories by meaning." },
      { name: "fetch", description: "Fetch one Open Brain thought by ID." },
      { name: "search_thoughts", description: "Search captured thoughts by meaning." },
      { name: "list_thoughts", description: "List recently captured thoughts." },
      { name: "thought_stats", description: "Get a summary of captured thoughts." },
      { name: "capture_thought", description: "Save a new thought to the local Aegis brain." },
    ],
  };
}

async function callMcpTool(name, args) {
  switch (name) {
    case "search":
      return mcpSearchCompat(args);
    case "fetch":
      return mcpFetch(args);
    case "search_thoughts":
      return mcpSearch(args);
    case "list_thoughts":
      return mcpList(args);
    case "thought_stats":
      return mcpStats();
    case "capture_thought":
      return mcpCapture(args);
    default:
      throw httpError(404, `unknown tool: ${name}`);
  }
}

async function handleOpenBrainMcp(body) {
  const id = body.id ?? null;
  if (body.method === "initialize") {
    return {
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "aegis-local-brain", version: "1.0.0" },
        capabilities: { tools: {} },
      },
      jsonrpc: "2.0",
      id,
    };
  }
  if (body.method === "tools/list") {
    return { result: mcpToolList(), jsonrpc: "2.0", id };
  }
  if (body.method !== "tools/call") return jsonRpcError(id, -32601, `method not found: ${body.method}`);
  const params = validateMetadata(body.params);
  const name = typeof params.name === "string" ? params.name : "";
  const resultText = await callMcpTool(name, extractMcpArgs(body));
  return jsonRpcResult(id, resultText);
}

function normalizedPath(pathname) {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

function thoughtSubroute(path, suffix) {
  const cleanSuffix = suffix.replace(/^\//, "");
  const match = path.match(new RegExp(`^/thought/([^/]+)/${cleanSuffix}$`));
  return match ? decodeURIComponent(match[1]) : null;
}

function agentMemoryPath(path) {
  if (path === "/agent-memory-api") return "/";
  if (path.startsWith("/agent-memory-api/")) return path.slice("/agent-memory-api".length) || "/";
  return path;
}

function localRoutePath(path) {
  const restPrefix = "/functions/v1/open-brain-rest";
  const memoryPrefix = "/functions/v1/agent-memory-api";
  if (path === restPrefix) return "/";
  if (path.startsWith(`${restPrefix}/`)) return path.slice(restPrefix.length) || "/";
  if (path === memoryPrefix) return "/agent-memory-api";
  if (path.startsWith(`${memoryPrefix}/`)) return `/agent-memory-api${path.slice(memoryPrefix.length)}`;
  return path;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = localRoutePath(normalizedPath(url.pathname));
  const memoryPath = agentMemoryPath(path);

  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method === "GET" && (path === "/health" || path === "/functions/v1/health")) {
    return sendJson(res, 200, {
      ok: true,
      status: "ok",
      service: "aegis-local-brain",
      embedding_model: EMBED_MODEL,
      embedding_dim: EMBED_DIM,
    });
  }

  if (!authenticated(req, url)) return sendJson(res, 401, { ok: false, error: "unauthorized" });

  try {
    if (req.method === "POST" && (path === "/capture" || path === "/functions/v1/capture")) {
      return sendJson(res, 200, await handleCapture(await readJson(req)));
    }
    if (req.method === "POST" && (path === "/search" || path === "/functions/v1/search")) {
      const body = await readJson(req);
      const dashboardShape =
        body.mode !== undefined || body.page !== undefined || body.limit !== undefined || body.threshold !== undefined;
      return sendJson(res, 200, dashboardShape ? await handleRestSearch(body) : await handleSearch(body));
    }
    if (req.method === "GET" && path.startsWith("/agent-memory-api") && memoryPath === "/health") {
      return sendJson(res, 200, handleAgentMemoryHealth());
    }
    if (req.method === "GET" && memoryPath === "/memories/review") {
      return sendJson(res, 200, await handleAgentMemories(url, { reviewOnly: true }));
    }
    if (req.method === "GET" && memoryPath === "/memories") {
      return sendJson(res, 200, await handleAgentMemories(url));
    }
    const memoryReviewMatch = memoryPath.match(/^\/memories\/([^/]+)\/review$/);
    if (req.method === "PATCH" && memoryReviewMatch) {
      return sendJson(res, 200, await handleAgentMemoryReview(decodeURIComponent(memoryReviewMatch[1]), await readJson(req)));
    }
    const memoryMatch = memoryPath.match(/^\/memories\/([^/]+)$/);
    if (req.method === "GET" && memoryMatch) {
      return sendJson(res, 200, await handleAgentMemoryById(decodeURIComponent(memoryMatch[1])));
    }
    if (req.method === "POST" && memoryPath === "/recall") {
      return sendJson(res, 200, await handleAgentMemoryRecall(await readJson(req)));
    }
    if (req.method === "POST" && memoryPath === "/writeback") {
      return sendJson(res, 200, await handleAgentMemoryWriteback(await readJson(req)));
    }
    const recallUsageMatch = memoryPath.match(/^\/recall\/([^/]+)\/usage$/);
    if (req.method === "POST" && recallUsageMatch) {
      return sendJson(res, 200, await handleAgentMemoryUsage(decodeURIComponent(recallUsageMatch[1]), await readJson(req)));
    }
    const recallTraceMatch = memoryPath.match(/^\/recall-traces\/([^/]+)$/);
    if (req.method === "GET" && recallTraceMatch) {
      return sendJson(res, 200, await handleAgentMemoryTrace(decodeURIComponent(recallTraceMatch[1])));
    }
    if (req.method === "GET" && memoryPath === "/audit-events") {
      return sendJson(res, 200, await handleAgentMemoryAuditEvents(url));
    }
    if (req.method === "GET" && path === "/stats") return sendJson(res, 200, await handleRestStats(url));
    if (req.method === "GET" && path === "/count") return sendJson(res, 200, await handleRestCount(url));
    if (req.method === "GET" && path === "/backup/archive/count") {
      return sendJson(res, 200, await handleBackupArchiveCount(url));
    }
    if (req.method === "GET" && path === "/backup/first-class/count") {
      return sendJson(res, 200, await handleFirstClassSideTableCount(url));
    }
    if (req.method === "POST" && path === "/backup/archive") {
      return sendJson(res, 200, await handleBackupArchive(await readJson(req)));
    }
    if (req.method === "GET" && path === "/thoughts") return sendJson(res, 200, await handleRestThoughts(url));
    if (req.method === "POST" && path === "/duplicates/resolve") {
      return sendJson(res, 200, await handleRestDuplicateResolve(await readJson(req)));
    }
    if (req.method === "GET" && path === "/duplicates") return sendJson(res, 200, await handleRestDuplicates(url));
    const connectionThoughtId = thoughtSubroute(path, "/connections");
    if (req.method === "GET" && connectionThoughtId) {
      return sendJson(res, 200, await handleRestThoughtConnections(connectionThoughtId, url));
    }
    const reflectionThoughtId = thoughtSubroute(path, "/reflection");
    if (req.method === "GET" && reflectionThoughtId) {
      return sendJson(res, 200, await handleRestThoughtReflection(reflectionThoughtId));
    }
    if (req.method === "POST" && reflectionThoughtId) {
      return sendJson(res, 200, await handleRestThoughtReflection(reflectionThoughtId, await readJson(req)));
    }
    if (req.method === "GET" && path === "/ingestion-jobs") {
      return sendJson(res, 200, await handleRestIngestionJobs(url));
    }
    const ingestionJobExecuteMatch = path.match(/^\/ingestion-jobs\/([^/]+)\/execute$/);
    if (req.method === "POST" && ingestionJobExecuteMatch) {
      return sendJson(res, 200, await handleRestIngestionJobExecute(decodeURIComponent(ingestionJobExecuteMatch[1])));
    }
    const ingestionJobMatch = path.match(/^\/ingestion-jobs\/([^/]+)$/);
    if (req.method === "GET" && ingestionJobMatch) {
      return sendJson(res, 200, await handleRestIngestionJobs(url, decodeURIComponent(ingestionJobMatch[1])));
    }
    if (req.method === "POST" && path === "/ingest") return sendJson(res, 200, await handleRestIngest(await readJson(req)));
    if ((req.method === "GET" || req.method === "PUT" || req.method === "DELETE") && path.startsWith("/thought/")) {
      const thoughtId = decodeURIComponent(path.slice("/thought/".length));
      if (req.method === "GET") return sendJson(res, 200, await handleRestThoughtById(thoughtId));
      if (req.method === "PUT") return sendJson(res, 200, await handleRestThoughtUpdate(thoughtId, await readJson(req)));
      return sendJson(res, 200, await handleRestThoughtDelete(thoughtId));
    }
    if (req.method === "GET" && (path === "/list" || path === "/functions/v1/list")) {
      return sendJson(res, 200, await handleList(url));
    }
    if (req.method === "POST" && (path === "/open-brain-mcp" || path === "/functions/v1/open-brain-mcp")) {
      return sendJson(res, 200, await handleOpenBrainMcp(await readJson(req)));
    }
    return sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    return sendJson(res, error.status || 500, publicError(error));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`aegis-local-brain listening on ${PORT}`);
});
