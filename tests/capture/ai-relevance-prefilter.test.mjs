import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  RELEVANCE_PREFILTER_BATCH_SIZE,
  RELEVANCE_PREFILTER_MAX_CONCURRENCY,
  RELEVANCE_PREFILTER_TIMEOUT_MS,
  buildRelevancePrefilterCandidate,
  buildRelevancePrefilterIdempotencyKey,
  evaluateRelevancePrefilterRecords,
  normalizeRelevancePrefilterDecision,
} from '../../utils/capture/relevance-prefilter.js';
import {scopeRelevancePrefilterIdempotencyKey} from '../../utils/api.js';

const captureSyncSource = await readFile(
  new URL('../../utils/capture-sync.js', import.meta.url),
  'utf8',
);
const relevancePrefilterSource = await readFile(
  new URL('../../utils/capture/relevance-prefilter.js', import.meta.url),
  'utf8',
);
const apiSource = await readFile(
  new URL('../../utils/api.js', import.meta.url),
  'utf8',
);

function keywordRecord(index = 1, overrides = {}) {
  const itemOverrides = overrides.item || {};
  return {
    id: overrides.id || `record-${index}`,
    type: overrides.type || 'keyword_notes',
    platform: overrides.platform || 'xiaohongshu',
    title: overrides.title || `别克壁纸 ${index}`,
    payload: {
      keyword: overrides.keyword || '别克壁纸',
      content: '详情正文不应发送',
      items: [
        {
          noteId: `note-${index}`,
          title: overrides.title || `别克壁纸 ${index}`,
          author: '别克车友',
          noteType: 'image',
          publishDateRaw: '1天前',
          coverImageUrl: 'https://example.test/private-cover.jpg',
          content: '列表阶段不应发送正文',
          ...itemOverrides,
        },
      ],
    },
  };
}

test('candidate uses list text only and never forwards cover or body', () => {
  const candidate = buildRelevancePrefilterCandidate(keywordRecord(1));
  assert.equal(candidate.keyword, '别克壁纸');
  assert.equal(candidate.platform, 'xiaohongshu');
  assert.deepEqual(Object.keys(candidate.evidence), [
    'itemId',
    'externalId',
    'title',
    'author',
    'noteType',
    'publishTime',
  ]);
  assert.equal(JSON.stringify(candidate.evidence).includes('private-cover'), false);
  assert.equal(JSON.stringify(candidate.evidence).includes('正文'), false);
  assert.equal(candidate.evidence.externalId, 'note-1');
});

test('only valid high-confidence skip is actionable', () => {
  assert.equal(
    normalizeRelevancePrefilterDecision({
      status: 'ok',
      modelDecision: 'skip',
      confidence: 0.97,
      executionDisposition: 'skip_full_capture',
    }).shouldSkip,
    true,
  );
  assert.equal(
    normalizeRelevancePrefilterDecision({
      status: 'ok',
      decision: 'skip',
      confidence: 0.99,
      executionDisposition: 'skip_full_capture',
    }).shouldSkip,
    true,
    'legacy decision alias remains fail-safe compatible',
  );
  for (const response of [
    {
      status: 'ok',
      modelDecision: 'skip',
      confidence: 0.969,
      executionDisposition: 'skip_full_capture',
    },
    {status: 'ok', modelDecision: 'need_detail', confidence: 1},
    {status: 'timeout', modelDecision: 'skip', confidence: 1},
    {status: 'ok', modelDecision: 'skip', confidence: 'invalid'},
    {status: 'ok', modelDecision: 'skip', confidence: 1},
  ]) {
    assert.equal(
      normalizeRelevancePrefilterDecision(response).shouldSkip,
      false,
    );
  }
});

test('fallback titles cannot be skipped even when model is overconfident', async () => {
  const record = keywordRecord(1, {title: '抖音搜索结果 1'});
  const result = await evaluateRelevancePrefilterRecords([record], {
    enabled: true,
    requestBatch: async ({items}) => ({
      ok: true,
      items: items.map((item) => ({
        itemId: item.itemId,
        status: 'ok',
        modelDecision: 'skip',
        confidence: 1,
        executionDisposition: 'skip_full_capture',
      })),
    }),
  });
  assert.deepEqual(result.skippedRecordIds, []);
  assert.equal(result.decisions[0].valid, true);
  assert.equal(result.decisions[0].shouldSkip, false);
});

test('records use small DeepSeek batches and the bounded response deadline', async () => {
  assert.equal(RELEVANCE_PREFILTER_BATCH_SIZE, 5);
  assert.equal(RELEVANCE_PREFILTER_TIMEOUT_MS, 20000);
  assert.match(
    apiSource,
    /Math\.min\(20000, Number\(options\?\.timeout\) \|\| 20000\)/u,
    'API layer must not clamp the prefilter back below its response deadline',
  );
  const records = Array.from({length: 41}, (_, index) => keywordRecord(index + 1));
  const calls = [];
  const result = await evaluateRelevancePrefilterRecords(records, {
    enabled: true,
    requestBatch: async (request, options) => {
      calls.push({request, options});
      return {
        ok: true,
        data: {
          items: request.items.map((item, index) => ({
            itemId: item.itemId,
            status: 'ok',
            modelDecision: index === 0 ? 'skip' : 'keep',
            confidence: 0.99,
            executionDisposition:
              index === 0 ? 'skip_full_capture' : 'collect_full',
          })),
        },
      };
    },
  });
  assert.equal(calls.length, 9);
  assert.deepEqual(
    calls.map(({request}) => request.items.length).sort((a, b) => b - a),
    [5, 5, 5, 5, 5, 5, 5, 5, 1],
  );
  assert.equal(calls.every(({request}) => request.mode === 'conservative'), true);
  assert.equal(calls.every(({request}) => request.skipThreshold === 0.97), true);
  assert.equal(
    calls.every(({request}) => request.idempotencyKey.includes(':conservative:0.9700:')),
    true,
  );
  assert.equal(calls.every(({options}) => options.timeout === 20000), true);
  assert.equal(result.skippedRecordIds.length, 9);
  assert.equal(result.failedOpenCount, 0);
});

test('a whole timed-out batch is split and retried once before failing open', async () => {
  const records = Array.from({length: 5}, (_, index) => keywordRecord(index + 1));
  const calls = [];
  const result = await evaluateRelevancePrefilterRecords(records, {
    enabled: true,
    requestBatch: async ({items}) => {
      calls.push(items.map((item) => item.itemId));
      if (calls.length === 1) {
        return {
          ok: true,
          items: items.map((item) => ({
            itemId: item.itemId,
            status: 'timeout',
            modelDecision: null,
            confidence: null,
            executionDisposition: 'collect_full',
            reason: 'MODEL_TIMEOUT',
          })),
        };
      }
      return {
        ok: true,
        items: items.map((item) => ({
          itemId: item.itemId,
          status: 'ok',
          modelDecision: 'keep',
          confidence: 1,
          executionDisposition: 'collect_full',
        })),
      };
    },
  });

  assert.deepEqual(calls.map((items) => items.length), [5, 3, 2]);
  assert.equal(result.retryCount, 2);
  assert.equal(result.retriedItemCount, 5);
  assert.equal(result.timeoutCount, 0);
  assert.equal(result.evaluatedCount, 5);
  assert.equal(result.failedOpenCount, 0);
});

test('split retries stop after one layer and expose the remaining timeout count', async () => {
  const records = Array.from({length: 5}, (_, index) => keywordRecord(index + 1));
  const calls = [];
  const result = await evaluateRelevancePrefilterRecords(records, {
    enabled: true,
    requestBatch: async ({items}) => {
      calls.push(items.length);
      return {
        ok: true,
        items: items.map((item) => ({
          itemId: item.itemId,
          status: 'timeout',
          modelDecision: null,
          confidence: null,
          executionDisposition: 'collect_full',
          reason: 'MODEL_TIMEOUT',
        })),
      };
    },
  });

  assert.deepEqual(calls, [5, 3, 2]);
  assert.equal(result.retryCount, 2);
  assert.equal(result.retriedItemCount, 5);
  assert.equal(result.timeoutCount, 5);
  assert.equal(result.evaluatedCount, 0);
  assert.equal(result.failedOpenCount, 5);
  assert.deepEqual(result.skippedRecordIds, []);
});

test('identical list text in a later capture run receives a new idempotency key', async () => {
  const requests = [];
  const captureRequest = async (request) => {
    requests.push(request);
    return {
      ok: true,
      items: request.items.map((item) => ({
        itemId: item.itemId,
        status: 'ok',
        modelDecision: 'keep',
        confidence: 1,
        executionDisposition: 'collect_full',
      })),
    };
  };

  await evaluateRelevancePrefilterRecords([keywordRecord(1)], {
    enabled: true,
    requestBatch: captureRequest,
  });
  await evaluateRelevancePrefilterRecords([keywordRecord(1)], {
    enabled: true,
    requestBatch: captureRequest,
  });

  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.notEqual(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.match(
    requests[0].idempotencyKey,
    new RegExp(`:request:${requests[0].requestId}$`, 'u'),
  );
});

test('prefilter idempotency scoping is stable for retries and bounded for the API', () => {
  const input = [{itemId: 'douyin:1', title: '别克壁纸'}];
  const first = buildRelevancePrefilterIdempotencyKey({
    requestId: 'req-1',
    platform: 'douyin',
    keyword: '别克壁纸',
    batchIndex: 0,
    items: input,
  });
  const retry = buildRelevancePrefilterIdempotencyKey({
    requestId: 'req-1',
    platform: 'douyin',
    keyword: '别克壁纸',
    batchIndex: 0,
    items: input,
  });
  const laterRun = buildRelevancePrefilterIdempotencyKey({
    requestId: 'req-2',
    platform: 'douyin',
    keyword: '别克壁纸',
    batchIndex: 0,
    items: input,
  });
  assert.equal(first, retry);
  assert.notEqual(first, laterRun);
  assert.equal(scopeRelevancePrefilterIdempotencyKey(first, 'req-1'), first);

  const legacyFirst = scopeRelevancePrefilterIdempotencyKey('legacy-content-key', 'req-1');
  const legacyLater = scopeRelevancePrefilterIdempotencyKey('legacy-content-key', 'req-2');
  assert.notEqual(legacyFirst, legacyLater);
  assert.equal(legacyFirst, 'legacy-content-key:request:req-1');
  assert.ok(
    scopeRelevancePrefilterIdempotencyKey('x'.repeat(700), 'req-1').length <= 512,
  );
});

test('parallel DeepSeek batches stay within the server tenant concurrency', async () => {
  assert.equal(RELEVANCE_PREFILTER_MAX_CONCURRENCY, 6);
  const records = Array.from({length: 70}, (_, index) => keywordRecord(index + 1));
  let active = 0;
  let maxActive = 0;
  const result = await evaluateRelevancePrefilterRecords(records, {
    enabled: true,
    requestBatch: async ({items}) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        ok: true,
        items: items.map((item) => ({
          itemId: item.itemId,
          status: 'ok',
          modelDecision: 'keep',
          confidence: 1,
          executionDisposition: 'collect_full',
        })),
      };
    },
  });
  assert.equal(maxActive, 6);
  assert.equal(result.evaluatedCount, 70);
  assert.equal(result.failedOpenCount, 0);
});

test('a client deadline still fails open instead of skipping the item', async () => {
  const result = await evaluateRelevancePrefilterRecords([keywordRecord(1)], {
    enabled: true,
    requestBatch: async () => ({
      ok: false,
      reason: 'timeout',
      message: 'Request timeout',
    }),
  });
  assert.deepEqual(result.skippedRecordIds, []);
  assert.equal(result.failedOpenCount, 1);
  assert.equal(result.decisions[0].status, 'timeout');
});

test('request failure, missing items and need_detail all fail open', async () => {
  const records = [keywordRecord(1), keywordRecord(2)];
  const thrown = await evaluateRelevancePrefilterRecords(records, {
    enabled: true,
    requestBatch: async () => {
      throw new Error('DeepSeek unavailable');
    },
  });
  assert.deepEqual(thrown.skippedRecordIds, []);
  assert.equal(thrown.failedOpenCount, 2);

  const partial = await evaluateRelevancePrefilterRecords(records, {
    enabled: true,
    requestBatch: async ({items}) => ({
      ok: true,
      items: [
        {
          itemId: items[0].itemId,
          status: 'ok',
          modelDecision: 'need_detail',
          confidence: 0.99,
        },
      ],
    }),
  });
  assert.deepEqual(partial.skippedRecordIds, []);
  assert.equal(partial.failedOpenCount, 1);
});

test('detail batch invokes AI before creating a detail runner and only for keyword records', () => {
  const start = captureSyncSource.indexOf(
    'export async function batchCaptureDetailsForRecords',
  );
  const end = captureSyncSource.indexOf(
    'const shouldStopDetailBatch',
    start,
  );
  const body = captureSyncSource.slice(start, end);
  const functionEnd = captureSyncSource.indexOf(
    'export function resolveSyncInputForRecord',
    start,
  );
  const fullBody = captureSyncSource.slice(start, functionEnd);
  const aiAt = body.indexOf('await evaluateRelevancePrefilterRecords(');
  const runnerAt = body.indexOf('await prepareDetailBatchRunnerContext({');
  assert.ok(aiAt >= 0, 'missing AI prefilter call');
  assert.ok(runnerAt > aiAt, 'AI prefilter must run before any detail tab is opened');
  assert.match(body, /enableAiRelevancePrefilter/u);
  assert.match(body, /relevanceKeyword = ''/u);
  assert.match(body, /enableAiRelevancePrefilter \?\?/u);
  assert.match(relevancePrefilterSource, /type !== KEYWORD_RECORD_TYPE/u);
  assert.doesNotMatch(
    body.slice(
      body.indexOf('if (relevancePrefilterSkipRecordIdSet.has(recordId))'),
      body.indexOf('// 增量采集:已采全'),
    ),
    /deleteRecord\(/u,
    'AI filtering must preserve the list record for audit and recovery',
  );

  const aiSkipBranches = [...fullBody.matchAll(
    /if \(relevancePrefilterSkipRecordIdSet\.has\(recordId\)\) \{/gu,
  )];
  assert.equal(aiSkipBranches.length, 2, 'expected both all-skipped and mixed-batch AI branches');
  for (const [branchIndex, match] of aiSkipBranches.entries()) {
    const branchEnd = fullBody.indexOf(
      branchIndex === 0 ? 'aiFilteredCount += 1;' : 'filteredCount += 1;',
      match.index,
    );
    assert.ok(branchEnd > match.index, 'AI skip branch end marker is missing');
    assert.doesNotMatch(
      fullBody.slice(match.index, branchEnd),
      /deleteRecord\(/u,
      'AI filtering must not delete list records in either terminal branch',
    );
  }
});
