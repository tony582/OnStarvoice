# HTTP integration tests

此目录验证 `server/app.js` 的真实 HTTP 边界。用例直接调用不负责监听、数据库
初始化和后台循环的 `createApp()`，由操作系统分配临时端口，不导入会立即启动
进程循环的 `server/index.js`。

`app.test.mjs` 当前覆盖：

- `/api/health` 存活检查与根路径重定向；
- 会话认证缺失与租户访问凭据缺失；
- 未知 API 的 404；
- 通过 `corsOrigins` 注入的 CORS 允许和拒绝；
- 未处理请求错误的 JSON 500 响应；
- 不可达本地测试库与非本地 HTTP 请求拦截，防止误用真实依赖；
- 通过注入 `logger` 隔离测试日志。

运行定向用例：

```bash
node --test tests/integration/http/app.test.mjs tests/server-app-factory-contract.test.mjs
```

需要 PostgreSQL 的 HTTP 用例仍必须使用隔离的 `TEST_DATABASE_URL`；不得连接生产库，
不得请求真实 AI、SMTP、外部媒体或客户浏览器。具体隔离规则见
[上级约定](../README.md)。
