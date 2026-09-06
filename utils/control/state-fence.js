/* Shared final-write fence. This is cooperative Extension locking, not a
 * chrome.storage transaction. Never acquire another queue/lock, perform a
 * network request, or invoke a public writer from inside run(). */
(function installControlStateFence(root) {
  'use strict';
  const AUTH_LOCK = 'onstarvoice:auth-state';
  const CONTROL_LOCK = 'onstarvoice:control-state-v1';

  function sourcePredatesClear(source, ledger) {
    const clearedAt = Date.parse(ledger?.clearedAt || '');
    if (!Number.isFinite(clearedAt)) return false;
    const createdAt = Date.parse(source?.createdAt || '');
    return !Number.isFinite(createdAt) || createdAt <= clearedAt;
  }

  function sameRequestVersion(current, expected) {
    if (!current || !expected) return current == null && expected == null;
    return ['id', 'attemptId', 'updatedAt', 'cloudAgentScopeId'].every(
      key => current[key] === expected[key],
    );
  }

  // Compatibility writers consume the existing reader's legacy Attempt alias.
  // Never use this comparison for new strict authority or infer a real UUID.
  function sameLegacyRequestVersion(current, expected) {
    if (!current || !expected) return current == null && expected == null;
    return sameRequestVersion({ ...current,
      attemptId: String(current.attemptId || `legacy-${current.id}`),
    }, { ...expected,
      attemptId: String(expected.attemptId || `legacy-${expected.id}`),
    });
  }

  function sourceChanged() {
    const error = new Error('Control source changed before final write');
    error.code = 'CONTROL_SOURCE_CHANGED';
    return error;
  }

  function createControlStateFence({getLocks = () => root.navigator?.locks} = {}) {
    function available() {
      return typeof getLocks()?.request === 'function';
    }
    function locked(name, operation, {strict = false} = {}) {
      if (typeof operation !== 'function') throw new TypeError('operation required');
      const locks = getLocks();
      if (typeof locks?.request === 'function') {
        return locks.request(name, {mode: 'exclusive'}, operation);
      }
      // Only pre-existing compatibility operations can work without Web Locks.
      // The new command checks available() before reads/network and at commit.
      if (strict) {
        const error = new Error('Shared control-state locking unavailable');
        error.code = 'strict_shared_lock_unavailable';
        return Promise.reject(error);
      }
      return Promise.resolve().then(operation);
    }
    return Object.freeze({
      available,
      run: (operation, options) => locked(CONTROL_LOCK, operation, options),
      runAuth: (operation, options) => locked(AUTH_LOCK, operation, options),
    });
  }

  const instance = createControlStateFence();
  async function writeRequestDelta(storage, key, expected, next) {
    return instance.run(async () => {
      const stored = await storage.get(key);
      const current = stored[key];
      if (!sameLegacyRequestVersion(current, expected)) throw sourceChanged();
      // Apply only the caller's intended delta to the fresh raw root. In
      // particular, a legacy normalized copy must not erase unrelated fields.
      const result = {...current};
      for (const name of new Set([...Object.keys(expected), ...Object.keys(next)])) {
        if (JSON.stringify(expected[name]) === JSON.stringify(next[name])) continue;
        if (Object.hasOwn(next, name)) result[name] = next[name];
        else delete result[name];
      }
      if (current.recoveryDismissedAt) {
        result.recoveryDismissedAt = current.recoveryDismissedAt;
        result.recoveryDismissedMessage = current.recoveryDismissedMessage;
        if (Date.parse(result.updatedAt) < Date.parse(current.updatedAt)) result.updatedAt = current.updatedAt;
      }
      await storage.set({[key]: result});
      return result;
    });
  }
  root.OnStarvoiceControlStateFence = Object.freeze({
    AUTH_LOCK, CONTROL_LOCK, createControlStateFence, sourcePredatesClear,
    sameRequestVersion, sameLegacyRequestVersion, sourceChanged, writeRequestDelta, ...instance,
  });
})(globalThis);
