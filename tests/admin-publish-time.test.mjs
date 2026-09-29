import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {
  captureKeywordPresentation,
  classifyPublishTimeText,
  publishTimePresentation,
} from '../web/admin/src/lib/publish-time.mjs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const kind = raw => classifyPublishTimeText(raw).kind;

test('the captured text is recognised by what it can actually say about the time', () => {
  // Shapes taken from production records, per platform.
  assert.deepEqual(classifyPublishTimeText('2026-09-28T03:17:29.000Z'),
    {kind: 'exact', precision: 'second', edited: false, text: '2026-09-28T03:17:29.000Z'});
  assert.deepEqual(classifyPublishTimeText('2026-09-28T03:17Z'),
    {kind: 'exact', precision: 'minute', edited: false, text: '2026-09-28T03:17Z'});
  assert.deepEqual(classifyPublishTimeText('2020/10/23 13:57:38'),
    {kind: 'exact', precision: 'second', edited: false, text: '2020/10/23 13:57:38'});
  assert.deepEqual(classifyPublishTimeText('2026-09-20 08:05'),
    {kind: 'exact', precision: 'minute', edited: false, text: '2026-09-20 08:05'});
  // A platform that shows only the day is uploaded as midnight: that is a day, not a time.
  assert.equal(kind('2026/1/7 00:00:00'), 'date');
  assert.equal(kind('2026-01-07 00:00'), 'date');
  for (const raw of ['2022-05-16', '2018-12-08', '2026年9月1日', '01-01', '6月17日', '· 6月17日', '编辑于 01-11', '编辑于 01-01 山东', '发布于 2026-09-01']) {
    assert.equal(kind(raw), 'date', raw);
  }
  for (const raw of ['8小时前', '10小时前', '10分钟前', '3 小时前', '刚刚', '编辑于 5分钟前']) {
    assert.equal(kind(raw), 'relative_time', raw);
  }
  for (const raw of ['1天前', '3天前', '2周前', '1个月前', '2年前', '昨天 18:20', '前天', '今天 09:30', '昨天 18:20 山东']) {
    assert.equal(kind(raw), 'relative_day', raw);
  }
  for (const raw of ['', '   ', null, undefined]) assert.equal(kind(raw), 'empty');
  assert.equal(kind('不久之前'), 'other');
  assert.equal(classifyPublishTimeText('编辑于 01-11').edited, true);
  assert.equal(classifyPublishTimeText('更新于 2026-09-01').edited, true);
  assert.equal(classifyPublishTimeText('发布于 2026-09-01').edited, false);
});

test('an exact time is shown in Beijing time with the precision it was captured with', () => {
  // The phone-found Douyin post of the report: 03:17:29 UTC is 11:17:29 in Beijing.
  assert.deepEqual(publishTimePresentation({
    publish_time: '2026-09-28T03:17:29.000Z',
    published_ts: '2026-09-28T03:17:29.000Z',
    publish_display: '2026-09-28',
  }), {value: '2026/09/28 11:17:29', hint: ''});
  // Late in the UTC day the Beijing date is the next one.
  assert.equal(publishTimePresentation({publish_time: '2026-09-27T16:30:00.000Z', published_ts: '2026-09-27T16:30:00.000Z'}).value,
    '2026/09/28 00:30:00');
  assert.equal(publishTimePresentation({publish_time: '2020/10/23 13:57:38', published_ts: '2020-10-23T05:57:38.000Z'}).value,
    '2020/10/23 13:57:38');
  assert.equal(publishTimePresentation({publish_time: '2026-09-20 08:05', published_ts: '2026-09-20T00:05:00.000Z'}).value,
    '2026/09/20 08:05');
  // Lists that do not carry published_ts: an ISO text with its zone is enough.
  assert.equal(publishTimePresentation({publish_time: '2026-09-28T03:17:29.000Z'}).value, '2026/09/28 11:17:29');
  // A text without a zone is not re-read in the viewer's zone: it stays as captured.
  assert.equal(publishTimePresentation({publish_time: '2020/10/23 13:57:38'}).value, '2020/10/23 13:57:38');
});

test('a relative text is converted from the capture moment and says what it was converted from', () => {
  // The Xiaohongshu post of the report: captured 2026-09-28 21:10:13 showing "8小时前".
  assert.deepEqual(publishTimePresentation({
    publish_time: '8小时前',
    published_ts: '2026-09-28T05:10:13.341Z',
    publish_display: '2026-09-28',
  }), {value: '约 2026/09/28 13:10', hint: '按采集时页面显示的「8小时前」换算'});
  assert.deepEqual(publishTimePresentation({publish_time: '10分钟前', published_ts: '2026-09-28T13:00:48.000Z'}),
    {value: '约 2026/09/28 21:00', hint: '按采集时页面显示的「10分钟前」换算'});
  // Days and longer only fix the day; the time of day would be the capture's, not the post's.
  assert.deepEqual(publishTimePresentation({publish_time: '1天前', published_ts: '2026-09-27T13:10:13.000Z'}),
    {value: '约 2026/09/27', hint: '按采集时页面显示的「1天前」换算'});
  assert.deepEqual(publishTimePresentation({publish_time: '昨天 18:20 山东', published_ts: '2026-09-27T13:10:13.000Z'}),
    {value: '约 2026/09/27', hint: '按采集时页面显示的「昨天 18:20 山东」换算'});
  // Not converted by the server (older rows): the day the list already shows, or nothing to claim.
  assert.deepEqual(publishTimePresentation({publish_time: '10小时前', publish_display: '2026-09-27'}),
    {value: '约 2026/09/27', hint: '按采集时页面显示的「10小时前」换算'});
  assert.deepEqual(publishTimePresentation({publish_time: '10小时前'}),
    {value: '-', hint: '按采集时页面显示的「10小时前」换算'});
  // The captured words alone are never the value: they would be read as relative to now.
  for (const raw of ['8小时前', '1天前', '刚刚', '昨天 18:20']) {
    const shown = publishTimePresentation({publish_time: raw, published_ts: '2026-09-28T05:10:13.341Z'});
    assert.equal(shown.value.includes('前') || shown.value.includes('刚刚') || shown.value.includes('昨天'), false, raw);
  }
});

test('a day is shown as a day, and an edit date is named as one', () => {
  assert.deepEqual(publishTimePresentation({publish_time: '2022-05-16', published_ts: '2022-05-15T16:00:00.000Z'}),
    {value: '2022/05/16', hint: ''});
  assert.deepEqual(publishTimePresentation({publish_time: '2026/1/7 00:00:00', published_ts: '2026-01-06T16:00:00.000Z'}),
    {value: '2026/01/07', hint: ''});
  assert.deepEqual(publishTimePresentation({publish_time: '01-01', published_ts: '2025-12-31T16:00:00.000Z'}),
    {value: '2026/01/01', hint: ''});
  assert.deepEqual(publishTimePresentation({publish_time: '编辑于 01-11 山东', published_ts: '2026-01-10T16:00:00.000Z'}),
    {value: '2026/01/11', hint: '页面显示「编辑于 01-11 山东」，是最后编辑的时间'});
  assert.deepEqual(publishTimePresentation({publish_time: '· 6月17日', published_ts: '2026-06-16T16:00:00.000Z'}),
    {value: '2026/06/17', hint: ''});
  // Without the server's timestamp: the list's day, else the text as captured.
  assert.equal(publishTimePresentation({publish_time: '01-01', publish_display: '2026-01-01'}).value, '2026/01/01');
  assert.equal(publishTimePresentation({publish_time: '2022-05-16'}).value, '2022-05-16');
  assert.equal(publishTimePresentation({publish_time: '不久之前'}).value, '不久之前');
  assert.equal(publishTimePresentation({publish_time: '不久之前', published_ts: '2026-06-16T16:00:00.000Z'}).value, '2026/06/17');
});

test('nothing captured shows nothing, and broken values never throw', () => {
  assert.deepEqual(publishTimePresentation({}), {value: '-', hint: ''});
  assert.deepEqual(publishTimePresentation(null), {value: '-', hint: ''});
  assert.deepEqual(publishTimePresentation(), {value: '-', hint: ''});
  assert.deepEqual(publishTimePresentation({publish_time: '', published_ts: null, publish_display: ''}), {value: '-', hint: ''});
  // A manually entered day has no captured text.
  assert.deepEqual(publishTimePresentation({publish_time: '', publish_display: '2026-09-20'}), {value: '2026/09/20', hint: ''});
  assert.deepEqual(publishTimePresentation({publish_time: '', published_ts: '2026-09-19T16:00:00.000Z'}), {value: '2026/09/20', hint: ''});
  assert.equal(publishTimePresentation({publish_time: '8小时前', published_ts: 'not a date'}).value, '-');
  assert.equal(publishTimePresentation({publish_time: '2026-13-45T99:99:99Z'}).value, '2026-13-45T99:99:99Z');
  assert.equal(publishTimePresentation({publish_time: 20260928, published_ts: undefined}).value, '20260928');
});

test('the keyword of a phone-found post comes from the record, else from its discovery', () => {
  assert.deepEqual(captureKeywordPresentation('凯迪拉克OTA', []), {value: '凯迪拉克OTA', hint: ''});
  assert.deepEqual(captureKeywordPresentation('', ['上汽通用客服']), {value: '上汽通用客服', hint: ''});
  assert.deepEqual(captureKeywordPresentation(null, ['上汽通用客服', '别克APP', '安吉星']),
    {value: '上汽通用客服', hint: '手机还在这些关键词下发现过：别克APP、安吉星'});
  // Stored keyword first; the same keyword is not repeated among the others.
  assert.deepEqual(captureKeywordPresentation('别克APP', ['上汽通用客服', '别克APP']),
    {value: '别克APP', hint: '手机还在这些关键词下发现过：上汽通用客服'});
  assert.deepEqual(captureKeywordPresentation('  ', [' ', null, '君越壁纸', '君越壁纸']), {value: '君越壁纸', hint: ''});
  assert.deepEqual(captureKeywordPresentation('', []), {value: '-', hint: ''});
  assert.deepEqual(captureKeywordPresentation(undefined, undefined), {value: '-', hint: ''});
  assert.deepEqual(captureKeywordPresentation('', 'not a list'), {value: '-', hint: ''});
});

test('the drawer receives the discovery keywords with the snapshots, and a failed lookup costs nothing else', () => {
  const routes = source('server/routes/records.js');
  const route = routes.slice(routes.indexOf("router.get('/:id/observations'"), routes.indexOf("router.get('/tables/:table'"));
  assert.match(route, /if \(!await ensureRecord\(req, res\)\) return;/u, 'tenant and record are checked first');
  assert.match(route, /const discoveryKeywords = await listRecordDiscoveryKeywords\(\{ queryAll \}, \{\s+tenantId: req\.tenantId,\s+recordId: req\.params\.id,\s+\}\)\.catch\(\(\) => \[\]\);/u);
  assert.match(route, /return res\.json\(\{ ok: true, observations, discoveryKeywords \}\);/u);

  const store = source('server/services/record-store.js');
  // Inside the upsert transaction and before anything reads record.keyword.
  const transaction = store.indexOf('const runUpsertTransaction = () => withTransaction(async tx => {');
  const lookup = store.indexOf('const discoveryKeyword = await readDiscoveryCaptureKeyword(tx, {tenantId, captureTaskId});');
  const guard = store.indexOf("if (!String(record.keyword || '').trim()) {", transaction);
  assert.ok(transaction > 0 && guard > transaction && lookup > guard);
  assert.equal(store.slice(transaction, guard).includes('record.keyword'), false);
  assert.equal(store.slice(transaction, guard).includes('tx.query'), false, 'it is the first thing the transaction does');
  assert.match(store.slice(transaction, lookup + 200),
    /if \(!String\(record\.keyword \|\| ''\)\.trim\(\)\) \{\s+const discoveryKeyword = await readDiscoveryCaptureKeyword\(tx, \{tenantId, captureTaskId\}\);\s+if \(discoveryKeyword\) record = \{\.\.\.record, keyword: discoveryKeyword\};/u);
});

test('the capture tab shows both through these presentations', () => {
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  assert.match(drawer, /<InfoTile label="关键词" \{\.\.\.captureKeywordPresentation\(r\.keyword, discoveryKeywords\)\} \/>/u);
  assert.match(drawer, /<InfoTile label="发布时间" \{\.\.\.publishTimePresentation\(r\)\} \/>/u);
  assert.doesNotMatch(drawer, /<InfoTile label="发布时间" value=\{r\.publish_time/u);
  assert.match(drawer, /setDiscoveryKeywords\(Array\.isArray\(oData\.discoveryKeywords\) \? oData\.discoveryKeywords : \[\]\)/u);
  assert.match(drawer, /\{hint && <div className="[^"]+">\{hint\}<\/div>\}/u);
});
