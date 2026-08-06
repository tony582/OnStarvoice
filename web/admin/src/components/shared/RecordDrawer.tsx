import { useCallback, useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  LinkIcon, CheckCircle, Loader2, X, Heart, MessageCircle, Star, Share2,
  ExternalLink, User, FileText, Camera, Bell, Archive, ArchiveRestore, Eye, Sparkles, ZoomIn,
  Pencil, Ban, ArrowLeft, ArrowRight, History, StickyNote, Tags, AlertTriangle,
  Copy, RefreshCw, Radar, ClipboardCheck, Inbox, CircleOff, ChevronDown, Check,
} from 'lucide-react'

const PANEL_MIN = 480, PANEL_MAX = 900, PANEL_DEFAULT = 620
import { api } from '@/lib/api'
import { formatNumber, formatDate, formatFullDateSec, LABELS, platformName, cn, identityLabel, friendlyError, proxiedImg } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { Tooltip } from '@/components/shared/Tooltip'
import { CopyTicketNumberButton } from '@/components/shared/CopyTicketNumberButton'
import { RecordImageGallery } from '@/components/shared/RecordImageGallery'
import {
  recordDisplayImageEntries,
  recordDisplayImages,
} from '@/components/shared/record-images'
import {
  RecordLabelChips, RecordLabelEditor, RecordLabelsHeading,
} from '@/components/shared/RecordLabels'
import { tagsFromRecord, type CustomTag, type CustomTagPatch } from '@/lib/custom-tags'

/**
 * 内容详情抽屉。写操作由调用方持有，抽屉保留当前内容并同步处理记录。
 */
export interface ManualRecordFields {
  sentiment?: string
  category?: string
  identityOverride?: string
  publishTime?: string
}

interface RecordActivity {
  id: string
  action: string
  metadata?: Record<string, unknown> | string | null
  actor_name?: string
  created_at?: string
}

type AsyncDrawerAction = () => Promise<boolean | void> | boolean | void
type RecordDrawerTab = 'content' | 'comments' | 'official' | 'snapshot' | 'patrol' | 'history'

export interface ContentTicketCloseResult {
  recordArchived?: boolean
  recordArchiveBlockedByActiveTicket?: boolean
  blockingActiveTicketId?: string | null
  blockingActiveTicketNumber?: string | null
}

export interface RecordProgressSummary {
  body: string
  authorName: string
  createdAt: string
  eventType: string
}

interface RecordDrawerProps {
  record: any
  onClose: () => void
  canWrite: boolean
  onLinkIssue: AsyncDrawerAction
  onSetStatus?: (status: string) => Promise<boolean | void> | boolean | void
  onMarkResponded?: AsyncDrawerAction
  onSetArchived?: (archived: boolean) => Promise<boolean | void> | boolean | void
  onFalsePositive?: AsyncDrawerAction
  falsePositivePending?: boolean
  onUpdateFields?: (fields: ManualRecordFields) => Promise<boolean | void> | boolean | void
  customTagCatalog?: CustomTag[]
  onUpdateCustomTags?: (patch: CustomTagPatch) => Promise<CustomTag[]>
  initialTab?: RecordDrawerTab
  onTicketNumberAdded?: (externalTicketNo: string) => void
  onTicketStatusChanged?: (status: string) => void
  onProgressAdded?: (progress: RecordProgressSummary) => void
  onTicketClosed?: (result: ContentTicketCloseResult) => Promise<void> | void
}

export function RecordDrawer(props: RecordDrawerProps) {
  return <RecordDrawerContent key={`${String(props.record?.id ?? '')}:${props.initialTab || 'content'}`} {...props} />
}

function RecordDrawerContent({
  record: r,
  onClose,
  canWrite,
  onLinkIssue,
  onSetStatus,
  onMarkResponded,
  onSetArchived,
  onFalsePositive,
  falsePositivePending = false,
  onUpdateFields,
  customTagCatalog = [],
  onUpdateCustomTags,
  initialTab = 'content',
  onTicketNumberAdded,
  onTicketStatusChanged,
  onProgressAdded,
  onTicketClosed,
}: RecordDrawerProps) {
  const [tab, setTab] = useState<RecordDrawerTab>(initialTab)
  const [comments, setComments] = useState<any[]>([])
  const [officialResponses, setOfficialResponses] = useState<any[]>([])
  const [observations, setObservations] = useState<any[]>([])
  const [activity, setActivity] = useState<RecordActivity[]>([])
  const [loadedRecordId, setLoadedRecordId] = useState('')
  const [loading, setLoading] = useState(true)
  const [lightbox, setLightbox] = useState<string>('') // 点击放大的图片 URL(''=关闭)
  const [editingJudgement, setEditingJudgement] = useState(false)
  const [editingLabels, setEditingLabels] = useState(false)
  const [editDraft, setEditDraft] = useState(() => manualDraft(r))
  const [editError, setEditError] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [savingLabels, setSavingLabels] = useState(false)
  const [statusBusy, setStatusBusy] = useState(false)
  const [falsePositiveBusy, setFalsePositiveBusy] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [noteError, setNoteError] = useState('')
  const [actionError, setActionError] = useState('')
  const [ticketCloseConfirmOpen, setTicketCloseConfirmOpen] = useState(false)
  const [ticketCloseNote, setTicketCloseNote] = useState('')
  const [ticketStatus, setTicketStatus] = useState(String(r.ticket_status || ''))
  const [ticketNumber, setTicketNumber] = useState(String(r.ticket_number || ''))
  const [ticketNumberDraft, setTicketNumberDraft] = useState(String(r.ticket_number || ''))
  const [editingTicketNumber, setEditingTicketNumber] = useState(false)
  const [savingTicketNumber, setSavingTicketNumber] = useState(false)
  const [ticketNumberError, setTicketNumberError] = useState('')
  const ticketNumberCancelRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('osv_detail_width'))
    return saved >= PANEL_MIN && saved <= PANEL_MAX ? saved : PANEL_DEFAULT
  })

  useEffect(() => {
    let active = true
    Promise.all([
      api.get('/records/' + r.id + '/comments').catch(() => ({ comments: [], officialResponses: [] })),
      api.get('/records/' + r.id + '/observations').catch(() => ({ observations: [] })),
      api.get('/records/' + r.id + '/activity').catch(() => ({ activity: [] })),
    ]).then(([cData, oData, aData]: any[]) => {
      if (!active) return
      setComments(cData.comments || [])
      setOfficialResponses(cData.officialResponses || [])
      setObservations(oData.observations || [])
      setActivity(aData.activity || [])
      setLoadedRecordId(r.id)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [r.id])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (statusBusy || falsePositiveBusy || savingEdit || savingLabels || savingNote || savingTicketNumber) return
      if (ticketCloseConfirmOpen) {
        setTicketCloseConfirmOpen(false)
        setTicketCloseNote('')
      }
      else if (editingTicketNumber) {
        ticketNumberCancelRef.current = true
        setTicketNumberDraft(ticketNumber)
        setTicketNumberError('')
        setEditingTicketNumber(false)
      }
      else if (editingLabels) setEditingLabels(false)
      else if (editingJudgement) setEditingJudgement(false)
      else if (lightbox) setLightbox('')
      else onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [editingJudgement, editingLabels, editingTicketNumber, falsePositiveBusy, lightbox, onClose, savingEdit, savingLabels, savingNote, savingTicketNumber, statusBusy, ticketCloseConfirmOpen, ticketNumber])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (statusBusy || falsePositiveBusy || savingEdit || savingLabels || savingNote || savingTicketNumber || editingJudgement || editingLabels || editingTicketNumber || ticketCloseConfirmOpen || lightbox) return
      const target = e.target
      if (!(target instanceof Node) || panelRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[role="dialog"], [data-radix-popper-content-wrapper], [data-record-detail-trigger]')) return
      onClose()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [editingJudgement, editingLabels, editingTicketNumber, falsePositiveBusy, lightbox, onClose, savingEdit, savingLabels, savingNote, savingTicketNumber, statusBusy, ticketCloseConfirmOpen])

  // 小屏笔记本用覆盖式抽屉，避免把列表和筛选工具条挤变形；大屏才为抽屉留位。
  useEffect(() => {
    document.documentElement.style.setProperty('--detail-dock-width', window.innerWidth >= 1600 ? width + 'px' : '0px')
  }, [width])
  // 关闭/卸载时归零(仅一次,避免改宽时闪一下)
  useEffect(() => {
    return () => { document.documentElement.style.setProperty('--detail-dock-width', '0px') }
  }, [])

  // 窗口变窄时收一下，并重新计算是否需要停靠。
  useEffect(() => {
    const clamp = () => setWidth(w => {
      const nextWidth = Math.min(w, Math.max(PANEL_MIN, window.innerWidth - 340))
      document.documentElement.style.setProperty('--detail-dock-width', window.innerWidth >= 1600 ? nextWidth + 'px' : '0px')
      return nextWidth
    })
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
      document.documentElement.style.setProperty('--detail-dock-width', window.innerWidth >= 1600 ? w + 'px' : '0px')
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

  const resolvedIdentity = identityLabel(r.source_type, r.author_fans, r.author_name, r.identity_override)
  const archived = Boolean(r.archived_at)
  const canProcess = canWrite && !archived

  const openJudgementEditor = () => {
    if (archived) return
    setEditDraft(manualDraft(r))
    setEditError('')
    setActionError('')
    setEditingLabels(false)
    setEditingJudgement(true)
  }

  const saveJudgement = async () => {
    if (archived || !onUpdateFields) return
    const original = manualDraft(r)
    const changes: ManualRecordFields = {}
    let changed = false

    if (editDraft.sentiment !== original.sentiment) { changes.sentiment = editDraft.sentiment; changed = true }
    if (editDraft.category !== original.category) { changes.category = editDraft.category; changed = true }
    if (editDraft.identityOverride !== original.identityOverride) { changes.identityOverride = editDraft.identityOverride; changed = true }
    if (editDraft.publishTime !== original.publishTime) { changes.publishTime = editDraft.publishTime; changed = true }

    if (!changed) {
      setEditError('请至少修改一项判断后再保存')
      return
    }
    setSavingEdit(true)
    setEditError('')
    try {
      const result = await onUpdateFields(changes)
      if (result !== false) setEditingJudgement(false)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : '保存失败，请稍后重试')
    } finally {
      setSavingEdit(false)
    }
  }

  const runStatusAction = async (action?: AsyncDrawerAction): Promise<boolean> => {
    if (!action) return false
    setStatusBusy(true)
    setActionError('')
    try {
      const result = await action()
      return result !== false
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '操作失败，请稍后重试')
      return false
    } finally {
      setStatusBusy(false)
    }
  }

  const refreshActivity = async () => {
    const data = await api.get<{ activity?: RecordActivity[] }>('/records/' + r.id + '/activity').catch(() => null)
    if (Array.isArray(data?.activity)) setActivity(data.activity)
  }

  const changeMode = async (nextMode: string) => {
    if (archived || nextMode === triageStatus) return
    const success = nextMode === 'official_responded' && onMarkResponded
      ? await runStatusAction(onMarkResponded)
      : await runStatusAction(() => onSetStatus?.(nextMode))
    if (!success) return
    await refreshActivity()
  }

  const markFalsePositive = async () => {
    if (archived || !onFalsePositive) return
    setFalsePositiveBusy(true)
    setActionError('')
    try {
      const result = await onFalsePositive()
      if (result !== false) await refreshActivity()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '提交误报失败，请稍后重试')
    } finally {
      setFalsePositiveBusy(false)
    }
  }

  const addNote = async () => {
    const body = noteDraft.trim()
    if (archived || !body || savingNote) return
    setSavingNote(true)
    setNoteError('')
    try {
      const isTicketProgress = Boolean(r.ticket_id && ticketStatus !== 'closed')
      const endpoint = isTicketProgress ? `/tickets/${r.ticket_id}/notes` : `/records/${r.id}/notes`
      const data = await api.post<{ note?: Record<string, unknown> }>(endpoint, { body })
      const note = data.note || {}
      const progress = {
        body: String(note.body || body),
        authorName: String(note.author_name || '当前用户'),
        createdAt: String(note.created_at || new Date().toISOString()),
        eventType: String(note.event_type || 'note'),
      }
      setActivity(current => [{
        id: String(note.id || `note-${Date.now()}`),
        action: isTicketProgress ? 'record.ticket_progress_added' : 'record.note_added',
        metadata: {
          body: progress.body,
          ...(isTicketProgress ? {
            ticketId: r.ticket_id,
            externalTicketNo: ticketNumber,
            ticketStatus: ticketStatus === 'pending' ? 'doing' : ticketStatus,
          } : {}),
        },
        actor_name: progress.authorName,
        created_at: progress.createdAt,
      }, ...current])
      onProgressAdded?.(progress)
      if (isTicketProgress && ticketStatus === 'pending') {
        setTicketStatus('doing')
        onTicketStatusChanged?.('doing')
      }
      setNoteDraft('')
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : '备注保存失败，请稍后重试')
    } finally {
      setSavingNote(false)
    }
  }

  const saveTicketNumber = async () => {
    const externalTicketNo = ticketNumberDraft.trim()
    if (!externalTicketNo) {
      setTicketNumberDraft(ticketNumber)
      setTicketNumberError('')
      setEditingTicketNumber(false)
      return
    }
    if (externalTicketNo === ticketNumber.trim()) {
      setTicketNumberError('')
      setEditingTicketNumber(false)
      return
    }
    const closedNumberBackfill = ticketStatus === 'closed' && !ticketNumber.trim()
    if (!r.ticket_id || savingTicketNumber || ((ticketStatus === 'closed' || archived) && !closedNumberBackfill)) return
    setSavingTicketNumber(true)
    setTicketNumberError('')
    try {
      await api.patch(`/tickets/${r.ticket_id}/external-number`, {
        externalTicketNo,
        previousExternalTicketNo: ticketNumber.trim(),
      })
      setTicketNumber(externalTicketNo)
      onTicketNumberAdded?.(externalTicketNo)
      setTicketNumberDraft(externalTicketNo)
      setEditingTicketNumber(false)
      await refreshActivity()
    } catch (err) {
      setTicketNumberError(err instanceof Error ? err.message : '工单号码保存失败，请稍后重试')
    } finally {
      setSavingTicketNumber(false)
    }
  }

  const closeTicket = async () => {
    if (!r.ticket_id || ticketStatus === 'closed' || statusBusy) return
    setStatusBusy(true)
    setActionError('')
    try {
      const result = await api.patch(`/tickets/${r.ticket_id}`, {
        action: 'close',
        note: ticketCloseNote,
      }) as ContentTicketCloseResult
      setTicketStatus('closed')
      setTicketCloseConfirmOpen(false)
      setTicketCloseNote('')
      if (onTicketClosed) {
        try {
          await onTicketClosed(result)
        } catch (error) {
          // 结案已经成功；父列表刷新失败不能反向把成功操作提示成失败。
          console.warn('工单结案后的内容列表刷新失败', error)
        }
      } else if (result.recordArchived === true) {
        onClose()
      } else {
        await refreshActivity()
        setActionError(result.recordArchiveBlockedByActiveTicket
          ? '本工单已结案，但该内容仍有另一张活动工单，因此继续保留在“工作中”。'
          : '本工单已结案，但内容归档状态未确认，请刷新列表核对。')
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '工单结案失败，请稍后重试')
    } finally {
      setStatusBusy(false)
    }
  }

  const updateLabels = async (patch: CustomTagPatch): Promise<CustomTag[]> => {
    if (archived || !onUpdateCustomTags) return []
    const tags = await onUpdateCustomTags(patch)
    const data = await api.get<{ activity?: RecordActivity[] }>('/records/' + r.id + '/activity').catch(() => ({ activity: [] }))
    if (Array.isArray(data.activity)) setActivity(data.activity)
    return tags
  }

  const imageEntries = recordDisplayImageEntries(r)
  const images = imageEntries.map(item => item.url)
  const customTags = tagsFromRecord(r)
  // 封面优先用本地化副本(/media,静态可靠、不走代理);只有无本地副本才回落 CDN 代理。
  // 之前用 images[0]=proxiedImg(cover_url) 总是绕道 /api/img,白白放着 cover_local 不用。
  const cover = getCover(r) || images[0] || ''

  const alerts = Number(r.alert_count || 0)
  const negComments = Number(r.negative_comment_count || 0)
  const deleted = String(r.content_availability_status || '') === 'deleted'
  const hasSignals = alerts > 0 || negComments > 0 || deleted
  const triageStatus = r.triage_status || 'unhandled'
  const hasTicket = Boolean(r.ticket_id)
  const addingTicketProgress = hasTicket && ticketStatus !== 'closed'
  const canEditTicketNumber = canWrite && hasTicket
    && ((!archived && ticketStatus !== 'closed') || (ticketStatus === 'closed' && !ticketNumber.trim()))

  const TABS = [
    { id: 'content' as const, label: '内容', icon: FileText },
    { id: 'comments' as const, label: `评论 (${comments.length})`, icon: MessageCircle },
    { id: 'official' as const, label: `官方回复 (${officialResponses.length})`, icon: CheckCircle },
    { id: 'snapshot' as const, label: '采集', icon: Camera },
    ...(r.sentiment === 'negative'
      ? [{ id: 'patrol' as const, label: '舆情巡查', icon: Radar }]
      : []),
    { id: 'history' as const, label: `处理记录 (${activity.length})`, icon: History },
  ]
  const modeActions = [
    { value: 'unhandled', label: '待处理', icon: Inbox },
    { value: 'reviewing', label: '负面流程', icon: Bell },
    { value: 'official_responded', label: '官方已评', icon: CheckCircle },
    { value: 'no_action', label: '无需操作', icon: CircleOff },
  ]
  const currentModeLabel = LABELS.triage[triageStatus] || triageStatus || '待处理'

  return (
    <div ref={panelRef} style={{ width }} role="dialog" aria-label="舆情内容详情"
      className="detail-drawer fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-card shadow-[-8px_0_24px_-12px_rgba(17,24,39,0.12)] animate-in slide-in-from-right duration-200">
      {/* 拖拽分隔条:贯穿到顶,与 banner 一体;hover 出蓝线(Asana) */}
      <div onMouseDown={startResize} title="拖动调整宽度"
        className="group absolute left-0 top-0 z-30 hidden h-full w-2.5 -translate-x-1/2 cursor-col-resize justify-center lg:flex">
        <span className="h-full w-px bg-transparent transition-all group-hover:w-[3px] group-hover:bg-primary" />
      </div>
      <div className="relative z-10 flex h-full w-full flex-col">

        {/* Header */}
        <div data-drawer-header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-border/60 bg-card px-2 pt-[env(safe-area-inset-top)] sm:gap-3 sm:px-5 lg:min-h-14">
          <button onClick={onClose} aria-label="返回内容列表" disabled={savingEdit || savingLabels || savingNote || statusBusy || falsePositiveBusy}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground transition active:bg-accent disabled:pointer-events-none disabled:opacity-40 lg:hidden"><ArrowLeft className="h-5 w-5" /></button>
          <h2 className="shrink-0 text-[16px] font-bold text-foreground">舆情内容详情</h2>
          {hasTicket && (
            <div className="flex min-w-0 flex-1 items-center gap-2 text-[12px] tabular-nums">
              <span className="shrink-0 font-medium text-primary">工单号</span>
              {editingTicketNumber && canEditTicketNumber ? (
                <input
                  autoFocus
                  value={ticketNumberDraft}
                  maxLength={100}
                  autoComplete="off"
                  aria-label="工单号"
                  placeholder="输入工单号"
                  disabled={savingTicketNumber}
                  onChange={event => { setTicketNumberDraft(event.target.value); setTicketNumberError('') }}
                  onBlur={() => {
                    if (ticketNumberCancelRef.current) {
                      ticketNumberCancelRef.current = false
                      return
                    }
                    void saveTicketNumber()
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      ticketNumberCancelRef.current = true
                      setTicketNumberDraft(ticketNumber)
                      setTicketNumberError('')
                      setEditingTicketNumber(false)
                    }
                  }}
                  className="ticket-number-input h-8 w-40 min-w-0 border-0 border-b border-primary bg-transparent px-0.5 text-[13px] font-semibold text-foreground outline-none disabled:opacity-60"
                />
              ) : (
                <div className="flex min-w-0 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="修改工单号"
                    disabled={!canEditTicketNumber}
                    onClick={() => {
                      ticketNumberCancelRef.current = false
                      setTicketNumberDraft(ticketNumber)
                      setTicketNumberError('')
                      setEditingTicketNumber(true)
                    }}
                    className="min-w-0 truncate rounded px-0.5 py-1 font-semibold text-foreground outline-none transition-colors enabled:hover:bg-muted enabled:hover:text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                  >
                    {ticketNumber || '待补录'}
                  </button>
                  <CopyTicketNumberButton value={ticketNumber} className="h-7 w-7" />
                </div>
              )}
              {ticketNumberError && <span role="alert" className="min-w-0 truncate text-[11px] font-medium text-destructive">{ticketNumberError}</span>}
            </div>
          )}
          <button onClick={onClose} aria-label="关闭舆情内容详情" disabled={savingEdit || savingLabels || savingNote || statusBusy || falsePositiveBusy}
            className="ml-auto hidden rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent disabled:pointer-events-none disabled:opacity-40 lg:block"><X className="h-5 w-5" /></button>
        </div>

        {archived && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/35 px-4 py-2 text-[12px] text-muted-foreground sm:px-5">
            <Archive className="h-3.5 w-3.5 shrink-0" />
            <span>该内容已封存为只读状态，取消归档后才能继续处理。</span>
          </div>
        )}

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {/* Hero */}
          <section className="border-b border-border/60 bg-card p-4 sm:p-5">
            <div className="flex gap-4">
              {cover ? (
                <button type="button" onClick={() => setLightbox(cover)} title="点击放大"
                  className="group relative h-[88px] w-[88px] shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted">
                  <img src={cover} alt="" className="h-full w-full object-cover transition group-hover:scale-105" referrerPolicy="no-referrer" onError={e => { (e.target as HTMLImageElement).parentElement!.style.display = 'none' }} />
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/25 group-hover:opacity-100"><ZoomIn className="h-4 w-4 text-white" /></span>
                </button>
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge>
                  <StatusBadge tone={r.sentiment || 'muted'}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge>
                  {r.content_availability_status === 'deleted' && (
                    <StatusBadge tone="muted"><Ban className="h-3 w-3" />原帖已删除</StatusBadge>
                  )}
                  {r.content_availability_status === 'page_unavailable' && (
                    <StatusBadge tone="muted"><Ban className="h-3 w-3" />已删除或不可访问</StatusBadge>
                  )}
                  {r.category && <StatusBadge tone="neutral">{LABELS.category[r.category] || r.category}</StatusBadge>}
                  {resolvedIdentity && (
                    <Tooltip text={r.identity_override ? '人工修正的疑似身份' : '疑似身份:账号名带品牌/车型 → 疑似品牌关联号(4S店 / KOE,非真实车主);其余按 AI 多信号判定。研判时 4S店 / KOE 建议剔除'}><span className={cn('cursor-help rounded-md px-2 py-0.5 text-[11px] font-semibold', ['KOE', '4S店'].includes(resolvedIdentity) ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : 'bg-muted text-muted-foreground')}>{resolvedIdentity}</span></Tooltip>
                  )}
                  {canProcess && onUpdateFields && (
                    <button type="button" onClick={openJudgementEditor}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-primary">
                      <Pencil className="h-3 w-3" />编辑判断
                    </button>
                  )}
                </div>
                <h3 className="text-[17px] font-bold leading-snug text-foreground">{r.title || String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '(无标题)'}</h3>

                {/* Author + links */}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
                      {(r.author_name || '?').slice(0, 1)}
                    </div>
                    <span className="text-[13px] font-semibold">{r.author_name || '未知作者'}</span>
                    <span className="text-[11px] text-muted-foreground">粉丝 {Number(r.author_fans) > 0 ? formatNumber(r.author_fans) : '-'}</span>
                  </div>
                  {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" />原文</a>}
                  {r.blogger_profile_url && <a href={r.blogger_profile_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"><User className="h-3.5 w-3.5" />主页</a>}
                  {r.publish_display && <span className="text-[12px] text-muted-foreground">发布于 {r.publish_display}</span>}
                </div>
              </div>
            </div>

            <div className="mt-4 border-t border-border/50 pt-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <RecordLabelsHeading />
                {customTags.length > 0 ? (
                  <RecordLabelChips tags={customTags} />
                ) : (
                  <span className="text-[11px] text-muted-foreground/60">暂无</span>
                )}
                {canProcess && onUpdateCustomTags && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingJudgement(false)
                      setEditingLabels(open => !open)
                    }}
                    className={cn(
                      'inline-flex h-6 items-center rounded-md border px-2 text-[10.5px] font-semibold transition-colors',
                      editingLabels
                        ? 'border-primary/30 bg-accent text-primary'
                        : 'border-border text-muted-foreground hover:border-primary/30 hover:bg-accent hover:text-primary',
                    )}
                  >
                    {editingLabels ? '收起管理' : '管理标签'}
                  </button>
                )}
              </div>
              {editingLabels && canProcess && onUpdateCustomTags && (
                <RecordLabelEditor
                  initialTags={customTags}
                  catalog={customTagCatalog}
                  onSave={updateLabels}
                  onCancel={() => setEditingLabels(false)}
                  onSavingChange={setSavingLabels}
                />
              )}
            </div>

            {/* 风险区只展示真实风险；官方回复属于处理进展，在“官方回复”与“处理记录”中展示。 */}
            {hasSignals && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-l-2 border-status-red bg-status-red/[0.04] px-3 py-2.5 dark:bg-status-red/[0.08]">
                <span className="text-[11px] font-semibold text-muted-foreground">风险信号</span>
                {alerts > 0 && (
                  <Tooltip text={r.alert_reasons || '已触发预警规则,建议优先处理'}><span className="cursor-help rounded bg-status-red/12 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:text-rose-300">预警 {alerts}</span></Tooltip>
                )}
                {negComments > 0 && (
                  <Tooltip text="该内容下被判为负面/风险的评论条数;下方可查看具体评论"><span className="cursor-help rounded bg-status-orange/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">负评 {negComments}</span></Tooltip>
                )}
                {deleted && (
                  <Tooltip text="负面巡查已确认平台提示该内容已删除"><span className="inline-flex cursor-help items-center gap-1 rounded bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground"><CircleOff className="h-3 w-3" />已删帖</span></Tooltip>
                )}
                {r.latest_negative_comment_at && (
                  <span className="ml-auto text-[11px] text-muted-foreground">最近负评 {formatDate(r.latest_negative_comment_at)}</span>
                )}
              </div>
            )}

            <div className="mt-4 grid grid-cols-2 divide-x divide-border/50 border-y border-border/50 bg-muted/20 sm:grid-cols-4">
              <Metric icon={Heart} label="点赞" value={r.likes} />
              <Metric icon={MessageCircle} label="评论" value={r.comments_count} />
              <Metric icon={Star} label="收藏" value={r.collects} />
              <Metric icon={Share2} label="转发" value={r.shares} />
            </div>
          </section>

          {/* Tabs */}
          <div role="tablist" aria-label="内容详情栏目" className="mobile-table-scroll sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-border/70 bg-muted/30 px-2 py-2 backdrop-blur-sm sm:px-4">
            {TABS.map(t => (
              <button key={t.id} id={`record-tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls={`record-panel-${t.id}`} onClick={() => setTab(t.id)}
                className={cn('flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-semibold transition-colors sm:px-3',
                  tab === t.id ? 'bg-card text-primary shadow-sm ring-1 ring-border/50' : 'text-muted-foreground hover:bg-card/70 hover:text-foreground')}>
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab panels */}
          <div id={`record-panel-${tab}`} role="tabpanel" aria-labelledby={`record-tab-${tab}`} className="min-h-[260px] bg-background/35 p-4 sm:p-5">
            {loading || loadedRecordId !== r.id ? (
              <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <>
                {tab === 'content' && (
                  <div className="space-y-5">
                    <div>
                      <h4 className="mb-2 text-[13px] font-semibold text-foreground">正文内容</h4>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{r.content || '无正文'}</p>
                    </div>
                    {r.ai_summary && (
                      <div>
                        <h4 className="mb-2 text-[13px] font-semibold text-foreground">AI 摘要</h4>
                        <p className="text-sm leading-relaxed text-muted-foreground">{r.ai_summary}</p>
                      </div>
                    )}
                    <section className="border-t border-border/50 pt-5">
                      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                            <Sparkles className="h-4 w-4 text-primary" />
                            深度剖析
                          </h4>
                          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                            {r.sentiment === 'negative'
                              ? '负面内容会自动拆解观点、传播风险与应对建议。'
                              : '需要时可手动生成观点、风险与应对建议。'}
                          </p>
                        </div>
                        {r.sentiment === 'negative' && <StatusBadge tone="negative">负面自动剖析</StatusBadge>}
                      </div>
                      <RecordAnalysisPanel
                        record={r}
                        canWrite={canProcess}
                        autoRun={r.sentiment === 'negative'}
                        embedded
                      />
                    </section>
                    {hasVideo(r) && <TranscriptSection record={r} canWrite={canProcess} />}
                    <RecordImageGallery
                      key={`${r.id}-${imageEntries.map(item => `${item.url}::${item.ref}`).join('|')}`}
                      recordId={String(r.id)}
                      canRefresh={canWrite}
                      images={images}
                      imageRefs={imageEntries.map(item => item.ref)}
                      onOpen={setLightbox}
                    />
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

                {tab === 'patrol' && (
                  <RecordPatrolPanel key={String(r.id)} record={r} />
                )}

                {tab === 'history' && (
                  <div className="space-y-4">
                    {canProcess && (
                      <section className="border-b border-border/60 pb-4">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <h4 className="text-[13px] font-semibold">新增记录</h4>
                          <span className="text-[11px] tabular-nums text-muted-foreground">{noteDraft.length}/2000</span>
                        </div>
                        <textarea
                          value={noteDraft}
                          maxLength={2000}
                          rows={3}
                          placeholder="记录当前进展…"
                          onChange={event => {
                            setNoteDraft(event.target.value)
                            if (noteError) setNoteError('')
                          }}
                          onKeyDown={event => {
                            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void addNote()
                          }}
                          className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 text-[13px] leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary focus:ring-2 focus:ring-ring/30"
                        />
                        <div className="mt-2 flex items-center justify-end gap-3">
                          {noteError && <span className="mr-auto text-[12px] font-medium text-destructive">{noteError}</span>}
                          <Button size="sm" disabled={!noteDraft.trim() || savingNote} onClick={() => void addNote()}>
                            {savingNote ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <StickyNote className="h-3.5 w-3.5" />}
                            添加记录
                          </Button>
                        </div>
                      </section>
                    )}

                    <section aria-label="处理记录列表">
                      {activity.length === 0 ? (
                        <EmptyState icon={History} title="暂无处理记录" />
                      ) : (
                        <ActivityTimeline items={activity} recordId={r.id} />
                      )}
                    </section>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Footer actions */}
        {canWrite && (
          <div className="border-t border-border bg-card px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] shadow-[0_-12px_28px_-24px_rgba(15,23,42,0.5)]">
            {archived ? (
              <div className="flex w-full min-w-0 items-center gap-3" aria-label="归档内容操作">
                <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
                  <Archive className="h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-foreground">内容已封存</div>
                    <div className="truncate text-[11px]">取消归档后才能继续处理</div>
                  </div>
                </div>
                {onSetArchived && (
                  <Button variant="outline" size="sm" className="h-9 shrink-0" disabled={statusBusy}
                    onClick={() => runStatusAction(() => onSetArchived(false))} aria-label="取消归档">
                    {statusBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
                    取消归档
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex w-full min-w-0 flex-wrap items-center gap-2" aria-label="内容处理操作">
                <div className="shrink-0" aria-label="处理模式">
                  {addingTicketProgress ? (
                    <StatusBadge tone="ticketed" className="h-8 gap-1.5 px-3 text-[12px]">
                      <ClipboardCheck className="h-3.5 w-3.5" />已转工单
                    </StatusBadge>
                  ) : onSetStatus ? (
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button type="button" disabled={statusBusy || falsePositiveBusy}
                          aria-label={`当前处理模式：${currentModeLabel}，点击修改`}
                          className="rounded-full outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
                          <StatusBadge tone={triageStatus} className="h-8 gap-1.5 px-3 text-[12px]">
                            {currentModeLabel}
                            {statusBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronDown className="h-3 w-3" />}
                          </StatusBadge>
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content align="start" sideOffset={8} collisionPadding={10}
                          className="z-[100] w-52 rounded-lg border border-border bg-card p-1.5 text-foreground shadow-lg animate-in fade-in zoom-in-95">
                          <DropdownMenu.RadioGroup value={triageStatus} aria-label="内容处理模式">
                            {modeActions.map(item => {
                              const active = item.value === triageStatus
                              const Icon = item.icon
                              return (
                                <DropdownMenu.RadioItem key={item.value} value={item.value}
                                  disabled={statusBusy || falsePositiveBusy}
                                  onSelect={() => { if (!active) void changeMode(item.value) }}
                                  className="flex h-10 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-[13px] outline-none transition-colors data-[highlighted]:bg-accent data-[disabled]:opacity-45">
                                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                  <span className={cn(active && 'font-semibold')}>{item.label}</span>
                                  <span className="ml-auto flex h-4 w-4 items-center justify-center"><DropdownMenu.ItemIndicator><Check className="h-4 w-4 text-primary" /></DropdownMenu.ItemIndicator></span>
                                </DropdownMenu.RadioItem>
                              )
                            })}
                          </DropdownMenu.RadioGroup>
                          <DropdownMenu.Separator className="my-1 h-px bg-border/70" />
                          <DropdownMenu.Item disabled={statusBusy || falsePositiveBusy}
                            onSelect={() => {
                              setActionError('')
                              void runStatusAction(onLinkIssue).then(success => { if (success) void refreshActivity() })
                            }}
                            className="flex h-10 cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 text-[13px] font-semibold text-primary outline-none transition-colors data-[highlighted]:bg-primary/10 data-[disabled]:cursor-default data-[disabled]:opacity-45">
                            <ClipboardCheck className="h-4 w-4 shrink-0 text-primary" />转工单
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  ) : (
                    <StatusBadge tone={triageStatus}>{currentModeLabel}</StatusBadge>
                  )}
                </div>

                <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                  {onFalsePositive && (
                    <Tooltip text={falsePositivePending ? '误报已提交，等待平台管理员复核' : '提交误报'}>
                      <Button variant="ghost" size="sm" disabled={falsePositivePending || statusBusy || falsePositiveBusy} onClick={markFalsePositive}
                        className={cn('h-9 shrink-0 gap-1.5 px-2.5 text-[12px]', falsePositivePending ? 'text-emerald-600 disabled:opacity-100 dark:text-emerald-300' : 'text-rose-600 hover:bg-rose-100 hover:text-rose-700 dark:text-rose-300 dark:hover:bg-rose-950/40')}
                        aria-label={falsePositivePending ? '误报已提交' : '提交误报'}>
                        {falsePositiveBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : falsePositivePending ? <CheckCircle className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                        <span>{falsePositivePending ? '已提交' : '误报'}</span>
                      </Button>
                    </Tooltip>
                  )}
                  {onSetArchived && !addingTicketProgress && (
                    <Button variant="ghost" size="sm" className="h-9 shrink-0 gap-1.5 px-2.5 text-[12px]" disabled={statusBusy || falsePositiveBusy}
                      onClick={() => runStatusAction(() => onSetArchived(true))} aria-label="归档">
                      <Archive className="h-3.5 w-3.5" />归档
                    </Button>
                  )}
                  {addingTicketProgress && (
                    <>
                      <Button className="h-9 shrink-0 px-3" variant="outline" size="sm" disabled={statusBusy || falsePositiveBusy} onClick={() => setTab('history')}>
                        <History className="h-3.5 w-3.5" />处理记录
                      </Button>
                      <Button className="h-9 shrink-0 px-3" size="sm" disabled={statusBusy || falsePositiveBusy}
                        onClick={() => { setActionError(''); setTicketCloseNote(''); setTicketCloseConfirmOpen(true) }}>
                        <CheckCircle className="h-3.5 w-3.5" />结案
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
            {actionError && <div role="alert" className="mt-2 text-[12px] font-medium text-destructive">{actionError}</div>}
          </div>
        )}
      </div>

      {!archived && ticketCloseConfirmOpen && addingTicketProgress && (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/35 p-3 sm:items-center sm:p-4 animate-in fade-in duration-150"
          onMouseDown={() => {
            if (statusBusy) return
            setTicketCloseConfirmOpen(false)
            setTicketCloseNote('')
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ticket-close-confirm-title"
            aria-describedby="ticket-close-confirm-description"
            className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl animate-in zoom-in-95 duration-150"
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <CheckCircle className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0">
                <h3 id="ticket-close-confirm-title" className="text-[15px] font-bold">确认结案？</h3>
                <p id="ticket-close-confirm-description" className="mt-1 text-[12px] leading-5 text-muted-foreground">
                  结案后内容将自动移入已归档，并从“工作中”移除；如该内容另有活动工单，则会继续保留。工单与处理记录仍会保留。
                </p>
              </div>
            </div>
            <label htmlFor={`ticket-close-note-${r.id}`} className="mt-4 block text-[12px] font-semibold text-foreground">
              结案说明 <span className="font-normal text-muted-foreground">（选填）</span>
            </label>
            <textarea
              id={`ticket-close-note-${r.id}`}
              aria-label="结案说明"
              value={ticketCloseNote}
              onChange={event => setTicketCloseNote(event.target.value)}
              placeholder="填写结案说明 / 处理结论（可留空）"
              rows={4}
              maxLength={2000}
              disabled={statusBusy}
              className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-6 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
            />
            <div className="mt-1 text-right text-[10px] tabular-nums text-muted-foreground">{ticketCloseNote.length}/2000</div>
            {actionError && <div className="mt-3 text-[12px] font-medium text-destructive">{actionError}</div>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={statusBusy} onClick={() => {
                setTicketCloseConfirmOpen(false)
                setTicketCloseNote('')
              }}>取消</Button>
              <Button size="sm" disabled={statusBusy} onClick={() => void closeTicket()}>
                {statusBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                结案
              </Button>
            </div>
          </div>
        </div>
      )}

      {editingJudgement && canProcess && (
        <JudgementEditor
          draft={editDraft}
          currentIdentity={identityLabel(r.source_type, r.author_fans, r.author_name)}
          error={editError}
          saving={savingEdit}
          onChange={draft => {
            setEditDraft(draft)
            if (editError) setEditError('')
          }}
          onCancel={() => { if (!savingEdit) setEditingJudgement(false) }}
          onSave={saveJudgement}
        />
      )}

      {/* 图片放大 lightbox:页内浮层,点背景 / × / Esc 关闭,不开新窗口 */}
      {lightbox && (
        <div onClick={() => setLightbox('')}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 sm:p-8 animate-in fade-in duration-150">
          <button type="button" onClick={() => setLightbox('')} title="关闭(Esc)"
            className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"><X className="h-5 w-5" /></button>
          <img src={lightbox} alt="" referrerPolicy="no-referrer" onClick={e => e.stopPropagation()}
            className="max-h-[90vh] max-w-[90vw] cursor-default rounded-lg object-contain shadow-2xl" />
        </div>
      )}
    </div>
  )
}

function ActivityTimeline({ items, recordId }: { items: RecordActivity[]; recordId: string }) {
  return (
    <div className="divide-y divide-border/50">
      {items.map(item => {
        const detail = activityDetail(item, recordId)
        return (
          <div key={`${item.action}-${item.id}`} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="min-w-0 text-[12px]">
                <span className="font-semibold text-foreground">{item.actor_name || '系统'}</span>
                <span className="ml-1 text-muted-foreground">{detail.title}</span>
              </div>
              <time className="text-[10.5px] tabular-nums text-muted-foreground">{formatFullDateSec(item.created_at)}</time>
            </div>
            {detail.body && (
              <p className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground/85">{detail.body}</p>
            )}
            {detail.changes.length > 0 && (
              <div className="mt-1.5 space-y-1.5">
                {detail.changes.map((change, index) => (
                  <div key={`${change.label}-${index}`} className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11.5px]">
                    <span className="text-muted-foreground">{change.label}</span>
                    <span className="break-words text-muted-foreground">{change.before}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                    <span className="break-words font-semibold text-foreground">{change.after}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface ActivityChange { label: string; before: string; after: string }

function activityDetail(item: RecordActivity, recordId: string): {
  title: string
  icon: React.ElementType
  tone: 'default' | 'note'
  body: string
  changes: ActivityChange[]
} {
  const metadata = historyValues(item.metadata)
  const result = {
    title: '更新了内容',
    icon: History,
    tone: 'default' as const,
    body: '',
    changes: [] as ActivityChange[],
  }

  if (item.action === 'record.note_added') {
    return { ...result, title: '添加了备注', icon: StickyNote, tone: 'note', body: String(metadata.body || '') }
  }
  if (item.action === 'record.legacy_triage_note') {
    return { ...result, title: '留下了历史处理备注', icon: StickyNote, body: String(metadata.body || '') }
  }
  if (item.action === 'record.false_positive_reported') {
    return {
      ...result,
      title: '提交了误报复核',
      icon: Ban,
      body: String(metadata.reason || '').trim(),
    }
  }
  if (item.action === 'record.manual_fields_updated') {
    const before = historyValues(metadata.originalValues)
    const after = historyValues(metadata.correctedValues)
    const changes = MANUAL_HISTORY_FIELDS
      .filter(field => Object.prototype.hasOwnProperty.call(after, field))
      .map(field => ({
        label: MANUAL_HISTORY_LABELS[field],
        before: manualHistoryValue(field, before[field]),
        after: manualHistoryValue(field, after[field]),
      }))
    return { ...result, title: '修改了判断', icon: Pencil, changes }
  }
  if (item.action === 'record.custom_tags_updated') {
    return {
      ...result,
      title: '更新了自定义标签',
      icon: Tags,
      changes: [{
        label: '标签',
        before: activityTags(metadata.before),
        after: activityTags(metadata.after),
      }],
    }
  }
  if (item.action === 'record.triage_updated' || item.action === 'record.triage_batch_updated') {
    const previous = historyValues(metadata.previous)
    const recordPrevious = historyValues(previous[recordId])
    const beforeStatus = String(metadata.previousStatus || recordPrevious.status || '')
    const afterStatus = String(metadata.nextStatus || metadata.status || beforeStatus)
    const changes = beforeStatus !== afterStatus ? [{
      label: '处理模式',
      before: LABELS.triage[beforeStatus] || beforeStatus || '待处理',
      after: LABELS.triage[afterStatus] || afterStatus || '待处理',
    }] : []
    const reason = String(metadata.reason || metadata.note || '').trim()
    return {
      ...result,
      title: item.action === 'record.triage_batch_updated' ? '批量更新了处理模式' : '更新了处理模式',
      icon: CheckCircle,
      body: reason,
      changes,
    }
  }
  if (item.action === 'record.archived') return { ...result, title: '归档了内容', icon: Archive }
  if (item.action === 'record.unarchived') return { ...result, title: '取消了归档', icon: ArchiveRestore }
  if (item.action === 'record.official_response_marked') {
    const beforeStatus = String(metadata.previousStatus || 'unhandled')
    const afterStatus = String(metadata.nextStatus || 'official_responded')
    return {
      ...result,
      title: '标记为官方已评',
      icon: CheckCircle,
      body: String(metadata.note || '').trim(),
      changes: [{
        label: '处理模式',
        before: LABELS.triage[beforeStatus] || beforeStatus,
        after: LABELS.triage[afterStatus] || afterStatus,
      }],
    }
  }
  if (item.action === 'record.ticket_progress_added') {
    const body = String(metadata.body || '').trim()
    return {
      ...result,
      title: '添加了工单进展',
      icon: ClipboardCheck,
      tone: 'note',
      body,
    }
  }
  if (item.action === 'record.ticket_closed' || item.action === 'record.ticket_reopened') {
    const body = String(metadata.body || '').trim()
    return {
      ...result,
      title: item.action === 'record.ticket_closed' ? '结案了工单' : '重开了工单',
      icon: ClipboardCheck,
      body,
    }
  }
  if (item.action === 'record.ticket_done' || item.action === 'record.ticket_dismissed') {
    const body = String(metadata.body || '').trim()
    return {
      ...result,
      title: item.action === 'record.ticket_done' ? '完成了工单处理' : '忽略了工单',
      icon: ClipboardCheck,
      body,
    }
  }
  if (item.action === 'record.ticket_number_added' || item.action === 'record.ticket_number_changed') {
    const externalTicketNo = String(metadata.externalTicketNo || '').trim()
    const previousExternalTicketNo = String(metadata.previousExternalTicketNo || '').trim()
    return {
      ...result,
      title: item.action === 'record.ticket_number_changed' ? '修改了工单号码' : '补录了工单号码',
      icon: ClipboardCheck,
      body: previousExternalTicketNo
        ? `${previousExternalTicketNo} → ${externalTicketNo}`
        : externalTicketNo,
    }
  }
  if (item.action === 'record.ticket_created') {
    const note = String(metadata.note || '').trim()
    return {
      ...result,
      title: '转为工单',
      icon: LinkIcon,
      body: note,
    }
  }
  if (item.action === 'record.official_responded') return { ...result, title: '采集到官方回复', icon: CheckCircle }
  if (item.action === 'record.reopened_by_comment_risk') return { ...result, title: '因新增负评重新进入待处理', icon: Bell }
  if (item.action === 'record.official_content_hidden') return { ...result, title: '识别为官方内容并移出分诊', icon: Eye }
  if (item.action === 'record.comment_risk_detected') {
    const added = Math.max(1, Number(metadata.addedNegativeCount || 1))
    const mode = String(metadata.processingMode || 'unhandled')
    return {
      ...result,
      title: '新增负评提醒',
      icon: Bell,
      body: `检测到 ${added} 条新增负评；仅作提醒，处理模式仍为“${LABELS.triage[mode] || mode}”。`,
    }
  }
  if (item.action === 'record.official_response_detected') {
    const added = Math.max(1, Number(metadata.addedOfficialResponseCount || 1))
    const mode = String(metadata.processingMode || 'unhandled')
    return {
      ...result,
      title: '官方回复提醒',
      icon: CheckCircle,
      body: `采集到 ${added} 条新增官方回复；仅作提醒，处理模式仍为“${LABELS.triage[mode] || mode}”。`,
    }
  }
  if (item.action === 'record.official_content_identified') {
    return {
      ...result,
      title: '识别为官方内容并移出分诊',
      icon: Eye,
      body: '仅更新内容归属，未改变处理模式。',
    }
  }
  if (item.action === 'record.official_content_exclusion_removed') {
    return {
      ...result,
      title: '取消了官方内容排除',
      icon: Eye,
      body: '仅更新内容归属，未改变处理模式。',
    }
  }
  return result
}

function activityTags(value: unknown): string {
  const items = Array.isArray(value) ? value : []
  const names = items.map(item => {
    if (item && typeof item === 'object') return String((item as Record<string, unknown>).name || '').trim()
    return String(item || '').trim()
  }).filter(Boolean)
  return names.length ? names.join('、') : '无'
}

interface ManualEditDraft {
  sentiment: string
  category: string
  identityOverride: string
  publishTime: string
}

const MANUAL_HISTORY_FIELDS = ['sentiment', 'category', 'identity_override', 'publish_time'] as const
type ManualHistoryField = typeof MANUAL_HISTORY_FIELDS[number]
const MANUAL_HISTORY_LABELS: Record<ManualHistoryField, string> = {
  sentiment: '情感',
  category: '分类',
  identity_override: '疑似身份',
  publish_time: '发布日期',
}

function historyValues(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function manualHistoryValue(field: ManualHistoryField, value: unknown): string {
  const text = String(value ?? '').trim()
  if (field === 'sentiment') return LABELS.sentiment[text] || text || '未设置'
  if (field === 'category') return LABELS.category[text] || text || '未设置'
  if (field === 'identity_override') {
    return ({ user: '用户', kol: 'KOL / KOC', dealer: '4S店', koe: 'KOE', other: '其他' } as Record<string, string>)[text] || '沿用 AI'
  }
  return text || '未设置'
}

function dateInputValue(record: any): string {
  const values = [record?.publish_display, record?.publish_time]
  for (const value of values) {
    const match = String(value || '').match(/\d{4}-\d{2}-\d{2}/)
    if (match) return match[0]
  }
  return ''
}

function manualDraft(record: any): ManualEditDraft {
  return {
    sentiment: String(record?.sentiment || ''),
    category: String(record?.category || ''),
    identityOverride: String(record?.identity_override || ''),
    publishTime: dateInputValue(record),
  }
}

function JudgementEditor({ draft, currentIdentity, error, saving, onChange, onCancel, onSave }: {
  draft: ManualEditDraft
  currentIdentity: string
  error: string
  saving: boolean
  onChange: (draft: ManualEditDraft) => void
  onCancel: () => void
  onSave: () => void
}) {
  const controlClass = 'mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-[13px] text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 lg:h-9'
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4 animate-in fade-in duration-150" onMouseDown={onCancel}>
      <div className="max-h-[calc(100dvh-1.5rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-border bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-xl sm:p-5 animate-in zoom-in-95 duration-150" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div>
            <h3 className="text-sm font-bold">编辑判断</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">人工修正将用于后台展示与后续统计；疑似身份选择“沿用 AI”可取消人工覆盖。</p>
          </div>
          <button type="button" onClick={onCancel} disabled={saving}
            className="ml-auto rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-[12px] font-semibold text-muted-foreground">
            情感
            <select value={draft.sentiment} onChange={e => onChange({ ...draft, sentiment: e.target.value })} className={controlClass}>
              <option value="" disabled>待标注</option>
              <option value="positive">正面</option>
              <option value="neutral">中性</option>
              <option value="negative">负面</option>
            </select>
          </label>
          <label className="text-[12px] font-semibold text-muted-foreground">
            分类
            <select value={draft.category} onChange={e => onChange({ ...draft, category: e.target.value })} className={controlClass}>
              <option value="" disabled>待分类</option>
              <option value="safety_rescue">安全救援</option>
              <option value="feature_usage">功能使用</option>
              <option value="renewal_billing">续费收费</option>
              <option value="privacy">隐私安全</option>
              <option value="app_issue">App问题</option>
              <option value="service_quality">服务质量</option>
              <option value="brand_image">品牌形象</option>
              <option value="other">其他</option>
            </select>
          </label>
          <label className="text-[12px] font-semibold text-muted-foreground">
            疑似身份
            <select value={draft.identityOverride} onChange={e => onChange({ ...draft, identityOverride: e.target.value })} className={controlClass}>
              <option value="">沿用 AI{currentIdentity ? `（当前：${currentIdentity}）` : ''}</option>
              <option value="user">用户</option>
              <option value="kol">KOL / KOC</option>
              <option value="dealer">4S店</option>
              <option value="koe">KOE</option>
              <option value="other">其他</option>
            </select>
          </label>
          <label className="text-[12px] font-semibold text-muted-foreground">
            发布日期
            <input type="date" value={draft.publishTime} onChange={e => onChange({ ...draft, publishTime: e.target.value })} className={controlClass} />
          </label>
        </div>

        {error && <p className="mt-2 text-[12px] font-medium text-destructive">{error}</p>}
        <div className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>取消</Button>
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            保存修改
          </Button>
        </div>
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
  let raw = ''
  if (r.cover_local) raw = r.cover_local            // 本地化封面(/media),proxiedImg 原样放行
  else if (r.cover_url) raw = r.cover_url
  else {
    try {
      const imgs = JSON.parse(r.image_urls || '[]')
      if (imgs.length) raw = typeof imgs[0] === 'string' ? imgs[0] : (imgs[0]?.url || '')
    } catch { /* 忽略历史记录中无效的图片 JSON，继续使用空封面。 */ }
  }
  return proxiedImg(raw)                             // CDN 图走 /api/img 代理,防直连防盗链刷不出
}

export function getImages(r: any): string[] {
  return recordDisplayImages(r)
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
      ) : status === 'no_speech' ? (
        <p className="text-sm text-muted-foreground">该视频无人声口播,无可转写的逐字稿。</p>
      ) : status === 'failed' ? (
        <p className="text-sm text-rose-600 dark:text-rose-400">转写失败:{friendlyError(error)}</p>
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
            <p className="text-sm text-rose-600 dark:text-rose-400">{friendlyError(analyzeError)}</p>
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

type TranscriptAnalysis = {
  stance?: unknown
  summary?: unknown
  keyPoints?: unknown
  issues?: unknown
  userNeeds?: unknown
  risk?: unknown
}

function TranscriptInsights({ data }: { data: TranscriptAnalysis }) {
  const stance = String(data?.stance || '').toLowerCase()
  const stanceTone = stance === 'positive' ? 'positive' : stance === 'negative' ? 'negative' : 'neutral'
  const stanceLabel = stance === 'positive' ? '正面' : stance === 'negative' ? '负面' : '中性'
  const toList = (v: unknown): string[] => Array.isArray(v) ? v.filter(Boolean).map(String) : (v ? [String(v)] : [])
  const keyPoints = toList(data?.keyPoints)
  const issues = toList(data?.issues)
  const userNeeds = toList(data?.userNeeds)
  return (
    <div className="space-y-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={stanceTone}>{stanceLabel}</StatusBadge>
        {Boolean(data?.summary) && <span>{String(data.summary)}</span>}
      </div>
      {keyPoints.length > 0 && <InsightList label="核心观点" items={keyPoints} />}
      {issues.length > 0 && <InsightList label="涉及槽点" items={issues} warn />}
      {Boolean(data?.risk) && (
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

type PatrolDelta = {
  likes: number | null
  comments: number | null
  collects: number | null
  shares: number | null
  interactionTotal: number | null
}

type PatrolSnapshot = {
  id?: string
  observationId?: string
  capturedAt?: string
  captured_at?: string
  likes?: number | null
  comments?: number | null
  comments_count?: number | null
  collects?: number | null
  shares?: number | null
  interactionTotal?: number | null
  interaction_total?: number | null
  availability_status?: string | null
  runId?: string
  kind?: 'baseline' | 'result' | string
}

type PatrolRun = {
  id?: string
  itemId?: string
  status?: string
  createdAt?: string
  created_at?: string
  updatedAt?: string
  updated_at?: string
  startedAt?: string
  started_at?: string
  finishedAt?: string
  finished_at?: string
  agentName?: string | null
  agent_name?: string | null
  errorMessage?: string | null
  error_message?: string | null
  availabilityStatus?: string | null
  availability_status?: string | null
  measured?: boolean
  delta?: Partial<PatrolDelta> | null
}

type PatrolTimeline = {
  record?: Record<string, unknown> | null
  summary?: {
    runCount?: number
    patrolCount?: number
    snapshotCount?: number
    measuredRuns?: number
    unmeasuredRuns?: number
    firstPatrolledAt?: string | null
    lastPatrolledAt?: string | null
    latestStatus?: string | null
    availabilityStatus?: string | null
    delta?: Partial<PatrolDelta> | null
  }
  snapshots?: PatrolSnapshot[]
  runs?: PatrolRun[]
}

type PatrolRecord = {
  id?: string | number
  sentiment?: string | null
  content_availability_status?: string | null
}

const PATROL_STATUS_LABEL: Record<string, string> = {
  completed: '巡查完成',
  partial: '部分完成',
  partially_completed: '部分完成',
  failed: '巡查失败',
  running: '巡查中',
  pending: '等待巡查',
  queued: '等待巡查',
  deleted: '原帖已删除',
  page_unavailable: '已删除或不可访问',
}

export function RecordPatrolPanel({ record }: { record: PatrolRecord }) {
  const [timeline, setTimeline] = useState<PatrolTimeline | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api.get<PatrolTimeline & { timeline?: PatrolTimeline }>(`/capture-cloud/negative-patrol/posts/${record.id}/timeline`)
      .then(data => { if (active) setTimeline(data.timeline || data) })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : '舆情巡查数据读取失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [record.id])

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  if (error) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="暂时无法读取舆情巡查"
        description={friendlyError(error)}
      />
    )
  }

  const summary = timeline?.summary || {}
  const runs = Array.isArray(timeline?.runs) ? timeline.runs : []
  const snapshots = (Array.isArray(timeline?.snapshots) ? timeline.snapshots : [])
    .filter(item => patrolSnapshotCapturedAt(item))
    .sort((a, b) => new Date(patrolSnapshotCapturedAt(a)).getTime() - new Date(patrolSnapshotCapturedAt(b)).getTime())
  const delta = summary.delta || runs.find(run => run.measured)?.delta || null
  const hasMeasuredDelta = Boolean(
    delta
    && [delta.likes, delta.comments, delta.collects, delta.shares, delta.interactionTotal]
      .some(value => typeof value === 'number'),
  )
  const availability = String(summary.availabilityStatus || record.content_availability_status || 'available')
  const unavailable = ['deleted', 'page_unavailable', 'unavailable'].includes(availability)
  const latestStatus = unavailable ? availability : String(summary.latestStatus || runs[0]?.status || '')
  const measuredRuns = Number(summary.measuredRuns || runs.filter(run => run.measured).length || 0)
  const patrolCount = Number(summary.patrolCount ?? summary.runCount ?? runs.length)
  const interactionDelta = typeof delta?.interactionTotal === 'number'
    ? delta.interactionTotal
    : sumKnown([delta?.likes, delta?.comments, delta?.collects, delta?.shares])

  if (runs.length === 0) {
    if (record.sentiment !== 'negative') {
      return (
        <EmptyState
          icon={Radar}
          title="该内容未纳入负面舆情巡查"
          description="尚无负面巡查任务记录；普通采集快照请在「采集」中查看。"
        />
      )
    }
    return (
      <EmptyState
        icon={Radar}
        title="尚未形成负面巡查记录"
        description="该内容已判为负面，但还没有经过「负面帖子巡查」任务。普通采集快照不会被计入巡查声量。"
      />
    )
  }

  return (
    <div className="space-y-5">
      <section className={cn(
        'rounded-xl border p-4',
        unavailable
          ? 'border-border bg-muted/35'
          : 'border-primary/15 bg-primary/[0.035]',
      )}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-primary" />
              <h4 className="text-[13px] font-semibold text-foreground">负面内容巡查状态</h4>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              仅统计真实负面巡查任务；普通重复采集不会混入这里。
            </p>
          </div>
          <StatusBadge tone={unavailable ? 'muted' : latestStatus === 'failed' ? 'negative' : latestStatus === 'running' ? 'reviewing' : 'positive'}>
            {PATROL_STATUS_LABEL[latestStatus] || '已纳入巡查'}
          </StatusBadge>
        </div>
        {unavailable && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-background/70 px-3 py-2 text-[12px] text-muted-foreground">
            <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>当前页面已删除或不可访问；历史巡查快照仍保留，不再把不可访问误算成互动下降。</span>
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h4 className="text-[13px] font-semibold text-foreground">最近一次可比巡查增量</h4>
            <p className="mt-0.5 text-[11px] text-muted-foreground">同一条内容两次巡查快照之间的互动变化，不等同于新增负面评论。</p>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {hasMeasuredDelta ? `${measuredRuns} 次可比巡查` : '待形成第二次巡查快照'}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <PatrolDeltaCard icon={Heart} label="点赞增加" value={delta?.likes} />
          <PatrolDeltaCard icon={MessageCircle} label="评论增加" value={delta?.comments} />
          <PatrolDeltaCard icon={Star} label="收藏增加" value={delta?.collects} />
          <PatrolDeltaCard icon={Share2} label="转发增加" value={delta?.shares} />
        </div>
      </section>

      <section className="rounded-xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-[13px] font-semibold text-foreground">互动趋势</h4>
            <p className="mt-0.5 text-[11px] text-muted-foreground">点赞、评论、收藏、转发的快照合计</p>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">本轮总互动变化</div>
            <div className="text-lg font-bold tabular-nums">{formatPatrolDelta(interactionDelta)}</div>
          </div>
        </div>
        <PatrolTrendChart snapshots={snapshots} />
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h4 className="text-[13px] font-semibold text-foreground">巡查记录</h4>
          <span className="text-[11px] text-muted-foreground">
            共 {patrolCount} 次 · 最近 {formatFullDateSec(
              summary.lastPatrolledAt
              || runs[0]?.finishedAt
              || runs[0]?.finished_at
              || runs[0]?.updatedAt
              || runs[0]?.updated_at,
            )}
          </span>
        </div>
        <div className="divide-y divide-border/50 rounded-xl border border-border/60 bg-card">
          {runs.slice(0, 8).map((run, index) => {
            const status = String(run.availabilityStatus || run.availability_status || run.status || '')
            return (
              <div key={run.itemId || run.id || index} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-semibold">第 {patrolCount - index} 次巡查</span>
                  <StatusBadge tone={status === 'failed' ? 'negative' : status === 'running' ? 'reviewing' : status.includes('unavailable') || status === 'deleted' ? 'muted' : 'positive'}>
                    {PATROL_STATUS_LABEL[status] || status || '已完成'}
                  </StatusBadge>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {formatFullDateSec(run.finishedAt || run.finished_at || run.updatedAt || run.updated_at || run.startedAt || run.started_at || run.createdAt || run.created_at)}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span>Agent：{run.agentName || run.agent_name || '未记录'}</span>
                  <span>{run.measured ? `互动变化 ${formatPatrolDelta(run.delta?.interactionTotal ?? sumKnown([run.delta?.likes, run.delta?.comments, run.delta?.collects, run.delta?.shares]))}` : '缺少成对快照，未计算增量'}</span>
                </div>
                {(run.errorMessage || run.error_message) && (
                  <p className="mt-1.5 text-[11px] leading-5 text-destructive">{run.errorMessage || run.error_message}</p>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function PatrolDeltaCard({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: number | null | undefined }) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />{label}
      </div>
      <div className="mt-1 text-[17px] font-bold tabular-nums">{formatPatrolDelta(value)}</div>
    </div>
  )
}

function PatrolTrendChart({ snapshots }: { snapshots: PatrolSnapshot[] }) {
  const points = snapshots
    .map(snapshot => ({
      capturedAt: patrolSnapshotCapturedAt(snapshot),
      total: snapshot.interactionTotal ?? snapshot.interaction_total ?? sumKnown([
        snapshot.likes,
        snapshot.comments ?? snapshot.comments_count,
        snapshot.collects,
        snapshot.shares,
      ]),
    }))
    .filter((point): point is { capturedAt: string; total: number } => typeof point.total === 'number')

  if (points.length < 2) {
    return (
      <div className="mt-4 flex h-28 items-center justify-center rounded-lg bg-muted/25 px-4 text-center text-[12px] text-muted-foreground">
        首次巡查只保存基线；完成下一次巡查后才会显示真实趋势。
      </div>
    )
  }

  const width = 520
  const height = 136
  const insetX = 12
  const insetY = 14
  const values = points.map(point => point.total)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(1, max - min)
  const coords = points.map((point, index) => ({
    x: insetX + (index / Math.max(1, points.length - 1)) * (width - insetX * 2),
    y: insetY + ((max - point.total) / range) * (height - insetY * 2),
    ...point,
  }))
  const polyline = coords.map(point => `${point.x},${point.y}`).join(' ')

  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-32 w-full overflow-visible" role="img" aria-label="负面内容互动变化趋势">
        {[0.2, 0.5, 0.8].map(ratio => (
          <line key={ratio} x1={insetX} x2={width - insetX} y1={height * ratio} y2={height * ratio}
            className="stroke-border/70" strokeDasharray="4 5" strokeWidth="1" />
        ))}
        <polyline points={polyline} fill="none" className="stroke-primary" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {coords.map((point, index) => (
          <g key={`${point.capturedAt}-${index}`}>
            <circle cx={point.x} cy={point.y} r="4" className="fill-card stroke-primary" strokeWidth="2.5" />
            {(index === 0 || index === coords.length - 1) && (
              <text x={point.x} y={Math.max(10, point.y - 9)} textAnchor={index === 0 ? 'start' : 'end'}
                className="fill-muted-foreground text-[10px] font-semibold">
                {formatNumber(point.total)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{formatFullDateSec(points[0]?.capturedAt)}</span>
        <span>{formatFullDateSec(points[points.length - 1]?.capturedAt)}</span>
      </div>
    </div>
  )
}

function patrolSnapshotCapturedAt(snapshot: PatrolSnapshot): string {
  return String(snapshot.capturedAt || snapshot.captured_at || '')
}

function sumKnown(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null
}

function formatPatrolDelta(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '待对比'
  return `${value > 0 ? '+' : ''}${formatNumber(value)}`
}

// 单条深度剖析:自含数据获取(GET 读缓存 → 无则 POST 发起,60s 显式超时),四块结果展示。
// 与话题级同范式:LLM 覆盖文字层,失败落 rule_fallback 兜底(仍有内容,可一键重试)。
const RISK_TONE: Record<string, string> = { critical: 'critical', warning: 'negative', attention: 'medium', watch: 'muted' }
const STANCE_LABEL: Record<string, string> = { positive: '正面', negative: '负面', neutral: '中性', mixed: '褒贬不一' }
const RECORD_SOURCE_LABEL: Record<string, string> = { llm: 'AI 深剖', rule_fallback: '规则兜底' }
const AUTO_ANALYSIS_REQUESTED = new Set<string>()

type RecordAnalysisPanelProps = {
  record: any
  canWrite: boolean
  autoRun?: boolean
  embedded?: boolean
}

function RecordAnalysisPanel(props: RecordAnalysisPanelProps) {
  return <RecordAnalysisPanelContent key={String(props.record?.id ?? '')} {...props} />
}

function RecordAnalysisPanelContent({ record, canWrite, autoRun = false, embedded = false }: RecordAnalysisPanelProps) {
  const [loading, setLoading] = useState(true)
  const [analysis, setAnalysis] = useState<any>(null)
  const [source, setSource] = useState('')
  const [stale, setStale] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [brandMissing, setBrandMissing] = useState(false)
  const [copied, setCopied] = useState('')

  const run = useCallback(async (refresh: boolean) => {
    setGenerating(true); setError(''); setBrandMissing(false)
    try {
      const d = await api.post<any>(
        `/opinion-analysis/records/${record.id}${refresh ? '?refresh=1' : ''}`, {}, { timeoutMs: 60000 },
      )
      setAnalysis(d.analysis || null)
      setSource(d.source || '')
      setStale(false)
    } catch (e: any) {
      const msg = e?.message || '剖析失败'
      if (/品牌/.test(msg)) setBrandMissing(true)
      setError(msg)
    } finally {
      setGenerating(false)
    }
  }, [record.id])

  useEffect(() => {
    let active = true
    api.get<any>(`/opinion-analysis/records/${record.id}`)
      .then(async d => {
        if (!active) return
        setAnalysis(d.analysis || null)
        setSource(d.source || '')
        setStale(Boolean(d.stale))
        if (
          !d.analysis
          && autoRun
          && canWrite
          && !AUTO_ANALYSIS_REQUESTED.has(String(record.id))
        ) {
          AUTO_ANALYSIS_REQUESTED.add(String(record.id))
          setLoading(false)
          await run(false)
        }
      })
      .catch(() => { /* 拉取失败按未剖析处理,由用户手动发起 */ })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [autoRun, canWrite, record.id, run])

  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 1500) } catch { /* 忽略 */ }
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  if (brandMissing) {
    return (
      <EmptyState icon={AlertTriangle} title="尚未配置品牌语境"
        description="回应话术是客户可见交付物,需先在「系统设置」填写品牌名称与业务语境后再发起深度剖析。" />
    )
  }

  if (!analysis) {
    return (
      <div className={cn('flex flex-col items-center gap-4 text-center', embedded ? 'py-6' : 'py-10')}>
        <Radar className="h-8 w-8 text-muted-foreground/60" />
        <div>
          <p className="text-sm font-semibold text-foreground">
            {generating && autoRun ? '正在自动深度剖析' : '尚未做深度剖析'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {generating && autoRun
              ? '负面内容已进入 AI 剖析，完成后会在这里展示观点、传播风险与建议。'
              : '基于正文 / 逐字稿 / 图文文字 / 评论，一次性拆解观点、风险与回应口径。'}
          </p>
        </div>
        {canWrite ? (
          <Button size="sm" disabled={generating} onClick={() => void run(Boolean(error))}>
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {generating ? '正在深度剖析…（约需数十秒）' : error ? '重新尝试' : '开始深度剖析'}
          </Button>
        ) : <p className="text-xs text-muted-foreground">只读账号无法发起剖析。</p>}
        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{friendlyError(error)}</p>}
      </div>
    )
  }

  const overview = analysis.overview || {}
  const content = analysis.contentInsights || {}
  const commentIns = analysis.commentInsights || {}
  const spread = analysis.spreadRisk || {}
  const response = analysis.suggestedResponse || {}
  const evidence: string[] = Array.isArray(analysis.meta?.evidenceSources) ? analysis.meta.evidenceSources : []
  const corePoints: string[] = Array.isArray(content.corePoints) ? content.corePoints : []
  const issues: string[] = Array.isArray(content.issues) ? content.issues : []
  const points: any[] = Array.isArray(commentIns.points) ? commentIns.points : []
  const alertReasons: string[] = Array.isArray(spread.alertReasons) ? spread.alertReasons : []
  const riskLevel = String(overview.riskLevel || 'watch')

  return (
    <div className="space-y-5">
      {/* 头部:来源徽章 + 重新剖析 */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={source === 'llm' ? 'reviewing' : 'muted'}>{RECORD_SOURCE_LABEL[source] || source || '规则兜底'}</StatusBadge>
        {evidence.map((e, i) => <span key={i} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{e}</span>)}
        {canWrite && (
          <button onClick={() => void run(true)} disabled={generating}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-primary transition hover:bg-accent disabled:opacity-50">
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            重新剖析
          </button>
        )}
      </div>
      {stale && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>内容或评论在剖析后有更新,当前结果可能已过时,建议「重新剖析」。</span>
        </div>
      )}
      {source === 'rule_fallback' && (
        <p className="text-[12px] text-muted-foreground">当前为规则兜底结果(LLM 未生成,可能未配置 Key 或调用超时)。点「重新剖析」再试一次。</p>
      )}
      {error && <p className="text-sm text-rose-600 dark:text-rose-400">{friendlyError(error)}</p>}

      {/* 1. 风险概览 */}
      <section>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={RISK_TONE[riskLevel] || 'muted'}>{overview.riskLevelLabel || riskLevel}</StatusBadge>
          <StatusBadge tone={overview.stance === 'positive' ? 'positive' : overview.stance === 'negative' ? 'negative' : 'muted'}>
            {STANCE_LABEL[String(overview.stance)] || '中性'}
          </StatusBadge>
        </div>
        {overview.summary && <p className="mt-2 text-sm leading-relaxed">{overview.summary}</p>}
      </section>

      {/* 2. 内容拆解 */}
      {(corePoints.length > 0 || issues.length > 0) && (
        <section className="space-y-2.5 border-t border-border/50 pt-4 text-sm">
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">内容拆解</h4>
          {corePoints.length > 0 && <InsightList label="核心观点" items={corePoints} />}
          {issues.length > 0 && <InsightList label="涉及槽点" items={issues} warn />}
        </section>
      )}

      {/* 3. 评论观点 */}
      {(commentIns.summary || points.length > 0) && (
        <section className="space-y-2 border-t border-border/50 pt-4">
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">评论观点</h4>
          {commentIns.summary && <p className="text-sm leading-relaxed text-muted-foreground">{commentIns.summary}</p>}
          <div className="space-y-2">
            {points.map((p, i) => (
              <div key={i} className="rounded-lg bg-muted/40 p-3">
                <div className="mb-1 flex items-center gap-2">
                  <StatusBadge tone={p.stance === 'negative' ? 'negative' : p.stance === 'positive' ? 'positive' : p.stance === 'mixed' ? 'medium' : 'muted'}>
                    {STANCE_LABEL[String(p.stance)] || '中性'}
                  </StatusBadge>
                  <span className="text-sm font-semibold">{p.viewpoint}</span>
                </div>
                {p.summary && <p className="text-[13px] leading-5 text-muted-foreground">{p.summary}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 4. 传播风险 */}
      <section className="border-t border-border/50 pt-4">
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">传播与风险</h4>
        <div className="grid grid-cols-2 gap-3">
          <InfoTile label="总互动" value={formatNumber(spread.interactionTotal)} />
          <InfoTile label="负面评论" value={`${formatNumber(spread.negativeCommentCount)} 条`} />
        </div>
        {alertReasons.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">已命中预警</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px] text-rose-700 dark:text-rose-300">
              {alertReasons.map((reason, i) => <li key={i}>{reason}</li>)}
            </ul>
          </div>
        )}
      </section>

      {/* 5. 应对建议与回应口径 */}
      <section className="border-t border-border/50 pt-4">
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">应对建议</h4>
        {response.action && <p className="text-sm leading-relaxed">{response.action}</p>}
        {response.replyDraft && (
          <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">回应话术草稿</span>
              <button onClick={() => void copy('reply', response.replyDraft)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-semibold text-primary transition hover:bg-accent">
                {copied === 'reply' ? <CheckCircle className="h-3 w-3 text-status-green" /> : <Copy className="h-3 w-3" />}
                {copied === 'reply' ? '已复制' : '复制'}
              </button>
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-5">{response.replyDraft}</p>
          </div>
        )}
        {response.escalation && (
          <div className="mt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">升级 / 协同</div>
            <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{response.escalation}</p>
          </div>
        )}
      </section>
    </div>
  )
}
