import { useEffect, useState } from 'react'
import { Loader2, Building2, Users, KeyRound, Settings as SettingsIcon, Save } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { useAuth } from '@/lib/auth'

/* ==================== TenantsPage ==================== */
export function TenantsPage() {
  const [tenants, setTenants] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [msg, setMsg] = useState('')

  const load = () => api.get<any>('/admin/tenants', { skipTenant: true })
    .then(d => setTenants(d.tenants || [])).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const create = async () => {
    const n = name.trim()
    if (!n) return
    setCreating(true); setMsg('')
    try {
      const d = await api.post<any>('/admin/tenants', { name: n }, { skipTenant: true })
      setName('')
      setMsg(`已创建客户「${d.tenant?.name || n}」。下一步:到「用户账号」给它建管理员,到「激活码」给它生成激活码。`)
      load()
    } catch (err) {
      setMsg('创建失败:' + (err instanceof Error ? err.message : ''))
    } finally { setCreating(false) }
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-5 duration-300">
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 inline-flex items-center gap-1.5 text-sm font-bold"><Building2 className="h-4 w-4 text-primary" />新建客户(租户)</h2>
        <p className="mb-3 text-[12.5px] text-muted-foreground">每个客户(如「安吉星」)= 一个租户,数据完全隔离。建好后给它建账号、发激活码。</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <Field label="客户/租户名称">
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="例:安吉星 / 上汽通用 / 凯迪拉克"
                onKeyDown={e => { if (e.key === 'Enter') create() }} />
            </Field>
          </div>
          <Button onClick={create} disabled={creating || !name.trim()}>{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}新建客户</Button>
        </div>
        {msg && <p className="mt-3 text-[12.5px] font-medium text-status-green">{msg}</p>}
      </section>

      {loading ? <Spin /> : !tenants.length ? <EmptyState icon={Building2} title="暂无租户" /> : (
        <Table heads={['租户', '状态', '创建时间']}>
          {tenants.map(t => (
            <tr key={t.id} className="transition-colors hover:bg-muted/30">
              <td className="px-4 py-3 font-medium">{t.name}</td>
              <td className="px-4 py-3"><StatusBadge tone={t.status}>{t.status === 'active' ? '启用' : t.status}</StatusBadge></td>
              <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(t.created_at)}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}

/* ==================== UsersPage ==================== */
export function UsersPage() {
  const { tenants } = useAuth()
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ email: '', name: '', password: '', type: 'tenant', tenantId: '', role: 'tenant_viewer', globalRole: 'internal_operator' })

  const load = async () => {
    setLoading(true)
    const data = await api.get<any>('/admin/users', { skipTenant: true })
    setUsers(data.users || [])
    setLoading(false)
  }
  useEffect(() => { load(); if (tenants.length) setForm(f => ({ ...f, tenantId: tenants[0]?.id || '' })) }, [tenants])

  const createUser = async () => {
    const body: any = { email: form.email, name: form.name, password: form.password }
    if (form.type === 'internal') { body.globalRole = form.globalRole } else { body.tenantId = form.tenantId; body.tenantRole = form.role }
    await api.post('/admin/users', body, { skipTenant: true })
    load()
  }

  const resetPwd = async (id: string) => {
    const pw = prompt('新密码：')
    if (!pw) return
    await api.post('/admin/users/' + id + '/reset-password', { password: pw }, { skipTenant: true })
  }

  const toggleStatus = async (id: string, current: string) => {
    await api.patch('/admin/users/' + id, { status: current === 'active' ? 'disabled' : 'active' }, { skipTenant: true })
    load()
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-6 duration-300">
      {/* Create form */}
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-4 text-sm font-bold">创建账号</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="邮箱"><Input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} type="email" /></Field>
          <Field label="姓名"><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="初始密码"><Input value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} type="password" /></Field>
          <Field label="账号类型">
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm">
              <option value="tenant">客户账号</option><option value="internal">内部账号</option>
            </select>
          </Field>
          {form.type === 'tenant' && (
            <>
              <Field label="租户">
                <select value={form.tenantId} onChange={e => setForm({ ...form, tenantId: e.target.value })} className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm">
                  {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="角色">
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm">
                  <option value="tenant_viewer">只读</option><option value="tenant_analyst">分析员</option><option value="tenant_admin">管理员</option>
                </select>
              </Field>
            </>
          )}
          {form.type === 'internal' && (
            <Field label="内部角色">
              <select value={form.globalRole} onChange={e => setForm({ ...form, globalRole: e.target.value })} className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm">
                <option value="internal_operator">内部运营</option><option value="platform_admin">平台管理员</option>
              </select>
            </Field>
          )}
        </div>
        <div className="mt-4 flex justify-end"><Button onClick={createUser}>创建账号</Button></div>
      </section>

      {loading ? <Spin /> : !users.length ? <EmptyState icon={Users} title="暂无用户" /> : (
        <Table heads={['用户', '角色', '状态', '最近登录', '操作']}>
          {users.map(u => (
            <tr key={u.id} className="transition-colors hover:bg-muted/30">
              <td className="px-4 py-3"><div className="font-medium">{u.name || u.email}</div><div className="text-xs text-muted-foreground">{u.email}</div></td>
              <td className="px-4 py-3"><StatusBadge tone={u.global_role || 'viewer'}>{u.is_internal ? (LABELS.role[u.global_role] || u.global_role) : '客户'}</StatusBadge></td>
              <td className="px-4 py-3"><StatusBadge tone={u.status}>{u.status === 'active' ? '启用' : '禁用'}</StatusBadge></td>
              <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(u.last_login_at)}</td>
              <td className="px-4 py-3 text-right">
                <div className="flex justify-end gap-1">
                  <Button variant="outline" size="sm" onClick={() => resetPwd(u.id)}>重置密码</Button>
                  <Button variant={u.status === 'active' ? 'destructive' : 'default'} size="sm" onClick={() => toggleStatus(u.id, u.status)}>{u.status === 'active' ? '禁用' : '启用'}</Button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}

/* ==================== AuthCodesPage ==================== */
export function AuthCodesPage() {
  const [codes, setCodes] = useState<any[]>([])
  const [tenants, setTenants] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ tenantId: '', type: 'annual', ownerName: '' })
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState('')

  const load = async () => {
    setLoading(true)
    const [codeData, tenantData] = await Promise.all([
      api.get<any>('/admin/auth-codes', { skipTenant: true }),
      api.get<any>('/admin/tenants', { skipTenant: true }),
    ])
    setCodes(codeData.codes || [])
    const ts = tenantData.tenants || []
    setTenants(ts)
    setForm(f => ({ ...f, tenantId: f.tenantId || ts[0]?.id || '' }))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const create = async () => {
    if (!form.tenantId) return
    setCreating(true); setCreated('')
    try {
      const d = await api.post<any>('/admin/auth-codes', {
        type: form.type,
        ownerName: form.ownerName.trim(),
        tenantId: form.tenantId,
      }, { skipTenant: true })
      const tname = tenants.find(t => t.id === form.tenantId)?.name || ''
      setCreated(`已为「${tname}」生成激活码:${d.code}`)
      setForm(f => ({ ...f, ownerName: '' }))
      load()
    } catch (err) {
      setCreated('创建失败:' + (err instanceof Error ? err.message : ''))
    } finally { setCreating(false) }
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-5 duration-300">
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 inline-flex items-center gap-1.5 text-sm font-bold"><KeyRound className="h-4 w-4 text-primary" />生成激活码</h2>
        <p className="mb-3 text-[12.5px] text-muted-foreground">激活码绑定到某个客户(租户),该客户用此码采集的数据全部归属其租户。</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="归属客户(租户)">
            <select value={form.tenantId} onChange={e => setForm({ ...form, tenantId: e.target.value })} className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm">
              {tenants.length === 0 && <option value="">(先到「租户管理」建客户)</option>}
              {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="类型">
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm">
              <option value="trial">试用(7天)</option><option value="annual">年付(1年)</option><option value="permanent">永久</option>
            </select>
          </Field>
          <Field label="备注/联系人(选填)"><Input value={form.ownerName} onChange={e => setForm({ ...form, ownerName: e.target.value })} placeholder="例:安吉星-张经理" /></Field>
          <div className="flex items-end"><Button className="w-full" onClick={create} disabled={creating || !form.tenantId}>{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}生成激活码</Button></div>
        </div>
        {created && <p className="mt-3 text-[12.5px] font-medium text-status-green">{created}</p>}
      </section>

      {loading ? <Spin /> : !codes.length ? <EmptyState icon={KeyRound} title="暂无激活码" /> : (
        <Table heads={['激活码', '类型', '状态', '客户', '绑定', '过期']}>
          {codes.map(c => (
            <tr key={c.id} className="transition-colors hover:bg-muted/30">
              <td className="px-4 py-3"><code className="rounded bg-muted px-2 py-0.5 text-xs font-mono">{c.code}</code><div className="mt-0.5 text-xs text-muted-foreground">{c.tenant_name}</div></td>
              <td className="px-4 py-3"><StatusBadge tone="neutral">{c.type}</StatusBadge></td>
              <td className="px-4 py-3"><StatusBadge tone={c.status}>{c.status}</StatusBadge></td>
              <td className="px-4 py-3 text-sm">{c.owner_name || c.owner_email || '-'}</td>
              <td className="px-4 py-3 tabular-nums text-sm">{c.binding_count} / {c.max_bindings}</td>
              <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(c.expires_at)}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}

/* ==================== SettingsPage ==================== */
export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.get<any>('/admin/settings'),
      api.get<any>('/admin/official-accounts'),
    ]).then(([sData]) => {
      setSettings(sData.settings || {})
    }).finally(() => setLoading(false))
  }, [])

  const save = async (group: string) => {
    const body: any = {}
    if (group === 'llm') {
      body.llm_provider = settings.llm_provider; body.llm_model = settings.llm_model
      const key = settings._llm_api_key; if (key) body.llm_api_key = key
    } else if (group === 'email') {
      for (const k of ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'email_from', 'email_to']) body[k] = settings[k]
    } else if (group === 'report') {
      for (const k of ['report_daily_time', 'report_weekly_time', 'report_monthly_day', 'report_monthly_time']) body[k] = settings[k]
    }
    await api.put('/admin/settings', body)
    alert('保存成功')
  }

  const u = (key: string, val: string) => setSettings(prev => ({ ...prev, [key]: val }))

  if (loading) return <Spin />

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-6 duration-300">
      <SettingsCard title="AI 模型" onSave={() => save('llm')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="提供商"><Input value={settings.llm_provider || ''} onChange={e => u('llm_provider', e.target.value)} /></Field>
          <Field label="模型"><Input value={settings.llm_model || ''} onChange={e => u('llm_model', e.target.value)} /></Field>
          <Field label="API Key" full><Input type="password" value={settings._llm_api_key || ''} onChange={e => u('_llm_api_key', e.target.value)} placeholder="留空不修改" /></Field>
        </div>
      </SettingsCard>

      <SettingsCard title="报告时间" onSave={() => save('report')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="日报时间"><Input value={settings.report_daily_time || '09:00'} onChange={e => u('report_daily_time', e.target.value)} /></Field>
          <Field label="周报时间"><Input value={settings.report_weekly_time || '09:00'} onChange={e => u('report_weekly_time', e.target.value)} /></Field>
          <Field label="月报日期"><Input value={settings.report_monthly_day || '1'} onChange={e => u('report_monthly_day', e.target.value)} /></Field>
          <Field label="月报时间"><Input value={settings.report_monthly_time || '09:00'} onChange={e => u('report_monthly_time', e.target.value)} /></Field>
        </div>
      </SettingsCard>

      <SettingsCard title="邮件发送" onSave={() => save('email')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SMTP 主机"><Input value={settings.smtp_host || ''} onChange={e => u('smtp_host', e.target.value)} /></Field>
          <Field label="SMTP 端口"><Input value={settings.smtp_port || '465'} onChange={e => u('smtp_port', e.target.value)} /></Field>
          <Field label="SMTP 账号"><Input value={settings.smtp_user || ''} onChange={e => u('smtp_user', e.target.value)} /></Field>
          <Field label="SMTP 密码"><Input type="password" value={settings.smtp_pass || ''} onChange={e => u('smtp_pass', e.target.value)} placeholder="留空不修改" /></Field>
          <Field label="发件人"><Input value={settings.email_from || ''} onChange={e => u('email_from', e.target.value)} /></Field>
          <Field label="收件人"><Input value={settings.email_to || ''} onChange={e => u('email_to', e.target.value)} /></Field>
        </div>
      </SettingsCard>
    </div>
  )
}

/* ==================== Shared components ==================== */
function Spin() { return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div> }

function Table({ heads, children }: { heads: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead><tr className="border-b border-border bg-muted/50">
          {heads.map(h => <th key={h} className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{h}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  )
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return <label className={`space-y-1.5 ${full ? 'sm:col-span-2' : ''}`}><span className="text-xs font-semibold text-muted-foreground">{label}</span>{children}</label>
}

function SettingsCard({ title, onSave, children }: { title: string; onSave: () => void; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="mb-4 text-sm font-bold">{title}</h2>
      {children}
      <div className="mt-4 flex justify-end"><Button size="sm" onClick={onSave}><Save className="h-3.5 w-3.5" /> 保存</Button></div>
    </section>
  )
}
