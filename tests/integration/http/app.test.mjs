import assert from 'node:assert/strict';
import test from 'node:test';

const ALLOWED_ORIGIN = 'https://admin.integration.test';
const DENIED_ORIGIN = 'https://untrusted.integration.test';
const UNREACHABLE_TEST_DATABASE = 'postgresql://onstarvoice_test:onstarvoice_test@127.0.0.1:1/onstarvoice_test_app_factory';

function listenOnTemporaryPort(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function json(response) {
  assert.match(response.headers.get('content-type') || '', /application\/json/u);
  return response.json();
}

test('createApp serves the HTTP boundary without database or background startup', async t => {
  const originalFetch = globalThis.fetch;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  const originalPgConnectTimeout = process.env.PG_CONNECT_TIMEOUT_MS;
  const blockedOutboundUrls = [];
  let localOrigin = null;

  process.env.DATABASE_URL = UNREACHABLE_TEST_DATABASE;
  process.env.TEST_DATABASE_URL = UNREACHABLE_TEST_DATABASE;
  process.env.PG_CONNECT_TIMEOUT_MS = '100';
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== localOrigin) {
      blockedOutboundUrls.push(url.href);
      throw new Error(`Unexpected outbound HTTP request: ${url.href}`);
    }
    return originalFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
    if (originalPgConnectTimeout === undefined) delete process.env.PG_CONNECT_TIMEOUT_MS;
    else process.env.PG_CONNECT_TIMEOUT_MS = originalPgConnectTimeout;
  });

  const appUrl = new URL('../../../server/app.js', import.meta.url);
  appUrl.searchParams.set('http-contract', String(Date.now()));
  const { createApp } = await import(appUrl.href);
  const { createProcessHealth } = await import(
    '../../../server/runtime/process-health.js'
  );
  const logs = [];
  const errors = [];
  const health = createProcessHealth({ role: 'api', uptime: () => 42 });
  const asyncHealth = Object.freeze({
    getLegacyHealth: () => health.getLegacyHealth(),
    getLiveness: () => health.getLiveness(),
    getReadiness: async () => health.getReadiness(),
  });
  const app = createApp({
    corsOrigins: [ALLOWED_ORIGIN],
    health: asyncHealth,
    logger: {
      log: (...args) => logs.push(args),
      error: (...args) => errors.push(args),
    },
  });
  const server = await listenOnTemporaryPort(app);
  t.after(() => closeServer(server));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  localOrigin = baseUrl;

  await t.test('reports liveness from /api/health', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.ok, true);
    assert.equal(body.version, '0.1.0');
    assert.equal(body.uptime, 42);
  });

  await t.test('separates liveness from readiness', async () => {
    const liveResponse = await fetch(`${baseUrl}/api/health/live`);
    assert.equal(liveResponse.status, 200);
    assert.deepEqual(await json(liveResponse), {
      ok: true,
      status: 'live',
      version: '0.1.0',
      role: 'api',
      uptime: 42,
    });

    const initializingResponse = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(initializingResponse.status, 503);
    assert.equal((await json(initializingResponse)).reason, 'initializing');

    health.markReady();
    const readyResponse = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(readyResponse.status, 200);
    assert.deepEqual(await json(readyResponse), {
      ok: true,
      status: 'ready',
      version: '0.1.0',
      role: 'api',
      uptime: 42,
    });

    health.markFailed('database_unavailable');
    const unavailableResponse = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(unavailableResponse.status, 503);
    assert.equal((await json(unavailableResponse)).reason, 'database_unavailable');

    const failedLiveResponse = await fetch(`${baseUrl}/api/health/live`);
    assert.equal(failedLiveResponse.status, 503);
    assert.equal((await json(failedLiveResponse)).reason, 'database_unavailable');
  });

  await t.test('redirects the root to the Admin application', async () => {
    const response = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin');
  });

  await t.test('rejects a missing user session before route work begins', async () => {
    const response = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(response.status, 401);
    assert.deepEqual(await json(response), {
      ok: false,
      error: 'unauthorized',
      message: '请先登录',
    });
  });

  await t.test('rejects missing tenant access before querying tenant data', async () => {
    const response = await fetch(`${baseUrl}/api/target`);
    assert.equal(response.status, 401);
    assert.deepEqual(await json(response), {
      ok: false,
      error: 'missing_auth_code',
      message: '缺少激活码',
    });
  });

  await t.test('returns 404 for an unknown API path', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') || '', /text\/html/u);
    assert.ok((await response.text()).length > 0);
  });

  await t.test('reflects an injected allowed CORS origin', async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal((await json(response)).ok, true);
  });

  await t.test('rejects an origin outside the injected CORS allowlist', async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: DENIED_ORIGIN },
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await json(response), {
      ok: false,
      error: 'server_error',
      message: `CORS origin not allowed: ${DENIED_ORIGIN}`,
    });
  });

  await t.test('serializes unhandled request errors as JSON', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(response.status, 500);
    const body = await json(response);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'server_error');
    assert.equal(typeof body.message, 'string');
    assert.ok(body.message.length > 0);
  });

  assert.ok(logs.some(args => String(args[0]).includes('GET /api/health')));
  assert.ok(errors.length >= 2);
  assert.deepEqual(blockedOutboundUrls, []);
});
