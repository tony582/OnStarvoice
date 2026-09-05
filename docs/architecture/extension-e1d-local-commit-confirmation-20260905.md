# E1d：列表保存成功确认与失败重试保护

日期：2026-09-05。隔离候选，只到 Draft；这是局部行为修复，不是生产发布或整个存储/同步重构完成。

## 基点与变更范围

- 精确基点：E1c PR #42，`9413adede541d8049bc00a784df6b23b703c152b`。新分支 `codex/extension-e1d-local-commit-confirmation-20260905`，PR base 为 #42 分支。
- main 仍为 `51896d8694c4b19e3731e5b6b7623397420c84a9`；PR #37–#42 不改变。Cron 解耦 #37 独立保留，未静默并入。
- 运行改动仅 `utils/capture-sync.js` 的 `saveRecordsWithCacheDedupe`：检查 `setDataPool` 返回值；会话去重键先暂存，提交成功后才发布。
- 另新增一份保存确认回归测试和本文档。未改 storage、API、ACK、状态格式、任务队列、平台采集、防风控等待、并行度、重试次数、background、sidebar、manifest、权限、版本或服务端。

## 修复的具体问题

`setDataPool` 在普通拒写、配额不足且无法安全压缩或重写失败时返回 `false`。旧调用只等待 Promise，忽略返回值，仍把记录交给已保存 UI/trace 与后续同步；checkpoint 会话还提前把该条身份键放进 `knownKeys`，可能让最终保存跳过未落盘记录。

本轮只改变以下提交边界：

1. 仍在原同实例数据池队列里读取、去重与合并；批内去重用暂存键继续保持原行为。
2. 有新增/刷新时，保存返回失败即抛出现有存储错误，不发布该次 saved/skipped 统计、记录 ID、trace binding 或去重键。
3. 保存成功后，才把暂存键并入原会话 Set，再执行已有结果发布。纯已存在且无变化的跳过无需新增写入，仍按原语义发布 skip。
4. final save 失败沿用外层失败返回，不进入 saved 进度、已保存标记回写或自动同步检查。checkpoint 的既有 fail-soft 不变；同一会话最终结果再次携带该记录时，能够实际重新保存，不被失败时的键挡住。

不清空此前已成功提交的会话记录。`checkpointCount`、`detectedCount`、`filteredCount` 是观察量，仍可在保存前变化，不能解释为保存成功数。无 session 时的批内刷新/重复行为保持原样；未增加全池克隆。

## 未解决的边界与下一步

- 这不是完整耐久重试队列：checkpoint 失败且该记录没有再次出现在最终 payload 时，本轮没有新增 outbox、补偿或恢复保证。进程退出/MV3 回收、多页面同时写入也未由本轮解决。
- 既有 `captureAndSync(mode='keyword')` 不建立列表 checkpoint session（类型判断只接收列表类型）；最终保存仍经本修复函数。真实 checkpoint 测试使用既有有效的 `blogger_notes` 路径。本轮不顺带修改 mode 映射。
- E1c 基点 `capture-sync.js:7445/8237/8292/9010` 的四处 `markRecordSynced` 及 `applySyncRecordResultItem` 的失败状态更新忽略“记录缺失”返回的 `false`，本轮保持不动。客资补同步在标记前还会更新 payload 和计数，不能只包装四个调用就宣称完整保护。
- 后续应区分“远端已成功”与“本地确认失败”，保留远端结果与补偿依据。简单抛通用错误可能丢失已有远端成功上下文；这与列表首次入池失败不是同一种错误。
- `updatedAt` 不是 revision/CAS；同 ESM 队列不是跨上下文事务。迟到正文回执保护需独立明确记录版本、Attempt、租户与提交原子性。auth/任务 closure/outbox 的已有保护不能代替正文 ACK 保护。
- 不据本地故障注入推断客户生产已经发生丢数据。`lastSyncedAt` 也不是单独的成功证据；未同步/失败记录的清理边界没有放宽。

## 验证记录

- 新增回归覆盖真实 captureAndSync 与 storage 的普通/配额拒写、checkpoint 与最终保存连续失败、同 session 新增/刷新失败后的最终保存恢复；真实函数桥接覆盖 pending、false、抛错、批内去重、无 session、无需写入的 skip、此前成功证据保留。Chrome API/采集/网络在 Node 测试中使用替身，旧测试文件未修改。
- Node **24.12.0 / 18.20.8** 全量回归各 **1,896/1,896**，无失败、跳过或取消；其中新增测试各 **12/12**（8 个顶层和 4 个子测试）。同一新测试只重定向 utils 到未改 E1c 基点，两版本均为 2 通过/10 失败，确认测试可以检出原问题。
- 语法、差异空白和仓库卫生检查通过。E1d/E1c 快照均为 **98 文件**，97 个 SHA-256 一致，仅 capture-sync 改变且源码与构建副本一致；原客户包与 QA 旧包仍 **95/95** 完全相同。manifest 仍为 **0.4.5**，权限不变，server 排除依赖后 **226/226** 文件一致。
- 独立源码核对：除目标函数外，capture-sync 其余 **96,202 tokens** 完全相同。81 组真实函数成功路径差分一致；另 4 组 false/reject × 新增/刷新检查失败后证据不发布、同 session 重试成功。差分求值不计作新增自动测试数量。
- Chrome for Testing **151.0.7922.34** 与 Edge **152.0.4191.66**：E1c 基点各一轮、E1d 候选各一轮，每轮 12 个原加载/分类/生命周期场景，加 3 个新保存探针，共 15 个检查。基点的 3 项是确认旧失败特征，不代表基点达到新的保存验收要求。
- 浏览器使用单独 QA 工作区与临时 Profile。新探针调用真实 captureAndSync/storage 模块，输入为合成采集结果，Chrome 写入失败被定点注入，重试成功使用临时 Profile 的真实 chrome.storage.local；页面回执为替身，fetch 被拒绝。不是实际磁盘满、客户任务或服务器同步验收。
- 两浏览器均复现基点假保存，候选拒写后无 saved 进度/trace/同步检查；checkpoint 首写失败后，基点只有一次写尝试且池为空，候选实际第二次写成功且 ID 对应，计数仅一次。
- 首轮探针把 keyword 模式误当成有效 checkpoint session，测试未通过；修正测试为既有 blogger_notes 路径并按既有 auth-check 返回形状断言后，四轮全部通过。未为通过测试改变运行代码，失败原始日志保留。
- 候选任务面板与等待截图已查看。四轮临时 Profile 均已退出/清理，生产更新请求被本地代理拒绝；NetLog 未观察到成功的非 loopback 连接，保留失败 IPv6 探测证据，不宣称具有进程级封包隔离。

本地浏览器证据位于独立 QA 工作区 `output/playwright/e1d-base-chrome-run-2`、`e1d-base-edge-run-1`、`e1d-chrome-run-1`、`e1d-edge-run-2`；逐项结果见各目录 `list-save-commit-result.json`。QA harness 和原始日志不进入本运行 PR。

本轮提交、普通推送、新建 stacked Draft PR 并等待 CI 后停止；继续禁止 Ready、合并、部署、生产迁移、split、客户 Extension 更新及处理 PR #29。UIUX 与共同代码/素材权属审查仍是独立工作，不因这次修复解决 MediaClaw 区分或权属问题。
