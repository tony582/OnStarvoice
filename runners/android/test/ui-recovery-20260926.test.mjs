import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUiTree} from '../src/device/ui-tree.mjs';
import {resource} from '../src/device/douyin-profile.mjs';
import {createProfileSession} from '../src/device/profile-session.mjs';
import {UNREADABLE_SCREEN_BACKS} from '../src/device/douyin-readiness.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {runDiscoveryTask} from '../src/core/discovery-runner.mjs';
import {readDiagnostics} from '../src/core/diagnostics.mjs';
import {fixtureTask, fixtureClock, fixturePermit, fixtureDevice} from './core-fixtures.mjs';

// 2026-09-26: after one keyword the phone stayed on a search results page whose hierarchy the
// parser rejected. Every later keyword read that same page first and ended invalid_ui_source in
// about ten seconds, using up all attempts of the whole batch.

const node = (id, text = '', extra = {}) => `<android.widget.TextView ${Object.entries({
  package: 'com.ss.android.ugc.aweme', class: 'android.widget.TextView', 'resource-id': resource(id),
  text, displayed: 'true', enabled: 'true', bounds: '[0,0][100,100]', ...extra,
}).map(([key, value]) => `${key}="${value}"`).join(' ')} />`;
const xml = body => `<hierarchy>${body}</hierarchy>`;
const ownProfile = xml(node('504', '抖音号：starvoice') + node('whh', '编辑主页') + node('0p3', '', {'content-desc': '首页，按钮'}));
const home = xml(node('hmy', '', {'content-desc': '搜索'}) + node('0p3', '', {'content-desc': '我，按钮'}));
const unreadable = xml(node('desc', '秘密标题&#11;'));

function fakeAppium(sources, calls) {
  let index = 0;
  return {
    createProfileSession: async () => ({sessionId: 'session-1'}), isLocked: async () => false,
    settings: async () => ({wakeLockTimeout: 0, enableTopmostWindowFromActivePackage: false}),
    source: async () => { calls.push('read'); return sources[Math.min(index++, sources.length - 1)]; },
    findElements: async () => [{'element-6066-11e4-a52e-4f735466cecf': 'element-1'}], clickElement: async () => null,
    back: async () => { calls.push('back'); return null; }, status: async () => ({ready: true}),
    deleteSession: async () => null, isSessionActive: async () => false,
  };
}
const fakeAdb = () => ({inspect: async () => ({model: 'DE106', apiLevel: 27}), inspectApp: async () => ({appVersion: '40.6.0'}),
  helperPids: async () => [], listDevices: async () => [{serial: 'phone-1', state: 'device'}], stopHelper: async () => null});
const session = (sources, calls) => createProfileSession({serial: 'phone-1', profileId: 'douyin-40.6.0-de106-api27-p0',
  adb: fakeAdb(), client: fakeAppium(sources, calls)});

test('a parser rejection names its rule with sizes and code points only', () => {
  const cases = [
    [unreadable, {parser: 'invalid_code_point', codePoint: 11}],
    [xml('<node text="x" text="y"/>'), {parser: 'duplicate_attribute'}],
    [xml('<node text="&unknown;"/>'), {parser: 'unknown_entity'}],
    [xml('<node>' .repeat(130) + '</node>'.repeat(130)), {parser: 'too_deep'}],
    [xml('<node>stray</node>'), {parser: 'stray_text'}],
    ['<!DOCTYPE x><hierarchy/>', {parser: 'markup_declaration'}],
    [xml('<node>'), {parser: 'unbalanced_tag'}],
    ['<hierarchy><node>', {parser: 'incomplete_document'}],
  ];
  for (const [source, expected] of cases) {
    let error;
    try { parseUiTree(source); } catch (caught) { error = caught; }
    assert.equal(error?.code, 'invalid_ui_source', expected.parser);
    for (const [key, value] of Object.entries(expected)) assert.equal(error.diagnostic[key], value, expected.parser);
    assert.equal(JSON.stringify(error.diagnostic).includes('秘密'), false, 'no page text');
    for (const value of Object.values(error.diagnostic)) {
      assert.ok(typeof value === 'number' || value === error.diagnostic.parser, `${expected.parser}: only numbers besides the rule`);
    }
  }
  assert.equal(parseUiTree(ownProfile).nodes.length, 4, 'valid hierarchies are unchanged');
});

test('the login check steps back out of an unreadable screen and then continues', async () => {
  const calls = [];
  const state = await session([unreadable, unreadable, ownProfile, home], calls).inspect({});
  assert.equal(state.loggedIn, true);
  assert.deepEqual(calls.slice(0, 5), ['read', 'back', 'read', 'back', 'read']);
});

test('a screen that stays unreadable fails after a bounded number of back presses', async () => {
  const calls = [];
  await assert.rejects(session([unreadable], calls).inspect({}), error => {
    assert.equal(error.code, 'invalid_ui_source');
    assert.equal(error.stage, 'inspect:login_check');
    assert.equal(error.backPresses, UNREADABLE_SCREEN_BACKS);
    assert.equal(error.diagnostic.parser, 'invalid_code_point');
    return true;
  });
  assert.equal(calls.filter(call => call === 'back').length, UNREADABLE_SCREEN_BACKS);
  assert.equal(calls.filter(call => call === 'read').length, UNREADABLE_SCREEN_BACKS + 1);
});

test('the parser rule reaches the local diagnose note but not the uploaded completion', async () => {
  const store = new RunnerStore(':memory:');
  try {
    const task = fixtureTask(); const clock = fixtureClock();
    const {device} = fixtureDevice(task, {inspect: async () => parseUiTree(unreadable)});
    const result = await runDiscoveryTask({task, store, clock, device, permit: fixturePermit(task, clock)});
    assert.equal(result.status, 'needs_action');
    assert.equal(result.reason, 'invalid_ui_source');
    const finished = readDiagnostics(store).at(-1);
    assert.equal(finished.code, 'invalid_ui_source');
    assert.equal(finished.diagnostic.parser, 'invalid_code_point');
    assert.equal(finished.diagnostic.codePoint, 11);
    assert.equal(JSON.stringify(result).includes('invalid_code_point'), false, 'the completion carries no parser detail');
  } finally { store.close(); }
});
