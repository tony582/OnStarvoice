import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createXhsSecurityBlockError,
  detectXhsSecurityPage,
  XHS_SECURITY_BLOCK_CODE,
} from '../../utils/capture/xiaohongshu-security.js';

test('detects the supplied Chinese Xiaohongshu 300013 protection page', () => {
  const evidence = detectXhsSecurityPage({
    text: '安全限制\n访问频繁，请稍后再试\n300013\n我要反馈\n返回首页',
    url: 'https://www.xiaohongshu.com/explore/example',
  });
  assert.equal(evidence?.variant, 'cn_rate_limit_300013');
  assert.equal(evidence?.language, 'zh-CN');
  assert.equal(evidence?.reason, 'rate_limit');
  assert.equal(evidence?.confirmed, true);
});

test('detects both supplied English REDNote protection pages', () => {
  const qr = detectXhsSecurityPage({
    text: 'Scan with logged–in 「REDNote APP」 for account security. QR code expires in 1 minutes.',
  });
  assert.equal(qr?.variant, 'en_account_security_qr');
  assert.equal(qr?.reason, 'account_security_qr');

  const rate = detectXhsSecurityPage({
    text: 'Requests too frequent. Try again after 1 minute. Refresh Feedback',
  });
  assert.equal(rate?.variant, 'en_rate_limit');
  assert.equal(rate?.reason, 'rate_limit');
});

test('ordinary post copy and generic security words are not protection pages', () => {
  for (const text of [
    '车主说最近请求太频繁，但刷新后就好了',
    '这款车给我很强的安全感，评论区也有人讨论 challenge',
    '访问频繁',
    '安全限制',
    '300013 是帖子里提到的编号',
    'Requests too frequent is quoted in this article.',
  ]) {
    assert.equal(detectXhsSecurityPage({text}), null, text);
  }
});

test('structured Xiaohongshu failure keeps the exact page variant', () => {
  const error = createXhsSecurityBlockError({
    confirmed: true,
    platform: 'xiaohongshu',
    variant: 'en_account_security_qr',
    language: 'en',
    reason: 'account_security_qr',
    pageUrl: 'https://www.xiaohongshu.com/',
  });
  assert.equal(error.code, XHS_SECURITY_BLOCK_CODE);
  assert.equal(error.securityBlocked, true);
  assert.equal(error.platformSafetyBlocked, true);
  assert.equal(error.requiresManualAction, true);
  assert.equal(error.securityEvidence.variant, 'en_account_security_qr');
});
