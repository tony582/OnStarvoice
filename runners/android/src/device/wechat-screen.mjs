import {DeviceError, throwIfAborted} from './bounded.mjs';
import {parseWindowFocus, parseResumedActivity, parseKeyguard, parseWakefulness} from './douyin-foreground.mjs';
import {pause} from './ui-wait.mjs';
import {ACTIVITY, OWNER_ACTION_TEXTS, WECHAT_PROFILE} from './wechat-profile.mjs';

// The shared primitives of the WeChat flow: where are we (focused activity), what does the screen say (OCR),
// and the hard stops (owner action needed, chat picker). Text read here is used for locating only.
export function createWechatScreen({adb, screen, ocr, serial, now = () => performance.now()}) {
  const activity = async options => {
    const focus = parseWindowFocus(await adb.windowFocus(serial, options)) ?? parseResumedActivity(await adb.resumedActivity(serial, options));
    if (!focus?.package) return {package: null, activity: null};
    const name = focus.activity?.startsWith('.') ? `${focus.package}${focus.activity}` : focus.activity;
    return {package: focus.package, activity: name};
  };
  const self = {
    activity,
    async assertAwakeAndUnlocked(options) {
      const wakefulness = parseWakefulness(await adb.powerState(serial, options));
      if (wakefulness && wakefulness !== 'Awake') throw new DeviceError('device_asleep', 'The phone screen is off', {deviceSettled: true});
      if (parseKeyguard(await adb.keyguardState(serial, options)) === true) throw new DeviceError('device_locked', 'Unlock the phone to continue', {deviceSettled: true});
    },
    /** Poll the focused activity until it is one of `wanted`; the chat picker is left at once and stops the step. */
    async waitFor(wanted, {signal, timeoutMs = 6000} = {}) {
      const goals = [wanted].flat();
      const deadline = now() + timeoutMs;
      let current;
      while (true) {
        throwIfAborted(signal);
        current = await activity({signal});
        if (current.activity === ACTIVITY.chooseChat) {
          await screen.back({signal});
          throw new DeviceError('unexpected_screen', 'WeChat opened the chat picker; nothing was sent', {deviceSettled: true});
        }
        if (current.package === WECHAT_PROFILE.packageName && goals.includes(current.activity)) return current;
        if (now() >= deadline) {
          throw new DeviceError('screen_unverified', 'WeChat did not reach the expected screen',
            {deviceSettled: true, observed: current.activity ? current.activity.split('.').pop().slice(0, 60) : current.package});
        }
        await pause(300, signal);
      }
    },
    /** Screenshot now; text recognition is started but not awaited (the caller decides when to wait). */
    async capture({signal, roi = null} = {}) {
      const png = await screen.screenshot({signal});
      return {at: Date.now(), text: ocr.recognize(png, {roi, signal})};
    },
    /** Screenshot and wait for its text: for steps that must know where to tap next. */
    async look({signal, roi = null} = {}) {
      const shot = await self.capture({signal, roi});
      const {rows} = await shot.text;
      self.assertNoOwnerAction(rows);
      return rows;
    },
    assertNoOwnerAction(rows) {
      if (rows.some(row => OWNER_ACTION_TEXTS.some(text => row.text.includes(text)))) {
        throw new DeviceError('login_or_challenge_required', 'WeChat asks the phone owner to act', {deviceSettled: true});
      }
    },
  };
  return self;
}
