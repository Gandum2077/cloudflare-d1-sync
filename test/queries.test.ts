import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { SQL, pointQuery } from "../src/sql";
import { cleanup } from "../src/cleanup";

it("keeps runtime query work bounded as tables grow", async () => {
  const costs: number[][] = [];
  for (const size of [1000, 10000]) {
    // Local fixtures only: deliberately large inserts do not belong to the runtime query path.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM data"),
      env.DB.prepare("DELETE FROM changes"),
      env.DB.prepare(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
        INSERT INTO data(tablename,id,content,sync_version,deleted,server_updated_at) SELECT 't',printf('%06d',x),'{}',1,0,0 FROM n`,
      ).bind(size),
      env.DB.prepare(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
        INSERT INTO changes(seq,tablename,id,operation,device_id,server_updated_at) SELECT x,'t',printf('%06d',x),'create','a',0 FROM n`,
      ).bind(size),
    ]);
    const queries: [string, (string | number)[]][] = [
      [SQL.events, [size - 100, 100]],
      [SQL.keysAfter, ["t", String(size - 100).padStart(6, "0"), 100]],
      [SQL.tableKeysFirst, ["t", 100]],
      [SQL.tableKeysAfter, ["t", String(size - 100).padStart(6, "0"), 100]],
      [SQL.tableKeysFirst, ["missing", 100]],
      [SQL.tableKeysAfter, ["t", String(size).padStart(6, "0"), 1]],
      [pointQuery(2, "d.id,d.sync_version"), ["missing", "x", "t", "absent"]],
      [
        pointQuery(2, "d.id,d.sync_version"),
        ["t", "000001", "t", String(size).padStart(6, "0")],
      ],
      [SQL.bounds, []],
    ];
    const sample: number[] = [];
    for (const [sql, args] of queries) {
      const result = await env.DB.prepare(sql)
        .bind(...args)
        .all();
      sample.push(result.meta.rows_read);
      const plans = await env.DB.prepare("EXPLAIN QUERY PLAN " + sql)
        .bind(...args)
        .all<{ detail: string }>();
      const detail = plans.results.map((p) => p.detail).join("\n");
      expect(detail).not.toMatch(/USE TEMP B-TREE/);
      if (sql !== SQL.bounds)
        expect(detail).toMatch(/SEARCH (?:data|changes|d) USING/);
      expect(detail).not.toMatch(/SCAN (?:data|d)(?:\s|$)/);
    }
    costs.push(sample);
  }
  // Includes index/table reads, but cannot grow linearly with the 10x larger table.
  for (let i = 0; i < costs[0].length; i++)
    expect(costs[1][i]).toBeLessThanOrEqual(costs[0][i] + 10);
  expect(costs[1].every((n) => n <= 210)).toBe(true);
});

it("resumes bounded GC checkpoints without scanning or storing a counter", async () => {
  await env.DB.prepare(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<55000)
    INSERT INTO changes(seq,tablename,id,operation,device_id,server_updated_at) SELECT x,'t',CAST(x AS TEXT),'create','a',0 FROM n`,
  ).run();
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN " + SQL.cleanup)
    .bind(5000)
    .all<{ detail: string }>();
  expect(plan.results.map((p) => p.detail).join("\n")).not.toMatch(
    /SCAN changes/,
  );
  for (let pass = 0; pass < 5; pass++)
    expect(await cleanup(env.DB.withSession("first-primary"))).toBe(1000);
  expect(await cleanup(env.DB.withSession("first-primary"))).toBe(0);
  const bounds = await env.DB.prepare(SQL.bounds).first();
  expect(bounds).toEqual({ latest: 55000, oldest: 5001 });
  await env.DB.prepare(SQL.change).bind("t", "new", "create", "a", 0).run();
  expect(await env.DB.prepare(SQL.bounds).first()).toEqual({
    latest: 55001,
    oldest: 5001,
  });
});

it("keeps a ten-record create batch within 41 written rows", async () => {
  expect(
    (await env.DB.prepare("PRAGMA index_list('changes')").all()).results,
  ).toEqual([]);
  await env.DB.prepare(
    "INSERT INTO devices(id,created_at,last_seen_at) VALUES('a',0,0)",
  ).run();
  const statements = [];
  for (let i = 0; i < 10; i++) {
    statements.push(
      env.DB.prepare(SQL.save).bind("t", String(i), "{}", 1, 0, 0, "a", "a"),
    );
    statements.push(
      env.DB.prepare(SQL.change).bind("t", String(i), "create", "a", 0),
    );
  }
  statements.push(env.DB.prepare(SQL.receipt).bind(1, "hash", "{}", 0, "a"));
  const results = await env.DB.batch(statements);
  expect(
    results.reduce((sum, result) => sum + result.meta.rows_written, 0),
  ).toBe(41);
});
