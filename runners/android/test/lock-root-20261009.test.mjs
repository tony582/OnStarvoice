// 2026-10-08: after a five-day run the device lock's owner.json under /tmp was removed by macOS's cleaner at midnight.
// The Runner then left a lock directory without an owner, and the next start refused with device_locked. The fixed
// host-wide root now lives where no cleaner empties it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixedLockRoot} from '../src/daemon/state.mjs';

function onPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {value: platform, configurable: true});
  try { return fn(); } finally { Object.defineProperty(process, 'platform', original); }
}

test('the device lock root is host-wide and outside every temporary directory a cleaner empties', () => {
  assert.equal(onPlatform('darwin', fixedLockRoot), '/Users/Shared/StarVoice/android-device-locks');
  assert.equal(onPlatform('linux', fixedLockRoot), '/var/tmp/starvoice-android-device-locks');
  const windows = onPlatform('win32', fixedLockRoot).replaceAll('\\', '/');
  assert.match(windows, /StarVoice\/android-device-locks$/u);
  assert.ok(!windows.toLowerCase().includes('/temp/'));
  for (const platform of ['darwin', 'linux', 'win32']) {
    const root = onPlatform(platform, fixedLockRoot);
    assert.ok(!root.startsWith('/tmp/') && !root.startsWith('/private/tmp/'), `${platform}: ${root}`);
    assert.ok(!root.includes(process.env.HOME ?? '\u0000'), 'never a per-user directory: two users must meet the same lock');
  }
});
