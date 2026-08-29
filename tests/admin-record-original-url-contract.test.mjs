import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('admin workbench resolves Douyin original links separately from search navigation', () => {
  const helper = source('web/admin/src/lib/record-display.ts');
  const triage = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const drawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const data = source('web/admin/src/pages/DataPage.tsx');

  assert.match(helper, /detailCaptureNoteUrl/);
  assert.match(helper, /www\.douyin\.com\/\$\{kind\}\/\$\{contentId\}/);
  assert.match(helper, /详情待补采/);
  assert.match(triage, /resolveRecordOriginalUrl\(r\)/);
  assert.match(triage, /recordDisplayTitle\(r\)/);
  assert.match(drawer, /isRecordDetailDegraded\(r\)/);
  assert.match(drawer, /href=\{originalUrl\}/);
  assert.match(data, /linkCell\(resolveRecordOriginalUrl\(r\), '打开笔记'\)/);
});

test('admin workbench distinguishes titleless Xiaohongshu notes from failed detail placeholders', () => {
  const helper = source('web/admin/src/lib/record-display.ts');
  const data = source('web/admin/src/pages/DataPage.tsx');

  assert.match(helper, /xiaohongshu\.com\/explore\/\$\{matched\[1\]\}/);
  assert.match(helper, /failed && \(placeholder \|\| \(!title && !content\)\)/);
  assert.match(helper, /return String\(record\.title \|\| record\.content \|\| fallback\)/);
  assert.match(data, /col\('title', '标题', \(r, ctx\) => longCell\(recordDisplayTitle\(r\), 180, ctx\)\)/);
});
