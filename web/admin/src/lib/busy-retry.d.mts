export const OVERVIEW_POLL_INTERVAL_MS: number
export const OVERVIEW_MAX_ERROR_BACKOFF_MS: number
export const OVERVIEW_BUSY_RETRY_BASE_MS: number

export function isServerBusyError(error: unknown): boolean

export function busyRetryDelayMs(
  error: unknown,
  attempt: number,
  options?: { baseMs?: number; maxMs?: number },
): number

export function readWithBusyRetry<T>(
  read: () => Promise<T>,
  options?: {
    retries?: number
    signal?: AbortSignal
    baseMs?: number
    maxMs?: number
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  },
): Promise<T>

export function overviewNextPollDelayMs(state?: { failureCount?: number; busy?: boolean }): number

export function overviewErrorMessage(error: unknown): string

export type OverviewReadOutcome = {
  loaded: boolean
  busy: boolean
  failureCount: number
  notice: string
  error: string
}

export function overviewReadOutcome(
  previous: { loaded: boolean; failureCount: number },
  result: { data: { stale?: boolean; staleAgeMs?: number } } | { error: unknown },
): OverviewReadOutcome

export function overviewNotRefreshedNotice(staleAgeMs?: number | null): string
