import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

import {
  buildListHarvestEventFromProgress,
  buildListHarvestItemAliases,
  createListCaptureDebugOverlay,
  createListCaptureOverlayRunScope,
  createListHarvestState,
  describeListHarvestState,
  evaluateListCaptureElementIdentity,
  formatTaskTakeoverCountdown,
  normalizeListHarvestItemOutcome,
  normalizeTaskTakeoverProgress,
  reduceListHarvestState,
  resolveTaskTakeoverWaitState,
} from "../../utils/capture/list-capture-debug-overlay.js";
import {createListCaptureAcceptanceLedger} from "../../utils/capture/list-capture-trace.js";

const DEFAULT_RUN_ID = "trace-run-a";

function captureTrace(sequence, noteId, overrides = {}) {
  return {
    version: 1,
    runId: DEFAULT_RUN_ID,
    sequence,
    identityKey: `id:${String(noteId).toLowerCase()}`,
    state: "accepted",
    ...overrides,
  };
}

function tracedItem(sequence, noteId = `note-${sequence}`, overrides = {}) {
  return {
    noteId,
    url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_source=pc_search`,
    title: `笔记 ${sequence}`,
    ...overrides,
    captureTrace: captureTrace(sequence, noteId, overrides.captureTrace),
  };
}

function startSession(sessionId = DEFAULT_RUN_ID) {
  return reduceListHarvestState(createListHarvestState(), {
    type: "start",
    sessionId,
    platform: "xiaohongshu",
    now: 100,
  });
}

function identityElement(attributes = {}, descendants = []) {
  return {
    id: attributes.id || "",
    innerText: attributes.innerText || "",
    textContent: attributes.textContent || attributes.innerText || "",
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    querySelectorAll() {
      return descendants;
    },
  };
}

function createOverlayDomHarness() {
  class FakeStyle {
    setProperty() {}
  }

  class FakeElement {
    constructor(tagName = "div") {
      this.tagName = tagName;
      this.attributes = new Map();
      this.children = [];
      this.parentNode = null;
      this.style = new FakeStyle();
      this.dataset = {};
      this.className = "";
      this.textContent = "";
      this.hidden = false;
      this.isConnected = false;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    appendChild(child) {
      child.parentNode = this;
      child.isConnected = this.isConnected;
      this.children.push(child);
      return child;
    }

    append(...children) {
      children.forEach((child) => this.appendChild(child));
    }

    attachShadow() {
      return new FakeElement("#shadow-root");
    }

    querySelectorAll() {
      return [];
    }

    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter(
          (child) => child !== this,
        );
      }
      this.parentNode = null;
      this.isConnected = false;
    }
  }

  const documentElement = new FakeElement("html");
  documentElement.isConnected = true;
  const documentRef = {
    documentElement,
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    querySelectorAll() {
      return [];
    },
  };
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  let intervalSequence = 0;
  const intervals = new Map();
  const windowRef = {
    MutationObserver: FakeMutationObserver,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {},
    setInterval(callback) {
      intervalSequence += 1;
      intervals.set(intervalSequence, callback);
      return intervalSequence;
    },
    clearInterval(timerId) {
      intervals.delete(timerId);
    },
  };
  return {
    documentRef,
    windowRef,
    runIntervals() {
      Array.from(intervals.values()).forEach((callback) => callback());
    },
    getActiveIntervalCount() {
      return intervals.size;
    },
  };
}

test("task takeover wait state uses an absolute reported deadline without inventing ETA", () => {
  const reportedAt = 1_700_000_000_000;
  assert.deepEqual(normalizeTaskTakeoverProgress(null), null);
  assert.deepEqual(
    normalizeTaskTakeoverProgress({
      phase: " INTER_KEYWORD_DELAY ",
      remainingMs: 7500,
      updatedAt: reportedAt,
      nextKeyword: "别克壁纸",
    }),
    {
      phase: "inter_keyword_delay",
      message: "",
      reason: "",
      nextKeyword: "别克壁纸",
      remainingMs: 7500,
      updatedAt: reportedAt,
      waitUntil: "",
    },
  );

  const relative = resolveTaskTakeoverWaitState(
    {
      phase: "inter_keyword_delay",
      remainingMs: 7500,
      updatedAt: reportedAt,
      nextKeyword: "别克壁纸",
    },
    reportedAt + 2000,
  );
  assert.equal(relative.waiting, true);
  assert.equal(relative.deadlineAt, reportedAt + 7500);
  assert.equal(relative.remainingMs, 5500);
  assert.equal(relative.nextKeyword, "别克壁纸");

  const explicit = resolveTaskTakeoverWaitState(
    {
      phase: "waiting_next_round",
      remainingMs: 99_000,
      updatedAt: reportedAt,
      waitUntil: reportedAt + 15_000,
    },
    reportedAt + 10_000,
  );
  assert.equal(explicit.waiting, true);
  assert.equal(explicit.deadlineAt, reportedAt + 15_000);
  assert.equal(explicit.remainingMs, 5000);

  const missingAnchor = resolveTaskTakeoverWaitState(
    {
      phase: "keyword_retry_wait",
      remainingMs: 5000,
    },
    reportedAt,
  );
  assert.equal(missingAnchor.waiting, false);
  assert.equal(missingAnchor.deadlineAt, 0);

  const ordinary = resolveTaskTakeoverWaitState(
    {
      phase: "capturing",
      remainingMs: 5000,
      updatedAt: reportedAt,
    },
    reportedAt,
  );
  assert.equal(ordinary.waiting, false);
  const resultRetry = resolveTaskTakeoverWaitState(
    {
      phase: "waiting_results",
      remainingMs: 3000,
      updatedAt: reportedAt,
    },
    reportedAt + 1000,
  );
  assert.equal(resultRetry.waiting, true);
  assert.equal(resultRetry.remainingMs, 2000);
  assert.equal(resultRetry.reason, "搜索结果正在加载，稍后自动重试");
  assert.equal(formatTaskTakeoverCountdown(5500), "00:06");
  assert.equal(formatTaskTakeoverCountdown(3_661_000), "01:01:01");
});

test("task takeover expands only explicit waits and updates its countdown in DOM only", () => {
  let now = 1_700_000_100_000;
  const harness = createOverlayDomHarness();
  const overlay = createListCaptureDebugOverlay({
    documentRef: harness.documentRef,
    windowRef: harness.windowRef,
    now: () => now,
  });

  const ordinary = overlay.setTaskTakeover({
    active: true,
    label: "AI 正在接管",
    progress: {
      phase: "capturing",
      message: "正在读取并筛选列表",
      remainingMs: 5000,
      updatedAt: now,
    },
  });
  const host = overlay.getHost();
  assert.equal(ordinary.waiting, false);
  assert.equal(host.getAttribute("data-takeover-waiting"), "false");
  assert.equal(host.getAttribute("data-takeover-label"), "正在读取并筛选列表");
  assert.equal(harness.getActiveIntervalCount(), 0);

  const waiting = overlay.setTaskTakeover({
    active: true,
    label: "AI 正在接管",
    progress: {
      phase: "inter_keyword_delay",
      message: "本词已完成，等待安全间隔",
      reason: "降低连续访问频率",
      remainingMs: 5000,
      updatedAt: now,
      nextKeyword: "别克壁纸",
    },
  });
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.deadlineAt, 1_700_000_105_000);
  assert.equal(host.getAttribute("data-takeover-waiting"), "true");
  assert.equal(
    host.getAttribute("data-takeover-next-keyword"),
    "别克壁纸",
  );
  assert.equal(
    host.getAttribute("data-takeover-reason"),
    "降低连续访问频率",
  );
  assert.equal(host.getAttribute("data-takeover-remaining-ms"), "5000");
  assert.equal(harness.getActiveIntervalCount(), 1);
  const stateBeforeCountdownTicks = overlay.getState();

  now = 1_700_000_103_250;
  harness.runIntervals();
  assert.equal(host.getAttribute("data-takeover-remaining-ms"), "1750");
  assert.deepEqual(overlay.getState(), stateBeforeCountdownTicks);

  now = 1_700_000_105_000;
  harness.runIntervals();
  assert.equal(host.getAttribute("data-takeover-remaining-ms"), "0");
  assert.equal(host.getAttribute("data-takeover-waiting"), "false");
  assert.equal(
    host.getAttribute("data-takeover-label"),
    "等待结束，正在继续",
  );
  assert.equal(host.getAttribute("data-takeover-deadline-at"), "");
  assert.equal(host.getAttribute("data-takeover-next-keyword"), "");
  assert.equal(host.getAttribute("data-takeover-reason"), "");
  assert.deepEqual(overlay.getState(), stateBeforeCountdownTicks);
  assert.equal(harness.getActiveIntervalCount(), 0);

  overlay.setTaskTakeover({active: false});
  assert.equal(host.getAttribute("data-takeover-visible"), "false");
  assert.equal(host.getAttribute("data-takeover-waiting"), "false");
  assert.equal(harness.getActiveIntervalCount(), 0);
  overlay.destroy();
});

test("task takeover timer is cleared by trace cleanup and reduced motion disables breathing", () => {
  let now = 1_700_000_200_000;
  const harness = createOverlayDomHarness();
  const overlay = createListCaptureDebugOverlay({
    documentRef: harness.documentRef,
    windowRef: harness.windowRef,
    now: () => now,
  });
  overlay.setTaskTakeover({
    active: true,
    progress: {
      phase: "scheduled-waiting",
      waitUntil: now + 60_000,
      updatedAt: now,
    },
  });
  assert.equal(harness.getActiveIntervalCount(), 1);
  overlay.clearTaskTrace();
  assert.equal(harness.getActiveIntervalCount(), 0);

  const overlaySource = readFileSync(
    new URL(
      "../../utils/capture/list-capture-debug-overlay.js",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    overlaySource,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.takeover-live-dot[\s\S]*?animation: none/,
  );
});

test("content takeover protocol forwards progress to the page overlay", () => {
  const contentSource = readFileSync(
    new URL("../../content-v2.js", import.meta.url),
    "utf8",
  );
  assert.match(
    contentSource,
    /overlay\.setTaskTakeover\(\{[\s\S]*?active: true,[\s\S]*?progress: normalizedProgress/,
  );
  assert.match(
    contentSource,
    /Object\.prototype\.hasOwnProperty\.call\(request \|\| \{\}, "progress"\)/,
  );
  assert.match(
    contentSource,
    /takeoverOptions\.progress =[\s\S]*?request\?\.progress/,
  );
});

test("externally assigned captureTrace numbers 1 through 40 remain the source of truth", () => {
  const items = Array.from({length: 40}, (_, index) =>
    tracedItem(index + 1),
  );
  const state = reduceListHarvestState(startSession(), {
    type: "checkpoint",
    items,
    detectedCount: 47,
    now: 200,
  });

  assert.equal(state.acceptedCount, 40);
  assert.equal(state.detectedCount, 47);
  assert.deepEqual(
    state.entries.map((entry) => entry.sequence),
    Array.from({length: 40}, (_, index) => index + 1),
  );
  assert.deepEqual(
    state.entries.map((entry) => entry.item.captureTrace.sequence),
    Array.from({length: 40}, (_, index) => index + 1),
  );
  assert.equal(state.entries.at(-1).item.noteId, "note-40");
});

test("the reducer preserves external numbers instead of inventing array positions", () => {
  const items = [
    tracedItem(12, "external-twelve"),
    tracedItem(4, "external-four"),
    tracedItem(9, "external-nine"),
  ];
  const state = reduceListHarvestState(startSession(), {
    type: "checkpoint",
    items,
  });

  assert.deepEqual(
    state.entries.map(({sequence, item}) => [sequence, item.noteId]),
    [
      [12, "external-twelve"],
      [4, "external-four"],
      [9, "external-nine"],
    ],
  );
});

test("items without a valid captureTrace fail closed and never enter marker state", () => {
  const state = reduceListHarvestState(startSession(), {
    type: "checkpoint",
    items: [
      {noteId: "missing-trace"},
      {
        noteId: "invalid-sequence",
        captureTrace: captureTrace(0, "invalid-sequence"),
      },
      {
        noteId: "wrong-run",
        captureTrace: captureTrace(1, "wrong-run", {runId: "another-run"}),
      },
      tracedItem(1, "accepted-one"),
    ],
  });

  assert.equal(state.acceptedCount, 1);
  assert.deepEqual(
    state.entries.map(({sequence, item}) => [sequence, item.noteId]),
    [[1, "accepted-one"]],
  );
});

test("repeat checkpoints merge one traced identity without changing its number", () => {
  let state = startSession();
  state = reduceListHarvestState(state, {
    type: "checkpoint",
    items: [
      tracedItem(7, "abc123", {title: "首次标题"}),
      tracedItem(11, "xyz789"),
    ],
  });
  state = reduceListHarvestState(state, {
    type: "checkpoint",
    items: [
      tracedItem(7, "abc123", {
        title: "更新后的标题",
        captureTrace: {state: "saved", recordId: "record-abc"},
      }),
      tracedItem(11, "xyz789", {likes: 88}),
    ],
  });

  assert.equal(state.acceptedCount, 2);
  assert.deepEqual(
    state.entries.map((entry) => entry.sequence),
    [7, 11],
  );
  assert.equal(state.entries[0].item.title, "更新后的标题");
  assert.equal(state.entries[0].item.captureTrace.recordId, "record-abc");
  assert.equal(state.entries[0].item.captureTrace.state, "saved");
  assert.equal(state.entries[1].item.likes, 88);
});

test("record and detail bindings update the same trace without renumbering it", () => {
  const overlay = createListCaptureDebugOverlay({
    documentRef: null,
    windowRef: null,
  });
  overlay.startSession({sessionId: DEFAULT_RUN_ID, platform: "xiaohongshu"});
  overlay.recordItems([tracedItem(3, "bound-three")]);

  const update = overlay.updateTraceBindings([
    {
      runId: DEFAULT_RUN_ID,
      sequence: 3,
      identityKey: "id:bound-three",
      state: "detail_capturing",
      recordId: "record-three",
    },
    {
      runId: DEFAULT_RUN_ID,
      sequence: 99,
      identityKey: "id:not-present",
      state: "detail_done",
      recordId: "record-not-present",
    },
  ]);

  assert.deepEqual(update, {
    runId: DEFAULT_RUN_ID,
    updatedCount: 1,
    ignoredCount: 1,
  });
  const [entry] = overlay.getState().entries;
  assert.equal(entry.sequence, 3);
  assert.equal(entry.item.captureTrace.sequence, 3);
  assert.equal(entry.item.captureTrace.identityKey, "id:bound-three");
  assert.equal(entry.item.captureTrace.state, "detail_capturing");
  assert.equal(entry.item.captureTrace.recordId, "record-three");
  overlay.destroy();
});

test("a stale DOM capture key cannot override a conflicting note id and URL", () => {
  const staleCard = identityElement(
    {
      "data-osv-capture-key": "xiaohongshu:old-note",
      "data-note-id": "new-note",
    },
    [
      identityElement({
        href: "https://www.xiaohongshu.com/explore/new-note",
      }),
    ],
  );
  const staleEvidence = evaluateListCaptureElementIdentity(staleCard, {
    noteId: "old-note",
    domCaptureKey: "xiaohongshu:old-note",
    url: "https://www.xiaohongshu.com/explore/old-note",
  });

  assert.equal(staleEvidence.domCaptureKeyMatched, true);
  assert.equal(staleEvidence.stableIdentityRequired, true);
  assert.equal(staleEvidence.stableIdentityMatched, false);

  const domOnlyEvidence = evaluateListCaptureElementIdentity(staleCard, {
    domCaptureKey: "xiaohongshu:old-note",
  });
  assert.equal(domOnlyEvidence.domCaptureKeyMatched, true);
  assert.equal(domOnlyEvidence.stableIdentityRequired, false);

  const matchingCard = identityElement(
    {
      "data-osv-capture-key": "xiaohongshu:old-note",
      "data-note-id": "old-note",
    },
    [
      identityElement({
        href: "https://www.xiaohongshu.com/explore/old-note",
      }),
    ],
  );
  const matchingEvidence = evaluateListCaptureElementIdentity(matchingCard, {
    noteId: "old-note",
    domCaptureKey: "xiaohongshu:old-note",
    url: "https://www.xiaohongshu.com/explore/old-note",
  });
  assert.equal(matchingEvidence.domCaptureKeyMatched, true);
  assert.equal(matchingEvidence.stableIdentityMatched, true);
});

test("a reused DOM capture key cannot merge two different stable note identities", () => {
  const ledger = createListCaptureAcceptanceLedger({runId: DEFAULT_RUN_ID});
  const [first, second] = ledger.acceptItems([
    {
      noteId: "stable-note-a",
      url: "https://www.xiaohongshu.com/explore/stable-note-a",
      domCaptureKey: "xiaohongshu:reused-virtual-slot",
    },
    {
      noteId: "stable-note-b",
      url: "https://www.xiaohongshu.com/explore/stable-note-b",
      domCaptureKey: "xiaohongshu:reused-virtual-slot",
    },
  ]);

  assert.equal(first.captureTrace.sequence, 1);
  assert.equal(second.captureTrace.sequence, 2);
  assert.equal(ledger.getAcceptedCount(), 2);

  const domOnlyLedger = createListCaptureAcceptanceLedger({runId: "dom-only-run"});
  const [domOnlyFirst, domOnlyRepeat] = domOnlyLedger.acceptItems([
    {domCaptureKey: "douyin:dom-only-slot"},
    {domCaptureKey: "douyin:dom-only-slot"},
  ]);
  assert.equal(domOnlyFirst.captureTrace.sequence, 1);
  assert.equal(domOnlyRepeat.captureTrace.sequence, 1);
  assert.equal(domOnlyLedger.getAcceptedCount(), 1);
});

test("conflicting stable aliases fail closed without merging two trace numbers", () => {
  const firstSeenLedger = createListCaptureAcceptanceLedger({
    runId: "first-seen-conflict",
  });
  const [firstSeenConflict] = firstSeenLedger.acceptItems([
    {
      noteId: "stable-a",
      url: "https://www.xiaohongshu.com/explore/stable-b",
    },
  ]);
  assert.equal(firstSeenConflict.captureTrace, undefined);
  assert.equal(firstSeenLedger.getAcceptedCount(), 0);

  const ledger = createListCaptureAcceptanceLedger({runId: DEFAULT_RUN_ID});
  const [first, second] = ledger.acceptItems([
    {
      noteId: "stable-a",
      url: "https://www.xiaohongshu.com/explore/stable-a",
    },
    {
      noteId: "stable-b",
      url: "https://www.xiaohongshu.com/explore/stable-b",
    },
  ]);
  assert.equal(first.captureTrace.sequence, 1);
  assert.equal(second.captureTrace.sequence, 2);

  const [conflict] = ledger.acceptItems([
    {
      noteId: "stable-a",
      url: "https://www.xiaohongshu.com/explore/stable-b",
    },
  ]);
  assert.equal(conflict.captureTrace, undefined);
  assert.equal(ledger.getAcceptedCount(), 2);

  const [repeatB] = ledger.acceptItems([{noteId: "stable-b"}]);
  assert.equal(repeatB.captureTrace.sequence, 2);

  let state = reduceListHarvestState(startSession(), {
    type: "checkpoint",
    items: [tracedItem(1, "stable-a"), tracedItem(2, "stable-b")],
  });
  state = reduceListHarvestState(state, {
    type: "checkpoint",
    items: [
      tracedItem(1, "stable-a", {
        url: "https://www.xiaohongshu.com/explore/stable-b",
      }),
    ],
  });
  assert.equal(state.acceptedCount, 2);
  assert.equal(state.outcomeCounts.skipped, 1);
  assert.equal(state.identityToSequence.get("id:stable-a"), 1);
  assert.equal(state.identityToSequence.get("id:stable-b"), 2);

  const forgedState = reduceListHarvestState(startSession("forged-run"), {
    type: "checkpoint",
    items: [
      {
        noteId: "stable-a",
        url: "https://www.xiaohongshu.com/explore/stable-b",
        captureTrace: {
          version: 1,
          runId: "forged-run",
          sequence: 1,
          identityKey: "id:stable-a",
          state: "accepted",
        },
      },
    ],
  });
  assert.equal(forgedState.acceptedCount, 0);
  assert.equal(forgedState.outcomeCounts.skipped, 1);
});

test("fallback text alone cannot receive or render a real trace number", () => {
  const ledger = createListCaptureAcceptanceLedger({runId: DEFAULT_RUN_ID});
  const [titleOnly] = ledger.acceptItems([
    {title: "只有标题", author: "没有稳定身份"},
  ]);
  assert.equal(titleOnly.captureTrace, undefined);
  assert.equal(ledger.getAcceptedCount(), 0);

  const state = reduceListHarvestState(startSession(), {
    type: "checkpoint",
    items: [
      {
        title: "伪造的 fallback trace",
        captureTrace: {
          version: 1,
          runId: DEFAULT_RUN_ID,
          sequence: 1,
          identityKey: "fallback:伪造的 fallback trace",
          state: "accepted",
        },
      },
    ],
  });
  assert.equal(state.acceptedCount, 0);
  assert.equal(state.outcomeCounts.skipped, 1);
});

test("a superseded run scope cannot report or terminate the current overlay run", () => {
  const overlay = createListCaptureDebugOverlay({
    documentRef: null,
    windowRef: null,
  });
  overlay.startSession({sessionId: "run-a", platform: "xiaohongshu"});
  const runA = createListCaptureOverlayRunScope(overlay, "run-a");
  overlay.startSession({sessionId: "run-b", platform: "xiaohongshu"});
  const runB = createListCaptureOverlayRunScope(overlay, "run-b");
  const stateBeforeLateRunAEvents = overlay.getState();

  const lateResults = [
    runA.handleProgress({
      phase: "list_checkpoint",
      listCheckpoint: {
        items: [
          tracedItem(1, "late-a", {
            captureTrace: {runId: "run-a", identityKey: "id:late-a"},
          }),
        ],
      },
    }),
    runA.recordItems([
      tracedItem(1, "late-a", {
        captureTrace: {runId: "run-a", identityKey: "id:late-a"},
      }),
    ]),
    runA.setRunning("late running"),
    runA.setBackoff("late backoff"),
    runA.complete("late complete"),
    runA.fail("late failure"),
    runA.cancel("late cancellation"),
  ];

  assert.equal(runA.isCurrent(), false);
  assert.equal(runA.getState(), null);
  assert.ok(lateResults.every((result) => result.applied === false));
  assert.deepEqual(overlay.getState(), stateBeforeLateRunAEvents);

  const currentResult = runB.handleProgress({
    phase: "list_checkpoint",
    listCheckpoint: {
      items: [
        tracedItem(1, "current-b", {
          captureTrace: {runId: "run-b", identityKey: "id:current-b"},
        }),
      ],
    },
  });
  assert.equal(currentResult.applied, true);
  assert.equal(overlay.getState().acceptedCount, 1);
  assert.equal(runB.complete().applied, true);
  assert.equal(overlay.getState().status, "completed");
  overlay.destroy();
});

test("task takeover survives a completed child list until explicitly released on both platforms", () => {
  for (const platform of ["xiaohongshu", "douyin"]) {
    const {documentRef, windowRef} = createOverlayDomHarness();
    const overlay = createListCaptureDebugOverlay({documentRef, windowRef});

    overlay.setTaskTakeover({
      active: true,
      label: `${platform} AI 正在接管`,
    });
    overlay.startSession({
      sessionId: `${platform}-child-list-run`,
      platform,
    });
    overlay.complete("子列表采集完成");

    const host = overlay.getHost();
    assert.equal(overlay.getState().status, "completed");
    assert.equal(host.getAttribute("data-task-takeover-active"), "true");
    assert.equal(host.getAttribute("data-takeover-visible"), "true");
    assert.equal(
      host.getAttribute("data-takeover-label"),
      `${platform} AI 正在接管`,
    );

    overlay.setTaskTakeover({active: false});
    assert.equal(host.getAttribute("data-task-takeover-active"), "false");
    assert.equal(host.getAttribute("data-takeover-visible"), "false");
    overlay.destroy();
  }
});

test("terminal task trace cleanup removes the completed overlay and can start cleanly again", () => {
  for (const platform of ["xiaohongshu", "douyin"]) {
    const {documentRef, windowRef} = createOverlayDomHarness();
    const overlay = createListCaptureDebugOverlay({documentRef, windowRef});
    const runId = `${platform}-terminal-trace`;

    overlay.setTaskTakeover({active: true});
    overlay.startSession({sessionId: runId, platform});
    overlay.recordItems([
      tracedItem(1, `${platform}-terminal-item`, {
        captureTrace: {
          runId,
          identityKey: `id:${platform}-terminal-item`,
        },
      }),
    ]);
    overlay.complete("任务完成");
    assert.ok(overlay.getHost());
    assert.equal(overlay.getState().acceptedCount, 1);

    const cleanup = overlay.clearTaskTrace();
    assert.equal(cleanup.cleared, true);
    assert.equal(cleanup.runId, runId);
    assert.equal(overlay.getHost(), null);
    assert.equal(overlay.getState().sessionId, "");
    assert.equal(overlay.getState().acceptedCount, 0);
    assert.deepEqual(overlay.getRenderSnapshot(), {
      markers: [],
      visibleMarkerCount: 0,
      unresolvedCount: 0,
    });

    overlay.startSession({
      sessionId: `${runId}-next`,
      platform,
    });
    assert.ok(overlay.getHost());
    assert.equal(overlay.getState().sessionId, `${runId}-next`);
    overlay.destroy();
  }
});

test("skipped failed and ai-skipped traced items never enter marker state", () => {
  let state = reduceListHarvestState(startSession(), {
    type: "checkpoint",
    items: [
      tracedItem(1, "skip-1", {outcome: "skipped"}),
      tracedItem(2, "fail-1", {harvestOutcome: "failed"}),
      tracedItem(3, "ai-1", {listOutcome: "ai_skipped"}),
      tracedItem(4, "typo-1", {outcome: "acceptedd"}),
      tracedItem(5, "accepted-5"),
      {noteId: "untraced-success", status: "success"},
    ],
  });
  state = reduceListHarvestState(state, {
    type: "items",
    outcome: "accepted",
    items: [
      tracedItem(6, "filtered-6", {status: "filtered"}),
      tracedItem(7, "accepted-7", {status: "success"}),
    ],
  });

  assert.equal(state.acceptedCount, 2);
  assert.deepEqual(
    state.entries.map(({sequence, item}) => [sequence, item.noteId]),
    [
      [5, "accepted-5"],
      [7, "accepted-7"],
    ],
  );
  assert.deepEqual(state.outcomeCounts, {
    aiSkipped: 1,
    failed: 1,
    skipped: 4,
  });
});

test("terminal states retain traced entries until a different run starts", () => {
  let state = reduceListHarvestState(startSession(), {
    type: "checkpoint",
    items: [tracedItem(1), tracedItem(2), tracedItem(3)],
  });
  state = reduceListHarvestState(state, {
    type: "completed",
    message: "完成",
  });

  const lateCheckpoint = reduceListHarvestState(state, {
    type: "checkpoint",
    items: [tracedItem(4)],
  });
  assert.strictEqual(lateCheckpoint, state);
  assert.equal(lateCheckpoint.acceptedCount, 3);

  const resumedSameSession = reduceListHarvestState(state, {
    type: "start",
    sessionId: DEFAULT_RUN_ID,
  });
  assert.equal(resumedSameSession.status, "running");
  assert.equal(resumedSameSession.acceptedCount, 3);

  const nextSession = reduceListHarvestState(state, {
    type: "start",
    sessionId: "trace-run-b",
  });
  assert.equal(nextSession.status, "running");
  assert.equal(nextSession.acceptedCount, 0);
  assert.deepEqual(nextSession.entries, []);
});

test("progress projection keeps traced checkpoint payloads intact", () => {
  const item = tracedItem(8, "progress-eight");
  assert.deepEqual(
    buildListHarvestEventFromProgress({
      phase: "list_checkpoint",
      detectedCount: 12,
      listCheckpoint: {items: [item]},
    }),
    {
      type: "checkpoint",
      items: [item],
      message: undefined,
      detectedCount: 12,
      now: undefined,
    },
  );
  assert.equal(
    buildListHarvestEventFromProgress({phase: "waiting"}).type,
    "backoff",
  );
  assert.equal(
    buildListHarvestEventFromProgress({phase: "canceled"}).type,
    "cancelled",
  );
});

test("identity aliases use trace identity, note ids, route urls and DOM hints", () => {
  const aliases = buildListHarvestItemAliases({
    noteId: "ABC123",
    url: "https://www.douyin.com/video/ABC123?previous_page=search_result",
    captureTrace: captureTrace(9, "ABC123"),
    domLocator: {
      dataAwemeId: "ABC123",
      href: "/video/ABC123?foo=bar",
      cssPath: "main > article:nth-child(2)",
    },
  });

  assert.ok(aliases.includes("id:abc123"));
  assert.ok(aliases.includes("url:www.douyin.com/video/abc123"));
  assert.ok(aliases.includes("url:/video/abc123"));
  assert.equal(
    aliases.some((alias) => alias.includes("nth-child")),
    false,
    "virtualized CSS positions must not become stable identities",
  );
});

test("state copy reports the number of externally traced entries", () => {
  const copy = describeListHarvestState({
    status: "completed",
    acceptedCount: 40,
  });
  assert.equal(copy.title, "列表采集完成");
  assert.match(copy.detail, /40/);
  assert.match(copy.detail, /下一次采集/);
  assert.equal(normalizeListHarvestItemOutcome("AI-SKIPPED"), "ai_skipped");
  assert.equal(normalizeListHarvestItemOutcome("acceptedd"), "ignored");
});
