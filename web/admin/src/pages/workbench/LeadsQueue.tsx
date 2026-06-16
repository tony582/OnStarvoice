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
import { CommentLeadDrawer } from '@/components/shared/CommentLeadDrawer'
import { useNotePrompt } from '@/components/shared/NotePrompt'
import { useTicketDispatch } from '@/components/shared/TicketDispatch'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'new', label: '新线索' },
  { value: 'following', label: '跟进中' },
  { value: 'resolved', label: '已处理' },
  { value: 'ignored', label: '已忽略' },
]
// 评论分诊与内容分诊同构:两个 MECE 桶。转工单后离开分诊视图(在工单系统里跟踪)。
const OPINION_TABS = [
  { value: 'pending', label: '待处理' },
  { value: 'archived', label: '已归档' },
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

export function LeadsQueue({ initial, category = 'opinion' }: { initial?: Record<string, string>; category?: 'opinion' | 'sales' }) {
  const isSales = category === 'sales'
  const noun = isSales ? '销售客资' : '评论'
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const [leads, setLeads] = useState<any[]>([])
  const [pagination, setPagination] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState(initial?.status ?? (category === 'sales' ? '' : 'pending'))
  const [platform, setPlatform] = useState(initial?.platform ?? '')
  const [leadType, setLeadType] = useState(initial?.leadType ?? '')
  const [priority, setPriority] = useState(initial?.priority ?? '')
  const [keyword, setKeyword] = useState(initial?.keyword ?? '')
  const [batchBusy, setBatchBusy] = useState(false)
  const [drawer, setDrawer] = useState<any>(null)
  const { ask, dialog } = useNotePrompt()
  const { dispatch, dialog: dispatchDialog } = useTicketDispatch()

  const sel = useSelection(`${status}|${platform}|${leadType}|${priority}|${keyword}|${pagination?.page ?? 1}`)

  const load = useCallback(async (page = 1) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '30', category })
      if (isSales) { if (status) params.set('status', status) }
      else params.set('bucket', status || 'pending')
      if (platform) params.set('platform', platform)
      if (leadType && !isSales) params.set('leadType', leadType)
      if (priority) params.set('priority', priority)
      if (keyword.trim()) params.set('keyword', keyword.trim())
      const data = await api.get<any>('/leads/comments?' + params.toString())
      setLeads(data.leads || [])
      setPagination(data.pagination || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : `${noun}加载失败`)
    } finally {
      setLoading(false)
    }
  }, [status, platform, leadType, priority, keyword, category, isSales, noun])

  useEffect(() => { load(1) }, [status, platform, leadType, priority, category]) // eslint-disable-line react-hooks/exhaustive-deps

  const reloadAfterMutation = useCallback(async () => {
    const page = pagination?.page || 1
    const willEmpty = leads.length <= 1 && page > 1
    await load(willEmpty ? page - 1 : page)
    refreshBadges()
  }, [load, pagination, leads.length, refreshBadges])

  const updateLeadStatus = async (id: string, nextStatus: string): Promise<boolean> => {
    const note = await ask({ title: `${noun}处理备注`, placeholder: '例如：已私信用户跟进 / 已转交销售 / 与本品牌无关' })
    if (note === null) return false // 取消则不处理，避免误点即消失
    await api.patch('/leads/comments/' + id, { status: nextStatus, note })
    await reloadAfterMutation()
    return true
  }

  const dispatchTicket = async (lead: any): Promise<boolean> => {
    const r = await dispatch({ summary: lead.comment_content, defaultPriority: lead.priority })
    if (!r) return false
    await api.post('/tickets', { sourceType: 'comment', sourceId: lead.id, priority: r.priority, assigneeUserId: r.assigneeUserId, assigneeName: r.assigneeName, note: r.note })
    await reloadAfterMutation()
    return true
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
        tabs={(isSales ? STATUS_OPTIONS.map(o => ({ key: o.value, label: o.value ? o.label : '全部线索' })) : OPINION_TABS.map(o => ({ key: o.value, label: o.label })))}
        activeKey={status}
        onChange={setStatus}
      />

      <WorkbenchToolbar meta={`${formatNumber(pagination?.total ?? leads.length)} 条${noun}`}>
        <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)}>
          {PLATFORM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </WorkbenchSelect>
        {!isSales && (
          <WorkbenchSelect value={leadType} onChange={e => setLeadType(e.target.value)}>
            {TYPE_OPTIONS.filter(o => o.value !== 'sales_intent').map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </WorkbenchSelect>
        )}
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
          <EmptyState icon={MessageSquareWarning} title={`暂无${noun}`} description={isSales ? '采集评论后，含购买意向/询价/留联系方式的评论会沉淀到这里' : '采集评论并完成判断后，需跟进的负面/风险评论会沉淀到这里'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted">
                  {canWrite() && (
                    <th className="w-10 px-4 py-2.5">
                      <Checkbox checked={allChecked} indeterminate={!allChecked && someChecked} onChange={() => sel.setAll(leads.map(l => l.id), !allChecked)} />
                    </th>
                  )}
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">评论内容</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">用户</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">类型</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">优先级</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">状态</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">时间</th>
                  <th className="px-4 py-2.5 text-right text-[12px] font-medium text-muted-foreground">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leads.map(lead => (
                  <tr key={lead.id} onClick={() => setDrawer(lead)}
                    className={`cursor-pointer transition-colors hover:bg-muted/40 ${drawer?.id === lead.id ? 'bg-accent' : sel.has(lead.id) ? 'bg-primary/[0.04]' : ''}`}>
                    {canWrite() && (
                      <td className="px-4 py-3 align-top" onClick={e => e.stopPropagation()}><Checkbox checked={sel.has(lead.id)} onChange={() => sel.toggle(lead.id)} /></td>
                    )}
                    <td className="max-w-[440px] px-4 py-3 align-top">
                      <div className="line-clamp-2 text-[13px] leading-5 text-foreground">{lead.comment_content || '(无内容)'}</div>
                      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <StatusBadge tone="neutral">{platformName(lead.platform)}</StatusBadge>
                        <span className="truncate">原帖：{compact(lead.record_title || '(无标题)', 26)}</span>
                        {(lead.note || lead.handled_at) && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">已留痕</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top text-xs">
                      <div className="font-medium text-foreground">{lead.comment_author_name || '-'}</div>
                      <div className="mt-0.5 whitespace-nowrap text-muted-foreground">IP {lead.comment_ip_location || '-'} · 赞 {formatNumber(lead.comment_like_count)}</div>
                    </td>
                    <td className="px-4 py-3 align-top"><StatusBadge tone="neutral">{LABELS.leadType[lead.lead_type] || lead.lead_type}</StatusBadge></td>
                    <td className="px-4 py-3 align-top"><StatusBadge tone={lead.priority}>{LABELS.priority[lead.priority] || lead.priority}</StatusBadge></td>
                    <td className="px-4 py-3 align-top"><StatusBadge tone={lead.status}>{LABELS.leadStatus[lead.status] || lead.status}</StatusBadge></td>
                    <td className="whitespace-nowrap px-4 py-3 align-top text-xs text-muted-foreground">{formatDate(lead.captured_at)}</td>
                    <td className="px-4 py-3 align-top" onClick={e => e.stopPropagation()}>
                      <div className="flex justify-end gap-1">
                        {isSales ? <>
                          <Button variant="outline" size="sm" disabled={!canWrite() || lead.status === 'following'} onClick={() => updateLeadStatus(lead.id, 'following')}>跟进</Button>
                          <Button variant="outline" size="sm" disabled={!canWrite() || lead.status === 'resolved'} onClick={() => updateLeadStatus(lead.id, 'resolved')}>处理</Button>
                          <Button variant="ghost" size="sm" disabled={!canWrite() || lead.status === 'ignored'} onClick={() => updateLeadStatus(lead.id, 'ignored')}>忽略</Button>
                        </> : status === 'archived' ? (
                          <span className="text-[11px] text-muted-foreground/60">已归档</span>
                        ) : <>
                          <Button size="sm" disabled={!canWrite()} onClick={() => dispatchTicket(lead)}>转工单</Button>
                          <Button variant="outline" size="sm" disabled={!canWrite()} onClick={() => updateLeadStatus(lead.id, 'resolved')}>归档</Button>
                          <Button variant="ghost" size="sm" disabled={!canWrite()} onClick={() => updateLeadStatus(lead.id, 'ignored')}>忽略</Button>
                        </>}
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
            <span className="text-xs text-muted-foreground">共 {formatNumber(pagination.total)} 条{noun}</span>
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
          actions={isSales ? [
            { key: 'following', label: '跟进', icon: Footprints },
            { key: 'resolved', label: '处理', icon: CheckCheck },
            { key: 'ignored', label: '忽略', icon: CircleSlash, tone: 'danger' },
          ] : [
            { key: 'resolved', label: '归档', icon: CheckCheck },
            { key: 'ignored', label: '忽略', icon: CircleSlash, tone: 'danger' },
          ]}
        />
      )}

      {drawer && (
        <CommentLeadDrawer
          lead={drawer}
          noun={noun}
          canWrite={canWrite()}
          isSales={isSales}
          bucket={isSales ? '' : status}
          onClose={() => setDrawer(null)}
          onSetStatus={async (s) => { if (await updateLeadStatus(drawer.id, s)) setDrawer(null) }}
          onDispatch={async () => { if (await dispatchTicket(drawer)) setDrawer(null) }}
        />
      )}
      {dialog}
      {dispatchDialog}
    </div>
  )
}
