import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  buildCommentLoadStage,
  resolveCommentCaptureStatus,
} from "../utils/capture/stage-diagnostics.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (await readFile(resolve(repoRoot, "utils/scroll.js"), "utf8"))
  .replace("import { randomScrollDistance } from './helpers.js';", "")
  .replace("import { DEFAULT_CONFIG } from './constants.js';", "")
  .replace(/\bexport\s+(?=(?:async\s+)?function\b)/g, "");
const xiaohongshuCommentsSource = await readFile(
  resolve(repoRoot, "utils/capture/comments.js"),
  "utf8",
);
const douyinCommentsSource = await readFile(
  resolve(repoRoot, "utils/capture/douyin-comments.js"),
  "utf8",
);
const contentSource = await readFile(resolve(repoRoot, "content-v2.js"), "utf8");

function createHarness({
  hidden = false,
  setTimeoutImpl = setTimeout,
  DateImpl = Date,
  navigator = {onLine: true},
  requestAnimationFrameImpl = () => 1,
  cancelAnimationFrameImpl = () => {},
} = {}) {
  const scrollCalls = [];
  const listeners = new Map();
  const document = {
    hidden,
    documentElement: {scrollHeight: 5000},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const window = {
    scrollY: 0,
    innerHeight: 800,
    scrollTo(_x, y) {
      this.scrollY = y;
      scrollCalls.push(y);
    },
  };
  const context = vm.createContext({
    DEFAULT_CONFIG: {
      MAX_SCROLL_TIMES: 50,
      NO_NEW_CONTENT_THRESHOLD: 3,
      MAX_CAPTURE_DURATION_MS: 600000,
      SCROLL_DELAY_MIN: 1000,
      SCROLL_DELAY_MAX: 3000,
    },
    Date: DateImpl,
    Math,
    Promise,
    clearTimeout,
    console,
    document,
    navigator,
    randomScrollDistance: () => 500,
    requestAnimationFrame: requestAnimationFrameImpl,
    cancelAnimationFrame: cancelAnimationFrameImpl,
    setTimeout: setTimeoutImpl,
    window,
  });
  vm.runInContext(
    `${source}\n;globalThis.__scrollRecoveryApi = {smoothScrollTo, wait, autoScrollLoad, setCancelFlag};`,
    context,
    {filename: "utils/scroll.js"},
  );
  return {api: context.__scrollRecoveryApi, document, scrollCalls, window};
}

test("hidden-page smooth scroll resolves immediately without an animation frame", async () => {
  const harness = createHarness({hidden: true});
  await harness.api.smoothScrollTo(640, 500);
  assert.equal(harness.window.scrollY, 640);
  assert.deepEqual(harness.scrollCalls, [640]);
});

test("smooth scroll has a wall-clock fallback when requestAnimationFrame never fires", async () => {
  const fastTimeout = (handler, delay, ...args) =>
    setTimeout(handler, Math.min(10, delay), ...args);
  const harness = createHarness({setTimeoutImpl: fastTimeout});

  await Promise.race([
    harness.api.smoothScrollTo(900, 500),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("smooth scroll stayed pending")), 200),
    ),
  ]);

  assert.equal(harness.window.scrollY, 900);
});

test("canceling an in-flight smooth scroll resolves without snapping to its target", async () => {
  let now = 1000;
  const frames = [];
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const harness = createHarness({
    DateImpl: FakeDate,
    requestAnimationFrameImpl: (callback) => {
      frames.push(callback);
      return frames.length;
    },
  });

  const scrolling = harness.api.smoothScrollTo(1000, 1000);
  now = 1250;
  frames.shift()();
  const positionWhenCanceled = harness.window.scrollY;

  harness.api.setCancelFlag(true);
  frames.shift()();

  await Promise.race([
    scrolling,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("canceled smooth scroll stayed pending")), 200),
    ),
  ]);

  assert.ok(positionWhenCanceled > 0 && positionWhenCanceled < 1000);
  assert.equal(harness.window.scrollY, positionWhenCanceled);
  assert.ok(!harness.scrollCalls.includes(1000));
});

test("wait uses Date.now so a sleep-sized wall-clock jump completes on first tick", async () => {
  let now = 1000;
  let timerCalls = 0;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const jumpingTimeout = (handler) => {
    timerCalls += 1;
    now += 10_000;
    return setTimeout(handler, 0);
  };
  const harness = createHarness({
    setTimeoutImpl: jumpingTimeout,
    DateImpl: FakeDate,
  });

  await harness.api.wait(5000);
  assert.equal(timerCalls, 1);
});

test("offline capture pauses and resumes the same scroll loop after reconnecting", async () => {
  const navigator = {onLine: false};
  const phases = [];
  let now = 1000;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const reconnectingTimeout = (handler, delay, ...args) => {
    if (!navigator.onLine) navigator.onLine = true;
    now += Math.max(1, Number(delay) || 0);
    return setTimeout(handler, 0, ...args);
  };
  const harness = createHarness({
    DateImpl: FakeDate,
    navigator,
    setTimeoutImpl: reconnectingTimeout,
  });

  const result = await harness.api.autoScrollLoad({
    maxScrollTimes: 1,
    detectNewContent: () => 1,
    stopWhen: () => ({stop: true, reason: "enough"}),
    onProgress: (progress) => phases.push(progress.phase),
  });

  assert.ok(phases.includes("network_paused"));
  assert.ok(phases.includes("network_resumed"));
  assert.equal(result.stopReason, "enough");
});

test("long offline capture returns a retryable stop instead of waiting forever", async () => {
  const navigator = {onLine: false};
  const phases = [];
  let now = 1000;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const advancingTimeout = (handler, delay, ...args) => {
    now += Math.max(5000, Number(delay) || 0);
    return setTimeout(handler, 0, ...args);
  };
  const harness = createHarness({
    DateImpl: FakeDate,
    navigator,
    setTimeoutImpl: advancingTimeout,
  });

  const result = await harness.api.autoScrollLoad({
    maxScrollTimes: 1,
    onProgress: (progress) => phases.push(progress.phase),
  });

  assert.ok(phases.includes("network_paused"));
  assert.ok(phases.includes("network_timeout"));
  assert.equal(result.stopReason, "network_timeout");
  assert.equal(result.stalled, true);
  assert.equal(result.networkTimedOut, true);
});

test("a cancel raised during comment initialization survives auto-scroll entry", async () => {
  const harness = createHarness();
  harness.api.setCancelFlag(true);

  const result = await harness.api.autoScrollLoad({
    maxScrollTimes: 3,
    resetCancelOnStart: false,
  });

  assert.equal(result.canceled, true);
  assert.equal(result.scrollCount, 0);
});

test("an explicit null scroll ceiling can continue past the former 50-scroll comment limit", async () => {
  const harness = createHarness();
  let loadedCount = 0;

  const result = await harness.api.autoScrollLoad({
    maxScrollTimes: null,
    noNewContentThreshold: 0,
    maxDurationMs: 60_000,
    waitMinMs: 0,
    waitMaxMs: 0,
    detectNewContent: () => loadedCount,
    scrollStep: async () => {
      loadedCount += 1;
    },
    stopWhen: ({currentContentCount}) =>
      currentContentCount >= 55
        ? {stop: true, reason: "max_items"}
        : {stop: false},
  });

  assert.equal(result.stopReason, "max_items");
  assert.equal(result.scrollCount, 55);
  assert.equal(result.maxScrollTimes, null);
});

test("both platform comment collectors omit a fixed scroll ceiling by default", () => {
  for (const platformSource of [
    xiaohongshuCommentsSource,
    douyinCommentsSource,
  ]) {
    assert.match(platformSource, /maxScrollTimes\s*=\s*null/u);
    assert.match(
      platformSource,
      /maxScrollTimes:\s*normalizedMaxScrollTimes/u,
    );
    assert.match(platformSource, /resolveCommentCaptureStatus\(\{/u);
  }

  const handlerStart = contentSource.indexOf("async function handleCaptureComments");
  const handlerEnd = contentSource.indexOf(
    "/**\n * \u5904\u7406\u53d6\u6d88\u91c7\u96c6",
    handlerStart,
  );
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handlerSource = contentSource.slice(handlerStart, handlerEnd);
  assert.match(handlerSource, /maxScrollTimes:\s*request\.maxScrollTimes/u);
  assert.doesNotMatch(handlerSource, /maxScrollTimes:[^\n]*\|\|\s*50/u);

  const stage = buildCommentLoadStage({
    maxScrollTimes: null,
    scrollResult: {maxScrollTimes: null},
  });
  assert.equal(stage.metrics.maxScrollTimes, null);
});

test("an explicit scroll ceiling remains diagnostic instead of looking complete", async () => {
  const phases = [];
  const harness = createHarness();

  const result = await harness.api.autoScrollLoad({
    maxScrollTimes: 2,
    noNewContentThreshold: 0,
    maxDurationMs: 60_000,
    waitMinMs: 0,
    waitMaxMs: 0,
    detectNewContent: ({scrollCount} = {}) => Number(scrollCount || 0),
    scrollStep: async () => {},
    onProgress: (progress) => phases.push(progress.phase),
  });

  assert.equal(result.stopReason, "max_scroll");
  assert.equal(result.completed, false);
  assert.equal(result.scrollCount, 2);
  assert.ok(phases.includes("max_reached"));
  assert.equal(
    resolveCommentCaptureStatus({scrollResult: result}),
    "partial",
  );
});

test("comment capture status treats only interruption and safety ceilings as partial", () => {
  for (const stopReason of ["max_scroll", "max_duration"]) {
    assert.equal(
      resolveCommentCaptureStatus({scrollResult: {stopReason}}),
      "partial",
    );
  }
  assert.equal(
    resolveCommentCaptureStatus({scrollResult: {stopReason: "max_items"}}),
    "done",
  );
  assert.equal(
    resolveCommentCaptureStatus({
      scrollResult: {stopReason: "comment_area_exhausted"},
    }),
    "done",
  );
  assert.equal(
    resolveCommentCaptureStatus({scrollResult: {stalled: true}}),
    "partial",
  );
});

test("a sleep-sized freeze is excluded from active capture duration", async () => {
  let now = 1000;
  let detectedCount = 0;
  const phases = [];
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const harness = createHarness({DateImpl: FakeDate});

  const result = await harness.api.autoScrollLoad({
    maxScrollTimes: 2,
    maxDurationMs: 10_000,
    detectNewContent: () => {
      detectedCount += 1;
      return detectedCount;
    },
    scrollStep: async () => {
      now += 8 * 60 * 60 * 1000;
    },
    stopWhen: ({currentContentCount}) =>
      currentContentCount >= 2
        ? {stop: true, reason: "enough"}
        : {stop: false},
    onProgress: (progress) => phases.push(progress.phase),
  });

  assert.ok(phases.includes("system_resumed"));
  assert.equal(result.stopReason, "enough");
  assert.ok(result.elapsedMs < 10_000);
  assert.ok(result.pausedDurationMs >= 8 * 60 * 60 * 1000);
});

test("resume clears pre-sleep no-growth rounds before deciding the page stalled", async () => {
  let now = 1000;
  let scrollCalls = 0;
  const phases = [];
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const harness = createHarness({DateImpl: FakeDate});

  const result = await harness.api.autoScrollLoad({
    maxScrollTimes: 3,
    noNewContentThreshold: 2,
    maxDurationMs: 10_000,
    waitMinMs: 0,
    waitMaxMs: 0,
    detectNewContent: () => 0,
    scrollStep: async () => {
      scrollCalls += 1;
      if (scrollCalls === 1) {
        now += 8 * 60 * 60 * 1000;
      }
    },
    stopWhen: ({scrollCount}) =>
      scrollCount >= 2
        ? {stop: true, reason: "enough"}
        : {stop: false},
    onProgress: (progress) => phases.push(progress.phase),
  });

  assert.ok(phases.includes("system_resumed"));
  assert.equal(result.stopReason, "enough");
  assert.equal(result.noNewContentCount, 1);
});
