import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(new URL('../web/admin/package.json', import.meta.url));
const ts = require('typescript');
const compile = file => ts.transpileModule(readFileSync(new URL(`../web/admin/src/lib/${file}`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const helperExports = {};
runInNewContext(compile('navigation-public-params.ts'), { exports: helperExports, URLSearchParams });
const exports = {};
runInNewContext(compile('navigation.tsx'), {
  exports, require: name => name === './navigation-public-params' ? helperExports : require(name), URLSearchParams,
});
const { normalizePublicPageParams } = helperExports;
const { normalizePage } = exports;
const params = query => JSON.parse(JSON.stringify(normalizePublicPageParams(new URLSearchParams(query))));

test('public links preserve repeated and comma-separated judgment selections together', () => {
  assert.deepEqual(params('page=workbench&queue=triage&intent=share&intent=complaint,inquiry&relevance=relevant&relevance=uncertain&relevanceConfidence=high,medium&relevanceConfidence=missing'), {
    queue: 'triage', intent: 'share,complaint,inquiry', relevance: 'relevant,uncertain', relevanceConfidence: 'high,medium,missing',
  });
});

test('explicit four-category intent and unrestricted empty filters remain distinct', () => {
  assert.deepEqual(params('page=workbench&intent=share&intent=other&intent=complaint&intent=inquiry'), {
    intent: 'share,other,complaint,inquiry',
  });
  assert.deepEqual(params('page=workbench'), {});
  assert.deepEqual(params('page=workbench&intent=&relevance=&relevanceConfidence='), {
    intent: '', relevance: '', relevanceConfidence: '',
  });
});

test('unrelated navigation parameters retain last-value semantics and legacy routes', () => {
  const values = params('page=triage&status=reviewed&status=negative_cold&keyword=旧&keyword=新&intent=share&intent=inquiry');
  assert.deepEqual(values, { status: 'negative_cold', keyword: '新', intent: 'share,inquiry' });
  assert.deepEqual(JSON.parse(JSON.stringify(normalizePage('triage', values))), {
    page: 'workbench', params: { queue: 'triage', ...values },
  });
});

test('public parameter limit still counts repeated entries and excludes page keys', () => {
  const query = new URLSearchParams({ page: 'workbench' });
  for (let index = 0; index < 19; index++) query.append(`field${index}`, 'keep');
  query.append('page', 'triage');
  query.append('intent', 'share');
  query.append('intent', 'inquiry');
  query.append('relevanceConfidence', 'high');
  const result = normalizePublicPageParams(query);
  assert.equal(Object.keys(result).length, 20);
  assert.equal(result.intent, 'share');
  assert.equal(result.relevanceConfidence, undefined);
  assert.equal(result.page, undefined);
});

test('individual keys and merged filter values retain their length limits', () => {
  const query = new URLSearchParams();
  query.append('k'.repeat(100), 'v'.repeat(600));
  query.append('intent', 's'.repeat(300));
  query.append('intent', 'i'.repeat(300));
  const result = normalizePublicPageParams(query);
  assert.equal(result['k'.repeat(80)], 'v'.repeat(500));
  assert.equal(result.intent, `${'s'.repeat(300)},${'i'.repeat(199)}`);
  assert.equal(result.intent.length, 500);
});

test('normalizing a public link does not mutate the original search parameters', () => {
  const query = new URLSearchParams('page=workbench&intent=share&intent=inquiry');
  const before = query.toString();
  normalizePublicPageParams(query);
  assert.equal(query.toString(), before);
});
