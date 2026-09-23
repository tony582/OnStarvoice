import {DiscoveryError, normalizeBatch, requireUuid, validatePrincipal} from './validation.js';
import {resolveEventIdentity} from './identity.js';
import {validateLineage} from './state.js';

function replay(existing, event) {
  if (!existing) return null;
  if (existing.payload_hash !== event.payloadHash) throw new DiscoveryError('EVENT_PAYLOAD_CONFLICT', 409);
  if (existing.upload_batch_id !== event.uploadBatchId) throw new DiscoveryError('EVENT_BATCH_CONFLICT', 409);
  return {...existing.receipt, status: 'duplicate'};
}

export function createDiscoveryService({repository, resolveShareUrl, now = Date.now} = {}) {
  if (!repository) throw new TypeError('A discovery repository is required');
  return {
    async ingestBatch({principal: rawPrincipal, batch}) {
      const principal = validatePrincipal(rawPrincipal);
      const normalized = normalizeBatch(batch, principal, now());
      // Authenticate before any optional network resolution. Exact replay skips
      // the resolver entirely and preserves the original receipt and outcome.
      const existing = await repository.transaction(async tx => {
        await tx.authorize(principal);
        return Promise.all(normalized.events.map(event => tx.findEvent(principal, event.eventId)));
      });
      const prepared = await Promise.all(normalized.events.map(async (event, index) => {
        replay(existing[index], event);
        return {event, identity: existing[index] ? null : await resolveEventIdentity(event, resolveShareUrl)};
      }));
      const receipts = [];
      // Each receipt is a short independent transaction. A failed later event
      // cannot erase an earlier durable receipt; clients retry the original batch.
      for (const {event, identity} of prepared) {
        receipts.push(await repository.transaction(async tx => {
          await tx.authorize(principal);
          await tx.lockBatch(principal, event);
          await tx.lockEvent(principal, event);
          const duplicate = replay(await tx.findEvent(principal, event.eventId), event);
          if (duplicate) return duplicate;
          const lineage = await tx.lineage(principal, event);
          const {late} = validateLineage(lineage, event, now());
          const result = !late && identity.status === 'resolved'
            ? await tx.upsertCandidate(principal, event, identity) : null;
          const receipt = {
            eventId: event.eventId, receiptId: tx.newReceiptId(), status: 'accepted',
            candidateId: result?.candidate.id || null,
            reason: late ? 'late_audit' : (identity.reason || result?.reason || result?.candidate.status || 'needs_review'),
            deliveryMode: late ? 'late_audit' : 'normal', resolutionStatus: identity.status,
            candidateStatus: result?.candidate.status || null, recordId: result?.record?.id || null,
            recordVisibility: result?.record?.business_visibility || null,
          };
          await tx.saveEvent(principal, event, identity, receipt);
          if (result) await tx.linkDemand(principal, event, result, receipt.receiptId);
          return receipt;
        }));
      }
      return {uploadBatchId: normalized.uploadBatchId, receipts};
    },
    async getReceipts({principal: rawPrincipal, uploadBatchId}) {
      const principal = validatePrincipal(rawPrincipal);
      const batchId = requireUuid(uploadBatchId, 'uploadBatchId');
      return repository.transaction(async tx => {
        await tx.authorize(principal);
        return {uploadBatchId: batchId, receipts: await tx.receipts(principal, batchId)};
      });
    },
  };
}
