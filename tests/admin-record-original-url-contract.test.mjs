import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('admin workbench keeps Douyin direct links and delegates Xiaohongshu opening', () => {
  const helper = source('web/admin/src/lib/record-display.ts');
  const triage = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const sourceAction = source('web/admin/src/components/shared/RecordSourceAction.tsx');
  const data = source('web/admin/src/pages/DataPage.tsx');

  assert.match(helper, /detailCaptureNoteUrl/);
  assert.match(helper, /www\.douyin\.com\/\$\{kind\}\/\$\{contentId\}/);
  assert.match(helper, /详情待补采/);
  assert.match(triage, /<RecordSourceAction record=\{r\}/);
  assert.match(triage, /recordDisplayTitle\(r\)/);
  assert.match(drawer, /isRecordDetailDegraded\(r\)/);
  assert.match(drawer, /<RecordSourceAction record=\{r\}/);
  assert.match(sourceAction, /resolveRecordOriginalUrl\(record\)/);
  assert.match(sourceAction, /const recordId = String\(record\.id\)/);
  assert.match(sourceAction, /\/triage\/records\/\$\{recordId\}\/source-open/);
  assert.match(sourceAction, /if \(!isXhs\)/);
  assert.match(sourceAction, /platform === 'xiaohongshu' \|\| hasXhsUrl/);
  assert.match(data, /function recordSourceCell\(record: any\)/);
  assert.match(data, /col\('url', '笔记链接', r => recordSourceCell\(r\)\)/);
});

test('all record-centric admin surfaces avoid stale Xiaohongshu hrefs', () => {
  const paths = [
    'web/admin/src/pages/HitsPage.tsx',
    'web/admin/src/pages/monitoring/HitsTab.tsx',
    'web/admin/src/pages/OpinionPage.tsx',
    'web/admin/src/pages/workbench/MisjudgmentQueue.tsx',
    'web/admin/src/components/shared/EventDrawer.tsx',
    'web/admin/src/pages/monitoring/OfficialCommentPatrolTab.tsx',
    'web/admin/src/pages/OpinionAnalysisPage.tsx',
    'web/admin/src/pages/insights/DashboardTab.tsx',
  ];

  for (const path of paths) {
    const adminSurface = source(path);
    assert.match(adminSurface, /RecordSourceAction/, path);
    assert.doesNotMatch(adminSurface, /href=\{(?:hit|post|record|r|it)\.url\}/, path);
  }
});

test('admin workbench distinguishes titleless Xiaohongshu notes from failed detail placeholders', () => {
  const helper = source('web/admin/src/lib/record-display.ts');
  const data = source('web/admin/src/pages/DataPage.tsx');

  assert.match(helper, /xiaohongshu\.com\/explore\/\$\{matched\[1\]\}/);
  assert.match(helper, /online capture Agent refreshes the link locally/);
  assert.match(helper, /failed && \(placeholder \|\| \(!title && !content\)\)/);
  assert.match(helper, /return String\(record\.title \|\| record\.content \|\| fallback\)/);
  assert.match(data, /col\('title', '标题', \(r, ctx\) => longCell\(recordDisplayTitle\(r\), 180, ctx\)\)/);
});
