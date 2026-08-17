import {
  CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
} from '../../../services/capture-cloud.js';
import {
  normalizeCaptureResourcePolicy,
  projectCaptureResourceAdmission,
} from '../../../services/capture-resource-policy.js';
import {safeJson, text} from '../application/control-outcome-projection.js';

export function captureTaskResourcePolicy(task = {}) {
  const metadata = safeJson(task.metadata || task.parent_metadata);
  return normalizeCaptureResourcePolicy(
    safeJson(metadata.planSnapshot).resourcePolicy,
  );
}

export async function reserveCaptureResourceAdmission(tx, {
  tenantId,
  parentTaskId,
  agent,
  platform = '',
  resourcePolicy = {},
  expectedSearches = 1,
} = {}) {
  const policy = normalizeCaptureResourcePolicy(resourcePolicy);
  const hostLabel = text(agent?.host_label, 120).toLowerCase();
  const capacityGroup = text(policy.capacityGroup, 80).toLowerCase();
  const lockKeys = [
    ...(policy.maxActive ? [`plan:${parentTaskId}`] : []),
    ...(policy.maxActivePerHost && hostLabel
      ? [`host:${hostLabel}`]
      : []),
    ...(policy.maxActiveInGroup && capacityGroup
      ? [`group:${capacityGroup}`]
      : []),
  ].sort((left, right) => left.localeCompare(right));
  for (const lockKey of lockKeys) {
    await tx.execute(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['capture_resource_admission', `${tenantId}:${lockKey}`],
    );
  }
  const usagePlatform = text(platform, 40).toLowerCase();
  const counts = await tx.queryOne(`
    WITH occupied AS (
      SELECT
        active_task.id AS execution_id,
        active_task.parent_task_id,
        LOWER(BTRIM(active_agent.host_label)) AS host_label,
        LOWER(BTRIM(COALESCE(
          active_task.metadata->'planSnapshot'->'resourcePolicy'->>'capacityGroup',
          ''
        ))) AS capacity_group
      FROM capture_tasks active_task
      JOIN capture_agents active_agent
        ON active_agent.id = COALESCE(
          active_task.assigned_agent_id,
          active_task.origin_agent_id
        )
        AND active_agent.tenant_id = active_task.tenant_id
      WHERE active_task.tenant_id = $1
        AND active_task.task_type <> 'capture_orchestration'
        AND active_task.status = ANY($5::text[])

      UNION

      SELECT
        active_command.task_id AS execution_id,
        command_task.parent_task_id,
        LOWER(BTRIM(command_agent.host_label)) AS host_label,
        LOWER(BTRIM(COALESCE(
          command_task.metadata->'planSnapshot'->'resourcePolicy'->>'capacityGroup',
          ''
        ))) AS capacity_group
      FROM capture_agent_commands active_command
      JOIN capture_agents command_agent
        ON command_agent.id = active_command.agent_id
        AND command_agent.tenant_id = active_command.tenant_id
      LEFT JOIN capture_tasks command_task
        ON command_task.id = active_command.task_id
        AND command_task.tenant_id = active_command.tenant_id
      WHERE active_command.tenant_id = $1
        AND active_command.status IN ('pending', 'acknowledged')
        AND (
          active_command.expires_at IS NULL OR
          active_command.expires_at > now()
        )
    )
    SELECT
      COUNT(DISTINCT execution_id)
        FILTER (WHERE parent_task_id = $2)::integer AS plan_active,
      COUNT(DISTINCT execution_id)
        FILTER (WHERE host_label = $3)::integer AS host_active,
      COUNT(DISTINCT execution_id)
        FILTER (WHERE capacity_group = $7)::integer AS group_active,
      COALESCE((
        SELECT daily_usage.searches
        FROM social_agent_daily_usage daily_usage
        WHERE daily_usage.tenant_id = $1
          AND daily_usage.agent_id = $4
          AND daily_usage.platform = $6
          AND daily_usage.usage_date =
            (now() AT TIME ZONE 'Asia/Shanghai')::date
      ), 0)::integer AS today_searches,
      COALESCE((
        SELECT account.daily_search_limit
        FROM social_account_bindings binding
        JOIN social_accounts account
          ON account.tenant_id = binding.tenant_id
          AND account.id = binding.social_account_id
        WHERE binding.tenant_id = $1
          AND binding.agent_id = $4
          AND binding.platform = $6
          AND binding.status = 'current'
        ORDER BY binding.first_seen_at DESC, binding.id DESC
        LIMIT 1
      ), 0)::integer AS daily_search_limit
    FROM occupied
  `, [
    tenantId,
    parentTaskId,
    hostLabel,
    agent.id,
    CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
    usagePlatform,
    capacityGroup,
  ]);
  return projectCaptureResourceAdmission({
    resourcePolicy: policy,
    hostLabel,
    planActive: counts?.plan_active,
    hostActive: counts?.host_active,
    groupActive: counts?.group_active,
    todaySearches: counts?.today_searches,
    expectedSearches,
    dailySearchLimit: counts?.daily_search_limit,
  });
}
