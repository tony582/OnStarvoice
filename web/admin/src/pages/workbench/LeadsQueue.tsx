import { useEffect, useState, useCallback, useRef } from 'react'
import {
  ChevronLeft, ChevronRight, Loader2, MessageSquareWarning, RefreshCw, Search,
  CheckCheck, CircleSlash, Footprints, Sparkles, Download, X, ArrowUp, ArrowDown,
  ChevronsUpDown, History, ArchiveRestore, Square, FileText,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatDateCompact, formatNumber, LABELS, platformName, cn } from '@/lib/utils'
import { COMMENT_LEAD_TYPES, COMMENT_LEAD_STATUSES, commentLeadIsArchived, commentLeadSource, commentLeadJudgment, commentLeadStatusLabel, commentLeadTicketStatusLabel, type CommentLead } from '@/lib/comment-leads'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchSelect, WorkbenchTableShell, WorkbenchTabs, WorkbenchToolbar } from '@/components/shared/Workbench'
import { KeywordFilter } from '@/components/shared/KeywordFilter'
import { MultiSelect } from '@/components/shared/MultiSelect'
import { DateRangeFilter, type DateBasis } from '@/components/shared/DateRangeFilter'
import { BatchBar, Checkbox, useSelection } from '@/components/shared/BatchBar'
import { CommentLeadDrawer } from '@/components/shared/CommentLeadDrawer'
import { RecordSourceAction } from '@/components/shared/RecordSourceAction'
import { useNotePrompt } from '@/components/shared/NotePrompt'
import { useTicketDispatch } from '@/components/shared/TicketDispatch'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'

type LeadSortField = 'publish' | 'first_seen' | 'last_seen'
type Pagination = { page: number; totalPages: number; total: number }
type RejudgeResult = { scanned: number; changed: number; retained: number; failed: number; skipped: number; total: number; hasMore: boolean; nextCursor?: string }

export function LeadsQueue({ initial, category = 'opinion' }: { initial?: Record<string, string>; category?: 'opinion' | 'sales' }) {
  const isSales = category === 'sales'
  const noun = isSales ? '销售客资' : '评论'
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const writable = canWrite()
  const [leads, setLeads] = useState<CommentLead[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [pageSize, setPageSize] = useState(30)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bucket, setBucket] = useState(initial?.bucket === 'archived' || ['resolved', 'ignored'].includes(initial?.status || '') ? 'archived' : 'active')
  const [status, setStatus] = useState(COMMENT_LEAD_STATUSES.some(option => option.value === initial?.status) ? initial!.status : '')
  const [platform, setPlatform] = useState(initial?.platform ?? '')
  const [leadType, setLeadType] = useState<string[]>(initial?.leadType ? [initial.leadType] : [])
  const [priority, setPriority] = useState(initial?.priority ?? '')
  const [keyword, setKeyword] = useState(initial?.keyword ?? '')
  const [keywordDraft, setKeywordDraft] = useState(initial?.keyword ?? '')
  const [sort, setSort] = useState<{ field: LeadSortField; dir: 'asc' | 'desc' }>({ field: 'publish', dir: 'desc' })
  const [captureKeywords, setCaptureKeywords] = useState<string[]>([])
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateBasis, setDateBasis] = useState<DateBasis>('publish')
  const [koe, setKoe] = useState('')
  const [exporting, setExporting] = useState(false)
  const [rejudging, setRejudging] = useState(false)
  const [rejudgeProgress, setRejudgeProgress] = useState<{ scanned: number; changed: number; failed: number; skipped: number; total: number } | null>(null)
  const [notice, setNotice] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ lead: CommentLead; tab: 'content' | 'history' | 'ticket' } | null>(null)
  const requestSeq = useRef(0)
  const currentListPage = useRef(1)
  const stopRejudge = useRef(false)
  const mounted = useRef(true)
  const { ask, dialog } = useNotePrompt()
  const { dispatch, dialog: dispatchDialog } = useTicketDispatch()

  const filterParams = useCallback(() => {
    const params = new URLSearchParams({ category, bucket })
    if (status) params.set('status', status)
    if (platform) params.set('platform', platform)
    if (!isSales) leadType.forEach(type => params.append('leadType', type))
    if (priority) params.set('priority', priority)
    if (keyword) params.set('keyword', keyword)
    params.set('sort', sort.field); params.set('dir', sort.dir)
    if (koe) params.set('koe', koe)
    captureKeywords.forEach(item => params.append('captureKeyword', item))
    if (dateFrom) params.set('dateFrom', dateFrom)
    if (dateTo) params.set('dateTo', dateTo)
    if (dateFrom || dateTo) params.set('dateBasis', dateBasis)
    return params
  }, [bucket, status, platform, leadType, priority, keyword, sort, category, isSales, koe, captureKeywords, dateFrom, dateTo, dateBasis])

  const sel = useSelection(`${filterParams().toString()}|${pageSize}|${pagination?.page ?? 1}`)
  const load = useCallback(async (page = 1) => {
    const seq = ++requestSeq.current
    currentListPage.current = page
    setLoading(true); setError('')
    try {
      const params = filterParams()
      params.set('page', String(page)); params.set('pageSize', String(pageSize))
      const data = await api.get<{ leads: CommentLead[]; pagination: Pagination }>('/leads/comments?' + params.toString())
      if (seq !== requestSeq.current) return
      setLeads(data.leads || []); setPagination(data.pagination || null)
      if (!data.leads?.length && page > 1 && data.pagination) {
        params.set('page', String(Math.max(1, data.pagination.totalPages)))
        const lastPage = await api.get<{ leads: CommentLead[]; pagination: Pagination }>('/leads/comments?' + params.toString())
        if (seq === requestSeq.current) { currentListPage.current = lastPage.pagination?.page || 1; setLeads(lastPage.leads || []); setPagination(lastPage.pagination || null) }
      }
    } catch (err) {
      if (seq === requestSeq.current) setError(err instanceof Error ? err.message : `${noun}加载失败`)
    } finally { if (seq === requestSeq.current) setLoading(false) }
  }, [filterParams, pageSize, noun])

  const latestLoad = useRef(load)
  useEffect(() => { latestLoad.current = load }, [load])

  useEffect(() => {
    let active = true
    stopRejudge.current = true
    queueMicrotask(() => { if (active) void load(1) })
    return () => { active = false }
  }, [load])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; requestSeq.current += 1; stopRejudge.current = true }
  }, [])

  const reloadAfterMutation = useCallback(async () => { await latestLoad.current(currentListPage.current); refreshBadges() }, [refreshBadges])
  const openDrawer = (lead: CommentLead, tab: 'content' | 'history' | 'ticket' = 'content') => {
    stopRejudge.current = true
    setDrawer({ lead, tab })
  }
  const updateLeadStatus = async (id: string, nextStatus: string): Promise<boolean> => {
    const note = await ask({ title: `${noun}处理备注`, placeholder: '记录本次处理、恢复原因或后续安排', confirmLabel: '保存状态' })
    if (note === null) return false
    setBusyId(id)
    try { await api.patch('/leads/comments/' + id, { status: nextStatus, ...(note.trim() ? { note: note.trim() } : {}) }); await reloadAfterMutation(); return true }
    finally { setBusyId(null) }
  }
  const runRowStatus = async (id: string, nextStatus: string) => {
    try { await updateLeadStatus(id, nextStatus) }
    catch (err) { setError(err instanceof Error ? err.message : '处理失败，请重试') }
  }
  const dispatchTicket = async (lead: CommentLead): Promise<boolean> => {
    const result = await dispatch({ sourceType: 'comment', summary: lead.comment_content || '', defaultPriority: lead.priority })
    if (!result) return false
    await api.post('/tickets', { sourceType: 'comment', sourceId: lead.id, externalTicketNo: result.externalTicketNo, priority: result.priority, assigneeUserId: result.assigneeUserId, assigneeName: result.assigneeName, note: result.note })
    await reloadAfterMutation()
    return true
  }
  const runBatch = async (nextStatus: string) => {
    if (!sel.count || batchBusy) return
    const note = await ask({ title: `批量${commentLeadStatusLabel(nextStatus)}`, helpText: `本次处理 ${sel.count} 条${noun}，备注将保存在每条跟进记录中。`, confirmLabel: '确认处理' })
    if (note === null) return
    setBatchBusy(true); setError('')
    try {
      const result = await api.patch<{ updated: number; skipped?: string[] }>('/leads/comments/batch', { ids: [...sel.selected], status: nextStatus, ...(note.trim() ? { note: note.trim() } : {}) })
      setNotice(`已更新 ${result.updated} 条${result.skipped?.length ? `，${result.skipped.length} 条未更新，请刷新核对` : ''}`)
      sel.clear(); await reloadAfterMutation()
    } catch (err) { setError(err instanceof Error ? err.message : '批量处理失败，请重试') }
    finally { setBatchBusy(false) }
  }
  const rejudgeSales = async () => {
    if (rejudging) return
    stopRejudge.current = false; setRejudging(true); setNotice(''); setRejudgeProgress(null); setError('')
    let cursor: string | undefined
    let scanned = 0, changed = 0, failed = 0, skipped = 0, total = 0
    let failureMessage = ''
    try {
      while (!stopRejudge.current) {
        const result = await api.post<RejudgeResult>('/leads/comments/rejudge-sales', { limit: 3, ...(cursor ? { cursor } : {}) })
        scanned += result.scanned || 0; changed += result.changed || 0; failed += result.failed || 0; skipped += result.skipped || 0; total = Math.max(total, result.total || 0)
        if (!mounted.current) return
        setRejudgeProgress({ scanned, changed, failed, skipped, total })
        if (!result.hasMore) break
        if (!result.nextCursor || result.nextCursor === cursor) throw new Error('本批已完成，但未返回下一批位置，已停止重判。')
        cursor = result.nextCursor
      }
      if (mounted.current) setNotice(`${stopRejudge.current ? '已停止后续重判' : '重判完成'}：检查 ${scanned} 条，移出非购买评论 ${changed} 条${failed ? `，${failed} 条判断失败、保留原结果` : ''}${skipped ? `，${skipped} 条处理期间数据发生变化或已有人工修正，已跳过、待核对` : ''}。`)
    } catch (err) {
      failureMessage = `${err instanceof Error ? err.message : '重判失败'}；已停止后续批次，可重新开始。`
    } finally {
      if (mounted.current) { setRejudging(false); await reloadAfterMutation(); if (failureMessage) setError(failureMessage) }
    }
  }
  const exportXlsx = async () => {
    setExporting(true)
    try { await api.download('/leads/comments/export?' + filterParams().toString(), `${noun}.xlsx`) }
    catch (err) { setError(err instanceof Error ? err.message : '导出失败，请重试') }
    finally { setExporting(false) }
  }
  const toggleSort = (field: LeadSortField) => setSort(value => value.field === field ? { field, dir: value.dir === 'desc' ? 'asc' : 'desc' } : { field, dir: 'desc' })
  const hasFilters = Boolean(status || platform || leadType.length || priority || keyword || koe || captureKeywords.length || dateFrom || dateTo)
  const clearFilters = () => { setStatus(''); setPlatform(''); setLeadType([]); setPriority(''); setKeyword(''); setKeywordDraft(''); setKoe(''); setCaptureKeywords([]); setDateFrom(''); setDateTo('') }
  const allChecked = leads.length > 0 && leads.every(lead => sel.has(lead.id))
  const someChecked = leads.some(lead => sel.has(lead.id))
  const statusOptions = COMMENT_LEAD_STATUSES.filter(option => bucket === 'archived' ? ['resolved', 'ignored'].includes(option.value) : ['new', 'following', 'ticketed'].includes(option.value))

  return <div className="space-y-3">
    <WorkbenchTabs tabs={[{ key: 'active', label: '工作中' }, { key: 'archived', label: '已归档' }]} activeKey={bucket} onChange={value => { setBucket(value); setStatus('') }} />
    <WorkbenchToolbar meta={`${formatNumber(pagination?.total ?? leads.length)} 条${noun}`}>
      <WorkbenchSelect aria-label="处理状态筛选" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</WorkbenchSelect>
      <WorkbenchSelect aria-label="平台筛选" value={platform} onChange={event => setPlatform(event.target.value)}><option value="">全部平台</option><option value="xiaohongshu">小红书</option><option value="douyin">抖音</option><option value="weibo">微博</option></WorkbenchSelect>
      {!isSales && <MultiSelect label="类型" options={COMMENT_LEAD_TYPES.filter(option => option.value !== 'sales_intent')} value={leadType} onChange={setLeadType} width="w-48" />}
      <WorkbenchSelect aria-label="来源筛选" value={koe} onChange={event => setKoe(event.target.value)}><option value="">全部来源</option><option value="hide">隐藏疑似 KOE</option><option value="only">只看疑似 KOE</option></WorkbenchSelect>
      <WorkbenchSelect aria-label="优先级筛选" value={priority} onChange={event => setPriority(event.target.value)}><option value="">全部优先级</option><option value="urgent">紧急</option><option value="high">高</option><option value="normal">普通</option><option value="low">低</option></WorkbenchSelect>
      <KeywordFilter value={captureKeywords} onChange={setCaptureKeywords} />
      <DateRangeFilter from={dateFrom} to={dateTo} onChange={(from, to) => { setDateFrom(from); setDateTo(to) }} basis={dateBasis} onBasisChange={setDateBasis} />
      {hasFilters && <button onClick={clearFilters} className="flex h-8 items-center gap-1 px-2 text-[12px] text-muted-foreground"><X className="h-3.5 w-3.5" />清空</button>}
      <form className="relative min-w-0 flex w-full items-center gap-1 sm:w-64" onSubmit={event => { event.preventDefault(); setKeyword(keywordDraft.trim()); if (keywordDraft.trim() === keyword) void load(1) }}><Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" /><Input aria-label="搜索评论、原帖、用户或 IP" value={keywordDraft} onChange={event => setKeywordDraft(event.target.value)} placeholder="搜索评论、原帖、用户、IP" className="h-8 pl-8 text-xs" /><Button type="submit" variant="outline" size="sm">搜索</Button></form>
      <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(pagination?.page || 1)}><RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />刷新</Button>
      <Button variant="outline" size="sm" disabled={exporting} onClick={() => void exportXlsx()}><Download className="h-3.5 w-3.5" />{exporting ? '导出中…' : '导出'}</Button>
      {isSales && writable && <Button variant="outline" size="sm" disabled={rejudging} onClick={() => void rejudgeSales()}><Sparkles className="h-3.5 w-3.5" />{rejudging ? 'AI 重判中…' : 'AI 重判'}</Button>}
    </WorkbenchToolbar>
    {rejudging && <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/[0.04] px-4 py-2.5 text-[12px]"><span>逐批核对购买意向{rejudgeProgress ? `：已检查 ${rejudgeProgress.scanned} / ${rejudgeProgress.total} 条，移出 ${rejudgeProgress.changed} 条，失败 ${rejudgeProgress.failed} 条，跳过 ${rejudgeProgress.skipped} 条` : '，正在处理首批…'}</span><Button variant="outline" size="sm" onClick={() => { stopRejudge.current = true; setNotice('正在完成当前批次，随后停止重判。') }}><Square className="h-3 w-3" />停止</Button></div>}
    {notice && <div role="status" className="rounded-lg border border-primary/20 bg-primary/[0.04] px-4 py-2.5 text-[12px]">{notice}</div>}
    {error && <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">{error}</div>}
    <WorkbenchTableShell mobileHint={false}>
      {loading ? <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div> : !leads.length ? <EmptyState icon={MessageSquareWarning} title={hasFilters ? '没有符合筛选条件的结果' : `暂无${bucket === 'archived' ? '已归档' : ''}${noun}`} description={hasFilters ? '调整筛选条件后重试。' : isSales ? '确认真实购买意向的评论会进入这里，可查看原帖、修正判断并记录跟进。' : '需要跟进的评论会进入这里，转工单后仍保留在工作中。'} /> : <>
        <div className="space-y-2.5 bg-muted/20 p-2 lg:hidden">
          {writable && <div className="flex items-center gap-2 rounded-xl bg-card p-3 text-[12px]"><Checkbox checked={allChecked} indeterminate={!allChecked && someChecked} onChange={() => sel.setAll(leads.map(lead => lead.id), !allChecked)} />全选本页<span className="ml-auto text-muted-foreground">已选 {sel.count} 条</span></div>}
          {leads.map(lead => <article key={lead.id} className={cn('space-y-3 rounded-xl border border-border bg-card p-3.5', drawer?.lead.id === lead.id && 'ring-2 ring-primary/15')}>
            <div className="flex items-center gap-2">{writable && <Checkbox checked={sel.has(lead.id)} onChange={() => sel.toggle(lead.id)} />}<StatusBadge tone="neutral">{platformName(lead.platform || '')}</StatusBadge><StatusBadge tone={lead.priority}>{LABELS.priority[lead.priority] || lead.priority}</StatusBadge><JudgmentBadge lead={lead} /><button onClick={() => openDrawer(lead)} className="ml-auto text-[12px] font-semibold text-primary">查看详情</button></div>
            <button onClick={() => openDrawer(lead)} className="block w-full whitespace-pre-wrap break-words text-left text-[14px] leading-6">{lead.comment_content || '(无内容)'}</button>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground"><span>{lead.comment_author_name || '未知用户'}</span><span>IP {lead.comment_ip_location || '—'}</span><span>赞 {formatNumber(lead.comment_like_count)}</span><span>{lead.publish_display || '时间未知'}</span></div>
            <div className="rounded-lg bg-muted/40 p-2.5"><div className="flex items-start gap-2"><span className="min-w-0 flex-1 text-[12px] leading-5">原帖：{lead.record_current_title || lead.record_title || '(无标题)'}</span><RecordSourceAction record={commentLeadSource(lead)} compact className="text-[11px]" /></div></div>
            <LeadProgress lead={lead} onClick={() => openDrawer(lead, 'history')} />
            <LeadActions lead={lead} canWrite={writable} busy={busyId === lead.id} onStatus={status => void runRowStatus(lead.id, status)} onNote={() => openDrawer(lead, 'history')} onTicket={() => openDrawer(lead, 'ticket')} />
          </article>)}
        </div>
        <div className="hidden overflow-x-auto lg:block"><table className="w-full min-w-[1120px] text-sm"><thead><tr className="border-b border-border/60 bg-muted/20 [&>th]:px-3 [&>th]:py-3 [&>th]:text-left [&>th]:text-[11px] [&>th]:font-medium [&>th]:whitespace-nowrap [&>th]:text-muted-foreground">
          {writable && <th className="w-10"><Checkbox checked={allChecked} indeterminate={!allChecked && someChecked} onChange={() => sel.setAll(leads.map(lead => lead.id), !allChecked)} /></th>}
          <th className="min-w-[280px]">评论与来源</th><th>评论者</th><th>类型 / 优先级</th><th className="min-w-[150px]">最近跟进</th>
          <SortableTh label="发布时间" field="publish" sort={sort} onSort={toggleSort} /><SortableTh label="首次发现" field="first_seen" sort={sort} onSort={toggleSort} /><SortableTh label="最近采集" field="last_seen" sort={sort} onSort={toggleSort} />
          <th className="sticky right-0 z-20 min-w-[210px] border-l border-border bg-card">处理状态 / 跟进</th>
        </tr></thead><tbody className="divide-y divide-border/50">{leads.map(lead => <tr key={lead.id} className={cn('group hover:bg-accent/35', drawer?.lead.id === lead.id && 'bg-accent/40', sel.has(lead.id) && 'bg-primary/[0.025]')}>
          {writable && <td className="px-3 py-3 align-top"><Checkbox checked={sel.has(lead.id)} onChange={() => sel.toggle(lead.id)} /></td>}
          <td className="max-w-[420px] px-3 py-3 align-top"><button onClick={() => openDrawer(lead)} className="block w-full text-left"><span className="line-clamp-3 whitespace-pre-wrap text-[13px] leading-6">{lead.comment_content || '(无内容)'}</span></button><div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><StatusBadge tone="neutral">{platformName(lead.platform || '')}</StatusBadge><span className="min-w-0 truncate" title={lead.record_current_title || lead.record_title}>原帖：{lead.record_current_title || lead.record_title || '(无标题)'}</span><RecordSourceAction record={commentLeadSource(lead)} compact /></div></td>
          <td className="px-3 py-3 align-top text-[12px]"><div className="max-w-32 truncate font-medium">{lead.comment_author_name || '—'}</div>{['dealer', 'employee'].includes(lead.comment_source_type || '') && <span className="mt-1 inline-block rounded bg-violet-500/10 px-1 py-0.5 text-[10px] text-violet-700 dark:text-violet-300">疑似 KOE</span>}<div className="mt-1 whitespace-nowrap text-[11px] text-muted-foreground">IP {lead.comment_ip_location || '—'} · 赞 {formatNumber(lead.comment_like_count)}</div></td>
          <td className="px-3 py-3 align-top"><div className="flex flex-col items-start gap-1.5"><StatusBadge tone="neutral">{LABELS.leadType[lead.lead_type] || lead.lead_type}</StatusBadge><StatusBadge tone={lead.priority}>{LABELS.priority[lead.priority] || lead.priority}</StatusBadge><JudgmentBadge lead={lead} /></div></td>
          <td className="max-w-[200px] px-3 py-3 align-top"><LeadProgress lead={lead} onClick={() => openDrawer(lead, 'history')} /></td>
          <td className="whitespace-nowrap px-3 py-3 align-top text-[11px] text-muted-foreground">{lead.publish_display || '—'}</td><td className="whitespace-nowrap px-3 py-3 align-top text-[11px] text-muted-foreground">{formatDateCompact(lead.comment_first_seen_at)}</td><td className="whitespace-nowrap px-3 py-3 align-top text-[11px] text-muted-foreground">{formatDateCompact(lead.comment_last_seen_at)}<div className="mt-1 text-[10px]">采集 {formatNumber(lead.comment_seen_count || 1)} 次</div></td>
          <td className="sticky right-0 z-10 border-l border-border bg-card px-3 py-3 align-top group-hover:bg-accent"><LeadActions lead={lead} canWrite={writable} busy={busyId === lead.id} onStatus={status => void runRowStatus(lead.id, status)} onNote={() => openDrawer(lead, 'history')} onTicket={() => openDrawer(lead, 'ticket')} /></td>
        </tr>)}</tbody></table></div>
      </>}
      {pagination && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"><div className="flex items-center gap-2 text-[12px] text-muted-foreground"><span>共 {formatNumber(pagination.total)} 条</span><select aria-label="每页条数" value={pageSize} onChange={event => setPageSize(Number(event.target.value))} className="h-8 rounded border border-border bg-background px-2">{[20, 30, 50, 100].map(size => <option key={size} value={size}>{size} 条/页</option>)}</select></div><div className="flex items-center gap-2"><Button variant="outline" size="sm" aria-label="上一页" disabled={loading || pagination.page <= 1} onClick={() => void load(pagination.page - 1)}><ChevronLeft className="h-4 w-4" /></Button><span className="text-[12px] tabular-nums text-muted-foreground">{pagination.page} / {Math.max(1, pagination.totalPages)}</span><Button variant="outline" size="sm" aria-label="下一页" disabled={loading || pagination.page >= pagination.totalPages} onClick={() => void load(pagination.page + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
    </WorkbenchTableShell>
    {writable && <BatchBar count={sel.count} busy={batchBusy} onClear={sel.clear} onAction={key => void runBatch(key)} actions={bucket === 'archived' ? [{ key: 'new', label: '恢复到待处理', icon: ArchiveRestore }] : [{ key: 'following', label: '跟进中', icon: Footprints }, { key: 'resolved', label: '已处理', icon: CheckCheck }, { key: 'ignored', label: '忽略', icon: CircleSlash }]} />}
    {drawer && <CommentLeadDrawer lead={drawer.lead} initialTab={drawer.tab} noun={noun} canWrite={writable} onClose={() => setDrawer(null)} onSetStatus={status => updateLeadStatus(drawer.lead.id, status)} onDispatch={() => dispatchTicket(drawer.lead)} onUpdated={reloadAfterMutation} />}
    {dialog}{dispatchDialog}
  </div>
}

function LeadActions({ lead, canWrite, busy, onStatus, onNote, onTicket }: { lead: CommentLead; canWrite: boolean; busy: boolean; onStatus: (status: string) => void; onNote: () => void; onTicket: () => void }) {
  const archived = commentLeadIsArchived(lead)
  return <div className="flex flex-wrap items-center gap-2">
    {canWrite && !archived ? <select aria-label={`${lead.comment_author_name || '评论'}的处理状态`} value={lead.status} disabled={busy} onChange={event => onStatus(event.target.value)} className="h-8 w-28 rounded-full border border-border bg-background px-2 text-[11px] font-semibold">{COMMENT_LEAD_STATUSES.filter(option => option.value !== 'ticketed' || lead.status === 'ticketed').map(option => <option key={option.value} value={option.value} disabled={option.value === 'ticketed'}>{option.label}</option>)}</select> : <StatusBadge tone={lead.status}>{commentLeadStatusLabel(lead.status)}</StatusBadge>}
    {archived && canWrite ? <Button variant="outline" size="sm" disabled={busy} onClick={() => onStatus('new')}><ArchiveRestore className="h-3.5 w-3.5" />恢复</Button> : <Button variant="outline" size="sm" onClick={onNote}><History className="h-3.5 w-3.5" />{canWrite ? '跟进' : '记录'}</Button>}
    {lead.ticket_id && <button type="button" onClick={onTicket} className="flex items-center gap-1 text-[10px] font-medium text-primary"><FileText className="h-3 w-3" />查看工单 · {commentLeadTicketStatusLabel(lead.ticket_status)}</button>}
  </div>
}

function LeadProgress({ lead, onClick }: { lead: CommentLead; onClick: () => void }) {
  const text = lead.progress_latest_body || lead.note || ''
  const count = Number(lead.progress_count || (text ? 1 : 0))
  return <button onClick={onClick} className="block w-full text-left text-[11px] leading-5"><span className={cn('line-clamp-2', text ? 'text-foreground' : 'text-muted-foreground')}>{text || '暂无跟进记录'}</span>{count > 0 && <span className="mt-1 block text-[10px] text-muted-foreground">{lead.progress_latest_author || lead.handled_name || ''} · {count} 条记录</span>}</button>
}

function SortableTh({ label, field, sort, onSort }: { label: string; field: LeadSortField; sort: { field: LeadSortField; dir: 'asc' | 'desc' }; onSort: (field: LeadSortField) => void }) {
  const active = sort.field === field
  const Arrow = active ? sort.dir === 'desc' ? ArrowDown : ArrowUp : ChevronsUpDown
  return <th><button onClick={() => onSort(field)} className={cn('flex items-center gap-1', active && 'text-foreground')}>{label}<Arrow className={cn('h-3 w-3', !active && 'opacity-30')} /></button></th>
}

function JudgmentBadge({ lead }: { lead: CommentLead }) {
  const judgment = commentLeadJudgment(lead)
  return judgment.label ? <StatusBadge tone={judgment.needsReview ? 'high' : 'muted'}>{judgment.label}</StatusBadge> : null
}
