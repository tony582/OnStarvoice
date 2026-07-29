/**
 * Optional AI relevance prefilter for keyword-search records.
 *
 * This module deliberately operates on list-page text only. It never calls an
 * AI provider from the extension and never blocks the original capture path on
 * an error. The server owns intent parsing, prompts and the DeepSeek call.
 */

import {prefilterRelevance} from '../api.js';

export const RELEVANCE_PREFILTER_DEFAULT_THRESHOLD = 0.97;
// DeepSeek handles smaller groups much more predictably. Keep each request
// small enough to finish inside the extension's bounded wait while still
// running the requests for one keyword in parallel.
export const RELEVANCE_PREFILTER_BATCH_SIZE = 5;
export const RELEVANCE_PREFILTER_TIMEOUT_MS = 20000;
export const RELEVANCE_PREFILTER_MAX_CONCURRENCY = 6;

const KEYWORD_RECORD_TYPE = 'keyword_notes';
const INSUFFICIENT_TITLE_PATTERN =
  /^(?:无标题(?:数据)?|搜索结果笔记|抖音搜索结果(?:\s*\d+)?|关键词\s*[:：]|单篇笔记)$/iu;

function normalizeText(value, limit = 280) {
  return String(value || '')
    .replace(/[\u200b-\u200d\ufeff]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function normalizeKeyword(value) {
  return normalizeText(value, 120);
}

function appendKeyword(labels, seen, value) {
  if (Array.isArray(value)) {
    value.forEach((item) => appendKeyword(labels, seen, item));
    return;
  }
  const label = normalizeKeyword(value);
  const key = label.toLocaleLowerCase();
  if (!label || seen.has(key)) return;
  seen.add(key);
  labels.push(label);
}

export function collectRelevancePrefilterKeywords(record = {}) {
  const payload =
    record?.payload && typeof record.payload === 'object' ? record.payload : {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === 'object'
      ? payload.items[0]
      : {};
  const labels = [];
  const seen = new Set();
  [
    payload.keyword,
    payload.searchKeyword,
    firstItem.keyword,
    firstItem.searchKeyword,
    payload.matchedKeyword,
    firstItem.matchedKeyword,
    payload.matchedKeywords,
    firstItem.matchedKeywords,
    payload.keywords,
    firstItem.keywords,
  ].forEach((value) => appendKeyword(labels, seen, value));
  return labels;
}

function resolveRecordPlatform(record = {}, firstItem = {}) {
  const direct = normalizeText(record?.platform || record?.payload?.platform, 40)
    .toLocaleLowerCase();
  if (['xiaohongshu', 'xhs', 'red', '小红书'].includes(direct)) {
    return 'xiaohongshu';
  }
  if (['douyin', 'dy', '抖音'].includes(direct)) return 'douyin';
  if (direct) return direct;
  const url = normalizeText(firstItem?.url || firstItem?.noteUrl, 600);
  if (/xiaohongshu\.com/iu.test(url)) return 'xiaohongshu';
  if (/douyin\.com/iu.test(url)) return 'douyin';
  return '';
}

function resolveRecordExternalId(record = {}, firstItem = {}) {
  return normalizeText(
    firstItem.noteId ||
      firstItem.awemeId ||
      record?.payload?.noteId ||
      record?.externalId,
    180,
  );
}

function resolveRecordItemId(record = {}, externalId = '', platform = '') {
  const recordId = normalizeText(record?.id, 180);
  if (recordId) return recordId;
  if (externalId) return `${platform || 'unknown'}:${externalId}`;
  return '';
}

export function buildRelevancePrefilterCandidate(
  record = {},
  {keyword = ''} = {},
) {
  const type = normalizeText(record?.type || record?.recordType, 80);
  if (type !== KEYWORD_RECORD_TYPE) return null;

  const payload =
    record?.payload && typeof record.payload === 'object' ? record.payload : {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === 'object'
      ? payload.items[0]
      : {};
  const resolvedKeyword =
    normalizeKeyword(keyword) || collectRelevancePrefilterKeywords(record)[0] || '';
  const platform = resolveRecordPlatform(record, firstItem);
  const externalId = resolveRecordExternalId(record, firstItem);
  const itemId = resolveRecordItemId(record, externalId, platform);
  if (!itemId || !platform || !resolvedKeyword) return null;

  const title = normalizeText(firstItem.title || record?.title, 280);
  const author = normalizeText(
    firstItem.author || firstItem.nickname || firstItem.bloggerName,
    160,
  );
  const noteType = normalizeText(
    firstItem.noteType || firstItem.contentType || firstItem.type,
    40,
  ).toLocaleLowerCase();
  const publishTime = normalizeText(
    firstItem.publishDateRaw ||
      firstItem.publishDate ||
      firstItem.lastEditedAt ||
      firstItem.publishTime,
    80,
  );
  const canSkip = Boolean(
    title &&
      title.length >= 2 &&
      !INSUFFICIENT_TITLE_PATTERN.test(title),
  );

  return {
    recordId: normalizeText(record?.id, 180) || itemId,
    keyword: resolvedKeyword,
    platform,
    itemId,
    canSkip,
    evidence: {
      itemId,
      externalId,
      title,
      author,
      noteType,
      publishTime,
    },
  };
}

function normalizeThreshold(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return RELEVANCE_PREFILTER_DEFAULT_THRESHOLD;
  return Math.max(
    RELEVANCE_PREFILTER_DEFAULT_THRESHOLD,
    Math.min(1, numeric),
  );
}

function chunkItems(items, size = RELEVANCE_PREFILTER_BATCH_SIZE) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function runWithConcurrency(
  items,
  worker,
  limit = RELEVANCE_PREFILTER_MAX_CONCURRENCY,
) {
  const source = Array.isArray(items) ? items : [];
  if (source.length === 0) return;
  let cursor = 0;
  const workerCount = Math.min(
    source.length,
    Math.max(1, Number(limit) || 1),
  );
  await Promise.all(
    Array.from({length: workerCount}, async () => {
      while (cursor < source.length) {
        const index = cursor;
        cursor += 1;
        await worker(source[index], index);
      }
    }),
  );
}

function hashText(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createRequestId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Fall through to a non-security identifier used only for diagnostics.
  }
  return `prefilter-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Keep one idempotency key inside one HTTP request/retry scope only.
 *
 * The generic API layer appends the active capture task context immediately
 * before sending. Reusing a content-only key in a later capture run therefore
 * produced the same key with a different taskId in the request body, which the
 * server correctly rejected as IDEMPOTENCY_CONFLICT. Including requestId keeps
 * transport retries idempotent while preventing different capture runs from
 * sharing a key just because their list text happens to be identical.
 */
export function buildRelevancePrefilterIdempotencyKey({
  requestId = '',
  platform = '',
  keyword = '',
  threshold = RELEVANCE_PREFILTER_DEFAULT_THRESHOLD,
  batchIndex = 0,
  items = [],
} = {}) {
  const normalizedThreshold = normalizeThreshold(threshold);
  const normalizedRequestId = normalizeText(requestId, 200);
  const contentHash = hashText(JSON.stringify(Array.isArray(items) ? items : []));
  const baseKey = `${normalizeText(platform, 40).toLocaleLowerCase()}:${hashText(
    normalizeKeyword(keyword),
  )}:list:conservative:${normalizedThreshold.toFixed(4)}:${Math.max(
    0,
    Number(batchIndex) || 0,
  )}:${contentHash}`;
  return normalizedRequestId
    ? `${baseKey}:request:${normalizedRequestId}`
    : baseKey;
}

function readResponseItems(response) {
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.data?.items)) return response.data.items;
  if (Array.isArray(response?.data?.data?.items)) return response.data.data.items;
  return [];
}

function isTimeoutLikeError(error) {
  const text = `${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`
    .toLocaleLowerCase();
  return text.includes('timeout') || text.includes('abort');
}

export function normalizeRelevancePrefilterDecision(
  raw = {},
  {threshold = RELEVANCE_PREFILTER_DEFAULT_THRESHOLD, canSkip = true} = {},
) {
  const status = normalizeText(raw?.status, 40).toLocaleLowerCase();
  const modelDecision = normalizeText(
    raw?.modelDecision || raw?.decision,
    40,
  ).toLocaleLowerCase();
  const confidence = Number(raw?.confidence);
  const executionDisposition = normalizeText(
    raw?.executionDisposition,
    80,
  ).toLocaleLowerCase();
  const normalizedThreshold = normalizeThreshold(threshold);
  const valid =
    status === 'ok' &&
    new Set(['keep', 'skip', 'need_detail']).has(modelDecision) &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1;
  const shouldSkip = Boolean(
    valid &&
      canSkip &&
      modelDecision === 'skip' &&
      executionDisposition === 'skip_full_capture' &&
      confidence >= normalizedThreshold,
  );
  return {
    valid,
    shouldSkip,
    status: status || 'model_error',
    modelDecision: valid ? modelDecision : null,
    confidence: valid ? confidence : null,
    executionDisposition: executionDisposition || null,
    reason: normalizeText(raw?.reason, 320),
    evidence: Array.isArray(raw?.evidence)
      ? raw.evidence.map((value) => normalizeText(value, 120)).filter(Boolean)
      : [],
  };
}

function buildGroupKey(candidate) {
  return `${candidate.platform}\u0000${candidate.keyword.toLocaleLowerCase()}`;
}

function isStopRequested(shouldStop) {
  if (typeof shouldStop !== 'function') return false;
  try {
    return shouldStop() === true;
  } catch {
    return true;
  }
}

/**
 * Evaluate keyword-search records in batches. Every malformed, missing, timed
 * out or failed decision is returned as allowed (fail open).
 */
export async function evaluateRelevancePrefilterRecords(
  records = [],
  {
    enabled = false,
    keyword = '',
    threshold = RELEVANCE_PREFILTER_DEFAULT_THRESHOLD,
    timeoutMs = RELEVANCE_PREFILTER_TIMEOUT_MS,
    shouldStop = null,
    requestBatch = prefilterRelevance,
  } = {},
) {
  const inputRecords = Array.isArray(records) ? records : [];
  const candidates = inputRecords
    .map((record) => buildRelevancePrefilterCandidate(record, {keyword}))
    .filter(Boolean);
  const resultBase = {
    enabled: Boolean(enabled),
    evaluatedCount: 0,
    skippedCount: 0,
    failedOpenCount: 0,
    retryCount: 0,
    retriedItemCount: 0,
    timeoutCount: 0,
    ineligibleCount: Math.max(0, inputRecords.length - candidates.length),
    skippedRecordIds: [],
    decisions: [],
    canceled: false,
  };
  if (!enabled || candidates.length === 0) return resultBase;
  if (isStopRequested(shouldStop)) {
    return {...resultBase, canceled: true, failedOpenCount: candidates.length};
  }

  const groups = new Map();
  candidates.forEach((candidate) => {
    const key = buildGroupKey(candidate);
    const group = groups.get(key) || [];
    group.push(candidate);
    groups.set(key, group);
  });

  const normalizedThreshold = normalizeThreshold(threshold);
  const decisions = [];
  let retryCount = 0;
  let retriedItemCount = 0;
  const batchJobs = [...groups.values()].flatMap((groupCandidates) =>
    chunkItems(groupCandidates).map((batch, batchIndex) => ({batch, batchIndex})),
  );

  const requestBatchOnce = async (
    batch,
    {batchIndex = 0, retryPart = 0} = {},
  ) => {
    if (isStopRequested(shouldStop)) {
      return batch.map((candidate) => ({
        ...candidate,
        valid: false,
        shouldSkip: false,
        status: 'canceled',
        modelDecision: null,
        confidence: null,
        executionDisposition: null,
        reason: '任务已停止，AI 筛选安全放行',
        evidence: [],
      }));
    }

    const requestId = createRequestId();
    const requestItems = batch.map((candidate) => candidate.evidence);
    let response = null;
    try {
      response = await requestBatch(
        {
          requestId,
          idempotencyKey: buildRelevancePrefilterIdempotencyKey({
            requestId,
            platform: batch[0].platform,
            keyword: batch[0].keyword,
            threshold: normalizedThreshold,
            batchIndex: batchIndex * 10 + retryPart,
            items: requestItems,
          }),
          platform: batch[0].platform,
          stage: 'list',
          keyword: batch[0].keyword,
          promptVersion: 'prefilter-list-v2',
          mode: 'conservative',
          skipThreshold: normalizedThreshold,
          items: requestItems,
        },
        {
          timeout: timeoutMs,
          shouldStop,
        },
      );
    } catch (error) {
      response = isTimeoutLikeError(error)
        ? {
            ok: false,
            reason: 'timeout',
            message: 'AI 判断等待超时，安全放行',
          }
        : null;
    }

    const responseItems = response?.ok ? readResponseItems(response) : [];
    const responseByItemId = new Map();
    responseItems.forEach((item) => {
      const itemId = normalizeText(item?.itemId, 180);
      if (!itemId || responseByItemId.has(itemId)) {
        if (itemId) responseByItemId.set(itemId, null);
        return;
      }
      responseByItemId.set(itemId, item);
    });

    return batch.map((candidate) => {
      const raw = responseByItemId.get(candidate.itemId);
      const decision = raw
        ? normalizeRelevancePrefilterDecision(raw, {
            threshold: normalizedThreshold,
            canSkip: candidate.canSkip,
          })
        : {
            valid: false,
            shouldSkip: false,
            status: response?.canceled
              ? 'canceled'
              : response?.reason === 'timeout'
                ? 'timeout'
                : 'model_error',
            modelDecision: null,
            confidence: null,
            executionDisposition: null,
            reason: normalizeText(
              response?.message || 'AI 未返回有效判断，安全放行',
              320,
            ),
            evidence: [],
          };
      return {...candidate, ...decision};
    });
  };

  await runWithConcurrency(
    batchJobs,
    async ({batch, batchIndex}) => {
      const initialDecisions = await requestBatchOnce(batch, {batchIndex});
      const wholeBatchTimedOut =
        batch.length > 1 &&
        initialDecisions.length === batch.length &&
        initialDecisions.every((decision) => decision.status === 'timeout');
      if (!wholeBatchTimedOut || isStopRequested(shouldStop)) {
        decisions.push(...initialDecisions);
        return;
      }

      const splitAt = Math.ceil(batch.length / 2);
      const retryBatches = [batch.slice(0, splitAt), batch.slice(splitAt)].filter(
        (retryBatch) => retryBatch.length > 0,
      );
      retriedItemCount += batch.length;
      for (let retryPart = 0; retryPart < retryBatches.length; retryPart += 1) {
        retryCount += 1;
        decisions.push(
          ...(await requestBatchOnce(retryBatches[retryPart], {
            batchIndex,
            retryPart: retryPart + 1,
          })),
        );
      }
    },
  );

  const skippedRecordIds = decisions
    .filter((decision) => decision.shouldSkip)
    .map((decision) => decision.recordId);
  return {
    ...resultBase,
    evaluatedCount: decisions.filter((decision) => decision.valid).length,
    skippedCount: skippedRecordIds.length,
    failedOpenCount: decisions.filter((decision) => !decision.valid).length,
    retryCount,
    retriedItemCount,
    timeoutCount: decisions.filter((decision) => decision.status === 'timeout')
      .length,
    skippedRecordIds: [...new Set(skippedRecordIds)],
    decisions,
    canceled: isStopRequested(shouldStop),
  };
}
