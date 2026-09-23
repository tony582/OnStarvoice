import {createProfileAdapter} from './profile-adapter.mjs';
import { DeviceError, throwIfAborted } from './bounded.mjs';
import { createAdbClient, validateSerial } from './adb.mjs';

/** This adapter bridges the runner to the calibrated-profile boundary.
 * No selector guesses or device actions are shipped before real-device acceptance.
 */
export function createAndroidDeviceAdapter({ serial, adb = createAdbClient(), profileId, appiumUrl, client, onState } = {}) {
  validateSerial(serial);
  if (profileId) return createProfileAdapter({serial,adb,profileId,appiumUrl,client,onState});
  const unavailable = async ({ signal } = {}) => {
    throwIfAborted(signal);
    throw new DeviceError('profile_required', 'Automatic Douyin actions require a validated real-device UI profile');
  };
  return {
    async inspect({ signal } = {}) {
      throwIfAborted(signal);
      try {
        const device = await adb.inspect(serial, { signal });
        return { ...device, deviceId: serial, connected: true, unlocked: null, loggedIn: null,
          challenge: null, readyForSearch: false, reason: 'profile_required' };
      } catch (error) {
        if (error.code === 'aborted') throw error;
        return { deviceId: serial, connected: false, unlocked: null, loggedIn: null,
          challenge: null, readyForSearch: false, reason: error.code || 'device_probe_failed' };
      }
    },
    search: unavailable,
    readCards: unavailable,
    openCard: unavailable,
    copyLink: unavailable,
    returnToResults: unavailable,
    scroll: unavailable,
    readSource: unavailable,
  };
}
