import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ArrowUpRight, Clock, Loader2, Play, Radar, Target } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, formatDateCompact, platformName, formatNumber } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge, StatusDot } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchTableShell } from '@/components/shared/Workbench'
import { useAuth } from '@/lib/auth'
import { useNav } from '@/lib/navigation'

type CreatorSubscription = {
  id: string
  name?: string
  bloggerName?: string
  platform: string
  platformBloggerId?: string
  keyword?: string
  status?: string
  account_url?: string
  accountUrl?: string
  cadence_minutes?: number
  cadenceMinutes?: number
  last_run_at?: string
  lastRunAt?: string
  next_run_at?: string
  nextRunAt?: string
  last_error?: string
  lastError?: string
  has_official_role?: boolean
  hasOfficialRole?: boolean
}

type SubscriptionResponse = {
  subscriptions?: CreatorSubscription[]
}

function formatCadence(min: number) {
  if (!min) return '-'
  if (min >= 1440) return min === 1440 ? '每天' : `每 ${Math.round(min / 1440)} 天`
  if (min >= 60) return `每 ${Math.round(min / 60)} 小时`
  return `每 ${min} 分钟`
}

export function MonitorTasksTab({ onViewHits }: { onViewHits?: (subscriptionId: string) => void }) {
  const { canWrite } = useAuth()
  const { navigate } = useNav()
  const [subs, setSubs] = useState<CreatorSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [actionError, setActionError] = useState('')

  const load = useCallback(() => Promise.resolve().then(async () => {
    setLoading(true)
    setActionError('')
    try {
      const data = await api.get<SubscriptionResponse>('/monitor/subscriptions?subjectType=creator')
      setSubs(data.subscriptions || [])
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '读取关注博主失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }), [])

  useEffect(() => { void load() }, [load])

  const createScanTask = (id: string) => {
    navigate('dispatch', { create: 'creator_patrol', subscriptionId: id })
  }

  const followedCreatorSubs = subs.filter(s => s.hasOfficialRole !== true && s.has_official_role !== true)
  const active = followedCreatorSubs.filter(s => s.status === 'active').length
  const errored = followedCreatorSubs.filter(s => String(s.last_error || s.lastError || '').trim()).length

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      {/* 手机端是“值守概览”，桌面继续保留原统计条。 */}
      <section className="relative overflow-hidden rounded-[22px] border border-border/70 bg-card px-5 py-4 shadow-sm lg:hidden">
        <span className={`absolute inset-y-0 left-0 w-1 ${loading ? 'bg-primary' : errored > 0 ? 'bg-status-red' : 'bg-status-green'}`} />
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground">监控值守</div>
            <div className="mt-1.5 text-[22px] font-bold leading-tight text-foreground">
              {loading ? '正在读取监控状态' : errored > 0 ? `${errored} 个关注对象需处理` : '所有关注对象运行正常'}
            </div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{loading ? '正在同步最新运行结果' : '先处理异常，再检查最新命中'}</div>
          </div>
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${loading ? 'bg-primary/10 text-primary' : errored > 0 ? 'bg-status-red/12 text-status-red' : 'bg-status-green/12 text-status-green'}`}>
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : errored > 0 ? <AlertTriangle className="h-5 w-5" /> : <Radar className="h-5 w-5" />}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 divide-x divide-border/70 border-t border-border/60 pt-3">
          <MobileStat label="关注" value={loading ? '—' : formatNumber(followedCreatorSubs.length)} />
          <MobileStat label="已启用" value={loading ? '—' : formatNumber(active)} tone={loading ? undefined : 'text-status-green'} />
          <MobileStat label="异常" value={loading ? '—' : formatNumber(errored)} tone={!loading && errored > 0 ? 'text-status-red' : undefined} />
        </div>
      </section>

      <div className="hidden flex-wrap items-center justify-between gap-3 lg:flex">
        <div className="flex flex-wrap gap-3">
          <Stat label="关注博主" value={formatNumber(followedCreatorSubs.length)} icon={Radar} />
          <Stat label="已启用" value={formatNumber(active)} icon={Clock} tone="green" />
          <Stat label="异常" value={formatNumber(errored)} icon={AlertTriangle} tone={errored > 0 ? 'red' : 'default'} />
        </div>
        <span className="text-[12px] text-muted-foreground">在 Extension 的账号主页识别中选择“关注博主”；扫描任务统一交给调度中心</span>
      </div>

      <p className="px-1 text-xs leading-5 text-muted-foreground lg:hidden">关注对象由 Extension 账号主页识别添加；这里管理对象，执行任务统一进入调度中心。</p>

      {actionError && (
        <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-sm font-medium text-status-red">
          {actionError}
        </div>
      )}
      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : followedCreatorSubs.length === 0 ? (
        <EmptyState icon={Radar} title="暂无关注博主" description="打开博主主页，在 Extension 账号识别中选择“关注博主”；随后可在调度中心分配扫描任务。" />
      ) : (
        <>
          <div className="space-y-3 lg:hidden">
            {followedCreatorSubs.map(s => {
              const err = String(s.last_error || s.lastError || '').trim()
              const accountUrl = s.account_url || s.accountUrl
              return (
                <article key={s.id} className="relative overflow-hidden rounded-[20px] border border-border/70 bg-card shadow-sm">
                  <span className={`absolute inset-y-0 left-0 w-1 ${err ? 'bg-status-red' : s.status === 'active' ? 'bg-status-green' : 'bg-muted-foreground/40'}`} />
                  <div className="px-5 pb-4 pt-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge tone="neutral">{platformName(s.platform)}</StatusBadge>
                          {err
                            ? <StatusDot tone="negative">异常</StatusDot>
                            : s.status === 'active'
                              ? <StatusDot tone="active">已启用</StatusDot>
                              : <StatusDot tone="muted">{s.status === 'paused' ? '已暂停' : s.status}</StatusDot>}
                        </div>
                        <h3 className="mt-2.5 truncate text-[17px] font-bold leading-6 text-foreground">{s.name || s.bloggerName || '博主'}</h3>
                        <div className="mt-1 truncate text-xs text-muted-foreground">{s.platformBloggerId || s.keyword || '未记录账号 ID'}</div>
                      </div>
                      {accountUrl && (
                        <a
                          href={accountUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`打开${s.name || '博主'}主页`}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-primary transition-colors active:bg-muted"
                        >
                          <ArrowUpRight className="h-4 w-4" />
                        </a>
                      )}
                    </div>

                    {err && (
                      <div className="mt-3 rounded-xl bg-status-red/8 px-3.5 py-3 text-xs leading-5 text-status-red">
                        <div className="mb-0.5 font-semibold">最近一次扫描异常</div>
                        <div className="line-clamp-2">{err}</div>
                      </div>
                    )}

                    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-border/60 py-3">
                      <div>
                        <dt className="text-[10px] font-semibold tracking-wide text-muted-foreground">扫描频率</dt>
                        <dd className="mt-1 text-[13px] font-semibold text-foreground">{formatCadence(s.cadence_minutes ?? s.cadenceMinutes ?? 0)}</dd>
                      </div>
                      <div>
                        <dt className="text-[10px] font-semibold tracking-wide text-muted-foreground">最近运行</dt>
                        <dd className="mt-1 text-[13px] font-semibold text-foreground">{formatDate(s.last_run_at || s.lastRunAt) || '—'}</dd>
                      </div>
                      <div className="col-span-2 flex items-center justify-between gap-3">
                        <dt className="text-[10px] font-semibold tracking-wide text-muted-foreground">下次计划</dt>
                        <dd className="text-[12px] font-medium text-foreground">{formatDateCompact(s.next_run_at || s.nextRunAt) || '—'}</dd>
                      </div>
                    </dl>

                    <div className="mt-4 grid grid-cols-2 gap-2.5">
                      {onViewHits ? (
                        <Button variant="outline" size="sm" className="w-full" onClick={() => onViewHits(s.id)}>
                          <Target className="h-4 w-4" /> 查看命中
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        className="w-full"
                        onClick={() => createScanTask(s.id)}
                        disabled={!canWrite()}
                      >
                        <Play className="h-4 w-4" />
                        分配扫描任务
                      </Button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>

          <div className="hidden lg:block">
            <WorkbenchTableShell>
              <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="border-b border-border/60 [&>th]:px-3 [&>th]:py-2.5 [&>th]:text-[11px] [&>th]:font-medium [&>th]:uppercase [&>th]:tracking-wider [&>th]:whitespace-nowrap [&>th]:text-muted-foreground">
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">博主</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">平台</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">状态</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">频率</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">上次 / 下次</th>
              <th className="px-4 py-2.5 text-right text-[12px] font-medium text-muted-foreground">操作</th>
            </tr></thead>
            <tbody className="divide-y divide-border/40">
              {followedCreatorSubs.map(s => {
                const err = String(s.last_error || s.lastError || '').trim()
                return (
                  <tr key={s.id} className="align-top transition-colors hover:bg-accent/45">
                    <td className="px-4 py-3">
                      <div className="font-medium">{s.name || s.bloggerName || '博主'}</div>
                      {(s.account_url || s.accountUrl)
                        ? <a href={s.account_url || s.accountUrl} target="_blank" rel="noreferrer" className="mt-0.5 inline-block text-xs text-primary hover:underline">博主主页 ↗</a>
                        : <div className="mt-0.5 text-xs text-muted-foreground">{s.platformBloggerId || s.keyword || '-'}</div>}
                    </td>
                    <td className="px-4 py-3"><StatusBadge tone="neutral">{platformName(s.platform)}</StatusBadge></td>
                    <td className="px-4 py-3">
                      {err
                        ? <StatusDot tone="negative">异常</StatusDot>
                        : s.status === 'active'
                          ? <StatusDot tone="active">已启用</StatusDot>
                          : <StatusDot tone="muted">{s.status === 'paused' ? '已暂停' : s.status}</StatusDot>}
                      {err && <div className="mt-1 max-w-[180px] truncate text-[10.5px] text-status-red" title={err}>{err}</div>}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{formatCadence(s.cadence_minutes ?? s.cadenceMinutes ?? 0)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      <div>上次 {formatDate(s.last_run_at) || '—'}</div>
                      <div className="mt-0.5">下次 {formatDate(s.next_run_at) || '—'}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {onViewHits && (
                          <Button variant="ghost" size="sm" onClick={() => onViewHits(s.id)}>
                            <Target className="h-3.5 w-3.5" /> 命中
                          </Button>
                        )}
                        <Button variant="outline" size="sm" onClick={() => createScanTask(s.id)} disabled={!canWrite()}>
                          <Play className="h-3.5 w-3.5" /> 分配扫描
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
              </table>
            </WorkbenchTableShell>
          </div>
        </>
      )}
    </div>
  )
}

function MobileStat({ label, value, tone = 'text-foreground' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="px-3 first:pl-0 last:pr-0">
      <div className={`text-lg font-bold leading-none tabular-nums ${tone}`}>{value}</div>
      <div className="mt-1.5 text-[10px] font-medium text-muted-foreground">{label}</div>
    </div>
  )
}

const STAT_TONE = { default: 'text-foreground', green: 'text-status-green', red: 'text-status-red' }

function Stat({ label, value, icon: Icon, tone = 'default' }: { label: string; value: string; icon: React.ElementType; tone?: keyof typeof STAT_TONE }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 shadow-xs">
      <Icon className={`h-5 w-5 ${STAT_TONE[tone]}`} strokeWidth={1.8} />
      <div>
        <div className={`text-[20px] font-bold leading-none tabular-nums ${STAT_TONE[tone]}`}>{value}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}
