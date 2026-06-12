import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

export type PageParams = Record<string, string>

interface NavContextValue {
  page: string
  params: PageParams | null
  /** seq 仅在带 params 的导航时自增,用于强制重挂载目标页以消费一次性预置筛选 */
  seq: number
  navigate: (page: string, params?: PageParams) => void
}

/**
 * 旧页面 id → 新信息架构映射。收件箱/线索/问题合入工作台,监控任务/命中合入监控中心,
 * 看板/报告合入分析与报告。初始读取 localStorage 与每次 navigate 都过此映射,
 * 兼容老用户残留的 osv_page 以及历史入口。
 */
export const LEGACY_PAGE_MAP: Record<string, { page: string; params?: PageParams }> = {
  triage: { page: 'workbench', params: { queue: 'triage' } },
  leads: { page: 'workbench', params: { queue: 'leads' } },
  issues: { page: 'workbench', params: { queue: 'issues' } },
  monitor: { page: 'monitoring', params: { tab: 'tasks' } },
  'monitor-hits': { page: 'monitoring', params: { tab: 'hits' } },
  analytics: { page: 'insights', params: { tab: 'dashboard' } },
  reports: { page: 'insights', params: { tab: 'reports' } },
}

export function normalizePage(page: string, params?: PageParams): { page: string; params: PageParams | null } {
  const mapped = LEGACY_PAGE_MAP[page]
  if (mapped) {
    return { page: mapped.page, params: { ...(mapped.params || {}), ...(params || {}) } }
  }
  return { page, params: params && Object.keys(params).length ? params : null }
}

const NavContext = createContext<NavContextValue | null>(null)

export function NavProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(() => {
    const stored = localStorage.getItem('osv_page') || 'overview'
    const norm = normalizePage(stored)
    return { page: norm.page, params: norm.params, seq: 0 }
  })

  const navigate = useCallback((page: string, params?: PageParams) => {
    const norm = normalizePage(page, params)
    // localStorage 只存归一化后的 page,绝不存 params(params 是一次性预置)
    localStorage.setItem('osv_page', norm.page)
    setState(prev => ({
      page: norm.page,
      params: norm.params,
      seq: norm.params ? prev.seq + 1 : prev.seq,
    }))
  }, [])

  return (
    <NavContext.Provider value={{ ...state, navigate }}>
      {children}
    </NavContext.Provider>
  )
}

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext)
  if (!ctx) throw new Error('useNav must be used within NavProvider')
  return ctx
}
