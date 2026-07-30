/**
 * Persist one immutable comment-sentiment baseline for every official post
 * observed by a completed profile patrol execution.
 *
 * record_observations is the execution-to-post evidence. This deliberately
 * avoids snapshotting every historical post under the account when a run only
 * inspected the latest N posts.
 */
export async function captureOfficialCommentPatrolSnapshots(
  tx,
  tenantId,
  executionId,
) {
  const execution = await tx.queryOne(`
    SELECT execution.id, execution.status, execution.finished_at,
      subscription.official_account_id
    FROM monitor_executions execution
    JOIN monitor_subscriptions subscription
      ON subscription.id = execution.subscription_id
      AND subscription.tenant_id = execution.tenant_id
      AND subscription.subject_type = 'official'
      AND subscription.official_account_id IS NOT NULL
    WHERE execution.id = $1::uuid
      AND execution.tenant_id = $2
      AND execution.status = 'succeeded'
    LIMIT 1
  `, [executionId, tenantId]);
  if (!execution) return {captured: 0};

  const rows = await tx.queryAll(`
    INSERT INTO official_comment_patrol_snapshots (
      tenant_id,
      official_account_id,
      monitor_execution_id,
      record_id,
      platform_comment_count,
      sampled_comment_count,
      positive_comment_count,
      neutral_comment_count,
      negative_comment_count,
      unknown_comment_count,
      high_risk_comment_count,
      latest_comment_at,
      captured_at
    )
    SELECT
      $1,
      $2::uuid,
      $3::uuid,
      record.id,
      GREATEST(0, COALESCE(record.comments_count, 0)),
      COUNT(comment.id) FILTER (WHERE comment.is_official = false)::integer,
      COUNT(comment.id) FILTER (
        WHERE comment.is_official = false
          AND comment.sentiment = 'positive'
      )::integer,
      COUNT(comment.id) FILTER (
        WHERE comment.is_official = false
          AND comment.sentiment = 'neutral'
      )::integer,
      COUNT(comment.id) FILTER (
        WHERE comment.is_official = false
          AND (
            comment.sentiment = 'negative'
            OR comment.is_negative = true
            OR comment.risk_level IN ('high', 'critical')
          )
      )::integer,
      COUNT(comment.id) FILTER (
        WHERE comment.is_official = false
          AND COALESCE(comment.sentiment, '') NOT IN (
            'positive', 'neutral', 'negative'
          )
          AND comment.is_negative = false
          AND comment.risk_level NOT IN ('high', 'critical')
      )::integer,
      COUNT(comment.id) FILTER (
        WHERE comment.is_official = false
          AND comment.risk_level IN ('high', 'critical')
      )::integer,
      MAX(comment.last_seen_at) FILTER (WHERE comment.is_official = false),
      COALESCE($4::timestamptz, now())
    FROM (
      SELECT DISTINCT observation.record_id
      FROM record_observations observation
      WHERE observation.tenant_id = $1
        AND observation.monitor_execution_id = $3::uuid
    ) observed
    JOIN records record
      ON record.id = observed.record_id
      AND record.tenant_id = $1
    LEFT JOIN record_comments comment
      ON comment.record_id = record.id
      AND comment.tenant_id = record.tenant_id
    GROUP BY record.id, record.comments_count
    ON CONFLICT (monitor_execution_id, record_id)
      WHERE monitor_execution_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `, [
    tenantId,
    execution.official_account_id,
    execution.id,
    execution.finished_at,
  ]);
  return {captured: rows.length};
}
