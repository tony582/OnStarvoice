import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import vm, {Script, runInNewContext} from 'node:vm';
import {createKeywordTaskState} from '../../sidebar/task-controller/keyword-state.js';
import {createKeywordPlanView} from '../../sidebar/legacy-view/keyword-plan.js';
import {createKeywordStrategyView} from '../../sidebar/legacy-view/keyword-strategy.js';
import {createKeywordSharingView} from '../../sidebar/legacy-view/keyword-sharing.js';
import {createMonitorSettingsView} from '../../sidebar/legacy-view/monitor-settings.js';
import {createLegacyCaptureInputsView} from '../../sidebar/legacy-view/capture-inputs.js';
import {createLegacyKeywordInputsView} from '../../sidebar/legacy-view/keyword-inputs.js';
import {createLegacyCaptureProgressView} from '../../sidebar/legacy-view/capture-progress.js';
import {createLegacyProgressVisibilityView} from '../../sidebar/legacy-view/progress-visibility.js';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('tests/fixtures/sidebar-controller-migration.json', root), 'utf8'));
const entries = manifest.entries;
const owners = new Map(entries.map(entry => [entry.name, entry]));
const preparedScopes = new WeakSet();
// These two existing public operations deliberately delegate to view-owned
// formatting. Every other historical declaration must have exactly one owner.
const presentationDelegates = new Set(['buildCaptureProgressText', 'normalizeProgressCount']);
assert.equal(owners.size, entries.length, 'Sidebar function ownership must be unique');

export function readSidebarFunction(name) {
  const {path, source} = readSidebarFunctionOwner(name);
  const matches = [...source.matchAll(new RegExp(`^( *)(?:export )?(?:async )?function ${name}\\s*\\(`, 'gm'))];
  assert.equal(matches.length, 1, `${path}: expected one real declaration of ${name}`);
  const [{index: start, 1: indent}] = matches;
  const closing = new RegExp(`^${indent}\\}(?=\\r?$)`, 'gm');
  closing.lastIndex = start;
  const end = closing.exec(source);
  assert.ok(end, `${path}: missing end of ${name}`);
  // Formatting/ESM wrapper only: production state and port accesses stay intact.
  const body = source.slice(start, end.index + end[0].length)
    .split('\n').map(line => line.startsWith(indent) ? line.slice(indent.length) : line).join('\n')
    .replace(/^export /, '');
  new Script(`(${body})`, {filename: `${path}#${name}`});
  return body;
}

// L3-A's manifest is historical evidence and retains the original source order.
// L3-B moves some of those declarations again, so resolve the actual owner rather
// than changing old hashes or pretending those functions still live in the host.
export function readSidebarFunctionOwner(name) {
  assert.ok(owners.has(name), `unknown Sidebar function: ${name}`);
  const declaration = new RegExp(`^ *(?:export )?(?:async )?function ${name}\\s*\\(`, 'gm');
  const matches = readSidebarRuntimeSources().flatMap(entry =>
    [...entry.source.matchAll(declaration)].map(() => entry));
  if (presentationDelegates.has(name)) {
    assert.deepEqual(matches.map(entry => entry.path).sort(), [
      'sidebar/legacy-view/capture-progress.js', 'sidebar/task-controller/progress.js',
    ], `expected only the explicit presentation implementation and controller delegate for ${name}`);
    return matches.find(entry => entry.path === 'sidebar/task-controller/progress.js');
  }
  assert.equal(matches.length, 1, `expected one actual Sidebar owner for ${name}`);
  return matches[0];
}

export function readSidebarFunctions(names) {
  assert.equal(new Set(names).size, names.length, 'duplicate Sidebar function selection');
  return names.map(readSidebarFunction).join('\n\n');
}

// Old marker pairs identify a bounded test group, not a reconstructed old file.
// Every selected declaration is read from its current, unique production owner.
export function readSidebarSection(startMarker, endMarker) {
  if (/^const [A-Za-z_$]/.test(startMarker)) {
    assert.equal(startMarker, 'const OPTIONAL_CAPTURE_ASSIST_SESSION_CODES = new Set([', 'unsupported host constant boundary');
    assert.equal(endMarker, 'async function startOptionalCaptureAssistSession(options = {})', 'unknown host constant ending boundary');
    assert.ok(owners.has('startOptionalCaptureAssistSession'), 'missing known function following host constant');
    const source = readFileSync(new URL('sidebar/sidebar-logic.js', root), 'utf8');
    const start = source.indexOf(startMarker);
    const end = source.indexOf(';', start);
    assert.ok(start >= 0 && end > start, `missing actual host constant: ${startMarker}`);
    assert.equal(source.indexOf(startMarker, start + startMarker.length), -1, 'ambiguous host constant');
    return source.slice(start, end + 1);
  }
  const nameOf = marker => /(?:async )?function\s+(\w+)\s*\(/.exec(marker)?.[1];
  const first = owners.get(nameOf(startMarker));
  const last = owners.get(nameOf(endMarker));
  assert.ok(first, `expected an exact starting function: ${startMarker}`);
  assert.ok(last, `expected an exact ending function: ${endMarker}`);
  assert.ok(last.index > first.index, `invalid Sidebar function interval: ${startMarker} -> ${endMarker}`);
  return readSidebarFunctions(entries.slice(first.index, last.index).map(entry => entry.name));
}

export function readSidebarControllerSources() {
  // Existing whole-runtime safety assertions must not lose migrated view code.
  return [...readSidebarDirectorySources('task-controller'), ...readSidebarDirectorySources('legacy-view'), ...readSidebarDirectorySources('legacy-application')];
}

function readSidebarDirectorySources(directoryName) {
  const directory = new URL(`sidebar/${directoryName}/`, root);
  const files = readdirSync(directory).filter(name => name.endsWith('.js')).sort();
  return files.map(name => ({path: `sidebar/${directoryName}/${name}`, source: readFileSync(new URL(name, directory), 'utf8')}));
}

export function readSidebarRuntimeSources() {
  return [{path: 'sidebar/sidebar-logic.js', source: readFileSync(new URL('sidebar/sidebar-logic.js', root), 'utf8')},
    ...readSidebarControllerSources()];
}

function readActualStateInitializer(path, name, context = {}) {
  const source = readFileSync(new URL(path, root), 'utf8');
  const marker = `  const ${name} = {`;
  const start = source.indexOf(marker);
  const end = source.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start, `missing actual ${name} initializer`);
  return runInNewContext(`${source.slice(start, end + 5)}\n${name};`, context);
}

export function createSidebarTestScope(input = {}) {
  if (preparedScopes.has(input)) return input;
  const defaults = readActualStateInitializer('sidebar/task-controller/coordinator.js', 'controllerState', {createKeywordTaskState});
  const viewDefaults = readActualStateInitializer('sidebar/legacy-view/coordinator.js', 'legacyViewState');
  const controllerState = {...defaults, ...input.controllerState};
  const legacyViewState = {...viewDefaults, ...input.legacyViewState};
  // Move explicitly supplied test fields into their real production namespace.
  // No production source is rewritten and no global compatibility getters exist.
  for (const name of Object.keys(defaults)) {
    if (Object.hasOwn(input, name)) { controllerState[name] = input[name]; delete input[name]; }
  }
  for (const name of Object.keys(viewDefaults)) {
    if (Object.hasOwn(input, name)) { legacyViewState[name] = input[name]; delete input[name]; }
  }
  input.controllerState = controllerState;
  input.legacyViewState = legacyViewState;
  input.sidebarTaskController ??= {};
  const coordinator = readFileSync(new URL('sidebar/task-controller/coordinator.js', root), 'utf8');
  const model = {};
  for (const [, read, name] of coordinator.matchAll(/\b(read\w+): \(\) => controllerState\.(\w+)/gu)) {
    input.sidebarTaskController[read] ??= () => controllerState[name];
    model[name] = () => controllerState[name];
  }
  for (const [, replace, name] of coordinator.matchAll(/\b(replace\w+): value => \(controllerState\.(\w+) = value\)/gu)) {
    input.sidebarTaskController[replace] ??= value => (controllerState[name] = value);
  }
  input.keywordModel ??= model;
  const application = new Proxy({}, {get: (_target, name) => (...args) => {
    assert.equal(typeof input[name], 'function', `missing explicit test application port ${String(name)}`);
    return input[name](...args);
  }});
  input.controllerOperations ??= application;
  // These are real legacy view factories, not duplicated DOM logic. Explicit
  // test ports win; application callbacks resolve only when the test calls them.
  const taskView = {};
  for (const factory of [createKeywordPlanView, createKeywordStrategyView, createKeywordSharingView, createMonitorSettingsView]) {
    Object.assign(taskView, factory({legacyViewState, ports: input, application, keywordModel: input.keywordModel, viewOperations: taskView}));
  }
  Object.assign(taskView, createLegacyCaptureInputsView(input), createLegacyKeywordInputsView(input),
    createLegacyCaptureProgressView(input), createLegacyProgressVisibilityView({...input,
      clearKeywordPlanProgressCountdown: application.clearKeywordPlanProgressCountdown,
      setCaptureButtonsDisabled: application.setCaptureButtonsDisabled,
    }), {isUnsupportedPlatformCoverVisible: application.isUnsupportedPlatformCoverVisible}, input.taskView);
  input.taskView = taskView;
  input.controllerPorts ??= {...input, taskView};
  preparedScopes.add(input);
  return input;
}

export function assertSidebarRuntimeDoesNotMatch(hostSource, pattern) {
  assert.doesNotMatch(hostSource, pattern, 'sidebar/sidebar-logic.js');
  for (const {path, source} of readSidebarControllerSources()) assert.doesNotMatch(source, pattern, path);
}

// Keep the existing isolated VM assertions while binding the actual owner state.
export const sidebarVm = Object.freeze({
  ...vm,
  createContext(input = {}, ...options) { return vm.createContext(createSidebarTestScope(input), ...options); },
  runInNewContext(source, input = {}, ...options) { return vm.runInNewContext(source, createSidebarTestScope(input), ...options); },
});
