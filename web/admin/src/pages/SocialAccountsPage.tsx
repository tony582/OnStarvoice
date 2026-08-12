import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  Clock3,
  Database,
  Edit3,
  Link2,
  Loader2,
  MonitorCheck,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Unlink,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type SocialPlatform = 'xiaohongshu' | 'douyin' | 'weibo'

type SocialUsage = {
  agent_id: string
  platform: SocialPlatform
  usage_date: string
  searches: number
  enhancements: number
  capture_runs: number
  captured_items: number
  failed_events: number
  safety_verifications: number
  last_event_at?: string | null
  last_safety_at?: string | null
}

type LinkedAccount = {
  id: string
  platform: SocialPlatform
  display_name: string
  account_handle: string
  platform_account_id: string
  registered_phone: string
  notes: string
  binding_id: string
  binding_source: string
}

type SocialAccount = {
  id: string
  platform: SocialPlatform
  display_name: string
  account_handle: string
  platform_account_id: string
  registered_phone: string
  notes: string
  bindings: Array<{
    id: string
    agent_id: string
    status: string
  }>
}

type SocialAgent = {
  id: string
  display_name?: string
  host_label?: string
  client_label?: string
  browser_name?: string
  operating_system?: string
  app_version?: string
  allowed_platforms?: string[]
  status: string
  last_heartbeat_at?: string | null
  last_error?: string
  online?: boolean
  accounts: LinkedAccount[]
  usage: SocialUsage[]
  today_safety_verifications: number
  last_safety_at?: string | null
}

type SocialAccountsOverview = {
  ok: boolean
  days: number
  today: string
  accounts: SocialAccount[]
  agents: SocialAgent[]
  summary: {
    accounts: number
    boundAgents: number
    agents: number
    onlineAgents: number
    agentsWithSafety: number
    today: {
      searches: number
      enhancements: number
      captureRuns: number
      capturedItems: number
      safetyVerifications: number
    }
  }
}

type AgentTotals = {
  searches: number
  enhancements: number
  captureRuns: number
  capturedItems: number
  failedEvents: number
  safetyVerifications: number
}

const PLATFORM_META: Record<SocialPlatform, { label: string; className: string }> = {
  xiaohongshu: { label: '小红书', className: 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300' },
  douyin: { label: '抖音', className: 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' },
  weibo: { label: '微博', className: 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-300' },
}

function dateKey(value: unknown) {
  const normalized = String(value || '')
  return /^\d{4}-\d{2}-\d{2}/u.test(normalized) ? normalized.slice(0, 10) : ''
}

function emptyTotals(): AgentTotals {
  return {
    searches: 0,
    enhancements: 0,
    captureRuns: 0,
    capturedItems: 0,
    failedEvents: 0,
    safetyVerifications: 0,
  }
}

function usageTotals(agent: SocialAgent, day: string) {
  const totals = (agent.usage || [])
    .filter(row => dateKey(row.usage_date) === day)
    .reduce((total, row) => ({
      searches: total.searches + Number(row.searches || 0),
      enhancements: total.enhancements + Number(row.enhancements || 0),
      captureRuns: total.captureRuns + Number(row.capture_runs || 0),
      capturedItems: total.capturedItems + Number(row.captured_items || 0),
      failedEvents: total.failedEvents + Number(row.failed_events || 0),
      safetyVerifications:
        total.safetyVerifications + Number(row.safety_verifications || 0),
    }), emptyTotals())
  return {
    ...totals,
    safetyVerifications: Math.max(
      totals.safetyVerifications,
      Number(agent.today_safety_verifications || 0),
    ),
  }
}

function agentName(agent: SocialAgent) {
  return agent.display_name || agent.client_label || agent.browser_name || '未命名 Agent'
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

function platformLabel(platform: string) {
  return PLATFORM_META[platform as SocialPlatform]?.label || platform || '未知平台'
}

function maskPhone(value: string) {
  const phone = String(value || '').trim()
  if (!phone) return ''
  if (phone.length <= 7) return `${phone.slice(0, 2)}••••`
  return `${phone.slice(0, 3)}••••${phone.slice(-4)}`
}

function todayLabel(today: string) {
  if (!today) return '今天'
  const [, month, day] = today.split('-')
  return `${month}/${day}`
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
  const [healthFilter, setHealthFilter] = useState<'all' | 'safety' | 'offline' | 'unbound'>('all')
  const [editingAgent, setEditingAgent] = useState<SocialAgent | null>(null)
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    try {
      const data = await api.get<SocialAccountsOverview>('/social-accounts/overview?days=7')
      setOverview({
        ...data,
        accounts: Array.isArray(data.accounts) ? data.accounts : [],
        agents: Array.isArray(data.agents) ? data.agents : [],
        summary: {
          accounts: Number(data.summary?.accounts || 0),
          boundAgents: Number(data.summary?.boundAgents || 0),
          agents: Number(data.summary?.agents || data.agents?.length || 0),
          onlineAgents: Number(data.summary?.onlineAgents || 0),
          agentsWithSafety: Number(data.summary?.agentsWithSafety || 0),
          today: {
            searches: Number(data.summary?.today?.searches || 0),
            enhancements: Number(data.summary?.today?.enhancements || 0),
            captureRuns: Number(data.summary?.today?.captureRuns || 0),
            capturedItems: Number(data.summary?.today?.capturedItems || 0),
            safetyVerifications: Number(data.summary?.today?.safetyVerifications || 0),
          },
        },
      })
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Agent 今日运行数据读取失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void load() })
    const refreshTimer = window.setInterval(() => { if (active) void load(true) }, 60_000)
    return () => {
      active = false
      window.clearInterval(refreshTimer)
    }
  }, [tenantId, load])

  useEffect(() => {
    if (!editingAgent) return
    const previousOverflow = document.body.style.overflow
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEditingAgent(null)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [editingAgent])

  const today = overview?.today || ''
  const visibleAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return (overview?.agents || [])
      .filter(agent => platformFilter === 'all' ||
        agent.usage?.some(row => row.platform === platformFilter) ||
        agent.accounts?.some(account => account.platform === platformFilter) ||
        agent.allowed_platforms?.includes(platformFilter))
      .filter(agent => {
        const totals = usageTotals(agent, today)
        if (healthFilter === 'safety') return totals.safetyVerifications > 0
        if (healthFilter === 'offline') return !agent.online
        if (healthFilter === 'unbound') return (agent.accounts || []).length === 0
        return true
      })
      .filter(agent => {
        if (!normalizedQuery) return true
        const accountText = (agent.accounts || [])
          .map(account => `${account.display_name} ${account.account_handle} ${account.platform_account_id}`)
          .join(' ')
        return `${agentName(agent)} ${agent.host_label || ''} ${agent.browser_name || ''} ${agent.operating_system || ''} ${accountText}`
          .toLowerCase()
          .includes(normalizedQuery)
      })
      .sort((left, right) => {
        const safetyDifference = usageTotals(right, today).safetyVerifications - usageTotals(left, today).safetyVerifications
        if (safetyDifference !== 0) return safetyDifference
        if (left.online !== right.online) return left.online ? -1 : 1
        return agentName(left).localeCompare(agentName(right), 'zh-CN')
      })
  }, [healthFilter, overview?.agents, platformFilter, query, today])

  const openAccountEditor = (agent: SocialAgent) => {
    setEditingAgent(agent)
    setSelectedAccountIds((agent.accounts || []).map(account => account.id))
    setFeedback('')
    setError('')
  }

  const saveAccountLinks = async () => {
    if (!editingAgent || !canWrite()) return
    setSaving(true)
    setError('')
    try {
      const currentIds = new Set((editingAgent.accounts || []).map(account => account.id))
      const nextIds = new Set(selectedAccountIds)
      const removed = (editingAgent.accounts || []).filter(account => !nextIds.has(account.id))
      const added = selectedAccountIds.filter(accountId => !currentIds.has(accountId))
      await Promise.all(
        removed.map(account => api.delete(`/social-accounts/bindings/${account.binding_id}`)),
      )
      await Promise.all(
        added.map(accountId => api.post(`/social-accounts/${accountId}/bindings`, { agentId: editingAgent.id })),
      )
      setFeedback('账号信息已更新；Agent 用量统计不受绑定变化影响')
      setEditingAgent(null)
      await load(true)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '更新账号信息失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading && !overview) {
    return (
      <div className="flex min-h-[420px] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />正在汇总 Agent 今日运行情况…
      </div>
    )
  }

  const summary = overview?.summary

  return (
    <div className="mx-auto w-full max-w-[1580px] space-y-5">
      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex flex-col gap-5 px-5 py-5 lg:flex-row lg:items-center lg:justify-between lg:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-primary">
              <MonitorCheck className="h-3.5 w-3.5" />Agent daily health
            </div>
            <h2 className="mt-1.5 text-[24px] font-extrabold tracking-[-0.035em]">今天每个 Agent 跑了多少，有没有安全验证</h2>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              搜索、增强和采集按 Agent 统计；每天 00:00 按上海自然日进入新一天。社交账号只作可选信息，不影响计数。
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-3 divide-x divide-border rounded-xl border border-border bg-background">
            <DecisionMetric label="Agent" value={summary?.agents || 0} />
            <DecisionMetric label="在线" value={summary?.onlineAgents || 0} />
            <DecisionMetric label="安全验证" value={summary?.agentsWithSafety || 0} alert={Boolean(summary?.agentsWithSafety)} suffix="个 Agent" />
          </div>
        </div>
        <div className="grid grid-cols-2 border-t border-border bg-muted/20 sm:grid-cols-5">
          <TodayMetric icon={Search} label="搜索" value={summary?.today.searches || 0} />
          <TodayMetric icon={Activity} label="采集运行" value={summary?.today.captureRuns || 0} />
          <TodayMetric icon={Sparkles} label="增强" value={summary?.today.enhancements || 0} />
          <TodayMetric icon={Database} label="采到内容" value={summary?.today.capturedItems || 0} />
          <TodayMetric icon={ShieldAlert} label="安全验证" value={summary?.today.safetyVerifications || 0} alert={Boolean(summary?.today.safetyVerifications)} />
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

      <section className="space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div>
            <h2 className="flex items-center gap-2 text-[18px] font-extrabold tracking-[-0.02em]">
              <Bot className="h-5 w-5 text-primary" />Agent 今日运行
              <span className="text-[12px] font-medium text-muted-foreground">{visibleAgents.length} 个</span>
            </h2>
            <p className="mt-1 text-[11px] text-muted-foreground">当前显示 {todayLabel(today)}；历史不会删除，只是次日默认读取新日期。</p>
          </div>
          <div className="flex flex-1 flex-wrap items-center gap-2 lg:justify-end">
            <label className="relative min-w-[190px] flex-1 lg:max-w-[280px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索 Agent、设备或账号信息"
                className="h-10 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-[12px] outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
            </label>
            <select
              value={platformFilter}
              onChange={event => setPlatformFilter(event.target.value as typeof platformFilter)}
              className="h-10 rounded-lg border border-input bg-card px-3 text-[12px] font-medium outline-none focus:border-primary"
              aria-label="按平台筛选 Agent"
            >
              <option value="all">全部平台</option>
              <option value="xiaohongshu">小红书</option>
              <option value="douyin">抖音</option>
              <option value="weibo">微博</option>
            </select>
            <select
              value={healthFilter}
              onChange={event => setHealthFilter(event.target.value as typeof healthFilter)}
              className="h-10 rounded-lg border border-input bg-card px-3 text-[12px] font-medium outline-none focus:border-primary"
              aria-label="按 Agent 健康状态筛选"
            >
              <option value="all">全部 Agent</option>
              <option value="safety">今日有安全验证</option>
              <option value="offline">当前离线</option>
              <option value="unbound">未登记账号</option>
            </select>
            <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing} className="h-10">
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />刷新
            </Button>
          </div>
        </div>

        {visibleAgents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-14 text-center">
            <Bot className="mx-auto h-8 w-8 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">当前条件下没有 Agent</h3>
            <p className="mt-1 text-xs text-muted-foreground">可清空筛选条件或等待 Agent 完成激活。</p>
          </div>
        ) : (
          <div className="grid gap-3 2xl:grid-cols-2">
            {visibleAgents.map(agent => (
              <AgentHealthCard
                key={agent.id}
                agent={agent}
                today={today}
                writable={canWrite()}
                onEdit={() => openAccountEditor(agent)}
              />
            ))}
          </div>
        )}
      </section>

      {editingAgent && (
        <AccountLinkDialog
          agent={editingAgent}
          accounts={overview?.accounts || []}
          selectedAccountIds={selectedAccountIds}
          setSelectedAccountIds={setSelectedAccountIds}
          writable={canWrite()}
          saving={saving}
          onClose={() => setEditingAgent(null)}
          onSave={() => void saveAccountLinks()}
        />
      )}
    </div>
  )
}

function AgentHealthCard({
  agent,
  today,
  writable,
  onEdit,
}: {
  agent: SocialAgent
  today: string
  writable: boolean
  onEdit: () => void
}) {
  const totals = usageTotals(agent, today)
  const safety = totals.safetyVerifications > 0
  const platforms = Array.from(new Set([
    ...(agent.usage || []).filter(row => dateKey(row.usage_date) === today).map(row => row.platform),
    ...(agent.accounts || []).map(account => account.platform),
    ...(agent.allowed_platforms || []),
  ])).filter(platform => PLATFORM_META[platform as SocialPlatform]) as SocialPlatform[]

  return (
    <article className={cn(
      'overflow-hidden rounded-2xl border bg-card shadow-xs',
      safety ? 'border-status-red/35' : 'border-border/80',
    )}>
      <header className={cn('flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between', safety && 'bg-status-red/[0.025]')}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[15px] font-extrabold">{agentName(agent)}</h3>
            <span className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
              agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground',
            )}>
              {agent.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {agent.online ? '在线' : agent.status === 'paused' ? '已暂停' : '离线'}
            </span>
            {safety && (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-red/10 px-2 py-0.5 text-[10px] font-semibold text-status-red">
                <ShieldAlert className="h-3 w-3" />今日出现安全验证
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">
            {[agent.host_label, agent.browser_name, agent.operating_system].filter(Boolean).join(' · ') || '设备信息待上报'}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {platforms.map(platform => (
              <span key={platform} className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', PLATFORM_META[platform].className)}>
                {PLATFORM_META[platform].label}
              </span>
            ))}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onEdit} disabled={!writable} className="shrink-0">
          <Edit3 className="h-3.5 w-3.5" />账号信息
        </Button>
      </header>

      <div className="grid grid-cols-2 border-y border-border/70 bg-muted/15 sm:grid-cols-5">
        <CardMetric label="搜索" value={totals.searches} />
        <CardMetric label="采集运行" value={totals.captureRuns} />
        <CardMetric label="增强" value={totals.enhancements} />
        <CardMetric label="采到内容" value={totals.capturedItems} />
        <CardMetric label="安全验证" value={totals.safetyVerifications} alert={safety} />
      </div>

      <div className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
            <Link2 className="h-3 w-3" />账号信息（可选）
          </div>
          {(agent.accounts || []).length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {agent.accounts.map(account => (
                <span key={account.id} className="max-w-full truncate rounded-md bg-muted px-2 py-1 text-[11px] text-foreground">
                  {platformLabel(account.platform)} · {account.display_name || account.account_handle || account.platform_account_id || '未命名账号'}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">未登记账号，不影响 Agent 搜索、采集和安全验证统计。</p>
          )}
        </div>
        <div className="text-[10px] leading-4 text-muted-foreground sm:text-right">
          <div>最后心跳 {formatMoment(agent.last_heartbeat_at)}</div>
          <div className={cn(safety && 'font-semibold text-status-red')}>最后安全验证 {formatMoment(agent.last_safety_at)}</div>
        </div>
      </div>
    </article>
  )
}

function AccountLinkDialog({
  agent,
  accounts,
  selectedAccountIds,
  setSelectedAccountIds,
  writable,
  saving,
  onClose,
  onSave,
}: {
  agent: SocialAgent
  accounts: SocialAccount[]
  selectedAccountIds: string[]
  setSelectedAccountIds: (ids: string[]) => void
  writable: boolean
  saving: boolean
  onClose: () => void
  onSave: () => void
}) {
  const currentAccountIds = new Set(
    (agent.accounts || []).map(account => account.id),
  )
  const supportedPlatforms = new Set(
    (agent.allowed_platforms || []).filter(platform => PLATFORM_META[platform as SocialPlatform]),
  )
  const availableAccounts = accounts.filter(account =>
    currentAccountIds.has(account.id) ||
    supportedPlatforms.size === 0 ||
    supportedPlatforms.has(account.platform),
  )

  const toggle = (accountId: string) => {
    if (selectedAccountIds.includes(accountId)) {
      setSelectedAccountIds(selectedAccountIds.filter(id => id !== accountId))
      return
    }
    const selectedAccount = availableAccounts.find(account => account.id === accountId)
    if (!selectedAccount) return
    const samePlatformIds = new Set(
      availableAccounts
        .filter(account => account.platform === selectedAccount.platform)
        .map(account => account.id),
    )
    setSelectedAccountIds([
      ...selectedAccountIds.filter(id => !samePlatformIds.has(id)),
      accountId,
    ])
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/35 p-0 sm:items-center sm:p-5" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section role="dialog" aria-modal="true" aria-label="编辑 Agent 账号信息" className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-t-[22px] border border-border bg-card shadow-xl sm:rounded-[22px]">
        <header className="flex items-start gap-3 border-b border-border px-4 py-4 sm:px-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Bot className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary">Optional account info</div>
            <h2 className="truncate text-[18px] font-extrabold">{agentName(agent)}</h2>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">账号只是设备登录信息，可登记、可不登记；每个平台最多一个，解绑不会清空 Agent 今日用量。</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="关闭账号信息">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="workspace-scrollbar flex-1 overflow-y-auto p-4 sm:p-5">
          {availableAccounts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
              <Unlink className="mx-auto h-6 w-6 text-muted-foreground" />
              <p className="mt-2 text-sm font-semibold">暂无可登记的社交账号</p>
              <p className="mt-1 text-xs text-muted-foreground">保持未绑定即可，Agent 用量仍会正常统计。</p>
            </div>
          ) : (
            <div className="space-y-2">
              {availableAccounts.map(account => {
                const selected = selectedAccountIds.includes(account.id)
                return (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => writable && toggle(account.id)}
                    disabled={!writable}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                      selected ? 'border-primary bg-primary/[0.045] ring-2 ring-primary/10' : 'border-border hover:bg-muted/35',
                    )}
                  >
                    <span className={cn(
                      'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
                      selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                    )}>
                      {selected && <Check className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <strong className="truncate text-[13px]">{account.display_name || account.account_handle || account.platform_account_id || '未命名账号'}</strong>
                        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', PLATFORM_META[account.platform].className)}>{PLATFORM_META[account.platform].label}</span>
                      </span>
                      <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                        {[account.account_handle, account.platform_account_id, maskPhone(account.registered_phone)].filter(Boolean).join(' · ') || '没有补充资料'}
                      </span>
                      {account.notes && <span className="mt-1 block truncate text-[10px] text-muted-foreground">{account.notes}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-5">
          <p className="text-[10px] leading-4 text-muted-foreground">已选 {selectedAccountIds.length} 个；每个平台最多 1 个，0 个也是正常状态。</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={onSave} disabled={!writable || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              保存信息
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function DecisionMetric({ label, value, alert = false, suffix = '' }: { label: string; value: number; alert?: boolean; suffix?: string }) {
  return (
    <div className="min-w-[92px] px-3 py-2.5 text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-[18px] font-extrabold tabular-nums', alert && 'text-status-red')}>{value}</div>
      {suffix && <div className="text-[9px] text-muted-foreground">{suffix}</div>}
    </div>
  )
}

function TodayMetric({ icon: Icon, label, value, alert = false }: { icon: typeof Clock3; label: string; value: number; alert?: boolean }) {
  return (
    <div className="flex items-center gap-2 border-b border-r border-border px-4 py-3 last:border-r-0 sm:border-b-0">
      <Icon className={cn('h-4 w-4 text-muted-foreground', alert && 'text-status-red')} />
      <div>
        <div className="text-[10px] text-muted-foreground">今日{label}</div>
        <div className={cn('text-[17px] font-extrabold tabular-nums', alert && 'text-status-red')}>{value}</div>
      </div>
    </div>
  )
}

function CardMetric({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return (
    <div className="border-b border-r border-border/70 px-3 py-2.5 last:border-r-0 sm:border-b-0">
      <div className="text-[9px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-[16px] font-extrabold tabular-nums', alert && 'text-status-red')}>{value}</div>
    </div>
  )
}
