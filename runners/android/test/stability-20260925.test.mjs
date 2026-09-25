import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseUiTree} from '../src/device/ui-tree.mjs';
import {resource} from '../src/device/douyin-profile.mjs';
import {readVerifiedDetail} from '../src/device/douyin-detail.mjs';
import {createAppiumClient} from '../src/device/appium.mjs';
import {createUiSession} from '../src/device/ui-session.mjs';
import {createAdbClient} from '../src/device/adb.mjs';
import {createForegroundGuard} from '../src/device/douyin-foreground.mjs';
import {createProfileSession} from '../src/device/profile-session.mjs';
import {createProfileAdapter} from '../src/device/profile-adapter.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {BudgetLedger} from '../src/core/budget.mjs';
import {runDiscoveryTask, faultDetails} from '../src/core/discovery-runner.mjs';
import {recordDiagnostic, readDiagnostics} from '../src/core/diagnostics.mjs';
import {diagnoseRunner} from '../src/daemon/diagnose.mjs';
import {runUp, describeOutcome} from '../src/cli/up-command.mjs';
import {fixtureTask, fixtureClock, fixturePermit, fixtureDevice} from './core-fixtures.mjs';
import {until} from './daemon-fixture.mjs';

const encode = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const node = (id, text = '', children = '', extra = {}) => `<android.widget.TextView ${Object.entries({
  package: 'com.ss.android.ugc.aweme', class: 'android.widget.TextView', 'resource-id': resource(id),
  text, displayed: 'true', enabled: 'true', bounds: '[0,0][100,100]', ...extra,
}).map(([key, value]) => `${key}="${encode(value)}"`).join(' ')}>${children}</android.widget.TextView>`;
const xml = body => `<hierarchy>${body}</hierarchy>`;
const tree = body => parseUiTree(xml(body));
const card = {title: '车机壁纸分享 #别克 #车机壁纸 @上海安吉星', author: '车主小王'};
const videoPage = (caption, author = '@' + card.author) => tree(node('desc', caption, '', {clickable: 'true'})
  + node('title', author, '', {'content-desc': '按钮'}) + node('vmj'));
const topicPage = () => tree(node('topic_title', '#车机壁纸 话题页面') + node('topic_count', '12.3万次播放'));
const TAP = {x: 801, y: 90, width: 852, height: 120};

// ---- Video caption expansion (the cause of last night's skipped video cards) ----

test('the inline 展开 is tapped at the caption end and any spacing before the UI 收起 is accepted', async () => {
  for (const [collapsed, expandedText] of [['车机壁纸分享 #别克…展开', `${card.title}\n收起`],
    ['车机壁纸分享 #别克... 展开', `${card.title}收起`], ['车机壁纸分享 #别克...展开', `${card.title}  收起`]]) {
    let expanded = false; const taps = [];
    const ui = {read: async () => videoPage(expanded ? expandedText : collapsed),
      clickId: async id => assert.fail(`the caption centre must never be clicked (${id})`),
      tapIdNearEnd: async id => { taps.push(id); expanded = true; return TAP; }};
    const detail = await readVerifiedDetail({ui, card});
    assert.equal(detail.title, card.title, collapsed);
    assert.deepEqual(taps, ['desc']);
  }
});

test('identity stays exact: a UI 收起 suffix is only removed when the rest equals the card', async () => {
  let expanded = false;
  const ui = {read: async () => videoPage(expanded ? '另一条完全不同的正文\n收起' : '车机壁纸分享 #别克... 展开'),
    tapIdNearEnd: async () => { expanded = true; return TAP; }};
  await assert.rejects(readVerifiedDetail({ui, card}), {code: 'detail_identity_unverified', stage: 'expanded', expandOutcome: 'mismatch'});
});

test('a tap that does not expand stops after three unchanged reads with a local-only diagnostic', async () => {
  let reads = 0; let clock = 0;
  const ui = {read: async () => { reads++; clock += 3000; return videoPage('车机壁纸分享 #别克... 展开'); },
    tapIdNearEnd: async () => TAP, currentActivity: async () => '.splash.SplashActivity'};
  await assert.rejects(readVerifiedDetail({ui, card, budgetMs: 40_000, now: () => clock}), error => {
    assert.equal(error.code, 'detail_identity_unverified');
    assert.equal(error.stage, 'expanded');
    assert.equal(error.expandOutcome, 'no_change');
    assert.equal(error.deviceSettled, true);
    assert.equal(error.diagnostic.card.title, card.title);
    assert.equal(error.diagnostic.detail.title, '车机壁纸分享 #别克... 展开');
    assert.deepEqual(error.diagnostic.tap, TAP);
    const uploaded = faultDetails(error);
    assert.equal(uploaded.expandOutcome, 'no_change');
    assert.equal(JSON.stringify(uploaded).includes(card.title), false, 'captions never reach uploaded details');
    assert.equal('diagnostic' in uploaded, false);
    return true;
  });
  assert.equal(reads, 4, 'one read finds the collapsed detail, three unchanged reads end the wait');
});

test('a tap that leaves the detail (for example a #topic page) is recognised after three reads', async () => {
  let expanded = false; let reads = 0;
  const ui = {read: async () => { reads++; return expanded ? topicPage() : videoPage('车机壁纸分享 #别克... 展开'); },
    tapIdNearEnd: async () => { expanded = true; return TAP; }};
  await assert.rejects(readVerifiedDetail({ui, card}), error => {
    assert.equal(error.expandOutcome, 'left_detail');
    assert.ok(error.diagnostic.texts.some(entry => entry.text.includes('话题页面')));
    return true;
  });
  assert.equal(reads, 4);
});

test('the caption tap is an element-relative clickGesture inside the located caption, never a centre click', async () => {
  const calls = [];
  const client = createAppiumClient({fetchImpl: async (url, init) => {
    calls.push({url, method: init.method, body: init.body ? JSON.parse(init.body) : null});
    if (url.endsWith('/elements')) return new Response(JSON.stringify({value: [{'element-6066-11e4-a52e-4f735466cecf': 'caption-1'}]}));
    if (url.endsWith('/rect')) return new Response(JSON.stringify({value: {x: 36, y: 1800, width: 852, height: 120}}));
    return new Response(JSON.stringify({value: null}));
  }});
  const ui = createUiSession({client, sessionId: 'session-1', resourceLocator: 'xpath'});
  assert.deepEqual(await ui.tapIdNearEnd('desc'), TAP);
  const gesture = calls.at(-1);
  assert.match(gesture.url, /\/session\/session-1\/execute\/sync$/u);
  assert.deepEqual(gesture.body, {script: 'mobile: clickGesture', args: [{elementId: 'caption-1', x: 801, y: 90}]});
  assert.equal(calls.some(call => call.url.endsWith('/click')), false);
  assert.throws(() => client.tapElementAt('session-1', 'caption-1', -1, 5), {code: 'invalid_tap'});
  assert.throws(() => client.tapElementAt('session-1', 'caption-1', 1.5, 5), {code: 'invalid_tap'});
});

// ---- Skipping policy and local diagnostics ----

const settled = (code, extra = {}) => Object.assign(new Error(code), {code, deviceSettled: true, ...extra});
function patternDevice(task, pattern) {
  const cards = [...pattern].map((kind, index) => ({cardId: `card-${index}`, title: `第${index}条`, author: '车友', kind}));
  return fixtureDevice(task, {
    readCards: async () => ({contextVerified: true, contextId: 'context-1', end: true, cards}),
    openCard: async ({card: selected}) => {
      if (selected.kind === 'F') {
        throw settled('detail_identity_unverified', {stage: 'expanded', expandOutcome: 'no_change',
          diagnostic: {card: {title: `秘密标题-${selected.cardId}`, author: '车友'}, stage: 'expanded'}});
      }
      return {identityVerified: true, cardId: selected.cardId, detailId: `detail-${selected.cardId}`,
        externalId: String(7_000_000_000_000_000_000n + BigInt(selected.cardId.slice(5)))};
    },
  });
}

test('isolated bad cards never stop a keyword; a successful capture resets the consecutive count', async () => {
  const store = new RunnerStore(':memory:');
  try {
    const task = fixtureTask(); const clock = fixtureClock();
    const {device, calls} = patternDevice(task, 'FFFFSFFFFSF');
    const result = await runDiscoveryTask({task, store, clock, device, permit: fixturePermit(task, clock)});
    assert.equal(result.status, 'completed');
    assert.equal(result.reason, 'results_end');
    assert.equal(result.stats.links, 2);
    assert.equal(result.stats.skippedCards, 9);
    assert.equal(calls.filter(name => name === 'recoverResults').length, 9);
  } finally { store.close(); }
});

test('skipped cards and the finished run leave local notes, and nothing uploaded carries a caption', async () => {
  const store = new RunnerStore(':memory:');
  try {
    const task = fixtureTask(); const clock = fixtureClock();
    const {device} = patternDevice(task, 'SFS');
    const result = await runDiscoveryTask({task, store, clock, device, permit: fixturePermit(task, clock)});
    assert.equal(result.status, 'completed');
    const notes = readDiagnostics(store);
    assert.deepEqual(notes.map(entry => entry.event), ['card_skipped', 'task_finished']);
    assert.equal(notes[0].keyword, task.keyword);
    assert.equal(notes[0].code, 'detail_identity_unverified');
    assert.equal(notes[0].operation, 'openCard');
    assert.equal(notes[0].diagnostic.card.title, '秘密标题-card-1');
    assert.equal(notes[1].status, 'completed');
    assert.equal(notes[1].stats.skippedCards, 1);
    assert.equal(JSON.stringify(result).includes('秘密标题'), false, 'the completion sent to the server has no caption');
    for (let index = 0; index < 5; index++) recordDiagnostic(store, {event: 'extra', index}, {limit: 3});
    assert.equal(readDiagnostics(store).length, 3, 'the local ring stays bounded');
  } finally { store.close(); }
});

test('a timed-out action names the operation that was in flight', async () => {
  const store = new RunnerStore(':memory:');
  try {
    const task = fixtureTask(); const clock = fixtureClock();
    const {device} = fixtureDevice(task, {openCard: () => new Promise(() => {})});
    const result = await runDiscoveryTask({task, store, clock, device, permit: fixturePermit(task, clock), actionTimeoutMs: 20});
    assert.equal(result.reason, 'device_action_timeout');
    assert.equal(result.details.operation, 'openCard');
    assert.equal(result.stopConfirmationRequired, true);
    assert.equal(readDiagnostics(store).at(-1).operation, 'openCard');
  } finally { store.close(); }
});

// ---- Session start-up: helper focus flash, step labels, relaunch target ----

const ownProfile = xml(node('504', '抖音号：starvoice') + node('whh', '编辑主页') + node('0p3', '', '', {'content-desc': '首页，按钮'}));
const home = xml(node('hmy', '', '', {'content-desc': '搜索'}) + node('0p3', '', '', {'content-desc': '我，按钮'}));
const notDouyin = xml('<node package="io.appium.settings" displayed="true" enabled="true" bounds="[0,0][100,100]" text="Appium Settings" />');
function fakeAppium(sources) {
  let index = 0;
  return {
    createProfileSession: async () => ({sessionId: 'session-1'}), isLocked: async () => false,
    settings: async () => ({wakeLockTimeout: 0, enableTopmostWindowFromActivePackage: false}),
    source: async () => sources[Math.min(index++, sources.length - 1)],
    findElements: async () => [{'element-6066-11e4-a52e-4f735466cecf': 'element-1'}], clickElement: async () => null,
    back: async () => null, status: async () => ({ready: true}), deleteSession: async () => null, isSessionActive: async () => false,
  };
}
const fakeAdb = () => ({inspect: async () => ({model: 'DE106', apiLevel: 27}), inspectApp: async () => ({appVersion: '40.6.0'}),
  helperPids: async () => [], listDevices: async () => [{serial: 'phone-1', state: 'device'}], stopHelper: async () => null});

test('a new session waits for Douyin to regain focus before reading, and each start-up step is labelled', async () => {
  const order = [];
  const session = createProfileSession({serial: 'phone-1', profileId: 'douyin-40.6.0-de106-api27-p0', adb: fakeAdb(),
    client: {...fakeAppium([ownProfile, home]), isLocked: async () => { order.push('lock_check'); return false; }}});
  const state = await session.inspect({afterCreate: async () => { order.push('after_create'); }});
  assert.equal(state.loggedIn, true);
  assert.deepEqual(order, ['after_create', 'lock_check'], 'the focus wait runs right after creation, before any screen read');
  const failing = createProfileSession({serial: 'phone-1', profileId: 'douyin-40.6.0-de106-api27-p0', adb: fakeAdb(),
    client: fakeAppium([notDouyin])});
  await assert.rejects(failing.inspect(), {code: 'douyin_not_foreground', stage: 'inspect:login_check'});
});

test('the adapter waits read-only for Douyin after a new session and relaunches it at most once', async () => {
  const calls = [];
  const foreground = {
    ensure: async ({launch}) => { calls.push(launch ? 'relaunch' : 'check'); return {package: 'com.ss.android.ugc.aweme', launched: launch}; },
    waitFor: async () => { calls.push('wait'); return {douyin: false, focus: 'io.appium.settings'}; },
  };
  const adapter = createProfileAdapter({serial: 'phone-1', adb: fakeAdb(), profileId: 'douyin-40.6.0-de106-api27-p0',
    client: fakeAppium([ownProfile, home]), foreground});
  const state = await adapter.inspect({});
  assert.equal(state.readyForSearch, true);
  assert.deepEqual(calls, ['check', 'wait', 'relaunch']);
});

test('waitFor is read-only and reports Douyin once it holds focus again', async () => {
  const focus = ['  mCurrentFocus=Window{1 u0 io.appium.settings/io.appium.settings.Settings}',
    '  mCurrentFocus=Window{2 u0 com.ss.android.ugc.aweme/com.ss.android.ugc.aweme.splash.SplashActivity}'];
  let index = 0; const launches = [];
  const guard = createForegroundGuard({serial: 'phone-1', wait: async () => {}, adb: {
    windowFocus: async () => focus[Math.min(index++, focus.length - 1)], resumedActivity: async () => '',
    launchActivity: async (...args) => { launches.push(args); }}});
  assert.deepEqual(await guard.waitFor({waitMs: 5000}), {douyin: true, focus: 'com.ss.android.ugc.aweme'});
  assert.equal(launches.length, 0);
});

test('the new ADB probes are read-only and pinned to the phone', async () => {
  const calls = [];
  const adb = createAdbClient({command: async (_file, args) => {
    calls.push(args);
    return {stdout: args.at(-1).startsWith('settings') ? '3\n' : 'E lowmemorykiller: Kill io.appium.uiautomator2.server\n', stderr: ''};
  }});
  assert.equal(await adb.stayOnWhilePluggedIn('829d89'), 3);
  assert.deepEqual(await adb.automationLog('829d89'), ['E lowmemorykiller: Kill io.appium.uiautomator2.server']);
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 7), ['-H', '127.0.0.1', '-P', '5037', '-s', '829d89', 'shell']);
    assert.doesNotMatch(args[7], /settings put|pm clear|force-stop|am start|input /u);
  }
});

// ---- Operator window and local diagnose ----

test('each finished keyword is one plain line, and early stops say the dispatcher will retry', () => {
  assert.equal(describeOutcome({keyword: '别克壁纸', status: 'completed_with_warnings', reason: 'no_new_cards', links: 13, skipped: 1}),
    '【完成】别克壁纸 · 找到 13 条 · 跳过 1 个无法核对的作品 · 结果已看完');
  assert.equal(describeOutcome({keyword: '君越壁纸', status: 'needs_action', reason: 'appium_http_error', links: 19, skipped: 0}),
    '【提前结束】君越壁纸 · 找到 19 条 · 手机自动化服务意外中断 · 调度中心会自动重试或交给其它节点');
});

test('the one-click window warns when the phone may sleep and prints finished keywords', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'android-up-stability-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  writeFileSync(join(dir, 'connection.json'), JSON.stringify({baseUrl: 'http://127.0.0.1:3999', deviceId: 'PHONE-1',
    clientUuid: randomUUID(), agentId: 'agent-1', agentToken: 'tok-1', tenantId: 'tenant-1', simulation: false,
    deviceProfile: 'douyin-40.6.0-de106-api27-p0', adbPath: '/opt/homebrew/bin/adb', appiumUrl: 'http://127.0.0.1:4723',
    appiumLaunch: {node: 'node', entry: '/tool/main.js', args: [], env: {}}}));
  const out = []; let daemon; let finish;
  const deps = {
    adb: {startServer: async () => {}, stayOnWhilePluggedIn: async () => 0},
    ensureAppium: async () => ({started: false, child: null}), stopAppium: async () => {},
    createDaemon: () => (daemon = {ready: false, deviceReason: 'device_asleep', blocked: null, lastOutcome: null,
      run: () => new Promise(resolve => { finish = () => resolve({deviceClosureRequired: false}); }), requestStop: () => finish?.()}),
    onSignals: () => () => {}, sleep: () => new Promise(resolve => setTimeout(resolve, 1)), watchMs: 1,
  };
  const running = runUp({'state-dir': dir}, {env: {}, stdout: line => out.push(line), deps});
  await until(() => out.some(line => line.includes('手机已息屏')));
  daemon.ready = true; daemon.deviceReason = null;
  daemon.lastOutcome = {keyword: '别克壁纸', status: 'completed', reason: 'results_end', links: 3, skipped: 0, at: 1};
  await until(() => out.some(line => line.startsWith('【完成】别克壁纸')));
  daemon.requestStop(); await running;
  assert.ok(out.some(line => line.includes('保持唤醒状态')), 'the stay-awake hint is shown when the setting is off');
});

test('diagnose lists recent runs with their keyword and the local notes about problems', () => {
  const store = new RunnerStore(':memory:');
  try {
    const task = fixtureTask(); const clock = fixtureClock();
    const ledger = new BudgetLedger({task, store, clock});
    ledger.beforeCard(); ledger.noteSkippedCard(); ledger.finish('needs_action', 'detail_identity_unverified');
    recordDiagnostic(store, {at: new Date(clock.wallNow()).toISOString(), event: 'card_skipped', itemId: task.identity.itemId,
      keyword: task.keyword, code: 'detail_identity_unverified', diagnostic: {expandOutcome: 'no_change'}});
    recordDiagnostic(store, {at: new Date(clock.wallNow()).toISOString(), event: 'task_finished', itemId: task.identity.itemId,
      keyword: task.keyword, status: 'needs_action', reason: 'detail_identity_unverified'});
    const report = diagnoseRunner(store, {hours: 1, now: clock.wallNow() + 1000});
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0].keyword, task.keyword);
    assert.equal(report.runs[0].skipped, 1);
    assert.equal(report.summary.endedEarly, 1);
    assert.deepEqual(report.problems.map(entry => entry.event), ['card_skipped', 'task_finished']);
  } finally { store.close(); }
});
