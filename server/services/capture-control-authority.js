import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {queryOne} from '../db/query.js';
import {hashCaptureAgentToken} from './capture-cloud.js';

export const TERMINAL_CONTROL_ACTION = 'dismiss_terminal_recovery_metadata';
export const TERMINAL_CONTROL_POLICY_VERSION = 'terminal-recovery-metadata-v1';
export const TERMINAL_CONTROL_WINDOW_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COUNT_KEYS = ['total', 'processed', 'saved', 'success', 'failed', 'skipped', 'retried', 'warnings'];
const RESULT_KEYS = ['round', 'index', 'keyword', 'status', 'attemptCount', 'savedCount', 'finishedAt'];
const SOURCE_KEYS = ['clientTaskId', 'controlTaskId', 'clientAttemptId', 'attemptNumber', 'progressSeq', 'sourceUpdatedAt', 'finishedAt', 'cloudCommandId', 'platform', 'settlement'];
const TERMINAL = 'completed_with_failures';

// One statement gives token entitlement and target evidence the same MVCC view.
// No verification, heartbeat, receipt, row/advisory lock or write is performed.
export const TERMINAL_CONTROL_AUTHORITY_SQL = `
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
        AND other.task_id = task.id AND other.id <> command.id
        AND other.status IN ('pending', 'acknowledged')
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
    AND task.source_updated_at = $7::timestamptz AND task.status = 'completed_with_failures'
  JOIN capture_task_attempts attempt ON attempt.task_id = task.id
    AND attempt.tenant_id = identity.tenant_id AND attempt.agent_id = identity.agent_id
    AND attempt.client_attempt_id = $4 AND attempt.attempt_number = task.attempt_number
    AND attempt.progress_seq = task.progress_seq AND attempt.status = task.status
  JOIN capture_task_snapshots snapshot ON snapshot.task_id = task.id
    AND snapshot.tenant_id = identity.tenant_id AND snapshot.agent_id = identity.agent_id
    AND snapshot.attempt_id = attempt.id AND snapshot.client_attempt_id = attempt.client_attempt_id
    AND snapshot.client_task_id = task.client_task_id AND snapshot.control_task_id = task.control_task_id
    AND snapshot.attempt_number = task.attempt_number AND snapshot.progress_seq = task.progress_seq
    AND snapshot.source_updated_at = task.source_updated_at AND snapshot.status = task.status
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

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}
function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function timestamp(value) {
  return typeof value === 'string' && value.length <= 32 &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function iso(value) {
  if (value === null || value === undefined) return '';
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}
function pick(source, keys) {
  return Object.fromEntries(keys.map(key => [key, source?.[key]]));
}

export function validateTerminalControlRequest(body) {
  if (!exactKeys(body, ['action', 'source']) || body.action !== TERMINAL_CONTROL_ACTION) return false;
  const source = body.source;
  if (!exactKeys(source, SOURCE_KEYS) || !UUID.test(source.clientTaskId) ||
      source.controlTaskId !== source.clientTaskId || !UUID.test(source.clientAttemptId) ||
      !UUID.test(source.cloudCommandId) || !integer(source.attemptNumber) || source.attemptNumber < 1 ||
      !integer(source.progressSeq) || !timestamp(source.sourceUpdatedAt) || !timestamp(source.finishedAt) ||
      Date.parse(source.finishedAt) > Date.parse(source.sourceUpdatedAt) ||
      !['xiaohongshu', 'douyin'].includes(source.platform)) return false;
  const facts = source.settlement;
  if (!exactKeys(facts, ['counts', 'progress', 'keywordResults']) ||
      !exactKeys(facts.counts, COUNT_KEYS) || !COUNT_KEYS.every(key => integer(facts.counts[key])) ||
      !exactKeys(facts.progress, ['phase', 'current', 'total']) ||
      facts.progress.phase !== 'unattended_completed_with_failures' ||
      !Array.isArray(facts.keywordResults) || facts.keywordResults.length < 1 || facts.keywordResults.length > 200) return false;
  const counts = facts.counts;
  if (counts.total !== facts.keywordResults.length || counts.processed !== counts.total ||
      counts.total !== counts.success + counts.failed + counts.skipped + counts.warnings ||
      counts.failed + counts.warnings < 1 || facts.progress.current !== counts.total || facts.progress.total !== counts.total) return false;
  const seen = new Set();
  const calculated = {completed: 0, failed: 0, partial: 0, skipped: 0, saved: 0, retried: 0};
  for (const result of facts.keywordResults) {
    if (!exactKeys(result, RESULT_KEYS) || !integer(result.round) || result.round < 1 || !integer(result.index) ||
        typeof result.keyword !== 'string' || result.keyword.length < 1 || result.keyword.length > 120 ||
        result.keyword.trim() !== result.keyword || !['completed', 'failed', 'partial', 'skipped'].includes(result.status) ||
        !integer(result.attemptCount) || result.attemptCount < 1 || !integer(result.savedCount) || !timestamp(result.finishedAt) ||
        Date.parse(result.finishedAt) > Date.parse(source.finishedAt)) return false;
    const key = `${result.round}:${result.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    calculated[result.status] += 1;
    calculated.saved += result.savedCount;
    calculated.retried += Math.max(0, result.attemptCount - 1);
  }
  return counts.success === calculated.completed && counts.failed === calculated.failed &&
    counts.warnings === calculated.partial && counts.skipped === calculated.skipped && counts.saved === calculated.saved &&
    counts.retried === calculated.retried;
}

function unsafeEvidence(value, key = '', depth = 0) {
  if (depth > 12) return true;
  const normalized = key.replaceAll('_', '').toLowerCase();
  if (/reconcil|securityblocked|platformsafetyblocked|requiresmanualaction|manualactionrequired|recoverypendinglaunch|stoppending|closurepending|adoption|^handoff|^successor/u.test(normalized)) {
    if (![false, null, '', 0].includes(value)) return true;
  }
  if (/securityevidence/u.test(normalized) && value?.confirmed === true) return true;
  if (/^(?:code|errorcode|reason|errorcategory|category|status|phase)$/u.test(normalized) &&
      typeof value === 'string' && /captcha|verification|security|platform_safety|needs_action|reconcil|stale|stop_pending|adoption/u.test(value.toLowerCase())) return true;
  if (Array.isArray(value)) return value.some(item => unsafeEvidence(item, '', depth + 1));
  if (object(value)) return Object.entries(value).some(([childKey, child]) => unsafeEvidence(child, childKey, depth + 1));
  return typeof value === 'string' && ['[TRUNCATED]', '[object Object]'].includes(value);
}

function projectedSettlement(row) {
  if (!object(row?.counts) || !object(row?.progress) || !Array.isArray(row?.checkpoint?.keywordResults)) return null;
  return {
    counts: pick(row.counts, COUNT_KEYS),
    progress: pick(row.progress, ['phase', 'current', 'total']),
    keywordResults: row.checkpoint.keywordResults.map(result => pick(result, RESULT_KEYS)),
  };
}

function evidenceMatches(source, identity, evidence) {
  const {task, attempt, snapshot, command} = evidence;
  if (!object(task) || !object(attempt) || !object(snapshot) || !object(command) ||
      evidence.attempt_conflict !== false || evidence.command_conflict !== false || evidence.successor_conflict !== false ||
      !UUID.test(task.id) || !UUID.test(attempt.id) || !Number.isSafeInteger(snapshot.id) || snapshot.id < 1 ||
      !/^[a-f0-9]{64}$/u.test(snapshot.snapshot_fingerprint)) return false;
  for (const row of [task, snapshot]) {
    if (row.status !== TERMINAL || row.task_type !== 'unattended_keyword_capture' || row.platform !== source.platform ||
        row.client_task_id !== source.clientTaskId || row.control_task_id !== source.controlTaskId ||
        row.attempt_number !== source.attemptNumber || row.progress_seq !== source.progressSeq ||
        iso(row.source_updated_at) !== source.sourceUpdatedAt || iso(row.finished_at) !== source.finishedAt ||
        !isDeepStrictEqual(projectedSettlement(row), source.settlement) || unsafeEvidence(row)) return false;
  }
  if (attempt.client_attempt_id !== source.clientAttemptId || attempt.status !== TERMINAL ||
      iso(attempt.finished_at) !== source.finishedAt ||
      !isDeepStrictEqual(pick(attempt.progress, ['phase', 'current', 'total']), source.settlement.progress) ||
      !isDeepStrictEqual(attempt.checkpoint?.keywordResults?.map(result => pick(result, RESULT_KEYS)), source.settlement.keywordResults) ||
      unsafeEvidence(attempt)) return false;
  const payload = command.payload;
  if (command.id !== source.cloudCommandId || command.status !== 'completed' || command.command_type !== 'create' ||
      payload?.authCodeId !== identity.auth_code_id || payload?.authBindingId !== identity.auth_binding_id ||
      payload?.clientTaskId !== source.clientTaskId || payload?.taskId !== task.id ||
      task.metadata?.createCommandId !== command.id || snapshot.metadata?.cloudCommandId !== command.id ||
      task.metadata?.cloudCommandId !== command.id || snapshot.client_attempt_id !== source.clientAttemptId ||
      snapshot.attempt_id !== attempt.id || !iso(command.finished_at) || unsafeEvidence(command)) return false;
  // First profile is an ordinary, non-orchestrated keyword plan. A server-side
  // create plan proves the complete expected work set instead of accepting a
  // self-reported smaller terminal total. Sequential search is a later profile.
  const plan = payload.planSnapshot;
  if (!object(plan) || payload.orchestration || task.parent_task_id || task.metadata?.parentTaskId ||
      task.metadata?.parentRequestId || task.metadata?.recoveryTaskId || task.metadata?.resumeCommandId ||
      task.metadata?.stopCommandId || task.metadata?.localClosure || task.metadata?.localClosures?.length ||
      payload.checkpoint || plan.sequentialSearchEnabled === true || (plan.searchPasses?.length || 0) > 1 ||
      !Array.isArray(plan.keywords) || plan.keywords.length < 1 || plan.keywords.length > 30 ||
      new Set(plan.keywords).size !== plan.keywords.length || plan.platform !== source.platform ||
      !integer(plan.maxRounds) || plan.maxRounds < 1 || plan.autoLoop === true) return false;
  const results = source.settlement.keywordResults;
  if (plan.keywords.length * plan.maxRounds !== results.length) return false;
  const expected = new Set();
  for (let round = 1; round <= plan.maxRounds; round += 1) {
    for (let index = 0; index < plan.keywords.length; index += 1) expected.add(`${round}:${index}:${plan.keywords[index]}`);
  }
  return results.every(result => expected.delete(`${result.round}:${result.index}:${result.keyword}`)) && expected.size === 0;
}

function deny(reason) {
  return {ok: false, action: TERMINAL_CONTROL_ACTION, decision: 'deny', reason, policyVersion: TERMINAL_CONTROL_POLICY_VERSION};
}

export async function evaluateTerminalControlAuthority({token, body}, {readOne = queryOne, now = Date.now} = {}) {
  if (!validateTerminalControlRequest(body)) return deny('invalid_control_target');
  if (typeof token !== 'string' || token.length < 1 || token.length > 512) return deny('invalid_agent_token');
  const startedAt = now();
  const source = body.source;
  const row = await readOne(TERMINAL_CONTROL_AUTHORITY_SQL, [hashCaptureAgentToken(token), source.clientTaskId,
    source.controlTaskId, source.clientAttemptId, source.attemptNumber, source.progressSeq,
    source.sourceUpdatedAt, source.cloudCommandId]);
  if (!row?.identity) return deny('agent_entitlement_unavailable');
  if (!Array.isArray(row.evidence) || row.evidence.length !== 1 || !evidenceMatches(source, row.identity, row.evidence[0])) {
    return deny('terminal_source_unproven');
  }
  const evaluatedAt = iso(row.evaluated_at);
  if (!evaluatedAt || Date.parse(source.sourceUpdatedAt) > Date.parse(evaluatedAt)) return deny('terminal_source_unproven');
  const expiry = row.identity.expires_at === null ? Infinity : Date.parse(iso(row.identity.expires_at));
  const expiresAt = Math.min(startedAt + TERMINAL_CONTROL_WINDOW_MS, Date.parse(evaluatedAt) + TERMINAL_CONTROL_WINDOW_MS, expiry);
  if (!Number.isFinite(expiresAt) || now() >= expiresAt) return deny('authority_expired');
  const {task, attempt, snapshot, command} = row.evidence[0];
  const authorityRevision = createHash('sha256').update(JSON.stringify({policy: TERMINAL_CONTROL_POLICY_VERSION,
    identity: row.identity, task, attempt, snapshot, command})).digest('hex');
  const {settlement: _settlement, ...identitySource} = source;
  return {ok: true, action: TERMINAL_CONTROL_ACTION, decision: 'allow', reason: 'terminal_metadata_authorized',
    policyVersion: TERMINAL_CONTROL_POLICY_VERSION, authorityRevision,
    tenantId: row.identity.tenant_id, agentId: row.identity.agent_id,
    authCodeId: row.identity.auth_code_id, authBindingId: row.identity.auth_binding_id,
    source: {...identitySource, serverTaskId: task.id, serverAttemptId: attempt.id,
      snapshotId: String(snapshot.id), snapshotFingerprint: snapshot.snapshot_fingerprint},
    evaluatedAt, expiresAt: new Date(expiresAt).toISOString()};
}
