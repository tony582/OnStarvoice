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
    /停止任务后不再残留采集辅助[\s\S]*下一个无人值守任务[\s\S]*自动搜索不再误入小红书 AI 搜索页[\s\S]*\/search_result_ai[\s\S]*时间筛选失败写明原因[\s\S]*页面脚本调用失败[\s\S]*等待时间和校验规则与 0\.4\.14 相同/u,
  );
  // 0.4.15 ships the reduced time-filter change only; the result wait stays at
  // 0.4.14's 8 s, and none of the dropped attempts' behaviour (longer wait,
  // remount handling, re-check, not-ready) is promised. A content-script
  // failure is described as 调用失败, never as 无响应.
  assert.doesNotMatch(
    JSON.stringify(EXTENSION_UPDATE_MANIFEST.releases[0]?.releaseNotes),
    /15 秒|20 秒|延长|重新挂载|复核|重挂|未就绪|无响应/u,
  );
  assert.match(aboutHtml, /停止任务后不再残留采集辅助[\s\S]*下一个无人值守任务[\s\S]*\/search_result_ai[\s\S]*失败原因可见[\s\S]*页面脚本调用失败[\s\S]*扩展 v0\.4\.14</u);
  assert.doesNotMatch(aboutHtml.slice(0, aboutHtml.indexOf('扩展 v0.4.14<')), /15 秒|20 秒|延长|重新挂载|复核|重挂|未就绪|无响应/u);
  assert.match(
    JSON.stringify(EXTENSION_UPDATE_MANIFEST.releases.find(release => release.version === '0.4.14')?.releaseNotes),
    /安卓手机搜索发现[\s\S]*补采完成后自动关页[\s\S]*正文与作者显示/u,
  );
  assert.match(
    JSON.stringify(EXTENSION_UPDATE_MANIFEST.releases.find(release => release.version === '0.4.12')?.releaseNotes),
    /无人值守采集不再误判旧运行页[\s\S]*失败上报保留错误码/u,
  );
  assert.match(
    JSON.stringify(EXTENSION_UPDATE_MANIFEST.releases.find(release => release.version === '0.4.11')?.releaseNotes),
    /抖音正文提及[\s\S]*关键词逐节点采集/u,
  );
  assert.match(
    JSON.stringify(EXTENSION_UPDATE_MANIFEST.releases.find(release => release.version === '0.4.10')?.releaseNotes),
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
  assert.equal(EXTENSION_UPDATE_MANIFEST.releases[1]?.version, '0.4.14');
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
