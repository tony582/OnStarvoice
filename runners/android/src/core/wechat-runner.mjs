import {BudgetLedger} from './budget.mjs';
import {OperationGate} from './operation-gate.mjs';
import {RunnerFault, requireEvidence} from './errors.mjs';
import {DeviceClosureJournal, readDeviceClosure} from './device-closure.mjs';
import {recordDiagnostic} from './diagnostics.mjs';
import {faultDetails} from './discovery-runner.mjs';
import {wechatPostEvent, wechatWorkKey} from './wechat-evidence.mjs';
import {sameCard} from '../device/wechat-ocr-parse.mjs';
import {runWechatPatrol} from './wechat-patrol.mjs';
import {runWechatForward} from './wechat-forward.mjs';

const DEFAULT_CLOCK = {wallNow: () => Date.now(), monotonicNow: () => performance.now()};
const METHODS = ['inspect', 'search', 'readCards', 'openCard', 'copyLink', 'readComments', 'returnToResults', 'recoverResults', 'scroll'];
// One post that fails in a known, settled way is skipped once the results page is proven again.
const RECOVERABLE = new Set(['card_open_failed', 'share_sheet_unverified', 'link_not_copied', 'comments_unverified', 'screen_unverified']);
export const MAX_CONSECUTIVE_SKIPS = 4;
// Calm pacing between posts (account safety): a random 3–6 s pause, cut short by a stop.
export const POST_PAUSE_MS = [3000, 6000];
const PREVIEW_RETRIES = [0, 1000, 3000];
const EARLY_PREVIEW_WAIT_MS = 2500;

function outcome(error) {
  if (error.code === 'budget_exhausted') return {status: 'completed_with_warnings', reason: error.details.reason};
  if (['user_stop', 'operator_takeover', 'remote_stop'].includes(error.code)) return {status: 'canceled', reason: error.code};
  if (['lease_expired', 'usb_disconnected'].includes(error.code)) return {status: 'interrupted', reason: error.code};
  return {status: 'needs_action', reason: error.code ?? 'device_failure'};
}

function validateTask(task, permit, device) {
  requireEvidence(task?.identity && typeof task.keyword === 'string' && task.keyword.trim(), 'invalid_task');
  requireEvidence(task.platform === 'wechat_channels' && task.filters && typeof task.filters === 'object', 'invalid_task');
  for (const field of ['taskId', 'itemId', 'attemptId', 'requestHash', 'agentId', 'discoveryRunId']) {
    requireEvidence(typeof task.identity[field] === 'string' && task.identity[field], 'invalid_task_identity');
    requireEvidence(permit.identity[field] === task.identity[field], 'permit_identity_mismatch');
  }
  requireEvidence(task.identity.discoveryRunId === task.identity.taskId, 'invalid_discovery_run');
  for (const method of METHODS) requireEvidence(typeof device[method] === 'function', 'invalid_device_adapter');
}

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, {once: true});
});

/** One Channels keyword on the phone: search, then per in-window card open → copy link → comments → back. */
export async function runWechatTask({task, store, device, permit, preview, clock = DEFAULT_CLOCK, resumeAuthorized = false,
  deviceClosureVerified = null, actionTimeoutMs = 60_000, prefilter = null, random = Math.random, postPauseMs = POST_PAUSE_MS}) {
  let ledger, gate, result, failure = null, lastEventId = null;
  const stats = {posts: 0, previewFailed: 0, previewUnavailable: 0, outsideWindow: 0, comments: 0};
  const pending = [];
  const note = (event, error = null, extra = {}) => recordDiagnostic(store, {at: new Date(clock.wallNow()).toISOString(), event,
    runId: task?.identity?.discoveryRunId ?? null, itemId: task?.identity?.itemId ?? null, keyword: task?.keyword ?? null,
    code: error?.code ?? null, operation: error?.operation ?? null, details: error ? faultDetails(error) : null, ...extra});
  const windowHours = Number.isFinite(task?.filters?.publishWindowHours) ? task.filters.publishWindowHours : null;
  const resolvePreview = async link => {
    let last;
    for (const wait of PREVIEW_RETRIES) {
      if (wait) await sleep(wait, permit.signal);
      try { return await preview.resolve(link); } catch (error) { last = error; if (error.code === 'share_link_invalid') break; }
    }
    throw last;
  };
  const assemble = async ({card, rank, shareUrl, info, comments, capturedAt}) => {
    let value;
    try { value = await info; } catch (error) { stats.previewFailed++; note('wechat_preview_failed', error); return; }
    if (value.unavailable) { stats.previewUnavailable++; return; }
    if (windowHours !== null && (capturedAt / 1000 - value.createtime) / 3600 > windowHours) { stats.outsideWindow++; return; }
    const event = wechatPostEvent({task, card, rank, shareUrl, info: value, comments: await comments, capturedAt});
    if (!store.getEvent(event.eventId)) { store.recordEvent(event); stats.posts++; stats.comments += event.comments.items.length; }
    lastEventId = event.eventId;
  };
  try {
    validateTask(task, permit, device);
    requireEvidence(preview && typeof preview.resolve === 'function', 'preview_unavailable');
    permit.assertAllowed();
    const journal = new DeviceClosureJournal({store, task, clock, deviceClosureVerified});
    ledger = new BudgetLedger({task, store, clock, resumeAuthorized});
    gate = new OperationGate({permit, beforeAction: () => ledger.assertAllowed(), journal, timeoutMs: actionTimeoutMs});
    const call = (method, params = {}) => gate.run(signal => device[method]({...params, signal}), method);
    const state = await call('inspect');
    requireEvidence(state?.deviceId === task.deviceId, 'device_identity_mismatch');
    if (state.readyForSearch === false) throw new RunnerFault(state.reason ?? 'device_not_ready');
    const commentLimit = task.comments?.enabled === true ? Math.max(0, Math.min(500, task.comments.limit ?? 50)) : 0;
    if (task.mode === 'forward') {
      // 「发到微信」 (0.4.6): no search, no upload; the result is whether the post was sent.
      requireEvidence(typeof device.openPost === 'function' && typeof device.forwardPost === 'function', 'invalid_device_adapter');
      result = await runWechatForward({task, call, resolve: resolvePreview, note});
    } else if (task.mode === 'patrol') {
      const record = event => {
        if (!store.getEvent(event.eventId)) { store.recordEvent(event); stats.posts++; stats.comments += event.comments.items.length; }
        lastEventId = event.eventId;
      };
      result = await runWechatPatrol({task, call, resolve: resolvePreview, commentLimit, clock, record, note,
        canOpenPost: typeof device.openPost === 'function'});
    } else {
      const sort = windowHours !== null ? 'latest' : (task.filters.sort ?? 'all');
      // The App's own 时长 / 范围 choices (0.4.5); absent means 不限.
      const searched = await call('search', {keyword: task.keyword, sort,
        duration: task.filters.duration ?? 'all', scope: task.filters.scope ?? 'all'});
      requireEvidence(searched?.verified === true, 'search_context_unverified');
      const seen = [];
      let cards = searched.cards, emptyPages = 0, older = 0, skips = 0, rank = 0;
      const decide = cardPrefilter(prefilter, task, permit, clock, ledger);
      while (!result) {
        const fresh = cards.filter(card => !seen.some(other => sameCard(other, card)));
        if (!fresh.length) {
          emptyPages++;
          if (emptyPages >= 2) { result = {status: 'completed', reason: 'results_end'}; break; }
          ledger.beforeSwipe();
          await call('scroll');
          cards = await call('readCards');
          continue;
        }
        emptyPages = 0;
        const skip = await decide(fresh);
        const card = fresh[0];
        seen.push(card);
        rank++;
        if (windowHours !== null && card.age && card.age.minHours > windowHours) {
          older++;
          if (older >= 2) { result = {status: 'completed', reason: 'publish_window_end'}; break; }
          continue;
        }
        if (card.age) older = 0;
        if (skip.has(card.cardKey)) continue;
        ledger.beforeCard();
        let shareUrl;
        try {
          await call('openCard', {card});
          ({shareUrl} = await call('copyLink'));
        } catch (error) {
          if (!RECOVERABLE.has(error.code) || error.deviceSettled !== true || skips >= MAX_CONSECUTIVE_SKIPS) throw error;
          note('wechat_card_skipped', error);
          skips++;
          try { cards = await call('recoverResults'); }
          catch (recovery) {
            if (['user_stop', 'remote_stop', 'lease_expired', 'aborted'].includes(recovery.code)) throw recovery;
            throw new RunnerFault(error.code, `${error.message}; safe return failed (${recovery.code})`, {...faultDetails(error), recovery: recovery.code});
          }
          continue;
        }
        const capturedAt = clock.wallNow();
        const info = resolvePreview(shareUrl);
        info.catch(() => {});
        // A post found outside the window by its exact time is not read further; its comments are skipped.
        const early = await Promise.race([info.then(value => value, () => null), sleep(EARLY_PREVIEW_WAIT_MS, permit.signal).then(() => null)]);
        const outside = early && !early.unavailable && windowHours !== null && (capturedAt / 1000 - early.createtime) / 3600 > windowHours;
        let comments = Promise.resolve({status: 'disabled', items: []});
        if (commentLimit > 0 && !outside && !early?.unavailable) {
          try { comments = Promise.resolve(await call('readComments', {limit: commentLimit})); }
          catch (error) {
            if (!RECOVERABLE.has(error.code) || error.deviceSettled !== true) throw error;
            note('wechat_comments_unread', error);
          }
        }
        pending.push(assemble({card, rank, shareUrl, info, comments, capturedAt}));
        ledger.noteLink(early ? wechatWorkKey(early) : `card:${card.cardKey}`);
        skips = 0;
        cards = await call('returnToResults');
        if (outside && sort === 'latest') { older++; if (older >= 2) { result = {status: 'completed', reason: 'publish_window_end'}; break; } }
        const [low, high] = postPauseMs;
        await sleep(low + Math.round(random() * (high - low)), permit.signal);
        permit.assertAllowed();
      }
    }
  } catch (error) {
    failure = error;
    result = {...outcome(error), message: error.message, details: faultDetails(error)};
  }
  await Promise.allSettled(pending);
  if (ledger) {
    try { ledger.finish(result.status, result.reason); }
    catch (error) { failure = error; result = {...outcome(error), message: error.message, details: faultDetails(error)}; }
  }
  note('task_finished', failure, {status: result.status, reason: result.reason, stats: {...ledger?.summary(), ...stats}});
  const deviceClosure = task?.deviceId ? readDeviceClosure(store, task.deviceId) : null;
  const deviceIdle = !deviceClosure?.required && (gate ? gate.deviceIdle : true);
  return {...result, stats: ledger ? {...ledger.summary(), ...stats} : null, lastEventId, deviceIdle,
    stopConfirmationRequired: !deviceIdle, deviceClosure, pendingEvents: store.pendingCount()};
}

// The relevance prefilter on card text (snippet + author), the same switch and skip rule as on Douyin; any
// failure opens the cards. Returns decide(cards) → Set of card keys to leave unopened.
function cardPrefilter(prefilter, task, permit, clock, ledger) {
  let filter = null;
  try { filter = typeof prefilter === 'function' ? prefilter({task, signal: permit.signal, now: clock.monotonicNow}) : null; } catch { filter = null; }
  if (filter?.enabled !== true) return async () => new Set();
  ledger.notePrefilter();
  const asked = new Set(), skipped = new Set();
  return async cards => {
    const fresh = cards.filter(card => !asked.has(card.cardKey) && card.snippet);
    if (!fresh.length) return skipped;
    fresh.forEach(card => asked.add(card.cardKey));
    permit.assertAllowed();
    let decision = null;
    try { decision = await filter.decide(fresh.map(card => ({cardId: card.cardKey, title: card.snippet, author: card.author}))); }
    catch { /* fail open */ }
    const skip = decision?.skip instanceof Set ? decision.skip : new Set();
    skip.forEach(key => skipped.add(key));
    ledger.notePrefilter({skipped: skip.size, judged: decision?.judged ?? 0, unjudged: decision ? decision.unjudged : fresh.length});
    permit.assertAllowed();
    return skipped;
  };
}
