import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { api } from './api'

interface User {
  id: string
  email: string
  name: string
  globalRole: string
  is_internal: boolean
  memberships?: Array<{ tenantId: string; tenantName: string; role: string; status: string }>
}

interface Tenant {
  id: string
  name: string
  status?: string
  created_at?: string
}

interface AuthState {
  user: User | null
  tenants: Tenant[]
  tenantId: string
  loading: boolean
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  switchTenant: (id: string) => void
  isInternal: () => boolean
  isPlatformAdmin: () => boolean
  canWrite: () => boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    tenants: [],
    tenantId: '',
    loading: true,
  })

  const isInternal = useCallback(() => {
    return state.user?.is_internal || ['platform_admin', 'internal_operator'].includes(state.user?.globalRole || '')
  }, [state.user])

  const isPlatformAdmin = useCallback(() => {
    return state.user?.globalRole === 'platform_admin'
  }, [state.user])

  const canWrite = useCallback(() => {
    if (isInternal()) return true
    const membership = state.user?.memberships?.find(m => m.tenantId === state.tenantId)
    return membership ? ['tenant_admin', 'tenant_analyst'].includes(membership.role) : false
  }, [state.user, state.tenantId, isInternal])

  const loadTenants = useCallback(async (user: User) => {
    let tenants: Tenant[] = []
    const internal = user.is_internal || ['platform_admin', 'internal_operator'].includes(user.globalRole)

    if (internal) {
      const data = await api.get<{ tenants: Tenant[] }>('/admin/tenants', { skipTenant: true })
      tenants = data.tenants || []
    } else {
      tenants = (user.memberships || [])
        .filter(m => m.status === 'active')
        .map(m => ({ id: m.tenantId, name: m.tenantName }))
    }

    const saved = localStorage.getItem('osv_tenant_id')
    const tenantId = tenants.some(t => t.id === saved) ? saved! : (tenants[0]?.id || '')
    api.setTenant(tenantId)

    setState(prev => ({ ...prev, user, tenants, tenantId, loading: false }))
  }, [])

  useEffect(() => {
    api.get<{ ok: boolean; user: User }>('/auth/me', { skipTenant: true })
      .then(data => {
        if (data.ok && data.user) {
          loadTenants(data.user)
        } else {
          setState(prev => ({ ...prev, loading: false }))
        }
      })
      .catch(() => {
        setState(prev => ({ ...prev, loading: false }))
      })
  }, [loadTenants])

  const login = async (email: string, password: string) => {
    const data = await api.post<{ user: User }>('/auth/login', { email, password }, { skipTenant: true })
    await loadTenants(data.user)
  }

  const logout = async () => {
    await api.post('/auth/logout', undefined, { skipTenant: true }).catch(() => {})
    setState({ user: null, tenants: [], tenantId: '', loading: false })
  }

  const switchTenant = (id: string) => {
    localStorage.setItem('osv_tenant_id', id)
    api.setTenant(id)
    setState(prev => ({ ...prev, tenantId: id }))
  }

  return (
    <AuthContext.Provider value={{ ...state, login, logout, switchTenant, isInternal, isPlatformAdmin, canWrite }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
