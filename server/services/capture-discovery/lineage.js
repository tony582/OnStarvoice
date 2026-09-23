import {DiscoveryError} from './validation.js';

export async function authorizePrincipal(tx, principal) {
  const agent = await tx.queryOne(`
    SELECT agent.id, agent.capabilities, agent.allowed_platforms
    FROM capture_agents agent
    JOIN tenants tenant ON tenant.id = agent.tenant_id AND tenant.status = 'active'
    JOIN auth_codes code ON code.id = agent.auth_code_id AND code.tenant_id = agent.tenant_id
      AND code.status = 'active' AND (code.expires_at IS NULL OR code.expires_at >= now())
    JOIN auth_bindings binding ON binding.id = agent.auth_binding_id AND binding.code_id = code.id
    WHERE agent.id = $1 AND agent.tenant_id = $2 AND agent.status = 'active'
      AND code.id = $3 AND binding.id = $4
  `, [principal.agentId, principal.tenantId, principal.authCodeId, principal.authBindingId]);
  if (!agent || agent.capabilities?.agentKind !== 'android_mobile'
      || agent.capabilities?.mobileSearchDiscoveryV1 !== true
      || !agent.allowed_platforms?.includes('douyin')) {
    throw new DiscoveryError('MOBILE_AGENT_NOT_AUTHORIZED', 403);
  }
}

export async function loadLineage(tx, principal, event) {
  // History proves origin; current item state only determines whether delivery
  // may satisfy a live demand. Old real attempts can still leave audit evidence.
  return tx.queryOne(`
    SELECT task.status AS task_status, task.platform,
      task.metadata->>'workflow' AS workflow,
      task.metadata->>'deadlineAt' AS deadline_at,
      (COALESCE(task.metadata->>'stopCommandId', '') <> ''
        OR task.metadata->>'stopRequested' = 'true') AS stop_requested,
      item.keyword, item.status AS item_status,
      item.assigned_agent_id AS current_agent_id, item.execution_task_id,
      item.assignment_revision, item.attempt_count, item.request_hash AS current_request_hash,
      attempt.attempt_number, attempt.status AS attempt_status
    FROM capture_task_item_attempts attempt
    JOIN capture_task_items item ON item.id = attempt.item_id AND item.tenant_id = attempt.tenant_id
    JOIN capture_tasks task ON task.id = attempt.execution_task_id AND task.tenant_id = attempt.tenant_id
    WHERE attempt.id = $1 AND attempt.tenant_id = $2 AND attempt.item_id = $3
      AND attempt.agent_id = $4 AND attempt.execution_task_id = $5
      AND attempt.parent_task_id = $5 AND item.task_id = $5
      AND attempt.assignment_revision = $6 AND attempt.request_hash = $7
    FOR SHARE OF task, item, attempt
  `, [event.attemptId, principal.tenantId, event.itemId, principal.agentId,
    event.taskId, event.assignmentRevision, event.requestHash]);
}
