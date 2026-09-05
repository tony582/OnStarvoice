# E1e：远端回执与本地确认的隔离契约

日期：2026-09-05。**未接入运行入口的可执行原型和现状测试，不是已经生效的同步修复。**

## 隔离基点与范围

- 基于 E1d PR #43：`c8f0a6cf01bf863b270fc90c1f4bbff059fc871a`；分支 `codex/extension-e1e-sync-confirmation-contract-20260905`，新 Draft PR 以 #43 分支为 base。
- main 仍为 `51896d8694c4b19e3731e5b6b7623397420c84a9`。不改变 PR #37–#43；Cron 解耦 #37 继续独立保留。
- 本轮只新增 `prototypes/extension-sync-confirmation/contract.mjs`、相关测试和本文档。原型不在构建脚本复制的 manifest/background/content/images/sidebar/utils 范围内，且现有运行源码不导入它。
- 不改采集、同步、队列、UI、服务端、数据库、状态格式、版本、权限、退避或防风控等待。原客户 checkout 与 Extension 快照不动。

## 为什么不能只在四处 ACK 后加失败判断

以下为精确基点 c8f0a6c 的源码事实，不是对生产事故的推断。

| 边界 | 现状与直接接线的风险 |
| --- | --- |
| capture-sync 的正文和客资提交 | `markRecordSynced` 读取后找不到记录的 false 被忽略；读取异常也可能表现为空，不能推断用户主动删除。真正拒写会抛错。客资 payload 的保存也承担确认作用，不能只覆盖四个标记调用。 |
| 单条异常返回 | `syncRecord` 的通用 catch 写 SYNC_ERROR，返回 unknown 类型和空 rawResponse；可能掩盖先前已经取得的远端成功。 |
| 批量异常返回 | 一个请求默认最多 5 条。B 的本地提交失败时，A–E 可能都已得到远端 ACK，只有 F 所在的下个请求尚未发送；不能把 C–E 划成“未开始”。 |
| streaming 包装与重试 | sidebar 的 createStreamingDetailAutoSyncQueue 包装把 blocked 覆盖为 phase===check；瞬时重试只检查文本特征，不读取 partialContentSuccess 或 retryable。 |
| dirty 重排 | utils/record-sync-queue.js 的 dirtyIds 重排独立于 shouldRetry；仅令一次普通重试返回 false 不等于禁止重排。 |
| 定向与监控 | cloud-targeted-post.applySyncResult 对非完整成功一律设置 retryable:true；监控按 !ok 记失败。partialContentSuccess 不是现有消费者认可的防重发契约。 |
| pending 范围 | maybeRunAutoSyncAfterDetailCapture 和 runSyncRecordBatch 先按 ID 存在筛选，随后可重置 DRAFT；syncScope:'pending' 本身不排除已同步记录。 |
| 服务端弹性恢复 | server/modules/capture/application/control-outcome-projection.js 的 projectElasticKeywordRecoveryStatus 会在预算内把非安全 failed/needs_action/completed_with_failures 投影为 retryable，不读取 error.retryable。 |

因此，直接返回普通失败、旧 syncPaused 或新字段 retryable:false，均不足以承诺所有入口不再自动发送。旧 syncPaused 表示远端不确定/限流且鼓励稍后继续，不能复用成“远端已确认，只待本地确认”。

## 本轮可执行契约的职责

原型只处理**调用方明确给定的、已关联到操作的证据**。每项操作同时有 operationId、recordId 和 content/comment_leads 阶段；同一记录的正文与客资不是同一次确认。operationId 是本原型的唯一键，不是已实现的服务器幂等键、Attempt fence 或 revision/CAS。

- 在尝试本地提交前，先保留整批远端结果，区分明确成功、明确失败、结果未知与未发送。
- 仅对明确 ACK 的操作调用注入的 commit；只有返回 true 才确认本地提交。false/异常立即停止后续 commit，保留当前项与同批后项的远端证据。
- 已确认的前项保留；同批已 ACK 但未尝试本地提交的后项，不得归入未发送。未知、未发送操作不伪造 ACK，不调用 commit。
- 返回独立确认账本，不冒充旧 ok/successCount/syncPaused 返回值。requiresReconciliation/blockAutomaticReplay 是将来调用方必须消费的契约信号，**目前没有改变任何生产重试行为**。
- localConfirmedCount 也包含远端明确失败后、成功保存本地失败态的操作，不能称作“同步成功数”。两个保护信号为 false 也不代表允许重放已确认操作。
- 原型没有网络派发能力，也没有浏览器存储依赖。commit 是测试/未来适配器注入点；内存中保留回执不等于成功持久化回执。
- 输入校验必须先于任何 commit；重复 operationId、未知状态或不完整身份不能产生半次写入。正文成功不证明客资成功；客资跳过、以前已同步不能伪装为本次新远端 ACK。

## 后续实际接线的分层门禁

1. **本地运行链**：正文与客资所有确认点一起接入；覆盖批内已 ACK、未提交、未知和未发送，以及保存前后异常。成功路径应保持现有结果与时序；失败返回保留远端证据，不退化成 SYNC_ERROR。
2. **所有本地消费者**：同步包装、普通重试、dirty 重排、定向/监控结果投影与手动入口统一认识“本地待确认”。验证过程中不得把新字段被丢弃解释为支持新契约。
3. **控制面协议与恢复策略**：明确该状态如何由 Extension 传到服务器，以及是否允许再次派发。涉及服务端恢复规则时单列评审和实施范围，不在本轮原型里偷偷改变。
4. **耐久性与竞争**：若要跨 MV3 回收、重启、租户切换、记录更新或跨设备保证不重发，需要另外设计回执持久化、幂等、版本/Attempt 绑定和原子提交；不能用 updatedAt 或同 ESM 队列替代。

所有阶段仍需隔离验证和独立发布授权。本轮不承诺跨任务/重启不重复，也不修改失败数据的清理政策。

## 验证记录

Node **24.12.0 / 18.20.8** 全量回归各 **1,924/1,924**，无失败、跳过或取消。新增 **28 项**：原型契约 10、真实旧链正常/缺陷特征 14、既有消费者边界 4。原有测试文件未改。

真实旧链测试调用实际 ESM syncRecord/syncRecordBatch/storage/api，Chrome storage 与 fetch 为内存替身；其中同组 6 条 fixture 验证仅 A–E 发送并获 ACK、B 本地拒写后只有 A 已同步、F 无请求、本组结构化结果/历史未形成。此类测试明确断言现有缺陷特征，作用是可重复证据，不是“修复已经通过”的测试。

消费者测试直接运行现有 streaming 包装/重试判定、record-sync-queue、定向投影和服务端纯恢复投影；证明新旗标被覆盖、dirty 重排独立于普通重试、retryable:false 不能阻止既有投影。没有实际发送或重新派发客户任务。

- 新隔离目录实际生成并校验 Extension 快照：E1e/E1d 均为 **98 文件，逐路径与 SHA-256 全部相同**。原型确实不进入插件包，manifest 仍为 **0.4.5**；原客户包与 QA 旧基点 **95/95** 逐文件不变。
- 本轮未重跑浏览器：生成包与上一轮 E1d 已验包逐字节一致，且没有运行入口接线。不能因此声称新确认保护已在 Chrome/Edge 生效。
- 独立审阅原型并运行输入预检、整批回执快照、严格 true、提交/调用方突变隔离、异常消息读取、正文/客资分离探针；现有 shipping 源文件对原型路径及 API 名称的引用为零。

本轮只到提交、普通推送、新建 Draft PR、等待 CI。禁止 Ready、合并、部署、生产迁移、split、客户 Extension 更新及处理 PR #29。Extension UIUX 和共同代码/素材权属工作仍独立，原型或重构均不能替代权属审查。
