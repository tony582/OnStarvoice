import {withTransaction} from '../db/init.js';
import {recordTriageAdmissionSql, recordEffectiveRelevanceSql} from './record-triage-admission.js';
import {
  NON_MONITOR_SUGGESTION, TRIAGE_SUGGESTION_RULE_VERSION, TRIAGE_SUGGESTION_SETTING,
  evaluateNonMonitorSuggestion, triageSuggestionEnabled,
} from '../../shared/triage-suggestions.mjs';

// Same aliases and criteria as the current unhandled work list, shared by its API and backfill.
export const TRIAGE_SUGGESTION_ACTIVE_SQL = `
  r.record_type NOT IN ('official_content', 'blogger_profile')
  AND r.business_visibility = 'eligible'
  AND (${recordTriageAdmissionSql('r')})
  AND (${recordEffectiveRelevanceSql('r')} IS DISTINCT FROM 'irrelevant')
  AND COALESCE(rt.status, 'unhandled') = 'unhandled'
  AND rt.archived_at IS NULL
`;
const RETURNING = 'record_id, suggestion, rule_version, reason, created_at::text AS created_at, resolved_at::text AS resolved_at, resolution, resolved_by';

export async function isTriageSuggestionEnabled(tx, tenantId) {
  const row = await tx.queryOne('SELECT value FROM tenant_settings WHERE tenant_id=$1 AND key=$2',
    [tenantId, TRIAGE_SUGGESTION_SETTING]);
  return triageSuggestionEnabled(row?.value, tenantId);
}

async function refreshInTransaction(tx, {tenantId, recordId}) {
  // Human changes acquire the same record lock before changing status or suggestions.
  const record = await tx.queryOne('SELECT * FROM records WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, recordId]);
  if (!record) return {status: 'not_found', suggestion: null};
  if (!await isTriageSuggestionEnabled(tx, tenantId)) return {status: 'disabled', suggestion: null};
  const eligibility = await tx.queryOne(`SELECT (${TRIAGE_SUGGESTION_ACTIVE_SQL}) AS active
    FROM records r LEFT JOIN record_triage rt ON rt.tenant_id=r.tenant_id AND rt.record_id=r.id
    WHERE r.tenant_id=$1 AND r.id=$2`, [tenantId, recordId]);
  const reason = eligibility?.active ? evaluateNonMonitorSuggestion(record) : null;
  if (!reason) {
    const resolved = await tx.queryOne(`UPDATE record_triage_suggestions
      SET resolution='superseded',resolved_at=clock_timestamp(),resolved_by=NULL
      WHERE tenant_id=$1 AND record_id=$2 AND suggestion=$3 AND resolved_at IS NULL RETURNING ${RETURNING}`,
    [tenantId, recordId, NON_MONITOR_SUGGESTION]);
    return {status: resolved ? 'superseded' : 'not_matched', suggestion: resolved};
  }
  const suggestion = await tx.queryOne(`INSERT INTO record_triage_suggestions
    (tenant_id,record_id,suggestion,rule_version,reason) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (tenant_id,record_id,suggestion) DO UPDATE SET
      rule_version=excluded.rule_version,reason=excluded.reason,resolved_at=NULL,resolution=NULL,resolved_by=NULL
    WHERE record_triage_suggestions.resolved_at IS NULL OR record_triage_suggestions.resolution='superseded'
    RETURNING ${RETURNING}`, [tenantId, recordId, NON_MONITOR_SUGGESTION, TRIAGE_SUGGESTION_RULE_VERSION, reason]);
  // A human rejection/acceptance is sticky, including after another successful AI classification.
  return {status: suggestion ? 'open' : 'suppressed', suggestion};
}

export async function refreshTriageSuggestion({tenantId, recordId}) {
  return withTransaction(tx => refreshInTransaction(tx, {tenantId, recordId}));
}

export async function resolveTriageSuggestions(tx, {tenantId, recordIds, status, userId = null}) {
  const ids = [...new Set(recordIds || [])].sort();
  if (!ids.length) return [];
  await tx.queryAll('SELECT id FROM records WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [tenantId, ids]);
  return tx.queryAll(`UPDATE record_triage_suggestions SET resolution=$3,resolved_at=clock_timestamp(),resolved_by=$4
    WHERE tenant_id=$1 AND record_id=ANY($2::uuid[]) AND suggestion=$5 AND resolved_at IS NULL RETURNING ${RETURNING}`,
  [tenantId, ids, status === 'reviewed_non_monitor' ? 'accepted' : 'rejected', userId, NON_MONITOR_SUGGESTION]);
}

export async function reopenTriageSuggestions(tx, {tenantId, resolutions}) {
  const snapshots = [...(resolutions || [])].sort((a, b) => String(a.record_id).localeCompare(String(b.record_id)));
  if (!snapshots.length) return [];
  const ids = [...new Set(snapshots.map(row => row.record_id))];
  const records = await tx.queryAll(`SELECT r.*,COALESCE(rt.status,'unhandled') AS triage_status,rt.archived_at,
      (${TRIAGE_SUGGESTION_ACTIVE_SQL}) AS suggestion_active
    FROM records r LEFT JOIN record_triage rt ON rt.tenant_id=r.tenant_id AND rt.record_id=r.id
    WHERE r.tenant_id=$1 AND r.id=ANY($2::uuid[]) ORDER BY r.id FOR UPDATE OF r`, [tenantId, ids]);
  const byId = new Map(records.map(record => [record.id, record]));
  const reopened = [];
  for (const row of snapshots) {
    if (!['accepted', 'rejected'].includes(row.resolution) || !row.resolved_at) continue;
    const record = byId.get(row.record_id);
    if (!record || record.triage_status !== 'unhandled' || record.archived_at) continue;
    // Classification/text can change while the record is handled. Undo restores the
    // human status, but must not revive a suggestion which no longer matches rule F.
    const reason = record.suggestion_active ? evaluateNonMonitorSuggestion(record) : null;
    // resolved_at comes from PostgreSQL ::text, preserving microseconds across audit JSON/undo.
    const current = await tx.queryOne(`UPDATE record_triage_suggestions s
      SET resolved_at=CASE WHEN $7::jsonb IS NULL THEN clock_timestamp() ELSE NULL END,
        resolution=CASE WHEN $7::jsonb IS NULL THEN 'superseded' ELSE NULL END,resolved_by=NULL,
        reason=COALESCE($7::jsonb,s.reason),rule_version=$8
      WHERE s.tenant_id=$1 AND s.record_id=$2 AND s.suggestion=$3 AND s.resolution=$4
        AND s.resolved_at=$5::timestamptz AND s.resolved_by IS NOT DISTINCT FROM $6::uuid
      RETURNING ${RETURNING}`, [tenantId, row.record_id, NON_MONITOR_SUGGESTION, row.resolution, row.resolved_at, row.resolved_by,
      reason, TRIAGE_SUGGESTION_RULE_VERSION]);
    if (current && reason) reopened.push(current);
  }
  return reopened;
}

export async function backfillTriageSuggestions({tenantId, apply = false, sampleLimit = 20}) {
  const preview = await withTransaction(async tx => {
    const enabled = await isTriageSuggestionEnabled(tx, tenantId);
    const {present} = await tx.queryOne("SELECT to_regclass('public.record_triage_suggestions') IS NOT NULL AS present");
    if (apply && !present) throw new Error('TRIAGE_SUGGESTION_MIGRATION_REQUIRED');
    const existingJoin = present ? `LEFT JOIN record_triage_suggestions s ON s.tenant_id=r.tenant_id AND s.record_id=r.id AND s.suggestion='non_monitor'` : '';
    const existingFields = present ? 's.resolution,s.record_id AS suggested_record_id' : 'NULL::text AS resolution,NULL::uuid AS suggested_record_id';
    const rows = await tx.queryAll(`SELECT r.id,r.tenant_id,r.platform,r.title,r.content,r.author_name,r.keyword,r.url,r.ai_result,${existingFields}
      FROM records r LEFT JOIN record_triage rt ON rt.tenant_id=r.tenant_id AND rt.record_id=r.id ${existingJoin}
      WHERE r.tenant_id=$1 AND (${TRIAGE_SUGGESTION_ACTIVE_SQL}) ORDER BY r.id`, [tenantId]);
    const result = {tenantId, enabled, ruleVersion: TRIAGE_SUGGESTION_RULE_VERSION, dryRun: !apply, scanned: rows.length,
      matched: 0, alreadyOpen: 0, suppressed: 0, wouldCreate: 0, wouldReopen: 0, applied: 0, samples: [], recordIds: []};
    for (const row of rows) {
      const reason = evaluateNonMonitorSuggestion(row);
      if (!reason) continue;
      result.matched++;
      if (row.resolution === 'accepted' || row.resolution === 'rejected') { result.suppressed++; continue; }
      if (!enabled) continue;
      if (!row.suggested_record_id) result.wouldCreate++;
      else if (row.resolution === 'superseded') result.wouldReopen++;
      else result.alreadyOpen++;
      result.recordIds.push(row.id);
      if (result.samples.length < Math.min(100, Math.max(0, sampleLimit))) result.samples.push({recordId: row.id,
        platform: row.platform, title: row.title, author: row.author_name, keyword: row.keyword, url: row.url, reason});
    }
    return result;
  }, {readOnly: true, isolationLevel: 'repeatable_read', statementTimeoutMs: 30000, lockTimeoutMs: 3000});
  if (apply) for (const recordId of preview.recordIds) {
    // Re-read the record, switch, admission and status under lock: the preview is not a write permit.
    if ((await refreshTriageSuggestion({tenantId, recordId})).status === 'open') preview.applied++;
  }
  const {recordIds: _ids, ...result} = preview;
  return result;
}
