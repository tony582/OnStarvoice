import { Fragment, useCallback, useEffect, useState } from 'react'
import { Loader2, Building2, Users, KeyRound, Save, Pencil, Copy, RefreshCw, Trash2, Laptop, FlaskConical } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, formatExpiry, LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { useBadges } from '@/lib/badges'

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
      <section className="rounded-xl border border-border bg-card p-4 lg:p-5">
        <h2 className="mb-1 inline-flex items-center gap-1.5 text-sm font-bold"><Building2 className="h-4 w-4 text-primary" />新建客户(租户)</h2>
        <p className="mb-3 text-[12.5px] text-muted-foreground">每个客户(如「安吉星」)= 一个租户,数据完全隔离。建好后给它建账号、发激活码。</p>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="min-w-0 w-full flex-1 sm:min-w-[240px]">
            <Field label="客户/租户名称">
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="例:安吉星 / 上汽通用 / 凯迪拉克"
                onKeyDown={e => { if (e.key === 'Enter') create() }} />
            </Field>
          </div>
          <Button className="h-11 w-full lg:h-9 lg:w-auto" onClick={create} disabled={creating || !name.trim()}>{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}新建客户</Button>
        </div>
        {msg && <p className={`mt-3 text-[12.5px] font-medium ${msg.startsWith('创建失败') ? 'text-status-red' : 'text-status-green'}`}>{msg}</p>}
      </section>

      {loading ? <Spin /> : !tenants.length ? <EmptyState icon={Building2} title="暂无租户" /> : (
        <>
          <MobileList label={`客户租户 · ${tenants.length}`}>
            {tenants.map(t => (
              <MobileEntityCard key={t.id} active={t.status === 'active'}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold tracking-[0.12em] text-muted-foreground">客户租户</p>
                    <h3 className="mt-1 break-words text-[17px] font-bold leading-6 text-foreground">{t.name}</h3>
                  </div>
                  <StatusBadge tone={t.status}>{t.status === 'active' ? '启用' : t.status}</StatusBadge>
                </div>
                <div className="mt-4"><MobileMeta label="创建时间" value={formatDate(t.created_at)} /></div>
              </MobileEntityCard>
            ))}
          </MobileList>
          <Table heads={['租户', '状态', '创建时间']}>
            {tenants.map(t => (
              <tr key={t.id} className="transition-colors hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">{t.name}</td>
                <td className="px-4 py-3"><StatusBadge tone={t.status}>{t.status === 'active' ? '启用' : t.status}</StatusBadge></td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(t.created_at)}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  )
}

/* ==================== UsersPage ==================== */
export function UsersPage() {
  const [tenants, setTenants] = useState<any[]>([])
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [mobileResetId, setMobileResetId] = useState('')
  const [mobilePassword, setMobilePassword] = useState('')
  const [mobileActionBusy, setMobileActionBusy] = useState(false)
  const [mobileDisableId, setMobileDisableId] = useState('')
  const [mobileActionError, setMobileActionError] = useState('')
  const [mobileNotice, setMobileNotice] = useState({ id: '', text: '', error: false })
  const [editingNameId, setEditingNameId] = useState('')
  const [editingNameSurface, setEditingNameSurface] = useState<'mobile' | 'desktop' | ''>('')
  const [editingName, setEditingName] = useState('')
  const [editingNameBusy, setEditingNameBusy] = useState(false)
  const [editingNameError, setEditingNameError] = useState('')
  const [form, setForm] = useState({ email: '', name: '', password: '', type: 'tenant', tenantId: '', role: 'tenant_viewer', globalRole: 'internal_operator' })

  const load = async () => {
    setLoading(true)
    const [u, t] = await Promise.all([
      api.get<any>('/admin/users', { skipTenant: true }),
      api.get<any>('/admin/tenants', { skipTenant: true }),
    ])
    setUsers(u.users || [])
    const ts = t.tenants || []
    setTenants(ts)
    setForm(f => ({ ...f, tenantId: f.tenantId || ts[0]?.id || '' }))
    setLoading(false)
  }
  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void load() })
    return () => { active = false }
  }, [])

  const createUser = async () => {
    if (!form.email.trim() || !form.password) { setMsg('邮箱和初始密码必填'); return }
    if (form.password.length < 8) { setMsg('初始密码至少 8 位'); return }
    const isInternal = form.type === 'internal'
    if (!isInternal && !form.tenantId) { setMsg('客户账号请选择租户(没有就先到「租户管理」建)'); return }
    const body: any = { email: form.email.trim(), name: form.name.trim(), password: form.password, isInternal }
    if (isInternal) body.globalRole = form.globalRole
    else { body.tenantId = form.tenantId; body.role = form.role }
    setBusy(true); setMsg('')
    try {
      await api.post('/admin/users', body, { skipTenant: true })
      const tname = tenants.find(t => t.id === form.tenantId)?.name
      setMsg(isInternal ? '✅ 内部账号已创建' : `✅ 已为「${tname || ''}」创建账号:${form.email.trim()}`)
      setForm(f => ({ ...f, email: '', name: '', password: '' }))
      load()
    } catch (err) {
      setMsg('创建失败:' + (err instanceof Error ? err.message : ''))
    } finally { setBusy(false) }
  }

  const resetPwd = async (id: string) => {
    const pw = prompt('新密码：')
    if (!pw) return
    await api.post('/admin/users/' + id + '/reset-password', { password: pw }, { skipTenant: true })
  }

  const resetPwdOnMobile = async (id: string) => {
    if (mobilePassword.length < 8) { setMobileActionError('新密码至少 8 位'); return }
    setMobileActionBusy(true); setMobileActionError('')
    try {
      await api.post('/admin/users/' + id + '/reset-password', { password: mobilePassword }, { skipTenant: true })
      setMobileResetId(''); setMobilePassword(''); setMobileNotice({ id, text: '密码已重置', error: false })
    } catch (err) {
      setMobileActionError('重置失败:' + (err instanceof Error ? err.message : ''))
    } finally { setMobileActionBusy(false) }
  }

  const toggleStatus = async (id: string, current: string) => {
    await api.patch('/admin/users/' + id, { status: current === 'active' ? 'disabled' : 'active' }, { skipTenant: true })
    load()
  }

  const toggleStatusOnMobile = async (id: string, current: string) => {
    setMobileActionBusy(true); setMobileActionError('')
    try {
      await toggleStatus(id, current)
      setMobileDisableId('')
      setMobileNotice({ id, text: current === 'active' ? '账号已停用' : '账号已启用', error: false })
    } catch (err) {
      const text = '操作失败:' + (err instanceof Error ? err.message : '')
      setMobileActionError(text)
      if (current !== 'active') setMobileNotice({ id, text, error: true })
    } finally { setMobileActionBusy(false) }
  }

  const beginNameEdit = (user: any, surface: 'mobile' | 'desktop') => {
    setEditingNameId(user.id)
    setEditingNameSurface(surface)
    setEditingName(String(user.name || ''))
    setEditingNameError('')
    setMobileResetId('')
    setMobileDisableId('')
    setMobileActionError('')
    setMobileNotice({ id: '', text: '', error: false })
  }

  const cancelNameEdit = () => {
    if (editingNameBusy) return
    setEditingNameId('')
    setEditingNameSurface('')
    setEditingName('')
    setEditingNameError('')
  }

  const saveUserName = async (user: any) => {
    const nextName = editingName.trim()
    if (!nextName) { setEditingNameError('用户名称不能为空'); return }
    if (nextName.length > 100) { setEditingNameError('用户名称不能超过 100 个字符'); return }
    if (nextName === String(user.name || '').trim()) { cancelNameEdit(); return }

    setEditingNameBusy(true)
    setEditingNameError('')
    try {
      await api.patch('/admin/users/' + user.id, { name: nextName }, { skipTenant: true })
      setUsers(current => current.map(item => item.id === user.id ? { ...item, name: nextName } : item))
      setEditingNameId('')
      setEditingNameSurface('')
      setEditingName('')
      setMobileNotice({ id: user.id, text: '用户名称已更新', error: false })
    } catch (err) {
      setEditingNameError('保存失败:' + (err instanceof Error ? err.message : ''))
    } finally { setEditingNameBusy(false) }
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-6 duration-300">
      {/* Create form */}
      <section className="rounded-xl border border-border bg-card p-4 lg:rounded-lg lg:p-5">
        <h2 className="mb-4 text-sm font-bold">创建账号</h2>
        <p className="mb-4 text-xs leading-5 text-muted-foreground lg:hidden">先确定账号归属和权限，再填写人员信息与初始密码。</p>
        <div className="grid gap-3 lg:grid-cols-3">
          <Field label="邮箱" className="order-5 lg:order-none"><Input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} type="email" /></Field>
          <Field label="姓名" className="order-4 lg:order-none"><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="初始密码" className="order-6 lg:order-none"><Input value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} type="password" /></Field>
          <Field label="账号类型" className="order-1 lg:order-none">
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm lg:h-9">
              <option value="tenant">客户账号</option><option value="internal">内部账号</option>
            </select>
          </Field>
          {form.type === 'tenant' && (
            <>
              <Field label="租户" className="order-2 lg:order-none">
                <select value={form.tenantId} onChange={e => setForm({ ...form, tenantId: e.target.value })} className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm lg:h-9">
                  {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="角色" className="order-3 lg:order-none">
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm lg:h-9">
                  <option value="tenant_viewer">只读</option><option value="tenant_analyst">分析员</option><option value="tenant_admin">管理员</option>
                </select>
              </Field>
            </>
          )}
          {form.type === 'internal' && (
            <Field label="内部角色" className="order-2 lg:order-none">
              <select value={form.globalRole} onChange={e => setForm({ ...form, globalRole: e.target.value })} className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm lg:h-9">
                <option value="internal_operator">内部运营</option><option value="platform_admin">平台管理员</option>
              </select>
            </Field>
          )}
        </div>
        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-end">
          {msg && <span className={`order-2 text-[12.5px] font-medium lg:order-none ${/失败|必填|至少|请选择/.test(msg) ? 'text-status-red' : 'text-status-green'}`}>{msg}</span>}
          <Button className="h-11 w-full lg:h-9 lg:w-auto" onClick={createUser} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}创建账号</Button>
        </div>
      </section>

      {loading ? <Spin /> : !users.length ? <EmptyState icon={Users} title="暂无用户" /> : (
        <>
          <MobileList label={`账号 · ${users.length}`}>
            {users.map(u => (
              <MobileEntityCard key={u.id} active={u.status === 'active'}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-[17px] font-bold leading-6">{u.name || u.email}</h3>
                    <p className="mt-0.5 break-all text-xs text-muted-foreground">{u.email}</p>
                  </div>
                  <StatusBadge tone={u.status}>{u.status === 'active' ? '启用' : '禁用'}</StatusBadge>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <MobileMeta label="账号角色" value={u.is_internal ? (LABELS.role[u.global_role] || u.global_role) : '客户账号'} />
                  <MobileMeta label="最近登录" value={formatDate(u.last_login_at)} />
                </div>
                {mobileNotice.id === u.id && <p className={`mt-3 rounded-lg px-3 py-2 text-xs font-semibold ${mobileNotice.error ? 'bg-destructive/10 text-destructive' : 'bg-status-green/10 text-status-green'}`}>{mobileNotice.text}</p>}
                {editingNameId === u.id && editingNameSurface === 'mobile' ? (
                  <form onSubmit={e => { e.preventDefault(); void saveUserName(u) }} className="mt-4 space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-3">
                    <Field label="用户名称">
                      <Input
                        autoFocus
                        value={editingName}
                        maxLength={100}
                        onChange={e => { setEditingName(e.target.value); setEditingNameError('') }}
                        onKeyDown={e => { if (e.key === 'Escape') cancelNameEdit() }}
                        aria-label={`修改 ${u.email} 的用户名称`}
                      />
                    </Field>
                    {editingNameError && <p role="alert" className="text-xs font-semibold text-destructive">{editingNameError}</p>}
                    <div className="grid grid-cols-2 gap-2">
                      <Button type="button" className="h-11" variant="outline" disabled={editingNameBusy} onClick={cancelNameEdit}>取消</Button>
                      <Button type="submit" className="h-11" disabled={editingNameBusy || !editingName.trim()}>
                        {editingNameBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存名称
                      </Button>
                    </div>
                  </form>
                ) : mobileResetId === u.id ? (
                  <div className="mt-4 space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-3">
                    <Field label="为此账号设置新密码">
                      <Input autoFocus type="password" value={mobilePassword} onChange={e => setMobilePassword(e.target.value)} placeholder="至少 8 位" />
                    </Field>
                    {mobileActionError && <p className="text-xs font-semibold text-destructive">{mobileActionError}</p>}
                    <div className="grid grid-cols-2 gap-2">
                      <Button className="h-11" variant="outline" onClick={() => { setMobileResetId(''); setMobilePassword(''); setMobileActionError('') }}>取消</Button>
                      <Button className="h-11" disabled={mobileActionBusy || mobilePassword.length < 8} onClick={() => resetPwdOnMobile(u.id)}>{mobileActionBusy && <Loader2 className="h-4 w-4 animate-spin" />}确认重置</Button>
                    </div>
                  </div>
                ) : mobileDisableId === u.id ? (
                  <div className="mt-4 space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                    <p className="text-sm font-bold text-destructive">确认停用这个账号？</p>
                    <p className="text-xs leading-5 text-muted-foreground">停用后，该账号将立即无法登录；之后仍可重新启用。</p>
                    {mobileActionError && <p className="text-xs font-semibold text-destructive">{mobileActionError}</p>}
                    <div className="grid grid-cols-2 gap-2">
                      <Button className="h-11" variant="outline" disabled={mobileActionBusy} onClick={() => { setMobileDisableId(''); setMobileActionError('') }}>返回</Button>
                      <Button className="h-11" variant="destructive" disabled={mobileActionBusy} onClick={() => toggleStatusOnMobile(u.id, u.status)}>{mobileActionBusy && <Loader2 className="h-4 w-4 animate-spin" />}确认停用</Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border/70 pt-4">
                      <Button className="h-11 px-2" variant="outline" onClick={() => beginNameEdit(u, 'mobile')}><Pencil className="h-3.5 w-3.5" />编辑名称</Button>
                      <Button className="h-11 px-2" variant="outline" onClick={() => { cancelNameEdit(); setMobileResetId(u.id); setMobilePassword(''); setMobileDisableId(''); setMobileActionError(''); setMobileNotice({ id: '', text: '', error: false }) }}>重置密码</Button>
                      <Button className="h-11" disabled={mobileActionBusy} variant={u.status === 'active' ? 'destructive' : 'default'} onClick={() => {
                        cancelNameEdit(); setMobileActionError(''); setMobileNotice({ id: '', text: '', error: false })
                        if (u.status === 'active') { setMobileDisableId(u.id); setMobileResetId('') }
                        else toggleStatusOnMobile(u.id, u.status)
                      }}>{u.status === 'active' ? '停用账号' : '启用账号'}</Button>
                    </div>
                    {u.status === 'active' && <p className="mt-2 text-[11px] leading-4 text-muted-foreground">停用属于高风险操作，需要再次确认。</p>}
                  </>
                )}
              </MobileEntityCard>
            ))}
          </MobileList>
          <Table heads={['用户', '角色', '状态', '最近登录', '操作']}>
            {users.map(u => (
              <tr key={u.id} className="transition-colors hover:bg-muted/30">
                <td className="px-4 py-3">
                  {editingNameId === u.id && editingNameSurface === 'desktop' ? (
                    <form onSubmit={e => { e.preventDefault(); void saveUserName(u) }} className="min-w-[320px]">
                      <div className="flex items-center gap-2">
                        <Input
                          autoFocus
                          value={editingName}
                          maxLength={100}
                          onChange={e => { setEditingName(e.target.value); setEditingNameError('') }}
                          onKeyDown={e => { if (e.key === 'Escape') cancelNameEdit() }}
                          aria-label={`修改 ${u.email} 的用户名称`}
                          className="h-8 min-w-0 flex-1"
                        />
                        <Button type="submit" size="sm" disabled={editingNameBusy || !editingName.trim()}>
                          {editingNameBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存
                        </Button>
                        <Button type="button" variant="ghost" size="sm" disabled={editingNameBusy} onClick={cancelNameEdit}>取消</Button>
                      </div>
                      {editingNameError && <p role="alert" className="mt-1.5 text-xs font-semibold text-destructive">{editingNameError}</p>}
                      <div className="mt-1 text-xs text-muted-foreground">{u.email}</div>
                    </form>
                  ) : (
                    <>
                      <div className="font-medium">{u.name || u.email}</div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                      {mobileNotice.id === u.id && <div className={`mt-1 text-xs font-medium ${mobileNotice.error ? 'text-destructive' : 'text-status-green'}`}>{mobileNotice.text}</div>}
                    </>
                  )}
                </td>
                <td className="px-4 py-3"><StatusBadge tone={u.global_role || 'viewer'}>{u.is_internal ? (LABELS.role[u.global_role] || u.global_role) : '客户'}</StatusBadge></td>
                <td className="px-4 py-3"><StatusBadge tone={u.status}>{u.status === 'active' ? '启用' : '禁用'}</StatusBadge></td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(u.last_login_at)}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="outline" size="sm" disabled={editingNameBusy && editingNameId === u.id} onClick={() => beginNameEdit(u, 'desktop')}><Pencil className="h-3.5 w-3.5" />编辑名称</Button>
                    <Button variant="outline" size="sm" onClick={() => resetPwd(u.id)}>重置密码</Button>
                    <Button variant={u.status === 'active' ? 'destructive' : 'default'} size="sm" onClick={() => toggleStatus(u.id, u.status)}>{u.status === 'active' ? '禁用' : '启用'}</Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  )
}

/* ==================== AuthCodesPage ==================== */
type AuthCodeForm = {
  tenantId: string
  type: string
  ownerName: string
  maxBindings: string
  expiresOn: string
}

type AuthCodeEditForm = {
  maxBindings: string
  expiresOn: string
}

function toDateInputValue(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function defaultAuthCodeExpiry(type: string) {
  if (type === 'permanent') return ''
  const date = new Date()
  if (type === 'trial') date.setDate(date.getDate() + 7)
  else date.setFullYear(date.getFullYear() + 1)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function newAuthCodeForm(): AuthCodeForm {
  return {
    tenantId: '',
    type: 'annual',
    ownerName: '',
    maxBindings: '3',
    expiresOn: defaultAuthCodeExpiry('annual'),
  }
}

export function AuthCodesPage() {
  const [codes, setCodes] = useState<any[]>([])
  const [tenants, setTenants] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<AuthCodeForm>(() => newAuthCodeForm())
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState('')
  const [editingCodeId, setEditingCodeId] = useState('')
  const [editForm, setEditForm] = useState<AuthCodeEditForm>({ maxBindings: '', expiresOn: '' })
  const [editMessage, setEditMessage] = useState('')
  const [savingCodeId, setSavingCodeId] = useState('')

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
  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void load() })
    return () => { active = false }
  }, [])

  const create = async () => {
    if (!form.tenantId) return
    const maxBindings = Number(form.maxBindings)
    if (!Number.isInteger(maxBindings) || maxBindings < 1 || maxBindings > 10000) {
      setCreated('创建失败:设备上限请输入 1-10000 的整数')
      return
    }
    if (form.type !== 'permanent' && !form.expiresOn) {
      setCreated('创建失败:请选择到期日')
      return
    }
    setCreating(true); setCreated('')
    try {
      const d = await api.post<any>('/admin/auth-codes', {
        type: form.type,
        ownerName: form.ownerName.trim(),
        tenantId: form.tenantId,
        maxBindings,
        expiresAt: form.type === 'permanent' ? null : form.expiresOn,
      }, { skipTenant: true })
      const tname = tenants.find(t => t.id === form.tenantId)?.name || ''
      setCreated(`已为「${tname}」生成激活码: ${d.code}`)
      setForm(f => ({ ...f, ownerName: '' }))
      load()
    } catch (err) {
      setCreated('创建失败:' + (err instanceof Error ? err.message : ''))
    } finally { setCreating(false) }
  }

  const beginEdit = (code: any) => {
    if (editingCodeId === code.id) {
      setEditingCodeId('')
      setEditMessage('')
      return
    }
    setEditingCodeId(code.id)
    setEditForm({
      maxBindings: String(code.max_bindings ?? 3),
      expiresOn: code.type === 'permanent' ? '' : toDateInputValue(code.expires_at),
    })
    setEditMessage('')
  }

  const saveEdit = async (code: any) => {
    const maxBindings = Number(editForm.maxBindings)
    const bindingCount = Number(code.binding_count || 0)
    if (!Number.isInteger(maxBindings) || maxBindings < 1 || maxBindings > 10000) {
      setEditMessage('设备上限请输入 1-10000 的整数')
      return
    }
    if (maxBindings < bindingCount) {
      setEditMessage(`设备上限不能低于当前已绑定数量 ${bindingCount}`)
      return
    }
    if (code.type !== 'permanent' && !editForm.expiresOn) {
      setEditMessage('请选择到期日')
      return
    }

    setSavingCodeId(code.id)
    setEditMessage('')
    try {
      await api.patch(`/admin/auth-codes/${code.id}`, {
        maxBindings,
        expiresAt: code.type === 'permanent' ? null : editForm.expiresOn,
      }, { skipTenant: true })
      await load()
      setEditMessage('授权配置已保存')
    } catch (err) {
      setEditMessage(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSavingCodeId('')
    }
  }

  const today = toDateInputValue(new Date().toISOString())

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-5 duration-300">
      <section className="rounded-xl border border-border bg-card p-4 lg:p-5">
        <h2 className="mb-1 inline-flex items-center gap-1.5 text-sm font-bold"><KeyRound className="h-4 w-4 text-primary" />生成激活码</h2>
        <p className="mb-3 text-[12.5px] text-muted-foreground">为客户设置可用的浏览器 Agent 数量和授权期限；生成后仍可随时调整。</p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Field label="归属客户(租户)">
            <select value={form.tenantId} onChange={e => setForm({ ...form, tenantId: e.target.value })} className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm lg:h-9">
              {tenants.length === 0 && <option value="">(先到「租户管理」建客户)</option>}
              {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="类型">
            <select value={form.type} onChange={e => {
              const type = e.target.value
              setForm({ ...form, type, expiresOn: defaultAuthCodeExpiry(type) })
            }} className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm lg:h-9">
              <option value="trial">试用</option><option value="annual">年付</option><option value="permanent">永久</option>
            </select>
          </Field>
          <Field label="设备上限(浏览器 Agent)">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={10000}
              step={1}
              value={form.maxBindings}
              onChange={e => setForm({ ...form, maxBindings: e.target.value })}
            />
          </Field>
          <Field label={form.type === 'permanent' ? '到期日(长期有效)' : '到期日'}>
            <Input
              type="date"
              min={today}
              disabled={form.type === 'permanent'}
              value={form.expiresOn}
              onChange={e => setForm({ ...form, expiresOn: e.target.value })}
            />
          </Field>
          <Field label="备注/联系人(选填)"><Input value={form.ownerName} onChange={e => setForm({ ...form, ownerName: e.target.value })} placeholder="例:安吉星-张经理" /></Field>
          <div className="flex items-end"><Button className="h-11 w-full lg:h-9" onClick={create} disabled={creating || !form.tenantId}>{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}生成激活码</Button></div>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">每个浏览器配置占用 1 个设备名额；同一台电脑安装多个浏览器，也会分别计数。</p>
        {created && <p className={`mt-3 break-all text-[12.5px] font-medium ${created.startsWith('创建失败') ? 'text-status-red' : 'text-status-green'}`}>{created}</p>}
      </section>

      {loading ? <Spin /> : !codes.length ? <EmptyState icon={KeyRound} title="暂无激活码" /> : (
        <>
          <MobileList label={`激活码 · ${codes.length}`}>
            {codes.map(c => {
              const exp = c.type === 'permanent'
                ? { text: '长期有效', expired: false }
                : formatExpiry(c.expires_at)
              return (
                <MobileEntityCard key={c.id} active={c.status === 'active' && !exp.expired}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-bold tracking-[0.12em] text-muted-foreground">{c.tenant_name || '未命名租户'}</p>
                      <code className="mt-1.5 block break-all font-mono text-[15px] font-bold leading-6 text-foreground">{c.code}</code>
                    </div>
                    <StatusBadge tone={c.status}>{c.status}</StatusBadge>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <MobileMeta label="有效类型" value={authCodeTypeLabel(c.type)} />
                    <MobileMeta label="浏览器 Agent" value={`${c.binding_count} / ${c.max_bindings}`} />
                    <MobileMeta label="联系人" value={c.owner_name || c.owner_email || '-'} />
                    <MobileMeta label="到期日" value={exp.text} danger={exp.expired} />
                  </div>
                  <Button className="mt-3 h-11 w-full" variant="outline" onClick={() => beginEdit(c)}>
                    <Pencil className="h-4 w-4" />{editingCodeId === c.id ? '收起调整' : '调整授权'}
                  </Button>
                  {editingCodeId === c.id && (
                    <AuthCodeEditor
                      code={c}
                      form={editForm}
                      busy={savingCodeId === c.id}
                      message={editMessage}
                      today={today}
                      onChange={setEditForm}
                      onSave={() => saveEdit(c)}
                      onCancel={() => { setEditingCodeId(''); setEditMessage('') }}
                    />
                  )}
                </MobileEntityCard>
              )
            })}
          </MobileList>
          <Table heads={['激活码', '类型', '状态', '客户', 'Agent 名额', '到期日', '操作']}>
            {codes.map(c => {
              const exp = c.type === 'permanent'
                ? { text: '长期有效', expired: false }
                : formatExpiry(c.expires_at)
              return (
                <Fragment key={c.id}>
                  <tr className="transition-colors hover:bg-muted/30">
                    <td className="px-4 py-3"><code className="rounded bg-muted px-2 py-0.5 text-xs font-mono">{c.code}</code><div className="mt-0.5 text-xs text-muted-foreground">{c.tenant_name}</div></td>
                    <td className="px-4 py-3"><StatusBadge tone="neutral">{authCodeTypeLabel(c.type)}</StatusBadge></td>
                    <td className="px-4 py-3"><StatusBadge tone={c.status}>{c.status}</StatusBadge></td>
                    <td className="px-4 py-3 text-sm">{c.owner_name || c.owner_email || '-'}</td>
                    <td className="px-4 py-3 tabular-nums text-sm">{c.binding_count} / {c.max_bindings}</td>
                    <td className={`px-4 py-3 text-sm ${exp.expired ? 'text-destructive' : 'text-muted-foreground'}`}>{exp.text}</td>
                    <td className="px-4 py-3 text-right"><Button size="sm" variant="outline" onClick={() => beginEdit(c)}><Pencil className="h-3.5 w-3.5" />调整</Button></td>
                  </tr>
                  {editingCodeId === c.id && (
                    <tr>
                      <td colSpan={7} className="bg-muted/20 px-4 py-4">
                        <AuthCodeEditor
                          code={c}
                          form={editForm}
                          busy={savingCodeId === c.id}
                          message={editMessage}
                          today={today}
                          onChange={setEditForm}
                          onSave={() => saveEdit(c)}
                          onCancel={() => { setEditingCodeId(''); setEditMessage('') }}
                          desktop
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </Table>
        </>
      )}
    </div>
  )
}

/* ==================== SettingsPage ==================== */
type AiFailoverStatus = {
  route?: 'primary' | 'backup' | 'configured'
  effectiveModel?: string
  consecutiveFailures?: number
  lastFailureAt?: string
  lastFailureCode?: string
  nextPrimaryProbeAt?: string
}

type LlmRelayAgent = {
  id: string
  name: string
  online: boolean
  last_seen_at?: string
  revoked_at?: string
  created_at?: string
}

type LlmRelayAgentsResponse = {
  agents?: LlmRelayAgent[]
}

type LlmRelayTokenResponse = {
  token?: string
}

type LlmRelayTestResponse = {
  model?: string
  latencyMs?: number
}

export function SettingsPage() {
  const { refresh: refreshBadges } = useBadges()
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [aiFailoverStatus, setAiFailoverStatus] = useState<AiFailoverStatus | null>(null)
  const [llmRelayAgents, setLlmRelayAgents] = useState<LlmRelayAgent[]>([])
  const [llmRelayToken, setLlmRelayToken] = useState('')
  const [llmRelayBusy, setLlmRelayBusy] = useState(false)
  const [llmRelayMessage, setLlmRelayMessage] = useState('')
  const [loading, setLoading] = useState(true)

  const loadSettings = useCallback(() => Promise.all([
      api.get<any>('/admin/settings'),
      api.get<any>('/admin/official-accounts'),
      api.get<LlmRelayAgentsResponse>('/admin/llm-relay-agents'),
    ]).then(([sData, , relayData]) => {
      setSettings(sData.settings || {})
      setAiFailoverStatus(sData.aiFailoverStatus || null)
      setLlmRelayAgents(relayData.agents || [])
    }), [])

  useEffect(() => {
    loadSettings().finally(() => setLoading(false))
  }, [loadSettings])

  const save = async (group: string) => {
    const body: any = {}
    if (group === 'llm') {
      body.llm_provider = settings.llm_provider; body.llm_model = settings.llm_model
      for (const key of [
        'relevance_prefilter_llm_provider',
        'relevance_prefilter_llm_model',
        'relevance_prefilter_llm_api_endpoint',
      ]) body[key] = settings[key] || ''
      for (const key of [
        'llm_failover_enabled',
        'llm_failover_primary_model',
        'llm_failover_backup_model',
        'llm_failover_failure_threshold',
        'llm_failover_window_seconds',
        'llm_failover_pending_threshold',
        'llm_failover_recovery_probe_seconds',
        'llm_failover_recovery_success_threshold',
      ]) body[key] = settings[key] || ''
      const key = settings._llm_api_key; if (key) body.llm_api_key = key
      const prefilterKey = settings._relevance_prefilter_llm_api_key
      if (prefilterKey) body.relevance_prefilter_llm_api_key = prefilterKey
    } else if (group === 'brand') {
      for (const k of ['brand_name', 'brand_aliases', 'brand_business_context', 'brand_relevance_terms', 'brand_noise_terms']) body[k] = settings[k] || ''
    } else if (group === 'email') {
      for (const k of [
        'smtp_host',
        'smtp_port',
        'smtp_secure',
        'smtp_user',
        'email_from',
        'email_to',
        'capture_attention_email_to',
      ]) body[k] = settings[k]
      const smtpPass = settings.smtp_pass
      if (smtpPass && smtpPass !== '***') body.smtp_pass = smtpPass
    } else if (group === 'report') {
      for (const k of ['report_daily_time', 'report_weekly_time', 'report_monthly_day', 'report_monthly_time']) body[k] = settings[k]
    } else if (group === 'comment-risk') {
      body.comment_risk_attention_enabled = settings.comment_risk_attention_enabled === 'false' ? 'false' : 'true'
    } else if (group === 'llm-relay') {
      body.llm_relay_mode = settings.llm_relay_mode || 'off'
      body.llm_relay_model = settings.llm_relay_model || 'gemini-3.7-flash-low'
    }
    await api.put('/admin/settings', body)
    if (group === 'llm' || group === 'llm-relay') await loadSettings()
    if (group === 'comment-risk') refreshBadges()
    alert('保存成功')
  }

  const u = (key: string, val: string) => setSettings(prev => ({ ...prev, [key]: val }))

  const rotateLlmRelayToken = async () => {
    setLlmRelayBusy(true); setLlmRelayMessage('')
    try {
      const data = await api.post<LlmRelayTokenResponse>('/admin/llm-relay-agents/rotate', { name: '本机 Antigravity' })
      setLlmRelayToken(data.token || '')
      setLlmRelayMessage('新令牌已生成。旧令牌已经失效。')
      await loadSettings()
    } catch (error) {
      setLlmRelayMessage('生成失败：' + (error instanceof Error ? error.message : '未知错误'))
    } finally {
      setLlmRelayBusy(false)
    }
  }

  const revokeLlmRelayAgent = async (id: string) => {
    if (!confirm('撤销后，本机 Agent 会立即失效。确定撤销吗？')) return
    setLlmRelayBusy(true); setLlmRelayMessage('')
    try {
      await api.delete('/admin/llm-relay-agents/' + id)
      setLlmRelayToken('')
      setLlmRelayMessage('本机 Agent 已撤销。')
      await loadSettings()
    } catch (error) {
      setLlmRelayMessage('撤销失败：' + (error instanceof Error ? error.message : '未知错误'))
    } finally {
      setLlmRelayBusy(false)
    }
  }

  const testLlmRelayAgent = async () => {
    setLlmRelayBusy(true); setLlmRelayMessage('')
    try {
      const data = await api.post<LlmRelayTestResponse>('/admin/llm-relay-agents/test', {})
      setLlmRelayMessage(`测试成功：${data.model || '本机模型'}，${Number(data.latencyMs || 0)} ms。现在可以再启用“最终判断优先使用本机”。`)
      await loadSettings()
    } catch (error) {
      setLlmRelayMessage('测试失败：' + (error instanceof Error ? error.message : '未知错误'))
    } finally {
      setLlmRelayBusy(false)
    }
  }

  const copyLlmRelayToken = async () => {
    if (!llmRelayToken) return
    await navigator.clipboard.writeText(llmRelayToken)
    setLlmRelayMessage('令牌已复制。')
  }

  if (loading) return <Spin />

  const activeLlmRelayAgent = llmRelayAgents.find(agent => !agent.revoked_at)

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-6 duration-300">
      <SettingsCard title="AI 模型" description="配置舆情分析模型，并在主模型拥堵时自动切到备用模型。" onSave={() => save('llm')}>
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="提供商"><Input value={settings.llm_provider || ''} onChange={e => u('llm_provider', e.target.value)} /></Field>
          <Field label="当前手工模型"><Input value={settings.llm_model || ''} onChange={e => u('llm_model', e.target.value)} /></Field>
          <Field label="API Key" full><Input type="password" value={settings._llm_api_key || ''} onChange={e => u('_llm_api_key', e.target.value)} placeholder="留空不修改" /></Field>
          <div className="rounded-lg border border-border bg-muted/30 p-3 lg:col-span-2">
            <div className="text-sm font-semibold text-foreground">采集前 AI 预判</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              独立于采集后的相关性和情感终判。建议使用千问 Flash，并固定关闭思考模式；留空则沿用上方模型。
            </div>
          </div>
          <Field label="预判提供商"><Input value={settings.relevance_prefilter_llm_provider || ''} onChange={e => u('relevance_prefilter_llm_provider', e.target.value)} placeholder="qianwen" /></Field>
          <Field label="预判模型"><Input value={settings.relevance_prefilter_llm_model || ''} onChange={e => u('relevance_prefilter_llm_model', e.target.value)} placeholder="qwen3.7-flash-2026-07-15" /></Field>
          <Field label="预判 API 地址" full><Input value={settings.relevance_prefilter_llm_api_endpoint || ''} onChange={e => u('relevance_prefilter_llm_api_endpoint', e.target.value)} placeholder="阿里云百炼 OpenAI 兼容地址" /></Field>
          <Field label="预判 API Key" full><Input type="password" value={settings._relevance_prefilter_llm_api_key || ''} onChange={e => u('_relevance_prefilter_llm_api_key', e.target.value)} placeholder="留空不修改" /></Field>
          <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 lg:col-span-2">
            <input
              type="checkbox"
              checked={settings.llm_failover_enabled === 'true'}
              onChange={event => u('llm_failover_enabled', event.target.checked ? 'true' : 'false')}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <span>
              <span className="block text-sm font-semibold">自动备用切换</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                连续出现上游 503、超时或排队失败，并确认存在待处理任务后切到备用模型；主模型连续探测恢复后自动切回。
              </span>
            </span>
          </label>
          <Field label="主模型"><Input value={settings.llm_failover_primary_model || ''} onChange={e => u('llm_failover_primary_model', e.target.value)} placeholder="deepseek-v4-flash" /></Field>
          <Field label="备用模型"><Input value={settings.llm_failover_backup_model || ''} onChange={e => u('llm_failover_backup_model', e.target.value)} placeholder="deepseek-v4-pro" /></Field>
          <Field label="连续失败阈值"><Input type="number" min="2" max="20" value={settings.llm_failover_failure_threshold || '3'} onChange={e => u('llm_failover_failure_threshold', e.target.value)} /></Field>
          <Field label="失败统计窗口（秒）"><Input type="number" min="30" max="900" value={settings.llm_failover_window_seconds || '120'} onChange={e => u('llm_failover_window_seconds', e.target.value)} /></Field>
          <Field label="待处理数量阈值"><Input type="number" min="1" max="10000" value={settings.llm_failover_pending_threshold || '1'} onChange={e => u('llm_failover_pending_threshold', e.target.value)} /></Field>
          <Field label="主模型探测间隔（秒）"><Input type="number" min="60" max="3600" value={settings.llm_failover_recovery_probe_seconds || '300'} onChange={e => u('llm_failover_recovery_probe_seconds', e.target.value)} /></Field>
          <Field label="恢复所需连续成功"><Input type="number" min="2" max="10" value={settings.llm_failover_recovery_success_threshold || '2'} onChange={e => u('llm_failover_recovery_success_threshold', e.target.value)} /></Field>
          <div className="rounded-lg border border-border bg-card p-3 text-xs leading-5 lg:col-span-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold text-foreground">
                当前线路：{aiFailoverStatus?.route === 'backup' ? '备用模型' : aiFailoverStatus?.route === 'primary' ? '主模型' : '手工配置'}
              </span>
              <span>生效模型：{aiFailoverStatus?.effectiveModel || settings.llm_model || '未配置'}</span>
              <span>连续失败：{aiFailoverStatus?.consecutiveFailures || 0}</span>
            </div>
            <div className="mt-1 text-muted-foreground">
              {aiFailoverStatus?.lastFailureAt
                ? `最近失败：${formatDate(aiFailoverStatus.lastFailureAt)} · ${aiFailoverStatus.lastFailureCode || '未知错误'}`
                : '最近失败：无'}
              {aiFailoverStatus?.nextPrimaryProbeAt
                ? `；下次主模型探测：${formatDate(aiFailoverStatus.nextPrimaryProbeAt)}`
                : ''}
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="本机 Antigravity AI"
        description="由你的 Mac 主动向阿里云领取列表前置预判及最终相关性与情感判断，不开放本机端口。"
        onSave={() => save('llm-relay')}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="使用方式">
            <select
              value={settings.llm_relay_mode || 'off'}
              onChange={event => u('llm_relay_mode', event.target.value)}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm lg:h-9"
            >
              <option value="off">关闭</option>
              <option value="primary">前置预判和最终判断优先使用本机，忙碌或离线时立即走云模型</option>
              <option value="fallback">前置预判和最终判断在云模型失败后使用本机</option>
            </select>
          </Field>
          <Field label="Antigravity 模型">
            <select
              value={settings.llm_relay_model || 'gemini-3.7-flash-low'}
              onChange={event => u('llm_relay_model', event.target.value)}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm lg:h-9"
            >
              <option value="gemini-3.7-flash-low">Gemini 3.7 Flash Low（批量推荐）</option>
              <option value="gemini-3.1-pro-low">Gemini 3.1 Pro Low（质量优先）</option>
            </select>
          </Field>

          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 lg:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Laptop className="h-4 w-4 text-primary" />
                <span className="font-semibold text-foreground">本机 Agent</span>
                <StatusBadge tone={activeLlmRelayAgent?.online ? 'active' : 'neutral'}>
                  {activeLlmRelayAgent?.online ? '在线' : activeLlmRelayAgent ? '离线' : '未配置'}
                </StatusBadge>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => loadSettings()} disabled={llmRelayBusy}>
                  <RefreshCw className="h-3.5 w-3.5" />刷新状态
                </Button>
                <Button size="sm" variant="outline" onClick={testLlmRelayAgent} disabled={llmRelayBusy || !activeLlmRelayAgent?.online}>
                  <FlaskConical className="h-3.5 w-3.5" />测试本机 AI
                </Button>
                <Button size="sm" variant="outline" onClick={rotateLlmRelayToken} disabled={llmRelayBusy}>
                  {llmRelayBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                  {activeLlmRelayAgent ? '轮换令牌' : '生成令牌'}
                </Button>
                {activeLlmRelayAgent && (
                  <Button size="sm" variant="outline" onClick={() => revokeLlmRelayAgent(activeLlmRelayAgent.id)} disabled={llmRelayBusy}>
                    <Trash2 className="h-3.5 w-3.5" />撤销
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-2 text-muted-foreground">
              阿里云只运行 StarVoice 后端；你的 Mac 上 Antigravity 和本机 Agent 都要保持运行。Agent 只向外连接阿里云，不会领取或修改采集任务。
            </p>
            <p className="mt-1 text-muted-foreground">
              当前接列表前置预判（每批最多 8 条）及最终相关性与情感判断；报告和关键词分析仍使用各自的云模型。本机一次处理 1 个批次，忙碌时新请求立即回退云模型，不会排队等待。
            </p>
            {activeLlmRelayAgent?.last_seen_at && (
              <p className="mt-1 text-muted-foreground">最近连接：{formatDate(activeLlmRelayAgent.last_seen_at)}</p>
            )}
          </div>

          {llmRelayToken && (
            <div className="rounded-lg border border-status-yellow/40 bg-status-yellow/5 p-3 lg:col-span-2">
              <div className="text-xs font-semibold text-foreground">一次性 Agent 令牌</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                离开本页后无法再次查看；复制后在 Mac 运行一次本机安装器，安装器会让你填写阿里云地址和此令牌，并安全保存到 macOS 钥匙串。以后登录 Mac 会自动启动，无需每天重新填写。
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Input readOnly value={llmRelayToken} className="font-mono text-xs" />
                <Button variant="outline" onClick={copyLlmRelayToken}><Copy className="h-4 w-4" />复制</Button>
              </div>
            </div>
          )}
          {llmRelayMessage && (
            <p className={`text-xs lg:col-span-2 ${llmRelayMessage.includes('失败') ? 'text-status-red' : 'text-status-green'}`}>
              {llmRelayMessage}
            </p>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title="品牌设置（AI 舆情判断按此租户的品牌语境）" description="定义当前租户的品牌边界和判断语境。" onSave={() => save('brand')}>
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="品牌名称"><Input value={settings.brand_name || ''} onChange={e => u('brand_name', e.target.value)} placeholder="如：安吉星" /></Field>
          <Field label="品牌别名（逗号分隔）"><Input value={settings.brand_aliases || ''} onChange={e => u('brand_aliases', e.target.value)} placeholder="如：OnStar,安吉星" /></Field>
          <Field label="业务背景" full><Input value={settings.brand_business_context || ''} onChange={e => u('brand_business_context', e.target.value)} placeholder="一句话描述品牌业务，如：车联网服务，提供远程控制/车况检测/道路救援等" /></Field>
          <Field label="强相关词（逗号分隔）" full><Input value={settings.brand_relevance_terms || ''} onChange={e => u('brand_relevance_terms', e.target.value)} placeholder="出现这些词更可能与品牌相关，如：车主,续费,客服,App" /></Field>
          <Field label="噪音/排除词（逗号分隔）" full><Input value={settings.brand_noise_terms || ''} onChange={e => u('brand_noise_terms', e.target.value)} placeholder="出现这些词多为无关，如：同名地名/小区/人名" /></Field>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">留空则回退到系统默认（安吉星）语境。给新公司开租户后，请在这里填该公司自己的品牌，AI 才会按它的语境判舆情。</p>
      </SettingsCard>

      <SettingsCard
        title="舆情值守范围"
        description="决定风险评论是否进入日常值守提醒和舆情风险统计。"
        onSave={() => save('comment-risk')}
      >
        <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
          <input
            type="checkbox"
            checked={settings.comment_risk_attention_enabled !== 'false'}
            onChange={event => u('comment_risk_attention_enabled', event.target.checked ? 'true' : 'false')}
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span>
            <span className="block text-sm font-semibold">评论纳入舆情关注</span>
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
              开启后，风险评论进入手机待办、指挥中心、分析看板、报告和舆情剖析；关闭后仍持续采集、AI 标注并保留评论分诊，但不再计入值守提醒和舆情风险数字。
            </span>
          </span>
        </label>
      </SettingsCard>

      <SettingsCard title="报告时间" description="分别设置日报、周报和月报的生成时点。" onSave={() => save('report')}>
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="日报时间"><Input value={settings.report_daily_time || '09:00'} onChange={e => u('report_daily_time', e.target.value)} /></Field>
          <Field label="周报时间"><Input value={settings.report_weekly_time || '09:00'} onChange={e => u('report_weekly_time', e.target.value)} /></Field>
          <Field label="月报日期"><Input value={settings.report_monthly_day || '1'} onChange={e => u('report_monthly_day', e.target.value)} /></Field>
          <Field label="月报时间"><Input value={settings.report_monthly_time || '09:00'} onChange={e => u('report_monthly_time', e.target.value)} /></Field>
        </div>
      </SettingsCard>

      <SettingsCard title="邮件发送" description="设置报告邮件的发送服务和收件人。" onSave={() => save('email')}>
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="SMTP 主机"><Input value={settings.smtp_host || ''} onChange={e => u('smtp_host', e.target.value)} /></Field>
          <Field label="SMTP 端口"><Input value={settings.smtp_port || '465'} onChange={e => u('smtp_port', e.target.value)} /></Field>
          <Field label="SMTP 账号"><Input value={settings.smtp_user || ''} onChange={e => u('smtp_user', e.target.value)} /></Field>
          <Field label="SMTP 密码"><Input type="password" value={settings.smtp_pass || ''} onChange={e => u('smtp_pass', e.target.value)} placeholder="留空不修改" /></Field>
          <Field label="发件人"><Input value={settings.email_from || ''} onChange={e => u('email_from', e.target.value)} /></Field>
          <Field label="收件人"><Input value={settings.email_to || ''} onChange={e => u('email_to', e.target.value)} /></Field>
          <Field label="任务需人工介入通知邮箱">
            <Input
              value={settings.capture_attention_email_to || ''}
              onChange={e => u('capture_attention_email_to', e.target.value)}
              placeholder="验证码或安全审核时通知"
            />
          </Field>
        </div>
      </SettingsCard>
    </div>
  )
}

/* ==================== Shared components ==================== */
function Spin() { return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div> }

function Table({ heads, children }: { heads: string[]; children: React.ReactNode }) {
  return (
    <div className="hidden overflow-hidden rounded-lg border border-border bg-card lg:block">
      <table className="w-full text-sm">
        <thead><tr className="border-b border-border bg-muted/50">
          {heads.map(h => <th key={h} className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{h}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  )
}

function MobileList({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 lg:hidden">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] font-bold tracking-[0.14em] text-muted-foreground">{label}</h2>
        <span className="text-[11px] text-muted-foreground">纵向查看</span>
      </div>
      {children}
    </section>
  )
}

function MobileEntityCard({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <article className={`relative overflow-hidden rounded-2xl border bg-card p-4 shadow-sm ${active ? 'border-border' : 'border-destructive/25'}`}>
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${active ? 'bg-status-green' : 'bg-destructive'}`} />
      {children}
    </article>
  )
}

function MobileMeta({ label, value, danger = false }: { label: string; value: React.ReactNode; danger?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl bg-muted/45 px-3 py-2.5">
      <p className="text-[10px] font-bold tracking-wide text-muted-foreground">{label}</p>
      <div className={`mt-1 break-words text-[13px] font-semibold leading-5 ${danger ? 'text-destructive' : 'text-foreground'}`}>{value}</div>
    </div>
  )
}

function authCodeTypeLabel(type: string) {
  if (type === 'trial') return '试用'
  if (type === 'annual') return '年付'
  if (type === 'permanent') return '永久'
  return type || '-'
}

function AuthCodeEditor({
  code,
  form,
  busy,
  message,
  today,
  onChange,
  onSave,
  onCancel,
  desktop = false,
}: {
  code: any
  form: AuthCodeEditForm
  busy: boolean
  message: string
  today: string
  onChange: (form: AuthCodeEditForm) => void
  onSave: () => void
  onCancel: () => void
  desktop?: boolean
}) {
  const bindingCount = Number(code.binding_count || 0)
  const permanent = code.type === 'permanent'
  return (
    <div className={`${desktop ? 'rounded-lg border border-border bg-card p-4' : 'mt-4 border-t border-border/70 pt-4'}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold">调整设备与有效期</p>
          <p className="mt-1 text-xs text-muted-foreground">当前已绑定 {bindingCount} 个设备，设备上限不能低于该数量。</p>
        </div>
        <StatusBadge tone="neutral">{authCodeTypeLabel(code.type)}</StatusBadge>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_auto] lg:items-end">
        <Field label="设备上限">
          <Input
            type="number"
            inputMode="numeric"
            min={Math.max(1, bindingCount)}
            max={10000}
            step={1}
            value={form.maxBindings}
            onChange={e => onChange({ ...form, maxBindings: e.target.value })}
          />
        </Field>
        <Field label={permanent ? '到期日(长期有效)' : '到期日'}>
          <Input
            type="date"
            min={today}
            disabled={permanent}
            value={form.expiresOn}
            onChange={e => onChange({ ...form, expiresOn: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2 lg:flex">
          <Button variant="outline" onClick={onCancel} disabled={busy}>取消</Button>
          <Button onClick={onSave} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存授权
          </Button>
        </div>
      </div>
      {message && <p className={`mt-3 text-xs font-medium ${message === '授权配置已保存' ? 'text-status-green' : 'text-destructive'}`}>{message}</p>}
    </div>
  )
}

function Field({ label, children, full, className = '' }: { label: string; children: React.ReactNode; full?: boolean; className?: string }) {
  return <label className={`space-y-1.5 [&_input]:h-11 lg:[&_input]:h-9 ${full ? 'lg:col-span-2' : ''} ${className}`}><span className="text-xs font-semibold text-muted-foreground">{label}</span>{children}</label>
}

function SettingsCard({ title, description, onSave, children }: { title: string; description?: string; onSave: () => void; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4 lg:rounded-lg lg:p-5">
      <div className="mb-4">
        <h2 className="text-base font-bold leading-6 lg:text-sm">{title}</h2>
        {description && <p className="mt-1 text-xs leading-5 text-muted-foreground lg:hidden">{description}</p>}
      </div>
      {children}
      <div className="mt-4 border-t border-border/70 pt-4 lg:flex lg:justify-end lg:border-0 lg:pt-0">
        <Button className="h-11 w-full lg:h-8 lg:w-auto" size="sm" onClick={onSave}><Save className="h-3.5 w-3.5" /> <span className="lg:hidden">保存本组设置</span><span className="hidden lg:inline">保存</span></Button>
      </div>
    </section>
  )
}
