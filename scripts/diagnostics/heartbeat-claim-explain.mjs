// Prints a read-only psql script that measures the statements of the node
// heartbeat and the stop-fence admission path with EXPLAIN (ANALYZE, BUFFERS).
//
//   node scripts/diagnostics/heartbeat-claim-explain.mjs [--nodes=6] > explain.sql
//   psql -X -f explain.sql            # inside the database to measure
//
// The statements are the ones the server sends: they are rendered by calling
// the real functions with a recording executor, or cut out of the route source.
// The script runs in one READ ONLY transaction, removes row locks
// (FOR UPDATE ... SKIP LOCKED) and forces custom plans, which is how the
// unnamed statements of node-postgres are planned. It measures the busiest
// nodes plus the nodes that own a row with the stop-fence code.
// docs/hotfix/20260929-heartbeat-claim-load.md describes how to read the output.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  captureTaskUnconfirmedLocalStopSql,
  findCaptureAgentExecutionSlotBlocker,
} from '../../server/services/capture-cloud.js';
import {
  claimStopFenceCheckOffers,
  listCaptureAgentStopFences,
  readStopFenceHeartbeatWork,
} from '../../server/services/capture-stop-fence.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const nodeLimit = Math.max(1, Math.min(40, Number(
  (process.argv.find(value => value.startsWith('--nodes=')) || '--nodes=6').slice(8),
) || 6));

const TENANT = '{tenant}';
const NODE = '{node}';
const PLACEHOLDER_NODE = '00000000-0000-4000-8000-000000000000';

function recorder() {
  const statements = [];
  const record = fallback => async (sql, params = []) => {
    statements.push({sql, params});
    return fallback;
  };
  return {statements, queryAll: record([]), queryOne: record(null), execute: record({rows: []})};
}

export async function renderHeartbeatClaimStatements() {
  const rendered = [];
  const add = (name, note, {sql, params}) => rendered.push({name, note, sql, params});
  const forNode = params => params.map(value => (value === PLACEHOLDER_NODE ? NODE : value));

  let tx = recorder();
  await findCaptureAgentExecutionSlotBlocker(tx, TENANT, PLACEHOLDER_NODE);
  add('slot_blocker', 'findCaptureAgentExecutionSlotBlocker', {
    sql: tx.statements[0].sql, params: forNode(tx.statements[0].params),
  });

  tx = recorder();
  await readStopFenceHeartbeatWork(tx, {
    tenantId: TENANT, agentId: NODE, includeNeedsActionChildren: true,
  });
  add('heartbeat_precheck', 'readStopFenceHeartbeatWork', tx.statements[0]);

  tx = recorder();
  await claimStopFenceCheckOffers(tx, {
    agent: {tenant_id: TENANT, id: PLACEHOLDER_NODE},
    lockAgentSession: async () => ({id: PLACEHOLDER_NODE}),
    includeNeedsActionChildren: true,
  });
  add('claim_implicit_release', 'claimStopFenceCheckOffers: rows the 976a0c6 rule released', {
    sql: tx.statements[0].sql, params: forNode(tx.statements[0].params),
  });
  add('claim_listing', 'claimStopFenceCheckOffers: six-row listing', {
    sql: tx.statements[1].sql, params: forNode(tx.statements[1].params),
  });

  tx = recorder();
  await listCaptureAgentStopFences(tx, TENANT, {includeLocalRelease: true});
  add('tenant_listing', 'task board and duty view', tx.statements[0]);

  tx = recorder();
  await listCaptureAgentStopFences(tx, TENANT, {agentId: PLACEHOLDER_NODE});
  add('node_listing', 'stop-fence recheck and confirm routes', {
    sql: tx.statements[0].sql, params: forNode(tx.statements[0].params),
  });

  const route = await readFile(path.join(repositoryRoot, 'server/routes/capture-cloud.js'), 'utf8');
  const inline = (marker, from) => {
    const start = route.indexOf(marker, from);
    if (start < 0) throw new Error(`route statement not found: ${marker}`);
    const open = route.indexOf('`', start);
    let sql = '';
    let index = open + 1;
    while (route[index] !== '`') {
      if (route.startsWith('${', index)) {
        const close = route.indexOf('}', index);
        const call = route.slice(index + 2, close)
          .match(/^captureTaskUnconfirmedLocalStopSql\('([a-z_]+)'(?:, '(\$[0-9]+)')?\)$/u);
        if (!call) throw new Error(`unsupported interpolation near ${marker}`);
        sql += captureTaskUnconfirmedLocalStopSql(call[1], call[2] || '$1');
        index = close + 1;
      } else {
        sql += route[index];
        index += 1;
      }
    }
    return sql;
  };
  add('terminal_notices', 'claimPriorityAgentControl', {
    sql: inline(
      'const terminalNotices = supportsTerminalNotices ? await tx.queryAll(',
      route.indexOf('async function claimPriorityAgentControl'),
    ),
    params: [TENANT, NODE],
  });
  add('heartbeat_commands', 'heartbeat command delivery', {
    sql: inline(
      'const commands = taskStateKnown ? await tx.queryAll(',
      route.indexOf("router.post('/agent/heartbeat'"),
    ),
    params: [NODE, TENANT, '{auth_code}', '{auth_binding}', '{allowed_platforms}',
      '{supported_platforms}', true, true, false],
  });
  add('create_route_queue_blocker', 'POST /agents/:id/tasks', {
    sql: inline('const queueBlocker = isPlanConfiguration ? null : await tx.queryOne('),
    params: [TENANT, NODE],
  });
  return rendered;
}

const ROW_LOCK = /\s+FOR UPDATE(?: OF [a-z_]+(?:\s*,\s*[a-z_]+)*)?(?: SKIP LOCKED| NOWAIT)?(?=\s|$)/gu;
const FORMAT_ARGUMENTS = {
  [TENANT]: '%1$L',
  [NODE]: '%2$L',
  '{auth_code}': '%3$L',
  '{auth_binding}': '%4$L',
  '{allowed_platforms}': '%5$L',
  '{supported_platforms}': '%6$L',
};

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return `'{${value.map(item => `"${String(item).replace(/["\\]/gu, '\\$&')}"`).join(',')}}'`;
  }
  return `'${String(value).replace(/'/gu, "''")}'`;
}

export function buildReadOnlyScript(statements, {nodes = nodeLimit} = {}) {
  const measured = `
    WITH per_node AS (
      SELECT task.tenant_id, COALESCE(task.assigned_agent_id, task.origin_agent_id) AS id,
        count(*) AS tasks,
        count(*) FILTER (WHERE UPPER(COALESCE(task.error->>'code', '')) =
          'PREVIOUS_CAPTURE_STOP_UNCONFIRMED') AS fence_rows
      FROM capture_tasks task
      WHERE COALESCE(task.assigned_agent_id, task.origin_agent_id) IS NOT NULL
      GROUP BY 1, 2
    ), ranked AS (
      SELECT per_node.*,
        row_number() OVER (ORDER BY tasks DESC, id) AS by_tasks,
        row_number() OVER (ORDER BY fence_rows DESC, tasks DESC, id) AS by_fence_rows
      FROM per_node
    )
    SELECT ranked.tenant_id, ranked.id, ranked.tasks, ranked.fence_rows,
      agent.auth_code_id, agent.auth_binding_id, agent.allowed_platforms,
      ARRAY(SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(agent.capabilities->'supportedPlatforms') = 'array'
          THEN agent.capabilities->'supportedPlatforms' ELSE '[]'::jsonb END)) AS supported
    FROM ranked JOIN capture_agents agent ON agent.id = ranked.id
    WHERE ranked.by_tasks <= ${nodes} OR (ranked.fence_rows > 0 AND ranked.by_fence_rows <= ${nodes})
    ORDER BY ranked.tasks DESC, ranked.id`;
  const lines = [
    '\\set ON_ERROR_STOP on',
    '\\pset pager off',
    'BEGIN READ ONLY;',
    "SET LOCAL statement_timeout = '20s';",
    "SET LOCAL lock_timeout = '1s';",
    'SET LOCAL plan_cache_mode = force_custom_plan;',
    'SELECT version();',
    `SELECT c.relname AS index, x.indisvalid AS valid, pg_size_pretty(pg_relation_size(c.oid)) AS size,
       s.idx_scan AS scans
     FROM pg_index x
     JOIN pg_class c ON c.oid = x.indexrelid
     JOIN pg_class t ON t.oid = x.indrelid
     LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
     WHERE t.relname IN ('capture_tasks', 'capture_agent_commands')
     ORDER BY t.relname, c.relname;`,
  ];
  for (const statement of statements) {
    lines.push(`PREPARE ${statement.name} AS ${statement.sql.replace(ROW_LOCK, '').trim()};`);
  }
  for (const statement of statements) {
    const perNode = statement.params.includes(NODE);
    const call = `EXPLAIN (ANALYZE, BUFFERS) EXECUTE ${statement.name}(${
      statement.params.map(value => FORMAT_ARGUMENTS[value] || literal(value).replace(/%/gu, '%%')).join(', ')
    })`.replace(/'/gu, "''");
    const label = perNode
      ? `'${statement.name} node ' || id || ' tasks=' || tasks || ' fence_rows=' || fence_rows`
      : `'${statement.name} tenant ' || tenant_id`;
    const source = perNode
      ? `(${measured}) nodes`
      : '(SELECT tenant_id FROM capture_tasks GROUP BY 1 ORDER BY count(*) DESC LIMIT 2) tenants';
    const values = perNode
      ? 'tenant_id, id, auth_code_id, auth_binding_id, allowed_platforms::text, supported::text'
      : 'tenant_id';
    // One statement per cell: psql prints only the last result of a cell.
    // The second run of each statement is the one to read.
    lines.push(
      `\\echo '--- ${statement.name}: ${statement.note.replace(/'/gu, '')}'`,
      `SELECT format('SELECT %L AS measured', ${label}),`,
      `  format('${call}', ${values}),`,
      `  format('${call}', ${values})`,
      `FROM ${source} \\gexec`,
    );
  }
  lines.push('ROLLBACK;');
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(buildReadOnlyScript(await renderHeartbeatClaimStatements()));
}
