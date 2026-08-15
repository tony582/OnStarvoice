import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PROCESS_ROLES,
  ProcessRoleConfigError,
  assertCompatibilityEntrypointRole,
  parseProcessRole,
  resolveProcessRole,
} from '../server/config/process-role.js';

function assertRoleError(callback, code) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ProcessRoleConfigError);
    assert.equal(error.code, code);
    return true;
  });
}

test('process roles are a closed, explicit set and production template selects all', async () => {
  assert.deepEqual(PROCESS_ROLES, [
    'all',
    'api',
    'scheduler',
    'ai-media',
    'maintenance',
  ]);
  for (const role of PROCESS_ROLES) {
    assert.equal(parseProcessRole(role, { nodeEnv: 'production' }).role, role);
  }

  const productionEnvironmentTemplate = await readFile(
    new URL('../deploy/onstarvoice.env.production.example', import.meta.url),
    'utf8',
  );
  assert.match(productionEnvironmentTemplate, /^PROCESS_ROLE=all$/mu);
});

test('production rejects a missing, empty, combined, or unknown role', () => {
  assertRoleError(
    () => parseProcessRole(undefined, { nodeEnv: 'production' }),
    'PROCESS_ROLE_REQUIRED',
  );
  assertRoleError(
    () => parseProcessRole('   ', { nodeEnv: 'production' }),
    'PROCESS_ROLE_EMPTY',
  );
  assertRoleError(
    () => parseProcessRole('all,api', { nodeEnv: 'production' }),
    'PROCESS_ROLE_COMBINATION_NOT_ALLOWED',
  );
  assertRoleError(
    () => parseProcessRole('scheduler，ai-media', { nodeEnv: 'production' }),
    'PROCESS_ROLE_COMBINATION_NOT_ALLOWED',
  );
  assertRoleError(
    () => parseProcessRole('worker', { nodeEnv: 'production' }),
    'PROCESS_ROLE_UNKNOWN',
  );
});

test('non-production defaults only a missing role to all and records a warning', () => {
  const warnings = [];
  const config = parseProcessRole(undefined, {
    nodeEnv: 'test',
    onWarning: warning => warnings.push(warning),
  });

  assert.equal(config.role, 'all');
  assert.equal(config.source, 'non-production-default');
  assert.deepEqual(warnings, config.warnings);
  assert.equal(warnings[0].code, 'PROCESS_ROLE_DEFAULTED');
  assertRoleError(
    () => parseProcessRole('', { nodeEnv: 'development' }),
    'PROCESS_ROLE_EMPTY',
  );
});

test('current compatibility entrypoint accepts only all until P2-C', () => {
  assert.equal(assertCompatibilityEntrypointRole('all'), 'all');

  for (const role of PROCESS_ROLES.filter(candidate => candidate !== 'all')) {
    assertRoleError(
      () => assertCompatibilityEntrypointRole(role),
      'PROCESS_ROLE_ENTRYPOINT_NOT_IMPLEMENTED',
    );
    assertRoleError(
      () => resolveProcessRole({
        env: { NODE_ENV: 'production', PROCESS_ROLE: role },
      }),
      'PROCESS_ROLE_ENTRYPOINT_NOT_IMPLEMENTED',
    );
  }

  assert.equal(resolveProcessRole({
    env: { NODE_ENV: 'production', PROCESS_ROLE: 'all' },
  }).role, 'all');
});
