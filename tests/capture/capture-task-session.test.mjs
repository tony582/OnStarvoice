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

test("capture task lifecycle emits the exact four-message contract", async () => {
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

  assert.deepEqual(runtime.messages, [
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

  const afterEnd = await updateCaptureTaskSession(
    {taskId: "task-session-contract", progress: {phase: "late"}},
    options,
  );
  assert.equal(afterEnd.reason, "no_active_task_session");
  assert.equal(runtime.messages.length, 4);
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
  assert.equal(runtime.messages.length, 1);

  const ended = await endCaptureTaskSession(
    {taskId: "task-explicit-identity", reason: "completed"},
    options,
  );
  assert.equal(ended.ok, true);
  assert.equal(runtime.messages.length, 2);
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
  assert.equal(runtime.messages.length, 3);
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
