// The orchestration parent projection (refreshOrchestrationParentTask) still lives in the HTTP layer.
// Services never import routes: the route layer registers the projector once at load, and an
// orchestration child completing without a registered projector is a wiring fault, not a silent skip.
let projector = null;
export function registerOrchestrationParentProjector(fn) {
  if (typeof fn !== 'function') throw new TypeError('orchestration_parent_projector_required');
  projector = fn;
}
export async function refreshOrchestrationParent(tx, tenantId, child, agentId) {
  if (!child?.metadata?.orchestrationChild || !child.parent_task_id) return;
  if (typeof projector !== 'function') throw new Error('orchestration_parent_projector_unregistered');
  const at = new Date().toISOString();
  await projector(tx, {tenantId, parentTaskId: child.parent_task_id, childTaskId: child.id,
    actorType: 'system', actorName: '手机搜索发现', eventAgentId: agentId, snapshot: {heartbeatAt: at, updatedAt: at}});
}
