-- Replace the development-only example entities. No legacy data mapping exists.
-- Keep bound devices, but discard example cursors, sessions and replay records.
DELETE FROM full_sync_sessions;
UPDATE devices SET full_sync_session_id = NULL, last_ack_change_seq = 0;
DELETE FROM processed_ops;
DELETE FROM processed_batches;
DELETE FROM changes;
DELETE FROM sqlite_sequence WHERE name = 'changes';
DELETE FROM sync_tables;
DROP TABLE bookmarks;
DROP TABLE settings;
UPDATE profile SET schema_version = 2, min_valid_change_seq = 0 WHERE id = 1;

CREATE TABLE archive_entries_v2 (
  id                   TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 32 AND id NOT GLOB '*[^0-9]*'),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  token                TEXT CHECK (token IS NULL OR length(token) <= 4096),
  title                TEXT CHECK (title IS NULL OR length(title) <= 4096),
  english_title        TEXT CHECK (english_title IS NULL OR length(english_title) <= 4096),
  japanese_title       TEXT CHECK (japanese_title IS NULL OR length(japanese_title) <= 4096),
  thumbnail_url        TEXT CHECK (thumbnail_url IS NULL OR length(thumbnail_url) <= 8192),
  category             TEXT CHECK (category IS NULL OR length(category) <= 200),
  posted_time          TEXT CHECK (posted_time IS NULL OR length(posted_time) <= 64),
  visible              INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  length               INTEGER CHECK (length IS NULL OR length >= 0),
  torrent_available    INTEGER NOT NULL DEFAULT 0 CHECK (torrent_available IN (0, 1)),
  uploader             TEXT CHECK (uploader IS NULL OR length(uploader) <= 512),
  disowned             INTEGER NOT NULL DEFAULT 0 CHECK (disowned IN (0, 1)),
  comment              TEXT CHECK (comment IS NULL OR length(comment) <= 32768),
  taglist_json         TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(taglist_json)
      AND json_type(taglist_json) = 'array'
      AND length(taglist_json) <= 65536
    )
);

CREATE INDEX idx_archive_entries_v2_tombstones
ON archive_entries_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE archive_read_state_v2 (
  id                   TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 32 AND id NOT GLOB '*[^0-9]*'),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  first_access_time    TEXT NOT NULL CHECK (length(first_access_time) BETWEEN 1 AND 64),
  last_access_time     TEXT NOT NULL CHECK (length(last_access_time) BETWEEN 1 AND 64),
  readlater            INTEGER NOT NULL DEFAULT 0 CHECK (readlater IN (0, 1)),
  last_read_page       INTEGER NOT NULL DEFAULT 0 CHECK (last_read_page >= 0)
);

CREATE INDEX idx_archive_read_state_v2_tombstones
ON archive_read_state_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE archive_favorite_state_v2 (
  id                   TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 32 AND id NOT GLOB '*[^0-9]*'),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  favorited            INTEGER NOT NULL DEFAULT 0 CHECK (favorited IN (0, 1)),
  favcat               INTEGER CHECK (favcat IS NULL OR favcat BETWEEN 0 AND 9)
);

CREATE INDEX idx_archive_favorite_state_v2_tombstones
ON archive_favorite_state_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE archive_rate_state_v2 (
  id                   TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 32 AND id NOT GLOB '*[^0-9]*'),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  average_rating       REAL NOT NULL DEFAULT 0,
  display_rating       REAL NOT NULL DEFAULT 0,
  is_my_rating         INTEGER NOT NULL DEFAULT 0 CHECK (is_my_rating IN (0, 1))
);

CREATE INDEX idx_archive_rate_state_v2_tombstones
ON archive_rate_state_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE gallery_reader_config_v2 (
  id                         TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 32 AND id NOT GLOB '*[^0-9]*'),
  sync_version               INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted                    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at          INTEGER NOT NULL,
  created_by_device_id       TEXT,
  updated_by_device_id       TEXT,
  pageDirection              TEXT NOT NULL DEFAULT 'left_to_right'
    CHECK (pageDirection IN ('left_to_right', 'right_to_left', 'vertical')),
  spreadModeEnabled          INTEGER NOT NULL DEFAULT 0 CHECK (spreadModeEnabled IN (0, 1)),
  skipFirstPageInSpread      INTEGER NOT NULL DEFAULT 0 CHECK (skipFirstPageInSpread IN (0, 1)),
  skipLandscapePagesInSpread INTEGER NOT NULL DEFAULT 0 CHECK (skipLandscapePagesInSpread IN (0, 1)),
  pagingGesture              TEXT NOT NULL DEFAULT 'tap_and_swipe'
    CHECK (pagingGesture IN ('tap_and_swipe', 'swipe', 'tap'))
);

CREATE INDEX idx_gallery_reader_config_v2_tombstones
ON gallery_reader_config_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE global_reader_config_v2 (
  id                         TEXT PRIMARY KEY CHECK (id = '1'),
  sync_version               INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted                    INTEGER NOT NULL DEFAULT 0 CHECK (deleted = 0),
  server_updated_at          INTEGER NOT NULL,
  created_by_device_id       TEXT,
  updated_by_device_id       TEXT,
  pageDirection              TEXT NOT NULL DEFAULT 'left_to_right'
    CHECK (pageDirection IN ('left_to_right', 'right_to_left', 'vertical')),
  spreadModeEnabled          INTEGER NOT NULL DEFAULT 0 CHECK (spreadModeEnabled IN (0, 1)),
  skipFirstPageInSpread      INTEGER NOT NULL DEFAULT 0 CHECK (skipFirstPageInSpread IN (0, 1)),
  skipLandscapePagesInSpread INTEGER NOT NULL DEFAULT 0 CHECK (skipLandscapePagesInSpread IN (0, 1)),
  pagingGesture              TEXT NOT NULL DEFAULT 'tap_and_swipe'
    CHECK (pagingGesture IN ('tap_and_swipe', 'swipe', 'tap'))
);

CREATE TABLE search_history_v2 (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 8192),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  last_access_time     TEXT NOT NULL CHECK (length(last_access_time) BETWEEN 1 AND 64),
  search_terms_json    TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(search_terms_json)
      AND json_type(search_terms_json) = 'array'
      AND length(search_terms_json) <= 65536
    )
);

CREATE INDEX idx_search_history_v2_tombstones
ON search_history_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE search_bookmarks_v2 (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 8192),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  position_key         TEXT NOT NULL CHECK (length(position_key) BETWEEN 1 AND 2048),
  search_terms_json    TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(search_terms_json)
      AND json_type(search_terms_json) = 'array'
      AND length(search_terms_json) <= 65536
    )
);

CREATE INDEX idx_search_bookmarks_v2_tombstones
ON search_bookmarks_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE ai_translation_services_v2 (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  name                 TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  selected             INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  script_text          TEXT NOT NULL CHECK (length(script_text) <= 65536),
  config_form          TEXT CHECK (config_form IS NULL OR length(config_form) <= 16384),
  config               TEXT CHECK (config IS NULL OR length(config) <= 16384)
);

CREATE UNIQUE INDEX idx_ai_translation_services_v2_single_selected
ON ai_translation_services_v2(selected)
WHERE selected = 1 AND deleted = 0;

CREATE INDEX idx_ai_translation_services_v2_tombstones
ON ai_translation_services_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE webdav_services_v2 (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  name                 TEXT CHECK (name IS NULL OR length(name) <= 200),
  host                 TEXT CHECK (host IS NULL OR length(host) <= 2048),
  port                 INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  https                INTEGER NOT NULL DEFAULT 0 CHECK (https IN (0, 1)),
  path                 TEXT CHECK (path IS NULL OR length(path) <= 4096),
  enabled              INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
);

CREATE UNIQUE INDEX idx_webdav_services_v2_single_enabled
ON webdav_services_v2(enabled)
WHERE enabled = 1 AND deleted = 0;

CREATE INDEX idx_webdav_services_v2_tombstones
ON webdav_services_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE local_marked_tags_v2 (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 1025),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  namespace            TEXT NOT NULL
    CHECK (length(namespace) BETWEEN 1 AND 512 AND instr(namespace, ':') = 0),
  name                 TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 512 AND instr(name, ':') = 0),
  watched              INTEGER CHECK (watched IS NULL OR watched IN (0, 1)),
  hidden               INTEGER CHECK (hidden IS NULL OR hidden IN (0, 1)),
  color                TEXT CHECK (color IS NULL OR length(color) <= 64),
  weight               INTEGER CHECK (
    weight IS NULL OR weight BETWEEN -9007199254740991 AND 9007199254740991
  ),
  CHECK (id = namespace || ':' || name)
);

CREATE INDEX idx_local_marked_tags_v2_tombstones
ON local_marked_tags_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE marked_uploaders_v2 (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT
);

CREATE INDEX idx_marked_uploaders_v2_tombstones
ON marked_uploaders_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE tag_access_count_v2 (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 2 AND 3074),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  namespace            TEXT NOT NULL DEFAULT ''
    CHECK (length(namespace) <= 512 AND instr(namespace, ':') = 0),
  qualifier            TEXT NOT NULL DEFAULT ''
    CHECK (length(qualifier) <= 512 AND instr(qualifier, ':') = 0),
  term                 TEXT NOT NULL DEFAULT ''
    CHECK (length(term) <= 2048 AND instr(term, ':') = 0),
  count                INTEGER NOT NULL DEFAULT 0
    CHECK (count BETWEEN 0 AND 9007199254740991),
  CHECK (id = qualifier || ':' || namespace || ':' || term)
);

CREATE INDEX idx_tag_access_count_v2_tombstones
ON tag_access_count_v2(server_updated_at, id) WHERE deleted = 1;

CREATE TABLE favorite_images_v2 (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 64),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  gid                  INTEGER NOT NULL CHECK (gid BETWEEN 0 AND 9007199254740991),
  page_index           INTEGER NOT NULL CHECK (page_index BETWEEN 0 AND 9007199254740991),
  favorited_at         TEXT NOT NULL CHECK (length(favorited_at) BETWEEN 1 AND 64),
  CHECK (id = CAST(gid AS TEXT) || ':' || CAST(page_index AS TEXT))
);

CREATE INDEX idx_favorite_images_v2_parent
ON favorite_images_v2(gid) WHERE deleted = 0;

CREATE INDEX idx_favorite_images_v2_tombstones
ON favorite_images_v2(server_updated_at, id) WHERE deleted = 1;

INSERT INTO sync_tables(table_name, table_order, schema_version)
VALUES
  ('archive_entries_v2', 1, 1),
  ('archive_read_state_v2', 2, 1),
  ('archive_favorite_state_v2', 3, 1),
  ('archive_rate_state_v2', 4, 1),
  ('gallery_reader_config_v2', 5, 1),
  ('global_reader_config_v2', 6, 1),
  ('search_history_v2', 7, 1),
  ('search_bookmarks_v2', 8, 1),
  ('ai_translation_services_v2', 9, 1),
  ('webdav_services_v2', 10, 1),
  ('local_marked_tags_v2', 11, 1),
  ('marked_uploaders_v2', 12, 1),
  ('tag_access_count_v2', 13, 1),
  ('favorite_images_v2', 14, 1);
