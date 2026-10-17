import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deploy, hash, releasePaths, preservedPath} from '../scripts/releases/douyin-filter-recovery/deploy.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-release-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const root = path.join(directory, 'app'), stage = path.join(directory, 'stage');
  const release = {version: '0.4.29', previous: '0.4.28', commit: 'b'.repeat(40),
    zip: 'StarVoice-extension-v0.4.29-20261017.zip', files: [], preservedSha256: hash('previous hotfix')};
  const write = async (file, data) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, data); };
  for (const name of releasePaths) {
    const before = name.endsWith('ops-control.js') ? "export const OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.28';" : `old ${name} 0.4.28`;
    const after = before.replace('0.4.28', '0.4.29');
    await write(path.join(root, name), before);
    await write(path.join(stage, 'payload', name), after);
    release.files.push({path: name, before: hash(before), after: hash(after)});
  }
  await write(path.join(root, preservedPath), 'previous hotfix');
  await fs.mkdir(path.join(root, 'public-downloads'), {recursive: true});
  await fs.writeFile(path.join(stage, release.zip), 'formal archive');
  release.zipSha256 = hash('formal archive');
  const states = ['onstarvoice-api', 'onstarvoice-scheduler', 'onstarvoice-ai-media', 'minilife'].map((name, i) => ({name, pid: 100 + i, status: 'online'}));
  const calls = [];
  const services = {
    health: async () => { calls.push('health'); },
    processes: async () => structuredClone(states),
    assertIdle: async () => { calls.push('idle'); return {activeTasks: 0, pendingCommands: 0, androidHeldItems: 0}; },
    manifest: async () => {
      const source = await fs.readFile(path.join(root, 'server/routes/update-manifest.js'), 'utf8');
      const latestVersion = source.includes('0.4.29') ? '0.4.29' : '0.4.28';
      return {latestVersion, minSupportedVersion: '0.3.51', downloadUrl: `https://voice.minilife.online/downloads/${release.zip}`};
    },
    download: async zip => fs.readFile(path.join(root, 'public-downloads', zip)),
    stopScheduler: async () => { calls.push('stop'); states[1].status = 'stopped'; states[1].pid = 0; },
    restartApi: async () => { calls.push('api'); states[0].pid += 1000; },
    restartScheduler: async () => { calls.push('scheduler'); states[1].pid = 1101; states[1].status = 'online'; },
  };
  return {root, stage, release, services, calls, states};
}
async function assertRestored(f) {
  for (const file of f.release.files) assert.equal(hash(await fs.readFile(path.join(f.root, file.path))), file.before);
  await assert.rejects(fs.stat(path.join(f.root, 'public-downloads', f.release.zip)), {code: 'ENOENT'});
  assert.equal(hash(await fs.readFile(path.join(f.root, preservedPath))), f.release.preservedSha256);
  assert.equal(f.states[1].status, 'online');
}

test('check mode is read only; apply verifies package and retains unrelated services and hotfix', async t => {
  const f = await fixture(t);
  assert.equal((await deploy({...f, checkOnly: true})).checked, true);
  await assertRestored(f);
  assert.ok(!f.calls.includes('stop'));
  const result = await deploy(f);
  assert.equal(result.published, true);
  assert.equal(f.states[2].pid, 102); assert.equal(f.states[3].pid, 103);
  for (const file of f.release.files) {
    assert.equal(hash(await fs.readFile(path.join(f.root, file.path))), file.after);
    assert.equal(hash(await fs.readFile(path.join(f.stage, 'backup', file.path))), file.before);
  }
  assert.ok(f.calls.lastIndexOf('idle') < f.calls.indexOf('api'));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.stage, 'published.json'), 'utf8')).commit, f.release.commit);
});

test('active capture blocks all live changes and service restarts', async t => {
  const f = await fixture(t);
  f.services.assertIdle = async () => { throw new Error('active capture'); };
  await assert.rejects(deploy(f), /active capture/);
  await assertRestored(f);
  assert.ok(!f.calls.includes('stop'));
});

test('capture starting before the final gate restores all files without restarting API', async t => {
  const f = await fixture(t);
  let checks = 0;
  f.services.assertIdle = async () => { if (++checks === 4) throw new Error('new active capture'); return {}; };
  await assert.rejects(deploy(f), /new active capture; rollback verified/);
  await assertRestored(f);
  // The API still has the previous modules loaded; do not interrupt the new task.
  assert.equal(f.calls.filter(call => call === 'api').length, 0);
});

test('API restart failure restores seven files and resumes the scheduler', async t => {
  const f = await fixture(t);
  const restart = f.services.restartApi;
  let attempts = 0;
  f.services.restartApi = async () => { if (++attempts === 1) throw new Error('restart failed'); await restart(); };
  await assert.rejects(deploy(f), /restart failed; rollback verified/);
  await assertRestored(f);
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.stage, 'rollback.json'), 'utf8')).restored, true);
});

test('download corruption rolls back before scheduling resumes', async t => {
  const f = await fixture(t);
  f.services.download = async () => { assert.equal(f.states[1].status, 'stopped'); return Buffer.from('corrupt'); };
  await assert.rejects(deploy(f), /Published download mismatch[\s\S]*rollback verified/);
  await assertRestored(f);
});

test('live drift, previous hotfix drift and unexpected surface fail before mutation', async t => {
  for (const mode of ['live', 'preserved', 'scope']) {
    const f = await fixture(t);
    if (mode === 'live') await fs.appendFile(path.join(f.root, releasePaths[0]), 'newer change');
    if (mode === 'preserved') await fs.appendFile(path.join(f.root, preservedPath), 'newer hotfix');
    if (mode === 'scope') f.release.files.push({path: 'server/.env'});
    await assert.rejects(deploy(f));
    assert.ok(!f.calls.includes('stop'));
  }
});
