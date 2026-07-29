import { createHash } from 'node:crypto';

import { execute, getSetting, queryAll, queryOne, withTransaction } from '../db/init.js';
import { callDeepSeekWithPrompt, getBrandContext, getDeepSeekConfig } from './ai-labeler.js';
import {
  formatMonitoringIntentForPrompt,
  resolveMonitoringIntent,
} from './monitoring-intent.js';

export const PREFILTER_PROMPT_VERSION = 'prefilter-list-v2';
export const PREFILTER_PROVIDER = 'deepseek';
export const PREFILTER_MAX_LIST_BATCH = 40;
export const PREFILTER_MIN_SKIP_THRESHOLD = 0.97;
export const PREFILTER_DEFAULT_MODEL_TIMEOUT_MS = 15000;
export const PREFILTER_DEFAULT_TENANT_CONCURRENCY = 6;

const VALID_PLATFORMS = new Set(['xiaohongshu', 'douyin']);
const VALID_MODES = new Set(['disabled', 'shadow', 'conservative']);
const VALID_DECISIONS = new Set(['keep', 'skip', 'need_detail']);
const MODE_RANK = { disabled: 0, shadow: 1, conservative: 2 };
const activeTenantCalls = new Map();

export class PrefilterRequestError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'PrefilterRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function boundedText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function boundedStringArray(value, { maxItems = 20, maxLength = 100 } = {}) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of value) {
    const item = boundedText(raw, maxLength);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

export function normalizePrefilterKeyword(value) {
  return boundedText(value, 200)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizePlatform(value) {
  const raw = boundedText(value, 40).toLowerCase();
  if (['xhs', 'red', '小红书'].includes(raw)) return 'xiaohongshu';
  if (['dy', '抖音'].includes(raw)) return 'douyin';
  return raw;
}

function normalizeMode(value, fallback = 'shadow') {
  const mode = boundedText(value, 30).toLowerCase();
  return VALID_MODES.has(mode) ? mode : fallback;
}

function normalizeIntent(raw, keywordHash) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    intentId: boundedText(source.intentId, 200) || `keyword:${keywordHash.slice(0, 24)}`,
    intentVersion: Number.isInteger(Number(source.intentVersion)) && Number(source.intentVersion) > 0
      ? Number(source.intentVersion)
      : 1,
    objective: boundedText(source.objective, 80),
    targetEntity: boundedStringArray(source.targetEntity, { maxItems: 20, maxLength: 80 }),
    targetContent: boundedStringArray(source.targetContent, { maxItems: 20, maxLength: 80 }),
    exclusions: boundedStringArray(source.exclusions, { maxItems: 30, maxLength: 100 }),
    notes: boundedText(source.notes, 500),
  };
}

function sanitizeListItem(raw, index) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const itemId = boundedText(source.itemId, 256);
  const item = {
    itemId,
    externalId: boundedText(source.externalId, 256),
    title: boundedText(source.title, 500),
    author: boundedText(source.author, 200),
    noteType: boundedText(source.noteType, 40),
    publishTime: boundedText(source.publishTime, 100),
  };
  if (!item.externalId && itemId.includes(':')) item.externalId = itemId.slice(itemId.indexOf(':') + 1);
  item.inputValid = Boolean(item.title || item.author);
  item.inputError = item.inputValid ? '' : `第 ${index + 1} 项缺少可判断的标题和作者`;
  return item;
}

export function validatePrefilterRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'INVALID_REQUEST', message: '请求体必须是 JSON 对象' };
  }
  const requestId = boundedText(body.requestId, 200);
  const idempotencyKey = boundedText(body.idempotencyKey, 512);
  const platform = normalizePlatform(body.platform);
  const stage = boundedText(body.stage || 'list', 20).toLowerCase();
  const keyword = normalizePrefilterKeyword(body.keyword);
  const requestedPromptVersion = boundedText(body.promptVersion || PREFILTER_PROMPT_VERSION, 100);
  const requestedModeRaw = boundedText(body.mode || 'shadow', 30).toLowerCase();

  if (!requestId) return { ok: false, status: 400, error: 'REQUEST_ID_REQUIRED', message: '缺少 requestId' };
  if (!idempotencyKey) return { ok: false, status: 400, error: 'IDEMPOTENCY_KEY_REQUIRED', message: '缺少 idempotencyKey' };
  if (!VALID_PLATFORMS.has(platform)) return { ok: false, status: 422, error: 'INVALID_PLATFORM', message: '仅支持小红书和抖音' };
  if (stage !== 'list') return { ok: false, status: 422, error: 'UNSUPPORTED_STAGE', message: '第一期仅支持 list 文字判断' };
  if (!keyword) return { ok: false, status: 422, error: 'KEYWORD_REQUIRED', message: '缺少搜索关键词' };
  if (!['prefilter-list-v1', PREFILTER_PROMPT_VERSION].includes(requestedPromptVersion)) {
    return { ok: false, status: 409, error: 'PROMPT_VERSION_CONFLICT', message: '前置筛选提示词版本不匹配' };
  }
  const promptVersion = PREFILTER_PROMPT_VERSION;
  if (!VALID_MODES.has(requestedModeRaw)) {
    return { ok: false, status: 422, error: 'INVALID_MODE', message: '筛选模式无效' };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { ok: false, status: 400, error: 'ITEMS_REQUIRED', message: 'items 不能为空' };
  }
  if (body.items.length > PREFILTER_MAX_LIST_BATCH) {
    return { ok: false, status: 413, error: 'BATCH_TOO_LARGE', message: `列表批次最多 ${PREFILTER_MAX_LIST_BATCH} 条` };
  }

  const items = body.items.map(sanitizeListItem);
  if (items.some(item => !item.itemId)) {
    return { ok: false, status: 422, error: 'ITEM_ID_REQUIRED', message: '每一项都必须提供 itemId' };
  }
  const uniqueItemIds = new Set(items.map(item => item.itemId));
  if (uniqueItemIds.size !== items.length) {
    return { ok: false, status: 422, error: 'DUPLICATE_ITEM_ID', message: '同一批次不能包含重复 itemId' };
  }

  const requestedThreshold = body.skipThreshold === undefined || body.skipThreshold === null || body.skipThreshold === ''
    ? PREFILTER_MIN_SKIP_THRESHOLD
    : Number(body.skipThreshold);
  if (!Number.isFinite(requestedThreshold) || requestedThreshold < 0 || requestedThreshold > 1) {
    return { ok: false, status: 422, error: 'INVALID_SKIP_THRESHOLD', message: '跳过阈值必须在 0 到 1 之间' };
  }

  const keywordHash = sha256(keyword);
  const intent = normalizeIntent({ ...(body.intent || {}), intentVersion: body.intentVersion || body.intent?.intentVersion }, keywordHash);
  return {
    ok: true,
    value: {
      requestId,
      idempotencyKey,
      taskId: boundedText(body.taskId, 200),
      runId: boundedText(body.runId, 200),
      keywordRunId: boundedText(body.keywordRunId, 200),
      platform,
      stage,
      keyword,
      keywordHash,
      promptVersion,
      mode: requestedModeRaw,
      requestedThreshold: Math.max(PREFILTER_MIN_SKIP_THRESHOLD, requestedThreshold),
      intent,
      items,
    },
  };
}

export function prefilterRequestBodyHash(request) {
  return sha256(stableStringify({
    taskId: request.taskId,
    runId: request.runId,
    keywordRunId: request.keywordRunId,
    platform: request.platform,
    stage: request.stage,
    keyword: request.keyword,
    promptVersion: request.promptVersion,
    mode: request.mode,
    requestedThreshold: request.requestedThreshold,
    intent: request.intent,
    items: request.items.map(({ inputValid: _inputValid, inputError: _inputError, ...item }) => item),
  }));
}

export function contentSummaryHash(item) {
  return sha256(stableStringify({
    title: item.title,
    author: item.author,
    noteType: item.noteType,
    publishTime: item.publishTime,
  }));
}

export function prefilterCacheKey(request, item, model) {
  return sha256(stableStringify({
    platform: request.platform,
    stage: request.stage,
    normalizedKeywordHash: request.keywordHash,
    intentId: request.intent.intentId,
    intentVersion: request.intent.intentVersion,
    externalId: item.externalId || item.itemId,
    contentSummaryHash: contentSummaryHash(item),
    promptVersion: request.promptVersion,
    modelProvider: PREFILTER_PROVIDER,
    modelName: model,
  }));
}

function safestMode(...modes) {
  return modes
    .map(mode => normalizeMode(mode, 'shadow'))
    .sort((left, right) => MODE_RANK[left] - MODE_RANK[right])[0] || 'shadow';
}

export function resolvePrefilterPolicyValues({
  requestedMode = 'shadow',
  requestedThreshold = PREFILTER_MIN_SKIP_THRESHOLD,
  tenantMode = 'conservative',
  tenantThreshold = PREFILTER_MIN_SKIP_THRESHOLD,
  serverMode = 'conservative',
} = {}) {
  const numericTenantThreshold = Number(tenantThreshold);
  const effectiveThreshold = Math.min(1, Math.max(
    PREFILTER_MIN_SKIP_THRESHOLD,
    Number.isFinite(Number(requestedThreshold)) ? Number(requestedThreshold) : PREFILTER_MIN_SKIP_THRESHOLD,
    Number.isFinite(numericTenantThreshold) ? numericTenantThreshold : PREFILTER_MIN_SKIP_THRESHOLD
  ));
  return {
    effectiveMode: safestMode(serverMode, tenantMode, requestedMode),
    skipThreshold: effectiveThreshold,
  };
}

async function resolvePrefilterPolicy(tenantId, request) {
  const [tenantMode, tenantThreshold] = await Promise.all([
    getSetting('relevance_prefilter_mode', tenantId),
    getSetting('relevance_prefilter_skip_threshold', tenantId),
  ]);
  return resolvePrefilterPolicyValues({
    requestedMode: request.mode,
    requestedThreshold: request.requestedThreshold,
    tenantMode: tenantMode || 'conservative',
    tenantThreshold: tenantThreshold || PREFILTER_MIN_SKIP_THRESHOLD,
    serverMode: process.env.PREFILTER_SERVER_MODE || 'conservative',
  });
}

export function determineExecutionDisposition({ status, modelDecision, confidence }, policy) {
  if (status !== 'ok') return 'collect_full';
  if (policy.effectiveMode !== 'conservative') return 'collect_full';
  if (modelDecision === 'skip' && confidence >= policy.skipThreshold) return 'skip_full_capture';
  return 'collect_full';
}

export function buildPrefilterSystemPrompt(brand = {}, intent = {}) {
  return `你是采集前的查询意图相关性筛选器。你不是在做宽泛的品牌舆情判断，而是在判断每条搜索结果是否符合用户本次搜索词的具体意图。

租户品牌：${brand.brandName || '未配置'}
品牌别名：${(brand.brandAliases || []).join('、') || '无'}
业务语境：${brand.businessContext || '无'}
品牌相关词：${(brand.positiveContextTerms || []).join('、') || '无'}
常见噪声：${(brand.noiseTerms || []).join('、') || '无'}

${formatMonitoringIntentForPrompt(intent)}

对每一项只允许三种决定：
- keep：现有列表文字已经足以确认符合本次查询意图；
- skip：现有列表文字已经足以确认不符合本次查询意图；
- need_detail：可能相关但证据不足，需要正文、标签、画面或口播才能判断。

规则：
1. 不要因为内容提到了品牌、车型、搜索词、话题标签或作者名就自动 keep，必须同时符合任务的目标对象和目标主题。
2. 人名、地名、谐音、其它品牌、泛词巧合命中应 skip。
3. 标题是兜底标题、只有封面可能含证据、视频依赖画面或口播时必须 need_detail。
4. 证据不足时必须 need_detail，禁止为了提高跳过率猜测。
5. 每个输入 itemId 必须恰好输出一次；不得输出未知 itemId。
6. 只输出 JSON 对象，不要 Markdown 或解释性前后缀。
7. confidence 表示你对当前决定的确定程度，不是相关度分数。若标题已经明确指向其它汽车品牌/产品，且目标品牌或目标实体完全缺失，这是可由列表文字直接证实的无关项，decision=skip，confidence 应为 0.98-1.00。
8. 只有部分词相似、可能需要画面/口播/正文才能排除，或仍存在合理相关解释时，不得用高置信 skip，必须输出 need_detail，confidence 不高于 0.96。
9. 关联品牌的其它车辆话题不属于当前功能任务。例如“别克OTA”不包含别克机械故障，“至境哨兵”不包含至境胎噪，“凯迪拉克壁纸”不包含凯迪拉克碰撞测试。

输出格式：
{"items":[{"itemId":"原值","decision":"keep|skip|need_detail","queryMatch":0.0,"brandMatch":0.0,"confidence":0.0,"reason":"简短中文原因","evidence":["证据"],"missingSignals":["缺失证据"]}]}`;
}

export function buildPrefilterUserMessage(request) {
  return JSON.stringify({
    keyword: request.keyword,
    platform: request.platform,
    stage: request.stage,
    intent: request.intent,
    items: request.items
      .filter(item => item.inputValid)
      .map(({ itemId, title, author, noteType, publishTime }) => ({ itemId, title, author, noteType, publishTime })),
  });
}

function normalizeScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) return null;
  return Math.round(score * 10000) / 10000;
}

function failOpenItem(item, status, reason, policy) {
  const result = {
    itemId: item.itemId,
    status,
    modelDecision: null,
    decisionFinality: 'provisional',
    queryMatch: null,
    brandMatch: null,
    confidence: null,
    reason: boundedText(reason, 1000) || 'AI 判断不可用，已按安全策略继续采集',
    evidence: [],
    missingSignals: [],
    executionDisposition: 'collect_full',
    failOpen: true,
    cacheHit: false,
  };
  result.executionDisposition = determineExecutionDisposition(result, policy);
  return result;
}

function normalizeOneModelItem(item, raw, policy) {
  const decision = boundedText(raw?.decision || raw?.modelDecision, 30).toLowerCase();
  const queryMatch = normalizeScore(raw?.queryMatch ?? raw?.query_match);
  const brandMatch = normalizeScore(raw?.brandMatch ?? raw?.brand_match);
  const confidence = normalizeScore(raw?.confidence);
  const reason = boundedText(raw?.reason, 1000);
  if (!VALID_DECISIONS.has(decision) || queryMatch === null || brandMatch === null || confidence === null || !reason) {
    return failOpenItem(item, 'model_error', 'DeepSeek 返回字段不完整，已按安全策略继续采集', policy);
  }
  const result = {
    itemId: item.itemId,
    status: 'ok',
    modelDecision: decision,
    decisionFinality: 'provisional',
    queryMatch,
    brandMatch,
    confidence,
    reason,
    evidence: boundedStringArray(raw?.evidence, { maxItems: 10, maxLength: 120 }),
    missingSignals: boundedStringArray(raw?.missingSignals ?? raw?.missing_signals, { maxItems: 10, maxLength: 120 }),
    executionDisposition: 'collect_full',
    failOpen: false,
    cacheHit: false,
  };
  result.executionDisposition = determineExecutionDisposition(result, policy);
  return result;
}

export function normalizePrefilterModelResponse(request, rawResponse, policy) {
  const rawItems = Array.isArray(rawResponse?.items) ? rawResponse.items : [];
  const requestedIds = new Set(request.items.map(item => item.itemId));
  const byId = new Map();
  let unknownOutputCount = 0;
  for (const raw of rawItems) {
    const itemId = boundedText(raw?.itemId, 256);
    if (!requestedIds.has(itemId)) {
      unknownOutputCount += 1;
      continue;
    }
    const existing = byId.get(itemId) || [];
    existing.push(raw);
    byId.set(itemId, existing);
  }

  const items = request.items.map(item => {
    if (!item.inputValid) return failOpenItem(item, 'invalid_input', item.inputError, policy);
    const matches = byId.get(item.itemId) || [];
    if (matches.length !== 1) {
      const reason = matches.length > 1
        ? 'DeepSeek 为同一 itemId 返回了重复结果，已按安全策略继续采集'
        : 'DeepSeek 未返回该 itemId，已按安全策略继续采集';
      return failOpenItem(item, 'model_error', reason, policy);
    }
    return normalizeOneModelItem(item, matches[0], policy);
  });

  return {
    items,
    degraded: unknownOutputCount > 0 || items.some(item => item.status !== 'ok'),
    unknownOutputCount,
  };
}

async function loadCachedPrefilterItems(tenantId, request, model, policy) {
  const candidates = request.items.filter(item => item.inputValid);
  if (candidates.length === 0) return new Map();
  const keyToItem = new Map(candidates.map(item => [prefilterCacheKey(request, item, model), item]));
  const rows = await queryAll(`
    SELECT cache_key, response_item
    FROM relevance_prefilter_cache
    WHERE tenant_id = $1
      AND cache_key = ANY($2::text[])
      AND expires_at > now()
  `, [tenantId, [...keyToItem.keys()]]);
  const cached = new Map();
  for (const row of rows) {
    const sourceItem = keyToItem.get(row.cache_key);
    if (!sourceItem) continue;
    const normalized = normalizeOneModelItem(sourceItem, row.response_item, policy);
    if (normalized.status !== 'ok') continue;
    normalized.cacheHit = true;
    cached.set(sourceItem.itemId, normalized);
  }
  return cached;
}

function allFailOpenItems(request, status, reason, policy) {
  return request.items.map(item => failOpenItem(
    item,
    item.inputValid ? status : 'invalid_input',
    item.inputValid ? reason : item.inputError,
    policy
  ));
}

function isTimeoutError(error) {
  const text = `${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return text.includes('timeout') || text.includes('abort');
}

function modelTimeoutMs() {
  const configured = Number(process.env.PREFILTER_MODEL_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return PREFILTER_DEFAULT_MODEL_TIMEOUT_MS;
  return Math.max(1000, Math.min(15000, configured));
}

function maxTenantConcurrency() {
  const configured = Number(process.env.PREFILTER_TENANT_CONCURRENCY);
  return Number.isInteger(configured) && configured > 0
    ? Math.min(10, configured)
    : PREFILTER_DEFAULT_TENANT_CONCURRENCY;
}

function acquireTenantSlot(tenantId) {
  const active = activeTenantCalls.get(tenantId) || 0;
  if (active >= maxTenantConcurrency()) {
    throw new PrefilterRequestError(429, 'PREFILTER_CONCURRENCY_LIMIT', 'AI 判断请求较多，本批请直接安全放行', { retryAfterMs: 1000 });
  }
  activeTenantCalls.set(tenantId, active + 1);
}

function releaseTenantSlot(tenantId) {
  const active = activeTenantCalls.get(tenantId) || 0;
  if (active <= 1) activeTenantCalls.delete(tenantId);
  else activeTenantCalls.set(tenantId, active - 1);
}

async function assertDailyQuota(tenantId, itemCount) {
  const configured = Number(await getSetting('relevance_prefilter_daily_item_limit', tenantId));
  const fallback = Number(process.env.PREFILTER_DAILY_ITEM_LIMIT || 5000);
  const limit = Number.isFinite(configured) && configured > 0 ? configured : fallback;
  if (!Number.isFinite(limit) || limit <= 0) return;
  const row = await queryOne(`
    SELECT COUNT(*)::int AS count
    FROM relevance_prefilter_decisions
    WHERE tenant_id = $1 AND created_at >= date_trunc('day', now())
  `, [tenantId]);
  if (Number(row?.count || 0) + itemCount > limit) {
    throw new PrefilterRequestError(429, 'PREFILTER_DAILY_LIMIT', '今日 AI 前置判断额度已用完，本批请直接安全放行');
  }
}

async function findIdempotentRequest(tenantId, request, bodyHash) {
  const existing = await queryOne(`
    SELECT id, request_body_hash, status, response_body, created_at, updated_at
    FROM relevance_prefilter_requests
    WHERE tenant_id = $1 AND idempotency_key = $2
  `, [tenantId, request.idempotencyKey]);
  if (!existing) return null;
  if (existing.request_body_hash !== bodyHash) {
    throw new PrefilterRequestError(409, 'IDEMPOTENCY_CONFLICT', '相同幂等键对应了不同请求内容');
  }
  if (existing.status === 'completed' && existing.response_body) {
    return { kind: 'replay', id: existing.id, response: { ...existing.response_body, idempotentReplay: true } };
  }
  const lastTouched = new Date(existing.updated_at || existing.created_at || 0).getTime();
  if (existing.status === 'failed' || (Number.isFinite(lastTouched) && Date.now() - lastTouched > 60000)) {
    return { kind: 'retryable', id: existing.id };
  }
  throw new PrefilterRequestError(409, 'IDEMPOTENCY_IN_PROGRESS', '相同请求正在处理，请勿阻塞采集主流程', { retryAfterMs: 500 });
}

async function reservePrefilterRequest(tenantId, request, bodyHash) {
  const existing = await findIdempotentRequest(tenantId, request, bodyHash);
  if (existing?.kind === 'replay') return existing;
  if (existing?.kind === 'retryable') {
    await execute(`
      UPDATE relevance_prefilter_requests
      SET request_id = $3, status = 'running', response_body = NULL, updated_at = now()
      WHERE id = $1 AND tenant_id = $2
    `, [existing.id, tenantId, request.requestId]);
    return { kind: 'reserved', id: existing.id };
  }
  const inserted = await execute(`
    INSERT INTO relevance_prefilter_requests (
      tenant_id, request_id, idempotency_key, request_body_hash, status, model_provider
    ) VALUES ($1, $2, $3, $4, 'running', 'deepseek')
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    RETURNING id
  `, [tenantId, request.requestId, request.idempotencyKey, bodyHash]);
  const id = inserted.rows?.[0]?.id;
  if (id) return { kind: 'reserved', id };
  return await findIdempotentRequest(tenantId, request, bodyHash);
}

async function persistPrefilterOutcome({ tenantId, prefilterRequestId, request, response, model }) {
  await withTransaction(async tx => {
    for (const [index, result] of response.items.entries()) {
      const sourceItem = request.items[index];
      await tx.execute(`
        INSERT INTO relevance_prefilter_decisions (
          tenant_id, prefilter_request_id, request_id,
          task_id, run_id, keyword_run_id, platform, stage,
          item_id, external_id, keyword, item_title_excerpt, item_author_excerpt,
          normalized_keyword_hash, content_summary_hash,
          intent_id, intent_version, prompt_version, model_provider, model_name,
          server_model_status, model_decision, decision_finality, execution_disposition,
          query_match, brand_match, confidence, reason, evidence, missing_signals,
          effective_mode, skip_threshold, latency_ms, cache_hit, metadata
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15,
          $16, $17, $18, 'deepseek', $19,
          $20, $21, $22, $23,
          $24, $25, $26, $27, $28::jsonb, $29::jsonb,
          $30, $31, $32, $33, $34::jsonb
        )
        ON CONFLICT (tenant_id, prefilter_request_id, item_id) DO NOTHING
      `, [
        tenantId,
        prefilterRequestId,
        request.requestId,
        request.taskId,
        request.runId,
        request.keywordRunId,
        request.platform,
        request.stage,
        sourceItem.itemId,
        sourceItem.externalId,
        request.keyword,
        sourceItem.title,
        sourceItem.author,
        request.keywordHash,
        contentSummaryHash(sourceItem),
        request.intent.intentId,
        request.intent.intentVersion,
        request.promptVersion,
        model,
        result.status,
        result.modelDecision,
        result.decisionFinality,
        result.executionDisposition,
        result.queryMatch,
        result.brandMatch,
        result.confidence,
        result.reason,
        JSON.stringify(result.evidence || []),
        JSON.stringify(result.missingSignals || []),
        response.effectiveMode,
        response.skipThreshold,
        response.latencyMs,
        Boolean(result.cacheHit),
        JSON.stringify({ failOpen: result.failOpen, itemIndex: index }),
      ]);
      if (result.status === 'ok' && !result.cacheHit) {
        await tx.execute(`
          INSERT INTO relevance_prefilter_cache (
            tenant_id, cache_key, platform, stage,
            normalized_keyword_hash, content_summary_hash,
            intent_id, intent_version, prompt_version,
            model_provider, model_name, response_item, expires_at
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6,
            $7, $8, $9,
            'deepseek', $10, $11::jsonb, now() + interval '14 days'
          )
          ON CONFLICT (tenant_id, cache_key)
          DO UPDATE SET
            response_item = excluded.response_item,
            created_at = now(),
            expires_at = excluded.expires_at
        `, [
          tenantId,
          prefilterCacheKey(request, sourceItem, model),
          request.platform,
          request.stage,
          request.keywordHash,
          contentSummaryHash(sourceItem),
          request.intent.intentId,
          request.intent.intentVersion,
          request.promptVersion,
          model,
          JSON.stringify(result),
        ]);
      }
    }
    await tx.execute(`
      UPDATE relevance_prefilter_requests
      SET status = 'completed', model_name = $3, response_body = $4::jsonb, updated_at = now()
      WHERE id = $1 AND tenant_id = $2
    `, [prefilterRequestId, tenantId, model, JSON.stringify(response)]);
  });
}

async function markPrefilterRequestFailed(tenantId, prefilterRequestId) {
  try {
    await execute(`
      UPDATE relevance_prefilter_requests
      SET status = 'failed', updated_at = now()
      WHERE id = $1 AND tenant_id = $2
    `, [prefilterRequestId, tenantId]);
  } catch (error) {
    console.error('[RelevancePrefilter] Failed to mark request as failed:', error?.message || error);
  }
}

export async function prefilterRelevanceBatch({ tenantId, body }) {
  const validation = validatePrefilterRequest(body);
  if (!validation.ok) {
    throw new PrefilterRequestError(validation.status, validation.error, validation.message);
  }
  const brand = await getBrandContext(tenantId);
  const request = {
    ...validation.value,
    intent: resolveMonitoringIntent(validation.value.keyword, {
      brand,
      fallbackIntent: validation.value.intent,
    }),
  };
  const bodyHash = prefilterRequestBodyHash(request);
  const existing = await findIdempotentRequest(tenantId, request, bodyHash);
  if (existing?.kind === 'replay') return existing.response;

  acquireTenantSlot(tenantId);
  try {
    await assertDailyQuota(tenantId, request.items.length);
    const policy = await resolvePrefilterPolicy(tenantId, request);
    const reservation = await reservePrefilterRequest(tenantId, request, bodyHash);
    if (reservation.kind === 'replay') return reservation.response;
    const startedAt = Date.now();
    let model = 'deepseek-chat';
    let items;
    let degraded = false;
    let unknownOutputCount = 0;

    if (policy.effectiveMode === 'disabled') {
      degraded = true;
      items = allFailOpenItems(request, 'model_error', 'AI 前置筛选已由服务端关闭，已继续原采集流程', policy);
    } else {
      try {
        const deepSeekConfig = await getDeepSeekConfig(tenantId);
        model = deepSeekConfig.model;
        const cached = await loadCachedPrefilterItems(tenantId, request, model, policy);
        const pendingItems = request.items.filter(item => item.inputValid && !cached.has(item.itemId));
        const pendingResults = new Map();
        if (pendingItems.length > 0) {
          const pendingRequest = { ...request, items: pendingItems };
          try {
            const result = await callDeepSeekWithPrompt(
              tenantId,
              buildPrefilterSystemPrompt(brand, request.intent),
              buildPrefilterUserMessage(pendingRequest),
              {
                timeoutMs: modelTimeoutMs(),
                maxTokens: Math.min(8192, Math.max(1200, pendingItems.length * 180)),
                returnMetadata: true,
              }
            );
            model = result.model;
            const normalized = normalizePrefilterModelResponse(pendingRequest, result.data, policy);
            for (const item of normalized.items) pendingResults.set(item.itemId, item);
            unknownOutputCount = normalized.unknownOutputCount;
          } catch (error) {
            const timedOut = isTimeoutError(error);
            const failed = allFailOpenItems(
              pendingRequest,
              timedOut ? 'timeout' : 'model_error',
              timedOut
                ? 'DeepSeek 判断超时，已按安全策略继续采集'
                : `DeepSeek 判断不可用，已按安全策略继续采集：${boundedText(error?.message, 300)}`,
              policy
            );
            for (const item of failed) pendingResults.set(item.itemId, item);
          }
        }
        items = request.items.map(item => {
          if (!item.inputValid) return failOpenItem(item, 'invalid_input', item.inputError, policy);
          return cached.get(item.itemId)
            || pendingResults.get(item.itemId)
            || failOpenItem(item, 'model_error', 'DeepSeek 未返回该项目，已继续原采集流程', policy);
        });
        degraded = unknownOutputCount > 0 || items.some(item => item.status !== 'ok');
      } catch (error) {
        const timedOut = isTimeoutError(error);
        degraded = true;
        items = allFailOpenItems(
          request,
          timedOut ? 'timeout' : 'model_error',
          timedOut
            ? 'DeepSeek 判断超时，已按安全策略继续采集'
            : `DeepSeek 判断不可用，已按安全策略继续采集：${boundedText(error?.message, 300)}`,
          policy
        );
      }
    }

    const response = {
      ok: true,
      degraded,
      requestId: request.requestId,
      intentId: request.intent.intentId,
      intentVersion: request.intent.intentVersion,
      intent: request.intent,
      promptVersion: request.promptVersion,
      provider: PREFILTER_PROVIDER,
      model,
      latencyMs: Date.now() - startedAt,
      effectiveMode: policy.effectiveMode,
      skipThreshold: policy.skipThreshold,
      unknownOutputCount,
      cacheHitCount: items.filter(item => item.cacheHit).length,
      idempotentReplay: false,
      items,
    };
    try {
      await persistPrefilterOutcome({
        tenantId,
        prefilterRequestId: reservation.id,
        request,
        response,
        model,
      });
    } catch (error) {
      await markPrefilterRequestFailed(tenantId, reservation.id);
      throw error;
    }
    return response;
  } finally {
    releaseTenantSlot(tenantId);
  }
}
