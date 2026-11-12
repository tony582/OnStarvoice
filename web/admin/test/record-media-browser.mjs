// Offline UI regression. Every API is a fixture; all external requests are blocked.
import assert from 'node:assert/strict'
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } })
  const errors = [], requests = []
  let scenario = {}, generated = false
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== base) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const path = url.pathname.slice(4)
    requests.push(`${request.method()} ${path}`)
    const send = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/auth/me') return send({ ok: true, user: { id: 'user', memberships: [{ tenantId: 'fixture', tenantName: '离线验收', role: 'tenant_analyst', status: 'active' }] } })
    const id = path.includes('/replacement/') ? 'replacement' : scenario.id || 'fixture'
    const record = { id, platform: scenario.platform || 'wechat_channels', title: '离线媒体与评论验收', content: '采集到的正文', note_type: 'video', sentiment: 'neutral',
      comments_capture_status: scenario.status || 'empty',
      ...(scenario.media === 'video' && id !== 'replacement' ? { video_url: 'https://media.example/v.mp4' } : {}),
      ...(scenario.media === 'audio' ? { audio_url: 'https://media.example/a.mp3' } : {}),
      ...(scenario.text || generated ? { transcript: '已保存的逐字稿', transcript_status: 'done' } : {}),
      ...(scenario.stale ? { transcript_status: 'processing' } : {}) }
    const comments = ['captured', 'partial'].includes(scenario.status) ? [{ id: 'comment', author_name: '评论者', content: '这是采集到的评论内容', sentiment: 'neutral' }] : []
    if (path.endsWith('/detail')) {
      if (scenario.delay && id !== 'replacement') await new Promise(resolve => setTimeout(resolve, 400))
      return send({ record }).catch(() => {}) // Switching the drawer aborts the old request.
    }
    if (path.endsWith('/source')) return send({ record, comments, officialResponses: [], observations: [], notes: [] })
    if (path.endsWith('/comments')) return send({ comments, officialResponses: [] })
    if (path.endsWith('/observations')) return send({ observations: [] })
    if (path.endsWith('/activity')) return send({ activity: [] })
    if (path.endsWith('/transcribe')) { generated = true; return send({ status: 'done' }) }
    if (path.endsWith('/transcript')) return send({ transcript: record.transcript || '', transcript_status: record.transcript_status || 'none' })
    if (path.endsWith('/wechat-forwards')) return send({ forwards: [], recipients: [] })
    return send({ analysis: null, members: [] })
  })
  const open = async options => {
    scenario = options; generated = false; requests.length = 0
    await page.goto(`${base}/admin/test/fixtures/record-media.html?${new URLSearchParams(options)}`)
    await page.getByRole('button', { name: '切换记录', exact: true }).waitFor()
    if (options.mode !== 'cell') await page.getByText('采集到的正文', { exact: true }).waitFor()
    await page.waitForTimeout(100)
  }
  const noGeneration = async () => assert.equal(await page.getByRole('button', { name: /生成逐字稿|重新生成/ }).count(), 0)
  const noMediaRequest = () => assert.deepEqual(requests.filter(path => /\/(video|transcript|transcribe)$/.test(path)), [])

  for (const mode of ['drawer', 'cell']) {
    await open({ mode, stale: '1' })
    await page.getByText(/视频号视频请在微信中查看/).waitFor()
    await noGeneration(); noMediaRequest()
    assert.equal(await page.getByRole('button', { name: '播放视频' }).count(), 0)

    await open({ mode, text: '1' })
    await page.getByText('已保存的逐字稿', { exact: true }).waitFor()
    await noGeneration()
    assert.equal(await page.getByRole('button', { name: '播放视频' }).count(), 0)
    assert.equal(requests.filter(path => /\/(video|transcribe)$/.test(path)).length, 0)

    for (const platform of ['douyin', 'xiaohongshu']) {
      await open({ mode, platform, media: 'video' })
      const generate = page.getByRole('button', { name: '生成逐字稿', exact: true })
      await generate.waitFor()
      if (mode === 'drawer') await page.getByRole('button', { name: '播放视频' }).waitFor()
      await generate.click()
      await page.getByText('已保存的逐字稿', { exact: true }).waitFor()
      assert.ok(requests.includes('POST /records/fixture/transcribe'))
      assert.ok(requests.includes('GET /records/fixture/transcript'))
    }
    await open({ mode, platform: 'douyin', media: 'audio' })
    await page.getByRole('button', { name: '生成逐字稿', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '播放视频' }).count(), 0)
  }

  for (const mode of ['drawer', 'ticket']) for (const platform of ['wechat_channels', 'wechat_articles']) {
    const noun = platform === 'wechat_articles' ? '留言' : '评论'
    const titles = { captured: `已采集${noun}`, partial: `${noun}未采完整`, empty: `暂无可见${noun}`, disabled: `未开启${noun}采集`, not_relocated: '未重新定位到原帖' }
    for (const [status, title] of Object.entries(titles)) {
      await open({ mode, platform, status })
      await page.getByRole(mode === 'drawer' ? 'tab' : 'button', { name: new RegExp(`^${noun}( \\(\\d+\\))?$`) }).click()
      await page.getByText(title, { exact: true }).waitFor()
      assert.equal(await page.getByText(/需要在.*开启评论采集/).count(), 0)
    }
  }

  // A late detail response for a previous record must not enable the new drawer's media.
  scenario = { mode: 'drawer', platform: 'douyin', media: 'video', delay: '1' }; requests.length = 0
  await page.goto(`${base}/admin/test/fixtures/record-media.html?${new URLSearchParams(scenario)}`)
  await page.getByRole('button', { name: '切换记录', exact: true }).click()
  await page.getByText('采集到的正文', { exact: true }).waitFor()
  await page.waitForTimeout(500)
  await noGeneration()
  assert.equal(await page.getByRole('button', { name: '播放视频' }).count(), 0)
  assert.equal(requests.includes('GET /records/replacement/transcript'), false)
  assert.deepEqual(errors, [])
  console.log('record media browser: 31 offline scenarios passed (media, saved transcript, comment states, and canceled drawer request)')
} finally {
  await browser?.close()
  await server.close()
}
