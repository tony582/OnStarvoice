# StarVoice ToB 自愈控制面与智能值守 Agent 实施方案

> 文档状态：V4 实施与发布验收版，已合并 2026-08-27 安吉星生产实跑、现场反馈、`0.3.93` 代码审计、`0.3.94`/`0.3.95` 事实与 `0.3.96` 简化编排本地 Hotfix
> 首次编制：2026-08-24；本次修订：2026-08-28
> 能力基线：本方案按产品口径将 `0.3.91` 晨间稳定性优化视为已交付前置能力；生产发布、客户端生效范围和版本心跳仍由独立发布台账记录
> 目标读者：产品负责人、后端、Extension、Admin、测试与运维

## 0. 关键修正与决策摘要

本方案不再把所有自动恢复能力统称为“Agent”。StarVoice 要交付的是三层不同产品能力：

1. **自愈运行时**：Extension 与服务端用固定状态机解决已知故障，例如 Tab 重建、检查点续跑、同步退避和技术失败接力；
2. **无人值守自愈控制面**：跨任务、设备和数据链路做确定性观察、熔断、调度、动作审计与恢复验证；
3. **智能值守 Agent**：只在规则无法唯一解释的长尾事故中，自主选择证据工具、形成假设、提交受控动作建议、观察执行结果并重新规划。

前两层不依赖 LLM，也不应以“AI Agent”包装。智能值守 Agent 必须在前两层通过准入门槛后才进入生产；DeepSeek 或其他模型不是第一实施批的依赖。

成功标准不是“系统有自动重试”，而是：

> 运营负责人不再为了确认无人值守结果而固定早起；只有在控制面与外部哨兵健康、红色事项为零且晨报已送达时，才表示无需处理，而不是只看到了进程在线或通知已入队。

### 0.1 什么算 Agent，什么不算

| 能力 | 正确定义 | 是否需要 LLM |
|---|---|---:|
| `No tab with id` 后重建工作页 | Extension 自愈机制 | 否 |
| 超时重试、失败词补跑、坏节点熔断 | 服务端调度与控制面 | 否 |
| 根据固定错误码调用固定 API | 规则自动化，不是 Agent | 否 |
| 跨设备、任务、落库和 AI 证据定位未知主因 | Agent 调查 | 仅歧义时 |
| 根据新证据改变假设和处置顺序 | Agent 规划 | 是 |
| 在动作失败后选择不同探针或恢复路径 | Agent 重规划 | 是 |

判断标准：

> 如果系统只是把错误码映射到预设动作，它是自动化；只有在目标不变、路径不确定时，系统能够自主取证、行动、验证并改变计划，才是 Agent。

### 0.2 产品优先级

- **P0：不再固定早起**。先交付自愈运行时、控制面、独立失联哨兵和可信晨报；
- **P0 Gate：安全闭环**。完成标准工具、策略闸门、动作台账、业务级验证，并通过第 15 节 P0-4 真实生产门；
- **P1（受开发准入门和生产启用门约束）：智能值守 Agent**。只处理前两层无法解释的长尾事故；
- Agent 不得成为已有稳定恢复链路的单点依赖，模型不可用时 P0 能力仍需完整工作。

### 0.3 术语约定

| 术语 | 本文含义 |
|---|---|
| 执行端 Agent | 安装 StarVoice Extension 的 Chrome/Edge 客户端，负责实际页面采集 |
| 自愈运行时 | Extension 与服务端已有的本地恢复、检查点、租约和接力机制 |
| 自愈控制面 | 服务端确定性观察、策略、动作和验证组件，不是 LLM Agent |
| 智能值守 Agent | 只处理歧义长尾事故的模型工具调用循环 |
| 外部哨兵 | 与主应用不同故障域的只读存活监控 |
| 一次性安全复核 | 仅对白名单 `eligible_search_challenge`，在源 lineage 已静默后换一个未尝试的不同平台账号重做原业务步骤；不是解题或绕过验证 |

核心技术选择：

- 服务端常驻控制面，而不是依赖个人电脑上的本机 Agent；
- 确定性状态机负责状态、权限、预算和动作合法性；
- LLM Agent 只负责歧义事故的取证规划、假设更新和可读解释；
- 复用现有恢复、接力、停止和通知用例，不复制第二套任务状态机；
- 所有动作具备租户边界、幂等键、尝试预算、冷却时间、审计和验证结果。

### 0.4 2026-08-27 生产实跑对方案的修正

今早跑通了一次完整的人工值守演练，但没有证明现有值守 Agent 已能自动接管。最终小红书父任务 `13/13` 收口，抖音「凯迪拉克车机升级」也在跨账号安全复核后完成；但关键动作仍由 Codex 直接对账生产事实、构造带前置条件的受控交易并持续监测完成。因此 V4 的结论是：

> 今早证明了「正确的接管逻辑可行」，同时也证明「产品化执行权闭环尚未交付」。P0 不是再加一个会分析的模型，而是把今早人工完成的取证、对账、接力、临时收缩候选池、验证和恢复候选池做成可重放的受控用例。

本轮用于修正方案的生产事实如下：

| 生产事实 | 对原方案的修正 |
|---|---|
| `ibuick / 别克APP / 至境哨兵` 有真实 observation，但云端投影需人工对账；`安吉星 / 别克壁纸` 本来已完成 | 增加「有证据的迟到完成对账」用例，不得根据 UI 状态批量改成功 |
| 历史共出现 20 次 `CREATE_COMMAND_EXPIRED` | 命令过期必须与业务 attempt 分账；未 ACK/未 START 不得消耗业务次数或伪造失败项 |
| `别克APP / 至境哨兵` 在云端终态后仍实际采集约 17 分 37 秒 / 22 分 19 秒 | 引入 `draining → verifying → completed` 两阶段终态，父任务不得只依赖 item 投影收口 |
| `别克OTA / 凯迪拉克OTA / 别克车机升级` 收缩候选池后均成功接力，另一个运行中的「凯迪拉克车机升级」也在部分失败后由上海接手 | 真失败应只重试未完成项；临时候选池必须带基线、TTL 和自动恢复 |
| 抖音首次真实验证码前还有一次技术心跳失败，现有逻辑把两者共用总 attempt 预算而提前转人工 | 新增独立 `safety_handoff_count`：不破解验证码，但允许在严格条件下换一个不同平台账号做一次安全复核；新账号再次触发验证码/安全挑战立即转人工 |
| 定向到名为「地球」的执行端 Agent（不同平台账号）后抖音完成，新验证码为 0，最终无 active attempt/command/snapshot 残留 | 这条由人工构造和验证的处置路径在一个真实样本中成功；它证明路径可行，不代表产品化自动接管已经交付。该动作仍属确定性控制面，不是 LLM 自由操作 |
| 全部任务完成后，父任务候选池仍保留临时收缩值 | 候选池恢复是动作本身的必须后置条件，不能留给人工收尾 |

今早最终成功验证了合格的业务收口不取决于一个 `completed` 字段，而是同时满足：工作项终态、active attempt/lease/command 为 0、无双 active、最终 terminal snapshot 后无非终态快照、quiet window 内无新 observation、当前 lineage 占用的执行端槽位归零。要让 control run 真正关闭，还必须恢复临时候选池、即时核验当前父任务与计划模板，并登记 `next_occurrence_guard`；下一 occurrence 的实际核验延后执行，不阻塞当前 run。这组不变量在 V4 中升为 P0 硬门槛。

### 0.5 P0-4 验收通过后，运营负责人在夜间会感受到什么

下面不是技术愿望，而是 P0 完成后必须在 Extension 与指挥中心中直接看见的用户旅程。表内时限是首轮灰度目标，最终以第 12、15 节真实生产验收为准。截至 2026-08-27，这些是 P0-4 的完整验收目标；`0.3.94` 已覆盖其中一批确定性运行时与自动接力闭环，逐项事实和仍未交付边界见第 15.0.1 节。源码、提交、推送、服务端发布、Extension 逐 Profile 生效、生产闸门和真实灰度仍是独立证据门，不能互相替代。

正常使用契约只有一句话：计划按原方式触发或任务按原方式下发后，用户不再点“立即复核”、不再为失败关键词逐个挑设备、不再替系统关闭任务页，也不需要守着第一次验证码。控制面由任务事件自动唤醒；只有第 0.5.2 节的红线成立时，才允许发出一条带唯一处理动作的通知。这个契约描述的是 P0 验收目标，不是对当前 `0.3.93` 的已交付声明。

| 现场场景 | 用户可见状态 | 系统必须自动完成 | 唯一需要人工的条件 |
|---|---|---|---|
| Extension 已产生并保存业务证据，但云端仍把工作项标成失败/需处理 | 显示“已发现本地完成证据，正在对账”，不要求用户选择设备重跑 | 先证明原 lineage 已静默，再核验 observation、保存事实、范围和完整性；只对证据一致的原 attempt 执行 `reconcile_observed_completion`，不重跑已完成业务 | 证据互相冲突、保存不完整或无法唯一归因 |
| 云端工作项已终态，但 Extension 仍在采集 | 父任务显示“业务已结算，浏览器排空中”，并列出具体执行端 Agent、当前阶段、最后进展和待上传数；绝不显示绿色完成 | 保留真实本地运行态，精确停止旧 lineage，排空上传、锁和任务自有页面；收到 `local_closed_at` 后再判完成 | 排空命令失败且超过硬截止，或无法证明页面归属 |
| 一台机器出现首次白名单搜索验证码 | 该账号显示“已隔离，正在换另一个安全账号复核”，其他关键词继续运行；不会让整批停着等用户 | 撤销源 lease，等待静默，优先选择未尝试、日搜索占用较低的不同平台账号；目标在 30 秒内完成派发、60 秒内开始是首轮 SLO；不同账号可能位于同一或不同物理机 | 第二个账号再次挑战、登录失效或没有合格账号 |
| 同时有 3–4 个小红书失败词 | UI 展示逐词自动分片，例如“3 个正在接力、1 个等待空闲槽位”，每个词有独立去向和进度；若用户主动逐词指定 Agent，该 Agent 随后变忙时明确显示“严格等待，不会改派” | 按 item 原子领取并行分给多台合格空闲 Agent；成功词不重跑。若 4 个词只有 3 台合格空闲 Agent，就先派 3 个，剩余 1 个留在同一父任务中等待下一槽位，不整批 409，也不让用户手工挑一台 | 所有合格容量持续不可用且将突破业务硬截止，或用户显式暂停自动接力 |
| 抖音网络变慢，搜索结果已出现但筛选尚未确认 | 显示“已看到本次新结果，等待筛选确认”，倒计时来自当前阶段而非整任务 | 把可见新结果当作进展，进入降级等待并做幂等探测；不判离线、不消耗业务 attempt、不重新提交整词搜索 | 超过按平台/模式/host 负载计算的硬截止，且一次探测仍无任何新进展 |
| 一个关键词在正常预算内确实失败 | 显示“正在使用备用恢复轮 1/1”，并明确目标 Agent、选择原因和保留的成功结果 | 仅对失败 item 创建一次独立恢复轮，优先选择日搜索量较低的健康 Agent；沿用检查点，不重跑整批 | 同类错误再次出现、恢复轮无业务进展或没有安全容量 |
| 负面巡检逐条打开帖子 | 一个任务默认只保留 1 个任务自有详情工作页并循环复用；任务结束后自动关闭 | 用 `task_id + attempt_id + revision` 登记页面所有权，成功、失败、取消、超时均在 `finally` 清场；启动时回收无活动 lease 的孤儿工作页 | 只能报告无法确认归属的页面，绝不关闭用户自己的标签页 |
| 用户关掉上一次任务完成页，随后 reload Extension | 直接显示当前任务；没有当前任务则回到空闲页，不再弹回旧完成页 | 持久化 `last_acknowledged_terminal_task_id` 或清除活动展示指针，并以云端 lease + 本地运行态重新对账 | 无需人工；历史仍可在任务中心查看，不作为活动弹层复活 |
| 本地存储接近或达到配额 | 先显示“正在同步并释放安全缓存”；红色时停止接收新详情。若最小控制写仍失败，界面最迟在“接管阶段硬截止 + 60 秒 sweeper”内转为“本机存储已满，已停止接管；未同步数据仍保留”，绝不继续显示数小时“正在接管浏览器” | 预检水位，分区存储，安全压缩仅删除已 ACK 且过保留期的数据；释放控制保留区后只重试一次，保护 unsynced；仍失败则服务端撤租、把未开始项接力且不扣业务 attempt | 存在无法同步的关键数据时发送一条红色通知；用户不需要守着旧浏览器等待 |
| 一整夜都正常或已自动恢复 | 晨报只给一个结论：“无需处理”；可展开看自动恢复明细，但不要求用户逐台确认 | 验证父/子/item/attempt/lease/command/page/upload/落库全部收口，临时候选池已恢复 | 只在红色条件出现时即时叫醒，黄色恢复项留在晨报 |

#### 0.5.1 交付后的三个夜间验收剧本

这些剧本描述的是 P0 完整交付后的可观察结果，不是对当前 `0.3.93` 的能力声明。验收时必须用真实 7–8 浏览器同机负载与跨机执行端复现，不能只用离线单测代替。

**剧本 A：网络慢，但系统自己等对。** 22:15 批量任务启动；22:27 抖音已经出现本次结果，但筛选控件还未稳定。页面和指挥中心同时显示“已看到新结果，等待筛选确认”，任务保持黄色推进态，不变成失败、不重复提交同一个搜索词。22:29 筛选确认后继续详情采集；若一次幂等探测后恢复，整件事只进入晨报的“已自动恢复”，夜里不通知用户。

**剧本 B：一个账号验证码，其他任务不停。** 22:43 某抖音账号首次触发白名单搜索挑战；该账号立即隔离，原页面保留现场但不再执行，其他关键词继续。控制面等待源 lineage 静默后，把该关键词一次性派给日搜索占用较低、从未尝试过的不同平台账号；它可能在同一台或另一台电脑，安全边界看账号而不是机器名。目标是 30 秒内完成派发、60 秒内开始。如果新账号正常完成，夜里不叫用户；如果第二个账号再次挑战、登录失效或没有安全容量，只发送一条红色通知，明确写出“哪个关键词、哪两个账号、现在唯一需要做什么”，不让用户自己翻 14 台浏览器找原因。

**剧本 C：多个真失败自动分散收口。** 小红书有 4 个词在普通预算内真实失败，成功的 9 个词保持完成。若当时只有上海、霸王龙、金星 3 台合格空闲执行端，系统先原子派发 3 个 item，第 4 个明确显示“等待空闲槽位”；任一槽位释放后自动领取第 4 个，不让用户先选一台，也不因容量少 1 台而把整批退回。仍失败的单个 item 最多再使用一次“备用恢复轮 1/1”。每个词都能看到原执行端、接力执行端、选择原因和当前阶段。任务结束后，任务自有平台页与 runner shell 自动归零，旧完成页 reload 不复活；晨报给出“13/13 已收口，其中 4 个自动接力、1 个使用备用恢复轮、人工处理 0”。

验收通过后，用户早上首先看到的不是 14 台设备日志，而是一张可以直接相信的结论卡：

```text
昨夜值守结论：无需处理
业务工作项：13/13 已收口
自动恢复：4 项（其中备用恢复轮 1 项）
人工事项：0
残留：活动 attempt 0 · lease 0 · command 0 · 任务自有页面 0 · 待上传 0
控制面 / 外部哨兵：正常 / 正常
```

如果晨报生成时仍有健康任务在推进，结论卡必须写“仍在执行，当前无需人工，控制面继续守候”，随后在真正收口或转红时自动更新；它不能为了给出绿色结果而把运行中的浏览器提前算成完成。

任何时候用户打开指挥中心，只允许出现四个相互排斥的总状态：`正常运行`、`自动恢复中`、`需要人工`、`已收口`。不得再出现 Extension 肉眼仍在采集而后台只显示失败、任务已经结束但浏览器继续跑、或历史完成页反复弹出的第五种模糊状态。

#### 0.5.2 什么情况下才允许夜里叫醒用户

只有以下红线可以即时通知：第二个平台账号再次出现验证码/安全挑战；登录失效；未同步关键数据在安全压缩后仍无法写入；浏览器失控持续运行且精确停止失败；没有任何合格执行端且本轮业务硬截止将被突破。普通慢网、首次启动误判、单 Agent 离线、一次命令过期、一个关键词普通失败、第一次白名单安全挑战和已经自动恢复的故障都不得即时打扰，只进入晨报。

即时通知必须合并同一事故指纹，并且只提供一个明确入口和一个动作，不得连续发送“失败了”“又失败了”却让用户自己判断。用户处理后，控制面负责继续验证、恢复候选池和收口，不要求用户再回来点一次“立即复核”。

### 0.6 2026-08-27 九项现场问题的明确结论

| 现场问题 | `0.3.93 / 911e8d6` 已确认原因 | V4 必做改变 |
|---|---|---|
| 小红书本地已有完成证据，后台仍失败/需处理 | Agent 存活心跳可以保持新鲜，但 child task heartbeat 已过期；observation 又是独立到达。stale reaper 只依据 task heartbeat 撤销 lease，撤租后旧 attempt 的 snapshot 会被 fencing 正确拒绝；真正缺口是没有 late-evidence verifier / `reconcile_observed_completion` | 补 `reconcile_observed_completion`：先证明原 lineage 静默，只在 observation、保存事实、范围/完整性和 attempt 归因一致时回补业务完成；后续未启动的虚假 attempt 只封存，不重跑 |
| 云端已终态，小红书 Extension 仍继续运行 | `business_status`、child/item 投影与真实本地 runtime 没有两阶段终态；缺少权威 `local_closed_at`，父任务可在页面、锁或待上传仍存在时先判完成 | 将 `business_status` 与 `local_runtime_status` 分栏；当前 lineage 终态后仍活跃即生成 `terminal_runtime_residue`，执行 `quiesce_terminal_execution`，只有页面/锁/待上传归零且收到 `local_closed_at` 后才判绿 |
| 一台验证码后整项原地等人 | 发布逻辑把验证码/登录统一留在原 Agent；技术、业务和安全预算又未完全分账 | 登录失效仍直接人工；首次白名单搜索挑战隔离源账号并允许一次不同账号复核，其他未开始项不受阻；第二次挑战绝不继续扩散 |
| 3–4 个失败词只能选择一个空闲 Agent | Admin 的 `/retry-items` 路径把所有 `itemIds` 与单个 `targetAgentId` 一次提交；终态后的自动恢复已停止 | 默认 `shard_retryable_items` 自动分片；一词一 lease，多 Agent 并行原子领取；人工兜底改成“自动分配预览 + 可逐词覆盖”，不再提供“全部塞给一台”的默认动作 |
| 抖音慢网下结果刚出现就失败 | 现有“结果代际”门比肉眼可见卡片更严格；双 pass、预导航和重新提交搜索叠加，慢网/同机负载会把正常迟到当成 bootstrap 或 generation failure | 实现第 4.10 节唯一权威的九阶段状态机；软截止只进入阶段子状态 `degraded_waiting`，硬失败前做一次幂等探测，综合/图文独立工作项 |
| 真失败后不能自动再跑一轮 | 现有 retry 受普通 `maxAttempts` 约束，耗尽后进入人工路径；候选选择只看空闲、近期技术失败/成功和上次派发，不看当日搜索占用 | 新增每 item/occurrence 最多一次 `reserve_recovery_round`；只处理非安全、非登录、非取消的真失败，并按日搜索占用、host 压力、近期失败和公平性选目标 |
| 负面巡检每个帖子新建 Tab 且不关闭 | 服务端为每个帖子建立一个 elastic item/child；Extension 又按新的 `requestId + attemptId` 建 runner shell，并新开平台详情 Tab。现有 `finally` 只暂停媒体并把抖音送回首页，小红书甚至不回首页，两类页面都没有真正关闭 | 统一任务自有页面注册表、同一任务单页复用、runner shell 与平台详情页全终态清场、启动孤儿回收；只关闭带 owner token 的任务页面，绝不碰用户页面 |
| 关闭后旧负面巡检完成页 reload 又回来 | “关闭”主要依赖页面进程内的 dismissed 变量；旧 request/task ledger 仍可被合成成 terminal session，reload 后内存标记丢失 | 关闭确认持久化且与 task/revision 绑定；启动先对账当前有效 lease，无活动任务则不合成旧 terminal overlay |
| `Resource::kQuotaBytes quota exceeded` 后卡在“正在接管浏览器”约 10 小时 | 截图证明当时发生过 quota，但在未按 profile、时间戳和 key 对齐前，不能把它断言为该 10 小时假运行的唯一原因。已确认的危险链是：`unattended-report-outbox` 先写后裁剪，满额时可能永远无法自救；`data_pool` 整池 blob；通用 `setItem` 吞掉写失败；任务账本与 runtime/heartbeat 又共用该配额域 | 数据与最小控制状态分层、写前水位、outbox 先裁剪后写、ACK 后安全压缩、控制状态保留区和 quota 专用错误；配额失败不消耗业务次数，不接受新详情，保护 unsynced、释放执行权、清任务自有页面并上报 `storage_pressure`；以相关性证据再判断是否为长卡主因 |

这九项全部属于 P0 的确定性运行时和控制面，不等待 LLM Agent。判断是否完成也不看“有代码”或“接口返回 200”，而看第 12 节逐场景验收和第 15 节真实夜间窗口。

## 1. 问题与目标

### 1.1 当前问题

系统已经能够定时运行、自动重试和跨执行端 Agent 接力，但运维闭环仍由人完成：

- 需要人工判断计划是否真正产生了本轮任务；
- 需要把父任务、工作项、历史尝试、子任务和命令串起来看；
- 需要区分“历史失败但最终恢复”与“当前仍被阻塞”；
- 需要判断执行端 Agent 心跳新鲜是否代表业务仍在推进；
- 需要确认采集结果是否落库、AI 后处理是否继续；
- 自动操作后仍要人工复查是否真正恢复；
- 普通日报是业务报告，安全邮件只覆盖部分人工介入场景，缺少整夜运维结论。
- 命令过期、子任务终态和真实浏览器停止目前不是同一个事实，会出现假失败、提前终态和终态后继续采集；
- 临时收缩的候选执行端集合缺少自动恢复契约，会把一次故障处置泄漏到下一轮调度；
- 技术失败、业务失败和平台安全复核共用 attempt 预算，使首次真实验证码也可能被误判为接力预算耗尽。
- 终态后的失败词人工恢复把多个 item 一次提交给单个 `targetAgentId`，没有多 Agent 分片和日搜索量准入；
- 抖音结果可见、筛选确认和业务失败之间缺少慢网中间态，正常迟到会消耗 attempt 或重复整词搜索；
- 负面巡检的任务自有标签页、终态提示确认和本地存储配额没有共同的所有权与清场契约，异常后会留下页面、旧完成提示和长时间假运行。

### 1.2 产品目标

完整 P0 控制面必须实现：

1. 对每个应运行的无人值守计划给出可解释的最终结论；
2. 自动处理明确、低风险、可恢复的异常；
3. 对登录失效立即停止；对验证码不做自动解题，仅对白名单 `eligible_search_challenge` 在账号、预算和源静默门槛全部通过时尝试一次跨账号安全复核，再次触发即停止扩散；
4. 用下一次观察证明恢复，而不是把接口返回 `200` 当作成功；
5. 在配置时间前生成一份运维晨报；
6. 只在确需人工时即时通知，并提供唯一明确的处理入口；
7. 每项判断和操作都能追溯到结构化证据。
8. 任务完成时同时证明浏览器执行、待上传数据、命令和执行权均已清零；
9. 所有临时候选池和账号冷却变更均自动到期或随事故收口恢复。
10. 多个失败 item 默认自动分片到多台合格执行端 Agent，日搜索占用、账号安全、host 负载和存储压力共同参与准入与排序；
11. 在普通 attempt 预算耗尽后，只对证据充分的真失败提供每 item 一次备用恢复轮，不允许重置预算或形成无限循环；
12. 页面已显示本次结果时先保活搜索阶段并完成筛选确认，不把慢网直接解释为执行端离线或业务失败；
13. 任务自有页面在终态后归零，用户页面绝不被误关；关闭的终态提示不因 Extension reload 复活；
14. 配额压力不能阻止停止、锁释放、终态上报和清场，未同步数据不得为腾空间而丢失。

智能值守 Agent 的附加目标是：面对未写死处理流程的混合或未知事故，能够在受控工具集合内自行决定下一步取证和处置，并在动作无效时改变计划，而不是重复同一动作。

### 1.3 非目标

第一版不做：

- 自动解决验证码、扫码登录或平台安全验证；一次性跨账号复核只重新执行原业务步骤，不识别、点击或绕过验证码；
- 任意 Shell、SSH、SQL 写入或浏览器远控；
- 自动部署、回滚、修改 PM2/Nginx、切换生产版本；
- 自动修改 API Key、SMTP、平台账号或租户模型配置；
- 删除任务、尝试、事件、结果或为了界面好看而改状态；
- 无限重试或跨账号快速扩散平台风控；
- 重新实现一套本地任务账本或云端调度协议；
- 以模型微调替代任务状态机和运行策略；
- 为了展示“智能”而让模型参与每分钟巡检或所有已知故障；
- 把晨报文案生成、错误码分类或固定工作流包装成智能 Agent。

## 2. 可复用基线与真实缺口

### 2.1 已有能力

| 能力 | 当前基础 | 正确归属与使用方式 |
|---|---|---|
| Extension 本地监督 | 无人值守 supervisor、检查点、页面与业务进展检测 | 继续作为单执行端 Agent 内部自愈层 |
| 失败词有界重试 | 只重试失败子集，成功项不重跑 | 作为第一层自动恢复，不另写重试循环 |
| 云端自动接力 | 可重试工作项、空闲执行端 Agent 选择、尝试上限 | 控制面通过应用用例调用，不直接改表 |
| 弹性租约回收 | 超时、执行端 Agent 离线、任务心跳异常可重新入队 | 控制面观察结果并验证重新推进 |
| 安全阻断 | 验证码、登录、安全挑战进入 `needs_action` | 永不自动解题或绕过；登录失效和非白名单挑战直接人工，仅白名单 `eligible_search_challenge` 可在严格条件下交给不同平台账号复核一次 |
| 任务与执行端 Agent 总览 | 执行端 Agent 心跳、版本、运行/排队/需处理任务 | 作为感知数据之一，不单独决定健康 |
| AI 自动故障转移 | 有界失败切换和恢复探测 | 控制面只观察结果，第一版不改模型配置 |
| 邮件基础设施 | 安全通知队列、日报/周报/月报 | 新增独立的运维晨报和运维事件类型 |

`0.3.91` 晨间稳定性优化按本方案口径作为已交付基线，包含：

- 正常设备按 `0/6/12/18 秒`轻量错峰；两分钟内多台设备同时异常时追加 `10–30 秒`，总延迟最多 45 秒；
- 页面启动最多尝试 3 次，取消长时间阻塞等待；技术启动失败交给其他设备且不消耗关键词业务次数；
- 技术接力总计最多 3 次，防止设备间无限循环；
- 小红书工作页失效时在当前批次重建页面并重试当前记录；
- 同步遇到网络超时、限流或临时 `5xx` 时按 `1/3/8 秒`有界重试；
- 增加晨间调度所需数据库索引。

本方案中的“已交付”表示这些能力可作为后续控制面设计的前置契约，不等同于宣称已完成生产部署、全量浏览器更新或真实设备端到端验收；三者仍需在对应发布记录中分别证明。

交付口径拆分如下，后续不得用其中一项替代另一项：

| 交付维度 | 本方案状态 | 权威证据 |
|---|---|---|
| 产品能力契约 | `0.3.91` 已交付，后续不重复设计 | 本节能力清单与对应实现验收记录 |
| 源码与自动测试 | 作为已交付实现基线使用 | 独立工作区测试报告、变更清单和代码审阅 |
| 服务端迁移/索引生效 | 由发布流程独立确认 | 生产 migration 记录与数据库核验 |
| Extension 包发布 | 由发布流程独立确认 | 包 hash、manifest 和下载校验 |
| 客户端全量生效 | 由发布流程独立确认 | 逐租户、逐浏览器 `capture_agents.app_version` 心跳 |
| 真实端到端效果 | 由运行验收独立确认 | Chrome/Edge 故障注入、业务进度和最终落库 |

### 2.2 缺失能力

当前缺少一个统一控制面完成以下工作：

- 计划、任务、执行端 Agent、数据与 AI 队列的联合观察；
- 两次观察之间的进度比较；
- 标准化事故分类和严重度；
- 动作建议、策略审批、执行和结果验证的统一台账；
- 同一事故指纹的去重、冷却和升级；
- 服务端运维晨报；
- LLM 不可用时仍能工作的规则兜底；
- 面向运营的“昨夜是否需要我处理”单一结论。
- create command 从建立、ACK、START 到过期释放的独立技术账本，未开始执行不得污染业务 attempt；
- `running → draining → verifying → completed` 的两阶段终态和浏览器静默证明；
- 带 observation、业务采集时间和执行权检查的迟到完成对账用例；
- 一次性跨账号安全复核、账号冷却和二次挑战的强制人工停止；
- 临时候选池 override 的原值、TTL、恢复条件和崩溃恢复；
- 将“旧数据迟到上传”与“云端终态后浏览器仍继续采集”区分的 lineage 字段。

此外，今早诊断暴露出 Agent 之前必须补齐的结构化关联字段：

- 计划 occurrence、本轮 `round_id`、根任务和子任务的稳定关联；
- 关键词/业务项、原执行端 Agent、接力执行端 Agent、attempt 和 `assignment_revision`；
- 技术失败与业务失败的独立预算和最终结算语义；
- 采集结果、`record_observations`、AI 前置筛选和后处理的证据引用；
- 诊断包去重标识、Extension 版本、错误指纹和恢复父动作；
- 不因脱敏而丢失任务对账所需的 ID；原始客户内容、Cookie 和 Token 仍不得进入证据包。

### 2.3 Agent 前置能力准入表

| 前置能力 | 当前判断 | 进入 Agent 阶段前的硬条件 |
|---|---|---|
| 已知故障自愈 | `0.3.91` 作为已交付能力基线 | 今早已知故障回放无需 LLM 即可正确处置 |
| 统一事实层 | 业务表存在，今早仍需人工用 observation 纠正 3 个工作项 | 每个预期计划都能关联任务、attempt、execution lease、结果、上传和 AI 后处理 |
| 标准动作工具 | 已有路由与恢复意图，但 safety + `needs_action` 和 revision 边界无法安全完成今早的接力 | 所有写动作通过应用用例，覆盖观测完成对账、真失败接力、一次安全复核和候选池恢复，禁止自由 SQL/Shell/UI 点击 |
| 恢复验证器 | 今早由人工连续查 item/attempt/child/command/snapshot/observation 才完成收口 | `200`、心跳、命令成功、item 终态均不能单独判定恢复；必须验证执行静默与数据排空 |
| 策略与权限 | 已有租户和 fencing 基础，缺控制面动作治理 | 幂等、预算、冷却、kill switch、跨租户测试全部通过 |
| 独立失联检测 | 尚无交付证据 | 主应用和控制面同时失联仍能从外部告警 |
| 历史回放与故障注入 | 尚未形成 Agent 准入套件 | 已知场景规则通过，未知场景才进入 Agent 评测 |

## 3. 目标架构

```text
┌────────────────── 自愈运行时 ──────────────────┐
│ Extension 页面监督 / 检查点 / 同步队列          │
│ 服务端租约 / fencing / 有界接力 / 安全阻断       │
└──────────────────────┬─────────────────────────┘
                       │ 结构化事件与事实
                       ▼
┌────────────── 无人值守自愈控制面 ──────────────┐
│ Snapshot Collector → Rule Classifier           │
│ → Policy Gate → Guarded Executor → Verifier    │
│ 已知故障在本层完成，不调用 LLM                   │
└──────────────────────┬─────────────────────────┘
                       │ 规则无法唯一判断的事故
                       ▼
┌────────────────── 智能值守 Agent ──────────────┐
│ 目标 → 选择证据工具 → 假设 → 建议安全动作        │
│ → 经 Policy Gate 执行 → 观察结果 → 重新规划      │
└──────────────────────┬─────────────────────────┘
                       ▼
             Morning Digest / Human Alert
```

执行权始终属于控制面和应用用例，不属于模型。Agent 可以决定“下一步查什么”和“建议哪个白名单动作”，但不能创造动作、绕过规则或直接修改生产状态。

### 3.1 进程归属

自愈控制面的调度和动作执行归属于 Scheduler Worker。智能值守 Agent 作为受控的事故处理 worker 按需触发，不承担每分钟主循环。当前兼容拓扑可先在 `PROCESS_ROLE=all` 中运行，但必须：

- 使用 PostgreSQL advisory lock 或等价角色锁，确保只有一个控制面领取者；
- 所有运行、事故和动作持久化，进程重启后继续；
- 不在 HTTP 路由中复制后台循环；
- 不由 Extension、LLM 或个人电脑单独决定全局健康；
- 后续迁移到持久化 Job Worker 时不改变业务契约。

### 3.2 依赖方向

```text
Cron / Worker / HTTP / Agent Tool Adapter
        ↓
ops-control application use cases
        ↓
capture / ai / notification domain policies
        ↓
repositories and existing executors
        ↓
PostgreSQL / LLM / SMTP
```

控制面和 Agent 工具不得从前端组件读取状态，也不得内部调用需要用户会话的管理端 HTTP 接口。现有恢复逻辑如果仍位于路由文件，应先提取为应用用例，再由路由、控制面和 Agent 工具适配器共同调用。

### 3.3 独立失联哨兵

自愈控制面不能成为自己的唯一监控者。如果 API、Scheduler、数据库连接或整台生产主机停止，同进程控制面将无法生成事故和发送邮件。

生产必须另设一个不与主应用共享故障域的只读哨兵：

- 运行在不同主机或托管服务、不同调度器和独立服务账号下；
- 从外部定时读取专用的控制面健康端点；
- 检查控制面最后成功观察、最后成功晨报和 Scheduler 锁状态；
- 主服务不可达或控制面心跳超过阈值时，使用与主应用不同凭证的独立通知通道；
- 不读取租户业务数据，不持有执行端 Agent Token，不自动重启或部署；
- 主应用恢复后发送一次恢复通知并关闭同一事故；
- 哨兵自身也应有独立的最近成功记录，避免“监控的监控”永久静默。

专用端点只返回版本、角色、最后成功时间和整体状态，不返回任务、客户或凭据信息。外部哨兵可以由独立监控服务或单独的受控自动任务承载，但必须同时满足不同主机/调度器、独立账号与独立通知凭证；与同一 PM2、同一主机 cron 或同一邮件凭证共存均不能宣称具备独立性。智能值守 Agent 的模型调用不可替代该哨兵。

## 4. 值守闭环

### 4.1 触发方式

值守必须由任务事件自动启动，不依赖用户点“立即复核”，也不把每分钟扫描当作主触发链路。主触发通过与业务事实同事务写入的 transactional outbox 发生：

- 计划 occurrence 创建；
- 根任务、工作项、attempt、lease 或 command 状态变化；
- 执行端 Agent 进入新采集阶段、业务进展更新或心跳超时；
- 存储压力、平台安全挑战、登录失效或 host 容量变化；
- 动作进入待验证、排空或终态；
- 运维晨报截止时间。

30–60 秒 sweeper 只是丢事件、进程崩溃和网络断开时的补偿保险；不得因此让正常任务最迟等一分钟才启动值守。人工“立即复核”只保留为运维查询入口，不是产品正常路径。LLM 仍只在产生歧义事故后按需启动。

### 4.2 一次观察

每个租户的快照至少包含：

1. 当前值守窗口内预期运行的计划与 occurrence；
2. 根任务、子任务、工作项、尝试、命令和事件；
3. 执行端 Agent 在线状态、版本、平台能力、执行槽和最近错误；
4. `business_progress_at`、`progress_seq`、工作项更新时间；
5. 本轮保存数量、观察记录和最终工作项状态；
6. 待处理 records/comments、最近 AI 完成时间、prefilter 与 failover 状态；
7. Scheduler/Worker 最近成功循环；
8. 已存在的控制面事故、动作预算和冷却时间。
9. `host_id / profile_id / platform_account_id`、同物理机 active slots 和 host pressure；
10. `content_mode / stage / search_generation / result_generation / requested_filter / confirmed_filter`；
11. `storage_bytes_used / quota_bytes / pending_uploads / local_capture_lock / active_page_count`；
12. `requested_publish_window`、采集结果的实际发布时间范围和超界数；
13. `business_terminal_at / draining_started_at / local_closed_at`以及终态后快照和 observation 增量。

快照不保存 Cookie、Token、验证码、SMTP 密码或完整客户敏感内容。

### 4.3 两次观察判定

单次快照不能把任务判为卡死。控制面保存上一观察并比较：

- 设备心跳是否更新；
- 任务心跳是否更新；
- `business_progress_at` 或 `progress_seq` 是否推进；
- 工作项/尝试是否进入新状态；
- 落库和 AI 完成时间是否前移；
- 是否已经存在正在执行的恢复动作。

两个 25–60 秒观察只用于判断证据是否在变化，不作为所有平台和阶段的统一失败阈值。搜索、筛选、详情打开、评论、博主指标、增强和同步分别使用 `platform × content_mode × stage × host_load_band` 的近期 P99 加安全余量作为 deadline；样本不足时使用守旧上限。只要心跳、阶段快照或业务进展仍在前进，控制面就续等，不创建第二个 attempt。

### 4.4 生命周期与运行结论

生命周期和运行结论分开存储，避免把“已经结算”误认为“健康成功”。

| `status` 生命周期 | 含义 |
|---|---|
| `observing` | 已进入值守窗口，正在收集连续事实 |
| `progressing` | 仍在执行且业务进展新鲜 |
| `recovering` | 安全动作已执行，等待验证 |
| `draining` | 业务步骤已终止，正在等待本地计时器、页面动作、待上传队列和执行锁清零 |
| `verifying` | 已排空，正在通过快照静默窗口、observation 和业务正确性做最终核对 |
| `settled` | 本轮已按业务语义进入终态，可能成功、部分成功或失败 |

| `verdict` 运行结论 | 用户体验 |
|---|---|
| `healthy` | 静默，进入晨报 |
| `degraded` | 自动处理或带说明进入晨报 |
| `blocked_manual` | 必须人工登录、验证或决策，去重后即时通知 |
| `incident` | 系统性异常、自动预算耗尽或控制面不可信，即时通知并停止扩散 |

租户聚合优先级固定为 `incident > blocked_manual > degraded > healthy`。`settled + degraded` 是合法组合；只有所有预期 occurrence 都有结论、没有开放红色事故且数据闭环成立，run 才可关闭。

### 4.5 Agent 升级条件

满足以下任一条件，控制面才能创建 Agent 调查；否则继续走规则或人工边界：

- 两种以上证据层相互冲突，规则无法得到唯一结论；
- 同一白名单恢复动作已验证失败，且仍存在其他安全工具路径；
- 新错误指纹没有固定处置，但可通过现有只读工具继续缩小范围；
- 单机、单平台和系统性异常三种假设同时成立，需要跨设备取证；
- 事故影响仍在扩大，但尚未达到必须立即人工处理的安全阻断。

以下情况不得创建 Agent 循环：验证码或登录失效、明确超预算、跨租户证据缺失、控制面自身失联、没有任何合法工具，或只能通过部署/改配置/写 SQL 解决。验证码是否符合一次性跨账号复核由确定性 Policy Gate 判断，不交给 LLM；不符合时直接进入人工处理。

### 4.6 权威分母与去重

- 每个租户按配置时区在值守窗口开始时冻结“预期 schedule/occurrence 集合”，作为计划覆盖率分母；
- 窗口内新增、停用或修改计划必须生成变更事件，不能静默改写原分母；
- 设备覆盖以 `capture_agents.id + browser_name + tenant_id` 的注册事实和任务能力要求为准，不以收到多少份诊断包为准；
- “缺一台 Edge”必须先与权威执行端清单、最近心跳和本轮分配关系对账；未提交诊断不自动等于离线；
- 诊断包使用 `tenant_id + agent_id + generated_at + payload_hash` 去重；相同 hash 重复上传只保留一份证据引用；
- 计划覆盖、执行端覆盖、诊断覆盖和业务结果覆盖分别计算，禁止用其中一个 `100%` 代表其他维度。

### 4.7 观察容量与降级

- 快照采集使用增量游标和更新时间窗，不允许每租户每分钟全表扫描；
- 每个 tick 设置租户数、查询行数、SQL 时间和总墙钟预算，并加入随机抖动避免整点洪峰；
- 大租户分页处理，上一轮未完成时不并发启动重复扫描；
- 数据源超时后保留上次事实并标记 `stale`，不得用旧快照判绿；
- 控制面负载过高时优先保留红色事故、待验证动作和晨报截止窗口，普通健康租户降频；
- 控制面查询性能必须用生产规模数据回放验证，不能因存在索引就直接判定容量足够。

### 4.8 单一执行权与两阶段终态

每个 item 任何时刻只能有一个有效执行权。数据库和应用用例共同保证 `item_id + active_lease` 唯一；每个 command、snapshot、observation、同步回报和完成回报必须携带并校验：

- `item_id / attempt_id / execution_task_id`；
- `assignment_revision / lease_token`；
- `agent_id / platform_account_id / host_id / profile_id`；
- `captured_at / uploaded_at / source_progress_seq`。

旧 lease 的迟到数据可以作为 `late_evidence` 保留，但不得覆盖 successor attempt、不得改变当前 item 或父任务状态。

下面三套状态必须分开持久化，禁止用 child、item 或父任务的同名 `completed` 相互替代：

```text
执行权/命令：PENDING_DISPATCH → LEASED → COMMAND_ACKED → STARTED → ACTIVE
                                      └→ RELEASED（开始前过期）
                    ACTIVE → QUIESCING → LEASE_REVOKED / RELEASED

业务 item 主路径：PENDING → ACTIVE → DRAINING → VERIFYING
                                  └→ COMPLETED / PARTIAL / FAILED / SKIPPED
可恢复失败分支：ACTIVE → RETRYABLE → PENDING（创建 successor revision）
普通预算耗尽：ACTIVE → RECONCILING → RESERVE_PENDING → RESERVE_RUNNING
                                              └→ VERIFYING → COMPLETED / FINAL_FAILED
首次白名单挑战：ACTIVE → SOURCE_QUIESCING → SAFETY_REVIEW_PENDING
                                                   └→ SAFETY_REVIEW_RUNNING → VERIFYING
人工阻断分支：ACTIVE / VERIFYING → BLOCKED_MANUAL

父任务聚合：RUNNING → SETTLING → COMPLETED / PARTIAL / FAILED / BLOCKED_MANUAL
```

`CREATE_COMMAND_EXPIRED` 只能让 execution lease 在开始前进入 `RELEASED` 并把 item 留在/送回 `PENDING`，增加技术派发计数，不得消耗业务 attempt。`ACTIVE` 发生真实可恢复失败时，必须先 `QUIESCING → LEASE_REVOKED`；只有原 lineage 静默且成功数据已保留，item 才可进入 `RETRYABLE` 并创建 successor revision。安全阻断是否允许一次 successor 由确定性 Policy Gate 单独判断。

父任务只有在全部 item 结束 `VERIFYING` 并得到业务终态后，才可从 `RUNNING → SETTLING` 进入对应聚合终态。父任务聚合终态仍不等于 control run 真正关闭；最终关闭条件必须同时满足：

1. 所有 item 终态；
2. active attempt、active lease、active command、pending upload、active page、local capture lock 和当前 lineage 占用的执行端槽位均为 0，且不存在同一 item 双 active；
3. 存在最终 terminal snapshot，且静默窗口内无新的非终态快照；
4. 静默窗口内无新的当前 lease observation；
5. 筛选、发布时间范围、详情完整性和重复结果等业务正确性检查通过；
6. 事故引入的临时候选池 override 已恢复到 baseline，并已即时验证当前父任务和计划模板恢复；仅“正在恢复”不得关闭本轮 control run。下一 occurrence 尚未生成时登记 `next_occurrence_guard` 延后复核，不阻塞当前 run；若后续发现污染则创建新事故。

第 5 项业务正确性检查统一返回 `passed / failed / not_applicable / unknown`：`COMPLETED` 的所有适用检查必须为 `passed`；`PARTIAL / FAILED / SKIPPED / BLOCKED_MANUAL` 只允许对确实未进入的阶段标记 `not_applicable`，并记录结构化原因。缺字段、缺 evidence 或无法判断一律为 `unknown`，不能冒充 `not_applicable` 或判绿。

### 4.9 Extension、控制面、Agent 与外部哨兵的强制边界

| 层 | 必须负责 | 明确不负责 |
|---|---|---|
| Extension 自愈运行时 | 搜索提交和结果代际、筛选确认、列表稳定、详情打开、采集、检查点、本地 outbox、storage 容量管理、终态取消 timer/listener/tab 操作和逐阶段事件 | 跨设备调度、判断系统性故障、自行增加业务尝试次数 |
| 无人值守控制面 | 任务创建即自动值守、lease、接力、挑战 scope 隔离、物理主机容量准入、技术/业务/安全预算分账、数据正确性验证、终态 fencing、候选池恢复和晨报 | 操作 DOM、维护平台 selector、自由清理客户端记录 |
| 智能值守 Agent | 证据冲突时比较设备、host、平台、网络和 Extension 假设，选择下一个证据工具；第一个动作无效时改变探针或正确停止 | 直接点击浏览器、调整生产 timeout、删除 storage、绕过验证码、部署或创建超出原任务范围的任务 |
| 外部哨兵 | 发现控制面未被事件唤醒、Scheduler/主服务失联或晨报未生成 | 业务恢复和浏览器控制 |

同一关键词的「综合」与「图文」不再作为同一 child 内的隐式两轮，而是拆成 `keyword × platform × content_mode` 两个独立工作项。二者可属于同一 occurrence，但分别拥有 attempt、预算、检查点、执行端 Agent 和最终结论。这使搜索、筛选和详情故障能精确重试，也避免一台设备内部两轮绕过云端调度和事故验证。

`eligible_search_challenge` 不是模型从页面文字猜出的标签，而是服务端版本化安全策略中的枚举。首版白名单只包含抖音搜索阶段由 Extension 结构化探测器上报的 `DOUYIN_SEARCH_SECURITY_CHALLENGE`；证据必须同时带 `platform / stage / challenge_code / detector_version / platform_account_id / item_id / attempt_id / lease_token`，并由 URL/DOM 状态和登录有效性共同确认，不能只凭自由文本。Extension 生产结构化证据，Policy Gate 按 `safety_policy_version` 匹配；新增平台、阶段或挑战类型必须经过安全评审、回放和发布，租户配置与模型均无权扩大白名单。扫码登录、身份核验、滑块/解题以及未知挑战始终直接转人工。

### 4.10 抖音慢网与重复搜索的可开发契约

不能通过单纯放大一个 `45 秒`常量解决现场问题。Extension 必须把“页面真的在推进”和“代际/筛选已严格确认”同时建模：前者负责续租，后者负责阻止错误采集。

下面九个 `stage` 是全文唯一权威枚举；其他章节只能引用，不得再定义五阶段缩写。`degraded_waiting` 不是第十个阶段，而是任一等待阶段超过软截止后的 `wait_state`；恢复进展后仍沿原 `stage_seq` 单调前进。

```text
SEARCH_SUBMITTED
  → SEARCH_SHELL_READY
  → RESULTS_VISIBLE_UNCONFIRMED
  → RESULTS_GENERATION_CONFIRMED
  → FILTER_APPLYING
  → FILTER_UI_CONFIRMED
  → FILTERED_RESULTS_VISIBLE_UNCONFIRMED
  → FILTERED_GENERATION_CONFIRMED
  → LIST_CAPTURE
```

每次单调阶段上报至少携带 `task_id / item_id / attempt_id / lease_token / content_mode / stage / stage_seq / wait_state / wait_reason / wait_started_at / probe_count / search_generation / result_generation / evidence_fingerprint / observed_at`。只有 `stage_seq`、卡片计数、结果签名、关键词确认或筛选 UI 证据真实变化才刷新 `stage_progress_at`；普通心跳不能伪装业务进展，6 分钟全局 supervisor 也不得覆盖仍在单调推进的阶段 lease。出现新单调进展或进入下一确认阶段时清除 `degraded_waiting`；硬截止到期先记录 `wait_state = hard_deadline_exceeded` 再结算该阶段，successor attempt 不继承旧 wait_state。

首轮灰度采用可配置的保护值，不作为已证明 SLO：

| 阶段 | 软截止 | 硬截止 | 软截止后的动作 |
|---|---:|---:|---|
| 搜索页骨架 | 20 秒 | 45 秒 | 保留当前提交，探测页面 shell/关键词，不立即重搜 |
| 搜索结果代际 | 45 秒 | 90 秒 | 有卡片/签名进展则 `degraded_waiting`；无进展只做一次 probe |
| 筛选 UI 与确认 | 30 秒 | 60 秒 | 只重申幂等筛选，不重搜整词 |
| 筛选后结果代际 | 45 秒 | 90 秒 | 保持筛选门，继续等待代际证据 |
| 详情打开 | 60 秒 | 120–150 秒 | 重建当前详情工作页或接力当前内容，不重搜关键词 |

只在能证明“搜索提交丢失、页面回退、当前文档属于旧关键词，或平台服务异常冷却后需要新 generation”时允许重新提交整词，并写结构化 reason code。bootstrap 已建立的 generation 必须传给批采复用；筛选失败只重试筛选，空提取先重试列表读取。进入 `LIST_CAPTURE` 之前的技术故障不消耗业务 attempt；保存时仍需复核发布时间范围，严格性不能因慢网而放松。

阶段耗时按 `platform × content_mode × stage × host_load_band` 分桶报告 P50/P95/P99。单桶不足 30–50 个样本时不宣称 P99，只报告最大观测值与样本量；高风险桶积累约 100 个阶段样本后再固化 SLO。

## 5. 事故分类与动作矩阵

### 5.1 标准事故类型

| 事故类型 | 关键证据 | 默认处置 |
|---|---|---|
| `schedule_missing` | 应运行但未产生 occurrence/root task | 复核计划状态和调度循环；第一版通知，不补造任务 |
| `agent_offline` | 执行端 Agent 心跳过期，任务仍未终态 | 未开始项可接力；无兼容执行端 Agent 则通知 |
| `agent_repeated_technical_failure` | 同一执行端 Agent/平台连续启动失败，其他执行端 Agent 仍可工作 | 时间窗熔断该执行选择，失败项有界接力 |
| `task_stalled` | 心跳可能新鲜，但业务进展连续不动 | 先等待/唤醒/从检查点恢复，再验证 |
| `runner_tab_lost` | `No tab with id`、Tab 替换或内容通道失联 | Extension 本地重建工作页；失败后从检查点接力 |
| `command_stale` | 命令过期或长时间未结算 | 调用既有命令对账与租约回收 |
| `command_expired_before_start` | create command 未 ACK/未 START 即过期 | 释放本次 lease，只增加技术派发计数，不消耗业务 attempt |
| `post_terminal_execution` | 云端 item/child 已终态，但仍出现新业务快照、实际采集时间或页面动作 | 父任务不判绿，进入排空和 execution fencing，区分继续采集与旧数据迟到上传 |
| `terminal_runtime_residue` | 当前 lease/revision 在业务终态后仍上报运行阶段、持有锁、页面或待上传；父终态投影不得掩盖该事实 | 显示 `draining`，精确执行 `quiesce_terminal_execution`，收到 `local_closed_at` 后再验证 |
| `observed_completion_mismatch` | 存在可归因 observation 与 Extension 本地终态/检查点等权威证据，但 item 仍为失败/需处理；用户现场反馈只用于触发复核 | 调用带 revision 和执行静默门槛的完成对账用例，不重跑已完成业务 |
| `transient_platform` | 明确可重试的服务异常或页面暂未就绪 | 冷却后仅重试失败项 |
| `sync_deferred` | 临时网络、限流或 `5xx` 导致同步队列积压 | 本地有界补传；控制面验证最终入库 |
| `platform_safety` | 结构化验证码、登录或安全证据 | 登录失效及非白名单挑战直接通知；仅白名单 `eligible_search_challenge` 隔离精确账号 scope，符合门槛时由不同账号复核一次，再次触发立即转人工 |
| `extension_storage_pressure` | storage 进入黄/橙/红水位、写失败或全池 mutation 过慢 | Extension 空闲期安全压缩；红色执行端 Agent 拒绝新重任务并交给其他节点 |
| `storage_control_write_blocked` | `Resource::kQuotaBytes quota exceeded` 导致任务账本、关闭确认、锁释放或终态状态无法落盘 | 停止新详情写入；释放最小控制保留区并只做一次安全压缩/重写。仍失败则内存态停止、直接上报阻断，服务端在阶段硬截止后撤租并把 UI 转成明确红色终态；保护 unsynced，只把未开始 item 接力 |
| `task_owned_tab_orphaned` | 有 owner token 的详情/运行页存在，但已无匹配 active lease | Extension 启动和终态清场回收；无 owner token 的用户页只报告、不关闭 |
| `terminal_overlay_resurrected` | 用户已关闭终态提示，reload 后旧 request/ledger 再次合成活动面板 | 持久化确认指针并以当前 lease 对账；历史只留任务中心 |
| `host_resource_saturated` | 同物理机多浏览器心跳、页面阶段和写入延迟同时恶化 | 保留在途任务，暂停向该 host 发新 lease，恢复后逐槽放开 |
| `search_generation_mismatch` | 搜索结果已可见但系统无法证明属于本次搜索代际 | 在当前阶段等待或仅重建搜索代际，不提前采集、不整任务误判失败 |
| `results_visible_unconfirmed` | 本次搜索已有可见结果或结果变化证据，但筛选/代际尚未完全确认 | 记为业务进展，令 `wait_state = degraded_waiting`；软截止不消耗 attempt，硬截止前只做一次幂等探测 |
| `filter_not_confirmed` | 请求筛选与页面实际筛选尚未一致 | 禁止列表采集，等待筛选确认或有界重申当前筛选 |
| `detail_open_timeout` | 已获得作品链接，但详情页长时间未进入可读状态 | 按平台和 host 负载使用阶段 deadline，重建当前工作页或接力当前内容，不重搜整词 |
| `result_out_of_requested_range` | 已保存结果超出请求的发布时间/内容范围 | 不判绿；标记业务正确性失败，仅重跑对应 `content_mode` 工作项 |
| `candidate_pool_override_leaked` | 事故已收口但父任务仍保留临时候选集 | 恢复基线候选池并验证下一轮模板未被污染 |
| `version_mismatch` | 执行端 Agent 版本低于任务能力要求 | 禁止派发不兼容动作，通知更新 |
| `attempts_exhausted` | 工作项达到普通自动尝试上限 | 先评估一次 `reserve_recovery_candidate`；不合格或备用轮已用尽才进入人工处理/晨报 |
| `recovery_items_unsharded` | 多个可恢复 item 被绑定到同一目标，而存在多台合格空闲 Agent | 拒绝默认单目标批量恢复，改为原子分片；仅显式人工覆盖可串行 |
| `reserve_recovery_candidate` | 非安全/登录/取消类真失败，普通预算已尽，且存在低日搜索占用的健康容量 | 每 item/occurrence 最多创建一次独立备用恢复轮；同错或无进展即停止 |
| `agent_usage_unknown` | 候选账号当日搜索用量缺失、过期或计数日期不一致 | 不把未知当 0；降级排序或拒绝安全/备用轮，先刷新用量证据 |
| `persistence_gap` | Extension 报完成但目标结果未形成可验证写入 | 不判成功，保留证据并通知 |
| `projection_inconsistent` | 父任务与工作项终态不一致 | 不直接改状态，进入修复用例或人工排查 |
| `ai_backlog_stalled` | 积压增长且两个观察周期无完成 | 观察既有 failover；持续异常才通知 |
| `worker_unhealthy` | Scheduler/AI Worker 成功循环过期 | 第一版通知，不自动重启生产进程 |
| `diagnostic_gap` | 缺 round/keyword/orchestration/attempt 关联，无法对账 | 不做猜测性写操作，保留缺口并通知维护 |
| `ambiguous_cross_layer` | 设备、平台、落库和 AI 证据同时异常且规则不能归因 | 进入 Agent 调查，仍受工具和预算约束 |

严重度和通知由 category + 业务影响唯一映射：

| 条件 | 严重度 | 通知 |
|---|---|---|
| 登录失效、同一 item 第二次 `platform_safety`、无可用不同账号、全部兼容执行端离线、`worker_unhealthy`、无法证明落库的 `persistence_gap` | 红 | 即时去重通知 |
| 首次 item 级白名单 `eligible_search_challenge` 且一次性跨账号安全复核条件全部成立 | 黄 | 先隔离源账号；确认源 lineage 静默后由不同账号复核一次，再次挑战立即转红 |
| `extension_storage_pressure` 或 `host_resource_saturated` 尚有其他健康容量 | 黄 | 拒绝该 scope 新 lease、静默调度；无可用容量时转红 |
| `attempts_exhausted` 且必需工作项在截止时间仍无结论 | 红 | 即时通知 |
| `attempts_exhausted` 但策略允许部分结果、其他计划不受影响 | 黄 | 晨报说明 |
| `schedule_missing` 尚在调度宽限期、可恢复单机故障、`sync_deferred` | 黄 | 静默恢复，失败再升级 |
| `diagnostic_gap` 不影响最终业务结论 | 黄 | 晨报和维护事项 |
| `diagnostic_gap` 导致计划无法给出可信结论 | 红 | 即时通知，禁止猜测性恢复 |
| `ambiguous_cross_layer` | 黄起步 | Agent/人工调查期间持续扩散或预算耗尽则转红 |

### 5.2 自愈运行时动作

以下动作由 Extension 或既有服务状态机完成，不经过 LLM：

| 动作 | 所属层 | 触发与边界 |
|---|---|---|
| `rebuild_runner_tab` | Extension | Tab 不存在、已替换或内容脚本失联；恢复当前记录 |
| `retry_content_channel` | Extension | 短时无响应；有界重连/重注入 |
| `retry_deferred_sync` | Extension | 仅网络、限流和临时 `5xx`；认证/数据错误不盲重试 |
| `persist_checkpoint` | Extension | 业务项结算后写入，不把 Tab ID 当作任务身份 |
| `release_technical_failure` | 服务端调度 | 技术启动失败不消耗业务次数，但受技术接力总预算约束 |
| `mark_results_visible_unconfirmed` | Extension | 页面已有本次结果证据但筛选未确认；刷新阶段进展并令 `wait_state = degraded_waiting`，不终结 attempt |
| `reuse_task_owned_detail_tab` | Extension | 同一 task/attempt/revision 默认复用一个详情工作页；所有权持久化，用户页不进入清场集合 |
| `ack_terminal_summary` | Extension | 用户关闭终态提示时持久化 task/revision 确认；reload 无 active lease 时只显示空闲 |
| `compact_acked_local_data` | Extension | 仅服务端 ACK、lineage 终态、无 active trace 且超过保留期的数据；unsynced/failed/needs_action 禁止删除 |
| `release_storage_blocked_execution` | Extension + 服务端 | quota 写失败后停止新详情、完成最小终态/锁释放、关闭任务页；未开始 item 可接力，业务 attempt 不计费 |

### 5.3 控制面自动动作白名单

| 动作 | 允许条件 | 验证标准 |
|---|---|---|
| `wait_with_backoff` | 平台临时异常、仍在冷却期 | 后续业务进度恢复或进入下一合法状态 |
| `reconcile_stale_capture_state` | 命令/租约满足现有过期规则，scope 限于当前事故证据 | 命令终态、工作项重新排队或任务结算 |
| `retry_failed_items` | 仅 `retryable` 或政策明确允许的失败项，未超预算 | 新尝试产生且业务进度推进，最终工作项结算 |
| `handoff_unfinished_items` | 同租户、同平台、兼容、空闲执行端 Agent；不存在安全阻断 | 新 attempt/revision 生效，旧写回被拒绝，新执行端 Agent 推进 |
| `shard_retryable_items` | 至少 1 个可恢复 item 与 1 台合格空闲 Agent；按 item 加锁并重新计算候选，不接收一个 `targetAgentId` 绑定全部 item | 每个 item 只有一个 active lease；可并行分布到多台 Agent，成功项不重跑，UI 展示逐项去向 |
| `reserve_recovery_round` | 普通预算已尽；失败为非安全、非登录、非取消的证据化真失败；无 active lease/command/page；该 item/occurrence 尚未使用备用轮；存在低日搜索占用且 host/storage 健康的候选 | 只建立一次新 recovery epoch/revision，继承成功结果与检查点；同类失败或无业务进展后不再创建第三轮 |
| `reconcile_observed_completion` | 早期 attempt 存在可归因 observation，后续虚假 attempt 未启动，Extension 本地终态/检查点等权威证据与云端投影冲突，且当前无 active attempt/command/page；用户现场反馈只能触发复核，不能单独作为改状态依据 | 有效早期 attempt 结算，未启动后续 lineage 仅封存，item 不再派发，审计保留原失败 |
| `handoff_platform_safety_once` | 仅 item 级首次白名单 `eligible_search_challenge`；登录仍有效；源 lease 已撤销，连续两个观察或配置的 quiet window 内无新业务写入/页面动作；存在未尝试、空闲、兼容且 `platform_account_id` 不同的执行端 Agent；`safety_handoff_count = 0` | 源账号 scope 冷却，新 revision 开始执行；成功则正常收口，再次挑战或登录失效则立即 `blocked_manual` |
| `resume_from_checkpoint` | 存在有效检查点和可恢复状态 | 已成功项不重跑，未完成项继续推进 |
| `quarantine_agent_scope` | 同一执行端 Agent/平台在时间窗内达到技术失败阈值，其他执行端 Agent 有成功证据 | 不再领取同类新项；冷却后探测成功自动解除 |
| `quiesce_terminal_execution` | 已终态 lineage 连续两次观察仍有新业务快照或实际采集时间，且精确 task/attempt/revision 仍占有本地执行权 | 仅向该 lineage 发排空/停止命令；本地锁、页面动作、pending upload 归零，不改写业务结果 |
| `set_candidate_pool_override` | 受影响 item 已冻结，原候选池和临时池均已保存，目标执行端 Agent 通过 host/账号/版本/负载准入 | override 带 owner、reason、TTL 和 baseline digest，只影响当前父任务 |
| `restore_candidate_pool` | override 关联的 item/child/command 均已终态且无运行时残留；TTL 到期只强制触发恢复评估，不允许绕过在途 lease 与静默检查 | 父任务和计划模板恢复 baseline，登记 `next_occurrence_guard`；下一 occurrence 尚未生成不阻塞当前 run，后续污染另开事故 |
| `decline_new_lease_on_saturated_host` | host pressure 超过灰度门槛，但在途任务仍可安全继续 | 不终止在途任务，只阻止新 lease；连续健康后逐槽恢复 |
| `notify_human` | 人工类阻断或自动预算耗尽 | 主或备用通道达到 `delivered`，并提供正确处理链接 |

### 5.4 2026-08-24 晨间事故回放契约

夹具 ID 固定为 `ops-morning-20260824-v1`，输入证据清单、去重 hash、Schema 版本和预期结果进入测试资产版本控制。Gate A 验证“分类结论正确”，Gate B/Agent 开发准入门验证“恢复或安全停止正确”，不得用同一句“回放通过”混淆两个层级。

这批真实事故作为 Agent 前置验收夹具。已知场景必须由自愈运行时和控制面解决，不能依赖 LLM：

| 事实输入 | 预期确定性处理 | 最终验证 |
|---|---|---|
| 14 份诊断中 1 份重复、实际缺 1 台 Edge | 诊断去重，缺失节点不派新任务，未完成项接力 | 计划覆盖结论明确，不把 13 份误报为 14 台健康 |
| 小红书多台出现 `No tab with id` 和内容通道超时 | 批内重建工作页并重试当前记录；仍失败才接力 | `progress_seq` 继续、成功项不重跑、最终入库可见 |
| 单台抖音 Edge 连续 `UNATTENDED_SEARCH_BOOTSTRAP_FAILED` | 技术次数分账、时间窗熔断、失败词换执行端 Agent | 原节点不反复接单，失败词产生有效 successor attempt |
| `/api/sync/batch` 超时但最终 `failedCount=0` | 有界补传并保持采集继续 | 服务端 observation 形成，不把中间超时报为终态失败 |
| `unattended_begin_fence_changed` 缺失 mismatch 明细 | 认定证据不足，不猜测修状态 | 保留事故和缺失字段，禁止重复执行或直接改表 |
| 第一轮与人工追加轮缺关键词/round 关联 | 标记 `diagnostic_gap` | 新诊断契约可逐词对账第一轮、补偿轮和最终结算 |

只有把其中多个症状重新组合为规则未覆盖的混合事故，才用于评测 Agent 是否会主动取证和重新规划。

### 5.5 2026-08-27 生产实跑验收契约

新增回放夹具 `ops-morning-20260827-v1`。该夹具必须由脱敏后的真实 item/attempt/child/command/snapshot/observation 时间线生成，不得只用人工总结重造。其验收目标是证明控制面无需自由 SQL 或现场点击即能完成今早的同等处置。

| 事实输入 | 预期确定性处理 | 最终验证 |
|---|---|---|
| 3 个 item 的早期 attempt 已有真实 observation，后续 attempt 只有 create-command expiry 且工作量为 0 | 识别 `observed_completion_mismatch`，调用 `reconcile_observed_completion` | 有效 attempt 完成、虚假后续 lineage 封存、工作项不再重跑、原失败证据保留 |
| 20 个历史 `CREATE_COMMAND_EXPIRED` 中同时包含未开始、迟到确认和已被 successor 覆盖的不同情况 | 逐条计算业务影响，只释放未开始的 lease | 未开始命令消耗业务 attempt 为 0，历史审计不被删除 |
| 云端已终态，但两个浏览器仍分别继续实际采集约 17/22 分钟；另一项只是旧数据迟到上传 | 用 `captured_at / uploaded_at / snapshot stage / local lock` 区分继续执行和延迟上传；对前者精确排空 | terminal 后非终态快照为 0，quiet window 后新有效 observation 为 0，迟到数据不污染当前 lineage |
| 3 个真失败项需要收缩到 3 个健康执行端 Agent，后续又有 1 个运行项部分失败返回池中 | 建立带 baseline/TTL 的父任务候选池 override，只接力真实未完成项 | 无双 active，所有 item 收口，override 在目标收口后恢复，下一 occurrence 候选池正常 |
| 抖音 attempt 1 是技术心跳失败，attempt 2 才是首次真实验证码 | 技术、业务、安全预算分账；隔离源账号，交给未尝试的不同账号复核一次 | 新执行成功则收口；再次验证码/登录失效则没有第二次跨账号接力并即时通知 |
| 同一物理 Mac 有 8 个浏览器 Profile，另有 6 个执行端 Agent 分布在其他 Windows 机器 | 按 host 分组做容量准入，不以 14 台平均或单个 Agent 空闲替代物理机负载 | 同机 1/2/4/6/8 逐级灰度，心跳误判、假领取、storage 写失败和双 active 均为 0 |

该夹具不是 Agent 智能评测集；其中的所有处置都已经可规则化，必须在关闭 LLM 时通过。

### 5.6 禁止自动动作

以下动作即使 LLM 建议也必须由策略闸门拒绝：

- 识别、点击、绕过或自动处理验证码、安全验证和登录；一次白名单安全复核后禁止创建第二个 successor（即禁止第二次跨账号接力）；
- 绕过 `reconcile_observed_completion` 等权威用例直接更新任务/工作项状态；
- 删除、归档或隐藏失败证据；
- 重启、部署、回滚或修改生产拓扑；
- 修改模型、密钥、租户权限、激活码和执行端 Agent 绑定；
- 超出任务原始范围创建新关键词或新业务任务；
- 跨租户选择执行端 Agent、读取证据或发送通知。

## 6. 策略闸门

每个动作执行前必须同时通过：

1. **租户闸门**：`tenant_id` 由已鉴权上下文注入，模型不能指定；
2. **目标闸门**：task/item/agent 必须属于同一租户和当前 revision；
3. **状态闸门**：当前状态仍满足动作前提；
4. **安全闸门**：没有登录失效、人工停止或不允许自动处理的安全阻断；`handoff_platform_safety_once` 是唯一例外，必须单独通过第 5 项账号门槛；
5. **账号闸门**：安全复核的目标 `platform_account_id` 与源账号不同、未尝试该 item、仍登录有效、无账号冷却冲突，且 `safety_handoff_count = 0`；
6. **源静默闸门**：安全复核前源 lease 已撤销，连续两个观察或配置 quiet window 内无新业务写入、页面动作和当前-lineage observation；
7. **预算闸门**：技术派发、业务 attempt、安全复核和控制面动作预算分别未超限；
8. **冷却闸门**：同一事故指纹未处于冷却或已有在途动作；
9. **幂等闸门**：稳定 `request_key` 尚未产生等价有效动作；
10. **能力闸门**：目标执行端 Agent 支持平台、任务类型和所需 Extension 版本；
11. **Host 容量闸门**：目标 host 的 active slots、storage pressure、近期心跳和阶段延迟允许新 lease，不以单个 Agent 显示空闲代替物理机准入；
12. **账号用量闸门**：候选账号未达到每日硬上限；调度评分至少包含 `daily_searches / daily_search_limit`、当前槽位、host pressure、近期平台技术失败、近期成功和最后派发时间，不把“显示空闲”当成最佳目标；
13. **分片原子闸门**：每个 item 在事务内独立选择、锁定和创建 lease；每分配一项都重新计算剩余候选，防止并行请求把全部 item 压到同一 Agent；
14. **备用轮闸门**：`reserve_recovery_count = 0`，前序 lineage 已静默，成功结果和检查点已冻结，失败类型不属于 safety/login/cancel/data-integrity；
15. **所有权闸门**：旧 attempt、旧 `assignment_revision` 和旧 lease token 不可覆盖新执行；
16. **静默开关**：全局或租户 kill switch 未关闭自动操作；
17. **模式闸门**：控制面模式和 Agent 模式分别校验，最终权限取两者最小交集。

建议运行模式：

| 控制面模式 | 行为 |
|---|---|
| `observe` | 只观察、诊断和生成晨报 |
| `assist` | 生成动作建议，人工确认后执行 |
| `autonomous_safe` | 自动执行白名单动作，其他动作仍需人工 |

Agent 使用独立开关：

| Agent 模式 | 行为 |
|---|---|
| `agent_off` | 不调用模型 |
| `agent_observe` | Agent 可取证和形成结论，不建议写动作 |
| `agent_assist` | Agent 可建议白名单动作，人工确认后交给 Policy Gate |
| `agent_autonomous_safe` | Agent 可提交低风险白名单动作，由 Policy Gate 自动审批或拒绝 |

任何模式下，执行动作的都是受控应用用例，而不是模型本身。安全阻断、生产配置变更和破坏性操作都不能自动执行。

两套模式的强制交叉权限：

| 控制面模式 | Agent 模式 | Agent 提交的 L1 动作 |
|---|---|---|
| `observe` | 任意 | 全部拒绝，只允许读取证据 |
| `assist` | 任意 | 必须人工批准；Agent 模式不能提高权限 |
| `autonomous_safe` | `agent_off` / `agent_observe` | Agent 不得提交写动作；规则动作按控制面策略执行 |
| `autonomous_safe` | `agent_assist` | Agent 建议必须人工批准 |
| `autonomous_safe` | `agent_autonomous_safe` | 才允许 Policy Gate 自动审批低风险白名单动作 |

任一全局、租户、事故或任务 kill switch 关闭写权限时，结果均降为 `observe`。不得用 Agent 模式提升控制面权限。

## 7. 数据模型

采用加法迁移，不改写现有任务历史。

### 7.1 `ops_control_runs`

记录一次租户值守窗口或一次即时复核：

- `id`, `tenant_id`；
- `window_start`, `window_end`, `digest_due_at`；
- `control_mode`, `agent_mode`, `policy_version`, `status`, `verdict`；
- `snapshot_count`, `last_observed_at`, `next_observe_at`；
- `summary`, `evidence_digest`；
- `started_at`, `finished_at`, `created_at`, `updated_at`。

### 7.2 `ops_control_incidents`

记录去重后的事故：

- `run_id`, `tenant_id`, `fingerprint`；
- `category`, `severity`, `status`；
- `schedule_id`, `occurrence_id`, `round_id`, `task_id`, `item_id`；
- `agent_id`, `source_agent_id`, `successor_agent_id`, `assignment_revision`, `lease_token_digest`；
- `host_id`, `profile_id`, `platform_account_id`, `challenge_scope`；
- `keyword_ref`、`content_mode` 或其他脱敏业务项引用；
- `stage`, `search_generation`, `result_generation`, `confirmed_filter_at`；
- `first_seen_at`, `last_seen_at`, `resolved_at`；
- `evidence`, `decision`, `requires_human`；
- `automatic_action_count`, `cooldown_until`。

同一租户和有效事故指纹只允许一个开放事故。

### 7.3 `ops_control_actions`

记录每个建议、执行和验证结果：

- `incident_id`, `tenant_id`, `action_type`；
- `request_key`, `action_sequence`, `retry_authorization_id`, `policy_version`, `decision_source`: `rule / human / agent`；
- `status`: `proposed / rejected / executing / verifying / succeeded / failed / expired`；
- `target_refs`, `preconditions`, `redacted_input`；
- `execution_result`, `verification_result`；
- `technical_dispatch_count`, `business_attempt_count`, `safety_handoff_count`, `control_action_count`；
- `lease_owner`, `lease_revision`, `lease_expires_at`, `candidate_pool_override_id`；
- `started_at`, `verified_at`, `finished_at`。

### 7.4 `ops_control_snapshots`

只保存规范化摘要和证据引用，不复制完整任务大对象：

- 计划/任务/工作项状态计数；
- 执行端 Agent 在线、版本与执行槽摘要；
- 业务进展和 AI 队列时间点；
- 关键 schedule/occurrence/round/task/item/attempt/event ID；
- host/profile/平台账号、host active slots 和资源压力；
- 平台、`content_mode`、采集 `stage`、搜索代际和筛选确认；
- storage 用量、待上传数、本地执行锁和活动页面数；
- 请求发布时间范围、结果时间范围、超界数和重复数；
- `business_terminal_at / local_closed_at`、终态后非终态快照数和终态后 observation 数；
- 脱敏后的异常码和统计。

原始事实仍以现有业务表为准，快照只用于比较与审计。

### 7.5 `ops_agent_investigations`

只记录真正进入 Agent 的长尾调查，不把普通规则 tick 记成 Agent 调用：

- `incident_id`, `tenant_id`, `objective`, `status`；
- `model`, `prompt_version`, `policy_version`, `input_digest`；
- `provider`, `provider_region`, `provider_request_id`；
- `hypotheses`, `selected_evidence_ids`, `tool_rounds`；
- `recommended_action`, `gate_decision`, `final_verdict`；
- `input_tokens`, `output_tokens`, `estimated_cost`, `billed_cost`, `billing_price_version`；
- `started_at`, `finished_at`, `escalated_at`。

不保存模型隐藏推理文本；只保存结构化假设、证据选择、工具结果引用和最终决策。原始网页内容和客户生成内容均视为不可信数据，不得作为系统指令。

### 7.6 配套台账

还需建立或复用以下持久化对象：

- `ops_control_digests`：晨报版本、覆盖窗口、生成状态和发送状态；
- `ops_control_notifications`：provider、模板、delivered/failed/acknowledged、备用通道和事件键；
- `ops_control_sentinel_checks`：外部哨兵最近成功、失联和恢复事件；
- `ops_control_tenant_settings`：`control_mode`、`agent_mode`、时区、窗口、预算、kill switch 和 opt-in；
- `ops_control_approvals`：审批人、权限、批准范围、有效期和执行结果；
- `ops_safety_policies`：版本化 `eligible_search_challenge` 白名单、平台/阶段/挑战码、最低 detector 版本、启停与审计；
- `ops_candidate_pool_overrides`：父任务原候选池、临时池、baseline digest、owner、reason、TTL、恢复状态和验证结果；
- `ops_next_occurrence_guards`：候选池恢复后的计划模板 digest、待观察 occurrence、验证截止时间和后续污染事故；
- 执行 lease 台账：item/attempt/agent/account/host/revision/token、ACK/START/排空/释放时间和终止原因，数据库层保证单 item 单 active lease。

所有台账定义租户隔离、保存期、归档策略和脱敏规则；不得永久保存完整诊断包或模型输入。

### 7.7 Evidence ID 与事故指纹

- Evidence ID 格式包含 `tenant / source_type / source_id / revision / observed_at / digest`；
- 证据过期或源 revision 变化后必须重新读取，模型不能复用旧事实执行动作；
- 事故 fingerprint 至少包含 `tenant_id / category / scoped_target / platform / policy_version`；
- fingerprint 算法版本化，升级时保留旧新关联，避免重复打开同一事故；
- `last_seen_at` 更新不改变 `first_seen_at`，事故关闭后同指纹再次出现应创建 successor incident；
- Evidence ID 和 fingerprint 都是服务端生成，模型只能引用。

## 8. 控制面用例与 Agent 工具契约

### 8.1 只读证据工具

模型可见工具 ID 统一使用 `snake_case`；内部应用函数可使用 `camelCase`，但必须由唯一 registry 映射：

| Model tool ID | 内部应用用例 | 用途 |
|---|---|---|
| `get_task_evidence` | `getTaskEvidence` | 任务、工作项、attempt、命令和事件 |
| `get_fleet_evidence` | `getFleetEvidence` | 同租户平台分布、执行端版本、心跳和成功率 |
| `get_persistence_evidence` | `getPersistenceEvidence` | observation/record 的可验证写入 |
| `get_ai_pipeline_evidence` | `getAiPipelineEvidence` | prefilter、标注、评论和 failover 状态 |
| `get_incident_timeline` | `getIncidentTimeline` | 已发生的快照、动作和验证结果 |
| `get_stage_timeline` | `getStageTimeline` | 搜索、筛选、列表、详情、评论、博主指标、增强和同步的逐阶段事实 |
| `get_extension_runtime_evidence` | `getExtensionRuntimeEvidence` | 本地执行锁、活动页面、待上传、timer/listener 和终态清场 |
| `get_storage_evidence` | `getStorageEvidence` | storage 用量、配额、压力级别、安全压缩结果和写延迟 |
| `get_host_capacity_evidence` | `getHostCapacityEvidence` | 同物理机 Profile、active slots、心跳、阶段延迟和容量准入 |
| `get_result_quality_evidence` | `getResultQualityEvidence` | 筛选条件、发布时间范围、详情完整性、重复和超界结果 |

`collectOpsSnapshot` 与 `assessOpsHealth` 是控制面内部用例，不暴露给模型自由调用。

这些工具返回结构化事实、证据 ID、新鲜度和缺失字段，不返回任意日志全文、Cookie、Token 或可执行文本。Agent 只能从这些工具中选择下一步取证，不能拼接自由 SQL。

### 8.2 受控动作工具

所有动作使用唯一 action registry：

| `action_type` | 内部应用用例 | 风险级别 | Agent 可否提交 | 专用 Verifier |
|---|---|---:|---:|---|
| `wait_with_backoff` | `scheduleControlRecheck` | L0 | 否，由控制面决定 | 冷却到期后只创建一次验证观察；若业务仍推进则不产生写动作 |
| `retry_failed_items` | `retryFailedItems` | L1 | 是 | 新 attempt、进度与最终结算 |
| `handoff_unfinished_items` | `handoffUnfinishedItems` | L1 | 是 | 新 revision、旧写回拒绝、新执行端推进 |
| `shard_retryable_items` | `shardRetryableItems` | L1 | 否，由确定性控制面按 item 分片 | 每 item 单 active lease、候选锁内复核、逐项去向与成功项不重跑 |
| `reserve_recovery_round` | `startReserveRecoveryRound` | L1 | 否，由确定性控制面按预算闸门判定 | `reserve_recovery_count` 从 0 原子增至 1，继承检查点；再次失败不再创建新轮 |
| `reconcile_observed_completion` | `reconcileObservedCompletion` | L1 | 是 | observation lineage、执行静默、虚假后续 attempt 封存与不再派发 |
| `handoff_platform_safety_once` | `handoffPlatformSafetyOnce` | L1 | 否，由确定性控制面判定 | 账号不同、安全次数 1、新 revision 推进；二次挑战强制人工 |
| `resume_from_checkpoint` | `resumeFromCheckpoint` | L1 | 是 | 已成功项不重跑、未完成项推进 |
| `reconcile_stale_capture_state` | `reconcileStaleCaptureState` | L1 | 是 | 权威状态机输出，不允许自由改状态 |
| `quarantine_agent_scope` | `quarantineAgentScope` | L1 | 是 | 限域停止派单、TTL/探测解除 |
| `quiesce_terminal_execution` | `quiesceTerminalExecution` | L1 | 是 | 精确 lineage 停止、页面/锁/待上传归零，业务结果不改写 |
| `set_candidate_pool_override` | `setCandidatePoolOverride` | L1 | 是 | 仅当前父任务生效，baseline/TTL 完整 |
| `restore_candidate_pool` | `restoreCandidatePool` | L1 | 否，由控制面强制收尾 | baseline 与当前计划模板恢复，并成功登记 `next_occurrence_guard`；未来污染另开事故 |
| `decline_new_lease_on_saturated_host` | `declineNewLeaseOnSaturatedHost` | L1 | 是 | 在途任务不受影响，新 lease 停止并逐槽恢复 |
| `notify_human` | `enqueueOpsNotificationByTemplate` | L0 | 否，由控制面决定 | delivered/failed/acknowledged |

`verifyControlAction`、`generateOpsDigest` 和通知发送是控制面内部用例，不作为模型可自由调用的工具。模型只能返回 `requiresHuman`、模板枚举和证据 ID，不能构造通知正文、收件人或任意 payload。

`rebuild_runner_tab`、内容脚本重连和本地同步补传仍属于 Extension 自愈运行时，不作为 LLM 可直接调用的浏览器工具。控制面只观察其结构化结果，必要时调用更高层的 `resumeFromCheckpoint` 或 `handoffUnfinishedItems`。

### 8.3 通用工具返回契约

所有工具统一返回：

```json
{
  "ok": true,
  "code": "ACTION_ACCEPTED",
  "evidenceIds": ["task:...", "attempt:..."],
  "preconditionsCheckedAt": "2026-08-24T00:00:00Z",
  "actionId": "...",
  "verificationState": "pending",
  "retryable": false
}
```

实现约束：

- 工具入参不接受模型自由提供的 SQL、URL、Header 或租户 ID；
- item ID 必须来自当前证据集合；
- 动作用例内部重新读取并锁定当前状态，不能信任旧快照；
- 每个写操作使用事务、幂等键和现有 revision/fencing；
- 返回结构化错误码，不能让模型靠自由文本猜测；
- 每个动作必须返回待验证状态，不能因命令受理直接标记恢复；
- HTTP 路由、控制面和 Agent Tool Adapter 调用同一应用服务，禁止复制行为。

### 8.4 幂等、事务与崩溃恢复

- `request_key = SHA-256(tenant_id | incident_id | action_type | sorted_target_refs | assignment_revision | action_sequence)`；
- `ops_control_actions(tenant_id, request_key)` 建唯一约束，重复 tick 只能读取原动作；
- 初次动作 `action_sequence = 1`；预算周期、策略版本或进程重启都不能自动改变 sequence；
- 只有前一动作已终态失败/过期、Verifier 再次证明事故仍存在，并生成显式 `retry_authorization_id` 后，才允许递增 `action_sequence`；
- `retry_authorization_id` 记录规则/人工批准者、原因、前一 action、有效期和重新校验结果；
- 动作台账、业务命令或 outbox 事件必须在同一 PostgreSQL 事务中提交；不得先记成功再发送命令；
- 外部副作用由带 `lease_owner / lease_revision / lease_expires_at` 的 executor 领取，旧 lease 回写无效；
- 进程崩溃后先重读动作、命令和业务状态，再决定续执行或只进入验证；
- 人工批准记录 `approved_by / approved_at / approval_expires_at`，执行前重新校验目标 revision 和安全状态；
- `reconcile_stale_capture_state` 只能调用已有权威状态机和修复用例，不能把“reconcile”解释为任意更新数据库状态。

### 8.5 P0 五类执行计数与 P1 Agent 预算

| P0 执行计数 | 消耗时点 | 是否返还 | 谁能调整上限 |
|---|---|---|---|
| `technical_dispatch_count` | 一次真实 bootstrap/技术派发 START 时 | 取消于开始前不扣；失败后不返还 | 租户策略/任务策略 |
| `business_attempt_count` | 页面 ready 后进入真实业务步骤时 | 不返还 | 现有 `maxAttempts` |
| `safety_handoff_count` | 首次 item 级白名单 `eligible_search_challenge` 后，不同平台账号 successor 真正 START 时 | 不返还；每 item/occurrence 硬上限 1 | 全局安全策略，模型和租户不得提高 |
| `reserve_recovery_count` | 普通预算耗尽后的备用 recovery epoch 真正 START 时 | 未 START 不扣；执行后不返还；每 item/occurrence 硬上限 1 | 全局恢复策略，模型和租户不得提高 |
| `control_action_count` | 新的有效 action/command 创建时 | 幂等重放不重复扣；已执行不返还 | 运维策略 |

P0 五类执行计数分别持久化，进程重启后继续。模型只能读取剩余额度，永远不能提高、重置或把技术失败改写成业务成功。

`agent_compute_budget` 是阶段 C/P1 的独立模型调用与费用预算，每次模型或工具调用实际发生时扣减，不返还，由租户与全局预算共同限制。它不是第六类 P0 执行计数；关闭 LLM 时，P0 五类计数和全部确定性恢复仍完整工作。

### 8.6 Verifier 成功语义

- `action accepted`：策略和事务已受理；不代表执行成功；
- `action succeeded`：动作专属后置条件在截止时间内成立；
- `incident resolved`：造成事故的业务影响消失且没有新的同指纹失败；
- 任务仍有新鲜业务进度时，Verifier 可以在总截止时间内续等，不得反复创建新动作；
- 超过动作验证截止时间、出现反证或业务无进展时，动作判失败并保留证据；
- Verifier 必须可重入，同一 action 重复验证不能产生业务副作用；
- 通知以 provider `delivered` 为最低成功条件；仅写入通知队列不算送达，失败时走备用通道或外部哨兵升级。

### 8.7 真正的 Agent 循环

Agent 的固定目标是：

> 在值守窗口截止前，让所有预期计划获得可验证结论；能安全恢复则恢复，不能安全恢复则停止扩散并给出唯一人工入口。

每次调查最多执行受预算限制的循环：

1. 读取当前事故和已有证据；
2. 生成不超过 3 个可验证假设；
3. 选择一个最能区分假设的只读工具；
4. 根据新事实更新置信度；
5. 若存在白名单动作，提交结构化建议给 Policy Gate；
6. 动作执行后调用 Verifier，而不是相信工具受理结果；
7. 验证失败时选择不同证据或动作路径；
8. 达到工具轮次、时间、token 或动作预算后停止并升级人工。

如果 Agent 每次都执行相同工具序列，它应退化为规则工作流并从 Agent 中移除。

## 9. LLM 使用边界

### 9.1 何时调用

不需要 LLM：

- 明确的完成、运行、离线、验证码、超预算，以及父子任务投影不一致等确定性状态冲突；
- 已有规则能够唯一映射到动作；
- 普通每分钟观察；
- 规则晨报和固定格式通知。

需要 LLM：

- 多个异常同时出现，现有规则无法区分主因和次生问题；
- 规则无法区分单机异常、平台页面变化和系统性退化；
- 第一个安全恢复路径验证失败，需要选择不同探针或动作。

互斥路由顺序：先判登录/人工停止和验证码类安全证据；对首次 item 级白名单 `eligible_search_challenge` 由确定性 Policy Gate 评估一次性跨账号复核，其余安全证据直接人工；再判确定性 `projection_inconsistent`、已知恢复规则；只有剩余的 `ambiguous_cross_layer` 才能创建 Agent 调查。

结构化事故结论可以选择用模型润色晨报，但它属于可选展示层：不创建 Agent investigation、不触发工具循环、不计为 Agent 成功，失败时直接使用规则模板。

### 9.2 输出契约

模型只能返回结构化建议：

```json
{
  "status": "observing|progressing|recovering|draining|verifying|settled",
  "verdict": "healthy|degraded|blocked_manual|incident",
  "incidentCategory": "task_stalled",
  "confidence": 0.92,
  "hypotheses": [
    {"code": "agent_local_failure", "confidence": 0.72},
    {"code": "platform_wide_failure", "confidence": 0.28}
  ],
  "evidenceIds": ["task:...", "item:...", "event:..."],
  "nextEvidenceTool": "get_fleet_evidence",
  "recommendedAction": "retry_failed_items",
  "targetItemIds": ["..."],
  "requiresHuman": false,
  "reason": "结构化证据支持的简短说明"
}
```

服务端必须拒绝：

- 未知枚举；
- 不存在或跨租户的证据 ID；
- 模型自行新增的动作名；
- 缺少证据的高风险结论；
- 模型建议与确定性安全策略冲突的动作。

### 9.3 不可信内容与提示注入边界

- 平台页面正文、评论、用户名、错误文本和第三方 API 返回均视为不可信数据；
- 原始内容只能作为被引用证据，不能进入 system/developer 指令区；
- 模型不得根据页面中的“忽略规则”“执行命令”“访问链接”等文字调用工具；
- 工具名称、参数 Schema、租户上下文和可选证据 ID 由服务端注入；
- 不允许模型生成 URL、Header、SQL、Shell、选择器代码或凭证；
- 检测到内容疑似提示注入时，保留脱敏指纹并按普通数据处理，不把它升级为指令。

### 9.4 模型路由、降级和成本

- LLM 不可用时继续运行规则分类、自动恢复和规则晨报；
- 每个事故只在状态实质变化时重新分析；
- 输入只包含诊断摘要和必要错误字段；
- 默认使用低成本模型做证据归纳并关闭思考模式；只有长尾事故允许升级一次高能力模型；
- 配置租户级每晨调用、工具轮次、token、金额和墙钟时间预算；推荐初始金额硬上限为每租户每早晨 `¥1`，灰度后按账单校准；
- 达到任一预算立即停止 Agent 循环，控制面继续运行并按证据决定晨报或人工通知；
- 记录模型、提示词版本、输入摘要哈希和输出，不记录密钥；
- 记录实际 token 与账单价格，不能把估算成本当作真实账单；
- Agent 自身的 AI 调用不得阻塞采集、落库和已有恢复链路。

### 9.5 租户、供应商与数据治理

- 智能值守 Agent 按租户显式 opt-in，控制面 P0 不因未授权模型供应商而停用；
- 为模型供应商记录服务区域、数据保留、训练使用承诺和合同版本；
- Agent 输入采用字段 allowlist，并用自动测试证明 Cookie、Token、账号、客户正文和个人信息不会出站；
- Admin 权限拆为查看结论、批准动作、修改预算、启停 Agent 和审计导出，批准人不能越过租户边界；
- 模型密钥只存在服务端 secret store，支持轮换和撤销，不进入任务、快照、日志或前端；
- 出站网络限制到批准的模型 API，禁止模型工具访问任意 URL；
- Prompt、结构化输入输出和调查台账按租户策略设保存期，到期删除或只保留不可逆聚合指标。

## 10. 通知与用户体验

### 10.1 通知分级

| 级别 | 场景 | 行为 |
|---|---|---|
| 绿色 | 全部正常或已自动恢复并验证 | 不即时打扰，只进晨报 |
| 黄色 | 有非阻断异常、正在恢复、部分业务跳过 | 默认只进晨报 |
| 红色 | 登录失效、不符合一次安全复核条件或复核后再次出现的验证码、全部兼容执行端 Agent 离线、预算耗尽、系统性停滞 | 去重后即时通知 |

红色通知必须包含：

- 一句话结论；
- 受影响的计划、任务、平台和执行端 Agent；
- 系统已经做过什么；
- 为什么不能继续自动处理；
- 唯一处理入口；
- 不包含验证码、Cookie、Token 和客户敏感内容。

通知状态必须区分 `queued / accepted / delivered / failed / acknowledged`。`queued` 或 provider `accepted` 只能证明已受理；超过送达阈值仍未 `delivered` 时切换备用通道。同一 `event_key` 去重即时通知和恢复通知；全部主应用通道失败时由外部哨兵使用独立凭证告警。

### 10.2 运维晨报

晨报和舆情日报分离，默认建议在 `08:30 Asia/Shanghai` 生成，最终时间由租户设置确认。值守窗口内全部预期任务提前结算时可以提前准备晨报；到截止时间仍有健康运行中的任务时，晨报必须明确写“仍在执行、无需人工，控制面继续守候”，并在最终结算或转红后补充状态变化，不能把未结算任务伪装为已完成。

内容固定为：

1. **总判定**：正常 / 已自动恢复 / 仍在执行且无需人工 / 需要处理；
2. **计划覆盖**：应运行、已生成、未生成、已结算；
3. **工作项结果**：成功、业务跳过、失败、需人工；
4. **执行端 Agent 状态**：在线、离线、版本异常、安全阻断；
5. **自动动作**：动作、对象、时间、验证结果；
6. **数据闭环**：落库与 AI 后处理是否继续；
7. **值守链路健康**：控制面最近观察、外部哨兵最近探测、晨报投递状态；
8. **人工事项**：没有则明确写“无需处理”。

### 10.3 Admin

第一版不增加独立复杂页面，在现有指挥中心增加“昨夜值守”区域：

- 总判定和最近观察时间；
- 应运行计划与最终结算；
- 自动恢复次数和验证结果；
- 仍需处理事项；
- 展开后查看事故、证据和动作时间线。

任务详情增加“值守记录”，展示建议、策略审批、执行和验证，不允许把模型思考过程或敏感日志直接呈现给客户。

租户设置增加：

- 是否启用值守；
- `observe / assist / autonomous_safe`；
- 晨报时间；
- 通知邮箱；
- 自动操作总开关；
- 允许接力和最大自动预算；
- 暂停值守的 kill switch。

## 11. 实施路线

### 阶段 0：已交付自愈基线

`0.3.91` 作为后续实施的能力基线，不在本方案中重复开发。后续控制面通过结构化事件使用其错峰、技术失败分账、有界接力、小红书工作页重建和同步退避能力，不复制同类逻辑。

阶段 0 的集成要求：

- 控制面能够识别 `0.3.91` 产生的技术次数、业务次数、接力次数和恢复结果；
- 自愈事件包含 task/item/attempt/agent/revision 关联；
- 控制面不得绕过 `0.3.91` 的本地预算另起一套 Tab 或同步重试；
- 生产生效范围继续通过发布台账和浏览器 `app_version` 心跳核验。

### 阶段 0.25：统一开发与发布基线

本文同时出现两种“基线”，含义不同：`0.3.91` 是按产品决策视为已交付的能力契约；`0.3.93`/`911e8d6` 是今早实际运行、后续代码实施必须对齐的 Hotfix 源码与运行行为基线，原则上应包含并延续 `0.3.91` 契约，但必须以差异报告证明，不能靠版本号推断。

今早生产运行的 `0.3.93` Hotfix 系列与当前架构工作分支存在分叉，而本方案文档尚未进入版本控制。实施前必须先建立独立的新 Hotfix 分支，以已发布的 `911e8d6` 系列为行为基线，再与最新主线做显式差异对账。未完成前不在当前架构分支直接开发或部署值守修复，避免将线上已有 Hotfix 再次覆盖。

阶段交付物：

- 可追溯的基线 commit、发布文件 allowlist 和线上/branch 差异报告；
- V4 方案和 `ops-morning-20260827-v1` 脱敏夹具纳入版本控制；
- Server、Extension 源码、`extension-build`、manifest、安装包和生产版本的唯一映射；
- 提交、推送、合并、部署和生产闸门启用分别授权。

### 阶段 0.4：Extension 与物理主机稳定性门槛

值守 Agent 不得用接力掩盖 Extension 自身的可修复故障。在控制面自动动作灰度前，Extension 必须交付：

1. **搜索/筛选/详情阶段代际**：实现第 4.10 节九阶段权威枚举；搜索结果代际和筛选确认事件明确，筛选确认前不得采集，页面已有新结果时刷新进展并令 `wait_state = degraded_waiting`，不因代际证据暂缺立即判失败；软截止不消耗 attempt，硬截止前只允许一次幂等探测，不得盲目重搜整词；
2. **综合/图文拆项**：两种 `content_mode` 分别建立工作项和预算，不再同一 child 隐式跑两轮；
3. **终态清场**：终态后取消 timer/listener/tab 操作，上报 pending upload、active page、local capture lock 和 `local_closed_at`；任务自有标签页以 task/attempt/revision + owner token 登记，默认单详情页复用并在 success/failure/cancel/timeout 的 `finally` 关闭；启动时仅回收无 active lease 的任务孤儿页，用户页永不关闭；
4. **终态提示确认**：终态面板的关闭确认持久化并绑定 task/revision；Extension 打开或 reload 时先对账当前 lease 和本地运行态，无活动任务则显示空闲，旧完成记录仅在任务中心展示；
5. **Storage 准入、控制状态保留与安全压缩**：使用 `getBytesInUse()` 或等价能力暴露水位；所有会影响 lease、task ledger、runtime/heartbeat、停止、终态、关闭确认、页面 owner 和 checkpoint outbox 的写入口必须经过统一 `ControlStorageAdapter`，大数据写入必须经过 quota-aware data adapter，不允许业务代码直接吞掉 `chrome.storage` 写失败；数据池分区/索引，避免每条记录重写整池；为控制状态建立可释放的最小保留空间；只压缩已服务端 ACK、lineage 已终态、无活动 trace 且超过保留期的 synced 明细；active、unsynced、failed、needs_action 永不自动删除；`unlimitedStorage` 只能作为附加护栏，不能替代上限、分区和压缩；
6. **同机容量遥测**：每个 Profile 上报稳定 `host_id`，控制面按 1/2/4/6/8 个同机 Profile 逐级灰度，不直接假设同机 8 个必然可并发；
7. **批量 mutation 和诊断轻量化**：避免每条详情都全量读写 `data_pool`，诊断只读计数、水位和时延，不为统计加载全部正文。

Storage 初始准入值：`<70%` 绿、`70%–80%` 黄、`80%–85%` 橙；`≥85%` 或剩余 `<1.5 MiB` 时压缩后仍不达标则拒绝新重任务；`≥95%`、剩余 `<512 KiB` 或实际写失败为红。这些是灰度初值，必须经真实数据校准。

Storage 水位以单个浏览器 Profile/Extension storage 为权威 scope，不把多个 Profile 的配额简单相加。Host 准入同时看各 Profile 的最高压力级别、pending uploads 总量、active slots 和阶段延迟：单个 Profile 红色时只禁止向该 Profile 派新重任务；只有 host 级资源指标或多个 Profile 同时退化时才暂停整个 host 的新 lease，在途任务仍按自身安全状态继续或排空。

控制保留区首轮 Hotfix 取 `64 KiB` 可释放占位，最终值由真实 Profile 样本校准。新/升级后的 Profile 在接受任务前先测量水位并建立保留区；历史已满且从未建立保留区的 Profile，只允许预裁剪重复 outbox、已 ACK 且超过保留期的 synced 数据，随后尝试建立保留区，绝不删除 unsynced/failed/needs_action。若仍无法建立，该 Profile 直接拒绝新 lease 并上报 `storage_control_write_blocked`。

任一关键控制写遇到 quota 时，适配器释放保留区、安全压缩并最多重试一次。若保留区成功释放，停止、锁释放、关闭确认和 `local_closed_at` 必须持久化；若保留区本身不存在/损坏或第二次控制写仍失败，Extension 立即停止新详情和页面动作，在内存本地态进入 `storage_blocked` 并直接向服务端报告事故 `storage_control_write_blocked`。服务端状态进入 `local_close_unconfirmed`，撤销 lease 且绝不判绿；报告也不可达时，由阶段硬截止和 sweeper 完成同一撤租。首轮灰度把“正在接管浏览器”阶段硬截止设为 120 秒，sweeper 最多再用 60 秒，因此无单调进展的旧任务最迟约 3 分钟转成明确的 `local_close_unconfirmed`/已撤租状态，而不是停留 10 小时。该 120/60 秒是可配置灰度初值，必须用慢网和 8 Profile 实测校准；storage 技术故障不得消耗业务 attempt。

### 阶段 0.5：事实契约与兼容层

`0.3.91` 已交付的是自愈行为，不代表 Agent 所需的完整跨层事实契约已经存在。阶段 0.5 必须补齐：

| 字段/事件 | 权威生产者 | 兼容要求 |
|---|---|---|
| `schedule_id / occurrence_id / round_id` | Scheduler/编排服务 | 老任务缺失时只读对账，不进入自动写动作 |
| `task_id / item_id / attempt_id` | 云任务状态机 | 每个 successor attempt 保留父 attempt |
| `agent_id / assignment_revision / lease_token` | 调度与执行端 Agent | 迟到回传必须携带旧 revision/lease 并被拒绝 |
| `host_id / profile_id / platform_account_id` | 执行端注册与社媒账号绑定 | 物理机容量、浏览器执行与平台账号风险三者分开管理 |
| `keyword_ref / business_item_ref / content_mode` | 任务创建者 | 可脱敏但不可删除逐项对账引用；综合/图文分项 |
| `business_progress_at / progress_seq` | 执行端 Agent 与服务端 | 单调推进，重试不得倒退 |
| `stage / search_generation / result_generation / confirmed_filter_at` | Extension | 搜索、筛选和采集不得跨代际串扰 |
| `result_visible_at / last_stage_progress_at / soft_deadline_at / hard_deadline_at / wait_state / wait_reason / wait_started_at / probe_count` | Extension | 慢网中间态可回放；`degraded_waiting` 在新进展/阶段确认时清除，硬截止写 `hard_deadline_exceeded` 后结算；探测最多一次 |
| `storage_bytes_used / quota_bytes / pending_uploads / control_reserve_bytes / storage_pressure` | Extension storage adapter | 只上报数值和压力级别，不上传客户正文 |
| `owned_page_count / owned_page_ids_hash / terminal_summary_ack` | Extension | 页面 ID 原文仅留本地，云端只需数量/hash；用户页不得进入 owner 集合 |
| `daily_searches / daily_search_limit / usage_date` | 社媒账号用量账本 | 调度按账号/平台/自然日计数，硬上限不可被备用轮绕过 |
| `reserve_recovery_count / recovery_epoch` | 调度状态机 | 每 item/occurrence 最多一次，普通 attempt 不能通过新 child 重置该计数 |
| `requested_publish_window / observed_publish_time` | 任务创建者 / Extension | 支持证明筛选后的业务结果正确 |
| `business_terminal_at / local_closed_at` | 服务端 / Extension | 业务终态与本地清场分开，终态后活动可识别 |
| `persistence_evidence_id` | record store | 指向 observation/record，不复制客户正文 |
| `ai_pipeline_state` | prefilter/label/comment worker | 支持 `not_applicable / skipped_by_policy / pending / completed / failed` |
| `diagnostic_id / payload_hash` | 诊断导出 | 可识别重复包、迟到包和缺失节点 |

Schema 必须版本化。旧版执行端 Agent 缺少关键字段时允许继续原有采集，但控制面最多运行 `observe`；不得因模型推断补造 ID 或升级到自动动作模式。

### 阶段 A：无 LLM 的只读控制面与晨报

目标：先让系统替人完成每天早上的核账，但不自动写生产状态。该阶段只是诊断里程碑：它能减少人工翻数据库，但发现故障后仍需人起床处理，因此不能单独宣称实现“不用早起”。

工作包：

1. 加法迁移建立 run/incident/snapshot/digest 台账；
2. 实现统一 Ops Snapshot Collector；
3. 实现确定性状态和事故分类；
4. 用相邻快照判断进展、停滞和最终结算；
5. 生成规则版晨报并接入现有邮件基础设施；
6. 提供控制面健康端点并接入独立失联哨兵；
7. 在指挥中心展示昨夜总判定；
8. 对历史无人值守记录进行离线回放。

Gate A：

- 连续回放能区分历史失败与最终恢复；
- 不把模板、旧 `needs_action` 或历史 failed 当成当前阻塞；
- 不以 PM2、`/api/health` 或执行端 Agent 在线单独判绿；
- 主服务或控制面本身失联时，独立哨兵能够通知；
- 跨租户测试为 0 泄漏；
- 不接入任何 LLM 仍能生成可用晨报；
- 2026-08-24 晨间事故回放全部得到正确结论。
- 2026-08-27 夹具中的迟到完成、命令过期影响、终态后执行、临时候选池和首次安全复核候选均能无人工 SQL 识别。

### 阶段 B：无 LLM 的安全动作与验证闭环

目标：自动执行经验证的确定性动作，完成真正的“不用早起”P0。

工作包：

1. 从路由中提取 action registry 对应的受控应用用例，路由、控制面和 Agent 工具不再复制状态变更逻辑；
2. 实现 Policy Gate；
3. 建立 action 台账、单 item 单 active lease、幂等、冷却和崩溃恢复；
4. 开启 command 影响对账、失败项自动分片、未完成项接力、每 item 一次备用恢复轮和基于权威 observation/Extension 终态证据的完成对账；
5. 实现两阶段终态、终态执行排空和业务正确性 Verifier；
6. 实现一次性跨账号安全复核、账号冷却和二次挑战人工通知；
7. 实现候选池 override 的建立、TTL、自动恢复和下一 occurrence 污染验证；
8. 按 host 容量和 storage pressure 控制新 lease；
9. 候选排序接入日搜索使用率和硬上限；人工恢复页默认展示自动分配预览，可逐 item 覆盖而不是一个单选框承载全部失败词；
10. `observe → assist → autonomous_safe` 逐级开关。

Gate B：

- 同一事故重复运行不产生重复有效动作；
- 成功项不重跑；
- 旧 attempt/revision/lease 回写全部被拒绝；
- 验证码不被自动解题，仅白名单 `eligible_search_challenge` 同 item/occurrence 最多 1 次不同账号复核，登录错误和非白名单挑战从不自动重试或接力；
- create command 未 ACK/未 START 消耗业务 attempt 为 0；
- 终态后页面操作、本地锁、pending upload、active command、active attempt、active lease 和当前-lineage 执行端槽位全部为 0，且无同一 item 双 active；
- 临时候选池在关联项收口后 30 秒内恢复，计划模板即时核验，并登记下一 occurrence 延后防污染检查；
- 动作 HTTP/用例返回成功但业务不推进时，不能标记恢复；
- 3–4 个同时失败的 item 在存在足够容量时分配到多台 Agent；任何 item 双 active 为 0，日搜索硬上限越界为 0；
- 普通预算耗尽后的真失败最多只有一次备用恢复轮；安全/登录/取消失败进入备用轮为 0，成功项重跑为 0；
- 进程在动作执行中终止后可安全恢复验证。

### Agent 非生产开发准入门（Development Readiness Gate）

同时满足以下条件才允许进入阶段 C 的离线开发与评测；此门不授权接入生产流量或真实写工具：

1. 2026-08-24 与 2026-08-27 已知事故回放在关闭 LLM 时全部通过；
2. 六类现有业务任务的每个 occurrence 都能关联到最终工作项、attempt、lease、落库和 AI 后处理证据；
3. action registry 的全部 L1 用例均通过幂等、并发、进程重启、租户/账号/host 边界和业务级验证；
4. 假动作成功但业务无进展时，Verifier 能稳定判失败；
5. 验证码解题/绕过、第二次跨账号安全接力、登录失效接力、跨租户目标和未知动作被 100% 拒绝；
6. 独立哨兵能在主应用与控制面同时失联时告警；
7. 单租户 `observe` 建议连续运行至少 7 个晨间窗口，误报绿色、漏掉预期计划和跨租户泄漏均为 0；
8. 具备 Agent 独立 kill switch、每晨金额预算和工具轮次上限。

任何一项未满足，都继续补控制面，不用模型掩盖基础设施缺口。

### 阶段 C：真正的 Agent 调查与辅助处置

目标：让规则无法唯一判断的长尾事故具备自主取证、假设更新、动作建议和失败后重新规划能力，不改变安全边界。

阶段 C 默认使用脱敏回放和故障注入；在下一道门通过前，Model Tool Adapter 不持有生产写权限。

工作包：

1. 实现只读证据 Tool Adapter 和受控动作 Tool Adapter；
2. 定义假设、证据选择、动作建议和最终结论 JSON Schema；
3. 增加证据 ID、工具参数、prompt/version 和模型成本审计；
4. 用保留场景测试 Agent 是否会选择不同探针并在失败后改变计划；
5. 第一阶段只启用 `agent_observe`，再升 `agent_assist`；
6. 规则结论与模型建议冲突时始终以规则为准；
7. 建立费用、延迟、工具轮次、失败和降级指标。

Agent 生产启用门（Production Enablement Gate）：

- 模型输出不能绕过策略闸门；
- 编造证据和未知动作全部拒绝；
- 模型不可用不影响自动恢复；
- 历史回放中，模型不得把最终成功误报为当前失败；
- 至少一个未写死动作序列的混合事故中，Agent 能通过取证缩小假设；
- 第一个建议动作被模拟为无效后，Agent 能选择不同路径或正确停止；
- 如果 Agent 相比规则基线没有增加长尾事故解决率，则不进入生产。

### 阶段 D：单租户 Agent 灰度与扩大

1. 控制面保持 `autonomous_safe`，Agent 单独以 `agent_observe` 灰度；
2. Agent 升为 `agent_assist`，人工核对证据、建议和停止条件；
3. 先在关键词无人值守上开启 `agent_autonomous_safe`，且只能提交既有低风险白名单动作；这是写动作灰度顺序，不是事实模型只支持关键词；
4. 验证 Agent 动作失败后的重规划、预算终止和人工升级；
5. 依次扩到负面内容巡查、关注内容巡查、官方账号评论巡查、关注博主作品扫描和官方账号作品发现；六类任务从阶段 0.5 起已共用一套 occurrence/item/attempt/lease/evidence 契约；
6. 达到验收门槛后才向其他租户开放。

每次扩大都必须记录目标租户、任务类型、执行端 Agent、Extension 版本、时间窗口和回滚开关。

晋级必须满足 12.4 的灰度分母和安全不变量。出现误报绿色、非法工具参数、越权/跨租户、重复副作用、预算后继续调用或模型不可用影响 P0 任一情况，立即将 Agent 降为 `agent_off`；控制面保持原模式继续值守。

## 12. 测试与验收

### 12.1 测试矩阵

| 层级 | 必测内容 |
|---|---|
| 纯函数 | 状态分类、事故指纹、严重度、动作矩阵、预算和冷却 |
| PostgreSQL | 租户隔离、唯一开放事故、动作幂等、租约、revision 和并发领取 |
| 应用用例 | action registry 全部 L1 动作的前置校验、事务、幂等和业务验证 |
| HTTP | 权限、租户、错误码、只读与写操作边界 |
| Worker | 重启、重复 tick、锁丢失、动作中断和验证续跑 |
| LLM Agent | Tool 选择、Schema、编造证据、提示注入、重规划、不可用降级和费用上限 |
| Extension | Chrome/Edge 心跳、搜索/筛选/详情代际、综合/图文拆项、检查点、storage 准入/压缩、迟到回传、终态清场和真实恢复 |
| 端到端 | 计划生成 → 采集 → 失败 → 自动动作 → 验证 → 晨报 |

### 12.2 必测场景

1. 全部任务正常完成；
2. 历史失败但接力后最终全部完成；
3. 执行端 Agent 在线、任务心跳新，但业务进展停滞；
4. 执行端 Agent 离线，存在兼容空闲执行端 Agent；
5. 执行端 Agent 离线，不存在兼容执行端 Agent；
6. 抖音临时服务异常；
7. 抖音/小红书验证码或登录失效；
8. 搜索无结果、内容删除或范围外；
9. 任务显示完成但没有可验证落库；
10. AI 积压增长、PM2 和 health 仍正常；
11. 自动动作接口成功但下一观察无进展；
12. 同一事故重复 tick 和进程重启；
13. 两个控制面 Worker 同时尝试领取；
14. 旧执行端 Agent 在接力后迟到回传；
15. 其他租户存在相似 task/item ID 或错误指纹；
16. Scheduler 停止但 API 仍在线；
17. 整台主服务不可达，独立哨兵仍能告警和识别恢复。
18. create command 未 ACK/未 START 过期，只释放技术 lease，不消耗业务 attempt；
19. 早期 attempt 有 observation，后续虚假 attempt 工作量为 0，自动对账且不重跑已完成项；
20. item 投影已终态但浏览器仍继续采集，与只有旧数据延迟上传的情况分别正确处理；
21. 首次白名单 `eligible_search_challenge` 之前已有技术失败，安全复核预算仍正确为 1；第二个账号再次挑战时没有第二个 successor；
22. 临时候选池完成故障接力后自动恢复，下一 occurrence 未被污染；
23. 抖音第一次搜索代际证据暂缺、页面已出结果，不误判离线；筛选未确认时不开始采集；
24. 已获得作品链接但详情页打开缓慢，按阶段 deadline 续等或精确恢复，不重搜整个关键词；
25. storage 剩余不足或写失败，拒绝新重任务并保护 unsynced/failed/active 数据，技术故障不消耗业务 attempt；
26. 同机 8 浏览器与跨机 6 执行端 Agent 分组并发，不得用 14 台平均掩盖单 host 拥塞；
27. 综合/图文两个工作项独立失败、接力和收口，不串联预算。
28. 父任务已终态但当前 lease 的 Extension 仍推进：指挥中心显示 `draining`，不得掩盖为完成；仅旧 lease 的迟到上传不能污染新 revision；
29. 技术心跳失败一次后首次白名单验证码：仍有且只有一次不同 `platform_account_id` 安全复核；同账号不同 Agent 被拒绝；
30. 4 个失败词与 4 台健康空闲 Agent：一个调度周期内形成 4 个独立 lease；4 个词与 3 台时形成 `1+1+1`，剩余 1 个等待槽位；
31. 候选 A 当日搜索 `80/100`、B 为 `10/100` 且其他条件相同：B 必须胜出；用量缺失或过期不得按 0 处理；
32. 普通预算耗尽后只产生一次备用恢复轮；未 ACK/START 的 create command 不消耗备用轮；真正执行再次失败后不产生第二轮；
33. 抖音可见新结果在慢网下迟到完成筛选：错误失败、业务 attempt 消耗和重复整词搜索均为 0；筛选确认前保存为 0；
34. 负面巡检 success/failure/cancel/timeout/Service Worker 重启后任务自有页面归零，用户自有页面误关为 0；
35. 终态提示关闭后 reload 不复活；quota 且保留区可释放时，停止、锁释放、关闭确认和 `local_closed_at` 必须持久化；保留区也失效时必须在 180 秒内撤租并进入 `local_close_unconfirmed`、不得判绿；两条分支未同步记录丢失均为 0。

### 12.3 Agent 专项保留集

Agent 评测场景不得全部来自 Prompt 中列出的错误码映射。至少包含：

1. 单机页面失效与平台整体异常同时出现，要求 Agent 主动比较设备分布；
2. 动作受理成功但业务进度不前，要求 Agent 否定第一次恢复结论；
3. 诊断包存在重复、缺失和迟到事件，要求 Agent 先识别证据质量；
4. 原始页面内容包含诱导调用工具的文字，要求 Agent 忽略并保持数据边界；
5. 没有合法自动动作的未知事故，要求 Agent 停止并通知人工；
6. 相同事故换一种表述或错误文本，要求 Agent 依赖结构化事实而非关键词命中。

专项验收看的是选择了什么证据、是否安全停止、能否根据结果改变计划，不以晨报文字是否流畅作为 Agent 成功。

### 12.4 产品验收硬指标

发布测试不变量：

- 预期无人值守运行覆盖率：`100%` 有结论；
- 同一工作项同时存在两个有效执行者：`0`；
- 重复自动动作产生重复业务副作用：`0`；
- 安全验证被自动解题/绕过：`0`；同 item 跨账号安全复核超过 1 次：`0`；
- 跨租户读取、行动或通知：`0`；
- “接口调用成功但未恢复”被报告为恢复：`0`；
- 晨报遗漏未结算计划：`0`；
- 控制面自身失联后无任何外部告警：`0`；
- 已知事故调用 LLM 才能完成恢复：`0`；
- Agent 绕过 Policy Gate 执行动作：`0`；
- Agent 在预算耗尽后继续调用模型或工具：`0`；
- create command 未 ACK/未 START 却消耗业务 attempt：`0`；
- 人工/观测完成对账后再次派发同 item：`0`；
- 筛选确认前开始采集：`0`；超出请求发布范围仍判绿：`0`；
- completed 后非终态 snapshot、页面动作、active lease/command 或 quiet window 后新当前-lineage observation：`0`；
- 临时候选池未在关联 item 收口后 30 秒内恢复：`0`；
- storage 写失败或 storage 技术故障消耗业务 attempt：`0`；
- 业务终态掩盖当前 lease 的本地运行：`0`；终态后任务自有页面：`0`；用户页面误关：`0`；
- 已关闭的终态提示在 reload 后复活：`0`；quota 下未同步数据丢失：`0`；保留区可释放却无法持久化停止/锁释放：`0`；保留区失效后超过 180 秒仍显示“正在接管”或错误判绿：`0`；
- 存在足够合格容量时，多失败 item 被默认绑定到同一 Agent：`0`；日搜索硬上限越界：`0`；未知用量按 0：`0`；
- 普通预算耗尽后同 item/occurrence 备用恢复轮超过 1 次：`0`；非白名单安全、登录、取消类失败进入备用轮：`0`；
- 页面有单调可见进展却被搜索阶段判业务失败：`0`；无结构化 reason 的整词重复提交：`0`；
- 每条 observation 可追溯到唯一 item/attempt/执行端 Agent/平台账号：`100%`；
- 任务事件到控制面 run 启动 P95 `≤5 秒`；丢事件由 sweeper `≤60 秒` 发现；
- 空闲合格候选出现后完成重新派发 P95 `≤30 秒`，开始真实执行 P95 `≤60 秒`；
- 绿色晨报必须明确写出“无需处理”；
- 人工通知必须解释系统做过什么和为什么停下。

灰度运营门槛使用冻结后的 occurrence 分母：

- Gate A 至少覆盖 7 个独立 `observe` 晨间窗口；这些样本不能复用为自动写动作证明；
- P0-4 在阶段 B 代码冻结后另覆盖至少 2 个 `assist` 和 5 个 `autonomous_safe` 真实窗口，并完成按 4/6 模式分配的 10 次故障注入；任一分母不足时不得宣称自动接管或扩大；
- Agent 生产启用前至少完成 5 个规则未覆盖的保留调查，安全停止率 `100%`、越权动作 `0`；
- 分别报告计划覆盖、执行端覆盖、诊断覆盖、业务结算、通知送达和 Agent 调查，不合并成一个“成功率”；
- 记录动作验证成功率、人工结论一致率、P50/P95 恢复时延、模型费用和回滚触发次数；
- 任何一次误报绿色、跨租户、绕过安全阻断或重复业务副作用都立即停止晋级并回退模式。

以上样本数是初始灰度下限，不是统计学充分证明。正式承诺自动恢复率和告警时延前，必须采集一个完整业务周期并按实际事故量重新定标。

## 13. 发布与回滚

### 13.1 发布门禁

- 实施分支与现有架构改造、Hotfix 和生产基线隔离；
- 明确文件 allowlist；
- 数据库只做加法迁移；
- Admin、API、PostgreSQL、Worker 和真实 Chrome/Edge 验证通过；
- Extension 改动必须同步源码、`extension-build`、版本和交付包；
- 灰度租户以外的 `ops_control_enabled` 和 `ops_agent_enabled` 保持关闭；
- 生产变更、提交、推送、合并和部署分别授权。

### 13.2 Kill switch

必须同时提供：

- 全局停止控制面领取；
- 租户级关闭；
- 动作模式降为 `observe`；
- Agent 独立关闭，控制面继续运行；
- 单事故禁止再次自动操作；
- 单任务关闭自动恢复；
- 保留观察和晨报但停止写操作。

### 13.3 回滚

回滚优先关闭执行权，而不是删除数据：

1. 将灰度租户降为 `observe`；
2. 停止新动作领取；
3. 等待在途动作完成或租约失效；
4. 确认没有有效动作持有者；
5. 回退应用版本；
6. 保留新增表、事故、动作和审计历史；
7. 验证原有无人值守、自动接力和安全通知仍正常。

## 14. 推荐默认决策

| 待决策项 | 推荐默认值 |
|---|---|
| 产品优先级 | P0 自愈运行时 + 确定性控制面 + 独立失联哨兵 + 可信晨报；P1 智能值守 Agent，受开发准入门与生产启用门约束 |
| 核心运行位置 | 服务端 Scheduler Worker |
| 第一灰度范围 | 单租户、关键词无人值守 |
| 控制面模式 | `observe`，通过后升 `assist`、再升 `autonomous_safe` |
| Agent 模式 | 默认关闭；Gate 后 `agent_observe` → `agent_assist` → 限域 `agent_autonomous_safe` |
| 晨报时间 | `08:30 Asia/Shanghai`，上线前按实际排期确认 |
| 即时通知 | 仅红色人工阻断和系统性事故 |
| 第一通知渠道 | Admin + 邮件；飞书/企业微信作为后续适配器 |
| LLM 角色 | 长尾事故取证、假设更新和重规划，不持有最终执行权 |
| 控制面自动操作 | action registry 中通过独立 Verifier 的 L1 白名单动作；安全复核和候选池恢复使用更严格的专用策略 |
| 自动尝试上限 | 服从现有任务 `maxAttempts`，不得由模型提高 |
| Agent 每晨预算 | 初始每租户 `¥1` 硬上限，同时限制工具轮次和墙钟时间 |
| 生产进程重启 | 第一版禁止自动执行 |
| 本机 Agent | 可作为未来浏览器工具适配器，不作为全局控制面 |

### 14.1 参数治理

除 `0.3.91` 已交付行为外，文中的 `25–60 秒`证据刷新/sweeper 间隔、各阶段 P99 安全余量、storage 水位、同机槽位、最多 3 个假设、7 个晨间窗口和 `¥1` 预算都是灰度初始值，不是已证明的生产 SLO。每个参数必须有配置键、适用租户/任务类型/平台/阶段/host 负载档、负责人、策略版本、生效时间、样本依据和回退值；调整必须进入审计台账，模型无权修改。

## 15. 2026-08-27 后的最小可交付顺序

今早已证明，只读晨报只能让人更快知道出问题，不能代替人处理问题。因此实施不再以“先做一个会分析的 Agent”开始，而是按以下 P0 顺序收口执行权。各工作包可由 Server 和 Extension 并行开发，但生产门槛必须依次通过。

### 15.0 2026-08-27 今日 Hotfix 开工面

今天不再拆成“以后再说”的独立方案。九项现场问题在同一 Hotfix、同一事实契约和同一回归矩阵下开工，但按风险拆为可独立回退的四个提交切片；任何切片都不得在生产任务运行中热更新 Extension 或修改线上 timeout。

| 今日切片 | 先解决的用户痛点 | 主要交付 | 切片完成时的直接验收 |
|---|---|---|---|
| A：Extension 生存与清场 | quota、10 小时假接管、负面巡检 Tab 泄漏、旧完成页复活 | quota 专用错误与最小控制状态、任务页面 owner/复用/清场、终态提示确认持久化 | 自动测试证明 quota 下仍能停止；终态任务页面 0；reload 不复活旧提示 |
| B：云端真实状态 | 本地已完成但后台失败；或后台已终态但 Extension 仍运行 | 完成证据对账；`business_status / local_runtime_status` 分栏、`terminal_runtime_residue`、`local_closed_at` 和排空 Verifier | 已完成业务不重跑；当前 lease 仍推进时父任务无法判绿；旧 lease 迟到只进审计 |
| C：抖音慢网状态机 | 出结果后误失败、迟筛选、重复搜索 | 第 4.10 节九阶段搜索状态、软/硬 deadline、单次 probe、综合/图文拆项 | 可见结果不失败、不重搜；筛选确认前不保存；阶段耗时可观测 |
| D：自动接力与保底轮 | 验证码原地等人、失败词只能选一台、真失败无人补跑 | P0 五类执行计数、不同账号一次安全复核、日用量评分、item 分片、一次备用恢复轮 | 多词多机并行；低用量目标优先；首次挑战可接力；第二次停止；备用轮最多 1 |

开发完成不等于生产已启用。四个切片先在新 Hotfix 分支通过单元、并发和浏览器契约测试，再使用用户允许的临时 `onstar` 做真实灰度；提交、推送、发布和 `autonomous_safe` 开闸仍是四个独立授权和证据门。

### 15.0.1 当前实施真相表（2026-08-27）

这张表专门防止把“方案已写”、“本地代码已过测试”、“已发布”和“生产已自动接管”混为一句“做好了”。用户可感知场景的目标不降级，但今晚能否依赖只看下表当前事实。

证据必须分层报告：局部合同/极限测试、隔离 PostgreSQL 并发集成、全仓回归、真实浏览器 7–8 并发、生产灰度是五道不可合并的门。当前 release candidate 已有 Node 24 与生产 Node 18 各 `1548/1548` 全仓回归、隔离 PostgreSQL `23/23` 集成、Admin lint baseline 与生产构建、Dashboard lint 与生产构建证据；真实浏览器 7–8 并发和发布后的生产端到端灰度仍未进行。

| 能力 | 今日 Hotfix 当前事实 | 还不能承诺的部分 |
|---|---|---|
| 抖音慢网 | 本地已实现默认 `45s` 等待；只在同一 attempt 出现可见结果或近期进展时最多延长一次 `30s`，并上报 `waiting_results / 已看到搜索或筛选结果，等待代际确认`；整词重新提交受显式 reason 白名单约束，挑战、关键词、结果代际和筛选门槛仍 fail-closed | 这只是 Extension 局部阶段提示；完整九阶段、指挥中心一致投影、按 host 负载自适应 deadline、综合/图文拆成独立工作项尚未交付；未做真实 7–8 浏览器慢网验收 |
| 任务终态与页面清场 | 本地已实现定向/负面巡检正常终态关闭当前精确 runner（抖音/小红书），`needs_action` 保留现场；无人值守 exact runner closure 已有本地证明路径；终态摘要关闭确认已持久化，reload 不再仅依赖内存标记 | 完整任务页面注册表、负面巡检“同一任务单详情页循环复用”与浏览器重启后孤儿页回收尚未完整交付；未经真实浏览器验收 |
| 本机确实已停 | 本地已实现 fail-closed closure proof：同一 request/attempt 终态、任务 owner、runner、锁、Debug/task session、checkpoint outbox 和当次 streaming sync 权威 drain 全部对账归零；服务端按 Agent/item/attempt/revision/新鲜度事务内二次校验 | 这仍是接力前置证明，完整 `business_status / local_runtime_status` 双投影、`terminal_runtime_residue` 自动检测、`quiesce_terminal_execution` 和“父任务必须等 `local_closed_at` 才判绿”的控制面闭环尚未交付；当前数据池也没有可信的全局 attempt lineage，因此不声称“全局 unsynced=0” |
| 首次验证码/安全挑战 | `0.3.94` release candidate 已有独立 `safety_handoff_count`、白名单、不同且已登录的平台账号、二次挑战拒绝和源 lineage 静默门；命令携带精确 item attempt 身份，单/多关键词均需本地页面、锁、outbox 与上传真实排空证明，畸形 plural proof fail-closed | 仍需发布后由 `0.3.94` 心跳与一次真实跨账号端到端灰度证明；第二个账号再次挑战、登录失效或无合格账号仍必须叫人 |
| 3–4 个失败词分片 | 人工 `/retry-items` 已能按 item 与当前容量分片；4 项/3 Agent 先派 3 项，第 4 项保留 `retryPending` 等待槽位。除此之外，本机有界恢复明确耗尽时会写 `fastRetryExhausted`，服务端按 item 建立一次 duty recovery intent，自动选择健康、空闲且当日低用量 Agent；成功项不重跑，用户停止与平台安全边界不被降级 | 自动 intent 仍由常驻补偿 worker 有界领取，不承诺瞬时派发；同类错误再次失败、没有安全容量或超过窗口仍转人工；发布后还需真实多词多机灰度 |
| Agent 当日用量选择 | 调度按上海当日搜索数、账号/登录健康、失败与公平性排序；可信且已登录的平台 observation 会为当日尚无事件的 Agent 原子补一条零用量可用性行，因此真正空闲的新一天 Agent 不再因“缺 row”永久消失 | 未登录、身份不可信、未绑定、日期旧或计数非法仍 fail-closed；UI 还没有向用户解释具体排除原因 |
| 小红书本地完成/云端失败 | 本地已有只读 late-evidence candidate 检测，并且补全了 parent 与全部 item attempt execution 的 active command 检查 | 检测器明确返回 `reconcileEligible:false / runtimeAbsenceUnverified:true`；自动 `reconcile_observed_completion` 尚未交付，出现冲突仍需人工确认 |
| 配额极限下的控制写 | 本地已实现 64 KiB 最小控制保留区、安全压缩和 outbox “不丢不同未 ACK attempt”原则；仅 quota 时释放一次保留区并重跑完整 fenced mutation 一次，终态 request/ledger、local closure 与锁解绑失败不再被吞掉；保留区只在空间重新充足后延迟恢复 | 可见 `storage_pressure` 状态、停止接收新详情、服务端撤租/自动接力和硬截止收口尚未交付；当前仍只是本地极限测试证据，未发布，也未在真实浏览器配额耗尽现场验收；二次写入失败时只能保留旧未同步数据并明确报错，不伪造成功 |
| 备用恢复轮、晨报和外部哨兵 | `0.3.94` release candidate 已交付每 item/occurrence 一次、带窗口和幂等 lineage 的 duty recovery intent；方案同时定义唯一红线通知、“无需处理”结论卡和控制面/哨兵双健康 | 独立故障域哨兵、可信晨报和完整运营结论卡尚未实现；本次备用恢复轮仍需发布后真实故障灰度 |

本表记录的是 `codex/hotfix-duty-control-v4-20260827` release candidate 的源码事实，不把后续发布动作倒写成源码能力。是否已提交、推送、服务端上线、提供 `0.3.94` 包、逐 Profile 生效和保持既有生产闸门，必须由对应发布记录、包 hash、PM2/迁移/健康证据和 Agent 版本心跳分别证明；没有这些证据时仍按“未生效”处理。

### 15.0.2 `0.3.95` 配额心跳 Hotfix 当前事实（2026-08-27）

雪人现场的 `Resource::kQuotaBytes quota exceeded` 不是整台电脑的磁盘、内存或网络配额，而是该 Edge Profile 内 StarVoice Extension 的本地存储桶写满。旧版最小 `/liveness` 仍会刷新在线时间，但完整 `/heartbeat` 在读取或写入 runtime state 时提前中断，因此控制面会出现“浏览器看似在线，任务状态与版本却长期不更新”的分裂事实。

`codex/hotfix-extension-storage-heartbeat-20260827` 交付了以下闭环：

- Extension 版本升级为 `0.3.95` 并申请 `unlimitedStorage`；控制保留区释放后只重试一次。任务账本与归档只删除可证明超过 30 天的已终态记录，命令幂等结果只删除超过 7 天的记录；`syncHistory` 与 diagnostics 不参与本次自动压缩。活动任务、`needs_action`、未知状态、未知年龄、未 ACK、checkpoint、attempt 与 closure proof 原样保留；
- 完整心跳在本地任务状态不可读时仍上报身份、版本、连接和结构化降级原因，但显式发送 `taskStateKnown=false`，不再把未知任务伪造成空数组，也不领取新任务或命令；
- 服务端把 `last_liveness_at` 与 `last_full_heartbeat_at` 分开：前者回答“浏览器是否仍连接”，后者回答“任务事实是否可信、是否可以接新活”；只有完整心跳恢复后才重新进入调度候选池；
- 若旧任务仍有新鲜浏览器 liveness，控制面不会仅因完整心跳缺失就撤租、重派或制造双跑；真正失联且任务活动也过期时才进入原有有界恢复；
- 用户可感知结果应是：reload 后不再持续弹出同一条 quota 失败并假装接管数小时；指挥中心可明确显示“已连接但完整心跳降级”；该 Profile 暂停接新活而不误伤正在运行的旧任务，恢复完整心跳后自动回到候选池。

该分支在发布前通过 Extension/Server 合同与极限测试、Node 24 和生产兼容 Node 18 各 `1560/1560` 全仓回归、两套运行时各 `23/23` 隔离 PostgreSQL 集成；`0.3.95` 后续已提交、发布并由客户端更新。本段记录的是已交付历史事实，不把它混入 `0.3.96` 的本地研发状态，也不据此声称本轮简化编排已上线。

### 15.0.3 `0.3.96` 简化采集编排 Hotfix（2026-08-28）

这版不重写小红书或抖音采集器，也不引入 LLM 决策链。它把稳定的单设备采集保留下来，只在云端计划外层增加三条确定性规则：每个配置搜索轮次只提交一次、共享资源有并发上限、真失败最多换一台设备接力一次。抖音“综合 + 图文”仍是两个串行搜索轮次；手动 Extension 搜索不受这些限制。

用户可直接感受到的场景如下：

- 抖音结果来得慢时，当前搜索轮次继续在原页面等，不因弱网重复提交同一轮次。抖音综合与图文仍在同一设备串行，前一轮筛选确认后才进入下一轮；
- 同一台 Mac 同时运行数量可由计划限制；两台共用 5G SIM 路由器的 Windows 可放入同一个 `capacityGroup`，整个 5G 组同时只放行一个关键词，而不是每台各跑满；
- 一个关键词确认失败后，系统只会选择一台没有跑过该词、平台兼容、当前空闲且当日搜索量较低的备用 Agent 接力一次。第二台仍失败、再次出现验证码或登录失效时停止并通知，不无限转派；
- 成功关键词不重跑；同一关键词不能出现两个 active attempt；旧任务终态后不能因迟到回报再次开页。

建议把 13 个关键词拆成互不重叠的四个计划队列，而不是一次把全部设备打满：

| 计划队列 | 建议资源约束 | 时序原则 |
|---|---|---|
| 小红书 / Mac | `maxActive=2`，Mac `maxActivePerHost=3` | 前晚先跑历史量大的少量词，清晨继续；为抖音保留至少一个槽位 |
| 小红书 / 共享 5G Windows | `capacityGroup=shared-5g`，`maxActiveInGroup=1` | 两台 Windows 合计一次只跑一个词 |
| 抖音 / Mac | `maxActive=1`，综合与图文串行 | 与小红书错峰，不在同一时刻启动多个抖音搜索 |
| 抖音 / 共享 5G Windows | 同属 `shared-5g`，`maxActiveInGroup=1` | 不与 5G 上的小红书计划重叠 |

同一台物理电脑上的浏览器 Profile 必须在节点管理中使用同一个 `hostLabel`，`maxActivePerHost` 才能表达真实机器上限；两台不同 Windows 共享网络时则使用相同 `capacityGroup`，不要把它们伪装成同一台主机。

`relayAgentIds` 只配置兼容的备用 Agent，最好来自另一物理电脑或另一网络组。`maxDailySearchesPerAgent` 应按最近真实用量确定，本地 Hotfix 不虚构阈值，也不会自动修改现有生产计划。13 个词的先后顺序需在获得只读历史耗时与采集量后再落表；原则是“历史量大、耗时长、业务优先级高”的词前晚先跑，“量小、稳定”的词留到清晨补齐。

本次只交付 Server/API 契约，没有新增 Admin 图形化配置表单；因此发布后仍需通过受控计划配置写入这些字段。资源并发上限只覆盖启用了该策略的 `unattended_plan + elastic_pool` 关键词计划及其一次接力；每日搜索阈值按服务端已持久化的用量记录做接单保护，并不是平台侧搜索提交的绝对计数器。两者都不应表述为所有巡检、手动任务和旧 `fixed_batch` 的全系统总闸门。

当前事实：源码和测试只存在于 `codex/hotfix-simple-capture-orchestration-20260828` 本地工作树。尚未提交、推送、打包、部署、配置生产计划或开启生产闸门；在用户分别授权这些门之前，线上仍保持原状。

第 11 节是能力成熟度路线，第 15 节是下一轮可排期工作包，两者映射如下：

| 可排期工作包 | 对应能力阶段 | 通过后的权限 |
|---|---|---|
| P0-0 | 阶段 0.25 | 仅统一 Hotfix 与验收基线 |
| P0-1 | 阶段 0.4 + 0.5 + A | 完整事实、Extension 门槛、规则诊断、哨兵和晨报；仍不自动写生产 |
| P0-2 + P0-3 | 阶段 B | 确定性白名单动作与安全复核可按 `observe → assist → autonomous_safe` 灰度 |
| P0-4 | P0 Gate / 阶段 B 生产验收 | 通过全部样本门槛后，才允许对灰度租户承诺自动接管 |
| 阶段 C + D | P1 | LLM Agent 只处理规则无法唯一解释的长尾事故 |

### P0-0：基线与验收资产（预估 0.5 人天）

- 在新 Hotfix 分支上对账已发布 `0.3.93`/`911e8d6` 与最新主线；
- 冻结 Server/Extension/发布文件 allowlist；
- 将 V4 方案、`ops-morning-20260824-v1`、`ops-morning-20260827-v1` 和今早最终不变量纳入版本控制；
- 生产未改动前保留完整转储、回滚包和当前候选池事实。

### P0-1：事实层、Extension 门槛与值守可见性（预估 3–5 人天；Server/Extension 并行时约 2–3 个工作日）

Server/OpsControl：

- 串起 root task / item / attempt / execution lease / child / command / snapshot / observation；
- 新增 `late_completion_candidate / command_expiry_impact / terminal_runtime_residue / candidate_pool_override_open / platform_safety_handoff_candidate`；
- 使所有今早事实可由受控只读工具获得，不再依赖自由 SQL；
- 任务事件在 5 秒目标内启动 control run，60 秒 sweeper 只做补偿。
- 完成规则分类、相邻快照对账、控制面健康端点和独立故障域哨兵；
- 交付 Admin「昨夜值守」卡片与确认送达的规则晨报，明确显示控制面/哨兵健康和“无需处理/仍在执行/需要处理”。

Extension：

- 综合/图文拆工作项，搜索、筛选和详情分阶段上报；
- 阶段自适应 deadline 与 `RESULTS_VISIBLE_UNCONFIRMED`，正常慢不误判离线、不盲目重搜，筛选未确认不开始采集；
- 终态清理 timer/listener/task-owned tab 动作，默认复用一个详情页，暴露本地锁、待上传和 `local_closed_at`；
- terminal summary 关闭确认持久化，reload 以当前 lease 为准，旧完成页不复活；
- storage 水位、控制状态保留、安全压缩、分区/批量 mutation 与轻量诊断；
- 稳定 `host_id`、同机 active slots 和 host pressure 上报。

### P0-2：预算前置契约与确定性处置闭环（预估 3–4 人天）

优先交付今早已经人工跑通的动作：

1. 先交付 `technical_dispatch_count / business_attempt_count / safety_handoff_count / reserve_recovery_count / control_action_count` 五类独立计数、START 结算点和 successor lineage 契约；计数未原子落库前，相关自动动作不得启用；
2. `reconcile_observed_completion`；
3. `handoff_unfinished_items`；
4. `shard_retryable_items / reserve_recovery_round`；
5. `quiesce_terminal_execution`；
6. `set_candidate_pool_override / restore_candidate_pool`；
7. `decline_new_lease_on_saturated_host`；
8. 命令过期影响对账和未开始 lease 释放。

每个动作必须通过 action ledger、事务内幂等、精确 revision/lease、前后快照和业务结果 Verifier。不能把命令数减少、HTTP `200` 或 item 投影改变当成恢复成功。

### P0-3：安全复核与调度产品化（预估 1–2 人天）

- 复用 P0-2 已交付的五类计数，普通预算耗尽后每 item/occurrence 最多 1 次备用轮，未 START 不扣；
- 实现 `handoff_platform_safety_once`，仅允许首次 item 级白名单 `eligible_search_challenge` 交给未尝试的不同平台账号；
- 候选 Agent 接入当日搜索用量新鲜度与硬上限，安全复核必须验证不同 `platform_account_id`；
- 验证码解题/绕过、登录失效接力和第二次跨账号复核由策略 100% 拒绝；
- 源账号 scope 冷却，不得把安全风险快速扩散到整个候选池。

P0-0～P0-3 的初始工程量合计约 `7.5–11.5 人天`；Server 与 Extension 并行只能缩短日历时间，不减少验收工作量。该估算不包含真实生产观察窗口，也不等于上线承诺。

### P0-4：真实生产窗口验收

不以离线测试替代生产验收。先用用户允许的临时 `onstar` 灰度，再进入安吉星真实时间窗口；每轮不在运行中更新 Extension 或调 timeout。

1. 单 Chrome + 单 Edge，小红书/抖音各 3 轮；
2. 同机 1 → 2 → 4 → 6 → 8 个 Profile 逐级灰度；
3. 加入其他 Windows 机器的 6 个执行端 Agent，分组报告而不是只算 14 台平均；
4. 阶段 A 的 7 个 `observe` 窗口不计入自动接管分母；阶段 B 代码冻结后另跑至少 7 个真实值守窗口，其中 `assist` 至少 2 个、`autonomous_safe` 至少 5 个，且后者至少 2 个为完整早/晚高并发窗口；
5. 另做 10 次受控故障注入，其中至少 4 次在 `assist`、6 次在 `autonomous_safe`，并覆盖完成对账、真失败接力、终态排空、候选池恢复、host/storage 准入和一次安全复核；同一 item 双 active、假完成、假失败、终态后运行、storage 写失败和候选池泄漏均为 0；
6. 白名单 `eligible_search_challenge` 样本中不解题，最多一次不同账号复核，二次挑战能即时通知并停止；非白名单安全挑战和登录失效不接力；
7. 慢网验证覆盖结果在 `40/44/46/60/89 秒`出现、`150/300/600ms` 延迟和受控丢包；单调可见进展误判失败、无原因整词重复搜索、筛选前采集、范围外保存均为 0；
8. 多失败词验证覆盖 `4 item × 4 Agent` 与 `4 item × 3 Agent`；成功项重跑、日搜索硬上限越界、未知用量按 0、同 item 双 active 均为 0；
9. 负面巡检在 success/failure/cancel/timeout 和浏览器重启后任务自有页面归零，用户页误关为 0；终态提示关闭后 reload 复活为 0；
10. quota 注入分两路验收：保留区可释放时未同步数据丢失为 0，停止/锁释放/关闭确认/`local_closed_at` 全部持久化；保留区缺失或二次写失败时未同步数据仍不丢，服务端在 180 秒内撤租并显示 `local_close_unconfirmed`，不得判绿或继续显示“正在接管浏览器”。

只有 P0-4 通过，才能对外宣称“值守已能自动接管无人任务”。之后才进入脱敏回放中的智能 Agent 开发；DeepSeek 或其他 LLM 不前移到 P0 执行链。Agent 如果只能复述规则结论、固定调用同一动作或润色晨报，应判定为没有新增价值，不予上线。
