import type { ResolvedRoute, RouteDefinition } from "./types";

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

export const SQL = {
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
        json_extract(value, '$.entity_id') AS entity_id
      FROM json_each(?)
    )
    SELECT i.op_index,
      CASE i.table_name
        WHEN 'bookmarks' THEN (SELECT json_object(
          'id', b.id, 'sync_version', b.sync_version, 'deleted', b.deleted,
          'server_updated_at', b.server_updated_at,
          'created_by_device_id', b.created_by_device_id,
          'updated_by_device_id', b.updated_by_device_id,
          'url', b.url, 'title', b.title, 'note', b.note, 'tags_json', b.tags_json
        ) FROM bookmarks b WHERE b.id = i.entity_id)
        WHEN 'settings' THEN (SELECT json_object(
          'id', s.id, 'sync_version', s.sync_version, 'deleted', s.deleted,
          'server_updated_at', s.server_updated_at,
          'created_by_device_id', s.created_by_device_id,
          'updated_by_device_id', s.updated_by_device_id,
          'value_json', s.value_json
        ) FROM settings s WHERE s.id = i.entity_id)
      END AS entity_json,
      (SELECT json_object(
        'op_id', p.op_id, 'batch_id', p.batch_id,
        'request_hash', p.request_hash, 'result_json', p.result_json
      ) FROM processed_ops p WHERE p.device_id = ? AND p.op_id = i.op_id) AS processed_json
    FROM input i ORDER BY i.op_index`,
  bookmarkProcessedOpInsert: `
    INSERT INTO processed_ops(
      device_id, op_id, batch_id, request_hash, result_status, result_json, server_updated_at
    ) SELECT ?, ?, ?, ?, 'applied', json_object(
      'op_id', ?, 'status', 'applied', 'entity_id', ?,
      'sync_version', b.sync_version, 'change_seq', last_insert_rowid()
    ), ? FROM bookmarks b WHERE b.id = ?`,
  settingProcessedOpInsert: `
    INSERT INTO processed_ops(
      device_id, op_id, batch_id, request_hash, result_status, result_json, server_updated_at
    ) SELECT ?, ?, ?, ?, 'applied', json_object(
      'op_id', ?, 'status', 'applied', 'entity_id', ?,
      'sync_version', s.sync_version, 'change_seq', last_insert_rowid()
    ), ? FROM settings s WHERE s.id = ?`,
  processedBatchInsert: `
    INSERT INTO processed_batches(device_id, batch_id, request_hash, result_json, server_updated_at)
    SELECT ?, ?, ?, COALESCE(
      (SELECT json_group_array(json(result_json)) FROM (
        SELECT result_json FROM processed_ops
        WHERE device_id = ? AND batch_id = ? ORDER BY rowid
      )), '[]'), ?
    RETURNING result_json`,

  bookmarkGet: `SELECT * FROM bookmarks WHERE id = ?`,
  bookmarkCreate: `
    INSERT INTO bookmarks(
      id, sync_version, deleted, server_updated_at, created_by_device_id,
      updated_by_device_id, url, title, note, tags_json
    ) VALUES (?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
  bookmarkUpdate: `
    UPDATE bookmarks SET
      sync_version = sync_version + 1,
      server_updated_at = ?, updated_by_device_id = ?,
      url = CASE WHEN ? = 1 THEN ? ELSE url END,
      title = CASE WHEN ? = 1 THEN ? ELSE title END,
      note = CASE WHEN ? = 1 THEN ? ELSE note END,
      tags_json = CASE WHEN ? = 1 THEN ? ELSE tags_json END
    WHERE id = ? AND sync_version = ? AND deleted = 0`,
  bookmarkUpsert: `
    INSERT INTO bookmarks(
      id, sync_version, deleted, server_updated_at, created_by_device_id,
      updated_by_device_id, url, title, note, tags_json
    ) VALUES (?, 0, 0, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sync_version = bookmarks.sync_version + 1, deleted = 0,
      server_updated_at = excluded.server_updated_at,
      updated_by_device_id = excluded.updated_by_device_id,
      url = CASE WHEN ? = 1 THEN excluded.url ELSE bookmarks.url END,
      title = CASE WHEN ? = 1 THEN excluded.title ELSE bookmarks.title END,
      note = CASE WHEN ? = 1 THEN excluded.note ELSE bookmarks.note END,
      tags_json = CASE WHEN ? = 1 THEN excluded.tags_json ELSE bookmarks.tags_json END`,
  bookmarkDelete: `
    UPDATE bookmarks SET sync_version = sync_version + 1, deleted = 1,
      server_updated_at = ?, updated_by_device_id = ?
    WHERE id = ? AND sync_version = ? AND deleted = 0`,
  bookmarkChangeInsert: `
    INSERT INTO changes(
      entity_table, entity_id, entity_sync_version, operation, payload_json, device_id, updated_at
    )
    SELECT 'bookmarks', id, sync_version,
      CASE WHEN ? = 'upsert' THEN CASE WHEN sync_version = 0 THEN 'create' ELSE 'update' END ELSE ? END,
      CASE WHEN EXISTS(
        SELECT 1 FROM full_sync_sessions
        WHERE phase IN ('downloading', 'catching_up') AND expires_at > ?
      ) THEN json_object(
        'id', id, 'sync_version', sync_version, 'deleted', deleted,
        'server_updated_at', server_updated_at,
        'created_by_device_id', created_by_device_id,
        'updated_by_device_id', updated_by_device_id,
        'url', url, 'title', title, 'note', note, 'tags_json', tags_json
      ) ELSE NULL END,
      ?, ? FROM bookmarks WHERE id = ?`,

  settingGet: `SELECT * FROM settings WHERE id = ?`,
  settingCreate: `
    INSERT INTO settings(
      id, sync_version, deleted, server_updated_at, created_by_device_id,
      updated_by_device_id, value_json
    ) VALUES (?, 0, 0, ?, ?, ?, ?)`,
  settingUpdate: `
    UPDATE settings SET sync_version = sync_version + 1,
      server_updated_at = ?, updated_by_device_id = ?, value_json = ?
    WHERE id = ? AND sync_version = ? AND deleted = 0`,
  settingUpsert: `
    INSERT INTO settings(
      id, sync_version, deleted, server_updated_at, created_by_device_id,
      updated_by_device_id, value_json
    ) VALUES (?, 0, 0, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sync_version = settings.sync_version + 1, deleted = 0,
      server_updated_at = excluded.server_updated_at,
      updated_by_device_id = excluded.updated_by_device_id,
      value_json = CASE WHEN ? = 1 THEN excluded.value_json ELSE settings.value_json END`,
  settingDelete: `
    UPDATE settings SET sync_version = sync_version + 1, deleted = 1,
      server_updated_at = ?, updated_by_device_id = ?
    WHERE id = ? AND sync_version = ? AND deleted = 0`,
  settingChangeInsert: `
    INSERT INTO changes(
      entity_table, entity_id, entity_sync_version, operation, payload_json, device_id, updated_at
    )
    SELECT 'settings', id, sync_version,
      CASE WHEN ? = 'upsert' THEN CASE WHEN sync_version = 0 THEN 'create' ELSE 'update' END ELSE ? END,
      CASE WHEN EXISTS(
        SELECT 1 FROM full_sync_sessions
        WHERE phase IN ('downloading', 'catching_up') AND expires_at > ?
      ) THEN json_object(
        'id', id, 'sync_version', sync_version, 'deleted', deleted,
        'server_updated_at', server_updated_at,
        'created_by_device_id', created_by_device_id,
        'updated_by_device_id', updated_by_device_id,
        'value_json', value_json
      ) ELSE NULL END,
      ?, ? FROM settings WHERE id = ?`,
  // A single statement fixes the response watermark and resolves nullable change payloads
  // against the same primary snapshot.
  pullChanges: `
    WITH watermark AS (
      SELECT COALESCE(MAX(change_seq), 0) AS highwater FROM changes
    ), page AS (
      SELECT c.change_seq, c.entity_table, c.operation,
        COALESCE(c.payload_json,
          CASE c.entity_table
            WHEN 'bookmarks' THEN (SELECT json_object(
              'id', b.id, 'sync_version', b.sync_version, 'deleted', b.deleted,
              'server_updated_at', b.server_updated_at,
              'created_by_device_id', b.created_by_device_id,
              'updated_by_device_id', b.updated_by_device_id,
              'url', b.url, 'title', b.title, 'note', b.note, 'tags_json', b.tags_json
            ) FROM bookmarks b WHERE b.id = c.entity_id)
            WHEN 'settings' THEN (SELECT json_object(
              'id', s.id, 'sync_version', s.sync_version, 'deleted', s.deleted,
              'server_updated_at', s.server_updated_at,
              'created_by_device_id', s.created_by_device_id,
              'updated_by_device_id', s.updated_by_device_id,
              'value_json', s.value_json
            ) FROM settings s WHERE s.id = c.entity_id)
          END
        ) AS payload_json
      FROM changes c, watermark w
      WHERE c.change_seq > ? AND c.change_seq <= w.highwater
      ORDER BY c.change_seq LIMIT ?
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
  fullDataPage: `
    SELECT table_order, table_name, entity_id, entity_json FROM (
      SELECT 1 AS table_order, 'bookmarks' AS table_name, b.id AS entity_id,
        json_object(
          'id', b.id, 'sync_version', b.sync_version, 'deleted', b.deleted,
          'server_updated_at', b.server_updated_at,
          'created_by_device_id', b.created_by_device_id,
          'updated_by_device_id', b.updated_by_device_id,
          'url', b.url, 'title', b.title, 'note', b.note, 'tags_json', b.tags_json
        ) AS entity_json
      FROM bookmarks b WHERE 1 > ? OR (1 = ? AND b.id > ?)
      UNION ALL
      SELECT 2, 'settings', s.id,
        json_object(
          'id', s.id, 'sync_version', s.sync_version, 'deleted', s.deleted,
          'server_updated_at', s.server_updated_at,
          'created_by_device_id', s.created_by_device_id,
          'updated_by_device_id', s.updated_by_device_id,
          'value_json', s.value_json
        )
      FROM settings s WHERE 2 > ? OR (2 = ? AND s.id > ?)
    ) ORDER BY table_order, entity_id LIMIT ?`,
  fullSeal: `
    UPDATE full_sync_sessions SET
      target_seq = COALESCE((SELECT MAX(change_seq) FROM changes), 0),
      phase = 'catching_up'
    WHERE id = ? AND device_id = ? AND phase = 'downloading'`,
  fullChanges: `
    SELECT change_seq, entity_table, operation, payload_json
    FROM changes
    WHERE change_seq > ? AND change_seq <= ?
    ORDER BY change_seq LIMIT ?`,
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
  cleanupBookmarkTombstones: `DELETE FROM bookmarks WHERE deleted = 1 AND server_updated_at < ?`,
  cleanupSettingTombstones: `DELETE FROM settings WHERE deleted = 1 AND server_updated_at < ?`,
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
