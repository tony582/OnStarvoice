import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { recordRelevanceJudgment, recordRelevanceExportFields } from '../server/services/record-relevance-filter.js';

const ts = createRequire(new URL('../web/admin/package.json', import.meta.url))('typescript');
const compiled = ts.transpileModule(readFileSync(new URL('../web/admin/src/lib/post-judgment.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { postJudgment } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function compare(record) {
  const ui = postJudgment(record);
  const api = recordRelevanceJudgment(record);
  const exported = recordRelevanceExportFields(record);
  const context = JSON.stringify(record);
  assert.equal(ui.relevanceFilter, api.relevance, context);
  assert.equal(ui.confidence, api.percent, context);
  assert.equal(ui.confidenceBand, api.confidenceBand, context);
  assert.equal(ui.manual, api.source === 'manual', context);
  assert.equal(ui.relevanceLabel, exported.relevance, context);
  assert.equal(exported.relevance_confidence, ui.confidence === null ? '' : `${ui.confidence}%`, context);
}

test('page and export share confidence classification across rounded boundaries and malformed historical scores', () => {
  const scores = [undefined, null, '', ' ', false, true, [], {}, 'NaN', 'Infinity', NaN, Infinity,
    -1, -.001, -0, 0, .145, .285, .565, .575, .5949999999999999, .595, .6,
    .7949999999999998, .7949999999999999, .795, .8, 1, 1.01,
    '7.95e-1', '\ufeff .92\u00a0', '0x1', '0X0001', '0b0', '0o1', '0x2', '+0x1',
    '1e-999999', '-1e-999999', '1e999999', '1.00000000000000001', '1.0000000000000002',
    `0.${'0'.repeat(1500)}1`, `0.7${'9'.repeat(1500)}`];
  for (let index = 0; index <= 1000; index++) scores.push(index / 1000);
  for (const relevance of ['relevant', 'uncertain', 'irrelevant', undefined, 'bogus']) {
    for (const relevanceConfidence of scores) compare({ ai_result: { relevance, relevanceConfidence } });
  }
});

test('actual manual values override AI scores while nested JSON text remains a string', () => {
  const manualValues = ['relevant', 'uncertain', 'irrelevant',
    { value: 'relevant', reason: '人工核对' }, { value: 'uncertain' }, { value: 'irrelevant' },
    undefined, null, '', 'bogus', false, [], ['relevant'], { value: 'bogus' },
    '{"value":"relevant"}', '{"value":"irrelevant","reason":"应按字符串处理"}', '"relevant"'];
  for (const relevance of ['relevant', 'uncertain', 'irrelevant', undefined]) {
    for (const manual of manualValues) {
      const record = { ai_result: { relevance, relevanceConfidence: .99 }, manual_overrides: { relevance: manual } };
      compare(record);
      // The whole fields can be serialized by historical API clients. This is
      // distinct from interpreting a nested manual string as a new JSON value.
      compare({ ai_result: JSON.stringify(record.ai_result), manual_overrides: JSON.stringify(record.manual_overrides) });
    }
  }
});
