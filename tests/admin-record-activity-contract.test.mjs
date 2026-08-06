import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('record and ticket notes are append-only, appear in one processing timeline, and export into one cell', () => {
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
  assert.match(drawer, /新增记录/);
  assert.match(drawer, /aria-label="处理记录列表"/);
  assert.doesNotMatch(drawer, />处理时间线<|>最新在前</);
  assert.match(drawer, /<ActivityTimeline items=\{activity\}/);
  assert.match(triage, /string_agg\(/);
  assert.match(triage, /FROM record_notes rn/);
  assert.match(triage, /FROM ticket_notes tn/);
  assert.match(triage, /header: '处理记录'/);
  assert.match(triage, /wrapText: true/);
});

test('triage risk signals include deleted posts while official response stays separate', () => {
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
  assert.match(queue, /\{ value: 'deleted', label: '已删帖' \}/);
  assert.match(queueRisk, /content_availability_status/);
  assert.match(queueRisk, /已删帖/);
  assert.match(route, /risks\.includes\('deleted'\)[^\n]+content_availability_status = 'deleted'/);
  assert.match(drawer, /const deleted = String\(r\.content_availability_status \|\| ''\) === 'deleted'/);
  assert.match(drawer, /const hasSignals = alerts > 0 \|\| negComments > 0 \|\| deleted/);
  assert.match(drawer, /已删帖/);
  assert.doesNotMatch(drawer, /风险信号[\s\S]{0,900}已官方回复/);
});

test('drawer and batch actions keep handling, ticketing, and archiving semantics separate', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const batchBar = source('web/admin/src/components/shared/BatchBar.tsx');

  assert.match(drawer, /await refreshActivity\(\)/);
  assert.match(drawer, /aria-label="内容处理操作"/);
  assert.match(drawer, /aria-label="内容处理模式"/);
  for (const [value, label] of [
    ['unhandled', '待处理'],
    ['reviewing', '负面流程'],
    ['official_responded', '官方已评'],
    ['no_action', '无需操作'],
  ]) {
    assert.match(drawer, new RegExp(`value: '${value}'[^\\n]+label: '${label}'`));
  }
  assert.match(drawer, /addingTicketProgress/);
  assert.match(drawer, /aria-label=\{falsePositivePending \? '误报已提交' : '提交误报'\}/);
  assert.match(drawer, /falsePositivePending \? '已提交' : '误报'/);
  assert.match(drawer, /record\.false_positive_reported/);
  assert.match(drawer, /提交了误报复核/);
  assert.match(drawer, /aria-label="归档内容操作"/);
  assert.match(drawer, /onSetArchived\(false\)/);
  assert.match(drawer, /aria-label="归档"/);
  assert.match(drawer, /onSetArchived\(true\)/);
  assert.match(queue, /return changeRecordMode\(drawerRecord, s as TriageMode\)/);
  assert.doesNotMatch(queue, /if \(updated\) setDrawerRecord\(null\)/);
  assert.match(drawer, /runStatusAction\(onLinkIssue\)/);
  assert.match(drawer, /record\.ticket_progress_added/);
  assert.match(drawer, /record\.ticket_closed/);

  const modeMutation = queue.slice(
    queue.indexOf('const changeTriageMode'),
    queue.indexOf('const changeRecordMode'),
  );
  assert.match(modeMutation, /status: newStatus/);
  assert.doesNotMatch(modeMutation, /\/triage\/records\/archive|changeArchive/);
  assert.match(queue, /newStatus === 'ticketed' \? dispatchTicket\(record\)/);

  const batchActions = queue.slice(queue.indexOf('actions={archiveView'), queue.indexOf('/>', queue.indexOf('actions={archiveView')));
  for (const key of ['unhandled', 'reviewing', 'official_responded', 'no_action', 'archive']) {
    assert.match(batchActions, new RegExp(`key: '${key}'`));
  }
  assert.doesNotMatch(batchActions, /key: 'ticketed'/);
  assert.match(batchBar, /aria-label="批量处理"/);
  assert.match(batchBar, /批量处理/);
});

test('triage filters preserve the operational dimensions without fixing their layout', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');

  assert.match(queue, /label: '工作中'/);
  assert.match(queue, /aria-label="内容筛选"/);
  assert.match(queue, /搜索标题、正文、作者、工单号/);
  assert.match(queue, /aria-label="平台筛选"/);
  assert.match(queue, /aria-label="处理模式筛选"/);
  assert.match(queue, /label="风险信号"/);
  assert.match(queue, /label="疑似身份"/);
  assert.match(queue, /<KeywordFilter value=\{captureKeywords\}/);
  assert.match(queue, /label="自定义标签"/);
  assert.match(queue, /aria-label="情感筛选"/);
  assert.match(queue, /\[\['', '全部情感'\], \['negative', '负面'\], \['neutral', '中性'\], \['positive', '正面'\]\]/);
  assert.match(queue, /aria-pressed=\{sentiment === value\}/);
  assert.match(queue, /setPlatform\(''\); setSentiment\(''\); setKeyword\(''\); setTriageStatus\(''\)/);
});
