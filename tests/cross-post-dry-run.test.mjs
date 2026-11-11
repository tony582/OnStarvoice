import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readCrossPostSnapshot, summarizeCrossPosts} from '../server/scripts/cross-posts-dry-run.js';

const script = fileURLToPath(new URL('../server/scripts/cross-posts-dry-run.js', import.meta.url));
const now = '2026-11-11T08:00:00.000Z', since = '2026-10-12T08:00:00.000Z';
const content = '我发现贺兰山这个壁纸充电的时候山刚好会显示在屏幕中间效果真的绝了';
const post = (id, overrides = {}) => ({id, tenant_id: 'a', platform: 'douyin', record_type: 'single_note', author_name: '凯迪电车之家',
  title: '标题'.repeat(30), content, published_ts: '2026-11-10T08:00:00.000Z', created_at: '2026-11-10T09:00:00.000Z', ...overrides});
const snapshot = records => ({asOf: now, since, tenants: [{id: 'a', name: '甲'}, {id: 'b', name: '乙'}, {id: 'empty', name: '空租户'}], records, exclusions: []});

function readStub({present = false, records = [], exclusions = []} = {}) {
  const calls = [];
  let options, transactions = 0;
  const query = async (sql, params) => {
    calls.push({sql, params});
    assert.match(sql.trim(), /^SELECT\b/iu, 'the reader must issue only SELECT statements');
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|CALL)\b/iu);
    if (sql.includes('to_regclass')) return {present};
    if (sql.includes('FROM tenants')) return snapshot(records).tenants;
    if (sql.includes('FROM records r')) return records;
    if (sql.includes('FROM record_cross_post_exclusions')) {
      assert.ok(present, 'must not query a missing exclusion table');
      return exclusions;
    }
    assert.fail(`unexpected query: ${sql}`);
  };
  return {calls, get options() { return options; }, get transactions() { return transactions; },
    withTransaction: async (fn, opts) => {
      transactions++; options = opts;
      return fn({queryAll: query, queryOne: query, execute() { assert.fail('dry-run attempted a write'); }});
    }};
}

test('snapshot uses one repeatable-read read-only transaction and never invokes migration or writes', async () => {
  const records = [post('a1'), post('a2', {platform: 'wechat_channels'})];
  const stub = readStub({records});
  const result = await readCrossPostSnapshot({now, withTransaction: stub.withTransaction});
  assert.equal(stub.transactions, 1);
  assert.deepEqual(stub.options, {category: 'reporting', readOnly: true, isolationLevel: 'repeatable_read', statementTimeoutMs: 15000, lockTimeoutMs: 500});
  assert.deepEqual(result, snapshot(records));
  const recordQuery = stub.calls.find(call => call.sql.includes('FROM records r'));
  assert.deepEqual(recordQuery.params, [since, now]);
  assert.match(recordQuery.sql, />= \$1::timestamptz - interval '72 hours'/u);
  assert.match(recordQuery.sql, /<= \$2::timestamptz/u);
  assert.equal(stub.calls.length, 3, 'missing exclusion table is probed, not read or created');
  assert.equal(summarizeCrossPosts(result).groupCount, 1);
  const source = await readFile(script, 'utf8');
  assert.doesNotMatch(source, /import\s[^;]*(?:initDb|migrat|app\.js|cron)/iu);
});

test('an existing exclusion table is read and respected in the preview without mutating it', async () => {
  const records = [post('a1'), post('a2', {platform: 'wechat_channels'})];
  const exclusions = [{tenant_id: 'a', record_a: 'a1', record_b: 'a2'}];
  const stub = readStub({present: true, records, exclusions});
  const result = await readCrossPostSnapshot({days: 7, now, withTransaction: stub.withTransaction});
  assert.equal(result.since, '2026-11-04T08:00:00.000Z');
  assert.deepEqual(result.exclusions, exclusions);
  assert.equal(stub.calls.length, 4);
  assert.equal(summarizeCrossPosts(result).groupCount, 0);
});

function fortyGroups() {
  return Array.from({length: 40}, (_, i) => {
    // Two-character unique authors avoid accidentally matching unrelated fixture groups by Dice/containment.
    const author_name = String.fromCodePoint(0x4e00 + i * 2, 0x4e01 + i * 2), tenant_id = i < 20 ? 'a' : 'b';
    return [post(`${i}-first`, {author_name, tenant_id}), post(`${i}-second`, {author_name, tenant_id, platform: 'xiaohongshu'})];
  }).flat();
}

test('preview reports all tenant totals and deterministically samples 30 groups across tenants', () => {
  const records = fortyGroups(), report = summarizeCrossPosts(snapshot(records));
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.groupCount, 40);
  assert.equal(report.memberCount, 80);
  assert.deepEqual(report.tenants, [{tenantId: 'a', name: '甲', groups: 20, records: 40, sourceRecords: 40},
    {tenantId: 'b', name: '乙', groups: 20, records: 40, sourceRecords: 40},
    {tenantId: 'empty', name: '空租户', groups: 0, records: 0, sourceRecords: 0}]);
  assert.equal(report.samples.length, 30);
  assert.equal(report.samples.filter(group => group.tenantId === 'a').length, 15);
  assert.equal(report.samples.filter(group => group.tenantId === 'b').length, 15);
  assert.equal(new Set(report.samples.map(group => `${group.tenantId}:${group.groupId}`)).size, 30);
  for (const group of report.samples) for (const member of group.members) {
    assert.equal(Array.from(member.title).length, 40);
    assert.equal(member.score, 1);
    assert.ok(member.author && member.platform && member.publishedAt);
  }
  assert.deepEqual(summarizeCrossPosts(snapshot([...records].reverse())), report);
});

test('30-day preview includes a partner exactly 72h before its boundary but excludes older-only groups', () => {
  const boundary = Date.parse(since), iso = delta => new Date(boundary + delta).toISOString();
  const records = [post('in', {published_ts: since}),
    post('edge', {platform: 'wechat_channels', published_ts: iso(-72 * 3_600_000)}),
    post('past-in', {author_name: '边界检查', published_ts: since}),
    post('past-out', {author_name: '边界检查', platform: 'wechat_channels', published_ts: iso(-72 * 3_600_000 - 1)}),
    post('old-a', {author_name: '历史检查', published_ts: iso(-1000)}),
    post('old-b', {author_name: '历史检查', platform: 'xiaohongshu', published_ts: iso(-2000)}),
    post('fallback-a', {author_name: '回退检查', published_ts: null, created_at: since}),
    post('fallback-b', {author_name: '回退检查', platform: 'xiaohongshu', published_ts: null, created_at: since})];
  const report = summarizeCrossPosts(snapshot(records));
  assert.equal(report.boundaryHours, 72);
  assert.equal(report.groupCount, 2);
  assert.equal(report.memberCount, 4);
  assert.equal(report.tenants[0].sourceRecords, 4);
  assert.deepEqual(report.samples.flatMap(group => group.members.map(row => row.id)).sort(), ['edge', 'fallback-a', 'fallback-b', 'in']);
  const edge = report.samples.find(group => group.members.some(row => row.id === 'edge'));
  assert.equal(edge.matches[0].evidence.hoursApart, 72);
});

// Fail immediately if a future CLI regression attempts a network connection during these offline tests.
const forbidNetwork = 'data:text/javascript,' + encodeURIComponent("import net from 'node:net'; net.Socket.prototype.connect = function() { throw new Error('network forbidden in offline dry-run test'); }; globalThis.fetch = () => { throw new Error('network forbidden in offline dry-run test'); };");
const run = args => spawnSync(process.execPath, ['--import', forbidNetwork, script, ...args], {encoding: 'utf8', timeout: 5000,
  env: {...process.env, DATABASE_URL: 'postgresql://127.0.0.1:1/offline_cross_post_guard'}});

test('CLI requires --dry-run, rejects --apply and invalid days before any database access', () => {
  for (const [args, error] of [[[], /Explicit --dry-run is required/u],
    [['--apply'], /Unknown option '--apply'/u], [['--dry-run', '--apply'], /Unknown option '--apply'/u],
    [['--dry-run', '--days', '0'], /--days must be 1–90/u], [['--dry-run', '--days', '91'], /--days must be 1–90/u]]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.stderr, /network forbidden|ECONNREFUSED/u);
  }
});

test('CLI input mode succeeds entirely offline and writes the full inspectable 30-group preview', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cross-post-dry-run-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const input = join(dir, 'snapshot.json'), output = join(dir, 'report.json');
  const data = snapshot(fortyGroups());
  await writeFile(input, JSON.stringify(data));
  const result = run(['--dry-run', '--input', input, '--output', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).samples, 30);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), summarizeCrossPosts(data));
  assert.deepEqual(JSON.parse(await readFile(input, 'utf8')), data, 'input snapshot stays untouched');
});
