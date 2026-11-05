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

export function ocrHelperAvailable(binaryPath) {
  if (typeof binaryPath !== 'string' || !binaryPath) return false;
  try { accessSync(binaryPath, constants.X_OK); return true; } catch { return false; }
}

export function createOcrPool({binaryPath, tmpDir, concurrency = 3, spawnImpl = spawn,
  requestTimeoutMs = OCR_REQUEST_TIMEOUT_MS} = {}) {
  if (typeof tmpDir !== 'string' || !tmpDir) throw new DeviceError('ocr_unavailable', 'OCR scratch directory is required');
  let child = null, restarts = 0, closed = false;
  const pending = new Map();
  const fail = (code, message) => {
    for (const [id, entry] of pending) { clearTimeout(entry.timer); rmSync(entry.path, {force: true}); entry.reject(new DeviceError(code, message)); pending.delete(id); }
  };
  const start = () => {
    if (child) return child;
    if (closed) throw new DeviceError('ocr_unavailable', 'OCR helper was closed');
    if (!ocrHelperAvailable(binaryPath)) throw new DeviceError('ocr_unavailable', 'The local OCR helper is not installed');
    if (restarts > MAX_RESTARTS) throw new DeviceError('ocr_unavailable', 'The local OCR helper keeps stopping');
    mkdirSync(tmpDir, {recursive: true, mode: 0o700});
    const proc = spawnImpl(binaryPath, ['--concurrency', String(Math.max(1, Math.min(6, concurrency)))],
      {stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true});
    child = proc;
    createInterface({input: proc.stdout}).on('line', line => {
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      const entry = pending.get(reply?.id);
      if (!entry) return;
      pending.delete(reply.id);
      clearTimeout(entry.timer);
      rmSync(entry.path, {force: true});
      if (reply.ok !== true || !Array.isArray(reply.rows)) entry.reject(new DeviceError('ocr_failed', 'Text recognition failed'));
      else entry.resolve({rows: reply.rows.map(normalizeRow).filter(Boolean), width: reply.width, height: reply.height, ms: reply.ms});
    });
    const ended = () => {
      if (child !== proc) return;
      child = null; restarts++;
      fail('ocr_unavailable', 'The local OCR helper stopped');
    };
    proc.on('exit', ended);
    proc.on('error', ended);
    proc.stdin.on('error', () => {});
    return proc;
  };
  return {
    /** Recognize one PNG screenshot (Buffer). `roi` = [x, y, w, h] in pixels limits the work to one area. */
    recognize(png, {roi = null, signal} = {}) {
      if (!Buffer.isBuffer(png) || png.length < 8) return Promise.reject(new DeviceError('ocr_failed', 'Screenshot is empty'));
      const proc = start();
      const id = randomUUID();
      const path = join(tmpDir, `${id}.png`);
      writeFileSync(path, png, {mode: 0o600});
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); rmSync(path, {force: true});
          reject(new DeviceError('ocr_timeout', 'Text recognition exceeded its time budget')); }, requestTimeoutMs);
        pending.set(id, {resolve, reject, timer, path});
        signal?.addEventListener('abort', () => {
          if (!pending.has(id)) return;
          pending.delete(id); clearTimeout(timer); rmSync(path, {force: true});
          reject(new DeviceError('aborted', 'Text recognition was canceled'));
        }, {once: true});
        proc.stdin.write(`${JSON.stringify({id, path, ...(roi ? {roi} : {})})}\n`);
      });
    },
    get pending() { return pending.size; },
    close() {
      closed = true;
      fail('aborted', 'OCR helper closed');
      if (child) { try { child.stdin.end(); child.kill('SIGTERM'); } catch { /* already gone */ } child = null; }
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
