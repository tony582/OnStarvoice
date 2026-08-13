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

function functionBlock(text, name) {
  const start = text.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const next = text.indexOf('\nfunction ', start + `function ${name}`.length);
  return text.slice(start, next === -1 ? text.length : next);
}

test('platform and handling-state pills keep stable scan widths', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const feishuControl = source('web/admin/src/components/shared/FeishuTableNumberControl.tsx');
  const copyButton = source('web/admin/src/components/shared/CopyTicketNumberButton.tsx');
  assert.match(queue, /const PLATFORM_BADGE_CLASS\s*=\s*['"][^'"]*w-14[^'"]*justify-center/);
  assert.match(queue, /const TRIAGE_MODE_BADGE_CLASS\s*=\s*['"][^'"]*w-\[132px\][^'"]*justify-center/);
  assert.match(queue, /dark:text-white/);

  const menu = between(queue, 'function TriageStatusMenu', 'function SortableTh');
  assert.match(menu, /w-\[236px\]/);
  assert.match(menu, />处理状态</);
  assert.match(menu, /CONTENT_TRIAGE_MODES\.map/);
  assert.doesNotMatch(menu, /转工单|TICKET_TRIAGE_MODE/);
  assert.doesNotMatch(menu, /FeishuTableNumberControl|feishuTableNo/);

  const row = functionBlock(queue, 'RecordRow');
  const mobile = functionBlock(queue, 'MobileRecordCard');
  assert.match(row, /triageStatus === 'negative_feishu'[\s\S]*<FeishuTableNumberControl/);
  assert.ok(row.indexOf('<FeishuTableNumberControl') < row.indexOf('sticky right-0 z-20'));
  assert.match(mobile, /r\.triage_status === 'negative_feishu'[\s\S]*<FeishuTableNumberControl/);
  assert.match(feishuControl, /aria-label=\{onSave \? `修改飞书表号：\$\{display\}`/);
  assert.match(feishuControl, /<input[\s\S]*autoFocus[\s\S]*aria-label="飞书表号"/);
  assert.match(feishuControl, /event\.key === 'Escape'/);
  assert.match(feishuControl, /label="飞书表号"/);
  assert.match(copyButton, /`复制\$\{label\} \$\{number\}`/);
});

test('row accent reflects handling state and sentiment without work-order lifecycle branches', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const board = source('web/admin/src/pages/workbench/TriageBoard.tsx');
  const badge = source('web/admin/src/components/ui/badge.tsx');
  const accent = between(queue, 'function recordAccentClass', 'function getPaginationItems');

  assert.match(accent, /triage_status === 'negative_feishu' \|\| record\.triage_status === 'negative_cold'\) return 'bg-status-red'/);
  assert.match(accent, /triage_status === 'replied'/);
  assert.match(accent, /sentiment === 'negative'/);
  assert.match(accent, /sentiment === 'positive'/);
  assert.doesNotMatch(accent, /ticket_status|ticketed/);
  assert.match(functionBlock(queue, 'MobileRecordCard'), /recordAccentClass\(r\)/);
  assert.match(functionBlock(queue, 'RecordRow'), /recordAccentClass\(r\)/);
  assert.match(board, /key: 'negative_feishu'[^\n]+bg-status-red/);
  assert.match(board, /key: 'negative_cold'[^\n]+bg-status-red/);
  assert.match(badge, /negative_feishu: 'red'/);
  assert.match(badge, /negative_cold: 'red'/);
});

test('fixed processing cell combines handling state with a direct note action', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const route = source('server/routes/triage.js');
  const header = between(queue, '<thead data-sticky-header', '</thead>');
  const row = functionBlock(queue, 'RecordRow');
  const progress = functionBlock(queue, 'InlineRecordProgress');

  assert.match(header, /sticky right-0 z-50 w-\[224px\] min-w-\[224px\]/);
  assert.match(header, /grid-cols-\[132px_48px\]/);
  assert.match(header, /label="处理状态"/);
  assert.match(header, /sr-only">备注/);
  assert.match(row, /sticky right-0 z-20 w-\[224px\] min-w-\[224px\]/);
  assert.match(row, /<TriageStatusMenu[\s\S]*<InlineRecordProgress record=\{r\} onAdd=\{onAddNote\}/);

  assert.match(progress, /record\.progress_latest_body/);
  assert.match(progress, /record\.progress_count/);
  assert.match(progress, /最近备注/);
  assert.match(progress, /group-hover\/progress:opacity-100/);
  assert.match(progress, /event\.stopPropagation\(\)/);
  assert.match(progress, /onAdd\(\)/);
  assert.doesNotMatch(progress, /onOpen|history/);

  const latestJoin = between(route, 'const LATEST_CONTENT_PROGRESS_JOIN', 'function appendTicketFilter');
  assert.match(latestJoin, /FROM record_notes rn/);
  assert.match(latestJoin, /FROM audit_logs al/);
  assert.doesNotMatch(latestJoin, /FROM ticket_notes/);
});

test('desktop keeps one native scroll surface and sticky state-note cell', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const desktopApp = source('web/admin/src/desktop/DesktopApp.tsx');

  assert.match(queue, /data-triage-table-scroll[\s\S]{0,80}className="relative hidden lg:block"/);
  assert.match(desktopApp, /app-main[^\"]*\[container-type:inline-size\]/);
  assert.match(queue, /className="sticky left-0 z-30[^\"]*lg:w-\[calc\(100cqw-6px\)\]/);
  assert.match(queue, /className="isolate overflow-visible rounded-xl bg-card lg:-mx-6 lg:rounded-none"/);
  assert.doesNotMatch(queue, /data-triage-table-scroll[\s\S]{0,180}overflow-x-auto|tableHead\.style\.transform|ResizeObserver/);
  assert.match(queue, /min-w-\[1080px\][^\"]*xl:min-w-full/);
  assert.match(queue, /<thead data-sticky-header className="[^"]*sticky top-0 z-40/);
  assert.match(queue, /sticky right-0 z-20 w-\[224px\] min-w-\[224px\][^\"]*before:inset-y-0/);
});

test('empty list keeps filters and the table header usable', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  assert.match(queue, /const emptyTitle = hasActiveFilters[\s\S]*?'没有搜索结果'/);
  assert.match(queue, /<tbody className="divide-y divide-border\/40">[\s\S]*records\.length === 0[\s\S]*<td colSpan=\{20\}[\s\S]*<EmptyState/);
  assert.doesNotMatch(queue, /records\.length === 0 \? \(\s*<EmptyState[\s\S]{0,300}\) : \(\s*<div className="isolate/);
});

test('toolbar and header filter the eight handling states without ticket filters', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const primary = between(queue, 'data-triage-toolbar="primary"', 'data-triage-toolbar="secondary"');
  const secondary = between(queue, 'data-triage-toolbar="secondary"', '{/* Board view */}');
  const header = between(queue, '<thead data-sticky-header', '</thead>');

  assert.match(primary, /aria-label="内容归档范围"/);
  assert.match(primary, /搜索标题、正文、作者、飞书表号…/);
  assert.match(primary, /<MultiSelect label="疑似身份"/);
  assert.match(primary, /<KeywordFilter/);
  assert.match(primary, /label="自定义标签"/);
  assert.match(primary, /aria-label="视图模式"/);
  assert.match(primary, /exportXlsx/);

  assert.match(secondary, /aria-label="情感筛选"/);
  assert.match(secondary, /<MultiSelect[\s\S]*label="全部状态"[\s\S]*value=\{triageStatuses\}/);
  assert.match(secondary, /aria-label="平台筛选"/);
  assert.match(secondary, /<CombinedDateRangeFilter/);
  assert.match(secondary, /<MultiSelect label="风险信号"/);
  assert.match(secondary, /xl:grid-cols-\[232px_repeat\(6,minmax\(0,1fr\)\)_58px\]/);
  assert.doesNotMatch(queue, /TicketStatusFilter|工单状态筛选/);

  assert.match(header, /label="平台"[\s\S]*value=\{platform\}[\s\S]*onChange=\{setPlatform\}/);
  assert.match(header, /label="情感"[\s\S]*value=\{sentiment\}[\s\S]*onChange=\{setSentiment\}/);
  assert.match(header, /label="处理状态"[\s\S]*value=\{triageStatuses\}[\s\S]*onChange=\{setTriageStatuses\}/);
});

test('drawer header keeps the Feishu number in the old inline-edit position while history remains available', () => {
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const header = between(drawer, '{/* Header */}', '{archived && (');
  const history = between(drawer, "{tab === 'history' && (", '{/* Footer actions */}');

  assert.match(header, />舆情内容详情</);
  assert.match(header, />舆情内容详情<[\s\S]*<FeishuTableNumberControl/);
  assert.match(header, /onSave=\{!archived \? onSetFeishuTableNo : undefined\}/);
  assert.doesNotMatch(header, /工单号|editingTicketNumber/);
  assert.match(history, /<ActivityTimeline items=\{activity\}/);
  assert.doesNotMatch(history, />处理时间线<|>最新在前</);
  assert.doesNotMatch(drawer, /确认结案|onTicketClosed|ticketCloseConfirmOpen/);
});
