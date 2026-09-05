import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);

function readFunctionBody() {
  const start = captureSyncSource.indexOf(
    "export async function batchCaptureDetailsForRecords",
  );
  const end = captureSyncSource.indexOf(
    "export function resolveSyncInputForRecord",
    start,
  );
  assert.ok(start >= 0, "missing batchCaptureDetailsForRecords");
  assert.ok(end > start, "missing batchCaptureDetailsForRecords end marker");
  return captureSyncSource.slice(start, end);
}

test("Douyin runner contract uses one dedicated worker and never the source tab", () => {
  const body = readFunctionBody();
  const runnerInitAt = body.indexOf(
    "runnerContext = await prepareDetailBatchRunnerContext({",
  );
  const registrationAt = body.indexOf(
    "const taskTabRegistration = await registerCaptureTaskTab({",
    runnerInitAt,
  );
  const registrationEnd = body.indexOf("});", registrationAt) + 3;
  const doubleBufferAt = body.indexOf(
    "const allowDetailDoubleBuffer = Boolean(",
    registrationEnd,
  );

  assert.ok(runnerInitAt >= 0, "missing primary detail runner initialization");
  assert.ok(registrationAt > runnerInitAt, "worker must be created before registration");
  assert.ok(doubleBufferAt > registrationAt, "missing Douyin serial-worker guard");

  const doubleBufferGuard = body.slice(
    doubleBufferAt,
    body.indexOf(");", doubleBufferAt) + 2,
  );
  assert.match(
    doubleBufferGuard,
    /!detailBatchContainsDouyin/u,
    "Douyin must never enable the second detail worker",
  );
  assert.match(
    doubleBufferGuard,
    /!normalizedCaptureTaskId\s*\|\|\s*taskTabRegistrationActive/u,
    "tracked Xiaohongshu double buffering requires active worker registration",
  );

  const runnerInit = body.slice(runnerInitAt, registrationAt);
  assert.match(
    runnerInit,
    /runnerMode:\s*DETAIL_RUNNER_MODE\.DEDICATED_TAB/u,
    "Douyin must use a dedicated detail worker instead of the search source tab",
  );
  assert.doesNotMatch(
    runnerInit,
    /DETAIL_RUNNER_MODE\.SOURCE_TAB/u,
    "the search source tab must never double as the detail worker",
  );

  const registration = body.slice(registrationAt, registrationEnd);
  assert.match(registration, /tabId:\s*runnerContext\.runnerTabId/u);
  assert.match(registration, /role:\s*'detail_worker'/u);
  assert.doesNotMatch(registration, /tabId:\s*runnerContext\.sourceTabId/u);
});

test("AI prefilter completion continues into worker registration and detail capture", () => {
  const body = readFunctionBody();
  const prefilterDoneAt = body.indexOf("phase: 'detail_ai_prefilter_done'");
  const runnerAt = body.indexOf(
    "runnerContext = await prepareDetailBatchRunnerContext({",
    prefilterDoneAt,
  );
  const registrationAt = body.indexOf(
    "const taskTabRegistration = await registerCaptureTaskTab({",
    runnerAt,
  );
  const batchStartAt = body.indexOf("phase: 'detail_batch_start'", registrationAt);
  const detailCaptureAt = body.indexOf(
    "let noteResult = await captureCurrentNotePayload()",
    batchStartAt,
  );

  assert.ok(prefilterDoneAt >= 0, "missing AI prefilter completion progress");
  assert.ok(runnerAt > prefilterDoneAt, "AI keep/need-detail items must open a runner");
  assert.ok(registrationAt > runnerAt, "the dedicated worker must be registered");
  assert.ok(batchStartAt > registrationAt, "detail batch must start after registration");
  assert.ok(detailCaptureAt > batchStartAt, "detail extraction must remain reachable");
});
