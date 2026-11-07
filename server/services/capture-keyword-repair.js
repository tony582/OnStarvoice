// Post-level repair handoff for elastic keyword items.
//
// Since 0.4.30 a keyword whose per-post enhancement exhausted its local retry
// budget became a terminal failure: the search had already succeeded, so a
// whole-keyword relay would repeat it. The failed posts were never given to
// another browser. Here the same keyword item is relayed instead, carrying
// only the failed posts of the failed step; a browser with
// keywordRepairTargetsV1 skips the search and enhances just those posts.

export const KEYWORD_REPAIR_PENDING_CODE = 'KEYWORD_REPAIR_PENDING';
export const KEYWORD_REPAIR_LIMIT = 2;
// An item waiting for a repair-capable browser this long may be taken by any
// browser as an ordinary keyword relay, so nothing waits forever.
export const KEYWORD_REPAIR_STARVATION_MS = 60 * 60 * 1000;
const EXHAUSTED_CODE = 'ENHANCEMENT_RETRY_EXHAUSTED';

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, limit = 1000) {
  return String(value ?? '').trim().slice(0, limit);
}

export function normalizeKeywordRepairTargets(values, platform = '') {
  const seen = new Set();
  const normalizedPlatform = text(platform, 40).toLowerCase();
  return (Array.isArray(values) ? values : [])
    .map(value => object(value))
    .map(target => ({
      externalId: text(target.externalId, 120),
      url: text(target.url, 2000),
      ...(text(target.stage, 80) ? {stage: text(target.stage, 80)} : {}),
    }))
    .filter(target => {
      if (!target.externalId || seen.has(target.externalId)) return false;
      try {
        const parsed = new URL(target.url);
        const host = parsed.hostname.toLowerCase();
        const base = normalizedPlatform === 'douyin' ? 'douyin.com'
          : normalizedPlatform === 'xiaohongshu' ? 'xiaohongshu.com' : '';
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
        if (base && host !== base && !host.endsWith(`.${base}`)) return false;
      } catch {
        return false;
      }
      seen.add(target.externalId);
      return true;
    })
    .slice(0, 200);
}

/** The repair this item is waiting for, or null. */
export function pendingKeywordRepair(itemMetadata = {}) {
  const repair = object(object(itemMetadata).keywordRepair);
  if (Number(repair.version) !== 1 || repair.state !== 'pending') return null;
  if (!Array.isArray(repair.targets) || repair.targets.length === 0) return null;
  return repair;
}

/**
 * Decide whether an exhausted keyword step is handed to another browser.
 * Returns the new pending repair, or null to keep the failure terminal.
 */
export function planKeywordRepair({
  entry = {},
  checkpoint = {},
  itemMetadata = {},
  planSnapshot = {},
  parentMetadata = {},
  platform = '',
  sourceAgentId = '',
  executionTaskId = '',
  attemptBudgetRemaining = true,
  now = new Date(),
} = {}) {
  const code = text(entry.errorCode || entry.error_code || object(entry.error).code, 100).toUpperCase();
  if (code !== EXHAUSTED_CODE) return null;
  const metadata = object(itemMetadata);
  const pending = pendingKeywordRepair(metadata);
  // Terminal snapshots are replayed until another browser claims the item;
  // the same source execution keeps its one planned repair.
  if (pending && text(executionTaskId, 100) &&
      pending.sourceExecutionTaskId === text(executionTaskId, 100)) {
    return pending;
  }
  if (!attemptBudgetRemaining) return null;
  if (text(metadata.pinnedAgentId, 100)) return null;
  if (object(parentMetadata).automaticRetryDisabled === true) return null;
  if (object(object(planSnapshot).recoveryPolicy).allowIdleAgentHandoff === false) return null;
  const previous = object(metadata.keywordRepair);
  const previousCount = Math.max(0, Math.floor(Number(previous.count)) || 0);
  if (previousCount >= KEYWORD_REPAIR_LIMIT) return null;
  const targets = normalizeKeywordRepairTargets(
    object(object(checkpoint).enhancementFailure).failedTargets,
    platform,
  );
  if (targets.length === 0) return null;
  const keyword = text(object(checkpoint).keyword || entry.keyword, 120);
  if (!keyword) return null;
  const nowDate = now instanceof Date ? now : new Date(now);
  return {
    version: 1,
    state: 'pending',
    keyword,
    round: Math.max(1, Math.floor(Number(object(checkpoint).round || entry.round)) || 1),
    platform: text(platform, 40).toLowerCase(),
    targets,
    count: previousCount + 1,
    sourceExecutionTaskId: text(executionTaskId, 100),
    sourceAgentIds: [...new Set([
      ...(Array.isArray(previous.sourceAgentIds) ? previous.sourceAgentIds : []),
      text(sourceAgentId, 100),
    ].filter(Boolean))].slice(-10),
    requestedAt: Number.isFinite(nowDate.getTime()) ? nowDate.toISOString() : new Date().toISOString(),
  };
}

/**
 * A settled snapshot for the repaired step closes the pending repair, so a
 * later relay of the same item never re-sends old targets.
 */
export function settleKeywordRepair({itemMetadata = {}, checkpoint = {}, status = '', now = new Date()} = {}) {
  const repair = pendingKeywordRepair(itemMetadata);
  if (!repair) return null;
  const round = Math.max(1, Math.floor(Number(object(checkpoint).round)) || 1);
  if (round !== Math.max(1, Number(repair.round) || 1)) return null;
  if (!['completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled', 'needs_action'].includes(status)) {
    return null;
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  return {
    ...repair,
    state: ['completed', 'completed_with_warnings'].includes(status) ? 'completed' : 'closed',
    settledStatus: status,
    settledAt: Number.isFinite(nowDate.getTime()) ? nowDate.toISOString() : new Date().toISOString(),
  };
}

/** The error a repair-scheduled item carries while it waits for a browser. */
export function keywordRepairPendingError(error = {}, repair = {}) {
  const source = object(error);
  const count = Array.isArray(repair.targets) ? repair.targets.length : 0;
  const message = text(source.message, 900);
  return {
    ...source,
    code: KEYWORD_REPAIR_PENDING_CODE,
    sourceCode: text(source.code, 100) || EXHAUSTED_CODE,
    keywordRepair: {count: repair.count, targetCount: count, round: repair.round},
    message: `${message || '采集增强未全部完成'}；已交给其它节点补采这 ${count} 条帖子（第 ${repair.count}/${KEYWORD_REPAIR_LIMIT} 次）`,
  };
}

/**
 * Resume checkpoint for a repair relay: every completed step except the
 * repaired one, starting at the repaired step. Steps after it that are not
 * complete run normally.
 */
export function buildKeywordRepairCheckpoint({repair = {}, itemMetadata = {}, now = new Date()} = {}) {
  const keyword = text(repair.keyword, 120);
  const round = Math.max(1, Math.floor(Number(repair.round)) || 1);
  const checkpoint = object(object(itemMetadata).checkpoint);
  const passResults = Array.isArray(checkpoint.searchPassResults) ? checkpoint.searchPassResults : [];
  const latestByRound = new Map();
  for (const result of passResults) {
    const source = object(result);
    if (text(source.keyword, 120) !== keyword) continue;
    latestByRound.set(Math.max(1, Math.floor(Number(source.round)) || 1), source);
  }
  const keywordResults = [...latestByRound.entries()]
    .filter(([entryRound, source]) => entryRound !== round &&
      ['completed', 'completed_with_warnings'].includes(text(source.status, 80).toLowerCase()))
    .sort(([left], [right]) => left - right)
    .map(([entryRound, source]) => ({
      round: entryRound,
      index: 0,
      keyword,
      status: 'completed',
      attemptCount: Math.max(0, Number(source.attemptCount) || 0),
      savedCount: Math.max(0, Number(source.savedCount) || 0),
      ...(source.noResults === true ? {noResults: true} : {}),
      ...(text(source.resultKind, 80) ? {resultKind: text(source.resultKind, 80)} : {}),
      ...(source.scanComplete === true ? {scanComplete: true} : {}),
      error: '',
      finishedAt: text(source.finishedAt, 60) || null,
    }));
  const nowDate = now instanceof Date ? now : new Date(now);
  return {
    schemaVersion: 1,
    round,
    activeKeywordIndex: 0,
    activeKeyword: '',
    activePhase: 'pending',
    keywordResults,
    updatedAt: Number.isFinite(nowDate.getTime()) ? nowDate.toISOString() : new Date().toISOString(),
  };
}
