import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOBILE_WORKFLOW,
  mobileKeywordMinutes,
  mobileKeywordMs,
  mobilePlanBlockReason,
  mobileTaskBudgets,
  mobileTaskFilters,
  trimMobilePlanSnapshot,
} from '../server/services/android-control/mobile-tasks.js';

test('mobile filter mapping keeps calibrated douyin values and falls back safely', () => {
  assert.deepEqual(
    mobileTaskFilters({sort: 'likes', publishTime: 'week', contentType: 'video', searchScope: 'followed'}),
    {sort: 'likes', publishTime: 'week', contentType: 'video'},
  );
  // Unknown / browser-only values fall back to the safe default.
  assert.deepEqual(
    mobileTaskFilters({sort: 'weird', publishTime: 'month', contentType: 'note'}),
    {sort: 'comprehensive', publishTime: 'all', contentType: 'all'},
  );
  assert.deepEqual(mobileTaskFilters(), {sort: 'comprehensive', publishTime: 'all', contentType: 'all'});
});

test('mobile keyword minutes normalize to 1-120 with a 15 minute default', () => {
  assert.equal(mobileKeywordMinutes({}), 15);
  assert.equal(mobileKeywordMinutes({mobileKeywordMaxMinutes: 0}), 1);
  assert.equal(mobileKeywordMinutes({mobileKeywordMaxMinutes: 999}), 120);
  assert.equal(mobileKeywordMinutes({mobileKeywordMaxMinutes: 20}), 20);
  assert.equal(mobileKeywordMs({mobileKeywordMaxMinutes: 20}), 20 * 60000);
});

test('mobile budgets: post limit maps to maxLinks, 0 unlimited, batch = keywordMs*n + 5min', () => {
  const budgets = mobileTaskBudgets({keywordMaxDetectedItems: 40, mobileKeywordMaxMinutes: 12}, 3);
  assert.equal(budgets.maxLinks, 40);
  assert.equal(budgets.maxCards, 0);
  assert.equal(budgets.maxSwipes, 0);
  assert.equal(budgets.keywordMs, 12 * 60000);
  assert.equal(budgets.batchMs, 12 * 60000 * 3 + 300000);
  assert.equal(budgets.maxPending, 100);
  // No configured limit or a non-positive one means unlimited links.
  assert.equal(mobileTaskBudgets({}, 1).maxLinks, 0);
  assert.equal(mobileTaskBudgets({keywordMaxDetectedItems: 0}, 1).maxLinks, 0);
  // A single elastic keyword: keywordMs + 5 minutes.
  assert.equal(mobileTaskBudgets({mobileKeywordMaxMinutes: 15}, 1).batchMs, 15 * 60000 + 300000);
});

test('mobile plan eligibility fences non-douyin, sequential, negative patrol and month window', () => {
  assert.equal(mobilePlanBlockReason({searchFilters: {publishTime: 'day'}}, 'douyin'), '');
  assert.equal(mobilePlanBlockReason({}, 'xiaohongshu'), 'platform_not_douyin');
  assert.equal(mobilePlanBlockReason({searchPasses: ['all', 'video']}, 'douyin'), 'sequential_search_unsupported');
  assert.equal(mobilePlanBlockReason({negativePatrol: {enabled: true}}, 'douyin'), 'negative_patrol_unsupported');
  assert.equal(mobilePlanBlockReason({searchFilters: {publishTime: 'month'}}, 'douyin'), 'publish_time_month_unsupported');
});

test('trimmed plan snapshot keeps everything but rewrites the keyword list', () => {
  const trimmed = trimMobilePlanSnapshot({keywords: ['a', 'b', 'c'], searchFilters: {sort: 'latest'}}, ['b']);
  assert.deepEqual(trimmed.keywords, ['b']);
  assert.deepEqual(trimmed.searchFilters, {sort: 'latest'});
  assert.equal(MOBILE_WORKFLOW, 'douyin_mobile_discovery');
});
