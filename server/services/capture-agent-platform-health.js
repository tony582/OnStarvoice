// Agent x platform admission health for automatic work claims.
//
// A browser whose recent work on one platform mostly fails (for example a
// Windows profile that cannot open Xiaohongshu detail pages) keeps taking
// fresh keywords and failing them. This module pauses automatic claims for
// that agent on that platform only while the rest of the fleet is clearly
// healthier, lets it take one probe per hour, and never starves work: an item
// that nobody else has claimed for a while stays open to every agent.

export const AGENT_HEALTH_SAMPLE_LIMIT = 10;
export const AGENT_HEALTH_MIN_SAMPLES = 6;
export const AGENT_HEALTH_MIN_SUCCESS_RATE = 0.5;
export const AGENT_HEALTH_WINDOW_MS = 72 * 60 * 60 * 1000;
export const AGENT_HEALTH_FLEET_WINDOW_MS = 6 * 60 * 60 * 1000;
export const AGENT_HEALTH_FLEET_MIN_SAMPLES = 8;
export const AGENT_HEALTH_FLEET_MARGIN = 0.3;
export const AGENT_HEALTH_PROBE_INTERVAL_MS = 60 * 60 * 1000;
export const AGENT_HEALTH_STARVATION_MS = 20 * 60 * 1000;
const AGENT_HEALTH_QUERY_TIMEOUT_MS = 750;

const SUCCESS_STATUSES = new Set(['completed', 'completed_with_warnings']);
export const AGENT_HEALTH_SAMPLE_STATUSES = Object.freeze([
  'completed', 'completed_with_warnings', 'failed', 'retryable', 'needs_action',
]);
// Outcomes that say nothing about this browser's ability to do the work.
export const AGENT_HEALTH_NEUTRAL_CODES = Object.freeze([
  'UNATTENDED_ATTEMPT_REPLACED',
  'PREVIOUS_CAPTURE_STOP_OPERATOR_RELEASED',
  'USER_CANCELED',
  'CAPTURE_CANCELED',
  'DOUYIN_SEARCH_SERVICE_ABNORMAL',
]);

function time(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Pure evaluation. `recent` is this agent's newest-first settled attempts on
 * the platform: [{status}], `fleet` the other agents' success/total counts.
 */
export function evaluateAgentPlatformHealth({
  recent = [],
  fleet = {},
  lastClaimAt = null,
  now = Date.now(),
} = {}) {
  const samples = (Array.isArray(recent) ? recent : []).slice(0, AGENT_HEALTH_SAMPLE_LIMIT);
  const successes = samples.filter(sample => SUCCESS_STATUSES.has(String(sample?.status || ''))).length;
  const successRate = samples.length > 0 ? successes / samples.length : 1;
  const fleetTotal = Math.max(0, Number(fleet?.total) || 0);
  const fleetRate = fleetTotal > 0 ? Math.max(0, Number(fleet?.ok) || 0) / fleetTotal : null;
  const latestSucceeded = samples.length > 0 && SUCCESS_STATUSES.has(String(samples[0]?.status || ''));
  const quarantined =
    samples.length >= AGENT_HEALTH_MIN_SAMPLES &&
    successRate < AGENT_HEALTH_MIN_SUCCESS_RATE &&
    !latestSucceeded &&
    fleetTotal >= AGENT_HEALTH_FLEET_MIN_SAMPLES &&
    fleetRate - successRate >= AGENT_HEALTH_FLEET_MARGIN;
  const lastClaim = time(lastClaimAt);
  const nowMs = time(now instanceof Date ? now : new Date(now));
  const probeAllowed = quarantined &&
    (!Number.isFinite(lastClaim) || nowMs - lastClaim >= AGENT_HEALTH_PROBE_INTERVAL_MS);
  return {
    quarantined,
    probeAllowed,
    samples: samples.length,
    successes,
    successRate,
    fleetRate,
    fleetSamples: fleetTotal,
  };
}

/** True when nobody has taken this work for long enough that any agent may. */
export function elasticItemStarving({itemStatus, itemUpdatedAt, waitingSince, now = Date.now()} = {}) {
  const anchor = time(String(itemStatus || '') === 'retryable' ? itemUpdatedAt : waitingSince);
  const nowMs = time(now instanceof Date ? now : new Date(now));
  return Number.isFinite(anchor) && Number.isFinite(nowMs) &&
    nowMs - anchor >= AGENT_HEALTH_STARVATION_MS;
}

/**
 * Reads one agent's platform health inside the claiming transaction. A failed
 * optional read must not abort the heartbeat transaction, so it runs inside a
 * savepoint with a short statement timeout and fails open (healthy).
 */
export async function readAgentPlatformHealth(tx, {tenantId, agentId, platform}) {
  const healthy = {quarantined: false, probeAllowed: false, samples: 0, successes: 0,
    successRate: 1, fleetRate: null, fleetSamples: 0, unavailable: false};
  if (!tenantId || !agentId || !platform) return healthy;
  await tx.execute('SAVEPOINT capture_agent_platform_health');
  try {
    const timeout = await tx.queryOne(`
      SELECT setting AS previous_timeout_ms,
        set_config('statement_timeout',
          (CASE WHEN setting::integer=0 THEN $1::integer
            ELSE LEAST(setting::integer,$1::integer) END)::text || 'ms', true)
      FROM pg_settings WHERE name='statement_timeout'
    `, [AGENT_HEALTH_QUERY_TIMEOUT_MS]);
    const recent = await tx.queryAll(`
      SELECT attempt.status
      FROM capture_task_item_attempts attempt
      JOIN capture_task_items item
        ON item.id = attempt.item_id AND item.tenant_id = attempt.tenant_id
      WHERE attempt.tenant_id = $1 AND attempt.agent_id = $2 AND item.platform = $3
        AND attempt.updated_at > now() - ($4::bigint * interval '1 millisecond')
        AND attempt.status = ANY($5::text[])
        AND UPPER(COALESCE(attempt.error->>'code', '')) <> ALL($6::text[])
      ORDER BY COALESCE(attempt.finished_at, attempt.updated_at) DESC, attempt.id DESC
      LIMIT $7
    `, [tenantId, agentId, platform, AGENT_HEALTH_WINDOW_MS,
      AGENT_HEALTH_SAMPLE_STATUSES, AGENT_HEALTH_NEUTRAL_CODES, AGENT_HEALTH_SAMPLE_LIMIT]);
    const lastClaim = await tx.queryOne(`
      SELECT MAX(attempt.created_at) AS last_claim_at
      FROM capture_task_item_attempts attempt
      JOIN capture_task_items item
        ON item.id = attempt.item_id AND item.tenant_id = attempt.tenant_id
      WHERE attempt.tenant_id = $1 AND attempt.agent_id = $2 AND item.platform = $3
        AND attempt.updated_at > now() - ($4::bigint * interval '1 millisecond')
    `, [tenantId, agentId, platform, AGENT_HEALTH_WINDOW_MS]);
    const fleet = await tx.queryOne(`
      SELECT
        COUNT(*) FILTER (WHERE attempt.status IN ('completed', 'completed_with_warnings'))::integer AS ok,
        COUNT(*)::integer AS total
      FROM capture_task_item_attempts attempt
      JOIN capture_task_items item
        ON item.id = attempt.item_id AND item.tenant_id = attempt.tenant_id
      JOIN capture_agents other
        ON other.id = attempt.agent_id AND other.tenant_id = attempt.tenant_id
      WHERE attempt.tenant_id = $1 AND attempt.agent_id <> $2 AND item.platform = $3
        AND attempt.updated_at > now() - ($4::bigint * interval '1 millisecond')
        AND attempt.status = ANY($5::text[])
        AND UPPER(COALESCE(attempt.error->>'code', '')) <> ALL($6::text[])
        AND COALESCE(other.capabilities->>'agentKind', '') <> 'android_mobile'
    `, [tenantId, agentId, platform, AGENT_HEALTH_FLEET_WINDOW_MS,
      AGENT_HEALTH_SAMPLE_STATUSES, AGENT_HEALTH_NEUTRAL_CODES]);
    await tx.queryOne("SELECT set_config('statement_timeout',$1,true)",
      [`${timeout.previous_timeout_ms}ms`]);
    const observed = await tx.queryOne('SELECT now() AS observed_at');
    return {
      ...evaluateAgentPlatformHealth({
        recent,
        fleet,
        lastClaimAt: lastClaim?.last_claim_at || null,
        now: observed?.observed_at || new Date(),
      }),
      unavailable: false,
    };
  } catch {
    await tx.execute('ROLLBACK TO SAVEPOINT capture_agent_platform_health');
    console.warn('[Capture health] Agent platform health unavailable; admitting normally');
    return {...healthy, unavailable: true};
  } finally {
    await tx.execute('RELEASE SAVEPOINT capture_agent_platform_health');
  }
}

/**
 * One cached read per platform for a single heartbeat claim. `cache` is a Map
 * shared by the recursive candidate search of one heartbeat.
 */
export async function agentPlatformAdmission(tx, {cache, tenantId, agentId, platform}) {
  const key = String(platform || '');
  if (cache?.has(key)) return cache.get(key);
  const health = await readAgentPlatformHealth(tx, {tenantId, agentId, platform: key});
  cache?.set(key, health);
  return health;
}
