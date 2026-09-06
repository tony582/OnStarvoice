// L3-A manual-capture: original control flow, explicit state and compatibility ports.
export function createManualCaptureController({controllerState, controllerPorts, controllerOperations}) {
  const {
    ERROR_MESSAGE_MAP,
    MAX_BATCH_KEYWORDS,
    MESSAGE_TYPE,
    PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
    PAGE_TYPE,
    UNATTENDED_KEYWORD_RETRY_MAX_MS,
    UNATTENDED_KEYWORD_RETRY_MIN_MS,
    batchCaptureByKeywords,
    buildStreamingSyncCompletionNotice,
    buildStreamingSyncTaskIssue,
    buildStreamingSyncTaskMetadata,
    captureAndSync,
    captureNoteWithOptionalComments,
    chrome,
    collectSearchFiltersFromControls,
    console,
    taskView,
    endCaptureTaskSession,
    ensureAuthVerifiedOrWarn,
    extractKeywordFromUrl,
    getCaptureBloggerMetricsChecked,
    getCaptureCommentsChecked,
    getCaptureSettings,
    getCommentLeadsFilterChecked,
    getCurrentRuntime,
    getKeywordSortDimensionLabel,
    getPagePlatform,
    getPlatformCapabilities,
    getPlatformCopy,
    getViewPlatform,
    hideProgress,
    isNoteDetailPending,
    isStreamingSyncReconciliationRequired,
    parseSearchManualScheduledStart,
    readBloggerKeywordFilterFromInput,
    readBloggerMaxDetectedItemsFromInput,
    readBloggerMinLikesFromInput,
    readKeywordMaxDetectedItemsFromInput,
    readKeywordMinLikesFromInput,
    readRequiredCommentsMaxDetectedItemsFromInput,
    refreshDataPool,
    resolveCurrentDetailCaptureSettings,
    resolveNoteDetailPendingText,
    runUnattendedKeywordAttempts,
    shouldHideNoteBloggerMetricsToggle,
    showMessage,
    showProgress,
    syncKeywordSortDimensionFromPage,
  } = controllerPorts;
  const acquireCaptureExecutionLock = (...args) => controllerOperations.acquireCaptureExecutionLock(...args);
  const appendStreamingSyncSummary = (...args) => controllerOperations.appendStreamingSyncSummary(...args);
  const beginSidebarTask = (...args) => controllerOperations.beginSidebarTask(...args);
  const createStreamingDetailAutoSyncQueue = (...args) => controllerOperations.createStreamingDetailAutoSyncQueue(...args);
  const dedupeKeywords = (...args) => controllerOperations.dedupeKeywords(...args);
  const drainStreamingDetailSyncQueue = (...args) => controllerOperations.drainStreamingDetailSyncQueue(...args);
  const finishSidebarTask = (...args) => controllerOperations.finishSidebarTask(...args);
  const handleProgress = (...args) => controllerOperations.handleProgress(...args);
  const maybeRunAutoDetailCaptureAfterListCapture = (...args) => controllerOperations.maybeRunAutoDetailCaptureAfterListCapture(...args);
  const maybeRunAutoSyncAfterDetailCapture = (...args) => controllerOperations.maybeRunAutoSyncAfterDetailCapture(...args);
  const releaseCaptureExecutionLock = (...args) => controllerOperations.releaseCaptureExecutionLock(...args);
  const releaseCaptureTaskOwner = (...args) => controllerOperations.releaseCaptureTaskOwner(...args);
  const renderCaptureRecoveryUI = (...args) => controllerOperations.renderCaptureRecoveryUI(...args);
  const resolveCaptureTaskSourceTabId = (...args) => controllerOperations.resolveCaptureTaskSourceTabId(...args);
  const resolveCaptureTaskTerminalStatus = (...args) => controllerOperations.resolveCaptureTaskTerminalStatus(...args);
  const routeDetailItemToStreamingSync = (...args) => controllerOperations.routeDetailItemToStreamingSync(...args);
  const runCaptureAction = (...args) => controllerOperations.runCaptureAction(...args);
  const sleepWithStop = (...args) => controllerOperations.sleepWithStop(...args);
  const startOptionalCaptureAssistSession = (...args) => controllerOperations.startOptionalCaptureAssistSession(...args);
  const supportsPersistentCaptureTaskPlatform = (...args) => controllerOperations.supportsPersistentCaptureTaskPlatform(...args);

  async function handleCaptureNoteData() {
    const runtime = getCurrentRuntime();
    const selectedPlatform = getViewPlatform(runtime);
    const pagePlatform = getPagePlatform(runtime);
    if (selectedPlatform !== pagePlatform) {
      const platformCopy = getPlatformCopy(selectedPlatform);
      showMessage(
        `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再采集`,
        "error",
      );
      return;
    }
    if (runtime?.pageType !== PAGE_TYPE.NOTE_DETAIL) {
      showMessage("请先切换到笔记/作品详情页", "error");
      return;
    }
    if (isNoteDetailPending(runtime)) {
      showMessage(resolveNoteDetailPendingText(runtime), "warning");
      return;
    }

    const settings = await getCaptureSettings();
    const currentPlatform = pagePlatform;
    const platformCapabilities = getPlatformCapabilities(currentPlatform);
    const hideBloggerMetricsToggle =
      shouldHideNoteBloggerMetricsToggle(selectedPlatform);
    const commentsConfigured = getCaptureCommentsChecked(settings);
    const includeComments = platformCapabilities.captureComments
      ? commentsConfigured
      : false;
    const enableCommentLeadsFilter =
      includeComments && getCommentLeadsFilterChecked(settings);
    const includeBloggerMetrics =
      !hideBloggerMetricsToggle && platformCapabilities.bloggerMetrics
        ? getCaptureBloggerMetricsChecked(settings)
        : false;
    let commentsMaxDetectedItems = settings.commentsMaxDetectedItems;
    if (includeComments) {
      commentsMaxDetectedItems = readRequiredCommentsMaxDetectedItemsFromInput();
      if (!commentsMaxDetectedItems) {
        showMessage("开启评论采集时，请填写评论探测上限（正整数）", "error");
        return;
      }
    }

    const taskContext = beginSidebarTask({
      taskType: "capture",
      featureKey: "capture.single_note",
      metadata: {
        platform: currentPlatform,
        pageType: runtime?.pageType || "",
        includeComments,
        includeBloggerMetrics,
        enableCommentLeadsFilter,
      },
    });
    let taskStatus = "completed";
    let taskError = null;

    showProgress(
      includeComments ? "正在采集笔记并准备评论任务..." : "正在采集笔记数据...",
    );

    try {
      const result = await captureNoteWithOptionalComments({
        includeComments,
        includeBloggerMetrics,
        enableCommentLeadsFilter,
        commentsMaxDetectedItems,
        detailNavTimeoutMs: settings.detailNavTimeoutMs,
        profileAfterNavWaitMs: settings.profileAfterNavWaitMs,
        onProgress: handleProgress,
      });

      if (result.recordId) {
        controllerState.activeCommentsCaptureRecordId = result.recordId;
      }

      if (result.ok) {
        if (result.phase === "note_ready") {
          showMessage("笔记采集成功，已加入缓存池", "success");
        } else if (result.phase === "comments_partial") {
          taskStatus = "partial";
          renderCaptureRecoveryUI({
            ...(result.commentsResult || {}),
            phase: "comments_partial",
            recordId: result.recordId,
            collectedCount: Number(result.commentsResult?.commentsCount || 0),
            captureAction: "captureComments",
            updatedAt: Date.now(),
          });
          showMessage(
            includeBloggerMetrics
              ? "笔记已入池，评论已手动停止并合并，博主指标已回填"
              : "笔记已入池，评论已手动停止并合并",
            "warning",
          );
        } else if (includeComments && includeBloggerMetrics) {
          showMessage(
            "笔记、评论与博主指标采集完成，已合并到同一条记录",
            "success",
          );
        } else if (includeBloggerMetrics) {
          showMessage("笔记与博主指标采集完成，已加入缓存池", "success");
        } else {
          showMessage("笔记与评论采集完成，已合并到同一条记录", "success");
        }
        await refreshDataPool();
        return;
      }

      if (result.noteReady || result.phase === "comments_failed") {
        taskStatus = "partial";
        const commentsFailed = Boolean(
          result.commentsResult && result.commentsResult.ok === false,
        );
        const metricsFailed = Boolean(
          result.bloggerMetricsResult && result.bloggerMetricsResult.ok === false,
        );
        if (commentsFailed) {
          renderCaptureRecoveryUI({
            phase: "comments_failed",
            recordId: result.recordId,
            captureAction: "captureComments",
            error: result.commentsResult?.error || null,
            updatedAt: Date.now(),
          });
        }
        if (commentsFailed && metricsFailed) {
          showMessage(
            "笔记已入池，评论与博主指标采集失败（可在记录卡片继续评论）",
            "warning",
          );
        } else if (commentsFailed) {
          showMessage("笔记已入池，评论采集失败，可在记录卡片继续评论", "warning");
        } else if (metricsFailed) {
          showMessage("笔记已入池，博主指标采集失败，不影响主流程", "warning");
        } else {
          showMessage("笔记已入池，存在可选增强项失败", "warning");
        }
        await refreshDataPool();
        return;
      }

      const rawErrorCode = String(result.error?.code || "").trim();
      const rawErrorMessage = String(result.error?.message || "").trim();
      const errorMsg =
        (rawErrorCode === "CAPTURE_FAILED" && rawErrorMessage) ||
        ERROR_MESSAGE_MAP[result.error?.code] ||
        rawErrorMessage ||
        "采集失败";
      taskStatus = "failed";
      showMessage(errorMsg, "error");
    } catch (error) {
      console.error(
        "[Sidebar] Capture note with optional comments failed:",
        error,
      );
      taskStatus = "failed";
      taskError = error;
      showMessage("操作失败: " + error.message, "error");
    } finally {
      controllerState.activeCommentsCaptureRecordId = "";
      controllerState.activeCommentsCaptureTabId = null;
      controllerState.activeCommentsCaptureRequestId = "";
      finishSidebarTask(taskContext, {
        status: taskStatus,
        error: taskError,
        metadata: {
          includeComments,
          includeBloggerMetrics,
        },
      });
      hideProgress();
    }
  }

  async function handleCaptureBloggerData() {
    const runtime = getCurrentRuntime();
    const selectedPlatform = getViewPlatform(runtime);
    const pagePlatform = getPagePlatform(runtime);
    if (selectedPlatform !== pagePlatform) {
      const platformCopy = getPlatformCopy(selectedPlatform);
      showMessage(
        `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再采集`,
        "error",
      );
      return;
    }
    if (runtime?.pageType !== PAGE_TYPE.BLOGGER_PROFILE) {
      showMessage("请先切换到博主主页", "error");
      return;
    }
    const taskContext = beginSidebarTask({
      taskType: "capture",
      featureKey: "capture.blogger",
      metadata: {
        platform: pagePlatform,
        pageType: runtime?.pageType || "",
      },
    });
    let taskStatus = "completed";
    let taskError = null;
    let executionLock = null;
    let captureTaskSessionStarted = false;
    showProgress("正在采集博主信息...");

    try {
      executionLock = await acquireCaptureExecutionLock({
        owner: "manual_blogger_capture",
        label: "博主主页采集",
      });
      if (!executionLock) {
        taskStatus = "skipped";
        return;
      }
      if (supportsPersistentCaptureTaskPlatform(pagePlatform)) {
        const sourceTabId = await resolveCaptureTaskSourceTabId({
          platform: pagePlatform,
        });
        const assistSession = await startOptionalCaptureAssistSession({
          taskId: taskContext.taskId,
          tabId: sourceTabId,
          label: "博主主页采集",
          platform: pagePlatform,
        });
        captureTaskSessionStarted = assistSession?.active === true;
      }

      const profileResult = await captureAndSync({
        mode: "blogger_profile",
        onProgress: handleProgress,
        autoSync: false,
      });

      if (!profileResult.ok) {
        const errorMsg =
          ERROR_MESSAGE_MAP[profileResult.error?.code] ||
          profileResult.error?.message ||
          "博主信息采集失败";
        showMessage(errorMsg, "error");
        taskStatus = "failed";
        return;
      }

      showProgress("正在采集博主笔记...");
      const settings = resolveCurrentDetailCaptureSettings(
        await getCaptureSettings(),
      );
      const bloggerMinLikes = readBloggerMinLikesFromInput(
        settings.bloggerMinLikes,
      );
      const bloggerMaxDetectedItems = readBloggerMaxDetectedItemsFromInput(
        settings.bloggerMaxDetectedItems,
      );
      const bloggerKeywordFilter = readBloggerKeywordFilterFromInput();

      const notesResult = await captureAndSync({
        mode: "blogger_notes",
        onProgress: handleProgress,
        autoSync: false,
        captureParams: {
          profileMetrics: profileResult.captureResult?.data || {},
          minLikes: bloggerMinLikes,
          maxDetectedItems: bloggerMaxDetectedItems,
          keywordFilter: bloggerKeywordFilter,
          waitMinMs: settings.sharedWaitMinMs,
          waitMaxMs: settings.sharedWaitMaxMs,
          stallTimeoutMs: settings.sharedStallTimeoutMs,
          maxDurationMs: settings.sharedMaxDurationMs,
        },
      });

      if (!notesResult.ok) {
        const errorMsg =
          ERROR_MESSAGE_MAP[notesResult.error?.code] ||
          notesResult.error?.message ||
          "博主笔记采集失败";
        showMessage(errorMsg, "error");
        taskStatus = "failed";
        return;
      }

      const notesPayload = notesResult.captureResult?.data || {};
      const filteredCount = Number(notesPayload.filteredCount || 0);
      const rawCount = Number(notesPayload.rawTotalCount || filteredCount);
      let successMsg = `博主信息与笔记采集成功：滚动探测 ${rawCount} 条，入池 ${filteredCount} 条（点赞≥${bloggerMinLikes}`;
      if (bloggerKeywordFilter) {
        successMsg += `，关键词"${bloggerKeywordFilter}"`;
      }
      successMsg += `，探测上限 ${bloggerMaxDetectedItems}）`;
      showMessage(successMsg, "success");
      await refreshDataPool();
      const enhanceResult = await maybeRunAutoDetailCaptureAfterListCapture(
        resolveCurrentDetailCaptureSettings(await getCaptureSettings()),
        {
          sourceLabel: "博主笔记",
          recordIds: notesResult.recordIds,
          captureTaskId: captureTaskSessionStarted ? taskContext.taskId : "",
        },
      );
      if (enhanceResult?.securityBlocked || enhanceResult?.canceled) {
        taskStatus = "partial";
      } else if (enhanceResult && enhanceResult.ok === false) {
        taskStatus = "completed_with_failures";
      }
    } catch (error) {
      console.error("[Sidebar] Capture blogger failed:", error);
      taskStatus = "failed";
      taskError = error;
      showMessage("操作失败: " + error.message, "error");
    } finally {
      const terminal = resolveCaptureTaskTerminalStatus({
        taskStatus,
        error: taskError,
      });
      if (captureTaskSessionStarted) {
        const captureTaskEnd = await endCaptureTaskSession({
          taskId: taskContext.taskId,
          ...terminal,
        });
        if (captureTaskEnd?.ok === true) {
          releaseCaptureTaskOwner(taskContext.taskId);
        }
      }
      if (executionLock) {
        await releaseCaptureExecutionLock(executionLock.id);
      }
      finishSidebarTask(taskContext, {
        status: taskStatus,
        error: taskError,
        metadata: {
          platform: pagePlatform,
        },
      });
      hideProgress();
    }
  }

  function hasActiveSearchFilters(searchFilters = {}) {
    return Object.values(searchFilters || {}).some((value) =>
      Boolean(String(value || "").trim()),
    );
  }

  async function applySearchFiltersOnActiveTab(tabId, searchFilters = {}) {
    if (!hasActiveSearchFilters(searchFilters) || !Number.isFinite(Number(tabId))) return;
    try {
      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE.RELAY_TO_CONTENT,
        tabId: Number(tabId),
        payload: { action: "applyBatchSearchFilters", ...searchFilters },
      });
    } catch (error) {
      console.warn("[Sidebar] 搜索页筛选切换失败(不影响采集):", error);
    }
  }

  function getSearchBatchKeywordsFromTextarea() {
    return String(taskView.readSearchBatchKeywordsText() || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function handleCaptureSearchData() {
    const runtime = getCurrentRuntime();
    const selectedPlatform = getViewPlatform(runtime);
    const pagePlatform = getPagePlatform(runtime);
    if (selectedPlatform !== pagePlatform) {
      const platformCopy = getPlatformCopy(selectedPlatform);
      showMessage(
        `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再采集`,
        "error",
      );
      return;
    }
    if (runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS) {
      showMessage("请先切换到搜索页", "error");
      return;
    }

    const platformCapabilities = getPlatformCapabilities(pagePlatform);
    if (!platformCapabilities.captureSearch) {
      showMessage("当前平台暂不支持搜索结果采集", "warning");
      return;
    }

    let activeTabUrl = runtime?.lastPageUrl || "";
    let searchActiveTabId = null;
    try {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (tab?.url) {
        activeTabUrl = tab.url;
      }
      if (tab?.id != null) searchActiveTabId = tab.id;
    } catch {
      // ignore and fallback to runtime url
    }

    // 批量多词模式:从文本框读多个关键词;否则单词:从当前搜索页读
    const searchBatchMode = taskView.readSearchBatchMode();
    let searchKeywords = [];
    let keyword = "";
    if (searchBatchMode) {
      const rawKw = getSearchBatchKeywordsFromTextarea();
      if (rawKw.length === 0) {
        showMessage("请输入至少一个关键词（每行一个）", "warning");
        return;
      }
      if (rawKw.length > MAX_BATCH_KEYWORDS) {
        showMessage(`单次最多批量采集 ${MAX_BATCH_KEYWORDS} 个关键词`, "warning");
        return;
      }
      searchKeywords = dedupeKeywords(rawKw);
      keyword = searchKeywords[0];
    } else {
      keyword = extractKeywordFromUrl(activeTabUrl);
      if (!keyword) {
        showMessage(
          "当前页面未检测到关键词。请先在搜索页输入关键词并点击搜索后再采集",
          "warning",
        );
        return;
      }
      searchKeywords = [keyword];
    }

    const taskContext = beginSidebarTask({
      taskType: "capture",
      featureKey: "capture.search",
      metadata: {
        platform: pagePlatform,
        pageType: runtime?.pageType || "",
        keyword,
      },
    });
    let taskStatus = "completed";
    let taskError = null;
    let executionLock = null;
    let streamingSyncQueue = null;
    let streamingSyncResult = null;
    let streamingSyncDrained = false;
    let captureTaskSessionStarted = false;
    let persistentCaptureTaskId = "";

    try {
      const settings = resolveCurrentDetailCaptureSettings(
        await getCaptureSettings(),
      );
      streamingSyncQueue = createStreamingDetailAutoSyncQueue(settings, {
        shouldStop: () => controllerState.searchCaptureCancelRequested,
      });
      if (
        settings.autoDetailCaptureAfterListCapture &&
        !ensureAuthVerifiedOrWarn({
          message: PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
        })
      ) {
        taskStatus = "skipped";
        return;
      }
      executionLock = await acquireCaptureExecutionLock({
        owner: "manual_search_capture",
        label: searchBatchMode ? "手动批量关键词采集" : "手动搜索页采集",
      });
      if (!executionLock) {
        taskStatus = "skipped";
        return;
      }
      const sortContext = await syncKeywordSortDimensionFromPage({
        force: true,
        fallbackDimension: controllerState.keywordSortDimension,
      });
      const sortLabel = getKeywordSortDimensionLabel(sortContext.dimension);
      const keywordMinLikes = readKeywordMinLikesFromInput(
        settings.keywordMinLikes,
      );
      const keywordMaxDetectedItems = readKeywordMaxDetectedItemsFromInput(
        settings.keywordMaxDetectedItems,
      );

      // 搜索页手动采集只负责本次执行；无人值守轮次由计划流程读取。
      controllerState.searchCaptureCancelRequested = false;
      const searchFilters = collectSearchFiltersFromControls("search");
      const searchAutoLoop = false;

      // 手动延迟启动:只支持今天的 HH:mm,老版本 datetime-local 值仍兼容。
      const searchScheduledStr = taskView.readSearchScheduledStart();
      const scheduledStart = parseSearchManualScheduledStart(searchScheduledStr);
      if (scheduledStart) {
        const {targetMs, label: targetLabel} = scheduledStart;
        if (!Number.isFinite(targetMs)) {
          taskStatus = "skipped";
          showMessage("当天延迟启动时间格式不正确", "warning");
          return;
        }
        if (targetMs <= Date.now()) {
          taskStatus = "skipped";
          showMessage("当天延迟启动时间已过，请选择稍后的时间或留空立即采集", "warning");
          return;
        }
        if (targetMs > Date.now()) {
          let lastSec = -1;
          await sleepWithStop(targetMs - Date.now(), () => {
            if (controllerState.searchCaptureCancelRequested) return true;
            const remain = Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
            if (remain !== lastSec) {
              lastSec = remain;
              const h = Math.floor(remain / 3600);
              const m = Math.floor((remain % 3600) / 60);
              const s = remain % 60;
              showProgress(`⏰ 定时采集:将于 ${targetLabel} 开始(还剩 ${h > 0 ? h + "时" : ""}${m}分${s}秒)`, "info");
            }
            return false;
          });
          if (controllerState.searchCaptureCancelRequested) {
            taskStatus = "skipped";
            showMessage("已取消定时采集", "warning");
            return;
          }
        }
      }

      if (supportsPersistentCaptureTaskPlatform(pagePlatform)) {
        const sourceTabId = await resolveCaptureTaskSourceTabId({
          preferredTabId: searchActiveTabId,
          platform: pagePlatform,
        });
        const assistSession = await startOptionalCaptureAssistSession({
          taskId: taskContext.taskId,
          tabId: sourceTabId,
          label: searchBatchMode
            ? `批量搜索采集 · ${searchKeywords.length} 个关键词`
            : `搜索「${keyword}」`,
          platform: pagePlatform,
        });
        captureTaskSessionStarted = assistSession?.active === true;
        // The task id below is only for the optional native assist lifecycle.
        // When that assist cannot start, list/detail collection must run without
        // task grouping instead of treating the missing Debug session as fatal.
        persistentCaptureTaskId = captureTaskSessionStarted
          ? taskContext.taskId
          : "";
      }

      let searchRound = 0;
      do {
        searchRound += 1;
        if (searchBatchMode) {
          // 批量多词:逐词在 runner tab(=当前 tab)采,排序/发布时间由 batchCaptureByKeywords 内部逐词应用
          controllerState.activeBatchRunnerTabId = searchActiveTabId ? Number(searchActiveTabId) : null;
          const runSearchBatchAttempt = (attemptKeywords) =>
            batchCaptureByKeywords({
            keywords: [...attemptKeywords],
            platform: pagePlatform,
            baseSearchUrl: activeTabUrl,
            captureTaskId: captureTaskSessionStarted
              ? persistentCaptureTaskId
              : "",
            searchFilters,
            captureParams: {
              minLikes: keywordMinLikes,
              sortDimension: sortContext.dimension,
              maxDetectedItems: keywordMaxDetectedItems,
              waitMinMs: settings.sharedWaitMinMs,
              waitMaxMs: settings.sharedWaitMaxMs,
              stallTimeoutMs: settings.sharedStallTimeoutMs,
              maxDurationMs: settings.sharedMaxDurationMs,
            },
            afterKeywordCapture: settings.autoDetailCaptureAfterListCapture
              ? async ({keyword: capturedKeyword, recordIds}) => {
                  await refreshDataPool();
                  const currentDetailSettings =
                    resolveCurrentDetailCaptureSettings(
                      await getCaptureSettings(),
                    );
                  let enhanceResult = null;
                  try {
                    enhanceResult = await maybeRunAutoDetailCaptureAfterListCapture(
                      currentDetailSettings,
                      {
                        sourceLabel: `关键词「${capturedKeyword}」搜索结果`,
                        recordIds,
                        relevanceKeyword: capturedKeyword,
                        captureTaskId: captureTaskSessionStarted
                          ? persistentCaptureTaskId
                          : "",
                        onItemSettled: streamingSyncQueue?.enabled
                          ? (progress) =>
                              routeDetailItemToStreamingSync(
                                streamingSyncQueue,
                                progress,
                                {
                                  sourceLabel: `关键词「${capturedKeyword}」笔记`,
                                },
                              )
                          : null,
                      },
                    );
                  } finally {
                    if (streamingSyncQueue?.enabled) {
                      streamingSyncQueue.enqueueMissing(recordIds, {
                        sourceLabel: `关键词「${capturedKeyword}」笔记`,
                      });
                    }
                  }
                  if (enhanceResult?.securityBlocked) {
                    // 撞小红书风控:停掉整轮无人值守,别再往下跑(越跑越死)
                    controllerState.searchCaptureCancelRequested = true;
                    taskStatus = "partial";
                    showMessage(
                      "⚠️ 触发小红书安全限制(访问频繁),已停止无人值守。建议隔较长时间(数小时)再跑。",
                      "warning",
                    );
                    return {...enhanceResult, canceled: true};
                  }
                  if (enhanceResult?.canceled) {
                    controllerState.searchCaptureCancelRequested = true;
                    taskStatus = "partial";
                    return enhanceResult;
                  }
                  if (enhanceResult && enhanceResult.ok === false) {
                    taskStatus = "completed_with_failures";
                  }
                  const syncResult = streamingSyncQueue?.enabled
                    ? null
                    : await maybeRunAutoSyncAfterDetailCapture(
                        currentDetailSettings,
                        {
                          sourceLabel: `关键词「${capturedKeyword}」搜索结果`,
                          recordIds,
                          shouldStop: () => controllerState.searchCaptureCancelRequested,
                        },
                      );
                  if (syncResult && syncResult.ok === false) {
                    taskStatus = "completed_with_failures";
                  }
                  return enhanceResult;
                }
              : null,
            onProgress: (p) => {
              handleProgress(p);
              showProgress(
                searchAutoLoop
                  ? appendStreamingSyncSummary(
                      `第 ${searchRound} 轮 · ${p?.message || ""}`,
                      streamingSyncQueue,
                    )
                  : appendStreamingSyncSummary(
                      p?.message || "正在批量采集...",
                      streamingSyncQueue,
                    ),
                "info",
              );
            },
            shouldStop: () => controllerState.searchCaptureCancelRequested,
          });
          const searchBatchAttemptRun = await runUnattendedKeywordAttempts({
            allKeywords: [...searchKeywords],
            initialPendingKeywords: [...searchKeywords],
            maxAttempts: pagePlatform === "douyin" ? 2 : 1,
            runAttempt: ({keywords: attemptKeywords}) =>
              runSearchBatchAttempt(attemptKeywords),
            onRetryScheduled:
              pagePlatform === "douyin"
                ? async ({keywords: retryKeywords, attempt}) => {
                    const retryDelay =
                      UNATTENDED_KEYWORD_RETRY_MIN_MS +
                      Math.random() *
                        (UNATTENDED_KEYWORD_RETRY_MAX_MS -
                          UNATTENDED_KEYWORD_RETRY_MIN_MS);
                    showProgress(
                      `${Math.ceil(retryDelay / 1000)} 秒后重试 ${retryKeywords.length} 个搜索失败的关键词（第 ${attempt}/2 次）`,
                      "info",
                    );
                    await sleepWithStop(
                      retryDelay,
                      () => controllerState.searchCaptureCancelRequested,
                    );
                  }
                : null,
            shouldStop: () => controllerState.searchCaptureCancelRequested,
          });
          const batchResult = searchBatchAttemptRun.result;
          await refreshDataPool();
          if (batchResult?.canceled) {
            taskStatus = "partial";
            controllerState.searchCaptureCancelRequested = true;
          } else {
            if ((batchResult?.stats?.failed || 0) > 0) {
              taskStatus = "completed_with_failures";
            }
          }
        } else {
          // 单词:在当前页切筛选 + 单次采集
          if (hasActiveSearchFilters(searchFilters)) {
            await applySearchFiltersOnActiveTab(searchActiveTabId, searchFilters);
            await sleepWithStop(1500, () => controllerState.searchCaptureCancelRequested);
          }
          const actionResult = await runCaptureAction({
            mode: "keyword",
            captureParams: {
              keyword,
              minLikes: keywordMinLikes,
              sortDimension: sortContext.dimension,
              maxDetectedItems: keywordMaxDetectedItems,
              waitMinMs: settings.sharedWaitMinMs,
              waitMaxMs: settings.sharedWaitMaxMs,
              stallTimeoutMs: settings.sharedStallTimeoutMs,
              maxDurationMs: settings.sharedMaxDurationMs,
            },
            progressMessage: searchAutoLoop
              ? `第 ${searchRound} 轮 · 正在采集搜索结果（关键词：${keyword}）...`
              : `正在采集搜索结果（关键词：${keyword}）...`,
            successMessage: `搜索笔记采集成功，已加入缓存池（${sortLabel}≥${keywordMinLikes}，探测上限 ${keywordMaxDetectedItems}）`,
            keepProgressOpen: true,
          });

          if (actionResult?.ok) {
            const currentDetailSettings = resolveCurrentDetailCaptureSettings(
              await getCaptureSettings(),
            );
            let enhanceResult = null;
            try {
              enhanceResult = await maybeRunAutoDetailCaptureAfterListCapture(
                currentDetailSettings,
                {
                  sourceLabel: "搜索结果",
                  recordIds: actionResult.recordIds,
                  relevanceKeyword: keyword,
                  captureTaskId: captureTaskSessionStarted
                    ? persistentCaptureTaskId
                    : "",
                  onItemSettled: streamingSyncQueue?.enabled
                    ? (progress) =>
                        routeDetailItemToStreamingSync(
                          streamingSyncQueue,
                          progress,
                          {sourceLabel: "搜索结果笔记"},
                        )
                    : null,
                },
              );
            } finally {
              if (streamingSyncQueue?.enabled) {
                streamingSyncQueue.enqueueMissing(actionResult.recordIds, {
                  sourceLabel: "搜索结果笔记",
                });
              }
            }
            if (enhanceResult?.securityBlocked) {
              controllerState.searchCaptureCancelRequested = true;
              taskStatus = "partial";
              showMessage("⚠️ 触发小红书安全限制(访问频繁),已停止无人值守。建议隔较长时间(数小时)再跑。", "warning");
            } else if (enhanceResult?.canceled) {
              taskStatus = "partial";
              controllerState.searchCaptureCancelRequested = true;
            } else if (enhanceResult && enhanceResult.ok === false) {
              taskStatus = "completed_with_failures";
            }
            if (!enhanceResult?.securityBlocked && !enhanceResult?.canceled) {
              const syncResult = streamingSyncQueue?.enabled
                ? null
                : await maybeRunAutoSyncAfterDetailCapture(
                    currentDetailSettings,
                    {
                      sourceLabel: "搜索结果",
                      recordIds: actionResult.recordIds,
                      shouldStop: () => controllerState.searchCaptureCancelRequested,
                    },
                  );
              if (syncResult && syncResult.ok === false) {
                taskStatus = "completed_with_failures";
              }
            }
          } else if (controllerState.searchCaptureCancelRequested) {
            taskStatus = "partial";
          } else {
            taskStatus = "failed";
          }
        }

        // 手动采集只跑一次；批量多词的逐词执行由 batchCaptureByKeywords 负责。
        if (controllerState.searchCaptureCancelRequested || !searchAutoLoop) {
          break;
        }
      } while (!controllerState.searchCaptureCancelRequested);

      streamingSyncResult = await drainStreamingDetailSyncQueue(
        streamingSyncQueue,
        {
          round: searchRound,
          updateProgress: (progress) => showProgress(progress.message, "info"),
        },
      );
      streamingSyncDrained = true;
      if (Number(streamingSyncResult?.failedCount || 0) > 0) {
        taskStatus = "completed_with_failures";
      }
      const streamingSyncNotice = buildStreamingSyncCompletionNotice(
        streamingSyncResult,
        {enabled: streamingSyncQueue?.enabled},
      );
      if (streamingSyncNotice) {
        showMessage(streamingSyncNotice.message, streamingSyncNotice.tone);
      }

      if (searchAutoLoop) {
        showMessage(
          `无人值守搜索采集${controllerState.searchCaptureCancelRequested ? "已停止" : "结束"}:共跑 ${searchRound} 轮`,
          controllerState.searchCaptureCancelRequested || isStreamingSyncReconciliationRequired(streamingSyncResult)
            ? "warning"
            : "success",
        );
      }
    } catch (error) {
      console.error("[Sidebar] Capture search failed:", error);
      taskStatus = "failed";
      taskError = error;
      showMessage("操作失败: " + error.message, "error");
    } finally {
      if (streamingSyncQueue?.enabled && !streamingSyncDrained) {
        streamingSyncResult = await drainStreamingDetailSyncQueue(
          streamingSyncQueue,
        ).catch((error) => {
          console.warn("[Sidebar] Drain manual streaming sync failed:", error);
          return streamingSyncQueue.getStats();
        });
      }
      if (streamingSyncResult?.canceled && taskStatus === "completed") {
        taskStatus = "partial";
      }
      const streamingSyncTaskIssue = buildStreamingSyncTaskIssue(
        streamingSyncResult,
      );
      if (
        streamingSyncTaskIssue &&
        !controllerState.searchCaptureCancelRequested &&
        taskStatus !== "failed"
      ) {
        taskStatus = "completed_with_failures";
        taskError = taskError || streamingSyncTaskIssue;
      }
      const terminal = resolveCaptureTaskTerminalStatus({
        taskStatus,
        error: taskError,
        canceled: controllerState.searchCaptureCancelRequested,
      });
      if (captureTaskSessionStarted) {
        const captureTaskEnd = await endCaptureTaskSession({
          taskId: taskContext.taskId,
          ...terminal,
        });
        if (captureTaskEnd?.ok === true) {
          releaseCaptureTaskOwner(taskContext.taskId);
        }
      }
      finishSidebarTask(taskContext, {
        status: taskStatus,
        error: taskError,
        metadata: {
          platform: pagePlatform,
          keyword,
          ...buildStreamingSyncTaskMetadata(streamingSyncResult),
        },
      });
      hideProgress();
      controllerState.searchCaptureCancelRequested = false;
      controllerState.activeBatchRunnerTabId = null;
      if (executionLock) {
        await releaseCaptureExecutionLock(executionLock.id);
      }
    }
  }

  return Object.freeze({
    handleCaptureNoteData,
    handleCaptureBloggerData,
    hasActiveSearchFilters,
    applySearchFiltersOnActiveTab,
    getSearchBatchKeywordsFromTextarea,
    handleCaptureSearchData,
  });
}
