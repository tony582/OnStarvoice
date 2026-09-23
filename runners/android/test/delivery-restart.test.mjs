import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {runLocalDemo} from '../src/cli/demo.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {createCloudClient} from '../src/cloud/client.mjs';
import {deliverPendingBatch} from '../src/cloud/delivery.mjs';
import {normalizeBatch} from '../../../server/services/capture-discovery/validation.js';

test('real HTTP response loss + SQLite restart recover the original batch without a second POST', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'android-delivery-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  await runLocalDemo({stateDir: directory});
  const receipts = new Map();
  let posts = 0;
  let assertionError;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers['x-capture-agent-token'], 'fixture-token');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET') {
        const uploadBatchId = url.searchParams.get('batchId');
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify({ok: true, uploadBatchId, receipts: receipts.get(uploadBatchId) || []}));
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const batch = JSON.parse(Buffer.concat(chunks).toString());
      const normalized = normalizeBatch(batch, {agentId: batch.events[0].agentId});
      assert.equal(normalized.events.length, 4);
      assert.equal(new Set(normalized.events.map(event => event.verifiedExternalId)).size, 3);
      posts++;
      receipts.set(batch.uploadBatchId, batch.events.map(event => ({eventId: event.eventId,
        receiptId: randomUUID(), status: 'accepted', candidateStatus: 'awaiting_detail_adapter'})));
      // Simulate a committed server receipt followed by a dropped TCP response.
      response.destroy();
    } catch (error) { assertionError = error; response.writeHead(500); response.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {server.close(resolve); server.closeAllConnections();}));
  const client = createCloudClient({baseUrl: `http://127.0.0.1:${server.address().port}`, agentToken: 'fixture-token'});
  let store = new RunnerStore(join(directory, 'runner.sqlite'));
  const originalBatch = store.nextBatch();
  const first = await deliverPendingBatch({store, client, now: () => 1000, random: () => 0});
  assert.equal(first.status, 'deferred');
  assert.equal(store.pendingCount(), 4);
  store.saveCheckpoint('network:delivery', first.retryState);
  store.close();
  store = new RunnerStore(join(directory, 'runner.sqlite'));
  t.after(() => store.close());
  assert.deepEqual(store.nextBatch(), originalBatch);
  const second = await deliverPendingBatch({store, client,
    retryState: store.loadCheckpoint('network:delivery').value, now: () => 100000});
  if (assertionError) throw assertionError;
  assert.equal(second.status, 'delivered');
  assert.equal(posts, 1);
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.nextBatch(), null);
});
