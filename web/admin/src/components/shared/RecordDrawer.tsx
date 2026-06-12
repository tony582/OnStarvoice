import { useEffect, useState } from 'react'
import {
  LinkIcon, CheckCircle, Loader2, X, Heart, MessageCircle, Star, Share2,
  ExternalLink, User, FileText, Camera,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, formatFullDate, LABELS, platformName, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'

/**
 * 舆情内容详情抽屉(帖子/评论/官方响应/采集快照 四 tab)。
 * 纯展示 + 回调:抽屉持有的是列表行快照,所有写操作由调用方持有,成功后由调用方
 * reload 列表并关闭抽屉(无单条 GET 端点可回灌)。从舆情收件箱提取以供多队列复用。
 */
export function RecordDrawer({ record: r, onClose, canWrite, onLinkIssue }: { record: any; onClose: () => void; canWrite: boolean; onLinkIssue: () => void }) {
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
      <div className="absolute inset-0 bg-black/35" />

      {/* Drawer */}
      <div className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-lg animate-in slide-in-from-right duration-200"
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
                <div className="h-28 w-28 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
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

export function getCover(r: any): string {
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
