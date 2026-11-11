import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createPollingController } from '../web/admin/src/lib/polling.mjs'

const page = readFileSync(new URL('../web/admin/src/pages/OpinionAnalysisPage.tsx', import.meta.url), 'utf8')
function between(start, end) {
  const begin = page.indexOf(start)
  assert.notEqual(begin, -1)
  const finish = page.indexOf(end, begin + start.length)
  assert.notEqual(finish, -1)
  return page.slice(begin + start.length, finish)
}
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }

test('returning to the list and reopening a completed analysis reads it again without restarting terminal polling', async () => {
  const requests = []
  const state = {
    selectedId: 'analysis-a', detail: { id: 'analysis-a', status: 'done', payload: 'old' }, detailError: 'old failure',
    api: { async get(path) { requests.push(path); return { analysis: { id: 'analysis-a', status: 'done', payload: `read-${requests.length}` } } } },
    setDetail(value) { state.detail = value },
    setDetailError(value) { state.detailError = value },
    setSelectedId(value) { state.selectedId = value },
    setItems() {},
  }
  const context = vm.createContext(state)
  const select = vm.runInContext(`(id) => {${between('  const selectAnalysis = useCallback((id: string) => {', '  }, [])')}}`, context)
  const read = vm.runInContext(`async (signal) => {${between('  const readDetail = useCallback(async (signal: AbortSignal) => {', '  }, [selectedId])').replace('api.get<any>', 'api.get')}}`, context)
  const options = between('  usePolling(readDetail, {', '  })')
  const enabledExpression = /enabled: (.+),\n/u.exec(options)?.[1]
  assert.ok(enabledExpression)
  const enabled = () => vm.runInContext(enabledExpression, context)

  for (let visit = 1; visit <= 2; visit += 1) {
    select('')
    assert.equal(state.detail, null)
    assert.equal(state.detailError, '')
    assert.equal(enabled(), false)
    select('analysis-a')
    assert.equal(enabled(), true, 'the cached terminal result must not suppress a new entry')
    let timer
    const polling = createPollingController(read, {
      intervalMs: 2500, enabled: enabled(),
      setTimer(callback) { timer = callback; return 1 },
      clearTimer() { timer = undefined },
    })
    assert.equal(typeof timer, 'function')
    timer()
    await flush()
    polling.configure({ intervalMs: 2500, enabled: enabled() })
    assert.equal(requests.length, visit)
    assert.equal(state.detail.payload, `read-${visit}`)
    assert.equal(enabled(), false, 'terminal success stops automatic refreshes')
    assert.equal(timer, undefined)
    polling.dispose()
  }
  assert.equal((page.match(/setSelectedId\(/gu) || []).length, 1, 'all selection routes clear stale detail and error through the shared transition')
  assert.match(page, /onBack=\{\(\) => selectAnalysis\(''\)\}/u)
  assert.match(page, /onOpen=\{\(\) => selectAnalysis\(item\.id\)\}/u)
})
