import { useEffect, useState } from 'react'
import {
  ChevronLeft, ChevronRight, ExternalLink, Loader2, Radar, RefreshCw,
} from 'lucide-react'
import { api } from '@/lib/api'
import { compact, formatDate, formatNumber, LABELS, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchSelect, WorkbenchTableShell, WorkbenchTabs, WorkbenchToolbar } from '@/components/shared/Workbench'

const RANGE_OPTIONS = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: 'all', label: '全部' },
]

const PLATFORM_OPTIONS = [
  { value: '', label: '全部平台' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'weibo', label: '微博' },
]

function interaction(row: any) {
  return Number(row.likes || 0) + Number(row.comments_count || 0) + Number(row.collects || 0) + Number(row.shares || 0)
}

export function MonitorHitsTab({ initial }: { initial?: Record<string, string> }) {
  const [hits, setHits] = useState<any[]>([])
  const [subscriptions, setSubscriptions] = useState<any[]>([])
  const [pagination, setPagination] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [range, setRange] = useState(initial?.range ?? '7d')
  const [platform, setPlatform] = useState(initial?.platform ?? '')
  const [subscriptionId, setSubscriptionId] = useState(initial?.subscriptionId ?? '')

  const loadSubscriptions = async () => {
    try {
      const data = await api.get<any>('/monitor/subscriptions')
      setSubscriptions(data.subscriptions || data.data?.items || [])
    } catch {
      setSubscriptions([])
    }
  }

  const load = async (page = 1) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '30', range })
      if (platform) params.set('platform', platform)
      if (subscriptionId) params.set('subscriptionId', subscriptionId)
      const data = await api.get<any>('/monitor/hits?' + params.toString())
      setHits(data.hits || [])
      setPagination(data.pagination || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '监控命中加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadSubscriptions() }, [])
  useEffect(() => { load(1) }, [range, platform, subscriptionId])

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-300">
      <WorkbenchTabs
        tabs={RANGE_OPTIONS.map(option => ({ key: option.value, label: option.label }))}
        activeKey={range}
        onChange={setRange}
      />

      <WorkbenchToolbar meta={`${formatNumber(pagination?.total ?? hits.length)} 条监控命中`}>
        <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)}>
          {PLATFORM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </WorkbenchSelect>
        <WorkbenchSelect value={subscriptionId} onChange={e => setSubscriptionId(e.target.value)} className="min-w-[180px]">
          <option value="">全部监控项</option>
          {subscriptions.map(sub => (
            <option key={sub.id} value={sub.id}>
              {sub.name || sub.keyword || sub.platformBloggerId || sub.id}
            </option>
          ))}
        </WorkbenchSelect>
        <Button variant="outline" size="sm" onClick={() => load(pagination?.page || 1)} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </WorkbenchToolbar>

      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      <WorkbenchTableShell>
        {loading ? (
          <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : !hits.length ? (
          <EmptyState icon={Radar} title="暂无监控命中" description="执行账号或关键词监控后，命中的内容会出现在这里" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1020px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted">
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">命中内容</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">监控项</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">作者</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">互动</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">状态</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">命中时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {hits.map(hit => (
                  <tr key={hit.observation_id} className="align-top transition-colors hover:bg-muted/30">
                    <td className="max-w-[410px] px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge tone="neutral">{platformName(hit.platform)}</StatusBadge>
                        <StatusBadge tone="muted">{LABELS.recordType[hit.record_type] || hit.record_type || '内容'}</StatusBadge>
                        {hit.url && (
                          <a href={hit.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                            原文 <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      <div className="mt-2 font-medium leading-5">{hit.title || compact(hit.content || '', 80) || '(无标题)'}</div>
                      {hit.content && <div className="mt-1 text-xs leading-5 text-muted-foreground">{compact(hit.content, 120)}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{hit.monitor_name || hit.monitor_keyword || hit.observation_keyword || '-'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">命中词 {hit.observation_keyword || hit.monitor_keyword || '-'}</div>
                      {hit.rank_position && <div className="mt-1 text-xs text-muted-foreground">排名 {hit.rank_position}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{hit.author_name || '-'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">粉丝 {formatNumber(hit.author_fans)}</div>
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      <div className="font-semibold">{formatNumber(interaction(hit))}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        赞 {formatNumber(hit.likes)} / 评 {formatNumber(hit.comments_count)} / 藏 {formatNumber(hit.collects)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {hit.is_new_record && <StatusBadge tone="active">新入库</StatusBadge>}
                        <StatusBadge tone={hit.sentiment || 'muted'}>{LABELS.sentiment[hit.sentiment] || '待标注'}</StatusBadge>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(hit.captured_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">共 {formatNumber(pagination.total)} 条命中</span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="px-3 text-sm tabular-nums text-muted-foreground">{pagination.page} / {pagination.totalPages}</span>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
      </WorkbenchTableShell>
    </div>
  )
}
