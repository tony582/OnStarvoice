// Narrow 0.4.30 release: eight approved files, one new extension archive.
// No dependency installs, environment writes, migrations or capture dispatch.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

export const releasePaths = [
  'server/services/capture-health-schema.js',
  'server/services/capture-cloud.js',
  'server/services/capture-orchestration.js',
  'server/services/capture-recovery-intents.js',
  'server/routes/capture-cloud.js',
  'server/services/ops-control.js',
  'server/public/about.html',
  'server/routes/update-manifest.js', // Publish metadata only after all implementation files.
];
export const requiredGuardPaths = [
  'server/.env', 'server/package.json', 'server/package-lock.json',
  'web/admin/dist/index.html',
  'public-downloads/StarVoice-extension-v0.4.29-20261017.zip',
  'server/services/android-control/posts.js',
  'server/services/android-control/post-ingest.js',
];
export const ciJobs = [
  'Tests and builds', 'Production Node 24 compatibility',
  'PostgreSQL 14 / Node 24.12.0 integration',
  'PostgreSQL 16 / Node 24.12.0 integration',
  'PostgreSQL 16 / Node 24 integration',
];
const SHA = /^[0-9a-f]{64}$/;
const affectedProcesses = ['onstarvoice-api', 'onstarvoice-scheduler'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async file => hash(await fs.readFile(file));
export const unwrapManifest = value => value?.data?.updateManifest || value?.updateManifest || value;
function safeRelative(value) {
  assert.ok(typeof value === 'string' && value && !path.isAbsolute(value) &&
    !value.includes('\\') && !value.includes('\0') &&
    !value.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe release path');
  return value;
}
async function regular(file) {
  let cursor = path.resolve(file);
  assert.ok((await fs.lstat(cursor)).isFile(), `Not a regular file: ${file}`);
  for (;;) {
    assert.ok(!(await fs.lstat(cursor)).isSymbolicLink(), `Refuse symlink: ${cursor}`);
    if (cursor === path.dirname(cursor)) break;
    cursor = path.dirname(cursor);
  }
}
async function inventory(directory, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await inventory(path.join(directory, entry.name), relative + '/'));
    else { assert.ok(entry.isFile(), `Non-regular tree entry: ${relative}`); result.push(relative); }
  }
  return result.sort();
}
async function assertAbsent(file) {
  try { await fs.lstat(file); throw new Error(`Already exists: ${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function assertDigest(file, expected, label) {
  await regular(file);
  assert.equal(await digest(file), expected, label);
}
async function atomicCopy(source, target, expected, tag) {
  const temporary = `${target}.capture-0430-${tag}`;
  const stat = await fs.stat(target);
  let created = false;
  try {
    await regular(source); await regular(target);
    await fs.copyFile(source, temporary, 1); created = true;
    assert.equal(await digest(temporary), expected, 'Atomic stage hash mismatch');
    await fs.chmod(temporary, stat.mode & 0o777);
    if (process.getuid?.() === 0) await fs.chown(temporary, stat.uid, stat.gid);
    await fs.rename(temporary, target);
  } finally { if (created) await fs.rm(temporary, {force: true}); }
}
function assertRelease(release) {
  assert.equal(release.version, '0.4.30'); assert.equal(release.previous, '0.4.29');
  assert.match(release.commit, /^[0-9a-f]{40}$/);
  assert.equal(release.zip, 'StarVoice-extension-v0.4.30-20261106.zip');
  assert.match(release.zipSha256, SHA);
  assert.deepEqual(release.files.map(file => file.path), releasePaths, 'Unexpected release surface/order');
  for (const file of release.files) { assert.match(file.before, SHA); assert.match(file.after, SHA); }
  assert.ok(Array.isArray(release.guards), 'Missing guards');
  assert.equal(new Set(release.guards.map(file => file.path)).size, release.guards.length, 'Duplicate guards');
  for (const guard of release.guards) {
    safeRelative(guard.path); assert.match(guard.sha256, SHA);
    assert.ok(!releasePaths.includes(guard.path) && guard.path !== `public-downloads/${release.zip}`, 'Guard overlaps release');
  }
  for (const required of requiredGuardPaths) assert.ok(release.guards.some(file => file.path === required), `Missing guard: ${required}`);
}
function assertCi(ci, release) {
  assert.equal(ci.headSha, release.commit, 'CI commit mismatch');
  assert.equal(ci.status, 'completed', 'CI not completed'); assert.equal(ci.conclusion, 'success', 'CI failed');
  assert.deepEqual(ci.jobs?.map(job => job.name).sort(), [...ciJobs].sort(), 'CI job set mismatch');
  for (const job of ci.jobs) { assert.equal(job.status, 'completed', `CI pending: ${job.name}`); assert.equal(job.conclusion, 'success', `CI failed: ${job.name}`); }
}
function assertIdle(value) {
  for (const key of ['activeTasks', 'pendingCommands', 'androidHeldItems']) assert.equal(value?.[key], 0, `${key} blocks deployment`);
  return value;
}
function assertProcessBaseline(processes, root) {
  assert.equal(new Set(processes.map(item => item.name)).size, processes.length, 'Ambiguous PM2 names');
  for (const role of ['api', 'scheduler', 'ai-media']) {
    const current = processes.find(item => item.name === `onstarvoice-${role}`);
    assert.ok(current?.status === 'online' && current.pid > 0, `Process unavailable: ${role}`);
    assert.equal(current.entry, path.join(root, `server/entrypoints/${role}.js`), `Unexpected process entry: ${role}`);
    assert.match(current.nodeVersion, /^24\./, `Unexpected process Node: ${role}`);
  }
}
function assertProcessContinuity(before, after, {restarted = []} = {}) {
  assert.deepEqual(after.map(item => item.name).sort(), before.map(item => item.name).sort(), 'PM2 process inventory changed');
  for (const old of before) {
    const current = after.find(item => item.name === old.name);
    assert.equal(current.status, old.status, `Process state changed: ${old.name}`);
    for (const key of ['entry', 'nodeVersion', 'parametersHash', 'environmentHash']) {
      assert.equal(current[key], old[key], `Process ${key} changed: ${old.name}`);
    }
    if (restarted.includes(old.name)) assert.ok(current.pid > 0 && current.pid !== old.pid, `Process did not restart: ${old.name}`);
    else assert.equal(current.pid, old.pid, `Unrelated process changed: ${old.name}`);
  }
}
function assertManifest(value, version, zip) {
  const manifest = unwrapManifest(value);
  assert.equal(manifest.latestVersion, version, 'Manifest version mismatch');
  assert.equal(manifest.minSupportedVersion, '0.3.51', 'Minimum version mismatch');
  assert.equal(manifest.downloadUrl, `https://voice.minilife.online/downloads/${zip}`, 'Manifest download mismatch');
  return manifest;
}

export async function deploy({root, stage, release, services, checkOnly = false, interrupted = () => false}) {
  assertRelease(release);
  root = path.resolve(root); stage = path.resolve(stage);
  assert.ok(stage !== root && !stage.startsWith(root + path.sep), 'Stage must be outside the application');
  const ciPath = path.join(stage, 'ci.json'); await regular(ciPath);
  assertCi(JSON.parse(await fs.readFile(ciPath, 'utf8')), release);
  const targetZip = path.join(root, 'public-downloads', release.zip);
  const stageZip = path.join(stage, release.zip);
  const oldZip = 'StarVoice-extension-v0.4.29-20261017.zip';
  const tag = randomUUID();
  const guards = async () => {
    for (const guard of release.guards) await assertDigest(path.join(root, guard.path), guard.sha256, `Guard drift: ${guard.path}`);
    const actual = (await inventory(path.join(root, 'web/admin/dist'))).map(file => `web/admin/dist/${file}`);
    assert.deepEqual(actual, release.guards.filter(file => file.path.startsWith('web/admin/dist/')).map(file => file.path).sort(), 'Admin inventory changed or incompletely guarded');
  };
  const baseline = async () => {
    await assertAbsent(targetZip);
    await assertAbsent(path.join(stage, 'backup'));
    for (const name of ['before.json', 'published.json', 'rollback.json']) await assertAbsent(path.join(stage, name));
    await assertDigest(stageZip, release.zipSha256, 'Package hash mismatch');
    assert.deepEqual(await inventory(path.join(stage, 'payload')), [...releasePaths].sort(), 'Unexpected payload inventory');
    for (const file of release.files) {
      await assertDigest(path.join(root, file.path), file.before, `Live drift: ${file.path}`);
      await assertDigest(path.join(stage, 'payload', file.path), file.after, `Payload drift: ${file.path}`);
    }
    const ops = 'server/services/ops-control.js';
    const oldOps = await fs.readFile(path.join(root, ops), 'utf8');
    assert.ok(oldOps.includes("OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.29'"), 'Missing previous ops baseline');
    assert.equal(await fs.readFile(path.join(stage, 'payload', ops), 'utf8'),
      oldOps.replace("OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.29'", "OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.30'"), 'Ops change exceeds version metadata');
    await guards();
  };
  await baseline(); await services.health();
  const beforeManifest = assertManifest(await services.manifest(), release.previous, oldZip);
  const oldZipSha256 = release.guards.find(file => file.path === `public-downloads/${oldZip}`).sha256;
  assert.equal(hash(await services.download(oldZip)), oldZipSha256, 'Previous public package mismatch');
  const beforeProcesses = await services.processes(); assertProcessBaseline(beforeProcesses, root);
  const idle = assertIdle(await services.assertIdle());
  if (checkOnly) return {checked: true, commit: release.commit, version: release.version, beforeProcesses, idle};
  // Shared with the earlier narrow publishers; never remove another run's lock.
  const lock = path.join(root, '.extension-ui-release.lock');
  await fs.mkdir(lock);
  const changed = [];
  let packageAdded = false, schedulerTouched = false, apiTouched = false;
  const check = () => { if (interrupted()) throw new Error('Release interrupted'); };
  const receipt = (name, value) => fs.writeFile(path.join(stage, name), JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  try {
    check(); await baseline();
    assertProcessContinuity(beforeProcesses, await services.processes());
    assertIdle(await services.assertIdle());
    await receipt('before.json', {commit: release.commit, beforeManifest, beforeProcesses, idle, guards: release.guards});
    await fs.mkdir(path.join(stage, 'backup'));
    for (const file of release.files) {
      const backup = path.join(stage, 'backup', file.path);
      await fs.mkdir(path.dirname(backup), {recursive: true});
      await fs.copyFile(path.join(root, file.path), backup, 1);
      await assertDigest(backup, file.before, `Backup drift: ${file.path}`);
    }
    check(); schedulerTouched = true; await services.stopScheduler();
    assertIdle(await services.assertIdle()); await guards(); check();
    const stagedZip = `${targetZip}.capture-0430-${tag}`;
    let stagedZipCreated = false;
    try {
      await fs.copyFile(stageZip, stagedZip, 1); stagedZipCreated = true;
      assert.equal(await digest(stagedZip), release.zipSha256, 'Staged package changed');
      await fs.chmod(stagedZip, 0o644);
      await fs.link(stagedZip, targetZip); packageAdded = true;
    } finally { if (stagedZipCreated) await fs.rm(stagedZip, {force: true}); }
    for (const file of release.files) {
      check();
      await assertDigest(path.join(root, file.path), file.before, `Concurrent change: ${file.path}`);
      await atomicCopy(path.join(stage, 'payload', file.path), path.join(root, file.path), file.after, tag);
      changed.push(file);
    }
    check(); assertIdle(await services.assertIdle()); await guards();
    apiTouched = true; await services.restartApi(); await services.health(); check();
    const manifest = assertManifest(await services.manifest(), release.version, release.zip);
    assert.equal(hash(await services.download(release.zip)), release.zipSha256, 'Published download mismatch');
    for (const file of release.files) await assertDigest(path.join(root, file.path), file.after, `Published file mismatch: ${file.path}`);
    await guards(); check(); await services.restartScheduler(); await services.health();
    const afterProcesses = await services.processes();
    assertProcessContinuity(beforeProcesses, afterProcesses, {restarted: affectedProcesses});
    await guards();
    const result = {published: true, commit: release.commit, version: release.version, zipSha256: release.zipSha256,
      beforeProcesses, afterProcesses, manifest, idle, at: new Date().toISOString()};
    await receipt('published.json', result);
    return result;
  } catch (error) {
    const failures = [];
    if (schedulerTouched) { try { await services.stopScheduler(); } catch (e) { failures.push(`Stop scheduler: ${e.message}`); } }
    let filesRestored = true;
    for (const file of [...changed].reverse()) {
      try {
        await assertDigest(path.join(root, file.path), file.after, 'Concurrent drift during rollback');
        const backup = path.join(stage, 'backup', file.path);
        await assertDigest(backup, file.before, 'Backup drift during rollback');
        await atomicCopy(backup, path.join(root, file.path), file.before, tag);
      } catch (e) { filesRestored = false; failures.push(`${file.path}: ${e.message}`); }
    }
    let treeVerified = filesRestored;
    try {
      for (const file of release.files) await assertDigest(path.join(root, file.path), file.before, `Rollback file mismatch: ${file.path}`);
      await guards();
    } catch (e) { treeVerified = false; failures.push(`Rollback tree verification: ${e.message}`); }
    // Runtime readiness must be proven before removing the archive: the old API
    // may still be serving the new manifest after a failed rollback restart.
    let oldApiRestored = false;
    if (treeVerified) {
      try {
        if (apiTouched) await services.restartApi();
        await services.health(); assertManifest(await services.manifest(), release.previous, oldZip);
        assert.equal(hash(await services.download(oldZip)), oldZipSha256, 'Previous public package mismatch');
        oldApiRestored = true;
      } catch (e) { failures.push(`API rollback: ${e.message}`); }
    }
    let retainedPackage = packageAdded;
    if (packageAdded && oldApiRestored) {
      try {
        await assertDigest(targetZip, release.zipSha256, 'Package drift during rollback');
        await fs.unlink(targetZip); retainedPackage = false;
      } catch (e) { failures.push(e.message); }
    }
    // Do not schedule on an unknown tree or a failed runtime restoration.
    if (schedulerTouched && oldApiRestored && failures.length === 0) {
      try { await services.restartScheduler(); await services.health(); }
      catch (e) { failures.push(`Scheduler rollback: ${e.message}`); }
    }
    try {
      await guards();
      assertProcessContinuity(beforeProcesses, await services.processes(), {restarted: [
        ...(apiTouched ? ['onstarvoice-api'] : []), ...(schedulerTouched ? ['onstarvoice-scheduler'] : []),
      ]});
    } catch (e) { failures.push(`Rollback process verification: ${e.message}`); }
    await receipt('rollback.json', {cause: error.message, restored: failures.length === 0,
      changedPaths: changed.map(file => file.path), retainedPackage, oldApiRestored,
      failures, at: new Date().toISOString()});
    throw new Error(`${error.message}; rollback ${failures.length ? 'incomplete: ' + failures.join('; ') : 'verified'}`);
  } finally { await fs.rmdir(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 3 && ['--check', '--apply'].includes(process.argv[2]), 'Use --check or --apply');
  assert.match(process.versions.node, /^24\./, 'Use production Node 24');
  const stage = path.dirname(fileURLToPath(import.meta.url));
  const root = '/opt/onstarvoice';
  const release = JSON.parse(await fs.readFile(path.join(stage, 'release.json'), 'utf8'));
  let interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { interrupted = true; });
  const command = (bin, args, options = {}) => {
    try { return execFileSync(bin, args, {encoding: 'utf8', timeout: 45000, maxBuffer: 10e6, stdio: ['pipe', 'pipe', 'pipe'], ...options}); }
    catch { throw new Error(`Command failed: ${bin} ${args.join(' ')}`); }
  };
  const get = async url => {
    const response = await fetch(url, {signal: AbortSignal.timeout(10000), headers: {'cache-control': 'no-cache'}});
    assert.equal(response.status, 200, `HTTP request failed: ${url}`); return response;
  };
  const canonical = object => Object.fromEntries(Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b)));
  const processes = async () => JSON.parse(command('pm2', ['jlist'])).map(p => ({name: p.name, pid: p.pid,
    status: p.pm2_env.status, entry: p.pm2_env.pm_exec_path, nodeVersion: p.pm2_env.node_version,
    environmentHash: hash(JSON.stringify(canonical(p.pm2_env.env))),
    parametersHash: hash(JSON.stringify({args: p.pm2_env.args, cwd: p.pm2_env.pm_cwd,
      interpreter: p.pm2_env.exec_interpreter, nodeArgs: p.pm2_env.node_args, mode: p.pm2_env.exec_mode, instances: p.pm2_env.instances})),
  }));
  const idle = async () => {
    const sql = `BEGIN READ ONLY; SET LOCAL statement_timeout='3s';
      SELECT json_build_object('checkedAt',now(),
        'activeTasks',(SELECT count(*) FROM capture_tasks WHERE task_type <> 'capture_orchestration'
          AND status IN ('claimed','running','recovering','interrupted','resume_requested','dispatch_pending','dispatched','assigned','pending','queued','waiting_device')),
        'pendingCommands',(SELECT count(*) FROM capture_agent_commands WHERE status IN ('pending','acknowledged') AND expires_at>now()),
        'androidHeldItems',(SELECT count(*) FROM capture_task_items i JOIN capture_agents a ON a.id=i.assigned_agent_id
          WHERE a.capabilities->>'agentKind'='android_mobile' AND i.metadata->>'deviceHeld'='true'));
      ROLLBACK;`;
    return JSON.parse(command('runuser', ['-u', 'postgres', '--', 'psql', '-qXAt', '-d', 'onstarvoice', '-v', 'ON_ERROR_STOP=1'], {input: sql, timeout: 10000}).trim());
  };
  const services = {
    health: async () => {
      const value = await (await get('http://127.0.0.1:3002/api/health/ready')).json();
      assert.equal(value.ok, true); assert.equal(value.status, 'ready'); assert.equal(value.role, 'api');
      assert.equal((await (await get('https://voice.minilife.online/api/health')).json()).ok, true);
    },
    manifest: async () => {
      const local = unwrapManifest(await (await get('http://127.0.0.1:3002/api/update-manifest')).json());
      const publicValue = unwrapManifest(await (await get('https://voice.minilife.online/api/update-manifest')).json());
      assert.deepEqual(publicValue, local, 'Public/local manifest mismatch'); return local;
    },
    download: async zip => {
      const local = Buffer.from(await (await get(`http://127.0.0.1:3002/downloads/${zip}`)).arrayBuffer());
      const publicBytes = Buffer.from(await (await get(`https://voice.minilife.online/downloads/${zip}`)).arrayBuffer());
      assert.equal(hash(local), hash(publicBytes), 'Public/local download mismatch'); return local;
    },
    processes, assertIdle: idle,
    stopScheduler: async () => { command('pm2', ['stop', 'onstarvoice-scheduler']); assert.equal((await processes()).find(p => p.name === 'onstarvoice-scheduler')?.status, 'stopped'); },
    restartApi: async () => {
      command('pm2', ['restart', 'onstarvoice-api']);
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) { try { await services.health(); return; } catch { await delay(500); } }
      throw new Error('API readiness timeout');
    },
    restartScheduler: async () => {
      command('pm2', ['restart', 'onstarvoice-scheduler']);
      const deadline = Date.now() + 30000;
      let stablePid = null, stableSince = 0;
      while (Date.now() < deadline) {
        const current = (await processes()).find(p => p.name === 'onstarvoice-scheduler');
        if (current?.status === 'online' && current.pid > 0) {
          if (stablePid !== current.pid) { stablePid = current.pid; stableSince = Date.now(); }
          if (Date.now() - stableSince >= 2500) return;
        } else { stablePid = null; stableSince = 0; }
        await delay(500);
      }
      throw new Error('Scheduler readiness timeout');
    },
  };
  console.log(JSON.stringify(await deploy({root, stage, release, services,
    checkOnly: process.argv[2] === '--check', interrupted: () => interrupted}), null, 2));
}
