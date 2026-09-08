# 客户日报实现接口

开发分支：`codex/hotfix-customer-daily-report-20260908`，基线 `fd74954`。

## 服务边界

- `customer-daily-report-data.js`: `dailyPeriod(date?, now?)` 返回 `{reportDate, periodStart, cutoffAt, assessedAt, monthStart, heatStart, mode}` (ISO dates, mode formal/realtime). `collectCustomerDailyReport({tenantId,date,now,db})`，db 为 transaction/queryAll/queryOne 对象，返回下述 snapshot。`renderCustomerDailyReportHtml(snapshot)`、`renderCustomerDailyReportText(snapshot)`、`buildCustomerDailyReportWorkbook(snapshot)` 返回 ExcelJS workbook。
- `customer-daily-reports.js`: 版本保存、配置、文档/消息独立交付状态、任务调度；负责把 id/version 加到 snapshot，并冻结。
- `customer-daily-report-presentation.js` 统一标题、平台、较昨日及汇总值；`customer-daily-report-image.js` 使用随包字体和 resvg 生成表格 PNG；`feishu-daily-report-message.js` 生成含图片、原帖链接及文档链接的富文本消息。
- `feishu-daily-report.js`: `createFeishuDailyClient(config,{fetchImpl}?)` 返回 `createDocument({title}) => {documentId,url}`, `writeDocument({documentId,snapshot,onProgress,progress}) => progress`, `ensureEditable({documentId})`, `sendReport({documentUrl,snapshot,uuid}) => {messageId}`。**每个远端写入前/后由 service 持久化阶段；不确定结果抛出带 ambiguous=true 的安全错误；普通已知失败可重试。**文档内容写入逐步 checkpoint，安全恢复不能改写已经交付的客户文档。详细 API 如需调整先沟通。

## Snapshot JSON v1

```
{ id?, version?, schemaVersion: 1, tenantId, tenantName, reportDate, mode,
  periodStart, cutoffAt, assessedAt, monthStart, heatStart,
  summary: {day: Counts, mtd: Counts},
  highHeat: Post[], coldMarked: Post[],
  warnings: [{code, message, blocking: boolean}],
  evidence: {...} }
Counts = {monitor, sdb, positive, neutral, negative, cold, inProgress:number|null, processed:number|null, unclassified, nonMonitor}
Post = {recordId,title,platform,url, heat?,observedAt?,comparisonText?,previousHeat?,previousObservedAt?,markedAt?,stale?,status?}
```

Post保留平台代码，渲染显示中文。所有计数是number；未掌握列严格null。证据保存采集首次入库集合、状态、采用的观测与审计事件ID等。统计严格参照中文v4方案。

## HTTP API (`/api/customer-daily-reports`)

- `GET /?date=YYYY-MM-DD` => `{ok,reports:Report[]}` (date可省略，最近50版)
- `POST /generate {date?,requestId?}` => `{ok,report}`；生成新不可变版，不发送。requestId幂等。
- `GET /:id` => `{ok,report,html,text,messageHtml,messageText}`；后两字段仅含二、三部分，用于复制正文。`GET /:id/excel` => xlsx；`GET /:id/summary.png` => 带下载文件名的 PNG，均按租户校验会话。
- `POST /:id/summary {summary:{day?,mtd?},requestId}` => `{ok,report}`；只允许修改每行的 monitor/sdb/positive/neutral/cold/inProgress/processed。非负整数，最后两列可为 null。按日期锁保存新不可变版本，重复请求幂等，旧版本或并发冲突返回 409。snapshot 保留 systemSummary、summaryEdited、summaryEdit。保存不触发群发；导出、表格图片与飞书交付使用保存后的汇总。
- `POST /:id/document {allowIncomplete?:boolean}`、`POST /:id/send {allowIncomplete?:boolean}` => `{ok,report}`；入持久化队列并尝试交付，同步操作有时间上限，UI可轮询GET。重复发送同版同群幂等，不提供隐含重发。
- `GET /settings` => `{ok,settings:Settings}`；`PUT /settings` => 同上。secret不返回，仅 `hasAppSecret/hasWebhook/hasWebhookSecret`。只admin可改配置；writer可生成/发送。

Report = `{id,reportDate,mode,version,generatedAt,snapshot?,delivery?:{status,documentId?,documentUrl?,messageId?,sentAt?,error?,chatName?}}`；status none/queued/working/retry_wait/needs_attention/document_ready/sent。

Settings = `{appId,appSecret?(write only),folderToken,documentBaseUrl,channel:'app'|'webhook',chatId,chatName,webhookUrl?(write only),webhookSecret?(write only),editorType:'email'|'openid'|'openchat',editorId,customerEditVerified:boolean,autoEnabled:boolean,sendTime:'HH:mm',hasAppSecret?,hasWebhook?,hasWebhookSecret?}`。

默认appId空（页面提示可复用现有接入），文档域名须 https://*.feishu.cn，需用户明确目标目录，默认禁止全网编辑。editor用于明确外部客户成员/群编辑权限。customerEditVerified是开启自动发送前的真实账号人工验收，配置关键项变更自动清除。手动发送不受此标记拦截，创建文档及发送前仍通过飞书接口检查指定协作者编辑、跨组织与留存权限，失败不发群。appSecret按服务端独立环境密钥加密，不进入普通tenant_settings或日志。

自动发送初次启用从下一次发送时间开始，不回补历史；服务重启按持久化next_run_at补发漏过日期。默认前日正式版，已有当天手动发送正式版优先复用，实时版不阻止正式版。更新设置或另发群不会重新写已生成文档。

日报独立显示在数据看板左侧；设置移至系统设置。默认最新版本，界面隐藏历史列表；数据说明通过感叹号弹窗查看。客户输出无入库时间、测量质量与版本说明。有可比观测才显示涨跌，否则简短显示暂无对比数据。手填后主动更新数据需确认，自动任务保留最新手填汇总。

群消息采用 post 富文本：汇总 PNG、二/三帖子链接、可编辑文档链接。先上传图片，持久化 imageKey/imageHash 后再发群，重试复用同一图片；图片上传失败不尝试群发，消息结果不确定时禁止自动重发。完整列表保留在文档，超长消息明确提示剩余条数。
