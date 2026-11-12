export class DeviceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new DeviceError('aborted', 'Device operation was canceled');
}

export const bounded = (operation, options) => boundedWithin(operation, options, 15000);
// Startup includes USB initialization; ordinary device operations retain their existing ceiling.
export const boundedStartup = (operation, options) => boundedWithin(operation, options, 30000);

async function boundedWithin(operation, { signal, timeoutMs = 5000 } = {}, maximumMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumMs) {
    throw new DeviceError('invalid_timeout', `Device timeout must be between 1 and ${maximumMs} ms`);
  }
  throwIfAborted(signal);
  const controller = new AbortController();
  let started = false;
  let timer;
  let onAbort;
  const cancellation = new Promise((_, reject) => {
    const cancel = (error) => {
      controller.abort(error);
      reject(error);
    };
    onAbort = () => cancel(new DeviceError('aborted', 'Device operation was canceled',
      { stopConfirmationRequired: started }));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => cancel(new DeviceError('device_timeout',
      'Device operation exceeded its time budget', { stopConfirmationRequired: true })), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      throwIfAborted(controller.signal);
      started = true;
      return operation(controller.signal);
    }), cancellation]);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof DeviceError) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
