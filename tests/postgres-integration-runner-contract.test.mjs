import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(repositoryRoot, 'scripts', 'run-postgres-integration-tests.mjs');
const migrationIntegration = path.join(
  repositoryRoot,
  'tests',
  'integration',
  'postgres',
  'migrations.integration.mjs',
);

test('PostgreSQL integration runner rejects URL parameters that can override the local host', () => {
  const unsafeUrl = 'postgresql://127.0.0.1:5432/onstarvoice_test?host=%2Fdefinitely-not-an-onstarvoice-socket';
  const env = { ...process.env, TEST_DATABASE_URL: unsafeUrl };
  delete env.DATABASE_URL;
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(process.execPath, [runner], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
    timeout: 2000,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /query parameters are not allowed/u);
  assert.doesNotMatch(result.stdout, /target accepted/u);
});

test('migration integration fails closed when executed directly without an explicit test database', () => {
  const runDirectly = env => spawnSync(process.execPath, ['--test', migrationIntegration], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
    timeout: 2000,
  });

  const missingTargetEnv = { ...process.env };
  delete missingTargetEnv.TEST_DATABASE_URL;
  delete missingTargetEnv.DATABASE_URL;
  delete missingTargetEnv.NODE_TEST_CONTEXT;
  const missingTarget = runDirectly(missingTargetEnv);
  const missingTargetOutput = `${missingTarget.stdout}\n${missingTarget.stderr}`;
  assert.equal(missingTarget.status, 1);
  assert.match(missingTargetOutput, /TEST_DATABASE_URL is required/u);
  assert.doesNotMatch(missingTargetOutput, /\[DB\]/u);

  const ambiguousTargetEnv = {
    ...process.env,
    TEST_DATABASE_URL: 'postgresql://127.0.0.1:1/onstarvoice_test_direct_guard',
  };
  delete ambiguousTargetEnv.DATABASE_URL;
  delete ambiguousTargetEnv.NODE_TEST_CONTEXT;
  const ambiguousTarget = runDirectly(ambiguousTargetEnv);
  const ambiguousTargetOutput = `${ambiguousTarget.stdout}\n${ambiguousTarget.stderr}`;
  assert.equal(ambiguousTarget.status, 1);
  assert.match(ambiguousTargetOutput, /DATABASE_URL conflicts with TEST_DATABASE_URL/u);
  assert.doesNotMatch(ambiguousTargetOutput, /\[DB\]/u);
});
