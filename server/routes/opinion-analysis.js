import { Router } from 'express';
import { queryAll, queryOne, execute } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import {
  runTopicAnalysis,
  analyzeOpinionRecord,
  countScopedRecords,
  normalizeKeywords,
  hasBrandContextConfigured,
  computeRecordInputHash,
} from '../services/opinion-analysis.js';

const router = Router();

router.use(requireTenantAccess);

const LIST_COLUMNS = `id, title, focus_topic_id, keywords, period_start, period_end, status, progress,
  sample_count, analysis_source, prompt_version, error, created_by, created_at, updated_at`;

function parsePeriodInput(value) {
  const date = new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? null : date;
}

async function rejectIfBrandMissing(req, res) {
  if (await hasBrandContextConfigured(req.tenantId)) return false;
  res.status(409).json({
    ok: false,
    error: 'brand_context_missing',
    message: '尚未配置品牌名称与业务语境,请先在系统设置完成品牌配置后再发起剖析',
  });
  return true;
}

function initialProgress() {
  return JSON.stringify({ stage: 'pending', message: '排队中', updatedAt: new Date().toISOString() });
}

// 发起话题剖析:品牌预检 → COUNT 预检 → INSERT pending + 后台执行,前端轮询 GET /topics/:id
router.post('/topics', requireTenantWriter, async (req, res, next) => {
  try {
    if (await rejectIfBrandMissing(req, res)) return;

    const keywords = normalizeKeywords(req.body?.keywords);
    const periodStart = parsePeriodInput(req.body?.periodStart);
    const periodEnd = parsePeriodInput(req.body?.periodEnd);
    if (!periodStart || !periodEnd || periodStart >= periodEnd) {
      return res.status(400).json({ ok: false, error: 'invalid_period', message: '请提供有效的剖析时间范围' });
    }
    const title = String(req.body?.title || '').trim().slice(0, 120)
      || (keywords.length ? `「${keywords.join('、')}」话题剖析`.slice(0, 120) : '全量舆情剖析');

    let focusTopicId = String(req.body?.focusTopicId || '').trim() || null;
    if (focusTopicId) {
      const topic = await queryOne(
        `SELECT id FROM focus_topics WHERE id = $1 AND tenant_id = $2`,
        [focusTopicId, req.tenantId]
      );
      if (!topic) return res.status(400).json({ ok: false, error: 'invalid_focus_topic', message: '关注主题不存在' });
    }

    const count = await countScopedRecords(req.tenantId, periodStart, periodEnd, keywords);
    if (count < 3) {
      return res.status(422).json({
        ok: false,
        error: 'insufficient_samples',
        message: `圈定范围内相关内容仅 ${count} 条(至少需要 3 条),请放宽关键词或时间范围`,
        count,
      });
    }

    const inserted = await queryOne(
      `INSERT INTO opinion_topic_analyses
        (tenant_id, title, focus_topic_id, keywords, period_start, period_end, status, progress, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'pending', $7::jsonb, $8)
       RETURNING ${LIST_COLUMNS}`,
      [
        req.tenantId, title, focusTopicId, JSON.stringify(keywords),
        periodStart.toISOString(), periodEnd.toISOString(), initialProgress(), req.actorName || '',
      ]
    );
    setImmediate(() => {
      runTopicAnalysis({ tenantId: req.tenantId, analysisId: inserted.id }).catch(() => {});
    });
    return res.json({ ok: true, analysis: inserted });
  } catch (err) {
    return next(err);
  }
});

// 列表(不含 payload,避免大 JSONB 拖慢卡片流)
router.get('/topics', async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const rows = await queryAll(
      `SELECT ${LIST_COLUMNS}
       FROM opinion_topic_analyses
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.tenantId, limit]
    );
    return res.json({ ok: true, analyses: rows });
  } catch (err) {
    return next(err);
  }
});

// 详情(轮询端点,含 payload + progress)
router.get('/topics/:id', async (req, res, next) => {
  try {
    const row = await queryOne(
      `SELECT * FROM opinion_topic_analyses WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (!row) return res.status(404).json({ ok: false, error: 'not_found', message: '剖析记录不存在' });
    return res.json({ ok: true, analysis: row });
  } catch (err) {
    return next(err);
  }
});

// 重跑:复制参数 INSERT 新行(追加留痕,旧结果保留供事件演化对比);样本量变化由 run 内 insufficientSamples 兜底
router.post('/topics/:id/rerun', requireTenantWriter, async (req, res, next) => {
  try {
    if (await rejectIfBrandMissing(req, res)) return;
    const source = await queryOne(
      `SELECT title, focus_topic_id, keywords, period_start, period_end
       FROM opinion_topic_analyses WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (!source) return res.status(404).json({ ok: false, error: 'not_found', message: '剖析记录不存在' });

    const inserted = await queryOne(
      `INSERT INTO opinion_topic_analyses
        (tenant_id, title, focus_topic_id, keywords, period_start, period_end, status, progress, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'pending', $7::jsonb, $8)
       RETURNING ${LIST_COLUMNS}`,
      [
        req.tenantId, source.title, source.focus_topic_id, JSON.stringify(source.keywords || []),
        source.period_start, source.period_end, initialProgress(), req.actorName || '',
      ]
    );
    setImmediate(() => {
      runTopicAnalysis({ tenantId: req.tenantId, analysisId: inserted.id }).catch(() => {});
    });
    return res.json({ ok: true, analysis: inserted });
  } catch (err) {
    return next(err);
  }
});

router.delete('/topics/:id', requireTenantWriter, async (req, res, next) => {
  try {
    const result = await execute(
      `DELETE FROM opinion_topic_analyses WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (!result.rowCount) return res.status(404).json({ ok: false, error: 'not_found', message: '剖析记录不存在' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// 单条深剖:与内容创意的爆款拆解同口径(不加 writer);缓存命中且非降级结果直接返回,
// rule_fallback 缓存 = 隐式重试一次(防一次 LLM 超时把降级结果永久钉死),GET 纯读不触发
router.post('/records/:recordId', async (req, res, next) => {
  try {
    if (await rejectIfBrandMissing(req, res)) return;
    const record = await queryOne(
      `SELECT id FROM records WHERE id = $1 AND tenant_id = $2`,
      [req.params.recordId, req.tenantId]
    );
    if (!record) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });

    const cached = await queryOne(
      `SELECT payload, analysis_source FROM opinion_record_analyses WHERE tenant_id = $1 AND record_id = $2`,
      [req.tenantId, req.params.recordId]
    );
    if (cached && cached.analysis_source !== 'rule_fallback' && !req.query.refresh) {
      return res.json({ ok: true, analysis: cached.payload, source: cached.analysis_source, cached: true });
    }

    const result = await analyzeOpinionRecord({ tenantId: req.tenantId, recordId: req.params.recordId });
    if (!result) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    return res.json({ ok: true, analysis: result.payload, source: result.source, cached: false, retried: Boolean(cached) });
  } catch (err) {
    return next(err);
  }
});

// 只读缓存:未剖析回 analysis:null,由前端决定是否发起 POST。
// stale = 缓存后正文/评论/逐字稿/OCR 有变化(input_hash 不一致),前端提示可重剖,GET 本身不触发。
router.get('/records/:recordId', async (req, res, next) => {
  try {
    const cached = await queryOne(
      `SELECT payload, analysis_source, prompt_version, input_hash, updated_at
       FROM opinion_record_analyses WHERE tenant_id = $1 AND record_id = $2`,
      [req.tenantId, req.params.recordId]
    );
    if (!cached) return res.json({ ok: true, analysis: null });

    let stale = false;
    const record = await queryOne(
      `SELECT id, content, comments_count, transcript FROM records WHERE id = $1 AND tenant_id = $2`,
      [req.params.recordId, req.tenantId]
    );
    if (record) {
      const currentHash = await computeRecordInputHash(req.tenantId, record);
      stale = Boolean(cached.input_hash) && currentHash !== cached.input_hash;
    }
    return res.json({
      ok: true, analysis: cached.payload, source: cached.analysis_source, updatedAt: cached.updated_at, stale,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
