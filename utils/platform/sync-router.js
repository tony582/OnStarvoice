import { SYNC_TYPE } from "../constants.js";
import { getPlatformConfig, normalizePlatformId } from "./registry.js";
import { resolveRecordPlatform } from "./record-envelope.js";

function clonePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  return JSON.parse(JSON.stringify(payload));
}

function maskToken(token) {
  if (!token) return "";
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

export function resolveSyncTableName(target, syncType) {
  const safeTarget = target && typeof target === "object" ? target : {};

  if (syncType === SYNC_TYPE.BLOGGER_PROFILE) {
    return String(safeTarget.bloggerProfileTableName || "").trim();
  }

  if (syncType === SYNC_TYPE.BLOGGER_NOTES) {
    return String(safeTarget.bloggerNotesTableName || "").trim();
  }

  if (syncType === SYNC_TYPE.KEYWORD_NOTES) {
    return String(safeTarget.keywordNotesTableName || "").trim();
  }

  if (syncType === SYNC_TYPE.COMMENT_LEADS) {
    return String(safeTarget.commentLeadsTableName || "").trim();
  }

  return String(safeTarget.tableId || "").trim();
}

export function getSyncWorkflow(record, options = {}) {
  const safeRecord = record && typeof record === "object" ? record : {};
  const platform = normalizePlatformId(
    options.platform || resolveRecordPlatform(safeRecord),
  );
  const recordType = String(
    options.recordType || safeRecord.recordType || safeRecord.type || "",
  ).trim();
  const platformConfig = getPlatformConfig(platform);
  const mappedWorkflow = String(
    platformConfig?.sync?.workflowMap?.[recordType] || "",
  ).trim();

  if (mappedWorkflow) {
    return mappedWorkflow;
  }

  if (recordType) {
    return `shared_${recordType}`;
  }

  return "shared_unknown";
}

export function buildSyncInput(record, target = {}, options = {}) {
  const safeRecord = record && typeof record === "object" ? record : {};
  const platform = normalizePlatformId(
    options.platform || resolveRecordPlatform(safeRecord),
  );
  const recordType = String(
    options.recordType || safeRecord.recordType || safeRecord.type || "",
  ).trim();
  const syncType = String(options.syncType || recordType).trim();
  const payload = clonePayload(
    options.payload ||
      safeRecord.payload ||
      safeRecord.normalizedPayload ||
      safeRecord.rawPayload ||
      {},
  );
  if (platform !== "unknown" && !String(payload.platform || "").trim()) {
    payload.platform = platform;
  }
  const workflow = getSyncWorkflow(safeRecord, {
    platform,
    recordType,
  });
  const tableName = resolveSyncTableName(target, syncType);

  return {
    platform,
    recordType,
    syncType,
    payload,
    workflow,
    tableName,
    target: {
      ...(target && typeof target === "object" ? target : {}),
      tableName,
    },
  };
}

export function buildSyncHistoryTarget(target, syncInput) {
  const safeTarget = target && typeof target === "object" ? target : {};
  const safeSyncInput =
    syncInput && typeof syncInput === "object" ? syncInput : {};

  return {
    tableName: String(
      safeSyncInput.tableName ||
        resolveSyncTableName(safeTarget, safeSyncInput.syncType || ""),
    ).trim(),
    feishuAppToken: maskToken(String(safeTarget.feishuAppToken || "")),
    platform: normalizePlatformId(safeSyncInput.platform || "unknown"),
    workflow: String(safeSyncInput.workflow || "").trim(),
    syncType: String(safeSyncInput.syncType || "").trim(),
  };
}
