import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

globalThis.window = {
  location: {
    href: 'https://www.xiaohongshu.com/search_result?keyword=dummy',
  },
};

const {
  ensureXhsNoteUrlSource,
  mergeNotesIntoMap,
  pickBestNoteUrl,
} = await import(`../../utils/capture/keyword-search.js?url-test=${Date.now()}`);
const {refreshListCaptureSourceUrlInPlace} = await import(
  `../../utils/capture-sync.js?url-refresh-test=${Date.now()}`
);

const NOTE_ID = '6a94c7c3000000002003b809';
const DUMMY_TOKEN = 'dummy_token_for_unit_test_only';
const fullUrl =
  `https://www.xiaohongshu.com/explore/${NOTE_ID}` +
  `?xsec_token=${DUMMY_TOKEN}&xsec_source=pc_search`;
const bareUrl = `https://www.xiaohongshu.com/explore/${NOTE_ID}`;

test('card URL selection prefers and preserves the complete clickable href', () => {
  assert.equal(
    pickBestNoteUrl([
      bareUrl,
      `/explore/${NOTE_ID}?xsec_token=${DUMMY_TOKEN}&xsec_source=pc_search`,
    ]),
    fullUrl,
  );
  assert.equal(ensureXhsNoteUrlSource(fullUrl), fullUrl);
  assert.equal(
    ensureXhsNoteUrlSource(
      `${bareUrl}?xsec_token=${DUMMY_TOKEN}&xsec_source=`,
    ),
    fullUrl,
  );
});

test('later scroll rounds cannot replace a complete URL with a bare canonical URL', () => {
  const noteMap = new Map();
  mergeNotesIntoMap(noteMap, [{noteId: NOTE_ID, url: fullUrl, title: 'first'}]);
  mergeNotesIntoMap(noteMap, [{noteId: NOTE_ID, url: bareUrl, title: 'latest'}]);

  assert.equal(noteMap.get(NOTE_ID).url, fullUrl);
  assert.equal(noteMap.get(NOTE_ID).title, 'latest');
});

function listRecord({
  platform = 'xiaohongshu',
  noteId = NOTE_ID,
  url = bareUrl,
  noteUrl,
} = {}) {
  return {
    platform,
    type: 'keyword_notes',
    payload: {
      items: [{
        noteId,
        url,
        ...(noteUrl === undefined ? {} : {noteUrl}),
      }],
    },
  };
}

test('local dedupe replaces a bare XHS URL with a fresh complete URL', () => {
  const existing = listRecord({noteUrl: bareUrl});
  existing.payload.detailCaptureNoteUrl = bareUrl;
  existing.payload.detailPayload = {url: bareUrl, noteUrl: bareUrl};
  const fresh = listRecord({url: fullUrl, noteUrl: fullUrl});

  assert.equal(refreshListCaptureSourceUrlInPlace(existing, fresh), true);
  assert.equal(existing.payload.items[0].url, fullUrl);
  assert.equal(existing.payload.items[0].noteUrl, fullUrl);
  assert.equal(existing.payload.detailCaptureNoteUrl, fullUrl);
  assert.equal(existing.payload.detailPayload.url, fullUrl);
  assert.equal(existing.payload.detailPayload.noteUrl, fullUrl);
  assert.equal(Number.isFinite(existing.updatedAt), true);
});

test('local dedupe never lets a bare URL overwrite a complete URL', () => {
  const existing = listRecord({url: fullUrl});
  const fresh = listRecord({url: bareUrl});

  assert.equal(refreshListCaptureSourceUrlInPlace(existing, fresh), false);
  assert.equal(existing.payload.items[0].url, fullUrl);
});

test('local URL refresh requires exact ID, HTTPS official host and xsec token', () => {
  const invalidUrls = [
    `https://www.xiaohongshu.com/explore/6a94c7c3000000002003b810?xsec_token=${DUMMY_TOKEN}`,
    `http://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=${DUMMY_TOKEN}`,
    `https://xiaohongshu.com.evil.example/explore/${NOTE_ID}?xsec_token=${DUMMY_TOKEN}`,
    bareUrl,
  ];
  for (const invalidUrl of invalidUrls) {
    const existing = listRecord();
    assert.equal(
      refreshListCaptureSourceUrlInPlace(existing, listRecord({url: invalidUrl})),
      false,
    );
    assert.equal(existing.payload.items[0].url, bareUrl);
  }
  assert.equal(
    refreshListCaptureSourceUrlInPlace(
      listRecord({platform: 'douyin'}),
      listRecord({platform: 'douyin', url: fullUrl}),
    ),
    false,
  );
});

test('local URL refresh accepts an exact user/profile/:author/:note URL', () => {
  const profileUrl =
    `https://www.xiaohongshu.com/user/profile/author_dummy/${NOTE_ID}` +
    `?xsec_token=${DUMMY_TOKEN}&xsec_source=pc_user`;
  const existing = listRecord();

  assert.equal(
    refreshListCaptureSourceUrlInPlace(existing, listRecord({url: profileUrl})),
    true,
  );
  assert.equal(existing.payload.items[0].url, profileUrl);
});

test('local URL refresh does not rewrite a mismatched detail URL', () => {
  const otherUrl = 'https://www.xiaohongshu.com/explore/6a94c7c3000000002003b810';
  const existing = listRecord();
  existing.payload.detailPayload = {url: otherUrl};

  assert.equal(
    refreshListCaptureSourceUrlInPlace(existing, listRecord({url: fullUrl})),
    true,
  );
  assert.equal(existing.payload.items[0].url, fullUrl);
  assert.equal(existing.payload.detailPayload.url, otherUrl);
});

test('sync payload keeps item.url while identity normalization alone strips xsec fields', async () => {
  const captureSyncSource = await readFile(
    new URL('../../utils/capture-sync.js', import.meta.url),
    'utf8',
  );
  const identityStart = captureSyncSource.indexOf('function normalizeIdentityUrl');
  const identityEnd = captureSyncSource.indexOf('\nfunction resolveRecordIdentityPlatform', identityStart);
  const identitySection = captureSyncSource.slice(identityStart, identityEnd);
  const compactStart = captureSyncSource.indexOf('function compactSyncItemForBackend');
  const compactEnd = captureSyncSource.indexOf('\nfunction normalizeCaptureTraceSequence', compactStart);
  const compactSection = captureSyncSource.slice(compactStart, compactEnd);
  const requestStart = captureSyncSource.indexOf('function buildSyncRequestPayload');
  const requestEnd = captureSyncSource.indexOf('\nfunction stripCommentCollectionsForContentSync', requestStart);
  const requestSection = captureSyncSource.slice(requestStart, requestEnd);

  assert.match(identitySection, /'xsec_token'/);
  assert.match(identitySection, /'xsec_source'/);
  assert.doesNotMatch(compactSection, /delete next\.(?:url|noteUrl)/);
  assert.match(requestSection, /return payload;/);
  assert.match(
    captureSyncSource,
    /const sourceUrlChanged\s*=\s*refreshListCaptureSourceUrlInPlace\(existingRecord, record\)/,
  );
});

test('keyword diagnostics never print captured URLs or tokens', async () => {
  const keywordSource = await readFile(
    new URL('../../utils/capture/keyword-search.js', import.meta.url),
    'utf8',
  );
  const emptySampleStart = keywordSource.indexOf('const sample = allItems.slice(0, 3)');
  const emptySampleEnd = keywordSource.indexOf('\n      console.warn(', emptySampleStart);
  const emptySampleSection = keywordSource.slice(emptySampleStart, emptySampleEnd);

  assert.doesNotMatch(emptySampleSection, /url:\s*item\.url/);
  assert.doesNotMatch(keywordSource, /console\.(?:log|warn|error|debug)\([^\n]*xsec_token/);
});
