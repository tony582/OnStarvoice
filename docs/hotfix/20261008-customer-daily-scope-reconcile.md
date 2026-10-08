# 已发送 9 月日报与内容分诊对齐（客户准入覆盖 + 对齐脚本）

原则：日报是工作量，按处理日期；月报按发帖时间。两者数量天然不同，但已发送的 9 月日报已锁定，日报里算过的帖子必须在内容分诊里存在，并且处理记录落在它被算进去的那一天。

9/29 已发送的 v3 累计 3425 条，其中 294 条现在不在内容分诊主列表：293 条是无品牌证据的哨兵关键词帖（别克哨兵 203、至境哨兵 89、别克OTA 1）未过准入，1 条已归档（7 月发布，员工 9/7 归档，保持不动）。294 条 AI 分析（相关性、情感、摘要、意图、内容主题）齐全，不需要重判。

- `record-triage-admission.js` 新增显式准入覆盖 `manual_overrides.triage_admission = {value:'included', reason, source, reportId, reportDate, appliedAt}`：SQL 与 JS 准入都先看它，相关性判定不改，证据状态为 `customer_included`。
- `server/scripts/reconcile-customer-daily-scope.mjs --tenant 安吉星 --month 2026-09 [--apply]`：取该月最后一份已发送日报的 `evidence.monthRecords` 作为冻结集合；对不在当前范围的帖子加覆盖；无处理状态的 195 条写成已复核-非监控内容，`record_triage` 与审计变更记录的时间都落在该帖所属日报的报表日 09:30（北京时间，且不早于采集时间+10 分钟）；报表日优先取各日日报快照的 `dayRecordIds`（242 条），9/7 首份日报之前采集的 52 条按客户工作日窗口（上一工作日 18:00 至当日 18:00，休息日并入下一工作日）推算，两者不一致即中止；员工已处理的 98 条（75 非监控、23 已复核）只加覆盖、保留原状态和真实处理记录；已归档跳过；可重复执行。
- 审计动作仍是 `record.triage_updated`，所以内容分诊按「处理时间」筛 9 月能看到它们；时间不在 10 月，10 月 8 日起按处理日期统计的日报不会把它们算成当天工作量。另写一条 `customer_daily_reconcile` 汇总审计。

验证：`record-triage-admission-override.test.mjs`、真库集成 `customer-daily-reconcile.integration.mjs`（计划、写入、幂等、10/8 日报不受影响、9 月月报按非监控计入、分诊接口按 9 月处理日期命中、归档和未报送帖不动）、既有准入相关 29 项单元回归。发布：替换 `record-triage-admission.js`、新增脚本，重启后先 dry run 核对（预期 cohort 3425、范围外 294、导入 195、仅覆盖 98、跳过归档 1），再 `--apply`，最后在后台重新生成 9 月月报（预计平台监控量 3221 → 约 3490，新增部分全部计为非监控，SDB 不变）。
