import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {executeScriptWithTimeout} from "../../utils/capture-sync.js";

// 0.4.19 S1：预加载等旁路事件带上前台阶段；探测类 executeScript 限时。

const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);
const sidebarSource = await readFile(
  new URL("../../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);

function readSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test("prefetch and worker-release events report the foreground stage instead of 0/0", () => {
  const transition = readSection(
    captureSyncSource,
    "onTransition: ({type, slot, snapshot, error}) => {",
    "const plannedDetailWorkerCount = runnerContexts.length;",
  );
  const helper = readSection(
    transition,
    "const readForegroundDetailProgress = () => {",
    "const fatalNavigationFailure =",
  );
  assert.match(helper, /activeDetailItemContext \|\| \{\}/u);
  assert.match(helper, /current: Number\(context\.current\) \|\| 0/u);
  assert.match(helper, /total: uniqueRecordIds\.length/u);
  assert.match(
    helper,
    /activeStage === 'comments_capture' \? 'captureComments' : ''/u,
    "outside the comment stage captureAction is written as an explicit empty string",
  );
  for (const phase of [
    "detail_item_prefetch_loading",
    "detail_item_prefetch_ready",
    "detail_worker_released",
  ]) {
    const event = readSection(
      transition,
      `...readForegroundDetailProgress(),\n          phase: '${phase}'`,
      "}, 'detail",
    );
    assert.match(event, /recordId: slot\.recordId|runnerTabId: slot\.tabId/u);
  }
});

test("the comment stage is recorded on the foreground context and its progress event", () => {
  const stage = readSection(
    captureSyncSource,
    "activeStage = 'comments_capture';",
    "const expectedCommentNoteId =",
  );
  assert.match(stage, /activeDetailItemContext\.activeStage = activeStage/u);
  const event = readSection(
    captureSyncSource,
    "phase: 'detail_comments_capturing',\n              message: `${progressLabel}：正在采集评论...`",
    "});",
  );
  assert.match(event, /captureAction: 'captureComments'/u);
  assert.match(event, /activeStage: 'comments_capture'/u);
});

test("the runner report snapshot keeps captureAction and activeStage", () => {
  const snapshot = readSection(
    sidebarSource,
    "const progressSnapshot = {",
    "lastSnapshot = progressSnapshot;",
  );
  assert.match(snapshot, /captureAction: String\(projectedProgress\?\.captureAction \|\| ""\)/u);
  assert.match(snapshot, /activeStage: String\(projectedProgress\?\.activeStage \|\| ""\)/u);
});

test("probe executeScript calls are bounded and time out to null", async () => {
  const previousChrome = globalThis.chrome;
  try {
    let calls = 0;
    globalThis.chrome = {
      scripting: {
        executeScript() {
          calls += 1;
          return new Promise(() => {});
        },
      },
    };
    const startedAt = Date.now();
    assert.equal(await executeScriptWithTimeout({target: {tabId: 5}}, 20), null);
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(calls, 1);

    globalThis.chrome = {
      scripting: {
        async executeScript() {
          return [{frameId: 0, result: {ok: true}}];
        },
      },
    };
    assert.deepEqual(
      await executeScriptWithTimeout({target: {tabId: 5}}, 1000),
      [{frameId: 0, result: {ok: true}}],
    );

    globalThis.chrome = {
      scripting: {
        async executeScript() {
          throw new Error("Cannot access contents of the page");
        },
      },
    };
    await assert.rejects(
      executeScriptWithTimeout({target: {tabId: 5}}, 1000),
      /Cannot access contents/u,
    );
  } finally {
    globalThis.chrome = previousChrome;
  }

  const preload = readSection(
    captureSyncSource,
    "async function probeDetailPreloadSafety(",
    "function isDouyinDirectDetailEntryUrl(",
  );
  assert.match(preload, /\(await executeScriptWithTimeout\(\{/u);
  assert.doesNotMatch(preload, /await chrome\.scripting\.executeScript\(/u);
  const unavailable = readSection(
    captureSyncSource,
    "async function probeDetailUnavailableInTab(",
    "function buildUnavailableBatchCaptureResult(",
  );
  assert.match(unavailable, /\(await executeScriptWithTimeout\(\{/u);
  // waitForOpenedUrlInTab 的可用性探测经由 probeDetailUnavailableInTab。
  const opened = readSection(
    captureSyncSource,
    "async function waitForOpenedUrlInTab(",
    "async function probeDetailPreloadSafety(",
  );
  assert.match(opened, /probeDetailUnavailableInTab\(tabId, targetUrl\)/u);
});
