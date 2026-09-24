import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {ChevronDown, Loader2, RotateCcw, Smartphone} from 'lucide-react'
import {androidApi, friendlyError} from './api'
import {DiscoveryCandidates} from './DiscoveryCandidates'
import {RecoveryPanel} from './RecoveryPanel'
import {durationLabel, reasonLabel, runResultLabel, statusLabel} from './presentation'
import type {DiscoveryRunDetail} from './types'

// 已入库：候选状态终态成功，或已关联到可展示的正式记录。
const STORED_STATUSES = new Set(['stored', 'fulfilled', 'already_exists'])
// 失败：链接无法解析等终态失败。
const FAILED_STATUSES = new Set(['unresolvable'])

// 复用手机发现的既有详情接口（GET /capture-cloud/android/runs/:id）与重处理接口，
// 在普通任务详情/历史里展示「手机发现 → 补详情」进度、候选与停稳恢复。
// runId 对编排子任务是 execution_task_id，对旧独立 run 是任务本身的 id。
export function AndroidChildRunPanel({runId, writable, agentLabel, refreshKey}: {
  runId: string
  writable: boolean
  agentLabel?: string
  refreshKey?: string | number
}) {
  const [detail, setDetail] = useState<DiscoveryRunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const generation = useRef(0)
  const acting = useRef(false)

  const load = useCallback(async () => {
    const version = ++generation.current
    setLoading(true)
    try {
      const result = await androidApi.detail(runId)
      if (generation.current === version) {
        setDetail(result)
        setError('')
      }
    } catch (err) {
      if (generation.current === version) setError(friendlyError(err))
    } finally {
      if (generation.current === version) setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void load() })
    return () => { active = false; generation.current += 1 }
  }, [load, refreshKey])

  const reprocess = useCallback(async (eventIds: string[], requestId: string) => {
    if (acting.current) return false
    acting.current = true
    setBusy(true)
    try {
      await androidApi.reprocess(runId, eventIds, requestId)
      await load()
      return true
    } catch (err) {
      setError(friendlyError(err))
      return false
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [runId, load])

  const counts = useMemo(() => {
    const candidates = detail?.candidates || []
    const stored = candidates.filter(candidate =>
      STORED_STATUSES.has(candidate.status) || Boolean(candidate.recordId && candidate.recordVisibility === 'eligible')).length
    const failed = candidates.filter(candidate => FAILED_STATUSES.has(candidate.status)).length
    return {
      discovered: candidates.length,
      stored,
      failed,
      pending: Math.max(0, candidates.length - stored - failed),
    }
  }, [detail])

  return (
    <section aria-label="手机发现进度" className="rounded-xl border border-primary/20 bg-primary/[0.02] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-primary">
          <Smartphone className="h-3.5 w-3.5" />手机发现{agentLabel ? ` · ${agentLabel}` : ''}
        </h4>
        {detail && <span className="text-[11px] text-muted-foreground">{runResultLabel(detail)}</span>}
      </div>

      {loading && !detail ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />正在读取手机发现进度…</div>
      ) : error && !detail ? (
        <p role="alert" className="py-2 text-[11px] text-status-red">{error}</p>
      ) : detail ? (
        <>
          {error && <p role="alert" className="mt-2 text-[11px] text-status-red">{error}</p>}
          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg bg-muted/40 px-2.5 py-2"><dt className="text-[10px] text-muted-foreground">手机发现</dt><dd className="mt-0.5 text-base font-semibold tabular-nums">{counts.discovered}</dd></div>
            <div className="rounded-lg bg-muted/40 px-2.5 py-2"><dt className="text-[10px] text-muted-foreground">待补详情</dt><dd className="mt-0.5 text-base font-semibold tabular-nums">{counts.pending}</dd></div>
            <div className="rounded-lg bg-muted/40 px-2.5 py-2"><dt className="text-[10px] text-muted-foreground">已入库</dt><dd className="mt-0.5 text-base font-semibold tabular-nums text-status-green">{counts.stored}</dd></div>
            <div className="rounded-lg bg-muted/40 px-2.5 py-2"><dt className="text-[10px] text-muted-foreground">失败</dt><dd className={`mt-0.5 text-base font-semibold tabular-nums ${counts.failed > 0 ? 'text-status-red' : ''}`}>{counts.failed}</dd></div>
          </dl>

          {detail.recovery && <div className="mt-3"><RecoveryPanel recovery={detail.recovery} /></div>}

          {detail.items.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-[11px]" aria-label="关键词执行状态">
              {detail.items.map(item => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-2.5 py-1.5">
                  <span className="font-medium">{item.keyword}</span>
                  <span className="text-muted-foreground">{statusLabel(item.status)}
                    {item.stats?.keywordElapsedMs !== undefined ? ` · 耗时 ${durationLabel(item.stats.keywordElapsedMs)}` : ''}
                    {(item.attemptCount || 0) > 1 ? ` · 第 ${item.attemptCount} 次` : ''}
                  </span>
                  {item.reason && <span className="w-full text-muted-foreground">{reasonLabel(item.reason)}</span>}
                </li>
              ))}
            </ul>
          )}

          <button type="button" onClick={() => setExpanded(value => !value)}
            className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-expanded={expanded}>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            {expanded ? '收起发现候选' : `展开发现候选 ${counts.discovered}`}
          </button>
          {expanded && (
            <div className="mt-3">
              <DiscoveryCandidates
                key={runId}
                candidates={detail.candidates}
                events={detail.events}
                writable={writable}
                busy={busy}
                onReprocess={reprocess}
              />
            </div>
          )}

          {writable && (
            <button type="button" onClick={() => { void load() }} disabled={loading}
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">
              <RotateCcw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />刷新手机发现
            </button>
          )}
        </>
      ) : null}
    </section>
  )
}
