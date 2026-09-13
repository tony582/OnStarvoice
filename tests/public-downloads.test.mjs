import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createPublicDownloadsRouter } from '../server/routes/public-downloads.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const express = require('express');
const packageName = 'StarVoice-extension-v0.4.10-20260912.zip';

test('public downloads serve packages while keeping deployment files private', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'starvoice-public-downloads-'));
  const directory = join(temporary, 'public-downloads');
  await mkdir(directory);
  await mkdir(join(directory, 'v049-20260911'));
  await writeFile(join(directory, packageName), 'PK-test-extension-package');
  await writeFile(join(directory, 'release.py'), 'private deployment controller');
  await writeFile(join(directory, 'RELEASE_MANIFEST.json'), '{"private":true}');
  await writeFile(join(directory, 'application-patch.tar.gz'), 'private backend code');
  await writeFile(join(directory, 'v049-20260911', 'release.py'), 'private nested controller');
  await writeFile(join(directory, 'v049-20260911', packageName), 'nested package');
  await writeFile(join(temporary, 'secret.txt'), 'private outside root');
  const linkedPackage = 'StarVoice-extension-v0.4.9-20260911.zip';
  await symlink(join(temporary, 'secret.txt'), join(directory, linkedPackage));

  const app = express();
  app.use('/downloads', createPublicDownloadsRouter(directory));
  const linkedRoot = join(temporary, 'linked-root');
  await symlink(directory, linkedRoot);
  app.use('/linked-downloads', createPublicDownloadsRouter(linkedRoot));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  });
  const request = (path, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });

  await t.test('anonymous GET, HEAD, range and conditional requests still work', async () => {
    const get = await request(`/downloads/${packageName}?source=update`);
    assert.equal(get.status, 200);
    assert.equal(get.body, 'PK-test-extension-package');
    assert.match(get.headers['content-type'], /application\/zip/u);
    assert.equal(get.headers['x-content-type-options'], 'nosniff');
    const head = await request(`/downloads/${packageName}`, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    const range = await request(`/downloads/${packageName}`, 'GET', { Range: 'bytes=0-1' });
    assert.equal(range.status, 206);
    assert.equal(range.body, 'PK');
    const cached = await request(`/downloads/${packageName}`, 'GET', { 'If-None-Match': get.headers.etag });
    assert.equal(cached.status, 304);
  });

  for (const path of [
    '/downloads', '/downloads/', '/downloads/release.py', '/downloads/RELEASE_MANIFEST.json',
    '/downloads/application-patch.tar.gz', '/downloads/v049-20260911/release.py',
    `/downloads/v049-20260911/${packageName}`, '/downloads/.env',
    '/downloads/%2e%2e/secret.txt', '/downloads/..%2fsecret.txt',
    '/downloads/%2e%2e%5csecret.txt', '/downloads/%252e%252e%252fsecret.txt',
    '/downloads//release.py', '/DOWNLOADS/release.py', '/downloads/release.py%00.zip',
    `/downloads/${linkedPackage}`, '/downloads/StarVoice-extension-v9.9.9-20260913.zip',
  ]) {
    await t.test(`rejects ${path}`, async () => {
      const response = await request(path);
      assert.equal(response.status, 404);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.doesNotMatch(response.body, /private|deployment|secret|controller/u);
    });
  }

  await t.test('does not serve packages through write methods', async () => {
    assert.equal((await request(`/downloads/${packageName}`, 'POST')).status, 404);
  });

  await t.test('rejects a download root replaced by a symbolic link', async () => {
    assert.equal((await request(`/linked-downloads/${packageName}`)).status, 404);
  });
});
