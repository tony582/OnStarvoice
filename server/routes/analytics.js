import { Router } from 'express';
import { queryOne, queryAll, execute } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { buildAnalyticsDashboard, generateOpinionInsight } from '../services/report-generator.js';
import {
  buildAnalyticsDrilldown,
  isValidAnalyticsDrilldownSelection,
} from '../services/analytics-drilldown.js';
import { buildAnalyticsWorkbook } from '../services/analytics-workbook.js';
import { compactAnalyticsDashboard } from '../services/analytics-dashboard-payload.js';
import { sendWorkbook } from '../services/xlsx-export.js';

const router = Router();
const DASHBOARD_CACHE_TTL_MS = 60_000;
const DASHBOARD_CACHE_MAX_ENTRIES = 100;
const dashboardCache = new Map();

function dashboardCacheKey(tenantId, period, keywords) {
  if (period.range !== 'month' || !period.month) return '';
  return [
    tenantId,
    period.month,
    [...keywords].sort((a, b) => a.localeCompare(b, 'zh-CN')).join('\u0001'),
  ].join('\u0002');
}

function pruneDashboardCache(now = Date.now()) {
  for (const [key, entry] of dashboardCache) {
    if (entry.expiresAt <= now) dashboardCache.delete(key);
  }
  while (dashboardCache.size >= DASHBOARD_CACHE_MAX_ENTRIES) {
    const oldestKey = dashboardCache.keys().next().value;
    if (oldestKey === undefined) break;
    dashboardCache.delete(oldestKey);
  }
}

async function loadDashboardSnapshot({ tenantId, period, keywords, forceRefresh = false }) {
  const key = dashboardCacheKey(tenantId, period, keywords);
  const now = Date.now();
  if (key && !forceRefresh) {
    const cached = dashboardCache.get(key);
    if (cached?.expiresAt > now) return await cached.promise;
  }

  const promise = buildAnalyticsDashboard({
    tenantId,
    periodStart: period.start,
    periodEnd: period.end,
    keywords,
  }).then(snapshot => ({
    snapshot: compactAnalyticsDashboard(snapshot),
    generatedAt: new Date().toISOString(),
  }));

  if (!key) return await promise;
  pruneDashboardCache(now);
  const entry = { promise, expiresAt: now + DASHBOARD_CACHE_TTL_MS };
  dashboardCache.set(key, entry);
  try {
    return await promise;
  } catch (error) {
    if (dashboardCache.get(key) === entry) dashboardCache.delete(key);
    throw error;
  }
}

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

function shanghaiMonthStart(date = new Date()) {
  const parts = shanghaiParts(date);
  return new Date(`${parts.year}-${parts.month}-01T00:00:00+08:00`);
}

function parseShanghaiMonth(value, now = new Date()) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const start = new Date(`${year}-${String(month).padStart(2, '0')}-01T00:00:00+08:00`);
  const nextStart = new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+08:00`);
  const end = now >= start && now < nextStart ? now : nextStart;
  return {
    month: `${year}-${String(month).padStart(2, '0')}`,
    start,
    end,
    label: `${year}年${month}月（月报）`,
  };
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
  const range = String(query.range || 'month');
  const today = shanghaiDayStart();

  if (range === 'month') {
    const parts = shanghaiParts();
    const selected = parseShanghaiMonth(query.month || `${parts.year}-${parts.month}`);
    if (!selected) return { error: '请选择有效的统计月份' };
    return {
      range,
      ...selected,
    };
  }

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

  if (range === '7d') {
    return { range, start: addDays(today, -6), end: new Date(), label: '近7天' };
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

  const parts = shanghaiParts();
  return {
    range: 'month',
    start: shanghaiMonthStart(),
    end: new Date(),
    label: `${parts.year}年${Number(parts.month)}月（月报）`,
  };
}

function dashboardKeywords(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

router.get('/dashboard', requireTenantAccess, async (req, res, next) => {
  try {
    const period = await resolveRange(req.tenantId, req.query);
    if (period.error) {
      return res.status(400).json({ ok: false, error: 'invalid_range', message: period.error });
    }

    // 数据看板按「采集关键词」收敛(关注主题/临时筛选);多个用逗号分隔。空=全量。
    const keywords = dashboardKeywords(req.query.keywords);

    const dashboard = await loadDashboardSnapshot({
      tenantId: req.tenantId,
      period,
      keywords,
      forceRefresh: req.query.refresh === '1',
    });

    return res.json({
      ok: true,
      period: {
        range: period.range,
        month: period.month || null,
        label: period.label,
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        generatedAt: dashboard.generatedAt,
      },
      snapshot: dashboard.snapshot,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/dashboard/export', requireTenantAccess, async (req, res, next) => {
  try {
    const period = await resolveRange(req.tenantId, req.query);
    if (period.error) {
      return res.status(400).json({ ok: false, error: 'invalid_range', message: period.error });
    }
    const workbook = await buildAnalyticsWorkbook({
      tenantId: req.tenantId,
      periodStart: period.start,
      periodEnd: period.end,
      periodLabel: period.label,
      keywords: dashboardKeywords(req.query.keywords),
    });
    return await sendWorkbook(res, {
      workbook,
      filename: `${period.label}-月报基础分析及数据源.xlsx`,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/dashboard/drilldown', requireTenantAccess, async (req, res, next) => {
  try {
    const dimension = String(req.query.dimension || '');
    const value = String(req.query.value || '');
    if (!isValidAnalyticsDrilldownSelection(dimension, value)) {
      return res.status(400).json({ ok: false, error: 'invalid_drilldown', message: '不支持的下钻条件' });
    }
    const period = await resolveRange(req.tenantId, req.query);
    if (period.error) {
      return res.status(400).json({ ok: false, error: 'invalid_range', message: period.error });
    }
    const drilldown = await buildAnalyticsDrilldown({
      tenantId: req.tenantId,
      periodStart: period.start,
      periodEnd: period.end,
      keywords: dashboardKeywords(req.query.keywords),
      dimension,
      value,
    });
    return res.json({
      ok: true,
      period: {
        range: period.range,
        month: period.month || null,
        label: period.label,
        start: period.start.toISOString(),
        end: period.end.toISOString(),
      },
      drilldown,
    });
  } catch (err) {
    return next(err);
  }
});

// 看板按需触发 AI 舆情研判(独立端点,避免拖慢看板加载/每次开都烧 token)
router.get('/ai-insight', requireTenantAccess, async (req, res, next) => {
  try {
    const period = await resolveRange(req.tenantId, req.query);
    if (period.error) {
      return res.status(400).json({ ok: false, error: 'invalid_range', message: period.error });
    }
    const insight = await generateOpinionInsight({
      tenantId: req.tenantId,
      periodStart: period.start,
      periodEnd: period.end,
    });
    return res.json({ ok: true, insight: insight || null });
  } catch (err) {
    return next(err);
  }
});

// ── 关注主题:数据看板按阶段/主题收敛的「采集关键词」预设 ──────────────
function cleanKeywords(value) {
  const arr = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const k of arr) {
    const s = String(k || '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

router.get('/focus-topics', requireTenantAccess, async (req, res, next) => {
  try {
    const topics = await queryAll(
      `SELECT id, name, keywords, sort_order, created_at, updated_at
       FROM focus_topics WHERE tenant_id = $1
       ORDER BY sort_order ASC, created_at ASC`,
      [req.tenantId],
    );
    return res.json({ ok: true, topics });
  } catch (err) {
    return next(err);
  }
});

router.post('/focus-topics', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name_required', message: '主题名不能为空' });
    const keywords = cleanKeywords(req.body?.keywords);
    const sortOrder = Number(req.body?.sortOrder) || 0;
    const topic = await queryOne(
      `INSERT INTO focus_topics (tenant_id, name, keywords, sort_order)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, name, keywords, sort_order, created_at, updated_at`,
      [req.tenantId, name, JSON.stringify(keywords), sortOrder],
    );
    return res.json({ ok: true, topic });
  } catch (err) {
    return next(err);
  }
});

router.patch('/focus-topics/:id', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const sets = [];
    const params = [];
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ ok: false, error: 'name_required', message: '主题名不能为空' });
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if (req.body?.keywords !== undefined) {
      params.push(JSON.stringify(cleanKeywords(req.body.keywords)));
      sets.push(`keywords = $${params.length}::jsonb`);
    }
    if (req.body?.sortOrder !== undefined) {
      params.push(Number(req.body.sortOrder) || 0);
      sets.push(`sort_order = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing_to_update' });
    sets.push('updated_at = now()');
    params.push(req.params.id, req.tenantId);
    const topic = await queryOne(
      `UPDATE focus_topics SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING id, name, keywords, sort_order, created_at, updated_at`,
      params,
    );
    if (!topic) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, topic });
  } catch (err) {
    return next(err);
  }
});

router.delete('/focus-topics/:id', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    await execute('DELETE FROM focus_topics WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
