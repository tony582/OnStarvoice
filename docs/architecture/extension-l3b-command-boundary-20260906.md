# L3-B 后续：旧任务命令适配与严格执行边界

## 本批合同与基点

基于 PR #57 最终 `ab7feee55032b929c861c1d33c5f145f7450a7c3` 创建隔离分支 `codex/extension-l3b-command-adapter-20260906`。实施前重新核验 #57 为 OPEN + Draft + CLEAN，两组 CI 成功；本批不修改 #57、其他既有 Draft 或 main。

本批允许本地代码/测试/计划修改、离线模拟、提交、普通推送、新 stacked Draft 及精确 head CI。仍禁止 Ready、合并、部署、迁移、split、客户 Extension 安装/Reload/更新、真实鉴权/客户数据 API/新采集，以及处理 PR #29。原客户工作树和参考包不改。

只推进既定 L3-B 的剩余旧命令边界，不开始 C/L4 或新增 U/helper 功能线：

1. 将旧 `handleTaskCenterAction` 的事件解包/界面效果与旧业务命令编排分开。真实 document 事件继续调用新适配器，旧函数体退出宿主；不复制第二套命令执行链。
2. 保留 action 别名、taskId 兼容映射、旧诊断回退、读取和等待顺序、原提示与错误边界。这些兼容行为不因此变成安全行为，不接作新 UI 命令能力。
3. 只读核对后台取消/恢复的目标、队列、锁、归档和页面副作用，形成有文件/函数/验收矩阵的严格围栏实施范围。**不在本批实现后台行为收紧**；需要另行明确授权。

## 职责与证据要求

| 职责 | 本批所有者 | 验收要求 |
| --- | --- | --- |
| 旧 DOM 事件、结果页切换、安全确认和提示 | `sidebar/legacy-view/task-center-actions.js` | 原 event.detail 解包与界面调用时机；不把历史项变为可信身份 |
| 旧任务中心 action 归一化、取消/恢复编排 | `sidebar/legacy-application/task-center-actions.js` | 显式消息、诊断读取、原取消和计划刷新端口；无 DOM/全局 current-task 状态，不加入新 UI/controller 的安全 API |
| 宿主接线 | `sidebar/sidebar-logic.js` | 只装配并保留原 document listener；两个启动分支构造无命令副作用 |
| 历史基线与回归 | 精确父函数证据及配对测试 | 测试原函数与真实候选模块；延迟响应/拒绝/提示抛错/当前任务替换/读取顺序均对照，不覆盖 L3-A/L3-B 原 fixture |
| 严格执行围栏 | 后台现有链只读审计 | 每项 mutation、资源和旧消费者列明；没有原子执行端与可信目标时，新 UI 不允许借用旧入口 |

行数仅说明旧宿主职责是否退出，不作为阶段完成率。整个 B/L3 的退出门、C 的 U5/真实历史权限接线、L4 来源处置、L5 后台宿主、L6 实机/长期/回滚、服务端 PR #37/G3 与 P8/G8 收尾均保留。

## 关键行为冻结

- taskId 在空 action 或 view_results 提前返回前读取；不能只为看结果而跳过原读取。
- `detail.task` 只在有效 continue_remaining 与 taskId 分支读取；不提前快照。
- stop 的活动诊断读取发生在远端取消非 ok/异常之后；不能在等待前缓存，也不能将它宣称为可信 Attempt。
- 原成功提示在对应 try 内，提示本身抛错的 catch 行为也保留；本地取消与人工安全确认的异常不被新 catch 吞掉。
- legacy 仍可能缺精确 Attempt、使用 taskId/requestId 映射与当前诊断回退；本批只隔离，不宣称修复。严格消费者必须使用后续独立执行协议。

## 当前状态

旧事件解包/显示和 legacy 应用编排已隔离接线，宿主从 11,096 行降至 11,014 行，净减 82 行。只补两个职责模块，不把 105 行旧函数与整个 L3 的完成量混算；原 document 事件名、listener 位置及 UI emitter 未变。构造阶段不读任务、不发消息；新应用 API 不加入 `createSidebarTaskController`。

精确父函数作为 105 行冻结测试证据（不是伪造旧大文件）保存于 `tests/fixtures/sidebar-legacy-task-center-action-migration.json`；原函数 SHA256 为 `394a545911b63a1345755b11132cfdaf146eeb4a2718bf40d8138e7109238c03`，原宿主 SHA256 为 `eb90f9ee026a2f119b984e67a99e5449af68faa6d64aaec97751d23851ff82d8`。L3-A 与 L3-B 的历史 fixture 字节不改；剩余宿主函数由 294 降至 293（含 export init）的差额单独登记。293 个保留函数逐字不变，整份宿主除旧函数退出和明确 import/装配外，其余 468 个顶层语句 AST 一致。

Node 24.12.0 / 18.20.8 官方全量各 **2,286/2,286**，0 失败/跳过；新增旧命令实际模块配对默认 **81/81**，启用精确 Git 对照为 **82/82**。受影响消费者各 **46/46**；L3-A、L3-B 与本批三基点专项组合各 **117/117**，包括真实宿主两种启动路径。只使用合成消息/对象，不连接真实浏览器或接口。保留继承键误命中、诊断回退和提示抛错等旧缺陷的 characterization，不将其当作安全命令支持。独立文档核读及 Draft 门收口中；本批最终 head CI 另核，不沿用 #57。

隔离快照 166 文件/v0.4.5，按相对路径排序的逐文件 SHA256 清单摘要为 `944810f628c497662696ea05ff9eba653d153449c4ce963f238386ae2529ad30`；原客户参考仍为 95 文件/v0.4.5、摘要 `554479f7e01198ba0e6f7c2eb3d16e58c55db773aaadad90ecea5d6b039d1f87`，未安装/Reload/打包发布。参考包不是所有客户实装版本证明。仓库卫生 859 文件检查通过；后台、平台、content、同步、服务端、管理端、manifest、依赖锁及 CI 文件均与父提交无差异。

无本任务上下文的独立文档读者已核对本批合同、统一路线图及总计划第 10 节：能正确区分已迁移职责、未修复的旧安全问题、父 CI 与本批 CI、本地与客户发布；没有阻断性歧义。该文档结论不代替代码、实机或严格修复验收。

交付状态：源码 `d805ed1b92a258772a5014064c85f6484d4d615b` 已普通推送并创建 [Draft PR #58](https://github.com/tony582/OnStarvoice/pull/58)，base 为 #57 精确 `ab7feee55032b929c861c1d33c5f145f7450a7c3`。本次状态补记只改三份计划；最终 head 两组 CI 独立核验，精确结果记录在 #58 正文和任务交付，不再用状态提交循环替代收口。保持 Draft，不继续实施未授权的严格行为变化。

## 后台只读审计：严格命令为什么尚不可用

以下定位冻结在父 `ab7feee`；相关运行文件本批不改。这里的“原子”只指本地比较后写入（CAS），不是把存储、浏览器、网络伪称一个跨系统事务。

| 环节 | 源文件与原函数/位置 | 必须处理的边界 |
| --- | --- | --- |
| 入口与显示 ID | `background.js:12161/12175` recover/cancel 消息；`sidebar/task-center-ui.js:448/1324` | 旧消息缺 expected Attempt；展示 ID 有兼容 fallback。不得从 taskId、按钮 data 属性、诊断上下文推造严格目标或当前权限 |
| 取消源/归档 | `background.js:7165/7193/7269`，`cancelUnattendedKeywordRunFromControl` | 历史按 requestId 删归档；终态先 cleanup 后 dismissal CAS；活跃分支先读锁、后 request-only mutation、再队列外取消与释放 |
| 最终持久提交 | `background.js:1671` request/ledger 提交；`:4816` `cancelUnattendedKeywordRunRequestWithinMutation`；`:4447` 清历史 | cancel 底层已有部分可选 Attempt 比较，但最终提交/配额重试也须重验；清历史使用 ledger 队列，可并发删 request，仅 U 队列不足 |
| 归档与锁 | `background.js:1096` 归档删除；`:6008` `releaseExactCaptureExecutionLockSnapshot`；`:7608/7647` active/stored 锁读取 | 归档在原 archive 队列内比较 id/attempt/updatedAt/scope；复用现有七字段锁快照比较。active 锁读取会清理/重载，strict 预检只能用纯 stored 读 |
| 恢复准备/创建 | `background.js:9671/9774/10043` prepare/manual recover | cleanup/完整云同步先于创建 mutation，归档删除仍是 requestId-only；必须在第一次副作用前验证源，创建和归档提交时再次核验 |
| 恢复启动与自动消费者 | `background.js:9086/9108/9135/9182` `launchPendingUnattendedRecovery`；`:9294` 自动恢复 | 当前先清任意 unattended 锁，再核对 request/Attempt，再在队列外开页。后继失效不得启动，也不得关闭后来复用的 runner/用户平台页 |
| 运行资源 | `utils/capture/lifecycle/attempts.js:273`；`cleanup.js:177/222/233/240/244` | stable taskId 重取当前资源、写 detaching、清 overlay、强制 Debug detach、按裸 tabId 关 worker、清 owner/runtime；每层都须贯穿同一快照而非只给 request 加参数 |
| 资源管理器 | `debug-session.js:948/971/1235`；`task-tab-group.js:530`；`task-owner.js:140`（均在 `utils/capture/`） | Debug 有可选 Attempt/run 比较，但旧 wrapper force:true，且比较前会取消 pending detach；group 已有可选比较但上层没传；owner clear 仅 taskId，需有限 generation/owner 比较 |
| 工作页取消 | `content-v2.js:2114` `handleCancelCapture`；`:58` list cancellation；`utils/scroll.js:17/31` | 任意非空 listRunId 可置页面共享取消位，overlay 取消也未完整受 captureId 匹配保护。后台先 inspect 再发旧 cancel 仍有竞态，不能当严格取消 |
| 调度与云端尾部 | `background.js:7295` cancel 的 launchDue 调度；`:10055/4173` 完整云同步；`server/routes/capture-cloud.js:8066` resume payload | 取消可能顺带启动到期计划；完整同步还执行其他云命令。云 resume 尚缺严格源 Attempt 贯通，必须另批授权，不能借“确认源”隐含触发其他任务 |

### 后续独立授权的实施范围（本批未实施）

第一道授权建议仅覆盖本地严格路径，保留全部无 strict 字段的旧行为；不更新 manifest、平台选择器、采集等待、重试预算或存储格式，不做 L5 的大迁移。候选文件白名单为：

1. `background.js`：严格入口与纯读源验证；当前/归档源 CAS；最终 ledger 提交和配额 retry 重验；归档删除；逐阶段取消、恢复、启动与尾部调度守卫。
2. `utils/capture/execution-identity.js`：严格身份谓词与七字段锁身份复用；不改变旧 attemptless/tab fallback 谓词。
3. `utils/capture/lifecycle/attempts.js`、`utils/capture/lifecycle/cleanup.js`、`utils/capture/task-runtime.js`：可选精确资源快照贯穿、幂等回收及拒绝结果；不得清当前新任务状态。
4. `utils/capture/debug-session.js`、`utils/capture/task-tab-group.js`、`utils/capture/task-owner.js`：原队列内先校验再副作用；strict 不 force、不凭 stable taskId 或裸 tabId 清资源。
5. `content-v2.js`：仅取消入口增加可选 strict 围栏，在同一次消息同步处理段核验 capture/list 身份及可证实独占活动后，才改共享取消位或 overlay。`utils/scroll.js` 仅回归，不改采集语义。
6. 对应既有测试与新增 strict control/content 竞态测试、架构计划。上述为 **9 个运行文件** 加测试/文档；若实施发现必须越过白名单，应先停止并说明，而非自行扩张。

严格目标至少需要明确的命令版本、requestId、源 Attempt、源版本与有效 scope；资源动作另外带可核验的 lock/owner/document/run/list 身份。expectedUpdatedAt 只用于首次源 CAS，后续使用成功提交所得阶段身份，避免自己的写入造成假冲突。调用者提交这些字段不等于可信：当前身份/权限必须由可信提供者重新核验；U 的历史读取许可、缓存 verified 或诊断状态都不能直接转为命令权限。缺真实提供者时不启用严格命令，C 的身份供给和接线门不关闭。

保留现有 U/ledger/archive/runner/lock/资源队列，逐阶段核验；不新增第二套全局队列，不 U→U 重入，不持 U 等会重新进入 U 的完整云同步。外部页面和网络无法回滚为原子事务，失效后只可精确回收本次创建且身份仍匹配的资源；不明资源保留并要求人工处理。不能仅凭“消息发送成功”提示“停止完成”。

证据完备且无需运行清理的 exact 终态/归档，可作为最先验证的有界子集；存在运行资源、旧 content 不支持 strict、身份缺失/变化、云接管未确认时明确拒绝。active cancel 与本地 recover 必须等后台、资源、content、runner 整条安全链通过后才可启用，不能将子集通过标作全链完成。

第二道授权单独覆盖服务端 `server/routes/capture-cloud.js` 与相关云命令/编排测试，贯通 expected source Attempt 和现有 local-closure/adoption receipt。它不属于第一道本地授权，不包含迁移、部署或真实采集。旧云 stop/resume/监督器/禁用计划仍须兼容回归。新增生产授权和客户交付另行审批。

### 严格修复的验收矩阵（待执行，不是本轮通过项）

| 场景 | 必须证明 |
| --- | --- |
| 同 request 的 A→B Attempt 在入口、排队或提交前切换；同 Attempt 的版本/scope变化 | 旧命令拒绝，B 的 request、ledger、archive、锁、页面、owner 不变；不先清理后报冲突 |
| 配额失败，重试前更新或清历史；归档读取后同 ID 被替换 | retry 内再次 CAS，不重放旧 request、不复活已删记录、不误删归档 |
| 同锁 ID 的 holder/document/tab/Attempt 更换 | 不 relay、不清绑定、不释放新锁；缺字段不得作为通配符 |
| Debug/group/owner 在 await 期间重新绑定；worker tab 被复用或移组 | 各层先匹配再动作，旧回收不 detach/关页/清 overlay、runtime 或 owner；重试也重验 |
| 旧 capture/list 消息抵达新页面活动；旧 content 无 strict；同页无法区分活动 | 不改 cancelFlag、不取消 overlay、不记错 list cancellation；拒绝且不降级旧消息 |
| 终态但 outbox/收口 marker 未完成 | 不提前关闭 runner，不伪造本地或云端收口成功 |
| recover 源 CAS 后、开页前后被替换；adoption 未确认或被别的 Agent 赢得 | 不启动失效后继、不伪造 item-attempt；只精确回收本次新建且仍归属的 runner |
| 旧无 strict 消息、旧 UI/云命令/监督器/禁用计划 | 原消息形状、采集规则、平台等待、重试预算和行为场景全部保留 |
| 拒绝路径全副作用审计 | 日志证明无 storage 写、relay/reload、tabs create/remove、Debug detach、owner clear、schedule launch 或 fullsync |

保留并扩展：`tests/background-capture-lock.test.mjs`、`tests/capture-local-closure-proof.test.mjs`、`tests/capture/{execution-identity,debug-session,task-tab-group,task-runtime,task-owner}.test.mjs`。本次只读审计未执行上表的新增验收，未修改上述 9 个运行文件或服务端。
