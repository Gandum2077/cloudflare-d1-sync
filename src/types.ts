export const API_VERSION = 1;
export const SCHEMA_VERSION = 1;
export const MAX_REQUEST_BYTES = 128 * 1024;
export const MAX_OPERATIONS = 8;
export const MAX_SYNC_LIMIT = 200;
export const MAX_FULL_SYNC_LIMIT = 500;
export const MAX_ACTIVE_FULL_SYNCS = 3;
export const FULL_SYNC_LEASE_MS = 15 * 60 * 1000;
export const FULL_SYNC_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const FULL_SYNC_COMPLETE_GRACE_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_HISTORY_ROWS = 5_000;
export const MAX_DEVICES = 20;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

export type ErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_API_VERSION"
  | "INVALID_CURSOR"
  | "DUPLICATE_ENTITY_IN_BATCH"
  | "UNAUTHORIZED"
  | "DEVICE_NOT_BOUND"
  | "SESSION_DEVICE_MISMATCH"
  | "ENTITY_NOT_FOUND"
  | "FULL_SYNC_NOT_FOUND"
  | "CONFLICT"
  | "BATCH_REJECTED"
  | "OP_ID_REUSED"
  | "BATCH_ID_REUSED"
  | "FULL_SYNC_IN_PROGRESS"
  | "INVALID_FULL_SYNC_PHASE"
  | "TABLE_RELOAD_REQUIRED"
  | "FULL_SYNC_EXPIRED"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "DATABASE_UNAVAILABLE";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: JsonObject;

  constructor(status: number, code: ErrorCode, message: string, details?: JsonObject) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface DeviceRow {
  id: string;
  deleted: number;
  name: string;
  platform: string | null;
  app_version: string | null;
  last_seen_at: number | null;
  last_ack_change_seq: number;
  full_sync_session_id: string | null;
}

export interface ProfileRow {
  schema_version: number;
  api_version: number;
  min_valid_change_seq: number;
  current_change_seq: number;
}

export interface BookmarkRow {
  id: string;
  sync_version: number;
  deleted: number;
  server_updated_at: number;
  created_by_device_id: string | null;
  updated_by_device_id: string | null;
  url: string;
  title: string;
  note: string;
  tags_json: string;
}

export interface SettingRow {
  id: string;
  sync_version: number;
  deleted: number;
  server_updated_at: number;
  created_by_device_id: string | null;
  updated_by_device_id: string | null;
  value_json: string;
}

export type EntityRow = BookmarkRow | SettingRow;
export type EntityTable = "bookmarks" | "settings";
export type OperationKind = "create" | "update" | "upsert" | "delete";

export interface SyncOperation {
  op_id: string;
  table: EntityTable;
  entity_id: string;
  operation: OperationKind;
  base_sync_version: number | null;
  data?: JsonObject;
}

export interface SyncRequestBody {
  batch_id?: string;
  cursor: number;
  ack_cursor: number;
  limit: number;
  operations: SyncOperation[];
}

export interface OperationResult {
  op_id: string;
  status: "applied" | "replayed";
  entity_id: string;
  sync_version: number;
  change_seq: number;
}

export interface ChangeResult {
  change_seq: number;
  table: EntityTable;
  operation: "create" | "update" | "delete";
  payload: JsonObject;
}

export interface FullSyncSessionRow {
  id: string;
  device_id: string;
  start_request_id: string;
  baseline_seq: number;
  target_seq: number | null;
  schema_version: number;
  phase: "downloading" | "catching_up" | "completed" | "expired";
  expires_at: number;
  created_at: number;
  completed_at: number | null;
}

export interface RouteDefinition {
  auth: "public" | "master" | "device";
  handler:
    | "health"
    | "verifyAuth"
    | "info"
    | "bindDevice"
    | "listDevices"
    | "patchDevice"
    | "deleteDevice"
    | "sync"
    | "fullSyncStart"
    | "fullSyncData"
    | "fullSyncSeal"
    | "fullSyncChanges"
    | "fullSyncComplete";
}

export interface ResolvedRoute extends RouteDefinition {
  params: Record<string, string>;
}

export function isEntityTable(value: string): value is EntityTable {
  return value === "bookmarks" || value === "settings";
}
