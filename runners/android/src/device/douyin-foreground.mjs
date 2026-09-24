import {DeviceError, throwIfAborted} from './bounded.mjs';
import {assertProfileDevice, DOUYIN_P0_PROFILE} from './douyin-profile.mjs';
import {pause} from './ui-wait.mjs';

/** The only reviewed launch target. A launch never resets, clears, reinstalls or force-stops the app. */
export const DOUYIN_LAUNCH_COMPONENT = `${DOUYIN_P0_PROFILE.packageName}/.main.MainActivity`;
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
 * Read-only foreground checks before a task is claimed, plus a rate-limited relaunch of Douyin.
 * Unlocking, waking, resetting or clearing the app is never attempted here.
 */
export function createForegroundGuard({adb, serial, launchIntervalMs = 60_000, waitMs = 10_000, pollMs = 1_000,
  now = Date.now, wait = pause}) {
  let lastLaunchAt = -Infinity;
  const readForeground = async options => parseWindowFocus((await adb.windowFocus(serial, options)))
    ?? parseResumedActivity(await adb.resumedActivity(serial, options));
  const isDouyin = foreground => foreground?.package === DOUYIN_P0_PROFILE.packageName;
  return {
    async ensure({signal, launch = true} = {}) {
      const options = {signal};
      throwIfAborted(signal);
      const wakefulness = parseWakefulness(await adb.powerState(serial, options));
      if (wakefulness && wakefulness !== 'Awake') throw new DeviceError('device_asleep', 'The phone screen is off', {wakefulness, deviceSettled: true});
      if (parseKeyguard(await adb.keyguardState(serial, options)) === true) {
        throw new DeviceError('device_locked', 'Unlock the phone to continue', {deviceSettled: true});
      }
      let foreground = await readForeground(options);
      if (isDouyin(foreground)) return {...foreground, launched: false};
      if (!launch || now() - lastLaunchAt < launchIntervalMs) {
        throw new DeviceError('douyin_not_foreground', 'Douyin must be in the foreground', {focus: describe(foreground), launched: false, deviceSettled: true});
      }
      lastLaunchAt = now();
      await adb.launchActivity(serial, DOUYIN_LAUNCH_COMPONENT, options);
      const deadline = now() + waitMs;
      do { await wait(pollMs, signal); foreground = await readForeground(options); }
      while (!isDouyin(foreground) && now() < deadline);
      // A relaunch never skips the profile: version and foreground package are read again afterwards.
      assertProfileDevice({...await adb.inspect(serial, options), ...await adb.inspectApp(serial, options)});
      if (!isDouyin(foreground)) {
        throw new DeviceError('douyin_not_foreground', 'Douyin did not reach the foreground after launch', {focus: describe(foreground), launched: true, deviceSettled: true});
      }
      return {...foreground, launched: true};
    },
  };
}
