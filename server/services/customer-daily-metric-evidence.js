const FIELDS = ['likes','comments_count','collects','shares'];

/** Build before carry-forward and comment guards. Never trust caller-supplied evidence. */
export function buildCustomerDailyMetricEvidence(record, commentDecision, now = new Date()) {
  const metrics = {};
  for (const field of FIELDS) {
    const value = record[field];
    const measured = typeof value === 'number' && Number.isFinite(value) && value >= 0
      && (field !== 'comments_count' || commentDecision?.preserved !== true);
    metrics[field] = {value:measured ? value : null,measured,reason:measured ? 'observed' : field === 'comments_count' && commentDecision?.preserved ? commentDecision.reason || 'preserved' : 'not_observed'};
  }
  const raw = String(record.capture_timestamp || '');
  const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? new Date(raw) : null;
  const observedAt = timestamp && Number.isFinite(timestamp.getTime()) && timestamp <= now ? timestamp.toISOString() : null;
  return {version:1,observedAt,timeSource:observedAt ? 'capture_timestamp' : 'ingested_at',metrics,allMeasured:FIELDS.every(field => metrics[field].measured)};
}

export function observationPayloadWithDailyEvidence(payload, evidence) {
  let parsed = payload;
  if (typeof parsed === 'string') { try { parsed=JSON.parse(parsed); } catch { parsed={}; } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed={};
  return JSON.stringify({...parsed,customerDailyMetricEvidence:evidence});
}
