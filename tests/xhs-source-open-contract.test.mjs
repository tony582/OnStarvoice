import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

import {
  redactXhsRecordNavigation,
  validatedStoredXhsSourceUrl,
} from '../server/services/xhs-source-open.js';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Xiaohongshu records expose a validated saved URL separately from canonical identity', () => {
  const triage = source('server/routes/triage.js');
  const service = source('server/services/xhs-source-open.js');
  const action = source('web/admin/src/components/shared/RecordSourceAction.tsx');

  assert.match(triage, /redactXhsRecordNavigation/);
  assert.match(service, /source_open_mode: 'stored_url'/);
  assert.match(service, /url: sourceUrl/);
  assert.match(service, /canonical_url: canonicalUrl/);
  assert.doesNotMatch(triage, /\/source-open/);
  assert.doesNotMatch(action, /source-open|RSA-OAEP|刷新中|sealedSourceUrl/);
  assert.match(action, /href=\{originalUrl\}/);
  assert.match(action, /原文不可用/);
});

test('saved Xiaohongshu URL validation requires HTTPS host and exact note identity', () => {
  const noteId = '6a94c7c3000000002003b809';
  const fullUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=test-token&xsec_source=pc_search`;
  assert.equal(validatedStoredXhsSourceUrl(fullUrl, noteId), fullUrl);
  assert.equal(
    validatedStoredXhsSourceUrl(
      `https://www.xiaohongshu.com/user/profile/author_01/${noteId}?xsec_token=test-token`,
      noteId,
    ),
    `https://www.xiaohongshu.com/user/profile/author_01/${noteId}?xsec_token=test-token`,
  );
  assert.equal(validatedStoredXhsSourceUrl(fullUrl, '6a942033000000002102f2fa'), '');
  assert.equal(validatedStoredXhsSourceUrl(`https://example.com/explore/${noteId}`, noteId), '');
  assert.equal(validatedStoredXhsSourceUrl(`http://www.xiaohongshu.com/explore/${noteId}`, noteId), '');
  assert.equal(validatedStoredXhsSourceUrl(`https://www.xiaohongshu.com/redirect/explore/${noteId}`, noteId), '');
  assert.equal(validatedStoredXhsSourceUrl(`https://www.xiaohongshu.com/explore/${noteId}`, noteId), '');
});

test('record navigation does not substitute canonical URL when full URL is missing', () => {
  const noteId = '6a94c7c3000000002003b809';
  const missing = redactXhsRecordNavigation({
    platform: 'xiaohongshu',
    external_id: noteId,
    url: '',
  });
  assert.equal(missing.url, '');
  assert.equal(missing.canonical_url, `https://www.xiaohongshu.com/explore/${noteId}`);
  assert.equal(missing.source_open_available, false);

  const fullUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=test-token`;
  const available = redactXhsRecordNavigation({
    platform: 'xiaohongshu',
    external_id: noteId,
    url: fullUrl,
  });
  assert.equal(available.url, fullUrl);
  assert.equal(available.canonical_url, `https://www.xiaohongshu.com/explore/${noteId}`);
  assert.equal(available.source_open_available, true);
});

test('source-open command result handling has no RSA or URL relay branch', () => {
  const captureCloud = source('server/routes/capture-cloud.js');
  const service = source('server/services/xhs-source-open.js');
  assert.doesNotMatch(captureCloud, /source_open_encrypted_result_invalid|sealedSourceUrl|sourceLinkReadyAt/);
  assert.doesNotMatch(service, /RSA-OAEP|navigationPublicKeyJwk|sealedSourceUrl/);
});
