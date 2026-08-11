import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('dashboard opens on a calendar-month report and puts basic distributions before extensions', () => {
  const dashboard = source('web/admin/src/pages/insights/DashboardTab.tsx');
  const route = source('server/routes/analytics.js');

  assert.match(dashboard, /useState\(currentShanghaiMonth\)/);
  assert.match(dashboard, /aria-label="统计月份" type="month"/);
  assert.match(dashboard, /aria-label="上一个月"/);
  assert.match(dashboard, /aria-label="下一个月"/);
  assert.doesNotMatch(dashboard, /近30天/);
  assert.doesNotMatch(dashboard, /RANGE_OPTIONS/);
  assert.match(route, /String\(query\.range \|\| 'month'\)/);
  assert.match(route, /function parseShanghaiMonth/);
  assert.match(route, /parseShanghaiMonth\(query\.month/);
  assert.match(route, /label: `\$\{year\}年\$\{month\}月（月报）`/);
  assert.match(route, /DASHBOARD_CACHE_TTL_MS = 60_000/);
  assert.match(route, /compactAnalyticsDashboard\(snapshot\)/);
  assert.match(route, /forceRefresh: req\.query\.refresh === '1'/);
  assert.match(dashboard, /data-testid="dashboard-loading-state"/);
  assert.match(dashboard, /正在生成 \{monthLabel\} 月报/);
  assert.match(dashboard, /计算三类分布/);
  assert.match(dashboard, /无需重复刷新/);
  assert.match(dashboard, /发布时间口径/);
  assert.match(dashboard, /无法识别发布时间的内容不纳入月报/);
  assert.doesNotMatch(dashboard, /<div className="flex justify-center py-24">\s*<Loader2/);

  const coreAt = dashboard.indexOf('<CoreMonthlyAnalysis');
  const extensionAt = dashboard.indexOf('延展分析</span>');
  const summaryAt = dashboard.indexOf('<ExecutiveSummary');
  assert.ok(coreAt > -1 && extensionAt > coreAt && summaryAt > extensionAt);
  for (const title of ['平台分布', '情感分布', '处理模式分布']) {
    assert.match(dashboard, new RegExp(`title="${title}"`));
  }
});

test('basic distribution cards cross-filter the in-report analysis and export one auditable monthly workbook', () => {
  const dashboard = source('web/admin/src/pages/insights/DashboardTab.tsx');
  const route = source('server/routes/analytics.js');
  const drilldown = source('server/services/analytics-drilldown.js');
  const workbook = source('server/services/analytics-workbook.js');

  assert.doesNotMatch(dashboard, /navigate\('workbench'/);
  assert.match(dashboard, /new URLSearchParams\(\{ range: 'month', month, dimension, value \}\)/);
  assert.match(dashboard, /\/analytics\/dashboard\/drilldown\?/);
  assert.doesNotMatch(dashboard, /<DashboardDrilldownPanel/);
  assert.match(dashboard, /三类分布始终显示；点击图形或图例，顶部指标和其他图表会一起更新/);
  assert.match(dashboard, /const crossFilteredRows/);
  assert.match(dashboard, /drilldownData\?\.breakdowns\[dimension\]/);
  assert.match(dashboard, /aria-label="当前联动筛选"/);
  assert.match(dashboard, /再次点击当前项可退出联动/);
  assert.match(dashboard, /<PieChart>/);
  assert.match(dashboard, /function CoreStatusCompositionCard/);
  assert.match(dashboard, /仅比较内容条数与占比/);
  assert.match(dashboard, /detail: dimension === 'status'\s*\? undefined/);
  assert.match(dashboard, /顶部指标和另外两个分布已按当前选择联动更新/);
  assert.doesNotMatch(dashboard, /内容证据/);
  assert.match(dashboard, /\/analytics\/dashboard\/export\?/);
  assert.match(dashboard, /导出月报数据/);
  assert.doesNotMatch(dashboard, /aria-label=\{`导出\$\{title\}`\}/);

  assert.match(route, /router\.get\('\/dashboard\/drilldown'/);
  assert.match(route, /buildAnalyticsDrilldown\(/);
  assert.match(route, /router\.get\('\/dashboard\/export'/);
  assert.match(route, /buildAnalyticsWorkbook\(/);
  assert.match(route, /sendWorkbook\(res/);
  assert.match(route, /filename: `\$\{period\.label\}-月报基础分析及数据源\.xlsx`/);

  for (const sheetName of ['月报主体', '内容分诊数据源']) {
    assert.match(workbook, new RegExp(`['\"]${sheetName}['\"]`));
  }
  for (const removedSheet of ['内容数据源', '采集快照源', '评论数据源', '问题数据源', '预警数据源', '官方回复源']) {
    assert.doesNotMatch(workbook, new RegExp(`addWorksheet\\(['\"]${removedSheet}['\"]`));
  }
  assert.match(workbook, /formula: `=COUNTA\(\$\{contentId\}\)`/);
  assert.match(workbook, /`=COUNTIF\(\$\{contentSentiment\},"负面"\)`/);
  assert.match(workbook, /`=SUM\(\$\{contentInteractions\}\)`/);
  assert.match(workbook, /title: '平台分布'/);
  assert.match(workbook, /title: '情感分布'/);
  assert.match(workbook, /title: '处理模式分布'/);
  assert.match(workbook, /workbook\.calcProperties\.fullCalcOnLoad = true/);
  assert.match(workbook, /return `'\$\{SOURCE_SHEET\}'!\$\$\{letter\}\$2:/);
  assert.match(workbook, /PUBLISHED_RECORD_PERIOD_SQL/);
  assert.doesNotMatch(workbook, /period_observation/);
  assert.match(workbook, /发布时间落在本统计周期内的内容/);

  assert.match(drilldown, /WITH base AS/);
  assert.match(drilldown, /selected AS/);
  assert.match(drilldown, /breakdowns:/);
  assert.doesNotMatch(drilldown, /LIMIT 30/);
  assert.doesNotMatch(drilldown, /records:/);
  assert.match(drilldown, /RELEVANT_RECORD_SQL/);
  assert.match(drilldown, /PUBLISHED_RECORD_PERIOD_SQL/);
  assert.doesNotMatch(drilldown, /period_observation/);

  const reportGenerator = source('server/services/report-generator.js');
  assert.match(reportGenerator, /const \[currentStats, previousStats\] = await Promise\.all/);
  assert.match(reportGenerator, /PUBLISHED_RECORD_PERIOD_SQL = 'r\.published_ts >= \$2 AND r\.published_ts < \$3'/);
  assert.match(reportGenerator, /timeBasis: 'published'/);
  assert.match(reportGenerator, /date_trunc\('day', r\.published_ts AT TIME ZONE 'Asia\/Shanghai'\)/);
});

test('dashboard drill-down presets preserve unknown platform while pending sentiment stays backend-only', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const triage = source('server/routes/triage.js');

  assert.match(queue, /function initialDateRanges/);
  assert.match(queue, /initial\?\.recentFrom/);
  assert.match(queue, /initial\?\.recentTo/);
  assert.match(queue, /initial\?\.captureKeywords/);
  assert.doesNotMatch(queue, /待标注/);
  assert.match(queue, /value="unknown">未知平台/);
  assert.match(triage, /sentiment === 'pending'/);
  assert.match(triage, /COALESCE\(r\.sentiment, ''\) = ''/);
  assert.match(triage, /platform === 'unknown'/);
  assert.match(triage, /COALESCE\(NULLIF\(r\.platform, ''\), 'unknown'\) = 'unknown'/);
});
