/**
 * Build one stable identity before a capture is exposed as running in the UI.
 * The bound runner tab must not follow later active-tab changes.
 */

export function createCaptureRequestId(prefix = 'capture') {
  const normalizedPrefix =
    String(prefix || 'capture')
      .trim()
      .replace(/[^a-z0-9_-]+/gi, '_') || 'capture';
  const randomPart =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${normalizedPrefix}_${Date.now().toString(36)}_${randomPart}`;
}

function normalizeRunnerTabId(value) {
  const tabId = Number(value);
  return Number.isFinite(tabId) && tabId > 0 ? tabId : null;
}

export async function ensureCommentCaptureIdentity({
  captureRequestId = '',
  runnerTabId = null,
  resolveRunnerTab = null,
} = {}) {
  const requestId =
    String(captureRequestId || '').trim() || createCaptureRequestId('comments');
  let boundRunnerTabId = normalizeRunnerTabId(runnerTabId);

  if (!boundRunnerTabId && typeof resolveRunnerTab === 'function') {
    const resolvedTab = await resolveRunnerTab();
    boundRunnerTabId = normalizeRunnerTabId(resolvedTab?.id ?? resolvedTab);
  }

  if (!boundRunnerTabId) {
    throw new Error('未找到可用的评论采集标签页');
  }

  return Object.freeze({
    captureRequestId: requestId,
    runnerTabId: boundRunnerTabId,
  });
}
