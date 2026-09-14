import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ts = createRequire(new URL('../web/admin/package.json', import.meta.url))('typescript');
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const compiled = ts.transpileModule(source('web/admin/src/lib/post-judgment.ts'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { postJudgment, normalizePostIntent, initialPostIntentFilter, appendPostIntentFilter, appendPostRelevanceFilters, normalizePostRelevanceFilter, normalizePostConfidenceFilter, postFilterSummary, POST_INTENT_OPTIONS, ALL_POST_INTENTS } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('four public post intents preserve legacy suggestions and keep missing values unjudged', () => {
  assert.deepEqual(POST_INTENT_OPTIONS.map(option => option.value), ['share', 'other', 'complaint', 'inquiry']);
  assert.equal(normalizePostIntent('suggestion'), 'other');
  for (const value of [undefined, null, '', 'unknown']) {
    assert.equal(postJudgment({ intent: value }).intentLabel, '待判断');
  }
  assert.equal(postJudgment({ intent: 'suggestion' }).intentLabel, '其他');
  assert.equal(postJudgment({ intent: 'share', intent_display: null }).intentLabel, '待判断');
  assert.equal(postJudgment({ intent: 'complaint' }).intentLabel, '投诉/抱怨');
});

test('positive intent selection defaults to unrestricted; explicit four categories remain filtered', () => {
  for (const value of [undefined, null, '', 'unknown', 'none']) assert.deepEqual(initialPostIntentFilter(value), []);
  assert.deepEqual(initialPostIntentFilter('share,inquiry'), ['share', 'inquiry']);
  const params = new URLSearchParams({ keyword: '哨兵' });
  for (const selected of [[], ['share'], ['share', 'inquiry'], ['inquiry'], [], ALL_POST_INTENTS]) {
    appendPostIntentFilter(params, selected);
    assert.deepEqual(params.getAll('intent'), selected);
    assert.equal(params.get('keyword'), '哨兵');
  }
  appendPostIntentFilter(params, ['complaint', 'inquiry', 'complaint']);
  assert.deepEqual(params.getAll('intent'), ['complaint', 'inquiry']);
});

test('relevance and confidence are independent OR dimensions on the common query', () => {
  const params = new URLSearchParams({ intent: 'share', status: 'unhandled' });
  appendPostRelevanceFilters(params, ['uncertain', 'irrelevant', 'uncertain', 'fake'], ['high', 'missing', 'high', 'fake']);
  assert.deepEqual(params.getAll('relevance'), ['uncertain', 'irrelevant']);
  assert.deepEqual(params.getAll('relevanceConfidence'), ['high', 'missing']);
  assert.equal(params.get('intent'), 'share');
  assert.equal(params.get('status'), 'unhandled');
  assert.deepEqual(normalizePostRelevanceFilter('relevant,unjudged'), ['relevant', 'unjudged']);
  assert.deepEqual(normalizePostConfidenceFilter(' low ,manual'), ['low', 'manual']);
  appendPostRelevanceFilters(params, [], []);
  assert.equal(params.has('relevance'), false);
  assert.equal(params.has('relevanceConfidence'), false);
});

test('relevance conclusion is independent of confidence and unknown scores are not fabricated', () => {
  for (const [value, label] of [['relevant', '相关'], ['uncertain', '信息不足'], ['irrelevant', '无关']]) {
    const judgment = postJudgment({ ai_result: { relevance: value, relevanceConfidence: .92 } });
    assert.equal(judgment.relevanceLabel, label);
    assert.equal(judgment.confidence, 92);
    assert.equal(judgment.confidenceBand, 'high');
  }
  assert.equal(postJudgment({ ai_result: {} }).relevanceLabel, '未判断');
  for (const relevanceConfidence of [undefined, null, '', ' ', false, true, [], {}, 1.2, -1, NaN, Infinity, 'foo']) {
    const judgment = postJudgment({ ai_result: { relevance: 'relevant', relevanceConfidence } });
    assert.equal(judgment.confidence, null);
    assert.equal(judgment.confidenceBand, 'missing');
  }
  for (const relevance of [undefined, null, '', 'fake']) {
    const judgment = postJudgment({ ai_result: { relevance, relevanceConfidence: .99 } });
    assert.equal(judgment.confidence, null);
    assert.equal(judgment.relevanceFilter, 'unjudged');
  }
});

test('confidence bands use rounded valid numeric values including zero and trimmed strings', () => {
  for (const [raw, percent, band] of [[0, 0, 'low'], [.594, 59, 'low'], [.595, 60, 'medium'], [.794, 79, 'medium'], [.795, 80, 'high'], [1, 100, 'high'], [' .92 ', 92, 'high']]) {
    const judgment = postJudgment({ ai_result: { relevance: 'relevant', relevanceConfidence: raw } });
    assert.equal(judgment.confidence, percent);
    assert.equal(judgment.confidenceBand, band);
  }
});

test('filter summaries show chosen labels and compact multiple selections', () => {
  assert.equal(postFilterSummary([], '全部意图'), '全部意图');
  assert.equal(postFilterSummary(['分享'], '全部意图'), '分享');
  assert.equal(postFilterSummary(['分享', '咨询'], '全部意图'), '分享 +1');
  assert.equal(postFilterSummary(['相关', '无关', '高置信度', '人工判断'], '相关性'), '相关 +3');
});

test('historical human relevance overrides retain precedence in read-only presentation', () => {
  const result = postJudgment({ archived_at: '2026-09-14', ai_result: { relevance: 'uncertain', relevanceReason: '旧AI原因' }, manual_overrides: { relevance: { value: 'relevant', reason: '已核对原帖车型' } } });
  assert.equal(result.relevanceLabel, '相关');
  assert.equal(result.relevanceReason, '已核对原帖车型');
  assert.equal(result.manual, true);
  assert.equal(result.archived, true);
  for (const manual of [{ value: 'relevant' }, 'irrelevant']) {
    const human = postJudgment({ manual_overrides: JSON.stringify({ relevance: manual }), ai_result: { relevance: 'uncertain', relevanceReason: '旧AI结论', relevanceConfidence: .99 } });
    assert.equal(human.confidence, null);
    assert.equal(human.confidenceBand, 'manual');
    assert.equal(human.relevanceReason, '人工判断，未填写依据');
  }
  assert.equal(postJudgment({ manual_overrides: { relevance: 'irrelevant' }, ai_result: { relevance: 'relevant' } }).relevanceLabel, '无关');
});

test('detail evidence only renders structured main-post source quotes', () => {
  const result = postJudgment({ ai_result: JSON.stringify({ intentReason: '提问使用方法', monitoringEvidence: { evidence: [{ source: 'title', entity: '别克', quote: '别克车主分享哨兵体验' }, { source: 'comment', quote: '评论说这是别克' }, { source: 'keyword', quote: '别克哨兵' }, { source: 'content', quote: '' }] } }) });
  assert.equal(result.intentReason, '提问使用方法');
  assert.deepEqual(result.evidence, [{ source: 'title', sourceLabel: '标题', entity: '别克', quote: '别克车主分享哨兵体验' }]);
});

test('list, mobile, board and drawer expose intent and relevance with one filtered export query', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const board = source('web/admin/src/pages/workbench/TriageBoard.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const header = queue.slice(queue.indexOf('<thead data-sticky-header'), queue.indexOf('</thead>'));
  assert.ok(header.indexOf('label="情感"') < header.indexOf('<PostIntentFilter header'));
  assert.ok(header.indexOf('<PostIntentFilter header') < header.indexOf('<PostRelevanceFilter header'));
  assert.match(queue, /appendPostIntentFilter\(params, intents\)/);
  assert.match(queue, /useSelection\(`\$\{filterParams\(\)\.toString\(\)\}/);
  assert.match(queue, /appendPostRelevanceFilters\(params, relevances, relevanceConfidences\)/);
  assert.match(queue, /<PostRelevanceFilter value=\{relevances\}/);
  assert.match(queue, /setIntents\(\[\]\); setRelevances\(\[\]\); setRelevanceConfidences\(\[\]\)/);
  assert.match(queue, /api\.download\('\/triage\/records\/export\?' \+ filterParams\(\)/);
  for (const text of [queue, board, drawer]) {
    assert.match(text, /<PostIntentBadge record=\{r\}/);
    assert.match(text, /<PostRelevanceBadge record=\{r\}/);
  }
  assert.match(drawer, /<PostJudgmentDetails/);
  assert.match(drawer, /<PostJudgmentDetails record=\{r\} \/>/);
});

test('content triage retains two lifecycle tabs and classification evidence is read-only', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const component = source('web/admin/src/components/shared/PostJudgment.tsx');
  const tabs = queue.slice(queue.indexOf('const ARCHIVE_VIEWS'), queue.indexOf('const PAGE_SIZE_OPTIONS'));
  assert.deepEqual([...tabs.matchAll(/value: '([^']+)'/g)].map(match => match[1]), ['active', 'archived']);
  for (const text of [queue, drawer, component]) assert.doesNotMatch(text, /relevance_review|onReviewRelevance|reviewRelevance|人工核实相关度|保存核实结论/);
  assert.doesNotMatch(component, /<textarea|<select|api\.patch/);
});

test('opening a drawer allows filters to wrap and keeps their labels horizontal', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const component = source('web/admin/src/components/shared/PostJudgment.tsx');
  assert.match(queue, /view === 'list' && !drawerRecord && 'xl:grid/);
  assert.match(queue, /w-full shrink-0 lg:w-\[160px\]/);
  assert.match(queue, /triggerClassName="w-full shrink-0 justify-between whitespace-nowrap"/);
  assert.match(component, /inline-flex shrink-0 items-center gap-1 whitespace-nowrap/);
});

test('menus use independent unrestricted reset items and positive multiselect choices', () => {
  const component = source('web/admin/src/components/shared/PostJudgment.tsx');
  assert.match(component, /<DropdownMenu\.Item onSelect=.*onChange\(\[\]\)/);
  assert.match(component, /resetLabel="全部意图"/);
  assert.match(component, /resetLabel="全部"/);
  assert.match(component, /resetLabel="不限"/);
  assert.match(component, /checked=\{value\.includes\(option\.value\)\}/);
  assert.match(component, /意图 · 可多选/);
  assert.match(component, /相关性 · 可多选/);
  assert.match(component, /置信度 · 可多选/);
  assert.doesNotMatch(component, /allSelected|indeterminate|未勾选意图|全选恢复/);
  assert.match(component, /不代表相关程度或实际准确率/);
  assert.match(component, /inline-flex flex-col items-start/);
});
