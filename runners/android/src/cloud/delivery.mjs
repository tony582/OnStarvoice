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
// Refusals the server pins on one event's origin: the keyword was handed out again while the event
// was still waiting here, so its attempt is no longer the current one and it can never be accepted.
const EVENT_ORIGIN_REFUSED = new Set(['ATTEMPT_LINEAGE_MISMATCH', 'DISCOVERY_TASK_MISMATCH']);
const refusesEvents = error => error instanceof CloudRequestError
  && (PAYLOAD_REFUSED.has(error.status) || (error.status === 403 && EVENT_ORIGIN_REFUSED.has(error.serverCode)));
// Refusals in a row with nothing accepted in between. A few bad events are simply set aside. This
// many in a row means the cause is probably not in the events (a server fault, a version mismatch),
// and setting everything aside would hide it: keywords would finish while nothing reaches the server.
// From then on only one event is tried per pause. Waiting events pile up, keywords end with
// outbox_backlog, and that failure is what a person sees. The first accepted event ends it.
export const REFUSALS_BEFORE_PAUSE = 20;
export const REFUSAL_PAUSE_MS = 600_000;
const failure = (error, batch, now) => ({code: error.code || 'delivery_failed', serverCode: error.serverCode ?? null,
  status: error.status || 0, uploadBatchId: batch.uploadBatchId, at: new Date(now()).toISOString()});

/** What a delivery turn means for a person watching: is the queue held, and by which cause. */
export function summarizeDelivery(result) {
  const cause = result.retryState?.error;
  return {status: result.status, blocked: !!result.retryState?.blocked, uploadBatchId: result.uploadBatchId ?? null,
    code: result.serverCode ?? result.error ?? cause?.serverCode ?? cause?.code ?? null,
    pausedUntil: result.retryState?.pausedUntil ?? null, refusedInARow: result.retryState?.refusedInARow ?? 0};
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
  const refusedInARow = Math.max(0, retryState.refusedInARow || 0);
  const kept = {...(retryState.lastRefusal ? {lastRefusal: retryState.lastRefusal} : {})};
  const rested = () => ({failures: 0, nextAttemptAt: 0, ...kept, ...(refusedInARow ? {refusedInARow} : {})});
  const oneSingleDone = singles > 1 ? {singles: singles - 1} : {};
  // An accepted event proves the server takes this runner's uploads: the run of refusals is over.
  const accepted = () => ({failures: 0, nextAttemptAt: 0, ...kept, ...oneSingleDone});
  const batch = store.nextBatch({limit: singles > 0 ? 1 : 5});
  if (!batch) return {status: 'idle', retryState: rested()};
  const stopped = error => signal?.aborted || error.code === 'cloud_aborted';
  const takeReceipts = async () => {
    const known = checkedReceipts(await client.getReceipts(batch.uploadBatchId, {signal}), batch);
    if (known.length) store.ackBatch(batch.uploadBatchId, known);
    return known;
  };
  let uploading = false;
  let cause;
  try {
    // Checking first also covers a process crash after server commit but before ack.
    const known = await takeReceipts();
    if (known.length === batch.events.length) {
      return {status: known.some(r => r.status === 'rejected') ? 'needs_action' : 'delivered',
        uploadBatchId: batch.uploadBatchId, retryState: accepted()};
    }
    uploading = true;
    const receipts = checkedReceipts(await client.ingest(batch, {signal}), batch);
    if (receipts.length !== batch.events.length) throw new CloudRequestError('incomplete_cloud_receipt');
    store.ackBatch(batch.uploadBatchId, receipts);
    return {status: receipts.some(r => r.status === 'rejected') ? 'needs_action' : 'delivered',
      uploadBatchId: batch.uploadBatchId, retryState: accepted()};
  } catch (error) {
    if (stopped(error)) return {status: 'stopped', retryState};
    cause = error;
  }
  if (uploading && refusesEvents(cause)) {
    const lastRefusal = failure(cause, batch, now);
    const refused = {error: lastRefusal.code, serverCode: lastRefusal.serverCode, uploadBatchId: batch.uploadBatchId};
    try {
      // The server keeps what it accepted before the refusal. Those events take their receipts
      // first; taken apart without them, they would be offered again under another batch.
      await takeReceipts();
      const waiting = store.unackedInBatch(batch.uploadBatchId);
      if (waiting > 1) {
        store.dissolveBatch(batch.uploadBatchId);
        return {status: 'split', ...refused, retryState: {...rested(), singles: waiting, lastRefusal}};
      }
      if (!waiting) return {status: 'delivered', uploadBatchId: batch.uploadBatchId, retryState: accepted()};
      store.quarantineBatch(batch.uploadBatchId, {reason: lastRefusal.serverCode ?? lastRefusal.code, at: lastRefusal.at});
      const inARow = refusedInARow + 1;
      const pausedUntil = inARow >= REFUSALS_BEFORE_PAUSE ? now() + REFUSAL_PAUSE_MS : 0;
      return {status: 'quarantined', ...refused, retryState: {failures: 0, nextAttemptAt: pausedUntil, ...oneSingleDone,
        lastRefusal, refusedInARow: inARow, ...(pausedUntil ? {pausedUntil} : {})}};
    } catch (error) {
      if (stopped(error)) return {status: 'stopped', retryState};
      cause = error; // Nothing was taken apart; the next turn starts over from the batch's receipts.
    }
  }
  const failures = (retryState.failures || 0) + 1;
  const retryable = cause instanceof CloudRequestError && cause.retryable;
  const delay = Math.max(cause.retryAfterMs || 0,
    Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6)) * (1 + random() * 0.2));
  return {status: retryable ? 'deferred' : 'needs_action', error: cause.code || 'delivery_failed', serverCode: cause.serverCode ?? null,
    retryState: {failures, blocked: !retryable, nextAttemptAt: now() + Math.ceil(delay), error: failure(cause, batch, now),
      ...(singles ? {singles} : {}), ...kept, ...(refusedInARow ? {refusedInARow} : {})}};
}
