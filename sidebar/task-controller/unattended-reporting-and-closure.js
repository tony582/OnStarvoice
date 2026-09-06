// L3-A unattended-reporting-and-closure: original control flow, explicit state and compatibility ports.
export function createUnattendedReportingAndClosureController({controllerState, controllerPorts, controllerOperations}) {
  const {
    KEYWORD_PLAN_TERMINAL_STATUSES,
    KEYWORD_RUN_REQUEST_STORAGE_KEY,
    MAX_BATCH_KEYWORDS,
    UNATTENDED_FINAL_FLUSH_INTENT_STORAGE_PREFIX,
    UNATTENDED_FINAL_FLUSH_INTENT_VERSION,
    UNATTENDED_FINAL_FLUSH_RETRY_DELAYS_MS,
    UNATTENDED_FINAL_FLUSH_RETRY_DELAY_MS,
    UNATTENDED_INITIAL_REPORT_RETRY_DELAYS_MS,
    UNATTENDED_LOCAL_CLOSURE_READY_STORAGE_PREFIX,
    UNATTENDED_LOCAL_CLOSURE_READY_VERSION,
    UNATTENDED_PROTECTED_WAIT_TICK_MS,
    UNATTENDED_RUNTIME_MESSAGE_TIMEOUT_MS,
    UNATTENDED_RUN_HEARTBEAT_INTERVAL_MS,
    UNATTENDED_TERMINAL_CONFIRM_RETRY_MAX_MS,
    UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS,
    chrome,
    clearInterval,
    clearTimeout,
    console,
    discardUnattendedCheckpointReports,
    enqueueUnattendedCheckpointReport,
    ensureControlStorageReserve,
    flushUnattendedCheckpointReportOutbox,
    getKeywordExecutionCopy,
    isStorageQuotaError,
    releaseControlStorageReserve,
    setInterval,
    setTimeout,
    sleep,
    summarizeUnattendedKeywordCheckpoint,
  } = controllerPorts;
  const buildUnattendedTaskCounts = (...args) => controllerOperations.buildUnattendedTaskCounts(...args);
  const dedupeKeywords = (...args) => controllerOperations.dedupeKeywords(...args);
  const isCaptureTaskDetailPhase = (...args) => controllerOperations.isCaptureTaskDetailPhase(...args);
  const projectCaptureTaskProgress = (...args) => controllerOperations.projectCaptureTaskProgress(...args);
  const readFiniteProgressNumber = (...args) => controllerOperations.readFiniteProgressNumber(...args);
  const sleepWithStop = (...args) => controllerOperations.sleepWithStop(...args);

  function activateUnattendedRunRequest(request = {}) {
    const nextRequestId = String(request?.id || "").trim();
    const nextAttemptId = String(request?.attemptId || "").trim();
    const preserveClaimRaceCancellation = Boolean(
      nextRequestId &&
        nextAttemptId &&
        controllerState.pendingUnattendedCancellationRequestId === nextRequestId &&
        controllerState.pendingUnattendedCancellationAttemptId === nextAttemptId,
    );
    // A recovered request reuses this long-lived sidebar document. Clear only
    // the previous attempt's local stop state synchronously, before the first
    // await (including a protected round-gap wait). Any cancellation delivered
    // after activation therefore belongs to the new attempt and must survive.
    if (!preserveClaimRaceCancellation) {
      controllerState.activeCaptureTaskCancellationReason = "";
      controllerState.batchKeywordCancelRequested = false;
      controllerState.detailBatchCancelRequested = false;
      controllerState.searchCaptureCancelRequested = false;
    }
    controllerState.activeUnattendedRunRequestId = nextRequestId;
    controllerState.activeUnattendedRunAttemptId = nextAttemptId;
    controllerState.pendingUnattendedCancellationRequestId = "";
    controllerState.pendingUnattendedCancellationAttemptId = "";
    controllerState.activeUnattendedTerminalProgressKey = "";
    controllerState.activeUnattendedProgressSeq = Math.max(0, Number(request?.progressSeq) || 0);
    controllerState.activeUnattendedAttemptRejected = false;
    controllerState.lastUnattendedContentProgressAt = 0;
    controllerState.lastUnattendedContentProgressFingerprint = "";
  }

  function clearActiveUnattendedRunRequest(requestId = "", attemptId = "") {
    if (
      requestId &&
      controllerState.activeUnattendedRunRequestId &&
      controllerState.activeUnattendedRunRequestId !== requestId
    ) {
      return;
    }
    if (
      attemptId &&
      controllerState.activeUnattendedRunAttemptId &&
      controllerState.activeUnattendedRunAttemptId !== attemptId
    ) {
      return;
    }
    controllerState.activeUnattendedRunRequestId = "";
    controllerState.activeUnattendedRunAttemptId = "";
    // Keep the terminal fence after local cleanup. Detail/comment workers can
    // emit late events after the root request has already settled. A new root
    // run clears this fence in activateUnattendedRunRequest().
    controllerState.activeUnattendedProgressSeq = 0;
    controllerState.activeUnattendedAttemptRejected = false;
    controllerState.lastUnattendedContentProgressAt = 0;
    controllerState.lastUnattendedContentProgressFingerprint = "";
  }

  function stopRejectedUnattendedAttempt(reason = "attempt_mismatch") {
    if (controllerState.activeUnattendedAttemptRejected) {
      return;
    }
    controllerState.activeUnattendedAttemptRejected = true;
    controllerState.batchKeywordCancelRequested = true;
    controllerState.detailBatchCancelRequested = true;
    // attempt 已由 background 换代时，只停止旧侧栏本地编排。后台会在启动新 attempt
    // 前按旧 runner 精确取消；这里若再发不带 captureRequestId 的全页取消，迟到回包
    // 可能误伤复用同一平台标签页的新 attempt。
    console.warn("[Sidebar] Stopping stale unattended attempt:", reason);
  }

  async function reportUnattendedKeywordRun(
    requestId,
    patch = {},
    {
      attemptId = controllerState.activeUnattendedRunAttemptId,
      quiet = false,
      durableCheckpoint = false,
    } = {},
  ) {
    if (!requestId) {
      return {ok: false, accepted: false, reason: "missing_request_id", data: null};
    }
    try {
      const response = await sendUnattendedRuntimeMessage({
        type: "onstarvoice:update-unattended-keyword-run",
        requestId,
        attemptId: String(attemptId || ""),
        patch,
      });
      const hasExplicitAcceptance = typeof response?.accepted === "boolean";
      const accepted = response?.accepted === true && response?.ok !== false;
      const reason = String(
        response?.reason || (hasExplicitAcceptance ? "" : "transport_error"),
      );
      if (
        !accepted &&
        (reason === "attempt_mismatch" || reason === "terminal")
      ) {
        stopRejectedUnattendedAttempt(reason);
      }
      if (
        !accepted &&
        ["attempt_mismatch", "not_found", "terminal"].includes(reason)
      ) {
        await discardUnattendedCheckpointReports({requestId, attemptId});
      }
      if (!accepted && !hasExplicitAcceptance && durableCheckpoint) {
        const queued = await enqueueUnattendedCheckpointReport({
          requestId,
          attemptId,
          patch,
        });
        if (queued.ok) {
          return {
            ok: true,
            accepted: true,
            reason: "queued_durable",
            data: null,
            durable: true,
          };
        }
      }
      // Do not delete a queued checkpoint merely because this direct report was
      // accepted: a newer report for the same attempt may have been queued while
      // this message was in flight. Flush below preserves revision fencing, and
      // the task ledger rejects an older replay as stale_progress.
      if (accepted) {
        void flushPendingUnattendedCheckpointReports({quiet: true});
      }
      return {
        ok: hasExplicitAcceptance && response?.ok !== false,
        accepted,
        reason,
        data: response?.data || null,
      };
    } catch (error) {
      if (durableCheckpoint) {
        const queued = await enqueueUnattendedCheckpointReport({
          requestId,
          attemptId,
          patch,
        });
        if (queued.ok) {
          return {
            ok: true,
            accepted: true,
            reason: "queued_durable",
            data: null,
            durable: true,
          };
        }
      }
      if (!quiet) {
        console.warn("[Sidebar] Update unattended keyword run failed:", error);
      }
      return {
        ok: false,
        accepted: false,
        reason: "transport_error",
        data: null,
        error,
      };
    }
  }

  function flushPendingUnattendedCheckpointReports({quiet = false} = {}) {
    if (controllerState.unattendedCheckpointOutboxFlushPromise) {
      return controllerState.unattendedCheckpointOutboxFlushPromise;
    }
    controllerState.unattendedCheckpointOutboxFlushPromise =
      flushUnattendedCheckpointReportOutbox({
        send: sendUnattendedRuntimeMessage,
      })
        .catch((error) => {
          if (!quiet) {
            console.warn(
              "[Sidebar] Flush unattended checkpoint outbox failed:",
              error,
            );
          }
          return {ok: false, reason: "flush_error", error};
        })
        .finally(() => {
          controllerState.unattendedCheckpointOutboxFlushPromise = null;
        });
    return controllerState.unattendedCheckpointOutboxFlushPromise;
  }

  function buildUnattendedLocalClosureReadyStorageKey(
    requestId = "",
    attemptId = "",
  ) {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedAttemptId = String(attemptId || "").trim();
    return normalizedRequestId && normalizedAttemptId
      ? `${UNATTENDED_LOCAL_CLOSURE_READY_STORAGE_PREFIX}` +
          `${normalizedRequestId}.${normalizedAttemptId}`
      : "";
  }

  function buildUnattendedFinalFlushIntentStorageKey(
    requestId = "",
    attemptId = "",
  ) {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedAttemptId = String(attemptId || "").trim();
    return normalizedRequestId && normalizedAttemptId
      ? `${UNATTENDED_FINAL_FLUSH_INTENT_STORAGE_PREFIX}` +
          `${normalizedRequestId}.${normalizedAttemptId}`
      : "";
  }

  function unattendedFinalFlushIdentity(requestId = "", attemptId = "") {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedAttemptId = String(attemptId || "").trim();
    return normalizedRequestId && normalizedAttemptId
      ? `${normalizedRequestId}:${normalizedAttemptId}`
      : "";
  }

  async function setUnattendedLocalClosureControlState(values) {
    try {
      await chrome.storage.local.set(values);
    } catch (error) {
      if (!isStorageQuotaError(error)) throw error;
      await releaseControlStorageReserve();
      await chrome.storage.local.set(values);
      void ensureControlStorageReserve();
    }
  }

  function clearUnattendedFinalFlushRetryTimer(identity = "") {
    const normalizedIdentity = String(identity || "").trim();
    const timer = controllerState.unattendedFinalFlushRetryTimersByIdentity.get(normalizedIdentity);
    if (timer) clearTimeout(timer);
    controllerState.unattendedFinalFlushRetryTimersByIdentity.delete(normalizedIdentity);
  }

  function scheduleUnattendedFinalFlushRetry({
    requestId,
    attemptId,
    failureCount = 0,
    nextRetryAt = "",
  } = {}) {
    const identity = unattendedFinalFlushIdentity(requestId, attemptId);
    if (!identity || controllerState.unattendedFinalFlushRetryTimersByIdentity.has(identity)) {
      return false;
    }
    const scheduledAt = Date.parse(String(nextRetryAt || ""));
    const delayMs = Number.isFinite(scheduledAt)
      ? Math.max(250, scheduledAt - Date.now())
      : UNATTENDED_FINAL_FLUSH_RETRY_DELAY_MS;
    const timer = setTimeout(async () => {
      controllerState.unattendedFinalFlushRetryTimersByIdentity.delete(identity);
      try {
        await finalizeUnattendedLocalClosureAfterFlush(requestId, attemptId, {
          ensureIntent: false,
        });
      } catch (error) {
        console.warn(
          "[Sidebar] Retry unattended terminal checkpoint flush failed:",
          error,
        );
        scheduleUnattendedFinalFlushRetry({
          requestId,
          attemptId,
          failureCount: Math.max(0, Number(failureCount) || 0) + 1,
        });
      }
    }, delayMs);
    controllerState.unattendedFinalFlushRetryTimersByIdentity.set(identity, timer);
    return true;
  }

  async function ensureUnattendedFinalFlushIntent(requestId, attemptId) {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedAttemptId = String(attemptId || "").trim();
    const intentKey = buildUnattendedFinalFlushIntentStorageKey(
      normalizedRequestId,
      normalizedAttemptId,
    );
    const markerKey = buildUnattendedLocalClosureReadyStorageKey(
      normalizedRequestId,
      normalizedAttemptId,
    );
    if (!intentKey || !markerKey) {
      return {ok: false, reason: "attempt_identity_missing"};
    }
    const stored = await chrome.storage.local.get([
      KEYWORD_RUN_REQUEST_STORAGE_KEY,
      intentKey,
      markerKey,
    ]);
    const current = stored?.[KEYWORD_RUN_REQUEST_STORAGE_KEY];
    if (
      String(current?.id || "").trim() !== normalizedRequestId ||
      String(current?.attemptId || "").trim() !== normalizedAttemptId
    ) {
      return {ok: false, reason: "attempt_superseded"};
    }
    if (
      !KEYWORD_PLAN_TERMINAL_STATUSES.has(
        String(current?.status || "").trim().toLowerCase(),
      )
    ) {
      return {ok: false, reason: "request_not_terminal"};
    }
    const existingMarker = stored?.[markerKey];
    const existingIntent = stored?.[intentKey];
    if (
      existingMarker?.version === UNATTENDED_LOCAL_CLOSURE_READY_VERSION &&
      String(existingMarker.requestId || "").trim() === normalizedRequestId &&
      String(existingMarker.attemptId || "").trim() === normalizedAttemptId
    ) {
      return {
        ok: true,
        reason: "checkpoint_flush_ready",
        status: "ready",
        marker: existingMarker,
        intent: existingIntent || null,
      };
    }
    if (String(existingIntent?.status || "") === "ready") {
      return {ok: false, reason: "closure_already_finalized"};
    }
    const now = new Date().toISOString();
    const intent = {
      version: UNATTENDED_FINAL_FLUSH_INTENT_VERSION,
      requestId: normalizedRequestId,
      attemptId: normalizedAttemptId,
      status: "pending",
      createdAt: String(existingIntent?.createdAt || now),
      updatedAt: now,
      failureCount: Math.max(0, Number(existingIntent?.failureCount) || 0),
      nextRetryAt: String(existingIntent?.nextRetryAt || ""),
    };
    await setUnattendedLocalClosureControlState({[intentKey]: intent});
    return {ok: true, reason: "checkpoint_flush_pending", status: "pending", intent};
  }

  async function recordUnattendedFinalFlushFailure(
    requestId,
    attemptId,
    reason = "checkpoint_flush_failed",
  ) {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedAttemptId = String(attemptId || "").trim();
    const identity = unattendedFinalFlushIdentity(
      normalizedRequestId,
      normalizedAttemptId,
    );
    const intentKey = buildUnattendedFinalFlushIntentStorageKey(
      normalizedRequestId,
      normalizedAttemptId,
    );
    if (!identity || !intentKey) return false;
    const stored = await chrome.storage.local.get([
      KEYWORD_RUN_REQUEST_STORAGE_KEY,
      intentKey,
    ]);
    const current = stored?.[KEYWORD_RUN_REQUEST_STORAGE_KEY];
    const intent = stored?.[intentKey];
    if (
      String(current?.id || "").trim() !== normalizedRequestId ||
      String(current?.attemptId || "").trim() !== normalizedAttemptId ||
      !KEYWORD_PLAN_TERMINAL_STATUSES.has(
        String(current?.status || "").trim().toLowerCase(),
      ) ||
      String(intent?.status || "") !== "pending"
    ) {
      clearUnattendedFinalFlushRetryTimer(identity);
      return false;
    }
    const failureCount = Math.max(0, Number(intent.failureCount) || 0) + 1;
    const nextRetryAt = new Date(
      Date.now() + UNATTENDED_FINAL_FLUSH_RETRY_DELAY_MS,
    ).toISOString();
    const nextIntent = {
      ...intent,
      status: "pending",
      failureCount,
      failureReason: String(reason || "checkpoint_flush_failed"),
      nextRetryAt,
      updatedAt: new Date().toISOString(),
    };
    await setUnattendedLocalClosureControlState({[intentKey]: nextIntent});
    clearUnattendedFinalFlushRetryTimer(identity);
    scheduleUnattendedFinalFlushRetry({
      requestId: normalizedRequestId,
      attemptId: normalizedAttemptId,
      failureCount,
      nextRetryAt,
    });
    return true;
  }

  async function persistUnattendedLocalClosureReadyMarker(
    requestId,
    attemptId,
  ) {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedAttemptId = String(attemptId || "").trim();
    const key = buildUnattendedLocalClosureReadyStorageKey(
      normalizedRequestId,
      normalizedAttemptId,
    );
    const intentKey = buildUnattendedFinalFlushIntentStorageKey(
      normalizedRequestId,
      normalizedAttemptId,
    );
    if (!key || !intentKey) {
      return {ok: false, reason: "attempt_identity_missing"};
    }
    const stored = await chrome.storage.local.get(
      KEYWORD_RUN_REQUEST_STORAGE_KEY,
    );
    const current = stored?.[KEYWORD_RUN_REQUEST_STORAGE_KEY];
    if (
      String(current?.id || "").trim() !== normalizedRequestId ||
      String(current?.attemptId || "").trim() !== normalizedAttemptId
    ) {
      return {ok: false, reason: "attempt_superseded"};
    }
    if (
      !KEYWORD_PLAN_TERMINAL_STATUSES.has(
        String(current?.status || "").trim().toLowerCase(),
      )
    ) {
      return {ok: false, reason: "request_not_terminal"};
    }
    const marker = {
      version: UNATTENDED_LOCAL_CLOSURE_READY_VERSION,
      requestId: normalizedRequestId,
      attemptId: normalizedAttemptId,
      readyAt: new Date().toISOString(),
    };
    await setUnattendedLocalClosureControlState({
      [key]: marker,
      [intentKey]: {
        version: UNATTENDED_FINAL_FLUSH_INTENT_VERSION,
        requestId: normalizedRequestId,
        attemptId: normalizedAttemptId,
        status: "ready",
        readyAt: marker.readyAt,
        updatedAt: marker.readyAt,
      },
    });
    await chrome.storage.local.remove(intentKey);
    clearUnattendedFinalFlushRetryTimer(
      unattendedFinalFlushIdentity(
        normalizedRequestId,
        normalizedAttemptId,
      ),
    );
    return {ok: true, reason: "checkpoint_flush_ready", marker};
  }

  async function finalizeUnattendedLocalClosureAfterFlush(
    requestId,
    attemptId,
    {ensureIntent = true} = {},
  ) {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedAttemptId = String(attemptId || "").trim();
    const identity = unattendedFinalFlushIdentity(
      normalizedRequestId,
      normalizedAttemptId,
    );
    if (!identity) {
      return {ok: false, reason: "attempt_identity_missing"};
    }
    const existing = controllerState.unattendedFinalFlushInFlightByIdentity.get(identity);
    if (existing) return await existing;
    const finalize = async () => {
      let intentState = null;
      if (ensureIntent) {
        intentState = await ensureUnattendedFinalFlushIntent(
          normalizedRequestId,
          normalizedAttemptId,
        );
        if (!intentState.ok) return intentState;
      } else {
        const intentKey = buildUnattendedFinalFlushIntentStorageKey(
          normalizedRequestId,
          normalizedAttemptId,
        );
        const markerKey = buildUnattendedLocalClosureReadyStorageKey(
          normalizedRequestId,
          normalizedAttemptId,
        );
        const stored = await chrome.storage.local.get([intentKey, markerKey]);
        intentState = {
          ok: Boolean(stored?.[intentKey]),
          status: String(stored?.[intentKey]?.status || ""),
          intent: stored?.[intentKey] || null,
          marker: stored?.[markerKey] || null,
          reason: stored?.[intentKey]
            ? "checkpoint_flush_pending"
            : "flush_intent_missing",
        };
        if (!intentState.ok) return intentState;
      }

      let ready = null;
      if (intentState.status === "ready" && intentState.marker) {
        ready = {
          ok: true,
          reason: "checkpoint_flush_ready",
          marker: intentState.marker,
        };
      } else {
        let flushResult = null;
        for (const delayMs of UNATTENDED_FINAL_FLUSH_RETRY_DELAYS_MS) {
          if (delayMs > 0) await sleep(delayMs);
          flushResult = await flushPendingUnattendedCheckpointReports({quiet: true});
          if (
            flushResult?.ok === true &&
            Number(flushResult?.retained || 0) === 0
          ) {
            break;
          }
        }
        if (
          flushResult?.ok !== true ||
          Number(flushResult?.retained || 0) !== 0
        ) {
          const reason = String(
            flushResult?.reason || "checkpoint_flush_failed",
          );
          await recordUnattendedFinalFlushFailure(
            normalizedRequestId,
            normalizedAttemptId,
            reason,
          );
          return {ok: false, reason, pending: true};
        }
        ready = await persistUnattendedLocalClosureReadyMarker(
          normalizedRequestId,
          normalizedAttemptId,
        );
        if (!ready.ok) return ready;
      }

      let response = null;
      for (const delayMs of UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS) {
        if (delayMs > 0) await sleep(delayMs);
        try {
          response = await sendUnattendedRuntimeMessage({
            type: "onstarvoice:finalize-unattended-local-closure",
            requestId: normalizedRequestId,
            attemptId: normalizedAttemptId,
            flushReady: true,
            readyAt: ready.marker.readyAt,
          });
          if (response?.accepted === true || response?.ok === true) break;
          if (
            ["attempt_superseded", "request_not_terminal"].includes(
              String(response?.reason || ""),
            )
          ) {
            break;
          }
        } catch {
          // The durable marker and storage change event are the authoritative
          // recovery path. This message only nudges a currently awake worker.
        }
      }
      return response || ready;
    };
    const inFlight = finalize().finally(() => {
      if (
        controllerState.unattendedFinalFlushInFlightByIdentity.get(identity) === inFlight
      ) {
        controllerState.unattendedFinalFlushInFlightByIdentity.delete(identity);
      }
    });
    controllerState.unattendedFinalFlushInFlightByIdentity.set(identity, inFlight);
    return await inFlight;
  }

  async function reconcilePendingUnattendedFinalFlushIntents() {
    const stored = await chrome.storage.local.get(null);
    const current = stored?.[KEYWORD_RUN_REQUEST_STORAGE_KEY];
    const currentRequestId = String(current?.id || "").trim();
    const currentAttemptId = String(current?.attemptId || "").trim();
    const currentTerminal = KEYWORD_PLAN_TERMINAL_STATUSES.has(
      String(current?.status || "").trim().toLowerCase(),
    );
    const staleKeys = [];
    for (const [key, intent] of Object.entries(stored || {})) {
      if (!key.startsWith(UNATTENDED_FINAL_FLUSH_INTENT_STORAGE_PREFIX)) {
        continue;
      }
      const requestId = String(intent?.requestId || "").trim();
      const attemptId = String(intent?.attemptId || "").trim();
      const identity = unattendedFinalFlushIdentity(requestId, attemptId);
      if (
        !identity ||
        !currentTerminal ||
        requestId !== currentRequestId ||
        attemptId !== currentAttemptId
      ) {
        staleKeys.push(key);
        clearUnattendedFinalFlushRetryTimer(identity);
        continue;
      }
      if (String(intent?.status || "") === "ready") {
        const markerKey = buildUnattendedLocalClosureReadyStorageKey(
          requestId,
          attemptId,
        );
        if (stored?.[markerKey]) {
          void finalizeUnattendedLocalClosureAfterFlush(requestId, attemptId, {
            ensureIntent: false,
          });
        }
        continue;
      }
      scheduleUnattendedFinalFlushRetry({
        requestId,
        attemptId,
        failureCount: intent?.failureCount,
        nextRetryAt: intent?.nextRetryAt,
      });
    }
    if (staleKeys.length > 0) {
      await chrome.storage.local.remove(staleKeys);
    }
  }

  async function reportInitialUnattendedKeywordRun(
    requestId,
    patch = {},
    {attemptId = controllerState.activeUnattendedRunAttemptId} = {},
  ) {
    let lastResult = null;
    for (const delayMs of UNATTENDED_INITIAL_REPORT_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      lastResult = await reportUnattendedKeywordRun(requestId, patch, {
        attemptId,
        quiet: delayMs < UNATTENDED_INITIAL_REPORT_RETRY_DELAYS_MS.at(-1),
      });
      if (lastResult.accepted || lastResult.reason !== "transport_error") {
        return lastResult;
      }
    }
    return lastResult;
  }

  async function sendUnattendedRuntimeMessage(message) {
    let timeoutId = null;
    try {
      return await Promise.race([
        chrome.runtime.sendMessage(message),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const error = new Error("无人值守状态上报超时");
            error.code = "UNATTENDED_RUNTIME_MESSAGE_TIMEOUT";
            reject(error);
          }, UNATTENDED_RUNTIME_MESSAGE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }
  }

  async function reportUnattendedTerminalRun(
    requestId,
    patch = {},
    {attemptId = controllerState.activeUnattendedRunAttemptId} = {},
  ) {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedAttemptId = String(attemptId || "").trim();
    const terminalProgressKey = `${normalizedRequestId}:${normalizedAttemptId}`;
    const commitTerminalFence = () => {
      if (
        normalizedRequestId &&
        normalizedRequestId ===
          String(controllerState.activeUnattendedRunRequestId || "").trim() &&
        (!normalizedAttemptId ||
          normalizedAttemptId ===
            String(controllerState.activeUnattendedRunAttemptId || "").trim())
      ) {
        // 只有后台确认终态（或确认当前 attempt 已被替换）后才立终态栅栏。
        // 若传输短暂失败，runner 仍需继续心跳并允许后台从检查点恢复。
        controllerState.activeUnattendedTerminalProgressKey = terminalProgressKey;
      }
    };
    let lastResult = null;
    let attemptIndex = 0;
    while (true) {
      const delayMs =
        attemptIndex < UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS.length
          ? UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS[attemptIndex]
          : Math.min(
              UNATTENDED_TERMINAL_CONFIRM_RETRY_MAX_MS,
              3000 *
                2 **
                  Math.min(
                    4,
                    attemptIndex - UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS.length,
                  ),
            );
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      lastResult = await reportUnattendedKeywordRun(requestId, patch, {
        attemptId,
        quiet: delayMs < UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS.at(-1),
      });
      if (
        lastResult.accepted ||
        lastResult.reason === "terminal" ||
        lastResult.reason === "attempt_mismatch"
      ) {
        commitTerminalFence();
        return lastResult;
      }
      // 只有传输层错误需要持续确认。后台明确拒绝时把结果交还调用方，
      // 避免不存在的任务在旧 runner 中无限重试。
      if (lastResult.reason !== "transport_error") {
        return lastResult;
      }
      attemptIndex += 1;
    }
  }

  function startUnattendedKeywordRunHeartbeat(
    requestId,
    attemptId = controllerState.activeUnattendedRunAttemptId,
  ) {
    if (!requestId) {
      return () => {};
    }

    let stopped = false;
    let reportInFlight = false;
    const reportHeartbeat = async () => {
      if (stopped || reportInFlight) {
        return;
      }
      reportInFlight = true;
      try {
        const result = await reportUnattendedKeywordRun(
          requestId,
          {
            heartbeatAt: new Date().toISOString(),
          },
          {attemptId},
        );
        if (
          result?.reason === "attempt_mismatch" ||
          result?.reason === "terminal"
        ) {
          stopped = true;
        }
      } finally {
        reportInFlight = false;
      }
    };

    void reportHeartbeat();
    const timerId = setInterval(
      reportHeartbeat,
      UNATTENDED_RUN_HEARTBEAT_INTERVAL_MS,
    );
    return () => {
      stopped = true;
      clearInterval(timerId);
    };
  }

  function createUnattendedKeywordProgressReporter(
    requestId,
    {
      checkpoint = null,
      taskTotal = 0,
      attemptId = controllerState.activeUnattendedRunAttemptId,
      executionMode = "unattended_plan",
    } = {},
  ) {
    const executionCopy = getKeywordExecutionCopy({executionMode});
    let lastFingerprint = "";
    let lastReportedAt = 0;
    let lastSnapshot = null;
    const detailTotalsByKeyword = new Map();
    const readCount = (value) => {
      if (value === null || value === undefined || value === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
    };
    const sumDetailField = (field) =>
      Array.from(detailTotalsByKeyword.values()).reduce(
        (total, item) => total + Math.max(0, Number(item?.[field]) || 0),
        0,
      );
    const reporter = (progress = {}) => {
      if (
        !requestId ||
        requestId !== String(controllerState.activeUnattendedRunRequestId || "").trim() ||
        (attemptId &&
          attemptId !== String(controllerState.activeUnattendedRunAttemptId || "").trim())
      ) {
        return;
      }
      const projectedProgress = projectCaptureTaskProgress(progress);
      const message = String(
        projectedProgress?.message || `${executionCopy.taskLabel}运行中`,
      ).trim();
      const phase = String(projectedProgress?.phase || "").trim();
      const detailKeyword = String(projectedProgress?.keyword || "").trim();
      if (detailKeyword && isCaptureTaskDetailPhase(phase)) {
        const round = Math.max(
          1,
          Number(
            projectedProgress?.roundCurrent ?? projectedProgress?.round,
          ) || 1,
        );
        const key = `${round}:${detailKeyword}`;
        const previous = detailTotalsByKeyword.get(key) || {
          success: 0,
          failed: 0,
          aiFiltered: 0,
          noEnhancement: 0,
        };
        const next = {...previous};
        const terminalDetailPhase = /^detail_batch_(?:done|failed|canceled|interrupted)$/u.test(
          phase,
        );
        const success = readCount(projectedProgress?.successCount);
        const failed = readCount(projectedProgress?.failedCount);
        const aiFiltered = readCount(projectedProgress?.aiFilteredCount);
        const noEnhancement = readCount(projectedProgress?.skippedCount);
        if (success !== null) {
          next.success = terminalDetailPhase
            ? success
            : Math.max(next.success, success);
        }
        if (failed !== null) {
          next.failed = terminalDetailPhase
            ? failed
            : Math.max(next.failed, failed);
        }
        if (aiFiltered !== null) {
          next.aiFiltered = Math.max(next.aiFiltered, aiFiltered);
        }
        if (noEnhancement !== null) {
          next.noEnhancement = Math.max(next.noEnhancement, noEnhancement);
        }
        detailTotalsByKeyword.set(key, next);
      }
      const now = Date.now();
      const remainingMs = Number.isFinite(Number(projectedProgress?.remainingMs))
        ? Math.max(0, Number(projectedProgress.remainingMs))
        : null;
      const updatedAt = new Date().toISOString();
      const checkpointSummary = summarizeUnattendedKeywordCheckpoint(
        checkpoint || {},
      );
      const progressSnapshot = {
        current: Number.isFinite(Number(projectedProgress?.current))
          ? Number(projectedProgress.current)
          : 0,
        total: Number.isFinite(Number(projectedProgress?.total))
          ? Number(projectedProgress.total)
          : 0,
        captureTaskId: String(projectedProgress?.captureTaskId || ""),
        unattendedRequestId: String(
          projectedProgress?.unattendedRequestId || requestId || "",
        ),
        unattendedAttemptId: String(
          projectedProgress?.unattendedAttemptId || attemptId || "",
        ),
        keyword: String(projectedProgress?.keyword || ""),
        keywordCurrent: readFiniteProgressNumber(
          projectedProgress?.keywordCurrent,
        ),
        keywordTotal: readFiniteProgressNumber(
          projectedProgress?.keywordTotal,
        ),
        itemCurrent: readFiniteProgressNumber(projectedProgress?.itemCurrent),
        itemTotal: readFiniteProgressNumber(projectedProgress?.itemTotal),
        nextKeyword: String(projectedProgress?.nextKeyword || ""),
        runStartedAt: String(projectedProgress?.runStartedAt || ""),
        finishedAt: String(projectedProgress?.finishedAt || ""),
        progressScope: String(projectedProgress?.progressScope || ""),
        phase,
        message,
        recordId: String(projectedProgress?.recordId || ""),
        runnerTabId: Number.isFinite(Number(projectedProgress?.runnerTabId))
          ? Number(projectedProgress.runnerTabId)
          : null,
        remainingMs,
        waitUntil:
          remainingMs !== null
            ? new Date(Date.now() + remainingMs).toISOString()
            : String(projectedProgress?.waitUntil || ""),
        round: readFiniteProgressNumber(
          projectedProgress?.roundCurrent,
          projectedProgress?.round,
        ),
        roundCurrent: readFiniteProgressNumber(
          projectedProgress?.roundCurrent,
          projectedProgress?.round,
        ),
        roundTotal: readFiniteProgressNumber(projectedProgress?.roundTotal),
        attemptCurrent: readFiniteProgressNumber(
          projectedProgress?.attemptCurrent,
          projectedProgress?.attempt,
        ),
        attemptTotal: readFiniteProgressNumber(
          projectedProgress?.attemptTotal,
          projectedProgress?.maxAttempts,
        ),
        phaseStartedAt: String(projectedProgress?.phaseStartedAt || ""),
        workerMode: String(projectedProgress?.workerMode || ""),
        workerStates: Array.isArray(projectedProgress?.workerStates)
          ? projectedProgress.workerStates.slice(0, 2)
          : [],
        taskMeta:
          projectedProgress?.taskMeta &&
          typeof projectedProgress.taskMeta === "object"
            ? projectedProgress.taskMeta
            : {},
        detectedCount: readFiniteProgressNumber(
          projectedProgress?.detectedCount,
        ),
        markedCount: readFiniteProgressNumber(projectedProgress?.markedCount),
        filteredCount: readFiniteProgressNumber(
          projectedProgress?.filteredCount,
        ),
        collectedCount: readFiniteProgressNumber(
          projectedProgress?.collectedCount,
        ),
        savedCount: readFiniteProgressNumber(projectedProgress?.savedCount),
        commentsCount: readFiniteProgressNumber(
          projectedProgress?.commentsCount,
          projectedProgress?.collectedCount,
        ),
        followersCount: readFiniteProgressNumber(
          projectedProgress?.followersCount,
          projectedProgress?.bloggerFollowersCount,
        ),
        detailSuccessCount: sumDetailField("success"),
        detailFailedCount: sumDetailField("failed"),
        aiFilteredCount: sumDetailField("aiFiltered"),
        noEnhancementCount: sumDetailField("noEnhancement"),
        syncSuccessCount: readCount(projectedProgress?.syncSuccessCount),
        syncFailedCount: readCount(projectedProgress?.syncFailedCount),
        syncSkippedCount: readCount(projectedProgress?.syncSkippedCount),
        syncRemainingCount: readCount(projectedProgress?.syncRemainingCount),
        progressPercent: readFiniteProgressNumber(
          projectedProgress?.progressPercent,
        ),
        updatedAt,
      };
      lastSnapshot = progressSnapshot;
      const fingerprint = JSON.stringify({
        message,
        phase,
        current: progressSnapshot.current,
        total: progressSnapshot.total,
        detailSuccessCount: progressSnapshot.detailSuccessCount,
        detailFailedCount: progressSnapshot.detailFailedCount,
        aiFilteredCount: progressSnapshot.aiFilteredCount,
        noEnhancementCount: progressSnapshot.noEnhancementCount,
        syncSuccessCount: progressSnapshot.syncSuccessCount,
        syncFailedCount: progressSnapshot.syncFailedCount,
        syncRemainingCount: progressSnapshot.syncRemainingCount,
      });
      if (fingerprint === lastFingerprint && now - lastReportedAt < 1500) {
        return;
      }
      lastFingerprint = fingerprint;
      lastReportedAt = now;
      controllerState.activeUnattendedProgressSeq += 1;
      void reportUnattendedKeywordRun(
        requestId,
        {
          status: "running",
          message,
          progressSeq: controllerState.activeUnattendedProgressSeq,
          businessProgressAt: updatedAt,
          counts: buildUnattendedTaskCounts(checkpoint || {}, checkpointSummary, {
            total: taskTotal,
          }),
          waitUntil:
            remainingMs !== null
              ? new Date(Date.now() + remainingMs).toISOString()
              : "",
          progress: progressSnapshot,
        },
        {attemptId},
      ).catch(() => null);
    };
    reporter.getSnapshot = () => (lastSnapshot ? {...lastSnapshot} : null);
    return reporter;
  }

  function resolveUnattendedProtectedWaitUntilMs(
    request = {},
    fallbackNotBeforeMs = 0,
  ) {
    const candidates = [
      request?.recoveryWaitUntil,
      request?.waitUntil,
      request?.progress?.waitUntil,
    ]
      .map((value) => Date.parse(String(value || "")))
      .filter((value) => Number.isFinite(value));
    const fallback = Number(fallbackNotBeforeMs);
    if (Number.isFinite(fallback) && fallback > 0) {
      candidates.push(fallback);
    }
    return candidates.length > 0 ? Math.max(...candidates) : 0;
  }

  async function reportUnattendedProtectedWaitState(
    requestId,
    {
      waitUntilMs = 0,
      remainingMs = 0,
      phase = "waiting_next_round",
      message = "等待下一轮采集",
      round = null,
      roundTotal = null,
      keyword = "",
      keywordCurrent = null,
      keywordTotal = null,
      counts = null,
      attemptId = "",
    } = {},
  ) {
    let lastResult = null;
    for (const delayMs of [0, 300, 900]) {
      if (delayMs > 0) await sleep(delayMs);
      if (
        controllerState.activeUnattendedAttemptRejected ||
        controllerState.batchKeywordCancelRequested ||
        controllerState.detailBatchCancelRequested ||
        requestId !== String(controllerState.activeUnattendedRunRequestId || "").trim() ||
        (attemptId &&
          attemptId !== String(controllerState.activeUnattendedRunAttemptId || "").trim())
      ) {
        return false;
      }
      controllerState.activeUnattendedProgressSeq += 1;
      const updatedAt = new Date().toISOString();
      const reportPatch = {
        status: "running",
        progressSeq: controllerState.activeUnattendedProgressSeq,
        waitUntil:
          Number.isFinite(Number(waitUntilMs)) && Number(waitUntilMs) > 0
            ? new Date(Number(waitUntilMs)).toISOString()
            : "",
        message,
        progress: {
          current: 0,
          total: 0,
          keyword: String(keyword || ""),
          keywordCurrent: readFiniteProgressNumber(keywordCurrent),
          keywordTotal: readFiniteProgressNumber(keywordTotal),
          itemCurrent: null,
          itemTotal: null,
          phase,
          message,
          remainingMs: Math.max(0, Number(remainingMs) || 0),
          round: Number.isFinite(Number(round)) ? Number(round) : null,
          roundCurrent: readFiniteProgressNumber(round),
          roundTotal: readFiniteProgressNumber(roundTotal),
          updatedAt,
        },
      };
      if (counts && typeof counts === "object") {
        reportPatch.counts = counts;
      }
      lastResult = await reportUnattendedKeywordRun(
        requestId,
        reportPatch,
        {attemptId},
      );
      if (lastResult?.accepted) return true;
      if (
        lastResult?.reason === "attempt_mismatch" ||
        lastResult?.reason === "terminal"
      ) {
        return false;
      }
    }
    const error = new Error("无法确认无人值守等待边界，已停止本次执行");
    error.code = "UNATTENDED_WAIT_STATE_WRITE_FAILED";
    throw error;
  }

  async function waitForUnattendedProtectedStart(
    request,
    {fallbackNotBeforeMs = 0, round = null} = {},
  ) {
    const requestId = String(request?.id || "").trim();
    const requestAttemptId = String(request?.attemptId || "").trim();
    if (!requestId) return false;
    const plannedKeywords = dedupeKeywords(
      Array.isArray(request?.planSnapshot?.keywords)
        ? request.planSnapshot.keywords
        : [],
    ).slice(0, MAX_BATCH_KEYWORDS);
    const plannedRounds = Math.max(
      1,
      Number(request?.planSnapshot?.maxRounds) || 1,
    );
    const plannedTaskTotal = plannedKeywords.length * plannedRounds;
    const checkpoint =
      request?.checkpoint && typeof request.checkpoint === "object"
        ? request.checkpoint
        : {};
    const checkpointSummary = summarizeUnattendedKeywordCheckpoint(checkpoint);
    const waitCounts = buildUnattendedTaskCounts(checkpoint, checkpointSummary, {
      total: plannedTaskTotal,
    });
    const activeKeywordIndex = Math.max(
      0,
      Math.min(
        plannedKeywords.length - 1,
        Number(checkpoint?.activeKeywordIndex) || 0,
      ),
    );
    const activeKeyword = String(
      checkpoint?.activeKeyword || plannedKeywords[activeKeywordIndex] || "",
    ).trim();
    const waitProgress = {
      roundTotal: plannedRounds,
      keyword: activeKeyword,
      keywordCurrent:
        plannedKeywords.length > 0 ? activeKeywordIndex + 1 : null,
      keywordTotal: plannedKeywords.length || null,
      counts: waitCounts,
    };
    const waitUntilMs = resolveUnattendedProtectedWaitUntilMs(
      request,
      fallbackNotBeforeMs,
    );
    const hadWaitMarker = Boolean(
      String(request?.recoveryWaitUntil || request?.waitUntil || request?.progress?.waitUntil || "").trim(),
    );

    while (waitUntilMs > Date.now()) {
      if (
        controllerState.activeUnattendedAttemptRejected ||
        controllerState.batchKeywordCancelRequested ||
        controllerState.detailBatchCancelRequested
      ) {
        return false;
      }
      const remainingMs = Math.max(0, waitUntilMs - Date.now());
      const message = `上一轮已完成，约 ${Math.max(1, Math.ceil(remainingMs / 60000))} 分钟后继续采集`;
      const accepted = await reportUnattendedProtectedWaitState(requestId, {
        waitUntilMs,
        remainingMs,
        message,
        round,
        attemptId: requestAttemptId,
        ...waitProgress,
      });
      if (!accepted) return false;
      await sleepWithStop(
        Math.min(remainingMs, UNATTENDED_PROTECTED_WAIT_TICK_MS),
        () =>
          controllerState.activeUnattendedAttemptRejected ||
          controllerState.batchKeywordCancelRequested ||
          controllerState.detailBatchCancelRequested,
      );
    }

    if (
      controllerState.activeUnattendedAttemptRejected ||
      controllerState.batchKeywordCancelRequested ||
      controllerState.detailBatchCancelRequested
    ) {
      return false;
    }
    if (!hadWaitMarker && !(Number(fallbackNotBeforeMs) > 0)) {
      return true;
    }
    return await reportUnattendedProtectedWaitState(requestId, {
      waitUntilMs: 0,
      remainingMs: 0,
      phase: "protected_wait_complete",
      message: "防风控等待已结束，准备继续采集",
      round,
      attemptId: requestAttemptId,
      ...waitProgress,
    });
  }

  return Object.freeze({
    activateUnattendedRunRequest,
    clearActiveUnattendedRunRequest,
    stopRejectedUnattendedAttempt,
    reportUnattendedKeywordRun,
    flushPendingUnattendedCheckpointReports,
    buildUnattendedLocalClosureReadyStorageKey,
    buildUnattendedFinalFlushIntentStorageKey,
    unattendedFinalFlushIdentity,
    setUnattendedLocalClosureControlState,
    clearUnattendedFinalFlushRetryTimer,
    scheduleUnattendedFinalFlushRetry,
    ensureUnattendedFinalFlushIntent,
    recordUnattendedFinalFlushFailure,
    persistUnattendedLocalClosureReadyMarker,
    finalizeUnattendedLocalClosureAfterFlush,
    reconcilePendingUnattendedFinalFlushIntents,
    reportInitialUnattendedKeywordRun,
    sendUnattendedRuntimeMessage,
    reportUnattendedTerminalRun,
    startUnattendedKeywordRunHeartbeat,
    createUnattendedKeywordProgressReporter,
    resolveUnattendedProtectedWaitUntilMs,
    reportUnattendedProtectedWaitState,
    waitForUnattendedProtectedStart,
  });
}
