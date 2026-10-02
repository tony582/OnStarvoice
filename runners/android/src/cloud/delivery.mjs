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

// The server answered the upload and refused the request body itself (validation or size). Sending
// the same batch again can never succeed, and the cause lies in its events, not in this runner.
const PAYLOAD_REFUSED = new Set([400, 413, 422]);
const failure = (error, batch, now) => ({code: error.code || 'delivery_failed', serverCode: error.serverCode ?? null,
  status: error.status || 0, uploadBatchId: batch.uploadBatchId, at: new Date(now()).toISOString()});

/** What a delivery turn means for a person watching: is the queue held, and by which cause. */
export function summarizeDelivery(result) {
  const cause = result.retryState?.error;
  return {status: result.status, blocked: !!result.retryState?.blocked, uploadBatchId: result.uploadBatchId ?? null,
    code: result.serverCode ?? result.error ?? cause?.serverCode ?? cause?.code ?? null};
}

// One bounded delivery attempt. The caller owns cadence and persists retryState
// with its checkpoint. No hidden loop can hold up local stop or busy-poll the DB.
export async function deliverPendingBatch({store, client, retryState = {},
  now = Date.now, random = Math.random, signal} = {}) {
  if (signal?.aborted) return {status: 'stopped', retryState};
  // A block written before 0.2.7 carries no cause. It is tried once more under the current rules
  // instead of holding every later event until someone edits the state by hand.
  if (retryState.blocked && !retryState.error) retryState = {failures: 0, nextAttemptAt: 0};
  if ((retryState.nextAttemptAt || 0) > now()) return {status: 'deferred', retryState};
  if (retryState.blocked) return {status: 'needs_action', retryState};
  // After a refused batch its events are offered one at a time for as many turns as it held.
  const singles = Math.max(0, retryState.singles || 0);
  const rested = () => ({failures: 0, nextAttemptAt: 0, ...(retryState.lastRefusal ? {lastRefusal: retryState.lastRefusal} : {})});
  const settled = (extra = {}) => ({...rested(), ...(singles > 1 ? {singles: singles - 1} : {}), ...extra});
  const batch = store.nextBatch({limit: singles > 0 ? 1 : 5});
  if (!batch) return {status: 'idle', retryState: rested()};
  let uploading = false;
  try {
    // Checking first also covers a process crash after server commit but before ack.
    const known = checkedReceipts(await client.getReceipts(batch.uploadBatchId, {signal}), batch);
    if (known.length) store.ackBatch(batch.uploadBatchId, known);
    if (known.length === batch.events.length) {
      return {status: known.some(r => r.status === 'rejected') ? 'needs_action' : 'delivered',
        uploadBatchId: batch.uploadBatchId, retryState: settled()};
    }
    uploading = true;
    const receipts = checkedReceipts(await client.ingest(batch, {signal}), batch);
    if (receipts.length !== batch.events.length) throw new CloudRequestError('incomplete_cloud_receipt');
    store.ackBatch(batch.uploadBatchId, receipts);
    return {status: receipts.some(r => r.status === 'rejected') ? 'needs_action' : 'delivered',
      uploadBatchId: batch.uploadBatchId, retryState: settled()};
  } catch (error) {
    if (signal?.aborted || error.code === 'cloud_aborted') return {status: 'stopped', retryState};
    if (uploading && error instanceof CloudRequestError && PAYLOAD_REFUSED.has(error.status)) {
      const lastRefusal = failure(error, batch, now);
      const waiting = store.unackedInBatch(batch.uploadBatchId);
      if (waiting > 1) {
        store.dissolveBatch(batch.uploadBatchId);
        return {status: 'split', error: lastRefusal.code, serverCode: lastRefusal.serverCode, uploadBatchId: batch.uploadBatchId,
          retryState: {failures: 0, nextAttemptAt: 0, singles: waiting, lastRefusal}};
      }
      store.quarantineBatch(batch.uploadBatchId, {reason: lastRefusal.serverCode ?? lastRefusal.code, at: lastRefusal.at});
      return {status: 'quarantined', error: lastRefusal.code, serverCode: lastRefusal.serverCode, uploadBatchId: batch.uploadBatchId,
        retryState: settled({lastRefusal})};
    }
    const failures = (retryState.failures || 0) + 1;
    const retryable = error instanceof CloudRequestError && error.retryable;
    const delay = Math.max(error.retryAfterMs || 0,
      Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6)) * (1 + random() * 0.2));
    return {status: retryable ? 'deferred' : 'needs_action', error: error.code || 'delivery_failed', serverCode: error.serverCode ?? null,
      retryState: {failures, blocked: !retryable, nextAttemptAt: now() + Math.ceil(delay), error: failure(error, batch, now),
        ...(singles ? {singles} : {}), ...(retryState.lastRefusal ? {lastRefusal: retryState.lastRefusal} : {})}};
  }
}
