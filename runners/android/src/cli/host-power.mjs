import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {recordDiagnostic} from '../core/diagnostics.mjs';

const run = promisify(execFile);
export const BATTERY_POWER_WARNING = '电脑在用电池，合盖或电量低时可能睡眠，采集会中断';

/** One read per startup, never a poll or a change to the owner's power settings. */
export async function warnWhenHostOnBattery({store, stdout = console.log, platform = process.platform,
  execFileImpl = run, now = Date.now} = {}) {
  if (platform !== 'darwin') return {checked: false, powerSource: 'unsupported'};
  let result;
  try {
    result = await execFileImpl('/usr/bin/pmset', ['-g', 'batt'], {encoding: 'utf8', timeout: 2000, maxBuffer: 16384});
  } catch {
    // A missing tool/timeout is not proof of battery power and must not stop collection.
    return {checked: false, powerSource: 'unknown'};
  }
  const source = /^Now drawing from ['"](Battery Power|AC Power)['"]/im.exec(String(result?.stdout || ''))?.[1];
  if (source !== 'Battery Power') return {checked: source === 'AC Power', powerSource: source === 'AC Power' ? 'ac' : 'unknown'};
  try { stdout(BATTERY_POWER_WARNING); } catch { /* Terminal output is optional. */ }
  recordDiagnostic(store, {at: new Date(now()).toISOString(), event: 'host_power', reason: 'host_on_battery', message: BATTERY_POWER_WARNING});
  return {checked: true, powerSource: 'battery'};
}
