import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const publisher = fileURLToPath(new URL('./deploy.mjs', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const oldZip = 'StarVoice-extension-v0.4.19-20260927.zip';
const newZip = 'StarVoice-extension-v0.4.20-20260928.zip';
const metadata = ['server/routes/update-manifest.js', 'server/public/about.html', 'server/services/ops-control.js'];
const jobs = ['Tests and builds', 'Production Node 18 compatibility',
  'PostgreSQL 14 / Node 24.12.0 integration', 'PostgreSQL 16 / Node 18.20.8 integration',
  'PostgreSQL 16 / Node 24.12.0 integration'];
const sourceFor = (version, zip) => 'export const EXTENSION_UPDATE_MANIFEST = Object.freeze(' + JSON.stringify({
  latestVersion: version, minSupportedVersion: '0.3.51', releaseDate: '2026-09-28',
  downloadUrl: 'https://voice.minilife.online/downloads/' + zip,
  changelogUrl: 'https://voice.minilife.online/changelog',
  releases: [{version, releaseDate: '2026-09-28', releaseNotes: [{tag: 'fix', notes: ['test release']}]}],
}) + ');\n';
async function write(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, value);
}
async function fixture(t) {
  // realpath avoids the macOS /var and /tmp aliases; the deployer rejects links.
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, 'task-device-publisher-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const app = path.join(root, 'simulation-app'), stage = path.join(root, 'stage');
  const oldFiles = {
    [metadata[0]]: sourceFor('0.4.19', oldZip),
    [metadata[1]]: '<html>Extension 0.4.19</html>',
    [metadata[2]]: "export const OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.19';\nexport const retained = true;\n",
    'server/index.js': '// entry unchanged\n',
    'server/app.js': '// routing unchanged\n',
    'server/package.json': '{"type":"module"}\n',
    'server/package-lock.json': '{"lockfileVersion":3}\n',
    'server/db/migrate.js': '// migration unchanged\n',
    'server/.env': 'TEST_ENV=unchanged-fixture-only\n',
    ['public-downloads/' + oldZip]: 'old-package-fixture',
    'web/admin/dist/index.html': '<html>unchanged admin</html>',
    'web/admin/dist/assets/admin.js': '// unchanged admin asset\n',
  };
  const newFiles = {
    [metadata[0]]: sourceFor('0.4.20', newZip),
    [metadata[1]]: '<html>Extension 0.4.20; Android Runner 0.2.6</html>',
    [metadata[2]]: oldFiles[metadata[2]].replace('0.4.19', '0.4.20'),
    ['public-downloads/' + newZip]: 'new-package-fixture',
  };
  for (const [relative, value] of Object.entries(oldFiles)) await write(path.join(app, relative), value);
  for (const [relative, value] of Object.entries(newFiles)) await write(path.join(stage, 'payload', relative), value);
  await fs.copyFile(publisher, path.join(stage, 'deploy.mjs'));
  const release = {
    baseHead: '88f5c10', sourceHead: 'f'.repeat(40), version: '0.4.20', androidVersion: '0.2.6',
    previousZip: oldZip, zip: newZip, rehearsalOnly: true,
    environmentSha: digest(oldFiles['server/.env']),
    files: Object.entries(newFiles).map(([relative, value]) => ({path: relative,
      oldSha: relative in oldFiles ? digest(oldFiles[relative]) : null, newSha: digest(value)})),
    guards: Object.entries(oldFiles).filter(([relative]) => !metadata.includes(relative) && relative !== 'server/.env')
      .map(([relative, value]) => ({path: relative, sha: digest(value)})),
  };
  const ci = {headSha: release.sourceHead, status: 'completed', conclusion: 'success',
    jobs: jobs.map(name => ({name, status: 'completed', conclusion: 'success'}))};
  await write(path.join(stage, 'release.json'), JSON.stringify(release));
  await write(path.join(stage, 'ci.json'), JSON.stringify(ci));
  const run = (...args) => spawnSync(process.execPath, [path.join(stage, 'deploy.mjs'), '--simulate', app, ...args],
    {encoding: 'utf8', timeout: 15000});
  const assertOriginal = async () => {
    for (const [relative, value] of Object.entries(oldFiles)) assert.equal(await fs.readFile(path.join(app, relative), 'utf8'), value, relative);
    await assert.rejects(fs.stat(path.join(app, 'public-downloads', newZip)), {code: 'ENOENT'});
  };
  const assertNoSwitch = async result => {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    await assert.rejects(fs.stat(path.join(stage, 'backup')), {code: 'ENOENT'});
    await assert.rejects(fs.stat(path.join(root, 'task-device-cleanup.deploy.lock')), {code: 'ENOENT'});
  };
  return {root, app, stage, release, ci, oldFiles, newFiles, run, assertOriginal, assertNoSwitch};
}

test('read-only preflight leaves the complete baseline untouched', async t => {
  const f = await fixture(t), result = f.run('--check');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await f.assertOriginal();
  await assert.rejects(fs.stat(path.join(f.stage, 'backup')), {code: 'ENOENT'});
});

test('success switches exactly four files while retaining Admin, guards and environment', async t => {
  const f = await fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const [relative, value] of Object.entries({...f.oldFiles, ...f.newFiles})) {
    assert.equal(await fs.readFile(path.join(f.app, relative), 'utf8'), value, relative);
  }
  for (const relative of metadata) assert.equal(await fs.readFile(path.join(f.stage, 'backup', relative), 'utf8'), f.oldFiles[relative]);
  const receipt = JSON.parse(await fs.readFile(path.join(f.stage, 'deployed.json'), 'utf8'));
  assert.equal(receipt.sourceHead, f.release.sourceHead);
  assert.equal(receipt.files, 4);
  assert.equal(receipt.simulation, true);
  await assert.rejects(fs.stat(path.join(f.root, 'task-device-cleanup.deploy.lock')), {code: 'ENOENT'});
});

for (const fail of ['mid-switch', 'readiness']) test(fail + ' restores all old files and removes the new package', async t => {
  const f = await fixture(t), result = f.run('--fail=' + fail);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /ROLLBACK VERIFIED/);
  await f.assertOriginal();
  const receipt = JSON.parse(await fs.readFile(path.join(f.stage, 'rollback.json'), 'utf8'));
  assert.equal(receipt.restored, true);
  assert.deepEqual(receipt.failures, []);
  assert.match(receipt.cause, new RegExp('Injected ' + fail));
  await assert.rejects(fs.stat(path.join(f.stage, 'deployed.json')), {code: 'ENOENT'});
});

for (const relative of [metadata[1], 'server/index.js', 'server/.env']) test('baseline drift refuses before switch: ' + relative, async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.app, relative), 'external drift');
  const result = f.run();
  await f.assertNoSwitch(result);
  assert.match(result.stderr, /SHA mismatch/);
});

test('an additional Admin asset refuses before switch', async t => {
  const f = await fixture(t);
  await write(path.join(f.app, 'web/admin/dist/assets/unexpected.js'), 'external admin update');
  const result = f.run();
  await f.assertNoSwitch(result);
  assert.match(result.stderr, /Admin file inventory changed/);
});

for (const invalid of ['sha', 'missing-job', 'failed-job', 'wrong-job']) test('invalid exact CI evidence refuses: ' + invalid, async t => {
  const f = await fixture(t);
  if (invalid === 'sha') f.ci.headSha = 'e'.repeat(40);
  if (invalid === 'missing-job') f.ci.jobs.pop();
  if (invalid === 'failed-job') f.ci.jobs[0].conclusion = 'failure';
  if (invalid === 'wrong-job') f.ci.jobs[0].name = 'Some other job';
  await write(path.join(f.stage, 'ci.json'), JSON.stringify(f.ci));
  const result = f.run();
  await f.assertNoSwitch(result);
  assert.match(result.stderr, /Exact release SHA/);
  await f.assertOriginal();
});

test('extra payload cannot change Admin or migrations', async t => {
  const f = await fixture(t);
  await write(path.join(f.stage, 'payload/server/db/migrate.js'), '// out of scope');
  const result = f.run();
  await f.assertNoSwitch(result);
  assert.match(result.stderr, /out-of-scope file/);
});

test('ops-control is limited to the version constant even when the staged SHA matches', async t => {
  const f = await fixture(t), relative = metadata[2];
  const changed = f.newFiles[relative] + 'export const unrelatedChange = true;\n';
  await write(path.join(f.stage, 'payload', relative), changed);
  f.release.files.find(file => file.path === relative).newSha = digest(changed);
  await write(path.join(f.stage, 'release.json'), JSON.stringify(f.release));
  const result = f.run();
  await f.assertNoSwitch(result);
  assert.match(result.stderr, /ops-control change exceeds/);
});
