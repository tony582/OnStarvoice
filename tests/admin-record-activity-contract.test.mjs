import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function between(text, start, end) {
  const startAt = text.indexOf(start);
  assert.notEqual(startAt, -1, `missing contract boundary: ${start}`);
  const endAt = text.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `missing contract boundary: ${end}`);
  return text.slice(startAt, endAt);
}

test('record notes are append-only and remain in one processing timeline and export cell', () => {
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
  assert.match(drawer, /新增记录/);
  assert.match(drawer, /aria-label="处理记录列表"/);
  assert.match(drawer, /<ActivityTimeline items=\{activity\}/);
  assert.match(triage, /string_agg\(/);
  assert.match(triage, /FROM record_notes rn/);
  assert.match(triage, /\|\| ' 状态备注：' \|\| \(al\.metadata->>'note'\) AS line/);
  assert.match(triage, /header: '处理记录'/);
  assert.match(triage, /wrapText: true/);
});

test('deleted-post risk stays separate from the manually selected unavailable state', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const route = source('server/routes/triage.js');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');

  const riskSignals = between(queue, 'function RiskSignals', 'function tagsFromMutationResponse');
  assert.match(queue, /\{ value: 'deleted', label: '已删帖' \}/);
  assert.match(riskSignals, /content_availability_status/);
  assert.match(riskSignals, /已删帖/);
  assert.doesNotMatch(riskSignals, /triage_status|unavailable/);
  assert.match(route, /risks\.includes\('deleted'\)[^\n]+content_availability_status = 'deleted'/);
  assert.match(drawer, /const deleted = String\(r\.content_availability_status \|\| ''\) === 'deleted'/);
  assert.match(drawer, /value: 'unavailable', label: '已不可见'/);
});

test('drawer and batch expose all eight states with shared status-change prompts', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const feishuControl = source('web/admin/src/components/shared/FeishuTableNumberControl.tsx');
  const batchBar = source('web/admin/src/components/shared/BatchBar.tsx');

  assert.match(drawer, /aria-label="内容处理操作"/);
  assert.match(drawer, /aria-label="处理状态"/);
  for (const [value, label] of [
    ['unhandled', '待处理'],
    ['replied', '已回复'],
    ['reviewed', '已复核'],
    ['reviewed_non_monitor', '已复核-非监控内容'],
    ['unavailable', '已不可见'],
    ['privacy_unreachable', '负面–隐私设置无法触达'],
    ['negative_feishu', '负面-飞书表'],
    ['negative_cold', '负面-冷处理'],
  ]) {
    assert.match(drawer, new RegExp(`value: '${value}'[^\\n]+label: '${label}'`));
    assert.match(queue, new RegExp(`value: '${value}'[^\\n]+label: '${label}'`));
  }
  assert.match(drawer, /aria-label="归档内容操作"/);
  assert.match(drawer, /onSetArchived\(false\)/);
  assert.match(drawer, /onSetArchived\(true\)/);
  assert.doesNotMatch(drawer, /addingTicketProgress|runStatusAction\(onLinkIssue\)/);

  const batchMutation = between(queue, 'const runBatch', 'const syncArchiveLocally');
  assert.match(batchMutation, /api\.patch<BatchModeMutationResponse>\('\/triage\/records\/batch'/);
  assert.match(batchMutation, /changedBatchModeIds\(result, ids\)/);
  assert.match(batchMutation, /await askStatusChange/);
  assert.match(batchMutation, /note: values\.note/);
  assert.match(batchMutation, /requireFeishuTableNo: newStatus === 'negative_feishu'/);
  assert.match(batchMutation, /feishuTableNo: values\.feishuTableNo/);
  assert.doesNotMatch(queue, /\.filter\(mode => mode\.value !== 'negative_feishu'\)/);
  assert.match(batchBar, /aria-label="批量处理"/);

  const drawerHeader = between(drawer, '{/* Header */}', '{archived && (');
  assert.match(drawerHeader, /<FeishuTableNumberControl/);
  assert.match(drawerHeader, /onSave=\{!archived \? onSetFeishuTableNo : undefined\}/);
  assert.doesNotMatch(drawerHeader, /changeMode\('negative_feishu'\)/);
  assert.equal((drawer.match(/<FeishuTableNumberControl/g) || []).length, 1);
  assert.match(feishuControl, /aria-label=\{onSave \? `修改飞书表号：\$\{display\}`/);
  assert.match(feishuControl, /<input[\s\S]*autoFocus[\s\S]*aria-label="飞书表号"/);
  assert.match(feishuControl, /onBlur=\{\(\) =>/);
  assert.match(feishuControl, /CopyTicketNumberButton value=\{number\} label="飞书表号"/);

  const inlineSave = between(queue, 'const saveFeishuTableNo', 'const modeVisibleInCurrentList');
  assert.match(inlineSave, /`\/triage\/records\/\$\{record\.id\}`/);
  assert.match(inlineSave, /\{ feishuTableNo \}/);
  assert.match(inlineSave, /feishu_table_no: savedNumber/);
});

test('triage filters keep operational dimensions without work-order controls', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');

  assert.match(queue, /label: '工作中'/);
  assert.match(queue, /aria-label="内容筛选"/);
  assert.match(queue, /搜索标题、正文、作者、飞书表号/);
  assert.doesNotMatch(queue, /搜索标题、正文、作者、工单号/);
  assert.match(queue, /aria-label="平台筛选"/);
  assert.match(queue, /<MultiSelect[\s\S]*label="全部状态"[\s\S]*value=\{triageStatuses\}/);
  assert.match(queue, /<HeaderMultiFilter[\s\S]*label="处理状态"[\s\S]*value=\{triageStatuses\}/);
  assert.match(queue, /label="风险信号"/);
  assert.match(queue, /label="疑似身份"/);
  assert.match(queue, /<KeywordFilter value=\{captureKeywords\}/);
  assert.match(queue, /label="自定义标签"/);
  assert.match(queue, /aria-label="情感筛选"/);
  assert.doesNotMatch(queue, /TicketStatusFilter|工单状态筛选/);
});
