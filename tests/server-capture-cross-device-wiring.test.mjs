import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  buildSequentialSearchResumeCheckpoint as canonicalBuildSequentialSearchResumeCheckpoint,
  expectedElasticKeywordSearches as canonicalExpectedElasticKeywordSearches,
  isExplicitUserCancellationSnapshot as canonicalIsExplicitUserCancellationSnapshot,
  orchestrationCheckpointEntries as canonicalOrchestrationCheckpointEntries,
  orchestrationCheckpointInteger as canonicalOrchestrationCheckpointInteger,
} from '../server/modules/capture/application/control-outcome-projection.js';
import {
  classifyCaptureRecoveryDisposition as canonicalClassifyCaptureRecoveryDisposition,
  crossDeviceRetryAgentDailyUsageEligible as canonicalCrossDeviceRetryAgentDailyUsageEligible,
  crossDeviceRetryAgentSupportsTask as canonicalCrossDeviceRetryAgentSupportsTask,
  crossDeviceRetrySafetyAgentIdsForItems as canonicalCrossDeviceRetrySafetyAgentIdsForItems,
  crossDeviceRetrySourceAgentIdsForItems as canonicalCrossDeviceRetrySourceAgentIdsForItems,
  crossDeviceRetryTaskSupported as canonicalCrossDeviceRetryTaskSupported,
  dispatchCrossDeviceRetry as canonicalDispatchCrossDeviceRetry,
  reconcileAutomaticCaptureRetries as canonicalReconcileAutomaticCaptureRetries,
} from '../server/modules/capture/infrastructure/postgres-cross-device-retry.js';
import {
  buildSequentialSearchResumeCheckpoint as routeBuildSequentialSearchResumeCheckpoint,
  classifyCaptureRecoveryDisposition as routeClassifyCaptureRecoveryDisposition,
  crossDeviceRetryAgentDailyUsageEligible as routeCrossDeviceRetryAgentDailyUsageEligible,
  crossDeviceRetryAgentSupportsTask as routeCrossDeviceRetryAgentSupportsTask,
  crossDeviceRetrySafetyAgentIdsForItems as routeCrossDeviceRetrySafetyAgentIdsForItems,
  crossDeviceRetrySourceAgentIdsForItems as routeCrossDeviceRetrySourceAgentIdsForItems,
  crossDeviceRetryTaskSupported as routeCrossDeviceRetryTaskSupported,
  dispatchCrossDeviceRetry as routeDispatchCrossDeviceRetry,
  expectedElasticKeywordSearches as routeExpectedElasticKeywordSearches,
  isExplicitUserCancellationSnapshot as routeIsExplicitUserCancellationSnapshot,
  orchestrationCheckpointEntries as routeOrchestrationCheckpointEntries,
  orchestrationCheckpointInteger as routeOrchestrationCheckpointInteger,
  reconcileAutomaticCaptureRetries as routeReconcileAutomaticCaptureRetries,
} from '../server/routes/capture-cloud.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const routePath = path.join(repositoryRoot, 'server', 'routes', 'capture-cloud.js');
const cronPath = path.join(repositoryRoot, 'server', 'cron.js');
const adapterPath = path.join(
  repositoryRoot,
  'server',
  'modules',
  'capture',
  'infrastructure',
  'postgres-cross-device-retry.js',
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

test('cross-device compatibility exports preserve canonical identity', () => {
  assert.strictEqual(
    routeBuildSequentialSearchResumeCheckpoint,
    canonicalBuildSequentialSearchResumeCheckpoint,
  );
  assert.strictEqual(
    routeExpectedElasticKeywordSearches,
    canonicalExpectedElasticKeywordSearches,
  );
  assert.strictEqual(
    routeIsExplicitUserCancellationSnapshot,
    canonicalIsExplicitUserCancellationSnapshot,
  );
  assert.strictEqual(
    routeReconcileAutomaticCaptureRetries,
    canonicalReconcileAutomaticCaptureRetries,
  );
  assert.strictEqual(
    routeClassifyCaptureRecoveryDisposition,
    canonicalClassifyCaptureRecoveryDisposition,
  );
  assert.strictEqual(
    routeCrossDeviceRetryAgentDailyUsageEligible,
    canonicalCrossDeviceRetryAgentDailyUsageEligible,
  );
  assert.strictEqual(
    routeCrossDeviceRetryAgentSupportsTask,
    canonicalCrossDeviceRetryAgentSupportsTask,
  );
  assert.strictEqual(
    routeCrossDeviceRetrySafetyAgentIdsForItems,
    canonicalCrossDeviceRetrySafetyAgentIdsForItems,
  );
  assert.strictEqual(
    routeCrossDeviceRetrySourceAgentIdsForItems,
    canonicalCrossDeviceRetrySourceAgentIdsForItems,
  );
  assert.strictEqual(
    routeCrossDeviceRetryTaskSupported,
    canonicalCrossDeviceRetryTaskSupported,
  );
  assert.strictEqual(
    routeDispatchCrossDeviceRetry,
    canonicalDispatchCrossDeviceRetry,
  );
  assert.strictEqual(
    routeOrchestrationCheckpointEntries,
    canonicalOrchestrationCheckpointEntries,
  );
  assert.strictEqual(
    routeOrchestrationCheckpointInteger,
    canonicalOrchestrationCheckpointInteger,
  );
});

test('cross-device canonical dependency graph is route and Express independent', () => {
  const graph = collectRelativeImportGraph([adapterPath]);
  const routeDirectory = `${path.join(repositoryRoot, 'server', 'routes')}${path.sep}`;
  for (const expectedPath of [
    adapterPath,
    path.join(repositoryRoot, 'server', 'db', 'init.js'),
    path.join(
      repositoryRoot,
      'server',
      'modules',
      'capture',
      'application',
      'automatic-recovery.js',
    ),
    path.join(
      repositoryRoot,
      'server',
      'modules',
      'capture',
      'application',
      'control-outcome-projection.js',
    ),
    path.join(
      repositoryRoot,
      'server',
      'modules',
      'capture',
      'infrastructure',
      'postgres-command-reconciliation.js',
    ),
    path.join(repositoryRoot, 'server', 'services', 'capture-cloud.js'),
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

test('Cron and the manual endpoint consume the canonical cross-device bindings', () => {
  const cronSource = readFileSync(cronPath, 'utf8');
  const routeSource = readFileSync(routePath, 'utf8');
  const adapterSource = readFileSync(adapterPath, 'utf8');

  assert.match(
    cronSource,
    /import\s*\{\s*reconcileAutomaticCaptureRetries,?\s*\}\s*from '\.\/modules\/capture\/infrastructure\/postgres-cross-device-retry\.js';/u,
  );
  assert.doesNotMatch(cronSource, /from '\.\/routes\/capture-cloud\.js';/u);

  const canonicalImport = routeSource.match(
    /import\s*\{([\s\S]*?)\}\s*from '\.\.\/modules\/capture\/infrastructure\/postgres-cross-device-retry\.js';/u,
  );
  assert.ok(canonicalImport);
  for (const binding of [
    'classifyCaptureRecoveryDisposition',
    'crossDeviceRetryAgentDailyUsageEligible',
    'crossDeviceRetryAgentSupportsTask',
    'crossDeviceRetrySafetyAgentIdsForItems',
    'crossDeviceRetrySourceAgentIdsForItems',
    'crossDeviceRetryTaskSupported',
    'dispatchCrossDeviceRetry',
    'loadCaptureAgentLocalClosureReuseGate',
    'reconcileAutomaticCaptureRetries',
  ]) {
    assert.match(canonicalImport[1], new RegExp(`\\b${binding}\\b`, 'u'));
  }

  const endpointStart = routeSource.indexOf(
    "router.post('/tasks/:id/retry-on-idle-agent'",
  );
  const endpointEnd = routeSource.indexOf(
    "router.post('/tasks/:id/resume'",
    endpointStart,
  );
  assert.ok(endpointStart >= 0 && endpointEnd > endpointStart);
  const endpoint = routeSource.slice(endpointStart, endpointEnd);
  assert.match(
    endpoint,
    /const result = await dispatchCrossDeviceRetry\(\{[\s\S]*requestKey,[\s\S]*expectedRevision,[\s\S]*actorType: 'user',[\s\S]*automatic: false/u,
  );
  assert.equal(endpoint.match(/\bdispatchCrossDeviceRetry\b/gu)?.length, 1);
  assert.doesNotMatch(
    routeSource,
    /(?:async\s+)?function\s+dispatchCrossDeviceRetry\b/u,
  );
  assert.doesNotMatch(
    routeSource,
    /\b(?:const|let|var)\s+dispatchCrossDeviceRetry\s*=/u,
  );

  assert.match(
    adapterSource,
    /createAutomaticCaptureRetryReconciler\(\{[\s\S]*dispatchRetry: dispatchCrossDeviceRetry/u,
  );
  assert.equal(
    adapterSource.match(
      /export async function dispatchCrossDeviceRetry\b/gu,
    )?.length,
    1,
  );
  for (const movedFunction of [
    'synthesizePromotedKeywordItems',
    'promoteSingleNodeTaskForRetry',
    'loadIdleCrossDeviceRetryAgent',
    'loadPromotedRetryPayload',
    'renewProfileRetryExecutions',
    'listAutomaticCaptureRetryCandidates',
  ]) {
    assert.doesNotMatch(
      routeSource,
      new RegExp(`(?:async\\s+)?function\\s+${movedFunction}\\b`, 'u'),
    );
  }
  assert.doesNotMatch(routeSource, /createAutomaticCaptureRetryReconciler/u);
  assert.doesNotMatch(routeSource, /\breconcileAutomaticCaptureRetriesImpl\b/u);
});
