// Post-level repair handoff for elastic keyword items.
//
// Since 0.4.30 a keyword whose per-post enhancement exhausted its local retry
// budget became a terminal failure: the search had already succeeded, so a
// whole-keyword relay would repeat it. The failed posts were never given to
// another browser. Here the same keyword item is relayed instead, carrying
// only the failed posts of the failed step; a browser with
// keywordRepairTargetsV1 skips the search and enhances just those posts.
//
// Every repair run counts, however it failed. A post that three different
// browsers could not open is treated as a property of the post (removed,
// private or under review), not of the browsers: the keyword completes with a
// warning instead of waiting for a person.

export const KEYWORD_REPAIR_PENDING_CODE = 'KEYWORD_REPAIR_PENDING';
export const KEYWORD_POSTS_UNOPENABLE_CODE = 'KEYWORD_POSTS_UNOPENABLE';
export const KEYWORD_REPAIR_LIMIT = 2;
export const KEYWORD_REPAIR_UNOPENABLE_AGENT_COUNT = 3;
// An item waiting for a repair-capable browser this long may be taken by any
// browser as an ordinary keyword relay, so nothing waits forever.
export const KEYWORD_REPAIR_STARVATION_MS = 60 * 60 * 1000;
const EXHAUSTED_CODE = 'ENHANCEMENT_RETRY_EXHAUSTED';
const FAILURE_LEDGER_LIMIT = 10;
// Codes that say the post page itself could not be shown.
const OPEN_FAILURE_CODES = new Set([
  'PAGE_OPEN_TIMEOUT', 'PAGE_OPEN_FAILED', 'CONTENT_UNAVAILABLE',
  'DOUYIN_CONTENT_UNAVAILABLE', 'TARGET_POST_UNAVAILABLE',
]);
// Codes that say the browser itself was in trouble, whatever the stage.
const NODE_FAILURE_CODES = new Set([
  'RUNNER_TAB_UNAVAILABLE', 'TASK_TAB_GROUP_UNAVAILABLE', 'TAB_NOT_FOUND',
  'CONTEXT_INTERRUPTED', 'RUNNER_INTERRUPTED', 'RETRY_RESULT_MISSING',
]);
// Wrappers that carry no information about the post.
const GENERIC_CODES = new Set([
  EXHAUSTED_CODE, 'INCOMPLETE_SEARCH_PASSES', 'UNKNOWN', 'UNEXPECTED_ERROR',
  'CAPTURE_ENHANCEMENT_INCOMPLETE',
]);
const SUCCESS_STATUSES = new Set(['completed', 'completed_with_warnings']);
const SETTLED_STATUSES = new Set([
  'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled', 'needs_action',
]);

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
      ...(text(target.code, 100) ? {code: text(target.code, 100).toUpperCase()} : {}),
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

function isoNow(now) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function failureKind(failure = {}) {
  const code = text(failure.code, 100).toUpperCase();
  const stage = text(failure.stage, 80).toLowerCase();
  if (stage === 'retry_budget') return 'untried';
  if (NODE_FAILURE_CODES.has(code)) return 'node';
  if (OPEN_FAILURE_CODES.has(code) || stage === 'navigation') return 'open';
  if ((code && !GENERIC_CODES.has(code)) || stage) return 'other';
  return 'unknown';
}

/**
 * True when distinct browsers failed this post at the page-open step and no
 * browser reported a failure anywhere else. Reports without any detail (old
 * browsers) count as browsers that tried, but at least one must name the open
 * step.
 */
export function keywordRepairTargetUnopenable(failures = []) {
  const kinds = (Array.isArray(failures) ? failures : []).map(failure => ({
    agentId: text(object(failure).agentId, 100),
    kind: failureKind(object(failure)),
  }));
  if (kinds.some(entry => entry.kind === 'other')) return false;
  if (!kinds.some(entry => entry.kind === 'open')) return false;
  const agents = new Set(kinds
    .filter(entry => (entry.kind === 'open' || entry.kind === 'unknown') && entry.agentId)
    .map(entry => entry.agentId));
  return agents.size >= KEYWORD_REPAIR_UNOPENABLE_AGENT_COUNT;
}

function mergeFailures(previous, targets, agentId) {
  const ledger = {};
  for (const target of targets) {
    const prior = Array.isArray(object(previous)[target.externalId]) ? object(previous)[target.externalId] : [];
    const entry = {
      agentId: text(agentId, 100),
      ...(target.code ? {code: target.code} : {}),
      ...(target.stage ? {stage: target.stage} : {}),
    };
    const key = value => `${value.agentId}|${value.code || ''}|${value.stage || ''}`;
    const merged = [...prior.map(object), entry]
      .filter((value, index, all) => all.findIndex(other => key(other) === key(value)) === index);
    ledger[target.externalId] = merged.slice(-FAILURE_LEDGER_LIMIT);
  }
  return ledger;
}

/** Browsers that already failed a post of this repair; a relay avoids them. */
export function keywordRepairFailedAgentIds(repair = {}) {
  const source = object(repair);
  return [...new Set([
    ...(Array.isArray(source.sourceAgentIds) ? source.sourceAgentIds : []),
    ...Object.values(object(source.failures)).flatMap(entries =>
      (Array.isArray(entries) ? entries : []).map(entry => text(object(entry).agentId, 100))),
  ].filter(Boolean))].slice(-20);
}

/**
 * Decide what an exhausted keyword step, or a failed repair run, leads to.
 * Returns a repair whose state is pending (hand to another browser),
 * unopenable (finish with a warning) or closed (a repair run that reached the
 * limit). Returns null when an ordinary exhausted failure stays terminal.
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
  repairRun = null,
  now = new Date(),
} = {}) {
  const code = text(entry.errorCode || entry.error_code || object(entry.error).code, 100).toUpperCase();
  const metadata = object(itemMetadata);
  const run = repairRun ? object(repairRun) : null;
  if (code !== EXHAUSTED_CODE && !run) return null;
  const pending = pendingKeywordRepair(metadata);
  // Terminal snapshots are replayed until another browser claims the item;
  // the same source execution keeps its one planned repair.
  if (pending && text(executionTaskId, 100) &&
      pending.sourceExecutionTaskId === text(executionTaskId, 100)) {
    return pending;
  }
  const keyword = text(object(checkpoint).keyword || entry.keyword, 120);
  if (!keyword) return null;
  const round = Math.max(1, Math.floor(Number(object(checkpoint).round || entry.round)) || 1);
  const previous = object(metadata.keywordRepair);
  const sameStep = Number(previous.version) === 1 && text(previous.keyword, 120) === keyword &&
    Math.max(1, Number(previous.round) || 1) === round;
  let targets = normalizeKeywordRepairTargets(
    object(object(checkpoint).enhancementFailure).failedTargets,
    platform,
  );
  if (run) {
    // A repair run handles only its targets. One that names none failed them all.
    const runIds = new Set((run.targets || []).map(target => text(object(target).externalId, 120)));
    targets = targets.filter(target => runIds.has(target.externalId));
    if (targets.length === 0) {
      targets = normalizeKeywordRepairTargets(run.targets, platform)
        .map(({code: _code, stage: _stage, ...target}) => target);
    }
  }
  if (targets.length === 0) return null;
  const failures = mergeFailures(sameStep ? previous.failures : {}, targets, sourceAgentId);
  const previousCount = sameStep ? Math.max(0, Math.floor(Number(previous.count)) || 0) : 0;
  const sourceAgentIds = [...new Set([
    ...(sameStep && Array.isArray(previous.sourceAgentIds) ? previous.sourceAgentIds : []),
    text(sourceAgentId, 100),
  ].filter(Boolean))].slice(-10);
  const base = {
    version: 1,
    keyword,
    round,
    platform: text(platform, 40).toLowerCase(),
    targets: targets.map(({code: _code, stage, ...target}) => ({...target, ...(stage ? {stage} : {})})),
    sourceAgentIds,
    failures,
    ...(text(previous.requestedAt, 60) && sameStep ? {requestedAt: text(previous.requestedAt, 60)} : {}),
  };
  if (targets.every(target => keywordRepairTargetUnopenable(failures[target.externalId]))) {
    return {...base, state: 'unopenable', count: previousCount, settledStatus: 'completed_with_warnings',
      settledExecutionTaskId: text(executionTaskId, 100), settledAt: isoNow(now)};
  }
  const closed = () => run
    ? {...base, state: 'closed', count: previousCount, settledStatus: 'failed',
      settledExecutionTaskId: text(executionTaskId, 100), settledAt: isoNow(now)}
    : null;
  if (!attemptBudgetRemaining) return closed();
  if (text(metadata.pinnedAgentId, 100)) return closed();
  if (object(parentMetadata).automaticRetryDisabled === true) return closed();
  if (object(object(planSnapshot).recoveryPolicy).allowIdleAgentHandoff === false) return closed();
  if (previousCount >= KEYWORD_REPAIR_LIMIT) return closed();
  return {
    ...base,
    state: 'pending',
    count: previousCount + 1,
    sourceExecutionTaskId: text(executionTaskId, 100),
    requestedAt: isoNow(now),
  };
}

/**
 * A settled snapshot closes the pending repair, so a later relay of the same
 * item never re-sends old targets. A completed keyword needs every step, so it
 * also completes a repair of an earlier step.
 */
export function settleKeywordRepair({itemMetadata = {}, checkpoint = {}, status = '', executionTaskId = '', now = new Date()} = {}) {
  const repair = pendingKeywordRepair(itemMetadata);
  if (!repair) return null;
  if (!SETTLED_STATUSES.has(status)) return null;
  const round = Math.max(1, Math.floor(Number(object(checkpoint).round)) || 1);
  if (!SUCCESS_STATUSES.has(status) && round !== Math.max(1, Number(repair.round) || 1)) return null;
  return {
    ...repair,
    state: SUCCESS_STATUSES.has(status) ? 'completed' : 'closed',
    settledStatus: status,
    ...(text(executionTaskId, 100) ? {settledExecutionTaskId: text(executionTaskId, 100)} : {}),
    settledAt: isoNow(now),
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

function repairAgentCount(repair = {}) {
  return new Set(Object.values(object(repair.failures)).flatMap(entries =>
    (Array.isArray(entries) ? entries : []).map(entry => text(object(entry).agentId, 100)).filter(Boolean))).size;
}

/** The note a keyword carries when it finished without posts no browser could open. */
export function keywordRepairUnopenableError(error = {}, repair = {}) {
  const source = object(error);
  const targets = Array.isArray(repair.targets) ? repair.targets : [];
  return {
    code: KEYWORD_POSTS_UNOPENABLE_CODE,
    category: 'post_unavailable',
    retryable: false,
    sourceCode: text(source.code, 100) || EXHAUSTED_CODE,
    unopenableTargets: targets.slice(0, 50).map(target => ({
      externalId: text(target.externalId, 120),
      url: text(target.url, 2000),
      agentCount: new Set((object(repair.failures)[target.externalId] || [])
        .map(entry => text(object(entry).agentId, 100)).filter(Boolean)).size,
    })),
    message: `${targets.length} 条帖子在 ${repairAgentCount(repair)} 个节点都打不开，可能已删除或审核中；` +
      '关键词其余结果已保存，下一轮巡检搜到时会再试',
  };
}

/** The error a repair run leaves when the repair limit ends it. */
export function keywordRepairClosedError(error = {}, repair = {}) {
  const source = object(error);
  const count = Array.isArray(repair.targets) ? repair.targets.length : 0;
  const message = text(source.message, 900);
  return {
    ...source,
    code: text(source.code, 100) || EXHAUSTED_CODE,
    retryable: false,
    keywordRepair: {count: repair.count, targetCount: count, round: repair.round},
    message: `${message || '采集增强未全部完成'}；已换 ${repairAgentCount(repair)} 个节点补采这 ${count} 条帖子，仍未完成`,
  };
}

function repairRunMatches(childRepair, pending) {
  const run = object(childRepair);
  return Boolean(pending) && Number(run.version) === 1 &&
    text(run.keyword, 120) === text(pending.keyword, 120) &&
    Math.max(1, Number(run.round) || 1) === Math.max(1, Number(pending.round) || 1) &&
    Math.floor(Number(run.count)) === Math.floor(Number(pending.count));
}

/**
 * The projection's repair decision for one keyword entry. Returns the status,
 * error and repair metadata to store, or null when repair is not involved.
 * A snapshot replay reproduces the decision of the execution that made it.
 */
export function decideKeywordRepair({
  entry = {},
  checkpoint = {},
  status = '',
  error = {},
  itemMetadata = {},
  childRepair = null,
  planSnapshot = {},
  parentMetadata = {},
  platform = '',
  agentId = '',
  executionTaskId = '',
  attemptBudgetRemaining = true,
  now = new Date(),
} = {}) {
  const metadata = object(itemMetadata);
  const existing = object(metadata.keywordRepair);
  const taskId = text(executionTaskId, 100);
  const sourceError = object(error);
  if (taskId && Number(existing.version) === 1 && existing.state === 'pending' &&
      existing.sourceExecutionTaskId === taskId) {
    return {status: 'retryable', error: keywordRepairPendingError(sourceError, existing), repair: existing};
  }
  if (taskId && Number(existing.version) === 1 && existing.settledExecutionTaskId === taskId) {
    if (existing.state === 'unopenable') {
      return {status: 'completed_with_warnings', error: keywordRepairUnopenableError(sourceError, existing), repair: existing};
    }
    if (existing.state === 'closed' && existing.settledStatus === 'failed') {
      return {status: 'failed', error: keywordRepairClosedError(sourceError, existing), repair: existing};
    }
  }
  const pending = pendingKeywordRepair(metadata);
  const round = Math.max(1, Math.floor(Number(object(checkpoint).round || entry.round)) || 1);
  const run = pending && repairRunMatches(childRepair, pending) &&
    round === Math.max(1, Number(pending.round) || 1) ? pending : null;
  const blocked = sourceError.securityBlocked === true || sourceError.platformSafetyBlocked === true ||
    sourceError.requiresManualAction === true;
  const code = text(entry.errorCode || entry.error_code || object(entry.error).code, 100).toUpperCase();
  const exhausted = status === 'failed' && code === EXHAUSTED_CODE;
  // A repair run that ended failed counts whatever it reported. One the
  // browser lost (an interruption or a broken runner) runs again elsewhere.
  const interrupted = entry.recoverableInterruption === true || entry.recoveryRequired === true ||
    NODE_FAILURE_CODES.has(code);
  const runFailed = Boolean(run) && text(entry.status, 80).toLowerCase() === 'failed' && !interrupted &&
    !['canceled', 'needs_action'].includes(status);
  if (!blocked && (exhausted || runFailed)) {
    const repair = planKeywordRepair({
      entry, checkpoint, itemMetadata: metadata, planSnapshot, parentMetadata, platform,
      sourceAgentId: agentId, executionTaskId: taskId, attemptBudgetRemaining, repairRun: run, now,
    });
    if (repair?.state === 'pending') {
      return {status: 'retryable', error: keywordRepairPendingError(sourceError, repair), repair};
    }
    if (repair?.state === 'unopenable') {
      return {status: 'completed_with_warnings', error: keywordRepairUnopenableError(sourceError, repair), repair};
    }
    if (repair?.state === 'closed') {
      return {status: 'failed', error: keywordRepairClosedError(sourceError, repair), repair};
    }
    return null;
  }
  const settled = settleKeywordRepair({itemMetadata: metadata, checkpoint, status, executionTaskId: taskId, now});
  return settled ? {status, error: sourceError, repair: settled} : null;
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
