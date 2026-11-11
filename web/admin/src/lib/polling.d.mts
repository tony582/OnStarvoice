export interface PollingController {
  refresh: () => Promise<void>
  setVisible: (visible: boolean) => void
  configure: (options: { intervalMs: number; enabled: boolean }) => void
  dispose: () => void
}

export function createPollingController(
  read: (signal: AbortSignal) => Promise<unknown>,
  options: {
    intervalMs: number
    enabled?: boolean
    immediate?: boolean
    visible?: boolean
    setTimer?: (callback: () => void, delay: number) => unknown
    clearTimer?: (timer: unknown) => void
  },
): PollingController
