import {createAndroidDeviceAdapter} from '../device/adapter.mjs';
import {createAdbClient} from '../device/adb.mjs';
import {settleDevice} from './settle-device.mjs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {RunnerStore} from '../storage/runner-store.mjs';
import {ExecutionPermit} from '../core/execution-permit.mjs';
import {runDiscoveryTask} from '../core/discovery-runner.mjs';
import {readDeviceClosure} from '../core/device-closure.mjs';
import {acquireDeviceLock, inspectDeviceLock} from '../core/device-lock.mjs';
import {createCloudClient} from '../cloud/client.mjs';
import {createControlClient} from '../cloud/control-client.mjs';
import {deliverPendingBatch} from '../cloud/delivery.mjs';
import {createSimulationDevice} from './simulation.mjs';
import {assertSimulationOrigin, fixedLockRoot, readConfig, setCheckpoint, stateValue} from './state.mjs';

const clock = {wallNow: Date.now, monotonicNow: () => performance.now()};
// Results with these reasons mean the phone itself is not ready; the runner stops advertising readiness at once.
const DEVICE_READINESS_REASONS = new Set(['douyin_not_foreground', 'device_locked', 'device_asleep', 'login_required',
  'login_or_challenge_required', 'login_state_unverified', 'challenge_or_unknown', 'profile_version_mismatch', 'system_overlay_blocked']);
/** The retained proof is handed to a task only for the closure it actually names; older proofs never travel. */
export function closureProofFor(store, deviceId) {
  const pending = readDeviceClosure(store, deviceId);
  const proof = stateValue(store, 'daemon:closure-proof');
  return pending?.required && proof?.deviceId === deviceId && proof.operationId === pending.operationId ? proof : null;
}
export const delay = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, {once: true});
});

export class AndroidDaemon {
  constructor({stateDir, config = readConfig(stateDir), store, control, delivery, device,
    lockRoot = fixedLockRoot(), pollMs = 5000, renewMs = 30000, deliveryMs = 5000, watchMs = 200,
    actionTimeoutMs = 10000} = {}) {
    if (config.simulation) assertSimulationOrigin(config.baseUrl);
    this.config = config;
    this.store = store ?? new RunnerStore(join(stateDir, 'runner.sqlite'));
    this.ownsStore = !store;
    this.control = control ?? createControlClient({baseUrl: config.baseUrl, agentToken: config.agentToken});
    this.delivery = delivery ?? createCloudClient({baseUrl: config.baseUrl, agentToken: config.agentToken});
    this.device = device ?? (config.simulation ? createSimulationDevice(config.deviceId) : config.deviceProfile
      ? createAndroidDeviceAdapter({serial:config.deviceId,profileId:config.deviceProfile,appiumUrl:config.appiumUrl,
        adb:createAdbClient({adbPath:config.adbPath}),onState:value=>setCheckpoint(this.store,'daemon:device-session',value)}) : null);
    this.ready = config.simulation === true && !!this.device;
    this.deviceProbe = null;
    Object.assign(this, {lockRoot, pollMs, renewMs, deliveryMs, watchMs, actionTimeoutMs});
    this.sessionId = randomUUID();
    this.shutdown = new AbortController();
    this.active = null;
    this.taskPromise = null;
    this.nextRenewAt = 0;
    this.blocked = null;
    this.startedAt = Date.now();
    this.nextControlAt = 0;
    this.controlFailures = 0;
  }
  status(extra = {}) {
    const value = {running: !this.shutdown.signal.aborted, pid: process.pid, sessionId: this.sessionId,
      deviceId: this.config.deviceId, readyForSearch: this.ready, reason: this.blocked ?? (this.ready ? null : this.deviceReason ?? 'profile_required'),
      activeIdentity: this.active?.task.identity ?? null, pendingEvents: this.store.pendingCount(),
      completionPending: !!stateValue(this.store, 'daemon:completion'),
      deviceClosureRequired: !!readDeviceClosure(this.store, this.config.deviceId)?.required,
      deviceProbe: this.deviceProbe, updatedAt: new Date().toISOString(), ...extra};
    setCheckpoint(this.store, 'daemon:status', value);
    return value;
  }
  requestStop(reason = 'user_stop') {
    if (this.finished) return;
    const pending = stateValue(this.store, 'daemon:completion');
    if (this.lockOwned && pending?.status === 'completed' && this.store.pendingForAttempt(pending.identity.attemptId)) {
      setCheckpoint(this.store, 'daemon:completion', {...pending, requestId: randomUUID(),
        status: 'canceled', reason});
    }
    this.active?.permit.stop(reason);
    this.shutdown.abort();
  }
  recoverInterruptedProcess() {
    const active = stateValue(this.store, 'daemon:active');
    if (!active || stateValue(this.store, 'daemon:completion')) return;
    // Never renew or retarget the old attempt after a process restart.
    this.saveCompletion(active, {status: 'interrupted', reason: 'process_restarted',
      deviceIdle: !readDeviceClosure(this.store, this.config.deviceId)?.required});
  }
  saveCompletion(active, result) {
    const status = result.status === 'completed_with_warnings' ? 'completed' : result.status;
    const body = {requestId: randomUUID(), identity: active.task.identity, sessionId: active.sessionId,
      status, reason: result.reason, deviceIdle: result.deviceIdle === true,
      checkpoint: {stats: result.stats ?? null, lastEventId: result.lastEventId ?? null,
        originalStatus: result.status, pendingEvents: this.store.pendingCount(),
        ...(result.details && Object.keys(result.details).length ? {failure: result.details} : {})}};
    setCheckpoint(this.store, 'daemon:completion', body); // Persist before touching the network.
    setCheckpoint(this.store, 'daemon:last-task', active);
    setCheckpoint(this.store, 'daemon:active', null);
    if (!body.deviceIdle) this.blocked = 'device_closure_required';
  }
  async flushCompletion({signal} = {}) {
    const completion = stateValue(this.store, 'daemon:completion');
    if (!completion) return true;
    if (completion.status === 'completed' && this.store.pendingForAttempt(completion.identity.attemptId)) return false;
    const result = await this.control.complete(completion, {signal});
    if (result.accepted !== true || typeof result.deviceHeld !== 'boolean') throw new Error('invalid_completion_receipt');
    setCheckpoint(this.store, 'daemon:last-completion', {request: completion, receipt: result});
    setCheckpoint(this.store, 'daemon:completion', null);
    if (result.deviceHeld) this.blocked = 'device_closure_required';
    else if (this.blocked === 'completion_pending') this.blocked = null;
    return !result.deviceHeld;
  }
  launch(task, lease, requestStartedAt) {
    if (!this.ready || this.active || this.taskPromise || this.blocked) return;
    if (task?.deviceId !== this.config.deviceId || task.identity?.agentId !== this.config.agentId
      || !Number.isFinite(Date.parse(task.deadlineAt))) {
      throw new Error('assigned_device_mismatch');
    }
    const permit = new ExecutionPermit({identity: task.identity});
    permit.grant(lease, {requestStartedAt});
    const active = {task, sessionId: this.sessionId, leaseId: lease.leaseId};
    setCheckpoint(this.store, 'daemon:active', active);
    this.active = {...active, permit, leaseId: lease.leaseId};
    this.nextRenewAt = Date.now() + this.renewMs;
    this.taskPromise = runDiscoveryTask({task, store: this.store, device: this.device, permit, clock,
      actionTimeoutMs: this.actionTimeoutMs, resumeAuthorized: task.resumeAuthorized === true,
      deviceClosureVerified: closureProofFor(this.store, this.config.deviceId)})
      .then(result => settleDevice({device:this.device,store:this.store,task,result,clock}))
      .then(result => {
        if (result.status.startsWith('completed')) {
          try { permit.assertAllowed(); }
          catch (error) { result = {...result, reason:error.code ?? 'lease_expired',
            status:['user_stop','remote_stop'].includes(error.code) ? 'canceled' : 'interrupted'}; }
        }
        if (this.device?.probe && DEVICE_READINESS_REASONS.has(result.reason)) { this.ready = false; this.deviceReason = result.reason; }
        // Plain summary for the one-click window; keyword and counts only.
        this.lastOutcome = {keyword: task.keyword, status: result.status, reason: result.reason ?? null,
          links: result.stats?.links ?? 0, skipped: result.stats?.skippedCards ?? 0,
          elapsedMs: result.stats?.keywordElapsedMs ?? null, at: Date.now()};
        this.saveCompletion({...active, leaseId: this.active?.leaseId ?? active.leaseId}, result);
        return result;
      })
      .finally(() => { this.active = null; this.taskPromise = null; });
  }
  applyControl(control) {
    if (control?.blocked) {
      this.blocked = control.reason ?? 'server_device_held';
      this.active?.permit.stop(control.stopRequested || control.reason === 'remote_stop' ? 'remote_stop' : 'lease_expired');
    }
    if (control?.stopRequested) this.active?.permit.stop('remote_stop');
  }
  async probeDevice() {
    // Every idle poll re-reads the phone; an earlier readyForSearch=true never claims another task.
    const state = await this.device.probe({signal: this.shutdown.signal});
    this.ready = state.readyForSearch === true;
    this.deviceReason = state.reason ?? null;
    this.deviceProbe = {readyForSearch: this.ready, reason: this.deviceReason, checkedAt: new Date().toISOString(),
      ...(state.foreground ? {foreground: state.foreground} : {}), ...(state.focus !== undefined ? {focus: state.focus} : {})};
  }
  /** A bounded, PII-free probe summary for the poll body: only the foreground identity and when it was read. */
  pollProbe() {
    const probe = this.deviceProbe;
    if (!probe) return null;
    const bound = value => typeof value === 'string' ? value.slice(0, 120) : null;
    const summary = {checkedAt: bound(probe.checkedAt)};
    if (probe.foreground) summary.foreground = {package: bound(probe.foreground.package),
      activity: bound(probe.foreground.activity), launched: probe.foreground.launched === true};
    return summary;
  }
  async tick() {
    if (Date.now() < this.nextControlAt) return;
    if (stateValue(this.store, 'daemon:completion')) {
      const pending = stateValue(this.store, 'daemon:completion');
      if (pending.status === 'completed' && this.store.pendingForAttempt(pending.identity.attemptId)) {
        const previous = stateValue(this.store, 'daemon:last-task');
        if (Date.now() >= Date.parse(previous.task.deadlineAt)) {
          setCheckpoint(this.store, 'daemon:completion', {...pending, requestId: randomUUID(),
            status: 'interrupted', reason: 'upload_deadline_expired'});
        } else if (Date.now() >= this.nextRenewAt) {
          const renewed = await this.control.renew({identity: pending.identity, sessionId: pending.sessionId,
            leaseId: previous.leaseId}, {signal: this.shutdown.signal});
          this.applyControl(renewed.control);
          if (!renewed.permit || renewed.control?.stopRequested || renewed.control?.blocked) {
            setCheckpoint(this.store, 'daemon:completion', {...pending, requestId: randomUUID(),
              status: 'interrupted', reason: 'upload_lease_expired'});
          } else setCheckpoint(this.store, 'daemon:last-task', {...previous, leaseId: renewed.permit.leaseId});
          this.nextRenewAt = Date.now() + this.renewMs;
        }
      }
      await this.flushCompletion({signal: this.shutdown.signal});
      return;
    }
    if (this.blocked) return;
    if (!this.active && this.device?.probe) await this.probeDevice();
    let started = performance.now();
    const polled = await this.control.poll({deviceId: this.config.deviceId, sessionId: this.sessionId,
      readyForSearch: this.ready, reason: this.deviceReason ?? null, probe: this.pollProbe()}, {signal: this.shutdown.signal});
    // Only an answered poll ends a failure streak; turns skipped for backoff or a block keep the count and the error.
    this.controlFailures = 0; this.lastControlError = null;
    this.nextControlAt = Date.now() + Math.max(this.pollMs, polled.pollAfterMs ?? 0);
    this.applyControl(polled.control);
    if (this.shutdown.signal.aborted) return;
    if (!this.active && polled.task && !this.blocked) this.launch(polled.task, polled.permit, started);
    const active = this.active;
    if (active && Date.now() >= this.nextRenewAt && !active.permit.signal.aborted) {
      started = performance.now();
      const renewed = await this.control.renew({identity: active.task.identity, sessionId: this.sessionId,
        leaseId: active.leaseId}, {signal: this.shutdown.signal});
      this.applyControl(renewed.control);
      if (this.active === active && !active.permit.signal.aborted) {
        if (renewed.permit) {
          active.permit.grant(renewed.permit, {requestStartedAt: started});
          active.leaseId = renewed.permit.leaseId;
        } else active.permit.stop('lease_expired');
      }
      this.nextRenewAt = Date.now() + this.renewMs;
    }
  }
  async controlLoop() {
    while (!this.shutdown.signal.aborted) {
      try { await this.tick(); }
      catch (error) {
        // A normal local shutdown aborts an in-flight poll. Do not turn that
        // expected cancellation into a persistent control-plane fault.
        if (!this.shutdown.signal.aborted) {
          if (error.retryable === false || [401, 403, 409].includes(error.status)) {
            this.blocked = 'control_requires_attention';
            this.active?.permit.stop('lease_expired');
          }
          this.lastControlError = error.code ?? 'control_unavailable';
          this.controlFailures++;
          // A running task or an undelivered completion stays at the first step so it still reaches the server within the 90 s lease.
          const step = this.active || stateValue(this.store, 'daemon:completion') ? 1 : Math.min(this.controlFailures, 6);
          this.nextControlAt = Date.now() + Math.max(error.retryAfterMs ?? 0, Math.min(60000, this.pollMs * 2 ** step));
        }
      }
      this.status({controlError: this.lastControlError ?? null});
      await delay(this.pollMs, this.shutdown.signal);
    }
  }
  async deliveryLoop() {
    while (!this.shutdown.signal.aborted) {
      const result = await deliverPendingBatch({store: this.store, client: this.delivery,
        retryState: stateValue(this.store, 'network:delivery') ?? {}, signal: this.shutdown.signal});
      setCheckpoint(this.store, 'network:delivery', result.retryState);
      await delay(this.deliveryMs, this.shutdown.signal);
    }
  }
  async watchLoop() {
    while (!this.shutdown.signal.aborted) {
      const request = stateValue(this.store, 'daemon:stop');
      if (request?.requestedAt >= this.startedAt) this.requestStop('user_stop');
      await delay(this.watchMs, this.shutdown.signal);
    }
  }
  async run({signal} = {}) {
    const onAbort = () => this.requestStop('user_stop');
    signal?.addEventListener('abort', onAbort, {once: true});
    let lock;
    let loops = [];
    let began = false;
    try {
      const existing = inspectDeviceLock({lockRoot: this.lockRoot, serial: this.config.deviceId});
      if (existing) {
        let alive = false;
        try { if (existing.owner?.pid) { process.kill(existing.owner.pid, 0); alive = true; } } catch (error) { alive = error.code === 'EPERM'; }
        if (!existing.owner || alive) throw new Error('device_locked');
      }
      began = true;
      this.recoverInterruptedProcess();
      // Lost completion responses can be recovered even while a stale physical lock is held.
      if (stateValue(this.store, 'daemon:completion')) {
        try { await this.flushCompletion({signal}); } catch { this.blocked = 'completion_pending'; }
      }
      lock = acquireDeviceLock({lockRoot: this.lockRoot, serial: this.config.deviceId, ownerId: this.config.clientUuid});
      this.lockOwned = true;
      setCheckpoint(this.store, 'daemon:lock', {token: lock.token, serial: this.config.deviceId, pid: process.pid});
      this.status();
      if (signal?.aborted) onAbort();
      loops = [this.controlLoop(), this.deliveryLoop(), this.watchLoop()];
      await Promise.all(loops);
      await this.taskPromise;
      // Same requestId is replayed on the next start if this response is lost.
      try { await this.flushCompletion(); } catch { this.blocked = 'completion_pending'; }
      return this.status({running: false});
    } finally {
      this.requestStop('user_stop');
      await Promise.allSettled(loops);
      await this.taskPromise;
      if (lock && !readDeviceClosure(this.store, this.config.deviceId)?.required) {
        lock.release();
        setCheckpoint(this.store, 'daemon:lock', null);
      }
      if (began) this.status({running: false});
      signal?.removeEventListener('abort', onAbort);
      this.lockOwned = false;
      this.finished = true;
      if (this.ownsStore) this.store.close();
    }
  }
}
