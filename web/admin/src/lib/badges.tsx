import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
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
  // 标识当前生效的拉取批次:租户切换/卸载时递增,丢弃在途的旧响应,避免计数串租户
  const tokenRef = useRef(0)
  const invalidatePending = useCallback(() => {
    tokenRef.current += 1
  }, [])

  // fresh=1：调用方刚改过数据，服务端必须在这次请求之后重新计数；
  // 定时与切回页面的读取不带它，可复用服务端 20 秒内的结果。
  const read = useCallback((fresh: boolean) => {
    if (!user || !tenantId) return
    const token = ++tokenRef.current
    api.get<{ ok: boolean; badges: Badges; features?: Partial<WorkspaceFeatures> }>(
      fresh ? '/workspace/badges?fresh=1' : '/workspace/badges',
    )
      .then(data => {
        if (token === tokenRef.current && data?.ok) {
          const commentRiskAttentionEnabled = data.features?.commentRiskAttentionEnabled !== false
          setBadgeState({
            scope: badgeScope,
            badges: { ...EMPTY, ...(data.badges || {}) },
            features: {
              loaded: true,
              commentRiskAttentionEnabled,
            },
          })
        }
      })
      .catch(() => {})
  }, [badgeScope, user, tenantId])
  const refresh = useCallback(() => read(true), [read])

  useEffect(() => {
    invalidatePending() // 租户变更立即作废在途请求
    read(false)
    const timer = window.setInterval(() => read(false), POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') read(false) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      invalidatePending()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [invalidatePending, read])

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
