import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, Copy, Download, ExternalLink, FileText, History, Loader2, Printer, RefreshCw, Send } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { CustomerDailyReportSettings } from './CustomerDailyReportSettings'
import { DAILY_API, dailyError, dailyTime, safeReportUrl, shanghaiDate, type DailyCounts, type DailyPost, type DailyReport, type DailySettings, type DailySnapshot } from './CustomerDailyReport.types'

type ReportResponse = { report: DailyReport; html: string; text: string }
type Notice = { kind: 'success' | 'error'; text: string }
const pendingStatuses = new Set(['queued', 'working', 'retry_wait'])
const deliveryLabels: Record<string, string> = {
  none: '尚未交付', queued: '等待准备', working: '正在准备文档与发送', retry_wait: '等待继续处理',
  needs_attention: '需要处理', document_ready: '飞书文档已就绪', sent: '已发送到群',
}
const platforms: Record<string, string> = { xiaohongshu: '小红书', xhs: '小红书', douyin: '抖音', weibo: '微博', bilibili: '哔哩哔哩', wechat: '微信', zhihu: '知乎', kuaishou: '快手', toutiao: '今日头条' }

export function CustomerDailyReport() {
  const { tenantId } = useAuth()
  // A tenant change must discard report data, requests, and unsaved credentials together.
  return <CustomerDailyReportWorkspace key={tenantId} />
}

function CustomerDailyReportWorkspace() {
  const { canWrite, user } = useAuth()
  const canManage = ['platform_admin', 'internal_operator'].includes(user?.globalRole || '')
  const [date, setDate] = useState(() => shanghaiDate(-1))
  const [reports, setReports] = useState<DailyReport[]>([])
  const [current, setCurrent] = useState<ReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pollError, setPollError] = useState('')
  const [settings, setSettings] = useState<DailySettings | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [allowIncomplete, setAllowIncomplete] = useState(false)
  const [sendCorrection, setSendCorrection] = useState(false)
  const [reload, setReload] = useState(0)
  const requestSequence = useRef(0)
  const versionToReload = useRef<string | null>(null)
  const generationRequest = useRef<{ date: string; id: string } | null>(null)
  const operation = useRef(false)
  const mounted = useRef(true)
  const today = shanghaiDate()
  const report = current?.report
  const snapshot = report?.snapshot
  const delivery = report?.delivery
  const deliveryStatus = delivery?.status || 'none'
  const processing = pendingStatuses.has(deliveryStatus)
  const unknownResult = deliveryStatus === 'needs_attention' && delivery?.canRetry !== true
  const blocked = snapshot?.warnings.some(warning => warning.blocking) || false
  const documentUrl = safeReportUrl(delivery?.documentUrl)
  const previousFormalDelivery = report?.mode === 'formal' ? reports.find(item => item.mode === 'formal' && item.version < report.version && item.delivery?.status === 'sent') : undefined
  const disabled = !!busy || loading

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
    const sequence = ++requestSequence.current
    let cancelled = false
    async function loadDate() {
      setLoading(true)
      setNotice(null)
      setPollError('')
      setAllowIncomplete(false)
      setSendCorrection(false)
      setCurrent(null)
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
    if (!report?.id || !processing) return
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
        if (!pendingStatuses.has(detail.report.delivery?.status || 'none')) return
      } catch (error) {
        if (stopped) return
        failures += 1
        setPollError(dailyError(error, '暂时无法更新发送状态，系统会继续查询。'))
      }
      timer = setTimeout(() => void poll(), Math.min(30000, 4000 * (failures + 1)))
    }
    timer = setTimeout(() => void poll(), 3000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [report?.id, processing])

  function chooseDate(value: string) {
    if (!value || value > today || operation.current) return
    generationRequest.current = null
    versionToReload.current = null
    setDate(value)
  }

  async function selectVersion(id: string) {
    if (operation.current) return
    const sequence = ++requestSequence.current
    setLoading(true)
    setNotice(null)
    setAllowIncomplete(false)
    setSendCorrection(false)
    setPollError('')
    setCurrent(null)
    try {
      const detail = await api.get<ReportResponse>(`${DAILY_API}/${encodeURIComponent(id)}`)
      if (mounted.current && sequence === requestSequence.current) setCurrent(detail)
    } catch (error) {
      if (mounted.current && sequence === requestSequence.current) setNotice({ kind: 'error', text: dailyError(error, '版本读取失败，请重试。') })
    } finally {
      if (mounted.current && sequence === requestSequence.current) setLoading(false)
    }
  }

  async function generate() {
    if (!canWrite() || operation.current) return
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
      setAllowIncomplete(false)
      setSendCorrection(false)
      setNotice({ kind: 'success', text: `v${data.report.version} 已生成，尚未发送到群。` })
    } catch (error) {
      if (mounted.current) setNotice({ kind: 'error', text: dailyError(error, '生成失败，请重试。') })
    } finally {
      operation.current = false
      if (mounted.current) setBusy('')
    }
  }

  async function deliver(action: 'document' | 'send') {
    if (!report || !canWrite() || operation.current || processing || unknownResult) return
    if (action === 'send' && previousFormalDelivery && !sendCorrection) return
    operation.current = true
    setBusy(action)
    setNotice(null)
    try {
      const data = await api.post<{ report: DailyReport }>(`${DAILY_API}/${encodeURIComponent(report.id)}/${action}`, { allowIncomplete, ...(action === 'send' && sendCorrection ? { correction: true } : {}) })
      if (!mounted.current) return
      if (data.report.id !== report.id) {
        const detail = await api.get<ReportResponse>(`${DAILY_API}/${encodeURIComponent(data.report.id)}`)
        if (!mounted.current) return
        setCurrent(detail)
        setSendCorrection(false)
        setAllowIncomplete(false)
        setNotice({ kind: 'success', text: '已沿用本日已有的正式日报，避免重复发送。' })
      } else {
        setCurrent(value => value?.report.id === data.report.id ? { ...value, report: { ...data.report, snapshot: data.report.snapshot || value.report.snapshot } } : value)
      }
      setReports(items => items.some(item => item.id === data.report.id) ? items.map(item => item.id === data.report.id ? data.report : item) : [data.report, ...items])
      setPollError('')
    } catch (error) {
      if (mounted.current) setNotice({ kind: 'error', text: dailyError(error, action === 'document' ? '文档准备失败，请查看发送配置。' : '发送未完成，请检查当前状态。') })
      try {
        const detail = await api.get<ReportResponse>(`${DAILY_API}/${encodeURIComponent(report.id)}`)
        if (mounted.current) setCurrent(detail)
      } catch { /* Keep the original error; do not repeat a potentially accepted delivery. */ }
    } finally {
      operation.current = false
      if (mounted.current) setBusy('')
    }
  }

  async function exportReport(action: 'excel' | 'copy' | 'print') {
    if (!current || operation.current) return
    operation.current = true
    setBusy(action)
    setNotice(null)
    try {
      if (action === 'excel') {
        await api.download(`${DAILY_API}/${encodeURIComponent(current.report.id)}/excel`, `舆情日报_${current.report.reportDate}_v${current.report.version}.xlsx`)
      } else if (action === 'copy') {
        if (!current.text || !current.html) throw new Error('这份日报正文尚未就绪，请刷新后再复制。')
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          try {
            await navigator.clipboard.write([new ClipboardItem({
              'text/html': new Blob([current.html], { type: 'text/html' }),
              'text/plain': new Blob([current.text], { type: 'text/plain' }),
            })])
            setNotice({ kind: 'success', text: '已复制日报表格、正文及完整链接，可粘贴到文档。' })
          } catch {
            await navigator.clipboard.writeText(current.text)
            setNotice({ kind: 'success', text: '此浏览器未允许复制表格格式，已复制完整文字和链接。' })
          }
        } else if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(current.text)
          setNotice({ kind: 'success', text: '已复制完整文字和链接；表格格式可通过 Excel 保留。' })
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
        <div><h2 className="text-xl font-semibold tracking-tight">客户舆情日报</h2><p className="mt-2 text-sm leading-6 text-slate-500">查看每日新增、重点负面和冷处理记录，交付客户继续完善。</p></div>
        <span className="rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700">{date === today ? '今天 · 实时日报' : '按日归档'}</span>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 items-center gap-3 text-sm text-slate-600">报表日期<input aria-label="报表日期" className="h-10 min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/30" type="date" value={date} max={today} disabled={disabled} onChange={e => chooseDate(e.target.value)} /></label>
        <Button variant="ghost" disabled={disabled} onClick={() => chooseDate(shanghaiDate(-1))}>昨天</Button>
        <Button variant="ghost" disabled={disabled} onClick={() => chooseDate(today)}>今天实时</Button>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button variant="outline" onClick={() => { setReload(value => value + 1); void loadSettings() }} disabled={disabled}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</Button>
          <Button onClick={() => void generate()} disabled={disabled || !canWrite()}>{busy === 'generate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}{reports.length ? '生成新版' : '生成日报'}</Button>
        </div>
      </div>
      <p className="mt-3 text-xs leading-6 text-slate-500">北京时间。默认查看昨天；今天新采集入库的数据归今天。生成新版会保留已有版本。</p>
    </section>

    {notice && <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
      {notice.kind === 'error' ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}<span>{notice.text}</span>
    </div>}

    {loading ? <div role="status" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white py-20 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" />正在读取日报…</div> : !snapshot ? <div className="rounded-xl border border-slate-200 bg-white px-6 py-16 text-center">
      <FileText className="mx-auto h-8 w-8 text-blue-500" /><h3 className="mt-4 text-base font-semibold">{reports.length ? '选择一个日报版本查看' : '这一天尚未生成日报'}</h3><p className="mt-2 text-sm text-slate-500">{canWrite() ? '点击「生成日报」，查看这一天的监控汇总和帖子清单。' : '有生成权限的同事生成后，即可在这里查看和导出。'}</p>
    </div> : <>
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-semibold text-blue-700">系统生成版 v{report?.version}</span><span className="text-slate-500">{snapshot.mode === 'realtime' ? `实时 · 截至 ${dailyTime(snapshot.cutoffAt)}` : '正式日报'} · 生成于 {dailyTime(report?.generatedAt)}</span></div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void exportReport('excel')}>{busy === 'excel' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}导出 Excel</Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void exportReport('copy')}><Copy className="h-3.5 w-3.5" />复制日报</Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void exportReport('print')}><Printer className="h-3.5 w-3.5" />打印 / PDF</Button>
          </div>
        </div>
        <article className="space-y-8 p-5 sm:p-7" aria-label="客户日报正文">
          <header className="border-b-2 border-blue-600 pb-5">
            <p className="text-xs font-medium text-blue-700">{snapshot.tenantName}</p>
            <h3 className="mt-2 text-2xl font-semibold tracking-tight">{snapshot.reportDate} 舆情日报</h3>
            <div className="mt-3 space-y-1 text-xs leading-6 text-slate-500"><p>新增 / 互动统计截至 {dailyTime(snapshot.cutoffAt)}；复核及冷处理状态截至 {dailyTime(snapshot.assessedAt)}</p><p>北京时间 · 系统初始数据。客户修改后的版本以飞书工作文档或客户保存的文件为准。</p></div>
          </header>
          {!!snapshot.warnings.length && <aside className="rounded-lg border border-amber-200 bg-amber-50/70 p-4" aria-label="数据完整性提示"><h4 className="flex items-center gap-2 text-sm font-semibold text-amber-900"><AlertCircle className="h-4 w-4" />本版数据说明</h4><ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-6 text-amber-900">{snapshot.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul></aside>}
          <SummaryTable snapshot={snapshot} />
          <ReportSection title="近7天发布、互动≥200的负面帖子" detail={`发布时间：${dailyTime(snapshot.heatStart)} 至 ${dailyTime(snapshot.cutoffAt)}；按最近有效观测排序。`}>
            <PostList posts={snapshot.highHeat} kind="heat" />
          </ReportSection>
          <ReportSection title="当天新增冷处理负面帖子" detail={`标记动作日期：${snapshot.reportDate}。包含以前采集、当天新标冷处理且本版仍有效的负面帖。`}>
            <PostList posts={snapshot.coldMarked} kind="cold" incomplete={snapshot.warnings.some(warning => /cold|audit|triage/i.test(warning.code) || /历史标记|冷处理.*不完整/.test(warning.message))} />
          </ReportSection>
        </article>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5" aria-label="飞书交付">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><h3 className="text-sm font-semibold">交付到飞书</h3><p className="mt-2 text-xs leading-6 text-slate-500">目标群：<span className="font-medium text-slate-800">{settings?.chatName || delivery?.chatName || '尚未配置'}</span> · 发送当前 v{report?.version}，客户可在工作文档中编辑并保存。</p></div>
          <div className="flex flex-wrap gap-2">
            {documentUrl && <a className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-medium text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href={documentUrl} target="_blank" rel="noopener noreferrer">打开飞书工作文档<ExternalLink className="h-3.5 w-3.5" /></a>}
            {!documentUrl && <Button variant="outline" onClick={() => void deliver('document')} disabled={!!busy || processing || unknownResult || !canWrite() || (blocked && !allowIncomplete)}>{busy === 'document' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}生成飞书文档</Button>}
            <Button onClick={() => void deliver('send')} disabled={!!busy || processing || unknownResult || deliveryStatus === 'sent' || !canWrite() || (blocked && !allowIncomplete) || (!!previousFormalDelivery && !sendCorrection)}>{busy === 'send' || processing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{deliveryStatus === 'sent' ? '已发送到群' : deliveryStatus === 'needs_attention' ? '继续发送' : sendCorrection ? '发送更正版' : '发送到飞书群'}</Button>
          </div>
        </div>
        <p role="status" aria-live="polite" className={`mt-3 flex items-center gap-2 text-xs ${deliveryStatus === 'needs_attention' ? 'text-rose-700' : deliveryStatus === 'sent' ? 'text-emerald-700' : 'text-slate-500'}`}>{processing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{deliveryLabels[deliveryStatus]}{delivery?.sentAt ? ` · ${dailyTime(delivery.sentAt)}` : ''}{processing ? '，页面会自动更新状态。' : ''}</p>
        {delivery?.error && <p role="alert" className="mt-2 text-xs leading-6 text-rose-700">{delivery.error}</p>}
        {unknownResult && <p className="mt-2 text-xs leading-6 text-slate-500">请管理员核对交付结果；当前暂停重复发送，避免出现重复文档或群消息。</p>}
        {pollError && <p role="alert" className="mt-2 text-xs leading-6 text-amber-800">{pollError} 正在继续查询，请勿重复发送。</p>}
        {blocked && canWrite() && <label className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-6 text-amber-900"><input type="checkbox" className="mt-1.5 accent-blue-600" checked={allowIncomplete} disabled={!!busy || processing} onChange={e => setAllowIncomplete(e.target.checked)} />仍交付当前已知数据，并在正文中保留以上数据缺口说明。</label>}
        {previousFormalDelivery && canWrite() && deliveryStatus !== 'sent' && <label className="mt-4 flex items-start gap-2 rounded-lg bg-blue-50 p-3 text-xs leading-6 text-blue-900"><input type="checkbox" className="mt-1.5 accent-blue-600" checked={sendCorrection} disabled={!!busy || processing} onChange={e => setSendCorrection(e.target.checked)} /><span>作为更正版发送，保留已交付旧版。<span className="block text-slate-500">这一天的 v{previousFormalDelivery.version} 已发送到当前群，勾选后才会另外发送本版；客户决定如何合并修改。</span></span></label>}
        <p className="mt-3 text-xs leading-6 text-slate-500">客户编辑不会被重新生成覆盖，也不会自动同步回此页面或系统导出的 Excel。</p>
      </section>
    </>}

    {!!reports.length && <details className="group rounded-xl border border-slate-200 bg-white" open={reports.length > 1 || !snapshot}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><History className="h-4 w-4 text-slate-500" />{date} 历史版本<span className="ml-auto text-xs font-normal text-slate-500">{reports.length} 个版本</span><ChevronDown className="h-4 w-4 group-open:rotate-180" /></summary>
      <div className="divide-y divide-slate-100 border-t border-slate-200">{reports.map(item => <div key={item.id} className={`flex flex-wrap items-center justify-between gap-3 px-5 py-3 ${item.id === report?.id ? 'bg-blue-50/60' : ''}`}>
        <div className="text-sm"><span className="font-medium">v{item.version} · {item.mode === 'realtime' ? '实时版' : '正式日报'}</span><span className="ml-3 text-xs text-slate-500">生成于 {dailyTime(item.generatedAt)} · {deliveryLabels[item.delivery?.status || 'none']}</span></div>
        <Button size="sm" variant="ghost" disabled={disabled || item.id === report?.id} onClick={() => void selectVersion(item.id)}>{item.id === report?.id ? '正在查看' : '查看此版'}</Button>
      </div>)}</div>
    </details>}
    {settings ? <CustomerDailyReportSettings settings={settings} canManage={canManage} onSaved={next => {
      setSettings(next)
      versionToReload.current = report?.id || null
      setReload(value => value + 1)
    }} /> : settingsError ? <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900"><span>{settingsError} 页面查看与导出仍可使用。</span><Button size="sm" variant="ghost" onClick={() => void loadSettings()}>重新读取配置</Button></div> : <p className="text-xs text-slate-500">正在读取发送配置…</p>}
  </div>
}

function SummaryTable({ snapshot }: { snapshot: DailySnapshot }) {
  const rows: Array<{ label: string; values: DailyCounts }> = [
    { label: snapshot.reportDate.slice(5).replace('-', '月') + '日', values: snapshot.summary.day },
    { label: 'MTD', values: snapshot.summary.mtd },
  ]
  return <ReportSection title="监控汇总" detail="监控数量仅计首次成功入库的新帖；同帖复采不重复计数。">
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[660px] border-collapse text-center text-sm tabular-nums" aria-label="监控汇总与月累计">
        <thead className="bg-blue-50/70 text-slate-700"><tr className="[&>th]:border-b [&>th]:border-r [&>th]:border-slate-200 [&>th]:px-3 [&>th]:py-3 [&>th]:font-medium [&>th:last-child]:border-r-0"><th rowSpan={2} scope="col">日期</th><th rowSpan={2} scope="col">监控数量</th><th rowSpan={2} scope="col">SDB范畴</th><th rowSpan={2} scope="col">正向</th><th rowSpan={2} scope="col">中性</th><th colSpan={3} scope="colgroup">负面</th></tr><tr className="[&>th]:border-b [&>th]:border-r [&>th]:border-slate-200 [&>th]:px-3 [&>th]:py-2.5 [&>th]:font-medium [&>th:last-child]:border-r-0"><th scope="col">冷处理</th><th scope="col">处理中</th><th scope="col">已处理</th></tr></thead>
        <tbody>{rows.map(({ label, values }) => <tr key={label} className={`[&>td]:border-r [&>td]:border-slate-200 [&>td]:px-3 [&>td]:py-4 [&>td:last-child]:border-r-0 ${label === 'MTD' ? 'border-t border-slate-200 bg-slate-50/70 font-medium' : ''}`}><th scope="row" className="border-r border-slate-200 px-3 py-4 font-medium">{label}</th><td>{values.monitor.toLocaleString()}</td><td>{values.sdb.toLocaleString()}</td><td>{values.positive.toLocaleString()}</td><td>{values.neutral.toLocaleString()}</td><td>{values.cold.toLocaleString()}</td><td aria-label="处理中：由客户补填" /><td aria-label="已处理：由客户补填" /></tr>)}</tbody>
      </table>
    </div>
    <p className="mt-3 text-xs leading-6 text-slate-500">当日负面共 <strong className="font-medium text-slate-700">{snapshot.summary.day.negative}</strong> 条，其中冷处理 {snapshot.summary.day.cold} 条；MTD 负面共 {snapshot.summary.mtd.negative} 条，其中冷处理 {snapshot.summary.mtd.cold} 条。处理中、已处理由客户补填，空白不代表 0。{snapshot.summary.day.unclassified > 0 ? `当日另有 ${snapshot.summary.day.unclassified} 条待识别或核对。` : ''}{snapshot.summary.mtd.unclassified > 0 ? `MTD 另有 ${snapshot.summary.mtd.unclassified} 条待识别或核对。` : ''}</p>
    <p className="mt-1 text-xs leading-6 text-slate-500">MTD 为月初至报表截止时间的首次入库集合，按本版复核结果统计；冷处理数量与下方当天标记清单可能不同。</p>
  </ReportSection>
}

function ReportSection({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return <section><h4 className="text-base font-semibold text-slate-900">{title}</h4><p className="mb-4 mt-1.5 text-xs leading-6 text-slate-500">{detail}</p>{children}</section>
}

function PostList({ posts, kind, incomplete = false }: { posts: DailyPost[]; kind: 'heat' | 'cold'; incomplete?: boolean }) {
  if (!posts.length) return <p className="rounded-lg bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-500">{kind === 'heat' ? '当前已核实数据中，暂无互动达到 200 的合资格负面帖子。' : incomplete ? '暂未检出，历史标记记录不完整。' : '当日无新增冷处理负面帖子。'}</p>
  return <ol className="divide-y divide-slate-200 border-y border-slate-200">{posts.map((post, index) => {
    const url = safeReportUrl(post.url)
    return <li key={`${post.recordId}-${index}`} className="flex gap-3 py-4 sm:gap-4">
      <span className="min-w-8 pt-0.5 text-xs font-semibold tabular-nums text-blue-700">{kind === 'heat' ? `TOP${index + 1}` : index + 1}</span>
      <div className="min-w-0 flex-1">
        {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="break-words text-sm font-medium leading-6 text-blue-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{post.title || '查看原帖'}<ExternalLink className="ml-1 inline h-3 w-3" /></a> : <p className="text-sm font-medium leading-6">{post.title || '标题待补'}<span className="ml-2 text-xs font-normal text-amber-800">原帖链接待补</span></p>}
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5 text-slate-500"><span>{platforms[post.platform] || post.platform}</span>{kind === 'heat' ? <><span className="font-medium text-slate-700">{post.stale ? '最近互动' : '互动'} {post.heat?.toLocaleString() ?? '待核对'}</span>{post.comparisonText && <span>较昨日 {post.comparisonText}</span>}<span>{post.timeSource === 'capture_timestamp' ? '实测时间' : post.timeSource === 'ingested_at' ? '入库时间' : '更新于'} {dailyTime(post.observedAt)}</span>{post.previousObservedAt && <span>昨日观测 {dailyTime(post.previousObservedAt)}</span>}{post.quality === 'legacy_unverified' && <span className="text-amber-800">历史入库记录，实测时间未核实</span>}{post.quality === 'measured_ingestion_time' && <span className="text-amber-800">实测时间未核实</span>}{post.stale && <span className="text-amber-800">本日待更新</span>}</> : <span>标记于 {dailyTime(post.markedAt)}</span>}{post.status === 'unavailable' && <span className="text-amber-800">已不可见</span>}{post.status === 'privacy_unreachable' && <span className="text-amber-800">隐私设置，无法访问</span>}</div>
      </div>
    </li>
  })}</ol>
}
