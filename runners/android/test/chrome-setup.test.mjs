import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setupRunner} from '../src/daemon/setup.mjs';
import {enableWechat} from '../src/cli/wechat-command.mjs';
import {parseArguments} from '../src/cli/arguments.mjs';
import {readConfig, writePrivateJson, setCheckpoint} from '../src/daemon/state.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {chromeInstallPaths, chromeInstallRoot, SYSTEM_CHROME} from '../src/preview/chrome-cache.mjs';
import {WECHAT_PROFILE} from '../src/device/wechat-profile.mjs';

function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'chrome-setup-test-')); t.after(() => rmSync(dir, {recursive: true, force: true})); return dir; }
function options(t) {
  const stateDir = temp(t);
  return {stateDir, baseUrl: 'https://fixture.example.invalid', deviceId: 'FIXTURE_PHONE', code: 'fixture-activation',
    client: {register: async () => ({agent: {id: randomUUID(), token: 'fixture-private-token'}, tenantId: randomUUID()})}};
}
test('ordinary physical setup and simulations never install a browser without WeChat intent', async t => {
  const input = options(t);
  await setupRunner({...input, prepareBrowser: () => assert.fail('ordinary setup may not download')});
  assert.equal(readConfig(input.stateDir).wechat, undefined);
  const simulation = options(t);
  await setupRunner({...simulation, baseUrl: 'http://127.0.0.1:1234', simulation: true, wechatPreview: true,
    prepareBrowser: () => assert.fail('simulations may not download')});
});
test('explicit setup preinstalls the browser without enabling WeChat or running OCR', async t => {
  const input = options(t), calls = [];
  const result = await setupRunner({...input, wechatPreview: true, prepareBrowser: async options => {
    calls.push(options); return {path: '/fixture/managed/chrome', source: 'managed'};
  }});
  assert.equal(calls.length, 1);
  assert.equal(result.previewBrowser.source, 'managed');
  assert.equal(readConfig(input.stateDir).wechat, undefined);
  assert.doesNotMatch(readFileSync(join(input.stateDir, 'connection.json'), 'utf8'), /fixture-activation/u);
});
test('reconfiguring an enabled phone retains OCR settings and upgrades the old system default', async t => {
  const input = options(t);
  await setupRunner(input);
  const previous = readConfig(input.stateDir);
  writePrivateJson(input.stateDir, 'connection.json', {...previous,
    wechat: {profile: WECHAT_PROFILE.id, ocrHelper: '/fixture/ocr', chromePath: SYSTEM_CHROME}});
  let called = 0;
  await setupRunner({...input, prepareBrowser: async options => {
    called++;
    assert.equal(options.chromePath, undefined, 'old system Chrome must not pin the automatic browser');
    return {path: '/fixture/managed/chrome', source: 'managed'};
  }});
  assert.equal(called, 1);
  assert.deepEqual(readConfig(input.stateDir).wechat, {profile: WECHAT_PROFILE.id, ocrHelper: '/fixture/ocr'});
});
test('automatic enablement and old managed config paths remain automatic after setup', async t => {
  const input = options(t); await setupRunner(input);
  const managed = chromeInstallPaths(chromeInstallRoot(), '150.0.1234.5', 'mac-arm64').executable;
  await enableWechat({stateDir: input.stateDir, prepareBrowser: async () => ({path: managed, source: 'managed'}), build: async () => '/fixture/ocr'});
  assert.equal(readConfig(input.stateDir).wechat.chromePath, undefined);
  writePrivateJson(input.stateDir, 'connection.json', {...readConfig(input.stateDir),
    wechat: {profile: WECHAT_PROFILE.id, ocrHelper: '/fixture/ocr', chromePath: managed}});
  await setupRunner({...input, prepareBrowser: async options => {
    assert.equal(options.chromePath, managed);
    return {path: managed, source: 'managed'};
  }});
  assert.deepEqual(readConfig(input.stateDir).wechat, {profile: WECHAT_PROFILE.id, ocrHelper: '/fixture/ocr'});
});
test('new explicit system override survives setup and is distinguishable from old defaults', async t => {
  const input = options(t);
  await setupRunner(input);
  writePrivateJson(input.stateDir, 'connection.json', {...readConfig(input.stateDir),
    wechat: {profile: WECHAT_PROFILE.id, ocrHelper: '/fixture/ocr', chromePath: SYSTEM_CHROME, chromeExplicit: true}});
  await setupRunner({...input, prepareBrowser: async options => {
    assert.equal(options.chromePath, SYSTEM_CHROME);
    return {path: SYSTEM_CHROME, source: 'custom'};
  }});
  assert.equal(readConfig(input.stateDir).wechat.chromeExplicit, true);
});
test('enable-wechat prepares a browser before OCR and records explicit overrides', async t => {
  const input = options(t); await setupRunner(input);
  const calls = [];
  const result = await enableWechat({stateDir: input.stateDir, chromePath: SYSTEM_CHROME,
    prepareBrowser: async options => {calls.push('browser'); assert.equal(options.chromePath, SYSTEM_CHROME); return {path: SYSTEM_CHROME, source: 'custom'};},
    build: async () => {calls.push('ocr'); return '/fixture/ocr';}});
  assert.deepEqual(calls, ['browser', 'ocr']);
  assert.equal(result.chrome, SYSTEM_CHROME);
  assert.equal(readConfig(input.stateDir).wechat.chromeExplicit, true);
});
test('temporary fallback is not pinned and an active runner cannot start installation', async t => {
  const input = options(t); await setupRunner(input);
  await enableWechat({stateDir: input.stateDir, prepareBrowser: async () => ({path: SYSTEM_CHROME, source: 'system', installError: 'chrome_download_timeout'}),
    build: async () => '/fixture/ocr'});
  assert.equal(readConfig(input.stateDir).wechat.chromePath, undefined);
  const store = new RunnerStore(join(input.stateDir, 'runner.sqlite'));
  setCheckpoint(store, 'daemon:active', {taskId: 'fixture'}); store.close();
  await assert.rejects(enableWechat({stateDir: input.stateDir,
    prepareBrowser: () => assert.fail('busy phone must not install'), build: () => assert.fail('busy phone must not compile')}), /Stop the Runner/u);
});
test('the preinstall CLI switch is explicit, boolean and restricted to setup', () => {
  assert.equal(parseArguments(['setup', '--state-dir', '/fixture', '--serial', 'FIXTURE_PHONE', '--wechat-preview', 'true']).values['wechat-preview'], 'true');
  for (const args of [['setup', '--state-dir', '/fixture', '--serial', 'FIXTURE_PHONE', '--wechat-preview', 'yes'],
    ['up', '--state-dir', '/fixture', '--wechat-preview', 'true']]) assert.throws(() => parseArguments(args));
});
