import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../web/admin/src/pages/workbench/TriageQueue.tsx', import.meta.url),
  'utf8',
);
const routeSource = readFileSync(
  new URL('../server/routes/triage.js', import.meta.url),
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

test('content triage limits the page before expensive ticket and progress joins', () => {
  const routeStart = routeSource.indexOf("router.get('/records'");
  const routeEnd = routeSource.indexOf("router.patch('/records/watch'", routeStart);
  const route = routeSource.slice(routeStart, routeEnd);
  const pageCte = route.indexOf('WITH page_records AS MATERIALIZED');
  const pageLimit = route.indexOf('LIMIT $${params.length - 1} OFFSET $${params.length}', pageCte);
  const outerPage = route.indexOf('FROM page_records page', pageLimit);
  const ticketJoin = route.indexOf('${LATEST_CONTENT_TICKET_JOIN}', outerPage);
  const progressJoin = route.indexOf('${LATEST_CONTENT_PROGRESS_JOIN}', outerPage);

  const statementEnd = route.indexOf('`, params, readOptions);', progressJoin);

  assert.ok(pageCte >= 0);
  assert.ok(pageLimit > pageCte);
  assert.ok(outerPage > pageLimit);
  assert.ok(ticketJoin > outerPage);
  assert.ok(progressJoin > ticketJoin);
  assert.ok(statementEnd > progressJoin);
  assert.doesNotMatch(route.slice(outerPage, statementEnd), /\$\{where\}/);
});

test('content triage counts and pages the filtered posts in one statement', () => {
  const routeStart = routeSource.indexOf("router.get('/records'");
  const routeEnd = routeSource.indexOf("router.patch('/records/watch'", routeStart);
  const route = routeSource.slice(routeStart, routeEnd);
  const pageCte = route.indexOf('WITH page_records AS MATERIALIZED');
  const statementEnd = route.indexOf('`, params, readOptions);', pageCte);
  const pageStatement = route.slice(pageCte, statementEnd);

  // The admission predicates cost about a second per evaluation over a
  // tenant's posts: the page statement is the only one that may run them.
  assert.equal(route.slice(0, pageCte).includes('${where}'), false, 'nothing evaluates the filter before the page statement');
  assert.match(pageStatement, /SELECT r\.id, COUNT\(\*\) OVER \(\) AS matched_total\s+FROM records r\s+LEFT JOIN record_triage rt[^\n]+\s+\$\{where\}\s+ORDER BY/u);
  assert.equal([...pageStatement.matchAll(/\$\{where\}/gu)].length, 1);
  assert.match(pageStatement, /SELECT\s+page\.matched_total,/u);

  const afterPage = route.slice(statementEnd);
  assert.match(afterPage, /if \(records\.length > 0\) \{\s+total = Number\(records\[0\]\.matched_total\) \|\| 0;\s+\} else if \(offset > 0\) \{/u);
  assert.equal([...afterPage.matchAll(/\$\{where\}/gu)].length, 1, 'only an empty page beyond the first counts separately');
  assert.match(afterPage, /`, countParams, readOptions\)/u);
  assert.match(route, /const countParams = \[\.\.\.params\];\s+const limit = /u, 'the count never receives LIMIT and OFFSET values');
  assert.match(afterPage, /records\.map\(\(\{ matched_total: _matchedTotal, \.\.\.record \}\) =>/u, 'the helper column stays out of the response');
});
