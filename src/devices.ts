import { SQL } from "./service";
import { jsonSuccess } from "./auth";
import { ApiError, MAX_DEVICES, type DeviceRow, type JsonObject } from "./types";
import {
  assertObject,
  assertOnlyKeys,
  optionalString,
  readJsonBody,
  requiredString,
} from "./validation";

function deviceJson(device: DeviceRow): JsonObject {
  return {
    id: device.id,
    deleted: device.deleted,
    name: device.name,
    platform: device.platform,
    app_version: device.app_version,
    last_seen_at: device.last_seen_at,
    last_ack_change_seq: device.last_ack_change_seq,
    full_sync_session_id: device.full_sync_session_id,
  };
}

export async function requireBoundDevice(db: D1Database, id: string): Promise<DeviceRow> {
  const device = await db.prepare(SQL.deviceGet).bind(id).first<DeviceRow>();
  if (device === null || device.deleted !== 0) {
    throw new ApiError(403, "DEVICE_NOT_BOUND", "device is not bound");
  }
  return device;
}

export async function bindDevice(request: Request, db: D1Database, now = Date.now()): Promise<Response> {
  const raw = assertObject(await readJsonBody(request));
  assertOnlyKeys(raw, ["device_id", "name", "platform", "app_version"]);
  const deviceId = requiredString(raw.device_id, "device_id", 1, 200);
  if (deviceId.includes(":")) throw new ApiError(400, "INVALID_REQUEST", "device_id must not contain a colon");
  const name = requiredString(raw.name, "name", 1, 200);
  const platform = optionalString(raw.platform, "platform", 100) ?? null;
  const appVersion = optionalString(raw.app_version, "app_version", 100) ?? null;

  try {
    const batch = await db.batch<DeviceRow>([
      db.prepare(SQL.deviceCapacityAssert).bind(deviceId, MAX_DEVICES),
      db.prepare(SQL.deviceBind).bind(deviceId, name, platform, appVersion, now),
      db.prepare(SQL.assertionClear),
      db.prepare(SQL.deviceGet).bind(deviceId),
    ]);
    const device = batch[3]?.results[0];
    if (device === undefined) throw new ApiError(503, "DATABASE_UNAVAILABLE", "database is unavailable");
    return jsonSuccess({ device: deviceJson(device) });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const existing = await db.prepare(SQL.deviceGet).bind(deviceId).first<DeviceRow>();
    const activeCount = await db.prepare("SELECT COUNT(*) AS count FROM devices WHERE deleted = 0").first<number>("count");
    if (existing?.deleted !== 0 && activeCount !== null && activeCount >= MAX_DEVICES) {
      throw new ApiError(429, "RATE_LIMITED", `at most ${MAX_DEVICES} active devices may be bound`);
    }
    throw new ApiError(503, "DATABASE_UNAVAILABLE", "device binding transaction failed; retry");
  }
}

export async function listDevices(db: D1Database): Promise<Response> {
  const result = await db.prepare(SQL.deviceList).all<DeviceRow>();
  return jsonSuccess({ devices: result.results.map(deviceJson) });
}

export async function patchDevice(
  request: Request,
  db: D1Database,
  targetId: string,
  now = Date.now(),
): Promise<Response> {
  if (targetId.length < 1 || targetId.length > 200) {
    throw new ApiError(400, "INVALID_REQUEST", "device id is invalid");
  }
  const raw = assertObject(await readJsonBody(request));
  assertOnlyKeys(raw, ["name", "platform", "app_version"]);
  if (Object.keys(raw).length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", "device patch must include at least one field");
  }
  const name = raw.name === undefined ? undefined : requiredString(raw.name, "name", 1, 200);
  const platform = optionalString(raw.platform, "platform", 100);
  const appVersion = optionalString(raw.app_version, "app_version", 100);
  const existing = await db.prepare(SQL.deviceGet).bind(targetId).first<DeviceRow>();
  if (existing === null) throw new ApiError(404, "ENTITY_NOT_FOUND", "device not found");
  if (existing.deleted !== 0) throw new ApiError(409, "CONFLICT", "device is unbound");

  await db
    .prepare(SQL.devicePatch)
    .bind(
      name === undefined ? 0 : 1,
      name ?? "",
      platform === undefined ? 0 : 1,
      platform ?? null,
      appVersion === undefined ? 0 : 1,
      appVersion ?? null,
      now,
      targetId,
    )
    .run();
  const updated = await db.prepare(SQL.deviceGet).bind(targetId).first<DeviceRow>();
  if (updated === null) throw new ApiError(503, "DATABASE_UNAVAILABLE", "database is unavailable");
  return jsonSuccess({ device: deviceJson(updated) });
}

export async function deleteDevice(
  db: D1Database,
  targetId: string,
  now = Date.now(),
): Promise<Response> {
  if (targetId.length < 1 || targetId.length > 200) {
    throw new ApiError(400, "INVALID_REQUEST", "device id is invalid");
  }
  const existing = await db.prepare(SQL.deviceGet).bind(targetId).first<DeviceRow>();
  if (existing === null) throw new ApiError(404, "ENTITY_NOT_FOUND", "device not found");
  await db.batch([
    db.prepare(SQL.deviceExpireSessions).bind(targetId),
    db.prepare(SQL.deviceDelete).bind(now, targetId),
  ]);
  const deleted = await db.prepare(SQL.deviceGet).bind(targetId).first<DeviceRow>();
  if (deleted === null) throw new ApiError(503, "DATABASE_UNAVAILABLE", "database is unavailable");
  return jsonSuccess({ device: deviceJson(deleted) });
}
