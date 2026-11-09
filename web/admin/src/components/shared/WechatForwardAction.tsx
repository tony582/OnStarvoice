import { useCallback, useEffect, useState } from 'react'
import { Loader2, Send } from 'lucide-react'
import { api, ApiResponseError } from '@/lib/api'

// 「发到微信」：视频号原文链接在电脑上要扫码，这里让采集手机把这条视频号转发给它微信里的一个联系人（比如你自己），
// 在电脑微信的聊天里点开卡片就能看。手机正在采集时要排队，等当前关键词采完再发；一次请求只发一次，不会自动重试。
type WechatForward = {
  id: string
  recipient: string
  status: string
  reason: string
  errorCode: string
  requestedBy?: string
  createdAt: string
  finishedAt?: string | null
}

const STORAGE_KEY = 'osv_wechat_forward_recipient'
const STATUS_TEXT: Record<string, string> = {
  pending: '排队中，手机空闲后发送',
  running: '手机正在发送',
  completed: '已发送',
  completed_with_warnings: '已点发送，但没看到「已发送」提示，请在微信里确认',
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
  INVALID_FORWARD_RECIPIENT: '接收人填 1–40 个字，不能有引号',
  android_discovery_not_enabled: '这个租户没有开通手机采集',
}

function describe(forward: WechatForward) {
  const base = STATUS_TEXT[forward.status] || forward.status
  if (forward.status !== 'failed') return base
  const why = FAILURE_TEXT[forward.reason] || FAILURE_TEXT[forward.errorCode] || forward.reason || forward.errorCode
  return why ? `${base}：${why}` : base
}

export function WechatForwardAction({ recordId, canWrite }: { recordId: string; canWrite: boolean }) {
  const [forwards, setForwards] = useState<WechatForward[]>([])
  const [editing, setEditing] = useState(false)
  const [recipient, setRecipient] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || '' } catch { return '' }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 状态只是提示，读不到不影响详情。
  const fetchForwards = useCallback(() => api
    .get<{ forwards: WechatForward[] }>(`/capture-cloud/android/wechat-forwards?recordId=${encodeURIComponent(recordId)}`)
    .then(result => Array.isArray(result.forwards) ? result.forwards : [], () => null), [recordId])
  const load = useCallback(async () => {
    const next = await fetchForwards()
    if (next) setForwards(next)
  }, [fetchForwards])

  useEffect(() => {
    let current = true
    void fetchForwards().then(next => { if (current && next) setForwards(next) })
    return () => { current = false }
  }, [fetchForwards])
  const waiting = forwards.some(forward => forward.status === 'pending' || forward.status === 'running')
  useEffect(() => {
    if (!waiting) return
    let current = true
    const timer = window.setInterval(() => {
      void fetchForwards().then(next => { if (current && next) setForwards(next) })
    }, 5000)
    return () => { current = false; window.clearInterval(timer) }
  }, [waiting, fetchForwards])

  const send = async () => {
    const name = recipient.trim()
    if (!name) { setError('请填写接收人'); return }
    setBusy(true)
    setError('')
    try {
      await api.post('/capture-cloud/android/wechat-forwards', { recordId, recipient: name })
      try { localStorage.setItem(STORAGE_KEY, name) } catch { /* 只是记住上次填的名字 */ }
      setEditing(false)
      await load()
    } catch (err) {
      const code = err instanceof ApiResponseError ? err.code : ''
      setError(REQUEST_ERRORS[code] || (err instanceof Error ? err.message : '发送请求失败'))
    } finally {
      setBusy(false)
    }
  }

  const latest = forwards[0]
  if (!canWrite && !latest) return null
  return (
    <div className="mt-2.5 rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        {canWrite && !editing && (
          <button type="button" onClick={() => { setEditing(true); setError('') }} disabled={waiting}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:pointer-events-none disabled:opacity-50">
            <Send className="h-3.5 w-3.5" />发到微信
          </button>
        )}
        {latest && (
          <span className="text-muted-foreground">
            {latest.recipient} · {describe(latest)}
          </span>
        )}
        {!latest && !editing && <span className="text-muted-foreground">电脑上打不开原文时，让采集手机把这条视频转发到你的微信</span>}
      </div>
      {editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={recipient} onChange={event => setRecipient(event.target.value)} maxLength={40} autoFocus
            onKeyDown={event => { if (event.key === 'Enter') void send() }}
            placeholder="接收人（采集手机微信里的名字）"
            className="h-8 min-w-[200px] flex-1 rounded-md border border-input bg-card px-2.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10" />
          <button type="button" onClick={() => void send()} disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 font-medium text-primary-foreground disabled:opacity-60">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}发送
          </button>
          <button type="button" onClick={() => { setEditing(false); setError('') }} disabled={busy}
            className="h-8 rounded-md px-2 text-muted-foreground hover:bg-accent">取消</button>
          <span className="w-full text-[11px] text-muted-foreground">手机正在采集时会排队，当前关键词采完后发送；名字要和采集手机微信里显示的完全一致。</span>
        </div>
      )}
      {error && <div className="mt-1.5 text-[11px] text-destructive">{error}</div>}
    </div>
  )
}
