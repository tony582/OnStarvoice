import {once} from 'node:events';

const isRunning = child => child.exitCode == null && child.signalCode == null;

export function terminatePreviewBrowser(child) {
  try {
    if (child && isRunning(child)) child.kill('SIGTERM');
  } catch { /* Already gone. */ }
}

/** Wait for actual exit before another browser can use the same profile and port. */
export async function stopPreviewBrowsers(browsers) {
  const pending = [...browsers].filter(isRunning);
  if (!pending.length) return true;
  const controller = new AbortController();
  const exited = Promise.all(pending.map(child => once(child, 'exit', {signal: controller.signal})));
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    for (const child of pending) terminatePreviewBrowser(child);
    await exited;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
