import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import { SQL } from "../src/service";

it("upgrades schema 2 without losing business data or resetting the highwater", async () => {
  const db = env.MIGRATION_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 2));
  await db.batch([
    db.prepare(
      "INSERT INTO devices(id,name,last_ack_change_seq) VALUES('existing','Existing',1)",
    ),
    db.prepare(
      "INSERT INTO archive_entries_v2(id,title,server_updated_at) VALUES('123','Keep gallery',1)",
    ),
    db.prepare(
      "INSERT INTO search_history_v2(id,last_access_time,server_updated_at) VALUES('history','now',1)",
    ),
    db.prepare(
      "INSERT INTO search_bookmarks_v2(id,position_key,server_updated_at) VALUES('bookmark','a',1)",
    ),
    db.prepare(
      "INSERT INTO tag_access_count_v2(id,qualifier,namespace,term,count,server_updated_at) VALUES('q:ns:term','q','ns','term',99,1)",
    ),
    db.prepare(
      "INSERT INTO changes(entity_table,entity_id,entity_sync_version,operation,updated_at) VALUES('tag_access_count_v2','q:ns:term',0,'create',1)",
    ),
  ]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(
    await db
      .prepare("SELECT title FROM archive_entries_v2 WHERE id='123'")
      .first("title"),
  ).toBe("Keep gallery");
  expect(await db.prepare("SELECT id FROM search_history_v2").first("id")).toBe(
    "history",
  );
  expect(
    await db.prepare("SELECT id FROM search_bookmarks_v2").first("id"),
  ).toBe("bookmark");
  expect(await db.prepare("SELECT id FROM devices").first("id")).toBe(
    "existing",
  );
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM tag_access_count_v2")
      .first("n"),
  ).toBe(0);
  expect(await db.prepare(SQL.profileInfo).first()).toMatchObject({
    schema_version: 3,
    min_valid_change_seq: 1,
    current_change_seq: 1,
  });
  await db
    .prepare(
      "INSERT INTO changes(entity_table,entity_id,entity_sync_version,operation,updated_at) VALUES('archive_entries_v2','123',0,'create',2)",
    )
    .run();
  expect(
    await db.prepare("SELECT MAX(change_seq) AS seq FROM changes").first("seq"),
  ).toBe(2);
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
});
