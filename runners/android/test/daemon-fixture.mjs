import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export async function mockControlPlane(t, {onRequest} = {}) {
  const taskId = randomUUID();
  const identity = {taskId, discoveryRunId: taskId, itemId: randomUUID(), attemptId: randomUUID(),
    agentId: randomUUID(), requestHash: 'f'.repeat(64), assignmentRevision: 1};
  const task = {identity, deviceId: 'SIMULATED_DEVICE', keyword: '别克壁纸',
    filters: {sort: 'latest', timeRange: 'day'}, deadlineAt: new Date(Date.now() + 60000).toISOString()};
  const state = {calls: [], completed: false, receipts: new Map(), task};
  const lease = () => ({...identity, leaseId: 'lease-one', serverTime: new Date().toISOString(),
    leaseUntil: new Date(Date.now() + 90000).toISOString()});
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const path = new URL(request.url, 'http://localhost');
    state.calls.push({path: path.pathname, body, token: request.headers['x-capture-agent-token']});
    const json = result => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result)); };
    if (await onRequest?.({request, response, body, path, state, json, lease})) return;
    if (path.pathname.endsWith('/register')) return json({ok: true, tenantId: 'tenant-test',
      agent: {id: identity.agentId, token: 'private-test-token', deviceId: body.deviceId}});
    if (path.pathname.endsWith('/poll')) return json({ok: true, task: state.completed || !body.readyForSearch ? null : task,
      permit: lease(), control: {}, pollAfterMs: 5, renewAfterMs: 30000});
    if (path.pathname.endsWith('/renew')) return json({ok: true, permit: lease(), control: {}});
    if (path.pathname.endsWith('/complete')) { state.completed = true; return json({ok: true, accepted: true, deviceHeld: !body.deviceIdle}); }
    if (path.pathname.endsWith('/close')) return json({ok: true, deviceHeld: false});
    if (path.pathname.endsWith('/discovery-receipts')) return json({ok: true, uploadBatchId: path.searchParams.get('batchId'),
      receipts: state.receipts.get(path.searchParams.get('batchId')) ?? []});
    if (path.pathname.endsWith('/discoveries')) {
      const receipts = body.events.map(event => ({eventId: event.eventId, status: 'accepted', receiptId: randomUUID()}));
      state.receipts.set(body.uploadBatchId, receipts);
      return json({ok: true, uploadBatchId: body.uploadBatchId, receipts});
    }
    response.statusCode = 404;
    json({ok: false});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const directory = mkdtempSync(join(tmpdir(), 'android-daemon-'));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, {recursive: true, force: true}); });
  return {baseUrl, state, directory, lockRoot: join(directory, 'locks'),
    config: {baseUrl, deviceId: task.deviceId, clientUuid: randomUUID(), agentId: identity.agentId,
      agentToken: 'private-test-token', simulation: true}};
}
export async function until(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
