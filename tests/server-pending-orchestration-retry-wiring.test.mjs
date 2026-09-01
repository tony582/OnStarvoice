import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  reconcilePendingOrchestrationRetries as canonicalReconciler,
} from '../server/modules/capture/infrastructure/postgres-pending-orchestration-retry.js';
import {
  reconcilePendingOrchestrationRetries as routeCompatibilityReconciler,
} from '../server/routes/capture-orchestrations.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const routePath = path.join(
  repositoryRoot,
  'server',
  'routes',
  'capture-orchestrations.js',
);
const cronPath = path.join(repositoryRoot, 'server', 'cron.js');
const adapterPath = path.join(
  repositoryRoot,
  'server',
  'modules',
  'capture',
  'infrastructure',
  'postgres-pending-orchestration-retry.js',
);
const applicationPath = path.join(
  repositoryRoot,
  'server',
  'modules',
  'capture',
  'application',
  'pending-orchestration-retry.js',
);

const staticModuleSpecifierPattern =
  /\b(?:import|export)\s+(?:[\w*\s{},]*?\s+from\s+)?['"]([^'"]+)['"]/gu;
const dynamicModuleSpecifierPattern =
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;

function moduleSpecifiers(source) {
  return [
    ...source.matchAll(staticModuleSpecifierPattern),
    ...source.matchAll(dynamicModuleSpecifierPattern),
  ].map(match => match[1]);
}

function resolveRelativeModule(fromPath, specifier) {
  const unresolved = path.resolve(path.dirname(fromPath), specifier);
  const candidates = [
    unresolved,
    `${unresolved}.js`,
    `${unresolved}.mjs`,
    path.join(unresolved, 'index.js'),
    path.join(unresolved, 'index.mjs'),
  ];
  const resolved = candidates.find(candidate => existsSync(candidate));
  assert.ok(resolved, `could not resolve ${specifier} imported by ${fromPath}`);
  return resolved;
}

function collectRelativeImportGraph(entryPaths) {
  const pending = [...entryPaths];
  const visited = new Set();
  const externalSpecifiers = new Set();
  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (visited.has(currentPath)) continue;
    visited.add(currentPath);
    const source = readFileSync(currentPath, 'utf8');
    assert.equal(
      [...source.matchAll(/\bimport\s*\(/gu)].length,
      [...source.matchAll(dynamicModuleSpecifierPattern)].length,
      `non-literal dynamic import in canonical graph: ${currentPath}`,
    );
    for (const specifier of moduleSpecifiers(source)) {
      if (!specifier.startsWith('.')) {
        externalSpecifiers.add(specifier);
        continue;
      }
      pending.push(resolveRelativeModule(currentPath, specifier));
    }
  }
  return {paths: [...visited], externalSpecifiers: [...externalSpecifiers]};
}

test('pending retry route export preserves canonical adapter identity', () => {
  assert.strictEqual(routeCompatibilityReconciler, canonicalReconciler);
});

test('pending retry canonical dependency graph is route and Express independent', () => {
  const graph = collectRelativeImportGraph([adapterPath, applicationPath]);
  assert.equal(
    graph.paths.some(modulePath => modulePath.includes(`${path.sep}routes${path.sep}`)),
    false,
  );
  assert.equal(
    graph.externalSpecifiers.some(specifier =>
      specifier === 'express' || specifier.startsWith('express/')
    ),
    false,
  );
});

test('Cron imports the canonical adapter while the route keeps only compatibility wiring', () => {
  const cronSource = readFileSync(cronPath, 'utf8');
  const routeSource = readFileSync(routePath, 'utf8');
  const adapterSource = readFileSync(adapterPath, 'utf8');

  assert.match(
    cronSource,
    /from '\.\/modules\/capture\/infrastructure\/postgres-pending-orchestration-retry\.js';/u,
  );
  assert.doesNotMatch(
    cronSource,
    /from '\.\/routes\/capture-orchestrations\.js';/u,
  );
  assert.match(
    routeSource,
    /export \{[\s\S]*reconcilePendingOrchestrationRetries[\s\S]*\} from '\.\.\/modules\/capture\/infrastructure\/postgres-pending-orchestration-retry\.js';/u,
  );
  assert.doesNotMatch(
    routeSource,
    /(?:async function|const) reconcilePendingOrchestrationRetries/u,
  );
  assert.match(
    adapterSource,
    /createPendingOrchestrationRetryReconciler\(\{[\s\S]*withTransaction,[\s\S]*dispatchOnePendingRetry: dispatchOnePendingOrchestrationRetry/u,
  );
});
