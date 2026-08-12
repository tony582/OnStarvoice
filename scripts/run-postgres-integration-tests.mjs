import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationRoot = path.join(repositoryRoot, 'tests', 'integration', 'postgres');
const rawUrl = String(process.env.TEST_DATABASE_URL || '').trim();

if (!rawUrl) {
  console.error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  process.exit(2);
}

let databaseUrl;
try {
  databaseUrl = new URL(rawUrl);
} catch {
  console.error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  process.exit(2);
}

const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//u, ''));
const allowedHost = databaseUrl.hostname === '127.0.0.1' || databaseUrl.hostname === 'localhost';
const allowedName = /^onstarvoice_(?:ci|test)(?:_|$)/u.test(databaseName);

if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !allowedHost || !allowedName) {
  console.error(
    'Refusing integration tests: use a localhost database named onstarvoice_ci* or onstarvoice_test*.',
  );
  process.exit(2);
}

if (process.env.DATABASE_URL && process.env.DATABASE_URL !== rawUrl) {
  console.error('DATABASE_URL conflicts with TEST_DATABASE_URL; refusing an ambiguous database target.');
  process.exit(2);
}

const entries = await readdir(integrationRoot, { withFileTypes: true });
const tests = entries
  .filter(entry => entry.isFile() && entry.name.endsWith('.integration.mjs'))
  .map(entry => path.join(integrationRoot, entry.name))
  .sort();

if (tests.length === 0) {
  console.error(`No PostgreSQL integration tests found in ${integrationRoot}.`);
  process.exit(2);
}

console.log(`PostgreSQL integration target accepted: ${databaseUrl.hostname}/${databaseName}`);

const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: rawUrl,
    ALLOW_RESET_MIGRATIONS: '0',
  },
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Could not start PostgreSQL integration tests: ${result.error.message}`);
  process.exit(2);
}

process.exit(result.status ?? 2);
