import { archiveParentId, exclusiveField, hasRequiredFields } from "./domain";
import { SQL } from "./service";
import {
  API_VERSION,
  MAX_PAGE_BYTES,
  ApiError,
  type ChangeResult,
  type DeviceRow,
  type JsonObject,
  type OperationResult,
  type SyncOperation,
  type SyncRequestBody,
  isEntityTable,
  isJsonObject,
} from "./types";
import { canonicalJson, operationHashInput, sha256Hex } from "./validation";
import { planWriteCleanup } from "./cleanup";

interface ProcessedBatchRow {
  request_hash: string;
  result_json: string;
}

interface PullRow {
  highwater: number;
  changes_json: string;
  next_cursor: number;
}

interface PreflightEntry {
  operation: SyncOperation;
  entity: EntityState | null;
  requestHash: string;
}

interface EntityState {
  syncVersion: number;
  deleted: number;
  json: JsonObject;
}

interface PreflightRow {
  op_index: number;
  entity_json: string | null;
  processed_json: string | null;
  parent_exists: number;
  has_children: number;
  exclusive_owner: string | null;
}

function parseJsonObject(value: string): JsonObject {
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

function parseEntityState(value: string): EntityState {
  const json = parseJsonObject(value);
  if (typeof json.sync_version !== "number" || typeof json.deleted !== "number") {
    throw new ApiError(500, "INTERNAL_ERROR", "database returned an invalid entity");
  }
  return { syncVersion: json.sync_version, deleted: json.deleted, json };
}

function parseOperationResults(value: string, replayed: boolean): OperationResult[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new ApiError(500, "INTERNAL_ERROR", "database returned invalid results");
  return parsed.map((item) => {
    if (!isJsonObject(item)) {
      throw new ApiError(500, "INTERNAL_ERROR", "database returned invalid operation result");
    }
    if (
      typeof item.op_id !== "string" ||
      typeof item.entity_id !== "string" ||
      typeof item.sync_version !== "number" ||
      typeof item.change_seq !== "number"
    ) {
      throw new ApiError(500, "INTERNAL_ERROR", "database returned invalid operation result");
    }
    return {
      op_id: item.op_id,
      status: replayed ? "replayed" : "applied",
      entity_id: item.entity_id,
      sync_version: item.sync_version,
      change_seq: item.change_seq,
    };
  });
}

function preflightError(operation: SyncOperation, entity: EntityState | null): JsonObject | null {
  if (operation.operation === "create") {
    if (!hasRequiredFields(operation.table, operation.data)) {
      return { op_id: operation.op_id, code: "INVALID_REQUEST", message: "create is missing required fields" };
    }
    if (entity !== null) {
      return { op_id: operation.op_id, code: "CONFLICT", current_entity: entity.json };
    }
    return null;
  }

  if (operation.operation === "upsert") {
    if (entity === null && !hasRequiredFields(operation.table, operation.data)) {
      return {
        op_id: operation.op_id,
        code: "INVALID_REQUEST",
        message: "upsert create branch is missing required fields",
      };
    }
    return null;
  }

  if (entity === null) {
    return { op_id: operation.op_id, code: "ENTITY_NOT_FOUND" };
  }
  if (entity.deleted !== 0 || operation.base_sync_version !== entity.syncVersion) {
    return { op_id: operation.op_id, code: "CONFLICT", current_entity: entity.json };
  }
  return null;
}

async function preflightOperations(
  db: D1Database,
  deviceId: string,
  operations: SyncOperation[],
): Promise<PreflightEntry[]> {
  for (const operation of operations) {
    if (operation.table === "tag_access_count_v2" &&
      (operation.data?.device_id !== deviceId || operation.entity_id.split(":")[0] !== deviceId)) {
      throw new ApiError(400, "INVALID_REQUEST", "a device may only write its own counters");
    }
  }
  const operationHashes = await Promise.all(
    operations.map((operation) => sha256Hex(canonicalJson(operationHashInput(deviceId, operation)))),
  );
  const preflightRows = await db
    .prepare(SQL.batchPreflight)
    .bind(
      JSON.stringify(operations.map((operation) => ({
        op_id: operation.op_id,
        table: operation.table,
        entity_id: operation.entity_id,
        operation: operation.operation,
        parent_id: archiveParentId(operation.table, operation.entity_id),
      }))),
      deviceId,
    )
    .all<PreflightRow>();

  const errors: JsonObject[] = [];
  const entries: PreflightEntry[] = [];
  const exclusiveOwners = new Map<string, string | null>();
  for (const [index, operation] of operations.entries()) {
    const requestHash = operationHashes[index];
    const row = preflightRows.results[index];
    if (requestHash === undefined || row === undefined || row.op_index !== index) {
      throw new ApiError(500, "INTERNAL_ERROR", "operation preflight failed");
    }
    const entity = row.entity_json === null ? null : parseEntityState(row.entity_json);
    const processed = row.processed_json === null ? null : parseJsonObject(row.processed_json);
    if (processed !== null) {
      if (typeof processed.batch_id !== "string") {
        throw new ApiError(500, "INTERNAL_ERROR", "database returned invalid idempotency data");
      }
      errors.push({
        op_id: operation.op_id,
        code: "OP_ID_REUSED",
        original_batch_id: processed.batch_id,
      });
    } else {
      const error = preflightError(operation, entity);
      if (error !== null) errors.push(error);
      const parentId = archiveParentId(operation.table, operation.entity_id);
      if (parentId !== null && operation.operation !== "delete") {
        const earlierParent = entries.find((entry) => entry.operation.table === "archive_entries_v2" && entry.operation.entity_id === parentId);
        const parentExists = earlierParent === undefined ? row.parent_exists === 1 : earlierParent.operation.operation !== "delete";
        if (!parentExists) errors.push({ op_id: operation.op_id, code: "ENTITY_NOT_FOUND", message: "archive parent must exist before this operation" });
      }
      if (operation.table === "archive_entries_v2" && operation.operation === "delete") {
        const earlierChild = entries.some((entry) => entry.operation.operation !== "delete" &&
          archiveParentId(entry.operation.table, entry.operation.entity_id) === operation.entity_id);
        if (row.has_children === 1 || earlierChild) errors.push({ op_id: operation.op_id, code: "CONFLICT", message: "delete archive dependents before their parent" });
      }
      const exclusive = exclusiveField(operation.table);
      if (exclusive !== null) {
        if (!exclusiveOwners.has(operation.table)) exclusiveOwners.set(operation.table, row.exclusive_owner);
        const owner = exclusiveOwners.get(operation.table);
        const selected = operation.operation !== "delete" && (operation.data?.[exclusive] ?? entity?.json[exclusive] ?? 0) === 1;
        if (selected && owner !== null && owner !== operation.entity_id) {
          errors.push({ op_id: operation.op_id, code: "CONFLICT", message: "clear the existing selection before selecting another entity" });
        } else if (selected) exclusiveOwners.set(operation.table, operation.entity_id);
        else if (owner === operation.entity_id) exclusiveOwners.set(operation.table, null);
      }
    }
    entries.push({ operation, entity, requestHash });
  }

  if (errors.length > 0) {
    const hasReusedId = errors.some((error) => error.code === "OP_ID_REUSED");
    throw new ApiError(
      409,
      hasReusedId ? "OP_ID_REUSED" : "BATCH_REJECTED",
      hasReusedId ? "an op_id was already used by another batch" : "one or more operations were rejected",
      { operation_errors: errors },
    );
  }
  return entries;
}

function operationStatements(
  db: D1Database,
  entry: PreflightEntry,
  deviceId: string,
  batchId: string,
  now: number,
): D1PreparedStatement[] {
  const { operation, requestHash } = entry;
  const sql = SQL.entities[operation.table];
  const parameters: (string | number | null)[] = [
    operation.entity_id, JSON.stringify(operation.data ?? {}), now, deviceId,
  ];
  if (operation.operation === "update" || operation.operation === "delete") parameters.push(operation.base_sync_version);
  return [
    db.prepare(sql[operation.operation]).bind(...parameters),
    db.prepare(SQL.assertionChanges),
    db.prepare(sql.changeInsert).bind(operation.operation, operation.operation, now, deviceId, now, operation.entity_id),
    db.prepare(sql.processedOpInsert).bind(
      deviceId, operation.op_id, batchId, requestHash, operation.op_id, operation.entity_id, now, operation.entity_id,
    ),
  ];
}

function parseChanges(value: string): ChangeResult[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new ApiError(500, "INTERNAL_ERROR", "database returned invalid changes");
  return parsed.map((item) => {
    if (!isJsonObject(item)) {
      throw new ApiError(500, "INTERNAL_ERROR", "database returned an invalid change");
    }
    if (
      typeof item.change_seq !== "number" ||
      typeof item.table !== "string" ||
      !isEntityTable(item.table) ||
      (item.operation !== "create" && item.operation !== "update" && item.operation !== "delete") ||
      !isJsonObject(item.payload)
    ) {
      throw new ApiError(500, "INTERNAL_ERROR", "database returned an invalid change");
    }
    return {
      change_seq: item.change_seq,
      table: item.table,
      operation: item.operation,
      payload: item.payload,
    };
  });
}

function operationResultJson(result: OperationResult): JsonObject {
  return {
    op_id: result.op_id,
    status: result.status,
    entity_id: result.entity_id,
    sync_version: result.sync_version,
    change_seq: result.change_seq,
  };
}

function changeResultJson(change: ChangeResult): JsonObject {
  return {
    change_seq: change.change_seq,
    table: change.table,
    operation: change.operation,
    payload: change.payload,
  };
}

async function pullChanges(
  db: D1Database,
  cursor: number,
  limit: number,
): Promise<{ changes: ChangeResult[]; nextCursor: number; hasMore: boolean }> {
  const row = await db.prepare(SQL.pullChanges).bind(cursor, limit, MAX_PAGE_BYTES).first<PullRow>();
  if (row === null) throw new ApiError(503, "DATABASE_UNAVAILABLE", "database is unavailable");
  const changes = parseChanges(row.changes_json);
  return {
    changes,
    nextCursor: row.next_cursor,
    hasMore: row.next_cursor < row.highwater,
  };
}

async function batchHash(operations: SyncOperation[]): Promise<string> {
  return await sha256Hex(
    canonicalJson({
      api_version: API_VERSION,
      operations: operations.map((operation) => ({
        op_id: operation.op_id,
        table: operation.table,
        entity_id: operation.entity_id,
        operation: operation.operation,
        base_sync_version: operation.base_sync_version,
        ...(operation.data === undefined ? {} : { data: operation.data }),
      })),
    }),
  );
}

export async function executeSync(
  db: D1Database,
  device: DeviceRow,
  request: SyncRequestBody,
  now = Date.now(),
): Promise<JsonObject> {
  const profile = await db.prepare(SQL.profileInfo).first<{
    min_valid_change_seq: number;
    current_change_seq: number;
  }>();
  if (profile === null) throw new ApiError(503, "DATABASE_UNAVAILABLE", "database is unavailable");
  if (
    request.ack_cursor > request.cursor ||
    request.cursor > profile.current_change_seq
  ) {
    throw new ApiError(400, "INVALID_CURSOR", "ack_cursor and cursor are outside the current change range");
  }

  await db.prepare(SQL.deviceAck).bind(request.ack_cursor, now, device.id).run();

  const activeSession = await db.prepare(SQL.activeSessionGet).bind(device.id).first<{
    id: string;
    expires_at: number;
  }>();
  if (activeSession !== null) {
    if (activeSession.expires_at <= now) {
      await db.batch([
        db.prepare(SQL.fullExpireOne).bind(activeSession.id),
        db.prepare(SQL.fullClearDevicePointer).bind(device.id, activeSession.id),
      ]);
    } else {
      throw new ApiError(409, "FULL_SYNC_IN_PROGRESS", "a full sync is in progress for this device");
    }
  }

  if (request.cursor < profile.min_valid_change_seq) {
    throw new ApiError(410, "TABLE_RELOAD_REQUIRED", "incremental change history is no longer available");
  }

  let results: OperationResult[] = [];
  if (request.operations.length > 0) {
    const batchId = request.batch_id;
    if (batchId === undefined) throw new ApiError(400, "INVALID_REQUEST", "batch_id is required");
    const requestBatchHash = await batchHash(request.operations);
    const cached = await db
      .prepare(SQL.processedBatchGet)
      .bind(device.id, batchId)
      .first<ProcessedBatchRow>();
    if (cached !== null) {
      if (cached.request_hash !== requestBatchHash) {
        throw new ApiError(409, "BATCH_ID_REUSED", "batch_id was already used with different operations");
      }
      results = parseOperationResults(cached.result_json, true);
    } else {
      const cleanup = await planWriteCleanup(
        db,
        now,
        request.operations.length,
        request.operations.length,
        1,
      );
      if (cleanup.floor > request.cursor) {
        throw new ApiError(410, "TABLE_RELOAD_REQUIRED", "this batch would evict required change history");
      }

      const preflight = await preflightOperations(db, device.id, request.operations);
      const statements = [...cleanup.statements];
      for (const entry of preflight) {
        statements.push(...operationStatements(db, entry, device.id, batchId, now));
      }
      const batchResultIndex = statements.length;
      statements.push(
        db.prepare(SQL.processedBatchInsert).bind(
          device.id,
          batchId,
          requestBatchHash,
          device.id,
          batchId,
          now,
        ),
        db.prepare(SQL.assertionClear),
      );

      try {
        const batchResults = await db.batch<{ result_json?: string }>(statements);
        const resultJson = batchResults[batchResultIndex]?.results[0]?.result_json;
        if (typeof resultJson !== "string") {
          throw new ApiError(500, "INTERNAL_ERROR", "database did not return operation results");
        }
        results = parseOperationResults(resultJson, false);
      } catch (error) {
        const concurrent = await db
          .prepare(SQL.processedBatchGet)
          .bind(device.id, batchId)
          .first<ProcessedBatchRow>();
        if (concurrent !== null) {
          if (concurrent.request_hash !== requestBatchHash) {
            throw new ApiError(409, "BATCH_ID_REUSED", "batch_id was already used with different operations");
          }
          results = parseOperationResults(concurrent.result_json, true);
        } else {
          try {
            await preflightOperations(db, device.id, request.operations);
          } catch (diagnosed) {
            if (diagnosed instanceof ApiError) throw diagnosed;
          }
          if (error instanceof Error && /SQLITE_CONSTRAINT|constraint failed/iu.test(error.message)) {
            throw new ApiError(409, "BATCH_REJECTED", "a business constraint rejected this batch");
          }
          // Database errors may contain bound values; never log the raw error.
          console.error(JSON.stringify({ message: "atomic sync batch failed" }));
          throw new ApiError(503, "DATABASE_UNAVAILABLE", "database transaction failed; retry the same batch");
        }
      }
    }
  }

  const pulled = await pullChanges(db, request.cursor, request.limit);
  return {
    results: results.map(operationResultJson),
    changes: pulled.changes.map(changeResultJson),
    next_cursor: pulled.nextCursor,
    acknowledged_cursor: Math.max(device.last_ack_change_seq, request.ack_cursor),
    has_more: pulled.hasMore,
    server_time: now,
  };
}

export { parseJsonObject };
