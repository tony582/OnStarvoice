import { randomUUID } from 'node:crypto';
import { BudgetLedger } from './budget.mjs';
import { OperationGate } from './operation-gate.mjs';
import { RunnerFault, requireEvidence } from './errors.mjs';
import { verifyContext, verifyLink, discoveryEvent, eventIdFor, discoveredWorkKey } from './discovery-evidence.mjs';
import { DeviceClosureJournal, readDeviceClosure } from './device-closure.mjs';
import { recordDiagnostic } from './diagnostics.mjs';

const DEFAULT_CLOCK = { wallNow: () => Date.now(), monotonicNow: () => performance.now() };
const METHODS = ['inspect', 'search', 'readCards', 'openCard', 'copyLink', 'returnToResults', 'scroll'];
// A single work may be skipped after these settled open failures, once the results page is proven again.
const RECOVERABLE_OPEN_FAILURES = new Set(['detail_ui_not_ready', 'detail_identity_unverified', 'card_open_failed']);
// Isolated bad cards are skipped without limit (the keyword time cap still applies); only this many
// abnormal cards in a row stop the keyword, because that pattern means the page itself is not usable.
export const MAX_CONSECUTIVE_SKIPS = 4;
const CONTROL_CODES = new Set(['user_stop', 'operator_takeover', 'remote_stop', 'lease_expired', 'usb_disconnected', 'aborted']);
const DETAIL_KEYS = ['cause', 'recovery', 'attempts', 'elapsedMs', 'budgetMs', 'observed', 'activity', 'stage', 'backPresses',
  'skippedCards', 'skipLimitReached', 'previousAttemptId', 'previousAssignmentRevision', 'previousStatus', 'previousReason',
  'w3cError', 'launched', 'focus', 'wakefulness', 'expandOutcome', 'operation', 'consecutiveSkips'];

/** Bounded, PII-free diagnostics carried into the completion checkpoint. */
export function faultDetails(error) {
  const source = { ...(error?.details && typeof error.details === 'object' ? error.details : {}), ...(error ?? {}) };
  const picked = {};
  for (const key of DETAIL_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    picked[key] = typeof value === 'string' ? value.slice(0, 120) : typeof value === 'number' ? Math.round(value)
      : typeof value === 'boolean' ? value : typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : String(value).slice(0, 120);
  }
  return picked;
}

function validateTask(task, permit, device) {
  requireEvidence(task?.identity && typeof task.keyword === 'string' && task.keyword.trim().length > 0, 'invalid_task');
  requireEvidence(typeof task.deviceId === 'string' && task.deviceId.length > 0 && task.filters && typeof task.filters === 'object', 'invalid_task');
  for (const field of ['taskId', 'itemId', 'attemptId', 'requestHash', 'agentId', 'discoveryRunId']) {
    requireEvidence(typeof task.identity[field] === 'string' && task.identity[field].length > 0, 'invalid_task_identity');
    requireEvidence(permit.identity[field] === task.identity[field], 'permit_identity_mismatch');
  }
  requireEvidence(Number.isSafeInteger(task.identity.assignmentRevision) && task.identity.assignmentRevision >= 1
    && task.identity.assignmentRevision === permit.identity.assignmentRevision, 'invalid_task_identity');
  requireEvidence(task.identity.discoveryRunId === task.identity.taskId, 'invalid_discovery_run');
  for (const method of METHODS) requireEvidence(typeof device[method] === 'function', 'invalid_device_adapter');
}

function outcome(error) {
  if (error.code === 'budget_exhausted') return { status: 'completed_with_warnings', reason: error.details.reason };
  if (['user_stop', 'operator_takeover', 'remote_stop'].includes(error.code)) return { status: 'canceled', reason: error.code };
  if (['lease_expired', 'usb_disconnected'].includes(error.code)) return { status: 'interrupted', reason: error.code };
  return { status: 'needs_action', reason: error.code ?? 'device_failure' };
}

export async function runDiscoveryTask({ task, store, device, permit, clock = DEFAULT_CLOCK, resumeAuthorized = false,
  deviceClosureVerified = null, actionTimeoutMs = 10_000 }) {
  let ledger;
  let gate;
  let result;
  let failure = null;
  let lastEventId = null;
  // Local-only note (see diagnostics.mjs); card titles in it never reach the uploaded completion.
  const note = (event, error = null, extra = {}) => recordDiagnostic(store, { at: new Date(clock.wallNow()).toISOString(), event,
    runId: task?.identity?.discoveryRunId ?? null, itemId: task?.identity?.itemId ?? null, keyword: task?.keyword ?? null,
    code: error?.code ?? null, operation: error?.operation ?? null, details: error ? faultDetails(error) : null,
    diagnostic: error?.diagnostic ?? null, ...extra });
  try {
    validateTask(task, permit, device);
    permit.assertAllowed();
    const journal = new DeviceClosureJournal({ store, task, clock, deviceClosureVerified });
    ledger = new BudgetLedger({ task, store, clock, resumeAuthorized });
    gate = new OperationGate({ permit, beforeAction: () => ledger.assertAllowed(), journal, timeoutMs: actionTimeoutMs });
    const call = (method, params = {}) => gate.run((signal, { budgetMs }) => device[method]({ ...params, signal, actionBudgetMs: budgetMs }), method);
    const read = async (method, params) => {
      try { return await call(method, params); }
      catch (error) {
        if (error.code !== 'loading_failed' || error.safeToRetry !== true) throw error;
        return call(method, params);
      }
    };
    // Skip one work only after the adapter proves the same results page, keyword and filters again;
    // an unproven return keeps the original precise reason and the device closure protection.
    let consecutiveSkips = 0;
    const skipAfterSafeReturn = async (error, contextId) => {
      if (!RECOVERABLE_OPEN_FAILURES.has(error.code) || error.deviceSettled !== true || typeof device.recoverResults !== 'function') throw error;
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        note('card_failed', error, { consecutiveSkips, skipLimitReached: true });
        throw new RunnerFault(error.code, error.message, { ...faultDetails(error), skippedCards: ledger.skippedCards,
          consecutiveSkips: consecutiveSkips + 1, skipLimitReached: true });
      }
      try {
        verifyContext(await call('recoverResults', { contextId, keyword: task.keyword, filters: task.filters }), task, contextId);
      } catch (recoveryError) {
        note('card_failed', error, { recovery: recoveryError.code ?? null });
        if (CONTROL_CODES.has(recoveryError.code)) throw recoveryError;
        throw new RunnerFault(error.code, `${error.message}; safe return failed (${recoveryError.code})`,
          { ...faultDetails(error), recovery: recoveryError.code });
      }
      ledger.noteSkippedCard();
      consecutiveSkips++;
      note('card_skipped', error, { consecutiveSkips });
    };
    const deviceState = await call('inspect');
    requireEvidence(deviceState?.deviceId === task.deviceId, 'device_identity_mismatch');
    requireEvidence(deviceState.connected === true, 'usb_disconnected');
    if (deviceState.readyForSearch === false) throw new RunnerFault(deviceState.reason ?? 'device_not_ready');
    requireEvidence(deviceState.unlocked === true, 'device_locked');
    requireEvidence(deviceState.loggedIn === true, 'login_required');
    requireEvidence(deviceState.challenge === false, 'challenge_or_unknown');
    const context = await read('search', { keyword: task.keyword, filters: task.filters });
    const contextId = verifyContext(context, task);
    const seenCards = new Set();
    let emptyPages = 0;
    while (true) {
      const page = await read('readCards', { contextId });
      requireEvidence(page?.contextVerified === true && page.contextId === contextId && Array.isArray(page.cards), 'search_context_unverified');
      let newCards = 0;
      for (const card of page.cards) {
        requireEvidence(typeof card.cardId === 'string' && card.cardId.length > 0, 'card_identity_unverified');
        if (seenCards.has(card.cardId)) continue;
        seenCards.add(card.cardId);
        newCards++;
        ledger.beforeCard();
        let detail;
        try { detail = await call('openCard', { card, contextId }); }
        catch (error) { await skipAfterSafeReturn(error, contextId); continue; }
        requireEvidence(detail?.identityVerified === true && detail.cardId === card.cardId
          && typeof detail.detailId === 'string' && detail.detailId.length > 0, 'detail_identity_unverified');
        let link;
        try {
          link = await call('copyLink', { detail, marker: `starvoice-discovery:${randomUUID()}` });
          verifyLink(link, detail);
        } catch (error) {
          if (['clipboard_not_fresh', 'link_identity_unverified', 'link_identity_mismatch', 'link_unverified'].includes(error.code)) {
            const event = discoveryEvent({ task, card, detail, link, context, clock, error });
            if (!store.getEvent(event.eventId)) store.recordEvent(event);
            lastEventId = event.eventId;
          }
          throw error;
        }
        const workKey = discoveredWorkKey(link, detail);
        const eventId = eventIdFor(task, detail, workKey);
        if (!store.getEvent(eventId)) store.recordEvent(discoveryEvent({ task, card, detail, link, context, clock }));
        lastEventId = eventId;
        verifyContext(await call('returnToResults', { contextId, keyword: task.keyword, filters: task.filters }), task, contextId);
        ledger.noteLink(workKey);
        consecutiveSkips = 0;
      }
      if (page.end === true) { result = { status: 'completed', reason: 'results_end' }; break; }
      emptyPages = newCards ? 0 : emptyPages + 1;
      if (emptyPages >= 2) { result = { status: 'completed_with_warnings', reason: 'no_new_cards' }; break; }
      ledger.beforeSwipe();
      const scrolled = await call('scroll', { contextId });
      requireEvidence(scrolled?.contextVerified === true && scrolled.contextId === contextId, 'search_context_changed');
    }
  } catch (error) {
    failure = error;
    result = { ...outcome(error), message: error.message, details: faultDetails(error) };
  }
  if (ledger) {
    try { ledger.finish(result.status, result.reason); }
    catch (error) { failure = error; result = { ...outcome(error), message: error.message, details: faultDetails(error) }; }
  }
  note('task_finished', failure, { status: result.status, reason: result.reason, stats: ledger?.summary() ?? null });
  const deviceClosure = task?.deviceId ? readDeviceClosure(store, task.deviceId) : null;
  const deviceIdle = !deviceClosure?.required && (gate ? gate.deviceIdle && result.reason !== 'usb_disconnected' : true);
  return { ...result, stats: ledger?.summary() ?? null, lastEventId, deviceIdle,
    stopConfirmationRequired: !deviceIdle, deviceClosure, pendingEvents: store.pendingCount() };
}
