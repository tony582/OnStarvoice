// Automatic retry of a phone-discovered post whose browser detail capture did
// not reach the record store. Before this, every such result waited for a
// person. A failed browser is excluded from the next claim so another healthy
// browser gets the work; the ledger lives in candidate.last_error.autoRetry.

export const DISCOVERY_AUTO_RETRY_LIMIT = 2;
export const DISCOVERY_AUTO_RETRY_EXCLUSION_MS = 30 * 60 * 1000;
// A completed snapshot can arrive before its record upload (for example while
// the server was busy). Give the late receipt time before another browser
// repeats the capture.
export const DISCOVERY_LATE_RECEIPT_GRACE_MS = 3 * 60 * 1000;
export const DISCOVERY_AUTO_REQUEUED_CODE = 'detail_auto_requeued';

// Another browser cannot change these outcomes.
const PERMANENT_CODES = new Set([
  'TARGET_URL_NOT_ALLOWED',
  'TARGET_DETAIL_URL_REQUIRED',
  'TARGET_DIRECT_DETAIL_URL_REQUIRED',
  'TARGET_PLATFORM_UNSUPPORTED',
  'TARGET_POST_UNAVAILABLE',
  'TARGET_CAPTURE_CANCELED',
  'DOUYIN_CONTENT_UNAVAILABLE',
  'CONTENT_UNAVAILABLE',
  'ALL_DEMANDS_CANCELED',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_NOW_SQL = `to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function ledger(candidate) {
  const value = candidate?.last_error?.autoRetry;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function discoveryAutoRetryCount(candidate) {
  const count = Math.floor(Number(ledger(candidate).count));
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function shouldAutoRetryDiscovery({candidate, sourceCode = ''} = {}) {
  if (!candidate || candidate.record_id) return false;
  if (PERMANENT_CODES.has(String(sourceCode || '').trim().toUpperCase())) return false;
  return discoveryAutoRetryCount(candidate) < DISCOVERY_AUTO_RETRY_LIMIT;
}

/**
 * Puts the candidate back in the queue for a different browser. Returns the
 * new attempt count, or 0 when the candidate changed meanwhile.
 */
export async function requeueDiscoveryCandidate(tx, {
  tenantId, candidate, agentId, sourceCode = '', delayMs = 0,
}) {
  const previous = ledger(candidate);
  const excluded = [...new Set([
    ...(Array.isArray(previous.excludedAgentIds) ? previous.excludedAgentIds : []),
    agentId,
  ].map(value => String(value || '')).filter(value => UUID.test(value)))].slice(-20);
  const count = discoveryAutoRetryCount(candidate) + 1;
  const code = String(sourceCode || '').slice(0, 160);
  const updated = await tx.queryOne(`UPDATE capture_discovery_candidates SET status='queued',
      last_error=jsonb_build_object('code',$3::text,'autoRetry',jsonb_build_object(
        'count',$4::integer,'excludedAgentIds',$5::jsonb,'lastCode',$3::text,
        'requeuedAt',${ISO_NOW_SQL},
        'notBefore',to_char((now()+($6::bigint*interval '1 millisecond')) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    WHERE tenant_id=$1 AND id=$2 AND record_id IS NULL AND status IN ('capturing','failed')
    RETURNING id`,
  [tenantId, candidate.id, code, count, JSON.stringify(excluded), Math.max(0, Math.floor(Number(delayMs) || 0))]);
  return updated ? count : 0;
}
