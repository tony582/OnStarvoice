import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createApp} from '../../../server/app.js';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {hashSessionToken} from '../../../server/services/auth-service.js';
import {pngFixture} from '../../helpers/wechat-image-fixtures.mjs';

test('image proxy requires a live login cookie, without requiring tenant membership', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const previousFetch = globalThis.fetch;
  let pool, userId, server;
  t.after(async () => {
    globalThis.fetch = previousFetch;
    if (server) await new Promise(resolve => {server.close(resolve);server.closeAllConnections();});
    if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await closePool();
  });
  await runMigrations(); pool = getPool();
  const token = randomUUID();
  const created = await pool.query(`INSERT INTO users(email,name,password_hash,status,is_internal,global_role)
    VALUES($1,'Image proxy test','not-a-login-password','active',false,'') RETURNING id`, [`image-${randomUUID()}@integration.invalid`]);
  userId = created.rows[0].id;
  await pool.query(`INSERT INTO user_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,
    [userId,hashSessionToken(token)]);
  const app = createApp({logger: {log() {}, error() {}}});
  server = app.listen(0,'127.0.0.1');await once(server,'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mediaUrl = 'https://p3.douyinpic.com/offline-test.png';
  let upstreamRequests = 0;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.href === mediaUrl) {
      upstreamRequests++;
      assert.equal(init.redirect, 'manual');
      return Promise.resolve(new Response(pngFixture(), {headers: {'content-type': 'image/png'}}));
    }
    assert.equal(url.origin, origin, 'only loopback HTTP and the fake CDN response are used');
    return previousFetch(input, init);
  };
  const url = `${origin}/api/img?url=${encodeURIComponent(mediaUrl)}`;
  for (const headers of [{}, {Cookie:'osv_session=invalid'}]) {
    const denied = await fetch(url, {headers});
    assert.equal(denied.status,401);
    assert.equal((await denied.json()).error,'unauthorized');
  }
  assert.equal(upstreamRequests,0);
  const accepted = await fetch(url,{headers:{Cookie:`osv_session=${token}`}});
  assert.equal(accepted.status,200);
  assert.deepEqual(Buffer.from(await accepted.arrayBuffer()),pngFixture());
  assert.equal(accepted.headers.get('cache-control'),'public, max-age=86400, immutable');
  assert.equal(accepted.headers.get('cross-origin-resource-policy'),'cross-origin');
  assert.equal(upstreamRequests,1);
  await pool.query(`UPDATE user_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1`,[userId]);
  const expired = await fetch(url,{headers:{Cookie:`osv_session=${token}`}});
  assert.equal(expired.status,401);
  assert.equal(upstreamRequests,1);
});
