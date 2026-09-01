import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const route = await readFile(
  new URL('../server/routes/followed-creator-patrol.js', import.meta.url),
  'utf8',
);
const serverApp = await readFile(
  new URL('../server/app.js', import.meta.url),
  'utf8',
);
const captureCloud = await readFile(
  new URL('../server/routes/capture-cloud.js', import.meta.url),
  'utf8',
);
const monitorRoute = await readFile(
  new URL('../server/routes/monitor.js', import.meta.url),
  'utf8',
);
const profileDiscoveryWork = await readFile(
  new URL(
    '../server/modules/capture/infrastructure/postgres-profile-discovery-work.js',
    import.meta.url,
  ),
  'utf8',
);
const dispatchService = await readFile(
  new URL('../server/services/profile-patrol-dispatch.js', import.meta.url),
  'utf8',
);
const cron = await readFile(
  new URL('../server/cron.js', import.meta.url),
  'utf8',
);
const sidebar = await readFile(
  new URL('../sidebar/sidebar-logic.js', import.meta.url),
  'utf8',
);

test('profile patrol is mounted under capture-cloud', () => {
  assert.match(
    serverApp,
    /import followedCreatorPatrolRouter from '\.\/routes\/followed-creator-patrol\.js';/u,
  );
  assert.match(
    serverApp,
    /app\.use\('\/api\/capture-cloud', followedCreatorPatrolRouter\);/u,
  );
});

test('subscription API separates creator and official roles', () => {
  assert.match(route, /'\/followed-creator-patrol\/subscriptions'/u);
  assert.match(route, /subjectType 仅支持 creator 或 official/u);
  assert.match(route, /AND subject_type = \$2/u);
  assert.match(route, /const SUBJECT_WORKFLOW = PROFILE_PATROL_WORKFLOWS/u);
  assert.match(
    dispatchService,
    /creator: 'followed_creator_post_patrol'/u,
  );
  assert.match(
    dispatchService,
    /official: 'official_account_comment_patrol'/u,
  );
  assert.match(route, /row\.subject_type \|\| 'creator'/u);
});

test('task creation binds one monitor execution and work item to each subscription', () => {
  assert.match(route, /'\/followed-creator-patrol\/tasks'/u);
  assert.match(route, /subscription_execution_busy/u);
  assert.match(route, /materializeProfilePatrolTask/u);
  assert.match(dispatchService, /INSERT INTO monitor_executions/u);
  assert.match(dispatchService, /INSERT INTO capture_task_items/u);
  assert.match(dispatchService, /'profile_subscription'/u);
  assert.match(dispatchService, /monitorExecutionId: execution\.id/u);
  assert.match(dispatchService, /INSERT INTO capture_task_item_attempts/u);
  assert.match(dispatchService, /INSERT INTO capture_agent_commands/u);
  assert.match(dispatchService, /followedCreatorPostPatrol/u);
  assert.match(dispatchService, /officialAccountCommentPatrolProfileV1/u);
  assert.match(dispatchService, /officialAccountLatestPostsByCountV1/u);
  assert.match(dispatchService, /remoteTargetedPostCaptureV1/u);
  assert.match(dispatchService, /targetMode: 'profile'/u);
});

test('task materialization binds the selected Agent to the work item', async () => {
  const {materializeProfilePatrolTask} = await import(
    `../server/services/profile-patrol-dispatch.js?materialize=${Date.now()}`,
  );
  const statements = [];
  const taskId = '10000000-0000-4000-8000-000000000001';
  const agentId = '20000000-0000-4000-8000-000000000002';
  const executionId = '30000000-0000-4000-8000-000000000003';
  const subscriptionId = '40000000-0000-4000-8000-000000000004';
  const tx = {
    async queryOne(sql, params) {
      statements.push({kind: 'queryOne', sql, params});
      if (sql.includes('INSERT INTO capture_tasks')) {
        return {
          id: taskId,
          title: '关注博主作品扫描',
          platform: 'douyin',
          status: 'pending',
        };
      }
      if (sql.includes('INSERT INTO monitor_executions')) {
        return {id: executionId};
      }
      if (sql.includes('INSERT INTO capture_agent_commands')) {
        return {
          id: '50000000-0000-4000-8000-000000000005',
          expires_at: null,
        };
      }
      throw new Error(`Unexpected queryOne: ${sql}`);
    },
    async execute(sql, params) {
      statements.push({kind: 'execute', sql, params});
      return {rowCount: 1};
    },
  };

  await materializeProfilePatrolTask(tx, {
    tenantId: '60000000-0000-4000-8000-000000000006',
    subjectType: 'creator',
    agent: {
      id: agentId,
      auth_code_id: '70000000-0000-4000-8000-000000000007',
      auth_binding_id: '80000000-0000-4000-8000-000000000008',
      last_heartbeat_at: new Date().toISOString(),
    },
    subscriptions: [{
      id: subscriptionId,
      platform: 'douyin',
      name: '测试博主',
      account_url: 'https://www.douyin.com/user/test-profile',
    }],
    requestKey: taskId,
    title: '关注博主作品扫描',
  });

  const itemInsert = statements.find(statement =>
    statement.kind === 'execute' &&
    statement.sql.includes('INSERT INTO capture_task_items'));
  assert.ok(itemInsert);
  assert.equal(itemInsert.params[6], subscriptionId);
  assert.equal(
    itemInsert.params[7],
    'https://www.douyin.com/user/test-profile',
  );
  assert.equal(itemInsert.params[8], agentId);
  assert.match(itemInsert.params[9], /^[0-9a-f]{64}$/u);
  const itemMetadata = JSON.parse(itemInsert.params[10]);
  assert.equal(itemMetadata.monitorExecutionId, executionId);
  assert.equal(itemMetadata.subscriptionId, subscriptionId);
});

test('mixed-platform profile patrol is rejected before any task is created', async () => {
  const {materializeProfilePatrolTask} = await import(
    `../server/services/profile-patrol-dispatch.js?mixed=${Date.now()}`,
  );
  let queried = false;
  const tx = {
    async queryOne() {
      queried = true;
      throw new Error('database must not be called');
    },
    async execute() {
      queried = true;
      throw new Error('database must not be called');
    },
  };

  await assert.rejects(
    materializeProfilePatrolTask(tx, {
      tenantId: '60000000-0000-4000-8000-000000000006',
      subjectType: 'official',
      agent: {id: '20000000-0000-4000-8000-000000000002'},
      subscriptions: [
        {
          id: '40000000-0000-4000-8000-000000000004',
          platform: 'douyin',
        },
        {
          id: '40000000-0000-4000-8000-000000000005',
          platform: 'xiaohongshu',
        },
      ],
      title: '官方账号评论巡查',
    }),
    error => {
      assert.equal(error.status, 409);
      assert.equal(
        error.error,
        'profile_scan_mixed_platform_not_supported',
      );
      assert.match(error.message, /只能分配同一平台/u);
      return true;
    },
  );
  assert.equal(queried, false);
});

test('scheduled profile patrol treats settled attention as idle but blocks interrupted execution', async () => {
  const {
    loadAvailableScheduledProfilePatrolAgent,
    profilePatrolTaskBlocksAgentSlot,
  } = await import(
    `../server/services/profile-patrol-dispatch.js?failover=${Date.now()}`
  );
  assert.equal(profilePatrolTaskBlocksAgentSlot('running'), true);
  assert.equal(profilePatrolTaskBlocksAgentSlot('waiting_device'), true);
  assert.equal(profilePatrolTaskBlocksAgentSlot('resume_requested'), true);
  assert.equal(profilePatrolTaskBlocksAgentSlot('needs_action'), false);
  assert.equal(profilePatrolTaskBlocksAgentSlot('interrupted'), true);
  assert.equal(profilePatrolTaskBlocksAgentSlot('failed'), false);

  const preferredAgentId = '10000000-0000-4000-8000-000000000001';
  const fallbackAgentId = '20000000-0000-4000-8000-000000000002';
  const tenantId = '30000000-0000-4000-8000-000000000003';
  const agent = (id, heartbeat) => ({
    id,
    tenant_status: 'active',
    status: 'active',
    auth_code_status: 'active',
    auth_code_expires_at: null,
    active_auth_binding_id: '40000000-0000-4000-8000-000000000004',
    auth_code_id: '50000000-0000-4000-8000-000000000005',
    auth_binding_id: '40000000-0000-4000-8000-000000000004',
    allowed_platforms: ['douyin'],
    capabilities: {
      remoteTaskCreate: true,
      remoteTargetedPostCaptureV1: true,
      followedCreatorPostPatrol: true,
      supportedPlatforms: ['douyin'],
    },
    last_heartbeat_at: heartbeat,
    active_task_count: 0,
    active_command_count: 0,
  });
  const fallback = agent(fallbackAgentId, new Date().toISOString());
  const statements = [];
  const tx = {
    async queryAll(sql, params) {
      statements.push({kind: 'queryAll', sql, params});
      return [
        agent(preferredAgentId, '2020-01-01T00:00:00.000Z'),
        fallback,
      ];
    },
    async queryOne(sql, params) {
      statements.push({kind: 'queryOne', sql, params});
      if (sql.includes('FROM capture_agents ca')) return fallback;
      if (sql.includes('FROM capture_tasks')) return null;
      throw new Error(`Unexpected queryOne: ${sql}`);
    },
    async execute(sql, params) {
      statements.push({kind: 'execute', sql, params});
      return {rowCount: 1};
    },
  };

  const selected = await loadAvailableScheduledProfilePatrolAgent(tx, {
    tenantId,
    preferredAgentId,
    platform: 'douyin',
    subjectType: 'creator',
  });
  assert.equal(selected.agent.id, fallbackAgentId);
  assert.equal(selected.preferredAgentId, preferredAgentId);
  assert.equal(selected.selection, 'failover');
  assert.ok(statements.some(statement =>
    statement.kind === 'execute' &&
    statement.sql.includes('pg_advisory_xact_lock')));
  assert.equal(statements.some(statement =>
    statement.sql.includes('UPDATE monitor_subscriptions') &&
    statement.sql.includes('assigned_agent_id')),
  false);
});

test('manual profile patrol shares the Agent execution-slot lock and rechecks blockers', async () => {
  const {loadCompatibleProfilePatrolAgent} = await import(
    `../server/services/profile-patrol-dispatch.js?slot=${Date.now()}`
  );
  const tenantId = '30000000-0000-4000-8000-000000000003';
  const agentId = '20000000-0000-4000-8000-000000000002';
  const blockerTaskId = '10000000-0000-4000-8000-000000000001';
  const statements = [];
  const tx = {
    async execute(sql, params) {
      statements.push({kind: 'execute', sql, params});
      return {rowCount: 1};
    },
    async queryOne(sql, params) {
      statements.push({kind: 'queryOne', sql, params});
      if (sql.includes('FROM capture_agents ca')) {
        return {
          id: agentId,
          tenant_status: 'active',
          status: 'active',
          auth_code_status: 'active',
          auth_code_expires_at: null,
          active_auth_binding_id:
            '40000000-0000-4000-8000-000000000004',
          allowed_platforms: ['douyin'],
          capabilities: {
            remoteTaskCreate: true,
            remoteTargetedPostCaptureV1: true,
            followedCreatorPostPatrol: true,
            supportedPlatforms: ['douyin'],
          },
        };
      }
      if (sql.includes("SELECT blocker.kind")) {
        return {
          kind: 'task',
          id: blockerTaskId,
          task_id: blockerTaskId,
          status: 'running',
        };
      }
      throw new Error(`Unexpected queryOne: ${sql}`);
    },
  };

  const result = await loadCompatibleProfilePatrolAgent(
    tx,
    tenantId,
    agentId,
    ['douyin'],
    'creator',
  );
  assert.equal(result.failure.error, 'profile_scan_agent_busy');
  assert.equal(result.failure.status, 409);
  assert.equal(result.failure.details.blockerTaskId, blockerTaskId);
  assert.match(statements[0].sql, /pg_advisory_xact_lock/u);
  assert.ok(
    statements.findIndex(statement =>
      statement.sql.includes('pg_advisory_xact_lock')) <
      statements.findIndex(statement =>
        statement.sql.includes('FROM capture_agents ca')),
  );
});

test('stale profile execution cleanup preserves live commands and online runners', async () => {
  const {reconcileStaleProfilePatrolExecutions} = await import(
    `../server/services/profile-patrol-dispatch.js?reconcile=${Date.now()}`
  );
  const executionId = '60000000-0000-4000-8000-000000000006';
  const statements = [];
  const tx = {
    async queryAll(sql, params) {
      statements.push({kind: 'queryAll', sql, params});
      return [{
        id: executionId,
        tenant_id: '30000000-0000-4000-8000-000000000003',
        subscription_id: '70000000-0000-4000-8000-000000000007',
      }];
    },
    async execute(sql, params) {
      statements.push({kind: 'execute', sql, params});
      return {rowCount: 1};
    },
  };

  const reconciled = await reconcileStaleProfilePatrolExecutions(tx, {
    limit: 25,
    staleMinutes: 15,
  });
  assert.equal(reconciled.length, 1);
  const cleanup = statements[0];
  assert.match(cleanup.sql, /active_command\.expires_at > now\(\)/u);
  assert.match(cleanup.sql, /active_agent\.last_liveness_at/u);
  assert.match(cleanup.sql, /active_agent\.last_full_heartbeat_at/u);
  assert.match(cleanup.sql, /FOR UPDATE OF execution SKIP LOCKED/u);
  assert.equal(cleanup.params[0], 25);
  assert.equal(cleanup.params[1], 15);
  assert.deepEqual(cleanup.params[3], [
    'pending',
    'waiting_device',
    'claimed',
    'running',
    'recovering',
    'interrupted',
    'resume_requested',
  ]);
  assert.equal(statements.length, 1);
});

test('manual dispatch safely adopts only unclaimed scheduled executions', () => {
  assert.match(route, /requestKeyCollision/u);
  assert.match(route, /idempotency_key_conflict/u);
  assert.match(route, /AS cloud_owned/u);
  assert.match(
    route,
    /execution\.status === 'running' \|\| execution\.cloud_owned === true/u,
  );
  assert.match(route, /reusablePendingExecutionBySubscription/u);
  assert.match(route, /executionIdsBySubscription:/u);
  assert.match(
    dispatchService,
    /resolvedExecutionsBySubscription\.set\([\s\S]*existingExecutionId/u,
  );
});

test('scheduled profile patrol materializes real dispatch-center tasks', () => {
  assert.match(cron, /enqueueDueProfilePatrolTasks\(20\)/u);
  assert.doesNotMatch(cron, /enqueueDueMonitorExecutions/u);
  assert.match(
    dispatchService,
    /WHERE ms\.status = 'active'[\s\S]*AND ms\.subject_type = 'creator'/u,
  );
  assert.doesNotMatch(
    dispatchService,
    /ms\.subject_type IN \('creator', 'official'\)/u,
  );
  assert.match(dispatchService, /subscriptionSnapshot\.assigned_agent_id/u);
  assert.match(dispatchService, /loadAvailableScheduledProfilePatrolAgent/u);
  assert.match(
    dispatchService,
    /SAVEPOINT \$\{savepoint\}[\s\S]*ROLLBACK TO SAVEPOINT \$\{savepoint\}/u,
  );
  assert.match(dispatchService, /selection: !preferred/u);
  assert.match(dispatchService, /scheduledAgentSelection/u);
  assert.match(dispatchService, /reconcileStaleProfilePatrolExecutions/u);
  assert.match(dispatchService, /历史账号巡查执行状态未闭环/u);
  assert.match(dispatchService, /triggerType: 'profile_scan_schedule'/u);
  assert.match(dispatchService, /requestedByName: '云端调度器'/u);
  assert.match(dispatchService, /const reusableExecution = await tx\.queryOne/u);
  assert.match(dispatchService, /executionIdsBySubscription\.set/u);
  assert.match(
    dispatchService,
    /ON CONFLICT \(subscription_id\)[\s\S]*WHERE status IN \('pending', 'running'\)[\s\S]*DO NOTHING/u,
  );
  assert.match(
    dispatchService,
    /error\?\.error === 'subscription_execution_busy'[\s\S]*kind: 'busy'/u,
  );
  assert.match(dispatchService, /当前没有在线、空闲且支持该平台的执行节点/u);
});

test('every Profile dispatcher locks the Agent before subscriptions and executions', () => {
  const scheduledStart = dispatchService.indexOf(
    'async function enqueueDueProfilePatrolSubscription',
  );
  const scheduledEnd = dispatchService.indexOf(
    'export async function enqueueDueProfilePatrolTasks',
    scheduledStart,
  );
  const scheduled = dispatchService.slice(scheduledStart, scheduledEnd);
  assert.ok(
    scheduled.indexOf('loadAvailableScheduledProfilePatrolAgent') <
      scheduled.indexOf('lockDueProfilePatrolSubscription'),
  );
  assert.ok(
    scheduled.indexOf('lockDueProfilePatrolSubscription') <
      scheduled.indexOf('const reusableExecution = await tx.queryOne'),
  );

  const manualStart = route.indexOf('const snapshotRows = await tx.queryAll');
  const manualEnd = route.indexOf('const agent = compatible.agent', manualStart);
  const manual = route.slice(manualStart, manualEnd);
  assert.ok(
    manual.indexOf('loadCompatibleProfilePatrolAgent') <
      manual.indexOf('ORDER BY id\n          FOR UPDATE'),
  );
  assert.ok(
    manual.indexOf('ORDER BY id\n          FOR UPDATE') <
      manual.indexOf('const activeExecutions = await tx.queryAll'),
  );
  assert.match(
    manual,
    /ORDER BY execution\.subscription_id, execution\.id[\s\S]*FOR UPDATE OF execution/u,
  );
});

test('scheduled occurrence participates in the dispatch idempotency hash', async () => {
  const {profilePatrolRequestHash} = await import(
    `../server/services/profile-patrol-dispatch.js?test=${Date.now()}`,
  );
  const input = {
    workflow: 'official_account_comment_patrol',
    agentId: 'agent-1',
    subscriptionIds: ['subscription-1'],
    title: '官方账号评论巡查',
    monitorSettings: {publishWindow: '7d'},
    captureSettings: {autoSyncAfterDetailCapture: true},
  };
  const first = profilePatrolRequestHash({
    ...input,
    scheduledFor: '2026-07-27T00:00:00.000Z',
  });
  const retry = profilePatrolRequestHash({
    ...input,
    scheduledFor: '2026-07-27T00:00:00.000Z',
  });
  const nextOccurrence = profilePatrolRequestHash({
    ...input,
    scheduledFor: '2026-07-28T00:00:00.000Z',
  });
  assert.equal(first, retry);
  assert.notEqual(first, nextOccurrence);
  assert.match(first, /^[0-9a-f]{64}$/u);
});

test('profile scan results project through task center without pretending subscriptions are records', () => {
  assert.match(captureCloud, /'followed_creator_post_patrol'/u);
  assert.match(captureCloud, /'official_account_post_discovery'/u);
  assert.match(
    captureCloud,
    /metadata->>'subscriptionId' = \$15/u,
  );
  assert.match(
    captureCloud,
    /WHEN \$2::boolean AND NOT \$18::boolean THEN record_id/u,
  );
  assert.match(
    captureCloud,
    /该账号没有返回可验证的扫描结果/u,
  );
  assert.match(captureCloud, /syncProfileDiscoverySubscriptions/u);
  assert.match(
    profileDiscoveryWork,
    /WHEN execution\.status = 'failed'\s+THEN now\(\) \+ interval '15 minutes'/u,
  );
});

test('Profile terminal paths keep task rows before subscriptions and executions', () => {
  const helperStart = profileDiscoveryWork.indexOf(
    'export async function lockProfileDiscoveryWorkForTask',
  );
  const helperEnd = profileDiscoveryWork.indexOf(
    'export async function syncProfileDiscoverySubscriptions',
    helperStart,
  );
  const helper = profileDiscoveryWork.slice(helperStart, helperEnd);
  const itemLock = helper.indexOf('FROM capture_task_items item');
  const attemptLock = helper.indexOf('FROM capture_task_item_attempts attempt');
  const subscriptionLock = helper.indexOf(
    'lockProfileDiscoverySubscriptionsForTask',
  );
  const executionLock = helper.indexOf('FROM monitor_executions execution');
  assert.ok(itemLock >= 0);
  assert.ok(itemLock < attemptLock);
  assert.ok(attemptLock < subscriptionLock);
  assert.ok(subscriptionLock < executionLock);
  assert.match(helper, /ORDER BY item\.ordinal, item\.id[\s\S]*FOR UPDATE OF item/u);
  assert.match(
    helper,
    /ORDER BY attempt\.item_id, attempt\.attempt_number, attempt\.id[\s\S]*FOR UPDATE OF attempt/u,
  );
  assert.match(
    helper,
    /ORDER BY execution\.id[\s\S]*FOR UPDATE OF execution/u,
  );

  const failureStart = profileDiscoveryWork.indexOf(
    'export async function failProfileDiscoveryWork',
  );
  const failure = profileDiscoveryWork.slice(failureStart);
  assert.ok(
    failure.indexOf('lockProfileDiscoveryWorkForTask') <
      failure.indexOf('UPDATE capture_task_items'),
  );

  const cancelStart = captureCloud.indexOf(
    'async function cancelProfileDiscoveryWork',
  );
  const cancelEnd = captureCloud.indexOf(
    'export function negativePatrolTargetResults',
    cancelStart,
  );
  const cancel = captureCloud.slice(cancelStart, cancelEnd);
  assert.ok(
    cancel.indexOf('lockProfileDiscoveryWorkForTask') <
      cancel.indexOf('UPDATE capture_task_items'),
  );

  const projectionStart = captureCloud.indexOf(
    'async function projectNegativePatrolSnapshot',
  );
  const projectionEnd = captureCloud.indexOf(
    'const items = await tx.queryAll',
    projectionStart,
  );
  const projection = captureCloud.slice(projectionStart, projectionEnd);
  assert.ok(
    projection.indexOf('lockProfileDiscoveryWorkForTask') <
      projection.indexOf('for (const entry of negativePatrolTargetResults'),
  );

  const finishStart = monitorRoute.indexOf("router.post('/executions/:id/finish'");
  const finishEnd = monitorRoute.indexOf("router.get('/settings'", finishStart);
  const finish = monitorRoute.slice(finishStart, finishEnd);
  assert.ok(
    finish.indexOf('lockProfileDiscoverySubscriptionsForExecutions') <
      finish.indexOf('UPDATE monitor_executions'),
  );
  assert.match(finish, /NOT EXISTS \([\s\S]*FROM capture_task_items item/u);
});

test('extension profile scan reuses monitor execution and renders distinct dark task copy', () => {
  assert.match(sidebar, /isTargetedProfileDiscoveryWorkflow/u);
  assert.match(sidebar, /executeMonitorRunItem\(\{/u);
  assert.match(sidebar, /runnerTabId: targetTabId/u);
  assert.match(sidebar, /executionPreclaimed:\s*true/u);
  assert.match(sidebar, /if \(!executionPreclaimed\) \{/u);
  assert.match(sidebar, /关注博主作品扫描/u);
  assert.match(sidebar, /官方账号作品发现/u);
  assert.match(sidebar, /扫描当前账号作品/u);
  assert.match(sidebar, /monitor_execution_not_claimable/u);
  assert.match(sidebar, /该账号扫描已被其他执行端领取或已结束/u);
});

test('official comment patrol enhances the selected latest account posts without skipping old records', () => {
  assert.match(sidebar, /scanLatestPostsByCount/u);
  assert.match(sidebar, /MONITOR_LATEST_POSTS_LIMIT_MAX/u);
  assert.match(sidebar, /postsLimit/u);
  assert.match(sidebar, /正在巡查账号评论/u);
  assert.match(sidebar, /includeComments:\s*true/u);
  assert.match(sidebar, /skipAlreadyCaptured:\s*false/u);
  assert.match(sidebar, /comment_capture_failed/u);
});
