import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronRight, Loader2, MessageCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import { api } from '@/lib/api'
import { useNav } from '@/lib/navigation'
import { formatDate, formatNumber, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge, StatusDot } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchTableShell } from '@/components/shared/Workbench'

type PatrolPost = {
  id: string
  title?: string
  content?: string
  url?: string
  publishTime?: string
  publishedAt?: string
  commentsCount?: number
  comments_count?: number
  commentsSampled?: number
  commentsCaptured?: number
  riskCommentCount?: number
  negativeComments?: number
  lastPatrolAt?: string
  lastPatrolledAt?: string
  patrolStatus?: string
  status?: string
}

type PatrolAccount = {
  id: string
  accountName?: string
  name?: string
  platform: string
  profileUrl?: string
  recentPosts?: PatrolPost[]
  posts?: PatrolPost[]
  recentPostCount?: number
  lastPatrolAt?: string
  lastPatrolledAt?: string
  lastPatrolStatus?: string
  patrolStatus?: string
  riskCommentCount?: number
  negativeComments?: number
}

type AccountResponse = {
  accounts?: PatrolAccount[]
  items?: PatrolAccount[]
  data?: { accounts?: PatrolAccount[]; items?: PatrolAccount[] }
}

function safeNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

function accountName(account: PatrolAccount) {
  return account.accountName || account.name || '未命名官方账号'
}

function postsOf(account: PatrolAccount) {
  return account.recentPosts || account.posts || []
}

function postPublishTime(post: PatrolPost) {
  return post.publishedAt || post.publishTime || ''
}

function lastPatrol(account: PatrolAccount) {
  return account.lastPatrolAt || account.lastPatrolledAt || ''
}

function riskCount(account: PatrolAccount) {
  return safeNumber(account.riskCommentCount ?? account.negativeComments)
}

function postRiskCount(post: PatrolPost) {
  return safeNumber(post.riskCommentCount ?? post.negativeComments)
}

function sampledCount(post: PatrolPost) {
  return safeNumber(post.commentsSampled ?? post.commentsCaptured)
}

function patrolStatusLabel(status?: string) {
  const normalized = String(status || '').toLowerCase()
  if (['completed', 'succeeded', 'success'].includes(normalized)) return { label: '已巡查', tone: 'active' as const }
  if (normalized === 'completed_with_warnings') return { label: '部分完成', tone: 'negative' as const }
  if (normalized === 'sampled') return { label: '已有样本', tone: 'active' as const }
  if (['failed', 'needs_action', 'attention', 'retryable'].includes(normalized)) return { label: '需处理', tone: 'negative' as const }
  if (['claimed', 'running', 'recovering', 'resume_requested'].includes(normalized)) return { label: '巡查中', tone: 'neutral' as const }
  if (['pending', 'assigned', 'dispatch_pending', 'dispatched', 'waiting_device', 'queued'].includes(normalized)) return { label: '待执行', tone: 'neutral' as const }
  if (normalized === 'canceled') return { label: '已取消', tone: 'muted' as const }
  if (normalized === 'skipped') return { label: '已跳过', tone: 'muted' as const }
  return { label: '未巡查', tone: 'muted' as const }
}

function postPatrolStatus(post: PatrolPost) {
  const explicitStatus = String(post.patrolStatus || post.status || '').trim()
  if (!explicitStatus && sampledCount(post) > 0) return { label: '已有样本', tone: 'active' as const }
  return patrolStatusLabel(explicitStatus)
}

export function OfficialCommentPatrolTab() {
  const { navigate } = useNav()
  const [accounts, setAccounts] = useState<PatrolAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.get<AccountResponse>('/capture-cloud/official-comment-patrol/accounts?range=7d')
      const rows = result.accounts || result.items || result.data?.accounts || result.data?.items || []
      setAccounts(rows.filter(row => row && typeof row.id === 'string'))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '读取官方账号巡查数据失败')
      setAccounts([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    return () => { active = false }
  }, [load])

  const totals = useMemo(() => ({
    accounts: accounts.length,
    posts: accounts.reduce((total, account) => total + Math.max(postsOf(account).length, safeNumber(account.recentPostCount)), 0),
    risk: accounts.reduce((total, account) => total + riskCount(account), 0),
  }), [accounts])

  const createTask = () => navigate('dispatch', { create: 'comment_patrol' })

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <section className="rounded-2xl border border-border/70 bg-card px-4 py-4 shadow-xs sm:px-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><MessageCircle className="h-4 w-4 text-primary" /><h2 className="text-base font-bold">官方账号评论巡查</h2></div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">查看已发现的近期作品和最近一次巡查结果；任务创建、分配与重试统一在调度中心完成。</p>
          </div>
          <Button size="sm" className="min-h-10 shrink-0" onClick={createTask}><MessageCircle className="h-4 w-4" />创建评论巡查</Button>
        </div>
        <div className="mt-4 grid grid-cols-3 divide-x divide-border/70 border-t border-border/60 pt-3">
          <MiniStat label="官方账号" value={loading ? '—' : formatNumber(totals.accounts)} />
          <MiniStat label="近 7 天作品" value={loading ? '—' : formatNumber(totals.posts)} />
          <MiniStat label="风险评论" value={loading ? '—' : formatNumber(totals.risk)} tone={totals.risk > 0 ? 'text-status-red' : undefined} />
        </div>
      </section>

      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-xs text-status-red"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => void load()}>重试</Button></div>}

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : accounts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card">
          <EmptyState icon={ShieldCheck} title="暂无可巡查官方账号" description="先在官方账号管理登记账号，并完成账号作品发现；带发布时间和原帖链接的近期作品才会进入巡查范围。" />
          <div className="flex justify-center border-t border-border/70 px-4 py-4"><Button size="sm" onClick={createTask}>前往调度中心创建任务</Button></div>
        </div>
      ) : (
        <div className="space-y-3">
          {accounts.map(account => {
            const posts = postsOf(account)
            const accountStatus = patrolStatusLabel(account.lastPatrolStatus || account.patrolStatus)
            const accountRisk = riskCount(account)
            return (
              <section key={account.id} className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs">
                <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><StatusBadge tone="neutral">{platformName(account.platform)}</StatusBadge><StatusBadge tone={accountStatus.tone}>{accountStatus.label}</StatusBadge>{accountRisk > 0 && <StatusBadge tone="negative">风险评论 {formatNumber(accountRisk)}</StatusBadge>}</div>
                    <h3 className="mt-2 text-[15px] font-bold text-foreground">{accountName(account)}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">最近巡查 {formatDate(lastPatrol(account)) || '—'} · 近 7 天可巡查作品 {formatNumber(Math.max(posts.length, safeNumber(account.recentPostCount)))}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={createTask} className="shrink-0">创建任务 <ChevronRight className="h-3.5 w-3.5" /></Button>
                </div>

                {posts.length === 0 ? (
                  <div className="flex items-start gap-3 px-4 py-5 text-xs leading-5 text-muted-foreground sm:px-5"><CalendarDays className="mt-0.5 h-4 w-4 shrink-0" /><span>近 7 天没有已发现且带发布时间的作品。账号发现完成后，会自动在这里显示为可巡查对象。</span></div>
                ) : (
                  <>
                    <div className="space-y-0 lg:hidden">
                      {posts.slice(0, 6).map(post => <PostMobileRow key={post.id} post={post} />)}
                    </div>
                    <div className="hidden lg:block"><WorkbenchTableShell><table className="w-full min-w-[760px] text-sm"><thead><tr className="border-b border-border/60 [&>th]:px-3 [&>th]:py-2.5 [&>th]:text-left [&>th]:text-[11px] [&>th]:font-medium [&>th]:text-muted-foreground"><th>作品</th><th>发布时间</th><th>评论摘要</th><th>最近巡查</th><th>状态</th></tr></thead><tbody className="divide-y divide-border/40">{posts.slice(0, 20).map(post => <PostTableRow key={post.id} post={post} />)}</tbody></table></WorkbenchTableShell></div>
                    {posts.length > 6 && <div className="border-t border-border/70 px-4 py-3 text-xs text-muted-foreground sm:px-5">当前展示前 {posts.length > 20 ? 20 : posts.length} 篇；创建任务时可预览并选择完整候选范围。</div>}
                  </>
                )}
              </section>
            )
          })}
        </div>
      )}
      {!loading && accounts.length > 0 && <div className="flex justify-end"><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />刷新资产状态</Button></div>}
    </div>
  )
}

function MiniStat({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div className="px-3 first:pl-0 last:pr-0"><div className={`text-lg font-bold leading-none tabular-nums ${tone}`}>{value}</div><div className="mt-1.5 text-[10px] font-medium text-muted-foreground">{label}</div></div>
}

function PostMobileRow({ post }: { post: PatrolPost }) {
  const status = postPatrolStatus(post)
  return <article className="border-b border-border/60 px-4 py-3.5 last:border-b-0"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="line-clamp-2 text-sm font-semibold leading-5 text-foreground">{post.title || post.content || '未命名作品'}</h4><p className="mt-1 text-[11px] text-muted-foreground">发布 {formatDate(postPublishTime(post)) || '—'}</p></div><StatusBadge tone={status.tone}>{status.label}</StatusBadge></div><p className="mt-2 text-xs text-muted-foreground">平台评论 {formatNumber(safeNumber(post.commentsCount ?? post.comments_count))} · 已入库样本 {formatNumber(sampledCount(post))}{postRiskCount(post) > 0 ? ` · 风险 ${formatNumber(postRiskCount(post))}` : ''}</p><p className="mt-1 text-[11px] text-muted-foreground">最近巡查 {formatDate(post.lastPatrolAt || post.lastPatrolledAt) || '—'}</p></article>
}

function PostTableRow({ post }: { post: PatrolPost }) {
  const status = postPatrolStatus(post)
  return <tr className="align-top transition-colors hover:bg-accent/45"><td className="max-w-[360px] px-4 py-3"><div className="line-clamp-2 font-medium leading-5">{post.title || post.content || '未命名作品'}</div>{post.url && <a href={post.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-primary hover:underline">打开原文 ↗</a>}</td><td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(postPublishTime(post)) || '—'}</td><td className="px-4 py-3 text-xs text-muted-foreground">平台 {formatNumber(safeNumber(post.commentsCount ?? post.comments_count))} · 已入库样本 {formatNumber(sampledCount(post))}{postRiskCount(post) > 0 ? <div className="mt-1 text-status-red">风险 {formatNumber(postRiskCount(post))}</div> : null}</td><td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(post.lastPatrolAt || post.lastPatrolledAt) || '—'}</td><td className="px-4 py-3"><StatusDot tone={status.tone}>{status.label}</StatusDot></td></tr>
}
