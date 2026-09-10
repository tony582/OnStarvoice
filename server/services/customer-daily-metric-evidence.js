const FIELDS = ['likes','comments_count','collects','shares'];
const EARLIEST_CAPTURE_MS = Date.parse('2000-01-01T00:00:00Z');
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/i;

/** Capture clients use epoch milliseconds; timezone-free dates and epoch seconds
 * cannot establish a measurement day. The upper bound is server time on write,
 * or that observation's persisted ingestion time when reading historical data. */
export function parseCustomerDailyCaptureTimestamp(value, notAfter = new Date()) {
  let timestamp;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    timestamp = value;
  } else if (typeof value === 'string' && /^\d{13}$/.test(value)) {
    timestamp = Number(value);
  } else if (typeof value === 'string') {
    const parts = value.match(ISO_TIMESTAMP);
    if (!parts) return null;
    const calendarDay = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`);
    if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0,10) !== value.slice(0,10)
      || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return null;
    timestamp = Date.parse(value);
  } else return null;
  const upperBound = notAfter === null || notAfter === '' ? NaN : new Date(notAfter).getTime();
  return Number.isSafeInteger(timestamp) && timestamp >= EARLIEST_CAPTURE_MS
    && Number.isFinite(upperBound) && timestamp <= upperBound
    ? new Date(timestamp).toISOString() : null;
}

function object(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Read only: call with a persisted observation, never an incoming sync payload.
 * Only the exact service-stamped, fully measured shape affected by the old
 * millisecond parser can recover its time. Legacy or carried-forward metrics
 * remain ineligible, and no payload field can overwrite the service evidence. */
export function recoverCustomerDailyObservationTime(row = {}) {
  if (row.captured_at == null || row.captured_at === '' || !Number.isFinite(new Date(row.captured_at).getTime())) return null;
  const payload = object(row.payload);
  const stamp = object(payload.customerDailyMetricEvidence);
  if (stamp.version !== 1 || stamp.allMeasured !== true || stamp.timeSource !== 'ingested_at' || stamp.observedAt !== null) return null;
  const fields = object(stamp.metrics);
  for (const key of FIELDS) {
    const field = object(fields[key]);
    if (field.measured !== true || field.reason !== 'observed' || typeof field.value !== 'number'
      || !Number.isFinite(field.value) || field.value < 0 || row[key] == null || row[key] === ''
      || field.value !== Number(row[key])) return null;
  }
  const firstItemIndex = Array.isArray(payload.items) ? payload.items.findIndex(item => item && typeof item === 'object' && !Array.isArray(item)) : -1;
  const firstItem = firstItemIndex < 0 ? {} : object(payload.items[firstItemIndex]);
  // Mirror normalizeRecord: select one detail object first, then get the camel
  // captureTimestamp from detail, first object item, and outer payload. An
  // existing empty outer detail deliberately masks the nested detail.
  const detailPath = payload.detailPayload ? 'payload.detailPayload' : `payload.items[${firstItemIndex}].detailPayload`;
  const detail = payload.detailPayload || firstItem.detailPayload || {};
  const layers = [
    [detailPath, detail],
    [`payload.items[${firstItemIndex}]`, firstItem],
    ['payload', payload],
  ];
  let selected = layers.find(([,layer]) => layer.captureTimestamp != null && layer.captureTimestamp !== '');
  // normalizeRecord's final `get(...) || item.captureTimestamp || ''` also
  // falls back to the outer value when a chosen detail value is false or zero.
  if (!selected?.[1].captureTimestamp) selected = ['payload',payload];
  const value = selected[1].captureTimestamp;
  // Only recover the known old 13-digit millisecond parser failure. Snake-case
  // and ISO fallbacks were not proven to be the timestamp used on that write.
  if (!['number','string'].includes(typeof value) || !/^\d{13}$/.test(String(value))) return null;
  const observedAt = parseCustomerDailyCaptureTimestamp(value, row.captured_at);
  return observedAt ? {observedAt,timeSource:'capture_timestamp',recovered:true,sourcePath:`${selected[0]}.captureTimestamp`} : null;
}

/** Build before carry-forward and comment guards. Never trust caller-supplied evidence. */
export function buildCustomerDailyMetricEvidence(record, commentDecision, now = new Date()) {
  const metrics = {};
  for (const field of FIELDS) {
    const value = record[field];
    const measured = typeof value === 'number' && Number.isFinite(value) && value >= 0
      && (field !== 'comments_count' || commentDecision?.preserved !== true);
    metrics[field] = {value:measured ? value : null,measured,reason:measured ? 'observed' : field === 'comments_count' && commentDecision?.preserved ? commentDecision.reason || 'preserved' : 'not_observed'};
  }
  const observedAt = parseCustomerDailyCaptureTimestamp(record.capture_timestamp, now);
  return {version:1,observedAt,timeSource:observedAt ? 'capture_timestamp' : 'ingested_at',metrics,allMeasured:FIELDS.every(field => metrics[field].measured)};
}

export function observationPayloadWithDailyEvidence(payload, evidence) {
  let parsed = payload;
  if (typeof parsed === 'string') { try { parsed=JSON.parse(parsed); } catch { parsed={}; } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed={};
  return JSON.stringify({...parsed,customerDailyMetricEvidence:evidence});
}
