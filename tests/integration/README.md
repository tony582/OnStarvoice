# StarVoice 集成测试约定

此目录只承载真实边界测试。隔离 PostgreSQL 用例由专用 Runner 执行；不应依赖数据库的 HTTP `*.test.mjs` 在不可达本地测试库保护下纳入默认 Node 回归。

## PostgreSQL

- 测试文件放在 `tests/integration/postgres/*.integration.mjs`。
- 只能通过 `TEST_DATABASE_URL` 显式指定隔离数据库。
- 数据库主机必须是 `localhost` 或 `127.0.0.1`，数据库名必须以 `onstarvoice_ci` 或 `onstarvoice_test` 开头。
- Runner 会令 `DATABASE_URL=TEST_DATABASE_URL`、`NODE_ENV=test`、`ALLOW_RESET_MIGRATIONS=0`；两者冲突时直接拒绝运行。
- Runner 不创建、不删除数据库。CI 使用临时 PostgreSQL Service；本地数据库的创建和清理由开发者明确执行。
- 禁止使用生产连接串、生产快照或包含客户数据的恢复库。

本地运行示例：

```bash
TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/onstarvoice_test \
  npm --prefix server run test:integration
```

## HTTP

HTTP 集成测试放在 `tests/integration/http/`。P2-A1 已提取 `createApp()` 并加入首批无数据库用例，后续用例必须继续满足：

- 测试导入无监听、无 Cron、无迁移、无回填副作用的 `createApp()`，禁止导入即启动的 `server/index.js`；
- 使用系统分配的临时端口；P2-A1 已覆盖认证/租户拒绝路径、404、500 和当前健康端点，readiness 及成功租户隔离留待后续阶段；
- 需要数据库的 HTTP 用例继续使用上述 `TEST_DATABASE_URL` 保护；
- 不调用真实 AI、SMTP、外部媒体或客户浏览器。

当前入口与覆盖范围见 `tests/integration/http/README.md`。任何需要 PostgreSQL 的 HTTP 用例都不得绕过上述连接保护。
