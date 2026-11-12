import {mkdir, mkdtemp, lstat, open, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromeInstallRoot, chromeInstallPaths, chromePlatform, executableAvailable, isManagedChromePath, readInstalledChrome, resolvePreviewChrome} from './chrome-cache.mjs';
import {ChromeInstallError, chromeReleaseMetadata, downloadChromeArchive} from './chrome-download.mjs';
import {runBrowserTool, verifyChromeApplication} from './chrome-verify.mjs';

const EXTRACTOR = fileURLToPath(new URL('../../tools/browser/extract-chrome.py', import.meta.url));

async function privateDirectory(directory) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ChromeInstallError('chrome_install_path_unsafe');
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, {force: true}); }
}

/** Called only from explicit setup/enable-wechat. Normal preview startup never installs. */
export async function installChromeForTesting({homeDir, platform, arch, fetchImpl = globalThis.fetch,
  runImpl = runBrowserTool, python = 'python3', metadataTimeoutMs = 15_000, downloadTimeoutMs = 300_000,
  onProgress = () => {}} = {}) {
  const targetPlatform = chromePlatform({platform, arch});
  const cached = readInstalledChrome({homeDir, platform: targetPlatform});
  if (cached) return {...cached, installed: false};
  const root = chromeInstallRoot(homeDir);
  await privateDirectory(root);
  let staging;
  try {
    // Check local prerequisites before downloading a large archive.
    let pythonVersion;
    try { pythonVersion = (await runImpl(python, ['--version'], {timeout: 10_000, maxBuffer: 4096})).stdout; }
    catch { throw new ChromeInstallError('chrome_python_required'); }
    const match = /^Python 3\.(\d+)\./u.exec(String(pythonVersion).trim());
    if (!match || Number(match[1]) < 9) throw new ChromeInstallError('chrome_python_required');
    onProgress('正在准备独立预览浏览器');
    const release = await chromeReleaseMetadata({platform: targetPlatform, fetchImpl, timeoutMs: metadataTimeoutMs});
    const paths = chromeInstallPaths(root, release.version, targetPlatform);
    const existing = readInstalledChrome({homeDir, platform: targetPlatform, version: release.version});
    if (existing) {
      await atomicJson(paths.current, {version: release.version, platform: targetPlatform});
      return {...existing, installed: false};
    }
    // Never overwrite an existing installation, including an unverified one.
    try { await lstat(paths.directory); throw new ChromeInstallError('chrome_install_existing_invalid'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    staging = await mkdtemp(join(root, '.install-'));
    const archive = join(staging, 'browser.zip'), extracted = join(staging, 'extracted');
    await mkdir(extracted, {mode: 0o700});
    onProgress('正在下载并校验独立预览浏览器');
    const checksums = await downloadChromeArchive(release, archive, {fetchImpl, timeoutMs: downloadTimeoutMs});
    let extraction;
    try {
      const result = await runImpl(python, [EXTRACTOR, archive, extracted, targetPlatform], {timeout: 180_000, maxBuffer: 16 * 1024});
      extraction = JSON.parse(result.stdout);
      if (!Number.isInteger(extraction.files) || extraction.files < 1) throw new Error('invalid extraction receipt');
    } catch { throw new ChromeInstallError('chrome_archive_unsafe'); }
    const verified = await verifyChromeApplication({directory: extracted, platform: targetPlatform, version: release.version, runImpl});
    await writeFile(join(extracted, 'install.json'), JSON.stringify({schemaVersion: 1, verified: true,
      version: release.version, platform: targetPlatform, sourceUrl: release.sourceUrl, generation: release.generation,
      checksums, extraction, ...verified, verifiedAt: new Date().toISOString()}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    await privateDirectory(dirname(paths.directory));
    try { await rename(extracted, paths.directory); }
    catch (error) {
      // Each installer owns separate staging. A published version is non-empty,
      // so rename cannot replace it; the losing installer validates the winner.
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      const winner = readInstalledChrome({homeDir, platform: targetPlatform, version: release.version});
      if (!winner) throw new ChromeInstallError('chrome_install_existing_invalid');
      await atomicJson(paths.current, {version: release.version, platform: targetPlatform});
      return {...winner, installed: false};
    }
    // The pointer changes only after the whole version is present and verified.
    await atomicJson(paths.current, {version: release.version, platform: targetPlatform});
    onProgress('独立预览浏览器已准备好');
    return {path: paths.executable, source: 'managed', version: release.version, platform: targetPlatform, installed: true};
  } finally {
    if (staging) await rm(staging, {recursive: true, force: true});
  }
}

/** Installation failure preserves an available system-browser fallback, with one warning. */
export async function preparePreviewChrome({chromePath, install = installChromeForTesting, ...options} = {}) {
  if (chromePath && !isManagedChromePath(chromePath, options)) {
    const path = resolve(chromePath);
    if (!executableAvailable(path)) throw new ChromeInstallError('chrome_executable_unavailable');
    return {path, source: 'custom', installed: false};
  }
  if (chromePath) {
    const selected = resolvePreviewChrome({...options, chromePath, onWarning: () => {}, warningState: {shown: false}});
    if (selected.source === 'managed') return {...selected, installed: false};
  }
  try { return await install(options); }
  catch (error) {
    const fallback = resolvePreviewChrome(options);
    if (!executableAvailable(fallback.path)) throw error;
    return {...fallback, installed: false, installError: error.code || 'chrome_install_failed'};
  }
}
