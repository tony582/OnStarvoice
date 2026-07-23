import { useEffect, useRef, useState } from 'react'
import {
  LinkIcon, CheckCircle, Loader2, X, Heart, MessageCircle, Star, Share2,
  ExternalLink, User, FileText, Camera, Bell, Archive, ArchiveRestore, Eye, Sparkles, ZoomIn,
  Pencil, Ban, ArrowLeft, History, ArrowRight, StickyNote, Tags, AlertTriangle,
} from 'lucide-react'

const PANEL_MIN = 480, PANEL_MAX = 900, PANEL_DEFAULT = 620
import { api } from '@/lib/api'
import { formatNumber, formatDate, formatFullDateSec, LABELS, platformName, cn, identityLabel, friendlyError, proxiedImg } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { Tooltip } from '@/components/shared/Tooltip'
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
 * 舆情内容详情抽屉。写操作由调用方持有，抽屉保留当前内容并同步处理记录。
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

export function RecordDrawer({
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
}: {
  record: any
  onClose: () => void
  canWrite: boolean
  onLinkIssue: () => void
  onSetStatus?: (status: string) => Promise<boolean | void> | boolean | void
  onMarkResponded?: AsyncDrawerAction
  onSetArchived?: (archived: boolean) => Promise<boolean | void> | boolean | void
  onFalsePositive?: AsyncDrawerAction
  falsePositivePending?: boolean
  onUpdateFields?: (fields: ManualRecordFields) => Promise<boolean | void> | boolean | void
  customTagCatalog?: CustomTag[]
  onUpdateCustomTags?: (patch: CustomTagPatch) => Promise<CustomTag[]>
}) {
  const [tab, setTab] = useState<'content' | 'comments' | 'official' | 'snapshot' | 'history'>('content')
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
  const [pendingMode, setPendingMode] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('osv_detail_width'))
    return saved >= PANEL_MIN && saved <= PANEL_MAX ? saved : PANEL_DEFAULT
  })

  useEffect(() => {
    let active = true
    setLoading(true)
    setComments([])
    setOfficialResponses([])
    setObservations([])
    setActivity([])
    setEditingJudgement(false)
    setEditingLabels(false)
    setLightbox('')
    setEditDraft(manualDraft(r))
    setEditError('')
    setNoteDraft('')
    setNoteError('')
    setActionError('')
    setPendingMode(null)
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
      if (statusBusy || falsePositiveBusy || savingEdit || savingLabels || savingNote) return
      if (pendingMode) setPendingMode(null)
      else if (editingLabels) setEditingLabels(false)
      else if (editingJudgement) setEditingJudgement(false)
      else if (lightbox) setLightbox('')
      else onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [editingJudgement, editingLabels, falsePositiveBusy, lightbox, onClose, pendingMode, savingEdit, savingLabels, savingNote, statusBusy])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (statusBusy || falsePositiveBusy || savingEdit || savingLabels || savingNote || editingJudgement || editingLabels || pendingMode || lightbox) return
      const target = e.target
      if (!(target instanceof Node) || panelRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[role="dialog"], [data-radix-popper-content-wrapper], [data-record-detail-trigger]')) return
      onClose()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [editingJudgement, editingLabels, falsePositiveBusy, lightbox, onClose, pendingMode, savingEdit, savingLabels, savingNote, statusBusy])

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

  const confirmModeChange = async () => {
    if (archived || !pendingMode || pendingMode === triageStatus) return
    const success = pendingMode === 'official_responded' && onMarkResponded
      ? await runStatusAction(onMarkResponded)
      : await runStatusAction(() => onSetStatus?.(pendingMode))
    if (!success) return
    setPendingMode(null)
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
      const data = await api.post<{ note?: Record<string, unknown> }>('/records/' + r.id + '/notes', { body })
      const note = data.note || {}
      setActivity(current => [{
        id: String(note.id || `note-${Date.now()}`),
        action: 'record.note_added',
        metadata: { body: String(note.body || body) },
        actor_name: String(note.author_name || '当前用户'),
        created_at: String(note.created_at || new Date().toISOString()),
      }, ...current])
      setNoteDraft('')
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : '备注保存失败，请稍后重试')
    } finally {
      setSavingNote(false)
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
  const hasSignals = alerts > 0 || negComments > 0
  const triageStatus = r.triage_status || 'unhandled'

  const TABS = [
    { id: 'content' as const, label: '内容', icon: FileText },
    { id: 'comments' as const, label: `评论 (${comments.length})`, icon: MessageCircle },
    { id: 'official' as const, label: `官方回复 (${officialResponses.length})`, icon: CheckCircle },
    { id: 'snapshot' as const, label: '采集', icon: Camera },
    { id: 'history' as const, label: `处理记录 (${activity.length})`, icon: History },
  ]
  const modeActions = [
    { value: 'unhandled', label: '待处理', activeClass: 'bg-amber-100 text-amber-800 shadow-sm dark:bg-amber-950/50 dark:text-amber-200' },
    { value: 'reviewing', label: '负面流程', activeClass: 'bg-violet-100 text-violet-800 shadow-sm dark:bg-violet-950/50 dark:text-violet-200' },
    { value: 'official_responded', label: '官方已评', activeClass: 'bg-cyan-100 text-cyan-800 shadow-sm dark:bg-cyan-950/50 dark:text-cyan-200' },
    { value: 'no_action', label: '无需操作', activeClass: 'bg-card text-foreground shadow-sm ring-1 ring-border/70' },
  ]
  const pendingModeOption = modeActions.find(item => item.value === pendingMode)

  return (
    <div ref={panelRef} style={{ width }} role="dialog" aria-modal="true" aria-label="舆情内容详情"
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
          <h2 className="min-w-0 truncate text-[16px] font-bold">舆情内容详情</h2>
          {r.triage_status && <StatusBadge tone={r.triage_status}>{LABELS.triage[r.triage_status] || r.triage_status}</StatusBadge>}
          {archived && <StatusBadge tone="muted"><Archive className="h-3 w-3" />已归档</StatusBadge>}
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
                  <Tooltip text={r.alert_reasons || '已触发预警规则,建议优先处理'}><span className="inline-flex cursor-help items-center gap-1 rounded bg-status-red/12 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:text-rose-300"><Bell className="h-3 w-3" />预警 {alerts}</span></Tooltip>
                )}
                {negComments > 0 && (
                  <Tooltip text="该内容下被判为负面/风险的评论条数;下方可查看具体评论"><span className="cursor-help rounded bg-status-orange/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">负评 {negComments}</span></Tooltip>
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
          <div className="mobile-table-scroll sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-border/70 bg-muted/30 px-2 py-2 backdrop-blur-sm sm:px-4">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={cn('flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-semibold transition-colors sm:px-3',
                  tab === t.id ? 'bg-card text-primary shadow-sm ring-1 ring-border/50' : 'text-muted-foreground hover:bg-card/70 hover:text-foreground')}>
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab panels */}
          <div className="min-h-[260px] bg-background/35 p-4 sm:p-5">
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

                {tab === 'history' && (
                  <div className="space-y-5">
                    {canProcess && (
                      <section className="border-b border-border/60 pb-5">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <h4 className="flex items-center gap-1.5 text-[13px] font-semibold">
                            <StickyNote className="h-4 w-4 text-primary" />新增备注
                          </h4>
                          <span className="text-[11px] tabular-nums text-muted-foreground">{noteDraft.length}/2000</span>
                        </div>
                        <textarea
                          value={noteDraft}
                          maxLength={2000}
                          rows={3}
                          placeholder="记录沟通进展、判断依据或后续安排"
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
                            添加备注
                          </Button>
                        </div>
                      </section>
                    )}

                    <section>
                      <div className="mb-4 flex items-center justify-between gap-3">
                        <h4 className="text-[13px] font-semibold">处理时间线</h4>
                        <span className="text-[11px] text-muted-foreground">最新在前</span>
                      </div>
                      {activity.length === 0 ? (
                        <EmptyState icon={History} title="暂无处理记录" description="状态、判断、标签、归档、工单和备注变更会显示在这里" />
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
              <div className="flex w-full min-w-0 items-center gap-2" aria-label="内容处理操作">
                {onSetStatus && (
                  <section className="grid min-w-0 flex-1 grid-cols-4 gap-0.5 rounded-lg border border-border bg-muted/45 p-0.5" aria-label="处理模式">
                    {modeActions.map(item => {
                      const active = item.value === triageStatus
                      return (
                        <button
                          key={item.value}
                          type="button"
                          disabled={active || statusBusy || falsePositiveBusy}
                          onClick={() => {
                            setActionError('')
                            setPendingMode(item.value)
                          }}
                          aria-pressed={active}
                          className={cn(
                            'inline-flex h-8 min-w-0 items-center justify-center whitespace-nowrap rounded-md px-0.5 text-[9px] font-semibold transition-colors disabled:pointer-events-none sm:text-[11px]',
                            active
                              ? item.activeClass
                              : 'text-muted-foreground hover:bg-card/80 hover:text-foreground',
                          )}
                        >
                          {item.label}
                        </button>
                      )
                    })}
                  </section>
                )}
                {(onFalsePositive || onSetArchived) && (
                  <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-muted/45 p-0.5" aria-label="其他操作">
                    {onFalsePositive && (
                      <Tooltip text={falsePositivePending ? '误报已提交，等待平台管理员复核' : '提交误报'}>
                        <Button variant="ghost" size="sm" disabled={falsePositivePending || statusBusy || falsePositiveBusy} onClick={markFalsePositive}
                          className={cn(
                            'h-8 shrink-0 gap-1 px-2 text-[11px]',
                            falsePositivePending
                              ? 'text-emerald-600 disabled:opacity-100 dark:text-emerald-300'
                              : 'text-rose-600 hover:bg-rose-100 hover:text-rose-700 dark:text-rose-300 dark:hover:bg-rose-950/40',
                          )}
                          aria-label={falsePositivePending ? '误报已提交' : '提交误报'}>
                          {falsePositiveBusy
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : falsePositivePending
                              ? <CheckCircle className="h-3.5 w-3.5" />
                              : <Ban className="h-3.5 w-3.5" />}
                          <span>{falsePositivePending ? '已提交' : '误报'}</span>
                        </Button>
                      </Tooltip>
                    )}
                    {onSetArchived && (
                      <Tooltip text="归档">
                        <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-1 px-2 text-[11px]" disabled={statusBusy || falsePositiveBusy}
                          onClick={() => runStatusAction(() => onSetArchived(true))} aria-label="归档">
                          <Archive className="h-3.5 w-3.5" />
                          <span>归档</span>
                        </Button>
                      </Tooltip>
                    )}
                  </div>
                )}
                <Button className="h-9 shrink-0 rounded-lg px-3 sm:px-4" size="sm" disabled={statusBusy || falsePositiveBusy} onClick={onLinkIssue}>转工单</Button>
              </div>
            )}
            {actionError && <div className="mt-2 text-[12px] font-medium text-destructive">{actionError}</div>}
          </div>
        )}
      </div>

      {!archived && pendingModeOption && (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/35 p-3 sm:items-center sm:p-4 animate-in fade-in duration-150"
          onMouseDown={() => { if (!statusBusy) setPendingMode(null) }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="mode-confirm-title"
            aria-describedby="mode-confirm-description"
            className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl animate-in zoom-in-95 duration-150"
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/12 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0">
                <h3 id="mode-confirm-title" className="text-[15px] font-bold">确认更改处理模式？</h3>
                <p id="mode-confirm-description" className="mt-1 text-[12px] leading-5 text-muted-foreground">
                  本次只更新处理模式，不会自动归档内容。
                </p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)] items-center gap-2 rounded-lg border border-border/70 bg-muted/25 px-3 py-3 text-center">
              <div>
                <div className="text-[10px] font-medium text-muted-foreground">当前</div>
                <div className="mt-0.5 text-[13px] font-semibold">{LABELS.triage[triageStatus] || triageStatus}</div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-[10px] font-medium text-muted-foreground">更改为</div>
                <div className="mt-0.5 text-[13px] font-semibold text-primary">{pendingModeOption.label}</div>
              </div>
            </div>

            {actionError && <div className="mt-3 text-[12px] font-medium text-destructive">{actionError}</div>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={statusBusy} onClick={() => setPendingMode(null)}>取消</Button>
              <Button size="sm" disabled={statusBusy} onClick={() => void confirmModeChange()}>
                {statusBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                确认更改
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
    <div>
      {items.map(item => {
        const detail = activityDetail(item, recordId)
        const Icon = detail.icon
        return (
          <div key={`${item.action}-${item.id}`} className="relative border-l border-border pb-6 pl-6 last:pb-0">
            <span className={cn(
              'absolute -left-[9px] top-0 flex h-[18px] w-[18px] items-center justify-center rounded-full ring-4 ring-card',
              detail.tone === 'note' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
            )}>
              <Icon className="h-3 w-3" />
            </span>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="text-[13px] font-semibold">
                <span>{item.actor_name || '系统'}</span>
                <span className="ml-1 font-medium text-muted-foreground">{detail.title}</span>
              </div>
              <div className="text-[11px] tabular-nums text-muted-foreground">{formatFullDateSec(item.created_at)}</div>
            </div>
            {detail.body && (
              <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground/85">{detail.body}</p>
            )}
            {detail.changes.length > 0 && (
              <div className="mt-2.5 space-y-2">
                {detail.changes.map((change, index) => (
                  <div key={`${change.label}-${index}`} className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 text-[12px]">
                    <span className="text-muted-foreground">{change.label}</span>
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)] items-center gap-1.5">
                      <span className="break-words rounded-md bg-muted/60 px-2 py-1 text-center text-muted-foreground">{change.before}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/60" />
                      <span className="break-words rounded-md bg-primary/[0.07] px-2 py-1 text-center font-semibold text-foreground">{change.after}</span>
                    </div>
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
      body: reason ? `说明：${reason}` : '',
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
  if (item.action === 'record.ticket_created') {
    const assignee = String(metadata.assigneeName || '').trim()
    const note = String(metadata.note || '').trim()
    return {
      ...result,
      title: '转为工单',
      icon: LinkIcon,
      body: [assignee ? `处理人：${assignee}` : '', note ? `说明：${note}` : ''].filter(Boolean).join('\n'),
    }
  }
  if (item.action === 'record.official_responded') return { ...result, title: '采集到官方回复', icon: CheckCircle }
  if (item.action === 'record.reopened_by_comment_risk') return { ...result, title: '因新增负评重新进入待处理', icon: Bell }
  if (item.action === 'record.official_content_hidden') return { ...result, title: '识别为官方内容并移出分诊', icon: Eye }
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
    } catch {}
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
