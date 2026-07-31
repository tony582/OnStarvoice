import { useEffect, useState, useCallback, useRef } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Inbox, Search, ChevronLeft, ChevronRight, MoreHorizontal,
  Check, CheckCircle, Archive, ArchiveRestore, CircleOff, Loader2, ChevronDown,
  User, FileText, Bell, ExternalLink,
  ArrowUp, ArrowDown, ChevronsUpDown, Download, X, SlidersHorizontal,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDateCompact, LABELS, platformName, cn, identityLabel } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { RecordDrawer, getCover, type ManualRecordFields } from '@/components/shared/RecordDrawer'
import { WorkbenchSelect } from '@/components/shared/Workbench'
import { KeywordFilter } from '@/components/shared/KeywordFilter'
import { CombinedDateRangeFilter, type CombinedDateRanges } from '@/components/shared/DateRangeFilter'
import { MultiSelect } from '@/components/shared/MultiSelect'
import { Tooltip } from '@/components/shared/Tooltip'
import { BatchBar, Checkbox, useSelection } from '@/components/shared/BatchBar'
import { useNotePrompt } from '@/components/shared/NotePrompt'
import { useTicketDispatch } from '@/components/shared/TicketDispatch'
import { RecordLabelChips } from '@/components/shared/RecordLabels'
import {
  normalizeCustomTags, tagsFromRecord,
  type CustomTag, type CustomTagPatch,
} from '@/lib/custom-tags'
import { TriageBoard } from '@/pages/workbench/TriageBoard'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'
import { Rows3, Kanban } from 'lucide-react'

interface Pagination { page: number; totalPages: number; total: number }
interface CustomTagsMutationResponse {
  customTags?: unknown
  custom_tags?: unknown
  record?: unknown
}
type SortField = 'publish' | 'interactions' | 'comments' | 'likes' | 'first_seen' | 'last_seen'
const RISK_OPTIONS = [{ value: 'alert', label: '有预警' }, { value: 'negative', label: '有负评' }]
const IDENTITY_OPTIONS = [{ value: 'user', label: '用户' }, { value: 'kol', label: 'KOL / KOC' }, { value: 'dealer', label: '4S店' }, { value: 'koe', label: 'KOE' }, { value: 'other', label: '其他' }]
type TriageMode = 'unhandled' | 'reviewing' | 'official_responded' | 'no_action'
type ArchiveView = 'active' | 'archived'
const TRIAGE_MODES: Array<{ value: TriageMode; label: string; icon: React.ElementType }> = [
  { value: 'unhandled', label: '待处理', icon: Inbox },
  { value: 'reviewing', label: '负面流程', icon: Bell },
  { value: 'official_responded', label: '官方已评', icon: CheckCircle },
  { value: 'no_action', label: '无需操作', icon: CircleOff },
]
const ARCHIVE_VIEWS: Array<{ value: ArchiveView; label: string; icon: React.ElementType }> = [
  { value: 'active', label: '工作中', icon: Inbox },
  { value: 'archived', label: '已归档', icon: Archive },
]
const PAGE_SIZE_OPTIONS = [20, 30, 50, 100] as const
const emptyDateRanges = (): CombinedDateRanges => ({
  publish: { from: '', to: '' },
  recent: { from: '', to: '' },
  first: { from: '', to: '' },
})

function getPaginationItems(currentPage: number, totalPages: number): Array<number | 'ellipsis'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1)
  if (currentPage <= 4) return [1, 2, 3, 4, 5, 'ellipsis', totalPages]
  if (currentPage >= totalPages - 3) {
    return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages]
  }
  return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', totalPages]
}

function contentAvailabilityLabel(record: Record<string, unknown>) {
  const status = String(record.content_availability_status || '')
  if (status === 'deleted') return '原帖已删除'
  if (status === 'page_unavailable') return '已删除或不可访问'
  return ''
}

export function TriageQueue({ initial }: { initial?: Record<string, string> }) {
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const [view, setView] = useState<'list' | 'board'>('list')
  const [boardNonce, setBoardNonce] = useState(0)
  const [archiveView, setArchiveView] = useState<ArchiveView>(initial?.bucket === 'archived' ? 'archived' : 'active')
  const [sentiment, setSentiment] = useState(initial?.sentiment ?? '')
  const [platform, setPlatform] = useState(initial?.platform ?? '')
  const [keyword, setKeyword] = useState(initial?.keyword ?? '')
  const [triageStatus, setTriageStatus] = useState('')
  const [risk, setRisk] = useState<string[]>([])
  const [identity, setIdentity] = useState<string[]>([])
  const [captureKeywords, setCaptureKeywords] = useState<string[]>([])
  const [customTagIds, setCustomTagIds] = useState<string[]>([])
  const [customTagCatalog, setCustomTagCatalog] = useState<CustomTag[]>([])
  const [dateRanges, setDateRanges] = useState<CombinedDateRanges>(emptyDateRanges)
  const [exporting, setExporting] = useState(false)
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  // 默认按发布时间倒序(最新在前);表头可点切换发布时间/互动量/首次发现/最近采集、升降序
  const [sort, setSort] = useState<{ field: SortField; dir: 'asc' | 'desc' }>({ field: 'publish', dir: 'desc' })
  const [records, setRecords] = useState<any[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [pageSize, setPageSize] = useState(30)
  const [jumpPage, setJumpPage] = useState('')
  const [loading, setLoading] = useState(true)
  const [modeBusyId, setModeBusyId] = useState<string | null>(null)
  const [archiveBusyId, setArchiveBusyId] = useState<string | null>(null)
  const [drawerRecord, setDrawerRecord] = useState<any>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const customTagRequestSeq = useRef(0)
  const { ask, dialog } = useNotePrompt()
  const { dispatch, dialog: dispatchDialog } = useTicketDispatch()

  const sel = useSelection(`${archiveView}|${triageStatus}|${risk}|${identity}|${platform}|${sentiment}|${keyword}|${customTagIds}|${dateRanges.publish.from}|${dateRanges.publish.to}|${dateRanges.recent.from}|${dateRanges.recent.to}|${dateRanges.first.from}|${dateRanges.first.to}|${pageSize}|${pagination?.page ?? 1}`)

  const loadCustomTagCatalog = useCallback((keyword = '') => Promise.resolve().then(async () => {
    const seq = ++customTagRequestSeq.current
    try {
      const params = new URLSearchParams({ limit: '100' })
      if (keyword) params.set('keyword', keyword)
      const data = await api.get<{ tags?: unknown }>('/custom-tags?' + params)
      if (seq === customTagRequestSeq.current) {
        setCustomTagCatalog(normalizeCustomTags(data.tags))
      }
    } catch {
      // 标签目录不阻断内容列表；详情中仍可输入新标签，稍后刷新再复用。
    }
  }), [])

  const filterParams = useCallback(() => {
    const params = new URLSearchParams({ sentiment, platform, keyword })
    if (archiveView === 'archived') params.set('bucket', 'archived')
    else params.set('queue', 'triage')
    if (triageStatus) params.set('status', triageStatus)
    risk.forEach(rk => params.append('risk', rk))
    identity.forEach(id => params.append('identity', id))
    params.set('sort', sort.field)
    params.set('dir', sort.dir)
    captureKeywords.forEach(k => params.append('captureKeyword', k))
    customTagIds.forEach(id => params.append('customTag', id))
    if (customTagIds.length) params.set('customTagMode', 'any')
    if (dateRanges.publish.from) params.set('publishFrom', dateRanges.publish.from)
    if (dateRanges.publish.to) params.set('publishTo', dateRanges.publish.to)
    if (dateRanges.recent.from) params.set('recentFrom', dateRanges.recent.from)
    if (dateRanges.recent.to) params.set('recentTo', dateRanges.recent.to)
    if (dateRanges.first.from) params.set('firstFrom', dateRanges.first.from)
    if (dateRanges.first.to) params.set('firstTo', dateRanges.first.to)
    return params
  }, [archiveView, triageStatus, risk, identity, sentiment, platform, keyword, sort, captureKeywords, customTagIds, dateRanges])

  const load = useCallback((page = 1, options?: { silent?: boolean }) => Promise.resolve().then(async () => {
    if (!options?.silent) setLoading(true)
    try {
      const params = filterParams()
      params.set('page', String(page))
      params.set('pageSize', String(pageSize))
      const data = await api.get<any>('/triage/records?' + params)
      setRecords(data.records || [])
      setPagination(data.pagination || null)
    } catch (err) { console.error(err) }
    finally { if (!options?.silent) setLoading(false) }
  }), [filterParams, pageSize])

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
  const activeDateFilterCount = Object.values(dateRanges).filter(range => range.from || range.to).length
  const hasActiveFilters = Boolean(platform || sentiment || keyword || triageStatus || risk.length || identity.length || captureKeywords.length || (view === 'list' && customTagIds.length) || activeDateFilterCount)
  const activeFilterCount = [platform, sentiment, triageStatus].filter(Boolean).length
    + risk.length + identity.length + captureKeywords.length + customTagIds.length + activeDateFilterCount
  const clearFilters = () => {
    setPlatform(''); setSentiment(''); setKeyword(''); setTriageStatus(''); setRisk([]); setIdentity([]); setCaptureKeywords([]); setCustomTagIds([]); setDateRanges(emptyDateRanges())
    setSort({ field: 'publish', dir: 'desc' })
  }

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadCustomTagCatalog() }, [loadCustomTagCatalog])

  // 写后统一刷新:回退空页 + 拉列表 + 更新徽标
  const reloadAfterMutation = useCallback(async () => {
    const page = pagination?.page || 1
    const willEmpty = records.length <= 1 && page > 1
    await load(willEmpty ? page - 1 : page, { silent: true })
    refreshBadges()
  }, [load, pagination, records.length, refreshBadges])

  const markFalsePositive = async (recordId: string): Promise<boolean> => {
    if (archiveView === 'archived') return false
    const reason = await ask({
      title: '提交误报',
      placeholder: '请说明为什么这条内容属于误报',
      confirmLabel: '提交误报',
      required: true,
      helpText: '提交后仅进入平台管理员复核，不会改变当前处理模式或归档状态。',
    })
    if (reason === null) return false
    await api.post('/feedback/false-positive', { recordId, reason })
    setRecords(current => current.map(record =>
      record.id === recordId ? { ...record, false_positive_pending: true } : record))
    setDrawerRecord((current: Record<string, unknown> | null) =>
      current?.id === recordId ? { ...current, false_positive_pending: true } : current)
    refreshBadges()
    return true
  }

  const updateManualFields = async (recordId: string, fields: ManualRecordFields): Promise<boolean> => {
    if (archiveView === 'archived') return false
    await api.patch('/records/' + recordId + '/manual-fields', fields)
    await reloadAfterMutation()
    setDrawerRecord(null)
    return true
  }

  const updateCustomTags = async (recordId: string, patch: CustomTagPatch): Promise<CustomTag[]> => {
    if (archiveView === 'archived') return []
    const data = await api.patch<CustomTagsMutationResponse>('/records/' + recordId + '/custom-tags', patch)
    const tags = tagsFromMutationResponse(data)
    setRecords(current => current.map(record =>
      record.id === recordId ? withCustomTags(record, tags) : record))
    setDrawerRecord((current: Record<string, unknown> | null) =>
      current?.id === recordId ? withCustomTags(current, tags) : current)
    await loadCustomTagCatalog()
    if (customTagIds.length) {
      const stillMatches = tags.some(tag => customTagIds.includes(tag.id))
      if (!stillMatches) {
        setRecords(current => current.filter(record => record.id !== recordId))
        setPagination(current => {
          if (!current) return current
          const total = Math.max(0, current.total - 1)
          return { ...current, total, totalPages: Math.ceil(total / pageSize) }
        })
      }
      const page = pagination?.page || 1
      const willEmpty = records.length <= 1 && page > 1
      await load(willEmpty ? page - 1 : page)
    }
    return tags
  }

  const dispatchTicket = async (record: any) => {
    if (archiveView === 'archived' || record.archived_at) return
    const r = await dispatch({ summary: record.title || record.content, defaultPriority: record.triage_priority })
    if (!r) return
    await api.post('/tickets', { sourceType: 'content', sourceId: record.id, priority: r.priority, assigneeUserId: r.assigneeUserId, assigneeName: r.assigneeName, note: r.note })
    await reloadAfterMutation()
  }

  const modeVisibleInCurrentList = useCallback((newStatus: string) => {
    return !triageStatus || triageStatus === newStatus
  }, [triageStatus])

  const syncModeLocally = useCallback((ids: Iterable<string>, newStatus: TriageMode) => {
    const changed = new Set(ids)
    const keepInList = modeVisibleInCurrentList(newStatus)
    setRecords(current => current.flatMap(record => {
      if (!changed.has(record.id)) return [record]
      if (!keepInList) return []
      return [{
        ...record,
        triage_status: newStatus,
        official_response_status: newStatus === 'official_responded' ? 'responded' : record.official_response_status,
      }]
    }))
    setDrawerRecord((current: any) => {
      if (!current || !changed.has(current.id)) return current
      return {
        ...current,
        triage_status: newStatus,
        official_response_status: newStatus === 'official_responded' ? 'responded' : current.official_response_status,
      }
    })
  }, [modeVisibleInCurrentList])

  const changeTriageMode = useCallback(async (recordId: string, newStatus: TriageMode): Promise<boolean> => {
    if (archiveView === 'archived' || modeBusyId || archiveBusyId) return false
    setModeBusyId(recordId)
    try {
      if (newStatus === 'official_responded') {
        await api.patch('/records/' + recordId + '/official-response', { status: 'responded' })
      } else {
        await api.patch('/triage/records/' + recordId, { status: newStatus })
      }
      const page = pagination?.page || 1
      const targetPage = !modeVisibleInCurrentList(newStatus) && records.length <= 1 && page > 1 ? page - 1 : page
      syncModeLocally([recordId], newStatus)
      refreshBadges()
      await load(targetPage, { silent: true })
      return true
    } catch (err) {
      console.error(err)
      return false
    } finally {
      setModeBusyId(null)
    }
  }, [archiveBusyId, archiveView, load, modeBusyId, modeVisibleInCurrentList, pagination, records.length, refreshBadges, syncModeLocally])

  const runBatch = async (newStatus: TriageMode) => {
    if (archiveView === 'archived' || sel.count === 0) return
    setBatchBusy(true)
    try {
      const ids = [...sel.selected]
      await api.patch('/triage/records/batch', { ids, status: newStatus })
      const page = pagination?.page || 1
      const selectedOnPage = records.filter(record => sel.has(record.id)).length
      const targetPage = !modeVisibleInCurrentList(newStatus) && selectedOnPage >= records.length && page > 1 ? page - 1 : page
      syncModeLocally(ids, newStatus)
      sel.clear()
      refreshBadges()
      await load(targetPage, { silent: true })
    } catch (err) { console.error(err) }
    finally { setBatchBusy(false) }
  }

  const syncArchiveLocally = useCallback((ids: Iterable<string>) => {
    const changed = new Set(ids)
    setRecords(current => current.filter(record => !changed.has(record.id)))
    setDrawerRecord((current: any) => current && changed.has(current.id) ? null : current)
  }, [])

  const changeArchive = useCallback(async (recordId: string, archived: boolean): Promise<boolean> => {
    if (modeBusyId || archiveBusyId) return false
    setArchiveBusyId(recordId)
    try {
      await api.patch('/triage/records/archive', { ids: [recordId], archived })
      const page = pagination?.page || 1
      const targetPage = records.length <= 1 && page > 1 ? page - 1 : page
      syncArchiveLocally([recordId])
      refreshBadges()
      await load(targetPage, { silent: true })
      return true
    } catch (err) {
      console.error(err)
      return false
    } finally {
      setArchiveBusyId(null)
    }
  }, [archiveBusyId, load, modeBusyId, pagination, records.length, refreshBadges, syncArchiveLocally])

  const runArchiveBatch = async (archived: boolean) => {
    if (sel.count === 0) return
    setBatchBusy(true)
    try {
      const ids = [...sel.selected]
      await api.patch('/triage/records/archive', { ids, archived })
      const page = pagination?.page || 1
      const selectedOnPage = records.filter(record => sel.has(record.id)).length
      const targetPage = selectedOnPage >= records.length && page > 1 ? page - 1 : page
      syncArchiveLocally(ids)
      sel.clear()
      refreshBadges()
      await load(targetPage, { silent: true })
    } catch (err) { console.error(err) }
    finally { setBatchBusy(false) }
  }

  const interactions = (r: any) => Number(r.likes || 0) + Number(r.comments_count || 0) + Number(r.collects || 0) + Number(r.shares || 0)
  const allChecked = records.length > 0 && records.every(r => sel.has(r.id))
  const someChecked = records.some(r => sel.has(r.id))
  const triageStatusOptions: Array<[string, string]> = [
    ['', '全部模式'],
    ['unhandled', '待处理'],
    ['reviewing', '负面流程'],
    ['official_responded', '官方已评'],
    ['no_action', '无需操作'],
  ]

  const narrow = false
  const drawerArchived = Boolean(drawerRecord?.archived_at)
  const drawerProps = drawerRecord ? {
    record: drawerRecord,
    onClose: () => setDrawerRecord(null),
    canWrite: canWrite(),
    onLinkIssue: () => { dispatchTicket(drawerRecord); setDrawerRecord(null) },
    onSetStatus: drawerArchived ? undefined : async (s: string) => {
      return changeTriageMode(drawerRecord.id, s as TriageMode)
    },
    onMarkResponded: drawerArchived ? undefined : async () => changeTriageMode(drawerRecord.id, 'official_responded'),
    onSetArchived: async (archived: boolean) => changeArchive(drawerRecord.id, archived),
    onFalsePositive: drawerArchived ? undefined : () => markFalsePositive(drawerRecord.id),
    falsePositivePending: Boolean(drawerRecord.false_positive_pending),
    onUpdateFields: drawerArchived ? undefined : (fields: ManualRecordFields) => updateManualFields(drawerRecord.id, fields),
    customTagCatalog,
    onUpdateCustomTags: drawerArchived ? undefined : (patch: CustomTagPatch) => updateCustomTags(drawerRecord.id, patch),
  } : null

  const goToPage = (requestedPage: number) => {
    if (!pagination) return
    const totalPages = Math.max(1, pagination.totalPages)
    const targetPage = Math.min(totalPages, Math.max(1, Math.trunc(requestedPage)))
    setJumpPage('')
    if (targetPage !== pagination.page) void load(targetPage)
  }

  const submitJumpPage = () => {
    const requestedPage = Number(jumpPage)
    if (!Number.isFinite(requestedPage) || jumpPage.trim() === '') return
    goToPage(requestedPage)
  }

  const pageStart = pagination && pagination.total > 0
    ? (pagination.page - 1) * pageSize + 1
    : 0
  const pageEnd = pagination ? Math.min(pagination.page * pageSize, pagination.total) : 0
  const paginationItems = pagination
    ? getPaginationItems(pagination.page, Math.max(1, pagination.totalPages))
    : []

  return (
    <div className="space-y-3">
      <div className="space-y-3 border-b border-border/60 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center rounded-lg border border-border/70 bg-muted/35 p-0.5" role="tablist" aria-label="内容归档范围">
            {ARCHIVE_VIEWS.map(item => {
              const Icon = item.icon
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => {
                    setArchiveView(item.value)
                    setTriageStatus('')
                    if (item.value === 'archived') setView('list')
                  }}
                  role="tab"
                  aria-selected={archiveView === item.value}
                  className={cn(
                    'inline-flex min-h-10 items-center gap-1.5 rounded-md px-3 py-2 text-[12px] font-semibold transition-colors lg:min-h-0 lg:py-1.5',
                    archiveView === item.value
                      ? 'bg-card text-foreground shadow-sm ring-1 ring-border/50'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />{item.label}
                </button>
              )
            })}
          </div>
          {view === 'board' && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Kanban className="h-3.5 w-3.5" />拖动卡片即可改变处理模式
            </span>
          )}
          {archiveView === 'active' && <div className="ml-auto inline-flex items-center gap-0.5">
            {([['list', '列表', Rows3], ['board', '看板', Kanban]] as const).map(([v, label, Icon]) => (
              <button key={v} onClick={() => setView(v)}
                className={cn('inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors lg:min-h-0 lg:px-2.5 lg:py-1.5',
                  v === 'board' && 'hidden lg:inline-flex',
                  view === v ? 'bg-accent text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                <Icon className="h-3.5 w-3.5" />{label}
              </button>
            ))}
          </div>}
        </div>

        <div role="group" aria-label="内容筛选" className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
          <div className="relative w-full lg:w-52">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={keyword} onChange={e => setKeyword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { load(); setBoardNonce(n => n + 1) } }} placeholder="搜索标题、正文…" className="h-10 border-transparent bg-muted pl-8 text-[12px] focus:bg-card lg:h-8" />
          </div>
          <button
            type="button"
            onClick={() => setMobileFiltersOpen(open => !open)}
            aria-expanded={mobileFiltersOpen}
            className={cn(
              'inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold lg:hidden',
              mobileFiltersOpen || activeFilterCount > 0 ? 'border-primary/25 bg-accent text-primary' : 'border-border bg-card text-muted-foreground',
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />筛选
            {activeFilterCount > 0 && <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">{activeFilterCount}</span>}
          </button>
          <div className={cn(
            'w-full flex-wrap items-center gap-2 rounded-xl bg-muted/30 p-3',
            mobileFiltersOpen ? 'flex' : 'hidden',
            'lg:contents',
          )}>
            <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)}
              aria-label="平台筛选"
              className={cn('bg-muted font-medium hover:bg-muted/70', platform ? 'text-foreground' : 'text-muted-foreground')}>
              <option value="">全部平台</option>
              <option value="xiaohongshu">小红书</option>
              <option value="douyin">抖音</option>
              <option value="weibo">微博</option>
            </WorkbenchSelect>
            {view === 'list' && (
              <>
                <WorkbenchSelect value={triageStatus} onChange={e => setTriageStatus(e.target.value)}
                  aria-label="处理模式筛选"
                  className={cn('bg-muted font-medium hover:bg-muted/70', triageStatus ? 'text-foreground' : 'text-muted-foreground')}>
                  {triageStatusOptions.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </WorkbenchSelect>
                <span className="mx-0.5 hidden h-4 w-px bg-border/60 lg:block" />
                <MultiSelect label="风险" options={RISK_OPTIONS} value={risk} onChange={setRisk} />
                <MultiSelect label="疑似身份" options={IDENTITY_OPTIONS} value={identity} onChange={setIdentity} />
                <KeywordFilter value={captureKeywords} onChange={setCaptureKeywords} />
                <MultiSelect
                  label="自定义标签"
                  options={customTagCatalog.map(tag => ({
                    value: tag.id,
                    label: tag.name,
                    count: tag.usageCount,
                  }))}
                  value={customTagIds}
                  onChange={setCustomTagIds}
                  width="w-64"
                  searchable
                  searchPlaceholder="搜索自定义标签…"
                  emptyText="暂无自定义标签"
                  onSearch={loadCustomTagCatalog}
                />
                <CombinedDateRangeFilter value={dateRanges} onChange={setDateRanges} />
              </>
            )}
            <span className="mx-0.5 hidden h-4 w-px bg-border/60 lg:block" />
            <div role="group" aria-label="情感筛选" className="mobile-table-scroll inline-flex h-10 max-w-full items-center overflow-x-auto rounded-lg bg-muted p-0.5 lg:h-8">
              {([['', '全部情感'], ['negative', '负面'], ['neutral', '中性'], ['positive', '正面']] as const).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={sentiment === value} onClick={() => setSentiment(value)}
                  className={cn('inline-flex h-9 shrink-0 items-center rounded-md px-2.5 text-[12px] font-medium transition-colors lg:h-7',
                    sentiment === value ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  {label}
                </button>
              ))}
            </div>
            {hasActiveFilters && (
              <button onClick={clearFilters} title="清空所有筛选" aria-label={`清空全部 ${activeFilterCount} 项筛选`}
                className="inline-flex h-10 items-center gap-1 rounded-lg px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:h-8 lg:px-2">
                <X className="h-3.5 w-3.5" />清空
              </button>
            )}
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
        <EmptyState
          icon={archiveView === 'archived' ? Archive : Inbox}
          title={archiveView === 'archived' ? '暂无已归档内容' : '暂无记录'}
          description={archiveView === 'archived' ? '客户主动归档的内容会显示在这里' : '调整筛选条件试试'}
        />
      ) : (
        <div className="overflow-hidden rounded-xl bg-card">
          <div className="divide-y divide-border/50 lg:hidden">
            {records.map(r => (
              <MobileRecordCard
                key={r.id}
                record={r}
                canWrite={canWrite()}
                selected={sel.has(r.id)}
                onToggle={() => sel.toggle(r.id)}
                onChangeMode={(nextStatus: TriageMode) => changeTriageMode(r.id, nextStatus)}
                modeBusy={modeBusyId === r.id}
                modeDisabled={archiveView === 'archived' || modeBusyId !== null || archiveBusyId !== null}
                onArchive={() => changeArchive(r.id, archiveView === 'active')}
                archiveBusy={archiveBusyId === r.id}
                archived={archiveView === 'archived'}
                onOpenDetail={() => setDrawerRecord(r)}
                interactions={interactions(r)}
              />
            ))}
          </div>
          <div className="hidden overflow-x-auto lg:block">
          <table className="w-full min-w-[1200px] text-sm">
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
                <th className="px-3 py-3.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">处理模式</th>
                {!narrow && <th className="px-3 py-3.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">风险信号</th>}
                {!narrow && <th className="px-3 py-3.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">疑似身份</th>}
                {!narrow && <SortableTh label="互动" field="interactions" sort={sort} onSort={toggleSort} align="right" />}
                {!narrow && <SortableTh label="评论" field="comments" sort={sort} onSort={toggleSort} align="right" />}
                {!narrow && <SortableTh label="点赞" field="likes" sort={sort} onSort={toggleSort} align="right" />}
                {!narrow && <SortableTh label="发布时间" field="publish" sort={sort} onSort={toggleSort} className="hidden lg:table-cell" />}
                {!narrow && <SortableTh label="首次发现" field="first_seen" sort={sort} onSort={toggleSort} className="hidden xl:table-cell" />}
                {!narrow && <SortableTh label="最近采集" field="last_seen" sort={sort} onSort={toggleSort} className="hidden xl:table-cell" />}
                {!narrow && <th className="hidden whitespace-nowrap px-3 py-3.5 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground xl:table-cell">采集次数</th>}
                {canWrite() && !narrow && <th className="sticky right-0 z-20 w-[132px] min-w-[132px] border-l border-border/50 bg-card px-3 py-3.5 pr-4 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground shadow-[-8px_0_16px_-14px_rgba(15,23,42,0.45)]">操作</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {records.map(r => (
                <RecordRow
                  key={r.id}
                  record={r}
                  canWrite={canWrite()}
                  narrow={narrow}
                  open={drawerRecord?.id === r.id}
                  selected={sel.has(r.id)}
                  onToggle={() => sel.toggle(r.id)}
                  onLinkIssue={() => dispatchTicket(r)}
                  onChangeMode={(nextStatus: TriageMode) => changeTriageMode(r.id, nextStatus)}
                  modeBusy={modeBusyId === r.id}
                  modeDisabled={archiveView === 'archived' || modeBusyId !== null || archiveBusyId !== null}
                  onArchive={() => changeArchive(r.id, archiveView === 'active')}
                  archiveBusy={archiveBusyId === r.id}
                  archived={archiveView === 'archived'}
                  onOpenDetail={() => setDrawerRecord(r)}
                  interactions={interactions(r)}
                />
              ))}
            </tbody>
          </table>
          </div>

          {pagination && (
            <div className="flex flex-col gap-3 border-t border-border/50 px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                第 {formatNumber(pageStart)}–{formatNumber(pageEnd)} 条，共 {formatNumber(pagination.total)} 条
              </span>
              <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  每页
                  <select
                    aria-label="每页条数"
                    value={pageSize}
                    onChange={event => setPageSize(Number(event.target.value))}
                    className="h-8 rounded-lg border border-border bg-card px-2 text-xs font-medium tabular-nums text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring/30"
                  >
                    {PAGE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}</option>)}
                  </select>
                  条
                </label>

                <nav aria-label="内容列表分页" className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    disabled={pagination.page <= 1}
                    aria-label="上一页"
                    title="上一页"
                    onClick={() => goToPage(pagination.page - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <div className="hidden items-center gap-1 sm:flex">
                    {paginationItems.map((item, index) => item === 'ellipsis' ? (
                      <span key={`ellipsis-${index}`} className="flex h-8 w-6 items-center justify-center text-xs text-muted-foreground">…</span>
                    ) : (
                      <Button
                        key={item}
                        variant={item === pagination.page ? 'default' : 'outline'}
                        size="icon"
                        className="h-8 w-8 text-xs tabular-nums"
                        aria-label={`第 ${item} 页`}
                        aria-current={item === pagination.page ? 'page' : undefined}
                        onClick={() => goToPage(item)}
                      >
                        {item}
                      </Button>
                    ))}
                  </div>
                  <span className="min-w-16 px-1 text-center text-xs tabular-nums text-muted-foreground sm:hidden">
                    {pagination.page} / {Math.max(1, pagination.totalPages)} 页
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    disabled={pagination.page >= pagination.totalPages}
                    aria-label="下一页"
                    title="下一页"
                    onClick={() => goToPage(pagination.page + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </nav>

                <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span>跳至</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={Math.max(1, pagination.totalPages)}
                    value={jumpPage}
                    onChange={event => setJumpPage(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Enter') submitJumpPage() }}
                    aria-label="跳转页码"
                    className="h-8 w-14 px-2 text-center text-xs tabular-nums"
                  />
                  <span>页</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-3"
                    disabled={jumpPage.trim() === ''}
                    onClick={submitJumpPage}
                  >
                    跳转
                  </Button>
                </div>
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
          onAction={key => {
            if (key === 'archive') void runArchiveBatch(true)
            else if (key === 'unarchive') void runArchiveBatch(false)
            else void runBatch(key as TriageMode)
          }}
          actions={archiveView === 'archived'
            ? [{ key: 'unarchive', label: '取消归档', icon: ArchiveRestore }]
            : [
                { key: 'unhandled', label: '待处理', icon: Inbox },
                { key: 'reviewing', label: '负面流程', icon: Bell },
                { key: 'official_responded', label: '官方已评', icon: CheckCircle },
                { key: 'no_action', label: '无需操作', icon: CircleOff },
                { key: 'archive', label: '归档', icon: Archive, separatorBefore: true },
              ]}
        />
      )}

      {/* 详情:盖式滑出面板(无遮罩,盖在列表右侧,左侧仍可点)*/}
      {/* The compiler cannot currently prove the ref-free shape of this memoized drawer payload. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      {drawerProps && <RecordDrawer {...drawerProps} />}
      {dialog}
      {dispatchDialog}
    </div>
  )
}

/* 手机值守卡片：把桌面表格里最需要扫读的判断、风险和时间压到一屏内。 */
// Mirrors the long-standing desktop row contract while keeping the mobile view local.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MobileRecordCard({ record: r, canWrite, selected, onToggle, onChangeMode, modeBusy, modeDisabled, onArchive, archiveBusy, archived, onOpenDetail, interactions }: any) {
  const cover = getCover(r)
  const customTags = tagsFromRecord(r)
  const tone = r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'
  const sentimentBar = r.sentiment === 'negative' ? 'bg-status-red' : r.sentiment === 'positive' ? 'bg-status-green' : 'bg-status-blue'
  const mobileIdentity = identityLabel(r.source_type, r.author_fans, r.author_name, r.identity_override)
  const hasRiskSignals = Number(r.alert_count || 0) > 0
    || Number(r.negative_comment_count || 0) > 0
    || (r.official_response_status && r.official_response_status !== 'none')
  const availabilityLabel = contentAvailabilityLabel(r)

  return (
    <article
      data-record-detail-trigger
      role="button"
      tabIndex={0}
      onClick={onOpenDetail}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenDetail()
        }
      }}
      className={cn(
        'relative cursor-pointer px-3 py-3.5 transition-colors active:bg-accent/70',
        selected && 'bg-primary/[0.05]',
      )}
    >
      <span className={cn('absolute inset-y-3.5 left-0 w-1 rounded-r-full', sentimentBar)} />
      <div className="flex items-start gap-3">
        {canWrite && (
          <div className="-ml-1 flex h-11 w-8 shrink-0 items-center justify-center" onClick={event => event.stopPropagation()}>
            <Checkbox checked={selected} onChange={onToggle} />
          </div>
        )}
        {cover ? (
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-border/70 bg-muted">
            <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          </div>
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-dashed border-border bg-muted/40">
            <FileText className="h-4 w-4 text-muted-foreground/40" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[14px] font-semibold leading-5">{r.title || r.content || '(无标题)'}</div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1"><User className="h-3 w-3 shrink-0" /><span className="max-w-28 truncate">{r.author_name || '未知作者'}</span></span>
            <span>{platformName(r.platform)}</span>
            {r.url && <a href={r.url} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()} className="inline-flex items-center gap-0.5 font-semibold text-primary">原文<ExternalLink className="h-3 w-3" /></a>}
          </div>
        </div>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/60" />
      </div>

      <div className={cn('mt-3 flex flex-wrap items-center gap-1.5', canWrite && 'pl-10')}>
        <StatusBadge tone={tone}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge>
        {availabilityLabel && <StatusBadge tone="muted"><CircleOff className="h-3 w-3" />{availabilityLabel}</StatusBadge>}
        {canWrite && !archived ? (
          <TriageStatusMenu status={r.triage_status || 'unhandled'} busy={modeBusy} disabled={modeDisabled} onChange={onChangeMode} />
        ) : (
          <StatusBadge tone={r.triage_status}>{LABELS.triage[r.triage_status] || r.triage_status}</StatusBadge>
        )}
        {hasRiskSignals && <RiskSignals record={r} />}
        {mobileIdentity && <IdentityBadge sourceType={r.source_type} fans={r.author_fans} name={r.author_name} override={r.identity_override} />}
      </div>

      <div className={cn('mt-3 grid grid-cols-3 divide-x divide-border/60 rounded-lg bg-muted/35 px-1 py-2', canWrite && 'ml-10')}>
        <MobileMetric label="互动" value={formatNumber(interactions)} />
        <MobileMetric label="发布" value={r.publish_display || '—'} />
        <MobileMetric label="最近采集" value={formatDateCompact(r.last_seen_at)} />
      </div>

      <div className={cn('mt-2.5 flex min-w-0 items-center justify-between gap-2', canWrite && 'pl-10')}>
        <div className="min-w-0">{customTags.length > 0 && <RecordLabelChips tags={customTags} limit={2} compact />}</div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canWrite && (
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={archiveBusy || (!archived && modeDisabled)}
              aria-label={archived ? '取消归档' : '归档'}
              title={archived ? '取消归档' : '归档'}
              onClick={event => { event.stopPropagation(); void onArchive() }}
            >
              {archiveBusy
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
            </Button>
          )}
          <span className="text-[11px] font-semibold text-primary">{archived ? '查看详情' : '查看并处理'}</span>
        </div>
      </div>
    </article>
  )
}

function MobileMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-2 text-center">
      <div className="truncate text-[11px] font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-0.5 text-[9.5px] text-muted-foreground">{label}</div>
    </div>
  )
}

/* ==================== Record Row(列表行)==================== */
function RecordRow({ record: r, canWrite, narrow, open, selected, onToggle, onLinkIssue, onChangeMode, modeBusy, modeDisabled, onArchive, archiveBusy, archived, onOpenDetail, interactions }: any) {
  const cover = getCover(r)
  const customTags = tagsFromRecord(r)
  const sentimentBar = r.sentiment === 'negative' ? 'bg-status-red' : r.sentiment === 'positive' ? 'bg-status-green' : 'bg-status-blue'
  const tone = r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'
  const triageStatus = r.triage_status || 'unhandled'
  const availabilityLabel = contentAvailabilityLabel(r)

  return (
    <tr data-record-detail-trigger className={cn('group cursor-pointer transition-colors', open ? 'bg-accent' : selected ? 'bg-primary/[0.05]' : 'hover:bg-accent/45')} onClick={onOpenDetail}>
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
              {r.blogger_profile_url && <a href={r.blogger_profile_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex shrink-0 items-center gap-0.5 font-medium text-primary hover:underline"><User className="h-2.5 w-2.5" />主页</a>}
            </div>
            {customTags.length > 0 && <RecordLabelChips tags={customTags} limit={2} compact className="mt-1" />}
          </div>
        </div>
      </td>
      {!narrow && <td className="px-3 py-3.5 align-middle"><StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge></td>}
      <td className="px-3 py-3.5 align-middle">
        <div className="flex flex-wrap gap-1">
          <StatusBadge tone={tone}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge>
          {availabilityLabel && <StatusBadge tone="muted"><CircleOff className="h-3 w-3" />{availabilityLabel}</StatusBadge>}
        </div>
      </td>
      <td className="px-3 py-3.5 align-middle">
        {canWrite && !archived ? (
          <TriageStatusMenu status={triageStatus} busy={modeBusy} disabled={modeDisabled} onChange={onChangeMode} />
        ) : (
          <StatusBadge tone={triageStatus}>{LABELS.triage[triageStatus] || triageStatus}</StatusBadge>
        )}
      </td>
      {!narrow && <td className="px-3 py-3.5 align-middle"><RiskSignals record={r} /></td>}
      {!narrow && <td className="px-3 py-3.5 align-middle"><IdentityBadge sourceType={r.source_type} fans={r.author_fans} name={r.author_name} override={r.identity_override} /></td>}
      {!narrow && <td className="px-3 py-3.5 text-right align-middle text-[12px] font-semibold tabular-nums">{formatNumber(interactions)}</td>}
      {!narrow && <td className="px-3 py-3.5 text-right align-middle text-[12px] font-semibold tabular-nums">{formatNumber(r.comments_count)}</td>}
      {!narrow && <td className="px-3 py-3.5 text-right align-middle text-[12px] font-semibold tabular-nums">{formatNumber(r.likes)}</td>}
      {!narrow && <td className="hidden whitespace-nowrap px-3 py-3.5 align-middle text-[11px] text-muted-foreground lg:table-cell">{r.publish_display || '—'}</td>}
      {!narrow && <td className="hidden whitespace-nowrap px-3 py-3.5 align-middle text-[11px] text-muted-foreground xl:table-cell">{formatDateCompact(r.first_seen_at)}</td>}
      {!narrow && <td className="hidden whitespace-nowrap px-3 py-3.5 align-middle text-[11px] text-muted-foreground xl:table-cell">{formatDateCompact(r.last_seen_at)}</td>}
      {!narrow && <td className="hidden px-3 py-3.5 text-right align-middle text-[12px] font-semibold tabular-nums xl:table-cell">{formatNumber(r.seen_count || 1)}</td>}
      {canWrite && !narrow && (
        <td className={cn(
          'sticky right-0 w-[132px] min-w-[132px] border-l border-border/50 px-3 py-3.5 pr-4 align-middle shadow-[-8px_0_16px_-14px_rgba(15,23,42,0.45)] transition-colors',
          'z-10',
          open || selected ? 'bg-accent' : 'bg-card group-hover:bg-accent',
        )} onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-1">
            {archived ? (
              <Button variant="outline" size="sm" disabled={archiveBusy} onClick={onArchive}>
                {archiveBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
                取消归档
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={onLinkIssue}>转工单</Button>
                <TriageStatusMenu
                  status={triageStatus}
                  busy={modeBusy}
                  archiveBusy={archiveBusy}
                  disabled={modeDisabled}
                  onChange={onChangeMode}
                  onArchiveChange={onArchive}
                  archived={archived}
                  trigger="icon"
                  align="end"
                />
              </>
            )}
          </div>
        </td>
      )}
    </tr>
  )
}

function TriageStatusMenu({ status, busy, archiveBusy, disabled, onChange, onArchiveChange, archived, trigger = 'badge', align = 'start' }: {
  status: string
  busy?: boolean
  archiveBusy?: boolean
  disabled?: boolean
  onChange: (status: TriageMode) => void | Promise<unknown>
  onArchiveChange?: () => void | Promise<unknown>
  archived?: boolean
  trigger?: 'badge' | 'icon'
  align?: 'start' | 'end'
}) {
  const label = LABELS.triage[status] || status || '待处理'
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {trigger === 'icon' ? (
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={busy || archiveBusy || disabled}
            aria-label="更多操作"
            title="更多操作"
            onClick={event => event.stopPropagation()}
          >
            {busy || archiveBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
          </Button>
        ) : (
          <button
            type="button"
            disabled={busy || disabled}
            aria-label={`当前处理模式：${label}，点击修改`}
            onClick={event => event.stopPropagation()}
            className="rounded-full outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <StatusBadge tone={status} className="gap-1 transition-[filter,box-shadow] hover:brightness-95 hover:shadow-sm">
              {label}
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronDown className="h-3 w-3" />}
            </StatusBadge>
          </button>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          collisionPadding={10}
          onClick={event => event.stopPropagation()}
          className="z-[100] min-w-48 animate-in fade-in zoom-in-95 rounded-lg border border-border bg-card p-1.5 text-foreground shadow-xl"
        >
          <DropdownMenu.Label className="px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground">处理模式</DropdownMenu.Label>
          <DropdownMenu.Separator className="mb-1 h-px bg-border/70" />
          <DropdownMenu.RadioGroup value={status}>
            {TRIAGE_MODES.map(option => {
              const Icon = option.icon
              const active = option.value === status
              return (
                <DropdownMenu.RadioItem
                  key={option.value}
                  value={option.value}
                  disabled={busy || disabled}
                  onSelect={() => { if (!active) void onChange(option.value) }}
                  className={cn(
                    'flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-[13px] outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-foreground',
                    active ? 'font-semibold text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{option.label}</span>
                  {active && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
                </DropdownMenu.RadioItem>
              )
            })}
          </DropdownMenu.RadioGroup>
          {trigger === 'icon' && onArchiveChange && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border/70" />
              <DropdownMenu.Item
                disabled={busy || archiveBusy || disabled}
                onSelect={() => { void onArchiveChange() }}
                className="flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-muted-foreground outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-foreground"
              >
                {archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                <span>{archived ? '取消归档' : '归档'}</span>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
function IdentityBadge({ sourceType, fans, name, override }: { sourceType?: string; fans?: number; name?: string; override?: string }) {
  const label = identityLabel(sourceType, fans, name, override)
  if (!label) return <span className="text-[11px] text-muted-foreground/40">—</span>
  const strong = label === 'KOE' || label === '4S店'
  const kol = label.includes('KOC') || label.includes('KOL')
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
  if (!(alerts > 0 || neg > 0)) {
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
    </div>
  )
}

function tagsFromMutationResponse(data: CustomTagsMutationResponse): CustomTag[] {
  if (data.customTags !== undefined) return normalizeCustomTags(data.customTags)
  if (data.custom_tags !== undefined) return normalizeCustomTags(data.custom_tags)
  if (data.record && typeof data.record === 'object') {
    const record = data.record as Record<string, unknown>
    if ('customTags' in record || 'custom_tags' in record) return tagsFromRecord(record)
  }
  throw new Error('标签已保存，但服务端未返回最新标签，请刷新后重试')
}

function withCustomTags<T extends Record<string, unknown>>(record: T, tags: CustomTag[]): T {
  return { ...record, customTags: tags, custom_tags: tags }
}
