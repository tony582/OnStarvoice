import {readDeviceClosure, DeviceClosureJournal} from '../core/device-closure.mjs';
import {inspectDeviceLock, releaseDeviceLock} from '../core/device-lock.mjs';
import {createControlClient} from '../cloud/control-client.mjs';
import {randomUUID} from 'node:crypto';
import {fixedLockRoot, setCheckpoint, stateValue} from './state.mjs';

export function daemonStatus(store) {
  const status = stateValue(store, 'daemon:status');
  let processAlive = false;
  try { if (status?.pid) { process.kill(status.pid, 0); processAlive = true; } } catch {}
  return {...status, processAlive, pendingEvents: store.pendingCount(), quarantinedEvents: store.quarantinedCount(),
    completionPending: !!stateValue(store, 'daemon:completion')};
}
export function requestLocalStop(store) {
  setCheckpoint(store, 'daemon:stop', {requestedAt: Date.now(), requestId: randomUUID()});
  return {ok: true, stopRequested: true, message: 'Stop requested; status must confirm closure.'};
}

export async function confirmDeviceClosure({store, config, evidence, client,
  lockRoot = fixedLockRoot(), isProcessAlive = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  }}) {
  const lock = inspectDeviceLock({lockRoot, serial: config.deviceId});
  if (lock?.owner?.pid && isProcessAlive(lock.owner.pid)) throw new Error('Stop the active runner before closure review');
  const active = stateValue(store, 'daemon:last-task') ?? stateValue(store, 'daemon:active');
  const closure = readDeviceClosure(store, config.deviceId);
  if (!active || (lock && !lock.owner)) throw new Error('Unconfirmed lock requires manual investigation');
  if (closure?.required && ['taskId', 'discoveryRunId', 'itemId', 'attemptId', 'agentId', 'requestHash', 'assignmentRevision']
    .some(key => closure.identity?.[key] !== active.task.identity[key])) {
    throw new Error('Closure task identity differs from the retained device operation');
  }
  const saved = stateValue(store, 'daemon:close');
  if (saved) evidence = saved.evidence;
  const owned = stateValue(store, 'daemon:lock');
  if (lock && owned?.token !== lock.owner.token) throw new Error('Lock ownership mismatch');
  const verifiedAt = Date.parse(evidence?.verifiedAt);
  if (!['operator_takeover', 'independent_stop_check'].includes(evidence?.method)
    || typeof evidence.evidenceId !== 'string' || !evidence.evidenceId.trim()
    || typeof evidence.verifiedBy !== 'string' || !evidence.verifiedBy.trim() || !Number.isFinite(verifiedAt)
    || verifiedAt > Date.now() || verifiedAt < (closure?.startedAt ?? 0)) throw new Error('Closure evidence required');
  const proof = {...evidence, deviceId: config.deviceId, operationId: closure?.operationId};
  const pending = saved ?? {requestId: randomUUID(), identity: active.task.identity, evidence};
  setCheckpoint(store, 'daemon:close', pending);
  const result = await (client ?? createControlClient({baseUrl: config.baseUrl, agentToken: config.agentToken})).close(pending);
  if (result.deviceHeld !== false) throw new Error('Device closure not acknowledged');
  if (closure?.required) new DeviceClosureJournal({store, task: active.task, clock: {wallNow: Date.now}, deviceClosureVerified: proof});
  setCheckpoint(store, 'daemon:closure-proof', proof);
  if (lock) {
    releaseDeviceLock({lockRoot, serial: config.deviceId, token: owned.token});
    setCheckpoint(store, 'daemon:lock', null);
  }
  setCheckpoint(store, 'daemon:close', null);
  return {ok: true, deviceHeld: false};
}
