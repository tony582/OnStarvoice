import { useCallback, useEffect, useRef } from 'react'
import { createPollingController, type PollingController } from '@/lib/polling.mjs'

interface PollingOptions {
  intervalMs: number
  /** Controls automatic reads only; refresh() remains available. */
  enabled?: boolean
  immediate?: boolean
  /** Changing the task/tenant scope aborts its previous request and starts a new cycle. */
  resetKey?: string | number
}

/**
 * Poll after completion, with one request in flight and at most one merged follow-up.
 * Pass signal through every request and check it before setting state. A callback
 * may display an error and rethrow it to enable backoff; refresh() itself never rejects.
 * Hidden pages pause automatic reads. Returning to the foreground refreshes immediately.
 */
export function usePolling(
  fn: (signal: AbortSignal) => Promise<unknown>,
  { intervalMs, enabled = true, immediate = true, resetKey }: PollingOptions,
) {
  const readRef = useRef(fn)
  const optionsRef = useRef({ intervalMs, enabled })
  const controllerRef = useRef<PollingController | null>(null)

  useEffect(() => { readRef.current = fn }, [fn])
  useEffect(() => { optionsRef.current = { intervalMs, enabled } }, [intervalMs, enabled])

  useEffect(() => {
    const controller = createPollingController(signal => readRef.current(signal), {
      ...optionsRef.current,
      immediate,
      visible: document.visibilityState === 'visible',
    })
    controllerRef.current = controller
    const onVisibilityChange = () => controller.setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [resetKey, immediate])

  useEffect(() => {
    controllerRef.current?.configure({ intervalMs, enabled })
  }, [intervalMs, enabled])

  const refresh = useCallback((): Promise<void> => controllerRef.current?.refresh() ?? Promise.resolve(), [])
  return { refresh }
}
