# Cloudflare D1 云同步

单用户、自托管的 Cloudflare Worker + D1 通用 JSON 同步服务。后端已按新协议实现；GitHub Pages 提供部署引导和本地主密钥生成。

- [同步协议](同步协议.md)：数据模型、版本控制、分页及幂等语义。
- [API 文档](docs/API.md)：接口、请求响应、错误码及客户端接入流程。
- [项目规划](PROJECT_SPEC.md)：项目范围、主密钥及实现状态。
- [实现说明](docs/IMPLEMENTATION.md)：事务、查询边界、日志清理与验证范围。

## 本地开发

需要 Node.js 22 或更新版本。

```sh
npm ci
cp .dev.vars.example .dev.vars
```

在 GitHub Pages 引导页本地生成主密钥，填入 `.dev.vars` 的 MASTER_KEY。此文件已被 Git 忽略；不得提交真实密钥。

```sh
npm run db:migrate:local
npm run dev
```

默认本地地址为 `http://localhost:8787`。健康检查为 `/v1/health`；其余请求携带 `Authorization: Bearer <MASTER_KEY>`。本地开发和测试使用本地 D1，不连接远端数据库。

```sh
npm run check
```

该命令运行类型检查、workerd/D1 集成测试与部署打包检查，不发布 Worker。测试使用独立数据库和固定测试凭据，不读取个人密钥。

## 部署

本次重建使用全新的 D1 数据库，不支持将旧业务表数据库原地升级。新迁移不包含旧数据转换，也不会自动清空已有数据库。

GitHub Pages 的 Deploy to Cloudflare 流程可预配 DB，并要求输入 MASTER_KEY Secret。构建部署命令使用 `npm run deploy`，先按 DB binding 应用迁移，再部署 Worker。

手动部署时先创建新数据库：

```sh
npx wrangler d1 create cloudflare-d1-sync
```

将返回的 database_id 写入 `wrangler.jsonc` 对应 DB binding，然后执行：

```sh
npm run deploy
npx wrangler secret put MASTER_KEY
```

Secret 缺失时鉴权请求不会通过。设置完成后检查健康接口，再注册设备并验证写入与同步。D1 预配和 Secret 的一键部署行为依据 [Cloudflare 部署按钮文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)；本仓库本次只做本地验证，未执行远端部署或全新账号部署验收。

Cron 每分钟最多清理十个小页，每页最多删除 100 条过期 change。查询禁止全表扫描；完整下载按主键索引逐页读取，每页最多 100 条，写请求最多 10 条。data 与 tombstone 不自动删除。
