import {randomUUID} from 'node:crypto';

// Explicit loopback-only fixture, not evidence of a working phone profile.
export function createSimulationDevice(deviceId, {works = ['7000000000000000001', '7000000000000000002']} = {}) {
  let context;
  return {
    inspect: async () => ({deviceId, connected: true, unlocked: true, loggedIn: true, challenge: false}),
    search: async ({keyword, filters}) => (context = {verified: true, contextId: randomUUID(), keyword, filters}),
    readCards: async () => ({contextVerified: true, contextId: context.contextId,
      cards: works.map((externalId, i) => ({cardId: `simulation-${i}`, title: `演示作品 ${i + 1}`, externalId})), end: true}),
    openCard: async ({card}) => ({identityVerified: true, cardId: card.cardId,
      detailId: `simulation-${card.externalId}`, externalId: card.externalId}),
    copyLink: async ({detail}) => ({fresh: true, markerReplaced: true, identityVerified: true,
      detailId: detail.detailId, externalId: detail.externalId, shareUrl: `https://www.douyin.com/video/${detail.externalId}`}),
    returnToResults: async () => context,
    scroll: async () => ({contextVerified: true, contextId: context.contextId}),
  };
}
