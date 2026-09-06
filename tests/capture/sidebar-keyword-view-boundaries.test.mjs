import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createKeywordTaskState} from '../../sidebar/task-controller/keyword-state.js';
import {createKeywordDraftsController} from '../../sidebar/task-controller/keyword-drafts.js';
import {createKeywordPlanController} from '../../sidebar/task-controller/keyword-plan.js';
import {createKeywordStrategyController} from '../../sidebar/task-controller/keyword-strategy.js';
import {createMonitorSubscriptionsController} from '../../sidebar/task-controller/monitor-subscriptions.js';
import {createLegacyKeywordInputsView} from '../../sidebar/legacy-view/keyword-inputs.js';
import {createKeywordPlanView} from '../../sidebar/legacy-view/keyword-plan.js';
import {createKeywordStrategyView} from '../../sidebar/legacy-view/keyword-strategy.js';
import {createMonitorSettingsView} from '../../sidebar/legacy-view/monitor-settings.js';
import {createProgressVisibilityController} from '../../sidebar/task-controller/progress-visibility.js';
import {createLegacyProgressVisibilityView} from '../../sidebar/legacy-view/progress-visibility.js';

const silence = {warn() {}, error() {}, log() {}};
const state = () => createKeywordTaskState();

test('keyword task stores are per controller, including arrays and platform drafts', () => {
  const a = state(); const b = state();
  a.expandedKeywordsBuffer.push('a'); a.batchDraftByPlatform.douyin = {};
  assert.deepEqual(b.expandedKeywordsBuffer, []);
  assert.deepEqual(b.batchDraftByPlatform, {});
});

test('batch draft input facade is cold, frozen and preserves captured nodes with late value reads', () => {
  const calls = [];
  const nodes = {textareaBatchLinks: {value: 'first'}, textareaBatchBloggers: {value: 'b'}, textareaBatchKeywords: {value: 'k'}};
  const view = createLegacyKeywordInputsView({document: {getElementById: id => {calls.push(id); return nodes[id];}}});
  assert.deepEqual(calls, []);
  const form = view.openBatchDraftInputs();
  assert.equal(Object.isFrozen(form), true);
  assert.deepEqual(calls, ['textareaBatchLinks', 'textareaBatchBloggers', 'textareaBatchKeywords']);
  const original = nodes.textareaBatchLinks;
  original.value = 'late'; nodes.textareaBatchLinks = {value: 'replacement'};
  assert.deepEqual(form.read(), {links: 'late', bloggers: 'b', batchKeywordsText: 'k'});
  assert.equal(Object.isFrozen(form.read()), true);
  form.apply({links: 'restored', bloggers: 'bb', batchKeywordsText: 'kk'});
  assert.equal(original.value, 'restored'); assert.equal(nodes.textareaBatchLinks.value, 'replacement');
  assert.deepEqual(Object.keys(form), ['read', 'apply']);
});

test('missing draft controls produce original empty values and accept application without DOM leaking', () => {
  const form = createLegacyKeywordInputsView({document: {getElementById: () => null}}).openBatchDraftInputs();
  assert.deepEqual(form.read(), {links: '', bloggers: '', batchKeywordsText: ''});
  form.apply({});
});

test('draft application commits expanded state before render and active platform only after input updates', () => {
  const s = state(); const calls = [];
  const ports = {BATCH_DRAFT_PLATFORMS: new Set(['xiaohongshu', 'douyin']), getCurrentRuntime: () => ({}), getViewPlatform: () => 'douyin',
    updateBatchKeywordInputState: () => calls.push(['input', s.activeBatchDraftPlatform]),
    taskView: {openBatchDraftInputs: () => ({apply: draft => calls.push(['apply', draft.links])}),
      renderExpandedKeywords: () => calls.push(['expanded', [...s.expandedKeywordsBuffer], s.activeBatchDraftPlatform]),
      renderKeywordInsightState: () => calls.push(['insight']), updateExpandKeywordsButtonState: () => calls.push(['button'])}};
  const app = createKeywordDraftsController({controllerState: s, controllerPorts: ports, controllerOperations: {buildKeywordOpportunityInputItems: items => items}});
  s.batchDraftByPlatform.douyin = {links: 'link', expandedKeywords: ['word']};
  app.applyBatchDraftToInputs('douyin');
  assert.deepEqual(calls, [['apply', 'link'], ['expanded', ['word'], ''], ['insight'], ['input', ''], ['button']]);
  assert.equal(s.activeBatchDraftPlatform, 'douyin');
  app.applyBatchDraftToInputs('douyin'); assert.equal(calls.length, 5);
});

for (const mode of ['disabled', 'local', 'covered', 'missing', 'ready', 'runner']) {
  test(`plan progress application chooses state cleanup before painting: ${mode}`, () => {
    const calls = []; const s = state();
    s.batchKeywordCaptureInFlight = mode === 'local' || mode === 'runner';
    const plan = {enabled: mode !== 'disabled', lastRunStatus: 'running'};
    const app = createKeywordPlanController({controllerState: s, controllerOperations: {
      getUnattendedRunRequestIdFromUrl: () => mode === 'runner' ? 'run' : '',
      resetCaptureRecoveryUI: options => calls.push(['reset', options]),
    }, controllerPorts: {taskView: {
      hideKeywordPlanProgressPanelIfOwned: p => calls.push(['hide', p]),
      isUnsupportedPlatformCoverVisible: () => mode === 'covered',
      openKeywordPlanProgress: () => {calls.push(['open']); return mode === 'missing' ? null : {render: p => calls.push(['render', p])};},
    }}});
    app.syncKeywordPlanProgressPanel(plan);
    if (mode === 'disabled') assert.deepEqual(calls, [['hide', plan]]);
    else if (mode === 'local' || mode === 'covered') assert.deepEqual(calls, []);
    else if (mode === 'missing') assert.deepEqual(calls, [['open']]);
    else assert.deepEqual(calls, [['open'], ['reset', {hidePanel: false, clearState: true}], ['render', plan]]);
  });
}

test('plan presentation cannot clear application state and retains captured progress nodes', () => {
  const old = {dataset: {}, style: {}}; const text = {}; const nodes = {progressContainer: old, progressText: text};
  const view = createKeywordPlanView({legacyViewState: {keywordPlanProgressCountdownToken: 0},
    ports: {document: {getElementById: id => nodes[id]}, clearInterval() {}},
    application: {}, keywordModel: {}, viewOperations: {}});
  const presentation = view.openKeywordPlanProgress();
  assert.equal(Object.isFrozen(presentation), true);
  nodes.progressContainer = {dataset: {}, style: {}};
  presentation.render({lastRunMessage: 'working', lastRunProgress: {message: 'working'}});
  assert.equal(old.dataset.progressSource, 'keyword-plan');
  assert.equal(nodes.progressContainer.dataset.progressSource, undefined);
  assert.equal(typeof text.textContent, 'string');
});

test('plan labels are painted before progress ownership cleanup and debug projection', () => {
  const events = []; const s = state(); const plan = {enabled: true, lastRunStatus: 'running'};
  const app = createKeywordPlanController({controllerState: s, controllerOperations: {
    getUnattendedRunRequestIdFromUrl: () => '',
    resetCaptureRecoveryUI: () => events.push('reset'),
  }, controllerPorts: {
    getCurrentRuntime: () => ({}), renderCaptureDebugSession: () => events.push('debug'),
    taskView: {renderKeywordPlanStatusLabels: () => events.push('labels'),
      isUnsupportedPlatformCoverVisible: () => false,
      openKeywordPlanProgress: () => ({render: () => events.push('progress')}),
    },
  }});
  app.renderKeywordPlanStatus(plan);
  assert.deepEqual(events, ['labels', 'reset', 'progress', 'debug']);
  const source = readFileSync(new URL('../../sidebar/legacy-view/keyword-plan.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  function renderKeywordPlanStatusLabels'), source.indexOf('  function getKeywordExecutionCopy'));
  assert.doesNotMatch(body, /resetCaptureRecovery|syncKeywordPlanProgressPanel|application\./);
});

test('strategy view actions dispatch intents without seeding or mutating application state', () => {
  const calls = [];
  const view = createKeywordStrategyView({legacyViewState: {}, ports: {}, keywordModel: {}, viewOperations: {}, application: {
    selectKeywordStrategyTab: tab => calls.push(['tab', tab]), openKeywordLongtail: () => calls.push(['open']),
  }});
  view.setKeywordStrategyTab('longtail'); view.handleOpenKeywordLongtail();
  assert.deepEqual(calls, [['tab', 'longtail'], ['open']]);
});

test('each plan scope fills keywords before reading that scopes current filters', () => {
  const events = [];
  const elements = Object.fromEntries(['search', 'modal'].map(scope => [scope, {
    get value() {events.push(['read-input', scope]); return '';},
    set value(value) {events.push(['write-input', scope, value]);},
  }]));
  const view = createKeywordPlanView({legacyViewState: {}, keywordModel: {}, viewOperations: {}, ports: {
    document: {getElementById: id => elements[id]}, getCurrentRuntime: () => ({}),
    KEYWORD_PLAN_CONTROL_IDS: {search: {keywords: 'search'}, modal: {keywords: 'modal'}},
    SEARCH_FILTER_FIELD_META: {}, SEARCH_FILTER_SCOPE_META: {},
  }, application: {normalizeSearchFilterPlatform: value => value, getSearchFilterConfig: () => ({})}});
  view.populateKeywordPlanKeywords(['keyword'], () => {events.push(['read-filters']); return {};}, 'douyin');
  assert.deepEqual(events, [
    ['read-input', 'search'], ['write-input', 'search', 'keyword'], ['read-filters'],
    ['read-input', 'modal'], ['write-input', 'modal', 'keyword'], ['read-filters'],
  ]);
});

test('longtail app selection preserves seed, active tab and paint order', () => {
  const calls = []; const runtime = {pageType: 'search'};
  const app = createKeywordStrategyController({controllerState: state(), controllerPorts: {
    PAGE_TYPE: {SEARCH_RESULTS: 'search'}, getCurrentRuntime: () => runtime,
    getPagePlatform: () => 'douyin', getViewPlatform: () => 'douyin', getPlatformCapabilities: () => ({captureSearch: true}),
    taskView: {setStrategyActiveTab: value => calls.push(['tab', value]), setStrategyPanelVisible: value => calls.push(['visible', value]),
      renderKeywordInsightState: () => calls.push(['insight']), renderKeywordStrategyPanel: () => calls.push(['paint'])},
  }, controllerOperations: {getCurrentSearchKeyword: () => 'seed', syncSeedKeywordFromCurrentSearch: (...args) => calls.push(['seed', ...args])}});
  app.openKeywordLongtail();
  assert.deepEqual(calls, [['seed', 'seed', {autoFillOnly: true}], ['visible', true], ['tab', 'longtail'], ['seed', 'seed'], ['insight'], ['paint']]);
});

test('monitor legacy event adapter sends no node and retains late action reads', async () => {
  const calls = []; const button = {dataset: {id: ' a ', nextStatus: 'paused'}, classList: {contains: type => type === 'btn-monitor-toggle'}};
  const view = createMonitorSettingsView({legacyViewState: {}, ports: {}, keywordModel: {}, viewOperations: {}, application: {
    handleLegacyMonitorAction: async intent => {assert.equal(Object.isFrozen(intent), true); button.dataset.id = 'b'; calls.push(intent.readSubscriptionId(), intent.isToggle(), intent.readNextStatus(), intent.isDelete());},
  }});
  await view.handleMonitorListClick({target: {closest: () => button}});
  assert.deepEqual(calls, ['b', true, 'paused', false]);
});

for (const mode of ['missing', 'decline', 'failed', 'success']) test(`monitor deletion preserves lookup/confirmation/write order: ${mode}`, async () => {
  const calls = [];
  const app = createMonitorSubscriptionsController({controllerState: state(), controllerOperations: {}, controllerPorts: {
    AUTH_STATUS: {VERIFIED: 'verified'}, MONITOR_STATUS: {DELETED: 'deleted'}, console: silence,
    getCurrentMonitor: () => ({items: mode === 'missing' ? [] : [{id: 's'}]}), getCurrentAuth: () => ({}),
    taskView: {confirmMonitorRemoval: () => {calls.push('confirm'); return mode !== 'decline';}},
    updateMonitorSubscription: async (id, update) => {calls.push(['write', id, update]); return {ok: mode === 'success'};},
    resetCurrentMonitor: async () => calls.push('refresh-unauthed'), showMessage: (...args) => calls.push(['message', ...args]),
  }});
  await app.handleLegacyMonitorAction({readSubscriptionId: () => 's', isToggle: () => false, isDelete: () => true});
  if (mode === 'missing') assert.equal(calls[0][0], 'message');
  else if (mode === 'decline') assert.deepEqual(calls, ['confirm']);
  else {assert.deepEqual(calls.slice(0, 2), ['confirm', ['write', 's', {status: 'deleted'}]]); assert.equal(calls.at(-1).at(-1), mode === 'success' ? 'success' : 'error');}
});

test('all seven keyword/monitor domains have no Sidebar DOM or host state bindings', () => {
  for (const file of ['keyword-drafts', 'keyword-plan', 'keyword-strategy', 'keyword-analysis', 'keyword-sort', 'monitor-policy', 'monitor-subscriptions']) {
    const source = readFileSync(new URL(`../../sidebar/task-controller/${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(?:document|window|HTMLElement|controllerBindings|sidebarTaskController)\b/, file);
    assert.doesNotMatch(source, /\.taskView\.(?:getKeywordPlanControl|getMonitorSettingsElements)\b/, file);
  }
});

test('show progress clears countdown then task state, re-reads nodes and only then reads run identity', () => {
  const events = []; const original = {dataset: {progressSource: 'keyword-plan'}, style: {}};
  const replacement = {dataset: {}, style: {}};
  let activeContainer = original;
  const elements = {progressText: {}, progressBar: {}, btnCancel: {style: {}}};
  const taskView = createLegacyProgressVisibilityView({
    document: {getElementById: id => id === 'progressContainer' ? activeContainer : elements[id]},
    clearKeywordPlanProgressCountdown: () => events.push('countdown'),
    setCaptureButtonsDisabled: value => events.push(['buttons', value]),
  });
  const app = createProgressVisibilityController({controllerState: {
    get activeUnattendedRunRequestId() {events.push(['read-run', replacement.dataset.progressSource]); return 'run';},
  }, controllerOperations: {resetCaptureRecoveryUI: () => {events.push('reset'); activeContainer = replacement;}},
  controllerPorts: {taskView: {...taskView, isUnsupportedPlatformCoverVisible: () => {events.push('cover'); return false;}}}});
  app.showProgress('working');
  assert.deepEqual(events, ['countdown', 'reset', 'cover', ['read-run', 'capture'], ['buttons', true]]);
  assert.equal(original.dataset.progressSource, 'keyword-plan');
  assert.equal(replacement.dataset.unattendedProgressState, 'running');
  assert.equal(elements.progressText.textContent, 'working');
});

for (const force of [false, true]) test(`hide progress respects the pinned guard before painting or task cleanup: force=${force}`, () => {
  const events = []; const container = {dataset: {progressSource: 'capture-recovery', recoveryPinned: 'true', unattendedProgressState: 'terminal'}, style: {display: 'block'}};
  const button = {style: {display: 'inline-block'}};
  const view = createLegacyProgressVisibilityView({document: {getElementById: id => {events.push(['node', id]); return id === 'progressContainer' ? container : button;}}});
  const app = createProgressVisibilityController({controllerState: {}, controllerPorts: {taskView: view}, controllerOperations: {
    resetCaptureRecoveryUI: options => events.push(['reset', options, container.style.display, button.hidden]),
  }});
  app.hideProgressPanelOnly({force});
  if (!force) {assert.deepEqual(events, [['node', 'progressContainer']]); assert.equal(container.style.display, 'block');}
  else {assert.deepEqual(events.at(-1), ['reset', {hidePanel: false, clearState: true}, 'none', true]); assert.equal(container.dataset.unattendedProgressState, 'terminal');}
});

test('missing progress container never reads current run and hidden UI never reads cover state', () => {
  const events = [];
  const view = createLegacyProgressVisibilityView({document: {getElementById: () => null}, setCaptureButtonsDisabled: () => events.push('buttons')});
  const app = createProgressVisibilityController({controllerState: {get activeUnattendedRunRequestId() {throw Error('unexpected run read');}},
    controllerPorts: {taskView: {...view, isUnsupportedPlatformCoverVisible: () => {throw Error('unexpected cover read');}}},
    controllerOperations: {resetCaptureRecoveryUI: () => events.push('reset')},
  });
  app.showProgress('hidden', false);
  assert.deepEqual(events, ['reset', 'buttons']);
});
