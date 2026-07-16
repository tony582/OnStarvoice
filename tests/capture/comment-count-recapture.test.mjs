import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const stored = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          requested
            .filter((key) => Object.hasOwn(stored, key))
            .map((key) => [key, stored[key]]),
        );
      },
      async set(values) {
        Object.assign(stored, values);
      },
    },
  },
};

const settingsApi = await import(
  "../../utils/capture-settings.js?comment-count-recapture-tests"
);
const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);
const serverSyncSource = await readFile(
  new URL("../../server/routes/sync.js", import.meta.url),
  "utf8",
);

test("comment-count recapture is enabled by default and persists an explicit opt-out", async () => {
  const key =
    settingsApi.CAPTURE_SETTINGS_KEYS.RECAPTURE_COMMENTS_ON_COUNT_INCREASE;
  assert.equal(key, "capture.recaptureCommentsOnCountIncrease");
  assert.equal(
    settingsApi.DEFAULT_CAPTURE_SETTINGS.recaptureCommentsOnCountIncrease,
    true,
  );
  assert.equal((await settingsApi.getCaptureSettings()).recaptureCommentsOnCountIncrease, true);

  const saved = await settingsApi.saveCaptureSettings({
    recaptureCommentsOnCountIncrease: false,
  });
  assert.equal(stored[key], false);
  assert.equal(saved.recaptureCommentsOnCountIncrease, false);
});

test("comment growth compares against a durable baseline and never guesses without one", () => {
  const normalizeStart = captureSyncSource.indexOf(
    "function normalizeOptionalCount(value)",
  );
  const normalizeEnd = captureSyncSource.indexOf(
    "function pickFirstCountFromSources",
    normalizeStart,
  );
  const baselineStart = captureSyncSource.indexOf(
    "function resolveCapturedCommentBaseline",
  );
  const baselineEnd = captureSyncSource.indexOf(
    "function isValidBloggerMetricsStatus",
    baselineStart,
  );
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
  assert.ok(baselineStart >= 0 && baselineEnd > baselineStart);

  const context = vm.createContext({
    parseInteractionCount(value) {
      return Number(value);
    },
  });
  vm.runInContext(
    `${captureSyncSource.slice(normalizeStart, normalizeEnd)}\n` +
      `${captureSyncSource.slice(baselineStart, baselineEnd)}\n` +
      "this.hasIncreased = hasCommentCountIncreasedSinceLastCapture;",
    context,
  );

  assert.equal(
    context.hasIncreased({
      currentCommentsCount: 11,
      localStatus: {hasBaseline: true, commentsBaselineCount: 10},
      remoteStatus: {hasBaseline: true, commentsBaselineCount: 20},
    }),
    false,
  );
  assert.equal(
    context.hasIncreased({
      currentCommentsCount: 11,
      localStatus: {
        hasBaseline: true,
        commentsBaselineCount: 10,
        capturedAt: 200,
      },
      remoteStatus: {
        hasBaseline: true,
        commentsBaselineCount: 20,
        capturedAt: 100,
      },
    }),
    true,
  );
  assert.equal(
    context.hasIncreased({
      currentCommentsCount: 11,
      localStatus: {
        hasBaseline: true,
        commentsBaselineCount: 10,
        capturedAt: 100,
      },
      remoteStatus: {
        hasBaseline: true,
        commentsBaselineCount: 20,
        capturedAt: 200,
      },
    }),
    false,
  );
  assert.equal(
    context.hasIncreased({
      currentCommentsCount: 20,
      localStatus: {hasBaseline: true, commentsBaselineCount: 20},
    }),
    false,
  );
  assert.equal(
    context.hasIncreased({
      currentCommentsCount: 13,
      remoteStatus: {hasBaseline: false, commentsCount: 12},
    }),
    true,
  );
  assert.equal(
    context.hasIncreased({currentCommentsCount: 13}),
    false,
  );
});

test("captured items are skipped except the comment-growth exception and its new baseline", () => {
  const start = captureSyncSource.indexOf(
    "export async function batchCaptureDetailsForRecords",
  );
  const end = captureSyncSource.indexOf("const results = [];", start);
  const precheck = captureSyncSource.slice(start, end);
  assert.match(precheck, /resolvedRecaptureCommentsOnIncrease/);
  assert.match(precheck, /hasCommentCountIncreasedSinceLastCapture/);
  assert.match(precheck, /nextRecaptureCommentRecordIds\.push\(p\.recordId\)/);
  assert.match(precheck, /nextSkipRecordIds\.push\(p\.recordId\)/);

  assert.match(
    captureSyncSource,
    /nextPayloadBase\.detailCommentCountBaseline = nextCommentBaseline/,
  );
  assert.match(
    captureSyncSource,
    /existingRecord\.payload\.detailCommentCountBaseline = previous/,
  );
  assert.match(captureSyncSource, /capturedAt: normalizeOptionalTimestamp/);
  assert.match(serverSyncSource, /detailCaptureFinishedAt/);
  assert.match(serverSyncSource, /capturedAt:/);
});
