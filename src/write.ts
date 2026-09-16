import { fail, object, string, integer, boolean, ApiError } from "./http";
import { SQL, pointQuery, type Device, type State, type Key } from "./sql";
export type Operation = Key & {
  operation: "create" | "update" | "delete";
  content?: unknown;
  base_sync_version?: number;
  forced: boolean;
};
export function parseWrite(body: Record<string, unknown>) {
  object(body, ["device_id", "request_seq", "operations"]);
  const device = string(body.device_id, true),
    seq = integer(body.request_seq, 1);
  if (
    !Array.isArray(body.operations) ||
    body.operations.length < 1 ||
    body.operations.length > 10
  )
    fail();
  const seen = new Set<string>();
  const ops = body.operations.map((value) => {
    const op = object(value, [
      "operation",
      "tablename",
      "id",
      "content",
      "base_sync_version",
      "forced",
    ]);
    const action = string(op.operation);
    if (action !== "create" && action !== "update" && action !== "delete")
      fail();
    const tablename = string(op.tablename),
      id = string(op.id),
      forced = boolean(op.forced, false);
    const key = JSON.stringify([tablename, id]);
    if (seen.has(key)) fail();
    seen.add(key);
    if (
      action === "delete"
        ? Object.hasOwn(op, "content")
        : !Object.hasOwn(op, "content")
    )
      fail();
    const base =
      op.base_sync_version === undefined
        ? undefined
        : integer(op.base_sync_version, 1);
    if (action !== "create" && !forced && base === undefined) fail();
    return {
      operation: action,
      tablename,
      id,
      content: op.content,
      base_sync_version: base,
      forced,
    } satisfies Operation;
  });
  return { device, seq, ops };
}
export function enabled(
  device: Device | null | undefined,
): asserts device is Device {
  if (!device) fail("DEVICE_NOT_FOUND", 404);
  if (device.disabled) fail("DEVICE_DISABLED", 403);
}
type Result = Key & {
  index: number;
  success: boolean;
  code?: string;
  sync_version?: number;
  deleted?: boolean;
};
function decide(
  op: Operation,
  state: State | undefined,
  index: number,
): Result {
  let code: string | undefined;
  if (op.operation === "create" && !op.forced && state && !state.deleted)
    code = "ALREADY_EXISTS";
  else if (
    (op.operation === "delete" || (op.operation === "update" && !op.forced)) &&
    (!state || state.deleted)
  )
    code = "ENTITY_NOT_FOUND";
  else if (
    !op.forced &&
    op.operation !== "create" &&
    state?.sync_version !== op.base_sync_version
  )
    code = "VERSION_CONFLICT";
  const result: Result = {
    index,
    success: !code,
    tablename: op.tablename,
    id: op.id,
  };
  if (code) {
    result.code = code;
    if (state) {
      result.sync_version = state.sync_version;
      result.deleted = !!state.deleted;
    }
  } else {
    result.sync_version = (state?.sync_version ?? 0) + 1;
    if (!Number.isSafeInteger(result.sync_version))
      throw new ApiError(503, "DATABASE_UNAVAILABLE");
    result.deleted = op.operation === "delete";
  }
  return result;
}
export async function write(
  db: D1DatabaseSession,
  body: Record<string, unknown>,
  hash: string,
  contents: Map<number, string> = new Map(),
) {
  const { device: id, seq, ops } = parseWrite(body);
  // At most two attempts keeps a ten-operation request within the free-tier query budget.
  for (let attempt = 0; attempt < 2; attempt++) {
    const device = await db.prepare(SQL.device).bind(id).first<Device>();
    enabled(device);
    if (seq === device.last_request_seq) {
      if (hash !== device.last_request_hash) fail("REQUEST_SEQ_REUSED", 409);
      if (!device.last_request_result)
        throw new ApiError(503, "DATABASE_UNAVAILABLE");
      return JSON.parse(device.last_request_result) as {
        request_seq: number;
        results: Result[];
      };
    }
    if (seq < device.last_request_seq) fail("REQUEST_EXPIRED", 409);
    if (seq !== device.last_request_seq + 1) fail("REQUEST_OUT_OF_ORDER", 409);
    const snapshot = await db
      .prepare(pointQuery(ops.length, "d.sync_version,d.deleted"))
      .bind(...ops.flatMap((op) => [op.tablename, op.id]))
      .all<State & { idx: number }>();
    const states = new Map(snapshot.results.map((row) => [row.idx, row]));
    const results = ops.map((op, i) => decide(op, states.get(i), i));
    const response = { request_seq: seq, results };
    const args: (string | number | null)[] = [id, device.last_request_seq];
    const checks = [
      "EXISTS(SELECT 1 FROM devices WHERE id=? AND disabled=0 AND last_request_seq=?)",
    ];
    for (const [i, op] of ops.entries()) {
      const old = states.get(i);
      checks.push(
        old
          ? "EXISTS(SELECT 1 FROM data WHERE tablename=? AND id=? AND sync_version=?)"
          : "NOT EXISTS(SELECT 1 FROM data WHERE tablename=? AND id=?)",
      );
      args.push(op.tablename, op.id);
      if (old) args.push(old.sync_version);
    }
    // SQLite integer overflow aborts the batch if the snapshot changed. SELECT false would NOT roll it back.
    const statements = [
      db
        .prepare(
          `SELECT CASE WHEN ${checks.join(" AND ")} THEN 1 ELSE abs(-9223372036854775808) END AS guarded`,
        )
        .bind(...args),
    ];
    const now = Date.now();
    for (const [i, op] of ops.entries()) {
      const result = results[i];
      if (!result.success) continue;
      statements.push(
        db
          .prepare(SQL.save)
          .bind(
            op.tablename,
            op.id,
            op.operation === "delete"
              ? null
              : (contents.get(i) ?? JSON.stringify(op.content)),
            result.sync_version!,
            Number(result.deleted),
            now,
            id,
            id,
          ),
      );
      const kind =
        op.operation === "delete"
          ? "delete"
          : !states.get(i) || states.get(i)?.deleted
            ? "create"
            : "update";
      statements.push(
        db.prepare(SQL.change).bind(op.tablename, op.id, kind, id, now),
      );
    }
    statements.push(
      db
        .prepare(SQL.receipt)
        .bind(seq, hash, JSON.stringify(response), now, id),
    );
    try {
      await db.batch(statements);
      return response;
    } catch (error) {
      if (!(error instanceof Error) || !/integer overflow/i.test(error.message))
        throw error;
    }
  }
  throw new ApiError(503, "DATABASE_UNAVAILABLE");
}
