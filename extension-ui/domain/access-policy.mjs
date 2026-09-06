import { exactReadIdentity } from './read-identity.mjs';
import { readAccessRequest, snapshotAccessFacts } from './access-contract.mjs';

const timeValue = value => Number.isSafeInteger(value) && value >= 0;
const capability = (allowed, reason, expiresAt = null) => Object.freeze({ allowed, reason, expiresAt });
const denied = capability(false, 'access_unavailable');
const BLOCKED = Object.freeze({ state: 'blocked', history: denied, capture: denied });

/**
 * User-approved product policy over trusted, fresh access facts. An expired
 * business license is not an expired identity or permission to read history.
 * This pure decision neither authenticates callers nor dispatches commands.
 */
export function evaluateAccessPolicy(facts, request, now) {
  const expected = readAccessRequest(request);
  const value = snapshotAccessFacts(facts);
  const actual = readAccessRequest(value);
  if (!expected || !actual || !timeValue(now) || !exactReadIdentity(value.accessRevision)) return BLOCKED;
  if (['principalId', 'sessionId', 'snapshotId', 'recordNamespace'].some(key => actual[key] !== expected[key]) ||
      ['tenantId', 'taskId', 'executionId'].some(key => actual.scope[key] !== expected.scope[key])) return BLOCKED;
  if (['identityStatus', 'tenantStatus', 'membershipStatus', 'deviceStatus'].some(key => value[key] !== 'active')) return BLOCKED;
  if (typeof value.historyReadAllowed !== 'boolean' || typeof value.captureAllowed !== 'boolean' ||
      ![value.licenseExpiresAt, value.sessionExpiresAt, value.evidenceExpiresAt].every(timeValue) ||
      value.sessionExpiresAt <= now || value.evidenceExpiresAt <= now) return BLOCKED;
  if (!['active', 'expired'].includes(value.licenseStatus) ||
      (value.licenseStatus === 'expired' && value.licenseExpiresAt > now)) return BLOCKED;

  const expired = value.licenseExpiresAt <= now;
  // evidenceExpiresAt is the provider's minimum validity horizon across all
  // identity, tenant, membership, device and exact historical-scope evidence.
  const readUntil = Math.min(value.sessionExpiresAt, value.evidenceExpiresAt);
  return Object.freeze({
    state: expired ? 'expired' : 'active',
    history: value.historyReadAllowed ? capability(true, 'allowed', readUntil) : capability(false, 'not_permitted'),
    capture: expired ? capability(false, 'license_expired') : value.captureAllowed
      ? capability(true, 'allowed', Math.min(readUntil, value.licenseExpiresAt))
      : capability(false, 'not_permitted'),
  });
}
