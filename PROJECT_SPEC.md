# Cloudflare D1 云同步项目规划

> 状态：设计基线（v1）  
> 目标：提供一个可一键部署、仅需一个主密钥、支持多设备离线同步的 Cloudflare Worker + D1 方案，并配套 GitHub Pages 使用引导页。

## 1. 项目目标

本项目用于在多个客户端之间同步结构化数据。每台设备保留自己的本地数据库；Cloudflare Worker 负责鉴权、校验、冲突检测和同步协议；Cloudflare D1 保存云端当前状态与变更流水。

项目交付物包含两部分：

1. **Cloudflare Worker**：完整、可直接部署，自动创建并绑定 D1，提供版本化 HTTP API。
2. **GitHub Pages**：通过 GitHub Actions 自动部署，用于介绍项目、指导部署、在浏览器本地生成主密钥，并提供“Deploy to Cloudflare”入口。

## 2. 核心设计结论

### 2.1 唯一需要用户保管的凭据

系统有且仅有一个由用户管理的根凭据：`MASTER_KEY`。它是所有设备共享的 Bearer Token，适用于单用户、自托管实例。

- `MASTER_KEY` 必须使用 `crypto.getRandomValues()` 生成 32 个随机字节（256 bit 熵），并编码为 64 字符小写十六进制字符串。不得使用用户自选密码或普通随机字符串。
- 生产环境中，`MASTER_KEY` 必须配置为 Cloudflare Worker Secret，不得保存到 Wrangler 明文变量、源码、D1 或日志中。`.dev.vars` 只用于本地开发，必须被 Git 忽略；仓库只提供不含真实值的 `.dev.vars.example`。
- 客户端通过 `Authorization: Bearer <MASTER_KEY>` 调用 API，并应将密钥保存到操作系统安全凭据存储，例如 iOS Keychain、Android Keystore 或 macOS Keychain；不得写入普通业务数据库、日志、URL、错误报告或明文偏好设置。
- Worker 比较密钥时，必须先将收到的值和 Secret 分别计算为固定长度的 SHA-256 摘要，再使用 `crypto.subtle.timingSafeEqual()` 比较；不得直接使用普通字符串比较。
- 修改 Worker Secret 表示全局轮换密钥：旧密钥立即失效，所有设备都必须重新配置。Cloudflare 控制面板不能恢复或显示已保存 Secret 的原值，只能替换它。
- 设备绑定 ID 禁止包含冒号，以便作为计数分量 ID 的前缀。
- `X-Device-ID` 只是设备标识，不是第二重鉴权。任意设备泄露主密钥都会导致整个实例失守，解绑设备也不能撤销该设备已持有的主密钥；这是 v1 为保持部署和使用简单而接受的安全边界。

### 2.2 两类版本号，不依赖设备时间

- `sync_version`：单个实体的版本号，用于乐观并发控制。
- `change_seq`：整个数据库的全局变更流水号，用于增量拉取。

### 2.3 同步规则

1. 普通 update/delete 提交 `base_sync_version`；服务端只在它等于当前版本时接受。
2. create 提交 `base_sync_version: null`；只有云端从未存在该 ID 时才能创建。
3. upsert 提交 `base_sync_version: null`：不存在时创建，存在时无条件更新，不检查当前版本；设备计数取 MAX，详见 DOMAIN_TABLES.md 第 13 节。
4. 每次成功更新、删除或 upsert 都由服务端增加 `sync_version`。
5. 除 DOMAIN_TABLES.md 规定的设备计数 MAX 合并外，下文 upsert 的通用覆盖规则适用于其他实体。普通操作版本不一致时返回 `409 CONFLICT` 和当前实体，不做静默覆盖；upsert 明确采用 D1 事务提交顺序的后提交者覆盖。

因此，数据表中的字段仍叫 `sync_version`，但上传参数必须叫 `base_sync_version`，避免混淆。

## 3. 同步不变量

任何实现都必须保持以下不变量：

1. 所有可同步表都包含 `id`、`sync_version`、`deleted`。
2. `id` 创建后不可改变。它可以是 UUID，也可以是所有客户端采用相同规范化规则生成的业务唯一键；相同业务键表示同一实体。
3. `sync_version` 只由 Worker 生成，初始为 `0`，每次成功修改或删除加 `1`。
4. 删除使用墓碑：设置 `deleted = 1`，不能立即物理删除。
5. 每次实体变化必须在同一批数据库操作中追加一条 `changes` 记录。
6. 客户端时间不参与冲突判断。
7. 每个上传操作带设备生命周期内唯一的 `op_id`；服务端必须幂等，重复请求不能重复执行。
8. 超出变更历史保留窗口的设备必须先完成完整同步；在此之前不接受任何上传 operation，包括 upsert。
9. 同一次 `/sync` 响应返回的 `next_cursor` 必须代表该响应快照的结束位置；客户端只有在事务性写入本地数据后才能保存该游标。
10. 处于完整同步会话的设备不能调用普通 `/sync`；其他设备仍可正常读写。
11. 存在有效完整同步会话时，每次实体变化都必须在 change 中保存该版本的完整实体或墓碑。
12. 完整同步只在暂存区追平到固定截止游标后整体切换，不能逐表替换正式数据。

## 4. 推荐仓库结构

```text
.
├── README.md
├── DOMAIN_TABLES.md             # 具体业务表、字段白名单和业务键规则
├── package.json
├── wrangler.jsonc
├── .dev.vars.example
├── src/
│   ├── index.ts                 # fetch 入口、中间件、统一错误处理
│   ├── service.ts               # API 路由定义及其应用 SQL（人工审查入口）
│   ├── auth.ts                  # 主密钥验证、CORS、安全响应头
│   ├── sync.ts                  # 同步编排、冲突结果、分页游标
│   ├── cleanup.ts               # Cron Trigger 历史与容量清理
│   ├── validation.ts            # 请求体校验与大小限制
│   └── types.ts                 # Env、DTO、错误码
├── migrations/
│   ├── 0001_initial.sql
│   └── 0002_*.sql
├── test/
│   ├── auth.test.ts
│   ├── sync.test.ts
│   └── migration.test.ts
├── docs/
│   ├── index.html               # GitHub Pages 单页入口
│   ├── app.js                   # 本地生成密钥、复制、引导
│   └── style.css
└── .github/workflows/
    ├── pages.yml
    └── test.yml
```

### 4.1 `service.ts` 的职责

为满足“API 和应用 SQL 集中、便于审查”的要求，`src/service.ts` 是人工审查的主要入口。它应按资源分区，每个路由将以下内容放在一起：

- HTTP 方法与路径；
- 请求/响应类型；
- 权限要求；
- 该操作使用的命名 SQL 常量；
- 简短处理函数。

迁移 SQL 不应塞进该文件。数据库结构演进必须保留在 `migrations/*.sql`，否则无法可靠追踪已经应用过的 schema 版本。`service.ts` 只集中日常查询和写入 SQL。

推荐格式：

```ts
// ── Devices ──────────────────────────────────────────────
const SQL_DEVICE_GET = `SELECT ... WHERE id = ?`;
const SQL_DEVICE_BIND = `INSERT INTO devices (...) VALUES (...)`;

export const routes = {
  "POST /v1/devices/bind": bindDevice,
  "GET /v1/devices": listDevices,
} as const;
```

禁止在各个 handler 中散落无名 SQL 字符串。复杂 SQL 上方应说明不变量，而不是逐行翻译 SQL。

## 5. 数据模型

### 5.1 所有业务表的公共字段

```sql
id                TEXT PRIMARY KEY,
sync_version      INTEGER NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
deleted           INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
server_updated_at INTEGER NOT NULL,
created_by_device_id TEXT,
updated_by_device_id TEXT
```

业务数据可以新增任意列，但不能改变公共字段的语义。具体业务表、字段白名单、业务主键与校验规则只定义在 [DOMAIN_TABLES.md](./DOMAIN_TABLES.md)，本文不重复定义。

### 5.2 `devices`：已绑定设备

```sql
CREATE TABLE devices (
  id                    TEXT PRIMARY KEY,
  deleted               INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  name                  TEXT NOT NULL,
  platform              TEXT,
  app_version           TEXT,
  last_seen_at          INTEGER,
  last_ack_change_seq   INTEGER NOT NULL DEFAULT 0,
  full_sync_session_id  TEXT
);
```

说明：

- `id` 由设备第一次绑定时生成并永久保存。
- `deleted = 1` 表示已解绑；设备表不进入业务 change 流水。
- `last_ack_change_seq` 只用于维护和清理评估，不能单独证明客户端状态正确。
- `full_sync_session_id` 指向当前会话；`full_sync_sessions` 是状态权威来源。中间件发现指针对应会话已过期时，先原子标记过期并清空指针；只有有效会话会阻止普通 `/v1/sync`。
- 此表的更新不写入 `changes`。

### 5.3 `profile`：数据库级元信息

`profile` 不是用户公开资料，而是此独立部署实例的元信息。固定只有一行。

```sql
CREATE TABLE profile (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version          INTEGER NOT NULL,
  api_version             INTEGER NOT NULL,
  min_valid_change_seq    INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL
);
```

初始迁移固定插入 `id = 1`，所有读写都带 `WHERE id = 1`，由主键和 CHECK 保证单例。

其中：

- `schema_version`：D1 数据结构版本；由迁移维护。
- `api_version`：Worker 当前协议主版本。
- `min_valid_change_seq`：仍允许增量同步的最早游标。当前高水位取此值与现存最大 `change_seq` 的较大者，清空历史后也不能回退到 0。

### 5.4 `changes`：只追加的变更流水

```sql
CREATE TABLE changes (
  change_seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_table        TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  entity_sync_version INTEGER NOT NULL,
  operation           TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  payload_json        TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  device_id           TEXT,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX idx_changes_cleanup ON changes(updated_at, change_seq);
```

通常只记录实体引用。存在有效完整同步会话时，`payload_json` 必须保存该次变更后的完整实体或墓碑，供该会话重建固定游标状态。

`changes.operation` 记录实际结果；upsert 根据实际分支写为 `create` 或 `update`，不写 `upsert`。

业务写入、change 插入和 payload 判断必须在同一个 D1 原子 `batch()` 中完成。只要存在 `phase IN ('downloading', 'catching_up')` 且 `expires_at > server_now` 的会话，本次 change 就保存 payload；允许为已经 seal 的会话多保存少量 payload。会话建立与业务写入必须依靠数据库事务顺序消除竞态，不能先在 Worker 中查询后再决定 payload。

### 5.5 `sync_tables`：业务表注册

```sql
CREATE TABLE sync_tables (
  table_name     TEXT PRIMARY KEY,
  table_order    INTEGER NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);
```

迁移负责维护此表。Worker 只能使用与代码中命名 SQL 白名单同时匹配的表，不能把查询结果直接拼入 SQL。

### 5.6 `full_sync_sessions`：完整同步会话

```sql
CREATE TABLE full_sync_sessions (
  id             TEXT PRIMARY KEY,
  device_id      TEXT NOT NULL,
  start_request_id TEXT NOT NULL,
  baseline_seq   INTEGER NOT NULL,
  target_seq     INTEGER,
  schema_version INTEGER NOT NULL,
  phase          TEXT NOT NULL CHECK (phase IN ('downloading', 'catching_up', 'completed', 'expired')),
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER,
  FOREIGN KEY(device_id) REFERENCES devices(id)
);

CREATE UNIQUE INDEX uniq_active_full_sync_device
ON full_sync_sessions(device_id)
WHERE phase IN ('downloading', 'catching_up');

CREATE UNIQUE INDEX uniq_full_sync_start_request
ON full_sync_sessions(device_id, start_request_id);
```

同一设备只能有一个有效会话。会话使用可续期的短期租约并限制最长总时长；过期后标记为 `expired` 并清除 `devices.full_sync_session_id`。已完成记录短期保留，使 `complete` 可幂等重试。

### 5.7 processed_ops：请求幂等

```sql
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
```

`op_id` 推荐使用 UUIDv4 或 UUIDv7，服务端以 `(device_id, op_id)` 作为幂等键。

`request_hash` 是单个 operation 的规范化表示的 SHA-256 十六进制值。规范化内容包含 API 版本、`device_id`、`op_id`、表、实体 ID、操作、`base_sync_version` 和规范化 `data`；对象键递归排序，区分字段缺失与 `null`。不得包含 `/sync` 的 `cursor`、`limit` 或其他 operations。

客户端为每批 operations 生成设备生命周期内唯一的 `batch_id`。批次 hash 只包含 API 版本和有序 operations，不包含同步游标或分页参数。相同 batch ID 和 hash 返回已缓存的 operation results；相同 batch ID 但不同 hash 返回 `BATCH_ID_REUSED`。

只有整体成功的批次写入 `processed_ops` 和 `processed_batches`。任何 operation 失败时，全批回滚且不缓存失败；客户端修正冲突后应生成新的 `batch_id`，未改变的 operation 可保留原 `op_id`。

幂等重放以 `batch_id` 为单位。某个已成功的 `op_id` 只能属于原批次；它出现在其他批次时，无论内容是否相同，都以 `OP_ID_REUSED` 拒绝整个新批次。

前置查询只能作为快速路径。整批实体写入、changes、`processed_ops` 和 `processed_batches` 必须位于同一个 D1 `batch()`。普通 update/delete 使用带版本条件的 DML，随后执行 `INSERT INTO tx_assertions(value) VALUES (changes())`；影响行数不是 1 时触发 CHECK 失败并回滚全批。批次末尾清空断言表。create/唯一键约束失败也直接回滚；upsert 使用单条 SQLite UPSERT 并由服务端递增版本。change 插入后的语句使用 `last_insert_rowid()` 生成成功结果中的 `change_seq`。

任何事务失败后都先查询 `processed_batches`，因为并发的相同批次可能先改变实体，导致本请求在到达批次唯一约束前就触发 OCC 或业务约束。若已有批次，hash 相同返回缓存结果，hash 不同返回 `BATCH_ID_REUSED`；确实不存在时才诊断并返回业务错误。实现前必须分别在本地 Miniflare D1 和远端测试 D1 验证 `changes()`、`last_insert_rowid()`、约束回滚及并发重试行为。

### 5.8 实现前 D1 实验

> 状态：已于 2026-08-18 在本地 Miniflare D1 与远端测试 D1 验证通过。

先编写最小实验 migration 和测试 Worker，仅验证：`changes()` 断言、`last_insert_rowid()`、CHECK/UNIQUE 导致的整批回滚、相同 batch 并发、最多 8 个 operations 的语句数与远端 D1 行为。实验通过后才能把该 SQL 模式用于正式业务表；若任一行为与预期不符，必须先修改事务设计和本文档。

验证结果：跨语句 `changes()` 断言和 `last_insert_rowid()` 均符合预期；CHECK/UNIQUE 失败会回滚整批；相同 batch 并发得到一次 applied 和一次 replayed，且只产生一份实体、change 和批次记录；8 个 operations 的 34 条语句可在同一 batch 中原子提交。

## 6. HTTP API

所有接口位于 `/v1`，响应均为 JSON。除 `/v1/health` 外均要求 `Authorization: Bearer` 和 `X-API-Version: 1`。除 `/v1/auth/verify`、`/v1/devices/bind` 外，还必须要求 `X-Device-ID` 对应一台未解绑设备。

统一成功结构：

```json
{ "ok": true, "data": {} }
```

统一错误结构：

```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "base_sync_version does not match current entity",
    "details": {}
  }
}
```

### 6.1 系统与鉴权

| 方法  | 路径              | 作用                                                   | 鉴权                |
| ----- | ----------------- | ------------------------------------------------------ | ------------------- |
| `GET` | `/v1/health`      | 存活检查，只返回服务/API 版本                          | 无                  |
| `GET` | `/v1/auth/verify` | 验证主密钥和 API 版本                                  | 主密钥              |
| `GET` | `/v1/info`        | 返回 schema/API 版本、当前游标、最早有效游标、业务表和能力列表 | 主密钥 + 已绑定设备 |

`GET /v1/health` 返回：

```json
{ "ok": true, "data": { "service": "cloudflare-d1-sync", "api_version": 1 } }
```

`GET /v1/auth/verify` 返回：

```json
{ "ok": true, "data": { "authenticated": true, "api_version": 1 } }
```

`GET /v1/info` 返回：

```json
{
  "ok": true,
  "data": {
    "schema_version": 3,
    "api_version": 1,
    "current_change_seq": 1288,
    "min_valid_change_seq": 0,
    "sync_tables": ["..."],
    "capabilities": ["batch_atomic", "full_sync", "upsert", "device_counters"]
  }
}
```

### 6.2 设备管理

| 方法     | 路径               | 作用                     |
| -------- | ------------------ | ------------------------ |
| `POST`   | `/v1/devices/bind` | 绑定新设备或恢复绑定     |
| `GET`    | `/v1/devices`      | 列出已绑定设备           |
| `PATCH`  | `/v1/devices/:id`  | 修改设备显示名称等元数据 |
| `DELETE` | `/v1/devices/:id`  | 解绑设备                 |

绑定请求示例：

```json
{
  "device_id": "0198...",
  "name": "My iPhone",
  "platform": "ios",
  "app_version": "1.0.0"
}
```

绑定成功返回：

```json
{
  "ok": true,
  "data": {
    "device": {
      "id": "0198...",
      "deleted": 0,
      "name": "My iPhone",
      "platform": "ios",
      "app_version": "1.0.0",
      "last_seen_at": 1786500000000,
      "last_ack_change_seq": 0,
      "full_sync_session_id": null
    }
  }
}
```

相同未解绑 ID 再次绑定时更新元数据并返回当前设备；已解绑 ID 重新绑定时设置 `deleted = 0`。请求体字段限制：`device_id` 1–200、`name` 1–200、`platform` 0–100、`app_version` 0–100 个字符。

`GET /v1/devices` 返回 `{ "ok": true, "data": { "devices": [{ ...device }] } }`，默认包含已解绑设备并明确返回 `deleted`。

`PATCH /v1/devices/:id` 请求为以下字段的任意非空子集：

```json
{ "name": "New name", "platform": "ios", "app_version": "1.1.0" }
```

不得修改 `id`、`deleted`、确认游标或完整同步状态。成功返回 `{ "ok": true, "data": { "device": { ...device } } }`；目标不存在返回 404，已解绑返回 409。

`DELETE /v1/devices/:id` 幂等解绑目标设备；若目标存在完整同步会话，须在同一 batch 中标记会话 `expired` 并清除引用。成功及重复删除均返回 `{ "ok": true, "data": { "device": { ...device, "deleted": 1 } } }`，不新增 change。

- 服务端需要对设备名称、平台和版本字符串限制长度。过长的字符串报错。
- 解绑最后一台设备是允许的，因为主密钥仍可绑定新设备。

### 6.3 核心同步接口

`POST /v1/sync` 在一次请求中完成：上传本地操作、返回逐项结果、拉取云端变更。

设备存在有效完整同步会话时，本接口返回 `409 FULL_SYNC_IN_PROGRESS`。

请求：

```json
{
  "batch_id": "0198-batch-1",
  "cursor": 1280,
  "ack_cursor": 1280,
  "limit": 1,
  "operations": [
    {
      "op_id": "0198-op-1",
      "table": "<registered-table>",
      "entity_id": "business-key-1",
      "operation": "update",
      "base_sync_version": 3,
      "data": {
        "field_a": "new value"
      }
    }
  ]
}
```

`batch_id` 在 `operations` 非空时必填；纯拉取请求使用空 `operations` 并省略 `batch_id`，不写入幂等表。

响应：

```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "op_id": "0198-op-1",
        "status": "applied",
        "entity_id": "business-key-1",
        "sync_version": 4,
        "change_seq": 1288
      }
    ],
    "changes": [
      {
        "change_seq": 1281,
        "table": "<registered-table>",
        "operation": "update",
        "payload": {
          "id": "business-key-1",
          "sync_version": 2,
          "deleted": 0,
          "field_a": "value",
          "server_updated_at": 1786500000000
        }
      }
    ],
    "next_cursor": 1281,
    "acknowledged_cursor": 1280,
    "has_more": true,
    "server_time": 1786500000000
  }
}
```

处理顺序必须固定：

1. 验证主密钥、设备状态、`X-API-Version: 1`、请求大小和全部字段；v1 每批最多 8 个 operations，每页最多 200 条 changes。同一批次内 `(table, entity_id)` 必须唯一，重复时返回 `400 DUPLICATE_ENTITY_IN_BATCH`。
2. `ack_cursor` 必须满足 `0 <= ack_cursor <= cursor <= current_change_seq`。服务端以 `MAX(last_ack_change_seq, ack_cursor)` 单调推进设备确认游标；它确认的是客户端此前已提交的状态，不是本响应即将返回的 changes。该维护更新不属于 operations 的业务事务。
3. 若 `cursor < min_valid_change_seq`，或为本批腾出容量将使最早有效游标超过 cursor，则不执行任何 operation（包括 create/upsert），返回 `410 TABLE_RELOAD_REQUIRED`。
4. 计算批次及各 operation hash。若批次已成功处理，返回缓存的 operation results，并按本次 cursor 重新拉取 changes。
5. 在写入前读取并验证所有实体、版本和业务约束。任意 operation 不合法、冲突、不存在或复用 ID 时，整个请求返回相应 HTTP 4xx；不执行任何 operation，也不返回 changes。
6. 全部预检通过后，用一个 D1 `batch()` 按数组顺序提交所有实体写入、changes、`processed_ops` 和 `processed_batches`。事务内条件和约束必须再次验证预检条件，防止并发竞态。
7. 任意语句失败则全批回滚。业务失败返回 HTTP 409 和 `error.details.operation_errors[]`；数据库临时故障返回 503。失败批次不写幂等记录。
8. 全批成功后取得 `response_high_watermark`，返回 `(cursor, response_high_watermark]` 内最多 `limit` 条变化。若 change 没有 payload，可读取业务表当前实体。`next_cursor` 是最后一条已返回 change 的序号；范围内没有 change 时等于上界。只有到达上界，`has_more` 才为 `false`。

批量语义是全有或全无，不允许部分成功。客户端必须原样重试超时的 `batch_id`、operations 和 `op_id`；收到确定的业务错误后可修正 pending operations，并使用新的 `batch_id` 再提交。

纯拉取请求示例：

```json
{ "cursor": 1281, "ack_cursor": 1281, "limit": 200, "operations": [] }
```

整批业务错误示例：

```json
{
  "ok": false,
  "error": {
    "code": "BATCH_REJECTED",
    "message": "one or more operations were rejected",
    "details": {
      "operation_errors": [
        { "op_id": "0198-op-1", "code": "CONFLICT", "current_entity": {} }
      ]
    }
  }
}
```

create、update、upsert 和 delete 共用请求 DTO；四种操作的 `data` 与版本规则见第 7 节。服务端只报告预检或事务回滚后确认的错误，不返回未经确认的部分成功结果。

### 6.4 完整同步接口

首次接入或增量游标过期时使用服务端会话：

| 方法   | 路径                     | 作用 |
| ------ | ------------------------ | ---- |
| `POST` | `/v1/full-sync/start`    | 创建会话并原子记录起始游标 `B` |
| `POST` | `/v1/full-sync/data`     | 自动分页返回所有已注册业务表 |
| `POST` | `/v1/full-sync/seal`     | 基础数据下载完成后固定截止游标 `H` |
| `POST` | `/v1/full-sync/changes`  | 分页返回 `(B,H]` 的不可变变更快照 |
| `POST` | `/v1/full-sync/complete` | 幂等关闭会话并将设备游标推进到 `H` |

#### 6.4.1 创建会话

请求：

```json
{ "request_id": "0198-full-start-1" }
```

响应：

```json
{
  "ok": true,
  "data": {
    "session_id": "0198-session-1",
    "phase": "downloading",
    "baseline_seq": 1280,
    "schema_version": 3,
    "expires_at": 1786500900000
  }
}
```

`start` 在一个 D1 batch 中建立会话、记录当前最大 change 为 `B` 并设置设备会话引用。重复 `request_id` 或设备已有有效会话时返回同一会话。

#### 6.4.2 下载业务数据

请求：

```json
{ "session_id": "0198-session-1", "cursor": null, "limit": 500 }
```

响应：

```json
{
  "ok": true,
  "data": {
    "rows": [
      { "table": "<registered-table>", "entity": { "id": "business-key-1", "sync_version": 2, "deleted": 0 } }
    ],
    "next_cursor": "opaque-table-position",
    "has_more": true,
    "expires_at": 1786500900000
  }
}
```

`data` 不接受表名，按 `sync_tables.table_order`、表内 `id ASC` 自动跨表分页（起点 `last_id = null`，空字符串是合法搜索 ID），数据来自 primary 并包含墓碑。 实现按代码白名单逐表执行主键范围查询，避免超出 D1 复合查询项数限制；数据与变更分页均设约 1 MiB 页预算，客户端以 `has_more` 而非返回条数判断结束。cursor 是 `base64url(canonical JSON + SHA-256 checksum)` 的无状态 keyset 位置，包含版本、session、schema、表序号和最后 ID；客户端可信，checksum 只用于发现损坏和客户端 bug，不作为防伪安全边界。相同参数可重复请求同一页，重复行必须可安全覆盖暂存区。

`limit` 必须在 1–500；`data` 和 `changes` 每次最多返回 500 条结果。

最后一页返回 `has_more: false`、`next_cursor: null` 和 `terminal_cursor`。客户端保存所有分页位置及 terminal cursor；响应丢失时使用原参数重试。

#### 6.4.3 固定截止游标

请求：

```json
{ "session_id": "0198-session-1", "terminal_cursor": "opaque-terminal-position" }
```

响应：

```json
{ "ok": true, "data": { "phase": "catching_up", "target_seq": 1310 } }
```

`seal` 验证 terminal cursor 后，在一个 batch 中将当前最大 change 记为 `H` 并切换 phase。重复调用返回同一个 `H`。

#### 6.4.4 追平变更

请求：

```json
{ "session_id": "0198-session-1", "cursor": 1280, "limit": 500 }
```

响应：

```json
{
  "ok": true,
  "data": {
    "changes": [
      { "change_seq": 1281, "table": "<registered-table>", "operation": "update", "payload": {} }
    ],
    "next_cursor": 1281,
    "target_seq": 1310,
    "has_more": true
  }
}
```

只允许从 `B` 顺序读取至 `H`，每条 change 的 payload 必须非空且来自流水快照。相同 cursor 可重复请求同一页。

#### 6.4.5 完成会话

客户端先在一个本地事务中将暂存区整体替换正式业务表并设置 `last_change_seq = H`，再请求：

```json
{ "session_id": "0198-session-1", "target_seq": 1310 }
```

响应：

```json
{ "ok": true, "data": { "session_id": "0198-session-1", "phase": "completed", "acknowledged_cursor": 1310 } }
```

服务端清除设备会话引用、设置 `last_ack_change_seq = H` 并把会话标记为 `completed`。重复调用返回同一成功结果；完成后恢复普通同步并重试 `pending_ops`。为处理“本地已切换但 complete 响应丢失”，已 seal 且 target 匹配的会话在过期后 24 小时内仍允许幂等 complete，但不再允许下载数据或 changes。

会话租约默认 15 分钟，合法分页请求续租 15 分钟，最长总时长 2 小时。同一设备只能有一个有效会话。除 complete 的 24 小时幂等宽限外，过期、schema 变化或流水失效时返回 `FULL_SYNC_EXPIRED`，清除设备引用，客户端丢弃暂存区重新开始。完整同步期间暂停普通同步和上传，但继续记录本地 `pending_ops`。

所有 full-sync 接口都验证 session 属于 `X-Device-ID`，并严格验证 phase：`data` 仅允许 `downloading`，`seal` 允许 `downloading` 或幂等读取已 seal 会话，`changes` 仅允许 `catching_up`，`complete` 允许 `catching_up` 或幂等读取已完成会话。错误分别使用 `SESSION_DEVICE_MISMATCH`、`INVALID_FULL_SYNC_PHASE`、`INVALID_CURSOR` 或 `FULL_SYNC_EXPIRED`。

## 7. 冲突与删除规则

### 7.1 创建

- `base_sync_version` 必须为 `null`。
- `data` 必须包含该业务表定义的全部必填业务字段，且只能包含允许写入字段。
- 若 ID 从未存在：创建，`sync_version = 0`，追加 `create` change。
- 若 ID 已存在（包括墓碑）：返回 `409 CONFLICT`，不能当作覆盖更新。

### 7.2 更新

- update 是 PATCH；`data` 至少包含一个允许写入字段，缺失字段保持原值。
- 只有 `base_sync_version === current.sync_version` 且 `current.deleted = 0` 才接受。
- 成功后由 Worker 将版本加一。
- 当前实体已删除时返回冲突，并返回墓碑状态。

### 7.3 删除

- delete 禁止携带 `data`。
- 删除同样要求版本匹配。
- 成功后 `deleted = 1` 且版本加一，并追加 delete change。
- 对同一 `op_id` 重试是幂等成功；换一个 `op_id` 再删已删除实体返回当前状态，不制造新流水。

### 7.4 创建或更新（upsert）

- 请求使用 `operation: "upsert"` 和 `base_sync_version: null`；服务端不得把客户端传入的版本写入数据库。
- ID 不存在时，`data` 必须包含全部必填业务字段；创建实体，设置 `sync_version = 0`，追加 `create` change。
- ID 已存在且未删除时，按 PATCH 语义无条件更新；缺失字段保持原值，令 `sync_version += 1`，追加 `update` change。`data` 至少包含一个允许写入字段。
- ID 是墓碑时，同样允许恢复：设置 `deleted = 0`、`sync_version += 1`，追加 `update` change。
- upsert 不返回版本冲突，多个设备写同一 ID 时采用 D1 事务提交顺序的后提交者覆盖；客户端时间不参与排序。
- upsert 仍须携带唯一 `op_id`，并遵守请求幂等、字段白名单和原子 change 规则。

### 7.5 业务唯一键

业务唯一键可以直接作为 `id`，使不同设备自然写入同一实体。所有客户端必须采用完全相同、版本化的规范化规则；原始字符串不同但语义相同的键不会被服务端自动合并。具体规则属于业务表定义。

upsert 会绕过乐观并发控制，并允许墓碑复活，只适用于明确接受“后提交者覆盖”的业务表或字段。需要保留并发修改的业务仍应使用 UUID、普通 update 和 `base_sync_version`。

### 7.6 operation 结构示例

以下为结构示意，实际字段以 `DOMAIN_TABLES.md` 为准：

```json
[
  { "op_id": "op-create", "table": "<registered-table>", "entity_id": "id-1", "operation": "create", "base_sync_version": null, "data": { "<all-required-fields>": "..." } },
  { "op_id": "op-update", "table": "<registered-table>", "entity_id": "id-2", "operation": "update", "base_sync_version": 3, "data": { "<changed-field>": "..." } },
  { "op_id": "op-upsert", "table": "<registered-table>", "entity_id": "id-3", "operation": "upsert", "base_sync_version": null, "data": { "<fields>": "..." } },
  { "op_id": "op-delete", "table": "<registered-table>", "entity_id": "id-4", "operation": "delete", "base_sync_version": 2 }
]
```

## 8. 长期离线与历史清理

v1 不承诺无限期增量历史。清理由 Worker 的 Cron Trigger 自动执行，建议每小时一次；写入路径同时执行容量保护，保证硬上限不会等待下一次定时任务。

`wrangler.jsonc` 必须声明，并由 Worker 导出 `scheduled()` handler：

```json
{ "triggers": { "crons": ["0 * * * *"] } }
```

推荐策略：

1. `changes`、`processed_ops`、`processed_batches` 各自最多 5000 行，任何记录最多保留 1 年。
2. 超过 1 年的记录直接删除；超过行数上限时，changes 按 `(updated_at, change_seq)`、幂等批次按 `server_updated_at` 从最旧开始删除，直到不超过 5000 行。
3. `min_valid_change_seq` 表示仍可作为增量起点的最小 cursor；若最早保留 change 为 `E`，其值最多推进到 `E - 1`。
4. 当客户端 `cursor < min_valid_change_seq` 时，返回 `TABLE_RELOAD_REQUIRED`，且不接受任何上传 operation。
5. 若行数清理将越过完整同步会话的 `baseline_seq`，先将受影响会话标记为 `expired` 并清除设备引用，再删除最旧 changes；硬上限优先于维持会话。
6. `processed_ops` 和 `processed_batches` 按批次一起清理：删除一个批次时同时删除其全部 operation 记录，直到两个表都不超过各自上限。
7. 墓碑最多保留 1 年；删除墓碑后，相同 ID 可再次 create。长期离线设备因此必须完整同步，不能依靠更早历史。
8. 完整同步完成后，暂存区整体替换本地云端镜像；本地待提交意图保留在 `pending_ops`。

清理、会话失效、游标推进必须放在同一个 D1 batch 中。业务写入前按“当前行数 + 本批新增量”计算需要释放的数量；若清理后的 `min_valid_change_seq` 将大于本请求 cursor，则拒绝本批并要求完整同步。否则在同一事务中先清理再插入，保证提交后仍满足硬上限。幂等保证只覆盖仍保留的记录；客户端不得在一年后重试旧 `batch_id` 或 `op_id`。

这条规则与墓碑共同防止数据“死而复生”。

## 9. 数据库迁移机制

使用 Wrangler/D1 migrations。迁移文件只能追加，已经发布的 migration 不得修改或重命名：

```text
migrations/
├── 0001_initial.sql
├── 0002_add_domain_table.sql
└── 0003_add_change_indexes.sql
```

发布流程：

1. 在本地 D1 应用全部 migration。
2. 运行旧 schema 到最新 schema 的迁移测试。
3. 先部署向前/向后兼容的 Worker。
4. 确认 D1 可恢复点或导出备份。
5. 对远端应用 migration。
6. 做健康检查和读写冒烟测试。
7. 再启用依赖新字段的新功能。

破坏性变更使用 expand–migrate–contract：先新增结构并双写，迁移旧数据，切换读取，最后在后续版本删除旧结构。不能依赖回滚 Worker 来回滚 D1 数据结构；Worker 版本回滚不等于数据库回滚。

`profile.schema_version` 用于 API 自检和诊断，但 migration 的实际应用记录应以 D1/Wrangler 的迁移记录为准。

## 10. GitHub Pages

页面由标题 + 三个主体部分组成：

1. 介绍部分
  - 简要介绍 CloudFlare Worker 用途、CloudFlare D1 免费版本用量限制。
  - 详细介绍 CloudFlare Worker 部署操作步骤。
2. 生成密钥部分
  - UI 由标签 + 生成按钮 + 复制按钮 + 介绍文本组成
  - 使用 `crypto.getRandomValues()` 在浏览器本地生成 32 字节随机值，并编码为 64 字符小写十六进制 `MASTER_KEY`。
  - 明确告知用户三条规则：
    - 密钥在浏览器本地环境生成，本页面不上传不存储，并且在离开或刷新本页面后立即丢失密钥。
    - 请用户将密钥保存在密码管理器，并让客户端使用操作系统安全凭据存储；本页面和 Cloudflare 控制面板都无法恢复原值。
    - 如果密钥丢失或任意设备疑似泄露，需要在 Cloudflare Worker 控制面板中替换 Secret；替换后所有设备都要重新配置。
3. 提供 Deploy to Cloudflare 按钮。
  - 仓库配置需要声明 D1 binding，确保 Deploy 流程能自动预配 D1 并绑定 Worker。主密钥作为 Secret 必须在部署流程中由用户输入，不能放进仓库 URL。

安全要求：

- 密钥不得写入 `localStorage`、Cookie、IndexedDB、URL、分析服务或错误上报。
- 页面不加载第三方分析、广告和远程脚本。
- 离开或刷新页面后立即丢失内存中的密钥。


## 11. 安全与可靠性要求

- 除 `/v1/health` 外，所有 API 只接受 `Authorization: Bearer <MASTER_KEY>`，密钥不得出现在 URL 或 query 参数中；生产访问必须使用 HTTPS。
- 主密钥缺失、格式错误和值错误统一返回 `401 UNAUTHORIZED`，响应不得暴露失败原因；认证失败和敏感请求必须限流。
- 不记录 `Authorization` header、完整请求 header、主密钥或包含主密钥的请求内容。CORS 只用于限制浏览器调用来源，不能替代鉴权。
- 限制请求体大小、单批 operation 数、单页 change 数和字符串长度。
- 只允许预定义表名和字段；表名绝不能直接从请求拼入 SQL。
- 所有值使用 prepared statements 绑定。
- 为 `/devices/bind`、`/sync` 和 `/full-sync/*` 设置速率限制；单实例同时最多允许 3 个有效完整同步会话。
- 错误响应不返回 SQL、堆栈、D1 ID、绑定配置和 Secret。
- 所有时间统一使用服务器 UTC 毫秒时间戳；仅作展示与审计。

## 12. API 错误码

| HTTP | code                   | 含义                             |
| ---: | ---------------------- | -------------------------------- |
|  400 | `INVALID_REQUEST`      | JSON、字段、表或操作不合法       |
|  400 | `UNSUPPORTED_API_VERSION` | API 版本缺失或不支持          |
|  400 | `INVALID_CURSOR`       | 分页游标损坏、越界或不连续       |
|  400 | `DUPLICATE_ENTITY_IN_BATCH` | 同批重复操作同一实体         |
|  401 | `UNAUTHORIZED`         | 主密钥缺失或错误                 |
|  403 | `DEVICE_NOT_BOUND`     | 设备不存在或已解绑               |
|  403 | `SESSION_DEVICE_MISMATCH` | 会话不属于当前设备            |
|  404 | `ENTITY_NOT_FOUND`     | 指定实体不存在                   |
|  404 | `FULL_SYNC_NOT_FOUND`  | 完整同步会话不存在               |
|  409 | `CONFLICT`             | `base_sync_version` 与云端不一致 |
|  409 | `BATCH_REJECTED`       | 批量操作整批拒绝                 |
|  409 | `OP_ID_REUSED`         | 同一 `op_id` 被用于不同请求      |
|  409 | `BATCH_ID_REUSED`      | 同一 `batch_id` 被用于不同批次   |
|  409 | `FULL_SYNC_IN_PROGRESS` | 当前设备正在完整同步            |
|  409 | `INVALID_FULL_SYNC_PHASE` | 接口与当前会话阶段不匹配       |
|  410 | `TABLE_RELOAD_REQUIRED` | 游标早于最早有效流水            |
|  410 | `FULL_SYNC_EXPIRED`    | 完整同步会话已过期或失效         |
|  413 | `PAYLOAD_TOO_LARGE`    | 请求体或批次过大                 |
|  429 | `RATE_LIMITED`         | 请求过于频繁                     |
|  500 | `INTERNAL_ERROR`       | 未分类服务端错误                 |
|  503 | `DATABASE_UNAVAILABLE` | D1 暂时不可用，可按退避策略重试  |

## 13. 客户端同步算法

客户端本地至少维护：

- 业务数据镜像；
- `pending_ops(op_id, table, entity_id, action, base_sync_version, payload)`；
- `pending_batches(batch_id, ordered_op_ids, request_hash)`；
- `last_change_seq`；
- `device_id`。

一次同步：

1. 将本地用户操作先事务性写入业务表和 `pending_ops`。
2. 选择最多 8 个 pending ops，生成 `batch_id`，并在本地事务中保存固定的有序内容和 hash 后再发送。
3. 调用 `/v1/sync`，令 `cursor = ack_cursor =` 当前已在本地提交的 `last_change_seq`。网络超时或临时故障后必须原样重试同一批次，不能增删、重排 operation 或更换 ID。
4. 成功时在一个本地事务中应用全部 operation results 与 changes、删除整批 pending ops、删除 pending batch，并更新 `last_change_seq`。
5. 业务错误时整批 pending ops 均保留；客户端解决冲突或修改意图后删除旧 pending batch，并为新内容生成新的 `batch_id`。
6. 若 `has_more = true`，使用空 operations 且不带 `batch_id` 继续拉取。
7. 已经成功的 `op_id` 不得用于新操作。
8. 收到 `TABLE_RELOAD_REQUIRED` 时暂停上传并保留 pending 数据，按 6.4 执行完整同步；整体切换并关闭会话后再恢复上传。

普通 update 的默认冲突策略不应是“最后写入获胜”。具体业务应自行定义合并策略；选择 upsert 的业务则明确采用 D1 事务提交顺序的后提交者覆盖。

## 14. 测试与验收

### 14.1 必测场景

- 正确/错误/缺失主密钥。
- 主密钥只能通过 `Authorization: Bearer` 传入；URL/query 中的密钥不被接受。
- 主密钥使用 SHA-256 固定长度摘要和 `crypto.subtle.timingSafeEqual()` 比较，认证日志和错误响应不泄露密钥或失败细节。
- 替换 Worker Secret 后旧密钥失效，新密钥生效。
- 未绑定设备、已解绑设备、重复绑定、设备数上限。
- create/update/delete/upsert 的正常路径。
- update 按 PATCH 保留缺失字段；upsert 更新分支保留缺失字段，创建分支缺少必填字段时整批拒绝；delete 携带 data 时拒绝。
- 同一批次重复 `(table, entity_id)` 时在写入前整批拒绝。
- 两台设备基于同一版本并发修改，只能有一个直接成功。
- 删除后长期离线设备上线，普通旧 update 不得复活数据。
- 两台设备以同一业务键并发 upsert 时都可成功，最终值与服务端提交顺序一致，版本逐次增加。
- upsert 在实体不存在、存活和已成为墓碑三种情况下分别执行创建、覆盖和恢复。
- 不同客户端对同一业务键执行业务文档规定的规范化后得到完全相同的 `id`。
- 客户端把系统时间改到过去或未来，同步结果不受影响。
- 请求超时后原样重试相同 `batch_id`，每个 operation 只产生一次实体变化和一条 change。
- 相同 `op_id` 携带不同内容被拒绝。
- 已成功的 `op_id` 出现在其他批次时，整个新批次以 `OP_ID_REUSED` 拒绝。
- 两个相同 `op_id` 并发请求只提交一次；实体、change 和幂等记录不存在部分提交。
- 成功批次可稳定重放；版本冲突、不存在和业务约束错误不缓存且不产生副作用。
- 单批任一 operation 冲突会回滚全部实体、changes 和幂等记录；不存在部分提交。
- 成功批次超时后用相同 `batch_id` 原样重试会返回缓存结果；失败批次修正后使用新的 `batch_id`。
- `cursor` 分页无遗漏、无跳跃；重复 change 可安全应用。
- `/sync` 仅按客户端提交的合法 `ack_cursor` 单调推进设备确认游标，不能确认本响应尚未提交的数据。
- 没有完整同步会话时 change 可不保存 payload；存在会话时，后续每条 change 都保存完整实体或墓碑。
- 会话建立与并发写入不存在漏存 payload 的竞态；多个重叠会话结束前不会提前清理所需 payload。
- 完整同步数据接口不接受表名，并按注册表自动分页返回全部业务表。
- 完整同步 data/changes 的 limit 最大为 500，重复相同分页参数可安全返回和应用。
- 设备 A 持续修改任意业务表时，设备 B 仍能追平到固定 `H` 并一次性切换，不暴露跨表半完成状态。
- 完整同步期间普通 `/sync` 被拒绝；本地意图保留，完成后以原 `op_id` 重试。
- 会话超时、末页响应丢失、`seal`/`complete` 重试及业务表注册版本变化均能安全恢复。
- Cron 和写入容量保护会删除超过一年或超出 5000 行的最旧记录；必要时先使受影响完整同步会话过期，并正确推进最早有效游标。
- 从每一个受支持的旧 schema 版本迁移到当前版本。
- 非法表名/字段、超大 payload、超大批次、畸形 JSON。

### 14.2 v1 验收标准

- 新用户可从 GitHub Pages 完成生成密钥、部署、设置 Secret 和首次绑定。
- Worker 在全新 D1 上应用迁移后无需人工执行 SQL 即可运行。
- 所有公开 API 有请求、响应、错误码示例。
- 应用 SQL 集中在 `src/service.ts`，迁移集中在 `migrations/`。
- 两台设备可完成创建、更新、删除、upsert 与增量同步。
- 并发冲突、幂等重试、墓碑和完整同步会话均通过自动化测试。
- 源码、构建产物、D1、日志和 Pages 持久化存储中均不存在真实主密钥；生产环境只通过 Worker Secret 提供密钥。

## 15. 暂不纳入 v1

- 多用户账号系统、邮箱登录、OAuth、密码找回。
- 多把管理员密钥或每设备独立密钥。
- 任意 SQL 执行 API。
- 图片和大型文件同步。
- 自动通用冲突合并或 CRDT。
- 浏览器页面直接查看、编辑用户数据库。

这些能力会显著扩大攻击面或改变“单用户、单主密钥、私有数据库”的项目定位，应在独立主版本中设计。

## 16. 实施顺序

1. 建立仓库、Wrangler 配置和 `0001_initial.sql`。
2. 完成 5.8 的本地与远端 D1 原子 SQL 实验；未通过前不实现正式写入路径。
3. 完成鉴权、统一响应与 `/health`、`/auth/verify`。
4. 完成设备绑定、查询、更新和解绑。
5. 按 `DOMAIN_TABLES.md` 完成业务迁移、字段白名单和命名 SQL。
6. 完成 `processed_ops`、整批 OCC 写入和 `changes` 流水。
7. 完成单请求上传 + 拉取的 `/sync`。
8. 完成业务表注册、完整同步会话和过期游标恢复。
9. 完成 Cron Trigger 与写入路径容量清理。
10. 增加本地/集成测试及迁移测试。
11. 制作 GitHub Pages 密钥生成与部署引导。
12. 验证 Deploy to Cloudflare 全新账号流程。
13. 发布 v1，并冻结 `/v1` 协议与 `0001_initial.sql`。

## 17. 参考资料

- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Cloudflare Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
