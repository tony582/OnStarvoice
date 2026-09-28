// Scoped metadata/package publication. No dependency installs, Admin build,
// migrations, database commands, environment edits or browser/device controls.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const stage = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const simulationIndex = args.indexOf('--simulate');
const simulation = simulationIndex >= 0;
const checkOnly = args.includes('--check');
const app = simulation ? path.resolve(args[simulationIndex + 1] || '') : '/opt/onstarvoice';
const failure = (args.find(value => value.startsWith('--fail=')) || '').slice(7);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--simulate') { i++; continue; }
  if (args[i] === '--check') continue;
  if (simulation && ['--fail=mid-switch', '--fail=readiness'].includes(args[i])) continue;
  throw new Error('Unknown argument: ' + args[i]);
}
if (simulation && (!args[simulationIndex + 1] || app === '/opt/onstarvoice' ||
  !path.basename(app).startsWith('simulation-'))) throw new Error('Unsafe simulation path');
if (stage === app || stage.startsWith(app + path.sep)) throw new Error('Stage must be outside the application');
if (process.versions.node !== '18.20.8') throw new Error('Use production Node 18.20.8');

const manifest = JSON.parse(await fs.readFile(path.join(stage, 'release.json'), 'utf8'));
const tag = manifest.sourceHead;
const SHA = /^[0-9a-f]{64}$/;
const ZIP = /^StarVoice-extension-v0\.4\.21-\d{8}\.zip$/;
const PREVIOUS_ZIP = /^StarVoice-extension-v0\.4\.20-\d{8}\.zip$/;
const metadataPaths = ['server/routes/update-manifest.js', 'server/public/about.html', 'server/services/ops-control.js'];
const CI_JOBS = ['Tests and builds', 'Production Node 18 compatibility',
  'PostgreSQL 14 / Node 24.12.0 integration', 'PostgreSQL 16 / Node 18.20.8 integration',
  'PostgreSQL 16 / Node 24.12.0 integration'];
if (!/^[0-9a-f]{40}$/.test(tag) || manifest.baseHead !== 'd68201d' ||
  manifest.version !== '0.4.21' || manifest.androidVersion !== '0.2.6' ||
  !ZIP.test(manifest.zip) || !PREVIOUS_ZIP.test(manifest.previousZip)) throw new Error('Invalid release identity');
if (!simulation && manifest.rehearsalOnly) throw new Error('Dirty-worktree rehearsal cannot deploy');
const allowedPaths = new Set([...metadataPaths, 'public-downloads/' + manifest.zip]);
function safeRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') ||
    path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error('Unsafe release path: ' + relative);
  }
  return relative;
}
const safePath = relative => path.join(app, safeRelative(relative));
if (!Array.isArray(manifest.files) || manifest.files.length !== 4 ||
  new Set(manifest.files.map(file => file.path)).size !== 4 ||
  manifest.files.some(file => !allowedPaths.has(file.path) || !SHA.test(file.newSha) ||
    (metadataPaths.includes(file.path) ? !SHA.test(file.oldSha) : file.oldSha !== null))) {
  throw new Error('Release must replace exactly three metadata files and add exactly one new zip');
}
if (!Array.isArray(manifest.guards) || new Set(manifest.guards.map(file => file.path)).size !== manifest.guards.length ||
  manifest.guards.some(file => !SHA.test(file.sha) || allowedPaths.has(file.path))) throw new Error('Invalid guards');
for (const file of [...manifest.files, ...manifest.guards]) safeRelative(file.path);
for (const required of ['server/index.js', 'server/app.js', 'server/package.json', 'server/package-lock.json',
  'server/db/migrate.js', 'web/admin/dist/index.html', 'public-downloads/' + manifest.previousZip]) {
  if (!manifest.guards.some(file => file.path === required)) throw new Error('Missing baseline guard: ' + required);
}
if (manifest.environmentSha !== undefined && !SHA.test(manifest.environmentSha)) throw new Error('Invalid environmentSha');
const hash = value => createHash('sha256').update(value).digest('hex');
const readHash = async file => {
  try { return hash(await fs.readFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
async function assertRegular(file, allowMissing = false) {
  let current = file;
  for (;;) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Refuse symlink: ' + current);
      if (current === file && !stat.isFile()) throw new Error('Not a regular file: ' + current);
    } catch (error) {
      if (!(allowMissing && error.code === 'ENOENT')) throw error;
    }
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
}
async function assertHash(file, expected) {
  await assertRegular(file, expected === null);
  const actual = await readHash(file);
  if (actual !== expected) throw new Error('SHA mismatch: ' + file + ' expected=' + expected + ' actual=' + actual);
}
async function listFiles(directory, base = directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Refuse symlink: ' + full);
    if (entry.isDirectory()) files.push(...await listFiles(full, base));
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join('/'));
    else throw new Error('Non-regular release tree entry: ' + full);
  }
  return files.sort();
}
async function checkGuards() {
  for (const file of manifest.guards) await assertHash(safePath(file.path), file.sha);
  const adminFiles = (await listFiles(safePath('web/admin/dist'))).map(file => 'web/admin/dist/' + file);
  const guardedAdmin = manifest.guards.filter(file => file.path.startsWith('web/admin/dist/')).map(file => file.path).sort();
  if (JSON.stringify(adminFiles) !== JSON.stringify(guardedAdmin)) throw new Error('Admin file inventory changed or is not completely guarded');
}
const curl = url => execFileSync('curl', ['--max-time', '30', '--retry', '0', '-fsS', '-H', 'Cache-Control: no-cache', url],
  {maxBuffer: 80 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
const origins = ['http://127.0.0.1:3002', 'https://voice.minilife.online'];
let restarts = 0;
function pm2Info() {
  if (simulation) return {pid: 100 + restarts, startedAt: 1000 + restarts, nodeVersion: '18.20.8',
    execPath: '/opt/onstarvoice/server/index.js', status: 'online', environmentHash: hash('simulation-env')};
  const processes = JSON.parse(execFileSync('pm2', ['jlist'], {maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']}));
  const matches = processes.filter(process => process.name === 'onstarvoice');
  if (matches.length !== 1 || matches[0].pm2_env?.status !== 'online') throw new Error('Expected one online PM2 onstarvoice process');
  const process = matches[0], env = process.pm2_env;
  // Record hashes only, never environment values or the raw PM2 document.
  const environment = Object.fromEntries(Object.entries(env.env || {}).sort(([a], [b]) => a.localeCompare(b)));
  return {pid: process.pid, startedAt: env.pm_uptime, nodeVersion: env.node_version,
    execPath: env.pm_exec_path, status: env.status, environmentHash: hash(JSON.stringify(environment))};
}
async function sourceManifest(file) {
  const source = await fs.readFile(file, 'utf8');
  const expression = source.match(/export const EXTENSION_UPDATE_MANIFEST = Object\.freeze\(([\s\S]*?)\);/);
  if (!expression) throw new Error('Update manifest export unavailable');
  return JSON.parse(JSON.stringify(vm.runInNewContext('(' + expression[1] + ')', {}, {timeout: 1000})));
}
async function assertManifest(version, zip) {
  const expected = await sourceManifest(safePath(metadataPaths[0]));
  if (expected.latestVersion !== version || expected.minSupportedVersion !== '0.3.51' ||
    expected.downloadUrl !== 'https://voice.minilife.online/downloads/' + zip ||
    expected.changelogUrl !== 'https://voice.minilife.online/changelog' ||
    expected.releases?.[0]?.version !== version || !expected.releases[0].releaseNotes?.length) {
    throw new Error('Unexpected staged/live update manifest identity');
  }
  if (!simulation) for (const origin of origins) {
    const value = JSON.parse(curl(origin + '/api/update-manifest'));
    for (const candidate of [value, value.data?.updateManifest]) {
      if (!candidate || ['latestVersion', 'minSupportedVersion', 'downloadUrl', 'changelogUrl', 'releaseDate', 'releases']
        .some(key => JSON.stringify(candidate[key]) !== JSON.stringify(expected[key]))) {
        throw new Error('HTTP update manifest differs from the installed source: ' + origin);
      }
    }
  }
}
async function assertHttpFiles(zip, zipSha, aboutSha) {
  if (simulation) return;
  for (const origin of origins) {
    if (hash(curl(origin + '/downloads/' + zip)) !== zipSha) throw new Error('HTTP extension package differs: ' + origin);
    if (hash(curl(origin + '/changelog')) !== aboutSha) throw new Error('HTTP changelog differs: ' + origin);
    for (const guard of manifest.guards.filter(file => file.path.startsWith('web/admin/dist/'))) {
      const relative = guard.path.slice('web/admin/dist/'.length);
      // Express static does not serve dotfiles. Keep every file in the disk
      // inventory/SHA guards, but do not request macOS metadata over HTTP.
      if (relative.split('/').some(segment => segment.startsWith('.'))) continue;
      const url = relative === 'index.html' ? '/admin/' : '/admin/' + relative;
      if (hash(curl(origin + url)) !== guard.sha) throw new Error('HTTP Admin file changed: ' + guard.path);
    }
  }
}
async function health() {
  if (simulation) {
    if (failure === 'readiness' && restarts === 1) throw new Error('Injected readiness failure');
    return;
  }
  curl(origins[0] + '/api/health/ready');
  curl(origins[0] + '/api/health/live');
}
async function restartAndWait() {
  restarts++;
  if (!simulation) execFileSync('pm2', ['restart', 'onstarvoice'], {stdio: ['ignore', 'pipe', 'pipe']});
  let last;
  for (let attempt = 0; attempt < (simulation ? 1 : 30); attempt++) {
    try { await health(); return; } catch (error) { last = error; }
    if (!simulation) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw last || new Error('Readiness timeout');
}
async function checkBase({verifyHttp = false} = {}) {
  for (const file of manifest.files) await assertHash(safePath(file.path), file.oldSha);
  await checkGuards();
  await assertManifest('0.4.20', manifest.previousZip);
  await assertRegular(safePath('server/.env'));
  if (manifest.environmentSha) await assertHash(safePath('server/.env'), manifest.environmentSha);
  const info = pm2Info();
  if (info.nodeVersion !== '18.20.8' || info.execPath !== '/opt/onstarvoice/server/index.js') throw new Error('Production runtime changed');
  await health();
  if (verifyHttp) {
    const previousZipGuard = manifest.guards.find(file => file.path === 'public-downloads/' + manifest.previousZip);
    await assertHttpFiles(manifest.previousZip, previousZipGuard.sha,
      manifest.files.find(file => file.path === metadataPaths[1]).oldSha);
  }
  return info;
}
async function checkStage() {
  const payloadPaths = await listFiles(path.join(stage, 'payload'));
  if (JSON.stringify(payloadPaths) !== JSON.stringify([...allowedPaths].sort())) throw new Error('Payload contains an out-of-scope file');
  for (const file of manifest.files) await assertHash(path.join(stage, 'payload', file.path), file.newSha);
  for (const relative of [metadataPaths[0], metadataPaths[2]]) execFileSync(process.execPath, ['--input-type=module', '--check'],
    {input: await fs.readFile(path.join(stage, 'payload', relative)), stdio: ['pipe', 'pipe', 'pipe']});
  const oldOps = await fs.readFile(safePath(metadataPaths[2]), 'utf8');
  const newOps = await fs.readFile(path.join(stage, 'payload', metadataPaths[2]), 'utf8');
  const oldConstant = "export const OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.20';";
  if (!oldOps.includes(oldConstant) || oldOps.replace(oldConstant,
    "export const OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.21';") !== newOps) throw new Error('ops-control change exceeds the version constant');
  const nextManifest = await sourceManifest(path.join(stage, 'payload', metadataPaths[0]));
  if (nextManifest.latestVersion !== manifest.version || nextManifest.releases?.[0]?.version !== manifest.version ||
    !nextManifest.releases[0].releaseNotes?.length) throw new Error('New changelog/version missing');
  const about = await fs.readFile(path.join(stage, 'payload', metadataPaths[1]), 'utf8');
  if (!about.includes('0.4.21') || !about.includes('0.2.6')) throw new Error('Public changelog must identify Extension 0.4.21 and Android Runner 0.2.6');
  const ci = JSON.parse(await fs.readFile(path.join(stage, 'ci.json'), 'utf8'));
  if (ci.headSha !== tag || ci.status !== 'completed' || ci.conclusion !== 'success' || ci.jobs?.length !== 5 ||
    JSON.stringify(ci.jobs.map(job => job.name).sort()) !== JSON.stringify([...CI_JOBS].sort()) ||
    ci.jobs.some(job => job.status !== 'completed' || job.conclusion !== 'success')) throw new Error('Exact release SHA has not passed all five named CI jobs');
}
async function atomicCopy(source, target) {
  await fs.mkdir(path.dirname(target), {recursive: true});
  const temporary = target + '.platform-home-followup-' + tag;
  await fs.copyFile(source, temporary, 1); // COPYFILE_EXCL; never follow an existing temp link.
  await fs.chmod(temporary, 0o644);
  await fs.rename(temporary, target);
}
const receipt = (name, data) => fs.writeFile(path.join(stage, name), JSON.stringify(data, null, 2) + '\n');
await checkStage();
await checkBase({verifyHttp: true});
if (checkOnly) {
  console.log('PASS: exact CI SHA, four-file scope, d68201d baseline, unchanged Admin, Node 18.20.8, update 0.4.20');
  process.exit(0);
}
const lockPath = path.join(path.dirname(stage), 'platform-home-followup.deploy.lock');
const lock = await fs.open(lockPath, 'wx');
const backup = path.join(stage, 'backup');
let before, environmentHash, mutated = [], interrupted = false;
const checkInterrupted = () => { if (interrupted) throw new Error('Deployment interrupted'); };
const onSignal = () => { interrupted = true; };
async function rollback(error) {
  const failures = [];
  for (const file of [...mutated].reverse()) {
    try {
      const target = safePath(file.path), current = await readHash(target);
      if (current !== file.oldSha && current !== file.newSha) throw new Error('Concurrent change; refusing overwrite: ' + file.path);
      await fs.rm(target + '.platform-home-followup-' + tag, {force: true});
      if (file.oldSha === null) await fs.rm(target, {force: true});
      else {
        await assertHash(path.join(backup, file.path), file.oldSha);
        await atomicCopy(path.join(backup, file.path), target);
      }
    } catch (failure) { failures.push(failure.message); }
  }
  try { await restartAndWait(); } catch (failure) { failures.push(failure.message); }
  let runtime;
  try {
    runtime = await checkBase({verifyHttp: true});
    if (await readHash(safePath('server/.env')) !== environmentHash || runtime.environmentHash !== before.environmentHash) throw new Error('Environment changed');
    // checkBase already verified the old public package, changelog and Admin.
  } catch (failure) { failures.push(failure.message); }
  await receipt('rollback.json', {sourceHead: tag, baseHead: manifest.baseHead, cause: error.message,
    restored: failures.length === 0, failures, runtime, simulation, at: new Date().toISOString()});
  console.error(failures.length ? 'ROLLBACK INCOMPLETE: ' + failures.join('; ') : 'ROLLBACK VERIFIED: d68201d / 0.4.20 / unchanged Admin and environment / ready');
}
try {
  before = await checkBase();
  environmentHash = await readHash(safePath('server/.env'));
  await fs.mkdir(backup); // Refuse reuse: never overwrite a release's backup.
  for (const file of manifest.files.filter(file => file.oldSha !== null)) {
    const destination = path.join(backup, file.path);
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.copyFile(safePath(file.path), destination);
    await assertHash(destination, file.oldSha);
  }
  await receipt('before.json', {sourceHead: tag, baseHead: manifest.baseHead, runtime: before, environmentHash, simulation});
  await checkBase();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, onSignal);
  for (const file of manifest.files) {
    checkInterrupted();
    await assertHash(safePath(file.path), file.oldSha);
    await assertHash(path.join(stage, 'payload', file.path), file.newSha);
    mutated.push(file);
    await atomicCopy(path.join(stage, 'payload', file.path), safePath(file.path));
    checkInterrupted();
    if (failure === 'mid-switch' && mutated.length === 2) throw new Error('Injected mid-switch failure');
  }
  await restartAndWait();
  checkInterrupted();
  const after = pm2Info();
  if (after.startedAt <= before.startedAt || after.pid === before.pid || after.nodeVersion !== before.nodeVersion ||
    after.execPath !== before.execPath || after.environmentHash !== before.environmentHash) throw new Error('PM2 runtime/environment restart mismatch');
  for (const file of manifest.files) await assertHash(safePath(file.path), file.newSha);
  await checkGuards();
  if (await readHash(safePath('server/.env')) !== environmentHash) throw new Error('Environment file changed');
  await assertManifest(manifest.version, manifest.zip);
  await assertHttpFiles(manifest.zip, manifest.files.find(file => file.path === 'public-downloads/' + manifest.zip).newSha,
    manifest.files.find(file => file.path === metadataPaths[1]).newSha);
  checkInterrupted();
  await receipt('deployed.json', {sourceHead: tag, baseHead: manifest.baseHead, version: manifest.version,
    androidVersion: manifest.androidVersion, runtime: after, files: manifest.files.length, simulation, at: new Date().toISOString()});
  console.log('DEPLOYMENT VERIFIED: ' + tag + ' / 0.4.21 / unchanged Admin and environment / ready');
} catch (error) {
  if (mutated.length) await rollback(error);
  else console.error('REFUSED BEFORE SWITCH: ' + error.message);
  process.exitCode = 1;
} finally {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(signal, onSignal);
  await lock.close();
  await fs.rm(lockPath, {force: true});
}
