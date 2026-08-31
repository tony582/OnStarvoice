import { useCallback, useEffect, useState } from 'react'
import {
  Bookmark, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Heart,
  Loader2, MessageCircle, Radar, RefreshCw, Share2, Target, UserRound,
} from 'lucide-react'
import { api } from '@/lib/api'
import { compact, formatDate, formatFullDate, formatNumber, LABELS, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchSelect, WorkbenchTableShell, WorkbenchTabs, WorkbenchToolbar } from '@/components/shared/Workbench'
import { RecordSourceAction } from '@/components/shared/RecordSourceAction'

const RANGE_OPTIONS = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: 'all', label: '全部' },
]

const PLATFORM_OPTIONS = [
  { value: '', label: '全部平台' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'weibo', label: '微博' },
]

function interaction(row: any) {
  return Number(row.likes || 0) + Number(row.comments_count || 0) + Number(row.collects || 0) + Number(row.shares || 0)
}

function sourceRecord(row: Record<string, unknown>) {
  return { ...row, id: row.record_id || row.id }
}

function hasSourceAction(row: Record<string, unknown>) {
  return String(row?.platform || '').trim().toLowerCase() === 'xiaohongshu' || Boolean(row?.url)
}

export function MonitorHitsTab({ initial }: { initial?: Record<string, string> }) {
  const [hits, setHits] = useState<any[]>([])
  const [subscriptions, setSubscriptions] = useState<any[]>([])
  const [pagination, setPagination] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [range, setRange] = useState(initial?.range ?? '7d')
  const [platform, setPlatform] = useState(initial?.platform ?? '')
  const [subscriptionId, setSubscriptionId] = useState(initial?.subscriptionId ?? '')
  const [expandedHitId, setExpandedHitId] = useState('')

  const loadSubscriptions = useCallback(() => Promise.resolve().then(async () => {
    try {
      const data = await api.get<any>('/monitor/subscriptions')
      setSubscriptions(data.subscriptions || data.data?.items || [])
    } catch {
      setSubscriptions([])
    }
  }), [])

  const load = useCallback((page = 1) => Promise.resolve().then(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '30', range })
      if (platform) params.set('platform', platform)
      if (subscriptionId) params.set('subscriptionId', subscriptionId)
      const data = await api.get<any>('/monitor/hits?' + params.toString())
      setHits(data.hits || [])
      setPagination(data.pagination || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '博主新动态加载失败')
    } finally {
      setLoading(false)
    }
  }), [range, platform, subscriptionId])

  useEffect(() => { void loadSubscriptions() }, [loadSubscriptions])
  useEffect(() => { void load(1) }, [load])
  useEffect(() => {
    if (!expandedHitId) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpandedHitId('')
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [expandedHitId])

  const expandedHit = hits.find(hit => String(hit.observation_id) === expandedHitId)

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-300">
      <WorkbenchTabs
        tabs={RANGE_OPTIONS.map(option => ({ key: option.value, label: option.label }))}
        activeKey={range}
        onChange={setRange}
      />

      {/* 手机端筛选是一个完整任务区，不沿用桌面工具栏的横向排布。 */}
      <section className="rounded-[20px] border border-border/70 bg-card p-4 shadow-sm lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground">命中时间线</div>
            <div className="mt-1 text-xl font-bold tabular-nums text-foreground">{loading ? '正在同步命中' : `${formatNumber(pagination?.total ?? hits.length)} 条新动态`}</div>
          </div>
          <Button variant="outline" size="icon" className="h-10 w-10" aria-label="刷新命中" onClick={() => load(pagination?.page || 1)} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2.5 border-t border-border/60 pt-3">
          <label className="min-w-0">
            <span className="mb-1 block px-1 text-[10px] font-semibold text-muted-foreground">内容平台</span>
            <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)} className="w-full border border-border bg-background">
              {PLATFORM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </WorkbenchSelect>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block px-1 text-[10px] font-semibold text-muted-foreground">关注对象</span>
            <WorkbenchSelect value={subscriptionId} onChange={e => setSubscriptionId(e.target.value)} className="w-full border border-border bg-background">
              <option value="">全部监控项</option>
              {subscriptions.map(sub => (
                <option key={sub.id} value={sub.id}>
                  {sub.name || sub.keyword || sub.platformBloggerId || sub.id}
                </option>
              ))}
            </WorkbenchSelect>
          </label>
        </div>
      </section>

      <div className="hidden lg:block">
        <WorkbenchToolbar meta={`${formatNumber(pagination?.total ?? hits.length)} 条新动态`}>
          <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)}>
            {PLATFORM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </WorkbenchSelect>
          <WorkbenchSelect value={subscriptionId} onChange={e => setSubscriptionId(e.target.value)} className="w-full lg:min-w-[180px] lg:w-auto">
            <option value="">全部监控项</option>
            {subscriptions.map(sub => (
              <option key={sub.id} value={sub.id}>
                {sub.name || sub.keyword || sub.platformBloggerId || sub.id}
              </option>
            ))}
          </WorkbenchSelect>
          <Button variant="outline" size="sm" onClick={() => load(pagination?.page || 1)} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </WorkbenchToolbar>
      </div>

      {error && <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-sm text-status-red">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : !hits.length ? (
        <EmptyState icon={Radar} title="暂无新动态" description="对关注的博主执行扫描后，抓到的新内容会出现在这里" />
      ) : (
        <>
          <ol className="space-y-0 lg:hidden">
            {hits.map((hit, index) => {
              const hitId = String(hit.observation_id)
              const expanded = expandedHitId === hitId
              const title = hit.title || compact(hit.content || '', 80) || '(无标题)'
              return (
                <li key={hit.observation_id} className="relative pl-6">
                  {index < hits.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[7px] top-6 w-px bg-border" />}
                  <span aria-hidden="true" className={`absolute left-0 top-5 h-[15px] w-[15px] rounded-full border-[3px] border-background ${hit.sentiment === 'negative' ? 'bg-status-red' : hit.is_new_record ? 'bg-status-green' : 'bg-primary'}`} />
                  <article className="mb-3 overflow-hidden rounded-[20px] border border-border/70 bg-card shadow-sm">
                    <div className="px-4 pb-4 pt-3.5">
                      <div className="flex items-center justify-between gap-3">
                        <time className="text-[11px] font-semibold tabular-nums text-muted-foreground">{formatDate(hit.captured_at)}</time>
                        {hit.is_new_record && <StatusBadge tone="active">新入库</StatusBadge>}
                      </div>

                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                        <StatusBadge tone="neutral">{platformName(hit.platform)}</StatusBadge>
                        <StatusBadge tone="muted">{LABELS.recordType[hit.record_type] || hit.record_type || '内容'}</StatusBadge>
                        <StatusBadge tone={hit.sentiment || 'muted'}>{LABELS.sentiment[hit.sentiment] || '待标注'}</StatusBadge>
                      </div>

                      <h3 className="mt-3 text-[16px] font-bold leading-6 text-foreground">{title}</h3>
                      {hit.content && <p className="mt-1.5 line-clamp-3 text-[13px] leading-5 text-muted-foreground">{hit.content}</p>}

                      <div className="mt-3 flex items-start gap-2 rounded-xl bg-muted/45 px-3 py-2.5">
                        <Target className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold text-foreground">{hit.monitor_name || hit.monitor_keyword || hit.observation_keyword || '未命名关注对象'}</div>
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">命中词：{hit.observation_keyword || hit.monitor_keyword || '-'}</div>
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-4 gap-1 rounded-xl border border-border/60 px-2 py-2.5">
                        <HitMetric icon={Heart} label="赞" value={hit.likes} />
                        <HitMetric icon={MessageCircle} label="评" value={hit.comments_count} />
                        <HitMetric icon={Bookmark} label="藏" value={hit.collects} />
                        <HitMetric icon={Share2} label="转" value={hit.shares} />
                      </div>

                      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <UserRound className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{hit.author_name || '未知作者'}</span>
                        </span>
                        <span className="shrink-0 tabular-nums">粉丝 {formatNumber(hit.author_fans)}</span>
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-2.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className={hasSourceAction(hit) ? 'w-full' : 'col-span-2 w-full'}
                          aria-expanded={expanded}
                          aria-controls={`monitor-hit-${hitId}`}
                          onClick={() => setExpandedHitId(expanded ? '' : hitId)}
                        >
                          详情
                          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                        </Button>
                        {hasSourceAction(hit) && (
                          <RecordSourceAction
                            record={sourceRecord(hit)}
                            className="h-10 touch-manipulation justify-center gap-2 rounded-lg bg-primary px-3.5 text-xs font-medium text-primary-foreground no-underline transition-colors hover:no-underline active:bg-primary/90"
                          />
                        )}
                      </div>
                    </div>

                  </article>
                </li>
              )
            })}
          </ol>

          {expandedHit && <MobileHitDetail hit={expandedHit} onClose={() => setExpandedHitId('')} />}

          <div className="hidden lg:block">
            <WorkbenchTableShell>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1020px] text-sm">
              <thead>
                <tr className="border-b border-border/60 [&>th]:px-3 [&>th]:py-2.5 [&>th]:text-[11px] [&>th]:font-medium [&>th]:uppercase [&>th]:tracking-wider [&>th]:whitespace-nowrap [&>th]:text-muted-foreground">
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">命中内容</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">监控项</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">作者</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">互动</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">状态</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">命中时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {hits.map(hit => (
                  <tr key={hit.observation_id} className="align-top transition-colors hover:bg-accent/45">
                    <td className="max-w-[410px] px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge tone="neutral">{platformName(hit.platform)}</StatusBadge>
                        <StatusBadge tone="muted">{LABELS.recordType[hit.record_type] || hit.record_type || '内容'}</StatusBadge>
                        {hasSourceAction(hit) && (
                          <RecordSourceAction record={sourceRecord(hit)} compact className="text-xs font-semibold" />
                        )}
                      </div>
                      <div className="mt-2 font-medium leading-5">{hit.title || compact(hit.content || '', 80) || '(无标题)'}</div>
                      {hit.content && <div className="mt-1 text-xs leading-5 text-muted-foreground">{compact(hit.content, 120)}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{hit.monitor_name || hit.monitor_keyword || hit.observation_keyword || '-'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">命中词 {hit.observation_keyword || hit.monitor_keyword || '-'}</div>
                      {hit.rank_position && <div className="mt-1 text-xs text-muted-foreground">排名 {hit.rank_position}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{hit.author_name || '-'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">粉丝 {formatNumber(hit.author_fans)}</div>
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      <div className="font-semibold">{formatNumber(interaction(hit))}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        赞 {formatNumber(hit.likes)} / 评 {formatNumber(hit.comments_count)} / 藏 {formatNumber(hit.collects)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {hit.is_new_record && <StatusBadge tone="active">新入库</StatusBadge>}
                        <StatusBadge tone={hit.sentiment || 'muted'}>{LABELS.sentiment[hit.sentiment] || '待标注'}</StatusBadge>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(hit.captured_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
              {pagination && pagination.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-border px-4 py-3">
                  <span className="text-xs text-muted-foreground">共 {formatNumber(pagination.total)} 条命中</span>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                    <span className="px-3 text-sm tabular-nums text-muted-foreground">{pagination.page} / {pagination.totalPages}</span>
                    <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)}><ChevronRight className="h-4 w-4" /></Button>
                  </div>
                </div>
              )}
            </WorkbenchTableShell>
          </div>

          {pagination && pagination.totalPages > 1 && (
            <nav aria-label="命中分页" className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-[18px] border border-border/70 bg-card p-2 shadow-sm lg:hidden">
              <Button variant="outline" size="sm" disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)}>
                <ChevronLeft className="h-4 w-4" /> 上一页
              </Button>
              <span className="px-1 text-xs font-semibold tabular-nums text-muted-foreground">{pagination.page} / {pagination.totalPages}</span>
              <Button variant="outline" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)}>
                下一页 <ChevronRight className="h-4 w-4" />
              </Button>
            </nav>
          )}
        </>
      )}
    </div>
  )
}

// Monitor hits are API-defined heterogeneous records shared with the desktop table.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MobileHitDetail({ hit, onClose }: { hit: any; onClose: () => void }) {
  const title = hit.title || compact(hit.content || '', 80) || '(无标题)'
  const hasFooterAction = Boolean(hasSourceAction(hit) || hit.monitor_account_url)

  return (
    <section
      id={`monitor-hit-${String(hit.observation_id)}`}
      role="dialog"
      aria-modal="true"
      aria-label="命中详情"
      className="fixed inset-0 z-[80] flex h-[100dvh] flex-col bg-background lg:hidden"
    >
      <header className="shrink-0 border-b border-border/70 bg-background px-3 pb-3 pt-[max(env(safe-area-inset-top),0.75rem)]">
        <div className="flex h-11 items-center gap-2">
          <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0" aria-label="返回命中时间线" onClick={onClose}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <div className="text-sm font-bold text-foreground">命中详情</div>
            <div className="truncate text-[11px] text-muted-foreground">{hit.monitor_name || hit.monitor_keyword || '关注对象'}</div>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone="neutral">{platformName(hit.platform)}</StatusBadge>
          <StatusBadge tone="muted">{LABELS.recordType[hit.record_type] || hit.record_type || '内容'}</StatusBadge>
          <StatusBadge tone={hit.sentiment || 'muted'}>{LABELS.sentiment[hit.sentiment] || '待标注'}</StatusBadge>
          {hit.is_new_record && <StatusBadge tone="active">新入库</StatusBadge>}
        </div>

        <h2 className="mt-4 text-[21px] font-bold leading-8 text-foreground">{title}</h2>

        <div className="mt-4 flex items-center justify-between gap-3 border-y border-border/60 py-3 text-xs text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <UserRound className="h-4 w-4 shrink-0" />
            <span className="truncate font-medium text-foreground">{hit.author_name || '未知作者'}</span>
          </span>
          <span className="shrink-0 tabular-nums">粉丝 {formatNumber(hit.author_fans)}</span>
        </div>

        <div className="mt-4 grid grid-cols-4 gap-1 rounded-2xl border border-border/70 bg-card px-2 py-3.5">
          <HitMetric icon={Heart} label="赞" value={hit.likes} />
          <HitMetric icon={MessageCircle} label="评" value={hit.comments_count} />
          <HitMetric icon={Bookmark} label="藏" value={hit.collects} />
          <HitMetric icon={Share2} label="转" value={hit.shares} />
        </div>

        <section className="mt-5 rounded-2xl bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-[0.12em] text-muted-foreground">
            <Target className="h-4 w-4 text-primary" /> 命中依据
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <HitDetail label="关注对象" value={hit.monitor_name || hit.monitor_keyword || '-'} wide />
            <HitDetail label="命中词" value={hit.observation_keyword || hit.monitor_keyword || '-'} />
            <HitDetail label="命中排名" value={hit.rank_position ? `第 ${hit.rank_position} 位` : '—'} />
            <HitDetail label="互动合计" value={formatNumber(interaction(hit))} />
            <HitDetail label="采集时间" value={formatFullDate(hit.captured_at)} wide />
          </dl>
        </section>

        {hit.content && (
          <section className="mt-5">
            <div className="text-[11px] font-bold tracking-[0.12em] text-muted-foreground">完整内容</div>
            <p className="mt-2.5 whitespace-pre-wrap break-words text-[14px] leading-7 text-foreground">{hit.content}</p>
          </section>
        )}
      </div>

      {hasFooterAction && (
        <footer className="grid shrink-0 grid-cols-2 gap-2.5 border-t border-border/70 bg-background px-4 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
          {hit.monitor_account_url ? (
            <a href={hit.monitor_account_url} target="_blank" rel="noreferrer" className={`inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-foreground ${hasSourceAction(hit) ? '' : 'col-span-2'}`}>
              关注对象主页 <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
          {hasSourceAction(hit) && (
            <RecordSourceAction
              record={sourceRecord(hit)}
              className={`h-11 justify-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground no-underline hover:no-underline ${hit.monitor_account_url ? '' : 'col-span-2'}`}
            />
          )}
        </footer>
      )}
    </section>
  )
}

function HitMetric({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value?: number | string | null }) {
  return (
    <div className="flex min-w-0 flex-col items-center text-center">
      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"><Icon className="h-3 w-3" />{label}</span>
      <strong className="mt-1 text-[12px] tabular-nums text-foreground">{formatNumber(value)}</strong>
    </div>
  )
}

function HitDetail({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <dt className="text-[10px] font-semibold text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-medium leading-5 text-foreground">{value}</dd>
    </div>
  )
}
