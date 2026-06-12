import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight, ChevronLeft, ChevronRight, Database, Download, ExternalLink, Image as ImageIcon,
  Loader2, RefreshCw, Search,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, formatNumber, platformName } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { WorkbenchSelect, WorkbenchTableShell, WorkbenchTabs, WorkbenchToolbar } from '@/components/shared/Workbench'
import { useNav } from '@/lib/navigation'

type TableKey =
  | 'single_notes'
  | 'keyword_notes'
  | 'blogger_profiles'
  | 'blogger_notes'
  | 'comment_leads'
  | 'monitor_content'

type Column = {
  key: string
  label: string
  width?: string
  render: (row: any, ctx: CellRenderContext) => React.ReactNode
}

type CellRenderContext = {
  expanded: boolean
  toggle: () => void
  resetKey: string
}

const TABLES: Array<{ key: TableKey; label: string; description: string }> = [
  { key: 'single_notes', label: '单笔记采集', description: '单条内容原始采集表' },
  { key: 'keyword_notes', label: '关键词笔记采集', description: '按关键词搜索采集的内容' },
  { key: 'blogger_profiles', label: '博主信息表', description: '账号主页与粉丝数据' },
  { key: 'blogger_notes', label: '博主笔记采集', description: '指定博主主页下的内容列表' },
  { key: 'comment_leads', label: '评论区客资采集', description: '评论区舆情跟进线索' },
  { key: 'monitor_content', label: '监控内容表', description: '监控任务命中的作品结果' },
]

const PLATFORM_OPTIONS = [
  { value: '', label: '全部平台' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'weibo', label: '微博' },
]

const VALID_TABLES: TableKey[] = ['single_notes', 'keyword_notes', 'blogger_profiles', 'blogger_notes', 'comment_leads', 'monitor_content']

export function DataPage() {
  const { params, navigate } = useNav()
  const initialTable = (VALID_TABLES.includes(params?.table as TableKey) ? params!.table : 'single_notes') as TableKey
  const [activeTable, setActiveTable] = useState<TableKey>(initialTable)
  const [rows, setRows] = useState<any[]>([])
  const [pagination, setPagination] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [platform, setPlatform] = useState(params?.platform ?? '')
  const [keyword, setKeyword] = useState('')
  const [expandedCells, setExpandedCells] = useState<Record<string, boolean>>({})
  const [expandResetVersion, setExpandResetVersion] = useState(0)

  const activeConfig = TABLES.find(table => table.key === activeTable) || TABLES[0]
  const columns = useMemo(() => {
    const base = columnsForTable(activeTable, platform)
    if (MEDIA_TABLES.has(activeTable)) {
      return [col('attachments', '附件', r => <AttachmentDownloadCell row={r} />, '128px'), ...base]
    }
    return base
  }, [activeTable, platform])
  const tableMinWidth = useMemo(() => columns.reduce((sum, column) => sum + columnWidthValue(column), 0), [columns])

  const load = async (page = 1) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '50' })
      if (platform) params.set('platform', platform)
      if (keyword.trim()) params.set('keyword', keyword.trim())
      const data = await api.get<any>(`/records/tables/${activeTable}?${params.toString()}`)
      setRows(data.rows || [])
      setPagination(data.pagination || null)
      setExpandedCells({})
      setExpandResetVersion(current => current + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '数据表加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(1) }, [activeTable, platform])

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-300">
      <WorkbenchTabs
        tabs={TABLES.map(table => ({ key: table.key, label: table.label }))}
        activeKey={activeTable}
        onChange={key => setActiveTable(key as TableKey)}
      />

      <WorkbenchToolbar meta={activeConfig.description}>
        <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)}>
          {PLATFORM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </WorkbenchSelect>
        <div className="relative min-w-[260px] flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') load(1) }}
            placeholder="搜索标题、正文、作者、关键词"
            className="h-8 pl-8 text-xs"
          />
          </div>
        <Button variant="outline" size="sm" onClick={() => load(1)} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </WorkbenchToolbar>

      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      <WorkbenchTableShell>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{activeConfig.label}</span>
            <StatusBadge tone="neutral">{formatNumber(pagination?.total ?? rows.length)} 条</StatusBadge>
            <span className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
              {platform ? platformName(platform) : '全部平台'}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {activeTable === 'comment_leads' && (
              <button
                onClick={() => navigate('workbench', { queue: 'leads' })}
                className="inline-flex items-center gap-1 font-medium text-primary transition-colors hover:underline"
              >
                去工作台处理 <ArrowRight className="h-3 w-3" />
              </button>
            )}
            <span>{columns.length} 列</span>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="max-h-[calc(100vh-330px)] min-h-[420px] overflow-auto bg-background">
            <table className="w-full border-separate border-spacing-0 text-sm" style={{ minWidth: `${Math.max(1280, tableMinWidth)}px` }}>
              <thead>
                <tr>
                  {columns.map((column, index) => (
                    <th
                      key={column.key}
                      className={tableHeaderClass(index)}
                      style={columnWidthStyle(column)}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map((row, index) => (
                    <tr key={row.id || row.observation_id || index} className="group align-top">
                      {columns.map((column, columnIndex) => {
                        const rowKey = String(row.id || row.observation_id || `${activeTable}-${pagination?.page || 1}-${index}`)
                        const cellKey = `${rowKey}:${column.key}`
                        return (
                          <td key={column.key} className={tableCellClass(columnIndex)} style={columnWidthStyle(column)}>
                            {column.render(row, {
                              expanded: Boolean(expandedCells[cellKey]),
                              resetKey: `${expandResetVersion}:${cellKey}`,
                              toggle: () => setExpandedCells(current => ({ ...current, [cellKey]: !current[cellKey] })),
                            })}
                          </td>
                        )
                      })}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={columns.length}>
                      <EmptyState icon={Database} title="暂无数据" description="采集或同步后，这张表会显示对应记录" />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">共 {formatNumber(pagination.total)} 条</span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-3 text-sm tabular-nums text-muted-foreground">{pagination.page} / {pagination.totalPages}</span>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </WorkbenchTableShell>
    </div>
  )
}

function columnsForTable(table: TableKey, platform = ''): Column[] {
  if (table === 'single_notes') {
    return singleNoteColumns(platform)
  }

  if (table === 'keyword_notes') {
    return keywordNoteColumns(platform)
  }

  if (table === 'blogger_profiles') {
    return bloggerProfileColumns(platform)
  }

  if (table === 'blogger_notes') {
    return bloggerNoteColumns(platform)
  }

  if (table === 'comment_leads') {
    return [
      col('recordTitle', '原笔记标题', (r, ctx) => longCell(r.record_title || '(无标题)', 180, ctx)),
      col('recordUrl', '原笔记链接', r => linkCell(r.record_url, '原文')),
      col('user', '评论用户', r => textCell(r.comment_author_name)),
      col('ip', 'IP属地', r => textCell(r.comment_ip_location)),
      col('content', '评论内容', (r, ctx) => longCell(r.comment_content, 260, ctx)),
      col('likes', '点赞数', r => metricCell(r.comment_like_count)),
      col('userUrl', '用户主页', r => linkCell(commentUserUrl(r), '主页')),
      col('matched', '命中关键词', r => tagCell(r.matched_keywords)),
      col('userId', '用户ID', r => textCell(r.comment_author_id)),
      col('time', '采集时间', r => dateCell(r.captured_at)),
      col('platform', '采集平台', r => platformBadge(r.platform)),
    ]
  }

  if (table === 'monitor_content') {
    return monitorContentColumns(platform)
  }

  return [
    col('author', '博主', r => textCell(r.author_name)),
    col('profile', '博主主页', r => linkCell(authorHomepage(r), '主页')),
    col('fans', '粉丝数', r => metricCell(r.author_fans)),
    col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
    col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))),
    col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
    col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
    col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
    col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
    col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
    col('tags', '话题标签', r => tagCell(r.tags)),
    col('likes', '点赞数', r => metricCell(r.likes)),
    col('collects', '收藏数', r => metricCell(r.collects)),
  ]
}

function keywordNoteColumns(platform: string): Column[] {
  if (platform === 'douyin') {
    return [
      col('keyword', '关键词', r => textCell(r.keyword || value(r, 'payload.keyword'))),
      col('author', '博主', r => textCell(r.author_name)),
      col('profile', '博主主页', r => linkCell(authorHomepage(r), '查看博主主页')),
      col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
      col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
      col('likes', '点赞数', r => metricCell(r.likes)),
      col('collects', '收藏数', r => metricCell(r.collects)),
      col('comments', '评论数', r => metricCell(r.comments_count)),
      col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
      col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
      col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
      col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
      col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
      col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
      col('tags', '话题标签', r => tagCell(r.tags)),
      col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
      ...aiWorkflowColumns({ includeDuration: false }),
      ...sourceTimeColumns('edited-first'),
    ]
  }

  return [
    col('keyword', '关键词', r => textCell(r.keyword || value(r, 'payload.keyword'))),
    col('author', '博主', r => textCell(r.author_name)),
    col('fans', '粉丝数', r => metricCell(r.author_fans)),
    col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
    col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))),
    col('profile', '博主主页', r => linkCell(authorHomepage(r), '查看博主主页')),
    col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
    col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
    col('tags', '话题标签', r => tagCell(r.tags)),
    col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
    col('likes', '点赞数', r => metricCell(r.likes)),
    col('collects', '收藏数', r => metricCell(r.collects)),
    col('comments', '评论数', r => metricCell(r.comments_count)),
    col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
    col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
    col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
    col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
    col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
    col('imageLinks', '图片链接', r => linkListCell(imageUrls(r), '图片')),
    col('images', '附件图片', r => imagesCell(imageUrls(r), r.title)),
    col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
    ...aiWorkflowColumns({ includeDuration: true }),
    ...sourceTimeColumns('edited-first'),
  ]
}

function bloggerProfileColumns(platform: string): Column[] {
  const columns: Column[] = [
    col('name', '博主名称', r => textCell(r.author_name || r.title)),
  ]

  if (platform !== 'douyin') {
    columns.push(col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))))
  }

  columns.push(
    col('profile', '主页链接', r => linkCell(authorHomepage(r) || r.url, '查看博主主页')),
    col('avatarLink', '头像链接', r => linkCell(avatarUrl(r), '头像')),
    col('avatar', '头像', r => imageCell(avatarUrl(r), r.author_name)),
    col('id', '小红书号', r => textCell(bloggerIdentifier(r))),
    col('desc', '简介', (r, ctx) => longCell(r.content || value(r, 'payload.description'), 180, ctx)),
    col('ip', 'IP属地', r => textCell(value(r, 'payload.ipLocation') || value(r, 'payload.region'))),
    col('following', '关注数', r => metricCell(value(r, 'payload.followingCount') || value(r, 'payload.followCount'))),
    col('fans', '粉丝数', r => metricCell(r.author_fans || value(r, 'payload.followersCount'))),
    col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
    col('time', '采集时间', r => dateCell(recordCaptureTime(r))),
    col('platform', '采集平台', r => platformBadge(r.platform)),
  )

  return columns
}

function bloggerNoteColumns(platform: string): Column[] {
  if (platform === 'douyin') {
    return [
      col('author', '博主', r => textCell(r.author_name)),
      col('fans', '粉丝数', r => metricCell(r.author_fans)),
      col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
      col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
      col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
      col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
      col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
      col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
      col('likes', '点赞数', r => metricCell(r.likes)),
      col('collects', '收藏数', r => metricCell(r.collects)),
      col('comments', '评论数', r => metricCell(r.comments_count)),
      col('shares', '转发数', r => metricCell(r.shares)),
      col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
      col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
      col('profile', '博主主页', r => linkCell(authorHomepage(r), '查看博主主页')),
      col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
      col('tags', '话题标签', r => tagCell(r.tags)),
      col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
      col('audio', '音频链接', r => linkCell(audioUrl(r), '收听音频')),
      ...aiWorkflowColumns({ includeDuration: true }),
      ...sourceTimeColumns('edited-first'),
    ]
  }

  return [
    col('author', '博主', r => textCell(r.author_name)),
    col('fans', '粉丝数', r => metricCell(r.author_fans)),
    col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
    col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))),
    col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
    col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
    col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
    col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
    col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
    col('likes', '点赞数', r => metricCell(r.likes)),
    col('collects', '收藏数', r => metricCell(r.collects)),
    col('comments', '评论数', r => metricCell(r.comments_count)),
    col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
    col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
    col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
    ...aiWorkflowColumns({ includeDuration: true }),
    ...sourceTimeColumns('edited-first'),
  ]
}

function monitorContentColumns(platform: string): Column[] {
  const isDouyin = platform === 'douyin'
  const columns: Column[] = [
    col('author', '博主', r => textCell(r.author_name)),
    col('profile', '博主主页', r => linkCell(authorHomepage(r), '查看博主主页')),
    col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
    col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
    col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
    col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
    col('likes', '点赞数', r => metricCell(r.likes)),
    col('collects', '收藏数', r => metricCell(r.collects)),
    col('comments', '评论数', r => metricCell(r.comments_count)),
  ]

  if (isDouyin || !platform) {
    columns.push(col('shares', '转发数', r => metricCell(r.shares)))
  }

  columns.push(
    col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
    col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
  )

  if (isDouyin) {
    columns.push(
      col('duration', '视频时长', r => textCell(videoDuration(r))),
      col('imageLinks', '图片链接', r => linkListCell(imageUrls(r), '图片')),
      col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
      col('tags', '话题标签', r => tagCell(r.tags)),
      col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
      col('audio', '音频链接', r => linkCell(audioUrl(r), '收听音频')),
      ...aiWorkflowColumns({ includeDuration: false }),
      ...sourceTimeColumns('capture-first'),
    )
    return columns
  }

  columns.push(
    col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
    col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
    col('tags', '话题标签', r => tagCell(r.tags)),
    col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
    ...aiWorkflowColumns({ includeDuration: platform ? true : false }),
    ...sourceTimeColumns('capture-first'),
  )

  return columns
}

function aiWorkflowColumns({ includeDuration }: { includeDuration: boolean }): Column[] {
  return [
    ...(includeDuration ? [col('duration', '视频时长', r => textCell(videoDuration(r)))] : []),
    col('transcript', '视频逐字稿提取', (r, ctx) => longCell(videoTranscript(r), 220, ctx)),
    col('script', '视频脚本分析', (r, ctx) => longCell(videoScriptAnalysis(r), 180, ctx)),
    col('scriptOut', '视频脚本分析.输出结果', (r, ctx) => longCell(videoScriptAnalysisOutput(r), 220, ctx)),
    col('commentText', '评论内容', (r, ctx) => longCell(commentText(r), 260, ctx)),
    col('commentAnalysis', '评论分析', (r, ctx) => longCell(commentAnalysis(r), 180, ctx)),
    col('commentAnalysisOut', '评论分析.输出结果', (r, ctx) => longCell(commentAnalysisOutput(r), 220, ctx)),
    col('rewrite', '改写', (r, ctx) => longCell(rewriteInput(r), 180, ctx)),
    col('rewriteOut', '改写.输出结果', (r, ctx) => longCell(rewriteOutput(r), 220, ctx)),
  ]
}

function sourceTimeColumns(order: 'capture-first' | 'edited-first'): Column[] {
  const platformColumn = col('platform', '采集平台', r => platformBadge(r.platform))
  const captureColumn = col('captureTime', '采集时间', r => dateCell(recordCaptureTime(r)))
  const editedColumn = col('editedAt', '笔记最近编辑时间', r => dateCell(noteEditedAt(r)))

  return order === 'capture-first'
    ? [platformColumn, captureColumn, editedColumn]
    : [platformColumn, editedColumn, captureColumn]
}

function singleNoteColumns(platform: string): Column[] {
  if (platform === 'xiaohongshu') {
    return [
      col('author', '博主', r => textCell(r.author_name)),
      col('profile', '博主主页', r => linkCell(authorHomepage(r), '主页')),
      col('fans', '粉丝数', r => metricCell(r.author_fans)),
      col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
      col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))),
      col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
      col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
      col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
      col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
      col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
      col('tags', '话题标签', r => tagCell(r.tags)),
      col('likes', '点赞数', r => metricCell(r.likes)),
      col('collects', '收藏数', r => metricCell(r.collects)),
      col('comments', '评论数', r => metricCell(r.comments_count)),
      col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
      col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
      col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
      col('imageLinks', '图片链接', r => linkListCell(imageUrls(r), '图片')),
      col('images', '附件图片', r => imagesCell(imageUrls(r), r.title)),
      col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
      col('duration', '视频时长', r => textCell(videoDuration(r))),
      col('transcript', '视频逐字稿提取', (r, ctx) => longCell(videoTranscript(r), 220, ctx)),
      col('script', '视频脚本分析', (r, ctx) => longCell(videoScriptAnalysis(r), 180, ctx)),
      col('scriptOut', '视频脚本分析.输出结果', (r, ctx) => longCell(videoScriptAnalysisOutput(r), 220, ctx)),
      col('commentText', '评论内容', (r, ctx) => longCell(commentText(r), 260, ctx)),
      col('commentAnalysis', '评论分析', (r, ctx) => longCell(commentAnalysis(r), 180, ctx)),
      col('commentAnalysisOut', '评论分析.输出结果', (r, ctx) => longCell(commentAnalysisOutput(r), 220, ctx)),
      col('rewrite', '改写', (r, ctx) => longCell(rewriteInput(r), 180, ctx)),
      col('rewriteOut', '改写.输出结果', (r, ctx) => longCell(rewriteOutput(r), 220, ctx)),
      col('platform', '采集平台', r => platformBadge(r.platform)),
      col('captureTime', '采集时间', r => dateCell(r.capture_timestamp || r.created_at)),
      col('editedAt', '笔记最近编辑时间', r => dateCell(noteEditedAt(r))),
    ]
  }

  if (platform === 'douyin') {
    return [
      col('author', '博主', r => textCell(r.author_name)),
      col('profile', '博主主页', r => linkCell(authorHomepage(r), '主页')),
      col('fans', '粉丝数', r => metricCell(r.author_fans)),
      col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
      col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
      col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
      col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
      col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
      col('likes', '点赞数', r => metricCell(r.likes)),
      col('collects', '收藏数', r => metricCell(r.collects)),
      col('comments', '评论数', r => metricCell(r.comments_count)),
      col('shares', '转发数', r => metricCell(r.shares)),
      col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
      col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
      col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
      col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
      col('tags', '话题标签', r => tagCell(r.tags)),
      col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
      col('audio', '音频链接', r => linkCell(audioUrl(r), '收听音频')),
      col('duration', '视频时长', r => textCell(videoDuration(r))),
      col('transcript', '视频逐字稿提取', (r, ctx) => longCell(videoTranscript(r), 220, ctx)),
      col('script', '视频脚本分析', (r, ctx) => longCell(videoScriptAnalysis(r), 180, ctx)),
      col('scriptOut', '视频脚本分析.输出结果', (r, ctx) => longCell(videoScriptAnalysisOutput(r), 220, ctx)),
      col('commentText', '评论内容', (r, ctx) => longCell(commentText(r), 260, ctx)),
      col('commentAnalysis', '评论分析', (r, ctx) => longCell(commentAnalysis(r), 180, ctx)),
      col('commentAnalysisOut', '评论分析.输出结果', (r, ctx) => longCell(commentAnalysisOutput(r), 220, ctx)),
      col('rewrite', '改写', (r, ctx) => longCell(rewriteInput(r), 180, ctx)),
      col('rewriteOut', '改写.输出结果', (r, ctx) => longCell(rewriteOutput(r), 220, ctx)),
      col('platform', '采集平台', r => platformBadge(r.platform)),
      col('captureTime', '采集时间', r => dateCell(r.capture_timestamp || r.created_at)),
      col('editedAt', '笔记最近编辑时间', r => dateCell(noteEditedAt(r))),
    ]
  }

  return [
    col('author', '博主', r => textCell(r.author_name)),
    col('profile', '博主主页', r => linkCell(authorHomepage(r), '主页')),
    col('fans', '粉丝数', r => metricCell(r.author_fans)),
    col('liked', '点赞与收藏数', r => metricCell(bloggerLiked(r))),
    col('account', '账号属性', r => textCell(r.blogger_account_type || value(r, 'payload.accountType'))),
    col('type', '笔记类型', r => textCell(noteTypeLabel(r))),
    col('coverLink', '封面链接', r => linkCell(primaryImage(r), '封面')),
    col('cover', '封面图', r => imageCell(primaryImage(r), r.title)),
    col('title', '标题', (r, ctx) => longCell(r.title || '(无标题)', 180, ctx)),
    col('content', '正文', (r, ctx) => longCell(r.content, 220, ctx)),
    col('tags', '话题标签', r => tagCell(r.tags)),
    col('likes', '点赞数', r => metricCell(r.likes)),
    col('collects', '收藏数', r => metricCell(r.collects)),
    col('comments', '评论数', r => metricCell(r.comments_count)),
    col('shares', '转发数', r => metricCell(r.shares)),
    col('noteRating', '笔记评级', r => ratingBadge(noteRating(r))),
    col('collectRating', '收藏评级', r => ratingBadge(collectRating(r))),
    col('url', '笔记链接', r => linkCell(r.url, '打开笔记')),
    col('imageLinks', '图片链接', r => linkListCell(imageUrls(r), '图片')),
    col('images', '附件图片', r => imagesCell(imageUrls(r), r.title)),
    col('video', '视频链接', r => linkCell(videoUrl(r), '查看视频')),
    col('audio', '音频链接', r => linkCell(audioUrl(r), '收听音频')),
    col('duration', '视频时长', r => textCell(videoDuration(r))),
    col('transcript', '视频逐字稿提取', (r, ctx) => longCell(videoTranscript(r), 220, ctx)),
    col('script', '视频脚本分析', (r, ctx) => longCell(videoScriptAnalysis(r), 180, ctx)),
    col('scriptOut', '视频脚本分析.输出结果', (r, ctx) => longCell(videoScriptAnalysisOutput(r), 220, ctx)),
    col('commentText', '评论内容', (r, ctx) => longCell(commentText(r), 260, ctx)),
    col('commentAnalysis', '评论分析', (r, ctx) => longCell(commentAnalysis(r), 180, ctx)),
    col('commentAnalysisOut', '评论分析.输出结果', (r, ctx) => longCell(commentAnalysisOutput(r), 220, ctx)),
    col('rewrite', '改写', (r, ctx) => longCell(rewriteInput(r), 180, ctx)),
    col('rewriteOut', '改写.输出结果', (r, ctx) => longCell(rewriteOutput(r), 220, ctx)),
    col('platform', '采集平台', r => platformBadge(r.platform)),
    col('captureTime', '采集时间', r => dateCell(r.capture_timestamp || r.created_at)),
    col('editedAt', '笔记最近编辑时间', r => dateCell(noteEditedAt(r))),
  ]
}

function col(key: string, label: string, render: Column['render'], width?: string): Column {
  return { key, label, render, width }
}

function columnWidthValue(column: Column) {
  if (column.width) return Number.parseInt(column.width, 10) || 150
  if (['author', 'name', 'recordTitle'].includes(column.key)) return 220
  if (['title', 'content', 'desc', 'commentText', 'commentAnalysisOut', 'scriptOut', 'rewriteOut'].includes(column.key)) return 300
  if (['transcript', 'script', 'commentAnalysis', 'rewrite'].includes(column.key)) return 260
  if (['cover', 'images', 'avatar'].includes(column.key)) return 118
  if (['imageLinks', 'profile', 'url', 'recordUrl', 'video', 'audio', 'coverLink', 'avatarLink', 'userUrl'].includes(column.key)) return 128
  if (['likes', 'collects', 'comments', 'shares', 'fans', 'liked', 'following'].includes(column.key)) return 96
  if (['platform', 'type', 'account', 'noteRating', 'collectRating'].includes(column.key)) return 118
  if (['captureTime', 'editedAt', 'time'].includes(column.key)) return 150
  if (['tags', 'matched'].includes(column.key)) return 220
  return 150
}

function columnWidthStyle(column: Column) {
  const width = `${columnWidthValue(column)}px`
  return { width, minWidth: width, maxWidth: width }
}

function tableHeaderClass(index: number) {
  return [
    'sticky top-0 border-b border-r border-border bg-muted px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground',
    index === 0 ? 'left-0 z-30' : 'z-20',
  ].join(' ')
}

function tableCellClass(index: number) {
  return [
    'border-b border-r border-border bg-card px-3 py-2 transition-colors group-hover:bg-muted/30',
    index === 0 ? 'sticky left-0 z-10' : '',
  ].join(' ')
}

function safeObject(value: unknown): Record<string, any> {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (!value) return []
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : value.split(/[,\s，#]+/).filter(Boolean)
    } catch {
      return value.split(/[,\s，#]+/).filter(Boolean)
    }
  }
  return []
}

function value(row: any, path: string): any {
  const parts = path.split('.')
  let current: any = row
  for (const part of parts) {
    current = part === 'payload' || part === 'record_payload' || part === 'comment_payload'
      ? safeObject(current?.[part])
      : current?.[part]
    if (current == null || current === '') return ''
  }
  return current
}

function firstValue(...values: any[]) {
  return values.find(item => item !== undefined && item !== null && item !== '') || ''
}

function recordCaptureTime(row: any) {
  return firstValue(
    row.monitor_captured_at,
    row.capture_timestamp,
    value(row, 'payload.captureTimestamp'),
    value(row, 'payload.capturedAt'),
    row.created_at,
  )
}

function avatarUrl(row: any) {
  return firstValue(
    row.author_avatar,
    value(row, 'payload.avatarUrl'),
    value(row, 'payload.authorAvatar'),
    value(row, 'payload.authorAvatarUrl'),
    value(row, 'payload.bloggerAvatar'),
  )
}

function bloggerIdentifier(row: any) {
  return firstValue(
    row.author_id,
    value(row, 'payload.xiaohongshuId'),
    value(row, 'payload.redId'),
    value(row, 'payload.douyinId'),
    value(row, 'payload.secUid'),
    value(row, 'payload.bloggerId'),
    value(row, 'payload.authorId'),
  )
}

function authorHomepage(row: any) {
  return firstValue(
    row.blogger_profile_url,
    row.monitor_account_url,
    value(row, 'payload.bloggerProfileUrl'),
    value(row, 'payload.authorProfileUrl'),
    value(row, 'payload.authorUrl'),
    value(row, 'payload.profileUrl'),
    value(row, 'record_payload.bloggerProfileUrl'),
  )
}

function bloggerLiked(row: any) {
  return firstValue(
    row.blogger_liked_collected,
    value(row, 'payload.bloggerLikedAndCollectedCount'),
    value(row, 'payload.likedAndCollectedCount'),
    value(row, 'payload.likedCollectedCount'),
  )
}

function primaryImage(row: any) {
  return firstValue(
    row.cover_url,
    value(row, 'payload.coverImageUrl'),
    value(row, 'payload.coverUrl'),
    value(row, 'payload.cover'),
    asArray(row.image_urls)[0],
    asArray(value(row, 'payload.imageUrls'))[0],
    asArray(value(row, 'payload.images'))[0],
  )
}

function imageUrls(row: any) {
  const urls = [
    ...asArray(row.image_urls),
    ...asArray(value(row, 'payload.imageUrls')),
    ...asArray(value(row, 'payload.images')),
    ...asArray(value(row, 'payload.imageLinks')),
    ...asArray(value(row, 'payload.attachments')),
  ].map(urlFromItem).filter(Boolean)
  const cover = primaryImage(row)
  return Array.from(new Set([cover, ...urls].filter(Boolean).map(String)))
}

function urlFromItem(item: any) {
  if (!item) return ''
  if (typeof item === 'string') return item.trim()
  if (typeof item === 'object') {
    return String(firstValue(item.url, item.src, item.href, item.originUrl, item.originalUrl, item.downloadUrl)).trim()
  }
  return ''
}

function videoUrl(row: any) {
  return firstValue(
    row.video_url,
    value(row, 'payload.videoUrl'),
    value(row, 'payload.videoLink'),
    value(row, 'payload.video_url'),
    value(row, 'payload.awemeVideoUrl'),
    urlFromItem(asArray(value(row, 'payload.videoUrls'))[0]),
  )
}

function audioUrl(row: any) {
  return firstValue(
    row.audio_url,
    value(row, 'payload.audioUrl'),
    value(row, 'payload.audio_url'),
    value(row, 'payload.musicUrl'),
    urlFromItem(asArray(value(row, 'payload.audioUrls'))[0]),
    urlFromItem(asArray(value(row, 'payload.musicUrls'))[0]),
  )
}

function videoDuration(row: any) {
  return firstValue(
    row.video_duration,
    value(row, 'payload.videoDuration'),
    value(row, 'payload.videoTime'),
    value(row, 'payload.duration'),
  )
}

function videoTranscript(row: any) {
  return firstValue(
    value(row, 'payload.videoTranscript'),
    value(row, 'payload.videoTranscriptText'),
    value(row, 'payload.videoTranscriptExtracted'),
    value(row, 'payload.videoSubtitleText'),
    value(row, 'payload.subtitleText'),
    value(row, 'payload.transcript'),
    value(row, 'payload.asrText'),
    value(row, 'payload.videoText'),
  )
}

function videoScriptAnalysis(row: any) {
  return firstValue(
    value(row, 'payload.videoScriptAnalysis'),
    value(row, 'payload.videoScriptAnalyze'),
    value(row, 'payload.scriptAnalysis'),
    value(row, 'payload.videoScriptPrompt'),
  )
}

function videoScriptAnalysisOutput(row: any) {
  return firstValue(
    value(row, 'payload.videoScriptAnalysisOutput'),
    value(row, 'payload.videoScriptAnalysisResult'),
    value(row, 'payload.scriptAnalysisOutput'),
    value(row, 'payload.scriptAnalysisResult'),
  )
}

function commentUserUrl(row: any) {
  return firstValue(
    value(row, 'comment_payload.authorUrl'),
    value(row, 'comment_payload.userUrl'),
    value(row, 'comment_payload.profileUrl'),
    value(row, 'comment_payload.homepage'),
  )
}

function commentText(row: any) {
  return firstValue(
    row.comments_text,
    value(row, 'payload.commentsMergedText'),
    value(row, 'payload.commentContent'),
    value(row, 'payload.commentText'),
  )
}

function commentAnalysis(row: any) {
  return firstValue(
    value(row, 'payload.commentAnalysis'),
    value(row, 'payload.commentsAnalysis'),
    value(row, 'payload.commentAnalysisPrompt'),
  )
}

function commentAnalysisOutput(row: any) {
  return firstValue(
    value(row, 'payload.commentAnalysisOutput'),
    value(row, 'payload.commentAnalysisResult'),
    value(row, 'payload.commentsAnalysisOutput'),
    value(row, 'payload.commentsAnalysisResult'),
  )
}

function rewriteInput(row: any) {
  return firstValue(
    value(row, 'payload.rewrite'),
    value(row, 'payload.rewriteInput'),
    value(row, 'payload.rewritePrompt'),
    value(row, 'payload.contentRewrite'),
  )
}

function rewriteOutput(row: any) {
  return firstValue(
    value(row, 'payload.rewriteOutput'),
    value(row, 'payload.rewriteResult'),
    value(row, 'payload.contentRewriteOutput'),
    value(row, 'payload.contentRewriteResult'),
  )
}

function noteEditedAt(row: any) {
  return firstValue(
    row.publish_time,
    value(row, 'payload.lastEditedAt'),
    value(row, 'payload.lastEditTime'),
    value(row, 'payload.updatedAt'),
    value(row, 'payload.publishTime'),
    value(row, 'payload.publishDate'),
  )
}

function noteTypeLabel(row: any) {
  const type = String(firstValue(row.note_type, value(row, 'payload.noteType'), value(row, 'payload.mediaType')) || '').toLowerCase()
  if (type === 'image' || type === '图文') return '图文'
  if (type === 'video' || type === '视频') return '视频'
  if (type === 'live') return '直播'
  return type || '-'
}

function interaction(row: any) {
  return Number(row.likes || 0) + Number(row.comments_count || 0) + Number(row.collects || 0) + Number(row.shares || 0)
}

function noteRating(row: any) {
  const total = interaction(row)
  if (total >= 10000) return { label: '爆款', tone: 'urgent' }
  if (total >= 1000) return { label: '潜力', tone: 'high' }
  if (total >= 100) return { label: '普通', tone: 'normal' }
  return { label: '低价值', tone: 'muted' }
}

function collectRating(row: any) {
  const collects = Number(row.collects || 0)
  if (collects >= 1000) return { label: '高收藏', tone: 'urgent' }
  if (collects >= 100) return { label: '可收藏', tone: 'high' }
  if (collects > 0) return { label: '普通', tone: 'normal' }
  return { label: '未采集', tone: 'muted' }
}

function textCell(value: unknown) {
  const text = String(value ?? '').trim()
  return <span className="block truncate text-sm text-foreground" title={text}>{text || '-'}</span>
}

function dateCell(value: unknown) {
  return textCell(formatTableDate(value))
}

function formatTableDate(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  let date: Date | null = null
  if (/^\d+$/.test(raw)) {
    const number = Number(raw)
    const millis = raw.length >= 12 ? number : number * 1000
    date = new Date(millis)
  } else {
    const parsed = new Date(raw)
    if (!Number.isNaN(parsed.getTime())) date = parsed
  }

  if (!date || Number.isNaN(date.getTime())) return formatDate(raw)
  const year = date.getFullYear()
  if (year < 2000 || year > 2100) return formatDate(raw)

  const pad = (number: number) => String(number).padStart(2, '0')
  return `${year}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function longCell(value: unknown, maxPreviewLength = 160, ctx?: CellRenderContext) {
  const text = String(value ?? '').trim()
  if (!text) return <span className="text-muted-foreground">-</span>
  return (
    <ExpandableText
      value={text}
      maxLines={3}
      maxPreviewLength={maxPreviewLength}
      expanded={Boolean(ctx?.expanded)}
      resetKey={ctx?.resetKey || text}
      onToggle={ctx?.toggle}
    />
  )
}

function ExpandableText({
  value,
  maxLines = 3,
  maxPreviewLength = 160,
  expanded,
  resetKey,
  onToggle,
}: {
  value: string
  maxLines?: number
  maxPreviewLength?: number
  expanded: boolean
  resetKey: string
  onToggle?: () => void
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [localExpanded, setLocalExpanded] = useState(false)
  const isExpanded = localExpanded

  useEffect(() => {
    setLocalExpanded(false)
  }, [resetKey])

  useEffect(() => {
    if (expanded) setLocalExpanded(true)
  }, [expanded])

  useEffect(() => {
    const node = contentRef.current
    if (!node || isExpanded) return

    const measure = () => {
      setHasOverflow(node.scrollHeight > node.clientHeight + 1)
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [value, maxLines, isExpanded])

  const canExpand = Boolean(isExpanded || hasOverflow || value.length > maxPreviewLength)
  const collapsedStyle = isExpanded
    ? undefined
    : {
        display: '-webkit-box',
        WebkitLineClamp: maxLines,
        WebkitBoxOrient: 'vertical' as const,
        overflow: 'hidden',
      }

  const handleToggle = (event?: React.SyntheticEvent) => {
    event?.preventDefault()
    event?.stopPropagation()
    setLocalExpanded(current => !current)
    onToggle?.()
  }

  return (
    <div className="space-y-1.5 text-sm leading-5 text-foreground">
      <div
        ref={contentRef}
        className={isExpanded ? 'whitespace-pre-wrap break-words' : 'break-words'}
        style={collapsedStyle}
        title={isExpanded ? undefined : value}
      >
        {value}
      </div>
      {canExpand && (
        <button
          type="button"
          onPointerDown={handleToggle}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') handleToggle(event)
          }}
          className="text-xs font-medium text-primary hover:underline"
        >
          {isExpanded ? '收起' : '查看全文'}
        </button>
      )}
    </div>
  )
}

function metricCell(value: unknown) {
  return (
    <span className="inline-flex h-7 min-w-12 items-center justify-end rounded-md bg-muted/60 px-2 text-sm tabular-nums text-foreground">
      {formatNumber(value as any)}
    </span>
  )
}

// 这些数据表的记录可能带媒体附件，展示「下载附件」按钮
const MEDIA_TABLES = new Set<TableKey>(['single_notes', 'keyword_notes', 'blogger_notes', 'monitor_content'])

type MediaTask = { url: string; filename: string; kind: 'image' | 'video' | 'audio' }

function sanitizeFilename(name: unknown): string {
  const text = String(name || 'record')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return text || 'record'
}

function extFromUrl(url: string, fallback: string): string {
  const path = String(url || '').split('?')[0]
  const match = path.match(/\.([a-z0-9]{2,5})$/i)
  return match ? `.${match[1].toLowerCase()}` : fallback
}

// 与后端 collectRecordMediaUrls 口径一致：封面 / 多图 / 视频 / 音频
function buildRecordMediaTasks(row: any): MediaTask[] {
  const tasks: MediaTask[] = []
  const seen = new Set<string>()
  const prefix = sanitizeFilename(row?.title || row?.author_name || 'record')
  const push = (url: unknown, filename: string, kind: MediaTask['kind']) => {
    const u = String(url || '').trim()
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) return
    seen.add(u)
    tasks.push({ url: u, filename, kind })
  }

  const cover = primaryImage(row)
  if (cover) push(cover, `${prefix}_cover${extFromUrl(String(cover), '.jpg')}`, 'image')
  imageUrls(row).forEach((url, index) => {
    if (String(url) === String(cover)) return
    push(url, `${prefix}_image_${index + 1}${extFromUrl(String(url), '.jpg')}`, 'image')
  })
  const video = videoUrl(row)
  if (video) push(video, `${prefix}_video${extFromUrl(String(video), '.mp4')}`, 'video')
  const audio = audioUrl(row)
  if (audio) push(audio, `${prefix}_audio${extFromUrl(String(audio), '.m4a')}`, 'audio')

  return tasks
}

function saveBlob(blob: Blob, filename: string) {
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(objUrl), 60000)
}

// 下载附件：逐个走后端透明代理 -> blob -> 保存到操作员本地，不占服务器空间
function AttachmentDownloadCell({ row }: { row: any }) {
  const tasks = useMemo(() => buildRecordMediaTasks(row), [row])
  const [status, setStatus] = useState<'idle' | 'downloading' | 'done' | 'error'>('idle')
  const [msg, setMsg] = useState('')

  if (!tasks.length) return <span className="text-muted-foreground">-</span>

  const handleDownload = async () => {
    if (status === 'downloading' || !row?.id) return
    setStatus('downloading')
    setMsg('')
    const tenant = api.getTenant()
    let ok = 0
    let fail = 0
    let lastError = ''
    for (const task of tasks) {
      try {
        const qs = new URLSearchParams({ url: task.url, filename: task.filename })
        const resp = await fetch(`/api/records/${row.id}/media-proxy?${qs.toString()}`, {
          credentials: 'same-origin',
          headers: tenant ? { 'x-tenant-id': tenant } : {},
        })
        if (!resp.ok) {
          fail += 1
          let detail = ''
          try {
            const data = await resp.json()
            detail = data?.message || data?.error || ''
          } catch {
            detail = resp.statusText
          }
          lastError = `HTTP ${resp.status}${detail ? ' · ' + detail : ''}`
          continue
        }
        saveBlob(await resp.blob(), task.filename)
        ok += 1
      } catch (err: any) {
        fail += 1
        lastError = err?.message ? `请求异常 · ${err.message}` : '请求异常'
      }
    }
    if (fail === 0) {
      setStatus('done')
      setMsg(`已下载 ${ok} 个`)
    } else if (ok === 0) {
      setStatus('error')
      setMsg(`下载失败（${lastError || '未知错误'}）`)
    } else {
      setStatus('error')
      setMsg(`成功 ${ok}，失败 ${fail}（${lastError}）`)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleDownload}
        disabled={status === 'downloading'}
        title="下载封面/图片/视频/音频到本地"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-semibold text-primary transition hover:border-primary/40 hover:bg-primary/5 disabled:opacity-60"
      >
        {status === 'downloading'
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : <Download className="h-3 w-3" />}
        {status === 'downloading' ? '下载中' : `下载附件(${tasks.length})`}
      </button>
      {msg && (
        <span className={`text-[11px] ${status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
          {msg}
        </span>
      )}
    </div>
  )
}

function linkCell(url: unknown, label: string) {
  const href = String(url || '').trim()
  if (!href) return <span className="text-muted-foreground">-</span>
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-semibold text-primary transition hover:border-primary/40 hover:bg-primary/5">
      {label}
      <ExternalLink className="h-3 w-3" />
    </a>
  )
}

function linkListCell(urls: unknown, label: string) {
  const list = asArray(urls).map(urlFromItem).filter(Boolean)
  if (!list.length) return <span className="text-muted-foreground">-</span>
  return (
    <div className="flex flex-wrap gap-1">
      {list.slice(0, 3).map((url, index) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" className="inline-flex h-6 items-center rounded-md border border-border bg-background px-2 text-[11px] font-semibold text-primary transition hover:border-primary/40 hover:bg-primary/5">
          {label}{index + 1}
        </a>
      ))}
      {list.length > 3 && <span className="inline-flex h-6 items-center rounded-md bg-muted px-2 text-[11px] text-muted-foreground">+{list.length - 3}</span>}
    </div>
  )
}

function imageCell(url: unknown, alt: unknown) {
  const src = String(url || '').trim()
  if (!src) {
    return <div className="flex h-11 w-11 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground"><ImageIcon className="h-4 w-4" /></div>
  }
  return <img src={src} alt={String(alt || '')} className="h-11 w-11 rounded-md border border-border object-cover" loading="lazy" />
}

function imagesCell(urls: unknown, alt: unknown) {
  const list = asArray(urls).map(urlFromItem).filter(Boolean)
  if (!list.length) {
    return <div className="flex h-11 w-11 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground"><ImageIcon className="h-4 w-4" /></div>
  }
  return (
    <div className="flex gap-1">
      {list.slice(0, 3).map((url, index) => (
        <img
          key={`${url}-${index}`}
          src={url}
          alt={String(alt || '')}
          className="h-11 w-11 rounded-md border border-border object-cover"
          loading="lazy"
        />
      ))}
    </div>
  )
}

function tagCell(value: unknown) {
  const tags = asArray(value).map(item => String(typeof item === 'object' ? item.name || item.label || item.value || '' : item).replace(/^#/, '').trim()).filter(Boolean)
  if (!tags.length) return <span className="text-muted-foreground">-</span>
  return (
    <div className="flex flex-wrap gap-1">
      {tags.slice(0, 3).map(tag => <StatusBadge key={tag} tone="muted">#{tag}</StatusBadge>)}
      {tags.length > 3 && <span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">+{tags.length - 3}</span>}
    </div>
  )
}

function platformBadge(platform: string) {
  return <StatusBadge tone="neutral">{platformName(platform)}</StatusBadge>
}

function ratingBadge(rating: { label: string; tone: string }) {
  return <StatusBadge tone={rating.tone}>{rating.label}</StatusBadge>
}
