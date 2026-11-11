import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {calculateTenantCrossPosts, getCrossPosts, excludeCrossPost, CROSS_POST_CURSOR} from '../../../server/services/cross-posts/store.js';

const NOW = Date.parse('2026-11-11T07:00:00.000Z');
const hour = 3600000;
const timestamp = offset => new Date(NOW + offset).toISOString();
const shared = '我发现贺兰山这个壁纸，充电的时候山刚好会显示在屏幕中间！效果真的绝了，今天分享给大家。';

test('cross-platform post labels use real PostgreSQL, tenant isolation, persistent cursors and existing triage HTTP', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  await runMigrations();
  const pool = getPool(), tenants = [], users = [];
  let server;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input);
    assert.equal(url.hostname, '127.0.0.1', 'integration tests may only contact their own local HTTP server');
    return originalFetch(input, options);
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try {
      if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    } finally {await closePool();}
  });
  async function tenant() {
    const id = (await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`T18 ${randomUUID()}`])).rows[0].id;
    tenants.push(id); return id;
  }
  async function record(tenantId, platform, extra = {}) {
    const id = extra.id || randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,record_type,title,content,author_name,
      published_ts,created_at,updated_at,first_seen_at,last_seen_at,business_visibility,ai_result,sentiment,keyword)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$10,'eligible','{"relevance":"relevant"}','negative','安吉星')`,
    [id, tenantId, platform, id, extra.type || 'keyword_notes', extra.title ?? shared, extra.content || '',
      extra.author ?? '凯迪电车之家', extra.published === null ? null : timestamp(extra.published ?? -hour),
      timestamp(extra.created ?? -2 * hour), timestamp(extra.updated ?? -hour)]);
    return id;
  }
  const labels = async tenantId => (await pool.query(`SELECT record_id,group_id,score,evidence
    FROM record_cross_posts WHERE tenant_id=$1 ORDER BY record_id`, [tenantId])).rows;
  const members = async (tenantId, id) => (await getCrossPosts(tenantId, id)).members.map(row => row.id).sort();
  const calculate = (tenantId, extra = {}) => calculateTenantCrossPosts(tenantId, {now: NOW, ...extra});

  await t.test('same-author different content is rejected and matching never crosses tenant boundaries', async () => {
    const a = await tenant(), b = await tenant();
    const first = await record(a, 'douyin', {created: -3 * hour});
    const second = await record(a, 'wechat_channels', {author: '凯迪电车之家🚗', published: -hour + 120000});
    const otherTenant = await record(b, 'xiaohongshu');
    const unrelated1 = await record(a, 'douyin', {author: '00后女大卖车日记📔', title: '好兄弟这台昂科旗今天已经谈好价格准备交车啦'});
    const unrelated2 = await record(a, 'xiaohongshu', {author: '00后女大卖车日记', title: '', content: '00后女车贩子整治市场！各种商家都被我砍得头疼'});
    const emptyAuthor = await record(a, 'xiaohongshu', {author: '🐳。'});
    const unsupported = await record(a, 'wechat_articles');
    const official = await record(a, 'xiaohongshu', {type: 'official_content'});
    const profile = await record(a, 'xiaohongshu', {type: 'blogger_profile'});
    const comment = await record(a, 'xiaohongshu', {type: 'comment'});
    const tooLate = await record(a, 'xiaohongshu', {published: 75 * hour});
    const result = await calculate(a);
    assert.equal(result.groups, 1); assert.equal(result.members, 2);
    assert.deepEqual(await members(a, first), [first, second].sort());
    assert.equal((await getCrossPosts(a, first)).groupId, first, 'the earliest created record anchors the group');
    for (const id of [unrelated1, unrelated2, emptyAuthor, unsupported, official, profile, comment, tooLate]) {
      assert.deepEqual(await members(a, id), [], id);
    }
    await calculate(b);
    assert.deepEqual(await members(b, otherTenant), []);
    await assert.rejects(getCrossPosts(a, otherTenant), {status: 404});
    await assert.rejects(excludeCrossPost(a, first, otherTenant), {status: 409});
    await assert.rejects(pool.query(`INSERT INTO record_cross_posts(tenant_id,record_id,group_id,score)
      VALUES($1,$2,$2,1)`, [a, otherTenant]), {code: '23503'});
  });

  await t.test('repeated scans retain group ids and evidence without merging or changing source records', async () => {
    const id = await tenant();
    const first = await record(id, 'douyin', {published: null, created: -3 * hour});
    await record(id, 'xiaohongshu', {published: null, title: '', content: shared});
    const sourceSql = 'SELECT id,platform,title,content,author_name,created_at,updated_at FROM records WHERE tenant_id=$1 ORDER BY id';
    const source = (await pool.query(sourceSql, [id])).rows;
    await calculate(id); const before = await labels(id);
    assert.equal(before.length, 2);
    for (let i = 0; i < 2; i++) {
      assert.equal((await calculate(id)).done, true);
      assert.deepEqual(await labels(id), before);
      assert.deepEqual((await pool.query(sourceSql, [id])).rows, source);
    }
    assert.equal((await getCrossPosts(id, first)).groupId, first);
    assert.ok(before.every(row => row.evidence.matches.every(match => match.evidence.timeSources.every(value => value === 'created_at'))));
    assert.equal((await pool.query('SELECT count(*) AS n FROM record_triage WHERE tenant_id=$1', [id])).rows[0].n, 0);
  });

  await t.test('excluding one member of a three-platform group prevents indirect reconnection after recalculation', async () => {
    const id = await tenant();
    const a = await record(id, 'douyin', {created: -3 * hour});
    const b = await record(id, 'xiaohongshu');
    const c = await record(id, 'wechat_channels');
    await calculate(id);
    assert.deepEqual(await members(id, a), [a, b, c].sort());
    await excludeCrossPost(id, a, b);
    const excluded = (await pool.query('SELECT record_a,record_b FROM record_cross_post_exclusions WHERE tenant_id=$1', [id])).rows;
    assert.equal(excluded.length, 2, 'the removed member is excluded against both remaining members');
    assert.ok(excluded.every(row => row.record_a < row.record_b));
    for (let i = 0; i < 2; i++) {
      await calculate(id);
      assert.deepEqual(await members(id, a), [a, c].sort());
      assert.deepEqual(await members(id, b), []);
    }
  });

  await t.test('changed content and newly ineligible records split existing groups, including their old members', async () => {
    const id = await tenant();
    const a = await record(id, 'douyin', {created: -4 * hour});
    const b = await record(id, 'xiaohongshu', {created: -3 * hour});
    const c = await record(id, 'wechat_channels');
    await calculate(id);
    await pool.query('UPDATE records SET title=$2,content=$3,updated_at=$4 WHERE id=$1', [b, '这里讨论美食烘焙课程，水果蛋糕配方完全不同', '', timestamp(1000)]);
    await calculate(id, {now: NOW + 2000});
    assert.deepEqual(await members(id, a), [a, c].sort());
    assert.deepEqual(await members(id, b), []);
    await pool.query("UPDATE records SET record_type='official_content',updated_at=$2 WHERE id=$1", [a, timestamp(3000)]);
    await calculate(id, {now: NOW + 4000});
    assert.deepEqual(await labels(id), []);
  });

  await t.test('an update outside the candidate time window still removes the previous distant group member', async () => {
    const id = await tenant();
    const a = await record(id, 'douyin', {published: -20 * 24 * hour, created: -21 * 24 * hour});
    const b = await record(id, 'wechat_channels', {published: -20 * 24 * hour, created: -21 * 24 * hour});
    await calculate(id);
    assert.equal((await labels(id)).length, 2);
    await pool.query('UPDATE records SET published_ts=$2,updated_at=$2 WHERE id=$1', [a, timestamp(1000)]);
    // b is not a current seed or a candidate in a +/-72h window around the moved a.
    await pool.query('UPDATE records SET updated_at=$2 WHERE id=$1', [b, timestamp(-21 * 24 * hour)]);
    await calculate(id, {now: NOW + 2000});
    assert.deepEqual(await labels(id), [], 'expanding affected groups must clear the old distant singleton too');
  });

  await t.test('a real update between snapshot and write rejects stale matching without labels or cursor advancement', async () => {
    const id = await tenant();
    const a = await record(id, 'douyin', {created: -3 * hour});
    const b = await record(id, 'wechat_channels');
    const blocker = await pool.connect();
    let pending, unlocked = false;
    try {
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query("SELECT pg_advisory_lock(hashtextextended('cross-posts:' || $1,0))", [id]);
      // Catch immediately so an assertion failure still drains the running calculation during cleanup.
      pending = calculate(id).then(value => ({value}), error => ({error}));
      const deadline = Date.now() + 1500;
      let observedWait = false;
      while (Date.now() < deadline) {
        const waiting = await pool.query(`SELECT pid FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND wait_event='advisory' AND $1::integer=ANY(pg_blocking_pids(pid))`, [pid]);
        if (waiting.rows.length) {observedWait = true; break;}
        await delay(10);
      }
      assert.equal(observedWait, true, 'PostgreSQL proves the read snapshot finished and the write transaction is waiting');
      await pool.query('UPDATE records SET title=$2,content=$3,updated_at=$4 WHERE id=$1',
        [b, '水果蛋糕烘焙课堂今天讲奶油打发技巧与甜点配方', '', timestamp(1000)]);
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended('cross-posts:' || $1,0))", [id]);
      unlocked = true;
      const outcome = await pending;
      assert.equal(outcome.error?.code, 'CROSS_POST_RETRY');
      assert.deepEqual(await labels(id), [], 'stale content cannot create a false group');
      assert.equal((await pool.query('SELECT count(*) AS n FROM tenant_settings WHERE tenant_id=$1 AND key=$2',
        [id, CROSS_POST_CURSOR])).rows[0].n, 0, 'the rejected cycle cannot skip the changed records next time');
      const retry = await calculate(id, {now: NOW + 2000});
      assert.equal(retry.processed, 2); assert.equal(retry.done, true); assert.equal(retry.groups, 0);
      assert.deepEqual(await members(id, a), []);
      assert.deepEqual(await members(id, b), []);
    } finally {
      if (!unlocked) await blocker.query("SELECT pg_advisory_unlock(hashtextextended('cross-posts:' || $1,0))", [id]);
      if (pending) await pending;
      blocker.release();
    }
  });

  await t.test('2001 real rows advance a stable timestamp/id cursor rather than repeating the first 2000 forever', async () => {
    const id = await tenant();
    const rows = Array.from({length: 2001}, (_, i) => ({id: randomUUID(), author: `游标作者${i}`, title: `游标内容第${i}条离线固定测试数据`}));
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,record_type,title,author_name,published_ts,created_at,updated_at)
      SELECT x.id,$1,'douyin',x.id::text,'keyword_notes',x.title,x.author,$2,$2,$2
      FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,author text,title text)`, [id, timestamp(-hour), JSON.stringify(rows)]);
    const ordered = rows.map(row => row.id).sort();
    const first = await calculate(id);
    assert.equal(first.processed, 2000); assert.equal(first.done, false);
    const cursor1 = JSON.parse((await pool.query('SELECT value FROM tenant_settings WHERE tenant_id=$1 AND key=$2', [id, CROSS_POST_CURSOR])).rows[0].value);
    assert.equal(cursor1.afterId, ordered[1999]);
    const second = await calculate(id, {now: NOW + hour});
    assert.equal(second.processed, 1); assert.equal(second.done, true);
    const cursor2 = JSON.parse((await pool.query('SELECT value FROM tenant_settings WHERE tenant_id=$1 AND key=$2', [id, CROSS_POST_CURSOR])).rows[0].value);
    assert.equal(cursor2.afterId, ordered[2000]);
    assert.equal(cursor2.upper, cursor1.upper, 'the scan upper bound remains fixed between batches');
    assert.equal((await pool.query('SELECT count(*) AS n FROM records WHERE tenant_id=$1', [id])).rows[0].n, 2001);
    assert.deepEqual(await labels(id), [], 'unmatched records advance the cursor too');
  });

  await t.test('real triage HTTP labels/filter preserve counts and batch changes only selected records with individual audit rows', async () => {
    const id = await tenant(), otherTenant = await tenant();
    const a = await record(id, 'douyin', {created: -3 * hour});
    const b = await record(id, 'xiaohongshu');
    const c = await record(id, 'wechat_channels');
    const single = await record(id, 'douyin', {author: '完全不同的作者', title: '独立测试内容用于核对标记不改变统计数据'});
    const foreign = await record(otherTenant, 'wechat_channels');
    const email = `t18-${randomUUID()}@integration.invalid`, password = 'T18-offline-test-password';
    const user = (await pool.query(`INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password)
      VALUES($1,'T18 test user',$2,'active',false,'',false) RETURNING id`, [email, hashPassword(password)])).rows[0].id;
    users.push(user);
    await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_analyst','active')", [user, id]);
    server = await new Promise((resolve, reject) => {
      const instance = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
      instance.once('error', reject); instance.once('listening', () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password})});
    assert.equal(login.status, 200);
    const headers = {authorization: `Bearer ${(await login.json()).token}`, 'x-tenant-id': id, 'content-type': 'application/json'};
    async function request(path, {method = 'GET', body, tenantId = id, status = 200} = {}) {
      const response = await fetch(`${base}/api/triage${path}`, {method, headers: {...headers, 'x-tenant-id': tenantId},
        ...(body ? {body: JSON.stringify(body)} : {})});
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result)); return result;
    }
    const list = extra => request(`/records?${new URLSearchParams({queue: 'triage', pageSize: '100', ...extra})}`);
    const before = await list({}); assert.equal(before.pagination.total, 4);
    const beforeCounts = (await pool.query('SELECT platform,count(*) AS n FROM records WHERE tenant_id=$1 GROUP BY platform ORDER BY platform', [id])).rows;
    await calculate(id);
    const all = await list({}), filtered = await list({crossPlatform: 'true'});
    assert.equal(all.pagination.total, before.pagination.total);
    assert.deepEqual(all.records.map(row => row.id).sort(), [a, b, c, single].sort());
    assert.equal(filtered.pagination.total, 3);
    assert.deepEqual(filtered.records.map(row => row.id).sort(), [a, b, c].sort());
    for (const row of filtered.records) {
      assert.equal(row.cross_post_group_id, a); assert.equal(row.cross_post_count, 3);
      assert.deepEqual(row.cross_post_platforms.slice().sort(), ['douyin', 'wechat_channels', 'xiaohongshu']);
    }
    assert.equal(all.records.find(row => row.id === single).cross_post_count, 0);
    assert.equal((await list({crossPlatform: 'true', platform: 'douyin'})).pagination.total, 1);
    const detail = await request(`/records/${a}/cross-posts`);
    assert.equal(detail.ok, true); assert.equal(detail.groupId, a);
    assert.deepEqual(detail.members.map(row => row.id).sort(), [a, b, c].sort());
    await request(`/records/${foreign}/cross-posts`, {status: 404});
    await request(`/records/${a}/cross-posts`, {tenantId: otherTenant, status: 403});
    const mutation = await request('/records/batch', {method: 'PATCH', body: {ids: [a, c, foreign], status: 'reviewed', note: 'T18 only checked records'}});
    assert.equal(mutation.updated, 2); assert.deepEqual(mutation.updatedIds.sort(), [a, c].sort());
    assert.deepEqual(mutation.skipped, [foreign]);
    const statuses = (await pool.query(`SELECT r.id,COALESCE(rt.status,'unhandled') AS status FROM records r
      LEFT JOIN record_triage rt ON rt.tenant_id=r.tenant_id AND rt.record_id=r.id WHERE r.id=ANY($1::uuid[])`, [[a, b, c, single, foreign]])).rows;
    for (const row of statuses) assert.equal(row.status, [a, c].includes(row.id) ? 'reviewed' : 'unhandled', row.id);
    const audits = (await pool.query(`SELECT target_id,metadata FROM audit_logs WHERE tenant_id=$1 AND actor_user_id=$2
      AND action='record.triage_batch_updated' AND target_id<>'' ORDER BY target_id`, [id, user])).rows;
    assert.deepEqual(audits.map(row => row.target_id), [a, c].sort());
    for (const row of audits) {
      assert.deepEqual(row.metadata.recordIds, [row.target_id]);
      assert.equal(row.metadata.previous[row.target_id].status, 'unhandled');
      assert.equal(row.metadata.status, 'reviewed');
    }
    assert.deepEqual((await pool.query('SELECT platform,count(*) AS n FROM records WHERE tenant_id=$1 GROUP BY platform ORDER BY platform', [id])).rows, beforeCounts);
    assert.equal((await list({})).pagination.total, 4);
    assert.equal((await list({crossPlatform: 'true', status: 'reviewed'})).pagination.total, 2);
    await request(`/records/${a}/cross-posts/exclude`, {method: 'POST', body: {recordId: foreign}, status: 409});
    await request(`/records/${a}/cross-posts/exclude`, {method: 'POST', body: {recordId: b}});
    await calculate(id);
    const after = await request(`/records/${a}/cross-posts`);
    assert.deepEqual(after.members.map(row => row.id).sort(), [a, c].sort());
    assert.deepEqual((await request(`/records/${b}/cross-posts`)).members, []);
    assert.equal((await list({crossPlatform: 'true'})).pagination.total, 2);
    assert.equal((await list({})).pagination.total, 4);
    assert.equal((await pool.query('SELECT count(*) AS n FROM record_cross_post_exclusions WHERE tenant_id=$1 AND created_by=$2', [id, user])).rows[0].n, 2);
  });
});
