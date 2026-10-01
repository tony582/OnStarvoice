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

test('handling-state pill keeps a compact stable scan width and platform lives in the content meta line', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const feishuControl = source('web/admin/src/components/shared/FeishuTableNumberControl.tsx');
  const copyButton = source('web/admin/src/components/shared/CopyTicketNumberButton.tsx');
  // 平台不再单独占一列：写在作者旁边，表格少一列噪音。
  assert.doesNotMatch(queue, /PLATFORM_BADGE_CLASS/);
  assert.match(functionBlock(queue, 'RecordRow'), /platformName\(r\.platform\)/);
  assert.match(queue, /const TRIAGE_MODE_BADGE_CLASS\s*=\s*['"][^'"]*w-\[112px\][^'"]*justify-center[^'"]*overflow-hidden/);
  assert.match(queue, /dark:text-white/);

  const menu = between(queue, 'function TriageStatusMenu', 'function SortableTh');
  assert.match(menu, /title=\{label\}/);
  assert.match(menu, /flex-1 truncate text-center/);
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

  assert.match(accent, /triage_status === 'negative_feishu' \|\| record\.triage_status === 'negative_cold' \|\| record\.triage_status === 'negative_comment' \|\| record\.triage_status === 'privacy_unreachable'\) return 'bg-status-red'/);
  assert.match(accent, /triage_status === 'replied'/);
  assert.match(accent, /sentiment === 'negative'/);
  assert.match(accent, /sentiment === 'positive'/);
  assert.doesNotMatch(accent, /ticket_status|ticketed/);
  assert.match(functionBlock(queue, 'MobileRecordCard'), /recordAccentClass\(r\)/);
  assert.match(functionBlock(queue, 'RecordRow'), /recordAccentClass\(r\)/);
  assert.match(board, /key: 'negative_feishu'[^\n]+bg-status-red/);
  assert.match(board, /key: 'negative_cold'[^\n]+bg-status-red/);
  assert.match(board, /key: 'negative_comment'[^\n]+bg-status-red/);
  assert.match(board, /key: 'privacy_unreachable'[^\n]+bg-status-red/);
  assert.match(badge, /negative_feishu: 'red'/);
  assert.match(badge, /negative_cold: 'red'/);
  assert.match(badge, /negative_comment: 'red'/);
  assert.match(badge, /privacy_unreachable: 'red'/);
});

test('fixed processing cell combines handling state with a direct note action', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const route = source('server/routes/triage.js');
  const header = between(queue, '<thead data-sticky-header', '</thead>');
  const row = functionBlock(queue, 'RecordRow');
  const progress = functionBlock(queue, 'InlineRecordProgress');

  assert.match(header, /sticky right-0 z-50 w-\[208px\] min-w-\[208px\]/);
  assert.match(header, /grid-cols-\[112px_48px\]/);
  assert.match(header, />处理状态</);
  assert.match(header, /sr-only">备注/);
  assert.match(row, /sticky right-0 z-20 w-\[208px\] min-w-\[208px\]/);
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
  assert.match(queue, /min-w-\[1240px\][^\"]*xl:min-w-full/);
  assert.match(queue, /<thead data-sticky-header className="[^"]*sticky top-0 z-40/);
  assert.match(queue, /sticky right-0 z-20 w-\[208px\] min-w-\[208px\][^\"]*before:inset-y-0/);
});

test('empty list keeps filters and the table header usable', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  assert.match(queue, /const emptyTitle = hasActiveFilters[\s\S]*?'没有搜索结果'/);
  assert.match(queue, /<tbody className="divide-y divide-border\/40">[\s\S]*records\.length === 0[\s\S]*<td colSpan=\{20\}[\s\S]*<EmptyState/);
  assert.doesNotMatch(queue, /records\.length === 0 \? \(\s*<EmptyState[\s\S]{0,300}\) : \(\s*<div className="isolate/);
});

test('one filter bar carries every content dimension once; the table header only labels and sorts', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const primary = between(queue, 'data-triage-toolbar="primary"', 'data-triage-toolbar="secondary"');
  const secondary = between(queue, 'data-triage-toolbar="secondary"', '{/* List */}');
  const header = between(queue, '<thead data-sticky-header', '</thead>');

  const lifecycleViews = between(queue, 'const ARCHIVE_VIEWS', 'const PAGE_SIZE_OPTIONS');
  assert.match(primary, /aria-label="内容生命周期"/);
  assert.match(primary, /ARCHIVE_VIEWS/);
  assert.doesNotMatch(lifecycleViews, /watched|已关注|Star/);
  assert.match(primary, /打开关注清单/);
  assert.match(primary, /aria-pressed=\{viewingWatchlist\}/);
  assert.match(primary, /placeholder="搜索标题、正文、作者…"/);
  assert.match(primary, /title="可搜索标题、正文、作者、飞书表号、账号、平台ID、采集词和标签"/);
  // 刷新是常驻的小图标按钮，取代原来的说明横幅 + 「刷新结果」大按钮；清空筛选固定在筛选行右下角。
  assert.match(primary, /aria-label="刷新列表"/);
  assert.doesNotMatch(primary, /清空筛选/);
  assert.match(secondary, /ml-auto inline-flex[^"]*"\s*>\s*<X className="h-3\.5 w-3\.5" \/>清空筛选/);
  assert.match(secondary, /disabled=\{!hasActiveFilters\}/);
  assert.match(primary, /exportXlsx/);
  assert.doesNotMatch(queue, /保存后可继续编辑|刷新结果将按当前条件重新查询|上次查询：/);

  // 内容维度的筛选全部收在第二行，各出现一次，同一外观、放在列数自适应的等宽网格里；平台与内容主题换成和其它筛选一致的 pill 下拉。
  assert.match(queue, /const FILTER_CELL = 'min-w-0 grow'/);
  assert.match(queue, /const FILTER_TRIGGER = 'w-full justify-between'/);
  assert.match(secondary, /w-full flex-wrap items-center gap-1\.5/);
  // 查询区不再套卡片边框；到表头的间距收紧；情感分段控件固定在第二行最左侧。
  assert.doesNotMatch(queue, /rounded-xl border border-border bg-card shadow-xs/);
  assert.match(queue, /className="sticky left-0 z-30 min-w-0 bg-background pb-2 /);
  assert.doesNotMatch(primary, /aria-label="情感筛选"/);
  assert.ok(secondary.indexOf('aria-label="情感筛选"') < secondary.indexOf('<PostRelevanceFilter'));
  assert.match(secondary, /<MultiSelect[\s\S]*label="处理状态"[\s\S]*value=\{triageStatuses\}[\s\S]*className=\{FILTER_CELL\}/);
  assert.match(secondary, /<CombinedDateRangeFilter value=\{dateRanges\} onChange=\{setDateRanges\} itemClassName=\{FILTER_CELL\} triggerClassName=\{FILTER_TRIGGER\} \/>/);
  // 用得少的平台 / 内容主题 / 疑似身份 / 采集关键词写成一组：桌面放第一行搜索框旁，窄屏收进筛选面板。
  const attributeFilters = between(queue, 'const attributeFilters = (', '// 首次读取');
  assert.match(attributeFilters, /<SingleSelectFilter label="平台" aria-label="平台筛选" value=\{platform\} options=\{PLATFORM_OPTIONS\} onChange=\{setPlatform\}/);
  assert.match(attributeFilters, /<SingleSelectFilter label="内容主题" aria-label="内容主题筛选" value=\{contentTopic\} options=\{CONTENT_TOPIC_FILTER_OPTIONS\} onChange=\{setContentTopic\}/);
  assert.match(attributeFilters, /<MultiSelect label="疑似身份"/);
  assert.match(attributeFilters, /<KeywordFilter/);
  assert.match(primary, /<div className="hidden lg:contents">\s*\{attributeFilters\}/);
  assert.match(secondary, /<div className="contents lg:hidden">\s*\{attributeFilters\}/);
  assert.match(secondary, /<MultiSelect label="风险信号"/);
  assert.match(secondary, /label="自定义标签"/);
  assert.match(secondary, /<CombinedDateRangeFilter/);
  assert.doesNotMatch(secondary, /关注状态筛选|未关注/);
  assert.ok(secondary.includes('<PostIntentFilter value={intents} onChange={setIntents}'));
  assert.ok(secondary.includes('<PostRelevanceFilter value={relevances} confidence={relevanceConfidences} onChange={setRelevances} onConfidenceChange={setRelevanceConfidences}'));
  // 等宽网格会把「全部平台」截成「全部平…」；筛选 pill 按内容宽度自然换行。
  assert.doesNotMatch(secondary, /xl:grid-cols-|<TriageSelect|<select/);
  assert.doesNotMatch(queue, /TicketStatusFilter|工单状态筛选/);

  // 表头不再重复放筛选器：只有列名与排序。
  assert.doesNotMatch(queue, /HeaderSingleFilter|HeaderMultiFilter/);
  assert.doesNotMatch(header, /<PostIntentFilter|<PostRelevanceFilter|<MultiSelect|onChange=\{setPlatform\}|onChange=\{setSentiment\}|onChange=\{setTriageStatuses\}/);
  assert.match(header, />处理状态</);
  assert.match(header, /<SortableTh label="发布时间" field="publish"/);
});

test('selection is lightweight: no page lock, no banner, cleared when the query changes', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const batchBar = source('web/admin/src/components/shared/BatchBar.tsx');
  // 勾选跟着查询走：筛选/翻页/切视图自动清空，不再进入「多选中」锁定态。
  assert.match(queue, /useSelection\(`\$\{filterQuery\}\|\$\{pageSize\}\|\$\{pagination\?\.page \?\? 1\}`\)/);
  assert.doesNotMatch(queue, /selectionActive|selectionSession|<fieldset disabled|多选中，已选|取消多选后按筛选更新/);
  assert.match(queue, /const cancelSelection = \(\) => \{\s+if \(selectionBusy\) return\s+sel\.clear\(\)\s+\}/);
  // shift 连选：从上一次勾选的行到当前行整段跟随。
  assert.match(queue, /sel\.setMany\(records\.slice\(start, end \+ 1\)/);
  assert.match(batchBar, /const setMany = useCallback/);
  assert.match(batchBar, /onChange: \(event: React\.MouseEvent<HTMLButtonElement>\) => void/);
  // 已保存但不再符合筛选的行淡显并提示，刷新后移出；不替用户悄悄重排。
  assert.match(queue, /function recordMatchesFilters\(record: Record<string, unknown>, filters: TriageFilterSnapshot\): boolean/);
  assert.match(queue, /outOfFilterIds\.has\(String\(r\.id\)\)/);
  assert.match(queue, /条已修改、不再符合当前筛选，刷新后移出/);
  assert.match(functionBlock(queue, 'RecordRow'), /outOfFilter && 'opacity-60 hover:opacity-100'/);
});

test('first load shows skeleton rows while refetches keep the old rows dimmed and unclickable', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  assert.match(queue, /const showSkeleton = loading && records\.length === 0/);
  assert.match(queue, /const refreshing = loading && records\.length > 0/);
  assert.match(queue, /refreshing && 'pointer-events-none opacity-60'/);
  assert.match(queue, /<SkeletonRows withCheckbox=\{canWrite\(\)\} \/>/);
  assert.match(queue, /<MobileSkeletonCards \/>/);
  assert.doesNotMatch(queue, /正在加载内容…/);
});

test('content topic shows as a chip only when classified and the filter offers an unclassified bucket', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const topics = source('web/admin/src/lib/content-topic.ts');
  const row = functionBlock(queue, 'RecordRow');
  const mobile = functionBlock(queue, 'MobileRecordCard');
  const chips = functionBlock(queue, 'RecordTopicChips');
  assert.match(chips, /contentTopicLabel\(r\.content_topic, ''\)/);
  assert.match(chips, /r\.category !== 'other'/);
  assert.match(row, /<RecordTopicChips record=\{r\} \/>/);
  assert.match(mobile, /<RecordTopicChips record=\{r\} \/>/);
  assert.doesNotMatch(queue, /主题生成中|内容主题：\{contentTopicLabel/);
  assert.match(topics, /fallback = '未分类'/);
  assert.match(topics, /\{ value: 'unclassified', label: '未分类' \}/);
  assert.match(topics, /\{ value: '', label: '全部内容主题' \}/);
});

test('search commits once, ignores stale responses, and the page is list-only', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const searchInput = between(queue, '<Search className=', '<button\n              type="button"\n              onClick={() => setMobileFiltersOpen');

  assert.match(queue, /const \[keywordDraft, setKeywordDraft\]/);
  assert.match(queue, /window\.setTimeout\(\(\) => setKeyword\(nextKeyword\), 400\)/);
  assert.match(searchInput, /setKeyword\(keywordDraft\.trim\(\)\)/);
  assert.doesNotMatch(searchInput, /\bload\(/);
  assert.match(queue, /const listRequestSeq = useRef\(0\)/);
  assert.match(queue, /requestSeq !== listRequestSeq\.current/);
  assert.match(queue, /if \(requestSeq === listRequestSeq\.current\) setLoading\(false\)/);

  // 看板视图已退役：页面只保留列表，没有视图切换，也不再向看板同步筛选。
  assert.doesNotMatch(queue, /TriageBoard|boardFilterQuery|aria-label="视图模式"|setView\(/);
  assert.match(queue, /setTriageStatuses\(\[\]\)/);
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
