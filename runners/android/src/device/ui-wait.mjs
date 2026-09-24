import { DeviceError, throwIfAborted } from './bounded.mjs';

export const READ_TIMEOUT_MS = 10_000;
export const RETRY_DELAY_MS = 500;

/** Resolve after ms, or as soon as the signal aborts; the abort is then reported as a DeviceError. */
export function pause(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  }).then(() => throwIfAborted(signal));
}

/**
 * Read the hierarchy until the predicate accepts it or no further complete read fits in the budget.
 * Each read keeps its own bound, so a hung read still surfaces as device_timeout (closure required).
 * A read is never started unless it can finish inside the budget; on exhaustion the caller is settled:
 * the last read returned and nothing is in flight on the phone.
 */
export async function readUntil({ ui, predicate, signal, budgetMs, now = () => performance.now(),
  readTimeoutMs = READ_TIMEOUT_MS, retryDelayMs = RETRY_DELAY_MS }) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new DeviceError('invalid_timeout', 'Read budget must be positive');
  const startedAt = now();
  let attempts = 0;
  while (true) {
    throwIfAborted(signal);
    const tree = await ui.read({ signal, timeoutMs: readTimeoutMs });
    attempts++;
    const elapsedMs = now() - startedAt;
    if (predicate(tree, { attempts, elapsedMs })) return { tree, matched: true, attempts, elapsedMs };
    if (elapsedMs + retryDelayMs + readTimeoutMs > budgetMs) return { tree, matched: false, attempts, elapsedMs };
    await pause(retryDelayMs, signal);
  }
}
