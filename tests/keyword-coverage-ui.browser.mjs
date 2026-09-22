import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {allocateKeywordWorkItems} from '../server/services/capture-orchestration.js';

// Builds the real composer against an ephemeral fixture API; never calls a live API.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const admin = join(root, 'web/admin');
const output = join(root, 'output/playwright/keyword-coverage');
const {build} = await import(join(admin, 'node_modules/vite/dist/node/index.js'));
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = `coverage-fixture-${randomUUID()}`;
const html = join(admin, `${name}.html`);
const entry = join(admin, `${name}.tsx`);
const dist = join(output, 'dist');
await mkdir(output, {recursive: true});
const keywords = ['别克壁纸', '凯迪拉克壁纸', '安吉星壁纸', '安吉星车机壁纸', '月兔栖梦', '檐下秋意',
  ...Array.from({length: 10}, (_, i) => `常规关键词${i + 1}`)];
const agents = Array.from({length: 6}, (_, i) => ({id: randomUUID(), display_name: `采集节点 ${i + 1}`,
  host_label: `设备 ${i + 1}`, browser_name: 'Chrome', operating_system: 'Windows', app_version: '0.4.11',
  status: 'active', online: true, allowed_platforms: ['xiaohongshu', 'douyin'],
  capabilities: {remoteTaskCreate: true, remoteTaskKeywordPostLimit: true, supportedPlatforms: ['xiaohongshu', 'douyin']}}));
const agentIds = agents.map(agent => agent.id);
const plans = new Map();
const writes = [];
function planFor(platform, legacy = false) {
  const key = `${platform}:${legacy}`;
  if (plans.has(key)) return plans.get(key);
  const id = randomUUID();
  const snapshot = {keywords, keywordCoverage: legacy ? 'each_agent' : 'shared', keywordMaxDetectedItems: 20,
    mode: 'daily', startTime: '21:15', randomOffsetMin: 2, searchFilters: {sort: 'comprehensive', publishTime: 'day'}};
  const plan = {orchestration: {id, title: '日常巡检', platform, status: 'pending',
    metadata: {planSnapshot: snapshot, eligibleAgentIds: agentIds, distributionMode: 'elastic_pool'}},
    schedule: {id: randomUUID(), status: 'active', revision: 1, schedule_mode: 'daily', start_time: '21:15',
      distribution_mode: 'elastic_pool', plan_snapshot: snapshot}, agents,
    items: allocateKeywordWorkItems({...snapshot, agentIds}).items.map(item => ({...item, id: randomUUID(), metadata: {keyword: item.keyword, ...item.metadata}}))};
  plans.set(key, plan);
  return plan;
}
let browser;
let server;
try {
  await writeFile(html, `<html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/${name}.tsx"></script></html>`);
  await writeFile(entry, `import React, {useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {OrchestrationComposerDrawer} from './src/pages/dispatch/cloud-tasks/OrchestrationComposerDrawer';
import './src/index.css';
function Harness(){const [data,setData]=useState(null);useEffect(()=>{fetch('/fixture'+location.search).then(r=>r.json()).then(setData)},[]);
return data ? <OrchestrationComposerDrawer open writable agents={data.agents} editingPlan={data.plan} onClose={()=>{}} /> : null}
createRoot(document.getElementById('root')).render(<Harness/>);`);
  await build({root: admin, configFile: join(admin, 'vite.config.ts'), logLevel: 'error',
    build: {outDir: dist, emptyOutDir: true, rollupOptions: {input: html}}});
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname === '/fixture') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({agents, plan: planFor(url.searchParams.get('platform') || 'xiaohongshu', url.searchParams.has('legacy'))}));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        assert.equal(request.method, 'PATCH');
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw); writes.push(body);
        const plan = [...plans.values()].find(value => url.pathname.includes(value.orchestration.id));
        assert.ok(plan);
        const snapshot = {...plan.schedule.plan_snapshot, ...body, ...body.schedule};
        plan.schedule = {...plan.schedule, revision: plan.schedule.revision + 1, plan_snapshot: snapshot};
        plan.orchestration.metadata.planSnapshot = snapshot;
        plan.items = allocateKeywordWorkItems(body).items.map(item => ({...item, id: randomUUID(), metadata: {keyword: item.keyword, ...item.metadata}}));
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ok: true, orchestrationId: plan.orchestration.id,
          revision: plan.schedule.revision, schedule: plan.schedule, itemCount: plan.items.length, agentIds}));
        return;
      }
      const path = url.pathname.startsWith('/admin/assets/')
        ? join(dist, 'assets', url.pathname.split('/').at(-1)) : join(dist, `${name}.html`);
      response.setHeader('content-type', path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(await readFile(path));
    } catch (error) { response.writeHead(500).end(JSON.stringify({error: error.message})); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/`;
  browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {})});
  const page = await browser.newPage({viewport: {width: 1440, height: 1050}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  for (const platform of ['xiaohongshu', 'douyin']) {
    await page.goto(`${base}?platform=${platform}`);
    const coverage = page.getByRole('group', {name: '每个所选节点都采集的关键词'});
    await coverage.waitFor();
    await coverage.getByRole('checkbox').first().waitFor();
    assert.equal(await page.getByText('壁纸关键词快捷选择').count(), 0);
    assert.equal(await coverage.getByRole('checkbox').count(), 16);
    for (const keyword of keywords.slice(0, 6)) await coverage.getByRole('checkbox', {name: keyword, exact: true}).check();
    await coverage.getByText('6 个词 × 6 个节点 + 10 个分工词 = 46 个工作项', {exact: false}).waitFor();
    await coverage.scrollIntoViewIfNeeded();
    await page.screenshot({path: join(output, `${platform}-desktop.png`)});
    await page.getByRole('button', {name: '预览计划修改', exact: true}).click();
    await page.getByText('46 个关键词工作项', {exact: false}).waitFor();
    await page.getByRole('button', {name: '保存修改', exact: true}).click();
    await page.getByRole('heading', {name: '计划修改已保存'}).waitFor();
    assert.deepEqual(writes.at(-1).eachAgentKeywords, keywords.slice(0, 6));
    assert.equal(writes.at(-1).platform, platform);
    assert.equal(writes.at(-1).keywordCoverage, 'each_agent');
    await page.reload();
    await coverage.waitFor();
    await coverage.getByRole('checkbox').first().waitFor();
    assert.equal(await coverage.locator('input:checked').count(), 6, 'saved selection survives reload');
    await page.getByRole('textbox', {name: /^关键词（每行一个）/}).fill([...keywords.slice(1), '新增关键词'].join('\n'));
    assert.equal(await coverage.locator('input:checked').count(), 5, 'removed words lose selection');
    assert.equal(await coverage.getByRole('checkbox', {name: '新增关键词', exact: true}).isChecked(), false);
    await page.getByRole('combobox', {name: /^先选采集平台/}).selectOption(platform === 'douyin' ? 'xiaohongshu' : 'douyin');
    assert.equal(await coverage.locator('input:checked').count(), 5, 'both platforms retain the selected scope');
    await page.setViewportSize({width: 390, height: 1000});
    await coverage.scrollIntoViewIfNeeded();
    await page.screenshot({path: join(output, `${platform}-mobile.png`)});
    await page.setViewportSize({width: 1440, height: 1050});
  }
  await page.goto(`${base}?platform=douyin&legacy=1`);
  const coverage = page.getByRole('group', {name: '每个所选节点都采集的关键词'});
  await coverage.waitFor();
    await coverage.getByRole('checkbox').first().waitFor();
  assert.equal(await coverage.locator('input:checked').count(), 16, 'old all-node plans keep all selected');
  await coverage.getByRole('button', {name: '清空选择'}).click();
  await page.getByRole('button', {name: '预览计划修改', exact: true}).click();
  await page.getByText('16 个关键词工作项', {exact: false}).waitFor();
  await page.getByRole('button', {name: '保存修改', exact: true}).click();
  await page.getByRole('heading', {name: '计划修改已保存'}).waitFor();
  assert.equal(writes.at(-1).keywordCoverage, 'shared');
  assert.deepEqual(writes.at(-1).eachAgentKeywords, []);
  assert.deepEqual(errors, []);
  console.log('PASS: both platforms, selected keyword counts, saved payload and reload, keyword removal/addition, platform switching, legacy all-node plans, desktop/mobile; no browser errors.');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await Promise.all([rm(html, {force: true}), rm(entry, {force: true})]);
}
