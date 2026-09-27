// Elastic-pool retry policy shared by the claim path, the snapshot projection
// and the orchestration routes (docs/hotfix/20260927-stuck-retry-and-attention-cleanup.md).
//
// F1: a retryable item whose untried pool Agents never claim it (stop fence,
//     offline, paused, always busy) would wait forever for its round to
//     finish. Once the current handoff is older than elasticRoundRelaxAfterMs()
//     the round exclusion shrinks to "the most recent attempt's Agent only".
// F2: XHS_SEARCH_TIME_FILTER_UNVERIFIED repeating on several Agents for the
//     same keyword is a page/time-window property, not an Agent failure. Once
//     it reached the limit inside the current retry window the item settles as
//     failed instead of burning the whole 2 x pool search budget.
//
// Both thresholds are read from process.env on every call (restart the
// process to change them), invalid or out-of-range values use the default.

export const ELASTIC_ROUND_RELAX_DEFAULT_MINUTES = 10;
export const ELASTIC_FILTER_VERIFICATION_DEFAULT_LIMIT = 3;
export const ELASTIC_FILTER_VERIFICATION_CODES = Object.freeze(new Set([
  'XHS_SEARCH_TIME_FILTER_UNVERIFIED',
]));
export const FILTER_VERIFICATION_STOP_REASON = 'filter_verification_repeated';
export const FILTER_VERIFICATION_SETTLED_MESSAGE =
  '多台节点都无法确认小红书时间筛选结果（可能该时段没有新内容或页面有变化），已停止自动重试；可稍后在批次里「重试失败关键词」';
export const FILTER_VERIFICATION_SETTLED_EVENT = 'elastic_item_filter_verification_settled';
// Keys a settlement adds to the item error; removed again when an operator
// puts the item back into the elastic queue.
export const FILTER_VERIFICATION_SETTLEMENT_KEYS = Object.freeze([
  'automaticRetryStopped',
  'automaticRetryStopReason',
  'filterVerificationAttemptCount',
  'filterVerificationAgentCount',
  'filterVerificationLimit',
  'originalMessage',
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SQL_ALIAS_PATTERN = /^[a-z_][a-z0-9_]*$/u;
// Only strings every PostgreSQL version casts to timestamptz without error:
// real month/day/hour/minute/second ranges and a +-15:59 offset. The day is
// checked against the month length separately (elasticRoundTimestampSql), so
// a malformed value on an item never breaks the whole claim statement.
const ISO_TIMESTAMP_SQL_PATTERN =
  '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T' +
  '([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,6})?' +
  '(Z|[+-](0[0-9]|1[0-5])(:?[0-5][0-9])?)$';

function safeJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function nonNegativeInteger(value) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/u.test(text)) return 0;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : 0;
}

function boundedIntegerEnv(raw, min, max, fallback) {
  const text = String(raw ?? '').trim();
  if (!/^[0-9]+$/u.test(text)) return fallback;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export function elasticRoundRelaxAfterMs(env = process.env) {
  return boundedIntegerEnv(
    env?.CAPTURE_ELASTIC_ROUND_RELAX_MINUTES,
    1,
    1440,
    ELASTIC_ROUND_RELAX_DEFAULT_MINUTES,
  ) * 60 * 1000;
}

export function elasticFilterVerificationLimit(env = process.env) {
  return boundedIntegerEnv(
    env?.CAPTURE_FILTER_VERIFICATION_LIMIT,
    2,
    20,
    ELASTIC_FILTER_VERIFICATION_DEFAULT_LIMIT,
  );
}

function elasticRoundTimestampSql(expression) {
  // Nested CASE: PostgreSQL evaluates CASE branches in order, so the casts
  // only ever see strings that passed the pattern and a real calendar day.
  return `CASE WHEN ${expression} ~ '${ISO_TIMESTAMP_SQL_PATTERN}' THEN CASE
        WHEN substr(${expression}, 9, 2)::integer <= EXTRACT(DAY FROM (
          make_date(substr(${expression}, 1, 4)::integer,
            substr(${expression}, 6, 2)::integer, 1)
          + interval '1 month' - interval '1 day'))
        THEN (${expression})::timestamptz END END`;
}

/**
 * SQL for the current handoff anchor of an elastic item: the latest valid
 * value of the main-projection anchor, the active-keyword anchor and the
 * "重试失败关键词" elastic waiting start. Old anchors stay on an item after a
 * manual retry, so the maximum (never the first present value) is the one
 * that describes the current wait. updated_at is only the fallback: repeated
 * snapshots keep refreshing it.
 */
export function elasticRoundAnchorSql(alias = 'item') {
  if (!SQL_ALIAS_PATTERN.test(alias)) throw new TypeError('invalid_sql_alias');
  return `COALESCE(
        GREATEST(
          ${elasticRoundTimestampSql(`${alias}.metadata #>> '{checkpoint,recovery,handoffReadyAt}'`)},
          ${elasticRoundTimestampSql(`${alias}.error #>> '{recovery,handoffReadyAt}'`)},
          ${elasticRoundTimestampSql(`${alias}.metadata ->> 'elasticRetryWaitingSince'`)}
        ),
        ${alias}.updated_at
      )`;
}

const ISO_TIMESTAMP_JS_PATTERN = new RegExp(ISO_TIMESTAMP_SQL_PATTERN, 'u');

function anchorCandidateMs(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_JS_PATTERN.test(value)) return NaN;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** JS twin of elasticRoundAnchorSql for tests and diagnostics. */
export function elasticRoundAnchorMs(item = {}) {
  const metadata = safeJson(item?.metadata);
  const error = safeJson(item?.error);
  const candidates = [
    safeJson(safeJson(metadata.checkpoint).recovery).handoffReadyAt,
    safeJson(error.recovery).handoffReadyAt,
    metadata.elasticRetryWaitingSince,
  ].map(anchorCandidateMs).filter(Number.isFinite);
  if (candidates.length > 0) return Math.max(...candidates);
  const updatedAt = item?.updated_at instanceof Date
    ? item.updated_at.getTime()
    : Date.parse(String(item?.updated_at || item?.updatedAt || ''));
  return Number.isFinite(updatedAt) ? updatedAt : NaN;
}

export function filterVerificationErrorCode(error = {}, checkpoint = {}) {
  const normalizedError = safeJson(error);
  const normalizedCheckpoint = safeJson(checkpoint);
  return String(
    normalizedError.code ||
      normalizedCheckpoint.errorCode ||
      normalizedCheckpoint.error_code ||
      '',
  ).trim().toUpperCase().slice(0, 100);
}

export function isFilterVerificationCode(code) {
  return ELASTIC_FILTER_VERIFICATION_CODES.has(String(code || '').trim().toUpperCase());
}

/**
 * First attempt number that belongs to the current retry window: after the
 * last negative-patrol recovery (manualRetryBaseAttemptCount) or the last
 * "重试失败关键词" (filterVerificationBaseAttemptCount), whichever is later.
 */
export function filterVerificationWindowBase(itemMetadata = {}) {
  const metadata = safeJson(itemMetadata);
  return Math.max(
    nonNegativeInteger(metadata.manualRetryBaseAttemptCount),
    nonNegativeInteger(metadata.filterVerificationBaseAttemptCount),
  );
}

/**
 * Pure threshold rule. attempts/agents already include the current report.
 * A pinned item or a one-Agent pool (N < 2) keeps the original behavior.
 */
export function elasticFilterVerificationSettlement({
  code = '',
  attempts = 0,
  agents = 0,
  agentAttemptLimit = 0,
  limit = elasticFilterVerificationLimit(),
} = {}) {
  const normalizedLimit = Math.max(2, Math.floor(Number(limit) || 0));
  const poolSize = Math.floor(Number(agentAttemptLimit) || 0);
  const normalizedAttempts = Math.max(0, Math.floor(Number(attempts) || 0));
  const normalizedAgents = Math.max(0, Math.floor(Number(agents) || 0));
  const settle = isFilterVerificationCode(code) &&
    poolSize >= 2 &&
    (
      normalizedAttempts >= normalizedLimit ||
      normalizedAgents >= Math.min(normalizedLimit, poolSize)
    );
  return {
    settle,
    attempts: normalizedAttempts,
    agents: normalizedAgents,
    limit: normalizedLimit,
  };
}

export function buildFilterVerificationSettledError(error = {}, {
  attempts = 0,
  agents = 0,
  limit = elasticFilterVerificationLimit(),
} = {}) {
  const {recovery: _recovery, ...errorWithoutRecovery} = safeJson(error);
  return {
    ...errorWithoutRecovery,
    message: FILTER_VERIFICATION_SETTLED_MESSAGE,
    originalMessage: String(safeJson(error).message || ''),
    automaticRetryStopped: true,
    automaticRetryStopReason: FILTER_VERIFICATION_STOP_REASON,
    filterVerificationAttemptCount: attempts,
    filterVerificationAgentCount: agents,
    filterVerificationLimit: limit,
  };
}

export function filterVerificationSettledEventMessage({keyword = '', attempts = 0, agents = 0} = {}) {
  return `关键词「${String(keyword || '').slice(0, 120)}」时间筛选已失败 ${attempts} 次（${agents} 台节点），无法确认小红书时间筛选，已停止自动重试`;
}

// (item_id, attempt_number) is unique: at most 2 x pool rows per item.
const FILTER_VERIFICATION_COUNT_SQL = `
  SELECT COUNT(*)::integer AS attempts,
    COUNT(DISTINCT attempt.agent_id)::integer AS agents,
    COALESCE(BOOL_OR(attempt.agent_id = $4::uuid), false) AS includes_reporter
  FROM capture_task_item_attempts attempt
  WHERE attempt.tenant_id = $1
    AND attempt.item_id = $2
    AND attempt.agent_id IS NOT NULL
    AND attempt.attempt_number > $3
    AND attempt.attempt_number IS DISTINCT FROM $5::integer
    AND UPPER(COALESCE(attempt.error->>'code', attempt.checkpoint->>'errorCode', '')) = ANY($6::text[])
`;

/**
 * Projection hook: called after a keyword snapshot projected to retryable.
 * The reporting attempt row still holds its previous state (and a repeated
 * snapshot may project the same failure again), so it is excluded from the
 * SQL and added here exactly once.
 *
 * Returns null (keep retryable) or {error, attempts, agents, limit, code}.
 */
export async function settleElasticFilterVerification(tx, {
  tenantId,
  itemId,
  status,
  error = {},
  checkpoint = {},
  elasticPool = false,
  agentAttemptLimit = 0,
  itemMetadata = {},
  reporterAgentId = null,
  attemptNumber = 0,
  env = process.env,
} = {}) {
  if (!elasticPool || status !== 'retryable' || !itemId) return null;
  if (Math.floor(Number(agentAttemptLimit) || 0) < 2) return null;
  if (UUID_PATTERN.test(String(safeJson(itemMetadata).pinnedAgentId || ''))) return null;
  const code = filterVerificationErrorCode(error, checkpoint);
  if (!isFilterVerificationCode(code)) return null;
  const base = filterVerificationWindowBase(itemMetadata);
  const currentAttempt = Math.max(0, Math.floor(Number(attemptNumber) || 0));
  const reporter = UUID_PATTERN.test(String(reporterAgentId || '')) ? String(reporterAgentId) : null;
  const tally = await tx.queryOne(FILTER_VERIFICATION_COUNT_SQL, [
    tenantId,
    itemId,
    base,
    reporter,
    currentAttempt > 0 ? currentAttempt : null,
    Array.from(ELASTIC_FILTER_VERIFICATION_CODES),
  ]);
  const countsCurrent = currentAttempt > base;
  const attempts = Number(tally?.attempts || 0) + (countsCurrent ? 1 : 0);
  const agents = Number(tally?.agents || 0) +
    (countsCurrent && reporter && tally?.includes_reporter !== true ? 1 : 0);
  const decision = elasticFilterVerificationSettlement({
    code,
    attempts,
    agents,
    agentAttemptLimit,
    limit: elasticFilterVerificationLimit(env),
  });
  if (!decision.settle) return null;
  return {
    code,
    attempts: decision.attempts,
    agents: decision.agents,
    limit: decision.limit,
    error: buildFilterVerificationSettledError(error, decision),
  };
}

/**
 * Claim-time backstop for items that were already retryable before this
 * rule existed (09-27: five keywords with 6–7 time-filter failures). One
 * statement settles every eligible keyword of the parent at once; rows that
 * another heartbeat is claiming are skipped without waiting. Stale anchors are
 * removed with the settlement. No stop-fence SQL, no command, no search.
 *
 * Returns the settled rows: [{id, keyword, attempt_count, attempts, agents, error_code}].
 */
export async function settleElasticFilterVerificationBatch(tx, {
  tenantId,
  parentTaskId,
  agentAttemptLimit = 0,
  env = process.env,
} = {}) {
  const poolSize = Math.floor(Number(agentAttemptLimit) || 0);
  if (!tenantId || !parentTaskId || poolSize < 2) return [];
  const limit = elasticFilterVerificationLimit(env);
  const settled = await tx.queryAll(`
    WITH candidate AS (
      SELECT item.id, item.assignment_revision, item.metadata
      FROM capture_task_items item
      WHERE item.tenant_id = $1
        AND item.task_id = $2
        AND item.item_type = 'keyword'
        AND item.status = 'retryable'
        AND UPPER(COALESCE(
          NULLIF(item.error->>'code', ''),
          item.metadata #>> '{checkpoint,errorCode}',
          ''
        )) = ANY($3::text[])
        AND COALESCE(item.metadata->>'pinnedAgentId', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ORDER BY item.id
      FOR UPDATE SKIP LOCKED
    ), counted AS (
      SELECT candidate.id, candidate.assignment_revision,
        tally.attempts, tally.agents
      FROM candidate
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::integer AS attempts,
          COUNT(DISTINCT attempt.agent_id)::integer AS agents
        FROM capture_task_item_attempts attempt
        WHERE attempt.tenant_id = $1
          AND attempt.item_id = candidate.id
          AND attempt.agent_id IS NOT NULL
          AND attempt.attempt_number > GREATEST(
            CASE WHEN candidate.metadata->>'manualRetryBaseAttemptCount' ~ '^[0-9]+$'
              THEN (candidate.metadata->>'manualRetryBaseAttemptCount')::integer ELSE 0 END,
            CASE WHEN candidate.metadata->>'filterVerificationBaseAttemptCount' ~ '^[0-9]+$'
              THEN (candidate.metadata->>'filterVerificationBaseAttemptCount')::integer ELSE 0 END
          )
          AND UPPER(COALESCE(attempt.error->>'code', attempt.checkpoint->>'errorCode', '')) = ANY($3::text[])
      ) tally
      WHERE tally.attempts >= $4::integer
        OR tally.agents >= LEAST($4::integer, $5::integer)
    )
    UPDATE capture_task_items item
    SET status = 'failed',
      metadata = item.metadata #- '{checkpoint,recovery}',
      error = (item.error - 'recovery') || jsonb_build_object(
        'message', $6::text,
        'originalMessage', COALESCE(item.error->>'message', ''),
        'automaticRetryStopped', true,
        'automaticRetryStopReason', $7::text,
        'filterVerificationAttemptCount', counted.attempts,
        'filterVerificationAgentCount', counted.agents,
        'filterVerificationLimit', $4::integer
      ),
      finished_at = COALESCE(item.finished_at, now()),
      updated_at = now()
    FROM counted
    WHERE item.id = counted.id
      AND item.tenant_id = $1
      AND item.task_id = $2
      AND item.status = 'retryable'
      AND item.assignment_revision = counted.assignment_revision
    RETURNING item.id, item.keyword, item.attempt_count, item.finished_at,
      counted.attempts, counted.agents,
      UPPER(COALESCE(NULLIF(item.error->>'code', ''), item.metadata #>> '{checkpoint,errorCode}', ''))
        AS error_code
  `, [
    tenantId,
    parentTaskId,
    Array.from(ELASTIC_FILTER_VERIFICATION_CODES),
    limit,
    poolSize,
    FILTER_VERIFICATION_SETTLED_MESSAGE,
    FILTER_VERIFICATION_STOP_REASON,
  ]);
  if (settled.length === 0) return [];
  await tx.execute(`
    UPDATE capture_task_item_attempts attempt
    SET status = 'failed',
      error = item.error,
      finished_at = COALESCE(attempt.finished_at, item.finished_at, now()),
      updated_at = now()
    FROM capture_task_items item
    WHERE item.tenant_id = $1
      AND item.id = ANY($2::uuid[])
      AND attempt.tenant_id = item.tenant_id
      AND attempt.item_id = item.id
      AND attempt.attempt_number = item.attempt_count
      AND attempt.status = 'retryable'
  `, [tenantId, settled.map(row => row.id)]);
  return settled.map(row => ({...row, limit}));
}
