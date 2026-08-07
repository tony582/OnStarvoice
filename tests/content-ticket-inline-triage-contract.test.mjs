import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TICKET_EVENT_TYPE_BY_ACTION } from '../server/services/ticket-event-types.js';
import { appendTicketLifecycleFilter } from '../server/routes/triage.js';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('content tickets become the fifth handling mode and persist a searchable external number', () => {
  const migration = source('server/db/migrations/057_content_ticket_inline_triage.sql');
  const correctiveMigration = source('server/db/migrations/058_content_ticket_processing_mode.sql');
  const tickets = source('server/routes/tickets.js');
  const triage = source('server/routes/triage.js');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS external_ticket_no TEXT/);
  assert.match(migration, /INSERT INTO record_triage \(tenant_id, record_id, status\)/);
  assert.match(migration, /SELECT DISTINCT t\.tenant_id, t\.source_record_id, 'ticketed'/);
  assert.match(migration, /DO UPDATE SET status = excluded\.status/);
  assert.doesNotMatch(migration, /metadata->>'previousStatus'/);
  assert.match(correctiveMigration, /SELECT DISTINCT t\.tenant_id, t\.source_record_id, 'ticketed'/);
  assert.match(migration, /'done', 'dismissed'/);
  assert.match(tickets, /external_ticket_no/);
  assert.match(tickets, /externalTicketNo/);
  assert.match(tickets, /external_ticket_no_too_long/);
  assert.match(tickets, /async function markContentRecordTicketed/);
  assert.match(tickets, /VALUES \(\$1, \$2, 'ticketed'/);
  assert.match(tickets, /UPDATE comment_leads SET status = 'ticketed'/);
  assert.match(tickets, /nextStatus: 'ticketed'/);
  assert.match(tickets, /processingModeChanged: previousStatus !== 'ticketed'/);

  assert.match(triage, /LATEST_CONTENT_TICKET_JOIN/);
  assert.match(triage, /ts\.external_ticket_no ILIKE/);
  assert.match(triage, /matchedTicketSql/);
  assert.match(triage, /AS matched_ticket_number/);
  assert.match(triage, /appendTicketFilter/);
  assert.match(triage, /appendTicketLifecycleFilter/);
  assert.match(triage, /ticketFilter === 'with'/);
  assert.match(triage, /ticketFilter === 'without'/);
  assert.match(triage, /AS ticket_number/);
  assert.match(triage, /header: '工单号码'/);
  assert.match(triage, /'official_responded', 'no_action', 'ticketed'/);
});

test('content triage marks and filters tickets while transfer accepts the client Excel number', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const board = source('web/admin/src/pages/workbench/TriageBoard.tsx');
  const dispatch = source('web/admin/src/components/shared/TicketDispatch.tsx');
  const tickets = source('server/routes/tickets.js');

  assert.doesNotMatch(queue, /const \[ticketFilter, setTicketFilter\]/);
  assert.doesNotMatch(queue, /params\.set\('ticket', ticketFilter\)/);
  assert.doesNotMatch(queue, /aria-label="工单筛选"/);
  assert.match(queue, /aria-label=\{`工单状态筛选，当前\$\{selected\.label\}`\}/);
  assert.match(queue, /setTriageStatus\(value \? 'ticketed' : ''\)/);
  assert.match(queue, /\{ value: 'active', label: '处理中'/);
  assert.match(queue, /\{ value: 'closed', label: '已结案'/);
  assert.match(queue, /params\.set\('ticketStatus', ticketStatusFilter\)/);
  assert.doesNotMatch(queue, /<optgroup label="工单">/);
  assert.match(queue, /newStatus === 'ticketed' \? dispatchTicket\(record\)/);
  assert.match(queue, /搜索标题、正文、作者、工单号/);
  assert.match(queue, /ticket_number/);
  assert.match(queue, /matched_ticket_number/);
  assert.match(queue, /查看处理进展/);
  assert.match(queue, /setBoardNonce\(n => n \+ 1\)/);
  assert.match(board, /ticket_number/);
  assert.doesNotMatch(board, /ticketFilter/);
  assert.match(board, /key: 'ticketed', label: '已转工单'/);
  assert.match(board, /onDispatchTicket\(card\)/);
  assert.match(queue, /工单号待补录/);
  assert.match(board, /工单号待补录/);
  assert.match(queue, /function InlineTicketNumberEditor/);
  assert.match(queue, /initialValue=\{number\}/);
  assert.match(queue, /onCancel=\{\(\) => setEditing\(false\)\}/);
  assert.match(queue, /event\.stopPropagation\(\)/);

  const inlineEditor = queue.slice(
    queue.indexOf('function InlineTicketNumberEditor'),
    queue.indexOf('function TriageStatusMenu'),
  );
  assert.match(inlineEditor, /maxLength=\{100\}/);
  assert.match(inlineEditor, /onBlur=\{\(\) =>/);
  assert.match(inlineEditor, /externalTicketNo === initialValue\.trim\(\)/);
  assert.match(inlineEditor, /event\.key === 'Escape'/);
  assert.match(inlineEditor, /onCancel\?\.\(\)/);
  assert.match(inlineEditor, /role="alert"/);
  assert.match(queue, /`\/tickets\/\$\{record\.ticket_id\}\/external-number`/);
  assert.match(queue, /const previousExternalTicketNo = String\(record\.ticket_number \|\| ''\)\.trim\(\)/);
  assert.match(queue, /const closedNumberBackfill = record\.ticket_status === 'closed' && !previousExternalTicketNo/);
  assert.match(queue, /\(record\.ticket_status === 'closed' \|\| record\.archived_at\) && !closedNumberBackfill/);
  assert.match(queue, /previousExternalTicketNo,/);
  assert.match(tickets, /router\.patch\('\/:id\/external-number'/);
  assert.match(tickets, /requireSessionUser/);
  assert.match(tickets, /external_ticket_no_required/);
  assert.match(tickets, /const closedContentBackfill = ticket\.status === 'closed'[\s\S]{0,180}ticket\.source_type === 'content'[\s\S]{0,180}!currentExternalTicketNo/);
  assert.match(tickets, /if \(ticket\.status === 'closed' && !closedContentBackfill\)/);
  assert.match(tickets, /if \(lifecycle\.archived_at && !closedContentBackfill\)/);
  assert.match(tickets, /error: 'ticket_number_locked'/);
  assert.match(tickets, /error: 'ticket_number_conflict'/);
  assert.match(tickets, /record\.ticket_number_changed/);
  assert.match(tickets, /previousExternalTicketNo: currentExternalTicketNo/);
  assert.match(tickets, /record\.ticket_number_added/);

  assert.match(dispatch, /externalTicketNo/);
  assert.match(dispatch, /工单号码/);
  assert.match(dispatch, /客户 Excel/);
  assert.match(dispatch, /maxLength=\{100\}/);
  assert.match(dispatch, /sourceType\?: 'content' \| 'comment'/);
  assert.match(dispatch, /role="dialog"/);
  assert.match(dispatch, /htmlFor="ticket-dispatch-number"/);
  assert.doesNotMatch(dispatch, /稍后在内容列表补录|保存后支持搜索|后续进展和结案/);

  const initialFocusEffect = dispatch.slice(
    dispatch.lastIndexOf('useEffect(() => {', dispatch.indexOf('ref.current?.focus()')),
    dispatch.indexOf('useEffect(() => {', dispatch.indexOf('ref.current?.focus()') + 1),
  );
  assert.match(initialFocusEffect, /ref\.current\?\.focus\(\)[\s\S]*\}, \[\]\)/);
  assert.doesNotMatch(initialFocusEffect, /externalTicketNo|priority|assigneeUserId|note|assignees/);
});

test('ticket lifecycle filtering follows the same active-first ticket shown in the list', () => {
  const active = appendTicketLifecycleFilter('WHERE r.tenant_id = $1', { ticketStatus: 'active' });
  const closed = appendTicketLifecycleFilter('WHERE r.tenant_id = $1', { ticketStatus: 'closed' });
  const ignored = appendTicketLifecycleFilter('WHERE r.tenant_id = $1', { ticketStatus: 'unexpected' });

  for (const sql of [active, closed]) {
    assert.match(sql, /tfs\.source_type = 'content'/);
    assert.match(sql, /ORDER BY \(tfs\.status <> 'closed'\) DESC, tfs\.created_at DESC, tfs\.id DESC/);
  }
  assert.match(active, /\) <> 'closed'$/);
  assert.match(closed, /\) = 'closed'$/);
  assert.equal(ignored, 'WHERE r.tenant_id = $1');
});

test('ticket progress is merged into the content processing timeline', () => {
  const records = source('server/routes/records.js');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const triage = source('server/routes/triage.js');

  assert.match(records, /FROM ticket_notes tn/);
  assert.match(records, /t\.source_type = 'content'/);
  assert.match(records, /record\.ticket_progress_added/);
  assert.match(records, /record\.ticket_closed/);
  assert.match(records, /record\.ticket_reopened/);
  assert.match(records, /record\.ticket_done/);
  assert.match(records, /record\.ticket_dismissed/);
  assert.match(drawer, /\/tickets\/.*\/notes/);
  assert.match(drawer, /新增记录/);
  assert.match(drawer, /record\.ticket_progress_added/);
  assert.match(drawer, /record\.ticket_number_added/);
  assert.match(drawer, /record\.ticket_number_changed/);
  assert.match(drawer, /record\.ticket_closed/);
  assert.match(drawer, /<ActivityTimeline items=\{activity\}/);
  assert.match(drawer, /处理记录/);
  assert.match(triage, /FROM ticket_notes tn/);
  assert.match(triage, /header: '处理记录'/);
});

test('ticket lifecycle remains append-only and reopening cannot create a second active ticket', () => {
  const tickets = source('server/routes/tickets.js');
  const drawer = source('web/admin/src/components/shared/TicketDrawer.tsx');

  assert.match(tickets, /findOtherActiveTicket/);
  assert.match(tickets, /error: 'active_ticket_exists'/);
  assert.deepEqual(TICKET_EVENT_TYPE_BY_ACTION, {
    done: 'done',
    dismiss: 'dismissed',
    close: 'closed',
    reopen: 'reopened',
  });
  assert.match(tickets, /const eventType = TICKET_EVENT_TYPE_BY_ACTION\[action\]/);
  assert.doesNotMatch(tickets, /action === 'dismiss' \? 'dismissed' : action/);
  assert.match(tickets, /decision === 'confirm' \? 'closed' : 'reopened'/);
  assert.match(tickets, /COALESCE\(NULLIF\(\$P, ''\), handle_note\)/);
  assert.match(drawer, /note\.event_type === ticket\.status/);
});

test('closing a content ticket archives its record atomically and remains safely retryable', () => {
  const tickets = source('server/routes/tickets.js');
  const patchStart = tickets.indexOf("router.patch('/:id'");
  const reviewStart = tickets.indexOf("router.patch('/:id/review'", patchStart);
  const patchRoute = tickets.slice(patchStart, reviewStart);

  assert.ok(patchStart > -1 && reviewStart > patchStart, 'ticket action route must be present');
  assert.match(tickets, /async function archiveContentRecordForTicketClose/);
  assert.match(tickets, /if \(ticket\.source_type !== 'content'\) return null/);
  assert.match(tickets, /INSERT INTO record_triage/);
  assert.match(tickets, /WHERE record_triage\.archived_at IS NULL/);
  assert.match(tickets, /'record\.archived', 'record'/);
  assert.match(tickets, /source: 'ticket_close'/);
  assert.match(tickets, /idempotentTicketClose/);
  assert.match(tickets, /const activeTicket = await findOtherActiveTicket\(tx, ticket, tenantId\)/);
  assert.match(tickets, /blockedByActiveTicket: true/);
  assert.match(tickets, /blockingActiveTicketId: activeTicket\.id/);
  assert.match(tickets, /blockingActiveTicketNumber: activeTicket\.external_ticket_no \|\| ''/);
  assert.match(patchRoute, /await lockTicketSource[\s\S]+FROM tickets WHERE id = \$1 AND tenant_id = \$2 FOR UPDATE/);
  assert.match(patchRoute, /action === 'close' && current\.source_type === 'content'/);
  assert.match(patchRoute, /return \{ invalidState: 'closed' \}/);
  assert.match(patchRoute, /const eventType = TICKET_EVENT_TYPE_BY_ACTION\[action\]/);
  assert.match(patchRoute, /recordArchived/);
  assert.match(patchRoute, /recordArchiveChanged/);
  assert.match(patchRoute, /archivedRecordId/);
  assert.match(patchRoute, /recordArchiveBlockedByActiveTicket/);
  assert.match(patchRoute, /blockingActiveTicketId/);
  assert.match(patchRoute, /blockingActiveTicketNumber/);
  assert.match(patchRoute, /current\.source_type === 'content'[\s\S]+content_reopen_not_allowed/);
  assert.match(patchRoute, /error: 'content_ticket_reopen_not_allowed'/);
  assert.match(patchRoute, /请先取消归档，再新建工单/);
});

test('content review confirmation uses source-first locking and archives in the same transaction', () => {
  const tickets = source('server/routes/tickets.js');
  const reviewStart = tickets.indexOf("router.patch('/:id/review'");
  const reviewRoute = tickets.slice(reviewStart);

  assert.ok(reviewStart > -1, 'ticket review route must be present');
  assert.match(reviewRoute, /SELECT id, source_type, source_record_id, source_comment_id/);
  assert.match(reviewRoute, /await lockTicketSource\(tx, ticketHint, req\.tenantId\)/);
  assert.match(reviewRoute, /feedback_status = 'pending_review'[\s\S]+FOR UPDATE/);
  assert.match(reviewRoute, /decision === 'reopen' && current\.source_type === 'content'/);
  assert.match(reviewRoute, /invalidState: 'content_reopen_not_allowed'/);
  assert.match(reviewRoute, /decision === 'confirm'[\s\S]+archiveContentRecordForTicketClose/);
  assert.match(reviewRoute, /recordArchiveBlockedByActiveTicket/);
  assert.match(reviewRoute, /error: 'content_ticket_reopen_not_allowed'/);
});

test('migration reconciles content-ticket archive state without changing existing handling fields', () => {
  const migration = source('server/db/migrations/057_content_ticket_inline_triage.sql');
  const reconciliationStart = migration.indexOf('-- 归档生命周期与内容工单状态双向对齐');
  const reconciliation = migration.slice(reconciliationStart);
  const conflictUpdate = reconciliation.slice(reconciliation.lastIndexOf('DO UPDATE SET'));

  assert.ok(reconciliationStart > -1, 'archive reconciliation must be present');
  assert.match(reconciliation, /UPDATE record_triage rt/);
  assert.match(reconciliation, /rt\.archived_at IS NOT NULL/);
  assert.match(reconciliation, /t\.source_type = 'content'/);
  assert.match(reconciliation, /t\.status <> 'closed'/);
  assert.match(reconciliation, /latest_closed_content_ticket/);
  assert.match(reconciliation, /t\.status = 'closed'/);
  assert.match(reconciliation, /NOT EXISTS/);
  assert.match(reconciliation, /COALESCE\(t\.reviewed_at, t\.handled_at, t\.updated_at\)/);
  assert.match(reconciliation, /ON CONFLICT \(tenant_id, record_id\)/);
  assert.match(reconciliation, /WHERE record_triage\.archived_at IS NULL/);
  assert.doesNotMatch(conflictUpdate, /\bstatus\s*=/);
  assert.doesNotMatch(conflictUpdate, /\bpriority\s*=/);
  assert.doesNotMatch(conflictUpdate, /\bowner_(?:user_id|name)\s*=/);
  assert.doesNotMatch(conflictUpdate, /\bnote\s*=/);
});

test('overview ticket progress uses mutually exclusive handling modes', () => {
  const workspace = source('server/routes/workspace.js');
  const overview = source('web/admin/src/pages/OverviewPage.tsx');
  const mobile = source('web/admin/src/mobile/MobileApp.tsx');
  const report = source('server/services/report-generator.js');
  const dashboard = source('web/admin/src/pages/insights/DashboardTab.tsx');
  const utils = source('web/admin/src/lib/utils.ts');

  assert.match(workspace, /AS active_or_ticketed/);
  assert.match(workspace, /COALESCE\(rt\.status, 'unhandled'\) IN \('unhandled', 'reviewing'\)[\s\S]+OR COALESCE\(rt\.status, 'unhandled'\) = 'ticketed'/);
  assert.match(overview, /k\.active_or_ticketed/);
  assert.match(mobile, /k\.active_or_ticketed/);
  assert.match(report, /active_or_ticketed/);
  assert.doesNotMatch(report, /workflowStats\?\.total_content/);
  assert.doesNotMatch(dashboard, /两项可重叠|并行维度/);
  assert.match(dashboard, /互斥处理模式/);
  assert.doesNotMatch(dashboard, /待处理=进入处理队列、尚未转工单/);
  assert.match(utils, /issue_linked: '已关联事件'/);
});

test('the retired feedback queue safely opens the ticketed handling mode without a separate entry', () => {
  const workbench = source('web/admin/src/pages/WorkbenchPage.tsx');
  const sidebar = source('web/admin/src/components/layout/Sidebar.tsx');
  const desktop = source('web/admin/src/desktop/DesktopApp.tsx');
  const mobile = source('web/admin/src/mobile/MobileApp.tsx');
  const dispatch = source('web/admin/src/components/shared/TicketDispatch.tsx');

  assert.doesNotMatch(workbench, /TicketFeedbackQueue/);
  assert.match(workbench, /params\?\.queue === 'feedback'/);
  assert.match(workbench, /queue: 'triage', status: 'ticketed'/);
  assert.doesNotMatch(sidebar, /queue: 'feedback'/);
  assert.doesNotMatch(sidebar, /工单闭环/);
  assert.match(sidebar, /params\?\.queue === 'feedback' \? 'triage'/);
  assert.doesNotMatch(desktop, /工单闭环/);
  assert.match(desktop, /params\?\.queue === 'feedback' \? 'triage'/);
  assert.doesNotMatch(mobile, /工单闭环/);
  assert.doesNotMatch(mobile, /ticketsPending/);
  assert.match(mobile, /query\.queue === 'feedback' \? 'triage'/);
  assert.match(mobile, /label="已转工单"[\s\S]+queue: 'triage', status: 'ticketed'/);
  assert.doesNotMatch(dispatch, /评论进入客服工单|后续进展和结案/);
});

test('active content tickets close from the record drawer and leave the working list', () => {
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');

  assert.match(drawer, /api\.patch\(`\/tickets\/\$\{r\.ticket_id\}`, \{[\s\S]+action: 'close',[\s\S]+note: ticketCloseNote/);
  assert.match(drawer, /await onTicketClosed\(result\)/);
  assert.match(drawer, /确认结案？/);
  assert.match(drawer, /结案后内容将自动移入已归档/);
  assert.match(drawer, /aria-label="结案说明"/);
  assert.match(drawer, /填写结案说明 \/ 处理结论（可留空）/);
  assert.match(drawer, /ticketCloseConfirmOpen && addingTicketProgress/);
  assert.match(queue, /onTicketClosed: async \(result: ContentTicketCloseResult\) =>/);
  assert.match(queue, /result\.recordArchived === true/);
  assert.match(queue, /if \(recordArchived\)[\s\S]+syncArchiveLocally\(\[recordId\]\)/);
  assert.match(queue, /recordArchiveBlockedByActiveTicket/);
  assert.match(queue, /继续保留在“工作中”/);
  assert.match(queue, /await load\(targetPage, \{ silent: true \}\)/);
  assert.match(queue, /skippedActiveTicketIds/);
  assert.match(queue, /syncArchiveLocally\(changedIds\)/);
  assert.match(queue, /hasOpenTicket=\{hasOpenTicket\}/);
});
