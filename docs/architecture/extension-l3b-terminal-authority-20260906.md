# L3-B 第一批：终态恢复建议撤销与共同写入保护

日期：2026-09-06。状态：**本地实现、离线验证及专用 PostgreSQL 有界验证通过；用户已授权提交、普通推送、新建 Draft PR 并等待精确 head CI。本批功能冻结，提交/PR/最终 CI 结果在 PR 正文与任务交付中记录。B/L3 和真实浏览器/客户验收未完成，不自动进入第二批。**

## 1. 授权、精确基点和范围

用户最初批准三批接线方案的第一批：新建隔离分支，实施、测试并更新计划，先不提交、不推送、不部署、不新采集。完成本地验证后，用户另行授权第 8 节送审操作；既有生产及下一阶段限制保持。

- 精确基点：`c1dd2a885225adb0a910fabd067041ce994b7b3d`，#59 的最终 head；本轮只读确认 OPEN + Draft + CLEAN，base 为 `5ef340c625f764e9228cd965740208b425f886bb`。
- 新工作树：`OnStarvoice-extension-l3b-terminal-authority-20260906`。
- 分支：`codex/extension-l3b-terminal-authority-20260906`；从上述基点新增本批提交，不改父提交或其他 Draft。
- 原始完整方案保留在父工作树的 `output/architecture/strict-control-wiring-plan-20260906.md`；本记录把本批范围与实际结果写回可版本化主计划，不修改父 Draft。
- 首次候选冻结时没有提交/推送/PR 操作；当前仅新增本批提交/普通推送/新 Draft 授权。没有执行 Ready、合并、split、部署、真实鉴权、客户 API/数据调用、客户包更新/Reload、新采集或 PR #29 操作。第 7 节只初始化新建本机测试库，不修改任何现有/生产数据库。

已修改运行文件只使用批准的 5 个宿主中的 4 个：`background.js`、`utils/storage.js`、`server/app.js`、`server/middleware/auth.js`；本批没有必要改 execution-identity。

新增运行文件恰为批准的 4 个：

| 文件 | 唯一职责 |
| --- | --- |
| `utils/control/terminal-authority.js` | raw 终态事实/来源校验、后台私有 handle 生命周期、两次在线核验和最终提交编排 |
| `utils/control/state-fence.js` | 共同 Auth/Q 锁、严格不可用拒绝、旧 writer 的来源/清理见证和短 delta 写入 |
| `server/routes/capture-control-authority.js` | 专用受限 POST Router，no-store、安全拒绝，不复用 verify/heartbeat |
| `server/services/capture-control-authority.js` | 一次一致 SELECT 核对当前凭证、绑定、创建命令和当前 task/Attempt/snapshot |

Sidebar、UI、content、平台算法、runner、采集等待、同步协议、manifest、依赖版本及锁文件均未修改。Sidebar 主文件仍为 11,014 行；本批是上一轮结构迁移的必要执行接线，不是又完成一轮主干搬迁，也不使用新增测试数量充当架构完成比例。

## 2. 真实入口与成功的严格含义

实际入口为后台 `onConnect` 的独立终态端口监听器，以及 `onMessage` 的专用 PREPARE / EXECUTE 分支。旧 owner 监听器原样保留，其真实协调器会忽略新端口名。旧 UI 没有建立新连接或发送新命令。

调用链：允许的 Sidebar document → 后台 raw 读取 → 服务端只读权限查询 → 后台私有短期 handle → 执行前第二次查询 → Auth/U/L/A/Q 内重读全部事实 → 一次目标元数据写入。

成功仅表示：“已撤销这次任务的本地恢复建议；已有结果和同步状态不变。”只写当前 request 的 `recoveryDismissedAt`、`recoveryDismissedMessage`、`updatedAt` 和准确 ledger 行/全局版本。它不是页面停止证明，不承诺云端永不再次调度。

首批只支持当前 request 槽位中的正常 `completed_with_failures` 云分配、单轮、非编排关键词任务。每条关键词结果必须有真实尝试与正常结算事实；计划不超过现有关键词计划上限 30 项。需精确原始 Attempt UUID、当前节点/租户、来源版本、创建命令，以及保留的 summary→counts/checkpoint/progress 投影证据。

还要求当前 Attempt 的同步结算证据明确已知、drain 已完成、blocked/canceled 明确为 false，13 项必要数值计数完整。未知或缺字段拒绝；失败上传允许保留，这不是页面活动停止或全数据池已同步的证明。

旧记录、缺失/合成 Attempt、archive-only、重复归档、待启动/人工处理、安全阻断、closure/adoption/reconciliation、来源不完整或矛盾、凭证过期/冻结/撤销、跨节点/租户/绑定/Attempt 均不进入成功路径。未同步和失败上传原样保留，不做“清零后成功”。

`completed` 无需撤销建议，`failed` 可能只是超时标记，首批均不支持；业务终态不被冒充为物理停止。严格 active cancel/recover 继续由既有拒绝入口拒绝，不能回退到旧 cancel、打开 runner 或全量云同步。

## 3. 权限、时效及可证明的边界

服务端把当前 token、agent、tenant、auth code/binding 和原始 completed create 命令中的服务端写入绑定联查。相同 agent ID 可以换绑，客户端 snapshot metadata 中自报的绑定不构成来源证明。

新服务只有 SELECT，不更新 token、last_seen、任务、命令或心跳；没有启动任务/进程/定时器。POST 只是避免目标参数进入 URL。查询使用既有 schema，没有新增表/索引/迁移文件；第 7 节是隔离测试环境准备，不是服务启动时迁移。

后台 handle 绑定 Extension ID、准确 Sidebar URL/document、实时端口、后台 generation、完整凭证指纹、目标事实和动作。单次可用窗口最多 5 秒，在线请求有超时，排队/重试后不能续期。最终锁内检查而非只依赖异步 storage change 事件。

成功回执短期缓存只重放原结果，不再次写入；回执重放仍重新读取凭证指纹并核对当前 caller，避免身份已替换但 change 事件迟到时跨身份返回旧回执。断连、重新连接换代、后台重启、身份变化使对应能力失效。

这是有界在线检查与应用内最终写入围栏，**不是服务端撤销与 Chrome storage 的跨系统原子事务，也不是持续撤销 epoch**。Web Locks 不可用时新命令拒绝；旧兼容路径保留原无锁降级，不声称其拥有严格保证。

## 4. 共同 writer 与锁顺序

需要时依次获取 `Auth → U → L → A → Q`。Q 是跨 Extension 上下文最终短存储锁；不在持 Q 时获取其他队列/锁、调用 public writer、页面或网络操作。它不是 Chrome storage 底层事务。

| 写入路径 | 最终队列/锁及保护 |
| --- | --- |
| 新终态提交 | Auth→U→L→A→Q；raw auth/request/ledger/archive 重读，私有能力重核，一次写 request+ledger |
| 普通无人值守提交 | 既有 U→L→Q；准确 predecessor/创建见证、清理标记、同 Attempt 撤销决定和版本保留 |
| targeted 提交 / 通用账本 upsert / 读修复 / 账本压缩 | L→Q；raw 清理来源和现有行检查，不用 normalizer 补的 createdAt 复活旧记录 |
| 归档新增/删除/清理/压缩 | A→Q；新增归档重核当前 source/version/撤销决定；新命令不删除 archive |
| 清任务历史 | L→A→Q；同一短阶段重读关联 request，保留真正活跃行，内联 archive 删除而非重入 public helper |
| 旧 stop/terminal cleanup/localClosure/recovery dismissal 写入 | 既有 U/L 后的短 Q 段或 fresh delta；页面与后续调度留在锁外 |
| storage set/update/clear auth | Auth→Q；旧 CAS 锁名保持，update 不重入 public setter |
| storage clearAll | Auth→Q；持久清理标记先落盘，再移除关联控制根；其他非控制数据清理在锁外 |

独立审阅没有发现改动部分的 Q→队列/网络反向边。普通提交的 sync schedule 移到 Q 释放之后；新命令不调用 sync schedule。

实现时修正并加入回归：清历史保留的活跃 Attempt A 可正常恢复成 B；缺显式 Attempt 的旧格式记录仍经独立 legacy 比较更新/归档/替换，不放宽严格 UUID 解析；两者组合也覆盖。迟到 terminal_absorbed 写入不得撤销已提交决定或回退该写入所见的全局 ledger 版本。

### reset 方案的实现细化

原提案写为 raw 删除控制根。实施审计发现仅删除 ledger 会让未修改的 targeted 源及迟到 producer 在重启后重建旧行，因此复用 ledger 已有 `clearedAt`：先存兼容的空 ledger+清理标记，再移除 auth/request/archive。没有增加 schema 或修改数据池/同步协议。

清理标记写失败则不删除控制根；删除失败则保留已经落盘的标记并报错，不假装全部清理成功。同一毫秒/时钟回拨下连续 reset 标记仍递增。

创建入口在异步准备前捕获 raw 清理标记，最后 Q 内比较；旧工作即使生成更晚 createdAt 也不能跨过 reset。明确的新创建在相同标记下允许同毫秒/时钟回拨，不误挡新任务。无创建见证的旧 producer/read repair 使用原始 createdAt 和 retained 行保护，不能靠 normalizer 补时间通过。

这些保证限定于合作的应用内 writer。外部清除浏览器数据、损坏、恶意写入、伪造 birth 不在锁的保证内。旧 UI 的排队 clear-history 和缺 scope 的通用 upsert 仍没有完整“入场身份意图”绑定；Q 不等于所有 legacy 操作已有跨身份授权隔离。这是继承的 C/身份入口缺口，不把新 strict 的完整凭证核验扩称为旧控制链已全部修复。

## 5. 验证与证据分级

官方递归发现器未修改，旧测试不跳过、不删除；PostgreSQL required 清单只追加新文件。

| 验证 | 结果/边界 |
| --- | --- |
| 精确基点 `c1dd2a8` 官方全量 | Node 24.12.0 / 18.20.8 各 2,468/2,468，0 skip；父工作区仍干净 |
| 本地候选官方全量 | Node 24.12.0 / 18.20.8 各 **2,615/2,615**，0 fail/skip/cancel；不是 GitHub CI 或真实平台采集 |
| 真实后台入口专项 | 70 项；实际完整 onConnect/onMessage、原 owner 协调器、本机 Router/服务、最终 Auth/U/L/A/Q；DB readOne 为离线 fixture |
| 服务端专项 | 40 项；当前绑定/原始命令来源、限动作、拒绝、只读响应；不证明 PostgreSQL 查询已经实跑 |
| 共同 fence + 实际 storage API | 25+13 项；真实 host writer/normalizer/ledger core，另一 realm 锁、迟到写入/reset、配对 legacy 恢复、quota 新读取与 auth CAS |
| 源码和构建 | 语法、diff 卫生、隔离快照校验；新模块递归进入本工作树 extension-build，未生成客户安装包或 Reload |
| 独立核读 | 服务器/客户端契约与旧 writer 锁序分别核读；发现并修正兼容及回执身份问题，遗留限制明确保留 |
| PostgreSQL/真实查询/规模 | 专用 PostgreSQL 17.9 实测两版各 1/1；真实 Router/SELECT-only 事务、权限/原绑定来源、1,500/10,000 条同终态合成任务各 3 次查询均通过，详见第 7 节；不是生产 P95，也未运行完整 PG runner 的其他演练 |
| 浏览器/客户/长期 | **未完成**。未执行真实 Chrome/Edge 平台验收、8 小时内存或 72 小时运行，不新采集 |

真实终态成功样例由现有 checkpoint 结算、controller 终态上报、background update/buildRun、task-center normalize、cloud snapshot 及服务端 normalize 链产生。raw summary 不被要求存在于 ledger/snapshot；仅按保留字段映射比对。失败上传明确保留，不能用手填一个 terminal status 冒充全链。

Node 24 初次全量受构建快照缺失和旧 source-contract 路径影响，共 3 项失败，该结果未作通过证据：本地补齐隔离快照，保留原 owner listener 与 auth 锁合同后在两版 Node 重跑全部测试，不改白名单外旧测试以绕过断言。安装依赖仅使用原锁文件；安装工具报告现有 server 3 个 moderate、admin 1 moderate/5 high 审计提示，未做 audit fix/升级；不把此记录当新增漏洞归因或整库安全审计。

本机日志（临时文件，不随源码提交）：候选 `/tmp/terminal-authority-node24-final.log`、`/tmp/terminal-authority-node18-final.log`；精确基点 `/tmp/onstarvoice-base-regression.la1ESZ/node24.log`、`/tmp/onstarvoice-base-regression.la1ESZ/node18.log`。最终卫生检查检查 872 个源码文件，隔离快照 168 文件；这些计数不是完成比例。

## 6. 下一门与原计划收尾

1. 专用测试库与本批有界数据库验证已按接续授权完成（第 7 节）；该项不再反复作为下一步，也不把已观察到的非阻断优化变成新阶段。
2. 用户已另行授权本批提交/普通推送/新 Draft，并等待精确 head 的 push/PR CI；不能沿用父 CI。真实客户规模/浏览器和长期验收仍按原计划后续进行，不通过反复增加本批功能等待它们。
3. 第二批再单独授权准确页面活动/资源停止，第三批本地恢复；云端 adoption/恢复协议另列，不处理 #29。没有成功链不关闭 B/L3。
4. C/U5 接独立新 UI/可信历史读取身份；继续遵守“可查看有权历史，不允许新采集”。UIUX、流程、用词、资产与 MediaClaw 的独立性仍需专门验收，不把拆模块/改名当权属结论。
5. L4 平台和来源、L5 后台宿主剩余职责、L6 实机长期按原次序推进。服务端 #37/G3、P8/G8 收尾继续登记，未顺带处理或宣布完成。

第一批有正向命令，并不等于完整 architecture、安全停止/恢复、UIUX 或客户验收完成。

## 7. 接续授权：专用数据库验证与本批冻结

用户在明确询问“仅在本机创建独立测试库、初始化现有表结构并完成实测”后回复“继续”，并要求说明终点。授权只用于这一个新建测试环境；生产/现有数据库、发布和其他阶段限制不变。

- 独立 PostgreSQL 17.9 实例：`127.0.0.1:55439`，角色 `onstarvoice_test`，新库 `onstarvoice_test_terminal_authority_20260906`。
- 数据目录：`/tmp/onstarvoice-terminal-authority-pg.OnmwQq/data`。没有使用本机现有 5432 实例的数据库。
- 核验真实 server address、port、database、user、data_directory；通过既有 maintenance CLI 仅给空测试库应用 71 个既有 schema 文件，再校验 checksum。未执行 reset/adopt/split/应用调度或完整 PG runner。
- 首次实测暴露测试种子参数的 UUID/text 类型未显式标注，以及期望请求数与实际不符；只修新测试文件，补充恢复合法状态和当前换绑 token 的真实请求，不降低断言或更改运行查询。
- 同 agent 换绑定后，当前有效的新 token 对旧绑定创建任务仍返回 409；旧 token、撤销、过期、错 Attempt、冲突命令等均拒绝。服务查询在 READ ONLY 事务执行，授权查询前后原业务行保持不变。

| 最终专用测试 | Node 24.12.0 | Node 18.20.8 |
| --- | ---: | ---: |
| 集成场景 | 1/1，0 skip | 1/1，0 skip |
| 1,500 条同节点/同租户/同终态无关任务，3 次规划+执行最大值 | 83.914 ms | 20.015 ms |
| 10,000 条同节点/同租户/同终态无关任务，3 次规划+执行最大值 | 84.401 ms | 82.155 ms |

各任务同时保留 Attempt、Snapshot、completed create Command，四表各为 1,501/10,001 行。精确 task/attempt/snapshot/command 查询均使用现有索引，每次实际返回 1 行、循环 1 次、过滤 0 行，低于本地单次 SQL 规划+执行 2 秒粗预算。

**明确限制**：后继冲突检查仍顺序扫描 1,501/10,001 行，具有线性成本。这是固定本机数据量下的实测，不是生产规模上界、整体常数复杂度或生产 P95。它登记为扩展性提醒/后续发布规模核验项；本批既定有界验证通过后不顺带改索引或新增迁移，不再扩大这批功能。

最终测试文件 SHA-256：`58ba764d9bd4833d1d1eaa88503d8a4c9c061d5866067f302386afcb42b8a21d`。最终两次结果保存在本任务工具输出；第 5 节 Node 日志仍指离线回归，`authority-node24.log` 为初次失败记录，不能冒充最终通过日志。

两版测试后清理并由主任务复查：合成租户、task、attempt、snapshot、command、token 均为 0，其他会话为 0；初始化自带的基础租户未动。专用实例已受控停止，55439 不再监听，测试库文件与初始化日志保留供复现；没有删除用户数据或停止现有数据库。

本批至此冻结在“本地候选待提交/审阅”，不继续增加场景或开启第二批。剩余总范围为 L3–L6 四阶段及单列的原服务端收尾，按主计划停止规则推进。

## 8. 独立送审授权

用户明确授权“提交、推送、创建 Draft PR，并等待 CI”。本轮只对冻结的 19 个候选源码/测试/计划文件提交，普通推送新分支，以 #59 的 `codex/extension-l3b-strict-control-20260906` 为 stacked base；提交前重核父 head 为 `c1dd2a885225adb0a910fabd067041ce994b7b3d`、OPEN + Draft + CLEAN、CI 12/12。

本批独立等待新提交的 push 与 pull_request 两组 CI，不以父提交/本地回归代替。最终 SHA、PR 号与 CI run 结果写入新 PR 正文及任务交付，避免仅为引用自身 SHA 再循环产生文档提交。

保持 Draft；不 Ready、不合并、不删除/改写其他分支、不修改 #59 或其他 PR、不部署/迁移生产、不更新客户 Extension、不新采集、不自动开启第二批。本轮不扩大运行功能；若 CI 失败，保留失败证据并报告具体阻断。
