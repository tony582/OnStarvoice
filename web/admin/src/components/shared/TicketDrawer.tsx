import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, Ban, Camera, CheckCircle, CheckCircle2, ClipboardCheck, ExternalLink,
  FileText, Heart, History, LinkIcon, Loader2, MessageCircle, RotateCcw, Share2,
  Star, StickyNote, User, UserCog, X, ZoomIn,
} from 'lucide-react'
import { api } from '@/lib/api'
import {
  cn, formatDate, formatFullDate, formatFullDateSec, formatNumber, identityLabel,
  LABELS, platformName, proxiedImg,
} from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { RecordImageGallery } from '@/components/shared/RecordImageGallery'
import { recordDisplayImageEntries } from '@/components/shared/record-images'

const PANEL_MIN = 480, PANEL_MAX = 900, PANEL_DEFAULT = 620

const STATE_TONE: Record<string, string> = { pending: 'orange', doing: 'blue', done: 'positive', dismissed: 'muted', closed: 'positive' }
const STATE_LABEL: Record<string, string> = { pending: '待处理', doing: '处理中', done: '已处理', dismissed: '已忽略', closed: '已结案' }

type TicketTab = 'content' | 'comments' | 'official' | 'snapshot' | 'history'
type TicketAction = () => Promise<unknown> | unknown

interface TicketNote {
  id: string
  event_type?: 'note' | 'closed' | 'reopened'
  body?: string
  author_name?: string
  created_at?: string
}

interface TicketSource {
  record: any
  comment: any
  comments: any[]
  officialResponses: any[]
  observations: any[]
  notes: TicketNote[]
}

interface TicketDrawerProps {
  ticket: any
  onClose: () => void
  canWrite: boolean
  onAction?: (action: string) => Promise<unknown> | unknown
  onReview?: (decision: 'confirm' | 'reopen') => Promise<unknown> | unknown
  onCloseTicket?: TicketAction
  onReopenTicket?: TicketAction
  onNoteAdded?: (note: any) => void
}

/**
 * 内容工单详情沿用「内容分诊详情」的信息骨架：内容摘要、互动数据、页签和底部动作保持一致，
 * 只把标签管理 / 处理模式替换为工单优先级、处理人、过程记录和结案动作。
 */
export function TicketDrawer(props: TicketDrawerProps) {
  return <TicketDrawerContent key={String(props.ticket?.id ?? '')} {...props} />
}

function TicketDrawerContent({
  ticket: t,
  onClose,
  canWrite,
  onAction,
  onReview,
  onCloseTicket,
  onReopenTicket,
  onNoteAdded,
}: TicketDrawerProps) {
  const [tab, setTab] = useState<TicketTab>('content')
  const [source, setSource] = useState<TicketSource | null>(null)
  const sourceVersion = `${String(t.id)}:${String(t.updated_at ?? '')}`
  const [loadedSourceVersion, setLoadedSourceVersion] = useState('')
  const loading = loadedSourceVersion !== sourceVersion
  const [noteText, setNoteText] = useState('')
  const [noteError, setNoteError] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [lightbox, setLightbox] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('osv_detail_width'))
    return saved >= PANEL_MIN && saved <= PANEL_MAX ? saved : PANEL_DEFAULT
  })

  useEffect(() => {
    let alive = true
    api.get<any>(`/tickets/${t.id}/source`)
      .then(data => {
        if (!alive) return
        setSource({
          record: data.record || null,
          comment: data.comment || null,
          comments: data.comments || data.negativeComments || [],
          officialResponses: data.officialResponses || [],
          observations: data.observations || [],
          notes: data.notes || [],
        })
        setLoadedSourceVersion(sourceVersion)
      })
      .catch(() => {
        if (!alive) return
        setSource({ record: null, comment: null, comments: [], officialResponses: [], observations: [], notes: [] })
        setLoadedSourceVersion(sourceVersion)
      })
    return () => { alive = false }
  }, [sourceVersion, t.id])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || savingNote || actionBusy) return
      if (lightbox) setLightbox('')
      else onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [actionBusy, lightbox, onClose, savingNote])

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (savingNote || actionBusy || lightbox) return
      const target = event.target
      if (!(target instanceof Node) || panelRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[role="dialog"], [data-radix-popper-content-wrapper], [data-ticket-detail-trigger]')) return
      onClose()
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [actionBusy, lightbox, onClose, savingNote])

  useEffect(() => {
    document.documentElement.style.setProperty('--detail-dock-width', window.innerWidth >= 1600 ? `${width}px` : '0px')
  }, [width])

  useEffect(() => () => { document.documentElement.style.setProperty('--detail-dock-width', '0px') }, [])

  useEffect(() => {
    const clamp = () => setWidth(current => {
      const next = Math.min(current, Math.max(PANEL_MIN, window.innerWidth - 340))
      document.documentElement.style.setProperty('--detail-dock-width', window.innerWidth >= 1600 ? `${next}px` : '0px')
      return next
    })
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = panelRef.current?.offsetWidth ?? width
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const move = (nextEvent: MouseEvent) => {
      const next = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startWidth + (startX - nextEvent.clientX)))
      if (panelRef.current) panelRef.current.style.width = `${next}px`
      document.documentElement.style.setProperty('--detail-dock-width', window.innerWidth >= 1600 ? `${next}px` : '0px')
    }
    const stop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      const next = panelRef.current?.offsetWidth ?? width
      setWidth(next)
      localStorage.setItem('osv_detail_width', String(next))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
  }

  const addNote = async () => {
    const body = noteText.trim()
    if (!body || savingNote || t.status === 'closed') return
    setSavingNote(true)
    setNoteError('')
    try {
      const result = await api.post<any>(`/tickets/${t.id}/notes`, { body })
      setSource(current => current ? { ...current, notes: [...current.notes, result.note] } : current)
      onNoteAdded?.(result.note)
      setNoteText('')
    } catch (error) {
      setNoteError(error instanceof Error ? error.message : '进展保存失败，请稍后重试')
    } finally {
      setSavingNote(false)
    }
  }

  const runAction = async (action?: TicketAction) => {
    if (!action || actionBusy) return
    setActionBusy(true)
    setActionError('')
    try {
      const result = await action()
      if (result !== false) setTab('history')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '操作失败，请稍后重试')
    } finally {
      setActionBusy(false)
    }
  }

  const openProgress = () => {
    setTab('history')
    window.setTimeout(() => noteRef.current?.focus(), 50)
  }

  const rec = source?.record
  const cmt = source?.comment
  const comments = source?.comments || []
  const officialResponses = source?.officialResponses || []
  const observations = source?.observations || []
  const notes = source?.notes || []
  const isComment = t.source_type === 'comment'
  const closed = t.status === 'closed'
  const postUrl = t.url || rec?.url || cmt?.record_url || ''
  const cover = recordCover(rec, t)
  const imageEntries = recordDisplayImageEntries(rec)
  const images = imageEntries.map(item => item.url)
  const resolvedIdentity = rec ? identityLabel(rec.source_type, rec.author_fans, rec.author_name, rec.identity_override) : ''
  const timeline = buildTimeline(t, notes)
  const tabs = [
    { id: 'content' as const, label: '内容', icon: FileText },
    { id: 'comments' as const, label: `评论 (${comments.length})`, icon: MessageCircle },
    { id: 'official' as const, label: `官方回复 (${officialResponses.length})`, icon: CheckCircle },
    { id: 'snapshot' as const, label: '采集', icon: Camera },
    { id: 'history' as const, label: `处理记录 (${timeline.length})`, icon: History },
  ]

  return (
    <div ref={panelRef} style={{ width }} role="dialog" aria-modal="true" aria-label="工单详情"
      className="detail-drawer fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-card shadow-[-8px_0_24px_-12px_rgba(17,24,39,0.12)] animate-in slide-in-from-right duration-200">
      <div onMouseDown={startResize} title="拖动调整宽度"
        className="group absolute left-0 top-0 z-30 hidden h-full w-2.5 -translate-x-1/2 cursor-col-resize justify-center lg:flex">
        <span className="h-full w-px bg-transparent transition-all group-hover:w-[3px] group-hover:bg-primary" />
      </div>

      <div className="relative z-10 flex h-full w-full flex-col">
        <div data-drawer-header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-border/60 bg-card px-2 pt-[env(safe-area-inset-top)] sm:gap-3 sm:px-5 lg:min-h-14">
          <button onClick={onClose} aria-label="返回工单列表" disabled={savingNote || actionBusy}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground transition active:bg-accent disabled:pointer-events-none disabled:opacity-40 lg:hidden">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h2 className="min-w-0 truncate text-[16px] font-bold">工单详情</h2>
          <StatusBadge tone={STATE_TONE[t.status] || 'muted'}>{STATE_LABEL[t.status] || t.status}</StatusBadge>
          <button onClick={onClose} aria-label="关闭工单详情" disabled={savingNote || actionBusy}
            className="ml-auto hidden rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent disabled:pointer-events-none disabled:opacity-40 lg:block">
            <X className="h-5 w-5" />
          </button>
        </div>

        {closed && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-emerald-500/[0.06] px-4 py-2 text-[12px] text-muted-foreground sm:px-5">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <span>该工单已结案，重开后可继续记录进展。</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto overscroll-contain">
          <section className="border-b border-border/60 bg-card p-4 sm:p-5">
            <div className="flex gap-4">
              {cover && (
                <button type="button" onClick={() => setLightbox(cover)} title="点击放大"
                  className="group relative h-[88px] w-[88px] shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted">
                  <img src={cover} alt="" className="h-full w-full object-cover transition group-hover:scale-105" referrerPolicy="no-referrer"
                    onError={event => { (event.target as HTMLImageElement).parentElement!.style.display = 'none' }} />
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/25 group-hover:opacity-100">
                    <ZoomIn className="h-4 w-4 text-white" />
                  </span>
                </button>
              )}

              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <StatusBadge tone="neutral">{platformName(t.platform || rec?.platform)}</StatusBadge>
                  {rec?.sentiment && <StatusBadge tone={rec.sentiment}>{LABELS.sentiment[rec.sentiment] || rec.sentiment}</StatusBadge>}
                  {rec?.category && <StatusBadge tone="neutral">{LABELS.category?.[rec.category] || rec.category}</StatusBadge>}
                  {resolvedIdentity && (
                    <span className={cn('rounded-md px-2 py-0.5 text-[11px] font-semibold', ['KOE', '4S店'].includes(resolvedIdentity) ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : 'bg-muted text-muted-foreground')}>
                      {resolvedIdentity}
                    </span>
                  )}
                </div>

                <h3 className="text-[17px] font-bold leading-snug text-foreground">
                  {rec?.title || t.title || String(rec?.content || t.item_text || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '(无标题)'}
                </h3>

                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
                      {(rec?.author_name || t.author || '?').slice(0, 1)}
                    </div>
                    <span className="text-[13px] font-semibold">{rec?.author_name || t.author || '未知作者'}</span>
                    <span className="text-[11px] text-muted-foreground">粉丝 {Number(rec?.author_fans) > 0 ? formatNumber(rec.author_fans) : '-'}</span>
                  </div>
                  {postUrl && <a href={postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" />原文</a>}
                  {rec?.blogger_profile_url && <a href={rec.blogger_profile_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"><User className="h-3.5 w-3.5" />主页</a>}
                  {(rec?.publish_display || rec?.publish_time) && <span className="text-[12px] text-muted-foreground">发布于 {rec.publish_display || rec.publish_time}</span>}
                </div>
              </div>
            </div>

            <div className="mt-4 border-t border-border/50 pt-3">
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px]">
                <span className="inline-flex items-center gap-1.5 font-semibold text-foreground"><ClipboardCheck className="h-3.5 w-3.5 text-primary" />工单信息</span>
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">优先级 <StatusBadge tone={t.priority}>{LABELS.priority[t.priority] || t.priority}</StatusBadge></span>
                <span className="inline-flex items-center gap-1.5 text-muted-foreground"><UserCog className="h-3.5 w-3.5" />处理人 <strong className="font-semibold text-foreground">{t.assignee_name || '本人跟进'}</strong></span>
                <span className="text-muted-foreground">转单人 <strong className="font-semibold text-foreground">{t.created_by_name || '-'}</strong></span>
                <span className="ml-auto tabular-nums text-muted-foreground">{formatFullDate(t.created_at)}</span>
              </div>
              {t.dispatch_note && (
                <div className="mt-2 border-l-2 border-amber-400 bg-amber-500/[0.05] px-3 py-2 text-[12px] leading-5">
                  <span className="mr-2 font-semibold text-foreground">转单说明</span>
                  <span className="text-muted-foreground">{t.dispatch_note}</span>
                </div>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 divide-x divide-border/50 border-y border-border/50 bg-muted/20 sm:grid-cols-4">
              <Metric icon={Heart} label="点赞" value={rec?.likes} />
              <Metric icon={MessageCircle} label="评论" value={rec?.comments_count} />
              <Metric icon={Star} label="收藏" value={rec?.collects} />
              <Metric icon={Share2} label="转发" value={rec?.shares} />
            </div>
          </section>

          <div className="mobile-table-scroll sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-border/70 bg-muted/30 px-2 py-2 backdrop-blur-sm sm:px-4">
            {tabs.map(item => (
              <button key={item.id} onClick={() => setTab(item.id)}
                className={cn(
                  'flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-semibold transition-colors sm:px-3',
                  tab === item.id ? 'bg-card text-primary shadow-sm ring-1 ring-border/50' : 'text-muted-foreground hover:bg-card/70 hover:text-foreground',
                )}>
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </button>
            ))}
          </div>

          <div className="min-h-[260px] bg-background/35 p-4 sm:p-5">
            {loading && !source ? (
              <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <>
                {tab === 'content' && (
                  <div className="space-y-5">
                    {isComment && (
                      <div>
                        <h4 className="mb-2 text-[13px] font-semibold text-foreground">评论内容</h4>
                        <p className="border-l-2 border-primary/40 pl-3 text-sm leading-relaxed">{cmt?.comment_content || t.item_text || '无评论内容'}</p>
                        <div className="mt-2 text-[11px] text-muted-foreground">{cmt?.comment_author_name || t.author || '未知评论者'}{cmt?.comment_ip_location ? ` · ${cmt.comment_ip_location}` : ''}{cmt?.comment_like_count ? ` · 赞 ${formatNumber(cmt.comment_like_count)}` : ''}</div>
                      </div>
                    )}
                    <div>
                      <h4 className="mb-2 text-[13px] font-semibold text-foreground">正文内容</h4>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{rec?.content || (!isComment ? t.item_text : '') || '无正文'}</p>
                    </div>
                    {rec?.ai_summary && (
                      <div>
                        <h4 className="mb-2 text-[13px] font-semibold text-foreground">AI 摘要</h4>
                        <p className="text-sm leading-relaxed text-muted-foreground">{rec.ai_summary}</p>
                      </div>
                    )}
                    <RecordImageGallery
                      key={`${rec?.id || t.id}-${imageEntries.map(item => `${item.url}::${item.ref}`).join('|')}`}
                      recordId={rec?.id ? String(rec.id) : undefined}
                      canRefresh={canWrite}
                      images={images}
                      imageRefs={imageEntries.map(item => item.ref)}
                      onOpen={setLightbox}
                    />
                  </div>
                )}

                {tab === 'comments' && (
                  comments.length === 0 ? (
                    <EmptyState icon={MessageCircle} title="暂无评论数据" description="需要在插件采集时开启评论采集" />
                  ) : (
                    <div className="space-y-3">
                      {comments.map((comment, index) => (
                        <div key={comment.id || index} className={cn('rounded-lg p-3.5', comment.is_negative ? 'bg-status-red/[0.05]' : 'bg-muted/50')}>
                          <div className="mb-1.5 flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-semibold">{comment.author_name || '未知评论者'}</span>
                            <span className="text-[11px] text-muted-foreground">{comment.publish_display || '—'}</span>
                            {comment.is_official && <StatusBadge tone="positive">官方回复</StatusBadge>}
                            <StatusBadge tone={comment.is_negative ? 'negative' : (comment.sentiment || 'muted')}>
                              {comment.is_negative ? `负面 · ${comment.risk_level || 'low'}` : (LABELS.sentiment[comment.sentiment] || '中性')}
                            </StatusBadge>
                          </div>
                          <p className="text-[13px] leading-5">{comment.content}</p>
                          {comment.ai_summary && <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{comment.ai_summary}</p>}
                          <div className="mt-2 text-[11px] text-muted-foreground">{formatNumber(comment.like_count)} 赞{comment.ip_location ? ` · IP ${comment.ip_location}` : ''}</div>
                        </div>
                      ))}
                    </div>
                  )
                )}

                {tab === 'official' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-x-5">
                      <InfoTile label="负面评论" value={`${formatNumber(rec?.negative_comment_count)} 条`} />
                      <InfoTile label="最近负评" value={formatDate(rec?.latest_negative_comment_at)} />
                      <InfoTile label="最后采集" value={formatDate(rec?.last_seen_at || rec?.created_at)} />
                      <InfoTile label="官方状态" value={rec?.official_response_status === 'responded' ? '已响应' : '未响应'} />
                    </div>
                    <h4 className="text-[13px] font-semibold text-foreground">官方回复记录</h4>
                    {officialResponses.length === 0 ? (
                      <EmptyState icon={CheckCircle} title="暂无官方回复" />
                    ) : (
                      <div className="space-y-2">
                        {officialResponses.map((item, index) => (
                          <div key={item.id || index} className="border-l-2 border-emerald-500 bg-emerald-500/[0.05] px-3 py-2.5">
                            <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                              <span className="font-semibold text-foreground">{item.account_name || '官方账号'}</span>
                              <span>{formatDate(item.published_at || item.created_at)}</span>
                            </div>
                            <p className="text-[13px] leading-5">{item.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {tab === 'snapshot' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-x-5">
                      <InfoTile label="关键词" value={rec?.keyword || '-'} />
                      <InfoTile label="内容类型" value={rec?.note_type || rec?.record_type || '-'} />
                      <InfoTile label="发布时间" value={rec?.publish_time || '-'} />
                      <InfoTile label="首次发现" value={formatFullDateSec(rec?.first_seen_at)} />
                      <InfoTile label="最近采集" value={formatFullDateSec(rec?.last_seen_at || rec?.created_at)} />
                      <InfoTile label="采集次数" value={`${formatNumber(rec?.seen_count)} 次`} />
                    </div>
                    <h4 className="text-[13px] font-semibold text-foreground">快照历史</h4>
                    {observations.length === 0 ? (
                      <EmptyState icon={Camera} title="暂无采集快照" />
                    ) : (
                      <div className="divide-y divide-border/50 border-y border-border/50">
                        {observations.map((item, index) => (
                          <div key={item.id || index} className="flex items-center justify-between gap-3 py-3">
                            <div className="flex flex-wrap items-center gap-3 text-[12px] tabular-nums">
                              <span className="flex items-center gap-1"><Heart className="h-3 w-3 text-muted-foreground" />{formatNumber(item.likes)}</span>
                              <span className="flex items-center gap-1"><MessageCircle className="h-3 w-3 text-muted-foreground" />{formatNumber(item.comments_count)}</span>
                              <span className="flex items-center gap-1"><Star className="h-3 w-3 text-muted-foreground" />{formatNumber(item.collects)}</span>
                              <span className="flex items-center gap-1"><Share2 className="h-3 w-3 text-muted-foreground" />{formatNumber(item.shares)}</span>
                            </div>
                            <span className="shrink-0 text-[11px] text-muted-foreground">{formatFullDateSec(item.captured_at)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {tab === 'history' && (
                  <div className="space-y-5">
                    {canWrite && !closed && (
                      <section className="border-b border-border/60 pb-5">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <h4 className="flex items-center gap-1.5 text-[13px] font-semibold"><StickyNote className="h-4 w-4 text-primary" />新增进展</h4>
                          <span className="text-[11px] tabular-nums text-muted-foreground">{noteText.length}/2000</span>
                        </div>
                        <textarea ref={noteRef} value={noteText} maxLength={2000} rows={3}
                          placeholder="记录沟通进展、处理结果或后续安排"
                          onChange={event => { setNoteText(event.target.value); if (noteError) setNoteError('') }}
                          onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void addNote() }}
                          className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 text-[13px] leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary focus:ring-2 focus:ring-ring/30" />
                        <div className="mt-2 flex items-center justify-end gap-3">
                          {noteError && <span className="mr-auto text-[12px] font-medium text-destructive">{noteError}</span>}
                          <Button size="sm" disabled={!noteText.trim() || savingNote} onClick={() => void addNote()}>
                            {savingNote ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <StickyNote className="h-3.5 w-3.5" />}
                            添加进展
                          </Button>
                        </div>
                      </section>
                    )}

                    <section>
                      <div className="mb-4 flex items-center justify-between gap-3">
                        <h4 className="text-[13px] font-semibold">处理时间线</h4>
                        <span className="text-[11px] text-muted-foreground">最新在前</span>
                      </div>
                      <TicketTimeline items={timeline} />
                    </section>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {canWrite && (onCloseTicket || onReopenTicket || onAction || onReview) && (
          <div className="border-t border-border bg-card px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] shadow-[0_-12px_28px_-24px_rgba(15,23,42,0.5)]">
            <div className="flex min-w-0 items-center gap-2">
              <div className="mr-auto min-w-0">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
                  {closed ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <ClipboardCheck className="h-4 w-4 text-primary" />}
                  {closed ? '工单已结案' : STATE_LABEL[t.status] || t.status}
                </div>
                <div className="truncate text-[10.5px] text-muted-foreground">{closed ? '重开后可继续处理' : `处理人：${t.assignee_name || '本人跟进'}`}</div>
              </div>

              {!closed && (onCloseTicket || onAction) && (
                <Button variant="outline" size="sm" className="h-9 shrink-0" disabled={actionBusy} onClick={openProgress}>
                  <StickyNote className="h-3.5 w-3.5" />记录进展
                </Button>
              )}
              {onCloseTicket && !closed && (
                <Button size="sm" className="h-9 shrink-0" disabled={actionBusy} onClick={() => void runAction(onCloseTicket)}>
                  {actionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}结案
                </Button>
              )}
              {onReopenTicket && closed && (
                <Button size="sm" className="h-9 shrink-0" disabled={actionBusy} onClick={() => void runAction(onReopenTicket)}>
                  {actionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}重开工单
                </Button>
              )}

              {onAction && (t.status === 'pending' || t.status === 'doing') && (
                <>
                  <Button variant="ghost" size="sm" className="h-9 shrink-0" disabled={actionBusy} onClick={() => void runAction(() => onAction('dismiss'))}><Ban className="h-3.5 w-3.5" />忽略</Button>
                  <Button size="sm" className="h-9 shrink-0" disabled={actionBusy} onClick={() => void runAction(() => onAction('done'))}><CheckCircle2 className="h-3.5 w-3.5" />处理完成</Button>
                </>
              )}
              {onReview && (
                <>
                  <Button variant="outline" size="sm" className="h-9 shrink-0" disabled={actionBusy} onClick={() => void runAction(() => onReview('reopen'))}>打回</Button>
                  <Button size="sm" className="h-9 shrink-0" disabled={actionBusy} onClick={() => void runAction(() => onReview('confirm'))}>确认归档</Button>
                </>
              )}
            </div>
            {actionError && <div className="mt-2 text-[12px] font-medium text-destructive">{actionError}</div>}
          </div>
        )}
      </div>

      {lightbox && (
        <div onClick={() => setLightbox('')} className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 sm:p-8 animate-in fade-in duration-150">
          <button type="button" onClick={() => setLightbox('')} title="关闭(Esc)" className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"><X className="h-5 w-5" /></button>
          <img src={lightbox} alt="" referrerPolicy="no-referrer" onClick={event => event.stopPropagation()} className="max-h-[90vh] max-w-[90vw] cursor-default rounded-lg object-contain shadow-2xl" />
        </div>
      )}
    </div>
  )
}

function Metric({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: unknown }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-1 text-[10.5px] font-medium text-muted-foreground"><Icon className="h-3 w-3" strokeWidth={2} />{label}</div>
      <div className="mt-0.5 text-[15px] font-bold tabular-nums">{formatNumber(Number(value || 0))}</div>
    </div>
  )
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-border/40 py-2">
      <div className="text-[10px] font-semibold text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold">{value || '-'}</div>
    </div>
  )
}

interface TimelineItem {
  id: string
  type: 'created' | 'note' | 'closed' | 'reopened' | 'done' | 'dismissed'
  title: string
  actor: string
  at?: string
  body?: string
}

function buildTimeline(ticket: any, notes: TicketNote[]): TimelineItem[] {
  const items: TimelineItem[] = notes.map(note => {
    const type = note.event_type || 'note'
    return {
      id: note.id,
      type,
      title: type === 'closed' ? '结案了工单' : type === 'reopened' ? '重开了工单' : '添加了处理进展',
      actor: note.author_name || '-',
      at: note.created_at,
      body: note.body || '',
    }
  })

  if (ticket.status === 'closed' && !notes.some(note => note.event_type === 'closed')) {
    items.push({
      id: `legacy-close-${ticket.id}`,
      type: 'closed',
      title: '结案了工单',
      actor: ticket.reviewed_by_name || ticket.handled_by_name || '-',
      at: ticket.reviewed_at || ticket.handled_at,
      body: ticket.handle_note || (ticket.handle_result === '已结案' ? '' : ticket.handle_result) || '',
    })
  }

  if (ticket.feedback_status === 'reopened' && ticket.status !== 'closed' && !notes.some(note => note.event_type === 'reopened')) {
    items.push({
      id: `legacy-reopen-${ticket.id}`,
      type: 'reopened',
      title: '重开了工单',
      actor: ticket.reviewed_by_name || ticket.handled_by_name || '-',
      at: ticket.updated_at,
      body: ticket.review_note || '',
    })
  }

  if ((ticket.status === 'done' || ticket.status === 'dismissed') && ticket.handled_at) {
    items.push({
      id: `handled-${ticket.id}`,
      type: ticket.status,
      title: ticket.status === 'dismissed' ? '忽略了工单' : '完成了处理',
      actor: ticket.handled_by_name || '-',
      at: ticket.handled_at,
      body: ticket.handle_note || ticket.handle_result || '',
    })
  }

  items.push({
    id: `created-${ticket.id}`,
    type: 'created',
    title: '创建并转出了工单',
    actor: ticket.created_by_name || '-',
    at: ticket.created_at,
    body: ticket.dispatch_note || '',
  })

  return items.sort((left, right) => timeValue(right.at) - timeValue(left.at))
}

function TicketTimeline({ items }: { items: TimelineItem[] }) {
  if (!items.length) return <EmptyState icon={History} title="暂无处理记录" />
  return (
    <div>
      {items.map(item => {
        const Icon = item.type === 'created' ? LinkIcon
          : item.type === 'closed' || item.type === 'done' ? CheckCircle2
            : item.type === 'reopened' ? RotateCcw
              : item.type === 'dismissed' ? Ban
                : StickyNote
        const emphasized = item.type === 'note' || item.type === 'reopened'
        return (
          <div key={item.id} className="relative border-l border-border pb-6 pl-6 last:pb-0">
            <span className={cn(
              'absolute -left-[9px] top-0 flex h-[18px] w-[18px] items-center justify-center rounded-full ring-4 ring-card',
              emphasized ? 'bg-primary text-primary-foreground' : item.type === 'closed' ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground',
            )}>
              <Icon className="h-3 w-3" />
            </span>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="text-[13px] font-semibold">
                <span>{item.actor}</span>
                <span className="ml-1 font-medium text-muted-foreground">{item.title}</span>
              </div>
              <div className="text-[11px] tabular-nums text-muted-foreground">{formatFullDateSec(item.at)}</div>
            </div>
            {item.body && <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground/85">{item.body}</p>}
          </div>
        )
      })}
    </div>
  )
}

function recordCover(record: any, ticket: any): string {
  return proxiedImg(record?.cover_local || record?.cover_url || ticket?.cover_url || '')
}

function timeValue(value?: string): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}
