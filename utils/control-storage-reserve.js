(function attachControlStorageReserve(root) {
  "use strict";

  const CONTROL_STORAGE_RESERVE_KEY =
    "onstarvoice.controlStorageReserve";
  const CONTROL_STORAGE_RESERVE_BYTES = 64 * 1024;
  const CONTROL_STORAGE_RESTORE_DELAY_MS = 1000;
  const CONTROL_STORAGE_RESTORE_HEADROOM_BYTES =
    CONTROL_STORAGE_RESERVE_BYTES * 2;
  const restoreTimers = new WeakMap();

  function resolveStorageArea(storage) {
    const area = storage || root.chrome?.storage?.local;
    if (
      !area ||
      typeof area.get !== "function" ||
      typeof area.set !== "function" ||
      typeof area.remove !== "function"
    ) {
      throw new Error("Chrome local storage is unavailable");
    }
    return area;
  }

  function isStorageQuotaError(error) {
    const name = String(error?.name || "");
    const message = String(error?.message || error || "");
    return (
      name === "QuotaExceededError" ||
      Number(error?.code) === 22 ||
      Number(error?.code) === 1014 ||
      /quota(?:bytes)?\s*(?:has been|was)?\s*exceeded/iu.test(message) ||
      /kQuotaBytes\s+quota\s+exceeded/iu.test(message) ||
      /QUOTA_BYTES/iu.test(message)
    );
  }

  function reserveValue() {
    return {
      schemaVersion: 1,
      padding: "0".repeat(CONTROL_STORAGE_RESERVE_BYTES),
    };
  }

  function hasValidReserve(value) {
    return Boolean(
      value?.schemaVersion === 1 &&
        String(value?.padding || "").length >=
          CONTROL_STORAGE_RESERVE_BYTES,
    );
  }

  async function hasVerifiedRestoreHeadroom(storage) {
    if (typeof storage.getBytesInUse !== "function") return false;
    const quotaBytes = Number(storage.QUOTA_BYTES);
    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) return false;
    const bytesUsed = Math.max(
      0,
      Number(await storage.getBytesInUse(null)) || 0,
    );
    return quotaBytes - bytesUsed >= CONTROL_STORAGE_RESTORE_HEADROOM_BYTES;
  }

  async function releaseControlStorageReserve({storage = null} = {}) {
    const area = resolveStorageArea(storage);
    await area.remove(CONTROL_STORAGE_RESERVE_KEY);
    return true;
  }

  async function ensureControlStorageReserve({
    storage = null,
    requireHeadroom = true,
  } = {}) {
    const area = resolveStorageArea(storage);
    const stored = await area.get(CONTROL_STORAGE_RESERVE_KEY);
    if (hasValidReserve(stored?.[CONTROL_STORAGE_RESERVE_KEY])) {
      return true;
    }
    if (
      requireHeadroom &&
      !(await hasVerifiedRestoreHeadroom(area))
    ) {
      return false;
    }
    await area.set({
      [CONTROL_STORAGE_RESERVE_KEY]: reserveValue(),
    });
    return true;
  }

  function scheduleControlStorageReserveRestore({
    storage = null,
    delayMs = CONTROL_STORAGE_RESTORE_DELAY_MS,
  } = {}) {
    const area = resolveStorageArea(storage);
    if (typeof root.setTimeout !== "function") return false;
    if (restoreTimers.has(area)) return true;
    const timer = root.setTimeout(async () => {
      restoreTimers.delete(area);
      try {
        await ensureControlStorageReserve({
          storage: area,
          requireHeadroom: true,
        });
      } catch (error) {
        // Reserve maintenance is best-effort and deliberately has no quota
        // retry. Retrying it through the reserve path would recurse forever
        // when the profile is still full.
        root.console?.warn?.(
          "[Storage] Failed to restore control reserve:",
          error,
        );
      }
    }, Math.max(0, Number(delayMs) || 0));
    timer?.unref?.();
    restoreTimers.set(area, timer);
    return true;
  }

  async function runWithControlStorageReserveRetry(
    operation,
    {
      storage = null,
      restoreDelayMs = CONTROL_STORAGE_RESTORE_DELAY_MS,
    } = {},
  ) {
    if (typeof operation !== "function") {
      throw new TypeError("control storage mutation must be a function");
    }
    const area = resolveStorageArea(storage);
    try {
      const value = await operation();
      scheduleControlStorageReserveRestore({
        storage: area,
        delayMs: restoreDelayMs,
      });
      return {value, retried: false, reserveReleased: false};
    } catch (initialError) {
      if (!isStorageQuotaError(initialError)) throw initialError;
      // One release, one retry. The operation itself is invoked again so a
      // fenced read-modify-write can re-read its authoritative attempt/lease
      // instead of replaying a stale prepared document.
      await releaseControlStorageReserve({storage: area});
      try {
        const value = await operation();
        scheduleControlStorageReserveRestore({
          storage: area,
          delayMs: restoreDelayMs,
        });
        return {value, retried: true, reserveReleased: true};
      } catch (retryError) {
        scheduleControlStorageReserveRestore({
          storage: area,
          delayMs: restoreDelayMs,
        });
        throw retryError;
      }
    }
  }

  root.OnStarvoiceControlStorageReserve = Object.freeze({
    CONTROL_STORAGE_RESERVE_KEY,
    CONTROL_STORAGE_RESERVE_BYTES,
    CONTROL_STORAGE_RESTORE_HEADROOM_BYTES,
    ensureControlStorageReserve,
    isStorageQuotaError,
    releaseControlStorageReserve,
    runWithControlStorageReserveRetry,
    scheduleControlStorageReserveRestore,
  });
})(globalThis);
