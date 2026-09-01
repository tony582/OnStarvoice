import crypto from 'node:crypto';

import { execute, queryOne, withTransaction } from '../db/init.js';
import { sanitizeLlmRelayRequestOptions } from './llm-relay.js';

export const LLM_RELAY_AGENT_ONLINE_MS = 15_000;
export const LLM_RELAY_JOB_TIMEOUT_MS = 40_000;
export const LLM_RELAY_LEASE_MS = 45_000;
const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 200;

function relayError(code, message, status = 503) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function createLlmRelayAgentToken() {
  return `svai_${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashLlmRelayAgentToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createLeaseToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function assertPlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw relayError(code, message, 400);
  }
  return value;
}

export function validateLlmRelayJobInput(input = {}) {
  const tenantId = String(input.tenantId || '').trim();
  const model = String(input.model || '').trim();
  const systemPrompt = String(input.systemPrompt || '');
  const userMessage = String(input.userMessage || '');
  if (!tenantId) throw relayError('LLM_RELAY_TENANT_REQUIRED', '缺少 AI 租户', 400);
  if (!/^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(model)) {
    throw relayError('LLM_RELAY_MODEL_INVALID', '本机 AI 模型名称不合法', 400);
  }
  if (!userMessage.trim()) {
    throw relayError('LLM_RELAY_PROMPT_REQUIRED', '本机 AI 请求内容为空', 400);
  }
  if (utf8Bytes(systemPrompt) + utf8Bytes(userMessage) > MAX_PROMPT_BYTES) {
    throw relayError('LLM_RELAY_PROMPT_TOO_LARGE', '本机 AI 请求内容过大', 413);
  }
  return {
    tenantId,
    model,
    systemPrompt,
    userMessage,
    requestOptions: sanitizeLlmRelayRequestOptions(input.requestOptions),
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cleanupExpiredRelayJobs() {
  await execute(`
    UPDATE llm_relay_jobs
    SET status = 'failed',
        error_code = 'LLM_RELAY_JOB_EXPIRED',
        error_message = '本机 AI 请求已过期',
        system_prompt = '',
        user_message = '',
        lease_token_hash = '',
        lease_expires_at = NULL,
        completed_at = now(),
        updated_at = now()
    WHERE status IN ('queued', 'leased') AND expires_at <= now()
  `);
  await execute(`
    DELETE FROM llm_relay_jobs
    WHERE status IN ('succeeded', 'failed', 'canceled')
      AND COALESCE(completed_at, created_at) < now() - interval '24 hours'
  `);
}

export async function requestLlmRelayAgentCompletion(input = {}) {
  const jobInput = validateLlmRelayJobInput(input);
  const timeoutMs = Math.max(
    5000,
    Math.min(LLM_RELAY_JOB_TIMEOUT_MS, Number(input.timeoutMs) || LLM_RELAY_JOB_TIMEOUT_MS),
  );
  await cleanupExpiredRelayJobs();

  const onlineAgent = await queryOne(`
    SELECT token.id
    FROM llm_relay_agent_tokens token
    JOIN tenants tenant ON tenant.id = token.tenant_id
    WHERE token.tenant_id = $1
      AND token.revoked_at IS NULL
      AND tenant.status = 'active'
      AND token.last_seen_at >= now() - ($2::int * interval '1 millisecond')
    ORDER BY token.last_seen_at DESC
    LIMIT 1
  `, [jobInput.tenantId, LLM_RELAY_AGENT_ONLINE_MS]);
  if (!onlineAgent) {
    throw relayError(
      'LLM_RELAY_AGENT_OFFLINE',
      '本机 Antigravity Agent 未在线，已切换备用 AI',
    );
  }

  const job = await withTransaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `llm-relay:${jobInput.tenantId}`,
    ]);
    const onlineCapacity = await tx.queryOne(`
      SELECT COUNT(*)::int AS count
      FROM llm_relay_agent_tokens
      WHERE tenant_id = $1
        AND revoked_at IS NULL
        AND last_seen_at >= now() - ($2::int * interval '1 millisecond')
    `, [jobInput.tenantId, LLM_RELAY_AGENT_ONLINE_MS]);
    const availableSlots = Number(onlineCapacity?.count || 0);
    if (availableSlots < 1) {
      throw relayError(
        'LLM_RELAY_AGENT_OFFLINE',
        '本机 Antigravity Agent 未在线，已切换备用 AI',
      );
    }
    const active = await tx.queryOne(`
      SELECT COUNT(*)::int AS count
      FROM llm_relay_jobs
      WHERE tenant_id = $1 AND status IN ('queued', 'leased') AND expires_at > now()
    `, [jobInput.tenantId]);
    // Each online token represents one sequential local Agent. Never build a
    // server-side backlog behind a busy Mac: overflow falls back to cloud now.
    if (Number(active?.count || 0) >= availableSlots) {
      throw relayError('LLM_RELAY_BUSY', '本机 AI 正忙，已立即切换云模型', 429);
    }
    return await tx.queryOne(`
      INSERT INTO llm_relay_jobs (
        tenant_id, model, system_prompt, user_message, request_options, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, now() + ($6::int * interval '1 millisecond')
      )
      RETURNING id
    `, [
      jobInput.tenantId,
      jobInput.model,
      jobInput.systemPrompt,
      jobInput.userMessage,
      JSON.stringify(jobInput.requestOptions),
      timeoutMs,
    ]);
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await queryOne(`
      SELECT status, result, error_code, error_message
      FROM llm_relay_jobs
      WHERE id = $1 AND tenant_id = $2
    `, [job.id, jobInput.tenantId]);
    if (!row) throw relayError('LLM_RELAY_JOB_MISSING', '本机 AI 请求不存在');
    if (row.status === 'succeeded') {
      return assertPlainObject(
        row.result,
        'LLM_RELAY_RESULT_INVALID',
        '本机 AI 返回格式不正确',
      );
    }
    if (['failed', 'canceled'].includes(row.status)) {
      throw relayError(
        row.error_code || 'LLM_RELAY_JOB_FAILED',
        row.error_message || '本机 AI 请求失败，已切换备用 AI',
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }

  await execute(`
    UPDATE llm_relay_jobs
    SET status = 'canceled',
        error_code = 'LLM_RELAY_JOB_TIMEOUT',
        error_message = '本机 AI 响应超时',
        system_prompt = '',
        user_message = '',
        lease_token_hash = '',
        lease_expires_at = NULL,
        completed_at = now(),
        updated_at = now()
    WHERE id = $1 AND tenant_id = $2 AND status IN ('queued', 'leased')
  `, [job.id, jobInput.tenantId]);
  throw relayError('LLM_RELAY_JOB_TIMEOUT', '本机 AI 响应超时，已切换备用 AI');
}

export async function heartbeatLlmRelayAgent(agent) {
  if (!agent?.id || !agent?.tenant_id) {
    throw relayError('LLM_RELAY_AGENT_INVALID', '本机 AI Agent 身份无效', 401);
  }
  const heartbeat = await queryOne(`
    UPDATE llm_relay_agent_tokens
    SET last_seen_at = now(), updated_at = now()
    WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
    RETURNING id, last_seen_at
  `, [agent.id, agent.tenant_id]);
  if (!heartbeat) {
    throw relayError('LLM_RELAY_AGENT_INVALID', '本机 AI Agent 已撤销', 401);
  }
  return heartbeat;
}

export async function claimNextLlmRelayJob(agent) {
  if (!agent?.id || !agent?.tenant_id) {
    throw relayError('LLM_RELAY_AGENT_INVALID', '本机 AI Agent 身份无效', 401);
  }
  await cleanupExpiredRelayJobs();
  return await withTransaction(async tx => {
    await tx.execute(`
      UPDATE llm_relay_agent_tokens
      SET last_seen_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
    `, [agent.id, agent.tenant_id]);
    await tx.execute(`
      UPDATE llm_relay_jobs
      SET status = CASE WHEN attempt_count >= $1 THEN 'failed' ELSE 'queued' END,
          error_code = CASE WHEN attempt_count >= $1 THEN 'LLM_RELAY_LEASE_EXHAUSTED' ELSE '' END,
          error_message = CASE WHEN attempt_count >= $1 THEN '本机 AI Agent 多次未完成请求' ELSE '' END,
          agent_token_id = NULL,
          lease_token_hash = '',
          lease_expires_at = NULL,
          completed_at = CASE WHEN attempt_count >= $1 THEN now() ELSE NULL END,
          system_prompt = CASE WHEN attempt_count >= $1 THEN '' ELSE system_prompt END,
          user_message = CASE WHEN attempt_count >= $1 THEN '' ELSE user_message END,
          updated_at = now()
      WHERE tenant_id = $2 AND status = 'leased' AND lease_expires_at <= now()
    `, [MAX_ATTEMPTS, agent.tenant_id]);

    const existingLease = await tx.queryOne(`
      SELECT id
      FROM llm_relay_jobs
      WHERE tenant_id = $1
        AND agent_token_id = $2
        AND status = 'leased'
        AND lease_expires_at > now()
      LIMIT 1
    `, [agent.tenant_id, agent.id]);
    if (existingLease) return null;

    const row = await tx.queryOne(`
      SELECT id, model, system_prompt, user_message, request_options, expires_at
      FROM llm_relay_jobs
      WHERE tenant_id = $1 AND status = 'queued' AND expires_at > now()
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `, [agent.tenant_id]);
    if (!row) return null;

    const leaseToken = createLeaseToken();
    const leased = await tx.queryOne(`
      UPDATE llm_relay_jobs
      SET status = 'leased',
          agent_token_id = $2,
          lease_token_hash = $3,
          lease_expires_at = now() + ($4::int * interval '1 millisecond'),
          leased_at = now(),
          attempt_count = attempt_count + 1,
          updated_at = now()
      WHERE id = $1 AND status = 'queued'
      RETURNING id, model, system_prompt, user_message, request_options, expires_at
    `, [row.id, agent.id, hashLlmRelayAgentToken(leaseToken), LLM_RELAY_LEASE_MS]);
    if (!leased) return null;
    return {
      id: leased.id,
      model: leased.model,
      systemPrompt: leased.system_prompt,
      userMessage: leased.user_message,
      requestOptions: leased.request_options || {},
      expiresAt: leased.expires_at,
      leaseToken,
    };
  });
}

export async function completeLlmRelayJob(agent, jobId, input = {}) {
  if (!agent?.id || !agent?.tenant_id) {
    throw relayError('LLM_RELAY_AGENT_INVALID', '本机 AI Agent 身份无效', 401);
  }
  const id = String(jobId || '').trim();
  const leaseToken = String(input.leaseToken || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw relayError('LLM_RELAY_JOB_ID_INVALID', '本机 AI 任务标识不合法', 400);
  }
  if (!leaseToken) {
    throw relayError('LLM_RELAY_LEASE_REQUIRED', '缺少本机 AI 任务租约', 400);
  }
  const success = input.success === true;
  let result = null;
  let errorCode = '';
  let errorMessage = '';
  if (success) {
    result = assertPlainObject(
      input.result,
      'LLM_RELAY_RESULT_INVALID',
      '本机 AI 返回值必须是 JSON 对象',
    );
    if (utf8Bytes(JSON.stringify(result)) > MAX_RESULT_BYTES) {
      throw relayError('LLM_RELAY_RESULT_TOO_LARGE', '本机 AI 返回内容过大', 413);
    }
  } else {
    errorCode = String(input.error?.code || 'LLM_RELAY_AGENT_ERROR').slice(0, 100);
    errorMessage = String(input.error?.message || '本机 AI 处理失败').slice(0, 1000);
  }

  const completed = await queryOne(`
    UPDATE llm_relay_jobs
    SET status = $5,
        result = $6::jsonb,
        error_code = $7,
        error_message = $8,
        system_prompt = '',
        user_message = '',
        lease_token_hash = '',
        lease_expires_at = NULL,
        completed_at = now(),
        updated_at = now()
    WHERE id = $1
      AND tenant_id = $2
      AND status = 'leased'
      AND agent_token_id = $3
      AND lease_token_hash = $4
      AND lease_expires_at > now()
      AND expires_at > now()
    RETURNING id, status
  `, [
    id,
    agent.tenant_id,
    agent.id,
    hashLlmRelayAgentToken(leaseToken),
    success ? 'succeeded' : 'failed',
    success ? JSON.stringify(result) : null,
    errorCode,
    errorMessage,
  ]);
  if (completed) return {id: completed.id, status: completed.status, duplicate: false};

  const current = await queryOne(`
    SELECT status
    FROM llm_relay_jobs
    WHERE id = $1 AND tenant_id = $2 AND agent_token_id = $3
  `, [id, agent.tenant_id, agent.id]);
  if (current && ['succeeded', 'failed', 'canceled'].includes(current.status)) {
    return {id, status: current.status, duplicate: true};
  }
  throw relayError('LLM_RELAY_LEASE_INVALID', '本机 AI 任务租约已失效', 409);
}
