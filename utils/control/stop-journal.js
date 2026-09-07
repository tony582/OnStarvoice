// One bounded, versioned control root. It is deliberately separate from legacy
// business status, results, upload receipts and localClosureStopConfirmation.
(function install(root) {
  'use strict';
  const KEY = 'onstarvoice.captureStopControl.v1';
  const VERSION = 1;
  const PHASES = new Set(['active', 'stop_requested', 'draining', 'stopped', 'quarantined']);
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  function valid(value) {
    return value && value.version === VERSION && PHASES.has(value.phase) &&
      Number.isSafeInteger(value.generation) && value.generation > 0 &&
      Number.isSafeInteger(value.operationWatermark) && value.operationWatermark >= 0 &&
      Number.isSafeInteger(value.activityWatermark) && value.activityWatermark >= 0 &&
      ['requestId', 'attemptId', 'ownerDocumentId', 'workerEpoch', 'credentialFingerprint', 'createdAt', 'updatedAt']
        .every(key => typeof value[key] === 'string' && value[key].length > 0) &&
      Array.isArray(value.pages) && value.pages.length <= 64 &&
      Array.isArray(value.operations) && value.operations.length <= 256 &&
      Array.isArray(value.activities) && value.activities.length <= 64;
  }
  function sameScope(left, right) {
    return left && right && ['version', 'requestId', 'attemptId', 'generation', 'ownerDocumentId']
      .every(key => left[key] === right[key]);
  }
  function create({storage, fence, keys, now = Date.now, runReservationOperation}) {
    if (!storage || !fence || !keys) throw new TypeError('stop journal ports required');
    const readKeys = [KEY, keys.auth, keys.request, keys.ledger, keys.archive, keys.lock];
    async function read() {
      const state = await storage.get(readKeys);
      return {journal: state[KEY] ?? null, auth: state[keys.auth] ?? null,
        request: state[keys.request] ?? null, ledger: state[keys.ledger] ?? null,
        archive: state[keys.archive] ?? null, lock: state[keys.lock] ?? null};
    }
    async function transact(change, {bindReservation = false} = {}) {
      // Q remains a leaf. change is synchronous: never wait for a page, resource,
      // another lock/queue, or online authorization while this fence is held.
      const commit = () => fence.run(async () => {
        const state = await read();
        const decision = change(copy(state));
        if (decision?.then) throw new TypeError('journal mutation must be synchronous');
        if (!decision || !Object.hasOwn(decision, 'next')) return decision?.result;
        if (!valid(decision.next)) throw new Error('invalid_stop_journal');
        if (state.journal && !valid(state.journal)) throw new Error('corrupt_stop_journal');
        if (state.journal && !sameScope(state.journal, decision.next)) throw new Error('stop_scope_changed');
        if (state.journal && state.journal.phase !== 'active' && decision.next.phase === 'active') {
          throw new Error('stop_is_monotonic');
        }
        const previous = Date.parse(state.journal?.updatedAt || '');
        const updatedAt = new Date(Math.max(now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
        // The only optional companion write is the exact existing reservation's
        // stable task binding during first admission, never a new lock/owner.
        const patch = {[KEY]: {...decision.next, updatedAt}};
        if (decision.bindLock) {
          if (state.journal || !state.lock || state.lock.captureTaskId || state.lock.captureTaskAttemptId ||
              decision.bindLock.id !== state.lock.id || decision.bindLock.holderId !== state.lock.holderId ||
              decision.bindLock.holderDocumentId !== state.lock.holderDocumentId ||
              decision.bindLock.holderTabId !== state.lock.holderTabId ||
              decision.bindLock.owner !== state.lock.owner ||
              decision.bindLock.captureTaskId !== `unattended-capture:${decision.next.requestId}` ||
              decision.bindLock.captureTaskAttemptId !== decision.next.attemptId) throw new Error('strict_lock_bind_changed');
          patch[keys.lock] = decision.bindLock;
        }
        await storage.set(patch);
        return copy(decision.result);
      }, {strict: true});
      if (bindReservation && typeof runReservationOperation !== 'function') throw new Error('strict_reservation_queue_unavailable');
      // Match legacy release's Auth -> execution-lock order. C is only used to
      // reserve an in-memory idle barrier and is NOT held across this callback.
      return fence.runAuth(() => bindReservation ? runReservationOperation(commit) : commit(), {strict: true});
    }
    async function guard() {
      // Any retained strict generation fences legacy starts/cleanup, including
      // after MV3 restart or reset. Unknown/corrupt evidence fails closed.
      return (await storage.get(KEY))[KEY] != null;
    }
    return Object.freeze({read, transact, guard});
  }
  root.OnStarvoiceStopJournal = Object.freeze({KEY, VERSION, valid, sameScope, create});
})(globalThis);
