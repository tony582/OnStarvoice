import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { knownInteractionSumSql } from '../server/services/interaction-sql.js';
import { buildUserMessage } from '../server/services/ai-labeler.js';

const rawCounter = String.raw`(?:[A-Za-z_]\w*\.)?(?:likes|comments_count|collects|shares)`;
const bareSum = new RegExp(String.raw`\b${rawCounter}\s*(?:\*\s*\d+\s*)?\+\s*${rawCounter}\b`, 'i');
const nullableDescending = /\b(?:likes|comments_count|collects|shares|like_count|interaction_total)\s+DESC\b(?!\s+NULLS\s+LAST)/i;
// Inspect literal SQL text, excluding JavaScript template expressions (ordinary
// in-memory sums are not SQL). Both complete statements and ORDER BY fragments
// are covered, so a fragment cannot evade the guard by omitting FROM records.
function sqlTextLiterals(source) {
  return [...source.matchAll(/(["'`])(?:\\[\s\S]|(?!\1)[\s\S])*?\1/g)]
    .map(match => ({text: match[0].slice(1, -1).replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, ' '), at: match.index}));
}
function violations(source) {
  return sqlTextLiterals(source).filter(({text}) => bareSum.test(text) || nullableDescending.test(text));
}

test('known sum retains all four counters and rejects non-identifier aliases', () => {
  assert.equal(knownInteractionSumSql('r'), 'COALESCE(r.likes, 0) + COALESCE(r.comments_count, 0) + COALESCE(r.collects, 0) + COALESCE(r.shares, 0)');
  assert.equal(knownInteractionSumSql(), 'COALESCE(likes, 0) + COALESCE(comments_count, 0) + COALESCE(collects, 0) + COALESCE(shares, 0)');
  assert.throws(() => knownInteractionSumSql('r; DROP TABLE records'), TypeError);
});

test('guard detects bare SQL sums on records/observations and nullable descending fragments', () => {
  for (const source of [
    "const sql = 'SELECT likes + comments_count FROM records';",
    'const sql = `SELECT SUM(o.likes + o.comments_count + o.collects + o.shares) FROM record_observations o WHERE tenant_id=${id}`;',
    "const order = '(shares + likes) DESC';",
    'const sql = `SELECT * FROM record_comments ORDER BY rc.like_count DESC, id`;',
  ]) assert.equal(violations(source).length, 1, source);
  for (const source of [
    'const result = row.likes + row.comments_count;',
    'const html = `value ${n(r.likes + r.comments_count)}`;',
    "const sql = 'SELECT COALESCE(likes, 0) + COALESCE(comments_count, 0) FROM records';",
    "const sql = 'ORDER BY rc.like_count DESC NULLS LAST';",
  ]) assert.equal(violations(source).length, 0, source);
});

test('server SQL never regresses to bare counter addition or NULL-first counter ordering', async () => {
  const failures = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if (entry.name === 'node_modules') continue;
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.js')) {
        const source = await readFile(file, 'utf8');
        for (const result of violations(source)) failures.push(`${file.pathname}:${source.slice(0, result.at).split('\n').length}: ${result.text.slice(0, 100)}`);
      }
    }
  }
  await walk(new URL('../server/', import.meta.url));
  assert.deepEqual(failures, []);
});

test('AI prompt distinguishes missing counters from known zero without literal null', () => {
  const partial = buildUserMessage({title: '文章', likes: 10000, comments_count: null, collects: null, shares: null});
  assert.match(partial, /10000赞 未知评论 未知收藏 未知转发/);
  assert.doesNotMatch(partial, /null|undefined|0转发/);
  assert.match(buildUserMessage({likes: 0, comments_count: 0, collects: 0, shares: 0}), /0赞 0评论 0收藏 0转发/);
  assert.doesNotMatch(buildUserMessage({title: '未知指标文章', likes: null, comments_count: null, collects: null, shares: null}), /互动：|null|undefined/);
});

// The administrator list chooses its metric column dynamically; the literal
// scanner cannot infer the selected column, so exercise that route contract too.
test('dynamic administrator metric ordering puts unknown values last', async () => {
  const source = await readFile(new URL('../server/routes/admin.js', import.meta.url), 'utf8');
  assert.match(source, /ORDER BY \$\{sortCol\} \$\{sortOrder\} NULLS LAST LIMIT/);
});
