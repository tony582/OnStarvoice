import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile, lstat, readFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {CFT_APP, CFT_EXECUTABLE} from './chrome-cache.mjs';
import {ChromeInstallError} from './chrome-download.mjs';

export const runBrowserTool = promisify(execFile);
export async function verifyChromeApplication({directory, platform, version, runImpl = runBrowserTool}) {
  const app = join(directory, `chrome-${platform}`, CFT_APP);
  const executable = join(app, 'Contents', 'MacOS', CFT_EXECUTABLE);
  const info = JSON.parse((await runImpl('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')],
    {timeout: 15_000, maxBuffer: 64 * 1024})).stdout);
  if (info.CFBundleIdentifier !== 'com.google.chrome.for.testing' || info.CFBundleExecutable !== CFT_EXECUTABLE
    || info.CFBundleShortVersionString !== version || info.CFBundlePackageType !== 'APPL') throw new ChromeInstallError('chrome_application_identity_invalid');
  const stat = await lstat(executable);
  if (!stat.isFile() || stat.size < 32 || stat.size > 64 * 1024 * 1024 || !(stat.mode & 0o111)) throw new ChromeInstallError('chrome_executable_invalid');
  const bytes = await readFile(executable);
  // CfT ships one architecture per archive. Refuse scripts and a binary for the wrong machine.
  const cpu = platform === 'mac-arm64' ? 0x0100000c : 0x01000007;
  if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu) throw new ChromeInstallError('chrome_executable_architecture_invalid');
  let signature = 'unsigned';
  let details;
  try { details = await runImpl('/usr/bin/codesign', ['--display', '--verbose=4', executable], {timeout: 15_000, maxBuffer: 64 * 1024}); }
  catch (error) {
    if (!/code object is not signed at all/u.test(String(error.stderr || ''))) throw new ChromeInstallError('chrome_signature_inspection_failed');
  }
  if (details) {
    const output = `${details.stdout || ''}\n${details.stderr || ''}`;
    signature = /Signature=adhoc/u.test(output) ? 'ad-hoc' : /Authority=/u.test(output) ? 'certificate' : '';
    if (!signature) throw new ChromeInstallError('chrome_signature_unknown');
    // Some official CfT bundles omit resource seals. Verify the same unmodified
    // physical Mach-O outside the bundle; do not re-sign or alter quarantine.
    const standalone = join(directory, '.signature-check');
    await copyFile(executable, standalone);
    try { await runImpl('/usr/bin/codesign', ['--verify', '--strict', standalone], {timeout: 30_000, maxBuffer: 64 * 1024}); }
    catch { throw new ChromeInstallError('chrome_signature_invalid'); }
    finally { await rm(standalone, {force: true}); }
  }
  // Official unsigned x64 builds are authenticated by HTTPS + the generation-
  // pinned archive checksum, never by pretending that an ad-hoc signature is a publisher identity.
  if (signature === 'unsigned' && platform === 'mac-arm64') throw new ChromeInstallError('chrome_signature_missing');
  const actual = await runImpl(executable, ['--version'], {timeout: 15_000, maxBuffer: 16 * 1024});
  if (actual.stdout.trim() !== `Google Chrome for Testing ${version}`) throw new ChromeInstallError('chrome_executable_version_invalid');
  return {executableSha256: createHash('sha256').update(bytes).digest('hex'), signature, bundleId: info.CFBundleIdentifier};
}
