import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import vm, {Script, runInNewContext} from 'node:vm';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('tests/fixtures/sidebar-controller-migration.json', root), 'utf8'));
const entries = manifest.entries;
const owners = new Map(entries.map(entry => [entry.name, entry]));
const preparedScopes = new WeakSet();
assert.equal(owners.size, entries.length, 'Sidebar function ownership must be unique');

export function readSidebarFunction(name) {
  const owner = owners.get(name);
  assert.ok(owner, `unknown Sidebar function: ${name}`);
  const path = owner.module ? `sidebar/task-controller/${owner.module}.js` : 'sidebar/sidebar-logic.js';
  const source = readFileSync(new URL(path, root), 'utf8');
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
  const directory = new URL('sidebar/task-controller/', root);
  const files = readdirSync(directory).filter(name => name.endsWith('.js')).sort();
  assert.ok(files.includes('coordinator.js'));
  return files.map(name => ({path: `sidebar/task-controller/${name}`, source: readFileSync(new URL(name, directory), 'utf8')}));
}

export function createSidebarTestScope(input = {}) {
  if (preparedScopes.has(input)) return input;
  const coordinator = readFileSync(new URL('sidebar/task-controller/coordinator.js', root), 'utf8');
  const marker = '  const controllerState = {';
  const start = coordinator.indexOf(marker);
  const end = coordinator.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start, 'missing actual controller state initializer');
  const defaults = runInNewContext(`${coordinator.slice(start, end + 5)}\ncontrollerState;`);
  const controllerState = {...defaults, ...input.controllerState};
  const controllerBindings = {...input.controllerBindings};
  // Move explicitly supplied test fields into their real production namespace.
  // No production source is rewritten and no global compatibility getters exist.
  for (const {name} of manifest.state) {
    if (Object.hasOwn(input, name)) { controllerState[name] = input[name]; delete input[name]; }
  }
  for (const name of manifest.shared) {
    if (Object.hasOwn(input, name)) {
      Object.defineProperty(controllerBindings, name, {
        enumerable: true, configurable: true,
        get: () => input[name], set: value => { input[name] = value; },
      });
    }
  }
  input.controllerState = controllerState;
  input.controllerBindings = controllerBindings;
  input.sidebarTaskController ??= {};
  for (const name of manifest.readStates) {
    const read = `read${name[0].toUpperCase()}${name.slice(1)}`;
    input.sidebarTaskController[read] ??= () => controllerState[name];
  }
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
