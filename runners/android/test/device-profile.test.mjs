import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUiTree, xpathLiteral } from '../src/device/ui-tree.mjs';
import { readSearch, readDetail, detailMatchesCard, readFilters, filtersMatch,
  resource, assertProfileDevice } from '../src/device/douyin-profile.mjs';
import { createUiSession } from '../src/device/ui-session.mjs';
import { createAppiumClient } from '../src/device/appium.mjs';
import { readVerifiedDetail } from '../src/device/douyin-detail.mjs';
import { createDouyinCalibrationFlow } from '../src/calibration/douyin-flow.mjs';
import { observeCopiedShare, confirmIndependentDetail } from '../src/calibration/share-evidence.mjs';

const encode = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const node = (id, text = '', children = '', extra = {}) => `<android.widget.TextView ${Object.entries({
  package: 'com.ss.android.ugc.aweme', class: 'android.widget.TextView', 'resource-id': resource(id),
  text, displayed: 'true', enabled: 'true', bounds: '[0,0][100,100]', ...extra,
}).map(([key, value]) => `${key}="${encode(value)}"`).join(' ')}>${children}</android.widget.TextView>`;
const tree = body => parseUiTree(`<hierarchy>${body}</hierarchy>`);
const card = { title: '新壁纸 @上海安吉星信息服务有限公司 #别克', author: '真实车主' };
const detail = { ...card, kind: 'note' };
const marker = 'starvoice-discovery:00000000-0000-4000-8000-000000000001';
const url = 'https://www.douyin.com/note/7687942022607741007';
const observation = () => observeCopiedShare({ marker, beforeText: marker,
  afterText: '看看【真实车主的图文作品】新壁纸 @上... https://v.douyin.com/validLink/',
  card, detailBefore: detail, detailAfter: detail });

test('UiAutomator2 class tags and Unicode entities parse without executing document features', () => {
  const result = tree(node('desc', '中文<&" 👧🏻'));
  assert.equal(result.nodes[1].attributes.text, '中文<&" 👧🏻');
  assert.equal(tree('<node text="&#x1F600;"/>').nodes[1].attributes.text, '😀');
  assert.equal(tree('<按钮 text="分享"/>').nodes[1].attributes.text, '分享');
  for (const xml of ['<!DOCTYPE hierarchy [<!ENTITY a SYSTEM "file:///etc/passwd">]><hierarchy/>',
    '<hierarchy><node></hierarchy>', '<hierarchy/><hierarchy/>', '<hierarchy><node text="&unknown;"/></hierarchy>',
    '<hierarchy><node text="x" text="y"/></hierarchy>', '<hierarchy><node text="&#0;"/></hierarchy>']) {
    assert.throws(() => parseUiTree(xml), { code: 'invalid_ui_source' });
  }
});

test('UI source has size and depth ceilings and supports quoted XPath text safely', () => {
  assert.throws(() => parseUiTree('x'.repeat(2 * 1024 * 1024 + 1)), { code: 'invalid_ui_source' });
  assert.throws(() => parseUiTree('<hierarchy>' + '<node>'.repeat(130) + '</node>'.repeat(130) + '</hierarchy>'), { code: 'invalid_ui_source' });
  assert.equal(xpathLiteral(`A'B"C`), `concat('A',"'",'B"C')`);
});

test('search cards bind their own author; mentions and unrelated authors cannot replace it', () => {
  const header = node('et_search_kw', '别克壁纸') + node('tab', '综合', '', { 'resource-id': 'android:id/text1', selected: 'true' });
  const cardNode = node('b87', '', node('desc', card.title) + node('ab0', card.author) + node('za5', '1小时前'));
  const parsed = readSearch(tree(header + cardNode + node('ab0', '官方账号')), '别克壁纸');
  assert.equal(parsed.verified, true); assert.equal(parsed.cards.length, 1);
  assert.equal(parsed.cards[0].author, card.author);
  assert.match(parsed.cards[0].selector, /真实车主/u);
  assert.equal(readSearch(tree(header + cardNode), '另一个词').verified, false);
  assert.equal(readSearch(tree(header + cardNode + node('hdi', '排序依据')), '别克壁纸').verified, false);
});

test('detail identity rejects changed author or truncation and allows only the display at-sign', () => {
  const found = readDetail(tree(node('tv_desc', card.title) + node('w67', card.author) + node('n00')));
  assert.equal(detailMatchesCard(found, card), true);
  assert.equal(detailMatchesCard({ ...found, author: '@' + card.author }, card), true);
  assert.equal(detailMatchesCard({ ...found, title: '新壁纸...' }, card), false);
  assert.equal(detailMatchesCard({ ...found, author: '上海安吉星信息服务有限公司' }, card), false);
});

test('filter choices are scoped to groups even when several choices are named unlimited', () => {
  const group = (label, selected) => node('uxo', '', node('hdi', label) + node('urc', '', node('rmy', selected), { 'content-desc': `已选中，${selected}，按钮` }));
  const body = group('排序依据', '最新发布') + group('发布时间', '一天内')
    + group('视频时长', '不限') + group('搜索范围', '不限') + group('内容形式', '不限');
  assert.equal(filtersMatch(readFilters(tree(body)), { sort: '最新发布', time: '一天内' }), true);
  assert.throws(() => readFilters(tree(body + group('发布时间', '一周内'))), { code: 'filter_ambiguous' });
});

test('profile refuses a different phone or Douyin version', () => {
  assert.doesNotThrow(() => assertProfileDevice({ model: 'DE106', apiLevel: 27, appVersion: '40.6.0' }));
  assert.throws(() => assertProfileDevice({ model: 'DE106', apiLevel: 27, appVersion: '31.0.0' }), { code: 'profile_version_mismatch' });
});

test('fresh truncated shares stay pending until full independent detail identity is confirmed', () => {
  const pending = observation();
  assert.equal(pending.identityVerified, false); assert.equal(pending.fullTitleIncluded, false);
  const actual = { url, source: 'official_browser_detail', title: card.title, author: card.author };
  assert.equal(confirmIndependentDetail({ observation: pending, resolvedUrl: url, independentDetail: actual }).identityVerified, true);
  for (const change of [{ title: '新壁纸 @上...' }, { author: '其他人' }, { url: url.replace(/7$/u, '8') }, { source: 'clipboard' }]) {
    assert.throws(() => confirmIndependentDetail({ observation: pending, resolvedUrl: url, independentDetail: { ...actual, ...change } }), { code: 'link_identity_unverified' });
  }
});

test('a changed detail, stale clipboard, or contradictory share author cannot become an observation', () => {
  const input = { marker, beforeText: marker, afterText: '看看【其他人的图文作品】 https://v.douyin.com/link/', card, detailBefore: detail, detailAfter: detail };
  assert.throws(() => observeCopiedShare(input), { code: 'share_author_mismatch' });
  assert.throws(() => observeCopiedShare({ ...input, afterText: marker }), { code: 'clipboard_not_fresh' });
  assert.throws(() => observeCopiedShare({ ...input, detailAfter: { ...detail, title: '另一条' } }), { code: 'detail_identity_unverified' });
});

test('Big Bang overlay halts the UI reader without clicking or trying another work', async () => {
  let actions = 0;
  const ui = createUiSession({ sessionId: 'session', client: {
    source: async () => `<hierarchy>${node('close', '', '', { package: 'com.smartisanos.textboom' })}</hierarchy>`,
    clickElement: async () => { actions++; },
  } });
  await assert.rejects(ui.read(), { code: 'system_overlay_blocked' }); assert.equal(actions, 0);
});

test('source transport accepts real large hierarchies while clipboard and other responses remain bounded', async () => {
  const value = 'x'.repeat(200 * 1024);
  const client = createAppiumClient({ fetchImpl: async () => new Response(JSON.stringify({ value })) });
  assert.equal((await client.source('session')).length, value.length);
  await assert.rejects(client.status(), { code: 'appium_response_too_large' });
  const giant = createAppiumClient({ fetchImpl: async () => new Response(JSON.stringify({ value: 'x'.repeat(2 * 1024 * 1024) })) });
  await assert.rejects(giant.source('session'), { code: 'appium_response_too_large' });
});

test('cancellation during element lookup prevents the following UI click', async () => {
  const controller = new AbortController(); let clicked = 0;
  const ui = createUiSession({ sessionId: 'session', client: {
    findElements: async () => { controller.abort(); return [{ 'element-6066-11e4-a52e-4f735466cecf': 'one' }]; },
    clickElement: async () => { clicked++; },
  } });
  await assert.rejects(ui.clickId('hmy', { signal: controller.signal }), { code: 'aborted' }); assert.equal(clicked, 0);
});


test('failed filter setup restores active-window scope and invalidates search context', async () => {
  const scopes = [];
  const page = tree(node('et_search_kw', '别克壁纸') + node('tab', '综合', '', {
    'resource-id': 'android:id/text1', selected: 'true',
  }));
  const flow = createDouyinCalibrationFlow({ ui: {
    setWindowScope: async enabled => { scopes.push(enabled); },
    read: async () => page,
    waitFor: async predicate => { assert.equal(predicate(page), true); return page; },
    input: async () => {}, clickId: async () => {},
    clickXPath: async () => { throw Object.assign(new Error('fixture'), { code: 'ui_target_ambiguous' }); },
  } });
  await assert.rejects(flow.search({ keyword: '别克壁纸' }), { code: 'ui_target_ambiguous' });
  assert.equal(scopes.at(-1), false);
  await assert.rejects(flow.readCards(), { code: 'search_context_unverified' });
});


test('video author excludes the related-search heading that reuses the title resource ID', () => {
  const page = tree(node('desc', card.title) + node('title', '@' + card.author, '', { 'content-desc': '按钮' })
    + node('title', '相关搜索') + node('vmj'));
  const result = readDetail(page);
  assert.equal(result.kind, 'video'); assert.equal(detailMatchesCard(result, card), true);
});


test('collapsed video must expand to the full selected caption before identity is accepted', async () => {
  const make = (title, author = '@' + card.author) => tree(node('desc', title)
    + node('title', author, '', { 'content-desc': '按钮' }) + node('vmj') + node('0s0', '展开'));
  let expanded = false; let clicks = 0;
  const ui = { waitFor: async predicate => {
    const current = make(expanded ? card.title : '新壁纸...');
    assert.equal(predicate(current), true); return current;
  }, clickId: async id => { assert.equal(id, '0s0'); clicks++; expanded = true; } };
  assert.equal((await readVerifiedDetail({ ui, card })).title, card.title);
  assert.equal(clicks, 1);
  await assert.rejects(readVerifiedDetail({ ui: { ...ui, waitFor: async () => make('新壁纸...', '@其他人') }, card }),
    { code: 'detail_identity_unverified' });
  assert.equal(clicks, 1);
});


test('image-note heading and body are read together before comparing with a search card', () => {
  const result = readDetail(tree(node('tv_title', '别克官方新壁纸又来啦！！')
    + node('tv_desc', '#真实生活分享计划 #别克') + node('w67', '车主') + node('n00')));
  assert.equal(detailMatchesCard(result, { title: '别克官方新壁纸又来啦！！#真实生活分享计划 #别克', author: '车主' }), true);
});


test('search note heading separator is handled without dropping punctuation inside the body', () => {
  const result = readDetail(tree(node('tv_title', '壁纸上新') + node('tv_desc', '正文，保留标点') + node('w67', '车主') + node('n00')));
  assert.equal(detailMatchesCard(result, { title: '壁纸上新。正文，保留标点', author: '车主' }), true);
  assert.equal(detailMatchesCard(result, { title: '壁纸上新。正文保留标点', author: '车主' }), false);
});


test('an oversized original clipboard is rejected before marker replacement or sharing', async () => {
  const header = node('et_search_kw', '别克壁纸') + node('tab', '综合', '', {
    'resource-id': 'android:id/text1', selected: 'true',
  });
  const page = tree(header + node('b87', '', node('desc', card.title) + node('ab0', card.author)));
  const group = (label, selected) => node('uxo', '', node('hdi', label)
    + node('urc', '', node('rmy', selected), { 'content-desc': `已选中，${selected}，按钮` }));
  const filters = tree(group('排序依据', '最新发布') + group('发布时间', '一天内')
    + group('视频时长', '不限') + group('搜索范围', '不限') + group('内容形式', '不限'));
  const detailPage = tree(node('tv_desc', card.title) + node('w67', card.author) + node('n00'));
  let current = page; let clipboardWrites = 0; let shares = 0;
  const ui = {
    setWindowScope: async () => {},
    waitFor: async predicate => { assert.equal(predicate(current), true); return current; },
    clickXPath: async selector => { current = selector.includes('筛选，按钮') ? filters : detailPage; },
    clickId: async id => { if (id === 'zsg') current = page; else shares++; },
    getClipboard: async () => '中'.repeat(6000),
    setClipboard: async () => { clipboardWrites++; },
  };
  const flow = createDouyinCalibrationFlow({ ui });
  const search = await flow.adoptCurrentSearch({ keyword: '别克壁纸', filters: { sort: '最新发布', time: '一天内' } });
  await assert.rejects(flow.capture({ card: search.cards[0] }), { code: 'clipboard_restore_unsupported' });
  assert.equal(clipboardWrites, 0); assert.equal(shares, 0);
});


test('40.6 inline video caption expands and removes only a verified UI collapse suffix', async () => {
  const make = (title, author = '@' + card.author, clickable = 'true') => tree(
    node('desc', title, '', {clickable}) + node('title', author, '', {'content-desc': '按钮'}) + node('vmj'));
  let expanded = false; let clicks = 0;
  const ui = {waitFor: async predicate => {
    const current = make(expanded ? card.title + ' 收起' : '新壁纸... 展开');
    assert.equal(predicate(current), true); return current;
  }, clickId: async id => {assert.equal(id, 'desc'); clicks++; expanded = true;}};
  assert.equal((await readVerifiedDetail({ui, card})).title, card.title);
  assert.equal((await readVerifiedDetail({ui, card})).title, card.title); // After returning from share.
  assert.equal(clicks, 1);
  for (const current of [make('新壁纸... 展开', '@其他人'), make('新壁纸... 展开', undefined, 'false'),
    make('另一篇正文 收起'), make(card.title + ' 收起', '@其他人'), make(card.title + ' 收起', undefined, 'false')]) {
    await assert.rejects(readVerifiedDetail({ui: {...ui, waitFor: async () => current}, card}),
      {code: 'detail_identity_unverified'});
  }
  assert.equal(clicks, 1);
  const literal = {...card, title: card.title + ' 收起'};
  const current = make(literal.title);
  assert.equal((await readVerifiedDetail({ui: {...ui, waitFor: async () => current}, card: literal})).title, literal.title);
});
