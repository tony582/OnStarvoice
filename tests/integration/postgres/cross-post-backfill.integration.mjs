import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {calculateTenantCrossPosts, excludeCrossPost} from '../../../server/services/cross-posts/store.js';
import {backfillTenantCrossPosts, backfillCrossPosts} from '../../../server/services/cross-posts/backfill.js';

const NOW = Date.parse('2026-11-11T07:00:00.000Z'), DAY = 86400000;
const date = days => new Date(NOW + days * DAY).toISOString();
const content = '我发现贺兰山这个壁纸充电的时候山刚好会显示在屏幕中间效果真的绝了';

test('explicit thirty-day backfill writes only labels, includes history and boundaries, and keeps guarded tenant atomicity', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  await runMigrations();
  const pool = getPool(), tenants = [];
  t.after(async () => {
    try {if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);}
    finally {await closePool();}
  });
  const tenant = async () => {
    const id = (await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`T18 backfill ${randomUUID()}`])).rows[0].id;
    tenants.push(id); return id;
  };
  async function record(tenantId, platform, published, extra = {}) {
    const id = randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,record_type,title,content,author_name,
      published_ts,created_at,updated_at,business_visibility,ai_result)
      VALUES($1::uuid,$2,$3,($1::uuid)::text,$4,$5,$6,$7,$8,$9,$9,'eligible','{"relevance":"relevant"}')`,
    [id, tenantId, platform, extra.type || 'keyword_notes', extra.title ?? content, extra.content || '',
      extra.author || '凯迪电车之家', published === null ? null : date(published), date(extra.created ?? published ?? -20)]);
    return id;
  }
  async function seedLabels(tenantId, ids) {
    const first = (await pool.query('SELECT id FROM records WHERE id=ANY($1::uuid[]) ORDER BY created_at,id LIMIT 1', [ids])).rows[0].id;
    await pool.query(`INSERT INTO record_cross_posts(tenant_id,record_id,group_id,score,evidence)
      SELECT $1,id,$2,0.5,'{"fixture":"preserve if unrelated"}' FROM unnest($3::uuid[]) ids(id)`, [tenantId, first, ids]);
  }
  const labels = async id => (await pool.query('SELECT * FROM record_cross_posts WHERE tenant_id=$1 ORDER BY record_id', [id])).rows;
  const stableLabels = async id => (await labels(id)).map(({matched_at, ...row}) => row);
  const apply = id => backfillTenantCrossPosts(id, {days: 30, now: NOW});

  await t.test('twenty-day-old rows are genuinely backfilled without scheduler cursors or source/triage mutations', async () => {
    const id = await tenant(), a = await record(id, 'douyin', -20), b = await record(id, 'wechat_channels', -20 + 2 / 1440);
    await pool.query("INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,'reviewed')", [id, a]);
    assert.equal((await calculateTenantCrossPosts(id, {now: NOW})).processed, 0);
    assert.deepEqual(await labels(id), []);
    const beforeRecords = (await pool.query('SELECT to_jsonb(r) AS row FROM records r WHERE tenant_id=$1 ORDER BY id', [id])).rows;
    const beforeTriage = (await pool.query('SELECT * FROM record_triage WHERE tenant_id=$1 ORDER BY record_id', [id])).rows;
    const beforeSettings = (await pool.query('SELECT * FROM tenant_settings WHERE tenant_id=$1 ORDER BY key', [id])).rows;
    const result = await apply(id);
    assert.equal(result.sourceRecords, 2); assert.equal(result.groups, 1); assert.equal(result.members, 2);
    assert.deepEqual((await labels(id)).map(r => r.record_id).sort(), [a, b].sort());
    const first = await stableLabels(id);
    await apply(id);
    assert.deepEqual(await stableLabels(id), first);
    assert.deepEqual((await pool.query('SELECT to_jsonb(r) AS row FROM records r WHERE tenant_id=$1 ORDER BY id', [id])).rows, beforeRecords);
    assert.deepEqual((await pool.query('SELECT * FROM record_triage WHERE tenant_id=$1 ORDER BY record_id', [id])).rows, beforeTriage);
    assert.deepEqual((await pool.query('SELECT * FROM tenant_settings WHERE tenant_id=$1 ORDER BY key', [id])).rows, beforeSettings);
  });

  await t.test('inclusive thirty-day and seventy-two-hour boundary matching excludes boundary-only and future groups', async () => {
    const id = await tenant();
    const a = await record(id, 'douyin', -30), b = await record(id, 'wechat_channels', -33);
    const tooOld = await record(id, 'xiaohongshu', -33 - 1 / DAY);
    const future = await record(id, 'xiaohongshu', 1 / DAY);
    await record(id, 'douyin', -32, {author: '边界外另一个人'});
    await record(id, 'wechat_channels', -32, {author: '边界外另一个人'});
    const result = await apply(id);
    assert.equal(result.sourceRecords, 1); assert.equal(result.groups, 1); assert.equal(result.members, 2);
    assert.deepEqual((await labels(id)).map(r => r.record_id).sort(), [a, b].sort());
    assert.ok(!(await labels(id)).some(r => [tooOld, future].includes(r.record_id)));
  });

  await t.test('complete existing groups extend beyond the boundary while unrelated older groups remain byte-for-byte unchanged', async () => {
    const id = await tenant();
    const a = await record(id, 'douyin', -29), b = await record(id, 'xiaohongshu', -31), c = await record(id, 'wechat_channels', -34);
    const d = await record(id, 'douyin', -40, {author: '窗口外独立作者'}), e = await record(id, 'wechat_channels', -40, {author: '窗口外独立作者'});
    await seedLabels(id, [a, b, c]); await seedLabels(id, [d, e]);
    const outside = (await labels(id)).filter(r => [d, e].includes(r.record_id));
    const result = await apply(id);
    assert.equal(result.groups, 1); assert.equal(result.members, 3); assert.equal(result.preservedLabels, 2);
    const inside = (await labels(id)).filter(r => [a, b, c].includes(r.record_id));
    assert.equal(inside.length, 3); assert.equal(new Set(inside.map(r => r.group_id)).size, 1);
    assert.deepEqual((await labels(id)).filter(r => [d, e].includes(r.record_id)), outside);
  });

  await t.test('manual exclusions remain intact and other tenants cannot join or be overwritten', async () => {
    const id = await tenant(), other = await tenant();
    const a = await record(id, 'douyin', -20), b = await record(id, 'xiaohongshu', -20), c = await record(id, 'wechat_channels', -20);
    const foreign = await record(other, 'douyin', -20), foreign2 = await record(other, 'wechat_channels', -20);
    await seedLabels(other, [foreign, foreign2]); const foreignBefore = await labels(other);
    await apply(id); await excludeCrossPost(id, a, b);
    const excluded = (await pool.query('SELECT * FROM record_cross_post_exclusions WHERE tenant_id=$1 ORDER BY record_a,record_b', [id])).rows;
    const result = await backfillCrossPosts({tenantId: id, days: 30, now: NOW});
    assert.equal(result.tenants.length, 1); assert.equal(result.memberCount, 2);
    assert.deepEqual((await labels(id)).map(r => r.record_id).sort(), [a, c].sort());
    assert.deepEqual((await pool.query('SELECT * FROM record_cross_post_exclusions WHERE tenant_id=$1 ORDER BY record_a,record_b', [id])).rows, excluded);
    assert.deepEqual(await labels(other), foreignBefore);
    await pool.query("UPDATE records SET record_type='official_content' WHERE id=$1", [a]);
    await apply(id);
    assert.deepEqual(await labels(id), [], 'changed ineligible historical records cannot keep stale labels');
  });

  await t.test('the explicit apply CLI executes the historical write path for only its named tenant', async () => {
    const id = await tenant();
    const a = await record(id, 'douyin', -20), b = await record(id, 'wechat_channels', -20);
    const script = fileURLToPath(new URL('../../../server/scripts/cross-posts-backfill.js', import.meta.url));
    const run = spawnSync(process.execPath, [script, '--apply', '--days', '30', '--tenant', id,
      '--as-of', date(0)], {env: {...process.env}, encoding: 'utf8', timeout: 15000});
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.mode, 'apply'); assert.equal(report.days, 30);
    assert.equal(report.groupCount, 1); assert.equal(report.memberCount, 2);
    assert.deepEqual(report.tenants.map(row => row.tenantId), [id]);
    assert.deepEqual((await labels(id)).map(row => row.record_id).sort(), [a, b].sort());
  });

  for (const change of ['record', 'exclusion', 'label']) await t.test(`${change} changes during computation reject the whole tenant write`, async () => {
    const id = await tenant(), a = await record(id, 'douyin', -20), b = await record(id, 'wechat_channels', -20);
    await seedLabels(id, [a, b]);
    const blocker = await pool.connect(); let pending, unlocked = false;
    try {
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query("SELECT pg_advisory_lock(hashtextextended('cross-posts:' || $1,0))", [id]);
      pending = apply(id).then(value => ({value}), error => ({error}));
      let waiting = false; const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const rows = await pool.query("SELECT pid FROM pg_stat_activity WHERE wait_event='advisory' AND $1::int=ANY(pg_blocking_pids(pid))", [pid]);
        if (rows.rowCount) {waiting = true; break;} await delay(10);
      }
      assert.equal(waiting, true);
      if (change === 'record') await pool.query('UPDATE records SET author_name=$2 WHERE id=$1', [b, '完全无关的美食作者']);
      if (change === 'exclusion') await pool.query('INSERT INTO record_cross_post_exclusions(tenant_id,record_a,record_b) VALUES($1,$2,$3)', [id, ...[a, b].sort()]);
      if (change === 'label') await pool.query('UPDATE record_cross_posts SET score=0.25 WHERE tenant_id=$1 AND record_id=$2', [id, a]);
      const currentLabels = await labels(id);
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended('cross-posts:' || $1,0))", [id]); unlocked = true;
      assert.equal((await pending).error?.code, 'CROSS_POST_BACKFILL_RETRY');
      assert.deepEqual(await labels(id), currentLabels, 'the rejected backfill cannot delete or partially replace labels');
      await apply(id);
      assert.equal((await labels(id)).length, change === 'label' ? 2 : 0);
    } finally {
      if (!unlocked) await blocker.query("SELECT pg_advisory_unlock(hashtextextended('cross-posts:' || $1,0))", [id]);
      if (pending) await pending; blocker.release();
    }
  });
});
