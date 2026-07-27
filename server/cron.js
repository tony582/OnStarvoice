/**
 * 定时任务调度
 */

import cron from 'node-cron';
import { queryAll, getSetting } from './db/init.js';
import { labelPendingRecords } from './services/ai-labeler.js';
import { generateDailyReport, generateWeeklyReport, generateMonthlyReport } from './services/report-generator.js';
import { processCaptureAttentionNotifications } from './services/capture-attention-notifier.js';
import { enqueueDueCaptureOrchestrations } from './services/capture-orchestration-scheduler.js';
import {enqueueDueProfilePatrolTasks} from './services/profile-patrol-dispatch.js';

function shanghaiNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    hhmm: `${map.hour}:${map.minute}`,
    weekday: new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day))).getUTCDay(),
  };
}

async function runConfiguredReports() {
  const now = shanghaiNowParts();
  const tenants = await queryAll("SELECT id FROM tenants WHERE status = 'active'");

  for (const tenant of tenants) {
    const dailyEnabled = await getSetting('report_daily_enabled', tenant.id);
    const dailyTime = await getSetting('report_daily_time', tenant.id);
    if (dailyEnabled !== 'false' && (dailyTime || '09:00') === now.hhmm) {
      await generateDailyReport(tenant.id);
    }

    const weeklyEnabled = await getSetting('report_weekly_enabled', tenant.id);
    const weeklyDay = Number(await getSetting('report_weekly_day', tenant.id) || 1);
    const weeklyTime = await getSetting('report_weekly_time', tenant.id);
    if (weeklyEnabled !== 'false' && weeklyDay === now.weekday && (weeklyTime || '09:00') === now.hhmm) {
      await generateWeeklyReport(tenant.id);
    }

    const monthlyEnabled = await getSetting('report_monthly_enabled', tenant.id);
    const monthlyDay = Number(await getSetting('report_monthly_day', tenant.id) || 1);
    const monthlyTime = await getSetting('report_monthly_time', tenant.id);
    if (monthlyEnabled !== 'false' && monthlyDay === now.day && (monthlyTime || '09:00') === now.hhmm) {
      await generateMonthlyReport(tenant.id);
    }
  }
}

export function startCronJobs() {
  cron.schedule('*/10 * * * *', async () => {
    console.log('[Cron] Running batch AI labeling...');
    try {
      await labelPendingRecords(20);
    } catch (err) {
      console.error('[Cron] Batch labeling error:', err.message);
    }
  });

  cron.schedule('*/5 * * * *', async () => {
    try {
      const results = await enqueueDueProfilePatrolTasks(20);
      const created = results.filter(result => result.kind === 'created').length;
      const attention = results.length - created;
      if (results.length > 0) {
        console.log(
          `[Cron] Profile patrol: ${created} task(s) created, ` +
          `${attention} subscription(s) need attention`,
        );
      }
    } catch (err) {
      console.error('[Cron] Profile patrol enqueue error:', err.message);
    }
  });

  cron.schedule('* * * * *', async () => {
    try {
      const results = await enqueueDueCaptureOrchestrations(20);
      const created = results.filter(result => result.kind === 'created').length;
      const skipped = results.length - created;
      if (results.length > 0) {
        console.log(
          `[Cron] Multi-Agent schedules: ${created} run(s) created, ${skipped} occurrence(s) advanced`,
        );
      }
    } catch (err) {
      console.error('[Cron] Multi-Agent schedule error:', err.message);
    }
  });

  cron.schedule('* * * * *', async () => {
    try {
      const result = await processCaptureAttentionNotifications(20);
      if (result.claimed > 0) {
        console.log(
          `[Cron] Capture attention notifications: ${result.sent} sent, ` +
          `${result.retry_wait} retrying, ${result.blocked_config} blocked, ` +
          `${result.failed} failed, ${result.worker_error} worker error(s)`,
        );
      }
    } catch (err) {
      console.error('[Cron] Capture attention notification error:', err.message);
    }
  });

  cron.schedule('* * * * *', async () => {
    try {
      await runConfiguredReports();
    } catch (err) {
      console.error('[Cron] Report scheduler error:', err.message);
    }
  });

  console.log('[Cron] Scheduled jobs started');
}
