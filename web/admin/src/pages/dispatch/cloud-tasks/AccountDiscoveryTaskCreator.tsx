import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Loader2, Play, Radar } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { StatusBadge, StatusDot } from '@/components/ui/badge'
import { platformName } from '@/lib/utils'
import { agentCreatePlatforms, type CloudAgent } from './lib'

type CreatorSubscription = {
  id: string
  name?: string
  platform: string
  keyword?: string
  account_url?: string
  accountUrl?: string
  status?: string
  last_run_at?: string
  lastRunAt?: string
  last_error?: string
  lastError?: string
}

type SubscriptionResponse = {
  subscriptions?: CreatorSubscription[]
}

export function AccountDiscoveryTaskCreator({
  agent,
  writable,
  initialSubscriptionId = '',
  subjectType = 'creator',
  onCreated,
}: {
  agent: CloudAgent
  writable: boolean
  initialSubscriptionId?: string
  subjectType?: 'creator' | 'official'
  onCreated: () => Promise<void> | void
}) {
  const [subscriptions, setSubscriptions] = useState<CreatorSubscription[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSubscriptionId ? [initialSubscriptionId] : [])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const pendingSubmission = useRef<{ fingerprint: string; requestKey: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.get<SubscriptionResponse>(
        `/capture-cloud/followed-creator-patrol/subscriptions?subjectType=${subjectType}`,
      )
      const rows = (result.subscriptions || []).filter(item => item?.id && item.status !== 'deleted')
      setSubscriptions(rows)
      if (!initialSubscriptionId && rows.length === 1) {
        setSelectedIds([rows[0].id])
      } else {
        setSelectedIds(current => current.filter(id => rows.some(row => row.id === id)))
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '读取账号列表失败')
      setSubscriptions([])
    } finally {
      setLoading(false)
    }
  }, [initialSubscriptionId, subjectType])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    return () => {
      active = false
    }
  }, [load])

  const supportedPlatforms = useMemo(() => {
    return new Set(agentCreatePlatforms(agent))
  }, [agent])
  const selectedPlatform = useMemo(() => {
    const selected = subscriptions.find(item => selectedIds.includes(item.id))
    return selected?.platform || ''
  }, [selectedIds, subscriptions])
  const profileScanSupported = subjectType === 'official'
    ? agent.capabilities?.officialAccountPostDiscovery === true
    : agent.capabilities?.followedCreatorPostPatrol === true
  const dispatchableIds = useMemo(() => {
    if (!profileScanSupported) return []
    return selectedIds.filter(id => {
      const subscription = subscriptions.find(item => item.id === id)
      return Boolean(subscription && supportedPlatforms.has(subscription.platform))
    })
  }, [profileScanSupported, selectedIds, subscriptions, supportedPlatforms])

  const toggle = (id: string) => {
    const subscription = subscriptions.find(item => item.id === id)
    if (!subscription) return
    if (
      !selectedIds.includes(id)
      && selectedPlatform
      && subscription.platform !== selectedPlatform
    ) {
      setError('同一个作品发现任务只能选择同一平台账号；请先清空当前选择，再选择其他平台。')
      return
    }
    setSelectedIds(current => current.includes(id)
      ? current.filter(value => value !== id)
      : [...current, id])
    setError('')
    pendingSubmission.current = null
  }

  const createTask = async () => {
    if (dispatchableIds.length === 0) return
    const taskInput = {
      agentId: agent.id,
      subscriptionIds: dispatchableIds,
      subjectType,
      distributionMode: 'fixed_batch' as const,
      recoveryPolicy: {
        allowIdleAgentHandoff: false,
        platformSafetyMode: 'manual_confirmed',
      },
    }
    const fingerprint = JSON.stringify(taskInput)
    let submission = pendingSubmission.current
    if (submission?.fingerprint !== fingerprint) {
      submission = { fingerprint, requestKey: window.crypto.randomUUID() }
      pendingSubmission.current = submission
    }
    setSubmitting(true)
    setError('')
    try {
      await api.post('/capture-cloud/followed-creator-patrol/tasks', {
        ...taskInput,
        requestKey: submission.requestKey,
      }, { timeoutMs: 30_000 })
      pendingSubmission.current = null
      await onCreated()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '创建账号作品发现任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-card p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Radar className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-bold text-foreground">
              {subjectType === 'official' ? '选择要更新作品的官方账号' : '选择要发现新动态的博主'}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {subjectType === 'official'
                ? '任务会先进入调度队列，再由当前 Agent 打开官方账号主页，发现带发布时间的近期作品，为评论巡查准备候选。'
                : '任务会先进入调度队列，再由当前 Agent 打开博主主页、发现近期作品并保存命中。'}
            </p>
          </div>
        </div>
      </section>

      {error && (
        <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-sm text-status-red">
          {error}
        </div>
      )}
      {!profileScanSupported && (
        <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-sm text-status-red">
          当前 Agent 的 Extension 版本尚不支持{subjectType === 'official' ? '官方账号作品发现' : '关注博主作品扫描'}，请先升级后再创建任务。
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : subscriptions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border px-5 py-12 text-center">
          <Radar className="mx-auto h-7 w-7 text-muted-foreground" />
          <div className="mt-3 text-sm font-semibold">{subjectType === 'official' ? '暂无官方账号' : '暂无关注博主'}</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {subjectType === 'official'
              ? '请先在官方账号主页打开 Extension，并选择“登记为官方账号”。'
              : '请先在博主主页打开 Extension，并选择“关注博主”。'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70">
          {subscriptions.map(subscription => {
            const platformConflict = Boolean(
              selectedPlatform
              && !selectedIds.includes(subscription.id)
              && subscription.platform !== selectedPlatform,
            )
            const unsupported = !profileScanSupported
              || !supportedPlatforms.has(subscription.platform)
              || platformConflict
            const selected = !unsupported && selectedIds.includes(subscription.id)
            const accountUrl = subscription.account_url || subscription.accountUrl || ''
            const lastError = String(subscription.last_error || subscription.lastError || '').trim()
            return (
              <label
                key={subscription.id}
                className={`flex gap-3 border-b border-border/60 px-4 py-4 last:border-b-0 ${unsupported ? 'cursor-not-allowed bg-muted/25 opacity-65' : 'cursor-pointer hover:bg-accent/35'}`}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={unsupported}
                  onChange={() => toggle(subscription.id)}
                  className="mt-1 h-4 w-4 rounded border-border accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone="neutral">{platformName(subscription.platform)}</StatusBadge>
                    {lastError
                      ? <StatusDot tone="negative">上次扫描异常</StatusDot>
                      : <StatusDot tone={subscription.status === 'active' ? 'active' : 'muted'}>
                        {subscription.status === 'active' ? '已启用' : '已暂停'}
                      </StatusDot>}
                    {unsupported && (
                      <StatusBadge tone="negative">
                        {!profileScanSupported
                          ? '当前 Agent 版本不支持'
                          : platformConflict
                            ? '请另建该平台任务'
                            : '当前 Agent 不负责此平台'}
                      </StatusBadge>
                    )}
                  </div>
                  <div className="mt-2 flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-bold text-foreground">
                      {subscription.name || (subjectType === 'official' ? '未命名官方账号' : '未命名博主')}
                    </span>
                    {accountUrl && (
                      <a
                        href={accountUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={event => event.stopPropagation()}
                        className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
                      >
                        主页 <ArrowUpRight className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{subscription.keyword || '未记录账号标识'}</div>
                  {lastError && <div className="mt-2 line-clamp-2 text-xs leading-5 text-status-red">{lastError}</div>}
                </div>
              </label>
            )
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-muted/25 px-4 py-3">
        <div className="text-xs text-muted-foreground">
          已选择 <span className="font-bold text-foreground">{dispatchableIds.length}</span> 个{subjectType === 'official' ? '官方账号' : '博主'}
        </div>
        <Button onClick={() => void createTask()} disabled={!writable || !profileScanSupported || submitting || dispatchableIds.length === 0}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {submitting ? '正在创建' : subjectType === 'official' ? '创建作品发现任务' : '创建扫描任务'}
        </Button>
      </div>
    </div>
  )
}
