import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Copy, Download, ExternalLink, FileText, Loader2, Mail, Pencil, Printer, RefreshCw, Save, Send, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { useNav } from '@/lib/navigation'
import * as Dialog from '@radix-ui/react-dialog'
import { CustomerDailyReportCalendar } from './CustomerDailyReportCalendar'
import { isMonthlySummary, monthlyDraftFromRows, monthlyFields, monthlyLabels, parseMonthlyDraft, sumMonthlyRows } from './CustomerDailyReport.summary.mjs'
import { DAILY_API, dailyError, dailyTime, safeReportUrl, shanghaiDate, type DailyCalendar, type DailyCounts, type DailyPost, type DailyReport, type DailySettings, type DailySnapshot } from './CustomerDailyReport.types'

type ReportResponse = { report: DailyReport; html: string; text: string; messageHtml: string; messageText: string }
type Notice = { kind: 'success' | 'error'; text: string }
const summaryFields = ['monitor', 'sdb', 'positive', 'neutral', 'cold', 'inProgress', 'processed'] as const
type SummaryField = typeof summaryFields[number] | typeof monthlyFields[number]
type SummaryDraft = Record<string, Partial<Record<SummaryField, string>>>
const summaryLabels: Record<SummaryField, string> = { ...monthlyLabels, monitor: '监控数量', sdb: 'SDB范畴', positive: '正向', neutral: '中性', cold: '冷处理', inProgress: '处理中', processed: '已处理' }
const pendingStatuses = new Set(['queued', 'working', 'retry_wait'])
const deliveryLabels: Record<string, string> = {
  none: '尚未交付', queued: '已提交，通常在下一分钟开始准备', working: '已提交，正在准备文档与发送', retry_wait: '等待继续处理',
  needs_attention: '需要处理', document_ready: '飞书文档已就绪', sent: '已发送到群',
}
const platforms: Record<string, string> = { xiaohongshu: '小红书', xhs: '小红书', douyin: '抖音', weibo: '微博', bilibili: '哔哩哔哩', wechat: '微信', zhihu: '知乎', kuaishou: '快手', toutiao: '今日头条' }

export function CustomerDailyReport() {
  const { tenantId } = useAuth()
  // A tenant change must discard report data, requests, and unsaved credentials together.
  return <CustomerDailyReportWorkspace key={tenantId} />
}

function CustomerDailyReportWorkspace() {
  const { canWrite } = useAuth()
  const { params } = useNav()
  const explicitDate = /^\d{4}-\d{2}-\d{2}$/.test(params?.date || '') && params!.date <= shanghaiDate() ? params!.date : ''
  const [date, setDate] = useState(() => explicitDate || shanghaiDate())
  const [calendar, setCalendar] = useState<{ date: string; value: DailyCalendar } | null>(null)
  const [calendarError, setCalendarError] = useState('')
  const calendarDefaultPending = useRef(!explicitDate)
  const [reports, setReports] = useState<DailyReport[]>([])
  const [current, setCurrent] = useState<ReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [deliveryNotice, setDeliveryNotice] = useState<Notice | null>(null)
  const [pollError, setPollError] = useState('')
  const [settings, setSettings] = useState<DailySettings | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [reload, setReload] = useState(0)
  const [showDataStatus, setShowDataStatus] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const [summaryDraft, setSummaryDraft] = useState<SummaryDraft | null>(null)
  const summaryRequest = useRef<string | null>(null)
  const requestSequence = useRef(0)
  const versionToReload = useRef<string | null>(null)
  const generationRequest = useRef<{ date: string; id: string } | null>(null)
  const operation = useRef(false)
  const mounted = useRef(true)
  const today = shanghaiDate()
  const selectedCalendar = calendar?.date === date ? calendar.value : null
  const canGenerate = selectedCalendar?.isWorkingDay === true
  const report = current?.report
  const snapshot = report?.snapshot
  const delivery = report?.delivery
  const deliveryStatus = delivery?.status || 'none'
  const emailDelivery = report?.emailDelivery
  const emailStatus = emailDelivery?.status || 'none'
  const emailProcessing = emailStatus === 'queued' || emailStatus === 'working'
  const emailUnknown = emailDelivery?.ambiguous === true || (emailStatus === 'failed' && emailDelivery?.canRetry !== true)
  const processing = pendingStatuses.has(deliveryStatus)
  const anyProcessing = processing || emailProcessing
  const unknownResult = deliveryStatus === 'needs_attention' && delivery?.canRetry !== true
  const blocked = snapshot?.warnings.some(warning => warning.blocking) || false
  const documentUrl = safeReportUrl(delivery?.documentUrl)
  const previousFormalDelivery = report?.mode === 'formal' ? reports.find(item => item.mode === 'formal' && item.version < report.version && item.delivery?.status === 'sent') : undefined
  const disabled = !!busy || loading || !!summaryDraft

  useEffect(() => {
    if (!summaryDraft) return
    const preventLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLeave)
    return () => window.removeEventListener('beforeunload', preventLeave)
  }, [summaryDraft])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; requestSequence.current += 1 }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const data = await api.get<{ settings: DailySettings }>(`${DAILY_API}/settings`)
      if (!mounted.current) return
      setSettings(data.settings)
      setSettingsError('')
    } catch (error) {
      if (mounted.current) setSettingsError(dailyError(error, '发送配置暂时无法读取。'))
    }
  }, [])

  useEffect(() => { void Promise.resolve().then(loadSettings) }, [loadSettings])

  useEffect(() => {
    let cancelled = false
    async function loadCalendar() {
      try {
        const data = await api.get<{ calendar: DailyCalendar }>(`${DAILY_API}/calendar?date=${encodeURIComponent(date)}`)
        if (cancelled || !mounted.current) return
        setCalendarError('')
        setCalendar({ date, value: data.calendar })
        if (calendarDefaultPending.current) {
          calendarDefaultPending.current = false
          if (data.calendar.defaultReportDate !== date) setDate(data.calendar.defaultReportDate)
        }
      } catch (error) {
        if (!cancelled && mounted.current) {
          setCalendar(null)
          setCalendarError(dailyError(error, '工作日历暂时无法读取，请刷新重试。'))
        }
      }
    }
    void loadCalendar()
    return () => { cancelled = true }
  }, [date, reload])

  useEffect(() => {
    const sequence = ++requestSequence.current
    let cancelled = false
    async function loadDate() {
      setLoading(true)
      setNotice(null)
      setDeliveryNotice(null)
      setPollError('')
      setCurrent(null)
      setSummaryDraft(null)
      setShowDataStatus(false)
      setConfirmRegenerate(false)
      setReports([])
      try {
        const data = await api.get<{ reports: DailyReport[] }>(`${DAILY_API}/?date=${encodeURIComponent(date)}`)
        if (cancelled || sequence !== requestSequence.current) return
        setReports(data.reports || [])
        const selected = data.reports?.find(item => item.id === versionToReload.current) || data.reports?.[0]
        versionToReload.current = null
        if (selected) {
          const detail = await api.get<ReportResponse>(`${DAILY_API}/${encodeURIComponent(selected.id)}`)
          if (!cancelled && sequence === requestSequence.current) setCurrent(detail)
        }
      } catch (error) {
        if (!cancelled && sequence === requestSequence.current) setNotice({ kind: 'error', text: dailyError(error, '日报读取失败，请刷新重试。') })
      } finally {
        if (!cancelled && sequence === requestSequence.current) setLoading(false)
      }
    }
    void loadDate()
    return () => { cancelled = true }
  }, [date, reload])

  useEffect(() => {
    if (!report?.id || !anyProcessing) return
    const id = report.id
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let failures = 0
    async function poll() {
      try {
        const detail = await api.get<ReportResponse>(`${DAILY_API}/${encodeURIComponent(id)}`)
        if (stopped) return
        failures = 0
        setPollError('')
        setCurrent(value => value?.report.id === id ? detail : value)
        setReports(value => value.map(item => item.id === id ? detail.report : item))
        if (!pendingStatuses.has(detail.report.delivery?.status || 'none') && !['queued', 'working'].includes(detail.report.emailDelivery?.status || 'none')) return
      } catch (error) {
        if (stopped) return
        failures += 1
        setPollError(dailyError(error, '暂时无法更新发送状态，系统会继续查询。'))
      }
      timer = setTimeout(() => void poll(), Math.min(30000, 4000 * (failures + 1)))
    }
    timer = setTimeout(() => void poll(), 3000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [report?.id, anyProcessing])

  function chooseDate(value: string) {
    if (!value || value > today || operation.current || summaryDraft) return
    calendarDefaultPending.current = false
    generationRequest.current = null
    versionToReload.current = null
    setDate(value)
  }

  async function generate() {
    if (!canWrite() || operation.current || summaryDraft || !canGenerate) return
    operation.current = true
    setBusy('generate')
    setNotice(null)
    if (!generationRequest.current || generationRequest.current.date !== date) {
      generationRequest.current = { date, id: crypto.randomUUID() }
    }
    try {
      const data = await api.post<{ report: DailyReport }>(`${DAILY_API}/generate`, { date, requestId: generationRequest.current.id })
      if (!mounted.current) return
      generationRequest.current = null
      setReports(items => [data.report, ...items.filter(item => item.id !== data.report.id)])
      const detail = await api.get<ReportResponse>(`${DAILY_API}/${encodeURIComponent(data.report.id)}`)
      if (!mounted.current) return
      setCurrent(detail)
      setDeliveryNotice(null)
      setNotice({ kind: 'success', text: '日报已更新，尚未发送到群。' })
    } catch (error) {
      if (mounted.current) setNotice({ kind: 'error', text: dailyError(error, '生成失败，请重试。') })
    } finally {
      operation.current = false
      if (mounted.current) setBusy('')
    }
  }

  async function saveSummary() {
    if (!report || !summaryDraft || !canWrite() || operation.current) return
    let summary: Record<string, unknown>
    if (snapshot && isMonthlySummary(snapshot)) {
      try { summary = parseMonthlyDraft(snapshot.summary.rows!, summaryDraft) }
      catch (error) { setNotice({ kind: 'error', text: dailyError(error, '请检查汇总数值。') }); return }
    } else {
      const legacySummary = { day: {}, mtd: {} } as Record<'day' | 'mtd', Partial<Record<SummaryField, number | null>>>
      for (const period of ['day', 'mtd'] as const) {
        for (const field of summaryFields) {
          const value = (summaryDraft[period][field] || '').trim()
          const nullable = field === 'inProgress' || field === 'processed'
          if (value === '' && nullable) { legacySummary[period][field] = null; continue }
          const number = Number(value)
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0) {
            setNotice({ kind: 'error', text: `${period === 'day' ? '当日' : 'MTD'}${summaryLabels[field]}请填写非负整数。` })
            return
          }
          legacySummary[period][field] = number
        }
      }
      summary = legacySummary
    }
    operation.current = true
    setBusy('summary')
    setNotice(null)
    summaryRequest.current ||= crypto.randomUUID()
    try {
      const data = await api.post<{ report: DailyReport }>(`${DAILY_API}/${encodeURIComponent(report.id)}/summary`, { summary, requestId: summaryRequest.current })
      const detail = await api.get<ReportResponse>(`${DAILY_API}/${encodeURIComponent(data.report.id)}`)
      if (!mounted.current) return
      setCurrent(detail)
      setDeliveryNotice(null)
      setReports(items => [data.report, ...items.filter(item => item.id !== data.report.id)])
      setSummaryDraft(null)
      summaryRequest.current = null
      setNotice({ kind: 'success', text: '汇总已保存，可下载或发送更新后的日报。' })
    } catch (error) {
      if (mounted.current) {
        const message = dailyError(error, '汇总保存未完成，请重试。')
        setNotice({ kind: 'error', text: message.includes('日报已更新') ? '日报已更新，请先取消修改，再刷新查看最新日报。' : message })
      }
    } finally {
      operation.current = false
      if (mounted.current) setBusy('')
    }
  }

  async function deliver(action: 'document' | 'send') {
    if (!report || !canWrite() || operation.current || processing || unknownResult || summaryDraft) return
    operation.current = true
    setBusy(action)
    setNotice(null)
    setDeliveryNotice(null)
    try {
      const data = await api.post<{ report: DailyReport }>(`${DAILY_API}/${encodeURIComponent(report.id)}/${action}`, { allowIncomplete: true, ...(action === 'send' && deliveryStatus === 'sent' ? { resendOf: delivery?.sendId } : {}), ...(action === 'send' && previousFormalDelivery ? { correction: true } : {}) })
      if (!mounted.current) return
      if (data.report.id !== report.id) {
        const detail = await api.get<ReportResponse>(`${DAILY_API}/${encodeURIComponent(data.report.id)}`)
        if (!mounted.current) return
        setCurrent(detail)
        setDeliveryNotice({ kind: 'success', text: '已沿用本日已有的正式日报，避免重复发送。' })
      } else {
        setCurrent(value => value?.report.id === data.report.id ? { ...value, report: { ...data.report, snapshot: data.report.snapshot || value.report.snapshot } } : value)
      }
      setReports(items => items.some(item => item.id === data.report.id) ? items.map(item => item.id === data.report.id ? data.report : item) : [data.report, ...items])
      setPollError('')
    } catch (error) {
      if (mounted.current) setDeliveryNotice({ kind: 'error', text: dailyError(error, action === 'document' ? '文档准备失败，请查看发送配置。' : '发送未完成，请检查当前状态。') })
      try {
        const detail = await api.get<ReportResponse>(`${DAILY_API}/${encodeURIComponent(report.id)}`)
        if (mounted.current) setCurrent(detail)
      } catch { /* Keep the original error; do not repeat a potentially accepted delivery. */ }
    } finally {
      operation.current = false
      if (mounted.current) setBusy('')
    }
  }

  async function sendEmail() {
    if (!report || !canWrite() || operation.current || emailProcessing || emailUnknown || (emailStatus === 'sent' && !emailDelivery?.sendId) || summaryDraft || !settings?.emailReady) return
    operation.current = true
    setBusy('email')
    setDeliveryNotice(null)
    try {
      const data = await api.post<{ report: DailyReport }>(`${DAILY_API}/${encodeURIComponent(report.id)}/email`, emailStatus === 'sent' ? { resendOf: emailDelivery?.sendId } : {})
      if (!mounted.current) return
      setCurrent(value => value?.report.id === data.report.id ? { ...value, report: { ...data.report, snapshot: data.report.snapshot || value.report.snapshot } } : value)
      setReports(items => items.map(item => item.id === data.report.id ? data.report : item))
      setPollError('')
    } catch (error) {
      if (mounted.current) setDeliveryNotice({ kind: 'error', text: dailyError(error, '邮件发送未完成，请检查当前状态。') })
      try {
        const detail = await api.get<ReportResponse>(`${DAILY_API}/${encodeURIComponent(report.id)}`)
        if (mounted.current) setCurrent(detail)
      } catch {
        if (mounted.current) setCurrent(value => value?.report.id === report.id ? { ...value, report: { ...value.report, emailDelivery: { ...value.report.emailDelivery, status: 'failed', ambiguous: true, canRetry: false, error: '发送结果暂时无法确认，请刷新核对；当前已暂停重复发送。' } } } : value)
      }
    } finally {
      operation.current = false
      if (mounted.current) setBusy('')
    }
  }

  async function exportReport(action: 'excel' | 'image' | 'copy' | 'print') {
    if (!current || operation.current || summaryDraft) return
    operation.current = true
    setBusy(action)
    setNotice(null)
    try {
      if (action === 'excel') {
        await api.download(`${DAILY_API}/${encodeURIComponent(current.report.id)}/excel`, `舆情日报_${current.report.reportDate}.xlsx`)
      } else if (action === 'image') {
        await api.download(`${DAILY_API}/${encodeURIComponent(current.report.id)}/summary.png`, `舆情日报汇总_${current.report.reportDate}.png`)
      } else if (action === 'copy') {
        if (!current.messageText || !current.messageHtml) throw new Error('这份日报正文尚未就绪，请刷新后再复制。')
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          try {
            await navigator.clipboard.write([new ClipboardItem({
              'text/html': new Blob([current.messageHtml], { type: 'text/html' }),
              'text/plain': new Blob([current.messageText], { type: 'text/plain' }),
            })])
            setNotice({ kind: 'success', text: '已复制正文和链接，可与表格图片一起发送。' })
          } catch {
            await navigator.clipboard.writeText(current.messageText)
            setNotice({ kind: 'success', text: '已复制纯文字正文和完整链接，可与表格图片一起发送。' })
          }
        } else if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(current.messageText)
          setNotice({ kind: 'success', text: '已复制正文和完整链接，可与表格图片一起发送。' })
        } else {
          throw new Error('当前浏览器不支持剪贴板访问，请使用 Excel 导出。')
        }
      } else {
        if (!current.html) throw new Error('这份日报正文尚未就绪，请刷新后再打印。')
        const frame = document.createElement('iframe')
        frame.title = '日报打印'
        frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
        frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;border:0;'
        frame.onload = () => {
          frame.contentWindow?.focus()
          frame.contentWindow?.print()
          setTimeout(() => frame.remove(), 60000)
        }
        frame.srcdoc = current.html
        document.body.appendChild(frame)
      }
    } catch (error) {
      if (mounted.current) setNotice({ kind: 'error', text: dailyError(error, '操作未完成，请重试。') })
    } finally {
      operation.current = false
      if (mounted.current) setBusy('')
    }
  }

  return <div className="space-y-5 text-slate-900">
    <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 className="text-xl font-semibold tracking-tight">客户舆情日报</h2><p className="mt-2 text-sm leading-6 text-slate-500">每日汇总、重点负面和冷处理记录。</p></div>
        <span className="rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700">{date === today ? '今天' : '按日归档'}</span>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 items-center gap-3 text-sm text-slate-600">报表日期<input aria-label="报表日期" className="h-10 min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/30" type="date" value={date} max={today} disabled={disabled} onChange={e => chooseDate(e.target.value)} /></label>
        <Button variant="ghost" disabled={disabled} onClick={() => chooseDate(shanghaiDate(-1))}>昨天</Button>
        <Button variant="ghost" disabled={disabled} onClick={() => chooseDate(today)}>今天</Button>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button variant="outline" onClick={() => { setReload(value => value + 1); void loadSettings() }} disabled={disabled}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</Button>
          <Button onClick={() => { if (snapshot?.summaryEdited) setConfirmRegenerate(true); else void generate() }} disabled={disabled || !canWrite() || !canGenerate}>{busy === 'generate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}{reports.length ? '更新日报' : '生成日报'}</Button>
        </div>
      </div>
      <p className="mt-3 text-xs leading-6 text-slate-500">北京时间 · 默认查看最近工作日日报。</p>
      {selectedCalendar?.isWorkingDay === false && <p role="status" className="mt-1 text-xs leading-6 text-slate-500">非工作日，采集内容合并至 {selectedCalendar.nextWorkingDate} 日报。</p>}
      {calendarError && <p role="alert" className="mt-1 text-xs leading-6 text-amber-800">{calendarError}</p>}
      <div className="mt-4 space-y-3 border-t border-slate-200 pt-4" aria-label="日报发送">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0"><p className="text-xs font-medium text-slate-700">飞书群 · {settings?.chatName || delivery?.chatName || '尚未配置'}</p><p role="status" aria-live="polite" className={`mt-1 text-xs ${deliveryStatus === 'needs_attention' ? 'text-rose-700' : deliveryStatus === 'sent' ? 'text-emerald-700' : 'text-slate-500'}`}>{deliveryLabels[deliveryStatus]}{delivery?.sentAt ? ` · ${dailyTime(delivery.sentAt)}` : ''}</p></div>
          <div className="flex flex-wrap gap-2">
            {documentUrl ? <a className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-medium text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href={documentUrl} target="_blank" rel="noopener noreferrer">飞书工作文档<ExternalLink className="h-3.5 w-3.5" /></a> : <Button size="sm" variant="outline" onClick={() => void deliver('document')} disabled={!report || disabled || processing || unknownResult || !canWrite()}>{busy === 'document' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}生成飞书文档</Button>}
            <Button size="sm" onClick={() => void deliver('send')} disabled={!report || disabled || processing || unknownResult || (deliveryStatus === 'sent' && !delivery?.sendId) || !canWrite()}>{busy === 'send' || processing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}{deliveryStatus === 'sent' ? '再次发送到群' : previousFormalDelivery ? '发送更正版' : deliveryStatus === 'needs_attention' ? '继续发送' : '发送到飞书群'}</Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0"><p className="break-all text-xs font-medium text-slate-700">邮件 · {emailDelivery?.recipients || settings?.emailRecipients || '尚未配置收件人'}</p><p role="status" aria-live="polite" className={`mt-1 text-xs ${emailStatus === 'failed' ? 'text-rose-700' : emailStatus === 'sent' ? 'text-emerald-700' : 'text-slate-500'}`}>{emailStatus === 'sent' ? '已发送邮件' : emailStatus === 'working' ? '正在发送邮件' : emailStatus === 'queued' ? '邮件已提交，等待发送' : emailStatus === 'failed' ? emailUnknown ? '发送结果待确认' : '邮件发送失败' : '尚未发送邮件'}{emailDelivery?.sentAt ? ` · ${dailyTime(emailDelivery.sentAt)}` : ''}</p></div>
          <Button size="sm" variant="outline" onClick={() => void sendEmail()} disabled={!report || disabled || emailProcessing || emailUnknown || (emailStatus === 'sent' && !emailDelivery?.sendId) || !canWrite() || !settings?.emailReady}>{busy === 'email' || emailProcessing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}{emailStatus === 'sent' ? '再次发送邮件' : emailStatus === 'failed' && !emailUnknown ? '重试邮件发送' : '发送邮件'}</Button>
        </div>
        {deliveryNotice && <p role={deliveryNotice.kind === 'error' ? 'alert' : 'status'} className={`rounded-lg px-3 py-2 text-xs leading-5 ${deliveryNotice.kind === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}>{deliveryNotice.text}</p>}
        {delivery?.error && delivery.error !== deliveryNotice?.text && <p role="alert" className="text-xs leading-5 text-rose-700">{delivery.error}</p>}
        {emailDelivery?.error && <p role="alert" className="text-xs leading-5 text-rose-700">{emailDelivery.error}</p>}
        {unknownResult && <p className="text-xs leading-5 text-slate-500">飞书发送结果待核对，当前暂停重复发送。</p>}
        {emailUnknown && <p className="text-xs leading-5 text-slate-500">邮件发送结果待核对，当前暂停重复发送。</p>}
        {pollError && <p role="alert" className="text-xs leading-5 text-amber-800">{pollError} 正在继续查询，请勿重复发送。</p>}
        {settingsError && <p role="alert" className="text-xs text-amber-800">{settingsError}</p>}
        {settings?.emailConfigError && <p role="alert" className="text-xs text-amber-800">{settings.emailConfigError}</p>}
      </div>
    </section>

    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[276px_minmax(0,1fr)]">
    <CustomerDailyReportCalendar date={date} today={today} disabled={disabled} refresh={reload + reports.length} onSelect={chooseDate} />
    <div className="min-w-0 space-y-5">

    {notice && <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
      {notice.kind === 'error' ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}<span>{notice.text}</span>
    </div>}

    {loading ? <div role="status" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white py-20 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" />正在读取日报…</div> : !snapshot ? <div className="rounded-xl border border-slate-200 bg-white px-6 py-16 text-center">
      <FileText className="mx-auto h-8 w-8 text-blue-500" /><h3 className="mt-4 text-base font-semibold">{reports.length ? '日报暂时无法读取' : '这一天尚未生成日报'}</h3><p className="mt-2 text-sm text-slate-500">{selectedCalendar?.isWorkingDay === false ? `采集内容将合并至 ${selectedCalendar.nextWorkingDate} 日报。` : canWrite() ? '点击「生成日报」，查看这一天的监控汇总和帖子清单。' : '有生成权限的同事生成后，即可在这里查看和导出。'}</p>
    </div> : <>
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-semibold text-blue-700">{snapshot.mode === 'realtime' ? `实时 · 截至 ${dailyTime(snapshot.cutoffAt)}` : '最新日报'}</span><button type="button" aria-label={blocked ? '查看数据说明，有待确认事项' : '查看数据说明'} title="数据说明" onClick={() => setShowDataStatus(true)} className={`rounded-full p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${blocked ? 'text-amber-700 hover:bg-amber-100' : 'text-slate-500 hover:bg-slate-200'}`}><AlertCircle className="h-4 w-4" /></button></div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void exportReport('image')}>{busy === 'image' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}下载表格图片</Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void exportReport('excel')}>{busy === 'excel' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}导出 Excel</Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void exportReport('copy')}><Copy className="h-3.5 w-3.5" />复制正文</Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void exportReport('print')}><Printer className="h-3.5 w-3.5" />打印 / PDF</Button>
          </div>
        </div>
        <article className="space-y-8 p-5 sm:p-7" aria-label="客户日报正文">
          <header className="border-b-2 border-blue-600 pb-5">
            <p className="text-xs font-medium text-blue-700">{snapshot.tenantName}</p>
            <h3 className="mt-2 text-2xl font-semibold tracking-tight">{snapshot.reportDate} 舆情日报</h3>
            {snapshot.mode === 'realtime' && <p className="mt-2 text-xs text-slate-500">实时截至 {dailyTime(snapshot.cutoffAt)}</p>}
          </header>
          <SummaryTable snapshot={snapshot} draft={summaryDraft} canEdit={canWrite()} busy={!!busy || anyProcessing} onEdit={() => { setSummaryDraft(isMonthlySummary(snapshot) ? monthlyDraftFromRows(snapshot.summary.rows!) : summaryToDraft(snapshot.summary)); setNotice(null); summaryRequest.current = null }} onChange={(period, field, value) => { summaryRequest.current = null; setSummaryDraft(draft => draft ? { ...draft, [period]: { ...draft[period], [field]: value } } : null) }} onCancel={() => { setSummaryDraft(null); summaryRequest.current = null; setNotice(null) }} onSave={() => void saveSummary()} />
          <ReportSection title="二、7天内热度值≥200的负面帖子">
            <PostList posts={snapshot.highHeat} kind="heat" />
          </ReportSection>
          <ReportSection title={coldSectionTitle(snapshot.coldMarked)}>
            <PostList posts={snapshot.coldMarked} kind="cold" incomplete={snapshot.evidence?.cold?.coverageComplete !== true} />
          </ReportSection>
        </article>
      </section>

      <Dialog.Root open={showDataStatus} onOpenChange={setShowDataStatus}>
        <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-slate-900/30" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%_-_2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-white p-6 shadow-xl focus:outline-none">
          <div className="mb-5 pr-7"><Dialog.Title className="text-base font-semibold text-slate-900">数据说明</Dialog.Title><Dialog.Description className="mt-2 text-xs text-slate-500">用于发送前核对，不加入客户日报正文。</Dialog.Description></div>
          <Dialog.Close aria-label="关闭数据说明" className="absolute right-4 top-4 rounded-lg p-2 text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X className="h-4 w-4" /></Dialog.Close>
          <div className="space-y-4 text-xs leading-6 text-slate-600">
            <p>{snapshot.collectionCutoffAt ? <>新增统计截至 {dailyTime(snapshot.collectionCutoffAt)}；互动统计截至 {dailyTime(snapshot.cutoffAt)}</> : <>新增 / 互动统计截至 {dailyTime(snapshot.cutoffAt)}</>}；复核及冷处理状态截至 {dailyTime(snapshot.assessedAt)}。北京时间。</p>
            {!!snapshot.warnings.length && <ul className="list-disc space-y-1 pl-5 text-amber-800">{snapshot.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul>}
            {snapshot.collectionStartAt && snapshot.collectionCutoffAt ? <>
              <p>采集归属范围：{dailyTime(snapshot.collectionStartAt)} 至 {dailyTime(snapshot.collectionCutoffAt)}。前夜采集归当天，周末和法定节假日合并至下一工作日，调休上班日正常出报。</p>
              <p>监控仅计进入客户内容分诊清单的新增帖子，复采和后续修改状态不重复计数；SDB 扣除已复核的非监控内容。MTD 按日报归属月份累计。</p>
              {snapshot.calendarRevision && <p>工作日历：中国法定节假日及调休安排 · {snapshot.calendarRevision}。</p>}
            </> : <p>此日报按生成时的原统计范围展示：监控为首次成功入库的新帖，复采不重复计数；SDB 扣除已复核的非监控内容。</p>}
            <p>系统统计负面：当日 {snapshot.summary.day.negative} 条，MTD {snapshot.summary.mtd.negative} 条。待识别或核对：当日 {snapshot.summary.day.unclassified} 条，MTD {snapshot.summary.mtd.unclassified} 条。客户补填的汇总与系统统计分别保存。</p>
            {isMonthlySummary(snapshot) ? <p>工作日各项数值可在本页填写并保存，MTD 自动汇总；休息日显示空值。飞书文档里的修改不会自动同步回本页。</p> : <p>处理中、已处理初始为空，空白不代表 0。可在本页填写并保存；飞书文档里的修改不会自动同步回本页。</p>}
            <p>7 天发布时间：{dailyTime(snapshot.heatStart)} 至 {dailyTime(snapshot.cutoffAt)}。热度为点赞、评论、收藏、分享之和。</p>
          </div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={confirmRegenerate} onOpenChange={setConfirmRegenerate}>
        <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-slate-900/30" /><Dialog.Content role="alertdialog" className="fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl focus:outline-none">
          <Dialog.Title className="text-base font-semibold text-slate-900">更新日报？</Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-slate-600">更新数据会重新计算汇总，并清空本页手填值。是否继续？</Dialog.Description>
          <div className="mt-6 flex justify-end gap-2"><Dialog.Close asChild><Button variant="outline">取消</Button></Dialog.Close><Button onClick={() => { setConfirmRegenerate(false); void generate() }}>更新数据</Button></div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </>}
    </div>
    </div>
  </div>
}

function summaryToDraft(summary: DailySnapshot['summary']): SummaryDraft {
  return Object.fromEntries((['day', 'mtd'] as const).map(period => [period, Object.fromEntries(summaryFields.map(field => [field, summary[period][field] == null ? '' : String(summary[period][field])]))])) as SummaryDraft
}

function SummaryTable(props: Parameters<typeof LegacySummaryTable>[0]) {
  if (!isMonthlySummary(props.snapshot)) return <LegacySummaryTable {...props} />
  const { snapshot, draft, canEdit, busy, onEdit, onChange, onCancel, onSave } = props
  const rows = snapshot.summary.rows!
  const totals = sumMonthlyRows(rows, draft)
  return <section>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h4 className="text-base font-semibold text-slate-900">一、监控汇总</h4><p className="mt-1.5 text-xs text-slate-500">{snapshot.reportDate.slice(0, 7)} · 月初至报表日</p></div>{canEdit && <div className="flex gap-2">{draft ? <><Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button><Button size="sm" disabled={busy} onClick={onSave}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存汇总</Button></> : <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}><Pencil className="h-3.5 w-3.5" />编辑汇总</Button>}</div>}</div>
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[780px] border-collapse text-center text-xs tabular-nums" aria-label="逐日监控汇总与月累计">
        <thead className="bg-blue-50/80 text-slate-700">
          <tr className="[&>th]:border-b [&>th]:border-r [&>th]:border-slate-200 [&>th]:px-3 [&>th]:py-3 [&>th]:font-medium [&>th:last-child]:border-r-0"><th rowSpan={2} scope="col" className="w-32">舆情处理日期</th><th rowSpan={2} scope="col">平台监控量</th><th rowSpan={2} scope="col">SDB范畴</th><th rowSpan={2} scope="col">正面</th><th rowSpan={2} scope="col">中性</th><th colSpan={4} scope="colgroup">负面</th></tr>
          <tr className="[&>th]:border-b [&>th]:border-r [&>th]:border-slate-200 [&>th]:px-3 [&>th]:py-2.5 [&>th]:font-medium [&>th:last-child]:border-r-0"><th scope="col">冷处理</th><th scope="col">评论区留言</th><th scope="col">负面处理流程</th><th scope="col">其他</th></tr>
        </thead>
        <tbody>{rows.map(row => <tr key={row.date} className={`border-b border-slate-200 last:border-b-0 [&>td]:border-r [&>td]:border-slate-200 [&>td]:px-2 [&>td]:py-2.5 [&>td:last-child]:border-r-0 ${!row.isWorkingDay ? 'bg-slate-50 text-slate-400' : row.date === snapshot.reportDate ? 'bg-blue-50/30' : ''}`}>
          <th scope="row" className="border-r border-slate-200 px-3 py-2.5 font-medium">{row.date.split('-').map(Number).join('/')}{!row.isWorkingDay && <span className="ml-1.5 text-[10px] font-normal">休</span>}</th>
          {monthlyFields.map(field => <td key={field}>{!row.isWorkingDay ? <span aria-label="休息日，不填写">—</span> : draft ? <input type="text" inputMode="numeric" aria-label={`${row.date} ${monthlyLabels[field]}`} className="h-8 w-full min-w-12 rounded border border-blue-200 bg-white px-1 text-center text-xs focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:bg-slate-50" value={draft[row.date]?.[field] ?? ''} disabled={busy} onChange={event => onChange(row.date, field, event.target.value)} /> : Number(row.counts[field] ?? 0).toLocaleString()}</td>)}
        </tr>)}</tbody>
        <tfoot className="border-t-2 border-blue-200 bg-blue-50/80 font-semibold text-blue-900"><tr className="[&>td]:border-r [&>td]:border-blue-100 [&>td]:px-2 [&>td]:py-3 [&>td:last-child]:border-r-0"><th scope="row" className="border-r border-blue-100 px-3 py-3">MTD</th>{monthlyFields.map(field => <td key={field} aria-label={`MTD ${monthlyLabels[field]}`}>{Number(totals[field] ?? 0).toLocaleString()}</td>)}</tr></tfoot>
      </table>
    </div>
    <p className="mt-3 text-xs leading-6 text-slate-500">{draft ? '工作日填写非负整数，MTD 自动求和。请先保存或取消，再切换日期、下载或发送。' : 'MTD 自动汇总本月工作日；休息日采集内容合并到下一工作日。'}</p>
  </section>
}

function LegacySummaryTable({ snapshot, draft, canEdit, busy, onEdit, onChange, onCancel, onSave }: {
  snapshot: DailySnapshot
  draft: SummaryDraft | null
  canEdit: boolean
  busy: boolean
  onEdit: () => void
  onChange: (period: string, field: SummaryField, value: string) => void
  onCancel: () => void
  onSave: () => void
}) {
  const rows: Array<{ key: 'day' | 'mtd'; label: string; values: DailyCounts }> = [
    { key: 'day', label: snapshot.reportDate.slice(5).replace('-', '月') + '日', values: snapshot.summary.day },
    { key: 'mtd', label: 'MTD', values: snapshot.summary.mtd },
  ]
  return <section>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h4 className="text-base font-semibold text-slate-900">一、监控汇总（本期新增）</h4>{canEdit && <div className="flex gap-2">{draft ? <><Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button><Button size="sm" disabled={busy} onClick={onSave}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存汇总</Button></> : <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}><Pencil className="h-3.5 w-3.5" />编辑汇总</Button>}</div>}</div>
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[660px] border-collapse text-center text-sm tabular-nums" aria-label="监控汇总与月累计">
        <thead className="bg-blue-50/70 text-slate-700"><tr className="[&>th]:border-b [&>th]:border-r [&>th]:border-slate-200 [&>th]:px-3 [&>th]:py-3 [&>th]:font-medium [&>th:last-child]:border-r-0"><th rowSpan={2} scope="col">日期</th><th rowSpan={2} scope="col">监控数量</th><th rowSpan={2} scope="col">SDB范畴</th><th rowSpan={2} scope="col">正向</th><th rowSpan={2} scope="col">中性</th><th colSpan={3} scope="colgroup">负面</th></tr><tr className="[&>th]:border-b [&>th]:border-r [&>th]:border-slate-200 [&>th]:px-3 [&>th]:py-2.5 [&>th]:font-medium [&>th:last-child]:border-r-0"><th scope="col">冷处理</th><th scope="col">处理中</th><th scope="col">已处理</th></tr></thead>
        <tbody>{rows.map(({ key, label, values }) => <tr key={key} className={`[&>td]:border-r [&>td]:border-slate-200 [&>td]:px-3 [&>td]:py-4 [&>td:last-child]:border-r-0 ${key === 'mtd' ? 'border-t border-slate-200 bg-slate-50/70 font-medium' : ''}`}><th scope="row" className="border-r border-slate-200 px-3 py-4 font-medium">{label}</th>{summaryFields.map(field => <td key={field} aria-label={!draft && values[field] == null ? `${summaryLabels[field]}：待补填` : undefined}>{draft ? <input type="text" inputMode="numeric" aria-label={`${key === 'day' ? '当日' : 'MTD'}${summaryLabels[field]}`} className="h-9 w-full min-w-14 rounded border border-blue-200 bg-white px-1 text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:bg-slate-50" value={draft[key][field]} disabled={busy} onChange={event => onChange(key, field, event.target.value)} /> : values[field]?.toLocaleString() ?? ''}</td>)}</tr>)}</tbody>
      </table>
    </div>
    {draft && <p className="mt-3 text-xs leading-6 text-slate-500">填写非负整数；处理中、已处理可以留空。请先保存或取消，再切换日期、下载或发送。</p>}
  </section>
}

function ReportSection({ title, children }: { title: string; children: ReactNode }) {
  return <section><h4 className="mb-4 text-base font-semibold text-slate-900">{title}</h4>{children}</section>
}

function coldSectionTitle(posts: DailyPost[]) {
  const historicalCount = posts.every(post => typeof post.isHistorical === 'boolean')
    ? posts.filter(post => post.isHistorical).length : null
  return `三、本期冷处理负面帖：${posts.length} 条${historicalCount ? `（含历史帖 ${historicalCount} 条）` : ''}`
}

function PostList({ posts, kind, incomplete = false }: { posts: DailyPost[]; kind: 'heat' | 'cold'; incomplete?: boolean }) {
  if (!posts.length) return <p className="rounded-lg bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-500">{kind === 'heat' ? '暂未检出符合条件的帖子。' : incomplete ? '暂未检出。' : '本期无冷处理负面帖子。'}</p>
  return <ol className="divide-y divide-slate-200 border-y border-slate-200">{posts.map((post, index) => {
    const url = safeReportUrl(post.url)
    return <li key={`${post.recordId}-${index}`} className="flex gap-3 py-4 sm:gap-4">
      <span className="min-w-8 pt-0.5 text-xs font-semibold tabular-nums text-blue-700">{kind === 'heat' ? `TOP${index + 1}` : index + 1}</span>
      <div className="min-w-0 flex-1">
        {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="break-words text-sm font-medium leading-6 text-blue-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{post.title || '查看原帖'}<ExternalLink className="ml-1 inline h-3 w-3" /></a> : <p className="text-sm font-medium leading-6">{post.title || '标题待补'}<span className="ml-2 text-xs font-normal text-amber-800">原帖链接待补</span></p>}
        <p className="mt-1.5 text-xs leading-5 text-slate-500">{platforms[post.platform] || post.platform || '未知平台'}{kind === 'cold' && post.isHistorical === true && <span className="ml-2 inline-flex rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">历史帖</span>}{kind === 'heat' && <>｜热度 {post.heat?.toLocaleString() ?? '待核对'}｜较昨日 {(post.comparisonText || '暂无对比').replace(/^较昨日\s*[:：]?\s*/, '').trim() || '暂无对比'}</>}</p>
      </div>
    </li>
  })}</ol>
}
