import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Loader2, MessageCircle, Send,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { CloudAgent } from './lib'
import { PLATFORM_LABELS, agentCreatePlatforms, agentTaskTypeBlockReason } from './lib'

type OfficialAccount = {
  id: string
  platform: string
  accountName?: string
  name?: string
  profileUrl?: string
}

type AccountResponse = {
  accounts?: OfficialAccount[]
  items?: OfficialAccount[]
  data?: { accounts?: OfficialAccount[]; items?: OfficialAccount[] }
}

function accountLabel(account?: OfficialAccount) {
  return account?.accountName || account?.name || '未命名官方账号'
}

export function OfficialCommentPatrolTaskCreator({
  agent,
  writable,
  onCreated,
  initialOfficialAccountId = '',
}: {
  agent: CloudAgent
  writable: boolean
  onCreated: () => Promise<void>
  initialOfficialAccountId?: string
}) {
  const [accounts, setAccounts] = useState<OfficialAccount[]>([])
  const [accountsLoading, setAccountsLoading] = useState(true)
  const [accountError, setAccountError] = useState('')
  const [accountId, setAccountId] = useState('')
  const [postsLimit, setPostsLimit] = useState<number | ''>('')
  const [commentsLimit, setCommentsLimit] = useState<number | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const pendingSubmission = useRef<{ fingerprint: string; requestKey: string } | null>(null)
  const availablePlatforms = useMemo(() => agentCreatePlatforms(agent), [agent])
  const compatibleAccounts = useMemo(
    () => accounts.filter(account => availablePlatforms.includes(account.platform)),
    [accounts, availablePlatforms],
  )
  const selectedAccount =
    compatibleAccounts.find(account => account.id === accountId) ||
    compatibleAccounts.find(account => account.id === initialOfficialAccountId) ||
    compatibleAccounts[0]
  const selectedPlatform = String(selectedAccount?.platform || '').trim()
  const platformCompatible = Boolean(selectedPlatform && availablePlatforms.includes(selectedPlatform))
  const profileReady = Boolean(String(selectedAccount?.profileUrl || '').trim())
  const commentPatrolBlockReason = agentTaskTypeBlockReason(agent, 'comment_patrol', 'one_time')
  const commentPatrolSupported = !commentPatrolBlockReason
  const compatible = platformCompatible && profileReady && commentPatrolSupported

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true)
    setAccountError('')
    try {
      const response = await api.get<AccountResponse>('/capture-cloud/official-comment-patrol/accounts?range=7d')
      const rows = response.accounts || response.items || response.data?.accounts || response.data?.items || []
      const normalized = rows
        .filter(item => item && typeof item.id === 'string' && String(item.platform || '').trim())
        .map(item => ({ ...item, platform: String(item.platform).trim().toLowerCase() }))
      setAccounts(normalized)
    } catch (requestError) {
      setAccounts([])
      setAccountError(requestError instanceof Error ? requestError.message : '读取官方账号失败')
    } finally {
      setAccountsLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void loadAccounts()
    })
    return () => { active = false }
  }, [loadAccounts])

  const resetSubmission = () => {
    setError('')
    setFeedback('')
    pendingSubmission.current = null
  }

  const validate = () => {
    if (!selectedAccount) return '请先选择一个官方账号。'
    if (!platformCompatible) return `当前 Agent 不负责${PLATFORM_LABELS[selectedPlatform] || selectedPlatform}，请返回选择兼容节点。`
    if (!profileReady) return '该官方账号还没有可用的主页链接，请先补全官方账号资料。'
    if (!commentPatrolSupported) return commentPatrolBlockReason
    if (typeof postsLimit !== 'number' || !Number.isSafeInteger(postsLimit) || postsLimit < 1 || postsLimit > 100) return '请填写 1–100 的最近作品数量。'
    if (typeof commentsLimit !== 'number' || !Number.isSafeInteger(commentsLimit) || commentsLimit < 1) return '请填写大于 0 的每篇评论采集数量。'
    return ''
  }

  const submit = async () => {
    setError('')
    setFeedback('')
    const validationError = validate()
    if (validationError) return setError(validationError)

    const taskInput = {
      officialAccountId: selectedAccount?.id,
      platform: selectedPlatform,
      postsLimit,
      commentsLimit,
      agentId: agent.id,
      title: `${accountLabel(selectedAccount)}评论巡查`,
    }
    const fingerprint = JSON.stringify(taskInput)
    let submission = pendingSubmission.current
    if (submission?.fingerprint !== fingerprint) {
      submission = { fingerprint, requestKey: window.crypto.randomUUID() }
      pendingSubmission.current = submission
    }

    setSubmitting(true)
    try {
      const result = await api.post<{ message?: string }>('/capture-cloud/official-comment-patrol/tasks', {
        ...taskInput,
        requestKey: submission.requestKey,
      }, { timeoutMs: 30_000 })
      pendingSubmission.current = null
      setFeedback(result.message || (agent.online
        ? `已向 ${agent.display_name} 下发 ${accountLabel(selectedAccount)}的账号主页评论巡查。`
        : `已创建 ${accountLabel(selectedAccount)}的账号主页评论巡查，Agent 上线后自动领取。`))
      await onCreated()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '创建评论巡查任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  const disabled = !writable || agent.status !== 'active' || submitting || accountsLoading

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-border bg-background">
        <div className="border-l-4 border-l-primary px-4 py-4 sm:px-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><MessageCircle className="h-5 w-5" /></span>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-foreground">巡查官方账号主页与近期评论</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Agent 会从账号主页按最新顺序读取你指定数量的作品，无需选择日期或逐篇勾选。</p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 border-t border-border/70 p-4 sm:grid-cols-2 sm:p-5">
          <label className="block text-xs font-medium text-muted-foreground sm:col-span-2">
            官方账号 <span className="text-status-red">*</span>
            <select value={selectedAccount?.id || ''} onChange={event => { setAccountId(event.target.value); resetSubmission() }} disabled={disabled || compatibleAccounts.length === 0}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60">
              {compatibleAccounts.length === 0 ? <option value="">{availablePlatforms.length === 1
                ? `当前 Agent 暂无可巡查的${PLATFORM_LABELS[availablePlatforms[0]] || availablePlatforms[0]}官方账号`
                : availablePlatforms.length === 0
                  ? '当前 Agent 未配置可执行平台'
                  : '当前 Agent 暂无兼容的官方账号'}</option> : compatibleAccounts.map(account => (
                <option key={account.id} value={account.id}>{PLATFORM_LABELS[account.platform] || account.platform} · {accountLabel(account)}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-muted-foreground sm:col-span-2">
            作品加载数量 <span className="text-status-red">*</span>
            <input type="number" min={1} max={100} step={1} value={postsLimit} placeholder="例如 20 或 30"
              onChange={event => { setPostsLimit(event.target.value === '' ? '' : Number(event.target.value)); resetSubmission() }} disabled={disabled}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">数量由本次任务明确指定，最多 100 篇；新作品会入库，已存在作品也会重新读取评论并补充更新。</p>
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            每篇评论采集数量 <span className="text-status-red">*</span>
            <input type="number" min={1} step={1} value={commentsLimit} placeholder="例如 500 或 1000"
              onChange={event => { setCommentsLimit(event.target.value === '' ? '' : Number(event.target.value)); resetSubmission() }} disabled={disabled}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">不设 100 条固定上限；实际会在平台评论已加载完、长时间无新增或达到安全时限时结束。</p>
          </label>
        </div>

        <div className="border-t border-border/70 bg-muted/25 px-4 py-3 sm:px-5">
          <p className={`text-[11px] leading-4 ${selectedPlatform && !compatible ? 'text-status-red' : 'text-muted-foreground'}`}>{selectedPlatform
            ? !platformCompatible
              ? `${PLATFORM_LABELS[selectedPlatform] || selectedPlatform} · 当前节点不兼容`
              : !profileReady
                ? '该官方账号尚未配置主页链接，请先补全账号资料。'
              : !commentPatrolSupported
                ? commentPatrolBlockReason
                : `${PLATFORM_LABELS[selectedPlatform] || selectedPlatform} · 将从账号主页读取作品并巡查评论`
            : '请选择账号后继续'}</p>
        </div>
      </section>

      {accountsLoading && <div className="flex items-center justify-center gap-2 py-5 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取可巡查官方账号</div>}
      {accountError && <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-xs leading-5 text-status-red"><div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{accountError}</span></div><Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => void loadAccounts()}>重新读取</Button></div>}

      {error && <p role="alert" className="text-xs leading-5 text-status-red">{error}</p>}
      {feedback && <p role="status" className="text-xs leading-5 text-status-green">{feedback}</p>}

      <Button type="button" onClick={submit} disabled={disabled || !compatible} className="min-h-11 w-full">
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {agent.online ? '创建并下发账号评论巡查' : '创建账号评论巡查并排队'}
      </Button>
    </div>
  )
}
