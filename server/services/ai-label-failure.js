// Bounded retry for record labelling.
//
// Before this module a failed label left no trace on the record: the write transaction
// rolled back, labelRecord() logged the message and returned null, and the 10-minute
// batch selected the record again and paid for another model call. One record failed
// 1,097 times in nine days.
//
// A failure that would repeat for the same record (the database rejects the write, the
// model reply is unusable, the provider rejects this input) is counted in
// records.ai_result.labelFailure. After LABEL_FAILURE_BUDGET counted failures the record is
// parked: the batch skips it, it stays unlabelled (no invented result), and it is tried
// again only by a forced relabel (a re-capture that changed its text: a fresh budget) or
// after LABEL_FAILURE_RULES_VERSION is bumped (also a fresh budget). Failures that clear
// themselves or are not the record's fault (database busy, provider busy or unreachable,
// tenant configuration, schema or code faults) are never counted and behave as before.
//
// Known limit: parking assumes the failure is specific to the record. If a provider or
// configuration fault makes every record fail with a counted failure for longer than about
// an hour, the whole backlog is parked and stays parked after the cause is fixed. It is
// found with the query in docs/hotfix/20260929-ai-label-surrogate.md and revived by bumping
// LABEL_FAILURE_RULES_VERSION or by deleting the marker.
//
// A successful label replaces ai_result wholesale, which removes the marker.
import { queryOne } from '../db/init.js';

// Bump this when a fix lands on the label write path: every parked record then gets a fresh
// budget, without anyone having to find them.
export const LABEL_FAILURE_RULES_VERSION = 'label-failure-v1';
export const LABEL_FAILURE_BUDGET = 3;
// Wait before the next attempt, indexed by the number of counted failures so far. The
// first is the next 10-minute batch, the rest one hour.
export const LABEL_FAILURE_RETRY_DELAYS_SECONDS = Object.freeze([300, 3600]);

// Pending-record filter for the batch. $2 is LABEL_FAILURE_RULES_VERSION. Written to be
// safe for any ai_result shape: a non-object value, a marker of another shape or a
// non-numeric nextAtEpoch all read as "due".
export const LABEL_RETRY_DUE_SQL = `(
  jsonb_typeof(ai_result -> 'labelFailure') IS DISTINCT FROM 'object'
  OR ai_result -> 'labelFailure' ->> 'rules' IS DISTINCT FROM $2
  OR (
    ai_result -> 'labelFailure' -> 'parked' IS DISTINCT FROM 'true'::jsonb
    AND CASE WHEN jsonb_typeof(ai_result -> 'labelFailure' -> 'nextAtEpoch') = 'number'
      THEN (ai_result -> 'labelFailure' ->> 'nextAtEpoch')::numeric <= extract(epoch FROM now())
      ELSE true END
  )
)`;

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const CONFIG_HTTP = new Set([401, 402, 403, 404]);
const TRANSIENT_NET_CAUSE = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED',
]);
const CONFIG_NET_CAUSE = /^(ERR_INVALID_URL|ERR_INVALID_ARG_VALUE|ERR_SSL_|ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_(VERIFY|GET)_|SELF_SIGNED_CERT)/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

const counted = reason => ({ counts: true, reason });
const skipped = reason => ({ counts: false, reason });

// Decides whether a failed label attempt counts against the record. Pure and code-first
// (never message-first). An error nobody anticipated is counted, so a deterministic failure
// of a kind not seen yet is still bounded.
export function classifyLabelError(error) {
  if (error === null || error === undefined) return counted('empty_error');
  const code = typeof error.code === 'string' ? error.code : ''; // a DOMException TimeoutError has a NUMERIC code
  const causeCode = typeof error.cause?.code === 'string' ? error.cause.code : '';
  const status = Number.isInteger(error.status) ? error.status : 0;
  const name = String(error.name || '');
  const message = String(error.message || '');

  if (code === 'DB_CAPACITY_UNAVAILABLE') return skipped('db_capacity');
  if (code === 'AI_ADMISSION_QUEUE_TIMEOUT' || code === 'AI_ADMISSION_QUEUE_FULL') return skipped('ai_admission_queue');
  if (code === 'LLM_RATE_LIMITED') return skipped('llm_rate_limited');
  if (code === 'LLM_JSON_PARSE_FAILED') return counted('llm_output_unparseable');
  if (code === 'LABEL_MODEL_EMPTY_RESULT') return counted('llm_empty_result');
  // Relay errors carry an HTTP-like status that means something else: read the code first.
  if (code === 'LLM_RELAY_PROMPT_TOO_LARGE') return counted('relay_prompt_too_large');
  if (code === 'LLM_RELAY_RESULT_INVALID') return counted('relay_result_invalid');
  if (/^LLM_RELAY_(MODEL_INVALID|TENANT_REQUIRED|PROMPT_REQUIRED|AGENT_INVALID)$/.test(code)) return skipped('relay_config');
  if (code.startsWith('LLM_RELAY_')) return skipped('relay_unavailable');
  if (code === 'LLM_HTTP_ERROR') {
    if (TRANSIENT_HTTP.has(status)) return skipped('llm_http_transient');
    if (CONFIG_HTTP.has(status)) return skipped('llm_http_config');
    if (status === 413) return counted('llm_http_413');
    if (status >= 400 && status < 500) return counted(`llm_http_${status}`);
    return skipped('llm_http_other');
  }

  // A Node socket code such as EPIPE has five capital letters, like a SQLSTATE: read it first.
  if (TRANSIENT_NET_CAUSE.has(code)) return skipped('network');

  if (SQLSTATE.test(code)) {
    // 08P01 is a bind/protocol mismatch, i.e. a bug, and must be tested before the class 08 rule.
    if (code === '08P01') return skipped('pg_code_fault');
    const family = code.slice(0, 2);
    if (family === '22' || family === '23' || family === '54') return counted(`pg_${code}`);
    if (family === '40' || code === '55P03' || code === '57014') return skipped('pg_busy');
    if (family === '53' || family === '57' || family === '08' || code === '25P03') return skipped('pg_resource_or_connection');
    if (['28', '3D', '3F', '42', '0A', 'XX', '25'].includes(family)) return skipped('pg_system');
    return counted('pg_unclassified');
  }

  if (name === 'TimeoutError' || name === 'AbortError') return skipped('timeout');
  if (causeCode && CONFIG_NET_CAUSE.test(causeCode)) return skipped('endpoint_config');
  if (causeCode && TRANSIENT_NET_CAUSE.has(causeCode)) return skipped('network');
  if (message === 'fetch failed') return skipped('network');
  if (/^Failed to parse URL/.test(message)) return skipped('endpoint_config');
  if (/Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|Cannot use a pool after calling end/.test(message)) {
    return skipped('pg_connection');
  }
  // Thrown before a request leaves the process (for example an API key with a non-ASCII character
  // in the Authorization header): tenant configuration, not the record.
  if (name === 'TypeError' && /ByteString|Invalid character in header|Headers/i.test(message)) return skipped('endpoint_config');
  if (name === 'SyntaxError') return counted('response_not_json');
  if (name === 'TypeError' || name === 'ReferenceError' || name === 'RangeError') return counted(`js_${name}`);
  return counted('unclassified');
}

export function readLabelFailure(aiResult) {
  let value = aiResult;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const marker = value && typeof value === 'object' && !Array.isArray(value) ? value.labelFailure : null;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const epoch = field => (typeof field === 'number' && Number.isFinite(field) ? field : null);
  return {
    rules: typeof marker.rules === 'string' ? marker.rules : '',
    attempts: Number.isInteger(marker.attempts) && marker.attempts > 0
      ? Math.min(marker.attempts, LABEL_FAILURE_BUDGET) : 0,
    parked: marker.parked === true,
    nextAtEpoch: epoch(marker.nextAtEpoch),
    lastAtEpoch: epoch(marker.lastAtEpoch),
  };
}

// True while a record must not be sent to the model again: parked, or waiting out the
// delay after its last counted failure. A marker from another rules version is ignored.
// `nowMs` should be the database clock (nextAtEpoch was written with it), as the batch SQL uses.
export function isLabelAttemptBlocked(aiResult, nowMs = Date.now()) {
  const marker = readLabelFailure(aiResult);
  if (!marker || marker.rules !== LABEL_FAILURE_RULES_VERSION) return false;
  if (marker.parked) return true;
  return marker.nextAtEpoch !== null && marker.nextAtEpoch * 1000 > nowMs;
}

// The budget arithmetic. `previous` is the marker read with the record. A forced relabel
// (its text changed) starts a fresh budget.
export function planLabelFailure({ previous, force = false }) {
  const carried = !force && previous && previous.rules === LABEL_FAILURE_RULES_VERSION ? previous.attempts : 0;
  const attempts = carried + 1;
  const parked = attempts >= LABEL_FAILURE_BUDGET;
  const delaySeconds = parked
    ? null
    : LABEL_FAILURE_RETRY_DELAYS_SECONDS[Math.min(attempts, LABEL_FAILURE_RETRY_DELAYS_SECONDS.length) - 1];
  return { attempts, parked, delaySeconds };
}

// Records the failure on the record itself. Only the error CODE is stored, never the
// message: it can quote request text or a URL that carries an API key. The guard leaves a
// record alone that was labelled or changed meanwhile; updated_at is not touched.
//
// A legacy ai_result that is not a JSON object (a string, an array, JSON null) and holds no label
// (`replaceScalar`, decided by the caller with hasRelevanceResult) is replaced by the marker:
// without that, such a record could never be counted and would be retried without bound. One that
// does hold a label is never rewritten.
export async function writeLabelFailure({ record, failure, error, plan, replaceScalar = false }) {
  const errorCode = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : '';
  return queryOne(`
    UPDATE records
    SET ai_result = (CASE WHEN jsonb_typeof(ai_result) = 'object' THEN ai_result ELSE '{}'::jsonb END)
      || jsonb_build_object('labelFailure', jsonb_build_object(
        'rules', $3::text,
        'attempts', $4::int,
        'parked', $5::boolean,
        'reason', $6::text,
        'code', $7::text,
        'lastAt', to_jsonb(now()),
        'lastAtEpoch', extract(epoch FROM now()),
        'nextAtEpoch', CASE WHEN $5::boolean THEN NULL ELSE extract(epoch FROM now()) + $8::int END))
    WHERE id = $1 AND tenant_id = $2
      AND (jsonb_typeof(ai_result) = 'object' OR $10::boolean)
      AND ai_result ->> 'relevance' IS NULL
      AND ai_labeled_at::text IS NOT DISTINCT FROM $9::text
    RETURNING id
  `, [
    record.id, record.tenant_id,
    LABEL_FAILURE_RULES_VERSION, plan.attempts, plan.parked,
    failure.reason, errorCode, plan.delaySeconds ?? 0, record.classification_version ?? null,
    replaceScalar === true,
  ]);
}
