import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Heart,
  Loader2,
  MessageCircle,
  Minus,
  Music2,
  Search,
  Share2,
  ShieldAlert,
  ThumbsUp,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useNav } from '@/lib/navigation'
import { cn, formatNumber, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusPill } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { RecordSourceAction } from '@/components/shared/RecordSourceAction'

type Sentiment = {
  total: number
  positive: number
  neutral: number
  negative: number
  unknown: number
  negativeRate: number
}

type PatrolPost = {
  id: string
  title: string
  url: string
  platform: string
  externalId: string
  publishedAt?: string | null
  publishTime?: string
  officialAccount: {
    id: string
    name: string
    platform?: string
  }
  coverage: {
    platformComments: number
    sampledComments: number
    percent: number | null
    note?: string
  }
  engagement: {
    likes: number
    comments: number
    shares: number
    trend?: {
      likes: number
      comments: number
      shares: number
      capturedAt?: string | null
    } | null
  }
  sentiment: Sentiment
  previousSentiment?: Sentiment | null
  delta?: {
    comments: number
    negative: number
    positive: number
    negativeRate: number
  } | null
  riskTrend: 'rising' | 'stable' | 'falling' | 'baseline'
  todos: {
    negative: number
    positive: number
  }
  lastPatrolledAt?: string | null
  previousPatrolledAt?: string | null
  patrolStatus: string
}

type WorkbenchResponse = {
  ok: boolean
  sort: PostSort
  accounts: Array<{ id: string; name: string; platform: string }>
  comparison: {
    scope: string
    baselineOnly: boolean
    comparedPosts: number
    latestPatrolledAt?: string | null
    previousPatrolledAt?: string | null
    newComments: number
    newNegative: number
    negativeComments: number
    positiveComments: number
    negativePending: number
    positivePending: number
    riskRisingPosts: number
  }
  posts: PatrolPost[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
  message?: string
}

type CommentAction = {
  id: string
  action_type: string
  status: string
  note?: string
  actor_name?: string
  completed_at?: string | null
  created_at?: string
  updated_at?: string
}

type PatrolComment = {
  id: string
  authorName: string
  content: string
  likeCount: number
  publishedAt?: string | null
  ipLocation?: string
  sentiment: string
  isNegative: boolean
  riskLevel: string
  category?: string
  summary?: string
  firstSeenAt?: string | null
  lastSeenAt?: string | null
  isNewSincePrevious: boolean
  leadId?: string | null
  actions: CommentAction[]
}

type CommentBucket = 'negative' | 'positive' | 'all'

type PostCommentsResponse = {
  ok: boolean
  post: {
    id: string
    title: string
    url: string
    platform: string
    publishedAt?: string | null
    officialAccount: { id: string; name: string }
  }
  bucket: CommentBucket
  counts: {
    all: number
    negative: number
    positive: number
    negativePending: number
    positivePending: number
  }
  comparison: {
    latestPatrolledAt?: string | null
    previousPatrolledAt?: string | null
    baselineOnly: boolean
  }
  comments: PatrolComment[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

type PostSort = 'published_desc' | 'collected_desc'

type Filters = {
  platform: string
  officialAccountId: string
  sort: PostSort
}

const INITIAL_FILTERS: Filters = {
  platform: '',
  officialAccountId: '',
  sort: 'published_desc',
}

const PAGE_SIZE_OPTIONS = [20, 30, 50] as const

function getPaginationItems(
  currentPage: number,
  totalPages: number,
): Array<number | 'ellipsis'> {
  if (totalPages <= 7) {
    return Array.from({length: totalPages}, (_, index) => index + 1)
  }
  if (currentPage <= 4) return [1, 2, 3, 4, 5, 'ellipsis', totalPages]
  if (currentPage >= totalPages - 3) {
    return [
      1,
      'ellipsis',
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ]
  }
  return [
    1,
    'ellipsis',
    currentPage - 1,
    currentPage,
    currentPage + 1,
    'ellipsis',
    totalPages,
  ]
}

function isPreviewMode() {
  if (!import.meta.env.DEV) return false
  return new URLSearchParams(window.location.search).get('preview') === 'official-comment-ops'
}

function safeNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

function formatDateTime(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function formatPublish(value?: string | null, fallback = '') {
  const candidate = value || fallback
  if (!candidate) return '—'
  const date = new Date(candidate)
  if (Number.isNaN(date.getTime())) return fallback || String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function comparableDate(value?: string | null) {
  const timestamp = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : null
}

function compareDateDesc(
  leftValue?: string | null,
  rightValue?: string | null,
) {
  const left = comparableDate(leftValue)
  const right = comparableDate(rightValue)
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return right - left
}

function comparePosts(left: PatrolPost, right: PatrolPost, sort: PostSort) {
  const primary = sort === 'collected_desc'
    ? compareDateDesc(left.lastPatrolledAt, right.lastPatrolledAt)
    : compareDateDesc(left.publishedAt, right.publishedAt)
  if (primary !== 0) return primary
  const published = compareDateDesc(left.publishedAt, right.publishedAt)
  if (published !== 0) return published
  return left.id.localeCompare(right.id)
}

function PlatformIcon({platform}: {platform: string}) {
  const xiaohongshu = platform === 'xiaohongshu'
  const Icon = xiaohongshu ? BookOpen : Music2
  const label = platformName(platform)
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded',
        xiaohongshu
          ? 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300'
          : 'bg-slate-100 text-slate-950 dark:bg-slate-800 dark:text-white',
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
    </span>
  )
}

function clonePreview<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function OfficialCommentPatrolTab() {
  const { navigate, params } = useNav()
  const { canWrite } = useAuth()
  const previewMode = isPreviewMode()
  const [filters, setFilters] = useState<Filters>(() => ({
    ...INITIAL_FILTERS,
    platform: params?.platform || '',
    officialAccountId: params?.officialAccountId || '',
  }))
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [data, setData] = useState<WorkbenchResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedPostId, setSelectedPostId] = useState('')
  const [bucket, setBucket] = useState<CommentBucket>('negative')
  const [detail, setDetail] = useState<PostCommentsResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      let response: WorkbenchResponse
      if (previewMode) {
        const module = await import('./officialCommentPatrolPreview')
        response = clonePreview(module.previewWorkbench) as WorkbenchResponse
        const filteredPosts = response.posts.filter(post => {
          if (filters.platform && post.platform !== filters.platform) return false
          if (
            filters.officialAccountId &&
            post.officialAccount.id !== filters.officialAccountId
          ) return false
          if (
            search &&
            !`${post.title} ${post.officialAccount.name}`
              .toLowerCase()
              .includes(search.toLowerCase())
          ) return false
          return true
        })
        const sortedPosts = [...filteredPosts].sort(
          (left, right) => comparePosts(left, right, filters.sort),
        )
        const total = sortedPosts.length
        const totalPages = Math.max(1, Math.ceil(total / pageSize))
        const effectivePage = Math.min(page, totalPages)
        const offset = (effectivePage - 1) * pageSize
        response.sort = filters.sort
        response.posts = sortedPosts.slice(offset, offset + pageSize)
        response.pagination = {
          page: effectivePage,
          pageSize,
          total,
          totalPages,
        }
      } else {
        const params = new URLSearchParams({
          sort: filters.sort,
          page: String(page),
          pageSize: String(pageSize),
        })
        if (filters.platform) params.set('platform', filters.platform)
        if (filters.officialAccountId) {
          params.set('officialAccountId', filters.officialAccountId)
        }
        if (search) params.set('search', search)
        response = await api.get<WorkbenchResponse>(
          `/capture-cloud/official-comment-patrol/workbench?${params.toString()}`,
        )
      }
      setData(response)
      setSelectedPostId(current => {
        if (response.posts.some(post => post.id === current)) return current
        return response.posts[0]?.id || ''
      })
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : '读取评论巡查数据失败',
      )
      setData(null)
      setSelectedPostId('')
    } finally {
      setLoading(false)
    }
  }, [filters, page, pageSize, previewMode, search])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const loadDetail = useCallback(async () => {
    if (!selectedPostId) {
      setDetail(null)
      return
    }
    setDetail(null)
    setDetailLoading(true)
    setDetailError('')
    try {
      if (previewMode) {
        const module = await import('./officialCommentPatrolPreview')
        setDetail(
          clonePreview(
            module.previewPostComments(bucket, selectedPostId),
          ) as PostCommentsResponse,
        )
      } else {
        const response = await api.get<PostCommentsResponse>(
          `/capture-cloud/official-comment-patrol/posts/${selectedPostId}/comments?bucket=${bucket}&pageSize=20`,
        )
        setDetail(response)
      }
    } catch (requestError) {
      setDetailError(
        requestError instanceof Error
          ? requestError.message
          : '读取帖子评论失败',
      )
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }, [bucket, previewMode, selectedPostId])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDetail(), 0)
    return () => window.clearTimeout(timer)
  }, [loadDetail])

  const selectedPost = useMemo(
    () => data?.posts.find(post => post.id === selectedPostId) || null,
    [data?.posts, selectedPostId],
  )

  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters(current => ({...current, [key]: value}))
    setPage(1)
  }

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault()
    setSearch(searchDraft.trim())
    setPage(1)
  }

  const createTask = (officialAccountId = '') => {
    navigate('dispatch', {
      create: 'comment_patrol',
      ...(officialAccountId ? {officialAccountId} : {}),
    })
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-0 duration-300 xl:flex xl:h-full xl:flex-col">
      <section className="shrink-0 border-b border-border/70 py-4">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <form onSubmit={submitSearch} className="relative min-w-0 flex-1">
            <input
              aria-label="搜索帖子"
              value={searchDraft}
              onChange={event => setSearchDraft(event.target.value)}
              placeholder="搜索帖子标题或账号"
              className="h-9 w-full rounded-lg border border-input bg-card pl-3 pr-16 text-[12px] outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/15"
            />
            {searchDraft && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => {
                  setSearchDraft('')
                  setSearch('')
                }}
                className="absolute right-8 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              type="submit"
              aria-label="搜索"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Search className="h-3.5 w-3.5" />
            </button>
          </form>
          <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
            <div className="relative shrink-0">
              <select
                aria-label="平台"
                value={filters.platform}
                onChange={event => updateFilter('platform', event.target.value)}
                className="h-9 appearance-none rounded-lg border border-input bg-card py-0 pl-3 pr-10 text-[12px] font-medium outline-none focus:ring-2 focus:ring-primary/15"
              >
                <option value="">全部平台</option>
                <option value="xiaohongshu">小红书</option>
                <option value="douyin">抖音</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
            <div className="relative shrink-0">
              <select
                aria-label="官方账号"
                value={filters.officialAccountId}
                onChange={event => updateFilter('officialAccountId', event.target.value)}
                className="h-9 min-w-40 appearance-none rounded-lg border border-input bg-card py-0 pl-3 pr-10 text-[12px] font-medium outline-none focus:ring-2 focus:ring-primary/15"
              >
                <option value="">全部官方账号</option>
                {(data?.accounts || []).map(account => (
                  <option key={account.id} value={account.id}>
                    {platformName(account.platform)} · {account.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
            <div className="relative shrink-0">
              <select
                aria-label="排序"
                value={filters.sort}
                onChange={event => updateFilter('sort', event.target.value as PostSort)}
                className="h-9 appearance-none rounded-lg border border-input bg-card py-0 pl-3 pr-10 text-[12px] font-medium outline-none focus:ring-2 focus:ring-primary/15"
              >
                <option value="published_desc">发帖时间：新到旧</option>
                <option value="collected_desc">最近采集时间：新到旧</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2 lg:ml-0">
              <Button
                size="sm"
                className="h-9 shrink-0"
                onClick={() => createTask(filters.officialAccountId)}
                disabled={!canWrite() && !previewMode}
              >
                发起巡查
              </Button>
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-xs text-status-red">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => void load()}>重试</Button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : data ? (
        <>
          {data.posts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card">
              <EmptyState
                icon={MessageCircle}
                title="当前筛选下暂无官方帖子"
                description="调整筛选，或发起评论巡查。"
              />
              <div className="flex justify-center border-t border-border/60 p-4">
                <Button size="sm" onClick={() => createTask()}>
                  发起巡查
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid min-w-0 items-stretch gap-3 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,3fr)_minmax(380px,2fr)] xl:gap-0 xl:overflow-hidden">
              <div className="flex min-h-0 min-w-0 flex-col xl:pr-4">
                <PostList
                  posts={data.posts}
                  selectedPostId={selectedPostId}
                  onSelect={postId => {
                    setSelectedPostId(postId)
                    setBucket('negative')
                  }}
                  pagination={data.pagination}
                  onPage={setPage}
                  pageSize={pageSize}
                  onPageSize={nextPageSize => {
                    setPageSize(nextPageSize)
                    setPage(1)
                  }}
                />
              </div>
              <PostDetailPanel
                post={selectedPost}
                detail={detail}
                loading={detailLoading}
                error={detailError}
                bucket={bucket}
                onBucket={setBucket}
                onRetry={() => void loadDetail()}
              />
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}

function PostList({
  posts,
  selectedPostId,
  onSelect,
  pagination,
  onPage,
  pageSize,
  onPageSize,
}: {
  posts: PatrolPost[]
  selectedPostId: string
  onSelect: (postId: string) => void
  pagination: WorkbenchResponse['pagination']
  onPage: (page: number) => void
  pageSize: number
  onPageSize: (pageSize: number) => void
}) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card">
      <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain lg:hidden">
        <div className="divide-y divide-border/60">
          {posts.map(post => (
            <PostMobileCard
              key={post.id}
              post={post}
              selected={post.id === selectedPostId}
              onSelect={() => onSelect(post.id)}
            />
          ))}
        </div>
      </div>

      <div className="workspace-scrollbar hidden min-h-0 flex-1 overflow-auto overscroll-contain lg:block">
        <table aria-label="官方帖子列表" className="w-full table-fixed text-left">
          <thead className="sticky top-0 z-20 bg-card">
            <tr className="border-b border-border/60 bg-muted/20 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <th className="w-[36%] px-3 py-2.5">帖子信息</th>
              <th className="w-[24%] px-3 py-2.5">情感分布</th>
              <th className="w-[25%] px-3 py-2.5">互动数据</th>
              <th className="w-[15%] px-3 py-2.5">最近采集</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {posts.map(post => (
              <PostTableRow
                key={post.id}
                post={post}
                selected={post.id === selectedPostId}
                onSelect={() => onSelect(post.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        pagination={pagination}
        onPage={onPage}
        pageSize={pageSize}
        onPageSize={onPageSize}
      />
    </section>
  )
}

function PostTableRow({
  post,
  selected,
  onSelect,
}: {
  post: PatrolPost
  selected: boolean
  onSelect: () => void
}) {
  const selectFromKeyboard = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onSelect()
  }
  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={selectFromKeyboard}
      className={cn(
        'cursor-pointer align-middle outline-none transition-colors hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30',
        selected && 'bg-accent/55 shadow-[inset_3px_0_0_var(--primary)]',
      )}
    >
      <td className="px-3 py-3">
        <div className="flex items-start gap-2">
          <PlatformIcon platform={post.platform} />
          <div className="min-w-0">
            <div className="line-clamp-2 text-[12px] font-semibold leading-4.5 text-foreground">
              {post.title}
            </div>
            <div className="mt-1 truncate text-[10px] text-muted-foreground">
              {post.officialAccount.name} · {formatPublish(post.publishedAt, post.publishTime)}
            </div>
            {post.url || post.platform === 'xiaohongshu' ? (
              <RecordSourceAction record={post} compact className="mt-1 text-[10px]" />
            ) : (
              <span className="mt-1 inline-flex text-[10px] text-muted-foreground">
                原文链接待补充
              </span>
            )}
          </div>
        </div>
      </td>
      <td className="px-3 py-3">
        <SentimentDistribution sentiment={post.sentiment} />
      </td>
      <td className="px-3 py-3">
        <EngagementMetrics engagement={post.engagement} />
      </td>
      <td className="px-3 py-3 text-[10px] text-muted-foreground">
        {formatDateTime(post.lastPatrolledAt)}
      </td>
    </tr>
  )
}

function PostMobileCard({
  post,
  selected,
  onSelect,
}: {
  post: PatrolPost
  selected: boolean
  onSelect: () => void
}) {
  return (
    <article className={cn('px-4 py-4', selected && 'bg-accent/45')}>
      <button type="button" className="w-full text-left" onClick={onSelect}>
        <div className="min-w-0">
          <div className="flex items-start gap-2">
            <PlatformIcon platform={post.platform} />
            <h4 className="line-clamp-2 text-sm font-semibold leading-5">{post.title}</h4>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {post.officialAccount.name} · {formatPublish(post.publishedAt, post.publishTime)}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            最近采集 {formatDateTime(post.lastPatrolledAt)}
          </p>
        </div>
      </button>
      {post.url || post.platform === 'xiaohongshu' ? (
        <RecordSourceAction record={post} compact className="mt-2 text-[11px]" />
      ) : (
        <span className="mt-2 inline-flex text-[11px] text-muted-foreground">
          原文链接待补充
        </span>
      )}
      <div className="mt-3">
        <SentimentDistribution sentiment={post.sentiment} />
      </div>
      <div className="mt-3 rounded-lg bg-muted/25 px-2 py-2.5">
        <EngagementMetrics engagement={post.engagement} />
      </div>
    </article>
  )
}

function EngagementMetrics({
  engagement,
}: {
  engagement: PatrolPost['engagement']
}) {
  const items = [
    {
      label: '点赞',
      value: engagement.likes,
      delta: engagement.trend?.likes,
      icon: ThumbsUp,
    },
    {
      label: '评论',
      value: engagement.comments,
      delta: engagement.trend?.comments,
      icon: MessageCircle,
    },
    {
      label: '转发',
      value: engagement.shares,
      delta: engagement.trend?.shares,
      icon: Share2,
    },
  ]
  return (
    <div className="grid grid-cols-3 gap-1.5 text-center">
      {items.map(item => {
        const Icon = item.icon
        return (
          <div
            key={item.label}
            aria-label={`${item.label} ${formatNumber(item.value)}，${
              item.delta === undefined
                ? '暂无历史趋势'
                : item.delta === 0
                  ? '较上次采集持平'
                  : `较上次采集${item.delta > 0 ? '增加' : '减少'} ${formatNumber(Math.abs(item.delta))}`
            }`}
          >
            <div className="flex items-center justify-center gap-1.5 tabular-nums">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[12px] font-bold text-foreground">
                {formatNumber(item.value)}
              </span>
              <EngagementTrend delta={item.delta} />
            </div>
            <div className="mt-1 whitespace-nowrap text-[10px] font-medium text-muted-foreground">
              {item.label}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function EngagementTrend({delta}: {delta?: number}) {
  if (delta === undefined) {
    return (
      <span
        title="暂无历史采集数据"
        className="inline-flex h-5 items-center rounded bg-muted px-1.5 text-[10px] font-bold text-muted-foreground"
      >
        —
      </span>
    )
  }
  if (delta === 0) {
    return (
      <span
        title="较上次采集持平"
        className="inline-flex h-5 items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] font-bold tabular-nums text-muted-foreground"
      >
        <Minus className="h-3 w-3" />0
      </span>
    )
  }
  const rising = delta > 0
  const Icon = rising ? ArrowUpRight : ArrowDownRight
  return (
    <span
      title={`较上次采集${rising ? '增加' : '减少'} ${formatNumber(Math.abs(delta))}`}
      className={cn(
        'inline-flex h-5 items-center gap-0.5 rounded px-1.5 text-[10px] font-bold tabular-nums',
        rising
          ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
          : 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
      )}
    >
      <Icon className="h-3 w-3" />
      {formatNumber(Math.abs(delta))}
    </span>
  )
}

function SentimentDistribution({sentiment}: {sentiment: Sentiment}) {
  const denominator = Math.max(1, safeNumber(sentiment.total))
  const positiveWidth = (safeNumber(sentiment.positive) / denominator) * 100
  const neutralWidth = (safeNumber(sentiment.neutral) / denominator) * 100
  const negativeWidth = (safeNumber(sentiment.negative) / denominator) * 100
  return (
    <div>
      <div className="flex items-center gap-2.5 whitespace-nowrap text-[11px] font-semibold tabular-nums">
        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-status-green" />
          {formatNumber(sentiment.positive)} 正面
        </span>
        <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500" />
          {formatNumber(sentiment.neutral)} 中性
        </span>
        <span className="inline-flex items-center gap-1 text-status-red">
          <span className="h-1.5 w-1.5 rounded-full bg-status-red" />
          {formatNumber(sentiment.negative)} 负面
        </span>
      </div>
      <div
        className="mt-2 flex h-2.5 gap-px overflow-hidden rounded-full bg-muted"
        aria-label={`正面 ${sentiment.positive}，中性 ${sentiment.neutral}，负面 ${sentiment.negative}`}
      >
        <span className="bg-status-green" style={{width: `${positiveWidth}%`}} />
        <span className="bg-slate-300 dark:bg-slate-600" style={{width: `${neutralWidth}%`}} />
        <span className="bg-status-red" style={{width: `${negativeWidth}%`}} />
      </div>
    </div>
  )
}

function Pagination({
  pagination,
  onPage,
  pageSize,
  onPageSize,
}: {
  pagination: WorkbenchResponse['pagination']
  onPage: (page: number) => void
  pageSize: number
  onPageSize: (pageSize: number) => void
}) {
  const [jumpPage, setJumpPage] = useState('')
  const totalPages = Math.max(1, pagination.totalPages)
  const pageStart = pagination.total > 0
    ? (pagination.page - 1) * pagination.pageSize + 1
    : 0
  const pageEnd = Math.min(
    pagination.page * pagination.pageSize,
    pagination.total,
  )
  const paginationItems = getPaginationItems(pagination.page, totalPages)
  const goToPage = (requestedPage: number) => {
    const targetPage = Math.min(
      totalPages,
      Math.max(1, Math.trunc(requestedPage)),
    )
    setJumpPage('')
    if (targetPage !== pagination.page) onPage(targetPage)
  }
  const submitJumpPage = () => {
    const requestedPage = Number(jumpPage)
    if (!Number.isFinite(requestedPage) || jumpPage.trim() === '') return
    goToPage(requestedPage)
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border/60 px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        第 {formatNumber(pageStart)}–{formatNumber(pageEnd)} 条，共 {formatNumber(pagination.total)} 条
      </span>
      <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap lg:justify-end">
        <label className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          每页
          <select
            aria-label="每页条数"
            value={pageSize}
            onChange={event => onPageSize(Number(event.target.value))}
            className="h-8 rounded-lg border border-border bg-card px-2 text-[10px] font-medium tabular-nums text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
          >
            {PAGE_SIZE_OPTIONS.map(size => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
          条
        </label>

        <nav aria-label="官方帖子分页" className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label="上一页"
            title="上一页"
            disabled={pagination.page <= 1}
            onClick={() => goToPage(pagination.page - 1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <div className="hidden items-center gap-1 sm:flex">
            {paginationItems.map((item, index) => item === 'ellipsis' ? (
              <span
                key={`ellipsis-${index}`}
                className="flex h-8 w-5 items-center justify-center text-[10px] text-muted-foreground"
              >
                …
              </span>
            ) : (
              <Button
                key={item}
                variant={item === pagination.page ? 'default' : 'outline'}
                size="icon"
                className="h-8 w-8 text-[10px] tabular-nums"
                aria-label={`第 ${item} 页`}
                aria-current={item === pagination.page ? 'page' : undefined}
                onClick={() => goToPage(item)}
              >
                {item}
              </Button>
            ))}
          </div>
          <span className="min-w-14 px-1 text-center text-[10px] tabular-nums text-muted-foreground sm:hidden">
            {pagination.page} / {totalPages} 页
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label="下一页"
            title="下一页"
            disabled={pagination.page >= totalPages}
            onClick={() => goToPage(pagination.page + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </nav>

        <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>跳至</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={totalPages}
            value={jumpPage}
            onChange={event => setJumpPage(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') submitJumpPage()
            }}
            aria-label="跳转页码"
            className="h-8 w-14 px-2 text-center text-[10px] tabular-nums"
          />
          <span>页</span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-[10px]"
            disabled={jumpPage.trim() === ''}
            onClick={submitJumpPage}
          >
            跳转
          </Button>
        </div>
      </div>
    </div>
  )
}

function PostDetailPanel({
  post,
  detail,
  loading,
  error,
  bucket,
  onBucket,
  onRetry,
}: {
  post: PatrolPost | null
  detail: PostCommentsResponse | null
  loading: boolean
  error: string
  bucket: CommentBucket
  onBucket: (bucket: CommentBucket) => void
  onRetry: () => void
}) {
  if (!post) {
    return (
      <aside className="flex min-h-0 min-w-0 flex-col xl:border-l xl:border-border/70 xl:pl-4">
        <div className="flex flex-1 items-center bg-card p-5">
          <EmptyState icon={MessageCircle} title="选择一篇帖子查看评论" />
        </div>
      </aside>
    )
  }
  const counts = detail?.counts || {
    all: post.sentiment.total,
    negative: post.sentiment.negative,
    positive: post.sentiment.positive,
    negativePending: post.todos.negative,
    positivePending: post.todos.positive,
  }
  return (
    <aside className="flex min-h-0 min-w-0 flex-col xl:border-l xl:border-border/70 xl:pl-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
      <div className="flex shrink-0 gap-1 border-b border-border/60 px-3">
        <DetailTab
          active={bucket === 'negative'}
          tone="negative"
          onClick={() => onBucket('negative')}
        >
          负面评论 {formatNumber(counts.negative)}
        </DetailTab>
        <DetailTab
          active={bucket === 'positive'}
          tone="positive"
          onClick={() => onBucket('positive')}
        >
          正面评论 {formatNumber(counts.positive)}
        </DetailTab>
        <DetailTab
          active={bucket === 'all'}
          tone="neutral"
          onClick={() => onBucket('all')}
        >
          全部评论 {formatNumber(counts.all)}
        </DetailTab>
      </div>

      <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div role="alert" className="p-5 text-center text-xs text-status-red">
            <p>{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
              重试
            </Button>
          </div>
        ) : detail?.comments.length ? (
          <div className="divide-y divide-border/60">
            {detail.comments.map(comment => (
              <CommentCard
                key={comment.id}
                comment={comment}
              />
            ))}
          </div>
        ) : (
          <div className="px-5 py-16 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {bucket === 'positive'
                ? <Heart className="h-4.5 w-4.5" />
                : <ShieldAlert className="h-4.5 w-4.5" />}
            </div>
            <p className="mt-3 text-[12px] font-semibold">
              {bucket === 'negative' ? '暂无负面评论' : bucket === 'positive' ? '暂无正面评论' : '暂无评论样本'}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              评论结果来自最近一次有效巡查样本
            </p>
          </div>
        )}
      </div>
      </div>
    </aside>
  )
}

function DetailTab({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean
  tone: 'negative' | 'positive' | 'neutral'
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'relative min-h-9 flex-1 whitespace-nowrap px-2 text-[10px] font-semibold text-muted-foreground transition-colors hover:text-foreground',
        active && tone === 'negative' && 'text-status-red',
        active && tone === 'positive' && 'text-emerald-700 dark:text-emerald-300',
        active && tone === 'neutral' && 'text-primary',
      )}
    >
      {children}
      {active && (
        <span className={cn(
          'absolute inset-x-2 bottom-0 h-0.5 rounded-full',
          tone === 'negative' && 'bg-status-red',
          tone === 'positive' && 'bg-status-green',
          tone === 'neutral' && 'bg-primary',
        )} />
      )}
    </button>
  )
}

function commentRecommendation(comment: PatrolComment) {
  if (comment.sentiment === 'positive') {
    return '点赞鼓励；如果提到具体使用体验，可简短回复致谢。'
  }
  if (['critical', 'high'].includes(comment.riskLevel)) {
    return '优先核实事实并准备公开回复；仅在确认违规、辱骂或虚假信息时考虑删除。'
  }
  if (comment.isNegative || comment.sentiment === 'negative') {
    return '先回应评论里的具体问题并跟进；如属重复攻击或违规内容，再考虑删除。'
  }
  return '观察后续讨论；出现明确问题或求助时再回复。'
}

function CommentCard({ comment }: { comment: PatrolComment }) {
  const positive = comment.sentiment === 'positive'
  return (
    <article className="px-3 py-3.5 sm:px-4">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="max-w-full break-words text-[11px] font-semibold">{comment.authorName}</span>
          <span className="text-[9px] text-muted-foreground">
            {comment.publishedAt || formatDateTime(comment.firstSeenAt)}
            {comment.ipLocation ? ` · ${comment.ipLocation}` : ''}
          </span>
        </div>
        <p className="mt-2 break-words text-[12px] leading-5 text-foreground">{comment.content}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[9px]">
          <StatusPill tone={positive ? 'positive' : comment.isNegative ? 'negative' : 'neutral'}>
            {positive ? '正面' : comment.isNegative ? '负面' : '中性'}
          </StatusPill>
          {comment.riskLevel && !['none', 'low'].includes(comment.riskLevel) && (
            <StatusPill tone={comment.riskLevel}>
              {comment.riskLevel === 'critical' ? '危急风险' : comment.riskLevel === 'high' ? '高风险' : '中风险'}
            </StatusPill>
          )}
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <ThumbsUp className="h-3 w-3" />
            {formatNumber(comment.likeCount)}
          </span>
        </div>
        <div className="mt-2.5 rounded-lg bg-muted/35 px-2.5 py-2">
          <p className="text-[10px] leading-4 text-foreground/80">
            <span className="font-semibold">建议：</span>
            {commentRecommendation(comment)}
          </p>
        </div>
      </div>
    </article>
  )
}
