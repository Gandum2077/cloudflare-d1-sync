import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { databaseError } from "../src/http";
import { handle } from "../src/index";
import { records } from "../src/read";
import { SQL } from "../src/sql";

const quotaCases = [
  [
    "Your account has exceeded D1's free tier daily row read limit.",
    "D1_READ_QUOTA_EXCEEDED",
    429,
  ],
  [
    "Your account has exceeded D1's free tier daily row write limit.",
    "D1_WRITE_QUOTA_EXCEEDED",
    429,
  ],
  [
    "Your account has exceeded D1's maximum account storage limit, please contact Cloudflare to raise your limit",
    "D1_STORAGE_QUOTA_EXCEEDED",
    507,
  ],
  ["Exceeded maximum DB size.", "D1_DATABASE_SIZE_EXCEEDED", 507],
  ["database or disk is full: SQLITE_FULL", "D1_DATABASE_SIZE_EXCEEDED", 507],
] as const;
it.each(quotaCases)(
  "classifies %s without exposing internal details",
  async (message, code, status) => {
    const failure = new Error("D1_ERROR: " + message);
    for (const error of [
      failure,
      new Error("D1 batch failed", { cause: failure }),
    ]) {
      const result = databaseError(error);
      expect(result.code).toBe(code);
      expect(result.status).toBe(status);
      expect(result.message).toBe(code);
      if (status === 429) {
        expect(Number(result.headers["Retry-After"])).toBeGreaterThan(0);
        expect(Number(result.headers["Retry-After"])).toBeLessThanOrEqual(
          86400,
        );
      }
    }
    const response = await handle(
      new Request("https://test/v1/devices", {
        headers: { Authorization: "Bearer " + "a".repeat(64) },
      }),
      {
        ...env,
        API_LIMITER: { limit: async () => ({ success: true }) },
        DB: new Proxy(env.DB, {
          get(target, key) {
            if (key === "withSession")
              return () => {
                throw failure;
              };
            return Reflect.get(target, key);
          },
        }),
      },
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: code } });
  },
);
it.each([
  "D1 DB storage operation exceeded timeout which caused object to be reset.",
  "D1 DB exceeded its CPU time limit and was reset.",
  "D1 DB's isolate exceeded its memory limit and was reset.",
  "D1 DB is overloaded. Too many requests queued.",
  "SQLITE_CONSTRAINT: private SQL detail",
])("does not mislabel other failures as quota: %s", (message) => {
  expect(databaseError(new Error(message)).code).toBe("DATABASE_UNAVAILABLE");
});
it("keeps row-size errors separate from exhausted database storage", () => {
  expect(
    databaseError(new Error("string or blob too big: SQLITE_TOOBIG")).code,
  ).toBe("PAYLOAD_TOO_LARGE");
});
it.each(["changes", "data", "results"] as const)(
  "reports a late %s streamed quota failure without returning a commit cursor",
  async (field) => {
    const keys = Array.from({ length: 11 }, (_, i) => ({
      tablename: "t",
      id: String(i),
    }));
    await env.DB.batch(
      keys.map((k) =>
        env.DB.prepare(SQL.save).bind(
          k.tablename,
          k.id,
          "{}",
          1,
          0,
          0,
          "a",
          "a",
        ),
      ),
    );
    let pages = 0;
    function wrap(statement: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(statement, {
        get(target, key) {
          if (key === "bind")
            return (...args: unknown[]) => wrap(target.bind(...args));
          if (key === "all")
            return async () => {
              if (++pages === 2) throw new Error(quotaCases[0][0]);
              return target.all();
            };
          return Reflect.get(target, key);
        },
      });
    }
    const session = env.DB.withSession("first-primary");
    const db = new Proxy(session, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => wrap(target.prepare(sql));
        return Reflect.get(target, key);
      },
    });
    const response = records(db, keys, field, {
      next_seq: 11,
      has_more: false,
    });
    expect(response.status).toBe(200);
    const result = await response.json<{
      changes?: unknown[];
      data?: unknown[];
      results?: unknown[];
      error: { code: string };
      next_seq?: number;
      has_more?: boolean;
    }>();
    expect(result[field]).toHaveLength(10);
    expect(result.error.code).toBe("D1_READ_QUOTA_EXCEEDED");
    expect(result.next_seq).toBeUndefined();
    expect(result.has_more).toBeUndefined();
  },
);
