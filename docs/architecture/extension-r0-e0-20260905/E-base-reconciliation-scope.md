# E-base：稳定修复与架构主线归并范围（只读候选）

日期：2026-09-05。已做 Git 历史、差异和模块归属核对，尚未创建功能归并提交、解决冲突、修改运行逻辑或验证真实客户环境。本文是下一批可审阅的范围，不是归并完成报告。

## 1. 输入事实和限制

- 架构主线：`51896d8694c4b19e3731e5b6b7623397420c84a9`。
- 与本机0.4.5交付95文件完全相等的源码：`85f8d797358e5aa2acf4db51ff1b3c57abe6c594`。
- 共同祖先：`9501925fea143a93ae33b31f019ee1ba978b1694`。
- 共同祖先之后，main 对生产脚本所覆盖的95个Extension源码文件无差异；hotfix分支有9个提交、47个变更路径。本机与main的9个Extension文件差异来自该hotfix链。

本机快照匹配不证明当前服务器也运行在该提交，更不能证明所有客户版本一致。以下是候选源码中的配套行为；功能实施前仍须核对正式发布记录和实际服务/客户端版本，不将Git分支名称当作生产证据。

## 2. 按最终行为归并，而非机械复制文件

| 行为组 | 来源提交 | main 对应承接位置与验证 |
|---|---|---|
| 无人值守完成闭环、精确request/Attempt自愈 | `2dea9ad8f1718c592c41fc1a24ca13fb274e3a79` | background、Sidebar，保留无人值守outbox及结束回传测试 |
| Debug可降级、BEGIN/END串行、旧Attempt不能回收新资源、精确恢复、Profile锁及worker/标签组 | `85f8d797358e5aa2acf4db51ff1b3c57abe6c594` | R0列出的9个扩展文件；配套debug/session/runtime/worker-order/tab-group/sidebar测试 |
| 本地关闭证明只作观测，分配/接力不因缺证明冻结；strict Attempt lineage与唯一记录冲突有限重放 | `f12e768bbb61ac4b21f53f3789fad77c95aa6b14` | 分配入口与`postgres-lease-reconciliation.js`、`postgres-cross-device-retry.js`；配套`record-store.js`、`sync.js`、`capture-safety-handoff-policy.js`、`capture-recovery-intents.js` |
| 已ACK但从未启动、心跳、产生执行Attempt的create允许过期重排 | `584993ec41be62505e1efbd7f00cc4631f6bb378` | `postgres-command-reconciliation.js`的资格判定/过期处理；保持架构application接口 |
| 技术失败不冷却整个Agent，单项/账号安全隔离保持 | `88b5f46de44162e96fea88180caf8e7e95c9aa2e` | capture-cloud技术hold和recovery metadata；不改变平台防风控等待 |
| 账户池技术失败后的有限第二轮；安全失败账号不再加入同item | `16b95e8449ef84ecb566dce3dd5432b030c5255b` | capture-cloud分配、`control-outcome-projection.js`预算/状态、capture-orchestrations重试分配 |
| 仅显示仍有效blocking command；去掉过时关闭证明导致的虚假告警，Ops基线与恢复展示一致 | `85f8d797358e5aa2acf4db51ff1b3c57abe6c594` | capture-orchestrations、ops-control、Admin recovery presentation和测试 |

文件名未带目录的服务端适配器位于 `server/modules/capture/infrastructure/`，`control-outcome-projection.js`位于`server/modules/capture/application/`。归并需按当前模块和事务边界承接，不能把旧hotfix路由直接替换到新架构。

hotfix链开头三项是 `dd59c0ab319182e624cc22669297791365a34060`、`a4c39432c70eaf330cea7ae6e93637fb75440944`、`396bcebbe8178acf0068697bd0a9189d7ca90eb7`。它们先处理旧版本关闭证明宽限，部分逻辑随后由f12e768替代。应核对85f8d79最终仍存在的行为，不能重放后停留在已经废弃的中间策略。

上述第二轮、关闭证明等都是两个候选源码之间已经存在的差异，不是本次提出的新重试/安全策略。E-base必须明确采用哪一份已验证发布行为及其配套保护；若真实运行证据不一致，停止归并并重新定位基线。

## 3. 必须保住的架构成果

| 已合并批次 | 保留内容 |
|---|---|
| PR #30 | automatic-recovery application和真实PostgreSQL恢复证据 |
| PR #31 | control-outcome projection、lease reconciliation、local-closure infrastructure边界；已失效行为可按完整稳定修复替换，但不回退结构 |
| PR #32 | command/profile reconciliation application与PostgreSQL adapter |
| PR #33 | cross-device retry和resource admission边界 |
| PR #34 | Agent execution-slot→source→parent→item/Attempt的锁序、快照重校验及死锁回归 |
| PR #35 | 0.4.3与架构main的已完成归并历史 |
| PR #36 | Agent→subscription→execution；终态item/Attempt→subscription→execution；旧Monitor finish的任务归属保护 |

整棵85f8d79源码覆盖main还会丢失更早的迁移/maintenance治理和拓扑演练，因此该操作不属于建议方案。PR #37继续独立Draft；不把其未合并改动提前塞入E-base，也不移动PR #29。

## 4. 不能拆开的保护组合

1. Extension9文件与配套服务端分配/回传语义要在同一兼容性矩阵中验证。单换扩展会保留架构main的旧关闭证明分配阻断；存在完成一条后不再分配的风险。
2. 替换关闭证明阻断时，要同时保留strict Attempt、requestHash、assignment revision、execution lineage、409 stale_attempt及记录唯一冲突重放。不能单独删门禁来提速。
3. 同名路由/测试按行为归并，保留PR #31–#36模块和锁序。重点检查`server-capture-cloud-contract.test.mjs`、`cloud-task-orchestration-wiring.test.mjs`、`server-capture-orchestration-route.test.mjs`，不能以较新的文件日期决定覆盖。

## 5. 后续实施建议

先确认真实服务端/交付版本，再建立隔离E-base候选。分提交记录行为来源和测试证据，逐组移植到现有模块；测试修复与功能移植分开提交。运行完整双Node回归、真实PostgreSQL竞争/幂等矩阵、候选包/源码匹配及专用浏览器代表场景后，才能认为归并候选技术就绪。

归并通过前，E1只继续规格准备。归并候选不同时加入新UI、IndexedDB、删除共同代码或更改平台等待。后续Ready、合并、发布及客户更新仍由独立明确范围控制；全套CI通过本身不授权部署。
