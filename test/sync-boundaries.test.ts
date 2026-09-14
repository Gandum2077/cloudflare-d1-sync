import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { performCleanup } from "../src/cleanup";
import { SQL } from "../src/service";
import { api, bind, dataOf, json } from "./helpers";

const post = async (path: string, body: unknown) => {
  const response = await api(path, {
    method: "POST",
    deviceId: "boundary-device",
    body,
  });
  expect(response.status).toBe(200);
  return dataOf(await json(response));
};

describe.sequential("sync boundary recovery", () => {
  it("retains the highwater after all history expires, completes full sync, and accepts subsequent writes", async () => {
    await bind("boundary-device", "Boundary");
    await env.DB.prepare(
      "INSERT INTO marked_uploaders_v2(id,server_updated_at) VALUES('author',1)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO changes(entity_table,entity_id,entity_sync_version,operation,updated_at) VALUES('marked_uploaders_v2','author',0,'create',1)",
    ).run();
    await performCleanup(env.DB, Date.now());
    expect(await env.DB.prepare(SQL.profileInfo).first()).toMatchObject({
      min_valid_change_seq: 1,
      current_change_seq: 1,
    });
    const pulled = await post("/v1/sync", {
      cursor: 1,
      ack_cursor: 1,
      limit: 200,
      operations: [],
    });
    expect(pulled.next_cursor).toBe(1);
    const start = await post("/v1/full-sync/start", {
      request_id: "after-cleanup",
    });
    expect(start.baseline_seq).toBe(1);
    const data = await post("/v1/full-sync/data", {
      session_id: start.session_id,
      cursor: null,
      limit: 500,
    });
    const seal = await post("/v1/full-sync/seal", {
      session_id: start.session_id,
      terminal_cursor: data.terminal_cursor,
    });
    expect(seal.target_seq).toBe(1);
    await post("/v1/full-sync/changes", {
      session_id: start.session_id,
      cursor: 1,
      limit: 500,
    });
    await post("/v1/full-sync/complete", {
      session_id: start.session_id,
      target_seq: 1,
    });
    const write = await post("/v1/sync", {
      batch_id: "after-cleanup",
      cursor: 1,
      ack_cursor: 1,
      limit: 200,
      operations: [
        {
          op_id: "create",
          table: "marked_uploaders_v2",
          entity_id: "new-author",
          operation: "create",
          base_sync_version: null,
          data: {},
        },
      ],
    });
    expect(write.next_cursor).toBe(2);
  });

  it("uploads and paginates empty search IDs without dropping or repeating rows", async () => {
    await post("/v1/sync", {
      batch_id: "empty-search",
      cursor: 2,
      ack_cursor: 2,
      limit: 200,
      operations: [
        {
          op_id: "empty-history",
          table: "search_history_v2",
          entity_id: "",
          operation: "create",
          base_sync_version: null,
          data: { last_access_time: "now", search_terms_json: "[]" },
        },
        {
          op_id: "next-history",
          table: "search_history_v2",
          entity_id: "next",
          operation: "create",
          base_sync_version: null,
          data: { last_access_time: "now" },
        },
        {
          op_id: "empty-bookmark",
          table: "search_bookmarks_v2",
          entity_id: "",
          operation: "create",
          base_sync_version: null,
          data: { position_key: "a", search_terms_json: "[]" },
        },
      ],
    });
    const start = await post("/v1/full-sync/start", {
      request_id: "empty-ids",
    });
    let cursor: unknown = null;
    const searchRows: string[] = [];
    for (let i = 0; i < 10; i++) {
      const page = await post("/v1/full-sync/data", {
        session_id: start.session_id,
        cursor,
        limit: 1,
      });
      expect(
        await post("/v1/full-sync/data", {
          session_id: start.session_id,
          cursor,
          limit: 1,
        }),
      ).toMatchObject({ rows: page.rows, next_cursor: page.next_cursor });
      for (const row of page.rows as {
        table: string;
        entity: { id: string };
      }[])
        if (row.table.startsWith("search_"))
          searchRows.push(`${row.table}/${row.entity.id}`);
      if (page.has_more === false) break;
      cursor = page.next_cursor;
    }
    expect(searchRows).toEqual([
      "search_history_v2/",
      "search_history_v2/next",
      "search_bookmarks_v2/",
    ]);
  });

  it("counts reactivated devices against capacity but allows active devices to bind again", async () => {
    for (let i = 0; i < 19; i++)
      await env.DB.prepare("INSERT INTO devices(id,name) VALUES(?,?)")
        .bind(`boundary-${i}`, "Boundary")
        .run();
    await env.DB.prepare(
      "INSERT INTO devices(id,name,deleted) VALUES('retired','Retired',1)",
    ).run();
    expect(
      (
        await api("/v1/devices/bind", {
          method: "POST",
          body: { device_id: "retired", name: "Retired" },
        })
      ).status,
    ).toBe(429);
    expect(
      await env.DB.prepare(
        "SELECT deleted FROM devices WHERE id='retired'",
      ).first("deleted"),
    ).toBe(1);
    expect(
      (
        await api("/v1/devices/bind", {
          method: "POST",
          body: { device_id: "boundary-device", name: "Renamed" },
        })
      ).status,
    ).toBe(200);
    await env.DB.prepare(
      "UPDATE devices SET deleted=1 WHERE id='boundary-0'",
    ).run();
    expect(
      (
        await api("/v1/devices/bind", {
          method: "POST",
          body: { device_id: "retired", name: "Retired" },
        })
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM devices WHERE deleted=0",
      ).first("n"),
    ).toBe(20);
  });
});
