import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../web/admin/src/pages/workbench/TriageQueue.tsx', import.meta.url),
  'utf8',
);

test('content triage pagination supports page size, page numbers, and direct jump', () => {
  assert.match(source, /const PAGE_SIZE_OPTIONS = \[20, 30, 50, 100\]/);
  assert.match(source, /params\.set\('pageSize', String\(pageSize\)\)/);
  assert.match(source, /Math\.ceil\(total \/ pageSize\)/);
  assert.match(source, /function getPaginationItems/);
  assert.match(source, /aria-label="内容列表分页"/);
  assert.match(source, /aria-label="每页条数"/);
  assert.match(source, /aria-label="跳转页码"/);
  assert.match(source, />跳至</);
  assert.match(source, />\s*跳转\s*</);
  assert.match(source, /第 \{formatNumber\(pageStart\)\}–\{formatNumber\(pageEnd\)\} 条，共/);
  assert.doesNotMatch(source, /params\.set\('pageSize', '30'\)/);
  assert.doesNotMatch(source, /Math\.ceil\(total \/ 30\)/);
});
