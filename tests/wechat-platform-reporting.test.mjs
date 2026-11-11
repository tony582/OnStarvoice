import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PLATFORM_LABELS, CUSTOMER_ASSISTANT_PLATFORMS } from '../server/services/platform-labels.js';
import { createCustomerAssistantTools } from '../server/services/customer-assistant-tools.js';
import { createCustomerAssistantAgent, validateCustomerAssistantToolArguments } from '../server/services/customer-assistant-agent.js';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const ExcelJS = require('exceljs');
const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const context = {tenantId: 'tenant-a', chatId: 'chat-a', senderId: 'sender-a', requestId: 'request-a'};

test('monthly XLSX includes both WeChat platforms, aliases once and every record in the 100% distribution', async () => {
  const platforms = ['wechat_channels', 'wechat_articles', 'douyin', 'xhs', 'future_platform'];
  const scope = vm.createContext({ExcelJS, PLATFORM_LABELS, RELEVANT_RECORD_SQL: 'true', PUBLISHED_RECORD_PERIOD_SQL: 'true',
    queryOne: async () => ({name: '测试租户'}),
    queryAll: async () => platforms.map((platform, i) => ({id: String(i), platform, published_ts: '2026-11-10T00:00:00Z'})),
  });
  vm.runInContext(source('server/services/analytics-workbook.js').replace(/^import.*\n/gm, '').replace(/^export /gm, ''), scope);
  const workbook = await vm.runInContext(`buildAnalyticsWorkbook({tenantId:'tenant-a', periodStart:new Date('2026-11-01'), periodEnd:new Date('2026-12-01')})`, scope);
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = reopened.getWorksheet('月报主体');
  const distribution = [];
  for (let row = 11; row <= sheet.rowCount; row++) {
    const count = sheet.getCell(`B${row}`).value, share = sheet.getCell(`C${row}`).value;
    if (count?.formula?.startsWith('COUNTIF(')) distribution.push({label: sheet.getCell(`A${row}`).value, count: count.result || 0, share: share?.result || 0});
  }
  assert.equal(distribution.reduce((sum, r) => sum + r.count, 0), 5);
  assert.ok(Math.abs(distribution.reduce((sum, r) => sum + r.share, 0) - 1) < 1e-10);
  for (const label of ['视频号', '微信文章', '小红书', 'future_platform']) assert.equal(distribution.find(r => r.label === label)?.count, 1, label);
  assert.equal(distribution.filter(r => r.label === '小红书').length, 1);
});

test('assistant validates and executes both WeChat filters and reports their Chinese names', async () => {
  for (const platform of ['wechat_channels', 'wechat_articles']) {
    assert.ok(CUSTOMER_ASSISTANT_PLATFORMS.includes(platform));
    assert.equal(validateCustomerAssistantToolArguments('query_negative', JSON.stringify({platform})).platform, platform);
    let calls = 0;
    const tools = createCustomerAssistantTools({now: () => new Date('2026-11-11T03:00:00Z'), db: {
      withTransaction: async callback => callback({queryOne: async (_sql, params) => {
        assert.equal(params[3], platform); calls++;
        return {total: 1, monitored: 1, pending_analysis: 0, by_platform: [{platform, negative: 1, pending_analysis: 0}], details: []};
      }}),
    }});
    let turn = 0;
    const agent = createCustomerAssistantAgent({now: () => new Date('2026-11-11T03:00:00Z'), executeTool: (...args) => tools.executeTool(...args), model: async request => {
      assert.ok(request.tools.find(tool => tool.function.name === 'query_negative').function.parameters.properties.platform.enum.includes(platform));
      return turn++ === 0 ? {role: 'assistant', content: '', tool_calls: [{id: 'call', type: 'function', function: {name: 'query_negative', arguments: JSON.stringify({platform})}}]} : {role: 'assistant', content: ''};
    }});
    const result = await agent.run({text: '今天这个平台有多少负面？', context});
    assert.equal(calls, 1); assert.equal(result.toolResults[0].result.ok, true);
    assert.match(result.reply, new RegExp(PLATFORM_LABELS[platform]));
  }
});

test('exports use the shared labels and customer dashboard exposes both WeChat platforms', () => {
  for (const route of ['leads', 'tickets', 'triage']) assert.match(source(`server/routes/${route}.js`), /PLATFORM_LABELS as PLATFORM_CN.*platform-labels/);
  assert.match(source('server/routes/triage.js'), /article: '文章'/);
  const dashboard = source('web/dashboard/src/App.tsx');
  assert.match(dashboard, /wechat_channels: '视频号'/); assert.match(dashboard, /wechat_articles: '微信文章'/);
  assert.match(dashboard, /Object\.entries\(PL\)\.map/);
});
