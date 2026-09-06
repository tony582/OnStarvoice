// UNWIRED protocol-planning prototype. Never call the legacy monitor finish
// endpoint with these decisions. No request or server acknowledgement is made.
import {hasSyncReconciliationSignal} from '../../utils/capture/sync-reconciliation-state.js';

function blockedPlan(decision) {
  return {
    decision,
    legacyFinishAllowed: false,
    automaticReplayBlocked: true,
    terminalSuccessAllowed: false,
  };
}

/**
 * Describe the next protocol requirement without authorizing any action.
 * Capability advertisement is not a committed server hold. Caller-supplied
 * receipt/ack fields are not evidence and are deliberately not inspected.
 * The upstream scope-aware adapter must retain its denial across later events;
 * this stateless planner cannot validate identity or release a durable hold.
 */
export function planMonitorFinish(input = {}) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return blockedPlan('require_protocol_support');
    }
    const hasHold = hasSyncReconciliationSignal(input.signal) ||
      input.holdDecision?.automaticReplayBlocked === true;
    if (!hasHold) return {decision: 'defer_existing'};

    return blockedPlan(input.capabilities?.reconciliationProtocolVersion === 1
      ? 'require_server_hold'
      : 'require_protocol_support');
  } catch {
    // Malformed accessors must not escape into a caller's generic legacy
    // fallback. A broken planning input can only produce a blocking decision.
    return blockedPlan('require_protocol_support');
  }
}
