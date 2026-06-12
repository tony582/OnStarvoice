const TASK_ID_PREFIX = "task";
const CORRELATION_ID_PREFIX = "corr";
const MAX_META_KEYS = 12;
const MAX_META_STRING_LENGTH = 160;

const activeTasks = new Map();
let lastTaskContext = null;

function createId(prefix) {
  const timePart = Date.now().toString(36);
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
      ? Array.from(crypto.getRandomValues(new Uint8Array(6)))
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("")
      : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${timePart}_${randomPart}`;
}

function normalizeText(value, limit = MAX_META_STRING_LENGTH) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > limit ? text.slice(0, limit) : text;
}

function taskKey(taskType, featureKey) {
  return `${normalizeText(taskType, 80) || "task"}:${normalizeText(featureKey, 120) || "unknown"}`;
}

function sanitizeMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  const safe = {};
  for (const [key, value] of Object.entries(metadata).slice(0, MAX_META_KEYS)) {
    const normalizedKey = normalizeText(key, 80);
    if (!normalizedKey) continue;

    if (value === null || typeof value === "boolean") {
      safe[normalizedKey] = value;
      continue;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) safe[normalizedKey] = value;
      continue;
    }
    if (typeof value === "string") {
      safe[normalizedKey] = normalizeText(value);
    }
  }

  return safe;
}

export function createTaskContext({
  taskType = "task",
  featureKey = "unknown",
  source = "extension",
  metadata = {},
} = {}) {
  const startedAt = new Date().toISOString();
  return {
    taskId: createId(TASK_ID_PREFIX),
    correlationId: createId(CORRELATION_ID_PREFIX),
    taskType: normalizeText(taskType, 80) || "task",
    featureKey: normalizeText(featureKey, 120) || "unknown",
    source: normalizeText(source, 80) || "extension",
    startedAt,
    metadata: sanitizeMetadata(metadata),
  };
}

export function normalizeTaskContext(input = null) {
  const source =
    input?.taskContext && typeof input.taskContext === "object"
      ? input.taskContext
      : input && typeof input === "object"
        ? input
        : {};
  const taskId = normalizeText(source.taskId || input?.taskId, 120);
  const correlationId = normalizeText(
    source.correlationId || input?.correlationId || taskId,
    120,
  );

  if (!taskId && !correlationId) {
    return null;
  }

  return {
    taskId: taskId || correlationId,
    correlationId: correlationId || taskId,
    taskType: normalizeText(source.taskType || input?.taskType, 80),
    featureKey: normalizeText(source.featureKey || input?.featureKey, 120),
    source: normalizeText(source.source || input?.source, 80),
    startedAt: normalizeText(source.startedAt || input?.startedAt, 80),
    metadata: sanitizeMetadata(source.metadata || input?.metadata || {}),
  };
}

export function beginTaskContext({
  taskType = "task",
  featureKey = "unknown",
  source = "sidebar",
  metadata = {},
} = {}) {
  const context = createTaskContext({taskType, featureKey, source, metadata});
  activeTasks.set(taskKey(taskType, featureKey), context);
  lastTaskContext = context;
  return context;
}

export function getActiveTaskContext(taskType = "", featureKey = "") {
  if (taskType || featureKey) {
    const exact = activeTasks.get(taskKey(taskType, featureKey));
    if (exact) return exact;
  }
  return lastTaskContext;
}

export function completeTaskContext({
  taskType = "",
  featureKey = "",
} = {}) {
  const key = taskKey(taskType, featureKey);
  const hasSpecificTask = Boolean(taskType || featureKey);
  const context =
    activeTasks.get(key) || (hasSpecificTask ? null : lastTaskContext);
  activeTasks.delete(key);
  if (context && lastTaskContext?.taskId === context.taskId) {
    const remainingTasks = Array.from(activeTasks.values());
    lastTaskContext = remainingTasks[remainingTasks.length - 1] || null;
  }
  return context || null;
}

export function serializeTaskContext(context = null) {
  const normalized = normalizeTaskContext(context || getActiveTaskContext());
  if (!normalized) return null;

  return {
    taskId: normalized.taskId,
    correlationId: normalized.correlationId,
    taskType: normalized.taskType,
    featureKey: normalized.featureKey,
    source: normalized.source,
    startedAt: normalized.startedAt,
  };
}

export function appendTaskContext(target = {}, context = null) {
  const serialized = serializeTaskContext(context);
  if (!serialized || !target || typeof target !== "object") {
    return target;
  }

  return {
    ...target,
    taskId: target.taskId || serialized.taskId,
    correlationId: target.correlationId || serialized.correlationId,
    featureKey: target.featureKey || serialized.featureKey,
    taskContext: {
      ...serialized,
      ...(target.taskContext && typeof target.taskContext === "object"
        ? target.taskContext
        : {}),
    },
  };
}
