import { describe, expect, it } from "vitest";
import { api, bind, dataOf, json } from "./helpers";

async function post(path: string, deviceId: string, body: Record<string, unknown>) {
  const response = await api(path, { method: "POST", deviceId, body });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  expect(new TextEncoder().encode(await response.clone().text()).byteLength).toBeLessThan(1100 * 1024);
  return dataOf(await json(response));
}

describe("large real-entity pagination", () => {
  it("advances all three cursors under the byte budget, including a long opaque key", async () => {
    await bind("large-source");
    await bind("large-target");
    await bind("large-observer");
    const started = await post("/v1/full-sync/start", "large-target", { request_id: "large-session" });
    const longId = '"'.repeat(8192);
    let sourceCursor = 0;
    for (let index = 0; index < 25; index++) {
      const response = await post("/v1/sync", "large-source", {
        batch_id: `large-${index}`, cursor: sourceCursor, ack_cursor: sourceCursor, limit: 200,
        operations: [{
          op_id: `large-op-${index}`, table: index === 0 ? "search_bookmarks_v2" : "ai_translation_services_v2",
          entity_id: index === 0 ? longId : `large-${index}`, operation: "create", base_sync_version: null,
          data: index === 0 ? { position_key: "a" } : { name: `Script ${index}`, script_text: "x".repeat(65536) },
        }],
      });
      sourceCursor = response.next_cursor as number;
    }
    const seen: string[] = [];
    let pageCursor: unknown = null;
    let terminal: unknown;
    let pageCount = 0;
    do {
      const page = await post("/v1/full-sync/data", "large-target", { session_id: started.session_id, cursor: pageCursor, limit: 500 });
      const rows = page.rows as { entity: { id: string } }[];
      expect(rows.length).toBeGreaterThan(0);
      seen.push(...rows.map((row) => row.entity.id));
      pageCursor = page.next_cursor;
      terminal = page.terminal_cursor;
      pageCount++;
      expect(pageCount).toBeLessThan(5);
    } while (pageCursor !== null);
    expect(pageCount).toBe(2);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe(longId);
    await post("/v1/full-sync/seal", "large-target", { session_id: started.session_id, terminal_cursor: terminal });

    for (const [path, deviceId] of [["/v1/sync", "large-observer"], ["/v1/full-sync/changes", "large-target"]]) {
      let cursor = 0;
      const sequences: number[] = [];
      let pages = 0;
      while (cursor < 25) {
        const page = await post(path!, deviceId!, path === "/v1/sync"
          ? { cursor, ack_cursor: cursor, limit: 200, operations: [] }
          : { session_id: started.session_id, cursor, limit: 500 });
        sequences.push(...(page.changes as { change_seq: number }[]).map((change) => change.change_seq));
        expect(page.next_cursor).toBeGreaterThan(cursor);
        cursor = page.next_cursor as number;
        expect(page.has_more).toBe(cursor < 25);
        pages++;
        expect(pages).toBeLessThan(5);
      }
      expect(pages).toBe(2);
      expect(sequences).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    }
  });
});
