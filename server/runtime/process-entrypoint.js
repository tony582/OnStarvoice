import { startRoleProcess } from './process-runtime.js';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function parseShutdownTimeout(env) {
  const raw = env.PROCESS_SHUTDOWN_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!/^[1-9]\d*$/u.test(String(raw))) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/**
 * Install one process entrypoint with fail-fast lock loss and graceful normal
 * signals. A second signal always forces a non-zero exit.
 */
export async function runProcessEntrypoint({
  expectedRole,
  entrypoint,
  env = process.env,
  logger = console,
  processObject = process,
  startProcess = startRoleProcess,
  exitProcess = code => process.exit(code),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const timeoutMs = parseShutdownTimeout(env);
  let runtime = null;
  let shutdownSignal = null;
  let shutdownPromise = null;
  let forceTimer = null;
  let exited = false;

  const exitOnce = code => {
    if (exited) return;
    exited = true;
    if (forceTimer) clearTimer(forceTimer);
    processObject.removeListener?.('SIGINT', onSigint);
    processObject.removeListener?.('SIGTERM', onSigterm);
    exitProcess(code);
  };

  const forceExitLater = () => {
    if (forceTimer) return;
    forceTimer = setTimer(() => {
      logger?.error?.('[ProcessRuntime] graceful shutdown timed out; forcing exit.');
      exitOnce(1);
    }, timeoutMs + 1000);
    forceTimer.unref?.();
  };

  const startRuntimeShutdown = () => {
    if (shutdownPromise || !runtime) return shutdownPromise;

    shutdownPromise = runtime.stop({ reason: shutdownSignal, timeoutMs })
      .then(result => {
        exitOnce(result.drained ? 0 : 1);
        return result;
      })
      .catch(error => {
        logger?.error?.(`[ProcessRuntime] shutdown failed: ${error?.message || error}`);
        exitOnce(1);
        return { drained: false, error };
      });
    return shutdownPromise;
  };

  const requestShutdown = signal => {
    if (shutdownSignal) {
      logger?.error?.(`[ProcessRuntime] received ${signal} during shutdown; forcing exit.`);
      exitOnce(1);
      return shutdownPromise;
    }
    shutdownSignal = signal;
    forceExitLater();
    return startRuntimeShutdown();
  };

  function onSigint() {
    logger?.info?.('[ProcessRuntime] SIGINT received; draining.');
    void requestShutdown('SIGINT');
  }

  function onSigterm() {
    logger?.info?.('[ProcessRuntime] SIGTERM received; draining.');
    void requestShutdown('SIGTERM');
  }

  processObject.on('SIGINT', onSigint);
  processObject.on('SIGTERM', onSigterm);

  try {
    runtime = await startProcess({
      expectedRole,
      entrypoint,
      env,
      logger,
      onLockLost(details) {
        logger?.error?.(
          `[ProcessRuntime] lost ${details.role} execution authority; exiting immediately.`,
        );
        exitOnce(1);
      },
    });
    if (shutdownSignal) void startRuntimeShutdown();
    return runtime;
  } catch (error) {
    logger?.error?.(`Failed to start ${expectedRole} process:`, error);
    exitOnce(1);
    return null;
  }
}
