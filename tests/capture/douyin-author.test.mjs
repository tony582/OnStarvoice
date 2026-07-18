import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeDouyinAuthorName,
  pickDouyinAuthorName,
} from "../../utils/capture/douyin-author.js";
import {resolveSyncInputForRecord} from "../../utils/capture-sync.js";

test("removes Douyin verification accessibility labels from author names", () => {
  assert.equal(
    normalizeDouyinAuthorName("吉事桔香茶认证徽章商家认证账号"),
    "吉事桔香茶",
  );
  assert.equal(
    normalizeDouyinAuthorName("@ 吉事桔香茶 官方认证"),
    "吉事桔香茶",
  );
  assert.equal(
    normalizeDouyinAuthorName("吉事桔香茶认证徽章品牌认证账号已关注"),
    "吉事桔香茶",
  );
});

test("keeps ordinary author names intact", () => {
  assert.equal(normalizeDouyinAuthorName("认证生活研究所"), "认证生活研究所");
  assert.equal(pickDouyinAuthorName("我的", "可心"), "可心");
});

test("a conflicting detail-page brand account cannot overwrite the list author", () => {
  const syncInput = resolveSyncInputForRecord({
    id: "record-douyin-author-conflict",
    platform: "douyin",
    type: "keyword_notes",
    payload: {
      keyword: "吉事桔香茶",
      detailCaptureStatus: "done",
      items: [
        {
          noteId: "7591873004130191546",
          url: "https://www.douyin.com/video/7591873004130191546",
          author: "白瀚白瀚",
          authorId: "list-author-id",
          authorUrl: "https://www.douyin.com/user/list-author",
        },
      ],
      detailPayload: {
        noteId: "7591873004130191546",
        url: "https://www.douyin.com/video/7591873004130191546",
        author: "吉事桔香茶认证徽章商家认证账号",
        authorId: "detail-brand-id",
        authorUrl: "https://www.douyin.com/user/detail-brand",
      },
    },
  });

  assert.equal(syncInput.payload.items[0].author, "白瀚白瀚");
  assert.equal(syncInput.payload.items[0].authorId, "list-author-id");
  assert.equal(
    syncInput.payload.items[0].authorUrl,
    "https://www.douyin.com/user/list-author",
  );
});
