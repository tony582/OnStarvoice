import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isWorkingDate, nextWorkingDate, previousWorkingDate, workCalendarMonth} from '../server/services/china-work-calendar.js';

// Runs only against an ephemeral local fixture server: no live send/export calls.
// Build web/admin first. Supply PLAYWRIGHT_MODULE when Playwright is installed outside this repository.
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(root, 'output/playwright/customer-daily');
await mkdir(output, {recursive: true});
const baseCounts = {monitor: 30, sdb: 25, positive: 3, neutral: 15, negative: 7, cold: 2, comment: 2, negativeProcess: 2, negativeOther: 1, inProgress: null, processed: null, unclassified: 0, nonMonitor: 5};
const requests = [];
const stored = new Map();
const reportFor = date => {
  if (stored.has(date)) return stored.get(date);
  const v1 = date === '2026-09-09';
  const rows = workCalendarMonth(date.slice(0, 7)).days.filter(day => day.date <= date).map(day => ({date: day.date, isWorkingDay: day.isWorkingDay, counts: {...baseCounts}}));
  const report = {id: `report-${date}`, reportDate: date, mode: 'formal', version: 2, generatedAt: `${date}T10:00:00Z`,
    snapshot: {schemaVersion: v1 ? 1 : 2, tenantId: 'tenant-test', tenantName: '安吉星', reportDate: date, mode: 'formal', periodStart: `${date}T00:00:00+08:00`, cutoffAt: `${date}T18:00:00+08:00`, assessedAt: `${date}T19:00:00+08:00`, monthStart: `${date.slice(0, 7)}-01`, heatStart: '2026-09-03T00:00:00+08:00',
      summary: {day: {...baseCounts}, mtd: {...baseCounts, monitor: 240}, ...(!v1 ? {format: 'daily_disposition_v2', dayDate: date, rows} : {})},
      highHeat: [{recordId: 'heat-1', title: '车机升级后使用体验反馈', platform: 'xiaohongshu', url: 'https://example.com/note', heat: 265, comparisonText: '+12'}], coldMarked: [], evidence: {cold: {coverageComplete: true}}, warnings: [{code: 'fixture', message: '部分互动数据待核对', blocking: true}]},
    delivery: {status: date === '2026-09-08' ? 'needs_attention' : 'none', canRetry: false, ...(date === '2026-09-08' ? {error: '飞书结果未知'} : {})},
    emailDelivery: {status: date === '2026-09-08' ? 'failed' : 'none', ...(date === '2026-09-08' ? {ambiguous: true, canRetry: false, error: '邮件结果未知'} : {})}};
  stored.set(date, report);
  return report;
};
const detail = report => ({report, html: '<p>日报</p>', text: '日报', messageHtml: '<p>日报正文</p>', messageText: '日报正文'});
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
    requests.push({path: url.pathname, method: request.method, body});
    let data = {ok: true};
    if (url.pathname === '/api/auth/me') data = {ok: true, user: {id: 'test', name: '测试管理员', globalRole: 'platform_admin', is_internal: true}};
    else if (url.pathname === '/api/admin/tenants') data = {tenants: [{id: 'tenant-test', name: '安吉星'}]};
    else if (url.pathname.endsWith('/settings')) data = {settings: {chatName: '客户日报群', emailRecipients: 'fixture@example.test', emailReady: true}};
    else if (url.pathname.endsWith('/calendar-month')) {
      const calendar = workCalendarMonth(url.searchParams.get('month'));
      data = {calendar: {...calendar, days: calendar.days.map(day => ({...day, hasReport: ['2026-09-08', '2026-09-09', '2026-09-10'].includes(day.date)}))}};
    } else if (url.pathname.endsWith('/calendar')) {
      const date = url.searchParams.get('date');
      data = {calendar: {defaultReportDate: previousWorkingDate(date, {inclusive: true}), isWorkingDay: isWorkingDate(date), nextWorkingDate: nextWorkingDate(date), collectionBoundaryTime: '18:00', revision: 'fixture-official'}};
    } else if (url.pathname === '/api/customer-daily-reports/') {
      const report = reportFor(url.searchParams.get('date'));
      data = {reports: [report, {...report, id: `${report.id}-previous`, version: 1, snapshot: undefined, delivery: {status: 'sent'}}]};
    } else if (/\/customer-daily-reports\/report-/.test(url.pathname)) {
      const date = url.pathname.match(/report-(\d{4}-\d{2}-\d{2})/)[1];
      const report = reportFor(date);
      if (request.method === 'POST') {
        if (url.pathname.endsWith('/summary')) {
          if (body.summary.rows) { for (const row of report.snapshot.summary.rows) if (body.summary.rows[row.date]) row.counts = {...row.counts, ...body.summary.rows[row.date]}; }
          else report.snapshot.summary = body.summary;
          report.snapshot.summaryEdited = true;
        } else if (url.pathname.endsWith('/email')) report.emailDelivery = {status: 'queued'};
        else if (url.pathname.endsWith('/send')) report.delivery = {status: 'queued'};
        data = {report};
      } else data = detail(report);
    }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({error: error.message})); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/admin/`;
const browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {})});
const errors = [];
async function open({width = 1440, mobile = false, date = '', query = ''} = {}) {
  const context = await browser.newContext({viewport: {width, height: 1100}, timezoneId: 'Asia/Shanghai'});
  const page = await context.newPage();
  await page.addInitScript(({mobile}) => {
    const OriginalDate = Date;
    class FixedDate extends OriginalDate { constructor(...args) { if (args.length) super(...args); else super('2026-09-10T02:00:00Z'); } static now() { return new OriginalDate('2026-09-10T02:00:00Z').getTime(); } }
    window.Date = FixedDate;
    localStorage.setItem('osv_ui_mode', mobile ? 'mobile' : 'desktop');
  }, {mobile});
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base}${query || (date ? `?page=insights&tab=daily&date=${date}` : '')}`);
  await page.getByRole('heading', {name: '客户舆情日报', exact: true}).waitFor();
  await page.getByRole('button', {name: '编辑汇总', exact: true}).waitFor();
  return {page, context};
}
try {
  const {page, context} = await open();
  await page.getByRole('table', {name: '逐日监控汇总与月累计'}).waitFor();
  assert.equal(await page.getByRole('checkbox').count(), 0);
  assert.equal(await page.getByRole('button', {name: '发送更正版'}).isEnabled(), true);
  assert.equal(await page.getByRole('button', {name: '发送邮件', exact: true}).isEnabled(), true);
  await page.getByRole('button', {name: /2026-09-20，调班工作日/}).waitFor();
  await page.getByRole('button', {name: /2026-09-25，法定休假/}).waitFor();
  const selected = page.getByRole('button', {name: /2026-09-10，工作日/});
  await selected.focus(); await page.keyboard.press('ArrowLeft');
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /2026-09-09/);
  await page.screenshot({path: join(output, 'desktop.png'), fullPage: true});
  await page.getByRole('button', {name: '上一月', exact: true}).click();
  await page.getByRole('button', {name: /2026-08-31，工作日/}).waitFor();
  await page.getByRole('button', {name: '下一月', exact: true}).click();
  await page.getByRole('button', {name: /2026-09-06，周末休息/}).click();
  await page.getByText('非工作日，采集内容合并至 2026-09-07 日报。').waitFor();
  assert.equal(await page.getByRole('button', {name: '更新日报', exact: true}).isDisabled(), true);
  await page.getByRole('button', {name: /2026-09-10，工作日/}).click();
  await page.getByRole('table', {name: '逐日监控汇总与月累计'}).waitFor();

  await page.getByRole('button', {name: '编辑汇总', exact: true}).click();
  await page.getByRole('textbox', {name: '2026-09-01 平台监控量', exact: true}).fill('60');
  assert.equal(await page.getByRole('cell', {name: 'MTD 平台监控量', exact: true}).innerText(), '270');
  assert.equal(await page.getByRole('textbox', {name: /2026-09-05/}).count(), 0);
  assert.equal(await page.getByRole('button', {name: '发送邮件', exact: true}).isDisabled(), true);
  assert.equal(await page.getByLabel('报表日期', {exact: true}).isDisabled(), true);
  assert.equal(await page.getByRole('button', {name: '导出 Excel', exact: true}).isDisabled(), true);
  await page.getByRole('button', {name: '保存汇总', exact: true}).click();
  await page.getByText('汇总已保存，可下载或发送更新后的日报。').waitFor();
  const saved = requests.findLast(item => item.path.endsWith('/summary'));
  assert.equal(saved.body.summary.rows['2026-09-01'].monitor, 60);
  assert.equal(saved.body.summary.rows['2026-09-05'], undefined);
  assert.equal(saved.body.summary.mtd, undefined);
  await page.getByRole('button', {name: '更新日报', exact: true}).click();
  await page.getByRole('alertdialog').waitFor(); await page.getByRole('button', {name: '取消', exact: true}).click();
  await page.getByRole('button', {name: '发送更正版', exact: true}).click();
  await page.getByText('已提交，通常在下一分钟开始准备').waitFor();
  assert.deepEqual(requests.findLast(item => item.path.endsWith('/send')).body, {allowIncomplete: true, correction: true});
  await page.getByRole('button', {name: '发送邮件', exact: true}).click();
  await page.getByText('邮件已提交，等待发送').waitFor();
  assert.equal(requests.findLast(item => item.path.endsWith('/email')).body, undefined);
  await context.close();

  const legacy = await open({date: '2026-09-09'});
  await legacy.page.getByRole('table', {name: '监控汇总与月累计', exact: true}).waitFor();
  await legacy.page.getByRole('button', {name: '编辑汇总', exact: true}).click();
  await legacy.page.getByRole('textbox', {name: '当日处理中', exact: true}).fill('3');
  await legacy.page.getByRole('button', {name: '保存汇总', exact: true}).click();
  await legacy.page.getByText('汇总已保存，可下载或发送更新后的日报。').waitFor();
  assert.equal(requests.findLast(item => item.path.endsWith('/summary')).body.summary.day.inProgress, 3);
  assert.equal(requests.findLast(item => item.path.endsWith('/summary')).body.summary.rows, undefined);
  await legacy.context.close();

  const unknown = await open({date: '2026-09-08'});
  assert.equal(await unknown.page.getByRole('button', {name: '发送更正版', exact: true}).isDisabled(), true);
  assert.equal(await unknown.page.getByRole('button', {name: '发送邮件', exact: true}).isDisabled(), true);
  await unknown.context.close();

  const explicitContext = await browser.newContext({viewport:{width:1440,height:900}});
  const explicitPage = await explicitContext.newPage();
  await explicitPage.goto(`${base}?page=insights&tab=dashboard`);
  await explicitPage.waitForLoadState('networkidle');
  assert.equal(await explicitPage.getByRole('heading', {name:'客户舆情日报',exact:true}).count(),0);
  await explicitContext.close();

  const narrow = await open({width: 390, mobile: true});
  await narrow.page.getByRole('button', {name: /日报日历/}).click();
  await narrow.page.getByRole('button', {name: /2026-09-25，法定休假/}).waitFor();
  await narrow.page.screenshot({path: join(output, 'mobile.png'), fullPage: true});
  assert.equal(await narrow.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await narrow.context.close();
  assert.deepEqual(errors, []);
  console.log('PASS: desktop/mobile default entry, official calendar, keyboard focus, V2 editing and MTD, V1 compatibility, correction/email payloads, uncertain-send protection; no console/page errors.');
} catch (error) { console.error(error); throw error; } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
