import { useEffect, useState, useCallback } from 'react'
import {
  Inbox, Search, ChevronLeft, ChevronRight, MoreHorizontal, LinkIcon,
  CheckCircle, Archive, Ban, Loader2,
  Package, User, FileText, Bell, ExternalLink,
  ArrowUp, ArrowDown, ChevronsUpDown, Download, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDateCompact, LABELS, platformName, cn, identityLabel } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { RecordDrawer, getCover } from '@/components/shared/RecordDrawer'
import { WorkbenchSelect } from '@/components/shared/Workbench'
import { KeywordFilter } from '@/components/shared/KeywordFilter'
import { DateRangeFilter, type DateBasis } from '@/components/shared/DateRangeFilter'
import { MultiSelect } from '@/components/shared/MultiSelect'
import { Tooltip } from '@/components/shared/Tooltip'
import { BatchBar, Checkbox, useSelection } from '@/components/shared/BatchBar'
import { useNotePrompt } from '@/components/shared/NotePrompt'
import { useTicketDispatch } from '@/components/shared/TicketDispatch'
import { TriageBoard } from '@/pages/workbench/TriageBoard'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'
import { Rows3, Kanban } from 'lucide-react'

const STATUS_TABS = [
  { value: '', label: '待处理', icon: Inbox },
  { value: 'archived', label: '已归档', icon: Package },
]

interface Pagination { page: number; totalPages: number; total: number }
type SortField = 'publish' | 'interactions' | 'first_seen' | 'last_seen'
const RISK_OPTIONS = [{ value: 'alert', label: '有预警' }, { value: 'negative', label: '有负评' }]
const IDENTITY_OPTIONS = [{ value: 'user', label: '用户' }, { value: 'kol', label: 'KOL / KOC' }, { value: 'dealer', label: '4S店' }, { value: 'koe', label: 'KOE' }, { value: 'other', label: '其他' }]

export function TriageQueue({ initial }: { initial?: Record<string, string> }) {
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const [view, setView] = useState<'list' | 'board'>('list')
  const [boardNonce, setBoardNonce] = useState(0)
  const [status, setStatus] = useState(initial?.status ?? '')
  const [sentiment, setSentiment] = useState(initial?.sentiment ?? '')
  const [platform, setPlatform] = useState(initial?.platform ?? '')
  const [keyword, setKeyword] = useState(initial?.keyword ?? '')
  const [triageStatus, setTriageStatus] = useState('')
  const [risk, setRisk] = useState<string[]>([])
  const [identity, setIdentity] = useState<string[]>([])
  const [captureKeywords, setCaptureKeywords] = useState<string[]>([])
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateBasis, setDateBasis] = useState<DateBasis>('publish')
  const [exporting, setExporting] = useState(false)
  // 默认按发布时间倒序(最新在前);表头可点切换发布时间/互动量/首次发现/最近采集、升降序
  const [sort, setSort] = useState<{ field: SortField; dir: 'asc' | 'desc' }>({ field: 'publish', dir: 'desc' })
  const [records, setRecords] = useState<any[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [drawerRecord, setDrawerRecord] = useState<any>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const { ask, dialog } = useNotePrompt()
  const { dispatch, dialog: dispatchDialog } = useTicketDispatch()

  const sel = useSelection(`${status}|${triageStatus}|${risk}|${identity}|${platform}|${sentiment}|${keyword}|${pagination?.page ?? 1}`)

  const filterParams = useCallback(() => {
    const params = new URLSearchParams({ sentiment, platform, keyword })
    if (status === 'archived') params.set('bucket', 'archived')
    else params.set('queue', 'active')
    if (triageStatus) params.set('status', triageStatus)
    risk.forEach(rk => params.append('risk', rk))
    identity.forEach(id => params.append('identity', id))
    params.set('sort', sort.field)
    params.set('dir', sort.dir)
    captureKeywords.forEach(k => params.append('captureKeyword', k))
    if (dateFrom) params.set('dateFrom', dateFrom)
    if (dateTo) params.set('dateTo', dateTo)
    if (dateFrom || dateTo) params.set('dateBasis', dateBasis)
    return params
  }, [status, triageStatus, risk, identity, sentiment, platform, keyword, sort, captureKeywords, dateFrom, dateTo, dateBasis])

  const load = useCallback(async (page = 1) => {
    setLoading(true)
    try {
      const params = filterParams()
      params.set('page', String(page))
      params.set('pageSize', '30')
      const data = await api.get<any>('/triage/records?' + params)
      setRecords(data.records || [])
      setPagination(data.pagination || null)
    } catch (err) { console.error(err) }
    finally { setLoading(false) }
  }, [filterParams])

  const exportXlsx = async () => {
    setExporting(true)
    try { await api.download('/triage/records/export?' + filterParams().toString(), '内容分诊.xlsx') }
    catch (err) { console.error(err) }
    finally { setExporting(false) }
  }

  // 点表头排序:点未激活列 → 该列降序;再点已激活列 → 升/降序切换
  const toggleSort = (field: SortField) =>
    setSort(s => s.field === field ? { field, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { field, dir: 'desc' })

  // 筛选是否有激活项(用于显示「清空筛选」);清空只重置筛选与排序,保留 tab
  const hasActiveFilters = Boolean(platform || sentiment || keyword || triageStatus || risk.length || identity.length || captureKeywords.length || dateFrom || dateTo)
  const clearFilters = () => {
    setPlatform(''); setSentiment(''); setKeyword(''); setTriageStatus(''); setRisk([]); setIdentity([]); setCaptureKeywords([]); setDateFrom(''); setDateTo('')
    setSort({ field: 'publish', dir: 'desc' })
  }

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

  const updateTriage = async (recordId: string, newStatus: string, opts?: { note?: string }) => {
    let note = opts?.note
    if (note === undefined) {
      const input = await ask({ title: '内容处理备注', placeholder: '例如：已官方回复 / 已上报 / 误报无需处理' })
      if (input === null) { setOpenMenu(null); return } // 取消则不处理，避免误点即消失
      note = input
    }
    await api.patch('/triage/records/' + recordId, { status: newStatus, note })
    setOpenMenu(null)
    await reloadAfterMutation()
  }

  const markResponded = async (recordId: string) => {
    await api.patch('/records/' + recordId + '/official-response', { status: 'responded' })
    setOpenMenu(null)
    await reloadAfterMutation()
  }

  const dispatchTicket = async (record: any) => {
    const r = await dispatch({ summary: record.title || record.content, defaultPriority: record.triage_priority })
    if (!r) return
    await api.post('/tickets', { sourceType: 'content', sourceId: record.id, priority: r.priority, assigneeUserId: r.assigneeUserId, assigneeName: r.assigneeName, note: r.note })
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
  // 处置状态筛选项随 tab 自适应:待处理队列只有未处理/待复核,已归档桶有归档/误报/已响应
  const triageStatusOptions: Array<[string, string]> = status === 'archived'
    ? [['', '全部状态'], ['archived', '已归档'], ['false_positive', '误报'], ['official_responded', '官方已响应']]
    : [['', '全部状态'], ['unhandled', '未处理'], ['reviewing', '待复核']]

  const narrow = false
  const drawerProps = drawerRecord ? {
    record: drawerRecord,
    onClose: () => setDrawerRecord(null),
    canWrite: canWrite(),
    onLinkIssue: () => { dispatchTicket(drawerRecord); setDrawerRecord(null) },
    onSetStatus: (s: string) => { updateTriage(drawerRecord.id, s); setDrawerRecord(null) },
    onMarkResponded: () => { markResponded(drawerRecord.id); setDrawerRecord(null) },
  } : null

  return (
    <div className="space-y-3">
      {/* 工具条:无边框,靠留白与柔色高亮分隔(Asana 式)*/}
      <div className="space-y-2 border-b border-border/50 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {view === 'list' ? (
            <div className="inline-flex flex-wrap items-center gap-0.5">
              {STATUS_TABS.map(tab => {
                const Icon = tab.icon
                const on = status === tab.value
                return (
                  <button key={tab.value} onClick={() => { setStatus(tab.value); setTriageStatus('') }}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-semibold transition-colors',
                      on ? 'bg-accent text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
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
          <div className="inline-flex items-center gap-0.5">
            {([['list', '列表', Rows3], ['board', '看板', Kanban]] as const).map(([v, label, Icon]) => (
              <button key={v} onClick={() => setView(v)}
                className={cn('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors',
                  view === v ? 'bg-accent text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                <Icon className="h-3.5 w-3.5" />{label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
          <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)}
            className={cn('bg-muted font-medium hover:bg-muted/70', platform ? 'text-foreground' : 'text-muted-foreground')}>
            <option value="">全部平台</option>
            <option value="xiaohongshu">小红书</option>
            <option value="douyin">抖音</option>
            <option value="weibo">微博</option>
          </WorkbenchSelect>
          {view === 'list' && (
            <>
              <WorkbenchSelect value={triageStatus} onChange={e => setTriageStatus(e.target.value)}
                className={cn('bg-muted font-medium hover:bg-muted/70', triageStatus ? 'text-foreground' : 'text-muted-foreground')}>
                {triageStatusOptions.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </WorkbenchSelect>
              <span className="mx-0.5 h-4 w-px bg-border/60" />
              <MultiSelect label="风险" options={RISK_OPTIONS} value={risk} onChange={setRisk} />
              <MultiSelect label="疑似身份" options={IDENTITY_OPTIONS} value={identity} onChange={setIdentity} />
              <KeywordFilter value={captureKeywords} onChange={setCaptureKeywords} />
              <DateRangeFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} basis={dateBasis} onBasisChange={setDateBasis} />
            </>
          )}
          <span className="mx-0.5 h-4 w-px bg-border/60" />
          <div className="inline-flex h-8 items-center rounded-lg bg-muted p-0.5">
            {([['', '全部情感'], ['negative', '负面'], ['neutral', '中性'], ['positive', '正面']] as const).map(([v, label]) => (
              <button key={v} onClick={() => setSentiment(v)}
                className={cn('inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium transition-colors',
                  sentiment === v ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                {label}
              </button>
            ))}
          </div>
          {hasActiveFilters && (
            <button onClick={clearFilters} title="清空所有筛选"
              className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <X className="h-3.5 w-3.5" />清空
            </button>
          )}
          <div className="relative ml-auto w-40 sm:w-52">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={keyword} onChange={e => setKeyword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { load(); setBoardNonce(n => n + 1) } }} placeholder="搜索标题、正文…" className="h-8 border-transparent bg-muted pl-8 text-[12px] focus:bg-card" />
          </div>
          {view === 'list' && (
            <Button variant="outline" size="sm" onClick={exportXlsx} disabled={exporting} title="导出当前筛选结果为 Excel">
              <Download className={cn('h-3.5 w-3.5', exporting && 'animate-pulse')} />
              {exporting ? '导出中…' : '导出'}
            </Button>
          )}
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
        <div className="overflow-hidden rounded-xl bg-card">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-sm">
            <thead>
              <tr className="border-b border-border/60 [&>th]:whitespace-nowrap [&>th]:py-3">
                {canWrite() && (
                  <th className="w-9 py-3.5 pl-4 pr-1">
                    <Checkbox checked={allChecked} indeterminate={!allChecked && someChecked} onChange={() => sel.setAll(records.map(r => r.id), !allChecked)} />
                  </th>
                )}
                <th className="px-3 py-3.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">内容</th>
                {!narrow && <th className="px-3 py-3.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">平台</th>}
                <th className="px-3 py-3.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">情感</th>
                <th className="px-3 py-3.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">处置状态</th>
                {!narrow && <th className="px-3 py-3.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">风险信号</th>}
                {!narrow && <th className="px-3 py-3.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">疑似身份</th>}
                {!narrow && <SortableTh label="互动" field="interactions" sort={sort} onSort={toggleSort} align="right" />}
                {!narrow && <SortableTh label="发布时间" field="publish" sort={sort} onSort={toggleSort} className="hidden lg:table-cell" />}
                {!narrow && <SortableTh label="首次发现" field="first_seen" sort={sort} onSort={toggleSort} className="hidden xl:table-cell" />}
                {!narrow && <SortableTh label="最近采集" field="last_seen" sort={sort} onSort={toggleSort} className="hidden xl:table-cell" />}
                {!narrow && <th className="hidden whitespace-nowrap px-3 py-3.5 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground xl:table-cell">采集次数</th>}
                {canWrite() && !narrow && <th className="px-3 py-3.5 pr-4 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">操作</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {records.map(r => (
                <RecordRow
                  key={r.id}
                  record={r}
                  canWrite={canWrite()}
                  archived={status === 'archived'}
                  narrow={narrow}
                  open={drawerRecord?.id === r.id}
                  selected={sel.has(r.id)}
                  onToggle={() => sel.toggle(r.id)}
                  openMenu={openMenu}
                  setOpenMenu={setOpenMenu}
                  onLinkIssue={() => dispatchTicket(r)}
                  onUpdateTriage={(s: string) => updateTriage(r.id, s)}
                  onMarkResponded={() => markResponded(r.id)}
                  onOpenDetail={() => setDrawerRecord(r)}
                  interactions={interactions(r)}
                />
              ))}
            </tbody>
          </table>
          </div>

          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-border/50 px-4 py-3">
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

      {/* Batch action bar */}
      {canWrite() && (
        <BatchBar
          count={sel.count}
          busy={batchBusy}
          onClear={sel.clear}
          onAction={key => runBatch(key)}
          actions={[
            { key: 'archived', label: '归档', icon: Archive },
            { key: 'false_positive', label: '误报', icon: Ban, tone: 'danger' },
          ]}
        />
      )}

      {/* 详情:盖式滑出面板(无遮罩,盖在列表右侧,左侧仍可点)*/}
      {drawerProps && <RecordDrawer {...drawerProps} />}
      {dialog}
      {dispatchDialog}
    </div>
  )
}

/* ==================== Record Row(列表行)==================== */
function RecordRow({ record: r, canWrite, archived, narrow, open, selected, onToggle, openMenu, setOpenMenu, onLinkIssue, onUpdateTriage, onMarkResponded, onOpenDetail, interactions }: any) {
  const cover = getCover(r)
  const sentimentBar = r.sentiment === 'negative' ? 'bg-status-red' : r.sentiment === 'positive' ? 'bg-status-green' : 'bg-status-blue'
  const tone = r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'

  return (
    <tr className={cn('group cursor-pointer transition-colors', open ? 'bg-accent' : selected ? 'bg-primary/[0.05]' : 'hover:bg-accent/45')} onClick={onOpenDetail}>
      {canWrite && (
        <td className="py-3.5 pl-4 pr-1 align-middle" onClick={e => e.stopPropagation()}>
          <Checkbox checked={selected} onChange={onToggle} />
        </td>
      )}
      <td className="px-3 py-3.5 align-middle">
        <div className="flex items-center gap-3">
          <span className={cn('h-10 w-1 shrink-0 rounded-full', sentimentBar)} />
          {cover ? (
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-xl border border-border/70 bg-muted">
              <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
            </div>
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-border bg-muted/40"><FileText className="h-4 w-4 text-muted-foreground/40" /></div>
          )}
          <div className="min-w-0 max-w-[300px]">
            <div className="line-clamp-2 text-[13px] font-medium leading-tight">{r.title || r.content || '(无标题)'}</div>
            <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
              <User className="h-2.5 w-2.5 shrink-0" />{r.author_name || '未知'}
              {r.category && <span className="truncate">· {LABELS.category[r.category] || r.category}</span>}
              {r.url && <a href={r.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex shrink-0 items-center gap-0.5 font-medium text-primary hover:underline"><ExternalLink className="h-2.5 w-2.5" />原文</a>}
            </div>
          </div>
        </div>
      </td>
      {!narrow && <td className="px-3 py-3.5 align-middle"><StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge></td>}
      <td className="px-3 py-3.5 align-middle"><StatusBadge tone={tone}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge></td>
      <td className="px-3 py-3.5 align-middle"><StatusBadge tone={r.triage_status}>{LABELS.triage[r.triage_status] || r.triage_status}</StatusBadge></td>
      {!narrow && <td className="px-3 py-3.5 align-middle"><RiskSignals record={r} /></td>}
      {!narrow && <td className="px-3 py-3.5 align-middle"><IdentityBadge sourceType={r.source_type} fans={r.author_fans} name={r.author_name} /></td>}
      {!narrow && <td className="px-3 py-3.5 text-right align-middle text-[12px] font-semibold tabular-nums">{formatNumber(interactions)}</td>}
      {!narrow && <td className="hidden whitespace-nowrap px-3 py-3.5 align-middle text-[11px] text-muted-foreground lg:table-cell">{r.publish_display || '—'}</td>}
      {!narrow && <td className="hidden whitespace-nowrap px-3 py-3.5 align-middle text-[11px] text-muted-foreground xl:table-cell">{formatDateCompact(r.first_seen_at)}</td>}
      {!narrow && <td className="hidden whitespace-nowrap px-3 py-3.5 align-middle text-[11px] text-muted-foreground xl:table-cell">{formatDateCompact(r.last_seen_at)}</td>}
      {!narrow && <td className="hidden px-3 py-3.5 text-right align-middle text-[12px] font-semibold tabular-nums xl:table-cell">{formatNumber(r.seen_count || 1)}</td>}
      {canWrite && !narrow && (
        <td className="px-3 py-3.5 pr-4 align-middle" onClick={e => e.stopPropagation()}>
          {archived ? (
            <div className="text-right text-[11px] text-muted-foreground/60">已归档</div>
          ) : (
            <div className="flex items-center justify-end gap-1">
              <Button size="sm" onClick={onLinkIssue}><LinkIcon className="h-3.5 w-3.5" />转工单</Button>
              <div className="action-dropdown relative">
                <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setOpenMenu(openMenu === r.id ? null : r.id)}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
                {openMenu === r.id && (
                  <div className="absolute right-0 top-full z-30 mt-1 w-40 animate-in fade-in slide-in-from-top-1 rounded-lg border border-border bg-card p-1 shadow-lg duration-150">
                    <MenuBtn icon={CheckCircle} label="标为已响应" onClick={onMarkResponded} />
                    <MenuBtn icon={Archive} label="归档" onClick={() => onUpdateTriage('archived')} />
                    <MenuBtn icon={Ban} label="误报" onClick={() => onUpdateTriage('false_positive')} />
                  </div>
                )}
              </div>
            </div>
          )}
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

/* 可排序表头:点击切换该列升/降序,激活列显示实心箭头,未激活显示淡色双箭头 */
function SortableTh({ label, field, sort, onSort, align = 'left', className = '' }: {
  label: string
  field: SortField
  sort: { field: string; dir: 'asc' | 'desc' }
  onSort: (field: SortField) => void
  align?: 'left' | 'right'
  className?: string
}) {
  const active = sort.field === field
  const Arrow = active ? (sort.dir === 'desc' ? ArrowDown : ArrowUp) : ChevronsUpDown
  return (
    <th className={cn('px-3 py-3.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground', align === 'right' ? 'text-right' : 'text-left', className)}>
      <button onClick={() => onSort(field)} title="点击切换排序"
        className={cn('inline-flex items-center gap-1 align-middle uppercase tracking-wider transition-colors hover:text-foreground', active && 'text-foreground')}>
        {label}
        <Arrow className={cn('h-3 w-3', active ? 'opacity-100' : 'opacity-30')} strokeWidth={2.5} />
      </button>
    </th>
  )
}

/* 疑似身份:作者来源(ai-labeler LLM 多信号判定);4S店/员工=疑似软文(原 KOE),KOL=自媒体,其余淡化 */
function IdentityBadge({ sourceType, fans, name }: { sourceType?: string; fans?: number; name?: string }) {
  const label = identityLabel(sourceType, fans, name)
  if (!label) return <span className="text-[11px] text-muted-foreground/40">—</span>
  const strong = label === 'KOE' || label === '4S店'
  const kol = label === 'KOC' || label.endsWith('KOL')
  const cls = strong
    ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
    : kol
      ? 'bg-sky-500/12 text-sky-700 dark:text-sky-300'
      : 'bg-muted text-muted-foreground'
  const badge = <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold', strong && 'cursor-help', cls)}>{label}</span>
  return strong ? <Tooltip text="账号名带品牌/车型,疑似经销商/品牌关联号(非真实车主),研判时建议剔除">{badge}</Tooltip> : badge
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
        <Tooltip text={r.alert_reasons || '已触发预警规则,建议优先处理'}>
          <span className="inline-flex cursor-help items-center gap-0.5 rounded bg-status-red/12 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-300"><Bell className="h-2.5 w-2.5" />预警{alerts}</span>
        </Tooltip>
      )}
      {neg > 0 && (
        <Tooltip text="该内容下被判为负面/风险的评论条数;点开详情可查看具体评论">
          <span className="cursor-help rounded bg-status-orange/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">负评{neg}</span>
        </Tooltip>
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
