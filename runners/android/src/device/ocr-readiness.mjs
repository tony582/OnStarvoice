import {readFileSync} from 'node:fs';
import {DeviceError} from './bounded.mjs';

export const OCR_WARMUP_TIMEOUT_MS = 120_000;
export const OCR_KEEPALIVE_MS = 240_000;
export const OCR_WARMUP_RETRY_MS = 30_000;
const WARMUP_IMAGE = new URL('../../tools/ocr/warmup.png', import.meta.url);

/** Local OCR only: this controller never reads or operates a phone. */
export function createOcrReadiness({ocr, now = Date.now, loadImage = () => readFileSync(WARMUP_IMAGE),
  onDiagnostic = () => {}}) {
  let closed = false, busy = false, timer = null, flight = null, failure = null, retryAt = 0;
  let lastWarmupMs = null;
  const fresh = () => Number.isFinite(ocr.lastSuccessAt) && now() >= ocr.lastSuccessAt
    && now() - ocr.lastSuccessAt < OCR_KEEPALIVE_MS;
  const note = entry => { try { onDiagnostic(entry); } catch { /* Diagnostics never affect readiness. */ } };
  const stopTimer = () => { clearTimeout(timer); timer = null; };
  function schedule(wait) {
    stopTimer();
    if (closed || busy || flight) return;
    timer = setTimeout(() => { timer = null; maintain(); }, Math.max(1, wait));
    timer.unref?.();
  }
  function startWarmup() {
    if (closed) return Promise.reject(new DeviceError('ocr_unavailable', 'OCR readiness was closed'));
    if (flight) return flight.promise;
    stopTimer();
    const controller = new AbortController(), started = now();
    const current = {controller};
    flight = current;
    current.promise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new DeviceError('aborted', 'OCR warmup canceled');
      return ocr.recognize(loadImage(), {timeoutMs: OCR_WARMUP_TIMEOUT_MS, signal: controller.signal});
    }).then(() => {
      if (controller.signal.aborted || closed) throw new DeviceError('aborted', 'OCR warmup canceled');
      failure = null; retryAt = 0; lastWarmupMs = Math.max(0, now() - started);
      note({event: 'ocr_warmup_ready', elapsedMs: lastWarmupMs});
    }, error => { throw error; }).catch(error => {
      failure = error; retryAt = now() + OCR_WARMUP_RETRY_MS;
      note({event: 'ocr_warmup_failed', code: error.code ?? 'ocr_failed',
        elapsedMs: Math.max(0, now() - started), details: error.details ?? null});
      throw new DeviceError('ocr_unavailable', 'OCR warmup did not complete',
        {details: {...error.details, cause: error.code ?? 'ocr_failed'}});
    }).finally(() => {
      if (flight === current) flight = null;
      if (!closed && !busy) schedule(failure ? OCR_WARMUP_RETRY_MS : OCR_KEEPALIVE_MS);
    });
    // Startup/idle callers do not await the request; the task caller still receives the original rejection.
    current.promise.catch(() => {});
    return current.promise;
  }
  function maintain() {
    if (closed || busy || flight) return;
    if (failure && now() < retryAt) { schedule(retryAt - now()); return; }
    if (fresh() && !failure) { schedule(OCR_KEEPALIVE_MS - (now() - ocr.lastSuccessAt)); return; }
    // A real recognition may be in flight when its successful timestamp is not yet available.
    if (ocr.pending > 0) { schedule(1000); return; }
    startWarmup();
  }
  async function ensureReady({signal} = {}) {
    if (signal?.aborted) throw signal.reason ?? new DeviceError('aborted', 'OCR warmup canceled');
    if (closed) throw new DeviceError('ocr_unavailable', 'OCR readiness was closed');
    if (fresh() && !failure && !flight) return;
    const promise = startWarmup();
    if (!signal) return promise;
    let cancel;
    const aborted = new Promise((_, reject) => {
      cancel = () => {
        flight?.controller.abort();
        reject(signal.reason ?? new DeviceError('aborted', 'OCR warmup canceled'));
      };
      signal.addEventListener('abort', cancel, {once: true});
      if (signal.aborted) cancel();
    });
    try { await Promise.race([promise, aborted]); }
    finally { signal.removeEventListener('abort', cancel); }
  }
  return {
    start: maintain,
    maintain,
    ensureReady,
    setTaskActive(value) {
      busy = value === true;
      if (busy) stopTimer(); else maintain();
    },
    status() {
      return {readyForSearch: !closed && !flight && !failure && fresh(),
        reason: closed || (!flight && failure) ? 'ocr_unavailable' : flight || !fresh() ? 'ocr_warming' : null,
        lastSuccessAt: ocr.lastSuccessAt ?? null, lastWarmupMs};
    },
    close() { closed = true; stopTimer(); flight?.controller.abort(); },
  };
}
