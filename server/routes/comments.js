import { Router } from 'express';
import { withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { getComment } from '../services/comment-workflow.js';

const router = Router();

router.post('/:id/issues', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { issueId = '', title = '', severity = 'medium', summary = '', suggestedAction = '' } = req.body || {};
    const result = await withTransaction(async tx => {
      const comment = await getComment(req.tenantId, req.params.id);
      if (!comment) return null;
      const record = await tx.queryOne(
        'SELECT * FROM records WHERE id = $1 AND tenant_id = $2',
        [comment.record_id, req.tenantId]
      );
      if (!record) return null;

      let issue;
      if (issueId) {
        issue = await tx.queryOne('SELECT * FROM issues WHERE id = $1 AND tenant_id = $2', [issueId, req.tenantId]);
        if (!issue) return null;
      } else {
        issue = await tx.queryOne(`
          INSERT INTO issues (
            tenant_id, title, severity, status, summary, suggested_action,
            primary_record_id, cluster_key, record_count
          ) VALUES ($1, $2, $3, 'triage', $4, $5, $6, gen_random_uuid()::text, 0)
          RETURNING *
        `, [
          req.tenantId,
          title || `负面评论：${comment.content.slice(0, 48)}` || record.title || '评论舆情问题',
          severity,
          summary || comment.ai_summary || comment.content,
          suggestedAction || '优先核查评论诉求，确认是否需要官方补充回复或客服跟进。',
          record.id,
        ]);
      }

      await tx.execute(`
        INSERT INTO issue_records (tenant_id, issue_id, record_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (issue_id, record_id) DO NOTHING
      `, [req.tenantId, issue.id, record.id]);
      await tx.execute(`
        UPDATE issues
        SET record_count = (SELECT COUNT(*) FROM issue_records WHERE issue_id = $1),
          last_seen_at = now(),
          updated_at = now()
        WHERE id = $1
      `, [issue.id]);
      await tx.execute(`
        INSERT INTO issue_events (tenant_id, issue_id, event_type, body, actor_type, actor_name, metadata)
        VALUES ($1, $2, 'comment_linked', $3, 'user', $4, $5::jsonb)
      `, [
        req.tenantId,
        issue.id,
        `从评论舆情关联：${comment.content}`,
        req.actorName || '',
        JSON.stringify({ commentId: comment.id, recordId: record.id, sentiment: comment.sentiment, riskLevel: comment.risk_level }),
      ]);
      await tx.execute(`
        INSERT INTO record_triage (tenant_id, record_id, status, priority, owner_user_id, owner_name, updated_at)
        VALUES ($1, $2, 'issue_linked', 'high', $3, $4, now())
        ON CONFLICT (tenant_id, record_id)
        DO UPDATE SET status = 'issue_linked', priority = 'high', owner_user_id = excluded.owner_user_id,
          owner_name = excluded.owner_name, updated_at = now()
      `, [req.tenantId, record.id, req.user?.id || null, req.actorName || '']);
      return issue;
    });

    if (!result) return res.status(404).json({ ok: false, error: 'not_found', message: '评论或问题不存在' });
    return res.json({ ok: true, issue: result });
  } catch (err) {
    return next(err);
  }
});

export default router;
