import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { cleanup } from "../src/cleanup";
import { SQL } from "../src/sql";

const testEnv = {
  ...env,
  API_LIMITER: { limit: async () => ({ success: true }) },
};
async function call(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  overrides: Partial<Env> = {},
) {
  return handle(
    new Request("https://test" + path, {
      method,
      headers: {
        Authorization: "Bearer " + "a".repeat(64),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...testEnv, ...overrides },
  );
}
async function register(id = "a") {
  const r = await call("/v1/devices/" + id, {}, "PUT");
  expect(r.status).toBe(201);
}
async function upload(ops: unknown[], seq = 1, device = "a") {
  return call("/v1/write", {
    device_id: device,
    request_seq: seq,
    operations: ops,
  });
}
const create = (id: string, content: unknown = { v: 1 }) => ({
  operation: "create",
  tablename: "t",
  id,
  content,
});
async function data(response: Response): Promise<Record<string, any>> {
  return response.json();
}

describe("HTTP and validation", () => {
  it("health is public and authentication has a uniform error", async () => {
    expect(
      (await handle(new Request("https://test/v1/health"), testEnv)).status,
    ).toBe(200);
    for (const auth of ["", "Bearer bad", "Bearer " + "b".repeat(64)]) {
      const r = await handle(
        new Request("https://test/v1/devices", {
          headers: { Authorization: auth },
        }),
        testEnv,
      );
      expect(r.status).toBe(401);
      expect(await data(r)).toEqual({
        error: { code: "UNAUTHORIZED", message: "UNAUTHORIZED" },
      });
    }
    expect(
      (
        await call("/v1/devices", undefined, "GET", {
          MASTER_KEY: "b".repeat(64),
        })
      ).status,
    ).toBe(401);
  });
  it("enforces routing, content type, unknown fields and rate limit", async () => {
    expect((await call("/bad")).status).toBe(404);
    expect((await call("/v1/write")).headers.get("Allow")).toBe("POST");
    expect((await call("/v1/devices/a", { typo: 1 }, "PUT")).status).toBe(400);
    expect(
      (
        await call("/v1/devices", undefined, "GET", {
          API_LIMITER: { limit: async () => ({ success: false }) },
        })
      ).status,
    ).toBe(429);
    const r = await handle(
      new Request("https://test/v1/write", {
        method: "POST",
        headers: { Authorization: "Bearer " + "a".repeat(64) },
        body: "{}",
      }),
      testEnv,
    );
    expect(r.status).toBe(415);
  });
  it("rejects duplicate JSON keys and preserves prototype-like business fields", async () => {
    await register();
    const duplicate = await handle(
      new Request("https://test/v1/write", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + "a".repeat(64),
          "Content-Type": "application/json",
        },
        body: '{"device_id":"a","device_id":"b"}',
      }),
      testEnv,
    );
    expect(duplicate.status).toBe(400);
    const content = JSON.parse('{"__proto__":{"a":1},"constructor":2}');
    expect((await upload([create("x", content)])).status).toBe(200);
    const r = await data(
      await call("/v1/sync", { device_id: "a", seq: 0, include_self: true }),
    );
    expect(r.changes[0].content).toEqual(content);
  });
});
describe("devices", () => {
  it("registers, patches, paginates and preserves private state", async () => {
    await register("a");
    await register("b");
    await upload([create("x")]);
    expect((await call("/v1/devices/a", { name: "Name" }, "PUT")).status).toBe(
      200,
    );
    const page = await data(await call("/v1/devices?limit=1"));
    expect(page.next_after_id).toBe("a");
    expect(page.devices[0].last_request_seq).toBe(1);
    expect(page.devices[0]).not.toHaveProperty("last_request_hash");
    expect(
      (await data(await call("/v1/devices?after_id=a"))).devices[0].id,
    ).toBe("b");
    await call("/v1/devices/a", { disabled: true }, "PATCH");
    expect((await upload([create("x")])).status).toBe(403);
    await call("/v1/devices/a", { disabled: false }, "PATCH");
    expect(
      (await data(await upload([create("x")]))).results[0].sync_version,
    ).toBe(1);
    expect(
      (await call("/v1/devices/missing", { disabled: true }, "PATCH")).status,
    ).toBe(404);
  });
});
describe("write and idempotency", () => {
  it("supports mixed outcomes, deletion and recovery with monotonic versions", async () => {
    await register();
    expect(
      (
        await data(await upload([create("A"), create("B"), create("C")]))
      ).results.every((r: any) => r.success),
    ).toBe(true);
    const r = await data(
      await upload(
        [
          create("A"),
          {
            ...create("B", { v: 2 }),
            operation: "update",
            base_sync_version: 9,
          },
          {
            operation: "delete",
            tablename: "t",
            id: "C",
            base_sync_version: 1,
          },
        ],
        2,
      ),
    );
    expect(r.results.map((v: any) => v.code ?? v.sync_version)).toEqual([
      "ALREADY_EXISTS",
      "VERSION_CONFLICT",
      2,
    ]);
    const row = await env.DB.prepare(
      "SELECT * FROM data WHERE tablename=? AND id=?",
    )
      .bind("t", "C")
      .first();
    expect(row?.content).toBeNull();
    await register("b");
    expect(
      (await data(await upload([create("C", null)], 1, "b"))).results[0]
        .sync_version,
    ).toBe(3);
    const restored = await env.DB.prepare(
      "SELECT * FROM data WHERE tablename=? AND id=?",
    )
      .bind("t", "C")
      .first();
    expect(restored?.created_by_device_id).toBe("a");
    expect(restored?.updated_by_device_id).toBe("b");
    expect(restored?.content).toBe("null");
  });
  it("returns mixed 10-item results; rejects 11, duplicates, bad limit and delete content", async () => {
    await register();
    expect(
      (await upload(Array.from({ length: 11 }, (_, i) => create(String(i)))))
        .status,
    ).toBe(400);
    expect((await upload([create("a"), create("a")])).status).toBe(400);
    expect(
      (
        await upload([
          {
            operation: "delete",
            tablename: "t",
            id: "a",
            base_sync_version: 1,
            content: null,
          },
        ])
      ).status,
    ).toBe(400);
    const ten = await upload(
      Array.from({ length: 10 }, (_, i) => create(String(i))),
    );
    const tenBody = await data(ten);
    expect(ten.status, JSON.stringify(tenBody)).toBe(200);
    expect(tenBody.results).toHaveLength(10);
    for (const limit of [0, 101, 1.5, "100", null])
      expect(
        (await call("/v1/sync", { device_id: "a", seq: 0, limit })).status,
      ).toBe(400);
  });
  it("replays identical bytes and rejects reused, expired and out-of-order numbers", async () => {
    await register();
    const forced = { ...create("x"), operation: "update", forced: true };
    const first = await data(await upload([forced]));
    expect(await data(await upload([forced]))).toEqual(first);
    expect((await data(await upload([create("other")]))).error.code).toBe(
      "REQUEST_SEQ_REUSED",
    );
    expect((await data(await upload([forced], 3))).error.code).toBe(
      "REQUEST_OUT_OF_ORDER",
    );
    await upload([forced], 2);
    expect((await data(await upload([forced]))).error.code).toBe(
      "REQUEST_EXPIRED",
    );
    expect(
      await env.DB.prepare(
        "SELECT seq FROM changes ORDER BY seq DESC LIMIT 1",
      ).first("seq"),
    ).toBe(2);
  });
  it("serializes duplicate concurrent batches and competing versions", async () => {
    await register();
    await register("b");
    const first = await Promise.all([
      upload([create("x")]),
      upload([create("x")]),
    ]);
    expect(await data(first[0])).toEqual(await data(first[1]));
    const op = {
      ...create("x", { v: 2 }),
      operation: "update",
      base_sync_version: 1,
    };
    const replies = await Promise.all([upload([op], 2), upload([op], 1, "b")]);
    const results = await Promise.all(replies.map(data));
    expect(
      results.flatMap((r) => r.results).filter((r) => r.success),
    ).toHaveLength(1);
    expect(
      results
        .flatMap((r) => r.results)
        .filter((r) => r.code === "VERSION_CONFLICT"),
    ).toHaveLength(1);
  });
  it("rolls back data, changes and receipt on an actual SQL failure", async () => {
    await register();
    await env.DB.exec(
      "CREATE TRIGGER fail_change BEFORE INSERT ON changes WHEN NEW.id='bad' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    const r = await upload([create("ok"), create("bad")]);
    expect(r.status).toBe(503);
    expect(
      await env.DB.prepare(
        "SELECT id FROM data WHERE tablename='t' AND id='ok'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT last_request_seq FROM devices WHERE id='a'",
      ).first("last_request_seq"),
    ).toBe(0);
    await env.DB.exec("DROP TRIGGER fail_change");
    expect((await upload([create("ok"), create("bad")])).status).toBe(200);
  });
});
describe("incremental and full download", () => {
  it("merges only a page and filters by current writer, advancing empty pages", async () => {
    await register();
    await register("b");
    await upload([create("x")]);
    await upload(
      [{ ...create("x"), operation: "update", forced: true }],
      1,
      "b",
    );
    await upload([{ ...create("x"), operation: "update", forced: true }], 2);
    const r = await data(
      await call("/v1/sync", { device_id: "a", seq: 0, limit: 2 }),
    );
    expect(r).toEqual({ changes: [], next_seq: 2, has_more: true });
    const self = await data(
      await call("/v1/sync", {
        device_id: "a",
        seq: 0,
        limit: 2,
        include_self: true,
      }),
    );
    expect(self.changes[0].sync_version).toBe(3);
    expect(
      await env.DB.prepare("SELECT last_seq FROM devices WHERE id='a'").first(
        "last_seq",
      ),
    ).toBe(0);
    await call("/v1/sync", { device_id: "a", seq: 2 });
    expect(
      await env.DB.prepare("SELECT last_seq FROM devices WHERE id='a'").first(
        "last_seq",
      ),
    ).toBe(2);
  });
  it("handles empty databases, pruned boundaries and ahead cursors", async () => {
    await register();
    expect(
      await data(await call("/v1/sync", { device_id: "a", seq: 0 })),
    ).toEqual({ changes: [], next_seq: 0, has_more: false });
    await upload([create("a"), create("b"), create("c")]);
    await env.DB.prepare("DELETE FROM changes WHERE seq=?").bind(1).run();
    expect((await call("/v1/sync", { device_id: "a", seq: 0 })).status).toBe(
      410,
    );
    expect((await call("/v1/sync", { device_id: "a", seq: 1 })).status).toBe(
      200,
    );
    expect((await call("/v1/sync", { device_id: "a", seq: 4 })).status).toBe(
      400,
    );
  });
  it("downloads arbitrary tuple keys, tombstones and catches inserts behind the cursor", async () => {
    await register();
    await register("b");
    await upload([{ ...create(""), tablename: "" }, create("z")]);
    const first = await data(
      await call("/v1/full-download", { device_id: "b", limit: 1 }),
    );
    expect(first.data[0].tablename).toBe("");
    expect(first.next_cursor.after).toEqual({ tablename: "", id: "" });
    await upload(
      [
        { ...create("a"), tablename: "" },
        { operation: "delete", tablename: "t", id: "z", base_sync_version: 1 },
      ],
      2,
    );
    const second = await data(
      await call("/v1/full-download", {
        device_id: "b",
        cursor: first.next_cursor,
      }),
    );
    expect(second.data.map((r: any) => r.id)).toEqual(["a", "z"]);
    expect(second.data[1].deleted).toBe(true);
    expect(second.start_seq).toBe(2);
    expect(second.next_cursor).toBeNull();
    const catchup = await data(
      await call("/v1/sync", {
        device_id: "b",
        seq: first.start_seq,
        include_self: true,
      }),
    );
    expect(catchup.changes).toHaveLength(2);
  });
});

describe("additional contract boundaries", () => {
  it("streams a default page of 100 records and then resumes at its actual boundary", async () => {
    await register();
    await register("b");
    for (let batch = 0; batch < 11; batch++) {
      const r = await upload(
        Array.from({ length: 10 }, (_, i) =>
          create(String(batch * 10 + i).padStart(3, "0")),
        ),
        batch + 1,
      );
      expect(r.status).toBe(200);
    }
    const first = await data(
      await call("/v1/sync", { device_id: "b", seq: 0 }),
    );
    expect(first.changes).toHaveLength(100);
    expect(first.next_seq).toBe(100);
    expect(first.has_more).toBe(true);
    const last = await data(
      await call("/v1/sync", { device_id: "b", seq: first.next_seq }),
    );
    expect(last.changes).toHaveLength(10);
    expect(last.next_seq).toBe(110);
    expect(last.has_more).toBe(false);
    const full = await data(
      await call("/v1/full-download", { device_id: "b" }),
    );
    expect(full.data).toHaveLength(100);
    expect(full.next_cursor.after.id).toBe("099");
    const tail = await data(
      await call("/v1/full-download", {
        device_id: "b",
        cursor: full.next_cursor,
      }),
    );
    expect(tail.data).toHaveLength(10);
    expect(tail.next_cursor).toBeNull();
  });
  it("distinguishes delimiter-like tuples and returns lossless JSON content", async () => {
    await register();
    await upload([
      { ...create("b:c"), tablename: "a" },
      { ...create("c"), tablename: "a:b" },
      { ...create(""), tablename: "" },
    ]);
    const full = await data(
      await call("/v1/full-download", { device_id: "a" }),
    );
    expect(full.data).toHaveLength(3);
    const raw =
      '{"device_id":"a","request_seq":2,"operations":[{"operation":"create","tablename":"t","id":"number","content":{"n":9007199254740993,"huge":1e400}}]}';
    const r = await handle(
      new Request("https://test/v1/write", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + "a".repeat(64),
          "Content-Type": "application/json",
        },
        body: raw,
      }),
      testEnv,
    );
    expect(r.status).toBe(200);
    const text = await (
      await call("/v1/sync", { device_id: "a", seq: 3, include_self: true })
    ).text();
    expect(text).toContain("9007199254740993");
    expect(text).toContain("1e400");
  });
  it("consumes all-business-failure batches but not invalid bodies", async () => {
    await register();
    const op = {
      operation: "delete",
      tablename: "t",
      id: "missing",
      forced: true,
    };
    const r = await data(await upload([op]));
    expect(r.results[0].code).toBe("ENTITY_NOT_FOUND");
    expect(r.results[0]).not.toHaveProperty("sync_version");
    expect(await data(await upload([op]))).toEqual(r);
    expect(
      (await data(await upload([create("x")], 2))).results[0].success,
    ).toBe(true);
  });
  it("expires full-download cursors and preserves valid empty or malformed key handling", async () => {
    await register();
    await upload([create("a"), create("b")]);
    const first = await data(
      await call("/v1/full-download", { device_id: "a", limit: 1 }),
    );
    await upload([create("c"), create("d")], 2);
    await env.DB.prepare("DELETE FROM changes WHERE seq<=?").bind(3).run();
    expect(
      (
        await call("/v1/full-download", {
          device_id: "a",
          cursor: first.next_cursor,
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await call("/v1/full-download", {
          device_id: "a",
          cursor: { start_seq: 4, after: { tablename: "t" } },
        })
      ).status,
    ).toBe(400);
    const empty = await data(
      await call("/v1/full-download", {
        device_id: "a",
        cursor: { start_seq: 4, after: { tablename: "z", id: "" } },
      }),
    );
    expect(empty.data).toEqual([]);
    expect(empty.next_cursor).toBeNull();
  });
});
