import {Readable} from 'node:stream';

export const MEDIA_DOWNLOAD_MAX_BYTES = 15 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class MediaDownloadError extends Error {
  constructor(code, message, {status = 502, ...details} = {}) {
    super(message);
    this.name = 'MediaDownloadError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function allowedUrl(value, isAllowedUrl) {
  let parsed;
  try { parsed = new URL(value); } catch { /* rejected below */ }
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || !isAllowedUrl(parsed.href)) {
    throw new MediaDownloadError('host_not_allowed', 'Media URL is not allowed', {status: 403});
  }
  return parsed.href;
}

function cancelBody(body) {
  try { body?.cancel()?.catch(() => {}); } catch { /* A consumed/locked body is closed by its reader. */ }
}

/**
 * Keep redirects, byte limits and cancellation under one lifetime, including body consumption.
 * Consumers must finish using `stream` before returning. Downloads use a total deadline;
 * inline playback may explicitly select an idle deadline without relaxing URL or byte limits.
 */
export async function withSafeMediaDownload({url, isAllowedUrl, headers = () => ({}), timeoutMs = 15000,
  maxBytes = MEDIA_DOWNLOAD_MAX_BYTES, timeoutMode = 'total', fetchImpl = globalThis.fetch}, consume) {
  if (typeof isAllowedUrl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !['total', 'idle'].includes(timeoutMode)) {
    throw new TypeError('Invalid media download policy');
  }
  maxBytes = Math.min(maxBytes, MEDIA_DOWNLOAD_MAX_BYTES);
  const controller = new AbortController();
  let timer, response, stream, reader, abortStream;
  const timeout = () => controller.abort(new MediaDownloadError('upstream_timeout', 'Media download timed out', {status: 504}));
  const armTimer = () => { clearTimeout(timer); timer = setTimeout(timeout, timeoutMs); };
  const abort = reason => controller.abort(reason || new MediaDownloadError('download_canceled', 'Media download canceled'));
  const abortable = async promise => {
    if (controller.signal.aborted) {
      Promise.resolve(promise).catch(() => {});
      throw controller.signal.reason;
    }
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, {once: true});
    });
    try { return await Promise.race([promise, aborted]); }
    finally { controller.signal.removeEventListener('abort', onAbort); }
  };
  armTimer();
  try {
    let current = allowedUrl(url, isAllowedUrl);
    for (let redirects = 0; ; redirects++) {
      response = await abortable(fetchImpl(current, {
        redirect: 'manual', signal: controller.signal,
        headers: typeof headers === 'function' ? headers(current) : headers,
      }));
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get('location');
      cancelBody(response.body);
      if (!location || redirects >= 3) throw new MediaDownloadError('redirect_failed', 'Media redirect limit exceeded');
      current = allowedUrl(new URL(location, current).href, isAllowedUrl);
    }
    if (timeoutMode === 'idle') armTimer();
    const length = Number(response.headers.get('content-length') || 0);
    if (response.ok && length > maxBytes) {
      const error = new MediaDownloadError('too_large', 'Media download exceeds its byte limit',
        {status: 413, maxBytes, observedBytes: length, source: 'content_length'});
      abort(error);
      throw error;
    }
    if (response.body) {
      stream = Readable.from((async function* () {
        reader = response.body.getReader();
        let received = 0;
        try {
          while (true) {
            const {done, value} = await abortable(reader.read());
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes) {
              const error = new MediaDownloadError('too_large', 'Media download exceeds its byte limit',
                {status: 413, maxBytes, observedBytes: received, source: 'stream'});
              abort(error);
              throw error;
            }
            if (timeoutMode === 'idle') armTimer();
            yield Buffer.from(value);
          }
        } finally {
          try { reader.cancel()?.catch(() => {}); } catch { /* already closed */ }
          try { reader.releaseLock(); } catch { /* cancellation can still be settling */ }
        }
      })());
      // Cancellation can precede the consumer attaching a pipeline/error listener.
      stream.on('error', () => {});
      abortStream = () => {
        stream.destroy(controller.signal.reason);
        try { reader?.cancel(controller.signal.reason)?.catch(() => {}); } catch { /* already closed */ }
      };
      controller.signal.addEventListener('abort', abortStream, {once: true});
    }
    return await abortable(consume({response, stream, signal: controller.signal, abort, url: current}));
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    if (abortStream) controller.signal.removeEventListener('abort', abortStream);
    stream?.destroy();
    cancelBody(response?.body);
    // Aborts a stalled network body even when a consumer rejects it without reading.
    if (!controller.signal.aborted) controller.abort();
  }
}
