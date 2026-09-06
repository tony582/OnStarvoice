# L2：保存与交付流水线实施记录

## 实施前合同

精确父提交：PR #54 最终 head `5f774ebfcaed24b79bfe84369d9b9c483da38f66`，CI 12/12、OPEN + Draft 在本轮重新核验。
工作树 `OnStarvoice-extension-l2-20260906`，分支 `codex/extension-l2-result-delivery-20260906`。
以下模块/退出条件先于源码迁移登记；实际完成范围和证据见末节，不是生产发布声明。
主计划见 [统一主执行计划](extension-architecture-roadmap.md)。

## 本轮职责与边界

| 模块 | 本轮迁出的完整职责 |
| --- | --- |
| checkpoint / cache | 列表 session、保存队列、身份索引、去重/刷新、最终保存和统计 |
| payload / trace-model / comment-model / metrics-model / record-model | 记录、评论、指标、trace 数据整理和存储 envelope，不改变字段、作者保护或零/未知语义 |
| store | 单/多条直接新记录持久化端口，覆盖非列表结果及原单篇/URL 批次直接写入；列表原子读改写仍由 cache 使用原存储事务端口完成 |
| preflight / history | 原授权与目标检查、默认表名、单条/批量及前端失败历史 |
| single / batch | 单条内容/客资提交与批量协调，保留所有原路径及回包 |
| requests / batch-plan / cancellation / results | 请求构造/分片/排序、限流与等待、取消/未知/暂停、精确 ACK 匹配和本地写回 |
| coordinator | 单一实例装配和原 checkpoint 可变指针，显式宿主端口及同名兼容方法 |

不迁移 Sidebar controller、`record-sync-queue.js` 的 pending/dirty/hold、页面导航/选择器、安全探测、真实评论采集、无人值守编排或服务器。
不增加缓存清理/IndexedDB/存储格式，不默认启用 E1e/E1i producer，也不调整已稳定的等待、并发或重试规则。

## 原入口与完整调用清单

唯一静态运行消费者是 `sidebar/sidebar-logic.js`：L2 的实际调用包括 `resolveSyncInputForRecord`、`syncRecordBatch`、`checkBeforeSync`、`buildCommentLeadsConfigFromSettings`、`buildCommentLeadsPayloadForRecord`。
原 `captureAndSync`、详情/评论重试、关键词/URL 批次等继续保留为兼容编排入口，经同名 alias 调用新职责；不能只证明模块单测。
保留所有 45 个原 ESM 导出；无实际外部调用的导出也不删除。
`processListCaptureCheckpointProgress` 的外部调用目前只在保存测试发现；不添加真实 producer，不能把测试注入当作运行接线。
`captureNoteWithOptionalComments` 和 `batchCaptureByUrls` 的原直接 `addRecord/addRecords` 已接保存端口，保持原构造时间、单条/多条分支、参数及返回值。
详情过滤/完整性处置中的 `deleteRecord` 留采集宿主，不将筛选策略带进保存模块。

## 状态与端口所有权

- coordinator 拥有唯一 `activeListCaptureCheckpointSession`；session 自带 queue、knownKeys、recordIdByKey、IDs、traceBindings、savedRecords 与 stats。
- 每次批次调用的 queue/results/paused/canceled/lastRequestStartedAt 仍局部拥有，不引入全局串行提交队列。
- 存储队列归 `storage.js`，通过原函数端口调用；`waitMs` 仍使用宿主可靠 Worker 时钟，不换成普通定时器。
- `activeCaptureTaskSessions`、可靠时钟状态和采集编排继续归原宿主；不复制执行锁/数据池。
- 跨阶段显式命名调用，不反向 import `capture-sync.js`；原评论 payload 与 leads 的依赖关系不改执行顺序。
- session 仍按旧兼容协议传递；不将冻结方法表冒充深不可变状态或安全隔离。

## 必须保持的行为和已知缺口

1. 列表在同一存储队列内读取→去重/刷新→写入成功→发布 knownKeys/stats/IDs/trace；false/throw 不污染已保存去重键。
2. final save 先等 checkpoint 队列，再保存并归并 ID/trace；刷新不 unshift、不算新增。保存确认前不发布 saved 或启动同步。
3. 单条保持 SYNCING→记录 DRAFT→读取目标/记录→内容发送→本地确认→客资→整体状态/进度→历史。
4. 批次先标记全部待发记录，按原类型/platform/workflow/keyword 分组；逐条本地写回后才记结果与进度，组完成后写历史。
5. ACK 严格按 recordId 匹配；顶层 ok 不补缺失 ACK 成功；限流、重记录隔离、未知阻塞、非枚举 pause/cancel 元数据原样保留。
6. 保留 500 条上限、单请求 5 条/1 MiB、评论重记录单条、256 KiB、2 秒间距、两次限流重试及 5–60 秒等待；内容同步继续携带结构化评论。
7. **既有风险未修复**：远端已接受但本地确认 false/throw 时仍可能误报或丢失 ACK；保留失败特征测试，不在结构迁移中偷偷改协议或声称已安全防重发。正式修复须按 E1e/E1i 的服务器与恢复屏障门槛处理。

## 验证、退出与后续

先按 AST 核对迁移函数与保留宿主函数，记录实际旧/新行数与出口清单。
原保存/同步/ACK/作者/评论测试定位真实新模块，不留旧复制函数、不拼接成伪旧源绕过断言；真实 ESM 入口的离线用例继续执行。
补充冷导入、独立实例、保存失败/取消/未知回执、请求/写入/进度/历史配对；双 Node 全量、语法、卫生和隔离快照通过后独立审阅。
候选快照只在新工作树生成；客户参考目录只读核对，不打包安装、不 Reload，不访问真实业务或新采集。
提交、普通推送及新 stacked Draft PR 后等待精确 head CI；禁止 Ready/合并/部署/迁移/split/客户 Extension 更新及处理 PR #29。
本地/CI 候选门通过后才能按计划进入 L3；真实浏览器/长期/发布门另列，L2 完成不等于全部架构或已知可靠性缺陷已解决。

## 实际结果

### 迁移与旧实现退出

- `utils/capture-sync.js`：**20,321 → 14,979 行，净减少 5,342 行**。166 个原函数体迁入 15 个职责阶段，另有 store 与 coordinator，共 17 个新模块；155 个宿主原函数体保留且 AST 等价。不是删掉业务能力，也不是整个采集核心已全部拆完。
- 原 45 个 ESM 导出逐名保留；其中 15 个迁出导出使用兼容 alias。原内部调用通过宿主末尾的实例装配连接真实模块，无反向 import 宿主、无伪旧文件运行副本。
- checkpoint 指针唯一归 coordinator；原 session queue 和每次批次局部队列不合并。74 个显式宿主端口完整解析；跨阶段调用逐项命名，不以无约束 context bag 隐藏依赖。
- 两处宿主直接新记录保存经 `savePreparedRecord/savePreparedRecords` 转发，参数、同步返回值及 Promise 身份保留；列表原子保存仍使用原 `runDataPoolMutation/getDataPool/setDataPool` 路径。没有新增存储队列或改格式。
- 同名兼容方法表仍含内部方法，不宣称已经收敛为最终最小 API；后续 L3/L4/L5 按消费者归属清理，不在本批删导出。`record-sync-queue.js` 和剩余采集/重试/导航入口未迁移。

### 已执行的本地证据

| 验证 | 本轮结果 |
| --- | --- |
| 官方递归回归 `scripts/run-node-regression-tests.mjs` | Node 24.12.0 / 18.20.8 各 **2,148/2,148**，失败、取消、跳过均为 0；不是只运行两级文件 glob |
| 新增真实模块/宿主用例 | 13 项纳入全量：冷导入、166 函数指纹、保存端口、独立实例、false/throw 后去重恢复、最终保存等待、单条时序、混合/缺失 ACK、取消、批次独立及精确 45 导出 |
| 精确父提交/候选业务事件配对 | 双 Node 各 17/17（上述 13 + 4 个本地配对）：single、batch-success、batch-mixed、canceled；比较回包、数据池与 I/O/进度/历史次序，仅排除列明的时钟字段，不要求相邻两次执行时间戳相同 |
| AST 与独立源码审阅 | 166 个迁出函数仅允许 checkpoint 状态显式归属变化，155 个宿主函数等价；116 条 port 引用、82 条跨阶段引用及 74 个注入端口均解析；无 EOF 装配前读取迁出 alias；未发现阻断项 |
| 原测试保持 | 9 个测试文件改为读取真实模块，原 test/subtest 名称及数量逐文件保持；原全表面禁止断言逐个新模块继续检查，不弱化为只检查残留宿主 |
| 语法/卫生/空白 | 双 Node 检查宿主及 17 新运行模块通过；仓库卫生 807 文件、`git diff --check` 通过 |
| 隔离快照 | L2 127 文件 / v0.4.5，L1 → L2 仅修改 `utils/capture-sync.js` 并增加 17 个模块；其余文件相同、无删除、无版本号/manifest/服务器变化 |

配对审计使用 `ONSTARVOICE_L2_BASELINE_REF=5f774ebfcaed24b79bfe84369d9b9c483da38f66` 读取本地 Git 对象；不访问网络或真实业务。CI 无历史对象要求，始终运行全部 13 项新增用例；该可选审计另加 4 项，不是 skip 原用例。

快照清单摘要沿用 L1 算法：相对路径字典序连接 `path + TAB + SHA256(bytes) + LF` 后 SHA256。

- L1 父快照：`e912c95b9a8aa668d1fe4d35f9783c346601be884bc62fe71204b524be7c8b0f`（110 文件）。
- L2 候选：`533a03bd1b1b17973469699301f7f144fb44df0c36e04ec0c4d0dc0da308e094`（127 文件）。
- 原工作区客户参考目录：`554479f7e01198ba0e6f7c2eb3d16e58c55db773aaadad90ecea5d6b039d1f87`（95 文件 / v0.4.5），只读核对且未改动；不代表已核验客户实际浏览器加载版本。

### 交付门和后续

本地源码和双 Node 回归已完成；提交、普通推送、新 stacked Draft PR 及精确 head CI 仍待执行，不能据本地通过提前写成远端完成。
独立代码审阅、三份计划文档的最终独立核读、提交前白名单与暂存区空白检查均已通过。
下一步固定为 L3：先核对 UI 设计交付与 U5/稳定基线缺口，再迁移 Sidebar 的任务 controller、状态投影与受控命令，保持有权历史读取/禁止新采集的规则。不另开与主干无关的小功能。
L2 没有解决上文第 7 项既有 ACK 确认风险，没有接真实恢复 producer，没有做真实采集、浏览器加载、8 小时/72 小时验收或客户发布；这些仍是独立门槛。UIUX/工作流用语与来源权属区分未因拆文件而完成。
