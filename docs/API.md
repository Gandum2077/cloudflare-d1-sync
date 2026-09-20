# Cloudflare D1 Sync HTTP API v1

> 状态：已实现并通过本地 workerd/D1 测试；尚未执行远端部署验收。
>
> 同步语义依据 [同步协议](../同步协议.md)，鉴权与项目范围依据 [项目规划](../PROJECT_SPEC.md)。本文补齐 HTTP 字段、默认值和响应格式，供后端与客户端共同实现。

## 1. 通用约定

### 1.1 地址与鉴权

Base URL 为用户部署的 Worker HTTPS 地址，例如 `https://sync.example.workers.dev`。下文路径均相对此地址，版本放在 `/v1` 路径中。

除 `GET /v1/health` 外，所有接口携带：

```http
Authorization: Bearer <MASTER_KEY>
Accept: application/json
```

有请求体的接口还必须携带 `Content-Type: application/json`，允许 `charset=utf-8`。请求和响应使用 UTF-8 JSON。主密钥是 64 字符小写十六进制字符串，只通过 Authorization 传递，不接受 URL、查询参数或正文中的密钥。

缺失、格式错误或不匹配的密钥统一返回 `401 UNAUTHORIZED`。更换 Worker Secret 后所有设备须使用新密钥。device_id 只是设备标识，不是独立凭据；持有主密钥可以管理全部设备，包括重新启用设备。

增量和完整下载响应采用流式输出；客户端须接收并解析完整 JSON 后才应用本页。若响应中断，即使已收到 HTTP 200，也不能推进游标，应重试原页。

JSON 响应设置 `Content-Type: application/json; charset=utf-8` 和 `Cache-Control: no-store`。平台在请求到达 Worker 前返回的错误可能不遵循本文 JSON 格式。

### 1.2 数据类型与参数

| 类型/字段 | 约定 |
| --- | --- |
| `tablename`、记录 `id` | 任意 JSON 字符串，包括空字符串；无格式或协议长度限制，不 trim、不改大小写、不规范化 |
| `device_id`、设备路径 `{id}` | 非空字符串，每个安装实例独占；建议客户端生成 UUID，路径值按单个路径段进行 URL 编码 |
| `content` | 任意合法 JSON 值，包含对象、数组、字符串、数字、布尔值和 null；不设协议大小上限 |
| `seq`、`start_seq`、`next_seq`、`last_seq` | 0～9007199254740991 的整数 |
| `request_seq`、`sync_version`、`base_sync_version` | 1～9007199254740991 的整数；设备尚无写请求时 `last_request_seq=0` |
| `limit` | 整数，默认 100，最小 1，最大 100；越界拒绝，不静默修正 |
| 布尔值 | JSON true/false，不接受 0/1 或字符串 |
| 时间 | 服务端 UTC Unix 毫秒时间戳，不参与冲突判断 |

正文必须是 JSON 对象。未知的协议字段、重复 JSON 对象成员名、错误类型和缺失必填字段均返回 `INVALID_REQUEST`；content 内部字段由业务自行定义，不做字段白名单校验。响应可以增加字段，客户端应忽略未知响应字段。

不设额外 content 大小限制不代表平台容量无限；超过平台硬限制必须报错，不能截断或伪报成功。JSON null 是合法存活内容，与删除记录省略 content 不同。

### 1.3 读取约束

绝对禁止全表扫描或单次全表读取。changes 只在当前页内合并，data 只按主键点查或主键索引分页下载。不得使用 OFFSET、全表计数、无界排序或扫描其他 changes 页寻找最新版本。

所有列表均无总数、页码和跳页参数。分页默认/最大 100；判断是否还有数据最多额外做一次索引定位，读取一条键。完整下载累计读取全部记录，每次仅读取小页；不能承诺累计读取额度为零。

### 1.4 接口目录

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/health` | 公开存活检查，不查询数据库 |
| PUT | `/v1/devices/{id}` | 注册设备或更新资料 |
| GET | `/v1/devices` | 分页列出设备 |
| PATCH | `/v1/devices/{id}` | 禁用或重新启用设备 |
| POST | `/v1/write` | 最多 10 条批量写入 |
| POST | `/v1/sync` | 增量下载、确认正式游标或恢复补拉 |
| POST | `/v1/full-download` | 分页完整下载 |

没有 `/v1/full-sync`、upsert、任意 SQL、全量一次性导出或业务字段查询接口。

## 2. 公共响应结构

### 2.1 同步记录 Record

存活记录：

```json
{
  "tablename": "archives",
  "id": "A",
  "content": {"title": "示例"},
  "sync_version": 3,
  "deleted": false
}
```

删除记录：

```json
{
  "tablename": "archives",
  "id": "A",
  "sync_version": 4,
  "deleted": true
}
```

以上字段为完整 Record 格式。存活记录必须有 content，即使值为 null；删除记录省略 content。不返回历史 content、事件 seq 或数据库内部字段。服务端仍维护创建者、更新者和更新时间，用于版本处理与自身过滤。

### 2.2 设备 Device

```json
{
  "id": "iphone-01",
  "name": "我的 iPhone",
  "platform": "ios",
  "last_seq": 1100,
  "last_request_seq": 12,
  "created_at": 1789516800000,
  "last_seen_at": 1789516860000,
  "disabled": false
}
```

name/platform 为字符串或 null；last_seq 是设备已确认应用的位置，last_request_seq 是最后完成的整批写请求编号。两者不相关。不得返回 last_request_hash、last_request_result 或主密钥。

created_at 注册后不变。设备成功发起 write/sync/full-download 时更新 last_seen_at；它仅作最近活动参考。资料管理和列表查询不代表目标设备上线，不更新已有设备的 last_seen_at。注册时两时间均取当前服务端时间。

### 2.3 接口级错误

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "limit 必须为 1 到 100 的整数。"
  }
}
```

error.code 为稳定的程序判断依据；message 是说明文字，不保证固定内容。错误不能泄露 SQL、堆栈、Secret 或完整业务内容。批量业务错误使用 results，见第 5 节。

## 3. 存活检查

### GET /v1/health

无鉴权、无参数、无请求体。

响应 `200 OK`：

```json
{"status":"ok","api_version":"v1"}
```

仅表明 Worker 可处理请求，不验证 D1 连通性、迁移状态或主密钥是否正确，不触发任何数据库扫描。

## 4. 设备管理

设备管理接口仅使用主密钥，不要求另带调用者 device_id。禁用设备仍可出现在列表中，不物理删除，避免遗失幂等状态。

### 4.1 PUT /v1/devices/{id}

创建指定设备；已存在时只更新明确提交的资料字段。

| 正文字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | 否 | string/null | 创建时缺省 null；更新时省略表示保留，null 表示清空 |
| `platform` | 否 | string/null | 同上，不限制枚举 |

```http
PUT /v1/devices/iphone-01
```

```json
{"name":"我的 iPhone","platform":"ios"}
```

新设备返回 `201 Created`，已有设备返回 `200 OK`，正文统一为：

```json
{
  "device": {
    "id": "iphone-01",
    "name": "我的 iPhone",
    "platform": "ios",
    "last_seq": 0,
    "last_request_seq": 0,
    "created_at": 1789516800000,
    "last_seen_at": 1789516800000,
    "disabled": false
  }
}
```

允许空对象 `{}`。新设备 disabled=false；更新不得改变 disabled、确认游标、请求编号、创建时间或幂等缓存。重复注册不是重置设备；重新启用通过 PATCH。

### 4.2 GET /v1/devices

| 查询参数 | 必填 | 说明 |
| --- | --- | --- |
| `limit` | 否 | 十进制整数，默认/最大 100 |
| `after_id` | 否 | 上一页返回的 next_after_id，URL 编码后原样传入；首次省略 |

```http
GET /v1/devices?limit=100&after_id=iphone-01
```

按设备主键的 BINARY 顺序，读取 id 严格大于 after_id 的一页，包含禁用设备。响应 `200 OK`：

```json
{
  "devices": [
    {
      "id": "mac-01",
      "name": "我的 Mac",
      "platform": "macos",
      "last_seq": 0,
      "last_request_seq": 0,
      "created_at": 1789516800000,
      "last_seen_at": 1789516800000,
      "disabled": false
    }
  ],
  "next_after_id": null,
  "has_more": false
}
```

有后续页时 next_after_id 为本页最后一个设备 ID，否则为 null。空结果返回 devices=[]、next_after_id=null、has_more=false。设备列表不是固定快照，遍历期间新注册的设备可在下一轮查询。

### 4.3 PATCH /v1/devices/{id}

必填正文 `disabled: boolean`：

```json
{"disabled":true}
```

响应 `200 OK`，结构为 `{"device": Device}`，字段与 4.1 相同。目标不存在返回 `404 DEVICE_NOT_FOUND`。重复设置同一状态成功，不增加任何 sync_version、seq 或 request_seq。

禁用设备调用 write/sync/full-download 返回 `403 DEVICE_DISABLED`，包括写请求重放。重新启用保留原请求编号、结果与游标；密钥轮换不重置这些状态。禁用不能撤销主密钥。

## 5. 批量写入

### 5.1 POST /v1/write

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `device_id` | 是 | string | 已注册且启用的设备 |
| `request_seq` | 是 | 正整数 | 新设备从 1 开始，此后逐次加 1 |
| `operations` | 是 | Operation[] | 1～10 条，顺序固定，不允许同批重复二元主键 |

Operation：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `operation` | 是 | create、update 或 delete |
| `tablename` | 是 | 任意字符串 |
| `id` | 是 | 任意字符串 |
| `content` | create/update 是 | 完整 JSON 内容；delete 禁止携带，即使是 null |
| `base_sync_version` | 普通 update/delete 是 | 正整数；create/forced 可省略，提供时仍须类型合法，但不参与版本判断 |
| `forced` | 否 | boolean，默认 false；true 必须来自用户主动决定 |

不得提交新的 sync_version、deleted、seq 或设备审计字段。

### 5.2 操作语义

| 操作 | 条件 | 成功行为 |
| --- | --- | --- |
| create | 不存在或已删除 | 创建/恢复内容，deleted=false |
| update | 存在、未删除、版本相同 | 替换整个 content |
| delete | 存在、未删除、版本相同 | 清空 content，deleted=true |
| forced create/update | 无版本前提 | 不存在则创建，否则覆盖/恢复 |
| forced delete | 存在且未删除 | 跳过版本比较，执行删除 |

首次版本为 1；任何成功操作都增加版本，包括内容相同的 update。删除后恢复继续原版本，不重置首次创建者。不存在或已删除的 update/delete 优先返回 ENTITY_NOT_FOUND，而不是 VERSION_CONFLICT。

### 5.3 混合结果示例

假设 A 尚不存在，B 为存活 v5，C 为存活 v2：

```json
{
  "device_id": "iphone-01",
  "request_seq": 1,
  "operations": [
    {"operation":"create","tablename":"archives","id":"A","content":{"title":"新增"}},
    {"operation":"update","tablename":"archives","id":"B","base_sync_version":4,"content":{"title":"修改"}},
    {"operation":"delete","tablename":"archives","id":"C","base_sync_version":2}
  ]
}
```

响应 `200 OK`：

```json
{
  "request_seq": 1,
  "results": [
    {"index":0,"success":true,"tablename":"archives","id":"A","sync_version":1,"deleted":false},
    {"index":1,"success":false,"tablename":"archives","id":"B","code":"VERSION_CONFLICT","sync_version":5,"deleted":false},
    {"index":2,"success":true,"tablename":"archives","id":"C","sync_version":3,"deleted":true}
  ]
}
```

results 与 operations 长度、顺序一致；index 从 0 开始。HTTP 200 只代表整批处理完成，客户端必须检查每个 success。即使全部是业务失败，也返回 200 并消耗该 request_seq。

成功项包含 index、success、tablename、id、sync_version、deleted。失败项包含前四项及 code；目标有当前记录时还包含当前 sync_version/deleted，完全不存在则省略这两个字段。

结果不回传 content。成功内容由客户端保存的原请求确定；删除成功对应无内容的 tombstone。返回版本属于原次处理结果，重放不能据此覆盖本地较新版本。

### 5.4 强制操作示例

上一批已完成并在本地保存结果后，用户选择覆盖 B：

```json
{
  "device_id": "iphone-01",
  "request_seq": 2,
  "operations": [
    {"operation":"update","tablename":"archives","id":"B","content":{"title":"用户确认覆盖"},"forced":true}
  ]
}
```

若 B 仍为 v5，成功结果为 v6；如果期间发生其他修改，则基于执行时的服务端版本加 1，不能使用客户端版本重置服务端版本。

### 5.5 原子性及重试

成功项的数据修改、对应 changes 和整批幂等结果一起提交。业务冲突只影响对应项；数据库故障导致整个事务回滚。结构错误、超过 10 条或同批重复主键在执行前拒绝整批。

每设备仅保留最后完成的请求编号、正文 hash 和整批结果：

| 请求编号 | 行为 |
| --- | --- |
| 等于上次编号且正文完全相同 | 200，返回原结果，不重复写入 |
| 等于上次编号但正文不同 | 409 REQUEST_SEQ_REUSED |
| 等于上次编号 + 1 | 处理新请求 |
| 小于上次编号 | 409 REQUEST_EXPIRED |
| 大于上次编号 + 1 | 409 REQUEST_OUT_OF_ORDER |

正文 hash 按 UTF-8 原始正文计算。字段顺序、空白、显式 false 与省略 false 都会改变正文；重试必须发送同一份持久化字节，不重新序列化，也不更换编号。Authorization 不属于 hash。

每设备只能有一批未确认请求。并发请求同一批也只能执行一次。客户端本地事务同时完成：应用成功结果、保存失败状态、确认整批请求、推进本地请求编号。成功项从待上传队列移除，失败项保留供解决；不能自动强制覆盖。

超时、断线或无法确定提交状态时，原样重试。确定结构错误不消耗编号，可修正后仍用待发送编号；收到 200 后修改业务意图必须使用下一编号。更旧请求的结果不提供永久查询；丢失本地请求状态应使用新设备 ID，不能靠重新注册旧 ID 重置编号。

## 6. 增量同步

### 6.1 POST /v1/sync

| 字段 | 必填 | 类型/默认值 | 说明 |
| --- | --- | --- | --- |
| `device_id` | 是 | string | 已注册且启用 |
| `seq` | 是 | 非负安全整数 | 已应用的事件位置，从此位置之后读取 |
| `limit` | 否 | integer，100 | 最多扫描 100 个原始事件 |
| `include_self` | 否 | boolean，false | true 包含自身版本，且不更新正式确认位置 |

```json
{"device_id":"iphone-01","seq":1000,"limit":100,"include_self":false}
```

响应 `200 OK`：

```json
{
  "changes": [
    {"tablename":"archives","id":"A","content":{"title":"来自另一设备"},"sync_version":12,"deleted":false},
    {"tablename":"archives","id":"C","sync_version":7,"deleted":true}
  ],
  "next_seq": 1100,
  "has_more": true
}
```

changes 为 Record 数组，最多 limit 条，无固定业务表顺序，不能用其排序决定游标。

### 6.2 扫描与过滤规则

1. seq 索引定位并读取当前页原始事件。
2. 仅在页内按二元主键合并。
3. 主键点查这些 data 的当前状态。
4. include_self=false 时，排除 data.updated_by_device_id 等于 device_id 的记录；true 时不排除。

不得扫描其他 changes 页查最新事件。返回状态可以新于扫描窗口；客户端只应用较大的 sync_version，不使用响应到达顺序覆盖。

next_seq 为最后实际扫描到的事件 seq，不是 client_seq + limit，也不是返回记录的最大版本。没有事件时保留请求 seq；过滤后为空也须推进到已扫描位置，例如：

```json
{"changes":[],"next_seq":1100,"has_more":true}
```

has_more=true 必须继续请求，不能因为 changes 为空停止。has_more=false 只表示当前检查时没有更多事件，不保证之后无新写入。

### 6.3 游标校验与确认

latest_seq/oldest_seq 来自索引端点；新库 latest_seq=0。日志清理保留最新事件，不清空 changes。

| 条件 | 响应 |
| --- | --- |
| 非法 seq，或 seq > latest_seq | 400 INVALID_CURSOR |
| 非空日志中 seq < oldest_seq - 1 | 410 FULL_SYNC_REQUIRED |
| seq == oldest_seq - 1 | 允许增量同步 |
| 空库且 seq=0 | 200，空数组、next_seq=0、has_more=false |

例如 oldest_seq=101，seq=100 合法，seq=99 必须完整下载。

普通请求只在游标通过校验后，将 devices.last_seq 单调推进至请求中的 seq，不能推进到本响应 next_seq。旧的合法 seq 可以重读，不能使确认位置倒退。客户端先在本地事务应用响应并保存 next_seq，再用该值发下一请求。

include_self=true 用于暂存区恢复，不更新 devices.last_seq。恢复切换完成后，用最终游标发送普通同步即可确认；不需要独立 ack 接口。

### 6.4 冲突后的拉取

失败项只含版本和删除状态。客户端保留本地待上传意图，从正式游标同步云端状态以解决冲突。需要包含自身版本时可使用 include_self=true，但自行在本地成功应用后再通过普通请求确认。若目标已不在保留窗口内，按 FULL_SYNC_REQUIRED 进行完整下载；不能绕过索引限制扫描历史查找目标。

## 7. 完整下载

### 7.1 POST /v1/full-download

不建立服务端快照或会话，不增加 sync_meta。完整下载以客户端保存的 start_seq 和复合主键游标推进。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `device_id` | 是 | 已注册且启用 |
| `limit` | 否 | 默认/最大 100 |
| `cursor` | 否 | 首次省略或 null；后续原样使用上页 next_cursor |

游标为对象：

```json
{"start_seq":1200,"after":{"tablename":"archives","id":"A"}}
```

start_seq 为首次下载前取得的最新 seq，after 包含两条原始字符串。不得拼成带分隔符的字符串，也不得用空字符串代替“无游标”；空字符串可能是真实主键。游标不含主密钥，也不是鉴权凭据。

### 7.2 首次请求

```json
{"device_id":"iphone-01","limit":1}
```

响应 `200 OK`：

```json
{
  "start_seq": 1200,
  "data": [
    {"tablename":"archives","id":"A","content":{"title":"示例"},"sync_version":2,"deleted":false}
  ],
  "next_cursor": {
    "start_seq": 1200,
    "after": {"tablename":"archives","id":"A"}
  },
  "has_more": true
}
```

此例使用 limit=1 展示翻页。首次 start_seq 必须在首个 data 页读取之前取得。

### 7.3 后续请求与末页

```json
{
  "device_id": "iphone-01",
  "limit": 1,
  "cursor": {"start_seq":1200,"after":{"tablename":"archives","id":"A"}}
}
```

响应：

```json
{
  "start_seq": 1200,
  "data": [
    {"tablename":"history","id":"B","sync_version":4,"deleted":true}
  ],
  "next_cursor": null,
  "has_more": false
}
```

data 为 Record 数组，按 `(tablename, id)` 的 BINARY 主键顺序排列，后续页严格大于 after。包含 tombstone，不过滤自身。每页 start_seq 保持不变；next_cursor 仅在有后续页时返回对象，否则为 null。

空库返回 start_seq=0、data=[]、next_cursor=null、has_more=false。合法游标超出最后一个主键时返回空末页，不要求 after 对应的记录仍存在。结构损坏、类型错误或 start_seq 越界返回 INVALID_CURSOR；start_seq 过期返回 FULL_SYNC_REQUIRED。

同一游标重试不保证内容字节相同，因为返回当前状态；客户端按版本应用。首次请求重试可能获得新 start_seq，必须将新首个响应作为新下载起点，不能混用两轮暂存数据。

### 7.4 下载后的补拉

1. 暂停该设备上传，先解决未确认写请求；其他设备可继续写入。
2. 保存首次 start_seq，将每页数据与 next_cursor 事务性写入本地暂存区。
3. 收到下载末页后，以 start_seq 开始补拉：

```json
{"device_id":"iphone-01","seq":1200,"limit":100,"include_self":true}
```

4. 将 changes 应用到暂存区并保存补拉 next_seq，重复至 has_more=false。
5. 本地事务切换云端镜像、保存最终游标，保留独立的待上传操作。
6. 恢复普通同步和上传；普通同步携带最终游标以确认正式位置。

补拉必须包含自身记录，否则暂存区可能漏数据。下载期间新插入在已翻过主键位置之前的记录，也依靠补拉恢复。

任一步遇到 FULL_SYNC_REQUIRED，重新建立暂存区并从首个下载请求开始；服务端不为下载无限保留日志。该流程保证最终收敛，不提供跨记录固定时点快照。持续写入或日志清理可能延长恢复，不能将未补拉完成的数据标记为完整同步完成。

## 8. 错误码与恢复

### 8.1 接口级错误

| HTTP | code | 含义与处理 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 请求结构、字段或分页上限错误；修正请求 |
| 400 | INVALID_CURSOR | 游标类型、结构或上界错误；检查本地游标，必要时重新下载 |
| 401 | UNAUTHORIZED | 主密钥缺失或无效；检查配置 |
| 403 | DEVICE_DISABLED | 设备已禁用；经设备管理重新启用 |
| 404 | DEVICE_NOT_FOUND | 同步/写入设备未注册，或 PATCH 目标不存在 |
| 404 | NOT_FOUND | 路径不存在 |
| 405 | METHOD_NOT_ALLOWED | 路径存在但方法错误；响应附 Allow |
| 409 | REQUEST_SEQ_REUSED | 相同编号被用于不同正文 |
| 409 | REQUEST_EXPIRED | 编号小于最后完成编号，原结果已不保留 |
| 409 | REQUEST_OUT_OF_ORDER | 编号跳跃，先解决上一请求 |
| 410 | FULL_SYNC_REQUIRED | 所需日志已清理；执行完整下载 |
| 413 | PAYLOAD_TOO_LARGE | Worker 可识别的请求/存储平台大小限制；不截断数据 |
| 415 | UNSUPPORTED_MEDIA_TYPE | 请求体不是 application/json |
| 429 | RATE_LIMITED | 请求过于频繁；如有 Retry-After 则遵循 |
| 429 | D1_READ_QUOTA_EXCEEDED | D1 每日读取额度已用完；停止自动重试，UTC 00:00 重置或升级套餐 |
| 429 | D1_WRITE_QUOTA_EXCEEDED | D1 每日写入额度已用完；停止自动重试，UTC 00:00 重置或升级套餐 |
| 507 | D1_STORAGE_QUOTA_EXCEEDED | D1 账户存储额度已用完；释放空间或调整账户额度，不按日重置 |
| 507 | D1_DATABASE_SIZE_EXCEEDED | 单个数据库容量已满；释放空间或拆分数据，不按日重置 |
| 500 | INTERNAL_ERROR | 未分类错误；写入结果不确定时原样重试 |
| 503 | DATABASE_UNAVAILABLE | 数据库暂不可用；退避并原样重试写请求 |

额度分类依据 [Cloudflare 官方 D1 错误文本](https://developers.cloudflare.com/d1/observability/debug-d1/)，兼容 `Error.cause`。每日额度错误附带到下次 UTC 00:00 的 `Retry-After` 秒数；不能将未知 DATABASE_UNAVAILABLE、CPU/内存/超时错误猜测为额度不足。

**流式下载错误**：`/v1/sync`、`/v1/full-download` 可能已发送 HTTP 200 后才遇到额度限制，此时 JSON 以顶层 `error: {code,message}` 结束，并省略成功游标与 `has_more`。客户端必须先检查顶层 error，再处理任何 data/changes；整页失败，不提交已返回的数据或推进游标。未知流式故障仍中断响应。额度恢复后重试应保留原游标及原样未确认写请求。

鉴权优先于设备状态与写结果重放。请求结构校验通过后才处理幂等编号。批量同键重复使用 INVALID_REQUEST，不写任何记录。

平台直接拒绝、连接中断和超时可能没有标准 JSON 响应。客户端不能仅凭 5xx 推断写入未提交：一律原样重试未确认批次。不能通过换编号重发避免错误，因为这可能重复执行 forced 操作。

### 8.2 批量业务错误

这些 code 出现在 HTTP 200 的 results 项中：

| code | 条件 | 返回状态 |
| --- | --- | --- |
| ALREADY_EXISTS | 普通 create 遇到存活记录 | 当前 sync_version、deleted=false |
| ENTITY_NOT_FOUND | 普通 update/delete 或 forced delete 的目标不存在或已删除 | 不存在时省略状态；tombstone 返回版本与 deleted=true |
| VERSION_CONFLICT | 普通 update/delete 的存活目标版本不匹配 | 当前版本与 deleted=false |

确定的失败结果同成功结果一起缓存并消耗 request_seq。用户解决冲突后，以新请求编号提交新意图，不修改已完成批次。

## 9. 客户端接入顺序

1. 保存 Worker 地址和主密钥，为本安装生成独立 device_id 并注册。
2. 新的本地镜像执行完整下载及恢复补拉；已有可信游标则普通增量同步，过期转完整下载。
3. 本地修改持久化为待上传操作，记录当时的 base_sync_version。
4. 选取最多 10 个不同主键，持久化 request_seq 和原始 JSON 正文字节，再发送 write。
5. 本地事务逐项处理结果；成功清除对应待上传项，失败保留供用户解决。
6. 普通同步逐页应用云端状态并保存游标；同设备所有同步任务串行执行。

设备请求编号、增量游标、复合主键下载游标是三种不同状态，不得互相替代。服务端数据已删除时，客户端必须应用 tombstone，不能用旧 update 自动复活。

## 10. 文档范围与实施验证

本文确定公开 HTTP 契约。实现验收覆盖所有请求示例、字段边界、混合结果、幂等并发、GC 竞态与恢复分页，并在 D1 上验证索引查询的实际读取行数。SQL 带 LIMIT 不构成禁止全表扫描要求的充分证明。

日志使用有界检查点清理，无需全表计数，详见 [实现说明](IMPLEMENTATION.md)。远端读取计费与性能尚待部署验收。
