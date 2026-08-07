import { useEffect, useState, useCallback, useRef } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Inbox, Search, ChevronLeft, ChevronRight, MessageSquarePlus, MessageSquareText,
  Check, CheckCircle, Archive, ArchiveRestore, CircleOff, Loader2, ChevronDown,
  User, FileText, Bell, ExternalLink,
  ArrowUp, ArrowDown, ChevronsUpDown, Download, X, SlidersHorizontal,
  ClipboardCheck, Rows3, Kanban,
} from 'lucide-react'
import { api, isApiNetworkError } from '@/lib/api'
import { formatNumber, formatDateCompact, LABELS, platformName, cn, identityLabel } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import {
  RecordDrawer, getCover,
  type ContentTicketCloseResult, type ManualRecordFields, type RecordProgressSummary,
} from '@/components/shared/RecordDrawer'
import { WorkbenchSelect } from '@/components/shared/Workbench'
import { KeywordFilter } from '@/components/shared/KeywordFilter'
import { CombinedDateRangeFilter, type CombinedDateRanges } from '@/components/shared/DateRangeFilter'
import { MultiSelect } from '@/components/shared/MultiSelect'
import { Tooltip } from '@/components/shared/Tooltip'
import { CopyTicketNumberButton } from '@/components/shared/CopyTicketNumberButton'
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

interface Pagination { page: number; totalPages: number; total: number }
interface CustomTagsMutationResponse {
  customTags?: unknown
  custom_tags?: unknown
  record?: unknown
}
interface ManualFieldsMutationResponse {
  record?: unknown
}
interface ArchiveMutationResponse {
  updatedIds?: unknown
  skippedActiveTicketIds?: unknown
  skipped?: unknown
}
interface BatchModeMutationResponse {
  updated?: unknown
  updatedIds?: unknown
  skipped?: unknown
}
type BatchFeedback = {
  message: string
  tone: 'success' | 'warning' | 'error'
}
interface TicketNumberSaveResult {
  ok: boolean
  message?: string
}
type SortField = 'publish' | 'interactions' | 'comments' | 'likes' | 'first_seen' | 'last_seen'
const RISK_OPTIONS = [
  { value: 'alert', label: '有预警' },
  { value: 'negative', label: '有负评' },
  { value: 'deleted', label: '已删帖' },
]
const IDENTITY_OPTIONS = [{ value: 'user', label: '用户' }, { value: 'kol', label: 'KOL / KOC' }, { value: 'dealer', label: '4S店' }, { value: 'koe', label: 'KOE' }, { value: 'other', label: '其他' }]
type TriageMode = 'unhandled' | 'reviewing' | 'official_responded' | 'no_action' | 'ticketed'
type ArchiveView = 'active' | 'archived'
type TicketStatusFilterValue = '' | 'all' | 'active' | 'closed'
const CONTENT_TRIAGE_MODES: Array<{ value: Exclude<TriageMode, 'ticketed'>; label: string; icon: React.ElementType }> = [
  { value: 'unhandled', label: '待处理', icon: Inbox },
  { value: 'reviewing', label: '负面流程', icon: Bell },
  { value: 'official_responded', label: '官方已评', icon: CheckCircle },
  { value: 'no_action', label: '无需操作', icon: CircleOff },
]
const TICKET_TRIAGE_MODE = { value: 'ticketed' as const, label: '已转工单' }
const TICKET_STATUS_FILTERS: Array<{ value: TicketStatusFilterValue; label: string; tone: 'muted' | 'blue' | 'green' }> = [
  { value: '', label: '不限工单', tone: 'muted' },
  { value: 'all', label: '全部工单', tone: 'blue' },
  { value: 'active', label: '处理中', tone: 'blue' },
  { value: 'closed', label: '已结案', tone: 'green' },
]
const PLATFORM_BADGE_CLASS = 'w-14 justify-center dark:text-white'
const TRIAGE_MODE_BADGE_CLASS = 'w-[88px] justify-center dark:text-white'
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

function TriageSelect({ className, disabled, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block w-full">
      <WorkbenchSelect
        {...props}
        disabled={disabled}
        className={cn('w-full appearance-none !pr-8', className)}
      />
      <ChevronDown
        aria-hidden
        className={cn(
          'pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground',
          disabled && 'opacity-50',
        )}
      />
    </span>
  )
}

function TicketStatusFilter({ value, onChange }: {
  value: TicketStatusFilterValue
  onChange: (value: TicketStatusFilterValue) => void
}) {
  const selected = TICKET_STATUS_FILTERS.find(option => option.value === value) || TICKET_STATUS_FILTERS[0]
  const triggerLabel = value ? selected.label : '工单状态'
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`工单状态筛选，当前${selected.label}`}
          title="筛选工单处理状态"
          className={cn(
            'inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border px-2 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/20 lg:h-8',
            selected.tone === 'green'
              ? 'border-status-green/30 bg-status-green/10 text-emerald-700 hover:bg-status-green/15 dark:text-emerald-300'
              : selected.tone === 'blue'
                ? 'border-primary/25 bg-accent text-primary hover:bg-primary/[0.12]'
                : 'border-border/80 bg-card text-muted-foreground hover:border-input hover:bg-muted hover:text-foreground',
          )}
        >
          <span className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            selected.tone === 'green' ? 'bg-status-green' : selected.tone === 'blue' ? 'bg-status-blue' : 'bg-status-grey',
          )} />
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={5}
          collisionPadding={10}
          className="z-[100] min-w-32 animate-in fade-in zoom-in-95 rounded-lg border border-border bg-card p-1.5 text-foreground shadow-lg"
        >
          <DropdownMenu.RadioGroup value={value || '__none__'} aria-label="工单状态筛选选项">
            {TICKET_STATUS_FILTERS.map(option => (
              <DropdownMenu.RadioItem
                key={option.value || 'none'}
                value={option.value || '__none__'}
                onSelect={() => onChange(option.value)}
                className="flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2.5 text-[12px] outline-none transition-colors data-[highlighted]:bg-accent"
              >
                <span className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  option.tone === 'green' ? 'bg-status-green' : option.tone === 'blue' ? 'bg-status-blue' : 'bg-status-grey',
                )} />
                <span className={cn('flex-1', option.value === value && 'font-semibold')}>{option.label}</span>
                <span className="flex h-4 w-4 items-center justify-center">
                  <DropdownMenu.ItemIndicator><Check className="h-3.5 w-3.5 text-primary" /></DropdownMenu.ItemIndicator>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function HeaderSingleFilter({ label, value, options, onChange }: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  const active = Boolean(value)
  const selectedLabel = options.find(option => option.value === value)?.label
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`${label}筛选${selectedLabel ? `，当前${selectedLabel}` : ''}`}
          title={selectedLabel ? `${label}：${selectedLabel}` : `筛选${label}`}
          className={cn(
            'inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium uppercase tracking-wider outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/20',
            active ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <span>{label}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={5}
          collisionPadding={10}
          className="z-[100] min-w-32 animate-in fade-in zoom-in-95 rounded-lg border border-border bg-card p-1.5 text-foreground shadow-lg"
        >
          <DropdownMenu.RadioGroup
            value={value || '__all__'}
            onValueChange={nextValue => onChange(nextValue === '__all__' ? '' : nextValue)}
            aria-label={`${label}筛选选项`}
          >
            {options.map(option => (
              <DropdownMenu.RadioItem
                key={option.value || 'all'}
                value={option.value || '__all__'}
                className="flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2.5 text-[12px] outline-none transition-colors data-[highlighted]:bg-accent"
              >
                <span className={cn('flex-1', option.value === value && 'font-semibold')}>{option.label}</span>
                <span className="flex h-4 w-4 items-center justify-center">
                  <DropdownMenu.ItemIndicator>
                    <Check className="h-3.5 w-3.5 text-primary" />
                  </DropdownMenu.ItemIndicator>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function recordAccentClass(record: Record<string, unknown>) {
  if (record.ticket_id && record.ticket_status === 'closed') return 'bg-status-green'
  if (record.ticket_id || record.triage_status === 'ticketed') return 'bg-status-blue'
  if (record.sentiment === 'negative') return 'bg-status-red'
  if (record.sentiment === 'positive') return 'bg-status-green'
  return 'bg-status-grey'
}

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
  if (status === 'page_unavailable') return '已删除或不可访问'
  return ''
}

function responseRecord(data?: ManualFieldsMutationResponse): Record<string, unknown> | null {
  return data?.record && typeof data.record === 'object' && !Array.isArray(data.record)
    ? data.record as Record<string, unknown>
    : null
}

function manualFieldsMatch(record: Record<string, unknown>, fields: ManualRecordFields) {
  return (fields.sentiment === undefined || String(record.sentiment || '') === fields.sentiment)
    && (fields.category === undefined || String(record.category || '') === fields.category)
    && (fields.identityOverride === undefined || String(record.identity_override || '') === fields.identityOverride)
    && (fields.publishTime === undefined || String(record.publish_time || '') === fields.publishTime)
}

function localManualFieldsPatch(
  fields: ManualRecordFields,
  savedRecord: Record<string, unknown> | null,
) {
  const patch: Record<string, unknown> = {}
  if (fields.sentiment !== undefined) patch.sentiment = fields.sentiment
  if (fields.category !== undefined) patch.category = fields.category
  if (fields.identityOverride !== undefined) patch.identity_override = fields.identityOverride
  if (fields.publishTime !== undefined) {
    patch.publish_time = fields.publishTime
    patch.publish_display = fields.publishTime
  }
  return { ...patch, ...(savedRecord || {}) }
}

async function verifyManualFieldsSaved(recordId: string, fields: ManualRecordFields) {
  const data = await api.get<ManualFieldsMutationResponse>(`/records/${recordId}/manual-fields`)
  const record = responseRecord(data)
  return record && manualFieldsMatch(record, fields) ? record : null
}

function changedArchiveIds(data: ArchiveMutationResponse | undefined, requestedIds: string[]) {
  const normalizedRequested = requestedIds.map(id => String(id).toLowerCase())
  if (Array.isArray(data?.updatedIds)) {
    return data.updatedIds.map(id => String(id).toLowerCase())
  }
  const skipped = new Set([
    ...(Array.isArray(data?.skippedActiveTicketIds) ? data.skippedActiveTicketIds : []),
    ...(Array.isArray(data?.skipped) ? data.skipped : []),
  ].map(id => String(id).toLowerCase()))
  return normalizedRequested.filter(id => !skipped.has(id))
}

function changedBatchModeIds(data: BatchModeMutationResponse | undefined, requestedIds: string[]) {
  const normalizedRequested = requestedIds.map(id => String(id).toLowerCase())
  if (Array.isArray(data?.updatedIds)) {
    const requested = new Set(normalizedRequested)
    return [...new Set(data.updatedIds
      .map(id => String(id).toLowerCase())
      .filter(id => requested.has(id)))]
  }
  const skipped = new Set(
    (Array.isArray(data?.skipped) ? data.skipped : []).map(id => String(id).toLowerCase()),
  )
  return normalizedRequested.filter(id => !skipped.has(id))
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
  const [triageStatus, setTriageStatus] = useState(initial?.status ?? '')
  const [ticketStatusFilter, setTicketStatusFilter] = useState<TicketStatusFilterValue>(() => {
    if (initial?.status !== 'ticketed') return ''
    return initial?.ticketStatus === 'active' || initial?.ticketStatus === 'closed'
      ? initial.ticketStatus
      : 'all'
  })
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
  const [drawerInitialTab, setDrawerInitialTab] = useState<'content' | 'history'>('content')
  const [ticketCloseNotice, setTicketCloseNotice] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchFeedback, setBatchFeedback] = useState<BatchFeedback | null>(null)
  const batchFeedbackTimer = useRef<number | undefined>(undefined)
  const customTagRequestSeq = useRef(0)
  const { ask, dialog } = useNotePrompt()
  const { dispatch, dialog: dispatchDialog } = useTicketDispatch()

  const sel = useSelection(`${archiveView}|${triageStatus}|${ticketStatusFilter}|${risk}|${identity}|${platform}|${sentiment}|${keyword}|${customTagIds}|${dateRanges.publish.from}|${dateRanges.publish.to}|${dateRanges.recent.from}|${dateRanges.recent.to}|${dateRanges.first.from}|${dateRanges.first.to}|${pageSize}|${pagination?.page ?? 1}`)

  const showBatchFeedback = useCallback((message: string, tone: BatchFeedback['tone']) => {
    window.clearTimeout(batchFeedbackTimer.current)
    setBatchFeedback({ message, tone })
    batchFeedbackTimer.current = window.setTimeout(() => setBatchFeedback(null), 3600)
  }, [])

  useEffect(() => () => window.clearTimeout(batchFeedbackTimer.current), [])

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
    if (triageStatus === 'ticketed' && (ticketStatusFilter === 'active' || ticketStatusFilter === 'closed')) {
      params.set('ticketStatus', ticketStatusFilter)
    }
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
  }, [archiveView, triageStatus, ticketStatusFilter, risk, identity, sentiment, platform, keyword, sort, captureKeywords, customTagIds, dateRanges])

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
  const ticketOnly = triageStatus === 'ticketed'
  const handlingStatus = ticketOnly ? '' : triageStatus
  const visibleTicketStatusFilter: TicketStatusFilterValue = ticketOnly ? (ticketStatusFilter || 'all') : ''
  const activeDateFilterCount = Object.values(dateRanges).filter(range => range.from || range.to).length
  const hasCustomSort = sort.field !== 'publish' || sort.dir !== 'desc'
  const hasActiveFilters = Boolean(platform || sentiment || keyword || triageStatus || risk.length || identity.length || captureKeywords.length || (view === 'list' && customTagIds.length) || activeDateFilterCount || hasCustomSort)
  const activeFilterCount = [platform, sentiment, triageStatus].filter(Boolean).length
    + Number(Boolean(keyword)) + risk.length + identity.length + captureKeywords.length + customTagIds.length + activeDateFilterCount + Number(hasCustomSort)
  const clearFilters = () => {
    setPlatform(''); setSentiment(''); setKeyword(''); setTriageStatus(''); setTicketStatusFilter(''); setRisk([]); setIdentity([]); setCaptureKeywords([]); setCustomTagIds([]); setDateRanges(emptyDateRanges())
    setSort({ field: 'publish', dir: 'desc' })
  }
  const changeHandlingStatusFilter = (value: string) => {
    setTriageStatus(value)
    setTicketStatusFilter('')
  }
  const changeTicketStatusFilter = (value: TicketStatusFilterValue) => {
    setTicketStatusFilter(value)
    setTriageStatus(value ? 'ticketed' : '')
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
    let data: ManualFieldsMutationResponse
    try {
      data = await api.patch<ManualFieldsMutationResponse>('/records/' + recordId + '/manual-fields', fields)
    } catch (error) {
      if (!isApiNetworkError(error)) throw error
      const verified = await verifyManualFieldsSaved(recordId, fields).catch(() => null)
      if (!verified) {
        const verificationError = new Error(
          '网络连接中断，暂时无法确认是否保存；请刷新页面核对后再操作，避免重复提交。',
        ) as Error & { cause?: unknown }
        verificationError.cause = error
        throw verificationError
      }
      console.warn('保存响应中断，已通过当前记录状态确认修改成功')
      data = { record: verified }
    }

    const savedRecord = responseRecord(data)
    const patch = localManualFieldsPatch(fields, savedRecord)
    const savedSentiment = savedRecord && Object.prototype.hasOwnProperty.call(savedRecord, 'sentiment')
      ? String(savedRecord.sentiment || '')
      : fields.sentiment
    const leavesCurrentSentiment = Boolean(sentiment && savedSentiment !== undefined && savedSentiment !== sentiment)
    setRecords(current => current.flatMap(record => {
      if (record.id !== recordId) return [record]
      return leavesCurrentSentiment ? [] : [{ ...record, ...patch }]
    }))
    if (leavesCurrentSentiment) {
      setPagination(current => {
        if (!current) return current
        const total = Math.max(0, current.total - 1)
        return { ...current, total, totalPages: Math.ceil(total / pageSize) }
      })
    }
    setDrawerRecord(null)
    // 数据已保存即返回成功；列表与角标刷新是尽力而为，不能反向把成功写入误报成失败。
    void reloadAfterMutation().catch(error => console.warn('保存后的列表刷新失败', error))
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

  const dispatchTicket = async (record: any): Promise<boolean> => {
    if (archiveView === 'archived' || record.archived_at) return false
    const r = await dispatch({ sourceType: 'content', summary: record.title || record.content, defaultPriority: record.triage_priority })
    if (!r) return false
    await api.post('/tickets', { sourceType: 'content', sourceId: record.id, externalTicketNo: r.externalTicketNo, priority: r.priority, assigneeUserId: r.assigneeUserId, assigneeName: r.assigneeName, note: r.note })
    await reloadAfterMutation()
    setBoardNonce(n => n + 1)
    return true
  }

  const saveInlineTicketNumber = useCallback(async (record: any, value: string): Promise<TicketNumberSaveResult> => {
    const externalTicketNo = value.trim()
    if (!record?.ticket_id || !externalTicketNo) return { ok: false, message: '请输入工单号' }
    const previousExternalTicketNo = String(record.ticket_number || '').trim()
    const closedNumberBackfill = record.ticket_status === 'closed' && !previousExternalTicketNo
    if ((record.ticket_status === 'closed' || record.archived_at) && !closedNumberBackfill) {
      return { ok: false, message: record.ticket_status === 'closed' ? '该工单已结案，不能修改号码' : '该内容已归档，不能修改工单号' }
    }
    try {
      const response = await api.patch<{ ticket?: { external_ticket_no?: string } }>(
        `/tickets/${record.ticket_id}/external-number`,
        {
          externalTicketNo,
          previousExternalTicketNo,
        },
      )
      const savedNumber = String(response.ticket?.external_ticket_no || externalTicketNo).trim()
      setRecords(current => current.map(item => item.id === record.id
        ? { ...item, ticket_number: savedNumber, matched_ticket_number: '' }
        : item))
      setDrawerRecord((current: any) => current?.id === record.id
        ? { ...current, ticket_number: savedNumber, matched_ticket_number: '' }
        : current)
      setBoardNonce(n => n + 1)
      if (keyword.trim()) await load(pagination?.page || 1, { silent: true })
      return { ok: true }
    } catch (error) {
      console.error(error)
      return { ok: false, message: error instanceof Error ? error.message : '工单号保存失败' }
    }
  }, [keyword, load, pagination])

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
    if (newStatus === 'ticketed') return false
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

  const changeRecordMode = (record: any, newStatus: TriageMode) => (
    newStatus === 'ticketed' ? dispatchTicket(record) : changeTriageMode(record.id, newStatus)
  )

  const runBatch = async (newStatus: TriageMode) => {
    if (archiveView === 'archived' || sel.count === 0) return
    setBatchFeedback(null)
    setBatchBusy(true)
    try {
      const ids = [...sel.selected]
      const result = await api.patch<BatchModeMutationResponse>('/triage/records/batch', { ids, status: newStatus })
      const changedIds = changedBatchModeIds(result, ids)
      const skippedCount = Math.max(0, ids.length - changedIds.length)
      const modeLabel = CONTENT_TRIAGE_MODES.find(mode => mode.value === newStatus)?.label || newStatus
      const page = pagination?.page || 1
      const changedSet = new Set(changedIds)
      const changedOnPage = records.filter(record => changedSet.has(String(record.id).toLowerCase())).length
      const targetPage = !modeVisibleInCurrentList(newStatus) && changedOnPage >= records.length && page > 1 ? page - 1 : page

      if (changedIds.length === 0) {
        showBatchFeedback('所选内容未能修改，列表已刷新，请重新选择后再试', 'error')
        await load(page, { silent: true })
        return
      }

      syncModeLocally(changedIds, newStatus)
      sel.clear()
      showBatchFeedback(
        skippedCount > 0
          ? `已将 ${changedIds.length} 条改为“${modeLabel}”，另有 ${skippedCount} 条未修改`
          : `已将 ${changedIds.length} 条内容改为“${modeLabel}”`,
        skippedCount > 0 ? 'warning' : 'success',
      )
      refreshBadges()
      await load(targetPage, { silent: true })
    } catch (err) {
      console.error(err)
      showBatchFeedback(`批量修改失败：${err instanceof Error ? err.message : '请稍后重试'}`, 'error')
    }
    finally { setBatchBusy(false) }
  }

  const syncArchiveLocally = useCallback((ids: Iterable<string>) => {
    const changed = new Set([...ids].map(id => String(id).toLowerCase()))
    setRecords(current => current.filter(record => !changed.has(String(record.id).toLowerCase())))
    setDrawerRecord((current: any) => current && changed.has(String(current.id).toLowerCase()) ? null : current)
  }, [])

  const changeArchive = useCallback(async (recordId: string, archived: boolean): Promise<boolean> => {
    if (modeBusyId || archiveBusyId) return false
    setArchiveBusyId(recordId)
    try {
      const result = await api.patch('/triage/records/archive', { ids: [recordId], archived }) as ArchiveMutationResponse
      const changedIds = changedArchiveIds(result, [recordId])
      const page = pagination?.page || 1
      const targetPage = changedIds.length > 0 && records.length <= 1 && page > 1 ? page - 1 : page
      if (changedIds.length > 0) syncArchiveLocally(changedIds)
      refreshBadges()
      await load(targetPage, { silent: true })
      return changedIds.includes(recordId.toLowerCase())
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
      const result = await api.patch('/triage/records/archive', { ids, archived }) as ArchiveMutationResponse
      const changedIds = changedArchiveIds(result, ids)
      const changedSet = new Set(changedIds)
      const page = pagination?.page || 1
      const changedOnPage = records.filter(record => changedSet.has(String(record.id).toLowerCase())).length
      const targetPage = changedOnPage >= records.length && page > 1 ? page - 1 : page
      syncArchiveLocally(changedIds)
      sel.clear()
      refreshBadges()
      await load(targetPage, { silent: true })
    } catch (err) { console.error(err) }
    finally { setBatchBusy(false) }
  }

  const interactions = (r: any) => Number(r.likes || 0) + Number(r.comments_count || 0) + Number(r.collects || 0) + Number(r.shares || 0)
  const allChecked = records.length > 0 && records.every(r => sel.has(r.id))
  const someChecked = records.some(r => sel.has(r.id))
  const contentStatusOptions: Array<[string, string]> = [
    ['unhandled', '待处理'],
    ['reviewing', '负面流程'],
    ['official_responded', '官方已评'],
    ['no_action', '无需操作'],
  ]

  const narrow = false
  const drawerArchived = Boolean(drawerRecord?.archived_at)
  const openDrawer = (record: any, initialTab: 'content' | 'history' = 'content') => {
    setDrawerInitialTab(initialTab)
    setDrawerRecord(record)
  }
  const drawerProps = drawerRecord ? {
    record: drawerRecord,
    onClose: () => setDrawerRecord(null),
    canWrite: canWrite(),
    onLinkIssue: async () => {
      const changed = await dispatchTicket(drawerRecord)
      if (changed) setDrawerRecord(null)
      return changed
    },
    onSetStatus: drawerArchived ? undefined : async (s: string) => {
      return changeRecordMode(drawerRecord, s as TriageMode)
    },
    onMarkResponded: drawerArchived ? undefined : async () => changeTriageMode(drawerRecord.id, 'official_responded'),
    onSetArchived: async (archived: boolean) => changeArchive(drawerRecord.id, archived),
    onFalsePositive: drawerArchived ? undefined : () => markFalsePositive(drawerRecord.id),
    falsePositivePending: Boolean(drawerRecord.false_positive_pending),
    onUpdateFields: drawerArchived ? undefined : (fields: ManualRecordFields) => updateManualFields(drawerRecord.id, fields),
    customTagCatalog,
    onUpdateCustomTags: drawerArchived ? undefined : (patch: CustomTagPatch) => updateCustomTags(drawerRecord.id, patch),
    initialTab: drawerInitialTab,
    onTicketNumberAdded: (externalTicketNo: string) => {
      setRecords(current => current.map(record => record.id === drawerRecord.id
        ? { ...record, ticket_number: externalTicketNo }
        : record))
      setDrawerRecord((current: any) => current?.id === drawerRecord.id
        ? { ...current, ticket_number: externalTicketNo }
        : current)
      setBoardNonce(n => n + 1)
    },
    onTicketStatusChanged: (ticketStatus: string) => {
      setRecords(current => current.map(record => record.id === drawerRecord.id
        ? { ...record, ticket_status: ticketStatus }
        : record))
      setDrawerRecord((current: any) => current?.id === drawerRecord.id
        ? { ...current, ticket_status: ticketStatus }
        : current)
      setBoardNonce(n => n + 1)
    },
    onProgressAdded: (progress: RecordProgressSummary) => {
      const recordId = drawerRecord.id
      const applyProgress = (record: any) => {
        const activeTicket = Boolean(record.ticket_id && record.ticket_status !== 'closed')
        return {
          ...record,
          progress_count: Number(record.progress_count || 0) + 1,
          progress_latest_body: progress.body,
          progress_latest_author: progress.authorName,
          progress_latest_at: progress.createdAt,
          progress_latest_type: progress.eventType,
          ...(activeTicket ? {
            ticket_notes_count: Number(record.ticket_notes_count || 0) + 1,
            ticket_latest_note: progress.body,
            ticket_latest_note_author: progress.authorName,
            ticket_latest_note_at: progress.createdAt,
            ticket_latest_note_type: progress.eventType,
          } : {}),
        }
      }
      setRecords(current => current.map(record => record.id === recordId ? applyProgress(record) : record))
      setDrawerRecord((current: any) => current?.id === recordId ? applyProgress(current) : current)
    },
    onTicketClosed: async (result: ContentTicketCloseResult) => {
      const recordId = String(drawerRecord.id)
      const page = pagination?.page || 1
      const recordArchived = result.recordArchived === true
      const targetPage = recordArchived && records.length <= 1 && page > 1 ? page - 1 : page
      if (recordArchived) {
        setTicketCloseNotice('')
        syncArchiveLocally([recordId])
      } else {
        const blockingTicket = String(result.blockingActiveTicketNumber || '').trim()
        setDrawerRecord(null)
        setTicketCloseNotice(result.recordArchiveBlockedByActiveTicket
          ? `本工单已结案，但该内容仍有另一张活动工单${blockingTicket ? `（${blockingTicket}）` : ''}，因此继续保留在“工作中”。`
          : '本工单已结案，但内容归档状态未确认，已保留在“工作中”并刷新列表。')
      }
      setBoardNonce(n => n + 1)
      refreshBadges()
      await load(targetPage, { silent: true })
    },
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
  const emptyTitle = hasActiveFilters
    ? '没有搜索结果'
    : archiveView === 'archived' ? '暂无已归档内容' : '暂无记录'
  const emptyDescription = hasActiveFilters
    ? '调整表头筛选或清空筛选条件后重试'
    : archiveView === 'archived' ? '客户主动归档的内容会显示在这里' : '暂无可处理内容'
  const EmptyIcon = hasActiveFilters ? Search : archiveView === 'archived' ? Archive : Inbox

  return (
    <div className={cn('space-y-3', view === 'list' && 'lg:w-max lg:min-w-full')}>
      {batchFeedback && (
        <div
          role={batchFeedback.tone === 'error' ? 'alert' : 'status'}
          aria-live={batchFeedback.tone === 'error' ? 'assertive' : 'polite'}
          className={cn(
            'fixed left-1/2 top-4 z-[80] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border bg-card px-3 py-2 text-[12px] font-medium shadow-lg animate-in fade-in slide-in-from-top-2',
            batchFeedback.tone === 'success' && 'border-status-green/30 text-emerald-700 dark:text-emerald-300',
            batchFeedback.tone === 'warning' && 'border-status-orange/30 text-amber-700 dark:text-amber-300',
            batchFeedback.tone === 'error' && 'border-destructive/30 text-destructive',
          )}
        >
          {batchFeedback.tone === 'success'
            ? <CheckCircle className="h-4 w-4 shrink-0" />
            : batchFeedback.tone === 'warning'
              ? <Bell className="h-4 w-4 shrink-0" />
              : <CircleOff className="h-4 w-4 shrink-0" />}
          <span className="min-w-0 leading-5">{batchFeedback.message}</span>
          <button
            type="button"
            onClick={() => setBatchFeedback(null)}
            aria-label="关闭批量处理提示"
            className="ml-1 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {ticketCloseNotice && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/[0.05] px-3 py-2.5 text-[12px] text-foreground">
          <ClipboardCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 leading-5">{ticketCloseNotice}</span>
          <button type="button" onClick={() => setTicketCloseNotice('')} aria-label="关闭结案提示"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="sticky left-0 z-30 !mb-0 space-y-2 border-b border-border/60 bg-background pb-3 lg:-mx-6 lg:w-[calc(100cqw-6px)] lg:px-6">
        <div data-triage-toolbar="primary" className="flex flex-wrap items-center gap-2">
          <div className="inline-flex h-10 items-center rounded-lg border border-border/80 bg-muted/55 p-0.5 lg:h-8" role="tablist" aria-label="内容归档范围">
            {ARCHIVE_VIEWS.map(item => {
              const Icon = item.icon
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => {
                    setArchiveView(item.value)
                    setTriageStatus('')
                    setTicketStatusFilter('')
                    if (item.value === 'archived') setView('list')
                  }}
                  role="tab"
                  aria-selected={archiveView === item.value}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold transition-colors lg:h-7',
                    archiveView === item.value
                      ? 'bg-card text-foreground shadow-sm ring-1 ring-border/80'
                      : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />{item.label}
                </button>
              )
            })}
          </div>

          <div className="order-last flex w-full min-w-0 items-center gap-2 lg:order-none lg:w-auto lg:min-w-[140px] lg:max-w-[680px] lg:flex-1">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={keyword} onChange={e => setKeyword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { load(); setBoardNonce(n => n + 1) } }} placeholder="搜索标题、正文、作者、工单号…" className="h-10 w-full border-transparent bg-muted pl-8 text-[12px] focus:bg-card lg:h-8" />
            </div>
            <button
              type="button"
              onClick={() => setMobileFiltersOpen(open => !open)}
              aria-expanded={mobileFiltersOpen}
              className={cn(
                'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold lg:hidden',
                mobileFiltersOpen || activeFilterCount > 0 ? 'border-primary/25 bg-accent text-primary' : 'border-border bg-card text-muted-foreground',
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />筛选
              {activeFilterCount > 0 && <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">{activeFilterCount}</span>}
            </button>
          </div>

          <div className="hidden shrink-0 lg:block">
            <MultiSelect label="疑似身份" options={IDENTITY_OPTIONS} value={identity} onChange={setIdentity} />
          </div>

          <div className="hidden shrink-0 lg:block">
            <KeywordFilter value={captureKeywords} onChange={setCaptureKeywords} />
          </div>

          <div className="hidden shrink-0 lg:block">
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
          </div>

          {archiveView === 'active' && (
            <div className="hidden h-8 shrink-0 items-center rounded-lg border border-border/80 bg-muted/55 p-0.5 lg:inline-flex" role="group" aria-label="视图模式">
              {([['list', '列表', Rows3], ['board', '看板', Kanban]] as const).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={view === value}
                  onClick={() => setView(value)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-semibold transition-colors',
                    view === value
                      ? 'bg-card text-foreground shadow-sm ring-1 ring-border/80'
                      : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />{label}
                </button>
              ))}
            </div>
          )}

          <div className="ml-auto inline-flex shrink-0 items-center justify-end gap-1">
            {view === 'list' && (
              <Button variant="outline" size="sm" onClick={exportXlsx} disabled={exporting} title="导出当前筛选结果为 Excel">
                <Download className={cn('h-3.5 w-3.5', exporting && 'animate-pulse')} />
                {exporting ? '导出中…' : '导出'}
              </Button>
            )}
          </div>
        </div>

        <div
          role="group"
          aria-label="内容筛选"
          data-triage-toolbar="secondary"
          className={cn(
            'w-full flex-wrap items-center gap-2 rounded-xl bg-muted/30 p-3',
            mobileFiltersOpen ? 'flex' : 'hidden',
            'lg:flex lg:min-h-8 lg:rounded-none lg:bg-transparent lg:p-0',
            view === 'list' && 'xl:grid xl:grid-cols-[232px_repeat(7,minmax(0,1fr))_58px]',
          )}
        >
          <div className="contents lg:hidden">
            <MultiSelect label="风险信号" options={RISK_OPTIONS} value={risk} onChange={setRisk} />
            <MultiSelect label="疑似身份" options={IDENTITY_OPTIONS} value={identity} onChange={setIdentity} />
            <KeywordFilter value={captureKeywords} onChange={setCaptureKeywords} />
            <MultiSelect
              label="自定义标签"
              options={customTagCatalog.map(tag => ({ value: tag.id, label: tag.name, count: tag.usageCount }))}
              value={customTagIds}
              onChange={setCustomTagIds}
              width="w-64"
              searchable
              searchPlaceholder="搜索自定义标签…"
              emptyText="暂无自定义标签"
              onSearch={loadCustomTagCatalog}
            />
          </div>

          <div role="group" aria-label="情感筛选" className="mobile-table-scroll inline-flex h-10 max-w-full items-center overflow-x-auto rounded-lg bg-muted p-0.5 lg:h-8 xl:w-full">
            {([['', '全部情感'], ['negative', '负面'], ['neutral', '中性'], ['positive', '正面']] as const).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={sentiment === value} onClick={() => setSentiment(value)}
                className={cn('inline-flex h-9 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium transition-colors lg:h-7 xl:flex-1 xl:px-2',
                  sentiment === value ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                {label}
              </button>
            ))}
          </div>

          {view === 'list' && (
            <>
              <div className="w-full lg:w-[124px] xl:w-full">
                <TriageSelect value={handlingStatus} onChange={e => changeHandlingStatusFilter(e.target.value)}
                  aria-label="处理模式筛选"
                  className={cn('bg-muted font-medium hover:bg-muted/70', handlingStatus ? 'text-foreground' : 'text-muted-foreground')}>
                  <option value="">全部模式</option>
                  {contentStatusOptions.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </TriageSelect>
              </div>
              <div className="w-full lg:w-[94px] xl:w-[94px] xl:justify-self-center">
                <TicketStatusFilter value={visibleTicketStatusFilter} onChange={changeTicketStatusFilter} />
              </div>
            </>
          )}

          <div className="w-full lg:w-[108px] xl:w-full">
            <TriageSelect value={platform} onChange={e => setPlatform(e.target.value)}
              aria-label="平台筛选"
              className={cn('bg-muted font-medium hover:bg-muted/70', platform ? 'text-foreground' : 'text-muted-foreground')}>
              <option value="">全部平台</option>
              <option value="xiaohongshu">小红书</option>
              <option value="douyin">抖音</option>
              <option value="weibo">微博</option>
            </TriageSelect>
          </div>

          {view === 'list' && (
            <>
              <CombinedDateRangeFilter value={dateRanges} onChange={setDateRanges} triggerClassName="w-full justify-between lg:!w-[82px] lg:!px-2 xl:!w-full" />
              <div className="hidden shrink-0 lg:block">
                <MultiSelect label="风险信号" options={RISK_OPTIONS} value={risk} onChange={setRisk} triggerClassName="xl:w-full xl:justify-between" />
              </div>
            </>
          )}

          <button
            type="button"
            onClick={clearFilters}
            disabled={!hasActiveFilters}
            title={hasActiveFilters ? '清空所有筛选与排序' : '暂无筛选或自定义排序'}
            aria-label={hasActiveFilters ? `清空全部 ${activeFilterCount} 项筛选与排序` : '清空筛选与排序，当前无活动条件'}
            className="inline-flex h-10 w-[58px] shrink-0 items-center justify-center gap-1 rounded-lg text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:text-muted-foreground/35 disabled:hover:bg-transparent lg:h-8"
          >
            <X className="h-3.5 w-3.5" />清空
          </button>
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
          onOpen={record => openDrawer(record)}
          onDispatchTicket={dispatchTicket}
          refreshBadges={refreshBadges}
        />
      ) : loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="isolate overflow-visible rounded-xl bg-card lg:-mx-6 lg:rounded-none">
          <div className="divide-y divide-border/50 lg:hidden">
            {records.length === 0 ? (
              <EmptyState icon={EmptyIcon} title={emptyTitle} description={emptyDescription} />
            ) : records.map(r => (
              <MobileRecordCard
                key={r.id}
                record={r}
                canWrite={canWrite()}
                selected={sel.has(r.id)}
                onToggle={() => sel.toggle(r.id)}
                onChangeMode={(nextStatus: TriageMode) => changeRecordMode(r, nextStatus)}
                modeBusy={modeBusyId === r.id}
                modeDisabled={archiveView === 'archived' || modeBusyId !== null || archiveBusyId !== null}
                onSaveTicketNumber={(value: string) => saveInlineTicketNumber(r, value)}
                onArchive={() => changeArchive(r.id, archiveView === 'active')}
                archiveBusy={archiveBusyId === r.id}
                archived={archiveView === 'archived'}
                onOpenDetail={() => openDrawer(r)}
                interactions={interactions(r)}
              />
            ))}
          </div>
          <div
            data-triage-table-scroll
            className="relative hidden lg:block"
          >
          <table className="w-full min-w-[1080px] text-sm xl:min-w-full">
            <thead data-sticky-header className="sticky top-0 z-40 bg-card [&_th]:!h-12 [&_th]:!py-0">
              <tr className="h-12 border-b border-border/60 [&>th]:whitespace-nowrap">
                {canWrite() && (
                  <th className="w-8 pl-3 pr-0">
                    <Checkbox checked={allChecked} indeterminate={!allChecked && someChecked} onChange={() => sel.setAll(records.map(r => r.id), !allChecked)} />
                  </th>
                )}
                <th className="px-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">内容</th>
                {!narrow && (
                  <th className="px-1.5 text-left">
                    <HeaderSingleFilter
                      label="平台"
                      value={platform}
                      onChange={setPlatform}
                      options={[
                        { value: '', label: '全部平台' },
                        { value: 'xiaohongshu', label: '小红书' },
                        { value: 'douyin', label: '抖音' },
                        { value: 'weibo', label: '微博' },
                      ]}
                    />
                  </th>
                )}
                <th className="px-1.5 text-left">
                  <HeaderSingleFilter
                    label="情感"
                    value={sentiment}
                    onChange={setSentiment}
                    options={[
                      { value: '', label: '全部情感' },
                      { value: 'negative', label: '负面' },
                      { value: 'neutral', label: '中性' },
                      { value: 'positive', label: '正面' },
                    ]}
                  />
                </th>
                {!narrow && <th className="px-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">风险信号</th>}
                {!narrow && <th className="px-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">疑似身份</th>}
                {!narrow && <SortableTh label="互动" field="interactions" sort={sort} onSort={toggleSort} align="right" />}
                {!narrow && <SortableTh label="评论" field="comments" sort={sort} onSort={toggleSort} align="right" />}
                {!narrow && <SortableTh label="点赞" field="likes" sort={sort} onSort={toggleSort} align="right" />}
                {!narrow && <SortableTh label="发布时间" field="publish" sort={sort} onSort={toggleSort} className="hidden lg:table-cell" />}
                {!narrow && <SortableTh label="首次发现" field="first_seen" sort={sort} onSort={toggleSort} className="hidden xl:table-cell" />}
                {!narrow && <SortableTh label="最近采集" field="last_seen" sort={sort} onSort={toggleSort} className="hidden xl:table-cell" />}
                {!narrow && <th className="hidden whitespace-nowrap px-3 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground xl:table-cell">采集次数</th>}
                <th className="sticky right-0 z-50 w-[180px] min-w-[180px] bg-card pl-6 pr-2 text-left before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-border before:content-['']">
                  <div className="grid grid-cols-[88px_48px] items-center gap-2">
                    <div className="flex justify-center">
                      <HeaderSingleFilter
                        label="处理模式"
                        value={handlingStatus}
                        onChange={changeHandlingStatusFilter}
                        options={[
                          { value: '', label: '全部模式' },
                          ...contentStatusOptions.map(([value, label]) => ({ value, label })),
                        ]}
                      />
                    </div>
                    <span className="sr-only">处理记录</span>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {records.length === 0 ? (
                <tr>
                  <td colSpan={20} className="h-[280px]">
                    <EmptyState icon={EmptyIcon} title={emptyTitle} description={emptyDescription} />
                  </td>
                </tr>
              ) : records.map(r => (
                <RecordRow
                  key={r.id}
                  record={r}
                  canWrite={canWrite()}
                  narrow={narrow}
                  open={drawerRecord?.id === r.id}
                  selected={sel.has(r.id)}
                  onToggle={() => sel.toggle(r.id)}
                  onOpenProgress={() => openDrawer(r, 'history')}
                  onChangeMode={(nextStatus: TriageMode) => changeRecordMode(r, nextStatus)}
                  modeBusy={modeBusyId === r.id}
                  modeDisabled={archiveView === 'archived' || modeBusyId !== null || archiveBusyId !== null}
                  onSaveTicketNumber={(value: string) => saveInlineTicketNumber(r, value)}
                  onArchive={() => changeArchive(r.id, archiveView === 'active')}
                  archiveBusy={archiveBusyId === r.id}
                  archived={archiveView === 'archived'}
                  onOpenDetail={() => openDrawer(r)}
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
function MobileRecordCard({ record: r, canWrite, selected, onToggle, onChangeMode, modeBusy, modeDisabled, onSaveTicketNumber, onArchive, archiveBusy, archived, onOpenDetail, interactions }: any) {
  const cover = getCover(r)
  const customTags = tagsFromRecord(r)
  const tone = r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'
  const accentBar = recordAccentClass(r)
  const mobileIdentity = identityLabel(r.source_type, r.author_fans, r.author_name, r.identity_override)
  const hasRiskSignals = Number(r.alert_count || 0) > 0
    || Number(r.negative_comment_count || 0) > 0
    || String(r.content_availability_status || '') === 'deleted'
    || (r.official_response_status && r.official_response_status !== 'none')
  const availabilityLabel = contentAvailabilityLabel(r)
  const hasOpenTicket = Boolean(r.ticket_id && r.ticket_status !== 'closed')
  const ticketClosed = Boolean(r.ticket_id && r.ticket_status === 'closed')

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
      <span className={cn('absolute inset-y-3.5 left-0 w-1 rounded-r-full', accentBar)} />
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
        <TicketMarker record={r} canEditNumber={canWrite} onSaveNumber={onSaveTicketNumber} />
        {availabilityLabel && <StatusBadge tone="muted"><CircleOff className="h-3 w-3" />{availabilityLabel}</StatusBadge>}
        {canWrite && !archived ? (
          <TriageStatusMenu status={r.triage_status || 'unhandled'} ticketClosed={ticketClosed} hasOpenTicket={hasOpenTicket} busy={modeBusy} disabled={modeDisabled} onChange={onChangeMode} />
        ) : (
          <StatusBadge tone={ticketClosed ? 'resolved' : r.triage_status}>{ticketClosed ? '工单已结案' : (LABELS.triage[r.triage_status] || r.triage_status)}</StatusBadge>
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
          {canWrite && (archived || !hasOpenTicket) && (
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
function RecordRow({ record: r, canWrite, narrow, open, selected, onToggle, onOpenProgress, onChangeMode, modeBusy, modeDisabled, onSaveTicketNumber, onArchive, archiveBusy, archived, onOpenDetail, interactions }: any) {
  const cover = getCover(r)
  const customTags = tagsFromRecord(r)
  const accentBar = recordAccentClass(r)
  const tone = r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'
  const triageStatus = r.triage_status || 'unhandled'
  const availabilityLabel = contentAvailabilityLabel(r)
  const hasOpenTicket = Boolean(r.ticket_id && r.ticket_status !== 'closed')
  const ticketClosed = Boolean(r.ticket_id && r.ticket_status === 'closed')

  return (
    <tr data-record-detail-trigger className={cn('group cursor-pointer transition-colors', open ? 'bg-accent' : selected ? 'bg-primary/[0.05]' : 'hover:bg-accent/45')} onClick={onOpenDetail}>
      {canWrite && (
        <td className="py-3.5 pl-3 pr-0 align-middle" onClick={e => e.stopPropagation()}>
          <Checkbox checked={selected} onChange={onToggle} />
        </td>
      )}
      <td className="px-3 py-3.5 align-middle">
        <div className="flex items-center gap-3">
          <span className={cn('h-10 w-1 shrink-0 rounded-full', accentBar)} />
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
            {r.ticket_id && <TicketMarker record={r} className="mt-1" canEditNumber={canWrite} onSaveNumber={onSaveTicketNumber} />}
            {customTags.length > 0 && <RecordLabelChips tags={customTags} limit={2} compact className="mt-1" />}
          </div>
        </div>
      </td>
      {!narrow && <td className="px-3 py-3.5 align-middle"><StatusBadge tone="neutral" className={PLATFORM_BADGE_CLASS}>{platformName(r.platform)}</StatusBadge></td>}
      <td className="px-3 py-3.5 align-middle">
        <div className="flex flex-wrap gap-1">
          <StatusBadge tone={tone}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge>
          {availabilityLabel && <StatusBadge tone="muted"><CircleOff className="h-3 w-3" />{availabilityLabel}</StatusBadge>}
        </div>
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
      <td className={cn(
        "sticky right-0 z-20 w-[180px] min-w-[180px] pl-6 pr-2 py-3.5 align-middle transition-colors before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-border before:content-['']",
        open || selected ? 'bg-accent' : 'bg-card group-hover:bg-accent',
      )} onClick={e => e.stopPropagation()}>
        <div className="grid grid-cols-[88px_48px] items-center gap-2">
          {canWrite && !archived ? (
            <TriageStatusMenu
              status={triageStatus}
              ticketClosed={ticketClosed}
              hasOpenTicket={hasOpenTicket}
              busy={modeBusy}
              archiveBusy={archiveBusy}
              disabled={modeDisabled}
              onChange={onChangeMode}
              onArchiveChange={hasOpenTicket ? undefined : onArchive}
            />
          ) : (
            <StatusBadge tone={ticketClosed ? 'resolved' : triageStatus} className={TRIAGE_MODE_BADGE_CLASS}>{ticketClosed ? '工单已结案' : (LABELS.triage[triageStatus] || triageStatus)}</StatusBadge>
          )}
          <InlineRecordProgress record={r} onOpen={onOpenProgress} />
        </div>
      </td>
    </tr>
  )
}

const TICKET_EVENT_LABELS: Record<string, string> = {
  note: '新增进展',
  done: '处理完成',
  dismissed: '无需处理',
  closed: '已结案',
  reopened: '重新处理',
}

function InlineRecordProgress({ record, onOpen }: {
  record: any
  onOpen: () => void
}) {
  const latestBody = String(record.progress_latest_body || '').trim()
  const latestType = String(record.progress_latest_type || 'note')
  const latestPreview = latestBody || TICKET_EVENT_LABELS[latestType] || '暂无进展'
  const latestAuthor = String(record.progress_latest_author || '').trim()
  const latestAt = String(record.progress_latest_at || '')
  const notesCount = Number(record.progress_count || 0)
  const fullMeta = [latestAuthor, latestAt ? formatDateCompact(latestAt) : '']
    .filter(Boolean)
    .join(' · ')

  return (
    <button
      type="button"
      aria-label={notesCount > 0 ? `查看处理进展：${latestPreview}` : '查看并添加处理进展'}
      onClick={event => {
        event.stopPropagation()
        onOpen()
      }}
      onPointerDown={event => event.stopPropagation()}
      className="group/progress relative flex h-8 w-12 items-center justify-center gap-1 rounded-lg border border-primary/20 bg-primary/[0.06] text-primary outline-none transition-[color,background-color,border-color,box-shadow] hover:border-primary/35 hover:bg-primary/[0.12] hover:shadow-sm focus-visible:border-primary/35 focus-visible:bg-primary/[0.12] focus-visible:ring-2 focus-visible:ring-primary/20"
    >
      {notesCount > 0 ? (
        <>
          <MessageSquareText className="h-4 w-4 shrink-0" />
          <span className="text-[10px] font-semibold tabular-nums">{notesCount > 99 ? '99+' : notesCount}</span>
        </>
      ) : (
        <MessageSquarePlus className="h-4 w-4 shrink-0" />
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-[calc(100%+8px)] top-1/2 z-50 w-64 -translate-y-1/2 translate-x-2 rounded-lg border border-border bg-card px-3 py-2.5 text-left text-foreground opacity-0 shadow-xl transition-[opacity,transform] duration-150 group-hover/progress:translate-x-0 group-hover/progress:opacity-100 group-focus-visible/progress:translate-x-0 group-focus-visible/progress:opacity-100 motion-reduce:transition-none"
      >
        <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">最近进展</span>
        <span className={cn('mt-1 block line-clamp-2 text-[12px] font-medium leading-5', notesCount > 0 ? 'text-foreground' : 'text-muted-foreground')}>
          {latestPreview}
        </span>
        <span className="mt-1.5 block truncate text-[10px] text-muted-foreground">
          {fullMeta || '点击查看并添加'}
        </span>
      </span>
    </button>
  )
}

function TicketMarker({ record, className = '', canEditNumber = false, onSaveNumber }: {
  record: any
  className?: string
  canEditNumber?: boolean
  onSaveNumber?: (value: string) => Promise<TicketNumberSaveResult>
}) {
  const [editing, setEditing] = useState(false)
  if (!record?.ticket_id) return null
  const number = String(record.ticket_number || '').trim()
  const matchedNumber = String(record.matched_ticket_number || '').trim()
  const closed = record.ticket_status === 'closed'
  const closedNumberBackfill = closed && !number
  const editable = canEditNumber && Boolean(onSaveNumber)
    && ((!record.archived_at && !closed) || closedNumberBackfill)
  if (editing && editable && onSaveNumber) {
    return (
      <InlineTicketNumberEditor
        key={`${record.ticket_id}:${number}`}
        className={className}
        initialValue={number}
        onSave={onSaveNumber}
        onCancel={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />
    )
  }
  if (!number && editable) {
    return (
      <button
        type="button"
        className={cn('inline-flex h-5 items-center gap-1 rounded px-0.5 text-[10.5px] font-medium text-primary outline-none transition-colors hover:bg-primary/[0.06] focus-visible:bg-primary/[0.06]', className)}
        onClick={event => { event.stopPropagation(); setEditing(true) }}
        onPointerDown={event => event.stopPropagation()}
        aria-label="补录工单号"
        title="点击补录工单号"
      >
        <span>工单号</span><span aria-hidden>—</span>
      </button>
    )
  }
  const label = matchedNumber && matchedNumber !== number
    ? `匹配工单号 ${matchedNumber} · 当前工单号 ${number || '待补录'}`
    : (number ? `工单号 ${number}` : '工单号待补录')
  if (editable) {
    return (
      <span className={cn('inline-flex h-5 max-w-full items-center gap-0.5', className)} title={label}>
        <button
          type="button"
          className="inline-flex h-5 min-w-0 items-center gap-1.5 rounded px-0.5 text-[10.5px] outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
          onClick={event => { event.stopPropagation(); setEditing(true) }}
          onPointerDown={event => event.stopPropagation()}
          aria-label={`修改工单号：${number}`}
        >
          <span className="shrink-0 font-medium text-primary">工单号</span>
          <span className="max-w-40 truncate font-semibold text-foreground">{matchedNumber && matchedNumber !== number ? `${matchedNumber} / ${number}` : number}</span>
        </button>
        <CopyTicketNumberButton value={number} className="h-5 w-5 rounded" />
      </span>
    )
  }
  return (
    <span className={cn('inline-flex h-5 max-w-full items-center gap-0.5 text-[10.5px]', className)} title={label}>
      <span className="inline-flex min-w-0 items-center gap-1.5 px-0.5">
        <span className="shrink-0 font-medium text-primary">工单号</span>
        <span className="max-w-40 truncate font-semibold text-foreground">{number || '—'}</span>
      </span>
      <CopyTicketNumberButton value={number} className="h-5 w-5 rounded" />
    </span>
  )
}

function InlineTicketNumberEditor({ className = '', initialValue = '', onSave, onCancel, onSaved }: {
  className?: string
  initialValue?: string
  onSave: (value: string) => Promise<TicketNumberSaveResult>
  onCancel?: () => void
  onSaved?: () => void
}) {
  const [value, setValue] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)

  const save = async () => {
    const externalTicketNo = value.trim()
    if (!externalTicketNo || savingRef.current) return
    if (externalTicketNo === initialValue.trim()) {
      onSaved?.()
      return
    }
    savingRef.current = true
    setSaving(true)
    setError('')
    const result = await onSave(externalTicketNo)
    if (!result.ok) setError(result.message || '工单号保存失败')
    else onSaved?.()
    setSaving(false)
    savingRef.current = false
  }

  return (
    <div className={cn('inline-flex max-w-full flex-col items-start', className)}>
      <form
        onSubmit={event => { event.preventDefault(); event.stopPropagation(); void save() }}
        onClick={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel?.()
          }
        }}
        className="inline-flex h-6 max-w-full items-center gap-1.5"
      >
        <span className="shrink-0 text-[10.5px] font-medium text-primary">工单号</span>
        <input
          autoFocus
          value={value}
          maxLength={100}
          autoComplete="off"
          onChange={event => { setValue(event.target.value); setError('') }}
          onBlur={() => {
            if (value.trim()) void save()
            else onCancel?.()
          }}
          placeholder="输入工单号"
          aria-label="补录工单号"
          disabled={saving}
          className={cn(
            'ticket-number-input h-6 w-28 min-w-0 rounded-none border-0 border-b bg-transparent px-0.5 text-[11px] font-medium text-foreground outline-none transition-colors placeholder:text-muted-foreground/55 disabled:opacity-60',
            error ? 'border-destructive' : 'border-border focus:border-primary',
          )}
        />
      </form>
      {error && <span role="alert" className="mt-1 max-w-44 text-[10px] font-medium leading-3 text-destructive">{error}</span>}
    </div>
  )
}

function TriageStatusMenu({ status, ticketClosed, hasOpenTicket, busy, archiveBusy, disabled, onChange, onArchiveChange }: {
  status: string
  ticketClosed?: boolean
  hasOpenTicket?: boolean
  busy?: boolean
  archiveBusy?: boolean
  disabled?: boolean
  onChange: (status: TriageMode) => void | Promise<unknown>
  onArchiveChange?: () => void | Promise<unknown>
}) {
  const label = ticketClosed ? '工单已结案' : (LABELS.triage[status] || status || '待处理')
  const ticketActive = status === 'ticketed'
  const ticketBranchLabel = hasOpenTicket || ticketActive ? '已转工单' : '转工单'
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={busy || archiveBusy || disabled}
          aria-label={`当前处理模式：${label}，点击修改`}
          onClick={event => event.stopPropagation()}
          className="rounded-full outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <StatusBadge tone={ticketClosed ? 'resolved' : status} className={cn(TRIAGE_MODE_BADGE_CLASS, 'gap-1 transition-[filter,box-shadow] hover:brightness-95 hover:shadow-sm')}>
            <span className="min-w-0 flex-1 text-center">{label}</span>
            {busy || archiveBusy ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
          </StatusBadge>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          collisionPadding={10}
          onClick={event => event.stopPropagation()}
          className="z-[100] w-[196px] max-w-[calc(100vw-16px)] animate-in fade-in zoom-in-95 rounded-lg border border-border bg-card p-1.5 text-foreground shadow-lg"
        >
          <div className="px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground">处理模式</div>
          <DropdownMenu.Separator className="mb-1 h-px bg-border/70" />
          <DropdownMenu.RadioGroup value={status} aria-label="内容处理模式">
            {CONTENT_TRIAGE_MODES.map(option => {
              const active = option.value === status
              const Icon = option.icon
              return (
                <DropdownMenu.RadioItem
                  key={option.value}
                  value={option.value}
                  disabled={busy || disabled || hasOpenTicket}
                  onSelect={() => { if (!active) void onChange(option.value) }}
                  className="flex h-10 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-[13px] text-foreground outline-none transition-colors data-[disabled]:opacity-45 data-[highlighted]:bg-accent"
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className={cn(active && 'font-semibold')}>{option.label}</span>
                  <span className="ml-auto flex h-4 w-4 items-center justify-center">
                    <DropdownMenu.ItemIndicator>
                      <Check className="h-4 w-4 text-primary" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                </DropdownMenu.RadioItem>
              )
            })}
          </DropdownMenu.RadioGroup>
          {onArchiveChange && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border/70" />
              <DropdownMenu.Item
                disabled={busy || archiveBusy || disabled}
                onSelect={() => { void onArchiveChange() }}
                className="flex h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-foreground"
              >
                <Archive className="h-4 w-4 shrink-0" />
                <span>归档</span>
              </DropdownMenu.Item>
            </>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-border/70" />
          <DropdownMenu.Item
            onSelect={() => { if (!hasOpenTicket && !ticketActive) void onChange(TICKET_TRIAGE_MODE.value) }}
            aria-current={ticketActive ? 'true' : undefined}
            className="flex h-10 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-[13px] font-semibold text-primary outline-none transition-colors data-[highlighted]:bg-primary/[0.08]"
          >
            <ClipboardCheck className="h-4 w-4 shrink-0" />
            <span>{ticketBranchLabel}</span>
          </DropdownMenu.Item>
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

/* 风险信号:预警 / 负面评论数 / 已删帖,一眼可扫 */
function RiskSignals({ record: r }: any) {
  const alerts = Number(r.alert_count || 0)
  const neg = Number(r.negative_comment_count || 0)
  const deleted = String(r.content_availability_status || '') === 'deleted'
  if (!(alerts > 0 || neg > 0 || deleted)) {
    return <span className="text-[11px] text-muted-foreground/40">—</span>
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {alerts > 0 && (
        <Tooltip text={r.alert_reasons || '已触发预警规则,建议优先处理'}>
          <span className="inline-flex cursor-help items-center rounded bg-status-red/12 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-300">预警{alerts}</span>
        </Tooltip>
      )}
      {neg > 0 && (
        <Tooltip text="该内容下被判为负面/风险的评论条数;点开详情可查看具体评论">
          <span className="cursor-help rounded bg-status-orange/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">负评{neg}</span>
        </Tooltip>
      )}
      {deleted && (
        <Tooltip text="负面巡查已确认平台提示该内容已删除">
          <span className="inline-flex cursor-help items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground"><CircleOff className="h-3 w-3" />已删帖</span>
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
