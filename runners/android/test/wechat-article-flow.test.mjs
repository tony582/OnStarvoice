import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createWechatArticleFlow} from '../src/device/wechat-article-flow.mjs';
import {ARTICLE_ACTIVITY, ARTICLE_LINK_ACTIVITY, ARTICLE_LANDING, ARTICLE_SEARCH, parseArticleCards} from '../src/device/wechat-article-parse.mjs';
import {ACTIVITY} from '../src/device/wechat-profile.mjs';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/wechat-articles/${name}.json`, import.meta.url)));
const row = (text, x, y, w = 200, h = 45) => ({text, x, y, w, h});
const shareUrl = 'https://mp.weixin.qq.com/s/bMWKCZnPrhVlz2uCqmRzKw';
const t9 = name => fixture('t9-claude-phone-20261109')[name].rows;
function fake({stage = 'home', previousLink = '', copiedLink = shareUrl, toast = true, hazard = null, blankInput = false, resumedArticle = false, oneStep = false, missingMenu = false, staleHome = 0, badLinkCard = false, articleActivity = ARTICLE_ACTIVITY, proxyReads = 0, restoreAfterCopy = false, blankArticleReads = 0, resultPages = null, articlePage = null, onWait = null} = {}) {
  let inputValue = '', clipboard = previousLink, emptyReads = blankInput ? 1 : 0; const calls = [];
  const activity = () => proxyReads-- > 0 ? 'com.tencent.mm.plugin.webview.stub.WebViewStubProxyUI' : hazard ?? ({home: ACTIVITY.main, discover: ACTIVITY.main, landing: ARTICLE_LANDING,
    input: ARTICLE_SEARCH, results: ARTICLE_SEARCH, article: articleActivity, menu: articleActivity, copy: articleActivity,
    copied: articleActivity}[stage]);
  const main = [row('微信', 80, 2150), row('通讯录', 330, 2150), row('发现', 600, 2150)];
  const rows = () => {
    if (oneStep) return [row(typeof oneStep === 'string' ? oneStep : 'One Step', 436, 335), row('K', 39, 332, 40), row('→', 999, 336, 35), row('16:45③单', 289, 586), row('文章内容', 306, 723)];
    if (stage === 'home') return staleHome-- > 0 ? fixture('21-article-first') : main;
    if (stage === 'discover') return [...main, row('搜一搜', 100, 1250)];
    if (stage === 'landing') return [row('搜索', 94, 502)];
    if (stage === 'input') return emptyReads-- > 0 ? [row('16:33', 26, 23)] : [row('搜索或提问', 137, 143), row('搜索', 921, 303, 80)];
    if (stage === 'results') {
      if (resultPages?.length) return resultPages.length > 1 ? resultPages.shift() : resultPages[0];
      return inputValue.startsWith('https://') ? fixture('link-open-results').map(row =>
        badLinkCard && row.y === 538 ? {...row, text: 'mp.weixin.qq.com.evil.test/s/token'} : row) : fixture('20-articles-loaded');
    }
    if (stage === 'menu') return fixture('30-menu-confirmed');
    if (stage === 'copy') return fixture('32-copy-link');
    if (stage === 'copied' && restoreAfterCopy) return [...fixture('37-comments-end'), ...fixture('33-link-copied')];
    if (stage === 'copied' && toast) return fixture('33-link-copied');
    if (stage === 'article' && blankArticleReads-- > 0) return fixture('21-article-first').filter(row => row.y < 600 || row.y > 2100);
    if (stage === 'article' && resumedArticle) return fixture('37-comments-end');
    return (articlePage ?? fixture('21-article-first')).filter(row => !missingMenu || !/^[•·.⋯…]{2,}$/u.test(row.text));
  };
  const screen = {
    launch: async () => { stage = 'home'; }, defaultIme: async () => 'owner.keyboard/.IME',
    enableIme: async value => calls.push(['enable', value]), setIme: async value => calls.push(['ime', value]),
    disableIme: async value => calls.push(['disable', value]), key: async () => {}, typeUnicode: async value => { inputValue = value; calls.push(['type', value]); },
    readClipboard: async () => clipboard,
    tap: async (x, y) => {
      assert.ok(Number.isInteger(x) && Number.isInteger(y), 'ADB tap coordinates must be integers');
      calls.push(['tap', x, y]);
      if (stage === 'home') stage = 'discover'; else if (stage === 'discover') stage = 'landing';
      else if (stage === 'landing') stage = 'input'; else if (stage === 'input' && x > 700) stage = 'results';
      else if (stage === 'results' && (y > 520 || (inputValue.startsWith('https://') && y > 330))) stage = 'article';
      else if (stage === 'article') stage = 'menu';
      else if (stage === 'copy') { stage = 'copied'; clipboard = copiedLink; }
    },
    swipe: async (...args) => { calls.push(['swipe', ...args.slice(0, 5)]); if (stage === 'menu') stage = 'copy';
      if (stage === 'copied' && restoreAfterCopy && args[3] > args[1]) { restoreAfterCopy = false; stage = 'article'; }
      if (stage === 'article' && args[3] > args[1]) resumedArticle = typeof resumedArticle === 'number' ? Math.max(0, resumedArticle - 1) : false; },
    back: async () => { calls.push(['back']); stage = stage === 'copied' || stage === 'article' ? 'results' : 'article'; },
  };
  const view = {activity: async () => ({package: 'com.tencent.mm', activity: activity()}),
    capture: async () => ({text: Promise.resolve({rows: rows()})})};
  return {flow: createWechatArticleFlow({screen, view, wait: async ms => { calls.push(['wait', ms]); await onWait?.(ms); }, now: () => 1}), calls,
    setResultPages: pages => { resultPages = pages; }, setStage: value => { stage = value; },
    setArticlePage: rows => { articlePage = rows; resumedArticle = false; }};
}

test('search tolerates the real blank first paint and restores keyboard, then returns arrays after an article', async () => {
  const {flow, calls} = fake({blankInput: true});
  const result = await flow.search({keyword: '安吉星', sort: 'all'});
  assert.equal(result.verified, true); assert.equal(result.cards.length, 4);
  assert.ok(calls.some(call => call[0] === 'ime' && call[1] === 'owner.keyboard/.IME'));
  assert.equal((await flow.openCard({card: result.cards[0]})).opened, true);
  assert.equal((await flow.copyLink()).shareUrl, shareUrl);
  const returned = await flow.returnToResults(); assert.equal(returned.length, 4);
  assert.equal((await flow.recoverResults()).length, 4);
});

test('Claude merged article tab opens its left half, then clipped titles and account bylines verify', async () => {
  for (const [index, header] of [[2, 's1-renew/072'], [3, 's1-renew/076']]) {
    const {flow, calls} = fake({resultPages: [t9('s1-renew-c/006'), t9('s1-renew/070')], articlePage: t9(header)});
    const result = await flow.search({keyword: '安吉星 续费', sort: 'all'});
    assert.ok(calls.some(call => call[0] === 'tap' && call[1] === 543 && call[2] === 308));
    assert.equal((await flow.openCard({card: result.cards[index]})).opened, true);
    assert.equal(calls.filter(call => call[0] === 'swipe').length, 0);
  }
});

test('Claude blank-to-shifted tab sequence waits before sliding, then recovers right after two left attempts', async () => {
  const shifted = t9('s2-week/007');
  const {flow, calls} = fake({resultPages: [t9('s2-week/006'), shifted, shifted, shifted, fixture('20-articles-loaded')]});
  assert.equal((await flow.search({keyword: '安吉星', sort: 'all'})).verified, true);
  const horizontal = calls.filter(call => call[0] === 'swipe');
  assert.deepEqual(horizontal, [['swipe', 920, 305, 290, 305, 1000], ['swipe', 920, 305, 290, 305, 1000], ['swipe', 290, 305, 920, 305, 1000]]);
  assert.ok(calls.findIndex(call => call[0] === 'wait' && call[1] === 800) < calls.findIndex(call => call[0] === 'swipe'));
});

test('four blank first paints wait 800ms each and can recover without any tab gesture', async () => {
  const blank = t9('s2-week/006');
  const {flow, calls} = fake({resultPages: [blank, blank, blank, blank, fixture('20-articles-loaded')]});
  assert.equal((await flow.search({keyword: '安吉星', sort: 'all'})).verified, true);
  assert.equal(calls.filter(call => call[0] === 'wait' && call[1] === 800).length, 4);
  assert.equal(calls.filter(call => call[0] === 'swipe').length, 0);
});

test('unpainted or unproven tab bars fail after four waits without horizontal gestures', async () => {
  for (const rows of [t9('s2-week/006'), [row('账号 评论', 200, 280)], [row('全部 视频 AI搜索', 100, 700)]]) {
    const {flow, calls} = fake({resultPages: [rows]});
    await assert.rejects(flow.search({keyword: '安吉星', sort: 'all'}), {code: 'article_tab_missing'});
    assert.equal(calls.filter(call => call[0] === 'wait' && call[1] === 800).length, 4);
    assert.equal(calls.filter(call => call[0] === 'swipe').length, 0);
  }
});

test('missing article tab has two bounded left and right gestures, and cancellation prevents further movement', async () => {
  const {flow, calls} = fake({resultPages: [t9('s2-week/007')]});
  await assert.rejects(flow.search({keyword: '安吉星', sort: 'all'}), {code: 'article_tab_missing'});
  assert.deepEqual(calls.filter(call => call[0] === 'swipe').map(call => call.slice(1, 4)), [[920, 305, 290], [920, 305, 290], [290, 305, 920], [290, 305, 920]]);
  const controller = new AbortController(), reason = Object.assign(new Error('stopped'), {code: 'user_stop'});
  const canceled = fake({resultPages: [t9('s2-week/006')], onWait: ms => { if (ms === 800) controller.abort(reason); }});
  await assert.rejects(canceled.flow.search({keyword: '安吉星', sort: 'all', signal: controller.signal}), {code: 'aborted'});
  assert.equal(canceled.calls.filter(call => call[0] === 'swipe').length, 0);
});

test('scrolled article results work after verified search while absent sorts and failed searches cannot establish context', async () => {
  const {flow, setResultPages} = fake({resultPages: [t9('s1-renew/070')]});
  await flow.search({keyword: '安吉星 续费', sort: 'all'});
  setResultPages([t9('s1-renew/080')]);
  assert.equal((await flow.readCards()).length, 4);
  assert.deepEqual(await flow.scroll(), {scrolled: true});
  const missing = fake({resultPages: [t9('s1-renew/080')]});
  await assert.rejects(missing.flow.search({keyword: '安吉星 续费', sort: 'all'}), {code: 'search_context_unverified'});
  // A present 不限 control can verify the initial page, but cannot establish the requested 最新 sort.
  const noLatest = t9('s1-renew/070').map(item => item.text.startsWith('不限') ? {...item, text: '不限'} : item);
  const failed = fake({resultPages: [noLatest]});
  await assert.rejects(failed.flow.search({keyword: '安吉星 续费', sort: 'latest'}), {code: 'sort_unverified'});
  failed.setResultPages([t9('s1-renew/070')]);
  const afterFailure = failed.calls.length;
  for (const operation of [() => failed.flow.readCards(), () => failed.flow.scroll(), () => failed.flow.openCard({card: {}}),
    () => failed.flow.recoverResults(), () => failed.flow.returnToResults()]) {
    await assert.rejects(operation(), {code: 'search_context_unverified'});
  }
  assert.equal(failed.calls.length, afterFailure, 'a failed search cannot authorize later device actions');
});

test('copy verifies the bottom menu text and allows the same link only with a fresh copy toast', async () => {
  const {flow, calls} = fake({stage: 'article', previousLink: shareUrl});
  assert.equal((await flow.copyLink()).shareUrl, shareUrl);
  assert.deepEqual(calls.find(call => call[0] === 'swipe'), ['swipe', 900, 1850, 330, 1850, 1100]);
  const taps = calls.filter(call => call[0] === 'tap');
  assert.ok(taps.at(-1)[2] > 1850, 'never taps recipient cards or forwarding controls');
  await assert.rejects(fake({stage: 'article', previousLink: shareUrl, toast: false}).flow.copyLink(), {code: 'link_not_copied'});
});

test('a copied foreign URL is rejected and an unexpected send confirmation is left without a tap', async () => {
  await assert.rejects(fake({stage: 'article', copiedLink: 'https://example.test/'}).flow.copyLink(), {code: 'link_not_copied'});
  const {flow, calls} = fake({stage: 'article', hazard: ACTIVITY.sendConfirm});
  await assert.rejects(flow.copyLink(), {code: 'unexpected_screen'});
  assert.deepEqual(calls, [['back']]);
});

test('unverified scope and unsupported sort are refused before phone input', async () => {
  for (const params of [{scope: 'followed'}, {sort: 'random'}, {duration: 'short'}]) {
    const {flow, calls} = fake();
    await assert.rejects(flow.search({keyword: '安吉星', ...params}), {code: 'unsupported_search'});
    assert.equal(calls.length, 0);
  }
});

test('an already-read article restores its body position: seek actual header before identity verification', async () => {
  const {flow, calls} = fake({resumedArticle: true});
  const result = await flow.search({keyword: '安吉星', sort: 'all'});
  assert.equal((await flow.openCard({card: result.cards[0]})).opened, true);
  assert.ok(calls.some(call => call[0] === 'swipe' && call[4] > call[2]), 'bounded reverse scroll returned to the header');
});

test('header seeking yields across bounded calls without reopening the result card', async () => {
  const {flow, calls} = fake({resumedArticle: 10});
  const result = await flow.search({keyword: '安吉星', sort: 'all'});
  const first = await flow.openCard({card: result.cards[0]});
  assert.equal(first.opened, false); assert.equal(first.hasMore, true); assert.equal(first.headerScrolls, 8);
  const second = await flow.openCard({card: result.cards[0]});
  assert.equal(second.opened, true); assert.equal(second.hasMore, false);
  assert.equal(calls.filter(call => call[0] === 'tap' && call[2] > 520 && call[2] < 800).length, 2,
    'one landing-field tap and one result-card tap; no repeated article opening');
});

test('T12 opening continuation keeps the requested card key when a reread changes one OCR character', async () => {
  const {flow, calls, setResultPages} = fake({resumedArticle: 10});
  const result = await flow.search({keyword: '安吉星', sort: 'all'});
  const card = result.cards[0];
  // Deliberately alter one recognized character in memory; the original real fixture remains untouched.
  const reread = fixture('20-articles-loaded').map(item => ({...item, text: item.text.replace('要不要续费', '要不要续貴')}));
  assert.notEqual(parseArticleCards(reread)[0].cardKey, card.cardKey);
  setResultPages([reread]);
  const first = await flow.openCard({card});
  assert.equal(first.opened, false); assert.equal(first.hasMore, true);
  const beforeWrongCard = calls.length;
  await assert.rejects(flow.openCard({card: result.cards[1]}), {code: 'article_identity_unverified'});
  assert.equal(calls.length, beforeWrongCard, 'a genuinely different requested card still cannot reuse the pending open');
  const second = await flow.openCard({card});
  assert.equal(second.opened, true); assert.equal(second.hasMore, false);
  assert.equal(calls.filter(call => call[0] === 'tap' && call[1] === parseArticleCards(reread)[0].tap.x
    && call[2] === parseArticleCards(reread)[0].tap.y).length, 1, 'continuation never reopens the card');
});

test('T12 recovery clears a failed pending open before the next card, from either article or results', async () => {
  for (const alreadyReturned of [false, true]) {
    const failure = Object.assign(new Error('OCR capture failed during header seeking'), {code: 'ocr_unavailable'});
    let failOnce = true, armed = false;
    const {flow, calls, setArticlePage, setStage} = fake({resumedArticle: 10, resultPages: [t9('s1-renew/070')],
      onWait: ms => { if (armed && ms === 600 && failOnce) { failOnce = false; throw failure; } }});
    const result = await flow.search({keyword: '安吉星 续费', sort: 'all'});
    armed = true;
    await assert.rejects(flow.openCard({card: result.cards[0]}), {code: 'ocr_unavailable'});
    if (alreadyReturned) setStage('results');
    assert.equal((await flow.recoverResults()).length, 4);
    setArticlePage(t9('s1-renew/072'));
    const next = await flow.openCard({card: result.cards[2]});
    assert.equal(next.opened, true); assert.equal(next.hasMore, false);
    assert.equal(calls.filter(call => call[0] === 'back').length, alreadyReturned ? 0 : 1);
  }
});

test('T12 real header with audio and AI metadata verifies on the normal card-opening path', async () => {
  const {flow} = fake({resultPages: [fixture('50-latest-loaded')], articlePage: fixture('t12-claude-header-012').rows});
  const result = await flow.search({keyword: '安吉星', sort: 'all'});
  assert.equal((await flow.openCard({card: result.cards[0]})).opened, true);
});

test('One Step overlay blocks article and home verification despite unchanged WeChat activity', async () => {
  for (const method of ['copyLink', 'parkHome']) {
    const {flow, calls} = fake({stage: 'article', oneStep: 'dais auo'});
    await assert.rejects(flow[method](), {code: 'system_overlay_blocked'});
    assert.equal(calls.filter(call => call[0] === 'tap' || call[0] === 'swipe').length, 0);
  }
});

test('a typed article URL opens only its 访问网页 domain card and continues header seeking without retyping', async () => {
  const {flow, calls} = fake({resumedArticle: 10, articleActivity: ARTICLE_LINK_ACTIVITY});
  const first = await flow.openArticleLink({url: shareUrl});
  assert.equal(first.opened, false); assert.equal(first.hasMore, true);
  const opened = await flow.openArticleLink({url: shareUrl});
  assert.equal(opened.opened, true); assert.equal(opened.title, '5年后安吉星要不要续费');
  assert.equal(calls.filter(call => call[0] === 'type').length, 1);
  assert.equal((await flow.copyLink()).shareUrl, shareUrl);
  await assert.rejects(fake().flow.openArticleLink({url: 'https://evil.test/s/article'}), {code: 'article_link_invalid'});
  await assert.rejects(fake({badLinkCard: true}).flow.openArticleLink({url: shareUrl}), {code: 'article_link_entry_unverified'});
});

test('menu icon OCR fallback requires a verified current article, and home waits for actual tab paint', async () => {
  const {flow, calls} = fake({missingMenu: true});
  const results = await flow.search({keyword: '安吉星', sort: 'all'});
  await flow.openCard({card: results.cards[0]});
  assert.equal((await flow.copyLink()).shareUrl, shareUrl);
  assert.ok(calls.some(call => call[0] === 'tap' && call[1] === 1000 && call[2] === 148));
  await assert.rejects(fake({stage: 'article', missingMenu: true}).flow.copyLink(), {code: 'share_sheet_unverified'});
  assert.equal((await fake({stage: 'article', staleHome: 1}).flow.parkHome()).parked, true);
});

test('a transient WebView proxy is waited out before input; a persistent proxy is never an allowed article', async () => {
  const transient = fake({stage: 'article', proxyReads: 2});
  assert.equal((await transient.flow.copyLink()).shareUrl, shareUrl);
  const persistent = fake({stage: 'article', hazard: 'com.tencent.mm.plugin.webview.stub.WebViewStubProxyUI'});
  await assert.rejects(persistent.flow.copyLink(), {code: 'screen_unverified'});
  assert.equal(persistent.calls.filter(call => call[0] !== 'wait').length, 0);
  await assert.rejects(fake({stage: 'article', hazard: 'com.tencent.mm.plugin.webview.ui.tools.WebViewUI'}).flow.copyLink(), {code: 'screen_unverified'});
});

test('an article header is not ready until its body has loaded and the header position stays stable', async () => {
  const {flow, calls} = fake({blankArticleReads: 2});
  const result = await flow.search({keyword: '安吉星', sort: 'all'});
  assert.equal((await flow.openCard({card: result.cards[0]})).opened, true);
  assert.equal(calls.filter(call => call[0] === 'swipe').length, 0, 'do not scroll a newly loading header');
});

test('a late restored body position after copy is rechecked and sought before body reader creation', async () => {
  const {flow, calls} = fake({restoreAfterCopy: true, copiedLink: `${shareUrl}?search_click_id=abc#wechat_redirect`});
  const result = await flow.search({keyword: '安吉星', sort: 'all'});
  await flow.openCard({card: result.cards[0]});
  assert.equal((await flow.copyLink()).shareUrl, `${shareUrl}?search_click_id=abc#wechat_redirect`);
  const waiting = await flow.readArticle({limit: 0, budgetMs: 2000});
  assert.equal(waiting.hasMore, true); assert.equal(waiting.pagesRead, 0); assert.equal(waiting.article.bodyReason, 'restoring_article_start');
  const read = await flow.readArticle({limit: 0});
  assert.ok(read.article.content.includes('一、先理清免费&付费边界'));
  assert.ok(calls.some(call => call[0] === 'swipe' && call[4] > call[2]));
  assert.equal(calls.filter(call => call[0] === 'type').length, 1);
});

test('supplemental reading requires the verified current article and a fresh copy, then keeps its restored position', async () => {
  await assert.rejects(fake({stage: 'article'}).flow.readArticle({bodyRequired: false}), {code: 'article_identity_unverified'});
  const {flow, calls} = fake({restoreAfterCopy: true});
  const result = await flow.search({keyword: '安吉星', sort: 'all'});
  await flow.openCard({card: result.cards[0]});
  await assert.rejects(flow.readArticle({bodyRequired: false}), {code: 'article_identity_unverified'});
  await flow.copyLink(); const before = calls.length;
  const read = await flow.readArticle({bodyRequired: false});
  assert.equal(read.hasMore, false); assert.equal(read.article.bodyStatus, 'delegated'); assert.equal(read.article.content, '');
  assert.equal(read.article.evidence.bodyEndObserved, true); assert.equal(read.comments.items.length, 2);
  assert.ok(calls.slice(before).filter(call => call[0] === 'swipe').every(call => call[4] < call[2]), 'no return to top');
  await assert.rejects(flow.readArticle(), {code: 'article_reader_mode_mismatch'});
  await flow.returnToResults(); await flow.openCard({card: result.cards[0]});
  await assert.rejects(flow.readArticle({bodyRequired: false}), {code: 'article_identity_unverified'}, 'copy proof cannot carry into another opening');
});
