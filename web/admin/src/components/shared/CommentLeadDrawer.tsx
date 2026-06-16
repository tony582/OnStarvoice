import { useEffect, useRef, useState } from 'react'
import { X, ExternalLink, MessageCircle, Footprints, CheckCheck, CircleSlash, Send } from 'lucide-react'
import { formatNumber, formatDate, formatFullDate, LABELS, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'

const PANEL_MIN = 420, PANEL_MAX = 860, PANEL_DEFAULT = 560

/**
 * 评论线索详情抽屉(舆情评论 / 销售客资 共用)。
 * 右侧停靠、可拖宽(与内容分诊一致),展示原帖 + 评论全文 + 线索判断 + 处理留痕,底部直接处理。
 */
export function CommentLeadDrawer({ lead, onClose, canWrite, onSetStatus, onDispatch, noun, isSales = false, bucket = '' }: {
  lead: any
  onClose: () => void
  canWrite: boolean
  onSetStatus: (status: string) => void
  onDispatch?: () => void
  noun: string
  isSales?: boolean
  bucket?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('osv_detail_width'))
    return saved >= PANEL_MIN && saved <= PANEL_MAX ? saved : PANEL_DEFAULT
  })

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

  const keywords: string[] = Array.isArray(lead.matched_keywords)
    ? lead.matched_keywords
    : (() => { try { return JSON.parse(lead.matched_keywords || '[]') } catch { return [] } })()

  const Act = ({ icon: Icon, label, status, tone }: any) => (
    <Button variant={tone === 'ghost' ? 'ghost' : 'outline'} size="sm"
      disabled={!canWrite || lead.status === status}
      onClick={() => onSetStatus(status)}>
      <Icon className="h-3.5 w-3.5" />{label}
    </Button>
  )

  return (
    <div ref={panelRef} style={{ width }}
      className="fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-card shadow-[-8px_0_24px_-12px_rgba(17,24,39,0.12)] animate-in slide-in-from-right duration-200">
      <div onMouseDown={startResize} title="拖动调整宽度"
        className="group absolute left-0 top-0 z-30 flex h-full w-2.5 -translate-x-1/2 cursor-col-resize justify-center">
        <span className="h-full w-px bg-transparent transition-all group-hover:w-[3px] group-hover:bg-primary" />
      </div>
      <div className="relative z-10 flex h-full w-full flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border/50 px-6 py-4">
          <h2 className="text-base font-bold">{noun}详情</h2>
          <StatusBadge tone={lead.status}>{LABELS.leadStatus[lead.status] || lead.status}</StatusBadge>
          <button onClick={onClose} className="ml-auto rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          {/* 评论(主角)*/}
          <section>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground"><MessageCircle className="h-3.5 w-3.5" />评论内容</div>
            <div className="rounded-lg border border-border bg-muted/30 p-3.5 text-[13px] leading-6 whitespace-pre-wrap">{lead.comment_content || '(无内容)'}</div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <StatusBadge tone="neutral">{platformName(lead.platform)}</StatusBadge>
              <StatusBadge tone="neutral">{LABELS.leadType[lead.lead_type] || lead.lead_type}</StatusBadge>
              <StatusBadge tone={lead.priority}>{LABELS.priority[lead.priority] || lead.priority}</StatusBadge>
            </div>
          </section>

          {/* 评论者 */}
          <section className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3.5 text-[12px]">
            <Info label="评论者" value={lead.comment_author_name || '-'} />
            <Info label="IP 属地" value={lead.comment_ip_location || '-'} />
            <Info label="用户 ID" value={lead.comment_author_id || '-'} />
            <Info label="评论点赞" value={formatNumber(lead.comment_like_count)} />
          </section>

          {/* AI 判断理由 + 命中词 */}
          {(lead.reason || keywords.length > 0) && (
            <section>
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">判断依据</div>
              {lead.reason && <div className="mb-2 text-[12px] leading-6 text-muted-foreground">{lead.reason}</div>}
              {keywords.length > 0 && (
                <div className="flex flex-wrap gap-1">{keywords.slice(0, 12).map(k => <StatusBadge key={k} tone="muted">{k}</StatusBadge>)}</div>
              )}
            </section>
          )}

          {/* 原帖(原始博文 + 帖子AI研判)*/}
          <section>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">来源原帖</div>
            <div className="rounded-lg border border-border p-3.5">
              <div className="text-[13px] font-medium leading-snug">{lead.record_title || '(无标题)'}</div>
              {lead.record_content && (
                <div className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-6 text-muted-foreground">{lead.record_content}</div>
              )}
              {lead.record_ai_summary && (
                <div className="mt-2 rounded-md bg-primary/[0.04] p-2.5 text-[12px] leading-6 text-muted-foreground"><span className="font-semibold text-foreground">帖子AI研判:</span>{lead.record_ai_summary}</div>
              )}
              {lead.record_url && (
                <a href={lead.record_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" />查看原帖</a>
              )}
            </div>
          </section>

          {/* 处理留痕 */}
          {(lead.note || lead.handled_at) && (
            <section>
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">处理留痕</div>
              <div className="rounded-lg bg-muted/40 p-3.5 text-[12px] leading-6">
                <div>{lead.note || '（无备注）'}</div>
                {(lead.handled_name || lead.handled_at) && (
                  <div className="mt-1.5 text-[11px] text-muted-foreground">{lead.handled_name || '—'}{lead.handled_at ? ` · ${formatFullDate(lead.handled_at)}` : ''}</div>
                )}
              </div>
            </section>
          )}

          <div className="text-[11px] text-muted-foreground">采集于 {formatDate(lead.captured_at)}</div>
        </div>

        {/* Footer 操作:销售=跟进/处理/忽略;舆情=转工单/归档/忽略(已归档只读)*/}
        {canWrite && (
          <div className="flex items-center justify-end gap-2 border-t border-border/50 px-6 py-3.5">
            {isSales ? <>
              <Act icon={Footprints} label="跟进" status="following" />
              <Act icon={CheckCheck} label="处理" status="resolved" />
              <Act icon={CircleSlash} label="忽略" status="ignored" tone="ghost" />
            </> : bucket === 'archived' ? (
              <span className="text-[12px] text-muted-foreground">已归档,无需操作</span>
            ) : <>
              <Button size="sm" onClick={onDispatch}><Send className="h-3.5 w-3.5" />转工单</Button>
              <Act icon={CheckCheck} label="归档" status="resolved" />
              <Act icon={CircleSlash} label="忽略" status="ignored" tone="ghost" />
            </>}
          </div>
        )}
      </div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-0.5 font-medium">{value}</div></div>
}
