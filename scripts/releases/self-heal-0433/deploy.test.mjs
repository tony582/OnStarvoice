import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deploy, hash, serverPaths, adminIndex, metadataPaths, requiredGuardPaths, ciJobs, unwrapManifest} from './deploy.mjs';

const addedPaths = ['web/admin/dist/assets/DispatchPage-DSjr6cbf.js', 'web/admin/dist/assets/index-CfDDi6jE.js'];
const releasePaths = [...serverPaths, ...addedPaths, adminIndex, ...metadataPaths];

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'self-heal-0433-release-'));
  const directory = await fs.realpath(temporary);
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const root = path.join(directory, 'app'), stage = path.join(directory, 'stage');
  const release = {version: '0.4.33', previous: '0.4.32', commit: 'b'.repeat(40),
    zip: 'StarVoice-extension-v0.4.33-20261108.zip', zipSha256: hash('formal archive'), files: [], guards: []};
  const write = async (file, data) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, data); };
  for (const name of releasePaths) {
    const before = name.endsWith('ops-control.js') ? "export const OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.32';" : `old ${name} 0.4.32`;
    const after = before.replace('0.4.32', '0.4.33');
    if (addedPaths.includes(name)) {
      await fs.mkdir(path.dirname(path.join(root, name)), {recursive: true});
    } else { await write(path.join(root, name), before); await fs.chmod(path.join(root, name), 0o640); }
    await write(path.join(stage, 'payload', name), after);
    release.files.push({path: name, before: addedPaths.includes(name) ? null : hash(before), after: hash(after)});
  }
  for (const name of [...requiredGuardPaths, 'web/admin/dist/assets/main.js']) {
    const data = `preserved ${name}`;
    await write(path.join(root, name), data); release.guards.push({path: name, sha256: hash(data)});
  }
  await write(path.join(stage, release.zip), 'formal archive');
  const ci = {headSha: release.commit, status: 'completed', conclusion: 'success',
    jobs: ciJobs.map(name => ({name, status: 'completed', conclusion: 'success'}))};
  await write(path.join(stage, 'ci.json'), JSON.stringify(ci));
  const states = ['onstarvoice-api', 'onstarvoice-scheduler', 'onstarvoice-ai-media', 'minilife'].map((name, i) => ({
    name, pid: 100 + i, status: 'online', nodeVersion: '24.21.0', parametersHash: hash(name + 'parameters'),
    environmentHash: hash(name + 'environment'), entry: path.join(root, `server/entrypoints/${name.replace('onstarvoice-', '')}.js`),
  }));
  const calls = [];
  let schedulerRestarts = 0;
  let runningApiVersion = '0.4.32';
  const services = {
    health: async () => { calls.push('health'); },
    processes: async () => structuredClone(states),
    assertIdle: async () => { calls.push('idle'); return {activeTasks: 0, pendingCommands: 0, androidHeldItems: 0}; },
    manifest: async () => {
      const latestVersion = runningApiVersion;
      return {data: {updateManifest: {latestVersion, minSupportedVersion: '0.3.51',
        downloadUrl: `https://voice.minilife.online/downloads/${latestVersion === '0.4.33' ? release.zip : 'StarVoice-extension-v0.4.32-20261107.zip'}`}}};
    },
    download: async zip => { calls.push('download'); return fs.readFile(path.join(root, 'public-downloads', zip)); },
    stopScheduler: async () => { calls.push('stop'); states[1].status = 'stopped'; states[1].pid = 0; },
    restartApi: async () => {
      calls.push('api'); states[0].pid += 1000;
      const source = await fs.readFile(path.join(root, 'server/routes/update-manifest.js'), 'utf8');
      runningApiVersion = source.includes('0.4.33') ? '0.4.33' : '0.4.32';
    },
    restartScheduler: async () => { calls.push('scheduler'); states[1].pid = 1101 + schedulerRestarts++; states[1].status = 'online'; },
  };
  return {root, stage, release, services, calls, states, ci, write};
}
async function assertGuards(f) {
  for (const guard of f.release.guards) assert.equal(hash(await fs.readFile(path.join(f.root, guard.path))), guard.sha256, guard.path);
  assert.equal(f.states[2].pid, 102); assert.equal(f.states[3].pid, 103);
}
async function assertRestored(f) {
  for (const file of f.release.files) {
    if (file.before === null) { await assert.rejects(fs.lstat(path.join(f.root, file.path)), {code: 'ENOENT'}, file.path); continue; }
    assert.equal(hash(await fs.readFile(path.join(f.root, file.path))), file.before, file.path);
    assert.equal((await fs.stat(path.join(f.root, file.path))).mode & 0o777, 0o640);
  }
  await assert.rejects(fs.stat(path.join(f.root, 'public-downloads', f.release.zip)), {code: 'ENOENT'});
  await assertGuards(f);
  assert.equal(f.states[0].status, 'online'); assert.equal(f.states[1].status, 'online');
}

test('read-only check and success verify guarded files, old package, exact CI and unrelated PIDs', async t => {
  const f = await fixture(t);
  assert.equal((await deploy({...f, checkOnly: true})).checked, true);
  await assertRestored(f);
  assert.ok(!f.calls.includes('stop'));
  await assert.rejects(fs.stat(path.join(f.stage, 'before.json')), {code: 'ENOENT'});
  const result = await deploy(f);
  assert.equal(result.published, true);
  await assertGuards(f);
  assert.ok(f.calls.indexOf('api') < f.calls.indexOf('scheduler'));
  assert.ok(f.calls.indexOf('download') < f.calls.indexOf('scheduler'));
  for (const file of f.release.files) {
    assert.equal(hash(await fs.readFile(path.join(f.root, file.path))), file.after);
    const current = await fs.stat(path.join(f.root, file.path));
    assert.equal(current.mode & 0o777, 0o640, `${file.path} takes the mode of its siblings`);
    if (file.before === null) {
      await assert.rejects(fs.lstat(path.join(f.stage, 'backup', file.path)), {code: 'ENOENT'});
      continue;
    }
    assert.equal(hash(await fs.readFile(path.join(f.stage, 'backup', file.path))), file.before);
    const backup = await fs.stat(path.join(f.stage, 'backup', file.path));
    assert.equal(current.uid, backup.uid); assert.equal(current.gid, backup.gid);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(f.stage, 'published.json'))).commit, f.release.commit);
});

test('a later payload copy failure restores earlier changed files and resumes scheduler without API restart', async t => {
  const f = await fixture(t);
  let checks = 0;
  f.services.assertIdle = async () => {
    if (++checks === 3) await fs.writeFile(path.join(f.stage, 'payload', releasePaths[5]), 'payload changed after validation');
    return {activeTasks: 0, pendingCommands: 0, androidHeldItems: 0};
  };
  await assert.rejects(deploy(f), /Atomic stage hash mismatch[\s\S]*rollback verified/);
  await assertRestored(f);
  assert.equal(f.calls.filter(call => call === 'api').length, 0);
  const receipt = JSON.parse(await fs.readFile(path.join(f.stage, 'rollback.json')));
  assert.equal(receipt.restored, true); assert.deepEqual(receipt.changedPaths, releasePaths.slice(0, 5),
    'new files and the replaced file before the failure were all rolled back');
});

test('API health failure restores all files, removes new ones, and health before restarting scheduler', async t => {
  const f = await fixture(t);
  f.services.health = async () => {
    f.calls.push('health');
    if (f.calls.filter(call => call === 'api').length === 1) throw new Error('new API unhealthy');
  };
  await assert.rejects(deploy(f), /new API unhealthy; rollback verified/);
  await assertRestored(f);
  assert.equal(f.calls.filter(call => call === 'api').length, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.stage, 'rollback.json'))).restored, true);
});

test('concurrent changed-file drift is never overwritten and leaves scheduler stopped with incomplete receipt', async t => {
  const f = await fixture(t);
  const drift = 'external owner changed this after release';
  const download = f.services.download;
  f.services.download = async zip => {
    if (zip !== f.release.zip) return download(zip);
    await fs.writeFile(path.join(f.root, releasePaths[1]), drift);
    throw new Error('injected verification failure');
  };
  await assert.rejects(deploy(f), /rollback incomplete[\s\S]*Concurrent drift during rollback/);
  assert.equal(await fs.readFile(path.join(f.root, releasePaths[1]), 'utf8'), drift);
  for (const file of f.release.files.filter(file => file.path !== releasePaths[1])) {
    if (file.before === null) await assert.rejects(fs.lstat(path.join(f.root, file.path)), {code: 'ENOENT'});
    else assert.equal(hash(await fs.readFile(path.join(f.root, file.path))), file.before);
  }
  assert.equal(hash(await download(f.release.zip)), f.release.zipSha256, 'the running new manifest retains a downloadable immutable package');
  assert.equal(unwrapManifest(await f.services.manifest()).latestVersion, '0.4.33');
  await assertGuards(f); assert.equal(f.states[1].status, 'stopped');
  const receipt = JSON.parse(await fs.readFile(path.join(f.stage, 'rollback.json')));
  assert.equal(receipt.restored, false); assert.equal(receipt.retainedPackage, true);
  assert.equal(receipt.oldApiRestored, false); assert.ok(receipt.failures.some(value => value.includes(releasePaths[1])));
});

test('all three busy counts fail closed before mutation even if the injected service does not throw', async t => {
  for (const key of ['activeTasks', 'pendingCommands', 'androidHeldItems']) {
    const f = await fixture(t);
    f.services.assertIdle = async () => ({activeTasks: 0, pendingCommands: 0, androidHeldItems: 0, [key]: 1});
    await assert.rejects(deploy(f), new RegExp(key + ' blocks deployment'));
    await assertRestored(f); assert.ok(!f.calls.includes('stop'));
  }
});

test('busy check after scheduler stop restores the scheduler without changing files', async t => {
  const f = await fixture(t);
  let checks = 0;
  f.services.assertIdle = async () => ({activeTasks: ++checks === 3 ? 1 : 0, pendingCommands: 0, androidHeldItems: 0});
  await assert.rejects(deploy(f), /activeTasks blocks deployment[\s\S]*rollback verified/);
  await assertRestored(f); assert.ok(!f.calls.includes('api'));
});

test('wrong CI, baseline drift, missing guards, extra admin and extra payload are rejected before PM2 changes', async t => {
  for (const mode of ['ci-sha', 'ci-job', 'live', 'added-exists', 'guard', 'admin', 'payload']) {
    const f = await fixture(t);
    if (mode === 'ci-sha') { f.ci.headSha = 'c'.repeat(40); await fs.writeFile(path.join(f.stage, 'ci.json'), JSON.stringify(f.ci)); }
    if (mode === 'ci-job') { f.ci.jobs.pop(); await fs.writeFile(path.join(f.stage, 'ci.json'), JSON.stringify(f.ci)); }
    if (mode === 'live') await fs.appendFile(path.join(f.root, releasePaths[1]), 'external drift');
    if (mode === 'added-exists') await f.write(path.join(f.root, addedPaths[0]), 'someone already created this');
    if (mode === 'guard') f.release.guards = f.release.guards.filter(file => file.path !== 'server/.env');
    if (mode === 'admin') await f.write(path.join(f.root, 'web/admin/dist/assets/new.js'), 'unexpected');
    if (mode === 'payload') await f.write(path.join(f.stage, 'payload/server/.env'), 'unexpected');
    await assert.rejects(deploy(f)); assert.ok(!f.calls.includes('stop'), mode);
    await assertGuards(f);
  }
});

test('existing public package and shared release lock are never overwritten or removed', async t => {
  for (const mode of ['package', 'lock']) {
    const f = await fixture(t);
    const target = path.join(f.root, mode === 'package' ? `public-downloads/${f.release.zip}` : '.extension-ui-release.lock');
    if (mode === 'package') await fs.writeFile(target, 'pre-existing package'); else await fs.mkdir(target);
    await assert.rejects(deploy(f));
    if (mode === 'package') assert.equal(await fs.readFile(target, 'utf8'), 'pre-existing package');
    else assert.equal((await fs.stat(target)).isDirectory(), true);
    assert.ok(!f.calls.includes('stop')); await assertGuards(f);
  }
});

test('manifest reader supports all deployed response wrappers', () => {
  const expected = {latestVersion: '0.4.33'};
  assert.equal(unwrapManifest(expected), expected);
  assert.equal(unwrapManifest({updateManifest: expected}), expected);
  assert.equal(unwrapManifest({data: {updateManifest: expected}}), expected);
});


test('failed API rollback restart retains the public new archive until the old runtime can be verified', async t => {
  const f = await fixture(t);
  const restart = f.services.restartApi;
  let attempts = 0;
  f.services.restartApi = async () => {
    if (++attempts === 2) throw new Error('rollback restart failed');
    await restart();
  };
  const download = f.services.download;
  f.services.download = async zip => {
    if (zip === f.release.zip) throw new Error('new release verification failed');
    return download(zip);
  };
  await assert.rejects(deploy(f), /rollback incomplete[\s\S]*rollback restart failed/);
  for (const file of f.release.files) {
    if (file.before === null) await assert.rejects(fs.lstat(path.join(f.root, file.path)), {code: 'ENOENT'});
    else assert.equal(hash(await fs.readFile(path.join(f.root, file.path))), file.before);
  }
  assert.equal(unwrapManifest(await f.services.manifest()).latestVersion, '0.4.33', 'running API keeps its startup modules after failed restart');
  assert.equal(hash(await download(f.release.zip)), f.release.zipSha256);
  assert.equal(f.states[1].status, 'stopped');
  await assertGuards(f);
  const receipt = JSON.parse(await fs.readFile(path.join(f.stage, 'rollback.json')));
  assert.equal(receipt.restored, false); assert.equal(receipt.retainedPackage, true); assert.equal(receipt.oldApiRestored, false);
});

test('a new file created by someone else between check and publish is never replaced', async t => {
  const f = await fixture(t);
  const restart = f.services.stopScheduler;
  f.services.stopScheduler = async () => {
    await restart();
    await fs.writeFile(path.join(f.root, addedPaths[1]), 'concurrent creator');
  };
  // An unknown tree fails closed: the scheduler stays stopped for a person.
  await assert.rejects(deploy(f), /Already exists[\s\S]*rollback incomplete/);
  assert.equal(await fs.readFile(path.join(f.root, addedPaths[1]), 'utf8'), 'concurrent creator');
  await assert.rejects(fs.lstat(path.join(f.root, addedPaths[0])), {code: 'ENOENT'}, 'the earlier new file was removed');
  assert.equal(f.calls.filter(call => call === 'api').length, 0);
  assert.equal(f.states[1].status, 'stopped');
  const receipt = JSON.parse(await fs.readFile(path.join(f.stage, 'rollback.json')));
  assert.equal(receipt.restored, false); assert.deepEqual(receipt.changedPaths, [...serverPaths, addedPaths[0]]);
});

test('an admin asset path outside the hashed asset pattern is rejected before any change', async t => {
  const f = await fixture(t);
  const bad = 'web/admin/dist/assets/../../index.html';
  f.release.files.splice(serverPaths.length, 0, {path: bad, before: null, after: hash('x')});
  await assert.rejects(deploy(f));
  assert.ok(!f.calls.includes('stop'));
  await assertRestored({...f, release: {...f.release, files: f.release.files.filter(file => file.path !== bad)}});
});
