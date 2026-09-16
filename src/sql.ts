// Every runtime query is a primary-key lookup, endpoint seek, or bounded index page.
export const SQL = {
  device: "SELECT * FROM devices WHERE id = ?",
  state:
    "SELECT sync_version, deleted FROM data WHERE tablename = ? AND id = ?",
  bounds: `SELECT COALESCE((SELECT seq FROM changes ORDER BY seq DESC LIMIT 1),0) AS latest,
    (SELECT seq FROM changes ORDER BY seq ASC LIMIT 1) AS oldest`,
  events:
    "SELECT seq, tablename, id FROM changes WHERE seq > ? ORDER BY seq LIMIT ?",
  keysFirst: "SELECT tablename, id FROM data ORDER BY tablename, id LIMIT ?",
  keysAfter:
    "SELECT tablename, id FROM data WHERE (tablename,id) > (?,?) ORDER BY tablename,id LIMIT ?",
  deviceColumns:
    "id, name, platform, last_seq, last_request_seq, created_at, last_seen_at, disabled",
  change: `INSERT INTO changes(seq,tablename,id,operation,device_id,server_updated_at)
    VALUES(COALESCE((SELECT seq FROM changes ORDER BY seq DESC LIMIT 1),0)+1,?,?,?,?,?)`,
  save: `INSERT INTO data(tablename,id,content,sync_version,deleted,server_updated_at,created_by_device_id,updated_by_device_id)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tablename,id) DO UPDATE SET
    content=excluded.content, sync_version=excluded.sync_version, deleted=excluded.deleted,
    server_updated_at=excluded.server_updated_at, updated_by_device_id=excluded.updated_by_device_id`,
  receipt:
    "UPDATE devices SET last_request_seq=?,last_request_hash=?,last_request_result=?,last_seen_at=? WHERE id=?",
  cleanup: `DELETE FROM changes WHERE seq IN (
    SELECT seq FROM changes WHERE seq <= ? ORDER BY seq LIMIT 100
  )`,
} as const;
export type Key = { tablename: string; id: string };
export type State = { sync_version: number; deleted: number };
export type Device = {
  id: string;
  name: string | null;
  platform: string | null;
  last_seq: number;
  last_request_seq: number;
  created_at: number;
  last_seen_at: number;
  disabled: number;
  last_request_hash: string | null;
  last_request_result: string | null;
};
export type Bounds = { latest: number; oldest: number | null };

// CROSS JOIN fixes the small request-key set as the outer loop; data uses its primary-key index.
export function pointQuery(count: number, columns: string): string {
  const values = Array.from({ length: count }, (_, i) => `(${i},?,?)`).join(
    ",",
  );
  return `WITH requested(idx,tablename,id) AS (VALUES ${values})
    SELECT requested.idx,${columns} FROM requested CROSS JOIN data AS d
    WHERE d.tablename=requested.tablename AND d.id=requested.id`;
}
