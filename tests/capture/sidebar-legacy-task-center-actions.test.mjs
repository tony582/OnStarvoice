import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {createLegacyTaskCenterActions} from '../../sidebar/legacy-application/task-center-actions.js';
import {createLegacyTaskCenterActionView} from '../../sidebar/legacy-view/task-center-actions.js';
import {createSidebarTaskController} from '../../sidebar/task-controller/coordinator.js';
import {isUnattendedSafetyBlock} from '../../utils/unattended-keyword-run.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sidebar-legacy-task-center-action-migration.json', import.meta.url), 'utf8'));
const BASELINE = 'ab7feee55032b929c861c1d33c5f145f7450a7c3';
const SOURCE_SHA = '394a545911b63a1345755b11132cfdaf146eeb4a2718bf40d8138e7109238c03';
const FILE_SHA = 'eb90f9ee026a2f119b984e67a99e5449af68faa6d64aaec97751d23851ff82d8';
const CANCEL = 'onstarvoice:cancel-unattended-keyword-run';
const RECOVER = 'onstarvoice:recover-unattended-keyword-run';

function snapshot(value) {
  if (value === undefined) return '[undefined]';
  if (typeof value === 'function') return `[function:${value.name}]`;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(snapshot);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]));
}

function failure(error) {
  return error && typeof error === 'object'
    ? {name: String(error.name || ''), message: String(error.message || '')}
    : {thrown: String(error)};
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

function createHarness(version, options = {}) {
  const trace = [];
  const harness = {
    trace,
    active: Object.hasOwn(options, 'active') ? options.active : {taskId: 'run'},
    options,
  };
  let noticeCount = 0;
  const sendRuntimeMessage = async payload => {
    trace.push(['send', snapshot(payload)]);
    if (options.send) return await options.send(payload, harness);
    if (options.sendError) throw options.sendError;
    return Object.hasOwn(options, 'response') ? options.response : {ok: true};
  };
  const getActiveTaskContext = () => {
    trace.push(['active']);
    if (options.activeError) throw options.activeError;
    return harness.active;
  };
  const handleCancel = async () => {
    trace.push(['local-cancel']);
    if (options.cancelError) throw options.cancelError;
    if (options.cancel) return await options.cancel(harness);
  };
  const loadKeywordPlanUI = async () => {
    trace.push(['load-plan']);
    if (options.loadError) throw options.loadError;
    if (options.load) return await options.load(harness);
    return options.loadResult;
  };
  const checkSafety = value => {
    trace.push(['safety']);
    if (options.safetyError) throw options.safetyError;
    return isUnattendedSafetyBlock(value);
  };
  const showMessage = (message, type) => {
    trace.push(['notice', message, type]);
    noticeCount += 1;
    if (options.noticeThrows?.includes(noticeCount)) throw new Error(`notice ${noticeCount} failed`);
  };
  const warnCancelFailure = error => {
    trace.push(['warn', failure(error)]);
    if (options.warnError) throw options.warnError;
  };
  const window = {
    activateSidebarTab(tab) {
      assert.equal(this, window, 'legacy activation retains its window receiver');
      trace.push(['activate', tab]);
      if (options.activateError) throw options.activateError;
    },
    confirm(message) {
      assert.equal(this, window, 'legacy confirmation retains its window receiver');
      trace.push(['confirm', message]);
      if (options.confirmError) throw options.confirmError;
      return options.confirm !== false;
    },
  };
  if (options.noActivate) delete window.activateSidebarTab;
  if (options.noConfirm) delete window.confirm;
  if (version === 'baseline') {
    assert.equal(createHash('sha256').update(fixture.source).digest('hex'), SOURCE_SHA, 'never evaluate a modified historical fixture');
    const context = vm.createContext({
      window, showMessage, getActiveTaskContext, handleCancel, loadKeywordPlanUI,
      isUnattendedSafetyBlock: checkSafety,
      chrome: {runtime: {sendMessage: sendRuntimeMessage}},
      console: {warn(prefix, error) {
        assert.equal(prefix, '[Sidebar] Cancel task center unattended run failed:');
        warnCancelFailure(error);
      }},
    });
    vm.runInContext(fixture.source, context);
    harness.handle = context.handleTaskCenterAction;
  } else {
    let application;
    const presentation = createLegacyTaskCenterActionView({
      window, showMessage,
      executeLegacyAction: detail => application.executeLegacyTaskCenterAction(detail),
    });
    application = createLegacyTaskCenterActions({
      sendRuntimeMessage, getActiveTaskContext, handleCancel, loadKeywordPlanUI,
      isUnattendedSafetyBlock: checkSafety, presentation, warnCancelFailure,
    });
    harness.handle = presentation.handleTaskCenterAction;
  }
  assert.deepEqual(trace, [], 'construction is cold');
  return harness;
}

async function execute(version, options, makeEvent) {
  const harness = createHarness(version, options);
  let error = null;
  let value;
  try {
    value = await harness.handle(makeEvent(harness));
  } catch (caught) {
    error = failure(caught);
  }
  return {trace: harness.trace, error, value: snapshot(value)};
}

async function paired(options, makeEvent) {
  const before = await execute('baseline', options, makeEvent);
  const after = await execute('candidate', options, makeEvent);
  assert.deepEqual(after, before);
  return after;
}

const event = (action, taskId = 'run', extra = {}) => () => ({detail: {action, taskId, ...extra}});
const types = result => result.trace.map(item => item[0]);

test('legacy action characterization is pinned to the exact PR 57 source, not a reconstructed host', () => {
  assert.equal(fixture.baseline, BASELINE);
  assert.equal(fixture.path, 'sidebar/sidebar-logic.js');
  assert.equal(fixture.functionName, 'handleTaskCenterAction');
  assert.equal(fixture.parentFileSha256, FILE_SHA);
  assert.equal(fixture.sourceSha256, SOURCE_SHA);
  assert.equal(createHash('sha256').update(fixture.source).digest('hex'), SOURCE_SHA);
});

// Extra exact-object evidence is opt-in, like the existing L3-A/L3-B checks.
// Default shallow CI always executes all fixture and behavior tests below.
if (process.env.ONSTARVOICE_LEGACY_COMMAND_BASELINE_REF) test('optional read-only Git check verifies the pinned source against the exact parent object', () => {
  assert.equal(process.env.ONSTARVOICE_LEGACY_COMMAND_BASELINE_REF, BASELINE);
  const parent = execFileSync('git', ['show', `${BASELINE}:${fixture.path}`], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });
  assert.equal(createHash('sha256').update(parent).digest('hex'), FILE_SHA);
  assert.ok(parent.includes(fixture.source));
});

test('legacy factories expose frozen capabilities and do not call dependencies at construction', () => {
  const forbidden = () => {throw new Error('unexpected construction effect');};
  const presentation = createLegacyTaskCenterActionView({window: {}, showMessage: forbidden, executeLegacyAction: forbidden});
  const application = createLegacyTaskCenterActions({
    sendRuntimeMessage: forbidden, getActiveTaskContext: forbidden, handleCancel: forbidden,
    isUnattendedSafetyBlock: forbidden, loadKeywordPlanUI: forbidden, presentation, warnCancelFailure: forbidden,
  });
  assert.equal(Object.isFrozen(presentation), true);
  assert.equal(Object.isFrozen(application), true);
  assert.deepEqual(Object.keys(application), ['executeLegacyTaskCenterAction']);
  assert.deepEqual(Object.keys(presentation), ['handleTaskCenterAction', 'activateResultsTab', 'confirmSafetyBlock', 'notify']);
  const controller = createSidebarTaskController({});
  assert.equal(Object.hasOwn(controller, 'executeLegacyTaskCenterAction'), false);
  assert.equal(Object.hasOwn(controller, 'handleTaskCenterAction'), false);
});

for (const detail of [null, undefined, '', 'stop', false, 0]) {
  test(`non-object legacy event detail remains a no-op: ${String(detail)}`, async () => {
    const result = await paired({}, () => ({detail}));
    assert.deepEqual(result.trace, []);
    assert.equal(result.error, null);
  });
}

test('legacy null event and function detail remain ignored, while array detail remains accepted', async () => {
  assert.deepEqual((await paired({}, () => null)).trace, []);
  assert.deepEqual((await paired({}, () => ({detail() {}}))).trace, []);
  const result = await paired({}, () => ({detail: Object.assign([], {action: 'view_results'})}));
  assert.deepEqual(result.trace, [['activate', 'searchTab']]);
});

test('detail unwrap still reads a truthy object three times and taskId is read even for an empty action', async () => {
  const result = await paired({}, harness => {
    const detail = {
      get action() {harness.trace.push(['read-action']); return '';},
      get taskId() {harness.trace.push(['read-task-id']); return '';},
      get id() {harness.trace.push(['read-id-fallback']); return 'fallback';},
    };
    return {get detail() {harness.trace.push(['read-detail']); return detail;}};
  });
  assert.deepEqual(types(result), ['read-detail', 'read-detail', 'read-detail', 'read-action', 'read-task-id', 'read-id-fallback']);
});

test('taskId getter failure happens before view-results activation', async () => {
  const result = await paired({}, () => ({detail: {action: 'view_results', get taskId() {throw new Error('task id unavailable');}}}));
  assert.deepEqual(result.trace, []);
  assert.equal(result.error.message, 'task id unavailable');
});

test('legacy action coercion failure precedes taskId reads and any effects', async () => {
  const result = await paired({}, harness => ({detail: {
    action: {toString() {throw new Error('action coercion failed');}},
    get taskId() {harness.trace.push(['unexpected-task-id']); return 'run';},
  }}));
  assert.deepEqual(result.trace, []);
  assert.equal(result.error.message, 'action coercion failed');
});

test('view-results stays optional, while activation failures remain uncaught', async () => {
  assert.deepEqual((await paired({noActivate: true}, event('view_results', ''))).trace, []);
  const result = await paired({activateError: new Error('activation failed')}, event('view_results', ''));
  assert.equal(result.error.message, 'activation failed');
  assert.deepEqual(types(result), ['activate']);
});

test('action/taskId trimming preserves the truthy whitespace ID fallback quirk', async () => {
  const a = await paired({}, event(' keep_results ', '  ', {id: 'fallback'}));
  assert.deepEqual(types(a), ['notice']);
  assert.equal(a.trace[0][2], 'warning');
  const b = await paired({}, event(' keep_results ', '', {id: ' fallback '}));
  assert.equal(b.trace[0][1].requestId, 'fallback');
});

for (const action of ['keep_results', 'stop', 'stop_keep', 'continue_remaining', 'resume_remaining', 'retry_failed', 'skip_current']) {
  test(`legacy action normal path preserves exact request payload and notices: ${action}`, async () => {
    const result = await paired({}, event(action));
    assert.equal(result.error, null);
    assert.equal(result.trace[0][0], action.includes('remaining') ? 'safety' : 'send');
    const payload = result.trace.find(item => item[0] === 'send')[1];
    assert.equal(payload.requestId, 'run');
    assert.equal(payload.type, ['keep_results', 'stop', 'stop_keep'].includes(action) ? CANCEL : RECOVER);
  });
}

for (const response of [null, {ok: false}, {ok: false, reason: 'reason-first', error: {message: 'nested-second'}}, {ok: false, error: {message: 'nested-only'}}, {ok: 'legacy-truthy'}]) {
  for (const action of ['keep_results', 'retry_failed']) {
    test(`legacy result/error priority remains unchanged: ${action}, ${JSON.stringify(response)}`, async () => {
      const result = await paired({response}, event(action));
      assert.equal(result.error, null);
      if (response?.reason) assert.match(result.trace.at(-1)[1], /reason-first/);
    });
  }
}

for (const action of ['keep_results', 'retry_failed']) {
  test(`legacy remote rejection remains inside the original catch: ${action}`, async () => {
    const result = await paired({sendError: new Error('remote failed')}, event(action));
    assert.deepEqual(types(result), ['send', 'notice']);
    assert.match(result.trace[1][1], /remote failed/);
    assert.equal(result.error, null);
  });
}

for (const action of ['continue_remaining', 'retry_failed', 'skip_current', 'unknown-action']) {
  test(`missing recovery task ID remains a no-op: ${action}`, async () => {
    const result = await paired({}, event(action, ''));
    assert.deepEqual(result.trace, []);
  });
}

test('legacy unknown action remains a no-op when it does not inherit a mode', async () => {
  assert.deepEqual((await paired({}, event('not-an-action'))).trace, []);
});

for (const action of ['toString', 'constructor', '__proto__']) {
  test(`characterize legacy defect only: inherited recovery mode ${action} is NOT a supported safe command`, async () => {
    const result = await paired({}, event(action));
    assert.equal(result.trace[0][0], 'send');
    assert.equal(result.trace[0][1].type, RECOVER);
    // This records the old non-allowlisted lookup without using a real runtime.
    // Strict commands must not reuse this compatibility adapter.
    assert.equal(result.error, null);
  });
}

for (const active of [{taskId: 'run'}, {taskId: 'another'}, null]) {
  for (const sendError of [null, new Error('remote failed')]) {
    test(`legacy stop fallback uses the diagnostic context only after remote failure: ${JSON.stringify(active)}, ${Boolean(sendError)}`, async () => {
      const result = await paired({response: {ok: false}, sendError, active}, event('stop'));
      assert.deepEqual(types(result), ['send', ...(sendError ? ['warn'] : []), 'active', ...(active?.taskId === 'run' ? ['local-cancel'] : []), 'notice']);
      assert.equal(result.error, null);
    });
  }
}

test('legacy stop with no ID calls local cancellation even when no diagnostic context exists', async () => {
  const result = await paired({active: null}, event('stop', ''));
  assert.deepEqual(types(result), ['active', 'local-cancel', 'notice']);
});

test('legacy remote stop success does not inspect diagnostics or cancel locally', async () => {
  const result = await paired({activeError: new Error('must not read')}, event('stop'));
  assert.deepEqual(types(result), ['send', 'notice']);
  assert.equal(result.error, null);
});

for (const action of ['view_results', 'keep_results', 'stop', 'retry_failed', 'skip_current', 'unknown-action']) {
  test(`unrelated legacy action must not read raw task safety data: ${action}`, async () => {
    const result = await paired({}, () => ({detail: {action, taskId: 'run', get task() {throw new Error('unexpected raw task read');}}}));
    assert.equal(result.error, null);
  });
}

for (const confirm of [true, false]) {
  test(`legacy safety continuation retains late raw-task read and confirmation: ${confirm}`, async () => {
    const result = await paired({confirm}, harness => ({detail: {
      action: 'resume_remaining', taskId: 'run',
      get task() {harness.trace.push(['read-safety-task']); return {code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE'};},
    }}));
    assert.deepEqual(types(result), ['read-safety-task', 'safety', 'confirm', ...(confirm ? ['send', 'notice', 'load-plan'] : [])]);
  });
}

test('legacy text-only safety hints do not silently become authoritative safety evidence', async () => {
  const result = await paired({confirm: false}, event('resume_remaining', 'run', {task: {message: '请完成验证码后继续'}}));
  assert.deepEqual(types(result), ['safety', 'send', 'notice', 'load-plan']);
});

for (const options of [{safetyError: new Error('safety failed')}, {confirmError: new Error('confirm failed')}]) {
  test(`safety/confirmation failure remains outside recovery catch: ${Object.keys(options)[0]}`, async () => {
    const result = await paired(options, event('continue_remaining', 'run', {task: {securityBlocked: true}}));
    assert.ok(result.error);
    assert.ok(!types(result).includes('notice'));
    assert.ok(!types(result).includes('send'));
  });
}

test('missing legacy confirm remains an uncaught failure, not an implicit approval or decline', async () => {
  const result = await paired({noConfirm: true}, event('continue_remaining', 'run', {task: {securityBlocked: true}}));
  assert.equal(result.error.name, 'TypeError');
  assert.deepEqual(types(result), ['safety']);
});

for (const options of [{activeError: new Error('active failed')}, {cancelError: new Error('cancel failed')}, {noticeThrows: [1]}]) {
  test(`local legacy stop errors remain uncaught: ${Object.keys(options)[0]}`, async () => {
    const result = await paired(options, event('stop', ''));
    assert.ok(result.error);
    assert.ok(!types(result).includes('warn'));
  });
}

test('warning callback failure remains uncaught and prevents diagnostic fallback', async () => {
  const result = await paired({sendError: new Error('send failed'), warnError: new Error('warning failed')}, event('stop'));
  assert.deepEqual(types(result), ['send', 'warn']);
  assert.equal(result.error.message, 'warning failed');
});

for (const action of ['keep_results', 'retry_failed']) {
  test(`success notice failure stays inside its legacy command catch: ${action}`, async () => {
    const result = await paired({noticeThrows: [1]}, event(action));
    assert.deepEqual(types(result), ['send', 'notice', 'notice']);
    assert.match(result.trace[2][1], /notice 1 failed/);
    assert.equal(result.error, null);
  });
}

test('characterize legacy defect: remote stop success notice failure can enter local fallback', async () => {
  const result = await paired({noticeThrows: [1]}, event('stop'));
  assert.deepEqual(types(result), ['send', 'notice', 'warn', 'active', 'local-cancel', 'notice']);
  assert.equal(result.error, null);
});

test('failure notice can itself reject the legacy handler', async () => {
  const result = await paired({noticeThrows: [1, 2]}, event('keep_results'));
  assert.equal(result.error.message, 'notice 2 failed');
});

for (const action of ['keep_results', 'retry_failed', 'stop']) {
  for (const value of [null, 'non-Error rejection']) {
    test(`legacy non-Error runtime rejection is characterized without normalizing it away: ${action}, ${String(value)}`, async () => {
      const result = await paired({send: async () => {throw value;}}, event(action));
      if (value === null && action !== 'stop') {
        assert.equal(result.error.name, 'TypeError');
      } else {
        assert.equal(result.error, null);
      }
    });
  }
}

test('legacy recovery announces success before refresh, and a thrown refresh produces a later failure notice', async () => {
  const result = await paired({loadError: new Error('refresh failed')}, event('retry_failed'));
  assert.deepEqual(types(result), ['send', 'notice', 'load-plan', 'notice']);
  assert.equal(result.trace[1][2], 'success');
  assert.equal(result.trace[3][2], 'error');
});

test('legacy recovery does not reinterpret a null plan refresh as failed execution', async () => {
  const result = await paired({loadResult: null}, event('retry_failed'));
  assert.deepEqual(types(result), ['send', 'notice', 'load-plan']);
  assert.equal(result.error, null);
});

for (const nextTaskId of ['run', 'different']) {
  test(`legacy stop reads changed diagnostics after its remote await: ${nextTaskId}`, {timeout: 5000}, async () => {
    async function run(version) {
      const gate = deferred();
      const harness = createHarness(version, {active: {taskId: 'before'}, send: () => gate.promise});
      const detail = {action: 'stop', taskId: 'run'};
      const pending = harness.handle({detail});
      assert.deepEqual(harness.trace.map(item => item[0]), ['send']);
      harness.active = {taskId: nextTaskId};
      detail.taskId = 'changed-event-id';
      gate.resolve({ok: false});
      await pending;
      return harness.trace;
    }
    const before = await run('baseline');
    assert.deepEqual(await run('candidate'), before);
    assert.equal(before[0][1].requestId, 'run');
    assert.deepEqual(before.map(item => item[0]), ['send', 'active', ...(nextTaskId === 'run' ? ['local-cancel'] : []), 'notice']);
  });
}

test('legacy recovery paints success before awaiting the plan refresh', {timeout: 5000}, async () => {
  async function run(version) {
    const entered = deferred();
    const release = deferred();
    const harness = createHarness(version, {load: () => {entered.resolve(); return release.promise;}});
    const pending = harness.handle(event('retry_failed')());
    await entered.promise;
    const during = snapshot(harness.trace);
    release.resolve(null);
    await pending;
    return {during, after: harness.trace};
  }
  const before = await run('baseline');
  assert.deepEqual(await run('candidate'), before);
  assert.deepEqual(before.during.map(item => item[0]), ['send', 'notice', 'load-plan']);
});

test('characterize legacy concurrency: duplicate events are not silently queued or debounced', {timeout: 5000}, async () => {
  async function run(version) {
    const gates = [];
    const harness = createHarness(version, {send: () => {const gate = deferred(); gates.push(gate); return gate.promise;}});
    const first = harness.handle(event('keep_results', 'first')());
    const second = harness.handle(event('keep_results', 'second')());
    assert.equal(gates.length, 2);
    const beforeReplies = snapshot(harness.trace);
    gates[1].resolve({ok: true});
    await second;
    gates[0].resolve({ok: false, reason: 'first failed'});
    await first;
    return {beforeReplies, after: harness.trace};
  }
  const before = await run('baseline');
  assert.deepEqual(await run('candidate'), before);
  assert.deepEqual(before.beforeReplies.map(item => item[0]), ['send', 'send']);
});
