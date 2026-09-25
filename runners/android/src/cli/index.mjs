import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseArguments, HELP} from './arguments.mjs';
import {runDoctor} from '../device/index.mjs';
import {runLocalDemo} from './demo.mjs';
import {daemonCommand, runControlPlaneDemo} from './daemon-commands.mjs';
import {runUp} from './up-command.mjs';
import {RunnerStore} from '../storage/runner-store.mjs';
import {createCloudClient} from '../cloud/client.mjs';
import {deliverPendingBatch} from '../cloud/delivery.mjs';

async function withStore(directory, operation) {
  const path = join(resolve(directory), 'runner.sqlite');
  if (!existsSync(path)) throw new Error('No existing runner.sqlite in --state-dir');
  const store = new RunnerStore(path);
  try { return await operation(store); } finally { store.close(); }
}

export async function runCli(args, {stdout = console.log, stderr = console.error,
  env = process.env, doctor = runDoctor, demo = runLocalDemo} = {}) {
  try {
    const {command, values} = parseArguments(args);
    if (command === 'help') { stdout(HELP); return 0; }
    if (command === 'run') {
      stdout(JSON.stringify({ok: false, code: 'profile_required',
        message: '真机操作及调度接入尚未验收。请先运行 doctor，设备到位后进行 P0。'}));
      return 2;
    }
    if (command === 'doctor') {
      const report = await doctor({serial: values.serial, adbPath: values['adb-path'],
        appiumPath: values['appium-path'], appiumCliPath: values['appium-cli-path'],
        appiumUrl: values['appium-url']});
      stdout(JSON.stringify(report, null, 2));
      return report.readyForP0 ? 0 : 2;
    }
    if (command === 'up') { await runUp(values, {env, stdout}); return 0; }
    if (['setup', 'start', 'stop', 'close', 'status', 'diagnose'].includes(command)) {
      const report = await daemonCommand(command, values, {env, stdout});
      stdout(JSON.stringify(report, null, 2));
      return 0;
    }
    if (command === 'demo' && values['cloud-url']) {
      stdout(JSON.stringify(await runControlPlaneDemo(values, {env, stdout}), null, 2));
      return 0;
    }
    if (command === 'demo') {
      const report = await demo({stateDir: values['state-dir']});
      stdout(JSON.stringify(report, null, 2));
      return report.results.every(item => item.status === 'completed') ? 0 : 2;
    }
    const report = await withStore(values['state-dir'], async store => {
      if (command === 'status') return {pendingEvents: store.pendingCount(), quarantinedEvents: store.quarantinedCount()};
      const client = createCloudClient({baseUrl: env.STARVOICE_CLOUD_URL, agentToken: env.STARVOICE_AGENT_TOKEN});
      const saved = store.loadCheckpoint('network:delivery');
      const retryState = command === 'retry-delivery' && saved?.value?.blocked
        ? {...saved.value, blocked: false, nextAttemptAt: 0} : saved?.value;
      const result = await deliverPendingBatch({store, client, retryState});
      store.saveCheckpoint('network:delivery', result.retryState, saved?.revision || 0);
      return result;
    });
    stdout(JSON.stringify(report, null, 2));
    return ['needs_action', 'deferred'].includes(report.status) ? 2 : 0;
  } catch {
    // Credentials and raw server/driver messages never reach the console.
    stderr('Command could not complete. Check command options, local state and connection settings.');
    return 2;
  }
}
