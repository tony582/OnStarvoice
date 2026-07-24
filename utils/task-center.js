(function initializeTaskCenterCore(root) {
  "use strict";

  const TASK_LEDGER_VERSION = 1;
  const DEFAULT_RETENTION_DAYS = 30;
  const DEFAULT_MAX_TERMINAL_RUNS = 300;
  const DEFAULT_STALE_ACTIVE_AFTER_MS = 10 * 60 * 1000;
  const MAX_EVENTS_PER_RUN = 50;
  const MAX_TEXT_LENGTH = 500;
  const MAX_TITLE_LENGTH = 160;
  const MAX_ID_LENGTH = 180;
  const MAX_METADATA_KEYS = 24;
  const MAX_CHECKPOINT_KEYWORD_RESULTS = 500;

  const TERMINAL_STATUSES = new Set([
    "completed",
    "completed_with_warnings",
    "completed_with_failures",
    "failed",
    "canceled",
    "skipped",
  ]);

  const STATUS_ALIASES = Object.freeze({
    queued: "pending",
    pending: "pending",
    deferred: "pending",
    claimed: "running",
    started: "running",
    running: "running",
    capturing: "running",
    syncing: "running",
    retrying: "recovering",
    recovering: "recovering",
    paused: "needs_action",
    blocked: "needs_action",
    partial: "needs_action",
    needs_action: "needs_action",
    action_required: "needs_action",
    success: "completed",
    succeeded: "completed",
    done: "completed",
    completed: "completed",
    no_hit: "completed",
    partial_success: "completed_with_warnings",
    completed_with_warnings: "completed_with_warnings",
    completed_with_failures: "completed_with_failures",
    failure: "failed",
    error: "failed",
    failed: "failed",
    cancelled: "canceled",
    canceled: "canceled",
    stopped: "canceled",
    skipped: "skipped",
    skipped_no_balance: "skipped",
  });

  const SENSITIVE_KEY_PATTERN =
    /(?:^|[_-])(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|auth[_-]?(?:code|token)|access[_-]?token|refresh[_-]?token)(?:$|[_-])/i;

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function normalizeNow(value) {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value.getTime();
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
  }

  function sanitizeText(value, limit = MAX_TEXT_LENGTH) {
    let text = String(value == null ? "" : value).trim();
    if (!text) return "";

    text = text
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
      .replace(
        /([?&](?:code|token|access_token|refresh_token|api_key|auth_code)=)[^&#\s]*/gi,
        "$1[REDACTED]",
      )
      .replace(
        /\b(authorization|cookie|password|passwd|secret|token|api[_-]?key|auth[_-]?code|access[_-]?token|refresh[_-]?token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
        "$1=[REDACTED]",
      );

    return text.length > limit ? text.slice(0, limit) : text;
  }

  function sanitizeId(value, fallback = "") {
    return sanitizeText(value || fallback, MAX_ID_LENGTH);
  }

  function sanitizeStructuredValue(value, key = "", depth = 0) {
    const normalizedKey = String(key || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2");
    if (SENSITIVE_KEY_PATTERN.test(normalizedKey)) {
      return "[REDACTED]";
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") return sanitizeText(value);
    if (depth >= 2) return sanitizeText(value);
    if (Array.isArray(value)) {
      return value
        .slice(0, 20)
        .map((item) => sanitizeStructuredValue(item, "", depth + 1));
    }
    if (!value || typeof value !== "object") return sanitizeText(value);

    const safe = {};
    for (const [childKey, childValue] of Object.entries(value).slice(
      0,
      MAX_METADATA_KEYS,
    )) {
      const safeKey = sanitizeText(childKey, 80);
      if (!safeKey) continue;
      safe[safeKey] = sanitizeStructuredValue(
        childValue,
        safeKey,
        depth + 1,
      );
    }
    return safe;
  }

  function normalizeTimestamp(value) {
    if (value == null || value === "") return "";
    const numeric = typeof value === "number" ? value : Number.NaN;
    const timestamp = Number.isFinite(numeric)
      ? numeric
      : Date.parse(String(value));
    if (!Number.isFinite(timestamp)) return "";
    try {
      return new Date(timestamp).toISOString();
    } catch {
      return "";
    }
  }

  function timestampMs(value) {
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function newestTimestamp(...values) {
    let latestValue = "";
    let latestMs = 0;
    for (const value of values) {
      const normalized = normalizeTimestamp(value);
      const milliseconds = timestampMs(normalized);
      if (milliseconds >= latestMs && normalized) {
        latestMs = milliseconds;
        latestValue = normalized;
      }
    }
    return latestValue;
  }

  function oldestTimestamp(...values) {
    let oldestValue = "";
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const value of values) {
      const normalized = normalizeTimestamp(value);
      const milliseconds = timestampMs(normalized);
      if (normalized && milliseconds < oldestMs) {
        oldestMs = milliseconds;
        oldestValue = normalized;
      }
    }
    return oldestValue;
  }

  function normalizeNonNegativeInteger(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric)
      ? Math.max(0, Math.floor(numeric))
      : Math.max(0, Math.floor(Number(fallback) || 0));
  }

  function normalizeStatus(value, fallback = "pending") {
    const status = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    return STATUS_ALIASES[status] || fallback;
  }

  function isTerminalTaskStatus(status) {
    return TERMINAL_STATUSES.has(normalizeStatus(status, ""));
  }

  function normalizeCounts(source = {}) {
    const input = objectValue(source);
    const counts = objectValue(input.counts);
    const read = (key, aliases = []) => {
      if (hasOwn(counts, key)) return normalizeNonNegativeInteger(counts[key]);
      for (const alias of aliases) {
        if (hasOwn(input, alias)) return normalizeNonNegativeInteger(input[alias]);
      }
      return 0;
    };

    return {
      total: read("total", ["totalCount", "requestedTotalCount"]),
      processed: read("processed", ["processedCount", "scannedCount"]),
      saved: read("saved", ["savedCount", "newRecords", "hitCount"]),
      success: read("success", ["successCount"]),
      failed: read("failed", ["failedCount"]),
      skipped: read("skipped", ["skippedCount"]),
      retried: read("retried", ["retryCount", "retriedCount"]),
      warnings: read("warnings", ["warningCount"]),
    };
  }

  const COUNT_ALIASES = Object.freeze({
    total: ["totalCount", "requestedTotalCount"],
    processed: ["processedCount", "scannedCount"],
    saved: ["savedCount", "newRecords", "hitCount"],
    success: ["successCount"],
    failed: ["failedCount"],
    skipped: ["skippedCount"],
    retried: ["retryCount", "retriedCount"],
    warnings: ["warningCount"],
  });

  function mergeCountPatch(currentCounts, patch) {
    const next = {...normalizeCounts({counts: currentCounts})};
    const source = objectValue(patch);
    const nested = objectValue(source.counts);
    for (const [key, aliases] of Object.entries(COUNT_ALIASES)) {
      if (hasOwn(nested, key)) {
        next[key] = normalizeNonNegativeInteger(nested[key]);
        continue;
      }
      for (const alias of aliases) {
        if (hasOwn(source, alias)) {
          next[key] = normalizeNonNegativeInteger(source[alias]);
          break;
        }
      }
    }
    return next;
  }

  function normalizeProgress(value = {}) {
    const input = objectValue(value);
    const progress = {
      current: normalizeNonNegativeInteger(input.current),
      total: normalizeNonNegativeInteger(input.total),
      index: normalizeNonNegativeInteger(input.index),
      keyword: sanitizeText(input.keyword, 200),
      phase: sanitizeText(input.phase, 100),
      message: sanitizeText(input.message),
      retryCount: normalizeNonNegativeInteger(input.retryCount),
      maxRetries: normalizeNonNegativeInteger(input.maxRetries),
      round: normalizeNonNegativeInteger(input.round),
      totalRounds: normalizeNonNegativeInteger(input.totalRounds),
      remainingMs: normalizeNonNegativeInteger(input.remainingMs),
      savedCount: normalizeNonNegativeInteger(
        input.savedCount == null ? input.saved : input.savedCount,
      ),
      updatedAt: normalizeTimestamp(input.updatedAt),
    };
    return progress;
  }

  function normalizeError(value) {
    if (!value) return null;
    if (typeof value === "string") {
      const message = sanitizeText(value);
      return message ? {code: "", reason: "", message} : null;
    }
    const input = objectValue(value);
    const message = sanitizeText(
      input.message || input.errorMessage || input.detail || input.reason,
    );
    const code = sanitizeText(input.code || input.errorCode, 100);
    const reason = sanitizeText(input.reason, 160);
    if (!message && !code && !reason) return null;
    return {code, reason, message};
  }

  function normalizeEvent(event, index = 0, options = {}) {
    const input = objectValue(event);
    const now = normalizeNow(options.now);
    const at =
      normalizeTimestamp(input.at || input.createdAt || input.updatedAt) ||
      new Date(now).toISOString();
    const id =
      sanitizeId(input.id || input.eventId) ||
      `event_${timestampMs(at).toString(36)}_${normalizeNonNegativeInteger(index)}`;
    const rawStatus = String(input.status || "").trim();
    return {
      id,
      type: sanitizeText(input.type || input.eventType || "update", 100),
      status: rawStatus ? normalizeStatus(rawStatus) : "",
      at,
      message: sanitizeText(input.message || input.errorMessage),
      metadata: sanitizeStructuredValue(
        input.metadata || input.details || input.data || {},
      ),
    };
  }

  function normalizeEvents(events, options = {}) {
    const safeEvents = [];
    const byId = new Map();
    const source = Array.isArray(events) ? events.slice(-MAX_EVENTS_PER_RUN * 2) : [];
    for (let index = 0; index < source.length; index += 1) {
      const event = normalizeEvent(source[index], index, options);
      if (byId.has(event.id)) {
        safeEvents[byId.get(event.id)] = event;
      } else {
        byId.set(event.id, safeEvents.length);
        safeEvents.push(event);
      }
    }
    return safeEvents.slice(-MAX_EVENTS_PER_RUN);
  }

  function normalizeCheckpoint(value = {}) {
    const input = objectValue(value);
    const keywordResults = Array.isArray(input.keywordResults)
      ? input.keywordResults
          .slice(0, MAX_CHECKPOINT_KEYWORD_RESULTS)
          .map((entry) => {
            const source = objectValue(entry);
            const keyword = sanitizeText(source.keyword, 200);
            if (!keyword) return null;
            const errorCode = sanitizeText(
              source.errorCode || source.error_code || source?.error?.code,
              100,
            );
            const errorCategory = sanitizeText(
              source.errorCategory ||
                source.error_category ||
                source?.error?.category,
              100,
            );
            const keywordServiceAbnormal =
              errorCode.toUpperCase() ===
              "DOUYIN_SEARCH_SERVICE_ABNORMAL";
            return {
              round: Math.max(1, normalizeNonNegativeInteger(source.round, 1)),
              index: normalizeNonNegativeInteger(source.index),
              keyword,
              status: sanitizeText(source.status, 60),
              attemptCount: normalizeNonNegativeInteger(source.attemptCount),
              savedCount: normalizeNonNegativeInteger(source.savedCount),
              error: sanitizeText(source.error),
              ...(errorCode ? {errorCode} : {}),
              ...(errorCategory ? {errorCategory} : {}),
              ...(!keywordServiceAbnormal &&
              source.securityBlocked === true
                ? {securityBlocked: true}
                : {}),
              ...(!keywordServiceAbnormal &&
              source.requiresManualAction === true
                ? {requiresManualAction: true}
                : {}),
              finishedAt: normalizeTimestamp(source.finishedAt),
            };
          })
          .filter(Boolean)
      : [];
    return {
      round: normalizeNonNegativeInteger(input.round),
      keywordIndex: normalizeNonNegativeInteger(input.keywordIndex),
      currentKeyword: sanitizeText(input.currentKeyword || input.keyword, 200),
      phase: sanitizeText(input.phase, 100),
      completedKeywords: Array.isArray(input.completedKeywords)
        ? input.completedKeywords.slice(0, 200).map((item) => sanitizeText(item, 200)).filter(Boolean)
        : [],
      failedKeywords: Array.isArray(input.failedKeywords)
        ? input.failedKeywords.slice(0, 200).map((item) => sanitizeText(item, 200)).filter(Boolean)
        : [],
      skippedKeywords: Array.isArray(input.skippedKeywords)
        ? input.skippedKeywords.slice(0, 200).map((item) => sanitizeText(item, 200)).filter(Boolean)
        : [],
      keywordResults,
      attempts: sanitizeStructuredValue(input.attempts || {}),
    };
  }

  function normalizeTaskRun(input = {}, options = {}) {
    const source = objectValue(input);
    const now = normalizeNow(options.now);
    const nowIso = new Date(now).toISOString();
    const id = sanitizeId(
      source.id || source.taskId || source.runId || source.executionId,
    );
    const status = normalizeStatus(source.status);
    const terminal = isTerminalTaskStatus(status);
    const createdAt =
      normalizeTimestamp(source.createdAt) ||
      normalizeTimestamp(source.startedAt) ||
      normalizeTimestamp(source.updatedAt) ||
      nowIso;
    const startedAt = normalizeTimestamp(source.startedAt);
    const updatedAt =
      normalizeTimestamp(source.updatedAt) ||
      normalizeTimestamp(source.finishedAt) ||
      startedAt ||
      createdAt;
    const finishedAt = terminal
      ? normalizeTimestamp(source.finishedAt) || updatedAt || nowIso
      : "";

    return {
      id,
      taskId: id,
      taskType: sanitizeText(
        source.taskType || source.type || source.featureKey || "task",
        100,
      ),
      featureKey: sanitizeText(source.featureKey, 120),
      title: sanitizeText(source.title || source.name || "任务", MAX_TITLE_LENGTH),
      source: sanitizeText(source.source || "extension", 100),
      trigger: sanitizeText(source.trigger, 100),
      platform: sanitizeText(source.platform || "unknown", 60).toLowerCase(),
      status,
      attemptId: sanitizeId(source.attemptId),
      attemptNumber: normalizeNonNegativeInteger(source.attemptNumber),
      progressSeq: normalizeNonNegativeInteger(source.progressSeq),
      heartbeatAt: normalizeTimestamp(source.heartbeatAt),
      businessProgressAt: normalizeTimestamp(source.businessProgressAt),
      createdAt,
      startedAt,
      updatedAt,
      finishedAt,
      message: sanitizeText(source.message),
      error: normalizeError(source.error || source.errorMessage),
      counts: normalizeCounts(source),
      progress: normalizeProgress(source.progress),
      checkpoint: normalizeCheckpoint(source.checkpoint),
      events: normalizeEvents(source.events, {now}),
      metadata: sanitizeStructuredValue(source.metadata || {}),
      runnerTabId:
        Number.isFinite(Number(source.runnerTabId)) && Number(source.runnerTabId) > 0
          ? Math.floor(Number(source.runnerTabId))
          : null,
      legacy: source.legacy === true,
      incomplete: source.incomplete === true,
      legacySource: sanitizeText(source.legacySource, 100),
      incompleteReason: sanitizeText(source.incompleteReason),
    };
  }

  function rejectMerge(reason, current) {
    return {accepted: false, reason, run: current};
  }

  function mergeTaskRun(current, patch = {}, options = {}) {
    const now = normalizeNow(options.now);
    const base = normalizeTaskRun(current, {now});
    const input = objectValue(patch);
    const patchId = sanitizeId(
      input.id || input.taskId || input.runId || input.executionId,
    );

    if (!base.id) {
      const created = normalizeTaskRun(input, {now});
      return created.id
        ? {accepted: true, reason: "created", run: created}
        : rejectMerge("invalid_id", base);
    }
    if (patchId && patchId !== base.id) {
      return rejectMerge("invalid_id", base);
    }
    if (isTerminalTaskStatus(base.status)) {
      return rejectMerge("terminal_absorbed", base);
    }

    const incomingAttemptId = sanitizeId(input.attemptId);
    const attemptMismatch =
      Boolean(base.attemptId) &&
      Boolean(incomingAttemptId) &&
      base.attemptId !== incomingAttemptId;
    if (attemptMismatch) {
      const incomingAttemptNumber = normalizeNonNegativeInteger(
        input.attemptNumber,
      );
      const transitionAllowed =
        options.allowAttemptTransition === true &&
        incomingAttemptNumber > base.attemptNumber;
      if (!transitionAllowed) {
        return rejectMerge("attempt_mismatch", base);
      }
    }

    if (
      hasOwn(input, "progressSeq") &&
      normalizeNonNegativeInteger(input.progressSeq) < base.progressSeq
    ) {
      return rejectMerge("stale_progress", base);
    }

    const nowIso = new Date(now).toISOString();
    const mergedInput = {
      ...base,
      ...input,
      id: base.id,
      taskId: base.id,
      createdAt: base.createdAt,
      startedAt: base.startedAt || normalizeTimestamp(input.startedAt),
      updatedAt: nowIso,
      counts: mergeCountPatch(base.counts, input),
      progress: hasOwn(input, "progress")
        ? {...base.progress, ...objectValue(input.progress)}
        : base.progress,
      checkpoint: hasOwn(input, "checkpoint")
        ? {...base.checkpoint, ...objectValue(input.checkpoint)}
        : base.checkpoint,
      metadata: hasOwn(input, "metadata")
        ? {...objectValue(base.metadata), ...objectValue(input.metadata)}
        : base.metadata,
      events: hasOwn(input, "events")
        ? [...base.events, ...(Array.isArray(input.events) ? input.events : [])]
        : base.events,
      heartbeatAt: hasOwn(input, "heartbeatAt")
        ? newestTimestamp(base.heartbeatAt, input.heartbeatAt)
        : base.heartbeatAt,
      businessProgressAt: hasOwn(input, "businessProgressAt")
        ? newestTimestamp(base.businessProgressAt, input.businessProgressAt)
        : base.businessProgressAt,
      progressSeq: hasOwn(input, "progressSeq")
        ? normalizeNonNegativeInteger(input.progressSeq)
        : base.progressSeq,
      attemptId: incomingAttemptId || base.attemptId,
      attemptNumber: hasOwn(input, "attemptNumber")
        ? normalizeNonNegativeInteger(input.attemptNumber)
        : base.attemptNumber,
    };

    const incomingStatus = hasOwn(input, "status")
      ? normalizeStatus(input.status, base.status)
      : base.status;
    if (isTerminalTaskStatus(incomingStatus)) {
      mergedInput.finishedAt = normalizeTimestamp(input.finishedAt) || nowIso;
    } else {
      mergedInput.finishedAt = "";
    }

    return {
      accepted: true,
      reason: "merged",
      run: normalizeTaskRun(mergedInput, {now}),
    };
  }

  function activityTimestamp(run) {
    return Math.max(
      timestampMs(run.finishedAt),
      timestampMs(run.businessProgressAt),
      timestampMs(run.heartbeatAt),
      timestampMs(run.updatedAt),
      timestampMs(run.startedAt),
      timestampMs(run.createdAt),
    );
  }

  function normalizeTaskLedger(input = {}, options = {}) {
    const now = normalizeNow(options.now);
    const source = Array.isArray(input) ? {runs: input} : objectValue(input);
    const candidates = Array.isArray(source.runs)
      ? source.runs
      : Array.isArray(source.tasks)
        ? source.tasks
        : Array.isArray(source.items)
          ? source.items
          : [];
    const byId = new Map();

    for (const candidate of candidates) {
      const normalized = normalizeTaskRun(candidate, {now});
      if (!normalized.id) continue;
      const existing = byId.get(normalized.id);
      if (!existing) {
        byId.set(normalized.id, normalized);
        continue;
      }
      const merged = mergeTaskRun(existing, normalized, {
        now,
        allowAttemptTransition: true,
      });
      if (merged.accepted) {
        byId.set(normalized.id, merged.run);
      }
    }

    const retentionDays = Math.max(
      0,
      Number.isFinite(Number(options.retentionDays))
        ? Number(options.retentionDays)
        : DEFAULT_RETENTION_DAYS,
    );
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const maxTerminalRuns = Math.max(
      0,
      normalizeNonNegativeInteger(
        options.maxTerminalRuns,
        DEFAULT_MAX_TERMINAL_RUNS,
      ),
    );
    const activeRuns = [];
    const terminalRuns = [];

    for (const run of byId.values()) {
      if (!isTerminalTaskStatus(run.status)) {
        activeRuns.push(run);
        continue;
      }
      const finishedMs =
        timestampMs(run.finishedAt) ||
        timestampMs(run.updatedAt) ||
        timestampMs(run.createdAt);
      if (finishedMs && finishedMs < cutoff) continue;
      terminalRuns.push(run);
    }

    terminalRuns.sort((left, right) => activityTimestamp(right) - activityTimestamp(left));
    const runs = [...activeRuns, ...terminalRuns.slice(0, maxTerminalRuns)].sort(
      (left, right) => activityTimestamp(right) - activityTimestamp(left),
    );
    const latestRunAt = runs.reduce(
      (latest, run) => newestTimestamp(latest, run.updatedAt),
      "",
    );

    return {
      version: TASK_LEDGER_VERSION,
      runs,
      clearedAt: normalizeTimestamp(source.clearedAt),
      updatedAt:
        normalizeTimestamp(source.updatedAt) || latestRunAt || new Date(now).toISOString(),
    };
  }

  function reconcileStaleTaskLedger(input = {}, options = {}) {
    const now = normalizeNow(options.now);
    const nowIso = new Date(now).toISOString();
    const staleAfterMs = Math.max(
      0,
      Number.isFinite(Number(options.staleAfterMs))
        ? Number(options.staleAfterMs)
        : DEFAULT_STALE_ACTIVE_AFTER_MS,
    );
    const normalized = normalizeTaskLedger(input, {...options, now});
    if (!staleAfterMs) return normalized;

    let changed = false;
    const runs = normalized.runs.map((run) => {
      if (
        !["pending", "running", "recovering"].includes(run.status) ||
        options.isTaskActive?.(run) === true
      ) {
        return run;
      }
      const lastActivityAt = activityTimestamp(run);
      if (!lastActivityAt || now - lastActivityAt < staleAfterMs) {
        return run;
      }

      changed = true;
      return normalizeTaskRun(
        {
          ...run,
          status: "canceled",
          finishedAt: nowIso,
          updatedAt: nowIso,
          message: "长时间无业务进展，已自动结束陈旧任务记录",
          events: [
            ...run.events,
            {
              id: `stale_reconciled_${now}`,
              type: "stale_reconciled",
              status: "canceled",
              at: nowIso,
              message: "长时间无业务进展，已自动结束陈旧任务记录",
            },
          ],
        },
        {now},
      );
    });

    if (!changed) return normalized;
    return normalizeTaskLedger(
      {
        ...normalized,
        runs,
        updatedAt: nowIso,
      },
      {...options, now},
    );
  }

  function upsertTaskRun(ledger, patch = {}, options = {}) {
    const now = normalizeNow(options.now);
    const normalizedLedger = normalizeTaskLedger(ledger, {...options, now});
    const input = objectValue(patch);
    const candidateId = sanitizeId(
      input.id || input.taskId || input.runId || input.executionId,
    );
    if (!candidateId) {
      return {
        accepted: false,
        reason: "invalid_id",
        run: null,
        ledger: normalizedLedger,
      };
    }

    const existing = normalizedLedger.runs.find((run) => run.id === candidateId);
    let result;
    if (existing) {
      result = mergeTaskRun(existing, input, options);
    } else {
      const created = normalizeTaskRun(
        {
          ...input,
          id: candidateId,
          createdAt: input.createdAt || new Date(now).toISOString(),
          updatedAt: input.updatedAt || new Date(now).toISOString(),
        },
        {now},
      );
      result = {accepted: true, reason: "created", run: created};
    }

    if (!result.accepted) {
      return {...result, ledger: normalizedLedger};
    }

    const nextRuns = normalizedLedger.runs.filter((run) => run.id !== candidateId);
    nextRuns.push(result.run);
    const nextLedger = normalizeTaskLedger(
      {
        version: TASK_LEDGER_VERSION,
        runs: nextRuns,
        clearedAt: normalizedLedger.clearedAt,
        updatedAt: new Date(now).toISOString(),
      },
      {...options, now},
    );
    return {...result, ledger: nextLedger};
  }

  function appendTaskEvent(run, event = {}, options = {}) {
    const now = normalizeNow(options.now);
    const normalizedRun = normalizeTaskRun(run, {now});
    const normalizedEvent = normalizeEvent(event, normalizedRun.events.length, {
      now,
    });
    const events = normalizedRun.events.filter(
      (existing) => existing.id !== normalizedEvent.id,
    );
    events.push(normalizedEvent);
    return normalizeTaskRun(
      {
        ...normalizedRun,
        events: events.slice(-MAX_EVENTS_PER_RUN),
        updatedAt: newestTimestamp(normalizedRun.updatedAt, normalizedEvent.at),
      },
      {now},
    );
  }

  function pick(source, names, fallback = undefined) {
    const input = objectValue(source);
    for (const name of names) {
      if (hasOwn(input, name) && input[name] != null && input[name] !== "") {
        return input[name];
      }
    }
    return fallback;
  }

  function arrayFrom(value, keys = []) {
    if (Array.isArray(value)) return value;
    const input = objectValue(value);
    for (const key of keys) {
      if (Array.isArray(input[key])) return input[key];
    }
    return [];
  }

  function legacyMarker(source) {
    return {
      legacy: true,
      incomplete: true,
      legacySource: source,
      incompleteReason: "升级前执行过程不可完整还原",
    };
  }

  function buildLegacySyncRun(entry, index, now) {
    const input = objectValue(entry);
    const failed = normalizeNonNegativeInteger(input.failedCount);
    const success = normalizeNonNegativeInteger(input.successCount);
    const skipped = normalizeNonNegativeInteger(input.skippedCount);
    const finishedAt = pick(input, ["finishedAt", "createdAt"]);
    let status = finishedAt ? "completed" : "completed_with_warnings";
    if (failed > 0 && success > 0) status = "completed_with_warnings";
    else if (failed > 0) status = "failed";
    else if (input.status) {
      const normalizedInputStatus = normalizeStatus(input.status, status);
      status = isTerminalTaskStatus(normalizedInputStatus)
        ? normalizedInputStatus
        : "completed_with_warnings";
    }
    const trigger = sanitizeText(input.trigger, 100);
    const isMonitor = trigger === "monitor_run_now";
    const rawId = pick(input, ["id", "taskId", "batchId"]);
    const stablePart = rawId || pick(input, ["startedAt", "createdAt"], index);

    return normalizeTaskRun(
      {
        id: `legacy:${isMonitor ? "monitor-local" : "sync"}:${stablePart}`,
        taskType: isMonitor ? "monitor" : "sync",
        featureKey: sanitizeText(input.syncType || input.workflow, 120),
        title: isMonitor ? "监控立即执行" : "数据同步",
        source: "local_history",
        trigger,
        platform: input.platform,
        status,
        createdAt: pick(input, ["createdAt", "startedAt"]),
        startedAt: input.startedAt,
        updatedAt: pick(input, ["finishedAt", "createdAt", "startedAt"]),
        finishedAt: isTerminalTaskStatus(status) ? finishedAt : "",
        message: input.message || input.errorMessage,
        error: input.frontendError || input.error || input.errorMessage,
        totalCount: pick(input, ["totalCount", "requestedTotalCount"]),
        processedCount: Math.max(0, success + failed + skipped),
        successCount: success,
        failedCount: failed,
        skippedCount: skipped,
        savedCount: success,
        metadata: {
          syncType: input.syncType,
          workflow: input.workflow,
          target: input.target,
        },
        ...legacyMarker("sync_history"),
      },
      {now},
    );
  }

  function normalizeLegacyMonitorEntry(entry, index) {
    const input = objectValue(entry);
    return {
      id: sanitizeId(pick(input, ["id", "executionId", "execution_id"])) ||
        `unknown_${index}`,
      batchId: sanitizeId(pick(input, ["batchId", "batch_id"])),
      subscriptionId: sanitizeId(
        pick(input, ["subscriptionId", "subscription_id"]),
      ),
      status: normalizeStatus(input.status),
      rawStatus: sanitizeText(input.status, 80),
      platform: sanitizeText(input.platform || "unknown", 60).toLowerCase(),
      title: sanitizeText(
        pick(input, ["bloggerName", "blogger_name", "name", "keyword"]),
        MAX_TITLE_LENGTH,
      ),
      createdAt: normalizeTimestamp(pick(input, ["createdAt", "created_at"])),
      startedAt: normalizeTimestamp(pick(input, ["startedAt", "started_at"])),
      updatedAt: normalizeTimestamp(pick(input, ["updatedAt", "updated_at"])),
      finishedAt: normalizeTimestamp(pick(input, ["finishedAt", "finished_at"])),
      recordsFound: normalizeNonNegativeInteger(
        pick(input, ["recordsFound", "records_found", "scannedCount", "scanned_count"]),
      ),
      saved: normalizeNonNegativeInteger(
        pick(input, ["newRecords", "new_records", "hitCount", "hit_count"]),
      ),
      updatedRecords: normalizeNonNegativeInteger(
        pick(input, ["updatedRecords", "updated_records"]),
      ),
      negativeCount: normalizeNonNegativeInteger(
        pick(input, ["negativeCount", "negative_count"]),
      ),
      errorMessage: sanitizeText(
        pick(input, ["errorMessage", "error_message", "message"]),
      ),
    };
  }

  function aggregateMonitorStatus(entries) {
    const statuses = entries.map((entry) => entry.status);
    if (statuses.some((status) => status === "running")) return "running";
    if (statuses.some((status) => status === "recovering")) return "recovering";
    if (statuses.some((status) => status === "needs_action")) return "needs_action";
    if (statuses.some((status) => status === "pending")) return "pending";
    if (statuses.every((status) => status === "canceled")) return "canceled";
    if (statuses.every((status) => status === "skipped")) return "skipped";
    const failedCount = statuses.filter((status) => status === "failed").length;
    const completedCount = statuses.filter(
      (status) => status === "completed" || status === "completed_with_warnings",
    ).length;
    if (failedCount && completedCount) return "completed_with_warnings";
    if (failedCount === statuses.length && statuses.length) return "failed";
    const canceledCount = statuses.filter((status) => status === "canceled").length;
    return failedCount || canceledCount ? "completed_with_warnings" : "completed";
  }

  function buildLegacyMonitorRuns(executions, now) {
    const groups = new Map();
    executions.forEach((entry, index) => {
      const normalized = normalizeLegacyMonitorEntry(entry, index);
      const key = normalized.batchId
        ? `batch:${normalized.batchId}`
        : `execution:${normalized.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(normalized);
    });

    const runs = [];
    for (const [groupKey, entries] of groups.entries()) {
      const aggregatedStatus = aggregateMonitorStatus(entries);
      const status = isTerminalTaskStatus(aggregatedStatus)
        ? aggregatedStatus
        : "completed_with_warnings";
      const platforms = [...new Set(entries.map((entry) => entry.platform).filter(Boolean))];
      const startedAt = oldestTimestamp(
        ...entries.map((entry) => entry.startedAt || entry.createdAt),
      );
      const updatedAt = newestTimestamp(
        ...entries.map(
          (entry) => entry.finishedAt || entry.updatedAt || entry.startedAt || entry.createdAt,
        ),
      );
      const errorMessages = entries.map((entry) => entry.errorMessage).filter(Boolean);
      const successCount = entries.filter((entry) => entry.status === "completed").length;
      const failedCount = entries.filter((entry) => entry.status === "failed").length;
      const skippedCount = entries.filter((entry) => entry.status === "skipped").length;
      const events = entries.map((entry) => ({
        id: `legacy_monitor_${entry.id}`,
        type: "monitor_execution",
        status: entry.status,
        at: entry.finishedAt || entry.updatedAt || entry.startedAt || entry.createdAt,
        message: entry.errorMessage || entry.title,
        metadata: {
          executionId: entry.id,
          subscriptionId: entry.subscriptionId,
          recordsFound: entry.recordsFound,
          saved: entry.saved,
        },
      }));

      runs.push(
        normalizeTaskRun(
          {
            id: `legacy:monitor:${groupKey}`,
            taskType: "monitor",
            featureKey: "monitor_execution",
            title: entries.length > 1 ? "监控批次" : entries[0].title || "博主监控",
            source: "backend_history",
            trigger: "monitor",
            platform: platforms.length === 1 ? platforms[0] : "mixed",
            status,
            createdAt: oldestTimestamp(...entries.map((entry) => entry.createdAt)) || startedAt,
            startedAt,
            updatedAt,
            finishedAt: isTerminalTaskStatus(status) ? updatedAt : "",
            message: errorMessages[0] || "",
            error: failedCount > 0 ? errorMessages[0] || "监控执行失败" : null,
            totalCount: entries.length,
            processedCount: entries.reduce((sum, entry) => sum + entry.recordsFound, 0),
            savedCount: entries.reduce((sum, entry) => sum + entry.saved, 0),
            successCount,
            failedCount,
            skippedCount,
            warningCount: entries.reduce((sum, entry) => sum + entry.negativeCount, 0),
            events,
            ...legacyMarker("monitor_executions"),
          },
          {now},
        ),
      );
    }
    return runs;
  }

  function buildLegacyUnattendedRun(planValue, requestValue, now) {
    const plan = objectValue(planValue);
    const request = objectValue(requestValue);
    const hasRequest = Boolean(
      request.id || request.requestId || request.status || request.createdAt,
    );
    const progress = objectValue(
      hasRequest ? request.progress : plan.lastRunProgress,
    );
    const statusValue = hasRequest ? request.status : plan.lastRunStatus;
    if (!statusValue) return null;

    const status = normalizeStatus(statusValue);
    const requestId = sanitizeId(request.id || request.requestId);
    const stablePart =
      requestId ||
      sanitizeId(plan.lastRunAt || plan.updatedAt || plan.nextRunAt) ||
      "latest";
    const keywords = Array.isArray(
      objectValue(request.planSnapshot).keywords,
    )
      ? request.planSnapshot.keywords
      : Array.isArray(plan.keywords)
        ? plan.keywords
        : [];
    const total = normalizeNonNegativeInteger(progress.total, keywords.length);
    const current = normalizeNonNegativeInteger(progress.current);
    const updatedAt = pick(
      request,
      ["updatedAt", "finishedAt", "startedAt", "createdAt"],
      plan.lastRunAt || plan.updatedAt,
    );

    return normalizeTaskRun(
      {
        id: `legacy:unattended:${stablePart}`,
        taskType: "unattended_keyword_capture",
        featureKey: "unattended_keyword_plan",
        title: "无人值守关键词采集",
        source: "unattended_plan",
        trigger: "schedule",
        platform: request.platform || request.planSnapshot?.platform || plan.platform,
        status,
        attemptId: request.attemptId,
        attemptNumber: request.attemptNumber,
        progressSeq: request.progressSeq,
        heartbeatAt: request.heartbeatAt,
        businessProgressAt:
          request.businessProgressAt || progress.updatedAt || "",
        createdAt: request.createdAt || plan.lastRunAt || plan.updatedAt,
        startedAt: request.startedAt,
        updatedAt,
        finishedAt: isTerminalTaskStatus(status)
          ? request.finishedAt || updatedAt
          : "",
        message:
          request.message || plan.lastRunMessage || progress.message || "",
        error: request.error,
        totalCount: total,
        processedCount: current,
        savedCount: pick(progress, ["savedCount", "saved"]),
        retryCount: pick(progress, ["retryCount", "retried"]),
        progress,
        runnerTabId: request.runnerTabId,
        metadata: {
          mode: plan.mode,
          scheduledAt: request.scheduledAt || plan.lastRunAt,
          keywordCount: keywords.length,
        },
        ...legacyMarker(hasRequest ? "unattended_request" : "unattended_plan"),
      },
      {now},
    );
  }

  function buildLegacyTaskCenterItems(input = {}, options = {}) {
    const now = normalizeNow(options.now);
    const source = objectValue(input);
    const syncEntries = arrayFrom(
      source.syncEntries || source.syncHistory,
      ["entries", "items"],
    );
    const monitorExecutions = arrayFrom(
      source.monitorExecutions || source.executions || source.monitor,
      ["items", "executions", "data"],
    );
    const unattendedPlan =
      source.unattendedPlan ||
      source.unattendedKeywordPlan ||
      source.plan ||
      null;
    const unattendedRequest =
      source.unattendedRequest ||
      source.unattendedKeywordRunRequest ||
      source.request ||
      null;

    const items = syncEntries.map((entry, index) =>
      buildLegacySyncRun(entry, index, now),
    );
    items.push(...buildLegacyMonitorRuns(monitorExecutions, now));
    const unattendedRun = buildLegacyUnattendedRun(
      unattendedPlan,
      unattendedRequest,
      now,
    );
    if (unattendedRun) items.push(unattendedRun);

    // 数据池没有可靠的任务边界，故意不读取 input.dataPool/input.records。
    return items.sort((left, right) => activityTimestamp(right) - activityTimestamp(left));
  }

  root.OnStarvoiceTaskCenterCore = Object.freeze({
    TASK_LEDGER_VERSION,
    TERMINAL_STATUSES,
    isTerminalTaskStatus,
    normalizeTaskRun,
    normalizeTaskLedger,
    reconcileStaleTaskLedger,
    mergeTaskRun,
    upsertTaskRun,
    appendTaskEvent,
    buildLegacyTaskCenterItems,
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
