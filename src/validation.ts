import {
  API_VERSION,
  ApiError,
  MAX_FULL_SYNC_LIMIT,
  MAX_OPERATIONS,
  MAX_REQUEST_BYTES,
  MAX_SYNC_LIMIT,
  isEntityTable,
  type EntityTable,
  type JsonObject,
  type JsonValue,
  type OperationKind,
  type SyncOperation,
  type SyncRequestBody,
} from "./types";

const encoder = new TextEncoder();

function invalid(message: string): never {
  throw new ApiError(400, "INVALID_REQUEST", message);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertObject(value: unknown, name = "body"): Record<string, unknown> {
  if (!isPlainObject(value)) invalid(`${name} must be a JSON object`);
  return value;
}

export function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name = "body",
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) invalid(`${name}.${unknown} is not allowed`);
}

export function requiredString(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    invalid(`${name} must be a string between ${minimum} and ${maximum} characters`);
  }
  return value;
}

export function optionalString(
  value: unknown,
  name: string,
  maximum: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximum) {
    invalid(`${name} must be null or a string no longer than ${maximum} characters`);
  }
  return value;
}

export function integerInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") invalid("Content-Type must be application/json");

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) invalid("invalid Content-Length");
    if (parsedLength > MAX_REQUEST_BYTES) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "request body is too large");
    }
  }

  if (request.body === null) invalid("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "PAYLOAD_TOO_LARGE", "request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    invalid("request body must be valid UTF-8 JSON");
  }
}

export function toJsonValue(value: unknown, name = "value"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${name} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => toJsonValue(item, `${name}[${index}]`));
  if (isPlainObject(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toJsonValue(item, `${name}.${key}`);
    }
    return result;
  }
  invalid(`${name} contains an unsupported JSON value`);
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeBookmarkUrl(input: string): string {
  if (input !== input.trim()) invalid("bookmark url must not contain surrounding whitespace");
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    invalid("bookmark url must be an absolute HTTP(S) URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin === "null") {
    invalid("bookmark url must be an absolute HTTP(S) URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    invalid("bookmark url must not contain embedded credentials");
  }

  const raw = input.match(/^(https?):\/\/[^/?#]+([^?#]*)(\?[^#]*)?(?:#.*)?$/i);
  if (raw === null) invalid("bookmark url must be an absolute HTTP(S) URL");
  const path = raw[2] === "" || raw[2] === undefined ? "/" : raw[2];
  const query = raw[3] ?? "";
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}${query}`;
}

function validateJsonText(value: unknown, name: string, requireArray: boolean): string {
  if (typeof value !== "string") invalid(`${name} must be a JSON string`);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (requireArray && !Array.isArray(parsed)) invalid(`${name} must encode a JSON array`);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    invalid(`${name} must contain valid JSON`);
  }
  return value;
}

function validateOperationData(
  table: EntityTable,
  entityId: string,
  operation: OperationKind,
  dataValue: unknown,
): JsonObject | undefined {
  if (operation === "delete") {
    if (dataValue !== undefined) invalid("delete operations must not include data");
    return undefined;
  }
  const data = assertObject(dataValue, "operation.data");
  const keys = Object.keys(data);
  if ((operation === "update" || operation === "upsert") && keys.length === 0) {
    invalid(`${operation} data must contain at least one writable field`);
  }

  if (table === "bookmarks") {
    assertOnlyKeys(data, ["url", "title", "note", "tags_json"], "operation.data");
    const normalized: JsonObject = {};
    if (data.url !== undefined) {
      const url = normalizeBookmarkUrl(requiredString(data.url, "operation.data.url", 1, 4096));
      if (url !== entityId) invalid("bookmark entity_id must equal the normalized url");
      normalized.url = url;
    }
    if (data.title !== undefined) normalized.title = requiredString(data.title, "operation.data.title", 0, 500);
    if (data.note !== undefined) normalized.note = requiredString(data.note, "operation.data.note", 0, 10_000);
    if (data.tags_json !== undefined) {
      normalized.tags_json = validateJsonText(data.tags_json, "operation.data.tags_json", true);
    }
    if ((operation === "create" || operation === "upsert") && keys.length === 0) {
      invalid(`${operation} data must not be empty`);
    }
    return normalized;
  }

  assertOnlyKeys(data, ["value_json"], "operation.data");
  const normalized: JsonObject = {};
  if (data.value_json !== undefined) {
    normalized.value_json = validateJsonText(data.value_json, "operation.data.value_json", false);
  }
  return normalized;
}

function parseOperation(value: unknown, index: number): SyncOperation {
  const raw = assertObject(value, `operations[${index}]`);
  assertOnlyKeys(
    raw,
    ["op_id", "table", "entity_id", "operation", "base_sync_version", "data"],
    `operations[${index}]`,
  );
  const opId = requiredString(raw.op_id, `operations[${index}].op_id`, 1, 200);
  if (typeof raw.table !== "string" || !isEntityTable(raw.table)) invalid("operation.table is not supported");
  const table = raw.table;
  const entityId = requiredString(
    raw.entity_id,
    `operations[${index}].entity_id`,
    1,
    table === "bookmarks" ? 2048 : 200,
  );
  if (!(["create", "update", "upsert", "delete"] as const).includes(raw.operation as OperationKind)) {
    invalid("operation.operation is not supported");
  }
  const operation = raw.operation as OperationKind;
  const base = raw.base_sync_version;
  if (operation === "create" || operation === "upsert") {
    if (base !== null) invalid(`${operation} base_sync_version must be null`);
  } else if (!Number.isSafeInteger(base) || (base as number) < 0) {
    invalid(`${operation} base_sync_version must be a non-negative integer`);
  }

  if (table === "bookmarks" && normalizeBookmarkUrl(entityId) !== entityId) {
    invalid("bookmark entity_id must already be a normalized url");
  }

  const data = validateOperationData(table, entityId, operation, raw.data);
  return {
    op_id: opId,
    table,
    entity_id: entityId,
    operation,
    base_sync_version: base as number | null,
    ...(data === undefined ? {} : { data }),
  };
}

export function parseSyncRequest(value: unknown): SyncRequestBody {
  const body = assertObject(value);
  assertOnlyKeys(body, ["batch_id", "cursor", "ack_cursor", "limit", "operations"]);
  const cursor = integerInRange(body.cursor, "cursor", 0, Number.MAX_SAFE_INTEGER);
  const ackCursor = integerInRange(body.ack_cursor, "ack_cursor", 0, Number.MAX_SAFE_INTEGER);
  const limit = integerInRange(body.limit, "limit", 1, MAX_SYNC_LIMIT);
  if (!Array.isArray(body.operations) || body.operations.length > MAX_OPERATIONS) {
    invalid(`operations must be an array with no more than ${MAX_OPERATIONS} items`);
  }
  const operations = body.operations.map(parseOperation);
  const batchId =
    body.batch_id === undefined
      ? undefined
      : requiredString(body.batch_id, "batch_id", 1, 200);
  if (operations.length > 0 && batchId === undefined) invalid("batch_id is required when operations are present");
  if (operations.length === 0 && batchId !== undefined) invalid("batch_id must be omitted for a pure pull");

  const entityKeys = new Set<string>();
  for (const operation of operations) {
    const key = `${operation.table}\u0000${operation.entity_id}`;
    if (entityKeys.has(key)) {
      throw new ApiError(
        400,
        "DUPLICATE_ENTITY_IN_BATCH",
        "a batch cannot operate on the same entity more than once",
      );
    }
    entityKeys.add(key);
  }

  return {
    ...(batchId === undefined ? {} : { batch_id: batchId }),
    cursor,
    ack_cursor: ackCursor,
    limit,
    operations,
  };
}

export function parseLimit(value: unknown, defaultValue: number, maximum = MAX_FULL_SYNC_LIMIT): number {
  if (value === undefined) return defaultValue;
  return integerInRange(value, "limit", 1, maximum);
}

export function operationHashInput(deviceId: string, operation: SyncOperation): JsonObject {
  return {
    api_version: API_VERSION,
    device_id: deviceId,
    op_id: operation.op_id,
    table: operation.table,
    entity_id: operation.entity_id,
    operation: operation.operation,
    base_sync_version: operation.base_sync_version,
    ...(operation.data === undefined ? {} : { data: operation.data }),
  };
}
