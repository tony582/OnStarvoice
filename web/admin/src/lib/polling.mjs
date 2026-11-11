/** A completion-based polling scheduler, independent of React and the DOM. */
export function createPollingController(read, {
  intervalMs,
  enabled = true,
  immediate = true,
  visible = true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let interval = normalizeInterval(intervalMs)
  let automatic = enabled
  let isVisible = visible
  let disposed = false
  let timer = null
  let active = null
  let pending = false
  let pendingManual = false
  let failures = 0
  let waiters = []

  function clearScheduled() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  function schedule(delay) {
    clearScheduled()
    if (disposed || active || !automatic || !isVisible) return
    timer = setTimer(() => {
      timer = null
      request(false)
    }, delay)
  }

  function start() {
    const requestState = { controller: new AbortController(), waiters }
    waiters = []
    pending = false
    pendingManual = false
    active = requestState
    // Attach both handlers before invoking user code, including synchronous throws.
    Promise.resolve().then(() => {
      if (!requestState.controller.signal.aborted) return read(requestState.controller.signal)
    }).then(() => {
      if (!disposed && !requestState.controller.signal.aborted) failures = 0
    }, () => {
      if (!disposed && !requestState.controller.signal.aborted) failures = Math.min(5, failures + 1)
    }).finally(() => {
      requestState.waiters.forEach(resolve => resolve())
      if (disposed || active !== requestState) return
      active = null
      if (pending && (pendingManual || (automatic && isVisible))) {
        start()
      } else {
        pending = false
        pendingManual = false
        schedule(failures ? Math.min(60_000, 5_000 * 2 ** (failures - 1)) : interval)
      }
    })
  }

  function request(manual) {
    if (disposed || (!manual && (!automatic || !isVisible))) return Promise.resolve()
    clearScheduled()
    // Each manual caller waits for the read it requested, including a merged follow-up.
    const completion = manual ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve()
    if (active) {
      pending = true
      pendingManual ||= manual
    } else {
      start()
    }
    return completion
  }

  function discardAutomaticFollowUp() {
    if (!pendingManual) pending = false
  }

  schedule(immediate ? 0 : interval)
  return {
    refresh: () => request(true),
    setVisible(nextVisible) {
      if (disposed || isVisible === nextVisible) return
      isVisible = nextVisible
      clearScheduled()
      if (isVisible) request(false)
      else discardAutomaticFollowUp()
    },
    configure({ intervalMs: nextInterval, enabled: nextEnabled }) {
      if (disposed) return
      const changedInterval = interval !== normalizeInterval(nextInterval)
      const becameEnabled = !automatic && nextEnabled
      interval = normalizeInterval(nextInterval)
      automatic = nextEnabled
      if (!automatic) {
        clearScheduled()
        discardAutomaticFollowUp()
      } else if (becameEnabled) {
        request(false)
      } else if (changedInterval && !active) {
        schedule(failures ? Math.min(60_000, 5_000 * 2 ** (failures - 1)) : interval)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearScheduled()
      pending = false
      pendingManual = false
      active?.controller.abort()
      active?.waiters.forEach(resolve => resolve())
      waiters.forEach(resolve => resolve())
      waiters = []
    },
  }
}

function normalizeInterval(value) {
  return Number.isFinite(value) && value > 0 ? value : 5_000
}
