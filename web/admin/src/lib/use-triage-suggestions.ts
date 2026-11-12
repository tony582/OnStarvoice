import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { SuggestionBatchResult, SuggestionUndoResult, SuggestionSelection } from '@/lib/triage-suggestions'

export function useSuggestionUndo(onRestored: (result: SuggestionUndoResult) => Promise<void> | void) {
  const [undo, setUndo] = useState<{ id: string; expires: number; count: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), Math.max(0, undo.expires - Date.now()))
    return () => window.clearTimeout(timer)
  }, [undo])
  const offer = (result: SuggestionBatchResult) => {
    const expires = Date.parse(result.undoExpiresAt || '')
    if (result.undoId && Number.isFinite(expires) && expires > Date.now()) {
      setError(''); setNotice('')
      setUndo({ id: result.undoId, expires, count: result.acceptedIds?.length || result.updatedIds?.length || 0 })
    }
  }
  const restore = async () => {
    if (!undo || busy || Date.now() >= undo.expires) return
    setBusy(true); setError('')
    try {
      const result = await api.post<SuggestionUndoResult>('/triage/suggestions/undo', { undoId: undo.id })
      setUndo(null)
      setNotice(`已撤销 ${result.restored} 条${result.skipped?.length ? `，${result.skipped.length} 条已有后续修改，已保留` : ''}`)
      await onRestored(result)
    } catch (err) { setError(err instanceof Error ? err.message : '撤销失败，请刷新核对') }
    finally { setBusy(false) }
  }
  return { offer, undo, busy, error, notice, restore }
}

export type SuggestionConfirmationState = { kind: 'accept'; rows: SuggestionSelection[] } | { kind: 'mixed'; total: number; suggested: number }
export type SuggestionChoice = 'accept' | 'split' | 'all' | null
export function useSuggestionConfirmation() {
  const [state, setState] = useState<(SuggestionConfirmationState & { resolve: (choice: SuggestionChoice) => void }) | null>(null)
  const ask = useCallback((options: SuggestionConfirmationState) => new Promise<SuggestionChoice>(resolve => setState({ ...options, resolve })), [])
  const close = (choice: SuggestionChoice) => setState(current => { current?.resolve(choice); return null })
  return { ask, state, close }
}
