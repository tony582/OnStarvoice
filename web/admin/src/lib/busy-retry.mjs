// 服务端用 503 server_busy 表示数据库短暂繁忙（排队超时或单条查询超时）。
// 这类失败通常几秒内自行恢复：页面先自动重试、保留已有数据，仍然失败才提示。

export const OVERVIEW_POLL_INTERVAL_MS = 15_000
export const OVERVIEW_MAX_ERROR_BACKOFF_MS = 120_000
export const OVERVIEW_BUSY_RETRY_BASE_MS = 3_000

// 登录态、租户校验等公共环节遇到数据库繁忙时，服务端按 500 返回数据库原文。
const TRANSIENT_DATABASE_MESSAGE = /Database (?:critical|general|reporting) capacity is temporarily unavailable|canceling statement due to (?:statement|lock) timeout/i

export function isServerBusyError(error) {
  if (!error || typeof error !== 'object') return false
  if (error.status === 503 || error.code === 'server_busy') return true
  return error.status === 500 && TRANSIENT_DATABASE_MESSAGE.test(String(error.message || ''))
}

export function busyRetryDelayMs(error, attempt, { baseMs = 1_000, maxMs = 8_000 } = {}) {
  const requested = Number(error?.retryAfterMs)
  const base = Number.isFinite(requested) && requested > 0 ? requested : baseMs
  return Math.min(maxMs, Math.max(250, Math.round(base * 2 ** Math.max(0, attempt))))
}

function sleepUnlessAborted(delayMs, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * 只对「服务繁忙」重试；其他错误、已被取消的读取立即抛出原错误。
 * retries 是首次读取之外最多再试的次数。
 */
export async function readWithBusyRetry(read, {
  retries = 2,
  signal,
  baseMs,
  maxMs,
  sleep = sleepUnlessAborted,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      if (attempt >= retries || !isServerBusyError(error) || signal?.aborted) throw error
      await sleep(busyRetryDelayMs(error, attempt, { baseMs, maxMs }), signal)
      if (signal?.aborted) throw error
    }
  }
}

/**
 * 任务看板下一次自动读取的间隔。
 * - 正常：15 秒。
 * - 服务繁忙（读取失败或拿到的是上一次的数据）：3、6、12 秒后重试，之后回到 15 秒。
 * - 其他错误（网络、权限等）：30、60、120 秒，避免对着故障反复请求。
 */
export function overviewNextPollDelayMs({ failureCount = 0, busy = false } = {}) {
  const failures = Math.max(0, Math.floor(Number(failureCount) || 0))
  if (failures === 0) return OVERVIEW_POLL_INTERVAL_MS
  if (busy) {
    return Math.min(OVERVIEW_POLL_INTERVAL_MS, OVERVIEW_BUSY_RETRY_BASE_MS * 2 ** (failures - 1))
  }
  return Math.min(OVERVIEW_MAX_ERROR_BACKOFF_MS, OVERVIEW_POLL_INTERVAL_MS * 2 ** failures)
}

/** 看板读取失败、页面又没有可保留的数据时显示的文字；繁忙不显示数据库原文。 */
export function overviewErrorMessage(error) {
  if (isServerBusyError(error)) return '任务看板查询繁忙，请稍后重试'
  const message = error && typeof error === 'object' ? String(error.message || '') : ''
  return message || '读取云端任务中心失败'
}

/**
 * 一次看板读取之后页面应处于的状态。
 * previous：{ loaded, failureCount }；result：{ data } 或 { error }。
 * data 总是显示出来，包括服务端在读不成时给的上一次结果（stale）。
 * - notice：看板还在、只是没刷新；error：看板不可用。两者不会同时出现。
 * - busy、failureCount 决定下一次读取的间隔（overviewNextPollDelayMs）。
 */
export function overviewReadOutcome(previous, result) {
  const loaded = Boolean(previous?.loaded)
  const failures = Math.max(0, Math.floor(Number(previous?.failureCount) || 0))
  const data = result && typeof result === 'object' ? result.data : null
  if (data && typeof data === 'object') {
    const stale = data.stale === true
    return {
      loaded: true,
      busy: stale,
      failureCount: stale ? Math.min(4, failures + 1) : 0,
      notice: stale ? overviewNotRefreshedNotice(data.staleAgeMs) : '',
      error: '',
    }
  }
  const error = result && typeof result === 'object' ? result.error : null
  const busy = isServerBusyError(error)
  const keepBoard = loaded && busy
  return {
    loaded,
    busy,
    failureCount: Math.min(4, failures + 1),
    notice: keepBoard ? overviewNotRefreshedNotice(null) : '',
    error: keepBoard ? '' : overviewErrorMessage(error),
  }
}

/** 看板没能刷新时的说明；staleAgeMs 为空表示页面保留的是自己上一次读到的数据。 */
export function overviewNotRefreshedNotice(staleAgeMs) {
  const age = staleAgeMs === null || staleAgeMs === undefined ? Number.NaN : Number(staleAgeMs)
  if (Number.isFinite(age) && age >= 0) {
    const seconds = Math.max(1, Math.round(age / 1000))
    return `服务繁忙，任务看板暂时没有刷新：当前显示的是约 ${seconds} 秒前的数据，系统会自动重试。`
  }
  return '服务繁忙，任务看板暂时没有刷新：页面保留上一次的数据，系统会自动重试。'
}
