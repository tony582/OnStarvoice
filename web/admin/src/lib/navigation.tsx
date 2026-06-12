import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

export type PageParams = Record<string, string>
export type Workspace = 'opinion' | 'content'

interface NavContextValue {
  workspace: Workspace
  page: string
  params: PageParams | null
  /** seq 仅在带 params 的导航时自增,用于强制重挂载目标页以消费一次性预置筛选 */
  seq: number
  navigate: (page: string, params?: PageParams) => void
  switchWorkspace: (ws: Workspace) => void
}

/** 每个工作区的默认首页 */
export const WORKSPACE_HOME: Record<Workspace, string> = {
  opinion: 'overview',
  content: 'content-home',
}

/** 页面 → 所属工作区(导航到他面页面会自动切面;未列出的=管理页,留在当前面) */
export const PAGE_WORKSPACE: Record<string, Workspace> = {
  overview: 'opinion', workbench: 'opinion', monitoring: 'opinion',
  insights: 'opinion', data: 'opinion', events: 'opinion',
  'content-home': 'content', tracks: 'content', hits: 'content',
  benchmarks: 'content', keywords: 'content', review: 'content',
}

/** 旧页面 id → 新信息架构映射(兼容老 localStorage / 历史入口) */
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
  if (mapped) return { page: mapped.page, params: { ...(mapped.params || {}), ...(params || {}) } }
  return { page, params: params && Object.keys(params).length ? params : null }
}

const NavContext = createContext<NavContextValue | null>(null)

function readInitial(): { workspace: Workspace; page: string } {
  const ws = (localStorage.getItem('osv_workspace') as Workspace) || 'opinion'
  const workspace: Workspace = ws === 'content' ? 'content' : 'opinion'
  // 兼容老 key osv_page → 归到舆情面
  const legacy = localStorage.getItem('osv_page')
  const stored = localStorage.getItem(`osv_page_${workspace}`) || (workspace === 'opinion' ? legacy : null)
  const norm = normalizePage(stored || WORKSPACE_HOME[workspace])
  // 归一化后页面若属于另一面,以页面归属为准
  const realWs = PAGE_WORKSPACE[norm.page] || workspace
  return { workspace: realWs, page: norm.page }
}

export function NavProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(() => {
    const init = readInitial()
    return { workspace: init.workspace, page: init.page, params: null as PageParams | null, seq: 0 }
  })

  const navigate = useCallback((page: string, params?: PageParams) => {
    const norm = normalizePage(page, params)
    setState(prev => {
      const ws = PAGE_WORKSPACE[norm.page] || prev.workspace
      localStorage.setItem('osv_workspace', ws)
      localStorage.setItem(`osv_page_${ws}`, norm.page)
      return { workspace: ws, page: norm.page, params: norm.params, seq: norm.params ? prev.seq + 1 : prev.seq }
    })
  }, [])

  const switchWorkspace = useCallback((ws: Workspace) => {
    setState(prev => {
      if (ws === prev.workspace) return prev
      const last = localStorage.getItem(`osv_page_${ws}`)
      const page = last && PAGE_WORKSPACE[last] === ws ? last : WORKSPACE_HOME[ws]
      localStorage.setItem('osv_workspace', ws)
      localStorage.setItem(`osv_page_${ws}`, page)
      return { workspace: ws, page, params: null, seq: prev.seq + 1 }
    })
  }, [])

  return (
    <NavContext.Provider value={{ ...state, navigate, switchWorkspace }}>
      {children}
    </NavContext.Provider>
  )
}

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext)
  if (!ctx) throw new Error('useNav must be used within NavProvider')
  return ctx
}
