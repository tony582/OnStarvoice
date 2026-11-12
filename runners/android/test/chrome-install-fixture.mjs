import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {CFT_METADATA_URL, updateCrc32c} from '../src/preview/chrome-download.mjs';
import {CFT_APP, CFT_EXECUTABLE} from '../src/preview/chrome-cache.mjs';

export const VERSION = '150.0.1234.5'; // Deliberately fixed test metadata; never a claimed live release.
const exec = promisify(execFile);
export function zipFixture(entries) {
  const script = `import base64,io,json,stat,sys,zipfile
data=json.load(sys.stdin)
target=io.BytesIO()
with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED) as archive:
 for entry in data:
  info=zipfile.ZipInfo(entry['name'])
  info.create_system=3
  info.compress_type=zipfile.ZIP_DEFLATED
  info.external_attr=entry.get('mode',stat.S_IFREG|0o644)<<16
  archive.writestr(info,base64.b64decode(entry['data']))
sys.stdout.buffer.write(target.getvalue())`;
  return execFileSync('python3', ['-c', script], {input: JSON.stringify(entries.map(entry => ({...entry,
    data: Buffer.from(entry.data ?? '').toString('base64')}))), maxBuffer: 8 * 1024 * 1024});
}
export function chromeEntries(platform = 'mac-arm64', {bundleId = 'com.google.chrome.for.testing', version = VERSION} = {}) {
  const root = `chrome-${platform}/${CFT_APP}/Contents`;
  const macho = Buffer.alloc(64);
  macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeUInt32LE(platform === 'mac-arm64' ? 0x0100000c : 0x01000007, 4);
  return [
    {name: `${root}/Info.plist`, data: JSON.stringify({CFBundleIdentifier: bundleId, CFBundleExecutable: CFT_EXECUTABLE,
      CFBundleShortVersionString: version, CFBundlePackageType: 'APPL'})},
    {name: `${root}/MacOS/${CFT_EXECUTABLE}`, data: macho, mode: 0o100755},
    {name: `${root}/Frameworks/Example.framework/Versions/A/Example`, data: 'fixture library'},
    {name: `${root}/Frameworks/Example.framework/Versions/Current`, data: 'A', mode: 0o120777},
    {name: `${root}/Frameworks/Example.framework/Example`, data: 'Versions/Current/Example', mode: 0o120777},
  ];
}
export function archiveMetadata(zip, platform = 'mac-arm64') {
  const crc = Buffer.alloc(4); crc.writeUInt32BE((updateCrc32c(0xffffffff, zip) ^ 0xffffffff) >>> 0);
  return {bucket: 'chrome-for-testing-public', name: `${VERSION}/${platform}/chrome-${platform}.zip`,
    generation: '1700000000000001', size: String(zip.length), md5Hash: createHash('md5').update(zip).digest('base64'), crc32c: crc.toString('base64')};
}
export function fakeCftNetwork(zip, {platform = 'mac-arm64', mutateStable = () => {}, mutateObject = () => {}, archiveResponse, beforeFetch} = {}) {
  const calls = [], object = archiveMetadata(zip, platform);
  mutateObject(object);
  const stable = {channels: {Stable: {version: VERSION, downloads: {chrome: [{platform,
    url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${platform}/chrome-${platform}.zip`}]}}}};
  mutateStable(stable);
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assertRequest(options);
    await beforeFetch?.(url);
    if (url === CFT_METADATA_URL) return new Response(JSON.stringify(stable));
    if (url.startsWith('https://storage.googleapis.com/storage/v1/')) return new Response(JSON.stringify(object));
    if (url.startsWith('https://storage.googleapis.com/download/storage/v1/')) {
      if (archiveResponse) return archiveResponse(url, options);
      return new Response(zip, {headers: {'content-length': String(zip.length), 'x-goog-generation': object.generation}});
    }
    throw new Error(`Unexpected fake request ${url}`);
  };
  return {fetchImpl, calls, object};
}
function assertRequest(options) {
  if (options.redirect !== 'manual' || options.headers['accept-encoding'] !== 'identity') throw new Error('unsafe request options');
}

/** The extractor uses real Python; all macOS tools/browser execution are explicit fakes. */
export function fakeBrowserTools({signature = 'ad-hoc', verifyFails = false, version = VERSION, onVersion} = {}) {
  const calls = [];
  const runImpl = async (command, args, options) => {
    calls.push([command, args]);
    if (command === 'python3') return exec(command, args, options);
    if (command === '/usr/bin/plutil') return {stdout: await readFile(args.at(-1), 'utf8'), stderr: ''};
    if (command === '/usr/bin/codesign') {
      if (args[0] === '--display') {
        if (signature === 'unsigned') throw Object.assign(new Error('not signed'), {stderr: 'code object is not signed at all'});
        return {stdout: '', stderr: signature === 'ad-hoc' ? 'Signature=adhoc\n' : signature === 'certificate' ? 'Authority=Fixture issuer\n' : 'unknown'};
      }
      if (verifyFails) throw new Error('fixture invalid signature');
      return {stdout: '', stderr: ''};
    }
    if (command.endsWith(`/Contents/MacOS/${CFT_EXECUTABLE}`) && args.length === 1 && args[0] === '--version') {
      await onVersion?.(command);
      return {stdout: `${CFT_EXECUTABLE} ${version}\n`, stderr: ''};
    }
    throw new Error(`Unexpected executable ${command}`);
  };
  return {runImpl, calls};
}
