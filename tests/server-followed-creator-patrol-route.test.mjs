import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const route = await readFile(
  new URL('../server/routes/followed-creator-patrol.js', import.meta.url),
  'utf8',
);
const serverIndex = await readFile(
  new URL('../server/index.js', import.meta.url),
  'utf8',
);
const captureCloud = await readFile(
  new URL('../server/routes/capture-cloud.js', import.meta.url),
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
    serverIndex,
    /import followedCreatorPatrolRouter from '\.\/routes\/followed-creator-patrol\.js';/u,
  );
  assert.match(
    serverIndex,
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
    /official: 'official_account_post_discovery'/u,
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
  assert.match(dispatchService, /officialAccountPostDiscovery/u);
  assert.match(dispatchService, /remoteTargetedPostCaptureV1/u);
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
      title: '官方账号作品发现',
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
    /ms\.subject_type IN \('creator', 'official'\)/u,
  );
  assert.match(dispatchService, /subscription\.assigned_agent_id/u);
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
  assert.match(
    dispatchService,
    /该账号尚未绑定执行节点，定时扫描未创建/u,
  );
});

test('scheduled occurrence participates in the dispatch idempotency hash', async () => {
  const {profilePatrolRequestHash} = await import(
    `../server/services/profile-patrol-dispatch.js?test=${Date.now()}`,
  );
  const input = {
    workflow: 'official_account_post_discovery',
    agentId: 'agent-1',
    subscriptionIds: ['subscription-1'],
    title: '官方账号作品发现',
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
    captureCloud,
    /WHEN execution\.status = 'failed'\s+THEN now\(\) \+ interval '15 minutes'/u,
  );
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
