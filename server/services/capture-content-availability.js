// Only structured, identity-bound page evidence may change availability.
export function capturedContentAvailability(record, now = Date.now()) {
  let payload = record.payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { return null; } }
  if (record.platform !== 'xiaohongshu' || !payload || !record.external_id) return null;
  if (payload.detailCaptureStatus === 'done' && payload.detailPayload?.noteId === record.external_id) {
    const at = Number(payload.detailCaptureFinishedAt);
    return Number.isFinite(at) && at > 0 && at <= now + 300000
      ? {status: 'available', observedAt: new Date(at).toISOString(), evidence: []} : null;
  }
  const value = payload.detailAvailability;
  if (payload.detailCaptureStatus !== 'unavailable' || !value ||
      value.platform !== record.platform || value.externalId !== record.external_id ||
      value.code !== 'TARGET_POST_UNAVAILABLE' ||
      !['deleted', 'page_unavailable'].includes(value.status)) return null;
  const at = Date.parse(value.observedAt);
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter(signal =>
    /^xhs_(?:deleted_copy|page_gone_countdown|unavailable_qr_layout|page_not_available|unavailable_error_copy|unavailable_toast)$/.test(signal)) : [];
  if (!Number.isFinite(at) || at <= 0 || at > now + 300000 || !evidence.length ||
      (value.status === 'deleted' && !evidence.some(signal => ['xhs_deleted_copy', 'xhs_page_gone_countdown'].includes(signal)))) return null;
  return {status: value.status, observedAt: new Date(at).toISOString(), evidence: [...new Set(evidence)].slice(0, 8)};
}

export async function persistCapturedContentAvailability(tx, {tenantId, recordId, record}) {
  const observation = capturedContentAvailability(record);
  if (!observation) return;
  await tx.execute(`UPDATE records SET content_availability_status=$3,
    content_availability_checked_at=$4::timestamptz,
    content_availability_reason=$5,content_availability_evidence=$6::jsonb
    WHERE tenant_id=$1 AND id=$2 AND (content_availability_checked_at IS NULL
      OR content_availability_checked_at <= $4::timestamptz)`,
  [tenantId, recordId, observation.status, observation.observedAt,
    observation.status === 'available' ? '' : 'post_deleted_or_unavailable',
    JSON.stringify({signals: observation.evidence, externalId: record.external_id,
      source: 'keyword_detail_enhancement'})]);
}

export async function loadUnavailableCapturedExternalIds(tx, {tenantId, platform, externalIds}) {
  if (platform !== 'xiaohongshu' || !externalIds.length) return [];
  const rows = await tx.queryAll(`SELECT external_id,content_availability_status AS status,
    content_availability_checked_at AS observed_at,content_availability_evidence AS evidence
    FROM records WHERE tenant_id=$1 AND platform=$2 AND external_id=ANY($3::text[])
      AND content_availability_checked_at IS NOT NULL
      AND (content_availability_status='deleted' OR
        (content_availability_status='page_unavailable' AND content_availability_checked_at > now()-interval '24 hours'))`,
  [tenantId, platform, externalIds]);
  return rows.map(row => ({externalId: row.external_id, platform, status: row.status,
    observedAt: new Date(row.observed_at).toISOString(), code: 'TARGET_POST_UNAVAILABLE',
    evidence: row.evidence?.signals || []}));
}
