import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {CFT_VERSION} from './chrome-cache.mjs';

export const CFT_METADATA_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const BUCKET = 'chrome-for-testing-public';
export const MAX_CHROME_ARCHIVE_BYTES = 512 * 1024 * 1024;
const CRC32C_TABLE = Uint32Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0x82f63b78 : 0);
  return value >>> 0;
});
export class ChromeInstallError extends Error {
  constructor(code) { super(code); this.name = 'ChromeInstallError'; this.code = code; }
}

export function updateCrc32c(crc, buffer) {
  for (const byte of buffer) crc = CRC32C_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}
function crcBase64(crc) { const bytes = Buffer.alloc(4); bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return bytes.toString('base64'); }
function checksumValid(value, bytes) {
  return typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
    && Buffer.from(value, 'base64').length === bytes && Buffer.from(value, 'base64').toString('base64') === value;
}
function officialUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) return false;
  return parsed.href === CFT_METADATA_URL || (parsed.hostname === 'storage.googleapis.com'
    && ['/storage/v1/b/', '/download/storage/v1/b/'].some(prefix => parsed.pathname.startsWith(`${prefix}${BUCKET}/o/`)));
}

/** No redirects; one deadline includes response headers, the body and each awaited write. */
async function readOfficial(url, {fetchImpl, timeoutMs, maxBytes, onHeaders = () => {}, onChunk}) {
  if (!officialUrl(url)) throw new ChromeInstallError('chrome_download_url_invalid');
  const controller = new AbortController();
  let rejectAbort, reader;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const timer = setTimeout(() => { const error = new ChromeInstallError('chrome_download_timeout'); controller.abort(error); rejectAbort(error); }, timeoutMs);
  const bounded = promise => Promise.race([promise, aborted]);
  try {
    const response = await bounded(fetchImpl(url, {redirect: 'manual', signal: controller.signal, headers: {'accept-encoding': 'identity'}}));
    if (response.status !== 200 || (response.url && response.url !== url) || !response.body) throw new ChromeInstallError('chrome_download_response_invalid');
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw new ChromeInstallError('chrome_download_encoding_invalid');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) {
      throw new ChromeInstallError('chrome_download_too_large');
    }
    onHeaders(response.headers);
    reader = response.body.getReader();
    let size = 0;
    for (;;) {
      const {done, value} = await bounded(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ChromeInstallError('chrome_download_too_large');
      await bounded(onChunk(Buffer.from(value)));
    }
    if (declared !== null && Number(declared) !== size) throw new ChromeInstallError('chrome_download_size_mismatch');
    return size;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

async function readJson(url, options) {
  const chunks = [];
  await readOfficial(url, {...options, maxBytes: 1024 * 1024, onChunk: chunk => chunks.push(chunk)});
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ChromeInstallError('chrome_download_metadata_invalid'); }
}

export async function chromeReleaseMetadata({platform, fetchImpl = globalThis.fetch, timeoutMs = 15_000} = {}) {
  if (!['mac-arm64', 'mac-x64'].includes(platform)) throw new ChromeInstallError('chrome_platform_unsupported');
  const data = await readJson(CFT_METADATA_URL, {fetchImpl, timeoutMs});
  const stable = data?.channels?.Stable, version = stable?.version;
  if (!CFT_VERSION.test(version ?? '')) throw new ChromeInstallError('chrome_download_metadata_invalid');
  const objectName = `${version}/${platform}/chrome-${platform}.zip`;
  const sourceUrl = `https://storage.googleapis.com/${BUCKET}/${objectName}`;
  const downloads = stable?.downloads?.chrome;
  if (!Array.isArray(downloads) || downloads.filter(item => item?.platform === platform && item?.url === sourceUrl).length !== 1
    || downloads.filter(item => item?.platform === platform).length !== 1) throw new ChromeInstallError('chrome_download_metadata_invalid');
  const metadataUrl = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(objectName)}?fields=bucket,name,generation,size,md5Hash,crc32c`;
  const object = await readJson(metadataUrl, {fetchImpl, timeoutMs});
  const size = Number(object.size);
  if (object.bucket !== BUCKET || object.name !== objectName || !/^\d{1,30}$/u.test(object.generation ?? '')
    || !/^\d+$/u.test(object.size ?? '') || !Number.isSafeInteger(size) || size < 1 || size > MAX_CHROME_ARCHIVE_BYTES
    || !(checksumValid(object.md5Hash, 16) || checksumValid(object.crc32c, 4))) throw new ChromeInstallError('chrome_download_metadata_invalid');
  if ((object.md5Hash && !checksumValid(object.md5Hash, 16)) || (object.crc32c && !checksumValid(object.crc32c, 4))) throw new ChromeInstallError('chrome_download_metadata_invalid');
  return {version, platform, sourceUrl, objectName, generation: object.generation, size,
    md5: object.md5Hash || null, crc32c: object.crc32c || null,
    downloadUrl: `https://storage.googleapis.com/download/storage/v1/b/${BUCKET}/o/${encodeURIComponent(objectName)}?alt=media&generation=${object.generation}`};
}

export async function downloadChromeArchive(release, target, {fetchImpl = globalThis.fetch, timeoutMs = 300_000} = {}) {
  if (!(release.size > 0 && release.size <= MAX_CHROME_ARCHIVE_BYTES)) throw new ChromeInstallError('chrome_download_too_large');
  if (!(checksumValid(release.md5, 16) || checksumValid(release.crc32c, 4))) throw new ChromeInstallError('chrome_download_metadata_invalid');
  const file = await open(target, 'wx', 0o600);
  const md5 = createHash('md5'), sha256 = createHash('sha256');
  let crc = 0xffffffff;
  try {
    const size = await readOfficial(release.downloadUrl, {fetchImpl, timeoutMs, maxBytes: release.size,
      onHeaders: headers => {
        if (headers.get('x-goog-generation') !== release.generation) throw new ChromeInstallError('chrome_download_generation_mismatch');
      },
      onChunk: async chunk => { md5.update(chunk); sha256.update(chunk); crc = updateCrc32c(crc, chunk); await file.writeFile(chunk); }});
    if (size !== release.size) throw new ChromeInstallError('chrome_download_size_mismatch');
    const actualMd5 = md5.digest('base64'), actualCrc = crcBase64(crc);
    if ((release.md5 && actualMd5 !== release.md5) || (release.crc32c && actualCrc !== release.crc32c)) throw new ChromeInstallError('chrome_download_checksum_mismatch');
    await file.sync();
    return {size, md5: actualMd5, crc32c: actualCrc, sha256: sha256.digest('hex')};
  } finally { await file.close(); }
}
