import { randomUUID } from 'node:crypto';
import { RunnerFault } from './errors.mjs';

export const deviceClosureKey = (deviceId) => `device-closure:${deviceId}`;
export const readDeviceClosure = (store, deviceId) => store.loadCheckpoint(deviceClosureKey(deviceId))?.value ?? null;

export class DeviceClosureJournal {
  constructor({ store, task, clock, deviceClosureVerified = null }) {
    this.store = store;
    this.task = task;
    this.clock = clock;
    this.key = deviceClosureKey(task.deviceId);
    const previous = store.loadCheckpoint(this.key);
    this.revision = previous?.revision ?? 0;
    this.value = previous?.value ?? null;
    if (this.value?.required) {
      const proof = deviceClosureVerified;
      const verifiedAt = Date.parse(proof?.verifiedAt);
      if (!proof || proof.deviceId !== task.deviceId || proof.operationId !== this.value.operationId
        || !['operator_takeover', 'independent_stop_check'].includes(proof.method)
        || typeof proof.evidenceId !== 'string' || !proof.evidenceId.trim()
        || typeof proof.verifiedBy !== 'string' || !proof.verifiedBy.trim()
        || !Number.isFinite(verifiedAt) || verifiedAt < this.value.startedAt || verifiedAt > clock.wallNow()) {
        throw new RunnerFault('device_closure_required', 'Previous device action has no confirmed closure',
          { deviceId: task.deviceId, operationId: this.value.operationId });
      }
      this.value = { ...this.value, required: false, closureProof: proof, closedAt: clock.wallNow() };
      this.save();
    }
  }
  save() { this.revision = this.store.saveCheckpoint(this.key, this.value, this.revision); }
  begin(operation) {
    if (this.value?.required) throw new RunnerFault('device_closure_required');
    this.value = { required: true, deviceId: this.task.deviceId, operationId: randomUUID(), operation,
      startedAt: this.clock.wallNow(), identity: this.task.identity,
      lastClosureProof: this.value?.closureProof ?? this.value?.lastClosureProof ?? null };
    this.save(); // Must commit before any command is handed to the adapter.
  }
  complete() {
    this.value = { ...this.value, required: false, closedAt: this.clock.wallNow() };
    this.save();
  }
}
