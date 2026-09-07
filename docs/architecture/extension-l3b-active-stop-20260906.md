# L3-B 准确停止：隔离实施与本地验证

创建日期：2026-09-06；更新：2026-09-07。状态：**第二批“准确停止”的本地候选已完成，Node 18/24 完整离线回归各 3,102/3,102，独立代码审阅通过；本机专用 PostgreSQL 验证现也已通过（两版各 1/1，详见第 9 节）。用户现已授权提交、普通推送、新 Draft 并等待精确 CI（第 10 节）；候选功能冻结。仍不关闭 B/L3，不启用客户插件；本地恢复属第三批，不新增架构阶段。**

## 1. 基点与本轮实际动作

- 精确基点：`3c19c5ea14c9ac1f68a21da8b8caf30353b459d1`，父 [Draft PR #60](https://github.com/tony582/OnStarvoice/pull/60)。本轮重新核验为 OPEN / Draft / CLEAN，base `c1dd2a885225adb0a910fabd067041ce994b7b3d`。
- 父提交 [push 6/6](https://github.com/tony582/OnStarvoice/actions/runs/34036117684) 与 [PR 6/6](https://github.com/tony582/OnStarvoice/actions/runs/34036136098) 是父候选证据，不是当前未提交准确停止候选的 CI。
- 新隔离工作树：`OnStarvoice-extension-l3b-active-stop-20260906`；分支 `codex/extension-l3b-active-stop-20260906`。不修改 #60、其他旧分支或原脏工作区。
- 前一轮只读审计已完成；用户补充授权后，本轮完成后台、原生产者、content/MAIN、停止控制与独立服务端只读接口接线。真实后台消息入口和原生产者正向链已在内存浏览器端口下验证，不能将模拟环境通过宣布为真实浏览器或整个 L3 关闭。
- 2026-09-06 源码验证时未操作数据库；2026-09-07 接续授权后仅准备并使用本次新建测试库（第 9 节）。始终未提交、推送、新建 PR、操作现有/生产数据库、真实浏览器/鉴权、客户 API、新采集或客户包；本地验证不等于已发布。

## 2. 两个必须先明确的范围差异

### 2.1 抖音详情子活动在原白名单之外

| 原始入口（精确基点） | 已核对事实 | 对停止证明的影响 |
| --- | --- | --- |
| `utils/capture/douyin-single-note.js:268`，`requestDouyinApiDetailFromMainWorld` | 派发详情请求事件后轮询缓存；默认 2,200ms 到期就返回 | 外层返回不代表请求结束 |
| `utils/capture/douyin-interceptor.js:170`，`fetchDetailViaApi` | MAIN world 中独立等待 fetch/body；一个 endpoint 失败后继续后续 endpoint | content 顶层 Promise、列表 tracker 和超时都没有覆盖该子活动 |
| 同文件 `:376`，事件监听器 | 输入只有 awemeId/requestedAt，没有本次操作身份、停止或真实结束回执 | 无法归属到精确 Attempt/document/generation，不能用空 tracker 确认静止 |

原接线提案第 6.3 节未包含以上两个运行文件。需要把它们纳入同一准确停止批次，增加内部请求身份、合作式停止及底层 settled 回执；不得靠禁用这条详情路径或永久拒绝来冒充完整正向交付。

保持原 endpoint、selector、正常采集规则、等待与重试次数；停止后不再开启下一请求是停止语义，不是另做平台性能调优。MAIN world 事件不是可信命令授权；后台权限必须独立核验，不把页面自报的身份或回执当作服务端权限。

### 2.2 重启后停止围栏需要独立持久控制记录

原提案第 6.2/6.4 节要求“先落盘停止意图”和 MV3 重启后禁止旧任务复活，但统一计划又要求本阶段不改变持久格式。现有字段不能无歧义兑现二者：

- `background.js:6374` 的 `localClosureStopConfirmation` 是停止后的 legacy 确认，不是停止前的派发禁令；不能沿用同一版本冒充完整物理停止证明。
- `background.js:7883` 的执行锁归一化白名单只保留原 owner/task/Attempt/holderDocument 等字段；随手附加 generation 会被归一化丢弃。
- 当前 owner、页面、runner 及资源记录没有共同持久 generation，也没有可在重启后核验的版本化 stop intent。

建议允许**版本化、可选、独立的插件本地控制记录**，保存精确来源、操作代次、停止阶段与必要分项回执；不覆写业务记录格式，不扩大记录正文，不混用 legacy confirmation。它仍是本地控制存储契约变化，必须明说，不能宣称“持久格式完全未改”。

候选设计须同时列清：写入/读取/清理者，Auth/U/L/A/Q 的短提交顺序，配额失败、reset、迟到 writer、旧版本读取与回滚的行为。旧包不理解新停止记录时，不假称其能维持 strict 围栏；回滚前必须静止并处理仍在途的 strict 代次，不能靠删除控制记录绕过。

此项不需要数据库迁移；不授权修改服务器表结构、云端 resume/adoption 协议或既有 outbox/同步协议。

## 3. 离线复现结果：确认缺口，不是修复通过

诊断文件：本工作树 `output/architecture/active-stop-mainworld-audit.test.mjs`（ignored，本地保留）。可从工作树执行 `node --test output/architecture/active-stop-mainworld-audit.test.mjs`。

直接读取精确 `3c19c5e` 的完整 interceptor 原文及真实 caller/缓存等待函数，在隔离 VM 中运行；storage、DOM 事件、时钟与 fetch 全部为内存样例，无网络或真实浏览器。

Node 24.12.0 / 18.20.8 各 **2/2**，0 skip/fail/cancel，确认：

1. 调用方等到超时返回 null 时，MAIN fetch 仍未结束；随后响应到达，原代码仍写入缓存。
2. 调用方已经超时后，第一个 endpoint 返回失败，原 MAIN 链仍启动第二个乃至第三个 endpoint。

这里的“通过”表示旧缺口被稳定复现，不表示停止修复、全量回归、CI、客户故障归因或生产验收通过。没有从该样例推断今天客户发生了同一问题。

## 4. 补充授权后的一次完整实施范围

目标固定为既定第二批：**精确当前任务的合作式停止闭环**，不是再提交一个全拒绝 helper。原三批顺序不变，第三批本地恢复复用其结果。

原第 6.3 节运行范围保留：

- 后台/content/身份：`background.js`、`content-v2.js`、`utils/capture/execution-identity.js`。
- 页面调用和底层活动：`utils/capture-sync.js`、`utils/scroll.js`、`utils/capture/douyin-keyword-search.js`。
- 资源所有者：`utils/capture/task-runtime.js`、`task-owner.js`、`debug-session.js`、`task-tab-group.js`（后三者同目录）。
- 生命周期：`utils/capture/lifecycle/` 下 coordinator、begin、end、restore、progress、tabs、leases、admission、cleanup、attempts。
- 任务生产者：`sidebar/task-controller/` 下 owner、task-ledger-assist、keyword-strategy、targeted、unattended-run。
- 第一批 control/storage 共同写保护与独立只读 stop 权限适配：复用已明确队列和来源契约；不得放宽 #60 的 terminal action/policy 成为 stop/resume 许可。
- 原拟新增页内登记、后台文档活动、统一页面操作、生命周期停止模块保留；独立版本化控制记录归此控制层所有，不另造平行执行器。

确定补充的两个文件：`utils/capture/douyin-single-note.js`、`utils/capture/douyin-interceptor.js`，以及上节明确的本地控制存储/内部握手契约。需真实 stop 权限的只读服务适配与 terminal policy 分离；本轮仍无真实客户 API 调用或启用许可。

不顺带重写全部平台模块。detail runner 已有可注入 Chrome 端口，prefetch 的 navigate 已由 capture-sync 注入：优先在本批调用点约束，并登记真实 pending Promise，不以其超时后清空的 slot 充当 drain。delivery 现有保存/checkpoint 尾部纳入 owner/runner 排空，不批量改动所有模块。

旧取消、旧 owner 等无严格身份路径不能控制已进入 strict 的代次；入口分流必须早于旧 fallback、debug stop、reload/close 和 list-run 改写。若实现发现其他必需的运行文件或协议超范围，先列具体证据，不能由“完整链”推导无限改动许可。

## 5. 必须整体通过的停止退出门

```text
独立当前 stop 权限 + 准确源
  → 最终 CAS 保存停止意图并冻结该代次新派发
  → owner / runner / content / MAIN 子活动按同一身份停止并排空
  → 已开始的本地保存/checkpoint 收尾，保留未同步与失败上传
  → 逐项确认资源，无法证明归属的用户页保留
  → 最终源 CAS 和分项回执
```

- `sourceStopped`、`runnerQuiesced`、`pendingUploads`、`resourcesReleased`、`successorAllowed`、`retainedTabs`、`manualActionRequired` 分开，不用一个 ok 混写。
- 已确认停止可与资源待处理并存；资源证据不足时不放行依赖它的后继。不强制 native remove/reload/ungroup/detach 来制造成功。
- 匿名/具名活动、直接注入/导航、MAIN fetch、Promise.race 底层工作均有真实登记；所有正向场景必须通过实际原入口，不只测试工厂。
- 排队期间换身份/Attempt、owner 重连、页面导航/BFCache、MV3 重启、迟到进度/保存/marker、部分 ACK、配额和最终写失败必须可复现；失败后不自动启动采集补偿。
- legacy 未进入 strict 的行为保留基点对照；旧测试不减项。严格停止后的迟到结果按原本地保存/幂等规则结算，不丢数据、不覆盖后继。
- Node 18/24 全量及独立锁序审阅保持；真实浏览器、性能与长期验收仍属 L6。数据库测试初始化、提交/推送/Draft、客户验证与发布均单独按许可处理。

## 6. 本地恢复的明确后续，不混入本批成功

现有 `manuallyRecoverUnattendedKeywordRun` 会新建 request/Attempt 并打开平台页/runner；不是纯粹恢复历史展示。严格版本必须：准确停止回执 → 本地来源与独立 recover 权限 → 预留启动意图 → 未激活 runner → document/generation 精确绑定 → 最终激活后才能领取。

当前 claim 已有 Attempt/document/holder 匹配，但开页与事后 bind 之间仍有窗口。不能复用完整云同步补权限，也不能拿 #60 metadata handle 或 U5 历史只读许可放行。仅在隔离测试使用合成 provider/runner，可以证明控制交接而不执行新采集；真实恢复启动继续禁止。云来源缺 adoption/closure 协议不在本轮补造。

L3 未关闭；C/U5、L4、L5、L6、服务端 #37/G3 与 P8/G8 尾项不变。上述必要范围已在同一第二批完成本地候选，并非新增阶段。

## 7. 本轮已实现的候选与限定

本节描述隔离源码，不代表客户功能开启。新路径只接受显式 `strictControlCandidate`，正常业务请求与默认插件流程不自动启用它；任务中心可点击控件与新 UI 的接入仍属于 C/U5。

| 层 | 实际接线 | 未宣称的能力 |
| --- | --- | --- |
| 权限 | 独立 `/api/capture-cloud/agent/stop-authority`，仅 SELECT；两次当前权限核验、短期句柄、精确来源最终 CAS | 不用终态清理、历史可见或 resume 权限替代 stop；不支持编造云 adoption |
| Owner/生产者 | 原无人值守入口先完成原 running 上报，再进入私有依赖作用域；同状态/原算法，实际 producer、异步 progress/checkpoint/outbox flush、原存储写和脚本 Promise 排空 | 不是第二套业务执行器；原生 debugger/group 模式不是该候选的已验收路径 |
| 页面 | 实际 content 入口、匿名活动、精确 document/activation、外部脚本 reserve/settle；导航前旧页永久冻结，新页再握手；两处后台仍存活的搜索观察器纳入被动活动与停止清理 | 页面合作式回执不是抗恶意页面的安全证明；BFCache 换文档不等于旧活动已消失 |
| 抖音详情 | MAIN fetch、body reader、fallback 与 content 外层超时共同记账；停止后不再启动后续 endpoint/迟到写缓存 | 不降低等待、不加并发、不调整采集选择规则 |
| 生命周期 | 旧变更入口实际 Promise 在途计数；接管屏障、旧清理/重绑/恢复拦截、后台重启与凭据变化隔离 | 不按可回收 tabId 强关用户页，不自动放行下一代 |

本批正向候选范围是：独立原始云任务、当前 running/原始 Attempt/原始 create 来源完整、唯一有效预约锁与当前 owner 文档，且旧原生资源与活动确实空闲。native 资源已有占用、编排来源、恢复/adoption 来源或证据不足时拒绝接入，不借本批修改其协议；普通未进入严格路径的业务仍用旧逻辑。

私有采集来源和排序读取绑定该代次已登记页面，不再借用用户正在浏览的 active tab。专用详情工作页的旧默认 `about:blank` 在此候选中使用该代次已验证 HTTPS 来源页启动，再执行精确文档导航；这是一项明确的合作式候选启动差异，不改公共 detail-runner 默认或旧路径。后台也拒绝未登记的用户 tabId。缺失或失败的 observer 清理不能伪装成静止；正常运行仍保留原 90 秒上限，不新增 90 秒等待。

### 本地控制记录与锁顺序

- `onstarvoice.captureStopControl.v1` 是单代次、有界、独立记录。只保存控制身份与分项状态，不保存正文、评论或原始凭据；凭据指纹为 SHA-256，完整比较见证仅在当前后台内存。
- 首次接入只把已存在的精确预约锁绑定到原有 stable taskId/Attempt 字段，与控制记录一次写入；不创建替代锁，不改结果/outbox 格式。
- C 队列仅获取“旧活动为空”的内存屏障，然后退出 C。最终首次提交遵守 **Auth → execution-lock → Q**；其他控制提交 **Auth → Q**。Q 不等待页面、网络或另一个资源队列。
- 新派发与停止意图 CAS 共享短派发门；页面 Promise 只在门中启动，不能在门中等待。已发出的脚本许可仍是计入中的在途操作，不能假称能强制撤销或已经结束。
- 操作/owner 活动只保留未结算项，持久单调水位防止重放；已验证超过 300 个动作、100 个活动不会因历史记录额度耗尽而截断。
- 先落盘才能回 `stop_requested`。页面/owner 回执缺失保持 pending/unknown，不以超时清账；逐项收齐后才给 `sourceStopped`。资源仍保留时明确 `resourcesReleased=false`、`successorAllowed=false`。
- MV3 重启不能继承旧内存权限；凭据/来源变化触发失败保护并冻结旧精确页面。控制记录存在或损坏都阻止旧启动/自动恢复。reset 遇到保留记录直接拒绝，不先删结果再处理围栏。
- 配额或写失败不报告提交成功，不清未同步数据。当前没有自动删除控制代次或恢复下一代的代码；后者必须在第三批完成精确交接后另行启用。旧包不识别新记录，不能直接回滚后继续采集来绕过围栏。

### 验证分层

已添加真实后台消息入口、原生产者/页面模块、服务端只读 Router、锁顺序/并发屏障、丢回执、迟到握手与创建、文档导航、凭据与来源变化的离线验证。历史 54 个生命周期函数、202 个 AST 和 165 个 Sidebar 函数的原始基线保留；本批只有逐字精确逆向差异清单，不刷新历史基线来隐藏变化。

本地源码快照只位于本隔离工作树 `extension-build`，供自动回归核对，未安装/Reload 或打包交付。2026-09-06 的 PostgreSQL 集成样例当时只做语法验证；2026-09-07 已按新授权完成独立库实测，见第 9 节。本批始终不使用既有或生产数据库。完整浏览器行为、客户环境、长时性能与发布仍分别待验，不用离线计数代替。

## 8. 2026-09-06 本地冻结记录（历史，后续实测见第 9 节）

本轮冻结基点仍为 `3c19c5ea14c9ac1f68a21da8b8caf30353b459d1`。工作树共 63 个改动/新增文件，其中 3 份计划、60 个源码/测试文件；没有新提交，因此下列证据只绑定这份未提交候选。

| 检查 | 最终结果 | 证据与限定 |
| --- | --- | --- |
| 官方递归完整回归 / Node 24.12.0 | 3,102/3,102；0 fail/skip/cancel | `node scripts/run-node-regression-tests.mjs`；本机日志 `/tmp/active-stop-verified-full-node24.log` |
| 同一完整回归 / Node 18.20.8 | 3,102/3,102；0 fail/skip/cancel | 同一脚本、同一冻结源码；本机日志 `/tmp/active-stop-verified-full-node18.log` |
| 真实入口与故障链 | 已纳入上述完整回归 | 实际 background 消息/port、原 owner producer、batch/sort/detail runner、最终保存/outbox flush、content/MAIN、搜索观察器、并发接管屏障和锁顺序；浏览器、存储、网络为隔离端口，不执行新采集 |
| 独立最终审阅 | owner/page、content/MAIN、service/lifecycle 范围均无已知本地阻断 | 修复最后发现的详情重建全局端口旁路、尾部未计数 Promise 与脚本返回后仍存活的 Observer；保留待验门，不推导全系统无缺陷 |
| 语法、历史基线、快照 | 58 个 JS/MJS 语法通过；173 文件快照逐字一致；`git diff --check` 通过 | 原历史指纹 fixture 不改；manifest、运行配置和依赖锁未改。快照仅供本隔离工作树回归，不是客户更新 |
| 真实 PostgreSQL | **未运行** | 集成文件已写、语法通过；需另授权本机隔离测试库及测试表准备，不能用 fake SQL 测试代替数据库验证 |
| 提交 / 推送 / 新 Draft / CI | **均未执行** | 父 #60 的 12/12 不归属本候选 |
| 真浏览器 / 长时 / 客户发布 | **均未执行** | L6 与发布授权另列；新 UI 控件尚未接入，默认严格候选仍关闭 |

为区分后续改动，60 个非文档改动文件按路径排序，依次以 `path + NUL + file bytes + NUL` 计算的 SHA-256 为 `086092b946dec301091b38991708c4d9e3a53b8505e0bfa39e18fe3c3faf3785`。它是本地源码/测试指纹，不是 Git 提交、安装包或 CI 证明。临时日志可能被系统清理，本节保留运行环境、命令、计数和对应源码指纹。

该次冻结后的下一项是单独授权的本机独立 PostgreSQL 验证，现已在第 9 节完成。此门不再反复列为待办。提交/普通推送/创建 Draft 并等待精确 CI 的接续授权见第 10 节；其后按原计划再进入第三批本地恢复，随后 C/U5、L4–L6。不能因“继续”越过已明确的禁止项，不追加外围功能。

## 9. 2026-09-07 接续授权：本机独立 PostgreSQL 验证

用户已明确授权“新建本机临时测试库、初始化测试表并运行隔离验证”。本节接续第 8 节，不沿用第一批数据库证据。本次已完成独占、仅绑定 loopback 的 PostgreSQL 实测，以既有 schema 初始化空测试库，仅运行本批 stop-authority 集成文件；测试数据和连接已清理，专用实例已停止。

本次数据库实测不连接本机既有或生产数据库，不运行完整 PG runner 中的 split/其他演练，不修改 schema/迁移文件，不调用客户 API/真实鉴权/平台采集。该次数据库授权不包含提交、推送、新 Draft、部署或客户插件更新；后续单独送审授权见第 10 节。

### 实测环境、结果与清理

- PostgreSQL **17.9**，本次新建实例 `127.0.0.1:55440`，角色 `onstarvoice_test`，库 `onstarvoice_test_active_stop_20260907`。
- 最终数据目录 `/private/tmp/onstarvoice-active-stop-pg.G9Nb5Z/data`；运行前校验真实 server address/port/user/data_directory，确认没有其他用户库及 public 表，再准备 **71 个既有 schema 文件**并验证 checksum。没有修改迁移文件或对既有数据库执行 schema 操作。
- 使用合成 tenant/agent/token/task/Attempt/create/snapshot；真实 Router 和生产 SELECT，所有权限查询均在 `BEGIN READ ONLY` 中执行。不调用 verify/heartbeat，不启动调度/采集。

| 验证 | Node 24.12.0 | Node 18.20.8 |
| --- | --- | --- |
| 本批真实 PostgreSQL 集成文件 | 1/1，0 fail/skip/cancel | 1/1，0 fail/skip/cancel |
| 真实 HTTP 请求 | 19 次 | 19 次 |
| 精确指定 SELECT | 17 次，各合法格式请求恰好 1 次；2 个错误 action 在查询前拒绝 | 同左 |
| 测试后合成数据与其他连接 | 全部 0 | 全部 0 |

原正向与拒绝断言全部保留；合法来源返回 200，错 Attempt、凭据撤销/到期/换绑、任务状态/版本变化、编排来源、其他活动任务/待执行命令均拒绝。本轮另外直接验证 snapshot 版本不符，以及原来源仍匹配但出现下一 Attempt 的真实 SQL 冲突；恢复精确来源后再次返回 200。正向查询前后身份、任务、Attempt、Snapshot 和 Command 行逐项不变。

每版测试结束后独立查询确认：合成租户、任务、Attempt、Snapshot、Command、Token、Agent、Binding、AuthCode 全部归零，其他会话为 0；初始化自带基础租户未改。专用实例受控停止，55440 不再监听。测试库文件与日志保留复现，没有删除客户或用户业务数据。

### 保留的失败记录与候选边界

首次实测最后的旧 `queries >= 14` 断言失败：实际原场景为 15 次请求、13 次查询，2 个无效 action 在查询前拒绝。现改为逐请求精确计数，新增两组“拒绝→恢复成功”后为 **19 请求/17 查询**，不通过放宽断言隐藏错误。第二次新种子误用不受 Attempt CHECK 支持的 `pending`，修正为既有合法状态 `claimed`；数据库约束保持原样。

上述修正仅涉及本批新增集成测试，不修改运行查询或其他运行代码。初次日志 `/tmp/active-stop-pg-20260907-initial.log` 与第二次失败日志 `/tmp/active-stop-pg-20260907-final.log` 保留，后者文件名含 final 但**结果是失败**，不能作为最终通过证据；两次专用实例均已停止。

最终通过日志：`/tmp/active-stop-pg-20260907-verified.log`。可复现本机准备脚本在 ignored 的 `output/architecture/run-active-stop-pg-20260907.mjs`；每次只创建新 cluster，精确核验目录和连接目标，成功/失败均停止自己创建的实例。正式 PG runner 会自动发现本集成文件，无需改 runner；本轮没有运行它的其他演练。

最终集成测试 SHA-256：`d36bd89f1d0dcbfbb91dd48ca9c3b19f24f66c65f941d34a03bcef8a3cd8eb28`。60 个非文档改动文件按第 8 节规则计算的新指纹为 `c6a159c4b09fec95036864808faed48cb930518a1b0f08e878246e8166e68826`；第 8 节旧指纹只归属其历史冻结版本。

补测后再次执行官方递归离线回归：Node 24.12.0 与 18.20.8 各 **3,102/3,102**，0 fail/skip/cancel。日志分别为 `/tmp/active-stop-post-pg-node24-20260907.log`、`/tmp/active-stop-post-pg-node18-20260907.log`。数据库测试独立计数，不并入这 3,102 项或声称完整 PG runner 通过；新增测试也经独立只读审阅，确认原断言保留且逐请求计数更严格。

该结果证明本机合成场景中的真实 SQL/Router 行为，不是生产 P95、客户数据规模上界、所有 PostgreSQL 版本或整个 PG runner 通过。真实浏览器、8/72 小时与客户发布仍属原 L6/发布门，不反向扩成本批的无尽附加测试。

本批数据库门已通过，该次交付冻结候选、未作新提交；后续提交授权和送审边界见第 10 节。不自动 Ready/合并/部署/迁移生产/更新插件/开启第三批恢复。

## 10. 2026-09-07 独立送审授权

用户明确授权当前冻结候选“提交、普通推送、创建 Draft PR，并等待 CI”。提交前重新核验父 #60 为 OPEN + Draft + CLEAN，head 精确 `3c19c5ea14c9ac1f68a21da8b8caf30353b459d1`，base `c1dd2a885225adb0a910fabd067041ce994b7b3d`，父 push/PR 两组 CI 12/12；父分支不变。

只对本隔离工作树已验证的 **63 个文件（60 个源码/测试、3 份计划）**提交；源码/测试指纹仍为第 9 节的 `c6a159c4...`。`output/` 本机日志/准备脚本、`extension-build/`、依赖目录、凭据和环境文件不进入提交。分支为 `codex/extension-l3b-active-stop-20260906`，普通推送，不 force；新 stacked Draft 的 base 为 #60 的 `codex/extension-l3b-terminal-authority-20260906`，不是 main。

新提交 SHA、PR 链接和对应 push/pull_request 两组 CI 结果写入 PR 正文与任务交付，不用父 CI 冒充，也不为记录自身 SHA 循环创建文档提交。既有 CI 的隔离检查按原配置运行，不增加工作流、不接触生产。若 CI 失败，保留失败证据并报告，不擅自扩大运行代码改动。

始终保持 Draft；不 Ready/合并/部署/迁移生产/实际 split/更新客户 Extension/新采集，不改父 Draft 或其他 PR，不自动开启第三批恢复。
