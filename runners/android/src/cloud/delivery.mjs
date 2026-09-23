import {CloudRequestError} from './client.mjs';

function checkedReceipts(payload, batch) {
  if (payload.uploadBatchId !== batch.uploadBatchId) {
    throw new CloudRequestError('receipt_batch_mismatch');
  }
  const expected = new Set(batch.events.map(event => event.eventId));
  const seen = new Set();
  for (const receipt of payload.receipts) {
    if (!expected.has(receipt.eventId) || seen.has(receipt.eventId)
      || !['accepted', 'duplicate', 'rejected'].includes(receipt.status)
      || (receipt.status !== 'rejected' && !receipt.receiptId)) {
      throw new CloudRequestError('receipt_identity_mismatch');
    }
    seen.add(receipt.eventId);
  }
  return payload.receipts;
}

// One bounded delivery attempt. The caller owns cadence and persists retryState
// with its checkpoint. No hidden loop can hold up local stop or busy-poll the DB.
export async function deliverPendingBatch({store, client, retryState = {},
  now = Date.now, random = Math.random, signal} = {}) {
  if (signal?.aborted) return {status: 'stopped', retryState};
  if ((retryState.nextAttemptAt || 0) > now()) return {status: 'deferred', retryState};
  if (retryState.blocked) return {status: 'needs_action', retryState};
  const batch = store.nextBatch({limit: 5});
  if (!batch) return {status: 'idle', retryState: {failures: 0, nextAttemptAt: 0}};
  try {
    // Checking first also covers a process crash after server commit but before ack.
    const known = checkedReceipts(await client.getReceipts(batch.uploadBatchId, {signal}), batch);
    if (known.length) store.ackBatch(batch.uploadBatchId, known);
    if (known.length === batch.events.length) {
      return {status: known.some(r => r.status === 'rejected') ? 'needs_action' : 'delivered',
        uploadBatchId: batch.uploadBatchId, retryState: {failures: 0, nextAttemptAt: 0}};
    }
    const receipts = checkedReceipts(await client.ingest(batch, {signal}), batch);
    if (receipts.length !== batch.events.length) throw new CloudRequestError('incomplete_cloud_receipt');
    store.ackBatch(batch.uploadBatchId, receipts);
    return {status: receipts.some(r => r.status === 'rejected') ? 'needs_action' : 'delivered',
      uploadBatchId: batch.uploadBatchId, retryState: {failures: 0, nextAttemptAt: 0}};
  } catch (error) {
    if (signal?.aborted || error.code === 'cloud_aborted') return {status: 'stopped', retryState};
    const failures = (retryState.failures || 0) + 1;
    const retryable = error instanceof CloudRequestError && error.retryable;
    const delay = Math.max(error.retryAfterMs || 0,
      Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6)) * (1 + random() * 0.2));
    return {status: retryable ? 'deferred' : 'needs_action', error: error.code || 'delivery_failed',
      retryState: {failures, blocked: !retryable, nextAttemptAt: now() + Math.ceil(delay)}};
  }
}
