import { describe, expect, it } from "vitest";
import { parseSyncRequest } from "../src/validation";

function parse(table: string, entityId: string, data: unknown, operation = "create") {
  return parseSyncRequest({ batch_id: "validation", cursor: 0, ack_cursor: 0, limit: 200, operations: [{
    op_id: "operation", table, entity_id: entityId, operation,
    base_sync_version: operation === "create" || operation === "upsert" ? null : 0,
    ...(data === undefined ? {} : { data }),
  }] }).operations[0];
}

describe("domain validation", () => {
  it.each([
    ["archive_entries_v2", "not-a-gid", {}],
    ["archive_entries_v2", "1", { deleted: 1 }],
    ["archive_entries_v2", "1", { length: 1.5 }],
    ["archive_entries_v2", "1", { length: Number.MAX_SAFE_INTEGER + 1 }],
    ["archive_entries_v2", "1", { visible: true }],
    ["archive_entries_v2", "1", { title: "中".repeat(2000) }],
    ["archive_entries_v2", "1", { title: "before\0after" }],
    ["archive_read_state_v2", "1", { first_access_time: "", last_access_time: "now" }],
    ["archive_favorite_state_v2", "1", { favcat: 10 }],
    ["archive_rate_state_v2", "1", { average_rating: Infinity }],
    ["gallery_reader_config_v2", "1", { pageDirection: "diagonal" }],
    ["global_reader_config_v2", "2", {}],
    ["search_history_v2", "a".repeat(8193), {}],
    ["ai_translation_services_v2", "service", { selected: 2 }],
    ["webdav_services_v2", "service", { username: "private-user" }],
    ["webdav_services_v2", "service", { password: "private-secret" }],
    ["webdav_services_v2", "service", { port: 65536 }],
    ["local_marked_tags_v2", "custom:tag", { namespace: "custom", name: "other" }],
    ["local_marked_tags_v2", "custom:tag", { namespace: "custom:extra" }],
    ["local_marked_tags_v2", "custom:tag:extra", {}],
    ["tag_access_count_v2", "q:ns:term", { count: -1 }],
    ["tag_access_count_v2", "q:ns:term", { qualifier: "other" }],
    ["tag_access_count_v2", "q:ns:term", { count: Number.MAX_SAFE_INTEGER + 1 }],
    ["favorite_images_v2", "01:2", { gid: 1, page_index: 2 }],
    ["favorite_images_v2", "1:2", { gid: 1, page_index: 3 }],
    ["favorite_images_v2", "9007199254740992:0", {}],
    ["archive_download_state_v2", "1", {}],
    ["archive_records_v2", "1", {}],
    ["config", "key", {}],
    ["bookmarks", "https://example.com", {}],
  ])("rejects invalid %s / %s data", (table, id, data) => {
    expect(() => parse(table, id, data)).toThrow();
  });

  it("restricts global config and count operations", () => {
    expect(() => parse("global_reader_config_v2", "1", {})).toThrow();
    expect(() => parse("global_reader_config_v2", "1", undefined, "delete")).toThrow();
    expect(() => parse("tag_access_count_v2", "::", {}, "upsert")).toThrow();
    expect(parse("global_reader_config_v2", "1", {}, "upsert")?.data).toEqual({});
    expect(parse("marked_uploaders_v2", "uploader", {})?.data).toEqual({});
  });

  it("allows arbitrary colon-free components and preserves opaque search IDs", () => {
    expect(parse("local_marked_tags_v2", "custom:标签", { namespace: "custom", name: "标签" })?.entity_id).toBe("custom:标签");
    expect(parse("tag_access_count_v2", "device:custom:ns:term", { device_id: "device", qualifier: "custom", namespace: "ns", term: "term", count: 1 })).toBeTruthy();
    expect(parse("search_history_v2", '  a:b "c"  ', { last_access_time: "now" })?.entity_id).toBe('  a:b "c"  ');
  });

  it("canonicalizes embedded JSON without reordering arrays", () => {
    const tags = parse("archive_entries_v2", "1", { taglist_json: '[ { "tags": ["b", "a"], "namespace": "custom" } ]' });
    expect(tags?.data?.taglist_json).toBe('[{"namespace":"custom","tags":["b","a"]}]');
    const search = parse("search_bookmarks_v2", "opaque", {
      search_terms_json: '[{"tilde":1,"term":"second","namespace":null},{"term":"first","dollar":0}]',
    });
    expect(search?.data?.search_terms_json).toBe('[{"namespace":null,"term":"second","tilde":1},{"dollar":0,"term":"first"}]');
  });

  it.each([
    ["taglist_json", "{}"],
    ["taglist_json", '[{"namespace":"n","tags":["a","a"]}]'],
    ["taglist_json", '[{"namespace":"n","tags":[]},{"namespace":"n","tags":[]}]'],
    ["taglist_json", JSON.stringify([{ namespace: "n", tags: Array(257).fill("a") }])],
    ["taglist_json", JSON.stringify(Array.from({ length: 257 }, (_, i) => ({ namespace: String(i), tags: [] })))],
    ["taglist_json", JSON.stringify([{ namespace: "n", tags: ["中".repeat(200)] }])],
    ["search_terms_json", '[{"term":"a","dollar":true}]'],
    ["search_terms_json", '[{"namespace":"n"}]'],
    ["search_terms_json", '[{"term":"a","unexpected":0}]'],
    ["search_terms_json", JSON.stringify(Array(101).fill({ term: "a" }))],
    ["search_terms_json", JSON.stringify(Array(40).fill({ term: "a".repeat(2048) }))],
  ])("rejects malformed or oversized %s attachments", (key, value) => {
    expect(() => parse(key === "taglist_json" ? "archive_entries_v2" : "search_history_v2", "1", { [key]: value })).toThrow();
  });
});
