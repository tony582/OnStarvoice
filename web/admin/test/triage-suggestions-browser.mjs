// Offline acceptance: browser requests are confined to this local Vite fixture.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
await server.listen()
const base = `http://127.0.0.1:${server.httpServer.address().port}`
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } })
  const errors = [], requests = [], batches = [], rejections = []
  page.on('pageerror', error => errors.push(error.message))
  const suggestion = { suggestion: 'non_monitor', ruleVersion: 'non_monitor_f_v1', reason: { summary: '其它通用内容，与搜索词不匹配，无服务主题词' } }
  let records, before, enabled = true, overflow = false, failAccept = false, stats
  const record = (index, suggested = true) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    title: `离线内容${index}`, content: `正文${index}`, platform: 'douyin', author_name: '离线作者', triage_status: 'unhandled',
    sentiment: 'neutral', likes: 1, comments_count: 0, shares: 0, collects: 0, created_at: '2026-11-12T02:00:00Z',
    triageSuggestion: suggested ? { ...suggestion } : null,
  })
  const reset = async (count = 3) => {
    records = Array.from({ length: count }, (_, index) => record(index + 1, count > 3 || index < 2))
    before = null; enabled = true; overflow = false; failAccept = false
    stats = { accepted: 2, rejected: 1, superseded: 3, acceptanceRate: 2 / 3 }
    batches.length = 0; requests.length = 0; rejections.length = 0
    await page.goto(`${base}/admin/test/fixtures/triage-suggestions.html`)
    await page.getByRole('switch', { name: /^系统建议非监控/ }).waitFor()
  }
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== base) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const path = url.pathname.slice(4)
    requests.push(`${request.method()} ${path}`)
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/auth/me') return send({ ok: true, user: { id: 'user', memberships: [{ tenantId: 'fixture', tenantName: '离线验收', role: 'tenant_analyst', status: 'active' }] } })
    if (path === '/workspace/badges') return send({ badges: {} })
    if (path === '/triage/records') {
      const open = records.filter(row => row.triage_status === 'unhandled' && row.triageSuggestion)
      let matching = url.searchParams.get('suggestion') === 'non_monitor' ? open : records
      const keyword = url.searchParams.get('keyword')
      if (keyword) matching = matching.filter(row => row.title.includes(keyword))
      const suggestions = { enabled, count: keyword ? open.filter(row => row.title.includes(keyword)).length : open.length, stats }
      if (url.searchParams.get('selection') === '1') return send({ selection: matching, suggestions, pagination: { total: overflow ? 10001 : matching.length } })
      const size = Number(url.searchParams.get('pageSize') || 30), pageNo = Number(url.searchParams.get('page') || 1)
      return send({ records: matching.slice((pageNo - 1) * size, pageNo * size), suggestions, pagination: { total: matching.length, totalPages: Math.ceil(matching.length / size), page: pageNo } })
    }
    if (path === '/triage/records/batch') {
      const body = request.postDataJSON(); batches.push(body)
      if (failAccept) return send({ message: '建议状态已变化，请刷新后重试' }, 409)
      before = structuredClone(records)
      const updatedIds = [], acceptedIds = [], statusById = {}
      for (const row of records.filter(row => body.ids.includes(row.id))) {
        const hasSuggestion = Boolean(row.triageSuggestion)
        const status = body.suggestionMode === 'split' && hasSuggestion ? 'reviewed_non_monitor' : body.status
        row.triage_status = status; updatedIds.push(row.id); statusById[row.id] = status
        if (hasSuggestion) {
          if (status === 'reviewed_non_monitor') { acceptedIds.push(row.id); stats.accepted++ } else stats.rejected++
          row.triageSuggestion = null
        }
      }
      return send({ updatedIds, acceptedIds, statusById, ...(acceptedIds.length ? { undoId: 'undo-fixture', undoExpiresAt: new Date(Date.now() + 10000).toISOString() } : {}) })
    }
    if (path === '/triage/suggestions/undo') {
      const restoredIds = before.filter(prior => records.find(row => row.id === prior.id)?.triage_status !== prior.triage_status).map(row => row.id)
      records = before; before = null
      return send({ restored: restoredIds.length, restoredIds, skipped: [] })
    }
    const id = /\/records\/([^/]+)/.exec(path)?.[1]
    const row = records?.find(item => item.id === id)
    if (path.endsWith('/suggestion/reject')) { rejections.push(id); row.triageSuggestion = null; stats.rejected++; return send({ ok: true }) }
    if (path.endsWith('/suggestion')) return send({ ok: true, suggestion: row?.triageSuggestion || null })
    if (path.endsWith('/detail')) return send({ record: row })
    if (path.endsWith('/comments')) return send({ comments: [], officialResponses: [] })
    if (path.endsWith('/observations')) return send({ observations: [] })
    if (path.endsWith('/activity')) return send({ activity: [] })
    return send({ tags: [], keywords: [], options: [], analysis: null })
  })
  const row = index => page.getByRole('row').filter({ has: page.getByText(`离线内容${index}`, { exact: true }) })
  const toggleFilter = () => page.getByRole('switch', { name: /^系统建议非监控/ }).click()
  const chooseReviewed = async () => {
    await page.getByRole('toolbar', { name: '批量处理' }).getByRole('button', { name: '处理状态', exact: true }).click()
    await page.getByRole('menuitem', { name: '已复核', exact: true }).click()
  }

  await reset()
  await row(1).getByText('建议非监控', { exact: true }).waitFor()
  assert.equal(await row(1).getByRole('button', { name: /待处理/ }).count(), 1)
  await page.getByText(/近 30 天：接受 2 \/ 不采纳 1 \/ 失效 3 · 采纳率 67%/).waitFor()
  await toggleFilter()
  await page.getByRole('button', { name: '全部接受建议 (2)', exact: true }).waitFor()
  assert.equal(await row(1).getByRole('checkbox').getAttribute('aria-checked'), 'true')
  await row(1).getByRole('checkbox').click()
  await page.getByRole('button', { name: '全部接受建议 (1)', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '确认接受非监控建议' })
  await confirm.getByText('离线内容2', { exact: true }).waitFor()
  assert.equal(await confirm.getByText('离线内容1', { exact: true }).count(), 0)
  await confirm.getByRole('button', { name: '确认接受 1 条' }).click()
  await page.getByRole('button', { name: '撤销', exact: true }).waitFor()
  assert.equal(batches[0].source, 'suggestion')
  assert.deepEqual(batches[0].ids, [record(2).id])
  assert.ok(records[0].triageSuggestion, 'Unchecked suggestion must stay unresolved')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.getByRole('button', { name: '全部接受建议 (2)', exact: true }).waitFor()
  assert.equal(records[1].triage_status, 'unhandled')

  for (const choice of ['取消', '全部标已复核', '其余 1 条标已复核，这 1 条标非监控']) {
    await reset()
    await row(1).getByRole('checkbox').click(); await row(3).getByRole('checkbox').click()
    await chooseReviewed()
    const mixed = page.getByRole('dialog', { name: '确认混合处理' })
    await mixed.getByText('所选 2 条中有 1 条系统建议为非监控，要怎么处理？', { exact: true }).waitFor()
    await mixed.getByRole('button', { name: choice, exact: true }).click()
    if (choice === '取消') { assert.equal(batches.length, 0); assert.equal(records[0].triage_status, 'unhandled') }
    else {
      await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-labelledby="suggestion-confirm-title"]'))
      await page.getByText(/已将 .*条/).first().waitFor()
      assert.equal(batches.length, 1)
      assert.equal(records[2].triage_status, 'reviewed')
      assert.equal(records[0].triage_status, choice === '全部标已复核' ? 'reviewed' : 'reviewed_non_monitor')
      assert.equal(records[0].triageSuggestion, null)
    }
  }

  await reset()
  await row(1).getByText('离线内容1', { exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '舆情内容详情' })
  await drawer.getByText('系统建议：非监控', { exact: true }).waitFor()
  await drawer.getByRole('button', { name: '不采纳', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[aria-label="非监控建议"]'))
  assert.equal(records[0].triage_status, 'unhandled')
  assert.deepEqual(rejections, [record(1).id])

  await reset()
  await row(1).getByText('离线内容1', { exact: true }).click()
  await drawer.getByRole('button', { name: '接受（标为非监控）', exact: true }).click()
  await drawer.getByRole('button', { name: '撤销', exact: true }).waitFor()
  assert.equal(records[0].triage_status, 'reviewed_non_monitor')
  await drawer.getByRole('button', { name: '撤销', exact: true }).click()
  await drawer.getByRole('button', { name: '接受（标为非监控）', exact: true }).waitFor()
  assert.equal(records[0].triage_status, 'unhandled')

  await reset(35)
  await toggleFilter(); await row(1).getByRole('checkbox').click()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await row(33).getByRole('checkbox').click()
  await page.getByRole('button', { name: '全部接受建议 (33)', exact: true }).click()
  await confirm.getByText('前 10 条内容：', { exact: true }).waitFor()
  assert.equal(await confirm.locator('li').count(), 10)
  await confirm.getByRole('button', { name: '确认接受 33 条' }).click()
  await page.getByRole('button', { name: '撤销', exact: true }).waitFor()
  assert.equal(batches[0].ids.length, 33)
  assert.equal(batches[0].ids.includes(record(1).id), false)
  assert.equal(batches[0].ids.includes(record(33).id), false)

  await reset(); overflow = true
  await toggleFilter(); await page.getByRole('button', { name: '全部接受建议 (2)', exact: true }).click()
  await page.getByText(/匹配内容超过单次处理上限/).waitFor()
  assert.equal(batches.length, 0)

  await reset(); failAccept = true
  await toggleFilter(); await page.getByRole('button', { name: '全部接受建议 (2)', exact: true }).click()
  await confirm.getByRole('button', { name: '确认接受 2 条' }).click()
  await page.getByText(/接受建议失败：建议状态已变化/).waitFor()
  assert.equal(records[0].triage_status, 'unhandled')

  await reset()
  await page.clock.install({ time: new Date() })
  await toggleFilter(); await page.getByRole('button', { name: '全部接受建议 (2)', exact: true }).click()
  await confirm.getByRole('button', { name: '确认接受 2 条' }).click()
  await page.getByRole('button', { name: '撤销', exact: true }).waitFor()
  await page.clock.fastForward(11000)
  assert.equal(await page.getByRole('button', { name: '撤销', exact: true }).count(), 0)
  assert.equal(records[0].triage_status, 'reviewed_non_monitor')
  assert.deepEqual(errors, [])
  console.log('triage suggestions browser: 10 offline workflows passed (selection, mixed choices, drawer, undo, expiry, conflicts, and limit)')
} finally {
  await browser?.close()
  await server.close()
}
