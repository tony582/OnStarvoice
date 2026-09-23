import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppiumClient } from '../src/device/appium.mjs';
import { createUiSession } from '../src/device/ui-session.mjs';

const hierarchy = '<hierarchy><node package="com.ss.android.ugc.aweme" text="复制成功" displayed="true" /></hierarchy>';
const response = value => new Response(JSON.stringify({ value }));
const session = fetchImpl => createUiSession({ client: createAppiumClient({ fetchImpl }), sessionId: 'read-budget' });

test('a legitimate 5.5 second hierarchy read finishes without a disconnect error', async () => {
  let requests = 0;
  const ui = session(async (_url, { signal }) => {
    requests++;
    await delay(5500, undefined, { signal });
    return response(hierarchy);
  });
  const tree = await ui.read();
  assert.equal(tree.nodes.find(node => node.attributes.text)?.attributes.text, '复制成功');
  assert.equal(requests, 1);
});

test('an explicit short read deadline still requires confirmed device closure', async () => {
  let signal;
  const ui = session(async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  await assert.rejects(ui.read({ timeoutMs: 20 }), { code: 'device_timeout', stopConfirmationRequired: true });
  assert.equal(signal.aborted, true);
});

test('parent cancellation interrupts a started hierarchy request', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  let signal;
  const ui = session(async (_url, options) => {
    signal = options.signal;
    started();
    return new Promise(() => {});
  });
  const reading = ui.read({ signal: controller.signal });
  const rejected = assert.rejects(reading, { code: 'aborted', stopConfirmationRequired: true });
  await ready;
  controller.abort();
  await rejected;
  assert.equal(signal.aborted, true);
});

test('an already canceled parent prevents a hierarchy request', async () => {
  let requests = 0;
  const controller = new AbortController();
  controller.abort();
  const ui = session(async () => { requests++; return response(hierarchy); });
  await assert.rejects(ui.read({ signal: controller.signal }), { code: 'aborted' });
  assert.equal(requests, 0);
});

test('a completed read still blocks Smartisan Big Bang', async () => {
  const ui = session(async () => response('<hierarchy><node package="com.smartisanos.textboom" displayed="true" /></hierarchy>'));
  await assert.rejects(ui.read(), { code: 'system_overlay_blocked' });
});

test('a legitimate 5.5 second scroll finishes once without replaying the gesture', async () => {
  let gestures = 0;
  const ui = session(async (url, { signal, body }) => {
    if (url.endsWith('/elements')) return response([{ 'element-6066-11e4-a52e-4f735466cecf': 'list-element' }]);
    assert.equal(JSON.parse(body).script, 'mobile: scrollGesture');
    gestures++;
    await delay(5500, undefined, { signal });
    return response(true);
  });
  assert.equal(await ui.scroll('search-list'), true);
  assert.equal(gestures, 1);
});

test('an explicit short scroll deadline still requires confirmed closure', async () => {
  let gestureSignal;
  const ui = session(async (url, { signal }) => {
    if (url.endsWith('/elements')) return response([{ 'element-6066-11e4-a52e-4f735466cecf': 'list-element' }]);
    gestureSignal = signal;
    return new Promise(() => {});
  });
  await assert.rejects(ui.scroll('search-list', { timeoutMs: 20 }), { code: 'device_timeout', stopConfirmationRequired: true });
  assert.equal(gestureSignal.aborted, true);
});
