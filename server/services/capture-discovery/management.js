import {createHash} from 'node:crypto';
import {matchesUiBoundRecord} from './ui-binding.js';
import {DiscoveryError,requireUuid} from './validation.js';
import {resolveEventIdentity} from './identity.js';
import {resolveDouyinShareUrl} from './share-resolver.js';

async function requireRun(tx,tenantId,runId,{lock=false}={}) {
  const run=await tx.queryOne(`SELECT id,status,metadata FROM capture_tasks
    WHERE tenant_id=$1 AND id=$2 AND metadata->>'workflow'='douyin_mobile_discovery' ${lock?'FOR UPDATE':''}`,[tenantId,runId]);
  if (!run) throw new DiscoveryError('DISCOVERY_RUN_NOT_FOUND',404);
  return run;
}
export function createDiscoveryManagementService({database,resolveShareUrl=resolveDouyinShareUrl}={}) {
  const transaction=async callback=>(database || await import('../../db/query.js')).withTransaction(callback,
    {category:'general',statementTimeoutMs:3000,lockTimeoutMs:500,idleInTransactionTimeoutMs:5000});
  return {
    async list({tenantId,runId}) {
      requireUuid(tenantId,'tenantId'); requireUuid(runId,'runId');
      return transaction(async tx=>{
        await tx.execute('SET TRANSACTION READ ONLY');
        const run=await requireRun(tx,tenantId,runId);
        const candidates=await tx.queryAll(`SELECT candidate.id AS "candidateId",candidate.external_id AS "externalId",
          candidate.canonical_url AS url,candidate.status,candidate.last_error AS error,
          demand.demand_status AS "demandStatus",candidate.record_id AS "recordId",
          record.business_visibility AS "recordVisibility",triage.status AS "triageStatus",
          item.execution_task_id AS "detailTaskId",task.status AS "detailTaskStatus",
          candidate.last_seen_at AS "lastSeenAt"
          FROM capture_discovery_run_candidates demand JOIN capture_discovery_candidates candidate
            ON candidate.id=demand.candidate_id AND candidate.tenant_id=demand.tenant_id
          LEFT JOIN records record ON record.id=candidate.record_id AND record.tenant_id=candidate.tenant_id
          LEFT JOIN record_triage triage ON triage.record_id=record.id AND triage.tenant_id=candidate.tenant_id
          LEFT JOIN capture_task_items item ON item.id=candidate.detail_task_item_id
          LEFT JOIN capture_tasks task ON task.id=item.execution_task_id
          WHERE demand.tenant_id=$1 AND demand.run_id=$2 ORDER BY candidate.first_seen_at,candidate.id LIMIT 101`,[tenantId,runId]);
        const events=await tx.queryAll(`SELECT id AS "receiptId",event_key AS "eventId",candidate_id AS "candidateId",
          keyword,title_hint AS "titleHint",author_hint AS "authorHint",raw_share_url AS "rawShareUrl",
          verification,resolution_status AS "resolutionStatus",resolution_error AS reason,
          delivery_mode AS "deliveryMode",review_result AS "reviewResult",discovered_at AS "discoveredAt"
          FROM capture_discovery_events WHERE tenant_id=$1 AND task_id=$2
          ORDER BY received_at,id LIMIT 101`,[tenantId,runId]);
        return {runId,status:run.status,candidates:candidates.slice(0,100),events:events.slice(0,100),
          truncated:candidates.length>100 || events.length>100};
      });
    },
    async reprocess({tenantId,runId,requestId,eventIds=[],candidateIds=[],userId=null}) {
      [tenantId,runId,requestId].forEach((value,index)=>requireUuid(value,['tenantId','runId','requestId'][index]));
      if (!Array.isArray(eventIds)||!Array.isArray(candidateIds)||eventIds.length+candidateIds.length<1
          ||eventIds.length+candidateIds.length>5) throw new DiscoveryError('REPROCESS_SELECT_1_TO_5');
      eventIds=[...new Set(eventIds.map(id=>requireUuid(id,'eventId')))].sort();
      candidateIds=[...new Set(candidateIds.map(id=>requireUuid(id,'candidateId')))].sort();
      const hash=createHash('sha256').update(JSON.stringify({runId,eventIds,candidateIds})).digest('hex');
      const replay=stored=>{
        if (stored && stored.payload_hash!==hash) throw new DiscoveryError('REPROCESS_REQUEST_CONFLICT',409);
        return stored?.result;
      };
      const prepared=await transaction(async tx=>{
        const known=replay(await tx.queryOne(`SELECT payload_hash,result FROM capture_discovery_reprocess_requests
          WHERE tenant_id=$1 AND request_id=$2`,[tenantId,requestId]));
        if (known) return {known};
        await requireRun(tx,tenantId,runId);
        const events=await tx.queryAll(`SELECT * FROM capture_discovery_events WHERE tenant_id=$1
          AND task_id=$2 AND event_key=ANY($3::uuid[])`,[tenantId,runId,eventIds]);
        if (events.length!==eventIds.length) throw new DiscoveryError('DISCOVERY_EVENT_NOT_FOUND',404);
        return {events};
      });
      if (prepared.known) return prepared.known;
      // Resolution is outside every database transaction, lock and connection.
      const resolved=await Promise.all(prepared.events.map(async event=>({event,
        identity:await resolveEventIdentity(event.payload,resolveShareUrl)})));
      return transaction(async tx=>{
        await tx.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`discovery-reprocess:${tenantId}:${requestId}`]);
        const known=replay(await tx.queryOne(`SELECT payload_hash,result FROM capture_discovery_reprocess_requests
          WHERE tenant_id=$1 AND request_id=$2`,[tenantId,requestId]));
        if (known) return known;
        const run=await requireRun(tx,tenantId,runId,{lock:true});
        // Stopping only mobile discovery leaves existing detail demand alive.
        // An explicit retry must not resume the phone or override a batch stop.
        const discoveryOnlyStop=run.metadata?.stopRequested===true
          &&run.metadata?.stopScope==='discovery'&&!run.metadata?.stopCommandId;
        if (!discoveryOnlyStop&&(run.status==='canceled'||run.metadata?.stopRequested||run.metadata?.stopCommandId
            ||run.metadata?.stopScope==='batch')) throw new DiscoveryError('DISCOVERY_RUN_STOPPED',409);
        // Prelock all existing candidates in one stable order, including those
        // referenced by resolved events, before any upsert or demand changes.
        await tx.queryAll(`SELECT id FROM capture_discovery_candidates WHERE tenant_id=$1
          AND (id=ANY($2::uuid[]) OR external_id=ANY($3::text[])) ORDER BY id FOR UPDATE`,
        [tenantId,[...candidateIds,...resolved.map(value=>value.event.candidate_id).filter(Boolean)],
          resolved.map(value=>value.identity.externalId).filter(Boolean)]);
        const results=[];
        for (const {event,identity} of resolved) {
          if (event.delivery_mode==='late_audit'||!['verified','ui_bound'].includes(event.verification)) {
            results.push({eventId:event.event_key,status:'needs_review',reason:'evidence_not_verified_or_late'}); continue;
          }
          let candidateId=event.candidate_id;
          if (!candidateId && identity.status==='resolved') {
            const record=await tx.queryOne(`SELECT id,business_visibility,title,content,author_name,url FROM records WHERE tenant_id=$1
              AND platform='douyin' AND external_id=$2 LIMIT 1`,[tenantId,identity.externalId]);
            const candidate=await tx.queryOne(`INSERT INTO capture_discovery_candidates(tenant_id,external_id,canonical_url,
              status,first_seen_at,last_seen_at,record_id) VALUES($1,$2,$3,$4,$5,$5,$6)
              ON CONFLICT(tenant_id,platform,external_id) DO UPDATE SET last_seen_at=GREATEST(capture_discovery_candidates.last_seen_at,EXCLUDED.last_seen_at)
              RETURNING id`,[tenantId,identity.externalId,identity.canonicalUrl,record?'already_exists':'queued',event.discovered_at,record?.id||null]);
            candidateId=candidate.id;
            await tx.execute(`INSERT INTO capture_discovery_run_candidates(tenant_id,run_id,candidate_id,first_event_id,demand_status,record_id)
              VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[tenantId,runId,candidateId,event.id,
              record?(record.business_visibility==='eligible'&&matchesUiBoundRecord(event.payload,record)?'fulfilled':'needs_action'):'active',record?.id||null]);
          }
          await tx.execute(`UPDATE capture_discovery_events SET candidate_id=COALESCE(candidate_id,$3),resolution_status=$4,
            resolution_error=$5,resolution_attempts=resolution_attempts+1,review_result='reprocessed',reviewed_by=$6,reviewed_at=now()
            WHERE tenant_id=$1 AND id=$2`,[tenantId,event.id,candidateId,identity.status,identity.reason||'',userId]);
          if (candidateId) candidateIds.push(candidateId);
          results.push({eventId:event.event_key,candidateId,status:identity.status,reason:identity.reason||''});
        }
        for (const id of [...new Set(candidateIds)].sort()) {
          const candidate=await tx.queryOne(`SELECT candidate.*,demand.demand_status FROM capture_discovery_candidates candidate
            JOIN capture_discovery_run_candidates demand ON demand.candidate_id=candidate.id AND demand.tenant_id=candidate.tenant_id
            WHERE candidate.tenant_id=$1 AND candidate.id=$2 AND demand.run_id=$3 FOR UPDATE OF candidate`,[tenantId,id,runId]);
          if (!candidate) throw new DiscoveryError('DISCOVERY_CANDIDATE_NOT_FOUND',404);
          if (candidate.demand_status==='canceled'||candidate.record_id||candidate.status==='capturing') {
            results.push({candidateId:id,status:candidate.status,reason:'existing_or_active_or_canceled'}); continue;
          }
          await tx.execute(`UPDATE capture_discovery_candidates SET status='queued',last_error='{}' WHERE tenant_id=$1 AND id=$2`,[tenantId,id]);
          await tx.execute(`UPDATE capture_discovery_run_candidates SET demand_status='active' WHERE tenant_id=$1
            AND run_id=$2 AND candidate_id=$3 AND demand_status<>'canceled'`,[tenantId,runId,id]);
          results.push({candidateId:id,status:'queued'});
        }
        const result={requestId,runId,results};
        await tx.execute(`INSERT INTO capture_discovery_reprocess_requests(tenant_id,request_id,run_id,payload_hash,result)
          VALUES($1,$2,$3,$4,$5)`,[tenantId,requestId,runId,hash,result]);
        return result;
      });
    },
  };
}
