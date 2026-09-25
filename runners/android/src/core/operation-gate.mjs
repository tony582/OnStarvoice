import { RunnerFault } from './errors.mjs';

// An adapter may mark an error `deviceSettled: true` only when it was raised after the last device
// command returned, so nothing is in flight; such errors complete the closure marker like a normal return.
const settledFailure = error => error?.deviceSettled === true || (error?.code === 'loading_failed' && error.safeToRetry === true);

export class OperationGate {
  constructor({ permit, beforeAction, journal = null, timeoutMs = 10_000 }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new RunnerFault('invalid_action_timeout');
    this.permit = permit;
    this.beforeAction = beforeAction;
    this.journal = journal;
    this.timeoutMs = timeoutMs;
    this.active = false;
    this.uncertain = false;
  }
  get deviceIdle() { return !this.active && !this.uncertain; }
  async run(action, operationName = 'device_action') {
    if (this.active || this.uncertain) throw new RunnerFault('operation_not_settled');
    const tag = (error) => {
      if (error && typeof error === 'object' && error.operation === undefined) { try { error.operation = operationName; } catch { /* frozen */ } }
      return error;
    };
    this.permit.assertAllowed();
    this.beforeAction();
    this.journal?.begin(operationName);
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = (reason) => {
      this.uncertain = true;
      controller.abort(tag(reason));
      rejectAbort(reason);
    };
    const onStop = () => abort(this.permit.signal.reason ?? new RunnerFault('user_stop'));
    this.permit.signal.addEventListener('abort', onStop, { once: true });
    const remaining = this.permit.expiresAt - this.permit.monotonicNow();
    const timeout = Math.min(this.timeoutMs, remaining);
    const timer = setTimeout(() => abort(new RunnerFault(remaining <= this.timeoutMs ? 'lease_expired' : 'device_action_timeout')), timeout);
    this.active = true;
    const operation = Promise.resolve().then(() => {
      this.permit.assertAllowed();
      // The action learns its whole budget so long UI waits can use it instead of a fixed inner limit.
      return action(controller.signal, { budgetMs: timeout });
    }).then((value) => {
      if (!this.uncertain) this.journal?.complete();
      return value;
    }, (error) => {
      if (settledFailure(error) && !this.uncertain) this.journal?.complete();
      else this.uncertain = true;
      throw tag(error);
    }).finally(() => { this.active = false; });
    try { return await Promise.race([operation, aborted]); }
    finally {
      clearTimeout(timer);
      this.permit.signal.removeEventListener('abort', onStop);
    }
  }
}
