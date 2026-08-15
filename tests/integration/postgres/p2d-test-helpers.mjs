import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const guardActiveMarker = /\[P2BTestGuard\] active/u;
export const guardBlockedMarker = /\[P2BTestGuard\] BLOCKED_NONLOCAL_OUTBOUND/u;

export function createGuardedChildEnvironment({
  databaseUrl,
  schema,
  applicationName,
  role = 'maintenance',
  nodeEnv = 'production',
  includeTestDatabaseUrl = true,
  extra = {},
} = {}) {
  assert.match(schema, /^p2d_[a-z0-9_]+$/u);
  assert.match(applicationName, /^p2d-[a-z0-9-]+$/u);

  const environment = {
    PATH: process.env.PATH || '',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || 'C',
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || process.env.USER || '',
    TZ: 'Asia/Shanghai',
    NODE_ENV: nodeEnv,
    PROCESS_ROLE: role,
    DATABASE_URL: databaseUrl,
    PG_CONNECT_TIMEOUT_MS: '1000',
    PG_IDLE_TIMEOUT_MS: '1000',
    PG_POOL_MAX: '2',
    PGAPPNAME: applicationName,
    PGOPTIONS: `-c search_path=${schema}`,
    ALLOW_RESET_MIGRATIONS: '0',
    BOOTSTRAP_ADMIN_EMAIL: '',
    BOOTSTRAP_ADMIN_PASSWORD: '',
    BOOTSTRAP_ADMIN_NAME: '',
    LLM_PROVIDER: 'deepseek',
    LLM_API_KEY: '',
    LLM_MODEL: '',
    LLM_API_ENDPOINT: 'http://127.0.0.1:1/v1',
    DASHSCOPE_API_KEY: '',
    DASHSCOPE_ASR_ENDPOINT: 'http://127.0.0.1:1/asr',
    DASHSCOPE_TASK_ENDPOINT: 'http://127.0.0.1:1/tasks',
    QWEN_OCR_API_KEY: '',
    QWEN_OCR_API_ENDPOINT: 'http://127.0.0.1:1/v1',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: '',
    EMAIL_TO: '',
    ONSTARVOICE_TEST_EXIT_DELAY_MS: '0',
    ...extra,
  };
  if (includeTestDatabaseUrl) environment.TEST_DATABASE_URL = databaseUrl;
  return environment;
}

export function spawnGuardedNode({
  nodePath = process.execPath,
  guardPath,
  scriptPath,
  args = [],
  cwd,
  env,
  label,
}) {
  const child = spawn(nodePath, [
    '--import',
    pathToFileURL(guardPath).href,
    scriptPath,
    ...args,
  ], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  return Object.freeze({
    child,
    label,
    stdout: () => stdout,
    stderr: () => stderr,
    output: () => `${stdout}\n${stderr}`,
  });
}

export function waitForChildExit(runtime, timeoutMs = 20_000) {
  const { child } = runtime;
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${runtime.label} (pid=${child.pid}) to exit`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

export async function stopChild(runtime) {
  if (!runtime || runtime.child.exitCode != null || runtime.child.signalCode != null) return;
  runtime.child.kill('SIGTERM');
  try {
    await waitForChildExit(runtime, 5000);
  } catch {
    runtime.child.kill('SIGKILL');
    await waitForChildExit(runtime, 3000);
  }
}

export async function waitForOutput(runtime, pattern, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = runtime.output();
    if (pattern.test(output)) return output;
    if (runtime.child.exitCode != null || runtime.child.signalCode != null) {
      throw new Error(`${runtime.label} exited before ${pattern} matched:\n${output}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern} from ${runtime.label}:\n${runtime.output()}`);
}

export async function waitForQuery(query, predicate, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await query();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Database condition was not met; last value=${JSON.stringify(value)}`);
}

export function assertGuarded(runtime) {
  const output = runtime.output();
  assert.match(output, guardActiveMarker, `${runtime.label} did not load the outbound guard`);
  assert.doesNotMatch(
    output,
    guardBlockedMarker,
    `${runtime.label} attempted a non-loopback or non-TCP connection`,
  );
}

export async function terminateApplications(pool, applicationNames) {
  const names = [...new Set(applicationNames.filter(Boolean))];
  if (names.length === 0) return [];
  const active = await pool.query(`
    SELECT pid
    FROM pg_stat_activity
    WHERE application_name = ANY($1::text[])
      AND pid <> pg_backend_pid()
  `, [names]);
  for (const row of active.rows) {
    await pool.query('SELECT pg_terminate_backend($1)', [row.pid]);
  }
  await waitForQuery(
    async () => Number((await pool.query(`
      SELECT count(*) AS count
      FROM pg_stat_activity
      WHERE application_name = ANY($1::text[])
    `, [names])).rows[0].count),
    count => count === 0,
  );
  return active.rows.map(row => row.pid);
}

export async function assertNoAdvisoryLocks(pool, backendPids) {
  if (backendPids.length === 0) return;
  const result = await pool.query(`
    SELECT count(*)::integer AS count
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND pid = ANY($1::integer[])
  `, [backendPids]);
  assert.equal(result.rows[0].count, 0, 'P2-D test left an advisory lock behind');
}

export function safeIdentifier(identifier) {
  assert.match(identifier, /^p2d_[a-z0-9_]+$/u);
  return `"${identifier}"`;
}
