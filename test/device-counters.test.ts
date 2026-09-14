import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, bind, dataOf, errorOf, json } from "./helpers";
import { SQL } from "../src/service";

const counter = (deviceId: string, count: number) => ({
  op_id: crypto.randomUUID(),
  table: "tag_access_count_v2",
  entity_id: `${deviceId}::artist:tag`,
  operation: "upsert",
  base_sync_version: null,
  data: {
    device_id: deviceId,
    qualifier: "",
    namespace: "artist",
    term: "tag",
    count,
  },
});
const body = (operations: unknown[]) => ({
  batch_id: crypto.randomUUID(),
  cursor: 0,
  ack_cursor: 0,
  limit: 200,
  operations,
});
const sync = (deviceId: string, request: unknown) =>
  api("/v1/sync", { method: "POST", deviceId, body: request });

describe.sequential("per-device cumulative counters", () => {
  it("sums separate components and makes retries and out-of-order writes idempotent", async () => {
    await bind("counter-a", "A");
    await bind("counter-b", "B");
    const first = body([counter("counter-a", 8)]);
    expect((await sync("counter-a", first)).status).toBe(200);
    expect(
      (await sync("counter-b", body([counter("counter-b", 5)]))).status,
    ).toBe(200);
    const replay = dataOf(await json(await sync("counter-a", first)));
    expect((replay.results as { status: string }[])[0]?.status).toBe(
      "replayed",
    );
    expect(
      await env.DB.prepare(
        "SELECT SUM(count) AS total FROM tag_access_count_v2",
      ).first("total"),
    ).toBe(13);
    const replies = await Promise.all([
      sync("counter-a", body([counter("counter-a", 9)])),
      sync("counter-a", body([counter("counter-a", 7)])),
    ]);
    expect(replies.map((r) => r.status)).toEqual([200, 200]);
    expect(
      await env.DB.prepare(
        "SELECT SUM(count) AS total FROM tag_access_count_v2",
      ).first("total"),
    ).toBe(14);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM tag_access_count_v2",
      ).first("n"),
    ).toBe(2);
  });

  it("rejects writes to another device, mismatched keys and counter deletion atomically", async () => {
    const wrongOwner = await sync(
      "counter-a",
      body([counter("counter-b", 999)]),
    );
    expect(wrongOwner.status).toBe(400);
    expect(errorOf(await json(wrongOwner)).code).toBe("INVALID_REQUEST");
    const mismatch = counter("counter-a", 999);
    mismatch.data.device_id = "counter-b";
    expect((await sync("counter-a", body([mismatch]))).status).toBe(400);
    expect(
      (
        await sync(
          "counter-a",
          body([
            {
              op_id: "delete",
              table: "tag_access_count_v2",
              entity_id: "counter-a::artist:tag",
              operation: "delete",
              base_sync_version: 2,
            },
          ]),
        )
      ).status,
    ).toBe(400);
    await expect(
      env.DB.batch([
        env.DB.prepare(SQL.entities.tag_access_count_v2.upsert).bind(
          "counter-b::artist:tag",
          JSON.stringify(counter("counter-b", 999).data),
          Date.now(),
          "counter-a",
        ),
        env.DB.prepare(SQL.assertionChanges),
      ]),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT SUM(count) AS total FROM tag_access_count_v2",
      ).first("total"),
    ).toBe(14);
  });

  it("pulls both components and retains contributions after a device is unbound", async () => {
    const pulled = dataOf(
      await json(
        await sync("counter-a", {
          cursor: 0,
          ack_cursor: 0,
          limit: 200,
          operations: [],
        }),
      ),
    );
    const changes = pulled.changes as {
      payload: { device_id: string; count: number };
    }[];
    expect(new Set(changes.map((c) => c.payload.device_id))).toEqual(
      new Set(["counter-a", "counter-b"]),
    );
    expect(
      (
        await api("/v1/devices/counter-b", {
          method: "DELETE",
          deviceId: "counter-a",
        })
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT SUM(count) AS total FROM tag_access_count_v2",
      ).first("total"),
    ).toBe(14);
  });
});
