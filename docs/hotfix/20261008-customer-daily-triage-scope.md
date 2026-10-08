# 客户日报改按内容分诊处理日期统计（2026-10-08 起）

9 月日报的平台监控量、SDB、正面、中性按首次入库时间统计，并纳入了未通过内容分诊准入的帖子（9 月 29 日已发送版本 3425 条中有 293 条不在内容分诊）。客户已提交 9 月数字，不追溯改写。

自报表日 2026-10-08 起（`CUSTOMER_DAILY_HANDLING_FROM`），日报全部九列改为「内容分诊主列表范围内、当天发生真实处理状态变更的主帖」：范围与分诊主列表一致（准入规则、有效相关性、关注例外、未归档、九种状态），日期取审计记录中的状态变更时间（北京时间），同帖同日去重，MTD 按本月帖子去重；休息日处理带入下一份工作日日报并按实际日期单独成行。当日数量等于内容分诊按「处理时间 = 当天」筛出的条数。没处理的帖子不再计入；同帖跨天再处理会在两天各计一次；归类按生成时的最终状态。

2026-10-08 之前的日期（含重新生成 9 月）继续走原首次入库逻辑；旧快照不改。新快照 `schemaVersion=6`、`summary.monitoringBasis=triage_handling_date_v1`，格式沿用 `daily_collection_handling_v5`，手填汇总按差额调整 MTD。待复核、采集未完成两类提示在新口径下不再出现。

验证：日报单元回归、真库集成（`customer-daily-triage-handling.integration.mjs`，比对分诊接口返回的 ID）、后台构建与 Playwright 页面回归。发布替换 server 与后台静态包，无迁移，不需更新扩展或手机 Runner。

## 发布记录（2026-10-08）

- 12:45 上传发布包到 `/opt/onstarvoice-private/releases/customer-monthly-0c56820-20261008/`（15 个 server 文件 + 后台 dist，SHA256SUMS 远端核对通过，生产 Node 18 语法检查通过）；发布前生产 `server/` 与 main@6ecdc04 校验比对仅 4 个无关文件不同。
- 12:45–12:50 数据库备份 `/opt/backups/onstarvoice/customer-monthly-pre-0c56820-20261008-124529.dump`（1.0 GB，`pg_restore --list` 可列出）。
- 12:51:48 执行 `deploy.sh`：备份被替换的 8 个文件到发布目录 `backup/`，复制 15 个文件并原地校验，后台 dist 原子切换（旧目录 `web/admin/dist.before-customer-monthly-0c56820-20261008`），`node db/migrate.js` 应用 092，`pm2 restart onstarvoice`（PID 780619）。
- 门禁：`/api/health` 200、`/api/health/ready` 200、`/admin/` 200、`/api/customer-monthly-reports/` 未登录 401、公网 health/admin/资源 200；两分钟内无再次重启。回退脚本 `rollback.sh` 在同一目录（迁移表为新增，不回退）。
- 生产 = main = 0c56820。9 月月报尚未生成：自动模式拒绝在生产执行写入脚本，需在后台「客户月报」页选择 2026-09 点「生成月报」。
