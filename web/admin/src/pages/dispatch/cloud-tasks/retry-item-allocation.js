export function allocateKeywordRetryItems({
  items = [],
  candidates = [],
  overrides = {},
  attemptedAgentIdsByItem = {},
} = {}) {
  const candidateById = new Map(
    candidates.map(candidate => [String(candidate.id || ''), candidate]),
  );
  const attemptedForItem = itemId => new Set(
    attemptedAgentIdsByItem instanceof Map
      ? attemptedAgentIdsByItem.get(String(itemId || '')) || []
      : attemptedAgentIdsByItem?.[String(itemId || '')] || [],
  );
  const reservedAgentIds = new Set();
  for (const item of items) {
    const overrideAgentId = String(overrides[item.id] || '').trim();
    if (
      overrideAgentId &&
      candidateById.has(overrideAgentId) &&
      !attemptedForItem(item.id).has(overrideAgentId)
    ) {
      reservedAgentIds.add(overrideAgentId);
    }
  }
  const usedAgentIds = new Set();
  return items.map(item => {
    const attemptedAgentIds = attemptedForItem(item.id);
    const overrideAgentId = String(overrides[item.id] || '').trim();
    let agent = overrideAgentId && !attemptedAgentIds.has(overrideAgentId)
      ? candidateById.get(overrideAgentId) || null
      : null;
    if (agent && usedAgentIds.has(String(agent.id || ''))) agent = null;
    if (!agent) {
      agent = candidates.find(candidate => {
        const candidateId = String(candidate.id || '');
        return Boolean(
          candidateId &&
          !usedAgentIds.has(candidateId) &&
          !attemptedAgentIds.has(candidateId) &&
          (
            !reservedAgentIds.has(candidateId) ||
            candidateId === overrideAgentId
          )
        );
      }) || null;
    }
    if (agent) usedAgentIds.add(String(agent.id || ''));
    return {
      item,
      agent,
      overrideAgentId,
      overridden: Boolean(
        overrideAgentId && String(agent?.id || '') === overrideAgentId,
      ),
      preferenceFallback: Boolean(
        overrideAgentId && String(agent?.id || '') !== overrideAgentId,
      ),
      preferredAgentAlreadyAttempted: Boolean(
        overrideAgentId && attemptedAgentIds.has(overrideAgentId),
      ),
    };
  });
}

export function buildKeywordRetryAssignments({items = [], overrides = {}} = {}) {
  return items.flatMap(item => {
    const agentId = String(overrides[item.id] || '').trim();
    return agentId ? [{itemId: item.id, agentId}] : [];
  });
}

// 与服务端 POST /orchestrations/:id/retry-items 的来源闸门一致
// （capture-orchestrations.js HANDOFF_SOURCE_FINAL_STATUSES 或
// stopFenceReleasedRetrySource）：原执行已结算，或是运营「确认旧页面已停止」
// 放行的批次子任务（superseded + terminalReason，且没有接力/恢复后继）。
// 只要一条来源不满足，整次请求就会 409 retry_source_not_settled，所以管理端
// 只能提交满足这条规则的关键词。
const MANUAL_RETRY_SOURCE_FINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'skipped',
]);
const STOP_FENCE_OPERATOR_RELEASED_REASON = 'stop_fence_operator_released';
// 弹性池自动接力（心跳领取）对 retryable 关键词的来源要求更宽：原执行停在
// 需处理/中断也可以由其他节点领取。
const ELASTIC_CLAIM_SOURCE_RELEASED_STATUSES = new Set([
  ...MANUAL_RETRY_SOURCE_FINAL_STATUSES,
  'superseded',
  'needs_action',
  'interrupted',
]);

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function manualKeywordRetrySourceSettled(execution) {
  if (!execution) return false;
  const status = String(execution.status || '');
  if (MANUAL_RETRY_SOURCE_FINAL_STATUSES.has(status)) return true;
  const metadata = plainObject(execution.metadata);
  return status === 'superseded' &&
    metadata.terminalReason === STOP_FENCE_OPERATOR_RELEASED_REASON &&
    !String(metadata.handoffSuccessorTaskId || '').trim() &&
    !String(metadata.recoveryTaskId || '').trim();
}

// 手机执行（douyin_mobile_discovery）的关键词不能在原批次里「重试失败关键词」：
// 手机不读重试下发的指令，服务端整单 409 retry_items_mobile_source
// （capture-orchestrations.js RETRY_ITEMS_MOBILE_SOURCE_MESSAGE），需要新建手机批次重采。
export const MOBILE_KEYWORD_RETRY_WORKFLOW = 'douyin_mobile_discovery';
export const MOBILE_KEYWORD_RETRY_UNSUPPORTED_TEXT =
  '手机采集的关键词不能在原批次里重试（手机不接收重试任务）；需要重采请新建手机采集批次';

export function mobileKeywordRetrySource(execution) {
  return plainObject(execution?.metadata).workflow === MOBILE_KEYWORD_RETRY_WORKFLOW;
}

// retryable 关键词在弹性池里由自动接力负责（按领取闸门判断）；其余关键词要走
// 「重试失败关键词」，按服务端人工重试闸门判断。
export function keywordRetrySourceReleased({item, execution, elasticPool = false} = {}) {
  if (!execution) return false;
  if (elasticPool && item?.status === 'retryable') {
    return ELASTIC_CLAIM_SOURCE_RELEASED_STATUSES.has(String(execution.status || ''));
  }
  if (mobileKeywordRetrySource(execution)) return false;
  return manualKeywordRetrySourceSettled(execution);
}
