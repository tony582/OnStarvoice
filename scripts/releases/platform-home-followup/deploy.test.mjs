import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const publisher = fileURLToPath(new URL('./deploy.mjs', import.meta.url));
const publisherSource = await fs.readFile(publisher, 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
const oldZip = 'StarVoice-extension-v0.4.20-20260928.zip';
const newZip = 'StarVoice-extension-v0.4.21-20260928.zip';
const metadata = ['server/routes/update-manifest.js', 'server/public/about.html', 'server/services/ops-control.js'];
const replacedCode = ['server/services/capture-discovery/detail-dispatch.js', 'server/services/capture-discovery/detail-projection.js'];
const addedCode = 'server/services/capture-discovery/detail-timeout-cooldown.js';
const replaced = [...metadata, ...replacedCode];
const publicationOrder = [addedCode, ...replacedCode, 'public-downloads/' + newZip,
  metadata[1], metadata[2], metadata[0]];
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
    [metadata[0]]: sourceFor('0.4.20', oldZip),
    [metadata[1]]: '<html>Extension 0.4.20</html>',
    [metadata[2]]: "export const OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.20';\nexport const retained = true;\n",
    [replacedCode[0]]: 'export const dispatch = () => null;\n',
    [replacedCode[1]]: 'export const project = () => null;\n',
    'server/index.js': '// entry unchanged\n',
    'server/app.js': '// routing unchanged\n',
    'server/package.json': '{"type":"module"}\n',
    'server/package-lock.json': '{"lockfileVersion":3}\n',
    'server/db/migrate.js': '// migration unchanged\n',
    'server/.env': 'TEST_ENV=unchanged-fixture-only\n',
    ['public-downloads/' + oldZip]: 'old-package-fixture',
    'web/admin/dist/index.html': '<html>unchanged admin</html>',
    'web/admin/dist/assets/admin.js': '// unchanged admin asset\n',
    'web/admin/dist/._assets': 'existing macOS directory metadata',
    'web/admin/dist/assets/._admin.js': 'existing macOS file metadata',
    'web/admin/dist/.cache/file.json': 'existing hidden directory file',
  };
  const newFiles = {
    [metadata[0]]: sourceFor('0.4.21', newZip),
    [metadata[1]]: '<html>Extension 0.4.21; Android Runner 0.2.6</html>',
    [metadata[2]]: oldFiles[metadata[2]].replace('0.4.20', '0.4.21'),
    ['public-downloads/' + newZip]: 'new-package-fixture',
    [replacedCode[0]]: "import {cooldown} from './detail-timeout-cooldown.js';\nexport const dispatch = cooldown;\n",
    [replacedCode[1]]: 'export const project = () => ({sourceMessage: \"root cause\"});\n',
    [addedCode]: 'export const cooldown = () => false;\n',
  };
  for (const [relative, value] of Object.entries(oldFiles)) await write(path.join(app, relative), value);
  for (const [relative, value] of Object.entries(newFiles)) await write(path.join(stage, 'payload', relative), value);
  await fs.copyFile(publisher, path.join(stage, 'deploy.mjs'));
  const release = {
    baseHead: 'd68201d', sourceHead: 'f'.repeat(40), version: '0.4.21', androidVersion: '0.2.6',
    previousZip: oldZip, zip: newZip, rehearsalOnly: true,
    environmentSha: digest(oldFiles['server/.env']),
    files: Object.entries(newFiles).map(([relative, value]) => ({path: relative,
      oldSha: relative in oldFiles ? digest(oldFiles[relative]) : null, newSha: digest(value)})),
    guards: Object.entries(oldFiles).filter(([relative]) => !replaced.includes(relative) && relative !== 'server/.env')
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
    await assert.rejects(fs.stat(path.join(app, addedCode)), {code: 'ENOENT'});
  };
  const assertNoSwitch = async result => {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    await assert.rejects(fs.stat(path.join(stage, 'backup')), {code: 'ENOENT'});
    await assert.rejects(fs.stat(path.join(root, 'platform-home-followup.deploy.lock')), {code: 'ENOENT'});
  };
  return {root, app, stage, release, ci, oldFiles, newFiles, run, assertOriginal, assertNoSwitch};
}

test('read-only preflight leaves the complete baseline untouched', async t => {
  const f = await fixture(t), result = f.run('--check');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await f.assertOriginal();
  await assert.rejects(fs.stat(path.join(f.stage, 'backup')), {code: 'ENOENT'});
});

test('success switches exactly seven files while retaining Admin, guards and environment', async t => {
  const f = await fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const [relative, value] of Object.entries({...f.oldFiles, ...f.newFiles})) {
    assert.equal(await fs.readFile(path.join(f.app, relative), 'utf8'), value, relative);
  }
  for (const relative of replaced) assert.equal(await fs.readFile(path.join(f.stage, 'backup', relative), 'utf8'), f.oldFiles[relative]);
  const receipt = JSON.parse(await fs.readFile(path.join(f.stage, 'deployed.json'), 'utf8'));
  assert.equal(receipt.sourceHead, f.release.sourceHead);
  assert.equal(receipt.files, 7);
  assert.equal(receipt.simulation, true);
  assert.deepEqual(receipt.switchedFiles, publicationOrder);
  assert.equal(receipt.idleCounts.activeTasks, 0);
  assert.equal(receipt.idleCounts.androidHeldItems, 0);
  await assert.rejects(fs.stat(path.join(f.root, 'platform-home-followup.deploy.lock')), {code: 'ENOENT'});
});

for (const fail of ['mid-switch', 'after-code', 'readiness']) test(fail + ' restores all old files and removes the new package', async t => {
  const f = await fixture(t), result = f.run('--fail=' + fail);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /ROLLBACK VERIFIED/);
  await f.assertOriginal();
  const receipt = JSON.parse(await fs.readFile(path.join(f.stage, 'rollback.json'), 'utf8'));
  assert.equal(receipt.restored, true);
  assert.deepEqual(receipt.failures, []);
  assert.match(receipt.cause, new RegExp('Injected ' + fail));
  assert.deepEqual(receipt.switchedFiles, publicationOrder.slice(0,
    fail === 'mid-switch' ? 2 : fail === 'after-code' ? 3 : 7));
  await assert.rejects(fs.stat(path.join(f.stage, 'deployed.json')), {code: 'ENOENT'});
});

for (const relative of [metadata[1], ...replacedCode, 'server/index.js', 'server/.env', 'web/admin/dist/._assets']) test('baseline drift refuses before switch: ' + relative, async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.app, relative), 'external drift');
  const result = f.run();
  await f.assertNoSwitch(result);
  assert.match(result.stderr, /SHA mismatch/);
});

for (const relative of ['assets/unexpected.js', 'assets/._unexpected.js']) test('an additional Admin asset refuses before switch: ' + relative, async t => {
  const f = await fixture(t);
  await write(path.join(f.app, 'web/admin/dist', relative), 'external admin update');
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

function sourceBlock(startMarker, endMarker) {
  const start = publisherSource.indexOf(startMarker);
  const end = publisherSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, 'publisher source boundary exists');
  return publisherSource.slice(start, end);
}

// Exercise the actual production HTTP checks with a read-only transport double;
// --simulate deliberately has no HTTP, so file-switch rehearsals alone miss it.
function httpPreflight(f) {
  const origins = ['http://local.test', 'https://public.test'];
  const responses = new Map(), requested = [];
  for (const origin of origins) {
    responses.set(origin + '/downloads/' + oldZip, f.oldFiles['public-downloads/' + oldZip]);
    responses.set(origin + '/changelog', f.oldFiles[metadata[1]]);
    responses.set(origin + '/admin/', f.oldFiles['web/admin/dist/index.html']);
    responses.set(origin + '/admin/assets/admin.js', f.oldFiles['web/admin/dist/assets/admin.js']);
  }
  const context = vm.createContext({
    simulation: false, checkOnly: false, origins, manifest: f.release, hash: digest, metadataPaths: metadata,
    safePath: relative => path.join(f.app, relative),
    assertHash: async () => {}, checkGuards: async () => {}, assertManifest: async () => {},
    assertRegular: async () => {}, health: async () => {}, checkStage: async () => {},
    pm2Info: () => ({nodeVersion: '18.20.8', execPath: '/opt/onstarvoice/server/index.js'}),
    curl(url) {
      requested.push(url);
      if (!responses.has(url)) throw new Error('HTTP 404: ' + url);
      return responses.get(url);
    },
  });
  vm.runInContext(sourceBlock('async function assertHttpFiles(', 'async function health(') +
    sourceBlock('async function checkBase(', 'async function checkStage('), context);
  return {origins, responses, requested, run: () => vm.runInContext('(async () => {\n' +
    sourceBlock('await checkStage();', 'const lockPath =') + '\n})()', context)};
}

test('production HTTP preflight verifies public assets but never requests hidden metadata', async t => {
  const f = await fixture(t), http = httpPreflight(f);
  await http.run();
  assert.equal(http.requested.length, 8, 'package, changelog and two public Admin files at both origins');
  assert.deepEqual(new Set(http.requested), new Set(http.responses.keys()));
  await f.assertOriginal();
});

for (const failure of ['missing-public-asset', 'wrong-public-asset', 'wrong-package', 'wrong-changelog']) {
  test('production preflight rejects an existing HTTP problem before switching: ' + failure, async t => {
    const f = await fixture(t), http = httpPreflight(f), origin = http.origins[1];
    if (failure === 'missing-public-asset') http.responses.delete(origin + '/admin/assets/admin.js');
    if (failure === 'wrong-public-asset') http.responses.set(origin + '/admin/assets/admin.js', 'different public bytes');
    if (failure === 'wrong-package') http.responses.set(origin + '/downloads/' + oldZip, 'different zip');
    if (failure === 'wrong-changelog') http.responses.set(origin + '/changelog', 'different changelog');
    await assert.rejects(http.run(), /HTTP (404|Admin file changed|extension package differs|changelog differs)/);
    await f.assertOriginal();
    await assert.rejects(fs.stat(path.join(f.stage, 'backup')), {code: 'ENOENT'});
    await assert.rejects(fs.stat(path.join(f.root, 'platform-home-followup.deploy.lock')), {code: 'ENOENT'});
  });
}


test('missing cooldown module refuses before any source is switched', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.stage, 'payload', addedCode));
  const result = f.run();
  await f.assertNoSwitch(result);
  assert.match(result.stderr, /out-of-scope file/);
  await f.assertOriginal();
});

test('preexisting cooldown module refuses instead of overwriting external work', async t => {
  const f = await fixture(t);
  await write(path.join(f.app, addedCode), 'external existing module');
  const result = f.run();
  await f.assertNoSwitch(result);
  assert.match(result.stderr, /SHA mismatch/);
  assert.equal(await fs.readFile(path.join(f.app, addedCode), 'utf8'), 'external existing module');
});

test('cooldown syntax is checked on production Node before switch', async t => {
  const f = await fixture(t);
  const invalid = 'export const cooldown = (';
  await write(path.join(f.stage, 'payload', addedCode), invalid);
  f.release.files.find(file => file.path === addedCode).newSha = digest(invalid);
  await write(path.join(f.stage, 'release.json'), JSON.stringify(f.release));
  const result = f.run();
  await f.assertNoSwitch(result);
  await f.assertOriginal();
});


test('manifest order cannot publish imports or version metadata before their dependencies', async t => {
  const f = await fixture(t);
  f.release.files.reverse();
  await write(path.join(f.stage, 'release.json'), JSON.stringify(f.release));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const deployed = JSON.parse(await fs.readFile(path.join(f.stage, 'deployed.json'), 'utf8'));
  assert.deepEqual(deployed.switchedFiles, publicationOrder);
});

for (const mode of ['busy', 'held', 'unknown']) test('final idle gate rejects ' + mode + ' without backup, switch or restart', async t => {
  const f = await fixture(t), result = f.run('--idle=' + mode);
  assert.equal(result.status, mode === 'unknown' ? 1 : 78, result.stdout + result.stderr);
  assert.match(result.stderr, mode === 'unknown' ? /IDLE GATE UNKNOWN/ : /IDLE GATE BUSY/);
  assert.doesNotMatch(result.stdout + result.stderr, /SIMULATION: restart|ROLLBACK VERIFIED/);
  await f.assertOriginal();
  for (const file of ['backup', 'before.json', 'deployed.json', 'rollback.json']) {
    await assert.rejects(fs.stat(path.join(f.stage, file)), {code: 'ENOENT'});
  }
  await assert.rejects(fs.stat(path.join(f.root, 'platform-home-followup.deploy.lock')), {code: 'ENOENT'});
});

for (const mode of ['busy', 'unknown']) test('--check remains read-only and does not require idle: ' + mode, async t => {
  const f = await fixture(t), result = f.run('--check', '--idle=' + mode);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /IDLE GATE|SIMULATION: restart/);
  await f.assertOriginal();
  await assert.rejects(fs.stat(path.join(f.stage, 'backup')), {code: 'ENOENT'});
});

test('production rejects simulation-only idle overrides before loading release or touching app', async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, [path.join(f.stage, 'deploy.mjs'), '--idle=busy'],
    {encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument: --idle=busy/);
  await f.assertOriginal();
  await assert.rejects(fs.stat(path.join(f.stage, 'backup')), {code: 'ENOENT'});
});

test('final baseline checks precede the fresh idle gate and all backup/payload writes follow it', () => {
  const cutover = sourceBlock('try {\n  before = await checkBase();', '} catch (error) {\n  if (mutated.length)');
  const baseline = cutover.indexOf('await checkBase()');
  const gate = cutover.indexOf('assertIdleBeforeSwitch()');
  const backup = cutover.indexOf('await fs.mkdir(backup)');
  const payload = cutover.indexOf('await atomicCopy(');
  assert.ok(baseline >= 0 && baseline < gate && gate < backup && backup < payload);
  assert.equal(cutover.lastIndexOf('await checkBase()'), baseline, 'no slow baseline HTTP work after final idle observation');
});

function idleGateContext(transport) {
  const context = vm.createContext({
    simulation: false, simulatedIdle: '', console: {log() {}}, IDLE_QUERY_SOURCE: 'fixture query source',
    process: {execPath: '/node18'}, safePath: relative => '/app/' + relative,
    execFileSync: transport,
  });
  vm.runInContext(sourceBlock('function readIdleCounts()', 'async function sourceManifest('), context);
  return context;
}

test('production idle reader has a hard child deadline and accepts only fresh integer aggregates', () => {
  let call;
  const context = idleGateContext((...args) => {
    call = args;
    return JSON.stringify({checkedAt: new Date().toISOString(), activeTasks: 0, androidHeldItems: 0});
  });
  assert.equal(vm.runInContext('assertIdleBeforeSwitch().activeTasks', context), 0);
  assert.equal(call[0], '/node18');
  assert.equal(call[2].cwd, '/app/server');
  assert.equal(call[2].timeout, 15000);
  assert.equal(call[2].killSignal, 'SIGKILL');
  for (const counts of [null, {}, {activeTasks:'0',androidHeldItems:0},
    {activeTasks:0,androidHeldItems:-1}, {activeTasks:0,androidHeldItems:0,checkedAt:'2020-01-01'}]) {
    const invalid = idleGateContext(() => JSON.stringify(counts));
    assert.throws(() => vm.runInContext('assertIdleBeforeSwitch()', invalid), /IDLE GATE UNKNOWN/);
  }
});

test('idle database failure is redacted and cannot be interpreted as zero', () => {
  for (const transport of [() => {throw new Error('fixture-private-connection-error');}, () => 'not-json']) {
    const context = idleGateContext(transport);
    assert.throws(() => vm.runInContext('assertIdleBeforeSwitch()', context), error => {
      assert.match(error.message, /IDLE GATE UNKNOWN/);
      assert.doesNotMatch(error.message, /fixture-private/);
      return true;
    });
  }
});

test('production child issues only bounded read-only aggregate queries with the operator count predicates', async () => {
  const match = publisherSource.match(/const IDLE_QUERY_SOURCE = `([\s\S]*?)`;/);
  assert.ok(match);
  const statements = [];
  let config, output = '', errorOutput = '';
  class Client {
    constructor(options) { config = options; }
    async connect() {}
    async query(sql) {
      statements.push(sql);
      return {rows: [{count: 0}]};
    }
    async end() {}
  }
  const context = vm.createContext({pg: {Client}, process: {
    env: {DATABASE_URL: 'postgresql://fixture-only'}, stdout: {write(value) {output += value;}},
    stderr: {write(value) {errorOutput += value;}},
  }});
  const child = match[1].replace("import 'dotenv/config';", '').replace("import pg from 'pg';", '');
  await vm.runInContext('(async () => {' + child + '})()', context);
  assert.equal(errorOutput, '');
  assert.equal(config.connectionTimeoutMillis, 3000);
  assert.equal(config.statement_timeout, 3000);
  assert.equal(config.query_timeout, 4000);
  assert.equal(statements.length, 4);
  assert.equal(statements[0], 'BEGIN READ ONLY');
  assert.equal(statements[3], 'ROLLBACK');
  assert.match(statements[1], /status IN \('claimed','running','recovering','resume_requested'\)/);
  assert.match(statements[1], /COALESCE\(a.last_liveness_at,a.last_heartbeat_at\)>now\(\)-interval '5 minutes'/);
  assert.match(statements[2], /a.capabilities->>'agentKind'='android_mobile' AND i.metadata->>'deviceHeld'='true'/);
  const counts = JSON.parse(output);
  assert.deepEqual(Object.keys(counts).sort(), ['activeTasks', 'androidHeldItems', 'checkedAt']);
  assert.equal(counts.activeTasks, 0);
  assert.equal(counts.androidHeldItems, 0);
});
