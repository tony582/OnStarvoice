# E1b：任务中心 checkpoint / counts 纯投影抽离

日期：2026-09-05。本步骤是隔离架构候选，只到 Draft，不是生产发布、故障修复或整个 Extension 重构完成。

## 基点和差异

- 精确基点：E1a PR #40，`8fec8b781ba92e6efe0f9c61734d6de93fbaf499`；本 PR 以 #40 分支为 base。
- 分支：`codex/extension-e1b-task-center-projection-20260905`。main 与 PR #37–#40 均不修改；PR #37 的 Cron 解耦仍独立保留，没有漏掉或静默引入。
- 从 background 原样抽离 `buildTaskCenterCheckpointFromUnattendedRequest` 和 `buildUnattendedTaskCounts` 到 `utils/capture/task-center-projection.js`，必需同步加载并保持同名调用。
- 两函数只依赖输入和 JS 内建，不能读写 Chrome、网络、存储、时钟或可变任务状态。不搬 `buildUnattendedTaskRun`、归一化器、持久化、ACK、队列或 MV3 生命周期。
- 原三个调用点保持不变，包括任务账本构建及人工“仅重试失败项”对 checkpoint 的读取；这不只是视觉展示，所以失败关键词归类不能顺手调整。
- 实现/测试差异限定 5 文件，另加本文档。manifest、版本、权限、协议、采集规则、等待、重试、并行度、UI、同步、服务端及数据库 schema 不变。

## 刻意保留的历史语义

- keywordResults 的 500 条上限只限制输出明细；完成/失败/跳过集合和 attempts 仍由全量输入生成。
- partial 仍归入 failedKeywords；计数 summary.partial 仍映射 warnings。集合归类使用未 trim 的原 status，输出明细才 trim。
- 同名关键词的 attempts 使用输入最后一条覆盖，不取最大值，也不按轮次重新排序。
- 无明细时保留旧数组和 attempts 对象的引用语义，不引入深拷贝。
- counts 字段优先于 summary 别名；null 会先命中数字候选、再沿用 previousCounts，而不是继续读取 summary。
- 当读取值为 processed=0 时，仍用分类计数和回退；total=0 沿用既有无总数上限的计算。previousCounts 回退保留原有未 floor 语义。

这些记录是兼容契约，不是对现有业务规则合理性的判断；如需修正规则，应另立行为变更及验收。

## 验证记录

- Node 24.12.0 / Node 18.20.8 全量回归各 **1,867/1,867**，无失败、跳过或取消。
- 新增 13 条直接兼容性测试及 2 条 runtime contract；原有 37 条 runtime contract 保留。两文件定向验证两个 Node 版本均 52/52。
- 独立复核：两个函数完整 AST（含参数/default）与精确基点一致；移除搬移、import 和绑定后，background 其余 **82,507 tokens 完全相同**。另 15 组基点/候选 VM 行为对照通过。
- 独立复核确认原 runtime contract 37 条和 background 238 个顶层测试的完整 AST 均未改变；模块缺失会明确中止启动，没有静默绕过。
- 语法检查、差异空白检查、仓库卫生及独立交付快照检查通过。快照为 97 文件（比 E1a 增加新模块），manifest 仍为 0.4.5；未生成发布 ZIP、安装或更新客户 Extension。
- 独立逐文件比对：相对 E1a 的 96 文件，只有 background 变化和新模块增加，其余 95/95 一致；原用户 95 文件交付快照与旧 QA 基线 SHA-256 全部相同。server、sidebar、capture-sync、manifest、权限均未变。
- 在隔离浏览器中，本轮重新验证 E1a 基点和 E1b 候选：Chrome for Testing 151.0.7922.34 与 Edge 152.0.4191.66，每种快照/浏览器组合各一轮，每轮 **10/10 场景通过**。基点的原函数输出与候选新模块输出逐项符合相同预期，候选也验证了两个全局函数确实绑定到新模块。
- 十个场景：扩展加载、BEGIN/进度、原生任务页组/工作页、等待倒计时、小红书 fixture 标记、正常 END 清理、抖音 fixture 标记、刷新后标记恢复、错误平台拒绝，以及真实 worker 内的任务中心投影。候选 Chrome 面板与 Edge 倒计时截图已查看。
- 四轮生产更新请求均被本地代理拒绝，NetLog 未观察到成功的非 loopback 连接；失败的 IPv6 探测保留记录，无对应发送字节事件。四个测试临时 Profile 均已清理。

本轮服务端与数据库 schema 无变化，没有重跑本地数据库 cluster；隔离 PostgreSQL CI 矩阵以 PR 精确 head 的检查为准，不以旧结果冒充当前验收。CI 通过也不授权 Ready、合并或发布。

## 浏览器隔离与边界

复用独立 QA 工作区的浏览器验收程序，并增加真实 Extension worker 内的两函数 fixture 调用和模块绑定检查。该调用只返回对象，不启动无人值守任务、不写入 checkpoint、不触发同步；它不是客户端到端业务验收，也不验证 MV3 worker 被终止后的恢复。

每轮新建临时 Profile，使用本地 HTTPS fixture、无客户凭据，默认拒绝的代理只转发固定 fixture host 与端口到 127.0.0.1。生产更新请求必须实际被代理拒绝。NetLog 检查保留失败 IPv6 探测，不把 HTTP 代理误称为进程级封包隔离。仅退出本轮测试浏览器并清理本轮临时 Profile。

QA 程序修改与原始证据留在独立本地测试工作区，不纳入本 PR 的运行差异。现有任务面板截图只是回归证据，不是新 UIUX 设计。

不声称完成真实平台采集/AI/同步、客户灰度、停止延迟、无 debugger 权限、8 小时内存或 72 小时稳定性验收。

## 后续与停止点

E1a 执行身份、E1b 状态投影形成可直接测试的纯模块；后续先盘点运行状态读写与同步提交边界，尤其持久化顺序、旧 Attempt 结果拒绝和确认回传，不能将这些副作用按行数整体搬家。

UIUX 设计和素材/共同代码权属审查保持独立。拆分、改名或换 UI 不代表 MediaClaw 相关权属风险已解决。

本轮提交、推送、创建 Draft PR 并等待 CI 后停止；不 Ready、合并、部署、生产迁移、生产 split、客户 Extension 更新或处理 PR #29。
