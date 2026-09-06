# L1：后台持久采集辅助生命周期职责迁移

## 结论与基线

本批把真实运行入口调用的生命周期实现从 `background.js` 迁出，不是未接线原型，也不是客户更新。
本地候选已完成接线、隔离回归和独立代码审阅；精确提交及 hosted CI 以本批 Draft PR 元数据为准。
真实浏览器、长期运行及客户验收未执行，不据此关闭 G7 或宣布整个 Extension 架构完成。

- 精确父提交：E1i / PR #48，`d5b243f0c6e6e9b3f920ab8264264553a6141411`。
- 运行源码候选：`6b15935f581c340b324e7175a46e476ede63042d`，已推送并创建 [Draft PR #54](https://github.com/tony582/OnStarvoice/pull/54)。
- 隔离分支：`codex/extension-l1-execution-lifecycle-20260906`。
- 主计划：[Extension 核心架构主执行计划](extension-architecture-roadmap.md)。
- 同基线后台从 **15,989 行降至 12,534 行，净减少 3,455 行**。
- 54 个原函数迁入 9 个职责模块；共享队列、恢复屏障及 manager 装配移入第 10 个协调器模块。
- `capture-sync.js`、Sidebar、平台采集实现、manifest、版本、存储键、服务器及构建脚本未改。
- U1–U5 是另一条候选链，本批没有集成其 UI/读取/权限原型；E1e/E1i 协议 producer 仍未启用。

## 入口与调用关系

旧结构是后台消息/事件直接调用同文件函数及共享状态。
新结构是原消息/事件 → 单次创建的 `captureLifecycle` 同名兼容入口 → 职责模块 → 命名宿主端口。
不存在并行启用的新旧两套执行器；原函数体已经退出后台文件。

| 原消费者 | 当前真实实现 | 保持的行为 |
| --- | --- | --- |
| BEGIN 消息 | `begin.beginCaptureTask` → `beginCaptureTaskNow` | 同一生命周期队列、恢复屏障、owner/Attempt 校验、启动失败回滚 |
| UPDATE 消息 | `progress.updateCaptureTask` | 原进度字段、旧 Attempt 拒绝、原响应 |
| register 消息 | `progress.registerCaptureTaskTab` | 页组和 Debug 登记顺序、回滚及原响应 |
| minimize 消息 | `progress.setCaptureTaskMinimized` | 原最小化与可选能力语义 |
| END 消息 | `end.endCaptureTask` → `performEndCaptureTask` | 与 BEGIN 共用队列；现有恢复/业务终态策略不变 |
| owner 端口与失联回调 | 显式 `owners` 端口、`end.handleAbandonedCaptureTask` | 原断连宽限与取消发布、清理顺序 |
| 后台启动/恢复调用 | `restore.restorePersistedCaptureRuntimeSession` | 同一实例的恢复 promise、快照比对与过期资源回收 |
| `tabs.onReplaced/onRemoved` | `tabs` 模块 | 原标签/Attempt 租约、worker 与锁引用更新 |
| Debug 状态/断开回调 | coordinator 状态回调、`end.handleUnexpectedCaptureDebugDetach` | 精确快照发布；非预期断开仅辅助降级，不擅自重派业务 |
| 无人值守恢复/准入消费者 | `attempts` / `admission` 的兼容入口 | 原任务身份栅栏、旧资源回收；调度权与根账本仍由宿主持有 |

`leases` 负责替换租约；`cleanup` 负责取消发布、资源跟踪、释放和失败重试；不是另起调度器。
每个职责模块显式列出自己的宿主端口和跨模块命名调用，不使用 `with`、Proxy、eval 或全局上下文袋。
9 个模块必须先全部注册，随后 coordinator 才能装配；缺少任一模块会在装配前失败。

## 状态所有权与持久化边界

| 状态/资源 | 当前所有者 | 外部访问 |
| --- | --- | --- |
| 生命周期 Promise 队列 | coordinator 实例 | 保留命名串行操作；拒绝不会污染后续队列 |
| 恢复 promise、进行中的 BEGIN 标记 | coordinator 实例 | BEGIN/restore/tabs 共享同一实例引用 |
| 替换租约 Map | coordinator 实例，leases/tabs 使用 | 命名租约方法，不暴露 Map |
| 待清理 worker Map | coordinator 实例，cleanup/tabs 使用 | 命名跟踪/释放方法，不暴露 Map |
| 清理中 Set | coordinator 实例 | 宿主只能通过 `isCaptureTaskCleanupInProgress(taskId)` 查询 |
| Debug、页组、owner manager | coordinator 实例 | 冻结的显式方法端口，非原 manager 对象 |
| runtime 持久化队列、执行锁队列、无人值守请求队列 | 原后台宿主 | 以命名函数注入，未复制队列/锁、未改锁序 |
| task/request/Attempt 根账本与业务调度 | 原后台宿主/既有模块 | 本批仅调用既有端口，不宣称职责已迁走 |

兼容端口明确为：

- Debug：`getSessionByTaskId/getSession/getActiveSessions/stopByTab/stopByTaskId/updateTask`。
- 页组：`getTask`。
- owner：`getOwner/clearTask/attachPort/bind`。

包装保留原 receiver、参数、返回对象/Promise 和同步顺序，没有多加异步层或重新入队。
查询结果仍遵循旧 manager 语义，不宣称深不可变快照，也不将这些接口当作安全隔离边界。
`bind/stopByTaskId` 同时供既有隔离测试兼容入口使用；公开操作名表仍保留迁移前函数名以便过渡验证。

## 明确保留的竞态和副作用顺序

1. BEGIN 和 END 串行；BEGIN 在恢复屏障通过后才建立进行中标记，结束时只清理自己那一个标记。
2. 标签替换事件没有被新塞入上述队列：必须能够更新等待中的 BEGIN 标记，避免相互等待。
3. 旧 unattended Attempt 的进度和 END 不得修改新运行的资源；恢复前后仍做原精确身份复核。
4. 清理按原 Debug → worker → 页组 → owner 顺序执行；worker 关闭失败保留待清理记录及持久快照，不抢先丢掉归属。
5. Debug 意外断开仍是观察性辅助降级，不能由新模块擅自取消业务、重试或创建第二条公共任务账本。
6. 原等待、宽限、锁租约、重试次数、页面规则与平台防风控节奏均保持，不把性能优化混入职责迁移。

## 旧代码退出与明确残余

- 精确基点共 331 个后台顶层函数，候选保留 276：移走 54 个职责函数及 1 个共享队列函数。
- 54 个原函数体不再存在于后台；对应可变绑定不再由后台直接持有。
- 276 个保留函数中仅本地收口证明的 Set 查询改为显式查询端口，其余函数正文保持等价。
- 原消息与事件名、响应结构、调用方无需同步改协议；同名 aliases 是显式兼容边界，不是复制旧实现。
- `beginCaptureTaskNow` 仍保留较长的原启动/回滚事务，本批优先迁移完整职责，不同时重写事务。
- 后台仍有约 12,500 行；无人值守编排、根账本及宿主存储/锁服务并未整体迁移。
- 这些剩余宿主职责已明确放入主计划 L5，分别迁入独立编排、账本、锁和存储服务，不永久留在后台大文件，也不塞回生命周期模块；L6 再做组合验收。
- 保存同步大文件进入 L2；Sidebar controller 与 U 链接口集成进入 L3；平台实现、来源/用语/资产核对进入 L4。
- 移动文件和命名端口不能证明 MediaClaw 代码来源独立或消除权属风险；独立性门槛继续单列。

## 本地验证证据

| 检查 | 结果与边界 |
| --- | --- |
| 54 个函数迁移对照 | AST 对照通过；独立审阅另从真实 `git show` 基点核对每个函数指纹，不只对照候选自制 fixture |
| 276 个宿主保留函数 | AST 核验通过，唯一允许变化为清理状态查询端口 |
| 原后台关键回归 | 干净 E1i 基点和 L1 候选各 238/238；候选测试只增加必需模块预加载，未删除原场景 |
| 运行契约 | 原 39 项保留、增加真实接线/单 owner 断言，共 40 项；定位实际职责模块，不拼接旧新源码绕过断言 |
| coordinator 专项 | 20 项：必需模块、实例隔离、队列恢复、租约、清理失败、旧 Attempt、意外断开、端口和原正文对照 |
| 全量 Node 24.12.0 | 2,135/2,135，无失败/跳过；含上述专项 |
| 全量 Node 18.20.8 | 2,135/2,135，无失败/跳过；含上述专项 |
| 独立复审 | 未发现阻断隔离提交/Draft 的迁移问题；另复跑 60 个模块/契约及 50 个恢复/标签/BEGIN-END 场景 |
| 无上下文文档复核 | 正确识别候选/发布边界及下一阶段；按反馈统一代码审阅状态、补足剩余后台职责归宿及精确候选/CI 链接 |
| 语法、仓库卫生、diff 空白、隔离构建快照 | 通过；仓库卫生检查 786 个文件 |
| 运行源码候选 CI | `6b15935` 的 [push 6/6](https://github.com/tony582/OnStarvoice/actions/runs/34014208892) 与 [PR 6/6](https://github.com/tony582/OnStarvoice/actions/runs/34014240128) 通过；其中数据库任务为 CI 的隔离容器，不是生产迁移 |

全量日志：`/tmp/onstarvoice-l1-node24-final-20260906.log`、`/tmp/onstarvoice-l1-node18-final-20260906.log`。
基点配对日志：`/tmp/onstarvoice-l1-baseline-paired-20260906.log`；AST 日志：`/tmp/onstarvoice-l1-equivalence.log`。
持久的逐函数基线指纹在 `tests/fixtures/capture-lifecycle-body-fingerprints.json`，回归测试按显式 state/API 限定替换核对；这不是任意语义变更的通行证。
上述精确 CI 归属于运行源码提交；本次文档补记不修改运行源码，但仍重新触发并等待最终 head CI。最终提交门以 PR #54 的最新 head 与相应 checks 复核，不沿用旧 head 的绿色。

第一遍全量有两个验证问题，已修正后完整重跑：构建快照与回归并发导致测试读取缺文件；旧 unattended 台账测试仍查找原文件里的 END 正文。
前者改为先完成快照再测试；后者保留原两项台账断言、改读真实 end 模块，并增加导入/装配/alias/调用/旧体退出断言，没有跳过或放宽业务场景。

## 隔离快照与客户保护

仅在 L1 工作树运行既有快照校验：110 文件 / v0.4.5，不生成安装 ZIP、不加载浏览器。
与 E1i 的 100 文件快照相比，只改 `background.js`、新增 10 个生命周期模块；无文件删除，其余原文件字节一致。
基点快照另逐文件对照精确提交，不能仅凭工作树目录名判断基点。

清单摘要算法：按相对路径字典序排序，连接每项 `path + TAB + SHA256(bytes) + LF`，再计算 SHA256。

- 本轮基点参考快照：`1f497e50003b8eab59cd3829eaca1dcadb98f74634b9c17de8a1f8ff2587abf8`。
- 本轮候选快照：`e912c95b9a8aa668d1fe4d35f9783c346601be884bc62fe71204b524be7c8b0f`。
- 原工作区客户参考目录仍为 95 文件 / v0.4.5，摘要 `554479f7e01198ba0e6f7c2eb3d16e58c55db773aaadad90ecea5d6b039d1f87`，未改动。

以上是本地目录证据，不证明客户浏览器当前加载的是哪个版本；历史文档摘要不拿来冒充本轮核验。
本轮未新采集、未调用真实鉴权或客户业务接口、未 Ready/合并/部署/迁移/split/Reload/更新 Extension，未处理 PR #29 或原有 Draft。

## 下一步及停线条件

本批精确 head 的 CI 候选门通过后，按主计划进入 L2 的隔离实施：先固定保存/提交/回执阶段及所有调用入口，再迁移真实流水线。
不默认启用远端 hold 协议，不改变存储格式、不删除未同步数据、不以 L2 名义顺带做数据库变更。
若基点变化、稳定 hotfix 未对齐、测试失败、身份/持久化/顺序不等价，先停止候选推进并更新计划，不能用客户任务验证或补偿。
真实 Chrome/Edge、8 小时内存及 72 小时稳定性验证需独立许可；未获得前停在候选状态，发布权不随“继续”扩大。
