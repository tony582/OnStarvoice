import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PREFILTER_DEFAULT_MODEL_TIMEOUT_MS,
  PREFILTER_DEFAULT_QUEUE_TIMEOUT_MS,
  PREFILTER_MAX_LIST_BATCH,
  PREFILTER_MAX_TENANT_SKIP_MATCH,
  PREFILTER_MIN_SKIP_THRESHOLD,
  PREFILTER_PROMPT_VERSION,
  buildPrefilterSystemPrompt,
  buildPrefilterUserMessage,
  determineExecutionDisposition,
  normalizePrefilterModelResponse,
  prefilterCacheKey,
  prefilterRequestBodyHash,
  resolvePrefilterPolicyValues,
  validatePrefilterRequest,
} from '../server/services/relevance-prefilter.js';
import {
  buildOpenAICompatibleRequestBody,
  resolvePurposeLLMConfigValues,
} from '../server/services/ai-labeler.js';
import { resolveMonitoringIntent } from '../server/services/monitoring-intent.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function source(path) {
  return readFile(resolve(repoRoot, path), 'utf8');
}

function validBody(overrides = {}) {
  return {
    requestId: 'req-1',
    idempotencyKey: 'task-1:run-1:keyword-1:list:1',
    taskId: 'task-1',
    runId: 'run-1',
    keywordRunId: 'keyword-1',
    platform: 'xiaohongshu',
    stage: 'list',
    keyword: ' 别克　壁纸 ',
    promptVersion: 'prefilter-list-v1',
    mode: 'conservative',
    intent: {
      intentId: 'intent-1',
      intentVersion: 1,
      targetEntity: ['别克汽车', 'Buick'],
      targetContent: ['壁纸', '屏保'],
    },
    items: [
      {
        itemId: 'xiaohongshu:a',
        externalId: 'a',
        title: '别克世纪高清车机壁纸',
        author: '别克车友',
        noteType: 'image',
        publishTime: '1天前',
      },
    ],
    ...overrides,
  };
}

test('list request validation is bounded, normalized and conservative-only for real skips', () => {
  const result = validatePrefilterRequest(validBody({ platform: '小红书', skipThreshold: 0.7 }));
  assert.equal(result.ok, true);
  assert.equal(result.value.platform, 'xiaohongshu');
  assert.equal(result.value.keyword, '别克 壁纸');
  assert.equal(result.value.promptVersion, PREFILTER_PROMPT_VERSION);
  assert.equal(result.value.requestedThreshold, PREFILTER_MIN_SKIP_THRESHOLD);
  assert.equal(result.value.mode, 'conservative');
  assert.equal(result.value.items[0].inputValid, true);

  const defaultMode = validatePrefilterRequest(validBody({ mode: undefined }));
  assert.equal(defaultMode.value.mode, 'shadow');
});

test('invalid batch shapes are rejected before any model call', () => {
  assert.equal(PREFILTER_MAX_LIST_BATCH, 40);
  assert.equal(PREFILTER_DEFAULT_MODEL_TIMEOUT_MS, 20000);
  assert.equal(PREFILTER_DEFAULT_QUEUE_TIMEOUT_MS, 5000);
  assert.equal(validatePrefilterRequest(validBody({ items: [] })).error, 'ITEMS_REQUIRED');
  assert.equal(
    validatePrefilterRequest(validBody({
      items: Array.from({ length: 41 }, (_, index) => ({ itemId: `douyin:${index}`, title: `标题${index}` })),
    })).error,
    'BATCH_TOO_LARGE',
  );
  assert.equal(
    validatePrefilterRequest(validBody({
      items: [{ itemId: 'same', title: 'A' }, { itemId: 'same', title: 'B' }],
    })).error,
    'DUPLICATE_ITEM_ID',
  );
  assert.equal(validatePrefilterRequest(validBody({ stage: 'detail' })).error, 'UNSUPPORTED_STAGE');
  assert.equal(validatePrefilterRequest(validBody({ promptVersion: 'prefilter-list-v0' })).error, 'PROMPT_VERSION_CONFLICT');
});

test('prefilter sends every configured provider only minimal list text', () => {
  const validation = validatePrefilterRequest(validBody({
    authCode: 'must-not-enter-prompt',
    items: [{
      itemId: 'douyin:a',
      title: '别克壁纸',
      author: '作者',
      content: '详情正文不应发送',
      coverUrl: 'https://private.example/cover',
      comments: [{ content: '评论不应发送' }],
    }],
  }));
  const message = buildPrefilterUserMessage(validation.value);
  assert.match(message, /别克壁纸/);
  assert.doesNotMatch(message, /must-not-enter-prompt|详情正文不应发送|private\.example|评论不应发送/);

  const prompt = buildPrefilterSystemPrompt(
    { brandName: '别克' },
    resolveMonitoringIntent('别克壁纸'),
  );
  assert.match(prompt, /keep\|skip\|need_detail/);
  assert.match(prompt, /双维度相关性筛选器/);
  assert.match(prompt, /全部监测关键词/);
  assert.match(prompt, /tenantRelevance/);
  assert.match(prompt, /目标对象：别克、Buick/);
  assert.match(prompt, /目标主题：车机壁纸、手机壁纸/);
  assert.match(prompt, /currentKeywordMatch/);
  assert.match(prompt, /凯迪拉克CT5紧急救援电话误拨/);
});

test('three-state normalization preserves partial success and fail-opens missing or invalid items', () => {
  const validation = validatePrefilterRequest(validBody({
    items: [
      { itemId: 'x:a', title: '大众壁纸', author: '车友' },
      { itemId: 'x:b', title: '别克壁纸', author: '车友' },
      { itemId: 'x:c', title: '', author: '' },
    ],
  }));
  assert.equal(validation.ok, true);
  const policy = resolvePrefilterPolicyValues({ requestedMode: 'conservative' });
  const normalized = normalizePrefilterModelResponse(validation.value, {
    items: [
      {
        itemId: 'x:a',
        decision: 'skip',
        tenantRelevance: 'irrelevant',
        queryMatch: 0.01,
        brandMatch: 0.02,
        confidence: 0.98,
        reason: '其它品牌壁纸',
        evidence: ['大众'],
        missingSignals: [],
      },
      { itemId: 'unknown', decision: 'skip', tenantRelevance: 'irrelevant', queryMatch: 0, brandMatch: 0, confidence: 1, reason: '未知项' },
    ],
  }, policy);

  assert.equal(normalized.items[0].status, 'ok');
  assert.equal(normalized.items[0].modelDecision, 'skip');
  assert.equal(normalized.items[0].executionDisposition, 'skip_full_capture');
  assert.equal(normalized.items[1].status, 'model_error');
  assert.equal(normalized.items[1].executionDisposition, 'collect_full');
  assert.equal(normalized.items[1].failOpen, true);
  assert.equal(normalized.items[2].status, 'invalid_input');
  assert.equal(normalized.items[2].executionDisposition, 'collect_full');
  assert.equal(normalized.unknownOutputCount, 1);
  assert.equal(normalized.degraded, true);
});

test('shadow mode and scores below 0.97 can never skip full capture', () => {
  const shadow = resolvePrefilterPolicyValues({ requestedMode: 'shadow' });
  assert.equal(shadow.effectiveMode, 'shadow');
  assert.equal(determineExecutionDisposition({ status: 'ok', modelDecision: 'skip', tenantRelevance: 'irrelevant', brandMatch: 0, confidence: 1 }, shadow), 'collect_full');

  const conservative = resolvePrefilterPolicyValues({ requestedMode: 'conservative', requestedThreshold: 0.97 });
  assert.equal(conservative.effectiveMode, 'conservative');
  assert.equal(determineExecutionDisposition({ status: 'ok', modelDecision: 'skip', tenantRelevance: 'irrelevant', brandMatch: 0, confidence: 0.9699 }, conservative), 'collect_full');
  assert.equal(determineExecutionDisposition({ status: 'model_error', modelDecision: 'skip', tenantRelevance: 'irrelevant', brandMatch: 0, confidence: 1 }, conservative), 'collect_full');
  assert.equal(determineExecutionDisposition({ status: 'ok', modelDecision: 'skip', tenantRelevance: 'irrelevant', brandMatch: 0, confidence: 0.97 }, conservative), 'skip_full_capture');
  assert.equal(PREFILTER_MAX_TENANT_SKIP_MATCH, 0.2);

  const serverShadow = resolvePrefilterPolicyValues({ requestedMode: 'conservative', serverMode: 'shadow' });
  assert.equal(serverShadow.effectiveMode, 'shadow');
});

test('tenant-relevant or protected incident results can never skip full capture', () => {
  const validation = validatePrefilterRequest(validBody({
    keyword: '凯迪拉克车机升级',
    items: [
      { itemId: 'ct5', title: '凯迪拉克CT 5经常莫名拨打紧急救援电话', author: '车主' },
      { itemId: 'remote', title: '昂科威plus远程失败', author: '车主' },
      { itemId: 'onstar', title: '安吉星，一生黑', author: '车主' },
    ],
  }));
  const policy = resolvePrefilterPolicyValues({ requestedMode: 'conservative' });
  const normalized = normalizePrefilterModelResponse(validation.value, {
    items: validation.value.items.map((item, index) => ({
      itemId: item.itemId,
      decision: 'skip',
      tenantRelevance: index === 0 ? 'relevant' : 'irrelevant',
      queryMatch: 0,
      brandMatch: index === 0 ? 0.8 : 0,
      confidence: 1,
      reason: '模拟当前关键词不匹配',
    })),
  }, policy);

  assert.deepEqual(
    normalized.items.map(item => item.executionDisposition),
    ['collect_full', 'collect_full', 'collect_full'],
  );
  assert.deepEqual(
    normalized.items.map(item => item.protectedSignal),
    [true, true, true],
  );
});

test('idempotency body hash ignores request ids but detects logical content changes', () => {
  const first = validatePrefilterRequest(validBody()).value;
  const retry = validatePrefilterRequest(validBody({ requestId: 'req-2', idempotencyKey: 'same-logical-key' })).value;
  const changed = validatePrefilterRequest(validBody({ items: [{ itemId: 'xiaohongshu:a', title: '内容变化', author: '车友' }] })).value;
  assert.equal(prefilterRequestBodyHash(first), prefilterRequestBodyHash(retry));
  assert.notEqual(prefilterRequestBodyHash(first), prefilterRequestBodyHash(changed));
  assert.equal(prefilterCacheKey(first, first.items[0], 'deepseek-chat').length, 64);
  assert.notEqual(
    prefilterCacheKey(first, first.items[0], 'deepseek-chat'),
    prefilterCacheKey(first, first.items[0], 'deepseek-reasoner'),
  );
  assert.notEqual(
    prefilterCacheKey(first, first.items[0], 'shared-model', 'deepseek'),
    prefilterCacheKey(first, first.items[0], 'shared-model', 'qianwen'),
  );
});

test('routine DeepSeek and Qwen requests explicitly disable thinking', () => {
  const shared = {
    model: 'model-a',
    systemPrompt: 'Return JSON.',
    userMessage: '{}',
    maxTokens: 2048,
    thinking: false,
  };
  const deepseek = buildOpenAICompatibleRequestBody({
    ...shared,
    provider: 'deepseek',
  });
  assert.deepEqual(deepseek.thinking, {type: 'disabled'});
  assert.equal(Object.hasOwn(deepseek, 'enable_thinking'), false);

  const qwen = buildOpenAICompatibleRequestBody({
    ...shared,
    provider: 'qwen',
  });
  assert.equal(qwen.enable_thinking, false);
  assert.equal(Object.hasOwn(qwen, 'thinking'), false);
  assert.deepEqual(qwen.response_format, {type: 'json_object'});
});

test('purpose route never reuses a credential across providers', () => {
  const base = {
    provider: 'deepseek',
    apiKey: 'deepseek-secret',
    model: 'deepseek-v4-flash',
    endpoint: 'https://api.deepseek.com/v1',
  };
  const missingQwenKey = resolvePurposeLLMConfigValues(base, {
    provider: 'qwen',
    model: 'qwen3.7-flash-2026-07-15',
  });
  assert.equal(missingQwenKey.provider, 'qianwen');
  assert.equal(missingQwenKey.apiKey, '');
  assert.equal(
    missingQwenKey.endpoint,
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
  );

  const qwen = resolvePurposeLLMConfigValues(base, {
    provider: 'qianwen',
    apiKey: 'qwen-secret',
    model: 'qwen3.7-flash-2026-07-15',
    endpoint: 'https://example.aliyuncs.com/compatible-mode/v1/',
  });
  assert.equal(qwen.apiKey, 'qwen-secret');
  assert.equal(qwen.endpoint, 'https://example.aliyuncs.com/compatible-mode/v1');
});

test('backend contract uses tenant auth, shared AI admission and an audit ledger', async () => {
  const [migration, service, route, aiLabeler, admission, serverApp] = await Promise.all([
    source('server/db/migrations/031_relevance_prefilter.sql'),
    source('server/services/relevance-prefilter.js'),
    source('server/routes/relevance-prefilter.js'),
    source('server/services/ai-labeler.js'),
    source('server/services/ai-admission.js'),
    source('server/app.js'),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS relevance_prefilter_requests/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS relevance_prefilter_decisions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS relevance_prefilter_cache/);
  assert.match(migration, /expires_at TIMESTAMPTZ NOT NULL DEFAULT \(now\(\) \+ interval '14 days'\)/);
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(migration, /server_model_status IN \('ok', 'invalid_input', 'model_error', 'timeout'\)/);
  assert.match(migration, /execution_disposition IN \('collect_full', 'skip_full_capture', 'request_detail'\)/);
  assert.match(service, /callRelevancePrefilterWithPrompt/);
  assert.doesNotMatch(service, /acquireTenantSlot|tenantSlotStates/u);
  assert.match(service, /Math\.max\(1800, pendingItems\.length \* 320\)/u);
  assert.match(service, /finishReason/u);
  assert.match(service, /thinkingEnabled: false/u);
  assert.match(service, /PREFILTER_DEFAULT_QUEUE_TIMEOUT_MS/u);
  assert.match(service, /relevance_prefilter_daily_item_limit/);
  assert.match(service, /response_body = \$5::jsonb/);
  assert.match(route, /requireAuthCodeFirst, requireTenantWriter/);
  assert.match(route, /failOpen: true/);
  assert.match(aiLabeler, /getRelevancePrefilterLLMConfig/u);
  assert.match(aiLabeler, /PREFILTER_LLM_API_KEY_MISSING/u);
  assert.match(aiLabeler, /enable_thinking = false/u);
  assert.match(aiLabeler, /LLM_JSON_PARSE_FAILED/u);
  assert.match(aiLabeler, /finish_reason/u);
  assert.match(aiLabeler, /runWithTenantAiAdmission/u);
  assert.match(admission, /DEFAULT_AI_TENANT_CONCURRENCY = 6/u);
  assert.match(admission, /priority/u);
  assert.match(admission, /AI_ADMISSION_QUEUE_TIMEOUT/u);
  assert.match(serverApp, /app\.use\('\/api\/relevance\/prefilter', relevancePrefilterRouter\)/);
});
