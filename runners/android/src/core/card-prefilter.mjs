import { randomUUID } from 'node:crypto';
import { RunnerFault } from './errors.mjs';

// 2026-10-03: about nine in ten cards a phone keyword opened (~17 s each to open and copy the link) were unrelated to
// the tenant. Before opening, the fresh cards of a results page now go to the server's existing relevance prefilter
// (the one the extension uses for 「AI 精准筛选」), and a card stays unopened only when the server clearly says so, by the
// extension's own skip rule. Every doubt opens the card: an error, a timeout, a switched-off plan or an unclear answer.
export const PREFILTER_BATCH = 8;
export const PREFILTER_TIMEOUT_MS = 30_000;
const MAX_FAILED_REQUESTS = 2;
const CARD_ID = /^[0-9a-f]{64}$/u;
// INSUFFICIENT_TITLE_PATTERN in utils/capture/relevance-prefilter.js: such a title is never enough to skip a work.
const PLACEHOLDER_TITLE = /^(?:无标题(?:数据)?|搜索结果笔记|抖音搜索结果(?:\s*\d+)?|关键词\s*[:：]|单篇笔记)$/iu;
const SERVER_CODE = /^[A-Za-z0-9_]{1,80}$/u;

export const cleanText = value => String(value ?? '').replace(/[\u200b-\u200d\ufeff]/gu, '').replace(/\s+/gu, ' ').trim();
/** Cut to `max` UTF-16 code units without leaving half a surrogate pair at the end. */
export function clipText(value, max) {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
export function titleCanBeSkipped(title) {
  const text = cleanText(title);
  return text.length >= 2 && !PLACEHOLDER_TITLE.test(text);
}

/** The extension's skip predicate (normalizeRelevancePrefilterDecision), applied strictly; anything else opens the card. */
export function shouldSkipCard(response, card) {
  if (response?.ok !== true || response.enabled !== true || !Array.isArray(response.items)) return false;
  const matches = response.items.filter(item => item?.cardId === card?.cardId);
  if (matches.length !== 1) return false;
  const [item] = matches;
  return item.status === 'ok' && item.modelDecision === 'skip' && item.tenantRelevance === 'irrelevant'
    && typeof item.confidence === 'number' && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1
    && item.protectedSignal !== true && item.executionDisposition === 'skip_full_capture' && titleCanBeSkipped(card.title);
}

const judgedItem = (response, card) => {
  const matches = response.items.filter(item => item?.cardId === card.cardId);
  return matches.length === 1 && matches[0].status === 'ok' ? matches[0] : null;
};
const failureCode = error => [error?.serverCode, error?.code].find(code => typeof code === 'string' && SERVER_CODE.test(code))
  ?? 'prefilter_failed';

/**
 * One prefilter per task. `decide(cards)` never throws: it returns the card IDs to leave unopened plus counts for the
 * completion stats. Only a card with a 64-hex ID and a title that could be skipped is sent (any other card opens
 * anyway), at most 8 per request and one request at a time. Two failed requests in a row, or one answer that the plan
 * switch is off, stop all further requests for this task; the cards that would have been sent then open unjudged.
 */
export function createCardPrefilter({ client, task, signal = null, now = () => performance.now(), onBatch = null,
  timeoutMs = PREFILTER_TIMEOUT_MS } = {}) {
  const enabled = task?.relevancePrefilter?.enabled === true && typeof client?.prefilter === 'function';
  let failedInARow = 0;
  let stopReason = null;
  const send = async (cards) => {
    const controller = new AbortController();
    let timer, onStop;
    const bounded = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new RunnerFault('prefilter_timeout')); }, timeoutMs);
      onStop = () => { controller.abort(); reject(new RunnerFault('aborted')); };
      signal?.addEventListener('abort', onStop, { once: true });
    });
    const body = { identity: task.identity, requestId: randomUUID(), cards: cards.map(card => ({ cardId: card.cardId,
      title: clipText(cleanText(card.title), 500), author: clipText(cleanText(card.author), 200) })) };
    try { return await Promise.race([bounded, Promise.resolve().then(() => client.prefilter(body, { signal: controller.signal }))]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onStop); }
  };
  async function decide(cards) {
    const result = { skip: new Set(), judged: 0, unjudged: 0, latencyMs: 0, failure: null };
    if (!enabled) return result;
    const ids = new Set();
    const eligible = (Array.isArray(cards) ? cards : []).filter(card => typeof card?.cardId === 'string'
      && CARD_ID.test(card.cardId) && !ids.has(card.cardId) && titleCanBeSkipped(card.title) && ids.add(card.cardId));
    for (let start = 0; start < eligible.length; start += PREFILTER_BATCH) {
      const batch = eligible.slice(start, start + PREFILTER_BATCH);
      if (stopReason || signal?.aborted) {
        result.unjudged += batch.length;
        result.failure ??= stopReason ?? 'aborted';
        continue;
      }
      const began = now();
      let response = null, failure = null;
      try {
        response = await send(batch);
        if (response?.ok !== true || typeof response.enabled !== 'boolean' || !Array.isArray(response.items)) failure = 'invalid_prefilter_response';
        else if (!response.enabled) failure = 'prefilter_disabled';
      } catch (error) { failure = signal?.aborted ? 'aborted' : failureCode(error); }
      const latencyMs = Math.max(0, now() - began);
      const skipped = [];
      let judged = 0;
      if (failure === 'prefilter_disabled') stopReason = failure;
      else if (failure && failure !== 'aborted' && ++failedInARow >= MAX_FAILED_REQUESTS) stopReason = 'prefilter_breaker_open';
      else if (!failure) {
        failedInARow = 0;
        for (const card of batch) {
          const item = judgedItem(response, card);
          if (!item) continue;
          judged++;
          if (shouldSkipCard(response, card)) {
            result.skip.add(card.cardId);
            skipped.push({ title: clipText(cleanText(card.title), 60), reason: clipText(cleanText(item.reason), 80) });
          }
        }
      }
      result.judged += judged;
      result.unjudged += batch.length - judged;
      result.latencyMs += latencyMs;
      result.failure ??= failure;
      // Local diagnostics only (diagnostics.mjs): card titles never leave the device.
      try {
        onBatch?.({ cards: batch.length, judged, skipped: skipped.length, unjudged: batch.length - judged, latencyMs, failure,
          degraded: response?.degraded === true, stopped: stopReason, aiSkipped: skipped.slice(0, PREFILTER_BATCH) });
      } catch { /* A diagnostics hook never changes a decision. */ }
    }
    return result;
  }
  return Object.freeze({ enabled, decide, get stopped() { return stopReason; } });
}
