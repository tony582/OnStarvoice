import {existsSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {RunnerStore} from '../storage/runner-store.mjs';
import {setupRunner} from '../daemon/setup.mjs';
import {AndroidDaemon} from '../daemon/runtime.mjs';
import {readConfig} from '../daemon/state.mjs';
import {confirmDeviceClosure, daemonStatus, requestLocalStop} from '../daemon/local-control.mjs';

export async function startRunner({stateDir, durationMs, stdout = console.log}) {
  const config = readConfig(stateDir);
  const daemon = new AndroidDaemon({stateDir,config,actionTimeoutMs:config.deviceProfile ? 60000 : 10000});
  const stop = () => daemon.requestStop('user_stop');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let timer;
  if (durationMs) timer = setTimeout(stop, durationMs);
  try {
    stdout(JSON.stringify({starting: true, mode: config.simulation ? 'simulation_only' : config.deviceProfile ? 'calibrated_p0' : 'profile_required',
      stateDir, deviceId: daemon.config.deviceId}));
    return await daemon.run();
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

export async function daemonCommand(command, values, {env, stdout}) {
  const stateDir = resolve(values['state-dir']);
  if (command === 'setup') {
    return setupRunner({stateDir, baseUrl: values['cloud-url'] ?? env.STARVOICE_CLOUD_URL,
      deviceId: values.serial, code: env.STARVOICE_ACTIVATION_CODE,
      simulation: values.simulation === 'true', deviceProfile: values['device-profile'],
      adbPath: values['adb-path'], appiumUrl: values['appium-url'], clientLabel: values.label});
  }
  if (command === 'start') return startRunner({stateDir, stdout});
  const path = join(stateDir, 'runner.sqlite');
  if (!existsSync(path)) throw new Error('No existing runner.sqlite in --state-dir');
  const store = new RunnerStore(path);
  try {
    if (command === 'status') return daemonStatus(store);
    if (command === 'stop') return requestLocalStop(store);
    if (command === 'close') return await confirmDeviceClosure({store, config: readConfig(stateDir),
      evidence: JSON.parse(readFileSync(values['evidence-file'], 'utf8'))});
    throw new Error('Unknown daemon command');
  } finally { store.close(); }
}

export async function runControlPlaneDemo(values, {env, stdout}) {
  const stateDir = values['state-dir'] ? resolve(values['state-dir']) : mkdtempSync(join(tmpdir(), 'android-control-demo-'));
  const seconds = Number(values['duration-seconds'] ?? 15);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error('Demo duration must be 1..300 seconds');
  await setupRunner({stateDir, baseUrl: values['cloud-url'], deviceId: values.serial ?? 'SIMULATED_DEVICE',
    code: env.STARVOICE_ACTIVATION_CODE, simulation: true, clientLabel: 'Local simulation only'});
  const result = await startRunner({stateDir, durationMs: seconds * 1000, stdout});
  return {mode: 'simulation_only', networkUsed: true, deviceUsed: false, stateDir, result,
    message: '仅连接显式 localhost 控制面；需在该本地服务创建模拟节点任务。'};
}
