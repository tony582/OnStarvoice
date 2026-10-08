import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Runs only against an ephemeral local fixture server: no live send/export calls.
// Build web/admin first. Supply PLAYWRIGHT_MODULE when Playwright is installed outside this repository.
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(root, 'output/playwright/customer-monthly');
await mkdir(output, {recursive: true});
const counts = (monitor, sdb, positive, neutral, cold = 0, comment = 0, negativeProcess = 0, negativeOther = 0) => ({monitor, sdb, positive, neutral, negative: cold + comment + negativeProcess + negativeOther, cold, comment, negativeProcess, negativeOther, inProgress: null, processed: null, unclassified: 0, nonMonitor: monitor - sdb});
const requests = [];
const stored = new Map();
let version = 1;
const reportFor = (month, nextVersion = 1) => {
  const rows = Array.from({length: 30}, (_, index) => ({date: `2026-09-${String(index + 1).padStart(2, '0')}`, counts: index % 3 === 0 ? counts(12, 11, 2, 7, 1, 1, 0, 0) : counts(0, 0, 0, 0)}));
  const total = counts(120, 110, 20, 70, 10, 10, 0, 0);
  return {id: `report-${month}-v${nextVersion}`, reportMonth: month, mode: 'formal', version: nextVersion, generatedAt: '2026-10-08T02:00:00Z',
    snapshot: {schemaVersion: 1, kind: 'customer_monthly_v1', tenantId: 'tenant-test', tenantName: '安吉星', reportMonth: month, mode: 'formal', periodStart: '2026-08-31T16:00:00.000Z', periodEnd: '2026-09-30T16:00:00.000Z',
      cutoffAt: '2026-09-30T16:00:00.000Z', assessedAt: '2026-10-08T02:00:00Z', complete: true, recordCount: 120,
      summary: {basis: 'published_ts_triage_scope_v1', total, rows,
        byTopic: [{topic: 'onstar', label: '安吉星', counts: counts(60, 55, 10, 35, 5, 5)}, {topic: 'infotainment', label: '车机', counts: counts(40, 36, 6, 24, 3, 3)}, {topic: 'wallpaper', label: '壁纸', counts: counts(20, 19, 4, 11, 2, 2)}],
        byPlatform: [{platform: 'xiaohongshu', label: '小红书', counts: counts(90, 82, 15, 52, 8, 7)}, {platform: 'douyin', label: '抖音', counts: counts(30, 28, 5, 18, 2, 3)}]},
      topNegative: [{recordId: 'hot-1', title: '车机升级后黑屏', platform: 'xiaohongshu', url: 'https://example.com/note', heat: 437, likes: 400, comments: 30, collects: 5, shares: 2, publishedAt: '2026-09-05T01:00:00Z', status: 'negative_cold', topicLabel: '车机'},
        {recordId: 'hot-2', title: '壁纸丢失求助', platform: 'douyin', url: 'https://example.com/note2', heat: 210, heatIsLowerBound: true, likes: 150, comments: 60, collects: 0, shares: null, publishedAt: '2026-09-09T01:00:00Z', status: 'negative_feishu', feishuTableNo: '26090901', topicLabel: '壁纸'}],
      warnings: [{code: 'published_time_missing', message: '本月采集入库的内容分诊帖子中3条缺少发布时间，无法按发帖时间归入月报。', blocking: false}],
      evidence: {recordCount: 120, missingPublishedCount: 3}},
    emailDelivery: {status: 'none', canRetry: false, ambiguous: false}};
};
const detail = report => ({report, html: '<p>月报</p>', text: '月报'});
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const path = url.pathname.startsWith('/admin/assets/') ? join(root, 'web/admin/dist/assets', url.pathname.split('/').at(-1)) : join(root, 'web/admin/dist/index.html');
      const data = await readFile(path);
      response.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(data); return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({path: url.pathname, method: request.method, body, query: Object.fromEntries(url.searchParams)});
    let data = {ok: true};
    if (url.pathname === '/api/auth/me') data = {ok: true, user: {id: 'test', name: '测试管理员', globalRole: 'platform_admin', is_internal: true}};
    else if (url.pathname === '/api/admin/tenants') data = {tenants: [{id: 'tenant-test', name: '安吉星'}]};
    else if (url.pathname === '/api/customer-monthly-reports/settings') data = {settings: {emailRecipients: 'fixture@example.test', emailReady: true}};
    else if (url.pathname === '/api/customer-monthly-reports/') {
      const month = url.searchParams.get('month');
      data = {reports: month === '2026-09' ? [...stored.values()].filter(report => report.reportMonth === month).sort((a, b) => b.version - a.version) : []};
      if (month === '2026-09' && !data.reports.length) { const first = reportFor(month, 1); stored.set(first.id, first); data.reports = [first]; }
    } else if (url.pathname === '/api/customer-monthly-reports/generate' && request.method === 'POST') {
      version += 1;
      const report = reportFor(body.month, version); stored.set(report.id, report); data = {report};
    } else if (/\/customer-monthly-reports\/report-/.test(url.pathname)) {
      const id = url.pathname.split('/')[3];
      const report = stored.get(id);
      if (request.method === 'POST' && url.pathname.endsWith('/email')) { report.emailDelivery = {status: 'queued', recipients: 'fixture@example.test', sendId: 'send-1'}; data = {report}; }
      else data = detail(report);
    }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({error: error.message})); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/admin/`;
const browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {})});
const errors = [];
async function open({width = 1440, mobile = false, query = ''} = {}) {
  const context = await browser.newContext({viewport: {width, height: 1100}, timezoneId: 'Asia/Shanghai'});
  const page = await context.newPage();
  await page.addInitScript(({mobile}) => {
    const OriginalDate = Date;
    class FixedDate extends OriginalDate { constructor(...args) { if (args.length) super(...args); else super('2026-10-08T02:00:00Z'); } static now() { return new OriginalDate('2026-10-08T02:00:00Z').getTime(); } }
    window.Date = FixedDate;
    localStorage.setItem('osv_ui_mode', mobile ? 'mobile' : 'desktop');
  }, {mobile});
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base}${query}`);
  return {page, context};
}
try {
  const desktop = await open({query: '?page=insights&tab=monthly'});
  const {page} = desktop;
  await page.getByRole('heading', {name: '客户舆情月报'}).waitFor();
  assert.equal(await page.getByLabel('报表月份').inputValue(), '2026-09', 'defaults to the previous Beijing month');
  const summary = page.getByRole('table', {name: '逐日发帖汇总及月合计'});
  await summary.waitFor();
  assert.equal(await summary.getByRole('cell', {name: '合计 平台监控量', exact: true}).innerText(), '120');
  assert.equal(await summary.getByRole('rowheader', {name: '2026/9/30', exact: true}).count(), 1);
  const topics = page.getByRole('table', {name: '内容主题分布及合计'});
  assert.equal(await topics.getByRole('rowheader', {name: '安吉星', exact: true}).count(), 1);
  assert.equal(await page.getByRole('table', {name: '平台分布及合计'}).getByRole('rowheader', {name: '抖音', exact: true}).count(), 1);
  const body = await page.locator('body').innerText();
  assert.match(body, /四、本月热度值≥200的负面帖子：2 条/);
  assert.match(body, /TOP1/);
  assert.match(body, /热度 至少 210/);
  assert.match(body, /飞书表 · 26090901|飞书表/);
  assert.match(body, /下载明细（120 条）/);
  await page.getByRole('button', {name: /查看数据说明/}).click();
  const explanation = await page.getByRole('dialog').innerText();
  assert.match(explanation, /缺少发布时间/);
  assert.match(explanation, /与按处理日期统计的客户日报口径不同/);
  await page.keyboard.press('Escape');
  await page.screenshot({path: join(output, 'september-desktop.png'), fullPage: true});
  await page.getByRole('button', {name: '更新月报', exact: true}).click();
  await page.getByText(/已生成 2026-09 月报第 2 版/).waitFor();
  const generate = requests.find(item => item.path === '/api/customer-monthly-reports/generate');
  assert.equal(generate.body.month, '2026-09');
  assert.match(generate.body.requestId, /^[0-9a-f-]{36}$/);
  await page.getByRole('button', {name: '发送邮件', exact: true}).click();
  await page.getByText('邮件已提交，等待发送').waitFor();
  assert.ok(requests.some(item => item.method === 'POST' && item.path.endsWith('/email')));
  await page.getByLabel('报表月份').fill('2026-10');
  await page.getByText(/2026-10 尚未生成月报/).waitFor();
  assert.ok(requests.some(item => item.path === '/api/customer-monthly-reports/' && item.query.month === '2026-10'));
  await desktop.context.close();
  const narrow = await open({width: 390, mobile: true, query: '?page=insights&tab=monthly'});
  await narrow.page.getByRole('table', {name: '逐日发帖汇总及月合计'}).waitFor();
  assert.equal(await narrow.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await narrow.page.screenshot({path: join(output, 'september-mobile.png'), fullPage: true});
  await narrow.context.close();
  assert.deepEqual(errors, []);
  console.log('PASS: monthly report page renders tables, topics, top negatives, data notes, generate and email flows on desktop and mobile; no console/page errors.');
} catch (error) { console.error(error); throw error; } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
