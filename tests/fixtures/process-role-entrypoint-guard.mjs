import net from 'node:net';

const ACTIVE_MARKER = '[P2BTestGuard] active';
const BLOCKED_MARKER = '[P2BTestGuard] BLOCKED_NONLOCAL_OUTBOUND';
const EXIT_DELAY_MARKER = '[P2BTestGuard] exit-delayed';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function writeMarker(marker) {
  try {
    process.stderr.write(`${marker}\n`);
  } catch {
    // The guard still blocks the request if the diagnostic stream is closed.
  }
}

function normalizeHost(value) {
  const host = String(value || 'localhost').trim().toLowerCase();
  if (host.startsWith('[') && host.includes(']:')) {
    return host.slice(0, host.indexOf(']') + 1);
  }
  if (/^127\.0\.0\.1:\d+$/u.test(host) || /^localhost:\d+$/u.test(host)) {
    return host.slice(0, host.lastIndexOf(':'));
  }
  return host;
}

function assertLoopbackHost(value) {
  if (LOOPBACK_HOSTS.has(normalizeHost(value))) return;
  writeMarker(BLOCKED_MARKER);
  const error = new Error('P2-B entrypoint test blocked a non-loopback network request.');
  error.code = 'P2B_TEST_NONLOCAL_OUTBOUND_BLOCKED';
  throw error;
}

function socketHost(args) {
  let normalizedArgs = args;
  while (Array.isArray(normalizedArgs[0])) {
    normalizedArgs = normalizedArgs[0];
  }
  const first = normalizedArgs[0];
  if (first && typeof first === 'object') {
    if (first.path) return null;
    return first.hostname || first.host || 'localhost';
  }
  if (typeof first === 'number') {
    return typeof normalizedArgs[1] === 'string' ? normalizedArgs[1] : 'localhost';
  }
  // Unix-domain sockets and unknown signatures are deliberately blocked: the
  // entrypoint integration contract permits only explicit loopback TCP.
  return null;
}

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...args) {
  const host = socketHost(args);
  if (host === null) {
    writeMarker(BLOCKED_MARKER);
    const error = new Error('P2-B entrypoint test blocked a non-TCP socket request.');
    error.code = 'P2B_TEST_NONLOCAL_OUTBOUND_BLOCKED';
    throw error;
  }
  assertLoopbackHost(host);
  return originalSocketConnect.apply(this, args);
};

const originalFetch = globalThis.fetch?.bind(globalThis);
if (originalFetch) {
  globalThis.fetch = (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL
      ? input
      : input?.url;
    const url = new URL(rawUrl);
    assertLoopbackHost(url.hostname);
    return originalFetch(input, init);
  };
}

const exitDelayMs = Number(process.env.ONSTARVOICE_TEST_EXIT_DELAY_MS || 0);
if (Number.isSafeInteger(exitDelayMs) && exitDelayMs > 0) {
  const originalExit = process.exit.bind(process);
  let exitScheduled = false;
  process.exit = code => {
    if (exitScheduled) return undefined;
    exitScheduled = true;
    writeMarker(EXIT_DELAY_MARKER);
    setTimeout(() => originalExit(code), exitDelayMs);
    return undefined;
  };
}

writeMarker(ACTIVE_MARKER);
