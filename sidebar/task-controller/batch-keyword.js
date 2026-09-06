// L3-A batch-keyword: original control flow, explicit state and compatibility ports.
export function createBatchKeywordController({controllerState, controllerPorts, controllerOperations}) {
  const {
    MAX_BATCH_KEYWORDS,
    PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
    PAGE_TYPE,
    UNATTENDED_ELASTIC_RELEASE_MIN_DELAY_MS,
    UNATTENDED_KEYWORD_RETRY_DELAYS_MS,
    advanceUnattendedCheckpointRound,
    batchCaptureByKeywords,
    beginTaskContext,
    buildStreamingSyncTaskIssue,
    buildStreamingSyncTaskMetadata,
    buildSyncReconciliationError,
    chrome,
    collectSearchFiltersFromControls,
    completeTaskContext,
    console,
    taskView,
    endCaptureTaskSession,
    ensureAuthVerifiedOrWarn,
    formatStreamingSyncSummary,
    getBatchKeywordsFromTextarea,
    getCaptureSettings,
    getCurrentRuntime,
    getPagePlatform,
    getPlatformCapabilities,
    getPlatformCopy,
    getViewPlatform,
    hasSyncReconciliationSignal,
    isStreamingSyncReconciliationRequired,
    isUnattendedSafetyBlock,
    normalizeUnattendedSearchPasses,
    persistCurrentBatchDraft,
    readKeywordMaxDetectedItemsFromInput,
    readKeywordMinLikesFromInput,
    refreshDataPool,
    resolveCompletedCheckpointKeywords,
    resolveCurrentDetailCaptureSettings,
    resolveTaskCaptureSettingsOverrides,
    resolveTaskKeywordMaxDetectedItems,
    runUnattendedKeywordAttempts,
    setBatchProgressDetail,
    setBatchProgressVisible,
    showMessage,
    syncKeywordSortDimensionFromPage,
    unattendedSearchPassLabel,
    updateBatchKeywordInputState,
    updateBatchProgress,
    updateCaptureTaskSession,
  } = controllerPorts;
  const acquireCaptureExecutionLock = (...args) => controllerOperations.acquireCaptureExecutionLock(...args);
  const appendStreamingSyncSummary = (...args) => controllerOperations.appendStreamingSyncSummary(...args);
  const beginSidebarTask = (...args) => controllerOperations.beginSidebarTask(...args);
  const clearCaptureTaskProgressContext = (...args) => controllerOperations.clearCaptureTaskProgressContext(...args);
  const createStreamingDetailAutoSyncQueue = (...args) => controllerOperations.createStreamingDetailAutoSyncQueue(...args);
  const dedupeKeywords = (...args) => controllerOperations.dedupeKeywords(...args);
  const drainStreamingDetailSyncQueue = (...args) => controllerOperations.drainStreamingDetailSyncQueue(...args);
  const finishSidebarTask = (...args) => controllerOperations.finishSidebarTask(...args);
  const maybeRunAutoDetailCaptureAfterListCapture = (...args) => controllerOperations.maybeRunAutoDetailCaptureAfterListCapture(...args);
  const maybeRunAutoSyncAfterDetailCapture = (...args) => controllerOperations.maybeRunAutoSyncAfterDetailCapture(...args);
  const projectCaptureTaskProgress = (...args) => controllerOperations.projectCaptureTaskProgress(...args);
  const readFiniteProgressNumber = (...args) => controllerOperations.readFiniteProgressNumber(...args);
  const releaseCaptureExecutionLock = (...args) => controllerOperations.releaseCaptureExecutionLock(...args);
  const releaseCaptureTaskOwner = (...args) => controllerOperations.releaseCaptureTaskOwner(...args);
  const rememberCaptureTaskProgressContext = (...args) => controllerOperations.rememberCaptureTaskProgressContext(...args);
  const requestCaptureCancelSignal = (...args) => controllerOperations.requestCaptureCancelSignal(...args);
  const requestDetailRunnerCancelSignals = (...args) => controllerOperations.requestDetailRunnerCancelSignals(...args);
  const resolveCaptureTaskSourceTabId = (...args) => controllerOperations.resolveCaptureTaskSourceTabId(...args);
  const resolveCaptureTaskTerminalStatus = (...args) => controllerOperations.resolveCaptureTaskTerminalStatus(...args);
  const resolveUnattendedEnhanceCancellation = (...args) => controllerOperations.resolveUnattendedEnhanceCancellation(...args);
  const routeDetailItemToStreamingSync = (...args) => controllerOperations.routeDetailItemToStreamingSync(...args);
  const settleKeywordRecordsForStreamingSync = (...args) => controllerOperations.settleKeywordRecordsForStreamingSync(...args);
  const sleepWithStop = (...args) => controllerOperations.sleepWithStop(...args);
  const startOptionalCaptureAssistSession = (...args) => controllerOperations.startOptionalCaptureAssistSession(...args);
  const supportsPersistentCaptureTaskPlatform = (...args) => controllerOperations.supportsPersistentCaptureTaskPlatform(...args);

  async function handleBatchKeywordCapture(options = {}) {
    const runOptions =
      options && typeof options === "object" && typeof options.preventDefault !== "function"
        ? options
        : {};
    const externalNotifyProgress =
      typeof runOptions.onProgress === "function" ? runOptions.onProgress : null;
    const externalCaptureTaskContext =
      runOptions.captureTaskContext &&
      typeof runOptions.captureTaskContext === "object"
        ? runOptions.captureTaskContext
        : null;
    const captureTaskLifecycleOwnedByCaller =
      runOptions.captureTaskLifecycleOwnedByCaller === true;
    const waitForegroundTabId = Number.isFinite(
      Number(runOptions.waitForegroundTabId),
    )
      ? Number(runOptions.waitForegroundTabId)
      : null;
    const preferredSourceTabId = Number.isFinite(
      Number(runOptions.sourceTabId),
    )
      ? Number(runOptions.sourceTabId)
      : null;
    const executionLockOwner =
      String(runOptions.executionLockOwner || "").trim() ||
      "manual_batch_keyword_capture";
    const executionLockLabel =
      String(runOptions.executionLockLabel || "").trim() ||
      "手动批量关键词采集";
    const captureExecutionLabel =
      String(runOptions.captureExecutionLabel || "").trim() ||
      (executionLockOwner === "unattended_keyword_plan"
        ? "无人值守采集"
        : "批量搜索采集");
    const executionMode =
      String(runOptions.executionMode || "").trim() === "one_time"
        ? "one_time"
        : executionLockOwner === "unattended_keyword_plan"
          ? "unattended_plan"
          : "manual";
    const releaseElasticItemOnLongRetry =
      runOptions.releaseElasticItemOnLongRetry === true;
    const disableAutomaticSearchRetry =
      runOptions.disableAutomaticSearchRetry === true;
    const requireVerifiedFilters =
      runOptions.requireVerifiedFilters === true;
    let bootstrapInitialSearchEvidence =
      runOptions.initialSearchEvidence &&
      typeof runOptions.initialSearchEvidence === "object" &&
      !Array.isArray(runOptions.initialSearchEvidence)
        ? runOptions.initialSearchEvidence
        : null;
    const sequentialSearchPasses = normalizeUnattendedSearchPasses({
      searchPasses: runOptions.searchPasses,
      searchFilters: runOptions.searchFilters,
    });
    const sequentialSearchEnabled = sequentialSearchPasses.length > 1;
    // Unattended identity belongs to this invocation, not to the mutable global
    // claim slot.  A delayed callback from a previous runner must never be
    // relabeled with the request/attempt that happens to be active later.
    const scopedUnattendedRequestId = String(
      runOptions.unattendedRequestId || "",
    ).trim();
    const scopedUnattendedAttemptId = String(
      runOptions.unattendedAttemptId || "",
    ).trim();
    const captureTaskItemAttempts = (Array.isArray(
      runOptions.captureTaskItemAttempts,
    )
      ? runOptions.captureTaskItemAttempts
      : [])
      .map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? entry
          : {},
      )
      .filter(
        (entry) =>
          String(entry.attemptId || "").trim() &&
          String(entry.keyword || "").trim(),
      );
    const resolveCaptureTaskItemAttempt = (value = {}) => {
      const keyword = String(value?.keyword || "").trim();
      if (!keyword) return null;
      const matches = captureTaskItemAttempts.filter(
        (entry) => String(entry.keyword || "").trim() === keyword,
      );
      return matches.length === 1 ? matches[0] : null;
    };
    const isCurrentUnattendedInvocation = () =>
      !scopedUnattendedRequestId ||
      (scopedUnattendedRequestId ===
        String(controllerState.activeUnattendedRunRequestId || "").trim() &&
        (!scopedUnattendedAttemptId ||
          scopedUnattendedAttemptId ===
            String(controllerState.activeUnattendedRunAttemptId || "").trim()));
    const shouldStopBatchInvocation = () =>
      controllerState.batchKeywordCancelRequested || !isCurrentUnattendedInvocation();
    if (
      executionLockOwner === "unattended_keyword_plan" &&
      controllerState.activeUnattendedAttemptRejected
    ) {
      return {started: false, canceled: true, reason: "当前执行已被新的恢复任务接管"};
    }

    if (controllerState.batchKeywordCaptureInFlight) {
      if (controllerState.batchKeywordCancelRequested) {
        showMessage("正在取消批量采集...", "warning");
        return {started: false, canceled: true, reason: "正在取消批量采集"};
      }
      controllerState.batchKeywordCancelRequested = true;
      // 取消时若正在「采集增强」逐条補采(用 detailBatch 标志 + 独立 runner tab),也要一并停,
      // 否则在增强阶段点终止会继续補采、停不下来。
      if (controllerState.detailBatchCaptureInFlight) {
        controllerState.detailBatchCancelRequested = true;
      }
      taskView.showBatchKeywordStopping();
      try {
        if (controllerState.detailBatchCaptureInFlight) {
          await requestDetailRunnerCancelSignals({
            extraTabIds: getCurrentRuntime()?.captureDebugSession?.workerTabIds,
            fallbackTabId: controllerState.activeBatchRunnerTabId,
          });
        } else {
          await requestCaptureCancelSignal(controllerState.activeBatchRunnerTabId);
        }
      } catch (error) {
        console.warn("[Sidebar] Batch keyword cancel failed:", error);
      }
      showMessage("正在取消批量采集...", "warning");
      return {started: false, canceled: true, reason: "正在取消批量采集"};
    }

    if (controllerState.batchUrlCaptureInFlight) {
      showMessage("已有批量任务执行中，请先停止当前任务", "warning");
      return {started: false, reason: "已有批量任务执行中"};
    }

    const runtime = getCurrentRuntime();
    const selectedPlatform = getViewPlatform(runtime);
    const bootstrapEvidenceTabId = Number(bootstrapInitialSearchEvidence?.tabId);
    const bootstrapEvidencePlatform = String(
      bootstrapInitialSearchEvidence?.platform || "",
    ).trim();
    const bootstrapEvidenceAccepted = Boolean(
      preferredSourceTabId &&
        bootstrapInitialSearchEvidence?.ready === true &&
        bootstrapEvidencePlatform &&
        bootstrapEvidenceTabId === Number(preferredSourceTabId),
    );
    const pagePlatform = bootstrapEvidenceAccepted
      ? bootstrapEvidencePlatform
      : getPagePlatform(runtime);
    const captureTaskDebugSupported =
      supportsPersistentCaptureTaskPlatform(pagePlatform);
    if (selectedPlatform !== pagePlatform) {
      const platformCopy = getPlatformCopy(selectedPlatform);
      showMessage(
        `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再采集`,
        "error",
      );
      return {started: false, reason: "当前数据视图与页面平台不一致"};
    }
    if (
      runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS &&
      !bootstrapEvidenceAccepted
    ) {
      showMessage("请先切换到搜索页", "error");
      return {started: false, reason: "当前页面不是搜索结果页"};
    }
    if (!getPlatformCapabilities(pagePlatform).captureSearch) {
      showMessage("当前平台暂不支持搜索结果采集", "warning");
      return {started: false, reason: "当前平台暂不支持搜索结果采集"};
    }

    const rawKeywords = getBatchKeywordsFromTextarea();
    if (rawKeywords.length === 0) {
      showMessage("请输入至少一个关键词（每行一个）", "warning");
      return {started: false, reason: "未填写关键词"};
    }
    if (rawKeywords.length > MAX_BATCH_KEYWORDS) {
      showMessage(`单次最多批量采集 ${MAX_BATCH_KEYWORDS} 个关键词`, "warning");
      return {started: false, reason: `关键词超过 ${MAX_BATCH_KEYWORDS} 个`};
    }

    const keywords = dedupeKeywords(rawKeywords);
    updateBatchKeywordInputState();
    persistCurrentBatchDraft();

    let executionLock = null;
    let streamingSyncQueue = null;
    let streamingSyncResult = null;
    let streamingSyncDrained = false;
    let failureOutcome = null;
    let caughtError = null;
    let sidebarTaskContext = null;
    let captureTaskContext = null;
    let captureTaskContextNeedsCompletion = false;
    let captureTaskSessionStarted = Boolean(
      captureTaskDebugSupported &&
        externalCaptureTaskContext &&
        runOptions.captureTaskSessionStarted === true,
    );
    let captureTaskSessionOwnedHere = false;
    let persistentCaptureTaskId = "";
    let sidebarTaskStatus = "failed";
    let sidebarTaskError = null;
    let sidebarTaskMetadata = {
      platform: pagePlatform,
      keywordCount: keywords.length,
    };
    let captureTaskRoundTotal = 1;
    let captureTaskDisplayMeta = {
      keywordList: [...keywords],
      executionMode,
      searchFilters:
        runOptions.searchFilters && typeof runOptions.searchFilters === "object"
          ? {...runOptions.searchFilters}
          : {},
      enhancementEnabled: false,
      aiRelevancePrefilterEnabled: false,
      commentsEnabled: false,
      bloggerMetricsEnabled: false,
    };
    const notifyProgress = (progress = {}) => {
      if (!isCurrentUnattendedInvocation()) {
        return projectCaptureTaskProgress({
          ...progress,
          ...(persistentCaptureTaskId
            ? {captureTaskId: persistentCaptureTaskId}
            : {}),
          ...(scopedUnattendedRequestId
            ? {unattendedRequestId: scopedUnattendedRequestId}
            : {}),
          ...(scopedUnattendedAttemptId
            ? {unattendedAttemptId: scopedUnattendedAttemptId}
            : {}),
        });
      }
      const projectedProgress = rememberCaptureTaskProgressContext({
        ...progress,
        ...(persistentCaptureTaskId
          ? {captureTaskId: persistentCaptureTaskId}
          : {}),
        ...(scopedUnattendedRequestId
          ? {unattendedRequestId: scopedUnattendedRequestId}
          : {}),
        ...(scopedUnattendedAttemptId
          ? {unattendedAttemptId: scopedUnattendedAttemptId}
          : {}),
        roundTotal:
          readFiniteProgressNumber(progress?.roundTotal, captureTaskRoundTotal) ||
          captureTaskRoundTotal,
        taskMeta: {
          ...captureTaskDisplayMeta,
          ...(progress?.taskMeta &&
          typeof progress.taskMeta === "object" &&
          !Array.isArray(progress.taskMeta)
            ? progress.taskMeta
            : {}),
        },
      });
      if (captureTaskSessionStarted && persistentCaptureTaskId) {
        void updateCaptureTaskSession({
          taskId: persistentCaptureTaskId,
          progress: projectedProgress,
        });
      }
      externalNotifyProgress?.(projectedProgress);
      return projectedProgress;
    };
    const batchInvocationToken = Symbol("batch-keyword-capture");
    controllerState.activeBatchKeywordInvocationToken = batchInvocationToken;
    try {
      const storedCaptureSettings = await getCaptureSettings();
      const taskCaptureSettings =
        runOptions.captureSettings &&
        typeof runOptions.captureSettings === "object" &&
        !Array.isArray(runOptions.captureSettings) &&
        Object.keys(runOptions.captureSettings).length > 0
          ? resolveTaskCaptureSettingsOverrides(
              storedCaptureSettings,
              runOptions.captureSettings,
            )
          : null;
      const settings = taskCaptureSettings ||
        resolveCurrentDetailCaptureSettings(storedCaptureSettings);
      streamingSyncQueue = createStreamingDetailAutoSyncQueue(settings, {
        shouldStop: shouldStopBatchInvocation,
        captureTaskId: scopedUnattendedRequestId,
        resolveCaptureTaskItemAttempt,
      });
      if (
        settings.autoDetailCaptureAfterListCapture &&
        !ensureAuthVerifiedOrWarn({
          message: PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
        })
      ) {
        return {started: false, reason: "采集增强需要先完成授权验证"};
      }
      executionLock = await acquireCaptureExecutionLock({
        owner: executionLockOwner,
        label: executionLockLabel,
      });
      if (!executionLock) {
        return {started: false, reason: "已有采集任务运行中"};
      }
      if (
        executionLockOwner === "unattended_keyword_plan" &&
        (controllerState.activeUnattendedAttemptRejected || !isCurrentUnattendedInvocation())
      ) {
        return {started: false, canceled: true, reason: "当前执行已被新的恢复任务接管"};
      }
      if (executionLockOwner !== "unattended_keyword_plan") {
        sidebarTaskContext = beginSidebarTask({
          taskType: "capture",
          featureKey: "capture.keyword_batch",
          metadata: sidebarTaskMetadata,
        });
        captureTaskContext = sidebarTaskContext;
      } else if (externalCaptureTaskContext) {
        captureTaskContext = externalCaptureTaskContext;
      } else {
        captureTaskContext = beginTaskContext({
          taskType: "capture",
          featureKey: "capture.unattended_keyword",
          source: "unattended",
          metadata: sidebarTaskMetadata,
        });
        captureTaskContextNeedsCompletion = true;
      }

      const sortContext = await syncKeywordSortDimensionFromPage({
        force: true,
        fallbackDimension: controllerState.keywordSortDimension,
      });
      const keywordMinLikes = readKeywordMinLikesFromInput(
        settings.keywordMinLikes,
      );
      const hasTaskKeywordMaxDetectedItems =
        runOptions.keywordMaxDetectedItems !== null &&
        runOptions.keywordMaxDetectedItems !== undefined &&
        runOptions.keywordMaxDetectedItems !== "";
      const keywordMaxDetectedItems = hasTaskKeywordMaxDetectedItems
        ? resolveTaskKeywordMaxDetectedItems(
            settings.keywordMaxDetectedItems,
            runOptions.keywordMaxDetectedItems,
          )
        : readKeywordMaxDetectedItemsFromInput(
            settings.keywordMaxDetectedItems,
          );
      captureTaskDisplayMeta.keywordMaxDetectedItems =
        keywordMaxDetectedItems;

      let baseSearchUrl = runtime?.lastPageUrl || "";
      try {
        let tab = null;
        if (preferredSourceTabId) {
          tab = await chrome.tabs.get(preferredSourceTabId);
        } else {
          [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
        }
        if (tab?.url) {
          baseSearchUrl = tab.url;
        }
        controllerState.activeBatchRunnerTabId = tab?.id ? Number(tab.id) : null;
      } catch (error) {
        if (preferredSourceTabId) {
          throw new Error(
            `指定的${captureExecutionLabel}页面不可用，已停止以免误采其它标签页：${String(
              error?.message || error || "页面不存在",
            )}`,
          );
        }
        // Manual capture can still resolve its current active tab below.
        controllerState.activeBatchRunnerTabId = null;
      }

      const sourceTabId = captureTaskDebugSupported
        ? await resolveCaptureTaskSourceTabId({
            preferredTabId: controllerState.activeBatchRunnerTabId,
            platform: pagePlatform,
          })
        : null;
      persistentCaptureTaskId = captureTaskDebugSupported
        ? String(captureTaskContext?.taskId || "").trim()
        : "";
      const ensurePersistentCaptureTaskSession = async () => {
        if (!captureTaskDebugSupported) return;
        if (captureTaskSessionStarted) return;
        const assistSession = await startOptionalCaptureAssistSession({
          taskId: persistentCaptureTaskId,
          tabId: sourceTabId,
          label:
            executionLockOwner === "unattended_keyword_plan"
              ? `${captureExecutionLabel} · ${keywords.length} 个关键词`
              : `批量搜索采集 · ${keywords.length} 个关键词`,
          platform: pagePlatform,
        });
        captureTaskSessionStarted = assistSession?.active === true;
        captureTaskSessionOwnedHere = assistSession?.active === true;
      };

      if (
        executionLockOwner === "unattended_keyword_plan" &&
        (!isCurrentUnattendedInvocation() ||
          controllerState.activeCaptureTaskCancellationReason)
      ) {
        return {
          started: true,
          canceled: true,
          reason:
            controllerState.activeCaptureTaskCancellationReason ||
            "unattended_attempt_replaced",
        };
      }
      controllerState.batchKeywordCaptureInFlight = true;
      controllerState.batchKeywordCancelRequested = false;

      taskView.showBatchKeywordRunning();

      setBatchProgressVisible("modal", true);

      // 执行轮数:1 轮即普通采集,大于 1 才按轮次间隔继续跑。
      const roundGapMin = Math.max(0, Number(taskView.readBatchLoopGapMinutesInput()) || 0);
      const maxRounds = Math.max(1, Math.floor(Number(taskView.readBatchLoopRoundsInput())) || 1); // 留空/0 = 1 轮(不做无限,防风控)
      captureTaskRoundTotal = maxRounds;
      const autoLoop = maxRounds > 1;
      const roundGapMs = roundGapMin * 60 * 1000;
      // 采集排序 / 范围(默认值归一为空 → 不触发筛选点击);复用「找对标账号」的筛选点击能力
      // 无人值守直接用计划里已归一化的 searchFilters,绕开"设控件→回读"的回环
      // (避免重渲染扰动/平台专属字段被抹);手动批量不传该项 → 仍回读 modal 控件。
      const searchFilters =
        runOptions.searchFilters && typeof runOptions.searchFilters === "object"
          ? runOptions.searchFilters
          : collectSearchFiltersFromControls("modal");
      captureTaskDisplayMeta = {
        ...captureTaskDisplayMeta,
        searchFilters: {...(searchFilters || {})},
        ...(sequentialSearchEnabled
          ? {searchPasses: [...sequentialSearchPasses]}
          : {}),
        enhancementEnabled: Boolean(settings.autoDetailCaptureAfterListCapture),
        aiRelevancePrefilterEnabled: Boolean(
          settings.enableAiRelevancePrefilter,
        ),
        commentsEnabled: Boolean(settings.includeCommentsOnDetailCapture),
        bloggerMetricsEnabled: Boolean(
          settings.includeBloggerMetricsOnDetailCapture,
        ),
      };
      const resumeCheckpoint =
        runOptions.resumeCheckpoint &&
        typeof runOptions.resumeCheckpoint === "object"
          ? runOptions.resumeCheckpoint
          : null;
      const onKeywordSettled =
        typeof runOptions.onKeywordSettled === "function"
          ? runOptions.onKeywordSettled
          : null;
      const maxKeywordAttempts = Math.max(
        1,
        Math.min(4, Number(runOptions.maxKeywordAttempts) || 1),
      );

      let result;
      const resumeRound = resumeCheckpoint
        ? Math.min(maxRounds, Math.max(1, Number(resumeCheckpoint.round) || 1))
        : 1;
      let round = resumeRound - 1;
      const previousKeywordResults = Array.isArray(resumeCheckpoint?.keywordResults)
        ? resumeCheckpoint.keywordResults
        : [];
      let totalSuccess = previousKeywordResults.filter(
        (entry) =>
          Math.max(1, Number(entry?.round) || 1) < resumeRound &&
          String(entry?.status || "") === "completed",
      ).length;
      let totalFailed = previousKeywordResults.filter(
        (entry) =>
          Math.max(1, Number(entry?.round) || 1) < resumeRound &&
          String(entry?.status || "") === "failed",
      ).length;

      // 定时启动:指定了开始时刻则等到那一刻再开跑(可中断),等待期间显示倒计时
      const scheduledStartStr = taskView.readBatchScheduledStart();
      if (scheduledStartStr) {
        const targetMs = new Date(scheduledStartStr).getTime();
        if (Number.isFinite(targetMs) && targetMs > Date.now()) {
          const targetLabel = new Date(scheduledStartStr).toLocaleString("zh-CN");
          setBatchProgressVisible("modal", true);
          let lastShownSec = -1;
          await sleepWithStop(targetMs - Date.now(), () => {
            if (shouldStopBatchInvocation()) return true;
            const remainSec = Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
            if (remainSec !== lastShownSec) {
              lastShownSec = remainSec;
              const h = Math.floor(remainSec / 3600);
              const m = Math.floor((remainSec % 3600) / 60);
              const s = remainSec % 60;
              updateBatchProgress(
                {
                  current: 0,
                  total: keywords.length,
                  keywordCurrent: 0,
                  keywordTotal: keywords.length,
                  nextKeyword: keywords[0] || "",
                  progressScope: "wait",
                  roundCurrent: 1,
                  roundTotal: maxRounds,
                  phase: "scheduled-waiting",
                  remainingMs: Math.max(0, targetMs - Date.now()),
                  message: `⏰ 定时采集:将于 ${targetLabel} 开始(还剩 ${h > 0 ? h + "时" : ""}${m}分${s}秒)`,
                },
                "modal",
              );
              notifyProgress?.({
                current: 0,
                total: keywords.length,
                keywordCurrent: 0,
                keywordTotal: keywords.length,
                nextKeyword: keywords[0] || "",
                progressScope: "wait",
                roundCurrent: 1,
                roundTotal: maxRounds,
                phase: "scheduled-waiting",
                remainingMs: Math.max(0, targetMs - Date.now()),
                message: `定时采集:将于 ${targetLabel} 开始(还剩 ${h > 0 ? h + "时" : ""}${m}分${s}秒)`,
              });
            }
            return false;
          });
          if (shouldStopBatchInvocation()) {
            showMessage("已取消定时采集", "warning");
            return {started: true, canceled: true, reason: "已取消定时采集"}; // finally 会复位状态/按钮
          }
        }
      }

      await ensurePersistentCaptureTaskSession();

      do {
        round += 1;
        const activeSearchPass = sequentialSearchEnabled
          ? sequentialSearchPasses[Math.min(round - 1, sequentialSearchPasses.length - 1)]
          : "";
        const activeSearchPassLabel = unattendedSearchPassLabel(activeSearchPass);
        const roundSearchFilters = activeSearchPass
          ? {...searchFilters, contentType: activeSearchPass}
          : searchFilters;
        if (activeSearchPass) {
          captureTaskDisplayMeta = {
            ...captureTaskDisplayMeta,
            searchFilters: {...roundSearchFilters},
            searchPassCurrent: round,
            searchPassTotal: sequentialSearchPasses.length,
            searchPassLabel: activeSearchPassLabel,
          };
        }
        const completedBeforeRun = resolveCompletedCheckpointKeywords(
          resumeCheckpoint,
          round,
        );
        const exhaustedBeforeRun = previousKeywordResults.filter(
          (entry) =>
            Math.max(1, Number(entry?.round) || 1) === round &&
            String(entry?.status || "") === "failed" &&
            Math.max(0, Number(entry?.attemptCount) || 0) >= maxKeywordAttempts,
        );
        const exhaustedKeywords = new Set(
          exhaustedBeforeRun.map((entry) => String(entry?.keyword || "").trim()),
        );
        let pendingKeywords = keywords.filter(
          (keyword) =>
            !completedBeforeRun.has(keyword) && !exhaustedKeywords.has(keyword),
        );
        let keywordAttempt = 1;
        const baseBatchOptions = {
          keywords: [...pendingKeywords],
          platform: pagePlatform,
          baseSearchUrl,
          sourceTabId: controllerState.activeBatchRunnerTabId,
          captureTaskId: captureTaskSessionStarted
            ? persistentCaptureTaskId
            : "",
          searchFilters: roundSearchFilters,
          disableAutomaticSearchRetry,
          requireVerifiedFilters,
          captureParams: {
            minLikes: keywordMinLikes,
            sortDimension: sortContext.dimension,
            maxDetectedItems: keywordMaxDetectedItems,
            waitMinMs: settings.sharedWaitMinMs,
            waitMaxMs: settings.sharedWaitMaxMs,
            stallTimeoutMs: settings.sharedStallTimeoutMs,
            maxDurationMs: settings.sharedMaxDurationMs,
          },
          waitForegroundTabId,
          onKeywordSettled: onKeywordSettled || streamingSyncQueue?.enabled
            ? async (settled = {}) => {
                const ownerCurrent = isCurrentUnattendedInvocation();
                settleKeywordRecordsForStreamingSync(
                  streamingSyncQueue,
                  settled,
                  {ownerCurrent},
                );
                if (!ownerCurrent || !onKeywordSettled) {
                  return;
                }
                const originalIndex = Math.max(
                  0,
                  keywords.indexOf(String(settled.keyword || "").trim()),
                );
                await onKeywordSettled({
                  ...settled,
                  current: originalIndex + 1,
                  total: keywords.length,
                  originalIndex,
                  round,
                  attempt: keywordAttempt,
                  maxAttempts: maxKeywordAttempts,
                });
              }
            : null,
          afterKeywordCapture: settings.autoDetailCaptureAfterListCapture
            ? async ({
                keyword: capturedKeyword,
                recordIds,
                runnerTabId,
              }) => {
                streamingSyncQueue?.registerCaptured?.(recordIds);
                if (!isCurrentUnattendedInvocation()) {
                  return {
                    ok: false,
                    canceled: true,
                    reason: "unattended_attempt_replaced",
                  };
                }
                const keywordPlanIndex = keywords.indexOf(
                  String(capturedKeyword || "").trim(),
                );
                const keywordPlanProgress =
                  keywordPlanIndex >= 0
                    ? {
                        keywordCurrent: keywordPlanIndex + 1,
                        keywordTotal: keywords.length,
                        nextKeyword: keywords[keywordPlanIndex + 1] || "",
                      }
                    : {};
                rememberCaptureTaskProgressContext({
                  phase: "detail_preparing",
                  progressScope: "detail_item",
                  keyword: capturedKeyword,
                  ...keywordPlanProgress,
                  round,
                  roundCurrent: round,
                  roundTotal: maxRounds,
                  attempt: keywordAttempt,
                  attemptCurrent: keywordAttempt,
                  attemptTotal: maxKeywordAttempts,
                  taskMeta: captureTaskDisplayMeta,
                });
                await refreshDataPool();
                const enhanceResult =
                  await maybeRunAutoDetailCaptureAfterListCapture(
                    settings,
                    {
                      sourceLabel: `关键词「${capturedKeyword}」搜索结果`,
                      recordIds,
                      relevanceKeyword: capturedKeyword,
                      waitForegroundTabId,
                      captureTaskId: captureTaskSessionStarted
                        ? persistentCaptureTaskId
                        : "",
                      unattendedRequestId: scopedUnattendedRequestId,
                      unattendedAttemptId: scopedUnattendedAttemptId,
                      onItemSettled: streamingSyncQueue?.enabled
                        ? (progress) =>
                            routeDetailItemToStreamingSync(
                              streamingSyncQueue,
                              progress,
                              {
                                sourceLabel: `关键词「${capturedKeyword}」笔记`,
                                keyword: capturedKeyword,
                              },
                            )
                        : null,
                      onProgress: notifyProgress
                        ? (detailProgress = {}) =>
                            notifyProgress({
                              ...detailProgress,
                              keyword: capturedKeyword,
                              ...keywordPlanProgress,
                              itemCurrent: readFiniteProgressNumber(
                                detailProgress.itemCurrent,
                                detailProgress.current,
                              ),
                              itemTotal: readFiniteProgressNumber(
                                detailProgress.itemTotal,
                                detailProgress.total,
                              ),
                              progressScope: "detail_item",
                              round,
                              roundCurrent: round,
                              roundTotal: maxRounds,
                              attempt: keywordAttempt,
                              attemptCurrent: keywordAttempt,
                              attemptTotal: maxKeywordAttempts,
                              phase: detailProgress.phase || "enhancing",
                              message:
                                detailProgress.message ||
                                `正在增强关键词「${capturedKeyword}」的采集结果`,
                              runnerTabId:
                                detailProgress.runnerTabId || runnerTabId || null,
                            })
                        : null,
                    },
                  );
                if (enhanceResult?.securityBlocked) {
                  controllerState.batchKeywordCancelRequested = true;
                  showMessage(
                    "⚠️ 触发小红书安全限制(访问频繁),已停止无人值守。建议隔较长时间(数小时)再跑。",
                    "warning",
                  );
                  return {...enhanceResult, canceled: true};
                }
                const resultInterruption = resolveUnattendedEnhanceCancellation(
                  enhanceResult,
                );
                if (resultInterruption.stopBatch) {
                  controllerState.batchKeywordCancelRequested = true;
                  if (enhanceResult?.integrityBlocked === true) {
                    showMessage(
                      "⚠️ 无法确认当前抖音作品身份，已停止无人值守，且未同步未验证数据。",
                      "warning",
                    );
                  }
                  return {
                    ...enhanceResult,
                    fatal: enhanceResult?.fatal === true,
                    stopBatch: true,
                    cancellationReason:
                      resultInterruption.reason ||
                      (enhanceResult?.integrityBlocked
                        ? "fatal_douyin_identity_mismatch"
                        : "fatal_detail_capture"),
                  };
                }
                if (enhanceResult?.canceled || resultInterruption.recoverable) {
                  const interruptionReason = controllerState.activeUnattendedAttemptRejected
                    ? "fatal_attempt_replaced"
                    : controllerState.activeUnattendedRunRequestId &&
                        !controllerState.activeCaptureExecutionLockId
                      ? "fatal_capture_lock_lost"
                      : controllerState.activeCaptureTaskCancellationReason;
                  const cancellation = resolveUnattendedEnhanceCancellation(
                    enhanceResult,
                    interruptionReason,
                  );
                  if (cancellation.stopBatch) {
                    controllerState.batchKeywordCancelRequested = true;
                    return {
                      ...enhanceResult,
                      cancellationReason: cancellation.reason,
                    };
                  }
                  // Debug/侧栏工作页的临时断开只影响当前关键词的增强结果。
                  // 把它保存为 partial，交给检查点恢复；不能让 shouldStop
                  // 把后续所有关键词误判成“用户取消”。
                  controllerState.batchKeywordCancelRequested = false;
                  if (
                    resolveUnattendedEnhanceCancellation(
                      {},
                      controllerState.activeCaptureTaskCancellationReason,
                    ).recoverable
                  ) {
                    controllerState.activeCaptureTaskCancellationReason = "";
                  }
                  return {
                    ...enhanceResult,
                    ok: false,
                    canceled: false,
                    partial: true,
                    recoverable: true,
                    cancellationReason:
                      cancellation.reason || "detail_capture_interrupted",
                    reason:
                      enhanceResult.reason ||
                      cancellation.reason ||
                      "detail_capture_interrupted",
                  };
                }
                if (streamingSyncQueue?.enabled) {
                  streamingSyncQueue.enqueueMissing(recordIds, {
                    sourceLabel: `关键词「${capturedKeyword}」笔记`,
                    keyword: capturedKeyword,
                  });
                }
                if (!streamingSyncQueue?.enabled) {
                  const captureAttempt = resolveCaptureTaskItemAttempt({
                    keyword: capturedKeyword,
                  });
                  await maybeRunAutoSyncAfterDetailCapture(settings, {
                    sourceLabel: `关键词「${capturedKeyword}」搜索结果`,
                    recordIds,
                    shouldStop: shouldStopBatchInvocation,
                    captureTaskId: scopedUnattendedRequestId,
                    captureTaskItemAttemptId: String(
                      captureAttempt?.attemptId || "",
                    ).trim(),
                    captureTaskItemRequestHash: String(
                      captureAttempt?.requestHash || "",
                    ).trim(),
                  });
                }
                return enhanceResult;
              }
            : null,
          onProgress: (progress) => {
            if (!isCurrentUnattendedInvocation()) {
              return;
            }
            // 进入「导航 / 切筛选 / 等待」阶段时清掉上一条采集明细,等本条列表采集再刷新
            if (progress.phase && progress.phase !== "capturing") {
              setBatchProgressDetail("");
            }
            const progressKeyword = String(progress?.keyword || "").trim();
            const originalIndex = progressKeyword
              ? keywords.indexOf(progressKeyword)
              : -1;
            const normalizedProgress = {
              ...progress,
              current: originalIndex >= 0 ? originalIndex + 1 : progress.current,
              total: keywords.length,
              keywordCurrent:
                originalIndex >= 0 ? originalIndex + 1 : progress.current,
              keywordTotal: keywords.length,
              itemCurrent: null,
              itemTotal: null,
              nextKeyword:
                originalIndex >= 0 ? keywords[originalIndex + 1] || "" : "",
              progressScope: "keyword",
              roundCurrent: round,
              roundTotal: maxRounds,
              attempt: keywordAttempt,
              attemptCurrent: keywordAttempt,
              attemptTotal: maxKeywordAttempts,
              maxAttempts: maxKeywordAttempts,
            };
            const progressForUi = autoLoop
              ? {
                  ...normalizedProgress,
                  round,
                  message: sequentialSearchEnabled
                    ? `${activeSearchPassLabel} · ${progress.message || ""}`
                    : `第 ${round} 轮 · ${progress.message || ""}`,
                }
              : { ...normalizedProgress, round };
            if (sequentialSearchEnabled) {
              progressForUi.searchPass = activeSearchPass;
              progressForUi.searchPassCurrent = round;
              progressForUi.searchPassTotal = sequentialSearchPasses.length;
              progressForUi.searchPassLabel = activeSearchPassLabel;
            }
            progressForUi.message = appendStreamingSyncSummary(
              progressForUi.message,
              streamingSyncQueue,
            );
            updateBatchProgress(
              progressForUi,
              "modal",
            );
            notifyProgress?.(progressForUi);
          },
          shouldStop: shouldStopBatchInvocation,
        };

        let mergedAttemptResult = {
          ok: exhaustedBeforeRun.length === 0,
          canceled: false,
          securityBlocked: false,
          results: exhaustedBeforeRun.map((entry) => ({
            keyword: String(entry?.keyword || ""),
            ok: false,
            error: String(entry?.error || "已达自动重试上限"),
            retryExhausted: true,
          })),
          stats: {
            total: keywords.length,
            processed: completedBeforeRun.size + exhaustedBeforeRun.length,
            success: completedBeforeRun.size,
            failed: exhaustedBeforeRun.length,
          },
        };

        const attemptRun = await runUnattendedKeywordAttempts({
          allKeywords: keywords,
          initialPendingKeywords: pendingKeywords,
          initialResult: mergedAttemptResult,
          completedBeforeRun,
          maxAttempts: maxKeywordAttempts,
          runAttempt: async ({keywords: attemptKeywords, attempt}) => {
            keywordAttempt = attempt;
            const attemptInitialSearchEvidence =
              attempt === 1 ? bootstrapInitialSearchEvidence : null;
            // A bootstrap navigation proves exactly one search operation. Never
            // let a later local retry or search pass reuse that old page proof.
            bootstrapInitialSearchEvidence = null;
            const attemptResult = await batchCaptureByKeywords({
              ...baseBatchOptions,
              keywords: attemptKeywords,
              initialSearchEvidence: attemptInitialSearchEvidence,
            });
            return attemptResult;
          },
          selectRetryKeywords: ({keywords: failedKeywords}) => {
            if (!resumeCheckpoint || !onKeywordSettled) {
              return failedKeywords;
            }
            return failedKeywords.filter((keyword) => {
              const checkpointEntry = (Array.isArray(resumeCheckpoint.keywordResults)
                ? resumeCheckpoint.keywordResults
                : []
              ).find(
                (entry) =>
                  Math.max(1, Number(entry?.round) || 1) === round &&
                  String(entry?.keyword || "").trim() === keyword,
              );
              return (
                !checkpointEntry ||
                Math.max(0, Number(checkpointEntry.attemptCount) || 0) <
                  maxKeywordAttempts
              );
            });
          },
          onRetryScheduled: async ({keywords: failedKeywords, attempt}) => {
            keywordAttempt = attempt;
            const retryDelay = Math.max(
              0,
              Number(
                UNATTENDED_KEYWORD_RETRY_DELAYS_MS[
                  Math.max(0, Number(attempt) - 2)
                ] ?? UNATTENDED_KEYWORD_RETRY_DELAYS_MS.at(-1),
              ) || 0,
            );
            const waitUntil = new Date(Date.now() + retryDelay).toISOString();
            const releaseElasticItem = Boolean(
              releaseElasticItemOnLongRetry &&
                failedKeywords.length > 0 &&
                retryDelay >= UNATTENDED_ELASTIC_RELEASE_MIN_DELAY_MS,
            );
            const retryProgress = {
              current: 0,
              total: keywords.length,
              keywordCurrent: 0,
              keywordTotal: keywords.length,
              nextKeyword: failedKeywords[0] || "",
              progressScope: "wait",
              round,
              roundCurrent: round,
              roundTotal: maxRounds,
              attempt,
              attemptCurrent: attempt,
              attemptTotal: maxKeywordAttempts,
              maxAttempts: maxKeywordAttempts,
              phase: releaseElasticItem
                ? "releasing_elastic_keyword"
                : "keyword_retry_wait",
              remainingMs: retryDelay,
              waitUntil,
              updatedAt: new Date().toISOString(),
              message: releaseElasticItem
                ? `关键词「${failedKeywords[0]}」已解除当前 Agent 锁定，正在交回云端；当前 Agent 可立即领取其它任务`
                : `${Math.ceil(retryDelay / 1000)} 秒后自动重试 ${failedKeywords.length} 个失败关键词（第 ${attempt}/${maxKeywordAttempts} 次）`,
            };
            updateBatchProgress(retryProgress, "modal");
            notifyProgress?.(retryProgress);
            if (releaseElasticItem) {
              const releaseError = new Error(retryProgress.message);
              releaseError.code = "UNATTENDED_ELASTIC_ITEM_RELEASED";
              releaseError.keyword = failedKeywords[0] || "";
              releaseError.retryAfterMs = retryDelay;
              releaseError.retryAt = waitUntil;
              releaseError.itemLockReleased = true;
              releaseError.requiresManualAction = false;
              releaseError.retryable = true;
              throw releaseError;
            }
            await sleepWithStop(retryDelay, shouldStopBatchInvocation);
          },
          shouldStop: shouldStopBatchInvocation,
        });
        mergedAttemptResult = attemptRun.result;
        pendingKeywords = attemptRun.pendingKeywords;

        result = mergedAttemptResult;

        await refreshDataPool();
        totalSuccess += result.stats.success;
        totalFailed += result.stats.failed;

        // 终止:被取消 / 没开循环 / 已到指定轮数
        if (
          shouldStopBatchInvocation() ||
          result.canceled ||
          result.fatal ||
          result.recoveryRequired ||
          !autoLoop ||
          round >= maxRounds
        ) {
          break;
        }

        // 进入等待前先把检查点推进到下一轮。这样在间隔中休眠、断网或关页后，
        // 恢复会直接从下一轮首词继续，不会重放已经完成的轮次或再等一整段间隔。
        if (resumeCheckpoint) {
          Object.assign(
            resumeCheckpoint,
            advanceUnattendedCheckpointRound({
              checkpoint: resumeCheckpoint,
              keywords,
              completedRound: round,
              maxRounds,
            }),
          );
        }

        // 轮次间隔:歇 roundGapMin 分钟再跑下一轮(睡眠中可中断)
        if (roundGapMs > 0) {
          const waitUntil = new Date(Date.now() + roundGapMs).toISOString();
          const buildWaitProgress = (remainingMs) => ({
            current: 0,
            total: keywords.length,
            keywordCurrent: keywords.length,
            keywordTotal: keywords.length,
            nextKeyword: keywords[0] || "",
            progressScope: "wait",
            phase: "waiting_next_round",
            remainingMs,
            message: `第 ${round} 轮完成（累计成功 ${totalSuccess}），约 ${Math.max(1, Math.ceil(remainingMs / 60000))} 分钟后开始第 ${round + 1} 轮…`,
            round,
            roundCurrent: round,
            roundTotal: maxRounds,
          });
          const waitProgress = buildWaitProgress(roundGapMs);
          updateBatchProgress(waitProgress, "modal");
          notifyProgress?.(waitProgress);
          if (typeof onKeywordSettled?.persist === "function") {
            await onKeywordSettled.persist({
              message: waitProgress.message,
              waitUntil,
            });
          }
          await sleepWithStop(
            roundGapMs,
            shouldStopBatchInvocation,
            {
              onTick: (remainingMs) => {
                const progress = buildWaitProgress(remainingMs);
                updateBatchProgress(progress, "modal");
                notifyProgress?.(progress);
              },
            },
          );
          if (!shouldStopBatchInvocation()) {
            const nextRoundProgress = {
              current: 0,
              total: keywords.length,
              keywordCurrent: 0,
              keywordTotal: keywords.length,
              nextKeyword: keywords[0] || "",
              progressScope: "wait",
              phase: "starting_next_round",
              message: `第 ${round + 1} 轮准备开始`,
              round: round + 1,
              roundCurrent: round + 1,
              roundTotal: maxRounds,
            };
            updateBatchProgress(nextRoundProgress, "modal");
            notifyProgress?.(nextRoundProgress);
          }
          if (
            !shouldStopBatchInvocation() &&
            typeof onKeywordSettled?.persist === "function"
          ) {
            await onKeywordSettled.persist({
              message: `第 ${round + 1} 轮准备开始`,
              waitUntil: "",
            });
          }
        } else if (typeof onKeywordSettled?.persist === "function") {
          await onKeywordSettled.persist({
            message: `第 ${round + 1} 轮准备开始`,
            waitUntil: "",
          });
        }
      } while (!shouldStopBatchInvocation());

      streamingSyncResult = await drainStreamingDetailSyncQueue(
        streamingSyncQueue,
        {
          round,
          updateProgress: (progress) => updateBatchProgress(progress, "modal"),
          notifyProgress,
        },
      );
      streamingSyncDrained = true;

      const stats = result.stats;
      const syncSummary = formatStreamingSyncSummary(streamingSyncResult);
      const streamingSyncTaskIssue = buildStreamingSyncTaskIssue(
        streamingSyncResult,
      );
      if (result?.securityBlocked) {
        showMessage(
          result?.blockingError?.message ||
            "检测到平台异常，已立即停止整批任务，请人工确认后再继续",
          "warning",
        );
      } else if (autoLoop) {
        const stopped = result.canceled || controllerState.batchKeywordCancelRequested;
        showMessage(
          sequentialSearchEnabled
            ? `无人值守采集${stopped ? "已停止" : "结束"}：已执行 ${round}/${sequentialSearchPasses.length} 个巡检步骤，累计成功 ${totalSuccess}，失败 ${totalFailed}${syncSummary ? `；${syncSummary}` : ""}`
            : `无人值守采集${stopped ? "已停止" : "结束"}：共跑 ${round} 轮，累计成功 ${totalSuccess}，失败 ${totalFailed}${syncSummary ? `；${syncSummary}` : ""}`,
          stopped || isStreamingSyncReconciliationRequired(streamingSyncResult)
            ? "warning"
            : "success",
        );
      } else if (result.canceled) {
        showMessage(
          `批量采集已停止：已处理 ${stats.processed}/${stats.total} 个关键词，成功 ${stats.success}，失败 ${stats.failed}${syncSummary ? `；${syncSummary}` : ""}`,
          "warning",
        );
      } else if (isStreamingSyncReconciliationRequired(streamingSyncResult)) {
        showMessage(`采集已结束；${syncSummary}`, "warning");
      } else {
        showMessage(
          `批量采集完成：共 ${stats.total} 个关键词，成功 ${stats.success}，失败 ${stats.failed}${syncSummary ? `；${syncSummary}` : ""}`,
          stats.failed > 0 ? "warning" : "success",
        );
      }
      sidebarTaskStatus = result?.securityBlocked
        ? "needs_action"
        : result?.canceled || controllerState.batchKeywordCancelRequested
          ? "canceled"
          : hasSyncReconciliationSignal(streamingSyncResult)
            ? "needs_action"
            : totalFailed > 0 || streamingSyncTaskIssue
              ? "completed_with_failures"
              : "completed";
      if (
        result?.securityBlocked &&
        result?.blockingError &&
        typeof result.blockingError === "object"
      ) {
        sidebarTaskError = {...result.blockingError};
      }
      if (streamingSyncTaskIssue && !sidebarTaskError) {
        sidebarTaskError = streamingSyncTaskIssue;
      }
      sidebarTaskMetadata = {
        ...sidebarTaskMetadata,
        rounds: round,
        successCount: totalSuccess,
        failedCount: totalFailed,
        ...buildStreamingSyncTaskMetadata(streamingSyncResult),
      };
      return {
        started: true,
        ok:
          !result?.canceled &&
          !result?.securityBlocked &&
          totalFailed === 0 &&
          !streamingSyncTaskIssue,
        canceled: Boolean(result?.canceled || controllerState.batchKeywordCancelRequested),
        securityBlocked: Boolean(result?.securityBlocked),
        requiresManualAction: Boolean(result?.requiresManualAction),
        fatal: Boolean(result?.fatal),
        blockingError:
          result?.blockingError &&
          typeof result.blockingError === "object"
            ? {...result.blockingError}
            : null,
        result,
        rounds: round,
        totalSuccess,
        totalFailed,
        streamingSync: streamingSyncResult,
        ...(hasSyncReconciliationSignal(streamingSyncResult)
          ? {reconciliationRequired: true, error: buildSyncReconciliationError()}
          : {}),
      };
    } catch (error) {
      console.error("[Sidebar] Batch keyword capture failed:", error);
      sidebarTaskStatus = "failed";
      sidebarTaskError = error;
      caughtError = error;
      const reconciliationRequired = hasSyncReconciliationSignal(error);
      if (
        error?.code === "UNATTENDED_ELASTIC_ITEM_RELEASED" &&
        !reconciliationRequired
      ) {
        throw error;
      }
      if (reconciliationRequired) {
        sidebarTaskStatus = controllerState.batchKeywordCancelRequested ? "canceled" : "needs_action";
        sidebarTaskError = isUnattendedSafetyBlock(error)
          ? error
          : buildSyncReconciliationError();
        showMessage(sidebarTaskError.message, "warning");
      } else {
        showMessage("批量采集失败: " + error.message, "error");
      }
      failureOutcome = {
        started: true,
        ok: false,
        error: reconciliationRequired ? buildSyncReconciliationError() : error.message,
        ...(reconciliationRequired
          ? {
              reconciliationRequired: true,
              canceled: Boolean(controllerState.batchKeywordCancelRequested),
              ...(isUnattendedSafetyBlock(error)
                ? {securityBlocked: true, blockingError: error}
                : {}),
            }
          : {}),
      };
      return failureOutcome;
    } finally {
      const ownsBatchInvocation = () =>
        controllerState.activeBatchKeywordInvocationToken === batchInvocationToken;
      const ownsCurrentBatchInvocation = () =>
        ownsBatchInvocation() && isCurrentUnattendedInvocation();
      if (
        ownsCurrentBatchInvocation() &&
        streamingSyncQueue &&
        !streamingSyncDrained
      ) {
        streamingSyncResult = await drainStreamingDetailSyncQueue(
          streamingSyncQueue,
          {notifyProgress},
        ).catch((error) => {
          console.warn("[Sidebar] Drain streaming sync after batch failed:", error);
          return streamingSyncQueue.getStats();
        });
        streamingSyncDrained = true;
      }
      // The terminal drain happens in finally so every exceptional exit uses the
      // same queue. Preserve that result on the already-returned object/error;
      // otherwise the outer unattended runner cannot prove the source attempt is
      // locally closed and a safe relay waits forever.
      if (streamingSyncResult) {
        if (failureOutcome) {
          failureOutcome.streamingSync = streamingSyncResult;
        }
        if (caughtError && typeof caughtError === "object") {
          caughtError.streamingSync = streamingSyncResult;
        }
      }
      if (
        hasSyncReconciliationSignal(streamingSyncResult) ||
        hasSyncReconciliationSignal(caughtError)
      ) {
        if (failureOutcome) {
          failureOutcome.reconciliationRequired = true;
          failureOutcome.error = buildSyncReconciliationError();
          if (controllerState.batchKeywordCancelRequested) failureOutcome.canceled = true;
          if (isUnattendedSafetyBlock(caughtError)) {
            failureOutcome.securityBlocked = true;
            failureOutcome.blockingError = caughtError;
          }
        }
        if (
          !controllerState.batchKeywordCancelRequested && sidebarTaskStatus !== "canceled" &&
          !isUnattendedSafetyBlock(sidebarTaskError)
        ) {
          sidebarTaskStatus = "needs_action";
          sidebarTaskError = buildSyncReconciliationError();
        }
      }
      const shouldEndCaptureTaskSession =
        ownsCurrentBatchInvocation() &&
        captureTaskSessionStarted &&
        !captureTaskLifecycleOwnedByCaller &&
        (captureTaskSessionOwnedHere || !externalCaptureTaskContext);
      if (shouldEndCaptureTaskSession) {
        const terminal = resolveCaptureTaskTerminalStatus({
          taskStatus: sidebarTaskStatus,
          error: sidebarTaskError,
          canceled:
            controllerState.batchKeywordCancelRequested || sidebarTaskStatus === "canceled",
        });
        const captureTaskEnd = await endCaptureTaskSession({
          taskId: persistentCaptureTaskId,
          ...terminal,
        });
        const captureTaskEnded =
          captureTaskEnd?.ok === true ||
          captureTaskEnd?.reason === "capture_task_not_found" ||
          captureTaskEnd?.response?.error?.code === "capture_task_not_found";
        if (captureTaskEnded) {
          releaseCaptureTaskOwner(persistentCaptureTaskId);
        }
      }
      if (ownsCurrentBatchInvocation() && sidebarTaskContext) {
        finishSidebarTask(sidebarTaskContext, {
          status: sidebarTaskStatus,
          error: sidebarTaskError,
          metadata: sidebarTaskMetadata,
        });
      } else if (
        ownsCurrentBatchInvocation() &&
        captureTaskContextNeedsCompletion &&
        captureTaskContext
      ) {
        completeTaskContext({
          taskType: captureTaskContext.taskType,
          featureKey: captureTaskContext.featureKey,
        });
      }
      if (ownsCurrentBatchInvocation()) {
        clearCaptureTaskProgressContext();
        if (executionLock) {
          await releaseCaptureExecutionLock(executionLock.id);
        }
      }
      if (ownsCurrentBatchInvocation()) {
        setBatchProgressDetail("");

        taskView.showBatchKeywordIdle();
        updateBatchKeywordInputState();
      }
      if (ownsBatchInvocation()) {
        controllerState.batchKeywordCaptureInFlight = false;
        controllerState.batchKeywordCancelRequested = false;
        controllerState.activeBatchRunnerTabId = null;
        controllerState.activeBatchKeywordInvocationToken = null;
      }
    }
  }

  return Object.freeze({
    handleBatchKeywordCapture,
  });
}
