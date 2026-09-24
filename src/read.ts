import {
  ApiError,
  databaseError,
  boolean,
  fail,
  integer,
  limit,
  object,
  string,
} from "./http";
import { SQL, pointQuery, type Bounds, type Device, type Key } from "./sql";
import { enabled } from "./write";
function validCursor(seq: number, bounds: Bounds) {
  if (seq > bounds.latest) fail("INVALID_CURSOR");
  if (bounds.oldest !== null && seq < bounds.oldest - 1)
    fail("FULL_SYNC_REQUIRED", 410);
}
// Stream groups of at most ten point lookups, rather than materializing 100 large contents.
// Late D1 failures abort the JSON stream: clients cannot commit a partial page or its cursor.
export function records(
  db: D1DatabaseSession,
  keys: Key[],
  field: "changes" | "data" | "results",
  tail: Record<string, unknown>,
  exclude?: string,
  details = false,
): Response {
  const encoder = new TextEncoder();
  let offset = 0,
    started = false,
    emitted = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          controller.enqueue(encoder.encode(`{"${field}":[`));
          started = true;
          return;
        }
        while (true) {
          if (offset >= keys.length) {
            controller.enqueue(
              encoder.encode(
                `]${Object.keys(tail).length ? "," + JSON.stringify(tail).slice(1) : "}"}`,
              ),
            );
            controller.close();
            return;
          }
          const group = keys.slice(offset, offset + 10);
          offset += group.length;
          const sql = pointQuery(
            group.length,
            "d.tablename,d.id,d.content,d.sync_version,d.deleted,d.updated_by_device_id,d.server_updated_at",
          );
          const rows = await db
            .prepare(sql)
            .bind(...group.flatMap((key) => [key.tablename, key.id]))
            .all<
              Key & {
                idx: number;
                content: string | null;
                sync_version: number;
                deleted: number;
                updated_by_device_id: string | null;
                server_updated_at: number;
              }
            >();
          if (field !== "results" && rows.results.length !== group.length)
            throw new Error("Missing authoritative record");
          let groupEmitted = false;
          const byIndex = new Map(rows.results.map((row) => [row.idx, row]));
          for (const [index, key] of group.entries()) {
            const row = byIndex.get(index);
            if (!row) {
              controller.enqueue(
                encoder.encode(
                  (emitted ? "," : "") +
                    JSON.stringify({ ...key, found: false }),
                ),
              );
              emitted = true;
              groupEmitted = true;
              continue;
            }
            if (exclude !== undefined && row.updated_by_device_id === exclude)
              continue;
            const metadata = JSON.stringify({
              tablename: row.tablename,
              id: row.id,
              sync_version: row.sync_version,
              deleted: !!row.deleted,
              ...(field === "results" ? { found: true } : {}),
              ...(details
                ? {
                    server_updated_at: row.server_updated_at,
                    updated_by_device_id: row.updated_by_device_id,
                  }
                : {}),
            });
            const value = row.deleted
              ? metadata
              : metadata.slice(0, -1) + `,"content":${row.content}}`;
            controller.enqueue(encoder.encode((emitted ? "," : "") + value));
            emitted = true;
            groupEmitted = true;
          }
          if (groupEmitted) return;
        }
      } catch (error) {
        const failure = databaseError(error);
        if (failure.status === 429 || failure.status === 507) {
          // Headers may already be sent. Finish with an error, never a success cursor.
          // Clients must reject the entire page even though HTTP status is 200.
          controller.enqueue(
            encoder.encode(
              `],"error":${JSON.stringify({ code: failure.code, message: failure.code })}}`,
            ),
          );
          controller.close();
        } else {
          controller.error(new Error("DATABASE_UNAVAILABLE"));
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export async function read(
  db: D1DatabaseSession,
  body: Record<string, unknown>,
) {
  object(body, ["device_id", "keys"]);
  const id = string(body.device_id, true);
  if (
    !Array.isArray(body.keys) ||
    body.keys.length < 1 ||
    body.keys.length > 100
  )
    fail();
  const keys = body.keys.map((value) => {
    const key = object(value, ["tablename", "id"]);
    return { tablename: string(key.tablename), id: string(key.id) };
  });
  enabled((await db.prepare(SQL.device).bind(id).first<Device>()) ?? undefined);
  await touchDevice(db, id);
  return records(db, keys, "results", {}, undefined, true);
}

async function touchDevice(db: D1DatabaseSession, id: string) {
  const updated = await db
    .prepare(
      "UPDATE devices SET last_seen_at=? WHERE id=? AND disabled=0 RETURNING id",
    )
    .bind(Date.now(), id)
    .first();
  if (!updated) fail("DEVICE_DISABLED", 403);
}
export async function sync(
  db: D1DatabaseSession,
  body: Record<string, unknown>,
) {
  object(body, ["device_id", "seq", "limit", "include_self"]);
  const id = string(body.device_id, true),
    seq = integer(body.seq, 0, "INVALID_CURSOR"),
    size = limit(body.limit),
    includeSelf = boolean(body.include_self, false);
  // The transaction's endpoint reads and event page cannot be separated by concurrent GC.
  const result = await db.batch([
    db.prepare(SQL.device).bind(id),
    db.prepare(SQL.bounds),
    db.prepare(SQL.events).bind(seq, size),
  ]);
  enabled(result[0].results[0] as Device | undefined);
  const bounds = result[1].results[0] as Bounds;
  validCursor(seq, bounds);
  const events = result[2].results as (Key & { seq: number })[];
  const keys = new Map<string, Key>();
  for (const event of events)
    keys.set(JSON.stringify([event.tablename, event.id]), {
      tablename: event.tablename,
      id: event.id,
    });
  const next = events.at(-1)?.seq ?? seq;
  // A disable between page acquisition and acknowledgement cannot create new data access grants.
  const updated = await db
    .prepare(
      `UPDATE devices SET last_seen_at=?,last_seq=MAX(last_seq,?) WHERE id=? AND disabled=0 RETURNING id`,
    )
    .bind(Date.now(), includeSelf ? 0 : seq, id)
    .first();
  if (!updated) fail("DEVICE_DISABLED", 403);
  return records(
    db,
    [...keys.values()],
    "changes",
    { next_seq: next, has_more: next < bounds.latest },
    includeSelf ? undefined : id,
  );
}
export async function fullDownload(
  db: D1DatabaseSession,
  body: Record<string, unknown>,
) {
  return download(db, body, false);
}
export async function tableDownload(
  db: D1DatabaseSession,
  body: Record<string, unknown>,
) {
  return download(db, body, true);
}
async function download(
  db: D1DatabaseSession,
  body: Record<string, unknown>,
  scoped: boolean,
) {
  object(
    body,
    scoped
      ? ["device_id", "limit", "cursor", "tablename"]
      : ["device_id", "limit", "cursor"],
  );
  const table = scoped ? string(body.tablename) : undefined;
  const id = string(body.device_id, true),
    size = limit(body.limit);
  let after: Key | undefined, start: number | undefined;
  if (body.cursor !== undefined && body.cursor !== null) {
    try {
      const cursor = object(body.cursor, ["start_seq", "after"]);
      start = integer(cursor.start_seq, 0, "INVALID_CURSOR");
      const key = object(cursor.after, ["tablename", "id"]);
      after = { tablename: string(key.tablename), id: string(key.id) };
      if (scoped && after.tablename !== table) fail("INVALID_CURSOR");
    } catch (error) {
      if (error instanceof ApiError) fail("INVALID_CURSOR");
      throw error;
    }
  }
  const page =
    table !== undefined
      ? after
        ? db.prepare(SQL.tableKeysAfter).bind(table, after.id, size)
        : db.prepare(SQL.tableKeysFirst).bind(table, size)
      : after
        ? db.prepare(SQL.keysAfter).bind(after.tablename, after.id, size)
        : db.prepare(SQL.keysFirst).bind(size);
  const result = await db.batch([
    db.prepare(SQL.device).bind(id),
    db.prepare(SQL.bounds),
    page,
  ]);
  enabled(result[0].results[0] as Device | undefined);
  const bounds = result[1].results[0] as Bounds;
  const startSeq = start ?? bounds.latest;
  validCursor(startSeq, bounds);
  const keys = result[2].results as Key[];
  const last = keys.at(-1);
  const more = last
    ? !!(await (
        table !== undefined
          ? db.prepare(SQL.tableKeysAfter).bind(table, last.id, 1)
          : db.prepare(SQL.keysAfter).bind(last.tablename, last.id, 1)
      ).first())
    : false;
  await touchDevice(db, id);
  return records(
    db,
    keys,
    "data",
    {
      start_seq: startSeq,
      next_cursor: more ? { start_seq: startSeq, after: last } : null,
      has_more: more,
    },
    undefined,
    scoped,
  );
}
