import { useEffect, useRef, useState } from 'react'
import { Loader2, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/utils'

const POLL_MS = 6000

/**
 * 评论入库进度条:轮询 /workspace/processing,展示「评论 AI 分析中 · 还剩 N 篇」。
 * 评论分类要逐条走 LLM(慢),用户同步后据此知道后台跑到哪了;跑完短暂提示后自动隐藏。
 * 进度按「本次会话见到的峰值评论数」做分母,刷新页面会以当前值为新基线(只影响进度条观感)。
 */
export function ProcessingBanner() {
  const [pendingPosts, setPendingPosts] = useState(0)
  const [pendingComments, setPendingComments] = useState(0)
  const [justDone, setJustDone] = useState(false)
  const peakRef = useRef(0)
  const wasPendingRef = useRef(false)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const d = await api.get<any>('/workspace/processing')
        if (!alive) return
        const posts = Number(d.pendingPosts || 0)
        const comments = Number(d.pendingComments || 0)
        if (comments > peakRef.current) peakRef.current = comments
        setPendingPosts(posts)
        setPendingComments(comments)
        if (posts === 0 && wasPendingRef.current) {
          setJustDone(true)
          peakRef.current = 0
          setTimeout(() => { if (alive) setJustDone(false) }, 6000)
        }
        wasPendingRef.current = posts > 0
      } catch { /* 静默:进度条非关键路径,失败不打扰用户 */ }
      if (alive) timer = setTimeout(poll, POLL_MS)
    }
    poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [])

  if (pendingPosts > 0) {
    const peak = Math.max(peakRef.current, pendingComments, 1)
    const done = Math.max(0, peak - pendingComments)
    const pct = Math.min(100, Math.round((done / peak) * 100))
    return (
      <div className="mb-3 flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/[0.04] px-4 py-2.5">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-[12.5px]">
            <span className="font-semibold text-foreground">评论已入库,AI 精炼中…</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">还剩 {formatNumber(pendingPosts)} 篇 · {formatNumber(pendingComments)} 条待分析</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all duration-700 ease-out" style={{ width: `${Math.max(pct, 4)}%` }} />
          </div>
        </div>
      </div>
    )
  }

  if (justDone) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-2.5 text-[12.5px] font-semibold text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-4 w-4 shrink-0" />评论 AI 分析已全部完成
      </div>
    )
  }

  return null
}
