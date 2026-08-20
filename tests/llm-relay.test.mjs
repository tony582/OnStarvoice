import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLlmRelayEligibleKind,
  LLM_RELAY_CLASSIFICATION_TIMEOUT_MS,
  LLM_RELAY_PREFILTER_PRIMARY_CLOUD_TIMEOUT_MS,
  LLM_RELAY_PREFILTER_QUEUE_TIMEOUT_MS,
  LLM_RELAY_PREFILTER_TIMEOUT_MS,
  LLM_RELAY_PREFILTER_TOTAL_BUDGET_MS,
  normalizeLlmRelaySettings,
  runLlmRelayPolicy,
  sanitizeLlmRelayRequestOptions,
} from '../server/services/llm-relay.js';
import {
  createLlmRelayAgentToken,
  hashLlmRelayAgentToken,
  validateLlmRelayJobInput,
} from '../server/services/llm-relay-jobs.js';

test('local relay is bounded to final and prefilter classification with short deadlines', () => {
  assert.equal(isLlmRelayEligibleKind('record_classification'), true);
  assert.equal(isLlmRelayEligibleKind('relevance_prefilter'), true);
  assert.equal(isLlmRelayEligibleKind('llm_prompt'), false);
  assert.equal(isLlmRelayEligibleKind('report'), false);
  assert.equal(LLM_RELAY_CLASSIFICATION_TIMEOUT_MS, 15_000);
  assert.equal(LLM_RELAY_PREFILTER_TIMEOUT_MS, 9_000);
  assert.equal(LLM_RELAY_PREFILTER_QUEUE_TIMEOUT_MS, 1_000);
  assert.equal(LLM_RELAY_PREFILTER_PRIMARY_CLOUD_TIMEOUT_MS, 8_000);
  assert.equal(LLM_RELAY_PREFILTER_TOTAL_BUDGET_MS, 28_000);
});

test('relay settings are opt-in and validate the model name', () => {
  assert.deepEqual(normalizeLlmRelaySettings({}), {
    mode: 'off',
    model: 'gemini-3.7-flash-low',
    enabled: false,
    validationError: '',
  });
  assert.equal(normalizeLlmRelaySettings({
    llm_relay_mode: 'primary',
    llm_relay_model: 'gemini-3.1-pro-low',
  }).enabled, true);
  assert.match(normalizeLlmRelaySettings({
    llm_relay_mode: 'remote-shell',
  }).validationError, /off、primary/);
  assert.match(normalizeLlmRelaySettings({
    llm_relay_mode: 'primary',
    llm_relay_model: '../unsafe',
  }).validationError, /模型名称/);
});

test('primary relay falls back to cloud while fallback mode does the inverse', async () => {
  const calls = [];
  const primaryResult = await runLlmRelayPolicy({
    mode: 'primary',
    relayAvailable: true,
    baseAvailable: true,
    callRelay: async () => {
      calls.push('relay');
      const error = new Error('offline');
      error.code = 'LLM_RELAY_AGENT_OFFLINE';
      throw error;
    },
    callBase: async () => {
      calls.push('base');
      return {ok: 'cloud'};
    },
  });
  assert.deepEqual(primaryResult, {ok: 'cloud'});
  assert.deepEqual(calls, ['relay', 'base']);

  calls.length = 0;
  const fallbackResult = await runLlmRelayPolicy({
    mode: 'fallback',
    relayAvailable: true,
    baseAvailable: true,
    callBase: async () => {
      calls.push('base');
      throw new Error('cloud down');
    },
    callRelay: async () => {
      calls.push('relay');
      return {ok: 'local'};
    },
  });
  assert.deepEqual(fallbackResult, {ok: 'local'});
  assert.deepEqual(calls, ['base', 'relay']);
});

test('relay request metadata is allowlisted and bounded', () => {
  assert.deepEqual(sanitizeLlmRelayRequestOptions({
    maxTokens: 99_999,
    timeoutMs: 1,
    kind: 'classification',
    authorName: 'must not leave server',
    ipAddress: '127.0.0.1',
    apiKey: 'secret',
  }), {
    maxTokens: 8192,
    timeoutMs: 5000,
    kind: 'classification',
    responseFormat: 'json_object',
  });

  const validated = validateLlmRelayJobInput({
    tenantId: 'tenant-a',
    model: 'gemini-3.7-flash-low',
    systemPrompt: 'Return JSON.',
    userMessage: 'Analyze this.',
    requestOptions: {kind: 'report', apiKey: 'never-store-me'},
  });
  assert.equal(validated.requestOptions.apiKey, undefined);
  assert.equal(validated.requestOptions.kind, 'report');
});

test('agent credentials are one-way hashed and use a separate prefix', () => {
  const token = createLlmRelayAgentToken();
  assert.match(token, /^svai_[A-Za-z0-9_-]{40,}$/);
  assert.match(hashLlmRelayAgentToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashLlmRelayAgentToken(token), token);
});
