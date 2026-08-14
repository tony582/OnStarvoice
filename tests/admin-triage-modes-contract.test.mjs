import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const STATUSES = [
  ['unhandled', '待处理'],
  ['replied', '已回复'],
  ['reviewed', '已复核'],
  ['reviewed_non_monitor', '已复核-非监控内容'],
  ['unavailable', '已不可见'],
  ['privacy_unreachable', '负面–隐私设置无法触达'],
  ['negative_feishu', '负面-飞书表'],
  ['negative_cold', '负面-冷处理'],
];

function between(text, start, end) {
  const startAt = text.indexOf(start);
  assert.notEqual(startAt, -1, `missing contract boundary: ${start}`);
  const endAt = text.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `missing contract boundary: ${end}`);
  return text.slice(startAt, endAt);
}

test('content handling exposes exactly the eight customer-maintained states', () => {
  const labels = source('web/admin/src/lib/utils.ts');
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const board = source('web/admin/src/pages/workbench/TriageBoard.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const route = source('server/routes/triage.js');
  const privacyMigration = source('server/db/migrations/064_content_privacy_unreachable_status.sql');

  const statusSet = between(route, 'const TRIAGE_STATUSES = new Set([', ']);');
  const queueModes = between(queue, 'const CONTENT_TRIAGE_MODES', 'const PLATFORM_BADGE_CLASS');
  const boardColumns = between(board, 'const COLUMNS', 'const PER_COL');
  const drawerModes = between(drawer, 'const modeActions', 'const currentModeLabel');
  const constraint = between(privacyMigration, 'ADD CONSTRAINT record_triage_status_check', '));');

  for (const [value, label] of STATUSES) {
    for (const block of [labels, queueModes, boardColumns, drawerModes, route]) {
      assert.match(block, new RegExp(value));
      assert.match(block, new RegExp(label));
    }
    assert.match(constraint, new RegExp(`'${value}'`));
  }
  for (const legacy of ['reviewing', 'official_responded', 'no_action', 'ticketed', 'issue_linked']) {
    assert.doesNotMatch(statusSet, new RegExp(`['"]${legacy}['"]`));
    assert.doesNotMatch(queueModes, new RegExp(`value: ['"]${legacy}['"]`));
    assert.doesNotMatch(boardColumns, new RegExp(`key: ['"]${legacy}['"]`));
    assert.doesNotMatch(drawerModes, new RegExp(`value: ['"]${legacy}['"]`));
    assert.doesNotMatch(constraint, new RegExp(`['"]${legacy}['"]`));
  }
});

test('content status filtering supports selecting multiple states end to end', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const route = source('server/routes/triage.js');

  assert.match(queue, /const \[triageStatuses, setTriageStatuses\] = useState<string\[]>/);
  assert.match(queue, /triageStatuses\.forEach\(status => params\.append\('status', status\)\)/);
  assert.match(queue, /<MultiSelect[\s\S]*label="全部状态"[\s\S]*value=\{triageStatuses\}/);
  assert.match(queue, /<HeaderMultiFilter[\s\S]*label="处理状态"[\s\S]*value=\{triageStatuses\}/);
  assert.match(route, /function appendStatusFilter/);
  assert.match(route, /= ANY\(\$\$\{params\.length\}::text\[\]\)/);
  assert.equal((route.match(/appendStatusFilter\(where, params, status\)/g) || []).length, 2);
});

test('privacy-unreachable remains data-compatible while presenting as a negative state', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const board = source('web/admin/src/pages/workbench/TriageBoard.tsx');
  const badges = source('web/admin/src/components/ui/badge.tsx');
  const dashboard = source('web/admin/src/pages/insights/DashboardTab.tsx');
  const legacyCss = source('server/admin/admin.css');

  assert.match(queue, /value: 'privacy_unreachable', label: '负面–隐私设置无法触达'/);
  assert.match(board, /key: 'privacy_unreachable'[^\n]+bg-status-red[^\n]+ring-status-red/);
  assert.match(badges, /privacy_unreachable: 'red'/);
  assert.match(dashboard, /key: 'privacy_unreachable', label: '负面–隐私设置无法触达', color: '#DC2626'/);
  assert.match(legacyCss, /badge\.negative_feishu, \.badge\.negative_cold, \.badge\.privacy_unreachable/);
});

test('migration preserves historical evidence while mapping old current states', () => {
  const migration = source('server/db/migrations/059_content_handling_statuses.sql');
  const privacyMigration = source('server/db/migrations/064_content_privacy_unreachable_status.sql');

  for (const [from, to] of [
    ['official_responded', 'replied'],
    ['ticketed', 'negative_feishu'],
    ['issue_linked', 'negative_feishu'],
    ['reviewing', 'negative_cold'],
    ['no_action', 'reviewed_non_monitor'],
  ]) {
    assert.match(migration, new RegExp(`WHEN '${from}' THEN '${to}'`));
  }
  assert.match(migration, /历史审计与工单记录继续保留/);
  assert.doesNotMatch(migration, /DELETE FROM (?:audit_logs|tickets|ticket_notes)/);
  assert.match(privacyMigration, /内容仍可见，但因用户隐私设置无法直接联系/);
  assert.doesNotMatch(privacyMigration, /UPDATE record_triage|DELETE FROM/);
});

test('status changes are generic and unrestricted by content work orders', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const board = source('web/admin/src/pages/workbench/TriageBoard.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const route = source('server/routes/triage.js');
  const records = source('server/routes/records.js');

  const queueMutation = between(queue, 'const changeTriageMode', 'const changeRecordMode');
  assert.match(queueMutation, /status: newStatus/);
  assert.match(queueMutation, /note: values\.note/);
  assert.match(queueMutation, /feishuTableNo: values\.feishuTableNo/);
  assert.match(queueMutation, /api\.patch\('\/triage\/records\/' \+ recordId, payload\)/);
  assert.doesNotMatch(queueMutation, /dispatchTicket|official-response|ticket_id|ticket_status/);

  const boardMove = between(board, 'const move = useCallback', 'if (loading)');
  assert.match(boardMove, /await onChangeMode\(card, to\)/);
  assert.doesNotMatch(boardMove, /dispatch|official-response|ticket/);

  const recordRoute = route.slice(route.indexOf("router.patch('/records/:recordId'"));
  assert.match(recordRoute, /status = CASE WHEN \$3::text IS NOT NULL THEN excluded\.status/);
  assert.doesNotMatch(recordRoute.slice(0, recordRoute.indexOf("router.post('/records/:recordId/issues'")), /content_ticket_active|status <> 'closed'|activeTicket/);
  assert.doesNotMatch(drawer, /TicketDispatch|确认结案|onLinkIssue/);

  const officialResponseRoute = between(records, "router.patch('/:id/official-response'", '/**\n * 媒体透明代理下载');
  assert.match(officialResponseRoute, /official_response_status/);
  assert.doesNotMatch(officialResponseRoute, /(?:INSERT INTO|UPDATE) record_triage|official_responded/);
});

test('negative Feishu status requires a searchable Feishu table number without restoring ticket workflow', () => {
  const migration = source('server/db/migrations/060_content_feishu_table_no.sql');
  const route = source('server/routes/triage.js');
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const prompt = source('web/admin/src/components/shared/StatusChangePrompt.tsx');
  const badges = source('web/admin/src/components/ui/badge.tsx');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS feishu_table_no/);
  assert.match(migration, /t\.external_ticket_no/);
  assert.doesNotMatch(migration, /DELETE FROM/);

  const keywordFilter = between(route, 'function appendKeywordFilter', 'function validateStatus');
  assert.match(keywordFilter, /rt\.feishu_table_no ILIKE/);
  assert.match(route, /feishu_table_no_required/);
  assert.match(route, /COALESCE\(rt\.feishu_table_no, ''\) AS feishu_table_no/);
  assert.match(route, /header: '飞书表号'/);

  assert.match(queue, /搜索标题、正文、作者、飞书表号/);
  assert.match(queue, /requireFeishuTableNo: newStatus === 'negative_feishu'/);
  assert.match(queue, /batchCount: sel\.count/);
  assert.match(queue, /feishuTableNo: values\.feishuTableNo/);
  const batchRoute = between(route, "router.patch('/records/batch'", '// 归档是独立生命周期');
  assert.match(batchRoute, /feishu_table_no_required/);
  assert.match(batchRoute, /feishu_table_no = CASE WHEN \$7::text IS NOT NULL/);
  assert.match(prompt, /飞书表号 <span/);
  assert.match(prompt, /备注（选填）/);
  assert.match(badges, /negative_feishu: 'red'/);
  assert.match(badges, /negative_cold: 'red'/);
});

test('pending queue and archive lifecycle remain independent from the selected state', () => {
  const route = source('server/routes/triage.js');
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');

  const activeQueue = between(route, 'export const ACTIVE_QUEUE_CONDITION', '// 处理状态和归档生命周期相互独立');
  assert.match(activeQueue, /COALESCE\(rt\.status, 'unhandled'\) = 'unhandled'/);
  assert.match(activeQueue, /rt\.archived_at IS NULL/);

  const archiveRoute = between(route, "router.patch('/records/archive'", "router.patch('/records/:recordId'");
  assert.match(archiveRoute, /archived_at = now\(\)/);
  assert.match(archiveRoute, /archived_at = NULL/);
  assert.doesNotMatch(archiveRoute, /status <> 'closed'|activeTicket|skippedActiveTicketIds/);
  assert.match(queue, /label: '工作中'/);
  assert.match(queue, /label: '已归档'/);
  assert.match(queue, /api\.patch\('\/triage\/records\/archive', \{ ids: \[recordId\], archived \}\)/);
});
