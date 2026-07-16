import assert from "node:assert/strict";
import test from "node:test";

import {
  buildListHarvestEventFromProgress,
  buildListHarvestItemAliases,
  createListCaptureDebugOverlay,
  createListCaptureOverlayRunScope,
  createListHarvestState,
  describeListHarvestState,
  evaluateListCaptureElementIdentity,
  normalizeListHarvestItemOutcome,
  reduceListHarvestState,
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
