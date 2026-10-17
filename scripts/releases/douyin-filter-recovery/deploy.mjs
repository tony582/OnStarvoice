// Narrow 0.4.29 release. No database writes, migrations or capture dispatch.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

export const releasePaths = [
  'server/routes/capture-cloud.js',
  'server/services/capture-elastic-policy.js',
  'server/services/capture-health-schema.js',
  'server/services/capture-recovery-intents.js',
  'server/routes/update-manifest.js',
  'server/services/ops-control.js',
  'server/public/about.html',
];
export const preservedPath = 'server/services/capture-discovery/detail-lifecycle.js';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async file => hash(await fs.readFile(file));
const regular = async file => assert.ok((await fs.lstat(file)).isFile(), `Not a regular file: ${file}`);
const affectedProcesses = ['onstarvoice-api', 'onstarvoice-scheduler'];
async function atomicCopy(source, target) {
  const temporary = `${target}.douyin-0429-stage`;
  const stat = await fs.stat(target);
  let created = false;
  try {
    await fs.copyFile(source, temporary, 1); created = true;
    await fs.chmod(temporary, stat.mode & 0o777);
    if (process.getuid?.() === 0) await fs.chown(temporary, stat.uid, stat.gid);
    await fs.rename(temporary, target);
  } finally { if (created) await fs.rm(temporary, {force: true}); }
}

export async function deploy({root, stage, release, services, checkOnly = false, interrupted = () => false}) {
  assert.equal(release.version, '0.4.29');
  assert.equal(release.previous, '0.4.28');
  assert.match(release.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(release.files.map(file => file.path), releasePaths);
  assert.equal(release.zip, 'StarVoice-extension-v0.4.29-20261017.zip');
  assert.match(release.preservedSha256, /^[0-9a-f]{64}$/);
  const preserve = async () => assert.equal(await digest(path.join(root, preservedPath)), release.preservedSha256, 'Previously deployed detail cleanup changed');
  const targetZip = path.join(root, 'public-downloads', release.zip);
  const stageZip = path.join(stage, release.zip);
  await regular(stageZip);
  assert.equal(await digest(stageZip), release.zipSha256, 'Package hash mismatch');
  try { await fs.lstat(targetZip); throw new Error('Package already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of release.files) {
    const current = path.join(root, file.path), next = path.join(stage, 'payload', file.path);
    await regular(current); await regular(next);
    assert.equal(await digest(current), file.before, `Live drift: ${file.path}`);
    assert.equal(await digest(next), file.after, `Payload drift: ${file.path}`);
  }
  const opsPath = 'server/services/ops-control.js';
  const oldOps = await fs.readFile(path.join(root, opsPath), 'utf8');
  const newOps = await fs.readFile(path.join(stage, 'payload', opsPath), 'utf8');
  assert.equal(newOps, oldOps.replace("OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.28'", "OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.29'"), 'Ops change exceeds version metadata');
  await preserve();
  await services.health();
  const beforeManifest = await services.manifest();
  assert.equal(beforeManifest.latestVersion, release.previous);
  assert.equal(beforeManifest.minSupportedVersion, '0.3.51');
  const beforeProcesses = await services.processes();
  for (const name of [...affectedProcesses, 'onstarvoice-ai-media']) {
    assert.ok(beforeProcesses.some(p => p.name === name && p.status === 'online'), `Process unavailable: ${name}`);
  }
  const idle = await services.assertIdle();
  if (checkOnly) return {checked: true, commit: release.commit, version: release.version, beforeProcesses, idle};
  const lock = path.join(root, '.extension-ui-release.lock');
  await fs.mkdir(lock);
  const changed = [];
  let packageAdded = false, schedulerTouched = false, apiTouched = false;
  const check = () => { if (interrupted()) throw new Error('Release interrupted'); };
  const receipt = (name, data) => fs.writeFile(path.join(stage, name), JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
  try {
    await receipt('before.json', {commit: release.commit, beforeManifest, beforeProcesses, idle});
    for (const file of release.files) {
      const backup = path.join(stage, 'backup', file.path);
      await fs.mkdir(path.dirname(backup), {recursive: true});
      await fs.copyFile(path.join(root, file.path), backup, 1);
      assert.equal(await digest(backup), file.before, `Backup drift: ${file.path}`);
    }
    check(); await services.assertIdle(); await preserve();
    schedulerTouched = true;
    await services.stopScheduler();
    // Recheck after stopping scheduled dispatch, before changing any live files.
    await services.assertIdle(); check();
    const stagedZip = `${targetZip}.douyin-0429-stage`;
    let stagedZipCreated = false;
    try {
      await fs.copyFile(stageZip, stagedZip, 1); stagedZipCreated = true;
      await fs.chmod(stagedZip, 0o644);
      await fs.link(stagedZip, targetZip); packageAdded = true;
    } finally { if (stagedZipCreated) await fs.rm(stagedZip, {force: true}); }
    for (const file of release.files) {
      check();
      assert.equal(await digest(path.join(root, file.path)), file.before, `Concurrent change: ${file.path}`);
      await atomicCopy(path.join(stage, 'payload', file.path), path.join(root, file.path));
      changed.push(file);
    }
    check(); await services.assertIdle();
    apiTouched = true;
    await services.restartApi(); await services.health();
    check();
    const manifest = await services.manifest();
    assert.equal(manifest.latestVersion, release.version);
    assert.equal(manifest.minSupportedVersion, '0.3.51');
    assert.equal(manifest.downloadUrl, `https://voice.minilife.online/downloads/${release.zip}`);
    assert.equal(hash(await services.download(release.zip)), release.zipSha256, 'Published download mismatch');
    for (const file of release.files) assert.equal(await digest(path.join(root, file.path)), file.after, `Published file mismatch: ${file.path}`);
    await preserve();
    check(); await services.restartScheduler();
    const afterProcesses = await services.processes();
    for (const old of beforeProcesses) {
      const current = afterProcesses.find(p => p.name === old.name);
      assert.ok(current, `Missing process: ${old.name}`);
      assert.equal(current.status, old.status, `Process state: ${old.name}`);
      if (affectedProcesses.includes(old.name)) assert.notEqual(current.pid, old.pid, `Process was not restarted: ${old.name}`);
      else assert.equal(current.pid, old.pid, `Unrelated process changed: ${old.name}`);
    }
    const result = {published: true, commit: release.commit, version: release.version, zipSha256: release.zipSha256,
      preservedSha256: release.preservedSha256, beforeProcesses, afterProcesses, idle, at: new Date().toISOString()};
    await receipt('published.json', result);
    return result;
  } catch (error) {
    const failures = [];
    // Stop scheduling while restoring a release that had already resumed it.
    if (schedulerTouched) { try { await services.stopScheduler(); } catch (e) { failures.push(`Stop scheduler: ${e.message}`); } }
    for (const file of [...changed].reverse()) {
      try {
        assert.equal(await digest(path.join(root, file.path)), file.after, 'Concurrent drift during rollback');
        const backup = path.join(stage, 'backup', file.path);
        assert.equal(await digest(backup), file.before, 'Backup drift during rollback');
        await atomicCopy(backup, path.join(root, file.path));
      } catch (e) { failures.push(`${file.path}: ${e.message}`); }
    }
    if (packageAdded) {
      try { assert.equal(await digest(targetZip), release.zipSha256, 'Package drift'); await fs.unlink(targetZip); }
      catch (e) { failures.push(e.message); }
    }
    if (apiTouched) {
      try { await services.restartApi(); await services.health(); assert.equal((await services.manifest()).latestVersion, release.previous); }
      catch (e) { failures.push(`API rollback: ${e.message}`); }
    }
    if (schedulerTouched) { try { await services.restartScheduler(); } catch (e) { failures.push(`Scheduler rollback: ${e.message}`); } }
    try { await preserve(); } catch (e) { failures.push(e.message); }
    await receipt('rollback.json', {cause: error.message, restored: failures.length === 0, failures});
    throw new Error(`${error.message}; rollback ${failures.length ? failures.join('; ') : 'verified'}`);
  } finally { await fs.rmdir(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(['--check', '--apply'].includes(process.argv[2]), 'Use --check or --apply');
  assert.equal(process.versions.node, '24.21.0', 'Unexpected production runtime');
  const stage = path.dirname(fileURLToPath(import.meta.url));
  const release = JSON.parse(await fs.readFile(path.join(stage, 'release.json'), 'utf8'));
  let interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
  const command = (bin, args, options = {}) => execFileSync(bin, args, {encoding: 'utf8', timeout: 45000, maxBuffer: 10e6, stdio: ['pipe', 'pipe', 'pipe'], ...options});
  const get = async url => { const response = await fetch(url, {signal: AbortSignal.timeout(10000), headers: {'cache-control': 'no-cache'}}); assert.equal(response.status, 200, url); return response; };
  const processes = async () => JSON.parse(command('pm2', ['jlist'])).map(p => ({name: p.name, pid: p.pid, status: p.pm2_env.status, entry: p.pm2_env.pm_exec_path, restarts: p.pm2_env.restart_time}));
  const assertIdle = async () => {
    const sql = `BEGIN READ ONLY; SET LOCAL statement_timeout='3s';
      SELECT json_build_object('checkedAt',now(),
        'activeTasks',(SELECT count(*) FROM capture_tasks WHERE task_type <> 'capture_orchestration'
          AND status IN ('claimed','running','recovering','resume_requested','dispatch_pending','dispatched','assigned','pending','queued','waiting_device')),
        'pendingCommands',(SELECT count(*) FROM capture_agent_commands WHERE status IN ('pending','acknowledged') AND expires_at>now()),
        'androidHeldItems',(SELECT count(*) FROM capture_task_items i JOIN capture_agents a ON a.id=i.assigned_agent_id
          WHERE a.capabilities->>'agentKind'='android_mobile' AND i.metadata->>'deviceHeld'='true'));
      ROLLBACK;`;
    const value = JSON.parse(command('runuser', ['-u', 'postgres', '--', 'psql', '-qXAt', '-d', 'onstarvoice', '-v', 'ON_ERROR_STOP=1'], {input: sql, timeout: 10000}).trim());
    for (const field of ['activeTasks', 'pendingCommands', 'androidHeldItems']) assert.equal(value[field], 0, `${field} blocks deployment`);
    return value;
  };
  const services = {
    health: async () => {
      const value = await (await get('http://127.0.0.1:3002/api/health/ready')).json();
      assert.equal(value.ok, true); assert.equal(value.status, 'ready'); assert.equal(value.role, 'api');
      assert.equal((await (await get('https://voice.minilife.online/api/health')).json()).ok, true);
    },
    manifest: async () => { const value = await (await get('http://127.0.0.1:3002/api/update-manifest')).json(); return value.data?.updateManifest || value.updateManifest || value; },
    download: async zip => Buffer.from(await (await get(`https://voice.minilife.online/downloads/${zip}`)).arrayBuffer()),
    processes, assertIdle,
    stopScheduler: async () => { command('pm2', ['stop', 'onstarvoice-scheduler']); assert.equal((await processes()).find(p => p.name === 'onstarvoice-scheduler')?.status, 'stopped'); },
    restartApi: async () => {
      command('pm2', ['restart', 'onstarvoice-api']);
      for (let i = 0; i < 30; i++) { try { await services.health(); return; } catch { await delay(500); } }
      throw new Error('API readiness timeout');
    },
    restartScheduler: async () => {
      command('pm2', ['restart', 'onstarvoice-scheduler']);
      await delay(2500);
      const current = (await processes()).find(p => p.name === 'onstarvoice-scheduler');
      assert.equal(current?.status, 'online'); assert.ok(current.pid > 0);
      assert.equal(current.entry, '/opt/onstarvoice/server/entrypoints/scheduler.js');
    },
  };
  const live = await processes();
  for (const role of ['api', 'scheduler', 'ai-media']) assert.equal(live.find(p => p.name === `onstarvoice-${role}`)?.entry, `/opt/onstarvoice/server/entrypoints/${role}.js`);
  console.log(JSON.stringify(await deploy({root: '/opt/onstarvoice', stage, release, services, checkOnly: process.argv[2] === '--check', interrupted: () => interrupted}), null, 2));
}
