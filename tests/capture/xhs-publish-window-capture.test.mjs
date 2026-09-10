import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {DEFAULT_CONFIG, PAGE_TYPE, SYNC_TYPE} from "../../utils/constants.js";
import {cleanText, parseInteractionCount} from "../../utils/helpers.js";
import {
  buildFilterApplyStage,
  buildListParseStage,
  buildScrollLoadStage,
  countMissingMetric,
} from "../../utils/capture/stage-diagnostics.js";
import {
  isOutsideXhsPublishWindow,
  isXhsPublishTimeWindow,
} from "../../utils/capture/xhs-publish-window.js";

const source = (await readFile(
  new URL("../../utils/capture/keyword-search.js", import.meta.url),
  "utf8",
)).replace(/^import\b[\s\S]*?;\n/gm, "").replace(/^export /gm, "");

const REFERENCE = new Date(2026, 8, 10, 12, 0, 0).getTime();

function note(noteId, publishDateRaw, likes = 10) {
  return {
    noteId,
    url: `https://www.xiaohongshu.com/explore/${noteId}`,
    title: `笔记 ${noteId}`,
    publishDateRaw,
    likes,
  };
}

function createRuntime(items, {advanceDuringScrollMs = 0} = {}) {
  let now = REFERENCE;
  const observed = {progress: [], stops: []};
  class CaptureDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return now;
    }
  }

  const context = vm.createContext({
    Date: CaptureDate,
    URL,
    DEFAULT_CONFIG,
    PAGE_TYPE,
    SYNC_TYPE,
    cleanText,
    parseInteractionCount,
    buildFilterApplyStage,
    buildListParseStage,
    buildScrollLoadStage,
    countMissingMetric,
    isOutsideXhsPublishWindow,
    isXhsPublishTimeWindow,
    window: {location: {href: "https://www.xiaohongshu.com/search_result?keyword=test"}},
    console: {warn() {}, error() {}},
    resetCancelFlag() {},
    isCanceled: () => false,
    wait: async () => {},
    autoScrollLoad: async (options) => {
      now += advanceDuringScrollMs;
      const currentContentCount = options.detectNewContent();
      const stop = options.stopWhen({currentContentCount, noNewContentCount: 0});
      observed.stops.push(stop);
      options.onProgress({phase: "scroll"});
      return {
        scrollCount: 0,
        maxScrollTimes: options.maxScrollTimes,
        completed: true,
        canceled: false,
        stopReason: stop.stop ? stop.reason : "max_scroll",
        finalContentCount: currentContentCount,
        noNewContentCount: 0,
        elapsedMs: advanceDuringScrollMs,
      };
    },
    fixtureItems: items,
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    fixtureItems = fixtureItems.map((item) => ({
      ...item, publishTimestamp: parsePublishTimestamp(item.publishDateRaw),
    }));
    extractNoteCards = () => fixtureItems;
    detectKeywordSortDimension = () => ({dimension: "likes", source: "test"});
  `, context);

  return {
    observed,
    run: (options = {}) => context.captureKeywordNotes({
      keyword: "test",
      maxDetectedItems: items.length,
      maxScrollTimes: 1,
      onProgress: (progress) => observed.progress.push(progress),
      ...options,
    }),
  };
}

function ids(items) {
  return Array.from(items, (item) => item.noteId);
}

test("XHS filters old items from both checkpoints and final results while retaining unknown dates", async () => {
  const runtime = createRuntime([
    note("old2025", "2025-06-19"),
    note("fresh2026", "3小时前"),
    note("unknown", ""),
    note("lowlikes", "刚刚", 2),
  ]);
  const result = await runtime.run({publishTimeWindow: "day", minLikes: 5});

  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(ids(result.data.items), ["fresh2026", "unknown"]);
  assert.equal(result.data.rawTotalCount, 4);
  assert.equal(result.data.publishWindowExcludedCount, 1);
  assert.equal(result.data.filteredBeforeLimitCount, 2);
  const checkpoints = runtime.observed.progress.filter((entry) => entry.listCheckpoint);
  assert.equal(checkpoints.length, 1);
  assert.deepEqual(ids(checkpoints[0].listCheckpoint.items), ["fresh2026", "unknown"]);
  assert.equal(checkpoints[0].listCheckpoint.payload.publishWindowExcludedCount, 1);
  assert.equal(result.meta.scrollInfo.stopReason, "max_items");
});

test("unselected or unsupported time windows preserve the existing metric-only capture", async () => {
  for (const publishTimeWindow of [undefined, "", "不限", "unsupported"]) {
    const runtime = createRuntime([
      note("old2025", "2025-06-19"),
      note("early2026", "2026-01-05"),
      note("lowlikes", "刚刚", 2),
    ]);
    const result = await runtime.run({publishTimeWindow, minLikes: 5});

    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(ids(result.data.items), ["old2025", "early2026"]);
    assert.equal(result.data.publishWindowExcludedCount, 0);
    assert.equal(result.diagnostics.emptyReason, "");
  }
});

test("all expired cards yield a successful diagnosed empty result without increasing the capture limit", async () => {
  const runtime = createRuntime([
    note("old2025", "2025-06-19"),
    note("early2026", "2026-01-05"),
  ]);
  const result = await runtime.run({publishTimeWindow: "day"});

  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.items.length, 0);
  assert.equal(result.data.rawTotalCount, 2);
  assert.equal(result.data.maxDetectedItems, 2);
  assert.equal(result.data.publishWindowExcludedCount, 2);
  assert.equal(result.meta.scrollInfo.stopReason, "max_items");
  assert.equal(result.diagnostics.emptyReason, "all_items_outside_publish_window");
  const filterStage = result.diagnostics.stageTrace.find((entry) => entry.stageKey === "capture.filter_apply");
  assert.equal(filterStage.metrics.allItemsOutsidePublishWindow, true);
  assert.equal(filterStage.metrics.publishWindowExcludedCount, 2);
  assert.equal(runtime.observed.progress.some((entry) => entry.listCheckpoint), false);
});

test("the time window uses the same reference during checkpoints and final extraction", async () => {
  const runtime = createRuntime([note("fresh2026", "2026-09-10")], {
    advanceDuringScrollMs: 3 * 24 * 60 * 60 * 1000,
  });
  const result = await runtime.run({publishTimeWindow: "day"});

  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(ids(result.data.items), ["fresh2026"]);
  assert.equal(result.data.publishWindowReferenceTimestamp, REFERENCE);
  assert.equal(result.data.publishWindowExcludedCount, 0);
  const checkpoint = runtime.observed.progress.find((entry) => entry.listCheckpoint);
  assert.equal(checkpoint.listCheckpoint.payload.publishWindowReferenceTimestamp, REFERENCE);
});


test("old-looking author nicknames remain in incremental and final captures", async () => {
  const runtime = createRuntime([{...note("ambiguous", "2025-06-19"), publishDateSource: "author_line"}]);
  const result = await runtime.run({publishTimeWindow: "day"});
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.publishWindowExcludedCount, 0);
  assert.equal(runtime.observed.progress.find(entry => entry.listCheckpoint).listCheckpoint.items.length, 1);
});
