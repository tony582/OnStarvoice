import { usePolling } from '@/hooks/usePolling'
import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react'
import { api } from './api'
import { useAuth } from './auth'

export interface Badges {
  triagePending: number
  leadsNew: number
  issuesOpen: number
  monitorAttention: number
  ticketsPending: number
  ticketsFeedback: number
  feedbackPending: number
}

export interface WorkspaceFeatures {
  loaded: boolean
  commentRiskAttentionEnabled: boolean
}

const EMPTY: Badges = {
  triagePending: 0,
  leadsNew: 0,
  issuesOpen: 0,
  monitorAttention: 0,
  ticketsPending: 0,
  ticketsFeedback: 0,
  feedbackPending: 0,
}

// 切换租户或尚未加载时先不制造评论待办；服务端对旧租户的正式缺省仍是开启。
const EMPTY_FEATURES: WorkspaceFeatures = {
  loaded: false,
  commentRiskAttentionEnabled: false,
}

interface BadgesContextValue {
  badges: Badges
  features: WorkspaceFeatures
  refresh: () => void
}

const BadgesContext = createContext<BadgesContextValue | null>(null)

const POLL_MS = 60_000

export function BadgesProvider({ children }: { children: ReactNode }) {
  const { tenantId, user } = useAuth()
  const badgeScope = user && tenantId ? `${user.id}:${tenantId}` : ''
  const [badgeState, setBadgeState] = useState<{ scope: string; badges: Badges; features: WorkspaceFeatures }>({
    scope: '',
    badges: EMPTY,
    features: EMPTY_FEATURES,
  })
  const badges = badgeState.scope === badgeScope ? badgeState.badges : EMPTY
  const features = badgeState.scope === badgeScope ? badgeState.features : EMPTY_FEATURES
  // Mutation refreshes must bypass the server cache; keep that intent until a
  // successful read so aborting a hidden tab cannot lose it.
  const freshScopeRef = useRef({ scope: '', revision: 0 })
  const read = useCallback(async (signal: AbortSignal) => {
    if (!user || !tenantId) return
    const freshRequest = freshScopeRef.current
    const fresh = freshRequest.scope === badgeScope
    const data = await api.get<{ ok: boolean; badges: Badges; features?: Partial<WorkspaceFeatures> }>(
      fresh ? '/workspace/badges?fresh=1' : '/workspace/badges', { signal },
    )
    if (signal.aborted || !data?.ok) return
    if (fresh && freshScopeRef.current === freshRequest) {
      freshScopeRef.current = { scope: '', revision: freshRequest.revision }
    }
    const commentRiskAttentionEnabled = data.features?.commentRiskAttentionEnabled !== false
    setBadgeState({
      scope: badgeScope,
      badges: { ...EMPTY, ...(data.badges || {}) },
      features: { loaded: true, commentRiskAttentionEnabled },
    })
  }, [badgeScope, user, tenantId])
  const { refresh: refreshPolling } = usePolling(read, {
    intervalMs: POLL_MS, enabled: !!badgeScope, resetKey: badgeScope,
  })
  const refresh = useCallback(() => {
    freshScopeRef.current = { scope: badgeScope, revision: freshScopeRef.current.revision + 1 }
    void refreshPolling()
  }, [badgeScope, refreshPolling])

  return (
    <BadgesContext.Provider value={{ badges, features, refresh }}>
      {children}
    </BadgesContext.Provider>
  )
}

export function useBadges(): BadgesContextValue {
  const ctx = useContext(BadgesContext)
  if (!ctx) throw new Error('useBadges must be used within BadgesProvider')
  return ctx
}
