import net from 'node:net';

const ACTIVE_MARKER = '[P2EHLocalGuard] active';
const BLOCKED_MARKER = '[P2EHLocalGuard] BLOCKED_NONLOCAL_NETWORK';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function marker(value) {
  try {
    process.stderr.write(`${value}\n`);
  } catch {
    // The guard remains fail-closed even if the diagnostic stream is gone.
  }
}

function normalizeHost(value) {
  const host = String(value || '').trim().toLowerCase();
  if (host.startsWith('[') && host.includes(']:')) return host.slice(0, host.indexOf(']') + 1);
  if (/^(?:127\.0\.0\.1|localhost):\d+$/u.test(host)) return host.slice(0, host.lastIndexOf(':'));
  return host;
}

function deny(message) {
  marker(BLOCKED_MARKER);
  const error = new Error(message);
  error.code = 'P2EH_NONLOCAL_NETWORK_BLOCKED';
  throw error;
}

function assertLoopback(value, operation) {
  if (LOOPBACK_HOSTS.has(normalizeHost(value))) return;
  deny(`P2-E-H local guard blocked non-loopback ${operation}.`);
}

function connectHost(args) {
  let normalized = args;
  while (Array.isArray(normalized[0])) normalized = normalized[0];
  const first = normalized[0];
  if (first && typeof first === 'object') {
    if (first.path) return null;
    return first.hostname || first.host || 'localhost';
  }
  if (typeof first === 'number') {
    return typeof normalized[1] === 'string' ? normalized[1] : 'localhost';
  }
  return null;
}

function listenHost(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    if (first.path) return null;
    return first.host || null;
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/u.test(first))) {
    return typeof args[1] === 'string' ? args[1] : null;
  }
  return null;
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function p2ehGuardedConnect(...args) {
  const host = connectHost(args);
  if (host === null) deny('P2-E-H local guard blocked a non-TCP connection.');
  assertLoopback(host, 'connection');
  return originalConnect.apply(this, args);
};

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function p2ehGuardedListen(...args) {
  const host = listenHost(args);
  if (host === null) deny('P2-E-H local guard blocked a non-TCP listener.');
  assertLoopback(host, 'listener');
  return originalListen.apply(this, args);
};

const originalFetch = globalThis.fetch?.bind(globalThis);
if (originalFetch) {
  globalThis.fetch = (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input : input?.url;
    const url = new URL(rawUrl);
    assertLoopback(url.hostname, 'fetch');
    return originalFetch(input, init);
  };
}

marker(ACTIVE_MARKER);
