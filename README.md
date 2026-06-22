# StarVoice 星语 · 舆情监控 SaaS

面向 **上汽通用 / 安吉星** 的多租户社媒舆情监控平台:Chrome 扩展采集小红书 / 抖音 / 微博内容与评论 → 后端 AI 研判、分诊、客资、工单、报告 → Web 后台运营。

> 部署/运维细节见 [`deploy/DEPLOY.md`](deploy/DEPLOY.md);本文是架构与开发总览。

---

## 1. 架构总览

```
┌──────────────────────┐   采集(作品/评论/账号)   ┌───────────────────────────┐   REST   ┌─────────────────────┐
│  Chrome 扩展          │ ───────────────────────▶ │  后端 Express + PostgreSQL │ ◀──────▶ │  Web 后台 (React)    │
│  (MediaClaw fork)     │     POST /api/sync         │  AI 研判 / 分诊 / 报告      │          │  舆情工作台 / 指挥中心 │
│  小红书 抖音 微博      │                            │  cron 定时(标注/报表)      │          │                     │
└──────────────────────┘                            └───────────────────────────┘          └─────────────────────┘
                                                              │ LLM (DeepSeek / 通义千问 / Gemini …)
                                                              │ 百炼 ASR(视频逐字稿)
```

- **扩展(采集端)**:`manifest.json` + `utils/` + `sidebar/`(源码在仓库根目录),实际加载的是手动快照 `extension-build/`(见 §6)。
- **后端**:`server/`,Express + PostgreSQL,`server/index.js` 启动,`server/routes/*` 提供 API,`server/services/*` 是业务逻辑,`server/cron.js` 跑定时任务。
- **后台**:`web/admin/`(React + TS + Tailwind + Vite),运营人员用;`web/dashboard/` 是另一套轻量看板。
- **多租户**:一套部署服务多个品牌方(安吉星 / OnStar / …),数据按 `tenant_id` 隔离。

---

## 2. 核心数据流

```
扩展采集 ──POST /api/sync(单条)或 /api/sync/batch(多条)──▶ normalizeRecord 归一化
   └─ upsertCapturedRecord            写 records(作品/帖子)
   └─ 评论 commentsCleanedItems        upsertRecordComments(见 §3.3)
        │
        ▼ 异步
   AI 标注 labelRecord(record)         relevance / sentiment / intent / category / source_type → records.ai_result
        │
        ▼ 据相关性 + 负评 + 官方响应
   进入「内容分诊」队列(triage.js 的 ACTIVE_QUEUE_CONDITION)
   评论生成「销售客资」(comment_leads,AI 判购买意向)
   触发「预警」(alerts)、聚类成「事件」(issues)、转「工单」(tickets)
   定时产出「报告」(report_runs / report_snapshots,日/周/月 + 六维研判)
```

---

## 3. 关键子系统

### 3.1 多租户与权限(`server/middleware/auth.js`)
- 会话:cookie `osv_session` 或 header `x-session-token`;租户:header `x-tenant-id`。
- 角色:`tenant_admin` / `tenant_analyst`(可写),平台内部角色可跨租户;`requireTenantAccess` / `requireTenantWriter` 守卫。
- **租户设置 `tenant_settings` 覆盖代码默认值**——例如品牌监控范围 `brand_business_context`、LLM 配置 `llm_*`、报表开关都是按租户存的,改"行为"优先改这里而非代码默认。

### 3.2 AI 研判(`server/services/ai-labeler.js`)
- 作品级:`labelRecord(id, {force})` → 相关性/情感/意向/分类/来源类型。`labelRecord` 默认跳过已标注记录,**重判存量要 `{force:true}`**。
- LLM 配置(按租户,`tenant_settings`):`llm_provider`(`deepseek`/`qianwen`/`openai`/`gemini`)、`llm_model`、`llm_api_key`。后台「AI 模型」卡片可配。
  - ⚠️ 服务器在**国内阿里云**,Google `gemini-*` 会被墙(实测 18s+ 超时),用 **DeepSeek** 或 **通义千问 qianwen(qwen3.x-flash)** 等国内可达模型;`qianwen` 走 DashScope 兼容地址(与服务器同云、秒回)。
- 品牌范围:安吉星监控范围是**整个上汽通用**(别克/凯迪拉克/雪佛兰 + 车机壁纸/周边),不止"安吉星"三个字。

### 3.3 评论采集与处理(`server/services/comment-workflow.js`)
**入库与 AI 解耦,两阶段**:
- **Phase A(同步,不调 LLM)**:评论用规则分类**立即入库、马上可见**,非官方评论标 `ai_classified_at = NULL`(待精炼)。
- **Phase B(后台,批量并行 LLM)**:`refineCommentsWithAI` 每 ~15s 捞待精炼评论,分批并发 AI 精炼回填、生成客资、重算负面数;**LLM 失败留待下轮重试,评论绝不丢成 0 条**。
- 自愈:`reprocessPendingComments` 启动后从 `records.payload` 补回漏入库的评论。
- 前台进度:`GET /api/workspace/processing` + `ProcessingBanner`(分诊页顶部进度条)。

### 3.4 监控与定时(`server/cron.js`)
- 每 10 分钟:`labelPendingRecords(20)` 标注积压;每 5 分钟:`enqueueDueMonitorExecutions` 排入到期监控;每分钟:`runConfiguredReports` 报表调度(按租户 `report_daily_time` 等)。
- 监控订阅 `monitor_subscriptions` + 执行 `monitor_executions`:按关键词/博主定时采集命中。

### 3.5 报告 / 逐字稿
- 报告:`server/services/report-generator.js`,日/周/月 + LLM 六维研判,地图(去南海诸岛 hover)/词云。
- 视频逐字稿:`transcription.js` + `dashscope-asr.js`(百炼 ASR)+ `transcript-analysis.js`,`asr-media-host.js` 临时公网托管媒体供百炼拉取。

---

## 4. 数据模型(主要表)
`records`(作品)· `record_comments`(评论)· `official_responses`(官方回复)· `comment_leads`(销售客资)· `record_triage`(分诊处置)· `alerts`(预警)· `issues`/`issue_records`(事件)· `tickets`(工单)· `report_runs`/`report_snapshots`(报告)· `monitor_subscriptions`/`monitor_executions`(监控)· `tenant_settings`/`official_accounts`/`tenants`(租户配置)。

迁移:`server/db/migrations/NNN_*.sql` 按序号执行(`server/db/migrate.js`,各包 BEGIN/COMMIT;含一次性 JS 钩子,以 `schema_migrations` 去重)。

---

## 5. 本地开发

```bash
# 后端(需本地 PostgreSQL,见 server/docker-compose.yml)
cd server && npm install && cp .env.example .env   # 配 DATABASE_URL / LLM_*;PORT 设 3001 对齐 admin 代理
node db/migrate.js && node index.js                # http://localhost:3001

# 后台(Vite,/api 代理到 :3001)
cd web/admin && npm install && npm run dev          # http://localhost:5173/admin
```
> ⚠️ 本机默认 Node v16,构建 admin 需 Node ≥18(deploy.sh 自动切 nvm v24)。

部署:`bash deploy/deploy.sh`(只发**后端 + admin 产物**到阿里云、跑迁移、pm2 重启;**不碰扩展**)。详见 [`deploy/DEPLOY.md`](deploy/DEPLOY.md)。

---

## 6. 扩展开发须知(重要)

- 扩展是 **MediaClaw 的 fork**,加入了若干本地补丁(搜「`本 fork 自加`」);合并上游时务必保留。
- **运行的是 `extension-build/` 这个手动快照,不是源码**。改完扩展源码(根目录 `utils/`、`sidebar/`、`manifest.json` 等)后必须:
  1. `rsync -a --exclude='.DS_Store' utils/ extension-build/utils/`(及其它改动文件);
  2. 用户在 `chrome://extensions` 点 **Reload**;
  3. **重新采集**才生效。`deploy.sh` 不部署扩展。
- 采集方式(扩展侧栏):**作品详情页**(单篇,带评论)/ **账号主页**(博主监控)/ **搜索页**(关键词)。「**采集增强**」会逐条打开详情页补采正文/互动/**评论**/客资;「评论加载上限」控制每帖采多少条评论。
- 给客户的扩展包:`zip` 打包 `extension-build/`(`*.zip` 已 gitignore),客户在开发者模式「加载已解压的扩展程序」。

---

## 7. 踩过的坑 / 注意事项

| 现象 | 根因 / 处理 |
|---|---|
| Gemini 调用超时 | 服务器在国内,Google 被墙。用 DeepSeek / 通义千问(同云)。 |
| 评论入库慢、大帖卡 0 | 旧版逐条 LLM 串行在一个事务里。已改 Phase A 快入库 + Phase B 批量并行精炼。 |
| 抖音发布时间显示成采集日 | 扩展读空 + 服务端回落被污染的 `lastEditedAt`。已改优先 API `create_time` + 正则兜底,服务端去掉 lastEditedAt 兜底。 |
| 抖音**图文**评论采不到 | 图文详情右侧「相关推荐 \| 评论」双 tab,评论容器折叠致被漏选、误滚推荐。已改容器评分锁定 `comment-list`。 |
| 抖音评论混入推荐/页脚 | 抖音采集只圈 `[data-e2e="comment-list"]`。 |
| 改了相关性范围不生效 | `brand_business_context` 是**租户设置**,覆盖代码默认。 |
| 重判存量记录没变化 | `labelRecord` 默认跳过已标注,要 `{force:true}`。 |
| 图文回复(子评论)采不全 | **待办**:「展开N条回复」未自动展开;滚动有时停太早。 |

---

## 8. 目录结构

```
manifest.json utils/ sidebar/ background.js content-*.js   扩展源码(根目录)
extension-build/                                            扩展手动快照(实际加载,gitignore)
server/
  index.js cron.js                                          启动 / 定时
  routes/        sync triage workspace records comments leads reports issues tickets monitor analytics …
  services/      ai-labeler comment-workflow report-generator transcription dashscope-asr alert-engine …
  db/migrations/ NNN_*.sql                                  迁移
web/admin/                                                  运营后台(React)
web/dashboard/                                              轻量看板
deploy/DEPLOY.md deploy.sh                                  部署
```
