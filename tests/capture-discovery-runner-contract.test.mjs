import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {discoveryEvent} from '../runners/android/src/core/discovery-evidence.mjs';
import {normalizeBatch} from '../server/services/capture-discovery/validation.js';

test('an actual Runner event is accepted by the server contract without rewriting identity', () => {
  const taskId = randomUUID();
  const identity = {taskId, discoveryRunId: taskId, itemId: randomUUID(), attemptId: randomUUID(),
    agentId: randomUUID(), assignmentRevision: 1, requestHash: 'a'.repeat(64)};
  const filters = {sort: 'latest', timeRange: 'day'};
  const payload = discoveryEvent({task: {identity, keyword: '别克壁纸', filters},
    card: {title: '正文仅 @ 官方', author: '普通用户'}, detail: {detailId: 'detail-one'},
    link: {externalId: '7000000000000000001', shareUrl: 'https://www.douyin.com/video/7000000000000000001'},
    context: {filters}, clock: {wallNow: Date.now}});
  const normalized = normalizeBatch({uploadBatchId: randomUUID(), events: [payload]}, {agentId: identity.agentId});
  assert.equal(normalized.events[0].eventId, payload.eventId);
  assert.equal(normalized.events[0].attemptId, identity.attemptId);
  assert.equal(normalized.events[0].verification, 'verified');
});
