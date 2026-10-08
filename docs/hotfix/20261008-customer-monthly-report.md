# 客户月报（按发帖时间统计）首版

客户按「发布月份 + 内容分诊」核对数据，日报按处理日期统计无法对账。新增「客户月报」页签（客户日报右侧），按帖子发布时间（北京时间）归入月份，范围与内容分诊主列表一致（准入规则、有效相关性、关注例外、未归档、九种状态），同帖只计一次；SDB 扣除已复核-非监控内容；情感、处理状态与内容主题取生成时的有效结论。当前月为月初至生成时间。

月报内容：逐日发帖汇总（九列，与日报同列）、内容主题分布（七个客户主题 + 主题生成中）、平台分布、本月热度值≥200 的负面帖子（按最近一次采集的点赞、评论、收藏、分享合计，互动项缺失标为至少）、数据说明。每个版本冻结全部明细，可下载「月报 Excel」（汇总、内容主题、平台分布、高热负面帖、数据说明）和「明细 Excel」（发布时间、平台、标题、作者、情感、处理状态、内容主题、采集关键词、互动数、首次采集时间、原帖链接）。邮件沿用客户日报的收件人与 SMTP，附带两份 Excel，队列复用日报邮件实现（`customer_monthly_email_deliveries`，每分钟处理）。

实现：迁移 `092_customer_monthly_reports.sql`；服务 `customer-monthly-report-data.js`、`customer-monthly-report-render.js`、`customer-monthly-email.js`、`customer-monthly-reports.js`；路由 `/api/customer-monthly-reports`（settings、列表、generate、详情、excel、detail.xlsx、email）；后台 `CustomerMonthlyReport.tsx`，手机端「更多」加入入口。日报邮件服务改为可配置表名与主题（`kind`），默认行为不变。

未做：飞书文档/群发、自动定时发送、手填汇总、表格图片；月报不含评论记录。9 月月报的数量与 9 月日报累计不同，属口径差异（发布时间 + 内容分诊范围 vs 首次入库 + 数据底座范围）。

验证：`customer-monthly-report.test.mjs`、真库集成 `customer-monthly-report.integration.mjs`（生成、版本冻结、幂等、邮件队列、HTTP 导出与权限）、后台构建、Playwright `customer-monthly-ui.browser.mjs`。发布需跑迁移 092（启动自动应用），替换 server 与后台静态包。

## 发布记录（2026-10-08）

- 12:45 上传发布包到 `/opt/onstarvoice-private/releases/customer-monthly-0c56820-20261008/`（15 个 server 文件 + 后台 dist，SHA256SUMS 远端核对通过，生产 Node 18 语法检查通过）；发布前生产 `server/` 与 main@6ecdc04 校验比对仅 4 个无关文件不同。
- 12:45–12:50 数据库备份 `/opt/backups/onstarvoice/customer-monthly-pre-0c56820-20261008-124529.dump`（1.0 GB，`pg_restore --list` 可列出）。
- 12:51:48 执行 `deploy.sh`：备份被替换的 8 个文件到发布目录 `backup/`，复制 15 个文件并原地校验，后台 dist 原子切换（旧目录 `web/admin/dist.before-customer-monthly-0c56820-20261008`），`node db/migrate.js` 应用 092，`pm2 restart onstarvoice`（PID 780619）。
- 门禁：`/api/health` 200、`/api/health/ready` 200、`/admin/` 200、`/api/customer-monthly-reports/` 未登录 401、公网 health/admin/资源 200；两分钟内无再次重启。回退脚本 `rollback.sh` 在同一目录（迁移表为新增，不回退）。
- 生产 = main = 0c56820。9 月月报尚未生成：自动模式拒绝在生产执行写入脚本，需在后台「客户月报」页选择 2026-09 点「生成月报」。
