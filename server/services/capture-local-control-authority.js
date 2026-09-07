import {createHash} from 'node:crypto';
import {queryOne} from '../db/query.js';
import {hashCaptureAgentToken} from './capture-cloud.js';

export const LOCAL_CONTROL_ACTIONS = Object.freeze([
  'admit_local_plan', 'start_local_capture', 'stop_local_capture', 'recover_local_capture',
]);
export const LOCAL_CONTROL_POLICY_VERSION = 'local-capture-control-v1';
export const LOCAL_CONTROL_WINDOW_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_KEYS = ['originId', 'planFingerprint', 'platform', 'requestId',
  'attemptId', 'generation', 'sourceRevision'];
const uuid = value => typeof value === 'string' && UUID.test(value);
const hash = value => typeof value === 'string' && SHA256.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// One current MVCC SELECT, without verify/touch/heartbeat, locks, task adoption,
// command creation or writes. This observes only entitlement and binding. The
// source is caller-supplied: echoing it NEVER proves a local production origin,
// stopped document, checkpoint ownership, or permission to consume cloud work.
// The Extension must independently verify its trusted production-origin witness
// and exact action/source/generation immediately before its guarded operation.
export const LOCAL_CONTROL_AUTHORITY_SQL = `
SELECT statement_timestamp() AS evaluated_at, (
  SELECT jsonb_build_object(
    'tenant_id', ca.tenant_id, 'agent_id', ca.id,
    'auth_code_id', ca.auth_code_id, 'auth_binding_id', ca.auth_binding_id,
    'token_id', cat.id, 'token_hash', cat.token_hash,
    'token_created_at', cat.created_at, 'bound_at', ab.bound_at,
    'expires_at', ac.expires_at, 'allowed_platforms', ca.allowed_platforms
  )
  FROM capture_agent_tokens cat
  JOIN capture_agents ca ON ca.id = cat.agent_id
    AND ca.auth_code_id = cat.auth_code_id AND ca.auth_binding_id = cat.auth_binding_id
  JOIN tenants tenant ON tenant.id = ca.tenant_id AND tenant.status = 'active'
  JOIN auth_codes ac ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
    AND ac.status = 'active' AND (ac.expires_at IS NULL OR ac.expires_at > statement_timestamp())
  JOIN auth_bindings ab ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
  WHERE cat.token_hash = $1 AND cat.revoked_at IS NULL AND ca.status = 'active'
    AND (cardinality(ca.allowed_platforms) = 0 OR $2 = ANY(ca.allowed_platforms))
) AS identity
`;

function exactData(value, keys) {
  if (!record(value) || Object.getOwnPropertySymbols(value).length) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).length !== keys.length ||
      keys.some(key => !fields[key] || !Object.hasOwn(fields[key], 'value'))) return null;
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}

function captureRequest(body) {
  try {
    const input = exactData(body, ['action', 'source']);
    const source = input && exactData(input.source, SOURCE_KEYS);
    if (!LOCAL_CONTROL_ACTIONS.includes(input?.action) || !source ||
        !uuid(source.originId) || !hash(source.planFingerprint) || !hash(source.sourceRevision) ||
        !['xiaohongshu', 'douyin'].includes(source.platform) || !integer(source.generation)) return null;
    if (input.action === 'admit_local_plan') {
      if (source.requestId !== '' || source.attemptId !== '' || source.generation !== 0) return null;
    } else if (!uuid(source.requestId) || !uuid(source.attemptId) || source.generation < 1) {
      return null;
    }
    return Object.freeze({action: input.action, source: Object.freeze(source)});
  } catch { return null; }
}

export function validateLocalControlRequest(body) { return captureRequest(body) !== null; }

function iso(value) {
  if (value === null || value === undefined || value === '') return '';
  const time = value instanceof Date ? value.getTime() :
    typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function normalizeIdentity(value, tokenHash, platform) {
  if (!record(value) || !['tenant_id', 'agent_id', 'auth_code_id', 'auth_binding_id', 'token_id']
    .every(key => uuid(value[key])) || value.token_hash !== tokenHash ||
    !Array.isArray(value.allowed_platforms) || value.allowed_platforms.some(item =>
      typeof item !== 'string' || item.length === 0 || item.length > 80 || item.trim() !== item)) return null;
  const tokenCreatedAt = iso(value.token_created_at), boundAt = iso(value.bound_at);
  const expiresAt = value.expires_at === null ? null : iso(value.expires_at);
  const allowedPlatforms = [...new Set(value.allowed_platforms)].sort();
  if (!tokenCreatedAt || !boundAt || expiresAt === '' ||
      (allowedPlatforms.length > 0 && !allowedPlatforms.includes(platform))) return null;
  // Do not hash ca.updated_at, heartbeat/last_seen, statement time, action, or
  // source. Routine liveness and repeated observations must not rotate a local
  // origin's binding fence. Credential replacement and rebinding must rotate it.
  return {tenantId: value.tenant_id, agentId: value.agent_id, authCodeId: value.auth_code_id,
    authBindingId: value.auth_binding_id, tokenId: value.token_id, tokenHash,
    tokenCreatedAt, boundAt, entitlementExpiresAt: expiresAt, allowedPlatforms};
}

function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function deny(reason, action = '') {
  return {ok: false, action, decision: 'deny', reason, policyVersion: LOCAL_CONTROL_POLICY_VERSION};
}

export async function evaluateLocalControlAuthority({token, body}, {readOne = queryOne, now = Date.now} = {}) {
  const input = captureRequest(body);
  if (!input) return deny('invalid_control_target');
  const {action, source} = input;
  if (typeof token !== 'string' || token.length < 1 || token.length > 512 || /\s|[\u0000-\u001f\u007f]/u.test(token)) {
    return deny('invalid_agent_token', action);
  }
  const startedAt = now();
  if (!integer(startedAt) || startedAt > 8640000000000000 - LOCAL_CONTROL_WINDOW_MS) {
    return deny('authority_expired', action);
  }
  const tokenHash = hashCaptureAgentToken(token);
  const row = await readOne(LOCAL_CONTROL_AUTHORITY_SQL, [tokenHash, source.platform]);
  const identity = normalizeIdentity(row?.identity, tokenHash, source.platform);
  if (!identity) return deny('agent_entitlement_unavailable', action);
  const evaluatedAt = iso(row.evaluated_at), checkedAt = now();
  if (!integer(checkedAt) || checkedAt < startedAt || !evaluatedAt ||
      Date.parse(evaluatedAt) > checkedAt || Date.parse(identity.tokenCreatedAt) > Date.parse(evaluatedAt) ||
      Date.parse(identity.boundAt) > Date.parse(evaluatedAt)) return deny('authority_expired', action);
  const entitlementExpiry = identity.entitlementExpiresAt === null
    ? Infinity : Date.parse(identity.entitlementExpiresAt);
  const expiry = Math.min(startedAt + LOCAL_CONTROL_WINDOW_MS,
    Date.parse(evaluatedAt) + LOCAL_CONTROL_WINDOW_MS, entitlementExpiry);
  if (!Number.isSafeInteger(expiry) || checkedAt >= expiry) return deny('authority_expired', action);
  const expiresAt = new Date(expiry).toISOString();
  const bindingRevision = digest(identity);
  const authorityRevision = digest({policyVersion: LOCAL_CONTROL_POLICY_VERSION,
    bindingRevision, action, source, evaluatedAt, expiresAt});
  return {ok: true, action, decision: 'allow', reason: 'local_control_authorized',
    policyVersion: LOCAL_CONTROL_POLICY_VERSION, bindingRevision, authorityRevision,
    tenantId: identity.tenantId, agentId: identity.agentId,
    authCodeId: identity.authCodeId, authBindingId: identity.authBindingId,
    source: {...source}, evaluatedAt, expiresAt};
}
