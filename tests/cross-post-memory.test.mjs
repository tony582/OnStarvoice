import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// Production scans can load about 12k window candidates while only a few authors actually match.
// An isolated 192 MiB V8 heap makes eager per-post 500-bigram Maps fail this regression; no production data is used.
test('12k candidate scan fits a bounded heap while preserving all eligible cross-platform matches', () => {
  const moduleUrl = new URL('../server/services/cross-posts/matching.js', import.meta.url).href;
  const source = `
    import {groupCrossPosts} from ${JSON.stringify(moduleUrl)};
    const count = 12000, paired = 200;
    const records = Array.from({length: count}, (_, i) => {
      const seed = i < paired ? Math.floor(i / 2) : i;
      return {id: String(i).padStart(5, '0'), tenant_id: 'synthetic',
        platform: ['douyin','xiaohongshu','wechat_channels'][i % 3], record_type: 'keyword_notes',
        author_name: String.fromCodePoint(0x3400 + Math.floor(seed / 255), 0x3500 + seed % 255), title: '',
        content: Array.from({length: 500}, (_, j) => String.fromCodePoint(0x4e00 + (seed * 503 + j) % 18000)).join(''),
        published_ts: '2026-11-11T07:00:00Z', created_at: '2026-11-11T07:00:00Z'};
    });
    const before = process.memoryUsage().heapUsed;
    const groups = groupCrossPosts(records);
    console.log(JSON.stringify({groups: groups.map(group => ({id: group.groupId, records: group.records.map(row => row.id),
      scores: group.matches.map(edge => edge.score)})), additionalHeapBytes: process.memoryUsage().heapUsed - before}));
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=192', '--input-type=module', '--eval', source], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const measured = JSON.parse(result.stdout);
  assert.deepEqual(measured.groups, Array.from({length: 100}, (_, i) => ({id: String(i * 2).padStart(5, '0'),
    records: [String(i * 2).padStart(5, '0'), String(i * 2 + 1).padStart(5, '0')], scores: [1]})));
  assert.ok(measured.additionalHeapBytes < 128 * 1024 ** 2, 'comparison workspace must stay below 128 MiB for mostly unrelated authors');
});
