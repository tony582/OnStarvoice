import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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

function existingTicketHandlerFixture({ status = 'negative_cold', actorType = 'user', rejectAudit = false } = {}) {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const recordId = '00000000-0000-0000-0000-000000000002';
  const ticket = { id: '00000000-0000-0000-0000-000000000003', external_ticket_no: 'FS-100', source_type: 'content', source_record_id: recordId };
  const committed = { status, tableNo: '', audits: [] };
  let handler;
  const router = { post(path, ...handlers) { if (path === '/') handler = handlers.at(-1); }, patch() {}, get() {} };
  const middleware = () => {};
  vm.runInNewContext(source('server/routes/tickets.js').replace(/^import .*;\n/gm, '').replace('export default router;', ''), {
    Router: () => router, requireTenantAccess: middleware, requireTenantWriter: middleware, requireSessionUser: middleware,
    queryOne: async (sql, params) => {
      assert.match(sql, /FROM records WHERE id = \$1 AND tenant_id = \$2/);
      assert.deepEqual(Array.from(params), [recordId, tenantId]);
      return { title: '测试帖子', platform: 'xiaohongshu' };
    },
    getRecordLifecycle: async () => ({ id: recordId, archived_at: null }),
    withTransaction: async callback => {
      const pending = structuredClone(committed);
      const result = await callback({
        queryOne: async sql => {
          if (/FROM tickets/.test(sql)) return ticket;
          if (/FROM record_triage/.test(sql)) return pending.status === null ? null : { status: pending.status };
          throw new Error('Unexpected query: ' + sql);
        },
        execute: async (sql, params) => {
          if (/INSERT INTO record_triage/.test(sql)) {
            assert.deepEqual(Array.from(params).slice(0, 2), [tenantId, recordId]);
            pending.status = 'negative_feishu'; pending.tableNo = params[4]; return;
          }
          assert.match(sql, /'record\.triage_updated', 'record'/);
          assert.equal(params[0], tenantId); assert.equal(params[1], actorType); assert.equal(params[4], recordId);
          if (rejectAudit) throw new Error('audit unavailable');
          pending.audits.push(JSON.parse(params[5]));
        },
      });
      Object.assign(committed, pending);
      return result;
    },
  });
  return { committed, ticket, invoke: async () => {
    let result;
    const req = { tenantId, actorType, authCode: actorType === 'auth_code' ? 'test-auth-code' : '',
      ...(actorType === 'user' ? { user: { id: '00000000-0000-0000-0000-000000000004', name: '处理人' } } : {}),
      body: { sourceType: 'content', sourceId: recordId, externalTicketNo: 'FS-100' } };
    await handler(req, { json: value => { result = value; return value; }, status: () => { throw new Error('Unexpected HTTP error'); } }, error => { throw error; });
    return result;
  } };
}

test('existing legacy content ticket records only a real status transition, including auth-code clients', async () => {
  for (const actorType of ['user', 'auth_code']) {
    const fixture = existingTicketHandlerFixture({ actorType });
    assert.equal((await fixture.invoke()).existed, true);
    assert.equal(fixture.committed.status, 'negative_feishu');
    assert.deepEqual(fixture.committed.audits, [{ previousStatus: 'negative_cold', nextStatus: 'negative_feishu', source: 'existing_ticket', ticketId: fixture.ticket.id }]);
    await fixture.invoke();
    assert.equal(fixture.committed.audits.length, 1, 'repeated same-status request must not become another handling event');
  }
});

test('existing same-state ticket may fill its Feishu number without recording a handling event', async () => {
  const fixture = existingTicketHandlerFixture({ status: 'negative_feishu' });
  await fixture.invoke();
  assert.equal(fixture.committed.tableNo, 'FS-100');
  assert.deepEqual(fixture.committed.audits, []);
  const missingTriage = existingTicketHandlerFixture({ status: null });
  await missingTriage.invoke();
  assert.equal(missingTriage.committed.audits[0].previousStatus, 'unhandled');
});

test('failed transition audit leaves the existing ticket status mutation uncommitted', async () => {
  const fixture = existingTicketHandlerFixture({ rejectAudit: true });
  await assert.rejects(fixture.invoke(), /audit unavailable/);
  assert.equal(fixture.committed.status, 'negative_cold');
  assert.equal(fixture.committed.tableNo, '');
  assert.deepEqual(fixture.committed.audits, []);
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

  for (const status of ['unhandled', 'replied', 'reviewed', 'reviewed_non_monitor', 'unavailable', 'privacy_unreachable', 'negative_feishu', 'negative_cold', 'negative_comment']) {
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
