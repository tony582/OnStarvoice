import { useEffect, useState, useCallback } from 'react'
import {
  ChevronLeft, ChevronRight, ExternalLink, Loader2, MessageSquareWarning,
  RefreshCw, Search, CheckCheck, CircleSlash, Footprints,
} from 'lucide-react'
import { api } from '@/lib/api'
import { compact, formatDate, formatNumber, LABELS, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchSelect, WorkbenchTableShell, WorkbenchTabs, WorkbenchToolbar } from '@/components/shared/Workbench'
import { BatchBar, Checkbox, useSelection } from '@/components/shared/BatchBar'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'new', label: '新线索' },
  { value: 'following', label: '跟进中' },
  { value: 'resolved', label: '已处理' },
  { value: 'ignored', label: '已忽略' },
]
const TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'complaint', label: '投诉维权' },
  { value: 'renewal_billing', label: '续费收费' },
  { value: 'app_issue', label: 'App故障' },
  { value: 'service_quality', label: '服务求助' },
  { value: 'safety_privacy', label: '安全隐私' },
  { value: 'brand_risk', label: '品牌风险' },
  { value: 'other', label: '其他跟进' },
]
const PRIORITY_OPTIONS = [
  { value: '', label: '全部优先级' },
  { value: 'urgent', label: '紧急' },
  { value: 'high', label: '高' },
  { value: 'normal', label: '普通' },
  { value: 'low', label: '低' },
]
const PLATFORM_OPTIONS = [
  { value: '', label: '全部平台' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'weibo', label: '微博' },
]

export function LeadsQueue({ initial }: { initial?: Record<string, string> }) {
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const [leads, setLeads] = useState<any[]>([])
  const [pagination, setPagination] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState(initial?.status ?? '')
  const [platform, setPlatform] = useState(initial?.platform ?? '')
  const [leadType, setLeadType] = useState(initial?.leadType ?? '')
  const [priority, setPriority] = useState(initial?.priority ?? '')
  const [keyword, setKeyword] = useState(initial?.keyword ?? '')
  const [batchBusy, setBatchBusy] = useState(false)

  const sel = useSelection(`${status}|${platform}|${leadType}|${priority}|${keyword}|${pagination?.page ?? 1}`)

  const load = useCallback(async (page = 1) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '30' })
      if (status) params.set('status', status)
      if (platform) params.set('platform', platform)
      if (leadType) params.set('leadType', leadType)
      if (priority) params.set('priority', priority)
      if (keyword.trim()) params.set('keyword', keyword.trim())
      const data = await api.get<any>('/leads/comments?' + params.toString())
      setLeads(data.leads || [])
      setPagination(data.pagination || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '评论线索加载失败')
    } finally {
      setLoading(false)
    }
  }, [status, platform, leadType, priority, keyword])

  useEffect(() => { load(1) }, [status, platform, leadType, priority]) // eslint-disable-line react-hooks/exhaustive-deps

  const reloadAfterMutation = useCallback(async () => {
    const page = pagination?.page || 1
    const willEmpty = leads.length <= 1 && page > 1
    await load(willEmpty ? page - 1 : page)
    refreshBadges()
  }, [load, pagination, leads.length, refreshBadges])

  const updateLeadStatus = async (id: string, nextStatus: string) => {
    await api.patch('/leads/comments/' + id, { status: nextStatus })
    await reloadAfterMutation()
  }

  const runBatch = async (nextStatus: string) => {
    if (sel.count === 0) return
    setBatchBusy(true)
    try {
      await api.patch('/leads/comments/batch', { ids: [...sel.selected], status: nextStatus })
      sel.clear()
      await reloadAfterMutation()
    } catch (err) { console.error(err) }
    finally { setBatchBusy(false) }
  }

  const allChecked = leads.length > 0 && leads.every(l => sel.has(l.id))
  const someChecked = leads.some(l => sel.has(l.id))

  return (
    <div className="space-y-3">
      <WorkbenchTabs
        tabs={STATUS_OPTIONS.map(option => ({ key: option.value, label: option.value ? option.label : '全部线索' }))}
        activeKey={status}
        onChange={setStatus}
      />

      <WorkbenchToolbar meta={`${formatNumber(pagination?.total ?? leads.length)} 条评论线索`}>
        <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)}>
          {PLATFORM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </WorkbenchSelect>
        <WorkbenchSelect value={leadType} onChange={e => setLeadType(e.target.value)}>
          {TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </WorkbenchSelect>
        <WorkbenchSelect value={priority} onChange={e => setPriority(e.target.value)}>
          {PRIORITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </WorkbenchSelect>
        <div className="relative min-w-[260px] flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') load(1) }}
            placeholder="搜索标题、评论、用户、IP"
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
        {loading ? (
          <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : !leads.length ? (
          <EmptyState icon={MessageSquareWarning} title="暂无评论线索" description="采集评论并完成判断后，需跟进的评论会沉淀到这里" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1140px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted">
                  {canWrite() && (
                    <th className="w-10 px-4 py-2.5">
                      <Checkbox checked={allChecked} indeterminate={!allChecked && someChecked} onChange={() => sel.setAll(leads.map(l => l.id), !allChecked)} />
                    </th>
                  )}
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">原内容 / 评论</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">用户</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">类型</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">优先级</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">状态</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">采集时间</th>
                  <th className="px-4 py-2.5 text-right text-[12px] font-medium text-muted-foreground">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leads.map(lead => (
                  <tr key={lead.id} className={`align-top transition-colors hover:bg-muted/30 ${sel.has(lead.id) ? 'bg-primary/[0.04]' : ''}`}>
                    {canWrite() && (
                      <td className="px-4 py-3"><Checkbox checked={sel.has(lead.id)} onChange={() => sel.toggle(lead.id)} /></td>
                    )}
                    <td className="max-w-[430px] px-4 py-3">
                      <div className="flex items-center gap-2">
                        <StatusBadge tone="neutral">{platformName(lead.platform)}</StatusBadge>
                        {lead.record_url && (
                          <a href={lead.record_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                            原文 <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      <div className="mt-2 font-medium leading-5">{lead.record_title || '(无标题)'}</div>
                      <div className="mt-1 text-xs leading-5 text-foreground">{lead.comment_content}</div>
                      {Array.isArray(lead.matched_keywords) && lead.matched_keywords.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {lead.matched_keywords.slice(0, 4).map((kw: string) => <StatusBadge key={kw} tone="muted">{kw}</StatusBadge>)}
                        </div>
                      )}
                      {lead.reason && <div className="mt-2 text-xs leading-5 text-muted-foreground">{compact(lead.reason, 90)}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{lead.comment_author_name || '-'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">ID {lead.comment_author_id || '-'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">IP {lead.comment_ip_location || '-'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">赞 {formatNumber(lead.comment_like_count)}</div>
                    </td>
                    <td className="px-4 py-3"><StatusBadge tone="neutral">{LABELS.leadType[lead.lead_type] || lead.lead_type}</StatusBadge></td>
                    <td className="px-4 py-3"><StatusBadge tone={lead.priority}>{LABELS.priority[lead.priority] || lead.priority}</StatusBadge></td>
                    <td className="px-4 py-3"><StatusBadge tone={lead.status}>{LABELS.leadStatus[lead.status] || lead.status}</StatusBadge></td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(lead.captured_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button variant="outline" size="sm" disabled={!canWrite() || lead.status === 'following'} onClick={() => updateLeadStatus(lead.id, 'following')}>跟进</Button>
                        <Button variant="outline" size="sm" disabled={!canWrite() || lead.status === 'resolved'} onClick={() => updateLeadStatus(lead.id, 'resolved')}>处理</Button>
                        <Button variant="ghost" size="sm" disabled={!canWrite() || lead.status === 'ignored'} onClick={() => updateLeadStatus(lead.id, 'ignored')}>忽略</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">共 {formatNumber(pagination.total)} 条线索</span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="px-3 text-sm tabular-nums text-muted-foreground">{pagination.page} / {pagination.totalPages}</span>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
      </WorkbenchTableShell>

      {canWrite() && (
        <BatchBar
          count={sel.count}
          busy={batchBusy}
          onClear={sel.clear}
          onAction={key => runBatch(key)}
          actions={[
            { key: 'following', label: '跟进', icon: Footprints },
            { key: 'resolved', label: '处理', icon: CheckCheck },
            { key: 'ignored', label: '忽略', icon: CircleSlash, tone: 'danger' },
          ]}
        />
      )}
    </div>
  )
}
