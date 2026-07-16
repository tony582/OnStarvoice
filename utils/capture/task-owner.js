(function installCaptureTaskOwner(root, factory) {
  const api = factory();
  if (typeof module === "object" && module?.exports) {
    module.exports = api;
  }
  root.OnStarvoiceCaptureTaskOwner = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function createCaptureTaskOwnerApi() {
    const OWNER_PORT_NAME = "osv.capture.sidebar-owner.v1";
    const BIND_MESSAGE_TYPE = "capture-owner:bind";
    const UNBIND_MESSAGE_TYPE = "capture-owner:unbind";
    const CANCELED_MESSAGE_TYPE = "capture-owner:canceled";
    const DEFAULT_GRACE_MS = 1500;

    function cleanText(value, maxLength = 320) {
      return String(value || "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
    }

    function normalizeTaskId(value) {
      return cleanText(value, 320);
    }

    function resolveMessageTaskId(message) {
      return normalizeTaskId(message?.taskId || message?.payload?.taskId);
    }

    function createCoordinator({
      portName = OWNER_PORT_NAME,
      graceMs = DEFAULT_GRACE_MS,
      onAbandoned = null,
      setTimeoutFn = (...args) => setTimeout(...args),
      clearTimeoutFn = (timerId) => clearTimeout(timerId),
    } = {}) {
      const normalizedPortName = cleanText(portName, 160) || OWNER_PORT_NAME;
      const normalizedGraceMs =
        Number.isFinite(Number(graceMs)) && Number(graceMs) >= 0
          ? Number(graceMs)
          : DEFAULT_GRACE_MS;
      const ownersByTaskId = new Map();
      const taskIdsByPort = new Map();
      const attachedPorts = new Set();
      let generation = 0;

      function isSupportedPort(port) {
        return Boolean(
          port &&
            port.name === normalizedPortName &&
            typeof port.onMessage?.addListener === "function" &&
            typeof port.onDisconnect?.addListener === "function",
        );
      }

      function forgetPortTask(port, taskId) {
        const taskIds = taskIdsByPort.get(port);
        if (!taskIds) return;
        taskIds.delete(taskId);
        if (taskIds.size === 0) taskIdsByPort.delete(port);
      }

      function rememberPortTask(port, taskId) {
        const taskIds = taskIdsByPort.get(port) || new Set();
        taskIds.add(taskId);
        taskIdsByPort.set(port, taskIds);
      }

      function cancelAbandonTimer(owner) {
        if (!owner || owner.timerId === null) return false;
        clearTimeoutFn(owner.timerId);
        owner.timerId = null;
        return true;
      }

      function publicOwner(owner, overrides = {}) {
        if (!owner) return null;
        return {
          taskId: owner.taskId,
          connected: Boolean(owner.port),
          abandoning: owner.timerId !== null,
          ...overrides,
        };
      }

      function bind(port, taskId) {
        const normalizedTaskId = normalizeTaskId(taskId);
        if (!normalizedTaskId) {
          return {bound: false, reason: "invalid_task"};
        }
        if (!attachedPorts.has(port) || !isSupportedPort(port)) {
          return {bound: false, reason: "invalid_port"};
        }

        const current = ownersByTaskId.get(normalizedTaskId);
        if (current?.port === port && current.timerId === null) {
          return publicOwner(current, {bound: true, reused: true});
        }

        const reconnected = Boolean(current);
        if (current) {
          cancelAbandonTimer(current);
          if (current.port) forgetPortTask(current.port, normalizedTaskId);
        }

        const owner = {
          taskId: normalizedTaskId,
          port,
          timerId: null,
          generation: ++generation,
        };
        ownersByTaskId.set(normalizedTaskId, owner);
        rememberPortTask(port, normalizedTaskId);
        return publicOwner(owner, {
          bound: true,
          reused: false,
          reconnected,
        });
      }

      function unbind(port, taskId) {
        const normalizedTaskId = normalizeTaskId(taskId);
        if (!normalizedTaskId) {
          return {unbound: false, reason: "invalid_task"};
        }
        const current = ownersByTaskId.get(normalizedTaskId);
        if (!current) {
          return {unbound: false, reason: "not_bound"};
        }
        if (current.port !== port) {
          return {unbound: false, reason: "owner_mismatch"};
        }
        cancelAbandonTimer(current);
        forgetPortTask(port, normalizedTaskId);
        ownersByTaskId.delete(normalizedTaskId);
        return {unbound: true, taskId: normalizedTaskId};
      }

      function clearTask(taskId) {
        const normalizedTaskId = normalizeTaskId(taskId);
        if (!normalizedTaskId) {
          return {cleared: false, reason: "invalid_task"};
        }
        const current = ownersByTaskId.get(normalizedTaskId);
        if (!current) {
          return {cleared: false, reason: "not_bound"};
        }
        cancelAbandonTimer(current);
        if (current.port) forgetPortTask(current.port, normalizedTaskId);
        ownersByTaskId.delete(normalizedTaskId);
        return {cleared: true, taskId: normalizedTaskId};
      }

      async function abandonIfCurrent(taskId, expectedGeneration) {
        const current = ownersByTaskId.get(taskId);
        if (
          !current ||
          current.port ||
          current.generation !== expectedGeneration
        ) {
          return false;
        }
        current.timerId = null;
        ownersByTaskId.delete(taskId);
        if (typeof onAbandoned === "function") {
          try {
            await Promise.resolve(onAbandoned({taskId}));
          } catch (error) {
            console.warn(
              "[CaptureTaskOwner] abandoned-task cleanup failed:",
              error?.message || error,
            );
          }
        }
        return true;
      }

      function scheduleAbandonment(taskId, port) {
        const current = ownersByTaskId.get(taskId);
        if (!current || current.port !== port) return false;
        forgetPortTask(port, taskId);
        const expectedGeneration = ++generation;
        const disconnectedOwner = {
          ...current,
          port: null,
          timerId: null,
          generation: expectedGeneration,
        };
        disconnectedOwner.timerId = setTimeoutFn(
          () => abandonIfCurrent(taskId, expectedGeneration),
          normalizedGraceMs,
        );
        ownersByTaskId.set(taskId, disconnectedOwner);
        return true;
      }

      function handlePortDisconnect(port) {
        if (!attachedPorts.delete(port)) return false;
        const taskIds = Array.from(taskIdsByPort.get(port) || []);
        taskIdsByPort.delete(port);
        for (const taskId of taskIds) {
          scheduleAbandonment(taskId, port);
        }
        return true;
      }

      function handlePortMessage(port, message) {
        const taskId = resolveMessageTaskId(message);
        if (message?.type === BIND_MESSAGE_TYPE) {
          return bind(port, taskId);
        }
        if (message?.type === UNBIND_MESSAGE_TYPE) {
          return unbind(port, taskId);
        }
        return {handled: false, reason: "unsupported_message"};
      }

      function attachPort(port) {
        if (!isSupportedPort(port)) return false;
        if (attachedPorts.has(port)) return true;
        attachedPorts.add(port);
        taskIdsByPort.set(port, taskIdsByPort.get(port) || new Set());
        port.onMessage.addListener((message) => {
          handlePortMessage(port, message);
        });
        port.onDisconnect.addListener(() => {
          handlePortDisconnect(port);
        });
        return true;
      }

      function notifyCanceled(taskId, payload = null) {
        const normalizedTaskId = normalizeTaskId(taskId);
        if (!normalizedTaskId) {
          return {notified: false, reason: "invalid_task"};
        }
        const owner = ownersByTaskId.get(normalizedTaskId);
        if (!owner?.port) {
          return {notified: false, reason: "owner_unavailable"};
        }
        try {
          owner.port.postMessage({
            type: CANCELED_MESSAGE_TYPE,
            taskId: normalizedTaskId,
            payload,
          });
          return {notified: true, taskId: normalizedTaskId};
        } catch {
          return {notified: false, reason: "post_failed"};
        }
      }

      return Object.freeze({
        attachPort,
        bind,
        unbind,
        clearTask,
        notifyCanceled,
        handlePortDisconnect,
        handlePortMessage,
        getOwner(taskId) {
          return publicOwner(ownersByTaskId.get(normalizeTaskId(taskId)));
        },
      });
    }

    return Object.freeze({
      OWNER_PORT_NAME,
      BIND_MESSAGE_TYPE,
      UNBIND_MESSAGE_TYPE,
      CANCELED_MESSAGE_TYPE,
      DEFAULT_GRACE_MS,
      createCoordinator,
    });
  },
);
