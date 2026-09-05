import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePostgresIntegrationTarget } from './lib/postgres-integration-target.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationRoot = path.join(repositoryRoot, 'tests', 'integration', 'postgres');
let target;
try {
  target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
  });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const { databaseName, databaseUrl, rawUrl } = target;

const entries = await readdir(integrationRoot, { withFileTypes: true });
const topologyRehearsalTestFile = 'process-topology-rehearsal.integration.mjs';
const tests = entries
  .filter(entry => entry.isFile() && entry.name.endsWith('.integration.mjs'))
  .map(entry => path.join(integrationRoot, entry.name))
  .sort();
const requiredTestFiles = [
  'capture-automatic-recovery.integration.mjs',
  'capture-command-reconciliation.integration.mjs',
  'capture-elastic-lease-reconciliation.integration.mjs',
  'capture-elastic-retry-rounds.integration.mjs',
  'capture-retry-lock-order.integration.mjs',
  'http-auth.integration.mjs',
  'maintenance-entrypoint.integration.mjs',
  'migration-governance.integration.mjs',
  'migrations.integration.mjs',
  'p2eh-local-canary.integration.mjs',
  'process-role-entrypoint.integration.mjs',
  'process-role-lock.integration.mjs',
  'process-runtime-split.integration.mjs',
  topologyRehearsalTestFile,
];
const discoveredNames = new Set(tests.map(testPath => path.basename(testPath)));
const missingRequiredTests = requiredTestFiles.filter(name => !discoveredNames.has(name));

if (tests.length === 0) {
  console.error(`No PostgreSQL integration tests found in ${integrationRoot}.`);
  process.exit(2);
}
if (missingRequiredTests.length > 0) {
  console.error(
    `Required PostgreSQL integration tests are missing: ${missingRequiredTests.join(', ')}`,
  );
  process.exit(2);
}

console.log(`PostgreSQL integration target accepted: ${databaseUrl.hostname}/${databaseName}`);

const topologyRehearsalPath = tests.find(
  testPath => path.basename(testPath) === topologyRehearsalTestFile,
);
const testPhases = [
  [topologyRehearsalPath],
  tests.filter(testPath => testPath !== topologyRehearsalPath),
];

for (const phaseTests of testPhases) {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...phaseTests],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: rawUrl,
        ALLOW_RESET_MIGRATIONS: '0',
      },
      stdio: 'inherit',
    },
  );

  if (result.error) {
    console.error(`Could not start PostgreSQL integration tests: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0) process.exit(result.status ?? 2);
}

process.exit(0);
