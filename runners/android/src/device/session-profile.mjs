import {DOUYIN_P0_PROFILE} from './douyin-profile.mjs';
import {validateSerial} from './adb.mjs';
import {DeviceError} from './bounded.mjs';

export function profileCapabilities(profileId, serial) {
  if (profileId !== DOUYIN_P0_PROFILE.id) throw new DeviceError('profile_required', 'Explicit calibrated profile required');
  validateSerial(serial);
  return {platformName:'Android', 'appium:automationName':'UiAutomator2', 'appium:udid':serial,
    'appium:deviceName':DOUYIN_P0_PROFILE.model, 'appium:noReset':true, 'appium:fullReset':false,
    'appium:autoLaunch':false, 'appium:skipUnlock':true, 'appium:shouldTerminateApp':false,
    'appium:skipLogcatCapture':true, 'appium:mockLocationApp':null, 'appium:newCommandTimeout':300,
    'appium:settings':{wakeLockTimeout:0, waitForIdleTimeout:500, enableMultiWindows:false,
      ignoreUnimportantViews:false, allowInvisibleElements:false, enableTopmostWindowFromActivePackage:false}};
}
