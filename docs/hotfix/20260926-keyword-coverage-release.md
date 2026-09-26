# 关键词节点覆盖不再无证据放行停止保护（17351b2）发布记录（20260926）

分支 `codex/release-keyword-coverage-20260926`，基线 `17098ed`（生产，`codex/release-hotfixes-20260926`，2026-09-26 11:37:23 上线），只加一个提交 `b986d71` = `17351b2`（`cherry-pick -x`，无冲突）。只换一个服务端文件，无迁移，不动 Admin 和扩展。

## 内容

固定分配（each_agent）批次里，关键词节点覆盖逻辑把某节点“需要处理”的子任务置为 `superseded` 时，会用新的覆盖错误码覆盖原错误码。原错误码如果是 `PREVIOUS_CAPTURE_STOP_UNCONFIRMED`，停止保护就在没有任何“旧页面已停止”证据的情况下消失，节点被放回来接任务。修复后保留停止保护码，覆盖原因写在旁边（`coverageReason`、`coverageMessage`）。节点没有响应、但本身被停止保护挡住时，覆盖原因写 `keyword_node_stop_fenced`，不写 `keyword_node_no_response`。

之前一直不发，是因为节点要能自己证明旧页面已停（0.4.16 起的 `previousCaptureStopCheckV1`）。0.4.17 已于 11:37 发布，用户确认各节点已更新，遂发布。

## 验证（Node 18.20.8）

| 检查 | 结果 |
|---|---|
| `tests/keyword-node-coverage.test.mjs` | 7/7；换回生产文件为 6/7 |
| `keyword-account-coverage.integration.mjs` | 21/21；换回生产文件为 19/21 |
| PostgreSQL 集成全套（50 个文件，`--test-concurrency=1`） | 390/390 |
| 单元回归全套 | 2773 项，2765 通过，8 失败，全部是已知的环境失败（缺 `typescript` 的 Admin 测试和缺 `extension-build/` 的一个文件），在基线上相同 |

## 发布包

目录 `/opt/onstarvoice-private/releases/keyword-coverage-b986d71-20260926`。

| 文件 | SHA-256 |
|---|---|
| `server.tar.gz`（仅 `server/services/keyword-node-coverage.js`，ustar，root 属主） | `b2aa5d0884f0718d8f86f615483992d432978721b81a1dda1405e7e63025b82b` |
| `deploy.sh` | `b554c40d3cab59a5919fdaf97633467528d6bf6b8a587dd1a35d649aac011350` |
| `keyword-node-coverage.js` | 生产现值 `dbc0f177…` → `8525fa2228e98101a9c48b3ffe5566a3b07eb50154f3a3a3c7b082896195c188` |

`deploy.sh` 沿用 09-26 发布包的结构。

- **部署前检查**：替换文件及其依赖（`services/capture-cloud.js` `003e42cb…`、`routes/capture-cloud.js` `3be625a2…`）为 `17098ed` 现值；PM2 在线；`health/ready` 通过。
- **能力闸口（只读 SQL）**：最近 7 天活跃的非手机节点必须都声明 `previousCaptureStopCheckV1`。`ACCEPT_UNCAPABLE_NODES=N` 允许运营接受至多 N 个列出的节点，超出仍拒绝。
- **切换**：tmp + mv 替换一个文件，`pm2 restart onstarvoice`。
- **部署后检查**：30 秒内 ready，live，进程确实重启且解释器版本不变，磁盘文件为新值。
- **自动回滚**：任何失败或信号都恢复旧文件、重启并等 ready。

## 上线（2026-09-26）

- **部署前两次 `--check`（18:5x、19:0x）**：文件与依赖哈希一致，服务 ready。最近 7 天活跃浏览器节点 18 个：0.4.17 17 个，0.4.12 1 个。闸口列出 2 个节点：
  - `Edge · macOS 0.4.12`：09-23 20:03 后未再上线，是旧登记记录。西瓜的 Edge 是另一条记录，已是 0.4.17。
  - `Chrome · macOS 0.4.17`：版本号已更新（认证路径会写 `app_version`），但能力清单尚未由完整心跳刷新。
- **部署**：Claude 的自动模式拦截了生产部署，由用户在本机终端执行 `ACCEPT_UNCAPABLE_NODES=2 bash deploy.sh`。此时闸口只剩 `Edge · macOS 0.4.12` 一个（Chrome 那条已由完整心跳刷新），1 ≤ 2，继续部署。
- **结果**：19:13:05 重启，新 PID 469496（Node 18.20.8），部署后检查全部通过，`health/ready` 为 `{"ok":true,"status":"ready","role":"all"}`。
- **回滚**：发布目录 `backup/server/services/keyword-node-coverage.js` 为旧文件；换回后 `pm2 restart onstarvoice`。
- **待补看**：部署后错误日志是否有新增、节点心跳是否正常（本次执行人的生产只读查询被本地权限拦截）。

## 上线后注意

- 此后被覆盖逻辑置为 `superseded` 的子任务如果带停止保护码，会保留它；节点由 0.4.17 自检证明旧页面已停后自动解除，或在后台「确认旧页面已停止」。
- `Edge · macOS 0.4.12` 这条旧记录若再次上线并遇到停止保护，只能人工确认。建议在后台「执行节点」停用该记录。
