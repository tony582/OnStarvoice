import { DEFAULT_CONFIG, PAGE_TYPE, RECORD_STATUS } from "../constants.js";
import { detectPlatformFromUrl } from "./page-routing.js";
import { normalizePlatformId } from "./registry.js";

export const RECORD_SCHEMA_VERSION = "v2";
let recordIdCounter = 0;

function cloneObject(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  if (Array.isArray(value)) {
    return value.map((item) => (item && typeof item === "object" ? { ...item } : item));
  }

  return { ...value };
}

function resolveDirectPlatform(value) {
  const normalized = normalizePlatformId(value);
  return normalized === "unknown" ? "" : normalized;
}

function inferPlatformFromCandidate(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return "";
  }

  if (candidate.includes("://")) {
    return resolveDirectPlatform(detectPlatformFromUrl(candidate));
  }

  return resolveDirectPlatform(candidate);
}

export function resolveRecordPayload(record) {
  if (!record || typeof record !== "object") {
    return {};
  }

  if (record.normalizedPayload && typeof record.normalizedPayload === "object") {
    return cloneObject(record.normalizedPayload);
  }

  if (record.payload && typeof record.payload === "object") {
    return cloneObject(record.payload);
  }

  if (record.rawPayload && typeof record.rawPayload === "object") {
    return cloneObject(record.rawPayload);
  }

  if (record.data && typeof record.data === "object") {
    return cloneObject(record.data);
  }

  return {};
}

export function resolveRecordPlatform(record) {
  const directPlatform = resolveDirectPlatform(record?.platform);
  if (directPlatform) {
    return directPlatform;
  }

  const payload = resolveRecordPayload(record);
  const rawPayload =
    record?.rawPayload && typeof record.rawPayload === "object"
      ? record.rawPayload
      : payload;
  const meta = record?.meta && typeof record.meta === "object" ? record.meta : {};
  const firstItem = Array.isArray(payload.items) ? payload.items[0] || {} : {};
  const candidates = [
    meta.platform,
    meta.sourceUrl,
    record?.sourceUrl,
    payload.platform,
    payload.url,
    payload.noteUrl,
    payload.detailPageUrl,
    payload.authorUrl,
    payload.bloggerUrl,
    payload.detailCaptureNoteUrl,
    rawPayload.platform,
    rawPayload.url,
    firstItem.url,
    firstItem.noteUrl,
    firstItem.detailPageUrl,
    firstItem.authorUrl,
    firstItem.bloggerUrl,
  ];

  for (const candidate of candidates) {
    const resolved = inferPlatformFromCandidate(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return "unknown";
}

function buildEnvelopeId(recordType) {
  const type = String(recordType || "record")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
  recordIdCounter = (recordIdCounter + 1) % 0x100000;
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${recordIdCounter.toString(36)}`;
  return `rec_${type}_${randomPart}`;
}

function resolveRecordType(record) {
  return String(record?.recordType || record?.type || "").trim();
}

function buildRecordPreview(recordType, normalizedPayload, rawPayload) {
  const payload = normalizedPayload && typeof normalizedPayload === "object"
    ? normalizedPayload
    : {};
  const raw = rawPayload && typeof rawPayload === "object" ? rawPayload : payload;

  if (recordType === "single_note") {
    return {
      title: String(payload.title || raw.title || payload.noteId || raw.noteId || "单篇笔记"),
      summary: String(payload.content || raw.content || payload.url || raw.url || "单篇笔记采集数据"),
    };
  }

  if (recordType === "blogger_profile") {
    return {
      title: String(payload.bloggerName || raw.bloggerName || payload.bloggerId || raw.bloggerId || "博主信息"),
      summary: String(
        payload.description ||
          raw.description ||
          payload.bloggerUrl ||
          raw.bloggerUrl ||
          "博主主页信息采集数据"
      ),
    };
  }

  if (recordType === "blogger_notes" || recordType === "keyword_notes") {
    const firstItem = (Array.isArray(payload.items) ? payload.items[0] : null) || {};
    const author = firstItem.author || payload.bloggerName || payload.keyword || "作者未知";
    return {
      title: String(firstItem.title || payload.title || (recordType === "blogger_notes" ? "博主笔记" : "搜索笔记")),
      summary: `${author} · 点赞 ${firstItem.likes || 0}`,
    };
  }

  if (recordType === "comments") {
    return {
      title: String(payload.noteTitle || payload.title || payload.noteId || "评论数据"),
      summary: `评论 ${Array.isArray(payload.items) ? payload.items.length : payload.totalCount || 0} 条`,
    };
  }

  return {
    title: String(payload.title || raw.title || "无标题数据"),
    summary: String(payload.summary || raw.summary || "无内容摘要..."),
  };
}

function finalizeNormalizedRecord(record = {}) {
  const recordType = resolveRecordType(record);
  const rawPayload = cloneObject(record.rawPayload || record.payload || record.data || {});
  const normalizedPayload = cloneObject(
    record.normalizedPayload || record.payload || record.data || rawPayload,
  );
  const platform = resolveRecordPlatform({
    ...record,
    recordType,
    rawPayload,
    normalizedPayload,
  });
  const preview = buildRecordPreview(recordType, normalizedPayload, rawPayload);

  return {
    ...record,
    platform,
    sourcePageType: record.sourcePageType || record.meta?.pageType || PAGE_TYPE.UNKNOWN,
    recordType,
    schemaVersion: RECORD_SCHEMA_VERSION,
    title: String(record.title || preview.title || ""),
    summary: String(record.summary || preview.summary || ""),
    rawPayload,
    normalizedPayload,
    meta: {
      ...(record.meta && typeof record.meta === "object" ? record.meta : {}),
      sourceUrl:
        record.meta?.sourceUrl ||
        record.sourceUrl ||
        normalizedPayload.url ||
        rawPayload.url ||
        "",
      appVersion: record.meta?.appVersion || DEFAULT_CONFIG.APP_VERSION,
      platform,
    },
    status: record.status || RECORD_STATUS.DRAFT,
    createdAt: record.createdAt || Date.now(),
    updatedAt: record.updatedAt || Date.now(),
    type: recordType,
    payload: normalizedPayload,
  };
}

export function createRecordEnvelope(captureResult = {}) {
  const meta = captureResult.meta && typeof captureResult.meta === "object" ? captureResult.meta : {};
  const rawPayload = captureResult.data && typeof captureResult.data === "object" ? captureResult.data : {};
  const normalizedPayload = cloneObject(rawPayload);
  return finalizeNormalizedRecord({
    id: buildEnvelopeId(captureResult.type),
    platform: captureResult.platform,
    sourcePageType: meta.pageType || PAGE_TYPE.UNKNOWN,
    recordType: captureResult.type || "",
    rawPayload: cloneObject(rawPayload),
    normalizedPayload,
    meta,
    status: RECORD_STATUS.DRAFT,
  });
}

export function normalizeStoredRecord(record = {}) {
  if (!record || typeof record !== "object") {
    return createRecordEnvelope();
  }

  if (
    record.schemaVersion === RECORD_SCHEMA_VERSION &&
    record.rawPayload &&
    record.normalizedPayload
  ) {
    return finalizeNormalizedRecord(record);
  }

  return finalizeNormalizedRecord({
    id: record.id || buildEnvelopeId(record.type || record.recordType),
    sourcePageType: record.sourcePageType || record.meta?.pageType || PAGE_TYPE.UNKNOWN,
    recordType: record.recordType || record.type || "",
    rawPayload: cloneObject(record.payload || record.rawPayload || record.data || {}),
    normalizedPayload: resolveRecordPayload(record),
    meta: record.meta,
    status: record.status || RECORD_STATUS.DRAFT,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    title: record.title,
    summary: record.summary,
    platform: record.platform,
  });
}

export function serializeRecordEnvelope(record = {}) {
  const normalized = normalizeStoredRecord(record);
  return {
    id: normalized.id,
    platform: normalized.platform,
    sourcePageType: normalized.sourcePageType,
    recordType: normalized.recordType,
    schemaVersion: normalized.schemaVersion,
    title: normalized.title,
    summary: normalized.summary,
    rawPayload: cloneObject(normalized.rawPayload),
    normalizedPayload: cloneObject(normalized.normalizedPayload),
    meta: {
      ...(normalized.meta && typeof normalized.meta === "object" ? normalized.meta : {}),
    },
    status: normalized.status,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    lastSyncedAt: normalized.lastSyncedAt || null,
    lastSyncReason: normalized.lastSyncReason || "",
    lastSyncDebugUrl: normalized.lastSyncDebugUrl || null,
  };
}
