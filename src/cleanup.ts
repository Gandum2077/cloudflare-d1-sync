import { SQL } from "./sql";
// Writes explicitly allocate head+1 within their transaction. GC only removes a prefix.
// A fixed 5,000-event checkpoint survives across Cron runs without a counter or GC session.
export async function cleanup(db: D1DatabaseSession): Promise<number> {
  const latest =
    (await db
      .prepare("SELECT seq FROM changes ORDER BY seq DESC LIMIT 1")
      .first<number>("seq")) ?? 0;
  const cutoff = Math.floor(latest / 5000) * 5000 - 50000;
  if (cutoff <= 0) return 0;
  let removed = 0;
  for (let page = 0; page < 10; page++) {
    const result = await db.prepare(SQL.cleanup).bind(cutoff).run();
    removed += result.meta.changes;
    if (result.meta.changes < 100) break;
  }
  return removed;
}
