import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromeReleaseMetadata, downloadChromeArchive, updateCrc32c, MAX_CHROME_ARCHIVE_BYTES} from '../src/preview/chrome-download.mjs';
import {fakeCftNetwork, VERSION} from './chrome-install-fixture.mjs';

async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'chrome-download-test-')); t.after(() => rm(dir, {recursive: true, force: true})); return dir; }
const platform = 'mac-arm64';
test('CRC32C matches the independent Castagnoli check vector', () => {
  assert.equal((updateCrc32c(0xffffffff, Buffer.from('123456789')) ^ 0xffffffff) >>> 0, 0xe3069283);
});
test('stable metadata selects each architecture and generation-pins a verified complete download', async t => {
  const dir = await temp(t), bytes = Buffer.from('small offline archive fixture');
  for (const platform of ['mac-arm64', 'mac-x64']) {
    const fake = fakeCftNetwork(bytes, {platform});
    const release = await chromeReleaseMetadata({platform, fetchImpl: fake.fetchImpl});
    assert.equal(release.version, VERSION);
    assert.match(release.downloadUrl, /generation=1700000000000001$/u);
    const file = join(dir, platform);
    const checksums = await downloadChromeArchive(release, file, {fetchImpl: fake.fetchImpl});
    assert.equal(checksums.md5, fake.object.md5Hash);
    assert.equal(checksums.crc32c, fake.object.crc32c);
    assert.deepEqual(await readFile(file), bytes);
    assert.equal(fake.calls.length, 3);
  }
});
test('metadata rejects wrong hosts, protocol, credentials, ports, duplicated architecture and version traversal', async () => {
  for (const url of ['http://storage.googleapis.com/a', 'https://evil.invalid/a', 'https://storage.googleapis.com:444/a',
    'https://user:pass@storage.googleapis.com/a', 'https://storage.googleapis.com/chrome-for-testing-public/other.zip']) {
    const fake = fakeCftNetwork(Buffer.from('x'), {mutateStable: data => { data.channels.Stable.downloads.chrome[0].url = url; }});
    await assert.rejects(chromeReleaseMetadata({platform, fetchImpl: fake.fetchImpl}), {code: 'chrome_download_metadata_invalid'});
    assert.equal(fake.calls.length, 1);
  }
  for (const mutateStable of [data => {data.channels.Stable.version = '../150';},
    data => {data.channels.Stable.downloads.chrome.push(data.channels.Stable.downloads.chrome[0]);}]) {
    const fake = fakeCftNetwork(Buffer.from('x'), {mutateStable});
    await assert.rejects(chromeReleaseMetadata({platform, fetchImpl: fake.fetchImpl}), {code: 'chrome_download_metadata_invalid'});
  }
});
test('object metadata requires exact identity, bounded size and a canonical server checksum', async () => {
  for (const mutateObject of [value => {value.bucket = 'other';}, value => {value.name = 'other';}, value => {value.generation = 'bad';},
    value => {value.size = String(MAX_CHROME_ARCHIVE_BYTES + 1);}, value => {value.size = '0';},
    value => {delete value.md5Hash; delete value.crc32c;}, value => {value.md5Hash = 'bad';}]) {
    const fake = fakeCftNetwork(Buffer.from('x'), {mutateObject});
    await assert.rejects(chromeReleaseMetadata({platform, fetchImpl: fake.fetchImpl}), {code: 'chrome_download_metadata_invalid'});
  }
});
test('either MD5 or CRC32C alone is sufficient, and a mismatching advertised checksum is refused', async t => {
  const dir = await temp(t);
  for (const removed of ['md5Hash', 'crc32c']) {
    const fake = fakeCftNetwork(Buffer.from('bytes'), {mutateObject: value => {delete value[removed];}});
    const release = await chromeReleaseMetadata({platform, fetchImpl: fake.fetchImpl});
    await downloadChromeArchive(release, join(dir, removed), {fetchImpl: fake.fetchImpl});
  }
  for (const field of ['md5Hash', 'crc32c']) {
    const fake = fakeCftNetwork(Buffer.from('bytes'), {mutateObject: value => {value[field] = Buffer.alloc(field === 'md5Hash' ? 16 : 4).toString('base64');}});
    const release = await chromeReleaseMetadata({platform, fetchImpl: fake.fetchImpl});
    await assert.rejects(downloadChromeArchive(release, join(dir, `bad-${field}`), {fetchImpl: fake.fetchImpl}), {code: 'chrome_download_checksum_mismatch'});
  }
});
test('redirects, wrong generation, changed encoding and size changes cannot become an installed archive', async t => {
  const dir = await temp(t), bytes = Buffer.from('bytes');
  for (const [name, archiveResponse, code] of [
    ['redirect', () => new Response(null, {status: 302, headers: {location: 'https://evil.invalid/browser.zip'}}), 'chrome_download_response_invalid'],
    ['generation', () => new Response(bytes, {headers: {'x-goog-generation': 'other'}}), 'chrome_download_generation_mismatch'],
    ['encoding', () => new Response(bytes, {headers: {'content-encoding': 'gzip'}}), 'chrome_download_encoding_invalid'],
    ['oversize', () => new Response(Buffer.alloc(6), {headers: {'x-goog-generation': '1700000000000001'}}), 'chrome_download_too_large'],
    ['truncated', () => new Response(Buffer.alloc(4), {headers: {'x-goog-generation': '1700000000000001'}}), 'chrome_download_size_mismatch'],
  ]) {
    const fake = fakeCftNetwork(bytes, {archiveResponse});
    const release = await chromeReleaseMetadata({platform, fetchImpl: fake.fetchImpl});
    await assert.rejects(downloadChromeArchive(release, join(dir, name), {fetchImpl: fake.fetchImpl}), {code});
    assert.equal(fake.calls.length, 3, 'a redirect is never followed');
  }
});
test('deadline covers stalled headers and a stalled response body, aborting the transfer', async t => {
  await assert.rejects(chromeReleaseMetadata({platform, fetchImpl: () => new Promise(() => {}), timeoutMs: 15}), {code: 'chrome_download_timeout'});
  const dir = await temp(t);
  let signal;
  const fake = fakeCftNetwork(Buffer.from('bytes'), {archiveResponse: (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({start(controller) {controller.enqueue(Buffer.from('b'));}}), {headers: {'x-goog-generation': '1700000000000001'}});
  }});
  const release = await chromeReleaseMetadata({platform, fetchImpl: fake.fetchImpl});
  await assert.rejects(downloadChromeArchive(release, join(dir, 'stalled'), {fetchImpl: fake.fetchImpl, timeoutMs: 15}), {code: 'chrome_download_timeout'});
  assert.equal(signal.aborted, true);
});
