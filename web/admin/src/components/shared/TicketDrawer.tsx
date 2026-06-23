import { useEffect, useRef, useState } from 'react'
import { X, ExternalLink, FileText, Info, Sparkles, MessageCircle, UserCog, Workflow, Pin, CheckCircle2, Send } from 'lucide-react'
import { api } from '@/lib/api'
import { formatFullDate, formatNumber, LABELS, platformName, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'

const PANEL_MIN = 420, PANEL_MAX = 860, PANEL_DEFAULT = 580

const STATE_TONE: Record<string, string> = { pending: 'orange', doing: 'blue', done: 'positive', dismissed: 'muted', closed: 'positive' }
const STATE_LABEL: Record<string, string> = { pending: '待处理', doing: '处理中', done: '已处理', dismissed: '已忽略', closed: '已结案' }

/**
 * 工单详情抽屉(舆情处理 / 已转工单 共用)。单面板(无 Tab),分区用分隔线拉开层次:
 * 内容 → 基本信息(互动数据 + 作者/主页/发布/采集/原文)→ AI 研判 → 负面评论 → 处理记录(活动流)。
 * 底部内联「过程备注」,顶部「结案」一键闭环(Asana 式)。右侧停靠、可拖宽、可钉住。
 * - 已转工单(就地闭环):传 onCloseTicket(结案)
 * - 舆情处理(客服):传 onAction(done / dismiss)
 * - 旧分诊回执:传 onReview(confirm / reopen)
 */
export function TicketDrawer({ ticket: t, onClose, canWrite, onAction, onReview, onCloseTicket }: {
  ticket: any
  onClose: () => void
  canWrite: boolean
  onAction?: (action: string) => void
  onReview?: (decision: 'confirm' | 'reopen') => void
  onCloseTicket?: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState<{ record: any; comment: any; negativeComments: any[]; notes: any[] } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [pinned, setPinned] = useState(() => localStorage.getItem('osv_drawer_pinned') === '1')
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('osv_detail_width'))
    return saved >= PANEL_MIN && saved <= PANEL_MAX ? saved : PANEL_DEFAULT
  })

  useEffect(() => {
    let alive = true
    setSource(null); setNoteText('')
    api.get<any>(`/tickets/${t.id}/source`)
      .then(d => { if (alive) setSource({ record: d.record, comment: d.comment, negativeComments: d.negativeComments || [], notes: d.notes || [] }) })
      .catch(() => { if (alive) setSource({ record: null, comment: null, negativeComments: [], notes: [] }) })
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

  const togglePin = () => setPinned(p => { const n = !p; localStorage.setItem('osv_drawer_pinned', n ? '1' : '0'); return n })

  const addNote = async () => {
    const body = noteText.trim()
    if (!body || savingNote) return
    setSavingNote(true)
    try {
      const r = await api.post<any>(`/tickets/${t.id}/notes`, { body })
      setSource(s => s ? { ...s, notes: [...(s.notes || []), r.note] } : s)
      setNoteText('')
    } catch { /* ignore */ } finally { setSavingNote(false) }
  }

  const isComment = t.source_type === 'comment'
  const rec = source?.record
  const cmt = source?.comment
  const kw: string[] = Array.isArray(cmt?.matched_keywords)
    ? cmt.matched_keywords
    : (() => { try { return JSON.parse(cmt?.matched_keywords || '[]') } catch { return [] } })()
  const hasAI = Boolean(rec?.ai_summary || cmt?.reason || kw.length > 0)
  const negs = source?.negativeComments || []
  const notes = source?.notes || []
  const closed = t.status === 'closed'
  const postUrl = t.url || rec?.url || cmt?.record_url || ''

  return (
    <div ref={panelRef} style={{ width }}
      className="fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-card shadow-[-8px_0_24px_-12px_rgba(17,24,39,0.12)] animate-in slide-in-from-right duration-200">
      <div onMouseDown={startResize} title="拖动调整宽度"
        className="group absolute left-0 top-0 z-30 flex h-full w-2.5 -translate-x-1/2 cursor-col-resize justify-center">
        <span className="h-full w-px bg-transparent transition-all group-hover:w-[3px] group-hover:bg-primary" />
      </div>
      <div className="relative z-10 flex h-full w-full flex-col">
        {/* Header:标题 + 状态 +(结案)+ 钉住 + 关闭 */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border/60 px-6">
          <h2 className="text-base font-bold">工单详情</h2>
          <StatusBadge tone={STATE_TONE[t.status] || 'muted'}>{STATE_LABEL[t.status] || t.status}</StatusBadge>
          <div className="ml-auto flex items-center gap-2">
            {onCloseTicket && (closed
              ? <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" />已结案</span>
              : canWrite && <Button size="sm" onClick={onCloseTicket}><CheckCircle2 className="h-3.5 w-3.5" />结案</Button>)}
            <button onClick={togglePin} title={pinned ? '已钉住:切换工单时保留滚动' : '钉住面板'}
              className={cn('rounded-lg p-1.5 transition-colors', pinned ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-accent')}>
              <Pin className={cn('h-[18px] w-[18px]', pinned && 'fill-current')} />
            </button>
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent"><X className="h-5 w-5" /></button>
          </div>
        </div>

        {/* 摘要条:类型 / 平台 / 优先级 / 处理人 / 原文 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border/60 bg-muted/30 px-6 py-2.5">
          <StatusBadge tone={isComment ? 'neutral' : 'active'}>{isComment ? '评论' : '内容'}</StatusBadge>
          <StatusBadge tone="neutral">{platformName(t.platform)}</StatusBadge>
          <StatusBadge tone={t.priority}>{LABELS.priority[t.priority] || t.priority}</StatusBadge>
          <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground"><UserCog className="h-3.5 w-3.5" />{t.assignee_name || '本人跟进'}</span>
          {postUrl && <a href={postUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" />原文</a>}
        </div>

        {/* Body:单面板,分区用分隔线拉开层次 */}
        <div className="flex-1 overflow-y-auto">
          {/* 内容 */}
          <Section icon={FileText} title={isComment ? '评论内容' : '帖子正文'}>
            {isComment ? (
              <>
                <Quote>{cmt?.comment_content || t.item_text || '(无内容)'}</Quote>
                <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-muted-foreground">
                  <span>评论作者 <span className="font-medium text-foreground">{cmt?.comment_author_name || t.author || '-'}</span></span>
                  {cmt?.comment_like_count > 0 && <span>· 赞 {formatNumber(cmt.comment_like_count)}</span>}
                  {cmt?.comment_ip_location && <span>· {cmt.comment_ip_location}</span>}
                </div>
              </>
            ) : (
              <>
                {(rec?.title || t.title) && <div className="mb-1.5 text-[14px] font-semibold leading-snug text-foreground">{rec?.title || t.title}</div>}
                <Quote>{rec?.content || t.item_text || '(无正文)'}</Quote>
              </>
            )}
          </Section>

          {/* 基本信息(以源帖 record 为主)*/}
          {rec && (
            <Section icon={Info} title={isComment ? '所在帖子 · 基本信息' : '基本信息'}>
              {isComment && rec.title && <div className="mb-2.5 line-clamp-2 text-[13px] font-medium leading-snug text-foreground">{rec.title}</div>}
              <div className="grid grid-cols-4 gap-2">
                <Stat label="点赞" value={rec.likes} />
                <Stat label="评论" value={rec.comments_count} />
                <Stat label="收藏" value={rec.collects} />
                <Stat label="转发" value={rec.shares} />
              </div>
              <div className="mt-3 space-y-1.5">
                <MetaRow label="作者">
                  <span className="font-medium text-foreground">{rec.author_name || t.author || '-'}</span>
                  {rec.author_fans > 0 && <span className="text-muted-foreground"> · {formatNumber(rec.author_fans)} 粉丝</span>}
                  {rec.blogger_profile_url && <a href={rec.blogger_profile_url} target="_blank" rel="noreferrer" className="ml-1.5 inline-flex items-center gap-0.5 font-semibold text-primary hover:underline">博主主页<ExternalLink className="h-3 w-3" /></a>}
                </MetaRow>
                {rec.publish_time && <MetaRow label="发布时间">{rec.publish_time}</MetaRow>}
                <MetaRow label="采集">
                  首次 {formatFullDate(rec.first_seen_at)} · 最近 {formatFullDate(rec.last_seen_at)}
                  {rec.seen_count > 0 && <span className="text-muted-foreground"> · 第 {rec.seen_count} 次</span>}
                </MetaRow>
                {postUrl && <MetaRow label="原文"><a href={postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-primary hover:underline">打开原文<ExternalLink className="h-3 w-3" /></a></MetaRow>}
                {(rec.sentiment || rec.category) && (
                  <MetaRow label="研判">
                    <span className="inline-flex flex-wrap gap-1 align-middle">
                      <StatusBadge tone={rec.sentiment === 'negative' ? 'negative' : rec.sentiment === 'positive' ? 'positive' : 'muted'}>{LABELS.sentiment[rec.sentiment] || '待标注'}</StatusBadge>
                      {rec.category && <StatusBadge tone="neutral">{LABELS.category?.[rec.category] || rec.category}</StatusBadge>}
                      {rec.negative_comment_count > 0 && <StatusBadge tone="negative">负评 {rec.negative_comment_count}</StatusBadge>}
                    </span>
                  </MetaRow>
                )}
              </div>
            </Section>
          )}

          {/* AI 研判 */}
          {hasAI && (
            <Section icon={Sparkles} title="AI 研判">
              <div className="space-y-2.5 rounded-xl bg-primary/[0.05] p-3.5">
                {rec?.ai_summary && (
                  <div className="text-[12.5px] leading-6"><span className="font-semibold text-foreground">帖子:</span><span className="text-muted-foreground"> {rec.ai_summary}</span></div>
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

          {/* 负面评论 */}
          {!isComment && negs.length > 0 && (
            <Section icon={MessageCircle} title={`负面评论 (${negs.length})`}>
              <div className="space-y-2">
                {negs.map((c, i) => (
                  <div key={i} className="rounded-lg bg-status-red/[0.05] p-3 text-[12px] leading-5">
                    <div className="whitespace-pre-wrap text-foreground">{c.content}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">{c.author_name || '匿名'}{c.ip_location ? ` · ${c.ip_location}` : ''}{c.like_count ? ` · 赞 ${formatNumber(c.like_count)}` : ''}</div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* 处理记录:活动流(转单 → 过程备注 → 结案)*/}
          <Section icon={Workflow} title="处理记录">
            <div className="space-y-3">
              <Entry tone="amber" who={t.created_by_name} when={t.created_at} label="转单"
                sub={`指派 ${t.assignee_name || '本人跟进'}`} body={t.dispatch_note} />
              {notes.map((n: any) => (
                <Entry key={n.id} who={n.author_name} when={n.created_at} body={n.body} />
              ))}
              {closed && (
                <Entry tone="green" who={t.handled_by_name} when={t.handled_at} label="结案"
                  sub={t.handle_result && t.handle_result !== '已结案' ? t.handle_result : undefined} body={t.handle_note} />
              )}
              {!notes.length && !t.dispatch_note && !closed && (
                <div className="text-[12px] text-muted-foreground">暂无处理记录,可在下方添加过程备注。</div>
              )}
            </div>
          </Section>
        </div>

        {/* Footer:内联添加过程备注 + 旧动作(舆情处理/分诊回执)*/}
        {canWrite && (onCloseTicket || onAction || onReview) && (
          <div className="shrink-0 border-t border-border/60 px-6 py-3">
            {!closed && (
              <div className="flex items-end gap-2">
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNote() } }}
                  rows={2}
                  placeholder="添加过程备注…(记录处理进展,Cmd/Ctrl+Enter 发送)"
                  className="min-h-[40px] flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-5 outline-none transition focus:border-primary" />
                <Button size="sm" onClick={addNote} disabled={savingNote || !noteText.trim()} title="添加过程备注">
                  <Send className="h-3.5 w-3.5" />{savingNote ? '…' : '添加'}
                </Button>
              </div>
            )}
            {(onAction || onReview) && (
              <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                {onAction && (t.status === 'pending' || t.status === 'doing') && <>
                  <Button variant="outline" size="sm" onClick={() => onAction('done')}>处理完成</Button>
                  <Button variant="ghost" size="sm" onClick={() => onAction('dismiss')}>忽略</Button>
                </>}
                {onAction && (t.status === 'done' || t.status === 'dismissed') &&
                  <span className="text-[12px] text-muted-foreground">{t.feedback_status === 'pending_review' ? '已提交,待分诊确认' : '已完成'}</span>}
                {onReview && <>
                  <Button variant="outline" size="sm" onClick={() => onReview('confirm')}>确认归档</Button>
                  <Button variant="ghost" size="sm" onClick={() => onReview('reopen')}>打回</Button>
                </>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// 分区:顶部分隔线 + 图标 + 加粗标题,拉开层次
function Section({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border/50 px-6 py-4 first:border-t-0">
      <div className="mb-2.5 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-[13px] font-bold text-foreground">{title}</h3>
      </div>
      {children}
    </section>
  )
}

function Quote({ children }: { children: React.ReactNode }) {
  return <div className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3.5 text-[13px] leading-6">{children}</div>
}

// 互动数据格子:大数字 + 小标签
function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="rounded-lg bg-muted/40 py-2 text-center">
      <div className="text-[16px] font-bold tabular-nums text-foreground">{formatNumber(value)}</div>
      <div className="mt-0.5 text-[10.5px] text-muted-foreground">{label}</div>
    </div>
  )
}

// 信息行:左侧固定宽度标签 + 右侧值
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 text-[12.5px] leading-5">
      <span className="w-[52px] shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
    </div>
  )
}

// 活动流条目:小圆点 + 人/时间/标签 + 内容气泡
function Entry({ who, when, body, label, sub, tone }: {
  who?: string; when?: string; body?: string; label?: string; sub?: string; tone?: 'amber' | 'green'
}) {
  const dot = tone === 'amber' ? 'bg-amber-500' : tone === 'green' ? 'bg-emerald-500' : 'bg-primary/50'
  return (
    <div className="flex gap-2.5">
      <span className={cn('mt-[6px] h-2 w-2 shrink-0 rounded-full ring-2 ring-card', dot)} />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] leading-5 text-muted-foreground">
          {label && <span className="font-semibold text-foreground">{label}</span>}
          {label && <span> · </span>}
          <span className="font-medium text-foreground">{who || '-'}</span>
          {when && <span> · {formatFullDate(when)}</span>}
          {sub && <span> · {sub}</span>}
        </div>
        {body && <div className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-[12.5px] leading-5 text-foreground">{body}</div>}
      </div>
    </div>
  )
}
