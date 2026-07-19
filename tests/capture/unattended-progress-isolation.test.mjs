import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sidebarSource = await readFile(
  new URL("../../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);

function readFunctionSource(name) {
  const marker = `function ${name}(`;
  const start = sidebarSource.indexOf(marker);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const bodyStart = sidebarSource.indexOf("{", start + marker.length);
  assert.notEqual(bodyStart, -1, `missing function body: ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < sidebarSource.length; index += 1) {
    const char = sidebarSource[index];
    if (char === "{") depth += 1;
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0) return sidebarSource.slice(start, index + 1);
  }
  assert.fail(`unterminated function: ${name}`);
}

function evaluateUnattendedTerminalClassifier() {
  const source = readFunctionSource("isUnattendedTerminalProgressPhase");
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.isUnattendedTerminalProgressPhase = isUnattendedTerminalProgressPhase;`,
    context,
  );
  return context.isUnattendedTerminalProgressPhase;
}

test("one keyword detail terminal event cannot terminate a multi-keyword unattended run", () => {
  const isUnattendedTerminalProgressPhase =
    evaluateUnattendedTerminalClassifier();

  for (const phase of [
    "detail_batch_done",
    "detail_batch_interrupted",
    "detail_batch_canceled",
    "blogger_metrics_done",
    "blogger_metrics_failed",
  ]) {
    assert.equal(
      isUnattendedTerminalProgressPhase(phase),
      false,
      `${phase} only settles work inside the current keyword`,
    );
  }

  const view = {state: "running", keyword: "词1", current: 1};
  const apply = (progress) => {
    if (isUnattendedTerminalProgressPhase(progress.phase)) {
      view.state = "terminal";
      return;
    }
    view.state = "running";
    view.keyword = progress.keyword;
    view.current = progress.keywordCurrent;
  };
  apply({phase: "detail_batch_done", keyword: "词1", keywordCurrent: 1});
  apply({phase: "capturing", keyword: "词2", keywordCurrent: 2});
  assert.deepEqual(view, {state: "running", keyword: "词2", current: 2});
});

test("only explicit unattended terminal phases close the unattended task", () => {
  const isUnattendedTerminalProgressPhase =
    evaluateUnattendedTerminalClassifier();

  for (const phase of [
    "streaming_sync_done",
    "unattended_completed",
    "unattended_completed_with_failures",
    "unattended_failed",
    "unattended_canceled",
  ]) {
    assert.equal(
      isUnattendedTerminalProgressPhase(phase),
      true,
      `${phase} must close the whole unattended task`,
    );
  }
  for (const phase of [
    "done",
    "completed",
    "completed_with_failures",
    "failed",
    "error",
    "canceled",
    "capturing",
    "recovering",
  ]) {
    assert.equal(
      isUnattendedTerminalProgressPhase(phase),
      false,
      `${phase} may belong to a keyword or nested worker`,
    );
  }
});

test("detail progress carries the owning capture task id before reaching the shared UI", () => {
  const start = sidebarSource.indexOf(
    "async function runDetailCaptureForRecordIds(",
  );
  const end = sidebarSource.indexOf(
    "async function handleRetryDetailCapture(",
    start,
  );
  assert.ok(start >= 0 && end > start);
  const section = sidebarSource.slice(start, end);
  const normalizedAt = section.indexOf("const normalizedProgress");
  const handleAt = section.indexOf("handleProgress(normalizedProgress)");
  assert.ok(normalizedAt >= 0 && handleAt > normalizedAt);
  assert.match(
    section.slice(normalizedAt, handleAt),
    /captureTaskId:\s*String\([\s\S]*?captureTaskId[\s\S]*?\)\.trim\(\)/,
    "every detail event must be stamped with the task that owns its worker",
  );
});

test("batch and detail callbacks keep the immutable unattended request attempt", () => {
  const batchStart = sidebarSource.indexOf(
    "async function handleBatchKeywordCapture(options = {})",
  );
  const batchEnd = sidebarSource.indexOf(
    "function activateUnattendedRunRequest",
    batchStart,
  );
  assert.ok(batchStart >= 0 && batchEnd > batchStart);
  const batchSection = sidebarSource.slice(batchStart, batchEnd);
  assert.match(batchSection, /runOptions\.unattendedRequestId/);
  assert.match(batchSection, /runOptions\.unattendedAttemptId/);
  assert.match(batchSection, /if \(!isCurrentUnattendedInvocation\(\)\)/);
  assert.match(
    batchSection,
    /unattendedRequestId:\s*scopedUnattendedRequestId/,
  );
  assert.match(
    batchSection,
    /unattendedAttemptId:\s*scopedUnattendedAttemptId/,
  );
  assert.match(batchSection, /const batchInvocationToken = Symbol\(/);
  assert.match(
    batchSection,
    /activeBatchKeywordInvocationToken === batchInvocationToken/,
  );
  assert.match(
    batchSection,
    /const shouldEndCaptureTaskSession =\s*ownsCurrentBatchInvocation\(\) &&/,
    "a late batch finally must not END the replacement session",
  );
  assert.match(
    batchSection,
    /if \(ownsBatchInvocation\(\)\) \{[\s\S]*?batchKeywordCaptureInFlight = false/,
    "only the active batch invocation may clear shared batch state",
  );

  const detailStart = sidebarSource.indexOf(
    "async function runDetailCaptureForRecordIds(",
  );
  const detailEnd = sidebarSource.indexOf(
    "async function handleRetryDetailCapture(",
    detailStart,
  );
  assert.ok(detailStart >= 0 && detailEnd > detailStart);
  const detailSection = sidebarSource.slice(detailStart, detailEnd);
  assert.match(detailSection, /const scopedUnattendedRequestId/);
  assert.match(detailSection, /const scopedUnattendedAttemptId/);
  assert.match(detailSection, /if \(!isCurrentDetailInvocation\(\)\)/);
  assert.match(detailSection, /const detailInvocationToken = Symbol\(/);
  assert.match(
    detailSection,
    /shouldStop:\s*\(\) =>[\s\S]*?!ownsDetailInvocation\(\)[\s\S]*?!isCurrentDetailInvocation\(\)/,
  );
  assert.match(
    detailSection,
    /prepareRetry:[\s\S]*?if \(!ownsDetailInvocation\(\) \|\| !isCurrentDetailInvocation\(\)\)/,
    "a stale detail callback must stop before rebuilding Debug context",
  );
  assert.match(
    detailSection,
    /unattendedAttemptId:\s*scopedUnattendedAttemptId/,
    "context rebuild must use the immutable owning attempt",
  );
  assert.match(
    detailSection,
    /const ownsInvocation = ownsDetailInvocation\(\);[\s\S]*?if \(ownsInvocation\) \{[\s\S]*?detailBatchCaptureInFlight = false/,
    "a late detail finally must not clear replacement worker state",
  );

  const clearSource = readFunctionSource("clearActiveUnattendedRunRequest");
  assert.match(clearSource, /activeUnattendedRunAttemptId !== attemptId/);

  const runStart = sidebarSource.indexOf(
    "async function runUnattendedKeywordPlanRequest(request)",
  );
  const runEnd = sidebarSource.indexOf(
    "async function runCaptureAction(",
    runStart,
  );
  const runSection = sidebarSource.slice(runStart, runEnd);
  assert.match(runSection, /const requestAttemptId/);
  assert.match(runSection, /const stillOwnsRequestAttempt =/);
  assert.match(
    runSection,
    /stillOwnsRequestAttempt &&[\s\S]*?endCaptureTaskSession/,
    "a superseded run must not end the replacement Debug session",
  );
});

test("late terminal events from task A are rejected after task B starts", () => {
  const handleProgressSource = readFunctionSource("handleProgress");
  let touched = 0;
  const context = {
    captureTaskOwnerTaskId: "task-B",
    activeUnattendedRunRequestId: "request-B",
    activeUnattendedRunAttemptId: "attempt-B",
    rememberCaptureTaskProgressContext(progress) {
      touched += 1;
      return progress;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${handleProgressSource}\nthis.handleProgress = handleProgress;`,
    context,
  );

  assert.doesNotThrow(() =>
    context.handleProgress({
      phase: "done",
      captureTaskId: "task-A",
      unattendedRequestId: "request-A",
    }),
  );
  assert.equal(touched, 0, "a stale task must not update remembered UI state");

  assert.doesNotThrow(() =>
    context.handleProgress({
      phase: "detail_batch_done",
      captureTaskId: "task-B",
      unattendedRequestId: "request-A",
    }),
  );
  assert.equal(
    touched,
    0,
    "a stale unattended request must not overwrite the replacement request",
  );

  assert.doesNotThrow(() =>
    context.handleProgress({
      phase: "done",
      captureTaskId: "task-B",
      unattendedRequestId: "request-B",
      unattendedAttemptId: "attempt-A",
    }),
  );
  assert.equal(
    touched,
    0,
    "a stale attempt must not terminate the replacement attempt",
  );

  assert.doesNotThrow(() =>
    context.handleProgress({
      phase: "done",
      captureTaskId: "task-B",
    }),
  );
  assert.equal(
    touched,
    0,
    "an unscoped late event cannot borrow the active unattended identity",
  );
});

test("the root terminal fence rejects late events from the same unattended attempt", () => {
  const handleProgressSource = readFunctionSource("handleProgress");
  let touched = 0;
  const context = {
    captureTaskOwnerTaskId: "unattended-capture:request-B",
    activeCaptureTaskProgressContext: null,
    activeUnattendedRunRequestId: "request-B",
    activeUnattendedRunAttemptId: "attempt-B",
    activeUnattendedTerminalProgressKey: "request-B:attempt-B",
    rememberCaptureTaskProgressContext(progress) {
      touched += 1;
      return progress;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${handleProgressSource}\nthis.handleProgress = handleProgress;`,
    context,
  );

  context.handleProgress({
    phase: "detail_item_done",
    captureTaskId: "unattended-capture:request-B",
    unattendedRequestId: "request-B",
    unattendedAttemptId: "attempt-B",
  });
  assert.equal(touched, 0, "terminal state must win over late worker progress");
});

test("terminal fence survives request cleanup without blocking a later manual task", () => {
  const clearSource = readFunctionSource("clearActiveUnattendedRunRequest");
  const handleProgressSource = readFunctionSource("handleProgress");
  let touched = 0;
  const manualPassed = new Error("manual progress passed unattended fence");
  const context = {
    captureTaskOwnerTaskId: "",
    activeCaptureTaskProgressContext: null,
    activeUnattendedRunRequestId: "request-old",
    activeUnattendedRunAttemptId: "attempt-old",
    activeUnattendedTerminalProgressKey: "request-old:attempt-old",
    activeUnattendedProgressSeq: 8,
    activeUnattendedAttemptRejected: false,
    lastUnattendedContentProgressAt: 123,
    lastUnattendedContentProgressFingerprint: "old",
    rememberCaptureTaskProgressContext() {
      touched += 1;
      throw manualPassed;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${clearSource}\n${handleProgressSource}\nthis.clearActiveUnattendedRunRequest = clearActiveUnattendedRunRequest; this.handleProgress = handleProgress;`,
    context,
  );

  context.clearActiveUnattendedRunRequest("request-old", "attempt-old");
  assert.equal(context.activeUnattendedRunRequestId, "");
  assert.equal(context.activeUnattendedRunAttemptId, "");
  assert.equal(
    context.activeUnattendedTerminalProgressKey,
    "request-old:attempt-old",
    "cleanup must retain the old terminal identity until a new unattended run starts",
  );

  assert.doesNotThrow(() =>
    context.handleProgress({
      phase: "detail_item_done",
      unattendedRequestId: "request-old",
      unattendedAttemptId: "attempt-old",
    }),
  );
  assert.equal(touched, 0, "late old worker progress remains fenced after cleanup");

  assert.throws(
    () => context.handleProgress({phase: "detail_item_done"}),
    (error) => error === manualPassed,
    "a later manual task without unattended identity must pass the old fence",
  );
  assert.equal(touched, 1);
});

test("unattended Debug wrappers never create a second public task ledger", async () => {
  const sidebarProgressStart = sidebarSource.indexOf(
    "function reportActiveSidebarTaskProgress(progress = {})",
  );
  const sidebarProgressEnd = sidebarSource.indexOf(
    "function reportActiveUnattendedContentProgress(",
    sidebarProgressStart,
  );
  assert.ok(sidebarProgressStart >= 0 && sidebarProgressEnd > sidebarProgressStart);
  const sidebarProgressSource = sidebarSource.slice(
    sidebarProgressStart,
    sidebarProgressEnd,
  );
  assert.match(
    sidebarProgressSource,
    /featureKey === "capture\.unattended_keyword"\) return/,
  );

  const backgroundSource = await readFile(
    new URL("../../background.js", import.meta.url),
    "utf8",
  );
  const endStart = backgroundSource.indexOf("async function endCaptureTask(");
  const endEnd = backgroundSource.indexOf(
    "async function handleUnexpectedCaptureDebugDetach(",
    endStart,
  );
  assert.ok(endStart >= 0 && endEnd > endStart);
  const endSource = backgroundSource.slice(endStart, endEnd);
  assert.match(
    endSource,
    /if \(!attemptFence\.unattended\) \{[\s\S]*?status: 'recovering'/,
    "recovering must stay on the root unattended request ledger",
  );
  assert.match(
    endSource,
    /if \(!attemptFence\.unattended\) \{[\s\S]*?terminalizeCaptureTaskLedgerRun/,
    "terminal Debug cleanup must not create unattended-capture:<id>",
  );
});
