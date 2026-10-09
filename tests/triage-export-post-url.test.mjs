import assert from 'node:assert/strict';
import test from 'node:test';
import {postUrl} from '../server/routes/triage.js';

// 2026-10-09: the export's 帖子链接 for Xiaohongshu follows the admin's 原文 rule
// (validatedStoredXhsSourceUrl): the stored search link is written out only when it
// is an https xiaohongshu.com note URL whose note id equals external_id and that
// still carries its xsec_token. Anything weaker stays empty, as before.
const TOKEN_URL = 'https://www.xiaohongshu.com/search_result/6a43d5260000000008032d64?xsec_token=ABCdef123%3D&xsec_source=pc_search';

test('a verifiable stored Xiaohongshu link is exported as is', () => {
  assert.equal(postUrl({platform: 'xiaohongshu', url: TOKEN_URL, external_id: '6a43d5260000000008032d64'}), TOKEN_URL);
  assert.equal(postUrl({platform: 'xiaohongshu', url: TOKEN_URL, external_id: '6A43D5260000000008032D64'}), TOKEN_URL, 'note ids compare case-insensitively');
});

test('Xiaohongshu links that cannot be verified stay empty', () => {
  assert.equal(postUrl({platform: 'xiaohongshu', url: TOKEN_URL, external_id: '6a43d5260000000008032d65'}), '', 'note id differs from external_id');
  assert.equal(postUrl({platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore/6a43d5260000000008032d64', external_id: '6a43d5260000000008032d64'}), '', 'no xsec_token');
  assert.equal(postUrl({platform: 'xiaohongshu', url: 'http://www.xiaohongshu.com/explore/6a43d5260000000008032d64?xsec_token=x', external_id: '6a43d5260000000008032d64'}), '', 'not https');
  assert.equal(postUrl({platform: 'xiaohongshu', url: 'https://evil.example/explore/6a43d5260000000008032d64?xsec_token=x', external_id: '6a43d5260000000008032d64'}), '', 'other host');
  assert.equal(postUrl({platform: 'xiaohongshu', url: '', external_id: '6a43d5260000000008032d64'}), '');
  assert.equal(postUrl({platform: 'xiaohongshu', url: TOKEN_URL, external_id: ''}), '', 'no stable identity to verify against');
});

test('other platforms keep their existing link rules', () => {
  assert.equal(postUrl({platform: 'douyin', url: '', external_id: '7421', note_type: 'video'}), 'https://www.douyin.com/video/7421');
  assert.equal(postUrl({platform: 'douyin', url: '', external_id: '7421', note_type: 'image'}), 'https://www.douyin.com/note/7421');
  assert.equal(postUrl({platform: 'douyin', url: 'https://www.douyin.com/video/7421?x=1', external_id: '7421'}), 'https://www.douyin.com/video/7421?x=1');
  assert.equal(postUrl({platform: 'weibo', url: '', external_id: 'abc'}), 'https://weibo.com/detail/abc');
  assert.equal(postUrl({platform: 'unknown', url: 'https://x.invalid/p', external_id: ''}), 'https://x.invalid/p');
});
