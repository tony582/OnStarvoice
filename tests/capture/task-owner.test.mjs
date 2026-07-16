import assert from "node:assert/strict";
import test from "node:test";

await import("../../utils/capture/task-owner.js");

const {
  OWNER_PORT_NAME,
  BIND_MESSAGE_TYPE,
  UNBIND_MESSAGE_TYPE,
  CANCELED_MESSAGE_TYPE,
  createCoordinator,
} = globalThis.OnStarvoiceCaptureTaskOwner;

function createPort(name = OWNER_PORT_NAME) {
  const messageListeners = new Set();
  const disconnectListeners = new Set();
  const posted = [];
  return {
    name,
    posted,
    postError: null,
    onMessage: {
      addListener(listener) {
        messageListeners.add(listener);
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.add(listener);
      },
    },
    postMessage(message) {
      if (this.postError) throw this.postError;
      posted.push(message);
    },
    emitMessage(message) {
      messageListeners.forEach((listener) => listener(message));
    },
    disconnect() {
      disconnectListeners.forEach((listener) => listener());
    },
  };
}

function createTimerDouble() {
  let nextId = 0;
  const pending = new Map();
  const cleared = [];
  return {
    pending,
    cleared,
    setTimeoutFn(callback, delay) {
      const id = ++nextId;
      pending.set(id, {callback, delay});
      return id;
    },
    clearTimeoutFn(id) {
      cleared.push(id);
      pending.delete(id);
    },
    async fire(id) {
      const timer = pending.get(id);
      if (!timer) return false;
      pending.delete(id);
      await timer.callback();
      return true;
    },
  };
}

test("only the dedicated capture owner port is accepted", () => {
  const coordinator = createCoordinator();
  const wrongPort = createPort("osv.some-other-port");
  assert.equal(coordinator.attachPort(wrongPort), false);
  wrongPort.emitMessage({type: BIND_MESSAGE_TYPE, taskId: "task-wrong"});
  assert.equal(coordinator.getOwner("task-wrong"), null);

  const ownerPort = createPort();
  assert.equal(coordinator.attachPort(ownerPort), true);
  assert.equal(coordinator.attachPort(ownerPort), true);
});

test("bind protocol is idempotent for the same task and port", () => {
  const coordinator = createCoordinator();
  const port = createPort();
  coordinator.attachPort(port);

  port.emitMessage({
    type: BIND_MESSAGE_TYPE,
    payload: {taskId: " task-repeat "},
  });
  assert.deepEqual(coordinator.getOwner("task-repeat"), {
    taskId: "task-repeat",
    connected: true,
    abandoning: false,
  });
  assert.equal(coordinator.bind(port, "task-repeat").reused, true);
});

test("disconnect waits for the grace period before abandoning the task", async () => {
  const timers = createTimerDouble();
  const abandoned = [];
  const coordinator = createCoordinator({
    graceMs: 1500,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onAbandoned: async (event) => abandoned.push(event),
  });
  const port = createPort();
  coordinator.attachPort(port);
  coordinator.bind(port, "task-disconnect");

  port.disconnect();
  assert.deepEqual(coordinator.getOwner("task-disconnect"), {
    taskId: "task-disconnect",
    connected: false,
    abandoning: true,
  });
  const [timerId, timer] = timers.pending.entries().next().value;
  assert.equal(timer.delay, 1500);
  assert.deepEqual(abandoned, []);

  await timers.fire(timerId);
  assert.deepEqual(abandoned, [{taskId: "task-disconnect"}]);
  assert.equal(coordinator.getOwner("task-disconnect"), null);
});

test("reconnecting the same task cancels its pending abandonment", async () => {
  const timers = createTimerDouble();
  const abandoned = [];
  const coordinator = createCoordinator({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onAbandoned: async (event) => abandoned.push(event),
  });
  const firstPort = createPort();
  const replacementPort = createPort();
  coordinator.attachPort(firstPort);
  coordinator.attachPort(replacementPort);
  coordinator.bind(firstPort, "task-reconnect");
  firstPort.disconnect();
  const timerId = timers.pending.keys().next().value;

  const rebound = coordinator.bind(replacementPort, "task-reconnect");
  assert.equal(rebound.reconnected, true);
  assert.deepEqual(timers.cleared, [timerId]);
  assert.deepEqual(coordinator.getOwner("task-reconnect"), {
    taskId: "task-reconnect",
    connected: true,
    abandoning: false,
  });
  assert.equal(await timers.fire(timerId), false);
  assert.deepEqual(abandoned, []);
});

test("a stale disconnect cannot abandon a task rebound to a newer port", () => {
  const timers = createTimerDouble();
  const coordinator = createCoordinator({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  const stalePort = createPort();
  const currentPort = createPort();
  coordinator.attachPort(stalePort);
  coordinator.attachPort(currentPort);
  coordinator.bind(stalePort, "task-stale-disconnect");
  coordinator.bind(currentPort, "task-stale-disconnect");

  stalePort.disconnect();
  assert.equal(timers.pending.size, 0);
  assert.deepEqual(coordinator.getOwner("task-stale-disconnect"), {
    taskId: "task-stale-disconnect",
    connected: true,
    abandoning: false,
  });
});

test("normal unbind and clearTask cancel ownership and pending timers", () => {
  const timers = createTimerDouble();
  const coordinator = createCoordinator({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  const port = createPort();
  coordinator.attachPort(port);
  coordinator.bind(port, "task-unbind");
  port.emitMessage({type: UNBIND_MESSAGE_TYPE, taskId: "task-unbind"});
  assert.equal(coordinator.getOwner("task-unbind"), null);

  const secondPort = createPort();
  coordinator.attachPort(secondPort);
  coordinator.bind(secondPort, "task-clear");
  secondPort.disconnect();
  const timerId = timers.pending.keys().next().value;
  assert.equal(coordinator.clearTask("task-clear").cleared, true);
  assert.deepEqual(timers.cleared, [timerId]);
  assert.equal(coordinator.getOwner("task-clear"), null);
});

test("a stale owner cannot unbind a task owned by its replacement", () => {
  const coordinator = createCoordinator();
  const stalePort = createPort();
  const currentPort = createPort();
  coordinator.attachPort(stalePort);
  coordinator.attachPort(currentPort);
  coordinator.bind(stalePort, "task-owner-check");
  coordinator.bind(currentPort, "task-owner-check");

  assert.deepEqual(coordinator.unbind(stalePort, "task-owner-check"), {
    unbound: false,
    reason: "owner_mismatch",
  });
  assert.equal(coordinator.getOwner("task-owner-check").connected, true);
});

test("notifyCanceled posts to the current owner and contains delivery failures", () => {
  const coordinator = createCoordinator();
  const port = createPort();
  coordinator.attachPort(port);
  coordinator.bind(port, "task-cancel-notice");

  assert.deepEqual(
    coordinator.notifyCanceled("task-cancel-notice", {reason: "native_cancel"}),
    {notified: true, taskId: "task-cancel-notice"},
  );
  assert.deepEqual(port.posted, [
    {
      type: CANCELED_MESSAGE_TYPE,
      taskId: "task-cancel-notice",
      payload: {reason: "native_cancel"},
    },
  ]);

  port.postError = new Error("port already disconnected");
  assert.doesNotThrow(() => {
    assert.deepEqual(
      coordinator.notifyCanceled("task-cancel-notice", {reason: "retry"}),
      {notified: false, reason: "post_failed"},
    );
  });
  assert.equal(coordinator.getOwner("task-cancel-notice").connected, true);
});
