import { ApiError, authenticate, databaseError, fail, json } from "./http";
import { readBody } from "./body";
import { putDevice, patchDevice, listDevices } from "./devices";
import { fullDownload, read, sync, tableDownload } from "./read";
import { write } from "./write";
import { cleanup } from "./cleanup";

export async function handle(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/v1/health" && request.method === "GET") {
      if (url.search || request.body) fail();
      return json({ status: "ok", api_version: "v1" });
    }
    const ip = request.headers.get("CF-Connecting-IP") ?? "local";
    if (!(await env.API_LIMITER.limit({ key: `ip:${ip}` })).success)
      throw new ApiError(429, "RATE_LIMITED", "RATE_LIMITED", {
        "Retry-After": "60",
      });
    await authenticate(request, env);
    const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
    const methods = deviceMatch
      ? ["PUT", "PATCH"]
      : url.pathname === "/v1/devices"
        ? ["GET"]
        : url.pathname === "/v1/health"
          ? ["GET"]
          : [
                "/v1/write",
                "/v1/sync",
                "/v1/full-download",
                "/v1/read",
                "/v1/table-download",
              ].includes(url.pathname)
            ? ["POST"]
            : null;
    if (!methods) fail("NOT_FOUND", 404);
    if (!methods.includes(request.method))
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "METHOD_NOT_ALLOWED", {
        Allow: methods.join(", "),
      });
    if (url.pathname !== "/v1/devices" && url.search) fail();
    const db = env.DB.withSession("first-primary");
    if (request.method === "GET") {
      if (request.body) fail();
      return await listDevices(db, url);
    }
    const { body, hash, contents } = await readBody(request);
    if (deviceMatch) {
      let id: string;
      try {
        id = decodeURIComponent(deviceMatch[1]);
      } catch {
        fail();
      }
      if (!id) fail();
      return request.method === "PUT"
        ? await putDevice(db, id, body)
        : await patchDevice(db, id, body);
    }
    if (url.pathname === "/v1/write")
      return json(await write(db, body, hash, contents));
    if (url.pathname === "/v1/sync") return await sync(db, body);
    if (url.pathname === "/v1/read") return await read(db, body);
    if (url.pathname === "/v1/table-download")
      return await tableDownload(db, body);
    return await fullDownload(db, body);
  } catch (error) {
    const failure = error instanceof ApiError ? error : databaseError(error);
    return json(
      { error: { code: failure.code, message: failure.message } },
      failure.status,
      failure.headers,
    );
  }
}
export default {
  fetch: handle,
  async scheduled(_event, env) {
    await cleanup(env.DB.withSession("first-primary"));
  },
} satisfies ExportedHandler<Env>;
