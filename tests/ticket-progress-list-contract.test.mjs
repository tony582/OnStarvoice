import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { TICKET_EVENT_TYPE_BY_ACTION } from '../server/services/ticket-event-types.js';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('legacy comment tickets stay comment-only without adding a new navigation entry', () => {
  const routes = source('server/routes/tickets.js');
  const opinion = source('web/admin/src/pages/OpinionPage.tsx');
  const sidebar = source('web/admin/src/components/layout/Sidebar.tsx');
  const mobile = source('web/admin/src/mobile/MobileApp.tsx');
  const dispatch = source('web/admin/src/components/shared/TicketDispatch.tsx');
  const drawer = source('web/admin/src/components/shared/TicketDrawer.tsx');

  assert.match(opinion, /status: state, type: 'comment'/);
  assert.doesNotMatch(opinion, /TYPE_OPTIONS/);
  assert.match(opinion, /onCloseTicket=\{drawer\.source_type === 'comment'/);
  assert.match(opinion, /\? \(\) => act\(drawer, 'close'\)/);
  assert.match(opinion, /act\(it, 'close'\)/);
  assert.match(opinion, /评论工单已结案/);
  assert.match(opinion, /needNote \|\| action === 'close'/);
  assert.match(opinion, /填写结案说明 \/ 处理结论（可留空）/);
  assert.doesNotMatch(sidebar, /id: 'opinion', label: '客服工单'/);
  assert.doesNotMatch(mobile, /title="客服工单"|title: '客服工单'/);
  assert.doesNotMatch(dispatch, /后续进展和结案在工单详情中记录/);
  assert.match(routes, /action === 'close'/);
  assert.match(opinion, /onNoteAdded=\{note =>/);
  assert.match(drawer, /onNoteAdded\?\.\(result\.note\)/);
});

test('content ticket drawer follows the triage detail anatomy', () => {
  const drawer = source('web/admin/src/components/shared/TicketDrawer.tsx');
  const opinion = source('web/admin/src/pages/OpinionPage.tsx');

  assert.match(drawer, /data-drawer-header/);
  assert.match(drawer, /label: '内容'/);
  assert.match(drawer, /label: `评论 \(\$\{comments\.length\}\)`/);
  assert.match(drawer, /label: `官方回复 \(\$\{officialResponses\.length\}\)`/);
  assert.match(drawer, /label: '采集'/);
  assert.match(drawer, /label: `处理记录 \(\$\{timeline\.length\}\)`/);
  assert.match(drawer, /工单信息/);
  assert.match(drawer, /互动数据|label="点赞"/);
  assert.match(drawer, /记录进展/);
  assert.match(opinion, /data-ticket-detail-trigger/);
});

test('closed tickets are read-only, append structured history, and have no retired closure page', () => {
  const migration = source('server/db/migrations/039_ticket_activity.sql');
  const inlineMigration = source('server/db/migrations/057_content_ticket_inline_triage.sql');
  const routes = source('server/routes/tickets.js');
  const opinion = source('web/admin/src/pages/OpinionPage.tsx');
  const drawer = source('web/admin/src/components/shared/TicketDrawer.tsx');

  assert.match(migration, /event_type TEXT NOT NULL DEFAULT 'note'/);
  assert.match(migration, /'note', 'closed', 'reopened'/);
  assert.match(inlineMigration, /'note', 'closed', 'reopened', 'done', 'dismissed'/);
  assert.match(routes, /action === 'reopen'/);
  assert.match(routes, /status = 'doing', feedback_status = 'reopened'/);
  assert.match(routes, /工单已结案，请重开后再添加进展/);
  assert.deepEqual(TICKET_EVENT_TYPE_BY_ACTION, {
    done: 'done',
    dismiss: 'dismissed',
    close: 'closed',
    reopen: 'reopened',
  });
  assert.match(routes, /const eventType = TICKET_EVENT_TYPE_BY_ACTION\[action\]/);
  assert.doesNotMatch(routes, /action === 'dismiss' \? 'dismissed' : action/);
  assert.match(routes, /content_ticket_reopen_not_allowed/);
  assert.match(opinion, /onCloseTicket=/);
  assert.match(drawer, /canWrite && !closed/);
  assert.equal(existsSync(new URL('../web/admin/src/pages/workbench/TicketFeedbackQueue.tsx', import.meta.url)), false);
});
