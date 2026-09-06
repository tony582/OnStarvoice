// L3-A targeted: original control flow, explicit state and compatibility ports.
export function createTargetedController({controllerState, controllerBindings, controllerPorts, controllerOperations}) {
  const {
    TARGETED_POST_RUN_ATTEMPT_QUERY_KEY,
    TARGETED_POST_RUN_HEARTBEAT_INTERVAL_MS,
    TARGETED_POST_RUN_QUERY_KEY,
    UNATTENDED_RUN_ATTEMPT_QUERY_KEY,
    UNATTENDED_RUN_QUERY_KEY,
    batchCaptureByUrls,
    buildCommentLeadsConfigFromSettings,
    buildSyncReconciliationError,
    chrome,
    clearInterval,
    clearTimeout,
    cloudTargetedPostApi,
    console,
    document,
    getCaptureSettings,
    getCurrentRuntime,
    getRecords,
    getTargetedWorkflowLabel,
    hasSyncReconciliationSignal,
    isTargetedProfileDiscoveryWorkflow,
    refreshDataPool,
    renderCaptureDebugSession,
    setInterval,
    setTimeout,
    showMessage,
    syncRecordBatch,
    window,
  } = controllerPorts;
  const acquireCaptureExecutionLock = (...args) => controllerOperations.acquireCaptureExecutionLock(...args);
  const executeMonitorRunItem = (...args) => controllerOperations.executeMonitorRunItem(...args);
  const releaseCaptureExecutionLock = (...args) => controllerOperations.releaseCaptureExecutionLock(...args);
  const requestCaptureCancelSignal = (...args) => controllerOperations.requestCaptureCancelSignal(...args);

  function getUnattendedRunRequestIdFromUrl() {
    try {
      return new URLSearchParams(window.location.search).get(
        UNATTENDED_RUN_QUERY_KEY,
      );
    } catch {
      return "";
    }
  }

  function getUnattendedRunAttemptIdFromUrl() {
    try {
      return (
        new URLSearchParams(window.location.search).get(
          UNATTENDED_RUN_ATTEMPT_QUERY_KEY,
        ) || ""
      ).trim();
    } catch {
      return "";
    }
  }

  function getTargetedPostRunRequestIdFromUrl() {
    try {
      return (
        new URLSearchParams(window.location.search).get(
          TARGETED_POST_RUN_QUERY_KEY,
        ) || ""
      ).trim();
    } catch {
      return "";
    }
  }

  function getTargetedPostRunAttemptIdFromUrl() {
    try {
      return (
        new URLSearchParams(window.location.search).get(
          TARGETED_POST_RUN_ATTEMPT_QUERY_KEY,
        ) || ""
      ).trim();
    } catch {
      return "";
    }
  }

  function createTargetedPostInvocationToken(requestId = "", attemptId = "") {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedAttemptId = String(attemptId || "").trim();
    if (!normalizedRequestId || !normalizedAttemptId) {
      return null;
    }
    return Object.freeze({
      requestId: normalizedRequestId,
      attemptId: normalizedAttemptId,
    });
  }

  function getTargetedPostInvocationTokenFromRequest(request) {
    return createTargetedPostInvocationToken(
      request?.id,
      request?.attemptId,
    );
  }

  function isSameTargetedPostInvocationToken(left, right) {
    return Boolean(
      left &&
        right &&
        left.requestId === right.requestId &&
        left.attemptId === right.attemptId,
    );
  }

  function isActiveTargetedPostInvocation(token) {
    return isSameTargetedPostInvocationToken(
      controllerState.activeTargetedPostInvocationToken,
      token,
    );
  }

  function activateTargetedPostInvocation(token) {
    const normalizedToken = createTargetedPostInvocationToken(
      token?.requestId,
      token?.attemptId,
    );
    controllerState.activeTargetedPostInvocationToken = normalizedToken;
    return normalizedToken;
  }

  function getTargetedPostInvocationOwnership(token) {
    return Object.freeze({
      active: isActiveTargetedPostInvocation(token),
      run: isSameTargetedPostInvocationToken(
        controllerState.targetedPostRunInFlightOwnerToken,
        token,
      ),
      batch: isSameTargetedPostInvocationToken(
        controllerState.targetedPostBatchStateOwnerToken,
        token,
      ),
      runnerTab: isSameTargetedPostInvocationToken(
        controllerState.targetedPostRunnerTabOwnerToken,
        token,
      ),
    });
  }

  function createTargetedPostInvocationError(
    reason = "stale_targeted_post_attempt",
  ) {
    const normalizedReason = String(reason || "").trim();
    const error = new Error(
      normalizedReason === "targeted_post_attempt_required"
        ? "定向作品任务缺少运行批次"
        : "定向作品任务已由新的运行批次接管",
    );
    error.code = normalizedReason || "stale_targeted_post_attempt";
    return error;
  }

  function handleTargetedPostRunRequestStorageChange(request) {
    const runnerRequestId = getTargetedPostRunRequestIdFromUrl();
    if (!runnerRequestId) {
      controllerState.targetedPostRunState = request;
      renderCaptureDebugSession(getCurrentRuntime() || {});
      return;
    }

    const runnerToken = createTargetedPostInvocationToken(
      runnerRequestId,
      getTargetedPostRunAttemptIdFromUrl(),
    );
    if (!runnerToken) {
      controllerState.activeTargetedPostInvocationToken = null;
      controllerState.targetedPostRunState = null;
      stopTargetedPostRunnerForInvalidBinding(
        "targeted_post_attempt_required",
      );
      renderCaptureDebugSession(getCurrentRuntime() || {});
      return;
    }

    const requestToken = getTargetedPostInvocationTokenFromRequest(request);
    if (
      controllerState.activeTargetedPostInvocationToken &&
      controllerState.activeTargetedPostInvocationToken.requestId === runnerRequestId &&
      !isSameTargetedPostInvocationToken(
        controllerState.activeTargetedPostInvocationToken,
        requestToken,
      )
    ) {
      activateTargetedPostInvocation(requestToken);
      controllerState.targetedPostRunState = null;
      stopTargetedPostRunnerForInvalidBinding(
        requestToken
          ? "stale_targeted_post_attempt"
          : "targeted_post_attempt_required",
      );
      renderCaptureDebugSession(getCurrentRuntime() || {});
      return;
    }

    if (!isSameTargetedPostInvocationToken(requestToken, runnerToken)) {
      return;
    }
    if (
      controllerState.activeTargetedPostInvocationToken &&
      !isSameTargetedPostInvocationToken(
        controllerState.activeTargetedPostInvocationToken,
        runnerToken,
      )
    ) {
      return;
    }
    if (!controllerState.activeTargetedPostInvocationToken) {
      activateTargetedPostInvocation(runnerToken);
    }
    controllerState.targetedPostRunState = request;
    renderCaptureDebugSession(getCurrentRuntime() || {});
    if (request?.cancelRequested === true) {
      controllerState.targetedPostCancelRequested = true;
      controllerState.batchUrlCancelRequested = true;
      if (
        controllerState.activeBatchRunnerTabId &&
        isSameTargetedPostInvocationToken(
          controllerState.targetedPostRunnerTabOwnerToken,
          runnerToken,
        )
      ) {
        void requestCaptureCancelSignal(controllerState.activeBatchRunnerTabId).catch(
          (error) => {
            console.warn(
              "[Sidebar] Targeted post cancellation signal failed:",
              error,
            );
          },
        );
      }
    }
  }

  function resolveTargetedPostRunBinding(
    response,
    requestId = "",
    attemptId = "",
  ) {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedAttemptId = String(attemptId || "").trim();
    if (!normalizedAttemptId) {
      return {
        accepted: false,
        reason: "targeted_post_attempt_required",
        request: null,
      };
    }

    if (!response?.ok || response?.accepted === false) {
      return {
        accepted: false,
        reason: String(
          response?.reason || "targeted_post_run_binding_rejected",
        ),
        request: null,
      };
    }

    const request =
      response?.data && typeof response.data === "object"
        ? response.data
        : null;
    if (
      !request ||
      String(request.id || "").trim() !== normalizedRequestId ||
      String(request.attemptId || "").trim() !== normalizedAttemptId
    ) {
      return {
        accepted: false,
        reason: "stale_targeted_post_attempt",
        request: null,
      };
    }

    return {accepted: true, reason: "", request};
  }

  function stopTargetedPostRunnerForInvalidBinding(reason = "") {
    const normalizedReason = String(reason || "").trim();
    if (controllerState.targetedPostRunBindingStopReason === normalizedReason) {
      return;
    }
    controllerState.targetedPostRunBindingStopReason = normalizedReason;
    const message =
      normalizedReason === "targeted_post_attempt_required"
        ? "定向作品任务链接缺少运行批次，已停止执行"
        : "当前定向作品任务运行批次已失效，旧页面已停止执行";
    console.warn("[Sidebar] Targeted post runner stopped:", normalizedReason);
    showMessage(message, "warning");
  }

  async function loadTargetedPostRunStateForDisplay() {
    try {
      const requestId = getTargetedPostRunRequestIdFromUrl();
      const attemptId = getTargetedPostRunAttemptIdFromUrl();
      const invocationToken = createTargetedPostInvocationToken(
        requestId,
        attemptId,
      );
      if (requestId && !attemptId) {
        controllerState.targetedPostRunState = null;
        stopTargetedPostRunnerForInvalidBinding(
          "targeted_post_attempt_required",
        );
        renderCaptureDebugSession(getCurrentRuntime() || {});
        return null;
      }

      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:get-targeted-post-run-state",
        ...(requestId ? {requestId, attemptId} : {}),
      });
      if (requestId) {
        const binding = resolveTargetedPostRunBinding(
          response,
          requestId,
          attemptId,
        );
        if (!binding.accepted) {
          controllerState.targetedPostRunState = null;
          stopTargetedPostRunnerForInvalidBinding(binding.reason);
          renderCaptureDebugSession(getCurrentRuntime() || {});
          return null;
        }
        if (
          controllerState.activeTargetedPostInvocationToken &&
          !isSameTargetedPostInvocationToken(
            controllerState.activeTargetedPostInvocationToken,
            invocationToken,
          )
        ) {
          stopTargetedPostRunnerForInvalidBinding(
            "stale_targeted_post_attempt",
          );
          return null;
        }
        if (!controllerState.activeTargetedPostInvocationToken) {
          activateTargetedPostInvocation(invocationToken);
        }
        if (!isActiveTargetedPostInvocation(invocationToken)) {
          return null;
        }
        controllerState.targetedPostRunState = binding.request;
      } else {
        controllerState.targetedPostRunState =
          response?.ok && response.data && typeof response.data === "object"
            ? response.data
            : null;
      }
      renderCaptureDebugSession(getCurrentRuntime() || {});
      return controllerState.targetedPostRunState;
    } catch (error) {
      console.warn(
        "[Sidebar] Load targeted post run state for display failed:",
        error,
      );
      return null;
    }
  }

  async function updateTargetedPostRun(
    request,
    patch = {},
    invocationToken = null,
  ) {
    const requestToken = getTargetedPostInvocationTokenFromRequest(request);
    if (!requestToken) {
      throw createTargetedPostInvocationError(
        "targeted_post_attempt_required",
      );
    }
    if (
      invocationToken &&
      (!isSameTargetedPostInvocationToken(requestToken, invocationToken) ||
        !isActiveTargetedPostInvocation(invocationToken))
    ) {
      throw createTargetedPostInvocationError();
    }
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:update-targeted-post-run",
      requestId: requestToken.requestId,
      attemptId: requestToken.attemptId,
      patch,
    });
    if (invocationToken && !isActiveTargetedPostInvocation(invocationToken)) {
      throw createTargetedPostInvocationError();
    }
    const binding = resolveTargetedPostRunBinding(
      response,
      requestToken.requestId,
      requestToken.attemptId,
    );
    if (!binding.accepted) {
      const error =
        binding.reason === "stale_targeted_post_attempt"
          ? createTargetedPostInvocationError(binding.reason)
          : new Error("定向作品任务状态更新失败");
      error.code = String(
        binding.reason || "TARGETED_POST_STATE_UPDATE_FAILED",
      );
      throw error;
    }
    if (invocationToken && !isActiveTargetedPostInvocation(invocationToken)) {
      throw createTargetedPostInvocationError();
    }
    controllerState.targetedPostRunState = binding.request;
    renderCaptureDebugSession(getCurrentRuntime() || {});
    return binding.request;
  }

  function startTargetedPostRunHeartbeat(invocationToken, getCurrentRequest) {
    let stopped = false;
    let inFlight = false;

    const publish = async () => {
      if (
        stopped ||
        inFlight ||
        !isActiveTargetedPostInvocation(invocationToken)
      ) {
        return;
      }
      const current =
        typeof getCurrentRequest === "function" ? getCurrentRequest() : null;
      const currentToken = getTargetedPostInvocationTokenFromRequest(current);
      if (
        !current ||
        !isSameTargetedPostInvocationToken(currentToken, invocationToken) ||
        cloudTargetedPostApi?.isTerminalRunStatus?.(current.status)
      ) {
        return;
      }

      inFlight = true;
      const now = new Date().toISOString();
      try {
        await updateTargetedPostRun(
          current,
          {
            heartbeatAt: now,
          },
          invocationToken,
        );
      } catch (error) {
        if (
          isActiveTargetedPostInvocation(invocationToken) &&
          String(error?.code || "") !== "targeted_post_run_terminal"
        ) {
          console.warn("[Sidebar] Targeted post heartbeat failed:", error);
        }
      } finally {
        inFlight = false;
      }
    };

    const timer = setInterval(() => {
      void publish();
    }, TARGETED_POST_RUN_HEARTBEAT_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async function cancelTargetedPostRunFromSidebar(requestId = "") {
    const current =
      controllerState.targetedPostRunState && typeof controllerState.targetedPostRunState === "object"
        ? controllerState.targetedPostRunState
        : null;
    if (
      !current ||
      (requestId && String(current.id || "") !== String(requestId))
    ) {
      return false;
    }
    if (cloudTargetedPostApi?.isTerminalRunStatus(current.status)) {
      return true;
    }
    const currentToken = getTargetedPostInvocationTokenFromRequest(current);
    if (!currentToken) {
      return false;
    }
    const runnerRequestId = getTargetedPostRunRequestIdFromUrl();
    const runnerToken = createTargetedPostInvocationToken(
      runnerRequestId,
      getTargetedPostRunAttemptIdFromUrl(),
    );
    if (
      runnerRequestId &&
      (!isSameTargetedPostInvocationToken(currentToken, runnerToken) ||
        !isActiveTargetedPostInvocation(runnerToken))
    ) {
      return false;
    }
    controllerState.targetedPostCancelRequested = true;
    controllerState.batchUrlCancelRequested = true;
    const workflowLabel =
      current.workflow === "official_account_comment_patrol"
        ? "官方账号评论巡查"
        : current.workflow === "followed_creator_post_patrol"
          ? "关注博主作品扫描"
          : current.workflow === "official_account_post_discovery"
            ? "官方账号作品发现"
            : "负面帖子巡查";
    await updateTargetedPostRun(current, {
      status:
        String(current.status || "") === "pending"
          ? "canceled"
          : "cancel_requested",
      cancelRequested: true,
      finishedAt:
        String(current.status || "") === "pending"
          ? new Date().toISOString()
          : "",
      message:
        String(current.status || "") === "pending"
          ? `${workflowLabel}已在执行前停止`
          : `正在停止${workflowLabel}并保留已有结果`,
    }, runnerRequestId ? runnerToken : null);
    if (
      controllerState.activeBatchRunnerTabId &&
      (!runnerRequestId ||
        isSameTargetedPostInvocationToken(
          controllerState.targetedPostRunnerTabOwnerToken,
          runnerToken,
        ))
    ) {
      await requestCaptureCancelSignal(controllerState.activeBatchRunnerTabId).catch(
        (error) => {
          console.warn(
            "[Sidebar] Targeted post cancellation signal failed:",
            error,
          );
        },
      );
    }
    return true;
  }

  async function confirmTargetedPostInvocationBinding(invocationToken) {
    if (!isActiveTargetedPostInvocation(invocationToken)) {
      return false;
    }
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:get-targeted-post-run-state",
      requestId: invocationToken.requestId,
      attemptId: invocationToken.attemptId,
    });
    const binding = resolveTargetedPostRunBinding(
      response,
      invocationToken.requestId,
      invocationToken.attemptId,
    );
    return binding.accepted && isActiveTargetedPostInvocation(invocationToken);
  }

  async function settleTargetedPostRunnerTab(
    tabId,
    platform = "",
    {returnHome = true} = {},
  ) {
    const normalizedTabId = Number(tabId);
    if (!Number.isSafeInteger(normalizedTabId) || normalizedTabId <= 0) {
      return false;
    }

    let runnerTab = null;
    try {
      runnerTab = await chrome.tabs.get(normalizedTabId);
    } catch {
      return false;
    }

    // 这个标签页由当前定向任务自己创建，可以安全收尾。先停止当前作品的
    // 音视频；正常终态直接关闭，避免每个巡检任务在浏览器里留下一个平台
    // 首页。needs_action 保留现场供用户处理，但同样停止媒体播放。
    try {
      await chrome.scripting.executeScript({
        target: {tabId: normalizedTabId},
        func: () => {
          let pausedCount = 0;
          document.querySelectorAll("video, audio").forEach((media) => {
            try {
              media.pause?.();
              media.autoplay = false;
              media.loop = false;
              media.removeAttribute?.("autoplay");
              media.removeAttribute?.("loop");
              pausedCount += 1;
            } catch {
              // 单个媒体节点不可控时继续处理其他节点。
            }
          });
          return pausedCount;
        },
      });
    } catch (error) {
      console.warn("[Sidebar] Pause targeted runner media failed:", error);
    }

    if (!returnHome) {
      return true;
    }

    try {
      await chrome.tabs.remove(normalizedTabId);
      return true;
    } catch (error) {
      console.warn("[Sidebar] Close targeted runner tab failed:", error);
      return false;
    }
  }

  async function waitForTargetedPostRunnerTab(tabId, shouldStop) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20 * 1000) {
      if (shouldStop()) {
        const error = new Error("定向作品任务已停止");
        error.code = "TARGET_CAPTURE_CANCELED";
        throw error;
      }
      try {
        const tab = await chrome.tabs.get(tabId);
        if (String(tab?.status || "") === "complete") {
          return tab;
        }
      } catch (error) {
        const wrapped = new Error(error?.message || "定向作品采集页已关闭");
        wrapped.code = "TARGET_RUNNER_TAB_CLOSED";
        throw wrapped;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const error = new Error("定向作品采集页打开超时");
    error.code = "TARGET_RUNNER_TAB_TIMEOUT";
    throw error;
  }

  function collectTargetedPostRecordIds(batchResult = {}) {
    const results = Array.isArray(batchResult?.results)
      ? batchResult.results
      : [];
    return [
      ...new Set(
        results.flatMap((result) =>
          Array.isArray(result?.recordIds)
            ? result.recordIds
                .map((recordId) => String(recordId || "").trim())
                .filter(Boolean)
            : [],
        ),
      ),
    ];
  }

  function buildTargetedProfileCaptureTaskContext(
    request = {},
    invocationToken = null,
  ) {
    const requestToken = getTargetedPostInvocationTokenFromRequest(request);
    if (
      !requestToken ||
      !invocationToken ||
      !isSameTargetedPostInvocationToken(requestToken, invocationToken)
    ) {
      throw createTargetedPostInvocationError(
        "stale_targeted_post_attempt",
      );
    }

    const officialCommentPatrol =
      String(request?.workflow || "").trim() ===
      "official_account_comment_patrol";
    // Native Debug resources for comment patrol use the physical run identity,
    // while server evidence always uses the UUID cloud task identity.
    return Object.freeze({
      taskId: officialCommentPatrol
        ? `${requestToken.requestId}::${requestToken.attemptId}`
        : "",
      captureTaskId: String(request.taskId || request.id || "").trim(),
      attemptId: requestToken.attemptId,
      label: getTargetedWorkflowLabel(request.workflow),
      ownerRequired: true,
    });
  }

  async function maybeClaimAndRunTargetedPostWorkflow() {
    const requestId = getTargetedPostRunRequestIdFromUrl();
    if (!requestId) {
      return;
    }
    const attemptId = getTargetedPostRunAttemptIdFromUrl();
    const invocationToken = createTargetedPostInvocationToken(
      requestId,
      attemptId,
    );
    if (!invocationToken) {
      controllerState.targetedPostRunState = null;
      stopTargetedPostRunnerForInvalidBinding(
        "targeted_post_attempt_required",
      );
      renderCaptureDebugSession(getCurrentRuntime() || {});
      return;
    }
    if (controllerState.targetedPostRunInFlight) {
      return;
    }
    if (!cloudTargetedPostApi?.normalizeCommandPayload) {
      throw new Error("当前扩展缺少定向作品采集协议");
    }

    const stateResponse = await chrome.runtime.sendMessage({
      type: "onstarvoice:get-targeted-post-run-state",
      requestId,
      attemptId,
    });
    const binding = resolveTargetedPostRunBinding(
      stateResponse,
      requestId,
      attemptId,
    );
    if (!binding.accepted) {
      controllerState.targetedPostRunState = null;
      stopTargetedPostRunnerForInvalidBinding(binding.reason);
      renderCaptureDebugSession(getCurrentRuntime() || {});
      return;
    }
    if (
      controllerState.activeTargetedPostInvocationToken &&
      !isSameTargetedPostInvocationToken(
        controllerState.activeTargetedPostInvocationToken,
        invocationToken,
      )
    ) {
      stopTargetedPostRunnerForInvalidBinding(
        "stale_targeted_post_attempt",
      );
      return;
    }
    if (!controllerState.activeTargetedPostInvocationToken) {
      activateTargetedPostInvocation(invocationToken);
    }
    if (!isActiveTargetedPostInvocation(invocationToken)) {
      return;
    }
    let request = binding.request;
    controllerState.targetedPostRunBindingStopReason = "";
    controllerState.targetedPostRunState = request;
    renderCaptureDebugSession(getCurrentRuntime() || {});
    if (
      cloudTargetedPostApi.isTerminalRunStatus(request.status)
    ) {
      return;
    }

    controllerState.targetedPostRunInFlight = true;
    controllerState.targetedPostRunInFlightOwnerToken = invocationToken;
    controllerState.targetedPostCancelRequested = request.cancelRequested === true;
    controllerState.batchUrlCancelRequested = controllerState.targetedPostCancelRequested;
    let executionLock = null;
    let targetTabId = null;
    // Invocation-local latch: status-report failures must not erase a hold that
    // has already been observed. This is not a durable recovery mechanism.
    let targetedSyncReconciliationRequired =
      Array.isArray(request.targetResults) &&
      request.targetResults.some(hasSyncReconciliationSignal);
    let stopTargetedPostHeartbeat = () => {};
    let targetedBusinessProgressTimer = null;
    let pendingTargetedBusinessProgress = null;
    let targetedBusinessProgressInFlight = Promise.resolve();
    const publishTargetedBusinessProgress = () => {
      if (targetedBusinessProgressTimer !== null) {
        clearTimeout(targetedBusinessProgressTimer);
        targetedBusinessProgressTimer = null;
      }
      const patch = pendingTargetedBusinessProgress;
      pendingTargetedBusinessProgress = null;
      if (!patch) return targetedBusinessProgressInFlight;
      targetedBusinessProgressInFlight = targetedBusinessProgressInFlight
        .then(async () => {
          if (!isActiveTargetedPostInvocation(invocationToken)) return;
          request = await updateTargetedPostRun(
            controllerState.targetedPostRunState || request,
            patch,
            invocationToken,
          );
        })
        .catch((error) => {
          if (isActiveTargetedPostInvocation(invocationToken)) {
            console.warn(
              "[Sidebar] Targeted business progress persistence failed:",
              error,
            );
          }
        });
      return targetedBusinessProgressInFlight;
    };
    const queueTargetedBusinessProgress = (progress = {}, message = "") => {
      const updatedAt =
        String(progress?.updatedAt || "").trim() || new Date().toISOString();
      pendingTargetedBusinessProgress = {
        progress: {...progress, updatedAt},
        message: String(message || progress?.message || "").trim(),
        businessProgressAt: updatedAt,
      };
      if (targetedBusinessProgressTimer === null) {
        targetedBusinessProgressTimer = setTimeout(() => {
          void publishTargetedBusinessProgress();
        }, 1000);
      }
    };
    const flushTargetedBusinessProgress = async () => {
      await publishTargetedBusinessProgress();
      await targetedBusinessProgressInFlight;
    };
    const shouldStop = () =>
      !isActiveTargetedPostInvocation(invocationToken) ||
      (isSameTargetedPostInvocationToken(
        controllerState.targetedPostRunInFlightOwnerToken,
        invocationToken,
      ) &&
        (controllerState.targetedPostCancelRequested || controllerState.batchUrlCancelRequested));
    const targetedWorkflow = String(
      request.workflow || "negative_post_patrol",
    ).trim();
    const isProfileDiscovery =
      isTargetedProfileDiscoveryWorkflow(
        targetedWorkflow,
        request.targetMode,
      );
    const targetedProfileCaptureTaskContext = isProfileDiscovery
      ? buildTargetedProfileCaptureTaskContext(request, invocationToken)
      : null;
    const workflowLabel = getTargetedWorkflowLabel(targetedWorkflow);
    try {
      if (targetedSyncReconciliationRequired) {
        request = await updateTargetedPostRun(request, {
          status: shouldStop() ? "canceled" : "needs_action",
          finishedAt: new Date().toISOString(),
          message: buildSyncReconciliationError().message,
          error: buildSyncReconciliationError(),
        }, invocationToken);
        return;
      }
      executionLock = await acquireCaptureExecutionLock({
        owner: "cloud_targeted_post_capture",
        label: workflowLabel,
      });
      if (!executionLock) {
        request = await updateTargetedPostRun(request, {
          status: "needs_action",
          finishedAt: new Date().toISOString(),
          message: "其他采集任务正在占用当前浏览器，请稍后接力",
          error: {
            code: "CAPTURE_LOCK_CONFLICT",
            message: "其他采集任务正在占用当前浏览器",
            retryable: true,
          },
        }, invocationToken);
        return;
      }
      request = await updateTargetedPostRun(request, {
        status: "running",
        startedAt: request.startedAt || new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        message: isProfileDiscovery
          ? `正在逐个扫描${request.subjectType === "official" ? "官方账号" : "关注博主"}`
          : "正在逐条采集指定作品",
      }, invocationToken);
      stopTargetedPostHeartbeat = startTargetedPostRunHeartbeat(
        invocationToken,
        () => controllerState.targetedPostRunState || request,
      );

      const settledItemIds = new Set(
        (Array.isArray(request.targetResults) ? request.targetResults : []).map(
          (result) => String(result?.itemId || ""),
        ),
      );
      const pendingTargets = (Array.isArray(request.targets)
        ? request.targets
        : []
      ).filter((target) => !settledItemIds.has(String(target?.itemId || "")));
      if (pendingTargets.length > 0 && !shouldStop()) {
        const targetTab = await chrome.tabs.create({
          url: pendingTargets[0].url,
          active: true,
        });
        if (!targetTab?.id) {
          const error = new Error("无法创建定向作品采集页");
          error.code = "TARGET_RUNNER_TAB_CREATE_FAILED";
          throw error;
        }
        targetTabId = Number(targetTab.id);
        if (!isActiveTargetedPostInvocation(invocationToken)) {
          throw createTargetedPostInvocationError();
        }
        controllerState.activeBatchRunnerTabId = targetTabId;
        controllerState.targetedPostRunnerTabOwnerToken = invocationToken;
        await waitForTargetedPostRunnerTab(targetTabId, shouldStop);
      }

      if (!isActiveTargetedPostInvocation(invocationToken)) {
        throw createTargetedPostInvocationError();
      }
      controllerState.batchUrlCaptureInFlight = true;
      controllerState.targetedPostBatchStateOwnerToken = invocationToken;
      controllerState.batchUrlCaptureMode = isProfileDiscovery
        ? "profile_discovery"
        : "targeted_posts";
      const storedCaptureSettings = await getCaptureSettings();
      const captureSettings = {
        ...(storedCaptureSettings &&
        typeof storedCaptureSettings === "object"
          ? storedCaptureSettings
          : {}),
        ...(request.captureSettings &&
        typeof request.captureSettings === "object"
          ? request.captureSettings
          : {}),
      };
      const monitorSettings =
        request.monitorSettings && typeof request.monitorSettings === "object"
          ? request.monitorSettings
          : {};
      let targetResults = Array.isArray(request.targetResults)
        ? request.targetResults.slice()
        : [];

      for (const target of pendingTargets) {
        if (shouldStop() || targetedSyncReconciliationRequired) break;
        const startedAt = new Date().toISOString();
        request = await updateTargetedPostRun(request, {
          status: "running",
          heartbeatAt: startedAt,
          progress: {
            current: Number(target.ordinal) || targetResults.length + 1,
            total: request.targets.length,
            itemId: target.itemId,
            recordId: target.recordId,
            title: target.title,
            url: target.url,
            targetTabId,
            phase: "target_opening",
          },
          message: isProfileDiscovery
            ? `正在打开第 ${target.ordinal}/${request.targets.length} 个账号主页`
            : `正在打开第 ${target.ordinal}/${request.targets.length} 条指定作品`,
        }, invocationToken);
        let batchResult = null;
        let targetResult = null;
        if (isProfileDiscovery) {
          const monitorResult = await executeMonitorRunItem({
            runItem: target,
            monitorItem: target,
            index: Math.max(0, Number(target.ordinal) - 1),
            total: request.targets.length,
            monitorSettings,
            captureSettings,
            runnerTabId: targetTabId,
            // The cloud task command is already leased to this Agent. Calling
            // the legacy monitor-start endpoint would correctly reject this
            // execution because it is linked to a cloud task item.
            executionPreclaimed: true,
            captureTaskContext: {
              ...targetedProfileCaptureTaskContext,
              captureTaskItemAttemptId: String(
                target.captureTaskItemAttemptId || "",
              ).trim(),
              captureTaskItemRequestHash: String(
                target.captureTaskItemRequestHash || "",
              ).trim(),
            },
            shouldStop,
            onProgress: (progress = {}) => {
              if (!isActiveTargetedPostInvocation(invocationToken)) {
                return;
              }
              const displayedToken =
                getTargetedPostInvocationTokenFromRequest(
                  controllerState.targetedPostRunState,
                );
              if (
                displayedToken &&
                !isSameTargetedPostInvocationToken(
                  displayedToken,
                  invocationToken,
                )
              ) {
                return;
              }
              const rawPhase = String(progress.phase || "profile_scan");
              const nextProgress = {
                ...(controllerState.targetedPostRunState?.progress &&
                typeof controllerState.targetedPostRunState.progress === "object"
                  ? controllerState.targetedPostRunState.progress
                  : request?.progress &&
                      typeof request.progress === "object"
                    ? request.progress
                    : {}),
                current: Number(target.ordinal) || targetResults.length + 1,
                total: request.targets.length,
                itemId: target.itemId,
                recordId: target.recordId,
                title: target.title,
                url: target.url,
                targetTabId,
                phase: rawPhase.startsWith("target_")
                  ? rawPhase
                  : `target_${rawPhase}`,
                message: String(
                  progress.message ||
                    `正在扫描第 ${target.ordinal}/${request.targets.length} 个账号`,
                ),
                updatedAt:
                  String(progress.updatedAt || "").trim() ||
                  new Date().toISOString(),
              };
              controllerState.targetedPostRunState = cloudTargetedPostApi.mergeRunPatch(
                controllerState.targetedPostRunState || request,
                {
                  progress: nextProgress,
                  message: nextProgress.message,
                },
              );
              queueTargetedBusinessProgress(
                nextProgress,
                nextProgress.message,
              );
              renderCaptureDebugSession(getCurrentRuntime() || {});
            },
          });
          const monitorStatus = String(monitorResult?.status || "");
          const canceled =
            shouldStop() ||
            String(monitorResult?.errorCode || "") === "capture_canceled";
          targetResult = {
            workflow: targetedWorkflow,
            itemId: String(target.itemId || ""),
            recordId: String(target.recordId || target.subscriptionId || ""),
            externalId: String(
              target.externalId || target.subscriptionId || "",
            ),
            subscriptionId: String(target.subscriptionId || ""),
            executionId: String(target.executionId || ""),
            ordinal: Number(target.ordinal) || targetResults.length + 1,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: canceled
              ? "canceled"
              : ["success", "no_hit"].includes(monitorStatus)
                ? "completed"
                : "failed",
            businessOutcome:
              monitorStatus === "no_hit"
                ? "profile_scan_no_new_posts"
                : monitorStatus === "success"
                  ? "profile_scan_completed"
                  : "profile_scan_failed",
            scanComplete: monitorResult?.scanComplete === true,
            partial: monitorResult?.partial === true,
            incompleteReason: String(monitorResult?.incompleteReason || ""),
            ...(monitorStatus === "no_hit"
              ? {
                  noResults: true,
                  resultKind: "profile_scan_no_new_posts",
                  qualifyingCount: 0,
                  scanComplete: true,
                }
              : {}),
            scannedCount: Math.max(
              0,
              Number(monitorResult?.scannedCount) || 0,
            ),
            hitCount: Math.max(0, Number(monitorResult?.hitCount) || 0),
            filteredCount: Math.max(
              0,
              Number(monitorResult?.filteredCount) || 0,
            ),
            unknownPublishTimeCount: Math.max(
              0,
              Number(monitorResult?.unknownPublishTimeCount) || 0,
            ),
            publishWindowLabel: String(
              monitorResult?.publishWindowLabel || "",
            ),
            ...(monitorStatus === "failed"
              ? {
                  error: cloudTargetedPostApi.projectCaptureFailure(
                    [monitorResult?.error, monitorResult],
                    {
                      fallbackCode: "PROFILE_SCAN_FAILED",
                      stage: "profile_scan",
                      fallbackMessage: "账号作品扫描失败",
                    },
                  ),
                }
              : {}),
          };
        } else {
          batchResult = await batchCaptureByUrls({
            urls: [target.url],
            mode: "single",
            runnerTabId: targetTabId,
            captureParams: {
              detectUnavailableTargetPage:
                [
                  "negative_post_patrol",
                  "watched_content_patrol",
                ].includes(targetedWorkflow),
              includeComments: captureSettings.includeComments === true,
              includeBloggerMetrics:
                captureSettings.includeBloggerMetrics === true,
              enableCommentLeadsFilter:
                captureSettings.enableCommentLeadsFilter === true,
              commentsMaxDetectedItems:
                captureSettings.commentsMaxDetectedItems || 50,
            },
            onProgress: (progress = {}) => {
              if (!isActiveTargetedPostInvocation(invocationToken)) {
                return;
              }
              const displayedToken =
                getTargetedPostInvocationTokenFromRequest(
                  controllerState.targetedPostRunState,
                );
              if (
                displayedToken &&
                !isSameTargetedPostInvocationToken(
                  displayedToken,
                  invocationToken,
                )
              ) {
                return;
              }
              const rawPhase = String(progress.phase || "capturing");
              const nextProgress = {
                ...(request?.progress && typeof request.progress === "object"
                  ? request.progress
                  : {}),
                current: Number(target.ordinal) || targetResults.length + 1,
                total: request.targets.length,
                itemId: target.itemId,
                recordId: target.recordId,
                title: target.title,
                url: target.url,
                targetTabId,
                phase: rawPhase.startsWith("target_")
                  ? rawPhase
                  : `target_${rawPhase}`,
                businessOutcome: String(progress.businessOutcome || ""),
                message: String(
                  progress.message ||
                    `正在采集第 ${target.ordinal}/${request.targets.length} 条指定作品`,
                ),
                updatedAt: new Date().toISOString(),
              };
              controllerState.targetedPostRunState = cloudTargetedPostApi.mergeRunPatch(
                controllerState.targetedPostRunState || request,
                {
                  progress: nextProgress,
                  message: nextProgress.message,
                },
              );
              queueTargetedBusinessProgress(
                nextProgress,
                nextProgress.message,
              );
              renderCaptureDebugSession(getCurrentRuntime() || {});
            },
            shouldStop,
          });
          if (!isActiveTargetedPostInvocation(invocationToken)) {
            throw createTargetedPostInvocationError();
          }
          const localRecordIds = collectTargetedPostRecordIds(batchResult);
          const localRecords = await getRecords(localRecordIds);
          targetResult = cloudTargetedPostApi.buildTargetResult({
            target,
            batchResult,
            records: localRecords,
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          if (
            ["completed", "completed_with_warnings"].includes(
              String(targetResult?.status || ""),
            ) &&
            targetResult?.businessOutcome !== "post_unavailable"
          ) {
            if (captureSettings.autoSyncAfterDetailCapture === false) {
              targetResult = cloudTargetedPostApi.applySyncResult(targetResult, {
                ok: false,
                successCount: 0,
                failedCount: targetResult.recordIds?.length || 0,
                pausedCount: 0,
                error: {
                  code: "TARGET_SYNC_DISABLED",
                  message: "定向作品已在本地采集，但任务未启用后台同步",
                },
              });
            } else {
              let syncResult = null;
              let syncError = null;
              try {
                syncResult = await syncRecordBatch(
                  Array.isArray(targetResult.recordIds)
                    ? targetResult.recordIds
                    : [],
                  null,
                  {
                    trigger: targetedWorkflow,
                    syncScope: "all",
                    captureTaskId: String(request.taskId || request.id || ""),
                    captureTaskItemAttemptId: String(
                      target.captureTaskItemAttemptId || "",
                    ).trim(),
                    captureTaskItemRequestHash: String(
                      target.captureTaskItemRequestHash || "",
                    ).trim(),
                    captureSettings: {
                      ...captureSettings,
                      autoSyncAfterDetailCapture: true,
                    },
                    commentLeadsConfig:
                      buildCommentLeadsConfigFromSettings(captureSettings),
                    shouldStop,
                  },
                );
              } catch (error) {
                syncError = error;
              }
              targetResult = cloudTargetedPostApi.applySyncResult(
                targetResult,
                syncResult,
                syncError,
              );
            }
          }
        }
        targetedSyncReconciliationRequired =
          targetedSyncReconciliationRequired ||
          hasSyncReconciliationSignal(targetResult);
        await flushTargetedBusinessProgress();
        if (!isActiveTargetedPostInvocation(invocationToken)) {
          throw createTargetedPostInvocationError();
        }
        targetResults.push(targetResult);
        const canceled =
          shouldStop() ||
          batchResult?.canceled ||
          targetResult.status === "canceled";
        request = await updateTargetedPostRun(request, {
          status: canceled ? "cancel_requested" : "running",
          cancelRequested: canceled,
          heartbeatAt: new Date().toISOString(),
          targetResults,
          progress: {
            current: targetResults.length,
            total: request.targets.length,
            itemId: target.itemId,
            recordId: target.recordId,
            title: target.title,
            url: target.url,
            targetTabId,
            businessOutcome: String(targetResult?.businessOutcome || ""),
            availabilityStatus: String(
              targetResult?.availabilityStatus || "",
            ),
            phase: canceled
              ? "target_canceling"
              : targetResult?.businessOutcome === "post_unavailable"
                ? "target_unavailable"
                : "target_settled",
          },
          message: canceled
            ? `${workflowLabel}正在停止并保留已有结果`
            : targetResult?.businessOutcome === "post_unavailable"
              ? `第 ${target.ordinal}/${request.targets.length} 条帖子已确认删除或不可用`
              : isProfileDiscovery
                ? `第 ${target.ordinal}/${request.targets.length} 个账号扫描已收口`
                : `第 ${target.ordinal}/${request.targets.length} 条指定作品已收口`,
        }, invocationToken);
        targetResults = Array.isArray(request.targetResults)
          ? request.targetResults.slice()
          : targetResults;
        if (canceled || hasSyncReconciliationSignal(targetResult)) break;
      }

      if (!isActiveTargetedPostInvocation(invocationToken)) {
        throw createTargetedPostInvocationError();
      }
      const checkpoint = cloudTargetedPostApi.buildCheckpoint(
        request.targets,
        targetResults,
      );
      const canceled = shouldStop() || request.cancelRequested === true;
      const reconciliationRequired = targetedSyncReconciliationRequired;
      const finalStatus = canceled
        ? "canceled"
        : reconciliationRequired
          ? "needs_action"
          : checkpoint.failedCount === 0 && checkpoint.warningCount === 0
            ? "completed"
            : checkpoint.successCount > 0 || checkpoint.warningCount > 0
              ? "completed_with_warnings"
              : "failed";
      stopTargetedPostHeartbeat();
      await flushTargetedBusinessProgress();
      request = await updateTargetedPostRun(request, {
        status: finalStatus,
        finishedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        targetResults,
        ...(reconciliationRequired
          ? {error: buildSyncReconciliationError()}
          : {}),
        progress: {
          current: checkpoint.processedCount,
          total: checkpoint.total,
          phase: finalStatus,
          targetedPost: true,
          workflow: targetedWorkflow,
          completedTargetCount: checkpoint.capturedCount,
          unavailableTargetCount: checkpoint.unavailableCount,
          failedTargetCount: checkpoint.failedCount,
        },
        message:
          finalStatus === "needs_action"
            ? buildSyncReconciliationError().message
            : isProfileDiscovery && finalStatus === "completed"
            ? `${workflowLabel}完成：已扫描 ${checkpoint.capturedCount} 个账号`
            : isProfileDiscovery && finalStatus === "completed_with_warnings"
              ? `${workflowLabel}部分完成：成功 ${checkpoint.capturedCount} 个，失败 ${checkpoint.failedCount} 个`
              : finalStatus === "completed"
                ? `${workflowLabel}完成：采集 ${checkpoint.capturedCount} 条，已删除或不可用 ${checkpoint.unavailableCount} 条`
                : finalStatus === "completed_with_warnings"
                  ? `${workflowLabel}部分完成：采集 ${checkpoint.capturedCount} 条，已删除或不可用 ${checkpoint.unavailableCount} 条，警告 ${checkpoint.warningCount} 条，失败 ${checkpoint.failedCount} 条`
              : finalStatus === "canceled"
                ? `${workflowLabel}已停止，已保留 ${checkpoint.processedCount} 条结果`
                : `${workflowLabel}失败，共 ${checkpoint.failedCount} 条`,
      }, invocationToken);
      await refreshDataPool();
    } catch (error) {
      stopTargetedPostHeartbeat();
      await flushTargetedBusinessProgress();
      console.error("[Sidebar] Targeted post workflow failed:", error);
      const staleInvocation =
        String(error?.code || "") === "stale_targeted_post_attempt" ||
        !isActiveTargetedPostInvocation(invocationToken);
      if (
        !staleInvocation &&
        request &&
        !cloudTargetedPostApi.isTerminalRunStatus(request.status)
      ) {
        try {
          await updateTargetedPostRun(request, {
            status:
              shouldStop() || error?.code === "TARGET_CAPTURE_CANCELED"
                ? "canceled"
                : targetedSyncReconciliationRequired || hasSyncReconciliationSignal(error)
                  ? "needs_action"
                  : "failed",
            finishedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            message:
              shouldStop() || error?.code === "TARGET_CAPTURE_CANCELED"
                ? `${workflowLabel}已停止并保留已有结果`
                : String(error?.message || `${workflowLabel}失败`),
            error: targetedSyncReconciliationRequired || hasSyncReconciliationSignal(error)
              ? buildSyncReconciliationError()
              : {
              code: String(error?.code || "TARGET_CAPTURE_FAILED"),
              message: String(error?.message || "定向作品采集失败").slice(
                0,
                1000,
              ),
              retryable:
                ![
                  "TARGET_IDENTITY_MISMATCH",
                  "TARGET_URL_NOT_ALLOWED",
                ].includes(String(error?.code || "")),
            },
          }, invocationToken);
        } catch (reportError) {
          console.error(
            "[Sidebar] Targeted post terminal report failed:",
            reportError,
          );
        }
      }
    } finally {
      stopTargetedPostHeartbeat();
      if (targetedBusinessProgressTimer !== null) {
        clearTimeout(targetedBusinessProgressTimer);
        targetedBusinessProgressTimer = null;
      }
      const cleanupOwnership =
        getTargetedPostInvocationOwnership(invocationToken);
      if (
        cleanupOwnership.active &&
        cleanupOwnership.runnerTab &&
        (await confirmTargetedPostInvocationBinding(invocationToken).catch(
          () => false,
        ))
      ) {
        await settleTargetedPostRunnerTab(targetTabId, request?.platform, {
          returnHome: String(request?.status || "") !== "needs_action",
        });
      }
      const latestOwnership =
        getTargetedPostInvocationOwnership(invocationToken);
      if (latestOwnership.batch) {
        controllerState.batchUrlCaptureInFlight = false;
        controllerState.batchUrlCaptureMode = "";
        controllerState.batchUrlCancelRequested = false;
        controllerState.targetedPostBatchStateOwnerToken = null;
      }
      if (latestOwnership.runnerTab) {
        controllerState.activeBatchRunnerTabId = null;
        controllerState.targetedPostRunnerTabOwnerToken = null;
      }
      if (latestOwnership.run) {
        controllerState.targetedPostCancelRequested = false;
        controllerState.targetedPostRunInFlight = false;
        controllerState.targetedPostRunInFlightOwnerToken = null;
      }
      if (latestOwnership.active) {
        controllerState.activeTargetedPostInvocationToken = null;
      }
      if (executionLock) {
        await releaseCaptureExecutionLock(executionLock.id);
      }
    }
  }

  return Object.freeze({
    getUnattendedRunRequestIdFromUrl,
    getUnattendedRunAttemptIdFromUrl,
    getTargetedPostRunRequestIdFromUrl,
    getTargetedPostRunAttemptIdFromUrl,
    createTargetedPostInvocationToken,
    getTargetedPostInvocationTokenFromRequest,
    isSameTargetedPostInvocationToken,
    isActiveTargetedPostInvocation,
    activateTargetedPostInvocation,
    getTargetedPostInvocationOwnership,
    createTargetedPostInvocationError,
    handleTargetedPostRunRequestStorageChange,
    resolveTargetedPostRunBinding,
    stopTargetedPostRunnerForInvalidBinding,
    loadTargetedPostRunStateForDisplay,
    updateTargetedPostRun,
    startTargetedPostRunHeartbeat,
    cancelTargetedPostRunFromSidebar,
    confirmTargetedPostInvocationBinding,
    settleTargetedPostRunnerTab,
    waitForTargetedPostRunnerTab,
    collectTargetedPostRecordIds,
    buildTargetedProfileCaptureTaskContext,
    maybeClaimAndRunTargetedPostWorkflow,
  });
}
