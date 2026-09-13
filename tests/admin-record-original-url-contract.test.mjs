import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import { createRequire } from 'node:module';

const ts = createRequire(new URL('../web/admin/package.json', import.meta.url))('typescript');
const compiled = ts.transpileModule(readFileSync(new URL('../web/admin/src/lib/comment-leads.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { commentLeadSource } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('admin workbench opens validated saved Xiaohongshu links directly', () => {
  const helper = source('web/admin/src/lib/record-display.ts');
  const triage = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const sourceAction = source('web/admin/src/components/shared/RecordSourceAction.tsx');
  const data = source('web/admin/src/pages/DataPage.tsx');

  assert.match(helper, /detailCaptureNoteUrl/);
  assert.match(helper, /www\.douyin\.com\/\$\{kind\}\/\$\{contentId\}/);
  assert.match(helper, /详情待补采/);
  assert.match(triage, /<RecordSourceAction record=\{r\}/);
  assert.match(triage, /recordDisplayTitle\(r\)/);
  assert.match(drawer, /isRecordDetailDegraded\(r\)/);
  assert.match(drawer, /<RecordSourceAction record=\{r\}/);
  assert.match(sourceAction, /resolveRecordOriginalUrl\(record\)/);
  assert.match(sourceAction, /platform === 'xiaohongshu' \|\| hasXhsUrl/);
  assert.match(sourceAction, /validatedStoredXhsUrl\(record\)/);
  assert.match(sourceAction, /href=\{originalUrl\}/);
  assert.match(sourceAction, /原文不可用/);
  assert.doesNotMatch(sourceAction, /source-open|刷新中|api\.post|api\.get/);
  assert.match(data, /function recordSourceCell\(record: Record<string, unknown>\)/);
  assert.match(data, /col\('url', '笔记链接', r => recordSourceCell\(r\)\)/);
});

test('all record-list APIs validate Xiaohongshu navigation URLs before UI rendering', () => {
  const userRoute = source('server/routes/user.js');
  const adminRoute = source('server/routes/admin.js');
  const recordsRoute = source('server/routes/records.js');

  assert.match(userRoute, /redactXhsRecordNavigation/);
  assert.match(userRoute, /serializeRecords\(records\)\.map\(record => redactXhsRecordNavigation\(record\)\)/);
  assert.match(adminRoute, /serializeRecords\(records\)\.map\(record => redactXhsRecordNavigation\(record\)\)/);
  assert.match(recordsRoute, /rows:\s*rows\.map\(row => redactXhsRecordNavigation\(row\)\)/);
});

test('legacy customer dashboard directly opens only a validated saved Xiaohongshu URL', () => {
  const dashboard = source('server/dashboard/dashboard.js');
  assert.match(dashboard, /function recordSourceLinkHtml\(record\)/);
  assert.match(dashboard, /searchParams\.get\('xsec_token'\)/);
  assert.match(dashboard, /actualId\.toLowerCase\(\) === expectedId\.toLowerCase\(\)/);
  assert.match(dashboard, /linkHtml\(parsed\.toString\(\), '打开原文'\)/);
  assert.match(dashboard, /原文不可用/);
  assert.doesNotMatch(dashboard, /source-open|刷新中|RSA-OAEP/);
});

test('all record-centric admin surfaces avoid stale Xiaohongshu hrefs', () => {
  const paths = [
    'web/admin/src/pages/HitsPage.tsx',
    'web/admin/src/pages/monitoring/HitsTab.tsx',
    'web/admin/src/pages/OpinionPage.tsx',
    'web/admin/src/pages/workbench/MisjudgmentQueue.tsx',
    'web/admin/src/components/shared/EventDrawer.tsx',
    'web/admin/src/pages/monitoring/OfficialCommentPatrolTab.tsx',
    'web/admin/src/pages/OpinionAnalysisPage.tsx',
    'web/admin/src/pages/insights/DashboardTab.tsx',
    'web/admin/src/pages/workbench/LeadsQueue.tsx',
    'web/admin/src/components/shared/CommentLeadDrawer.tsx',
    'web/admin/src/components/shared/TicketDrawer.tsx',
  ];

  for (const path of paths) {
    const adminSurface = source(path);
    assert.match(adminSurface, /RecordSourceAction/, path);
    assert.doesNotMatch(adminSurface, /href=\{(?:hit|post|record|r|it)\.url\}/, path);
  }

  const leads = source('web/admin/src/pages/workbench/LeadsQueue.tsx');
  const commentLeadDrawer = source('web/admin/src/components/shared/CommentLeadDrawer.tsx');
  const ticketDrawer = source('web/admin/src/components/shared/TicketDrawer.tsx');
  const data = source('web/admin/src/pages/DataPage.tsx');
  assert.doesNotMatch(leads, /href=\{lead\.record_url\}/);
  assert.match(leads, /record=\{commentLeadSource\(lead\)\}/);
  assert.doesNotMatch(commentLeadDrawer, /href=\{lead\.record_url\}/);
  assert.match(commentLeadDrawer, /record=\{detail\.record \|\| commentLeadSource\(lead\)\}/);
  assert.doesNotMatch(ticketDrawer, /href=\{postUrl\}/);
  assert.match(ticketDrawer, /id: rec\?\.id \|\| t\.source_record_id \|\| cmt\?\.record_id/);
  assert.match(data, /const sourceRecord = mobileSourceRecord\(row, table\)/);
  assert.match(data, /<RecordSourceAction[\s\S]*record=\{sourceRecord\}/);
  assert.match(data, /id: row\.record_id/);
  assert.doesNotMatch(data, /return String\(firstValue\(row\.record_url, row\.url\)\)/);
  assert.doesNotMatch(data, /resolveRecordOriginalUrl\(row\) \|\| String\(row\.record_url \|\| ''\)/);
});

test('admin workbench distinguishes titleless Xiaohongshu notes from failed detail placeholders', () => {
  const helper = source('web/admin/src/lib/record-display.ts');
  const data = source('web/admin/src/pages/DataPage.tsx');

  assert.match(helper, /normalizedXhsContentId\(record\.external_id\)/);
  assert.match(helper, /validates the captured xsec URL/);
  assert.match(helper, /failed && \(placeholder \|\| \(!title && !content\)\)/);
  assert.match(helper, /return String\(record\.title \|\| record\.content \|\| fallback\)/);
  assert.match(data, /col\('title', '标题', \(r, ctx\) => longCell\(recordDisplayTitle\(r\), 180, ctx\)\)/);
});


test('comment source uses the current parent URL and preserves Xiaohongshu token and identity', () => {
  const currentUrl = 'https://www.xiaohongshu.com/explore/66abcdef1234567890abcdef?xsec_token=current%2Btoken&xsec_source=pc_search';
  const lead = {
    id: 'lead-1', record_id: 'record-1', status: 'new', lead_type: 'sales_intent', priority: 'normal',
    platform: 'xiaohongshu',
    record_url: 'https://www.xiaohongshu.com/explore/66abcdef1234567890abcdef?xsec_token=old-token',
    record_current_url: currentUrl,
    record_canonical_url: 'https://www.xiaohongshu.com/explore/66abcdef1234567890abcdef',
    record_external_id: '66abcdef1234567890abcdef',
  };
  const resolved = commentLeadSource(lead);
  assert.equal(resolved.url, currentUrl);
  assert.equal(new URL(resolved.url).searchParams.get('xsec_token'), 'current+token');
  assert.equal(resolved.external_id, lead.record_external_id);
  assert.equal(resolved.canonical_url, lead.record_canonical_url);
  assert.equal(resolved.id, 'record-1');
  assert.equal(commentLeadSource({ ...lead, record_current_url: '' }).url, lead.record_url);
  assert.equal(commentLeadSource({ ...lead, record_current_url: undefined }).url, lead.record_url);
});
