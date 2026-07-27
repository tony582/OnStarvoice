(function attachSocialAccountUsage(root) {
  "use strict";

  const TRACKED_ACTIONS = new Set([
    "smartCapture",
    "captureSingleNote",
    "captureBloggerNotes",
    "captureKeywordNotes",
  ]);
  const MAX_QUEUE_SIZE = 1000;

  function text(value, limit = 1000) {
    const normalized = String(value ?? "").trim();
    return normalized.length > limit ? normalized.slice(0, limit) : normalized;
  }

  function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function nonNegativeInteger(value, maximum = 100000) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(maximum, parsed);
  }

  function createEventId() {
    if (root.crypto?.randomUUID) return root.crypto.randomUUID();
    return `usage-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  }

  function resultItems(response) {
    const data = objectValue(response?.data);
    const candidates = [
      data.items,
      data.notes,
      data.records,
      data.results,
    ];
    for (const value of candidates) {
      if (Array.isArray(value)) return value;
    }
    return [];
  }

  function capturedItemCount(action, response) {
    const items = resultItems(response);
    if (items.length > 0) return items.length;
    if (action === "captureSingleNote" && response?.ok === true) return 1;
    const data = objectValue(response?.data);
    return nonNegativeInteger(
      data.savedCount ??
        data.capturedCount ??
        data.totalCount ??
        data.filteredCount,
    );
  }

  function buildUsageEventFromRelay({
    action,
    platform,
    response = null,
    error = null,
    taskId = "",
    featureKey = "",
    observedAccount = null,
  } = {}) {
    const normalizedAction = text(action, 80);
    const normalizedPlatform = text(platform, 40).toLowerCase();
    if (
      !TRACKED_ACTIONS.has(normalizedAction) ||
      !["xiaohongshu", "douyin", "weibo"].includes(normalizedPlatform)
    ) {
      return null;
    }
    const succeeded = response?.ok === true && !error;
    const searches = normalizedAction === "captureKeywordNotes" ? 1 : 0;
    const enhancements = normalizedAction === "captureSingleNote" ? 1 : 0;
    // 详情增强单独计入 enhancements，避免同一次详情补采既算增强又算采集运行。
    // captureRuns 只表示列表/页面采集动作，三项指标因此可以独立解释。
    const captureRuns = normalizedAction === "captureSingleNote" ? 0 : 1;
    const capturedItems = capturedItemCount(normalizedAction, response);
    const account = objectValue(observedAccount);
    return {
      eventId: createEventId(),
      platform: normalizedPlatform,
      searches,
      enhancements,
      captureRuns,
      capturedItems,
      succeeded,
      occurredAt: new Date().toISOString(),
      accountIdentity:
        text(account.platformAccountId, 240) ||
        text(account.accountHandle, 160)
          ? {
              platformAccountId: text(account.platformAccountId, 240),
              accountHandle: text(account.accountHandle, 160),
              displayName: text(account.displayName, 160),
              confidence: text(account.confidence, 40) || "unknown",
              observedAt: text(account.observedAt, 80),
            }
          : null,
      metadata: {
        action: normalizedAction,
        taskId: text(taskId, 240),
        featureKey: text(featureKey, 120),
        errorCode: text(
          error?.code ||
            response?.error?.code ||
            response?.diagnostics?.errorCode,
          120,
        ),
      },
    };
  }

  function normalizeUsageQueue(value) {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    const result = [];
    for (const item of source.slice(-MAX_QUEUE_SIZE)) {
      const event = objectValue(item);
      const eventId = text(event.eventId, 240);
      if (!eventId || seen.has(eventId)) continue;
      seen.add(eventId);
      result.push({...event, eventId});
    }
    return result;
  }

  function appendUsageEvent(queue, event) {
    const normalized = normalizeUsageQueue(queue);
    if (!event?.eventId) return normalized;
    const next = normalized.filter(item => item.eventId !== event.eventId);
    next.push(event);
    return next.slice(-MAX_QUEUE_SIZE);
  }

  function acknowledgeUsageEvents(queue, eventIds) {
    const acknowledged = new Set(
      (Array.isArray(eventIds) ? eventIds : [])
        .map(value => text(value, 240))
        .filter(Boolean),
    );
    if (acknowledged.size === 0) return normalizeUsageQueue(queue);
    return normalizeUsageQueue(queue).filter(
      event => !acknowledged.has(event.eventId),
    );
  }

  root.OnStarvoiceSocialAccountUsage = Object.freeze({
    buildUsageEventFromRelay,
    normalizeUsageQueue,
    appendUsageEvent,
    acknowledgeUsageEvents,
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
