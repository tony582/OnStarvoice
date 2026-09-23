import {randomUUID} from 'node:crypto';
import {mkdtempSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {RunnerStore} from '../storage/runner-store.mjs';
import {ExecutionPermit} from '../core/execution-permit.mjs';
import {runDiscoveryTask} from '../core/discovery-runner.mjs';

// Deliberately synthetic, visible fixtures. This adapter never imports ADB,
// Appium or the cloud client, so demo cannot touch a phone or a live tenant.
function fixtureDevice(deviceId, works) {
  let context;
  return {
    inspect: async () => ({deviceId, connected: true, unlocked: true, loggedIn: true, challenge: false}),
    search: async ({keyword, filters}) => (context = {verified: true, contextId: randomUUID(), keyword, filters}),
    readCards: async () => ({contextVerified: true, contextId: context.contextId,
      cards: works.map((externalId, i) => ({cardId: `fixture-${i}`, title: `演示作品 ${i + 1}`, externalId})), end: true}),
    openCard: async ({card}) => ({identityVerified: true, cardId: card.cardId,
      detailId: `fixture-detail-${card.externalId}`, externalId: card.externalId}),
    copyLink: async ({detail}) => ({fresh: true, markerReplaced: true, identityVerified: true,
      detailId: detail.detailId, externalId: detail.externalId,
      shareUrl: `https://www.douyin.com/video/${detail.externalId}`}),
    returnToResults: async () => context,
    scroll: async () => ({contextVerified: true, contextId: context.contextId}),
  };
}

export async function runLocalDemo({stateDir} = {}) {
  const directory = stateDir ? resolve(stateDir) : mkdtempSync(join(tmpdir(), 'starvoice-android-demo-'));
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const store = new RunnerStore(join(directory, 'runner.sqlite'));
  const taskId = randomUUID();
  const agentId = randomUUID();
  const results = [];
  const rows = [
    ['别克壁纸', ['7000000000000000001', '7000000000000000002']],
    ['君越壁纸', ['7000000000000000002', '7000000000000000003']],
  ];
  try {
    for (const [keyword, works] of rows) {
      const identity = {taskId, discoveryRunId: taskId, agentId, itemId: randomUUID(),
        attemptId: randomUUID(), assignmentRevision: 1, requestHash: 'f'.repeat(64)};
      const permit = new ExecutionPermit({identity});
      const start = performance.now();
      const now = Date.now();
      permit.grant({...identity, leaseId: randomUUID(), serverTime: new Date(now).toISOString(),
        leaseUntil: new Date(now + 90000).toISOString()}, {requestStartedAt: start});
      const task = {identity, keyword, deviceId: 'SIMULATED_DEVICE',
        filters: {sort: 'latest', timeRange: 'day'}, deadlineAt: new Date(now + 600000).toISOString()};
      results.push({keyword, ...await runDiscoveryTask({task, store, permit,
        device: fixtureDevice(task.deviceId, works)})});
    }
    return {mode: 'simulation_only', networkUsed: false, deviceUsed: false,
      stateDir: directory, discoveryRunId: taskId, results,
      pendingEvents: store.pendingCount(), quarantinedEvents: store.quarantinedCount(),
      message: '本地模拟已结束；数据只在演示队列中，不代表真机或正式入库。'};
  } finally { store.close(); }
}
