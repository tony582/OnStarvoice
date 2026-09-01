# StarVoice 0.4 实施与验收方案（2026-08-31）

## 结论

0.4.0 本地实现已经完成，范围为三条并列 P0：

1. 小红书“原文”不再回放历史 `xsec` 链接，改由来源优先的在线 Agent 在其当前登录 Chrome Profile 内实时重搜、按笔记 ID 精确核对并本地打开。
2. AI 相关性从单纯列表预筛升级为“列表判断 → 最小详情二判 → 完整增强”的分级链路；过滤和延后记录留存审计，但不进入正常业务视图和后续普通 AI/媒体增强。
3. 浏览器 Debug 占用拆分为 StarVoice 活跃、StarVoice 已确认陈旧、外部调试器和未知占用；仅自动回收证据确认的自有陈旧会话，其余保留现场并把云端工作项交回空闲 Agent。

当前状态是“代码、迁移、构建和安装包均已在独立工作树验证”，不是“已部署”或“生产验收完成”。

## 一、故障原因与修复边界

### 1. 小红书原文链接

已确认两条现场记录：

- `6a942033000000002102f2fa`（成都来源）；
- `6a94c7c3000000002003b809`（重庆来源）。

二者在相应 Chrome Profile 已登录的前提下仍返回 `300031`。因此根因不是“未登录”或“登录错账号”，而是产品把搜索卡片携带的短期、搜索上下文/Profile 相关 `xsec_token/xsec_source` 当成了永久链接。裸 `/explore/:id` 只是稳定身份，也不保证可直接浏览。

0.4 固定边界：

- 服务端与管理端只保存、展示稳定笔记身份；
- 管理端不再为小红书渲染历史直链；
- 分诊、记录详情、数据表、爆款、监测命中、事件、误判、客服工单、官方巡查与舆情样本统一复用实时来源动作；
- 用户点击“原文”后，服务端只下发 `recordId/externalId/标题/原采集词`；
- Agent 最多尝试标题和原采集词两个有界搜索上下文；
- 只有搜索卡片笔记 ID 与目标 `externalId` 完全一致且获得当次新鲜 `xsec_token`，才在该 Agent 本地导航；
- `xsec` 不回传管理 API、不进入任务结果、不落入普通审计或 canonical URL；
- 登录失效、安全验证、未命中、`300031`、身份不一致或页面无法核验时均失败关闭，并保留搜索页供人工确认，不能伪报成功。

### 2. AI 相关性与业务污染

旧链路只有列表判断。`need_detail`、低置信度和模型异常大量直接进入详情、评论、作者主页及后置 AI；已经跳过增强的基础记录仍可能进入内容分诊和统计。

0.4 固定处置：

| 条件 | 浏览器动作 | 业务可见性 |
|---|---|---|
| 列表高置信无关且无保护信号 | 不开详情 | `filtered_out` |
| 列表证据不足或 `need_detail` | 只读取标题、作者、正文、标签、OCR、逐字稿等最小详情 | 二判后决定 |
| 最小详情二判无关 | 停止评论和作者增强 | `filtered_out` |
| 相关、不确定或命中风险/投诉/救援等保护信号 | 完整增强 | `eligible` |
| 主备模型均异常且无保护信号 | 不无限量完整采集；仅按 10%、每批最多 3 条抽样，其余延后 | `deferred` |

`filtered_out/deferred` 不删除记录。候选身份、来源关键词、模型版本、判断依据、父子决策和最小详情继续用于审计与恢复，但不进入：

- 内容分诊、待处理队列和导出；
- 负面巡查、告警、评论线索；
- 工作台 KPI、关键词、监测命中、情感/平台分布；
- 月报、数据看板和舆情分析；
- 普通记录 AI 打标、AI failover 待处理队列；
- 封面和正文图片异步落地。

数据库迁移：`078_relevance_disposition_v2.sql`。迁移只投影历史记录中已有明确处置证据的行；不根据模糊历史字段推断并隐藏内容，也不删除数据。

### 3. Debug 占用与错误接力

旧链路把多种占用统一压成 `capture_task_debug_busy`，导致服务端无法判断是否能清理，也容易让一个本可换节点的工作项停在原 Agent。

0.4 分类：

| 分类 | 自动行为 |
|---|---|
| `starvoice_active` | 不清理，保留当前运行；云端工作项释放给其他空闲 Agent |
| `starvoice_stale_recovered` | 仅在旧 owner 已终态且精确资源证据闭环后，定点回收并继续一次 |
| `external_debugger` | 不 detach 用户 DevTools/其他扩展，保留页面并换 Agent |
| `unknown_occupancy` | 保守不清理，保留页面并换 Agent |

这些错误属于弹性 Agent 容量，不消耗业务重试预算，也不会把父任务转成人工阻断。Sidebar 收到此类云任务失败时不在原机自旋重试，不关闭用户当前页面。

## 二、主要实现位置

小红书实时打开：

- `server/services/xhs-source-open.js`
- `server/routes/triage.js`
- `server/routes/capture-cloud.js`
- `background.js`
- `content-v2.js`
- `utils/capture/keyword-search.js`
- `utils/cloud-task-agent.js`
- `web/admin/src/components/shared/RecordSourceAction.tsx`

AI 二判与业务可见性：

- `server/db/migrations/078_relevance_disposition_v2.sql`
- `server/services/relevance-prefilter.js`
- `utils/capture/relevance-prefilter.js`
- `utils/capture-sync.js`
- `server/services/record-store.js`
- 内容分诊、负面巡查、线索、工作台、告警、报告和 AI worker 查询

Debug 归因与改派：

- `utils/capture/debug-session.js`
- `background.js`
- `sidebar/sidebar-logic.js`
- `server/routes/capture-cloud.js`

版本面：

- Extension manifest：`0.4.0`
- 服务端运行基线：`0.4.0`
- 更新清单：`0.4.0 / 2026-08-31`
- 安装包名：`StarVoice-extension-v0.4.0-20260831.zip`

## 三、验证结果

已完成：

- Node 全量回归：`1627/1627`；
- PostgreSQL 集成：`24/24`，包含从空库执行全部非破坏性迁移、重复执行幂等，以及小红书来源 Agent 优先与命令载荷脱敏；
- 管理后台：TypeScript 与 Vite production build 通过；
- Extension：生产目标快照校验通过，95 个构建文件；
- ZIP：108 个条目，Manifest `0.4.0`，运行时 API 为 `https://voice.minilife.online`，禁止交付文件检查通过；
- `git diff --check` 与相关 JavaScript 语法检查通过。

本地交付包：

- `release/StarVoice-extension-v0.4.0-20260831.zip`
- SHA-256：`e453a4b792d91fa6dafe391dbcf057b45a9a82313e482536b8b7e413b0c85069`

## 四、生产发布顺序

以下步骤需要单独的生产变更授权，本次未执行：

1. 备份数据库并部署包含 078 的服务端版本；执行非破坏性迁移。
2. 部署管理后台和 API，确认旧 0.3.x Agent 仍可正常心跳与执行原任务。
3. 上传 0.4.0 ZIP 到更新清单声明的下载位置并核对线上 SHA-256。
4. 先只升级“重庆”小红书 Profile 对应 Agent，确认心跳出现 `xiaohongshuSourceOpenV1=true`。
5. 用记录 `6a94c7c3000000002003b809` 做单点验收；通过后再升级其余 Agent。
6. 观察 AI `filtered_out/deferred` 数量、二判命中率、Debug 四类占用及 Agent 改派情况，再扩大范围。

## 五、“重庆”Profile 验收口径

必须在用户指定的“另外一个 Chrome 账号/重庆 Profile”完成，不得用其他 Chrome 代替：

1. 该 Profile 安装并重新加载 0.4.0 Extension；
2. 后台 Agent 心跳显示版本 0.4.0、在线、空闲、具备小红书实时打开能力；
3. 管理端点击目标记录“原文”，任务应优先分配到原来源 Agent；
4. Agent 打开搜索页，先按标题、必要时按原采集词搜索，并按 `6a94c7c3000000002003b809` 精确匹配；
5. 命中后在同一 Profile 打开当次新链接，最终页面身份一致且不出现 `300031`；
6. 管理端只看到 opened/失败状态和 Agent 名称，响应与日志中不能出现 `xsec_token`；
7. 未命中或仍被平台拦截时必须明确失败并停在搜索页，不能再次跳到历史 404 链接。

只有第 1—7 条在生产真实 Profile 中通过，才可把“小红书原文修复”标记为生产验收完成。

## 六、回滚边界

- Extension 可回滚到 0.3.99；服务端会因缺少 `xiaohongshuSourceOpenV1` 能力而拒绝实时打开，不会把旧 token 重新暴露为 href。
- 078 新增列和决策台账保留，不做破坏性回滚。回滚应用代码后默认 `eligible` 可保持旧行为兼容。
- 不回滚、不覆盖 2026-08-31 已完成的 619 条历史 URL 上下文回填；该回填有独立备份，但它不是本修复的运行依赖。
- 外部 DevTools 或未知 Debug owner 永远不属于自动清理范围。
