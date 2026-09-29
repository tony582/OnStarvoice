import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
  captureTaskUnconfirmedLocalStopSql,
  findCaptureAgentExecutionSlotBlocker,
} from '../server/services/capture-cloud.js';
import {
  listCaptureAgentStopFences,
  readStopFenceHeartbeatWork,
} from '../server/services/capture-stop-fence.js';
import {
  buildReadOnlyScript,
  renderHeartbeatClaimStatements,
} from '../scripts/diagnostics/heartbeat-claim-explain.mjs';

// docs/hotfix/20260929-heartbeat-claim-load.md: migration 091 only adds
// partial indexes. PostgreSQL uses a partial index when it can prove the
// index predicate from the statement, which it does by matching expressions.
// These tests keep the two texts identical: whoever edits a statement or the
// migration sees here which index stops serving it.

const migrationUrl = new URL('../server/db/migrations/091_capture_heartbeat_indexes.sql', import.meta.url);
const routeUrl = new URL('../server/routes/capture-cloud.js', import.meta.url);

// Whitespace never matters to the parser; compare texts without it.
const collapse = value => String(value)
  .replace(/\s+/gu, ' ')
  .replace(/\( /gu, '(')
  .replace(/ \)/gu, ')')
  .trim();
const withoutAlias = (sql, alias) => collapse(sql).split(`${alias}.`).join('');

function parseIndexes(source) {
  const statements = source
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(collapse)
    .filter(Boolean);
  return statements.map(statement => {
    const match = statement.match(
      /^CREATE INDEX IF NOT EXISTS (\w+) ON (\w+) \((.+?)\)(?: INCLUDE \((.+?)\))? WHERE (.+)$/u,
    );
    assert.ok(match, `only partial CREATE INDEX IF NOT EXISTS statements: ${statement.slice(0, 80)}`);
    const [, name, table, keys, include = '', predicate] = match;
    return {name, table, keys, include, predicate};
  });
}

// Top-level AND clauses of a predicate (parentheses and quotes respected).
function clauses(predicate) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  const text = collapse(predicate);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") quoted = !quoted;
    if (!quoted && char === '(') depth += 1;
    if (!quoted && char === ')') depth -= 1;
    if (!quoted && depth === 0 && text.startsWith(' AND ', index)) {
      parts.push(current.trim());
      current = '';
      index += 4;
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.map(part => (
    part.startsWith('(') && part.endsWith(')') ? part.slice(1, -1).trim() : part
  ));
}

function recorder() {
  const statements = [];
  const record = fallback => async (sql, params = []) => {
    statements.push({sql, params});
    return fallback;
  };
  return {statements, queryAll: record([]), queryOne: record(null)};
}

function routeStatement(source, marker, from = 0) {
  const start = source.indexOf(marker, from);
  assert.ok(start >= 0, `route statement not found: ${marker}`);
  const open = source.indexOf('`', start);
  return source.slice(open + 1, source.indexOf('`', open + 1));
}

const indexes = parseIndexes(await readFile(migrationUrl, 'utf8'));
const byName = Object.fromEntries(indexes.map(index => [index.name, index]));
const AGENT = '55555555-5555-4555-8555-555555555555';

test('migration 091 is additive and runs inside the migration transaction', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.deepEqual(indexes.map(index => index.name), [
    'idx_capture_tasks_stop_fence_unconfirmed',
    'idx_capture_tasks_stop_fence_local_release',
    'idx_capture_tasks_agent_slot_blocking',
    'idx_capture_tasks_terminal_notice',
    'idx_capture_tasks_settled_run_proof',
    'idx_capture_agent_commands_accepted_stop',
  ]);
  const sql = source.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  // migrate.js wraps every file in BEGIN/COMMIT: CONCURRENTLY would fail there.
  assert.doesNotMatch(sql, /CONCURRENTLY/u);
  assert.doesNotMatch(sql, /\b(?:DROP|ALTER|UPDATE|DELETE|INSERT|TRUNCATE|UNIQUE)\b/u);
  assert.deepEqual(
    [...new Set(indexes.map(index => index.table))].sort(),
    ['capture_agent_commands', 'capture_tasks'],
  );
});

test('the scans of the admission fence SQL match the index predicates', () => {
  const fence = captureTaskUnconfirmedLocalStopSql('task');
  const open = byName.idx_capture_tasks_stop_fence_unconfirmed;
  assert.deepEqual(clauses(open.predicate), [
    "UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'",
  ]);
  // The outer row and the historical_stop scan carry the same condition.
  assert.ok(withoutAlias(fence, 'task').includes(open.predicate));
  assert.ok(withoutAlias(fence, 'historical_stop').includes(open.predicate));
  assert.ok(withoutAlias(fence, 'historical_stop').includes("status = 'superseded'"));
  assert.equal(
    open.keys,
    'tenant_id, (COALESCE(assigned_agent_id, origin_agent_id)), status',
  );

  const proof = byName.idx_capture_tasks_settled_run_proof;
  const settledRuns = withoutAlias(
    fence.slice(fence.indexOf('settled_runs AS MATERIALIZED'), fence.indexOf('SELECT historical_stop.id')),
    'stop_proof',
  );
  const proofClauses = clauses(proof.predicate);
  assert.equal(proofClauses.length, 5);
  for (const clause of proofClauses) {
    assert.ok(settledRuns.includes(clause), `settled_runs no longer contains: ${clause}`);
  }
  // Every column the aggregation reads comes from the index, so the scan can
  // be index-only: `metadata` and `error` appear in the predicate alone.
  const provided = `${proof.keys}, ${proof.include}`.split(',').map(column => column.trim());
  const read = new Set(
    [...settledRuns.matchAll(/\b(tenant_id|assigned_agent_id|origin_agent_id|platform|created_at|started_at|finished_at|status|id|task_type|metadata|error)\b/gu)]
      .map(match => match[1]),
  );
  const predicateOnly = ['task_type', 'finished_at', 'metadata', 'error'];
  for (const column of read) {
    if (predicateOnly.includes(column)) continue;
    assert.ok(provided.includes(column), `settled_runs reads ${column}, which the index does not provide`);
  }
  for (const column of predicateOnly) {
    const outside = proofClauses.reduce((text, clause) => text.split(clause).join(''), settledRuns);
    assert.doesNotMatch(
      outside.slice(outside.indexOf('WHERE tenant_id'), outside.indexOf('GROUP BY')),
      new RegExp(`\\b${column}\\b`, 'u'),
      `${column} is read outside the index predicate`,
    );
  }

  const receipts = byName.idx_capture_agent_commands_accepted_stop;
  const confirmedStops = collapse(
    fence.slice(fence.indexOf('confirmed_stops AS MATERIALIZED'), fence.indexOf('settled_runs AS MATERIALIZED')),
  );
  for (const clause of clauses(receipts.predicate)) {
    assert.ok(confirmedStops.includes(clause), `confirmed_stops no longer contains: ${clause}`);
  }
  assert.equal(receipts.keys, 'tenant_id, task_id, agent_id, finished_at');
});

test('the execution slot blocker can combine the slot and the fence index', async () => {
  const tx = recorder();
  await findCaptureAgentExecutionSlotBlocker(tx, 'tenant-1', AGENT);
  const [{sql, params}] = tx.statements;
  const slot = byName.idx_capture_tasks_agent_slot_blocking;
  const statuses = [...slot.predicate.matchAll(/'([a-z_]+)'/gu)].map(match => match[1]);
  assert.deepEqual(statuses, [...CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES]);
  assert.deepEqual(params[2], CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES);
  assert.equal(slot.keys, byName.idx_capture_tasks_stop_fence_unconfirmed.keys);
  const statement = collapse(sql);
  // Both arms of the OR sit under the same tenant and node conditions, which
  // are the leading index columns of both indexes.
  assert.ok(statement.includes(
    'WHERE task.tenant_id = $1 AND COALESCE(task.assigned_agent_id, task.origin_agent_id) = $2',
  ));
  assert.ok(statement.includes(
    `(task.status = ANY($3::text[]) AND NOT (task.id = ANY($4::uuid[]))) OR ${collapse(captureTaskUnconfirmedLocalStopSql('task'))}`,
  ));
});

test('the heartbeat precheck and the fence listing match the fence and local-release indexes', async () => {
  const open = byName.idx_capture_tasks_stop_fence_unconfirmed;
  const release = byName.idx_capture_tasks_stop_fence_local_release;
  const releaseClauses = clauses(release.predicate);
  assert.deepEqual(releaseClauses, [
    "UPPER(COALESCE(error->>'code', '')) = 'HISTORICAL_STOP_FENCE_RECONCILED'",
    "metadata #>> '{stopFenceCheck,localRelease,state}' = 'pending'",
  ]);

  const precheck = recorder();
  await readStopFenceHeartbeatWork(precheck, {tenantId: 'tenant-1', agentId: AGENT});
  const precheckSql = collapse(precheck.statements[0].sql);
  const bare = precheckSql.split('fenced_child.').join('').split('released.').join('');
  assert.equal(bare.split(open.predicate).length - 1, 2, 'superseded rows and needs_action children');
  // local_release_pending and the two "latest release" rows.
  for (const clause of releaseClauses) {
    assert.equal(bare.split(clause).length - 1, 3, clause);
  }

  const listing = recorder();
  await listCaptureAgentStopFences(listing, 'tenant-1', {agentId: AGENT, includeLocalRelease: true});
  const listingSql = collapse(listing.statements[0].sql);
  assert.ok(withoutAlias(listingSql, 'task').includes(`AND ${open.predicate}`));
  for (const clause of releaseClauses) {
    assert.ok(withoutAlias(listingSql, 'released').includes(`AND ${clause}`), clause);
  }
  assert.ok(listingSql.includes(collapse(captureTaskUnconfirmedLocalStopSql('task'))));
});

test('the terminal notice statement matches its index expression and predicate', async () => {
  const route = await readFile(routeUrl, 'utf8');
  const notices = withoutAlias(routeStatement(
    route,
    'const terminalNotices = supportsTerminalNotices ? await tx.queryAll(',
    route.indexOf('async function claimPriorityAgentControl'),
  ), 'task');
  const notice = byName.idx_capture_tasks_terminal_notice;
  for (const clause of clauses(notice.predicate)) {
    assert.ok(notices.includes(clause), `terminal notices no longer contain: ${clause}`);
  }
  const latest = "GREATEST(COALESCE(finished_at, '-infinity'::timestamptz), " +
    "COALESCE(updated_at, '-infinity'::timestamptz))";
  assert.equal(notice.keys, `tenant_id, assigned_agent_id, (${latest}), id`);
  assert.ok(notices.includes(`WHERE tenant_id = $1 AND assigned_agent_id = $2 AND task_type IN`));
  assert.ok(notices.includes(`AND ${latest} >= now() - interval '7 days'`));
  assert.ok(notices.includes(`ORDER BY ${latest} ASC, id LIMIT 50`));
});

test('the measurement script only reads', async () => {
  const statements = await renderHeartbeatClaimStatements();
  assert.deepEqual(statements.map(statement => statement.name), [
    'slot_blocker', 'heartbeat_precheck', 'claim_implicit_release', 'claim_listing',
    'tenant_listing', 'node_listing', 'terminal_notices', 'heartbeat_commands',
    'create_route_queue_blocker',
  ]);
  // The statements are the server's own text, not a copy that can drift.
  const blocker = recorder();
  await findCaptureAgentExecutionSlotBlocker(blocker, 'tenant-1', AGENT);
  assert.equal(statements[0].sql, blocker.statements[0].sql);
  const fenced = statements.filter(statement =>
    statement.sql.includes(captureTaskUnconfirmedLocalStopSql('task')) ||
    statement.sql.includes(captureTaskUnconfirmedLocalStopSql('unsafe_stop', '$2')));
  assert.equal(fenced.length, 7, 'every statement that embeds the admission fence');

  const script = buildReadOnlyScript(statements, {nodes: 3});
  const lines = script.split('\n');
  assert.equal(lines.indexOf('BEGIN READ ONLY;'), 2);
  assert.equal(lines.at(-2), 'ROLLBACK;');
  assert.ok(script.includes('SET LOCAL plan_cache_mode = force_custom_plan;'));
  assert.doesNotMatch(script, /FOR UPDATE|FOR SHARE|NOWAIT/u);
  // A statement starts after `;`, after \gexec or after a psql command.
  const starts = new Set();
  let boundary = true;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('\\')) {
      boundary = true;
      continue;
    }
    if (boundary) starts.add(line.trimStart().split(/\s+/u)[0].replace(/;$/u, ''));
    boundary = /;\s*$/u.test(line) || /\\gexec\s*$/u.test(line);
  }
  assert.deepEqual([...starts].sort(), ['BEGIN', 'PREPARE', 'ROLLBACK', 'SELECT', 'SET'].sort());
  for (const prepared of script.match(/^PREPARE \w+ AS \w+/gmu)) {
    assert.match(prepared, /AS (?:SELECT|WITH)$/u);
  }
});
