// Read-only online authority for an independently witnessed LOCAL source.
// Neither this client nor the provider's echo proves local task provenance.
(function install(root) {
  'use strict';
  const ACTIONS = Object.freeze(['admit_local_plan', 'start_local_capture',
    'stop_local_capture', 'recover_local_capture']);
  const POLICY = 'local-capture-control-v1';
  const WINDOW_MS = 5000;
  const ORIGIN_KEY = 'onstarvoice.localCaptureOrigin.v1';
  const SOURCE_KEYS = Object.freeze(['originId', 'planFingerprint', 'platform',
    'requestId', 'attemptId', 'generation', 'sourceRevision']);
  const BINDING_KEYS = Object.freeze(['tenantId', 'agentId', 'authCodeId',
    'authBindingId', 'bindingRevision']);
  const RESPONSE_KEYS = Object.freeze(['ok', 'decision', 'reason', 'action', 'policyVersion',
    ...BINDING_KEYS, 'authorityRevision', 'source', 'evaluatedAt', 'expiresAt']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const SHA256 = /^[a-f0-9]{64}$/;
  const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
  const uuid = value => typeof value === 'string' && UUID.test(value);
  const digest = value => typeof value === 'string' && SHA256.test(value);
  const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
  function failure(code) {const error = new Error(code); error.code = code; return error;}

  function exactRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
  }

  // Canonical JSON only: do not invoke getters/toJSON, silently erase fields,
  // coerce identities or hash non-finite numbers as a different value.
  function canonical(value, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw failure('local_control_invalid_json');
    ancestors.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value'))) {
        throw failure('local_control_invalid_json');
      }
      if (Array.isArray(value)) {
        if (keys.length !== value.length + 1 || !keys.includes('length') ||
            keys.some(key => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
          throw failure('local_control_invalid_json');
        }
        return '[' + Array.from({length: value.length}, (_, index) =>
          canonical(descriptors[index].value, ancestors)).join(',') + ']';
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== null && Object.getPrototypeOf(prototype) !== null) throw failure('local_control_invalid_json');
      return '{' + keys.sort().map(key => JSON.stringify(key) + ':' + canonical(descriptors[key].value, ancestors)).join(',') + '}';
    } finally {ancestors.delete(value);}
  }
  const copy = value => JSON.parse(canonical(value));
  function freeze(value) {
    if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}
    return value;
  }
  async function hash(value) {
    const bytes = new root.TextEncoder().encode(canonical(value));
    const result = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function sourceShape(source) {
    return exactRecord(source, SOURCE_KEYS) && uuid(source.originId)
      && digest(source.planFingerprint) && digest(source.sourceRevision)
      && ['xiaohongshu', 'douyin'].includes(source.platform)
      && (source.generation === 0
        ? source.requestId === '' && source.attemptId === ''
        : Number.isSafeInteger(source.generation) && source.generation > 0
          && uuid(source.requestId) && uuid(source.attemptId));
  }
  function validateSource(action, source) {
    try {return ACTIONS.includes(action) && sourceShape(source)
      && (action === 'admit_local_plan' ? source.generation === 0 : source.generation > 0);}
    catch {return false;}
  }
  function sourceMatches(left, right) {
    try {return sourceShape(left) && sourceShape(right) && SOURCE_KEYS.every(key => left[key] === right[key]);}
    catch {return false;}
  }
  function validBinding(binding) {
    return exactRecord(binding, BINDING_KEYS) && BINDING_KEYS.every(key =>
      key === 'bindingRevision' ? digest(binding[key]) : uuid(binding[key]));
  }

  function create({query, now = Date.now, setTimer = root.setTimeout, clearTimer = root.clearTimeout} = {}) {
    if (![query, now, setTimer, clearTimer].every(value => typeof value === 'function')) {
      throw failure('local_control_authority_ports_required');
    }
    async function evaluate({action, source, auth, expectedBinding = null} = {}) {
      if (!validateSource(action, source)) throw failure('local_control_source_invalid');
      const sourceSnapshot = freeze(copy(source));
      const authSnapshot = freeze(copy(auth));
      if (!text(authSnapshot?.authMutationId) || !text(authSnapshot?.captureAgent?.id)
          || !text(authSnapshot?.captureAgent?.token) || !text(authSnapshot?.tenant?.id)) {
        throw failure('local_control_auth_invalid');
      }
      if ((action !== 'admit_local_plan' && expectedBinding === null)
          || (expectedBinding !== null && (!validBinding(expectedBinding)
            || expectedBinding.agentId !== authSnapshot.captureAgent.id
            || expectedBinding.tenantId !== authSnapshot.tenant.id))) {
        throw failure('local_control_binding_unproven');
      }
      const binding = expectedBinding === null ? null : freeze(copy(expectedBinding));
      const startedAt = now();
      if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > 8640000000000000 - WINDOW_MS) {
        throw failure('local_control_clock_invalid');
      }
      const localDeadline = startedAt + WINDOW_MS;
      const controller = new root.AbortController();
      let timer;
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => query({action, source: sourceSnapshot},
            {rawAuth: authSnapshot, signal: controller.signal})),
          new Promise((_, reject) => {timer = setTimer(() => {
            controller.abort(); reject(failure('local_control_authority_expired'));
          }, WINDOW_MS);}),
        ]);
        if (!exactRecord(response, RESPONSE_KEYS)) throw failure('local_control_authority_denied');
        const authority = copy(response), receivedAt = now();
        if (authority.ok !== true || authority.decision !== 'allow' || authority.reason !== 'local_control_authorized'
            || authority.action !== action || authority.policyVersion !== POLICY
            || !validBinding(Object.fromEntries(BINDING_KEYS.map(key => [key, authority[key]])))
            || !digest(authority.authorityRevision) || !sourceMatches(sourceSnapshot, authority.source)
            || authority.agentId !== authSnapshot.captureAgent.id || authority.tenantId !== authSnapshot.tenant.id
            || (binding && BINDING_KEYS.some(key => authority[key] !== binding[key]))
            || !timestamp(authority.evaluatedAt) || !timestamp(authority.expiresAt)
            || !Number.isSafeInteger(receivedAt) || receivedAt < startedAt
            || Date.parse(authority.evaluatedAt) > receivedAt
            || Date.parse(authority.expiresAt) <= Date.parse(authority.evaluatedAt)
            || Date.parse(authority.expiresAt) - Date.parse(authority.evaluatedAt) > WINDOW_MS
            || receivedAt >= Math.min(localDeadline, Date.parse(authority.expiresAt))) {
          throw failure('local_control_authority_denied');
        }
        return freeze({deadline: Math.min(localDeadline, Date.parse(authority.expiresAt)), authority});
      } finally {clearTimer(timer);}
    }
    return Object.freeze({evaluate});
  }
  root.OnStarvoiceLocalCaptureAuthority = Object.freeze({ACTIONS, POLICY, WINDOW_MS, ORIGIN_KEY,
    SOURCE_KEYS, BINDING_KEYS, canonical, hash, validateSource, sourceMatches, create});
})(globalThis);
