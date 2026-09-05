import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  activeRecoveryCommandStatus,
  formatRecoveryAttemptLabel,
  formatRecoveryCountdown,
  formatRecoveryState,
  orchestrationItemStatusBucket,
  summarizeOrchestrationItems,
} from '../web/admin/src/pages/dispatch/cloud-tasks/recovery-presentation.js';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('retryable items are counted only as automatic recovery', () => {
  const summary = summarizeOrchestrationItems([
    {status: 'completed'},
    {status: 'running'},
    {status: 'retryable'},
    {status: 'needs_action'},
    {status: 'failed'},
  ]);

  assert.deepEqual(summary, {
    completed: 1,
    settled: 2,
    active: 1,
    automaticRecovery: 1,
    manual: 1,
    failed: 1,
  });
  assert.equal(orchestrationItemStatusBucket('retryable'), 'automatic_recovery');
  assert.equal(orchestrationItemStatusBucket('needs_action'), 'manual');
  assert.equal(orchestrationItemStatusBucket('failed'), 'failed');
});

test('an expired recovery check names Agent reporting only when a command is waiting', () => {
  const now = Date.parse('2026-09-01T02:10:00.000Z');
  const due = Date.parse('2026-09-01T02:09:00.000Z');
  const future = Date.parse('2026-09-01T02:11:05.000Z');

  assert.equal(
    formatRecoveryCountdown({waitUntil: due, now}),
    '已到检查时间，等待服务端重新评估',
  );
  assert.equal(
    formatRecoveryCountdown({
      waitUntil: due,
      now,
      awaitingAgentReport: true,
    }),
    '指令已下发，等待 Agent 回报',
  );
  assert.equal(
    formatRecoveryCountdown({waitUntil: future, now}),
    '01:05 后检查',
  );
});

test('a real command state takes priority over both future and expired recovery times', () => {
  const now = Date.parse('2026-09-02T02:10:00.000Z');
  const due = Date.parse('2026-09-02T02:09:00.000Z');
  const future = Date.parse('2026-09-02T02:11:05.000Z');

  assert.equal(
    formatRecoveryState({commandStatus: 'pending', waitUntil: future, now}),
    '指令已下发 · 等待 Agent 领取',
  );
  assert.equal(
    formatRecoveryState({commandStatus: 'acknowledged', waitUntil: due, now}),
    'Agent 已领取 · 等待执行回报',
  );
  assert.equal(
    formatRecoveryState({waitUntil: future, now}),
    '01:05 后检查',
  );
  assert.equal(
    formatRecoveryState({waitUntil: due, now}),
    '尚未下发 · 等待空闲 Agent',
  );
});

test('an expired or malformed command is never presented as an active blocker', () => {
  const now = Date.parse('2026-09-02T02:10:00.000Z');
  assert.equal(activeRecoveryCommandStatus({
    id: 'future-command',
    status: 'pending',
    expiresAt: '2026-09-02T02:11:00.000Z',
    now,
  }), 'pending');
  assert.equal(activeRecoveryCommandStatus({
    id: 'past-command',
    status: 'acknowledged',
    expiresAt: '2026-09-02T02:09:00.000Z',
    now,
  }), '');
  assert.equal(activeRecoveryCommandStatus({
    id: 'malformed-command',
    status: 'pending',
    expiresAt: 'not-a-date',
    now,
  }), '');
});

test('an unknown recovery attempt total never invents a denominator', () => {
  assert.equal(
    formatRecoveryAttemptLabel({attemptCurrent: 4, attemptTotal: 8}),
    '4/8',
  );
  assert.equal(
    formatRecoveryAttemptLabel({attemptCurrent: 4, attemptTotal: null}),
    '第 4 次',
  );
  assert.equal(
    formatRecoveryAttemptLabel({attemptCurrent: 4, attemptTotal: 0}),
    '第 4 次',
  );
});

test('orchestration detail treats acknowledged commands as awaiting Agent report', async () => {
  const source = await readFile(
    new URL(
      '../web/admin/src/pages/dispatch/cloud-tasks/OrchestrationDetailWorkspace.tsx',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(source, /activeRecoveryCommandStatus/u);
  assert.match(source, /blocking_command_status[\s\S]*activeBlockingStatus/u);
  assert.doesNotMatch(
    source,
    /\['pending', 'claimed'\]\.includes\(commandStatus\)/u,
  );
});

test('orchestration detail omits retired closure blocking and keeps separate status counts', async () => {
  const source = await read(
    'web/admin/src/pages/dispatch/cloud-tasks/OrchestrationDetailWorkspace.tsx',
  );

  assert.doesNotMatch(source, /waitingForSourceClosure/u);
  assert.doesNotMatch(source, /execution-closure:/u);
  assert.doesNotMatch(source, /等待原 Agent 关闭确认/u);
  assert.doesNotMatch(source, /本地关闭证明/u);
  assert.doesNotMatch(source, /暂缓换 Agent/u);
  assert.match(source, /formatRecoveryState/u);
  assert.match(source, /executionAwaitingCommandStatus/u);
  assert.match(source, /RETRY_SOURCE_RELEASED_EXECUTION_STATUSES/u);
  assert.match(source, /来源执行记录缺失 · 等待服务端校验/u);
  assert.match(source, /原执行指令尚未结算/u);
  assert.match(source, /尚未释放接力/u);
  assert.match(source, /真正下发后会显示目标 Agent 和命令状态/u);
  assert.match(source, /等待空闲 Agent 心跳领取/u);
  assert.doesNotMatch(source, /recovery\.nextEvaluationAt/u);
  assert.doesNotMatch(source, /recovery\.next_evaluation_at/u);
  assert.doesNotMatch(source, /hasVisibleRecoveryCountdown/u);
  assert.match(
    source,
    /elasticPool[\s\S]*RETRY_SOURCE_RELEASED_EXECUTION_STATUSES\.has\(sourceStatus\)/u,
  );
  assert.match(
    source,
    /RETRY_SOURCE_RELEASED_EXECUTION_STATUSES[\s\S]*'needs_action', 'interrupted'/u,
  );
  assert.match(
    source,
    /const sourceAgentId = itemAssignedAgentId\([\s\S]*agent\.id === sourceAgentId/u,
  );
  assert.doesNotMatch(source, /keywordRetrySourceAgentIds/u);
  assert.doesNotMatch(source, /attempt_total \|\| 3/u);
  assert.doesNotMatch(source, /自动尝试已耗尽/u);
  assert.match(source, /最终分配以服务端提交时的实时状态为准/u);
  assert.match(source, /技术失败在全池尝试后可进入下一轮复用/u);
  assert.match(
    source,
    /FINAL_ORCHESTRATION_STATUSES\.has\(String\(detail\.orchestration\.status/u,
  );
  assert.match(
    source,
    /FINAL_EXECUTION_STATUSES\.has\(String\(execution\.status/u,
  );
  assert.match(source, /自动恢复 \{automaticRecoveryCount\}/u);
  assert.match(source, /需人工 \{manualCount\}/u);
  assert.match(source, /失败 \{failedCount\}/u);
  assert.doesNotMatch(source, /异常 \{failedCount\}/u);
  assert.doesNotMatch(source, /已到重试时间，正在等待 Agent 回报/u);
});
