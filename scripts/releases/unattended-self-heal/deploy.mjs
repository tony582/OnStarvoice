// Prepared release only. --check is read-only; production deployment requires
// the user's explicit approval. A simulation exercises the same file operations
// but replaces PM2/HTTP with local adapters and never contacts production.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const stage = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const simulationIndex = args.indexOf('--simulate');
const simulation = simulationIndex >= 0;
const checkOnly = args.includes('--check');
const app = simulation ? path.resolve(args[simulationIndex + 1] || '') : '/opt/onstarvoice';
const failure = simulation ? (args.find(a => a.startsWith('--fail=')) || '').slice(7) : '';
const allowed = new Set(['--check', '--simulate']);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--simulate') { i++; continue; }
  if (simulation && args[i].startsWith('--fail=')) continue;
  if (!allowed.has(args[i])) throw new Error('Unknown argument: ' + args[i]);
}
if (simulation && (!args[simulationIndex + 1] || app === '/opt/onstarvoice' ||
    !path.basename(app).startsWith('simulation-'))) throw new Error('Unsafe simulation path');
if (process.versions.node !== '18.20.8') throw new Error('Use production Node 18.20.8');
const manifest = JSON.parse(await fs.readFile(path.join(stage, 'release.json'), 'utf8'));
const tag = manifest.sourceHead;
if (!/^[0-9a-f]{40}$/.test(tag) || manifest.baseHead !== '31b51d1' ||
    manifest.version !== '0.4.19') throw new Error('Invalid release identity');
if (!simulation && manifest.rehearsalOnly) throw new Error('Dirty-worktree rehearsal cannot deploy');
const hash = data => createHash('sha256').update(data).digest('hex');
const readHash = async file => {
  try { return hash(await fs.readFile(file)); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
function safePath(relative) {
  if (!relative || path.isAbsolute(relative) || relative.split('/').some(p => p === '..' || p === '.'))
    throw new Error('Unsafe release path: ' + relative);
  return path.join(app, relative);
}
async function assertRegular(file, allowMissing = false) {
  let current = file;
  for (;;) {
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) throw new Error('Refuse symlink: ' + current);
      if (current === file && !st.isFile()) throw new Error('Not a regular file: ' + current);
    } catch (e) {
      if (!(allowMissing && e.code === 'ENOENT')) throw e;
    }
    if (current === app || current === stage || current === path.dirname(current)) break;
    current = path.dirname(current);
  }
}
async function assertHash(file, expected) {
  await assertRegular(file, expected === null);
  const actual = await readHash(file);
  if (actual !== expected) throw new Error('SHA mismatch: ' + file + ' expected=' + expected + ' actual=' + actual);
}
const curl = url => execFileSync('curl', ['--max-time', '30', '-fsS', url], {maxBuffer: 40 * 1024 * 1024});
let restarts = 0;
function pm2Info() {
  if (simulation) return {pid: 100 + restarts, startedAt: 1000 + restarts,
    nodeVersion: '18.20.8', execPath: '/opt/onstarvoice/server/index.js', status: 'online'};
  const p = JSON.parse(execFileSync('pm2', ['jlist'], {maxBuffer: 4 * 1024 * 1024})).find(p => p.name === 'onstarvoice');
  if (!p || p.pm2_env?.status !== 'online') throw new Error('PM2 onstarvoice is not online');
  return {pid: p.pid, startedAt: p.pm2_env.pm_uptime, nodeVersion: p.pm2_env.node_version,
    execPath: p.pm2_env.pm_exec_path, status: p.pm2_env.status};
}
async function getManifest() {
  if (!simulation) return JSON.parse(curl('http://127.0.0.1:3002/api/update-manifest'));
  const source = await fs.readFile(safePath('server/routes/update-manifest.js'), 'utf8');
  const latestVersion = source.match(/latestVersion: '([^']+)'/)[1];
  const downloadUrl = source.match(/downloadUrl: '([^']+)'/)[1];
  const value = {latestVersion, downloadUrl, minSupportedVersion: '0.3.51'};
  return {...value, data: {updateManifest: value}};
}
async function assertManifest(version, zip) {
  const m = await getManifest();
  if (m.latestVersion !== version || m.data?.updateManifest?.latestVersion !== version ||
      m.downloadUrl !== m.data?.updateManifest?.downloadUrl ||
      !String(m.downloadUrl).endsWith('/downloads/' + zip) || m.minSupportedVersion !== '0.3.51')
    throw new Error('Unexpected live update manifest');
}
async function health() {
  if (simulation) {
    if (failure === 'readiness' && restarts === 1) throw new Error('Injected readiness failure');
    return;
  }
  curl('http://127.0.0.1:3002/api/health/ready');
  curl('http://127.0.0.1:3002/api/health/live');
}
async function restartAndWait() {
  restarts++;
  if (!simulation) execFileSync('pm2', ['restart', 'onstarvoice'], {stdio: ['ignore', 'pipe', 'pipe']});
  let last;
  for (let i = 0; i < (simulation ? 1 : 30); i++) {
    try { await health(); return; } catch (e) { last = e; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw last || new Error('Readiness timeout');
}
async function checkBase() {
  for (const f of manifest.files) await assertHash(safePath(f.path), f.oldSha);
  for (const f of manifest.guards) await assertHash(safePath(f.path), f.sha);
  await assertManifest('0.4.18', manifest.previousZip);
  const info = pm2Info();
  if (info.nodeVersion !== '18.20.8' || info.execPath !== '/opt/onstarvoice/server/index.js')
    throw new Error('Production interpreter or entrypoint changed');
  await health();
  return info;
}
async function checkStage() {
  for (const f of manifest.files) await assertHash(path.join(stage, 'payload', f.path), f.newSha);
  for (const f of manifest.files.filter(f => f.path.startsWith('server/') && f.path.endsWith('.js'))) {
    execFileSync(process.execPath, ['--input-type=module', '--check'],
      {input: await fs.readFile(path.join(stage, 'payload', f.path)), stdio: ['pipe', 'pipe', 'pipe']});
  }
  if (!simulation) {
    const ci = JSON.parse(await fs.readFile(path.join(stage, 'ci.json'), 'utf8'));
    if (ci.headSha !== tag || ci.status !== 'completed' || ci.conclusion !== 'success' ||
        ci.jobs?.length !== 5 || ci.jobs.some(j => j.status !== 'completed' || j.conclusion !== 'success'))
      throw new Error('Exact release commit has not passed all five CI jobs');
  }
}
async function atomicCopy(source, target) {
  await fs.mkdir(path.dirname(target), {recursive: true});
  const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.selfheal-' + tag);
  await fs.copyFile(source, temporary);
  await fs.chmod(temporary, 0o644);
  await fs.rename(temporary, target);
}
const receipt = (name, data) => fs.writeFile(path.join(stage, name), JSON.stringify(data, null, 2) + '\n');
await checkStage();
await checkBase();
if (checkOnly) {
  console.log('PASS: stage SHA, production 31b51d1 file baseline, Node 18.20.8, ready and update 0.4.18');
  process.exit(0);
}
// No stage or production write has happened before the read-only preflight.
const lockPath = path.join(path.dirname(stage), 'unattended-self-heal.deploy.lock');
const lock = await fs.open(lockPath, 'wx');
const backup = path.join(stage, 'backup');
let before, environmentHash, mutated = [], rollingBack = false, interrupted = false;
const checkInterrupted = () => { if (interrupted) throw new Error('Deployment interrupted'); };
async function rollback(error) {
  if (rollingBack) return;
  rollingBack = true;
  const failures = [];
  for (const f of [...mutated].reverse()) {
    try {
      const target = safePath(f.path);
      const current = await readHash(target);
      if (current !== f.oldSha && current !== f.newSha)
        throw new Error('Unexpected concurrent change: ' + f.path);
      if (f.oldSha === null) await fs.rm(target, {force: true});
      else await atomicCopy(path.join(backup, f.path), target);
      await fs.rm(path.join(path.dirname(target), '.' + path.basename(target) + '.selfheal-' + tag), {force: true});
    } catch (e) { failures.push(e.message); }
  }
  if (mutated.length) {
    try { await restartAndWait(); } catch (e) { failures.push(e.message); }
  }
  try {
    await checkBase();
    if (await readHash(path.join(app, 'server/.env')) !== environmentHash) throw new Error('Environment file changed');
  } catch (e) { failures.push(e.message); }
  let runtime = null;
  try { runtime = pm2Info(); } catch (e) { failures.push(e.message); }
  await receipt('rollback.json', {sourceHead: tag, baseHead: manifest.baseHead,
    cause: error.message, restored: failures.length === 0, failures, runtime});
  console.error(failures.length ? 'ROLLBACK INCOMPLETE: ' + failures.join('; ') : 'ROLLBACK VERIFIED: 31b51d1, manifest 0.4.18, service ready');
}
function onSignal() { interrupted = true; }
try {
  before = await checkBase();
  environmentHash = await readHash(path.join(app, 'server/.env'));
  await fs.mkdir(backup); // refuses an already used stage; backups are never overwritten
  for (const f of manifest.files.filter(f => f.oldSha !== null)) {
    const to = path.join(backup, f.path);
    await fs.mkdir(path.dirname(to), {recursive: true});
    await fs.copyFile(safePath(f.path), to);
    await assertHash(to, f.oldSha);
  }
  await receipt('before.json', {sourceHead: tag, baseHead: manifest.baseHead, runtime: before, environmentHash});
  await checkBase();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.once('SIGHUP', onSignal);
  for (const f of manifest.files) {
    checkInterrupted();
    await assertHash(safePath(f.path), f.oldSha);
    mutated.push(f); // rollback includes a failed copy or rename
    await atomicCopy(path.join(stage, 'payload', f.path), safePath(f.path));
    checkInterrupted();
    if (failure === 'mid-switch' && f.path === 'server/routes/capture-cloud.js') throw new Error('Injected mid-switch failure');
  }
  await restartAndWait();
  checkInterrupted();
  const after = pm2Info();
  if (after.startedAt <= before.startedAt || after.nodeVersion !== before.nodeVersion ||
      after.execPath !== before.execPath) throw new Error('PM2 did not restart the expected runtime');
  for (const f of manifest.files) await assertHash(safePath(f.path), f.newSha);
  for (const f of manifest.guards) await assertHash(safePath(f.path), f.sha);
  if (await readHash(path.join(app, 'server/.env')) !== environmentHash) throw new Error('Environment file changed');
  await assertManifest(manifest.version, manifest.zip);
  if (!simulation) {
    const zipFile = manifest.files.find(f => f.path === 'public-downloads/' + manifest.zip);
    const index = manifest.files.find(f => f.path === 'web/admin/dist/index.html');
    if (hash(curl('http://127.0.0.1:3002/downloads/' + manifest.zip)) !== zipFile.newSha ||
        hash(curl('http://127.0.0.1:3002/admin/')) !== index.newSha)
      throw new Error('HTTP release download or Admin index differs from the staged files');
    for (const f of manifest.files.filter(f => f.path.startsWith('web/admin/dist/assets/'))) {
      if (hash(curl('http://127.0.0.1:3002/admin/assets/' + path.basename(f.path))) !== f.newSha)
        throw new Error('HTTP Admin asset differs: ' + f.path);
    }
  }
  checkInterrupted();
  await receipt('deployed.json', {sourceHead: tag, baseHead: manifest.baseHead, version: manifest.version,
    runtime: after, files: manifest.files.length, simulation, at: new Date().toISOString()});
  console.log('DEPLOYMENT VERIFIED: ' + tag + ' / 0.4.19 / ready');
} catch (error) {
  if (mutated.length) await rollback(error);
  else console.error('REFUSED BEFORE SWITCH: ' + error.message);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGTERM', onSignal);
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGHUP', onSignal);
  await lock.close();
  await fs.rm(lockPath, {force: true});
}
