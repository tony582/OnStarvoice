import { useEffect, useState, useCallback } from 'react'
import {
  Inbox, Search, ChevronLeft, ChevronRight, MoreHorizontal, LinkIcon,
  CheckCircle, Eye, Archive, Ban, Loader2, Bookmark, Link2, CircleCheck,
  Package, User, ScanSearch, FileText, Bell,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, LABELS, platformName, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { RecordDrawer, getCover } from '@/components/shared/RecordDrawer'
import { WorkbenchSelect } from '@/components/shared/Workbench'
import { BatchBar, Checkbox, useSelection } from '@/components/shared/BatchBar'
import { TriageBoard } from '@/pages/workbench/TriageBoard'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'
import { Rows3, Kanban } from 'lucide-react'

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
  const [view, setView] = useState<'list' | 'board'>('list')
  const [boardNonce, setBoardNonce] = useState(0)
  const [status, setStatus] = useState(initial?.status ?? '')
  const [sentiment, setSentiment] = useState(initial?.sentiment ?? '')
  const [platform, setPlatform] = useState(initial?.platform ?? '')
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
      const params = new URLSearchParams({ page: String(page), pageSize: '30', status, queue: status ? '' : 'active', sentiment, platform, keyword })
      const data = await api.get<any>('/triage/records?' + params)
      setRecords(data.records || [])
      setPagination(data.pagination || null)
    } catch (err) { console.error(err) }
    finally { setLoading(false) }
  }, [status, sentiment, platform, keyword])

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
    <div className="space-y-4">
      {/* 工具条:状态分段 + 视图切换 + 筛选,收成一个紧凑块(笔记本上少占两层)*/}
      <div className="space-y-2.5 border-b border-border pb-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {view === 'list' ? (
            <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
              {STATUS_TABS.map(tab => {
                const Icon = tab.icon
                const on = status === tab.value
                return (
                  <button key={tab.value} onClick={() => setStatus(tab.value)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition-colors',
                      on ? 'bg-primary text-white shadow-xs' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}>
                    <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                    {tab.label}
                  </button>
                )
              })}
            </div>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Kanban className="h-3.5 w-3.5" />拖动卡片即可改变处置状态
            </span>
          )}
          <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5">
            {([['list', '列表', Rows3], ['board', '看板', Kanban]] as const).map(([v, label, Icon]) => (
              <button key={v} onClick={() => setView(v)}
                className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors',
                  view === v ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground')}>
                <Icon className="h-3.5 w-3.5" />{label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)}>
            <option value="">全部平台</option>
            <option value="xiaohongshu">小红书</option>
            <option value="douyin">抖音</option>
            <option value="weibo">微博</option>
          </WorkbenchSelect>
          <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5">
            {['', 'negative', 'neutral', 'positive'].map(v => (
              <button key={v} onClick={() => setSentiment(v)}
                className={cn('rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors',
                  sentiment === v ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground')}>
                {v === '' ? '全部情感' : v === 'negative' ? '负面' : v === 'neutral' ? '中性' : '正面'}
              </button>
            ))}
          </div>
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={keyword} onChange={e => setKeyword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { load(); setBoardNonce(n => n + 1) } }} placeholder="搜索标题、正文、关键词…" className="h-8 pl-8 text-[12px]" />
          </div>
        </div>
      </div>

      {/* Board view */}
      {view === 'board' ? (
        <TriageBoard
          sentiment={sentiment}
          platform={platform}
          keyword={keyword}
          reloadKey={`${sentiment}|${platform}|${boardNonce}`}
          canWrite={canWrite()}
          onOpen={setDrawerRecord}
          refreshBadges={refreshBadges}
        />
      ) : loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : records.length === 0 ? (
        <EmptyState icon={Inbox} title="暂无记录" description="调整筛选条件试试" />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/70">
                {canWrite() && (
                  <th className="w-9 py-2.5 pl-4 pr-1">
                    <Checkbox checked={allChecked} indeterminate={!allChecked && someChecked} onChange={() => sel.setAll(records.map(r => r.id), !allChecked)} />
                  </th>
                )}
                <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">内容</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">平台</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">情感</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">处置状态</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">风险信号</th>
                <th className="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">互动</th>
                <th className="hidden px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground lg:table-cell">最近</th>
                {canWrite() && <th className="px-3 py-2.5 pr-4 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">操作</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/55">
              {records.map(r => (
                <RecordRow
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
            </tbody>
          </table>

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

      {/* Record detail drawer */}
      {drawerRecord && (
        <RecordDrawer
          record={drawerRecord}
          onClose={() => setDrawerRecord(null)}
          canWrite={canWrite()}
          onLinkIssue={() => { linkIssue(drawerRecord.id); setDrawerRecord(null) }}
          onSetStatus={s => { updateTriage(drawerRecord.id, s); setDrawerRecord(null) }}
          onMarkResponded={() => { markResponded(drawerRecord.id); setDrawerRecord(null) }}
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

/* ==================== Record Row(列表行)==================== */
function RecordRow({ record: r, canWrite, selected, onToggle, openMenu, setOpenMenu, onLinkIssue, onUpdateTriage, onMarkResponded, onOpenDetail, interactions }: any) {
  const cover = getCover(r)
  const sentimentBar = r.sentiment === 'negative' ? 'bg-status-red' : r.sentiment === 'positive' ? 'bg-status-green' : 'bg-status-blue'
  const tone = r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'

  return (
    <tr className={cn('group cursor-pointer transition-colors hover:bg-accent/45', selected && 'bg-primary/[0.05]')} onClick={onOpenDetail}>
      {canWrite && (
        <td className="py-2.5 pl-4 pr-1 align-middle" onClick={e => e.stopPropagation()}>
          <Checkbox checked={selected} onChange={onToggle} />
        </td>
      )}
      <td className="px-3 py-2.5 align-middle">
        <div className="flex items-center gap-3">
          <span className={cn('h-10 w-1 shrink-0 rounded-full', sentimentBar)} />
          {cover ? (
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-xl border border-border/70 bg-muted">
              <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
            </div>
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-border bg-muted/40"><FileText className="h-4 w-4 text-muted-foreground/40" /></div>
          )}
          <div className="min-w-0 max-w-[380px]">
            <div className="truncate text-[13px] font-medium leading-tight">{r.title || r.content || '(无标题)'}</div>
            <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
              <User className="h-2.5 w-2.5 shrink-0" />{r.author_name || '未知'}
              {r.category && <span className="truncate">· {LABELS.category[r.category] || r.category}</span>}
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5 align-middle"><StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge></td>
      <td className="px-3 py-2.5 align-middle"><StatusBadge tone={tone}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge></td>
      <td className="px-3 py-2.5 align-middle"><StatusBadge tone={r.triage_status}>{LABELS.triage[r.triage_status] || r.triage_status}</StatusBadge></td>
      <td className="px-3 py-2.5 align-middle"><RiskSignals record={r} /></td>
      <td className="px-3 py-2.5 text-right align-middle text-[12px] font-semibold tabular-nums">{formatNumber(interactions)}</td>
      <td className="hidden whitespace-nowrap px-3 py-2.5 align-middle text-[11px] text-muted-foreground lg:table-cell">{formatDate(r.last_seen_at || r.created_at)}</td>
      {canWrite && (
        <td className="px-3 py-2.5 pr-4 align-middle" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-1">
            <Button size="sm" onClick={onLinkIssue}><LinkIcon className="h-3.5 w-3.5" />转问题</Button>
            <div className="action-dropdown relative">
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setOpenMenu(openMenu === r.id ? null : r.id)}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
              {openMenu === r.id && (
                <div className="absolute right-0 top-full z-30 mt-1 w-40 animate-in fade-in slide-in-from-top-1 rounded-lg border border-border bg-card p-1 shadow-lg duration-150">
                  <MenuBtn icon={CheckCircle} label="标为已响应" onClick={onMarkResponded} />
                  <MenuBtn icon={Eye} label="待复核" onClick={() => onUpdateTriage('reviewing')} />
                  <MenuBtn icon={Archive} label="归档" onClick={() => onUpdateTriage('archived')} />
                  <MenuBtn icon={Ban} label="误报" onClick={() => onUpdateTriage('false_positive')} />
                </div>
              )}
            </div>
          </div>
        </td>
      )}
    </tr>
  )
}

function MenuBtn({ icon: Icon, label, onClick }: { icon: React.ElementType; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
      <Icon className="h-4 w-4" />{label}
    </button>
  )
}

/* 风险信号:预警 / 负面评论数 / 官方回复状态,一眼可扫 */
function RiskSignals({ record: r }: any) {
  const alerts = Number(r.alert_count || 0)
  const neg = Number(r.negative_comment_count || 0)
  const official = r.official_response_status
  if (!(alerts > 0 || neg > 0 || (official && official !== 'none'))) {
    return <span className="text-[11px] text-muted-foreground/40">—</span>
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {alerts > 0 && (
        <span className="inline-flex items-center gap-0.5 rounded bg-status-red/12 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-300"><Bell className="h-2.5 w-2.5" />预警{alerts}</span>
      )}
      {neg > 0 && (
        <span className="rounded bg-status-orange/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">负评{neg}</span>
      )}
      {official === 'responded' && (
        <span className="rounded bg-status-green/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">已回复</span>
      )}
      {official === 'needs_followup' && (
        <span className="rounded bg-status-amber/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">需跟进</span>
      )}
    </div>
  )
}
