import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const TEST_DATABASE_RE = /^onstarvoice_test_p2eh_[a-z0-9_]+$/u;
const RUN_ID_RE = /^[a-z0-9][a-z0-9_]{7,31}$/u;

export class P2ehLocalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'P2ehLocalError';
    this.code = code;
    this.details = details;
  }
}

export function assertRunId(runId) {
  const value = String(runId || '');
  if (!RUN_ID_RE.test(value)) {
    throw new P2ehLocalError(
      'P2EH_RUN_ID_INVALID',
      'P2-E-H local run id must contain only lower-case letters, numbers, and underscore.',
    );
  }
  return value;
}

export function assertP2ehRoleLocks(rows, expectedRole) {
  if (!Array.isArray(rows)) {
    throw new P2ehLocalError('P2EH_LOCK_ROWS_INVALID', 'Role lock rows must be an array.');
  }
  const rolePattern = /^onstarvoice:(?:all|scheduler|ai-media):\d+$/u;
  const maintenanceRows = rows.filter(row => String(row?.application_name || '').startsWith(
    'onstarvoice:maintenance-task:',
  ));
  if (maintenanceRows.length > 0) {
    throw new P2ehLocalError(
      'P2EH_MAINTENANCE_LOCK_REMAINS',
      'Maintenance task locks remain after startup.',
      { maintenanceRows },
    );
  }
  const unexpectedRows = rows.filter(row => !rolePattern.test(String(row?.application_name || '')));
  if (unexpectedRows.length > 0) {
    throw new P2ehLocalError(
      'P2EH_UNEXPECTED_ADVISORY_LOCK',
      'An unexpected advisory lock is present in the rehearsal database.',
      { unexpectedRows },
    );
  }

  if (expectedRole === 'all') {
    if (rows.length !== 1
        || !rows[0].application_name.startsWith('onstarvoice:all:')
        || rows[0].lock_count !== 2) {
      throw new P2ehLocalError(
        'P2EH_ALL_LOCKS_INVALID',
        'Compatibility process does not hold exactly two role locks.',
        { rows },
      );
    }
    return;
  }
  if (expectedRole === 'split') {
    const scheduler = rows.filter(row => row.application_name.startsWith('onstarvoice:scheduler:'));
    const ai = rows.filter(row => row.application_name.startsWith('onstarvoice:ai-media:'));
    if (rows.length !== 2 || scheduler[0]?.lock_count !== 1 || ai[0]?.lock_count !== 1) {
      throw new P2ehLocalError(
        'P2EH_SPLIT_LOCKS_INVALID',
        'Split workers do not hold exactly one lock each.',
        { rows },
      );
    }
    return;
  }
  if (expectedRole === 'none') {
    if (rows.length !== 0) {
      throw new P2ehLocalError(
        'P2EH_LOCKS_NOT_RELEASED',
        'Role/advisory locks were not fully released.',
        { rows },
      );
    }
    return;
  }
  throw new P2ehLocalError(
    'P2EH_LOCK_EXPECTATION_INVALID',
    `Unsupported role-lock expectation: ${String(expectedRole)}`,
  );
}

export function parseLocalDatabaseUrl(rawUrl, { restore = false, runId } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    throw new P2ehLocalError('P2EH_DATABASE_URL_INVALID', 'Database URL is invalid.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new P2ehLocalError('P2EH_DATABASE_PROTOCOL_INVALID', 'Database URL must use PostgreSQL.');
  }
  if (url.hostname !== '127.0.0.1') {
    throw new P2ehLocalError(
      'P2EH_DATABASE_NOT_LOOPBACK',
      'P2-E-H local rehearsal accepts only a loopback PostgreSQL target.',
    );
  }
  if (url.search || url.hash) {
    throw new P2ehLocalError(
      'P2EH_DATABASE_URL_OPTIONS_FORBIDDEN',
      'Database URL query parameters and fragments are forbidden.',
    );
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (!TEST_DATABASE_RE.test(databaseName)) {
    throw new P2ehLocalError(
      'P2EH_DATABASE_NAME_INVALID',
      'Database name must start with onstarvoice_test_p2eh_ and use a safe exact name.',
    );
  }
  const normalizedRunId = assertRunId(runId);
  const expectedName = restore
    ? `onstarvoice_test_p2eh_${normalizedRunId}_restore`
    : `onstarvoice_test_p2eh_${normalizedRunId}`;
  if (databaseName !== expectedName) {
    throw new P2ehLocalError(
      'P2EH_DATABASE_NAME_MISMATCH',
      `Database name must be exactly ${expectedName}.`,
    );
  }
  return Object.freeze({ rawUrl: String(rawUrl), url, databaseName });
}

export function redactedDatabaseTarget(rawUrl) {
  const url = new URL(rawUrl);
  const port = url.port || '5432';
  return `${url.hostname}:${port}/${decodeURIComponent(url.pathname.slice(1))}`;
}

export function sandboxProfile() {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound (require-not (remote ip "localhost:*")))',
    '(deny network-inbound (require-not (local ip "localhost:*")))',
  ].join('\n');
}

export function credentialSafeText(value) {
  return String(value || '')
    .replace(/\b(postgres(?:ql)?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu, '$1[redacted]@')
    .replace(/\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/giu, '$1[redacted]')
    .replace(/\b(bearer\s+)[a-z0-9._~+\/-]+/giu, '$1[redacted]')
    .replace(/\b((?:PGPASSWORD|SMTP_PASS|[A-Z0-9_]*API_KEY)\s*[:=]\s*)[^\s,;]+/gu, '$1[redacted]')
    .replace(/("(?:PGPASSWORD|SMTP_PASS|[A-Z0-9_]*API_KEY)"\s*:\s*)"[^"]*"/gu, '$1"[redacted]"')
    .replace(/("Authorization"\s*:\s*)"[^"]*"/giu, '$1"[redacted]"');
}

export async function runCommand(command, args = [], {
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowExitCodes = [0],
  input,
  label = path.basename(command),
  captureLimit = MAX_CAPTURE_BYTES,
  signal,
} = {}) {
  if (!path.isAbsolute(command)) {
    throw new P2ehLocalError(
      'P2EH_COMMAND_NOT_ABSOLUTE',
      `Command path must be absolute: ${command}`,
    );
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new P2ehLocalError(
      'P2EH_COMMAND_ENV_REQUIRED',
      `A complete, sanitized environment is required for ${label}.`,
    );
  }
  const child = spawn(command, args.map(value => String(value)), {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let overflow = false;
  const append = (current, chunk) => {
    if (overflow) return current;
    const next = current + chunk;
    if (Buffer.byteLength(next) > captureLimit) {
      overflow = true;
      return next.slice(0, captureLimit);
    }
    return next;
  };
  child.stdout.on('data', chunk => { stdout = append(stdout, String(chunk)); });
  child.stderr.on('data', chunk => { stderr = append(stderr, String(chunk)); });
  if (input === undefined) child.stdin.end();
  else child.stdin.end(input);

  let timer;
  let forceKillTimer;
  let killDeadlineTimer;
  let stopError;
  let abortListener;
  const result = await new Promise((resolve, reject) => {
    const requestStop = error => {
      if (stopError) return;
      stopError = error;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killDeadlineTimer = setTimeout(() => reject(new P2ehLocalError(
        'P2EH_COMMAND_KILL_TIMEOUT',
        `${label} did not close after SIGTERM and SIGKILL.`,
        { label, pid: child.pid },
      )), 6000);
    };
    timer = setTimeout(() => requestStop(new P2ehLocalError(
      'P2EH_COMMAND_TIMEOUT',
      `${label} did not finish within ${timeoutMs}ms and was stopped.`,
      { label },
    )), timeoutMs);
    if (signal) {
      abortListener = () => requestStop(new P2ehLocalError(
        'P2EH_SIGNAL_RECEIVED',
        `Rehearsal interrupted by ${String(signal.reason || 'signal')}.`,
        { label },
      ));
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    }
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (stopError) {
        stopError.details = {
          ...stopError.details,
          outcome: { code, signal, pid: child.pid },
        };
        reject(stopError);
        return;
      }
      resolve({ code, signal });
    });
  }).finally(() => {
    clearTimeout(timer);
    clearTimeout(forceKillTimer);
    clearTimeout(killDeadlineTimer);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  });

  if (overflow) {
    throw new P2ehLocalError(
      'P2EH_COMMAND_OUTPUT_LIMIT',
      `${label} produced more than the allowed output.`,
    );
  }
  const outcome = Object.freeze({
    ...result,
    stdout: credentialSafeText(stdout),
    stderr: credentialSafeText(stderr),
  });
  if (!allowExitCodes.includes(result.code)) {
    throw new P2ehLocalError(
      'P2EH_COMMAND_FAILED',
      `${label} exited with code ${result.code}${result.signal ? ` (${result.signal})` : ''}.`,
      { label, outcome },
    );
  }
  return outcome;
}

export async function waitFor(check, {
  timeoutMs = 30_000,
  intervalMs = 250,
  label = 'condition',
  signal,
} = {}) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw new P2ehLocalError(
        'P2EH_SIGNAL_RECEIVED',
        `Rehearsal interrupted by ${String(signal.reason || 'signal')}.`,
      );
    }
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    let abortListener;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      if (!signal) return;
      abortListener = () => {
        clearTimeout(timer);
        reject(new P2ehLocalError(
          'P2EH_SIGNAL_RECEIVED',
          `Rehearsal interrupted by ${String(signal.reason || 'signal')}.`,
        ));
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }).finally(() => {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    });
  }
  throw new P2ehLocalError(
    'P2EH_WAIT_TIMEOUT',
    `Timed out waiting for ${label}.`,
    lastError ? { cause: lastError } : {},
  );
}

export function canBindPort(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function assertPortsAvailable(ports) {
  for (const port of ports) {
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      throw new P2ehLocalError('P2EH_PORT_INVALID', `Invalid rehearsal port: ${port}`);
    }
    if (!await canBindPort(port)) {
      throw new P2ehLocalError('P2EH_PORT_IN_USE', `Rehearsal port is already in use: ${port}`);
    }
  }
}

export async function preflightSandbox({ sandboxExec, nodeBin, networkGuardPath, loopbackPort }) {
  if (![sandboxExec, nodeBin, networkGuardPath].every(path.isAbsolute)) {
    throw new P2ehLocalError(
      'P2EH_PREFLIGHT_PATH_NOT_ABSOLUTE',
      'Sandbox, Node, and network guard paths must be absolute.',
    );
  }
  const profile = sandboxProfile();
  const probeEnv = Object.freeze({
    PATH: '/usr/bin:/bin',
    HOME: '/var/empty',
    TMPDIR: '/tmp',
    LANG: 'C',
    TZ: 'UTC',
  });
  const loopbackProbe = [
    'const net=require("node:net");',
    'const s=net.connect({host:"127.0.0.1",port:Number(process.argv[1])});',
    's.setTimeout(1000);',
    's.once("connect",()=>{console.log("P2EH_LOOPBACK_OK");s.end();});',
    's.once("timeout",()=>{console.error("P2EH_LOOPBACK_TIMEOUT");process.exit(31);});',
    's.once("error",e=>{console.error(`P2EH_LOOPBACK_${e.code}`);process.exit(32);});',
  ].join('');
  const loopback = await runCommand(sandboxExec, [
    '-p', profile, nodeBin, '-e', loopbackProbe, String(loopbackPort),
  ], { label: 'sandbox loopback probe', timeoutMs: 3000, env: probeEnv });
  if (!loopback.stdout.includes('P2EH_LOOPBACK_OK')) {
    throw new P2ehLocalError('P2EH_SANDBOX_LOOPBACK_FAILED', 'Sandbox did not allow loopback TCP.');
  }

  const outboundProbe = [
    'const net=require("node:net");',
    'const s=net.connect({host:"203.0.113.1",port:9});',
    's.setTimeout(1000);',
    's.once("connect",()=>{console.error("P2EH_NONLOCAL_CONNECTED");process.exit(41);});',
    's.once("timeout",()=>{console.error("P2EH_NONLOCAL_TIMEOUT");process.exit(42);});',
    's.once("error",e=>{',
    'if(e.code==="EPERM"||e.code==="EACCES"){console.log(`P2EH_NONLOCAL_BLOCKED_${e.code}`);process.exit(0);}',
    'console.error(`P2EH_NONLOCAL_WRONG_${e.code}`);process.exit(43);});',
  ].join('');
  const outbound = await runCommand(sandboxExec, [
    '-p', profile, nodeBin, '-e', outboundProbe,
  ], { label: 'sandbox outbound probe', timeoutMs: 3000, env: probeEnv });
  if (!/P2EH_NONLOCAL_BLOCKED_(?:EPERM|EACCES)/u.test(outbound.stdout)) {
    throw new P2ehLocalError(
      'P2EH_SANDBOX_NONLOCAL_FAILED',
      'Sandbox did not immediately reject non-loopback TCP.',
    );
  }

  const inboundProbe = [
    'const net=require("node:net");const s=net.createServer();',
    'try{s.listen(0,"0.0.0.0",()=>{console.error("P2EH_NONLOCAL_BOUND");s.close(()=>process.exit(51));});}',
    'catch(e){if(e.code==="P2EH_NONLOCAL_NETWORK_BLOCKED"){',
    'console.log("P2EH_NONLOCAL_BIND_BLOCKED_EPERM");process.exit(0);}',
    'console.error(`P2EH_NONLOCAL_BIND_WRONG_${e.code}`);process.exit(52);}',
  ].join('');
  const inbound = await runCommand(nodeBin, [
    '--import', networkGuardPath, '-e', inboundProbe,
  ], { label: 'Node network guard inbound probe', timeoutMs: 3000, env: probeEnv });
  if (!/P2EH_NONLOCAL_BIND_BLOCKED_(?:EPERM|EACCES)/u.test(inbound.stdout)) {
    throw new P2ehLocalError(
      'P2EH_SANDBOX_BIND_FAILED',
      'Node network guard did not reject non-loopback bind.',
    );
  }
  return Object.freeze({ loopback: true, outboundBlocked: true, inboundBlocked: true });
}

export function isolatedEnvironment({
  tempRoot,
  databaseUrl,
  apiPort,
  ingressPort,
  role,
  emptyEnvPath,
  mediaDir,
  runId,
} = {}) {
  const pathValue = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  return Object.freeze({
    PATH: pathValue,
    HOME: path.join(tempRoot, 'home'),
    TMPDIR: path.join(tempRoot, 'tmp'),
    LANG: 'C.UTF-8',
    TZ: 'Asia/Shanghai',
    NODE_ENV: 'production',
    PROCESS_ROLE: role,
    PROCESS_SHUTDOWN_TIMEOUT_MS: '30000',
    DATABASE_URL: databaseUrl,
    ALLOW_RESET_MIGRATIONS: '0',
    MIGRATION_LOCK_WAIT_MS: '15000',
    MIGRATION_LOCK_POLL_MS: '100',
    PGAPPNAME: `onstarvoice:p2eh:${runId}:${role}`,
    PG_POOL_MAX: '3',
    PG_CONNECT_TIMEOUT_MS: '3000',
    PG_IDLE_TIMEOUT_MS: '5000',
    PG_QUERY_TIMEOUT_MS: '5000',
    HOST: '127.0.0.1',
    PORT: String(apiPort),
    PUBLIC_BASE_URL: `http://127.0.0.1:${ingressPort}`,
    CORS_ORIGINS: `http://127.0.0.1:${ingressPort}`,
    MEDIA_DIR: mediaDir,
    DOTENV_CONFIG_PATH: emptyEnvPath,
    BOOTSTRAP_ADMIN_EMAIL: '',
    BOOTSTRAP_ADMIN_PASSWORD: '',
    BOOTSTRAP_ADMIN_NAME: '',
    ADMIN_PASSWORD: '',
    LLM_PROVIDER: 'deepseek',
    LLM_API_KEY: '',
    LLM_MODEL: '',
    DASHSCOPE_API_KEY: '',
    DASHSCOPE_ASR_ENDPOINT: 'http://127.0.0.1:1/asr',
    DASHSCOPE_TASK_ENDPOINT: 'http://127.0.0.1:1/tasks',
    QWEN_OCR_API_KEY: '',
    QWEN_OCR_API_ENDPOINT: 'http://127.0.0.1:1/v1',
    LLM_API_ENDPOINT: 'http://127.0.0.1:1/v1',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1',
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: '',
    EMAIL_TO: '',
    FEISHU_WEBHOOK_URL: '',
    ONSTARVOICE_P2EH_RUN_ID: runId,
  });
}

export function nginxConfig({ prefix, ingressPort, apiPort }) {
  const logs = path.join(prefix, 'logs');
  const temp = path.join(prefix, 'temp');
  return [
    'worker_processes 1;',
    `pid ${JSON.stringify(path.join(logs, 'nginx.pid'))};`,
    `error_log ${JSON.stringify(path.join(logs, 'error.log'))} notice;`,
    'events { worker_connections 128; }',
    'http {',
    '  log_format p2eh "$remote_addr $status $request_method $uri";',
    `  access_log ${JSON.stringify(path.join(logs, 'access.log'))} p2eh;`,
    `  client_body_temp_path ${JSON.stringify(path.join(temp, 'client'))};`,
    `  proxy_temp_path ${JSON.stringify(path.join(temp, 'proxy'))};`,
    '  server {',
    `    listen 127.0.0.1:${ingressPort};`,
    '    server_name p2eh.localhost;',
    '    location / {',
    `      proxy_pass http://127.0.0.1:${apiPort};`,
    '      proxy_http_version 1.1;',
    '      proxy_set_header Host $host;',
    '      proxy_set_header X-Forwarded-For 127.0.0.1;',
    '      proxy_set_header X-Forwarded-Proto http;',
    '      proxy_connect_timeout 2s;',
    '      proxy_read_timeout 35s;',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

export function pm2Ecosystem({
  releaseRoot,
  sandboxExec,
  sandboxProfileText,
  nodeBin,
  guardPath,
  commonEnv,
  tempRoot,
  runId,
  schedulerPort,
  aiMediaPort,
  restoreDatabaseUrl,
  restorePort,
}) {
  for (const [label, value] of Object.entries({
    releaseRoot,
    sandboxExec,
    nodeBin,
    guardPath,
    tempRoot,
  })) {
    if (!path.isAbsolute(String(value || ''))) {
      throw new P2ehLocalError('P2EH_PM2_PATH_INVALID', `${label} must be an absolute path.`);
    }
  }
  if (!commonEnv || typeof commonEnv !== 'object' || !commonEnv.DATABASE_URL) {
    throw new P2ehLocalError(
      'P2EH_PM2_ENV_INVALID',
      'PM2 ecosystem requires an explicit primary DATABASE_URL.',
    );
  }
  if (!restoreDatabaseUrl
      || ![schedulerPort, aiMediaPort, restorePort].every(port => (
        Number.isSafeInteger(port) && port >= 1024 && port <= 65535
      ))) {
    throw new P2ehLocalError(
      'P2EH_PM2_RESTORE_INVALID',
      'PM2 ecosystem requires an explicit restore database and high restore port.',
    );
  }
  assertRunId(runId);
  const rolePorts = Object.freeze({
    all: commonEnv.PORT,
    api: commonEnv.PORT,
    scheduler: String(schedulerPort),
    'ai-media': String(aiMediaPort),
  });
  const roles = [
    ['all', 'server/index.js'],
    ['api', 'server/entrypoints/api.js'],
    ['scheduler', 'server/entrypoints/scheduler.js'],
    ['ai-media', 'server/entrypoints/ai-media.js'],
  ];
  const apps = roles.map(([role, relativeEntrypoint]) => ({
    name: `p2eh-${runId}-${role}`,
    script: sandboxExec,
    args: [
      '-p', sandboxProfileText,
      nodeBin,
      '--import', guardPath,
      path.join(releaseRoot, relativeEntrypoint),
    ],
    cwd: path.join(releaseRoot, 'server'),
    interpreter: 'none',
    exec_mode: 'fork',
    instances: 1,
    watch: false,
    autorestart: false,
    merge_logs: true,
    kill_timeout: 45_000,
    time: true,
    out_file: path.join(tempRoot, 'logs', `${role}.out.log`),
    error_file: path.join(tempRoot, 'logs', `${role}.err.log`),
    env: {
      ...commonEnv,
      PROCESS_ROLE: role,
      PGAPPNAME: `onstarvoice:p2eh:${runId}:${role}`,
      PORT: rolePorts[role],
    },
  }));
  apps.push({
    name: `p2eh-${runId}-sandbox-probe`,
    script: sandboxExec,
    args: [
      '-p', sandboxProfileText,
      nodeBin,
      '-e',
      [
        'const net=require("node:net");',
        'const s=net.connect({host:"203.0.113.1",port:9});',
        's.setTimeout(1000);',
        's.once("connect",()=>process.exit(71));',
        's.once("timeout",()=>process.exit(72));',
        's.once("error",e=>{',
        'if(e.code==="EPERM"||e.code==="EACCES"){',
        'console.log(`P2EH_PM2_SANDBOX_BLOCKED_${e.code}`);process.exit(0);}',
        'process.exit(73);});',
      ].join(''),
    ],
    cwd: releaseRoot,
    interpreter: 'none',
    exec_mode: 'fork',
    instances: 1,
    watch: false,
    autorestart: false,
    merge_logs: true,
    kill_timeout: 5000,
    time: true,
    out_file: path.join(tempRoot, 'logs', 'sandbox-probe.out.log'),
    error_file: path.join(tempRoot, 'logs', 'sandbox-probe.err.log'),
    env: {
      ...commonEnv,
      PROCESS_ROLE: 'api',
      PGAPPNAME: `onstarvoice:p2eh:${runId}:sandbox-probe`,
      PORT: String(schedulerPort),
    },
  });
  apps.push({
    name: `p2eh-${runId}-restore-api`,
    script: sandboxExec,
    args: [
      '-p', sandboxProfileText,
      nodeBin,
      '--import', guardPath,
      path.join(releaseRoot, 'server/entrypoints/api.js'),
    ],
    cwd: path.join(releaseRoot, 'server'),
    interpreter: 'none',
    exec_mode: 'fork',
    instances: 1,
    watch: false,
    autorestart: false,
    merge_logs: true,
    kill_timeout: 45_000,
    time: true,
    out_file: path.join(tempRoot, 'logs', 'restore-api.out.log'),
    error_file: path.join(tempRoot, 'logs', 'restore-api.err.log'),
    env: {
      ...commonEnv,
      PROCESS_ROLE: 'api',
      PGAPPNAME: `onstarvoice:p2eh:${runId}:restore-api`,
      DATABASE_URL: restoreDatabaseUrl,
      PORT: String(restorePort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${restorePort}`,
      CORS_ORIGINS: `http://127.0.0.1:${restorePort}`,
    },
  });
  return `${JSON.stringify({ apps }, null, 2)}\n`;
}

export async function writePrivateFile(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, contents, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

export async function assertPrivatePath(targetPath, { directory = false } = {}) {
  const details = await lstat(targetPath);
  if (details.isSymbolicLink()) {
    throw new P2ehLocalError('P2EH_PATH_SYMLINK_FORBIDDEN', `Symbolic link is forbidden: ${targetPath}`);
  }
  if (directory ? !details.isDirectory() : !details.isFile()) {
    throw new P2ehLocalError('P2EH_PATH_TYPE_INVALID', `Unexpected path type: ${targetPath}`);
  }
  const mode = details.mode & 0o777;
  const allowed = directory ? 0o700 : 0o600;
  if ((mode & 0o077) !== 0 || (mode & allowed) !== allowed) {
    throw new P2ehLocalError('P2EH_PATH_PERMISSIONS_INVALID', `Path is not private: ${targetPath}`);
  }
  return details;
}
