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

test("a lost BEGIN response is confirmed by an exact idempotent resend before local activation", async () => {
  let beginAttempts = 0;
  const runtime = createRuntimeDouble(async (message) => {
    if (message.type === "onstarvoice:begin-capture-task") {
      beginAttempts += 1;
      if (beginAttempts === 1) {
        throw new Error("message port closed after BEGIN was applied");
      }
    }
    return {ok: true, data: {taskId: message.taskId}};
  });
  const options = {chromeApi: runtime.chromeApi};
  const taskId = "unattended-capture:uncertain-begin-confirmed";

  const begun = await beginCaptureTaskSession(
    {
      taskId,
      tabId: 45,
      label: "确认已应用 BEGIN",
      platform: "douyin",
      ownerRequired: false,
      attemptId: "attempt-confirmed",
    },
    options,
  );

  assert.equal(begun.ok, true);
  assert.equal(begun.active, true);
  const beginMessages = getTaskLifecycleMessages(runtime.messages).filter(
    (message) => message.type === "onstarvoice:begin-capture-task",
  );
  assert.equal(beginMessages.length, 2);
  assert.deepEqual(beginMessages[1], beginMessages[0]);

  await endCaptureTaskSession({taskId, reason: "completed"}, options);
});

test("an unconfirmed BEGIN sends an exact attempt-fenced END and never activates locally", async () => {
  const runtime = createRuntimeDouble(async (message) => {
    if (message.type === "onstarvoice:begin-capture-task") {
      throw new Error("message port closed after uncertain BEGIN");
    }
    return {ok: true, data: {taskId: message.taskId}};
  });
  const options = {chromeApi: runtime.chromeApi};
  const taskId = "unattended-capture:uncertain-begin-cleanup";

  const begun = await beginCaptureTaskSession(
    {
      taskId,
      tabId: 46,
      label: "BEGIN 响应持续丢失",
      platform: "xiaohongshu",
      ownerRequired: false,
      attemptId: "attempt-cleanup",
    },
    options,
  );

  assert.equal(begun.ok, false);
  assert.equal(begun.active, false);
  assert.equal(begun.cleanupAttempted, true);
  assert.equal(begun.cleanupConfirmed, true);
  assert.deepEqual(
    getTaskLifecycleMessages(runtime.messages).map((message) => message.type),
    [
      "onstarvoice:begin-capture-task",
      "onstarvoice:begin-capture-task",
      "onstarvoice:end-capture-task",
    ],
  );
  const cleanup = getTaskLifecycleMessages(runtime.messages).at(-1);
  assert.deepEqual(cleanup, {
    type: "onstarvoice:end-capture-task",
    taskId,
    reason: "begin_confirmation_failed",
    status: "failed",
    attemptId: "attempt-cleanup",
  });
  assert.equal(getTakeoverMessages(runtime.messages).length, 0);
  assert.equal(
    (
      await updateCaptureTaskSession(
        {taskId, progress: {phase: "must_not_publish"}},
        options,
      )
    ).reason,
    "no_active_task_session",
  );
});

test("an uncertain BEGIN with unconfirmed cleanup is a hard ownership failure", async () => {
  const runtime = createRuntimeDouble(async () => {
    throw new Error("message port unavailable before lifecycle confirmation");
  });
  const options = {chromeApi: runtime.chromeApi};
  const taskId = "unattended-capture:uncertain-cleanup-unconfirmed";

  const begun = await beginCaptureTaskSession(
    {
      taskId,
      tabId: 48,
      platform: "xiaohongshu",
      ownerRequired: false,
      attemptId: "attempt-cleanup-unconfirmed",
    },
    options,
  );

  assert.equal(begun.ok, false);
  assert.equal(begun.active, false);
  assert.equal(begun.reason, "capture_task_begin_cleanup_failed");
  assert.equal(begun.originalReason, "task_session_unavailable");
  assert.equal(begun.cleanupAttempted, true);
  assert.equal(begun.cleanupConfirmed, false);
  assert.deepEqual(
    getTaskLifecycleMessages(runtime.messages).map((message) => message.type),
    [
      "onstarvoice:begin-capture-task",
      "onstarvoice:begin-capture-task",
      "onstarvoice:end-capture-task",
      "onstarvoice:end-capture-task",
    ],
  );
  assert.equal(getTakeoverMessages(runtime.messages).length, 0);
});

test("an ignored BEGIN confirmation is authoritative and never becomes locally active", async () => {
  let beginAttempts = 0;
  const runtime = createRuntimeDouble(async (message) => {
    if (message.type === "onstarvoice:begin-capture-task") {
      beginAttempts += 1;
      if (beginAttempts === 1) {
        throw new Error("first BEGIN response was lost");
      }
      return {
        ok: true,
        data: {ignored: true, reason: "stale_unattended_attempt"},
      };
    }
    return {
      ok: true,
      data: {ignored: true, reason: "stale_unattended_attempt"},
    };
  });
  const options = {chromeApi: runtime.chromeApi};
  const taskId = "unattended-capture:uncertain-then-ignored";

  const begun = await beginCaptureTaskSession(
    {
      taskId,
      tabId: 47,
      platform: "douyin",
      attemptId: "attempt-obsolete",
    },
    options,
  );

  assert.equal(begun.ok, false);
  assert.equal(begun.active, false);
  assert.equal(begun.reason, "stale_unattended_attempt");
  assert.equal(begun.cleanupAttempted, true);
  assert.equal(getTakeoverMessages(runtime.messages).length, 0);
  assert.deepEqual(
    getTaskLifecycleMessages(runtime.messages).map((message) => message.type),
    [
      "onstarvoice:begin-capture-task",
      "onstarvoice:begin-capture-task",
      "onstarvoice:end-capture-task",
    ],
  );
});

test("an ignored stale BEGIN never creates a local active session", async () => {
  const runtime = createRuntimeDouble(async (message) => {
    if (message.type === "onstarvoice:begin-capture-task") {
      return {
        ok: true,
        data: {ignored: true, reason: "stale_unattended_attempt"},
      };
    }
    return {ok: true, data: {ok: true}};
  });
  const options = {chromeApi: runtime.chromeApi};
  const taskId = "unattended-capture:stale-begin";

  const begun = await beginCaptureTaskSession(
    {
      taskId,
      tabId: 44,
      platform: "douyin",
      attemptId: "attempt-stale",
    },
    options,
  );

  assert.equal(begun.ok, false);
  assert.equal(begun.active, false);
  assert.equal(begun.reason, "stale_unattended_attempt");
  assert.equal(
    (await updateCaptureTaskSession({taskId, progress: {phase: "late"}}, options))
      .reason,
    "no_active_task_session",
  );
  assert.equal(getTakeoverMessages(runtime.messages).length, 0);
});

test("an authoritative source mismatch stays a hard rejection without local retry", async () => {
  let replacementBeginAttempts = 0;
  const runtime = createRuntimeDouble(async (message) => {
    if (
      message.type === "onstarvoice:begin-capture-task" &&
      Number(message.tabId) === 52
    ) {
      replacementBeginAttempts += 1;
      return {
        ok: false,
        error: {code: "capture_task_source_mismatch"},
      };
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

  assert.equal(rebound.ok, false);
  assert.equal(rebound.active, false);
  assert.equal(rebound.reason, "capture_task_source_mismatch");
  assert.equal(replacementBeginAttempts, 1);
  const beginMessages = getTaskLifecycleMessages(runtime.messages).filter(
    (message) => message.type === "onstarvoice:begin-capture-task",
  );
  assert.deepEqual(
    beginMessages.map((message) => message.tabId),
    [51, 52],
  );

  await endCaptureTaskSession(
    {taskId: "task-source-rebound", reason: "completed"},
    options,
  );
  assert.equal(getTakeoverMessages(runtime.messages).at(-1).tabId, 51);
});

test("a confirmed stale-assist degradation keeps exact END ownership without drawing an active overlay", async () => {
  const runtime = createRuntimeDouble(async (message) => {
    if (message.type === "onstarvoice:begin-capture-task") {
      return {
        ok: true,
        data: {
          taskId: message.taskId,
          assistDegraded: true,
          assistReason: "capture_assist_source_stale",
        },
      };
    }
    return {ok: true, data: {released: true}};
  });
  const options = {chromeApi: runtime.chromeApi};
  const taskId = "task-stale-assist-degraded";

  const begun = await beginCaptureTaskSession(
    {
      taskId,
      tabId: 52,
      platform: "douyin",
      attemptId: "attempt-stale-assist",
    },
    options,
  );

  assert.equal(begun.ok, true);
  assert.equal(begun.active, true);
  assert.equal(begun.degraded, true);
  assert.equal(begun.assistReason, "capture_assist_source_stale");
  assert.deepEqual(
    getTakeoverMessages(runtime.messages).at(-1),
    {
      type: "onstarvoice:relay-to-content",
      tabId: 52,
      payload: {
        action: "setCaptureTaskTakeover",
        taskId,
        active: false,
        label: "采集辅助运行中",
        clearTrace: true,
      },
    },
  );

  await endCaptureTaskSession({taskId, reason: "completed"}, options);
  const end = getTaskLifecycleMessages(runtime.messages).find(
    (message) => message.type === "onstarvoice:end-capture-task",
  );
  assert.equal(end.attemptId, "attempt-stale-assist");
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
