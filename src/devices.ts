import { boolean, fail, json, limit, object, string } from "./http";
import { SQL, type Device } from "./sql";
function publicDevice(d: Device) {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    last_seq: d.last_seq,
    last_request_seq: d.last_request_seq,
    created_at: d.created_at,
    last_seen_at: d.last_seen_at,
    disabled: !!d.disabled,
  };
}
export async function putDevice(
  db: D1DatabaseSession,
  id: string,
  body: Record<string, unknown>,
) {
  object(body, ["name", "platform"]);
  for (const key of ["name", "platform"])
    if (body[key] !== undefined && body[key] !== null) string(body[key]);
  const now = Date.now();
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO devices(id,name,platform,created_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id`,
      )
      .bind(id, body.name ?? null, body.platform ?? null, now, now),
    db
      .prepare(
        `UPDATE devices SET name=CASE WHEN ? THEN ? ELSE name END,platform=CASE WHEN ? THEN ? ELSE platform END WHERE id=? RETURNING ${SQL.deviceColumns}`,
      )
      .bind(
        Number(Object.hasOwn(body, "name")),
        body.name ?? null,
        Number(Object.hasOwn(body, "platform")),
        body.platform ?? null,
        id,
      ),
  ]);
  return json(
    { device: publicDevice(result[1].results[0] as Device) },
    result[0].results.length ? 201 : 200,
  );
}
export async function patchDevice(
  db: D1DatabaseSession,
  id: string,
  body: Record<string, unknown>,
) {
  object(body, ["disabled"]);
  const row = await db
    .prepare(
      `UPDATE devices SET disabled=? WHERE id=? RETURNING ${SQL.deviceColumns}`,
    )
    .bind(Number(boolean(body.disabled)), id)
    .first<Device>();
  if (!row) fail("DEVICE_NOT_FOUND", 404);
  return json({ device: publicDevice(row) });
}
export async function listDevices(db: D1DatabaseSession, url: URL) {
  const params = url.searchParams;
  for (const key of params.keys())
    if (!["limit", "after_id"].includes(key) || params.getAll(key).length !== 1)
      fail();
  const raw = params.get("limit");
  if (raw !== null && !/^\d+$/.test(raw)) fail();
  const size = limit(raw === null ? undefined : Number(raw)),
    after = params.get("after_id");
  const query =
    after === null
      ? `SELECT ${SQL.deviceColumns} FROM devices ORDER BY id LIMIT ?`
      : `SELECT ${SQL.deviceColumns} FROM devices WHERE id>? ORDER BY id LIMIT ?`;
  const page = await db
    .prepare(query)
    .bind(...(after === null ? [size] : [after, size]))
    .all<Device>();
  const last = page.results.at(-1)?.id;
  const more =
    last !== undefined
      ? !!(await db
          .prepare("SELECT id FROM devices WHERE id>? ORDER BY id LIMIT 1")
          .bind(last)
          .first())
      : false;
  return json({
    devices: page.results.map(publicDevice),
    next_after_id: more ? last : null,
    has_more: more,
  });
}
