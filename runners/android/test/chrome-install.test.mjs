import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, readFile, writeFile, readdir, lstat, mkdir, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installChromeForTesting, preparePreviewChrome} from '../src/preview/chrome-install.mjs';
import {chromeInstallRoot, chromeInstallPaths, chromePlatform, readInstalledChrome, resolvePreviewChrome, SYSTEM_CHROME} from '../src/preview/chrome-cache.mjs';
import {zipFixture, chromeEntries, fakeBrowserTools, fakeCftNetwork, VERSION} from './chrome-install-fixture.mjs';

async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'chrome-install-test-')); t.after(() => rm(dir, {recursive: true, force: true})); return dir; }
function dependencies(homeDir, {arch = 'arm64', entries = chromeEntries(arch === 'arm64' ? 'mac-arm64' : 'mac-x64'), archive, toolsOptions, networkOptions} = {}) {
  const platform = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  const zip = archive ?? zipFixture(entries), tools = fakeBrowserTools(toolsOptions), network = fakeCftNetwork(zip, {platform, ...networkOptions});
  return {options: {homeDir, platform: 'darwin', arch, runImpl: tools.runImpl, fetchImpl: network.fetchImpl}, tools, network};
}

test('platform mapping is explicit and never guesses unsupported architectures', () => {
  assert.equal(chromePlatform({platform: 'darwin', arch: 'arm64'}), 'mac-arm64');
  assert.equal(chromePlatform({platform: 'darwin', arch: 'x64'}), 'mac-x64');
  for (const options of [{platform: 'linux', arch: 'x64'}, {platform: 'darwin', arch: 'arm'}]) assert.throws(() => chromePlatform(options));
});
test('both Mac builds install atomically, preserve safe framework links and are reused without networking', async t => {
  const homeDir = await temp(t), root = chromeInstallRoot(homeDir);
  for (const arch of ['arm64', 'x64']) {
    const targetPlatform = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
    const paths = chromeInstallPaths(root, VERSION, targetPlatform);
    const d = dependencies(homeDir, {arch, toolsOptions: {signature: arch === 'arm64' ? 'ad-hoc' : 'unsigned', onVersion: async () => {
      await assert.rejects(lstat(paths.current), {code: 'ENOENT'});
      await assert.rejects(lstat(paths.directory), {code: 'ENOENT'});
    }}});
    const installed = await installChromeForTesting(d.options);
    assert.equal(installed.installed, true);
    assert.equal(installed.path, paths.executable);
    const receipt = JSON.parse(await readFile(paths.receipt, 'utf8'));
    assert.equal(receipt.signature, arch === 'arm64' ? 'ad-hoc' : 'unsigned');
    assert.equal(receipt.checksums.md5, d.network.object.md5Hash);
    assert.equal(receipt.generation, d.network.object.generation);
    assert.equal((await lstat(paths.directory)).mode & 0o777, 0o700);
    const link = join(paths.app, 'Contents/Frameworks/Example.framework/Example');
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readFile(link, 'utf8'), 'fixture library');
    assert.match(await realpath(link), /Versions\/A\/Example$/u);
    assert.equal(readInstalledChrome({homeDir, platform: targetPlatform}).path, paths.executable);
    assert.equal((await installChromeForTesting({...d.options, fetchImpl: () => assert.fail('cached install must not fetch'),
      runImpl: () => assert.fail('cached install must not execute')})).installed, false);
    assert.equal((await readdir(root)).some(name => name.startsWith('.install')), false);
    assert.equal(d.tools.calls.some(([command]) => /(?:pkill|killall|xattr|spctl)$/u.test(command)), false);
    assert.equal(d.tools.calls.some(([, args]) => args.includes('--sign')), false);
  }
});
test('legacy system Chrome defaults prefer the managed installation; explicit user overrides still win', async t => {
  const homeDir = await temp(t), d = dependencies(homeDir);
  const installed = await installChromeForTesting(d.options);
  const options = {homeDir, platform: 'darwin', arch: 'arm64', onWarning: () => assert.fail('managed lookup should not warn')};
  assert.equal(resolvePreviewChrome(options).path, installed.path);
  assert.equal(resolvePreviewChrome({...options, chromePath: SYSTEM_CHROME}).path, installed.path);
  assert.equal(resolvePreviewChrome({...options, chromePath: installed.path}).source, 'managed');
  assert.equal((await preparePreviewChrome({...options, chromePath: installed.path,
    install: () => assert.fail('verified historical managed path is reused')})).source, 'managed');
  assert.equal(resolvePreviewChrome({...options, chromePath: SYSTEM_CHROME, chromeExplicit: true}).path, SYSTEM_CHROME);
  assert.equal(resolvePreviewChrome({...options, chromePath: '/explicit/other-browser'}).path, '/explicit/other-browser');
});
test('cache tampering and malformed current pointers are not accepted', async t => {
  const homeDir = await temp(t), d = dependencies(homeDir);
  const installed = await installChromeForTesting(d.options);
  const paths = chromeInstallPaths(chromeInstallRoot(homeDir), VERSION, 'mac-arm64');
  await writeFile(installed.path, 'tampered executable');
  assert.equal(readInstalledChrome({homeDir, platform: 'mac-arm64'}), null);
  const fallback = join(homeDir, 'fixture-system');
  await writeFile(fallback, 'not executed', {mode: 0o700});
  const options = {homeDir, platform: 'darwin', arch: 'arm64', systemChrome: fallback, onWarning: () => {}, warningState: {shown: false}};
  assert.equal(resolvePreviewChrome({...options, chromePath: installed.path, chromeExplicit: true}).path, fallback);
  const prepared = await preparePreviewChrome({...options, chromePath: installed.path,
    install: async () => {throw new Error('fixture install unavailable');}});
  assert.equal(prepared.path, fallback, 'even a saved managed path must not bypass receipt/hash validation');
  await writeFile(paths.current, JSON.stringify({version: '../../escape', platform: 'mac-arm64'}));
  assert.equal(readInstalledChrome({homeDir, platform: 'mac-arm64'}), null);
});
test('fallback is local and warns once; a custom executable skips installation', async t => {
  const homeDir = await temp(t), systemChrome = join(homeDir, 'system-browser');
  await writeFile(systemChrome, 'fixture never executed', {mode: 0o700});
  const warnings = [], warningState = {shown: false};
  const options = {homeDir, systemChrome, platform: 'darwin', arch: 'arm64', warningState, onWarning: line => warnings.push(line)};
  for (let i = 0; i < 3; i++) assert.equal(resolvePreviewChrome(options).path, systemChrome);
  const prepared = await preparePreviewChrome({...options, install: async () => {throw Object.assign(new Error('offline fixture'), {code: 'chrome_download_timeout'});}});
  assert.equal(prepared.path, systemChrome);
  assert.equal(prepared.installError, 'chrome_download_timeout');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /建议安装独立预览浏览器/u);
  assert.equal((await preparePreviewChrome({chromePath: systemChrome, install: () => assert.fail('explicit paths must not install')})).source, 'custom');
});
test('failed validation leaves no installed directory, pointer, lock or partial archive', async t => {
  for (const options of [{entries: chromeEntries('mac-arm64', {bundleId: 'com.google.Chrome'})},
    {toolsOptions: {verifyFails: true}}, {toolsOptions: {signature: 'unsigned'}}, {toolsOptions: {version: '0.0.0.0'}}]) {
    const homeDir = await temp(t), d = dependencies(homeDir, options);
    await assert.rejects(installChromeForTesting(d.options));
    assert.deepEqual(await readdir(chromeInstallRoot(homeDir)), []);
  }
});
test('wrong architecture and scripts are rejected before the version command', async t => {
  for (const executableBytes of [Buffer.from('#!/bin/sh\necho fake'), chromeEntries('mac-x64')[1].data]) {
    const homeDir = await temp(t), entries = chromeEntries();
    entries[1].data = executableBytes;
    const d = dependencies(homeDir, {entries});
    await assert.rejects(installChromeForTesting(d.options));
    assert.equal(d.tools.calls.some(([command]) => command.endsWith('/MacOS/Google Chrome for Testing')), false);
  }
});
test('installer fails before network when Python is unavailable and never overwrites an invalid version', async t => {
  const homeDir = await temp(t), d = dependencies(homeDir);
  await assert.rejects(installChromeForTesting({...d.options, runImpl: async () => {throw new Error('missing Python');},
    fetchImpl: () => assert.fail('prerequisite failure must precede download')}), {code: 'chrome_python_required'});
  const paths = chromeInstallPaths(chromeInstallRoot(homeDir), VERSION, 'mac-arm64');
  await mkdir(paths.directory, {recursive: true});
  await writeFile(join(paths.directory, 'keep.txt'), 'untouched');
  await assert.rejects(installChromeForTesting(d.options), {code: 'chrome_install_existing_invalid'});
  assert.equal(await readFile(join(paths.directory, 'keep.txt'), 'utf8'), 'untouched');
});
test('concurrent installers cannot replace each other or publish a partial version', async t => {
  const homeDir = await temp(t);
  let release, entered, verified = 0;
  const gate = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
  const d = dependencies(homeDir, {toolsOptions: {onVersion: async () => {if (++verified === 2) entered(); await gate;}}});
  const first = installChromeForTesting(d.options);
  const second = installChromeForTesting(d.options);
  await started;
  release();
  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(outcomes.map(value => value.installed).sort(), [false, true]);
  assert.equal(outcomes[0].path, outcomes[1].path);
  assert.equal(readInstalledChrome({homeDir, platform: 'mac-arm64'}).path, outcomes[0].path);
  assert.equal((await readdir(chromeInstallRoot(homeDir))).some(name => name.startsWith('.install')), false);
});
test('a publication interrupted before current is recoverable and abandoned staging does not lock future installs', async t => {
  const homeDir = await temp(t), d = dependencies(homeDir);
  const installed = await installChromeForTesting(d.options);
  const paths = chromeInstallPaths(chromeInstallRoot(homeDir), VERSION, 'mac-arm64');
  await rm(paths.current);
  const abandoned = join(chromeInstallRoot(homeDir), '.install-interrupted');
  await mkdir(abandoned);
  await writeFile(join(abandoned, 'browser.zip'), 'interrupted fixture');
  const recovery = dependencies(homeDir);
  const recovered = await installChromeForTesting(recovery.options);
  assert.equal(recovered.path, installed.path);
  assert.equal(recovered.installed, false);
  assert.equal(recovery.network.calls.length, 2, 'already verified version requires only metadata, not another archive');
  assert.equal(readInstalledChrome({homeDir, platform: 'mac-arm64'}).path, installed.path);
  assert.equal(await readFile(join(abandoned, 'browser.zip'), 'utf8'), 'interrupted fixture', 'do not delete another install attempt');
});
test('unsafe ZIP paths, link escapes, cycles, duplicates and special files never reach verification', async t => {
  const prefix = 'chrome-mac-arm64';
  for (const extra of [
    [{name: '../escape', data: 'x'}], [{name: '/absolute', data: 'x'}], [{name: `${prefix}/a/../../escape`, data: 'x'}],
    [{name: `${prefix}/a\\b`, data: 'x'}], [{name: 'chrome-mac-x64/wrong', data: 'x'}],
    [{name: `${prefix}/escape`, data: '../../outside', mode: 0o120777}],
    [{name: `${prefix}/a`, data: 'b', mode: 0o120777}, {name: `${prefix}/b`, data: 'a', mode: 0o120777}],
    [{name: `${prefix}/duplicate`, data: 'a'}, {name: `${prefix}/DUPLICATE`, data: 'b'}],
    [{name: `${prefix}/pipe`, data: '', mode: 0o010644}],
    [{name: `${prefix}/link`, data: 'target', mode: 0o120777}, {name: `${prefix}/link/child`, data: 'bad'}, {name: `${prefix}/target`, data: ''}],
  ]) {
    const homeDir = await temp(t), d = dependencies(homeDir, {entries: [...chromeEntries(), ...extra]});
    await assert.rejects(installChromeForTesting(d.options), {code: 'chrome_archive_unsafe'});
    assert.equal(d.tools.calls.some(([command]) => command === '/usr/bin/plutil'), false);
    assert.deepEqual(await readdir(chromeInstallRoot(homeDir)), []);
  }
});
test('oversized ZIP declarations, encrypted members, corrupt CRC and truncated archives fail even with a valid download checksum', async t => {
  const original = zipFixture(chromeEntries());
  const central = original.indexOf(Buffer.from('504b0102', 'hex'));
  assert.ok(central > 0);
  for (const mutate of [
    buffer => {buffer.writeUInt32LE(1024 * 1024 * 1024 + 1, central + 24); return buffer;},
    buffer => {buffer.writeUInt16LE(buffer.readUInt16LE(central + 8) | 1, central + 8); return buffer;},
    buffer => {buffer.writeUInt32LE((buffer.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16); return buffer;},
    buffer => buffer.subarray(0, buffer.length - 30),
  ]) {
    const homeDir = await temp(t), d = dependencies(homeDir, {archive: mutate(Buffer.from(original))});
    await assert.rejects(installChromeForTesting(d.options), {code: 'chrome_archive_unsafe'});
    assert.equal(d.tools.calls.some(([command]) => command === '/usr/bin/plutil'), false);
    assert.deepEqual(await readdir(chromeInstallRoot(homeDir)), []);
  }
});
