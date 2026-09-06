// L3-B keyword-plan: explicit application responsibility.
export function createKeywordPlanController({controllerState, controllerPorts, controllerOperations}) {
  const {
    KEYWORD_PLAN_MODES,
    KEYWORD_PLAN_RECONCILE_INTERVAL_MS,
    KEYWORD_PLAN_STORAGE_KEY,
    KEYWORD_PLAN_TERMINAL_STATUSES,
    KEYWORD_RUN_REQUEST_STORAGE_KEY,
    PLATFORM_SEARCH_FILTER_OPTIONS,
    SEARCH_FILTER_FIELD_META,
    TARGETED_POST_RUN_REQUEST_STORAGE_KEY,
    UNATTENDED_FINAL_FLUSH_INTENT_STORAGE_PREFIX,
    chrome,
    clearInterval,
    console,
    getCurrentRuntime,
    getViewPlatform,
    renderCaptureDebugSession,
    setInterval,
    showMessage,
    updateBatchKeywordInputState,
  } = controllerPorts;
  const getTargetedPostRunRequestIdFromUrl = (...args) => controllerOperations.getTargetedPostRunRequestIdFromUrl(...args);
  const getUnattendedRunRequestIdFromUrl = (...args) => controllerOperations.getUnattendedRunRequestIdFromUrl(...args);
  const handleTargetedPostRunRequestStorageChange = (...args) => controllerOperations.handleTargetedPostRunRequestStorageChange(...args);
  const handleUnattendedRunRequestStorageChange = (...args) => controllerOperations.handleUnattendedRunRequestStorageChange(...args);
  const maybeClaimAndRunUnattendedKeywordPlan = (...args) => controllerOperations.maybeClaimAndRunUnattendedKeywordPlan(...args);
  const reconcilePendingUnattendedFinalFlushIntents = (...args) => controllerOperations.reconcilePendingUnattendedFinalFlushIntents(...args);
  const refreshDataPoolThrottled = (...args) => controllerOperations.refreshDataPoolThrottled(...args);
  const collectKeywordPlanFromInputs = (...args) => controllerPorts.taskView.collectKeywordPlanFromInputs(...args);
  const syncKeywordPlanDateFields = (...args) => controllerPorts.taskView.syncKeywordPlanDateFields(...args);

  function normalizeKeywordPlanMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "holidays") {
      return "custom_dates";
    }
    return KEYWORD_PLAN_MODES.has(normalized) ? normalized : "daily";
  }
  function normalizeSearchFilterPlatform(platform = "") {
    const normalized = String(platform || "").trim().toLowerCase();
    return normalized === "douyin" ? "douyin" : "xiaohongshu";
  }
  function getSearchFilterConfig(platform = "") {
    return PLATFORM_SEARCH_FILTER_OPTIONS[normalizeSearchFilterPlatform(platform)] ||
      PLATFORM_SEARCH_FILTER_OPTIONS.xiaohongshu;
  }
  function isDefaultSearchFilterValue(field, value) {
    const meta = SEARCH_FILTER_FIELD_META[field] || {};
    const normalized = String(value || "").trim();
    return (
      !normalized ||
      normalized === String(meta.defaultValue || "") ||
      normalized === String(meta.storageDefault || "")
    );
  }
  function normalizeSearchFilterValueForStorage(field, value) {
    return isDefaultSearchFilterValue(field, value)
      ? ""
      : String(value || "").trim().toLowerCase();
  }
  function normalizeCalendarDate(value) {
    const match = String(value || "").trim().match(
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
    );
    if (!match) return "";
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1) return "";
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [
      31,
      leapYear ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ][month - 1];
    if (day > daysInMonth) return "";
    return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  function normalizeDateListText(value) {
    return Array.from(
      new Set(
        String(value || "")
          .split(/[\s,，;；]+/g)
          .map(normalizeCalendarDate)
          .filter(Boolean),
      ),
    ).join("\n");
  }
  function getDateListFromText(value) {
    const normalized = normalizeDateListText(value);
    return normalized ? normalized.split("\n").filter(Boolean) : [];
  }
  function parseSearchManualScheduledStart(value = "") {
    const raw = String(value || "").trim();
    if (!raw) {
      return null;
    }

    const timeOnlyMatch = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (timeOnlyMatch) {
      const hours = Number(timeOnlyMatch[1]);
      const minutes = Number(timeOnlyMatch[2]);
      const seconds = Number(timeOnlyMatch[3] || 0);
      if (
        hours >= 0 &&
        hours <= 23 &&
        minutes >= 0 &&
        minutes <= 59 &&
        seconds >= 0 &&
        seconds <= 59
      ) {
        const target = new Date();
        target.setHours(hours, minutes, seconds, 0);
        return {
          targetMs: target.getTime(),
          label: `今天 ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
        };
      }
    }

    const targetMs = new Date(raw).getTime();
    if (!Number.isFinite(targetMs)) {
      return {targetMs: NaN, label: raw};
    }
    return {
      targetMs,
      label: new Date(targetMs).toLocaleString("zh-CN"),
    };
  }
  function isExplicitUserUnattendedCancellationMessage(message = "") {
    return /用户手动|手动中止/.test(String(message || "").trim());
  }
  function isKeywordPlanRunning(plan = {}) {
    const status = String(plan?.lastRunStatus || "").trim();
    return ["pending", "claimed", "started", "running", "recovering"].includes(
      status,
    );
  }
  function normalizeUnattendedSearchPasses(plan = {}) {
    const allowed = new Set(["all", "image", "video"]);
    const fallback = allowed.has(String(plan?.searchFilters?.contentType || ""))
      ? String(plan.searchFilters.contentType)
      : "all";
    const requested = [];
    const seen = new Set();
    for (const rawValue of Array.isArray(plan?.searchPasses)
      ? plan.searchPasses
      : []) {
      const value = String(rawValue || "").trim().toLowerCase();
      if (!allowed.has(value) || seen.has(value)) continue;
      seen.add(value);
      requested.push(value);
      if (requested.length >= 3) break;
    }
    if (requested.length === 0) return [fallback];
    if (requested.length === 1) return requested;
    if (requested.includes("all")) {
      const supplement = requested.find(
        (value) => value === "image" || value === "video",
      );
      return supplement ? ["all", supplement] : ["all"];
    }
    return [requested[0]];
  }
  function buildKeywordRunDisplayPlan(
    plan = controllerState.keywordPlanState,
    request = controllerState.activeKeywordRunState,
  ) {
    if (!request || typeof request !== "object") {
      return plan;
    }
    const requestId = String(request.id || "").trim();
    const status = String(request.status || "").trim().toLowerCase();
    const shouldDisplayRequest = Boolean(
      requestId &&
        (isKeywordPlanRunning({lastRunStatus: status}) ||
          KEYWORD_PLAN_TERMINAL_STATUSES.has(status)),
    );
    if (!shouldDisplayRequest) {
      return plan;
    }
    const snapshot =
      request.planSnapshot && typeof request.planSnapshot === "object"
        ? request.planSnapshot
        : {};
    const progress =
      request.progress && typeof request.progress === "object"
        ? request.progress
        : {};
    const executionMode =
      String(request.executionMode || "").trim() === "one_time"
        ? "one_time"
        : "unattended_plan";
    return {
      ...snapshot,
      enabled: true,
      lastRunStatus: status,
      lastRunMessage:
        String(request.message || progress.message || "").trim() ||
        (status === "pending" || status === "claimed"
          ? "任务已领取，正在准备采集页面"
          : "当前采集任务运行中"),
      lastRunAt: String(
        request.finishedAt ||
          request.updatedAt ||
          request.startedAt ||
          request.claimedAt ||
          request.createdAt ||
          "",
      ),
      lastRunRequestId: requestId,
      lastRunProgress: {
        ...progress,
        unattendedRequestId: requestId,
        unattendedAttemptId: String(request.attemptId || "").trim(),
        runnerTabId: progress.runnerTabId ?? request.runnerTabId ?? null,
        updatedAt: String(
          progress.updatedAt || request.updatedAt || request.createdAt || "",
        ),
      },
      executionMode,
      cloudAssigned: request.cloudAssigned === true,
    };
  }
  function hasVisibleLocalCaptureProgress() {
    return (
      controllerState.batchKeywordCaptureInFlight ||
      controllerState.batchUrlCaptureInFlight ||
      controllerState.detailBatchCaptureInFlight ||
      controllerState.monitorRunInFlight ||
      controllerState.keywordBenchmarkInFlight ||
      controllerState.keywordOpportunityInFlight ||
      controllerState.keywordExpandInFlight ||
      [
        "network_paused",
        "network_resumed",
        "system_resumed",
        "capture_recovering",
        "capture_canceling",
      ].includes(String(controllerState.activeRecoveryProgress?.phase || ""))
    );
  }
  function populateKeywordPlanUI(plan = {}) {
    controllerState.keywordPlanState = plan || null;
    controllerPorts.taskView.populateKeywordPlanSchedule(plan);

    const keywords = Array.isArray(plan?.keywords) ? plan.keywords : [];
    const planPlatform =
      plan?.platform ||
      getViewPlatform(getCurrentRuntime()) ||
      "xiaohongshu";
    controllerPorts.taskView.populateKeywordPlanKeywords(keywords, () => plan?.searchFilters || {}, planPlatform);
    updateBatchKeywordInputState();

    syncKeywordPlanDateFields();
    renderKeywordPlanStatus(plan);
  }
  function syncKeywordPlanProgressPanel(plan = controllerState.keywordPlanState) {
    const isUnattendedRunnerTab = Boolean(getUnattendedRunRequestIdFromUrl());
    if (!plan?.enabled || !isKeywordPlanRunning(plan)) {
      controllerPorts.taskView.hideKeywordPlanProgressPanelIfOwned(plan);
      return;
    }
    if (
      (!isUnattendedRunnerTab && hasVisibleLocalCaptureProgress()) ||
      controllerPorts.taskView.isUnsupportedPlatformCoverVisible()
    ) {
      return;
    }
    const presentation = controllerPorts.taskView.openKeywordPlanProgress();
    if (!presentation) return;
    controllerOperations.resetCaptureRecoveryUI({hidePanel: false, clearState: true});
    presentation.render(plan);
  }
  function renderKeywordPlanStatus(plan = controllerState.keywordPlanState, scope = null) {
    controllerPorts.taskView.renderKeywordPlanStatusLabels(plan, scope);
    syncKeywordPlanProgressPanel(buildKeywordRunDisplayPlan(plan));
    // Preserve the original startup/debug projection after progress ownership.
    renderCaptureDebugSession(getCurrentRuntime() || {});
  }
  async function loadKeywordPlanUI({preserveInputs = false} = {}) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:get-unattended-keyword-plan",
      });
      if (!response?.ok) {
        throw new Error(response?.error?.message || "读取计划失败");
      }
      const plan = response.data || {};
      if (preserveInputs) {
        controllerState.keywordPlanState = plan;
        renderKeywordPlanStatus(plan);
      } else {
        populateKeywordPlanUI(plan);
      }
      return plan;
    } catch (error) {
      console.warn("[Sidebar] Load unattended keyword plan failed:", error);
      renderKeywordPlanStatus(null);
      return null;
    }
  }
  function renderActiveKeywordRunState(request) {
    controllerState.activeKeywordRunState =
      request && typeof request === "object" ? request : null;
    const displayPlan = buildKeywordRunDisplayPlan(controllerState.keywordPlanState);
    syncKeywordPlanProgressPanel(displayPlan);
    renderCaptureDebugSession(getCurrentRuntime() || {});
  }
  async function loadActiveKeywordRunState() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:get-unattended-keyword-run-state",
      });
      if (!response?.ok) {
        throw new Error(response?.error?.message || "读取当前采集任务失败");
      }
      renderActiveKeywordRunState(response.data || null);
      return controllerState.activeKeywordRunState;
    } catch (error) {
      console.warn("[Sidebar] Load active keyword run failed:", error);
      return controllerState.activeKeywordRunState;
    }
  }
  function shouldRefreshDataPoolForKeywordPlan(plan = {}) {
    const status = String(plan?.lastRunStatus || "").trim();
    return (
      status === "started" ||
      status === "running" ||
      status === "recovering" ||
      status === "completed" ||
      status === "completed_with_failures" ||
      status === "needs_action" ||
      status === "failed" ||
      status === "canceled"
    );
  }
  async function reconcileKeywordPlanFromSidebar() {
    if (
      controllerState.keywordPlanReconcileInFlight ||
      getUnattendedRunRequestIdFromUrl() ||
      getTargetedPostRunRequestIdFromUrl()
    ) {
      return;
    }
    controllerState.keywordPlanReconcileInFlight = true;
    try {
      const [plan] = await Promise.all([
        loadKeywordPlanUI({preserveInputs: true}),
        loadActiveKeywordRunState(),
      ]);
      if (shouldRefreshDataPoolForKeywordPlan(plan)) {
        await refreshDataPoolThrottled();
      }
      await maybeClaimAndRunUnattendedKeywordPlan({allowPending: true});
    } finally {
      controllerState.keywordPlanReconcileInFlight = false;
    }
  }
  function startKeywordPlanReconcileTimer() {
    stopKeywordPlanReconcileTimer();
    if (
      getUnattendedRunRequestIdFromUrl() ||
      getTargetedPostRunRequestIdFromUrl()
    ) {
      return;
    }
    controllerState.keywordPlanReconcileTimer = setInterval(() => {
      reconcileKeywordPlanFromSidebar().catch((error) => {
        console.warn("[Sidebar] Reconcile unattended keyword plan failed:", error);
      });
    }, KEYWORD_PLAN_RECONCILE_INTERVAL_MS);
  }
  function stopKeywordPlanReconcileTimer() {
    if (controllerState.keywordPlanReconcileTimer) {
      clearInterval(controllerState.keywordPlanReconcileTimer);
      controllerState.keywordPlanReconcileTimer = null;
    }
  }
  function setupKeywordPlanStorageListener() {
    if (!chrome?.storage?.onChanged) {
      return;
    }
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }
      if (changes?.[KEYWORD_PLAN_STORAGE_KEY]) {
        const plan = changes[KEYWORD_PLAN_STORAGE_KEY].newValue || null;
        controllerState.keywordPlanState = plan;
        renderKeywordPlanStatus(plan);
        if (shouldRefreshDataPoolForKeywordPlan(plan)) {
          refreshDataPoolThrottled().catch((error) => {
            console.warn(
              "[Sidebar] Failed to refresh pool during keyword plan update:",
              error,
            );
          });
        }
      }
      if (changes?.[KEYWORD_RUN_REQUEST_STORAGE_KEY]) {
        const request =
          changes[KEYWORD_RUN_REQUEST_STORAGE_KEY].newValue || null;
        renderActiveKeywordRunState(request);
        handleUnattendedRunRequestStorageChange(request);
      }
      if (changes?.[TARGETED_POST_RUN_REQUEST_STORAGE_KEY]) {
        const request =
          changes[TARGETED_POST_RUN_REQUEST_STORAGE_KEY].newValue || null;
        handleTargetedPostRunRequestStorageChange(request);
      }
      if (
        Object.keys(changes || {}).some((key) =>
          key.startsWith(UNATTENDED_FINAL_FLUSH_INTENT_STORAGE_PREFIX),
        )
      ) {
        void reconcilePendingUnattendedFinalFlushIntents().catch((error) => {
          console.warn(
            "[Sidebar] Reconcile unattended final flush intents failed:",
            error,
          );
        });
      }
    });
  }
  async function handleSaveKeywordPlan(scope = "modal") {
    try {
      const plan = collectKeywordPlanFromInputs(scope);
      if (plan.enabled && plan.keywords.length === 0) {
        showMessage("启用无人值守计划前，请先填写至少一个关键词", "warning");
        return;
      }
      if (plan.enabled && plan.mode === "custom_dates" && !plan.customDates) {
        showMessage("指定日期清单需要填写至少一个运行日期", "warning");
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:save-unattended-keyword-plan",
        plan,
      });
      if (!response?.ok) {
        throw new Error(response?.error?.message || "保存计划失败");
      }
      populateKeywordPlanUI(response.data || plan);
      showMessage(plan.enabled ? "无人值守计划已保存" : "无人值守计划已关闭", "success");
    } catch (error) {
      console.error("[Sidebar] Save unattended keyword plan failed:", error);
      showMessage("保存无人值守计划失败: " + error.message, "error");
    }
  }

  return Object.freeze({
    renderKeywordPlanStatus,
    syncKeywordPlanProgressPanel,
    normalizeKeywordPlanMode,
    normalizeSearchFilterPlatform,
    getSearchFilterConfig,
    isDefaultSearchFilterValue,
    normalizeSearchFilterValueForStorage,
    normalizeCalendarDate,
    normalizeDateListText,
    getDateListFromText,
    parseSearchManualScheduledStart,
    isExplicitUserUnattendedCancellationMessage,
    isKeywordPlanRunning,
    normalizeUnattendedSearchPasses,
    buildKeywordRunDisplayPlan,
    hasVisibleLocalCaptureProgress,
    populateKeywordPlanUI,
    loadKeywordPlanUI,
    renderActiveKeywordRunState,
    loadActiveKeywordRunState,
    shouldRefreshDataPoolForKeywordPlan,
    reconcileKeywordPlanFromSidebar,
    startKeywordPlanReconcileTimer,
    stopKeywordPlanReconcileTimer,
    setupKeywordPlanStorageListener,
    handleSaveKeywordPlan,
  });
}
