# v1 业务表定义

本文档是具体业务表、字段白名单、业务主键和数据校验规则的唯一来源。通用同步字段及协议见 [PROJECT_SPEC.md](./PROJECT_SPEC.md)。迁移和 `src/service.ts` 中的命名 SQL 必须与本文一致。

## 1. `bookmarks`

书签使用规范化 URL 作为业务主键，推荐使用 upsert。

```sql
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
```

客户端可写字段：`url`、`title`、`note`、`tags_json`。create 和 upsert 创建分支必须提供全部四个字段；update 是 PATCH；upsert 更新分支中缺失字段保持原值。`id` 必须等于规范化后的 `url`。

URL 规范化 v1：只接受绝对 HTTP(S) URL；scheme 和 host 小写；移除 fragment 和默认端口；空 path 变为 `/`；其余 path、query 顺序和转义保持不变。规则变化必须提升 API 主版本。

## 2. `settings`

设置项使用稳定的设置键作为业务主键，推荐使用 upsert。

```sql
CREATE TABLE settings (
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  sync_version         INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  deleted              INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_updated_at    INTEGER NOT NULL,
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  value_json           TEXT NOT NULL CHECK (json_valid(value_json))
);
```

客户端可写字段只有 `value_json`。create 和 upsert 创建分支必须提供该字段；update 是 PATCH；upsert 更新分支缺失该字段时保持原值。

## 3. 注册

初始迁移在创建业务表和 `sync_tables` 后执行：

```sql
INSERT INTO sync_tables(table_name, table_order, schema_version)
VALUES ('bookmarks', 1, 1), ('settings', 2, 1);
```

Worker 代码必须为这两张表提供静态命名 SQL 和字段白名单。`sync_tables` 只负责发现和排序，不能作为动态 SQL 注入来源。
