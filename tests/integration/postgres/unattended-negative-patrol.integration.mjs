import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

const DAY = 24 * 60 * 60 * 1000;
const FIXED_RUN = '2026-09-08T01:00:00.000Z';
const KEYWORD = '集成测试品牌';
const CAPABILITIES = {
  remoteTaskCreate: true, remoteTaskKeywordPostLimit: true,
  remoteTaskEnhancementOptions: true, singleRelayV1: true,
  remoteSequentialSearchPassesV1: true, remoteTargetedPostCaptureV1: true,
  negativePostPatrol: true, negativePatrolTerminalReceiptV1: true,
  watchedContentPatrol: true, remoteStop: true, taskStateKnown: true,
  supportedPlatforms: ['douyin', 'xiaohongshu'],
};

test('unattended negative patrol preserves real scheduling, dispatch and durable rotation boundaries', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {
    normalizeUnattendedNegativePatrolScope: normalizeScope,
    loadUnattendedNegativePatrolCandidates: loadCandidates,
    claimUnattendedNegativePatrolItem: claimRotation,
    completeUnattendedNegativePatrolItem: completeRotation,
    failUnattendedNegativePatrolItem: failRotation,
  } = await import('../../../server/services/unattended-negative-patrol.js');
  const {dispatchNextElasticWorkItem, projectNegativePatrolSnapshot} =
    await import('../../../server/routes/capture-cloud.js');
  await runMigrations();
  const pool = getPool();
  t.after(closePool);

  async function fixture(st, {runStartedAt = FIXED_RUN, agentCount = 2} = {}) {
    const tenant = (await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [`Unattended patrol integration ${randomUUID()}`])).rows[0];
    st.after(async () => {
      await pool.query('DELETE FROM capture_orchestration_schedule_agents WHERE tenant_id=$1', [tenant.id]);
      await pool.query('DELETE FROM tenants WHERE id=$1', [tenant.id]);
    });
    const scope = normalizeScope({tenantId: tenant.id, platforms: ['douyin', 'xiaohongshu'],
      keywords: [KEYWORD], runStartedAt, timezone: 'Asia/Shanghai'});
    const code = (await pool.query(`INSERT INTO auth_codes (tenant_id, code, status, expires_at)
      VALUES ($1, $2, 'active', now()+interval '1 day') RETURNING id`,
    [tenant.id, `PATROL-${randomUUID()}`])).rows[0];
    const agents = [];
    for (let index = 0; index < agentCount; index++) {
      const binding = (await pool.query('INSERT INTO auth_bindings (code_id,fingerprint) VALUES ($1,$2) RETURNING id',
        [code.id, randomUUID()])).rows[0];
      const agent = (await pool.query(`INSERT INTO capture_agents (
        tenant_id,client_uuid,display_name,browser_name,app_version,allowed_platforms,status,
        auth_code_id,auth_binding_id,capabilities,last_heartbeat_at,last_full_heartbeat_at,last_liveness_at
      ) VALUES ($1,$2,$3,'Chrome','0.4.7',ARRAY['douyin','xiaohongshu'],'active',$4,$5,$6,now(),now(),now()) RETURNING *`,
      [tenant.id, randomUUID(), `Patrol node ${index}`, code.id, binding.id, JSON.stringify(CAPABILITIES)])).rows[0];
      agents.push(agent);
      await pool.query(`INSERT INTO capture_agent_tokens (agent_id,auth_code_id,auth_binding_id,token_hash)
        VALUES ($1,$2,$3,$4)`, [agent.id, code.id, binding.id,
        createHash('sha256').update(randomUUID()).digest('hex')]);
    }
    async function record(label, options = {}) {
      const publishedAt = options.publishedAt === null ? null
        : options.publishedAt || new Date(Date.parse(runStartedAt) - DAY).toISOString();
      const platform = options.platform || 'douyin';
      const externalId = `patrol_${randomUUID().replaceAll('-', '')}`;
      const row = (await pool.query(`INSERT INTO records (
        tenant_id,external_id,platform,title,keyword,sentiment,publish_time,published_ts,
        created_at,business_visibility,manual_overrides,content_availability_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'eligible',$10,$11) RETURNING *`,
      [tenant.id, externalId, platform, label, options.keyword || KEYWORD,
        options.sentiment || 'negative', publishedAt || '', publishedAt,
        options.createdAt || new Date(Date.parse(runStartedAt) - 8 * DAY).toISOString(),
        JSON.stringify(options.overrides || {}), options.availability || 'unknown'])).rows[0];
      if (options.status || options.archived || options.priority) await pool.query(`INSERT INTO record_triage
        (tenant_id,record_id,status,priority,archived_at)
        VALUES ($1,$2,$3,$4,CASE WHEN $5::boolean THEN now() ELSE NULL END)`,
      [tenant.id, row.id, options.status || 'unhandled', options.priority || 'normal', !!options.archived]);
      return row;
    }
    async function parent({plan = {}, metadata = {}, platform = 'douyin'} = {}) {
      return (await pool.query(`INSERT INTO capture_tasks (
        tenant_id,client_task_id,task_type,feature_key,platform,status,title,metadata,counts
      ) VALUES ($1,$2,'capture_orchestration','keyword_orchestration',$3,'pending','Mixed patrol fixture',$4,'{"total":0}') RETURNING *`,
      [tenant.id, randomUUID(), platform, JSON.stringify({distributionMode: 'elastic_pool',
        eligibleAgentIds: agents.map(agent => agent.id), negativePatrolRun: {...scope, summary: {}},
        planSnapshot: {platform, keywords: [KEYWORD], keywordMaxDetectedItems: 2,
          maxRounds: 1, negativePatrol: {enabled: true, lookbackDays: 7}, ...plan}, ...metadata})])).rows[0];
    }
    async function item(owner, {record: source, keyword, ordinal = 0, metadata = {}} = {}) {
      return (await pool.query(`INSERT INTO capture_task_items (
        tenant_id,task_id,item_key,item_type,keyword,ordinal,platform,record_id,external_id,url_snapshot,status,metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) RETURNING *`,
      [tenant.id, owner.id, source ? `negative:${source.platform}:${source.external_id}` : `keyword:${ordinal}:${keyword}`,
        source ? 'negative_post' : 'keyword', keyword || '', ordinal, source?.platform || owner.platform,
        source?.id || null, source?.external_id || '', source
          ? `https://www.${source.platform === 'douyin' ? 'douyin.com/video' : 'xiaohongshu.com/explore'}/${source.external_id}` : '',
        JSON.stringify(source ? {unattendedNegativePatrol: true, sourceRecord: {title: source.title},
          captureSettings: {skipExistingPosts: false}, ...metadata} : metadata)])).rows[0];
    }
    async function claim(agent = agents[0]) {
      const current = (await pool.query('SELECT * FROM capture_agents WHERE id=$1', [agent.id])).rows[0];
      return withTransaction(tx => dispatchNextElasticWorkItem(tx, {agent: current, capabilities: current.capabilities}));
    }
    async function state(source) {
      return (await pool.query(`SELECT * FROM unattended_negative_patrol_state
        WHERE tenant_id=$1 AND platform=$2 AND external_id=$3`, [tenant.id, source.platform, source.external_id])).rows[0];
    }
    async function execution(source, {owner, targetItem, agent = agents[0], revision = 1, metadata = {}} = {}) {
      owner ||= await parent();
      targetItem ||= await item(owner, {record: source, metadata});
      const child = (await pool.query(`INSERT INTO capture_tasks (
        tenant_id,parent_task_id,assigned_agent_id,client_task_id,task_type,feature_key,platform,status,orchestration_revision,metadata
      ) VALUES ($1,$2,$3,$4,'negative_post_patrol','negative_post_patrol',$5,'running',$6,$7) RETURNING *`,
      [tenant.id, owner.id, agent.id, randomUUID(), source.platform, revision,
        JSON.stringify({cloudWorkQueue: true, distributionMode: 'elastic_pool', perItemAdmissionV1: true})])).rows[0];
      const hash = createHash('sha256').update(randomUUID()).digest('hex');
      await pool.query(`UPDATE capture_task_items SET execution_task_id=$2,assigned_agent_id=$3,
        assignment_revision=$4,attempt_count=1,request_hash=$5,status='dispatched' WHERE id=$1`,
      [targetItem.id, child.id, agent.id, revision, hash]);
      const attempt = (await pool.query(`INSERT INTO capture_task_item_attempts (
        tenant_id,item_id,parent_task_id,execution_task_id,agent_id,attempt_number,assignment_revision,status,request_hash
      ) VALUES ($1,$2,$3,$4,$5,1,$6,'dispatched',$7) RETURNING *`,
      [tenant.id, targetItem.id, owner.id, child.id, agent.id, revision, hash])).rows[0];
      const input = {...scope, recordId: source.id, itemId: targetItem.id,
        executionTaskId: child.id, assignmentRevision: revision, now: runStartedAt};
      return {owner, item: targetItem, child, attempt, input, agent};
    }
    async function observation(source, {at = runStartedAt, graph, likes = 1} = {}) {
      return (await pool.query(`INSERT INTO record_observations (
        tenant_id,record_id,platform,keyword,captured_at,likes,comments_count,collects,shares,
        capture_task_id,capture_task_item_id,capture_task_item_attempt_id
      ) VALUES ($1,$2,$3,$4,$5,$6,2,3,4,$7,$8,$9) RETURNING *`,
      [tenant.id, source.id, source.platform, KEYWORD, at, likes,
        graph?.child.id || null, graph?.item.id || null, graph?.attempt.id || null])).rows[0];
    }
    return {tenant, scope, agents, record, parent, item, claim, state, execution, observation};
  }

  async function authenticatedHttp(st, f) {
    const {createApp} = await import('../../../server/app.js');
    const {hashPassword} = await import('../../../server/services/auth-service.js');
    const password = 'unattended-integration-only';
    const email = `unattended-${randomUUID()}@integration.invalid`;
    const user = (await pool.query(`INSERT INTO users (email,name,password_hash,status,must_change_password)
      VALUES ($1,'Patrol test user',$2,'active',false) RETURNING id`, [email, hashPassword(password)])).rows[0];
    st.after(() => pool.query('DELETE FROM users WHERE id=$1', [user.id]));
    await pool.query("INSERT INTO user_memberships (user_id,tenant_id,role,status) VALUES ($1,$2,'tenant_admin','active')", [user.id, f.tenant.id]);
    const server = await new Promise((resolve, reject) => {
      const listening = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
      listening.once('error', reject);
      listening.once('listening', () => resolve(listening));
    });
    st.after(() => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const loginResponse = await fetch(`${origin}/api/auth/login`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password})});
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    const headers = {'content-type': 'application/json', authorization: `Bearer ${login.token}`, 'x-tenant-id': f.tenant.id};
    return {
      async post(path, body) {
        const response = await fetch(`${origin}${path}`, {method: 'POST', headers, body: JSON.stringify(body)});
        return {status: response.status, body: await response.json()};
      },
      async patch(path, body) {
        const response = await fetch(`${origin}${path}`, {method: 'PATCH', headers, body: JSON.stringify(body)});
        return {status: response.status, body: await response.json()};
      },
    };
  }

  await t.test('the frozen 168-hour window, existing triage, keyword and tenant scope produce the complete ordered candidate set', async st => {
    const f = await fixture(st);
    const start = await f.record('inclusive-start', {publishedAt: f.scope.windowStart});
    const cold = await f.record('cold-first-visit', {status: 'negative_cold'});
    const feishu = await f.record('feishu-first-visit', {status: 'negative_feishu'});
    const privacy = await f.record('privacy-is-still-visible', {status: 'privacy_unreachable'});
    const xhs = await f.record('independent-platform', {platform: 'xiaohongshu'});
    await f.record('before-start', {publishedAt: new Date(Date.parse(f.scope.windowStart) - 1).toISOString()});
    await f.record('exclusive-end', {publishedAt: f.scope.windowEnd});
    await f.record('created-in-this-run', {createdAt: f.scope.windowEnd});
    await f.record('not-monitored', {status: 'reviewed_non_monitor'});
    await f.record('not-visible', {status: 'unavailable'});
    await f.record('archived', {archived: true});
    await f.record('other-keyword', {keyword: '其他品牌'});
    await f.record('positive', {sentiment: 'positive'});
    await f.record('missing-date', {publishedAt: null});
    const other = await fixture(st);
    await other.record('other-tenant');
    const loaded = await withTransaction(tx => loadCandidates(tx, {...f.scope, persistCandidates: true}));
    assert.deepEqual(new Set(loaded.candidates.map(row => row.recordId)), new Set([start.id, cold.id, feishu.id, privacy.id, xhs.id]));
    assert.equal(loaded.candidates.filter(row => row.platform === 'douyin')[0].recordId, start.id);
    assert.equal(loaded.summary.firstPending, 5);
    assert.equal(loaded.summary.unknownPublishTime, 1);
    assert.equal(loaded.summary.exclusionReasons.triage_reviewed_non_monitor, 1);
    assert.equal(loaded.summary.exclusionReasons.triage_unavailable, 1);
    assert.equal(loaded.candidates.find(row => row.recordId === cold.id).dueReason, 'first_patrol');
    const next = await withTransaction(tx => loadCandidates(tx, {...f.scope,
      runStartedAt: '2026-09-09T01:00:00Z', persistCandidates: true}));
    assert.equal(next.summary.outOfWindowUncovered, 1);
    assert.equal(next.candidates.some(row => row.recordId === start.id), false);
  });

  await t.test('automatic rotation is not truncated by the manual preview hundred-record limit', async st => {
    const f = await fixture(st, {agentCount: 0});
    await pool.query(`INSERT INTO records (tenant_id,external_id,platform,title,keyword,sentiment,
      publish_time,published_ts,created_at,business_visibility)
      SELECT $1,'many-'||n,'douyin','complete candidate enumeration',$2,'negative',$3::text,$3::text::timestamptz,
        $3::text::timestamptz-interval '1 day','eligible' FROM generate_series(1,105) n`,
    [f.tenant.id, KEYWORD, '2026-09-07T01:00:00Z']);
    const loaded = await withTransaction(tx => loadCandidates(tx, {...f.scope, persistCandidates: true}));
    assert.equal(loaded.candidates.length, 105);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM unattended_negative_patrol_state WHERE tenant_id=$1', [f.tenant.id])).rows[0].n, 105);
  });

  await t.test('two real Agents claim the keyword first and patrol while that keyword is still running', async st => {
    const f = await fixture(st, {runStartedAt: new Date().toISOString()});
    const source = await f.record('parallel-negative');
    const owner = await f.parent({plan: {captureSettings: {skipExistingPosts: true},
      searchPasses: [{sort: 'general'}, {sort: 'latest'}], recoveryPolicy: {singleRelayV1: true}}});
    // A smaller patrol ordinal makes this a priority assertion, not insertion-order luck.
    const patrol = await f.item(owner, {record: source, ordinal: 0});
    const keyword = await f.item(owner, {keyword: KEYWORD, ordinal: 10});
    await pool.query('UPDATE capture_tasks SET counts=$2 WHERE id=$1', [owner.id, {total: 2}]);
    const first = await f.claim(f.agents[0]);
    assert.equal(first?.itemId, keyword.id, JSON.stringify(first));
    await pool.query("UPDATE capture_tasks SET status='running',started_at=now() WHERE id=$1", [first.childTaskId]);
    await pool.query("UPDATE capture_task_items SET status='running' WHERE id=$1", [keyword.id]);
    const targetedOnly = {...CAPABILITIES, singleRelayV1: false,
      remoteSequentialSearchPassesV1: false, remoteTaskKeywordPostLimit: false};
    await pool.query('UPDATE capture_agents SET capabilities=$2 WHERE id=$1', [f.agents[1].id, targetedOnly]);
    const second = await f.claim(f.agents[1]);
    assert.equal(second?.itemId, patrol.id, JSON.stringify(second));
    const command = (await pool.query('SELECT * FROM capture_agent_commands WHERE id=$1', [second.commandId])).rows[0];
    assert.equal(command.payload.workflow, 'negative_post_patrol');
    assert.equal(command.payload.platform, source.platform);
    assert.equal(command.payload.targets.length, 1);
    assert.equal(command.payload.captureSettings.skipExistingPosts, false);
    const attempt = (await pool.query('SELECT * FROM capture_task_item_attempts WHERE item_id=$1', [patrol.id])).rows[0];
    assert.equal(command.payload.targets[0].captureTaskItemAttemptId, attempt.id);
    assert.equal(command.payload.targets[0].captureTaskItemRequestHash, attempt.request_hash);
    assert.ok(command.admitted_at);
    assert.equal((await pool.query('SELECT status FROM capture_tasks WHERE id=$1', [first.childTaskId])).rows[0].status, 'running');
    assert.equal(await f.claim(f.agents[1]), null, 'A busy Agent cannot claim a second execution');
    const child = (await pool.query('SELECT * FROM capture_tasks WHERE id=$1', [second.childTaskId])).rows[0];
    const finishedAt = new Date().toISOString();
    const endpoint = await f.observation(source, {at: finishedAt,
      graph: {child, item: patrol, attempt}});
    const snapshot = {status: 'completed', targetResults: [{
      itemId: patrol.id, recordId: source.id, externalId: source.external_id,
      ordinal: 1, status: 'completed', startedAt: f.scope.runStartedAt, finishedAt,
    }]};
    await withTransaction(tx => projectNegativePatrolSnapshot(tx, f.agents[1], child, snapshot));
    const completed = (await pool.query('SELECT * FROM capture_task_items WHERE id=$1', [patrol.id])).rows[0];
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result_observation_id, endpoint.id);
    const rotation = await f.state(source);
    assert.equal(rotation.last_result_observation_id, endpoint.id);
    assert.equal(rotation.lease_execution_task_id, null);
    assert.equal((await pool.query('SELECT status FROM capture_tasks WHERE id=$1', [owner.id])).rows[0].status,
      'running', 'Patrol completion must not settle a still-running keyword');
    await withTransaction(tx => projectNegativePatrolSnapshot(tx, f.agents[1], child, snapshot));
    assert.deepEqual(await f.state(source), rotation, 'A repeated terminal heartbeat must not advance the next visit');
  });

  await t.test('same-post reservations serialize across separate runs and survive a reopened connection', async st => {
    const f = await fixture(st);
    const source = await f.record('one-post-two-runs');
    const first = { ...f.scope, recordId: source.id, itemId: randomUUID(), executionTaskId: randomUUID(), assignmentRevision: 1, now: FIXED_RUN};
    const second = {...first, itemId: randomUUID(), executionTaskId: randomUUID()};
    const outcomes = await Promise.all([
      withTransaction(tx => claimRotation(tx, first)),
      withTransaction(tx => claimRotation(tx, second)),
    ]);
    assert.equal(outcomes.filter(result => result.claimed).length, 1);
    assert.ok(['already_claimed', 'record_busy'].includes(outcomes.find(result => !result.claimed).reason));
    const winner = outcomes[0].claimed ? first : second;
    const loser = outcomes[0].claimed ? second : first;
    assert.equal((await withTransaction(tx => claimRotation(tx, loser))).reason, 'already_claimed');
    assert.equal((await f.state(source)).lease_item_id, winner.itemId);
    const connection = await pool.connect();
    try {
      const persisted = await connection.query('SELECT lease_execution_task_id FROM unattended_negative_patrol_state WHERE tenant_id=$1 AND record_id=$2', [f.tenant.id, source.id]);
      assert.equal(persisted.rows[0].lease_execution_task_id, winner.executionTaskId);
    } finally { connection.release(); }
  });

  await t.test('twelve search-quota-blocked keywords cannot exhaust every heartbeat before an executable negative patrol', async st => {
    const f = await fixture(st, {runStartedAt: new Date().toISOString(), agentCount: 1});
    const agent = f.agents[0];
    const account = (await pool.query(`INSERT INTO social_accounts
      (tenant_id,platform,platform_account_id,daily_search_limit) VALUES ($1,'douyin',$2,1) RETURNING id`,
    [f.tenant.id, randomUUID()])).rows[0];
    await pool.query(`INSERT INTO social_account_bindings (tenant_id,agent_id,social_account_id,platform)
      VALUES ($1,$2,$3,'douyin')`, [f.tenant.id, agent.id, account.id]);
    await pool.query(`INSERT INTO social_agent_daily_usage (tenant_id,agent_id,platform,usage_date,searches,last_event_at)
      VALUES ($1,$2,'douyin',(now() AT TIME ZONE 'Asia/Shanghai')::date,1,now())`, [f.tenant.id, agent.id]);
    const owner = await f.parent();
    const keywords = [];
    for (let ordinal = 0; ordinal < 12; ordinal++) {
      keywords.push(await f.item(owner, {keyword: `${KEYWORD}-${ordinal}`, ordinal}));
    }
    const source = await f.record('zero-search-target-after-twelve-blockers');
    const patrol = await f.item(owner, {record: source, ordinal: 12});
    await pool.query('UPDATE capture_tasks SET counts=$2 WHERE id=$1', [owner.id, {total: 13}]);
    const claimed = await f.claim(agent);
    assert.equal(claimed?.itemId, patrol.id, JSON.stringify(claimed));
    const command = (await pool.query('SELECT * FROM capture_agent_commands WHERE id=$1', [claimed.commandId])).rows[0];
    assert.equal(command.payload.workflow, 'negative_post_patrol');
    const pending = (await pool.query('SELECT status,attempt_count FROM capture_task_items WHERE id=ANY($1::uuid[])', [keywords.map(item => item.id)])).rows;
    assert.equal(pending.length, 12);
    assert.ok(pending.every(item => item.status === 'pending' && item.attempt_count === 0));
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM capture_agent_commands WHERE tenant_id=$1', [f.tenant.id])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT searches FROM social_agent_daily_usage WHERE tenant_id=$1', [f.tenant.id])).rows[0].searches, 1);
  });

  await t.test('a state changed after materialization is rechecked before dispatch without consuming an attempt', async st => {
    const f = await fixture(st, {runStartedAt: new Date().toISOString()});
    const source = await f.record('withdraw-before-claim');
    const owner = await f.parent();
    const target = await f.item(owner, {record: source});
    await pool.query(`INSERT INTO record_triage (tenant_id,record_id,status)
      VALUES ($1,$2,'reviewed_non_monitor')`, [f.tenant.id, source.id]);
    const dispatched = await f.claim();
    assert.equal(dispatched, null);
    const saved = (await pool.query('SELECT * FROM capture_task_items WHERE id=$1', [target.id])).rows[0];
    assert.equal(saved.status, 'skipped');
    assert.match(saved.metadata.skipReason, /reviewed_non_monitor/u);
    assert.equal(saved.attempt_count, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM capture_task_item_attempts WHERE item_id=$1', [target.id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM capture_agent_commands WHERE tenant_id=$1', [f.tenant.id])).rows[0].n, 0);
  });

  await t.test('a completion heartbeat with only an unrelated keyword snapshot cannot settle or advance the patrol', async st => {
    const f = await fixture(st);
    const source = await f.record('no-patrol-observation');
    const graph = await f.execution(source);
    assert.equal((await withTransaction(tx => claimRotation(tx, graph.input))).claimed, true);
    await f.observation(source, {at: '2026-09-08T01:10:00Z'});
    const snapshot = {status: 'completed', targetResults: [{itemId: graph.item.id,
      recordId: source.id, externalId: source.external_id, ordinal: 1, status: 'completed',
      startedAt: FIXED_RUN, finishedAt: '2026-09-08T01:10:00Z'}]};
    await withTransaction(tx => projectNegativePatrolSnapshot(tx, graph.agent, graph.child, snapshot));
    const saved = (await pool.query('SELECT * FROM capture_task_items WHERE id=$1', [graph.item.id])).rows[0];
    assert.equal(saved.status, 'needs_action');
    assert.equal(saved.error.code, 'patrol_durable_result_missing');
    assert.equal(saved.result_observation_id, null);
    assert.equal((await f.state(source)).last_success_at, null);
  });

  await t.test('only exact persisted attempt evidence advances rotation, once, to the next calendar batch', async st => {
    const f = await fixture(st);
    const source = await f.record('calendar-and-lineage');
    const graph = await f.execution(source);
    assert.equal((await withTransaction(tx => claimRotation(tx, graph.input))).claimed, true);
    const complete = overrides => withTransaction(tx => completeRotation(tx, {
      ...graph.input, finishedAt: '2026-09-08T01:20:00Z', ...overrides,
    }));
    assert.equal((await complete()).updated, false);
    const unrelated = await f.observation(source, {at: '2026-09-08T01:19:00Z'});
    await pool.query("UPDATE capture_task_items SET status='completed',result_observation_id=$2 WHERE id=$1", [graph.item.id, unrelated.id]);
    assert.equal((await complete({resultObservationId: unrelated.id})).updated, false,
      'A concurrent keyword observation must not count as this patrol success');
    assert.equal((await f.state(source)).last_success_at, null);
    const endpoint = await f.observation(source, {graph, at: '2026-09-08T01:20:00Z'});
    await pool.query('UPDATE capture_task_items SET result_observation_id=$2 WHERE id=$1', [graph.item.id, endpoint.id]);
    assert.equal((await complete({resultObservationId: endpoint.id, assignmentRevision: 2})).updated, false);
    const success = await complete({resultObservationId: endpoint.id, finishedAt: '2099-01-01T00:00:00Z'});
    assert.equal(success.updated, true);
    assert.equal(success.nextDueDate, '2026-09-09');
    const saved = await f.state(source);
    assert.equal(saved.last_success_at.toISOString(), endpoint.captured_at.toISOString(),
      'An incorrect device completion clock cannot postpone the server-observed next patrol');
    assert.equal((await complete({resultObservationId: endpoint.id})).updated, false);
    assert.deepEqual(await f.state(source), saved, 'Replays do not advance the rotation clock');
    const sameDay = await withTransaction(tx => loadCandidates(tx, {...f.scope, runStartedAt: '2026-09-08T05:00:00Z'}));
    assert.equal(sameDay.candidates.length, 0);
    const nextMorning = await withTransaction(tx => loadCandidates(tx, {...f.scope, runStartedAt: '2026-09-09T01:00:00Z'}));
    assert.equal(nextMorning.candidates[0]?.recordId, source.id,
      '09:20 completion must not miss the next day 09:00 batch');
  });

  await t.test('stable cold treatment gets a first patrol, then seven-day cadence; failures preserve first-patrol eligibility', async st => {
    const f = await fixture(st);
    const cold = await f.record('stable-cold', {status: 'negative_cold'});
    const baseline = await f.observation(cold, {at: '2026-09-07T05:00:00Z'});
    const graph = await f.execution(cold, {metadata: {baseline: {observationId: baseline.id}}});
    assert.equal((await withTransaction(tx => claimRotation(tx, graph.input))).claimed, true);
    const endpoint = await f.observation(cold, {graph, at: '2026-09-08T02:00:00Z'});
    await pool.query("UPDATE capture_task_items SET status='completed',result_observation_id=$2 WHERE id=$1", [graph.item.id, endpoint.id]);
    const success = await withTransaction(tx => completeRotation(tx, {...graph.input,
      resultObservationId: endpoint.id, finishedAt: '2026-09-08T02:00:00Z'}));
    assert.equal(success.updated, true);
    assert.equal(success.cadenceDays, 7);
    assert.equal(success.nextDueDate, '2026-09-15');
    const failedSource = await f.record('failed-first-patrol');
    const failed = await f.execution(failedSource);
    assert.equal((await withTransaction(tx => claimRotation(tx, failed.input))).claimed, true);
    const outcome = await withTransaction(tx => failRotation(tx, {...failed.input, now: FIXED_RUN}));
    assert.equal(outcome.updated, true);
    const failedState = await f.state(failedSource);
    assert.equal(failedState.last_success_at, null);
    assert.equal(failedState.next_due_date, null);
    assert.equal(failedState.failure_count, 1);
    assert.equal((await withTransaction(tx => failRotation(tx, {...failed.input, now: FIXED_RUN}))).updated, false);
    const duringCooldown = await withTransaction(tx => loadCandidates(tx, f.scope));
    assert.equal(duringCooldown.candidates.some(row => row.recordId === failedSource.id), false);
    const afterCooldown = await withTransaction(tx => loadCandidates(tx, {...f.scope, runStartedAt: '2026-09-08T01:16:00Z'}));
    assert.equal(afterCooldown.candidates.find(row => row.recordId === failedSource.id)?.dueReason, 'first_patrol');
  });

  await t.test('manual retry requires a settled source, preserves attempts, renews the original queue budget and fences old results', async st => {
    const f = await fixture(st, {runStartedAt: new Date().toISOString()});
    const http = await authenticatedHttp(st, f);
    const source = await f.record('manual-retry-original-item');
    const graph = await f.execution(source);
    assert.equal((await withTransaction(tx => claimRotation(tx, graph.input))).claimed, true);
    await pool.query("UPDATE capture_task_items SET status='needs_action',attempt_count=8 WHERE id=$1", [graph.item.id]);
    await pool.query(`INSERT INTO capture_task_item_attempts (tenant_id,item_id,parent_task_id,
      execution_task_id,agent_id,attempt_number,assignment_revision,status,request_hash,finished_at,updated_at)
      SELECT $1,$2,$3,$4,$5,n,1,'failed',$6,now()-interval '1 hour',now()-interval '1 hour'
      FROM generate_series(2,8) n`,
    [f.tenant.id, graph.item.id, graph.owner.id, graph.child.id, graph.agent.id, graph.attempt.request_hash]);
    const retryPath = `/api/capture-cloud/orchestrations/${graph.owner.id}/negative-patrol/retry`;
    const revision = Number(graph.owner.orchestration_revision);
    const request = {expectedRevision: revision, itemIds: [graph.item.id], confirmSafety: true};
    const busy = await http.post(retryPath, request);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error, 'retry_source_not_settled');
    assert.equal((await f.state(source)).lease_execution_task_id, graph.child.id);
    await pool.query("UPDATE capture_tasks SET status='failed',finished_at=now() WHERE id=$1", [graph.child.id]);
    const restored = await http.post(retryPath, request);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.revision, revision + 1);
    const pending = (await pool.query('SELECT * FROM capture_task_items WHERE id=$1', [graph.item.id])).rows[0];
    assert.equal(pending.status, 'pending');
    assert.equal(pending.task_id, graph.owner.id);
    assert.equal(pending.attempt_count, 8, 'Manual recovery must retain append-only historical attempt numbering');
    assert.equal(pending.metadata.manualRetryBaseAttemptCount, 8);
    assert.equal(pending.execution_task_id, null);
    assert.equal((await f.state(source)).lease_execution_task_id, null);
    const staleRevision = await http.post(retryPath, request);
    assert.equal(staleRevision.status, 409);
    assert.equal(staleRevision.body.error, 'revision_conflict');
    const resumed = await f.claim(graph.agent);
    assert.equal(resumed?.itemId, graph.item.id, JSON.stringify(resumed));
    const nextAttempt = (await pool.query('SELECT * FROM capture_task_item_attempts WHERE item_id=$1 ORDER BY attempt_number DESC LIMIT 1', [graph.item.id])).rows[0];
    assert.equal(nextAttempt.attempt_number, 9);
    assert.equal(nextAttempt.execution_task_id, resumed.childTaskId);
    assert.ok(nextAttempt.assignment_revision > graph.input.assignmentRevision);
    assert.notEqual(nextAttempt.request_hash, graph.attempt.request_hash);
    const oldEndpoint = await f.observation(source, {graph, at: new Date().toISOString()});
    const stateBeforeReplay = await f.state(source);
    await withTransaction(tx => projectNegativePatrolSnapshot(tx, graph.agent, graph.child, {
      status: 'completed', targetResults: [{itemId: graph.item.id, recordId: source.id,
        externalId: source.external_id, ordinal: 1, status: 'completed',
        startedAt: f.scope.runStartedAt, finishedAt: oldEndpoint.captured_at.toISOString()}],
    }));
    assert.deepEqual(await f.state(source), stateBeforeReplay);
    const active = (await pool.query('SELECT * FROM capture_task_items WHERE id=$1', [graph.item.id])).rows[0];
    assert.equal(active.execution_task_id, resumed.childTaskId);
    assert.equal(active.status, 'dispatched');
    assert.equal(active.result_observation_id, null);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM capture_task_item_attempts WHERE item_id=$1', [graph.item.id])).rows[0].n, 9);
  });

  await t.test('formal watched patrol evidence shares the daily clock, while keyword captures and failed attempts never count as success', async st => {
    const f = await fixture(st);
    const sources = [];
    const endpoints = [];
    for (const kind of ['watched', 'keyword', 'failed-attempt']) {
      const source = await f.record(`formal-${kind}`);
      const graph = await f.execution(source);
      const endpoint = await f.observation(source, {graph, at: '2026-09-08T00:30:00Z'});
      await pool.query(`UPDATE capture_task_items SET status='completed',result_observation_id=$2,
        finished_at=$3,item_type=$4 WHERE id=$1`,
      [graph.item.id, endpoint.id, endpoint.captured_at, kind === 'watched' ? 'watched_content' : 'negative_post']);
      await pool.query(`UPDATE capture_tasks SET status='completed',task_type=$2,feature_key=$2,
        finished_at=$3 WHERE id=$1`, [graph.child.id,
        kind === 'watched' ? 'watched_content_patrol' : kind === 'keyword' ? 'unattended_keyword_capture' : 'negative_post_patrol',
        endpoint.captured_at]);
      await pool.query('UPDATE capture_task_item_attempts SET status=$2,finished_at=$3 WHERE id=$1',
        [graph.attempt.id, kind === 'failed-attempt' ? 'failed' : 'completed', endpoint.captured_at]);
      if (kind === 'watched') await pool.query("UPDATE capture_task_items SET finished_at='2099-01-01T00:00:00Z' WHERE id=$1", [graph.item.id]);
      assert.equal(await f.state(source), undefined, 'Formal hand-operated evidence exists before any unattended rotation state');
      sources.push(source);
      endpoints.push(endpoint);
    }
    const today = await withTransaction(tx => loadCandidates(tx, f.scope));
    assert.deepEqual(new Set(today.candidates.map(row => row.recordId)), new Set(sources.slice(1).map(row => row.id)));
    assert.ok(today.candidates.every(row => row.dueReason === 'first_patrol'));
    assert.equal(today.summary.notDue, 1);
    const watchedClaim = await withTransaction(tx => claimRotation(tx, {...f.scope, recordId: sources[0].id,
      itemId: randomUUID(), executionTaskId: randomUUID(), assignmentRevision: 1, now: FIXED_RUN}));
    assert.equal(watchedClaim.claimed, false);
    assert.equal(watchedClaim.reason, 'not_due');
    assert.equal(watchedClaim.sharedResultObservationId, endpoints[0].id);
    assert.equal(watchedClaim.nextDueDate, '2026-09-09');
    const tomorrow = await withTransaction(tx => loadCandidates(tx, {...f.scope, runStartedAt: '2026-09-09T01:00:00Z'}));
    assert.equal(tomorrow.candidates.find(row => row.recordId === sources[0].id)?.dueReason, 'due');
  });

  await t.test('HTTP creation saves the negative switch, ordinary schedule edits retain it, and explicit disable removes it', async st => {
    const f = await fixture(st, {runStartedAt: new Date().toISOString()});
    const http = await authenticatedHttp(st, f);
    const requestKey = randomUUID();
    const plan = {requestKey, title: 'Editable mixed patrol plan', platform: 'douyin',
      executionMode: 'unattended_plan', distributionMode: 'elastic_pool', keywords: [KEYWORD],
      agentIds: f.agents.map(agent => agent.id), schedule: {mode: 'daily', startTime: '09:00'},
      keywordMaxDetectedItems: 2, maxRounds: 1};
    const created = await http.post('/api/capture-cloud/orchestrations', {
      ...plan, negativePatrol: {enabled: true, lookbackDays: 7},
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const template = (await pool.query('SELECT * FROM capture_tasks WHERE id=$1', [requestKey])).rows[0];
    assert.deepEqual(template.metadata.planSnapshot.negativePatrol, {enabled: true, lookbackDays: 7});
    const items = (await pool.query('SELECT * FROM capture_task_items WHERE task_id=$1', [template.id])).rows;
    const activated = await http.post(`/api/capture-cloud/orchestrations/${template.id}/dispatch`, {
      expectedRevision: 0, eligibleAgentIds: f.agents.map(agent => agent.id),
      assignments: items.map(item => ({itemId: item.id, agentId: f.agents[0].id})),
    });
    assert.ok([200, 201].includes(activated.status), JSON.stringify(activated.body));
    const schedule = (await pool.query('SELECT * FROM capture_orchestration_schedules WHERE template_task_id=$1', [template.id])).rows[0];
    assert.deepEqual(schedule.plan_snapshot.negativePatrol, {enabled: true, lookbackDays: 7});
    const edited = await http.patch(`/api/capture-cloud/orchestrations/${template.id}/schedule`, {
      ...plan, title: 'Title changed without touching patrol', expectedRevision: Number(schedule.revision),
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const retained = (await pool.query('SELECT * FROM capture_orchestration_schedules WHERE id=$1', [schedule.id])).rows[0];
    assert.deepEqual(retained.plan_snapshot.negativePatrol, {enabled: true, lookbackDays: 7});
    const disabled = await http.patch(`/api/capture-cloud/orchestrations/${template.id}/schedule`, {
      ...plan, expectedRevision: Number(retained.revision), negativePatrol: {enabled: false, lookbackDays: 7},
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    const stopped = (await pool.query('SELECT * FROM capture_orchestration_schedules WHERE id=$1', [schedule.id])).rows[0];
    const stoppedTemplate = (await pool.query('SELECT * FROM capture_tasks WHERE id=$1', [template.id])).rows[0];
    assert.notEqual(stopped.plan_snapshot.negativePatrol?.enabled, true);
    assert.notEqual(stoppedTemplate.metadata.planSnapshot.negativePatrol?.enabled, true);
    const materialized = await http.post(`/api/capture-cloud/orchestrations/${template.id}/schedule/run-now`, {requestKey: randomUUID()});
    assert.equal(materialized.status, 201, JSON.stringify(materialized.body));
    assert.deepEqual((await pool.query('SELECT item_type FROM capture_task_items WHERE task_id=$1', [materialized.body.runTaskId])).rows.map(row => row.item_type), ['keyword']);
  });

  await t.test('restoring failed items does not bypass the frozen window or a new non-monitoring decision', async st => {
    const f = await fixture(st, {runStartedAt: new Date().toISOString()});
    const http = await authenticatedHttp(st, f);
    const owner = await f.parent();
    const excluded = await f.record('requeued-then-excluded');
    const expired = await f.record('requeued-date-corrected-outside-window');
    const graphs = [];
    for (const [ordinal, source] of [excluded, expired].entries()) {
      const item = await f.item(owner, {record: source, ordinal});
      const graph = await f.execution(source, {owner, targetItem: item});
      graphs.push(graph);
      await pool.query("UPDATE capture_tasks SET status='failed' WHERE id=$1", [graph.child.id]);
      await pool.query("UPDATE capture_task_items SET status='failed' WHERE id=$1", [item.id]);
    }
    const restored = await http.post(`/api/capture-cloud/orchestrations/${owner.id}/negative-patrol/retry`, {
      expectedRevision: Number(owner.orchestration_revision), itemIds: graphs.map(graph => graph.item.id), confirmSafety: true,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    await pool.query("INSERT INTO record_triage (tenant_id,record_id,status) VALUES ($1,$2,'reviewed_non_monitor')", [f.tenant.id, excluded.id]);
    await pool.query('UPDATE records SET published_ts=$2 WHERE id=$1',
      [expired.id, new Date(Date.parse(f.scope.windowStart) - 1).toISOString()]);
    assert.equal(await f.claim(), null);
    const saved = (await pool.query('SELECT * FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal', [owner.id])).rows;
    assert.deepEqual(saved.map(row => row.status), ['skipped', 'skipped']);
    assert.match(saved[0].metadata.skipReason, /reviewed_non_monitor/u);
    assert.equal(saved[1].metadata.skipReason, 'outside_window');
    assert.deepEqual(saved.map(row => row.attempt_count), [1, 1]);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM capture_agent_commands WHERE tenant_id=$1', [f.tenant.id])).rows[0].n, 0);
    assert.equal((await f.state(expired)).last_success_at, null);
  });

  await t.test('generic task stop withdraws mixed queues and undelivered keyword/patrol children without accepting old patrol receipts', async st => {
    for (const mode of ['waiting-to-claim', 'children-not-delivered']) {
      await st.test(mode, async stopTest => {
        const f = await fixture(stopTest, {runStartedAt: new Date().toISOString()});
        const http = await authenticatedHttp(stopTest, f);
        const owner = await f.parent();
        const keyword = await f.item(owner, {keyword: KEYWORD, ordinal: 0});
        const source = await f.record(`stop-${mode}-first`);
        const unclaimedSource = await f.record(`stop-${mode}-unclaimed`);
        const patrol = await f.item(owner, {record: source, ordinal: 1});
        const unclaimedPatrol = await f.item(owner, {record: unclaimedSource, ordinal: 2});
        await withTransaction(tx => loadCandidates(tx, {...f.scope, persistCandidates: true}));
        await pool.query('UPDATE capture_tasks SET counts=$2 WHERE id=$1', [owner.id, {total: 3}]);
        let dispatchedPatrol;
        let oldGraph;
        if (mode === 'children-not-delivered') {
          const dispatchedKeyword = await f.claim(f.agents[0]);
          assert.equal(dispatchedKeyword?.itemId, keyword.id);
          dispatchedPatrol = await f.claim(f.agents[1]);
          assert.equal(dispatchedPatrol?.itemId, patrol.id);
          const child = (await pool.query('SELECT * FROM capture_tasks WHERE id=$1', [dispatchedPatrol.childTaskId])).rows[0];
          const attempt = (await pool.query('SELECT * FROM capture_task_item_attempts WHERE item_id=$1', [patrol.id])).rows[0];
          oldGraph = {child, item: patrol, attempt};
          assert.equal(child.started_at, null);
          assert.equal(child.heartbeat_at, null);
        }
        const stopped = await http.post(`/api/capture-cloud/tasks/${owner.id}/stop`, {});
        assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
        assert.equal(stopped.body.status, 'canceled');
        assert.equal(stopped.body.canceledItemCount, 3);
        assert.deepEqual(stopped.body.stopCommandIds, []);
        const stoppedParent = (await pool.query('SELECT * FROM capture_tasks WHERE id=$1', [owner.id])).rows[0];
        assert.equal(stoppedParent.status, 'canceled');
        assert.equal(stoppedParent.metadata.operatorStopped, true);
        const stoppedItems = (await pool.query('SELECT * FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal', [owner.id])).rows;
        assert.ok(stoppedItems.every(item => item.status === 'canceled' && item.metadata.operatorStopped === true));
        assert.equal(stoppedItems.find(item => item.id === unclaimedPatrol.id).attempt_count, 0);
        const commands = (await pool.query('SELECT * FROM capture_agent_commands WHERE tenant_id=$1', [f.tenant.id])).rows;
        assert.equal(commands.length, dispatchedPatrol ? 2 : 0);
        assert.ok(commands.every(command => command.status === 'expired' && command.result.reason === 'stopped_before_dispatch'));
        const children = (await pool.query('SELECT * FROM capture_tasks WHERE parent_task_id=$1', [owner.id])).rows;
        assert.ok(children.every(child => child.status === 'canceled' && child.metadata.stoppedBeforeDispatch === true));
        for (const agent of f.agents) assert.equal(await f.claim(agent), null);
        if (oldGraph) {
          const endpoint = await f.observation(source, {graph: oldGraph, at: new Date().toISOString()});
          const beforeReplay = await f.state(source);
          await withTransaction(tx => projectNegativePatrolSnapshot(tx, f.agents[1], oldGraph.child, {
            status: 'completed', targetResults: [{itemId: patrol.id, recordId: source.id,
              externalId: source.external_id, ordinal: 1, status: 'completed',
              startedAt: f.scope.runStartedAt, finishedAt: endpoint.captured_at.toISOString()}],
          }));
          assert.deepEqual(await f.state(source), beforeReplay);
          const retained = (await pool.query('SELECT status,result_observation_id FROM capture_task_items WHERE id=$1', [patrol.id])).rows[0];
          assert.equal(retained.status, 'canceled');
          assert.equal(retained.result_observation_id, null);
        }
        assert.equal((await f.state(source)).last_success_at, null);
        assert.equal((await f.state(unclaimedSource)).last_success_at, null);
        const repeated = await http.post(`/api/capture-cloud/tasks/${owner.id}/stop`, {});
        assert.equal(repeated.status, 200);
        assert.equal(repeated.body.existing, true);
        assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM capture_agent_commands WHERE tenant_id=$1', [f.tenant.id])).rows[0].n, commands.length);
      });
    }
  });

  await t.test('the real HTTP run-now route materializes one mixed run idempotently and leaves an unchecked schedule keyword-only', async st => {
    const f = await fixture(st, {runStartedAt: new Date().toISOString()});
    const source = await f.record('http-materialized-negative');
    const http = await authenticatedHttp(st, f);
    async function schedule(enabled) {
      const template = await f.parent({metadata: {orchestrationTemplate: true, executionMode: 'unattended_plan'}});
      await f.item(template, {keyword: KEYWORD});
      const saved = (await pool.query(`INSERT INTO capture_orchestration_schedules (
        tenant_id,template_task_id,title,platform,status,schedule_mode,timezone,start_time,
        plan_snapshot,distribution_mode,next_run_at
      ) VALUES ($1,$2,'HTTP patrol plan','douyin','active','daily','Asia/Shanghai','09:00',$3,'elastic_pool',now()+interval '1 day') RETURNING *`,
      [f.tenant.id, template.id, {platform: 'douyin', keywords: [KEYWORD], maxRounds: 1,
        keywordMaxDetectedItems: 2, negativePatrol: {enabled, lookbackDays: 7}}])).rows[0];
      await pool.query('UPDATE capture_tasks SET orchestration_schedule_id=$2 WHERE id=$1', [template.id, saved.id]);
      for (const [index, agent] of f.agents.entries()) await pool.query(`INSERT INTO capture_orchestration_schedule_agents
        (schedule_id,tenant_id,agent_id,ordinal) VALUES ($1,$2,$3,$4)`, [saved.id, f.tenant.id, agent.id, index]);
      return template;
    }
    async function runNow(template, requestKey) {
      return http.post(`/api/capture-cloud/orchestrations/${template.id}/schedule/run-now`, {requestKey});
    }
    const checked = await schedule(true);
    const requestKey = randomUUID();
    const first = await runNow(checked, requestKey);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const rows = (await pool.query('SELECT * FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal', [first.body.runTaskId])).rows;
    assert.deepEqual(rows.map(row => row.item_type), ['keyword', 'negative_post']);
    assert.equal(rows[1].record_id, source.id);
    assert.equal(rows[1].metadata.unattendedNegativePatrol, true);
    const run = (await pool.query('SELECT * FROM capture_tasks WHERE id=$1', [first.body.runTaskId])).rows[0];
    assert.equal(Date.parse(run.metadata.negativePatrolRun.windowEnd) - Date.parse(run.metadata.negativePatrolRun.windowStart), 7 * DAY);
    assert.equal(run.counts.total, 2);
    const replay = await runNow(checked, requestKey);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.runTaskId, first.body.runTaskId);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM capture_task_items WHERE task_id=$1', [first.body.runTaskId])).rows[0].n, 2);
    const unchecked = await schedule(false);
    const keywordOnly = await runNow(unchecked, randomUUID());
    assert.equal(keywordOnly.status, 201, JSON.stringify(keywordOnly.body));
    assert.deepEqual((await pool.query('SELECT item_type FROM capture_task_items WHERE task_id=$1', [keywordOnly.body.runTaskId])).rows.map(row => row.item_type), ['keyword']);

    await st.test('unclaimed patrols roll into the next occurrence after keyword completion, while a live patrol still blocks overlap', async () => {
      await pool.query("UPDATE capture_task_items SET status='completed',finished_at=now() WHERE id=$1", [rows[0].id]);
      const next = await runNow(checked, randomUUID());
      assert.equal(next.status, 201, JSON.stringify(next.body));
      assert.notEqual(next.body.runTaskId, first.body.runTaskId);
      const rolled = (await pool.query('SELECT * FROM capture_task_items WHERE id=$1', [rows[1].id])).rows[0];
      assert.equal(rolled.status, 'skipped');
      assert.equal(rolled.metadata.skipReason, 'next_run_rollover');
      assert.equal(rolled.attempt_count, 0);
      assert.equal((await f.state(source)).last_success_at, null);
      const nextItems = (await pool.query('SELECT * FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal', [next.body.runTaskId])).rows;
      assert.deepEqual(nextItems.map(row => row.item_type), ['keyword', 'negative_post']);
      assert.equal(nextItems[1].record_id, source.id);
      await pool.query("UPDATE capture_task_items SET status='completed',finished_at=now() WHERE id=$1", [nextItems[0].id]);
      const nextParent = (await pool.query('SELECT * FROM capture_tasks WHERE id=$1', [next.body.runTaskId])).rows[0];
      const live = await f.execution(source, {owner: nextParent, targetItem: nextItems[1]});
      const blocked = await runNow(checked, randomUUID());
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error, 'orchestration_schedule_overlap');
      assert.equal(blocked.body.activeRunTaskId, next.body.runTaskId);
      const retained = (await pool.query('SELECT status,execution_task_id FROM capture_task_items WHERE id=$1', [nextItems[1].id])).rows[0];
      assert.equal(retained.status, 'dispatched');
      assert.equal(retained.execution_task_id, live.child.id);
    });
  });
});
