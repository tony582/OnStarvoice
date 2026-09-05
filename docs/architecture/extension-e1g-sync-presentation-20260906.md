# E1g：同步状态展示解耦与待核对提示

日期：2026-09-06。**本轮是本地展示消费者准备；真实同步入口仍未开启核对挂起，不是端到端防重发或已发布修复。**

## 基点和允许范围

- 基于 E1f PR #45 的 `8d9670798662cc25f5aa8744a4f288de905e7e64`，隔离分支 `codex/extension-e1g-sync-presentation-20260906`；新 Draft PR 以 #45 分支为 base。
- main 为 `51896d8694c4b19e3731e5b6b7623397420c84a9`，PR #37–#45 不改。Cron 解耦 #37 仍单独保留。
- 运行范围：新 `utils/capture/streaming-sync-presentation.js` 与 `sidebar/sidebar-logic.js` 的导入、三函数提取、手动/批量最终提示分支。
- 不改 queue、capture-sync、storage、background、server、状态协议、权限、版本、采集规则、防风控等待或失败重试次数。真实 `createStreamingDetailAutoSyncQueue` 不传 `shouldHoldForReconciliation`。
- 不碰原客户目录、插件快照、浏览器配置。测试包不是客户更新；不 Ready、合并、部署、迁移、split 或处理 PR #29。

## 从大文件抽出的职责

新模块只负责纯数据到展示结果的映射，没有 import、浏览器、存储、网络或队列控制依赖：

| 函数 | 职责 |
| --- | --- |
| `isStreamingSyncReconciliationRequired` | 仅识别严格布尔 true，不把字符串、数字等当作新状态。 |
| `formatStreamingSyncSummary` | 原同步摘要；明确 hold 时改为待核对摘要，不再称为待上传或给重试提示。 |
| `buildStreamingSyncTaskIssue` | 原 blocked/incomplete 描述；hold 时返回独立 `STREAMING_SYNC_RECONCILIATION_REQUIRED` 描述。 |
| `buildStreamingSyncTaskMetadata` | 保留原六项统计；仅 hold 添加 `syncReconciliationRequired:true` 与 `syncDrainCompleted:false`。 |
| `buildStreamingSyncCompletionNotice` | 提取手动采集原成功通知判定；hold 只给 warning，不给已同步后台提示。 |

原 `appendStreamingSyncSummary` 仍留在 sidebar 作为读取队列统计的薄适配器。模块不读取/复制回执、编号数组或队列控制方法，不伪造成功计数或上传完成证据。`retryable:false` 是本地描述字段，不是已经生效的服务器派发约束。

非 hold 路径保持旧行为，包括 Number/String/Boolean 的原始转换和原提示文字。本轮不顺手修 NaN、普通同步失败仍可使用旧外层成功色等其他问题。输入来自当前 plain queue stats；不承诺带副作用 getter/Proxy 的读取顺序完全等价。

## 接入位置及保持不变的优先级

- 手动采集：同步成功 toast 统一使用新纯函数；hold 改为待核对 warning。已存在普通失败计数时保留 `completed_with_failures`，不把挂起项目补算成失败或成功。
- 手动循环结束：有 hold 不追加 success 色；原取消文字保留。
- 批量/循环/顺序搜索：摘要能展示待核对，hold 使用 warning。平台限制先于取消/循环/普通结束提示；取消仍显示已停止。
- 原 `streamingSyncDrained` 是“本地已调用 drain 路径”的 bookkeeping，不是上传完成证据。本轮不改它，也不改 E1f drain 返回的 `drainCompleted:false`。

## 还不能启用的原因

1. 本轮只准备显示层及本地 issue/metadata。batch 的 hold 仍依照旧分支返回 `ok:false`、`streamingSync`，但不返回 `error`；本地状态仍为 `completed_with_failures`。
2. 更外层 `runUnattendedKeywordPlanRequest` 仅在 `batchRunResult.ok === false` 且有 error 时抛错，最终还会根据关键词 checkpoint 的 failed/partial 决定状态。因此“没有成功 toast”不等于无人值守业务终态已统一识别 hold。
3. E1f 的上传清场证据仍拒绝有 hold 的 drain；即使外层文案/状态不完整，也不能据此宣布 business uploads cleared。但这不是已回收 runner 的证明。
4. 服务端弹性恢复可能继续把 `completed_with_failures` 投影为 retryable。只换 error code 或传 retryable:false 不足以保证云端不再派发；控制面适配需另列范围。
5. 真正远端 ACK / 本地确认失败尚需接入正文、客资、批内后项及定向/监控/手动入口；跨 MV3 回收、重启、租户/Attempt 切换仍需持久化与身份约束。不得用本地纯展示函数替代这些机制。

下一步先统一无人值守终态和剩余消费者的契约，再单独评审控制面恢复接入；在这些门禁补齐前，不打开真实 producer 的新选项。

## 验证记录

- Node 24.12.0 / 18.20.8 全量各 **1,976/1,976**，无失败、跳过或取消。新增 pure 14 项、实际 consumer 13 项；旧 wiring 测试只机械改变两处源码截断锚点，业务断言未删改。
- pure 差分覆盖 756 个计数/启用组合及 378 个 marker/blocked/error 组合，每个又检查六种 notice enabled 输入。冻结的旧函数与新的非 hold 输出一致；普通空值、primitive、负值、NaN 等旧边界保留。
- consumer 测试运行真实 manual/batch 终态片段和实际 drain，包含一条真实 hold 队列。相同 13 项移到 E1f 旧实现，在两个运行版本均为 7 个兼容通过、6 个预期 hold 差异失败，确认测试能识别能力缺失。
- 独立文本审阅：formatter/issue 去掉前置 hold 分支后与旧函数逐字相同；metadata 去掉尾部新字段后也相同。sidebar 排除允许修改区域后，其余 **1,026,637 字节**完全一致，SHA-256 `b7793bf3a96013dae84c932dc770539b4f9a75b1b6ed3ce7e8416d831884de61`。
- 既有浏览器夹具配对验证：E1f 基点 Chrome/Edge 各 **19/19**，E1g 候选各 **22/22**。新增检查覆盖模块加载/旧默认输出、hold 投影、实际 warning toast 的文字/样式/关闭。toast 使用本机注入统计，不是一次真实采集任务；实际 manual/batch 判定由上述 VM 测试验证。
- 浏览器临时 profile 已清理。默认拒绝代理阻止生产 HTTP(S) 更新请求，未观察到成功非回环连接；失败 IPv6 路由探针如实记录（-109、无发送字节），不宣称系统级零外连尝试。截图已查看。
- 候选插件快照 **99 文件 / 0.4.5**；比 E1f 98 文件只新增纯模块并改变 sidebar，其他文件 SHA-256 相同。原客户包与隔离旧基点 **95/95 文件一致**。仓库卫生与快照校验通过。
- 本地浏览器证据位于独立 QA 目录的 `output/playwright/e1g-{base-chrome,base-edge,chrome,edge}-run-1`，网络汇总 `e1g-final-network-audit.log`。没有客户业务、8 小时或 72 小时验收结论。

## 整体进度，不等同于发布进度

Extension 已完成一批职责提取、保存失败保护及待核对原型/队列/展示准备；同步生产者和全链路恢复仍未启用。UIUX 任务已有设计稿，本架构分支未实施整套界面替换。MediaClaw 相关共同模块已有替换清单，但五批独立实现尚未完成，移动函数不能算独立重写或权属问题已解决。后端 Cron #37 继续按独立授权关口收尾。所有候选只到 Draft，不影响客户当前使用版本。
