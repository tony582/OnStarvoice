import assert from "node:assert/strict";
import test from "node:test";

import {
  beginCaptureTaskSession,
  endCaptureTaskSession,
  registerCaptureTaskTab,
  updateCaptureTaskSession,
} from "../../utils/capture-sync.js";

function createRuntimeDouble(responder = null) {
  const messages = [];
  return {
    messages,
    chromeApi: {
      runtime: {
        async sendMessage(message) {
          messages.push(structuredClone(message));
          if (typeof responder === "function") {
            return await responder(message, messages.length);
          }
          return {ok: true, data: {taskId: message.taskId}};
        },
      },
    },
  };
}

function getTaskLifecycleMessages(messages = []) {
  return messages.filter(
    (message) => message.type !== "onstarvoice:relay-to-content",
  );
}

function getTakeoverMessages(messages = []) {
  return messages.filter(
    (message) =>
      message.type === "onstarvoice:relay-to-content" &&
      message.payload?.action === "setCaptureTaskTakeover",
  );
}

test("capture task lifecycle emits four root messages plus page takeover updates", async () => {
  const runtime = createRuntimeDouble();
  const options = {chromeApi: runtime.chromeApi};

  const begun = await beginCaptureTaskSession(
    {
      taskId: "  task-session-contract  ",
      tabId: "41",
      label: "  搜索「车机升级」  ",
      platform: " XiaoHongShu ",
      ownerRequired: true,
    },
    options,
  );
  assert.equal(begun.active, true);

  const reused = await beginCaptureTaskSession(
    {taskId: "task-session-contract", tabId: 41},
    options,
  );
  assert.equal(reused.reused, true);

  await updateCaptureTaskSession(
    {
      taskId: "task-session-contract",
      progress: {phase: "detail_capturing", current: 1, total: 2},
    },
    options,
  );
  await registerCaptureTaskTab(
    {
      taskId: "task-session-contract",
      tabId: "92",
      role: " DETAIL_WORKER ",
    },
    options,
  );
  await endCaptureTaskSession(
    {
      taskId: "task-session-contract",
      reason: " completed ",
      status: " COMPLETED ",
    },
    options,
  );

  const lifecycleMessages = getTaskLifecycleMessages(runtime.messages);
  assert.match(
    lifecycleMessages[1]?.progress?.phaseStartedAt || "",
    /^\d{4}-\d{2}-\d{2}T/u,
  );
  assert.match(
    lifecycleMessages[1]?.progress?.updatedAt || "",
    /^\d{4}-\d{2}-\d{2}T/u,
  );
  const normalizedLifecycleMessages = lifecycleMessages.map((message) => {
    if (message.type !== "onstarvoice:update-capture-task") {
      return message;
    }
    const progress = {...message.progress};
    delete progress.phaseStartedAt;
    delete progress.updatedAt;
    return {...message, progress};
  });
  assert.deepEqual(normalizedLifecycleMessages, [
    {
      type: "onstarvoice:begin-capture-task",
      taskId: "task-session-contract",
      tabId: 41,
      label: "搜索「车机升级」",
      platform: "xiaohongshu",
      ownerRequired: true,
    },
    {
      type: "onstarvoice:update-capture-task",
      taskId: "task-session-contract",
      progress: {phase: "detail_capturing", current: 1, total: 2},
    },
    {
      type: "onstarvoice:register-capture-task-tab",
      taskId: "task-session-contract",
      tabId: 92,
      role: "detail_worker",
    },
    {
      type: "onstarvoice:end-capture-task",
      taskId: "task-session-contract",
      reason: "completed",
      status: "COMPLETED",
    },
  ]);
  const takeoverMessages = getTakeoverMessages(runtime.messages);
  assert.equal(takeoverMessages.length, 3);
  assert.deepEqual(
    takeoverMessages.map((message) => message.payload.active),
    [true, true, false],
  );
  assert.equal(takeoverMessages.at(-1).payload.clearTrace, true);

  const afterEnd = await updateCaptureTaskSession(
    {taskId: "task-session-contract", progress: {phase: "late"}},
    options,
  );
  assert.equal(afterEnd.reason, "no_active_task_session");
  assert.equal(runtime.messages.length, 7);
});

test("no active session is a no-op and leaves the old capture path intact", async () => {
  const runtime = createRuntimeDouble();
  const options = {chromeApi: runtime.chromeApi};

  assert.equal(
    (await updateCaptureTaskSession({progress: {phase: "list"}}, options))
      .reason,
    "no_active_task_session",
  );
  assert.equal(
    (await registerCaptureTaskTab({tabId: 92}, options)).reason,
    "no_active_task_session",
  );
  assert.equal(
    (await endCaptureTaskSession({reason: "completed"}, options)).reason,
    "no_active_task_session",
  );
  assert.deepEqual(runtime.messages, []);
});

test("an unattended attempt token fences its lifecycle and a stale END does not clear the replacement overlay", async () => {
  const runtime = createRuntimeDouble(async (message) => {
    if (message.type === "onstarvoice:end-capture-task") {
      return {
        ok: true,
        data: {ignored: true, reason: "stale_unattended_attempt"},
      };
    }
    return {ok: true, data: {taskId: message.taskId}};
  });
  const options = {chromeApi: runtime.chromeApi};
  const taskId = "unattended-capture:attempt-fence-contract";

  await beginCaptureTaskSession(
    {taskId, tabId: 61, platform: "douyin", attemptId: "attempt-old"},
    options,
  );
  await updateCaptureTaskSession(
    {taskId, progress: {phase: "detail_capturing"}},
    options,
  );
  await registerCaptureTaskTab(
    {taskId, tabId: 62, role: "detail_worker"},
    options,
  );
  const ended = await endCaptureTaskSession(
    {taskId, reason: "failed", status: "failed"},
    options,
  );

  assert.equal(ended.data.ignored, true);
  const lifecycle = getTaskLifecycleMessages(runtime.messages);
  assert.deepEqual(
    lifecycle.map((message) => [message.type, message.attemptId]),
    [
      ["onstarvoice:begin-capture-task", "attempt-old"],
      ["onstarvoice:update-capture-task", "attempt-old"],
      ["onstarvoice:register-capture-task-tab", "attempt-old"],
      ["onstarvoice:end-capture-task", "attempt-old"],
    ],
  );
  assert.deepEqual(
    getTakeoverMessages(runtime.messages).map((message) =>
      message.payload.active,
    ),
    [true],
    "a stale runner must not clear the takeover overlay owned by the replacement attempt",
  );
  assert.equal(
    (await updateCaptureTaskSession({taskId, progress: {phase: "late"}}, options))
      .reason,
    "no_active_task_session",
  );
});

test("an omitted task id never borrows the sole active persistent session", async () => {
  const runtime = createRuntimeDouble();
  const options = {chromeApi: runtime.chromeApi};
  await beginCaptureTaskSession(
    {taskId: "task-explicit-identity", tabId: 43},
    options,
  );

  assert.equal(
    (await updateCaptureTaskSession({progress: {phase: "detail"}}, options))
      .reason,
    "no_active_task_session",
  );
  assert.equal(
    (await registerCaptureTaskTab({tabId: 93}, options)).reason,
    "no_active_task_session",
  );
  assert.equal(
    (await endCaptureTaskSession({reason: "completed"}, options)).reason,
    "no_active_task_session",
  );
  assert.equal(getTaskLifecycleMessages(runtime.messages).length, 1);
  assert.equal(getTakeoverMessages(runtime.messages).length, 1);

  const ended = await endCaptureTaskSession(
    {taskId: "task-explicit-identity", reason: "completed"},
    options,
  );
  assert.equal(ended.ok, true);
  assert.equal(getTaskLifecycleMessages(runtime.messages).length, 2);
  assert.equal(getTakeoverMessages(runtime.messages).length, 2);
  assert.equal(getTakeoverMessages(runtime.messages).at(-1).payload.clearTrace, true);
});

test("failed begin never activates a task session", async () => {
  const runtime = createRuntimeDouble(async () => ({
    ok: false,
    error: {code: "unsupported_message"},
  }));
  const options = {chromeApi: runtime.chromeApi};

  const begun = await beginCaptureTaskSession(
    {taskId: "task-begin-failed", tabId: 41},
    options,
  );
  assert.equal(begun.active, false);
  assert.equal(begun.reason, "unsupported_message");
  assert.equal(
    (
      await updateCaptureTaskSession(
        {taskId: "task-begin-failed", progress: {phase: "list"}},
        options,
      )
    ).reason,
    "no_active_task_session",
  );
  assert.equal(runtime.messages.length, 1);
});

test("a replaced source tab is revalidated with background before local reuse", async () => {
  let replacementBeginAttempts = 0;
  const runtime = createRuntimeDouble(async (message) => {
    if (
      message.type === "onstarvoice:begin-capture-task" &&
      Number(message.tabId) === 52
    ) {
      replacementBeginAttempts += 1;
      if (replacementBeginAttempts === 1) {
        return {
          ok: false,
          error: {code: "capture_task_source_mismatch"},
        };
      }
    }
    return {ok: true, data: {taskId: message.taskId}};
  });
  const options = {chromeApi: runtime.chromeApi};

  await beginCaptureTaskSession(
    {taskId: "task-source-rebound", tabId: 51, platform: "douyin"},
    options,
  );
  const rebound = await beginCaptureTaskSession(
    {taskId: "task-source-rebound", tabId: 52, platform: "douyin"},
    options,
  );

  assert.equal(rebound.ok, true);
  assert.equal(rebound.active, true);
  assert.equal(rebound.rebound, true);
  assert.equal(replacementBeginAttempts, 2);
  const beginMessages = getTaskLifecycleMessages(runtime.messages).filter(
    (message) => message.type === "onstarvoice:begin-capture-task",
  );
  assert.deepEqual(
    beginMessages.map((message) => message.tabId),
    [51, 52, 52],
  );

  await endCaptureTaskSession(
    {taskId: "task-source-rebound", reason: "completed"},
    options,
  );
  assert.equal(getTakeoverMessages(runtime.messages).at(-1).tabId, 52);
});

test("end retries one transient background release failure before clearing ownership", async () => {
  let endAttempts = 0;
  const runtime = createRuntimeDouble(async (message) => {
    if (message.type !== "onstarvoice:end-capture-task") {
      return {ok: true, data: {taskId: message.taskId}};
    }
    endAttempts += 1;
    return endAttempts === 1
      ? {ok: false, error: {code: "release_failed"}}
      : {ok: true, data: {taskId: message.taskId}};
  });
  const options = {chromeApi: runtime.chromeApi};

  await beginCaptureTaskSession(
    {taskId: "task-end-failed", tabId: 41},
    options,
  );
  const ended = await endCaptureTaskSession(
    {taskId: "task-end-failed", reason: "failed", status: "failed"},
    options,
  );
  assert.equal(ended.ok, true);
  assert.equal(endAttempts, 2);

  const afterEnd = await updateCaptureTaskSession(
    {taskId: "task-end-failed", progress: {phase: "release_retry"}},
    options,
  );
  assert.equal(afterEnd.reason, "no_active_task_session");
  assert.equal(runtime.messages.length, 5);
  assert.equal(getTakeoverMessages(runtime.messages).at(-1).payload.clearTrace, true);
});

test("two failed end attempts keep local ownership for a later user retry", async () => {
  const runtime = createRuntimeDouble(async (message) =>
    message.type === "onstarvoice:end-capture-task"
      ? {ok: false, error: {code: "release_failed"}}
      : {ok: true, data: {taskId: message.taskId}},
  );
  const options = {chromeApi: runtime.chromeApi};
  await beginCaptureTaskSession(
    {taskId: "task-end-still-failed", tabId: 42},
    options,
  );

  const ended = await endCaptureTaskSession(
    {taskId: "task-end-still-failed", reason: "failed"},
    options,
  );
  assert.equal(ended.reason, "release_failed");
  const progress = await updateCaptureTaskSession(
    {taskId: "task-end-still-failed", progress: {phase: "retry_available"}},
    options,
  );
  assert.equal(progress.ok, true);
});
