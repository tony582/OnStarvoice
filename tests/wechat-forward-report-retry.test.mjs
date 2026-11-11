import assert from 'node:assert/strict';
import test from 'node:test';
import {assessCustomerDailyCaptureReadiness} from '../server/services/customer-daily-report-data.js';
import {keywordRetrySourceReleased} from '../web/admin/src/pages/dispatch/cloud-tasks/retry-item-allocation.js';

const parent = {id: 'report-parent', task_type: 'capture_orchestration', feature_key: 'keyword_orchestration',
  status: 'failed', total_item_count: 2, wechat_forward_item_count: 2, keyword_item_count: 0, unsettled_keyword_items: 0};

test('all-forward orchestrations never block collection readiness, including failed and queued forwards', () => {
  for (const status of ['pending', 'running', 'failed', 'completed_with_failures']) {
    assert.equal(assessCustomerDailyCaptureReadiness({...parent, status,
      progress: {streamingSyncEnabled: true, streamingSyncRemainingCount: 1}}), null, status);
  }
});

test('mixed forwarding keeps incomplete keywords blocking and settled keywords independent', () => {
  const mixed = {...parent, wechat_forward_item_count: 1, keyword_item_count: 1, unsettled_keyword_items: 1};
  assert.ok(assessCustomerDailyCaptureReadiness(mixed).reasons.includes('keyword_items_incomplete'));
  assert.equal(assessCustomerDailyCaptureReadiness({...mixed, unsettled_keyword_items: 0}), null);
});

test('empty, uncounted or partly-forward orchestrations are not accidentally exempted', () => {
  for (const patch of [
    {total_item_count: 0, wechat_forward_item_count: 0},
    {total_item_count: undefined, wechat_forward_item_count: undefined},
    {total_item_count: 2, wechat_forward_item_count: 1},
    {total_item_count: 0, wechat_forward_item_count: 0, metadata: {wechatForward: {recipient: '文件传输助手'}}},
  ]) {
    assert.ok(assessCustomerDailyCaptureReadiness({...parent, ...patch}).reasons.includes('capture_failed'));
  }
});

test('the forwarding exemption cannot hide a regular capture task', () => {
  assert.ok(assessCustomerDailyCaptureReadiness({...parent, task_type: 'capture', feature_key: 'capture.search'})
    .reasons.includes('capture_failed'));
});

test('Admin retry eligibility refuses forwards for both manual retries and elastic recovery', () => {
  for (const elasticPool of [false, true]) {
    for (const status of ['failed', 'needs_action', 'retryable']) {
      for (const sourceStatus of ['completed', 'failed', 'interrupted', 'needs_action']) {
        assert.equal(keywordRetrySourceReleased({item: {item_type: 'wechat_forward', status},
          execution: {status: sourceStatus}, elasticPool}), false, `${status}/${sourceStatus}/${elasticPool}`);
      }
    }
  }
  assert.equal(keywordRetrySourceReleased({item: {item_type: 'keyword', status: 'failed'}, execution: {status: 'failed'}}), true);
  assert.equal(keywordRetrySourceReleased({item: {item_type: 'keyword', status: 'retryable'}, execution: {status: 'interrupted'}, elasticPool: true}), true);
});
