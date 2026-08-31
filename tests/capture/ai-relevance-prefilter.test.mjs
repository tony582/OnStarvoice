import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  RELEVANCE_PREFILTER_BATCH_SIZE,
  RELEVANCE_PREFILTER_MAX_CONCURRENCY,
  RELEVANCE_PREFILTER_TIMEOUT_MS,
  RELEVANCE_PREFILTER_DETAIL_PROMPT_VERSION,
  buildRelevanceDetailCandidate,
  buildRelevancePrefilterCandidate,
  buildRelevancePrefilterIdempotencyKey,
  evaluateRelevancePrefilterRecords,
  evaluateRelevanceDetailRecord,
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

test('detail candidate contains only bounded minimal evidence', () => {
  const candidate = buildRelevanceDetailCandidate(keywordRecord(1), {
    title: '昂科威 Plus 使用感受',
    author: '车主',
    content: '正文内容',
    tags: ['昂科威', '车机'],
    ocrText: '屏幕显示文字',
    transcript: '视频口播文字',
    commentsCleanedItems: [{content: '评论不得发送'}],
    bloggerFollowersCount: 999,
    imageUrls: ['https://private.example/image.jpg'],
  });
  assert.equal(candidate.evidence.content, '正文内容');
  assert.deepEqual(candidate.evidence.tags, ['昂科威', '车机']);
  const serialized = JSON.stringify(candidate.evidence);
  assert.doesNotMatch(serialized, /评论不得发送|bloggerFollowersCount|private\.example/u);
});

test('a valid server skip disposition is actionable without a second client threshold', () => {
  assert.equal(
    normalizeRelevancePrefilterDecision({
      status: 'ok',
      modelDecision: 'skip',
      tenantRelevance: 'irrelevant',
      confidence: 0.95,
      executionDisposition: 'skip_full_capture',
    }).shouldSkip,
    true,
  );
  assert.equal(
    normalizeRelevancePrefilterDecision({
      status: 'ok',
      decision: 'skip',
      tenantRelevance: 'irrelevant',
      confidence: 0.99,
      executionDisposition: 'skip_full_capture',
    }).shouldSkip,
    true,
    'legacy decision alias remains fail-safe compatible',
  );
  for (const response of [
    {status: 'ok', modelDecision: 'need_detail', tenantRelevance: 'uncertain', confidence: 1},
    {status: 'timeout', modelDecision: 'skip', confidence: 1},
    {status: 'ok', modelDecision: 'skip', confidence: 'invalid'},
    {status: 'ok', modelDecision: 'skip', confidence: 1},
  ]) {
    assert.equal(
      normalizeRelevancePrefilterDecision(response).shouldSkip,
      false,
    );
  }
  assert.equal(
    normalizeRelevancePrefilterDecision({
      status: 'ok',
      modelDecision: 'skip',
      tenantRelevance: 'relevant',
      confidence: 1,
      executionDisposition: 'skip_full_capture',
    }).shouldSkip,
    false,
  );
  assert.equal(
    normalizeRelevancePrefilterDecision({
      status: 'ok',
      modelDecision: 'skip',
      tenantRelevance: 'irrelevant',
      confidence: 1,
      protectedSignal: true,
      executionDisposition: 'skip_full_capture',
    }).shouldSkip,
    false,
  );
  assert.equal(
    normalizeRelevancePrefilterDecision({
      status: 'ok',
      modelDecision: 'skip',
      tenantRelevance: 'irrelevant',
      confidence: 1,
      executionDisposition: 'skip_full_capture',
    }, {canSkip: false}).shouldSkip,
    false,
  );
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
        tenantRelevance: 'irrelevant',
        confidence: 1,
        executionDisposition: 'skip_full_capture',
      })),
    }),
  });
  assert.deepEqual(result.skippedRecordIds, []);
  assert.equal(result.decisions[0].valid, true);
  assert.equal(result.decisions[0].shouldSkip, false);
});

test('records use sequential micro-batches and the bounded response deadline', async () => {
  assert.equal(RELEVANCE_PREFILTER_BATCH_SIZE, 8);
  assert.equal(RELEVANCE_PREFILTER_TIMEOUT_MS, 30000);
  assert.match(
    apiSource,
    /Math\.min\(120000, Number\(options\?\.timeout\) \|\| 30000\)/u,
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
            tenantRelevance: index === 0 ? 'irrelevant' : 'relevant',
            confidence: 0.99,
            executionDisposition:
              index === 0 ? 'skip_full_capture' : 'collect_full',
          })),
        },
      };
    },
  });
  assert.equal(calls.length, 6);
  assert.deepEqual(
    calls.map(({request}) => request.items.length).sort((a, b) => b - a),
    [8, 8, 8, 8, 8, 1],
  );
  assert.equal(calls.every(({request}) => request.mode === 'conservative'), true);
  assert.equal(calls.every(({request}) => request.skipThreshold === 0.97), true);
  assert.equal(
    calls.every(({request}) => request.idempotencyKey.includes(':conservative:0.9700:')),
    true,
  );
  assert.equal(calls.every(({options}) => options.timeout === 30000), true);
  assert.equal(result.skippedRecordIds.length, 6);
  assert.equal(result.failedOpenCount, 0);
});

test('a whole timed-out batch fails open without split retries', async () => {
  const records = Array.from({length: 5}, (_, index) => keywordRecord(index + 1));
  const calls = [];
  const result = await evaluateRelevancePrefilterRecords(records, {
    enabled: true,
    requestBatch: async ({items}) => {
      calls.push(items.map((item) => item.itemId));
      return {
        ok: true,
        items: items.map((item) => ({
          itemId: item.itemId,
          status: 'timeout',
          modelDecision: null,
          confidence: null,
          executionDisposition: 'defer_enhancement',
          reason: 'MODEL_TIMEOUT',
        })),
      };
    },
  });

  assert.deepEqual(calls.map((items) => items.length), [5]);
  assert.equal(result.retryCount, 0);
  assert.equal(result.retriedItemCount, 0);
  assert.equal(result.timeoutCount, 5);
  assert.equal(result.evaluatedCount, 0);
  assert.equal(result.failedOpenCount, 5);
  assert.equal(result.deferredCount, 5);
});

test('multiple timed-out micro-batches each make one request only', async () => {
  const records = Array.from({length: 17}, (_, index) => keywordRecord(index + 1));
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
          executionDisposition: 'defer_enhancement',
          reason: 'MODEL_TIMEOUT',
        })),
      };
    },
  });

  assert.deepEqual(calls, [8, 8, 1]);
  assert.equal(result.retryCount, 0);
  assert.equal(result.retriedItemCount, 0);
  assert.equal(result.timeoutCount, 17);
  assert.equal(result.evaluatedCount, 0);
  assert.equal(result.failedOpenCount, 17);
  assert.deepEqual(result.skippedRecordIds, []);
  assert.equal(result.deferredCount, 17);
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
        tenantRelevance: 'relevant',
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

test('each Agent submits only one AI micro-batch at a time', async () => {
  assert.equal(RELEVANCE_PREFILTER_MAX_CONCURRENCY, 1);
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
          tenantRelevance: 'relevant',
          confidence: 1,
          executionDisposition: 'collect_full',
        })),
      };
    },
  });
  assert.equal(maxActive, 1);
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
  assert.equal(thrown.deferredCount, 2);

  const partial = await evaluateRelevancePrefilterRecords(records, {
    enabled: true,
    requestBatch: async ({items}) => ({
      ok: true,
      items: [
        {
          itemId: items[0].itemId,
          status: 'ok',
          modelDecision: 'need_detail',
          tenantRelevance: 'uncertain',
          confidence: 0.99,
          executionDisposition: 'collect_minimal_detail',
        },
      ],
    }),
  });
  assert.deepEqual(partial.skippedRecordIds, []);
  assert.equal(partial.failedOpenCount, 1);
  assert.equal(partial.minimalDetailCount, 1);
  assert.equal(partial.deferredCount, 1);
});

test('detail second stage uses one minimal request and can terminate expensive capture', async () => {
  const requests = [];
  const decision = await evaluateRelevanceDetailRecord(
    keywordRecord(1),
    {
      title: '大众壁纸合集',
      author: '车友',
      content: '全文只讨论大众汽车，与别克无关',
      tags: ['大众'],
      commentsCleanedItems: [{content: '不得发送'}],
    },
    {
      requestBatch: async (request) => {
        requests.push(request);
        return {
          ok: true,
          items: request.items.map((item) => ({
            itemId: item.itemId,
            status: 'ok',
            modelDecision: 'skip',
            tenantRelevance: 'irrelevant',
            confidence: 0.99,
            executionDisposition: 'skip_full_capture',
            decisionFinality: 'final',
            reason: '最小详情确认无关',
          })),
        };
      },
    },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stage, 'detail');
  assert.equal(requests[0].promptVersion, RELEVANCE_PREFILTER_DETAIL_PROMPT_VERSION);
  assert.doesNotMatch(JSON.stringify(requests[0]), /不得发送/u);
  assert.equal(decision.shouldSkip, true);
  assert.equal(decision.executionDisposition, 'skip_full_capture');
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

  const mixedSkipStart = aiSkipBranches[1].index;
  const mixedSkipEnd = fullBody.indexOf(
    'if (relevancePrefilterDeferredRecordIdSet.has(recordId))',
    mixedSkipStart,
  );
  const mixedSkipBranch = fullBody.slice(mixedSkipStart, mixedSkipEnd);
  assert.match(mixedSkipBranch, /continue;/u);
  assert.doesNotMatch(
    mixedSkipBranch,
    /captureCurrentNotePayload|captureCommentsForCurrentNote|captureBloggerMetricsForDetailPayload/u,
    'an actionable list skip must exit before detail, comment or blogger capture',
  );

  const noteCaptureAt = fullBody.indexOf('let noteResult = await captureCurrentNotePayload();');
  const secondStageAt = fullBody.indexOf('await evaluateRelevanceDetailRecord(');
  const bloggerAt = fullBody.indexOf('await captureBloggerMetricsForDetailPayload(');
  const commentsAt = fullBody.indexOf('await captureCommentsForCurrentNote(');
  assert.ok(secondStageAt > noteCaptureAt, 'detail AI must run after minimal note capture');
  assert.ok(bloggerAt > secondStageAt, 'detail AI must run before blogger metrics');
  assert.ok(commentsAt > secondStageAt, 'detail AI must run before comments');
});
