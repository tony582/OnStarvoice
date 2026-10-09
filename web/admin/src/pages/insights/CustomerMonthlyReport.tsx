import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Download, ExternalLink, FileText, Loader2, Mail, Printer, RefreshCw, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { useNav } from '@/lib/navigation'
import * as Dialog from '@radix-ui/react-dialog'
import { dailyPostStatusLabel } from './CustomerDailyReport.summary.mjs'
import { dailyError, safeReportUrl } from './CustomerDailyReport.types'
import { MONTHLY_API, monthlyTime, shanghaiMonth, type MonthlyCounts, type MonthlyGroup, type MonthlyPost, type MonthlyReport, type MonthlySettings } from './CustomerMonthlyReport.types'

type ReportResponse = { report: MonthlyReport; html: string; text: string }
type Notice = { kind: 'success' | 'error'; text: string }
const fields = ['monitor', 'sdb', 'positive', 'neutral', 'cold', 'comment', 'negativeProcess', 'negativeOther'] as const
const fieldLabels: Record<typeof fields[number], string> = { monitor: '平台监控量', sdb: 'SDB范畴', positive: '正面', neutral: '中性', cold: '冷处理', comment: '评论区留言', negativeProcess: '走负面处理流程', negativeOther: '其他' }
const platforms: Record<string, string> = { xiaohongshu: '小红书', xhs: '小红书', douyin: '抖音', weibo: '微博', bilibili: '哔哩哔哩', wechat: '微信', zhihu: '知乎', kuaishou: '快手', toutiao: '今日头条' }
const basisText = '按帖子发布时间（北京时间）统计内容分诊中未归档的主帖，同帖只计一次；SDB 扣除已复核-非监控内容；情感、处理状态和内容主题取本版生成时的有效结论。'

export function CustomerMonthlyReport() {
  const { tenantId } = useAuth()
  return <CustomerMonthlyReportWorkspace key={tenantId} />
}

function CustomerMonthlyReportWorkspace() {
  const { canWrite } = useAuth()
  const { params } = useNav()
  const currentMonth = shanghaiMonth()
  const explicitMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(params?.month || '') && params!.month <= currentMonth ? params!.month : ''
  const [month, setMonth] = useState(() => explicitMonth || shanghaiMonth(-1))
  const [reports, setReports] = useState<MonthlyReport[]>([])
  const [current, setCurrent] = useState<ReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [deliveryNotice, setDeliveryNotice] = useState<Notice | null>(null)
  const [pollError, setPollError] = useState('')
  const [settings, setSettings] = useState<MonthlySettings | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [reload, setReload] = useState(0)
  const [showDataStatus, setShowDataStatus] = useState(false)
  const requestSequence = useRef(0)
  const generationRequest = useRef<{ month: string; id: string } | null>(null)
  const operation = useRef(false)
  const mounted = useRef(true)
  const report = current?.report
  const snapshot = report?.snapshot
  const emailDelivery = report?.emailDelivery
  const emailStatus = emailDelivery?.status || 'none'
  const emailProcessing = emailStatus === 'queued' || emailStatus === 'working'
  const emailUnknown = emailDelivery?.ambiguous === true || (emailStatus === 'failed' && emailDelivery?.canRetry !== true)
  const blocked = snapshot?.warnings.some(warning => warning.blocking) || false
  const disabled = !!busy || loading

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; requestSequence.current += 1 }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const data = await api.get<{ settings: MonthlySettings }>(`${MONTHLY_API}/settings`)
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
    async function load() {
      // Reset inside the async task rather than synchronously in the effect
      // body (react-hooks/set-state-in-effect); the sequence guard keeps a
      // superseded request from touching state afterwards.
      setLoading(true)
      setNotice(null)
      setDeliveryNotice(null)
      try {
        const data = await api.get<{ reports: MonthlyReport[] }>(`${MONTHLY_API}/?month=${encodeURIComponent(month)}`)
        if (!mounted.current || sequence !== requestSequence.current) return
        setReports(data.reports)
        const selected = data.reports[0]
        if (!selected) { setCurrent(null); return }
        const detail = await api.get<ReportResponse>(`${MONTHLY_API}/${encodeURIComponent(selected.id)}`)
        if (!mounted.current || sequence !== requestSequence.current) return
        setCurrent(detail)
      } catch (error) {
        if (mounted.current && sequence === requestSequence.current) { setCurrent(null); setNotice({ kind: 'error', text: dailyError(error, '月报暂时无法读取，请稍后刷新。') }) }
      } finally {
        if (mounted.current && sequence === requestSequence.current) setLoading(false)
      }
    }
    void load()
  }, [month, reload])

  useEffect(() => {
    if (!report || !emailProcessing) return
    const id = report.id
    const timer = window.setInterval(async () => {
      try {
        const detail = await api.get<ReportResponse>(`${MONTHLY_API}/${encodeURIComponent(id)}`)
        if (!mounted.current) return
        setPollError('')
        setCurrent(value => value?.report.id === id ? detail : value)
        setReports(items => items.map(item => item.id === id ? detail.report : item))
      } catch (error) {
        if (mounted.current) setPollError(dailyError(error, '发送状态暂时无法刷新。'))
      }
    }, 5000)
    return () => window.clearInterval(timer)
  }, [report, emailProcessing])

  function chooseMonth(value: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value > currentMonth || operation.current) return
    setMonth(value)
  }

  async function generate() {
    if (!canWrite() || operation.current) return
    operation.current = true
    setBusy('generate')
    setNotice(null)
    try {
      if (generationRequest.current?.month !== month) generationRequest.current = { month, id: crypto.randomUUID() }
      const data = await api.post<{ report: MonthlyReport }>(`${MONTHLY_API}/generate`, { month, requestId: generationRequest.current.id })
      generationRequest.current = null
      if (!mounted.current) return
      const detail = await api.get<ReportResponse>(`${MONTHLY_API}/${encodeURIComponent(data.report.id)}`)
      if (!mounted.current) return
      setCurrent(detail)
      setReports(items => [detail.report, ...items.filter(item => item.id !== detail.report.id)])
      setNotice({ kind: 'success', text: `已生成 ${month} 月报第 ${detail.report.version} 版，可下载、发送邮件或下载明细。` })
    } catch (error) {
      if (mounted.current) setNotice({ kind: 'error', text: dailyError(error, '月报生成未完成，请重试。') })
    } finally {
      operation.current = false
      if (mounted.current) setBusy('')
    }
  }

  async function sendEmail() {
    if (!report || !canWrite() || operation.current || emailProcessing || emailUnknown || (emailStatus === 'sent' && !emailDelivery?.sendId) || !settings?.emailReady) return
    operation.current = true
    setBusy('email')
    setDeliveryNotice(null)
    try {
      const data = await api.post<{ report: MonthlyReport }>(`${MONTHLY_API}/${encodeURIComponent(report.id)}/email`, emailStatus === 'sent' ? { resendOf: emailDelivery?.sendId } : {})
      if (!mounted.current) return
      setCurrent(value => value?.report.id === data.report.id ? { ...value, report: { ...data.report, snapshot: data.report.snapshot || value.report.snapshot } } : value)
      setReports(items => items.map(item => item.id === data.report.id ? data.report : item))
      setPollError('')
    } catch (error) {
      if (mounted.current) setDeliveryNotice({ kind: 'error', text: dailyError(error, '邮件发送未完成，请检查当前状态。') })
      try {
        const detail = await api.get<ReportResponse>(`${MONTHLY_API}/${encodeURIComponent(report.id)}`)
        if (mounted.current) setCurrent(detail)
      } catch {
        if (mounted.current) setCurrent(value => value?.report.id === report.id ? { ...value, report: { ...value.report, emailDelivery: { ...value.report.emailDelivery, status: 'failed', ambiguous: true, canRetry: false, error: '发送结果暂时无法确认，请刷新核对；当前已暂停重复发送。' } } } : value)
      }
    } finally {
      operation.current = false
      if (mounted.current) setBusy('')
    }
  }

  async function exportReport(action: 'excel' | 'detail' | 'print') {
    if (!current || operation.current) return
    operation.current = true
    setBusy(action)
    setNotice(null)
    try {
      if (action === 'excel') {
        await api.download(`${MONTHLY_API}/${encodeURIComponent(current.report.id)}/excel`, `客户月报_${current.report.reportMonth}_v${current.report.version}.xlsx`)
      } else if (action === 'detail') {
        await api.download(`${MONTHLY_API}/${encodeURIComponent(current.report.id)}/detail.xlsx`, `客户月报明细_${current.report.reportMonth}_v${current.report.version}.xlsx`)
      } else {
        if (!current.html) throw new Error('这份月报正文尚未就绪，请刷新后再打印。')
        const frame = document.createElement('iframe')
        frame.title = '月报打印'
        frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
        frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;border:0;'
        frame.onload = () => { frame.contentWindow?.focus(); frame.contentWindow?.print(); setTimeout(() => frame.remove(), 60000) }
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
        <div><h2 className="text-xl font-semibold tracking-tight">客户舆情月报</h2><p className="mt-2 text-sm leading-6 text-slate-500">按发帖月份汇总内容分诊帖子、内容主题分布与高热负面，可下载明细。</p></div>
        <span className="rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700">{month === currentMonth ? '本月至今' : '按月归档'}</span>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 items-center gap-3 text-sm text-slate-600">报表月份<input aria-label="报表月份" className="h-10 min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/30" type="month" value={month} max={currentMonth} disabled={disabled} onChange={e => chooseMonth(e.target.value)} /></label>
        <Button variant="ghost" disabled={disabled} onClick={() => chooseMonth(shanghaiMonth(-1))}>上月</Button>
        <Button variant="ghost" disabled={disabled} onClick={() => chooseMonth(currentMonth)}>本月</Button>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button variant="outline" onClick={() => { setReload(value => value + 1); void loadSettings() }} disabled={disabled}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</Button>
          <Button onClick={() => void generate()} disabled={disabled || !canWrite()}>{busy === 'generate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}{reports.length ? '更新月报' : '生成月报'}</Button>
        </div>
      </div>
      <p className="mt-3 text-xs leading-6 text-slate-500">北京时间 · 按帖子发布月份统计，默认查看上个月。{reports.length > 1 ? `当前为第 ${report?.version ?? reports[0].version} 版，共 ${reports.length} 版。` : ''}</p>
      <div className="mt-4 space-y-3 border-t border-slate-200 pt-4" aria-label="月报发送">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0"><p className="break-all text-xs font-medium text-slate-700">邮件 · {emailDelivery?.recipients || settings?.emailRecipients || '尚未配置收件人'}</p><p role="status" aria-live="polite" className={`mt-1 text-xs ${emailStatus === 'failed' ? 'text-rose-700' : emailStatus === 'sent' ? 'text-emerald-700' : 'text-slate-500'}`}>{emailStatus === 'sent' ? '已发送邮件' : emailStatus === 'working' ? '正在发送邮件' : emailStatus === 'queued' ? '邮件已提交，等待发送' : emailStatus === 'failed' ? emailUnknown ? '发送结果待确认' : '邮件发送失败' : '尚未发送邮件'}{emailDelivery?.sentAt ? ` · ${monthlyTime(emailDelivery.sentAt)}` : ''}</p></div>
          <Button size="sm" variant="outline" onClick={() => void sendEmail()} disabled={!report || disabled || emailProcessing || emailUnknown || (emailStatus === 'sent' && !emailDelivery?.sendId) || !canWrite() || !settings?.emailReady}>{busy === 'email' || emailProcessing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}{emailStatus === 'sent' ? '再次发送邮件' : emailStatus === 'failed' && !emailUnknown ? '重试邮件发送' : '发送邮件'}</Button>
        </div>
        <p className="text-xs leading-5 text-slate-500">邮件附带月报 Excel 和本版明细 Excel，收件人沿用客户日报设置。</p>
        {deliveryNotice && <p role={deliveryNotice.kind === 'error' ? 'alert' : 'status'} className={`rounded-lg px-3 py-2 text-xs leading-5 ${deliveryNotice.kind === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}>{deliveryNotice.text}</p>}
        {emailDelivery?.error && <p role="alert" className="text-xs leading-5 text-rose-700">{emailDelivery.error}</p>}
        {emailUnknown && <p className="text-xs leading-5 text-slate-500">邮件发送结果待核对，当前暂停重复发送。</p>}
        {pollError && <p role="alert" className="text-xs leading-5 text-amber-800">{pollError} 正在继续查询，请勿重复发送。</p>}
        {settingsError && <p role="alert" className="text-xs text-amber-800">{settingsError}</p>}
        {settings?.emailConfigError && <p role="alert" className="text-xs text-amber-800">{settings.emailConfigError}</p>}
      </div>
    </section>

    {notice && <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
      {notice.kind === 'error' ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}<span>{notice.text}</span>
    </div>}

    {loading ? <div role="status" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white py-20 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" />正在读取月报…</div> : !snapshot ? <div className="rounded-xl border border-slate-200 bg-white px-6 py-16 text-center">
      <FileText className="mx-auto h-8 w-8 text-blue-500" /><h3 className="mt-4 text-base font-semibold">{reports.length ? '月报暂时无法读取' : `${month} 尚未生成月报`}</h3><p className="mt-2 text-sm text-slate-500">{canWrite() ? '点击「生成月报」，按发帖月份汇总内容分诊帖子、内容主题分布和高热负面。' : '有生成权限的同事生成后，即可在这里查看、下载和发送。'}</p>
    </div> : <>
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-semibold text-blue-700">{snapshot.complete === false ? `本月至今 · 截至 ${monthlyTime(snapshot.cutoffAt)}` : `最新月报 · 第 ${report?.version ?? snapshot.version ?? 1} 版`}</span><button type="button" aria-label={blocked ? '查看数据说明，有待确认事项' : '查看数据说明'} title="数据说明" onClick={() => setShowDataStatus(true)} className={`rounded-full p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${blocked ? 'text-amber-700 hover:bg-amber-100' : 'text-slate-500 hover:bg-slate-200'}`}><AlertCircle className="h-4 w-4" /></button></div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void exportReport('excel')}>{busy === 'excel' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}导出 Excel</Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void exportReport('detail')}>{busy === 'detail' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}下载明细（{snapshot.recordCount ?? snapshot.evidence?.recordCount ?? 0} 条）</Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void exportReport('print')}><Printer className="h-3.5 w-3.5" />打印 / PDF</Button>
          </div>
        </div>
        <article className="space-y-8 p-5 sm:p-7" aria-label="客户月报正文">
          <header className="border-b-2 border-blue-600 pb-5">
            <p className="text-xs font-medium text-blue-700">{snapshot.tenantName}</p>
            <h3 className="mt-2 text-2xl font-semibold tracking-tight">{snapshot.reportMonth} 舆情月报</h3>
            <p className="mt-2 text-xs text-slate-500">{snapshot.complete === false ? `统计截至 ${monthlyTime(snapshot.cutoffAt)}（本月尚未结束）` : `${snapshot.reportMonth} 全月发布帖子 · 生成于 ${monthlyTime(snapshot.assessedAt)}`}</p>
          </header>
          <ReportSection title="一、月度舆情汇总（按发帖日期）">
            <CountTable ariaLabel="逐日发帖汇总及月合计" firstHeader="发帖日期" rows={snapshot.summary.rows.map(row => ({ label: row.date.split('-').map(Number).join('/'), counts: row.counts }))} total={snapshot.summary.total} />
            <p className="mt-3 text-xs leading-6 text-slate-500">{basisText}</p>
          </ReportSection>
          <ReportSection title="二、内容主题分布">
            <CountTable ariaLabel="内容主题分布及合计" firstHeader="内容主题" rows={snapshot.summary.byTopic} total={snapshot.summary.total} left />
            <p className="mt-3 text-xs leading-6 text-slate-500">内容主题按帖子主要讨论对象单选归类；尚未生成主题的帖子列为「主题生成中」。</p>
          </ReportSection>
          <ReportSection title="三、平台分布">
            <CountTable ariaLabel="平台分布及合计" firstHeader="平台" rows={snapshot.summary.byPlatform} total={snapshot.summary.total} left />
          </ReportSection>
          <ReportSection title={`四、本月热度值≥200的负面帖子：${snapshot.topNegative.length} 条`}>
            <TopNegativeList posts={snapshot.topNegative} />
          </ReportSection>
        </article>
      </section>

      <Dialog.Root open={showDataStatus} onOpenChange={setShowDataStatus}>
        <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-slate-900/30" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%_-_2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-white p-6 shadow-xl focus:outline-none">
          <div className="mb-5 pr-7"><Dialog.Title className="text-base font-semibold text-slate-900">数据说明</Dialog.Title><Dialog.Description className="mt-2 text-xs text-slate-500">用于发送前核对，不加入客户月报正文。</Dialog.Description></div>
          <Dialog.Close aria-label="关闭数据说明" className="absolute right-4 top-4 rounded-lg p-2 text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X className="h-4 w-4" /></Dialog.Close>
          <div className="space-y-4 text-xs leading-6 text-slate-600">
            <p>统计范围：{monthlyTime(snapshot.periodStart)} 至 {monthlyTime(snapshot.cutoffAt)} 发布的帖子；生成时间 {monthlyTime(snapshot.assessedAt)}。北京时间。</p>
            {!!snapshot.warnings.length && <ul className="list-disc space-y-1 pl-5 text-amber-800">{snapshot.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul>}
            <p>{basisText}采集时间和处理时间不影响月份归属，与按处理日期统计的客户日报口径不同。</p>
            <p>高热负面帖按本月发布、情感为负面且可见互动合计（点赞、评论、收藏、分享）不低于 200 的帖子列出，取最近一次采集到的互动数；互动项缺失的按已知项合计并标为「至少」。</p>
            <p>系统统计负面：本月 {snapshot.summary.total.negative} 条；待识别或核对：{snapshot.summary.total.unclassified} 条。明细随本版本冻结保存，重新生成会产生新版本，不改写已有版本。</p>
          </div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </>}
  </div>
}

function CountTable({ ariaLabel, firstHeader, rows, total, left = false }: { ariaLabel: string; firstHeader: string; rows: Array<Pick<MonthlyGroup, 'label' | 'counts'>>; total: MonthlyCounts; left?: boolean }) {
  const cell = (counts: MonthlyCounts) => fields.map(field => <td key={field}>{Number(counts[field] ?? 0).toLocaleString()}</td>)
  return <div className="overflow-x-auto border border-slate-300">
    <table className="w-full min-w-[780px] border-collapse text-center text-xs tabular-nums" aria-label={ariaLabel}>
      <thead className="bg-[#101416] text-white">
        <tr className="[&>th]:border-b [&>th]:border-r [&>th]:border-slate-300 [&>th]:px-3 [&>th]:py-3 [&>th]:font-semibold [&>th:last-child]:border-r-0"><th rowSpan={2} scope="col" className={left ? 'w-40 text-left' : 'w-32'}>{firstHeader}</th><th rowSpan={2} scope="col">{fieldLabels.monitor}</th><th rowSpan={2} scope="col">{fieldLabels.sdb}</th><th rowSpan={2} scope="col">{fieldLabels.positive}</th><th rowSpan={2} scope="col">{fieldLabels.neutral}</th><th colSpan={4} scope="colgroup">负面</th></tr>
        <tr className="[&>th]:border-b [&>th]:border-r [&>th]:border-slate-300 [&>th]:px-3 [&>th]:py-2.5 [&>th]:font-semibold [&>th:last-child]:border-r-0"><th scope="col">{fieldLabels.cold}</th><th scope="col">{fieldLabels.comment}</th><th scope="col">{fieldLabels.negativeProcess}</th><th scope="col">{fieldLabels.negativeOther}</th></tr>
      </thead>
      <tbody>{rows.length ? rows.map(row => <tr key={row.label} className="border-b border-slate-300 [&>td]:border-r [&>td]:border-slate-300 [&>td]:px-3 [&>td]:py-2.5 [&>td:last-child]:border-r-0"><th scope="row" className={`border-r border-slate-300 px-3 py-2.5 font-normal ${left ? 'text-left' : ''}`}>{row.label}</th>{cell(row.counts)}</tr>) : <tr><td colSpan={9} className="border-b border-slate-300 px-3 py-4 text-slate-500">本月暂无帖子。</td></tr>}</tbody>
      <tfoot><tr className="bg-[#f2f2f2] font-semibold [&>td]:border-r [&>td]:border-slate-300 [&>td]:px-3 [&>td]:py-3 [&>td:last-child]:border-r-0"><th scope="row" className={`border-r border-slate-300 px-3 py-3 ${left ? 'text-left' : ''}`}>合计</th>{fields.map(field => <td key={field} aria-label={`合计 ${fieldLabels[field]}`}>{Number(total[field] ?? 0).toLocaleString()}</td>)}</tr></tfoot>
    </table>
  </div>
}

function ReportSection({ title, children }: { title: string; children: ReactNode }) {
  return <section><h4 className="mb-4 text-base font-semibold text-slate-900">{title}</h4>{children}</section>
}

function TopNegativeList({ posts }: { posts: MonthlyPost[] }) {
  if (!posts.length) return <p className="rounded-lg bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-500">本月暂未检出符合条件的帖子。</p>
  return <ol className="divide-y divide-slate-200 border-y border-slate-200">{posts.map((post, index) => {
    const url = safeReportUrl(post.url)
    return <li key={`${post.recordId}-${index}`} className="flex gap-3 py-4 sm:gap-4">
      <span className="min-w-8 pt-0.5 text-xs font-semibold tabular-nums text-blue-700">TOP{index + 1}</span>
      <div className="min-w-0 flex-1">
        {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="break-words text-sm font-medium leading-6 text-blue-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{post.title || '查看原帖'}<ExternalLink className="ml-1 inline h-3 w-3" /></a> : <p className="text-sm font-medium leading-6">{post.title || '标题待补'}<span className="ml-2 text-xs font-normal text-amber-800">原帖链接待补</span></p>}
        <p className="mt-1.5 break-words text-xs leading-5 text-slate-500">{platforms[post.platform] || post.platform || '未知平台'}｜热度 {post.heatIsLowerBound ? '至少 ' : ''}{post.heat.toLocaleString()}｜发布 {monthlyTime(post.publishedAt, true)}｜主题：{post.topicLabel || '主题生成中'}</p>
        <p className="mt-2 text-xs leading-5 text-slate-700"><span className="text-slate-500">处理状态：</span>{dailyPostStatusLabel(post)}</p>
      </div>
    </li>
  })}</ol>
}
