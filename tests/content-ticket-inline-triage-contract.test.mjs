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

test('active content work-order controls are retired from triage UI', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const board = source('web/admin/src/pages/workbench/TriageBoard.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');

  for (const ui of [queue, board, drawer]) {
    assert.doesNotMatch(ui, /TicketDispatch|dispatchTicket|onDispatchTicket|TICKET_TRIAGE_MODE/);
    assert.doesNotMatch(ui, /工单号待补录|补录工单号|确认结案|结案说明/);
  }
  assert.doesNotMatch(queue, /TicketStatusFilter|ticketStatusFilter|InlineTicketNumberEditor|TicketMarker/);
  assert.doesNotMatch(drawer, /CopyTicketNumberButton|onTicketClosed|ticketCloseConfirmOpen|editingTicketNumber/);
  assert.match(queue, /搜索标题、正文、作者、飞书表号/);
  assert.doesNotMatch(queue, /搜索标题、正文、作者、工单号/);
});

test('row note button opens a required note dialog and hover shows the latest note', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const route = source('server/routes/triage.js');

  const addNote = between(queue, 'const addRecordNote', 'const syncModeLocally');
  assert.match(queue, /const \{ ask, dialog \} = useNotePrompt\(\)/);
  assert.match(addNote, /await ask\(\{/);
  assert.match(addNote, /title: '填写备注'/);
  assert.match(addNote, /required: true/);
  assert.match(addNote, /`\/records\/\$\{record\.id\}\/notes`/);
  assert.match(queue, /\{dialog\}/);

  const inline = between(queue, 'function InlineRecordProgress', 'function TriageStatusMenu');
  assert.match(inline, /onClick=\{event => \{[\s\S]*onAdd\(\)/);
  assert.match(inline, /record\.progress_latest_body/);
  assert.match(inline, /最近备注/);
  assert.match(inline, /group-hover\/progress:opacity-100/);
  assert.doesNotMatch(inline, /onOpen|setTab\('history'\)/);

  const latestJoin = between(route, 'const LATEST_CONTENT_PROGRESS_JOIN', 'function appendTicketFilter');
  assert.match(latestJoin, /FROM record_notes rn/);
  assert.match(latestJoin, /record\.triage_updated/);
  assert.match(latestJoin, /record\.triage_batch_updated/);
  assert.doesNotMatch(latestJoin, /ticket_notes/);
});

test('every status change opens an optional note prompt and batch notes share the same flow', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const prompt = source('web/admin/src/components/shared/StatusChangePrompt.tsx');
  const route = source('server/routes/triage.js');

  const single = between(queue, 'const changeRecordMode', 'const runBatch');
  const batch = between(queue, 'const runBatch', 'const syncArchiveLocally');
  assert.match(single, /await askStatusChange\(/);
  assert.match(single, /changeTriageMode\(record\.id, newStatus, values\)/);
  assert.match(batch, /await askStatusChange\(\{[\s\S]*batchCount: sel\.count,[\s\S]*requireFeishuTableNo: newStatus === 'negative_feishu'/);
  assert.match(batch, /note: values\.note/);
  assert.match(batch, /feishuTableNo: values\.feishuTableNo/);
  assert.match(prompt, /备注（选填）/);
  assert.match(prompt, /maxLength=\{2000\}/);
  assert.ok(prompt.indexOf('status-change-feishu-number') < prompt.indexOf('status-change-note'));

  const mountFocus = between(prompt, '// 自动聚焦只在弹窗首次打开时执行', '// 键盘监听与首次聚焦分开');
  assert.match(mountFocus, /\[state\.requireFeishuTableNo\]/);
  assert.doesNotMatch(mountFocus, /submit\(\)|\[onCancel|\[note|\[feishuTableNo/);
  const keyboardEffect = prompt.slice(prompt.indexOf('// 键盘监听与首次聚焦分开'));
  assert.match(keyboardEffect, /\[onCancel, submit\]/);

  const latestJoin = between(route, 'const LATEST_CONTENT_PROGRESS_JOIN', 'function appendTicketFilter');
  assert.match(latestJoin, /al\.metadata->>'note'/);
  assert.match(latestJoin, /'status_note'::text/);
});

test('legacy content ticket calls map to Feishu status without constraining later changes', () => {
  const tickets = source('server/routes/tickets.js');
  const triage = source('server/routes/triage.js');

  assert.match(tickets, /async function markContentRecordNegativeFeishu/);
  assert.match(tickets, /'negative_feishu'/);
  assert.match(tickets, /nextStatus: 'negative_feishu'/);
  assert.doesNotMatch(tickets, /markContentRecordTicketed/);

  const statusRoute = between(triage, "router.patch('/records/:recordId'", "router.post('/records/:recordId/issues'");
  assert.doesNotMatch(statusRoute, /content_ticket_active|ticket_status|status <> 'closed'/);
  assert.match(statusRoute, /previousStatus/);
  assert.match(statusRoute, /nextStatus/);
});

test('legacy ticket evidence remains readable in the unified processing history and export', () => {
  const records = source('server/routes/records.js');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const triage = source('server/routes/triage.js');

  assert.match(records, /FROM ticket_notes tn/);
  assert.match(records, /record\.ticket_progress_added/);
  assert.match(records, /record\.ticket_closed/);
  assert.match(drawer, /<ActivityTimeline items=\{activity\}/);
  assert.match(drawer, /record\.ticket_progress_added/);
  assert.match(drawer, /record\.ticket_closed/);
  assert.match(triage, /FROM ticket_notes tn/);
  assert.match(triage, /header: '处理记录'/);
});

test('overview metrics report current handling states instead of work-order coverage', () => {
  const workspace = source('server/routes/workspace.js');
  const overview = source('web/admin/src/pages/OverviewPage.tsx');
  const mobile = source('web/admin/src/mobile/MobileApp.tsx');
  const report = source('server/services/report-generator.js');
  const dashboard = source('web/admin/src/pages/insights/DashboardTab.tsx');
  const workbench = source('web/admin/src/pages/WorkbenchPage.tsx');

  for (const status of ['unhandled', 'replied', 'reviewed', 'reviewed_non_monitor', 'unavailable', 'privacy_unreachable', 'negative_feishu', 'negative_cold']) {
    assert.match(workspace, new RegExp(status));
    assert.match(report, new RegExp(status));
  }
  assert.match(workspace, /AS handled_total/);
  assert.match(workspace, /AS status_total/);
  assert.match(overview, /handled_total/);
  assert.match(mobile, /handled_total/);
  assert.match(report, /状态处理率/);
  assert.match(dashboard, /状态分布|处理状态/);
  assert.match(workbench, /queue: 'triage', status: 'negative_feishu'/);
});
