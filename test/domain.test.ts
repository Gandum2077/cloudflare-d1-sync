import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ENTITY_TABLES, type EntityTable, type JsonObject } from "../src/types";
import { performCleanup } from "../src/cleanup";
import { SQL } from "../src/service";
import { api, bind, dataOf, errorOf, json } from "./helpers";

type Op = Record<string, unknown>;
const fixtures: { table: EntityTable; id: string; data: JsonObject }[] = [
  { table: "archive_entries_v2", id: "123", data: { title: "Gallery", token: "gallery-token", taglist_json: '[{"tags":["tag"],"namespace":"custom"}]' } },
  { table: "archive_read_state_v2", id: "123", data: { first_access_time: "first", last_access_time: "last" } },
  { table: "archive_favorite_state_v2", id: "123", data: { favorited: 1, favcat: 9 } },
  { table: "archive_rate_state_v2", id: "123", data: { average_rating: 4.5, display_rating: 4.7, is_my_rating: 1 } },
  { table: "gallery_reader_config_v2", id: "123", data: { pageDirection: "vertical" } },
  { table: "global_reader_config_v2", id: "1", data: { pagingGesture: "swipe" } },
  { table: "search_history_v2", id: " opaque:search ", data: { last_access_time: "last", search_terms_json: '[{"term":"t","dollar":1}]' } },
  { table: "search_bookmarks_v2", id: "bookmark", data: { position_key: "a", search_terms_json: '[{"term":"t","namespace":null}]' } },
  { table: "ai_translation_services_v2", id: "ai", data: { name: "AI", script_text: "translate()", config_form: "[]", config: "{}" } },
  { table: "webdav_services_v2", id: "dav", data: { name: "DAV", host: "example.com", port: 443, https: 1, path: "/files", enabled: 1 } },
  { table: "local_marked_tags_v2", id: "custom:name", data: { namespace: "custom", name: "name", watched: 1, hidden: null, weight: -5 } },
  { table: "marked_uploaders_v2", id: "uploader", data: {} },
  { table: "tag_access_count_v2", id: "q:ns:t", data: { qualifier: "q", namespace: "ns", term: "t", count: 2 } },
  { table: "favorite_images_v2", id: "123:0", data: { gid: 123, page_index: 0, favorited_at: "now" } },
];

function op(table: EntityTable, id: string, data: JsonObject, kind = "create", base: number | null = null): Op {
  return { op_id: crypto.randomUUID(), table, entity_id: id, operation: kind, base_sync_version: base,
    ...(kind === "delete" ? {} : { data }) };
}

async function sync(operations: Op[], deviceId = "domain-source", batchId = crypto.randomUUID()) {
  const cursor = await env.DB.prepare("SELECT COALESCE(MAX(change_seq), 0) AS seq FROM changes").first<number>("seq");
  return await api("/v1/sync", { method: "POST", deviceId, body: {
    ...(operations.length === 0 ? {} : { batch_id: batchId }), cursor, ack_cursor: 0, limit: 200, operations,
  } });
}

async function post(path: string, body: Record<string, unknown>, deviceId = "domain-target") {
  const response = await api(path, { method: "POST", deviceId, body });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return dataOf(await json(response));
}

async function apply(operations: Op[]) {
  for (let offset = 0; offset < operations.length; offset += 8) {
    const response = await sync(operations.slice(offset, offset + 8));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  }
}

describe.sequential("real business entities", () => {
  it("creates and incrementally returns all 14 entities with defaults and safe projections", async () => {
    await bind("domain-source");
    await bind("domain-target");
    await apply(fixtures.map(({ table, id, data }) => op(table, id, data, table === "global_reader_config_v2" ? "upsert" : "create")));
    const info = await api("/v1/info", { deviceId: "domain-source" });
    expect(dataOf(await json(info)).sync_tables).toEqual(ENTITY_TABLES);
    const pulled = await post("/v1/sync", { cursor: 0, ack_cursor: 0, limit: 200, operations: [] });
    const changes = pulled.changes as { table: string; payload: JsonObject }[];
    expect(changes.map((change) => change.table)).toEqual(ENTITY_TABLES);
    expect(changes[0]?.payload).toMatchObject({ title: "Gallery", visible: 1, comment: null, taglist_json: '[{"namespace":"custom","tags":["tag"]}]' });
    expect(changes[4]?.payload).toMatchObject({ pageDirection: "vertical", spreadModeEnabled: 0, pagingGesture: "tap_and_swipe" });
    expect(changes[9]?.payload).not.toHaveProperty("username");
    expect(changes[9]?.payload).not.toHaveProperty("password");
    const columns = await env.DB.prepare("PRAGMA table_info(webdav_services_v2)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).not.toContain("password");
  });

  it("pages across every table and freezes complete payloads at the sealed watermark", async () => {
    const started = await post("/v1/full-sync/start", { request_id: "all-tables" });
    let cursor: unknown = null;
    let terminal: unknown;
    const tables: unknown[] = [];
    do {
      const page = await post("/v1/full-sync/data", { session_id: started.session_id, cursor, limit: 3 });
      const retry = await post("/v1/full-sync/data", { session_id: started.session_id, cursor, limit: 3 });
      expect(retry.rows).toEqual(page.rows);
      tables.push(...(page.rows as { table: string }[]).map((row) => row.table));
      cursor = page.next_cursor;
      terminal = page.terminal_cursor;
    } while (cursor !== null);
    expect(tables).toEqual(ENTITY_TABLES);
    await apply(fixtures.map(({ table, id, data }) => op(table, id, data, "update", 0)));
    const sealed = await post("/v1/full-sync/seal", { session_id: started.session_id, terminal_cursor: terminal });
    await apply([op("archive_entries_v2", "123", { title: "after seal" }, "update", 1)]);
    const changes = await post("/v1/full-sync/changes", { session_id: started.session_id, cursor: started.baseline_seq, limit: 500 });
    const rows = changes.changes as { table: string; payload: JsonObject }[];
    expect(rows.map((row) => row.table)).toEqual(ENTITY_TABLES);
    expect(rows[0]?.payload.title).toBe("Gallery");
    expect(rows[0]?.payload.comment).toBeNull();
    expect(rows[9]?.payload).not.toHaveProperty("password");
    await post("/v1/full-sync/complete", { session_id: started.session_id, target_seq: sealed.target_seq });
  });

  it("preserves omitted fields and writes explicit NULL in partial upserts", async () => {
    await apply([op("ai_translation_services_v2", "ai", { config: null }, "upsert")]);
    const row = await env.DB.prepare("SELECT name, script_text, config, config_form FROM ai_translation_services_v2 WHERE id = 'ai'").first();
    expect(row).toEqual({ name: "AI", script_text: "translate()", config: null, config_form: "[]" });
    const missing = await sync([op("ai_translation_services_v2", "missing-fields", { selected: 1 }, "upsert")]);
    expect(missing.status).toBe(409);
    expect(errorOf(await json(missing)).code).toBe("BATCH_REJECTED");
  });

  it("rejects missing/later parents and requires children to be tombstoned before a parent", async () => {
    const bad = await sync([op("favorite_images_v2", "456:0", { gid: 456, page_index: 0, favorited_at: "now" }), op("archive_entries_v2", "456", {})]);
    expect(bad.status).toBe(409);
    expect(await env.DB.prepare("SELECT id FROM archive_entries_v2 WHERE id = '456'").first()).toBeNull();
    await apply([op("archive_entries_v2", "456", {}), op("favorite_images_v2", "456:0", { gid: 456, page_index: 0, favorited_at: "now" })]);
    expect((await sync([op("archive_entries_v2", "456", {}, "delete", 0)])).status).toBe(409);
    expect((await sync([op("archive_entries_v2", "456", {}, "delete", 0), op("favorite_images_v2", "456:0", {}, "delete", 0)])).status).toBe(409);
    await apply([op("favorite_images_v2", "456:0", {}, "delete", 0), op("archive_entries_v2", "456", {}, "delete", 0)]);
    expect((await sync([op("archive_read_state_v2", "456", { first_access_time: "a", last_access_time: "b" })])).status).toBe(409);
    await apply([op("archive_entries_v2", "456", {}, "upsert"), op("favorite_images_v2", "456:0", {}, "upsert")]);
  });

  it("enforces both exclusive selections, ordered switches, and selection release on delete", async () => {
    for (const [table, first, field, data] of [
      ["ai_translation_services_v2", "ai", "selected", { name: "Other", script_text: "script" }],
      ["webdav_services_v2", "dav", "enabled", {}],
    ] as const) {
      if (field === "selected") await apply([op(table, first, { [field]: 1 }, "upsert")]);
      expect((await sync([op(table, "second", { ...data, [field]: 1 })])).status).toBe(409);
      expect((await sync([op(table, "second", { ...data, [field]: 1 }), op(table, first, { [field]: 0 }, "upsert")])).status).toBe(409);
      await apply([op(table, first, { [field]: 0 }, "upsert"), op(table, "second", { ...data, [field]: 1 })]);
      await apply([op(table, "second", {}, "delete", 0), op(table, first, { [field]: 1 }, "upsert")]);
      expect((await sync([op(table, "second", {}, "upsert")])).status).toBe(409);
    }
  });

  it("rejects stale counter updates and rolls back SQL-level uniqueness failures atomically", async () => {
    await apply([op("tag_access_count_v2", "q:ns:t", { count: 3 }, "update", 1)]);
    const stale = await sync([op("marked_uploaders_v2", "should-not-exist", {}), op("tag_access_count_v2", "q:ns:t", { count: 4 }, "update", 1)]);
    expect(stale.status).toBe(409);
    expect(await env.DB.prepare("SELECT id FROM marked_uploaders_v2 WHERE id = 'should-not-exist'").first()).toBeNull();
    await expect(env.DB.batch([
      env.DB.prepare(SQL.entities.marked_uploaders_v2.create).bind("sql-rollback", "{}", Date.now(), "domain-source"),
      env.DB.prepare(SQL.assertionChanges),
      env.DB.prepare(SQL.entities.webdav_services_v2.create).bind("sql-conflict", '{"enabled":1}', Date.now(), "domain-source"),
    ])).rejects.toThrow();
    expect(await env.DB.prepare("SELECT id FROM marked_uploaders_v2 WHERE id = 'sql-rollback'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM tx_assertions").first<number>("count")).toBe(0);
  });

  it("replays concurrent identical batches once and rejects WebDAV credentials without side effects", async () => {
    const operations = [op("marked_uploaders_v2", "concurrent", {})];
    const batchId = "concurrent-batch";
    const responses = await Promise.all([sync(operations, "domain-source", batchId), sync(operations, "domain-source", batchId)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const leaked = await sync([op("webdav_services_v2", "leaked", { username: "private-user", password: "private-secret" })]);
    expect(leaked.status).toBe(400);
    expect(await leaked.text()).not.toContain("private-secret");
    expect(await env.DB.prepare("SELECT id FROM webdav_services_v2 WHERE id = 'leaked'").first()).toBeNull();
  });
  it("tombstones every deletable table and cleans them without removing the global singleton", async () => {
    const deletions: Op[] = [];
    for (const table of [...ENTITY_TABLES].reverse()) {
      if (table === "global_reader_config_v2") continue;
      const rows = await env.DB.prepare(`SELECT id, sync_version FROM ${table} WHERE deleted = 0`).all<{ id: string; sync_version: number }>();
      deletions.push(...rows.results.map((row) => op(table, row.id, {}, "delete", row.sync_version)));
    }
    await apply(deletions);
    const started = await post("/v1/full-sync/start", { request_id: "tombstones" });
    const page = await post("/v1/full-sync/data", { session_id: started.session_id, cursor: null, limit: 500 });
    const rows = page.rows as { table: string; entity: JsonObject }[];
    for (const table of ENTITY_TABLES) {
      expect(rows.some((row) => row.table === table && row.entity.deleted === (table === "global_reader_config_v2" ? 0 : 1))).toBe(true);
    }
    await performCleanup(env.DB, Date.now() + 366 * 24 * 60 * 60 * 1000);
    for (const table of ENTITY_TABLES) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<number>("count")).toBe(table === "global_reader_config_v2" ? 1 : 0);
    }
  });

});
