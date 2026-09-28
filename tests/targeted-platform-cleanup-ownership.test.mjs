import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const protocol = await readFile(new URL('../utils/cloud-targeted-post.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const context = vm.createContext({URL});
vm.runInContext(protocol, context);
vm.runInContext(`const cloudTargetedPostApi = OnStarvoiceCloudTargetedPost;\n` +
  background.slice(background.indexOf('function targetedPostPlatformUrlBelongsToRequest('),
    background.indexOf('function isExplicitMissingTargetedPostTabError(')), context);
const owns = context.targetedPostPlatformUrlBelongsToRequest;
const api = context.OnStarvoiceCloudTargetedPost;
vm.runInContext(background.slice(background.indexOf('function normalizeTargetedPostPlatformTab('),
  background.indexOf('function targetedPostPlatformTabMatchesRequest(')), context);
vm.runInContext(background.slice(background.indexOf('function normalizeTargetedPostPlatformTabCleanup('),
  background.indexOf('async function readTargetedPostPlatformTabCleanup(')), context);
vm.runInContext(background.slice(background.indexOf('function targetedPostPlatformCleanupOwnsUrl('),
  background.indexOf('async function recoverTargetedPostPlatformTabCleanup(')), context);

test('all six supported targeted workflows use the persistent platform ownership path', () => {
  for (const workflow of ['negative_post_patrol', 'watched_content_patrol', 'official_account_comment_patrol',
    'followed_creator_post_patrol', 'official_account_post_discovery', 'discovered_post_capture']) {
    assert.equal(api.usesOwnedPlatformTab(workflow), true, workflow);
  }
  assert.equal(api.usesOwnedPlatformTab('arbitrary'), false);
});

test('profile patrol cleanup only owns its exact profile on the correct origin', () => {
  for (const workflow of ['official_account_comment_patrol', 'followed_creator_post_patrol', 'official_account_post_discovery']) {
    for (const [platform, url, other] of [
      ['douyin', 'https://www.douyin.com/user/MS4w.LjAA-test', 'https://www.douyin.com/user/another'],
      ['xiaohongshu', 'https://www.xiaohongshu.com/user/profile/abc123', 'https://www.xiaohongshu.com/user/profile/def456'],
    ]) {
      const request = {workflow, platform, targets: [{url}]};
      assert.equal(owns(`${url}?tracking=1`, request), true);
      assert.equal(owns(`${url}/`, request), true);
      assert.equal(owns(other, request), false);
      assert.equal(owns(url.replace('www.', 'evil.'), request), false);
      assert.equal(owns(url.replace('https:', 'http:'), request), false);
      assert.equal(owns('about:blank', request), false);
    }
  }
});

test('missing externalId is derived from target URL, not accepted as any detail page', () => {
  const request = {workflow: 'negative_post_patrol', platform: 'douyin', targets: [{url: 'https://www.douyin.com/video/123'}]};
  assert.equal(owns('https://www.douyin.com/video/123', request), true);
  assert.equal(owns('https://www.douyin.com/video/456', request), false);
  assert.equal(owns('https://www.douyin.com/user/123', request), false);
});

test('negative detail cleanup never adopts a profile even if malformed input names it', () => {
  const url = 'https://www.douyin.com/user/profile';
  assert.equal(owns(url, {workflow: 'negative_post_patrol', platform: 'douyin', targets: [{url}]}), false);
});

test('persistent cleanup follows the second authorized profile and mixed-platform targets', () => {
  const allowedTargets = [
    {platform: 'douyin', url: 'https://www.douyin.com/user/first'},
    {platform: 'douyin', url: 'https://www.douyin.com/user/second'},
    {platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/user/profile/third'},
  ];
  const registration = {requestId: 'r', attemptId: 'a', sessionId: 's', tabId: 42,
    platform: 'multi', workflow: 'followed_creator_post_patrol', url: allowedTargets[0].url, allowedTargets};
  // Round trip through the real persisted normalization, including a restart.
  const durable = JSON.parse(JSON.stringify(context.normalizeTargetedPostPlatformTabCleanup(registration)));
  for (const target of allowedTargets) {
    assert.equal(context.targetedPostPlatformCleanupOwnsUrl(target.url, durable), true, target.url);
  }
  assert.equal(context.targetedPostPlatformCleanupOwnsUrl('https://www.douyin.com/user/not-in-task', durable), false);
});
