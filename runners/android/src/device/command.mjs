import { execFile } from 'node:child_process';
import { DeviceError, bounded } from './bounded.mjs';

// No shell interpolation, npx, installation, or inherited remote ADB endpoints.
export function runDeviceCommand(file, args, { signal, timeoutMs = 5000, env = process.env } = {}) {
  return bounded((boundedSignal) => new Promise((resolve, reject) => {
    const safeEnv = { ...env };
    delete safeEnv.ADB_SERVER_SOCKET;
    delete safeEnv.ANDROID_ADB_SERVER_ADDRESS;
    delete safeEnv.ANDROID_SERIAL;
    execFile(file, args, {
      signal: boundedSignal, windowsHide: true, shell: false, encoding: 'utf8',
      timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: safeEnv,
    }, (error, stdout, stderr) => {
      if (error) {
        // Do not echo subprocess output: it can contain device or account details.
        reject(new DeviceError(error.code === 'ENOENT' ? 'executable_missing' : 'command_failed',
          error.code === 'ENOENT' ? 'Required executable is not installed or not on PATH' : 'Device command failed'));
      } else resolve({ stdout, stderr });
    });
  }), { signal, timeoutMs });
}
