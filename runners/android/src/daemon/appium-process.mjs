import {spawn} from 'node:child_process';
import {createAppiumClient} from '../device/appium.mjs';

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 1_000;
const KILL_GRACE_MS = 10_000;

/** Resolve after ms, or immediately once the (optional) signal aborts. */
export const wait = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
  function onAbort() { clearTimeout(timer); resolve(); }
  signal?.addEventListener?.('abort', onAbort, {once: true});
});

export async function appiumReady({client, signal}) {
  try { return (await client.status({signal}))?.ready === true; } catch { return false; }
}

/**
 * Ensure a local Appium answers /status. When it does not, spawn node directly from the recorded launch
 * descriptor (execFile-style, shell:false — the run-appium.sh is never executed) and wait, bounded, for
 * readiness. Returns the child handle when one was started so the caller can stop it later.
 */
export async function ensureAppium({appiumUrl, launch, client = createAppiumClient({appiumUrl}),
  spawnImpl = spawn, sleep = wait, now = Date.now, timeoutMs = READY_TIMEOUT_MS, pollMs = READY_POLL_MS, onLog, signal} = {}) {
  if (await appiumReady({client, signal})) return {started: false, child: null};
  if (!launch) throw new Error('Appium is not running and no launch descriptor is configured');
  // A bare "node" in the descriptor is resolved to the node currently running the runner.
  const node = /[\\/]/u.test(launch.node) ? launch.node : process.execPath;
  const child = spawnImpl(node, [launch.entry, ...launch.args], {
    env: {...process.env, ...launch.env}, stdio: 'ignore', shell: false, windowsHide: true, detached: false,
  });
  child.once?.('error', () => {}); // A spawn failure surfaces as the readiness timeout below.
  const deadline = now() + timeoutMs;
  while (now() < deadline && !signal?.aborted) {
    await sleep(pollMs, signal);
    if (await appiumReady({client, signal})) { onLog?.('appium_ready'); return {started: true, child}; }
  }
  await stopAppium(child, {sleep});
  throw new Error('Appium did not become ready in time');
}

/** Terminate a spawned Appium child: SIGTERM, then SIGKILL after a grace period. No-op when nothing was started. */
export async function stopAppium(child, {graceMs = KILL_GRACE_MS, sleep = wait} = {}) {
  if (!child || child.killed || child.exitCode !== null && child.exitCode !== undefined) return;
  const exited = new Promise(resolve => child.once?.('exit', resolve));
  try { child.kill('SIGTERM'); } catch { return; }
  await Promise.race([exited, sleep(graceMs)]);
  if ((child.exitCode === null || child.exitCode === undefined) && !child.killed) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}
