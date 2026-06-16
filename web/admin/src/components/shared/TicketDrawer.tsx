import { useEffect, useRef, useState } from 'react'
import { X, ExternalLink, FileText, Send, UserCog, Wrench, ClipboardCheck, Sparkles, MessageCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, formatFullDate, formatNumber, LABELS, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'

const PANEL_MIN = 420, PANEL_MAX = 860, PANEL_DEFAULT = 560

const STATE_TONE: Record<string, string> = { pending: 'orange', doing: 'blue', done: 'positive', dismissed: 'muted', closed: 'muted' }
const STATE_LABEL: Record<string, string> = { pending: '待处理', doing: '处理中', done: '已处理', dismissed: '已忽略', closed: '已归档' }
const FEEDBACK_LABEL: Record<string, string> = { pending_review: '待分诊确认', confirmed: '分诊已确认', reopened: '被打回' }

/**
 * 工单详情抽屉(舆情处理 / 工单回执 共用)。右侧停靠、可拖宽,与评论分诊抽屉风格一致。
 * 展示:工单原文 + 转单信息 + 处理过程 + 回执。
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

  const kw: string[] = Array.isArray(source?.comment?.matched_keywords)
    ? source!.comment.matched_keywords
    : (() => { try { return JSON.parse(source?.comment?.matched_keywords || '[]') } catch { return [] } })()

  return (
    <div ref={panelRef} style={{ width }}
      className="fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-card shadow-[-8px_0_24px_-12px_rgba(17,24,39,0.12)] animate-in slide-in-from-right duration-200">
      <div onMouseDown={startResize} title="拖动调整宽度"
        className="group absolute left-0 top-0 z-30 flex h-full w-2.5 -translate-x-1/2 cursor-col-resize justify-center">
        <span className="h-full w-px bg-transparent transition-all group-hover:w-[3px] group-hover:bg-primary" />
      </div>
      <div className="relative z-10 flex h-full w-full flex-col">
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-border/50 px-6 py-4">
          <h2 className="text-base font-bold">工单详情</h2>
          <StatusBadge tone={STATE_TONE[t.status] || 'muted'}>{STATE_LABEL[t.status] || t.status}</StatusBadge>
          {t.feedback_status && t.feedback_status !== 'none' && (
            <span className="text-[11px] text-muted-foreground">{FEEDBACK_LABEL[t.feedback_status] || ''}</span>
          )}
          <button onClick={onClose} className="ml-auto rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          {/* 工单原文(主角)*/}
          <section>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground"><FileText className="h-3.5 w-3.5" />工单原文 · {t.source_type === 'comment' ? '评论' : '内容'}</div>
            <div className="rounded-lg border border-border bg-muted/30 p-3.5 text-[13px] leading-6 whitespace-pre-wrap">{t.item_text || t.title || '(无内容)'}</div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <StatusBadge tone="neutral">{platformName(t.platform)}</StatusBadge>
              {t.category && <StatusBadge tone="neutral">{LABELS.leadType[t.category] || t.category}</StatusBadge>}
              <StatusBadge tone={t.priority}>{LABELS.priority[t.priority] || t.priority}</StatusBadge>
              {t.url && <a href={t.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" />查看原文</a>}
            </div>
            {t.author && <div className="mt-2 text-[12px] text-muted-foreground">作者:{t.author}</div>}
          </section>

          {/* 原始博文(评论工单=评论所在帖子;内容工单=帖子正文)*/}
          {source?.record && (
            <section>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground"><FileText className="h-3.5 w-3.5" />{t.source_type === 'comment' ? '评论所在帖子' : '帖子正文'}</div>
              <div className="rounded-lg border border-border p-3.5">
                {source.record.title && <div className="text-[13px] font-medium leading-snug">{source.record.title}</div>}
                <div className="mt-1.5 max-h-44 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-6 text-muted-foreground">{source.record.content || '(无正文)'}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <StatusBadge tone={source.record.sentiment === 'negative' ? 'negative' : source.record.sentiment === 'positive' ? 'positive' : 'muted'}>{LABELS.sentiment[source.record.sentiment] || '待标注'}</StatusBadge>
                  {source.record.category && <StatusBadge tone="neutral">{LABELS.category?.[source.record.category] || source.record.category}</StatusBadge>}
                  <span>赞 {formatNumber(source.record.likes)} · 评 {formatNumber(source.record.comments_count)}{source.record.negative_comment_count > 0 ? ` · 负评 ${source.record.negative_comment_count}` : ''}</span>
                </div>
              </div>
            </section>
          )}

          {/* AI 研判(帖子)*/}
          {source?.record?.ai_summary && (
            <section>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground"><Sparkles className="h-3.5 w-3.5" />AI 研判</div>
              <div className="rounded-lg bg-primary/[0.04] p-3.5 text-[12.5px] leading-6 text-muted-foreground">{source.record.ai_summary}</div>
            </section>
          )}

          {/* 评论 AI 判断(评论工单)*/}
          {source?.comment && (source.comment.reason || kw.length > 0) && (
            <section>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground"><Sparkles className="h-3.5 w-3.5" />评论 AI 判断</div>
              <div className="rounded-lg bg-primary/[0.04] p-3.5 text-[12.5px] leading-6">
                {source.comment.reason && <div className="text-muted-foreground">{source.comment.reason}</div>}
                {kw.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{kw.slice(0, 12).map((k: string) => <StatusBadge key={k} tone="muted">{k}</StatusBadge>)}</div>}
              </div>
            </section>
          )}

          {/* 负面评论(内容工单)*/}
          {source && t.source_type === 'content' && source.negativeComments.length > 0 && (
            <section>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground"><MessageCircle className="h-3.5 w-3.5" />负面评论 ({source.negativeComments.length})</div>
              <div className="space-y-2">
                {source.negativeComments.map((c: any, i: number) => (
                  <div key={i} className="rounded-lg bg-status-red/[0.05] p-3 text-[12px] leading-5">
                    <div className="whitespace-pre-wrap">{c.content}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">{c.author_name || '匿名'}{c.ip_location ? ` · ${c.ip_location}` : ''}{c.like_count ? ` · 赞 ${formatNumber(c.like_count)}` : ''}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 转单信息 */}
          <section>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground"><Send className="h-3.5 w-3.5" />转单信息</div>
            <div className="space-y-2 rounded-lg border border-border p-3.5 text-[12px] leading-6">
              <div className="flex items-center gap-2 text-muted-foreground"><UserCog className="h-3.5 w-3.5" />指派给:<span className="font-medium text-foreground">{t.assignee_name || '公共池'}</span></div>
              <div className="text-muted-foreground">转单人:<span className="font-medium text-foreground">{t.created_by_name || '-'}</span> · {formatDate(t.created_at)}</div>
              {t.dispatch_note && <div className="rounded-md bg-amber-50 px-2.5 py-1.5 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">说明:{t.dispatch_note}</div>}
            </div>
          </section>

          {/* 处理过程 */}
          {(t.handle_note || t.handle_result || t.handled_at) && (
            <section>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground"><Wrench className="h-3.5 w-3.5" />处理过程</div>
              <div className="rounded-lg bg-muted/40 p-3.5 text-[12px] leading-6">
                {t.handle_result && <div className="mb-1 font-medium">{t.handle_result}</div>}
                <div>{t.handle_note || '（无说明）'}</div>
                {(t.handled_by_name || t.handled_at) && (
                  <div className="mt-1.5 text-[11px] text-muted-foreground">{t.handled_by_name || '—'}{t.handled_at ? ` · ${formatFullDate(t.handled_at)}` : ''}</div>
                )}
              </div>
            </section>
          )}

          {/* 回执 */}
          {t.feedback_status && t.feedback_status !== 'none' && (t.review_note || t.reviewed_by_name) && (
            <section>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground"><ClipboardCheck className="h-3.5 w-3.5" />分诊回执</div>
              <div className="rounded-lg border border-border p-3.5 text-[12px] leading-6">
                <div className="font-medium">{FEEDBACK_LABEL[t.feedback_status] || ''}</div>
                {t.review_note && <div className="mt-1 text-muted-foreground">{t.review_note}</div>}
                {(t.reviewed_by_name || t.reviewed_at) && <div className="mt-1.5 text-[11px] text-muted-foreground">{t.reviewed_by_name || '—'}{t.reviewed_at ? ` · ${formatFullDate(t.reviewed_at)}` : ''}</div>}
              </div>
            </section>
          )}
        </div>

        {/* Footer 操作 */}
        {canWrite && (onAction || onReview) && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 px-6 py-3.5">
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
