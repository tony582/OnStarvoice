import {getRecordLifecycles} from './record-lifecycle.js';
import {reopenTriageSuggestions} from './triage-suggestions.js';

// The audit entry is the undo receipt. It is tenant/actor scoped, short lived and
// contains server-read snapshots; a client can never supply the previous state.
export async function undoTriageSuggestionBatch(tx, {tenantId, undoId, actorType, actorId, userId}) {
  const audits=await tx.queryAll(`SELECT id,target_id,metadata FROM audit_logs
    WHERE tenant_id=$1 AND actor_type=$2 AND actor_id=$3 AND action='record.triage_batch_updated'
      AND metadata->>'undoId'=$4 AND (metadata->>'undoExpiresAt')::timestamptz >= clock_timestamp()
    ORDER BY target_id`, [tenantId,actorType,actorId,undoId]);
  if (!audits.length) return null;
  const ids=audits.map(row=>row.target_id);
  await getRecordLifecycles({tenantId,recordIds:ids,tx,lock:true});
  const valid=await tx.queryOne('SELECT $1::timestamptz >= clock_timestamp() AS valid',[audits[0].metadata.undoExpiresAt]);
  if (!valid.valid) return null;
  const restoredIds=[], skipped=[];
  for (const audit of audits) {
    const {undoBefore:before,undoAfter:after,suggestionResolution}=audit.metadata;
    const current=await tx.queryOne(`SELECT to_jsonb(rt) AS snapshot,
      EXISTS(SELECT 1 FROM audit_logs a WHERE a.tenant_id=$1
        AND a.metadata->>'originalAuditId'=$3 AND a.action='record.triage_updated') AS already_undone
      FROM record_triage rt WHERE rt.tenant_id=$1 AND rt.record_id=$2`,[tenantId,audit.target_id,String(audit.id)]);
    // jsonb equality also detects priority, ownership, note and archive changes.
    const same=current && !current.already_undone && (await tx.queryOne('SELECT $1::jsonb=$2::jsonb AS same',[current.snapshot,after])).same;
    if (!same) {skipped.push(audit.target_id);continue;}
    if (before) {
      await tx.execute(`UPDATE record_triage SET status=$3,priority=$4,owner_user_id=$5,owner_name=$6,
        note=$7,feishu_table_no=$8,updated_at=now() WHERE tenant_id=$1 AND record_id=$2`,
      [tenantId,audit.target_id,before.status,before.priority,before.owner_user_id,before.owner_name,before.note,before.feishu_table_no]);
    } else {
      await tx.execute('DELETE FROM record_triage WHERE tenant_id=$1 AND record_id=$2',[tenantId,audit.target_id]);
    }
    if (suggestionResolution) await reopenTriageSuggestions(tx,{tenantId,resolutions:[suggestionResolution]});
    await tx.execute(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,actor_user_id,action,target_type,target_id,metadata)
      VALUES($1,$2,$3,$4,'record.triage_updated','record',$5,$6::jsonb)`,[tenantId,actorType,actorId,userId,audit.target_id,
      {source:'suggestion_undo',undoId,originalAuditId:String(audit.id),previousStatus:after.status,nextStatus:before?.status || 'unhandled'}]);
    restoredIds.push(audit.target_id);
  }
  return {restored:restoredIds.length,restoredIds,skipped};
}
