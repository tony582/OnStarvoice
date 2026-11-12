import {isTriageSuggestionEnabled, triageSuggestionActiveSql} from './triage-suggestions.js';

export const openTriageSuggestionSql = () => `(${triageSuggestionActiveSql()}) AND EXISTS (
  SELECT 1 FROM record_triage_suggestions suggestion
  WHERE suggestion.tenant_id=r.tenant_id AND suggestion.record_id=r.id
    AND suggestion.suggestion='non_monitor' AND suggestion.resolved_at IS NULL)`;

export function publicTriageSuggestion(row) {
  return row ? {suggestion: row.suggestion, ruleVersion: row.rule_version, reason: row.reason} : null;
}

export async function openTriageSuggestions(db, tenantId, recordIds) {
  if (!recordIds.length || !await isTriageSuggestionEnabled(db, tenantId)) return [];
  return db.queryAll(`SELECT s.* FROM record_triage_suggestions s
    JOIN records r ON r.tenant_id=s.tenant_id AND r.id=s.record_id
    LEFT JOIN record_triage rt ON rt.tenant_id=r.tenant_id AND rt.record_id=r.id
    WHERE s.tenant_id=$1 AND s.record_id=ANY($2::uuid[])
      AND s.suggestion='non_monitor' AND s.resolved_at IS NULL
      AND (${triageSuggestionActiveSql()})`, [tenantId, recordIds]);
}

export async function triageSuggestionSummary(db, tenantId, where, params) {
  const enabled = await isTriageSuggestionEnabled(db, tenantId);
  const empty = {enabled, count:0, stats:{accepted:0,rejected:0,superseded:0,acceptanceRate:null}};
  if (!enabled) return empty;
  const [count, stats] = await Promise.all([
    db.queryOne(`SELECT COUNT(*)::int AS count FROM record_triage_suggestions s
      JOIN records r ON r.tenant_id=s.tenant_id AND r.id=s.record_id
      LEFT JOIN record_triage rt ON rt.tenant_id=r.tenant_id AND rt.record_id=r.id
      ${where} AND s.suggestion='non_monitor' AND s.resolved_at IS NULL
        AND (${triageSuggestionActiveSql()})`, params),
    db.queryOne(`SELECT COUNT(*) FILTER (WHERE resolution='accepted')::int AS accepted,
      COUNT(*) FILTER (WHERE resolution='rejected')::int AS rejected,
      COUNT(*) FILTER (WHERE resolution='superseded')::int AS superseded
      FROM record_triage_suggestions WHERE tenant_id=$1
        AND resolved_at >= now()-interval '30 days' AND suggestion='non_monitor'`, [tenantId]),
  ]);
  const accepted=Number(stats.accepted), rejected=Number(stats.rejected);
  return {enabled, count:Number(count.count), stats:{accepted,rejected,superseded:Number(stats.superseded),
    acceptanceRate: accepted+rejected ? accepted/(accepted+rejected) : null}};
}
