import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('content triage keeps five states but presents content handling and work orders as two paths', () => {
  const labels = source('web/admin/src/lib/utils.ts');
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const board = source('web/admin/src/pages/workbench/TriageBoard.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const dashboard = source('web/admin/src/pages/insights/DashboardTab.tsx');
  const route = source('server/routes/triage.js');
  const migration = source('server/db/migrations/036_record_triage_no_action.sql');
  const feedbackOnlyMigration = source('server/db/migrations/038_false_positive_feedback_only.sql');

  for (const label of ['待处理', '负面流程', '官方已评', '无需操作', '已转工单']) {
    assert.match(labels, new RegExp(label));
    assert.match(queue, new RegExp(label));
    assert.match(board, new RegExp(label));
    assert.match(drawer, new RegExp(label));
    assert.match(dashboard, new RegExp(label));
    assert.match(route, new RegExp(label));
  }
  for (const staleLabel of ['走负面流程', '官方已评论', '不需要操作']) {
    assert.doesNotMatch([labels, queue, board, drawer, dashboard, route].join('\n'), new RegExp(staleLabel));
  }

  const queueContentModes = queue.slice(
    queue.indexOf('const CONTENT_TRIAGE_MODES'),
    queue.indexOf('const TICKET_TRIAGE_MODE'),
  );
  for (const [value, label] of [
    ['unhandled', '待处理'],
    ['reviewing', '负面流程'],
    ['official_responded', '官方已评'],
    ['no_action', '无需操作'],
  ]) {
    assert.match(queueContentModes, new RegExp(`value: '${value}'[^\\n]+label: '${label}'`));
  }
  assert.doesNotMatch(queueContentModes, /value: 'ticketed'/);
  assert.match(queue, /const TICKET_TRIAGE_MODE = \{ value: 'ticketed' as const, label: '已转工单'/);
  assert.match(queue, /newStatus === 'ticketed' \? dispatchTicket\(record\)/);
  assert.match(queue, /function TriageStatusMenu/);
  assert.match(queue, /onChangeMode=\{\(nextStatus: TriageMode\)/);
  assert.match(queue, /api\.patch\('\/triage\/records\/' \+ recordId, \{ status: newStatus \}\)/);
  assert.match(queue, /params\.set\('queue', 'triage'\)/);
  assert.match(queue, /return !triageStatus \|\| triageStatus === newStatus/);
  assert.doesNotMatch(queue, /initial\?\.ticket === 'with'/);
  assert.doesNotMatch(queue, /label: '已处理'/);
  assert.match(queue, /aria-label="内容处理模式"/);
  assert.match(drawer, /aria-label="内容处理模式"/);
  assert.match(drawer, /addingTicketProgress/);

  const boardContentModes = board.slice(
    board.indexOf('const CONTENT_COLUMNS'),
    board.indexOf('const TICKET_COLUMN'),
  );
  for (const value of ['unhandled', 'reviewing', 'official_responded', 'no_action']) {
    assert.match(boardContentModes, new RegExp(`key: '${value}'`));
  }
  assert.doesNotMatch(boardContentModes, /ticketed/);
  assert.match(board, /\{ key: 'ticketed', label: '已转工单'/);
  assert.match(board, /to === 'ticketed'/);
  assert.match(board, /onDispatchTicket\(card\)/);
  assert.match(board, /to === 'official_responded'/);
  assert.match(board, /\/official-response/);
  assert.match(board, /queue: 'triage'/);
  assert.match(route, /status === 'official_responded'/);
  assert.match(route, /official_response_status = 'responded'/);
  assert.match(route, /updatedIds: \[\.\.\.updatedSet\]/);
  assert.match(route, /const TRIAGE_QUEUE_CONDITION/);
  assert.match(route, /queue === 'triage'/);
  assert.match(route, /IN \('unhandled', 'reviewing', 'official_responded', 'no_action', 'ticketed'\)/);
  const recordModeRoute = route.slice(route.indexOf("router.patch('/records/:recordId'"));
  assert.match(recordModeRoute, /status <> 'closed'/);
  assert.match(recordModeRoute, /error: 'content_ticket_active'/);
  assert.match(recordModeRoute, /工单结案前，处理模式须保留为“已转工单”/);
  const activeQueue = route.slice(
    route.indexOf('export const ACTIVE_QUEUE_CONDITION'),
    route.indexOf('// 处理模式和归档生命周期相互独立'),
  );
  assert.doesNotMatch(activeQueue, /official_response_status/);
  assert.match(route, /header: '处理模式'/);
  assert.match(migration, /status = 'no_action'/);
  assert.match(migration, /archived_at = COALESCE\(archived_at, updated_at, now\(\)\)/);
  const statusSet = route.match(/const TRIAGE_STATUSES = new Set\(\[[^\]]+\]\)/)?.[0] || '';
  assert.doesNotMatch(statusSet, /false_positive/);
  assert.doesNotMatch(statusSet, /ticketed/);
  assert.match(route, /false_positive_is_feedback_only/);
  assert.doesNotMatch(
    feedbackOnlyMigration.match(/ADD CONSTRAINT record_triage_status_check[\s\S]*$/)?.[0] || '',
    /false_positive/,
  );
});

test('archive is an explicit single or batch lifecycle action, independent from handling mode', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const route = source('server/routes/triage.js');
  const migration = source('server/db/migrations/035_record_triage_archive.sql');

  assert.match(queue, /label: '工作中'/);
  assert.match(queue, /label: '已归档'/);
  assert.doesNotMatch(queue, /label: '未归档'/);
  assert.match(queue, /params\.set\('bucket', 'archived'\)/);
  assert.match(queue, /api\.patch\('\/triage\/records\/archive', \{ ids: \[recordId\], archived \}\)/);
  assert.match(queue, /api\.patch\('\/triage\/records\/archive', \{ ids, archived \}\)/);
  assert.match(queue, /key: 'archive', label: '归档'/);
  assert.match(queue, /key: 'unarchive', label: '取消归档'/);
  assert.match(drawer, /onSetArchived/);

  const archiveStart = route.indexOf("router.patch('/records/archive'");
  const recordStart = route.indexOf("router.patch('/records/:recordId'");
  assert.ok(archiveStart > -1 && recordStart > archiveStart, 'archive route must precede the parameter route');
  const archiveRoute = route.slice(archiveStart, recordStart);
  assert.match(archiveRoute, /archived_at = now\(\)/);
  assert.match(archiveRoute, /archived_at = NULL/);
  assert.match(archiveRoute, /DO UPDATE SET\s+archived_at = now\(\)/);
  assert.doesNotMatch(archiveRoute, /DO UPDATE SET\s+status\s*=/);
  assert.match(archiveRoute, /let targetIds = validIds/);
  assert.match(archiveRoute, /if \(archived\)/);
  assert.match(archiveRoute, /source_type = 'content'/);
  assert.match(archiveRoute, /status <> 'closed'/);
  assert.match(archiveRoute, /activeTicketRecordIds/);
  assert.match(archiveRoute, /skippedActiveTicketIds/);
  assert.match(route, /const TRIAGE_ARCHIVE_CONDITION/);
  assert.match(route, /rt\.archived_at IS NULL/);
  assert.match(route, /rt\.archived_at IS NOT NULL/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS archived_by_user_id UUID/);
});

test('archived content is sealed until an explicit unarchive', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const lifecycle = source('server/services/record-lifecycle.js');
  const triageRoute = source('server/routes/triage.js');
  const recordsRoute = source('server/routes/records.js');
  const ticketsRoute = source('server/routes/tickets.js');
  const feedbackRoute = source('server/routes/feedback.js');
  const commentWorkflow = source('server/services/comment-workflow.js');

  assert.match(queue, /if \(archiveView === 'archived' \|\| record\.archived_at\) return/);
  assert.match(queue, /canWrite && !archived/);
  assert.match(queue, /archived \? '查看详情' : '查看并处理'/);
  assert.match(queue, /archiveView === 'archived'\s*\? \[\{ key: 'unarchive', label: '取消归档'/);

  assert.match(drawer, /const canProcess = canWrite && !archived/);
  assert.match(drawer, /该内容已封存为只读状态，取消归档后才能继续处理/);
  assert.match(drawer, /aria-label="归档内容操作"/);
  assert.match(drawer, /内容已封存/);
  assert.match(drawer, /onSetArchived\(false\)/);

  assert.match(lifecycle, /RECORD_ARCHIVED_ERROR = 'record_archived'/);
  assert.match(lifecycle, /内容已归档，请先取消归档后再处理/);
  assert.match(lifecycle, /FOR UPDATE OF r/);
  assert.match(triageRoute, /getRecordLifecycles/);
  assert.match(triageRoute, /sendRecordArchived\(res, archivedIds\)/);
  assert.match(recordsRoute, /sendRecordArchived\(res, \[req\.params\.id\]\)/);
  assert.match(ticketsRoute, /if \(lifecycle\.archived_at\) return sendRecordArchived\(res, \[sourceId\]\)/);
  assert.match(feedbackRoute, /if \(result\.archived\) return sendRecordArchived\(res, \[recordId\]\)/);

  const workflowStart = commentWorkflow.indexOf('async function appendCommentSignals');
  const workflowEnd = commentWorkflow.indexOf('// ── 抖音过采兜底', workflowStart);
  const archivedWorkflowGuard = commentWorkflow.slice(workflowStart, workflowEnd);
  assert.match(archivedWorkflowGuard, /rt\.archived_at/);
  assert.match(archivedWorkflowGuard, /if \(!current \|\| current\.archived_at\) return \[\]/);
  assert.doesNotMatch(commentWorkflow, /INSERT INTO record_triage/);
  assert.doesNotMatch(commentWorkflow, /UPDATE record_triage/);
  assert.match(commentWorkflow, /processingModeChanged:\s*false/);
  assert.match(commentWorkflow, /record\.comment_risk_detected/);
  assert.match(commentWorkflow, /record\.official_response_detected/);
});
