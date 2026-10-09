import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ProcessTopologyError,
  assertProcessTopologyDeployable,
  parseProcessTopologyJson,
  validateProcessTopology,
} from '../scripts/check-process-topology.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(repositoryRoot, 'scripts', 'check-process-topology.mjs');
const productionManifest = path.join(
  repositoryRoot,
  'deploy',
  'process-topology.production.json',
);
const splitCandidateManifest = path.join(
  repositoryRoot,
  'deploy',
  'process-topology.split.candidate.json',
);
const compatibilityManifest = path.join(
  repositoryRoot,
  'deploy',
  'process-topology.compatibility.json',
);
const serverPackage = path.join(repositoryRoot, 'server', 'package.json');

function processConfig(name, role, instances = 1) {
  return { name, role, instances };
}

function manifest(topology, processes) {
  return { schemaVersion: 1, topology, processes };
}

function assertTopologyError(callback, code) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ProcessTopologyError);
    assert.equal(error.code, code);
    return true;
  });
}

test('production manifest is the deployable split topology with one instance per role', async () => {
  const topology = assertProcessTopologyDeployable(parseProcessTopologyJson(
    await readFile(productionManifest, 'utf8'),
  ));

  assert.equal(topology.schemaVersion, 1);
  assert.equal(topology.topology, 'split');
  assert.equal(topology.deployable, true);
  assert.equal(topology.totalInstances, 3);
  assert.deepEqual(topology.roleCounts, { 'ai-media': 1, api: 1, scheduler: 1 });
  assert.deepEqual(
    topology.processes.map(processConfig => processConfig.name),
    ['onstarvoice-api', 'onstarvoice-scheduler', 'onstarvoice-ai-media'],
  );
});

test('compatibility rollback manifest is one deployable all instance named like the legacy process', async () => {
  const topology = assertProcessTopologyDeployable(parseProcessTopologyJson(
    await readFile(compatibilityManifest, 'utf8'),
  ));

  assert.equal(topology.topology, 'compatibility');
  assert.equal(topology.deployable, true);
  assert.deepEqual(topology.roleCounts, { all: 1 });
  assert.equal(topology.processes[0].name, 'onstarvoice');
});

test('topology validation rejects mixed mode, multiple all, and duplicate execution authority', () => {
  assertTopologyError(
    () => validateProcessTopology({ schemaVersion: 2, topology: 'compatibility', processes: [] }),
    'TOPOLOGY_SCHEMA_UNSUPPORTED',
  );
  assertTopologyError(
    () => validateProcessTopology(manifest('automatic', [processConfig('api', 'api')])),
    'TOPOLOGY_MODE_UNKNOWN',
  );
  assertTopologyError(
    () => validateProcessTopology(manifest('split', [
      processConfig('compatibility', 'all'),
      processConfig('api', 'api'),
    ])),
    'TOPOLOGY_MIXED_MODES',
  );
  assertTopologyError(
    () => validateProcessTopology(manifest('compatibility', [
      processConfig('compatibility', 'all', 2),
    ])),
    'TOPOLOGY_MULTIPLE_ALL',
  );
  assertTopologyError(
    () => validateProcessTopology(manifest('split', [
      processConfig('api', 'api'),
      processConfig('scheduler-a', 'scheduler'),
      processConfig('scheduler-b', 'scheduler'),
    ])),
    'TOPOLOGY_DUPLICATE_EXECUTION_AUTHORITY',
  );
  assertTopologyError(
    () => validateProcessTopology(manifest('split', [
      processConfig('api', 'api'),
      processConfig('worker', 'unknown'),
    ])),
    'TOPOLOGY_ROLE_UNKNOWN',
  );
});

test('split topology with one instance per role is deployable', () => {
  const splitManifest = manifest('split', [
    processConfig('api', 'api'),
    processConfig('scheduler', 'scheduler'),
    processConfig('ai-media', 'ai-media'),
  ]);
  const topology = assertProcessTopologyDeployable(splitManifest);

  assert.equal(topology.topology, 'split');
  assert.equal(topology.deployable, true);
  assert.deepEqual(topology.roleCounts, { 'ai-media': 1, api: 1, scheduler: 1 });
});

test('versioned split candidate matches the production manifest role for role', async () => {
  const candidateManifest = parseProcessTopologyJson(
    await readFile(splitCandidateManifest, 'utf8'),
  );
  const topology = assertProcessTopologyDeployable(candidateManifest);
  const production = validateProcessTopology(parseProcessTopologyJson(
    await readFile(productionManifest, 'utf8'),
  ));

  assert.equal(topology.schemaVersion, 1);
  assert.equal(topology.topology, 'split');
  assert.equal(topology.deployable, true);
  assert.equal(topology.totalInstances, 3);
  assert.deepEqual(topology.roleCounts, production.roleCounts);
});

test('server package exposes dedicated P2-C entrypoint scripts without changing compatibility scripts', async () => {
  const packageConfig = JSON.parse(await readFile(serverPackage, 'utf8'));

  assert.equal(packageConfig.scripts.start, 'node index.js');
  assert.equal(packageConfig.scripts.dev, 'node --watch index.js');
  assert.equal(packageConfig.scripts['start:api'], 'node entrypoints/api.js');
  assert.equal(packageConfig.scripts['start:scheduler'], 'node entrypoints/scheduler.js');
  assert.equal(packageConfig.scripts['start:ai-media'], 'node entrypoints/ai-media.js');
});

test('split candidate rejects missing, duplicate, or out-of-scope runtime roles', () => {
  assertTopologyError(
    () => validateProcessTopology(manifest('split', [
      processConfig('api', 'api'),
      processConfig('scheduler', 'scheduler'),
    ])),
    'TOPOLOGY_SPLIT_ROLE_COUNT_INVALID',
  );
  assertTopologyError(
    () => validateProcessTopology(manifest('split', [
      processConfig('api', 'api', 2),
      processConfig('scheduler', 'scheduler'),
      processConfig('ai-media', 'ai-media'),
    ])),
    'TOPOLOGY_SPLIT_ROLE_COUNT_INVALID',
  );
  assertTopologyError(
    () => validateProcessTopology(manifest('split', [
      processConfig('api', 'api'),
      processConfig('scheduler', 'scheduler'),
      processConfig('ai-media', 'ai-media'),
      processConfig('maintenance', 'maintenance'),
    ])),
    'TOPOLOGY_SPLIT_ROLE_SET_INVALID',
  );
});

test('JSON parsing fails without echoing manifest contents', () => {
  const secret = 'postgresql://user:do-not-print@127.0.0.1/onstarvoice';
  assertTopologyError(
    () => parseProcessTopologyJson(`{"databaseUrl":"${secret}"`),
    'TOPOLOGY_INVALID_JSON',
  );
  try {
    parseProcessTopologyJson(`{"databaseUrl":"${secret}"`);
  } catch (error) {
    assert.doesNotMatch(error.message, /do-not-print/u);
  }
});

test('CLI uses the shared validator, accepts both topologies, and never leaks secrets', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'onstarvoice-topology-'));
  const compatibilityPath = path.join(tempDirectory, 'compatibility.json');
  const splitPath = path.join(tempDirectory, 'split.json');
  const malformedPath = path.join(tempDirectory, 'malformed.json');
  const secret = 'super-secret-database-password';

  try {
    await writeFile(
      compatibilityPath,
      JSON.stringify(manifest('compatibility', [processConfig('onstarvoice', 'all')])),
    );
    await writeFile(
      splitPath,
      JSON.stringify(manifest('split', [
        processConfig('api', 'api'),
        processConfig('scheduler', 'scheduler'),
        processConfig('ai-media', 'ai-media'),
      ])),
    );
    await writeFile(malformedPath, `{"databaseUrl":"postgresql://user:${secret}@host/db"`);

    const compatible = spawnSync(process.execPath, [checker, compatibilityPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: `postgresql://user:${secret}@host/db` },
    });
    assert.equal(compatible.status, 0, compatible.stderr);
    assert.match(compatible.stdout, /topology=compatibility roles=all:1/u);
    assert.doesNotMatch(`${compatible.stdout}\n${compatible.stderr}`, new RegExp(secret, 'u'));

    const splitCandidate = spawnSync(process.execPath, [checker, '--candidate', splitPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(splitCandidate.status, 0, splitCandidate.stderr);
    assert.match(splitCandidate.stdout, /candidate validation passed/u);
    assert.match(splitCandidate.stdout, /topology=split roles=ai-media:1,api:1,scheduler:1/u);

    const split = spawnSync(process.execPath, [checker, splitPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(split.status, 0, split.stderr);
    assert.match(split.stdout, /Process topology preflight passed: .*topology=split roles=ai-media:1,api:1,scheduler:1/u);

    const malformed = spawnSync(process.execPath, [checker, malformedPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /TOPOLOGY_INVALID_JSON/u);
    assert.doesNotMatch(`${malformed.stdout}\n${malformed.stderr}`, new RegExp(secret, 'u'));
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
