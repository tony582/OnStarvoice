# 负面巡查卡在「正在核对巡查任务状态」hotfix（2026-10-07）

分支 `codex/hotfix-patrol-reconcile-livelock-20261007`，基线 `dd2b027`（= `main` = 生产服务端；生产的 `capture-stop-fence-release.js` 仍是 `bb53e44` 版，只比 main 多末尾一个空行）。发布 = `edbd48e`：扩展 0.4.23 + 服务端兜底。没有迁移、配置、Admin 或 Runner 改动。

## 现象

10-07 05:00 的「抖音~日常+负面巡检」批次 26 项，23 项正常完成，3 项卡住：

| 节点 | 下发 | 结果 |
| --- | --- | --- |
| Edge · Windows~月球 | 05:07:45 | 一直到 18:33:46 用户手动停止（「定向作品任务已在执行前停止」） |
| Edge · Windows~地球 | 05:11:47 | 11:34:58 才开始并完成 |
| Surface-Edge · Windows~土星 | 05:07:19 | 12:36:11 才开始并完成 |

执行页显示「页面响应较慢 已运行 06:0x:xx 0%」，顶部反复弹「正在核对巡查任务状态，确认后会自动继续」。服务端三条子任务一直 `pending`、`started_at` 为空；创建指令 05:07–05:13 已被心跳快照对账成 `completed`（`task_snapshot_observed`）。节点心跳全程正常。节点本地任务中心 10 分钟后把这条记成 `stale_task_heartbeat_timeout`，但执行页没被收掉。10-05 月球同样卡过：05:11 下发，10:33 才开始。

nginx 访问日志：同一台 Windows 机器（39.144.x.x，地球和月球）的心跳从 05:10 起由每 10 分钟约 60 次升到约 210 次。全部是 200，持续到 18:3x 才回落。10-05 那次也是同样形态，10:33 巡查开始后立刻回落。

## 根因

### 扩展：对账活锁

负面巡查开跑前，执行页要先发 `onstarvoice:reconcile-targeted-post-run-state`。后台要完成一次完整同步（`syncCloudTaskAgent({force: true})`）才算对账成功。

- 如果此时已有同步在进行，`syncCloudTaskAgent` 立即返回 `sync_in_flight`，同时置 `cloudTaskAgentSyncPending`，等当前同步结束后再接一次强制同步。
- 执行页拿到失败后弹提示，5 秒后重试。
- 单次同步超过 5 秒时（这几台 Windows 节点约 5–6 秒），每次重试都落在某次同步中间。每次重试又续上下一次同步，于是同步首尾相接，心跳每次都成功，执行页却永远拿不到「对账完成」。
- 进入循环的起因：05:07 左右服务端繁忙（前一晚和当天凌晨多次 `Database general capacity is temporarily unavailable`，05:01–05:06 的关键词任务也报状态上报超时），那几次同步特别慢。之后同步只要还长于重试间隔，循环就一直维持。
- 偶尔一次重试恰好落在两次同步之间时会自行解开，地球和土星就是这样跑完的。

这段代码是 0.4.6（9 月初）引入的，不是最近的改动。

### 服务端：没有任何兜底

节点心跳快照一出现这条任务（本地状态 `pending`），`resolveCreateCommandFromSnapshot` 就把创建指令记成 `completed`，3 分钟的创建确认超时（`expireStaleCommands`）从此不再管它。`reconcileElasticCaptureLeases` 只回收节点离线 10 分钟以上的子任务。所以「已确认、没开始、节点在线」的巡查没有任何超时，还一直占着：

- 这台节点的执行位，节点领不到别的活；
- 这个帖子的巡查租约，其它批次会把它当成「正在处理」。

## 修复

### 扩展 0.4.23（`7c3c9e2`）

| 位置 | 改动 |
| --- | --- |
| `background.js` `syncCloudTaskAgent` | 每次真正开始的同步分配序号 `cloudTaskAgentSyncSeq`，并带一个结束信号 `cloudTaskAgentSyncSettled`；`finally` 里记下 `{seq, result}`（抛错时记 `sync_failed`） |
| `background.js` 新增 `syncCloudTaskAgentAfterRequest` | 返回一次「在本次请求之后开始」的同步结果。已在进行的同步只等不算（它可能在请求之前就读了本地和服务端状态）。没有同步在跑就自己发一次强制同步。等待先前同步最多 30 秒，超过仍返回 `sync_in_flight` |
| 对账消息处理 | 改用 `syncCloudTaskAgentAfterRequest`。服务端失败、退避中（`failure_backoff`）仍判未对账，不开跑 |
| `sidebar-logic.js` | 执行页开跑前这一条对账消息的等待上限改为 90 秒（`TARGETED_POST_RECONCILE_MESSAGE_TIMEOUT_MS`）；侧栏初始化时的展示用对账和其它控制消息仍是 12 秒 |
| `syncCloudTaskAgent`（复审修复 `9b53187`） | 「同步进行中」标志、序号和结束信号改在读凭据（一次 `chrome.storage` 调用）之前同步置好；没有凭据时也从同一个 `finally` 返回。原先标志在读凭据之后才置，被同一次同步唤醒的多个等待者和待同步链会在这段时间里各自开一次完整同步，原有的「同一时间只跑一次同步」就不成立了 |

### 服务端兜底（`3798159`）

`reconcileElasticCaptureLeases`（cron 每分钟）的候选和加锁复查都加一个分支：`negative_post_patrol` 子任务仍为 `pending`、`started_at` 为空、下发超过 15 分钟（`NEGATIVE_PATROL_START_TIMEOUT_MIN`），且没有未完成的指令。

- 写法沿用现有「节点在线」分支：子任务 `failed`，`terminalDisposition = superseded`；错误码和 `terminalReason` 用新码 `negative_patrol_start_timeout`；工作项投影为 `retryable`；事件 `elastic_work_item_requeued` 带 `startTimeoutMinutes: 15`。
- 新码加入 `ELASTIC_STALE_TASK_CODES`，也加入 `mirrorTaskSnapshot` 的迟到快照防线：卡住的旧运行页再上报，不会改写这条子任务。被拦下的快照也不会进入巡查结果投影，不会给帖子记失败或冷却。
- 卡住的节点下一次心跳收到「已由其它节点接力」（superseded）终止通知并确认。**确认时不再把这条工作项投影成 `canceled`**。原逻辑会无条件投影，节点在线时确认几乎立刻到，帖子会在别的节点接手前被取消。这一条只针对新码。
- 该码计入弹性重试预算，与离线超时一致；不加冷却。

**已知同类风险，没有改：** 离线超时退回（`elastic_agent_offline_timeout`）在节点回来确认通知时，也会把还没被别的节点接走的工作项投影成 `canceled`。

**独立复审指出、留作选项的缺口：**

- 还没升级的 0.4.22 慢节点被收回一条后，会立刻再领一条新巡查，可能再卡 15 分钟，每次消耗该帖一次重试预算。新码的节点暂停时间是 0，和其它「任务心跳中断」类一致。可选做法：对新码给节点 30–60 分钟不领负面巡查，或计为不扣预算。
- 只覆盖弹性池（`elastic_pool`）批次。后台手动派发的固定批次巡查（`fixed_batch`），以及被「创建指令过期」复活成 `claimed` 的子任务，不在这条兜底内。

### 版本（`323e05d`）

`manifest.json` 0.4.23，更新清单、更新日志页、`OPS_CONTROL_RUNTIME_BASELINE_VERSION` 同步。最低支持版本仍为 0.3.51。

## 验证

| 项目 | 结果 |
| --- | --- |
| `tests/background-capture-lock.test.mjs` 新增 3 项：执行页比一次同步更频繁地重试仍能对账；请求前已开始的同步不算数；服务端退避中仍不开跑 | 修复前前两项失败，形态与生产一致（连续 6 次 `sync_in_flight`）；修复后 3/3 |
| 复审后再加 2 项：同一次同步唤醒的多个等待者仍一次只跑一个同步（待同步链、两条执行页消息两种情形，存储读加 5 ms 延迟）；没有凭据时等待者正常结束 | 在 `323e05d` 上第一项失败（最多 2 个心跳并发）；修复后通过 |
| 两个原有测试（搁浅的负面巡查取消对账）写死 `2026-09-07T11:0xZ`，任务中心 30 天后清掉已结束记录，10-07 19:00 起在任何代码上都失败 | 改成一分钟前（`edbd48e`，只改测试）；其它写死日期的测试另开任务排查 |
| 新增 `tests/integration/postgres/negative-patrol-start-timeout.integration.mjs` | 真实下发 → 快照确认 → 14 分钟不动、16 分钟退回 → 卡住节点收到 superseded 通知并确认，工作项仍是 `retryable` → 另一节点接走。对照：已开始的、创建未确认的都不动。基线代码上第一项失败（不退回）；只去掉确认那段改动时，工作项变成 `canceled`。修复后 3/3 |
| `tests/server-capture-cloud-contract.test.mjs` | 119/119（新增迟到快照防线与新分支断言） |
| 全量单元 `run-node-regression-tests.mjs` | Node 18.20.8、24.12.0 各 3260/3260（`edbd48e`） |
| 全量 PostgreSQL 集成 `run-postgres-integration-tests.mjs`（全新库，PostgreSQL 17，Node 18.20.8） | 511/511（`323e05d`；之后只改了扩展和测试） |
| 生产只读 `EXPLAIN ANALYZE` 新候选查询 | 走 `idx_capture_tasks_elastic_children_active` 与 `idx_capture_tasks_agent_slot_blocking`，74 ms（冷读） |
| 发布脚本在模拟生产目录（`dd2b027` 的 `server/` + 生产那份 `capture-stop-fence-release.js`，真实 Node 18 进程）上演练 6 种情形 | 预检通过；相关模块被改、替换文件被改、新安装包已存在都拒绝且不改任何东西；新进程起不来时恢复 4 个文件、删掉新安装包、服务恢复就绪；正常部署后更新清单 0.4.23、安装包按字节一致下载、更新日志页显示最新、未登录请求应答不变（401）；同一发布目录第二次运行被拒 |

发布包与演练脚本：`~/Documents/claude/releases/OnStarvoice-patrol-reconcile-20261007/`。替换 `server/routes/capture-cloud.js`、`server/routes/update-manifest.js`、`server/services/ops-control.js`、`server/public/about.html`，新增 `public-downloads/StarVoice-extension-v0.4.23-20261007.zip`。预检核对这 4 个文件和 33 个相关模块与生产一致。回退：恢复发布目录 `backup/` 里的 4 个文件，删除新安装包，重启。没有数据需要回退。

## 生效范围

- 服务端兜底部署即生效，未升级的节点也受益：卡住的巡查 15 分钟后会被改派，旧节点收到通知后停掉旧运行页。
- 对账修复要节点更新到扩展 0.4.23 并重载后才生效。
- 本机 Mac 节点跑的是主目录 `extension-build/` 快照，要另外同步。

## 部署（2026-10-08，用户本会话说「继续部署吧」）

| 时间 | 步骤 | 结果 |
| --- | --- | --- |
| 09:5x | 只读核对生产 | 进程 PID 650010（10-03 13:25:30 起，重启 38 次）；4 个要替换的文件和 33 个相关模块与预期一致，0.4.23 安装包不存在；没有运行中的任务，7 个待执行批次；近一小时 18 个节点在线。**地球 05:35 下发的负面巡查又卡住**（`pending`，4 小时多未开始），与 10-07 同一现象 |
| 09:5x | 上传发布目录 `/opt/onstarvoice-private/releases/patrol-reconcile-6ecdc04-20261007`，`SHA256SUMS` 核对，`bash deploy.sh --check` | 三个文件 OK；预检通过 |
| 09:56:09–09:56:17 | `bash deploy.sh` | 退出码 0；新进程 PID 771442（重启 39 次，Node 18.20.8），就绪；心跳、手机领取、云端概览三个路由对未带令牌请求的应答与部署前一致（401）；更新清单 0.4.23，安装包按字节一致下载，更新日志页显示最新 |
| 09:59:02 前后 | 兜底首次在线触发 | 地球那条子任务变为 `failed` / `negative_patrol_start_timeout` / `superseded`，工作项 `retryable`，批次由 `pending` 变 `running` |
| 09:59:07 / 09:59:23 | 地球心跳收到 superseded 通知（应答 461 → 787 字节）并确认 | 子任务 `superseded`；**工作项保持 `retryable`，没有被取消** |
| 09:59:51 | 改派 | 工作项派给 Surface-Edge · Windows~土星（第 2 次尝试）；10:00:01 土星快照显示已排队，10:01 仍未开始（同样是 0.4.22，大概率又进活锁），兜底会在 15 分钟后再改派 |

部署后：`main` 快进到 `6ecdc04` 并推送，本机主目录也快进；本机 `extension-build/` 由 0.4.22 同步到 0.4.23（与安装包只差 `background.js`、`sidebar/sidebar-logic.js`、`manifest.json` 三个文件），旧快照备份在 `.codex-release-backups/extension-build.rollback-v0422-before-6ecdc04-20261008`，各浏览器重载扩展后生效。

后续：土星（0.4.22）同样没开始，10:15:00 被兜底收回、10:15:52 改派月球；用户随后把六台 Windows 节点（地球、月球、土星、木星、火星、金星）都更新到 0.4.23（10:29 均以 0.4.23 心跳）。月球那条是升级前收到的，重载扩展时运行页被关闭，10:31 再次被收回；10:41 派给已是 0.4.23 的土星，10:41:27 开始，10:42 完成，共 4 次尝试，这个帖子当天的巡查最终完成。批次 25/26 完成，状态显示「已取消」是因为 07:31 地球的关键词「凯迪拉克车机升级」筛选后结果没加载（`INCOMPLETE_SEARCH_PASSES`）被取消，与本次修复无关。Mac 上的 Chrome 节点（上海、北京、成都、重庆）10:29 时仍报 0.4.22，需重载扩展。

## 线上排查（只读，需要点名主机）

```sql
-- 下发后迟迟未开始的巡查
SELECT t.id, a.display_name, t.status, t.created_at, t.started_at
FROM capture_tasks t JOIN capture_agents a ON a.id = t.assigned_agent_id
WHERE t.task_type = 'negative_post_patrol' AND t.status = 'pending'
  AND t.started_at IS NULL AND t.created_at < now() - interval '15 minutes';
-- 兜底触发记录
SELECT task_id, created_at, payload->>'timeoutCode'
FROM capture_task_events
WHERE event_type = 'elastic_work_item_requeued'
  AND payload->>'timeoutCode' = 'negative_patrol_start_timeout'
ORDER BY created_at DESC LIMIT 20;
```

还有一个信号：同一节点心跳从每 20 秒一次变成每 5–6 秒一次、且持续不降（nginx `access.log` 按 IP、按 10 分钟计数），基本就是这个活锁。
