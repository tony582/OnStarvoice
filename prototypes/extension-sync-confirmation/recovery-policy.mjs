// UNWIRED DESIGN PROTOTYPE. Not included in the Extension delivery snapshot.
// This describes a consumer requirement; no server or queue calls this module.
// A signal is not proof of identity, receipt durability, or attempt ownership.
import {hasSyncReconciliationSignal} from '../../utils/capture/sync-reconciliation-state.js';

/**
 * State what an eventual recovery adapter must respect for an explicit hold.
 * This does not select a server status, authorize a replay, close a task, or
 * resolve a hold. Missing signals defer judgment; they never permit an action.
 */
export function projectSyncReconciliationRecovery(source = {}) {
  if (hasSyncReconciliationSignal(source)) {
    return {
      decision: 'require_reconciliation',
      automaticReplayBlocked: true,
      terminalSuccessAllowed: false,
    };
  }
  return {decision: 'defer_existing'};
}
