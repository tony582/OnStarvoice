// Offline browser acceptance: all API responses are fixtures, external requests are blocked.
// Supply PLAYWRIGHT_MODULE with a locally installed playwright module if it is not in node_modules.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const root = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
await server.listen()
const base = `http://127.0.0.1:${server.httpServer.address().port}`
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222', c = '33333333-3333-4333-8333-333333333333'
  const records = [
    { id: a, platform: 'douyin', title: '贺兰山壁纸测试原文', content: '完整正文：充电时山会显示在屏幕中间。', author_name: '凯迪电车之家', triage_status: 'unhandled' },
    { id: b, platform: 'wechat_channels', title: '贺兰山壁纸视频号原文', content: '切换后的完整正文：充电时山会显示在屏幕中间。', author_name: '凯迪电车之家', triage_status: 'reviewed' },
    { id: c, platform: 'xiaohongshu', title: '独立内容不能一起处理', content: '其它文章', author_name: '另外的作者', triage_status: 'unhandled' },
  ].map(record => ({ ...record, created_at: '2026-11-11T08:00:00Z', published_ts: '2026-11-10T08:00:00Z', sentiment: 'neutral', archived_at: null, likes: 1, comments_count: 0, collects: 0, shares: 0 }))
  let excluded = false
  let failExclude = false
  let failBatch = false
  const batches = [], exclusions = [], listQueries = []
  const member = record => ({ id: record.id, platform: record.platform, title: record.title, author: record.author_name, triage_status: record.triage_status, published_at: record.published_ts, created_at: record.created_at, archived_at: record.archived_at })
  const grouped = record => ({ ...record, cross_post_group_id: !excluded && record.id !== c ? a : null, cross_post_count: !excluded && record.id !== c ? 2 : 0, cross_post_platforms: !excluded && record.id !== c ? ['douyin', 'wechat_channels'] : [] })
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== base) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const path = url.pathname.slice(4)
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/auth/me') return send({ ok: true, user: { id: 'user', memberships: [{ tenantId: 'fixture', tenantName: '离线验收', role: 'tenant_analyst', status: 'active' }] } })
    if (path === '/workspace/badges') return send({ ok: true, badges: {} })
    if (path === '/triage/records') {
      listQueries.push(url.searchParams.toString())
      const result = records.map(grouped).filter(record => url.searchParams.get('crossPlatform') !== 'true' || record.cross_post_count > 1)
      return send({ records: result, pagination: { page: 1, totalPages: 1, total: result.length } })
    }
    if (path.endsWith('/cross-posts/exclude')) {
      const body = route.request().postDataJSON()
      exclusions.push(body)
      if (failExclude) return send({ message: '离线模拟排除失败' }, 503)
      excluded = true
      return send({ ok: true })
    }
    if (path.endsWith('/cross-posts')) return send({ groupId: excluded ? null : a, members: excluded ? [] : records.slice(0, 2).map(member) })
    if (path === '/triage/records/batch') {
      const body = route.request().postDataJSON()
      if (failBatch) return send({ message: '离线模拟处理失败' }, 503)
      batches.push(body)
      for (const record of records) if (body.ids.includes(record.id)) record.triage_status = body.status
      return send({ updatedIds: body.ids, updated: body.ids.length, skipped: [] })
    }
    if (path.startsWith('/opinion-analysis/records/')) return send({ record: records.find(record => path.includes(record.id)) })
    if (path.endsWith('/comments')) return send({ comments: [], officialResponses: [] })
    if (path.endsWith('/observations')) return send({ observations: [] })
    if (path.endsWith('/activity')) return send({ activity: [] })
    return send({ tags: [], keywords: [], options: [] })
  })
  await page.goto(`${base}/admin/test/fixtures/cross-posts.html`)
  await page.getByText('贺兰山壁纸测试原文', { exact: true }).last().waitFor()
  assert.equal(await page.getByText('多平台 ×2', { exact: true }).filter({ visible: true }).count(), 2)
  assert.ok(await page.getByRole('img', { name: '视频号', exact: true }).filter({ visible: true }).count() > 0)
  assert.ok(await page.getByRole('img', { name: '抖音', exact: true }).filter({ visible: true }).count() > 0)
  await page.getByRole('button', { name: '多平台同发', exact: true }).click()
  await page.waitForFunction(() => !document.body.innerText.includes('独立内容不能一起处理'))
  assert.ok(listQueries.some(query => new URLSearchParams(query).get('crossPlatform') === 'true'))
  await page.getByText('贺兰山壁纸测试原文', { exact: true }).last().click()
  let section = page.getByRole('region', { name: '其它平台同发' })
  await section.getByRole('checkbox', { name: '选择当前内容' }).waitFor()
  assert.equal(await section.getByRole('checkbox', { name: '选择当前内容' }).isChecked(), true)
  assert.equal(await section.getByRole('checkbox', { name: '选择贺兰山壁纸视频号原文' }).isChecked(), false)
  await section.getByRole('checkbox', { name: '选择贺兰山壁纸视频号原文' }).check()
  if (process.env.CROSS_POST_SCREENSHOT) {
    await mkdir(dirname(process.env.CROSS_POST_SCREENSHOT), { recursive: true })
    await page.screenshot({ path: process.env.CROSS_POST_SCREENSHOT, fullPage: true })
  }
  await section.getByRole('button', { name: '一起处理（2）' }).click()
  await page.getByRole('menuitem', { name: '已复核', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(batches.length, 0, 'cancel must not mutate any record')
  await section.getByRole('button', { name: '一起处理（2）' }).click()
  await page.getByRole('menuitem', { name: '已复核', exact: true }).click()
  await page.getByRole('button', { name: '确认修改', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-labelledby="status-change-title"]'))
  await section.getByRole('button', { name: '一起处理（2）' }).waitFor({ state: 'visible' })
  assert.deepEqual(batches[0].ids.sort(), [a, b].sort())
  assert.equal(records[2].triage_status, 'unhandled')
  await section.getByRole('button', { name: '贺兰山壁纸视频号原文', exact: true }).click()
  await page.getByText('切换后的完整正文：充电时山会显示在屏幕中间。', { exact: true }).waitFor()
  section = page.getByRole('region', { name: '其它平台同发' })
  assert.equal(await section.getByRole('checkbox', { name: '选择当前内容' }).isChecked(), true)
  assert.equal(await section.getByRole('checkbox', { name: '选择贺兰山壁纸测试原文' }).isChecked(), false)
  failBatch = true
  await section.getByRole('button', { name: '一起处理（1）' }).click()
  await page.getByRole('menuitem', { name: '已回复', exact: true }).click()
  await page.getByRole('button', { name: '确认修改', exact: true }).click()
  await page.getByText('批量修改失败：离线模拟处理失败', { exact: true }).waitFor()
  assert.equal(records[1].triage_status, 'reviewed')
  failBatch = false
  failExclude = true
  await section.getByRole('button', { name: '不是同一内容', exact: true }).click()
  await section.getByRole('alert').filter({ hasText: '离线模拟排除失败' }).waitFor()
  assert.equal(await section.getByRole('checkbox').count(), 2)
  failExclude = false
  await section.getByRole('button', { name: '不是同一内容', exact: true }).click()
  await section.waitFor({ state: 'hidden' })
  await page.getByText('多平台 ×2', { exact: true }).first().waitFor({ state: 'hidden' })
  assert.deepEqual(exclusions, [{ recordId: a }, { recordId: a }])
  assert.equal(await page.getByRole('button', { name: '多平台同发', exact: true }).getAttribute('aria-pressed'), 'true')
  excluded = false
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.getByText('贺兰山壁纸测试原文', { exact: true }).filter({ visible: true }).waitFor()
  assert.equal(await page.getByText('多平台 ×2', { exact: true }).filter({ visible: true }).count(), 2)
  await page.getByText('贺兰山壁纸测试原文', { exact: true }).filter({ visible: true }).click()
  section = page.getByRole('region', { name: '其它平台同发' })
  await section.getByRole('button', { name: '一起处理（1）' }).waitFor()
  assert.equal(await section.getByRole('checkbox', { name: '选择当前内容' }).isChecked(), true)
  assert.deepEqual(errors, [])
  console.log('Cross-post offline browser acceptance passed: desktop/mobile badge and icons, filter, default selection, cancel, selected-only batch, full drawer switch, independent statuses, error retention, exclusion and refresh.')
} finally {
  await browser?.close()
  await server.close()
}
