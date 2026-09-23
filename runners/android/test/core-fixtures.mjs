import { ExecutionPermit } from '../src/core/execution-permit.mjs';

export function fixtureTask(overrides = {}) {
  return { identity: { taskId: 'run-1', discoveryRunId: 'run-1', itemId: 'item-1', attemptId: 'attempt-1',
    agentId: 'agent-1', requestHash: 'request-hash', assignmentRevision: 1 },
  deviceId: 'phone-1', keyword: '别克壁纸', filters: { sort: 'latest', range: 'day' }, ...overrides };
}
export function fixtureClock() {
  let wall = Date.parse('2026-09-22T02:00:00Z');
  let mono = 100;
  return { wallNow: () => wall, monotonicNow: () => mono, advance: (ms) => { wall += ms; mono += ms; },
    wallOnly: (ms) => { wall += ms; } };
}
export function fixturePermit(task, clock, duration = 90_000) {
  const permit = new ExecutionPermit({ identity: task.identity, monotonicNow: clock.monotonicNow });
  permit.grant({ ...task.identity, leaseId: 'lease-1', serverTime: new Date(clock.wallNow()).toISOString(),
    leaseUntil: new Date(clock.wallNow() + duration).toISOString() }, { requestStartedAt: clock.monotonicNow() });
  return permit;
}
export function fixtureDevice(task, overrides = {}) {
  const calls = [];
  const context = { verified: true, keyword: task.keyword, filters: task.filters, contextId: 'context-1' };
  const methods = {
    inspect: async () => ({ deviceId: task.deviceId, connected: true, unlocked: true, loggedIn: true, challenge: false }),
    search: async () => context,
    readCards: async () => ({ contextVerified: true, contextId: context.contextId,
      cards: [{ cardId: 'card-1', title: '新壁纸', author: '车友', publishTimeRaw: '1 小时前' }], end: true }),
    openCard: async ({ card }) => ({ identityVerified: true, cardId: card.cardId, detailId: 'detail-1', externalId: '1234567890123456789' }),
    copyLink: async ({ detail }) => ({ identityVerified: true, fresh: true, markerReplaced: true, detailId: detail.detailId,
      externalId: detail.externalId, shareUrl: `https://www.douyin.com/note/${detail.externalId}` }),
    returnToResults: async () => context,
    scroll: async () => ({ contextVerified: true, contextId: context.contextId }),
    ...overrides,
  };
  const device = Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async (params) => {
    calls.push(name);
    return fn(params);
  }]));
  return { device, calls, context };
}
