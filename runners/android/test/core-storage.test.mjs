import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerStore } from '../src/storage/runner-store.mjs';

test('SQLite survives restart and reuses exact batch and original payload after an unknown response', () => {
  const dir = mkdtempSync(join(tmpdir(), 'android-outbox-'));
  const path = join(dir, 'outbox.sqlite');
  try {
    let store = new RunnerStore(path);
    const event = { eventId: 'e-1', attemptId: 'old-attempt', title: '作品', discoveredAt: '2026-09-22T01:00:00Z' };
    store.recordEvent(event);
    const original = store.nextBatch();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    store.close();
    store = new RunnerStore(path);
    assert.deepEqual(store.nextBatch(), original);
    assert.equal(store.pendingCount(), 1);
    assert.deepEqual(store.recordEvent(event), { eventId: 'e-1', duplicate: true });
    assert.throws(() => store.recordEvent({ ...event, attemptId: 'new-attempt' }), { code: 'event_payload_conflict' });
    store.ackBatch(original.uploadBatchId, [{ eventId: 'e-1', status: 'accepted', receiptId: 'receipt-1' }]);
    assert.equal(store.pendingCount(), 0);
    assert.equal(store.nextBatch(), null);
    assert.deepEqual(store.getEvent('e-1').payload, event);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('partial receipts preserve original batch; rejections remain quarantined and never overwrite evidence', () => {
  const store = new RunnerStore(':memory:');
  try {
    store.recordEvent({ eventId: 'a', value: 1 });
    store.recordEvent({ eventId: 'b', value: 2 });
    const batch = store.nextBatch();
    assert.throws(() => store.ackBatch(batch.uploadBatchId, [
      { eventId: 'a', status: 'accepted', receiptId: 'r-a' }, { eventId: 'foreign', status: 'accepted', receiptId: 'r-x' },
    ]), /membership/);
    assert.equal(store.getEvent('a').state, 'batched');
    assert.deepEqual(store.ackBatch(batch.uploadBatchId, [{ eventId: 'a', status: 'duplicate', receiptId: 'r-a' }]), { complete: false, pendingReceipts: 1 });
    assert.deepEqual(store.nextBatch(), batch);
    store.ackBatch(batch.uploadBatchId, [{ eventId: 'b', status: 'rejected', reason: 'identity_conflict' }]);
    assert.equal(store.pendingCount(), 0);
    assert.equal(store.quarantinedCount(), 1);
    assert.equal(store.getEvent('b').payload.value, 2);
    assert.equal(store.getEvent('b').receipt.reason, 'identity_conflict');
  } finally { store.close(); }
});

test('receipt acknowledgement requires durable ID and checkpoints use revision compare-and-swap', () => {
  const store = new RunnerStore(':memory:');
  try {
    store.recordEvent({ eventId: 'e' });
    const batch = store.nextBatch();
    assert.throws(() => store.ackBatch(batch.uploadBatchId, [{ eventId: 'e', status: 'accepted' }]), /receiptId/);
    assert.equal(store.saveCheckpoint('run', { count: 1 }), 1);
    assert.equal(store.saveCheckpoint('run', { count: 2 }, 1), 2);
    assert.throws(() => store.saveCheckpoint('run', { count: 0 }, 1), { code: 'checkpoint_conflict' });
    assert.deepEqual(store.loadCheckpoint('run'), { revision: 2, value: { count: 2 } });
  } finally { store.close(); }
});
