import { execFile } from 'node:child_process';
import { DeviceError, bounded } from './bounded.mjs';

// No shell interpolation, npx, installation, or inherited remote ADB endpoints.
export function runDeviceCommand(file, args, { signal, timeoutMs = 5000, env = process.env, adbOperation } = {}) {
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
        const failure=new DeviceError(error.code === 'ENOENT' ? 'executable_missing' : 'command_failed',
          error.code === 'ENOENT' ? 'Required executable is not installed or not on PATH' : 'Device command failed');
        // Keep only the classified daemon signal, never raw account/device output.
        if (/daemon not running|cannot connect to (?:the )?daemon|failed to (?:start|connect to) daemon/iu.test(`${stdout}\n${stderr}`)) failure.adbDaemonUnavailable=true;
        if (adbOperation === 'start-server') failure.adbFailureCategory =
          /cannot start server on remote host/iu.test(`${stdout}\n${stderr}`) ? 'remote_host_refused' : 'other';
        reject(failure);
      } else resolve({ stdout, stderr });
    });
  }), { signal, timeoutMs });
}

// Binary stdout (a PNG screenshot through `adb exec-out`), bounded to maxBytes. Output is never echoed.
export function runDeviceBinary(file, args, { signal, timeoutMs = 8000, maxBytes = 8 * 1024 * 1024, env = process.env } = {}) {
  return bounded((boundedSignal) => new Promise((resolve, reject) => {
    const safeEnv = { ...env };
    delete safeEnv.ADB_SERVER_SOCKET;
    delete safeEnv.ANDROID_ADB_SERVER_ADDRESS;
    delete safeEnv.ANDROID_SERIAL;
    execFile(file, args, {
      signal: boundedSignal, windowsHide: true, shell: false, encoding: 'buffer',
      timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: maxBytes, env: safeEnv,
    }, (error, stdout) => {
      if (error) reject(new DeviceError(error.code === 'ENOENT' ? 'executable_missing' : 'command_failed', 'Device command failed'));
      else resolve(stdout);
    });
  }), { signal, timeoutMs });
}
