import { useEffect, useRef, useState } from 'react'
import { X, ExternalLink, FileText, Sparkles, MessageCircle, UserCog, Workflow } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, formatFullDate, formatNumber, LABELS, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'

const PANEL_MIN = 420, PANEL_MAX = 860, PANEL_DEFAULT = 580

const STATE_TONE: Record<string, string> = { pending: 'orange', doing: 'blue', done: 'positive', dismissed: 'muted', closed: 'muted' }
const STATE_LABEL: Record<string, string> = { pending: '待处理', doing: '处理中', done: '已处理', dismissed: '已忽略', closed: '已归档' }
const FEEDBACK_LABEL: Record<string, string> = { pending_review: '待分诊确认', confirmed: '分诊已确认', reopened: '被打回' }

/**
 * 工单详情抽屉(舆情处理 / 已转工单 共用)。右侧停靠、可拖宽。
 * 结构:顶部摘要条 → 工单内容 / 帖子 / AI 研判 / 负面评论 → 处理流程时间线 → 底部操作。
 * - 客服侧:传 onAction(action) —— start / done / dismiss / back
 * - 分诊侧:传 onReview(decision) —— confirm / reopen
 */
export function TicketDrawer({ ticket: t, onClose, canWrite, onAction, onReview }: {
  ticket: any
  onClose: () => void
  canWrite: boolean
  onAction?: (action: string) => void
  onReview?: (decision: 'confirm' | 'reopen') => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState<{ record: any; comment: any; negativeComments: any[] } | null>(null)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('osv_detail_width'))
    return saved >= PANEL_MIN && saved <= PANEL_MAX ? saved : PANEL_DEFAULT
  })

  useEffect(() => {
    let alive = true
    setSource(null)
    api.get<any>(`/tickets/${t.id}/source`)
      .then(d => { if (alive) setSource({ record: d.record, comment: d.comment, negativeComments: d.negativeComments || [] }) })
      .catch(() => { if (alive) setSource({ record: null, comment: null, negativeComments: [] }) })
    return () => { alive = false }
  }, [t.id])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  useEffect(() => { document.documentElement.style.setProperty('--detail-dock-width', width + 'px') }, [width])
  useEffect(() => () => { document.documentElement.style.setProperty('--detail-dock-width', '0px') }, [])
  useEffect(() => {
    const clamp = () => setWidth(w => Math.min(w, Math.max(PANEL_MIN, window.innerWidth - 340)))
    clamp(); window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelRef.current?.offsetWidth ?? width
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize'
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + (startX - ev.clientX)))
      if (panelRef.current) panelRef.current.style.width = w + 'px'
      document.documentElement.style.setProperty('--detail-dock-width', w + 'px')
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''; document.body.style.cursor = ''
      const w = panelRef.current?.offsetWidth ?? width
      setWidth(w); localStorage.setItem('osv_detail_width', String(w))
    }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }

  const isComment = t.source_type === 'comment'
  const rec = source?.record
  const cmt = source?.comment
  const kw: string[] = Array.isArray(cmt?.matched_keywords)
    ? cmt.matched_keywords
    : (() => { try { return JSON.parse(cmt?.matched_keywords || '[]') } catch { return [] } })()
  const hasAI = Boolean(rec?.ai_summary || cmt?.reason || kw.length > 0)

  // 处理流程三步状态
  const procState = t.status === 'pending' ? 'pending' : t.status === 'doing' ? 'active' : 'done'
  const reviewState = (t.feedback_status === 'confirmed' || t.feedback_status === 'reopened') ? 'done'
    : t.feedback_status === 'pending_review' ? 'active' : 'pending'

  return (
    <div ref={panelRef} style={{ width }}
      className="fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-card shadow-[-8px_0_24px_-12px_rgba(17,24,39,0.12)] animate-in slide-in-from-right duration-200">
      <div onMouseDown={startResize} title="拖动调整宽度"
        className="group absolute left-0 top-0 z-30 flex h-full w-2.5 -translate-x-1/2 cursor-col-resize justify-center">
        <span className="h-full w-px bg-transparent transition-all group-hover:w-[3px] group-hover:bg-primary" />
      </div>
      <div className="relative z-10 flex h-full w-full flex-col">
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-border/60 px-6 py-4">
          <h2 className="text-base font-bold">工单详情</h2>
          <StatusBadge tone={STATE_TONE[t.status] || 'muted'}>{STATE_LABEL[t.status] || t.status}</StatusBadge>
          <button onClick={onClose} className="ml-auto rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        {/* 摘要条 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border/60 bg-muted/30 px-6 py-2.5">
          <StatusBadge tone={isComment ? 'neutral' : 'active'}>{isComment ? '评论' : '内容'}</StatusBadge>
          <StatusBadge tone="neutral">{platformName(t.platform)}</StatusBadge>
          <StatusBadge tone={t.priority}>{LABELS.priority[t.priority] || t.priority}</StatusBadge>
          <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground"><UserCog className="h-3.5 w-3.5" />{t.assignee_name || '公共池'}</span>
          {t.url && <a href={t.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" />原文</a>}
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* 工单内容(评论工单=评论;内容工单=帖子正文优先用拉到的全文)*/}
          <Section icon={FileText} title={isComment ? '评论内容' : '帖子正文'}>
            <Quote>{(!isComment && rec?.content) ? rec.content : (t.item_text || t.title || '(无内容)')}</Quote>
            {!isComment && rec && (
              <StatRow rec={rec} />
            )}
            {t.author && <div className="mt-1.5 text-[12px] text-muted-foreground">作者:{t.author}</div>}
          </Section>

          {/* 评论所在帖子(仅评论工单)*/}
          {isComment && rec && (
            <Section icon={FileText} title="评论所在帖子">
              <div className="rounded-lg border border-border p-3.5">
                {rec.title && <div className="text-[13px] font-medium leading-snug">{rec.title}</div>}
                <div className="mt-1.5 max-h-36 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-6 text-muted-foreground">{rec.content || '(无正文)'}</div>
                <StatRow rec={rec} className="mt-2" />
              </div>
            </Section>
          )}

          {/* AI 研判(帖子 + 评论 合并)*/}
          {hasAI && (
            <Section icon={Sparkles} title="AI 研判">
              <div className="space-y-2.5 rounded-lg bg-primary/[0.04] p-3.5">
                {rec?.ai_summary && (
                  <div className="text-[12.5px] leading-6">
                    <span className="font-semibold text-foreground">帖子:</span>
                    <span className="text-muted-foreground"> {rec.ai_summary}</span>
                  </div>
                )}
                {(cmt?.reason || kw.length > 0) && (
                  <div className="text-[12.5px] leading-6">
                    <span className="font-semibold text-foreground">评论:</span>
                    {cmt?.reason && <span className="text-muted-foreground"> {cmt.reason}</span>}
                    {kw.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{kw.slice(0, 12).map((k) => <StatusBadge key={k} tone="muted">{k}</StatusBadge>)}</div>}
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* 负面评论(内容工单)*/}
          {!isComment && source && source.negativeComments.length > 0 && (
            <Section icon={MessageCircle} title={`负面评论 (${source.negativeComments.length})`}>
              <div className="space-y-2">
                {source.negativeComments.map((c, i) => (
                  <div key={i} className="rounded-lg bg-status-red/[0.05] p-3 text-[12px] leading-5">
                    <div className="whitespace-pre-wrap text-foreground">{c.content}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">{c.author_name || '匿名'}{c.ip_location ? ` · ${c.ip_location}` : ''}{c.like_count ? ` · 赞 ${formatNumber(c.like_count)}` : ''}</div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* 处理流程(时间线)*/}
          <Section icon={Workflow} title="处理流程">
            <div className="relative space-y-3.5 pl-5">
              <span className="absolute bottom-1.5 left-[4px] top-1.5 w-px bg-border" />
              <Step state="done" label="转单" meta={`${t.created_by_name || '-'} · ${formatDate(t.created_at)} · 指派 ${t.assignee_name || '公共池'}`} note={t.dispatch_note} noteTone="amber" />
              <Step
                state={procState}
                label={`客服处理${t.status === 'doing' ? '(进行中)' : t.status === 'pending' ? '(待领取)' : ''}`}
                meta={t.handled_at ? `${t.handled_by_name || '-'} · ${formatFullDate(t.handled_at)}${t.status === 'dismissed' ? ' · 已忽略' : ''}` : (t.status === 'pending' ? '等待客服领取' : '')}
                note={t.handle_note}
                noteTone="muted"
              />
              <Step
                state={reviewState}
                label={`分诊回执${t.feedback_status === 'pending_review' ? '(待确认)' : ''}`}
                meta={t.reviewed_at ? `${t.reviewed_by_name || '-'} · ${formatFullDate(t.reviewed_at)} · ${FEEDBACK_LABEL[t.feedback_status] || ''}` : (t.feedback_status === 'pending_review' ? '等待分诊确认' : '尚未处理完')}
                note={t.review_note}
                noteTone={t.feedback_status === 'reopened' ? 'rose' : 'muted'}
              />
            </div>
          </Section>
        </div>

        {/* Footer 操作 */}
        {canWrite && (onAction || onReview) && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 px-6 py-3.5">
            {onAction && t.status === 'pending' && <>
              <Button variant="outline" size="sm" onClick={() => onAction('start')}>开始处理</Button>
              <Button size="sm" onClick={() => onAction('done')}>处理完成</Button>
              <Button variant="ghost" size="sm" onClick={() => onAction('dismiss')}>忽略</Button>
            </>}
            {onAction && t.status === 'doing' && <>
              <Button size="sm" onClick={() => onAction('done')}>处理完成</Button>
              <Button variant="ghost" size="sm" onClick={() => onAction('back')}>退回</Button>
            </>}
            {onAction && (t.status === 'done' || t.status === 'dismissed') &&
              <span className="text-[12px] text-muted-foreground">{t.feedback_status === 'pending_review' ? '已提交,待分诊确认' : '已完成'}</span>}
            {onReview && <>
              <Button size="sm" onClick={() => onReview('confirm')}>确认归档</Button>
              <Button variant="ghost" size="sm" onClick={() => onReview('reopen')}>打回</Button>
            </>}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />{title}
      </div>
      {children}
    </section>
  )
}

function Quote({ children }: { children: React.ReactNode }) {
  return <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3.5 text-[13px] leading-6">{children}</div>
}

function StatRow({ rec, className = '' }: { rec: any; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground ${className}`}>
      <StatusBadge tone={rec.sentiment === 'negative' ? 'negative' : rec.sentiment === 'positive' ? 'positive' : 'muted'}>{LABELS.sentiment[rec.sentiment] || '待标注'}</StatusBadge>
      {rec.category && <StatusBadge tone="neutral">{LABELS.category?.[rec.category] || rec.category}</StatusBadge>}
      <span>赞 {formatNumber(rec.likes)} · 评 {formatNumber(rec.comments_count)}{rec.negative_comment_count > 0 ? ` · 负评 ${rec.negative_comment_count}` : ''}</span>
    </div>
  )
}

function Step({ state, label, meta, note, noteTone }: {
  state: 'done' | 'active' | 'pending'
  label: string
  meta?: string
  note?: string
  noteTone?: 'amber' | 'muted' | 'rose'
}) {
  const dot = state === 'done' ? 'bg-primary' : state === 'active' ? 'bg-amber-500' : 'bg-muted-foreground/30'
  const noteCls = noteTone === 'amber'
    ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
    : noteTone === 'rose'
      ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300'
      : 'bg-muted/50 text-muted-foreground'
  return (
    <div className="relative">
      <span className={`absolute -left-[18px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-card ${dot}`} />
      <div className={`text-[12.5px] font-semibold ${state === 'pending' ? 'text-muted-foreground' : 'text-foreground'}`}>{label}</div>
      {meta && <div className="mt-0.5 text-[11px] text-muted-foreground">{meta}</div>}
      {note && <div className={`mt-1.5 rounded-md px-2.5 py-1.5 text-[12px] leading-5 ${noteCls}`}>{note}</div>}
    </div>
  )
}
