import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, ArrowRight, ChevronDown, ChevronLeft, ChevronRight, Database, Download, ExternalLink, FileText,
  Filter, Image as ImageIcon, Layers3, Loader2, RefreshCw, Search, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, formatNumber, platformName, friendlyError } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { WorkbenchSelect, WorkbenchTableShell, WorkbenchTabs, WorkbenchToolbar } from '@/components/shared/Workbench'
import { DateRangeFilter, type DateBasis } from '@/components/shared/DateRangeFilter'
import { useNav } from '@/lib/navigation'

type TableKey =
  | 'single_notes'
  | 'keyword_notes'
  | 'blogger_profiles'
  | 'blogger_notes'
  | 'comment_leads'
  | 'monitor_content'

type Column = {
  key: string
  label: string
  width?: string
  render: (row: any, ctx: CellRenderContext) => React.ReactNode
}

type CellRenderContext = {
  expanded: boolean
  toggle: () => void
  resetKey: string
}

const TABLES: Array<{ key: TableKey; label: string; description: string }> = [
  { key: 'single_notes', label: '单笔记采集', description: '单条内容原始采集表' },
  { key: 'keyword_notes', label: '关键词笔记采集', description: '按关键词搜索采集的内容' },
  { key: 'blogger_profiles', label: '博主信息表', description: '账号主页与粉丝数据' },
  { key: 'blogger_notes', label: '博主笔记采集', description: '指定博主主页下的内容列表' },
  { key: 'comment_leads', label: '评论区客资采集', description: '评论区舆情跟进线索' },
  { key: 'monitor_content', label: '监控内容表', description: '监控任务命中的作品结果' },
]

const PLATFORM_OPTIONS = [
  { value: '', label: '全部平台' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'weibo', label: '微博' },
]

const VALID_TABLES: TableKey[] = ['single_notes', 'keyword_notes', 'blogger_profiles', 'blogger_notes', 'comment_leads', 'monitor_content']

export function DataPage() {
  const { params, navigate } = useNav()
  const initialTable = (VALID_TABLES.includes(params?.table as TableKey) ? params!.table : 'single_notes') as TableKey
  const [activeTable, setActiveTable] = useState<TableKey>(initialTable)
  const [rows, setRows] = useState<any[]>([])
  const [pagination, setPagination] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [platform, setPlatform] = useState(params?.platform ?? '')
  const [keyword, setKeyword] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateBasis, setDateBasis] = useState<DateBasis>('publish')
  const [expandedCells, setExpandedCells] = useState<Record<string, boolean>>({})
  const [expandResetVersion, setExpandResetVersion] = useState(0)
  // The data explorer intentionally accepts heterogeneous rows from six tables.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [selectedRecord, setSelectedRecord] = useState<any | null>(null)
  const [datasetPickerOpen, setDatasetPickerOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)

  const activeConfig = TABLES.find(table => table.key === activeTable) || TABLES[0]
  const columns = useMemo(() => {
    const base = columnsForTable(activeTable, platform)
    if (MEDIA_TABLES.has(activeTable)) {
      return [col('attachments', '附件', r => <AttachmentDownloadCell row={r} />, '128px'), ...base]
    }
    return base
  }, [activeTable, platform])
  const tableMinWidth = useMemo(() => columns.reduce((sum, column) => sum + columnWidthValue(column), 0), [columns])

  const load = async (page = 1) => {
    setLoading(true)
    setError('')
    setSelectedRecord(null)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '50' })
      if (platform) params.set('platform', platform)
      if (keyword.trim()) params.set('keyword', keyword.trim())
      if (dateFrom) params.set('dateFrom', dateFrom)
      if (dateTo) params.set('dateTo', dateTo)
      if (dateFrom || dateTo) params.set('dateBasis', dateBasis)
      const data = await api.get<any>(`/records/tables/${activeTable}?${params.toString()}`)
      setRows(data.rows || [])
      setPagination(data.pagination || null)
      setExpandedCells({})
      setExpandResetVersion(current => current + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '数据表加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void load(1) })
    return () => { active = false }
  }, [activeTable, platform, dateFrom, dateTo, dateBasis]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectTable = (table: TableKey) => {
    setActiveTable(table)
    setSelectedRecord(null)
    setDatasetPickerOpen(false)
  }

  const activeFilterCount = Number(Boolean(platform)) + Number(Boolean(dateFrom || dateTo))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderColumn = (row: any, column: Column, rowIndex = 0) => {
    const rowKey = recordKey(row, activeTable, pagination?.page || 1, rowIndex)
    const cellKey = `${rowKey}:${column.key}`
    return column.render(row, {
      expanded: Boolean(expandedCells[cellKey]),
      resetKey: `${expandResetVersion}:${cellKey}`,
      toggle: () => setExpandedCells(current => ({ ...current, [cellKey]: !current[cellKey] })),
    })
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-300">
      <div className="hidden lg:block">
        <WorkbenchTabs
          tabs={TABLES.map(table => ({ key: table.key, label: table.label }))}
          activeKey={activeTable}
          onChange={key => selectTable(key as TableKey)}
        />
      </div>

      <div className="hidden lg:block">
        <WorkbenchToolbar meta={activeConfig.description}>
          <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)}>
            {PLATFORM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </WorkbenchSelect>
          <DateRangeFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} basis={dateBasis} onBasisChange={setDateBasis} />
          <div className="relative min-w-0 w-full flex-1 lg:min-w-[260px] lg:w-auto lg:flex-none">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') load(1) }}
              placeholder="搜索标题、正文、作者、关键词"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => load(1)} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </WorkbenchToolbar>
      </div>

      <section className="space-y-3 lg:hidden" aria-label="移动数据仓">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <button
            type="button"
            onClick={() => setDatasetPickerOpen(true)}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-muted/60"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Layers3 className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-semibold tracking-wide text-muted-foreground">当前数据集</span>
              <span className="mt-0.5 block truncate text-base font-bold text-foreground">{activeConfig.label}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{activeConfig.description}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">
              切换 <ChevronDown className="h-4 w-4" />
            </span>
          </button>

          <div className="border-t border-border bg-muted/20 px-3 py-3">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={keyword}
                  onChange={e => setKeyword(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') load(1) }}
                  placeholder="搜标题、正文或作者"
                  className="h-10 rounded-xl bg-background pl-9 text-sm"
                />
              </div>
              <button
                type="button"
                onClick={() => setFiltersOpen(true)}
                className="relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-background px-3 text-sm font-semibold text-foreground active:bg-muted"
              >
                <Filter className="h-4 w-4" />
                筛选
                {activeFilterCount > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label="刷新数据"
                onClick={() => load(1)}
                disabled={loading}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-foreground active:bg-muted disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
              <span>{platform ? platformName(platform) : '全部平台'} · {dateRangeSummary(dateFrom, dateTo)}</span>
              <span className="shrink-0 font-semibold tabular-nums text-foreground">{formatNumber(pagination?.total ?? rows.length)} 条</span>
            </div>
          </div>
        </div>

        {activeTable === 'comment_leads' && (
          <button
            type="button"
            onClick={() => navigate('workbench', { queue: 'leads' })}
            className="flex w-full items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-left"
          >
            <span>
              <span className="block text-sm font-semibold text-foreground">这些客资需要跟进？</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">进入客资队列完成分配与处理</span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-primary" />
          </button>
        )}

        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

        {loading ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <span className="text-sm text-muted-foreground">正在整理记录…</span>
          </div>
        ) : rows.length ? (
          <div className="space-y-2.5">
            {rows.map((row, index) => (
              <MobileRecordCard
                key={recordKey(row, activeTable, pagination?.page || 1, index)}
                row={row}
                table={activeTable}
                onOpen={() => setSelectedRecord(row)}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-card">
            <EmptyState icon={Database} title="暂无数据" description="采集或同步后，这里会显示对应记录" />
          </div>
        )}

        {pagination && pagination.totalPages > 1 && (
          <MobilePagination pagination={pagination} onPage={load} />
        )}
      </section>

      {error && <div className="hidden rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 lg:block">{error}</div>}

      <div className="hidden lg:block">
        <WorkbenchTableShell>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{activeConfig.label}</span>
            <StatusBadge tone="neutral">{formatNumber(pagination?.total ?? rows.length)} 条</StatusBadge>
            <span className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
              {platform ? platformName(platform) : '全部平台'}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {activeTable === 'comment_leads' && (
              <button
                onClick={() => navigate('workbench', { queue: 'leads' })}
                className="inline-flex items-center gap-1 font-medium text-primary transition-colors hover:underline"
              >
                去工作台处理 <ArrowRight className="h-3 w-3" />
              </button>
            )}
            <span>{columns.length} 列</span>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="max-h-[calc(100dvh-280px)] min-h-[360px] overflow-auto bg-background lg:max-h-[calc(100vh-330px)] lg:min-h-[420px]">
            <table className="w-full border-separate border-spacing-0 text-sm" style={{ minWidth: `${Math.max(1280, tableMinWidth)}px` }}>
              <thead>
                <tr>
                  {columns.map((column, index) => (
                    <th
                      key={column.key}
                      className={tableHeaderClass(index)}
                      style={columnWidthStyle(column)}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map((row, index) => (
                    <tr key={row.id || row.observation_id || index} className="group align-top">
                      {columns.map((column, columnIndex) => {
                        return (
                          <td key={column.key} className={tableCellClass(columnIndex)} style={columnWidthStyle(column)}>
                            {renderColumn(row, column, index)}
                          </td>
                        )
                      })}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={columns.length}>
                      <EmptyState icon={Database} title="暂无数据" description="采集或同步后，这张表会显示对应记录" />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

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
        </WorkbenchTableShell>
      </div>

      {datasetPickerOpen && (
        <MobileDatasetPicker activeTable={activeTable} onSelect={selectTable} onClose={() => setDatasetPickerOpen(false)} />
      )}

      {filtersOpen && (
        <MobileDataFilters
          platform={platform}
          dateFrom={dateFrom}
          dateTo={dateTo}
          dateBasis={dateBasis}
          onClose={() => setFiltersOpen(false)}
          onApply={next => {
            setPlatform(next.platform)
            setDateFrom(next.dateFrom)
            setDateTo(next.dateTo)
            setDateBasis(next.dateBasis)
            setFiltersOpen(false)
          }}
        />
      )}

      {selectedRecord && (
        <MobileRecordDetail
          row={selectedRecord}
          table={activeTable}
          columns={columns}
          renderColumn={column => renderColumn(selectedRecord, column)}
          onClose={() => setSelectedRecord(null)}
          onOpenWorkbench={activeTable === 'comment_leads' ? () => navigate('workbench', { queue: 'leads' }) : undefined}
        />
      )}
    </div>
  )
}

/* Mobile renderers consume the same heterogeneous table rows as the desktop column registry. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function recordKey(row: any, table: TableKey, page: number, index: number) {
  return String(row?.id || row?.observation_id || `${table}-${page}-${index}`)
}

function dateRangeSummary(from: string, to: string) {
  if (!from && !to) return '不限时间'
  return `${from || '最早'} 至 ${to || '今天'}`
}

function MobileDatasetPicker({
  activeTable,
  onSelect,
  onClose,
}: {
  activeTable: TableKey
  onSelect: (table: TableKey) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[90] lg:hidden" role="dialog" aria-modal="true" aria-label="选择数据集">
      <button type="button" aria-label="关闭数据集选择" onClick={onClose} className="absolute inset-0 bg-slate-950/45" />
      <div className="absolute inset-x-0 bottom-0 max-h-[86dvh] overflow-y-auto rounded-t-[28px] border-t border-border bg-background px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-lg font-bold text-foreground">切换数据集</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">按采集任务进入对应记录，不需要横向找表格。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-2">
          {TABLES.map((table, index) => {
            const active = table.key === activeTable
            return (
              <button
                key={table.key}
                type="button"
                onClick={() => onSelect(table.key)}
                className={`flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors ${active ? 'border-primary bg-primary/5' : 'border-border bg-card active:bg-muted'}`}
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold tabular-nums ${active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-foreground">{table.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{table.description}</span>
                </span>
                {active ? <StatusBadge tone="normal">当前</StatusBadge> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function MobileDataFilters({
  platform,
  dateFrom,
  dateTo,
  dateBasis,
  onClose,
  onApply,
}: {
  platform: string
  dateFrom: string
  dateTo: string
  dateBasis: DateBasis
  onClose: () => void
  onApply: (filters: { platform: string; dateFrom: string; dateTo: string; dateBasis: DateBasis }) => void
}) {
  const [draftPlatform, setDraftPlatform] = useState(platform)
  const [draftFrom, setDraftFrom] = useState(dateFrom)
  const [draftTo, setDraftTo] = useState(dateTo)
  const [draftBasis, setDraftBasis] = useState<DateBasis>(dateBasis)
  const basisOptions: Array<{ key: DateBasis; label: string }> = [
    { key: 'publish', label: '发布时间' },
    { key: 'recent', label: '最近采集' },
    { key: 'first', label: '首次采集' },
  ]

  const applyDays = (days: number) => {
    const end = new Date()
    const start = new Date()
    start.setDate(end.getDate() - (days - 1))
    setDraftFrom(toYmd(start))
    setDraftTo(toYmd(end))
  }

  const applyThisMonth = () => {
    const end = new Date()
    setDraftFrom(toYmd(new Date(end.getFullYear(), end.getMonth(), 1)))
    setDraftTo(toYmd(end))
  }

  const reset = () => {
    setDraftPlatform('')
    setDraftFrom('')
    setDraftTo('')
    setDraftBasis('publish')
  }

  return (
    <div className="fixed inset-0 z-[90] lg:hidden" role="dialog" aria-modal="true" aria-label="筛选数据">
      <button type="button" aria-label="关闭筛选" onClick={onClose} className="absolute inset-0 bg-slate-950/45" />
      <div className="absolute inset-x-0 bottom-0 max-h-[90dvh] overflow-y-auto rounded-t-[28px] border-t border-border bg-background px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="text-lg font-bold text-foreground">筛选记录</p>
            <p className="mt-0.5 text-xs text-muted-foreground">平台与时间可组合筛选</p>
          </div>
          <button type="button" onClick={reset} className="text-sm font-semibold text-primary">全部重置</button>
        </div>

        <div className="space-y-5">
          <fieldset>
            <legend className="mb-2 text-xs font-bold tracking-wide text-muted-foreground">采集平台</legend>
            <div className="grid grid-cols-2 gap-2">
              {PLATFORM_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setDraftPlatform(option.value)}
                  className={`h-11 rounded-xl border text-sm font-semibold ${draftPlatform === option.value ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-foreground'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-xs font-bold tracking-wide text-muted-foreground">时间口径</legend>
            <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
              {basisOptions.map(option => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setDraftBasis(option.key)}
                  className={`h-9 rounded-lg text-xs font-semibold ${draftBasis === option.key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-xs font-bold tracking-wide text-muted-foreground">快捷时间</legend>
            <div className="grid grid-cols-3 gap-2">
              <button type="button" onClick={() => applyDays(7)} className="h-10 rounded-xl border border-border bg-card text-sm font-semibold text-foreground">近 7 天</button>
              <button type="button" onClick={() => applyDays(30)} className="h-10 rounded-xl border border-border bg-card text-sm font-semibold text-foreground">近 30 天</button>
              <button type="button" onClick={applyThisMonth} className="h-10 rounded-xl border border-border bg-card text-sm font-semibold text-foreground">本月</button>
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted-foreground">开始日期</span>
              <input
                type="date"
                value={draftFrom}
                max={draftTo || undefined}
                onChange={event => setDraftFrom(event.target.value)}
                className="h-11 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted-foreground">结束日期</span>
              <input
                type="date"
                value={draftTo}
                min={draftFrom || undefined}
                onChange={event => setDraftTo(event.target.value)}
                className="h-11 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary"
              />
            </label>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onApply({ platform: draftPlatform, dateFrom: draftFrom, dateTo: draftTo, dateBasis: draftBasis })}
          className="mt-6 h-12 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm active:opacity-90"
        >
          查看筛选结果
        </button>
      </div>
    </div>
  )
}

function MobileRecordCard({ row, table, onOpen }: { row: any; table: TableKey; onOpen: () => void }) {
  const cover = table === 'blogger_profiles' ? avatarUrl(row) : primaryImage(row)
  const title = mobileRecordTitle(row, table)
  const subtitle = mobileRecordSubtitle(row, table)
  const stats = mobileRecordStats(row, table)
  const capturedAt = recordCaptureTime(row)

  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative w-full overflow-hidden rounded-2xl border border-border bg-card p-4 text-left shadow-sm transition active:scale-[0.995] active:bg-muted/30"
    >
      <span className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-primary/70" />
      <span className="flex items-start gap-3">
        {cover ? (
          <img src={proxyImg(String(cover))} alt="" className="h-[74px] w-[62px] shrink-0 rounded-xl border border-border object-cover" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span className="flex h-[74px] w-[62px] shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-muted-foreground">
            {table === 'blogger_profiles' ? <Database className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <StatusBadge tone="neutral">{platformName(row?.platform)}</StatusBadge>
            <span className="truncate text-[11px] text-muted-foreground">{mobileRecordKind(table)}</span>
          </span>
          <span className="mt-2 block text-[15px] font-bold leading-5 text-foreground" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {title}
          </span>
          {subtitle && <span className="mt-1 block truncate text-xs text-muted-foreground">{subtitle}</span>}
        </span>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
      </span>
      <span className="mt-3 flex items-center justify-between gap-3 border-t border-border/70 pt-3">
        <span className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
          {stats.map(stat => <span key={stat.label} className="whitespace-nowrap"><strong className="font-semibold tabular-nums text-foreground">{stat.value}</strong> {stat.label}</span>)}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{mobileDate(capturedAt)}</span>
      </span>
    </button>
  )
}

function MobilePagination({ pagination, onPage }: { pagination: any; onPage: (page: number) => void }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-3 py-3">
      <button
        type="button"
        disabled={pagination.page <= 1}
        onClick={() => onPage(pagination.page - 1)}
        className="inline-flex h-10 items-center gap-1 rounded-xl border border-border px-3 text-sm font-semibold text-foreground disabled:opacity-35"
      >
        <ChevronLeft className="h-4 w-4" /> 上一页
      </button>
      <span className="text-center text-xs text-muted-foreground">
        <strong className="block text-sm font-bold tabular-nums text-foreground">{pagination.page} / {pagination.totalPages}</strong>
        共 {formatNumber(pagination.total)} 条
      </span>
      <button
        type="button"
        disabled={pagination.page >= pagination.totalPages}
        onClick={() => onPage(pagination.page + 1)}
        className="inline-flex h-10 items-center gap-1 rounded-xl border border-border px-3 text-sm font-semibold text-foreground disabled:opacity-35"
      >
        下一页 <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  )
}

function MobileRecordDetail({
  row,
  table,
  columns,
  renderColumn,
  onClose,
  onOpenWorkbench,
}: {
  row: any
  table: TableKey
  columns: Column[]
  renderColumn: (column: Column) => React.ReactNode
  onClose: () => void
  onOpenWorkbench?: () => void
}) {
  const grouped = useMemo(() => groupMobileColumns(columns.filter(column => column.key !== 'attachments')), [columns])
  const originalUrl = mobileOriginalUrl(row, table)
  const hasAttachments = MEDIA_TABLES.has(table) && buildRecordMediaTasks(row).length > 0

  return (
    <div className="fixed inset-0 z-[100] flex min-h-0 flex-col bg-background lg:hidden" role="dialog" aria-modal="true" aria-label="记录详情">
      <header className="shrink-0 border-b border-border bg-background/95 px-3 pb-3 pt-[max(.75rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="flex items-center gap-2">
          <button type="button" aria-label="返回记录列表" onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-muted-foreground">{mobileRecordKind(table)} · {platformName(row?.platform)}</p>
            <h2 className="truncate text-base font-bold text-foreground">{mobileRecordTitle(row, table)}</h2>
          </div>
          <StatusBadge tone="neutral">{columns.length} 项</StatusBadge>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        <div className="mb-4 overflow-hidden rounded-2xl border border-border bg-card">
          <div className="flex gap-3 p-4">
            {primaryImage(row) && (
              <img src={proxyImg(String(primaryImage(row)))} alt="" className="h-20 w-16 shrink-0 rounded-xl border border-border object-cover" referrerPolicy="no-referrer" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-bold leading-6 text-foreground">{mobileRecordTitle(row, table)}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{mobileRecordSubtitle(row, table) || '暂无补充说明'}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {mobileRecordStats(row, table).map(stat => <StatusBadge key={stat.label} tone="muted">{stat.value} {stat.label}</StatusBadge>)}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {grouped.map((group, groupIndex) => (
            <details key={group.key} open={groupIndex === 0 || group.key === 'actions'} className="group overflow-hidden rounded-2xl border border-border bg-card">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 [&::-webkit-details-marker]:hidden">
                <span>
                  <span className="block text-sm font-bold text-foreground">{group.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{group.columns.length} 个字段</span>
                </span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="divide-y divide-border border-t border-border">
                {group.columns.map(column => (
                  <div key={column.key} className="px-4 py-3.5">
                    <p className="mb-2 text-[11px] font-bold tracking-wide text-muted-foreground">{column.label}</p>
                    <div className="min-w-0 text-sm [&_.truncate]:overflow-visible [&_.truncate]:whitespace-normal [&_img]:h-20 [&_img]:w-20">
                      {renderColumn(column)}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      </main>

      <footer className="shrink-0 border-t border-border bg-background/95 px-3 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        <div className="flex items-stretch gap-2">
          {hasAttachments && (
            <div className="min-w-0 flex-1 [&_button]:h-11 [&_button]:w-full [&_button]:justify-center [&_button]:rounded-xl">
              <AttachmentDownloadCell row={row} />
            </div>
          )}
          {originalUrl && (
            <a href={originalUrl} target="_blank" rel="noreferrer" className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-bold text-primary-foreground">
              打开原文 <ExternalLink className="h-4 w-4" />
            </a>
          )}
          {onOpenWorkbench && (
            <button type="button" onClick={onOpenWorkbench} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-bold text-primary-foreground">
              去处理 <ArrowRight className="h-4 w-4" />
            </button>
          )}
          {!hasAttachments && !originalUrl && !onOpenWorkbench && (
            <button type="button" onClick={onClose} className="h-11 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground">返回记录列表</button>
          )}
        </div>
      </footer>
    </div>
  )
}

function groupMobileColumns(columns: Column[]) {
  const groups = [
    { key: 'core', label: '核心信息', columns: [] as Column[] },
    { key: 'metrics', label: '数据表现', columns: [] as Column[] },
    { key: 'media', label: '图片与媒体', columns: [] as Column[] },
    { key: 'ai', label: '逐字稿与 AI 分析', columns: [] as Column[] },
    { key: 'actions', label: '链接与来源', columns: [] as Column[] },
  ]
  const metrics = new Set(['fans', 'liked', 'following', 'likes', 'collects', 'comments', 'shares', 'noteRating', 'collectRating'])
  const media = new Set(['cover', 'coverLink', 'avatar', 'avatarLink', 'images', 'imageLinks', 'video', 'audio', 'duration'])
  const ai = new Set(['transcript', 'script', 'scriptOut', 'commentText', 'commentAnalysis', 'commentAnalysisOut', 'rewrite', 'rewriteOut'])
  const actions = new Set(['profile', 'url', 'recordUrl', 'userUrl', 'platform', 'captureTime', 'editedAt', 'time'])

  columns.forEach(column => {
    if (metrics.has(column.key)) groups[1].columns.push(column)
    else if (media.has(column.key)) groups[2].columns.push(column)
    else if (ai.has(column.key)) groups[3].columns.push(column)
    else if (actions.has(column.key)) groups[4].columns.push(column)
    else groups[0].columns.push(column)
  })

  return groups.filter(group => group.columns.length)
}

function mobileRecordTitle(row: any, table: TableKey) {
  if (table === 'blogger_profiles') return String(firstValue(row.author_name, row.title, bloggerIdentifier(row), '未命名博主'))
  if (table === 'comment_leads') return String(firstValue(row.comment_content, row.record_title, '未命名评论'))
  return String(firstValue(row.title, row.record_title, row.content, row.author_name, '未命名记录'))
}

function mobileRecordSubtitle(row: any, table: TableKey) {
  if (table === 'blogger_profiles') return String(firstValue(row.content, value(row, 'payload.description'), bloggerIdentifier(row)))
  if (table === 'comment_leads') return String(firstValue(row.comment_author_name, row.record_title, row.matched_keywords))
  return String(firstValue(row.author_name, row.keyword, value(row, 'payload.keyword'), row.content))
}

function mobileRecordKind(table: TableKey) {
  return TABLES.find(item => item.key === table)?.label || '数据记录'
}

function mobileRecordStats(row: any, table: TableKey) {
  if (table === 'blogger_profiles') {
    return [
      { label: '粉丝', value: formatNumber(firstValue(row.author_fans, value(row, 'payload.followersCount')) as any) },
      { label: '获赞收藏', value: formatNumber(bloggerLiked(row) as any) },
    ]
  }
  if (table === 'comment_leads') {
    return [
      { label: '赞', value: formatNumber(row.comment_like_count as any) },
      { label: '命中词', value: String(asArray(row.matched_keywords).length || '-') },
    ]
  }
  return [
    { label: '赞', value: formatNumber(row.likes as any) },
    { label: '藏', value: formatNumber(row.collects as any) },
    { label: '评', value: formatNumber(row.comments_count as any) },
  ]
}

function mobileOriginalUrl(row: any, table: TableKey) {
  if (table === 'blogger_profiles') return String(firstValue(authorHomepage(row), row.url))
  if (table === 'comment_leads') return String(firstValue(row.record_url, row.url))
  return String(firstValue(row.url, row.record_url))
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function mobileDate(value: unknown) {
  const formatted = formatTableDate(value)
  return formatted ? formatted.replace(/^\d{4}\//, '').slice(0, 11) : '时间未知'
}

function toYmd(date: Date) {
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function columnsForTable(table: TableKey, platform = ''): Column[] {
  if (table === 'single_notes') {
    return singleNoteColumns(platform)
  }

  if (table === 'keyword_notes') {
    return keywordNoteColumns(platform)
  }

  if (table === 'blogger_profiles') {
    return bloggerProfileColumns(platform)
  }

  if (table === 'blogger_notes') {
    return bloggerNoteColumns(platform)
  }

  if (table === 'comment_leads') {
    return [
      col('recordTitle', '原笔记标题', (r, ctx) => longCell(r.record_title || '(无标题)', 180, ctx)),
      col('recordUrl', '原笔记链接', r => linkCell(r.record_url, '原文')),
      col('user', '评论用户', r => textCell(r.comment_author_name)),
      col('ip', 'IP属地', r => textCell(r.comment_ip_location)),
      col('content', '评论内容', (r, ctx) => longCell(r.comment_content, 260, ctx)),
      col('likes', '点赞数', r => metricCell(r.comment_like_count)),
      col('userUrl', '用户主页', r => linkCell(commentUserUrl(r), '主页')),
      col('matched', '命中关键词', r => tagCell(r.matched_keywords)),
      col('userId', '用户ID', r => textCell(r.comment_author_id)),
      col('time', '采集时间', r => dateCell(r.captured_at)),
      col('platform', '采集平台', r => platformBadge(r.platform)),
    ]
  }

  if (table === 'monitor_content') {
    return monitorContentColumns(platform)
  }

  return [
    col('author', '博主', r => textCell(r.author_name)),
    col('profile', '博主主页', r => linkCell(authorHomepage(r), '主页')),
    col('fans', '粉丝数', r => metricCell(r.author_fans)),
    col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
    col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))),
    col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
    col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
    col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
    col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
    col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
    col('tags', '话题标签', r => tagCell(r.tags)),
    col('likes', '点赞数', r => metricCell(r.likes)),
    col('collects', '收藏数', r => metricCell(r.collects)),
  ]
}

function keywordNoteColumns(platform: string): Column[] {
  if (platform === 'douyin') {
    return [
      col('keyword', '关键词', r => textCell(r.keyword || value(r, 'payload.keyword'))),
      col('author', '博主', r => textCell(r.author_name)),
      col('profile', '博主主页', r => linkCell(authorHomepage(r), '查看博主主页')),
      col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
      col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
      col('likes', '点赞数', r => metricCell(r.likes)),
      col('collects', '收藏数', r => metricCell(r.collects)),
      col('comments', '评论数', r => metricCell(r.comments_count)),
      col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
      col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
      col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
      col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
      col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
      col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
      col('tags', '话题标签', r => tagCell(r.tags)),
      col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
      ...aiWorkflowColumns({ includeDuration: false }),
      ...sourceTimeColumns('edited-first'),
    ]
  }

  return [
    col('keyword', '关键词', r => textCell(r.keyword || value(r, 'payload.keyword'))),
    col('author', '博主', r => textCell(r.author_name)),
    col('fans', '粉丝数', r => metricCell(r.author_fans)),
    col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
    col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))),
    col('profile', '博主主页', r => linkCell(authorHomepage(r), '查看博主主页')),
    col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
    col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
    col('tags', '话题标签', r => tagCell(r.tags)),
    col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
    col('likes', '点赞数', r => metricCell(r.likes)),
    col('collects', '收藏数', r => metricCell(r.collects)),
    col('comments', '评论数', r => metricCell(r.comments_count)),
    col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
    col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
    col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
    col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
    col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
    col('imageLinks', '图片链接', r => linkListCell(imageUrls(r), '图片')),
    col('images', '附件图片', r => imagesCell(imageUrls(r), r.title)),
    col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
    ...aiWorkflowColumns({ includeDuration: true }),
    ...sourceTimeColumns('edited-first'),
  ]
}

function bloggerProfileColumns(platform: string): Column[] {
  const columns: Column[] = [
    col('name', '博主名称', r => textCell(r.author_name || r.title)),
  ]

  if (platform !== 'douyin') {
    columns.push(col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))))
  }

  columns.push(
    col('profile', '主页链接', r => linkCell(authorHomepage(r) || r.url, '查看博主主页')),
    col('avatarLink', '头像链接', r => linkCell(avatarUrl(r), '头像')),
    col('avatar', '头像', r => imageCell(avatarUrl(r), r.author_name)),
    col('id', '小红书号', r => textCell(bloggerIdentifier(r))),
    col('desc', '简介', (r, ctx) => longCell(r.content || value(r, 'payload.description'), 180, ctx)),
    col('ip', 'IP属地', r => textCell(value(r, 'payload.ipLocation') || value(r, 'payload.region'))),
    col('following', '关注数', r => metricCell(value(r, 'payload.followingCount') || value(r, 'payload.followCount'))),
    col('fans', '粉丝数', r => metricCell(r.author_fans || value(r, 'payload.followersCount'))),
    col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
    col('time', '采集时间', r => dateCell(recordCaptureTime(r))),
    col('platform', '采集平台', r => platformBadge(r.platform)),
  )

  return columns
}

function bloggerNoteColumns(platform: string): Column[] {
  if (platform === 'douyin') {
    return [
      col('author', '博主', r => textCell(r.author_name)),
      col('fans', '粉丝数', r => metricCell(r.author_fans)),
      col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
      col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
      col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
      col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
      col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
      col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
      col('likes', '点赞数', r => metricCell(r.likes)),
      col('collects', '收藏数', r => metricCell(r.collects)),
      col('comments', '评论数', r => metricCell(r.comments_count)),
      col('shares', '转发数', r => metricCell(r.shares)),
      col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
      col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
      col('profile', '博主主页', r => linkCell(authorHomepage(r), '查看博主主页')),
      col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
      col('tags', '话题标签', r => tagCell(r.tags)),
      col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
      col('audio', '音频链接', r => linkCell(audioUrl(r), '收听音频')),
      ...aiWorkflowColumns({ includeDuration: true }),
      ...sourceTimeColumns('edited-first'),
    ]
  }

  return [
    col('author', '博主', r => textCell(r.author_name)),
    col('fans', '粉丝数', r => metricCell(r.author_fans)),
    col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
    col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))),
    col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
    col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
    col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
    col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
    col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
    col('likes', '点赞数', r => metricCell(r.likes)),
    col('collects', '收藏数', r => metricCell(r.collects)),
    col('comments', '评论数', r => metricCell(r.comments_count)),
    col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
    col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
    col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
    ...aiWorkflowColumns({ includeDuration: true }),
    ...sourceTimeColumns('edited-first'),
  ]
}

function monitorContentColumns(platform: string): Column[] {
  const isDouyin = platform === 'douyin'
  const columns: Column[] = [
    col('author', '博主', r => textCell(r.author_name)),
    col('profile', '博主主页', r => linkCell(authorHomepage(r), '查看博主主页')),
    col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
    col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
    col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
    col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
    col('likes', '点赞数', r => metricCell(r.likes)),
    col('collects', '收藏数', r => metricCell(r.collects)),
    col('comments', '评论数', r => metricCell(r.comments_count)),
  ]

  if (isDouyin || !platform) {
    columns.push(col('shares', '转发数', r => metricCell(r.shares)))
  }

  columns.push(
    col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
    col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
  )

  if (isDouyin) {
    columns.push(
      col('duration', '视频时长', r => textCell(videoDuration(r))),
      col('imageLinks', '图片链接', r => linkListCell(imageUrls(r), '图片')),
      col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
      col('tags', '话题标签', r => tagCell(r.tags)),
      col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
      col('audio', '音频链接', r => linkCell(audioUrl(r), '收听音频')),
      ...aiWorkflowColumns({ includeDuration: false }),
      ...sourceTimeColumns('capture-first'),
    )
    return columns
  }

  columns.push(
    col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
    col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
    col('tags', '话题标签', r => tagCell(r.tags)),
    col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
    ...aiWorkflowColumns({ includeDuration: platform ? true : false }),
    ...sourceTimeColumns('capture-first'),
  )

  return columns
}

function aiWorkflowColumns({ includeDuration }: { includeDuration: boolean }): Column[] {
  return [
    ...(includeDuration ? [col('duration', '视频时长', r => textCell(videoDuration(r)))] : []),
    col('transcript', '视频逐字稿提取', (r) => <TranscriptCell row={r} />),
    col('script', '视频脚本分析', (r, ctx) => longCell(videoScriptAnalysis(r), 180, ctx)),
    col('scriptOut', '视频脚本分析.输出结果', (r, ctx) => longCell(videoScriptAnalysisOutput(r), 220, ctx)),
    col('commentText', '评论内容', (r, ctx) => longCell(commentText(r), 260, ctx)),
    col('commentAnalysis', '评论分析', (r, ctx) => longCell(commentAnalysis(r), 180, ctx)),
    col('commentAnalysisOut', '评论分析.输出结果', (r, ctx) => longCell(commentAnalysisOutput(r), 220, ctx)),
    col('rewrite', '改写', (r, ctx) => longCell(rewriteInput(r), 180, ctx)),
    col('rewriteOut', '改写.输出结果', (r, ctx) => longCell(rewriteOutput(r), 220, ctx)),
  ]
}

function sourceTimeColumns(order: 'capture-first' | 'edited-first'): Column[] {
  const platformColumn = col('platform', '采集平台', r => platformBadge(r.platform))
  const captureColumn = col('captureTime', '采集时间', r => dateCell(recordCaptureTime(r)))
  const editedColumn = col('editedAt', '笔记最近编辑时间', r => dateCell(noteEditedAt(r)))

  return order === 'capture-first'
    ? [platformColumn, captureColumn, editedColumn]
    : [platformColumn, editedColumn, captureColumn]
}

function singleNoteColumns(platform: string): Column[] {
  if (platform === 'xiaohongshu') {
    return [
      col('author', '博主', r => textCell(r.author_name)),
      col('profile', '博主主页', r => linkCell(authorHomepage(r), '主页')),
      col('fans', '粉丝数', r => metricCell(r.author_fans)),
      col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
      col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))),
      col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
      col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
      col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
      col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
      col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
      col('tags', '话题标签', r => tagCell(r.tags)),
      col('likes', '点赞数', r => metricCell(r.likes)),
      col('collects', '收藏数', r => metricCell(r.collects)),
      col('comments', '评论数', r => metricCell(r.comments_count)),
      col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
      col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
      col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
      col('imageLinks', '图片链接', r => linkListCell(imageUrls(r), '图片')),
      col('images', '附件图片', r => imagesCell(imageUrls(r), r.title)),
      col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
      col('duration', '视频时长', r => textCell(videoDuration(r))),
      col('transcript', '视频逐字稿提取', (r) => <TranscriptCell row={r} />),
      col('script', '视频脚本分析', (r, ctx) => longCell(videoScriptAnalysis(r), 180, ctx)),
      col('scriptOut', '视频脚本分析.输出结果', (r, ctx) => longCell(videoScriptAnalysisOutput(r), 220, ctx)),
      col('commentText', '评论内容', (r, ctx) => longCell(commentText(r), 260, ctx)),
      col('commentAnalysis', '评论分析', (r, ctx) => longCell(commentAnalysis(r), 180, ctx)),
      col('commentAnalysisOut', '评论分析.输出结果', (r, ctx) => longCell(commentAnalysisOutput(r), 220, ctx)),
      col('rewrite', '改写', (r, ctx) => longCell(rewriteInput(r), 180, ctx)),
      col('rewriteOut', '改写.输出结果', (r, ctx) => longCell(rewriteOutput(r), 220, ctx)),
      col('platform', '采集平台', r => platformBadge(r.platform)),
      col('captureTime', '采集时间', r => dateCell(r.capture_timestamp || r.created_at)),
      col('editedAt', '笔记最近编辑时间', r => dateCell(noteEditedAt(r))),
    ]
  }

  if (platform === 'douyin') {
    return [
      col('author', '博主', r => textCell(r.author_name)),
      col('profile', '博主主页', r => linkCell(authorHomepage(r), '主页')),
      col('fans', '粉丝数', r => metricCell(r.author_fans)),
      col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
      col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
      col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
      col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
      col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
      col('likes', '点赞数', r => metricCell(r.likes)),
      col('collects', '收藏数', r => metricCell(r.collects)),
      col('comments', '评论数', r => metricCell(r.comments_count)),
      col('shares', '转发数', r => metricCell(r.shares)),
      col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
      col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
      col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
      col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
      col('tags', '话题标签', r => tagCell(r.tags)),
      col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
      col('audio', '音频链接', r => linkCell(audioUrl(r), '收听音频')),
      col('duration', '视频时长', r => textCell(videoDuration(r))),
      col('transcript', '视频逐字稿提取', (r) => <TranscriptCell row={r} />),
      col('script', '视频脚本分析', (r, ctx) => longCell(videoScriptAnalysis(r), 180, ctx)),
      col('scriptOut', '视频脚本分析.输出结果', (r, ctx) => longCell(videoScriptAnalysisOutput(r), 220, ctx)),
      col('commentText', '评论内容', (r, ctx) => longCell(commentText(r), 260, ctx)),
      col('commentAnalysis', '评论分析', (r, ctx) => longCell(commentAnalysis(r), 180, ctx)),
      col('commentAnalysisOut', '评论分析.输出结果', (r, ctx) => longCell(commentAnalysisOutput(r), 220, ctx)),
      col('rewrite', '改写', (r, ctx) => longCell(rewriteInput(r), 180, ctx)),
      col('rewriteOut', '改写.输出结果', (r, ctx) => longCell(rewriteOutput(r), 220, ctx)),
      col('platform', '采集平台', r => platformBadge(r.platform)),
      col('captureTime', '采集时间', r => dateCell(r.capture_timestamp || r.created_at)),
      col('editedAt', '笔记最近编辑时间', r => dateCell(noteEditedAt(r))),
    ]
  }

  return [
    col('author', '博主', r => textCell(r.author_name)),
    col('profile', '博主主页', r => linkCell(authorHomepage(r), '主页')),
    col('fans', '粉丝数', r => metricCell(r.author_fans)),
    col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
    col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))),
    col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
    col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
    col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
    col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
    col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
    col('tags', '话题标签', r => tagCell(r.tags)),
    col('likes', '点赞数', r => metricCell(r.likes)),
    col('collects', '收藏数', r => metricCell(r.collects)),
    col('comments', '评论数', r => metricCell(r.comments_count)),
    col('shares', '转发数', r => metricCell(r.shares)),
    col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
    col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
    col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
    col('imageLinks', '图片链接', r => linkListCell(imageUrls(r), '图片')),
    col('images', '附件图片', r => imagesCell(imageUrls(r), r.title)),
    col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
    col('audio', '音频链接', r => linkCell(audioUrl(r), '收听音频')),
    col('duration', '视频时长', r => textCell(videoDuration(r))),
    col('transcript', '视频逐字稿提取', (r) => <TranscriptCell row={r} />),
    col('script', '视频脚本分析', (r, ctx) => longCell(videoScriptAnalysis(r), 180, ctx)),
    col('scriptOut', '视频脚本分析.输出结果', (r, ctx) => longCell(videoScriptAnalysisOutput(r), 220, ctx)),
    col('commentText', '评论内容', (r, ctx) => longCell(commentText(r), 260, ctx)),
    col('commentAnalysis', '评论分析', (r, ctx) => longCell(commentAnalysis(r), 180, ctx)),
    col('commentAnalysisOut', '评论分析.输出结果', (r, ctx) => longCell(commentAnalysisOutput(r), 220, ctx)),
    col('rewrite', '改写', (r, ctx) => longCell(rewriteInput(r), 180, ctx)),
    col('rewriteOut', '改写.输出结果', (r, ctx) => longCell(rewriteOutput(r), 220, ctx)),
    col('platform', '采集平台', r => platformBadge(r.platform)),
    col('captureTime', '采集时间', r => dateCell(r.capture_timestamp || r.created_at)),
    col('editedAt', '笔记最近编辑时间', r => dateCell(noteEditedAt(r))),
  ]
}

function col(key: string, label: string, render: Column['render'], width?: string): Column {
  return { key, label, render, width }
}

function columnWidthValue(column: Column) {
  if (column.width) return Number.parseInt(column.width, 10) || 150
  if (['author', 'name', 'recordTitle'].includes(column.key)) return 220
  if (['title', 'content', 'desc', 'commentText', 'commentAnalysisOut', 'scriptOut', 'rewriteOut'].includes(column.key)) return 300
  if (['transcript', 'script', 'commentAnalysis', 'rewrite'].includes(column.key)) return 260
  if (['cover', 'images', 'avatar'].includes(column.key)) return 118
  if (['imageLinks', 'profile', 'url', 'recordUrl', 'video', 'audio', 'coverLink', 'avatarLink', 'userUrl'].includes(column.key)) return 128
  if (['likes', 'collects', 'comments', 'shares', 'fans', 'liked', 'following'].includes(column.key)) return 96
  if (['platform', 'type', 'account', 'noteRating', 'collectRating'].includes(column.key)) return 118
  if (['captureTime', 'editedAt', 'time'].includes(column.key)) return 150
  if (['tags', 'matched'].includes(column.key)) return 220
  return 150
}

function columnWidthStyle(column: Column) {
  const width = `${columnWidthValue(column)}px`
  return { width, minWidth: width, maxWidth: width }
}

function tableHeaderClass(index: number) {
  return [
    'sticky top-0 border-b border-r border-border bg-muted px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground',
    index === 0 ? 'left-0 z-30' : 'z-20',
  ].join(' ')
}

function tableCellClass(index: number) {
  return [
    'border-b border-r border-border bg-card px-3 py-2 transition-colors group-hover:bg-muted/30',
    index === 0 ? 'sticky left-0 z-10' : '',
  ].join(' ')
}

function safeObject(value: unknown): Record<string, any> {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (!value) return []
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : value.split(/[,\s，#]+/).filter(Boolean)
    } catch {
      return value.split(/[,\s，#]+/).filter(Boolean)
    }
  }
  return []
}

function value(row: any, path: string): any {
  const parts = path.split('.')
  let current: any = row
  for (const part of parts) {
    current = part === 'payload' || part === 'record_payload' || part === 'comment_payload'
      ? safeObject(current?.[part])
      : current?.[part]
    if (current == null || current === '') return ''
  }
  return current
}

function firstValue(...values: any[]) {
  return values.find(item => item !== undefined && item !== null && item !== '') || ''
}

function recordCaptureTime(row: any) {
  return firstValue(
    row.monitor_captured_at,
    row.capture_timestamp,
    value(row, 'payload.captureTimestamp'),
    value(row, 'payload.capturedAt'),
    row.created_at,
  )
}

function avatarUrl(row: any) {
  return firstValue(
    row.author_avatar,
    value(row, 'payload.avatarUrl'),
    value(row, 'payload.authorAvatar'),
    value(row, 'payload.authorAvatarUrl'),
    value(row, 'payload.bloggerAvatar'),
  )
}

function bloggerIdentifier(row: any) {
  return firstValue(
    row.author_id,
    value(row, 'payload.xiaohongshuId'),
    value(row, 'payload.redId'),
    value(row, 'payload.douyinId'),
    value(row, 'payload.secUid'),
    value(row, 'payload.bloggerId'),
    value(row, 'payload.authorId'),
  )
}

function authorHomepage(row: any) {
  return firstValue(
    row.blogger_profile_url,
    row.monitor_account_url,
    value(row, 'payload.bloggerProfileUrl'),
    value(row, 'payload.authorProfileUrl'),
    value(row, 'payload.authorUrl'),
    value(row, 'payload.profileUrl'),
    value(row, 'record_payload.bloggerProfileUrl'),
  )
}

function bloggerLiked(row: any) {
  return firstValue(
    row.blogger_liked_collected,
    value(row, 'payload.bloggerLikedAndCollectedCount'),
    value(row, 'payload.likedAndCollectedCount'),
    value(row, 'payload.likedCollectedCount'),
  )
}

function primaryImage(row: any) {
  return firstValue(
    row.cover_url,
    value(row, 'payload.coverImageUrl'),
    value(row, 'payload.coverUrl'),
    value(row, 'payload.cover'),
    asArray(row.image_urls)[0],
    asArray(value(row, 'payload.imageUrls'))[0],
    asArray(value(row, 'payload.images'))[0],
  )
}

function imageUrls(row: any) {
  const urls = [
    ...asArray(row.image_urls),
    ...asArray(value(row, 'payload.imageUrls')),
    ...asArray(value(row, 'payload.images')),
    ...asArray(value(row, 'payload.imageLinks')),
    ...asArray(value(row, 'payload.attachments')),
  ].map(urlFromItem).filter(Boolean)
  const cover = primaryImage(row)
  return Array.from(new Set([cover, ...urls].filter(Boolean).map(String)))
}

function urlFromItem(item: any) {
  if (!item) return ''
  if (typeof item === 'string') return item.trim()
  if (typeof item === 'object') {
    return String(firstValue(item.url, item.src, item.href, item.originUrl, item.originalUrl, item.downloadUrl)).trim()
  }
  return ''
}

function videoUrl(row: any) {
  return firstValue(
    row.video_url,
    value(row, 'payload.videoUrl'),
    value(row, 'payload.videoLink'),
    value(row, 'payload.video_url'),
    value(row, 'payload.awemeVideoUrl'),
    urlFromItem(asArray(value(row, 'payload.videoUrls'))[0]),
  )
}

function audioUrl(row: any) {
  return firstValue(
    row.audio_url,
    value(row, 'payload.audioUrl'),
    value(row, 'payload.audio_url'),
    value(row, 'payload.musicUrl'),
    urlFromItem(asArray(value(row, 'payload.audioUrls'))[0]),
    urlFromItem(asArray(value(row, 'payload.musicUrls'))[0]),
  )
}

function videoDuration(row: any) {
  return firstValue(
    row.video_duration,
    value(row, 'payload.videoDuration'),
    value(row, 'payload.videoTime'),
    value(row, 'payload.duration'),
  )
}

function videoTranscript(row: any) {
  return firstValue(
    value(row, 'payload.videoTranscript'),
    value(row, 'payload.videoTranscriptText'),
    value(row, 'payload.videoTranscriptExtracted'),
    value(row, 'payload.videoSubtitleText'),
    value(row, 'payload.subtitleText'),
    value(row, 'payload.transcript'),
    value(row, 'payload.asrText'),
    value(row, 'payload.videoText'),
  )
}

function videoScriptAnalysis(row: any) {
  return firstValue(
    value(row, 'payload.videoScriptAnalysis'),
    value(row, 'payload.videoScriptAnalyze'),
    value(row, 'payload.scriptAnalysis'),
    value(row, 'payload.videoScriptPrompt'),
  )
}

function videoScriptAnalysisOutput(row: any) {
  return firstValue(
    value(row, 'payload.videoScriptAnalysisOutput'),
    value(row, 'payload.videoScriptAnalysisResult'),
    value(row, 'payload.scriptAnalysisOutput'),
    value(row, 'payload.scriptAnalysisResult'),
  )
}

function commentUserUrl(row: any) {
  return firstValue(
    value(row, 'comment_payload.authorUrl'),
    value(row, 'comment_payload.userUrl'),
    value(row, 'comment_payload.profileUrl'),
    value(row, 'comment_payload.homepage'),
  )
}

function commentText(row: any) {
  return firstValue(
    row.comments_text,
    value(row, 'payload.commentsMergedText'),
    value(row, 'payload.commentContent'),
    value(row, 'payload.commentText'),
  )
}

function commentAnalysis(row: any) {
  return firstValue(
    value(row, 'payload.commentAnalysis'),
    value(row, 'payload.commentsAnalysis'),
    value(row, 'payload.commentAnalysisPrompt'),
  )
}

function commentAnalysisOutput(row: any) {
  return firstValue(
    value(row, 'payload.commentAnalysisOutput'),
    value(row, 'payload.commentAnalysisResult'),
    value(row, 'payload.commentsAnalysisOutput'),
    value(row, 'payload.commentsAnalysisResult'),
  )
}

function rewriteInput(row: any) {
  return firstValue(
    value(row, 'payload.rewrite'),
    value(row, 'payload.rewriteInput'),
    value(row, 'payload.rewritePrompt'),
    value(row, 'payload.contentRewrite'),
  )
}

function rewriteOutput(row: any) {
  return firstValue(
    value(row, 'payload.rewriteOutput'),
    value(row, 'payload.rewriteResult'),
    value(row, 'payload.contentRewriteOutput'),
    value(row, 'payload.contentRewriteResult'),
  )
}

function noteEditedAt(row: any) {
  return firstValue(
    row.publish_time,
    value(row, 'payload.lastEditedAt'),
    value(row, 'payload.lastEditTime'),
    value(row, 'payload.updatedAt'),
    value(row, 'payload.publishTime'),
    value(row, 'payload.publishDate'),
  )
}

function noteTypeLabel(row: any) {
  const type = String(firstValue(row.note_type, value(row, 'payload.noteType'), value(row, 'payload.mediaType')) || '').toLowerCase()
  if (type === 'image' || type === '图文') return '图文'
  if (type === 'video' || type === '视频') return '视频'
  if (type === 'live') return '直播'
  return type || '-'
}

function interaction(row: any) {
  return Number(row.likes || 0) + Number(row.comments_count || 0) + Number(row.collects || 0) + Number(row.shares || 0)
}

function noteRating(row: any) {
  const total = interaction(row)
  if (total >= 10000) return { label: '爆款', tone: 'urgent' }
  if (total >= 1000) return { label: '潜力', tone: 'high' }
  if (total >= 100) return { label: '普通', tone: 'normal' }
  return { label: '低价值', tone: 'muted' }
}

function collectRating(row: any) {
  const collects = Number(row.collects || 0)
  if (collects >= 1000) return { label: '高收藏', tone: 'urgent' }
  if (collects >= 100) return { label: '可收藏', tone: 'high' }
  if (collects > 0) return { label: '普通', tone: 'normal' }
  return { label: '未采集', tone: 'muted' }
}

function textCell(value: unknown) {
  const text = String(value ?? '').trim()
  return <span className="block truncate text-sm text-foreground" title={text}>{text || '-'}</span>
}

function dateCell(value: unknown) {
  return textCell(formatTableDate(value))
}

function formatTableDate(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  let date: Date | null = null
  if (/^\d+$/.test(raw)) {
    const number = Number(raw)
    const millis = raw.length >= 12 ? number : number * 1000
    date = new Date(millis)
  } else {
    const parsed = new Date(raw)
    if (!Number.isNaN(parsed.getTime())) date = parsed
  }

  if (!date || Number.isNaN(date.getTime())) return formatDate(raw)
  const year = date.getFullYear()
  if (year < 2000 || year > 2100) return formatDate(raw)

  const pad = (number: number) => String(number).padStart(2, '0')
  return `${year}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function longCell(value: unknown, maxPreviewLength = 160, ctx?: CellRenderContext) {
  const text = String(value ?? '').trim()
  if (!text) return <span className="text-muted-foreground">-</span>
  return (
    <ExpandableText
      value={text}
      maxLines={3}
      maxPreviewLength={maxPreviewLength}
      expanded={Boolean(ctx?.expanded)}
      resetKey={ctx?.resetKey || text}
      onToggle={ctx?.toggle}
    />
  )
}

function ExpandableText({
  value,
  maxLines = 3,
  maxPreviewLength = 160,
  expanded,
  resetKey,
  onToggle,
}: {
  value: string
  maxLines?: number
  maxPreviewLength?: number
  expanded: boolean
  resetKey: string
  onToggle?: () => void
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [localExpansion, setLocalExpansion] = useState({
    resetKey,
    expanded: false,
  })
  const isExpanded = expanded ||
    (localExpansion.resetKey === resetKey && localExpansion.expanded)

  useEffect(() => {
    const node = contentRef.current
    if (!node || isExpanded) return

    const measure = () => {
      setHasOverflow(node.scrollHeight > node.clientHeight + 1)
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [value, maxLines, isExpanded])

  const canExpand = Boolean(isExpanded || hasOverflow || value.length > maxPreviewLength)
  const collapsedStyle = isExpanded
    ? undefined
    : {
        display: '-webkit-box',
        WebkitLineClamp: maxLines,
        WebkitBoxOrient: 'vertical' as const,
        overflow: 'hidden',
      }

  const handleToggle = (event?: React.SyntheticEvent) => {
    event?.preventDefault()
    event?.stopPropagation()
    setLocalExpansion({resetKey, expanded: !isExpanded})
    onToggle?.()
  }

  return (
    <div className="space-y-1.5 text-sm leading-5 text-foreground">
      <div
        ref={contentRef}
        className={isExpanded ? 'whitespace-pre-wrap break-words' : 'break-words'}
        style={collapsedStyle}
        title={isExpanded ? undefined : value}
      >
        {value}
      </div>
      {canExpand && (
        <button
          type="button"
          onPointerDown={handleToggle}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') handleToggle(event)
          }}
          className="text-xs font-medium text-primary hover:underline"
        >
          {isExpanded ? '收起' : '查看全文'}
        </button>
      )}
    </div>
  )
}

function metricCell(value: unknown) {
  return (
    <span className="inline-flex h-7 min-w-12 items-center justify-end rounded-md bg-muted/60 px-2 text-sm tabular-nums text-foreground">
      {formatNumber(value as any)}
    </span>
  )
}

// 这些数据表的记录可能带媒体附件，展示「下载附件」按钮
const MEDIA_TABLES = new Set<TableKey>(['single_notes', 'keyword_notes', 'blogger_notes', 'monitor_content'])

type MediaTask = { url: string; filename: string; kind: 'image' | 'video' | 'audio' }

function sanitizeFilename(name: unknown): string {
  const text = String(name || 'record')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return text || 'record'
}

function extFromUrl(url: string, fallback: string): string {
  const path = String(url || '').split('?')[0]
  const match = path.match(/\.([a-z0-9]{2,5})$/i)
  return match ? `.${match[1].toLowerCase()}` : fallback
}

// 与后端 collectRecordMediaUrls 口径一致：封面 / 多图 / 视频 / 音频
function buildRecordMediaTasks(row: any): MediaTask[] {
  const tasks: MediaTask[] = []
  const seen = new Set<string>()
  const prefix = sanitizeFilename(row?.title || row?.author_name || 'record')
  const push = (url: unknown, filename: string, kind: MediaTask['kind']) => {
    const u = String(url || '').trim()
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) return
    seen.add(u)
    tasks.push({ url: u, filename, kind })
  }

  const cover = primaryImage(row)
  if (cover) push(cover, `${prefix}_cover${extFromUrl(String(cover), '.jpg')}`, 'image')
  imageUrls(row).forEach((url, index) => {
    if (String(url) === String(cover)) return
    push(url, `${prefix}_image_${index + 1}${extFromUrl(String(url), '.jpg')}`, 'image')
  })
  const video = videoUrl(row)
  if (video) push(video, `${prefix}_video${extFromUrl(String(video), '.mp4')}`, 'video')
  const audio = audioUrl(row)
  if (audio) push(audio, `${prefix}_audio${extFromUrl(String(audio), '.m4a')}`, 'audio')

  return tasks
}

function saveBlob(blob: Blob, filename: string) {
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(objUrl), 60000)
}

// 下载附件：逐个走后端透明代理 -> blob -> 保存到操作员本地，不占服务器空间
function AttachmentDownloadCell({ row }: { row: any }) {
  const tasks = useMemo(() => buildRecordMediaTasks(row), [row])
  const [status, setStatus] = useState<'idle' | 'downloading' | 'done' | 'error'>('idle')
  const [msg, setMsg] = useState('')

  if (!tasks.length) return <span className="text-muted-foreground">-</span>

  const handleDownload = async () => {
    if (status === 'downloading' || !row?.id) return
    setStatus('downloading')
    setMsg('')
    const tenant = api.getTenant()
    let ok = 0
    let fail = 0
    let lastError = ''
    for (const task of tasks) {
      try {
        const qs = new URLSearchParams({ url: task.url, filename: task.filename })
        const resp = await fetch(`/api/records/${row.id}/media-proxy?${qs.toString()}`, {
          credentials: 'same-origin',
          headers: tenant ? { 'x-tenant-id': tenant } : {},
        })
        if (!resp.ok) {
          fail += 1
          let detail = ''
          try {
            const data = await resp.json()
            detail = data?.message || data?.error || ''
          } catch {
            detail = resp.statusText
          }
          lastError = `HTTP ${resp.status}${detail ? ' · ' + detail : ''}`
          continue
        }
        saveBlob(await resp.blob(), task.filename)
        ok += 1
      } catch (err: any) {
        fail += 1
        lastError = err?.message ? `请求异常 · ${err.message}` : '请求异常'
      }
    }
    if (fail === 0) {
      setStatus('done')
      setMsg(`已下载 ${ok} 个`)
    } else if (ok === 0) {
      setStatus('error')
      setMsg(`下载失败（${lastError || '未知错误'}）`)
    } else {
      setStatus('error')
      setMsg(`成功 ${ok}，失败 ${fail}（${lastError}）`)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleDownload}
        disabled={status === 'downloading'}
        title="下载封面/图片/视频/音频到本地"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-semibold text-primary transition hover:border-primary/40 hover:bg-primary/5 disabled:opacity-60"
      >
        {status === 'downloading'
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : <Download className="h-3 w-3" />}
        {status === 'downloading' ? '下载中' : `下载附件(${tasks.length})`}
      </button>
      {msg && (
        <span className={`text-[11px] ${status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
          {msg}
        </span>
      )}
    </div>
  )
}

// 视频逐字稿单元:有结果显示文本;没结果给「生成逐字稿」按钮(异步转写 + 轮询)
const TRANSCRIPT_TERMINAL = ['done', 'failed', 'expired', 'no_media']
function TranscriptCell({ row }: { row: any }) {
  const initialText = String(row?.transcript || videoTranscript(row) || '')
  const [status, setStatus] = useState<string>(row?.transcript_status || (initialText ? 'done' : 'none'))
  const [text, setText] = useState<string>(initialText)
  const [error, setError] = useState<string>(row?.transcript_error || '')
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  useEffect(() => stopPoll, [])

  const startPoll = () => {
    stopPoll()
    pollRef.current = setInterval(async () => {
      try {
        const d: any = await api.get(`/records/${row.id}/transcript`)
        setStatus(d.transcript_status || 'none'); setText(d.transcript || ''); setError(d.transcript_error || '')
        if (TRANSCRIPT_TERMINAL.includes(d.transcript_status)) { stopPoll(); setBusy(false) }
      } catch { /* 下个周期再试 */ }
    }, 3500)
  }

  const generate = async () => {
    if (!row?.id || busy) return
    setBusy(true); setError('')
    try {
      const d: any = await api.post(`/records/${row.id}/transcribe`, {})
      setStatus(d.status || 'pending')
      if (d.status === 'no_media') { setBusy(false); return }
      if (d.status === 'pending' || d.status === 'processing') startPoll()
      else setBusy(false)
    } catch (e: any) {
      setStatus('failed'); setError(e?.message || '触发失败'); setBusy(false)
    }
  }

  const inProgress = busy || status === 'pending' || status === 'processing'

  if (status === 'done' && text) {
    return (
      <div className="max-w-full whitespace-pre-wrap break-words text-xs leading-5 lg:max-w-[220px]" title={text}>
        {text.length > 200 ? text.slice(0, 200) + '…' : text}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={generate}
        disabled={inProgress}
        title="用阿里云百炼提取视频口播文字"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-semibold text-primary transition hover:border-primary/40 hover:bg-primary/5 disabled:opacity-60"
      >
        {inProgress ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
        {inProgress ? '转写中…' : status === 'done' ? '重新生成' : '生成逐字稿'}
      </button>
      {status === 'no_media' && <span className="text-[11px] text-muted-foreground">无可转写视频</span>}
      {status === 'no_speech' && <span className="text-[11px] text-muted-foreground">无人声口播</span>}
      {status === 'expired' && <span className="text-[11px] text-amber-600">直链过期,需重采</span>}
      {status === 'failed' && <span className="text-[11px] text-destructive">{friendlyError(error)}</span>}
    </div>
  )
}

function linkCell(url: unknown, label: string) {
  const href = String(url || '').trim()
  if (!href) return <span className="text-muted-foreground">-</span>
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-semibold text-primary transition hover:border-primary/40 hover:bg-primary/5">
      {label}
      <ExternalLink className="h-3 w-3" />
    </a>
  )
}

function linkListCell(urls: unknown, label: string) {
  const list = asArray(urls).map(urlFromItem).filter(Boolean)
  if (!list.length) return <span className="text-muted-foreground">-</span>
  return (
    <div className="flex flex-wrap gap-1">
      {list.slice(0, 3).map((url, index) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" className="inline-flex h-6 items-center rounded-md border border-border bg-background px-2 text-[11px] font-semibold text-primary transition hover:border-primary/40 hover:bg-primary/5">
          {label}{index + 1}
        </a>
      ))}
      {list.length > 3 && <span className="inline-flex h-6 items-center rounded-md bg-muted px-2 text-[11px] text-muted-foreground">+{list.length - 3}</span>}
    </div>
  )
}

// 小红书/微博/抖音 图片 CDN 有 Referer 防盗链,直接 <img> 引用会 403。
// 经 /api/img 后端代理(带对应 Referer)取图。
const PROXY_IMG_HOSTS = /(?:\.sinaimg\.(?:cn|com)|\.weiboimg\.(?:cn|com)|\.xhscdn\.com|\.xiaohongshu\.com|\.douyinpic\.com|\.douyinstatic\.com|\.pstatp\.com|\.byteimg\.com|\.bytecdn\.cn|\.bdxiguaimg\.com)$/i
function proxyImg(url: string): string {
  const s = String(url || '').trim()
  if (!s) return s
  try {
    const u = new URL(s, window.location.origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return s
    if (PROXY_IMG_HOSTS.test(u.hostname)) return `/api/img?url=${encodeURIComponent(u.toString())}`
  } catch {
    /* 非法 URL,原样返回 */
  }
  return s
}

function thumb(url: string, alt: unknown) {
  const proxied = proxyImg(url)
  return (
    <a
      href={proxied}
      target="_blank"
      rel="noreferrer"
      title="点击查看大图"
      className="block transition hover:opacity-80"
    >
      <img
        src={proxied}
        alt={String(alt || '')}
        className="h-11 w-11 cursor-zoom-in rounded-md border border-border object-cover"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    </a>
  )
}

function imageCell(url: unknown, alt: unknown) {
  const src = String(url || '').trim()
  if (!src) {
    return <div className="flex h-11 w-11 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground"><ImageIcon className="h-4 w-4" /></div>
  }
  return thumb(src, alt)
}

function imagesCell(urls: unknown, alt: unknown) {
  const list = asArray(urls).map(urlFromItem).filter(Boolean)
  if (!list.length) {
    return <div className="flex h-11 w-11 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground"><ImageIcon className="h-4 w-4" /></div>
  }
  return (
    <div className="flex gap-1">
      {list.slice(0, 3).map((url, index) => (
        <div key={`${url}-${index}`}>{thumb(url, alt)}</div>
      ))}
    </div>
  )
}

function tagCell(value: unknown) {
  const tags = asArray(value).map(item => String(typeof item === 'object' ? item.name || item.label || item.value || '' : item).replace(/^#/, '').trim()).filter(Boolean)
  if (!tags.length) return <span className="text-muted-foreground">-</span>
  return (
    <div className="flex flex-wrap gap-1">
      {tags.slice(0, 3).map(tag => <StatusBadge key={tag} tone="muted">#{tag}</StatusBadge>)}
      {tags.length > 3 && <span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">+{tags.length - 3}</span>}
    </div>
  )
}

function platformBadge(platform: string) {
  return <StatusBadge tone="neutral">{platformName(platform)}</StatusBadge>
}

function ratingBadge(rating: { label: string; tone: string }) {
  return <StatusBadge tone={rating.tone}>{rating.label}</StatusBadge>
}
