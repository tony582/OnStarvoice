import assert from 'node:assert/strict';
import test from 'node:test';
import {AuthorDomNode, el} from '../fixtures/author-dom.mjs';
import {extractDouyinAuthorInfo} from '../../utils/capture/douyin-single-note.js';
import {resolveSearchCardAuthorInfo} from '../../utils/capture/douyin-keyword-search.js';
import {resolveCapturedRecordType} from '../../server/services/official-account-identity.js';

globalThis.Element = AuthorDomNode;
globalThis.window = {
  innerWidth: 1200, innerHeight: 900,
  getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: '1'}),
};
const OFFICIAL = 'MS4wLjABAAAAfiSeUkdKAizCXA_PQB2SvpFKSE9urkLkV-JgydIwH6g';
const AUTHOR = 'MS4wLjABAAAA0FyLQGI69KPA2EkV6JxTAe09MY9T9tnjlN8CM1znn3M';
const officialName = '上海安吉星信息服务有限公司';
const profile = id => `https://www.douyin.com/user/${id}`;
const link = (id, ...children) => el('a', {href: `//www.douyin.com/user/${id}`}, ...children);
const mention = () => link(OFFICIAL, el('span', {id: `@${officialName}`}, `@${officialName}`));
const card = (id = AUTHOR, name = 'Change') => el('div', {'data-e2e': 'user-info'},
  link(id, el('span', {'data-e2e': 'live-avatar'}, el('img', {alt: name}))),
  el('div', {}, link(id, el('div', {'data-click-from': 'title'}, name)),
    el('p', {}, '粉丝331获赞6052')), el('button', {}, '关注'));
const expected = {name: 'Change', userId: AUTHOR, url: profile(AUTHOR)};
const officialAccounts = [{id: 'official', platform: 'douyin', status: 'active', account_name: officialName,
  platform_user_id: OFFICIAL, account_id: OFFICIAL, profile_url: profile(OFFICIAL), skip_content: true}];

test('real note layout: a body @mention cannot replace the publisher or trigger official exclusion', () => {
  // Mirrors /note/7688168579418098019: user-info contains avatar/name links;
  // the description is an unlabelled sibling with an inline @ span.
  const root = el('main', {'data-e2e': 'note-detail'}, card(),
    el('div', {}, '壁纸上新。这次上新了《檐下秋意》 和《月兔栖梦》 赞赞赞', mention()));
  const author = extractDouyinAuthorInfo(root);
  assert.deepEqual(author, expected);
  const result = resolveCapturedRecordType({record: {platform: 'douyin', record_type: 'keyword_notes',
    author_name: author.name, author_id: author.userId}, officialAccounts});
  assert.equal(result.recordType, 'keyword_notes');
});

test('a genuine official publisher remains official even when its nickname starts with @', () => {
  const root = el('main', {}, el('div', {'data-e2e': 'feed-video-nickname'},
    link(OFFICIAL, `@${officialName}`)), el('div', {'data-e2e': 'video-desc'}, link(AUTHOR, '@Change')));
  const author = extractDouyinAuthorInfo(root);
  assert.equal(author.userId, OFFICIAL);
  assert.equal(author.name, officialName);
  assert.equal(resolveCapturedRecordType({record: {platform: 'douyin', record_type: 'single_note',
    author_id: author.userId}, officialAccounts}).recordType, 'official_content');
});

test('missing publisher does not fall back to mentions, commenters, recommendations or another detail', () => {
  const root = el('main', {}, mention(),
    el('div', {'data-e2e': 'comment-list'}, card('commenter', '睡个好觉_')),
    el('div', {'data-e2e': 'recommend-list'}, card('recommendation', '推荐作者')));
  globalThis.document = el('body', {}, root, card(OFFICIAL, officialName));
  assert.deepEqual(extractDouyinAuthorInfo(root), {name: '', userId: '', url: ''});
});

test('hidden author cards and ambiguous author identities cannot supply a publisher', () => {
  const root = el('main', {}, el('div', {'aria-hidden': 'true'}, card(OFFICIAL, officialName)), card());
  assert.deepEqual(extractDouyinAuthorInfo(root), expected);
  const ambiguous = el('main', {}, el('div', {'data-e2e': 'user-info'}, link(AUTHOR, 'Change'), link(OFFICIAL, officialName)));
  assert.deepEqual(extractDouyinAuthorInfo(ambiguous), {name: '', userId: '', url: ''});
});

test('search author row wins over description mentions as one identity tuple', () => {
  const root = el('div', {class: 'search-result-card'},
    el('div', {class: 'desc'}, mention()),
    el('div', {class: 'WldPmwm5'}, link(AUTHOR, '@Change')));
  assert.deepEqual(resolveSearchCardAuthorInfo(root), expected);
});

test('a search nickname without a profile link never borrows a mentioned account ID', () => {
  const root = el('div', {class: 'search-result-card'},
    el('div', {class: 'desc'}, mention()), el('span', {class: 'WldPmwm5'}, 'Change'));
  assert.deepEqual(resolveSearchCardAuthorInfo(root), {name: 'Change', userId: '', url: ''});
});

test('search text with only an @mention is not author evidence', () => {
  const root = el('div', {class: 'search-result-card'}, el('div', {class: 'desc'}, '壁纸上新', mention()));
  assert.deepEqual(resolveSearchCardAuthorInfo(root), {name: '', userId: '', url: ''});
});

test('external and own-profile links cannot become strong publisher identities', () => {
  for (const href of ['https://douyin.com.evil.example/user/official', '/user/self']) {
    const root = el('main', {}, el('div', {'data-e2e': 'feed-video-nickname'}, el('a', {href}, 'Change')));
    const author = extractDouyinAuthorInfo(root);
    assert.equal(author.userId, '');
    assert.equal(author.url, '');
  }
});
