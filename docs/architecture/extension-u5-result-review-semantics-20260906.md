# U5：历史未知、明确问题和介入报告的只读分类

日期：2026-09-06。基点为 Draft PR #52 / `22f50c650d9c33494a7a8b51d24b3829dc738927`。隔离分支 `codex/extension-u5-result-review-semantics-20260906`，工作目录 `OnStarvoice-extension-u5-20260906`。

## 目标与不变边界

此前兼容字段 `needsAttention` 混合了未知、停止、保存等待、失败与明确介入报告。直接把它标成“当前待处理”，会把大量缺少本次回执的历史记录变成人工待办。本批新增独立分类并贯通所有读取层，不改原有字段含义，不从结果快照推导执行权限。

只修改独立 `extension-ui` 领域模块、测试和说明。不修改旧 UI、采集/同步、认证、服务端、数据库或构建白名单。不调用真实客户数据，不新采集。Ready、合并、部署、迁移、split、客户 Extension 更新和处理 PR #29 仍禁止；只创建本批的堆叠 Draft，旧 PR 不动。

## 三个可同时成立的标记

`presentResult(summary)` 新增冻结字段：

```js
review: {
  unverified: false,
  hasIssue: false,
  interventionReported: false,
  reasons: [] // 冻结、固定词汇、固定顺序，最多五项
}
```

| 摘要信号 | unverified | hasIssue | interventionReported |
| --- | --- | --- | --- |
| 采集完成，服务器与本地均确认 | 否 | 否 | 否 |
| 历史同步状态存在，但缺少本次采集和回执证据 | 是 | 不据此推断 | 否 |
| 服务器未知、本地明确失败 | 是 | 是 | 否 |
| 服务器已确认、本地仍 pending | 否 | 否 | 否 |
| 采集 partial / failed | 不据此推断 | 是 | 否 |
| 采集明确 needs_action | 不据此推断 | 是 | 是 |
| 采集 stopped / cancelled，双端确认 | 否 | 否 | 否 |
| 明确 reconciliationRequired=true | 不据此推断 | 是 | 否 |
| reconciliationRequired 值不合法 | 是 | 不据此推断 | 否 |

每行只说明对应信号；其他信号仍独立参与。例如 needs_action 与未知回执并存时，三个标记可以全部为真。pending 只表示等待，不等于已成功，也不自行判定失败；是否等待超时应由具有时间和执行上下文的后续任务模型决定。

原因按身份、采集、服务器、本地、核对标志顺序生成：

- 身份无效：`invalid_record_identity`。
- 采集未知、不完整、失败、介入报告：`capture_unverified`、`capture_partial`、`capture_failed`、`capture_intervention_reported`。
- 双端逐项判断：`remote_unverified` / `local_unverified`，或 `remote_failure_reported` / `local_failure_reported`。
- 核对要求或其未知值：`reconciliation_required` / `reconciliation_unverified`。

这些是固定机器键，不是用户最终用语。它们只说明快照中的报告，不证明报告此刻仍适用。没有 `allowedActions`、`needsUserAction`、自动重试、重发、解除挂起或任务成功推断。当前有效人工待办还需新鲜执行身份、状态版本、范围和能力契约。

## 接线与兼容

1. `result-presenter` 一次读取 remote/local/reconciliation 原始字段，复用给旧展示状态和新 review。新分类不依赖旧 delivery 的优先级，因此未知远端不会盖住本地失败。保持旧 capture/delivery 文案和 needsAttention 完全不变。未来视图必须展示新 review 原因并明确“历史报告”，不能只画旧 delivery 标签或把旧 capture 文案当作当前任务指令，否则仍会漏显本地失败或误造待办。
2. `result-review` 统一五个精确筛选键及匹配谓词：`all`、`attention`、`unverified`、`issues`、`intervention`。不读取 getter、继承状态、正文或评论，不保留原输入对象。
3. `result-page` 对已授权轻量摘要先匹配再分页，保持旧接口的非法选项回退规则和最多 50 条限制。这仍是传入摘要的遍历，不是旧大数组存储的性能修复。
4. `result-catalog` 在有界 manifest 初始化时投影一次，为每个筛选建立独立的摘要引用索引。后续直接切片，不扫描正文或重复投影整个目录；不复制五份正文或保留原 provider 对象。沿用最多 10,000 条、精确 ID/版本、命名空间和快照限制。
5. `readQuery` 只新增三个合法键，显式非法值继续拒绝，不扩大查询。`decodeResultPage` 对收到的摘要重新投影并匹配，不信任源自填的 review、needsAttention 或 actions。范围、快照、查询回声、页面长度与详情身份检查不变。
6. U2 会话与 U3 源无需新增分支即可消费这些查询；U4 权限策略完全不修改。只读过期客户仍可读取符合范围的历史介入报告，但不能据此重新采集；冻结/撤权仍拒绝读取。

计数继续是 `{ all, attention, matching }`，没有增加全局当前待办计数。`all` 和 `attention` 筛选的 matching 与对应旧计数严格相等。三个新筛选是旧 attention 的子集，解码要求 `matching <= attention <= all`，并检查每一条可见记录确实命中该筛选。页长必须为 `min(limit, max(0, matching-offset))`。

三个新筛选不是互斥分区，不得相加。接收端只能证明当前页约束，不能仅凭一页数据验证未返回记录的全局计数；范围、状态真实性、全局索引与新鲜度仍由可信源负责。旧 attention 还可能包含 stopped 或本地待确认，故不要求它等于三个新筛选的并集。

历史适配器不变：旧 synced/draft/failed 及时间戳不恢复为当前回执或权限。它已有的明确核对标志可报告问题，但不表示用户此刻可以解除；缺证据不能自动变成失败。

## 验证与后续门槛

本批使用合成摘要与授权事实，本地验证已完成：

- 新增 **59/59** 项测试，Node 24.12.0 与 18.20.8 均通过。持久测试包含 4,032 组状态矩阵、1,500 条摘要分页、目录快照稳定性、页面防伪与恶意访问器；矩阵组合不另算测试数量。
- U4 到期策略 → U3 许可/快照源 → U2 筛选列表及详情读取的组合通过，冻结/撤权拒绝；没有执行采集命令或访问客户数据。
- 全量回归两套 Node 环境各 **2492/2492**，无失败、取消或跳过。日志：`/tmp/onstarvoice-u5-node24-final-20260906.log`、`/tmp/onstarvoice-u5-node18-final-20260906.log`。
- 独立只读审查无阻断发现，另以 5,145 组状态及 1,500 条摘要 × 105 组分页条件核对旧 attention 子集关系和新谓词。旧标签不能替代新原因展示的限制已纳入本契约。
- 静态边界 13 模块通过（core-only、无 UI 入口）；服务端语法及 diff 空白检查通过。运行源码、server、构建和 CI 脚本无变动。
- U5 隔离快照与 U4 相同：95 文件 / 0.4.3 / 清单 SHA256 `c5040350bd8f8731c5375b958f7147b76c3b65c9c580c49fba504ea3cd28c0c2`。
- 客户本机参考包未变：95 文件 / 0.4.5 / 清单 SHA256 `554479f7e01198ba0e6f7c2eb3d16e58c55db773aaadad90ecea5d6b039d1f87`。没有生成安装 ZIP、重载扩展或执行生产采集。

清单算法沿用 U3/U4：相对路径排序，每行 `路径\t文件SHA256\n`，再对完整清单求 SHA256。远端提交与 Draft CI 是提交后的独立门槛，实际结果以交付报告和 GitHub 检查为准。

仍未完成：真实状态供给方、任务进度/停止/当前介入命令契约、真实存储接线、视觉入口、浏览器交互与客户验收。该独立模块不是全部共同代码的替换，也不是 MediaClaw 权属或法律风险结论。隔离快照对照仅用于确认客户构建未包含新代码，不是生产运行版本证明。
