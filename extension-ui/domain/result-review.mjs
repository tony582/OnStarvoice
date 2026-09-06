import { exactRecordId } from './record-id.mjs';

export const RESULT_FILTERS = Object.freeze(['all', 'attention', 'unverified', 'issues', 'intervention']);

/** Classify captured primitive signals, not current task state or action authority. */
export function reviewResultSignals(id, captureKey, remote, local, reconciliation) {
  const reasons = [];
  let unverified = false;
  let hasIssue = false;
  let interventionReported = false;
  const unknown = reason => { unverified = true; reasons.push(reason); };
  const issue = reason => { hasIssue = true; reasons.push(reason); };

  if (!exactRecordId(id)) unknown('invalid_record_identity');
  switch (captureKey) {
    case 'pending': case 'running': case 'completed': case 'stopped': break;
    case 'partial': issue('capture_partial'); break;
    case 'failed': issue('capture_failed'); break;
    case 'needs_action':
      issue('capture_intervention_reported');
      interventionReported = true;
      break;
    default: unknown('capture_unverified');
  }
  // Evaluate both receipts independently: uncertainty must not hide a known failure.
  for (const [side, value] of [['remote', remote], ['local', local]]) {
    if (value === 'failed') issue(`${side}_failure_reported`);
    else if (value !== 'confirmed' && value !== 'pending') unknown(`${side}_unverified`);
  }
  if (reconciliation === true) issue('reconciliation_required');
  else if (reconciliation !== undefined && reconciliation !== false) unknown('reconciliation_unverified');

  return Object.freeze({ unverified, hasIssue, interventionReported, reasons: Object.freeze(reasons) });
}

function own(value, key) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

/** Match a locally projected display model. Never use this predicate to authorize. */
export function matchesResultFilter(item, filter) {
  switch (filter) {
    case 'all': return true;
    case 'attention': return own(item, 'needsAttention') === true;
    case 'unverified': return own(own(item, 'review'), 'unverified') === true;
    case 'issues': return own(own(item, 'review'), 'hasIssue') === true;
    case 'intervention': return own(own(item, 'review'), 'interventionReported') === true;
    default: return false;
  }
}
