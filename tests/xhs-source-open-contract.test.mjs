import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

import {buildXhsSourceOpenSearchQueries} from '../server/services/xhs-source-open.js';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Xiaohongshu original-link requests never expose a historical xsec href', () => {
  const triage = source('server/routes/triage.js');
  const service = source('server/services/xhs-source-open.js');
  const action = source('web/admin/src/components/shared/RecordSourceAction.tsx');

  assert.match(triage, /redactXhsRecordNavigation/);
  assert.match(service, /url: ''/);
  assert.match(service, /source_open_mode: 'agent_refresh'/);
  assert.match(service, /executionMode: 'source_open'/);
  assert.match(service, /searchQueries/);
  assert.doesNotMatch(service, /['"]xsec_token['"]/);
  assert.match(action, /if \(!isXhs\)/);
  assert.match(action, /source-open/);
  assert.match(action, /requestGeneration/);
});

test('Xiaohongshu source-open uses bounded, deduplicated title and keyword searches', () => {
  assert.deepEqual(buildXhsSourceOpenSearchQueries({
    title: ' 昂科威Plus使用感受 ',
    keyword: '功能使用',
    author_name: '到处闲逛的CaptainNick',
  }, '6a942033000000002102f2fa'), [
    '昂科威Plus使用感受',
    '功能使用',
  ]);
  assert.deepEqual(buildXhsSourceOpenSearchQueries({
    title: '同一个词',
    keyword: ' 同一个词 ',
    author_name: '重庆',
  }, '6a94c7c3000000002003b809'), [
    '同一个词',
    '重庆',
  ]);
});

test('0.4 Agent refreshes, validates and opens a fresh Xiaohongshu card URL locally', () => {
  const agent = source('utils/cloud-task-agent.js');
  const background = source('background.js');
  const content = source('utils/capture/keyword-search.js');
  const captureCloud = source('server/routes/capture-cloud.js');

  assert.match(agent, /xiaohongshuSourceOpenV1: true/);
  assert.match(background, /validatedFreshXhsSourceUrl/);
  assert.match(background, /url\.searchParams\.get\('xsec_token'\)/);
  assert.match(background, /inspectXhsSourceOpenPage/);
  assert.match(background, /source_open_probe_unavailable/);
  assert.match(background, /for \(let queryIndex = 0; queryIndex < searchQueries\.length/);
  assert.match(background, /source_unavailable/);
  assert.match(background, /url: searchUrl, active: true/);
  assert.match(content, /findXhsSourceNote/);
  assert.match(content, /String\(note\.noteId \|\| ""\).*=== targetId/s);
  assert.match(captureCloud, /createExecutionMode === 'source_open'/);
  assert.match(captureCloud, /xiaohongshuSourceOpenV1/);
});
