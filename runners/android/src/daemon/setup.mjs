import {profileCapabilities} from '../device/session-profile.mjs';
import {validateAppiumUrl} from '../device/appium.mjs';
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {RunnerStore} from '../storage/runner-store.mjs';
import {createControlClient} from '../cloud/control-client.mjs';
import {normalizeCloudUrl} from '../cloud/client.mjs';
import {validateSerial} from '../device/adb.mjs';
import {resolveAppiumLaunch} from './appium-launch.mjs';
import {assertSimulationOrigin, loadClientUuid, readConfig, stateValue, writePrivateJson} from './state.mjs';

export async function setupRunner({stateDir, baseUrl, deviceId, code, simulation = false, deviceProfile, adbPath, appiumUrl,
  appiumLaunch, appiumLaunchFile, clientLabel, client} = {}) {
  const directory = resolve(stateDir);
  const origin = normalizeCloudUrl(baseUrl);
  validateSerial(deviceId);
  if (simulation) assertSimulationOrigin(origin);
  if (deviceProfile) {
    if (simulation) throw new Error('Simulation and a physical profile cannot be combined');
    profileCapabilities(deviceProfile,deviceId);
  }
  if (appiumUrl) validateAppiumUrl(appiumUrl);
  // Record the local Appium launch descriptor so `up` can start it later; parse the run-appium.sh, never run it.
  const launch = deviceProfile ? (appiumLaunch ?? resolveAppiumLaunch({file: appiumLaunchFile})) : null;
  if (typeof code !== 'string' || !code.trim()) throw new Error('Activation code required in environment');
  if (existsSync(join(directory, 'connection.json'))) {
    const previous = readConfig(directory);
    if (previous.baseUrl !== origin || previous.deviceId !== deviceId || previous.simulation !== simulation
      || previous.deviceProfile !== deviceProfile) {
      throw new Error('Use a new state directory for a different server or device');
    }
    // Token rotation is explicit setup only. Never cross-bind queued evidence.
    const store = new RunnerStore(join(directory, 'runner.sqlite'));
    try {
      if (store.pendingCount() || stateValue(store, 'daemon:active') || stateValue(store, 'daemon:completion')
        || stateValue(store, 'daemon:status')?.running) throw new Error('Runner must be stopped with an empty queue');
    } finally { store.close(); }
  }
  const clientUuid = loadClientUuid(directory);
  const registered = await (client ?? createControlClient({baseUrl: origin})).register({
    code, clientUuid, deviceId, clientLabel: clientLabel ?? 'Android USB Runner', appVersion: '0.2.4',
  });
  const config = {baseUrl: origin, deviceId, clientUuid, agentId: registered.agent.id,
    agentToken: registered.agent.token, tenantId: registered.tenantId, simulation,
    ...(deviceProfile ? {deviceProfile, adbPath, appiumUrl: validateAppiumUrl(appiumUrl), ...(launch ? {appiumLaunch: launch} : {})} : {})};
  writePrivateJson(directory, 'connection.json', config);
  return {ok: true, agentId: config.agentId, deviceId, simulation, readyForSearch: simulation,
    reason: simulation ? 'simulation_only' : deviceProfile ? 'device_check_pending' : 'profile_required'};
}
