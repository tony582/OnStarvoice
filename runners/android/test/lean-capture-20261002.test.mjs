// 2026-10-02: a captured work cost 33 s on the DE106, most of it in checks that never found anything in nine days
// (474 runs, 1,137 works): proving login on 我 before every keyword, reopening the filter panel after every work,
// and unfolding captions to compare them in full. Now login is proven on 我 once per Runner process and again after
// the Runner starts Douyin, the filters are read after the search and after a recovery, and nothing on a detail is
// tapped (the copied link is the work's identity).
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUiTree} from '../src/device/ui-tree.mjs';
import {DeviceError} from '../src/device/bounded.mjs';
import {resource, DOUYIN_P0_PROFILE} from '../src/device/douyin-profile.mjs';
import {verifyLoginAndSearchEntry} from '../src/device/douyin-readiness.mjs';
import {createForegroundGuard} from '../src/device/douyin-foreground.mjs';
import {createProfileAdapter} from '../src/device/profile-adapter.mjs';
import {createDouyinCalibrationFlow} from '../src/calibration/douyin-flow.mjs';

const encode = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const node = (id, text = '', children = '', extra = {}) => `<android.widget.TextView ${Object.entries({
  package: 'com.ss.android.ugc.aweme', class: 'android.widget.TextView', 'resource-id': resource(id),
  text, displayed: 'true', enabled: 'true', bounds: '[0,0][100,100]', ...extra,
}).map(([key, value]) => `${key}="${encode(value)}"`).join(' ')}>${children}</android.widget.TextView>`;
const xml = body => `<hierarchy>${body}</hierarchy>`;
const tabs = selected => node('0p3', '', '', {'content-desc': '首页，按钮', selected: String(selected === 'home')})
  + node('0p3', '', '', {'content-desc': '我，按钮', selected: String(selected === 'me')});
const PAGES = {
  home: xml(node('hmy', '', '', {'content-desc': '搜索'}) + tabs('home')),
  friends: xml(node('hmy', '', '', {'content-desc': '搜索'}) + tabs('friends')),
  me: xml(node('504', '抖音号：starvoice') + node('whh', '编辑主页') + tabs('me')),
  results: xml(node('et_search_kw', '别克壁纸') + node('tab', '综合', '', {'resource-id': 'android:id/text1', selected: 'true'})),
  loginWall: xml(node('login_title', '点击登录') + tabs('home')),
  unknown: xml(node('webview_title', '活动页面')),
};

// ---- The login check itself (douyin-readiness) ----

function screenUi(start, {backTo = {results: 'home', friends: 'home', me: 'home', unknown: 'unknown'}, slowFirst = false} = {}) {
  let page = start, clock = 0, first = slowFirst;
  const calls = [];
  const ui = {
    read: async () => { calls.push('read'); clock += first ? 6000 : 500; first = false; return parseUiTree(PAGES[page]); },
    back: async () => { calls.push('back'); page = backTo[page] ?? page; },
    clickXPath: async selector => {
      if (selector.includes('我，按钮')) { calls.push('tap:me'); page = 'me'; }
      else if (selector.includes('首页，按钮')) { calls.push('tap:home'); page = 'home'; }
      else assert.fail(`unexpected tap ${selector}`);
    },
    waitFor: async predicate => { calls.push('read'); const tree = parseUiTree(PAGES[page]);
      if (!predicate(tree)) throw new DeviceError('device_timeout', 'fixture: the awaited screen did not appear'); return tree; },
  };
  return {ui, calls, now: () => clock};
}

test('with login proven, a keyword that starts on Douyin home only reads it: no tap at all', async () => {
  const {ui, calls, now} = screenUi('home');
  const state = await verifyLoginAndSearchEntry(ui, {ownProfileProven: true, now});
  assert.deepEqual(state, {loggedIn: true, challenge: false, loginCheck: 'retained'});
  assert.deepEqual(calls, ['read']);
});

test('without the proof the own profile is visited as before, and the result says so', async () => {
  const {ui, calls, now} = screenUi('home');
  const state = await verifyLoginAndSearchEntry(ui, {now});
  assert.equal(state.loginCheck, 'own_profile');
  assert.deepEqual(calls, ['read', 'tap:me', 'read', 'tap:home', 'read']);
});

test('with login proven, other starting screens return to home without ever opening 我', async () => {
  for (const [start, expected] of [
    ['results', ['read', 'back', 'read']],                      // back lands on home: nothing to tap
    ['friends', ['read', 'tap:home', 'read']],                  // another main tab: one tap on 首页
    ['me', ['read', 'tap:home', 'read']],                       // the own profile itself: one tap on 首页
  ]) {
    const {ui, calls, now} = screenUi(start);
    const state = await verifyLoginAndSearchEntry(ui, {ownProfileProven: true, now});
    assert.equal(state.loginCheck, 'retained', start);
    assert.deepEqual(calls, expected, start);
    assert.equal(calls.includes('tap:me'), false, start);
  }
});

test('with login proven, a slow home feed item is still moved on before anything else happens', async () => {
  const {ui, calls, now} = screenUi('home', {slowFirst: true});
  const skips = [];
  const state = await verifyLoginAndSearchEntry(ui, {ownProfileProven: true, now, feedSettleMs: 1,
    skipFeedItem: async () => { skips.push('swipe'); return true; }});
  assert.deepEqual([state.loginCheck, state.feedSkips], ['retained', 1]);
  assert.deepEqual(calls, ['read', 'read']);
  assert.equal(skips.length, 1);
});

test('with login proven, a login or verification prompt still stops the task before any back or tap', async () => {
  const {ui, calls, now} = screenUi('loginWall');
  await assert.rejects(verifyLoginAndSearchEntry(ui, {ownProfileProven: true, now}), {code: 'login_or_challenge_required'});
  assert.deepEqual(calls, ['read']);
});

test('with login proven, a screen with no way back to the main tabs is refused after the same bounded backs', async () => {
  const {ui, calls, now} = screenUi('unknown');
  await assert.rejects(verifyLoginAndSearchEntry(ui, {ownProfileProven: true, now}), {code: 'login_state_unverified'});
  assert.equal(calls.filter(call => call === 'back').length, 6);
  assert.equal(calls.some(call => call.startsWith('tap:')), false);
});

// ---- The login proof across tasks (profile adapter + real foreground guard) ----

const DOUYIN_FOCUS = '  mCurrentFocus=Window{7918cc1 u0 com.ss.android.ugc.aweme/com.ss.android.ugc.aweme.splash.SplashActivity}';
const HELPER_FOCUS = '  mCurrentFocus=Window{2b u0 io.appium.settings/io.appium.settings.Settings}';
const LAUNCHER_FOCUS = '  mCurrentFocus=Window{9 u0 com.smartisanos.launcher/com.smartisanos.launcher.Launcher}';

function phone() {
  const state = {page: 'home', focus: DOUYIN_FOCUS, focusAfterSession: null, meShows: 'me', launches: 0, clock: 1_000_000};
  const taps = [];
  let lastSelector = null, sessions = 0;
  const adb = {
    inspect: async () => ({model: 'DE106', apiLevel: '27'}), inspectApp: async () => ({appVersion: DOUYIN_P0_PROFILE.version}),
    listDevices: async () => [{serial: 'phone-1', state: 'device'}], helperPids: async () => [], stopHelper: async () => null,
    powerState: async () => 'mWakefulness=Awake', keyguardState: async () => 'mShowingLockscreen=false',
    windowFocus: async () => state.focus, resumedActivity: async () => '',
    launchActivity: async () => { state.launches++; state.focus = DOUYIN_FOCUS; state.page = 'home'; return {launched: true}; },
    swipeUp: async () => assert.fail('the feed reads quickly here'),
  };
  const client = {
    status: async () => ({ready: true}),
    createProfileSession: async () => {
      sessions++;
      if (state.focusAfterSession) { state.focus = state.focusAfterSession; state.focusAfterSession = null; }
      return {sessionId: `session-${sessions}`};
    },
    isLocked: async () => false, settings: async () => ({wakeLockTimeout: 0, enableTopmostWindowFromActivePackage: false}),
    source: async () => PAGES[state.page],
    findElements: async (id, using, value) => { lastSelector = value; return [{'element-6066-11e4-a52e-4f735466cecf': 'element-1'}]; },
    clickElement: async () => {
      if (lastSelector.includes('我，按钮')) { taps.push('me'); state.page = state.meShows; }
      else if (lastSelector.includes('首页，按钮')) { taps.push('home'); state.page = 'home'; }
      else assert.fail(`unexpected tap ${lastSelector}`);
    },
    back: async () => { state.page = 'home'; },
    deleteSession: async () => null, isSessionActive: async () => false,
  };
  const foreground = createForegroundGuard({adb, serial: 'phone-1', pollMs: 1, now: () => state.clock,
    wait: async () => { state.clock += 1000; }});
  const adapter = () => createProfileAdapter({serial: 'phone-1', profileId: DOUYIN_P0_PROFILE.id, adb, client, foreground});
  return {state, taps, adapter, foreground};
}
async function task(adapter, taps) {
  taps.length = 0;
  try { return await adapter.inspect({}); }
  finally { await adapter.close(); }
}

test('login is proven on 我 for the first task of a Runner process and not again for the next tasks', async () => {
  const {taps, adapter} = phone();
  const runner = adapter();
  assert.equal((await task(runner, taps)).loginCheck, 'own_profile');
  assert.deepEqual(taps, ['me', 'home']);
  for (let next = 0; next < 3; next++) {
    const state = await task(runner, taps);
    assert.deepEqual([state.loginCheck, state.loggedIn, state.challenge], ['retained', true, false]);
    assert.deepEqual(taps, [], 'a keyword that starts on home taps nothing');
  }
  // A new Runner process holds no proof: nothing is persisted.
  assert.equal((await task(adapter(), taps)).loginCheck, 'own_profile');
  assert.deepEqual(taps, ['me', 'home']);
});

test('after the Runner starts Douyin from an idle probe, the next task proves login on 我 again', async () => {
  const {state, taps, adapter, foreground} = phone();
  const runner = adapter();
  await task(runner, taps);
  state.focus = LAUNCHER_FOCUS;
  const probe = await runner.probe({});
  assert.deepEqual([probe.readyForSearch, probe.foreground.launched, foreground.launches], [true, true, 1]);
  assert.equal((await task(runner, taps)).loginCheck, 'own_profile');
  assert.deepEqual(taps, ['me', 'home']);
  assert.equal((await task(runner, taps)).loginCheck, 'retained');
});

test('a relaunch while the session starts is seen by that same task', async () => {
  const {state, taps, adapter, foreground} = phone();
  const runner = adapter();
  await task(runner, taps);
  state.clock += 120_000;                       // outside the launcher's rate limit
  state.focusAfterSession = HELPER_FOCUS;       // the helper keeps focus and Douyin has to be started again
  const result = await task(runner, taps);
  assert.equal(foreground.launches, 1);
  assert.equal(result.loginCheck, 'own_profile');
  assert.deepEqual(taps, ['me', 'home']);
});

test('a login check that fails leaves no proof, so the next task checks 我 again', async () => {
  const {state, taps, adapter} = phone();
  const runner = adapter();
  state.meShows = 'loginWall';                  // 我 shows a login prompt: the account is logged out
  await assert.rejects(task(runner, taps), {code: 'login_or_challenge_required'});
  assert.deepEqual(taps, ['me']);
  state.meShows = 'me'; state.page = 'home';  // the owner logs in again
  assert.equal((await task(runner, taps)).loginCheck, 'own_profile');
  assert.deepEqual(taps, ['me', 'home']);
});

test('with the proof held, a login prompt on screen still stops the task without any tap', async () => {
  const {state, taps, adapter} = phone();
  const runner = adapter();
  await task(runner, taps);
  state.page = 'loginWall';
  await assert.rejects(task(runner, taps), {code: 'login_or_challenge_required'});
  assert.deepEqual(taps, []);
});

// ---- Filters: read after the search and after a recovery, not after every work ----

const keyword = '安吉星壁纸';
const card = {title: '安吉星车机壁纸上新，这次的秋天配色很好看 #别克', author: '真实车主'};
const header = node('et_search_kw', keyword) + node('tab', '综合', '', {'resource-id': 'android:id/text1', selected: 'true'});
const resultsPage = parseUiTree(xml(header + node('b87', '', node('desc', card.title) + node('ab0', card.author))));
const otherResults = parseUiTree(xml(node('et_search_kw', '别的关键词')
  + node('tab', '综合', '', {'resource-id': 'android:id/text1', selected: 'true'})));
// A folded video caption: before 0.2.9 the runner tapped its 展开 to compare the full text.
const videoPage = parseUiTree(xml(node('desc', '安吉星车机壁纸上新，这次的... 展开', '', {clickable: 'true'})
  + node('title', '@真实车主', '', {'content-desc': '按钮'}) + node('vmj')));
const group = (label, selected) => node('uxo', '', node('hdi', label)
  + node('urc', '', node('rmy', selected), {'content-desc': `已选中，${selected}，按钮`}));
const filterPanel = parseUiTree(xml(group('排序依据', '最新发布') + group('发布时间', '一天内') + group('视频时长', '不限')
  + group('搜索范围', '不限') + group('内容形式', '不限')));

function resultsPhone() {
  let current = resultsPage, clipboard = 'original', backTo = resultsPage;
  const actions = [];
  const counts = {filterPanels: 0};
  const ui = {
    setWindowScope: async () => {},
    read: async () => current,
    waitFor: async predicate => {
      if (!predicate(current)) throw new DeviceError('device_timeout', 'fixture: the awaited screen did not appear');
      return current;
    },
    clickXPath: async selector => {
      if (selector.includes('筛选，按钮')) { counts.filterPanels++; current = filterPanel; }
      else if (selector.includes("content-desc='复制链接'")) {
        actions.push('copy');
        clipboard = `看看【${card.author}的视频作品】安吉星车机... https://v.douyin.com/abc123/`;
        current = videoPage;
      } else if (selector.includes(card.title)) { actions.push('card'); current = videoPage; }
      else assert.fail(`unexpected selector ${selector}`);
    },
    clickId: async id => {
      if (id === 'zsg') current = resultsPage;
      else if (id === 'vmj') { actions.push('vmj'); current = parseUiTree(xml(node('option', '', '', {'content-desc': '复制链接'}))); }
      else assert.fail(`nothing else on the detail is tapped (${id})`);
    },
    back: async () => { actions.push('back'); current = backTo; },
    tapIdNearEnd: async () => assert.fail('captions are never unfolded'),
    getClipboard: async () => clipboard,
    setClipboard: async text => { clipboard = text; },
  };
  return {ui, actions, counts, returnTo: page => { backTo = page; }};
}

test('a folded video is captured with one card click, the share controls only, and no filter panel on the way back', async () => {
  const phone = resultsPhone();
  const flow = createDouyinCalibrationFlow({ui: phone.ui});
  const search = await flow.adoptCurrentSearch({keyword, filters: {sort: '最新发布', time: '一天内'}});
  assert.equal(phone.counts.filterPanels, 1, 'the filters are read once for the search');
  const result = await flow.capture({card: search.cards[0]});
  assert.deepEqual([result.kind, result.title, result.cardDetailMatched], ['video', card.title, true]);
  assert.equal('filtersRetained' in result, false);
  assert.deepEqual(phone.actions, ['card', 'vmj', 'copy', 'back']);
  assert.equal(phone.counts.filterPanels, 1, 'returning from a work does not open the filter panel');
  // A recovery still proves the filters again.
  await flow.recoverResults({});
  assert.equal(phone.counts.filterPanels, 2);
});

test('returning from a work still requires the verified results page of this keyword', async () => {
  const phone = resultsPhone();
  const flow = createDouyinCalibrationFlow({ui: phone.ui});
  const search = await flow.adoptCurrentSearch({keyword, filters: {sort: '最新发布', time: '一天内'}});
  await flow.openCard({card: search.cards[0]});
  phone.returnTo(otherResults);
  await assert.rejects(flow.returnToResults({}), {code: 'device_timeout'});
  // The same keyword is not enough: the 综合 tab must be selected and no filter panel may be open.
  const otherTab = parseUiTree(xml(node('et_search_kw', keyword)
    + node('tab', '综合', '', {'resource-id': 'android:id/text1', selected: 'false'})
    + node('b87', '', node('desc', card.title) + node('ab0', card.author))));
  const panelOpen = parseUiTree(xml(header + node('b87', '', node('desc', card.title) + node('ab0', card.author))
    + group('排序依据', '最新发布')));
  for (const [label, page] of [['综合 tab not selected', otherTab], ['filter panel still open', panelOpen]]) {
    phone.returnTo(resultsPage);
    await flow.recoverResults({});
    await flow.openCard({card: search.cards[0]});
    phone.returnTo(page);
    await assert.rejects(flow.returnToResults({}), {code: 'device_timeout'}, label);
  }
  // And the verified results page is accepted without opening the filter panel.
  phone.returnTo(resultsPage);
  await flow.recoverResults({});
  const panels = phone.counts.filterPanels;
  await flow.openCard({card: search.cards[0]});
  assert.equal((await flow.returnToResults({})).verified, true);
  assert.equal(phone.counts.filterPanels, panels);
});
