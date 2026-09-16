CREATE TABLE data (
  tablename TEXT NOT NULL,
  id TEXT NOT NULL,
  content TEXT,
  sync_version INTEGER NOT NULL CHECK(sync_version BETWEEN 1 AND 9007199254740991),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)),
  server_updated_at INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  PRIMARY KEY (tablename, id)
);
CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(seq BETWEEN 1 AND 9007199254740991),
  tablename TEXT NOT NULL,
  id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','delete')),
  device_id TEXT NOT NULL,
  server_updated_at INTEGER NOT NULL
);
CREATE INDEX idx_changes_data ON changes(tablename, id);
CREATE INDEX idx_changes_device ON changes(device_id);
CREATE TABLE devices (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  platform TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0, 1)),
  last_request_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_request_seq BETWEEN 0 AND 9007199254740991),
  last_request_hash TEXT,
  last_request_result TEXT
);
