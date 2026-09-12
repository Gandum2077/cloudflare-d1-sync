import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, bind, dataOf, errorOf, json } from "./helpers";

const archiveId = "12345";

function archiveCreate(opId: string, entityId = archiveId): Record<string, unknown> {
  return {
    op_id: opId,
    table: "archive_entries_v2",
    entity_id: entityId,
    operation: "create",
    base_sync_version: null,
    data: { title: "Example", comment: "Note", taglist_json: '[{"namespace":"misc","tags":["docs"]}]' },
  };
}

async function sync(
  deviceId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await api("/v1/sync", { method: "POST", deviceId, body });
}

describe.sequential("atomic incremental sync", () => {
  it("creates a archive entry, returns its change, and replays the batch idempotently", async () => {
    await bind("sync-a", "Sync A");
    await bind("sync-b", "Sync B");
    const body = {
      batch_id: "batch-create",
      cursor: 0,
      ack_cursor: 0,
      limit: 200,
      operations: [archiveCreate("op-create")],
    };
    const created = await sync("sync-a", body);
    expect(created.status).toBe(200);
    const createdData = dataOf(await json(created));
    const results = createdData.results as Record<string, unknown>[];
    const changes = createdData.changes as Record<string, unknown>[];
    expect(results[0]).toMatchObject({ status: "applied", sync_version: 0, change_seq: 1 });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_seq: 1, table: "archive_entries_v2", operation: "create" });

    const replay = await sync("sync-a", body);
    expect(replay.status).toBe(200);
    const replayResults = dataOf(await json(replay)).results as Record<string, unknown>[];
    expect(replayResults[0]).toMatchObject({ status: "replayed", change_seq: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM changes").first<number>("count")).toBe(1);
  });

  it("updates with OCC and rejects a stale competing batch without side effects", async () => {
    const updated = await sync("sync-a", {
      batch_id: "batch-update",
      cursor: 1,
      ack_cursor: 1,
      limit: 200,
      operations: [{
        op_id: "op-update",
        table: "archive_entries_v2",
        entity_id: archiveId,
        operation: "update",
        base_sync_version: 0,
        data: { title: "Updated" },
      }],
    });
    expect(updated.status).toBe(200);
    expect((dataOf(await json(updated)).results as Record<string, unknown>[])[0]).toMatchObject({
      sync_version: 1,
      change_seq: 2,
    });

    const stale = await sync("sync-b", {
      batch_id: "batch-stale",
      cursor: 2,
      ack_cursor: 0,
      limit: 200,
      operations: [{
        op_id: "op-stale",
        table: "archive_entries_v2",
        entity_id: archiveId,
        operation: "update",
        base_sync_version: 0,
        data: { comment: "Stale" },
      }],
    });
    expect(stale.status).toBe(409);
    expect(errorOf(await json(stale)).code).toBe("BATCH_REJECTED");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM changes").first<number>("count")).toBe(2);
  });

  it("upserts webdav_services_v2, rejects op id reuse, and pulls changes on another device", async () => {
    const upsert = await sync("sync-a", {
      batch_id: "batch-setting",
      cursor: 2,
      ack_cursor: 2,
      limit: 200,
      operations: [{
        op_id: "op-setting",
        table: "webdav_services_v2",
        entity_id: "theme",
        operation: "upsert",
        base_sync_version: null,
        data: { name: '{"mode":"dark"}' },
      }],
    });
    expect(upsert.status).toBe(200);

    const reused = await sync("sync-a", {
      batch_id: "another-batch",
      cursor: 3,
      ack_cursor: 3,
      limit: 200,
      operations: [{
        op_id: "op-setting",
        table: "webdav_services_v2",
        entity_id: "other",
        operation: "create",
        base_sync_version: null,
        data: { name: "true" },
      }],
    });
    expect(reused.status).toBe(409);
    expect(errorOf(await json(reused)).code).toBe("OP_ID_REUSED");

    const pull = await sync("sync-b", { cursor: 0, ack_cursor: 0, limit: 2, operations: [] });
    expect(pull.status).toBe(200);
    const pullData = dataOf(await json(pull));
    expect((pullData.changes as unknown[]).length).toBe(2);
    expect(pullData.has_more).toBe(true);
    expect(pullData.next_cursor).toBe(2);
  });

  it("rolls back an entire mixed batch when one operation conflicts", async () => {
    const freshId = "12346";
    const response = await sync("sync-a", {
      batch_id: "batch-atomic-reject",
      cursor: 3,
      ack_cursor: 3,
      limit: 200,
      operations: [
        archiveCreate("op-fresh", freshId),
        {
          op_id: "op-conflict",
          table: "archive_entries_v2",
          entity_id: archiveId,
          operation: "update",
          base_sync_version: 0,
          data: { title: "Will not happen" },
        },
      ],
    });
    expect(response.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_entries_v2 WHERE id = ?").bind(freshId).first<number>("count")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM processed_batches WHERE batch_id = ?").bind("batch-atomic-reject").first<number>("count")).toBe(0);
  });

  it("deletes with a tombstone and rejects malformed operations before writing", async () => {
    const duplicate = await sync("sync-a", {
      batch_id: "duplicate-entity",
      cursor: 3,
      ack_cursor: 3,
      limit: 200,
      operations: [
        { op_id: "dup-1", table: "webdav_services_v2", entity_id: "theme", operation: "update", base_sync_version: 0, data: { name: "1" } },
        { op_id: "dup-2", table: "webdav_services_v2", entity_id: "theme", operation: "delete", base_sync_version: 0 },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect(errorOf(await json(duplicate)).code).toBe("DUPLICATE_ENTITY_IN_BATCH");

    const deleted = await sync("sync-a", {
      batch_id: "delete-archive entry",
      cursor: 3,
      ack_cursor: 3,
      limit: 200,
      operations: [{
        op_id: "op-delete",
        table: "archive_entries_v2",
        entity_id: archiveId,
        operation: "delete",
        base_sync_version: 1,
      }],
    });
    expect(deleted.status).toBe(200);
    const row = await env.DB.prepare("SELECT deleted, sync_version FROM archive_entries_v2 WHERE id = ?").bind(archiveId).first<{
      deleted: number;
      sync_version: number;
    }>();
    expect(row).toEqual({ deleted: 1, sync_version: 2 });
  });

  it("commits the maximum eight-operation batch atomically", async () => {
    const operations = Array.from({ length: 8 }, (_, index) => ({
      op_id: `max-op-${index}`,
      table: "webdav_services_v2",
      entity_id: `max-setting-${index}`,
      operation: "create",
      base_sync_version: null,
      data: { name: JSON.stringify({ index }) },
    }));
    const response = await sync("sync-a", {
      batch_id: "max-eight-batch",
      cursor: 4,
      ack_cursor: 4,
      limit: 200,
      operations,
    });
    expect(response.status).toBe(200);
    expect(dataOf(await json(response)).results).toHaveLength(8);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM webdav_services_v2 WHERE id LIKE 'max-setting-%'").first<number>("count"),
    ).toBe(8);
  });
});
