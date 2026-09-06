# U3：独立摘要快照与读取许可生命周期

日期：2026-09-06。基点为 Draft PR #50 / `7a0bc4cdde66a1fd0b761fc44038776ae37c2664`；独立分支 `codex/extension-u3-authorized-snapshot-source-20260906`。只推进新架构和人工数据验证，不改旧 PR 或客户运行链路。

## 结论与真实接入边界

本批完成一个**进程内轻量摘要索引、延迟详情加载接口、读取前后许可核对**的可执行数据源，可直接作为 U2 的注入 source。它不依赖 UIUX 定稿。

**没有**实现真实权限服务、浏览器存储适配器或 PostgreSQL 结果查询器；没有为旧记录补造归属，没有磁盘/数据库迁移，没有接真实客户数据。真实 source 的身份来源和快照一致性仍需要后续独立实现，不能把函数回包字段当作鉴权事实。

## 发布基线核对

本轮只读取本机源码及客户参考包文件，未读取生产磁盘或客户存储。

- 本机客户参考 `OnStarvoice-2/extension-build`：**0.4.5 / 95 文件**。
- 所有 95 文件分别与稳定来源 `85f8d797358e5aa2acf4db51ff1b3c57abe6c594`、E-base 候选 `bc2fc9d0adb36e5997383087bc5cb2222369e291` 的对应源码逐字节相同。
- 与 U2 来源的旧 main 运行源码比较有 **9 文件不同**：background、content-v2、manifest、sidebar-logic、capture-sync、capture/debug-session、capture/list-capture-debug-overlay、capture/task-runtime、capture/task-tab-group。
- 因此本候选不能直接替换客户包；新模块仍不进入构建白名单。该文件比较不是本轮生产部署/进程版本核验。

客户清单 SHA256 为 `554479f7e01198ba0e6f7c2eb3d16e58c55db773aaadad90ecea5d6b039d1f87`。格式：路径排序后，每行为 `相对路径\t文件SHA256\n`，再对完整清单求 SHA256。

## 为什么不直接复用现有读取器

以下客户代码位置来自本机 0.4.5 参考；服务端位置来自本批 U2 基点，不能据此推断生产 schema 或权限行为。

| 已核验入口 | 接入风险 |
| --- | --- |
| `utils/platform/record-envelope.js:284 serializeRecordEnvelope` | 白名单没有顶层 tenant/task/execution、snapshot 或 recordVersion；meta 旁证不是强制归属契约 |
| `utils/capture-sync.js:1450` 去重及 `:1767` trace 合并 | platform+note/url 跨池去重，新 run 的 trace 可以写入旧 record.id，不能把最新 trace 当不可变历史归属 |
| `utils/task-context.js:56 / :81 / :114` | 本地 task/correlation ID 会归一化且可回退 lastTaskContext，不等于可信服务端执行身份 |
| `utils/storage.js:606 getDataPool` | 读取全池、逐条归一化；发现重复 ID 会修复并写回 |
| `utils/storage.js:1057 getRecord` | 调用全池读取后 find，不是持久化单条查询 |
| `utils/storage.js:128 getItem` | 读取异常返回 null，后续可变成空池；新 source 必须明确失败，不能伪装无结果 |
| `background.js:1968 readTaskLedger` / `onstarvoice:get-task-ledger` | 会重建/协调运行并写回，不能因消息叫“get”就当只读源 |
| `background.js:2371 ensureCloudTaskAgentScope` | 会改变节点 scope、清理 command/archive，不是无副作用权限检查 |
| `server/routes/records.js:174`、`server/routes/user.js:67` | tenant-only 的整行列表，count/rows 分开查询，没有 U2 执行范围及跨请求结果快照 |
| `server/services/record-store.js:661 / :830` | 部分 observation 有严格来源，缺失时为 null；不能用标题/时间/关键词补造。写入时“当前 attempt/分配”验证器不能直接用于历史读取，否则重派后会误隐藏旧证据 |
| `server/routes/capture-cloud.js:5853 / :8455` | overview GET 会协调过期命令；任务 snapshots 是 progress/checkpoint，不是结果正文快照 |
| `server/routes/sync.js:477` | 客户 recordId 与 backendRecordId 是两个命名空间；服务器记录也不能证明客户本地已确认 |
| `server/middleware/auth.js:255` | 旧授权回退路径可更新过期激活码，不应无审查地接入严格只读 source |

本批的负对照测试直接使用既有序列化器；读取器则在仅含人工数据、内存存储桩的 VM 中执行原函数体，验证上述整池处理、ID 修复写回和读取失败空池现象。它不是浏览器实测，也没有执行客户数据写入。

## 新接口及独立边界

```text
可信新 manifest（已由供给方核实 scope / namespace / 版本与成员关系）
  → buildResultCatalog：一次建立轻量全量摘要索引、全范围 ID 唯一性校验
  → createSnapshotResultSource
      ├─ authorize：读取前许可
      ├─ 摘要切片 / 按 ID + recordVersion 延迟加载一条详情
      └─ authorize：读取后许可 + 同一授权世代 + 有效期复核
  → U2 会话的范围/快照校验、取消与迟到结果隔离
  → 未来独立视图（本批不实现）
```

### 轻量目录

`buildResultCatalog(manifest)` 接收：

```js
{
  scope: { tenantId, taskId, executionId },
  snapshotId,
  recordNamespace: 'client_record', // 或 server_record；不能混用
  entries: [{ recordId, recordVersion, summary }]
}
```

- scope、snapshot 和 recordVersion 使用 U2 的精确新契约；recordId 使用 U1 精确契约。没有 trim、截断 ID、按时间戳推断版本或按当前账号补归属。
- 整个 manifest 最多 10,000 条，是本批明确的内存工作上限，不是存储扩容。任何缺失/无效/重复 ID（包括跨页）都拒绝整个目录，不偷偷修复、丢行或挑一条。
- 只复制摘要白名单，不保存原对象、正文、评论或原始信封；冻结新副本，不冻结调用方对象。无效状态类型/访问器拒绝，不把未知或矛盾变成成功。
- 初始化遍历全部轻量摘要一次；随后 all/attention 分页只切既有索引，最多 50 条，详情 ID 用 Map 精确查找。测试覆盖 1,500 条及上限，不能把它称为客户现有持久化性能已经改善。
- attention 暂时严格遵循 U1 的 `needsAttention` 技术语义，含“证据未知”。它不是任务 `needs_action`、用户必须操作或允许重试的标志，不能直接决定新 UI 的“需处理”页。

### 授权和详情能力

`createSnapshotResultSource({ manifest, authorize, loadDetail, now? })` 返回 `readSummaryPage / readRecordDetail / close`，两种读取可直接供 U2 调用。

`authorize({ scope, snapshotId, recordNamespace, signal })` 的可信适配器必须给出：

```js
{ allowed: true, scope, snapshotId, recordNamespace, accessRevision, expiresAt }
```

- 每次读取都重新获取前后两份许可，不缓存授权；必须同 scope、快照、命名空间和 accessRevision，两份许可在最终发布时都仍有效。
- accessRevision 必须来自可信账户/授权世代。切账户、撤权或权限改变必须改变它；简单返回当前时间、固定字符串、激活状态或客户端请求回声不满足责任。
- 这是**检查可信许可的生命周期接口**，不是实际登录/鉴权协议，不把 `allowed:true` 当加密签名或成员关系证明。
- 首次许可不成立时不调用详情 loader。异常、过期、错配、未知记录、无效 signal 统一拒绝 `Error('Result read unavailable')`，无原始错误、许可对象或部分数据；U2 会显示稳定的读取失败状态。
- loadDetail 参数为 `{ scope, snapshotId, recordNamespace, recordId, recordVersion, signal }`，必须按这些精确绑定读取；回包带同一组绑定及规范 detail。不能悄悄降级为最新记录。
- 首次许可及详情绑定成立后，立即生成有界独立冻结投影；二次授权后再检查原信封的身份和版本，只发布先前投影。授权等待期间原对象的正文/评论变化不会渗入本次结果；版本变化则拒绝。
- 外部取消或 close 会立即拒绝本地 pending 读取，丢弃迟到返回并发送取消信号；close 释放本 source 的目录引用。可信函数若不合作，无法强制停止其内部工作；本 source 无单独超时，U2 的超时通过 signal 传入。
- 最终消费者仍要在更新前执行 U2 `isCurrent`；账户/任务切换时同时关闭 U2 会话和 U3 source。两次授权不是实时撤销订阅，已经交出的 DTO 无法事后追回，也不能中断同步阻塞代码。

## 真实接线尚待补齐

1. 明确服务端、客户端、手工任务与 monitor 的 ID 命名空间。历史服务器来源应沿 observation 关联的 attempt 核验父任务/子执行，而不是拿当前分配字段反推历史。
2. 实现真正只读的授权适配器和许可世代；本轮没有新路由、认证协议或真实凭据调用。
3. 为 manifest、单条详情建立真实一致快照/修订供给；本批只拒绝错配，不能替供应方证明版本真实性。
4. 为归属不足的旧记录制定证据核对方案，保持旧数据不变；不能自动归到当前租户/任务，不能按未知状态自动重采或删除。
5. 新旧基线归并和客户包切换独立审批。PR #37 的 Cron 收尾、其他 E1 候选均不因 U3 自动合并或启用。

## UIUX 交付接收记录（尚未实施视图）

本轮收到「重新设计 Extension UIUX」的交付通知，并读取了该任务最新用户要求与完成回复；用户要求标准单选/多选体验及功能完整。设计任务交付的交互参考文件已确认存在，Figma 原生画板尚未在本任务视觉验收，不能把接收通知当成最终业务验收。

- Figma 新候选页：[第 7 页，候选 A](https://www.figma.com/design/jk1NmFyzAWdBQROUU9nSYI/StarVoice-Extension-UIUX-Redesign-%E2%80%94-3-Directions?node-id=21-2&p=f)。交付方报告约 40 个页面/状态，白色 + Logo 蓝、底部导航，旧页面保留；本批没有改它们。
- 本地参考：`/Users/dulaidila/.codex/visualizations/2026/08/18/01a0133f-f6cf-78e3-99d0-ee9b01e3a449/extension-ui-direction-a-complete/index.html`。
- 下一批接口对照重点：历史 unknown 与必须操作分开；微博的已有标签映射与实际搜索能力分开；收藏/分享/转发/粉丝指标尚未进入 U1；stopping 要有命令证据；allowedActions 不从展示状态推导；双端确认必须有真实对应回执。

独立视图接入是后续批次，不在 U3 偷偷新增界面、取消平台等待、执行命令或替换旧侧栏。新模块不是 UI/全部共同代码区分或权属审查完成的证明。

## 验证状态

本地验证已完成：

- 新增目录测试 26、许可/数据源与 U2 组合测试 100、旧路径负对照 5，合计 **131 项**。
- Node 24.12.0 / Node 18.20.8 全量各 **2202/2202**，零失败/跳过/取消。日志：`/tmp/onstarvoice-u3-node24-final-20260906.log`、`/tmp/onstarvoice-u3-node18-final-20260906.log`。
- 独立审阅复现并推动修复详情共享对象变异和投影时版本切换窗口；二次授权后只发布先前冻结投影，版本变化拒绝。
- 静态边界检查 9 个模块通过（core-only），仓库卫生检查 753 文件及 diff 空白检查通过。
- 本候选 95 文件快照与 U2 逐字节一致，版本仍 0.4.3，清单摘要 `c5040350bd8f8731c5375b958f7147b76c3b65c9c580c49fba504ea3cd28c0c2`。
- 客户参考 95 文件仍为 0.4.5，清单摘要与本批开始时一致。运行源码、服务端、构建和 CI 脚本均无差异；未生成 ZIP、未加载浏览器 Extension。

远端精确提交及 Draft CI 为提交后的独立门槛，实际状态以交付报告为准；不以这些检查替代浏览器、长时采集、生产或客户验收。
