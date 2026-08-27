export function allocateKeywordRetryItems({
  items = [],
  candidates = [],
  overrides = {},
} = {}) {
  const candidateById = new Map(
    candidates.map(candidate => [String(candidate.id || ''), candidate]),
  );
  const reservedAgentIds = new Set(
    Object.values(overrides)
      .map(agentId => String(agentId || '').trim())
      .filter(agentId => candidateById.has(agentId)),
  );
  const automaticAgents = candidates.filter(
    agent => !reservedAgentIds.has(String(agent.id || '')),
  );
  let automaticIndex = 0;
  return items.map(item => {
    const overrideAgentId = String(overrides[item.id] || '').trim();
    const agent = overrideAgentId
      ? candidateById.get(overrideAgentId) || null
      : automaticAgents[automaticIndex++] || null;
    return {
      item,
      agent,
      overrideAgentId,
      overridden: Boolean(overrideAgentId),
      strictWaiting: Boolean(overrideAgentId && !agent),
    };
  });
}

export function buildKeywordRetryAssignments({items = [], overrides = {}} = {}) {
  return items.flatMap(item => {
    const agentId = String(overrides[item.id] || '').trim();
    return agentId ? [{itemId: item.id, agentId}] : [];
  });
}
