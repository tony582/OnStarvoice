import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {Script} from 'node:vm';

// The fixture is a location manifest, never an executable copy of production.
// Read each named function from its one actual owner; a moved/missing/ambiguous
// declaration fails explicitly instead of silently returning an empty section.
const root = new URL('../../', import.meta.url);
const {entries} = JSON.parse(readFileSync(new URL(
  'tests/fixtures/capture-delivery-body-fingerprints.json', root,
), 'utf8'));
const owners = new Map(entries.map(({name, module}) => [name, module]));
assert.equal(owners.size, entries.length, 'delivery function ownership must be unique');

export function readCaptureFunction(name) {
  assert.match(name, /^[A-Za-z_$][\w$]*$/, 'expected an exact function name');
  const owner = owners.get(name);
  const path = owner ? `utils/capture/delivery/${owner}.js` : 'utils/capture-sync.js';
  const source = readFileSync(new URL(path, root), 'utf8');
  let matches = [...source.matchAll(new RegExp(
    `^( *)(?:export )?(?:async )?function ${name}\\s*\\(`, 'gm',
  ))];
  if (!owner && source.includes('export function createCaptureSyncScope(')) {
    const facadeStart = source.indexOf('\nconst legacyChromeApi =');
    assert.ok(facadeStart > 0, 'capture scope must have an explicit legacy facade');
    const facades = matches.filter((match) => match.index > facadeStart);
    assert.ok(facades.length <= 1, `ambiguous legacy facade for ${name}`);
    for (const facade of facades) {
      const body = source.slice(facade.index, source.indexOf('\n}', facade.index) + 2);
      assert.match(body, new RegExp(`^export (?:async )?function ${name}\\(\\.\\.\\.args\\) \\{\\n  return getLegacyCaptureSyncScope\\(\\)\\.${name}\\(\\.\\.\\.args\\);\\n\\}$`),
        `legacy ${name} must remain only an exact same-name delegation`);
    }
    matches = matches.filter((match) => match.index < facadeStart);
  }
  assert.equal(matches.length, 1, `${path}: expected exactly one real declaration of ${name}`);
  const [{index: start, 1: indent}] = matches;
  const closing = new RegExp(`^${indent}\\}(?=\\r?$)`, 'gm');
  closing.lastIndex = start;
  const end = closing.exec(source);
  assert.ok(end, `${path}: missing closing brace for ${name}`);
  // Only remove the ESM export keyword for isolated VM execution. In particular,
  // state.activeListCaptureCheckpointSession remains the production state access.
  const body = source.slice(start, end.index + end[0].length).replace(/^( *)export /, '$1');
  new Script(`(${body.trim()})`, {filename: `${path}#${name}`});
  return body;
}

export function readCaptureFunctions(names) {
  assert.equal(new Set(names).size, names.length, 'duplicate requested capture functions');
  return names.map(readCaptureFunction).join('\n\n');
}

// Whole-surface prohibitions must inspect each real module independently, never
// concatenate them into a fabricated monolithic capture-sync source.
export function readCaptureDeliverySources() {
  const directory = new URL('utils/capture/delivery/', root);
  const files = readdirSync(directory).filter((name) => name.endsWith('.js')).sort();
  assert.ok(files.includes('coordinator.js') && files.includes('store.js'), 'missing delivery boundaries');
  return files.map((name) => ({
    path: `utils/capture/delivery/${name}`,
    source: readFileSync(new URL(name, directory), 'utf8'),
  }));
}

export function readCaptureConstant(name) {
  assert.match(name, /^[A-Za-z_$][\w$]*$/, 'expected an exact constant name');
  const source = readFileSync(new URL('utils/capture-sync.js', root), 'utf8');
  const declarations = [...source.matchAll(new RegExp(`^const ${name} =`, 'gm'))];
  assert.equal(declarations.length, 1, `expected one host constant ${name}`);
  const start = declarations[0].index;
  const end = source.indexOf(';', start);
  assert.ok(end > start, `missing terminator for host constant ${name}`);
  const declaration = source.slice(start, end + 1);
  new Script(declaration, {filename: `utils/capture-sync.js#${name}`});
  return declaration;
}
