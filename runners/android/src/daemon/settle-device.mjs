import {DeviceClosureJournal, readDeviceClosure} from '../core/device-closure.mjs';
import {recordDiagnostic} from '../core/diagnostics.mjs';

const PROTECTED_PARK_REASONS = new Set(['user_stop', 'operator_takeover', 'remote_stop', 'lease_expired',
  'usb_disconnected', 'aborted', 'device_locked', 'device_asleep', 'login_required', 'login_or_challenge_required',
  'login_state_unverified', 'challenge_or_unknown', 'profile_version_mismatch', 'system_overlay_blocked',
  'session_closure_required', 'session_creation_unconfirmed', 'session_identity_missing', 'device_session_busy',
  'douyin_not_foreground']);

async function parkHome(device, result, permit) {
  const skip = reason => ({parked: false, reason});
  if (['canceled', 'interrupted'].includes(result.status) || PROTECTED_PARK_REASONS.has(result.reason)) {
    return skip(result.reason || result.status);
  }
  if (!permit) return skip('permit_unavailable');
  if (typeof device.parkHome !== 'function') return skip('home_park_unsupported');
  try {
    permit.assertAllowed();
    const evidence = await device.parkHome({permit});
    return evidence?.parked === true ? evidence : skip(evidence?.reason || 'home_not_verified');
  } catch (error) {
    return skip(permit.signal.aborted ? permit.signal.reason?.code || 'aborted' : error.code || 'home_park_failed');
  }
}

// Physical closure is verified before the task completion can release its slot.
// A lost Appium create/delete response never authorizes a new device session.
export async function settleDevice({device, store, task, result, clock, permit}) {
  if (typeof device.close !== 'function') return result;
  let pending = readDeviceClosure(store,task.deviceId);
  if (!pending?.required) {
    const journal = new DeviceClosureJournal({store,task,clock});
    journal.begin('close_session');
    pending = journal.value;
  }
  const homePark = await parkHome(device, result, permit);
  result = {...result, homePark};
  try {
    recordDiagnostic(store, {event: 'home_park', runId: task.identity.discoveryRunId,
      itemId: task.identity.itemId, at: new Date(clock.wallNow()).toISOString(), ...homePark});
  } catch { /* Optional diagnostics, including construction, can never prevent physical close. */ }
  try {
    const evidence = await device.close();
    if (evidence.closed !== true) throw new Error('closure_unconfirmed');
    const proof = {deviceId:task.deviceId,operationId:pending.operationId,method:'independent_stop_check',
      verifiedBy:'runner-appium-adb',verifiedAt:evidence.verifiedAt,evidenceId:evidence.evidenceId};
    const journal = new DeviceClosureJournal({store,task,clock,deviceClosureVerified:proof});
    return {...result,deviceIdle:true,stopConfirmationRequired:false,deviceClosure:journal.value};
  } catch {
    return {...result,...(result.status.startsWith('completed') ? {status:'needs_action',reason:'device_closure_required'} : {}),
      deviceIdle:false,stopConfirmationRequired:true,deviceClosure:readDeviceClosure(store,task.deviceId)};
  }
}
