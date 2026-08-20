import { getSettings } from '../db/init.js';

export const LLM_RELAY_SETTING_KEYS = Object.freeze({
  mode: 'llm_relay_mode',
  model: 'llm_relay_model',
});

export const LLM_RELAY_MODES = Object.freeze(['off', 'primary', 'fallback']);
export const DEFAULT_LLM_RELAY_MODEL = 'gemini-3.7-flash-low';
export const LLM_RELAY_CLASSIFICATION_TIMEOUT_MS = 15_000;
export const LLM_RELAY_PREFILTER_TIMEOUT_MS = 9_000;
export const LLM_RELAY_PREFILTER_QUEUE_TIMEOUT_MS = 1_000;
export const LLM_RELAY_PREFILTER_PRIMARY_CLOUD_TIMEOUT_MS = 8_000;
export const LLM_RELAY_PREFILTER_TOTAL_BUDGET_MS = 28_000;
export const LLM_RELAY_ELIGIBLE_KINDS = Object.freeze([
  'record_classification',
  'relevance_prefilter',
]);

export function isLlmRelayEligibleKind(value) {
  return LLM_RELAY_ELIGIBLE_KINDS.includes(String(value || '').trim());
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return LLM_RELAY_MODES.includes(mode) ? mode : 'off';
}

export function normalizeLlmRelaySettings(settings = {}) {
  const rawMode = String(settings[LLM_RELAY_SETTING_KEYS.mode] || '').trim().toLowerCase();
  const mode = normalizeMode(rawMode);
  const model = String(
    settings[LLM_RELAY_SETTING_KEYS.model] || DEFAULT_LLM_RELAY_MODEL,
  ).trim();
  let validationError = '';
  if (rawMode && !LLM_RELAY_MODES.includes(rawMode)) {
    validationError = '本机 AI 模式必须为 off、primary 或 fallback';
  } else if (mode !== 'off' && !/^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(model)) {
    validationError = '本机 AI 模型名称不合法';
  }
  return {
    mode,
    model,
    enabled: mode !== 'off' && !validationError,
    validationError,
  };
}

export async function getLlmRelayConfig(tenantId) {
  const settings = await getSettings(Object.values(LLM_RELAY_SETTING_KEYS), tenantId);
  return normalizeLlmRelaySettings(settings);
}

export function sanitizeLlmRelayRequestOptions(options = {}) {
  const sanitized = {};
  const maxTokens = Number(options.maxTokens);
  if (Number.isFinite(maxTokens)) {
    sanitized.maxTokens = Math.max(256, Math.min(8192, Math.round(maxTokens)));
  }
  const timeoutMs = Number(options.timeoutMs);
  if (Number.isFinite(timeoutMs)) {
    sanitized.timeoutMs = Math.max(5000, Math.min(35000, Math.round(timeoutMs)));
  }
  const kind = String(options.kind || '').trim();
  if (kind) sanitized.kind = kind.slice(0, 80);
  sanitized.responseFormat = 'json_object';
  return sanitized;
}

/**
 * Apply the tenant's relay policy without coupling it to a specific provider.
 * Both callbacks are lazy so an offline local Agent falls back immediately.
 */
export async function runLlmRelayPolicy({
  mode,
  relayAvailable,
  baseAvailable,
  callRelay,
  callBase,
  onRelayError = () => {},
  onBaseError = () => {},
}) {
  const normalizedMode = normalizeMode(mode);
  const canRelay = Boolean(relayAvailable) && typeof callRelay === 'function';
  const canBase = Boolean(baseAvailable) && typeof callBase === 'function';

  if (normalizedMode === 'primary' && canRelay) {
    try {
      return await callRelay();
    } catch (error) {
      onRelayError(error);
      if (!canBase) throw error;
      return await callBase();
    }
  }

  if (normalizedMode === 'fallback') {
    if (canBase) {
      try {
        return await callBase();
      } catch (error) {
        onBaseError(error);
        if (!canRelay) throw error;
      }
    }
    if (canRelay) return await callRelay();
    return null;
  }

  if (canBase) return await callBase();
  if (normalizedMode !== 'off' && canRelay) return await callRelay();
  return null;
}
