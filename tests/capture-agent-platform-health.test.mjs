import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  AGENT_HEALTH_PROBE_INTERVAL_MS,
  AGENT_HEALTH_STARVATION_MS,
  agentPlatformAdmission,
  elasticItemStarving,
  evaluateAgentPlatformHealth,
  readAgentPlatformHealth,
} from '../server/services/capture-agent-platform-health.js';

const now = Date.parse('2026-11-07T12:00:00Z');
const statuses = list => list.map(status => ({status}));
const failing = statuses(['failed', 'retryable', 'failed', 'completed', 'retryable', 'failed', 'needs_action', 'completed']);
const healthyFleet = {ok: 45, total: 50};

test('a browser that mostly fails a platform the fleet handles well is paused there', () => {
  const health = evaluateAgentPlatformHealth({recent: failing, fleet: healthyFleet,
    lastClaimAt: new Date(now - 5 * 60 * 1000).toISOString(), now});
  assert.equal(health.quarantined, true);
  assert.equal(health.probeAllowed, false);
  assert.equal(health.samples, 8);
  assert.equal(health.successes, 2);
});

test('a paused browser gets one probe per hour and its latest success lifts the pause', () => {
  const probe = evaluateAgentPlatformHealth({recent: failing, fleet: healthyFleet,
    lastClaimAt: new Date(now - AGENT_HEALTH_PROBE_INTERVAL_MS).toISOString(), now});
  assert.equal(probe.quarantined, true);
  assert.equal(probe.probeAllowed, true);
  const recovered = evaluateAgentPlatformHealth({
    recent: [{status: 'completed'}, ...failing], fleet: healthyFleet, now});
  assert.equal(recovered.quarantined, false);
});

test('a platform-wide problem never pauses every browser', () => {
  const struggling = evaluateAgentPlatformHealth({recent: failing, fleet: {ok: 20, total: 50}, now});
  assert.equal(struggling.quarantined, false, 'others are not clearly healthier');
  const unknownFleet = evaluateAgentPlatformHealth({recent: failing, fleet: {ok: 5, total: 5}, now});
  assert.equal(unknownFleet.quarantined, false, 'too few fleet samples to compare');
});

test('few samples or an acceptable success rate keep the browser admitted', () => {
  assert.equal(evaluateAgentPlatformHealth({recent: failing.slice(0, 5), fleet: healthyFleet, now}).quarantined, false);
  const mixed = statuses(['failed', 'completed', 'completed', 'failed', 'completed', 'completed', 'failed', 'completed']);
  assert.equal(evaluateAgentPlatformHealth({recent: mixed, fleet: healthyFleet, now}).quarantined, false);
});

test('work nobody else has claimed within the starvation window stays open to a paused browser', () => {
  const fresh = new Date(now - 60 * 1000).toISOString();
  const old = new Date(now - AGENT_HEALTH_STARVATION_MS).toISOString();
  assert.equal(elasticItemStarving({itemStatus: 'pending', waitingSince: fresh, now}), false);
  assert.equal(elasticItemStarving({itemStatus: 'pending', waitingSince: old, now}), true);
  assert.equal(elasticItemStarving({itemStatus: 'retryable', itemUpdatedAt: old, waitingSince: fresh, now}), true);
  assert.equal(elasticItemStarving({itemStatus: 'retryable', itemUpdatedAt: fresh, waitingSince: old, now}), false);
});

test('an unavailable health read fails open inside its own savepoint and is cached per heartbeat', async () => {
  const sql = [];
  let reads = 0;
  const tx = {
    async execute(statement) { sql.push(statement); },
    async queryOne(statement) {
      if (statement.includes('pg_settings')) return {previous_timeout_ms: '5000'};
      throw Object.assign(new Error('canceling statement due to statement timeout'), {code: '57014'});
    },
    async queryAll() { reads += 1; return []; },
  };
  const health = await readAgentPlatformHealth(tx, {tenantId: 't', agentId: 'a', platform: 'douyin'});
  assert.equal(health.quarantined, false);
  assert.equal(health.unavailable, true);
  assert.deepEqual(sql, ['SAVEPOINT capture_agent_platform_health',
    'ROLLBACK TO SAVEPOINT capture_agent_platform_health', 'RELEASE SAVEPOINT capture_agent_platform_health']);
  const cache = new Map();
  await agentPlatformAdmission(tx, {cache, tenantId: 't', agentId: 'a', platform: 'douyin'});
  await agentPlatformAdmission(tx, {cache, tenantId: 't', agentId: 'a', platform: 'douyin'});
  assert.equal(reads, 2, 'one read for the direct call, one for the first cached admission');
});

test('the automatic claim pauses only fresh work of an unhealthy platform and keeps pinned work', async () => {
  const source = await readFile(new URL('../server/routes/capture-cloud.js', import.meta.url), 'utf8');
  assert.match(source, /cardinality\(\$16::text\[\]\) = 0[\s\S]*item\.metadata->>'pinnedAgentId' = \$2::text[\s\S]*\$17::bigint/u);
  assert.match(source, /platformHealth\.quarantined &&\s*!platformHealth\.probeAllowed &&\s*!elasticItemStarving/u);
  assert.match(source, /quarantinedPlatforms: \[\.\.\.quarantinedPlatforms, candidatePlatform\]/u);
});
