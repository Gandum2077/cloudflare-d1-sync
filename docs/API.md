# HTTP API v1

基础 URL：`https://<worker>/v1`。所有响应都是 JSON：成功为 `{"ok":true,"data":...}`，失败为 `{"ok":false,"error":{"code":"...","message":"...","details":{}}}`。

除健康检查外，请求头必须包含：

```http
Authorization: Bearer <64-character-lowercase-hex-MASTER_KEY>
X-API-Version: 1
```

除鉴权验证和设备绑定外，还必须包含 `X-Device-ID: <bound-device-id>`。JSON 请求必须使用 `Content-Type: application/json`。

## 系统

### `GET /v1/health`

无鉴权、无请求体。

```json
{"ok":true,"data":{"service":"cloudflare-d1-sync","api_version":1}}
```

### `GET /v1/auth/verify`

验证主密钥和 API 版本。

```json
{"ok":true,"data":{"authenticated":true,"api_version":1}}
```

认证失败示例：

```json
{"ok":false,"error":{"code":"UNAUTHORIZED","message":"authentication failed","details":{}}}
```

### `GET /v1/info`

```json
{"ok":true,"data":{"schema_version":1,"api_version":1,"min_valid_change_seq":0,"current_change_seq":128,"sync_tables":["bookmarks","settings"],"capabilities":["batch_atomic","full_sync","upsert"]}}
```

## 设备

### `POST /v1/devices/bind`

此端点不需要 `X-Device-ID`。同一 ID 会更新元数据并恢复已解绑设备。

```json
{"device_id":"device-01","name":"My iPhone","platform":"ios","app_version":"1.0.0"}
```

```json
{"ok":true,"data":{"device":{"id":"device-01","deleted":0,"name":"My iPhone","platform":"ios","app_version":"1.0.0","last_seen_at":1786500000000,"last_ack_change_seq":0,"full_sync_session_id":null}}}
```

### `GET /v1/devices`

返回所有设备，包括 `deleted: 1` 的已解绑记录。

```json
{"ok":true,"data":{"devices":[{"id":"device-01","deleted":0,"name":"My iPhone","platform":"ios","app_version":"1.0.0","last_seen_at":1786500000000,"last_ack_change_seq":0,"full_sync_session_id":null}]}}
```

### `PATCH /v1/devices/:id`

请求是 `name`、`platform`、`app_version` 的任意非空子集；`platform` 与 `app_version` 可设为 `null`。

```json
{"name":"New name","app_version":"1.1.0"}
```

响应与 bind 的 `data.device` 相同。目标不存在为 `404 ENTITY_NOT_FOUND`，已解绑为 `409 CONFLICT`。

### `DELETE /v1/devices/:id`

无请求体。幂等地设置 `deleted: 1`，同时使该设备的完整同步会话过期。响应与 bind 的 `data.device` 相同。

## 增量同步

### `POST /v1/sync`

纯拉取：

```json
{"cursor":128,"ack_cursor":128,"limit":200,"operations":[]}
```

带原子上传批次：

```json
{
  "batch_id":"batch-0198",
  "cursor":128,
  "ack_cursor":128,
  "limit":200,
  "operations":[
    {
      "op_id":"op-0198",
      "table":"bookmarks",
      "entity_id":"https://example.com/",
      "operation":"update",
      "base_sync_version":3,
      "data":{"title":"New title"}
    }
  ]
}
```

`create` 和 `upsert` 的 `base_sync_version` 必须为 `null`；`update` 和 `delete` 必须提交非负整数版本。`delete` 不允许 `data`。每批最多 8 个 operation，同一批不能重复 `(table, entity_id)`。

```json
{
  "ok":true,
  "data":{
    "results":[{"op_id":"op-0198","status":"applied","entity_id":"https://example.com/","sync_version":4,"change_seq":129}],
    "changes":[{"change_seq":129,"table":"bookmarks","operation":"update","payload":{"id":"https://example.com/","sync_version":4,"deleted":0,"server_updated_at":1786500000000,"url":"https://example.com/","title":"New title","note":"","tags_json":"[]"}}],
    "next_cursor":129,
    "acknowledged_cursor":128,
    "has_more":false,
    "server_time":1786500000000
  }
}
```

批次失败时没有任何部分写入：

```json
{"ok":false,"error":{"code":"BATCH_REJECTED","message":"one or more operations were rejected","details":{"operation_errors":[{"op_id":"op-0198","code":"CONFLICT","current_entity":{"id":"https://example.com/","sync_version":4,"deleted":0}}]}}}
```

超时后必须原样重试同一个 `batch_id` 与有序 operations；成功重放的 result 使用 `status: "replayed"`。确定的业务错误修正后应生成新 `batch_id`。

## 完整同步

### `POST /v1/full-sync/start`

```json
{"request_id":"full-start-0198"}
```

```json
{"ok":true,"data":{"session_id":"session-uuid","phase":"downloading","baseline_seq":128,"schema_version":1,"expires_at":1786500900000}}
```

同一 `request_id` 或同设备已有有效会话时返回同一会话。

### `POST /v1/full-sync/data`

```json
{"session_id":"session-uuid","cursor":null,"limit":500}
```

```json
{"ok":true,"data":{"rows":[{"table":"settings","entity":{"id":"theme","sync_version":1,"deleted":0,"value_json":"{\"mode\":\"dark\"}"}}],"next_cursor":null,"has_more":false,"terminal_cursor":"opaque","expires_at":1786500900000}}
```

后续页把上一次 `next_cursor` 原样传回。最后一页提供 `terminal_cursor`。

### `POST /v1/full-sync/seal`

```json
{"session_id":"session-uuid","terminal_cursor":"opaque"}
```

```json
{"ok":true,"data":{"phase":"catching_up","target_seq":132}}
```

### `POST /v1/full-sync/changes`

第一次从 `baseline_seq` 开始，之后使用响应的 `next_cursor`。

```json
{"session_id":"session-uuid","cursor":128,"limit":500}
```

```json
{"ok":true,"data":{"changes":[{"change_seq":129,"table":"settings","operation":"update","payload":{"id":"theme","sync_version":2,"deleted":0,"value_json":"{\"mode\":\"light\"}"}}],"next_cursor":132,"target_seq":132,"has_more":false,"expires_at":1786500900000}}
```

### `POST /v1/full-sync/complete`

客户端先在本地事务中整体切换暂存区，再调用：

```json
{"session_id":"session-uuid","target_seq":132}
```

```json
{"ok":true,"data":{"session_id":"session-uuid","phase":"completed","acknowledged_cursor":132}}
```

complete 可幂等重试。会话默认租期 15 分钟、最长 2 小时；已 seal 会话过期后仍有 24 小时 complete 宽限。

## 业务表

### `bookmarks`

客户端可写：`url`、`title`、`note`、`tags_json`。create/upsert 创建分支必须四项齐全。`entity_id` 必须是规范化 URL：HTTP(S)、scheme/host 小写、无 fragment、无默认端口、空 path 为 `/`。

### `settings`

客户端可写：`value_json`。create/upsert 创建分支必须提供它，且内容必须是合法 JSON 文本。

## 错误码

| HTTP | code | 说明 |
| ---: | --- | --- |
| 400 | `INVALID_REQUEST` | JSON、字段、表或操作非法 |
| 400 | `UNSUPPORTED_API_VERSION` | API 版本缺失或不支持 |
| 400 | `INVALID_CURSOR` | 游标损坏、越界或不连续 |
| 400 | `DUPLICATE_ENTITY_IN_BATCH` | 同批重复操作同一实体 |
| 401 | `UNAUTHORIZED` | 主密钥缺失或错误 |
| 403 | `DEVICE_NOT_BOUND` | 设备不存在或已解绑 |
| 403 | `SESSION_DEVICE_MISMATCH` | 会话不属于当前设备 |
| 404 | `ENTITY_NOT_FOUND` | 实体或设备不存在 |
| 404 | `FULL_SYNC_NOT_FOUND` | 完整同步会话不存在 |
| 409 | `CONFLICT` / `BATCH_REJECTED` | 版本冲突或整批拒绝 |
| 409 | `OP_ID_REUSED` / `BATCH_ID_REUSED` | 幂等 ID 被改作他用 |
| 409 | `FULL_SYNC_IN_PROGRESS` | 当前设备正在完整同步 |
| 409 | `INVALID_FULL_SYNC_PHASE` | 会话阶段不允许该操作 |
| 410 | `TABLE_RELOAD_REQUIRED` | 增量流水已过期 |
| 410 | `FULL_SYNC_EXPIRED` | 完整同步会话失效 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求超过 128 KiB |
| 429 | `RATE_LIMITED` | 请求频率或资源数量超限 |
| 500 | `INTERNAL_ERROR` | 未分类服务端错误 |
| 503 | `DATABASE_UNAVAILABLE` | D1 暂时不可用，可退避重试 |
