PRAGMA foreign_keys = ON;

CREATE TABLE profile (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version       INTEGER NOT NULL,
  api_version          INTEGER NOT NULL,
  min_valid_change_seq INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL
);

INSERT INTO profile (id, schema_version, api_version, min_valid_change_seq, created_at)
VALUES (1, 1, 1, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE devices (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  name                 TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  platform             TEXT CHECK (platform IS NULL OR length(platform) <= 100),
  app_version          TEXT CHECK (app_version IS NULL OR length(app_version) <= 100),
  last_seen_at         INTEGER,
  last_ack_change_seq  INTEGER NOT NULL DEFAULT 0 CHECK (last_ack_change_seq >= 0),
  full_sync_session_id TEXT
);

CREATE TABLE sync_tables (
  table_name     TEXT PRIMARY KEY,
  table_order    INTEGER NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE changes (
  change_seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_table        TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  entity_sync_version INTEGER NOT NULL CHECK (entity_sync_version >= 0),
  operation           TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  payload_json        TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  device_id           TEXT,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX idx_changes_cleanup ON changes(updated_at, change_seq);
CREATE INDEX idx_changes_entity ON changes(entity_table, entity_id, change_seq);

CREATE TABLE full_sync_sessions (
  id               TEXT PRIMARY KEY,
  device_id        TEXT NOT NULL,
  start_request_id TEXT NOT NULL,
  baseline_seq     INTEGER NOT NULL CHECK (baseline_seq >= 0),
  target_seq       INTEGER CHECK (target_seq IS NULL OR target_seq >= baseline_seq),
  schema_version   INTEGER NOT NULL,
  phase            TEXT NOT NULL CHECK (phase IN ('downloading', 'catching_up', 'completed', 'expired')),
  expires_at       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  FOREIGN KEY(device_id) REFERENCES devices(id)
);

CREATE UNIQUE INDEX uniq_active_full_sync_device
ON full_sync_sessions(device_id)
WHERE phase IN ('downloading', 'catching_up');

CREATE UNIQUE INDEX uniq_full_sync_start_request
ON full_sync_sessions(device_id, start_request_id);

CREATE INDEX idx_full_sync_expiry
ON full_sync_sessions(phase, expires_at, baseline_seq);

-- Keep a contiguous change_seq suffix. Capacity preflight rejects a writer
-- before this trigger runs if advancing the floor would invalidate its cursor.
CREATE TRIGGER cap_changes_after_insert
AFTER INSERT ON changes
WHEN (SELECT COUNT(*) FROM changes) > 5000
BEGIN
  UPDATE full_sync_sessions SET phase = 'expired'
  WHERE phase IN ('downloading', 'catching_up') AND baseline_seq < COALESCE((
    SELECT MAX(change_seq) FROM changes WHERE change_seq NOT IN (
      SELECT change_seq FROM changes
      ORDER BY updated_at DESC, change_seq DESC LIMIT 5000
    )
  ), 0);

  UPDATE devices SET full_sync_session_id = NULL
  WHERE full_sync_session_id IN (
    SELECT id FROM full_sync_sessions WHERE phase = 'expired'
  );

  UPDATE profile SET min_valid_change_seq = MAX(min_valid_change_seq, COALESCE((
    SELECT MAX(change_seq) FROM changes WHERE change_seq NOT IN (
      SELECT change_seq FROM changes
      ORDER BY updated_at DESC, change_seq DESC LIMIT 5000
    )
  ), 0)) WHERE id = 1;

  DELETE FROM changes WHERE change_seq <= COALESCE((
    SELECT MAX(change_seq) FROM changes WHERE change_seq NOT IN (
      SELECT change_seq FROM changes
      ORDER BY updated_at DESC, change_seq DESC LIMIT 5000
    )
  ), 0);
END;

CREATE TABLE processed_ops (
  device_id         TEXT NOT NULL,
  op_id             TEXT NOT NULL,
  batch_id          TEXT NOT NULL,
  request_hash      TEXT NOT NULL CHECK (length(request_hash) = 64),
  result_status     TEXT NOT NULL,
  result_json       TEXT NOT NULL CHECK (json_valid(result_json)),
  server_updated_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, op_id)
);

CREATE TABLE processed_batches (
  device_id         TEXT NOT NULL,
  batch_id          TEXT NOT NULL,
  request_hash      TEXT NOT NULL CHECK (length(request_hash) = 64),
  result_json       TEXT NOT NULL CHECK (json_valid(result_json)),
  server_updated_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, batch_id)
);

CREATE TABLE tx_assertions (
  value INTEGER NOT NULL CHECK (value = 1)
);

CREATE INDEX idx_processed_ops_cleanup
ON processed_ops(server_updated_at, device_id, batch_id);

CREATE INDEX idx_processed_batches_cleanup
ON processed_batches(server_updated_at, device_id, batch_id);

-- A batch has at most eight operations. When operation capacity is reached,
-- retaining the newest 625 complete batches guarantees both 5000-row caps.
CREATE TRIGGER cap_processed_batches_after_insert
AFTER INSERT ON processed_batches
WHEN (SELECT COUNT(*) FROM processed_batches) > 5000
  OR (SELECT COUNT(*) FROM processed_ops) > 5000
BEGIN
  DELETE FROM processed_batches WHERE rowid NOT IN (
    SELECT rowid FROM processed_batches
    ORDER BY server_updated_at DESC, rowid DESC
    LIMIT CASE WHEN (SELECT COUNT(*) FROM processed_ops) > 5000 THEN 625 ELSE 5000 END
  );

  DELETE FROM processed_ops
  WHERE NOT EXISTS (
    SELECT 1 FROM processed_batches b
    WHERE b.device_id = processed_ops.device_id AND b.batch_id = processed_ops.batch_id
  );
END;

CREATE TABLE rate_limits (
  scope       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  PRIMARY KEY(scope, subject, window_start)
);

CREATE INDEX idx_rate_limits_cleanup ON rate_limits(window_start);

CREATE TABLE bookmarks (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 2048),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  url                  TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 4096),
  title                TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  note                 TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 10000),
  tags_json            TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array')
);

CREATE INDEX idx_bookmarks_updated ON bookmarks(server_updated_at, id);

CREATE TABLE settings (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  value_json           TEXT NOT NULL CHECK (json_valid(value_json))
);

CREATE INDEX idx_settings_updated ON settings(server_updated_at, id);

INSERT INTO sync_tables(table_name, table_order, schema_version)
VALUES ('bookmarks', 1, 1), ('settings', 2, 1);
