import {queryAll, queryOne, withTransaction} from '../db/init.js';
import {getTenantAiAdmissionSnapshot} from './ai-admission.js';

export const DEFAULT_AI_FAILOVER_FAILURE_THRESHOLD = 3;
export const DEFAULT_AI_FAILOVER_WINDOW_MS = 120000;
export const DEFAULT_AI_FAILOVER_PENDING_THRESHOLD = 1;
export const DEFAULT_AI_FAILOVER_RECOVERY_PROBE_MS = 300000;
export const DEFAULT_AI_FAILOVER_RECOVERY_SUCCESS_THRESHOLD = 2;

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const POLICY_SETTING_KEYS = [
  'llm_failover_enabled',
  'llm_failover_mode',
  'llm_failover_primary_model',
  'llm_failover_backup_model',
  'llm_failover_failure_threshold',
  'llm_failover_window_seconds',
  'llm_failover_pending_threshold',
  'llm_failover_recovery_probe_seconds',
  'llm_failover_recovery_success_threshold',
];

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function enabledValue(value) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(
    String(value || '').trim().toLowerCase(),
  );
}

function boundedText(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength);
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function activeModelForState(state) {
  return state.route === 'backup' ? state.backupModel : state.primaryModel;
}

function stateFromRow(row = {}) {
  return {
    route: row.route === 'backup' ? 'backup' : 'primary',
    primaryModel: boundedText(row.primary_model || row.primaryModel),
    backupModel: boundedText(row.backup_model || row.backupModel),
    consecutiveFailures: Math.max(
      0,
      Number(row.consecutive_failures ?? row.consecutiveFailures) || 0,
    ),
    failureWindowStartedAt:
      row.failure_window_started_at || row.failureWindowStartedAt || null,
    lastSuccessAt: row.last_success_at || row.lastSuccessAt || null,
    lastFailureAt: row.last_failure_at || row.lastFailureAt || null,
    lastFailureCode: boundedText(
      row.last_failure_code || row.lastFailureCode,
      100,
    ),
    lastFailureStatus:
      Number(row.last_failure_status ?? row.lastFailureStatus) || null,
    lastFailureKind: boundedText(
      row.last_failure_kind || row.lastFailureKind,
      100,
    ),
    backupSince: row.backup_since || row.backupSince || null,
    nextPrimaryProbeAt:
      row.next_primary_probe_at || row.nextPrimaryProbeAt || null,
    recoveryProbeSuccesses: Math.max(
      0,
      Number(row.recovery_probe_successes ?? row.recoveryProbeSuccesses) || 0,
    ),
    lastProbeAt: row.last_probe_at || row.lastProbeAt || null,
    lastProbeSucceeded:
      row.last_probe_succeeded ?? row.lastProbeSucceeded ?? null,
  };
}

export function normalizeAiFailoverPolicy(settings = {}, baseConfig = {}) {
  const provider = boundedText(baseConfig.provider, 40).toLowerCase();
  const configuredModel = boundedText(baseConfig.model);
  const primaryModel = boundedText(
    settings.llm_failover_primary_model || configuredModel,
  );
  const backupModel = boundedText(settings.llm_failover_backup_model);
  const requested = enabledValue(settings.llm_failover_enabled);
  const mode = String(settings.llm_failover_mode || '')
    .trim()
    .toLowerCase() === 'active_active'
    ? 'active_active'
    : 'failover';
  const validModels = Boolean(
    primaryModel && backupModel && primaryModel !== backupModel,
  );
  const enabled = requested && provider === 'deepseek' && validModels;
  return {
    requested,
    mode,
    enabled,
    disabledReason: !requested
      ? 'disabled'
      : provider !== 'deepseek'
        ? 'provider_not_deepseek'
        : !validModels
          ? 'invalid_models'
          : '',
    provider,
    configuredModel,
    primaryModel,
    backupModel,
    failureThreshold: boundedInteger(
      settings.llm_failover_failure_threshold,
      DEFAULT_AI_FAILOVER_FAILURE_THRESHOLD,
      2,
      20,
    ),
    failureWindowMs: boundedInteger(
      settings.llm_failover_window_seconds,
      DEFAULT_AI_FAILOVER_WINDOW_MS / 1000,
      30,
      900,
    ) * 1000,
    pendingThreshold: boundedInteger(
      settings.llm_failover_pending_threshold,
      DEFAULT_AI_FAILOVER_PENDING_THRESHOLD,
      1,
      10000,
    ),
    recoveryProbeMs: boundedInteger(
      settings.llm_failover_recovery_probe_seconds,
      DEFAULT_AI_FAILOVER_RECOVERY_PROBE_MS / 1000,
      60,
      3600,
    ) * 1000,
    recoverySuccessThreshold: boundedInteger(
      settings.llm_failover_recovery_success_threshold,
      DEFAULT_AI_FAILOVER_RECOVERY_SUCCESS_THRESHOLD,
      2,
      10,
    ),
  };
}

export function selectActiveActiveModel(config = {}, sequence = 0) {
  const failover = config.failover || {};
  if (!failover.enabled || failover.mode !== 'active_active') {
    return boundedText(config.model);
  }
  const models = [failover.primaryModel, failover.backupModel]
    .map(model => boundedText(model))
    .filter((model, index, values) => model && values.indexOf(model) === index);
  if (models.length < 2) return boundedText(config.model) || models[0] || '';
  const normalizedSequence = Math.max(0, Number(sequence) || 0);
  return models[Math.floor(normalizedSequence) % models.length];
}

export function activeActivePeerModel(config = {}, attemptedModel = '') {
  const failover = config.failover || {};
  if (!failover.enabled || failover.mode !== 'active_active') return '';
  const attempted = boundedText(attemptedModel || config.model);
  const primary = boundedText(failover.primaryModel);
  const backup = boundedText(failover.backupModel);
  if (attempted === primary) return backup;
  if (attempted === backup) return primary;
  return primary || backup;
}

export function initialAiFailoverRoute(policy = {}) {
  return policy.configuredModel === policy.backupModel
    ? 'backup'
    : 'primary';
}

export function classifyAiFailure(error) {
  const status = Number(error?.status) || Number(
    String(error?.message || '').match(/\b(429|500|502|503|504)\b/u)?.[1],
  ) || null;
  const code = boundedText(
    error?.code || error?.name || (status ? `HTTP_${status}` : 'AI_REQUEST_FAILED'),
    100,
  );
  const message = boundedText(error?.message, 500);
  const lower = `${code} ${message}`.toLowerCase();
  const admissionFailure = [
    'AI_ADMISSION_QUEUE_TIMEOUT',
    'AI_ADMISSION_QUEUE_FULL',
  ].includes(code);
  const timeout =
    /timeout|timed out|aborted|aborterror|timeouterror/u.test(lower);
  const networkFailure =
    /fetch failed|econnreset|econnrefused|socket|network/u.test(lower);
  const responseFailure = code === 'LLM_JSON_PARSE_FAILED';
  const retryable =
    admissionFailure ||
    timeout ||
    networkFailure ||
    responseFailure ||
    RETRYABLE_HTTP_STATUSES.has(status);
  return {
    status,
    code,
    message,
    retryable,
    retryCurrent: retryable && !admissionFailure,
    category: admissionFailure
      ? 'admission_queue'
      : timeout
        ? 'timeout'
        : RETRYABLE_HTTP_STATUSES.has(status)
          ? 'upstream_http'
          : responseFailure
            ? 'model_response'
            : networkFailure
              ? 'network'
              : 'non_retryable',
  };
}

function pressurePresent(pressure, threshold) {
  const pendingTotal =
    Number(pressure?.pendingComments || 0) +
    Number(pressure?.pendingRecords || 0);
  return Boolean(
    pressure?.criticalPath ||
    Number(pressure?.queued || 0) > 0 ||
    pendingTotal >= threshold ||
    Number(pressure?.runningPrefilters || 0) > 0,
  );
}

export function transitionAiFailoverFailure({
  state: rawState,
  policy,
  failure,
  pressure = {},
  attemptedModel = '',
  now = new Date(),
}) {
  const state = stateFromRow(rawState);
  const activeModel = activeModelForState(state);
  if (!policy?.enabled || !failure?.retryable) {
    return {
      state,
      switched: false,
      retryModel: '',
      retryRoute: '',
      retryCurrent: false,
      pressureDetected: false,
    };
  }

  // A concurrent request may have already switched the tenant. Let this stale
  // request retry on the active model without incrementing the new route's
  // failure counter.
  if (attemptedModel && attemptedModel !== activeModel) {
    return {
      state,
      switched: false,
      retryModel: activeModel,
      retryRoute: state.route,
      retryCurrent: failure.retryCurrent,
      pressureDetected: pressurePresent(pressure, policy.pendingThreshold),
    };
  }

  const nowMs = now.getTime();
  const windowStart = state.failureWindowStartedAt
    ? new Date(state.failureWindowStartedAt).getTime()
    : Number.NaN;
  const withinWindow =
    Number.isFinite(windowStart) &&
    nowMs - windowStart <= policy.failureWindowMs;
  const consecutiveFailures = withinWindow
    ? state.consecutiveFailures + 1
    : 1;
  const failureWindowStartedAt = withinWindow
    ? state.failureWindowStartedAt
    : now;
  const pressureDetected = pressurePresent(
    pressure,
    policy.pendingThreshold,
  );
  const switched =
    state.route === 'primary' &&
    consecutiveFailures >= policy.failureThreshold &&
    pressureDetected;
  const nextState = {
    ...state,
    route: switched ? 'backup' : state.route,
    consecutiveFailures,
    failureWindowStartedAt,
    lastFailureAt: now,
    lastFailureCode: failure.code,
    lastFailureStatus: failure.status,
    lastFailureKind: boundedText(pressure.kind, 100),
    backupSince: switched ? now : state.backupSince,
    nextPrimaryProbeAt: switched
      ? new Date(nowMs + policy.recoveryProbeMs)
      : state.nextPrimaryProbeAt,
    recoveryProbeSuccesses: switched ? 0 : state.recoveryProbeSuccesses,
  };
  return {
    state: nextState,
    switched,
    retryModel: switched ? state.backupModel : '',
    retryRoute: switched ? 'backup' : '',
    retryCurrent: switched && failure.retryCurrent,
    pressureDetected,
  };
}

export function transitionAiFailoverProbe({
  state: rawState,
  policy,
  succeeded,
  now = new Date(),
}) {
  const state = stateFromRow(rawState);
  if (!policy?.enabled || state.route !== 'backup') {
    return {state, recovered: false};
  }
  const recoveryProbeSuccesses = succeeded
    ? state.recoveryProbeSuccesses + 1
    : 0;
  const recovered =
    succeeded &&
    recoveryProbeSuccesses >= policy.recoverySuccessThreshold;
  return {
    recovered,
    state: {
      ...state,
      route: recovered ? 'primary' : 'backup',
      consecutiveFailures: recovered ? 0 : state.consecutiveFailures,
      failureWindowStartedAt: recovered
        ? null
        : state.failureWindowStartedAt,
      backupSince: recovered ? null : state.backupSince,
      nextPrimaryProbeAt: recovered
        ? null
        : new Date(now.getTime() + policy.recoveryProbeMs),
      recoveryProbeSuccesses: recovered ? 0 : recoveryProbeSuccesses,
      lastProbeAt: now,
      lastProbeSucceeded: Boolean(succeeded),
    },
  };
}

async function loadPolicySettings(tenantId, executor = null) {
  const query = executor?.queryAll || queryAll;
  const rows = await query(
    `SELECT key, value
     FROM tenant_settings
     WHERE tenant_id = $1 AND key = ANY($2::text[])`,
    [tenantId, POLICY_SETTING_KEYS],
  );
  return Object.fromEntries(rows.map(row => [row.key, row.value]));
}

async function initializeOrRefreshState(tx, tenantId, policy) {
  await tx.queryOne(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`ai-failover:${tenantId}`],
  );
  let row = await tx.queryOne(
    'SELECT * FROM ai_failover_states WHERE tenant_id = $1 FOR UPDATE',
    [tenantId],
  );
  const initialRoute = initialAiFailoverRoute(policy);
  if (!row) {
    row = await tx.queryOne(
      `INSERT INTO ai_failover_states (
         tenant_id, route, primary_model, backup_model,
         backup_since, next_primary_probe_at
       ) VALUES (
         $1, $2, $3, $4,
         CASE WHEN $2 = 'backup' THEN now() ELSE NULL END,
         CASE WHEN $2 = 'backup'
           THEN now() + make_interval(secs => $5)
           ELSE NULL END
       )
       RETURNING *`,
      [
        tenantId,
        initialRoute,
        policy.primaryModel,
        policy.backupModel,
        Math.round(policy.recoveryProbeMs / 1000),
      ],
    );
    return row;
  }
  if (
    row.primary_model !== policy.primaryModel ||
    row.backup_model !== policy.backupModel
  ) {
    const previous = stateFromRow(row);
    row = await tx.queryOne(
      `UPDATE ai_failover_states
       SET route = $2,
           primary_model = $3,
           backup_model = $4,
           consecutive_failures = 0,
           failure_window_started_at = NULL,
           backup_since = CASE WHEN $2 = 'backup' THEN now() ELSE NULL END,
           next_primary_probe_at = CASE WHEN $2 = 'backup'
             THEN now() + make_interval(secs => $5)
             ELSE NULL END,
           recovery_probe_successes = 0,
           updated_at = now()
       WHERE tenant_id = $1
       RETURNING *`,
      [
        tenantId,
        initialRoute,
        policy.primaryModel,
        policy.backupModel,
        Math.round(policy.recoveryProbeMs / 1000),
      ],
    );
    await tx.execute(
      `INSERT INTO audit_logs (
         tenant_id, actor_type, actor_id, action,
         target_type, target_id, metadata
       ) VALUES (
         $1, 'system', 'ai-failover', 'ai.failover_policy_rebased',
         'tenant', $1::uuid::text, $2::jsonb
       )`,
      [tenantId, JSON.stringify({
        previousPrimaryModel: previous.primaryModel,
        previousBackupModel: previous.backupModel,
        primaryModel: policy.primaryModel,
        backupModel: policy.backupModel,
        route: initialRoute,
      })],
    );
  }
  return row;
}

export async function resolveAiFailoverConfig(tenantId, baseConfig) {
  if (String(baseConfig?.provider || '').toLowerCase() !== 'deepseek') {
    return {
      ...baseConfig,
      failover: {enabled: false, route: 'configured'},
    };
  }
  const settings = await loadPolicySettings(tenantId);
  const policy = normalizeAiFailoverPolicy(settings, baseConfig);
  if (!policy.enabled) {
    return {
      ...baseConfig,
      failover: {
        enabled: false,
        requested: policy.requested,
        disabledReason: policy.disabledReason,
        route: 'configured',
      },
    };
  }
  const row = await withTransaction(async tx =>
    initializeOrRefreshState(tx, tenantId, policy));
  const state = stateFromRow(row);
  return {
    ...baseConfig,
    model: activeModelForState(state),
    failover: {
      enabled: true,
      mode: policy.mode,
      route: state.route,
      primaryModel: policy.primaryModel,
      backupModel: policy.backupModel,
      policy,
    },
  };
}

async function loadTenantPressure(tx, tenantId, kind) {
  const row = await tx.queryOne(
    `SELECT
       (SELECT count(*)
        FROM record_comments
        WHERE tenant_id = $1
          AND ai_classified_at IS NULL
          AND is_official = false) AS pending_comments,
       (SELECT count(*)
        FROM records
        WHERE tenant_id = $1
          AND record_type NOT IN ('official_content', 'blogger_profile')
          AND business_visibility = 'eligible'
          AND ai_labeled_at IS NULL
          AND created_at >= now() - interval '24 hours') AS pending_records,
       (SELECT count(*)
        FROM relevance_prefilter_requests
        WHERE tenant_id = $1
          AND status = 'running'
          AND updated_at >= now() - interval '5 minutes') AS running_prefilters`,
    [tenantId],
  );
  const admission = getTenantAiAdmissionSnapshot(tenantId);
  return {
    kind,
    pendingComments: Number(row?.pending_comments || 0),
    pendingRecords: Number(row?.pending_records || 0),
    runningPrefilters: Number(row?.running_prefilters || 0),
    active: Number(admission?.active || 0),
    queued: Number(admission?.queued || 0),
    oldestWaitMs: Number(admission?.oldestWaitMs || 0),
    criticalPath: kind === 'relevance_prefilter',
  };
}

async function persistFailureState(tx, tenantId, transition) {
  const state = transition.state;
  return await tx.queryOne(
    `UPDATE ai_failover_states
     SET route = $2,
         consecutive_failures = $3,
         failure_window_started_at = $4,
         last_failure_at = $5,
         last_failure_code = $6,
         last_failure_status = $7,
         last_failure_kind = $8,
         backup_since = $9,
         next_primary_probe_at = $10,
         recovery_probe_successes = $11,
         updated_at = now()
     WHERE tenant_id = $1
     RETURNING *`,
    [
      tenantId,
      state.route,
      state.consecutiveFailures,
      state.failureWindowStartedAt,
      state.lastFailureAt,
      state.lastFailureCode,
      state.lastFailureStatus,
      state.lastFailureKind,
      state.backupSince,
      state.nextPrimaryProbeAt,
      state.recoveryProbeSuccesses,
    ],
  );
}

export async function recordAiModelFailure(
  tenantId,
  {config, error, kind = 'llm'} = {},
) {
  const failure = classifyAiFailure(error);
  const failover = config?.failover || {};
  if (!failover.enabled || !failure.retryable) {
    return {
      switched: false,
      retryModel: '',
      retryRoute: '',
      retryCurrent: false,
      failure,
    };
  }
  if (failover.mode === 'active_active') {
    const retryModel = activeActivePeerModel(config, config?.model);
    await queryOne(
      `UPDATE ai_failover_states
       SET last_failure_at = now(),
           last_failure_code = $2,
           last_failure_status = $3,
           last_failure_kind = $4,
           updated_at = now()
       WHERE tenant_id = $1
       RETURNING tenant_id`,
      [
        tenantId,
        failure.code,
        failure.status,
        boundedText(kind, 100),
      ],
    );
    return {
      switched: false,
      retryModel,
      retryRoute: 'active_active',
      retryCurrent: Boolean(failure.retryCurrent && retryModel),
      pressureDetected: true,
      failure,
    };
  }
  return await withTransaction(async tx => {
    await tx.queryOne(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`ai-failover:${tenantId}`],
    );
    const row = await tx.queryOne(
      'SELECT * FROM ai_failover_states WHERE tenant_id = $1 FOR UPDATE',
      [tenantId],
    );
    if (!row) {
      return {
        switched: false,
        retryModel: '',
        retryRoute: '',
        retryCurrent: false,
        failure,
      };
    }
    const policySettings = await loadPolicySettings(tenantId, tx);
    const policy = normalizeAiFailoverPolicy(policySettings, {
      provider: config.provider,
      model: failover.policy?.configuredModel || config.model,
    });
    if (!policy.enabled) {
      return {
        switched: false,
        retryModel: '',
        retryRoute: '',
        retryCurrent: false,
        failure,
      };
    }
    const pressure = await loadTenantPressure(tx, tenantId, kind);
    const transition = transitionAiFailoverFailure({
      state: row,
      policy,
      failure,
      pressure,
      attemptedModel: config.model,
      now: new Date(),
    });
    if (
      transition.state.consecutiveFailures !== Number(row.consecutive_failures) ||
      transition.switched
    ) {
      await persistFailureState(tx, tenantId, transition);
    }
    if (transition.switched) {
      await tx.execute(
        `INSERT INTO audit_logs (
           tenant_id, actor_type, actor_id, action,
           target_type, target_id, metadata
         ) VALUES (
           $1, 'system', 'ai-failover', 'ai.failover_activated',
           'tenant', $1::uuid::text, $2::jsonb
         )`,
        [tenantId, JSON.stringify({
          primaryModel: policy.primaryModel,
          backupModel: policy.backupModel,
          failureThreshold: policy.failureThreshold,
          failureWindowMs: policy.failureWindowMs,
          failureCode: failure.code,
          failureStatus: failure.status,
          failureCategory: failure.category,
          kind,
          pressure,
        })],
      );
      console.warn('[AIFailover] switched to backup model', {
        tenantId,
        primaryModel: policy.primaryModel,
        backupModel: policy.backupModel,
        failureCode: failure.code,
        kind,
        pressure,
      });
    }
    return {
      switched: transition.switched,
      retryModel: transition.retryModel,
      retryRoute: transition.retryRoute,
      retryCurrent: transition.retryCurrent,
      pressureDetected: transition.pressureDetected,
      pressure,
      failure,
    };
  });
}

export async function recordAiModelSuccess(
  tenantId,
  {config} = {},
) {
  const failover = config?.failover || {};
  if (!failover.enabled) return;
  if (failover.mode === 'active_active') {
    await queryOne(
      `UPDATE ai_failover_states
       SET route = 'primary',
           last_success_at = now(),
           consecutive_failures = 0,
           failure_window_started_at = NULL,
           backup_since = NULL,
           next_primary_probe_at = NULL,
           recovery_probe_successes = 0,
           updated_at = now()
       WHERE tenant_id = $1
       RETURNING tenant_id`,
      [tenantId],
    );
    return;
  }
  await queryOne(
    `UPDATE ai_failover_states
     SET last_success_at = now(),
         consecutive_failures = CASE
           WHEN $2 = CASE route
             WHEN 'backup' THEN backup_model
             ELSE primary_model
           END THEN 0
           ELSE consecutive_failures
         END,
         failure_window_started_at = CASE
           WHEN $2 = CASE route
             WHEN 'backup' THEN backup_model
             ELSE primary_model
           END THEN NULL
           ELSE failure_window_started_at
         END,
         updated_at = now()
     WHERE tenant_id = $1
     RETURNING tenant_id`,
    [tenantId, config.model],
  );
}

async function claimRecoveryProbe(tenantId) {
  return await withTransaction(async tx => {
    const providerAndModel = await tx.queryAll(
      `SELECT key, value
       FROM tenant_settings
       WHERE tenant_id = $1
         AND key = ANY($2::text[])`,
      [tenantId, ['llm_provider', 'llm_model', ...POLICY_SETTING_KEYS]],
    );
    const values = Object.fromEntries(
      providerAndModel.map(item => [item.key, item.value]),
    );
    const policy = normalizeAiFailoverPolicy(values, {
      provider: values.llm_provider || process.env.LLM_PROVIDER || 'gemini',
      model: values.llm_model || process.env.LLM_MODEL || '',
    });
    if (!policy.enabled) return null;
    await initializeOrRefreshState(tx, tenantId, policy);
    const row = await tx.queryOne(
      `UPDATE ai_failover_states
       SET next_primary_probe_at = now() + make_interval(secs => $2),
           updated_at = now()
       WHERE tenant_id = $1
         AND route = 'backup'
         AND next_primary_probe_at <= now()
       RETURNING *`,
      [tenantId, Math.round(policy.recoveryProbeMs / 1000)],
    );
    if (!row) return null;
    return {state: stateFromRow(row), policy};
  });
}

async function persistProbeResult(tenantId, policy, succeeded, probeError = null) {
  return await withTransaction(async tx => {
    await tx.queryOne(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`ai-failover:${tenantId}`],
    );
    const row = await tx.queryOne(
      'SELECT * FROM ai_failover_states WHERE tenant_id = $1 FOR UPDATE',
      [tenantId],
    );
    if (!row || row.route !== 'backup') return {recovered: false};
    const transition = transitionAiFailoverProbe({
      state: row,
      policy,
      succeeded,
      now: new Date(),
    });
    const state = transition.state;
    await tx.execute(
      `UPDATE ai_failover_states
       SET route = $2,
           consecutive_failures = $3,
           failure_window_started_at = $4,
           backup_since = $5,
           next_primary_probe_at = $6,
           recovery_probe_successes = $7,
           last_probe_at = $8,
           last_probe_succeeded = $9,
           metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{lastProbeError}',
             to_jsonb($10::text),
             true
           ),
           updated_at = now()
       WHERE tenant_id = $1`,
      [
        tenantId,
        state.route,
        state.consecutiveFailures,
        state.failureWindowStartedAt,
        state.backupSince,
        state.nextPrimaryProbeAt,
        state.recoveryProbeSuccesses,
        state.lastProbeAt,
        state.lastProbeSucceeded,
        boundedText(probeError?.message, 300),
      ],
    );
    if (transition.recovered) {
      await tx.execute(
        `INSERT INTO audit_logs (
           tenant_id, actor_type, actor_id, action,
           target_type, target_id, metadata
         ) VALUES (
           $1, 'system', 'ai-failover', 'ai.failover_recovered',
           'tenant', $1::uuid::text, $2::jsonb
         )`,
        [tenantId, JSON.stringify({
          primaryModel: policy.primaryModel,
          backupModel: policy.backupModel,
          requiredProbeSuccesses: policy.recoverySuccessThreshold,
        })],
      );
      console.info('[AIFailover] primary model recovered', {
        tenantId,
        primaryModel: policy.primaryModel,
        backupModel: policy.backupModel,
      });
    }
    return {recovered: transition.recovered};
  });
}

export async function runAiFailoverRecoverySweep({probe, limit = 20} = {}) {
  if (typeof probe !== 'function') {
    throw new TypeError('AI failover recovery sweep requires a probe function');
  }
  const due = await queryAll(
    `SELECT tenant_id
     FROM ai_failover_states
     WHERE route = 'backup'
       AND next_primary_probe_at <= now()
     ORDER BY next_primary_probe_at
     LIMIT $1`,
    [boundedInteger(limit, 20, 1, 100)],
  );
  const result = {probed: 0, succeeded: 0, recovered: 0};
  for (const item of due) {
    const claim = await claimRecoveryProbe(item.tenant_id);
    if (!claim) continue;
    result.probed += 1;
    let succeeded = false;
    let probeError = null;
    try {
      succeeded = await probe({
        tenantId: item.tenant_id,
        model: claim.policy.primaryModel,
      }) === true;
    } catch (error) {
      probeError = error;
    }
    if (succeeded) result.succeeded += 1;
    const persisted = await persistProbeResult(
      item.tenant_id,
      claim.policy,
      succeeded,
      probeError,
    );
    if (persisted.recovered) result.recovered += 1;
  }
  return result;
}

export async function getAiFailoverStatus(tenantId) {
  const rows = await queryAll(
    `SELECT key, value
     FROM tenant_settings
     WHERE tenant_id = $1
       AND key = ANY($2::text[])`,
    [tenantId, ['llm_provider', 'llm_model', ...POLICY_SETTING_KEYS]],
  );
  const settings = Object.fromEntries(rows.map(row => [row.key, row.value]));
  const policy = normalizeAiFailoverPolicy(settings, {
    provider: settings.llm_provider || process.env.LLM_PROVIDER || 'gemini',
    model: settings.llm_model || process.env.LLM_MODEL || '',
  });
  const row = await queryOne(
    'SELECT * FROM ai_failover_states WHERE tenant_id = $1',
    [tenantId],
  );
  const state = row ? stateFromRow(row) : null;
  const route = state?.route || initialAiFailoverRoute(policy);
  return {
    requested: policy.requested,
    enabled: policy.enabled,
    disabledReason: policy.disabledReason,
    mode: policy.mode,
    route: policy.enabled
      ? policy.mode === 'active_active' ? 'active_active' : route
      : 'configured',
    effectiveModel: policy.enabled
      ? policy.mode === 'active_active'
        ? `${policy.primaryModel}+${policy.backupModel}`
        : (route === 'backup' ? policy.backupModel : policy.primaryModel)
      : policy.configuredModel,
    primaryModel: policy.primaryModel,
    backupModel: policy.backupModel,
    failureThreshold: policy.failureThreshold,
    failureWindowSeconds: Math.round(policy.failureWindowMs / 1000),
    pendingThreshold: policy.pendingThreshold,
    recoveryProbeSeconds: Math.round(policy.recoveryProbeMs / 1000),
    recoverySuccessThreshold: policy.recoverySuccessThreshold,
    consecutiveFailures: state?.consecutiveFailures || 0,
    lastSuccessAt: isoOrNull(state?.lastSuccessAt),
    lastFailureAt: isoOrNull(state?.lastFailureAt),
    lastFailureCode: state?.lastFailureCode || '',
    backupSince: isoOrNull(state?.backupSince),
    nextPrimaryProbeAt: isoOrNull(state?.nextPrimaryProbeAt),
    recoveryProbeSuccesses: state?.recoveryProbeSuccesses || 0,
    lastProbeAt: isoOrNull(state?.lastProbeAt),
    lastProbeSucceeded: state?.lastProbeSucceeded ?? null,
  };
}
