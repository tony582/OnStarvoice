import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Send } from 'lucide-react'
import { api, ApiResponseError, isApiNetworkError } from '@/lib/api'
import { useAuth } from '@/lib/auth'

// 接收人按租户配置；每人一条任务，手机依次发送，每条只尝试一次。
type WechatForward = {
  id: string
  recipient: string
  status: string
  reason: string
  errorCode: string
  requestedBy?: string
  createdAt: string
}
type ForwardsResponse = { forwards: WechatForward[]; recipients: string[] }

const STORAGE_KEY = 'osv_wechat_forward_recipients'
const STATUS_TEXT: Record<string, string> = {
  pending: '排队中',
  running: '正在发送',
  completed: '已发送',
  completed_with_warnings: '已点发送，未看到「已发送」提示，请在微信里确认',
  failed: '发送失败',
  canceled: '已取消',
}
const FAILURE_TEXT: Record<string, string> = {
  forward_recipient_not_found: '采集手机的微信里没有找到这个名字',
  forward_confirm_unverified: '发送确认页上的接收人对不上，已取消',
  forward_post_unavailable: '原帖已不可访问',
  forward_post_mismatch: '原文链接对应的已不是这条帖子',
  forward_picker_unverified: '没有打开选择聊天页面',
  share_sheet_unverified: '没有打开转发菜单',
  RECORD_SHARE_LINK_MISSING: '这条内容没有视频号原文链接',
}
const REQUEST_ERRORS: Record<string, string> = {
  NO_WECHAT_PHONE: '这个租户还没有开通视频号的采集手机',
  RECORD_SHARE_LINK_MISSING: '这条内容没有视频号原文链接',
  RECORD_NOT_WECHAT_CHANNELS: '只有视频号内容可以发到微信',
  FORWARD_RECIPIENTS_NOT_CONFIGURED: '还没有配置接收人',
  FORWARD_RECIPIENT_NOT_ALLOWED: '接收人名单已更新，请重新选择',
  INVALID_FORWARD_RECIPIENT: '请至少选择一个接收人',
  android_discovery_not_enabled: '这个租户没有开通手机采集',
}

function describe(forward: WechatForward) {
  const base = STATUS_TEXT[forward.status] || forward.status
  if (forward.status !== 'failed') return base
  const why = FAILURE_TEXT[forward.reason] || FAILURE_TEXT[forward.errorCode] || forward.reason || forward.errorCode
  return why ? `${base}：${why}` : base
}

function rememberedChoice(storageKey: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function WechatForwardAction({ recordId, canWrite }: { recordId: string; canWrite: boolean }) {
  const { tenantId, user } = useAuth()
  return <WechatForwardContent key={`${tenantId}:${recordId}`} recordId={recordId} canWrite={canWrite}
    storageKey={`${STORAGE_KEY}:${tenantId}:${user?.id || ''}`} />
}

function WechatForwardContent({ recordId, canWrite, storageKey }: { recordId: string; canWrite: boolean; storageKey: string }) {
  const [forwards, setForwards] = useState<WechatForward[]>([])
  const [recipients, setRecipients] = useState<string[]>([])
  const [editing, setEditing] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const fetchForwards = useCallback(() => api.get<ForwardsResponse>(
    `/capture-cloud/android/wechat-forwards?recordId=${encodeURIComponent(recordId)}`), [recordId])
  const apply = useCallback((result: ForwardsResponse) => {
    setForwards(Array.isArray(result.forwards) ? result.forwards : [])
    setRecipients(Array.isArray(result.recipients) ? result.recipients : [])
    setLoadError('')
  }, [])

  useEffect(() => {
    let current = true
    void fetchForwards().then(result => { if (current) apply(result) }, () => {
      if (current) setLoadError('暂时无法读取接收人和发送状态')
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [fetchForwards, apply])

  const waiting = forwards.some(forward => forward.status === 'pending' || forward.status === 'running')
  useEffect(() => {
    if (!waiting) return
    let current = true
    const timer = window.setInterval(() => {
      void fetchForwards().then(result => { if (current) apply(result) }, () => {
        if (current) setLoadError('发送状态暂时未更新，请稍后刷新')
      })
    }, 5000)
    return () => { current = false; window.clearInterval(timer) }
  }, [waiting, fetchForwards, apply])

  const refresh = async () => {
    setLoading(true)
    try {
      const result = await fetchForwards()
      if (mounted.current) apply(result)
    } catch {
      if (mounted.current) setLoadError('暂时无法读取接收人和发送状态')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }
  const open = () => {
    const remembered = rememberedChoice(storageKey).filter(name => recipients.includes(name))
    setChosen(remembered.length ? remembered : recipients.slice(0, 1))
    setEditing(true)
    setError('')
  }
  const toggle = (name: string, checked: boolean) => setChosen(current =>
    checked ? [...current.filter(item => item !== name), name] : current.filter(item => item !== name))
  const selected = recipients.filter(name => chosen.includes(name))

  const send = async () => {
    if (inFlight.current) return
    if (!selected.length) { setError('请至少选择一个接收人'); return }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api.post<{ forwards: WechatForward[] }>('/capture-cloud/android/wechat-forwards', { recordId, recipients: selected })
      try { localStorage.setItem(storageKey, JSON.stringify(selected)) } catch { /* 只是记住上次选的人 */ }
      if (!mounted.current) return
      // 排队结果直接显示；随后刷新失败也不会把已受理的发送当成失败。
      const accepted = Array.isArray(result.forwards) ? result.forwards : []
      setForwards(current => [...accepted, ...current.filter(item => !accepted.some(next => next.recipient === item.recipient))])
      setEditing(false)
      await refresh()
    } catch (err) {
      if (!mounted.current) return
      const code = err instanceof ApiResponseError ? err.code : ''
      setError(isApiNetworkError(err)
        ? '发送请求的结果暂未确认，请先查看发送状态或微信聊天，再决定是否重新发送。'
        : REQUEST_ERRORS[code] || (err instanceof Error ? err.message : '发送请求失败'))
      await refresh()
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  // 兼容旧版接口：每个接收人只显示最近一次。
  const latest = forwards.filter((forward, index) => forwards.findIndex(other => other.recipient === forward.recipient) === index)
  if (!canWrite && !latest.length) return null
  return (
    <div className="mt-2.5 rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        {canWrite && !editing && (
          <button type="button" onClick={open} disabled={loading || busy || !recipients.length}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:pointer-events-none disabled:opacity-50">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}发到微信
          </button>
        )}
        {!latest.length && !editing && !loadError && (
          <span className="text-muted-foreground">
            {loading ? '正在读取接收人和发送状态…' : recipients.length
              ? '电脑上打不开原文时，让采集手机把这条视频转发到微信'
              : '还没有配置接收人，请管理员在「系统设置 → 视频号发到微信」里添加'}
          </span>
        )}
      </div>
      {latest.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-muted-foreground" aria-label="微信发送状态" aria-live="polite">
          {latest.map(forward => <li key={forward.id} className="break-words">{forward.recipient} · {describe(forward)}</li>)}
        </ul>
      )}
      {editing && (
        <div className="mt-2">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="接收人（可多选）">
            {recipients.map(name => (
              <label key={name} className={`inline-flex min-h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 ${chosen.includes(name) ? 'border-primary/40 bg-primary/[0.06] text-primary' : 'border-border bg-card text-foreground'} ${busy ? 'opacity-60' : ''}`}>
                <input type="checkbox" checked={chosen.includes(name)} disabled={busy} onChange={event => toggle(name, event.target.checked)} className="h-3.5 w-3.5 shrink-0 accent-primary" />
                <span className="break-all">{name}</span>
              </label>
            ))}
          </div>
          {!recipients.length && <p className="text-muted-foreground">接收人名单为空，请管理员先在系统设置里添加。</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void send()} disabled={busy || loading || !selected.length}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 font-medium text-primary-foreground disabled:opacity-60">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}{busy ? '正在提交…' : `发送${selected.length > 1 ? `（${selected.length} 人）` : ''}`}
            </button>
            <button type="button" onClick={() => { setEditing(false); setError('') }} disabled={busy}
              className="h-8 rounded-md px-2 text-muted-foreground hover:bg-accent">取消</button>
            <span className="text-[11px] text-muted-foreground">可多选；手机正在采集时会排队，当前关键词采完后逐个发送，每人只尝试一次。</span>
          </div>
        </div>
      )}
      {loadError && <div className="mt-1.5 text-[11px] text-muted-foreground" role="status">
        {loadError}。<button type="button" onClick={() => void refresh()} disabled={loading || busy} className="ml-1 underline disabled:opacity-50">刷新</button>
      </div>}
      {error && <div className="mt-1.5 text-[11px] text-destructive" role="alert">{error}</div>}
    </div>
  )
}
