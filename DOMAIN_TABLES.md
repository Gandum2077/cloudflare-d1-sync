# v1 业务表定义

本文档是 D1 业务实体、字段白名单、业务主键和数据校验规则的唯一来源。通用同步字段及协议见 [PROJECT_SPEC.md](./PROJECT_SPEC.md)。迁移和 `src/service.ts` 中的命名 SQL 必须与本文一致。

本地真实结构来自 [db.sql](./db.sql)，但 D1 不机械复制本地物理表：

- `archive_taglist_v2` 折叠为 `archive_entries_v2.taglist_json`；两张搜索词附属表分别折叠为父实体的 `search_terms_json`。这些附属行没有独立的 `sync_version` 和墓碑，必须随父实体原子同步；客户端应用父实体时，在同一本地事务中整体替换对应附属行。
- `archive_download_state_v2`、`downloaded_marked_tags_v2`、`banned_uploaders`、`favcat_titles`、`config`、`translation_data` 按源文件标注仅保留在本地。
- `ai_translation_services_v2` 的 secure 字段已由业务层排除，现有字段全部参与同步。
- `webdav_services_v2` 只同步 `name`、`host`、`port`、`https`、`path`、`enabled`；`username` 和 `password` 永不进入请求、响应、D1、change payload 或日志。
- `archive_records_v2` 是本地只读投影视图，不是同步实体；它组合阅读记录、阅读状态、收藏、评分、下载状态和按 namespace 聚合的标签，不能注册到 `sync_tables`。
- 云端不复制本地外键。四张图库状态/设置表和图片收藏写入前，阅读记录必须未删除，或在同批次更早创建/复活。删除阅读记录前必须先显式删除未删除的依赖实体，可分批处理；所有删除各自产生墓碑与 `changes`，不做物理级联。

所有字符串同时受各节标注的字符数及同数值的 UTF-8 字节数上限约束，并禁止 NUL。所有 JSON 附属字段都使用无额外空白、对象键递归排序的规范 JSON。Worker 必须同时限制 UTF-8 字节数、数组项数和每个字符串长度；SQL 中的 `length()` 只是第二道防线。除各节另有说明外，create、update、upsert 和 delete 均可用，update 采用 OCC，upsert 明确采用后提交者覆盖。

## 1. `archive_entries_v2`

阅读记录。`id` 是十进制 `gid` 字符串；`taglist_json` 对应本地 `archive_taglist_v2` 和 `archive_records_v2` 视图，保存按 namespace 聚合的 `{ "namespace": string, "tags": string[] }`，最多 256 个 namespace 分组，每组最多 256 个标签、总计最多 4096 个标签；namespace 最长 512 字节，标签为 1–512 字节，禁止重复 namespace 或组内重复标签。客户端可写全部业务字段；创建时没有额外必填字段。

```sql
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
```

## 2. `archive_read_state_v2`

阅读进度，`id` 与 `archive_entries_v2.id` 相同。客户端可写 `first_access_time`、`last_access_time`、`readlater`、`last_read_page`；创建必须提供两个时间字段。

```sql
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
```

## 3. `archive_favorite_state_v2`

收藏状态，`id` 与 `archive_entries_v2.id` 相同。客户端可写 `favorited`、`favcat`；`favcat` 沿用本地 0–9 分类。

```sql
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
```

## 4. `archive_rate_state_v2`

评分状态，`id` 与 `archive_entries_v2.id` 相同。客户端可写 `average_rating`、`display_rating`、`is_my_rating`；Worker 只接受有限 JSON 数值。

```sql
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
```

## 5. `gallery_reader_config_v2`

单个图库的阅读设置，`id` 与 `archive_entries_v2.id` 相同。客户端可写五个设置字段；创建时均可使用默认值。

```sql
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
```

## 6. `global_reader_config_v2`

全局阅读设置，固定 `id = '1'`，只能有一行。客户端可写五个设置字段，只允许 upsert/update，不允许 delete。

```sql
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
```

## 7. `search_history_v2`

搜索历史。`id` 是客户端现有的 `sorted_fsearch`，作为不透明、不可变字符串传输；服务端不重新规范化，允许空字符串但不允许 NULL。分页起点用 null 表示，不能把空 ID 当作起点或结束标记。`search_terms_json` 对应本地 `search_history_search_terms_v2`，数组下标就是 `term_index`，最多 100 项。每项只允许 `namespace`、`qualifier`、`term`、`dollar`、`subtract`、`tilde`，其中 `term` 必填且最长 2048 字节；`namespace`、`qualifier` 可省略或为 null，非 null 时最长 512 字节；三个标志可省略（本地按 0 处理），显式提供时只能为 0/1。客户端可写 `last_access_time`、`search_terms_json`；创建必须提供 `last_access_time`。

```sql
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
```

## 8. `search_bookmarks_v2`

搜索书签。`id` 和 `search_terms_json` 的规则与 `search_history_v2` 相同。客户端可写 `position_key`、`search_terms_json`；创建必须提供 `position_key`。

```sql
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
```

## 9. `ai_translation_services_v2`

AI 翻译服务。业务层已在写入本地表前排除 secure 字段，因此现有 `script_text`、`config_form`、`config` 均为允许跨设备同步的非机密配置。`id` 是创建后不可变的内容 hash 或 UUID，服务端将其作为不透明字符串。客户端可写全部业务字段；创建必须提供 `name` 和 `script_text`。同一时刻最多一条未删除记录可有 `selected = 1`；切换选择时，同批次必须先取消旧记录再选择新记录。

```sql
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
```

## 10. `webdav_services_v2`

WebDAV 服务的安全投影。`id` 是创建后不可变的内容 hash 或 UUID，服务端将其作为不透明字符串。客户端可写 `name`、`host`、`port`、`https`、`path`、`enabled`，创建时没有额外必填字段；`username` 和 `password` 不属于云端表字段，也不在字段白名单中。同一时刻最多一条未删除记录可有 `enabled = 1`。

客户端应用云端记录时只合并上述安全字段，不得清空或覆盖本机 `assets/credentials.json` 中的 `username`、`password`。新设备未配置本地凭据时，即使同步得到 `enabled = 1`，运行时也必须保持停用并提示用户补充凭据。

```sql
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
```

## 11. `local_marked_tags_v2`

本地产生的标记标签。`namespace` 和 `name` 都禁止包含冒号，服务端不限制具体选项；`id` 固定为 `<namespace>:<name>`，Worker 必须重算并校验。客户端可写除公共字段外的全部字段，创建必须提供 `namespace` 和 `name`。

```sql
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
```

## 12. `marked_uploaders_v2`

本地产生的标记上传者。上传者字符串直接作为 `id`，没有其他业务字段；创建可提交空 `data`。

```sql
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
```

## 13. `tag_access_count_v2`

每台设备各自累计同一搜索词的访问次数，云端保存分量，客户端按 `qualifier`、`namespace`、`term` 求和展示。`id` 为 `<device_id>:<qualifier>:<namespace>:<term>`；四个组成部分禁止包含冒号，`device_id` 必须等于请求的 `X-Device-ID`。设备只能写自己的分量，所有设备均可下载其他设备的分量。

create、update、upsert 均须提供 `device_id`、`qualifier`、`namespace`、`term`、`count`，其中 update 仍检查 `base_sync_version`；建议用 upsert 上传本机累计值。更新在 SQL 中取 `MAX(云端现值, 提交值)`，重复或乱序上传不重复累加、不减少已有次数。`sync_version` 仍由服务端维护。禁止 delete、清零或改写其他设备的分量；设备解绑保留历史贡献。

本机使用持久设备标识，只递增自己的行，只上传自己的累计值，不能上传汇总值。下载合并也取较大值，自己的云端回声不能覆盖尚未上传的访问次数。完整同步替换其他设备缓存时保留本机分量；设备标识不参与业务同步，也不能复制到另一设备使用。

```sql
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
```

## 14. `favorite_images_v2`

图片收藏。`gid` 和 `page_index` 都是非负安全整数，`id` 固定为无前导零的 `<gid>:<page_index>`，Worker 必须重算并校验。源库的 `gid` 外键指向阅读记录；云端不复制物理外键，但 Worker 必须校验对应的 `archive_entries_v2` 实体存在或在同批次更早创建。客户端可写 `gid`、`page_index`、`favorited_at`，创建必须提供三者。

```sql
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

-- Parent deletion checks use this partial index without scanning all favorites.
CREATE INDEX idx_favorite_images_v2_parent
ON favorite_images_v2(gid) WHERE deleted = 0;

CREATE INDEX idx_favorite_images_v2_tombstones
ON favorite_images_v2(server_updated_at, id) WHERE deleted = 1;
```

# 业务表注册

`0002_domain_tables.sql` 创建业务表；`0003_device_counters.sql` 升到结构版本 3，保留其他业务数据和设备，清空无设备归属的试验计数、变更历史和幂等记录，客户端重新完整同步。计数及两张搜索表的表版本为 2，其余表版本仍为 1。全局高水位保留，不重置 `sqlite_sequence`。共注册 14 张同步实体表。顺序保证阅读记录先于其状态表；`sync_tables` 仍只用于发现和分页排序，不能作为动态 SQL 注入来源。

```sql
INSERT INTO sync_tables(table_name, table_order, schema_version)
VALUES
  ('archive_entries_v2', 1, 1),
  ('archive_read_state_v2', 2, 1),
  ('archive_favorite_state_v2', 3, 1),
  ('archive_rate_state_v2', 4, 1),
  ('gallery_reader_config_v2', 5, 1),
  ('global_reader_config_v2', 6, 1),
  ('search_history_v2', 7, 2),
  ('search_bookmarks_v2', 8, 2),
  ('ai_translation_services_v2', 9, 1),
  ('webdav_services_v2', 10, 1),
  ('local_marked_tags_v2', 11, 1),
  ('marked_uploaders_v2', 12, 1),
  ('tag_access_count_v2', 13, 2),
  ('favorite_images_v2', 14, 1);
```
