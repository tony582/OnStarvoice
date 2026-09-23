import {randomUUID} from 'node:crypto';
import {matchesUiBoundRecord} from './ui-binding.js';
import {authorizePrincipal, loadLineage} from './lineage.js';
import {candidateOutcome} from './state.js';
import {DiscoveryError} from './validation.js';

function session(tx) {
  return {
    authorize: principal => authorizePrincipal(tx, principal),
    lineage: (principal, event) => loadLineage(tx, principal, event),
    async lockEvent(principal, event) {
      await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`discovery:${principal.tenantId}:${principal.agentId}:${event.eventId}`]);
    },
    async lockBatch(principal, event) {
      await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`discovery-batch:${principal.tenantId}:${principal.agentId}:${event.uploadBatchId}`]);
      const previous = await tx.queryOne(`SELECT upload_batch_hash FROM capture_discovery_events
        WHERE tenant_id=$1 AND agent_id=$2 AND upload_batch_id=$3 LIMIT 1`,
      [principal.tenantId, principal.agentId, event.uploadBatchId]);
      if (previous && previous.upload_batch_hash !== event.uploadBatchHash) {
        throw new DiscoveryError('BATCH_PAYLOAD_CONFLICT', 409);
      }
    },
    findEvent: (principal, eventId) => tx.queryOne(`
      SELECT payload_hash, upload_batch_id, receipt FROM capture_discovery_events
      WHERE tenant_id = $1 AND agent_id = $2 AND event_key = $3
    `, [principal.tenantId, principal.agentId, eventId]),
    async upsertCandidate(principal, event, identity) {
      // Lock the canonical candidate before reading records. Otherwise a stale
      // NULL read can overwrite an ingestion receipt committed while waiting
      // for ON CONFLICT to acquire this candidate's row lock.
      const previous = await tx.queryOne(`INSERT INTO capture_discovery_candidates (
          tenant_id, external_id, canonical_url, status, first_seen_at, last_seen_at
        ) VALUES ($1,$2,$3,'queued',$4,$4)
        ON CONFLICT (tenant_id,platform,external_id) DO UPDATE SET
          last_seen_at=GREATEST(capture_discovery_candidates.last_seen_at,EXCLUDED.last_seen_at),
          first_seen_at=LEAST(capture_discovery_candidates.first_seen_at,EXCLUDED.first_seen_at)
        RETURNING *`,[principal.tenantId,identity.externalId,identity.canonicalUrl,event.discoveredAt]);
      const record = await tx.queryOne(`SELECT id,business_visibility,title,content,author_name,url FROM records
        WHERE tenant_id=$1 AND platform='douyin' AND external_id=$2 LIMIT 1`,[principal.tenantId,identity.externalId]);
      const outcome=candidateOutcome(record);
      const status=record?'already_exists':['already_exists','stored'].includes(previous.status)?'queued':previous.status;
      const candidate=await tx.queryOne(`UPDATE capture_discovery_candidates SET record_id=$3,status=$4
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,[principal.tenantId,previous.id,record?.id||null,status]);
      if (record && !matchesUiBoundRecord(event,record)) {
        return {candidate,record:null,demandStatus:'needs_action',reason:'existing_record_identity_mismatch'};
      }
      return {candidate,record,demandStatus:record?outcome.demandStatus:
        ['queued','capturing'].includes(status)?'active':'needs_action'};
    },
    async saveEvent(principal, event, identity, receipt) {
      await tx.execute(`INSERT INTO capture_discovery_events (
        id, tenant_id, agent_id, task_id, item_id, attempt_id, assignment_revision, request_hash,
        event_key, payload_hash, upload_batch_id, keyword, requested_filters, observed_filters,
        raw_share_url, title_hint, author_hint, publish_time_raw, discovered_at, evidence_ref,
        verification, receipt, resolution_status, resolution_error, verified_external_id,
        delivery_mode, payload, candidate_id, upload_batch_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29)`, [
        receipt.receiptId, principal.tenantId, principal.agentId, event.taskId, event.itemId,
        event.attemptId, event.assignmentRevision, event.requestHash, event.eventId, event.payloadHash,
        event.uploadBatchId, event.keyword, event.requestedFilters, event.observedFilters,
        event.rawShareUrl, event.titleHint, event.authorHint, event.publishTimeRaw,
        event.discoveredAt, event.evidenceRef, event.verification, receipt, identity.status,
        identity.reason || '', identity.externalId || '', receipt.deliveryMode, event, receipt.candidateId,
        event.uploadBatchHash,
      ]);
    },
    async linkDemand(principal, event, result, receiptId) {
      await tx.execute(`INSERT INTO capture_discovery_run_candidates (
        tenant_id, run_id, candidate_id, first_event_id, demand_status, record_id
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (tenant_id, run_id, candidate_id) DO UPDATE SET
        record_id = EXCLUDED.record_id, demand_status = EXCLUDED.demand_status
      WHERE capture_discovery_run_candidates.demand_status <> 'canceled'`, [
        principal.tenantId, event.discoveryRunId, result.candidate.id, receiptId,
        result.demandStatus, result.record?.id || null,
      ]);
    },
    newReceiptId: randomUUID,
    async receipts(principal, uploadBatchId) {
      const rows = await tx.queryAll(`SELECT receipt FROM capture_discovery_events
        WHERE tenant_id=$1 AND agent_id=$2 AND upload_batch_id=$3
        ORDER BY received_at, id LIMIT 5`, [principal.tenantId, principal.agentId, uploadBatchId]);
      return rows.map(row => row.receipt);
    },
  };
}

export function createDiscoveryRepository({database} = {}) {
  async function db() { return database || import('../../db/query.js'); }
  return {
    async transaction(callback) {
      return (await db()).withTransaction(tx => callback(session(tx)), {
        category: 'general', statementTimeoutMs: 3000, lockTimeoutMs: 500,
        idleInTransactionTimeoutMs: 5000,
      });
    },
  };
}
