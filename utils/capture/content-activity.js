/** Page-local, non-resettable control cohort. This is not server authorization. */
const COHORT_FIELDS = Object.freeze([
  'requestId', 'attemptId', 'generation', 'ownerDocumentId', 'documentId',
]);

function controlError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 320
    && value.trim() === value;
}

function validCohort(value) {
  return value?.version === 1 && COHORT_FIELDS.every((key) =>
    key === 'generation'
      ? Number.isSafeInteger(value[key]) && value[key] > 0
      : validToken(value[key]));
}

// These ports observe only our own isolated-world witness. They are not an
// authorization channel, and a legacy/unknown observer is never an idle proof.
export function createSearchWitnessActivityPorts({
  getWitness = () => globalThis.window?.__STARVOICE_DOUYIN_SEARCH_WITNESS__,
} = {}) {
  return Object.freeze({
    readPassiveActivity() {
      const witness = getWitness();
      if (!witness) return 0;
      if (witness.lifecycleVersion === 1 && typeof witness.stop === 'function') {
        return witness.retired === true && witness.active === false ? 0 : 1;
      }
      return witness.observer ? 1 : 0;
    },
    stopPassiveActivity() {
      const witness = getWitness();
      if (witness?.lifecycleVersion === 1 && typeof witness.stop === 'function') {
        witness.stop();
      } else {
        // Best effort for an older installation, but do not invent a retired
        // receipt for an observer whose complete lifecycle is unknown.
        witness?.observer?.disconnect?.();
      }
    },
  });
}

export function createContentActivityRegistry({
  createActivationId = () => globalThis.crypto.randomUUID(),
  readPassiveActivity = () => 0,
  stopPassiveActivity = () => {},
} = {}) {
  let scope = null;
  let stopped = false;
  let sequence = 0;
  let currentInvocation = null;
  const activities = new Map();
  const usedOperations = new Set();
  const externalSettlements = new Map();
  const abortController = new AbortController();

  function passiveCount() {
    try {
      const count = readPassiveActivity();
      return Number.isSafeInteger(count) && count >= 0 ? count : 1;
    } catch {return 1;}
  }

  function stopPassive() {
    try {stopPassiveActivity();} catch { /* Failed retirement remains counted. */ }
  }

  const matches = (value, {operation = true} = {}) => validCohort(value)
    && scope && COHORT_FIELDS.every((key) => value[key] === scope[key])
    && value.activationId === scope.activationId
    && (!operation || validToken(value.operationId));

  function inspect() {
    const pending = [...activities.values()];
    const passive = passiveCount();
    return {
      version: 1, strict: Boolean(scope), stopped,
      activeCount: pending.length + passive,
      topLevelCount: pending.filter((item) => !item.child).length,
      childCount: pending.filter((item) => item.child).length + passive,
      passiveCount: passive,
      quiesced: stopped && pending.length === 0 && passive === 0,
      mainWorldCooperative: pending.some((item) => item.kind === 'main-detail')
        || Boolean(scope?.mainWorldCooperative),
      scope: scope ? {...scope} : null,
    };
  }

  function assertIdentity(envelope) {
    if (!matches(envelope)) throw controlError('PAGE_CONTROL_IDENTITY_MISMATCH');
  }

  function assertCanProduce() {
    if (scope && stopped) throw controlError('CAPTURE_CANCELED');
  }

  function register(handler, {kind = 'page-operation', child = false, cancel, invocation} = {}) {
    const id = ++sequence;
    const record = {kind, child, cancel, invocation: invocation || currentInvocation};
    activities.set(id, record);
    let result;
    try {
      result = handler();
    } catch (error) {
      activities.delete(id);
      if (!activities.size) currentInvocation = null;
      throw error;
    }
    const settled = Promise.resolve(result).finally(() => {
      activities.delete(id);
      if (!activities.size) currentInvocation = null;
    });
    // A detached child may reject after the response timeout. Keep it observable
    // without an unhandled rejection; callers still receive the original result.
    void settled.catch(() => {});
    return settled;
  }

  return Object.freeze({
    isStrict: () => Boolean(scope),
    isStopped: () => Boolean(scope && stopped),
    getScope: () => scope ? {...scope} : null,
    getInvocation: () => currentInvocation ? {...currentInvocation} : null,
    getSignal: () => scope ? abortController.signal : null,
    assertCanProduce,
    inspect,
    inspectStrict(envelope) { assertIdentity(envelope); return inspect(); },
    handshake(envelope) {
      if (!validCohort(envelope)) throw controlError('PAGE_CONTROL_INVALID_COHORT');
      if (scope) {
        if (!COHORT_FIELDS.every((key) => envelope[key] === scope[key])) {
          throw controlError('PAGE_CONTROL_COHORT_LOCKED');
        }
        return inspect();
      }
      if (activities.size || passiveCount()) throw controlError('PAGE_CONTROL_PAGE_BUSY');
      const activationId = createActivationId();
      if (!validToken(activationId)) throw controlError('PAGE_CONTROL_ACTIVATION_UNAVAILABLE');
      scope = Object.fromEntries(['version', ...COHORT_FIELDS].map((key) => [key, envelope[key]]));
      scope.activationId = activationId;
      return inspect();
    },
    runLegacy(handler, options) {
      if (scope) throw controlError('PAGE_CONTROL_LEGACY_BLOCKED');
      return register(handler, options);
    },
    run(envelope, handler, options = {}) {
      assertIdentity(envelope);
      assertCanProduce();
      if (activities.size) throw controlError('PAGE_CONTROL_PAGE_BUSY');
      if (usedOperations.has(envelope.operationId)) throw controlError('PAGE_CONTROL_OPERATION_REPLAY');
      // A document is intentionally finite. Do not evict replay fences.
      if (usedOperations.size >= 10000) throw controlError('PAGE_CONTROL_DOCUMENT_EXHAUSTED');
      usedOperations.add(envelope.operationId);
      currentInvocation = {...envelope};
      return register(handler, {...options, invocation: currentInvocation});
    },
    reserve(envelope) {
      assertIdentity(envelope);
      assertCanProduce();
      if (activities.size) throw controlError('PAGE_CONTROL_PAGE_BUSY');
      if (usedOperations.has(envelope.operationId)) throw controlError('PAGE_CONTROL_OPERATION_REPLAY');
      if (usedOperations.size >= 10000) throw controlError('PAGE_CONTROL_DOCUMENT_EXHAUSTED');
      usedOperations.add(envelope.operationId);
      currentInvocation = {...envelope};
      const pending = new Promise((resolve) => externalSettlements.set(envelope.operationId, resolve));
      void register(() => pending, {kind: 'external-script', invocation: currentInvocation});
      return inspect();
    },
    navigate(envelope, dispatch) {
      assertIdentity(envelope);
      assertCanProduce();
      if (activities.size) throw controlError('PAGE_CONTROL_PAGE_BUSY');
      if (usedOperations.has(envelope.operationId)) throw controlError('PAGE_CONTROL_OPERATION_REPLAY');
      if (usedOperations.size >= 10000) throw controlError('PAGE_CONTROL_DOCUMENT_EXHAUSTED');
      if (typeof dispatch !== 'function') throw controlError('PAGE_CONTROL_NAVIGATION_REJECTED');
      usedOperations.add(envelope.operationId);
      // Navigation is a terminal handoff for this Document, not another run.
      // Freeze before dispatch; BFCache and a lost reply must not revive it.
      stopped = true;
      abortController.abort();
      stopPassive();
      const snapshot = inspect();
      if (!snapshot.quiesced) throw controlError('PAGE_CONTROL_PAGE_BUSY');
      dispatch();
      return snapshot;
    },
    async settle(envelope) {
      assertIdentity(envelope);
      const resolve = externalSettlements.get(envelope.operationId);
      if (!resolve) throw controlError('PAGE_CONTROL_EXTERNAL_OPERATION_UNKNOWN');
      // An already granted script can install its observer after stop. Retire
      // that late installation before releasing the real external reservation.
      if (stopped) stopPassive();
      externalSettlements.delete(envelope.operationId);
      resolve();
      await Promise.resolve();
      return inspect();
    },
    trackChild(promise, {kind = 'page-child', cancel, invocation = currentInvocation} = {}) {
      if (scope && (!invocation || !matches(invocation))) {
        throw controlError('PAGE_CONTROL_CHILD_IDENTITY_MISMATCH');
      }
      if (kind === 'main-detail' && scope) scope.mainWorldCooperative = true;
      // Register already-started work even after stop: refusing to count it would
      // manufacture an empty drain. Production admission is a separate check.
      const settled = register(() => promise, {kind, child: true, cancel, invocation});
      if (stopped && typeof cancel === 'function') {
        try { cancel(); } catch { /* Remain counted until the real promise settles. */ }
      }
      return settled;
    },
    cancel(envelope) {
      assertIdentity(envelope);
      stopped = true;
      abortController.abort();
      stopPassive();
      for (const record of activities.values()) {
        try { record.cancel?.(); } catch { /* Failed cancellation is not completion. */ }
      }
      return inspect();
    },
    invalidate() {
      if (!scope) return;
      stopped = true;
      abortController.abort();
      stopPassive();
      for (const record of activities.values()) {
        try { record.cancel?.(); } catch { /* Remain conservatively active. */ }
      }
    },
  });
}

export const pageActivity = createContentActivityRegistry(createSearchWitnessActivityPorts());
