import { useAuth } from '@/lib/auth'
import { customerAssistantApi } from '@/lib/customer-assistant'
import { CustomerAssistantWorkspace } from '@/pages/customer-assistant/CustomerAssistantWorkspace'

export function CustomerAssistantPage() {
  const { user, tenantId, tenants } = useAuth()
  const canManage = ['platform_admin', 'internal_operator'].includes(user?.globalRole || '')
  if (!canManage) return <div className="rounded-xl border border-border bg-card p-6"><h1 className="text-lg font-semibold">客户助手</h1><p className="mt-2 text-sm text-muted-foreground">客户助手接入与试用仅供管理员使用。</p></div>
  return <CustomerAssistantWorkspace key={tenantId} service={customerAssistantApi} tenantName={tenants.find(tenant => tenant.id === tenantId)?.name} />
}
