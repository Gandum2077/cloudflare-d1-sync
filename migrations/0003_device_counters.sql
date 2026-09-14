-- Schema 3: preserve business entities and bindings; discard experimental shared counters.
-- No client has uploaded production data. Each device will upload its own preserved local count.
UPDATE profile SET schema_version = 3, min_valid_change_seq = MAX(min_valid_change_seq,
  COALESCE((SELECT MAX(change_seq) FROM changes), 0)) WHERE id = 1;
DELETE FROM full_sync_sessions;
UPDATE devices SET full_sync_session_id = NULL, last_ack_change_seq = 0;
DELETE FROM processed_ops;
DELETE FROM processed_batches;
DELETE FROM changes;
-- Keep sqlite_sequence: a history cleanup must never rewind the global watermark.

ALTER TABLE search_history_v2 RENAME TO search_history_v2_previous;
DROP INDEX idx_search_history_v2_tombstones;
CREATE TABLE search_history_v2 (
  id                   TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 0 AND 8192),
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
INSERT INTO search_history_v2 SELECT * FROM search_history_v2_previous;
DROP TABLE search_history_v2_previous;

ALTER TABLE search_bookmarks_v2 RENAME TO search_bookmarks_v2_previous;
DROP INDEX idx_search_bookmarks_v2_tombstones;
CREATE TABLE search_bookmarks_v2 (
  id                   TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 0 AND 8192),
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
INSERT INTO search_bookmarks_v2 SELECT * FROM search_bookmarks_v2_previous;
DROP TABLE search_bookmarks_v2_previous;

DROP TABLE tag_access_count_v2;
CREATE TABLE tag_access_count_v2 (
  id                   TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 4 AND 3275),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted = 0),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  device_id            TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 200 AND instr(device_id, ':') = 0),
  namespace            TEXT NOT NULL DEFAULT ''
    CHECK (length(namespace) <= 512 AND instr(namespace, ':') = 0),
  qualifier            TEXT NOT NULL DEFAULT ''
    CHECK (length(qualifier) <= 512 AND instr(qualifier, ':') = 0),
  term                 TEXT NOT NULL DEFAULT ''
    CHECK (length(term) <= 2048 AND instr(term, ':') = 0),
  count                INTEGER NOT NULL DEFAULT 0
    CHECK (count BETWEEN 0 AND 9007199254740991),
  CHECK (id = device_id || ':' || qualifier || ':' || namespace || ':' || term)
);


UPDATE sync_tables SET schema_version = 2 WHERE table_name IN ('search_history_v2','search_bookmarks_v2','tag_access_count_v2');
