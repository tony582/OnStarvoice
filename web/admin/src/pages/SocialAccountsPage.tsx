import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, Bot, Check, Clock3,
  Edit3, Loader2, Phone, Plus, RefreshCw, Search,
  ShieldAlert, Sparkles, UserRoundCog, WandSparkles, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type SocialPlatform = 'xiaohongshu' | 'douyin' | 'weibo'
type HealthStatus = 'active' | 'resting' | 'risk' | 'login_required' | 'disabled' | 'unknown'

interface SocialBinding {
  id: string
  agent_id: string
  social_account_id: string
  platform: SocialPlatform
  status: 'current' | 'historical'
  source: string
  last_login_state: 'authenticated' | 'logged_out' | 'unknown'
  first_seen_at: string
  last_seen_at: string
  ended_at?: string | null
  agent_display_name?: string
  agent_host_label?: string
  agent_browser_name?: string
  agent_operating_system?: string
  agent_last_heartbeat_at?: string
  agent_online?: boolean
}

interface SocialUsage {
  social_account_id: string
  agent_id: string
  platform: SocialPlatform
  usage_date: string
  searches: number
  enhancements: number
  capture_runs: number
  captured_items: number
  failed_events: number
  last_event_at?: string | null
}

interface SocialAccount {
  id: string
  platform: SocialPlatform
  platform_account_id: string
  account_handle: string
  display_name: string
  registered_phone: string
  identity_source: 'manual' | 'extension' | 'placeholder'
  health_status: HealthStatus
  effective_health_status: HealthStatus
  rest_until?: string | null
  notes: string
  daily_search_limit: number
  daily_enhancement_limit: number
  daily_capture_limit: number
  last_seen_at?: string | null
  last_agent_id?: string | null
  created_at: string
  updated_at: string
  bindings: SocialBinding[]
  usage: SocialUsage[]
}

interface SocialAgent {
  id: string
  display_name?: string
  host_label?: string
  client_label?: string
  browser_name?: string
  operating_system?: string
  app_version?: string
  allowed_platforms?: string[]
  status: string
  last_heartbeat_at?: string
  online?: boolean
}

interface SocialAccountsOverview {
  ok: boolean
  days: number
  today: string
  accounts: SocialAccount[]
  agents: SocialAgent[]
  summary: {
    accounts: number
    boundAgents: number
    needsAttention: number
    resting: number
    today: {
      searches: number
      enhancements: number
      captureRuns: number
      capturedItems: number
    }
  }
}

interface AccountForm {
  platform: SocialPlatform
  displayName: string
  accountHandle: string
  platformAccountId: string
  registeredPhone: string
  healthStatus: HealthStatus
  restUntil: string
  dailySearchLimit: string
  dailyEnhancementLimit: string
  dailyCaptureLimit: string
  notes: string
}

const PLATFORM_META: Record<SocialPlatform, { label: string; short: string; className: string }> = {
  xiaohongshu: { label: '小红书', short: '小红书', className: 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300' },
  douyin: { label: '抖音', short: '抖音', className: 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' },
  weibo: { label: '微博', short: '微博', className: 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-300' },
}

const STATUS_META: Record<HealthStatus, { label: string; className: string }> = {
  active: { label: '可使用', className: 'bg-status-green/10 text-emerald-700 dark:text-emerald-300' },
  resting: { label: '休息中', className: 'bg-status-blue/10 text-status-indigo dark:text-blue-300' },
  risk: { label: '风险观察', className: 'bg-status-red/10 text-status-red' },
  login_required: { label: '需要登录', className: 'bg-status-orange/15 text-amber-700 dark:text-amber-300' },
  disabled: { label: '已停用', className: 'bg-muted text-muted-foreground' },
  unknown: { label: '待确认', className: 'bg-muted text-muted-foreground' },
}

const FORM_CONTROL_CLASS =
  'h-10 w-full rounded-lg border border-input bg-background px-3 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:bg-muted/45 disabled:text-muted-foreground'

const emptyForm = (): AccountForm => ({
  platform: 'xiaohongshu',
  displayName: '',
  accountHandle: '',
  platformAccountId: '',
  registeredPhone: '',
  healthStatus: 'active',
  restUntil: '',
  dailySearchLimit: '',
  dailyEnhancementLimit: '',
  dailyCaptureLimit: '',
  notes: '',
})

function localDateTimeInput(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (item: number) => String(item).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formFromAccount(account: SocialAccount): AccountForm {
  return {
    platform: account.platform,
    displayName: account.display_name || '',
    accountHandle: account.account_handle || '',
    platformAccountId: account.platform_account_id || '',
    registeredPhone: account.registered_phone || '',
    healthStatus: account.effective_health_status || account.health_status,
    restUntil: localDateTimeInput(account.rest_until),
    dailySearchLimit: account.daily_search_limit ? String(account.daily_search_limit) : '',
    dailyEnhancementLimit: account.daily_enhancement_limit ? String(account.daily_enhancement_limit) : '',
    dailyCaptureLimit: account.daily_capture_limit ? String(account.daily_capture_limit) : '',
    notes: account.notes || '',
  }
}

function accountPayload(form: AccountForm) {
  const count = (value: string) => Math.max(0, Math.floor(Number(value) || 0))
  return {
    platform: form.platform,
    displayName: form.displayName.trim(),
    accountHandle: form.accountHandle.trim(),
    platformAccountId: form.platformAccountId.trim(),
    registeredPhone: form.registeredPhone.trim(),
    healthStatus: form.healthStatus,
    restUntil: form.restUntil ? new Date(form.restUntil).toISOString() : null,
    dailySearchLimit: count(form.dailySearchLimit),
    dailyEnhancementLimit: count(form.dailyEnhancementLimit),
    dailyCaptureLimit: count(form.dailyCaptureLimit),
    notes: form.notes.trim(),
  }
}

function dayKey(value: unknown) {
  const text = String(value || '')
  return /^\d{4}-\d{2}-\d{2}/u.test(text) ? text.slice(0, 10) : ''
}

function usageForDay(account: SocialAccount, date: string) {
  return account.usage
    .filter(row => dayKey(row.usage_date) === date)
    .reduce(
      (sum, row) => ({
        searches: sum.searches + Number(row.searches || 0),
        enhancements: sum.enhancements + Number(row.enhancements || 0),
        captureRuns: sum.captureRuns + Number(row.capture_runs || 0),
        capturedItems: sum.capturedItems + Number(row.captured_items || 0),
        failedEvents: sum.failedEvents + Number(row.failed_events || 0),
      }),
      { searches: 0, enhancements: 0, captureRuns: 0, capturedItems: 0, failedEvents: 0 },
    )
}

function accountNeedsRest(account: SocialAccount, today: string) {
  const usage = usageForDay(account, today)
  return (
    (account.daily_search_limit > 0 && usage.searches >= account.daily_search_limit) ||
    (account.daily_enhancement_limit > 0 && usage.enhancements >= account.daily_enhancement_limit) ||
    (account.daily_capture_limit > 0 && usage.captureRuns >= account.daily_capture_limit)
  )
}

function maskPhone(value: string) {
  const phone = String(value || '').trim()
  if (!phone) return ''
  if (phone.length <= 7) return `${phone.slice(0, 2)}••••`
  return `${phone.slice(0, 3)}••••${phone.slice(-4)}`
}

function formatMoment(value?: string | null) {
  if (!value) return '暂无'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '暂无'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function agentName(agent: SocialAgent | SocialBinding) {
  const binding = agent as SocialBinding
  const node = agent as SocialAgent
  return (
    binding.agent_display_name ||
    node.display_name ||
    binding.agent_browser_name ||
    node.browser_name ||
    node.client_label ||
    '未命名 Agent'
  )
}

function supportsPlatform(agent: SocialAgent, platform: SocialPlatform) {
  return !Array.isArray(agent.allowed_platforms) ||
    agent.allowed_platforms.length === 0 ||
    agent.allowed_platforms.includes(platform)
}

function restUntilTomorrow() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
}

export function SocialAccountsPage() {
  const { tenantId, canWrite } = useAuth()
  const [overview, setOverview] = useState<SocialAccountsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [query, setQuery] = useState('')
  const [platformFilter, setPlatformFilter] = useState<'all' | SocialPlatform>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'attention' | HealthStatus>('all')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingAccountId, setEditingAccountId] = useState('')
  const [form, setForm] = useState<AccountForm>(emptyForm)
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  const [editorTab, setEditorTab] = useState<'profile' | 'usage'>('profile')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    try {
      const data = await api.get<SocialAccountsOverview>('/social-accounts/overview?days=7')
      setOverview(data)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '账号负载读取失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void load() })
    return () => { active = false }
  }, [tenantId, load])

  useEffect(() => {
    if (!editorOpen) return
    const previous = document.body.style.overflow
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEditorOpen(false)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', close)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', close)
    }
  }, [editorOpen])

  const editingAccount = useMemo(
    () => overview?.accounts.find(account => account.id === editingAccountId) || null,
    [editingAccountId, overview?.accounts],
  )

  const openCreate = () => {
    setEditingAccountId('')
    setForm(emptyForm())
    setSelectedAgentIds([])
    setEditorTab('profile')
    setEditorOpen(true)
  }

  const openEdit = (account: SocialAccount, tab: 'profile' | 'usage' = 'profile') => {
    setEditingAccountId(account.id)
    setForm(formFromAccount(account))
    setSelectedAgentIds(
      account.bindings
        .filter(binding => binding.status === 'current')
        .map(binding => binding.agent_id),
    )
    setEditorTab(tab)
    setEditorOpen(true)
  }

  const visibleAccounts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const today = overview?.today || ''
    return (overview?.accounts || [])
      .filter(account => platformFilter === 'all' || account.platform === platformFilter)
      .filter(account => {
        if (statusFilter === 'all') return true
        if (statusFilter === 'attention') {
          return (
            ['risk', 'login_required'].includes(account.effective_health_status) ||
            accountNeedsRest(account, today)
          )
        }
        return account.effective_health_status === statusFilter
      })
      .filter(account => {
        if (!normalizedQuery) return true
        const bindings = account.bindings
          .filter(binding => binding.status === 'current')
          .map(binding => `${binding.agent_display_name || ''} ${binding.agent_host_label || ''}`)
          .join(' ')
        return `${account.display_name} ${account.account_handle} ${account.platform_account_id} ${account.registered_phone} ${bindings}`
          .toLowerCase()
          .includes(normalizedQuery)
      })
      .sort((left, right) => {
        const leftAttention = Number(
          ['risk', 'login_required'].includes(left.effective_health_status) ||
          accountNeedsRest(left, today),
        )
        const rightAttention = Number(
          ['risk', 'login_required'].includes(right.effective_health_status) ||
          accountNeedsRest(right, today),
        )
        if (leftAttention !== rightAttention) return rightAttention - leftAttention
        return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
      })
  }, [overview, platformFilter, query, statusFilter])

  const saveAccount = async () => {
    if (!canWrite()) return
    setSaving(true)
    setError('')
    setFeedback('')
    try {
      const payload = accountPayload(form)
      let accountId = editingAccountId
      let existingBindings = editingAccount?.bindings.filter(binding => binding.status === 'current') || []
      if (editingAccountId) {
        await api.patch(`/social-accounts/${editingAccountId}`, payload)
      } else {
        const created = await api.post<{ account: SocialAccount }>('/social-accounts', payload)
        accountId = created.account.id
        existingBindings = []
      }

      const desired = new Set(selectedAgentIds)
      await Promise.all(
        existingBindings
          .filter(binding => !desired.has(binding.agent_id))
          .map(binding => api.delete(`/social-accounts/bindings/${binding.id}`)),
      )
      const existingAgentIds = new Set(existingBindings.map(binding => binding.agent_id))
      await Promise.all(
        selectedAgentIds
          .filter(agentId => !existingAgentIds.has(agentId))
          .map(agentId =>
            api.post(`/social-accounts/${accountId}/bindings`, { agentId }),
          ),
      )
      setFeedback(editingAccountId ? '账号资料与 Agent 绑定已更新' : '社交账号已建立')
      setEditorOpen(false)
      await load(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存账号失败')
    } finally {
      setSaving(false)
    }
  }

  const setRestState = async (account: SocialAccount, resting: boolean) => {
    if (!canWrite()) return
    try {
      const restUntil = resting
        ? restUntilTomorrow()
        : null
      await api.patch(`/social-accounts/${account.id}`, {
        ...accountPayload(formFromAccount(account)),
        healthStatus: resting ? 'resting' : 'active',
        restUntil,
      })
      setFeedback(resting ? '已标记该账号休息 24 小时' : '账号已恢复为可使用')
      await load(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新账号状态失败')
    }
  }

  if (loading && !overview) {
    return (
      <div className="flex min-h-[420px] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />正在汇总账号负载…
      </div>
    )
  }

  const today = overview?.today || ''
  const attentionCount = (overview?.accounts || []).filter(account =>
    ['risk', 'login_required'].includes(account.effective_health_status) ||
    accountNeedsRest(account, today),
  ).length

  return (
    <div className="mx-auto w-full max-w-[1580px] space-y-5">
      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex flex-col gap-5 px-5 py-5 lg:flex-row lg:items-center lg:justify-between lg:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-primary">
              <Activity className="h-3.5 w-3.5" />Account workload
            </div>
            <h2 className="mt-1.5 text-[24px] font-extrabold tracking-[-0.035em]">今天哪些账号该继续，哪些该休息</h2>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              Extension 自动识别当前登录账号；注册手机号和阈值由你补充管理。
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-3 divide-x divide-border rounded-xl border border-border bg-background">
            <DecisionMetric label="需要处理" value={attentionCount} alert={attentionCount > 0} />
            <DecisionMetric label="休息中" value={overview?.summary.resting || 0} />
            <DecisionMetric label="已绑定 Agent" value={overview?.summary.boundAgents || 0} />
          </div>
        </div>
        <div className="grid grid-cols-2 border-t border-border bg-muted/20 sm:grid-cols-4">
          <TodayMetric icon={Search} label="搜索" value={overview?.summary.today.searches || 0} />
          <TodayMetric icon={WandSparkles} label="增强" value={overview?.summary.today.enhancements || 0} />
          <TodayMetric icon={Bot} label="采集运行" value={overview?.summary.today.captureRuns || 0} />
          <TodayMetric icon={Sparkles} label="采到内容" value={overview?.summary.today.capturedItems || 0} />
        </div>
      </section>

      {(feedback || error) && (
        <div className={cn(
          'flex items-start gap-2 rounded-xl border px-4 py-3 text-[12px]',
          error
            ? 'border-status-red/25 bg-status-red/5 text-status-red'
            : 'border-status-green/25 bg-status-green/5 text-emerald-700 dark:text-emerald-300',
        )}>
          {error ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <Check className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{error || feedback}</span>
        </div>
      )}

      <section>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div>
            <h2 className="flex items-center gap-2 text-[18px] font-extrabold tracking-[-0.02em]">
              <UserRoundCog className="h-5 w-5 text-primary" />社交账号
              <span className="text-[12px] font-medium text-muted-foreground">{visibleAccounts.length} 个</span>
            </h2>
            <p className="mt-1 text-[11px] text-muted-foreground">每日次数按账号归档，不因更换 Agent 而丢失。</p>
          </div>
          <div className="flex flex-1 flex-wrap items-center gap-2 lg:justify-end">
            <label className="relative min-w-[180px] flex-1 lg:max-w-[260px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索账号、手机号或 Agent"
                className="h-10 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-[12px] outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
            </label>
            <select value={platformFilter} onChange={event => setPlatformFilter(event.target.value as typeof platformFilter)}
              className="h-10 rounded-lg border border-input bg-card px-3 text-[12px] font-medium outline-none focus:border-primary">
              <option value="all">全部平台</option>
              <option value="xiaohongshu">小红书</option>
              <option value="douyin">抖音</option>
              <option value="weibo">微博</option>
            </select>
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}
              className="h-10 rounded-lg border border-input bg-card px-3 text-[12px] font-medium outline-none focus:border-primary">
              <option value="all">全部状态</option>
              <option value="attention">需要处理</option>
              <option value="active">可使用</option>
              <option value="resting">休息中</option>
              <option value="login_required">需要登录</option>
              <option value="risk">风险观察</option>
              <option value="disabled">已停用</option>
            </select>
            <Button variant="outline" size="icon" onClick={() => void load(true)} disabled={refreshing} aria-label="刷新账号负载">
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </Button>
            <Button onClick={openCreate} disabled={!canWrite()}>
              <Plus className="h-4 w-4" />新建账号
            </Button>
          </div>
        </div>

        <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-card">
          <div className="hidden grid-cols-[minmax(230px,1.2fr)_minmax(180px,0.9fr)_minmax(340px,1.55fr)_150px] gap-5 border-b border-border bg-muted/25 px-5 py-2.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground lg:grid">
            <div>账号</div><div>当前 Agent</div><div>今日负载</div><div className="text-right">状态与操作</div>
          </div>
          {visibleAccounts.map((account, index) => (
            <AccountRow
              key={account.id}
              account={account}
              today={today}
              divided={index > 0}
              writable={canWrite()}
              onEdit={() => openEdit(account)}
              onUsage={() => openEdit(account, 'usage')}
              onRest={resting => void setRestState(account, resting)}
            />
          ))}
          {!visibleAccounts.length && (
            <div className="px-5 py-16 text-center">
              <UserRoundCog className="mx-auto h-8 w-8 text-muted-foreground/50" />
              <div className="mt-3 text-sm font-bold">还没有符合条件的账号</div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                打开 Extension 并保持 Agent 在线后，系统会自动登记识别到的登录账号。
              </p>
              {canWrite() && <Button size="sm" className="mt-4" onClick={openCreate}><Plus className="h-4 w-4" />手动建立账号</Button>}
            </div>
          )}
        </div>
      </section>

      {editorOpen && (
        <AccountEditor
          account={editingAccount}
          overview={overview}
          form={form}
          setForm={setForm}
          selectedAgentIds={selectedAgentIds}
          setSelectedAgentIds={setSelectedAgentIds}
          tab={editorTab}
          setTab={setEditorTab}
          saving={saving}
          writable={canWrite()}
          onClose={() => setEditorOpen(false)}
          onSave={() => void saveAccount()}
        />
      )}
    </div>
  )
}

function DecisionMetric({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return (
    <div className="min-w-[92px] px-3 py-3 text-center sm:min-w-[116px]">
      <div className={cn('text-[22px] font-extrabold tabular-nums tracking-[-0.04em]', alert && 'text-status-red')}>{value}</div>
      <div className="mt-0.5 whitespace-nowrap text-[10px] font-medium text-muted-foreground">{label}</div>
    </div>
  )
}

function TodayMetric({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary"><Icon className="h-4 w-4" /></span>
      <div><div className="text-[17px] font-extrabold tabular-nums">{value}</div><div className="text-[10px] text-muted-foreground">{label} · 今天</div></div>
    </div>
  )
}

function AccountRow({
  account,
  today,
  divided,
  writable,
  onEdit,
  onUsage,
  onRest,
}: {
  account: SocialAccount
  today: string
  divided: boolean
  writable: boolean
  onEdit: () => void
  onUsage: () => void
  onRest: (resting: boolean) => void
}) {
  const usage = usageForDay(account, today)
  const bindings = account.bindings.filter(binding => binding.status === 'current')
  const needsRest = accountNeedsRest(account, today)
  const status = account.effective_health_status || account.health_status
  const statusMeta = STATUS_META[status]
  return (
    <article className={cn(
      'grid gap-4 px-4 py-4 transition-colors hover:bg-muted/15 lg:grid-cols-[minmax(230px,1.2fr)_minmax(180px,0.9fr)_minmax(340px,1.55fr)_150px] lg:items-center lg:gap-5 lg:px-5',
      divided && 'border-t border-border',
    )}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('shrink-0 rounded-md px-2 py-1 text-[9px] font-extrabold', PLATFORM_META[account.platform].className)}>
            {PLATFORM_META[account.platform].short}
          </span>
          <button type="button" onClick={onEdit} className="truncate text-left text-[14px] font-extrabold hover:text-primary">
            {account.display_name || account.account_handle || '未识别账号'}
          </button>
          {account.identity_source === 'extension' && (
            <span className="shrink-0 rounded bg-primary/8 px-1.5 py-0.5 text-[8px] font-bold text-primary">自动识别</span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-muted-foreground">
          {account.account_handle && <span>@{account.account_handle}</span>}
          {account.platform_account_id && <span>ID {account.platform_account_id}</span>}
          {account.registered_phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{maskPhone(account.registered_phone)}</span>}
        </div>
      </div>

      <div className="min-w-0">
        {bindings.length ? (
          <div className="space-y-1.5">
            {bindings.slice(0, 2).map(binding => (
              <div key={binding.id} className="flex min-w-0 items-center gap-2 text-[11px]">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', binding.agent_online ? 'bg-status-green' : 'bg-status-grey')} />
                <span className="truncate font-semibold">{agentName(binding)}</span>
                <span className="shrink-0 text-[9.5px] text-muted-foreground">{binding.agent_online ? '在线' : '离线'}</span>
              </div>
            ))}
            {bindings.length > 2 && <div className="text-[10px] text-muted-foreground">另 {bindings.length - 2} 个 Agent</div>}
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">尚未绑定 Agent</span>
        )}
      </div>

      <button type="button" onClick={onUsage} className="grid grid-cols-3 gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
        <UsageRail label="搜索" value={usage.searches} limit={account.daily_search_limit} tone="blue" />
        <UsageRail label="增强" value={usage.enhancements} limit={account.daily_enhancement_limit} tone="purple" />
        <UsageRail label="采集" value={usage.captureRuns} limit={account.daily_capture_limit} tone="green" meta={`${usage.capturedItems} 条`} />
      </button>

      <div className="flex items-center justify-between gap-3 lg:block lg:text-right">
        <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
          <span className={cn('rounded-full px-2.5 py-1 text-[10px] font-bold', statusMeta.className)}>{statusMeta.label}</span>
          {needsRest && !['risk', 'login_required', 'resting'].includes(status) && (
            <span className="rounded-full bg-status-orange/15 px-2.5 py-1 text-[10px] font-bold text-amber-700 dark:text-amber-300">建议休息</span>
          )}
        </div>
        <div className="mt-0 flex items-center gap-1 lg:mt-2 lg:justify-end">
          {writable && (
            status === 'resting' ? (
              <button type="button" onClick={() => onRest(false)} className="rounded-lg px-2 py-1.5 text-[10px] font-bold text-primary hover:bg-accent">恢复使用</button>
            ) : (
              <button type="button" onClick={() => onRest(true)} className="rounded-lg px-2 py-1.5 text-[10px] font-bold text-muted-foreground hover:bg-muted hover:text-foreground">标记休息 24h</button>
            )
          )}
          <button type="button" onClick={onEdit} aria-label="编辑账号" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
            <Edit3 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </article>
  )
}

function UsageRail({ label, value, limit, tone, meta }: { label: string; value: number; limit: number; tone: 'blue' | 'purple' | 'green'; meta?: string }) {
  const percent = limit > 0 ? Math.min(100, Math.round((value / limit) * 100)) : Math.min(100, value > 0 ? 18 : 0)
  const over = limit > 0 && value >= limit
  const color = over
    ? 'bg-status-orange'
    : tone === 'purple'
      ? 'bg-status-purple'
      : tone === 'green'
        ? 'bg-status-green'
        : 'bg-status-indigo'
  return (
    <span className="min-w-0">
      <span className="flex items-baseline gap-1">
        <span className={cn('text-[15px] font-extrabold tabular-nums', over && 'text-amber-700 dark:text-amber-300')}>{value}</span>
        <span className="truncate text-[9px] text-muted-foreground">/ {limit || '未设'}</span>
      </span>
      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">
        <span className={cn('block h-full rounded-full transition-[width]', color)} style={{ width: `${percent}%` }} />
      </span>
      <span className="mt-1 flex items-center justify-between text-[9px] text-muted-foreground">
        <span>{label}</span>{meta && <span>{meta}</span>}
      </span>
    </span>
  )
}

function AccountEditor({
  account,
  overview,
  form,
  setForm,
  selectedAgentIds,
  setSelectedAgentIds,
  tab,
  setTab,
  saving,
  writable,
  onClose,
  onSave,
}: {
  account: SocialAccount | null
  overview: SocialAccountsOverview | null
  form: AccountForm
  setForm: React.Dispatch<React.SetStateAction<AccountForm>>
  selectedAgentIds: string[]
  setSelectedAgentIds: React.Dispatch<React.SetStateAction<string[]>>
  tab: 'profile' | 'usage'
  setTab: (tab: 'profile' | 'usage') => void
  saving: boolean
  writable: boolean
  onClose: () => void
  onSave: () => void
}) {
  const agents = (overview?.agents || []).filter(agent => supportsPlatform(agent, form.platform))
  const setField = <K extends keyof AccountForm>(key: K, value: AccountForm[K]) => {
    setForm(current => ({ ...current, [key]: value }))
  }
  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds(current =>
      current.includes(agentId)
        ? current.filter(id => id !== agentId)
        : [...current, agentId],
    )
  }
  const dailyRows = account
    ? Array.from(
        new Set(account.usage.map(row => dayKey(row.usage_date)).filter(Boolean)),
      )
        .sort((left, right) => right.localeCompare(left))
        .slice(0, 7)
        .map(date => ({ date, ...usageForDay(account, date) }))
    : []

  return (
    <div className="fixed inset-0 z-[90]">
      <button type="button" aria-label="关闭账号编辑" onClick={onClose} className="absolute inset-0 bg-black/25 backdrop-blur-[1px]" />
      <section role="dialog" aria-modal="true" aria-label={account ? '账号详情' : '新建社交账号'}
        className="absolute inset-y-0 right-0 flex w-full max-w-[590px] flex-col border-l border-border bg-background shadow-xl">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-4 sm:px-5">
          <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl', PLATFORM_META[form.platform].className)}>
            <UserRoundCog className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary">{account ? 'Account profile' : 'New account'}</div>
            <h2 className="truncate text-[18px] font-extrabold">{account ? (account.display_name || account.account_handle || '未识别账号') : '新建社交账号'}</h2>
          </div>
          <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex shrink-0 gap-1 border-b border-border px-4 pt-2 sm:px-5">
          <EditorTab active={tab === 'profile'} onClick={() => setTab('profile')}>资料与绑定</EditorTab>
          <EditorTab active={tab === 'usage'} onClick={() => setTab('usage')} disabled={!account}>每日用量</EditorTab>
        </div>

        <div className="workspace-scrollbar flex-1 overflow-y-auto px-4 py-5 sm:px-5">
          {tab === 'profile' ? (
            <div className="space-y-6">
              <EditorSection title="账号资料" copy="Extension 尽量自动识别账号；注册手机号仅由后台人工维护。">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="平台">
                    <select value={form.platform} disabled={Boolean(account) || !writable} onChange={event => setField('platform', event.target.value as SocialPlatform)} className={FORM_CONTROL_CLASS}>
                      <option value="xiaohongshu">小红书</option>
                      <option value="douyin">抖音</option>
                      <option value="weibo">微博</option>
                    </select>
                  </Field>
                  <Field label="账号名称">
                    <input value={form.displayName} disabled={!writable} onChange={event => setField('displayName', event.target.value)} placeholder="客户可识别的名称" className={FORM_CONTROL_CLASS} />
                  </Field>
                  <Field label="平台账号">
                    <input value={form.accountHandle} disabled={!writable} onChange={event => setField('accountHandle', event.target.value)} placeholder="如抖音号、小红书号" className={FORM_CONTROL_CLASS} />
                  </Field>
                  <Field label="平台账号 ID">
                    <input value={form.platformAccountId} disabled={!writable} onChange={event => setField('platformAccountId', event.target.value)} placeholder="自动识别或手动填写" className={FORM_CONTROL_CLASS} />
                  </Field>
                  <Field label="注册手机号" className="sm:col-span-2" hint="仅用于内部账号管理，不下发给 Extension。">
                    <input value={form.registeredPhone} disabled={!writable} onChange={event => setField('registeredPhone', event.target.value)} placeholder="例如 138 0000 0000" inputMode="tel" className={FORM_CONTROL_CLASS} />
                  </Field>
                </div>
              </EditorSection>

              <EditorSection title="使用状态" copy="登记账号的休息、风险观察或停用状态，便于运营安排。">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="当前状态">
                    <select value={form.healthStatus} disabled={!writable} onChange={event => setField('healthStatus', event.target.value as HealthStatus)} className={FORM_CONTROL_CLASS}>
                      <option value="active">可使用</option>
                      <option value="resting">休息中</option>
                      <option value="risk">风险观察</option>
                      <option value="login_required">需要登录</option>
                      <option value="disabled">已停用</option>
                      <option value="unknown">待确认</option>
                    </select>
                  </Field>
                  <Field label="休息到">
                    <input type="datetime-local" value={form.restUntil} disabled={!writable || form.healthStatus !== 'resting'} onChange={event => setField('restUntil', event.target.value)} className={FORM_CONTROL_CLASS} />
                  </Field>
                  <Field label="备注" className="sm:col-span-2">
                    <textarea value={form.notes} disabled={!writable} onChange={event => setField('notes', event.target.value)} placeholder="例如：近期出现验证码，7 月 28 日后再启用" rows={3} className={cn(FORM_CONTROL_CLASS, 'min-h-[88px] resize-y py-2.5')} />
                  </Field>
                </div>
              </EditorSection>

              <EditorSection title="每日提醒阈值" copy="达到任一阈值后显示“建议休息”；留空表示不设置提醒。">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="搜索次数">
                    <input type="number" min="0" value={form.dailySearchLimit} disabled={!writable} onChange={event => setField('dailySearchLimit', event.target.value)} placeholder="不限制" className={FORM_CONTROL_CLASS} />
                  </Field>
                  <Field label="增强次数">
                    <input type="number" min="0" value={form.dailyEnhancementLimit} disabled={!writable} onChange={event => setField('dailyEnhancementLimit', event.target.value)} placeholder="不限制" className={FORM_CONTROL_CLASS} />
                  </Field>
                  <Field label="采集次数">
                    <input type="number" min="0" value={form.dailyCaptureLimit} disabled={!writable} onChange={event => setField('dailyCaptureLimit', event.target.value)} placeholder="不限制" className={FORM_CONTROL_CLASS} />
                  </Field>
                </div>
              </EditorSection>

              <EditorSection title="绑定 Agent" copy="同一个账号可以登记在多个浏览器节点上；给 Agent 换绑后，后续用量会记到新账号。">
                <div className="overflow-hidden rounded-xl border border-border">
                  {agents.map((agent, index) => {
                    const selected = selectedAgentIds.includes(agent.id)
                    return (
                      <button key={agent.id} type="button" disabled={!writable} onClick={() => toggleAgent(agent.id)}
                        className={cn('flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-muted/50 disabled:cursor-default', index > 0 && 'border-t border-border')}>
                        <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-md border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>
                          {selected && <Check className="h-3.5 w-3.5" />}
                        </span>
                        <span className={cn('h-2 w-2 shrink-0 rounded-full', agent.online ? 'bg-status-green' : 'bg-status-grey')} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-bold">{agentName(agent)}</span>
                          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                            {[agent.host_label, agent.browser_name, agent.operating_system].filter(Boolean).join(' · ') || '浏览器 Agent'}
                          </span>
                        </span>
                        <span className="text-[10px] text-muted-foreground">{agent.online ? '在线' : '离线'}</span>
                      </button>
                    )
                  })}
                  {!agents.length && <div className="px-4 py-8 text-center text-[11px] text-muted-foreground">当前没有支持该平台的 Agent</div>}
                </div>
              </EditorSection>
            </div>
          ) : (
            <div className="space-y-5">
              <section className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4 text-primary" />
                  <h3 className="text-[14px] font-extrabold">近 7 日账号负载</h3>
                </div>
                <p className="mt-1 text-[10.5px] leading-5 text-muted-foreground">
                  搜索指关键词搜索；增强指打开详情补齐正文、互动和评论；采集次数是 Extension 发起的采集运行，采到内容为实际返回条数。
                </p>
              </section>
              <div className="overflow-hidden rounded-2xl border border-border bg-card">
                {dailyRows.map((row, index) => (
                  <div key={row.date} className={cn('px-4 py-4', index > 0 && 'border-t border-border')}>
                    <div className="flex items-center justify-between">
                      <div className="text-[12px] font-extrabold">{row.date}</div>
                      {row.failedEvents > 0 && <span className="rounded-full bg-status-red/8 px-2 py-1 text-[9px] font-bold text-status-red">失败事件 {row.failedEvents}</span>}
                    </div>
                    <div className="mt-3 grid grid-cols-4 divide-x divide-border">
                      <DailyMetric label="搜索" value={row.searches} />
                      <DailyMetric label="增强" value={row.enhancements} />
                      <DailyMetric label="采集" value={row.captureRuns} />
                      <DailyMetric label="内容" value={row.capturedItems} />
                    </div>
                  </div>
                ))}
                {!dailyRows.length && (
                  <div className="px-4 py-14 text-center text-[11px] text-muted-foreground">
                    这个账号还没有 Extension 用量记录
                  </div>
                )}
              </div>
              {account && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <InfoLine icon={Activity} label="最近识别" value={formatMoment(account.last_seen_at)} />
                  <InfoLine icon={ShieldAlert} label="账号来源" value={account.identity_source === 'manual' ? '后台手动建立' : account.identity_source === 'extension' ? 'Extension 自动识别' : '等待补全身份'} />
                </div>
              )}
            </div>
          )}
        </div>

        {tab === 'profile' && writable && (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-4 py-3 sm:px-5">
            <span className="hidden text-[10.5px] text-muted-foreground sm:block">保存后，绑定关系会在下一次心跳生效。</span>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={onClose}>取消</Button>
              <Button onClick={onSave} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                保存账号
              </Button>
            </div>
          </footer>
        )}
      </section>
    </div>
  )
}

function EditorTab({ active, onClick, disabled, children }: { active: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={cn('relative px-3 py-2.5 text-[12px] font-bold transition-colors disabled:opacity-40', active ? 'text-primary' : 'text-muted-foreground hover:text-foreground')}>
      {children}
      {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
    </button>
  )
}

function EditorSection({ title, copy, children }: { title: string; copy: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[14px] font-extrabold">{title}</h3>
      <p className="mt-1 text-[10.5px] leading-5 text-muted-foreground">{copy}</p>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={className}>
      <span className="mb-1.5 block text-[11px] font-bold text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[9.5px] leading-4 text-muted-foreground">{hint}</span>}
    </label>
  )
}

function DailyMetric({ label, value }: { label: string; value: number }) {
  return <div className="text-center"><div className="text-[17px] font-extrabold tabular-nums">{value}</div><div className="mt-0.5 text-[9px] text-muted-foreground">{label}</div></div>
}

function InfoLine({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="h-4 w-4" /></span>
      <div><div className="text-[9px] text-muted-foreground">{label}</div><div className="mt-0.5 text-[11px] font-bold">{value}</div></div>
    </div>
  )
}
