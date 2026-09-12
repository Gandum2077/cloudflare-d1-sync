import { ENTITY_TABLES, type EntityTable, type ResolvedRoute, type RouteDefinition } from "./types";
import { ARCHIVE_STATE_TABLES, DOMAIN_FIELDS, type FieldRule } from "./domain";

// This file is the audit surface for every public route and every application SQL statement.
export const routes = {
  "GET /v1/health": { auth: "public", handler: "health" },
  "GET /v1/auth/verify": { auth: "master", handler: "verifyAuth" },
  "GET /v1/info": { auth: "device", handler: "info" },
  "POST /v1/devices/bind": { auth: "master", handler: "bindDevice" },
  "GET /v1/devices": { auth: "device", handler: "listDevices" },
  "POST /v1/sync": { auth: "device", handler: "sync" },
  "POST /v1/full-sync/start": { auth: "device", handler: "fullSyncStart" },
  "POST /v1/full-sync/data": { auth: "device", handler: "fullSyncData" },
  "POST /v1/full-sync/seal": { auth: "device", handler: "fullSyncSeal" },
  "POST /v1/full-sync/changes": { auth: "device", handler: "fullSyncChanges" },
  "POST /v1/full-sync/complete": { auth: "device", handler: "fullSyncComplete" },
} as const satisfies Record<string, RouteDefinition>;

export function resolveRoute(method: string, pathname: string): ResolvedRoute | null {
  const exact = routes[`${method} ${pathname}` as keyof typeof routes];
  if (exact !== undefined) return { ...exact, params: {} };

  const deviceMatch = pathname.match(/^\/v1\/devices\/([^/]+)$/);
  if (deviceMatch !== null && (method === "PATCH" || method === "DELETE")) {
    let id: string;
    try {
      id = decodeURIComponent(deviceMatch[1] ?? "");
    } catch {
      return null;
    }
    return {
      auth: "device",
      handler: method === "PATCH" ? "patchDevice" : "deleteDevice",
      params: { id },
    };
  }
  return null;
}

const commonColumns = ["id", "sync_version", "deleted", "server_updated_at", "created_by_device_id", "updated_by_device_id"];

function entityJson(table: EntityTable, alias = "e"): string {
  let json = `json_object(${commonColumns.map((column) => `'${column}', ${alias}.${column}`).join(", ")})`;
  const fields = Object.keys(DOMAIN_FIELDS[table]);
  // D1 limits functions to 32 arguments. json_set retains explicit SQL NULLs.
  for (let offset = 0; offset < fields.length; offset += 15) {
    json = `json_set(${json}, ${fields.slice(offset, offset + 15)
      .map((column) => `'$.${column}', ${alias}.${column}`).join(", ")})`;
  }
  return json;
}

// These SQL fragments are assembled once from the code-owned whitelist. Neither
// request values nor database registry values are interpolated into SQL text.
function dependentExists(input: string, excludeEarlierDeletes = false): string {
  const dependencies: readonly EntityTable[] = [...ARCHIVE_STATE_TABLES, "favorite_images_v2"];
  return dependencies.map((table) => {
    const match = table === "favorite_images_v2"
      ? `child.gid = CAST(${input}.entity_id AS INTEGER) AND CAST(child.gid AS TEXT) = ${input}.entity_id`
      : `child.id = ${input}.entity_id`;
    const excluded = excludeEarlierDeletes ? `AND NOT EXISTS (
      SELECT 1 FROM input earlier WHERE earlier.op_index < ${input}.op_index
        AND earlier.table_name = '${table}' AND earlier.entity_id = child.id AND earlier.operation = 'delete'
    )` : "";
    return `EXISTS (SELECT 1 FROM ${table} child WHERE ${match} AND child.deleted = 0 ${excluded})`;
  }).join(" OR ");
}

function entityStatements(table: EntityTable) {
  const fields = Object.entries(DOMAIN_FIELDS[table]);
  const input = `WITH input AS (SELECT ? AS entity_id, ? AS data, ? AS now, ? AS device_id)`;
  const has = (column: string) => `json_type(i.data, '$.${column}') IS NOT NULL`;
  const extract = (column: string) => `json_extract(i.data, '$.${column}')`;
  const fallback = (rule: FieldRule): string => {
    if (rule.default === undefined) return "NULL";
    return typeof rule.default === "number" ? String(rule.default) : `'${rule.default}'`;
  };
  const parent = table === "favorite_images_v2" ? "substr(i.entity_id, 1, instr(i.entity_id, ':') - 1)"
    : ARCHIVE_STATE_TABLES.some((name) => name === table) ? "i.entity_id" : null;
  const parentGuard = parent === null ? "1" : `EXISTS (
    SELECT 1 FROM archive_entries_v2 parent WHERE parent.id = ${parent} AND parent.deleted = 0
  )`;
  const columns = [...commonColumns, ...fields.map(([column]) => column)].join(", ");
  const insertValues = (existing: boolean) => [
    "i.entity_id", "0", "0", "i.now", "i.device_id", "i.device_id",
    ...fields.map(([column, rule]) => `CASE WHEN ${has(column)} THEN ${extract(column)} ELSE ${existing
      ? `CASE WHEN e.id IS NOT NULL THEN e.${column} ELSE ${fallback(rule)} END`
      : fallback(rule)} END`),
  ].join(", ");
  return {
    fullDataPage: `WITH candidates AS (
        SELECT ${ENTITY_TABLES.indexOf(table) + 1} AS table_order, '${table}' AS table_name,
          e.id AS entity_id, ${entityJson(table)} AS entity_json
        FROM ${table} e WHERE e.id > ?1 ORDER BY e.id LIMIT ?2
      ), sized AS (
        SELECT *, length(CAST(entity_json AS BLOB)) + 128 AS entity_bytes FROM candidates
      ), budgeted AS (
        SELECT *, SUM(entity_bytes) OVER (ORDER BY entity_id) AS page_bytes FROM sized
      ) SELECT * FROM budgeted WHERE page_bytes - entity_bytes <= ?3 ORDER BY entity_id`,
    create: `${input} INSERT INTO ${table} (${columns})
      SELECT ${insertValues(false)} FROM input i WHERE ${parentGuard}`,
    update: `${input} UPDATE ${table} SET
      sync_version = sync_version + 1, server_updated_at = i.now, updated_by_device_id = i.device_id
      ${fields.map(([column]) => `, ${column} = CASE WHEN ${has(column)} THEN ${extract(column)} ELSE ${column} END`).join("\n")}
      FROM input i WHERE id = i.entity_id AND sync_version = ? AND deleted = 0 AND ${parentGuard}`,
    upsert: `${input} INSERT INTO ${table} (${columns})
      SELECT ${insertValues(true)} FROM input i LEFT JOIN ${table} e ON e.id = i.entity_id WHERE ${parentGuard}
      ON CONFLICT(id) DO UPDATE SET
        sync_version = ${table}.sync_version + 1, deleted = 0,
        server_updated_at = excluded.server_updated_at, updated_by_device_id = excluded.updated_by_device_id
        ${fields.map(([column]) => `, ${column} = excluded.${column}`).join("\n")}`,
    delete: `${input} UPDATE ${table} SET sync_version = sync_version + 1, deleted = 1,
      server_updated_at = i.now, updated_by_device_id = i.device_id
      FROM input i WHERE id = i.entity_id AND sync_version = ? AND deleted = 0
      ${table === "archive_entries_v2" ? `AND NOT (${dependentExists("i")})` : ""}`,
    changeInsert: `INSERT INTO changes (
        entity_table, entity_id, entity_sync_version, operation, payload_json, device_id, updated_at
      ) SELECT '${table}', e.id, e.sync_version,
        CASE WHEN ? = 'upsert' THEN CASE WHEN e.sync_version = 0 THEN 'create' ELSE 'update' END ELSE ? END,
        CASE WHEN EXISTS (SELECT 1 FROM full_sync_sessions
          WHERE phase IN ('downloading', 'catching_up') AND expires_at > ?)
        THEN ${entityJson(table)} ELSE NULL END, ?, ? FROM ${table} e WHERE e.id = ?`,
    processedOpInsert: `INSERT INTO processed_ops (
        device_id, op_id, batch_id, request_hash, result_status, result_json, server_updated_at
      ) SELECT ?, ?, ?, ?, 'applied', json_object(
        'op_id', ?, 'status', 'applied', 'entity_id', ?,
        'sync_version', e.sync_version, 'change_seq', last_insert_rowid()
      ), ? FROM ${table} e WHERE e.id = ?`,
    cleanupTombstones: `DELETE FROM ${table} WHERE deleted = 1 AND server_updated_at < ?`,
  };
}

const entitySql = Object.fromEntries(ENTITY_TABLES.map((table) => [table, entityStatements(table)])) as
  Record<EntityTable, ReturnType<typeof entityStatements>>;

function entityLookup(tableExpression: string, idExpression: string): string {
  return `CASE ${tableExpression} ${ENTITY_TABLES.map((table) =>
    `WHEN '${table}' THEN (SELECT ${entityJson(table)} FROM ${table} e WHERE e.id = ${idExpression})`).join("\n")} END`;
}

export const SQL = {
  entities: entitySql,
  profileInfo: `
    SELECT p.schema_version, p.api_version, p.min_valid_change_seq,
           COALESCE((SELECT MAX(change_seq) FROM changes), 0) AS current_change_seq
    FROM profile p WHERE p.id = 1`,
  syncTables: `
    SELECT table_name, table_order, schema_version
    FROM sync_tables WHERE enabled = 1 ORDER BY table_order`,

  deviceGet: `SELECT * FROM devices WHERE id = ?`,
  deviceList: `SELECT * FROM devices ORDER BY deleted ASC, COALESCE(last_seen_at, 0) DESC, id ASC`,
  deviceTouch: `UPDATE devices SET last_seen_at = ? WHERE id = ? AND deleted = 0`,
  deviceCapacityAssert: `
    INSERT INTO tx_assertions(value)
    SELECT CASE WHEN EXISTS(SELECT 1 FROM devices WHERE id = ?)
      OR (SELECT COUNT(*) FROM devices WHERE deleted = 0) < ? THEN 1 ELSE 0 END`,
  deviceBind: `
    INSERT INTO devices(id, deleted, name, platform, app_version, last_seen_at, last_ack_change_seq, full_sync_session_id)
    VALUES (?, 0, ?, ?, ?, ?, 0, NULL)
    ON CONFLICT(id) DO UPDATE SET
      deleted = 0, name = excluded.name, platform = excluded.platform,
      app_version = excluded.app_version, last_seen_at = excluded.last_seen_at`,
  devicePatch: `
    UPDATE devices SET
      name = CASE WHEN ? = 1 THEN ? ELSE name END,
      platform = CASE WHEN ? = 1 THEN ? ELSE platform END,
      app_version = CASE WHEN ? = 1 THEN ? ELSE app_version END,
      last_seen_at = ?
    WHERE id = ? AND deleted = 0`,
  deviceExpireSessions: `
    UPDATE full_sync_sessions SET phase = 'expired'
    WHERE device_id = ? AND phase IN ('downloading', 'catching_up')`,
  deviceDelete: `
    UPDATE devices SET deleted = 1, full_sync_session_id = NULL, last_seen_at = ?
    WHERE id = ?`,
  deviceAck: `
    UPDATE devices SET last_ack_change_seq = MAX(last_ack_change_seq, ?), last_seen_at = ?
    WHERE id = ? AND deleted = 0`,

  assertionClear: `DELETE FROM tx_assertions`,
  assertionChanges: `INSERT INTO tx_assertions(value) VALUES (changes())`,

  rateLimitIncrement: `
    INSERT INTO rate_limits(scope, subject, window_start, request_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(scope, subject, window_start)
    DO UPDATE SET request_count = request_count + 1
    RETURNING request_count`,

  processedBatchGet: `
    SELECT request_hash, result_json FROM processed_batches
    WHERE device_id = ? AND batch_id = ?`,
  processedOpGet: `
    SELECT op_id, batch_id, request_hash, result_json FROM processed_ops
    WHERE device_id = ? AND op_id = ?`,
  batchPreflight: `
    WITH input AS (
      SELECT CAST(key AS INTEGER) AS op_index,
        json_extract(value, '$.op_id') AS op_id,
        json_extract(value, '$.table') AS table_name,
        json_extract(value, '$.entity_id') AS entity_id,
        json_extract(value, '$.operation') AS operation,
        json_extract(value, '$.parent_id') AS parent_id
      FROM json_each(?)
    )
    SELECT i.op_index, ${entityLookup("i.table_name", "i.entity_id")} AS entity_json,
      EXISTS (SELECT 1 FROM archive_entries_v2 parent WHERE parent.id = i.parent_id AND parent.deleted = 0) AS parent_exists,
      CASE WHEN i.table_name = 'archive_entries_v2' AND i.operation = 'delete'
        THEN (${dependentExists("i", true)}) ELSE 0 END AS has_children,
      CASE i.table_name
        WHEN 'ai_translation_services_v2' THEN (SELECT id FROM ai_translation_services_v2 WHERE selected = 1 AND deleted = 0)
        WHEN 'webdav_services_v2' THEN (SELECT id FROM webdav_services_v2 WHERE enabled = 1 AND deleted = 0)
      END AS exclusive_owner,
      (SELECT json_object(
        'op_id', p.op_id, 'batch_id', p.batch_id,
        'request_hash', p.request_hash, 'result_json', p.result_json
      ) FROM processed_ops p WHERE p.device_id = ? AND p.op_id = i.op_id) AS processed_json
    FROM input i ORDER BY i.op_index`,
  processedBatchInsert: `
    INSERT INTO processed_batches(device_id, batch_id, request_hash, result_json, server_updated_at)
    SELECT ?, ?, ?, COALESCE(
      (SELECT json_group_array(json(result_json)) FROM (
        SELECT result_json FROM processed_ops
        WHERE device_id = ? AND batch_id = ? ORDER BY rowid
      )), '[]'), ?
    RETURNING result_json`,

  // A single statement fixes the response watermark and resolves nullable change payloads
  // against the same primary snapshot.
  pullChanges: `
    WITH watermark AS (
      SELECT COALESCE(MAX(change_seq), 0) AS highwater FROM changes
    ), candidates AS (
      SELECT c.change_seq, c.entity_table, c.operation,
        COALESCE(c.payload_json,
          ${entityLookup("c.entity_table", "c.entity_id")}
        ) AS payload_json
      FROM changes c, watermark w
      WHERE c.change_seq > ? AND c.change_seq <= w.highwater
      ORDER BY c.change_seq LIMIT ?
    ), sized AS (
      SELECT *, SUM(length(CAST(payload_json AS BLOB)) + 256) OVER (ORDER BY change_seq) AS page_bytes
      FROM candidates
    ), page AS (
      SELECT * FROM sized WHERE page_bytes <= ? ORDER BY change_seq
    )
    SELECT w.highwater,
      COALESCE((SELECT json_group_array(json_object(
        'change_seq', change_seq, 'table', entity_table,
        'operation', operation, 'payload', json(payload_json)
      )) FROM page), '[]') AS changes_json,
      COALESCE((SELECT MAX(change_seq) FROM page), w.highwater) AS next_cursor
    FROM watermark w`,

  activeSessionGet: `
    SELECT * FROM full_sync_sessions
    WHERE device_id = ? AND phase IN ('downloading', 'catching_up')
    ORDER BY created_at DESC LIMIT 1`,
  fullSessionGet: `SELECT * FROM full_sync_sessions WHERE id = ?`,
  fullSessionByRequest: `
    SELECT * FROM full_sync_sessions WHERE device_id = ? AND start_request_id = ?`,
  fullExpireOne: `
    UPDATE full_sync_sessions SET phase = 'expired'
    WHERE id = ? AND phase IN ('downloading', 'catching_up')`,
  fullClearDevicePointer: `
    UPDATE devices SET full_sync_session_id = NULL
    WHERE id = ? AND full_sync_session_id = ?`,
  fullActiveCapacityAssert: `
    INSERT INTO tx_assertions(value)
    SELECT CASE WHEN (SELECT COUNT(*) FROM full_sync_sessions
      WHERE phase IN ('downloading', 'catching_up') AND expires_at > ?) < ?
      THEN 1 ELSE 0 END`,
  fullStart: `
    INSERT INTO full_sync_sessions(
      id, device_id, start_request_id, baseline_seq, target_seq,
      schema_version, phase, expires_at, created_at, completed_at
    ) SELECT ?, ?, ?, COALESCE(MAX(c.change_seq), 0), NULL,
      p.schema_version, 'downloading', ?, ?, NULL
    FROM profile p LEFT JOIN changes c ON 1 = 1 WHERE p.id = 1`,
  fullSetDevicePointer: `
    UPDATE devices SET full_sync_session_id = ? WHERE id = ? AND deleted = 0`,
  fullRenew: `
    UPDATE full_sync_sessions SET expires_at = MIN(?, created_at + ?)
    WHERE id = ? AND phase IN ('downloading', 'catching_up')`,
  fullSeal: `
    UPDATE full_sync_sessions SET
      target_seq = COALESCE((SELECT MAX(change_seq) FROM changes), 0),
      phase = 'catching_up'
    WHERE id = ? AND device_id = ? AND phase = 'downloading'`,
  fullChanges: `
    WITH candidates AS (
      SELECT change_seq, entity_table, operation, payload_json FROM changes
      WHERE change_seq > ? AND change_seq <= ? ORDER BY change_seq LIMIT ?
    ), sized AS (
      SELECT *, SUM(COALESCE(length(CAST(payload_json AS BLOB)), 0) + 256)
        OVER (ORDER BY change_seq) AS page_bytes FROM candidates
    ) SELECT change_seq, entity_table, operation, payload_json
      FROM sized WHERE page_bytes <= ? ORDER BY change_seq`,
  fullCompleteSession: `
    UPDATE full_sync_sessions SET phase = 'completed', completed_at = ?
    WHERE id = ? AND device_id = ? AND phase IN ('catching_up', 'expired') AND target_seq = ?`,
  fullCompleteDevice: `
    UPDATE devices SET full_sync_session_id = NULL,
      last_ack_change_seq = MAX(last_ack_change_seq, ?), last_seen_at = ?
    WHERE id = ? AND (full_sync_session_id = ? OR full_sync_session_id IS NULL)`,

  cleanupExpireByFloor: `
    UPDATE full_sync_sessions SET phase = 'expired'
    WHERE phase IN ('downloading', 'catching_up')
      AND (expires_at <= ? OR baseline_seq < ?)`,
  cleanupClearPointers: `
    UPDATE devices SET full_sync_session_id = NULL
    WHERE full_sync_session_id IN (
      SELECT id FROM full_sync_sessions WHERE phase = 'expired'
    )`,
  cleanupChanges: `DELETE FROM changes WHERE change_seq <= ?`,
  cleanupProfileFloor: `
    UPDATE profile SET min_valid_change_seq = MAX(min_valid_change_seq, ?) WHERE id = 1`,
  cleanupOpsByAge: `
    DELETE FROM processed_ops WHERE (device_id, batch_id) IN (
      SELECT device_id, batch_id FROM processed_batches WHERE server_updated_at < ?
    )`,
  cleanupBatchesByAge: `DELETE FROM processed_batches WHERE server_updated_at < ?`,
  cleanupOpsByCapacity: `
    DELETE FROM processed_ops WHERE (device_id, batch_id) NOT IN (
      SELECT device_id, batch_id FROM processed_batches
      ORDER BY server_updated_at DESC, device_id DESC, batch_id DESC LIMIT ?
    )`,
  cleanupBatchesByCapacity: `
    DELETE FROM processed_batches WHERE (device_id, batch_id) NOT IN (
      SELECT device_id, batch_id FROM processed_batches
      ORDER BY server_updated_at DESC, device_id DESC, batch_id DESC LIMIT ?
    )`,
  cleanupCompletedSessions: `
    DELETE FROM full_sync_sessions
    WHERE phase IN ('completed', 'expired') AND COALESCE(completed_at, expires_at) < ?`,
  cleanupRateLimits: `DELETE FROM rate_limits WHERE window_start < ?`,
  cleanupFloorPlan: `
    SELECT (SELECT COALESCE(MAX(change_seq), 0) FROM changes) AS current_change_seq,
      p.min_valid_change_seq,
      (SELECT COUNT(*) FROM changes) AS change_count,
      (SELECT MAX(c.change_seq) FROM changes c
        WHERE c.updated_at < ? OR c.change_seq NOT IN (
          SELECT change_seq FROM changes WHERE updated_at >= ?
          ORDER BY updated_at DESC, change_seq DESC LIMIT ?
        )) AS delete_through_change_seq,
      (SELECT COUNT(*) FROM processed_ops) AS processed_op_count,
      (SELECT COUNT(*) FROM processed_batches) AS processed_batch_count
    FROM profile p WHERE p.id = 1`,
} as const;
