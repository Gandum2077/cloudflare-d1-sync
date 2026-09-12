import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ENTITY_TABLES, SCHEMA_VERSION } from "../src/types";
import { performCleanup } from "../src/cleanup";

describe.sequential("migration and maintenance", () => {
  it("upgrades a populated example schema and preserves device bindings", async () => {
    const initial = env.TEST_MIGRATIONS[0];
    if (initial === undefined) throw new Error("initial migration is missing");
    await applyD1Migrations(env.MIGRATION_DB, [initial]);
    await env.MIGRATION_DB.batch([
      env.MIGRATION_DB.prepare("INSERT INTO devices(id, name, last_ack_change_seq, full_sync_session_id) VALUES ('legacy-device', 'Legacy', 1, 'legacy-session')"),
      env.MIGRATION_DB.prepare("INSERT INTO settings(id, server_updated_at, value_json) VALUES ('legacy', 1, 'null')"),
      env.MIGRATION_DB.prepare("INSERT INTO changes(entity_table, entity_id, entity_sync_version, operation, updated_at) VALUES ('settings', 'legacy', 0, 'create', 1)"),
      env.MIGRATION_DB.prepare("INSERT INTO full_sync_sessions(id, device_id, start_request_id, baseline_seq, schema_version, phase, expires_at, created_at) VALUES ('legacy-session', 'legacy-device', 'legacy-start', 1, 1, 'downloading', 9999999999999, 1)"),
      env.MIGRATION_DB.prepare("INSERT INTO processed_batches(device_id, batch_id, request_hash, result_json, server_updated_at) VALUES ('legacy-device', 'batch', ?, '[]', 1)").bind("a".repeat(64)),
      env.MIGRATION_DB.prepare("INSERT INTO processed_ops(device_id, op_id, batch_id, request_hash, result_status, result_json, server_updated_at) VALUES ('legacy-device', 'op', 'batch', ?, 'applied', '{}', 1)").bind("a".repeat(64)),
    ]);
    await applyD1Migrations(env.MIGRATION_DB, env.TEST_MIGRATIONS);
    expect(await env.MIGRATION_DB.prepare("SELECT id, last_ack_change_seq, full_sync_session_id FROM devices").first()).toEqual({ id: "legacy-device", last_ack_change_seq: 0, full_sync_session_id: null });
    for (const table of ["changes", "processed_ops", "processed_batches", "full_sync_sessions"])
      expect(await env.MIGRATION_DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<number>("count")).toBe(0);
    expect(await env.MIGRATION_DB.prepare("SELECT name FROM sqlite_master WHERE name IN ('bookmarks', 'settings')").all()).toMatchObject({ results: [] });
    expect(await env.MIGRATION_DB.prepare("SELECT COUNT(*) AS count FROM sync_tables").first<number>("count")).toBe(14);
    await applyD1Migrations(env.MIGRATION_DB, env.TEST_MIGRATIONS);
  });

  it("creates every required table and registers only audited business tables", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = tables.results.map((row) => row.name);
    for (const required of [
      ...ENTITY_TABLES,
      "changes",
      "devices",
      "full_sync_sessions",
      "processed_batches",
      "processed_ops",
      "profile",
      "sync_tables",
      "tx_assertions",
    ]) {
      expect(names).toContain(required);
    }
    const registry = await env.DB.prepare(
      "SELECT table_name, table_order, schema_version FROM sync_tables ORDER BY table_order",
    ).all();
    expect(registry.results).toEqual(ENTITY_TABLES.map((table, index) => ({
      table_name: table, table_order: index + 1, schema_version: 1,
    })));
    expect(await env.DB.prepare("SELECT schema_version FROM profile WHERE id = 1").first<number>("schema_version")).toBe(SCHEMA_VERSION);
    for (const excluded of ["bookmarks", "settings", "archive_taglist_v2", "archive_download_state_v2", "archive_records_v2", "config", "translation_data"])
      expect(names).not.toContain(excluded);
  });

  it("enforces JSON constraints and removes expired tombstones during cleanup", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO search_bookmarks_v2(id, server_updated_at, position_key, search_terms_json) VALUES ('invalid', 1, 'a', 'not-json')",
      ).run(),
    ).rejects.toThrow();

    await env.DB.prepare(
      "INSERT INTO marked_uploaders_v2(id, sync_version, deleted, server_updated_at) VALUES ('old', 1, 1, 1)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO changes(entity_table, entity_id, entity_sync_version, operation, updated_at) VALUES ('marked_uploaders_v2', 'old', 1, 'delete', 1)",
    ).run();
    await performCleanup(env.DB, Date.now());
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM marked_uploaders_v2 WHERE id = 'old'").first<number>("count")).toBe(0);
    expect(await env.DB.prepare("SELECT min_valid_change_seq FROM profile WHERE id = 1").first<number>("min_valid_change_seq")).toBeGreaterThanOrEqual(1);
  });

  it("enforces the 5000-row change cap inside the write transaction", async () => {
    await env.DB.prepare(`
      WITH RECURSIVE numbers(value) AS (
        VALUES(0) UNION ALL SELECT value + 1 FROM numbers WHERE value < 70
      )
      INSERT INTO changes(entity_table, entity_id, entity_sync_version, operation, updated_at)
      SELECT 'marked_uploaders_v2', 'capacity-' || left_side.value || '-' || right_side.value,
        0, 'create', ?
      FROM numbers left_side CROSS JOIN numbers right_side
      LIMIT 5001
    `).bind(Date.now()).run();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM changes").first<number>("count")).toBe(5000);
    expect(await env.DB.prepare("SELECT min_valid_change_seq FROM profile WHERE id = 1").first<number>("min_valid_change_seq")).toBeGreaterThan(1);
  });
});
