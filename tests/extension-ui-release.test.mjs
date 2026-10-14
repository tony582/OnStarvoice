import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deploy, metadataPaths, hash} from '../scripts/releases/extension-ui/deploy.mjs';

async function fixture(t, {failDownload = false} = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-ui-release-test-'));
  t.after(() => fs.rm(temp, {recursive: true}));
  const root = path.join(temp, 'app'), stage = path.join(temp, 'stage');
  await fs.mkdir(path.join(root, 'public-downloads'), {recursive: true});
  const release = {commit: 'a'.repeat(40), version: '0.4.27', previous: '0.4.26', zip: 'StarVoice-extension-v0.4.27-20261014.zip', files: []};
  for (const file of metadataPaths) {
    const before = file.endsWith('ops-control.js') ? "export const OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.26';" : '0.4.26';
    const after = before.replace('0.4.26', '0.4.27');
    await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true});
    await fs.mkdir(path.dirname(path.join(stage, 'payload', file)), {recursive: true});
    await fs.writeFile(path.join(root, file), before);
    await fs.writeFile(path.join(stage, 'payload', file), after);
    release.files.push({path: file, before: hash(before), after: hash(after)});
  }
  await fs.writeFile(path.join(stage, release.zip), 'test package'); release.zipSha256 = hash('test package');
  let restarts = 0;
  const services = {
    health: async () => {},
    manifest: async () => ({latestVersion: await fs.readFile(path.join(root, metadataPaths[0]), 'utf8'), minSupportedVersion: '0.3.51', downloadUrl: `https://voice.minilife.online/downloads/${release.zip}`}),
    processes: async () => ['api', 'scheduler', 'ai-media'].map((name, i) => ({name: `onstarvoice-${name}`, pid: i + 100 + (i ? 0 : restarts), status: 'online'})),
    restartApi: async () => { restarts++; },
    download: async () => { if (failDownload) throw new Error('Injected download failure'); return fs.readFile(path.join(root, 'public-downloads', release.zip)); },
  };
  return {root, stage, release, services, restarts: () => restarts};
}
test('release check is read only', async t => { const f = await fixture(t); assert.equal((await deploy({...f, checkOnly: true})).checked, true); assert.equal(f.restarts(), 0); await assert.rejects(fs.stat(path.join(f.stage, 'backup'))); });
test('release updates only metadata and package, restarting API once', async t => { const f = await fixture(t); assert.equal((await deploy(f)).published, true); assert.equal(f.restarts(), 1); for (const file of f.release.files) assert.equal(hash(await fs.readFile(path.join(f.root, file.path))), file.after); });
test('post-publish failure restores all metadata and removes only the new package', async t => { const f = await fixture(t, {failDownload: true}); await assert.rejects(deploy(f), /rollback verified/); assert.equal(f.restarts(), 2); for (const file of f.release.files) assert.equal(hash(await fs.readFile(path.join(f.root, file.path))), file.before); await assert.rejects(fs.stat(path.join(f.root, 'public-downloads', f.release.zip))); });
test('baseline drift rejects before writes or restart', async t => { const f = await fixture(t); await fs.writeFile(path.join(f.root, metadataPaths[0]), 'other release'); await assert.rejects(deploy(f), /File drift/); assert.equal(f.restarts(), 0); });
test('existing package is never overwritten', async t => { const f = await fixture(t); await fs.writeFile(path.join(f.root, 'public-downloads', f.release.zip), 'existing'); await assert.rejects(deploy(f), /already exists/); assert.equal(f.restarts(), 0); });
test('existing release lock blocks cutover', async t => { const f = await fixture(t); await fs.mkdir(path.join(f.root, '.extension-ui-release.lock')); await assert.rejects(deploy(f), /EEXIST/); assert.equal(f.restarts(), 0); });
