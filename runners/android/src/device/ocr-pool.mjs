import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {accessSync, constants, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {DeviceError} from './bounded.mjs';

// Local text recognition for screens whose UI tree the app hides (WeChat 8.0.80). The helper is the
// compiled tools/ocr/StarVoiceOCR.swift (macOS Vision): it runs on this computer, calls no model service,
// and answers requests concurrently. Screenshots are written to a private directory only for the moment the
// helper reads them and are deleted with the reply; neither images nor recognized text are kept.
export const OCR_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESTARTS = 3;
const STDERR_BYTES = 2048;

export function ocrHelperAvailable(binaryPath) {
  if (typeof binaryPath !== 'string' || !binaryPath) return false;
  try { accessSync(binaryPath, constants.X_OK); return true; } catch { return false; }
}

export function createOcrPool({binaryPath, tmpDir, concurrency = 3, spawnImpl = spawn,
  requestTimeoutMs = OCR_REQUEST_TIMEOUT_MS, now = Date.now} = {}) {
  if (typeof tmpDir !== 'string' || !tmpDir) throw new DeviceError('ocr_unavailable', 'OCR scratch directory is required');
  let child = null, restarts = 0, closed = false, lastSuccessAt = null;
  const pending = new Map();
  const details = (worker, extra = {}) => {
    let stderr = worker.stderr.toString('utf8');
    // Decoding a partial UTF-8 boundary can add replacement bytes; retain the same byte ceiling.
    while (Buffer.byteLength(stderr) > STDERR_BYTES) stderr = stderr.slice(stderr.codePointAt(0) > 0xffff ? 2 : 1);
    return {...extra, stderr};
  };
  const error = (worker, code, message, extra) => new DeviceError(code, message, {details: details(worker, extra)});
  const settle = (id, failure, value) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    rmSync(entry.path, {force: true});
    if (failure) entry.reject(failure); else entry.resolve(value);
  };
  const retire = (worker, code, message, extra = {}, unexpected = false) => {
    if (worker.retired) return;
    worker.retired = true;
    if (child === worker) { child = null; lastSuccessAt = null; }
    if (unexpected) restarts++;
    for (const [id, entry] of pending) {
      if (entry.worker === worker) settle(id, error(worker, code, message, extra));
    }
    worker.reader?.close();
    try { worker.proc.stdin.end(); worker.proc.kill('SIGTERM'); } catch { /* already gone */ }
  };
  const start = () => {
    if (child?.exited) throw error(child, 'ocr_unavailable', 'The local OCR helper stopped', child.exited);
    if (child) return child;
    if (closed) throw new DeviceError('ocr_unavailable', 'OCR helper was closed');
    if (!ocrHelperAvailable(binaryPath)) throw new DeviceError('ocr_unavailable', 'The local OCR helper is not installed');
    if (restarts > MAX_RESTARTS) throw new DeviceError('ocr_unavailable', 'The local OCR helper keeps stopping');
    mkdirSync(tmpDir, {recursive: true, mode: 0o700});
    let proc;
    try {
      proc = spawnImpl(binaryPath, ['--concurrency', String(Math.max(1, Math.min(6, concurrency)))],
        {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    } catch (cause) {
      restarts++; lastSuccessAt = null;
      throw new DeviceError('ocr_unavailable', 'The local OCR helper could not start', {details: {
        error: typeof cause?.code === 'string' ? cause.code : 'process_error',
        message: String(cause?.message ?? cause).slice(0, 512), stderr: '',
      }});
    }
    const worker = {proc, stderr: Buffer.alloc(0), retired: false};
    child = worker;
    proc.stderr?.on('data', chunk => {
      worker.stderr = Buffer.from(Buffer.concat([worker.stderr, Buffer.from(chunk)]).subarray(-STDERR_BYTES));
    });
    worker.reader = createInterface({input: proc.stdout});
    worker.reader.on('line', line => {
      if (worker.retired) return;
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      const entry = pending.get(reply?.id);
      if (!entry || entry.worker !== worker) return;
      if (reply.ok !== true || !Array.isArray(reply.rows)) {
        settle(reply.id, error(worker, 'ocr_failed', 'Text recognition failed', {
          error: typeof reply.error === 'string' ? reply.error.slice(0, 256) : 'invalid_reply',
          ...(typeof reply.domain === 'string' ? {domain: reply.domain.slice(0, 256)} : {}),
          ...(Number.isSafeInteger(reply.code) ? {code: reply.code} : {}),
        }));
      } else {
        if (child === worker && !worker.exited) lastSuccessAt = now();
        settle(reply.id, null, {rows: reply.rows.map(normalizeRow).filter(Boolean), width: reply.width, height: reply.height, ms: reply.ms});
      }
    });
    proc.on('exit', (exitCode, signal) => {
      worker.exited = {exitCode, signal};
      if (child === worker) lastSuccessAt = null;
    });
    // close follows stdout/stderr drainage; an exit event alone may omit the final error bytes.
    proc.on('close', (exitCode, signal) => retire(worker, 'ocr_unavailable', 'The local OCR helper stopped', {exitCode, signal}, true));
    const unavailable = cause => retire(worker, 'ocr_unavailable', 'The local OCR helper stopped', {
      error: typeof cause?.code === 'string' ? cause.code : 'process_error',
      message: String(cause?.message ?? cause).slice(0, 512),
    }, true);
    proc.on('error', unavailable);
    proc.stdin.on('error', unavailable);
    worker.unavailable = unavailable;
    return worker;
  };
  return {
    /** Recognize one PNG screenshot (Buffer). `roi` = [x, y, w, h] in pixels limits the work to one area. */
    async recognize(png, {roi = null, signal, timeoutMs = requestTimeoutMs} = {}) {
      if (!Buffer.isBuffer(png) || png.length < 8) return Promise.reject(new DeviceError('ocr_failed', 'Screenshot is empty'));
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new DeviceError('invalid_timeout', 'OCR timeout must be between 1 and 120000 ms');
      if (signal?.aborted) throw new DeviceError('aborted', 'Text recognition was canceled');
      const worker = start();
      const id = randomUUID();
      const path = join(tmpDir, `${id}.png`);
      writeFileSync(path, png, {mode: 0o600});
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(id, error(worker, 'ocr_timeout', 'Text recognition exceeded its time budget', {timeoutMs}));
          // A timed-out Vision request may still hold a slot. Retire it before another warmup/request.
          retire(worker, 'ocr_unavailable', 'The local OCR helper was restarted after a timeout', {error: 'request_timeout'});
        }, timeoutMs);
        const onAbort = () => {
          if (!pending.has(id)) return;
          settle(id, error(worker, 'aborted', 'Text recognition was canceled'));
          retire(worker, 'ocr_unavailable', 'The local OCR helper was restarted after cancellation', {error: 'request_aborted'});
        };
        pending.set(id, {resolve, reject, timer, path, worker, signal, onAbort});
        signal?.addEventListener('abort', onAbort, {once: true});
        if (signal?.aborted) { onAbort(); return; }
        try {
          worker.proc.stdin.write(`${JSON.stringify({id, path, ...(roi ? {roi} : {})})}\n`, cause => {
            if (cause) worker.unavailable(cause);
          });
        } catch (cause) { worker.unavailable(cause); }
      });
    },
    get pending() { return pending.size; },
    get lastSuccessAt() { return lastSuccessAt; },
    close() {
      closed = true;
      if (child) retire(child, 'aborted', 'OCR helper closed');
      lastSuccessAt = null;
    },
  };
}

function normalizeRow(row) {
  if (!row || typeof row.text !== 'string') return null;
  const number = value => Number.isFinite(value) ? Math.round(value) : 0;
  const text = row.text.normalize('NFC').trim();
  if (!text) return null;
  return {text, conf: Number.isFinite(row.conf) ? row.conf : 0, x: number(row.x), y: number(row.y), w: number(row.w), h: number(row.h)};
}
