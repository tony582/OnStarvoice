\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = 'official_content_workflow_repair_20260801_v1'
  ) THEN
    RAISE EXCEPTION 'official content workflow repair was already applied';
  END IF;
END
$guard$;

CREATE TEMP TABLE official_type_repairs ON COMMIT DROP AS
SELECT DISTINCT ON (record.id)
  record.id AS record_id,
  record.record_type AS previous_record_type,
  account.id AS official_account_id
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
WHERE record.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND record.record_type NOT IN ('official_content', 'blogger_profile')
ORDER BY record.id, account.id;

CREATE TEMP TABLE safe_mode_repairs ON COMMIT DROP AS
WITH first_automatic AS (
  SELECT DISTINCT ON (audit.target_id)
    audit.target_id,
    audit.metadata->>'previousStatus' AS previous_status,
    audit.created_at AS first_automatic_at
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
  ORDER BY audit.target_id, audit.created_at, audit.id
),
last_automatic AS (
  SELECT DISTINCT ON (audit.target_id)
    audit.target_id,
    audit.action AS last_action,
    audit.created_at AS last_automatic_at
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
)
SELECT
  triage.record_id,
  triage.status AS previous_status,
  first_automatic.previous_status AS restored_status,
  last_automatic.last_action
FROM first_automatic
JOIN last_automatic USING (target_id)
JOIN record_triage triage
  ON triage.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND triage.record_id::text = first_automatic.target_id
WHERE first_automatic.previous_status = 'unhandled'
  AND abs(extract(epoch FROM (
    triage.updated_at - last_automatic.last_automatic_at
  ))) < 1
  AND triage.priority = 'normal'
  AND triage.owner_user_id IS NULL
  AND btrim(triage.owner_name) = ''
  AND btrim(triage.note) = ''
  AND triage.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM audit_logs later_user
    WHERE later_user.tenant_id = triage.tenant_id
      AND later_user.target_type = 'record'
      AND later_user.target_id = first_automatic.target_id
      AND later_user.actor_type = 'user'
      AND later_user.created_at > first_automatic.first_automatic_at
  );

CREATE TEMP TABLE official_scope ON COMMIT DROP AS
SELECT record.id AS record_id
FROM records record
WHERE record.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND (
    record.record_type = 'official_content'
    OR record.id IN (SELECT record_id FROM official_type_repairs)
  );

CREATE TEMP TABLE official_fact_repairs ON COMMIT DROP AS
WITH facts AS (
  SELECT scope.record_id,
    count(comment.id) FILTER (WHERE comment.is_official)::integer
      AS official_count,
    count(comment.id) FILTER (
      WHERE comment.is_negative AND NOT comment.is_official
    )::integer AS negative_count,
    max(comment.last_seen_at) FILTER (
      WHERE comment.is_negative AND NOT comment.is_official
    ) AS latest_negative_at
  FROM official_scope scope
  LEFT JOIN record_comments comment
    ON comment.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
    AND comment.record_id = scope.record_id
  GROUP BY scope.record_id
)
SELECT record.id AS record_id,
  record.official_replied AS previous_official_replied,
  record.official_response_status AS previous_response_status,
  record.negative_comment_count AS previous_negative_count,
  (facts.official_count > 0) AS official_replied,
  CASE
    WHEN facts.official_count = 0 THEN 'none'
    WHEN facts.negative_count > 0 THEN 'needs_followup'
    ELSE 'responded'
  END AS response_status,
  facts.negative_count,
  facts.latest_negative_at
FROM facts
JOIN records record
  ON record.id = facts.record_id
  AND record.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
WHERE record.official_replied IS DISTINCT FROM (facts.official_count > 0)
  OR record.official_response_status IS DISTINCT FROM CASE
    WHEN facts.official_count = 0 THEN 'none'
    WHEN facts.negative_count > 0 THEN 'needs_followup'
    ELSE 'responded'
  END
  OR record.negative_comment_count IS DISTINCT FROM facts.negative_count;

CREATE TEMP TABLE false_alert_repairs ON COMMIT DROP AS
SELECT alert.id AS alert_id,
  alert.record_id,
  alert.issue_id,
  issue.status AS issue_status,
  issue.record_count,
  count(issue_event.id) FILTER (
    WHERE issue_event.actor_type = 'user'
  )::integer AS user_issue_events,
  (
    SELECT count(*)::integer
    FROM issue_records link
    WHERE link.issue_id = alert.issue_id
  ) AS issue_links,
  (
    SELECT count(*)::integer
    FROM issue_records link
    WHERE link.issue_id = alert.issue_id
      AND link.record_id NOT IN (SELECT record_id FROM official_scope)
  ) AS nonofficial_issue_links
FROM alerts alert
JOIN official_scope scope ON scope.record_id = alert.record_id
LEFT JOIN issues issue
  ON issue.tenant_id = alert.tenant_id
  AND issue.id = alert.issue_id
LEFT JOIN issue_events issue_event
  ON issue_event.tenant_id = alert.tenant_id
  AND issue_event.issue_id = issue.id
WHERE alert.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
GROUP BY alert.id, alert.record_id, alert.issue_id,
  issue.status, issue.record_count;

-- Lock every material row after the deterministic candidate sets are fixed.
SELECT record.id
FROM records record
WHERE record.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND record.id IN (SELECT record_id FROM official_scope)
ORDER BY record.id
FOR UPDATE;

SELECT triage.record_id
FROM record_triage triage
WHERE triage.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND triage.record_id IN (SELECT record_id FROM safe_mode_repairs)
ORDER BY triage.record_id
FOR UPDATE;

SELECT alert.id
FROM alerts alert
WHERE alert.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND alert.id IN (SELECT alert_id FROM false_alert_repairs)
ORDER BY alert.id
FOR UPDATE;

SELECT issue.id
FROM issues issue
WHERE issue.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND issue.id IN (SELECT issue_id FROM false_alert_repairs)
ORDER BY issue.id
FOR UPDATE;

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM official_type_repairs) <> 50 THEN
    RAISE EXCEPTION 'official content type candidate count changed';
  END IF;
  IF (SELECT count(*) FROM official_scope) <> 114 THEN
    RAISE EXCEPTION 'official content scope count changed';
  END IF;
  IF (SELECT count(*) FROM safe_mode_repairs) <> 83 THEN
    RAISE EXCEPTION 'safe processing-mode repair count changed';
  END IF;
  IF (SELECT count(*) FROM official_fact_repairs) <> 37 THEN
    RAISE EXCEPTION 'official response fact repair count changed';
  END IF;
  IF (SELECT count(*) FROM false_alert_repairs) <> 2 THEN
    RAISE EXCEPTION 'false official alert repair count changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM official_type_repairs candidate
    WHERE EXISTS (
      SELECT 1 FROM record_notes note
      WHERE note.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
        AND note.record_id = candidate.record_id
    )
    OR EXISTS (
      SELECT 1 FROM tickets ticket
      WHERE ticket.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
        AND ticket.source_record_id = candidate.record_id
    )
    OR EXISTS (
      SELECT 1 FROM audit_logs audit
      WHERE audit.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
        AND audit.target_type = 'record'
        AND audit.target_id = candidate.record_id::text
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
    )
  ) THEN
    RAISE EXCEPTION 'official content repair gained a manual workflow blocker';
  END IF;

  IF EXISTS (
    SELECT 1 FROM official_fact_repairs repair
    WHERE EXISTS (
      SELECT 1 FROM audit_logs audit
      WHERE audit.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
        AND audit.target_type = 'record'
        AND audit.target_id = repair.record_id::text
        AND audit.actor_type = 'user'
        AND audit.action = 'record.official_response_marked'
    )
  ) THEN
    RAISE EXCEPTION 'official response fact repair gained a manual override';
  END IF;

  IF EXISTS (
    SELECT 1 FROM false_alert_repairs
    WHERE issue_id IS NULL
      OR issue_status <> 'new'
      OR record_count <> 1
      OR user_issue_events <> 0
      OR issue_links <> 1
      OR nonofficial_issue_links <> 0
  ) THEN
    RAISE EXCEPTION 'false alert repair is no longer isolated and untouched';
  END IF;
END
$preflight$;

INSERT INTO audit_logs (
  tenant_id, actor_type, actor_id, action, target_type, target_id, metadata
)
SELECT
  '457e5851-93eb-4446-84e5-eb6ddb871e65',
  'system',
  'official-content-workflow-repair',
  'record.official_content_identified',
  'record',
  repair.record_id::text,
  jsonb_build_object(
    'previousRecordType', repair.previous_record_type,
    'nextRecordType', 'official_content',
    'source', 'strong_identity_historical_repair',
    'officialAccountId', repair.official_account_id,
    'processingModeChanged', false
  )
FROM official_type_repairs repair
ORDER BY repair.record_id;

UPDATE records record
SET record_type = 'official_content',
  updated_at = now()
FROM official_type_repairs repair
WHERE record.id = repair.record_id
  AND record.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND record.record_type = repair.previous_record_type;

INSERT INTO audit_logs (
  tenant_id, actor_type, actor_id, action, target_type, target_id, metadata
)
SELECT
  '457e5851-93eb-4446-84e5-eb6ddb871e65',
  'system',
  'official-content-workflow-repair',
  'record.processing_mode_repaired',
  'record',
  repair.record_id::text,
  jsonb_build_object(
    'previousStatus', repair.previous_status,
    'nextStatus', repair.restored_status,
    'lastAutomaticAction', repair.last_action,
    'reason', 'historical_comment_workflow_changed_processing_mode'
  )
FROM safe_mode_repairs repair
ORDER BY repair.record_id;

UPDATE record_triage triage
SET status = repair.restored_status,
  updated_at = now()
FROM safe_mode_repairs repair
WHERE triage.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND triage.record_id = repair.record_id
  AND triage.status = repair.previous_status;

INSERT INTO audit_logs (
  tenant_id, actor_type, actor_id, action, target_type, target_id, metadata
)
SELECT
  '457e5851-93eb-4446-84e5-eb6ddb871e65',
  'system',
  'official-content-workflow-repair',
  'record.official_response_facts_repaired',
  'record',
  repair.record_id::text,
  jsonb_build_object(
    'previousOfficialReplied', repair.previous_official_replied,
    'officialReplied', repair.official_replied,
    'previousResponseStatus', repair.previous_response_status,
    'responseStatus', repair.response_status,
    'previousNegativeCount', repair.previous_negative_count,
    'negativeCount', repair.negative_count
  )
FROM official_fact_repairs repair
ORDER BY repair.record_id;

UPDATE records record
SET official_replied = repair.official_replied,
  official_response_status = repair.response_status,
  negative_comment_count = repair.negative_count,
  latest_negative_comment_at = repair.latest_negative_at,
  updated_at = now()
FROM official_fact_repairs repair
WHERE record.id = repair.record_id
  AND record.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';

INSERT INTO audit_logs (
  tenant_id, actor_type, actor_id, action, target_type, target_id, metadata
)
SELECT
  '457e5851-93eb-4446-84e5-eb6ddb871e65',
  'system',
  'official-content-workflow-repair',
  'record.false_alert_removed',
  'record',
  repair.record_id::text,
  jsonb_build_object(
    'alertId', repair.alert_id,
    'issueId', repair.issue_id,
    'reason', 'record_confirmed_as_official_content'
  )
FROM false_alert_repairs repair
ORDER BY repair.record_id;

INSERT INTO issue_events (
  tenant_id, issue_id, event_type, body, actor_type, actor_name, metadata
)
SELECT
  '457e5851-93eb-4446-84e5-eb6ddb871e65',
  repair.issue_id,
  'system_repair',
  '关联内容已确认是官方账号原帖，误预警已撤销',
  'system',
  '官方内容工作流修复',
  jsonb_build_object(
    'alertId', repair.alert_id,
    'recordId', repair.record_id,
    'reason', 'record_confirmed_as_official_content'
  )
FROM false_alert_repairs repair
ORDER BY repair.issue_id;

DELETE FROM issue_records link
USING false_alert_repairs repair
WHERE link.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND link.issue_id = repair.issue_id
  AND link.record_id = repair.record_id
  AND link.alert_id = repair.alert_id;

DELETE FROM alerts alert
USING false_alert_repairs repair
WHERE alert.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND alert.id = repair.alert_id
  AND alert.record_id = repair.record_id
  AND alert.issue_id = repair.issue_id;

UPDATE issues issue
SET status = 'ignored',
  record_count = 0,
  updated_at = now()
FROM false_alert_repairs repair
WHERE issue.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
  AND issue.id = repair.issue_id
  AND issue.status = 'new'
  AND NOT EXISTS (
    SELECT 1 FROM issue_records link WHERE link.issue_id = issue.id
  );

INSERT INTO schema_migrations (version)
VALUES ('official_content_workflow_repair_20260801_v1');

COMMIT;
