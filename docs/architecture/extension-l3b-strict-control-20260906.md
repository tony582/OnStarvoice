# L3-B 严格控制基础：已验证的边界与未启用能力

## 结论与授权

本批不是完整停止/恢复修复。它在已授权的 9 个运行文件内实现严格入口拒绝、内部精确存储原语、资源检查及页面取消拒绝；保留无 strict 字段的旧行为。**所有对外严格停止/恢复仍未启用；不能宣称客户已受益或旧安全问题已消除。**

用户在上一轮 9 文件清单后明确“允许，继续吧”。从 #58 精确最终 `5ef340c625f764e9228cd965740208b425f886bb` 创建隔离工作树 `OnStarvoice-extension-l3b-strict-control-20260906`，分支 `codex/extension-l3b-strict-control-20260906`。创建前核验 #58 为 OPEN + Draft + CLEAN；父提交两组 CI 12/12 已核验，不能代替本批 CI。

允许本地修改、合成测试、提交、普通推送、新 stacked Draft 及精确 head CI。禁止 Ready、合并、部署、迁移、split、客户 Extension 安装/Reload/更新、真实鉴权/客户数据 API、新采集及处理 PR #29。原 dirty 工作树、#58/其他旧 PR 与 main 不改。测试快照只在新隔离工作树生成，不是客户更新包。

## 为什么没有启用完整命令

| 必要证据 | 实际代码中的缺口 | 本批处置 |
| --- | --- | --- |
| 当前身份及命令权限 | 后台 `readCloudTaskAgentCredential` 只读缓存 id/token；`ensureCloudTaskAgentScope` 是带写入的本地记账；UI verified 是缓存。无“当前 tenant/binding + 精确命令目标 + 操作权限”的可信提供者 | 对外携带 `strictControl` 的取消/恢复一律拒绝；不接受调用者 permission/verified/token 声明，不调用真实接口补造证据 |
| 页面活动独占 | `runTrackedCaptureRequest` 忽略空 captureRequestId；一个具名和一个匿名活动同时运行时，旧 inspect 仍可能显示 activeCount=1。页面没有完整 document/Attempt/owner 绑定，共享取消位还被其他处理器使用 | `handleCancelCapture` 对严格消息同步拒绝，不修改共享位/列表取消记录/overlay，不退回旧消息 |
| 安全资源回收 | 原 native detach/ungroup/remove 没有原子 document 条件；先读标签再关闭仍有复用窗口，stable taskId 不是当前 generation | 严格活动资源清理拒绝；仅允许只读观察指定资源记录是否为空，结果始终 released=false，不是后续操作的租约 |
| 恢复启动和云接管 | 旧恢复器仍存在源校验前清锁及队列外开页；完整云同步可能执行其他命令，云协议缺严格源贯通 | 不接旧启动器，不启用 active cancel/local recover，不动服务端或 E1e/E1i |

这不是用“disabled”冒充全链修复，而是在实际证据不足时保留明确阻断。以下内部原语可离线验证，但不能绕过权限/资源/页面/runner 门。

## 运行文件及接口

仅以下 9 个运行文件发生变化；未改 manifest、加载器、selector、平台采集等待/重试、存储 schema、server、web 或 CI。

| 文件 | 本批职责 |
| --- | --- |
| `background.js` | 两类旧消息的 strictControl 拒绝前置；内部终态元数据提交；可选严格归档精确删除 |
| `utils/capture/execution-identity.js` | 四个独立严格身份谓词；旧 7 个宽松兼容 helper 不变 |
| `utils/capture/lifecycle/attempts.js` | 两个资源 wrapper 透传 strictResources，不能顺带清锁或终态化 |
| `utils/capture/lifecycle/cleanup.js` | 严格资源只读观察，缺证据/有资源拒绝；不进入旧回收链 |
| `utils/capture/task-runtime.js` | 严格资源期望快照与只读检查；严格 worker/native 清理拒绝 |
| `utils/capture/debug-session.js` | 既有队列内先拒绝，不能先取消 pending detach 或 force 清理 |
| `utils/capture/task-tab-group.js` | 既有队列内先拒绝，不能先改 group 或解绑标签 |
| `utils/capture/task-owner.js` | 严格 clearTask 拒绝，不把 stable taskId 当 owner generation |
| `content-v2.js` | 仅取消入口前置严格拒绝；旧函数体与旧活动追踪不变 |

消息示意：`strictControl: {version:1, requestId, attemptId, updatedAt, agentScopeId}`。存在字段即进入严格分支，包括 null/false/undefined/未知版本；无此字段才保留旧行为。后台完整但无可信提供者返回 `strict_permission_provider_unavailable`，格式错误返回 `strict_source_invalid`；页面返回 `STRICT_CONTENT_CONTROL_REJECTED / CONTENT_ACTIVITY_IDENTITY_UNPROVEN`。调用成功、发送成功都不代表已停止。

资源示意：`strictResources: {version:1, taskId, attemptId, runId, debug:null, group:null, owner:null, runtime:null, workerTabIds:[]}`。严格期望在等待前固定；原始 runtime 缺字段不是空，不能使用宿主补默认值后的记录。读取后重新检查 manager/owner/pending/inflight。即使观测为空，也仅返回 `observed:true, released:false, mutated:false`；没有涵盖执行锁、页面活动、outbox、所有标签，也不构成本地收口证明。

## 内部存储原语的精确边界

### 终态元数据

`persistStrictUnattendedTerminalMetadata(request, {strictSource})` 是未接外部命令的后台内部原语；不是停止、恢复、完整“保留结果”业务操作，也不核准关闭任何资源。

- 原始源必须自带 id/Attempt/updatedAt/cloudAgentScopeId；不通过会合成 `legacy-*` Attempt 或补 scope 的 normalizer。
- 只处理终态且不包括 needs_action；调用方指定终态必须与原 request 和唯一 ledger run 一致。新时间戳必须有效并严格前进，首次提交后的旧命令不可重放。
- 只更新 request 的 recoveryDismissedAt/recoveryDismissedMessage/updatedAt 和对应 ledger run 的 updatedAt；保留正文、进度、收口/outbox 标记、其他任务及计划。共享 ledger 时间不倒退。
- 内部取得已有 U→ledger 队列，最终读 raw request/auth/ledger 后比较再提交。不得在已持 U 的调用者中重入本原语；目前无生产调用者。
- 配额只重试一次，重新进入 U→ledger 并重读。没有 reserve 释放/异步恢复、compaction、完整云同步或 launchDue。第一次写失败后再拒绝意味着有一次失败的 set 尝试，但无成功业务写入；不把它描述为“从未尝试写”。
- auth 的匹配只是此次存储快照，不证明当前权限，也不和其他 auth writer 构成原子授权。这里的串行比较写入只覆盖遵守相同队列的参与者，不是 Chrome storage 原生跨系统事务。

### 归档精确删除

`removeArchivedUnattendedKeywordRunRequest(requestId, {strictSource})` 在原 archive 队列内，比较原始容器 scope、目标行 id/Attempt/updatedAt/scope 和缓存 auth scope。只删该行，保留其他原始条目，不因 normalize/保留期截断删除无关数据。缺失、替换、重放均拒绝。

它是独立的单存储原语，**没有和 request/ledger 合成整项事务**；不检查运行资源、云接管或本地收口，不允许直接接 UI。旧仅 requestId 调用仍走旧兼容函数体。

## 已执行与仍未执行的验收

| 场景 | 本批证据状态 |
| --- | --- |
| 旧源排队期间 Attempt/版本/scope 更换；ledger 清历史先完成 | 内部存储测试：拒绝，不覆盖/复活源 |
| 同源并发两次提交；成功后的新版本再次提交 | 首次成功、旧版本拒绝；request 与 ledger 版本同步前进 |
| 配额失败后更换源/清历史；普通磁盘错误 | 仅配额有一次重验重试；不重放旧源、不调用 reserve 或其他清理 |
| 同 ID 归档替换、scope/版本/缺 Attempt | 原 archive 队列内拒绝，保留替换行与其他条目 |
| 完整伪权限/缓存 verified/token、空/错误 strict 字段 | 完整后台宿主两类监听器均零副作用拒绝；旧消息成功对照仍通过 |
| 资源等待期间重新绑定；strict malformed/未知资源 | 拒绝且保留资源；空观察不等于 release/closure |
| 旧 capture/list 消息与具名+匿名并发 | 页面严格拒绝、无取消位/overlay/列表记录变化；具名+匿名证明旧 inspect 不足 |
| active cancel、local recover、开页前后后继替换、云 adoption | 未启用、未取得全链成功验收；外部严格拒绝不能冒充这些场景已修复 |
| 真实 Chrome/Edge、8 小时/72 小时、客户版本和业务采集 | 未执行；保留 L6/客户交付审批 |

历史 L1 的 54 项 fixture 不改，只对 3 段新增严格前置单独固定 hash 后，继续校验原完整函数体；content 旧取消原文 SHA256 与父提交一致。原有测试不减项、不跳过。

### 本地交付证据

- 运行源码与测试提交：`b18c8d0aa3e8d7c0aa308a55bf7333c911f17f1c`；之后只补计划文档，最终 head 单独核对 CI。
- Node 24.12.0 / 18.20.8 官方全量各 **2,468/2,468**，0 失败/跳过；相对父提交新增 182 项。
- 新增项：完整后台宿主 47（该文件完整各 285/285）、身份 10、存储竞态 37、内容页 35、资源 53。均使用合成状态和故障，不连接真实浏览器/网络。
- L3-A/L3-B/旧 adapter 三个精确 Git 基点对照组合，双 Node 各 **117/117**，包含两条实际宿主启动路径；不是沿用父提交的执行结果。
- 旧 `persistUnattendedRunMutation` 与父提交逐字一致。保留原 L1/L3 历史 fixture，未改采集、同步、UI 或平台场景。
- 初次全量因新工作树尚未生成隔离 `extension-build`，1 个旧快照测试读取失败；补齐本工作树快照后，两组全量重新通过。没有跳过或改写该测试。
- 隔离快照 166 文件、manifest 0.4.5，逐文件 SHA256 清单摘要 `6fef408ee50c1c5e9064a83d20667eefc770b1d471450e73504d6a69640956f4`。原客户参考仍 95 文件、0.4.5，摘要 `554479f7e01198ba0e6f7c2eb3d16e58c55db773aaadad90ecea5d6b039d1f87`；这不是所有客户安装版本证明。
- 9 个运行文件双 Node 语法、仓库卫生 863 文件、隔离快照和差异空白检查通过。server/web/manifest/loader/scroll/Sidebar/CI 与所有历史 fixture 相对父提交无差异。
- 独立源码复核已修正 U→ledger、严格版本前进、旧 terminal_absorbed 误用、共享 ledger 时间倒退、默认运行状态误当原始空证据等问题；当前没有阻断本批“拒绝入口＋内部原语”交付的剩余发现。
- 无本任务历史的独立文档读者核对本文件、统一路线图及总计划第 10 节，正确区分 7 项能力/发布/授权问题；两处历史时点措辞已澄清，无阻断性歧义。核读不代替代码、CI 或实机验证。
- 最终 head、Draft PR、push/PR 两组 CI 以本批 PR 正文及任务交付精确记录；不沿用父 CI，也不为更新 CI 状态循环制造新提交。

## 后续固定顺序，不临时跳阶段

1. 收口本批离线测试、独立复核和新 Draft 精确 CI。保持 B/L3 未完成；不为了文件减行继续搬小 helper。
2. 在实施完整命令前，先明确可信当前权限提供者与目标协议。此项属于 C 的必要前置，不是顺带启用历史读取许可；涉及 UI/auth/API 适配的新增文件需先列白名单再授权。
3. 补完整页面生命周期身份（包括匿名活动和共享取消位）、资源 generation/合作式回收与 runner 启动围栏。现有“仅取消入口”范围不能补造这些绑定；平台规则、等待和重试仍保持不变。明确需要保留的用户标签与不能证明归属的资源。
4. 云 expected source Attempt 与 local-closure/adoption receipt 按原第二道授权单独推进；不借本地原语调用完整云同步。
5. 上述前置通过后才启用严格停止/恢复，并执行原 9 文件合同的整条竞态验收，再收口 B；C 接新 UI/U5、之后 L4 来源/独立平台、L5 后台宿主、L6 实机长期。服务端 PR #37/G3 和 P8/G8 继续保留。

没有新的客户发布授权。本批没有证明 MediaClaw 法律风险已消除，也没有把 UI 原型或代码身份分离算作独立产品验收。
