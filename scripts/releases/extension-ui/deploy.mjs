// Narrow 0.4.24 metadata/package release. No database or capture-node operations.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

export const metadataPaths = ['server/routes/update-manifest.js', 'server/public/about.html', 'server/services/ops-control.js'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const regular = async file => { if (!(await fs.lstat(file)).isFile()) throw new Error(`Not a regular file: ${file}`); };
async function atomicCopy(source, target) {
  const temporary = `${target}.ui-0424-stage`;
  await fs.copyFile(source, temporary, 1);
  await fs.chmod(temporary, 0o644);
  await fs.rename(temporary, target);
}

export async function deploy({root, stage, release, services, checkOnly = false, interrupted = () => false}) {
  if (release.version !== '0.4.24' || release.previous !== '0.4.23' || !/^[0-9a-f]{40}$/.test(release.commit)) throw new Error('Invalid release identity');
  if (JSON.stringify(release.files.map(f => f.path)) !== JSON.stringify(metadataPaths)) throw new Error('Unexpected release surface');
  if (release.zip !== 'StarVoice-extension-v0.4.24-20261014.zip') throw new Error('Unexpected package');
  const targetZip = path.join(root, 'public-downloads', release.zip);
  const stageZip = path.join(stage, release.zip);
  await regular(stageZip);
  if (hash(await fs.readFile(stageZip)) !== release.zipSha256) throw new Error('Package hash mismatch');
  try { await fs.lstat(targetZip); throw new Error('Package already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const file of release.files) {
    const current = path.join(root, file.path), next = path.join(stage, 'payload', file.path);
    await regular(current); await regular(next);
    if (hash(await fs.readFile(current)) !== file.before || hash(await fs.readFile(next)) !== file.after) throw new Error(`File drift: ${file.path}`);
  }
  const oldOps = await fs.readFile(path.join(root, metadataPaths[2]), 'utf8');
  const newOps = await fs.readFile(path.join(stage, 'payload', metadataPaths[2]), 'utf8');
  if (oldOps.replace("OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.23'", "OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.24'") !== newOps) throw new Error('Ops change exceeds version metadata');
  await services.health();
  const beforeManifest = await services.manifest();
  if (beforeManifest.latestVersion !== release.previous || beforeManifest.minSupportedVersion !== '0.3.51') throw new Error('Unexpected live manifest');
  const beforeProcesses = await services.processes();
  for (const name of ['onstarvoice-api', 'onstarvoice-scheduler', 'onstarvoice-ai-media']) {
    if (!beforeProcesses.some(p => p.name === name && p.status === 'online')) throw new Error(`Process unavailable: ${name}`);
  }
  if (checkOnly) return {checked: true, version: release.version, beforeProcesses};
  const lock = path.join(root, '.extension-ui-release.lock');
  await fs.mkdir(lock);
  const changed = [];
  let packageAdded = false;
  const check = () => { if (interrupted()) throw new Error('Release interrupted'); };
  const receipt = (name, data) => fs.writeFile(path.join(stage, name), JSON.stringify(data, null, 2) + '\n');
  try {
    await receipt('before.json', {commit: release.commit, beforeManifest, beforeProcesses});
    for (const file of release.files) {
      const backup = path.join(stage, 'backup', file.path);
      await fs.mkdir(path.dirname(backup), {recursive: true});
      await fs.copyFile(path.join(root, file.path), backup, 1);
      if (hash(await fs.readFile(backup)) !== file.before) throw new Error('Backup drift');
    }
    check();
    const stagedZip = `${targetZip}.ui-0424-stage`;
    await fs.copyFile(stageZip, stagedZip, 1);
    await fs.chmod(stagedZip, 0o644);
    // Link is atomic and refuses to replace an existing public package.
    await fs.link(stagedZip, targetZip); packageAdded = true;
    await fs.unlink(stagedZip);
    for (const file of release.files) {
      check();
      if (hash(await fs.readFile(path.join(root, file.path))) !== file.before) throw new Error('Concurrent metadata change');
      await atomicCopy(path.join(stage, 'payload', file.path), path.join(root, file.path));
      changed.push(file);
    }
    check(); await services.restartApi(); await services.health(); check();
    const manifest = await services.manifest();
    if (manifest.latestVersion !== release.version || manifest.minSupportedVersion !== '0.3.51' || manifest.downloadUrl !== `https://voice.minilife.online/downloads/${release.zip}`) throw new Error('Published manifest mismatch');
    if (hash(await services.download(release.zip)) !== release.zipSha256) throw new Error('Published download mismatch');
    for (const file of release.files) if (hash(await fs.readFile(path.join(root, file.path))) !== file.after) throw new Error('Published file mismatch');
    const afterProcesses = await services.processes();
    for (const old of beforeProcesses.filter(p => p.name !== 'onstarvoice-api')) {
      const current = afterProcesses.find(p => p.name === old.name);
      if (!current || current.pid !== old.pid || current.status !== old.status) throw new Error(`Unrelated process changed: ${old.name}`);
    }
    const result = {published: true, commit: release.commit, version: release.version, zipSha256: release.zipSha256, beforeProcesses, afterProcesses, at: new Date().toISOString()};
    await receipt('published.json', result);
    return result;
  } catch (error) {
    const failures = [];
    for (const file of [...changed].reverse()) {
      try {
        if (hash(await fs.readFile(path.join(root, file.path))) !== file.after) throw new Error('Concurrent drift during rollback');
        await atomicCopy(path.join(stage, 'backup', file.path), path.join(root, file.path));
      } catch (e) { failures.push(`${file.path}: ${e.message}`); }
    }
    if (packageAdded) {
      try { if (hash(await fs.readFile(targetZip)) !== release.zipSha256) throw new Error('Package drift'); await fs.unlink(targetZip); } catch (e) { failures.push(e.message); }
    }
    if (changed.length) {
      try { await services.restartApi(); await services.health(); if ((await services.manifest()).latestVersion !== release.previous) throw new Error('Rollback manifest mismatch'); } catch (e) { failures.push(e.message); }
    }
    await receipt('rollback.json', {cause: error.message, restored: failures.length === 0, failures});
    throw new Error(`${error.message}; rollback ${failures.length ? failures.join('; ') : 'verified'}`);
  } finally { await fs.rmdir(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!['--check', '--apply'].includes(process.argv[2])) throw new Error('Use --check or --apply');
  const stage = path.dirname(fileURLToPath(import.meta.url));
  const release = JSON.parse(await fs.readFile(path.join(stage, 'release.json'), 'utf8'));
  let interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
  const get = async pathname => { const response = await fetch(`http://127.0.0.1:3002${pathname}`, {signal: AbortSignal.timeout(10000)}); if (!response.ok) throw new Error(`HTTP ${response.status}: ${pathname}`); return response; };
  const services = {
    health: async () => { if (!(await (await get('/api/health/ready')).json()).ok) throw new Error('Not ready'); },
    manifest: async () => (await get('/api/update-manifest')).json(),
    download: async zip => Buffer.from(await (await get(`/downloads/${zip}`)).arrayBuffer()),
    processes: async () => JSON.parse(execFileSync('pm2', ['jlist'], {encoding: 'utf8', maxBuffer: 10e6})).map(p => ({name: p.name, pid: p.pid, status: p.pm2_env.status})),
    restartApi: async () => {
      execFileSync('pm2', ['restart', 'onstarvoice-api'], {stdio: 'pipe'});
      for (let i = 0; i < 30; i++) { try { await services.health(); return; } catch { await delay(1000); } }
      throw new Error('API readiness timeout');
    },
  };
  console.log(JSON.stringify(await deploy({root: '/opt/onstarvoice', stage, release, services, checkOnly: process.argv[2] === '--check', interrupted: () => interrupted}), null, 2));
}
