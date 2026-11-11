// Local fixture acceptance for the real list, same-post section and detail drawer.
// Remote requests are blocked; only this Vite server and fixture API are reachable.
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const records = [
    { title: '无关内容显示验收', triage_display_status: 'not_admitted', triage_display_reason: 'AI 判定无关' },
    { title: '预筛内容显示验收', triage_display_status: 'not_admitted', triage_display_reason: '已被采集预筛排除' },
    { title: '已准入内容显示验收', triage_display_status: 'unhandled', monitoring_evidence_status:'not_applicable', ai_result:{relevance:'relevant',monitoringEvidence:{status:'needs_review',reason:'需要品牌证据'}} },
    { title: '已复核内容显示验收', triage_status: 'reviewed', triage_display_status: 'reviewed' },
    { title: '已归档内容显示验收', triage_status: 'reviewed_non_monitor', triage_display_status: 'reviewed_non_monitor', archived_at: '2026-11-11T10:00:00Z' },
    { title: '关注内容显示验收', triage_display_status: 'watched_not_pending', triage_display_reason:'已关注的无关内容保留在工作列表，不计入待处理数量', is_watched:true },
  ].map((row, index) => ({ id: `${index+1}1111111-1111-4111-8111-111111111111`, platform: ['douyin','xiaohongshu','wechat_channels'][index%3], author_name: '测试作者', content: '验收用完整正文', triage_status: 'unhandled', archived_at: null, created_at: '2026-11-11T08:00:00Z', sentiment: 'neutral', likes: 1, comments_count: 0, collects: 0, shares: 0, ...row }))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== base) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const path = url.pathname.slice(4)
    const send = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/auth/me') return send({ ok:true, user: { id: 'user', memberships: [{ tenantId: 'fixture', tenantName: '离线验收', role: 'tenant_analyst', status: 'active' }] } })
    if (path === '/workspace/badges') return send({ badges: {} })
    // Outside rows model the existing edit-context behavior: an edited row is
    // retained until refresh instead of disappearing during the user's action.
    if (path === '/triage/records') return send({ records, pagination: { page: 1, totalPages: 1, total: records.length } })
    if (path.endsWith('/cross-posts')) return send({ groupId: records[0].id, members: records.map(row => ({ ...row, author: row.author_name })) })
    if (path.startsWith('/opinion-analysis/records/') && path.endsWith('/detail')) return send({ record: records.find(row => path.includes(row.id)) })
    if (path.startsWith('/opinion-analysis/records/')) return send({ analysis: null })
    if (path.endsWith('/comments')) return send({ comments: [], officialResponses: [] })
    if (path.endsWith('/observations')) return send({ observations: [] })
    if (path.endsWith('/activity')) return send({ activity: [] })
    return send({ tags: [], keywords: [], options: [] })
  })
  for (const width of [1440,390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1050 })
    await page.goto(`${base}/admin/test/fixtures/cross-posts.html`)
    const title = page.getByText(records[0].title,{exact:true}).filter({visible:true})
    await title.waitFor()
    assert.equal(await page.getByText('未进入工作列表',{exact:true}).filter({visible:true}).count(),2,`list ${width}`)
    assert.equal(await page.getByRole('button',{name:'当前处理状态：待处理，点击修改',exact:true}).filter({visible:true}).count(),1,`only eligible pending ${width}`)
    await title.click()
    const drawer=page.getByRole('dialog',{name:'舆情内容详情'}),section=drawer.getByRole('region',{name:'其它平台同发'})
    await section.getByText('预筛内容显示验收',{exact:true}).waitFor()
    assert.equal(await section.getByText('未进入工作列表',{exact:true}).count(),2)
    assert.equal(await section.getByText('待处理',{exact:true}).count(),1)
    assert.equal(await section.getByText('已关注（不计待处理）',{exact:true}).count(),1)
    assert.equal(await section.getByText('已复核',{exact:true}).count(),1)
    assert.equal(await section.getByText('已复核-非监控内容',{exact:true}).count(),1)
    assert.equal(await section.getByText('已归档',{exact:true}).count(),1)
    const footer=drawer.getByLabel('处理状态',{exact:true})
    assert.equal(await footer.getByText('未进入工作列表',{exact:true}).count(),1)
    await footer.getByText('未进入工作列表',{exact:true}).hover()
    await drawer.getByText('AI 判定无关',{exact:true}).waitFor()
    await page.mouse.move(1,1)
    await section.getByRole('button',{name:'预筛内容显示验收',exact:true}).click()
    await drawer.getByRole('heading',{name:'预筛内容显示验收',exact:true}).waitFor()
    await drawer.getByLabel('处理状态',{exact:true}).getByText('未进入工作列表',{exact:true}).hover()
    await drawer.getByText('已被采集预筛排除',{exact:true}).waitFor()
    assert.equal(await drawer.getByRole('button',{name:/人工纳入|纳入工作列表/}).count(),0)
    await page.mouse.move(1,1)
    await section.getByRole('button',{name:'已准入内容显示验收',exact:true}).click()
    await drawer.getByRole('button',{name:'当前处理状态：待处理，点击修改',exact:true}).waitFor()
    assert.equal(await drawer.getByText('需要品牌证据',{exact:true}).count(),0)
    await section.getByRole('button',{name:'关注内容显示验收',exact:true}).click()
    await drawer.getByLabel('处理状态',{exact:true}).getByText('已关注（不计待处理）',{exact:true}).waitFor()
    await section.getByRole('button',{name:'已归档内容显示验收',exact:true}).click()
    await drawer.getByText('内容已封存',{exact:true}).waitFor()
    assert.equal(await section.getByRole('checkbox').count(),0,'archived drawer does not offer batch handling')
  }
  assert.deepEqual(errors,[])
  console.log('Triage display browser acceptance passed: desktop/mobile list, cross-post badges, full drawer switch, outside reasons on hover, admitted pending, reviewed and archived preservation, no admission button.')
} finally { await browser?.close();await server.close() }
