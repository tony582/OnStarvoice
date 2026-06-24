import { useEffect, useRef, useState } from 'react'
import {
  LinkIcon, CheckCircle, Loader2, X, Heart, MessageCircle, Star, Share2,
  ExternalLink, User, FileText, Camera, Bell, Archive, Eye, Sparkles,
} from 'lucide-react'

// 详情面板可拖宽,停靠右侧(Asana 式)
const PANEL_MIN = 420, PANEL_MAX = 860, PANEL_DEFAULT = 560
import { api } from '@/lib/api'
import { formatNumber, formatDate, formatFullDateSec, LABELS, platformName, cn, identityLabel } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { Tooltip } from '@/components/shared/Tooltip'

/**
 * 舆情内容详情抽屉(帖子/评论/官方响应/采集快照 四 tab)。
 * 纯展示 + 回调:抽屉持有的是列表行快照,所有写操作由调用方持有,成功后由调用方
 * reload 列表并关闭抽屉(无单条 GET 端点可回灌)。从舆情收件箱提取以供多队列复用。
 */
export function RecordDrawer({ record: r, onClose, canWrite, onLinkIssue, onSetStatus, onMarkResponded }: {
  record: any
  onClose: () => void
  canWrite: boolean
  onLinkIssue: () => void
  onSetStatus?: (status: string) => void
  onMarkResponded?: () => void
}) {
  const [tab, setTab] = useState<'content' | 'comments' | 'official' | 'snapshot'>('content')
  const [comments, setComments] = useState<any[]>([])
  const [officialResponses, setOfficialResponses] = useState<any[]>([])
  const [observations, setObservations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const panelRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('osv_detail_width'))
    return saved >= PANEL_MIN && saved <= PANEL_MAX ? saved : PANEL_DEFAULT
  })

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

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  // 把停靠宽度写入 CSS 变量,主内容据此让出右边
  useEffect(() => {
    document.documentElement.style.setProperty('--detail-dock-width', width + 'px')
  }, [width])
  // 关闭/卸载时归零(仅一次,避免改宽时闪一下)
  useEffect(() => {
    return () => { document.documentElement.style.setProperty('--detail-dock-width', '0px') }
  }, [])

  // 窗口变窄时收一下,给列表留出最小空间
  useEffect(() => {
    const clamp = () => setWidth(w => Math.min(w, Math.max(PANEL_MIN, window.innerWidth - 340)))
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])

  // 拖拽改宽:拖动时直接改 DOM(不触发重渲染),松手再落库
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelRef.current?.offsetWidth ?? width
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + (startX - ev.clientX)))
      if (panelRef.current) panelRef.current.style.width = w + 'px'
      document.documentElement.style.setProperty('--detail-dock-width', w + 'px')
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      const w = panelRef.current?.offsetWidth ?? width
      setWidth(w)
      localStorage.setItem('osv_detail_width', String(w))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const images = getImages(r)
  const cover = images[0] || ''

  const alerts = Number(r.alert_count || 0)
  const negComments = Number(r.negative_comment_count || 0)
  const official = r.official_response_status
  const hasSignals = alerts > 0 || negComments > 0 || (official && official !== 'none')

  const TABS = [
    { id: 'content' as const, label: '帖子内容', icon: FileText },
    { id: 'comments' as const, label: `评论 (${comments.length})`, icon: MessageCircle },
    { id: 'official' as const, label: `官方响应 (${officialResponses.length})`, icon: CheckCircle },
    { id: 'snapshot' as const, label: '采集快照', icon: Camera },
  ]

  return (
    <div ref={panelRef} style={{ width }}
      className="fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-card shadow-[-8px_0_24px_-12px_rgba(17,24,39,0.12)] animate-in slide-in-from-right duration-200">
      {/* 拖拽分隔条:贯穿到顶,与 banner 一体;hover 出蓝线(Asana) */}
      <div onMouseDown={startResize} title="拖动调整宽度"
        className="group absolute left-0 top-0 z-30 flex h-full w-2.5 -translate-x-1/2 cursor-col-resize justify-center">
        <span className="h-full w-px bg-transparent transition-all group-hover:w-[3px] group-hover:bg-primary" />
      </div>
      <div className="relative z-10 flex h-full w-full flex-col">

        {/* Header */}
        <div className="flex h-14 items-center gap-3 border-b border-border/50 px-6">
          <h2 className="text-base font-bold">舆情内容详情</h2>
          {r.triage_status && <StatusBadge tone={r.triage_status}>{LABELS.triage[r.triage_status] || r.triage_status}</StatusBadge>}
          <button onClick={onClose} className="ml-auto rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          {/* Hero */}
          <div className="border-b border-border/50 p-6">
            <div className="flex gap-4">
              {cover ? (
                <div className="h-[88px] w-[88px] shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
                  <img src={cover} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" onError={e => { (e.target as HTMLImageElement).parentElement!.style.display = 'none' }} />
                </div>
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge>
                  <StatusBadge tone={r.sentiment || 'muted'}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge>
                  {r.category && <StatusBadge tone="neutral">{LABELS.category[r.category] || r.category}</StatusBadge>}
                  {identityLabel(r.source_type, r.author_fans, r.author_name) && (
                    <Tooltip text="疑似身份:账号名带品牌/车型 → 疑似品牌关联号(4S店 / KOE,非真实车主);其余按 AI 多信号判定。研判时 4S店 / KOE 建议剔除"><span className={cn('cursor-help rounded-md px-2 py-0.5 text-[11px] font-semibold', ['KOE', '4S店'].includes(identityLabel(r.source_type, r.author_fans, r.author_name)) ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : 'bg-muted text-muted-foreground')}>{identityLabel(r.source_type, r.author_fans, r.author_name)}</span></Tooltip>
                  )}
                </div>
                <h3 className="text-[15px] font-bold leading-snug">{r.title || String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '(无标题)'}</h3>

                {/* Author + links */}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
                      {(r.author_name || '?').slice(0, 1)}
                    </div>
                    <span className="text-[13px] font-semibold">{r.author_name || '未知作者'}</span>
                    {r.blogger_fans_count ? <span className="text-[11px] text-muted-foreground">{formatNumber(r.blogger_fans_count)} 粉丝</span> : null}
                  </div>
                  {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" />原文</a>}
                  {r.blogger_profile_url && <a href={r.blogger_profile_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"><User className="h-3.5 w-3.5" />主页</a>}
                  {r.publish_display && <span className="text-[12px] text-muted-foreground">发布于 {r.publish_display}</span>}
                </div>
              </div>
            </div>

            {/* 风险信号条:与列表一致,深看再加最近负评时间 */}
            {hasSignals && (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg bg-status-red/[0.05] px-3 py-2.5 dark:bg-status-red/[0.08]">
                <span className="text-[11px] font-semibold text-muted-foreground">风险信号</span>
                {alerts > 0 && (
                  <Tooltip text={r.alert_reasons || '已触发预警规则,建议优先处理'}><span className="inline-flex cursor-help items-center gap-1 rounded bg-status-red/12 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:text-rose-300"><Bell className="h-3 w-3" />预警 {alerts}</span></Tooltip>
                )}
                {negComments > 0 && (
                  <Tooltip text="该内容下被判为负面/风险的评论条数;下方可查看具体评论"><span className="cursor-help rounded bg-status-orange/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">负评 {negComments}</span></Tooltip>
                )}
                {official === 'responded' && (
                  <span className="inline-flex items-center gap-1 rounded bg-status-green/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"><CheckCircle className="h-3 w-3" />已官方回复</span>
                )}
                {official === 'needs_followup' && (
                  <span className="rounded bg-status-amber/20 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">需跟进</span>
                )}
                {r.latest_negative_comment_at && (
                  <span className="ml-auto text-[11px] text-muted-foreground">最近负评 {formatDate(r.latest_negative_comment_at)}</span>
                )}
              </div>
            )}

            {/* 互动指标:无框,标签—数值靠留白排开(Asana 式)*/}
            <div className="mt-4 grid grid-cols-4">
              <Metric icon={Heart} label="点赞" value={r.likes} />
              <Metric icon={MessageCircle} label="评论" value={r.comments_count} />
              <Metric icon={Star} label="收藏" value={r.collects} />
              <Metric icon={Share2} label="转发" value={r.shares} />
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border/50 px-6">
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
                    {hasVideo(r) && <TranscriptSection record={r} canWrite={canWrite} />}
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
                        <div key={i} className={cn('rounded-xl p-4', c.is_negative ? 'bg-status-red/[0.05]' : 'bg-muted/50')}>
                          <div className="mb-1.5 flex items-center gap-2">
                            <span className="text-sm font-semibold">{c.author_name || '未知评论者'}</span>
                            <span className="text-xs text-muted-foreground">{c.publish_display || '—'}</span>
                            {c.is_official && <StatusBadge tone="positive">官方回复</StatusBadge>}
                            {commentClassifier(c) === 'llm_comment' && <StatusBadge tone="neutral">AI</StatusBadge>}
                            <StatusBadge tone={c.is_negative ? 'negative' : (c.sentiment || 'muted')}>
                              {c.is_negative ? `负面 · ${c.risk_level || 'low'}` : (LABELS.sentiment[c.sentiment] || '中性')}
                            </StatusBadge>
                          </div>
                          <p className="text-sm">{c.content}</p>
                          {c.ai_summary && (
                            <div className="mt-2 rounded-md bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
                              {c.ai_summary}
                            </div>
                          )}
                          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                            <span>{formatNumber(c.like_count)} 赞{c.ip_location ? ` · IP ${c.ip_location}` : ''}</span>
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
                          <div key={i} className="rounded-xl bg-status-green/[0.07] p-4">
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
                      <InfoTile label="首次发现" value={formatFullDateSec(r.first_seen_at)} />
                      <InfoTile label="最近采集" value={formatFullDateSec(r.last_seen_at || r.created_at)} />
                      <InfoTile label="采集次数" value={`${formatNumber(r.seen_count)} 次`} />
                    </div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">快照历史</h4>
                    {observations.length === 0 ? (
                      <EmptyState icon={Camera} title="暂无采集快照" />
                    ) : (
                      <div className="space-y-2">
                        {observations.slice(0, 10).map((o: any, i: number) => (
                          <div key={i} className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
                            <div className="flex items-center gap-3 text-sm tabular-nums">
                              <span className="flex items-center gap-1"><Heart className="h-3 w-3 text-muted-foreground" />{formatNumber(o.likes)}</span>
                              <span className="flex items-center gap-1"><MessageCircle className="h-3 w-3 text-muted-foreground" />{formatNumber(o.comments_count)}</span>
                              <span className="flex items-center gap-1"><Star className="h-3 w-3 text-muted-foreground" />{formatNumber(o.collects)}</span>
                              <span className="flex items-center gap-1"><Share2 className="h-3 w-3 text-muted-foreground" />{formatNumber(o.shares)}</span>
                            </div>
                            <span className="text-xs text-muted-foreground">{formatFullDateSec(o.captured_at)}</span>
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

        {/* 处理留痕:状态 / 处理人 / 时间 / 备注 */}
        {(r.triage_note || r.triage_owner_name) && (
          <div className="border-t border-border/50 bg-muted/30 px-6 py-3 text-[12px]">
            <div className="font-semibold text-muted-foreground">处理留痕</div>
            <div className="mt-1 space-y-0.5 text-muted-foreground">
              <div>
                状态：{LABELS.triage[r.triage_status] || r.triage_status || '未处理'}
                {r.triage_owner_name && <span> · 处理人：{r.triage_owner_name}</span>}
                {r.triage_updated_at && <span> · {formatDate(r.triage_updated_at)}</span>}
              </div>
              {r.triage_note && <div className="text-foreground/80">备注：{r.triage_note}</div>}
            </div>
          </div>
        )}

        {/* Footer actions */}
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-6 py-4">
            {onMarkResponded && <Button variant="outline" size="sm" onClick={onMarkResponded}><CheckCircle className="h-3.5 w-3.5" />标为已响应</Button>}
            {onSetStatus && <Button variant="outline" size="sm" onClick={() => onSetStatus('reviewing')}><Eye className="h-3.5 w-3.5" />待复核</Button>}
            {onSetStatus && <Button variant="outline" size="sm" onClick={() => onSetStatus('archived')}><Archive className="h-3.5 w-3.5" />归档</Button>}
            <Button className="ml-auto" onClick={onLinkIssue}><LinkIcon className="h-4 w-4" />转工单</Button>
          </div>
        )}
      </div>
    </div>
  )
}

function Metric({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: any }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-1 text-[10.5px] font-medium text-muted-foreground"><Icon className="h-3 w-3" strokeWidth={2} />{label}</div>
      <div className="mt-0.5 text-[15px] font-bold tabular-nums">{formatNumber(value)}</div>
    </div>
  )
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-border/40 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold">{value || '-'}</div>
    </div>
  )
}

export function getCover(r: any): string {
  if (r.cover_local) return r.cover_local
  if (r.cover_url) return r.cover_url
  try {
    const imgs = JSON.parse(r.image_urls || '[]')
    if (imgs.length) return typeof imgs[0] === 'string' ? imgs[0] : (imgs[0]?.url || '')
  } catch {}
  return ''
}

export function getImages(r: any): string[] {
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

function commentClassifier(comment: any): string {
  const aiResult = comment?.ai_result
  if (!aiResult) return ''
  if (typeof aiResult === 'object') return aiResult.classifier || ''
  try {
    return JSON.parse(aiResult)?.classifier || ''
  } catch {
    return ''
  }
}

function hasVideo(r: any): boolean {
  return Boolean(r?.video_url) || r?.note_type === 'video'
}

const TRANSCRIPT_TERMINAL = ['done', 'failed', 'expired', 'no_media']

/**
 * 视频逐字稿:用阿里云百炼把视频口播转成文字,补"视频内容盲区"。
 * 转写异步(后台提交+轮询),这里点击触发后轮询 GET /records/:id/transcript。
 */
function TranscriptSection({ record, canWrite }: { record: any; canWrite: boolean }) {
  const [status, setStatus] = useState<string>(record.transcript_status || 'none')
  const [text, setText] = useState<string>(record.transcript || '')
  const [error, setError] = useState<string>(record.transcript_error || '')
  const [busy, setBusy] = useState(false)
  const [analysis, setAnalysis] = useState<any>(record.transcript_analysis || null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeError, setAnalyzeError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }

  const startPoll = () => {
    stopPoll()
    pollRef.current = setInterval(async () => {
      try {
        const d: any = await api.get(`/records/${record.id}/transcript`)
        setStatus(d.transcript_status || 'none')
        setText(d.transcript || '')
        setError(d.transcript_error || '')
        if (TRANSCRIPT_TERMINAL.includes(d.transcript_status)) { stopPoll(); setBusy(false) }
      } catch { /* 单次轮询失败,下个周期再试 */ }
    }, 3500)
  }

  // 打开抽屉时主动从库里拉最新逐字稿 + AI 分析(列表行快照可能不含这些字段);在转写中则接着轮询
  useEffect(() => {
    let cancelled = false
    api.get(`/records/${record.id}/transcript`).then((d: any) => {
      if (cancelled) return
      setStatus(d.transcript_status || 'none')
      setText(d.transcript || '')
      setError(d.transcript_error || '')
      setAnalysis(d.transcript_analysis || null)
      if (d.transcript_status === 'pending' || d.transcript_status === 'processing') { setBusy(true); startPoll() }
    }).catch(() => { /* 拉取失败保持快照初值 */ })
    return () => { cancelled = true; stopPoll() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const generate = async () => {
    setBusy(true); setError('')
    try {
      const d: any = await api.post(`/records/${record.id}/transcribe`, {})
      setStatus(d.status || 'pending')
      if (d.status === 'no_media') { setBusy(false); return }
      startPoll()
    } catch (e: any) {
      setStatus('failed'); setError(e?.message || '触发失败'); setBusy(false)
    }
  }

  const analyze = async () => {
    setAnalyzing(true); setAnalyzeError('')
    try {
      const d: any = await api.post(`/records/${record.id}/analyze-transcript`, {})
      setAnalysis(d.analysis || null)
    } catch (e: any) {
      setAnalyzeError(e?.message || 'AI 分析失败')
    } finally {
      setAnalyzing(false)
    }
  }

  const inProgress = status === 'pending' || status === 'processing'
  const hasTranscript = status === 'done' && !!text

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">视频逐字稿</h4>
        {canWrite && !inProgress && (
          <button onClick={generate} disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-primary transition hover:bg-accent disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            {status === 'done' ? '重新生成' : '生成逐字稿'}
          </button>
        )}
      </div>
      {inProgress ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在转写中,约需数十秒…</p>
      ) : status === 'done' && text ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
      ) : status === 'done' ? (
        <p className="text-sm text-muted-foreground">转写完成但无文本(可能无人声/纯音乐)。</p>
      ) : status === 'expired' ? (
        <p className="text-sm text-amber-600 dark:text-amber-400">视频直链已过期,需重新采集后再转写。</p>
      ) : status === 'no_media' ? (
        <p className="text-sm text-muted-foreground">该内容无可转写的视频。</p>
      ) : status === 'failed' ? (
        <p className="text-sm text-rose-600 dark:text-rose-400">转写失败{error ? `:${error}` : ''}</p>
      ) : (
        <p className="text-sm text-muted-foreground">尚未生成。点「生成逐字稿」用 AI 提取视频口播文本。</p>
      )}

      {hasTranscript && (
        <div className="mt-4 rounded-lg border border-border/60 bg-muted/30 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">AI 舆情分析</h4>
            {canWrite && (
              <button onClick={analyze} disabled={analyzing}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-primary transition hover:bg-accent disabled:opacity-50">
                {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {analysis ? '重新分析' : 'AI 分析'}
              </button>
            )}
          </div>
          {analyzing ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在分析口播内容…</p>
          ) : analyzeError ? (
            <p className="text-sm text-rose-600 dark:text-rose-400">{analyzeError}</p>
          ) : analysis ? (
            <TranscriptInsights data={analysis} />
          ) : (
            <p className="text-sm text-muted-foreground">点「AI 分析」基于逐字稿提取核心观点 / 情绪 / 槽点 / 品牌风险 / 用户诉求。</p>
          )}
        </div>
      )}
    </div>
  )
}

function TranscriptInsights({ data }: { data: any }) {
  const stance = String(data?.stance || '').toLowerCase()
  const stanceTone = stance === 'positive' ? 'positive' : stance === 'negative' ? 'negative' : 'neutral'
  const stanceLabel = stance === 'positive' ? '正面' : stance === 'negative' ? '负面' : '中性'
  const toList = (v: any): string[] => Array.isArray(v) ? v.filter(Boolean).map(String) : (v ? [String(v)] : [])
  const keyPoints = toList(data?.keyPoints)
  const issues = toList(data?.issues)
  const userNeeds = toList(data?.userNeeds)
  return (
    <div className="space-y-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={stanceTone}>{stanceLabel}</StatusBadge>
        {data?.summary && <span>{String(data.summary)}</span>}
      </div>
      {keyPoints.length > 0 && <InsightList label="核心观点" items={keyPoints} />}
      {issues.length > 0 && <InsightList label="涉及槽点" items={issues} warn />}
      {data?.risk && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">品牌风险</div>
          <p className="mt-0.5 leading-relaxed">{String(data.risk)}</p>
        </div>
      )}
      {userNeeds.length > 0 && <InsightList label="用户诉求" items={userNeeds} />}
    </div>
  )
}

function InsightList({ label, items, warn }: { label: string; items: string[]; warn?: boolean }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
        {items.map((it, i) => (
          <li key={i} className={warn ? 'text-amber-700 dark:text-amber-300' : ''}>{it}</li>
        ))}
      </ul>
    </div>
  )
}
