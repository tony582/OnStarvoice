# E1f：默认关闭的本地队列核对挂起能力

日期：2026-09-05。**只准备本地队列与 drain 消费边界；真实同步生产者未启用，不能宣称线上已防止重复发送。**

## 隔离范围

- 基点为 E1e PR #44：`a02e807c8074ef88820a07a1a488a626e1ba4733`。分支 `codex/extension-e1f-reconciliation-hold-20260905`，新 Draft PR 以 #44 分支为 base。
- main 仍为 `51896d8694c4b19e3731e5b6b7623397420c84a9`；PR #37–#44 保持原状。Cron 解耦 #37 继续独立保留。
- 运行源码只改 `utils/record-sync-queue.js` 和 `sidebar/sidebar-logic.js` 中的 `drainStreamingDetailSyncQueue`；另加两份测试和本文档。
- **不修改** capture-sync、storage、background、server、协议、版本、权限、重试次数、防风控等待。E1e 原型仍不进入插件包，不被真实入口导入。
- 原客户 checkout、插件包及客户浏览器配置不动。不启用真实 producer 的新选项，不增加恢复、确认后放行、重发或持久化入口。

## 可选接口与行为

`createRecordSyncQueue` 新增可选的同步谓词 `shouldHoldForReconciliation(result, {recordId, meta, attempt})`。缺省或 null 不启动新机制，旧 API keys、统计结构及执行结果保持不变。构造参数非 null 且非函数立即报错。

| 返回或异常 | 本地队列行为 |
| --- | --- |
| 严格 false | 继续原重试与结算路径；谓词拿到独立副本，不能篡改真实结果。 |
| 严格 true | 在重试、processed/成功/失败/跳过计数及 dirty 重排之前挂起。 |
| 抛错 | 挂起，快照标记 `RECONCILIATION_GUARD_FAILED`。 |
| 非布尔值，包括 Promise | 挂起，标记 `RECONCILIATION_GUARD_INVALID_RESULT`；观察 Promise 拒绝但不等待异步判定。 |
| 结果无法 structuredClone | 挂起，`evidenceUnavailable:true`、`result:null`；不能声称完整回执已保留。 |

只在显式 opt-in 的实例上提供 `getReconciliationSnapshot()`：未挂起返回 null，挂起后按需返回独立副本，包含当前 recordId、attempt、完整可克隆结果、证据可用性、guardError 和未处理编号。result 是 processRecord 已返回的证据，队列不会自行创造服务器回执或判定本地提交是否成功。

证据复制隔离的当前契约和测试限于普通 JSON 形态结果。`structuredClone` 对 SharedArrayBuffer 及其视图仍共享底层内存；此类特殊输入未纳入本轮接线契约，不能泛称任意可克隆输入都完全隔离。未来生产适配器须约束回执形态，或另行拒绝/处理共享内存类型，不能直接扩大此保证。

挂起后的 `getStats()` 仅增加 `reconciliationRequired`、`heldRecordId`、`heldRecordIds`、`heldUniqueCount`、`drainCompleted:false`。高频统计/状态通知不复制完整正文或回执。显式 opt-in 的结果分类仍需要克隆结果/上下文，因此不承诺启用后零额外内存开销；真实入口未启用。

## 未处理记录与取消顺序

- 已完成的 P 保留原成功计数；A 返回待核对、B 尚未处理、A 又被标 dirty 时，未处理编号为 A/B 两个，不双计 A，不把 A 计为成功、失败、跳过或排除。
- 挂起阻止普通重试、dirty 重排、后续 worker 及 finally 自动续跑；不发送当前项的 settled，也不发送 drained。
- `drain()` 仍等待当前 processRecord 返回，随后返回挂起快照，不因保留 pending 而无限循环。**不新增网络请求超时，不能使本来永不返回的 processRecord 自动结束。**
- 未取消的挂起队列仍登记后来入队的记录和 hasSeen，避免旧 sidebar 将“没见过”误当作有意排除；只登记、不派发。
- 先挂起后取消：保留回执、pending/dirty 编号；先取消后迟到结果：在原 cancel 清空前临时保存轻量编号，收到 hold 后恢复为待核对证据。若迟到结果无需 hold，则保持旧取消结算语义。
- 取消后新 enqueue 仍按旧规则拒绝。本轮不重定义取消后采集规则，也不增加恢复接口。
- 仅内存保留，不覆盖 MV3 回收、浏览器重启、跨租户/设备、记录新版本或 Attempt 切换；不是 durable outbox、CAS 或服务器幂等。

## 收尾保护与未接线门禁

drain 适配器看到 hold 时使用 `streaming_sync_reconciliation_required`，展示待核对而非上传完成，并返回 `drainCompleted:false`。其中“不会自动重发”只指这个已挂起的本地队列，不是全系统保证。

实际 terminal 投影因此不形成完整上传证据；未改的 background 检查拒绝 business uploads cleared。即使适配器错误地强制 drainCompleted=true，只要 remaining 或覆盖计数未满足，依旧不能清场。这证明“不能宣告结清”，**不意味着已回收 runner 或完成任务清理**。

启用真实生产者前必须另行完成：

1. 正文/客资所有本地确认点保留同批远端 ACK，不退化成普通 SYNC_ERROR；与 E1e 操作级账本关联，不能把一个队列 recordId 充当整批 operationId。
2. 所有本地消费者与外层 UI 汇总统一认识待核对。当前仅 drain 适配器准备完成；例如外层仍存在依据 `!blocked` 显示成功的路径，定向、监控及手动入口也没有接入。
3. 服务端控制面与弹性恢复规则单列评审范围；当前规则仍可能将非安全失败投影为可重试。不能依赖 retryable:false 或本地 hold 阻止云端重新派发。
4. 如需跨重启防重发，另行设计耐久回执、操作身份/版本绑定、核对与安全恢复。未同步或待核对数据不自动删除。

当前 source 和运行工厂测试均证明 `createStreamingDetailAutoSyncQueue` **不传入**新选项。保持默认关闭是本阶段安全前提。

## 验证

- Node 24.12.0 / 18.20.8 全量各 **1,949/1,949**，零失败、跳过或取消。新增队列测试 19、真实收尾链测试 6，原测试未修改。
- 独立审阅并对 11 组默认路径比较旧队列的 API keys、统计、状态事件和 processRecord 调用，全部相同。新增收尾测试指向旧基点时，3 项兼容路径通过、3 项 hold 路径失败，确认测试能区分能力缺失。
- 在独立 QA 目录使用现有浏览器夹具：E1e 基线 Chrome/Edge 各 **15/15**，E1f 候选各 **19/19**。新增 4 项为默认关闭、挂起后取消、取消后迟到回执、非法异步谓词；只使用内存结果，不执行真实同步。
- 候选与基线均为 **98 文件、0.4.5**；逐路径 SHA-256 仅 queue 与 sidebar 两文件不同。原客户包与隔离旧基点 **95/95 逐文件相同**。
- 浏览器只使用本轮临时 profile 和本机平台页面夹具；默认拒绝的代理拦截生产更新检查，无外部转发实现。NetLog 未观察到成功非回环连接；浏览器 IPv6 路由探针失败（-109、无发送字节）仍如实留存，不能将 HTTP 代理夸大为系统级零外连尝试。临时配置已清理，客户配置未动。
- 本地 QA 证据：`OnStarvoice-extension-browser-validation-20260905/output/playwright/e1f-{base-chrome,base-edge,chrome,edge}-run-1`，网络汇总 `e1f-final-network-audit.log`。截图已查看。没有 8 小时/72 小时或客户业务验收结论。

只推进提交、普通推送、新建 Draft、等待 CI；不 Ready、不合并、不部署、不迁移、不 split、不更新客户 Extension、不处理 PR #29。UIUX 独立重设计及 MediaClaw 共同代码/素材权属工作仍保留；架构重构或界面改名不能替代权属审查。
