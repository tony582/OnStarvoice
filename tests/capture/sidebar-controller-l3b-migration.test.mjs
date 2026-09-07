import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import {createSidebarTaskController} from '../../sidebar/task-controller/coordinator.js';
import {createKeywordTaskState, KEYWORD_SORT_DIMENSION} from '../../sidebar/task-controller/keyword-state.js';
import {createLegacyKeywordView} from '../../sidebar/legacy-view/coordinator.js';
import {createLegacyCaptureProgressView} from '../../sidebar/legacy-view/capture-progress.js';
import {PAGE_TYPE} from '../../utils/constants.js';
import {AST_AUDIT_VERSION, parseSidebarAst, findSidebarFunctionAst, hashSidebarFunctionAst} from '../helpers/sidebar-controller-ast.mjs';
import {
  createSidebarTestScope,
  readSidebarFunction,
  readSidebarFunctionOwner,
  readSidebarRuntimeSources,
} from '../helpers/sidebar-controller-source.mjs';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('tests/fixtures/sidebar-controller-l3b-migration.json', root), 'utf8'));
const historicalSource = readFileSync(new URL(`tests/fixtures/${manifest.historicalFixture}`, root), 'utf8');
const historical = JSON.parse(historicalSource);
const runtimeSources = readSidebarRuntimeSources();
const runtimeAsts = new Map(runtimeSources.map(entry => [entry.path, parseSidebarAst(entry.source)]));
const hash = source => createHash('sha256').update(source.split('\n').map(line => line.trim()).join('\n')).digest('hex');
const activeStopDeltaSource = readFileSync(new URL('tests/fixtures/sidebar-controller-active-stop-delta.json', root), 'utf8');
const activeStopDelta = JSON.parse(activeStopDeltaSource);
assert.equal(activeStopDelta.baseline, '3c19c5ea14c9ac1f68a21da8b8caf30353b459d1');
assert.equal(createHash('sha256').update(activeStopDeltaSource).digest('hex'),
  '71f5a4b27e36cb306aa92c2b24af2fae7a6f6f40f7364739f6f33c1d21bad923');
assert.equal(activeStopDelta.entries.length, 12);
const activeStopChanges = new Map(activeStopDelta.entries.map(entry => [entry.name, entry]));
assert.equal(activeStopChanges.size, 12);
function rawSidebarFunction(name) {
  const owner = readSidebarFunctionOwner(name);
  const node = findSidebarFunctionAst(runtimeAsts.get(owner.path), name);
  return owner.source.slice(...node.range);
}
function withoutVerifiedActiveStopDelta(name, source) {
  const change = activeStopChanges.get(name);
  if (!change) return source;
  assert.equal(readSidebarFunctionOwner(name).path, change.owner, `${name}: strict delta owner`);
  assert.equal(createHash('sha256').update(source).digest('hex'), change.sha256,
    `${name}: exact strict body before inverse verification`);
  const lines = source.split('\n');
  for (const patch of [...change.reverse].reverse()) {
    assert.equal(Number.isSafeInteger(patch.at) && patch.at >= 0, true);
    assert.deepEqual(lines.slice(patch.at, patch.at + patch.remove.length), patch.remove,
      `${name}: exact strict delta at ${patch.at}`);
    lines.splice(patch.at, patch.remove.length, ...patch.insert);
  }
  return lines.join('\n');
}
const privateNames = ['setRecoveryCopy', 'isRecoveryActionAvailable', 'handoffRecoveryFocus'];
const delegateNames = ['buildCaptureProgressText', 'normalizeProgressCount'];
const names = entries => entries.map(entry => entry.name).sort();
const canonical = value => {
  if (Object.prototype.toString.call(value) === '[object Set]') return {set: [...value].map(canonical)};
  if (Array.isArray(value)) return Array.from(value, canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};

test('L3-B pins 216 actual single owners without rewriting L3-A evidence or reconstructing its monolith', () => {
  assert.equal(manifest.baseline, '2c997709c0a4223784901aeaa461fab46108ba8b');
  assert.equal(createHash('sha256').update(historicalSource).digest('hex'), manifest.historicalFixtureSha256);
  assert.equal(manifest.entries.length, 216);
  assert.equal(new Set(names(manifest.entries)).size, 216);
  assert.equal(manifest.entries.filter(entry => entry.owner.startsWith('sidebar/task-controller/')).length, 138);
  assert.equal(manifest.entries.filter(entry => entry.owner.startsWith('sidebar/legacy-view/')).length, 78);
  const originalHostNames = new Set(historical.entries.filter(entry => !entry.module).map(entry => entry.name));
  const controller = createSidebarTaskController({});
  const view = createLegacyKeywordView({ports: {}, application: {}, keywordModel: {}});
  for (const entry of [...manifest.entries, ...manifest.additionalHostTransitions]) {
    assert.equal(originalHostNames.has(entry.name), true, `${entry.name}: original host declaration`);
    const matches = runtimeSources.flatMap(owner =>
      [...owner.source.matchAll(new RegExp(`^ *(?:export )?(?:async )?function ${entry.name}\\s*\\(`, 'gm'))].map(() => owner.path));
    assert.deepEqual(matches, [entry.owner], `${entry.name}: explicit single owner`);
    assert.equal(readSidebarFunctionOwner(entry.name).path, entry.owner);
    const actualApi = entry.owner.startsWith('sidebar/task-controller/') ? controller : view;
    assert.equal(typeof actualApi[entry.name], 'function', `${entry.name}: actual factory export`);
    assert.equal(hash(actualApi[entry.name].toString()), hash(readSidebarFunction(entry.name)), `${entry.name}: real implementation wiring`);
    if (actualApi === view) assert.equal(Object.hasOwn(controller, entry.name), false, `${entry.name}: view implementation is not a controller export`);
  }
  const host = runtimeSources.find(entry => entry.path === 'sidebar/sidebar-logic.js').source;
  const remaining = [...host.matchAll(/^(?:export )?(?:async )?function\s+(\w+)\s*\(/gmu)].map(match => match[1]).filter(name => originalHostNames.has(name));
  // The subsequent legacy-command batch separately migrates this one host
  // event adapter; keep the original 216 + 2 migration ledger unchanged.
  assert.equal(readSidebarFunctionOwner('handleTaskCenterAction').path, 'sidebar/legacy-view/task-center-actions.js');
  assert.equal(remaining.length, originalHostNames.size - 216 - 2 - 1);
  assert.equal(remaining.length, 293);
});

test('default CI verifies the exact strict delta then compares 202 normalized ASTs to unchanged parent hashes and excludes 14 semantic transitions', () => {
  assert.equal(manifest.normalizedAstAudit.version, AST_AUDIT_VERSION);
  assert.equal(manifest.normalizedAstAudit.equivalentCount, 202);
  const semantic = Object.keys(manifest.normalizedAstAudit.semanticTransitions).sort();
  assert.deepEqual(semantic, [
    'persistBatchDraftForPlatform', 'applyBatchDraftToInputs', 'renderKeywordPlanStatus',
    'syncKeywordPlanProgressPanel', 'populateKeywordPlanUI', 'setKeywordStrategyTab',
    'handleOpenKeywordLongtail', 'handleBenchmarkDiscoveryResultActions',
    'renderInsightCardToImage', 'renderKeywordOpportunityCardToImage', 'renderBenchmarkDiscoveryCardToImage',
    'showInsightImagePreview', 'loadMonitorSubscriptions', 'handleMonitorListClick',
  ].sort());
  let equivalents = 0;
  for (const entry of manifest.entries) {
    assert.match(entry.baselineNormalizedAstSha256, /^[a-f0-9]{64}$/u, entry.name);
    const verifiedSource = withoutVerifiedActiveStopDelta(entry.name, rawSidebarFunction(entry.name));
    const actual = hashSidebarFunctionAst(findSidebarFunctionAst(parseSidebarAst(verifiedSource), entry.name));
    if (semantic.includes(entry.name)) {
      assert.notEqual(actual, entry.baselineNormalizedAstSha256, `${entry.name}: semantic change must not claim AST equivalence`);
    } else {
      assert.equal(actual, entry.baselineNormalizedAstSha256, `${entry.name}: baseline-normalized AST changed`);
      equivalents++;
    }
  }
  assert.equal(equivalents, 202);
});

test('two separately recorded in-scope host progress transitions keep explicit provenance outside the original 216', () => {
  assert.deepEqual(names(manifest.additionalHostTransitions), ['hideProgressPanelOnly', 'showProgress']);
  for (const entry of manifest.additionalHostTransitions) {
    assert.equal(manifest.entries.some(original => original.name === entry.name), false);
    assert.equal(entry.owner, 'sidebar/task-controller/progress-visibility.js');
    assert.equal(entry.transition, 'progress-visibility-semantic-presentation-port');
    assert.match(entry.scope, /Separately recorded in-scope/u);
    assert.notEqual(hashSidebarFunctionAst(findSidebarFunctionAst(runtimeAsts.get(entry.owner), entry.name)), entry.baselineNormalizedAstSha256);
  }
});

test('all 165 L3-A operations retain historical hashes after exact strict-delta verification except the 21 categorized semantic-port changes', () => {
  const moved = historical.entries.filter(entry => entry.module);
  assert.equal(moved.length, 165);
  assert.equal(Object.keys(manifest.l3aTransitions).length, 24);
  const changed = [];
  for (const entry of moved) {
    const actualHash = hash(withoutVerifiedActiveStopDelta(entry.name, rawSidebarFunction(entry.name)));
    const transition = manifest.l3aTransitions[entry.name];
    if (!transition || transition === 'unchanged-body-now-view-private') {
      assert.equal(actualHash, entry.migratedSha256, `${entry.name}: no undeclared body change`);
    } else {
      assert.notEqual(actualHash, entry.migratedSha256, `${entry.name}: explicitly changed body must not masquerade as the old hash`);
      changed.push(entry.name);
    }
  }
  assert.equal(changed.length, 21);
  for (const name of Object.keys(manifest.l3aTransitions)) assert.equal(moved.some(entry => entry.name === name), true, `unknown transition ${name}`);
});

test('five presentation implementations retain exact old bodies while only two scalar delegates stay public', () => {
  const controller = createSidebarTaskController({});
  const view = createLegacyCaptureProgressView({});
  for (const name of privateNames) {
    assert.equal(readSidebarFunctionOwner(name).path, 'sidebar/legacy-view/capture-progress.js');
    assert.equal(Object.hasOwn(controller, name), false);
    assert.equal(Object.hasOwn(view, name), false);
  }
  for (const name of delegateNames) {
    const entry = historical.entries.find(entry => entry.name === name);
    assert.equal(hash(view[name].toString()), entry.migratedSha256, `${name}: unchanged actual view body`);
    assert.match(controller[name].toString(), new RegExp(`return taskView\\.${name}\\(`, 'u'));
  }
});

test('30 application and six presentation initializers retain their original values and separate instance ownership', () => {
  assert.equal(manifest.state.length, 36);
  const applicationEntries = manifest.state.filter(entry => entry.owner === 'controllerState');
  const viewEntries = manifest.state.filter(entry => entry.owner === 'legacyViewState');
  assert.equal(applicationEntries.length, 30);
  assert.equal(viewEntries.length, 6);
  assert.deepEqual(Object.keys(createKeywordTaskState()).sort(), names(applicationEntries));
  const a = createSidebarTestScope({});
  const b = createSidebarTestScope({});
  assert.deepEqual(Object.keys(a.legacyViewState).sort(), names(viewEntries));
  for (const entry of manifest.state) {
    const expected = vm.runInNewContext(`(${entry.initializer})`, {PAGE_TYPE, KEYWORD_SORT_DIMENSION});
    assert.deepEqual(canonical(a[entry.owner][entry.name]), canonical(expected), entry.name);
    if (expected && typeof expected === 'object') assert.notEqual(a[entry.owner][entry.name], b[entry.owner][entry.name], `${entry.name}: independent mutable initializer`);
    assert.equal(Object.hasOwn(a, entry.name), false, `${entry.name}: no hidden global state proxy`);
  }
  a.controllerState.expandedKeywordsBuffer.push('synthetic keyword');
  a.legacyViewState.expandedKeywordInsightCategoryIds.add('synthetic category');
  assert.deepEqual(b.controllerState.expandedKeywordsBuffer, []);
  assert.equal(b.legacyViewState.expandedKeywordInsightCategoryIds.size, 0);
  for (const entry of viewEntries) assert.equal(Object.hasOwn(a.controllerState, entry.name), false, `${entry.name}: view state is not task state`);
  for (const entry of applicationEntries) assert.equal(Object.hasOwn(a.legacyViewState, entry.name), false, `${entry.name}: task state is not view state`);
});

test('real module assembly exposes no old host binding, controller state bag or raw DOM capability', () => {
  const controller = createSidebarTaskController({});
  for (const name of ['controllerState', 'controllerPorts', 'controllerBindings', 'controllerOperations', 'state', 'document', 'window']) {
    assert.equal(Object.hasOwn(controller, name), false);
  }
  const source = runtimeSources.find(entry => entry.path === 'sidebar/task-controller/coordinator.js').source;
  assert.doesNotMatch(source, /controllerBindings/u);
  const host = runtimeSources.find(entry => entry.path === 'sidebar/sidebar-logic.js').source;
  for (const {name} of manifest.state) assert.doesNotMatch(host, new RegExp(`\\b(?:let|const) ${name}\\b`, 'u'), `${name}: no second host owner`);
});

// Optional exact-object verification is read-only and never fetches a missing
// commit. Default CI checks above need no Git history (including shallow CI).
if (process.env.ONSTARVOICE_L3B_BASELINE_REF) {
  assert.equal(process.env.ONSTARVOICE_L3B_BASELINE_REF, manifest.baseline);
  const baseline = execFileSync('git', ['show', `${manifest.baseline}:sidebar/sidebar-logic.js`], {cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  const baselineAst = parseSidebarAst(baseline);
  test('L3-B baseline hashes describe the exact authorized original Git object', () => {
    for (const entry of [...manifest.entries, ...manifest.additionalHostTransitions]) {
      const declaration = findSidebarFunctionAst(baselineAst, entry.name);
      const [start, end] = declaration.range;
      assert.equal(hash(baseline.slice(start, end)), entry.baselineSha256, entry.name);
      assert.equal(hashSidebarFunctionAst(declaration), entry.baselineNormalizedAstSha256, `${entry.name}: exact parent AST provenance`);
    }
    for (const entry of manifest.state) assert.ok(baseline.includes(`${entry.kind} ${entry.name} = ${entry.initializer};`), entry.name);
  });
}
