import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { acquireDeviceLock, inspectDeviceLock, releaseDeviceLock } from '../src/core/device-lock.mjs';

test('atomic device lock excludes the same serial and release validates current token', () => {
  const lockRoot = mkdtempSync(join(tmpdir(), 'android-lock-'));
  try {
    const first = acquireDeviceLock({ lockRoot, serial: 'phone-A' });
    assert.throws(() => acquireDeviceLock({ lockRoot, serial: 'phone-A' }), { code: 'device_locked' });
    const other = acquireDeviceLock({ lockRoot, serial: 'phone-B' });
    assert.notEqual(first.path, other.path);
    assert.throws(() => releaseDeviceLock({ lockRoot, serial: 'phone-A', token: 'wrong' }), { code: 'device_lock_not_owned' });
    assert.equal(inspectDeviceLock({ lockRoot, serial: 'phone-A' }).owner.token, first.token);
    first.release();
    const next = acquireDeviceLock({ lockRoot, serial: 'phone-A' });
    assert.throws(() => first.release(), { code: 'device_lock_not_owned' });
    assert.equal(inspectDeviceLock({ lockRoot, serial: 'phone-A' }).owner.token, next.token);
    next.release(); other.release();
  } finally { rmSync(lockRoot, { recursive: true, force: true }); }
});

test('lock remains after its process exits and is never stolen based on dead PID or age', () => {
  const lockRoot = mkdtempSync(join(tmpdir(), 'android-dead-owner-'));
  try {
    const source = `import {acquireDeviceLock} from ${JSON.stringify(new URL('../src/core/device-lock.mjs', import.meta.url).href)};
      const lock=acquireDeviceLock({lockRoot:${JSON.stringify(lockRoot)},serial:'phone'}); console.log(lock.token);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const lock = inspectDeviceLock({ lockRoot, serial: 'phone' });
    writeFileSync(join(lock.path, 'owner.json'), JSON.stringify({ ...lock.owner, pid: 99999999, acquiredAt: '2000-01-01T00:00:00Z' }));
    assert.throws(() => acquireDeviceLock({ lockRoot, serial: 'phone' }), { code: 'device_locked' });
    releaseDeviceLock({ lockRoot, serial: 'phone', token: child.stdout.trim() });
    assert.equal(inspectDeviceLock({ lockRoot, serial: 'phone' }), null);
  } finally { rmSync(lockRoot, { recursive: true, force: true }); }
});

test('incomplete or corrupt ownership metadata blocks acquisition and tokenless cleanup', () => {
  const lockRoot = mkdtempSync(join(tmpdir(), 'android-incomplete-lock-'));
  try {
    const lock = acquireDeviceLock({ lockRoot, serial: '../../phone' });
    unlinkSync(join(lock.path, 'owner.json'));
    assert.equal(inspectDeviceLock({ lockRoot, serial: '../../phone' }).reason, 'device_lock_metadata_unconfirmed');
    assert.throws(() => acquireDeviceLock({ lockRoot, serial: '../../phone' }), { code: 'device_locked' });
    assert.throws(() => lock.release(), { code: 'device_lock_not_owned' });
    mkdirSync(join(lockRoot, 'irrelevant'));
  } finally { rmSync(lockRoot, { recursive: true, force: true }); }
});

test('physical lock refuses a symlink root rather than using another lock namespace', async t => {
  const {symlinkSync} = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'device-lock-root-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const real = join(dir, 'real');
  const link = join(dir, 'link');
  const first = acquireDeviceLock({lockRoot: real, serial: 'phone'});
  symlinkSync(real, link, 'dir');
  assert.throws(() => acquireDeviceLock({lockRoot: link, serial: 'another-phone'}), {code: 'invalid_device_lock_root'});
  first.release();
});
