import {createHash} from 'node:crypto';
import {queryOne} from '../db/query.js';
import {hashCaptureAgentToken} from './capture-cloud.js';

// Independent capability: neither terminal dismissal nor history/start/resume
// permissions can satisfy this policy. This provider never stops work itself.
export const ACTIVE_STOP_ACTION = 'stop_active_capture';
export const ACTIVE_STOP_POLICY_VERSION = 'active-capture-stop-v1';
export const ACTIVE_STOP_WINDOW_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const uuid = value => typeof value === 'string' && UUID.test(value);
const SOURCE_KEYS = ['clientTaskId', 'controlTaskId', 'clientAttemptId', 'attemptNumber',
  'progressSeq', 'sourceUpdatedAt', 'cloudCommandId', 'platform', 'status'];

// One SELECT and one MVCC view: no heartbeat, acknowledgement, command creation,
// locks, reconciliation, adoption or writes. A newer active task/attempt or
// command conflicts with this narrowly scoped current-source observation.
export const ACTIVE_STOP_AUTHORITY_SQL = `
WITH identity AS (
  SELECT ca.tenant_id, ca.id AS agent_id, ca.auth_code_id, ca.auth_binding_id,
    ac.expires_at, cat.id AS token_id, cat.created_at AS token_created_at,
    ca.updated_at AS agent_updated_at, ab.bound_at
  FROM capture_agent_tokens cat
  JOIN capture_agents ca ON ca.id = cat.agent_id
    AND ca.auth_code_id = cat.auth_code_id AND ca.auth_binding_id = cat.auth_binding_id
  JOIN tenants tenant ON tenant.id = ca.tenant_id AND tenant.status = 'active'
  JOIN auth_codes ac ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
    AND ac.status = 'active' AND (ac.expires_at IS NULL OR ac.expires_at > statement_timestamp())
  JOIN auth_bindings ab ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
  WHERE cat.token_hash = $1 AND cat.revoked_at IS NULL AND ca.status = 'active'
), evidence AS (
  SELECT to_jsonb(task) AS task, to_jsonb(attempt) AS attempt,
    to_jsonb(snapshot) AS snapshot, to_jsonb(command) AS command,
    EXISTS (
      SELECT 1 FROM capture_task_attempts other
      WHERE other.task_id = task.id AND other.id <> attempt.id
        AND (other.attempt_number >= attempt.attempt_number OR other.client_attempt_id = attempt.client_attempt_id)
    ) AS attempt_conflict,
    EXISTS (
      SELECT 1 FROM capture_agent_commands other
      WHERE other.agent_id = identity.agent_id AND other.tenant_id = identity.tenant_id
        AND other.id <> command.id AND other.status IN ('pending', 'acknowledged')
    ) AS command_conflict,
    EXISTS (
      SELECT 1 FROM capture_tasks other
      WHERE other.tenant_id = identity.tenant_id AND other.assigned_agent_id = identity.agent_id
        AND other.id <> task.id AND (
          other.status IN ('pending', 'waiting_device', 'claimed', 'running', 'recovering', 'resume_requested')
          OR other.metadata->>'parentRequestId' = task.client_task_id
          OR other.metadata->>'recoveryTaskId' = task.client_task_id
        )
    ) AS successor_conflict
  FROM identity
  JOIN capture_tasks task ON task.tenant_id = identity.tenant_id
    AND task.origin_agent_id = identity.agent_id AND task.assigned_agent_id = identity.agent_id
    AND task.client_task_id = $2 AND task.control_task_id = $3
    AND task.attempt_number = $5 AND task.progress_seq = $6
    AND task.source_updated_at = $7::timestamptz AND task.status = 'running'
    AND task.parent_task_id IS NULL AND task.finished_at IS NULL
  JOIN capture_task_attempts attempt ON attempt.task_id = task.id
    AND attempt.tenant_id = identity.tenant_id AND attempt.agent_id = identity.agent_id
    AND attempt.client_attempt_id = $4 AND attempt.attempt_number = task.attempt_number
    AND attempt.progress_seq = task.progress_seq AND attempt.status = task.status
    AND attempt.finished_at IS NULL
  JOIN capture_task_snapshots snapshot ON snapshot.task_id = task.id
    AND snapshot.tenant_id = identity.tenant_id AND snapshot.agent_id = identity.agent_id
    AND snapshot.attempt_id = attempt.id AND snapshot.client_attempt_id = attempt.client_attempt_id
    AND snapshot.client_task_id = task.client_task_id AND snapshot.control_task_id = task.control_task_id
    AND snapshot.attempt_number = task.attempt_number AND snapshot.progress_seq = task.progress_seq
    AND snapshot.source_updated_at = task.source_updated_at AND snapshot.status = task.status
    AND snapshot.finished_at IS NULL
  JOIN capture_agent_commands command ON command.id = $8::uuid AND command.task_id = task.id
    AND command.tenant_id = identity.tenant_id AND command.agent_id = identity.agent_id
    AND command.command_type = 'create' AND command.status = 'completed'
    AND command.payload->>'taskId' = task.id::text
    AND command.payload->>'clientTaskId' = task.client_task_id
    AND command.payload->>'authCodeId' = identity.auth_code_id::text
    AND command.payload->>'authBindingId' = identity.auth_binding_id::text
  LIMIT 2
)
SELECT statement_timestamp() AS evaluated_at,
  (SELECT to_jsonb(identity) FROM identity) AS identity,
  COALESCE((SELECT jsonb_agg(evidence) FROM evidence), '[]'::jsonb) AS evidence
`;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && value.length === 24 &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function iso(value) {
  if (value === null || value === undefined || value === '') return '';
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}
function exactData(value, keys) {
  if (!record(value) || Object.getOwnPropertySymbols(value).length) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).length !== keys.length || keys.some(key => !fields[key] || !Object.hasOwn(fields[key], 'value'))) return null;
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}
function captureRequest(body) {
  try {
    const input = exactData(body, ['action', 'source']);
    const source = input && exactData(input.source, SOURCE_KEYS);
    if (input?.action !== ACTIVE_STOP_ACTION || !source ||
        !uuid(source.clientTaskId) || source.controlTaskId !== source.clientTaskId ||
        !uuid(source.clientAttemptId) || !uuid(source.cloudCommandId) ||
        !integer(source.attemptNumber) || source.attemptNumber < 1 || !integer(source.progressSeq) ||
        !timestamp(source.sourceUpdatedAt) || source.status !== 'running' ||
        !['xiaohongshu', 'douyin'].includes(source.platform)) return null;
    return Object.freeze(source);
  } catch { return null; }
}
export function validateActiveStopRequest(body) { return captureRequest(body) !== null; }

function present(value) {
  if (value === undefined || value === null || value === '' || value === false || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (record(value)) return Object.keys(value).length > 0;
  return true;
}
function hasOtherLineage(value) {
  if (!record(value)) return false;
  return ['parentTaskId', 'parentRequestId', 'recoveryTaskId', 'previousAttemptId',
    'resumeCommandId', 'stopCommandId', 'orchestration', 'orchestrationContext', 'orchestrationChild',
    'orchestrationRevision', 'itemIds', 'itemAttempts', 'recoveryAdoption', 'recoveryAdoptionReceipt',
    'localRecoveryAdoption', 'adoptionReceipt', 'localClosure', 'localClosures',
    'localClosureEvidence', 'localClosureEvidences', 'handoffSuccessorTaskId']
    .some(key => present(value[key]));
}
function identityValid(identity) {
  return record(identity) && ['tenant_id', 'agent_id', 'auth_code_id', 'auth_binding_id', 'token_id']
    .every(key => uuid(identity[key])) &&
    ['token_created_at', 'agent_updated_at', 'bound_at'].every(key => iso(identity[key])) &&
    (identity.expires_at === null || Boolean(iso(identity.expires_at)));
}
function evidenceMatches(source, identity, evidence) {
  const {task, attempt, snapshot, command} = evidence || {};
  if (![task, attempt, snapshot, command].every(record) ||
      evidence.attempt_conflict !== false || evidence.command_conflict !== false || evidence.successor_conflict !== false ||
      !uuid(task.id) || !uuid(attempt.id) || !integer(snapshot.id) || snapshot.id < 1 ||
      !/^[a-f0-9]{64}$/u.test(snapshot.snapshot_fingerprint)) return false;
  for (const row of [task, snapshot]) {
    if (row.tenant_id !== identity.tenant_id || row.status !== source.status ||
        row.task_type !== 'unattended_keyword_capture' || row.platform !== source.platform ||
        row.client_task_id !== source.clientTaskId || row.control_task_id !== source.controlTaskId ||
        row.attempt_number !== source.attemptNumber || row.progress_seq !== source.progressSeq ||
        iso(row.source_updated_at) !== source.sourceUpdatedAt || row.finished_at !== null ||
        !record(row.metadata) || row.metadata.cloudAssigned !== true ||
        row.metadata.cloudAgentScopeId !== identity.agent_id || row.metadata.cloudCommandId !== source.cloudCommandId ||
        hasOtherLineage(row.metadata)) return false;
  }
  if (task.origin_agent_id !== identity.agent_id || task.assigned_agent_id !== identity.agent_id ||
      task.parent_task_id !== null || snapshot.task_id !== task.id || snapshot.agent_id !== identity.agent_id ||
      snapshot.attempt_id !== attempt.id || snapshot.client_attempt_id !== source.clientAttemptId ||
      attempt.tenant_id !== identity.tenant_id || attempt.agent_id !== identity.agent_id || attempt.task_id !== task.id ||
      attempt.client_attempt_id !== source.clientAttemptId || attempt.attempt_number !== source.attemptNumber ||
      attempt.progress_seq !== source.progressSeq || attempt.status !== source.status || attempt.finished_at !== null) return false;
  const payload = command.payload;
  if (command.id !== source.cloudCommandId || command.task_id !== task.id || command.tenant_id !== identity.tenant_id ||
      command.agent_id !== identity.agent_id || command.command_type !== 'create' || command.status !== 'completed' ||
      !iso(command.finished_at) || task.metadata.createCommandId !== command.id || !record(payload) ||
      payload.taskId !== task.id || payload.clientTaskId !== source.clientTaskId ||
      payload.authCodeId !== identity.auth_code_id || payload.authBindingId !== identity.auth_binding_id ||
      hasOtherLineage(payload) || present(payload.checkpoint)) return false;
  const plan = payload.planSnapshot;
  // The original server create command establishes provenance; a mirrored
  // cloudAssigned flag alone cannot authorize this source. Safety errors and
  // unsynced results do not prevent stopping and are never cleared here.
  return record(plan) && plan.platform === source.platform && Array.isArray(plan.keywords) &&
    plan.keywords.length > 0 && plan.keywords.length <= 30 &&
    plan.keywords.every(keyword => typeof keyword === 'string' && keyword.trim() === keyword &&
      keyword.length > 0 && keyword.length <= 120) && new Set(plan.keywords).size === plan.keywords.length &&
    integer(plan.maxRounds) && plan.maxRounds > 0 && typeof plan.autoLoop === 'boolean' &&
    plan.autoLoop === (plan.maxRounds > 1);
}
function deny(reason) {
  return {ok: false, action: ACTIVE_STOP_ACTION, decision: 'deny', reason, policyVersion: ACTIVE_STOP_POLICY_VERSION};
}

export async function evaluateActiveStopAuthority({token, body}, {readOne = queryOne, now = Date.now} = {}) {
  const source = captureRequest(body);
  if (!source) return deny('invalid_control_target');
  if (typeof token !== 'string' || token.length < 1 || token.length > 512 || /\s|[\u0000-\u001f\u007f]/u.test(token)) {
    return deny('invalid_agent_token');
  }
  const startedAt = now();
  if (!integer(startedAt)) return deny('authority_expired');
  const row = await readOne(ACTIVE_STOP_AUTHORITY_SQL, [hashCaptureAgentToken(token), source.clientTaskId,
    source.controlTaskId, source.clientAttemptId, source.attemptNumber, source.progressSeq,
    source.sourceUpdatedAt, source.cloudCommandId]);
  if (!identityValid(row?.identity)) return deny('agent_entitlement_unavailable');
  if (!Array.isArray(row.evidence) || row.evidence.length !== 1 || !evidenceMatches(source, row.identity, row.evidence[0])) {
    return deny('active_source_unproven');
  }
  const evaluatedAt = iso(row.evaluated_at);
  const checkedAt = now();
  if (!integer(checkedAt) || checkedAt < startedAt || !evaluatedAt ||
      Date.parse(evaluatedAt) > checkedAt || Date.parse(source.sourceUpdatedAt) > Date.parse(evaluatedAt)) {
    return deny('active_source_unproven');
  }
  const entitlementExpiry = row.identity.expires_at === null ? Infinity : Date.parse(iso(row.identity.expires_at));
  const expiresAt = Math.min(startedAt + ACTIVE_STOP_WINDOW_MS,
    Date.parse(evaluatedAt) + ACTIVE_STOP_WINDOW_MS, entitlementExpiry);
  if (!Number.isSafeInteger(expiresAt) || checkedAt >= expiresAt) return deny('authority_expired');
  const {task, attempt, snapshot, command} = row.evidence[0];
  const authorityRevision = createHash('sha256').update(JSON.stringify({policy: ACTIVE_STOP_POLICY_VERSION,
    identity: row.identity, task, attempt, snapshot, command})).digest('hex');
  return {ok: true, action: ACTIVE_STOP_ACTION, decision: 'allow', reason: 'active_stop_authorized',
    policyVersion: ACTIVE_STOP_POLICY_VERSION, authorityRevision,
    tenantId: row.identity.tenant_id, agentId: row.identity.agent_id,
    authCodeId: row.identity.auth_code_id, authBindingId: row.identity.auth_binding_id,
    source: {...source, serverTaskId: task.id, serverAttemptId: attempt.id,
      snapshotId: String(snapshot.id), snapshotFingerprint: snapshot.snapshot_fingerprint},
    evaluatedAt, expiresAt: new Date(expiresAt).toISOString()};
}
