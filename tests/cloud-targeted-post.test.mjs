import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import test from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(
  resolve(repoRoot, "utils/cloud-targeted-post.js"),
  "utf8",
);
const context = vm.createContext({Date, Set, URL});
vm.runInContext(source, context, {filename: "utils/cloud-targeted-post.js"});
const targeted = context.OnStarvoiceCloudTargetedPost;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("normalizes only protocol v1 negative-post detail targets", () => {
  const command = targeted.normalizeCommandPayload({
    protocolVersion: 1,
    workflow: "negative_post_patrol",
    taskId: "task-1",
    clientTaskId: "client-task-1",
    platform: "xiaohongshu",
    planSnapshot: {
      targets: [
        {
          recordId: "record-1",
          externalId: "note-1",
          url: "https://www.xiaohongshu.com/explore/note-1?xsec_source=pc_search&utm_source=bad#fragment",
          title: "目标作品",
        },
      ],
    },
  });

  assert.equal(command.protocolVersion, 1);
  assert.equal(command.workflow, "negative_post_patrol");
  assert.equal(command.captureSettings.autoSyncAfterDetailCapture, true);
  assert.equal(command.targets[0].externalId, "note-1");
  assert.equal(
    command.targets[0].url,
    "https://www.xiaohongshu.com/explore/note-1?xsec_source=pc_search",
  );
});

test("rejects arbitrary origins, non-detail pages and mismatched identities", () => {
  const base = {
    protocolVersion: 1,
    workflow: "negative_post_patrol",
    taskId: "task-1",
    platform: "douyin",
  };
  for (const target of [
    {recordId: "record-1", url: "https://example.com/video/123"},
    {recordId: "record-1", url: "https://www.douyin.com/search/test"},
    {
      recordId: "record-1",
      externalId: "456",
      url: "https://www.douyin.com/video/123",
    },
  ]) {
    assert.throws(
      () =>
        targeted.normalizeCommandPayload({
          ...base,
          planSnapshot: {targets: [target]},
        }),
      /目标链接|作品标识|作品详情/,
    );
  }
});

test("allows a Douyin search modal only when modal_id identifies the target", () => {
  const normalized = targeted.canonicalizeTargetUrl(
    "https://www.douyin.com/jingxuan/search/test?type=general&modal_id=766193585000000001&aid=tracking",
    "douyin",
    "766193585000000001",
  );
  assert.equal(normalized.routeKind, "search_modal");
  assert.equal(
    normalized.url,
    "https://www.douyin.com/jingxuan/search/test?type=general&modal_id=766193585000000001",
  );
});

test("blocks cloud success when captured record identity differs", () => {
  const result = targeted.buildTargetResult({
    target: {
      itemId: "item-1",
      recordId: "server-record-1",
      externalId: "expected-note",
      ordinal: 1,
    },
    batchResult: {
      results: [{ok: true, recordIds: ["local-record-1"]}],
    },
    records: [
      {
        id: "local-record-1",
        platform: "xiaohongshu",
        data: {
          noteId: "different-note",
          url: "https://www.xiaohongshu.com/explore/different-note",
        },
      },
    ],
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "TARGET_IDENTITY_MISMATCH");
});

test("builds resumable item results and checkpoint in target order", () => {
  const targets = [
    {itemId: "item-1", recordId: "record-1", externalId: "note-1", ordinal: 1},
    {itemId: "item-2", recordId: "record-2", externalId: "note-2", ordinal: 2},
  ];
  const completed = targeted.buildTargetResult({
    target: targets[0],
    batchResult: {
      results: [{ok: true, recordIds: ["local-1"]}],
    },
    records: [
      {
        id: "local-1",
        platform: "xiaohongshu",
        data: {noteId: "note-1"},
      },
    ],
  });
  const checkpoint = targeted.buildCheckpoint(targets, [completed]);
  assert.equal(completed.status, "completed");
  assert.deepEqual(plain(checkpoint), {
    workflow: "negative_post_patrol",
    nextOrdinal: 2,
    processedCount: 1,
    successCount: 1,
    warningCount: 0,
    failedCount: 0,
    unavailableCount: 0,
    capturedCount: 1,
    skippedCount: 0,
    canceledCount: 0,
    completedItemIds: ["item-1"],
    total: 2,
  });
});

test("settles a deleted or unavailable post without retrying it", () => {
  const targets = [{
    workflow: "negative_post_patrol",
    itemId: "item-deleted",
    recordId: "record-deleted",
    externalId: "note-deleted",
    ordinal: 1,
  }];
  const result = targeted.buildTargetResult({
    target: targets[0],
    batchResult: {
      results: [{
        ok: true,
        captured: false,
        unavailable: true,
        businessOutcome: "post_unavailable",
        availabilityStatus: "deleted",
        retryable: false,
        availability: {
          status: "unavailable",
          availabilityStatus: "deleted",
          reason: "post_deleted_or_unavailable",
          code: "TARGET_POST_UNAVAILABLE",
          message: "平台提示该帖子已删除",
          evidence: ["xhs_deleted_copy"],
          observedAt: "2026-07-27T01:00:00.000Z",
        },
      }],
    },
    finishedAt: "2026-07-27T01:00:00.000Z",
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.captured, false);
  assert.equal(result.businessOutcome, "post_unavailable");
  assert.equal(result.availabilityStatus, "deleted");
  assert.equal(result.retryable, false);
  assert.deepEqual(plain(result.recordIds), []);
  assert.deepEqual(plain(targeted.buildCheckpoint(targets, [result])), {
    workflow: "negative_post_patrol",
    nextOrdinal: 2,
    processedCount: 1,
    successCount: 0,
    warningCount: 0,
    failedCount: 0,
    unavailableCount: 1,
    capturedCount: 0,
    skippedCount: 1,
    canceledCount: 0,
    completedItemIds: ["item-deleted"],
    total: 1,
  });
});

test("accepts official-account comment patrol only with a published direct-detail target and comments sync", () => {
  const command = targeted.normalizeCommandPayload({
    protocolVersion: 1,
    workflow: "official_account_comment_patrol",
    taskId: "official-task-1",
    platform: "douyin",
    captureSettings: {
      includeComments: true,
      autoSyncAfterDetailCapture: true,
      commentsMaxDetectedItems: 30,
    },
    planSnapshot: {
      targets: [{
        recordId: "post-1",
        externalId: "766193585000000001",
        url: "https://www.douyin.com/video/766193585000000001?tracking=drop",
        publishedAt: "2026-07-26T01:00:00.000Z",
      }],
    },
  });

  assert.equal(command.workflow, "official_account_comment_patrol");
  assert.equal(command.targets[0].workflow, "official_account_comment_patrol");
  assert.equal(command.targets[0].publishedAt, "2026-07-26T01:00:00.000Z");
  assert.equal(command.captureSettings.includeComments, true);
  assert.equal(command.captureSettings.autoSyncAfterDetailCapture, true);
});

test("rejects unsupported workflows and unsafe official-comment patrol inputs", () => {
  const base = {
    protocolVersion: 1,
    workflow: "official_account_comment_patrol",
    taskId: "official-task-1",
    platform: "douyin",
    captureSettings: {includeComments: true, autoSyncAfterDetailCapture: true},
    planSnapshot: {
      targets: [{
        recordId: "post-1",
        externalId: "766193585000000001",
        url: "https://www.douyin.com/video/766193585000000001",
        publishedAt: "2026-07-26T01:00:00.000Z",
      }],
    },
  };
  assert.throws(
    () => targeted.normalizeCommandPayload({...base, workflow: "third_workflow"}),
    /协议版本不受支持/,
  );
  assert.throws(
    () => targeted.normalizeCommandPayload({...base, captureSettings: {autoSyncAfterDetailCapture: true}}),
    /必须启用评论采集/,
  );
  assert.throws(
    () => targeted.normalizeCommandPayload({...base, planSnapshot: {targets: [{
      ...base.planSnapshot.targets[0],
      publishedAt: "",
    }]}}),
    /缺少发布时间/,
  );
  assert.throws(
    () => targeted.normalizeCommandPayload({...base, planSnapshot: {targets: [{
      ...base.planSnapshot.targets[0],
      url: "https://www.douyin.com/jingxuan/search/test?type=general&modal_id=766193585000000001",
    }]}}),
    /只允许抖音作品详情直链/,
  );
});

test("normalizes creator and official profile discovery as resumable account targets", () => {
  const creator = targeted.normalizeCommandPayload({
    protocolVersion: 1,
    workflow: "followed_creator_post_patrol",
    taskId: "creator-task-1",
    title: "关注博主作品扫描",
    platform: "multi",
    monitorSettings: {publishWindow: "7d"},
    targets: [{
      itemId: "11111111-1111-4111-8111-111111111111",
      recordId: "22222222-2222-4222-8222-222222222222",
      externalId: "22222222-2222-4222-8222-222222222222",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      executionId: "33333333-3333-4333-8333-333333333333",
      platform: "xiaohongshu",
      accountUrl:
        "https://www.xiaohongshu.com/user/profile/creator-a?xsec_source=pc_feed&utm_source=drop#bad",
      title: "博主 A",
    }],
  });

  assert.equal(creator.workflow, "followed_creator_post_patrol");
  assert.equal(creator.platform, "multi");
  assert.equal(creator.subjectType, "creator");
  assert.equal(creator.targets[0].routeKind, "profile");
  assert.equal(
    creator.targets[0].url,
    "https://www.xiaohongshu.com/user/profile/creator-a?xsec_source=pc_feed",
  );
  assert.equal(creator.targets[0].executionId, "33333333-3333-4333-8333-333333333333");
  assert.equal(plain(creator.monitorSettings).publishWindow, "7d");

  const official = targeted.normalizeCommandPayload({
    protocolVersion: 1,
    workflow: "official_account_post_discovery",
    taskId: "official-discovery-1",
    platform: "douyin",
    targets: [{
      itemId: "44444444-4444-4444-8444-444444444444",
      recordId: "55555555-5555-4555-8555-555555555555",
      subscriptionId: "55555555-5555-4555-8555-555555555555",
      executionId: "66666666-6666-4666-8666-666666666666",
      platform: "douyin",
      url: "https://www.douyin.com/user/MS4wLjABAAAA-demo?aid=drop",
    }],
  });
  assert.equal(official.subjectType, "official");
  assert.equal(official.targets[0].platform, "douyin");
  assert.equal(official.targets[0].url, "https://www.douyin.com/user/MS4wLjABAAAA-demo");
});

test("profile discovery rejects post URLs and missing monitor execution identity", () => {
  const base = {
    protocolVersion: 1,
    workflow: "followed_creator_post_patrol",
    taskId: "creator-task-1",
    platform: "xiaohongshu",
  };
  assert.throws(
    () => targeted.normalizeCommandPayload({
      ...base,
      targets: [{
        itemId: "item-1",
        recordId: "subscription-1",
        subscriptionId: "subscription-1",
        executionId: "execution-1",
        url: "https://www.xiaohongshu.com/explore/note-1",
      }],
    }),
    /账号主页/,
  );
  assert.throws(
    () => targeted.normalizeCommandPayload({
      ...base,
      targets: [{
        itemId: "item-1",
        recordId: "subscription-1",
        url: "https://www.xiaohongshu.com/user/profile/creator-a",
      }],
    }),
    /监控执行标识/,
  );
});

test("reports a bounded current-run comment observation without claiming a full history", () => {
  const result = targeted.buildTargetResult({
    target: {
      workflow: "official_account_comment_patrol",
      itemId: "post-1",
      recordId: "server-post-1",
      externalId: "123",
      ordinal: 1,
    },
    batchResult: {
      results: [{
        ok: true,
        recordIds: ["local-post-1"],
        commentsResult: {
          phase: "comments_partial",
          currentObservedCount: 2,
          currentObservedItems: [
            {commentId: "c1", content: "第一条"},
            {commentId: "c2", content: "第二条"},
          ],
          partial: true,
          stopReason: "network_timeout",
        },
      }],
    },
    records: [{
      id: "local-post-1",
      platform: "douyin",
      data: {awemeId: "123", comments: 100, commentsCountKnown: true},
    }],
    finishedAt: "2026-07-26T02:00:00.000Z",
  });

  assert.equal(result.workflow, "official_account_comment_patrol");
  assert.deepEqual(plain(result.commentObservation), {
    observedAt: "2026-07-26T02:00:00.000Z",
    captureStatus: "comments_partial",
    observedCount: 2,
    pageTotalCount: 100,
    pageTotalKnown: true,
    partial: true,
    stoppedByUser: false,
    stoppedByStall: false,
    stoppedByNetwork: false,
    stopReason: "network_timeout",
    sampleAvailable: true,
    samples: [
      {commentId: "c1", content: "第一条"},
      {commentId: "c2", content: "第二条"},
    ],
    scope: "visible_comments_bounded",
  });
});

test("does not report backend completion when record sync fails", () => {
  const result = targeted.applySyncResult(
    {
      itemId: "item-1",
      recordIds: ["local-1"],
      status: "completed",
    },
    {
      ok: false,
      successCount: 0,
      failedCount: 1,
      error: {code: "SYNC_REJECTED", message: "后台拒绝写入"},
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.backendSynced, false);
  assert.equal(result.localCaptureCompleted, true);
  assert.equal(result.error.stage, "sync");
  assert.equal(result.error.code, "SYNC_REJECTED");
});

test("reports a target complete only after every captured record syncs", () => {
  const result = targeted.applySyncResult(
    {
      itemId: "item-1",
      recordIds: ["local-1"],
      status: "completed",
    },
    {
      ok: true,
      successCount: 1,
      failedCount: 0,
      pausedCount: 0,
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.backendSynced, true);
  assert.equal(result.sync.status, "completed");
});

test("mergeRunPatch ignores unknown target results and preserves formal checkpoint", () => {
  const request = targeted.createRunRequest(
    targeted.normalizeCommandPayload({
      protocolVersion: 1,
      workflow: "negative_post_patrol",
      taskId: "task-1",
      platform: "douyin",
      planSnapshot: {
        targets: [
          {
            recordId: "record-1",
            url: "https://www.douyin.com/video/123",
          },
        ],
      },
    }),
    {commandId: "command-1", attemptId: "attempt-1"},
  );
  const merged = targeted.mergeRunPatch(request, {
    status: "completed",
    targetResults: [
      {
        itemId: "record-1",
        recordId: "record-1",
        externalId: "123",
        ordinal: 1,
        status: "completed",
      },
      {itemId: "unknown", status: "completed"},
    ],
  });
  assert.equal(merged.status, "completed");
  assert.equal(merged.targetResults.length, 1);
  assert.equal(merged.checkpoint.nextOrdinal, 2);
});
