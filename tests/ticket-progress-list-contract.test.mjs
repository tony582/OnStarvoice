import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('dispatched ticket list exposes and immediately syncs the latest process note', () => {
  const routes = source('server/routes/tickets.js');
  const queue = source('web/admin/src/pages/workbench/TicketFeedbackQueue.tsx');
  const drawer = source('web/admin/src/components/shared/TicketDrawer.tsx');

  assert.match(routes, /AS latest_note_author/);
  assert.match(routes, /AS latest_note_at/);
  assert.match(queue, /latest_note_author/);
  assert.match(queue, /latest_note_at/);
  assert.match(queue, /syncAddedNote/);
  assert.match(queue, /status: item\.status === 'pending' \? 'doing'/);
  assert.match(queue, /onNoteAdded=\{note => syncAddedNote\(drawer\.id, note\)\}/);
  assert.match(drawer, /onNoteAdded\?\.\(result\.note\)/);
});

test('content ticket drawer follows the triage detail anatomy', () => {
  const drawer = source('web/admin/src/components/shared/TicketDrawer.tsx');
  const queue = source('web/admin/src/pages/workbench/TicketFeedbackQueue.tsx');

  assert.match(drawer, /data-drawer-header/);
  assert.match(drawer, /label: '内容'/);
  assert.match(drawer, /label: `评论 \(\$\{comments\.length\}\)`/);
  assert.match(drawer, /label: `官方回复 \(\$\{officialResponses\.length\}\)`/);
  assert.match(drawer, /label: '采集'/);
  assert.match(drawer, /label: `处理记录 \(\$\{timeline\.length\}\)`/);
  assert.match(drawer, /工单信息/);
  assert.match(drawer, /互动数据|label="点赞"/);
  assert.match(drawer, /记录进展/);
  assert.match(queue, /data-ticket-detail-trigger/);
});

test('closed tickets are read-only until reopened and keep structured history', () => {
  const migration = source('server/db/migrations/039_ticket_activity.sql');
  const routes = source('server/routes/tickets.js');
  const queue = source('web/admin/src/pages/workbench/TicketFeedbackQueue.tsx');
  const drawer = source('web/admin/src/components/shared/TicketDrawer.tsx');

  assert.match(migration, /event_type TEXT NOT NULL DEFAULT 'note'/);
  assert.match(migration, /'note', 'closed', 'reopened'/);
  assert.match(routes, /action === 'reopen'/);
  assert.match(routes, /status = 'doing', feedback_status = 'reopened'/);
  assert.match(routes, /工单已结案，请重开后再添加进展/);
  assert.match(routes, /eventType = action === 'close' \? 'closed' : 'reopened'/);
  assert.match(queue, /action: 'reopen'/);
  assert.match(queue, /onReopenTicket=\{\(\) => reopenTicket\(drawer\)\}/);
  assert.match(drawer, /canWrite && !closed/);
  assert.match(drawer, /重开工单/);
});
