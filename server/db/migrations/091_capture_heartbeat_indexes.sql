-- Indexes for the node heartbeat and the stop-fence admission SQL.
--
-- docs/hotfix/20260929-heartbeat-claim-load.md: every statement below read
-- each task a node (or the tenant) ever had and de-TOASTed `metadata` per row.
-- No statement changes; the predicates here repeat the statements' own
-- conditions verbatim so the planner can prove them, and
-- tests/capture-heartbeat-indexes.test.mjs pins that.
--
-- Release note: deploy.sh runs migrations while the previous process still
-- serves heartbeats. Create these beforehand with CREATE INDEX CONCURRENTLY
-- (docs/hotfix/20260929-heartbeat-claim-load.md) so this file finds them.

-- Rows that still carry the stop-fence code: the admission predicate
-- (captureTaskUnconfirmedLocalStopSql), the fence listing and the heartbeat
-- precheck.
CREATE INDEX IF NOT EXISTS idx_capture_tasks_stop_fence_unconfirmed
  ON capture_tasks (
    tenant_id,
    (COALESCE(assigned_agent_id, origin_agent_id)),
    status
  )
  WHERE UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED';

-- Released fences whose node still has to drop its local execution lock.
CREATE INDEX IF NOT EXISTS idx_capture_tasks_stop_fence_local_release
  ON capture_tasks (
    tenant_id,
    (COALESCE(assigned_agent_id, origin_agent_id))
  )
  WHERE UPPER(COALESCE(error->>'code', '')) = 'HISTORICAL_STOP_FENCE_RECONCILED'
    AND metadata #>> '{stopFenceCheck,localRelease,state}' = 'pending';

-- Work that can still own a node's execution slot
-- (CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES).
CREATE INDEX IF NOT EXISTS idx_capture_tasks_agent_slot_blocking
  ON capture_tasks (
    tenant_id,
    (COALESCE(assigned_agent_id, origin_agent_id)),
    status
  )
  WHERE status IN (
    'pending', 'waiting_device', 'claimed', 'running',
    'recovering', 'interrupted', 'resume_requested'
  );

-- Terminal notices of targeted patrol tasks (claimPriorityAgentControl).
CREATE INDEX IF NOT EXISTS idx_capture_tasks_terminal_notice
  ON capture_tasks (
    tenant_id,
    assigned_agent_id,
    (GREATEST(
      COALESCE(finished_at, '-infinity'::timestamptz),
      COALESCE(updated_at, '-infinity'::timestamptz)
    )),
    id
  )
  WHERE task_type IN (
      'negative_post_patrol',
      'watched_content_patrol',
      'official_account_comment_patrol',
      'followed_creator_post_patrol',
      'official_account_post_discovery'
    )
    AND (
      status IN ('canceled', 'superseded')
      OR metadata->>'terminalDisposition' IN ('canceled', 'superseded', 'revoked')
    );

-- Settled runs: the release proof of the 976a0c6 rule. Every column the
-- aggregation reads is here, so it never visits `metadata`.
CREATE INDEX IF NOT EXISTS idx_capture_tasks_settled_run_proof
  ON capture_tasks (tenant_id, status, platform)
  INCLUDE (assigned_agent_id, origin_agent_id, created_at, started_at, id)
  WHERE task_type IN ('capture', 'unattended_keyword_capture')
    AND finished_at >= started_at
    AND COALESCE(metadata->>'executionMode', '') NOT IN ('source_open', 'unattended_plan')
    AND metadata->>'stopPending' IS DISTINCT FROM 'true'
    AND UPPER(COALESCE(error->>'code', '')) <> 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED';

-- Accepted stop receipts: the proof for a settled run that was canceled.
CREATE INDEX IF NOT EXISTS idx_capture_agent_commands_accepted_stop
  ON capture_agent_commands (tenant_id, task_id, agent_id, finished_at)
  WHERE command_type = 'stop'
    AND status = 'completed'
    AND result->>'accepted' = 'true';
