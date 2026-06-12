import {STORAGE_KEY} from "./constants.js";
import {
  getAuth,
  getCapture,
  getDataPool,
  getMonitor,
  getRuntime,
  getSync,
} from "./storage.js";
import {resolveCanonicalFeatureKey} from "./features/registry.js";
import {normalizeTaskContext, serializeTaskContext} from "./task-context.js";

const MAX_RECENT_ACTIONS = 30;
const MAX_RECENT_ERRORS = 20;
const MAX_RECENT_STAGES = 60;
const MAX_RECENT_TASKS = 20;
const MAX_TEXT_LENGTH = 220;
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
      ? source.recentActions.slice(0, MAX_RECENT_ACTIONS)
      : [],
    recentErrors: Array.isArray(source.recentErrors)
      ? source.recentErrors.slice(0, MAX_RECENT_ERRORS)
      : [],
    recentStages: Array.isArray(source.recentStages)
      ? source.recentStages.slice(0, MAX_RECENT_STAGES)
      : [],
    recentTasks: Array.isArray(source.recentTasks)
      ? source.recentTasks.slice(0, MAX_RECENT_TASKS)
      : [],
    lastUpdatedAt: normalizeText(source.lastUpdatedAt, 80) || nowIso(),
  };
}

function safeUrlParts(rawUrl = "") {
  try {
    const parsed = new URL(String(rawUrl || ""));
    return {
      host: normalizeText(parsed.host, 160),
      path: normalizeText(parsed.pathname || "/", 220),
    };
  } catch {
    return {
      host: "",
      path: "",
    };
  }
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
  if (typeof value === "string") return normalizeText(value);
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
      safe[normalizedKey] = normalizeText(value, 160);
      continue;
    }
    if (Array.isArray(value)) {
      safe[normalizedKey] = value
        .slice(0, 8)
        .map((item) =>
          typeof item === "number" || typeof item === "boolean"
            ? item
            : normalizeText(item, 80),
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
    code: code || fallbackCode,
    message,
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
    source: normalizeText(source.source, 80),
    action: normalizeText(source.action, 120),
    stage: normalizeText(source.stage, 120),
    status: normalizeText(source.status, 80),
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
    stageKey: normalizeText(source.stageKey || source.stage, 120),
    label: normalizeText(source.label, 120),
    status: normalizeText(source.status, 80) || "unknown",
    taskId: normalizeText(source.taskId || taskContext?.taskId, 120),
    correlationId: normalizeText(
      source.correlationId || taskContext?.correlationId,
      120,
    ),
    source: normalizeText(source.source, 80),
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
  const [runtime, auth, capture, sync, monitor, dataPool] = await Promise.all([
    getRuntime().catch(() => ({})),
    getAuth().catch(() => ({})),
    getCapture().catch(() => ({})),
    getSync().catch(() => ({})),
    getMonitor().catch(() => ({})),
    getDataPool().catch(() => ({})),
  ]);
  const page = safeUrlParts(runtime?.lastPageUrl || "");
  return {
    runtime,
    auth,
    capture,
    sync,
    monitor,
    dataPool,
    page,
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
    auth: {
      status: normalizeText(snapshot.auth?.status, 80),
      verified: Boolean(snapshot.auth?.verified),
      reason: normalizeText(snapshot.auth?.reason, 120),
      remainingCredits:
        Number(snapshot.auth?.credentialCredit?.remainingCredits) || null,
    },
    capture: {
      status: normalizeText(snapshot.capture?.status, 80),
      activeType: normalizeText(snapshot.capture?.activeType, 80),
      phase: normalizeText(snapshot.capture?.progress?.phase, 80),
      message: normalizeText(snapshot.capture?.progress?.message, 180),
      error: snapshot.capture?.error
        ? normalizeError(snapshot.capture.error, "capture_error")
        : null,
    },
    sync: {
      status: normalizeText(snapshot.sync?.status, 80),
      activeSyncType: normalizeText(snapshot.sync?.activeSyncType, 80),
      message: normalizeText(snapshot.sync?.message, 180),
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
    recentActions: state.recentActions.slice(0, 10),
    recentErrors: state.recentErrors.slice(0, 10),
    recentStages: state.recentStages.slice(0, 20),
    recentTasks: state.recentTasks.slice(0, 10),
    note: "诊断信息已脱敏：不包含正文全文、评论全文、token、cookie、飞书密钥或激活码。",
    extra: sanitizeMetadata(extra),
  };
}

export function formatDiagnosticsReport(report = {}) {
  return JSON.stringify(report, null, 2);
}

export async function buildDiagnosticsText(extra = {}) {
  return formatDiagnosticsReport(await buildDiagnosticsReport(extra));
}
