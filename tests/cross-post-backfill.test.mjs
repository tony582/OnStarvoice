import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseBackfillArgs} from '../server/scripts/cross-posts-backfill.js';
import {backfillWindow} from '../server/services/cross-posts/backfill.js';

test('historical backfill requires an explicit write switch and exactly thirty days', () => {
  for (const args of [[], ['--days', '30'], ['--apply'], ['--apply', '--days', '3'], ['--dry-run']]) {
    assert.throws(() => parseBackfillArgs(args));
  }
  const tenant = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(parseBackfillArgs(['--apply', '--days', '30', '--tenant', tenant, '--as-of', '2026-11-11T07:00:00Z']),
    {options: {days: 30, tenantId: tenant, now: '2026-11-11T07:00:00Z'}, output: undefined});
  assert.throws(() => parseBackfillArgs(['--apply', '--days', '30', '--tenant', 'wrong']));
  assert.throws(() => parseBackfillArgs(['--apply', '--days', '30', '--as-of', 'wrong']));
  assert.deepEqual(backfillWindow({now: '2026-11-11T07:00:00Z'}), {asOf: '2026-11-11T07:00:00.000Z',
    since: '2026-10-12T07:00:00.000Z', boundarySince: '2026-10-09T07:00:00.000Z'});
});

test('backfill CLI refuses missing authorization or database without contacting any network', () => {
  const script = fileURLToPath(new URL('../server/scripts/cross-posts-backfill.js', import.meta.url));
  const guard = 'data:text/javascript,' + encodeURIComponent("import net from 'node:net'; net.Socket.prototype.connect=function(){throw new Error('network forbidden')};");
  const env = {...process.env}; delete env.DATABASE_URL;
  for (const [args, message] of [[[], /Explicit --apply --days 30/u], [['--apply', '--days', '30'], /Explicit DATABASE_URL/u]]) {
    const result = spawnSync(process.execPath, ['--import', guard, script, ...args], {env, encoding: 'utf8'});
    assert.equal(result.status, 1); assert.match(result.stderr, message); assert.doesNotMatch(result.stderr, /network forbidden/u);
  }
});
