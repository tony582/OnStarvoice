import {STORAGE_KEY} from "./constants.js";
import {
  getAuth,
  getCapture,
  getDataPool,
  getMonitor,
  getRuntime,
  getSync,
  getTaskLedger,
} from "./storage.js";
import {resolveCanonicalFeatureKey} from "./features/registry.js";
import {normalizeTaskContext, serializeTaskContext} from "./task-context.js";

const MAX_RECENT_ACTIONS = 30;
const MAX_RECENT_ERRORS = 20;
const MAX_RECENT_STAGES = 60;
const MAX_RECENT_TASKS = 20;
const MAX_TEXT_LENGTH = 220;
const MAX_HEALTH_LATENCY_MS = 2 * 60 * 1000;
const MAX_HEALTH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HEAP_MB = 1024 * 1024;
const KNOWN_SECRET_TOKEN_FAMILY_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:xox[baprs][_-][A-Za-z0-9_-]{10,}|glpat[_-][A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16})(?:$|[^A-Za-z0-9])/iu;
const SENSITIVE_KEY_PATTERN =
  /(token|cookie|secret|password|authorization|credential|code|feishuAppToken|appToken|body|content|comments?|text|payload)/i;
const SENSITIVE_STAGE_KEY_PATTERN =
  /(token|cookie|secret|password|authorization|credential|code|feishuAppToken|appToken|body|payload|rawText|commentText|contentText|(^|[._-])(?:content|text)($|[._-]))/i;

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, limit = MAX_TEXT_LENGTH) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > limit ? text.slice(0, limit) : text;
}

export function sanitizeDiagnosticText(value, limit = MAX_TEXT_LENGTH) {
  return normalizeText(value, limit)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, "[CREDENTIAL_REDACTED]")
    .replace(
      /\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/giu,
      "[REDACTED]",
    )
    .replace(
      /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      "[CREDENTIAL_REDACTED]",
    )
    .replace(/\b[A-Za-z0-9]{32,}\b/gu, "[CREDENTIAL_REDACTED]")
    .replace(
      /\b(authorization|cookie|password|passwd|secret|token|api[_-]?key|auth(?:entication)?[_-]?code|activation[_-]?code|credential|session)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
      "$1=[REDACTED]",
    )
    .replace(
      /\b(authorization|cookie|password|passwd|secret|token|api[_-]?key|auth(?:entication)?[_-]?code|activation[_-]?code|credential|session|bearer)[_.:-]+[A-Za-z0-9._~+\/-]+\b/giu,
      "$1_[REDACTED]",
    )
    .replace(/https?:\/\/[^\s<>"']+/giu, "[URL_REDACTED]");
}

function getChromeStorage() {
  if (
    typeof chrome === "undefined" ||
    !chrome?.storage?.local ||
    typeof chrome.storage.local.get !== "function"
  ) {
    return null;
  }
  return chrome.storage.local;
}

async function readDiagnosticsState() {
  const storage = getChromeStorage();
  if (!storage) {
    return getDefaultDiagnosticsState();
  }

  try {
    const result = await storage.get(STORAGE_KEY.DIAGNOSTICS);
    return normalizeDiagnosticsState(result?.[STORAGE_KEY.DIAGNOSTICS]);
  } catch {
    return getDefaultDiagnosticsState();
  }
}

async function writeDiagnosticsState(state) {
  const storage = getChromeStorage();
  if (!storage) {
    return false;
  }

  try {
    await storage.set({
      [STORAGE_KEY.DIAGNOSTICS]: normalizeDiagnosticsState(state),
    });
    return true;
  } catch {
    return false;
  }
}

function getDefaultDiagnosticsState() {
  return {
    version: 1,
    recentActions: [],
    recentErrors: [],
    recentStages: [],
    recentTasks: [],
    lastUpdatedAt: nowIso(),
  };
}

function normalizeDiagnosticsState(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    version: 1,
    recentActions: Array.isArray(source.recentActions)
      ? source.recentActions
          .slice(0, MAX_RECENT_ACTIONS)
          .map((item) => normalizeEvent(item))
      : [],
    recentErrors: Array.isArray(source.recentErrors)
      ? source.recentErrors.slice(0, MAX_RECENT_ERRORS).map((item) => ({
          ...normalizeEvent(item),
          error: normalizeError(item?.error, "runtime_error"),
        }))
      : [],
    recentStages: Array.isArray(source.recentStages)
      ? source.recentStages
          .slice(0, MAX_RECENT_STAGES)
          .map((item) => normalizeStageTrace(item))
      : [],
    recentTasks: Array.isArray(source.recentTasks)
      ? source.recentTasks
          .slice(0, MAX_RECENT_TASKS)
          .map((item) => normalizeEvent(item))
      : [],
    lastUpdatedAt: normalizeText(source.lastUpdatedAt, 80) || nowIso(),
  };
}

function safeUrlParts(rawUrl = "") {
  try {
    const parsed = new URL(String(rawUrl || ""));
    const hostname = String(parsed.hostname || "").toLowerCase();
    const host = hostname === "douyin.com" || hostname.endsWith(".douyin.com")
      ? "douyin.com"
      : hostname === "xiaohongshu.com" || hostname.endsWith(".xiaohongshu.com")
        ? "xiaohongshu.com"
        : hostname === "weibo.com" || hostname.endsWith(".weibo.com")
          ? "weibo.com"
          : "other";
    const pathname = String(parsed.pathname || "/").toLowerCase();
    const path = /\/(?:video|note)\//u.test(pathname)
      ? "/work/:id"
      : /\/user(?:\/profile)?\//u.test(pathname)
        ? "/profile/:id"
        : /\/search(?:\/|$)|\/jingxuan\/search/u.test(pathname)
          ? "/search/:query"
          : /\/search_result(?:\/|$)/u.test(pathname)
            ? "/search_result"
            : /\/explore(?:\/|$)/u.test(pathname)
              ? "/explore"
              : pathname === "/"
                ? "/"
                : "/other";
    return {
      host,
      path,
    };
  } catch {
    return {
      host: "",
      path: "",
    };
  }
}

function boundedMetric(
  value,
  {minimum = 0, maximum = Number.MAX_SAFE_INTEGER, decimals = 0} = {},
) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const bounded = Math.min(maximum, Math.max(minimum, parsed));
  const factor = 10 ** Math.max(0, Math.min(3, decimals));
  return Math.round(bounded * factor) / factor;
}

function timestampValue(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1000000000000) return numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function healthAgeMs(value, now = Date.now()) {
  const timestamp = timestampValue(value);
  if (timestamp <= 0) return null;
  return boundedMetric(now - timestamp, {
    minimum: 0,
    maximum: MAX_HEALTH_AGE_MS,
  });
}

function healthTimestamp(value) {
  const timestamp = timestampValue(value);
  return timestamp > 0 ? new Date(timestamp).toISOString() : "";
}

function healthCode(value, limit = 80, fallback = "unknown") {
  const raw = normalizeText(value, Math.max(limit * 4, 320));
  const compact = raw.replace(/[._:-]/gu, "");
  if (
    !raw ||
    /(?:https?:\/\/|www\.|[/?#&=@]|(?:token|cookie|authorization|bearer|password|passwd|secret|api[_-]?key|apikey|auth(?:entication)?[_-]?code|activation[_-]?code|credential|session))/iu.test(raw) ||
    KNOWN_SECRET_TOKEN_FAMILY_PATTERN.test(raw) ||
    /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/u.test(raw) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(raw) ||
    /(?:^|[._:-])[A-Za-z0-9]{32,}(?:$|[._:-])/u.test(raw) ||
    (
      compact.length >= 32 &&
      /^[A-Za-z0-9+/_-]+$/u.test(compact) &&
      /[a-z]/u.test(compact) &&
      /[A-Z]/u.test(compact) &&
      /\d/u.test(compact)
    )
  ) return fallback;
  const normalized = raw.slice(0, limit);
  return /^[A-Za-z0-9_.:-]+$/u.test(normalized)
    ? normalized.toLowerCase()
    : fallback;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function nestedObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function firstBoundedMetric(values = [], options = {}) {
  for (const value of values) {
    const normalized = boundedMetric(value, options);
    if (normalized !== null) return normalized;
  }
  return null;
}

function recentRequestTiming(runtime = {}, diagnosticsState = {}) {
  const source = nestedObject(runtime);
  const runtimeHealth = nestedObject(
    source.healthEvidence || source.runtimeHealth || source.health,
  );
  const runtimeNetwork = nestedObject(runtimeHealth.network);
  const directLatency = firstBoundedMetric(
    [
      source.lastRequestLatencyMs,
      source.lastApiRttMs,
      source.apiRttMs,
      runtimeNetwork.lastRequestLatencyMs,
      runtimeNetwork.apiRttMs,
      runtimeNetwork.latencyMs,
    ],
    {minimum: 0, maximum: MAX_HEALTH_LATENCY_MS, decimals: 1},
  );
  if (directLatency !== null) {
    return {
      latencyMs: directLatency,
      observedAt: healthTimestamp(
        source.lastRequestAt || runtimeNetwork.observedAt,
      ),
      source: "runtime",
    };
  }

  const stages = Array.isArray(diagnosticsState?.recentStages)
    ? diagnosticsState.recentStages
    : [];
  for (const stage of stages.slice(0, MAX_RECENT_STAGES)) {
    const stageKey = healthCode(stage?.stageKey, 120, "");
    const stageSource = healthCode(stage?.source, 80, "");
    if (
      stageSource !== "api" &&
      !/(?:api|request|network|sync)/u.test(stageKey)
    ) {
      continue;
    }
    const metrics = nestedObject(stage?.metrics);
    const latencyMs = firstBoundedMetric(
      [
        metrics.apiRttMs,
        metrics.requestLatencyMs,
        metrics.latencyMs,
        metrics.elapsedMs,
        metrics.durationMs,
      ],
      {minimum: 0, maximum: MAX_HEALTH_LATENCY_MS, decimals: 1},
    );
    if (latencyMs === null) continue;
    return {
      latencyMs,
      observedAt: healthTimestamp(stage?.at),
      source: "diagnostic_stage",
    };
  }

  return {latencyMs: null, observedAt: "", source: "unavailable"};
}

function buildNetworkHealth(runtime = {}, diagnosticsState = {}) {
  const timing = recentRequestTiming(runtime, diagnosticsState);
  const recentErrors = Array.isArray(diagnosticsState?.recentErrors)
    ? diagnosticsState.recentErrors.slice(0, MAX_RECENT_ERRORS)
    : [];
  const apiErrors = recentErrors.filter((entry) => {
    const source = healthCode(entry?.source, 80, "");
    const stage = healthCode(entry?.stage, 120, "");
    return source === "api" || /(?:api|request|network|sync)/u.test(stage);
  });
  const errorCodes = apiErrors.map((entry) =>
    healthCode(entry?.error?.code, 120, "unknown"),
  );
  return {
    available: timing.latencyMs !== null || apiErrors.length > 0,
    recentRequestLatencyMs: timing.latencyMs,
    latencyObservedAt: timing.observedAt,
    latencySource: timing.source,
    recentApiErrorCount: apiErrors.length,
    recentTimeoutCount: errorCodes.filter((code) => code.includes("timeout"))
      .length,
    recentNetworkErrorCount: errorCodes.filter((code) =>
      code.includes("network"),
    ).length,
    lastErrorCode: errorCodes[0] || "",
    lastErrorAt: healthTimestamp(apiErrors[0]?.at),
  };
}

function buildHeapHealth(memoryObservation = {}) {
  const source = nestedObject(memoryObservation);
  const bytesToMb = (value) => {
    const bytes = boundedMetric(value, {
      minimum: 0,
      maximum: MAX_HEAP_MB * 1024 * 1024,
    });
    return bytes === null
      ? null
      : boundedMetric(bytes / (1024 * 1024), {
          minimum: 0,
          maximum: MAX_HEAP_MB,
          decimals: 1,
        });
  };
  const usedMb = bytesToMb(source.usedJSHeapSize);
  const totalMb = bytesToMb(source.totalJSHeapSize);
  const limitMb = bytesToMb(source.jsHeapSizeLimit);
  const utilizationPct =
    usedMb !== null && limitMb !== null && limitMb > 0
      ? boundedMetric((usedMb / limitMb) * 100, {
          minimum: 0,
          maximum: 100,
          decimals: 1,
        })
      : null;
  return {
    available: usedMb !== null || totalMb !== null || limitMb !== null,
    usedMb,
    totalMb,
    limitMb,
    utilizationPct,
  };
}

export function buildBrowserRuntimeHealthSnapshot({
  runtime = {},
  diagnosticsState = {},
  tabObservation = {},
  eventLoopObservation = {},
  memoryObservation = {},
  sampledAt = nowIso(),
  now = Date.now(),
} = {}) {
  const runtimeSource = nestedObject(runtime);
  const tab = nestedObject(tabObservation);
  const eventLoop = nestedObject(eventLoopObservation);
  const eventLoopAverageMs = boundedMetric(eventLoop.averageLagMs, {
    minimum: 0,
    maximum: MAX_HEALTH_LATENCY_MS,
    decimals: 1,
  });
  const eventLoopMaxMs = boundedMetric(eventLoop.maxLagMs, {
    minimum: 0,
    maximum: MAX_HEALTH_LATENCY_MS,
    decimals: 1,
  });

  return {
    version: 1,
    sampledAt: healthTimestamp(sampledAt) || nowIso(),
    cpu: {
      available: false,
      reason: "browser_extension_api_unavailable",
      proxyMetrics: [
        "event_loop_lag",
        "heap_usage",
        "tab_lifecycle",
        "request_latency",
      ],
    },
    eventLoop: {
      available: eventLoopAverageMs !== null || eventLoopMaxMs !== null,
      sampleCount:
        boundedMetric(eventLoop.sampleCount, {minimum: 0, maximum: 10}) ?? 0,
      averageLagMs: eventLoopAverageMs,
      maxLagMs: eventLoopMaxMs,
    },
    heap: buildHeapHealth(memoryObservation),
    tab: {
      available: tab.available === true,
      tracked: tab.tracked === true,
      status: healthCode(tab.status, 30, "unavailable"),
      active: booleanOrNull(tab.active),
      discarded: booleanOrNull(tab.discarded),
      frozen: booleanOrNull(tab.frozen),
      autoDiscardable: booleanOrNull(tab.autoDiscardable),
    },
    network: buildNetworkHealth(runtimeSource, diagnosticsState),
    runtime: {
      platform: healthCode(runtimeSource.platform, 40),
      pageType: healthCode(runtimeSource.pageType, 60),
      detailReady: booleanOrNull(runtimeSource.detailReady),
      stateAgeMs: healthAgeMs(runtimeSource.lastUpdatedAt, now),
      captureProgressAgeMs: healthAgeMs(
        runtimeSource.lastCaptureProgressAt,
        now,
      ),
      serviceWorkerRestartCount: boundedMetric(
        runtimeSource.serviceWorkerRestartCount,
        {minimum: 0, maximum: 1000000},
      ),
    },
  };
}

async function sampleEventLoopHealth({sampleCount = 3, delayMs = 8} = {}) {
  if (typeof setTimeout !== "function") {
    return {available: false, sampleCount: 0};
  }
  const monotonicNow = () => {
    try {
      if (typeof globalThis.performance?.now === "function") {
        return globalThis.performance.now();
      }
    } catch {
      // Fall back to wall-clock sampling.
    }
    return Date.now();
  };
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = monotonicNow();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    samples.push(Math.max(0, monotonicNow() - startedAt - delayMs));
  }
  return {
    available: samples.length > 0,
    sampleCount: samples.length,
    averageLagMs:
      samples.length > 0
        ? samples.reduce((total, value) => total + value, 0) / samples.length
        : null,
    maxLagMs: samples.length > 0 ? Math.max(...samples) : null,
  };
}

function readMemoryObservation() {
  try {
    const memory = globalThis.performance?.memory;
    if (!memory || typeof memory !== "object") return {};
    return {
      usedJSHeapSize: memory.usedJSHeapSize,
      totalJSHeapSize: memory.totalJSHeapSize,
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
    };
  } catch {
    return {};
  }
}

function trackedTabId(runtime = {}, taskLedger = {}) {
  const direct = Number(runtime?.lastActiveTabId);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const runs = Array.isArray(taskLedger?.runs) ? taskLedger.runs : [];
  const activeStatuses = new Set([
    "pending",
    "running",
    "recovering",
    "paused",
    "needs_action",
  ]);
  const activeRun = runs.find((run) =>
    activeStatuses.has(String(run?.status || "")),
  );
  const runnerTabId = Number(activeRun?.runnerTabId);
  return Number.isFinite(runnerTabId) && runnerTabId > 0
    ? Math.floor(runnerTabId)
    : null;
}

async function readTabObservation(runtime = {}, taskLedger = {}) {
  const tabsApi = globalThis.chrome?.tabs;
  if (!tabsApi || typeof tabsApi.get !== "function") {
    return {available: false, tracked: false, status: "unavailable"};
  }
  const tabId = trackedTabId(runtime, taskLedger);
  if (!tabId) {
    return {available: true, tracked: false, status: "untracked"};
  }
  try {
    const tab = await tabsApi.get(tabId);
    return {
      available: true,
      tracked: Boolean(tab),
      status: tab?.status || "unknown",
      active: tab?.active,
      discarded: tab?.discarded,
      frozen: tab?.frozen,
      autoDiscardable: tab?.autoDiscardable,
    };
  } catch {
    return {available: true, tracked: false, status: "missing"};
  }
}

async function collectBrowserRuntimeHealth({
  runtime = {},
  diagnosticsState = {},
  taskLedger = {},
} = {}) {
  const [eventLoopObservation, tabObservation] = await Promise.all([
    sampleEventLoopHealth(),
    readTabObservation(runtime, taskLedger),
  ]);
  return buildBrowserRuntimeHealthSnapshot({
    runtime,
    diagnosticsState,
    tabObservation,
    eventLoopObservation,
    memoryObservation: readMemoryObservation(),
  });
}

function countSelectorMatches(selectors = []) {
  if (typeof document === "undefined" || !document?.querySelectorAll) {
    return 0;
  }
  let total = 0;
  for (const selector of selectors) {
    try {
      total += document.querySelectorAll(selector).length;
    } catch {
      // Ignore selector incompatibilities across platforms.
    }
  }
  return total;
}

function buildSelectorHitSummary() {
  return {
    titleCandidates: countSelectorMatches([
      "h1",
      '[class*="title"]',
      '[data-e2e="video-desc"]',
      '[data-e2e*="title"]',
    ]),
    commentContainerCandidates: countSelectorMatches([
      '[class*="comment"]',
      '[data-e2e*="comment"]',
      "[data-comment-list]",
      '[aria-label*="评论"]',
    ]),
    searchInputCandidates: countSelectorMatches([
      'input[type="search"]',
      'input[placeholder*="搜索"]',
      'input[aria-label*="搜索"]',
      '[contenteditable="true"]',
    ]),
    keyButtonCandidates: countSelectorMatches([
      "button",
      '[role="button"]',
      '[aria-label*="评论"]',
      '[aria-label*="点赞"]',
      '[aria-label*="收藏"]',
    ]),
    detailContentCandidates: countSelectorMatches([
      "article",
      "main",
      '[class*="detail"]',
      '[class*="note"]',
      '[data-e2e*="detail"]',
    ]),
  };
}

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (depth >= 1) return "[object]";

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === "object") {
    return sanitizeMetadata(value, depth + 1);
  }

  return String(value);
}

function sanitizeMetadata(metadata = {}, depth = 0) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  const safe = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 12)) {
    const normalizedKey = normalizeText(key, 80);
    if (!normalizedKey || SENSITIVE_KEY_PATTERN.test(normalizedKey)) {
      continue;
    }
    const sanitized = sanitizeValue(value, depth);
    if (sanitized !== undefined) {
      safe[normalizedKey] = sanitized;
    }
  }
  return safe;
}

function sanitizeStageMetrics(metrics = {}, depth = 0) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    return {};
  }

  const safe = {};
  for (const [key, value] of Object.entries(metrics).slice(0, 24)) {
    const normalizedKey = normalizeText(key, 80);
    if (!normalizedKey || SENSITIVE_STAGE_KEY_PATTERN.test(normalizedKey)) {
      continue;
    }

    if (value === null || value === undefined) {
      safe[normalizedKey] = value;
      continue;
    }
    if (typeof value === "boolean") {
      safe[normalizedKey] = value;
      continue;
    }
    if (typeof value === "number") {
      safe[normalizedKey] = Number.isFinite(value) ? value : null;
      continue;
    }
    if (typeof value === "string") {
      safe[normalizedKey] = sanitizeDiagnosticText(value, 160);
      continue;
    }
    if (Array.isArray(value)) {
      safe[normalizedKey] = value
        .slice(0, 8)
        .map((item) =>
          typeof item === "number" || typeof item === "boolean"
            ? item
            : sanitizeDiagnosticText(item, 80),
        );
      continue;
    }
    if (depth < 1 && typeof value === "object") {
      safe[normalizedKey] = sanitizeStageMetrics(value, depth + 1);
    }
  }
  return safe;
}

function normalizeError(error = null, fallbackCode = "unknown_error") {
  const source = error && typeof error === "object" ? error : {};
  const code = normalizeText(
    source.code ||
      source.reason ||
      source.error?.code ||
      source.error?.reason ||
      fallbackCode,
    120,
  );
  const message = normalizeText(
    source.message ||
      source.error?.message ||
      (typeof error === "string" ? error : ""),
  );

  return {
    code: healthCode(code, 120, fallbackCode),
    message: sanitizeDiagnosticText(message),
  };
}

function normalizeEvent(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const taskContext = normalizeTaskContext(source.taskContext || source);
  const featureKey = resolveCanonicalFeatureKey(
    source.featureKey || taskContext?.featureKey,
  );
  return {
    at: normalizeText(source.at, 80) || nowIso(),
    featureKey: normalizeText(featureKey, 120),
    taskType: normalizeText(source.taskType || taskContext?.taskType, 80),
    taskId: normalizeText(source.taskId || taskContext?.taskId, 120),
    correlationId: normalizeText(
      source.correlationId || taskContext?.correlationId,
      120,
    ),
    source: healthCode(source.source, 80, ""),
    action: sanitizeDiagnosticText(source.action, 120),
    stage: healthCode(source.stage, 120, ""),
    status: healthCode(source.status, 80, ""),
    metadata: sanitizeMetadata(source.metadata || {}),
  };
}

function normalizeStageTrace(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const taskContext = normalizeTaskContext(source.taskContext || source);
  const featureKey = resolveCanonicalFeatureKey(
    source.featureKey || source.parentFeatureKey || taskContext?.featureKey,
  );
  const parentFeatureKey = resolveCanonicalFeatureKey(
    source.parentFeatureKey || featureKey,
  );
  return {
    at: normalizeText(source.at, 80) || nowIso(),
    featureKey: normalizeText(featureKey, 120),
    parentFeatureKey: normalizeText(parentFeatureKey, 120),
    stageKey: healthCode(source.stageKey || source.stage, 120, ""),
    label: sanitizeDiagnosticText(source.label, 120),
    status: healthCode(source.status, 80),
    taskId: normalizeText(source.taskId || taskContext?.taskId, 120),
    correlationId: normalizeText(
      source.correlationId || taskContext?.correlationId,
      120,
    ),
    source: healthCode(source.source, 80, ""),
    metrics: sanitizeStageMetrics(source.metrics || source.metadata || {}),
    error: source.error ? normalizeError(source.error, "stage_error") : null,
  };
}

function pushRecent(list, item, limit) {
  return [item, ...list].slice(0, limit);
}

export async function recordDiagnosticAction(input = {}) {
  const state = await readDiagnosticsState();
  state.recentActions = pushRecent(
    state.recentActions,
    normalizeEvent(input),
    MAX_RECENT_ACTIONS,
  );
  state.lastUpdatedAt = nowIso();
  return await writeDiagnosticsState(state);
}

export async function recordDiagnosticTask(input = {}) {
  const state = await readDiagnosticsState();
  state.recentTasks = pushRecent(
    state.recentTasks,
    normalizeEvent(input),
    MAX_RECENT_TASKS,
  );
  state.lastUpdatedAt = nowIso();
  return await writeDiagnosticsState(state);
}

export async function recordDiagnosticStage(input = {}) {
  const state = await readDiagnosticsState();
  const normalized = normalizeStageTrace(input);
  if (!normalized.stageKey) {
    return false;
  }
  state.recentStages = pushRecent(
    state.recentStages,
    normalized,
    MAX_RECENT_STAGES,
  );
  state.lastUpdatedAt = nowIso();
  return await writeDiagnosticsState(state);
}

export async function recordDiagnosticError(input = {}) {
  const state = await readDiagnosticsState();
  const normalized = normalizeEvent(input);
  state.recentErrors = pushRecent(
    state.recentErrors,
    {
      ...normalized,
      error: normalizeError(input.error, input.fallbackCode || "runtime_error"),
    },
    MAX_RECENT_ERRORS,
  );
  state.lastUpdatedAt = nowIso();
  return await writeDiagnosticsState(state);
}

export function buildContentDiagnostics({
  action = "",
  taskContext = null,
  response = null,
  error = null,
} = {}) {
  const urlParts =
    typeof window !== "undefined" ? safeUrlParts(window.location.href) : {};
  const responseError = response?.error || error || null;

  return {
    generatedAt: nowIso(),
    source: "content",
    action: normalizeText(action, 120),
    taskContext: serializeTaskContext(taskContext),
    page: {
      host: urlParts.host || "",
      path: urlParts.path || "",
    },
    result: {
      ok: response?.ok !== false && !responseError,
      type: normalizeText(response?.type, 80),
      itemCount: Array.isArray(response?.data?.items)
        ? response.data.items.length
        : null,
    },
    selectorSummary: buildSelectorHitSummary(),
    stageTrace: Array.isArray(response?.diagnostics?.stageTrace)
      ? response.diagnostics.stageTrace
          .slice(0, 12)
          .map((stage) =>
            normalizeStageTrace({
              ...stage,
              taskContext,
              source: stage?.source || "content",
            }),
          )
      : [],
    error: responseError ? normalizeError(responseError, "content_error") : null,
  };
}

async function resolveSnapshotRuntime() {
  const [runtime, auth, capture, sync, monitor, dataPool, taskLedger] = await Promise.all([
    getRuntime().catch(() => ({})),
    getAuth().catch(() => ({})),
    getCapture().catch(() => ({})),
    getSync().catch(() => ({})),
    getMonitor().catch(() => ({})),
    getDataPool().catch(() => ({})),
    getTaskLedger().catch(() => ({runs: []})),
  ]);
  const page = safeUrlParts(runtime?.lastPageUrl || "");
  return {
    runtime,
    auth,
    capture,
    sync,
    monitor,
    dataPool,
    taskLedger,
    page,
  };
}

function buildTaskCenterDiagnostics(taskLedger = {}) {
  const runs = Array.isArray(taskLedger?.runs) ? taskLedger.runs : [];
  const activeStatuses = new Set([
    "pending",
    "running",
    "recovering",
    "paused",
    "needs_action",
  ]);
  const safeRuns = runs.slice(0, 10).map((run) => ({
    id: normalizeText(run?.id, 120),
    kind: normalizeText(run?.kind, 80),
    status: normalizeText(run?.status, 80),
    platform: normalizeText(run?.platform, 80),
    trigger: normalizeText(run?.trigger, 80),
    attemptNumber: Number(run?.attemptNumber) || 0,
    progressSeq: Number(run?.progressSeq) || 0,
    runnerTabId:
      Number.isFinite(Number(run?.runnerTabId)) && Number(run?.runnerTabId) > 0
        ? Math.floor(Number(run.runnerTabId))
        : null,
    heartbeatAt: normalizeText(run?.heartbeatAt, 80),
    businessProgressAt: normalizeText(run?.businessProgressAt, 80),
    updatedAt: normalizeText(run?.updatedAt, 80),
    finishedAt: normalizeText(run?.finishedAt, 80),
    progress: {
      current: Number(run?.progress?.current) || 0,
      total: Number(run?.progress?.total) || 0,
      phase: normalizeText(run?.progress?.phase, 80),
      message: sanitizeDiagnosticText(run?.progress?.message, 180),
    },
    counts: sanitizeMetadata(run?.counts || run?.summary || {}),
    recovery: {
      count: Math.max(0, Number(run?.metadata?.recoveryCount) || 0),
      maxAttempts: Math.max(
        0,
        Number(run?.metadata?.maxRecoveryAttempts) || 0,
      ),
      reason: sanitizeDiagnosticText(run?.metadata?.recoveryReason, 120),
      waitUntil: normalizeText(run?.metadata?.recoveryWaitUntil, 80),
    },
    error: run?.error
      ? normalizeError(run.error, "task_run_error")
      : null,
  }));
  return {
    totalCount: runs.length,
    activeCount: runs.filter((run) => activeStatuses.has(String(run?.status || "")))
      .length,
    recentRuns: safeRuns,
  };
}

export async function buildDiagnosticsReport(extra = {}) {
  const [state, snapshot] = await Promise.all([
    readDiagnosticsState(),
    resolveSnapshotRuntime(),
  ]);
  const records = Array.isArray(snapshot.dataPool?.records)
    ? snapshot.dataPool.records
    : [];
  const monitorItems = Array.isArray(snapshot.monitor?.items)
    ? snapshot.monitor.items
    : [];
  const browserRuntime = await collectBrowserRuntimeHealth({
    runtime: snapshot.runtime,
    diagnosticsState: state,
    taskLedger: snapshot.taskLedger,
  });

  return {
    generatedAt: nowIso(),
    app: {
      version: normalizeText(snapshot.runtime?.appVersion, 80),
      clientUuid: normalizeText(snapshot.runtime?.clientUuid, 120),
      clientLabel: normalizeText(snapshot.runtime?.clientLabel, 120),
    },
    page: {
      platform: normalizeText(snapshot.runtime?.platform, 80),
      pageType: normalizeText(snapshot.runtime?.pageType, 80),
      host: snapshot.page.host,
      path: snapshot.page.path,
    },
    browserRuntime,
    auth: {
      status: normalizeText(snapshot.auth?.status, 80),
      verified: Boolean(snapshot.auth?.verified),
      reason: sanitizeDiagnosticText(snapshot.auth?.reason, 120),
      remainingCredits:
        Number(snapshot.auth?.credentialCredit?.remainingCredits) || null,
    },
    capture: {
      status: normalizeText(snapshot.capture?.status, 80),
      activeType: normalizeText(snapshot.capture?.activeType, 80),
      phase: normalizeText(snapshot.capture?.progress?.phase, 80),
      message: sanitizeDiagnosticText(
        snapshot.capture?.progress?.message,
        180,
      ),
      error: snapshot.capture?.error
        ? normalizeError(snapshot.capture.error, "capture_error")
        : null,
    },
    sync: {
      status: normalizeText(snapshot.sync?.status, 80),
      activeSyncType: normalizeText(snapshot.sync?.activeSyncType, 80),
      message: sanitizeDiagnosticText(snapshot.sync?.message, 180),
      error: snapshot.sync?.error
        ? normalizeError(snapshot.sync.error, "sync_error")
        : null,
    },
    monitor: {
      itemCount: monitorItems.length,
      status: normalizeText(snapshot.monitor?.status, 80),
      lastLoadedAt: normalizeText(snapshot.monitor?.lastLoadedAt, 80),
    },
    dataPool: {
      recordCount: records.length,
      syncedCount: records.filter((record) => record?.status === "synced").length,
      failedCount: records.filter((record) => record?.status === "failed").length,
    },
    taskCenter: buildTaskCenterDiagnostics(snapshot.taskLedger),
    recentActions: state.recentActions.slice(0, 10),
    recentErrors: state.recentErrors.slice(0, 10),
    recentStages: state.recentStages.slice(0, 20),
    recentTasks: state.recentTasks.slice(0, 10),
    note: "诊断信息已脱敏：不包含正文全文、评论全文、token、cookie、飞书密钥、激活码或完整 URL；浏览器不提供 CPU 指标时使用事件循环、Heap、标签页生命周期和请求延迟作为近似证据。",
    extra: sanitizeMetadata(extra),
  };
}

export function formatDiagnosticsReport(report = {}) {
  return JSON.stringify(report, null, 2);
}

export async function buildDiagnosticsText(extra = {}) {
  return formatDiagnosticsReport(await buildDiagnosticsReport(extra));
}
