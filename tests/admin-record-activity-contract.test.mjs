import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('record notes are append-only, appear in the activity timeline, and export into one cell', () => {
  const migration = source('server/db/migrations/037_record_notes.sql');
  const records = source('server/routes/records.js');
  const triage = source('server/routes/triage.js');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS record_notes/);
  assert.match(migration, /record_notes_body_check/);
  assert.match(records, /router\.post\('\/:id\/notes'/);
  assert.match(records, /INSERT INTO record_notes/);
  assert.match(records, /router\.get\('\/:id\/activity'/);
  assert.match(records, /record\.note_added/);
  assert.match(records, /record\.legacy_triage_note/);
  assert.match(drawer, /新增备注/);
  assert.match(drawer, /处理时间线/);
  assert.match(drawer, /<ActivityTimeline items=\{activity\}/);
  assert.match(triage, /string_agg\(/);
  assert.match(triage, /FROM record_notes rn/);
  assert.match(triage, /header: '内容备注'/);
  assert.match(triage, /wrapText: true/);
});

test('triage list sorts comments and likes while official response stays outside risk signals', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const route = source('server/routes/triage.js');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');

  assert.match(queue, /SortableTh label="评论" field="comments"/);
  assert.match(queue, /SortableTh label="点赞" field="likes"/);
  assert.match(route, /sort === 'comments'/);
  assert.match(route, /sort === 'likes'/);

  const queueRisk = queue.slice(queue.indexOf('function RiskSignals'), queue.indexOf('function tagsFromMutationResponse'));
  assert.doesNotMatch(queueRisk, /official_response_status/);
  assert.doesNotMatch(queueRisk, /已回复/);
  assert.match(drawer, /const hasSignals = alerts > 0 \|\| negComments > 0/);
  assert.doesNotMatch(drawer, /风险信号[\s\S]{0,900}已官方回复/);
});

test('drawer and batch actions expose a clear handling hierarchy', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const batchBar = source('web/admin/src/components/shared/BatchBar.tsx');

  assert.match(drawer, /确认更改处理模式？/);
  assert.match(drawer, /本次只更新处理模式，不会自动归档内容/);
  assert.match(drawer, /role="alertdialog"/);
  assert.match(drawer, /await refreshActivity\(\)/);
  assert.match(drawer, /aria-label="内容处理操作"/);
  assert.match(drawer, /data-drawer-header/);
  assert.match(drawer, /lg:min-h-14/);
  assert.match(drawer, /flex w-full min-w-0 items-center gap-2/);
  assert.match(drawer, /grid min-w-0 flex-1 grid-cols-4/);
  assert.match(drawer, /aria-label="其他操作"/);
  assert.doesNotMatch(drawer, /mobile-table-scroll overflow-x-auto" aria-label="内容处理操作"/);
  assert.match(drawer, /aria-label=\{falsePositivePending \? '误报已提交' : '提交误报'\}/);
  assert.match(drawer, /falsePositivePending \? '已提交' : '误报'/);
  assert.match(drawer, /record\.false_positive_reported/);
  assert.match(drawer, /提交了误报复核/);
  assert.match(drawer, /aria-label="归档内容操作"/);
  assert.match(drawer, /onSetArchived\(false\)/);
  assert.match(drawer, /aria-label="归档"/);
  assert.match(drawer, /onSetArchived\(true\)/);
  assert.doesNotMatch(drawer, /grid w-\[304px\] grid-cols-4 gap-px overflow-hidden/);
  assert.doesNotMatch(drawer, /尚未开始处理|进入负面舆情流程|官方账号已经回复|确认无需继续跟进/);
  assert.match(queue, /return changeTriageMode\(drawerRecord\.id, s as TriageMode\)/);
  assert.doesNotMatch(queue, /if \(updated\) setDrawerRecord\(null\)/);
  assert.match(drawer, />转工单<\/Button>/);
  assert.match(batchBar, /aria-label="批量处理"/);
  assert.match(batchBar, /bg-primary px-4 text-primary-foreground/);
  assert.match(batchBar, /批量处理/);
});

test('triage toolbar restores the stable filter layout with search aligned left', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const multiSelect = source('web/admin/src/components/shared/MultiSelect.tsx');

  assert.match(queue, /label: '工作中'/);
  assert.match(queue, /role="group" aria-label="内容筛选" className="flex flex-wrap items-center gap-x-1\.5 gap-y-2"/);
  assert.match(queue, /relative w-full lg:w-52/);
  assert.doesNotMatch(queue, /relative w-full lg:ml-auto lg:w-52/);
  assert.match(queue, /mobileFiltersOpen \? 'flex' : 'hidden'/);
  assert.match(queue, /'lg:contents'/);
  assert.doesNotMatch(queue, /aria-label="内容筛选"[^\n]*overflow-x-auto/);
  assert.match(queue, /aria-label="平台筛选"/);
  assert.match(queue, /aria-label="处理模式筛选"/);
  assert.match(queue, /label="风险"/);
  assert.match(queue, /label="疑似身份"/);
  assert.match(queue, /<KeywordFilter value=\{captureKeywords\}/);
  assert.match(queue, /label="自定义标签"/);
  assert.match(queue, /aria-label="情感筛选"/);
  assert.match(queue, /\[\['', '全部情感'\], \['negative', '负面'\], \['neutral', '中性'\], \['positive', '正面'\]\]/);
  assert.match(queue, /aria-pressed=\{sentiment === value\}/);
  assert.match(multiSelect, /triggerClassName\?: string/);
});
