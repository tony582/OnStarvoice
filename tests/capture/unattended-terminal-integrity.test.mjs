import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {buildDiagnosticsReport} from "../../utils/diagnostics.js";

const source = await readFile(new URL("../../sidebar/sidebar-logic.js", import.meta.url), "utf8");

function functionSource(name, async = false) {
  const start = source.indexOf(`${async ? "async " : ""}function ${name}(`);
  assert.ok(start >= 0, name);
  let depth = 0;
  let paramsEnd = -1;
  for (let index = source.indexOf("(", start); index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")" && --depth === 0) {
      paramsEnd = index;
      break;
    }
  }
  assert.ok(paramsEnd > start, `parameter list: ${name}`);
  for (let index = source.indexOf("{", paramsEnd); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated function: ${name}`);
}

const terminalContext = vm.createContext({});
vm.runInContext(functionSource("buildUnattendedTerminalProgress"), terminalContext);
const terminal = terminalContext.buildUnattendedTerminalProgress;

test("startup failure displays zero progress at its actual first step", () => {
  const progress = terminal({
    status: "failed", taskTotal: 2, roundTotal: 2, roundCurrent: 1,
    previousProgress: {roundCurrent: 1, phase: "starting_capture_session"},
  });
  assert.equal(progress.current, 0);
  assert.equal(progress.progressPercent, 0);
  assert.equal(progress.roundCurrent, 1);
  assert.equal(progress.lastBusinessPhase, "starting_capture_session");
  assert.equal(progress.streamingSyncDrainCompleted, false);
});

test("second-step startup failure preserves the completed prefix without showing full completion", () => {
  const progress = terminal({
    status: "failed", taskTotal: 2, roundTotal: 2, roundCurrent: 2,
    summary: {completed: 1, saved: 3}, previousProgress: {roundCurrent: 1},
  });
  assert.equal(progress.current, 1);
  assert.equal(progress.progressPercent, 50);
  assert.equal(progress.roundCurrent, 2);
  assert.equal(progress.capturedRecordCount, 3);
});

test("completed steps retain full progress and unknown totals do not invent a percentage", () => {
  const progress = terminal({
    status: "completed", taskTotal: 2, roundTotal: 2, roundCurrent: 2,
    summary: {completed: 2},
  });
  assert.equal(progress.current, 2);
  assert.equal(progress.progressPercent, 100);
  assert.equal(progress.roundCurrent, 2);
  assert.equal(terminal({status: "failed"}).progressPercent, null);
});

const identity = {
  lockId: "3385c728-2a47-43e8-8726-13248440cabf",
  owner: "unattended_keyword_plan",
  holderId: "ea2e0d88-2707-40a5-9ea4-02f1e8da0770",
  holderDocumentId: "649E7F46F510BC6D72458BF9A9D93F33",
  captureTaskId: "unattended-capture:f768ba55-497c-45cc-90fc-3f0e6bc4d35c",
  attemptId: "151e5f4a-6607-41f3-8fcd-2abd453e611f",
};

test("task ledger and exported diagnostics retain the bounded BEGIN comparison", async () => {
  const previousChrome = globalThis.chrome;
  const core = globalThis.OnStarvoiceTaskCenterCore;
  const run = core.normalizeTaskRun({
    id: "f768ba55-497c-45cc-90fc-3f0e6bc4d35c", status: "failed",
    error: {
      code: "unattended_begin_fence_changed", message: "BEGIN failed",
      details: {
        current: true, active: true, lockMatchesTaskAttempt: true,
        expected: {...identity, holderTabId: 41, cookie: "private-cookie"},
        actual: {...identity, holderTabId: 42, url: "https://private.example/content"},
        body: "private-body",
      },
    },
  });
  const roundTrip = core.normalizeTaskRun(JSON.parse(JSON.stringify(run)));
  assert.equal(roundTrip.error.details.expected.holderTabId, 41);
  assert.equal(roundTrip.error.details.actual.holderTabId, 42);
  const stored = {"onstarvoice.taskLedger": {runs: [roundTrip]}};
  globalThis.chrome = {storage: {local: {
    async get(key) { return {[key]: stored[key] ?? null}; },
    async set() {},
  }}};
  try {
    const report = await buildDiagnosticsReport();
    const details = report.taskCenter.recentRuns[0].error.details;
    assert.equal(details.expected.holderTabId, 41);
    assert.equal(details.actual.holderTabId, 42);
    assert.equal(details.expected.holderDocumentId, identity.holderDocumentId);
    for (const value of ["private-cookie", "private-body", "private.example"]) {
      assert.equal(JSON.stringify(report).includes(value), false);
    }
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test("unrecognized errors and malformed identity payloads are not exported as fence evidence", () => {
  const normalize = globalThis.OnStarvoiceTaskCenterCore.normalizeCaptureFenceErrorDetails;
  assert.equal(normalize({code: "other_error", details: identity}), null);
  assert.equal(normalize({code: "unattended_begin_fence_changed", details: []}), null);
  const details = normalize({code: "unattended_begin_fence_changed", details: {
    current: "true", expected: {lockId: "Bearer secret", holderTabId: Infinity},
    actual: {holderDocumentId: "private-body", holderTabId: -1},
  }});
  assert.equal(details.current, null);
  assert.equal(details.expected.lockId, "");
  assert.equal(details.expected.holderTabId, null);
  assert.equal(details.actual.holderDocumentId, "");
});
