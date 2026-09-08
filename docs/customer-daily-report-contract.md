# 客户日报实现接口

开发分支：`codex/hotfix-customer-daily-report-20260908`，基线 `fd74954`。

## 服务边界

- `customer-daily-report-data.js`: `dailyPeriod(date?, now?)` 返回 `{reportDate, periodStart, cutoffAt, assessedAt, monthStart, heatStart, mode}` (ISO dates, mode formal/realtime). `collectCustomerDailyReport({tenantId,date,now,db})`，db 为 transaction/queryAll/queryOne 对象，返回下述 snapshot。`renderCustomerDailyReportHtml(snapshot)`、`renderCustomerDailyReportText(snapshot)`、`buildCustomerDailyReportWorkbook(snapshot)` 返回 ExcelJS workbook。
- `customer-daily-reports.js`: 版本保存、配置、文档/消息独立交付状态、任务调度；负责把 id/version 加到 snapshot，并冻结。
- `feishu-daily-report.js`: `createFeishuDailyClient(config,{fetchImpl}?)` 返回 `createDocument({title}) => {documentId,url}`, `writeDocument({documentId,snapshot,onProgress,progress}) => progress`, `ensureEditable({documentId})`, `sendReport({documentUrl,snapshot,uuid}) => {messageId}`。**每个远端写入前/后由 service 持久化阶段；不确定结果抛出带 ambiguous=true 的安全错误；普通已知失败可重试。**文档内容写入逐步 checkpoint，安全恢复不能改写已经交付的客户文档。详细 API 如需调整先沟通。

## Snapshot JSON v1

```
{ id?, version?, schemaVersion: 1, tenantId, tenantName, reportDate, mode,
  periodStart, cutoffAt, assessedAt, monthStart, heatStart,
  summary: {day: Counts, mtd: Counts},
  highHeat: Post[], coldMarked: Post[],
  warnings: [{code, message, blocking: boolean}],
  evidence: {...} }
Counts = {monitor, sdb, positive, neutral, negative, cold, inProgress:null, processed:null, unclassified, nonMonitor}
Post = {recordId,title,platform,url, heat?,observedAt?,comparisonText?,previousHeat?,previousObservedAt?,markedAt?,stale?,status?}
```

Post保留平台代码，渲染显示中文。所有计数是number；未掌握列严格null。证据保存采集首次入库集合、状态、采用的观测与审计事件ID等。统计严格参照中文v4方案。

## HTTP API (`/api/customer-daily-reports`)

- `GET /?date=YYYY-MM-DD` => `{ok,reports:Report[]}` (date可省略，最近50版)
- `POST /generate {date?,requestId?}` => `{ok,report}`；生成新不可变版，不发送。requestId幂等。
- `GET /:id` => `{ok,report,html,text}`；`GET /:id/excel` => xlsx
- `POST /:id/document {allowIncomplete?:boolean}`、`POST /:id/send {allowIncomplete?:boolean}` => `{ok,report}`；入持久化队列并尝试交付，同步操作有时间上限，UI可轮询GET。重复发送同版同群幂等，不提供隐含重发。
- `GET /settings` => `{ok,settings:Settings}`；`PUT /settings` => 同上。secret不返回，仅 `hasAppSecret/hasWebhook/hasWebhookSecret`。只admin可改配置；writer可生成/发送。

Report = `{id,reportDate,mode,version,generatedAt,snapshot?,delivery?:{status,documentId?,documentUrl?,messageId?,sentAt?,error?,chatName?}}`；status none/queued/working/retry_wait/needs_attention/document_ready/sent。

Settings = `{appId,appSecret?(write only),folderToken,documentBaseUrl,channel:'app'|'webhook',chatId,chatName,webhookUrl?(write only),webhookSecret?(write only),editorType:'email'|'openid'|'openchat',editorId,customerEditVerified:boolean,autoEnabled:boolean,sendTime:'HH:mm',hasAppSecret?,hasWebhook?,hasWebhookSecret?}`。

默认appId空（页面提示可复用现有接入），文档域名须 https://*.feishu.cn，需用户明确目标目录，默认禁止全网编辑。editor用于明确外部客户成员/群编辑权限。customerEditVerified是一次真实账号测试的人工验收，配置关键项变更自动清除，正常每日不再人工验收。appSecret按服务端独立环境密钥加密，不进入普通tenant_settings或日志。

自动发送初次启用从下一次发送时间开始，不回补历史；服务重启按持久化next_run_at补发漏过日期。默认前日正式版，已有当天手动发送正式版优先复用，实时版不阻止正式版。更新设置或另发群不会重新写已生成文档。
