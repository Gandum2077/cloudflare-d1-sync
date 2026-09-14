import { SQL } from "./service";
import {
  ApiError,
  ENTITY_TABLES,
  type EntityTable,
  FULL_SYNC_COMPLETE_GRACE_MS,
  FULL_SYNC_LEASE_MS,
  FULL_SYNC_MAX_AGE_MS,
  MAX_ACTIVE_FULL_SYNCS,
  MAX_FULL_SYNC_LIMIT,
  MAX_PAGE_BYTES,
  SCHEMA_VERSION,
  type FullSyncSessionRow,
  type JsonObject,
  isJsonObject,
} from "./types";
import {
  assertObject,
  assertOnlyKeys,
  canonicalJson,
  integerInRange,
  parseLimit,
  readJsonBody,
  requiredString,
  sha256Hex,
} from "./validation";

interface FullCursor {
  v: number;
  session: string;
  schema: number;
  table_order: number;
  last_id: string | null;
  terminal: boolean;
}

interface FullDataRow {
  table_order: number;
  table_name: EntityTable;
  entity_id: string;
  entity_json: string;
  entity_bytes: number;
}

interface FullChangeRow {
  change_seq: number;
  entity_table: EntityTable;
  operation: "create" | "update" | "delete";
  payload_json: string | null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new ApiError(400, "INVALID_CURSOR", "cursor is malformed");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "cursor is malformed");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encodeCursor(cursor: FullCursor): Promise<string> {
  const json = canonicalJson({
    v: cursor.v,
    session: cursor.session,
    schema: cursor.schema,
    table_order: cursor.table_order,
    last_id: cursor.last_id,
    terminal: cursor.terminal,
  });
  const checksum = await sha256Hex(json);
  return bytesToBase64Url(new TextEncoder().encode(`${json}.${checksum}`));
}

async function decodeCursor(value: string): Promise<FullCursor> {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(value));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_CURSOR", "cursor is malformed");
  }
  const separator = decoded.lastIndexOf(".");
  if (separator < 0) throw new ApiError(400, "INVALID_CURSOR", "cursor is malformed");
  const json = decoded.slice(0, separator);
  const checksum = decoded.slice(separator + 1);
  if (checksum !== (await sha256Hex(json))) {
    throw new ApiError(400, "INVALID_CURSOR", "cursor checksum does not match");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "cursor is malformed");
  }
  if (!isJsonObject(parsed)) {
    throw new ApiError(400, "INVALID_CURSOR", "cursor is malformed");
  }
  if (
    parsed.v !== 1 ||
    typeof parsed.session !== "string" ||
    typeof parsed.schema !== "number" ||
    !Number.isSafeInteger(parsed.schema) ||
    typeof parsed.table_order !== "number" ||
    !Number.isSafeInteger(parsed.table_order) ||
    (parsed.last_id !== null && typeof parsed.last_id !== "string") ||
    typeof parsed.terminal !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_CURSOR", "cursor is malformed");
  }
  return {
    v: 1,
    session: parsed.session,
    schema: parsed.schema,
    table_order: parsed.table_order,
    last_id: parsed.last_id,
    terminal: parsed.terminal,
  };
}

function parseStoredObject(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ApiError(500, "INTERNAL_ERROR", "database returned invalid JSON");
  }
  if (!isJsonObject(parsed)) {
    throw new ApiError(500, "INTERNAL_ERROR", "database returned invalid JSON");
  }
  return parsed;
}

async function getSession(db: D1Database, sessionId: string, deviceId: string): Promise<FullSyncSessionRow> {
  const session = await db.prepare(SQL.fullSessionGet).bind(sessionId).first<FullSyncSessionRow>();
  if (session === null) throw new ApiError(404, "FULL_SYNC_NOT_FOUND", "full sync session not found");
  if (session.device_id !== deviceId) {
    throw new ApiError(403, "SESSION_DEVICE_MISMATCH", "full sync session belongs to another device");
  }
  return session;
}

async function expireSession(db: D1Database, session: FullSyncSessionRow): Promise<never> {
  await db.batch([
    db.prepare(SQL.fullExpireOne).bind(session.id),
    db.prepare(SQL.fullClearDevicePointer).bind(session.device_id, session.id),
  ]);
  throw new ApiError(410, "FULL_SYNC_EXPIRED", "full sync session has expired");
}

async function requireLiveSession(
  db: D1Database,
  session: FullSyncSessionRow,
  now: number,
): Promise<void> {
  if (session.schema_version !== SCHEMA_VERSION || session.expires_at <= now || session.phase === "expired") {
    await expireSession(db, session);
  }
}

function sessionStartJson(session: FullSyncSessionRow): JsonObject {
  return {
    session_id: session.id,
    phase: session.phase,
    baseline_seq: session.baseline_seq,
    schema_version: session.schema_version,
    expires_at: session.expires_at,
  };
}

export async function startFullSync(
  request: Request,
  db: D1Database,
  deviceId: string,
  now = Date.now(),
): Promise<JsonObject> {
  const raw = assertObject(await readJsonBody(request));
  assertOnlyKeys(raw, ["request_id"]);
  const requestId = requiredString(raw.request_id, "request_id", 1, 200);
  const priorRequest = await db
    .prepare(SQL.fullSessionByRequest)
    .bind(deviceId, requestId)
    .first<FullSyncSessionRow>();
  if (priorRequest !== null) {
    if (priorRequest.phase === "expired") throw new ApiError(410, "FULL_SYNC_EXPIRED", "full sync session has expired");
    return sessionStartJson(priorRequest);
  }

  const active = await db.prepare(SQL.activeSessionGet).bind(deviceId).first<FullSyncSessionRow>();
  if (active !== null) {
    if (active.expires_at > now) return sessionStartJson(active);
    await db.batch([
      db.prepare(SQL.fullExpireOne).bind(active.id),
      db.prepare(SQL.fullClearDevicePointer).bind(deviceId, active.id),
    ]);
  }

  const sessionId = crypto.randomUUID();
  const expiresAt = now + FULL_SYNC_LEASE_MS;
  try {
    const results = await db.batch<FullSyncSessionRow>([
      db.prepare(SQL.fullActiveCapacityAssert).bind(now, MAX_ACTIVE_FULL_SYNCS),
      db.prepare(SQL.fullStart).bind(sessionId, deviceId, requestId, expiresAt, now),
      db.prepare(SQL.fullSetDevicePointer).bind(sessionId, deviceId),
      db.prepare(SQL.assertionChanges),
      db.prepare(SQL.assertionClear),
      db.prepare(SQL.fullSessionGet).bind(sessionId),
    ]);
    const session = results[5]?.results[0];
    if (session === undefined) throw new ApiError(503, "DATABASE_UNAVAILABLE", "database is unavailable");
    return sessionStartJson(session);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const concurrent = await db
      .prepare(SQL.fullSessionByRequest)
      .bind(deviceId, requestId)
      .first<FullSyncSessionRow>();
    if (concurrent !== null) return sessionStartJson(concurrent);
    throw new ApiError(429, "RATE_LIMITED", "too many full sync sessions are active");
  }
}

export async function readFullSyncData(
  request: Request,
  db: D1Database,
  deviceId: string,
  now = Date.now(),
): Promise<JsonObject> {
  const raw = assertObject(await readJsonBody(request));
  assertOnlyKeys(raw, ["session_id", "cursor", "limit"]);
  const sessionId = requiredString(raw.session_id, "session_id", 1, 200);
  const limit = parseLimit(raw.limit, MAX_FULL_SYNC_LIMIT);
  if (raw.cursor !== null && typeof raw.cursor !== "string") {
    throw new ApiError(400, "INVALID_CURSOR", "cursor must be null or a string");
  }
  const session = await getSession(db, sessionId, deviceId);
  await requireLiveSession(db, session, now);
  if (session.phase !== "downloading") {
    throw new ApiError(409, "INVALID_FULL_SYNC_PHASE", "data can only be read while downloading");
  }

  const position =
    typeof raw.cursor === "string"
      ? await decodeCursor(raw.cursor)
      : { v: 1, session: sessionId, schema: session.schema_version, table_order: 1, last_id: null, terminal: false };
  if (
    position.session !== sessionId ||
    position.schema !== session.schema_version ||
    position.terminal ||
    position.table_order < 1 ||
    position.table_order > ENTITY_TABLES.length
  ) {
    throw new ApiError(400, "INVALID_CURSOR", "cursor does not match this full sync session");
  }

  const renewedExpiry = Math.min(now + FULL_SYNC_LEASE_MS, session.created_at + FULL_SYNC_MAX_AGE_MS);
  await db.prepare(SQL.fullRenew).bind(renewedExpiry, FULL_SYNC_MAX_AGE_MS, sessionId).run();
  const allRows: FullDataRow[] = [];
  let bytes = 0;
  for (const [index, table] of ENTITY_TABLES.entries()) {
    if (index + 1 < position.table_order) continue;
    const page = await db.prepare(SQL.entities[table].fullDataPage).bind(
      index + 1 === position.table_order ? position.last_id : null,
      limit + 1 - allRows.length,
      MAX_PAGE_BYTES - bytes,
    ).all<FullDataRow>();
    allRows.push(...page.results);
    bytes += page.results.reduce((sum, row) => sum + row.entity_bytes, 0);
    if (allRows.length > limit || bytes > MAX_PAGE_BYTES) break;
  }
  const hasMore = allRows.length > limit || bytes > MAX_PAGE_BYTES;
  const pageRows = hasMore ? allRows.slice(0, -1) : allRows;
  const rows: JsonObject[] = pageRows.map((row) => ({
    table: row.table_name,
    entity: parseStoredObject(row.entity_json),
  }));
  const last = pageRows.at(-1);
  const finalPosition: FullCursor = {
    v: 1,
    session: sessionId,
    schema: session.schema_version,
    table_order: last?.table_order ?? position.table_order,
    last_id: last?.entity_id ?? position.last_id,
    terminal: !hasMore,
  };
  const cursor = await encodeCursor(finalPosition);
  return {
    rows,
    next_cursor: hasMore ? cursor : null,
    has_more: hasMore,
    ...(hasMore ? {} : { terminal_cursor: cursor }),
    expires_at: renewedExpiry,
  };
}

export async function sealFullSync(
  request: Request,
  db: D1Database,
  deviceId: string,
  now = Date.now(),
): Promise<JsonObject> {
  const raw = assertObject(await readJsonBody(request));
  assertOnlyKeys(raw, ["session_id", "terminal_cursor"]);
  const sessionId = requiredString(raw.session_id, "session_id", 1, 200);
  const terminalCursor = await decodeCursor(
    requiredString(raw.terminal_cursor, "terminal_cursor", 1, 4096),
  );
  const session = await getSession(db, sessionId, deviceId);
  await requireLiveSession(db, session, now);
  if (
    terminalCursor.session !== sessionId ||
    terminalCursor.schema !== session.schema_version ||
    !terminalCursor.terminal
  ) {
    throw new ApiError(400, "INVALID_CURSOR", "terminal cursor does not match this session");
  }
  if (session.phase === "catching_up") {
    return { phase: session.phase, target_seq: session.target_seq };
  }
  if (session.phase !== "downloading") {
    throw new ApiError(409, "INVALID_FULL_SYNC_PHASE", "session cannot be sealed in its current phase");
  }
  await db.prepare(SQL.fullSeal).bind(sessionId, deviceId).run();
  const sealed = await getSession(db, sessionId, deviceId);
  return { phase: sealed.phase, target_seq: sealed.target_seq };
}

export async function readFullSyncChanges(
  request: Request,
  db: D1Database,
  deviceId: string,
  now = Date.now(),
): Promise<JsonObject> {
  const raw = assertObject(await readJsonBody(request));
  assertOnlyKeys(raw, ["session_id", "cursor", "limit"]);
  const sessionId = requiredString(raw.session_id, "session_id", 1, 200);
  const cursor = integerInRange(raw.cursor, "cursor", 0, Number.MAX_SAFE_INTEGER);
  const limit = parseLimit(raw.limit, MAX_FULL_SYNC_LIMIT);
  const session = await getSession(db, sessionId, deviceId);
  await requireLiveSession(db, session, now);
  if (session.phase !== "catching_up" || session.target_seq === null) {
    throw new ApiError(409, "INVALID_FULL_SYNC_PHASE", "changes can only be read after sealing");
  }
  if (cursor < session.baseline_seq || cursor > session.target_seq) {
    throw new ApiError(400, "INVALID_CURSOR", "cursor is outside the session change range");
  }

  const renewedExpiry = Math.min(now + FULL_SYNC_LEASE_MS, session.created_at + FULL_SYNC_MAX_AGE_MS);
  const results = await db.batch<FullChangeRow>([
    db.prepare(SQL.fullRenew).bind(renewedExpiry, FULL_SYNC_MAX_AGE_MS, sessionId),
    db.prepare(SQL.fullChanges).bind(cursor, session.target_seq, limit, MAX_PAGE_BYTES),
  ]);
  const rows = results[1]?.results ?? [];
  const changes: JsonObject[] = rows.map((row) => {
    if (row.payload_json === null) {
      throw new ApiError(500, "INTERNAL_ERROR", "full sync change payload is missing");
    }
    return {
      change_seq: row.change_seq,
      table: row.entity_table,
      operation: row.operation,
      payload: parseStoredObject(row.payload_json),
    };
  });
  const nextCursor = rows.at(-1)?.change_seq ?? session.target_seq;
  return {
    changes,
    next_cursor: nextCursor,
    target_seq: session.target_seq,
    has_more: nextCursor < session.target_seq,
    expires_at: renewedExpiry,
  };
}

export async function completeFullSync(
  request: Request,
  db: D1Database,
  deviceId: string,
  now = Date.now(),
): Promise<JsonObject> {
  const raw = assertObject(await readJsonBody(request));
  assertOnlyKeys(raw, ["session_id", "target_seq"]);
  const sessionId = requiredString(raw.session_id, "session_id", 1, 200);
  const targetSeq = integerInRange(raw.target_seq, "target_seq", 0, Number.MAX_SAFE_INTEGER);
  const session = await getSession(db, sessionId, deviceId);
  if (session.phase === "completed") {
    if (session.target_seq !== targetSeq) {
      throw new ApiError(400, "INVALID_CURSOR", "target_seq does not match the completed session");
    }
    return {
      session_id: session.id,
      phase: session.phase,
      acknowledged_cursor: session.target_seq,
    };
  }
  const withinGrace =
    session.target_seq === targetSeq && now <= session.expires_at + FULL_SYNC_COMPLETE_GRACE_MS;
  if (
    (session.phase !== "catching_up" && session.phase !== "expired") ||
    session.target_seq !== targetSeq ||
    !withinGrace
  ) {
    if (session.expires_at <= now) await expireSession(db, session);
    throw new ApiError(409, "INVALID_FULL_SYNC_PHASE", "session cannot be completed");
  }
  const device = await db.prepare(SQL.deviceGet).bind(deviceId).first<{ full_sync_session_id: string | null }>();
  if (device === null || (device.full_sync_session_id !== null && device.full_sync_session_id !== sessionId)) {
    throw new ApiError(409, "INVALID_FULL_SYNC_PHASE", "device has moved to another full sync session");
  }

  await db.batch([
    db.prepare(SQL.fullCompleteSession).bind(now, sessionId, deviceId, targetSeq),
    db.prepare(SQL.assertionChanges),
    db.prepare(SQL.fullCompleteDevice).bind(targetSeq, now, deviceId, sessionId),
    db.prepare(SQL.assertionChanges),
    db.prepare(SQL.assertionClear),
  ]);
  return {
    session_id: sessionId,
    phase: "completed",
    acknowledged_cursor: targetSeq,
  };
}
