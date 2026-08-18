import { API_VERSION, ApiError, type JsonObject, type JsonValue } from "./types";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
} as const;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

interface TimingSafeSubtleCrypto {
  timingSafeEqual(
    first: ArrayBuffer | ArrayBufferView,
    second: ArrayBuffer | ArrayBufferView,
  ): boolean;
}

function supportsTimingSafeEqual(
  subtle: SubtleCrypto,
): subtle is SubtleCrypto & TimingSafeSubtleCrypto {
  return "timingSafeEqual" in subtle && typeof subtle.timingSafeEqual === "function";
}

function withSecurityHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    result.set(name, value);
  }
  return result;
}

export function jsonSuccess(data: JsonObject, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: withSecurityHeaders(JSON_HEADERS),
  });
}

export function jsonError(error: ApiError): Response {
  const details = error.details === undefined ? {} : error.details;
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: error.code, message: error.message, details },
    }),
    {
      status: error.status,
      headers: withSecurityHeaders(JSON_HEADERS),
    },
  );
}

export function emptyResponse(status = 204): Response {
  return new Response(null, {
    status,
    headers: withSecurityHeaders({
      Allow: "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Version, X-Device-ID",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    }),
  });
}

export function notFoundResponse(): Response {
  return jsonError(new ApiError(404, "ENTITY_NOT_FOUND", "route not found"));
}

export async function verifyMasterKey(request: Request, env: Env): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(env.MASTER_KEY)) {
    throw new ApiError(500, "INTERNAL_ERROR", "service authentication is not configured");
  }

  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer ([0-9a-f]{64})$/);
  const provided = match?.[1] ?? "";
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.MASTER_KEY)),
  ]);
  const subtle = globalThis.crypto.subtle;
  if (!supportsTimingSafeEqual(subtle)) {
    throw new ApiError(500, "INTERNAL_ERROR", "constant-time authentication is unavailable");
  }
  return subtle.timingSafeEqual(providedHash, expectedHash) && match !== null;
}

export function requireApiVersion(request: Request): void {
  if (request.headers.get("X-API-Version") !== String(API_VERSION)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_API_VERSION",
      `X-API-Version must be ${API_VERSION}`,
    );
  }
}

export function getDeviceId(request: Request): string {
  const deviceId = request.headers.get("X-Device-ID");
  if (deviceId === null || deviceId.length < 1 || deviceId.length > 200) {
    throw new ApiError(403, "DEVICE_NOT_BOUND", "device is not bound");
  }
  return deviceId;
}

export function asJsonObject(value: JsonValue): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ApiError(500, "INTERNAL_ERROR", "response serialization failed");
  }
  return value;
}
