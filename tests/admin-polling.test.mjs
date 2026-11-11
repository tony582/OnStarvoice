import test from 'node:test'
import assert from 'node:assert/strict'
import { createPollingController } from '../web/admin/src/lib/polling.mjs'

const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function clock() {
  let now = 0, serial = 0
  const timers = new Map()
  return {
    setTimer(callback, delay) { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id },
    clearTimer(id) { timers.delete(id) },
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await flush()
      }
      now = target
      await flush()
    },
    delays() { return [...timers.values()].map(value => value.at - now) },
  }
}

test('a 70-second read never overlaps periodic reads; the next interval starts after completion', async () => {
  const time = clock(), first = deferred()
  let calls = 0
  const polling = createPollingController(() => { calls += 1; return calls === 1 ? first.promise : Promise.resolve() }, { intervalMs: 5_000, ...time })
  await time.advance(0)
  await time.advance(70_000)
  assert.equal(calls, 1)
  assert.deepEqual(time.delays(), [])
  first.resolve()
  await flush()
  await time.advance(4_999)
  assert.equal(calls, 1)
  await time.advance(1)
  assert.equal(calls, 2)
  polling.dispose()
})

test('many manual and foreground refreshes merge into one follow-up and await that read', async () => {
  const time = clock(), reads = [deferred(), deferred()]
  let calls = 0, resolved = 0
  const polling = createPollingController(() => reads[calls++].promise, { intervalMs: 5_000, ...time })
  await time.advance(0)
  const waiting = Array.from({ length: 8 }, () => polling.refresh().then(() => { resolved += 1 }))
  polling.setVisible(false)
  polling.setVisible(true)
  assert.equal(calls, 1)
  reads[0].resolve()
  await flush()
  assert.equal(calls, 2)
  assert.equal(resolved, 0)
  reads[1].resolve()
  await Promise.all(waiting)
  await flush()
  assert.equal(resolved, 8)
  assert.deepEqual(time.delays(), [5_000])
  polling.dispose()
})

test('hidden pages cancel scheduled and queued automatic reads, then refresh immediately on return', async () => {
  const time = clock(), first = deferred()
  let calls = 0
  const polling = createPollingController(() => { calls += 1; return calls === 1 ? first.promise : Promise.resolve() }, { intervalMs: 5_000, ...time })
  await time.advance(0)
  polling.setVisible(false)
  polling.setVisible(true) // Queues an automatic refresh while the first read is in flight.
  polling.setVisible(false) // Hiding again must discard that queued automatic refresh.
  first.resolve()
  await flush()
  await time.advance(60_000)
  assert.equal(calls, 1)
  polling.setVisible(true)
  await flush()
  assert.equal(calls, 2)
  polling.setVisible(false)
  await time.advance(60_000)
  assert.equal(calls, 2)
  polling.dispose()
})

test('enabled only controls automation; explicit refresh works when disabled or hidden', async () => {
  const time = clock()
  let calls = 0
  const polling = createPollingController(async () => { calls += 1 }, { intervalMs: 5_000, enabled: false, visible: false, ...time })
  await time.advance(60_000)
  await polling.refresh()
  assert.equal(calls, 1)
  polling.setVisible(true)
  await time.advance(60_000)
  assert.equal(calls, 1)
  polling.configure({ intervalMs: 10_000, enabled: true })
  await flush()
  assert.equal(calls, 2)
  assert.deepEqual(time.delays(), [10_000])
  polling.configure({ intervalMs: 10_000, enabled: false })
  await time.advance(60_000)
  assert.equal(calls, 2)
  polling.dispose()
})

test('failures back off 5/10/20/40/60 seconds and a successful read restores the normal interval', async () => {
  const time = clock()
  let fail = true, calls = 0
  const polling = createPollingController(async () => { calls += 1; if (fail) throw new Error('offline') }, { intervalMs: 15_000, ...time })
  await time.advance(0)
  for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    assert.deepEqual(time.delays(), [delay])
    await time.advance(delay)
  }
  assert.equal(calls, 7)
  fail = false
  await polling.refresh()
  await flush()
  assert.deepEqual(time.delays(), [15_000])
  fail = true
  await polling.refresh() // Manual failures settle normally, rather than rejecting.
  await flush()
  assert.deepEqual(time.delays(), [5_000])
  polling.dispose()
})

test('dispose aborts the body read, releases manual waiters, and never starts queued or future reads', async () => {
  const time = clock(), read = deferred()
  let signal, calls = 0
  const polling = createPollingController(value => { signal = value; calls += 1; return read.promise }, { intervalMs: 5_000, ...time })
  const first = polling.refresh()
  await flush()
  const queued = polling.refresh()
  polling.dispose()
  assert.equal(signal.aborted, true)
  await Promise.all([first, queued])
  read.reject(new DOMException('Aborted', 'AbortError'))
  await flush()
  await time.advance(60_000)
  await polling.refresh()
  assert.equal(calls, 1)
  assert.deepEqual(time.delays(), [])
})

test('replacing a task scope aborts its old read and late completion cannot affect the new cycle', async () => {
  const time = clock(), oldRead = deferred()
  let oldSignal, newCalls = 0
  const oldScope = createPollingController(signal => { oldSignal = signal; return oldRead.promise }, { intervalMs: 5_000, ...time })
  await time.advance(0)
  oldScope.dispose()
  const newScope = createPollingController(async () => { newCalls += 1 }, { intervalMs: 15_000, ...time })
  await time.advance(0)
  assert.equal(oldSignal.aborted, true)
  oldRead.reject(new Error('late old failure'))
  await flush()
  assert.deepEqual(time.delays(), [15_000])
  await time.advance(15_000)
  assert.equal(newCalls, 2)
  newScope.dispose()
})

test('immediate=false waits once, while visibility restoration still refreshes promptly', async () => {
  const time = clock()
  let calls = 0
  const polling = createPollingController(async () => { calls += 1 }, { intervalMs: 5_000, immediate: false, ...time })
  await time.advance(4_999)
  assert.equal(calls, 0)
  await time.advance(1)
  assert.equal(calls, 1)
  polling.setVisible(false)
  polling.setVisible(true)
  await flush()
  assert.equal(calls, 2)
  polling.dispose()
})
