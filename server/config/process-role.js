export const PROCESS_ROLES = Object.freeze([
  'all',
  'api',
  'scheduler',
  'ai-media',
  'maintenance',
]);

const PROCESS_ROLE_SET = new Set(PROCESS_ROLES);

export class ProcessRoleConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProcessRoleConfigError';
    this.code = code;
  }
}

export function isProcessRole(value) {
  return typeof value === 'string' && PROCESS_ROLE_SET.has(value);
}

function isProduction(nodeEnv) {
  return String(nodeEnv || '').trim().toLowerCase() === 'production';
}

/**
 * Parse one process role without starting any runtime services.
 *
 * A missing role remains backward compatible outside production. An explicitly
 * empty value is always treated as a configuration error so a misspelled or
 * half-written deployment cannot silently gain every execution authority.
 */
export function parseProcessRole(
  rawValue,
  { defaultRole = 'all', nodeEnv = process.env.NODE_ENV, onWarning } = {},
) {
  if (!isProcessRole(defaultRole)) {
    throw new ProcessRoleConfigError(
      'PROCESS_ROLE_EXPECTED_UNKNOWN',
      'The expected process role is not supported.',
    );
  }
  if (rawValue === undefined || rawValue === null) {
    if (isProduction(nodeEnv)) {
      throw new ProcessRoleConfigError(
        'PROCESS_ROLE_REQUIRED',
        'PROCESS_ROLE must be explicitly set in production.',
      );
    }

    const warning = {
      code: 'PROCESS_ROLE_DEFAULTED',
      message: defaultRole === 'all'
        ? 'PROCESS_ROLE is not set; non-production compatibility mode defaults to all.'
        : `PROCESS_ROLE is not set; non-production entrypoint defaults to ${defaultRole}.`,
    };
    if (typeof onWarning === 'function') onWarning(warning);
    return Object.freeze({
      role: defaultRole,
      source: 'non-production-default',
      warnings: Object.freeze([warning]),
    });
  }

  const role = String(rawValue).trim();
  if (!role) {
    throw new ProcessRoleConfigError(
      'PROCESS_ROLE_EMPTY',
      'PROCESS_ROLE must not be empty.',
    );
  }
  if (/[,，]/u.test(role)) {
    throw new ProcessRoleConfigError(
      'PROCESS_ROLE_COMBINATION_NOT_ALLOWED',
      'PROCESS_ROLE must contain exactly one role; comma-separated combinations are not allowed.',
    );
  }
  if (!isProcessRole(role)) {
    throw new ProcessRoleConfigError(
      'PROCESS_ROLE_UNKNOWN',
      'PROCESS_ROLE is not one of the supported roles.',
    );
  }

  return Object.freeze({
    role,
    source: 'environment',
    warnings: Object.freeze([]),
  });
}

/**
 * Validate the one role owned by an explicit process entrypoint.
 */
export function assertProcessEntrypointRole(
  role,
  { expectedRole, entrypoint = 'process entrypoint' } = {},
) {
  if (!isProcessRole(expectedRole)) {
    throw new ProcessRoleConfigError(
      'PROCESS_ROLE_EXPECTED_UNKNOWN',
      'The expected process role is not supported.',
    );
  }
  if (!isProcessRole(role)) {
    throw new ProcessRoleConfigError(
      'PROCESS_ROLE_UNKNOWN',
      'PROCESS_ROLE is not one of the supported roles.',
    );
  }
  if (role !== expectedRole) {
    throw new ProcessRoleConfigError(
      'PROCESS_ROLE_ENTRYPOINT_MISMATCH',
      `${entrypoint} requires PROCESS_ROLE=${expectedRole}.`,
    );
  }
  return role;
}

/**
 * Resolve the one role owned by an independent process entrypoint.
 *
 * Production always requires an explicit PROCESS_ROLE. Outside production a
 * missing value defaults to this entrypoint's expected role and emits the same
 * auditable warning used by the compatibility entrypoint.
 */
export function resolveEntrypointProcessRole({
  env = process.env,
  expectedRole,
  entrypoint = 'process entrypoint',
  onWarning,
} = {}) {
  const config = parseProcessRole(env.PROCESS_ROLE, {
    defaultRole: expectedRole,
    nodeEnv: env.NODE_ENV,
    onWarning,
  });
  assertProcessEntrypointRole(config.role, { entrypoint, expectedRole });
  return config;
}

/**
 * server/index.js remains the compatibility entrypoint. Independent P2-C
 * roles must use their dedicated entrypoints instead of this one.
 */
export function assertCompatibilityEntrypointRole(
  role,
  { entrypoint = 'server/index.js' } = {},
) {
  if (!isProcessRole(role)) {
    throw new ProcessRoleConfigError(
      'PROCESS_ROLE_UNKNOWN',
      'PROCESS_ROLE is not one of the supported roles.',
    );
  }
  if (role !== 'all') {
    throw new ProcessRoleConfigError(
      'PROCESS_ROLE_ENTRYPOINT_NOT_IMPLEMENTED',
      `${entrypoint} only supports PROCESS_ROLE=all; use the dedicated entrypoint for role ${role}.`,
    );
  }
  return role;
}

/**
 * Resolve PROCESS_ROLE for the current compatibility entrypoint.
 */
export function resolveProcessRole({
  env = process.env,
  entrypoint = 'server/index.js',
  onWarning,
} = {}) {
  const config = parseProcessRole(env.PROCESS_ROLE, {
    defaultRole: 'all',
    nodeEnv: env.NODE_ENV,
    onWarning,
  });
  assertCompatibilityEntrypointRole(config.role, { entrypoint });
  return config;
}
