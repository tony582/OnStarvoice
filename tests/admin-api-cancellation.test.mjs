import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const ts = createRequire(new URL('../web/admin/package.json', import.meta.url))('typescript')
const compiled = ts.transpileModule(readFileSync(new URL('../web/admin/src/lib/api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { api, ApiNetworkError, ApiResponseError } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

function slowBodyFetch(t) {
  let requestSignal, bodyStarted
  const started = new Promise(resolve => { bodyStarted = resolve })
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestSignal = options.signal
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'))
        requestSignal.addEventListener('abort', () => controller.error(requestSignal.reason), { once: true })
      },
    })
    const response = new Response(stream, { headers: { 'Content-Type': 'application/json' } })
    const readJson = response.json.bind(response)
    response.json = () => { bodyStarted(); return readJson() }
    return response
  })
  return { started, signal: () => requestSignal }
}

test('caller abort rejects a slow response body after headers, without returning a format-error payload', async t => {
  const body = slowBodyFetch(t), controller = new AbortController()
  const pending = api.get('/slow-body', { signal: controller.signal })
  await body.started
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError' && !(error instanceof ApiNetworkError))
  assert.equal(body.signal().aborted, true)
})

test('timeout remains active while the body arrives, including when a caller signal was supplied', async t => {
  const body = slowBodyFetch(t), controller = new AbortController()
  const pending = api.get('/slow-body', { signal: controller.signal, timeoutMs: 15 })
  await body.started
  assert.equal(body.signal().aborted, false)
  await assert.rejects(pending, /请求超时/)
  assert.equal(body.signal().aborted, true)
  assert.equal(controller.signal.aborted, false, 'the API does not cancel the caller-owned controller')
})

test('caller cancellation wins over its later timeout and a pre-aborted request is never sent', async t => {
  const body = slowBodyFetch(t), controller = new AbortController()
  const pending = api.get('/slow-body', { signal: controller.signal, timeoutMs: 100 })
  await body.started
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  const requests = globalThis.fetch.mock.callCount()
  await assert.rejects(api.get('/already-aborted', { signal: controller.signal, timeoutMs: 100 }), error => error.name === 'AbortError')
  assert.equal(globalThis.fetch.mock.callCount(), requests)
})

test('successful body consumption clears timeout and detaches the caller abort listener', async t => {
  const controller = new AbortController()
  let requestSignal
  const add = t.mock.method(controller.signal, 'addEventListener')
  const remove = t.mock.method(controller.signal, 'removeEventListener')
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestSignal = options.signal
    return Response.json({ ok: true, records: [1] })
  })
  assert.deepEqual(await api.get('/done', { signal: controller.signal, timeoutMs: 10 }), { ok: true, records: [1] })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(requestSignal.aborted, false)
  assert.equal(add.mock.callCount(), 1)
  assert.equal(remove.mock.callCount(), 1)
  controller.abort()
  assert.equal(requestSignal.aborted, false)
})

test('HTTP, malformed JSON and transport errors retain their distinct behavior', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: '无权访问', error: 'forbidden' }, { status: 403 }))
  await assert.rejects(api.get('/denied'), error => error instanceof ApiResponseError && error.status === 403 && error.message === '无权访问')
  globalThis.fetch.mock.mockImplementation(async () => new Response('not-json'))
  assert.deepEqual(await api.get('/malformed'), { ok: false, message: '响应格式错误' })
  globalThis.fetch.mock.mockImplementation(async () => { throw new TypeError('network down') })
  await assert.rejects(api.get('/offline'), error => error instanceof ApiNetworkError)
  globalThis.fetch.mock.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('body connection lost')) } })))
  await assert.rejects(api.get('/body-lost'), error => error instanceof ApiNetworkError)
})
