import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import test from 'node:test';
import {createCaptureDiscoveriesRouter} from '../server/routes/capture-discoveries.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const express = require('express');
const agent = {id: 'agent-a', tenant_id: 'tenant-a', auth_code_id: 'code-a',
  auth_binding_id: 'binding-a', allowed_platforms: ['douyin'],
  capabilities: {agentKind: 'android_mobile', mobileSearchDiscoveryV1: true}};

async function serve(t, overrides = {}) {
  let authCalls = 0;
  const calls = [];
  const service = {
    async ingestBatch(value) { calls.push(value); return {uploadBatchId: value.batch.uploadBatchId, receipts: []}; },
    async getReceipts(value) { calls.push(value); return {uploadBatchId: value.uploadBatchId, receipts: []}; },
    ...overrides.service,
  };
  const authenticateAgent = (req, res, next) => {
    authCalls++;
    if (req.headers['x-capture-agent-token'] !== 'fixture-token') {
      return res.status(401).json({ok: false});
    }
    req.captureAgent = overrides.agent || agent;
    next();
  };
  const app = express();
  app.use(express.json());
  app.use('/api/capture-cloud', createCaptureDiscoveriesRouter({
    authenticateAgent, service, enabledTenants: overrides.enabledTenants || new Set(['tenant-a']),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {server.close(resolve); server.closeAllConnections();}));
  return {calls, authCalls: () => authCalls, request: (path, options = {}) => fetch(
    `http://127.0.0.1:${server.address().port}/api/capture-cloud${path}`, {
      ...options, headers: {'content-type': 'application/json', 'x-capture-agent-token': 'fixture-token',
        ...options.headers},
    })};
}

test('disabled discovery performs no authentication DB lookup and cannot mutate', async t => {
  const api = await serve(t, {enabledTenants: new Set()});
  const response = await api.request('/agent/discoveries', {method: 'POST', body: '{}'});
  assert.equal(response.status, 404);
  assert.equal(api.authCalls(), 0);
  assert.equal(api.calls.length, 0);
});

test('an agent token and an allowed tenant are both required', async t => {
  const api = await serve(t, {enabledTenants: new Set(['tenant-b'])});
  assert.equal((await api.request('/agent/discovery-receipts?batchId=x',
    {headers: {'x-capture-agent-token': ''}})).status, 401);
  assert.equal((await api.request('/agent/discovery-receipts?batchId=x')).status, 403);
  assert.equal(api.calls.length, 0);
});

test('ordinary browser nodes cannot use mobile discovery ingestion', async t => {
  const api = await serve(t, {agent: {...agent, capabilities: {remoteTaskCreate: true}}});
  assert.equal((await api.request('/agent/discoveries', {method: 'POST', body: '{}'})).status, 403);
  assert.equal(api.calls.length, 0);
});

test('principal derives from authenticated node, not submitted tenant or agent fields', async t => {
  const api = await serve(t);
  const batch = {tenantId: 'foreign', agentId: 'forged', uploadBatchId: 'batch-x', events: []};
  const response = await api.request('/agent/discoveries', {method: 'POST', body: JSON.stringify(batch)});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true, uploadBatchId: 'batch-x', receipts: []});
  assert.deepEqual(api.calls[0].principal, {
    tenantId: 'tenant-a', agentId: 'agent-a', authCodeId: 'code-a', authBindingId: 'binding-a',
  });
});

test('receipt lookup remains scoped to the authenticated node', async t => {
  const api = await serve(t);
  const response = await api.request('/agent/discovery-receipts?batchId=batch-x');
  assert.equal(response.status, 200);
  assert.equal(api.calls[0].uploadBatchId, 'batch-x');
  assert.equal(api.calls[0].principal.agentId, 'agent-a');
});

test('DB capacity returns retry guidance and hides internal errors', async t => {
  const api = await serve(t, {service: {getReceipts() {
    throw Object.assign(new Error('internal secret fixture'), {code: 'DB_CAPACITY_UNAVAILABLE', retryAfterMs: 2500});
  }}});
  const response = await api.request('/agent/discovery-receipts?batchId=batch-x');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '3');
  assert.deepEqual(await response.json(), {ok: false, error: 'server_busy', retryAfterMs: 2500});
});

test('invalid task lineage returns conflict without pretending success', async t => {
  const api = await serve(t, {service: {ingestBatch() {
    throw Object.assign(new Error('private internals'), {code: 'TASK_LINEAGE_CONFLICT', status: 409});
  }}});
  const response = await api.request('/agent/discoveries', {method: 'POST', body: '{}'});
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {ok: false, error: 'TASK_LINEAGE_CONFLICT'});
});
