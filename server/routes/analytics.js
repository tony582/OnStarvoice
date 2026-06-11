import { Router } from 'express';
import { queryOne } from '../db/init.js';
import { requireTenantAccess } from '../middleware/auth.js';
import { buildAnalyticsDashboard } from '../services/report-generator.js';

const router = Router();

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function shanghaiDayStart(date = new Date()) {
  const parts = shanghaiParts(date);
  return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function parseLocalDate(value, { endOfDay = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const start = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) return null;
  return endOfDay ? addDays(start, 1) : start;
}

async function dataBounds(tenantId) {
  const row = await queryOne(`
    SELECT MIN(ts) as start_at, MAX(ts) as end_at
    FROM (
      SELECT created_at as ts FROM records WHERE tenant_id = $1
      UNION ALL
      SELECT captured_at as ts FROM record_observations WHERE tenant_id = $1
      UNION ALL
      SELECT created_at as ts FROM record_comments WHERE tenant_id = $1
      UNION ALL
      SELECT created_at as ts FROM official_responses WHERE tenant_id = $1
      UNION ALL
      SELECT first_seen_at as ts FROM issues WHERE tenant_id = $1
      UNION ALL
      SELECT created_at as ts FROM alerts WHERE tenant_id = $1
    ) s
  `, [tenantId]);
  return row || {};
}

async function resolveRange(tenantId, query) {
  const range = String(query.range || '7d');
  const today = shanghaiDayStart();

  if (range === 'custom') {
    const start = parseLocalDate(query.start);
    const end = parseLocalDate(query.end, { endOfDay: true });
    if (!start || !end) {
      return { error: '请填写有效的开始和结束日期' };
    }
    if (start >= end) {
      return { error: '结束日期必须晚于开始日期' };
    }
    return { range, start, end, label: `${query.start} 至 ${query.end}` };
  }

  if (range === 'today') {
    return { range, start: today, end: new Date(), label: '今日' };
  }

  if (range === 'yesterday') {
    return { range, start: addDays(today, -1), end: today, label: '昨日' };
  }

  if (range === '30d') {
    return { range, start: addDays(today, -29), end: new Date(), label: '近30天' };
  }

  if (range === '90d') {
    return { range, start: addDays(today, -89), end: new Date(), label: '近90天' };
  }

  if (range === 'all') {
    const bounds = await dataBounds(tenantId);
    const start = bounds.start_at ? new Date(bounds.start_at) : addDays(today, -29);
    const latest = bounds.end_at ? new Date(bounds.end_at) : new Date();
    return {
      range,
      start,
      end: new Date(Math.max(Date.now(), latest.getTime() + 60000)),
      label: '全部数据',
    };
  }

  return { range: '7d', start: addDays(today, -6), end: new Date(), label: '近7天' };
}

router.get('/dashboard', requireTenantAccess, async (req, res, next) => {
  try {
    const period = await resolveRange(req.tenantId, req.query);
    if (period.error) {
      return res.status(400).json({ ok: false, error: 'invalid_range', message: period.error });
    }

    const snapshot = await buildAnalyticsDashboard({
      tenantId: req.tenantId,
      periodStart: period.start,
      periodEnd: period.end,
    });

    return res.json({
      ok: true,
      period: {
        range: period.range,
        label: period.label,
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        generatedAt: new Date().toISOString(),
      },
      snapshot,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
