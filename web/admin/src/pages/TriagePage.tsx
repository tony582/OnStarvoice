import { useEffect, useState, useCallback } from 'react'
import {
  Inbox, Search, ChevronLeft, ChevronRight, MoreHorizontal, LinkIcon,
  CheckCircle, Eye, Archive, Ban, Loader2, Bookmark, Link2, CircleCheck,
  Package, X, Heart, MessageCircle, Star, Share2, ExternalLink, User,
  Clock, Tag, Globe, ScanSearch, FileText, Camera,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, formatFullDate, compact, LABELS, platformName, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { useAuth } from '@/lib/auth'

const STATUS_TABS = [
  { value: '', label: '待处理', icon: Inbox },
  { value: 'unhandled', label: '新线索', icon: Bookmark },
  { value: 'reviewing', label: '待复核', icon: ScanSearch },
  { value: 'issue_linked', label: '已转问题', icon: Link2 },
  { value: 'official_responded', label: '已响应', icon: CircleCheck },
  { value: 'archived', label: '已归档', icon: Package },
]

interface Pagination { page: number; totalPages: number; total: number }

export function TriagePage() {
  const { canWrite } = useAuth()
  const [status, setStatus] = useState('')
  const [sentiment, setSentiment] = useState('')
  const [keyword, setKeyword] = useState('')
  const [records, setRecords] = useState<any[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [drawerRecord, setDrawerRecord] = useState<any>(null)

  const load = useCallback(async (page = 1) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '30', status, queue: status ? '' : 'active', sentiment, keyword })
      const data = await api.get<any>('/triage/records?' + params)
      setRecords(data.records || [])
      setPagination(data.pagination || null)
    } catch (err) { console.error(err) }
    finally { setLoading(false) }
  }, [status, sentiment, keyword])

  useEffect(() => { load() }, [load])

  // Click outside to close dropdown
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.action-dropdown')) setOpenMenu(null)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  const updateTriage = async (recordId: string, newStatus: string) => {
    await api.patch('/triage/records/' + recordId, { status: newStatus })
    load(pagination?.page || 1)
    setOpenMenu(null)
  }

  const markResponded = async (recordId: string) => {
    await api.patch('/records/' + recordId + '/official-response', { status: 'responded' })
    load(pagination?.page || 1)
    setOpenMenu(null)
  }

  const linkIssue = async (recordId: string) => {
    const title = prompt('问题标题（简述负面舆情要点）：')
    if (!title) return
    await api.post('/triage/records/' + recordId + '/issues', { title })
    load(pagination?.page || 1)
  }

  const interactions = (r: any) => Number(r.likes || 0) + Number(r.comments_count || 0) + Number(r.collects || 0) + Number(r.shares || 0)

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-5 duration-300">
      {/* Status tabs */}
      <div className="flex flex-wrap gap-2 border-b border-border pb-4">
        {STATUS_TABS.map(tab => {
          const Icon = tab.icon
          return (
            <button key={tab.value} onClick={() => setStatus(tab.value)}
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-semibold transition-all duration-200',
                status === tab.value
                  ? 'border-primary bg-primary text-white shadow-sm shadow-primary/25'
                  : 'border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-primary'
              )}>
              <Icon className="h-3.5 w-3.5" strokeWidth={2} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3">
          <span className="text-xs font-semibold text-muted-foreground">情感</span>
          {['', 'negative', 'neutral', 'positive'].map(v => (
            <button key={v} onClick={() => setSentiment(v)}
              className={cn('rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
                sentiment === v ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}>
              {v === '' ? '全部' : v === 'negative' ? '负面' : v === 'neutral' ? '中性' : '正面'}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={keyword} onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && load()} placeholder="搜索标题、正文、关键词…" className="pl-9" />
        </div>
      </div>

      {/* Card list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : records.length === 0 ? (
        <EmptyState icon={Inbox} title="暂无记录" description="调整筛选条件试试" />
      ) : (
        <div className="space-y-3">
          {records.map(r => (
            <RecordCard
              key={r.id}
              record={r}
              canWrite={canWrite()}
              openMenu={openMenu}
              setOpenMenu={setOpenMenu}
              onLinkIssue={() => linkIssue(r.id)}
              onUpdateTriage={(s: string) => updateTriage(r.id, s)}
              onMarkResponded={() => markResponded(r.id)}
              onOpenDetail={() => setDrawerRecord(r)}
              interactions={interactions(r)}
            />
          ))}

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between rounded-xl border border-border bg-card px-5 py-3">
              <span className="text-xs text-muted-foreground">共 {formatNumber(pagination.total)} 条</span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-3 text-sm tabular-nums text-muted-foreground">{pagination.page} / {pagination.totalPages}</span>
                <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Record detail drawer */}
      {drawerRecord && (
        <RecordDrawer
          record={drawerRecord}
          onClose={() => setDrawerRecord(null)}
          canWrite={canWrite()}
          onLinkIssue={() => { linkIssue(drawerRecord.id); setDrawerRecord(null) }}
        />
      )}
    </div>
  )
}

/* ==================== Record Card ==================== */
function RecordCard({ record: r, canWrite, openMenu, setOpenMenu, onLinkIssue, onUpdateTriage, onMarkResponded, onOpenDetail, interactions }: any) {
  const cover = getCover(r)
  const sentimentColor = r.sentiment === 'negative' ? 'border-l-red-500' : r.sentiment === 'positive' ? 'border-l-emerald-500' : 'border-l-blue-400'

  return (
    <div className={cn('group relative overflow-hidden rounded-xl border border-border bg-card transition-all duration-200 hover:shadow-md border-l-[3px]', sentimentColor)}
      onClick={onOpenDetail} role="button" tabIndex={0}>
      <div className="flex gap-4 p-4">
        {/* Thumbnail */}
        {cover ? (
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
            <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          </div>
        ) : (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg border border-dashed border-border bg-muted/50">
            <FileText className="h-6 w-6 text-muted-foreground/40" />
          </div>
        )}

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Top row: badges */}
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge>
            <StatusBadge tone={r.sentiment || 'muted'}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge>
            {r.category && <StatusBadge tone="neutral">{LABELS.category[r.category] || r.category}</StatusBadge>}
            <StatusBadge tone={r.triage_status}>{LABELS.triage[r.triage_status] || r.triage_status}</StatusBadge>
          </div>

          {/* Title */}
          <h3 className="mb-1 truncate text-sm font-bold leading-snug">{r.title || '(无标题)'}</h3>

          {/* Summary */}
          <p className="mb-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{r.content || r.ai_summary || ''}</p>

          {/* Bottom row: author + stats + time */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><User className="h-3 w-3" />{r.author_name || '未知'}</span>
            <span className="flex items-center gap-1"><Heart className="h-3 w-3" />{formatNumber(r.likes)}</span>
            <span className="flex items-center gap-1"><MessageCircle className="h-3 w-3" />{formatNumber(r.comments_count)}</span>
            <span className="flex items-center gap-1"><Star className="h-3 w-3" />{formatNumber(r.collects)}</span>
            <span className="flex items-center gap-1"><Share2 className="h-3 w-3" />{formatNumber(r.shares)}</span>
            <span className="ml-auto flex items-center gap-1"><Clock className="h-3 w-3" />{formatDate(r.last_seen_at || r.created_at)}</span>
          </div>
        </div>

        {/* Actions */}
        {canWrite && (
          <div className="flex shrink-0 items-start gap-1" onClick={e => e.stopPropagation()}>
            <Button size="sm" onClick={onLinkIssue}><LinkIcon className="h-3.5 w-3.5" />转问题</Button>
            <div className="action-dropdown relative">
              <Button variant="outline" size="icon" className="h-8 w-8"
                onClick={() => setOpenMenu(openMenu === r.id ? null : r.id)}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
              {openMenu === r.id && (
                <div className="absolute right-0 top-full z-20 mt-1 w-44 animate-in fade-in slide-in-from-top-1 rounded-lg border border-border bg-card p-1 shadow-xl duration-150">
                  <MenuBtn icon={CheckCircle} label="标为已响应" onClick={onMarkResponded} />
                  <MenuBtn icon={Eye} label="待复核" onClick={() => onUpdateTriage('reviewing')} />
                  <MenuBtn icon={Archive} label="归档" onClick={() => onUpdateTriage('archived')} />
                  <MenuBtn icon={Ban} label="误报" onClick={() => onUpdateTriage('false_positive')} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Hover accent */}
      <div className="pointer-events-none absolute inset-0 rounded-xl border border-primary/0 transition-all duration-200 group-hover:border-primary/15" />
    </div>
  )
}

/* ==================== Record Detail Drawer ==================== */
function RecordDrawer({ record: r, onClose, canWrite, onLinkIssue }: { record: any; onClose: () => void; canWrite: boolean; onLinkIssue: () => void }) {
  const [tab, setTab] = useState<'content' | 'comments' | 'official' | 'snapshot'>('content')
  const [comments, setComments] = useState<any[]>([])
  const [officialResponses, setOfficialResponses] = useState<any[]>([])
  const [observations, setObservations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.get('/records/' + r.id + '/comments').catch(() => ({ comments: [], officialResponses: [] })),
      api.get('/records/' + r.id + '/observations').catch(() => ({ observations: [] })),
    ]).then(([cData, oData]: any[]) => {
      setComments(cData.comments || [])
      setOfficialResponses(cData.officialResponses || [])
      setObservations(oData.observations || [])
    }).finally(() => setLoading(false))
  }, [r.id])

  const images = getImages(r)
  const cover = images[0] || ''

  const TABS = [
    { id: 'content' as const, label: '帖子内容', icon: FileText },
    { id: 'comments' as const, label: `评论 (${comments.length})`, icon: MessageCircle },
    { id: 'official' as const, label: `官方响应 (${officialResponses.length})`, icon: CheckCircle },
    { id: 'snapshot' as const, label: '采集快照', icon: Camera },
  ]

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Drawer */}
      <div className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right duration-200"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-bold">舆情内容详情</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          {/* Hero */}
          <div className="border-b border-border p-6">
            <div className="flex gap-4">
              {cover ? (
                <div className="h-28 w-28 shrink-0 overflow-hidden rounded-xl border border-border bg-muted">
                  <img src={cover} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                </div>
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap gap-2">
                  <StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge>
                  <StatusBadge tone={r.sentiment || 'muted'}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge>
                  {r.category && <StatusBadge tone="neutral">{LABELS.category[r.category] || r.category}</StatusBadge>}
                  <StatusBadge tone={r.triage_status}>{LABELS.triage[r.triage_status] || r.triage_status}</StatusBadge>
                </div>
                <h3 className="text-base font-bold leading-snug">{r.title || '(无标题)'}</h3>

                {/* Author */}
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">
                    {(r.author_name || '?').slice(0, 1)}
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{r.author_name || '未知作者'}</div>
                    <div className="text-[11px] text-muted-foreground">{r.blogger_fans_count ? formatNumber(r.blogger_fans_count) + ' 粉丝' : ''}</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Stats grid */}
            <div className="mt-4 grid grid-cols-4 gap-2">
              <StatTile icon={Heart} label="点赞" value={r.likes} />
              <StatTile icon={MessageCircle} label="评论" value={r.comments_count} />
              <StatTile icon={Star} label="收藏" value={r.collects} />
              <StatTile icon={Share2} label="转发" value={r.shares} />
            </div>

            {/* Links */}
            <div className="mt-3 flex gap-3">
              {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" />打开原文</a>}
              {r.blogger_profile_url && <a href={r.blogger_profile_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><User className="h-3.5 w-3.5" />博主主页</a>}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border px-6">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={cn('flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-semibold transition-colors',
                  tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab panels */}
          <div className="p-6">
            {loading ? (
              <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <>
                {tab === 'content' && (
                  <div className="space-y-5">
                    <div>
                      <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">正文内容</h4>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{r.content || '无正文'}</p>
                    </div>
                    {r.ai_summary && (
                      <div>
                        <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">AI 摘要</h4>
                        <p className="text-sm leading-relaxed text-muted-foreground">{r.ai_summary}</p>
                      </div>
                    )}
                    {images.length > 1 && (
                      <div>
                        <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">图片</h4>
                        <div className="grid grid-cols-3 gap-2">
                          {images.map((url: string, i: number) => (
                            <div key={i} className="overflow-hidden rounded-lg border border-border bg-muted aspect-square">
                              <img src={url} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {tab === 'comments' && (
                  comments.length === 0 ? (
                    <EmptyState icon={MessageCircle} title="暂无评论数据" description="需要在插件采集时开启评论采集" />
                  ) : (
                    <div className="space-y-3">
                      {comments.map((c: any, i: number) => (
                        <div key={i} className={cn('rounded-lg border p-4', c.is_negative ? 'border-red-200 bg-red-50/50 dark:border-red-900/30 dark:bg-red-950/20' : 'border-border')}>
                          <div className="mb-1.5 flex items-center gap-2">
                            <span className="text-sm font-semibold">{c.author_name || '未知评论者'}</span>
                            <span className="text-xs text-muted-foreground">{formatDate(c.published_at || c.created_at)}</span>
                            {c.is_official && <StatusBadge tone="positive">官方回复</StatusBadge>}
                            <StatusBadge tone={c.is_negative ? 'negative' : (c.sentiment || 'muted')}>
                              {c.is_negative ? `负面 · ${c.risk_level || 'low'}` : (LABELS.sentiment[c.sentiment] || '中性')}
                            </StatusBadge>
                          </div>
                          <p className="text-sm">{c.content}</p>
                          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                            <span>{formatNumber(c.like_count)} 赞{c.ip_location ? ` · IP ${c.ip_location}` : ''}</span>
                            {canWrite && c.is_negative && (
                              <Button variant="outline" size="sm" onClick={() => {
                                const title = prompt('问题标题', '负面评论跟进')
                                if (!title) return
                                api.post('/comments/' + c.id + '/issues', { title }).then(onClose)
                              }}><LinkIcon className="h-3 w-3" />转问题</Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}

                {tab === 'official' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <InfoTile label="负面评论" value={`${formatNumber(r.negative_comment_count)} 条`} />
                      <InfoTile label="最近负评" value={formatDate(r.latest_negative_comment_at)} />
                      <InfoTile label="最后采集" value={formatDate(r.last_seen_at || r.created_at)} />
                      <InfoTile label="官方状态" value={r.official_response_status === 'responded' ? '已响应' : '未响应'} />
                    </div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">官方回复记录</h4>
                    {officialResponses.length === 0 ? (
                      <EmptyState icon={CheckCircle} title="暂无官方回复" />
                    ) : (
                      <div className="space-y-2">
                        {officialResponses.map((item: any, i: number) => (
                          <div key={i} className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-900/30 dark:bg-emerald-950/20">
                            <div className="mb-1.5 flex items-center gap-2">
                              <span className="text-sm font-semibold">{item.account_name || '官方账号'}</span>
                              <span className="text-xs text-muted-foreground">{formatDate(item.published_at || item.created_at)}</span>
                              <StatusBadge tone="positive">官方回复</StatusBadge>
                            </div>
                            <p className="text-sm">{item.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {tab === 'snapshot' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <InfoTile label="关键词" value={r.keyword || '-'} />
                      <InfoTile label="内容类型" value={r.note_type || '-'} />
                      <InfoTile label="发布时间" value={r.publish_time || '-'} />
                      <InfoTile label="首次发现" value={formatDate(r.first_seen_at)} />
                      <InfoTile label="最近采集" value={formatDate(r.last_seen_at || r.created_at)} />
                      <InfoTile label="采集次数" value={`${formatNumber(r.seen_count)} 次`} />
                    </div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">快照历史</h4>
                    {observations.length === 0 ? (
                      <EmptyState icon={Camera} title="暂无采集快照" />
                    ) : (
                      <div className="space-y-2">
                        {observations.slice(0, 10).map((o: any, i: number) => (
                          <div key={i} className="flex items-center justify-between rounded-lg border border-border p-3">
                            <div className="flex items-center gap-3 text-sm tabular-nums">
                              <span className="flex items-center gap-1"><Heart className="h-3 w-3 text-muted-foreground" />{formatNumber(o.likes)}</span>
                              <span className="flex items-center gap-1"><MessageCircle className="h-3 w-3 text-muted-foreground" />{formatNumber(o.comments_count)}</span>
                              <span className="flex items-center gap-1"><Star className="h-3 w-3 text-muted-foreground" />{formatNumber(o.collects)}</span>
                              <span className="flex items-center gap-1"><Share2 className="h-3 w-3 text-muted-foreground" />{formatNumber(o.shares)}</span>
                            </div>
                            <span className="text-xs text-muted-foreground">{formatFullDate(o.captured_at)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Footer actions */}
        {canWrite && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
            <Button variant="outline" onClick={onClose}>关闭</Button>
            <Button onClick={onLinkIssue}><LinkIcon className="h-4 w-4" />转为问题</Button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ==================== Helpers ==================== */
function StatTile({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: any }) {
  return (
    <div className="rounded-lg bg-muted/50 p-3 text-center">
      <Icon className="mx-auto mb-1 h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
      <div className="text-base font-bold tabular-nums">{formatNumber(value)}</div>
      <div className="text-[10px] font-semibold text-muted-foreground">{label}</div>
    </div>
  )
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold">{value || '-'}</div>
    </div>
  )
}

function MenuBtn({ icon: Icon, label, onClick }: { icon: React.ElementType; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
      <Icon className="h-4 w-4" />{label}
    </button>
  )
}

function getCover(r: any): string {
  if (r.cover_url) return r.cover_url
  try {
    const imgs = JSON.parse(r.image_urls || '[]')
    if (imgs.length) return typeof imgs[0] === 'string' ? imgs[0] : (imgs[0]?.url || '')
  } catch {}
  return ''
}

function getImages(r: any): string[] {
  const urls: string[] = []
  if (r.cover_url) urls.push(r.cover_url)
  try {
    const imgs = JSON.parse(r.image_urls || '[]')
    for (const img of imgs) {
      const url = typeof img === 'string' ? img : (img?.url || '')
      if (url && !urls.includes(url)) urls.push(url)
    }
  } catch {}
  return urls.filter(u => /^https?:\/\//i.test(u))
}
