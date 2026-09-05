# E1c：同步回执分类抽离与保存/确认边界盘点

日期：2026-09-05。隔离架构候选，只到 Draft；不是生产发布、同步故障修复或完整 Extension 重构完成。

## 基点与本轮边界

- 精确基点：E1b PR #41，`3973d476d1dd634fdbbd640bde4189e7a1f1988e`；新分支 `codex/extension-e1c-sync-response-classification-20260905`，以 #41 分支为 PR base。
- main 和 PR #37–#41 不修改；Cron 解耦 PR #37 仍独立保留，不静默并入或遗忘。
- 从 `utils/capture-sync.js` 原样抽离 10 个分类函数、2 个原因 Set 到 `utils/capture/sync-response-classification.js`；唯一依赖为 `ERROR_REASON`。
- 只导出已有调用需要的 6 个入口：batch/item reason 归一化、batch/item 限流判定、batch/item 不确定结果判定；4 个 helper 与 Set 保持私有。
- 不搬成功结果映射、getSyncBatchItems、请求循环、退避计算、计时器、队列、ACK 写入、客资补同步、auth 或存储实现；不更改任何规则、间隔、重试次数、并行度或状态格式。
- 允许差异为 2 个运行文件、2 个新增测试文件及本文档。background、sidebar、manifest、权限、版本、平台采集、服务端、数据库 schema 不变。

## 实际保存到确认的顺序

以下位置按精确基点 3973d47 盘点；“等待函数返回”不等同于对返回值或物理持久化的完整证明。

| 阶段 | 原代码边界 | 本轮保留的语义 |
| --- | --- | --- |
| 列表保存 | capture-sync:1818 saveRecordsWithCacheDedupe；:1917 setDataPool | 在 data-pool mutation 队列内重读、合并并等待保存；调用点对 false 返回的局限见后文 |
| 采集后同步 | captureAndSync:2438、:2572 | 先等待保存结果，再决定是否进入单条或批量同步 |
| 单条确认 | syncRecord:7422、:7448 | 等待请求，按既有 syncResult.ok 分支标记本地；不是本次分类抽离范围 |
| 批量确认归属 | syncGroupRecordsWithRetry:8705 | 按 data.items[].recordId 匹配当前分块；重复 ID 仍采用 Map 最后一项 |
| 批量成功判断 | buildSyncRecordResultItem:8968 | 只有 item.ok === true 是单项成功，不能由批次整体成功推断缺失项成功 |
| 暂停与继续 | syncGroupRecordsWithRetry:8712–8806 | 顶层限流优先暂停；单项限流/结果未知留待继续；隔离重项继续规则原样不变 |
| 本地提交后记进度 | applySyncRecordResultItem:9011；调用:8776 | await 成功/失败写入后，才加入 groupResults 并报告已处理进度；false 返回与抛错不是同一语义 |

`ok === true` 的严格判断、item/batch HTTP 字段优先级、truthy 字段先选后 trim、限流优先于不确定、全部 reason 与文本匹配规则保持原样。本文是现状契约，不把旧规则描述为新设计。

## 本轮未修复的存储确认局限

1. `utils/storage.js:145–161` 的 dataPoolMutationQueue 只串行化当前 ESM 实例，不是多页面/多上下文全局事务。getDataPool 的重复 ID 修复、直接 setDataPool / clearDataPool 不自行进入此队列。
2. `storage.js:1092` 的 markRecordSynced 仅凭 recordId 调用 updateRecord，没有显式 Attempt、record revision 或 tenant CAS。不能据此证明迟到正文回执/切换租户/多上下文更新安全；本次也没有证明生产已经因此丢失数据。
3. `storage.js:965` 的 updateRecord 在记录不存在时返回 false，真正写失败抛错；applySyncRecordResultItem 没有检查 false。列表去重保存也只 await setDataPool，没有检查其 false 返回。后续应分别设计保存成功证明与确认提交条件，不在搬移代码时顺手改变。
4. lastSyncedAt 不是单独的成功证明，失败标记也会写它。现有容量回收要求 synced、超过保留期且不处于活动 trace；不得放宽成按时间戳清理，更不能自动删未同步或失败记录。

background 的任务 closure/adoption/social-usage ACK、auth mutation CAS、checkpoint outbox 的迟到事件保护属于其他链路，不能拿它们的测试结果证明正文 synced 提交安全。本轮没有改这些既有保护，也没有处理生产数据。

## 验证记录

- Node 24.12.0 / Node 18.20.8 全量回归各 **1,884/1,884**，无失败、跳过或取消；新增 17 条（分类 7、加载契约 2、提交桥接 8），旧测试文件均未改动。
- 桥接覆盖混合成功/明确失败/未知、缺失/异常/错 ID 回执、重复 ID 最后一项、顶层 429 优先暂停、真实重试计数、隔离重项继续、显式取消、写入抛错不推进当前及后续记录；不把 false 返回当作抛错场景。
- 独立复核 12 个完整 AST 节点（10 函数＋2 Set）与基点一致，移除搬移部分与新 import 后，capture-sync 的其余 **96,928 tokens 完全相同**。公开 API 恰为原调用的 6 个入口；未发现常量写入、依赖环或初始化时序变化。
- 独立差分使用 95 个异常/混合回执样本及 item/batch 组合，共 **27,360 次公开函数求值一致**；这是差分求值次数，不是新增测试数量。
- 语法、差异空白、仓库卫生和独立快照检查通过。E1c 包为 98 文件，相对 E1b 97 文件仅 utils/capture-sync.js 改变和新分类模块增加，其余 96/96 相同；原客户快照与旧 QA 基线 95/95 SHA-256 相同。manifest 仍为 MV3/0.4.5，权限、background、storage、API、队列、sidebar、server 均不变。
- 本轮 E1b 基点在 Chrome for Testing 151.0.7922.34 / Edge 152.0.4191.66 各一轮，每轮 **11/11**；E1c 候选两浏览器各一轮，每轮 **12/12**。原 10 个生命周期/标记/投影场景保留，基点和候选均增加真实 capture-sync ESM 依赖加载；候选另测新分类模块的 6 个公开入口与限流/未知优先级。
- 候选 Chrome 任务面板和 Edge 倒计时截图已查看；四轮临时 Profile 已退出并清理，生产更新 CONNECT 请求均实际被测试代理拒绝。NetLog 未观察到成功的非 loopback 连接，保留失败 IPv6 探测及其错误/无发送字节证据，不等同于进程级封包审计。

本轮无服务端/schema 改动，未重跑本地数据库 cluster。CI 的构建、回归及隔离 PostgreSQL 矩阵以 PR 精确 head 为准；本地或 CI 通过均不授权 Ready、合并或发布。

## 验收边界和下一步

浏览器仍使用单独 QA 工作区、临时 Profile 和本地 fixture。只检查 capture-sync 的真实 ESM 依赖加载及分类模块对惰性样本的结果，不从浏览器调用实际同步方法。网络代理默认拒绝生产请求；NetLog 只报告可观测结果，不宣称 HTTP 代理具有进程级封包隔离。原始日志和截图留在本地 QA 工作区，不纳入运行差异。

新增提交桥接测试使用原 syncGroupRecordsWithRetry/applySyncRecordResultItem 的函数体及真实分类模块，网络、存储、计时使用替身；它验证调用顺序，不是实盘、生产服务或客户采集端到端验收。

下一步优先明确上述保存成功、迟到回执及跨上下文提交契约，再决定存储层拆离和独立保护修复的顺序。UIUX 与素材/共同代码权属审查独立；模块拆分不代表 MediaClaw 相关权属风险已解决。

本轮提交、推送、新建 Draft PR 并等待 CI 后停止；继续禁止 Ready、合并、部署、生产迁移、生产 split、客户 Extension 更新及处理 PR #29。
