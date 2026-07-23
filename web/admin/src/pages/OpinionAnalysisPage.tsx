import { useEffect, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, Check, ClipboardList, Copy, ExternalLink, Loader2,
  MessageSquare, Plus, Quote, Radar, RotateCcw, ScanSearch, ShieldAlert,
  Sparkles, TrendingUp, Trash2, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useNav } from '@/lib/navigation'
import { cn, formatDate, formatFullDate, formatNumber, LABELS } from '@/lib/utils'
import { StatusBadge, StatusPill } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/shared/EmptyState'

interface TopicAnalysis {
  id: string
  title: string
  focus_topic_id: string | null
  keywords: string[] | null
  period_start: string
  period_end: string
  status: string
  progress: { stage?: string; message?: string } | null
  sample_count: number | null
  analysis_source: string | null
  error?: string
  created_by?: string
  created_at: string
  payload?: any
}

const STATUS_LABEL: Record<string, string> = { pending: '排队中', running: '剖析中', done: '已完成', failed: '失败' }
const STATUS_TONE: Record<string, string> = { pending: 'pending', running: 'reviewing', done: 'resolved', failed: 'high' }
const SOURCE_LABEL: Record<string, string> = { llm_with_rule_metrics: 'AI 剖析', partial_llm: '部分 AI', rule_fallback: '规则兜底' }
const SOURCE_TONE: Record<string, string> = { llm_with_rule_metrics: 'generated', partial_llm: 'medium', rule_fallback: 'muted' }
// 主标签一律显示服务端写进 payload 的 riskLevelLabel;这份映射只服务「规则对照」小字与色条兜底,
// 值与 server/services/report-generator.js 的 RISK_LEVEL_LABEL 对齐
const RISK_TEXT: Record<string, string> = { critical: '重点处置', warning: '风险预警', attention: '需要关注', watch: '平稳观察' }
const RISK_BAR: Record<string, string> = {
  critical: 'bg-status-darkred text-white',
  warning: 'bg-status-red text-white',
  attention: 'bg-status-orange text-[#663d00]',
  watch: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
}
const STANCE_LABEL: Record<string, string> = { negative: '负面', mixed: '争议', neutral: '中立', positive: '正面' }
const STANCE_TONE: Record<string, string> = { negative: 'negative', mixed: 'medium', neutral: 'neutral', positive: 'positive' }

function fmtDay(v?: string | null) {
  if (!v) return '-'
  const d = new Date(v)
  if (isNaN(d.getTime())) return v
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function OpinionAnalysisPage() {
  const { canWrite } = useAuth()
  const [items, setItems] = useState<TopicAnalysis[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<TopicAnalysis | null>(null)
  const [detailError, setDetailError] = useState('')

  const loadList = () => api.get<any>('/opinion-analysis/topics')
    .then(d => setItems(d.analyses || []))
    .catch(console.error)

  useEffect(() => { loadList().finally(() => setLoading(false)) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 列表停留时对排队/运行中的行保持轮询,让状态徽章自己走到 done/failed
  useEffect(() => {
    if (selectedId || !items.some(x => x.status === 'pending' || x.status === 'running')) return
    const timer = window.setTimeout(loadList, 2500)
    return () => window.clearTimeout(timer)
  }, [items, selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 详情轮询:pending/running 每 2.5s 刷一次,done/failed 停
  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      try {
        const d = await api.get<any>(`/opinion-analysis/topics/${selectedId}`)
        if (!alive) return
        const row = d.analysis
        setDetail(row)
        setDetailError('')
        setItems(prev => prev.map(x => x.id === row.id ? { ...x, ...row, payload: undefined } : x))
        if (row.status === 'pending' || row.status === 'running') timer = window.setTimeout(tick, 2500)
      } catch (err) {
        if (alive) setDetailError(err instanceof Error ? err.message : '加载剖析详情失败')
      }
    }
    tick()
    return () => { alive = false; if (timer) window.clearTimeout(timer) }
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const rerun = async (id: string) => {
    try {
      const d = await api.post<any>(`/opinion-analysis/topics/${id}/rerun`)
      setItems(prev => [d.analysis, ...prev])
      setSelectedId(d.analysis.id)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '重跑失败')
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm('确定删除这条剖析记录?历史快照删除后不可恢复。')) return
    try {
      await api.delete(`/opinion-analysis/topics/${id}`)
      setItems(prev => prev.filter(x => x.id !== id))
      if (selectedId === id) setSelectedId('')
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '删除失败')
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  if (selectedId) {
    return (
      <DetailView detail={detail} error={detailError} canWrite={canWrite()}
        onBack={() => setSelectedId('')} onRerun={() => rerun(selectedId)} onDelete={() => remove(selectedId)} />
    )
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">圈定关键词与时间范围,对已采集舆情做四块深度拆解:风险研判、观点情绪、传播分析、应对口径。每次剖析都是留痕快照,可回看对比事件演化。</p>
        {canWrite() && (
          <Button size="sm" className="shrink-0" onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" />新建剖析</Button>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState icon={ScanSearch} title="还没有剖析记录"
          description={canWrite() ? '点右上角「新建剖析」,圈定一个话题开始深度拆解' : '等待有编辑权限的成员发起第一次剖析'} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map(item => (
            <AnalysisCard key={item.id} item={item} canWrite={canWrite()}
              onOpen={() => setSelectedId(item.id)} onRerun={() => rerun(item.id)} onDelete={() => remove(item.id)} />
          ))}
        </div>
      )}

      {creating && (
        <CreateDrawer onClose={() => setCreating(false)}
          onCreated={a => { setCreating(false); setItems(prev => [a, ...prev]); setSelectedId(a.id) }} />
      )}
    </div>
  )
}

function AnalysisCard({ item, canWrite, onOpen, onRerun, onDelete }: {
  item: TopicAnalysis; canWrite: boolean
  onOpen: () => void; onRerun: () => void; onDelete: () => void
}) {
  const keywords = Array.isArray(item.keywords) ? item.keywords : []
  const running = item.status === 'pending' || item.status === 'running'
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4 shadow-xs transition-all hover:border-input hover:shadow-sm">
      <button type="button" onClick={onOpen} className="flex flex-1 flex-col text-left">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone={STATUS_TONE[item.status] || 'neutral'}>
            {running && <Loader2 className="mr-0.5 h-2.5 w-2.5 animate-spin" />}
            {STATUS_LABEL[item.status] || item.status}
          </StatusBadge>
          {item.status === 'done' && item.analysis_source && (
            <StatusPill tone={SOURCE_TONE[item.analysis_source] || 'muted'}>{SOURCE_LABEL[item.analysis_source] || item.analysis_source}</StatusPill>
          )}
        </div>
        <h3 className="mt-2.5 line-clamp-2 text-[14px] font-bold leading-snug">{item.title || '(未命名剖析)'}</h3>
        <div className="mt-2 flex flex-wrap gap-1">
          {keywords.slice(0, 3).map(k => <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">{k}</span>)}
          {keywords.length > 3 && <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">+{keywords.length - 3}</span>}
          {!keywords.length && <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">全量内容</span>}
        </div>
        {running && <div className="mt-2 text-[11px] text-muted-foreground">{item.progress?.message || '处理中…'}</div>}
        {item.status === 'failed' && <div className="mt-2 line-clamp-2 text-[11px] text-status-red">{item.error || '剖析失败'}</div>}
        <div className="mt-2.5 text-[10.5px] text-muted-foreground">
          {fmtDay(item.period_start)} ~ {fmtDay(item.period_end)}
          {item.status === 'done' && ` · 样本 ${formatNumber(item.sample_count || 0)}`}
          {' · '}{formatDate(item.created_at)}
        </div>
      </button>
      {item.status === 'failed' && canWrite && (
        <div className="mt-3 flex gap-3 border-t border-border/70 pt-2.5">
          <button type="button" onClick={onRerun} className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline">
            <RotateCcw className="h-3 w-3" />重跑
          </button>
          <button type="button" onClick={onDelete} className="inline-flex items-center gap-1 text-[11px] font-medium text-status-red hover:underline">
            <Trash2 className="h-3 w-3" />删除
          </button>
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[12px] font-semibold">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[10.5px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function CreateDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (a: TopicAnalysis) => void }) {
  const { isInternal } = useAuth()
  const { navigate } = useNav()
  const [topics, setTopics] = useState<any[]>([])
  const [topicId, setTopicId] = useState('')
  const [title, setTitle] = useState('')
  const [keywordsText, setKeywordsText] = useState('')
  const [preset, setPreset] = useState<'7' | '30' | 'custom'>('7')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // api.ts 只透传 message 不带错误码,按服务端文案识别 brand_context_missing
  const brandMissing = error.includes('品牌')

  useEffect(() => {
    api.get<any>('/analytics/focus-topics').then(d => setTopics(d.topics || [])).catch(() => {})
  }, [])

  const pickTopic = (id: string) => {
    setTopicId(id)
    const topic = topics.find(t => t.id === id)
    if (topic) setKeywordsText((Array.isArray(topic.keywords) ? topic.keywords : []).join('、'))
  }

  const submit = async () => {
    let periodStart: Date
    let periodEnd: Date
    if (preset === 'custom') {
      if (!from || !to) { setError('请选择自定义时间范围'); return }
      periodStart = new Date(`${from}T00:00:00`)
      periodEnd = new Date(`${to}T23:59:59.999`)
      if (!(periodStart < periodEnd)) { setError('开始日期必须早于结束日期'); return }
    } else {
      periodEnd = new Date()
      periodStart = new Date(Date.now() - (preset === '7' ? 7 : 30) * 86400000)
    }
    const keywords = keywordsText.split(/[,，、\n]+/).map(s => s.trim()).filter(Boolean)
    setSubmitting(true)
    setError('')
    try {
      const d = await api.post<any>('/opinion-analysis/topics', {
        title: title.trim(),
        focusTopicId: topicId || undefined,
        keywords,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      })
      onCreated(d.analysis)
    } catch (err) {
      setError(err instanceof Error ? err.message : '发起剖析失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/35" />
      <div role="dialog" aria-modal="true" aria-label="新建剖析"
        className="relative z-10 flex h-full w-full max-w-lg flex-col border-l border-border bg-card shadow-lg animate-in slide-in-from-right duration-200" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-4 sm:px-6">
          <h2 className="inline-flex items-center gap-2 text-base font-bold"><ScanSearch className="h-4 w-4 text-primary" />新建话题剖析</h2>
          <button onClick={onClose} aria-label="关闭新建剖析" className="rounded-lg p-2 text-muted-foreground transition hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-6">
          <Field label="关注主题(可选)" hint="选主题自动带出关键词,仍可继续编辑;剖析结果会归入该主题">
            <select value={topicId} onChange={e => pickTopic(e.target.value)}
              className="flex h-11 w-full rounded-md border border-input bg-card px-3 text-base outline-none transition-colors focus:border-primary lg:h-9 lg:text-[13px]">
              <option value="">不关联主题,手动圈定</option>
              {topics.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>

          <Field label="关键词" hint="多个关键词用顿号、逗号或换行分隔;留空 = 剖析全量相关内容">
            <Input value={keywordsText} onChange={e => setKeywordsText(e.target.value)} placeholder="输入监控中的采集关键词" />
          </Field>

          <Field label="时间范围">
            <div className="flex gap-1.5">
              {([['7', '近7天'], ['30', '近30天'], ['custom', '自定义']] as const).map(([value, label]) => (
                <button key={value} type="button" onClick={() => setPreset(value)}
                  className={cn('h-9 flex-1 rounded-lg text-[12px] font-medium transition-colors lg:h-8',
                    preset === value ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground')}>
                  {label}
                </button>
              ))}
            </div>
            {preset === 'custom' && (
              <div className="mt-2 flex items-center gap-2">
                <Input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="开始日期" />
                <span className="shrink-0 text-xs text-muted-foreground">至</span>
                <Input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="结束日期" />
              </div>
            )}
          </Field>

          <Field label="标题(可选)">
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="留空自动按关键词命名" maxLength={120} />
          </Field>

          {error && (
            brandMissing ? (
              <div className="rounded-lg border border-status-orange/30 bg-status-orange/[0.08] p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <div className="text-[12px] leading-relaxed">
                    <p className="font-semibold">尚未配置品牌语境,无法发起剖析</p>
                    <p className="mt-0.5 text-muted-foreground">剖析的回应话术按品牌口径生成,需要先配置品牌名称与业务语境。{!isInternal() && '请联系平台管理员完成配置。'}</p>
                    {isInternal() && (
                      <button type="button" onClick={() => navigate('settings')} className="mt-1.5 font-semibold text-primary hover:underline">前往系统设置配置 →</button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[12px] leading-relaxed text-status-red">{error}</p>
            )
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3.5 sm:px-6">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}发起剖析
          </Button>
        </div>
      </div>
    </div>
  )
}

const STEPS = [
  { key: 'collect', label: '圈定样本', desc: '统计声量 / 情绪 / 预警' },
  { key: 'analyze', label: 'AI 研判', desc: '风险观点 + 传播应对' },
  { key: 'finalize', label: '汇总结果', desc: '合并规则与 AI 产出' },
]

function stepIndex(stage?: string) {
  if (stage === 'collect') return 0
  if (stage === 'analyze') return 1
  if (stage === 'finalize' || stage === 'done') return 2
  return -1 // pending 排队中
}

function ProgressSteps({ progress, status }: { progress: TopicAnalysis['progress']; status: string }) {
  const idx = stepIndex(progress?.stage)
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center">
        {STEPS.map((step, i) => {
          const state = i < idx ? 'done' : i === idx ? 'current' : 'todo'
          return (
            <div key={step.key} className={cn('flex items-center', i > 0 && 'flex-1')}>
              {i > 0 && <div className={cn('mx-2 h-px flex-1', i <= idx ? 'bg-primary/50' : 'bg-border')} />}
              <div className="flex flex-col items-center gap-1.5">
                <span className={cn('flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-bold transition-colors',
                  state === 'done' && 'bg-primary text-primary-foreground',
                  state === 'current' && 'border-2 border-primary text-primary',
                  state === 'todo' && 'border border-border text-muted-foreground')}>
                  {state === 'done' ? <Check className="h-4 w-4" /> : state === 'current' ? <Loader2 className="h-4 w-4 animate-spin" /> : i + 1}
                </span>
                <span className={cn('whitespace-nowrap text-[11px] font-semibold', state === 'todo' ? 'text-muted-foreground' : 'text-foreground')}>{step.label}</span>
                <span className="hidden whitespace-nowrap text-[9.5px] text-muted-foreground sm:block">{step.desc}</span>
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {progress?.message || (status === 'pending' ? '排队等待执行…' : '处理中…')}
      </p>
    </div>
  )
}

function DetailView({ detail, error, canWrite, onBack, onRerun, onDelete }: {
  detail: TopicAnalysis | null; error: string; canWrite: boolean
  onBack: () => void; onRerun: () => void; onDelete: () => void
}) {
  if (!detail) {
    return (
      <div className="animate-in fade-in space-y-4 duration-300">
        <BackBar onBack={onBack} />
        {error
          ? <div className="rounded-xl border border-status-red/30 bg-status-red/[0.06] p-4 text-sm text-status-red">{error}</div>
          : <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
      </div>
    )
  }

  const keywords = Array.isArray(detail.keywords) ? detail.keywords : []
  const running = detail.status === 'pending' || detail.status === 'running'
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <BackBar onBack={onBack} />

      <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone={STATUS_TONE[detail.status] || 'neutral'}>
            {running && <Loader2 className="mr-0.5 h-2.5 w-2.5 animate-spin" />}
            {STATUS_LABEL[detail.status] || detail.status}
          </StatusBadge>
          {detail.status === 'done' && detail.analysis_source && (
            <StatusPill tone={SOURCE_TONE[detail.analysis_source] || 'muted'}>{SOURCE_LABEL[detail.analysis_source] || detail.analysis_source}</StatusPill>
          )}
        </div>
        <h2 className="mt-2 text-[17px] font-bold leading-snug">{detail.title || '(未命名剖析)'}</h2>
        <div className="mt-2 flex flex-wrap gap-1">
          {keywords.map(k => <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">{k}</span>)}
          {!keywords.length && <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">全量内容</span>}
        </div>
        <div className="mt-2.5 text-[11px] text-muted-foreground">
          时间范围 {fmtDay(detail.period_start)} ~ {fmtDay(detail.period_end)}
          {detail.created_by && ` · 发起人 ${detail.created_by}`}
          {' · '}{formatFullDate(detail.created_at)}
        </div>
      </div>

      {running && <ProgressSteps progress={detail.progress} status={detail.status} />}

      {detail.status === 'failed' && (
        <div className="rounded-xl border border-status-red/30 bg-status-red/[0.06] p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-status-red"><AlertTriangle className="h-4 w-4" />剖析失败</div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{detail.error || '未知错误,请重试'}</p>
          {canWrite && (
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" onClick={onRerun}><RotateCcw className="h-3.5 w-3.5" />重新发起</Button>
              <Button size="sm" variant="ghost" className="text-status-red" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" />删除记录</Button>
            </div>
          )}
        </div>
      )}

      {detail.status === 'done' && (
        detail.payload
          ? <ResultBlocks payload={detail.payload} analysisSource={detail.analysis_source} />
          : <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">剖析已完成但结果为空,请重跑一次。</div>
      )}
    </div>
  )
}

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack}
      className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground">
      <ArrowLeft className="h-4 w-4" />返回剖析列表
    </button>
  )
}

function Section({ icon: Icon, iconTone, title, source, extra, children }: {
  icon: React.ElementType; iconTone: string; title: string
  source?: string; extra?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-3.5 flex flex-wrap items-center gap-1.5">
        <Icon className={cn('h-4 w-4', iconTone)} />
        <h3 className="text-[14px] font-bold">{title}</h3>
        {extra}
        <SourceTag source={source} />
      </div>
      {children}
    </section>
  )
}

function SourceTag({ source }: { source?: string }) {
  const ai = source === 'llm'
  return (
    <span className={cn('ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide',
      ai ? 'bg-status-purple/12 text-purple-600 dark:text-purple-400' : 'bg-muted text-muted-foreground')}>
      {ai ? 'AI 生成' : '规则统计'}
    </span>
  )
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{children}</h4>
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button type="button"
      onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }}
      className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary hover:underline">
      <Copy className="h-3 w-3" />{copied ? '已复制' : '复制'}
    </button>
  )
}

/** 证据回链:sampleIds → sampleMap(id→{title,url})。本版为外链打开原帖,页内抽屉下钻在 C5 接入。 */
function SampleLinks({ ids, sampleMap, className }: { ids?: string[]; sampleMap: any; className?: string }) {
  const links = (ids || []).map(id => ({ id, ...(sampleMap?.[id] || {}) })).filter((x: any) => x.url)
  if (!links.length) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {links.map((l: any) => (
        <a key={l.id} href={l.url} target="_blank" rel="noreferrer" title={l.title || ''}
          className="inline-flex max-w-[220px] items-center gap-1 text-[10.5px] font-medium text-primary hover:underline">
          <ExternalLink className="h-3 w-3 shrink-0" /><span className="truncate">{l.title || '打开原帖'}</span>
        </a>
      ))}
    </div>
  )
}

const TONE_META: Record<string, { label: string; bar: string }> = {
  positive: { label: '正面', bar: 'bg-status-green' },
  neutral: { label: '中性', bar: 'bg-slate-300 dark:bg-slate-600' },
  negative: { label: '负面', bar: 'bg-status-red' },
}

function EmotionBar({ tones }: { tones: any[] }) {
  const total = tones.reduce((acc, t) => acc + Number(t.count || 0), 0)
  if (!total) return <p className="text-xs text-muted-foreground">周期内暂无已标注情感的内容。</p>
  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
        {tones.map(t => Number(t.count) > 0 && (
          <div key={t.tone} className={TONE_META[t.tone]?.bar || 'bg-muted'} style={{ width: `${(Number(t.count) / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {tones.map(t => (
          <span key={t.tone} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn('h-2 w-2 rounded-full', TONE_META[t.tone]?.bar || 'bg-muted')} />
            {TONE_META[t.tone]?.label || t.tone} {formatNumber(t.count)} 条({t.share}%)
          </span>
        ))}
      </div>
    </div>
  )
}

function TrendBars({ trend }: { trend: any[] }) {
  const max = Math.max(...trend.map(t => Number(t.total) || 0), 1)
  return (
    <div className="mt-3.5">
      <SubHeading>扩散节奏</SubHeading>
      <div className="flex h-20 items-end gap-[3px]">
        {trend.map((t, i) => {
          const h = Math.max(4, (Number(t.total) / max) * 100)
          const negRatio = Number(t.total) > 0 ? Number(t.negative) / Number(t.total) : 0
          return (
            <div key={i} title={`${t.label}:${t.total} 条(负面 ${t.negative})`}
              className="relative flex-1 rounded-t bg-status-blue/25" style={{ height: `${h}%` }}>
              {negRatio > 0 && <div className="absolute inset-x-0 bottom-0 rounded-t bg-status-red/70" style={{ height: `${negRatio * 100}%` }} />}
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-[9.5px] text-muted-foreground">
        <span>{trend[0]?.label}</span>
        <span>{trend[trend.length - 1]?.label}</span>
      </div>
    </div>
  )
}

function ResultBlocks({ payload, analysisSource }: { payload: any; analysisSource: string | null }) {
  const meta = payload.meta || {}
  const metrics = payload.ruleMetrics || {}
  const risk = payload.riskAssessment || {}
  const opinion = payload.opinionBreakdown || {}
  const spread = payload.spreadNarrative || {}
  const strategy = payload.responseStrategy || {}
  const draft = strategy.responseDraft || {}
  const sampleMap = payload.sampleMap || {}
  const platformMax = Math.max(...(spread.platforms || []).map((p: any) => Number(p.count) || 0), 1)

  return (
    <div className="space-y-4">
      {meta.insufficientSamples && (
        <div className="flex items-start gap-2.5 rounded-xl border border-status-orange/30 bg-status-orange/[0.08] p-3.5 text-[12.5px] leading-relaxed">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>圈定范围内有效样本不足 3 条,本次结果为纯规则统计、未经 AI 研判。建议放宽关键词或时间范围后重新发起。</span>
        </div>
      )}

      {/* 块1 风险研判与趋势 */}
      <Section icon={ShieldAlert} iconTone="text-status-red" title="风险研判与趋势" source={risk.source}>
        <div className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg px-4 py-3', RISK_BAR[risk.riskLevel] || RISK_BAR.watch)}>
          <span className="text-[17px] font-black">{risk.riskLevelLabel || RISK_TEXT[risk.riskLevel] || risk.riskLevel}</span>
          {risk.ruleRiskLevel && risk.ruleRiskLevel !== risk.riskLevel && (
            <span className="text-[10.5px] font-medium opacity-85">规则对照:{RISK_TEXT[risk.ruleRiskLevel] || risk.ruleRiskLevel}(AI 与规则定级不一致,以 AI 为准)</span>
          )}
        </div>
        {risk.riskSummary && <p className="mt-3 text-[13px] leading-relaxed">{risk.riskSummary}</p>}
        {risk.trendJudgment && (
          <p className="mt-2 flex items-start gap-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
            <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0" />{risk.trendJudgment}
          </p>
        )}
        {(risk.keyDrivers || []).length > 0 && (
          <div className="mt-3.5">
            <SubHeading>风险驱动因素</SubHeading>
            <div className="space-y-2">
              {(risk.keyDrivers || []).map((d: any, i: number) => (
                <div key={i} className="rounded-lg border border-border p-3">
                  <div className="text-[13px] font-semibold leading-snug">{d.driver}</div>
                  {d.evidence && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{d.evidence}</p>}
                  <SampleLinks ids={d.sampleIds} sampleMap={sampleMap} className="mt-1.5" />
                </div>
              ))}
            </div>
          </div>
        )}
        {(risk.watchPoints || []).length > 0 && (
          <div className="mt-3.5">
            <SubHeading>盯防要点</SubHeading>
            <ul className="space-y-1.5">
              {(risk.watchPoints || []).map((w: string, i: number) => (
                <li key={i} className="flex items-start gap-2 text-[12.5px] leading-relaxed">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-status-orange" />{w}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* 块2 观点与情绪拆解 */}
      <Section icon={MessageSquare} iconTone="text-status-purple" title="观点与情绪拆解" source={opinion.source}>
        <SubHeading>情绪构成(真实计数)</SubHeading>
        <EmotionBar tones={opinion.emotionTones || []} />
        <div className="mt-3.5">
          <SubHeading>观点聚类</SubHeading>
          {(opinion.viewpointClusters || []).length > 0 ? (
            <div className="space-y-2">
              {(opinion.viewpointClusters || []).map((c: any, i: number) => (
                <div key={i} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge tone={STANCE_TONE[c.stance] || 'neutral'}>{STANCE_LABEL[c.stance] || c.stance}</StatusBadge>
                    {Number(c.share) > 0 && <span className="text-[11px] font-bold tabular-nums text-muted-foreground">占比 {c.share}%</span>}
                    <span className="text-[13px] font-semibold leading-snug">{c.viewpoint}</span>
                  </div>
                  {c.summary && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{c.summary}</p>}
                  <SampleLinks ids={c.sampleIds} sampleMap={sampleMap} className="mt-1.5" />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">暂无可聚类的观点。</p>
          )}
        </div>
        {(opinion.representativeVoices || []).length > 0 && (
          <div className="mt-3.5">
            <SubHeading>代表言论(真实评论)</SubHeading>
            <div className="space-y-2">
              {(opinion.representativeVoices || []).map((v: any, i: number) => (
                <div key={i} className="rounded-lg bg-muted/50 p-3">
                  <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed">
                    <Quote className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />{v.content}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-[18px] text-[10.5px] text-muted-foreground">
                    {Number(v.likeCount) > 0 && <span>赞 {formatNumber(v.likeCount)}</span>}
                    {v.recordTitle && <span className="max-w-[240px] truncate">来自:{v.recordTitle}</span>}
                    {sampleMap[v.recordId]?.url && (
                      <a href={sampleMap[v.recordId].url} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
                        <ExternalLink className="h-3 w-3" />打开原帖
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* 块3 传播分析(platforms/trend/keyNodes 数据永远来自规则统计,LLM 只写叙事) */}
      <Section icon={Radar} iconTone="text-status-blue" title="传播分析" source={spread.source}
        extra={Number(metrics.lowFansHighSpreadCount) > 0 && (
          <span className="rounded bg-status-red/12 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 dark:text-rose-300">低粉高扩散 {metrics.lowFansHighSpreadCount} 条</span>
        )}>
        {spread.summary && <p className="text-[13px] leading-relaxed">{spread.summary}</p>}
        {(spread.platforms || []).length > 0 && (
          <div className="mt-3.5">
            <SubHeading>平台分布</SubHeading>
            <div className="space-y-1.5">
              {(spread.platforms || []).map((p: any) => (
                <div key={p.platform} className="flex items-center gap-2.5">
                  <span className="w-14 shrink-0 text-[11.5px] font-medium">{p.label}</span>
                  <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                    <div className="h-full rounded bg-status-blue/70" style={{ width: `${(Number(p.count) / platformMax) * 100}%` }} />
                  </div>
                  <span className="w-28 shrink-0 text-right text-[10.5px] tabular-nums text-muted-foreground">{formatNumber(p.count)} 条 · 负面 {formatNumber(p.negativeCount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {(spread.trend || []).length > 0 && <TrendBars trend={spread.trend} />}
        {(spread.keyNodes || []).length > 0 && (
          <div className="mt-3.5">
            <SubHeading>关键扩散节点(互动增长最快)</SubHeading>
            <div className="space-y-1.5">
              {(spread.keyNodes || []).map((n: any, i: number) => (
                <div key={i} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                  <StatusBadge tone={n.sentiment || 'neutral'}>{LABELS.sentiment[n.sentiment || ''] || '待标注'}</StatusBadge>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{n.title || '(无标题)'}</span>
                  <span className={cn('shrink-0 text-[11px] font-bold tabular-nums', n.sentiment === 'negative' ? 'text-status-red' : 'text-muted-foreground')}>+{formatNumber(n.interactionGrowth)}</span>
                  {sampleMap[n.recordId]?.url && (
                    <a href={sampleMap[n.recordId].url} target="_blank" rel="noreferrer" aria-label="打开原帖" className="shrink-0 text-primary hover:opacity-75">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* 块4 应对建议与回应口径 */}
      <Section icon={ClipboardList} iconTone="text-status-green" title="应对建议与回应口径" source={strategy.source}>
        {(strategy.actions || []).length > 0 && (
          <div>
            <SubHeading>处置清单</SubHeading>
            <div className="space-y-1.5">
              {(strategy.actions || []).map((a: string, i: number) => (
                <div key={i} className="flex items-start gap-2.5 rounded-lg bg-muted/50 px-3 py-2 text-[12.5px] leading-relaxed">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-status-green/15 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">{i + 1}</span>
                  {a}
                </div>
              ))}
            </div>
          </div>
        )}
        {draft.statement ? (
          <div className="mt-3.5 rounded-lg border-2 border-status-green/25 bg-status-green/[0.04] p-3.5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">对外统一口径</span>
              <CopyButton text={draft.statement} />
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{draft.statement}</p>
          </div>
        ) : (
          <p className="mt-3.5 rounded-lg border border-dashed border-border p-3 text-xs leading-relaxed text-muted-foreground">本次未生成对外话术:规则兜底不产出客户可见话术,待 AI 服务可用后重跑即可补齐。</p>
        )}
        {(draft.qa || []).length > 0 && (
          <div className="mt-3.5">
            <SubHeading>高频追问 Q&amp;A</SubHeading>
            <div className="space-y-2">
              {(draft.qa || []).map((item: any, i: number) => (
                <div key={i} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[12.5px] font-semibold leading-snug">Q:{item.q}</span>
                    <CopyButton text={`Q:${item.q}\nA:${item.a}`} />
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">A:{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        )}
        {(draft.channelNotes || []).length > 0 && (
          <div className="mt-3.5">
            <SubHeading>分渠道注意事项</SubHeading>
            <ul className="space-y-1.5">
              {(draft.channelNotes || []).map((note: string, i: number) => (
                <li key={i} className="flex items-start gap-2 text-[12.5px] leading-relaxed">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-status-teal" />{note}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(strategy.contentIdeas || []).length > 0 && (
          <div className="mt-3.5">
            <SubHeading>承接性内容选题</SubHeading>
            <div className="grid gap-2 sm:grid-cols-2">
              {(strategy.contentIdeas || []).map((idea: any, i: number) => (
                <div key={i} className="rounded-lg border border-border p-3">
                  <div className="flex items-start gap-1.5">
                    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-purple" />
                    <span className="text-[12.5px] font-semibold leading-snug">{idea.title}</span>
                  </div>
                  {idea.angle && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{idea.angle}</p>}
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] text-muted-foreground">可到「内容创意 · 选题与扩词」继续扩写这些方向。</p>
          </div>
        )}
      </Section>

      <div className="pb-2 text-center text-[10.5px] text-muted-foreground">
        生成于 {formatFullDate(meta.generatedAt)} · 样本 {formatNumber(meta.sampleCount || 0)} 条
        {analysisSource && ` · ${SOURCE_LABEL[analysisSource] || analysisSource}`}
      </div>
    </div>
  )
}
