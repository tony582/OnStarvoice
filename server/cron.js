/**
 * 定时任务调度
 */

import cron from 'node-cron';
import { getSetting } from './db/init.js';
import { labelPendingRecords } from './services/ai-labeler.js';
import { generateDailyReport, generateWeeklyReport } from './services/report-generator.js';

export function startCronJobs() {
  // 每 10 分钟批量标签未处理的记录
  cron.schedule('*/10 * * * *', async () => {
    console.log('[Cron] Running batch AI labeling...');
    try {
      await labelPendingRecords(20);
    } catch (err) {
      console.error('[Cron] Batch labeling error:', err.message);
    }
  });

  // 每天 09:00 发送日报
  cron.schedule('0 9 * * *', async () => {
    const enabled = getSetting('report_daily_enabled');
    if (enabled === 'false') return;
    console.log('[Cron] Generating daily report...');
    try {
      await generateDailyReport();
    } catch (err) {
      console.error('[Cron] Daily report error:', err.message);
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每周一 09:00 发送周报
  cron.schedule('0 9 * * 1', async () => {
    const enabled = getSetting('report_weekly_enabled');
    if (enabled === 'false') return;
    console.log('[Cron] Generating weekly report...');
    try {
      await generateWeeklyReport();
    } catch (err) {
      console.error('[Cron] Weekly report error:', err.message);
    }
  }, { timezone: 'Asia/Shanghai' });

  console.log('[Cron] Scheduled jobs started');
}
