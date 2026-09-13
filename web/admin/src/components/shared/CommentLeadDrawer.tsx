import { useCallback, useEffect, useRef, useState } from 'react'
import { X, MessageCircle, ArrowLeft, Loader2, History, FileText, Lightbulb, Pencil, ArchiveRestore, Send, Copy, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, formatFullDate, LABELS, platformName, cn } from '@/lib/utils'
import { commentLeadIsArchived, commentLeadSource, commentLeadJudgment, commentLeadStatusLabel, commentLeadTicketStatusLabel, COMMENT_LEAD_STATUSES, COMMENT_LEAD_TYPES, type CommentLead, type CommentLeadDetail, type CommentLeadActivity, type CommentLeadTicket } from '@/lib/comment-leads'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { RecordSourceAction } from '@/components/shared/RecordSourceAction'
import { TicketDrawer } from '@/components/shared/TicketDrawer'
import { useNotePrompt } from '@/components/shared/NotePrompt'
import { RecordDrawer } from '@/components/shared/RecordDrawer'

const PANEL_MIN = 480, PANEL_MAX = 900, PANEL_DEFAULT = 620

type DrawerTab = 'content' | 'history'
interface Props {
  lead: CommentLead
  onClose: () => void
  canWrite: boolean
  onSetStatus: (status: string) => Promise<boolean>
  onDispatch?: () => Promise<boolean>
  onUpdated: () => void | Promise<void>
  noun: string
  initialTab?: DrawerTab | 'ticket'
}

export function CommentLeadDrawer(props: Props) {
  return <CommentLeadDrawerContent key={`${props.lead.id}:${props.initialTab || "content"}`} {...props} />
}

function CommentLeadDrawerContent({ lead: initialLead, onClose, canWrite, onSetStatus, onDispatch, onUpdated, noun, initialTab = 'content' }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const requestSeq = useRef(0)
  const dragCleanup = useRef<(() => void) | null>(null)
  const [detail, setDetail] = useState<CommentLeadDetail>({ lead: initialLead, record: null, activity: [] })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<DrawerTab>(initialTab === 'ticket' ? 'content' : initialTab)
  const [showTicket, setShowTicket] = useState(initialTab === 'ticket')
  const { ask: askTicketNote, dialog: ticketNoteDialog } = useNotePrompt()
  const [note, setNote] = useState('')
  const [correcting, setCorrecting] = useState(false)
  const [correctionType, setCorrectionType] = useState(initialLead.lead_type === 'sales_intent' ? 'brand_risk' : 'sales_intent')
  const [correctionReason, setCorrectionReason] = useState('')
  const [showRecord, setShowRecord] = useState(false)
  const [copied, setCopied] = useState(false)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('osv_detail_width'))
    return saved >= PANEL_MIN && saved <= PANEL_MAX ? saved : PANEL_DEFAULT
  })
  const lead = detail.lead
  const archived = commentLeadIsArchived(lead)
  const isSales = lead.lead_type === 'sales_intent'
  const judgment = commentLeadJudgment(lead)

  const reloadDetail = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    setLoadError('')
    try {
      const result = await api.get<CommentLeadDetail>(`/leads/comments/${initialLead.id}`)
      if (seq === requestSeq.current) setDetail({ ...result, activity: result.activity || [] })
    } catch (err) {
      if (seq === requestSeq.current) setLoadError(err instanceof Error ? err.message : '详情加载失败，请重试')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [initialLead.id])

  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void reloadDetail() })
    return () => { active = false; requestSeq.current += 1 }
  }, [reloadDetail])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || showRecord || (showTicket && detail.ticket) || busy || event.defaultPrevented) return
      // 备注/工单弹窗由自身处理 Escape，避免连带关闭详情。
      if (document.querySelector('[data-lead-dialog], .fixed.z-\\[60\\]')) return
      if (correcting) setCorrecting(false)
      else onClose()
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [busy, correcting, onClose, showRecord, showTicket, detail.ticket])
  useEffect(() => {
    if (!showRecord && !showTicket) document.documentElement.style.setProperty('--detail-dock-width', width + 'px')
  }, [width, showRecord, showTicket])
  useEffect(() => () => {
    dragCleanup.current?.()
    document.documentElement.style.setProperty('--detail-dock-width', '0px')
  }, [])

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault()
    dragCleanup.current?.()
    const startX = event.clientX, startW = panelRef.current?.offsetWidth ?? width
    let nextWidth = startW
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const move = (e: MouseEvent) => {
      nextWidth = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + startX - e.clientX))
      if (panelRef.current) panelRef.current.style.width = nextWidth + 'px'
      document.documentElement.style.setProperty('--detail-dock-width', nextWidth + 'px')
    }
    const cleanup = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    const up = () => { cleanup(); setWidth(nextWidth); localStorage.setItem('osv_detail_width', String(nextWidth)) }
    dragCleanup.current = cleanup
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const runAction = async (action: () => Promise<boolean | void>, refresh = true) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await action()
      if (result === false) return
      if (refresh) await reloadDetail()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试')
    } finally { setBusy(false) }
  }

  const addNote = () => runAction(async () => {
    const body = note.trim()
    if (!body) return false
    await api.post(`/leads/comments/${lead.id}/notes`, { body })
    setNote('')
    await onUpdated()
  })
  const saveCorrection = () => runAction(async () => {
    if (!correctionReason.trim()) { setError('请填写具体判断原因'); return false }
    await api.patch(`/leads/comments/${lead.id}`, { leadType: correctionType, correctionReason: correctionReason.trim() })
    setCorrecting(false); setCorrectionReason('')
    await onUpdated()
    setTab('history')
  })

  const refreshAfterTicket = async () => { await reloadDetail(); await onUpdated() }
  const actOnTicket = async (action: string) => {
    if (!detail.ticket) return false
    const labels: Record<string, string> = { done: '处理完成', dismiss: '忽略工单', close: '工单结案', reopen: '重开工单' }
    const note = await askTicketNote({ title: labels[action] || '工单处理', placeholder: '记录处理结果、结案说明或重开原因', confirmLabel: labels[action] || '保存' })
    if (note === null) return false
    const result = await api.patch<{ ticket: CommentLeadTicket }>(`/tickets/${detail.ticket.id}`, { action, ...(note.trim() ? { note: note.trim() } : {}) })
    setDetail(current => ({ ...current, ticket: result.ticket }))
    await refreshAfterTicket()
    return true
  }
  if (showTicket && detail.ticket) {
    return <><TicketDrawer ticket={detail.ticket} canWrite={canWrite} onClose={() => setShowTicket(false)} onAction={actOnTicket} onCloseTicket={() => actOnTicket('close')} onReopenTicket={() => actOnTicket('reopen')} onNoteAdded={() => void refreshAfterTicket()} onTicketNumberAdded={() => void refreshAfterTicket()} />{ticketNoteDialog}</>
  }

  if (showRecord && detail.record) {
    return <RecordDrawer record={detail.record} canWrite={false} onClose={() => setShowRecord(false)} />
  }

  const fallbackSteps = isSales
    ? ['先查看原帖与上下文，确认询价、试驾或购买表达是否为真实需求，留意反问、暗讽及否定语气。', '确认需求后询问产品、地区和购买计划，再转交相应销售跟进；存在疑点时先澄清。', '将每次沟通结果追加到跟进记录，处理完毕后标记已处理。']
    : ['结合原帖核对评论实际诉求；区分暗讽、投诉和真实求助，保留具体表达作为依据。', '对可核实的问题记录事实和诉求，需要多人处理时转工单；信息不足时先澄清。', '记录每次跟进及处理结果，需要继续观察时保持跟进中。']
  const suggestion = detail.suggestion
  const keywords = Array.isArray(lead.matched_keywords) ? lead.matched_keywords : []

  return (
    <div ref={panelRef} style={{ width }} role="dialog" aria-modal="true" aria-label={`${noun}详情`}
      className="detail-drawer fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-card shadow-[-8px_0_24px_-12px_rgba(17,24,39,0.12)] animate-in slide-in-from-right duration-200">
      <div onMouseDown={startResize} title="拖动调整宽度" className="group absolute left-0 top-0 z-30 hidden h-full w-2.5 -translate-x-1/2 cursor-col-resize justify-center lg:flex"><span className="h-full w-px bg-transparent group-hover:w-[3px] group-hover:bg-primary" /></div>
      <div className="flex min-h-14 items-center gap-2 border-b border-border/50 px-3 pt-[env(safe-area-inset-top)] sm:px-5">
        <button onClick={onClose} disabled={busy} aria-label={`返回${noun}列表`} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full lg:hidden"><ArrowLeft className="h-5 w-5" /></button>
        <h2 className="text-base font-bold">{noun}详情</h2>
        <StatusBadge tone={lead.status}>{commentLeadStatusLabel(lead.status)}</StatusBadge>
        <button onClick={onClose} disabled={busy} aria-label={`关闭${noun}详情`} className="ml-auto hidden rounded-lg p-2 text-muted-foreground hover:bg-accent lg:block"><X className="h-5 w-5" /></button>
      </div>
      <div role="tablist" aria-label="评论详情内容" className="flex gap-1 border-b border-border/50 px-4 py-2">
        {[{ id: 'content' as const, label: '评论与建议', icon: MessageCircle }, { id: 'history' as const, label: `跟进记录${detail.activity.length ? ` (${detail.activity.length})` : ''}`, icon: History }].map(item => <button key={item.id} role="tab" aria-selected={tab === item.id} aria-controls={`lead-panel-${item.id}`} onClick={() => setTab(item.id)} className={cn('flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold', tab === item.id ? 'bg-accent text-primary' : 'text-muted-foreground hover:bg-muted')}><item.icon className="h-3.5 w-3.5" />{item.label}</button>)}
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">
        {loading && <div className="mb-3 flex items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在加载最新详情…</div>}
        {loadError && <div role="alert" className="mb-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-[12px] text-destructive">{loadError}<button onClick={() => void reloadDetail()} className="ml-2 font-semibold underline">重试</button></div>}
        {showTicket && !detail.ticket && !loading && !loadError && <p role="alert" className="mb-3 rounded-lg bg-muted p-3 text-[12px] text-muted-foreground">关联工单暂不可用，请刷新后重试。</p>}
        {archived && <div className="mb-4 rounded-lg bg-muted px-3 py-2.5 text-[12px] text-muted-foreground">已归档，恢复到待处理后可继续跟进和修正判断。</div>}
        {tab === 'content' ? <div id="lead-panel-content" role="tabpanel" className="space-y-5">
          <section>
            <div className="mb-2 flex flex-wrap items-center gap-1.5"><StatusBadge tone="neutral">{platformName(lead.platform || '')}</StatusBadge><StatusBadge tone="neutral">{LABELS.leadType[lead.lead_type] || lead.lead_type}</StatusBadge><StatusBadge tone={lead.priority}>{LABELS.priority[lead.priority] || lead.priority}</StatusBadge></div>
            <div className="rounded-xl border border-border bg-muted/25 p-3.5 text-[14px] leading-7 whitespace-pre-wrap break-words">{lead.comment_content || '(无内容)'}</div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-[12px]"><Info label="评论者" value={lead.comment_author_name || '—'} /><Info label="IP 属地" value={lead.comment_ip_location || '—'} /><Info label="评论时间" value={lead.publish_display || '—'} /><Info label="评论点赞" value={formatNumber(lead.comment_like_count)} /></div>
          </section>
          <section className="rounded-xl border border-border p-3.5">
            <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-[12px] font-bold">判断依据</h3>{canWrite && !archived && <button disabled={busy || loading || Boolean(loadError)} onClick={() => { setCorrecting(!correcting); setError('') }} className="flex items-center gap-1 text-[12px] font-semibold text-primary disabled:opacity-50"><Pencil className="h-3.5 w-3.5" />修正判断</button>}</div>
            {judgment.label && <div className="mb-2"><StatusBadge tone={judgment.needsReview ? 'high' : 'neutral'}>{judgment.label}</StatusBadge></div>}
            <p className="whitespace-pre-wrap text-[12px] leading-6 text-muted-foreground">{judgment.reason || '暂无具体判断依据，请结合评论与原帖核对。'}</p>
            {judgment.salesReason && judgment.salesReason !== judgment.reason && <p className="mt-2 text-[12px] leading-6 text-muted-foreground"><span className="font-semibold">购买判断：</span>{judgment.salesReason}</p>}
            {(judgment.expression || judgment.actor || judgment.target) && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">{judgment.expression && <span>语气：{judgment.expression}</span>}{judgment.actor && <span>主体：{judgment.actor}</span>}{judgment.target && <span>购买对象：{judgment.target}</span>}</div>}
            {judgment.evidence.length > 0 && <div className="mt-3 border-l-2 border-primary/25 pl-3"><div className="mb-1 text-[10px] font-bold text-muted-foreground">评论中的意向证据</div>{judgment.evidence.map((text: string, index: number) => <p key={index} className="whitespace-pre-wrap text-[12px] leading-6">“{text}”</p>)}</div>}
            {keywords.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{keywords.slice(0, 12).map((word: string) => <StatusBadge key={word} tone="muted">{word}</StatusBadge>)}</div>}
            {correcting && <div className="mt-3 space-y-2 border-t border-border pt-3">
              <label className="block text-[12px] font-semibold" htmlFor="lead-correction-type">正确类型</label>
              <select id="lead-correction-type" value={correctionType} disabled={busy} onChange={event => setCorrectionType(event.target.value)} className="h-10 w-full rounded-lg border border-border bg-background px-2 text-[13px]">{COMMENT_LEAD_TYPES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              <label className="block text-[12px] font-semibold" htmlFor="lead-correction-reason">判断原因</label>
              <textarea id="lead-correction-reason" value={correctionReason} disabled={busy} maxLength={2000} onChange={event => setCorrectionReason(event.target.value)} placeholder="例如：这是反问和暗讽，没有真实购买意愿；结合原帖可见用户正在抱怨收费。" rows={3} className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-6" />
              <p className="text-[11px] leading-5 text-muted-foreground">修正会记录原因，并按正确类型显示在销售客资或评论分诊中。</p>
              <div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => setCorrecting(false)}>取消</Button><Button size="sm" disabled={busy || !correctionReason.trim()} onClick={() => void saveCorrection()}>保存修正</Button></div>
            </div>}
          </section>
          <section className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3.5">
            <h3 className="mb-2 flex items-center gap-1.5 text-[12px] font-bold"><Lightbulb className="h-4 w-4 text-amber-600" />跟进建议</h3>
            <p className="mb-2 text-[11px] leading-5 text-muted-foreground">{suggestion?.source === 'ai' ? 'AI 跟进建议，基于已保存的评论判断。' : '按当前类型整理的跟进建议。'}请先结合原帖核实实际诉求。</p>
            {suggestion?.summary && <p className="mb-2 text-[12px] font-medium leading-6">{suggestion.summary}</p>}
            <ol className="list-decimal space-y-1.5 pl-4 text-[12px] leading-6">{(suggestion?.steps?.length ? suggestion.steps : fallbackSteps).map((step, index) => <li key={index}>{step}</li>)}</ol>
            {suggestion?.replyDraft && <div className="mt-3 border-t border-amber-500/15 pt-3"><div className="mb-1 flex items-center justify-between"><span className="text-[11px] font-bold">沟通参考</span><button className="flex items-center gap-1 text-[11px] text-primary" onClick={async () => { try { await navigator.clipboard.writeText(suggestion.replyDraft || ''); setCopied(true) } catch { setError('复制失败，请手动选择文字复制') } }}>{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}{copied ? '已复制' : '复制'}</button></div><p className="whitespace-pre-wrap text-[12px] leading-6">{suggestion.replyDraft}</p></div>}
          </section>
          {lead.ticket_id && <section className="flex items-center justify-between gap-3 rounded-xl border border-border p-3.5"><div><h3 className="text-[12px] font-bold">关联工单</h3><p className="mt-1 text-[11px] text-muted-foreground">{commentLeadTicketStatusLabel(lead.ticket_status)}</p></div><Button variant="outline" size="sm" disabled={loading || !detail.ticket} onClick={() => setShowTicket(true)}><FileText className="h-3.5 w-3.5" />查看工单</Button></section>}
          <section className="rounded-xl border border-border p-3.5">
            <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-[12px] font-bold">来源原帖</h3><RecordSourceAction record={detail.record || commentLeadSource(lead)} className="text-[12px]" /></div>
            <div className="text-[13px] font-semibold leading-6">{detail.record?.title || lead.record_title || '(无标题)'}</div>
            {(detail.record?.content || lead.record_content) && <p className="mt-1.5 max-h-52 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-6 text-muted-foreground">{detail.record?.content || lead.record_content}</p>}
            <Button size="sm" variant="outline" className="mt-3" disabled={!detail.record || loading} onClick={() => setShowRecord(true)}><FileText className="h-3.5 w-3.5" />查看完整原帖详情</Button>
            {!loading && !loadError && !detail.record && <p className="mt-2 text-[11px] text-muted-foreground">当前原帖详情不可用，以上保留采集时的来源信息。</p>}
          </section>
          <p className="text-[11px] text-muted-foreground">采集于 {formatDate(lead.captured_at)}</p>
        </div> : <div id="lead-panel-history" role="tabpanel" className="space-y-4">
          {canWrite && !archived && <section aria-label="追加跟进记录" className="rounded-xl border border-border p-3.5">
            <label className="mb-2 block text-[12px] font-bold" htmlFor="lead-follow-up-note">追加跟进记录</label>
            <textarea id="lead-follow-up-note" value={note} maxLength={2000} disabled={busy} onChange={event => setNote(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && note.trim() && !busy) { event.preventDefault(); void addNote() } }} rows={4} placeholder="记录本次沟通、用户诉求、处理结果或下次跟进安排。" className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-6 outline-none focus:ring-2 focus:ring-primary/20" />
            <div className="mt-2 flex items-center justify-between gap-2"><span className="text-[11px] text-muted-foreground">每次追加独立保存，保留历史记录</span><Button size="sm" disabled={!note.trim() || busy || loading || Boolean(loadError)} onClick={() => void addNote()}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}保存记录</Button></div>
          </section>}
          <section aria-label="跟进历史记录">
            {!loading && detail.activity.length === 0 && !loadError && <div className="py-8 text-center text-[13px] text-muted-foreground">暂无跟进记录</div>}
            <div className="space-y-3">{detail.activity.map(item => <ActivityItem key={item.id} item={item} />)}</div>
          </section>
        </div>}
      </div>
      {error && <div role="alert" className="border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-[12px] text-destructive">{error}</div>}
      {canWrite && <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {archived ? <Button size="sm" variant="outline" disabled={busy || loading || Boolean(loadError)} onClick={() => void runAction(() => onSetStatus('new'))}><ArchiveRestore className="h-3.5 w-3.5" />恢复到待处理</Button> : <>
          <label className="sr-only" htmlFor="lead-status">处理状态</label>
          <select id="lead-status" aria-label="评论处理状态" value={lead.status} disabled={busy || loading || Boolean(loadError)} onChange={event => void runAction(() => onSetStatus(event.target.value))} className="h-9 rounded-lg border border-border bg-background px-2 text-[12px] font-semibold">{COMMENT_LEAD_STATUSES.filter(option => option.value !== 'ticketed' || lead.status === 'ticketed').map(option => <option key={option.value} value={option.value} disabled={option.value === 'ticketed'}>{option.label}</option>)}</select>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setTab('history')}><History className="h-3.5 w-3.5" />写跟进</Button>
          {!isSales && onDispatch && lead.status !== 'ticketed' && <Button size="sm" disabled={busy || loading || Boolean(loadError)} onClick={() => void runAction(onDispatch)}><Send className="h-3.5 w-3.5" />转工单</Button>}
        </>}
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>}
    </div>
  )
}

function ActivityItem({ item }: { item: CommentLeadActivity }) {
  const metadata = item.metadata || {}
  const title = item.action.includes('correct') ? '修正判断' : item.action.includes('note') || item.action.includes('progress') ? '跟进备注' : item.action.includes('ticket') ? '工单进展' : item.action.includes('status') ? '更新处理状态' : item.action.includes('priority') ? '更新优先级' : item.action === 'ai_review' ? 'AI 重新判断' : '处理记录'
  const body = item.body || metadata.body || metadata.note || metadata.correctionReason || ''
  const before = metadata.status_from || metadata.previousStatus || metadata.before?.status || metadata.previous?.status
  const after = metadata.status_to || metadata.nextStatus || metadata.after?.status || metadata.status
  return <article className="rounded-xl border border-border p-3.5"><div className="flex items-start justify-between gap-3"><h4 className="text-[12px] font-semibold">{title}</h4><span className="text-[10px] text-muted-foreground">{item.created_at ? formatFullDate(item.created_at) : ''}</span></div>{before && after && before !== after && <p className="mt-1.5 text-[11px] text-muted-foreground">{commentLeadStatusLabel(before)} → {commentLeadStatusLabel(after)}</p>}{body && <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-6">{String(body)}</p>}<p className="mt-2 text-[11px] text-muted-foreground">{item.actor_name || '系统'}</p></article>
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[10px] text-muted-foreground">{label}</div><div className="mt-0.5 font-medium">{value}</div></div>
}
