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
