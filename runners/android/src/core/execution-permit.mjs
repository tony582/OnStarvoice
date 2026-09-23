import { RunnerFault } from './errors.mjs';

export class ExecutionPermit {
  constructor({ identity, monotonicNow = () => performance.now() }) {
    this.identity = Object.freeze({ ...identity });
    this.monotonicNow = monotonicNow;
    this.expiresAt = -Infinity;
    this.controller = new AbortController();
    this.stopReason = null;
    this.lastRequestStartedAt = -Infinity;
  }
  get signal() { return this.controller.signal; }
  grant(lease, { requestStartedAt }) {
    if (this.stopReason) throw new RunnerFault('stopped');
    if (!Number.isFinite(requestStartedAt) || requestStartedAt < this.lastRequestStartedAt) throw new RunnerFault('stale_lease');
    const now = this.monotonicNow();
    if (requestStartedAt > now) throw new RunnerFault('invalid_lease_clock');
    for (const key of ['taskId', 'itemId', 'attemptId', 'assignmentRevision']) {
      if (lease[key] !== this.identity[key]) throw new RunnerFault('lease_identity_mismatch');
    }
    const duration = Date.parse(lease.leaseUntil) - Date.parse(lease.serverTime);
    if (!lease.leaseId || !Number.isFinite(duration) || duration <= 0 || duration > 90_000) throw new RunnerFault('invalid_lease');
    const deadline = requestStartedAt + duration;
    if (deadline <= now) throw new RunnerFault('expired_lease_response');
    this.lastRequestStartedAt = requestStartedAt;
    this.expiresAt = deadline;
    return deadline;
  }
  stop(reason = 'user_stop') {
    this.stopReason ??= reason;
    this.controller.abort(new RunnerFault(this.stopReason));
  }
  assertAllowed() {
    if (this.stopReason) throw new RunnerFault(this.stopReason);
    if (this.monotonicNow() >= this.expiresAt) throw new RunnerFault('lease_expired');
  }
}
