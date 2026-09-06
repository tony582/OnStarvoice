import { evaluateAccessPolicy } from '../domain/access-policy.mjs';
import { ownAccessField, readAccessIdentity, readAccessRequest, snapshotAccessFacts } from '../domain/access-contract.mjs';

const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const unavailable = () => new Error('History read unavailable');
const MAX_GRANT_MS = 30000;

/**
 * Adapt freshly verified facts to U3's read-only grant, pinned to one identity.
 * No authentication, persistence, receipt lookup or command capability lives here.
 */
export function createHistoryReadAuthorizer(options) {
  const identity = readAccessIdentity(ownAccessField(options, 'identity'));
  const readAccessFacts = ownAccessField(options, 'readAccessFacts');
  let now;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(options, 'now');
    now = descriptor === undefined ? Date.now : Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  } catch { now = null; }
  if (!identity || typeof readAccessFacts !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid history authorizer configuration');
  }

  function time() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
    return value;
  }

  return async function authorize(request) {
    try {
      const target = readAccessRequest({
        ...identity,
        scope: ownAccessField(request, 'scope'),
        snapshotId: ownAccessField(request, 'snapshotId'),
        recordNamespace: ownAccessField(request, 'recordNamespace'),
      });
      const signal = ownAccessField(request, 'signal');
      if (!target || signalAborted.call(signal)) throw unavailable();
      // Calling this capability on each U3 check is deliberate: no cached grants.
      const raw = await readAccessFacts(Object.freeze({ ...target, signal }));
      if (signalAborted.call(signal)) throw unavailable();
      const facts = snapshotAccessFacts(raw);
      const checkedAt = time();
      const decision = evaluateAccessPolicy(facts, target, checkedAt);
      if (!decision.history.allowed || !Number.isSafeInteger(checkedAt + MAX_GRANT_MS)) throw unavailable();
      const expiresAt = Math.min(decision.history.expiresAt, checkedAt + MAX_GRANT_MS);
      if (expiresAt <= time() || signalAborted.call(signal)) throw unavailable();
      return Object.freeze({
        allowed: true, scope: target.scope, snapshotId: target.snapshotId,
        recordNamespace: target.recordNamespace, accessRevision: facts.accessRevision, expiresAt,
      });
    } catch { throw unavailable(); }
  };
}
