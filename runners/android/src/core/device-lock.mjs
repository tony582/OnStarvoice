import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RunnerFault } from './errors.mjs';

function lockPath(lockRoot, serial) {
  if (typeof lockRoot !== 'string' || !lockRoot || typeof serial !== 'string' || !serial.trim()) throw new RunnerFault('invalid_device_lock');
  return join(resolve(lockRoot), `${createHash('sha256').update(serial).digest('hex')}.lock`);
}

export function inspectDeviceLock({ lockRoot, serial }) {
  const path = lockPath(lockRoot, serial);
  try {
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    return { path, owner };
  } catch (error) {
    if (error.code === 'ENOENT') {
      // A directory without complete metadata may be an interrupted acquisition.
      try { lstatSync(path); } catch (directoryError) {
        if (directoryError.code === 'ENOENT') return null;
      }
    }
    return { path, owner: null, reason: 'device_lock_metadata_unconfirmed' };
  }
}

export function acquireDeviceLock({ lockRoot, serial, ownerId = randomUUID() }) {
  const path = lockPath(lockRoot, serial);
  mkdirSync(resolve(lockRoot), { recursive: true, mode: 0o700 });
  const root = lstatSync(resolve(lockRoot));
  if (!root.isDirectory() || root.isSymbolicLink()) throw new RunnerFault('invalid_device_lock_root');
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new RunnerFault('device_locked', 'Device control lock already exists; explicit closure review required',
      { path, owner: inspectDeviceLock({ lockRoot, serial })?.owner ?? null });
  }
  const token = randomUUID();
  const owner = { serial, ownerId, token, pid: process.pid, acquiredAt: new Date().toISOString() };
  let fd;
  try {
    fd = openSync(join(path, 'owner.json'), 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(owner));
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    // On failed acquisition metadata stays in place. PID age never authorizes removal.
  }
  return { path, token, owner, release: () => releaseDeviceLock({ lockRoot, serial, token }) };
}

export function releaseDeviceLock({ lockRoot, serial, token }) {
  const root = lstatSync(resolve(lockRoot));
  if (!root.isDirectory() || root.isSymbolicLink()) throw new RunnerFault('invalid_device_lock_root');
  const current = inspectDeviceLock({ lockRoot, serial });
  if (!current?.owner || !token || current.owner.token !== token || current.owner.serial !== serial) {
    throw new RunnerFault('device_lock_not_owned', 'Device lock release requires the current ownership token');
  }
  unlinkSync(join(current.path, 'owner.json'));
  rmdirSync(current.path);
}
