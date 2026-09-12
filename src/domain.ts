import { type EntityTable, type JsonObject } from "./types";

export type FieldRule =
  | { kind: "text"; max: number; min?: number; nullable?: boolean; default?: string; values?: readonly string[] }
  | { kind: "integer"; min: number; max: number; nullable?: boolean; default?: number }
  | { kind: "real"; default: number }
  | { kind: "taglist" | "search_terms"; default: string };

const text = (max: number, nullable = true, min = 0): FieldRule => ({ kind: "text", max, min, nullable });
const integer = (min: number, max = Number.MAX_SAFE_INTEGER, nullable = false, defaultValue?: number): FieldRule =>
  ({ kind: "integer", min, max, nullable, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const flag: FieldRule = integer(0, 1, false, 0);
const readerFields = {
  pageDirection: { kind: "text", max: 20, default: "left_to_right", values: ["left_to_right", "right_to_left", "vertical"] },
  spreadModeEnabled: flag,
  skipFirstPageInSpread: flag,
  skipLandscapePagesInSpread: flag,
  pagingGesture: { kind: "text", max: 20, default: "tap_and_swipe", values: ["tap_and_swipe", "swipe", "tap"] },
} satisfies Record<string, FieldRule>;

// Field names and defaults are code-owned; requests and sync_tables cannot add SQL identifiers.
export const DOMAIN_FIELDS: Record<EntityTable, Readonly<Record<string, FieldRule>>> = {
  archive_entries_v2: {
    token: text(4096), title: text(4096), english_title: text(4096), japanese_title: text(4096),
    thumbnail_url: text(8192), category: text(200), posted_time: text(64),
    visible: integer(0, 1, false, 1), length: integer(0, Number.MAX_SAFE_INTEGER, true),
    torrent_available: flag, uploader: text(512), disowned: flag, comment: text(32768),
    taglist_json: { kind: "taglist", default: "[]" },
  },
  archive_read_state_v2: {
    first_access_time: text(64, false, 1), last_access_time: text(64, false, 1),
    readlater: flag, last_read_page: integer(0, Number.MAX_SAFE_INTEGER, false, 0),
  },
  archive_favorite_state_v2: { favorited: flag, favcat: integer(0, 9, true) },
  archive_rate_state_v2: {
    average_rating: { kind: "real", default: 0 }, display_rating: { kind: "real", default: 0 }, is_my_rating: flag,
  },
  gallery_reader_config_v2: readerFields,
  global_reader_config_v2: readerFields,
  search_history_v2: { last_access_time: text(64, false, 1), search_terms_json: { kind: "search_terms", default: "[]" } },
  search_bookmarks_v2: { position_key: text(2048, false, 1), search_terms_json: { kind: "search_terms", default: "[]" } },
  ai_translation_services_v2: {
    name: text(200, false, 1), selected: flag, script_text: text(65536, false),
    config_form: text(16384), config: text(16384),
  },
  webdav_services_v2: {
    name: text(200), host: text(2048), port: integer(1, 65535, true), https: flag, path: text(4096), enabled: flag,
  },
  local_marked_tags_v2: {
    namespace: text(512, false, 1), name: text(512, false, 1),
    watched: integer(0, 1, true), hidden: integer(0, 1, true), color: text(64),
    weight: integer(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true),
  },
  marked_uploaders_v2: {},
  tag_access_count_v2: {
    namespace: { kind: "text", max: 512, default: "" },
    qualifier: { kind: "text", max: 512, default: "" },
    term: { kind: "text", max: 2048, default: "" },
    count: integer(0, Number.MAX_SAFE_INTEGER, false, 0),
  },
  favorite_images_v2: {
    gid: integer(0), page_index: integer(0), favorited_at: text(64, false, 1),
  },
};

export const REQUIRED_FIELDS: Partial<Record<EntityTable, readonly string[]>> = {
  archive_read_state_v2: ["first_access_time", "last_access_time"],
  search_history_v2: ["last_access_time"],
  search_bookmarks_v2: ["position_key"],
  ai_translation_services_v2: ["name", "script_text"],
  local_marked_tags_v2: ["namespace", "name"],
  tag_access_count_v2: ["qualifier", "namespace", "term"],
  favorite_images_v2: ["gid", "page_index", "favorited_at"],
};

export const ARCHIVE_STATE_TABLES = [
  "archive_read_state_v2", "archive_favorite_state_v2", "archive_rate_state_v2", "gallery_reader_config_v2",
] as const;

export function archiveParentId(table: EntityTable, id: string): string | null {
  if (ARCHIVE_STATE_TABLES.some((name) => name === table)) return id;
  if (table === "favorite_images_v2") return id.split(":")[0] ?? null;
  return null;
}

export function exclusiveField(table: EntityTable): string | null {
  if (table === "ai_translation_services_v2") return "selected";
  if (table === "webdav_services_v2") return "enabled";
  return null;
}

export function hasRequiredFields(table: EntityTable, data: JsonObject | undefined): boolean {
  return data !== undefined && (REQUIRED_FIELDS[table] ?? []).every((field) => Object.hasOwn(data, field));
}
