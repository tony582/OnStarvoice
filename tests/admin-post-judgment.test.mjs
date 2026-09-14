import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ts = createRequire(new URL('../web/admin/package.json', import.meta.url))('typescript');
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const compiled = ts.transpileModule(source('web/admin/src/lib/post-judgment.ts'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { postJudgment, normalizePostIntent, initialPostIntentFilter, appendPostIntentFilter, POST_INTENT_OPTIONS, ALL_POST_INTENTS } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

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

test('multi-select intent query carries only selected categories and all-select preserves unjudged records', () => {
  const subset = new URLSearchParams({ keyword: '哨兵' });
  appendPostIntentFilter(subset, ['complaint', 'inquiry', 'complaint']);
  assert.deepEqual(subset.getAll('intent'), ['complaint', 'inquiry']);
  assert.equal(subset.get('keyword'), '哨兵');
  const all = new URLSearchParams({ intent: 'complaint' });
  appendPostIntentFilter(all, ['share', 'other', 'complaint', 'inquiry']);
  assert.equal(all.has('intent'), false);
  const none = new URLSearchParams({ keyword: '哨兵', intent: 'complaint' });
  appendPostIntentFilter(none, []);
  assert.deepEqual(none.getAll('intent'), ['none']);
  assert.equal(none.get('keyword'), '哨兵');
});

test('default intent selection stores all four and the last uncheck remains explicitly empty', () => {
  for (const value of [undefined, null, '', 'unknown']) assert.deepEqual(initialPostIntentFilter(value), ALL_POST_INTENTS);
  assert.deepEqual(initialPostIntentFilter('complaint,inquiry'), ['complaint', 'inquiry']);
  assert.deepEqual(initialPostIntentFilter('none'), []);
  let selected = initialPostIntentFilter();
  for (const intent of ALL_POST_INTENTS) {
    selected = selected.filter(value => value !== intent);
    const params = new URLSearchParams();
    appendPostIntentFilter(params, selected);
    assert.deepEqual(params.getAll('intent'), selected.length ? selected : ['none']);
  }
  assert.deepEqual(selected, []);
  const fresh = initialPostIntentFilter();
  fresh.pop();
  assert.equal(initialPostIntentFilter().length, 4);
});

test('relevance degree is independent from judgment confidence, missing values are never fabricated as zero', () => {
  assert.equal(postJudgment({ ai_result: { relevance: 'relevant', relevanceConfidence: 0.1 } }).relevanceLabel, '明确相关');
  assert.equal(postJudgment({ ai_result: { relevance: 'irrelevant', relevanceConfidence: 0.99 } }).relevanceLabel, '无关');
  assert.equal(postJudgment({ ai_result: { relevance: 'uncertain' } }).relevanceLabel, '待核实');
  assert.equal(postJudgment({ ai_result: {} }).relevanceLabel, '待判断');
  for (const relevanceConfidence of [undefined, null, '', ' ', false, [], {}, 1.2, -1]) {
    assert.equal(postJudgment({ ai_result: { relevanceConfidence } }).confidence, null);
  }
  assert.equal(postJudgment({ ai_result: { relevanceConfidence: 0 } }).confidence, 0);
});

test('historical human relevance overrides retain precedence in read-only presentation', () => {
  const result = postJudgment({ archived_at: '2026-09-14', ai_result: { relevance: 'uncertain', relevanceReason: '旧AI原因' }, manual_overrides: { relevance: { value: 'relevant', reason: '已核对原帖车型' } } });
  assert.equal(result.relevanceLabel, '明确相关');
  assert.equal(result.relevanceReason, '已核对原帖车型');
  assert.equal(result.manual, true);
  assert.equal(result.archived, true);
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
  assert.ok(header.indexOf('<PostIntentFilter header') < header.indexOf('>相关度</th>'));
  assert.match(queue, /appendPostIntentFilter\(params, intents\)/);
  assert.match(queue, /useSelection\(`[^`]*\$\{intents\}/);
  assert.match(queue, /setIntents\(\[\.\.\.ALL_POST_INTENTS\]\)/);
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

test('intent menu uses an actual tri-state all checkbox and does not reinterpret empty as all', () => {
  const component = source('web/admin/src/components/shared/PostJudgment.tsx');
  assert.match(component, /const allSelected = ALL_POST_INTENTS\.every/);
  assert.match(component, /const selected = value/);
  assert.match(component, /checked=\{selected\.includes\(option\.value\)\}/);
  assert.match(component, /<DropdownMenu\.CheckboxItem checked=\{allSelected \? true : value\.length \? 'indeterminate' : false\}/);
  assert.match(component, /onChange\(allSelected \? \[\] : \[\.\.\.ALL_POST_INTENTS\]\)/);
  assert.doesNotMatch(component, /value\.length === 0 \|\|/);
  assert.match(component, /全部意图包含尚未判断的内容/);
  assert.match(component, /未勾选意图，当前不显示任何内容/);
});
