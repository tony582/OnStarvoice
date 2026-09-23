const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_RESPONSE_BYTES = 256 * 1024;

export class CloudRequestError extends Error {
  constructor(code, {status = 0, retryAfterMs = 0, retryable = false} = {}) {
    super(code);
    this.name = 'CloudRequestError';
    Object.assign(this, {code, status, retryAfterMs, retryable});
  }
}

export function normalizeCloudUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Invalid cloud URL'); }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('Cloud URL must not contain credentials, query or fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new TypeError('Cloud URL requires HTTPS (HTTP is allowed only on loopback)');
  }
  if (url.pathname !== '/') throw new TypeError('Cloud URL must be the server origin');
  return url.origin;
}

function retryDelay(value, now) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new CloudRequestError('invalid_cloud_response');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new CloudRequestError('cloud_response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof CloudRequestError) throw error;
    throw new CloudRequestError('invalid_cloud_response');
  } finally { reader.releaseLock(); }
}

export function createTransport({baseUrl, agentToken, fetchImpl = fetch,
  timeoutMs = 10000, now = Date.now} = {}) {
  const origin = normalizeCloudUrl(baseUrl);
  if (agentToken !== undefined && (typeof agentToken !== 'string' || !agentToken.trim() || /[\r\n]/u.test(agentToken))) {
    throw new TypeError('A valid agent token is required');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError('Cloud timeout must be between 1 and 30000 ms');
  }
  async function request(path, {body, signal} = {}) {
    if (signal?.aborted) throw new CloudRequestError('cloud_aborted');
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => {
      controller.abort();
      rejectAbort(new CloudRequestError('cloud_aborted'));
    };
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CloudRequestError('cloud_timeout', {retryable: true}));
      }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, aborted, (async () => {
        const response = await fetchImpl(`${origin}/api/capture-cloud${path}`, {
          method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
          headers: {'content-type': 'application/json', ...(agentToken ? {'x-capture-agent-token': agentToken} : {})},
          ...(body ? {body: JSON.stringify(body)} : {}),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new CloudRequestError(`cloud_http_${response.status}`, {
            status: response.status,
            retryAfterMs: retryDelay(response.headers.get('retry-after'), now),
            retryable: response.status === 429 || response.status >= 500,
          });
        }
        const payload = await readJson(response);
        if (payload?.ok !== true) {
          throw new CloudRequestError('invalid_cloud_response');
        }
        return payload;
      })()]);
    } catch (error) {
      if (signal?.aborted) throw new CloudRequestError('cloud_aborted');
      if (error instanceof CloudRequestError) throw error;
      throw new CloudRequestError('cloud_network_error', {retryable: true});
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return request;
}
