import {DiscoveryError} from './validation.js';

const ACTIVE_TASK = new Set(['claimed', 'running', 'recovering']);
const ACTIVE_ITEM = new Set(['dispatched', 'running']);

export function validateLineage(lineage, event, now = Date.now()) {
  if (!lineage) throw new DiscoveryError('ATTEMPT_LINEAGE_MISMATCH', 403);
  if (lineage.workflow !== 'douyin_mobile_discovery' || lineage.platform !== 'douyin'
      || lineage.keyword !== event.keyword) throw new DiscoveryError('DISCOVERY_TASK_MISMATCH', 403);
  const deadline = Date.parse(lineage.deadline_at);
  const current = lineage.current_agent_id === event.agentId
    && lineage.execution_task_id === event.taskId
    && lineage.assignment_revision === event.assignmentRevision
    && lineage.attempt_count === lineage.attempt_number
    && lineage.current_request_hash === event.requestHash;
  const active = current && ACTIVE_TASK.has(lineage.task_status)
    && ACTIVE_ITEM.has(lineage.item_status) && ACTIVE_ITEM.has(lineage.attempt_status)
    && !lineage.stop_requested && Number.isFinite(deadline) && deadline > now;
  return {late: event.deliveryMode === 'late_audit' || !active};
}

export function candidateOutcome(record) {
  return record
    ? {status: 'already_exists', demandStatus: record.business_visibility === 'eligible' ? 'fulfilled' : 'needs_action'}
    : {status: 'queued', demandStatus: 'active'};
}
