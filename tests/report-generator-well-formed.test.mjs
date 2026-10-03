import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildInsightSamplePool } from '../server/services/report-generator.js';
import { isWellFormed } from '../server/utils/well-formed-text.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('insight samples cut titles at 80 and summaries at 160 on whole characters', () => {
  // The pool feeds the report insight prompt and the opinion analysis payload (jsonb).
  const title = `${'题'.repeat(79)}🤯尾`;
  const summary = `${'摘'.repeat(159)}🤯尾`;
  const { samples, sampleMap } = buildInsightSamplePool({
    topNegative: [{ id: 'r1', title, ai_summary: summary, sentiment: 'negative' }],
  });
  assert.equal(samples[0].title, '题'.repeat(79));
  assert.equal(samples[0].summary, '摘'.repeat(159));
  assert.equal(sampleMap.r1.title, '题'.repeat(79));
  for (const text of [samples[0].title, samples[0].summary, sampleMap.r1.title]) assert.equal(isWellFormed(text), true);

  // Text without a split pair is cut exactly as before.
  const plain = buildInsightSamplePool({ topNegative: [{ id: 'r2', title: '题'.repeat(100), content: '文 '.repeat(100) }] });
  assert.equal(plain.samples[0].title, '题'.repeat(80));
  assert.equal(plain.samples[0].summary, '文 '.repeat(100).replace(/\s+/g, ' ').slice(0, 160));
});

test('every jsonb parameter of the report generator goes through the well-formed serializer', async () => {
  const source = await readFile(resolve(repoRoot, 'server/services/report-generator.js'), 'utf8');
  // report_runs.metadata, report_snapshots.data and the resend audit log.
  assert.equal(source.match(/\$\d+::jsonb/gu)?.length, 3);
  assert.equal(source.match(/stringifyJsonWellFormed\(/gu)?.length, 3);
  for (const name of ['async function upsertReportRun', 'export async function resendReport']) {
    const start = source.indexOf(name);
    assert.ok(start > 0, name);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    assert.doesNotMatch(body, /JSON\.stringify\(/u, name);
  }
  // compactText is the cut that reached production (2026-09-12/13).
  assert.match(source, /function compactText[\s\S]{0,200}truncateWellFormed\(text, max - 1\)/u);
});
