import {recordTriageAdmissionSql, recordEffectiveRelevanceSql} from './record-triage-admission.js';

export const CUSTOMER_DAILY_HANDLING_FROM = '2026-10-08';
export const CUSTOMER_DAILY_HANDLING_BASIS = 'triage_handling_date_v1';
export const usesTriageHandlingDate = period => String(period?.reportDate || '') >= CUSTOMER_DAILY_HANDLING_FROM;
export const isTriageHandlingSnapshot = snapshot => snapshot?.summary?.monitoringBasis === CUSTOMER_DAILY_HANDLING_BASIS;
export const CUSTOMER_TRIAGE_STATUSES = ['unhandled', 'replied', 'reviewed', 'reviewed_non_monitor', 'unavailable', 'privacy_unreachable', 'negative_feishu', 'negative_cold', 'negative_comment'];

// Same admission, relevance, lifecycle and status scope as the Content Triage
// main list. Customer reports count main posts, never comment/profile records.
export const CUSTOMER_ACTIVE_TRIAGE_SQL = `r.record_type NOT IN ('official_content', 'blogger_profile', 'comment', 'comments', 'record_comment', 'comment_detail')
  AND r.business_visibility = 'eligible' AND (${recordTriageAdmissionSql('r')})
  AND rt.archived_at IS NULL
  AND COALESCE(rt.status, 'unhandled') IN (${CUSTOMER_TRIAGE_STATUSES.map(value => `'${value}'`).join(',')})
  AND (${recordEffectiveRelevanceSql('r')} IS DISTINCT FROM 'irrelevant' OR EXISTS (
    SELECT 1 FROM record_watchlist daily_watched WHERE daily_watched.tenant_id=r.tenant_id AND daily_watched.record_id=r.id))`;

export const isActiveDailyTriagePost = row => row.admission_allowed !== false && !row.archived_at
  && CUSTOMER_TRIAGE_STATUSES.includes(row.status || 'unhandled');
