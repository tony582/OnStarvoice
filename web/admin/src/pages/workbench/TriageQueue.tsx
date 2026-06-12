import { useEffect, useState, useCallback } from 'react'
import {
  Inbox, Search, ChevronLeft, ChevronRight, MoreHorizontal, LinkIcon,
  CheckCircle, Eye, Archive, Ban, Loader2, Bookmark, Link2, CircleCheck,
  Package, Heart, MessageCircle, Star, Share2, User, Clock, ScanSearch, FileText,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, LABELS, platformName, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { RecordDrawer, getCover } from '@/components/shared/RecordDrawer'
import { BatchBar, Checkbox, useSelection } from '@/components/shared/BatchBar'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'

const STATUS_TABS = [
  { value: '', label: '待处理', icon: Inbox },
  { value: 'unhandled', label: '新线索', icon: Bookmark },
  { value: 'reviewing', label: '待复核', icon: ScanSearch },
  { value: 'issue_linked', label: '已转问题', icon: Link2 },
  { value: 'official_responded', label: '已响应', icon: CircleCheck },
  { value: 'archived', label: '已归档', icon: Package },
]

interface Pagination { page: number; totalPages: number; total: number }

export function TriageQueue({ initial }: { initial?: Record<string, string> }) {
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const [status, setStatus] = useState(initial?.status ?? '')
  const [sentiment, setSentiment] = useState(initial?.sentiment ?? '')
  const [keyword, setKeyword] = useState(initial?.keyword ?? '')
  const [records, setRecords] = useState<any[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [drawerRecord, setDrawerRecord] = useState<any>(null)
  const [batchBusy, setBatchBusy] = useState(false)

  const sel = useSelection(`${status}|${sentiment}|${keyword}|${pagination?.page ?? 1}`)

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

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.action-dropdown')) setOpenMenu(null)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  // 写后统一刷新:回退空页 + 拉列表 + 更新徽标
  const reloadAfterMutation = useCallback(async () => {
    const page = pagination?.page || 1
    const willEmpty = records.length <= 1 && page > 1
    await load(willEmpty ? page - 1 : page)
    refreshBadges()
  }, [load, pagination, records.length, refreshBadges])

  const updateTriage = async (recordId: string, newStatus: string) => {
    await api.patch('/triage/records/' + recordId, { status: newStatus })
    setOpenMenu(null)
    await reloadAfterMutation()
  }

  const markResponded = async (recordId: string) => {
    await api.patch('/records/' + recordId + '/official-response', { status: 'responded' })
    setOpenMenu(null)
    await reloadAfterMutation()
  }

  const linkIssue = async (recordId: string) => {
    const title = prompt('问题标题（简述负面舆情要点）：')
    if (!title) return
    await api.post('/triage/records/' + recordId + '/issues', { title })
    await reloadAfterMutation()
  }

  const runBatch = async (newStatus: string) => {
    if (sel.count === 0) return
    setBatchBusy(true)
    try {
      await api.patch('/triage/records/batch', { ids: [...sel.selected], status: newStatus })
      sel.clear()
      await reloadAfterMutation()
    } catch (err) { console.error(err) }
    finally { setBatchBusy(false) }
  }

  const interactions = (r: any) => Number(r.likes || 0) + Number(r.comments_count || 0) + Number(r.collects || 0) + Number(r.shares || 0)
  const allChecked = records.length > 0 && records.every(r => sel.has(r.id))
  const someChecked = records.some(r => sel.has(r.id))

  return (
    <div className="space-y-5">
      {/* Status tabs */}
      <div className="flex flex-wrap gap-2 border-b border-border pb-4">
        {STATUS_TABS.map(tab => {
          const Icon = tab.icon
          return (
            <button key={tab.value} onClick={() => setStatus(tab.value)}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-4 py-2 text-[13px] font-medium transition-colors duration-200',
                status === tab.value
                  ? 'border-primary bg-primary text-white'
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
        {canWrite() && records.length > 0 && (
          <button onClick={() => sel.setAll(records.map(r => r.id), !allChecked)}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground">
            <Checkbox checked={allChecked} indeterminate={!allChecked && someChecked} onChange={() => sel.setAll(records.map(r => r.id), !allChecked)} />
            全选本页
          </button>
        )}
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
              selected={sel.has(r.id)}
              onToggle={() => sel.toggle(r.id)}
              openMenu={openMenu}
              setOpenMenu={setOpenMenu}
              onLinkIssue={() => linkIssue(r.id)}
              onUpdateTriage={(s: string) => updateTriage(r.id, s)}
              onMarkResponded={() => markResponded(r.id)}
              onOpenDetail={() => setDrawerRecord(r)}
              interactions={interactions(r)}
            />
          ))}

          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-card px-5 py-3">
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

      {/* Batch action bar */}
      {canWrite() && (
        <BatchBar
          count={sel.count}
          busy={batchBusy}
          onClear={sel.clear}
          onAction={key => runBatch(key)}
          actions={[
            { key: 'reviewing', label: '待复核', icon: Eye },
            { key: 'archived', label: '归档', icon: Archive },
            { key: 'false_positive', label: '误报', icon: Ban, tone: 'danger' },
          ]}
        />
      )}
    </div>
  )
}

/* ==================== Record Card ==================== */
function RecordCard({ record: r, canWrite, selected, onToggle, openMenu, setOpenMenu, onLinkIssue, onUpdateTriage, onMarkResponded, onOpenDetail }: any) {
  const cover = getCover(r)
  const sentimentColor = r.sentiment === 'negative' ? 'border-l-red-500' : r.sentiment === 'positive' ? 'border-l-emerald-500' : 'border-l-blue-400'

  return (
    <div className={cn('group relative overflow-hidden rounded-lg border bg-card transition-colors duration-200 border-l-[3px]',
      selected ? 'border-primary/50 ring-1 ring-primary/30' : 'border-border hover:border-input', sentimentColor)}
      onClick={onOpenDetail} role="button" tabIndex={0}>
      <div className="flex gap-4 p-4">
        {/* Selection checkbox */}
        {canWrite && (
          <div className="flex items-start pt-0.5" onClick={e => e.stopPropagation()}>
            <Checkbox checked={selected} onChange={onToggle} />
          </div>
        )}

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
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge>
            <StatusBadge tone={r.sentiment || 'muted'}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge>
            {r.category && <StatusBadge tone="neutral">{LABELS.category[r.category] || r.category}</StatusBadge>}
            <StatusBadge tone={r.triage_status}>{LABELS.triage[r.triage_status] || r.triage_status}</StatusBadge>
          </div>

          <h3 className="mb-1 truncate text-sm font-bold leading-snug">{r.title || '(无标题)'}</h3>
          <p className="mb-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{r.content || r.ai_summary || ''}</p>

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
                <div className="absolute right-0 top-full z-20 mt-1 w-44 animate-in fade-in slide-in-from-top-1 rounded-lg border border-border bg-card p-1 shadow-sm duration-150">
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

      <div className="pointer-events-none absolute inset-0 rounded-lg border border-primary/0 transition-colors duration-200 group-hover:border-primary/15" />
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
