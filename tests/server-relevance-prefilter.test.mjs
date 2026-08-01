import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PREFILTER_DEFAULT_MODEL_TIMEOUT_MS,
  PREFILTER_MAX_LIST_BATCH,
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
  assert.equal(PREFILTER_DEFAULT_MODEL_TIMEOUT_MS, 25000);
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

test('first release sends DeepSeek only minimal list text', () => {
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
  assert.match(prompt, /不是在做宽泛的品牌舆情判断/);
  assert.match(prompt, /目标对象：别克、Buick/);
  assert.match(prompt, /目标主题：车机壁纸、手机壁纸/);
  assert.match(prompt, /必须同时符合任务的目标对象和目标主题/);
  assert.match(prompt, /其它汽车品牌[\s\S]*0\.98-1\.00/);
  assert.match(prompt, /合理相关解释[\s\S]*need_detail[\s\S]*0\.96/);
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
        queryMatch: 0.01,
        brandMatch: 0.02,
        confidence: 0.98,
        reason: '其它品牌壁纸',
        evidence: ['大众'],
        missingSignals: [],
      },
      { itemId: 'unknown', decision: 'skip', queryMatch: 0, brandMatch: 0, confidence: 1, reason: '未知项' },
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
  assert.equal(determineExecutionDisposition({ status: 'ok', modelDecision: 'skip', confidence: 1 }, shadow), 'collect_full');

  const conservative = resolvePrefilterPolicyValues({ requestedMode: 'conservative', requestedThreshold: 0.97 });
  assert.equal(conservative.effectiveMode, 'conservative');
  assert.equal(determineExecutionDisposition({ status: 'ok', modelDecision: 'skip', confidence: 0.9699 }, conservative), 'collect_full');
  assert.equal(determineExecutionDisposition({ status: 'model_error', modelDecision: 'skip', confidence: 1 }, conservative), 'collect_full');
  assert.equal(determineExecutionDisposition({ status: 'ok', modelDecision: 'skip', confidence: 0.97 }, conservative), 'skip_full_capture');

  const serverShadow = resolvePrefilterPolicyValues({ requestedMode: 'conservative', serverMode: 'shadow' });
  assert.equal(serverShadow.effectiveMode, 'shadow');
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
});

test('backend contract uses tenant auth, shared AI admission and an audit ledger', async () => {
  const [migration, service, route, aiLabeler, admission, serverIndex] = await Promise.all([
    source('server/db/migrations/031_relevance_prefilter.sql'),
    source('server/services/relevance-prefilter.js'),
    source('server/routes/relevance-prefilter.js'),
    source('server/services/ai-labeler.js'),
    source('server/services/ai-admission.js'),
    source('server/index.js'),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS relevance_prefilter_requests/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS relevance_prefilter_decisions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS relevance_prefilter_cache/);
  assert.match(migration, /expires_at TIMESTAMPTZ NOT NULL DEFAULT \(now\(\) \+ interval '14 days'\)/);
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(migration, /server_model_status IN \('ok', 'invalid_input', 'model_error', 'timeout'\)/);
  assert.match(migration, /execution_disposition IN \('collect_full', 'skip_full_capture', 'request_detail'\)/);
  assert.match(service, /callDeepSeekWithPrompt/);
  assert.doesNotMatch(service, /acquireTenantSlot|tenantSlotStates/u);
  assert.match(service, /Math\.max\(3000, pendingItems\.length \* 600\)/u);
  assert.match(service, /finishReason/u);
  assert.match(service, /retryCount/u);
  assert.match(service, /relevance_prefilter_daily_item_limit/);
  assert.match(service, /response_body = \$4::jsonb/);
  assert.match(route, /requireAuthCodeFirst, requireTenantWriter/);
  assert.match(route, /failOpen: true/);
  assert.match(aiLabeler, /config\.provider !== 'deepseek'/);
  assert.match(aiLabeler, /租户后台尚未配置 DeepSeek API Key/);
  assert.match(aiLabeler, /LLM_JSON_PARSE_FAILED/u);
  assert.match(aiLabeler, /finish_reason/u);
  assert.match(aiLabeler, /runWithTenantAiAdmission/u);
  assert.match(admission, /DEFAULT_AI_TENANT_CONCURRENCY = 6/u);
  assert.match(admission, /priority/u);
  assert.match(admission, /AI_ADMISSION_QUEUE_TIMEOUT/u);
  assert.match(serverIndex, /app\.use\('\/api\/relevance\/prefilter', relevancePrefilterRouter\)/);
});
