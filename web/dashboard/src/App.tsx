import { useState, useEffect, useCallback } from 'react'
import {
  Moon, Sun, LogOut, Search, ChevronLeft, ChevronRight,
  TrendingUp, AlertTriangle, Database, Tag, BarChart3,
  Loader2, Inbox, ExternalLink,
} from 'lucide-react'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

function cn(...inputs: any[]) { return twMerge(clsx(inputs)) }

const SL: Record<string, string> = { positive: '正面', neutral: '中性', negative: '负面' }
const PL: Record<string, string> = { xiaohongshu: '小红书', douyin: '抖音', weibo: '微博' }
const CL: Record<string, string> = {
  safety_rescue: '安全救援', feature_usage: '功能使用', renewal_billing: '续费收费',
  privacy: '隐私安全', app_issue: 'App问题', service_quality: '服务质量', brand_image: '品牌形象', other: '其他',
}

const TONE: Record<string, string> = {
  positive: 'bg-emerald-500/10 text-emerald-600',
  negative: 'bg-red-500/10 text-red-600',
  neutral: 'bg-blue-500/10 text-blue-600',
}

function Badge({ tone, children }: { tone?: string; children: React.ReactNode }) {
  const cls = (tone && TONE[tone]) || 'bg-muted text-muted-foreground'
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold', cls)}>{children}</span>
}

/* ---- API ---- */
let authCode = ''

async function api<T = any>(path: string, opts: any = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-auth-code': authCode, ...opts.headers }
  const resp = await fetch('/api/user' + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
  return resp.json()
}

/* ---- Theme Toggle ---- */
function ThemeToggle() {
  useEffect(() => {
    const s = localStorage.getItem('osv_theme')
    if (s === 'dark' || (!s && matchMedia('(prefers-color-scheme:dark)').matches)) document.documentElement.classList.add('dark')
  }, [])
  return (
    <button onClick={() => {
      const d = document.documentElement.classList.toggle('dark')
      localStorage.setItem('osv_theme', d ? 'dark' : 'light')
    }} className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card transition hover:bg-accent" title="切换主题">
      <Sun className="h-4 w-4 rotate-0 scale-100 transition dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition dark:rotate-0 dark:scale-100" />
    </button>
  )
}

/* ==================== Login ==================== */
function LoginView({ onLogin }: { onLogin: (owner: string) => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    if (!code.trim()) return
    setError(''); setLoading(true)
    authCode = code.trim()
    try {
      const data = await api<any>('/login', { method: 'POST', body: { code: code.trim() } })
      if (data.ok) {
        localStorage.setItem('osv_user_code', code.trim())
        onLogin(data.owner || code.trim().slice(0, 8))
      } else {
        setError(data.message || '激活码无效')
      }
    } catch (e: any) { setError('连接失败: ' + e.message) }
    finally { setLoading(false) }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-6">
      <div className="pointer-events-none absolute -left-32 -top-32 h-[500px] w-[500px] animate-pulse rounded-full bg-primary/20 blur-[100px]" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-[400px] w-[400px] animate-pulse rounded-full bg-cyan-500/15 blur-[100px]" style={{ animationDelay: '2s' }} />
      <div className="relative z-10 w-full max-w-md space-y-6 rounded-2xl border border-border/50 bg-card/80 p-10 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-col items-center">
          <img src="/images/logo-starvoice.svg" alt="" className="mb-5 h-14 w-14 drop-shadow-lg" />
          <h1 className="bg-gradient-to-r from-primary to-cyan-500 bg-clip-text text-2xl font-extrabold text-transparent">StarVoice 星语</h1>
          <p className="mt-1 text-sm text-muted-foreground">数据中心</p>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-semibold text-muted-foreground">激活码</label>
          <input value={code} onChange={e => setCode(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} autoFocus
            placeholder="请输入您的激活码" className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <button onClick={submit} disabled={loading}
          className="flex h-10 w-full items-center justify-center rounded-lg bg-primary text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50">
          {loading ? '验证中…' : '登录'}
        </button>
        {error && <p className="text-center text-sm font-medium text-destructive">{error}</p>}
      </div>
    </div>
  )
}

/* ==================== Main Dashboard ==================== */
function DashboardView({ owner }: { owner: string }) {
  const [stats, setStats] = useState<any>(null)
  const [records, setRecords] = useState<any[]>([])
  const [pagination, setPagination] = useState<any>(null)
  const [platform, setPlatform] = useState('')
  const [sentiment, setSentiment] = useState('')
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<any>('/stats?days=7').then(setStats).catch(console.error)
  }, [])

  const loadRecords = useCallback(async (page = 1) => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), pageSize: '30', platform, sentiment, keyword })
    const data = await api<any>('/records?' + params)
    setRecords(data.records || [])
    setPagination(data.pagination || null)
    setLoading(false)
  }, [platform, sentiment, keyword])

  useEffect(() => { loadRecords() }, [loadRecords])

  const fmt = (v: any) => { const n = Number(v); return isNaN(n) ? '0' : n >= 10000 ? (n / 10000).toFixed(1) + '万' : n.toLocaleString() }

  const KPI = [
    { label: '总记录', value: stats?.total, icon: Database },
    { label: '本周新增', value: stats?.periodNew, icon: TrendingUp },
    { label: '负面内容', value: stats?.negative, icon: AlertTriangle, tone: 'destructive' as const },
    { label: '待标注', value: stats?.pendingLabel, icon: Tag },
    { label: '监控中', value: stats?.monitoring, icon: BarChart3 },
  ]

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border bg-card/80 backdrop-blur-lg">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <img src="/images/logo-starvoice.svg" alt="" className="h-8 w-8" />
            <div>
              <div className="text-sm font-bold">StarVoice 星语</div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">数据中心</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{owner}</span>
            <ThemeToggle />
            <button onClick={() => { localStorage.removeItem('osv_user_code'); location.reload() }} className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium transition hover:bg-accent">
              <LogOut className="h-4 w-4" /> 退出
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 p-6">
        {/* KPIs */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          {KPI.map(k => (
            <div key={k.label} className="group relative overflow-hidden rounded-xl border border-border bg-card p-5 transition-all hover:-translate-y-0.5 hover:shadow-lg">
              <div className="flex items-start gap-3">
                <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', k.tone === 'destructive' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary')}>
                  <k.icon className="h-5 w-5" strokeWidth={1.8} />
                </div>
                <div>
                  <div className={cn('text-2xl font-extrabold tabular-nums', k.tone === 'destructive' && 'text-destructive')}>{fmt(k.value)}</div>
                  <div className="text-xs font-semibold text-muted-foreground">{k.label}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <select value={platform} onChange={e => setPlatform(e.target.value)} className="h-9 rounded-lg border border-input bg-card px-3 text-sm">
            <option value="">全部平台</option>
            <option value="xiaohongshu">小红书</option><option value="douyin">抖音</option><option value="weibo">微博</option>
          </select>
          <select value={sentiment} onChange={e => setSentiment(e.target.value)} className="h-9 rounded-lg border border-input bg-card px-3 text-sm">
            <option value="">全部情感</option>
            <option value="negative">负面</option><option value="neutral">中性</option><option value="positive">正面</option>
          </select>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={keyword} onChange={e => setKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadRecords()}
              placeholder="搜索标题、内容…" className="h-9 w-64 rounded-lg border border-input bg-card pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : records.length === 0 ? (
          <div className="flex flex-col items-center py-16"><Inbox className="mb-3 h-12 w-12 text-muted-foreground/40" /><div className="text-sm font-semibold text-muted-foreground">暂无数据</div></div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border bg-muted/50">
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">内容</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">作者</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">AI分析</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">互动</th>
                  <th className="px-4 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground">链接</th>
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {records.map((r: any) => (
                    <tr key={r.id} className="cursor-pointer transition hover:bg-muted/30" onClick={() => setSelected(r)}>
                      <td className="max-w-sm px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Badge tone="neutral">{PL[r.platform] || r.platform}</Badge>
                          <span className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleDateString('zh-CN')}</span>
                        </div>
                        <div className="mt-1 truncate font-medium">{r.title || '(无标题)'}</div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">{r.author_name || '-'}</td>
                      <td className="px-4 py-3">
                        <Badge tone={r.sentiment}>{SL[r.sentiment] || '待标注'}</Badge>
                        {r.category && <div className="mt-1"><Badge>{CL[r.category] || r.category}</Badge></div>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums">{fmt(r.likes)}/{fmt(r.comments_count)}/{fmt(r.collects)}</td>
                      <td className="px-4 py-3 text-right">
                        {r.url && <a href={r.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" />原文</a>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-3">
                <span className="text-xs text-muted-foreground">共 {fmt(pagination.total)} 条</span>
                <div className="flex items-center gap-1">
                  <button disabled={pagination.page <= 1} onClick={() => loadRecords(pagination.page - 1)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card transition hover:bg-accent disabled:opacity-50"><ChevronLeft className="h-4 w-4" /></button>
                  <span className="px-3 text-sm tabular-nums text-muted-foreground">{pagination.page} / {pagination.totalPages}</span>
                  <button disabled={pagination.page >= pagination.totalPages} onClick={() => loadRecords(pagination.page + 1)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card transition hover:bg-accent disabled:opacity-50"><ChevronRight className="h-4 w-4" /></button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Detail modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setSelected(null)}>
          <div className="mx-4 max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">{selected.title || '(无标题)'}</h2>
              <button onClick={() => setSelected(null)} className="rounded-lg p-1 hover:bg-accent">&times;</button>
            </div>
            <div className="mb-3 flex flex-wrap gap-2">
              <Badge tone="neutral">{PL[selected.platform] || selected.platform}</Badge>
              <Badge tone={selected.sentiment}>{SL[selected.sentiment] || '待标注'}</Badge>
              {selected.category && <Badge>{CL[selected.category] || selected.category}</Badge>}
            </div>
            <p className="mb-4 whitespace-pre-wrap text-sm leading-relaxed">{selected.content || selected.ai_summary || '无内容'}</p>
            <div className="text-xs text-muted-foreground">
              {selected.author_name && <span>作者: {selected.author_name} · </span>}
              {selected.url && <a href={selected.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">查看原文</a>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ==================== App ==================== */
export default function App() {
  const [owner, setOwner] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const saved = localStorage.getItem('osv_user_code')
    if (saved) {
      authCode = saved
      api<any>('/login', { method: 'POST', body: { code: saved } })
        .then(d => { if (d.ok) setOwner(d.owner || saved.slice(0, 8)); })
        .finally(() => setChecking(false))
    } else {
      setChecking(false)
    }
  }, [])

  if (checking) return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
  if (!owner) return <LoginView onLogin={setOwner} />
  return <DashboardView owner={owner} />
}
