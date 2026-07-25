import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import updateManifestRouter, {
  EXTENSION_UPDATE_MANIFEST,
} from '../server/routes/update-manifest.js';

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
);

test('extension update manifest matches the packaged source version', () => {
  assert.equal(EXTENSION_UPDATE_MANIFEST.latestVersion, manifest.version);
  assert.match(
    EXTENSION_UPDATE_MANIFEST.downloadUrl,
    new RegExp(`v${manifest.version.replaceAll('.', '\\.')}[^/]*\\.zip$`, 'u'),
  );
  assert.equal(
    EXTENSION_UPDATE_MANIFEST.releases[0]?.version,
    manifest.version,
  );
});

test('extension update endpoint returns the shape consumed by the sidebar', () => {
  const routeLayer = updateManifestRouter.stack.find(
    layer => layer?.route?.path === '/',
  );
  assert.ok(routeLayer, 'update manifest route is missing');

  let payload = null;
  routeLayer.route.stack[0].handle({}, {
    json(value) {
      payload = value;
      return value;
    },
  });

  assert.equal(payload?.ok, true);
  assert.deepEqual(
    payload?.data?.updateManifest,
    EXTENSION_UPDATE_MANIFEST,
  );
  assert.equal(payload?.latestVersion, manifest.version);
});
