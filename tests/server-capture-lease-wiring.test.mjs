import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  elasticAttemptBudgetAfterOutcome as canonicalElasticAttemptBudgetAfterOutcome,
  projectElasticAttemptBudget as canonicalProjectElasticAttemptBudget,
  projectElasticKeywordRecoveryStatus as canonicalProjectElasticKeywordRecoveryStatus,
} from '../server/modules/capture/application/control-outcome-projection.js';
import {
  reconcileElasticCaptureLeases as canonicalReconcileElasticCaptureLeases,
} from '../server/modules/capture/infrastructure/postgres-lease-reconciliation.js';
import {
  elasticAttemptBudgetAfterOutcome as routeElasticAttemptBudgetAfterOutcome,
  projectElasticAttemptBudget as routeProjectElasticAttemptBudget,
  projectElasticKeywordRecoveryStatus as routeProjectElasticKeywordRecoveryStatus,
  reconcileElasticCaptureLeases as routeReconcileElasticCaptureLeases,
} from '../server/routes/capture-cloud.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const routePath = path.join(repositoryRoot, 'server', 'routes', 'capture-cloud.js');
const cronPath = path.join(repositoryRoot, 'server', 'cron.js');
const projectionPath = path.join(
  repositoryRoot,
  'server',
  'modules',
  'capture',
  'application',
  'control-outcome-projection.js',
);
const leasePath = path.join(
  repositoryRoot,
  'server',
  'modules',
  'capture',
  'infrastructure',
  'postgres-lease-reconciliation.js',
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

test('lease and projection compatibility exports preserve canonical identity', () => {
  assert.strictEqual(
    routeReconcileElasticCaptureLeases,
    canonicalReconcileElasticCaptureLeases,
  );
  assert.strictEqual(
    routeElasticAttemptBudgetAfterOutcome,
    canonicalElasticAttemptBudgetAfterOutcome,
  );
  assert.strictEqual(
    routeProjectElasticAttemptBudget,
    canonicalProjectElasticAttemptBudget,
  );
  assert.strictEqual(
    routeProjectElasticKeywordRecoveryStatus,
    canonicalProjectElasticKeywordRecoveryStatus,
  );
});

test('lease canonical dependency graph is route and Express independent', () => {
  const graph = collectRelativeImportGraph([leasePath, projectionPath]);
  const routeDirectory = `${path.join(repositoryRoot, 'server', 'routes')}${path.sep}`;
  for (const expectedPath of [
    leasePath,
    projectionPath,
    path.join(repositoryRoot, 'server', 'db', 'init.js'),
    path.join(
      repositoryRoot,
      'server',
      'modules',
      'capture',
      'application',
      'lease-reconciliation.js',
    ),
    path.join(repositoryRoot, 'server', 'services', 'capture-orchestration.js'),
  ]) {
    assert.ok(graph.paths.includes(expectedPath), `missing graph node: ${expectedPath}`);
  }
  assert.deepEqual(
    graph.paths.filter(candidate => candidate.startsWith(routeDirectory)),
    [],
  );
  assert.equal(
    graph.externalSpecifiers.some(
      specifier => specifier === 'express' || specifier.startsWith('express/'),
    ),
    false,
  );
});

test('Cron consumes the canonical lease while route retains one compatibility export', () => {
  const cronSource = readFileSync(cronPath, 'utf8');
  const routeSource = readFileSync(routePath, 'utf8');

  assert.match(
    cronSource,
    /import\s*\{\s*reconcileElasticCaptureLeases,?\s*\}\s*from '\.\/modules\/capture\/infrastructure\/postgres-lease-reconciliation\.js';/u,
  );
  assert.doesNotMatch(cronSource, /from '\.\/routes\/capture-cloud\.js';/u);

  assert.match(
    routeSource,
    /from '\.\.\/modules\/capture\/infrastructure\/postgres-lease-reconciliation\.js';/u,
  );
  assert.doesNotMatch(routeSource, /function listElasticCaptureLeaseCandidates\b/u);
  assert.doesNotMatch(routeSource, /function settleElasticCaptureLeaseCandidate\b/u);
  assert.doesNotMatch(routeSource, /\breconcileElasticCaptureLeasesImpl\b/u);
  assert.doesNotMatch(routeSource, /createElasticCaptureLeaseReconciler/u);
  for (const movedFunction of [
    'appendEvent',
    'elasticAttemptBudgetAfterOutcome',
    'projectElasticAttemptBudget',
    'projectElasticKeywordRecoveryStatus',
    'projectOrchestrationChildControlOutcome',
  ]) {
    assert.doesNotMatch(
      routeSource,
      new RegExp(`(?:async\\s+)?function\\s+${movedFunction}\\b`, 'u'),
    );
  }
});
