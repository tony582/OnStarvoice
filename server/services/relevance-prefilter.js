import { createHash } from 'node:crypto';

import { execute, getSetting, queryAll, queryOne, withTransaction } from '../db/init.js';
import {
  callRelevancePrefilterWithPrompt,
  getBrandContext,
  getRelevancePrefilterCacheRoutes,
  getRelevancePrefilterLLMConfig,
} from './ai-labeler.js';
import {
  formatMonitoringIntentForPrompt,
  formatTenantMonitoringScopeForPrompt,
  resolveMonitoringIntent,
  resolveTenantMonitoringScope,
} from './monitoring-intent.js';

export const PREFILTER_PROMPT_VERSION = 'prefilter-list-v3';
export const PREFILTER_PROVIDER = 'deepseek';
export const PREFILTER_MAX_LIST_BATCH = 40;
export const PREFILTER_MIN_SKIP_THRESHOLD = 0.97;
export const PREFILTER_MAX_TENANT_SKIP_MATCH = 0.2;
export const PREFILTER_DEFAULT_MODEL_TIMEOUT_MS = 20000;
export const PREFILTER_DEFAULT_QUEUE_TIMEOUT_MS = 5000;

const VALID_PLATFORMS = new Set(['xiaohongshu', 'douyin']);
const VALID_MODES = new Set(['disabled', 'shadow', 'conservative']);
const VALID_DECISIONS = new Set(['keep', 'skip', 'need_detail']);
const VALID_TENANT_RELEVANCE = new Set(['relevant', 'irrelevant', 'uncertain']);
const MODE_RANK = { disabled: 0, shadow: 1, conservative: 2 };
const PROTECTED_MONITORING_SIGNAL_PATTERN = /(?:安吉星|onstar|紧急(?:救援|求助)|道路救援|\bsos\b|远程(?:启动|控制|解锁|上锁|空调)?.{0,8}(?:失败|失效|不能|无法|用不了|没反应|故障|异常)|客服.{0,8}(?:投诉|误导|不处理|不解决)|续费.{0,8}(?:投诉|误导|收费|争议|贵|坑|不续)|一生黑)/iu;

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
  if (!['prefilter-list-v1', 'prefilter-list-v2', PREFILTER_PROMPT_VERSION].includes(requestedPromptVersion)) {
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

export function prefilterCacheKey(
  request,
  item,
  model,
  provider = PREFILTER_PROVIDER,
) {
  return sha256(stableStringify({
    platform: request.platform,
    stage: request.stage,
    normalizedKeywordHash: request.keywordHash,
    intentId: request.intent.intentId,
    intentVersion: request.intent.intentVersion,
    externalId: item.externalId || item.itemId,
    contentSummaryHash: contentSummaryHash(item),
    promptVersion: request.promptVersion,
    modelProvider: provider,
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

export function hasProtectedMonitoringSignal(item = {}) {
  return PROTECTED_MONITORING_SIGNAL_PATTERN.test(`${item.title || ''} ${item.author || ''}`);
}

export function determineExecutionDisposition({
  status,
  modelDecision,
  tenantRelevance,
  brandMatch,
  confidence,
  protectedSignal = false,
}, policy) {
  if (status !== 'ok') return 'collect_full';
  if (policy.effectiveMode !== 'conservative') return 'collect_full';
  if (protectedSignal) return 'collect_full';
  if (
    modelDecision === 'skip'
    && tenantRelevance === 'irrelevant'
    && Number(brandMatch) <= PREFILTER_MAX_TENANT_SKIP_MATCH
    && confidence >= policy.skipThreshold
  ) return 'skip_full_capture';
  return 'collect_full';
}

export function buildPrefilterSystemPrompt(
  brand = {},
  intent = {},
  tenantScope = resolveTenantMonitoringScope(brand),
) {
  return `你是采集前的双维度相关性筛选器。你必须分别判断“当前搜索词是否匹配”和“是否属于租户整体监控范围”，两者不能互相覆盖。

租户品牌：${brand.brandName || '未配置'}
品牌别名：${(brand.brandAliases || []).join('、') || '无'}
业务语境：${brand.businessContext || '无'}
品牌相关词：${(brand.positiveContextTerms || []).join('、') || '无'}
常见噪声：${(brand.noiseTerms || []).join('、') || '无'}

${formatTenantMonitoringScopeForPrompt(tenantScope)}

${formatMonitoringIntentForPrompt(intent)}

对每一项只允许三种决定：
- keep：现有列表文字已经足以确认符合本次搜索词；
- skip：现有列表文字已经足以确认不符合本次搜索词；
- need_detail：可能匹配本次搜索词，但证据不足，需要正文、标签、画面或口播才能判断。

同时必须输出 tenantRelevance：
- relevant：即使不匹配当前搜索词，仍明确属于租户整体监控对象与主题；
- irrelevant：明确不属于全部监测关键词、对象和主题；
- uncertain：列表文字不足以排除整体相关性，需要完整内容。

规则：
1. decision 只表示 currentKeywordMatch；tenantRelevance 表示租户整体相关性。decision=skip 绝不等于 tenantRelevance=irrelevant。
2. 判断当前搜索词时仍须同时符合其目标对象和目标主题，不能因为只出现品牌、车型或搜索词就自动 keep。
3. 内容命中任一其它监测关键词或主题时，即使当前 decision=skip，tenantRelevance 也必须是 relevant 或 uncertain。
4. 安吉星、紧急/道路救援、远程控制故障、客服投诉、续费争议等风险线索必须保守采集，不得仅因当前搜索词不匹配而判整体无关。
5. 人名、地名、谐音、租户范围外的其它品牌、泛词巧合命中可判 decision=skip 且 tenantRelevance=irrelevant。
6. 标题是兜底标题、只有封面可能含证据、视频依赖画面或口播时必须 need_detail，tenantRelevance 至少 uncertain。
7. 证据不足时必须 need_detail，禁止为了提高跳过率猜测。
8. 每个输入 itemId 必须恰好输出一次；不得输出未知 itemId。
9. 只输出 JSON 对象，不要 Markdown 或解释性前后缀。
10. confidence 表示你对 decision 和 tenantRelevance 组合的确定程度，不是相关度分数。
11. queryMatch 是当前搜索词匹配分；brandMatch 是租户整体监控范围匹配分，不是当前关键词目标品牌分。
12. “凯迪拉克CT5紧急救援电话误拨”对“凯迪拉克车机升级”可 decision=skip，但属于安全救援监测，必须 tenantRelevance=relevant 并完整采集。

输出格式：
{"items":[{"itemId":"原值","decision":"keep|skip|need_detail","tenantRelevance":"relevant|irrelevant|uncertain","queryMatch":0.0,"brandMatch":0.0,"confidence":0.0,"reason":"同时说明当前词匹配和整体相关性的简短中文原因","evidence":["证据"],"missingSignals":["缺失证据"]}]}`;
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
    tenantRelevance: null,
    decisionFinality: 'provisional',
    queryMatch: null,
    brandMatch: null,
    confidence: null,
    reason: boundedText(reason, 1000) || 'AI 判断不可用，已按安全策略继续采集',
    evidence: [],
    missingSignals: [],
    executionDisposition: 'collect_full',
    failOpen: true,
    protectedSignal: hasProtectedMonitoringSignal(item),
    cacheHit: false,
  };
  result.executionDisposition = determineExecutionDisposition(result, policy);
  return result;
}

function normalizeOneModelItem(item, raw, policy) {
  const decision = boundedText(raw?.decision || raw?.modelDecision, 30).toLowerCase();
  const tenantRelevance = boundedText(
    raw?.tenantRelevance ?? raw?.tenant_relevance,
    30,
  ).toLowerCase();
  const queryMatch = normalizeScore(raw?.queryMatch ?? raw?.query_match);
  const brandMatch = normalizeScore(raw?.brandMatch ?? raw?.brand_match);
  const confidence = normalizeScore(raw?.confidence);
  const reason = boundedText(raw?.reason, 1000);
  if (
    !VALID_DECISIONS.has(decision)
    || !VALID_TENANT_RELEVANCE.has(tenantRelevance)
    || queryMatch === null
    || brandMatch === null
    || confidence === null
    || !reason
  ) {
    return failOpenItem(item, 'model_error', 'AI 返回字段不完整，已按安全策略继续采集', policy);
  }
  const protectedSignal = hasProtectedMonitoringSignal(item);
  const result = {
    itemId: item.itemId,
    status: 'ok',
    modelDecision: decision,
    tenantRelevance,
    decisionFinality: 'provisional',
    queryMatch,
    brandMatch,
    confidence,
    protectedSignal,
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
        ? 'AI 为同一 itemId 返回了重复结果，已按安全策略继续采集'
        : 'AI 未返回该 itemId，已按安全策略继续采集';
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

async function loadCachedPrefilterItems(
  tenantId,
  request,
  routes,
  policy,
) {
  const candidates = request.items.filter(item => item.inputValid);
  const normalizedRoutes = Array.isArray(routes)
    ? routes.filter(route => route?.provider && route?.model)
    : [];
  if (candidates.length === 0 || normalizedRoutes.length === 0) {
    return {items: new Map(), firstRoute: null};
  }
  const candidateKeys = new Map(candidates.map(item => [
    item.itemId,
    normalizedRoutes.map(route => ({
      cacheKey: prefilterCacheKey(request, item, route.model, route.provider),
      route,
    })),
  ]));
  const allKeys = [...candidateKeys.values()].flat().map(entry => entry.cacheKey);
  const rows = await queryAll(`
    SELECT cache_key, response_item
    FROM relevance_prefilter_cache
    WHERE tenant_id = $1
      AND cache_key = ANY($2::text[])
      AND expires_at > now()
  `, [tenantId, allKeys]);
  const rowsByKey = new Map(rows.map(row => [row.cache_key, row.response_item]));
  const cached = new Map();
  let firstRoute = null;
  for (const sourceItem of candidates) {
    const keys = candidateKeys.get(sourceItem.itemId) || [];
    for (const entry of keys) {
      const responseItem = rowsByKey.get(entry.cacheKey);
      if (!responseItem) continue;
      const normalized = normalizeOneModelItem(sourceItem, responseItem, policy);
      if (normalized.status !== 'ok') continue;
      normalized.cacheHit = true;
      cached.set(sourceItem.itemId, normalized);
      firstRoute ||= entry.route;
      break;
    }
  }
  return {items: cached, firstRoute};
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
  return Math.max(1000, Math.min(40000, configured));
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

async function persistPrefilterOutcome({
  tenantId,
  prefilterRequestId,
  request,
  response,
  provider,
  model,
}) {
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
          $16, $17, $18, $19, $20,
          $21, $22, $23, $24,
          $25, $26, $27, $28, $29::jsonb, $30::jsonb,
          $31, $32, $33, $34, $35::jsonb
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
        provider,
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
        JSON.stringify({
          failOpen: result.failOpen,
          itemIndex: index,
          tenantRelevance: result.tenantRelevance || null,
          protectedSignal: Boolean(result.protectedSignal),
        }),
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
            $10, $11, $12::jsonb, now() + interval '14 days'
          )
          ON CONFLICT (tenant_id, cache_key)
          DO UPDATE SET
            response_item = excluded.response_item,
            created_at = now(),
            expires_at = excluded.expires_at
        `, [
          tenantId,
          prefilterCacheKey(request, sourceItem, model, provider),
          request.platform,
          request.stage,
          request.keywordHash,
          contentSummaryHash(sourceItem),
          request.intent.intentId,
          request.intent.intentVersion,
          request.promptVersion,
          provider,
          model,
          JSON.stringify(result),
        ]);
      }
    }
    await tx.execute(`
      UPDATE relevance_prefilter_requests
      SET status = 'completed', model_provider = $3, model_name = $4,
          response_body = $5::jsonb, updated_at = now()
      WHERE id = $1 AND tenant_id = $2
    `, [prefilterRequestId, tenantId, provider, model, JSON.stringify(response)]);
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
  const tenantScope = resolveTenantMonitoringScope(brand);
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

    await assertDailyQuota(tenantId, request.items.length);
    const policy = await resolvePrefilterPolicy(tenantId, request);
    const reservation = await reservePrefilterRequest(tenantId, request, bodyHash);
    if (reservation.kind === 'replay') return reservation.response;
    const startedAt = Date.now();
    let provider = PREFILTER_PROVIDER;
    let model = 'deepseek-chat';
    let items;
    let degraded = false;
    let unknownOutputCount = 0;
    let modelDiagnostics = {};

    if (policy.effectiveMode === 'disabled') {
      degraded = true;
      items = allFailOpenItems(request, 'model_error', 'AI 前置筛选已由服务端关闭，已继续原采集流程', policy);
    } else {
      try {
        const llmConfig = await getRelevancePrefilterLLMConfig(tenantId);
        const cacheRoutes = await getRelevancePrefilterCacheRoutes(tenantId, llmConfig);
        provider = cacheRoutes[0]?.provider || llmConfig.provider;
        model = cacheRoutes[0]?.model || llmConfig.model;
        const cacheResult = await loadCachedPrefilterItems(
          tenantId,
          request,
          cacheRoutes,
          policy,
        );
        const cached = cacheResult.items;
        if (cacheResult.firstRoute) {
          provider = cacheResult.firstRoute.provider;
          model = cacheResult.firstRoute.model;
        }
        const pendingItems = request.items.filter(item => item.inputValid && !cached.has(item.itemId));
        const pendingResults = new Map();
        if (pendingItems.length > 0) {
          const pendingRequest = { ...request, items: pendingItems };
          try {
            const baseMaxTokens = Math.min(
              4096,
              Math.max(1800, pendingItems.length * 320),
            );
            const result = await callRelevancePrefilterWithPrompt(
              tenantId,
              buildPrefilterSystemPrompt(brand, request.intent, tenantScope),
              buildPrefilterUserMessage(pendingRequest),
              {
                timeoutMs: modelTimeoutMs(),
                queueTimeoutMs: PREFILTER_DEFAULT_QUEUE_TIMEOUT_MS,
                maxTokens: baseMaxTokens,
                returnMetadata: true,
                priority: 'capture',
                kind: 'relevance_prefilter',
              },
            );
            if (!result) {
              const error = new Error('AI 未返回可用的结构化结果');
              error.code = 'LLM_EMPTY_RESULT';
              throw error;
            }
            if (result.finishReason === 'length') {
              const error = new Error('AI 结构化结果被截断，已安全放行');
              error.code = 'LLM_OUTPUT_TRUNCATED';
              error.finishReason = result.finishReason;
              error.responseLength = result.responseLength;
              throw error;
            }
            provider = result.provider || provider;
            model = result.model;
            modelDiagnostics = {
              route: result.route || (result.provider === 'antigravity' ? 'relay' : 'base'),
              finishReason: result.finishReason || '',
              responseLength: Math.max(0, Number(result.responseLength) || 0),
              promptTokens: Math.max(0, Number(result.promptTokens) || 0),
              completionTokens: Math.max(0, Number(result.completionTokens) || 0),
              totalTokens: Math.max(0, Number(result.totalTokens) || 0),
              reasoningTokens: Math.max(0, Number(result.reasoningTokens) || 0),
              retryCount: 0,
              thinkingEnabled: false,
            };
            const normalized = normalizePrefilterModelResponse(pendingRequest, result.data, policy);
            for (const item of normalized.items) pendingResults.set(item.itemId, item);
            unknownOutputCount = normalized.unknownOutputCount;
          } catch (error) {
            console.warn('[RelevancePrefilter] Model output unavailable', {
              tenantId,
              code: boundedText(error?.code, 100),
              finishReason: boundedText(error?.finishReason, 40),
              responseLength: Math.max(0, Number(error?.responseLength) || 0),
            });
            const timedOut = isTimeoutError(error);
            const failed = allFailOpenItems(
              pendingRequest,
              timedOut ? 'timeout' : 'model_error',
              timedOut
                ? 'AI 判断超时，已按安全策略继续采集'
                : `AI 判断不可用，已按安全策略继续采集：${boundedText(error?.message, 300)}`,
              policy
            );
            for (const item of failed) pendingResults.set(item.itemId, item);
          }
        }
        items = request.items.map(item => {
          if (!item.inputValid) return failOpenItem(item, 'invalid_input', item.inputError, policy);
          return cached.get(item.itemId)
            || pendingResults.get(item.itemId)
            || failOpenItem(item, 'model_error', 'AI 未返回该项目，已继续原采集流程', policy);
        });
        degraded = unknownOutputCount > 0 || items.some(item => item.status !== 'ok');
      } catch (error) {
        const timedOut = isTimeoutError(error);
        degraded = true;
        items = allFailOpenItems(
          request,
          timedOut ? 'timeout' : 'model_error',
          timedOut
            ? 'AI 判断超时，已按安全策略继续采集'
            : `AI 判断不可用，已按安全策略继续采集：${boundedText(error?.message, 300)}`,
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
      tenantScope: {
        scopeId: tenantScope.scopeId,
        scopeVersion: tenantScope.scopeVersion,
        keywords: tenantScope.keywords,
      },
      promptVersion: request.promptVersion,
      provider,
      model,
      latencyMs: Date.now() - startedAt,
      effectiveMode: policy.effectiveMode,
      skipThreshold: policy.skipThreshold,
      unknownOutputCount,
      modelDiagnostics,
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
        provider,
        model,
      });
    } catch (error) {
      await markPrefilterRequestFailed(tenantId, reservation.id);
      throw error;
    }
    return response;
}
