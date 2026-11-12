import {accessSync, constants, lstatSync, readFileSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join, relative, resolve, sep} from 'node:path';

export const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const CFT_APP = 'Google Chrome for Testing.app';
export const CFT_EXECUTABLE = 'Google Chrome for Testing';
export const CFT_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}\.\d{1,6}$/u;
const fallbackWarning = {shown: false};

export function chromePlatform({platform = process.platform, arch = process.arch} = {}) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw Object.assign(new Error('Unsupported preview browser platform'), {code: 'chrome_platform_unsupported'});
  // An x64 Node running under Rosetta deliberately selects the x64 browser.
  return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
}

export function chromeInstallRoot(homeDir = homedir()) {
  return join(resolve(homeDir), '.local', 'share', 'starvoice', 'chrome-for-testing');
}

export function chromeInstallPaths(root, version, platform) {
  if (!CFT_VERSION.test(version) || !['mac-arm64', 'mac-x64'].includes(platform)) throw new Error('Invalid preview browser version or platform');
  const directory = join(root, version, platform);
  const app = join(directory, `chrome-${platform}`, CFT_APP);
  return {directory, app, executable: join(app, 'Contents', 'MacOS', CFT_EXECUTABLE),
    receipt: join(directory, 'install.json'), current: join(root, `current-${platform}.json`)};
}

export function executableAvailable(path) {
  try { return lstatSync(path).isFile() && (accessSync(path, constants.X_OK), true); } catch { return false; }
}

export function isManagedChromePath(path, {homeDir} = {}) {
  return typeof path === 'string' && resolve(path).startsWith(chromeInstallRoot(homeDir) + sep);
}

export function readInstalledChrome({homeDir, platform, version} = {}) {
  try {
    const selectedPlatform = platform ?? chromePlatform();
    const root = chromeInstallRoot(homeDir);
    const pointer = version ? {version, platform: selectedPlatform}
      : JSON.parse(readFileSync(join(root, `current-${selectedPlatform}.json`), 'utf8'));
    if (pointer.platform !== selectedPlatform || !CFT_VERSION.test(pointer.version)) return null;
    const paths = chromeInstallPaths(root, pointer.version, selectedPlatform);
    const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'));
    if (receipt.schemaVersion !== 1 || receipt.verified !== true || receipt.version !== pointer.version
      || receipt.platform !== selectedPlatform || !/^[a-f0-9]{64}$/u.test(receipt.executableSha256 ?? '')) return null;
    // The app, version directory and receipt must not be redirected outside our private cache.
    if (!lstatSync(root).isDirectory() || !realpathSync(paths.executable).startsWith(realpathSync(root) + sep)
      || realpathSync(paths.directory) !== join(realpathSync(root), pointer.version, selectedPlatform) || !executableAvailable(paths.executable)
      || lstatSync(paths.executable).size > 64 * 1024 * 1024) return null;
    const digest = createHash('sha256').update(readFileSync(paths.executable)).digest('hex');
    if (digest !== receipt.executableSha256) return null;
    return {path: paths.executable, source: 'managed', version: receipt.version, platform: selectedPlatform};
  } catch { return null; }
}

export function warnPreviewFallback({onWarning = console.error, warningState = fallbackWarning} = {}) {
  if (!warningState.shown) {
    warningState.shown = true;
    onWarning('建议安装独立预览浏览器；当前暂用系统 Chrome。运行 enable-wechat 可安装。');
  }
}

/** Lookup is local only. Explicit --chrome paths remain an intentional override. */
export function resolvePreviewChrome({chromePath, chromeExplicit = false, homeDir, platform, arch, systemChrome = SYSTEM_CHROME, onWarning, warningState} = {}) {
  // Older connection.json files sometimes pinned the previous system default.
  // Only a newly explicit override may keep that default ahead of managed CfT.
  const managedPath = isManagedChromePath(chromePath, {homeDir});
  if (chromePath && !managedPath && (chromePath !== SYSTEM_CHROME || chromeExplicit)) return {path: chromePath, source: 'custom'};
  let installed;
  try {
    const selectedPlatform = chromePlatform({platform, arch});
    if (managedPath) {
      const [version, savedPlatform] = relative(chromeInstallRoot(homeDir), resolve(chromePath)).split(sep);
      if (CFT_VERSION.test(version) && savedPlatform === selectedPlatform) {
        const selected = readInstalledChrome({homeDir, platform: selectedPlatform, version});
        if (selected?.path === resolve(chromePath)) installed = selected;
      }
    }
    installed ??= readInstalledChrome({homeDir, platform: selectedPlatform});
  } catch { /* non-mac test host */ }
  if (installed) return installed;
  if (executableAvailable(systemChrome)) warnPreviewFallback({onWarning, warningState});
  return {path: systemChrome, source: 'system'};
}
