import { exactReadIdentity } from './read-identity.mjs';
import { readScope } from './read-contract.mjs';

const UNREADABLE = Symbol('unreadable');
const FACT_FIELDS = [
  'principalId', 'sessionId', 'snapshotId', 'recordNamespace', 'accessRevision',
  'identityStatus', 'tenantStatus', 'membershipStatus', 'deviceStatus',
  'licenseStatus', 'licenseExpiresAt', 'sessionExpiresAt', 'evidenceExpiresAt',
  'historyReadAllowed', 'captureAllowed',
];

export function ownAccessField(value, key) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return UNREADABLE;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : UNREADABLE;
  } catch { return UNREADABLE; }
}

export function readAccessIdentity(value) {
  const principalId = exactReadIdentity(ownAccessField(value, 'principalId'));
  const sessionId = exactReadIdentity(ownAccessField(value, 'sessionId'));
  return principalId && sessionId ? Object.freeze({ principalId, sessionId }) : null;
}

export function readAccessRequest(value) {
  const identity = readAccessIdentity(value);
  const scope = readScope(ownAccessField(value, 'scope'));
  const snapshotId = exactReadIdentity(ownAccessField(value, 'snapshotId'));
  const recordNamespace = ownAccessField(value, 'recordNamespace');
  if (!identity || !scope || !snapshotId || !['client_record', 'server_record'].includes(recordNamespace)) return null;
  return Object.freeze({ ...identity, scope, snapshotId, recordNamespace });
}

// Detach only a bounded whitelist of primitive facts and an exact scope. This
// projection is not authentication: the provider must establish these facts.
export function snapshotAccessFacts(value) {
  const result = {};
  for (const field of FACT_FIELDS) {
    const entry = ownAccessField(value, field);
    result[field] = ['string', 'number', 'boolean'].includes(typeof entry) ? entry : UNREADABLE;
  }
  result.scope = readScope(ownAccessField(value, 'scope'));
  return Object.freeze(result);
}
