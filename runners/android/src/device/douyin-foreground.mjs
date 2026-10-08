import {DeviceError, throwIfAborted} from './bounded.mjs';
import {assertProfileDevice, DOUYIN_P0_PROFILE} from './douyin-profile.mjs';
import {pause} from './ui-wait.mjs';
import {MEMORY_RESTART_THRESHOLDS, memoryPressure} from './douyin-memory.mjs';

/**
 * The only reviewed launch target. A launch never resets, clears, reinstalls or force-stops the app. The one
 * force-stop the Runner performs is the memory relief in relieveMemory below, between keywords, followed by this launch.
 * Measured on DE106 / Douyin 40.6.0 (2026-09-25, read-only `cmd package resolve-activity` for MAIN/LAUNCHER):
 * the launcher is .splash.SplashActivity, which also hosts the home feed. .main.MainActivity is not the launcher.
 */
export const DOUYIN_LAUNCH_COMPONENT = `${DOUYIN_P0_PROFILE.packageName}/.splash.SplashActivity`;
const ACTIVITY = /([a-z]\w*(?:\.\w+)+)\/(\.?[\w.$]+)/u;

/** `dumpsys window windows`: the focused window is the authority; a keyguard or system window takes focus away. */
export function parseWindowFocus(dump = '') {
  const focus = /mCurrentFocus=Window\{\S+ u\d+ ([^}]*)\}/u.exec(dump);
  if (focus) {
    const activity = ACTIVITY.exec(focus[1]);
    return activity ? {package: activity[1], activity: activity[2], source: 'window_focus'}
      : {package: null, activity: null, focus: focus[1].trim().slice(0, 80), source: 'window_focus'};
  }
  const app = /mFocusedApp=.*?ActivityRecord\{\S+ u\d+ ([a-z]\w*(?:\.\w+)+)\/(\.?[\w.$]+)/u.exec(dump);
  return app ? {package: app[1], activity: app[2], source: 'focused_app'} : null;
}
/** `dumpsys activity activities`: fallback when the window dump has no focus line. */
export function parseResumedActivity(dump = '') {
  const match = /m(?:Resumed|Focused)Activity: ActivityRecord\{\S+ u\d+ ([a-z]\w*(?:\.\w+)+)\/(\.?[\w.$]+)/u.exec(dump);
  return match ? {package: match[1], activity: match[2], source: 'resumed_activity'} : null;
}
/** `dumpsys window policy`: true/false when a keyguard marker is printed, null when the format is unknown. */
export function parseKeyguard(dump = '') {
  const values = [...dump.matchAll(/(?<![A-Za-z])(?:mShowingLockscreen|isStatusBarKeyguard|mKeyguardShowing|showing)=(true|false)/gu)]
    .map(match => match[1] === 'true');
  return values.length ? values.some(Boolean) : null;
}
/** `dumpsys power`: Awake, Asleep, Dozing or Dreaming; null when not printed. */
export const parseWakefulness = (dump = '') => /mWakefulness=(\w+)/u.exec(dump)?.[1] ?? null;

const describe = foreground => foreground?.package ?? foreground?.focus ?? null;
// Guard errors follow completed read-only commands with no session open, so the phone is settled.

/**
 * Read-only foreground checks before a task is claimed, plus a rate-limited relaunch of Douyin, plus (0.3.1) a
 * rate-limited restart of Douyin when the phone is out of memory. Unlocking, waking, resetting or clearing the app
 * is never attempted here.
 */
export function createForegroundGuard({adb, serial, launchIntervalMs = 60_000, waitMs = 10_000, pollMs = 1_000,
  memoryThresholds = MEMORY_RESTART_THRESHOLDS, restartIntervalMs = 30 * 60_000, now = Date.now, wait = pause}) {
  let lastLaunchAt = -Infinity, launches = 0, lastRestartAt = -Infinity;
  const readForeground = async options => parseWindowFocus((await adb.windowFocus(serial, options)))
    ?? parseResumedActivity(await adb.resumedActivity(serial, options));
  const isDouyin = foreground => foreground?.package === DOUYIN_P0_PROFILE.packageName;
  const assertAwakeAndUnlocked = async options => {
    const wakefulness = parseWakefulness(await adb.powerState(serial, options));
    if (wakefulness && wakefulness !== 'Awake') throw new DeviceError('device_asleep', 'The phone screen is off', {wakefulness, deviceSettled: true});
    if (parseKeyguard(await adb.keyguardState(serial, options)) === true) {
      throw new DeviceError('device_locked', 'Unlock the phone to continue', {deviceSettled: true});
    }
  };
  // The reviewed launch, counted before the start command. Shared by the relaunch in ensure and the memory restart.
  const start = async options => {
    lastLaunchAt = now(); launches++;
    await adb.launchActivity(serial, DOUYIN_LAUNCH_COMPONENT, options);
    const deadline = now() + waitMs;
    let foreground;
    do { await wait(pollMs, options.signal); foreground = await readForeground(options); }
    while (!isDouyin(foreground) && now() < deadline);
    // A relaunch never skips the profile: version and foreground package are read again afterwards.
    assertProfileDevice({...await adb.inspect(serial, options), ...await adb.inspectApp(serial, options)});
    if (!isDouyin(foreground)) {
      throw new DeviceError('douyin_not_foreground', 'Douyin did not reach the foreground after launch', {focus: describe(foreground), launched: true, deviceSettled: true});
    }
    return {...foreground, launched: true};
  };
  return {
    /** Starts of Douyin made through the reviewed launcher by this guard, counted before the start command. */
    get launches() { return launches; },
    /**
     * Wait, read-only, until Douyin holds focus again. Creating an automation session can briefly bring the
     * Appium helper app to the front; reading the screen during that moment is not a Douyin failure.
     */
    async waitFor({signal, waitMs: limit = 8_000} = {}) {
      const deadline = now() + limit;
      let foreground = await readForeground({signal});
      while (!isDouyin(foreground) && now() < deadline) { await wait(pollMs, signal); foreground = await readForeground({signal}); }
      return {douyin: isDouyin(foreground), focus: describe(foreground)};
    },
    async ensure({signal, launch = true} = {}) {
      const options = {signal};
      throwIfAborted(signal);
      await assertAwakeAndUnlocked(options);
      const foreground = await readForeground(options);
      if (isDouyin(foreground)) return {...foreground, launched: false};
      if (!launch || now() - lastLaunchAt < launchIntervalMs) {
        throw new DeviceError('douyin_not_foreground', 'Douyin must be in the foreground', {focus: describe(foreground), launched: false, deviceSettled: true});
      }
      return start(options);
    },
    /**
     * Between keywords only (an idle probe, no session open): read the phone's memory and, under pressure, stop Douyin
     * once and start it again through the reviewed launcher. The restart counts as a launch, so the next keyword
     * proves login on 我 again. At most one restart per restartIntervalMs, so a phone that stays short of memory for
     * another reason is not restarted on every poll; the reading is still reported. An adb client without the reader,
     * or a reading without the fields, never restarts anything.
     */
    async relieveMemory({signal} = {}) {
      const options = {signal};
      throwIfAborted(signal);
      if (typeof adb.memInfo !== 'function') return {reading: null, starved: false, reasons: [], restarted: false};
      const reading = await adb.memInfo(serial, options);
      const {starved, reasons} = memoryPressure(reading, memoryThresholds);
      const result = {reading, starved, reasons, restarted: false};
      if (!starved) return result;
      if (now() - lastRestartAt < restartIntervalMs) return {...result, skipped: 'recently_restarted'};
      await assertAwakeAndUnlocked(options); // Never start Douyin into a locked or sleeping phone.
      lastRestartAt = now();
      await adb.stopDouyin(serial, options);
      const foreground = await start(options);
      return {...result, restarted: true, foreground: {package: foreground.package, activity: foreground.activity}};
    },
  };
}
