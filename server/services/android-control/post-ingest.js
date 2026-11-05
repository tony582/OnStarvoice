import {batchReceipts, postBatchInput, postLineage, receiptView, saveReceipt, wechatSyncBody} from './posts.js';

/**
 * Upload of phone-captured Channels posts. Ownership and receipts use short transactions of their own; the
 * record write in between is the normal sync path (`persist`, injected by the route layer so services never
 * import routes). A lost response is answered from the stored receipt; a record write repeated after a crash
 * is idempotent (same attempt → same observation, same comment ids).
 */
export async function ingestPosts({transaction, persist}, principal, body) {
  const {uploadBatchId, events} = postBatchInput(body, principal);
  const receipts = [];
  for (const event of events) {
    const {previous, lineage, authCode} = await transaction(async tx => {
      const found = await postLineage(tx, principal, event);
      if (found.previous) return found;
      const code = await tx.queryOne('SELECT code FROM auth_codes WHERE id=$1 AND tenant_id=$2', [principal.authCodeId, principal.tenantId]);
      return {...found, authCode: code?.code || ''};
    });
    if (previous) { receipts.push(receiptView(previous)); continue; }
    if (!lineage.inWindow) {
      receipts.push(receiptView(await transaction(tx => saveReceipt(tx, principal, uploadBatchId, event,
        {status: 'rejected', reason: 'captured_outside_attempt'}))));
      continue;
    }
    // While the attempt is the item's current one the observation is bound to it strictly (as a browser sync is);
    // a post that arrives after the keyword moved on is still stored, without that binding.
    const {externalId, body: syncBody} = wechatSyncBody(event, {keyword: lineage.keyword, taskId: event.taskId,
      attemptId: lineage.current ? event.attemptId : '', requestHash: lineage.current ? event.requestHash : ''});
    let result;
    try {
      ({result} = await persist(syncBody, {tenantId: principal.tenantId, authCode,
        captureAgent: {id: principal.agentId, auth_code_id: principal.authCodeId, auth_binding_id: principal.authBindingId}}));
    } catch (error) {
      if (error?.code !== 'stale_attempt') throw error;
      result = {action: 'skipped', reason: 'stale_attempt'};
    }
    const outcome = result.action === 'skipped'
      ? {status: 'rejected', reason: result.reason || 'skipped', externalId}
      : {status: 'accepted', externalId, recordId: result.id || null, observationId: result.observationId || null};
    receipts.push(receiptView(await transaction(tx => saveReceipt(tx, principal, uploadBatchId, event, outcome))));
  }
  return {uploadBatchId, receipts};
}

export const postReceipts = ({transaction}, principal, batchId) => transaction(tx => batchReceipts(tx, principal, batchId));
