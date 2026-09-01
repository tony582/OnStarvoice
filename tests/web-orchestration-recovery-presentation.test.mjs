import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  formatRecoveryCountdown,
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

test('orchestration detail treats acknowledged commands as awaiting Agent report', async () => {
  const source = await readFile(
    new URL(
      '../web/admin/src/pages/dispatch/cloud-tasks/OrchestrationDetailWorkspace.tsx',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    source,
    /\['pending', 'acknowledged'\]\.includes\(commandStatus\)/u,
  );
  assert.doesNotMatch(
    source,
    /\['pending', 'claimed'\]\.includes\(commandStatus\)/u,
  );
});

test('orchestration detail exposes local-closure blocking and separate status counts', async () => {
  const source = await read(
    'web/admin/src/pages/dispatch/cloud-tasks/OrchestrationDetailWorkspace.tsx',
  );

  assert.match(source, /item\.metadata\?\.waitingForSourceClosure === true/u);
  assert.match(
    source,
    /executionMetadata\.waitingForSourceClosure === true/u,
  );
  assert.match(source, /execution-closure:/u);
  assert.match(
    source,
    /executionItems\.some\(item => itemClosureCardIds\.has\(String\(item\.id\)\)\)/u,
  );
  assert.match(source, /等待原 Agent 关闭确认/u);
  assert.match(source, /本地关闭证明/u);
  assert.match(source, /暂缓换 Agent/u);
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
