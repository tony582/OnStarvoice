import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCaptureRecoveryErrorCode,
} from '../server/services/capture-health-schema.js';

test('recovery error codes are accepted only from the explicit business-code set', () => {
  for (const [input, expected] of [
    ['CONTENT_RELAY_TIMEOUT', 'CONTENT_RELAY_TIMEOUT'],
    ['network-timeout', 'NETWORK_TIMEOUT'],
    ['DOUYIN_DETAIL_NOT_READY', 'DOUYIN_DETAIL_NOT_READY'],
    ['DOUYIN_SEARCH_SECURITY_CHALLENGE', 'DOUYIN_SEARCH_SECURITY_CHALLENGE'],
    ['STALE_TASK_HEARTBEAT_TIMEOUT', 'STALE_TASK_HEARTBEAT_TIMEOUT'],
    ['CAPTURE_TASK_UNEXPECTED_CANCELLATION', 'CAPTURE_TASK_UNEXPECTED_CANCELLATION'],
    ['EXTENSION_RUNTIME_RESTARTED', 'EXTENSION_RUNTIME_RESTARTED'],
    [
      'UNATTENDED_RECOVERY_LAUNCH_EXHAUSTED',
      'UNATTENDED_RECOVERY_LAUNCH_EXHAUSTED',
    ],
    ['USER_CANCELED', 'USER_CANCELED'],
  ]) {
    assert.equal(normalizeCaptureRecoveryErrorCode(input), expected, input);
  }

  for (const value of [
    'NETWORK_PROD_DB_INTERNAL',
    'CAPTURE_CUSTOMER_13800138000',
    'DOUYIN_TENANT_ACME_PRIVATE',
    'SYNC_PROD_CLUSTER_ALPHA',
    'UNATTENDED_XOXB_123456789012_123456789012_ABCDEFGHIJKLMNOP',
  ]) {
    assert.equal(normalizeCaptureRecoveryErrorCode(value), 'UNKNOWN', value);
  }
});
