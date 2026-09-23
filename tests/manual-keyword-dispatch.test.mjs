import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {normalizeRemoteTaskInput} from '../server/services/capture-cloud.js';
import {splitManualKeywords} from '../web/admin/src/pages/dispatch/cloud-tasks/manualKeywordDispatch.mjs';
import {beginTaskContext, completeTaskContext} from '../utils/task-context.js';
const protocol = await readFile(new URL('../utils/manual-keyword-dispatch.js', import.meta.url), 'utf8');
const sidebar = await readFile(new URL('../sidebar/sidebar-logic.js', import.meta.url), 'utf8');
const id = 'eef45fc2-60f4-49f2-a3fd-4a2b572ba51e';
const settings = {
  autoDetailCaptureAfterListCapture: true, autoSyncAfterDetailCapture: true,
  enableAiRelevancePrefilter: true, includeBloggerMetricsOnDetailCapture: true,
  enableLowFollowerHitFilterOnDetailCapture: false, lowFollowerHitThresholdOnDetailCapture: 1234,
  includeCommentsOnDetailCapture: true, detailCommentsMaxDetectedItems: 50,
  enableCommentLeadsFilterOnDetailCapture: false, skipAlreadyCapturedOnDetailCapture: true,
};
const plan = {platform: 'xiaohongshu', keywords: ['安吉星', '别克APP'], keywordMaxDetectedItems: 50,
  keywordMinLikes: 0, manualStartTime: '23:55', captureSettings: settings,
  searchFilters: {publishTime: 'day', sort: 'comprehensive', contentType: 'image', searchScope: 'unviewed', distance: 'all', videoDuration: 'all'}};
const command = {id: 'command-1', payload: {clientTaskId: id, title: '手动采集测试', planSnapshot: plan}};
function harness() {
  const state = {}, pages = new Map(), reports = [];
  let busy = false, opens = 0;
  const context = vm.createContext({URL});
  vm.runInContext(protocol, context);
  const deps = {
    storage: {async get(key) {return {[key]: structuredClone(state[key])};}, async set(value) {Object.assign(state, structuredClone(value));}},
    tabs: {async create(tab) {opens++; const page = {...tab, id: opens}; pages.set(opens, page); return page;},
      async get(id) {if (!pages.has(id)) throw Error('missing'); return pages.get(id);}},
    getURL: path => `chrome-extension://starvoice/${path}`,
    isBusy: async () => busy, reportRun: async run => reports.push(structuredClone(run)),
  };
  const create = () => context.OnStarvoiceManualKeywordDispatch.createController(deps);
  return {create, controller: create(), state, pages, reports, setBusy: value => {busy = value;}, get opens() {return opens;},
    sender: () => ({url: pages.get(1)?.url, tab: {id: 1}, documentId: 'document-1'})};
}

test('23 keywords split across 8 nodes exactly once, deduplicated and balanced', () => {
  const keywords = Array.from({length: 23}, (_, i) => `关键词${i}`);
  const groups = splitManualKeywords([...keywords, keywords[0], ''].join('\n'), Array.from({length: 8}, (_, i) => `node${i}`));
  assert.deepEqual(groups.map(group => group.keywords.length), [3,3,3,3,3,3,3,2]);
  assert.deepEqual(groups.flatMap(group => group.keywords), keywords);
  assert.equal(splitManualKeywords('甲\n乙', ['a', 'b', 'c']).length, 2);
  assert.throws(() => splitManualKeywords(Array.from({length: 31}, (_, i) => `${i}`).join('\n'), ['a']), /30/);
});

test('normalization preserves all manual controls and forbids handoff or plan looping', () => {
  const normalized = normalizeRemoteTaskInput({executionMode: 'manual_batch', ...plan, maxRounds: 20,
    recoveryPolicy: {allowIdleAgentHandoff: true}});
  assert.equal(normalized.executionMode, 'manual_batch');
  assert.equal(normalized.planSnapshot.maxRounds, 1);
  assert.equal(normalized.planSnapshot.recoveryPolicy.allowIdleAgentHandoff, false);
  assert.deepEqual(normalized.planSnapshot.captureSettings, settings);
  assert.deepEqual(normalized.planSnapshot.searchFilters, plan.searchFilters);
  assert.equal(normalized.planSnapshot.manualStartTime, '23:55');
  assert.equal(normalized.planSnapshot.keywordMinLikes, 0);
});

test('concurrent command delivery, service worker restart and page reload cannot start twice', async () => {
  const h = harness();
  const delivered = await Promise.all([h.controller.dispatch(command), h.controller.dispatch(command)]);
  assert.ok(delivered.every(result => result.accepted));
  assert.equal(h.opens, 1);
  assert.equal((await h.controller.claim(id, {url: 'https://evil.invalid/', tab:{id:1}})).ok, false);
  const claimed = await h.controller.claim(id, h.sender());
  assert.equal(claimed.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(claimed.data.plan)), plan);
  const restarted = h.create();
  assert.equal((await restarted.dispatch(command)).accepted, true);
  assert.equal((await restarted.claim(id, h.sender())).ok, false);
  assert.equal(h.opens, 1);
});

test('busy browser is left untouched; a race before claim asks for local action', async () => {
  const h = harness(); h.setBusy(true);
  assert.equal((await h.controller.dispatch(command)).deferred, true);
  assert.equal(h.opens, 0);
  h.setBusy(false); await h.controller.dispatch(command); h.setBusy(true);
  assert.equal((await h.controller.claim(id, h.sender())).reason, 'capture_lock_busy');
  assert.equal(h.reports.at(-1).status, 'needs_action');
});

test('an interrupted delivery is actionable and never opens a second runner', async () => {
  const h=harness();await h.controller.dispatch(command);
  const entry=h.state['onstarvoice.manualKeywordDispatch.v1'][id];
  entry.delivered=false;entry.runnerTabId=null;
  assert.equal((await h.create().dispatch(command)).accepted,false);
  assert.equal(h.reports.at(-1).error.code,'MANUAL_BATCH_DELIVERY_INTERRUPTED');
  assert.equal(h.opens,1);
});

test('closing or losing a runner retains an actionable result and never replays it', async () => {
  const h = harness(); await h.controller.dispatch(command);
  await h.controller.claim(id, h.sender());
  await h.controller.removed(1);
  assert.equal(h.reports.at(-1).error.code, 'MANUAL_BATCH_PAGE_CLOSED');
  assert.equal((await h.controller.dispatch(command)).accepted, true);
  assert.equal(h.opens, 1);
  const h2 = harness(); await h2.controller.dispatch(command); h2.pages.clear();
  const fresh = {...command, id:'command-2', payload:{...command.payload, clientTaskId:'def45fc2-60f4-49f2-a3fd-4a2b572ba51e'}};
  assert.equal((await h2.controller.dispatch(fresh)).accepted, true);
  assert.ok(h2.reports.some(run => run.error?.code === 'MANUAL_BATCH_PAGE_CLOSED'));
});

test('reload reports an interruption but a duplicate claim from the live document leaves it running', async () => {
  const h=harness();await h.controller.dispatch(command);await h.controller.claim(id,h.sender());
  const before=h.reports.length;
  await h.controller.claim(id,h.sender());assert.equal(h.reports.length,before);
  await h.controller.claim(id,{...h.sender(),documentId:'document-2'});
  assert.equal(h.reports.at(-1).error.code,'MANUAL_BATCH_PAGE_RELOADED');
  assert.equal(h.opens,1);
});

test('normal completion does not get changed to failure when the page later closes', async () => {
  const h = harness(); await h.controller.dispatch(command); await h.controller.claim(id,h.sender());
  await h.controller.finish(id,h.sender()); const before = h.reports.length;
  await h.controller.removed(1); assert.equal(h.reports.length, before);
});

test('remote manual identity uses the same task context and completion lookup', () => {
  const context = beginTaskContext({taskId:id, taskType:'capture',featureKey:'capture.search'});
  assert.equal(context.taskId,id);
  assert.equal(completeTaskContext({taskType:'capture',featureKey:'capture.search'}).taskId,id);
});

function runnerHarness(overrides = {}) {
  const elements = new Map(), calls = [], messages = [], saved = [];
  const get = id => {if (!elements.has(id)) elements.set(id,{}); return elements.get(id);};
  const context = vm.createContext({
    window:{activateSidebarTab: tab => calls.push(['tab',tab])}, document:{getElementById:get},
    getRemoteManualKeywordBatchId: () => id,
    chrome:{runtime:{async sendMessage(message) {
      messages.push(message);
      if (message.type.includes('claim-manual')) return {ok:true,data:{plan,title:'测试'}};
      if (message.type.includes('switch-platform')) return {ok:true,data:{tabId:71,url:'https://www.xiaohongshu.com/explore'}};
      return {ok:true};
    }}},
    acquireCaptureExecutionLock: async () => ({id:'lock'}), releaseCaptureExecutionLock:async () => {},
    navigateActiveTabToKeywordSearchForPlan: async () => ({tabId:71,initialSearchEvidence:{ready:true}}),
    isAuthVerified:()=>true, getCurrentAuth:()=>({verified:true}),
    saveCaptureSettings: async value => {saved.push(value);return value;}, initCaptureSettingsUI:async () => {},
    syncDetailCaptureControlsFromStoredSettings:(value)=>calls.push(['settings',value]),
    setSearchExecutionMode:mode=>calls.push(['mode',mode]),
    syncSearchFilterControlsForPlatform:(platform,values)=>calls.push(['filters',platform,values]),
    persistCurrentBatchDraft:()=>{}, showMessage:()=>{}, reportSidebarTaskRun:async run=>calls.push(['error',run]),
    handleCaptureSearchData:async options=>{calls.push(['capture',options]);return {started:true,status:'completed'};},
    ...overrides,
  });
  const start=sidebar.indexOf('async function runRemoteManualKeywordBatch()');
  const end=sidebar.indexOf('\nasync function handleCaptureSearchData(',start);
  vm.runInContext(`let manualSelectedPlatform='';\n${sidebar.slice(start,end)}`,context);
  return {run:()=>context.runRemoteManualKeywordBatch(),get,calls,messages,saved};
}

test('delivery fills real search manual controls and invokes the manual click handler with the full settings',async()=>{
  const h=runnerHarness();await h.run();
  assert.deepEqual(JSON.parse(JSON.stringify(h.saved[0])),{...settings,keywordMaxDetectedItems:50,keywordMinLikes:0});
  assert.equal(h.get('chkSearchBatchMode').checked,true);
  assert.equal(h.get('textareaSearchBatchKeywords').value,'安吉星\n别克APP');
  assert.equal(h.get('inputSearchScheduledStart').value,'23:55');
  assert.equal(h.get('inputKeywordMaxDetectedItems').value,'50');
  assert.ok(h.calls.some(call=>call[0]==='mode'&&call[1]==='manual'));
  const capture=h.calls.find(call=>call[0]==='capture')[1];
  assert.equal(capture.manualTaskId,id);assert.equal(capture.sourceTabId,71);
  assert.equal(h.messages.filter(message=>message.type.includes('finish-manual')).length,1);
  assert.equal(h.calls.filter(call=>call[0]==='capture').length,1);
});

test('unready search page cannot silently report a running manual batch or change preferences',async()=>{
  const h=runnerHarness({navigateActiveTabToKeywordSearchForPlan:async()=>({tabId:71})});await h.run();
  assert.equal(h.saved.length,0);
  assert.equal(h.calls.filter(call=>call[0]==='capture').length,0);
  assert.equal(h.calls.find(call=>call[0]==='error')[1].status,'needs_action');
});
