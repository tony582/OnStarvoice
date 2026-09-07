# L3-B 第三批：本地停止与恢复交接

日期：2026-09-07。状态：**本批 32 文件候选已冻结，接续授权进入提交、普通推送、新建 stacked Draft 与精确 CI。专用 PostgreSQL 实测 Node 18/24 各 27/27，之后官方离线回归各 3,590/3,590；合成数据及连接清理完成，临时实例已停止，运行源码未改。提交/PR/CI 结果以本次 Draft 的精确交付记录为准；不关闭 B/L3，不 Ready、不合并、不发布、不操作既有/生产数据库、不新采集。**

## 基线与固定范围

- 从 `d4c716f41afceecbe97031ca2db490f82bb7d6bf` 新建 `codex/extension-l3b-local-recovery-20260907`，工作树 `OnStarvoice-extension-l3b-local-recovery-20260907`。
- 父 [PR #61](https://github.com/tony582/OnStarvoice/pull/61) 已核验 `OPEN + Draft + CLEAN`，精确两组 CI 12/12。父分支、原脏工作区、main 和客户系统不动。
- 本批承接原第三批，不增加阶段。前置审计纠正了来源交集：#61 停止只覆盖原云任务，纯本地恢复需要另有正向来源证明和独立权限；不能把云任务删字段后重新分类。
- 初始授权仅本地实现、离线验证及计划同步；本轮另获新建本机临时测试库与合成数据专项验证授权，结果见最后一节。提交/推送/Draft、真实浏览器与发布仍各有独立门；不处理云 resume/adoption 协议或 PR #29。

## 一次完整交付合同

只接受可信本地计划入口新产生、证据完整、非云托管/非编排的原始无人值守任务。普通手动采集、旧云保存的本地执行计划、旧无来源见证历史、编排和未知谱系不自动取得新权限。原始本地任务可停止并交接到一个新 request/Attempt；第二代仍可准确停止，本批不自动开放再一代恢复。

1. 独立只读本地权限：分别核验计划准入、执行准入、停止、恢复；服务端仅证明当前授权/绑定，不把客户端 source 回显当服务端原始来源证明。
2. 独立本地计划/请求见证：原计划保存、原始 request 构造与账本投影共同产生。普通作者/云计划 writer 清除计划见证，不能继承同字段的本地权限；已入场任务保留自己的独立来源证明。12 个内部纯日程/运行投影调用使用私有对象身份，在最终 Q 内比较当前计划、候选计划与原证明的语义身份及指纹后才保留；未知/不匹配不写入，避免延期后无声降级旧路径。renderer JSON 不能取得私有身份。
3. 复用准确停止的真实 owner/页面/子活动排空；固定当前 worker、完整停止回执、原 owner/锁和 source 的最终比较。没有停止证明或未知资源时不启动。
4. `prepared → 未激活 shell → runner_bound → activated → claimed`：同一 document、同一 connection、一个后台签发代次；两个 bootstrap 同时受控，最终一次领取后才进入原 producer，不另建采集引擎。
5. 后继只在最终原子本地写入中发布，旧来源、完整退休停止证明及未同步数据保留。资源保留与执行权交接分开，不按可回收 tabId 强关用户页，不删除围栏作回滚。

本批新增控制逻辑归入 `utils/control/` 与 `utils/capture/lifecycle/local-recovery.js`；大文件只接入口及复用原计划/request/checkpoint/ledger 的纯构造器。新旧采集算法、平台等待、重试、并发和 UIUX 保持原规则。新可点击任务中心入口留给 C/U5，不借 legacy UI 消息伪装严格授权。

## 实际职责与失败语义

| 职责 | 实际落点 | 明确不承担什么 |
| --- | --- | --- |
| 当前本地授权/绑定 | `server/services/capture-local-control-authority.js`、独立路由及 `utils/control/local-capture-authority.js` | 不领云命令、不续心跳、不写数据库；source 回显不证明来源 |
| 本地原始来源见证 | `utils/control/local-capture-source.js` + 受控计划保存/原请求构造 | 不把旧历史或移除 cloud 字段的任务洗成本地来源 |
| 排空与停止证明 | 复用 `strict-control.js` 的真实 owner/子活动/页面链及私有内存见证 | 不凭 completed、tab 不见或后台重启重建停止证明 |
| 后继发布与代次交接 | `local-recovery.js` + `stop-journal.js` 独立本地最终事务 | 不另写平台采集引擎、不重新发送业务数据、不删除旧围栏 |
| 未激活运行页 | `sidebar/recovery-runner-gate.js`、两个 bootstrap、原 owner/producer | URL 只定位意图；未精确确认领取前不执行旧初始化/采集 |
| 旧宿主连接 | `background.js` 装配/消息/连接/原计划与 request/checkpoint/ledger 构造器 | 原后台主干整体迁出仍属于 L5，不以本批新增接线称其已经拆完 |

提交与执行权分开处理：`accepted:false` / `successorAllowed:false` 表示此次响应**没有授予执行权**，不表示先前写入已经回滚。已尝试持久写入后出错，会返回 `effectReceipt`，区分最后尝试阶段、同一意图的当前观察、未知结果、已确认/未知运行页，以及 `reconciliationPending:true`、`automaticRetryAllowed:false`、`resourcesReleased:false`。观察读取失败或看到不同/腐坏意图时保持 unknown，不补写、不自动重试、不按 tabId 清理。领取已落盘但回执丢失时，新页保持不执行，第二次消息不能重新领取。

原始任务准入复用真实纯构造器与账本投影，由独立本地 Auth→Q writer 保存；第二代领取使用 Auth→执行锁→Q 单次最终事务。网络授权和创建运行页都在最终锁外。停止记录、完整旧代证明、历史请求、未同步结果和待上传 outbox 保留；执行权移交不等于旧页物理资源已回收。

## 验收和当前进展

- 独立权限 service/client 四类动作已通过离线测试；本批真实 PostgreSQL / Router / SQL 实测现也通过，两 Node 各 27/27，不借用父批数据库证据。
- 实际本地计划 → 原始 request/账本 → 严格停止 → 准备/文档绑定/激活/一次 claim 已组合通过；真实后台消息/连接及懒初始化另有 29 项接线测试，不能用直调模块冒充后台接线。
- 双 bootstrap 与实际 owner/原无人值守 producer 已接线，在第一个平台操作前准确阻断。两平台三种恢复模式均通过来源、计划/账本、新代领取及再次准确停止；空恢复来源不创建运行页。
- 独立审阅发现的停止回执/worker 漂移、授权/首次读取期间连接替换、早握手继承、launch 最终比较、内部日程降级、持久写入/创建后回执丢失已修复并有精确失败回归；原历史测试/哈希未删除或刷新。

### 最终本地门

| 检查 | 结果 |
| --- | --- |
| 官方 Node 18.20.8 完整回归 | 3,590/3,590，fail/skip/todo 均 0 |
| 官方 Node 24.12.0 完整回归 | 3,590/3,590，fail/skip/todo 均 0 |
| 本地服务权限 / 客户端权限 / 来源见证 | 两 Node 分别 90 / 110 / 118 项；均纳入上述全量，不另加成“总通过数” |
| 整链 / gate / 后台接线 / 连接竞态 / 副作用回执 / 双平台三模式 / 日程来源 | 两 Node 分别 43 / 31 / 29 / 10 / 14 / 12 / 30 项，均纳入全量 |
| 旧 Sidebar / 旧命令历史组合 | 最终重跑三组 controller / 旧命令测试，全部精确 Git 基点验证两 Node 各 111/111；旧基线哈希保留 |
| 源码卫生与隔离快照 | 27 个变化的 JS/MJS 语法通过，`git diff --check` 通过；177 文件隔离源码快照验证，不是安装/客户包发布 |
| 独立审阅 | 真实复现缺陷已回归闭合；本批 PG 另经脚本/测试/实测日志审核，结果见最后一节；实机和新 UI 入口不记为通过 |

最初开发中的全量运行曾为 3,441 项、15 失败：10 项暴露构造器迁出后的局部变量遗漏，1 项缺本工作树隔离快照，1 项正在形成的新历史逆向差异，3 项普通宿主测试尚未接真实 gate。代码/本地测试准备分别纠正后，最终双 Node 3,590 项均重新通过，不隐藏首次失败。

首次本地冻结范围共 31 文件：14 运行源码、14 测试/夹具/测试辅助、3 计划文档。本轮增加 1 个独立 PG 集成测试后为 **32 文件（12 已有修改、20 新文件）**。14 运行源码按路径排序、依次串入 `path + NUL + bytes` 的 SHA-256 仍为 `b0b6dba623d352aa9d243b220de05a013d43ee9305037bf241bcf85aff707471`。HEAD 仍是父 `d4c716f`，不把父 SHA 写成新候选提交。manifest、版本/权限、runtime-config、依赖锁、迁移文件与客户安装目录无变更。

## 完成门与剩余顺序

关键异步边界覆盖换权限/来源/连接、错误 document/generation、后台重启、存储配额/回执丢失、重复 claim 和迟到旧消息。测试不连接真实鉴权/平台/客户 API，不执行新采集。所有历史测试与哈希保留，只增加逐条精确逆向差异证明，不刷新基线。

组合测试使用真实控制模块、后台消息/连接路由、懒初始化、共享构造器与投影、同文档 gate 和原 producer。原始 claim/running 预约、浏览器与网络、执行器空闲准入仍是明确的内存模拟接缝；在第一个平台操作前停止，不将其描述为实机或客户采集通过。本批只读接口的真实 PostgreSQL 实测已单列完成；后续实机/长期观察及新 UI 可见入口尚无本批验收证据。

本批功能冻结，不追加优化。**本批 PG 门已过，不再作为待办重复执行；提交/普通推送/新 Draft/精确 CI 已获接续授权，见最后一节。** 原顺序仍为第三批候选收口 → C/U5 → L4 → L5 → L6，不增加阶段。服务端 #37/G3 与 P8/G8 保留独立收尾；本批通过也不等于 UIUX、MediaClaw 独立性或整套架构已完成。

## 2026-09-07 接续授权：本机独立 PostgreSQL 专项验证

用户授权新建本机临时测试库，用合成数据验证新增只读权限接口，不连接生产。该授权不包含提交、推送、Draft、部署、真实采集或修改已冻结运行源码。

本次使用全新、仅监听 `127.0.0.1:55441` 的 PostgreSQL **17.9** 实例、角色 `onstarvoice_test`、库 `onstarvoice_test_local_control_20260907`，不是本机已有服务。最终数据目录 `/private/tmp/onstarvoice-local-control-pg.3G1er4/data`；先核验实际数据目录、地址、端口、用户、无既有用户库和 public 空表，再以 **71 个未修改的既有 schema 文件**初始化测试表并校验 checksum。环境不继承业务连接串，`DOTENV_CONFIG_PATH=/dev/null`。只运行新增 `tests/integration/postgres/capture-local-control-authority.integration.mjs`；未执行完整 PG runner 中的 split 或其他演练。

专项测试经真实 Router / service / SQL，四类动作分别核验当前绑定与权限。随机合法 source 的回显不作为服务端来源证明，真实 Extension 来源验证器继续拒绝无 witness 的记录；真实权限客户端拒绝其他租户、换绑或换 token 后的旧 binding fence。

| 本批实测 | Node 24.12.0 | Node 18.20.8 |
| --- | --- | --- |
| 集成测试 | 27/27（26 个子用例 + 父用例），0 fail/skip/cancel | 27/27，0 fail/skip/cancel |
| 真实本机 HTTP 请求 | 65 次 | 65 次 |
| 生产权限 SELECT | 51 次，逐条原样 SQL；每次确认 `transaction_read_only=on` | 51 次，同样规则 |
| 每请求身份/业务数据比较 | 两组合成身份全行及 task/Attempt/snapshot/command/intent/wakeup 前后不变 | 同左 |
| 测试结束后的外部清理核对 | 合成 tenant、task、Attempt、snapshot、command、token、agent、binding、auth_code 及其他连接均 0 | 同左 |

已覆盖 active/paused/revoked/frozen/expired、到期窗口上限、空与限定平台、字段归一、换 token/绑定与跨租户/code 错配。两真实连接证明：未提交撤销不会被脏读；撤销提交后下一请求立即重新查询并拒绝。不宣称已签发 grant 会锁住随后权限变化，也不将本机 PG17.9 结果推广为生产性能或其他版本验收。

首次日志 `/tmp/local-control-pg-20260907-run1.log` 保留失败：测试将 `inet_server_addr()::text` 的标准 `/32` 表示漏出本机白名单，停在 seed 前。仅修新增测试，复用既有 `isAllowedPostgresIntegrationServerAddress`；该安全工具及运行代码均未改。首次实例 `/private/tmp/onstarvoice-local-control-pg.dgSimo/data` 也已清理连接并受控停止。没有放宽至外部数据库。

最终通过日志 `/tmp/local-control-pg-20260907-run2.log`。脚本 `output/architecture/run-local-control-pg-20260907.mjs` 为 ignored 本机复现辅助：每次新建 cluster，正常成功/失败都停止自己的精确实例并验证端口释放。最终两 Node 测试后合成数据和连接均归零；实例已停止，55441 已释放。临时数据库文件与日志保留，没有删除用户业务数据或声称整个目录已删除。

新增集成测试 SHA-256：`290dfdbd885c5685766ef2da0917fde06a7761a27c504eb29750debe4d501f21`。独立审阅已核对准备脚本、完整测试、首次失败修正和最终日志。补测后再次运行官方 Node 18/24 离线回归，均 **3,590/3,590**（0 fail/skip/cancel），日志 `/tmp/local-control-post-pg-node18-20260907.log` 与 `/tmp/local-control-post-pg-node24-20260907.log`。PG 的 27 项单列，不并入离线 3,590 项，也不声称完整 PG runner 通过。

本轮仅增加本批 PG 测试并同步三份计划，14 个运行源码指纹保持冻结。未暂存、提交、推送、新建 PR、Ready、合并、部署、迁移既有/生产数据库、实际 split、客户 Extension 更新或新采集。下一步仅等待独立送审授权，不反复重做此 PG 门，不扩大当前候选。

## 2026-09-07 接续授权：冻结候选送审

上述“未提交/待授权”保留 PG 验证结束时的历史快照。用户在明确的送审请求后继续授权，本次仅提交已冻结的 32 文件候选、普通推送 `codex/extension-l3b-local-recovery-20260907`，以 #61 的 `codex/extension-l3b-active-stop-20260906` 为 base 创建新 Draft 并等待精确 head 的 push/PR CI。父 head `d4c716f41afceecbe97031ca2db490f82bb7d6bf`、父 Draft 状态及两组 CI 已重新核验。

不重开实现、不重跑已通过的本地/PG 门；只同步三份计划的送审元数据。CI 任一失败即停止并报告，不自动重试或修改。最终 SHA、PR 链接及 CI 结果记入本次 PR 描述及交付记录，不为回填自身 SHA 再产生文档提交和额外 CI 循环。保持 Draft，不操作父分支、main、其他 PR、生产、迁移、split 或客户 Extension，不新采集。下一实质工作仍为 C/U5，须按原计划独立推进。
