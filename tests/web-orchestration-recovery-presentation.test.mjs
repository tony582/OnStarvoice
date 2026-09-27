import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  activeRecoveryCommandStatus,
  elasticRoundAnchorMs,
  formatRecoveryAttemptLabel,
  formatRecoveryCountdown,
  formatRecoveryState,
  orchestrationItemStatusBucket,
  summarizeElasticRoundWait,
  summarizeOrchestrationItems,
} from '../web/admin/src/pages/dispatch/cloud-tasks/recovery-presentation.js';
import {elasticRoundAnchorMs as serverElasticRoundAnchorMs} from '../server/services/capture-elastic-policy.js';

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
  // The retry list uses the server's gates (retry-item-allocation.js):
  // heartbeat claim for retryable elastic keywords, manual retry otherwise.
  assert.match(
    source,
    /keywordRetrySourceReleased\(\{ item, execution: sourceExecution, elasticPool \}\)/u,
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

// docs/hotfix/20260927-stuck-retry-and-attention-cleanup.md F1: batch 408d1410
// (8 XHS nodes; 上海 and 火星 fenced by this batch's own needs_action children).
const POOL_NAMES = ['上海', '北京', '成都', '重庆', '木星', '火星', '金星', '霸王龙'];
const poolAgents = POOL_NAMES.map((name, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  display_name: name,
  status: 'active',
  online: true,
  allowed_platforms: ['xiaohongshu'],
  active_task_count: 0,
}));
const agentId = name => poolAgents[POOL_NAMES.indexOf(name)].id;
const fencedAgentIds = new Set([agentId('上海'), agentId('火星')]);
function itemWithAttempts(itemId, names, {handoffReadyAt, metadata = {}} = {}) {
  const attempts = names.map((name, index) => ({
    id: `${itemId}-${index + 1}`,
    item_id: itemId,
    agent_id: agentId(name),
    attempt_number: index + 1,
    created_at: `2026-09-27T0${Math.min(9, index)}:00:00.000Z`,
  }));
  const item = {
    id: itemId,
    status: 'retryable',
    platform: 'xiaohongshu',
    item_type: 'keyword',
    attempt_count: names.length,
    assigned_agent_id: agentId(names.at(-1)),
    metadata: {
      checkpoint: {recovery: {handoffReadyAt}},
      ...metadata,
    },
    error: {code: 'XHS_SEARCH_TIME_FILTER_UNVERIFIED'},
    updated_at: '2026-09-27T05:08:47.000Z',
  };
  return {item, attempts};
}
const roundInput = (fixture, extra = {}) => ({
  ...fixture,
  poolAgentIds: poolAgents.map(agent => agent.id),
  agents: poolAgents,
  fencedAgentIds,
  relaxAfterMs: 10 * 60 * 1000,
  ...extra,
});

test('09-27 replay: the recovery card names the untried fenced nodes and the relax time', () => {
  const anchor = '2026-09-27T04:30:00.000Z';
  const anjixing = itemWithAttempts('anjixing', ['火星', '成都', '霸王龙', '重庆', '金星', '北京', '木星'], {handoffReadyAt: anchor});
  const before = summarizeElasticRoundWait(roundInput(anjixing, {now: Date.parse('2026-09-27T04:35:00.000Z')}));
  assert.equal(before.window, 7);
  assert.deepEqual(before.untried.map(entry => [entry.name, entry.reason]), [['上海', '待确认停止']]);
  assert.equal(before.relaxAtMs, Date.parse(anchor) + 10 * 60 * 1000);
  assert.equal(before.relaxed, false);
  const clock = new Date(before.relaxAtMs);
  const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`;
  assert.equal(before.message,
    `本轮未尝试的节点：上海（待确认停止）；超过 10 分钟未领取将开放给其他节点（约 ${hhmm} 起，原节点木星除外）`);

  const customer = itemWithAttempts('customer', ['霸王龙', '成都', '重庆', '金星', '北京', '木星'], {handoffReadyAt: anchor});
  const waiting = summarizeElasticRoundWait(roundInput(customer, {now: Date.parse('2026-09-27T04:31:00.000Z')}));
  assert.equal(waiting.window, 6);
  assert.deepEqual(waiting.untried.map(entry => entry.name), ['上海', '火星']);
  assert.match(waiting.message, /^本轮未尝试的节点：上海（待确认停止）、火星（待确认停止）；超过 10 分钟未领取将开放给其他节点/u);

  const relaxed = summarizeElasticRoundWait(roundInput(customer, {now: Date.parse('2026-09-27T04:40:00.000Z')}));
  assert.equal(relaxed.relaxed, true);
  assert.equal(relaxed.message,
    '本轮未尝试的节点（上海：待确认停止、火星：待确认停止）超过 10 分钟未领取，已开放给除原节点木星外的其他节点，等待空闲节点领取');
});

test('a manual retry wait uses its own start, never the stale 04:30 anchor', () => {
  const fixture = itemWithAttempts('manual', ['霸王龙', '成都', '重庆'], {
    handoffReadyAt: '2026-09-27T04:30:00.000Z',
    metadata: {elasticRetryWaitingSince: '2026-09-27T17:00:00.000+08:00'},
  });
  assert.equal(elasticRoundAnchorMs(fixture.item), Date.parse('2026-09-27T09:00:00.000Z'));
  assert.equal(elasticRoundAnchorMs(fixture.item), serverElasticRoundAnchorMs(fixture.item),
    'the Admin and server anchor rules agree');
  const summary = summarizeElasticRoundWait(roundInput(fixture, {now: Date.parse('2026-09-27T09:05:00.000Z')}));
  assert.equal(summary.relaxed, false);
  assert.equal(summary.relaxAtMs, Date.parse('2026-09-27T09:10:00.000Z'));
  assert.equal(summarizeElasticRoundWait(roundInput(fixture, {now: Date.parse('2026-09-27T09:10:00.000Z')})).relaxed, true);
});

test('untried nodes are annotated with why they cannot claim', () => {
  const fixture = itemWithAttempts('reasons', ['成都', '木星']);
  const agents = poolAgents.map(agent => ({
    ...agent,
    ...(agent.display_name === '北京' ? {online: false} : {}),
    ...(agent.display_name === '重庆' ? {status: 'paused'} : {}),
    ...(agent.display_name === '金星' ? {active_task_count: 1} : {}),
    ...(agent.display_name === '霸王龙' ? {allowed_platforms: ['douyin']} : {}),
  }));
  const summary = summarizeElasticRoundWait(roundInput(fixture, {agents, now: Date.parse('2026-09-27T05:09:00.000Z')}));
  assert.deepEqual(summary.untried.map(entry => [entry.name, entry.reason]), [
    ['上海', '待确认停止'], ['北京', '离线'], ['重庆', '已暂停'], ['火星', '待确认停止'],
    ['金星', '忙碌'], ['霸王龙', '不负责该平台'],
  ]);
  // No anchor at all: updated_at is the fallback.
  assert.equal(summary.anchorMs, Date.parse('2026-09-27T05:08:47.000Z'));
});

test('a full round, a pinned item or an unknown pool get no round text', () => {
  const fullRound = itemWithAttempts('round2', POOL_NAMES.slice(1).concat('北京'));
  const summary = summarizeElasticRoundWait(roundInput(fullRound, {now: Date.parse('2026-09-27T05:00:00.000Z')}));
  assert.equal(summary.window, 0);
  assert.equal(summary.message, '本轮池内节点都已尝试，已进入下一轮：除原节点外的节点都可领取');

  const pinned = itemWithAttempts('pinned', ['成都'], {metadata: {pinnedAgentId: agentId('成都')}});
  assert.equal(summarizeElasticRoundWait(roundInput(pinned)), null);
  assert.equal(summarizeElasticRoundWait(roundInput(fullRound, {poolAgentIds: []})), null);
  assert.equal(summarizeElasticRoundWait(roundInput(fullRound, {poolAgentIds: [agentId('成都')]})), null);
  assert.equal(summarizeElasticRoundWait(roundInput({...fullRound, item: {...fullRound.item, status: 'failed'}})), null);
});

test('the recovery card uses the round summary and the server-provided relax window', async () => {
  const source = await read('web/admin/src/pages/dispatch/cloud-tasks/OrchestrationDetailWorkspace.tsx');
  assert.match(source, /summarizeElasticRoundWait\(\{/u);
  assert.match(source, /detail\.elasticPolicy\?\.roundRelaxAfterMs\) \|\| DEFAULT_ELASTIC_ROUND_RELAX_MS/u);
  assert.match(source, /fencedAgentIds: stopFencedAgentIds/u);
  assert.match(source, /roundWait\s*\?\s*`\$\{workUnit\}「\$\{keywordForItem\(item\)\}」：\$\{roundWait\.message\}`/u);
  const routes = await read('server/routes/capture-orchestrations.js');
  assert.match(routes, /elasticPolicy: \{roundRelaxAfterMs: elasticRoundRelaxAfterMs\(\)\}/u);
});
