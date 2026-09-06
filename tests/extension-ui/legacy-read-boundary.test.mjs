import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { serializeRecordEnvelope } from '../../utils/platform/record-envelope.js';
import { adaptStoredSummary } from '../../extension-ui/adapters/stored-result.mjs';
import { buildResultCatalog } from '../../extension-ui/domain/result-catalog.mjs';

// Negative controls invoke unchanged baseline code only with synthetic objects.
// This is not a connection to a browser profile or a source used by the new UI.
const storage = await readFile(new URL('../../utils/storage.js', import.meta.url), 'utf8');
function functionSource(name) {
  const source = storage.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?^}`, 'm'))?.[0];
  assert.ok(source, `Missing baseline function ${name}`);
  return source.replace(/^export /u, '');
}

function legacyReader(records, failRead = false) {
  const calls = { reads: 0, normalized: 0, writes: [], errors: 0 };
  let nextId = 0;
  const context = vm.createContext({
    chrome: { storage: { local: { async get(key) {
      calls.reads += 1;
      if (failRead) throw new Error('synthetic read failure');
      return { [key]: { records } };
    } } } },
    console: { error() { calls.errors += 1; } },
    STORAGE_KEY: { DATA_POOL: 'synthetic-pool' },
    normalizeStoredRecord(record) { calls.normalized += 1; return { ...record }; },
    serializeRecordEnvelope(record) { return { ...record }; },
    generateRecordId() { return `generated-${++nextId}`; },
    async setItem(key, value) { calls.writes.push({ key, value }); return true; },
  });
  const names = ['getItem', 'getDefaultDataPool', 'repairDuplicateRecordIds', 'getDataPool', 'getRecord'];
  vm.runInContext(names.map(functionSource).join('\n'), context);
  return { calls, context };
}

test('actual serializer does not durably preserve proposed top-level read ownership or versions', () => {
  const input = {
    id: 'legacy-1', type: 'single_note', platform: 'xiaohongshu',
    tenantId: 'tenant-old', taskId: 'task-old', executionId: 'execution-old',
    snapshotId: 'snapshot-old', recordVersion: 'version-old',
    payload: { title: '人工旧记录', content: '人工正文' },
    meta: { captureTrace: { runId: 'diagnostic-run' } },
  };
  const before = structuredClone(input);
  const stored = serializeRecordEnvelope(input);
  for (const key of ['tenantId', 'taskId', 'executionId', 'snapshotId', 'recordVersion']) {
    assert.equal(Object.hasOwn(stored, key), false, key);
  }
  assert.equal(stored.meta.captureTrace.runId, 'diagnostic-run');
  assert.deepEqual(input, before);
});

test('legacy history, current auth and trace hints are not accepted as a new manifest', () => {
  const stored = serializeRecordEnvelope({
    id: 'legacy-1', type: 'single_note', payload: { title: '旧记录' },
    status: 'synced', lastSyncedAt: 123,
    meta: { captureTrace: { runId: 'run-1' } },
  });
  const pool = { records: [stored], lastUpdatedAt: 456, schemaVersion: 'v2', auth: { tenant: { id: 'current-tenant' } } };
  const before = structuredClone(pool);
  assert.throws(() => buildResultCatalog(pool), { message: 'Invalid result catalog' });
  const mapped = adaptStoredSummary(stored).summary;
  assert.deepEqual(mapped.delivery, { remote: 'unknown', local: 'unknown' });
  assert.deepEqual(pool, before);
});

test('baseline single-record lookup normalizes the whole 1500-row pool', async () => {
  const records = Array.from({ length: 1500 }, (_, i) => ({ id: `record-${i}`, title: '人工摘要' }));
  const { context, calls } = legacyReader(records);
  assert.equal((await context.getRecord('record-100')).id, 'record-100');
  assert.equal(calls.reads, 1);
  assert.equal(calls.normalized, 1500);
  assert.equal(calls.writes.length, 0);
});

test('baseline nominal single-record read can repair duplicate IDs and write the pool', async () => {
  const records = [{ id: 'same' }, { id: 'same' }];
  const before = structuredClone(records);
  const { context, calls } = legacyReader(records);
  await context.getRecord('same');
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].value.records[1].id, 'generated-1');
  assert.equal(new Set(calls.writes[0].value.records.map(row => row.id)).size, 2);
  assert.deepEqual(records, before);
});

test('baseline swallowed read failure can look like an empty pool, unlike the new source rejection', async () => {
  const { context, calls } = legacyReader([], true);
  const pool = await context.getDataPool();
  assert.equal(pool.records.length, 0);
  assert.equal(calls.errors, 1);
  assert.equal(calls.writes.length, 0);
});
