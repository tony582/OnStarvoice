import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {pngFixture} from '../../helpers/wechat-image-fixtures.mjs';

test('Channels cover and avatar localization uses real ingestion and PostgreSQL with entirely mocked downloads', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const mediaDir = await mkdtemp(join(tmpdir(), 't19-media-'));
  const beforeDir = process.env.MEDIA_DIR, beforeFetch = globalThis.fetch;
  process.env.MEDIA_DIR = mediaDir;
  const responses = new Map(), calls = [], unexpected = [], tenants = [];
  globalThis.fetch = async (url, options) => {
    url = String(url); calls.push({url, options});
    if (!responses.has(url)) {unexpected.push(url); throw new Error('Unmocked network request refused');}
    return responses.get(url)(options);
  };
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {ensureCoverLocal, ensureAvatarLocal, backfillRecentCovers} = await import('../../../server/services/media-store.js');
  const {getProcessBackgroundWorkSnapshot} = await import('../../../server/runtime/process-background-work.js');
  const {upsertCapturedRecord} = await import('../../../server/services/record-store.js');
  const {normalizeRecord} = await import('../../../server/routes/sync.js');
  const {wechatSyncBody} = await import('../../../server/services/android-control/posts.js');
  await runMigrations();
  const pool = getPool(), query = async (sql, args = []) => (await pool.query(sql, args)).rows;
  const settle = async () => {
    for (let n = 0; n < 500; n++) {if (!getProcessBackgroundWorkSnapshot().inFlight) return; await delay(10);}
    assert.fail('media background work did not settle');
  };
  t.after(async () => {
    try {
      await settle();
      if (tenants.length) await query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
      assert.deepEqual(unexpected, [], 'all image and unrelated HTTP requests must be mocked');
    } finally {
      await closePool(); globalThis.fetch = beforeFetch;
      if (beforeDir === undefined) delete process.env.MEDIA_DIR; else process.env.MEDIA_DIR = beforeDir;
      await rm(mediaDir, {recursive: true, force: true});
    }
  });
  const tenant = async () => {
    const [{id}] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`T19 media ${randomUUID()}`]);
    tenants.push(id); return id;
  };
  const image = (url, status = 200, bytes = pngFixture()) => {
    responses.set(url, () => status === 200 ? new Response(bytes, {headers: {'content-type': 'image/png'}}) : new Response('', {status}));
    return url;
  };
  const count = url => calls.filter(call => call.url === url).length;
  const stored = async id => (await query('SELECT * FROM records WHERE id=$1', [id]))[0];
  const insert = async (tenantId, cover, avatar = '', platform = 'wechat_channels') => {
    const [{id}] = await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,author_name,
      cover_url,author_avatar,business_visibility,last_seen_at) VALUES($1,$2,$3,'keyword_notes','安吉星测试','测试作者',$4,$5,'eligible',now()) RETURNING id`,
    [tenantId, randomUUID(), platform, cover, avatar]); return id;
  };
  const makeEvent = (cover, avatar) => ({platform: 'wechat_channels', capturedAt: Date.now(), shareUrl: `https://weixin.qq.com/sph/${randomUUID()}`,
    preview: {createtime: Math.floor(Date.now() / 1000), nickname: `测试作者${randomUUID()}`, description: '安吉星续费和服务测试',
      avatarUrl: avatar, coverUrl: cover, favCountFmt: '2', likeCountFmt: '1', forwardCountFmt: '0', commentCountFmt: '0', isImage: false},
    comments: {status: 'empty', headerCount: 0, items: []}, card: {snippet: '安吉星测试', timeLabel: '刚刚'}, mode: 'keyword'});
  const capture = async (tenantId, event) => {
    const {body} = wechatSyncBody(event, {keyword: '安吉星', taskId: '', attemptId: '', requestHash: ''});
    const result = await upsertCapturedRecord(normalizeRecord(body)[0], {tenantId});
    await settle(); return result;
  };

  await t.test('normal Channels ingestion schedules and stores cover plus avatar without replacing their source URLs', async () => {
    const tenantId = await tenant(), cover = image('https://finder.video.qq.com/ingested'), avatar = image('https://wx.qlogo.cn/ingested');
    const event = makeEvent(cover, avatar), result = await capture(tenantId, event), row = await stored(result.id);
    assert.equal(result.action, 'inserted'); assert.equal(row.cover_url, cover); assert.equal(row.author_avatar, avatar);
    assert.match(row.cover_local, /^\/media\/covers\/.+\.png$/); assert.match(row.author_avatar_local, /^\/media\/avatars\/.+\.png$/);
    for (const path of [row.cover_local, row.author_avatar_local]) assert.deepEqual(await readFile(join(mediaDir, path.slice(7))), pngFixture());
    for (const url of [cover, avatar]) {
      assert.equal(count(url), 1); assert.equal(calls.find(call => call.url === url).options.headers.Referer, 'https://channels.weixin.qq.com/');
    }
    await capture(tenantId, {...event, mode: 'patrol', capturedAt: Date.now() + 1000});
    assert.equal(count(cover), 1); assert.equal(count(avatar), 1, 'repeated patrol keeps durable copies');
  });

  for (const status of [400, 403]) await t.test(`${status} is persistent per URL; recapture with a fresh URL saves both missing images`, async () => {
    const tenantId = await tenant(), cover = image(`https://finder.video.qq.com/expired-${status}`, status), avatar = image(`https://wx.qlogo.cn/expired-${status}`, status);
    const event = makeEvent(cover, avatar), {id} = await capture(tenantId, event);
    const first = await stored(id);
    assert.equal(first.cover_local, ''); assert.equal(first.author_avatar_local, '');
    for (const [error, source] of [[first.cover_storage_error, cover], [first.author_avatar_storage_error, avatar]]) {
      assert.equal(error.httpStatus, status); assert.equal(error.sourceUrl, source); assert.equal(error.code, 'upstream_rejected');
    }
    await Promise.all([ensureCoverLocal(id, cover, 'wechat_channels'), ensureCoverLocal(id, cover, 'wechat_channels'),
      ensureAvatarLocal(id, avatar, 'wechat_channels')]);
    await capture(tenantId, {...event, capturedAt: Date.now() + 1000});
    await backfillRecentCovers(800, {tenantId});
    const retry = await backfillRecentCovers(1, {platform: 'wechat_channels', allHistory: true, tenantId});
    assert.equal(retry.cover.blocked, 1); assert.equal(retry.avatar.blocked, 1);
    assert.equal(count(cover), 1); assert.equal(count(avatar), 1, 'retry suppression survives ingestion and both backfill modes');
    const freshCover = image(`https://findermp.video.qq.com/fresh-${status}`), freshAvatar = image(`https://wx.qlogo.cn/fresh-${status}`);
    const updated = await capture(tenantId, {...event, mode: 'patrol', capturedAt: Date.now() + 2000,
      preview: {...event.preview, coverUrl: freshCover, avatarUrl: freshAvatar}});
    assert.equal(updated.id, id); assert.equal(updated.action, 'updated');
    const row = await stored(id);
    assert.equal(row.cover_url, freshCover); assert.equal(row.author_avatar, freshAvatar);
    assert.ok(row.cover_local && row.author_avatar_local); assert.deepEqual(row.cover_storage_error, {}); assert.deepEqual(row.author_avatar_storage_error, {});
    assert.equal(count(freshCover), 1); assert.equal(count(freshAvatar), 1);
  });

  await t.test('concurrent requests for the same URL share one download', async () => {
    const tenantId = await tenant(), cover = image('https://finder.video.qq.com/concurrent'), id = await insert(tenantId, cover);
    const results = await Promise.all(Array.from({length: 8}, () => ensureCoverLocal(id, cover, 'wechat_channels')));
    assert.ok(results.every(result => result.status === 'saved')); assert.equal(count(cover), 1);
  });

  for (const status of [200, 403]) await t.test(`late old-URL ${status} cannot overwrite a new cover or avatar`, async () => {
    const tenantId = await tenant();
    for (const [kind, source, local, error, host, ensure] of [
      ['cover', 'cover_url', 'cover_local', 'cover_storage_error', 'finder.video.qq.com', ensureCoverLocal],
      ['avatar', 'author_avatar', 'author_avatar_local', 'author_avatar_storage_error', 'wx.qlogo.cn', ensureAvatarLocal],
    ]) {
      const old = `https://${host}/late-${kind}-${status}`, fresh = image(`https://${host}/current-${kind}-${status}`, 200, pngFixture(130, 140));
      let started, release;
      const entered = new Promise(resolve => {started = resolve;}), gate = new Promise(resolve => {release = resolve;});
      responses.set(old, async () => {started(); await gate; return status === 200
        ? new Response(pngFixture(), {headers: {'content-type': 'image/png'}}) : new Response('', {status});});
      const id = await insert(tenantId, kind === 'cover' ? old : '', kind === 'avatar' ? old : '');
      const pending = ensure(id, old, 'wechat_channels'); await entered;
      await query(`UPDATE records SET ${source}=$1 WHERE id=$2`, [fresh, id]);
      assert.equal((await ensure(id, fresh, 'wechat_channels')).status, 'saved');
      const before = await stored(id); release(); assert.equal((await pending).status, 'stale');
      const after = await stored(id);
      assert.equal(after[local], before[local]); assert.deepEqual(after[error], {});
      assert.deepEqual(await readFile(join(mediaDir, after[local].slice(7))), pngFixture(130, 140));
    }
  });

  await t.test('transient errors remain retryable and unsafe redirects never reach their destination', async () => {
    const tenantId = await tenant(), cover = image('https://finder.video.qq.com/transient', 500), id = await insert(tenantId, cover);
    assert.equal((await ensureCoverLocal(id, cover, 'wechat_channels')).status, 'failed');
    assert.deepEqual((await stored(id)).cover_storage_error, {});
    image(cover); assert.equal((await ensureCoverLocal(id, cover, 'wechat_channels')).status, 'saved'); assert.equal(count(cover), 2);
    const redirected = 'https://finder.video.qq.com/unsafe-redirect';
    responses.set(redirected, () => new Response('', {status: 302, headers: {location: 'http://127.0.0.1/private'}}));
    const next = await insert(tenantId, redirected);
    assert.equal((await ensureCoverLocal(next, redirected, 'wechat_channels')).status, 'failed');
    assert.equal((await stored(next)).cover_local, '');
  });

  await t.test('all-history paged backfill reports actual saves and invalid links without touching other tenants or platforms', async () => {
    const tenantId = await tenant(), foreign = await tenant(), ids = [];
    for (const [n, status] of [200, 400, 403].entries()) {
      ids.push(await insert(tenantId, image(`https://finder.video.qq.com/history-${n}`, status), image(`https://wx.qlogo.cn/history-${n}`)));
    }
    await query("UPDATE records SET last_seen_at=now()-interval '60 days' WHERE id=ANY($1::uuid[])", [ids]);
    const other = await insert(tenantId, image('https://p3.douyinpic.com/history-untouched'), '', 'douyin');
    const foreignId = await insert(foreign, image('https://finder.video.qq.com/foreign-untouched'));
    const untouched = await query('SELECT to_jsonb(r) AS row FROM records r WHERE id=ANY($1::uuid[]) ORDER BY id', [[other, foreignId]]);
    const defaultResult = await backfillRecentCovers(1, {platform: 'wechat_channels', tenantId});
    assert.equal(defaultResult.records, 0);
    const result = await backfillRecentCovers(1, {platform: 'wechat_channels', allHistory: true, tenantId});
    assert.equal(result.records, 3); assert.equal(result.cover.saved, 1); assert.equal(result.cover.expired, 2);
    assert.equal(result.cover.http400, 1); assert.equal(result.cover.http403, 1); assert.equal(result.avatar.saved, 3);
    const countBefore = calls.length;
    const again = await backfillRecentCovers(1, {platform: 'wechat_channels', allHistory: true, tenantId});
    assert.equal(again.cover.blocked, 2); assert.equal(again.cover.existing, 1); assert.equal(again.avatar.existing, 3); assert.equal(calls.length, countBefore);
    assert.deepEqual(await query('SELECT to_jsonb(r) AS row FROM records r WHERE id=ANY($1::uuid[]) ORDER BY id', [[other, foreignId]]), untouched);
  });

  await t.test('other platforms retain existing cover retries and never schedule avatar localization', async () => {
    const tenantId = await tenant(), cover = image('https://p3.douyinpic.com/legacy-retry', 403), avatar = image('https://wx.qlogo.cn/legacy-avatar');
    const id = await insert(tenantId, cover, avatar, 'douyin');
    await ensureCoverLocal(id, cover, 'douyin'); await ensureCoverLocal(id, cover, 'douyin');
    assert.equal(count(cover), 2); assert.deepEqual((await stored(id)).cover_storage_error, {});
    assert.equal((await ensureAvatarLocal(id, avatar, 'douyin')).status, 'unsupported'); assert.equal(count(avatar), 0);
    image(cover); await ensureCoverLocal(id, cover, 'douyin');
    assert.equal((await stored(id)).cover_local, `/media/covers/${id}.png`);
  });
});
