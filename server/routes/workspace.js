import { Router } from 'express';
import { queryAll, queryOne } from '../db/init.js';
import { requireTenantAccess } from '../middleware/auth.js';
import { applyResolvedMetrics } from '../utils/metrics.js';

const router = Router();

router.get('/overview', requireTenantAccess, async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const kpi = await queryOne(`
      SELECT
        COUNT(*) AS total_records,
        COUNT(*) FILTER (WHERE created_at >= $2) AS period_new,
        COUNT(*) FILTER (WHERE created_at >= $3) AS today_new,
        COUNT(*) FILTER (WHERE sentiment = 'negative' AND created_at >= $2) AS negative_period,
        COUNT(*) FILTER (WHERE sentiment = '') AS pending_label,
        COALESCE(SUM(likes + comments_count + collects + shares), 0) AS total_interaction
      FROM records
      WHERE tenant_id = $1
    `, [req.tenantId, since, todayStart.toISOString()]);

    const issueStats = await queryOne(`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'closed', 'ignored')) AS open_issues,
        COUNT(*) FILTER (WHERE severity IN ('high', 'critical') AND status NOT IN ('resolved', 'closed', 'ignored')) AS high_open_issues,
        COUNT(*) FILTER (WHERE due_at IS NOT NULL AND due_at < now() AND status NOT IN ('resolved', 'closed', 'ignored')) AS overdue_issues
      FROM issues
      WHERE tenant_id = $1
    `, [req.tenantId]);

    const triageStats = await queryOne(`
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(rt.status, 'unhandled') = 'unhandled') AS unhandled,
        COUNT(*) FILTER (WHERE COALESCE(rt.status, 'unhandled') = 'reviewing') AS reviewing,
        COUNT(*) FILTER (WHERE COALESCE(rt.status, 'unhandled') = 'issue_linked') AS issue_linked
      FROM records r
      LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1
    `, [req.tenantId]);

    const operationsStats = await queryOne(`
      SELECT
        (SELECT COUNT(*)
         FROM record_observations ro
         WHERE ro.tenant_id = $1
           AND ro.monitor_execution_id IS NOT NULL
           AND ro.captured_at >= $2) AS today_monitor_hits,
        (SELECT COUNT(*)
         FROM comment_leads cl
         WHERE cl.tenant_id = $1
           AND cl.created_at >= $2) AS today_comment_leads,
        (SELECT COUNT(*)
         FROM monitor_subscriptions ms
         WHERE ms.tenant_id = $1
           AND ms.status = 'active') AS active_monitors
    `, [req.tenantId, todayStart.toISOString()]);

    const pendingRecords = await queryAll(`
      SELECT r.id, r.platform, r.title, r.content, r.author_name, r.url, r.likes, r.comments_count,
        r.collects, r.shares, r.sentiment, r.category, r.last_seen_at,
        COALESCE(rt.status, 'unhandled') AS triage_status,
        COALESCE(rt.priority, 'normal') AS triage_priority,
        (SELECT COUNT(*) FROM alerts a WHERE a.record_id = r.id AND a.tenant_id = r.tenant_id) AS alert_count
      FROM records r
      LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1
        AND COALESCE(rt.status, 'unhandled') IN ('unhandled', 'reviewing')
      ORDER BY
        CASE WHEN r.sentiment = 'negative' THEN 1 ELSE 2 END,
        (r.likes + r.comments_count + r.collects + r.shares) DESC,
        r.last_seen_at DESC
      LIMIT 8
    `, [req.tenantId]);

    const platformCoverage = await queryAll(`
      SELECT platform, COUNT(*) AS count,
        COUNT(*) FILTER (WHERE created_at >= $2) AS period_new,
        MAX(last_seen_at) AS last_seen_at
      FROM records
      WHERE tenant_id = $1
      GROUP BY platform
      ORDER BY count DESC
    `, [req.tenantId, since]);

    const riskTrend = await queryAll(`
      SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE sentiment = 'negative') AS negative
      FROM records
      WHERE tenant_id = $1 AND created_at >= $2
      GROUP BY day
      ORDER BY day ASC
    `, [req.tenantId, since]);

    const latestContent = await queryAll(`
      SELECT id, platform, record_type, title, content, author_name, url, likes,
        comments_count, collects, shares, sentiment, keyword, created_at, last_seen_at
      FROM records
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT 8
    `, [req.tenantId]);

    const latestCommentLeads = await queryAll(`
      SELECT *
      FROM comment_leads
      WHERE tenant_id = $1
      ORDER BY captured_at DESC, created_at DESC
      LIMIT 8
    `, [req.tenantId]);

    const latestMonitorHits = await queryAll(`
      SELECT
        ro.id AS observation_id,
        ro.captured_at,
        ro.keyword AS observation_keyword,
        ms.name AS monitor_name,
        ms.keyword AS monitor_keyword,
        r.id AS record_id,
        r.platform,
        r.record_type,
        r.title,
        r.content,
        r.author_name,
        r.url,
        r.likes,
        r.comments_count,
        r.collects,
        r.shares,
        r.payload AS record_payload,
        ro.payload AS observation_payload,
        r.sentiment,
        CASE
          WHEN r.created_at >= ro.captured_at - interval '5 minutes'
            AND r.created_at <= ro.captured_at + interval '5 minutes'
          THEN true
          ELSE false
        END AS is_new_record
      FROM record_observations ro
      JOIN records r ON r.id = ro.record_id AND r.tenant_id = ro.tenant_id
      LEFT JOIN monitor_executions me ON me.id = ro.monitor_execution_id AND me.tenant_id = ro.tenant_id
      LEFT JOIN monitor_subscriptions ms ON ms.id = me.subscription_id AND ms.tenant_id = ro.tenant_id
      WHERE ro.tenant_id = $1
        AND ro.monitor_execution_id IS NOT NULL
      ORDER BY ro.captured_at DESC
      LIMIT 8
    `, [req.tenantId]);
    const normalizedLatestMonitorHits = latestMonitorHits.map(applyResolvedMetrics);

    const sourceDistribution = await queryAll(`
      SELECT COALESCE(NULLIF(record_type, ''), 'single_note') AS record_type,
        COUNT(*) AS count,
        COUNT(*) FILTER (WHERE created_at >= $2) AS period_new,
        MAX(created_at) AS last_created_at
      FROM records
      WHERE tenant_id = $1
      GROUP BY COALESCE(NULLIF(record_type, ''), 'single_note')
      ORDER BY count DESC
    `, [req.tenantId, since]);

    const topIssues = await queryAll(`
      SELECT id, title, severity, status, owner_name, due_at, record_count, updated_at
      FROM issues
      WHERE tenant_id = $1 AND status NOT IN ('resolved', 'closed', 'ignored')
      ORDER BY
        CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        updated_at DESC
      LIMIT 8
    `, [req.tenantId]);

    const reports = await queryAll(`
      SELECT id, report_type, period_start, period_end, status, subject, generated_at, sent_at, error_message
      FROM report_runs
      WHERE tenant_id = $1
      ORDER BY period_start DESC
      LIMIT 6
    `, [req.tenantId]);

    const monitorHealth = await queryAll(`
      SELECT ms.id, ms.name, ms.keyword, ms.platform, ms.status, ms.last_run_at, ms.next_run_at, ms.last_error,
        me.status AS last_execution_status, me.finished_at AS last_execution_finished_at
      FROM monitor_subscriptions ms
      LEFT JOIN LATERAL (
        SELECT status, finished_at
        FROM monitor_executions
        WHERE subscription_id = ms.id
        ORDER BY created_at DESC
        LIMIT 1
      ) me ON true
      WHERE ms.tenant_id = $1 AND ms.status <> 'deleted'
      ORDER BY ms.updated_at DESC
      LIMIT 8
    `, [req.tenantId]);

    return res.json({
      ok: true,
      tenant: { id: req.tenantId, name: req.tenantName },
      days,
      kpi: { ...kpi, ...issueStats, ...triageStats, ...operationsStats },
      pendingRecords,
      latestContent,
      latestCommentLeads,
      latestMonitorHits: normalizedLatestMonitorHits,
      platformCoverage,
      sourceDistribution,
      riskTrend,
      topIssues,
      reports,
      monitorHealth,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
