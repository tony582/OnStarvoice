import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (await readFile(
  resolve(repoRoot, "utils/capture-recovery-ui.js"),
  "utf8",
)).replace(/\bexport\s+(?=function\b)/g, "");
const context = vm.createContext({Date, Set});
vm.runInContext(
  `${source}\n;globalThis.__captureRecoveryUiApi = {buildCaptureRecoveryAnnouncementKey, resolveCaptureRecoveryView, resolveCommentCaptureStatusView, resolveCommentCaptureActions};`,
  context,
  {filename: "utils/capture-recovery-ui.js"},
);
const {
  buildCaptureRecoveryAnnouncementKey,
  resolveCaptureRecoveryView,
  resolveCommentCaptureStatusView,
  resolveCommentCaptureActions,
} = context.__captureRecoveryUiApi;

function actionIds(view) {
  return Array.from(view.actions, (action) => action.id);
}

test("recovery heartbeat does not change the live-region announcement", () => {
  const first = resolveCaptureRecoveryView({
    phase: "network_paused",
    recordId: "record-heartbeat",
    captureRequestId: "request-heartbeat",
    updatedAt: 1000,
    heartbeatAt: 1000,
  }, {now: 1100});
  const heartbeat = resolveCaptureRecoveryView({
    phase: "network_paused",
    recordId: "record-heartbeat",
    captureRequestId: "request-heartbeat",
    updatedAt: 2500,
    heartbeatAt: 2500,
  }, {now: 2600});

  assert.equal(
    buildCaptureRecoveryAnnouncementKey(first),
    buildCaptureRecoveryAnnouncementKey(heartbeat),
  );
});

test("network pause explains automatic continuation and only offers cancel", () => {
  const view = resolveCaptureRecoveryView({
    phase: "network_paused",
    recordId: "record-1",
    runnerTabId: 12,
    updatedAt: 1000,
  }, {now: 1500});

  assert.equal(view.visible, true);
  assert.equal(view.state, "paused");
  assert.equal(view.tone, "warning");
  assert.match(view.title, /网络已断开/);
  assert.match(view.detail, /自动继续/);
  assert.deepEqual(actionIds(view), ["cancel"]);
  assert.equal(view.showCancel, true);
  assert.equal(view.showRetry, false);
  assert.equal(view.showDismiss, false);
  assert.equal(view.statusLabel, "等待网络");
  assert.match(view.nextStep, /自动继续/);
  assert.equal(view.pinned, false);
  assert.equal(view.runnerTabId, 12);
});

test("automatic page recovery shows its attempt and cannot start a parallel retry", () => {
  const view = resolveCaptureRecoveryView({
    phase: "capture_recovering",
    recordId: "record-2",
    recoveryAttempt: 1,
    updatedAt: 2000,
  }, {now: 2500});

  assert.equal(view.state, "recovering");
  assert.match(view.title, /90 秒没有新进度/);
  assert.match(view.detail, /1\/1/);
  assert.deepEqual(actionIds(view), ["cancel"]);
  assert.equal(view.showCancel, true);
  assert.equal(view.showRetry, false);
  assert.equal(view.statusLabel, "自动恢复中");
});

test("batch recovery makes it clear that cancel stops the whole task", () => {
  const view = resolveCaptureRecoveryView({
    phase: "capture_recovering",
    recordId: "record-batch",
    total: 8,
    recoveryAttempt: 1,
    updatedAt: 2600,
  }, {now: 2700});

  assert.equal(view.showCancel, true);
  assert.equal(view.cancelLabel, "取消整个任务并保留");
});

test("network timeout waits for safe task finalization before offering retry", () => {
  const view = resolveCaptureRecoveryView({
    phase: "network_timeout",
    recordId: "record-3",
    updatedAt: 3000,
  }, {now: 3500});

  assert.equal(view.state, "finishing");
  assert.equal(view.tone, "error");
  assert.match(view.title, /断网时间较长/);
  assert.deepEqual(actionIds(view), []);
  assert.equal(view.showCancel, false);
  assert.equal(view.showRetry, false);
  assert.equal(view.showDismiss, false);
  assert.equal(view.statusLabel, "正在保存");
});

test("canceling state disables every action while saved data is finalized", () => {
  const view = resolveCaptureRecoveryView({
    phase: "capture_canceling",
    recordId: "record-canceling",
    captureRequestId: "request-canceling",
    updatedAt: 3600,
  }, {now: 3700});

  assert.equal(view.state, "canceling");
  assert.match(view.title, /正在取消并保存/);
  assert.deepEqual(actionIds(view), []);
  assert.equal(view.showCancel, false);
  assert.equal(view.showRetry, false);
  assert.equal(view.showDismiss, false);
});

for (const [phase, tone, titlePattern] of [
  ["comments_partial", "warning", /评论采集中断/],
  ["comments_failed", "error", /评论采集未完成/],
]) {
  test(`${phase} exposes retry but not cancel`, () => {
    const view = resolveCaptureRecoveryView({
      phase,
      recordId: "record-4",
      collectedCount: 7,
      updatedAt: 4000,
    }, {now: 4500});

    assert.equal(view.tone, tone);
    assert.match(view.title, titlePattern);
    assert.deepEqual(actionIds(view), ["retry", "dismiss"]);
    assert.equal(view.showRetry, true);
    assert.equal(view.showDismiss, true);
  });
}

test("a repaired interrupted task tells the user that saved comments remain", () => {
  const view = resolveCaptureRecoveryView({
    phase: "interrupted_repaired",
    recordId: "record-5",
    savedCount: 9,
    updatedAt: 5000,
  }, {now: 5500});

  assert.equal(view.state, "retryable");
  assert.match(view.title, /上次任务意外中断/);
  assert.match(view.detail, /保留 9 条评论/);
  assert.deepEqual(actionIds(view), ["retry", "dismiss"]);
  assert.equal(view.retryLabel, "继续采集");
});

test("stale persisted recovery progress stays hidden when the sidebar reopens", () => {
  const view = resolveCaptureRecoveryView({
    phase: "capture_recovering",
    recordId: "record-stale",
    updatedAt: 1000,
  }, {
    now: 20_000,
    staleAfterMs: 5000,
  });

  assert.equal(view.visible, false);
  assert.equal(view.reason, "stale");
  assert.deepEqual(actionIds(view), []);
  assert.equal(view.showCancel, false);
  assert.equal(view.showRetry, false);
  assert.equal(view.showDismiss, false);
});

test("retryable recovery hides retry when no record can be targeted", () => {
  const view = resolveCaptureRecoveryView({
    phase: "comments_failed",
    updatedAt: 6000,
  }, {now: 6500});

  assert.equal(view.visible, true);
  assert.deepEqual(actionIds(view), ["dismiss"]);
  assert.equal(view.showRetry, false);
  assert.equal(view.showDismiss, true);
});

test("recovery view always exposes the stable renderer contract", () => {
  const view = resolveCaptureRecoveryView({
    phase: "network_paused",
    recordId: "record-contract",
    captureRequestId: "request-contract",
    updatedAt: 7000,
  }, {now: 7500});
  const requiredKeys = [
    "visible",
    "tone",
    "title",
    "detail",
    "nextStep",
    "statusLabel",
    "showCancel",
    "cancelLabel",
    "showRetry",
    "retryLabel",
    "showDismiss",
    "dismissLabel",
    "pinned",
    "recordId",
    "runnerTabId",
    "captureRequestId",
  ];

  for (const key of requiredKeys) {
    assert.equal(Object.hasOwn(view, key), true, key);
  }
  assert.equal(view.captureRequestId, "request-contract");
});

test("comment card actions keep stop and retry mutually exclusive", () => {
  const cases = [
    ["capturing", ["cancel"]],
    ["partial", ["retry"]],
    ["failed", ["retry"]],
    ["done", []],
  ];

  for (const [status, expectedActions] of cases) {
    const actions = resolveCommentCaptureActions({
      status,
      recordId: "record-card",
    });
    assert.deepEqual(
      Array.from(actions, (action) => action.id),
      expectedActions,
      status,
    );
  }
});

test("comment status view maps capturing, partial, failed, and done", () => {
  const cases = [
    ["capturing", "info", "cancel", "停止并保留"],
    ["partial", "warning", "retry", "继续采集"],
    ["failed", "error", "retry", "重试"],
    ["done", "success", "", ""],
  ];

  for (const [status, tone, action, actionLabel] of cases) {
    const view = resolveCommentCaptureStatusView({
      commentsCaptureStatus: status,
      commentsTotalCaptured: 6,
    });
    assert.equal(view.tone, tone, status);
    assert.equal(view.action, action, status);
    assert.equal(view.actionLabel, actionLabel, status);
    assert.equal(typeof view.title, "string", status);
    assert.equal(typeof view.detail, "string", status);
  }
});

test("comment card actions stay hidden without a target record", () => {
  assert.deepEqual(
    Array.from(resolveCommentCaptureActions({status: "capturing"})),
    [],
  );
  assert.deepEqual(
    Array.from(resolveCommentCaptureActions({status: "failed"})),
    [],
  );
});

test("partial comment status distinguishes observed comments from saved comments", () => {
  const view = resolveCommentCaptureStatusView({
    commentsCaptureStatus: "partial",
    commentsTotalCaptured: 5,
    commentsObservedBeforeInterrupt: 11,
  });

  assert.match(view.title, /已保存 5 条/);
  assert.match(view.detail, /检测到 11 条，实际已保存 5 条/);
  assert.equal(view.action, "retry");
});
