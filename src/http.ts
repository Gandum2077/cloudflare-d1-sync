export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}
export function json(
  value: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}
export function fail(code = "INVALID_REQUEST", status = 400): never {
  throw new ApiError(status, code);
}
export function object(
  value: unknown,
  allowed?: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const result = value as Record<string, unknown>;
  if (allowed && Object.keys(result).some((key) => !allowed.includes(key)))
    fail();
  return result;
}
export function string(value: unknown, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value.length)) fail();
  return value;
}
export function integer(
  value: unknown,
  min = 0,
  code = "INVALID_REQUEST",
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    fail(code);
  return value;
}
export function limit(value: unknown): number {
  if (value === undefined) return 100;
  const n = integer(value, 1);
  if (n > 100) fail();
  return n;
}
export function boolean(value: unknown, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") fail();
  return value;
}
export async function authenticate(request: Request, env: Env): Promise<void> {
  const token =
    request.headers
      .get("Authorization")
      ?.match(/^Bearer ([0-9a-f]{64})$/)?.[1] ?? "";
  const secret = env.MASTER_KEY ?? "";
  const [a, b] = await Promise.all(
    [token, secret].map((value) =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
  const equal = crypto.subtle.timingSafeEqual(a, b);
  if (!equal || !token || !/^[0-9a-f]{64}$/.test(secret))
    fail("UNAUTHORIZED", 401);
}
export function databaseError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : "";
  if (
    /too (?:big|large)|SQLITE_TOOBIG|string or blob too big|row.*size/i.test(
      message,
    )
  )
    return new ApiError(413, "PAYLOAD_TOO_LARGE");
  return new ApiError(503, "DATABASE_UNAVAILABLE");
}
