# Cloudflare D1 Sync

一个面向单用户、自托管场景的离线优先同步服务。Cloudflare Worker 负责主密钥鉴权、字段校验、乐观并发控制和完整同步；D1 保存业务实体、墓碑、全局变更流水与幂等结果。

业务表定义见 [DOMAIN_TABLES.md](./DOMAIN_TABLES.md)，客户端原始结构见 [db.sql](./db.sql)。Worker 同步 14 张业务实体表；本地附属表折叠到父实体的 JSON 字段，本地专用表和 WebDAV 凭据不上传。

当前数据库结构版本为 2。`0002_domain_tables.sql` 会删除研发阶段的 `bookmarks/settings` 示例数据及旧同步历史，保留已绑定设备；已有客户端需丢弃旧游标和待重试的示例批次，重新完整同步。

## 特性

- 一个 256-bit `MASTER_KEY`，无账号系统、无第三方服务。
- create / update / delete / upsert 与最多 8 个 operation 的原子批次。
- `sync_version` 乐观并发控制、`change_seq` 增量游标、删除墓碑。
- `batch_id` + `op_id` 请求幂等，网络超时可原样重试。
- 固定高水位完整同步，不会向客户端暴露跨表半完成状态。
- 每小时清理一年前或超过 5000 行的历史、幂等记录和墓碑。
- 浏览器本地密钥生成页，不保存、不上传密钥。

协议与实现约束见 [PROJECT_SPEC.md](./PROJECT_SPEC.md)，业务表唯一来源见 [DOMAIN_TABLES.md](./DOMAIN_TABLES.md)，完整 HTTP 参考见 [docs/API.md](./docs/API.md)。

## 一键部署

部署按钮必须指向公开的 GitHub 或 GitLab 仓库。发布本仓库后，将下面的 `YOUR_USERNAME` 替换为仓库所有者；GitHub Pages 引导页会在 Actions 构建时自动使用真实仓库地址。

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USERNAME/cloudflare-d1-sync)

部署流程会依据 `wrangler.jsonc` 自动预配 D1，并依据 `.dev.vars.example` 提示输入 `MASTER_KEY`。`package.json` 的部署脚本会先应用迁移，再发布 Worker。

1. 打开 `docs/index.html` 或已发布的 GitHub Pages，引导页会用 `crypto.getRandomValues()` 生成 64 位小写十六进制主密钥。
2. 立即保存到密码管理器，然后点击 Deploy to Cloudflare。
3. 在部署表单中把生成值填入 `MASTER_KEY` Secret。不要把密钥提交到仓库。
4. 部署完成后访问 `GET /v1/health`，再通过 `/v1/devices/bind` 绑定第一台设备。

## 本地开发

要求 Node.js 22 或更高版本。

```bash
npm ci
cp .dev.vars.example .dev.vars
# 把 .dev.vars 中的 MASTER_KEY 换成 64 位小写十六进制值
npm run db:migrate:local
npm run dev
```

生产 Secret 使用交互式命令设置，密钥不会出现在命令参数或 shell 历史中：

```bash
npx wrangler secret put MASTER_KEY
```

## 验证

```bash
npm run check
```

该命令检查 Wrangler 生成类型、TypeScript、无浮动 Promise 的 lint 规则、Workers Runtime + D1 集成测试和部署构建。

## 最小客户端调用

```bash
curl -X POST "https://YOUR_WORKER.workers.dev/v1/devices/bind" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "X-API-Version: 1" \
  -H "Content-Type: application/json" \
  --data '{"device_id":"my-device","name":"My Device","platform":"macos","app_version":"1.0.0"}'
```

除 `/v1/health` 外，所有端点都要求 Bearer Token 和 `X-API-Version: 1`；除鉴权验证和设备绑定外，还要求 `X-Device-ID`。

## 安全边界

本项目是单用户方案。任意设备泄露主密钥都会导致整个实例失守；解绑设备不能撤销它已经持有的密钥。疑似泄露时必须替换 Worker Secret，并重新配置全部设备。客户端应将密钥存入系统安全凭据存储，绝不能写入业务数据库、URL、日志或错误报告。

## License

MIT
