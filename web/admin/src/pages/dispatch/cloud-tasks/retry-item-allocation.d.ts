export interface KeywordRetryItemLike {
  id: string
}

export interface KeywordRetryAgentLike {
  id: string
}

export interface KeywordRetryAllocation<Item, Agent> {
  item: Item
  agent: Agent | null
  overrideAgentId: string
  overridden: boolean
  strictWaiting: boolean
}

export function allocateKeywordRetryItems<
  Item extends KeywordRetryItemLike,
  Agent extends KeywordRetryAgentLike,
>(input: {
  items?: Item[]
  candidates?: Agent[]
  overrides?: Record<string, string>
}): Array<KeywordRetryAllocation<Item, Agent>>

export function buildKeywordRetryAssignments<
  Item extends KeywordRetryItemLike,
>(input: {
  items?: Item[]
  overrides?: Record<string, string>
}): Array<{itemId: string; agentId: string}>
