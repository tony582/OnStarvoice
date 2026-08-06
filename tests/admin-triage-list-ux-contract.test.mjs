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

function itemAround(text, marker) {
  const markerAt = text.indexOf(marker);
  assert.notEqual(markerAt, -1, `missing item marker: ${marker}`);
  const startAt = text.lastIndexOf('<DropdownMenu.Item', markerAt);
  const endAt = text.indexOf('</DropdownMenu.Item>', markerAt);
  assert.ok(startAt >= 0 && endAt > markerAt, `cannot isolate item around: ${marker}`);
  return text.slice(startAt, endAt + '</DropdownMenu.Item>'.length);
}

function functionBlock(text, name) {
  const start = text.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const next = text.indexOf('\nfunction ', start + `function ${name}`.length);
  return text.slice(start, next === -1 ? text.length : next);
}

test('work-order transfer is a command, not a solid-blue selected row', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const menu = between(queue, 'function TriageStatusMenu', 'function SortableTh');
  const transfer = itemAround(menu, 'TICKET_TRIAGE_MODE.value');

  assert.match(transfer, /data-\[highlighted\]:bg-/);
  assert.doesNotMatch(transfer, /(?:^|\s)bg-(?:blue-(?:500|600|700|800)|status-blue)(?:\s|\")/);
  assert.doesNotMatch(transfer, /(?:^|\s)text-white(?:\s|\")/);
});

test('platform and handling-mode pills use shared fixed-width contracts', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');

  assert.match(queue, /const PLATFORM_BADGE_CLASS\s*=\s*['\"][^'\"]*(?<!max-)\b(?:w-|min-w-)[^'\"]*\bjustify-center\b[^'\"]*['\"]/);
  assert.match(queue, /const TRIAGE_MODE_BADGE_CLASS\s*=\s*['\"][^'\"]*(?<!max-)\b(?:w-|min-w-)[^'\"]*\bjustify-center\b[^'\"]*['\"]/);
  assert.match(queue, /const PLATFORM_BADGE_CLASS\s*=\s*['\"][^'\"]*dark:text-white/);
  assert.match(queue, /const TRIAGE_MODE_BADGE_CLASS\s*=\s*['\"][^'\"]*dark:text-white/);
  assert.match(queue, /className=\{PLATFORM_BADGE_CLASS\}[\s\S]{0,120}\{platformName\(r\.platform\)\}/);

  const menu = between(queue, 'function TriageStatusMenu', 'function SortableTh');
  assert.match(menu, /<StatusBadge[^>]*className=\{cn\(TRIAGE_MODE_BADGE_CLASS,/);
  assert.match(queue, /<StatusBadge tone=\{triageStatus\} className=\{TRIAGE_MODE_BADGE_CLASS\}/);
});

test('risk warning drops its decorative bell while preserving the warning count', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const riskSignals = between(queue, 'function RiskSignals', 'function tagsFromMutationResponse');

  assert.match(riskSignals, /预警\{alerts\}/);
  assert.match(riskSignals, /已删帖/);
  assert.doesNotMatch(riskSignals, /<Bell\b/);
});

test('row accent prioritizes a work order, then negative, positive, and neutral sentiment', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const accent = between(queue, 'function recordAccentClass', 'function MobileRecordCard');

  const ticketAt = Math.max(accent.indexOf("triage_status === 'ticketed'"), accent.indexOf('ticket_id'));
  const negativeAt = accent.indexOf("sentiment === 'negative'");
  const positiveAt = accent.indexOf("sentiment === 'positive'");
  const neutralAt = Math.max(accent.lastIndexOf('bg-status-grey'), accent.lastIndexOf('bg-slate-'));
  assert.ok(ticketAt >= 0, 'ticketed content must have an explicit accent branch');
  assert.ok(ticketAt < negativeAt && negativeAt < positiveAt && positiveAt < neutralAt,
    'accent priority must be ticketed blue, negative red, positive green, then neutral grey');
  assert.match(accent, /bg-status-blue/);
  assert.match(accent, /bg-status-red/);
  assert.match(accent, /bg-status-green/);

  const mobile = between(queue, 'function MobileRecordCard', 'function MobileMetric');
  const desktop = between(queue, 'function RecordRow', 'function TicketMarker');
  assert.match(mobile, /recordAccentClass\(r\)/);
  assert.match(desktop, /recordAccentClass\(r\)/);
});

test('missing and existing work-order numbers edit inline and save on blur', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const marker = between(queue, 'function TicketMarker', 'function InlineTicketNumberEditor');
  const missingAt = marker.indexOf('if (!number && editable)');
  const labelAt = marker.indexOf('const label', missingAt + 1);
  assert.ok(missingAt >= 0 && labelAt > missingAt, 'editable work-order number branches must remain explicit');
  const missing = marker.slice(missingAt, labelAt);

  assert.match(missing, /aria-label="补录工单号"/);
  assert.match(missing, /event\.stopPropagation\(\); setEditing\(true\)/);
  assert.match(missing, /font-medium text-primary/);
  assert.doesNotMatch(missing, /<StatusBadge\b/);
  assert.doesNotMatch(missing, /工单号待补录/);
  assert.match(marker, /const closedNumberBackfill = closed && !number/);
  assert.match(marker, /\(!record\.archived_at && !closed\) \|\| closedNumberBackfill/);
  assert.match(marker, /font-medium text-primary">工单号/);

  const editor = between(queue, 'function InlineTicketNumberEditor', 'function TriageStatusMenu');
  assert.match(editor, /autoFocus/);
  assert.match(editor, /onBlur=\{\(\) =>[\s\S]{0,140}void save\(\)/);
  assert.match(editor, /event\.key === 'Escape'/);
  assert.doesNotMatch(editor, /<Button\b|<button\b/);
  assert.match(marker, /<CopyTicketNumberButton value=\{number\}/);
});

test('the fixed processing cell combines handling mode with progress preview and history', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const route = source('server/routes/triage.js');
  const header = between(queue, '<thead data-sticky-header', '</thead>');
  const row = functionBlock(queue, 'RecordRow');
  const progress = functionBlock(queue, 'InlineRecordProgress');

  assert.doesNotMatch(header, />\s*进展\s*</);
  assert.match(header, /sticky right-0 z-50 w-\[180px\] min-w-\[180px\][^"]*pl-6[\s\S]*label="处理模式"[\s\S]*sr-only">处理记录/);
  assert.doesNotMatch(queue, /(?:w|min-w)-\[224px\]/);

  const fixedCellAt = row.indexOf('sticky right-0 z-20 w-[180px] min-w-[180px]');
  const modeAt = row.indexOf('<TriageStatusMenu', fixedCellAt);
  const progressAt = row.indexOf('<InlineRecordProgress', fixedCellAt);
  assert.ok(fixedCellAt >= 0 && modeAt > fixedCellAt && progressAt > modeAt,
    'the fixed right cell must show handling mode first and progress second');
  assert.match(row, /<InlineRecordProgress\b/);
  assert.match(row, /<InlineRecordProgress\s+record=\{r\}\s+onOpen=\{onOpenProgress\}/);
  assert.match(queue, /onOpenProgress=\{\(\) => openDrawer\(r, 'history'\)\}/);

  assert.match(progress, /record\.progress_latest_body/);
  assert.match(progress, /record\.progress_count/);
  assert.match(progress, /border border-primary\/20 bg-primary\/\[0\.06\] text-primary/);
  assert.match(progress, /<MessageSquareText\b/);
  assert.match(progress, /<MessageSquarePlus\b/);
  assert.match(progress, /(?:right-full|right-\[calc\(100%[^\]]*\)\])/);
  assert.match(progress, /opacity-0/);
  assert.match(progress, /translate-x-/);
  assert.match(progress, /group-hover(?:\/[\w-]+)?:opacity-100/);
  assert.match(progress, /group-hover(?:\/[\w-]+)?:translate-x-0/);
  assert.match(progress, /event\.stopPropagation\(\)/);
  assert.match(progress, /onOpen\(\)/);

  for (const field of [
    'progress_count',
    'progress_latest_body',
    'progress_latest_author',
    'progress_latest_at',
    'progress_latest_type',
  ]) {
    assert.match(route, new RegExp(`\\b${field}\\b`));
  }

  const progressSql = between(route, 'const LATEST_CONTENT_PROGRESS_JOIN', 'function appendTicketFilter');
  assert.match(progressSql, /FROM record_notes\s+rn/);
  assert.match(progressSql, /FROM ticket_notes\s+tn/);
  assert.match(progressSql, /UNION ALL/);

  assert.doesNotMatch(queue, /InlineTicketProgress|addInlineTicketNote|TicketNoteMutationResponse/);
  assert.doesNotMatch(queue, /<textarea\b/);
  assert.doesNotMatch(queue, /更多操作|trigger="icon"/);
});

test('desktop uses one native scroll surface while the toolbar stays horizontally fixed', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const desktopApp = source('web/admin/src/desktop/DesktopApp.tsx');
  assert.match(queue, /data-triage-table-scroll[\s\S]{0,80}className="relative hidden lg:block"/);
  assert.match(desktopApp, /app-main[^\"]*\[container-type:inline-size\]/);
  assert.match(queue, /view === 'list' && 'lg:w-max lg:min-w-full'/);
  assert.match(queue, /className="sticky left-0 z-30 !mb-0 space-y-2 border-b border-border\/60 bg-background pb-3[^\"]*lg:-mx-6[^\"]*lg:w-\[calc\(100cqw-6px\)\]/);
  assert.match(queue, /className="isolate overflow-visible rounded-xl bg-card lg:-mx-6 lg:rounded-none"/);
  assert.doesNotMatch(queue, /data-triage-table-scroll[\s\S]{0,180}overflow-x-auto|tableHead\.style\.transform|ResizeObserver/);
  assert.match(queue, /min-w-\[1080px\][^\"]*xl:min-w-full/);
  assert.match(queue, /<thead data-sticky-header className="[^"]*sticky top-0 z-40[^"]*\[&_th\]:!h-12[^"]*\[&_th\]:!py-0/);
  assert.match(queue, /<tr className="h-12 border-b border-border\/60/);
  assert.match(queue, /<th className="sticky right-0 z-50 w-\[180px\][^"]*before:inset-y-0[^"]*before:bg-border/);
  assert.match(queue, /sticky right-0 z-20 w-\[180px\] min-w-\[180px\][^"]*before:inset-y-0[^"]*before:bg-border/);
});

test('empty list keeps the filterable table header visible', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  assert.match(queue, /const emptyTitle = hasActiveFilters[\s\S]*?'没有搜索结果'/);
  assert.doesNotMatch(queue, /records\.length === 0 \? \(\s*<EmptyState[\s\S]{0,300}\) : \(\s*<div className="isolate/);
  assert.match(queue, /<tbody className="divide-y divide-border\/40">[\s\S]*?records\.length === 0 \? \([\s\S]*?<td colSpan=\{20\}[\s\S]*?<EmptyState/);
});

test('desktop triage toolbar balances primary commands and secondary filters across two rows', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const primary = between(queue, 'data-triage-toolbar="primary"', 'data-triage-toolbar="secondary"');
  const secondary = between(queue, 'data-triage-toolbar="secondary"', '{/* Board view */}');

  assert.match(primary, /aria-label="内容归档范围"/);
  assert.match(primary, /搜索标题、正文、作者、工单号/);
  assert.match(primary, /lg:max-w-\[680px\] lg:flex-1/);
  assert.match(primary, /<MultiSelect label="疑似身份"/);
  assert.match(primary, /<KeywordFilter/);
  assert.match(primary, /label="自定义标签"/);
  assert.match(primary, /aria-label="视图模式"/);
  assert.match(primary, /\[\['list', '列表', Rows3\], \['board', '看板', Kanban\]\]/);
  assert.match(primary, /aria-pressed=\{view === value\}/);
  assert.match(primary, /rounded-lg border border-border\/80 bg-muted\/55 p-0\.5/);
  assert.doesNotMatch(primary, /bg-foreground text-background/);
  assert.match(primary, /bg-card text-foreground shadow-sm ring-1 ring-border\/80/);
  assert.match(queue, /function TriageSelect/);
  assert.match(queue, /appearance-none !pr-8/);
  assert.match(primary, /exportXlsx/);

  assert.match(secondary, /aria-label="情感筛选"/);
  assert.match(secondary, /aria-label="只看已转工单"/);
  assert.match(secondary, /aria-pressed=\{ticketOnly\}/);
  assert.match(secondary, /<Check className="h-3\.5 w-3\.5"/);
  assert.doesNotMatch(secondary, /今日采集/);
  assert.match(secondary, /<CombinedDateRangeFilter/);
  assert.match(secondary, /<MultiSelect label="风险信号"/);
  assert.match(secondary, /aria-label="平台筛选"/);
  assert.match(secondary, /aria-label="处理模式筛选"/);
  assert.match(secondary, /xl:grid-cols-\[232px_repeat\(7,minmax\(0,1fr\)\)_58px\]/);
  assert.match(secondary, /aria-label="情感筛选"[^>]*xl:w-full/);
  assert.match(secondary, /lg:w-\[94px\] xl:w-full/);
  assert.match(secondary, /lg:!w-\[82px\][^"']*xl:!w-full/);
  assert.match(secondary, /triggerClassName="xl:w-full xl:justify-between"/);
  assert.doesNotMatch(secondary, /lg:ml-auto lg:block/);
  assert.match(secondary, /disabled=\{!hasActiveFilters\}/);
  assert.match(secondary, /clearFilters/);
  assert.match(secondary, /w-\[58px\]/);
  assert.doesNotMatch(secondary, /exportXlsx/);
  assert.match(
    secondary,
    /aria-label="处理模式筛选"[\s\S]*aria-label="只看已转工单"[\s\S]*aria-label="平台筛选"[\s\S]*<CombinedDateRangeFilter[\s\S]*<MultiSelect label="风险信号"[\s\S]*onClick=\{clearFilters\}/,
  );
});

test('clear control resets custom table sorting as well as filters', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  assert.match(queue, /const hasCustomSort = sort\.field !== 'publish' \|\| sort\.dir !== 'desc'/);
  assert.match(queue, /activeDateFilterCount \|\| hasCustomSort/);
  assert.match(queue, /setSort\(\{ field: 'publish', dir: 'desc' \}\)/);
});

test('list header filters share the same platform, sentiment, and handling-mode state', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const header = between(queue, '<thead data-sticky-header', '</thead>');

  assert.match(queue, /function HeaderSingleFilter/);
  assert.match(header, /label="平台"[\s\S]*value=\{platform\}[\s\S]*onChange=\{setPlatform\}/);
  assert.match(header, /label="情感"[\s\S]*value=\{sentiment\}[\s\S]*onChange=\{setSentiment\}/);
  assert.match(header, /label="处理模式"[\s\S]*value=\{handlingStatus\}[\s\S]*onChange=\{setTriageStatus\}/);
});

test('filter popovers stay above the sticky list header', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const multi = source('web/admin/src/components/shared/MultiSelect.tsx');
  const keywords = source('web/admin/src/components/shared/KeywordFilter.tsx');
  const dates = source('web/admin/src/components/shared/DateRangeFilter.tsx');

  assert.match(queue, /<thead data-sticky-header className="[^"]*z-40/);
  for (const popover of [multi, keywords, dates]) {
    assert.match(popover, /responsive-filter-popover[^\n]*z-50/);
    assert.doesNotMatch(popover, /responsive-filter-popover[^\n]*lg:z-30/);
  }
});

test('drawer and shared badges avoid duplicate or decorative status chrome', () => {
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const labels = source('web/admin/src/components/shared/RecordLabels.tsx');
  const badges = source('web/admin/src/components/ui/badge.tsx');
  const header = between(drawer, '{/* Header */}', '{archived && (');
  const history = between(drawer, "{tab === 'history' && (", '{/* Footer actions */}');
  const labelChips = between(labels, 'export function RecordLabelChips', 'export function RecordLabelEditor');

  assert.match(header, />舆情内容详情</);
  assert.match(header, /aria-label="修改工单号"/);
  assert.match(header, /editingTicketNumber/);
  assert.match(header, /font-medium text-primary">工单号/);
  assert.match(drawer, /const canEditTicketNumber = canWrite && hasTicket[\s\S]{0,180}ticketStatus === 'closed' && !ticketNumber\.trim\(\)/);
  assert.match(drawer, /editingTicketNumber && canEditTicketNumber/);
  assert.match(header, /onBlur=\{\(\) =>/);
  assert.match(header, /void saveTicketNumber\(\)/);
  assert.match(header, /<CopyTicketNumberButton value=\{ticketNumber\}/);
  assert.doesNotMatch(header, /StatusBadge tone="ticketed"/);
  assert.doesNotMatch(header, /已转工单/);
  assert.doesNotMatch(history, /ticketStatusLabel|ticket_assignee_name|>处理人</);
  assert.doesNotMatch(history, />处理时间线<|>最新在前</);
  assert.match(history, /<ActivityTimeline items=\{activity\}/);
  assert.doesNotMatch(drawer, /处理人：/);
  assert.doesNotMatch(labelChips, /tone\.dot|rounded-full[^\n]*(?:h-|size-)[12]/);

  const solid = between(badges, 'const SOLID', '// 浅底');
  for (const tone of ['green', 'red', 'darkred', 'orange', 'amber', 'blue', 'purple', 'teal']) {
    assert.match(solid, new RegExp(`${tone}:\\s*['\"][^'\"]*text-white`));
  }
});
