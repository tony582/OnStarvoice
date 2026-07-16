import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCommentLeadsToPayload,
  applyCommentResultToSingleNotePayload,
} from "../utils/capture-sync.js";

test("failed detail comment capture keeps checkpoint comments and recomputes leads", () => {
  const checkpointItems = [
    {
      commentId: "comment-1",
      content: "想咨询一下报价",
      userName: "客户甲",
      ipLocation: "上海",
      likes: 2,
    },
  ];
  const mergedText = "1、客户甲（上海）：想咨询一下报价（2 个赞）";

  // 批量详情增强会先生成新的 detailPayload；失败结果中的
  // cleanedItems / mergedText 才是上一次已落盘的真实检查点。
  const failedPayload = applyCommentResultToSingleNotePayload(
    {
      url: "https://www.xiaohongshu.com/explore/note-1",
      title: "测试笔记",
      commentsCleanedItems: [],
      commentsMergedText: "",
      commentsTotalCaptured: 0,
      commentLeadsItems: [],
      commentLeadsTotal: 0,
    },
    {
      status: "failed",
      cleanedItems: checkpointItems,
      mergedText,
      error: "网络中断",
    },
  );
  const {payload, leadResult} = applyCommentLeadsToPayload({
    syncType: "single_note",
    payload: failedPayload,
    commentLeadsConfig: {
      enabled: true,
      keywords: ["咨询"],
      ips: [],
    },
    computedAt: 1234,
  });

  assert.equal(payload.commentsCaptureStatus, "failed");
  assert.deepEqual(payload.commentsCleanedItems, checkpointItems);
  assert.equal(payload.commentsMergedText, mergedText);
  assert.equal(payload.commentsTotalCaptured, 1);
  assert.equal(payload.commentLeadsTotal, 1);
  assert.equal(payload.commentLeadsItems.length, 1);
  assert.equal(leadResult.matchedCount, 1);
});

test("successful retry clears the previous interrupted observation", () => {
  const payload = applyCommentResultToSingleNotePayload(
    {
      commentsCaptureStatus: "partial",
      commentsCleanedItems: [{commentId: "old", content: "old"}],
      commentsTotalCaptured: 1,
      commentsObservedBeforeInterrupt: 20,
    },
    {
      status: "done",
      cleanedItems: [
        {commentId: "old", content: "old"},
        {commentId: "new", content: "new"},
      ],
      mergedText: "old\nnew",
      stoppedByUser: false,
    },
  );

  assert.equal(payload.commentsCaptureStatus, "done");
  assert.equal(payload.commentsTotalCaptured, 2);
  assert.equal(
    Object.hasOwn(payload, "commentsObservedBeforeInterrupt"),
    false,
  );
});
