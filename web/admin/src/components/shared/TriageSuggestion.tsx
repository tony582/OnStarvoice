import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  formatTriageSuggestionReason, openTriageSuggestion, TRIAGE_SUGGESTION_RULE_VERSION,
  type TriageSuggestion, type SuggestionBatchResult,
} from '@/lib/triage-suggestions'
import { useSuggestionUndo, type SuggestionConfirmationState, type SuggestionChoice } from '@/lib/use-triage-suggestions'

export function TriageSuggestionBadge({ record }: { record: Record<string, unknown> }) {
  const suggestion = openTriageSuggestion(record)
  return suggestion ? <span title={formatTriageSuggestionReason(suggestion.reason)} className="inline-flex rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">建议非监控</span> : null
}

export function SuggestionUndoBanner({ undo, busy, error, notice, restore }: ReturnType<typeof useSuggestionUndo>) {
  return undo || error || notice ? <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 text-xs">
      {undo && <><span>已将 {undo.count} 条标为非监控</span><span aria-hidden="true">·</span>
      <button type="button" disabled={busy} onClick={() => void restore()} className="font-semibold text-primary disabled:opacity-50">{busy ? '正在撤销…' : '撤销'}</button>
      <span className="text-muted-foreground">10 秒内可撤销，之后可在处理记录中逐条改回。</span></>}
      {notice && <span>{notice}</span>}
      {error && <span role="alert" className="text-destructive">{error}</span>}
    </div> : null
}

export function SuggestionConfirmation({ state, onChoice }: { state: SuggestionConfirmationState | null; onChoice: (choice: SuggestionChoice) => void }) {
  useEffect(() => {
    if (!state) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onChoice(null) } }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [state, onChoice])
  if (!state) return null
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onMouseDown={() => onChoice(null)}>
    <div role="dialog" aria-modal="true" aria-labelledby="suggestion-confirm-title" className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-xl" onMouseDown={event => event.stopPropagation()}>
      <h3 id="suggestion-confirm-title" className="text-sm font-semibold">{state.kind === 'accept' ? '确认接受非监控建议' : '确认混合处理'}</h3>
      {state.kind === 'accept' ? <>
        <p className="mt-3 text-sm">共 {state.rows.length} 条，将改为「已复核-非监控内容」，可在处理记录中撤销。</p>
        <p className="mt-2 text-xs text-muted-foreground">{state.rows.length > 10 ? '前 10 条内容：' : '本次内容：'}</p>
        <ol className="mt-2 list-inside list-decimal space-y-1 text-xs">{state.rows.slice(0, 10).map(row => <li key={row.id}>{row.title || '无标题'}</li>)}</ol>
        <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => onChoice(null)}>取消</Button><Button autoFocus onClick={() => onChoice('accept')}>确认接受 {state.rows.length} 条</Button></div>
      </> : <>
        <p className="mt-3 text-sm">所选 {state.total} 条中有 {state.suggested} 条系统建议为非监控，要怎么处理？</p>
        <div className="mt-5 flex flex-col gap-2">
          <Button autoFocus className="h-auto min-h-10 whitespace-normal" onClick={() => onChoice('split')}>其余 {state.total - state.suggested} 条标已复核，这 {state.suggested} 条标非监控</Button>
          <Button variant="outline" onClick={() => onChoice('all')}>全部标已复核</Button>
          <Button variant="ghost" onClick={() => onChoice(null)}>取消</Button>
        </div>
      </>}
    </div>
  </div>
}

export function TriageSuggestionPanel({ record, canWrite, onChanged }: {
  record: Record<string, unknown> & { id: string }
  canWrite: boolean
  onChanged?: (patch: Record<string, unknown>) => void
}) {
  const [suggestion, setSuggestion] = useState<TriageSuggestion | null>(openTriageSuggestion(record))
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    api.get<{ suggestion: TriageSuggestion | null }>(`/triage/records/${record.id}/suggestion`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setSuggestion(result.suggestion || null) })
      .catch(() => { /* A missing read must not invent a suggestion. */ })
    return () => controller.abort()
  }, [record.id, record.triage_status, record.triageSuggestion, version])
  const undo = useSuggestionUndo(async result => {
    if (result.restoredIds.includes(record.id)) {
      const data = await api.get<{ suggestion: TriageSuggestion | null }>(`/triage/records/${record.id}/suggestion`)
      setSuggestion(data.suggestion)
      onChanged?.({ triage_status: 'unhandled', triageSuggestion: data.suggestion })
    }
    setVersion(value => value + 1)
  })
  const resolve = async (accept: boolean) => {
    if (!suggestion || !canWrite || busy) return
    setBusy(true); setError('')
    try {
      if (accept) {
        const result = await api.patch<SuggestionBatchResult>('/triage/records/batch', {
          ids: [record.id], status: 'reviewed_non_monitor', source: 'suggestion', ruleVersion: suggestion.ruleVersion || TRIAGE_SUGGESTION_RULE_VERSION,
        })
        if (!result.updatedIds?.includes(record.id)) throw new Error('建议状态已变化，请刷新核对')
        undo.offer(result)
        onChanged?.({ triage_status: 'reviewed_non_monitor', triageSuggestion: null })
      } else {
        await api.post(`/triage/records/${record.id}/suggestion/reject`, {})
        onChanged?.({ triageSuggestion: null })
      }
      setSuggestion(null)
    } catch (err) { setError(err instanceof Error ? err.message : '处理建议失败，请重试'); setVersion(value => value + 1) }
    finally { setBusy(false) }
  }
  return <>
    <SuggestionUndoBanner {...undo} />
    {suggestion && <div aria-label="非监控建议" className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5">
      <p className="font-semibold">系统建议：非监控</p><p className="mt-1 text-muted-foreground">{formatTriageSuggestionReason(suggestion.reason)}</p>
      {canWrite && <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void resolve(true)}>接受（标为非监控）</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void resolve(false)}>不采纳</Button></div>}
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </>
}
