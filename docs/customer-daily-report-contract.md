# 客户日报实现接口

当前统计口径：客户工作日，采用中国法定节假日及调休安排。

## 服务边界

- `customer-daily-business-period.js`: `customerDailyBusinessPeriod(date?,now?,config?)` 计算客户工作日、跨夜采集区间、MTD 归属区间和日历版本。新日报采用当天正式版；休息日合并至下个工作日，不单独生成。
- `china-work-calendar.js`: 读取 `server/assets/calendar/` 中国务院通知对应的年度快照；同时识别法定假期与周末补班。当前包含 2025、2026 年，后续年度按官方通知更新文件及年度注册。运行时不依赖第三方网络查询，缺失年份明确提示待更新，不推测工作日。
- `customer-daily-report-data.js`: `collectCustomerDailyReport({tenantId,date,now,db,businessPeriod})`，db 为 transaction/queryAll/queryOne 对象，返回下述 snapshot。生产服务传入工作日区间；`dailyPeriod(date?,now?)` 保留旧自然日格式用于旧记录日期校验及兼容调用。`renderCustomerDailyReportHtml(snapshot)`、`renderCustomerDailyReportText(snapshot)`、`buildCustomerDailyReportWorkbook(snapshot)` 返回 ExcelJS workbook。
- `customer-daily-reports.js`: 版本保存、配置、文档/消息独立交付状态、任务调度；负责把 id/version 加到 snapshot，并冻结。
- `customer-daily-report-presentation.js` 统一标题、平台、较昨日及汇总值；`customer-daily-report-image.js` 使用随包字体和 resvg 生成表格 PNG；`feishu-daily-report-message.js` 生成含图片、原帖链接及文档链接的富文本消息。
- `feishu-daily-report.js`: `createFeishuDailyClient(config,{fetchImpl}?)` 返回 `createDocument({title}) => {documentId,url}`, `writeDocument({documentId,snapshot,onProgress,progress}) => progress`, `ensureEditable({documentId})`, `sendReport({documentUrl,snapshot,uuid}) => {messageId}`。**每个远端写入前/后由 service 持久化阶段；不确定结果抛出带 ambiguous=true 的安全错误；普通已知失败可重试。**文档内容写入逐步 checkpoint，安全恢复不能改写已经交付的客户文档。详细 API 如需调整先沟通。

## Snapshot JSON v1

```
{ id?, version?, schemaVersion: 1, tenantId, tenantName, reportDate, mode,
  periodStart, cutoffAt, assessedAt, monthStart, heatStart,
  collectionStartAt?, collectionEndAt?, collectionCutoffAt?, collectionBoundaryTime?,
  previousWorkDate?, handlingStartAt?, calendarRevision?, reportBasis?: 'customer_workday_v1',
  summary: {day: Counts, mtd: Counts},
  highHeat: Post[], coldMarked: Post[],
  warnings: [{code, message, blocking: boolean}],
  evidence: {...} }
Counts = {monitor, sdb, positive, neutral, negative, cold, inProgress:number|null, processed:number|null, unclassified, nonMonitor}
Post = {recordId,title,platform,url, heat?,observedAt?,comparisonText?,previousHeat?,previousObservedAt?,markedAt?,stale?,status?,isHistorical?:boolean}
```

Post保留平台代码，渲染显示中文。所有计数是number；未掌握列严格null。证据保存采集首次入库集合、状态、采用的观测与审计事件ID等。

## 采集与处理归属

- 采集以系统首次入库时间为准。默认切分时间为北京时间 18:00，可在设置调整；一个工作日的完整区间为上个工作日 18:00（含）至本工作日 18:00（不含）。例如普通周一包含周五晚及整个周末；2026-09-20 是调休上班的周日，正常单独出报。
- 当天生成仅包含生成时已经入库的帖子，之后至 18:00 的补采仍归当天，需要主动更新当天日报后交付，不自动移动到次日。生成后当天新标冷处理同样需要更新当天快照；已发送版本不随之后的数据变化而改写。此归属以入库时间窗口计算，不追溯迟到上传的任务原计划时间。
- 监控数量只计进入客户内容分诊清单的新帖子：`business_visibility=eligible`，且 AI 非 irrelevant 或该租户已关注。复采、巡查刷新、后续处理状态变化不增加监控数量。已归档帖子保留原采集贡献。SDB 再扣除 `reviewed_non_monitor`。
- 汇总情感和冷处理数量使用该采集集合在生成时的有效状态；客户的处理时间不移动帖子的采集归属。第三部分使用上个工作日次日零点至报表截止时间内的新冷处理事件，包含期间处理的旧帖，因此与汇总冷处理数量可能不同。
- 页面、Excel 和飞书标题统一为「监控汇总（本期新增）」及「本期冷处理负面帖：N 条（含历史帖 H 条）」。后者总数来自去重后的实际处理清单；历史帖以首次入库早于本日报采集区间起点判断，并在条目上标记「历史帖」。周末合并区间内的帖子仍属本期新增。旧快照没有归属字段时不推测历史数量，历史数为 0 时省略括号；不显示采集或处理时间。重复调整不重复计数，撤销冷处理的帖子移出清单。
- MTD 按日报所属月份累计采集窗口，月初第一份日报可包含上月末晚间及跨月假期；当期已生成版本保持冻结。重新生成明确生成新版本；自动任务优先复用已有客户版本，不覆盖手填或已交付飞书内容。
- 热度仍取近 7 天负面帖的有效观测，较昨日使用该帖昨天最后一次有效观测。新采集接受毫秒时间戳；已保存的旧完整服务端证据可只读恢复准确采集时间。缺项、保留值、无服务端证据的旧观测不生成涨跌百分比。

## HTTP API (`/api/customer-daily-reports`)

- `GET /?date=YYYY-MM-DD` => `{ok,reports:Report[]}` (date可省略，最近50版)
- `GET /calendar?date=YYYY-MM-DD` => `{ok,calendar:{defaultReportDate,isWorkingDay,nextWorkingDate,collectionBoundaryTime,revision}}`；默认当前工作日，休息日默认最近一个工作日，所选休息日另提示合并目标日期。
- `POST /generate {date?,requestId?}` => `{ok,report}`；生成新不可变版，不发送。requestId幂等。
- `GET /:id` => `{ok,report,html,text,messageHtml,messageText}`；后两字段仅含二、三部分，用于复制正文。`GET /:id/excel` => xlsx；`GET /:id/summary.png` => 带下载文件名的 PNG，均按租户校验会话。
- `POST /:id/summary {summary:{day?,mtd?},requestId}` => `{ok,report}`；只允许修改每行的 monitor/sdb/positive/neutral/cold/inProgress/processed。非负整数，最后两列可为 null。按日期锁保存新不可变版本，重复请求幂等，旧版本或并发冲突返回 409。snapshot 保留 systemSummary、summaryEdited、summaryEdit。保存不触发群发；导出、表格图片与飞书交付使用保存后的汇总。
- `POST /:id/document {allowIncomplete?:boolean}`、`POST /:id/send {allowIncomplete?:boolean}` => `{ok,report}`；入持久化队列并尝试交付，同步操作有时间上限，UI可轮询GET。重复发送同版同群幂等，不提供隐含重发。
- `GET /settings` => `{ok,settings:Settings}`；`PUT /settings` => 同上。secret不返回，仅 `hasAppSecret/hasWebhook/hasWebhookSecret`。只admin可改配置；writer可生成/发送。

Report = `{id,reportDate,mode,version,generatedAt,snapshot?,delivery?:{status,documentId?,documentUrl?,messageId?,sentAt?,error?,chatName?}}`；status none/queued/working/retry_wait/needs_attention/document_ready/sent。

Settings = `{appId,appSecret?(write only),folderToken,documentBaseUrl,channel:'app'|'webhook',chatId,chatName,webhookUrl?(write only),webhookSecret?(write only),editorType:'email'|'openid'|'openchat',editorId,customerEditVerified:boolean,autoEnabled:boolean,sendTime:'HH:mm',hasAppSecret?,hasWebhook?,hasWebhookSecret?}`。

默认appId空（页面提示可复用现有接入），文档域名须 https://*.feishu.cn，需用户明确目标目录，默认禁止全网编辑。editor用于明确外部客户成员/群编辑权限。customerEditVerified是开启自动发送前的真实账号人工验收，配置关键项变更自动清除。手动发送不受此标记拦截，创建文档及发送前仍通过飞书接口检查指定协作者编辑、跨组织与留存权限，失败不发群。appSecret按服务端独立环境密钥加密，不进入普通tenant_settings或日志。

Settings 另有 `collectionBoundaryTime:'HH:mm'`，默认 `18:00`。`calendarPendingYear:number|null` 和 `calendarError:string|null` 为调度只读提示，不能通过配置提交伪造或清除；等待补齐日历时 `nextRunAt` 为 null，库内保留的未完成游标不作为计划发送时间显示。

自动发送初次启用从下一次工作日发送时间开始，不回补历史；服务重启按持久化next_run_at补齐漏过的工作日。发送当天正式版，休息日跳过，调休工作日正常发送；已有发送中/已发送版本或客户手填版优先复用，旧实时版不阻止正式版。更新设置或另发群不会重新写已生成文档。缺失下一年度日历时保留未完成调度位置并提示更新，仍处理已知日期和其他已排队交付。

日报独立显示在数据看板左侧；设置移至系统设置。默认最新版本，界面隐藏历史列表；数据说明通过感叹号弹窗查看。客户输出无入库时间、测量质量与版本说明。有可比观测才显示涨跌，否则简短显示暂无对比数据。手填后主动更新数据需确认，自动任务保留最新手填汇总。

群消息采用 post 富文本：汇总 PNG、二/三帖子链接、可编辑文档链接。先上传图片，持久化 imageKey/imageHash 后再发群，重试复用同一图片；图片上传失败不尝试群发，消息结果不确定时禁止自动重发。完整列表保留在文档，超长消息明确提示剩余条数。
