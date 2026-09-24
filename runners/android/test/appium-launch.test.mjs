import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAppiumLaunch} from '../src/daemon/appium-launch.mjs';

const HOME = '/Users/tester';
const SAMPLE = `#!/usr/bin/env bash
# StarVoice Appium launcher
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=~/.local/share/starvoice/android-sdk
export APPIUM_HOME=~/.local/share/starvoice/android-toolchain
cd "$APPIUM_HOME"
exec node "$APPIUM_HOME/node_modules/appium/build/lib/main.js" --address 127.0.0.1 --port 4723 --log-level warn "$@"
`;

test('run-appium.sh is parsed into an execFile-style descriptor with expanded env and entry', () => {
  const launch = parseAppiumLaunch(SAMPLE, {home: HOME});
  assert.equal(launch.node, 'node');
  assert.equal(launch.entry, `${HOME}/.local/share/starvoice/android-toolchain/node_modules/appium/build/lib/main.js`);
  assert.deepEqual(launch.args, ['--address', '127.0.0.1', '--port', '4723', '--log-level', 'warn'],
    'the shell "$@" passthrough is not carried as a literal argument');
  assert.deepEqual(launch.env, {
    JAVA_HOME: '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    ANDROID_HOME: `${HOME}/.local/share/starvoice/android-sdk`,
    APPIUM_HOME: `${HOME}/.local/share/starvoice/android-toolchain`,
  });
});

test('an absolute node path and bare main.js path are preserved without a shell', () => {
  const launch = parseAppiumLaunch(`export JAVA_HOME=/j\nexport ANDROID_HOME=/a\nexport APPIUM_HOME=/p\n`
    + `exec /opt/node/bin/node /p/node_modules/appium/build/lib/main.js --port 4723\n`, {home: HOME});
  assert.equal(launch.node, '/opt/node/bin/node');
  assert.equal(launch.entry, '/p/node_modules/appium/build/lib/main.js');
  assert.deepEqual(launch.args, ['--port', '4723']);
});

test('a launch file without a node entry or a required env value is rejected', () => {
  assert.throws(() => parseAppiumLaunch('export JAVA_HOME=/j\nexport ANDROID_HOME=/a\nexport APPIUM_HOME=/p\n', {home: HOME}),
    /no node entry/u);
  assert.throws(() => parseAppiumLaunch('export JAVA_HOME=/j\nexec node /p/main.js\n', {home: HOME}), /missing ANDROID_HOME/u);
  assert.throws(() => parseAppiumLaunch('x'.repeat(64 * 1024 + 1), {home: HOME}), /too large/u);
});
