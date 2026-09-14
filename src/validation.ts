import { ARCHIVE_STATE_TABLES, DOMAIN_FIELDS, type FieldRule } from "./domain";
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

function boundedText(value: unknown, name: string, minimum: number, maximum: number): string {
  const result = requiredString(value, name, minimum, maximum);
  if (result.includes("\0") || encoder.encode(result).byteLength > maximum) {
    invalid(`${name} contains NUL or exceeds its UTF-8 byte limit`);
  }
  return result;
}

function validateAttachment(value: unknown, kind: "taglist" | "search_terms", name: string): string {
  const source = boundedText(value, name, 2, 65536);
  let parsed: unknown;
  try { parsed = JSON.parse(source) as unknown; } catch { invalid(`${name} must contain valid JSON`); }
  if (!Array.isArray(parsed) || parsed.length > (kind === "taglist" ? 256 : 100)) {
    invalid(`${name} must encode a bounded array`);
  }
  const namespaces = new Set<string>();
  let totalTags = 0;
  const normalized = parsed.map((item: unknown, index: number): JsonObject => {
    const label = `${name}[${index}]`;
    const object = assertObject(item, label);
    if (kind === "taglist") {
      assertOnlyKeys(object, ["namespace", "tags"], label);
      const namespace = boundedText(object.namespace, `${label}.namespace`, 0, 512);
      if (namespaces.has(namespace)) invalid(`${name} contains duplicate namespaces`);
      namespaces.add(namespace);
      if (!Array.isArray(object.tags) || object.tags.length > 256) invalid(`${label}.tags must be an array of at most 256 strings`);
      totalTags += object.tags.length;
      if (totalTags > 4096) invalid(`${name} contains too many tags`);
      const tags = object.tags.map((tag: unknown) => boundedText(tag, `${label}.tags`, 1, 512));
      if (new Set(tags).size !== tags.length) invalid(`${label}.tags contains duplicates`);
      return { namespace, tags };
    }
    assertOnlyKeys(object, ["namespace", "qualifier", "term", "dollar", "subtract", "tilde"], label);
    const term: JsonObject = { term: boundedText(object.term, `${label}.term`, 0, 2048) };
    for (const key of ["namespace", "qualifier"]) {
      if (Object.hasOwn(object, key)) {
        term[key] = object[key] === null ? null : boundedText(object[key], `${label}.${key}`, 0, 512);
      }
    }
    for (const key of ["dollar", "subtract", "tilde"]) {
      if (Object.hasOwn(object, key)) term[key] = integerInRange(object[key], `${label}.${key}`, 0, 1);
    }
    return term;
  });
  const canonical = canonicalJson(normalized);
  if (encoder.encode(canonical).byteLength > 65536) invalid(`${name} exceeds its UTF-8 byte limit`);
  return canonical;
}

function validateField(value: unknown, rule: FieldRule, name: string): JsonValue {
  if (value === null && "nullable" in rule && rule.nullable) return null;
  if (rule.kind === "taglist" || rule.kind === "search_terms") return validateAttachment(value, rule.kind, name);
  if (rule.kind === "text") {
    const result = boundedText(value, name, rule.min ?? 0, rule.max);
    if (rule.values !== undefined && !rule.values.includes(result)) invalid(`${name} is not a supported option`);
    return result;
  }
  if (rule.kind === "integer") return integerInRange(value, name, rule.min, rule.max);
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${name} must be a finite number`);
  return value;
}

function validateEntityId(table: EntityTable, value: unknown): string {
  const limits: Partial<Record<EntityTable, number>> = {
    archive_entries_v2: 32, archive_read_state_v2: 32, archive_favorite_state_v2: 32,
    archive_rate_state_v2: 32, gallery_reader_config_v2: 32, global_reader_config_v2: 1,
    search_history_v2: 8192, search_bookmarks_v2: 8192, local_marked_tags_v2: 1025,
    marked_uploaders_v2: 512, tag_access_count_v2: 3275, favorite_images_v2: 64,
  };
  const id = boundedText(value, "operation.entity_id", table === "search_history_v2" || table === "search_bookmarks_v2" ? 0 : 1, limits[table] ?? 200);
  if ((table === "archive_entries_v2" || ARCHIVE_STATE_TABLES.some((name) => name === table)) && !/^[0-9]+$/u.test(id)) {
    invalid("archive entity_id must be a decimal gid string");
  }
  if (table === "global_reader_config_v2" && id !== "1") invalid("global reader config entity_id must be 1");
  if (table === "local_marked_tags_v2" || table === "tag_access_count_v2") {
    const parts = id.split(":");
    if (parts.length !== (table === "local_marked_tags_v2" ? 2 : 4)) invalid("entity_id must use the documented composite key");
    parts.forEach((part, index) => boundedText(part, "entity_id component", table === "local_marked_tags_v2" || index === 0 ? 1 : 0, table === "tag_access_count_v2" ? (index === 0 ? 200 : index === 3 ? 2048 : 512) : 512));
  }
  if (table === "favorite_images_v2") {
    const parts = id.split(":");
    if (parts.length !== 2 || parts.some((part) => !/^(0|[1-9][0-9]*)$/u.test(part) || !Number.isSafeInteger(Number(part)))) {
      invalid("favorite image entity_id must be canonical gid:page_index with non-negative safe integers");
    }
  }
  return id;
}

function validateOperationData(
  table: EntityTable,
  entityId: string,
  operation: OperationKind,
  dataValue: unknown,
): JsonObject | undefined {
  if (table === "global_reader_config_v2" && operation !== "upsert" && operation !== "update") {
    invalid("global reader config only supports upsert and update");
  }
  if (table === "tag_access_count_v2") {
    if (operation === "delete") invalid("device counters cannot be deleted or reset");
    const counter = assertObject(dataValue, "operation.data");
    for (const key of ["device_id", "qualifier", "namespace", "term", "count"]) {
      if (!Object.hasOwn(counter, key)) invalid(`operation.data.${key} is required for a device counter`);
    }
  }
  if (operation === "delete") {
    if (dataValue !== undefined) invalid("delete operations must not include data");
    return undefined;
  }
  const data = assertObject(dataValue, "operation.data");
  const fields = DOMAIN_FIELDS[table];
  assertOnlyKeys(data, Object.keys(fields), "operation.data");
  if (operation === "update" && Object.keys(data).length === 0 && table !== "marked_uploaders_v2") {
    invalid("update data must contain at least one writable field");
  }
  const normalized: JsonObject = {};
  for (const [key, value] of Object.entries(data)) {
    const rule = fields[key];
    if (rule === undefined) invalid("unsupported business field");
    normalized[key] = validateField(value, rule, `operation.data.${key}`);
  }
  const keyFields = table === "local_marked_tags_v2" ? ["namespace", "name"]
    : table === "tag_access_count_v2" ? ["device_id", "qualifier", "namespace", "term"]
    : table === "favorite_images_v2" ? ["gid", "page_index"] : [];
  const parts = entityId.split(":");
  for (const [index, key] of keyFields.entries()) {
    const value = normalized[key];
    if (Object.hasOwn(normalized, key) &&
      ((typeof value !== "string" && typeof value !== "number") || String(value) !== parts[index])) {
      invalid(`operation.data.${key} does not match entity_id`);
    }
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
  const entityId = validateEntityId(table, raw.entity_id);
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
