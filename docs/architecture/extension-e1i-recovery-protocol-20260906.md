# E1i：待核对协议、恢复屏障和监控接入清单

## 结论与授权边界

本批完成**未接线的可执行协议原型、故障注入测试和接入设计**，没有修复正在运行的服务器。
三个状态必须分开：远端已经接收数据、本地已确认保存、服务器已持久记录“禁止重跑”。
前两个不能互相代替，第三个也不能只靠 UI 显示 `needs_action`。

- 隔离分支：`codex/extension-e1i-recovery-protocol-20260906`。
- 精确基线：PR #47，`dabdb5a4fabe85abb256a3730ccbce402fd265f0`。
- 授权范围仅提交、普通推送和新建 stacked Draft PR；不 Ready、合并、部署、迁移、split。实际提交/推送/CI 状态以交付回复和 PR 元数据为准，本段不是已执行声明。
- 不改客户 Extension、不启用真实同步 producer，不修改已有 PR #29 / #37–#47。
- main 仍为 `51896d8694c4b19e3731e5b6b7623397420c84a9`；PR #37 Cron 收尾候选保留。
- 本批新增文件只在 `prototypes/`、`tests/`、`docs/`。服务器、插件运行源码与构建脚本不变。

## 本批可执行内容

| 文件 / 接口 | 已实现 | 明确没有实现 |
| --- | --- | --- |
| `prototypes/extension-sync-confirmation/server-hold-protocol.mjs` / `planReconciliationHold` | 严格版本、事件和执行身份校验；跨租户/过期回报拒绝；资源级 hold 单调保留；同事件身份/语义冲突拒绝 | 鉴权、数据库锁、持久化、调度器拦截、解除 hold |
| 同文件 / `confirmReconciliationHold` | 只在注入适配器给出严格提交回执且身份完全匹配后确认 hold；回包丢失不重试、不判为未保存 | 真实事务适配器、超时取消、跨进程回执真实性、自动重发或完整 finish 幂等账本 |
| `prototypes/extension-sync-confirmation/monitor-finish-contract.mjs` / `planMonitorFinish` | 有 hold 时禁止降级调用旧 finish；协议不支持就要求升级；支持协议仍要求服务器 hold | 发请求、终结监控、推进游标、更新下次执行时间；客户端自称 committed 不能获得放行 |

`defer_existing` 仅表示本模块没有做决定，**不是允许重试或完成**。
`hold_commit_confirmed.accepted=true` 只确认注入适配器回执中的 hold，**不确认采集/同步成功，也不解除 hold**。
原型没有生产调用方；HTTP 客户端不能充当可信 `persist` 适配器。
即使测试中的内存适配器返回 committed，也不代表已在 PostgreSQL 验证。

## 身份模型与保留规则

拟议标准 scope 为 `tenantId / lane / parentId / resourceId / executionId / attemptId / agentId / assignmentRevision / requestHash`。
所有字符串必须精确、非空、无控制字符且不超过 240 字符；revision 必须为正安全整数。
只接受数值 `protocolVersion=1`。不做大小写转换、字符串转数字或缺省身份补齐。

| lane | 资源级屏障 | scope 的未来可信来源 |
| --- | --- | --- |
| `capture_item` | tenant + parent task + item | 已锁的 parent/item/execution/item-attempt/Agent 关联；继续验证既有 attempt number、client attempt、assignment revision、request hash 等原生栅栏，再生成标准 scope |
| `monitor_subscription` | tenant + subscription；不能仅挂在 execution 上 | tenant 来自鉴权；subscription/execution 来自服务器绑定；领取者、attempt/claim epoch、版本和 request hash 必须由新的领取机制分配 |

这不是现有字段的自动映射器。尤其旧 monitor execution **没有**完整领取身份，不得用 `updated_at`、订阅配置的 Agent 或客户端传来的身份冒充。
云 Profile 路径已有 item/attempt 关联，旧 monitor start/finish 又用 `NOT EXISTS` 排除这些关联项，两个入口不能混成一个宽松协议。
拟议映射中，capture 的 parentId 为 parent task ID、resourceId 为 item ID；monitor 的 parentId 和 resourceId 都填同一个可信 subscription ID，executionId 才是本次 execution ID。
正式适配器必须验证这些原生关联；原型只检查传入标准 scope 的完整性/精确相等，不会查询或证明数据库关系。

既有 hold 保存资源身份、起源 scope 和首个事件 ID。后继执行/设备可以有新的有效身份，但其成功、取消或一般错误不能清掉同资源的旧 hold。
同一事件 ID 若换身份或把 hold 改报为普通成功，拒绝；同语义重复只允许确认既有 hold，不增加业务副作用。
本原型仅比较标准化 hold 语义，不承诺任意原始 HTTP payload 的完整幂等性。
正式 finish 需要独立事件 ID +规范化请求摘要+已提交回执账本；不同 payload 的冲突必须在事务内拒绝。

核对/解除另设门槛：未知提交结果先按精确租户、资源、事件查询可信回执，不自动补发业务数据。
未来只有单独授权的运维核对动作，在逐 operation/stage 远端回执与本地确认均对应、当前身份和 hold 版本再次匹配并写入审计后，才可申请解除。
“后台存在一条记录”或拥有普通管理员重试权限都不满足该证据要求。
该动作的权限角色、解除接口及恢复操作尚未实现，不能用本批原型代替审批。

## 服务端接入位置：不能只改一个状态分类函数

以下位置在本批基线中只读核验。行号以该基线为准，实施时以函数名再次定位。

| 入口 / 位置 | 已发现的边界 | 正式接入要求 |
| --- | --- | --- |
| `server/services/capture-cloud.js` / `normalizeCloudTaskSnapshot`（776） | 返回白名单不保留顶层 hold / streaming 对象；error 和部分 metadata 并非可靠专用账本 | 新增独立、版本化、精确身份的信号通道，不将大回执塞进通用截断 metadata |
| `server/routes/capture-cloud.js` / snapshot mirror、`projectOrchestrationSnapshot`（2689） | 错误/checkpoint 会重建，未开始项可被转为 retryable | hold 独立保存；区分明确未发送项与已接受但待确认项 |
| `server/modules/capture/application/control-outcome-projection.js` / `projectElasticKeywordRecoveryStatus`（394） | 非安全且未耗尽次数时，held needs_action 仍可能变 retryable | 分类前识别独立屏障；不冒充验证码等平台安全 |
| `server/modules/capture/infrastructure/postgres-cross-device-retry.js` / `classifyCaptureRecoveryDisposition`（138）、dispatch | `retryable:false` 不能防止自动重试；最终更新会清 error/checkpoint/targetResult | 候选预筛 + 最终锁后复核；在建 child/command、换 assignment、清证据之前拒绝 held 项 |
| `server/routes/capture-orchestrations.js` / waiting retry、retry-items、resolve-attention | 普通重试/确认安全没有回执核对语义 | confirmSafety、人工普通重试不构成解除 hold 的授权；保留既有 marker/证据 |
| `server/routes/capture-cloud.js` / `dispatchNextElasticWorkItem`（3866） | pending/retryable 领取后可清旧 checkpoint/error | 清理、续派和版本切换前在原锁序内检查屏障 |
| lease / command reconciliation 模块 | 仅处理其原有活动/待领取状态，不是扫描所有 needs_action；但活动记录若已有 hold，超时错误可能覆盖信号 | 允许必要控制回收，禁止它释放业务 hold 或制造业务重派；“读接口”调用的 expire/reconcile 也要纳入 |
| `server/services/capture-recovery-intents.js`（4034） | 部分 SYNC 错误已有 waiting_human 保护，但不是严格统一 hold 协议 | 保留已有保护；不得把偶然分类覆盖当作全局屏障 |

正式事务适配器必须在**现有锁序内最终复核**权威身份与资源 hold。
读侧预筛只是优化，不替代锁后检查；新屏障不能反过来引入 subscription → item/attempt 等逆序锁。
既有 Agent 执行槽、item/attempt、subscription、execution 取得顺序须在每条入口分别保持。
注入回调必须在 COMMIT 完成后才返回回执；若 COMMIT 后通信失败，结果是未知，不可自动重发。

## 监控需要订阅级屏障

1. `server/routes/monitor.js:1153` start 只有 tenant + execution + pending CAS；没有领取者 attempt 绑定。
2. `:1174` finish 把非 failed 一律变 succeeded。把 needs_action 直接发过去会被误当成功。
3. finish 重复 CAS miss 不重复订阅/快照副作用，但仅返回 ok:false，不能区分重复、冲突、过期回报。
4. `server/db/migrations/049_official_account_monitor_link.sql:177` 的活跃唯一性仅覆盖 pending/running。
5. `server/services/profile-patrol-dispatch.js` 的候选查询（709）、锁后查询（741）、stale 清理及跨设备换 execution 均须识别 subscription hold。
6. `run-now`、`due/start`、定时调度、重试、云监控终态映射必须同时受屏障约束，否则单个 execution 暂停后仍可创建下一次执行。

未来需要持久化结构/索引与协议升级共同完成。**本批没有新增 DDL，没有执行任何迁移。**
不能先让客户端启用，再指望服务器逐步补屏障；不支持 v1 hold 协议时，客户端不得把它降级为旧 finish 成功/失败。

## 后续实施与上线门槛

| 阶段 | 必须一起满足 | 当前状态 |
| --- | --- | --- |
| 协议设计 | 精确身份、资源级单调 hold、提交回执与失败语义 | 本批原型与隔离测试；无真实适配器 |
| 持久化候选 | 专用 hold/事件回执结构、版本 CAS、所有调度屏障、原锁序、保留策略 | 未实施；需要单独授权数据库设计/迁移和运行时代码接入 |
| 真实链路验证 | PostgreSQL 并发/回滚/提交后断联、重启、跨设备、租户隔离、旧客户端滚动兼容 | 未完成；本批只有内存和源码片段实验 |
| 插件接线 | E1e producer + 本地回执保留 + 剩余循环/监控/手动采集消费者完整覆盖 | 未启用，必须等服务器门槛成立 |
| 客户发布 | 指定版本审批、可回滚灰度、真实 Chrome/Edge 采集与长时运行验证 | 未授权、未执行 |

UIUX、MediaClaw 代码来源/独立实现另有批次；本协议原型和模块提取不能作为独立性或法律结论。
原先 PR #37 的 Cron 收尾也不因本批自动合并；保持独立发布审批。

## 本批验证证据

- 新增 **62 项**：计划器 26、提交确认及内存实验 16、monitor 原型/旧路径负对照 20。
- Node 24.12.0 与 Node 18.20.8 完整回归各 **2114/2114**，零失败/跳过。
  日志为 `/tmp/onstarvoice-e1i-node24-final-20260906.log` 和 `/tmp/onstarvoice-e1i-node18-final-20260906.log`。
- 仓库检查 **772 个文件**，diff 空白检查通过；只新增本批 6 个原型/测试/文档文件。
- 构建快照 **100 文件 / v0.4.5**，与 PR #47 快照逐字节一致。排序路径+SHA256清单摘要：
  `5ae68cb0846b83b4bc2150133e1d8f3ce153f46c67629241794097877d4cd601`。
- 客户现用快照仍 **95 文件**，与稳定基线逐字节一致，清单摘要：
  `a47d62ca2d900653ca4c228e051ee9868d8a2dd3755faf221c4971a1d402bce8`。
- 本次没有重跑浏览器：没有运行源码/快照变化。PR #47 的浏览器证据归属于上批，不伪装成本次验收。
- 独立代码审阅发现并修复事件字段重复读取、控制字符边界、异常输入退出旧流程风险；随后测试全过。
- 无上下文文档读者正确回答六个问题：上线范围、accepted 含义、重试/解除权限、旧 monitor 身份、单点修改风险、后续授权门槛。
  依据审阅补清了身份映射、授权与实际执行区别、未来核对/解除要求。
- hosted CI 为提交后的独立门槛，以 Draft PR 对应的精确 head 为准。

以上不是实际数据库故障恢复测试，也不是已在生产实现禁止重发的证明。
