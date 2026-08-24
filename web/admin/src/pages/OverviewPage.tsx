import { useEffect, useState } from 'react'
import {
  Activity, AlertOctagon, Inbox, Loader2, ShieldAlert, ArrowRight,
  Radio, Heart, MessageCircle, MessageSquare, MoonStar, RefreshCw,
} from 'lucide-react'
import { api } from '@/lib/api'
import { compact, formatNumber, formatDate, platformName, cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { InfoHint } from '@/components/shared/InfoHint'
import { RecordDrawer } from '@/components/shared/RecordDrawer'
import { useNav } from '@/lib/navigation'
import { useBadges } from '@/lib/badges'
import { useAuth } from '@/lib/auth'

interface OverviewData {
  kpi: Record<string, number>
  features?: { commentRiskAttentionEnabled?: boolean }
  sentimentBreakdown: { negative: number; neutral: number; positive: number; unlabeled: number; total: number }
  platformRisk: Array<{ platform: string; total: number; negative: number }>
  pendingRecords: any[]
}

interface OpsControlSummary {
  kind: string
  mode: 'observe' | 'guarded'
  observeOnly: boolean
  llmUsed: boolean
  runtimeBaselineVersion: string
  policy: {
    enabled: boolean
    globalEnabled: boolean
    tenantEnabled: boolean
    actionsGlobalEnabled: boolean
    actionsEnabled: boolean
    actionAllowlist: string[]
    windowStart: string
    windowEnd: string
  }
  run?: {
    id: string
    service_date: string
    lifecycle_status: 'observing' | 'progressing' | 'recovering' | 'settled'
    verdict: 'pending' | 'healthy' | 'degraded' | 'blocked_manual' | 'incident'
    snapshot_count: number
    summary?: {
      headline?: string
      observedScheduleCount?: number
      expectedScheduleCount?: number
      taskCount?: number
      activeTaskCount?: number
      recoveredItemCount?: number
      manualBlockerCount?: number
      onlineAgentCount?: number
      registeredAgentCount?: number
      actions?: {
        total?: number
        pendingVerification?: number
        verified?: number
        failed?: number
        blocked?: number
      }
    }
    last_snapshot_at?: string
  } | null
  digest?: { summary?: string; delivery_status?: string } | null
  incidents?: Array<{
    id: string
    severity: string
    title: string
    message: string
    alert_delivery_status?: string
    alert_sent_at?: string
  }>
  actions?: Array<{ id: string; action_type: string; status: string; target_id: string }>
}

export function OverviewPage() {
  const { navigate } = useNav()
  const { badges } = useBadges()
  const { canWrite } = useAuth()
  const [data, setData] = useState<OverviewData | null>(null)
  const [ops, setOps] = useState<OpsControlSummary | null>(null)
  const [opsBusy, setOpsBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [drawer, setDrawer] = useState<any>(null)

  useEffect(() => {
    Promise.all([
      api.get<OverviewData>('/workspace/overview?days=7'),
      api.get<OpsControlSummary>('/ops-control/summary').catch(() => null),
    ]).then(([overview, opsSummary]) => {
      setData(overview)
      setOps(opsSummary)
    }).catch(console.error).finally(() => setLoading(false))
  }, [])

  const observeNow = async () => {
    setOpsBusy(true)
    try {
      await api.post('/ops-control/observe-now', {})
      setOps(await api.get<OpsControlSummary>('/ops-control/summary'))
    } catch (error) {
      console.error(error)
    } finally {
      setOpsBusy(false)
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }

  const k = data?.kpi || {}
  const sb = data?.sentimentBreakdown || { negative: 0, neutral: 0, positive: 0, unlabeled: 0, total: 0 }
  const labeledTotal = Number(sb.negative || 0) + Number(sb.neutral || 0) + Number(sb.positive || 0)
  const negRatio = labeledTotal ? Math.round((Number(sb.negative || 0) / labeledTotal) * 100) : 0
  const events = data?.pendingRecords || []
  const handled = Number(k.handled_total || 0)
  const activeTotal = Number(k.status_total ?? (Number(k.unhandled || 0) + handled))
  const handledPct = activeTotal ? Math.round((handled / activeTotal) * 100) : 0
  const commentRiskAttentionEnabled = data?.features?.commentRiskAttentionEnabled !== false

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      {/* 顶部状态条 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-green opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-status-green" /></span>
          实时值守中 · 近 7 日
        </span>
        <span className="text-[11px] font-medium text-muted-foreground">
          评论风险提醒 · {commentRiskAttentionEnabled ? '已开启' : '已关闭'}
        </span>
      </div>

      <OpsControlCard
        data={ops}
        busy={opsBusy}
        canObserve={canWrite()}
        onObserve={observeNow}
        onOpenDispatch={() => navigate('dispatch')}
      />

      {/* Numbers 行 */}
      <div className={cn('grid grid-cols-1 gap-3 min-[360px]:grid-cols-2', commentRiskAttentionEnabled ? 'lg:grid-cols-3 xl:grid-cols-5' : 'lg:grid-cols-4')}>
        <NumberCard label="互动总量" hint="互动总量=点赞+评论+收藏+转发 之和(全部内容累计),不是内容条数。「声量」才指内容条数,见分析与报告。本系统不采阅读/播放量,不报触达人数。" value={formatNumber(k.total_interaction)} sub={`周期新增内容 ${formatNumber(k.period_new)}`} icon={Radio} onClick={() => navigate('data')} />
        <NumberCard label="待处理" hint="待处理=进入内容分诊、尚未完成处理的内容。" value={formatNumber(badges.triagePending)} sub="待人工研判" tone="orange" icon={Inbox} onClick={() => navigate('workbench', { queue: 'triage' })} />
        <NumberCard label="内容负面" hint="内容负面=情感被 AI 标注为负面的内容总数;负面占比=负面 ÷ 已标注内容。评论风险单独统计，避免两种处置入口混在一起。" value={formatNumber(sb.negative)} sub={`负面占比 ${negRatio}%`} tone="red" icon={ShieldAlert} onClick={() => navigate('workbench', { queue: 'triage', sentiment: 'negative' })} />
        {commentRiskAttentionEnabled && (
          <NumberCard label="风险评论" hint="风险评论=评论分诊中尚未跟进的非销售评论；评论采集和 AI 标注不受此卡片影响。" value={formatNumber(badges.leadsNew)} sub={`近 7 日新增 ${formatNumber(k.period_comment_leads)}`} tone="orange" icon={MessageSquare} onClick={() => navigate('workbench', { queue: 'leads' })} />
        )}
        <NumberCard label="开放问题" hint="开放问题=未解决/未关闭的问题单(issue);高优=高/紧急级别。" value={formatNumber(k.open_issues)} sub={`高优 ${formatNumber(k.high_open_issues)}`} tone={Number(k.high_open_issues || 0) > 0 ? 'red' : 'default'} icon={AlertOctagon} onClick={() => navigate('workbench', { queue: 'issues' })} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        {/* 左:情感结构 + 分平台风险 */}
        <section className="rounded-xl border border-border bg-card p-4 shadow-xs sm:p-5">
          <h2 className="text-[13px] font-semibold tracking-tight">内容情感结构</h2>
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-muted">
            <div className="bg-status-red" style={{ width: pct(sb.negative, sb.total) }} />
            <div className="bg-status-grey" style={{ width: pct(sb.neutral, sb.total) }} />
            <div className="bg-status-green" style={{ width: pct(sb.positive, sb.total) }} />
          </div>
          <div className="mt-2.5 flex items-center justify-between text-[11px]">
            <span className="font-medium text-status-red">负面 {formatNumber(sb.negative)}</span>
            <span className="text-muted-foreground">中性 {formatNumber(sb.neutral)}</span>
            <span className="font-medium text-emerald-600 dark:text-emerald-400">正面 {formatNumber(sb.positive)}</span>
          </div>

          <h2 className="mt-5 text-[13px] font-semibold tracking-tight">内容分平台风险</h2>
          <div className="mt-3 space-y-2.5">
            {(data?.platformRisk || []).filter(p => p.platform).slice(0, 5).map(p => {
              const ratio = p.total ? p.negative / p.total : 0
              const color = ratio >= 0.2 ? 'bg-status-red' : ratio >= 0.08 ? 'bg-status-orange' : 'bg-status-green'
              return (
                <div key={p.platform} className="flex items-center gap-2.5 text-[11px]">
                  <span className="w-12 shrink-0 text-muted-foreground">{platformName(p.platform)}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', color)} style={{ width: `${Math.max(4, Math.round(ratio * 100))}%` }} /></div>
                  <span className={cn('w-7 shrink-0 text-right font-semibold tabular-nums', ratio >= 0.2 ? 'text-status-red' : 'text-muted-foreground')}>{formatNumber(p.negative)}</span>
                </div>
              )
            })}
          </div>
        </section>

        {/* 右:风险事件流 + 处置进度 */}
        <section className="rounded-xl border border-border bg-card p-4 shadow-xs sm:p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight">风险事件流</h2>
            <button onClick={() => navigate('workbench', { queue: 'triage' })} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary">全部处置 <ArrowRight className="h-3 w-3" /></button>
          </div>
          {events.length === 0 ? (
            <div className="py-8"><EmptyState icon={Activity} title="暂无待处置风险" description="所有舆情已处置完毕" /></div>
          ) : (
            <div className="mt-3 space-y-2">
              {events.slice(0, 6).map(r => {
                const tone = r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'
                const accent = r.sentiment === 'negative' ? 'border-l-status-red' : r.sentiment === 'positive' ? 'border-l-status-green' : 'border-l-status-blue'
                const interactions = Number(r.likes || 0) + Number(r.comments_count || 0) + Number(r.collects || 0) + Number(r.shares || 0)
                return (
                  <button key={r.id} data-record-detail-trigger onClick={() => setDrawer(r)}
                    className={cn('flex w-full items-center gap-3 rounded-r-lg border border-l-[3px] border-border bg-card px-3 py-2.5 text-left transition-all hover:shadow-xs hover:border-input', accent)}>
                    <StatusBadge tone={tone}>{tone === 'negative' ? '负面' : tone === 'positive' ? '正面' : '中性'}</StatusBadge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{r.title || compact(r.content || '', 40) || '(无标题)'}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-muted-foreground">
                        <span>{platformName(r.platform)}</span>
                        <span className="inline-flex items-center gap-0.5"><Heart className="h-2.5 w-2.5" />{formatNumber(r.likes)}</span>
                        <span className="inline-flex items-center gap-0.5"><MessageCircle className="h-2.5 w-2.5" />{formatNumber(r.comments_count)}</span>
                        {Number(r.alert_count) > 0 && <span className="font-medium text-status-red">预警 {r.alert_count}</span>}
                        <span className="ml-auto hidden sm:inline">{formatDate(r.last_seen_at)}</span>
                      </div>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-primary"><span className="hidden sm:inline">处置</span><ArrowRight className="h-3.5 w-3.5" /></span>
                  </button>
                )
              })}
            </div>
          )}

          {/* 状态处理进度 */}
          <div className="mt-4 border-t border-border pt-3.5">
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground"><span>状态处理进度（非待处理 / 当前相关内容）</span><span className="tabular-nums">{formatNumber(handled)} / {formatNumber(activeTotal)}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-status-green transition-all" style={{ width: `${handledPct}%` }} /></div>
          </div>
        </section>
      </div>

      {drawer && (
        <RecordDrawer record={drawer} onClose={() => setDrawer(null)} canWrite={canWrite()} />
      )}
    </div>
  )
}

const OPS_VERDICT = {
  pending: { label: '观察中', tone: 'neutral', accent: 'border-l-status-blue' },
  healthy: { label: '无需处理', tone: 'positive', accent: 'border-l-status-green' },
  degraded: { label: '部分异常', tone: 'medium', accent: 'border-l-status-orange' },
  blocked_manual: { label: '需要人工', tone: 'medium', accent: 'border-l-status-orange' },
  incident: { label: '系统异常', tone: 'negative', accent: 'border-l-status-red' },
} as const

function OpsControlCard({ data, busy, canObserve, onObserve, onOpenDispatch }: {
  data: OpsControlSummary | null
  busy: boolean
  canObserve: boolean
  onObserve: () => void
  onOpenDispatch: () => void
}) {
  const enabled = data?.policy?.enabled === true
  const run = data?.run || null
  const verdict = run?.verdict || 'pending'
  const style = OPS_VERDICT[verdict]
  const summary = run?.summary || {}
  const actionSummary = summary.actions || {}
  const guarded = data?.mode === 'guarded'
  const actionsEnabled = data?.policy?.actionsEnabled === true
  const disabledReason = data?.policy?.globalEnabled === false
    ? '服务端全局 kill switch 已关闭'
    : '本租户尚未开启值守观察'
  const headline = !data
    ? '值守控制面暂不可用'
    : !enabled
      ? '观察模式尚未启用'
      : run?.summary?.headline || data.digest?.summary || '等待首次连续观察'
  const attention = verdict === 'incident' || verdict === 'blocked_manual' || verdict === 'degraded'
    || Number(actionSummary.failed || 0) > 0 || Number(actionSummary.blocked || 0) > 0
  const firstIncident = data?.incidents?.[0]
  const alertLabel = firstIncident?.alert_delivery_status === 'sent'
    ? '异常提醒已发送'
    : ['retry_wait', 'blocked_config', 'failed'].includes(firstIncident?.alert_delivery_status || '')
      ? '异常提醒发送异常'
      : firstIncident ? '先自动恢复，必要时提醒' : ''

  return (
    <section data-ops-control-card className={cn('rounded-xl border border-l-[3px] border-border bg-card p-4 shadow-xs sm:p-5', enabled ? style.accent : 'border-l-border')}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <MoonStar className="h-4 w-4 text-primary" />
            <h2 className="text-[13px] font-semibold tracking-tight">昨夜值守</h2>
            <StatusBadge tone={enabled ? style.tone : 'neutral'}>{enabled ? style.label : '未开启'}</StatusBadge>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {guarded ? (actionsEnabled ? '受控动作' : '受控动作未放行') : '观察模式'}
            </span>
          </div>
          <p className="mt-2 text-sm font-semibold text-foreground">{headline}</p>
          {!enabled && <p className="mt-1 text-xs text-muted-foreground">{disabledReason}</p>}
          {enabled && run && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {run.service_date} · {Number(run.snapshot_count || 0)} 次快照
              {run.last_snapshot_at ? ` · 最近观察 ${formatDate(run.last_snapshot_at)}` : ''}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {enabled && canObserve && (
            <button type="button" onClick={onObserve} disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}立即复核
            </button>
          )}
          {attention && (
            <button type="button" onClick={onOpenDispatch}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground">
              查看调度 <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {enabled && run && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
          <OpsFact label="计划覆盖" value={`${Number(summary.observedScheduleCount || 0)}/${Number(summary.expectedScheduleCount || 0)}`} />
          <OpsFact label="任务" value={String(Number(summary.taskCount || 0))} />
          <OpsFact label="仍在执行" value={String(Number(summary.activeTaskCount || 0))} />
          <OpsFact label="已自动恢复" value={String(Number(summary.recoveredItemCount || 0))} />
          <OpsFact label="需人工" value={String(Number(summary.manualBlockerCount || 0))} danger={Number(summary.manualBlockerCount || 0) > 0} />
          <OpsFact label="在线 Agent" value={`${Number(summary.onlineAgentCount || 0)}/${Number(summary.registeredAgentCount || 0)}`} />
          <OpsFact
            label="动作 已验收/待验收"
            value={`${Number(actionSummary.verified || 0)}/${Number(actionSummary.pendingVerification || 0)}`}
            danger={Number(actionSummary.failed || 0) + Number(actionSummary.blocked || 0) > 0}
          />
        </div>
      )}

      {enabled && (data?.incidents || []).length > 0 && (
        <div className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">当前事项：</span>{firstIncident?.title}
          {(data?.incidents || []).length > 1 ? `，另有 ${(data?.incidents || []).length - 1} 项` : ''}
          {alertLabel ? <span className="ml-2 font-medium">· {alertLabel}</span> : null}
        </div>
      )}
      <p className="mt-3 text-[10.5px] leading-5 text-muted-foreground">
        {data?.runtimeBaselineVersion || '0.3.91'} 已交付自愈基线 · 未调用 LLM · {actionsEnabled
          ? '仅执行白名单动作，每次一个目标，并由后续快照验收'
          : guarded
            ? '动作总闸、租户模式或白名单尚未全部放行'
            : '当前只观察、判断和通知'}
      </p>
    </section>
  )
}

function OpsFact({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-lg bg-muted/45 px-3 py-2">
      <div className="text-[10px] font-medium text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-sm font-bold tabular-nums', danger ? 'text-status-red' : 'text-foreground')}>{value}</div>
    </div>
  )
}

function pct(n: number, total: number): string {
  if (!total) return '0%'
  return `${(n / total) * 100}%`
}

const NUM_TONE = {
  default: 'text-foreground',
  orange: 'text-status-orange',
  red: 'text-status-red',
}

function NumberCard({ label, value, sub, icon: Icon, tone = 'default', onClick, hint }: {
  label: string; value: string; sub?: string; icon: React.ElementType; tone?: keyof typeof NUM_TONE; onClick?: () => void; hint?: string
}) {
  return (
    <div onClick={onClick} role="button" tabIndex={0}
      className="group cursor-pointer rounded-xl border border-border bg-card px-3.5 py-3 text-left shadow-xs transition-all duration-150 hover:border-primary/30 hover:shadow-sm sm:px-4 sm:py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 truncate text-[12px] font-medium text-muted-foreground">{label}{hint && <InfoHint text={hint} />}</span>
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" strokeWidth={1.8} />
      </div>
      <div className={cn('mt-2 text-[22px] font-bold leading-none tabular-nums tracking-tight sm:text-[26px]', NUM_TONE[tone])}>{value}</div>
      {sub && <div className="mt-1.5 text-[10.5px] text-muted-foreground">{sub}</div>}
    </div>
  )
}
