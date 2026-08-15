import { isProcessRole } from '../config/process-role.js';

export const PROCESS_HEALTH_VERSION = '0.1.0';

const READINESS_REASON_RE = /^[a-z][a-z0-9_]{0,63}$/u;

function assertReadinessReason(reason) {
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  if (!READINESS_REASON_RE.test(normalized)) {
    throw new TypeError(
      'readiness reason must be a lowercase machine-readable code',
    );
  }
  return normalized;
}

function normalizeUptime(value) {
  const uptime = Number(value);
  return Number.isFinite(uptime) && uptime >= 0 ? uptime : 0;
}

/**
 * Create a side-effect-free process health provider.
 *
 * Liveness only reports that the current process can answer HTTP. Readiness is
 * opt-in and remains false until the owning runtime has finished its database,
 * role-lock, and role-specific initialization.
 */
export function createProcessHealth({
  role = 'all',
  version = PROCESS_HEALTH_VERSION,
  uptime = () => process.uptime(),
  initialReadinessReason = 'initializing',
  readinessProbe = null,
  readinessFailureReason = 'dependency_unavailable',
} = {}) {
  if (!isProcessRole(role)) {
    throw new TypeError('role must be a supported process role');
  }
  const normalizedVersion = typeof version === 'string' ? version.trim() : '';
  if (!normalizedVersion) {
    throw new TypeError('version must be a non-empty string');
  }
  if (typeof uptime !== 'function') {
    throw new TypeError('uptime must be a function');
  }
  if (readinessProbe !== null && typeof readinessProbe !== 'function') {
    throw new TypeError('readinessProbe must be a function when provided');
  }
  const normalizedReadinessFailureReason = assertReadinessReason(
    readinessFailureReason,
  );

  let lifecycle = Object.freeze({
    phase: 'initializing',
    reason: assertReadinessReason(initialReadinessReason),
  });

  function commonSnapshot() {
    return {
      version: normalizedVersion,
      role,
      uptime: normalizeUptime(uptime()),
    };
  }

  const provider = {
    getLegacyHealth() {
      const snapshot = commonSnapshot();
      return Object.freeze({
        ok: true,
        version: snapshot.version,
        uptime: snapshot.uptime,
      });
    },

    getLiveness() {
      const live = lifecycle.phase !== 'stopped' && lifecycle.phase !== 'failed';
      const snapshot = {
        ok: live,
        status: live ? 'live' : 'not_live',
        ...commonSnapshot(),
      };
      if (!live) snapshot.reason = lifecycle.reason;
      return Object.freeze(snapshot);
    },

    getReadiness() {
      const ready = lifecycle.phase === 'ready';
      if (!ready || !readinessProbe) {
        const snapshot = {
          ok: ready,
          status: ready ? 'ready' : 'not_ready',
          ...commonSnapshot(),
        };
        if (!ready) snapshot.reason = lifecycle.reason;
        return Object.freeze(snapshot);
      }

      return Promise.resolve()
        .then(() => readinessProbe())
        .then(result => {
          if (result === false) {
            return Object.freeze({
              ok: false,
              status: 'not_ready',
              ...commonSnapshot(),
              reason: normalizedReadinessFailureReason,
            });
          }
          return Object.freeze({
            ok: true,
            status: 'ready',
            ...commonSnapshot(),
          });
        })
        .catch(() => Object.freeze({
          ok: false,
          status: 'not_ready',
          ...commonSnapshot(),
          reason: normalizedReadinessFailureReason,
        }));
    },

    markReady() {
      lifecycle = Object.freeze({ phase: 'ready', reason: null });
      return provider.getReadiness();
    },

    markDraining() {
      lifecycle = Object.freeze({ phase: 'draining', reason: 'draining' });
      return provider.getReadiness();
    },

    markStopped() {
      lifecycle = Object.freeze({ phase: 'stopped', reason: 'stopped' });
      return provider.getReadiness();
    },

    markFailed(reason = 'failed') {
      lifecycle = Object.freeze({
        phase: 'failed',
        reason: assertReadinessReason(reason),
      });
      return provider.getReadiness();
    },
  };

  return Object.freeze(provider);
}
