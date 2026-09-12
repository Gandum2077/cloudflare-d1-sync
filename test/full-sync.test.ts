import { describe, expect, it } from "vitest";
import { api, bind, dataOf, errorOf, json } from "./helpers";

async function post(path: string, deviceId: string, body: Record<string, unknown>): Promise<Response> {
  return await api(path, { method: "POST", deviceId, body });
}

describe.sequential("full sync sessions", () => {
  it("downloads all tables, catches up to a sealed watermark, and completes idempotently", async () => {
    await bind("full-source", "Source");
    await bind("full-target", "Target");

    const create = await post("/v1/sync", "full-source", {
      batch_id: "full-seed-batch",
      cursor: 0,
      ack_cursor: 0,
      limit: 200,
      operations: [{
        op_id: "full-seed-op",
        table: "webdav_services_v2",
        entity_id: "language",
        operation: "create",
        base_sync_version: null,
        data: { name: '"zh-CN"' },
      }],
    });
    expect(create.status).toBe(200);

    const started = await post("/v1/full-sync/start", "full-target", { request_id: "full-start-1" });
    expect(started.status).toBe(200);
    const startData = dataOf(await json(started));
    expect(startData.baseline_seq).toBe(1);
    const sessionId = startData.session_id as string;

    const blocked = await post("/v1/sync", "full-target", {
      cursor: 0,
      ack_cursor: 0,
      limit: 200,
      operations: [],
    });
    expect(blocked.status).toBe(409);
    expect(errorOf(await json(blocked)).code).toBe("FULL_SYNC_IN_PROGRESS");

    const page = await post("/v1/full-sync/data", "full-target", {
      session_id: sessionId,
      cursor: null,
      limit: 1,
    });
    expect(page.status).toBe(200);
    const pageData = dataOf(await json(page));
    expect(pageData.has_more).toBe(false);
    expect((pageData.rows as Record<string, unknown>[])[0]?.table).toBe("webdav_services_v2");
    const terminalCursor = pageData.terminal_cursor as string;

    const update = await post("/v1/sync", "full-source", {
      batch_id: "full-update-batch",
      cursor: 1,
      ack_cursor: 1,
      limit: 200,
      operations: [{
        op_id: "full-update-op",
        table: "webdav_services_v2",
        entity_id: "language",
        operation: "update",
        base_sync_version: 0,
        data: { name: '"en-US"' },
      }],
    });
    expect(update.status).toBe(200);

    const sealed = await post("/v1/full-sync/seal", "full-target", {
      session_id: sessionId,
      terminal_cursor: terminalCursor,
    });
    expect(sealed.status).toBe(200);
    expect(dataOf(await json(sealed)).target_seq).toBe(2);

    const changes = await post("/v1/full-sync/changes", "full-target", {
      session_id: sessionId,
      cursor: 1,
      limit: 500,
    });
    expect(changes.status).toBe(200);
    const changeRows = dataOf(await json(changes)).changes as Record<string, unknown>[];
    expect(changeRows).toHaveLength(1);
    expect(changeRows[0]).toMatchObject({ change_seq: 2, table: "webdav_services_v2", operation: "update" });
    expect(changeRows[0]?.payload).toBeTruthy();

    const completed = await post("/v1/full-sync/complete", "full-target", {
      session_id: sessionId,
      target_seq: 2,
    });
    expect(completed.status).toBe(200);
    expect(dataOf(await json(completed))).toMatchObject({ phase: "completed", acknowledged_cursor: 2 });

    const replay = await post("/v1/full-sync/complete", "full-target", {
      session_id: sessionId,
      target_seq: 2,
    });
    expect(replay.status).toBe(200);

    const resumed = await post("/v1/sync", "full-target", {
      cursor: 2,
      ack_cursor: 2,
      limit: 200,
      operations: [],
    });
    expect(resumed.status).toBe(200);
  });

  it("rejects a session owned by another device", async () => {
    const started = await post("/v1/full-sync/start", "full-target", { request_id: "owner-check" });
    const sessionId = dataOf(await json(started)).session_id as string;
    const response = await post("/v1/full-sync/data", "full-source", {
      session_id: sessionId,
      cursor: null,
      limit: 10,
    });
    expect(response.status).toBe(403);
    expect(errorOf(await json(response)).code).toBe("SESSION_DEVICE_MISMATCH");
  });
});
