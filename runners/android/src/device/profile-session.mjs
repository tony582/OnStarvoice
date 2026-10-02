import {randomUUID} from 'node:crypto';
import {bounded, DeviceError, throwIfAborted} from './bounded.mjs';
import {selectDevice} from './adb.mjs';
import {assertProfileDevice, DOUYIN_P0_PROFILE} from './douyin-profile.mjs';
import {parseWindowFocus} from './douyin-foreground.mjs';
import {createUiSession} from './ui-session.mjs';
import {verifyLoginAndSearchEntry} from './douyin-readiness.mjs';
import {parkDouyinHome} from './douyin-home.mjs';

// Label the start-up step on any error that has none, so a failed start says where it stopped (PII-free).
async function step(name, operation) {
  try { return await operation(); }
  catch (error) {
    if (error && typeof error === 'object' && error.stage === undefined) { try { error.stage = `inspect:${name}`; } catch { /* frozen */ } }
    throw error;
  }
}

export function createProfileSession({serial, profileId, adb, client, onState = () => {}, feedSettleMs, slowReadMs}) {
  let sessionId = null, creating = false, uncertain = false, ui = null;
  return {
    get ui() { if (!ui) throw new DeviceError('session_required','Device session is not initialized'); return ui; },
    async inspect({signal, afterCreate = null} = {}) {
      const options = {signal};
      const device = await step('device_check', async () => {
        const value = await adb.inspect(serial, options);
        assertProfileDevice({...value, ...await adb.inspectApp(serial,options)});
        return value;
      });
      if (uncertain) throw new DeviceError('session_closure_required','Previous session creation is unconfirmed');
      if (!sessionId) {
        await step('session_create', async () => {
          if ((await adb.helperPids(serial,options)).length) {
            throw new DeviceError('device_session_busy','Another automation session already owns this phone');
          }
          creating = true; uncertain = true;
          onState({phase:'creating', deviceId:serial});
          const value = await client.createProfileSession(profileId, serial, {...options,timeoutMs:15000});
          sessionId = value?.sessionId;
          if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
            sessionId = null; throw new DeviceError('session_identity_missing','Created session identity is unknown');
          }
          creating = false; uncertain = false;
          onState({phase:'active', deviceId:serial, sessionId});
          ui = createUiSession({client:{...client,enforceDouyinScreen:true},sessionId,resourceLocator:'xpath'});
        });
        if (afterCreate) await step('foreground_after_session', () => afterCreate());
      }
      throwIfAborted(signal);
      await step('lock_check', async () => {
        if (await client.isLocked(sessionId,options) !== false) throw new DeviceError('device_locked','Unlock the phone to continue');
      });
      await step('settings_check', async () => {
        const settings = await client.settings(sessionId,options);
        if (settings.wakeLockTimeout !== 0 || settings.enableTopmostWindowFromActivePackage !== false) {
          throw new DeviceError('session_settings_changed','Calibrated session settings changed');
        }
      });
      // Moves the home feed on by one item when reading it is slow or does not finish. Only while Douyin's
      // home activity holds focus, and through adb: the automation helper is the part that is busy.
      const skipFeedItem = async () => {
        const focus = parseWindowFocus(await adb.windowFocus(serial, options));
        if (focus?.package !== DOUYIN_P0_PROFILE.packageName || !focus.activity?.endsWith('.splash.SplashActivity')) return false;
        await adb.swipeUp(serial, options);
        return true;
      };
      const login = await step('login_check', () => verifyLoginAndSearchEntry(ui, {...options, skipFeedItem, feedSettleMs, slowReadMs}));
      return {...device,...login,deviceId:serial,unlocked:true,connected:true,readyForSearch:true};
    },
    async parkHome({signal, beforeAction}) {
      throwIfAborted(signal); beforeAction();
      if (creating || uncertain) throw new DeviceError('session_closure_required', 'Session ownership is not confirmed');
      if (!sessionId || !ui) throw new DeviceError('no_active_session', 'There is no owned session to return home');
      if (await client.isLocked(sessionId, {signal}) !== false) throw new DeviceError('device_locked', 'The phone must remain unlocked');
      throwIfAborted(signal); beforeAction();
      return parkDouyinHome({ui, signal, beforeAction});
    },
    close() {
      return bounded(async signal => {
        if (creating || (uncertain && !sessionId)) return {closed:false,reason:'session_creation_unconfirmed'};
        if (!sessionId) return {closed:true,verifiedAt:new Date().toISOString(),evidenceId:randomUUID()};
        const id = sessionId;
        const ownedPids = await adb.helperPids(serial,{signal});
        try {await client.deleteSession(id,{signal});} catch { /* Verify independently below. */ }
        if (await client.isSessionActive(id,{signal})) {
          return {closed:false,reason:'session_delete_unconfirmed'};
        }
        selectDevice(await adb.listDevices({signal}),serial);
        const remaining = await adb.helperPids(serial,{signal});
        if (remaining.some(pid => !ownedPids.includes(pid))) return {closed:false,reason:'helper_ownership_changed'};
        if (remaining.length) await adb.stopHelper(serial,{signal});
        if ((await adb.helperPids(serial,{signal})).length) return {closed:false,reason:'helper_stop_unconfirmed'};
        sessionId = null; ui = null; uncertain = false;
        const result={closed:true,verifiedAt:new Date().toISOString(),evidenceId:randomUUID(),sessionInvalid:true,helperStopped:true};
        onState({phase:'closed',deviceId:serial,...result});
        return result;
      }, {timeoutMs:15000});
    },
  };
}
