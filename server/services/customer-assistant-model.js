import {normalizeCustomerAssistantMessage} from './customer-assistant-agent.js';

const sequences = new Map();
let defaultDependencies;
async function dependenciesFor(overrides) {
  if (overrides) return overrides;
  defaultDependencies ||= Promise.all([import('./ai-labeler.js'), import('./ai-admission.js'), import('./ai-failover.js')]).then(([labeler, admission, failover]) => ({
    getConfig: labeler.getDeepSeekConfig,
    runAdmission: admission.runWithTenantAiAdmission,
    recordFailure: failover.recordAiModelFailure,
    recordSuccess: failover.recordAiModelSuccess,
    selectModel: failover.selectActiveActiveModel,
    fetch: globalThis.fetch,
  }));
  return defaultDependencies;
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('请求已取消'), {code: 'ABORT_ERR'});
}

function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || Object.assign(new Error('请求已取消'), {code: 'ABORT_ERR'}));
    signal.addEventListener('abort', onAbort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
}

async function readResponse(response) {
  const maxBytes = 256000;
  if (Number(response.headers?.get('content-length')) > maxBytes) {
    await response.body?.cancel?.();
    throw Object.assign(new Error('模型响应过大'), {code: 'assistant_model_response_invalid'});
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error('模型响应过大'), {code: 'assistant_model_response_invalid'});
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error('模型响应过大'), {code: 'assistant_model_response_invalid'});
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

/** Tenant-bound transport for real DeepSeek tool calls; imports do not read tenant secrets. */
export function createCustomerAssistantModel({tenantId, thinking = false, timeoutMs = 40000, dependencies} = {}) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) throw new TypeError('tenantId is required');
  const duration = Math.max(1000, Math.min(40000, Number(timeoutMs) || 40000));
  return async ({messages, tools, signal} = {}) => {
    abortIfNeeded(signal);
    if (!Array.isArray(messages) || !Array.isArray(tools) || messages.length > 120 || JSON.stringify({messages, tools}).length > 180000) throw Object.assign(new Error('模型请求无效或过大'), {code: 'assistant_model_request_invalid'});
    const deps = await dependenciesFor(dependencies);
    abortIfNeeded(signal);
    let config = await deps.getConfig(tenantId);
    if (config?.provider !== 'deepseek' || !config.apiKey || !config.model || !config.endpoint) throw Object.assign(new Error('客户助手尚未配置 DeepSeek'), {code: 'assistant_model_not_configured'});
    if (config.failover?.mode === 'active_active' && deps.selectModel) {
      const sequence = sequences.get(tenantId) || 0;
      sequences.set(tenantId, sequence + 1);
      config = {...config, model: deps.selectModel(config, sequence), failover: {...config.failover, route: 'active_active'}};
    }
    const safeRecordFailure = async cause => {
      try { return await deps.recordFailure(tenantId, {config, error: cause, kind: 'customer_group_assistant'}); } catch { return {}; }
    };
    const request = async () => {
      abortIfNeeded(signal);
      const timeout = AbortSignal.timeout(duration);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const body = {model: config.model, messages, tools, tool_choice: 'auto', max_tokens: 8192, stream: false, thinking: {type: thinking ? 'enabled' : 'disabled'}};
      if (!thinking) body.temperature = 0.1;
      const response = await deps.fetch(`${String(config.endpoint).replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}`},
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      abortIfNeeded(requestSignal);
      if (!response.ok) {
        await response.body?.cancel?.();
        throw Object.assign(new Error(`DeepSeek 请求失败 (${response.status})`), {status: response.status, code: 'assistant_model_http_error'});
      }
      const data = await readResponse(response);
      abortIfNeeded(requestSignal);
      if (!['stop', 'tool_calls'].includes(data?.choices?.[0]?.finish_reason)) throw Object.assign(new Error('模型回答未完整结束'), {code: 'assistant_model_response_invalid'});
      return normalizeCustomerAssistantMessage(data.choices[0].message);
    };
    let recordedFailure = false;
    try {
      const result = await awaitWithAbort(deps.runAdmission(tenantId, async () => {
        abortIfNeeded(signal);
        try { return await request(); } catch (cause) {
          abortIfNeeded(signal);
          const decision = await safeRecordFailure(cause);
          recordedFailure = true;
          if (!decision?.retryCurrent || !decision.retryModel || decision.retryModel === config.model) throw cause;
          config = {...config, model: decision.retryModel, failover: {...config.failover, route: decision.retryRoute || 'backup'}};
          try { return await request(); } catch (backupError) {
            abortIfNeeded(signal);
            await safeRecordFailure(backupError);
            throw backupError;
          }
        }
      }, {priority: 'interactive', kind: 'customer_group_assistant', queueTimeoutMs: 15000}), signal);
      try { await deps.recordSuccess(tenantId, {config}); } catch { /* Bookkeeping cannot invalidate a successful answer. */ }
      return result;
    } catch (cause) {
      abortIfNeeded(signal);
      if (!recordedFailure) await safeRecordFailure(cause);
      throw cause;
    }
  };
}
