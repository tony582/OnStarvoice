// One bounded, versioned control root. It is deliberately separate from legacy
// business status, results, upload receipts and localClosureStopConfirmation.
(function install(root) {
  'use strict';
  const KEY = 'onstarvoice.captureStopControl.v1';
  const VERSION = 1;
  const ORIGIN_KEY = 'onstarvoice.localCaptureOrigin.v1';
  const LAUNCH_KEY = 'onstarvoice.localRecoveryLaunch.v1';
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
    const readKeys = [KEY, keys.auth, keys.request, keys.ledger, keys.archive, keys.lock,
      ORIGIN_KEY, LAUNCH_KEY, ...(keys.plan ? [keys.plan] : [])];
    async function read() {
      const state = await storage.get(readKeys);
      return {journal: state[KEY] ?? null, auth: state[keys.auth] ?? null,
        request: state[keys.request] ?? null, ledger: state[keys.ledger] ?? null,
        archive: state[keys.archive] ?? null, lock: state[keys.lock] ?? null,
        origin: state[ORIGIN_KEY] ?? null, launch: state[LAUNCH_KEY] ?? null,
        plan: keys.plan ? state[keys.plan] ?? null : null};
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
      const state = await storage.get([KEY, LAUNCH_KEY]);
      return state[KEY] != null || state[LAUNCH_KEY] != null;
    }
    // Separate, private local launch transaction; ordinary stop writers retain
    // their original monotonic/same-scope contract above. This is the only
    // permitted generation transition and preserves the complete retired proof.
    async function localTransaction(change, {reservation = false} = {}) {
      if (reservation && typeof runReservationOperation !== 'function') throw new Error('strict_reservation_queue_unavailable');
      const commit = () => fence.run(async () => {
        const state = await read();
        const decision = change(copy(state));
        if (decision?.then) throw new TypeError('local launch mutation must be synchronous');
        if (!decision?.patch) return copy(decision?.result);
        const patch = {};
        const names = {journal: KEY, origin: ORIGIN_KEY, launch: LAUNCH_KEY,
          request: keys.request, ledger: keys.ledger, archive: keys.archive, lock: keys.lock, plan: keys.plan};
        for (const [name, value] of Object.entries(decision.patch)) {
          if (!names[name] || value == null) throw new Error('invalid_local_launch_patch');
          patch[names[name]] = copy(value);
        }
        if (decision.patch.journal) {
          const old = state.journal, next = decision.patch.journal;
          if (!reservation || !valid(old) || !valid(next) || old.originKind !== 'local-v1' ||
              old.generation !== 1 || old.phase !== 'stopped' || old.runnerQuiesced !== true ||
              old.ownerReleased !== true || old.operations.length || old.activities.length ||
              old.pages.some(page => !page.stopped || !page.quiesced) ||
              next.originKind !== 'local-v1' || next.generation !== 2 || next.phase !== 'active' ||
              next.requestId === old.requestId || next.attemptId === old.attemptId ||
              next.retired?.length !== 1 || JSON.stringify(next.retired[0]) !== JSON.stringify(old) ||
              decision.patch.request?.id !== next.requestId || decision.patch.request?.attemptId !== next.attemptId ||
              decision.patch.origin?.request?.requestId !== next.requestId ||
              decision.patch.launch?.phase !== 'claimed' || state.launch?.phase !== 'activated' ||
              decision.patch.lock?.captureTaskId !== `unattended-capture:${next.requestId}` ||
              decision.patch.lock?.captureTaskAttemptId !== next.attemptId ||
              decision.patch.lock?.holderDocumentId !== next.ownerDocumentId) throw new Error('local_handoff_unproven');
        }
        await storage.set(patch);
        return copy(decision.result);
      }, {strict: true});
      return fence.runAuth(() => reservation ? runReservationOperation(commit) : commit(), {strict: true});
    }
    return Object.freeze({read, transact, guard, localTransaction});
  }
  root.OnStarvoiceStopJournal = Object.freeze({KEY, VERSION, ORIGIN_KEY, LAUNCH_KEY, valid, sameScope, create});
})(globalThis);
