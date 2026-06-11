import { useEffect, useState, useCallback } from 'react'
import { Inbox, Search, ChevronLeft, ChevronRight, MoreHorizontal, LinkIcon, CheckCircle, Eye, Archive, Ban, Loader2, ScanSearch, Bookmark, Link2, CircleCheck, Package } from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, compact, LABELS, platformName, cn } from '@/lib/utils'
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

interface Pagination {
  page: number
  totalPages: number
  total: number
}

export function TriagePage() {
  const { canWrite } = useAuth()
  const [status, setStatus] = useState('')
  const [sentiment, setSentiment] = useState('')
  const [keyword, setKeyword] = useState('')
  const [records, setRecords] = useState<any[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  const load = useCallback(async (page = 1) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '30',
        status,
        queue: status ? '' : 'active',
        sentiment,
        keyword,
      })
      const data = await api.get<any>('/triage/records?' + params)
      setRecords(data.records || [])
      setPagination(data.pagination || null)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [status, sentiment, keyword])

  useEffect(() => { load() }, [load])

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

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      {/* Status tabs */}
      <div className="flex flex-wrap gap-2 border-b border-border pb-4">
        {STATUS_TABS.map(tab => {
          const Icon = tab.icon
          return (
            <button
              key={tab.value}
              onClick={() => setStatus(tab.value)}
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-semibold transition-all duration-200',
                status === tab.value
                  ? 'border-primary bg-primary text-white shadow-sm'
                  : 'border-border bg-card text-muted-foreground hover:border-primary hover:text-primary'
              )}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={2} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={sentiment}
          onChange={e => setSentiment(e.target.value)}
          className="h-9 rounded-lg border border-input bg-card px-3 text-sm"
        >
          <option value="">全部情感</option>
          <option value="negative">负面</option>
          <option value="neutral">中性</option>
          <option value="positive">正面</option>
        </select>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && load()}
            placeholder="搜索标题、正文、关键词…"
            className="w-72 pl-9"
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : records.length === 0 ? (
        <EmptyState icon={Inbox} title="暂无记录" description="调整筛选条件试试" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">内容</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">作者</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">AI判断</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">互动</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">状态</th>
                  {canWrite() && <th className="px-4 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground">操作</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {records.map(r => (
                  <tr key={r.id} className="transition-colors hover:bg-muted/30">
                    {/* Content cell */}
                    <td className="max-w-sm px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Thumb record={r} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge>
                            <span className="text-xs text-muted-foreground">{formatDate(r.last_seen_at || r.created_at)}</span>
                          </div>
                          <div className="mt-1 truncate font-medium">{r.title || '(无标题)'}</div>
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">{compact(r.content || r.ai_summary || '', 80)}</div>
                        </div>
                      </div>
                    </td>
                    {/* Author */}
                    <td className="whitespace-nowrap px-4 py-3 text-sm">{r.author_name || '-'}</td>
                    {/* AI */}
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <StatusBadge tone={r.sentiment || 'muted'}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge>
                        <StatusBadge tone={r.category ? 'neutral' : 'muted'}>{LABELS.category[r.category] || '待分类'}</StatusBadge>
                      </div>
                    </td>
                    {/* Interactions */}
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-sm">
                      {formatNumber(r.likes)}/{formatNumber(r.comments_count)}/{formatNumber(r.collects)}/{formatNumber(r.shares)}
                    </td>
                    {/* Status */}
                    <td className="px-4 py-3">
                      <StatusBadge tone={r.triage_status}>
                        {LABELS.triage[r.triage_status] || r.triage_status}
                      </StatusBadge>
                    </td>
                    {/* Actions */}
                    {canWrite() && (
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" onClick={() => linkIssue(r.id)}>
                            <LinkIcon className="h-3.5 w-3.5" />
                            转问题
                          </Button>
                          <div className="relative">
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => setOpenMenu(openMenu === r.id ? null : r.id)}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                            {openMenu === r.id && (
                              <div className="absolute right-0 top-full z-20 mt-1 w-44 animate-in fade-in slide-in-from-top-1 rounded-lg border border-border bg-card p-1 shadow-lg duration-150">
                                <MenuButton icon={CheckCircle} label="标为已响应" onClick={() => markResponded(r.id)} />
                                <MenuButton icon={Eye} label="待复核" onClick={() => updateTriage(r.id, 'reviewing')} />
                                <MenuButton icon={Archive} label="归档" onClick={() => updateTriage(r.id, 'archived')} />
                                <MenuButton icon={Ban} label="误报" onClick={() => updateTriage(r.id, 'false_positive')} />
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-4 py-3">
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
    </div>
  )
}

function Thumb({ record: r }: { record: any }) {
  let cover = r.cover_url || ''
  if (!cover) {
    try {
      const imgs = JSON.parse(r.image_urls || '[]')
      if (imgs.length) cover = typeof imgs[0] === 'string' ? imgs[0] : (imgs[0]?.url || '')
    } catch {}
  }

  if (cover && /^https?:\/\//i.test(cover)) {
    return (
      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
        <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
      </div>
    )
  }

  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-dashed border-border bg-muted text-xs font-bold text-muted-foreground">
      {platformName(r.platform).slice(0, 1)}
    </div>
  )
}

function MenuButton({ icon: Icon, label, onClick }: { icon: React.ElementType; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  )
}
