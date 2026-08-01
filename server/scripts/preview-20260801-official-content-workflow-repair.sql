\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- 安吉星租户纯只读预览：一个 CTE 查询汇总所有候选、阻断项和关联影响。
-- 文件没有 UPDATE/INSERT/DELETE/DDL，末尾显式 ROLLBACK。
WITH
official_records AS MATERIALIZED (
  SELECT DISTINCT ON (record.id)
    record.id,
    record.platform,
    record.title,
    record.author_name,
    record.record_type,
    record.official_replied,
    record.official_response_status,
    record.negative_comment_count,
    account.id AS official_account_id,
    account.account_name AS official_account_name,
    COALESCE(triage.status, 'unhandled') AS processing_mode,
    triage.updated_at AS processing_mode_updated_at
  FROM records record
  JOIN official_accounts account
    ON account.tenant_id = record.tenant_id
    AND account.status = 'active'
    AND account.skip_content = true
    AND (account.platform = '' OR account.platform = record.platform)
    AND (
      (COALESCE(account.platform_user_id, '') <> ''
        AND account.platform_user_id = record.author_id)
      OR (COALESCE(account.account_no, '') <> ''
        AND account.account_no = record.author_account_no)
      OR (COALESCE(account.account_id, '') <> '' AND (
        account.account_id = record.author_id
        OR account.account_id = record.author_account_no
      ))
    )
  LEFT JOIN record_triage triage
    ON triage.tenant_id = record.tenant_id
    AND triage.record_id = record.id
  WHERE record.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
    AND record.record_type <> 'blogger_profile'
  ORDER BY record.id, account.id
),
type_summary AS (
  SELECT record_type, processing_mode, count(*)::integer AS records
  FROM official_records
  GROUP BY record_type, processing_mode
),
type_repairs AS (
  SELECT id, platform, title, author_name, record_type, processing_mode,
    official_account_name
  FROM official_records
  WHERE record_type <> 'official_content'
),
fact_scope AS MATERIALIZED (
  SELECT id, platform, title, official_replied,
    official_response_status, negative_comment_count
  FROM official_records
  UNION
  SELECT record.id, record.platform, record.title, record.official_replied,
    record.official_response_status, record.negative_comment_count
  FROM records record
  WHERE record.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
    AND record.record_type = 'official_content'
),
manual_blockers AS (
  SELECT candidate.id, candidate.platform, candidate.title,
    EXISTS (
      SELECT 1 FROM record_notes note
      WHERE note.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
        AND note.record_id = candidate.id
    ) AS has_notes,
    EXISTS (
      SELECT 1 FROM tickets ticket
      WHERE ticket.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
        AND ticket.source_record_id = candidate.id
    ) AS has_tickets,
    EXISTS (
      SELECT 1 FROM record_triage triage
      WHERE triage.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
        AND triage.record_id = candidate.id
        AND (
          triage.archived_at IS NOT NULL
          OR triage.owner_user_id IS NOT NULL
          OR btrim(triage.owner_name) <> ''
          OR btrim(triage.note) <> ''
          OR triage.priority <> 'normal'
        )
    ) AS has_manual_triage_fields,
    EXISTS (
      SELECT 1 FROM audit_logs audit
      WHERE audit.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
        AND audit.target_type = 'record'
        AND audit.target_id = candidate.id::text
        AND audit.actor_type = 'user'
        AND audit.action IN (
          'record.triage_updated',
          'record.triage_batch_updated',
          'record.archived',
          'record.unarchived',
          'record.official_response_marked',
          'record.ticket_created',
          'record.note_added'
        )
    ) AS has_user_workflow_audit
  FROM type_repairs candidate
),
last_automatic_mode_event AS (
  SELECT DISTINCT ON (audit.target_id)
    audit.target_id,
    audit.action,
    audit.metadata,
    audit.created_at
  FROM audit_logs audit
  WHERE audit.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
    AND audit.actor_type = 'system'
    AND audit.actor_id = 'comment-workflow'
    AND audit.target_type = 'record'
    AND audit.action IN (
      'record.official_content_hidden',
      'record.reopened_by_comment_risk',
      'record.official_responded'
    )
  ORDER BY audit.target_id, audit.created_at DESC, audit.id DESC
),
automatic_modes AS (
  SELECT record.id, record.platform, record.title,
    record.record_type,
    triage.status AS current_mode,
    event.metadata->>'previousStatus' AS previous_mode,
    event.action,
    event.created_at,
    triage.updated_at,
    (triage.priority = 'normal'
      AND triage.owner_user_id IS NULL
      AND btrim(triage.owner_name) = ''
      AND btrim(triage.note) = ''
      AND triage.archived_at IS NULL) AS default_system_only_fields,
    EXISTS (
      SELECT 1 FROM audit_logs later_user
      WHERE later_user.tenant_id = record.tenant_id
        AND later_user.target_type = 'record'
        AND later_user.target_id = record.id::text
        AND later_user.actor_type = 'user'
        AND later_user.created_at > event.created_at
    ) AS has_later_user_action
  FROM last_automatic_mode_event event
  JOIN records record
    ON record.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
    AND record.id::text = event.target_id
  JOIN record_triage triage
    ON triage.tenant_id = record.tenant_id
    AND triage.record_id = record.id
  WHERE abs(extract(epoch FROM (triage.updated_at - event.created_at))) < 1
),
comment_facts AS (
  SELECT candidate.id,
    count(comment.id) FILTER (WHERE comment.is_official)::integer AS official_count,
    count(comment.id) FILTER (
      WHERE comment.is_negative AND NOT comment.is_official
    )::integer AS negative_count,
    max(comment.last_seen_at) FILTER (
      WHERE comment.is_negative AND NOT comment.is_official
    ) AS latest_negative_at
  FROM fact_scope candidate
  LEFT JOIN record_comments comment
    ON comment.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
    AND comment.record_id = candidate.id
  GROUP BY candidate.id
),
response_mismatches AS (
  SELECT candidate.id, candidate.platform, candidate.title,
    candidate.official_replied AS stored_official_replied,
    candidate.official_response_status AS stored_response_status,
    facts.official_count,
    CASE
      WHEN facts.official_count = 0 THEN 'none'
      WHEN facts.negative_count > 0 THEN 'needs_followup'
      ELSE 'responded'
    END AS expected_response_status,
    candidate.negative_comment_count AS stored_negative_count,
    facts.negative_count AS expected_negative_count,
    EXISTS (
      SELECT 1 FROM audit_logs audit
      WHERE audit.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
        AND audit.target_type = 'record'
        AND audit.target_id = candidate.id::text
        AND audit.actor_type = 'user'
        AND audit.action = 'record.official_response_marked'
    ) AS has_manual_response_mark
  FROM fact_scope candidate
  JOIN comment_facts facts ON facts.id = candidate.id
  WHERE candidate.official_replied IS DISTINCT FROM (facts.official_count > 0)
    OR candidate.official_response_status IS DISTINCT FROM CASE
      WHEN facts.official_count = 0 THEN 'none'
      WHEN facts.negative_count > 0 THEN 'needs_followup'
      ELSE 'responded'
    END
    OR candidate.negative_comment_count IS DISTINCT FROM facts.negative_count
),
false_alerts AS (
  SELECT candidate.id AS record_id, candidate.platform, candidate.title,
    alert.id AS alert_id, alert.level, alert.reason,
    alert.created_at AS alert_created_at,
    issue.id AS issue_id, issue.status AS issue_status, issue.record_count,
    count(issue_event.id) FILTER (
      WHERE issue_event.actor_type = 'user'
    )::integer AS user_issue_events
  FROM official_records candidate
  JOIN alerts alert
    ON alert.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
    AND alert.record_id = candidate.id
  LEFT JOIN issues issue
    ON issue.tenant_id = alert.tenant_id
    AND issue.id = alert.issue_id
  LEFT JOIN issue_events issue_event
    ON issue_event.tenant_id = alert.tenant_id
    AND issue_event.issue_id = issue.id
  GROUP BY candidate.id, candidate.platform, candidate.title,
    alert.id, alert.level, alert.reason, alert.created_at,
    issue.id, issue.status, issue.record_count
),
patrol_continuity AS (
  SELECT count(DISTINCT candidate.id)::integer AS official_records,
    count(DISTINCT snapshot.record_id)::integer AS records_with_patrol_snapshots,
    count(DISTINCT snapshot.id)::integer AS patrol_snapshots,
    count(DISTINCT comment.record_id)::integer AS records_with_comments,
    count(DISTINCT comment.id)::integer AS comments,
    count(DISTINCT observation.id)::integer AS observations,
    count(DISTINCT observation.record_id) FILTER (
      WHERE observation.monitor_execution_id IS NOT NULL
    )::integer AS records_with_execution_observations
  FROM official_records candidate
  LEFT JOIN official_comment_patrol_snapshots snapshot
    ON snapshot.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
    AND snapshot.record_id = candidate.id
  LEFT JOIN record_comments comment
    ON comment.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
    AND comment.record_id = candidate.id
  LEFT JOIN record_observations observation
    ON observation.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
    AND observation.record_id = candidate.id
)
SELECT jsonb_pretty(jsonb_build_object(
  'typeSummary', COALESCE((
    SELECT jsonb_agg(to_jsonb(item) ORDER BY item.record_type, item.processing_mode)
    FROM type_summary item
  ), '[]'::jsonb),
  'typeRepairs', COALESCE((
    SELECT jsonb_agg(to_jsonb(item) ORDER BY item.platform, item.title, item.id)
    FROM type_repairs item
  ), '[]'::jsonb),
  'manualBlockers', COALESCE((
    SELECT jsonb_agg(to_jsonb(item) ORDER BY item.platform, item.title, item.id)
    FROM manual_blockers item
    WHERE item.has_notes OR item.has_tickets OR item.has_manual_triage_fields
      OR item.has_user_workflow_audit
  ), '[]'::jsonb),
  'automaticModes', COALESCE((
    SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
    FROM automatic_modes item
  ), '[]'::jsonb),
  'responseMismatches', COALESCE((
    SELECT jsonb_agg(to_jsonb(item) ORDER BY item.platform, item.title, item.id)
    FROM response_mismatches item
  ), '[]'::jsonb),
  'falseAlerts', COALESCE((
    SELECT jsonb_agg(to_jsonb(item) ORDER BY item.alert_created_at, item.alert_id)
    FROM false_alerts item
  ), '[]'::jsonb),
  'patrolContinuity', (
    SELECT to_jsonb(item) FROM patrol_continuity item
  )
)) AS repair_preview;

ROLLBACK;
