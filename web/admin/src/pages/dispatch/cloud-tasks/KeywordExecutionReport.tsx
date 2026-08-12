import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Check,
  CheckCircle2,
  Circle,
  Database,
  Loader2,
  Search,
  Sparkles,
  Wifi,
  WifiOff,
} from 'lucide-react'
import type {
  OrchestrationAttemptRecord,
  OrchestrationCloudAgent,
  OrchestrationExecutionRecord,
  OrchestrationItemRecord,
} from './types'
import { STATUS_LABELS, formatTime } from './lib'

type Props = {
  items: OrchestrationItemRecord[]
  executions: OrchestrationExecutionRecord[]
  agents: OrchestrationCloudAgent[]
  attempts: OrchestrationAttemptRecord[]
}

type StageKey = 'waiting' | 'search' | 'list' | 'enhancement' | 'sync' | 'completed' | 'failed'

type KeywordProgress = {
  item: OrchestrationItemRecord
  execution?: OrchestrationExecutionRecord
  agent?: OrchestrationCloudAgent
  keyword: string
  status: string
  stage: StageKey
  stageLabel: string
  batchCurrent: number
  batchTotal: number
  itemCurrent: number | null
  itemTotal: number | null
  searchCount: number | null
  enhancedCount: number | null
  savedCount: number | null
  updatedAt: string | null
  message: string
}

const ACTIVE_STATUSES = new Set([
  'assigned', 'dispatch_pending', 'dispatched', 'waiting_device', 'claimed',
  'running', 'recovering', 'resume_requested',
])

const DONE_STATUSES = new Set(['completed', 'completed_with_warnings'])

const FAILURE_STATUSES = new Set(['retryable', 'needs_action', 'failed', 'interrupted', 'completed_with_failures'])

const STAGE_ORDER: Array<{ key: Exclude<StageKey, 'waiting' | 'completed' | 'failed'>; label: string }> = [
  { key: 'search', label: '搜索' },
  { key: 'list', label: '列表采集' },
  { key: 'enhancement', label: '增强' },
  { key: 'sync', label: '保存' },
]

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return null
}

function maxFinite(...values: unknown[]): number | null {
  const numbers = values
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value >= 0)
  return numbers.length > 0 ? Math.max(...numbers) : null
}

function keywordForItem(item: OrchestrationItemRecord) {
  const metadataKeyword = item.metadata?.keyword
  return String(item.keyword || metadataKeyword || item.item_key || '未命名关键词').trim()
}

function executionTaskId(execution: OrchestrationExecutionRecord) {
  return String(execution.taskId || execution.task_id || execution.id || '')
}

function executionItemIds(execution: OrchestrationExecutionRecord) {
  const ids = execution.itemIds || execution.item_ids
  return Array.isArray(ids) ? ids.map(String) : []
}

function executionAgentId(execution?: OrchestrationExecutionRecord) {
  return String(execution?.agentId || execution?.agent_id || execution?.assigned_agent_id || '')
}

function executionAgent(execution?: OrchestrationExecutionRecord): OrchestrationCloudAgent | undefined {
  const id = executionAgentId(execution)
  const displayName = String(execution?.agent_display_name || '').trim()
  if (!id || !displayName) return undefined
  return {
    id,
    display_name: displayName,
    host_label: String(execution?.agent_host_label || ''),
    browser_name: String(execution?.agent_browser_name || ''),
    operating_system: String(execution?.agent_operating_system || ''),
    app_version: String(execution?.agent_app_version || ''),
    allowed_platforms: [],
    status: execution?.agent_status === 'paused' ? 'paused' : 'active',
    last_heartbeat_at: execution?.agent_last_heartbeat_at || null,
    online: execution?.agent_online === true || execution?.agentOnline === true,
  }
}

function attemptItemId(attempt: OrchestrationAttemptRecord) {
  return String(attempt.itemId || attempt.item_id || '')
}

function itemAgentId(
  item: OrchestrationItemRecord,
  execution: OrchestrationExecutionRecord | undefined,
  attempts: OrchestrationAttemptRecord[],
) {
  // The execution is the authoritative live owner. This also keeps a retried
  // or handed-off keyword on the Agent that is actually reporting progress.
  if (execution) return executionAgentId(execution)
  const latestAttempt = attempts
    .filter(attempt => attemptItemId(attempt) === item.id)
    .sort((left, right) => Number(right.attempt_number || 0) - Number(left.attempt_number || 0))[0]
  return String(
    item.assigned_agent_id
      || latestAttempt?.agentId
      || latestAttempt?.agent_id
      || '',
  )
}

function attemptAgent(
  item: OrchestrationItemRecord,
  attempts: OrchestrationAttemptRecord[],
  agentId: string,
): OrchestrationCloudAgent | undefined {
  const latestAttempt = attempts
    .filter(attempt => attemptItemId(attempt) === item.id)
    .sort((left, right) => Number(right.attempt_number || 0) - Number(left.attempt_number || 0))[0]
  const name = String(
    latestAttempt?.agent_display_name
      || latestAttempt?.agentDisplayName
      || '',
  ).trim()
  if (!agentId || !name) return undefined
  return {
    id: agentId,
    display_name: name,
    host_label: '',
    browser_name: '',
    operating_system: '',
    app_version: '',
    allowed_platforms: [],
    status: 'paused',
    online: false,
  }
}

function agentName(agent?: OrchestrationCloudAgent) {
  if (!agent) return '等待分配 Agent'
  return agent.display_name || `${agent.host_label || '未命名设备'} · ${agent.browser_name || '浏览器'}`
}

function progressStage(phaseValue: unknown, status: string): { stage: StageKey; label: string } {
  if (DONE_STATUSES.has(status)) return { stage: 'completed', label: '已完成' }
  if (FAILURE_STATUSES.has(status)) return { stage: 'failed', label: STATUS_LABELS[status] || '执行异常' }

  const phase = String(phaseValue || '').toLowerCase()
  if (/sync|sav|persist|upload/u.test(phase)) return { stage: 'sync', label: '正在保存结果' }
  if (/detail|enhanc|comment|blogger|profile/u.test(phase)) return { stage: 'enhancement', label: '正在增强采集' }
  if (/list|collect|scroll|extract/u.test(phase)) return { stage: 'list', label: '正在采集列表' }
  if (/search|open|filter/u.test(phase)) return { stage: 'search', label: '正在搜索' }
  if (ACTIVE_STATUSES.has(status)) return { stage: 'search', label: '准备搜索' }
  return { stage: 'waiting', label: STATUS_LABELS[status] || '等待执行' }
}

function statusTone(status: string) {
  if (FAILURE_STATUSES.has(status)) return 'border-status-red/25 bg-status-red/8 text-status-red'
  if (DONE_STATUSES.has(status)) return 'border-status-green/25 bg-status-green/8 text-status-green'
  if (ACTIVE_STATUSES.has(status)) return 'border-primary/25 bg-primary/8 text-primary'
  return 'border-border bg-muted text-muted-foreground'
}

function countLabel(value: number | null, suffix = '条') {
  return value === null ? '—' : `${value} ${suffix}`
}

function buildKeywordProgress(
  item: OrchestrationItemRecord,
  index: number,
  total: number,
  executions: OrchestrationExecutionRecord[],
  agentsById: Map<string, OrchestrationCloudAgent>,
  attempts: OrchestrationAttemptRecord[],
): KeywordProgress {
  const execution = item.execution_task_id
    ? executions.find(candidate => executionTaskId(candidate) === item.execution_task_id)
    : executions.find(candidate => executionItemIds(candidate).includes(item.id))
  const keyword = keywordForItem(item)
  const executionProgress = objectValue(execution?.progress)
  const executionCheckpoint = objectValue(execution?.checkpoint)
  const reportedKeyword = String(executionProgress.keyword || executionCheckpoint.keyword || '').trim()
  const executionItemCount = execution ? executionItemIds(execution).length : 0
  const ownsLiveProgress = reportedKeyword
    ? reportedKeyword === keyword
    : executionItemCount <= 1
  // One child execution can own many keywords. Its progress only describes
  // the current keyword, so never project those live counters onto siblings.
  const progress = ownsLiveProgress ? executionProgress : {}
  const checkpoint = ownsLiveProgress ? executionCheckpoint : {}
  const metadataCheckpoint = objectValue(item.metadata?.checkpoint)
  const status = String(item.status || execution?.status || 'pending')
  const { stage, label } = progressStage(progress.phase || checkpoint.phase, status)
  const itemCurrent = finiteNumber(progress.itemCurrent, progress.item_current)
  const itemTotal = maxFinite(
    progress.itemTotal,
    progress.item_total,
    progress.detectedCount,
    progress.collectedCount,
  )
  const inferredCompleted = itemCurrent === null ? null : Math.max(0, itemCurrent - (stage === 'enhancement' ? 1 : 0))
  const enhancedCount = maxFinite(
    progress.detailSuccessCount,
    progress.detail_success_count,
    stage === 'enhancement' ? inferredCompleted : null,
  )
  const searchCount = maxFinite(
    progress.detectedCount,
    progress.markedCount,
    progress.collectedCount,
    itemTotal,
  )
  const savedCount = maxFinite(
    progress.syncSuccessCount,
    progress.sync_success_count,
    progress.savedCount,
    checkpoint.savedCount,
    metadataCheckpoint.savedCount,
    item.metadata?.savedCount,
  )
  const agentId = itemAgentId(item, execution, attempts)
  // Execution rows retain the historical Agent identity even when that Agent
  // is no longer part of the current eligible pool returned in `agents`.
  const agent = agentsById.get(agentId)
    || executionAgent(execution)
    || attemptAgent(item, attempts, agentId)
  const message = String(
    progress.message
      || execution?.message
      || objectValue(item.error).message
      || '',
  ).trim()

  return {
    item,
    execution,
    agent,
    keyword,
    status,
    stage,
    stageLabel: label,
    batchCurrent: Number.isFinite(Number(item.ordinal)) ? Number(item.ordinal) + 1 : index + 1,
    batchTotal: total,
    itemCurrent,
    itemTotal,
    searchCount,
    enhancedCount,
    savedCount,
    updatedAt: String(progress.updatedAt || progress.updated_at || execution?.updated_at || item.updated_at || '') || null,
    message,
  }
}

function StageRail({ progress }: { progress: KeywordProgress }) {
  const activeIndex = STAGE_ORDER.findIndex(stage => stage.key === progress.stage)
  const terminalDone = progress.stage === 'completed'
  return (
    <ol className="grid grid-cols-4 gap-1" aria-label="当前关键词执行阶段">
      {STAGE_ORDER.map((stage, index) => {
        const completed = terminalDone || activeIndex > index
        const active = activeIndex === index
        return (
          <li key={stage.key} className="min-w-0">
            <div className="mb-2 flex items-center">
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                completed
                  ? 'border-status-green bg-status-green text-white'
                  : active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground'
              }`}>
                {completed ? <Check className="h-3.5 w-3.5" /> : active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Circle className="h-2.5 w-2.5" />}
              </span>
              {index < STAGE_ORDER.length - 1 && (
                <span className={`h-px min-w-2 flex-1 ${completed ? 'bg-status-green/55' : 'bg-border'}`} />
              )}
            </div>
            <span className={`block truncate text-[10px] font-medium ${active ? 'text-primary' : completed ? 'text-status-green' : 'text-muted-foreground'}`}>
              {stage.label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function KeywordExecutionReport({ items, executions, agents, attempts }: Props) {
  const [selectedItemId, setSelectedItemId] = useState('')
  const [query, setQuery] = useState('')
  const [agentFilter, setAgentFilter] = useState('all')
  const listRef = useRef<HTMLDivElement | null>(null)
  const alignedActiveItemRef = useRef('')
  const agentsById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents])
  const progressItems = useMemo(
    () => items.map((item, index) => buildKeywordProgress(item, index, items.length, executions, agentsById, attempts)),
    [agentsById, attempts, executions, items],
  )
  const activeItem = progressItems.find(item => ACTIVE_STATUSES.has(item.status))
  const selected = progressItems.find(item => item.item.id === selectedItemId) || activeItem || progressItems[0]
  const filteredItems = progressItems.filter(item => {
    const matchesQuery = !query.trim() || item.keyword.toLowerCase().includes(query.trim().toLowerCase())
    const matchesAgent = agentFilter === 'all' || item.agent?.id === agentFilter
    return matchesQuery && matchesAgent
  })

  useEffect(() => {
    const activeItemId = activeItem?.item.id || ''
    const list = listRef.current
    if (!activeItemId || !list || alignedActiveItemRef.current === activeItemId) return
    const row = Array.from(list.querySelectorAll<HTMLElement>('[data-keyword-item-id]'))
      .find(element => element.dataset.keywordItemId === activeItemId)
    if (!row) return
    alignedActiveItemRef.current = activeItemId
    list.scrollTop = Math.max(0, row.offsetTop - list.offsetTop - (list.clientHeight - row.clientHeight) / 2)
  }, [activeItem?.item.id, filteredItems.length])

  if (items.length === 0) {
    return (
      <section className="rounded-2xl border border-border/70 bg-card px-4 py-12 text-center text-xs text-muted-foreground">
        服务端尚未返回关键词工作项。
      </section>
    )
  }

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1.28fr)_minmax(340px,0.72fr)]" aria-label="关键词实时执行报告">
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card">
        <header className="border-b border-border/70 px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">Keyword progress</div>
              <h3 className="mt-0.5 text-sm font-bold text-foreground">关键词执行情况</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">按词查看所属 Agent，以及搜索、采集、增强与保存进度。</p>
            </div>
            <span className="self-start rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">{items.length} 个词</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索关键词"
                className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-xs text-foreground outline-none transition-colors focus:border-primary"
              />
            </label>
            <select
              value={agentFilter}
              onChange={event => setAgentFilter(event.target.value)}
              className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-primary"
              aria-label="按 Agent 筛选关键词"
            >
              <option value="all">全部 Agent</option>
              {Array.from(new Map(
                progressItems
                  .filter(progress => progress.agent)
                  .map(progress => [progress.agent!.id, progress.agent!]),
              ).values()).map(agent => (
                <option key={agent.id} value={agent.id}>{agentName(agent)}</option>
              ))}
            </select>
          </div>
        </header>

        <div ref={listRef} className="max-h-[620px] divide-y divide-border/70 overflow-y-auto">
          {filteredItems.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">没有符合筛选条件的关键词。</div>
          ) : filteredItems.map(progress => {
            const isSelected = progress.item.id === selected?.item.id
            const isLive = ACTIVE_STATUSES.has(progress.status)
            return (
              <button
                key={progress.item.id}
                data-keyword-item-id={progress.item.id}
                type="button"
                onClick={() => setSelectedItemId(progress.item.id)}
                className={`grid w-full gap-3 px-4 py-3 text-left transition-colors sm:grid-cols-[38px_minmax(0,1fr)_minmax(210px,0.62fr)] sm:items-center ${
                  isSelected ? 'bg-primary/[0.045]' : 'hover:bg-muted/35'
                }`}
              >
                <span className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold tabular-nums ${isSelected ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  {progress.batchCurrent}
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <strong className="truncate text-sm text-foreground">{progress.keyword}</strong>
                    <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold ${statusTone(progress.status)}`}>
                      {isLive ? progress.stageLabel : STATUS_LABELS[progress.status] || progress.stageLabel}
                    </span>
                  </span>
                  <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Bot className="h-3 w-3 shrink-0" />
                    <span className="truncate">{agentName(progress.agent)}</span>
                    {progress.agent && (
                      <span className={`inline-flex shrink-0 items-center gap-1 ${progress.agent.online ? 'text-status-green' : 'text-muted-foreground'}`}>
                        {progress.agent.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                        {progress.agent.online ? '在线' : '离线'}
                      </span>
                    )}
                  </span>
                </span>
                <span className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                  <span>搜索 <strong className="font-semibold tabular-nums text-foreground">{countLabel(progress.searchCount)}</strong></span>
                  <span>增强 <strong className="font-semibold tabular-nums text-foreground">{countLabel(progress.enhancedCount)}</strong></span>
                  <span>保存 <strong className="font-semibold tabular-nums text-foreground">{countLabel(progress.savedCount)}</strong></span>
                  <span>词内 <strong className="font-semibold tabular-nums text-foreground">{progress.itemCurrent === null || progress.itemTotal === null ? '—' : `${progress.itemCurrent}/${progress.itemTotal}`}</strong></span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {selected && (
        <aside className="self-start overflow-hidden rounded-2xl border border-border/70 bg-card xl:sticky xl:top-4">
          <header className="border-b border-border/70 bg-primary/[0.035] px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">Selected keyword</div>
                <h3 className="mt-1 truncate text-base font-bold text-foreground">{selected.keyword}</h3>
              </div>
              <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold ${statusTone(selected.status)}`}>{selected.stageLabel}</span>
            </div>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              <Bot className="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1 truncate">{agentName(selected.agent)}</span>
              {selected.agent && <span className={selected.agent.online ? 'text-status-green' : ''}>{selected.agent.online ? '在线' : '离线'}</span>}
            </div>
          </header>

          <div className="space-y-4 p-4">
            <StageRail progress={selected} />

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-border/70 bg-muted/25 p-3">
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><Search className="h-3 w-3" />搜索结果</span>
                <strong className="mt-1 block text-lg tabular-nums text-foreground">{countLabel(selected.searchCount)}</strong>
              </div>
              <div className="rounded-xl border border-border/70 bg-muted/25 p-3">
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><Sparkles className="h-3 w-3" />已增强</span>
                <strong className="mt-1 block text-lg tabular-nums text-foreground">{countLabel(selected.enhancedCount)}</strong>
              </div>
              <div className="rounded-xl border border-border/70 bg-muted/25 p-3">
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><Database className="h-3 w-3" />已保存</span>
                <strong className="mt-1 block text-lg tabular-nums text-foreground">{countLabel(selected.savedCount)}</strong>
              </div>
              <div className="rounded-xl border border-border/70 bg-muted/25 p-3">
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><CheckCircle2 className="h-3 w-3" />批次位置</span>
                <strong className="mt-1 block text-lg tabular-nums text-foreground">{selected.batchCurrent}/{selected.batchTotal}</strong>
              </div>
            </div>

            <div className="rounded-xl border border-primary/15 bg-primary/[0.035] p-3">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-semibold text-foreground">词内位置</span>
                <strong className="tabular-nums text-primary">
                  {selected.itemCurrent === null || selected.itemTotal === null ? '尚未进入逐条处理' : `${selected.itemCurrent}/${selected.itemTotal}`}
                </strong>
              </div>
              {selected.itemCurrent !== null && selected.itemTotal !== null && selected.itemTotal > 0 && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary/10">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.min(100, Math.round((selected.itemCurrent / selected.itemTotal) * 100))}%` }} />
                </div>
              )}
            </div>

            <div className="space-y-1 text-[11px] leading-4 text-muted-foreground">
              {selected.message && <p className="rounded-lg bg-muted/35 px-2.5 py-2 text-foreground">{selected.message}</p>}
              <p>最后上报：<strong className="font-medium text-foreground">{formatTime(selected.updatedAt)}</strong></p>
              <p>尝试次数：<strong className="font-medium text-foreground">{Math.max(0, Number(selected.item.attempt_count || 0))}</strong></p>
            </div>
          </div>
        </aside>
      )}
    </section>
  )
}
