import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import updateManifestRouter, {
  EXTENSION_UPDATE_MANIFEST,
} from '../server/routes/update-manifest.js';
import {
  OPS_CONTROL_RUNTIME_BASELINE_VERSION,
} from '../server/services/ops-control.js';

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
);
const aboutHtml = await readFile(
  new URL('../server/public/about.html', import.meta.url),
  'utf8',
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
  assert.equal(OPS_CONTROL_RUNTIME_BASELINE_VERSION, manifest.version);
  assert.match(
    JSON.stringify(EXTENSION_UPDATE_MANIFEST.releases[0]?.releaseNotes),
    /抖音明确空结果[\s\S]*客户群助手试用/u,
  );
  assert.match(
    JSON.stringify(EXTENSION_UPDATE_MANIFEST.releases.find(release => release.version === '0.4.9')?.releaseNotes),
    /无人值守启动[\s\S]*多步采集[\s\S]*不可查看[\s\S]*日报支持主动再次发送/u,
  );
  assert.match(
    aboutHtml,
    new RegExp(`扩展 v${manifest.version.replaceAll('.', '\\.')}[^<]*<span class="date">${EXTENSION_UPDATE_MANIFEST.releaseDate}<\\/span><span class="pill">最新<\\/span>`, 'u'),
  );
  assert.equal(EXTENSION_UPDATE_MANIFEST.releases[1]?.version, '0.4.9');
  assert.match(JSON.stringify(EXTENSION_UPDATE_MANIFEST.releases.find(release => release.version === '0.4.8')?.releaseNotes), /半年内[\s\S]*不限时间[\s\S]*月历[\s\S]*邮件/u);
  assert.match(aboutHtml, /扩展 v0\.4\.7<span class="date">2026-09-08<\/span><\/h3>/u);
  assert.equal((aboutHtml.match(/<span class="pill">最新<\/span>/gu) || []).length, 1);
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
