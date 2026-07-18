import assert from "node:assert/strict";
import test from "node:test";

const {
  extractDouyinPublishDateCandidate,
  normalizeDouyinPublishDate,
} = await import(
  `../../utils/capture/douyin-single-note.js?publish-time-test=${Date.now()}`
);
const {resolveSyncInputForRecord} = await import(
  `../../utils/capture-sync.js?publish-time-test=${Date.now()}`
);

test("Douyin detail publish time preserves the visible full timestamp", () => {
  assert.equal(
    extractDouyinPublishDateCandidate("发布时间：2026-01-05 21:44"),
    "2026-01-05 21:44",
  );
  assert.equal(
    normalizeDouyinPublishDate("发布时间：2026-01-05 21:44"),
    "2026-01-05 21:44:00",
  );
});

test("Douyin detail publish time keeps API ISO timestamps", () => {
  assert.equal(
    normalizeDouyinPublishDate("2025-11-03T08:39:02.000Z"),
    "2025-11-03T08:39:02.000Z",
  );
});

test("missing or invalid Douyin detail dates stay empty instead of becoming today", () => {
  const referenceDate = new Date(2026, 6, 16, 12, 0, 0);

  assert.equal(normalizeDouyinPublishDate("", referenceDate), "");
  assert.equal(normalizeDouyinPublishDate("00:15", referenceDate), "");
  assert.equal(normalizeDouyinPublishDate("00-15", referenceDate), "");
  assert.equal(normalizeDouyinPublishDate("视频不存在", referenceDate), "");
});

test("Douyin detail timestamp overrides a stale list-card date in the sync payload", () => {
  const syncInput = resolveSyncInputForRecord({
    id: "record-douyin-publish-time",
    platform: "douyin",
    type: "keyword_notes",
    payload: {
      keyword: "吉事桔香茶",
      detailCaptureStatus: "done",
      items: [
        {
          noteId: "7591873004130191546",
          url: "https://www.douyin.com/video/7591873004130191546",
          publishDate: "2026-07-16",
          publishDateRaw: "00-15",
        },
      ],
      detailPayload: {
        noteId: "7591873004130191546",
        url: "https://www.douyin.com/video/7591873004130191546",
        publishTime: "2026-01-05 21:44:00",
        publishDateRaw: "2026-01-05 21:44",
        lastEditedAt: "2026-01-05 21:44:00",
      },
    },
  });

  assert.equal(syncInput.syncType, "keyword_notes");
  assert.equal(syncInput.payload.items[0].publishTime, "2026-01-05 21:44:00");
  assert.equal(syncInput.payload.items[0].publishDateRaw, "2026-01-05 21:44");
});
