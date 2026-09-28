import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const code = background.slice(background.indexOf('async function stopTargetedPostAttemptResources('),
  background.indexOf('async function applyTargetedPostTerminalNotice('));
async function run({workflow = 'discovered_post_capture', legacy = false,
  cleanup = {ok: true, removedCount: 1, tabId: 21}, after = 'missing', preserve = false} = {}) {
  const request = {id: 'r', attemptId: 'a', status: 'completed', runnerTabId: 11,
    workflow, platform: 'douyin', targets: [{url: 'https://www.douyin.com/note/123'}]};
  const registration = {tabId: 21, sessionId: 's', legacy, workflow, platform: 'douyin', url: request.targets[0].url};
  let lookups = 0;
  const homes = [];
  const ctx = vm.createContext({console,
    readTargetedPostRunRequest: async () => request,
    readTargetedPostPlatformTabForAttempt: async () => registration,
    closeTerminalTargetedPostPlatformTab: async () => cleanup,
    closeLegacyTargetedPostPlatformTab: async () => cleanup,
    readStoredCaptureExecutionLock: async () => null,
    isSameTargetedPostAttempt: () => true,
    isOwnedTargetedPostAttempt: () => true,
    isCaptureExecutionLockOwnedByTargetedPostAttempt: () => false,
    cloudTargetedPostApi: {shouldPreservePlatformTab: () => preserve},
    closeTerminalTargetedPostRunnerTabs: async () => ({closed: true}),
    queueFinishedTaskHome: async (value, options) => homes.push({value, options}),
    isExplicitMissingTargetedPostTabError: error => error.message === 'No tab with id: 21',
    chrome: {tabs: {get: async () => {
      if (++lookups === 1) return {id: 21, windowId: 7, url: request.targets[0].url};
      if (after === 'missing') throw Error('No tab with id: 21');
      if (after === 'unknown') throw Error('browser temporarily unavailable');
      return {id: 21, windowId: 7, url: request.targets[0].url};
    }}},
  });
  vm.runInContext(code, ctx);
  await ctx.stopTargetedPostAttemptResources(request);
  return homes;
}

test('all targeted workflows may replace an actually closed owned page in its original window', async () => {
  for (const workflow of ['negative_post_patrol', 'watched_content_patrol', 'official_account_comment_patrol',
    'followed_creator_post_patrol', 'official_account_post_discovery', 'discovered_post_capture']) {
    const homes = await run({workflow});
    assert.equal(homes.length, 1, workflow);
    assert.equal(homes[0].options.allowCreateHome, true, workflow);
    assert.equal(homes[0].options.runnerTab.windowId, 7);
  }
});

test('success alone, a legacy registration, changed ownership and uncertain removal never authorize a new home', async () => {
  for (const options of [
    {cleanup: {ok: true, removedCount: 0, skipped: true}},
    {cleanup: {ok: true, removedCount: 1, tabId: 22}},
    {cleanup: {ok: true, removedCount: 1, tabId: 21, retained: true}},
    {legacy: true}, {after: 'present'}, {after: 'unknown'},
  ]) {
    const homes = await run(options);
    assert.equal(homes.length, 1);
    assert.equal(homes[0].options.allowCreateHome, false, JSON.stringify(options));
  }
});

test('failed cleanup and human-action protection never enqueue a home', async () => {
  assert.equal((await run({cleanup: {ok: false, removedCount: 0}})).length, 0);
  assert.equal((await run({preserve: true})).length, 0);
});
