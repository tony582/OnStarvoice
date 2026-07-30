import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  createCommandSnapshotMatches,
} from '../server/routes/capture-cloud.js';
import {
  normalizeCloudTaskSnapshot,
} from '../server/services/capture-cloud.js';
import {
  materializeProfilePatrolTask,
} from '../server/services/profile-patrol-dispatch.js';

const captureCloudRoute = await readFile(
  new URL('../server/routes/capture-cloud.js', import.meta.url),
  'utf8',
);

const WORKFLOW = 'official_account_comment_patrol';
const TARGET = {
  itemId: '90000000-0000-4000-8000-000000000009',
  subscriptionId: '40000000-0000-4000-8000-000000000004',
  accountUrl: 'https://www.douyin.com/user/official-profile',
  url: 'https://www.douyin.com/user/official-profile',
};
const MONITOR_SETTINGS = {
  postsLimit: 30,
};
const CAPTURE_SETTINGS = {
  includeComments: true,
  includeCommentsOnDetailCapture: true,
  autoSyncAfterDetailCapture: true,
  commentsMaxDetectedItems: 50,
  scanLatestPostsByCount: true,
};

function officialCommentCommand(overrides = {}) {
  return {
    workflow: WORKFLOW,
    taskKind: WORKFLOW,
    protocolVersion: 1,
    targetMode: 'profile',
    profileMode: true,
    subjectType: 'official',
    targets: [TARGET],
    monitorSettings: MONITOR_SETTINGS,
    captureSettings: CAPTURE_SETTINGS,
    ...overrides,
  };
}

function officialCommentSnapshot(overrides = {}) {
  return normalizeCloudTaskSnapshot({
    id: '10000000-0000-4000-8000-000000000001',
    taskType: WORKFLOW,
    ...officialCommentCommand(),
    ...overrides,
  });
}

test('official comment snapshots promote their profile execution contract into metadata', () => {
  const snapshot = normalizeCloudTaskSnapshot({
    id: '10000000-0000-4000-8000-000000000001',
    taskType: WORKFLOW,
    workflow: WORKFLOW,
    protocolVersion: 1,
    targetMode: 'profile',
    profileMode: true,
    subjectType: 'official',
    targets: [TARGET],
    monitorSettings: MONITOR_SETTINGS,
    captureSettings: CAPTURE_SETTINGS,
    metadata: {
      cloudCommandId: 'command-1',
      workflow: 'negative_post_patrol',
      protocolVersion: 0,
      targetMode: 'detail',
      profileMode: false,
      subjectType: 'creator',
      targets: [{
        subscriptionId: 'wrong-subscription',
        accountUrl: 'https://www.douyin.com/user/wrong-profile',
      }],
      monitorSettings: {
        postsLimit: 1,
      },
      captureSettings: {
        includeComments: false,
        includeCommentsOnDetailCapture: false,
        commentsMaxDetectedItems: 1,
        scanLatestPostsByCount: false,
      },
    },
  });

  assert.equal(snapshot.metadata.workflow, WORKFLOW);
  assert.equal(snapshot.metadata.protocolVersion, 1);
  assert.equal(snapshot.metadata.targetMode, 'profile');
  assert.equal(snapshot.metadata.profileMode, true);
  assert.equal(snapshot.metadata.subjectType, 'official');
  assert.deepEqual(snapshot.metadata.targets, [TARGET]);
  assert.deepEqual(snapshot.metadata.monitorSettings, MONITOR_SETTINGS);
  assert.deepEqual(snapshot.metadata.captureSettings, CAPTURE_SETTINGS);
  assert.equal(snapshot.metadata.cloudCommandId, 'command-1');
  assert.equal(
    createCommandSnapshotMatches(officialCommentCommand(), snapshot),
    true,
    'stale metadata must not veto the authoritative top-level run contract',
  );
});

test('official comment create completion requires matching workflow and profile mode', () => {
  const command = officialCommentCommand();
  const matching = officialCommentSnapshot();
  const wrongWorkflow = officialCommentSnapshot({
    workflow: 'negative_post_patrol',
  });
  const wrongMode = officialCommentSnapshot({
    targetMode: 'detail',
    profileMode: false,
  });
  const missingMode = normalizeCloudTaskSnapshot({
    id: '10000000-0000-4000-8000-000000000001',
    taskType: WORKFLOW,
    workflow: WORKFLOW,
  });

  assert.equal(createCommandSnapshotMatches(command, matching), true);
  assert.equal(createCommandSnapshotMatches(command, wrongWorkflow), false);
  assert.equal(createCommandSnapshotMatches(command, wrongMode), false);
  assert.equal(createCommandSnapshotMatches(command, missingMode), false);
  assert.equal(
    createCommandSnapshotMatches(
      {workflow: 'negative_post_patrol'},
      wrongWorkflow,
    ),
    true,
    'other workflows retain their existing reconciliation behavior',
  );
});

test('official comment create completion rejects the wrong account, post count, and comment contract', () => {
  const command = officialCommentCommand();
  const wrongAccount = officialCommentSnapshot({
    targets: [{
      ...TARGET,
      subscriptionId: '40000000-0000-4000-8000-000000000099',
      accountUrl: 'https://www.douyin.com/user/wrong-profile',
      url: 'https://www.douyin.com/user/wrong-profile',
    }],
  });
  const wrongPostsLimit = officialCommentSnapshot({
    monitorSettings: {
      ...MONITOR_SETTINGS,
      postsLimit: 20,
    },
  });
  const commentsDisabled = officialCommentSnapshot({
    captureSettings: {
      ...CAPTURE_SETTINGS,
      includeComments: false,
      includeCommentsOnDetailCapture: false,
    },
  });
  const wrongCommentLimit = officialCommentSnapshot({
    captureSettings: {
      ...CAPTURE_SETTINGS,
      commentsMaxDetectedItems: 10,
    },
  });
  const wrongSelectionMode = officialCommentSnapshot({
    captureSettings: {
      ...CAPTURE_SETTINGS,
      scanLatestPostsByCount: false,
    },
  });

  assert.equal(createCommandSnapshotMatches(command, wrongAccount), false);
  assert.equal(createCommandSnapshotMatches(command, wrongPostsLimit), false);
  assert.equal(createCommandSnapshotMatches(command, commentsDisabled), false);
  assert.equal(createCommandSnapshotMatches(command, wrongCommentLimit), false);
  assert.equal(createCommandSnapshotMatches(command, wrongSelectionMode), false);
});

test('snapshot upserts do not restore stale execution fields from existing metadata', () => {
  for (const key of [
    'workflow',
    'protocolVersion',
    'targetMode',
    'profileMode',
    'subjectType',
    'targets',
    'monitorSettings',
    'captureSettings',
  ]) {
    assert.doesNotMatch(
      captureCloudRoute,
      new RegExp(`'${key}', capture_tasks\\.metadata->'${key}'`, 'u'),
      `stale execution field must not be restored by the upsert: ${key}`,
    );
  }
  assert.match(
    captureCloudRoute,
    /'createCommandId', capture_tasks\.metadata->'createCommandId'/u,
    'server-owned command identity must remain protected',
  );
  assert.match(
    captureCloudRoute,
    /'remoteRequestHash', capture_tasks\.metadata->'remoteRequestHash'/u,
    'server-owned request identity must remain protected',
  );
  assert.match(
    captureCloudRoute,
    /SELECT id::text AS id, status, payload[\s\S]*resolveCreateCommandFromSnapshot\(tx, agent, task, snapshot, createCommandEvidence\)/u,
  );
});

test('official profile task materialization stores the full contract in task metadata and command payload', async () => {
  const statements = [];
  const taskId = '10000000-0000-4000-8000-000000000001';
  const agentId = '20000000-0000-4000-8000-000000000002';
  const executionId = '30000000-0000-4000-8000-000000000003';
  const subscriptionId = '40000000-0000-4000-8000-000000000004';
  const commandId = '50000000-0000-4000-8000-000000000005';
  const tx = {
    async queryOne(sql, params) {
      statements.push({kind: 'queryOne', sql, params});
      if (sql.includes('INSERT INTO monitor_executions')) {
        return {id: executionId};
      }
      if (sql.includes('INSERT INTO capture_tasks')) {
        return {
          id: taskId,
          title: '官方账号评论巡查',
          platform: 'douyin',
          status: 'pending',
        };
      }
      if (sql.includes('INSERT INTO capture_agent_commands')) {
        return {id: commandId, expires_at: null};
      }
      throw new Error(`Unexpected queryOne: ${sql}`);
    },
    async execute(sql, params) {
      statements.push({kind: 'execute', sql, params});
      return {rowCount: 1};
    },
  };
  const monitorSettings = {
    postsLimit: 30,
  };
  const captureSettings = {
    includeCommentsOnDetailCapture: true,
    commentsMaxDetectedItems: 50,
    scanLatestPostsByCount: true,
  };

  await materializeProfilePatrolTask(tx, {
    tenantId: '60000000-0000-4000-8000-000000000006',
    subjectType: 'official',
    agent: {
      id: agentId,
      auth_code_id: '70000000-0000-4000-8000-000000000007',
      auth_binding_id: '80000000-0000-4000-8000-000000000008',
      last_heartbeat_at: new Date().toISOString(),
    },
    subscriptions: [{
      id: subscriptionId,
      platform: 'douyin',
      name: '上海安吉星信息服务有限公司',
      account_url: 'https://www.douyin.com/user/official-profile',
    }],
    requestKey: taskId,
    title: '官方账号评论巡查',
    monitorSettings,
    captureSettings,
  });

  const taskInsert = statements.find(statement =>
    statement.kind === 'queryOne' &&
    statement.sql.includes('INSERT INTO capture_tasks'));
  const commandInsert = statements.find(statement =>
    statement.kind === 'queryOne' &&
    statement.sql.includes('INSERT INTO capture_agent_commands'));
  assert.ok(taskInsert);
  assert.ok(commandInsert);

  const metadata = JSON.parse(taskInsert.params[10]);
  assert.equal(metadata.workflow, WORKFLOW);
  assert.equal(metadata.targetMode, 'profile');
  assert.equal(metadata.profileMode, true);
  assert.equal(metadata.subjectType, 'official');
  assert.deepEqual(metadata.monitorSettings, monitorSettings);
  assert.deepEqual(metadata.captureSettings, captureSettings);

  const payload = JSON.parse(commandInsert.params[4]);
  assert.equal(payload.workflow, WORKFLOW);
  assert.equal(payload.targetMode, 'profile');
  assert.equal(payload.profileMode, true);
  assert.equal(payload.subjectType, 'official');
  assert.deepEqual(payload.monitorSettings, monitorSettings);
  assert.deepEqual(payload.captureSettings, captureSettings);
});
