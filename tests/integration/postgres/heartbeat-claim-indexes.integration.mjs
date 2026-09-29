import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

// docs/hotfix/20260929-heartbeat-claim-load.md: migration 091 adds indexes
// and changes no statement. On a tenant with enough history to make a
// sequential scan expensive, every heartbeat and stop-fence statement must
//   * return exactly what it returns without any index (same admission);
//   * be planned through the 091 indexes (CI runs this on PostgreSQL 14,
//     the production version);
//   * stay within a small number of page reads.
const FENCE = {code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED', message: '旧采集页面未能安全停止'};
const RECONCILED = {code: 'HISTORICAL_STOP_FENCE_RECONCILED', originalCode: FENCE.code};
const FILLER_PER_NODE = 320;
const INDEXES = {
  fence: 'idx_capture_tasks_stop_fence_unconfirmed',
  release: 'idx_capture_tasks_stop_fence_local_release',
  slot: 'idx_capture_tasks_agent_slot_blocking',
  notice: 'idx_capture_tasks_terminal_notice',
  proof: 'idx_capture_tasks_settled_run_proof',
  receipt: 'idx_capture_agent_commands_accepted_stop',
};

test('heartbeat and stop-fence statements read through the 091 indexes and admit the same nodes', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {findCaptureAgentExecutionSlotBlocker} = await import('../../../server/services/capture-cloud.js');
  const {
    claimStopFenceCheckOffers, listCaptureAgentStopFences, readStopFenceHeartbeatWork,
  } = await import('../../../server/services/capture-stop-fence.js');
  await runMigrations();
  const pool = getPool();
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;

  const [tenant] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',
    [`Heartbeat index test ${randomUUID()}`]);
  t.after(async () => {
    await query('DELETE FROM tenants WHERE id=$1', [tenant.id]);
    await closePool();
  });
  const nodes = {};
  for (const name of ['held', 'releasedByRun', 'releasedByStop', 'needsAction', 'localRelease', 'clean']) {
    [nodes[name]] = await query(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,status,
      allowed_platforms,capabilities,last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
      VALUES($1,$2,$3,'active',ARRAY['xiaohongshu'],'{"previousCaptureStopCheckV1":true}',now(),now(),now())
      RETURNING *`, [tenant.id, randomUUID(), name]);
  }

  async function task(node, overrides = {}) {
    const data = {
      task_type: 'unattended_keyword_capture', status: 'completed', error: {}, metadata: {},
      platform: 'xiaohongshu', parent_task_id: null, control_task_id: `control-${randomUUID()}`,
      created_at: '2026-09-01T00:00:00Z', started_at: '2026-09-01T00:01:00Z',
      finished_at: '2026-09-01T00:02:00Z', updated_at: '2026-09-01T00:03:00Z',
      ...overrides,
    };
    const [row] = await query(`INSERT INTO capture_tasks(tenant_id,origin_agent_id,assigned_agent_id,
      client_task_id,control_task_id,title,task_type,status,error,metadata,platform,parent_task_id,
      created_at,started_at,finished_at,updated_at)
      VALUES($1,$2,$2,$3,$4,'Heartbeat index fixture',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [tenant.id, node?.id || null, randomUUID(), data.control_task_id, data.task_type, data.status,
      data.error, data.metadata, data.platform, data.parent_task_id, data.created_at,
      data.started_at, data.finished_at, data.updated_at]);
    return row;
  }

  // History: every node finished many runs long before its fence, each with
  // a `metadata` large enough to be stored out of line, as in production.
  await query(`
    INSERT INTO capture_tasks(tenant_id,origin_agent_id,assigned_agent_id,client_task_id,control_task_id,
      title,task_type,status,metadata,platform,created_at,started_at,finished_at,updated_at)
    SELECT $1, agent.id, agent.id, 'filler-' || agent.id || '-' || n, 'filler-control-' || agent.id || '-' || n,
      'Heartbeat index filler',
      (ARRAY['unattended_keyword_capture','unattended_keyword_capture','capture','negative_post_patrol'])[1 + n % 4],
      (ARRAY['completed','completed','completed_with_warnings','superseded','canceled'])[1 + n % 5],
      jsonb_build_object('executionMode', 'one_time', 'attemptIdentity', md5('attempt' || agent.id || n),
        'planSnapshot', jsonb_build_object('keywords', (
          SELECT jsonb_agg(md5(agent.id::text || n || k) || md5(k::text || n)) FROM generate_series(1, 40) k)),
        'terminalNoticeAcknowledgement', jsonb_build_object(
          'requestId', 'filler-control-' || agent.id || '-' || n,
          'attemptId', md5('attempt' || agent.id || n),
          'status', (ARRAY['completed','completed','completed_with_warnings','superseded','canceled'])[1 + n % 5])),
      'xiaohongshu',
      '2026-08-01T00:00:00Z'::timestamptz + n * interval '1 hour',
      '2026-08-01T00:01:00Z'::timestamptz + n * interval '1 hour',
      '2026-08-01T00:20:00Z'::timestamptz + n * interval '1 hour',
      '2026-08-01T00:21:00Z'::timestamptz + n * interval '1 hour'
    FROM capture_agents agent CROSS JOIN generate_series(1, $2::integer) n
    WHERE agent.tenant_id = $1`, [tenant.id, FILLER_PER_NODE]);

  // Stop commands of that history: most were accepted, as in production.
  await query(`
    INSERT INTO capture_agent_commands(tenant_id,agent_id,task_id,command_type,status,payload,result,
      created_at,finished_at)
    SELECT task.tenant_id, task.assigned_agent_id, task.id, 'stop',
      CASE WHEN task.status = 'canceled' THEN 'completed' ELSE 'failed' END,
      jsonb_build_object('controlTaskId', task.control_task_id, 'platform', task.platform,
        'note', repeat(md5(task.id::text), 8)),
      CASE WHEN task.status = 'canceled' THEN '{"accepted":true}'::jsonb ELSE '{"accepted":false}'::jsonb END,
      task.started_at, task.finished_at
    FROM capture_tasks task
    WHERE task.tenant_id = $1 AND task.title = 'Heartbeat index filler'`, [tenant.id]);

  const parent = await task(null, {task_type: 'capture_orchestration'});
  const successor = await task(nodes.held, {parent_task_id: parent.id});
  const fenced = (node, overrides = {}) => task(node, {
    parent_task_id: parent.id, status: 'superseded', error: FENCE,
    metadata: {handoffSuccessorTaskId: successor.id}, updated_at: '2026-09-02T00:00:00Z', ...overrides,
  });
  const laterRun = (node, overrides = {}) => task(node, {
    task_type: 'capture', created_at: '2026-09-03T00:00:00Z', started_at: '2026-09-03T00:01:00Z',
    finished_at: '2026-09-03T00:02:00Z', updated_at: '2026-09-03T00:03:00Z', ...overrides,
  });

  const held = await fenced(nodes.held);
  const releasedByRun = await fenced(nodes.releasedByRun);
  await laterRun(nodes.releasedByRun);
  const releasedByStop = await fenced(nodes.releasedByStop);
  const canceledRun = await laterRun(nodes.releasedByStop, {status: 'canceled'});
  await query(`INSERT INTO capture_agent_commands(tenant_id,agent_id,task_id,command_type,status,result,
    created_at,finished_at) VALUES($1,$2,$3,'stop','completed','{"accepted":true}',$4,$5)`,
  [tenant.id, nodes.releasedByStop.id, canceledRun.id, '2026-09-03T00:01:30Z', '2026-09-03T00:02:00Z']);
  const needsAction = await fenced(nodes.needsAction, {status: 'needs_action', metadata: {}});
  const releasePending = await task(nodes.localRelease, {
    parent_task_id: parent.id, status: 'superseded', error: RECONCILED, updated_at: '2026-09-02T00:00:00Z',
    metadata: {stopFenceCheck: {version: 1, resolvedAt: new Date().toISOString(), localRelease: {
      checkId: randomUUID(), state: 'pending', requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), lastOfferedAt: null,
    }}},
  });
  const running = await task(nodes.localRelease, {status: 'running', finished_at: null,
    created_at: '2026-09-04T00:00:00Z', started_at: '2026-09-04T00:01:00Z', updated_at: '2026-09-04T00:02:00Z'});
  // Fence codes that never hold a node: a confirmed cancel and a recovery.
  await fenced(nodes.clean, {status: 'canceled'});
  await fenced(nodes.clean, {metadata: {handoffSuccessorTaskId: successor.id, recoveryTaskId: randomUUID()}});
  const recent = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
  const notice = await task(nodes.clean, {task_type: 'negative_post_patrol', status: 'canceled',
    metadata: {attemptIdentity: 'attempt-open'}, finished_at: recent(30), updated_at: recent(30)});
  await task(nodes.clean, {task_type: 'negative_post_patrol', status: 'canceled',
    control_task_id: 'acknowledged-request', finished_at: recent(20), updated_at: recent(20),
    metadata: {attemptIdentity: 'attempt-done', terminalNoticeAcknowledgement: {
      requestId: 'acknowledged-request', attemptId: 'attempt-done', status: 'canceled'}}});
  await task(nodes.clean, {task_type: 'watched_content_patrol', status: 'completed',
    metadata: {attemptIdentity: 'attempt-revoked', terminalDisposition: 'revoked'},
    finished_at: recent(10), updated_at: recent(10)});

  await pool.query('VACUUM (ANALYZE) capture_tasks');
  await pool.query('VACUUM (ANALYZE) capture_agent_commands');
  await pool.query('VACUUM (ANALYZE) capture_task_attempts');

  const route = await readFile(new URL('../../../server/routes/capture-cloud.js', import.meta.url), 'utf8');
  const noticesStart = route.indexOf('const terminalNotices = supportsTerminalNotices ? await tx.queryAll(',
    route.indexOf('async function claimPriorityAgentControl'));
  const noticesOpen = route.indexOf('`', noticesStart);
  const terminalNoticesSql = route.slice(noticesOpen + 1, route.indexOf('`', noticesOpen + 1));

  // Runs `work` against one connection and rolls back. `plain` disables every
  // index scan for that transaction: the statement's meaning without indexes.
  async function inTransaction(work, {plain = false} = {}) {
    const client = await pool.connect();
    const statements = [];
    const run = async (sql, params = []) => {
      statements.push({sql, params});
      return (await client.query(sql, params)).rows;
    };
    const tx = {
      queryAll: run,
      queryOne: async (sql, params) => (await run(sql, params))[0] || null,
      execute: async (sql, params) => ({rows: await run(sql, params)}),
    };
    try {
      await client.query('BEGIN');
      if (plain) {
        await client.query(`SET LOCAL enable_indexscan = off;
          SET LOCAL enable_indexonlyscan = off; SET LOCAL enable_bitmapscan = off`);
      }
      return {value: await work(tx, client), statements};
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  const cases = [];
  for (const [name, node] of Object.entries(nodes)) {
    cases.push({
      name: `slot blocker: ${name}`,
      work: tx => findCaptureAgentExecutionSlotBlocker(tx, tenant.id, node.id),
      allowed: [INDEXES.slot, INDEXES.fence],
    }, {
      name: `heartbeat precheck: ${name}`,
      work: tx => readStopFenceHeartbeatWork(tx, {tenantId: tenant.id, agentId: node.id,
        previousFullHeartbeatAt: null, includeNeedsActionChildren: true}),
      allowed: [INDEXES.fence, INDEXES.release],
    }, {
      name: `node listing: ${name}`,
      work: tx => listCaptureAgentStopFences(tx, tenant.id, {agentId: node.id, includeLocalRelease: true}),
      allowed: [INDEXES.fence, INDEXES.release],
    }, {
      name: `claim listing: ${name}`,
      work: tx => listCaptureAgentStopFences(tx, tenant.id, {agentId: node.id, onlySuperseded: true,
        includeNeedsActionChildren: true, includeLocalRelease: true, includeExpiredLocalRelease: true,
        requireRequestId: true, limit: 6}),
      allowed: [INDEXES.fence, INDEXES.release],
    }, {
      name: `terminal notices: ${name}`,
      work: tx => tx.queryAll(terminalNoticesSql, [tenant.id, node.id]),
      allowed: [INDEXES.notice],
    });
  }
  cases.push({
    name: 'tenant listing',
    work: tx => listCaptureAgentStopFences(tx, tenant.id, {includeLocalRelease: true}),
    allowed: [INDEXES.fence, INDEXES.release],
  });

  await t.test('admission and the listings answer as they do without any index', async () => {
    for (const item of cases) {
      const indexed = await inTransaction(item.work);
      const plain = await inTransaction(item.work, {plain: true});
      assert.deepEqual(indexed.value, plain.value, item.name);
      item.statement = indexed.statements.at(-1);
      item.value = indexed.value;
    }
    const blocker = name => cases.find(item => item.name === `slot blocker: ${name}`).value;
    assert.equal(blocker('held').id, held.id);
    assert.equal(blocker('held').reason, 'previous_capture_stop_unconfirmed');
    assert.equal(blocker('releasedByRun'), null, 'a later settled run released the node');
    assert.equal(blocker('releasedByStop'), null, 'a confirmed stop released the node');
    assert.equal(blocker('needsAction').id, needsAction.id);
    assert.equal(blocker('localRelease').id, running.id);
    assert.equal(blocker('localRelease').reason, 'active_task');
    assert.equal(blocker('clean'), null);

    const listed = cases.find(item => item.name === 'tenant listing').value;
    assert.deepEqual(
      listed.map(row => [row.kind, row.id]).sort(),
      [['fence', held.id], ['fence', needsAction.id], ['local_release', releasePending.id]].sort(),
    );
    const precheck = name => cases.find(item => item.name === `heartbeat precheck: ${name}`).value;
    assert.equal(precheck('held').checkDue, true);
    assert.equal(precheck('releasedByRun').checkDue, true, 'the claim still has to write the release down');
    assert.equal(precheck('needsAction').checkDue, true);
    assert.deepEqual(precheck('localRelease'), {checkDue: true, holdNewWork: true});
    assert.deepEqual(precheck('clean'), {checkDue: false, holdNewWork: false});
    const notices = name => cases.find(item => item.name === `terminal notices: ${name}`).value;
    assert.deepEqual(notices('clean').map(row => row.attempt_id).sort(), ['attempt-open', 'attempt-revoked']);
    assert.equal(notices('clean')[0].request_id, notice.control_task_id);
    assert.deepEqual(notices('held'), []);
  });

  await t.test('the heartbeat claim finds the rows the 976a0c6 rule released', async () => {
    const claim = plain => inTransaction(async tx => {
      const offers = await claimStopFenceCheckOffers(tx, {
        agent: nodes.releasedByRun,
        lockAgentSession: async () => nodes.releasedByRun,
        includeNeedsActionChildren: true,
      });
      const [row] = await tx.queryAll('SELECT error FROM capture_tasks WHERE id=$1', [releasedByRun.id]);
      return {offers, code: row.error.code};
    }, {plain});
    const indexed = await claim(false);
    const plain = await claim(true);
    assert.deepEqual(indexed.value, plain.value);
    assert.deepEqual(indexed.value, {offers: [], code: RECONCILED.code});
    cases.push({
      name: 'claim implicit release',
      statement: indexed.statements.find(statement => /AND NOT \(UPPER\(COALESCE\(task\.error/u.test(statement.sql)),
      allowed: [INDEXES.fence],
    });
    assert.ok(cases.at(-1).statement, 'the implicit release statement was issued');
  });

  function scans(node, found = []) {
    const indexes = new Set();
    (function collect(child) {
      if (child['Index Name']) indexes.add(child['Index Name']);
      for (const next of child.Plans || []) if (!next['Relation Name']) collect(next);
    })(node);
    if (node['Relation Name']) {
      found.push({type: node['Node Type'], relation: node['Relation Name'], alias: node.Alias,
        indexes: [...indexes]});
    }
    for (const child of node.Plans || []) scans(child, found);
    return found;
  }
  const RELEASE_PROOF = {
    stop_proof: INDEXES.proof,
    historical_stop: INDEXES.fence,
    capture_agent_commands: INDEXES.receipt,
  };

  await t.test('every statement is planned through the 091 indexes', async () => {
    for (const item of cases) {
      const {sql, params} = item.statement;
      const [row] = await query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      const found = scans(row['QUERY PLAN'][0].Plan);
      const describe = `${item.name}: ${JSON.stringify(found)}`;
      for (const scan of found) {
        if (!['capture_tasks', 'capture_agent_commands'].includes(scan.relation)) continue;
        assert.notEqual(scan.type, 'Seq Scan', describe);
        if (RELEASE_PROOF[scan.alias]) {
          assert.deepEqual(scan.indexes, [RELEASE_PROOF[scan.alias]], describe);
        }
        if (scan.alias === 'stop_proof') assert.equal(scan.type, 'Index Only Scan', describe);
        if (['task', 'released', 'capture_tasks'].includes(scan.alias) ||
            /^released_\d+$/u.test(scan.alias)) {
          assert.ok(scan.indexes.length > 0 && scan.indexes.every(name => item.allowed.includes(name)),
            describe);
        }
        // needs_action rows are few by nature; the status index is as good.
        if (scan.alias === 'fenced_child') {
          assert.ok(scan.indexes.length > 0 && scan.indexes.every(name =>
            [INDEXES.fence, 'idx_capture_tasks_tenant_status_updated'].includes(name)), describe);
        }
      }
      const outer = found.filter(scan => scan.alias === 'task' || scan.relation === 'capture_tasks' &&
        ['released', 'fenced_child', 'capture_tasks'].includes(scan.alias));
      assert.ok(outer.length > 0, describe);
    }
    const blocker = cases.find(item => item.name === 'slot blocker: held');
    const [row] = await query(`EXPLAIN (FORMAT JSON) ${blocker.statement.sql}`, blocker.statement.params);
    const outer = scans(row['QUERY PLAN'][0].Plan).find(scan => scan.alias === 'task');
    assert.deepEqual([...outer.indexes].sort(), [INDEXES.slot, INDEXES.fence].sort(),
      'live work and fences are read from the two small indexes');
  });

  await t.test('no statement reads more than a small share of the history', async st => {
    const pagesRead = async (item, plain) => (await inTransaction(async (tx, client) => {
      const {rows} = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${item.statement.sql.replace(
          /\s+FOR UPDATE(?: OF [a-z_]+)?(?: SKIP LOCKED)?\s*$/u, '')}`,
        item.statement.params,
      );
      const plan = rows[0]['QUERY PLAN'][0].Plan;
      return (plan['Shared Hit Blocks'] || 0) + (plan['Shared Read Blocks'] || 0);
    }, {plain})).value;
    const ceilings = [
      [/^slot blocker: (?:clean|releasedByRun|releasedByStop|localRelease)$/u, 120],
      [/^slot blocker: (?:held|needsAction)$/u, 400],
      [/^heartbeat precheck: /u, 200],
      [/^terminal notices: /u, 200],
      [/^(?:node|claim) listing: /u, 400],
      [/^tenant listing$/u, 600],
      [/^claim implicit release$/u, 400],
    ];
    for (const item of cases) {
      const ceiling = ceilings.find(([pattern]) => pattern.test(item.name))?.[1];
      assert.ok(ceiling, item.name);
      const indexed = await pagesRead(item, false);
      const plain = await pagesRead(item, true);
      st.diagnostic(`${item.name}: ${indexed} pages (${plain} without index scans)`);
      assert.ok(indexed <= ceiling, `${item.name} read ${indexed} pages (ceiling ${ceiling})`);
      // The fixture is large enough that losing an index would show here.
      assert.ok(plain >= indexed * 4, `${item.name}: ${indexed} pages, ${plain} without index scans`);
    }
  });
});
