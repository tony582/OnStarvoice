# E0：执行契约与验收基线目录

观察日期：2026-09-05。状态：源码入口和验收规格已盘点；完整 golden payload、实机、性能和长期验证待执行。本文件不是通过证书。

下列行号引用 `main@51896d8694c4b19e3731e5b6b7623397420c84a9`。本机 0.4.5 对应源码 `85f8d797358e5aa2acf4db51ff1b3c57abe6c594`；E1 前须在已归并基线上重取调用点和验收证据，不沿用旧行号当作运行事实。完整差异见 [R0](R0-evidence-and-provenance.md)。

## 1. 四种上下文分别管理

| 对象 | 现有入口 | E1 保持的语义 |
|---|---|---|
| 诊断上下文 | `utils/task-context.js:6–7,102,114,122,138,152` | Map/lastTaskContext 按类型/功能选择；序列化 task/correlation；显式传参按调用方逐步迁移 |
| 本地持久采集 session | `utils/capture-sync.js:140`、`background.js:14029` 起 | begin/update/register-tab/end 消息和 session 归属 |
| Sidebar native owner | `utils/capture/task-owner.js:10,17` | owner 端口、bind/unbind/canceled、10秒断连宽限；不同于点击停止时限 |
| 云任务/Attempt/无人值守请求 | `sidebar/sidebar-logic.js:16606,16901,18842–18855,19583` | 精确 cloud lineage、稳定 `unattended-capture:${requestId}`、旧 Attempt 晚到不得覆盖新执行 |

E1a 暂定目标为 `utils/execution/context.js`。先定义关联字段及校验，再迁移 API、诊断、content、capture-sync、Sidebar。不能把四种生命周期归并为一个全局“当前任务”，也不能把诊断 taskId 直接当服务器任务主键。

同一 `taskType:featureKey` 再次启动、未命中 fallback、旧 complete 删除新任务、不同 module realm 是优先补测场景。目前未取得这些场景的专项行为通过证据。facade 调用迁移并验收之前不删除旧入口；独立实现完成时再确认旧模块退出交付包。

## 2. 消息、存储和 API 冻结目录

| 类别 | 源码入口 | 固定内容及需补样例 |
|---|---|---|
| 常规消息 | `utils/constants.js:115` | single note、blogger、keyword、comments、relay/progress、cancel；补成功/拒绝/迟到样例 |
| 持久 session | `utils/capture-sync.js:140` | `onstarvoice:begin-capture-task`、`onstarvoice:update-capture-task`、`onstarvoice:register-capture-task-tab`、`onstarvoice:end-capture-task` |
| owner | `utils/capture/task-owner.js:10` 起 | `osv.capture.sidebar-owner.v1`、`capture-owner:bind/unbind/canceled`；只解绑精确 owner |
| 执行锁与控制键 | `background.js:50,71,125–137` | captureExecutionLock、cloudCommandResults、Agent状态、checkpoint outbox v2、closure evidence v2、stop confirmation v1；2分钟租约及续租 |
| 存储键/状态 | `utils/constants.js:34,43,55,64,98` | auth/runtime/target/capture/sync/monitor、data_pool、sync_history、taskLedger、计划/请求/归档/诊断；区分 canceled/needs_action/completed_with_failures |
| 队列与账本 | `utils/storage.js:145,830,849` | 模块 Promise 队列不等于跨文档事务锁；账本兼容读取及租户/Agent范围 |
| HTTP同步 | `utils/constants.js:145`、`utils/api.js:463,490,513,519` | verify、sync、sync/batch、sync/captured；Agent token选择条件；已采查询失败降级 |
| 云执行 | `utils/cloud-task-agent.js:1344,1353,1360` | heartbeat/liveness/command completion、准确任务身份及幂等完成 |

`/api/sync/batch` 每条现有字段包括 `recordId/syncType/platform/workflow/monitorExecutionId/captureTaskId/captureTaskItemAttemptId/captureTaskItemRequestHash/payload`。新内部接口不能悄悄改名或丢弃字段，也不能把诊断ID写成业务Attempt ID。

完整 E0 golden 制品应从已归并的精确源码/测试夹具取得每个入口的请求、响应、状态转换、错误/取消分支及脱敏存储快照，记录来源提交和预期；动态ID/时间使用固定fixture或明确规范化规则。不保存真实激活码、Bearer token、客户正文或账号会话。本次只建立目录，没有编造成功payload。

## 3. 行为验收矩阵

“已有入口”仅说明仓库存在相关测试，不表示本次已执行或覆盖完整场景。CI复用现有套件也不能替代真实平台。

| 编号 | 场景及验收点 | 已有测试入口 | 本批状态 |
|---|---|---|---|
| B01 | 手工单条/博主/搜索：实际启动才建session、一位owner、finally结束；无session保持兼容 | `tests/capture/sidebar-capture-task-wiring.test.mjs`、`tests/capture/capture-task-session.test.mjs` | 实机待验 |
| B02 | 云端/定向：URL/task/Attempt/requestHash一致；旧进度/结束不覆盖新Attempt；完成有业务结果 | `tests/cloud-task-agent.test.mjs`、`tests/capture/sidebar-capture-task-wiring.test.mjs` | 完整golden/实机待验 |
| B03 | 无人值守：XHS页面接管、抖音工作页替换、搜索证明复用；技术恢复预算保持 | `tests/capture/sidebar-capture-task-wiring.test.mjs` | 实机及多轮待验 |
| B04 | 页丢失/替换：登记worker后导航、只恢复原目标、不借用用户网页 | `tests/capture/capture-task-worker-order.test.mjs`、`tests/capture/capture-task-session.test.mjs` | 故障注入/实机待验 |
| B05 | 停止：精确request取消、旧owner不影响新任务；存储失败仍清理，回收失败可重试 | `tests/capture/task-runtime.test.mjs`、`tests/capture/task-owner.test.mjs` | 时序/实机待验 |
| B06 | 恢复：部分评论保留、旧END不清新状态、用户停止/平台验证不自动复活 | `tests/capture-recovery.test.mjs`、`tests/capture/capture-task-session.test.mjs` | 真SW挂起/重启待验 |
| B07 | 同步：丢响应重试幂等；cancel后不重排新任务；在途结果结算；captured/uploaded/excluded分开 | `tests/capture/record-sync-queue.test.mjs` | 真实API/数据库闭环待验 |
| B08 | 容量：活动/未同步/失败/归属不明不删，无安全清理候选时暂停接收 | `tests/storage-pressure.test.mjs` | quota/长正文压力待验 |
| B09 | 同类型双任务、fallback、旧complete、跨realm，不串日志/保存/取消对象 | 未取得完整专项行为证据 | E1a优先补测 |
| B10 | 包资源、授权/租户切换、Chrome/Edge停止恢复、微博已有入口回归 | `tests/capture/extension-snapshot.browser.mjs` | 隔离Chromium不能代表真实全平台 |
| B11 | 回滚：旧包读取候选同格式数据、保留未提交结果、不复活停止任务 | 未取得完整覆盖证据 | 发布前验证 |

资源回收依据 `utils/capture/task-runtime.js:124,158,169,173`：释放debugger、关闭登记worker、释放原生组；关闭失败保留后续回收所需ownership。0.4.5已有debug可选/任务生命周期修复，E-base后需重验。

取消不能简化成“停止后所有同步一律丢弃”：阻止新采集和业务轮次，保留已本地确认数据；区分待提交、在途、服务端已接受但响应丢失，按既有幂等/身份检查结算。用户停止不撤回服务器已接受结果，迟到确认不能覆盖取消或后续Attempt终态。

## 4. 性能目标与采样（全部待测）

| 指标 | 后续目标 | 最低证据要求 |
|---|---|---|
| 复制诊断 | 1,500条数据池≤1秒 | 固定代表正文/评论字节规模至少30次，记录每次/最大值；不能只建空记录 |
| 50条启动预处理 | ≤2秒 | 相同数据集至少30批，包含必要读取与最终提交 |
| 小红书确认0评论到下一条真开始 | 含现有正常2–5秒等待后P95≤6秒 | 至少100个可判定样本，nearest-rank P95；所有异常/无下一条样本单列原因，不静默删样本 |
| 抖音确认0评论到下一条真开始 | 固定现有防风控等待，与稳定包同负载比较额外开销 | 至少100个可判定样本；等待和存储/交接开销分别记录，不使用小红书6秒目标缩短抖音等待 |
| 停止UI | 100ms反馈、3秒本地停止 | 至少30次，含拥塞/消息不回；本地停止不等于远端或worker均已回收 |
| 关闭面板 | 本地直接响应 | 不等待网络/存储/清理，其他入口仍能看到资源回收进度 |
| 长期运行 | Chrome/Edge各8小时无持续单向内存增长，再做72小时验证 | 固定任务负载、版本和采样/静置窗口；同负载对比稳定包；运行前冻结量化斜率/峰值界限 |

每条关联task/Attempt/requestId和六段时间：上一条完成、等待存储队列、记录保存、页面标记、防风控等待、下一条开始。先定义同一时钟/跨页对齐和日志开销，不能因计时逐条阻塞提交。

这些是目标而非当前性能结论。验证码、网络故障、无后续任务分类报告，同时保留完整业务成功率与可比较延时样本。平台变化与架构故障分别归因。既有客户每日重启操作不因本计划自动取消。

## 5. 测试和交付隔离

- 原 `OnStarvoice-2` 有用户修改，本批不在那里构建、测试、格式化或同步。
- `scripts/check-extension-snapshot.zsh:8` 会重建 `extension-build`；`server/package.json` 的 `npm test` 先执行它。本批本地用只读审计、文档校验和仓库卫生检查。
- GitHub CI在临时checkout执行现有套件，生成临时快照；本批没有改CI或新增发布步骤，结束后保持Draft。
- 后续真实验收使用专用Profile/测试租户，不能复用客户Agent身份、local storage或PM2。模拟测试拦截意外生产请求；真实平台采集另按明确测试范围执行。
- 源码正则测试只验证部分结构；重构需补行为测试，不能只改正则使CI绿色。`docs/extension-maintenance-handoff.md`亦说明静态检查不能代替真实账号、验证介入和长期无人值守。

## 6. E0 完成清单

- [x] 固定架构基点、本机交付副本与逐文件哈希。
- [x] 本机0.4.5对应源码95/95一致，列出main的9个差异。
- [x] 盘点消息、存储、身份/取消入口与测试目录。
- [x] 记录兼容边界、性能目标、实机与回滚要求。
- [ ] E-base归并后重新冻结完整请求/响应/存储golden。
- [ ] 真实Chrome/Edge、代表平台场景和业务结算通过。
- [ ] 故障注入、量化性能、8/72小时验证通过。
- [ ] 客户实际版本/发布来源和回滚演练通过。

只有前四项在本批完成，其余继续作为后续候选/发布条件，不用常规CI代替。
