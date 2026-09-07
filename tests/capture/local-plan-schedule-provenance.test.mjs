import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {parseSidebarAst} from '../helpers/sidebar-controller-ast.mjs';
import {createLocalRecoveryHarness, LOCAL_KEYS, clone, deferred} from '../helpers/local-recovery-harness.mjs';

const background = readFileSync(new URL('../../background.js', import.meta.url), 'utf8');
const ast = parseSidebarAst(background);
const declaration = name => ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
const writer = declaration('saveUnattendedKeywordPlan');
const capability = ast.body.find(node => node.type === 'VariableDeclaration' &&
  node.declarations.some(entry => entry.id.name === 'LOCAL_PLAN_SCHEDULE_WRITE'));

async function fixture({withRequest = false, legacy = false} = {}) {
  const h = createLocalRecoveryHarness();
  assert.equal((await h.savePlan()).ok, true);
  if (withRequest) assert.equal((await h.createOriginal()).handled, true);
  if (legacy) delete h.store[LOCAL_KEYS.origin];
  let inQ = false, tail = Promise.resolve();
  const effects = [];
  class ClockDate extends Date {
    constructor(...args) {super(...(args.length ? args : [h.now()]));}
    static now() {return h.now();}
  }
  const context = vm.createContext({Date: ClockDate,
    navigator: {locks: {request(name, options, operation) {
      assert.equal(name, 'onstarvoice:control-state-v1');
      assert.equal(options.mode, 'exclusive');
      const work = tail.then(async () => {
        assert.equal(inQ, false);
        inQ = true;
        try {return await operation();} finally {inQ = false;}
      });
      tail = work.catch(() => {});
      return work;
    }}},
    chrome: {storage: {local: {
      get(keys) {assert.equal(inQ, true, 'fresh plan/proof read belongs to final Q'); return h.storage.get(keys);},
      set(patch) {assert.equal(inQ, true, 'plan/proof publication belongs to the same final Q'); return h.storage.set(patch);},
    }}},
    STORAGE_KEYS: {unattendedKeywordPlan: 'plan'},
    normalizeUnattendedKeywordPlan: h.builders.normalizeUnattendedKeywordPlan,
    OnStarvoiceLocalCaptureSource: h.context.OnStarvoiceLocalCaptureSource,
    OnStarvoiceLocalCaptureAuthority: h.context.OnStarvoiceLocalCaptureAuthority,
    runTaskLedgerMutation: operation => operation(),
    computeNextUnattendedRunAt() {assert.fail('these writer tests supply an explicit schedule projection');},
    syncUnattendedKeywordAlarm: async () => {assert.equal(inQ, false); effects.push('alarm');},
    scheduleCloudTaskAgentSync: () => {assert.equal(inQ, false); effects.push('agent-sync');},
    readCloudTaskAgentCredential: async () => h.store.auth.captureAgent,
    confirmCloudTaskAgentPlanScope: async () => {effects.push('cloud-author-save');},
    cleanupDisabledUnattendedKeywordPlanRuntime: async () => {effects.push('disabled-plan');},
  });
  vm.runInContext(readFileSync(new URL('../../utils/control/state-fence.js', import.meta.url), 'utf8'), context);
  vm.runInContext(`${background.slice(...capability.range)}\n${background.slice(...writer.range)}
    globalThis.writers = {
      ordinary: saveUnattendedKeywordPlan,
      schedule: (plan, options) => saveUnattendedKeywordPlan(plan, options, LOCAL_PLAN_SCHEDULE_WRITE),
    };`, context, {filename: 'actual-background-plan-writer.js'});
  const options = {recomputeNext: false, preserveRunState: false};
  return {h, context, effects, options, writers: context.writers};
}

const projections = [
  ['nextRunAt', '2026-09-08T12:00:00.000Z'],
  ['lastRunAt', '2026-09-07T11:59:00.000Z'],
  ['lastRunStatus', 'deferred'],
  ['lastRunMessage', 'synthetic schedule deferral'],
  ['lastRunProgress', {keywordIndex: 1, total: 2}],
  ['lastRunRequestId', 'synthetic-projection-only'],
];
for (const [field, value] of projections) test(`internal ${field} projection preserves the exact authored plan and request witnesses`, async () => {
  const {h, writers, options} = await fixture({withRequest: true});
  const origin = clone(h.store[LOCAL_KEYS.origin]);
  const request = clone(h.store.request), ledger = clone(h.store.ledger);
  h.advance(1);
  await writers.schedule({...h.store.plan, [field]: value}, options);
  assert.deepEqual(h.store[LOCAL_KEYS.origin], origin);
  assert.deepEqual(h.store.request, request);
  assert.deepEqual(h.store.ledger, ledger);
  assert.equal(h.context.OnStarvoiceLocalCaptureSource.requestProof(await h.journal.read()).requestId, request.id);
});

test('schedule deferral before first launch still requires actual start_local_capture and cannot fall back to legacy', async () => {
  const {h, writers, options} = await fixture();
  const origin = clone(h.store[LOCAL_KEYS.origin]);
  await writers.schedule({...h.store.plan, lastRunStatus: 'deferred', nextRunAt: '2026-09-08T12:00:00.000Z'}, options);
  assert.deepEqual(h.store[LOCAL_KEYS.origin], origin);
  const result = await h.createOriginal();
  assert.equal(result.handled, true);
  assert.equal(result.request.strictControlCandidate, true);
  assert.deepEqual(h.queries.map(query => query.action), ['admit_local_plan', 'start_local_capture']);
});

for (const cloud of [false, true]) test(`${cloud ? 'cloud/import' : 'ordinary author'} save revokes only the plan witness, even for identical configuration`, async () => {
  const {h, writers, options} = await fixture({withRequest: true});
  const requestProof = clone(h.store[LOCAL_KEYS.origin].request);
  await writers.ordinary(clone(h.store.plan), {...options, confirmCloudScope: cloud});
  assert.equal(h.store[LOCAL_KEYS.origin].plan, null);
  assert.deepEqual(h.store[LOCAL_KEYS.origin].request, requestProof);
});

for (const token of [true, {}, {scheduleOnly: true}, {preserveOrigin: true}, 'LOCAL_PLAN_SCHEDULE_WRITE']) {
  test(`renderer JSON cannot forge the private schedule capability: ${JSON.stringify(token)}`, async () => {
    const {h, writers, options} = await fixture({withRequest: true});
    const requestProof = clone(h.store[LOCAL_KEYS.origin].request);
    await writers.ordinary(clone(h.store.plan), options, token);
    assert.equal(h.store[LOCAL_KEYS.origin].plan, null);
    assert.deepEqual(h.store[LOCAL_KEYS.origin].request, requestProof);
  });
}

for (const [name, mutate] of [
  ['unknown origin version', h => {h.store[LOCAL_KEYS.origin].version = 2;}],
  ['missing plan proof', h => {delete h.store[LOCAL_KEYS.origin].plan;}],
  ['false plan proof', h => {h.store[LOCAL_KEYS.origin].plan = false;}],
  ['invalid proof kind', h => {h.store[LOCAL_KEYS.origin].plan.kind = 'cloud-plan';}],
  ['different proof fingerprint', h => {h.store[LOCAL_KEYS.origin].plan.planFingerprint = 'f'.repeat(64);}],
  ['different raw stored keywords', h => {h.store.plan.keywords = ['changed'];}],
  ['unknown raw stored configuration', h => {h.store.plan.unknownControl = true;}],
  ['different proof configuration', h => {h.store[LOCAL_KEYS.origin].plan.planSnapshot.keywords = ['changed'];}],
]) test(`unknown/mismatched ${name} is rejected without clearing or rewriting evidence`, async () => {
  const {h, writers, options, effects} = await fixture();
  const desired = clone(h.store.plan);
  mutate(h);
  const before = clone(h.store), count = h.writes.length;
  await assert.rejects(writers.schedule(desired, options), {code: 'local_plan_schedule_origin_unproven'});
  assert.deepEqual(h.store, before);
  assert.equal(h.writes.length, count);
  assert.deepEqual(effects, []);
});

for (const change of [{keywords: ['changed']}, {platform: 'douyin'}, {enabled: false}, {autoLoop: true, maxRounds: 5}]) {
  test(`internal capability cannot authorize a configuration edit: ${JSON.stringify(change)}`, async () => {
    const {h, writers, options} = await fixture();
    const before = clone(h.store);
    await assert.rejects(writers.schedule({...h.store.plan, ...change}, options), {code: 'local_plan_schedule_origin_unproven'});
    assert.deepEqual(h.store, before);
  });
}

test('an earlier Q writer changing authored fields wins over a queued schedule projection', async () => {
  const {h, writers, options, context} = await fixture();
  const desired = clone(h.store.plan), origin = clone(h.store[LOCAL_KEYS.origin]);
  const entered = deferred(), release = deferred();
  const previous = context.OnStarvoiceControlStateFence.run(async () => {
    entered.resolve();
    await release.promise;
    h.store.plan.keywords = ['newer-author-fields'];
  });
  await entered.promise;
  const queued = writers.schedule(desired, options);
  release.resolve(); await previous;
  await assert.rejects(queued, {code: 'local_plan_schedule_origin_unproven'});
  assert.deepEqual(h.store.plan.keywords, ['newer-author-fields']);
  assert.deepEqual(h.store[LOCAL_KEYS.origin], origin);
});

test('quota failure preserves the complete plan and origin instead of silently downgrading', async () => {
  const {h, writers, options} = await fixture();
  const before = clone(h.store);
  h.hooks.beforeSet = () => {throw new Error('synthetic quota');};
  await assert.rejects(writers.schedule({...h.store.plan, nextRunAt: '2026-09-08T12:00:00.000Z'}, options), /synthetic quota/);
  assert.deepEqual(h.store, before);
});

test('ordinary legacy plans and explicitly revoked plan witnesses retain the previous scheduler path', async () => {
  for (const revoked of [false, true]) {
    const {h, writers, options} = await fixture({legacy: !revoked});
    if (revoked) h.store[LOCAL_KEYS.origin].plan = null;
    await writers.schedule({...h.store.plan, lastRunStatus: 'deferred'}, options);
    assert.equal(h.store.plan.lastRunStatus, 'deferred');
    assert.equal(h.store[LOCAL_KEYS.origin]?.plan ?? null, null);
  }
});

test('all real call sites separate internal projection capability from author/cloud writes', () => {
  const sites = [];
  function walk(node, owner = '') {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration') owner = node.id.name;
    if (node.type === 'CallExpression' && node.callee?.name === 'saveUnattendedKeywordPlan') {
      sites.push({owner, capability: node.arguments[2]?.name || '', arity: node.arguments.length});
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'range', 'tokens', 'comments'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(entry => walk(entry, owner));
      else walk(child, owner);
    }
  }
  walk(ast);
  const internal = {cancelUnattendedKeywordRunFromControl: 1,
    handleUnattendedKeywordAlarm: 6, reconcileUnattendedKeywordPlanSchedule: 5};
  assert.equal(sites.length, 15, 'new call sites require an explicit provenance classification');
  for (const [owner, count] of Object.entries(internal)) {
    const selected = sites.filter(site => site.owner === owner);
    assert.equal(selected.length, count);
    assert.ok(selected.every(site => site.capability === 'LOCAL_PLAN_SCHEDULE_WRITE' && site.arity === 3));
  }
  const ordinary = sites.filter(site => !Object.hasOwn(internal, site.owner));
  assert.equal(ordinary.length, 3);
  assert.ok(ordinary.every(site => !site.capability && site.arity === 2));
});
