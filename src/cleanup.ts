import { SQL } from "./service";
import {
  ApiError,
  ENTITY_TABLES,
  MAX_HISTORY_ROWS,
  MAX_OPERATIONS,
  RETENTION_MS,
} from "./types";
import { sha256Hex } from "./validation";

interface CleanupPlanRow {
  current_change_seq: number;
  min_valid_change_seq: number;
  change_count: number;
  delete_through_change_seq: number | null;
  processed_op_count: number;
  processed_batch_count: number;
}

export interface WriteCleanupPlan {
  floor: number;
  statements: D1PreparedStatement[];
}

function cleanupStatements(
  db: D1Database,
  now: number,
  floor: number,
  retainedBatches: number,
): D1PreparedStatement[] {
  const cutoff = now - RETENTION_MS;
  return [
    db.prepare(SQL.cleanupExpireByFloor).bind(now, floor),
    db.prepare(SQL.cleanupClearPointers),
    db.prepare(SQL.cleanupChanges).bind(floor),
    db.prepare(SQL.cleanupProfileFloor).bind(floor),
    ...ENTITY_TABLES.filter((table) => table !== "global_reader_config_v2")
      .map((table) => db.prepare(SQL.entities[table].cleanupTombstones).bind(cutoff)),
    db.prepare(SQL.cleanupOpsByAge).bind(cutoff),
    db.prepare(SQL.cleanupBatchesByAge).bind(cutoff),
    db.prepare(SQL.cleanupOpsByCapacity).bind(retainedBatches),
    db.prepare(SQL.cleanupBatchesByCapacity).bind(retainedBatches),
    db.prepare(SQL.cleanupCompletedSessions).bind(now - 24 * 60 * 60 * 1000),
    db.prepare(SQL.cleanupRateLimits).bind(now - 10 * 60 * 1000),
  ];
}

export async function planWriteCleanup(
  db: D1Database,
  now: number,
  newChanges: number,
  newOperations: number,
  newBatches: number,
  includeStatements = false,
): Promise<WriteCleanupPlan> {
  const retainedChanges = Math.max(0, MAX_HISTORY_ROWS - newChanges);
  const cutoff = now - RETENTION_MS;
  const plan = await db
    .prepare(SQL.cleanupFloorPlan)
    .bind(cutoff, cutoff, retainedChanges)
    .first<CleanupPlanRow>();
  if (plan === null) throw new ApiError(503, "DATABASE_UNAVAILABLE", "database is unavailable");

  const floor = Math.max(
    plan.min_valid_change_seq,
    plan.delete_through_change_seq ?? 0,
  );
  const batchesByBatchLimit = Math.max(0, MAX_HISTORY_ROWS - newBatches);
  const mustTrimOperations = plan.processed_op_count + newOperations > MAX_HISTORY_ROWS;
  const batchesByOperationLimit = mustTrimOperations
    ? Math.max(0, Math.floor((MAX_HISTORY_ROWS - newOperations) / MAX_OPERATIONS))
    : batchesByBatchLimit;
  const retainedBatches = Math.min(batchesByBatchLimit, batchesByOperationLimit);

  return {
    floor,
    statements: includeStatements
      ? cleanupStatements(db, now, floor, retainedBatches)
      : [],
  };
}

export async function performCleanup(db: D1Database, now = Date.now()): Promise<void> {
  const plan = await planWriteCleanup(db, now, 0, 0, 0, true);
  await db.batch([...plan.statements, db.prepare(SQL.assertionClear)]);
}

export async function enforceRateLimit(
  db: D1Database,
  scope: string,
  rawSubject: string,
  maximum: number,
  now = Date.now(),
): Promise<void> {
  const subject = await sha256Hex(rawSubject);
  const windowStart = Math.floor(now / 60_000) * 60_000;
  const row = await db
    .prepare(SQL.rateLimitIncrement)
    .bind(scope, subject, windowStart)
    .first<{ request_count: number }>();
  if (row === null) throw new ApiError(503, "DATABASE_UNAVAILABLE", "database is unavailable");
  if (row.request_count > maximum) {
    throw new ApiError(429, "RATE_LIMITED", "request rate limit exceeded", {
      retry_after_seconds: 60,
    });
  }
}
