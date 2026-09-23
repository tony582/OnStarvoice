import {chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {normalizeCloudUrl} from '../cloud/client.mjs';
import {validateSerial} from '../device/adb.mjs';

export const fixedLockRoot = () => process.platform === 'win32'
  ? join(process.env.ProgramData || 'C:/ProgramData', 'StarVoice', 'android-device-locks')
  : '/tmp/starvoice-android-device-locks';
export const setCheckpoint = (store, key, value) => store.saveCheckpoint(key, value, store.loadCheckpoint(key)?.revision ?? 0);
export const stateValue = (store, key) => store.loadCheckpoint(key)?.value ?? null;
export function readConfig(directory) {
  const config = JSON.parse(readFileSync(join(resolve(directory), 'connection.json'), 'utf8'));
  normalizeCloudUrl(config.baseUrl);
  validateSerial(config.deviceId);
  if (!config.agentToken || !config.agentId || !config.clientUuid) throw new Error('Invalid setup');
  return config;
}
export function writePrivateJson(directory, name, value) {
  mkdirSync(resolve(directory), {recursive: true, mode: 0o700});
  const target = join(resolve(directory), name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}
export function loadClientUuid(directory) {
  try {
    const {clientUuid} = JSON.parse(readFileSync(join(directory, 'identity.json'), 'utf8'));
    if (!/^[0-9a-f-]{36}$/iu.test(clientUuid)) throw new Error('Invalid identity');
    return clientUuid;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const clientUuid = randomUUID();
    writePrivateJson(directory, 'identity.json', {clientUuid});
    return clientUuid;
  }
}
export const sessionKey = (config) => createHash('sha256').update(`${config.agentId}:${config.deviceId}`).digest('hex');
export function assertSimulationOrigin(baseUrl) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)) {
    throw new Error('Simulation requires a loopback control plane');
  }
}
