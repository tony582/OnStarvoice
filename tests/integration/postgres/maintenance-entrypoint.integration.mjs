import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import {
  assertGuarded,
  assertNoAdvisoryLocks,
  createGuardedChildEnvironment,
  safeIdentifier,
  spawnGuardedNode,
  stopChild,
  terminateApplications,
  waitForChildExit,
} from './p2d-test-helpers.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const maintenanceEntrypoint = path.join(repositoryRoot, 'server', 'entrypoints', 'maintenance.js');
const guardPath = path.join(repositoryRoot, 'tests', 'fixtures', 'process-role-entrypoint-guard.mjs');
const publishTimestampTask = 'publish-ts-backfill-v1';
const commentsWorkflowBackfillTask = 'comments-workflow-backfill';

function assertRejectedBeforeDatabase(runtime, secret) {
  const output = runtime.output();
  assert.notEqual(runtime.child.exitCode, 0, output);
  assertGuarded(runtime);
  assert.doesNotMatch(
    output,
    /PostgreSQL initialized|Applying migration|migration lock/iu,
    output,
  );
  assert.doesNotMatch(output, new RegExp(secret, 'u'), output);
}

test('maintenance CLI validates before PostgreSQL and is the explicit migration/task owner', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const { closePool, getPool } = await import('../../../server/db/pool.js');
  const pool = getPool();
  const runId = randomUUID().replaceAll('-', '');
  const schema = `p2d_maintenance_${runId}`;
  const runtimes = new Set();
  const applicationNames = new Set();
  const observedBackendPids = new Set();

  const spawnMaintenance = ({
    args,
    suffix,
    databaseUrl = target.rawUrl,
    role = 'maintenance',
    includeTestDatabaseUrl = true,
    extra = {},
  }) => {
    const applicationName = `p2d-maintenance-${runId}-${suffix}`;
    applicationNames.add(applicationName);
    const runtime = spawnGuardedNode({
      guardPath,
      scriptPath: maintenanceEntrypoint,
      args,
      cwd: repositoryRoot,
      env: createGuardedChildEnvironment({
        databaseUrl,
        schema,
        applicationName,
        role,
        includeTestDatabaseUrl,
        extra,
      }),
      label: `maintenance-${suffix}`,
    });
    if (args[0] === 'run' && args[1]) {
      applicationNames.add(`onstarvoice:maintenance-task:${args[1]}:${runtime.child.pid}`);
    }
    if (extra.MAINTENANCE_OFFLINE_CONFIRMED === '1') {
      applicationNames.add(`onstarvoice:maintenance-offline:${runtime.child.pid}`);
    }
    runtimes.add(runtime);
    return runtime;
  };

  t.after(async () => {
    const errors = [];
    for (const runtime of runtimes) {
      try { await stopChild(runtime); } catch (error) { errors.push(error); }
      try { assertGuarded(runtime); } catch (error) { errors.push(error); }
    }
    try {
      const terminated = await terminateApplications(pool, [...applicationNames]);
      for (const pid of terminated) observedBackendPids.add(pid);
      await assertNoAdvisoryLocks(pool, [...observedBackendPids]);
    } catch (error) {
      errors.push(error);
    }
    try { await pool.query(`DROP SCHEMA IF EXISTS ${safeIdentifier(schema)} CASCADE`); } catch (error) {
      errors.push(error);
    }
    try {
      const remaining = await pool.query('SELECT to_regnamespace($1) AS namespace', [schema]);
      assert.equal(remaining.rows[0].namespace, null, 'maintenance schema was not removed');
    } catch (error) {
      errors.push(error);
    }
    try { await closePool(); } catch (error) { errors.push(error); }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'P2-D maintenance-entrypoint cleanup failed');
    }
  });

  await pool.query(`CREATE SCHEMA ${safeIdentifier(schema)}`);

  await t.test('usage, unknown command/task, invalid flags, and wrong role fail before database access', async () => {
    const secret = `p2d-secret-${runId}`;
    const unreachable = `postgresql://p2d:${secret}@192.0.2.1/onstarvoice`;
    const help = spawnMaintenance({
      suffix: 'help',
      args: [],
      databaseUrl: unreachable,
      includeTestDatabaseUrl: false,
    });
    assert.deepEqual(
      await waitForChildExit(help, 5000),
      { code: 0, signal: null },
      help.output(),
    );
    assertGuarded(help);
    assert.match(help.output(), /Usage:/u);
    assert.doesNotMatch(
      help.output(),
      /PostgreSQL initialized|Applying migration|migration lock/iu,
    );
    assert.doesNotMatch(help.output(), new RegExp(secret, 'u'));

    const invalidCases = [
      { suffix: 'unknown-command', args: ['unknown-command'] },
      { suffix: 'unknown-task', args: ['run', 'not-a-maintenance-task'] },
      { suffix: 'missing-task', args: ['run'] },
      { suffix: 'invalid-flag', args: ['migrate', '--not-a-real-option'] },
      {
        suffix: 'offline-confirmation-required',
        args: ['run', publishTimestampTask],
        expected: /MAINTENANCE_OFFLINE_CONFIRMATION_REQUIRED/u,
      },
      { suffix: 'wrong-role', args: ['verify'], role: 'api' },
      { suffix: 'combined-role', args: ['verify'], role: 'maintenance,api' },
    ];

    for (const invalidCase of invalidCases) {
      const runtime = spawnMaintenance({
        ...invalidCase,
        databaseUrl: unreachable,
        includeTestDatabaseUrl: false,
      });
      const exit = await waitForChildExit(runtime, 5000);
      assert.equal(exit.signal, null, runtime.output());
      assertRejectedBeforeDatabase(runtime, secret);
      if (invalidCase.expected) assert.match(runtime.output(), invalidCase.expected);
    }
  });

  await t.test('migrate and verify are finite, guarded, checksum-complete, and reset-free', async () => {
    const migrate = spawnMaintenance({ args: ['migrate'], suffix: 'migrate' });
    assert.deepEqual(
      await waitForChildExit(migrate, 20_000),
      { code: 0, signal: null },
      migrate.output(),
    );
    assertGuarded(migrate);
    assert.doesNotMatch(
      migrate.output(),
      /\[Cron\]|HTTP listener|Backend Server|\[CommentRefine\]|\[MediaBackfill\]/u,
      migrate.output(),
    );

    const appliedBeforeVerify = await pool.query(`
      SELECT version, applied_at, checksum_sha256, checksum_recorded_at
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version LIKE '%.sql'
      ORDER BY version
    `);
    assert.ok(appliedBeforeVerify.rowCount > 0);
    assert.equal(
      appliedBeforeVerify.rows.every(row => (
        !/reset/iu.test(row.version)
        && /^[a-f0-9]{64}$/u.test(row.checksum_sha256)
        && row.checksum_recorded_at instanceof Date
      )),
      true,
    );
    const resetRows = await pool.query(`
      SELECT version
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version LIKE '%.sql' AND version ~* 'reset'
    `);
    assert.equal(resetRows.rowCount, 0);
    const runsBeforeExplicitTask = await pool.query(`
      SELECT count(*)::integer AS count
      FROM ${safeIdentifier(schema)}.maintenance_runs
    `);
    assert.equal(runsBeforeExplicitTask.rows[0].count, 0, 'migrate must not auto-run maintenance tasks');

    const verify = spawnMaintenance({ args: ['verify'], suffix: 'verify' });
    assert.deepEqual(
      await waitForChildExit(verify, 15_000),
      { code: 0, signal: null },
      verify.output(),
    );
    assertGuarded(verify);
    assert.doesNotMatch(verify.output(), /\[Cron\]|HTTP listener|Backend Server/u, verify.output());

    const appliedAfterVerify = await pool.query(`
      SELECT version, applied_at, checksum_sha256, checksum_recorded_at
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version LIKE '%.sql'
      ORDER BY version
    `);
    assert.deepEqual(appliedAfterVerify.rows, appliedBeforeVerify.rows, 'verify must be read-only');
  });

  await t.test('repeatable comment backfill preserves existing observation facts while inserting missing comments', async () => {
    const tenant = await pool.query(`
      INSERT INTO ${safeIdentifier(schema)}.tenants (name)
      VALUES ($1)
      RETURNING id
    `, [`P2-D comment backfill ${runId}`]);
    const tenantId = tenant.rows[0].id;
    const firstComment = {
      commentId: `p2d-comment-existing-${runId}`,
      authorName: '历史评论用户',
      authorId: `p2d-author-existing-${runId}`,
      content: '刹车失效，已经影响行车安全',
      likes: 3,
      publishedAt: '2026-08-01 10:00:00',
    };
    const record = await pool.query(`
      INSERT INTO ${safeIdentifier(schema)}.records (
        tenant_id, external_id, platform, title, content, author_name, payload
      ) VALUES ($1, $2, 'weibo', $3, $4, $5, $6::jsonb)
      RETURNING id
    `, [
      tenantId,
      `p2d-record-${runId}`,
      'P2-D 历史评论回填',
      '用于验证可重复维护任务不会刷新既有评论观测事实',
      '测试作者',
      JSON.stringify({ commentsCleanedItems: [firstComment] }),
    ]);
    const recordId = record.rows[0].id;

    const runBackfill = async suffix => {
      const runtime = spawnMaintenance({
        args: ['run', commentsWorkflowBackfillTask],
        suffix,
        extra: { MAINTENANCE_OFFLINE_CONFIRMED: '1' },
      });
      assert.deepEqual(
        await waitForChildExit(runtime, 15_000),
        { code: 0, signal: null },
        runtime.output(),
      );
      assertGuarded(runtime);
    };

    await runBackfill('comments-backfill-first');
    const initialComment = await pool.query(`
      SELECT id, external_comment_id, last_seen_at, seen_count
      FROM ${safeIdentifier(schema)}.record_comments
      WHERE tenant_id = $1 AND record_id = $2
    `, [tenantId, recordId]);
    assert.equal(initialComment.rowCount, 1);
    assert.equal(initialComment.rows[0].external_comment_id, firstComment.commentId);
    assert.equal(initialComment.rows[0].seen_count, 1);
    const initialRecord = await pool.query(`
      SELECT latest_negative_comment_at, updated_at
      FROM ${safeIdentifier(schema)}.records
      WHERE id = $1 AND tenant_id = $2
    `, [recordId, tenantId]);
    assert.ok(initialRecord.rows[0].latest_negative_comment_at instanceof Date);

    await new Promise(resolve => setTimeout(resolve, 25));
    await runBackfill('comments-backfill-repeat');
    const repeatedComment = await pool.query(`
      SELECT id, last_seen_at, seen_count
      FROM ${safeIdentifier(schema)}.record_comments
      WHERE tenant_id = $1 AND record_id = $2 AND external_comment_id = $3
    `, [tenantId, recordId, firstComment.commentId]);
    const repeatedRecord = await pool.query(`
      SELECT latest_negative_comment_at, updated_at
      FROM ${safeIdentifier(schema)}.records
      WHERE id = $1 AND tenant_id = $2
    `, [recordId, tenantId]);
    assert.equal(repeatedComment.rows[0].id, initialComment.rows[0].id);
    assert.equal(repeatedComment.rows[0].seen_count, initialComment.rows[0].seen_count);
    assert.equal(
      repeatedComment.rows[0].last_seen_at.getTime(),
      initialComment.rows[0].last_seen_at.getTime(),
    );
    assert.equal(
      repeatedRecord.rows[0].latest_negative_comment_at.getTime(),
      initialRecord.rows[0].latest_negative_comment_at.getTime(),
    );
    assert.equal(
      repeatedRecord.rows[0].updated_at.getTime(),
      initialRecord.rows[0].updated_at.getTime(),
      'a no-op repeat must not make the record look newly captured',
    );

    const missingComment = {
      commentId: `p2d-comment-missing-${runId}`,
      authorName: '新增评论用户',
      authorId: `p2d-author-missing-${runId}`,
      content: '这是一条后补的普通评论',
      likes: 1,
      publishedAt: '2026-08-02 11:00:00',
    };
    await pool.query(`
      UPDATE ${safeIdentifier(schema)}.records
      SET payload = $1::jsonb
      WHERE id = $2 AND tenant_id = $3
    `, [JSON.stringify({ commentsCleanedItems: [firstComment, missingComment] }), recordId, tenantId]);
    await runBackfill('comments-backfill-missing');
    const finalComments = await pool.query(`
      SELECT external_comment_id, last_seen_at, seen_count
      FROM ${safeIdentifier(schema)}.record_comments
      WHERE tenant_id = $1 AND record_id = $2
      ORDER BY external_comment_id
    `, [tenantId, recordId]);
    assert.equal(finalComments.rowCount, 2, 'a missing comment must still be inserted');
    const preserved = finalComments.rows.find(row => row.external_comment_id === firstComment.commentId);
    const inserted = finalComments.rows.find(row => row.external_comment_id === missingComment.commentId);
    assert.ok(preserved);
    assert.ok(inserted);
    assert.equal(preserved.seen_count, 1);
    assert.equal(preserved.last_seen_at.getTime(), initialComment.rows[0].last_seen_at.getTime());
    assert.equal(inserted.seen_count, 1);

    const officialComment = {
      commentId: `p2d-comment-official-${runId}`,
      authorName: '安吉星官方客服',
      authorId: `p2d-official-author-${runId}`,
      content: '官方回复：事故情况已经核实并处理中',
      likes: 2,
      publishedAt: '2026-08-03 12:00:00',
    };
    const officialRecord = await pool.query(`
      INSERT INTO ${safeIdentifier(schema)}.records (
        tenant_id, external_id, platform, title, content, author_name, author_id, payload
      ) VALUES ($1, $2, 'weibo', $3, $4, $5, $6, $7::jsonb)
      RETURNING id
    `, [
      tenantId,
      `p2d-official-record-${runId}`,
      'P2-D 官方评论身份回填',
      '用于验证后补的官方强身份会纠正旧评论，但不伪造新采集',
      '普通发布者',
      `p2d-unrelated-record-author-${runId}`,
      JSON.stringify({ officialReplyItems: [officialComment] }),
    ]);
    const officialRecordId = officialRecord.rows[0].id;

    await runBackfill('comments-backfill-official-before-account');
    const beforeOfficialIdentity = await pool.query(`
      SELECT id, first_seen_at, last_seen_at, seen_count, updated_at, payload,
        is_official, is_negative, sentiment, category, risk_level, ai_classified_at
      FROM ${safeIdentifier(schema)}.record_comments
      WHERE tenant_id = $1 AND record_id = $2 AND external_comment_id = $3
    `, [tenantId, officialRecordId, officialComment.commentId]);
    assert.equal(beforeOfficialIdentity.rowCount, 1);
    assert.equal(beforeOfficialIdentity.rows[0].is_official, false);
    assert.equal(beforeOfficialIdentity.rows[0].is_negative, true);
    assert.equal(beforeOfficialIdentity.rows[0].ai_classified_at, null);
    const responsesBeforeIdentity = await pool.query(`
      SELECT count(*)::integer AS count
      FROM ${safeIdentifier(schema)}.official_responses
      WHERE tenant_id = $1 AND record_id = $2
    `, [tenantId, officialRecordId]);
    assert.equal(responsesBeforeIdentity.rows[0].count, 0);

    const account = await pool.query(`
      INSERT INTO ${safeIdentifier(schema)}.official_accounts (
        tenant_id, platform, account_name, platform_user_id, aliases
      ) VALUES ($1, 'weibo', $2, $3, $4::jsonb)
      RETURNING id
    `, [
      tenantId,
      officialComment.authorName,
      officialComment.authorId,
      JSON.stringify([officialComment.authorName]),
    ]);
    const officialAccountId = account.rows[0].id;

    await new Promise(resolve => setTimeout(resolve, 25));
    await runBackfill('comments-backfill-official-identity-repair');
    const repairedOfficialComment = await pool.query(`
      SELECT id, first_seen_at, last_seen_at, seen_count, updated_at, payload,
        author_name, author_id, is_official, is_negative, sentiment, category,
        risk_level, ai_classified_at
      FROM ${safeIdentifier(schema)}.record_comments
      WHERE tenant_id = $1 AND record_id = $2 AND external_comment_id = $3
    `, [tenantId, officialRecordId, officialComment.commentId]);
    assert.equal(repairedOfficialComment.rowCount, 1);
    assert.equal(repairedOfficialComment.rows[0].id, beforeOfficialIdentity.rows[0].id);
    assert.equal(
      repairedOfficialComment.rows[0].first_seen_at.getTime(),
      beforeOfficialIdentity.rows[0].first_seen_at.getTime(),
    );
    assert.equal(
      repairedOfficialComment.rows[0].last_seen_at.getTime(),
      beforeOfficialIdentity.rows[0].last_seen_at.getTime(),
    );
    assert.equal(repairedOfficialComment.rows[0].seen_count, beforeOfficialIdentity.rows[0].seen_count);
    assert.deepEqual(repairedOfficialComment.rows[0].payload, beforeOfficialIdentity.rows[0].payload);
    assert.ok(
      repairedOfficialComment.rows[0].updated_at.getTime()
        > beforeOfficialIdentity.rows[0].updated_at.getTime(),
    );
    assert.equal(repairedOfficialComment.rows[0].author_name, officialComment.authorName);
    assert.equal(repairedOfficialComment.rows[0].author_id, officialComment.authorId);
    assert.equal(repairedOfficialComment.rows[0].is_official, true);
    assert.equal(repairedOfficialComment.rows[0].is_negative, false);
    assert.equal(repairedOfficialComment.rows[0].sentiment, 'neutral');
    assert.equal(repairedOfficialComment.rows[0].category, 'official_response');
    assert.equal(repairedOfficialComment.rows[0].risk_level, 'none');
    assert.ok(repairedOfficialComment.rows[0].ai_classified_at instanceof Date);

    const repairedOfficialResponse = await pool.query(`
      SELECT id, comment_id, official_account_id, account_name, account_id, created_at
      FROM ${safeIdentifier(schema)}.official_responses
      WHERE tenant_id = $1 AND record_id = $2
    `, [tenantId, officialRecordId]);
    assert.equal(repairedOfficialResponse.rowCount, 1, 'the missing official response must be inserted once');
    assert.equal(repairedOfficialResponse.rows[0].comment_id, repairedOfficialComment.rows[0].id);
    assert.equal(repairedOfficialResponse.rows[0].official_account_id, officialAccountId);
    assert.equal(repairedOfficialResponse.rows[0].account_name, officialComment.authorName);
    assert.equal(repairedOfficialResponse.rows[0].account_id, officialComment.authorId);

    const repairedOfficialRecord = await pool.query(`
      SELECT official_replied, official_response_status, negative_comment_count,
        latest_negative_comment_at, updated_at
      FROM ${safeIdentifier(schema)}.records
      WHERE id = $1 AND tenant_id = $2
    `, [officialRecordId, tenantId]);
    assert.equal(repairedOfficialRecord.rows[0].official_replied, true);
    assert.equal(repairedOfficialRecord.rows[0].official_response_status, 'responded');
    assert.equal(repairedOfficialRecord.rows[0].negative_comment_count, 0);
    assert.equal(repairedOfficialRecord.rows[0].latest_negative_comment_at, null);
    const repairRun = await pool.query(`
      SELECT result_summary
      FROM ${safeIdentifier(schema)}.maintenance_runs
      WHERE task_id = $1 AND status = 'succeeded'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `, [commentsWorkflowBackfillTask]);
    assert.equal(Number(repairRun.rows[0].result_summary.officialResponses), 1);

    await new Promise(resolve => setTimeout(resolve, 25));
    await runBackfill('comments-backfill-official-identity-repeat');
    const repeatedOfficialComment = await pool.query(`
      SELECT id, first_seen_at, last_seen_at, seen_count, updated_at, payload
      FROM ${safeIdentifier(schema)}.record_comments
      WHERE tenant_id = $1 AND record_id = $2 AND external_comment_id = $3
    `, [tenantId, officialRecordId, officialComment.commentId]);
    const repeatedOfficialResponses = await pool.query(`
      SELECT id, created_at
      FROM ${safeIdentifier(schema)}.official_responses
      WHERE tenant_id = $1 AND record_id = $2
    `, [tenantId, officialRecordId]);
    const repeatedOfficialRecord = await pool.query(`
      SELECT official_replied, official_response_status, negative_comment_count,
        latest_negative_comment_at, updated_at
      FROM ${safeIdentifier(schema)}.records
      WHERE id = $1 AND tenant_id = $2
    `, [officialRecordId, tenantId]);
    assert.equal(repeatedOfficialComment.rows[0].id, repairedOfficialComment.rows[0].id);
    assert.equal(
      repeatedOfficialComment.rows[0].first_seen_at.getTime(),
      repairedOfficialComment.rows[0].first_seen_at.getTime(),
    );
    assert.equal(
      repeatedOfficialComment.rows[0].last_seen_at.getTime(),
      repairedOfficialComment.rows[0].last_seen_at.getTime(),
    );
    assert.equal(repeatedOfficialComment.rows[0].seen_count, repairedOfficialComment.rows[0].seen_count);
    assert.equal(
      repeatedOfficialComment.rows[0].updated_at.getTime(),
      repairedOfficialComment.rows[0].updated_at.getTime(),
    );
    assert.deepEqual(repeatedOfficialComment.rows[0].payload, repairedOfficialComment.rows[0].payload);
    assert.equal(repeatedOfficialResponses.rowCount, 1, 'the repeat must not duplicate official responses');
    assert.equal(repeatedOfficialResponses.rows[0].id, repairedOfficialResponse.rows[0].id);
    assert.equal(
      repeatedOfficialResponses.rows[0].created_at.getTime(),
      repairedOfficialResponse.rows[0].created_at.getTime(),
    );
    assert.equal(repeatedOfficialRecord.rows[0].official_replied, true);
    assert.equal(repeatedOfficialRecord.rows[0].official_response_status, 'responded');
    assert.equal(repeatedOfficialRecord.rows[0].negative_comment_count, 0);
    assert.equal(repeatedOfficialRecord.rows[0].latest_negative_comment_at, null);
    assert.equal(
      repeatedOfficialRecord.rows[0].updated_at.getTime(),
      repairedOfficialRecord.rows[0].updated_at.getTime(),
      'an identity-repair no-op repeat must leave the record timestamp unchanged',
    );
    const repeatRun = await pool.query(`
      SELECT result_summary
      FROM ${safeIdentifier(schema)}.maintenance_runs
      WHERE task_id = $1 AND status = 'succeeded'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `, [commentsWorkflowBackfillTask]);
    assert.equal(
      Number(repeatRun.rows[0].result_summary.officialResponses),
      0,
      'officialResponses must count newly inserted response rows, not recognized comments',
    );
  });

  await t.test('a named one-shot records one completion outside schema_migrations', async () => {
    const checksumTarget = '067_maintenance_runs.sql';
    const checksumBeforeTamper = await pool.query(`
      SELECT checksum_sha256, checksum_recorded_at
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version = $1
    `, [checksumTarget]);
    assert.equal(checksumBeforeTamper.rowCount, 1);
    await pool.query(`
      UPDATE ${safeIdentifier(schema)}.schema_migrations
      SET checksum_sha256 = repeat('0', 64)
      WHERE version = $1
    `, [checksumTarget]);
    const rejectedByChecksum = spawnMaintenance({
      args: ['run', publishTimestampTask],
      suffix: 'task-checksum-rejected',
      extra: { MAINTENANCE_OFFLINE_CONFIRMED: '1' },
    });
    assert.deepEqual(
      await waitForChildExit(rejectedByChecksum, 15_000),
      { code: 1, signal: null },
      rejectedByChecksum.output(),
    );
    assertGuarded(rejectedByChecksum);
    assert.match(
      rejectedByChecksum.output(),
      /DATABASE_MIGRATION_CHECKSUM_MISMATCH/u,
    );
    const runsAfterRejectedChecksum = await pool.query(`
      SELECT count(*)::integer AS count
      FROM ${safeIdentifier(schema)}.maintenance_runs
      WHERE task_id = $1
    `, [publishTimestampTask]);
    assert.equal(runsAfterRejectedChecksum.rows[0].count, 0);
    await pool.query(`
      UPDATE ${safeIdentifier(schema)}.schema_migrations
      SET checksum_sha256 = $2,
          checksum_recorded_at = $3
      WHERE version = $1
    `, [
      checksumTarget,
      checksumBeforeTamper.rows[0].checksum_sha256,
      checksumBeforeTamper.rows[0].checksum_recorded_at,
    ]);

    const first = spawnMaintenance({
      args: ['run', publishTimestampTask],
      suffix: 'task-first',
      extra: { MAINTENANCE_OFFLINE_CONFIRMED: '1' },
    });
    const second = spawnMaintenance({
      args: ['run', publishTimestampTask],
      suffix: 'task-second',
      extra: { MAINTENANCE_OFFLINE_CONFIRMED: '1' },
    });
    const [firstExit, secondExit] = await Promise.all([
      waitForChildExit(first, 15_000),
      waitForChildExit(second, 15_000),
    ]);
    for (const [runtime, exit] of [[first, firstExit], [second, secondExit]]) {
      assert.equal(exit.signal, null, runtime.output());
      if (exit.code !== 0) {
        assert.equal(exit.code, 1, runtime.output());
        assert.match(
          runtime.output(),
          /MAINTENANCE_TASK_LOCK_UNAVAILABLE|PROCESS_ROLE_LOCK_UNAVAILABLE/u,
        );
      }
      assertGuarded(runtime);
    }
    assert.equal(
      [firstExit, secondExit].some(exit => exit.code === 0),
      true,
      `at least one task process must succeed:\n${first.output()}\n${second.output()}`,
    );

    const completions = await pool.query(`
      SELECT status, count(*)::integer AS count
      FROM ${safeIdentifier(schema)}.maintenance_runs
      WHERE task_id = $1
        AND status IN ('succeeded', 'adopted')
      GROUP BY status
      ORDER BY status
    `, [publishTimestampTask]);
    assert.equal(
      completions.rows.reduce((sum, row) => sum + row.count, 0),
      1,
      'a one-shot task must have exactly one successful or adopted completion',
    );
    const wronglyRegistered = await pool.query(`
      SELECT 1
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version = $1
    `, [publishTimestampTask]);
    assert.equal(wronglyRegistered.rowCount, 0, 'new maintenance task IDs must not enter schema_migrations');
    const rollbackBridge = await pool.query(`
      SELECT 1
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version = $1
    `, ['publish_ts_backfill_v1']);
    assert.equal(
      rollbackBridge.rowCount,
      1,
      'a completed legacy once task must preserve the marker needed by older releases',
    );

    const taskApplicationNames = [...applicationNames].filter(name => (
      name.includes(`maintenance-task:${publishTimestampTask}`)
      || name.includes('onstarvoice:maintenance-offline:')
      || name.includes('-task-first')
      || name.includes('-task-second')
    ));
    const remainingSessions = await pool.query(`
      SELECT count(*)::integer AS count
      FROM pg_stat_activity
      WHERE application_name = ANY($1::text[])
    `, [taskApplicationNames]);
    assert.equal(remainingSessions.rows[0].count, 0, 'task CLI left a PostgreSQL session open');
    const remainingLocks = await pool.query(`
      SELECT count(*)::integer AS count
      FROM pg_locks lock
      JOIN pg_stat_activity activity ON activity.pid = lock.pid
      WHERE lock.locktype = 'advisory'
        AND activity.application_name = ANY($1::text[])
    `, [taskApplicationNames]);
    assert.equal(remainingLocks.rows[0].count, 0, 'task CLI left an advisory lock behind');
  });
});
