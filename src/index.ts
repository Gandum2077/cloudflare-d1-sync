import {
  emptyResponse,
  getDeviceId,
  jsonError,
  jsonSuccess,
  notFoundResponse,
  requireApiVersion,
  verifyMasterKey,
} from "./auth";
import { enforceRateLimit, performCleanup } from "./cleanup";
import {
  bindDevice,
  deleteDevice,
  listDevices,
  patchDevice,
  requireBoundDevice,
} from "./devices";
import {
  completeFullSync,
  readFullSyncChanges,
  readFullSyncData,
  sealFullSync,
  startFullSync,
} from "./full-sync";
import { resolveRoute, SQL } from "./service";
import { executeSync } from "./sync";
import { API_VERSION, ApiError, ENTITY_TABLES, entitySchemaVersion, SCHEMA_VERSION, type DeviceRow, type JsonObject } from "./types";
import { parseSyncRequest, readJsonBody } from "./validation";

function clientSubject(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown-client";
}

async function info(db: D1Database): Promise<Response> {
  const [profile, tables] = await Promise.all([
    db.prepare(SQL.profileInfo).first<{
      schema_version: number;
      api_version: number;
      min_valid_change_seq: number;
      current_change_seq: number;
    }>(),
    db.prepare(SQL.syncTables).all<{ table_name: string; table_order: number; schema_version: number }>(),
  ]);
  if (profile === null) throw new ApiError(503, "DATABASE_UNAVAILABLE", "database is unavailable");
  const expected = [...ENTITY_TABLES];
  if (
    profile.schema_version !== SCHEMA_VERSION ||
    profile.api_version !== API_VERSION ||
    tables.results.length !== expected.length ||
    tables.results.some((table, index) => table.table_name !== expected[index] || table.schema_version !== entitySchemaVersion(expected[index]) || table.table_order !== index + 1)
  ) {
    throw new ApiError(500, "INTERNAL_ERROR", "database schema does not match this Worker version");
  }
  return jsonSuccess({
    ...profile,
    sync_tables: expected,
    capabilities: ["batch_atomic", "full_sync", "upsert", "device_counters"],
  });
}

async function dispatch(
  request: Request,
  env: Env,
  route: NonNullable<ReturnType<typeof resolveRoute>>,
  device: DeviceRow | null,
): Promise<Response> {
  switch (route.handler) {
    case "health":
      return jsonSuccess({ service: "cloudflare-d1-sync", api_version: API_VERSION });
    case "verifyAuth":
      return jsonSuccess({ authenticated: true, api_version: API_VERSION });
    case "info":
      return await info(env.DB);
    case "bindDevice":
      await enforceRateLimit(env.DB, "device-bind", clientSubject(request), 10);
      return await bindDevice(request, env.DB);
    case "listDevices":
      return await listDevices(env.DB);
    case "patchDevice":
      return await patchDevice(request, env.DB, route.params.id ?? "");
    case "deleteDevice":
      return await deleteDevice(env.DB, route.params.id ?? "");
    case "sync": {
      if (device === null) throw new ApiError(403, "DEVICE_NOT_BOUND", "device is not bound");
      await enforceRateLimit(env.DB, "sync", device.id, 120);
      const body = parseSyncRequest(await readJsonBody(request));
      return jsonSuccess(await executeSync(env.DB, device, body));
    }
    case "fullSyncStart":
    case "fullSyncData":
    case "fullSyncSeal":
    case "fullSyncChanges":
    case "fullSyncComplete": {
      if (device === null) throw new ApiError(403, "DEVICE_NOT_BOUND", "device is not bound");
      await enforceRateLimit(env.DB, "full-sync", device.id, 60);
      let data: JsonObject;
      if (route.handler === "fullSyncStart") data = await startFullSync(request, env.DB, device.id);
      else if (route.handler === "fullSyncData") data = await readFullSyncData(request, env.DB, device.id);
      else if (route.handler === "fullSyncSeal") data = await sealFullSync(request, env.DB, device.id);
      else if (route.handler === "fullSyncChanges") data = await readFullSyncChanges(request, env.DB, device.id);
      else data = await completeFullSync(request, env.DB, device.id);
      return jsonSuccess(data);
    }
  }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return emptyResponse();
  const url = new URL(request.url);
  const route = resolveRoute(request.method, url.pathname);
  if (route === null) return notFoundResponse();
  if (route.auth === "public") return await dispatch(request, env, route, null);

  requireApiVersion(request);
  if (!(await verifyMasterKey(request, env))) {
    await enforceRateLimit(env.DB, "auth-failure", clientSubject(request), 10);
    throw new ApiError(401, "UNAUTHORIZED", "authentication failed");
  }

  let device: DeviceRow | null = null;
  if (route.auth === "device") {
    const deviceId = getDeviceId(request);
    device = await requireBoundDevice(env.DB, deviceId);
    if (route.handler !== "sync") {
      await env.DB.prepare(SQL.deviceTouch).bind(Date.now(), device.id).run();
    }
  }
  return await dispatch(request, env, route, device);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      if (error instanceof ApiError) return jsonError(error);
      console.error(JSON.stringify({
        message: "unhandled request error",
        method: request.method,
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : "unknown error",
      }));
      return jsonError(new ApiError(500, "INTERNAL_ERROR", "internal server error"));
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      performCleanup(env.DB).catch((error: unknown) => {
        console.error(JSON.stringify({
          message: "scheduled cleanup failed",
          error: error instanceof Error ? error.message : "unknown error",
        }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
