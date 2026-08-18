import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { performCleanup } from "../src/cleanup";

describe.sequential("migration and maintenance", () => {
  it("creates every required table and registers only audited business tables", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = tables.results.map((row) => row.name);
    for (const required of [
      "bookmarks",
      "changes",
      "devices",
      "full_sync_sessions",
      "processed_batches",
      "processed_ops",
      "profile",
      "settings",
      "sync_tables",
      "tx_assertions",
    ]) {
      expect(names).toContain(required);
    }
    const registry = await env.DB.prepare(
      "SELECT table_name, table_order, schema_version FROM sync_tables ORDER BY table_order",
    ).all();
    expect(registry.results).toEqual([
      { table_name: "bookmarks", table_order: 1, schema_version: 1 },
      { table_name: "settings", table_order: 2, schema_version: 1 },
    ]);
  });

  it("enforces JSON constraints and removes expired tombstones during cleanup", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO settings(id, server_updated_at, value_json) VALUES ('invalid', 1, 'not-json')",
      ).run(),
    ).rejects.toThrow();

    await env.DB.prepare(
      "INSERT INTO settings(id, sync_version, deleted, server_updated_at, value_json) VALUES ('old', 1, 1, 1, 'null')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO changes(entity_table, entity_id, entity_sync_version, operation, updated_at) VALUES ('settings', 'old', 1, 'delete', 1)",
    ).run();
    await performCleanup(env.DB, Date.now());
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM settings WHERE id = 'old'").first<number>("count")).toBe(0);
    expect(await env.DB.prepare("SELECT min_valid_change_seq FROM profile WHERE id = 1").first<number>("min_valid_change_seq")).toBeGreaterThanOrEqual(1);
  });

  it("enforces the 5000-row change cap inside the write transaction", async () => {
    await env.DB.prepare(`
      WITH RECURSIVE numbers(value) AS (
        VALUES(0) UNION ALL SELECT value + 1 FROM numbers WHERE value < 70
      )
      INSERT INTO changes(entity_table, entity_id, entity_sync_version, operation, updated_at)
      SELECT 'settings', 'capacity-' || left_side.value || '-' || right_side.value,
        0, 'create', ?
      FROM numbers left_side CROSS JOIN numbers right_side
      LIMIT 5001
    `).bind(Date.now()).run();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM changes").first<number>("count")).toBe(5000);
    expect(await env.DB.prepare("SELECT min_valid_change_seq FROM profile WHERE id = 1").first<number>("min_valid_change_seq")).toBeGreaterThan(1);
  });
});
