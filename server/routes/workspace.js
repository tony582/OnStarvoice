import { Router } from 'express';
import { queryAll, queryOne } from '../db/init.js';
import { requireTenantAccess } from '../middleware/auth.js';

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
      kpi: { ...kpi, ...issueStats, ...triageStats },
      pendingRecords,
      platformCoverage,
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
