import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertCircle, BarChart3, CheckCircle2, Eye, FileText, Loader2, Mail, RefreshCw, Send, Sparkles, X } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { useAuth } from '@/lib/auth'

type ReportRun = {
  id: string
  report_type: string
  period_start: string
  period_end: string
  status: string
  subject: string
  generated_at?: string
  sent_at?: string
  error_message?: string
  created_at?: string
}

type PreviewTab = 'management' | 'dashboard' | 'email'

type ReportPreview = {
  report: ReportRun
  subject: string
  managementHtml: string
  dashboardHtml: string
  emailHtml: string
}

const REPORT_OPTIONS = [
  { type: 'daily', label: '日报', title: '今日风险与待处理', desc: '新增线索、负面评论、官方响应、待跟进问题', icon: AlertCircle },
  { type: 'weekly', label: '周报', title: '趋势变化与复盘', desc: '主题演化、平台变化、重点问题和行动建议', icon: BarChart3 },
  { type: 'monthly', label: '月报', title: '管理层总结', desc: '重复问题、处置效率、长期风险和管理建议', icon: FileText },
]

const PREVIEW_TABS: Array<{ id: PreviewTab; label: string; icon: typeof FileText }> = [
  { id: 'management', label: '管理报告', icon: FileText },
  { id: 'dashboard', label: '报告看板', icon: BarChart3 },
  { id: 'email', label: '邮件摘要', icon: Mail },
]

function reportPeriod(report: ReportRun) {
  return `${formatDate(report.period_start)} - ${formatDate(report.period_end)}`
}

function reportIntent(type: string) {
  if (type === 'weekly') return '趋势复盘'
  if (type === 'monthly') return '管理层复盘'
  return '当日处置'
}

function previewHtml(preview: ReportPreview, tab: PreviewTab) {
  if (tab === 'dashboard') return preview.dashboardHtml || preview.managementHtml
  if (tab === 'email') return preview.emailHtml || preview.managementHtml
  return preview.managementHtml
}

export function ReportsTab() {
  const { canWrite } = useAuth()
  const [reports, setReports] = useState<ReportRun[]>([])
  const [loading, setLoading] = useState(true)
  const [busyType, setBusyType] = useState('')
  const [sendingId, setSendingId] = useState('')
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [preview, setPreview] = useState<ReportPreview | null>(null)
  const [previewTab, setPreviewTab] = useState<PreviewTab>('management')

  const latest = reports[0]
  const generatedCount = useMemo(() => reports.filter(r => ['generated', 'sent'].includes(r.status)).length, [reports])
  const failedCount = useMemo(() => reports.filter(r => r.status === 'failed').length, [reports])

  const load = async () => {
    setLoading(true)
    try {
      const data = await api.get<{ reports: ReportRun[] }>('/reports?limit=100')
      setReports(data.reports || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const generate = async (type: string) => {
    setNotice(null)
    setBusyType(type)
    try {
      const data = await api.post<{ report?: ReportRun }>('/reports/generate', { type, send: false, template: 'management' })
      await load()
      setNotice({ type: 'success', text: `${LABELS.reportType[type] || type}已生成，可先预览再发送。` })
      if (data.report?.id) await previewReport(data.report.id)
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '报告生成失败' })
    } finally {
      setBusyType('')
    }
  }

  const previewReport = async (id: string) => {
    const data = await api.get<any>('/reports/' + id + '/preview')
    setPreview({
      report: data.report,
      subject: data.report?.subject || '报告',
      managementHtml: data.managementHtml || data.html || '',
      dashboardHtml: data.dashboardHtml || data.html || '',
      emailHtml: data.emailHtml || data.html || '',
    })
    setPreviewTab('management')
  }

  const send = async (id: string) => {
    setNotice(null)
    setSendingId(id)
    try {
      await api.post('/reports/' + id + '/send')
      setNotice({ type: 'success', text: '报告已发送给系统设置里的邮件收件人。' })
      await load()
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '发送失败，请检查 SMTP 和收件人配置。' })
      await load()
    } finally {
      setSendingId('')
    }
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-5 duration-300">
      <section className="grid gap-5 rounded-lg border border-border bg-card p-5 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)]">
        <div className="flex min-w-0 flex-col justify-between gap-8">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-primary">Report Center</div>
            <h2 className="mt-2 text-2xl font-bold tracking-normal text-foreground">企业舆情报告看板</h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">
              报告中心负责周期归档、预览确认和邮件发送；实时筛选分析请进入左侧「数据看板」。日报看当日风险，周报看趋势复盘，月报看管理层长期问题。
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <ReportMetric label="可发送报告" value={generatedCount} />
            <ReportMetric label="发送失败" value={failedCount} tone={failedCount > 0 ? 'danger' : 'normal'} />
            <ReportMetric label="最近报告" value={latest ? LABELS.reportType[latest.report_type] || latest.report_type : '-'} compact />
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
          {REPORT_OPTIONS.map(option => {
            const Icon = option.icon
            const active = busyType === option.type
            return (
              <button
                key={option.type}
                type="button"
                disabled={!canWrite() || active}
                onClick={() => generate(option.type)}
                className="rounded-lg border border-border bg-background/60 p-4 text-left transition hover:border-primary hover:bg-card disabled:cursor-not-allowed disabled:opacity-55"
              >
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  {active ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
                </span>
                <div className="mt-3 text-xs font-bold text-primary">{option.label}</div>
                <strong className="mt-1 block text-sm text-foreground">{option.title}</strong>
                <small className="mt-2 block text-xs leading-5 text-muted-foreground">{option.desc}</small>
              </button>
            )
          })}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        <FlowCard step="1" title="生成" desc="聚合帖子、评论、问题、告警、官方响应和采集质量。" />
        <FlowCard step="2" title="预览" desc="检查管理报告、报告看板和邮件摘要三种视图。" />
        <FlowCard step="3" title="发送" desc="发给系统设置中的邮件收件人，失败原因会保留。" />
      </section>

      {notice && (
        <div className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${
          notice.type === 'success'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-rose-200 bg-rose-50 text-rose-700'
        }`}>
          {notice.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          <span>{notice.text}</span>
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h3 className="text-base font-bold">历史报告</h3>
            <p className="mt-1 text-xs text-muted-foreground">同周期重复生成会更新同一份报告，不重复创建。</p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : reports.length === 0 ? (
          <EmptyState icon={FileText} title="暂无报告" description="点击上方按钮生成第一份报告" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 [&>th]:px-3 [&>th]:py-2.5 [&>th]:text-[11px] [&>th]:font-medium [&>th]:uppercase [&>th]:tracking-wider [&>th]:whitespace-nowrap [&>th]:text-muted-foreground">
                  <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">报告</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">周期</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">状态</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">生成 / 发送</th>
                  <th className="px-5 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {reports.map(report => (
                  <tr key={report.id} className="transition-colors hover:bg-accent/45">
                    <td className="min-w-[360px] px-5 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge tone="neutral">{LABELS.reportType[report.report_type] || report.report_type}</StatusBadge>
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{reportIntent(report.report_type)}</span>
                      </div>
                      <div className="mt-2 font-semibold leading-6 text-foreground">{report.subject || '未命名报告'}</div>
                      {report.error_message && <div className="mt-1 text-xs text-destructive">{report.error_message}</div>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-muted-foreground">{reportPeriod(report)}</td>
                    <td className="px-4 py-4"><StatusBadge tone={report.status}>{LABELS.reportStatus[report.status] || report.status}</StatusBadge></td>
                    <td className="whitespace-nowrap px-4 py-4 text-xs leading-6 text-muted-foreground">
                      <div>生成：{formatDate(report.generated_at || report.created_at || '')}</div>
                      <div>发送：{report.sent_at ? formatDate(report.sent_at) : '-'}</div>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => previewReport(report.id)}>
                          <Eye className="h-3.5 w-3.5" /> 预览
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => send(report.id)} disabled={!canWrite() || sendingId === report.id}>
                          {sendingId === report.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                          发送
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {preview && (
        <ReportPreviewDrawer
          preview={preview}
          activeTab={previewTab}
          onTabChange={setPreviewTab}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}

function ReportMetric({ label, value, tone = 'normal', compact = false }: { label: string; value: ReactNode; tone?: 'normal' | 'danger'; compact?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-background/60 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 font-bold ${compact ? 'text-base' : 'text-2xl'} ${tone === 'danger' ? 'text-destructive' : 'text-foreground'}`}>{value}</div>
    </div>
  )
}

function FlowCard({ step, title, desc }: { step: string; title: string; desc: string }) {
  return (
    <div className="flex gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-sm font-bold text-primary">{step}</div>
      <div>
        <strong className="text-sm text-foreground">{title}</strong>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{desc}</p>
      </div>
    </div>
  )
}

function ReportPreviewDrawer({ preview, activeTab, onTabChange, onClose }: {
  preview: ReportPreview
  activeTab: PreviewTab
  onTabChange: (tab: PreviewTab) => void
  onClose: () => void
}) {
  const html = previewHtml(preview, activeTab)
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/35" />
      <div
        className="relative z-10 flex h-full w-full max-w-[1440px] flex-col border-l border-border bg-card shadow-lg animate-in slide-in-from-right duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-bold uppercase tracking-wide text-primary">Report Preview</div>
            <h2 className="mt-1 truncate text-base font-bold">{preview.subject}</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              <StatusBadge tone="neutral">{LABELS.reportType[preview.report.report_type] || preview.report.report_type}</StatusBadge>
              <StatusBadge tone={preview.report.status}>{LABELS.reportStatus[preview.report.status] || preview.report.status}</StatusBadge>
              <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground">{reportPeriod(preview.report)}</span>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/80 px-6 py-3">
          <div className="inline-flex rounded-lg border border-border bg-muted p-1">
            {PREVIEW_TABS.map(tab => {
              const Icon = tab.icon
              const active = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onTabChange(tab.id)}
                  className={`inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold transition ${
                    active ? 'bg-card text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            报告看板用于归档预览，实时筛选分析在「数据看板」。
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-[#F6F8FB]">
          {html ? (
            <div className="report-preview-content" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <EmptyState icon={FileText} title="暂无内容" />
          )}
        </div>
      </div>
    </div>
  )
}
