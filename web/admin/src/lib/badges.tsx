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
}

const EMPTY: Badges = { triagePending: 0, leadsNew: 0, issuesOpen: 0, monitorAttention: 0, ticketsPending: 0, ticketsFeedback: 0 }

interface BadgesContextValue {
  badges: Badges
  refresh: () => void
}

const BadgesContext = createContext<BadgesContextValue | null>(null)

const POLL_MS = 60_000

export function BadgesProvider({ children }: { children: ReactNode }) {
  const { tenantId, user } = useAuth()
  const [badges, setBadges] = useState<Badges>(EMPTY)
  // 标识当前生效的拉取批次:租户切换/卸载时递增,丢弃在途的旧响应,避免计数串租户
  const tokenRef = useRef(0)

  const refresh = useCallback(() => {
    if (!user || !tenantId) {
      setBadges(EMPTY)
      return
    }
    const token = ++tokenRef.current
    api.get<{ ok: boolean; badges: Badges }>('/workspace/badges')
      .then(data => {
        if (token === tokenRef.current && data?.ok) setBadges(data.badges || EMPTY)
      })
      .catch(() => {})
  }, [user, tenantId])

  useEffect(() => {
    tokenRef.current++ // 租户变更立即作废在途请求
    setBadges(EMPTY)
    refresh()
    const timer = window.setInterval(refresh, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      tokenRef.current++
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  return (
    <BadgesContext.Provider value={{ badges, refresh }}>
      {children}
    </BadgesContext.Provider>
  )
}

export function useBadges(): BadgesContextValue {
  const ctx = useContext(BadgesContext)
  if (!ctx) throw new Error('useBadges must be used within BadgesProvider')
  return ctx
}
