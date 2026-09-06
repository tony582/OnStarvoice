// L3-B keyword-analysis: explicit application responsibility.
export function createKeywordAnalysisController({controllerState, controllerPorts, controllerOperations}) {
  const {
    KEYWORD_ANALYSIS_STALE_LOCK_MS,
    KEYWORD_INSIGHT_ANALYSIS_COST_CREDITS,
    MESSAGE_TYPE,
    PAGE_TYPE,
    analyzeKeywords,
    chrome,
    console,
    detectPlatformFromUrl,
    ensureAuthVerifiedOrWarn,
    formatKeywordStrategyAccessError,
    getCurrentRuntime,
    getKeywordInsightAuthRequiredMessage,
    getPagePlatform,
    hideProgress,
    lightSampleByKeywords,
    refreshVerifiedAuthSnapshot,
    showMessage,
    showProgress,
  } = controllerPorts;
  const createEmptyKeywordInsightState = (...args) => controllerOperations.createEmptyKeywordInsightState(...args);
  const dedupeKeywords = (...args) => controllerOperations.dedupeKeywords(...args);
  const getBatchDraftForPlatform = (...args) => controllerOperations.getBatchDraftForPlatform(...args);
  const getKeywordInsightSeedKeyword = (...args) => controllerOperations.getKeywordInsightSeedKeyword(...args);
  const getKeywordInsightState = (...args) => controllerOperations.getKeywordInsightState(...args);
  const persistBatchDraftForPlatform = (...args) => controllerOperations.persistBatchDraftForPlatform(...args);
  const persistCurrentBatchDraft = (...args) => controllerOperations.persistCurrentBatchDraft(...args);
  const stopKeywordSortSyncTimer = (...args) => controllerOperations.stopKeywordSortSyncTimer(...args);
  const syncKeywordSortDimensionByRuntime = (...args) => controllerOperations.syncKeywordSortDimensionByRuntime(...args);
  const updateKeywordInsightState = (...args) => controllerOperations.updateKeywordInsightState(...args);
  const renderExpandedKeywords = (...args) => controllerPorts.taskView.renderExpandedKeywords(...args);
  const renderKeywordInsightState = (...args) => controllerPorts.taskView.renderKeywordInsightState(...args);
  const updateExpandKeywordsButtonState = (...args) => controllerPorts.taskView.updateExpandKeywordsButtonState(...args);

  function getSelectedRecommendedKeywords(draft = getKeywordInsightState()) {
    return Array.isArray(draft.selectedKeywords)
      ? [...draft.selectedKeywords]
      : [];
  }
  function invalidateKeywordInsightDraft(platform = "") {
    controllerState.keywordInsightRunToken += 1;
    controllerState.keywordAnalysisInFlight = false;
    controllerState.keywordAnalysisStartedAt = 0;
    controllerState.keywordInsightSampleInFlight = false;
    const currentDraft = getBatchDraftForPlatform(platform);
    updateKeywordInsightState(
      {
        ...createEmptyKeywordInsightState(),
        analysisVersion: (currentDraft.analysisVersion || 0) + 1,
      },
      platform,
    );
  }
  function clearKeywordInsightResult({showFeedback = true} = {}) {
    const hasAnything = controllerState.expandedKeywordsBuffer.length > 0;
    if (!hasAnything) {
      return;
    }

    controllerState.expandedKeywordsBuffer = [];
    controllerPorts.taskView.setExpandedKeywordsVisible(false);
    invalidateKeywordInsightDraft();
    renderKeywordInsightState();
    persistCurrentBatchDraft();
    updateExpandKeywordsButtonState();
    if (showFeedback) {
      showMessage("已清空扩展词和分析结果", "success");
    }
  }
  function isKeywordAnalysisLockStale() {
    if (!controllerState.keywordAnalysisInFlight || controllerState.keywordAnalysisStartedAt <= 0) {
      return false;
    }
    return Date.now() - controllerState.keywordAnalysisStartedAt > KEYWORD_ANALYSIS_STALE_LOCK_MS;
  }
  function releaseKeywordAnalysisLock() {
    controllerState.keywordAnalysisInFlight = false;
    controllerState.keywordAnalysisStartedAt = 0;
  }
  function updateCategorySampleResult(categoryId, result) {
    const draft = getKeywordInsightState();
    updateKeywordInsightState({
      sampleStatusByCategoryId: {
        ...draft.sampleStatusByCategoryId,
        [categoryId]: result?.status === "success" ? "success" : "error",
      },
      sampleResultsByCategoryId: {
        ...draft.sampleResultsByCategoryId,
        [categoryId]: result,
      },
    });
    renderKeywordInsightState();
    persistCurrentBatchDraft();
  }
  async function runKeywordInsightSampling({
    analysisResult,
    baseSearchUrl,
    runToken,
  }) {
    const categories = Array.isArray(analysisResult?.categories)
      ? analysisResult.categories
      : [];
    if (categories.length === 0) {
      return;
    }

    controllerState.keywordInsightSampleInFlight = true;
    const sampleStatusByCategoryId = {};
    categories.forEach((category) => {
      sampleStatusByCategoryId[category.id] = "loading";
    });
    updateKeywordInsightState({
      sampleStatusByCategoryId,
      sampleResultsByCategoryId: {},
    });
    renderKeywordInsightState();
    persistCurrentBatchDraft();

    try {
      const runtime = getCurrentRuntime();
      const pagePlatform = getPagePlatform(runtime);
      await lightSampleByKeywords({
        categorySamples: categories.map((category) => {
          const candidates =
            Array.isArray(category.sampleCandidateKeywords) &&
            category.sampleCandidateKeywords.length > 0
              ? category.sampleCandidateKeywords
              : Array.isArray(category.keywords) && category.keywords.length > 0
                ? [category.keywords[0]]
                : [];
          return {
            categoryId: category.id,
            candidateKeywords: candidates,
          };
        }),
        platform: pagePlatform,
        baseSearchUrl,
        onProgress: (progress) => {
          if (runToken !== controllerState.keywordInsightRunToken) {
            return;
          }
          if (progress?.phase === "category_done" && progress?.result) {
            updateCategorySampleResult(progress.categoryId, progress.result);
          }
        },
        shouldStop: () => runToken !== controllerState.keywordInsightRunToken,
      });
    } catch (error) {
      console.warn("[Sidebar] Keyword insight sampling failed:", error);
    } finally {
      if (runToken === controllerState.keywordInsightRunToken) {
        controllerState.keywordInsightSampleInFlight = false;
        renderKeywordInsightState();
      }
    }
  }
  async function startKeywordAnalysis({force = false} = {}) {
    if (controllerState.keywordAnalysisInFlight) {
      if (force && isKeywordAnalysisLockStale()) {
        console.warn(
          "[Sidebar] Keyword analysis lock stale, force releasing lock",
        );
        releaseKeywordAnalysisLock();
        renderKeywordInsightState();
      } else {
        return;
      }
    }

    const seedKeyword = getKeywordInsightSeedKeyword({preferStored: true});
    if (!seedKeyword) {
      if (force) {
        showMessage(
          "未检测到页面回填关键词，请先进入搜索结果页后再重试",
          "warning",
        );
      }
      return;
    }
    if (controllerState.expandedKeywordsBuffer.length === 0) {
      if (force) {
        showMessage("未检测到扩展词，请先扩词后再重试", "warning");
      }
      return;
    }
    if (
      !ensureAuthVerifiedOrWarn({
        message: getKeywordInsightAuthRequiredMessage(),
      })
    ) {
      return;
    }

    const draft = getKeywordInsightState();
    if (!force && draft.analysisStatus === "success" && draft.analysisResult) {
      renderKeywordInsightState();
      return;
    }

    controllerState.keywordAnalysisInFlight = true;
    controllerState.keywordAnalysisStartedAt = Date.now();
    controllerState.keywordInsightRunToken += 1;
    const runToken = controllerState.keywordInsightRunToken;

    updateKeywordInsightState({
      analysisVersion: (draft.analysisVersion || 0) + 1,
      analysisStatus: "loading",
      analysisErrorMessage: "",
      analysisResult: null,
      selectedCategoryIds: [],
      sampleStatusByCategoryId: {},
      sampleResultsByCategoryId: {},
    });
    renderKeywordInsightState();
    persistCurrentBatchDraft();

    try {
      const runtime = getCurrentRuntime();
      const pagePlatform = getPagePlatform(runtime);
      let baseSearchUrl = runtime?.lastPageUrl || "";
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tab?.url) {
          baseSearchUrl = tab.url;
        }
      } catch {
        // ignore
      }

      const analysisKeywords = dedupeKeywords(
        controllerState.expandedKeywordsBuffer
          .map((item) => String(item || "").trim())
          .filter(Boolean),
      );
      const dedupedCount =
        controllerState.expandedKeywordsBuffer.length - analysisKeywords.length;
      if (dedupedCount > 0) {
        showMessage(
          `分析前已去重 ${dedupedCount} 个重复词，实际分析 ${analysisKeywords.length} 个词`,
          "warning",
        );
      }

      const response = await analyzeKeywords({
        seedKeyword,
        keywords: analysisKeywords,
        platform: pagePlatform,
      });
      if (!response?.ok || !response?.data) {
        const requestError = new Error(
          response?.error?.message || response?.message || "智能分析暂时不可用",
        );
        requestError.reason =
          response?.error?.reason || response?.reason || "server_error";
        requestError.data = response?.error?.data || response?.data || null;
        throw requestError;
      }
      if (runToken !== controllerState.keywordInsightRunToken) {
        return;
      }

      const analysisResult = response.data;

      updateKeywordInsightState({
        analysisStatus: "success",
        analysisErrorMessage: "",
        analysisResult,
        selectedCategoryIds: [],
        selectedKeywords: [],
        sampleStatusByCategoryId: {},
        sampleResultsByCategoryId: {},
      });
      renderKeywordInsightState();
      persistCurrentBatchDraft();

      if (runToken === controllerState.keywordInsightRunToken) {
        await runKeywordInsightSampling({
          analysisResult,
          baseSearchUrl,
          runToken,
        });
      }
    } catch (error) {
      if (runToken !== controllerState.keywordInsightRunToken) {
        return;
      }
      const errorReason = String(error?.reason || "")
        .trim()
        .toLowerCase();
      if (errorReason === "insufficient_balance") {
        const requiredCredits = Number(error?.data?.requiredCredits);
        const requiredCreditsLabel =
          Number.isInteger(requiredCredits) && requiredCredits > 0
            ? requiredCredits
            : KEYWORD_INSIGHT_ANALYSIS_COST_CREDITS;
        updateKeywordInsightState({
          analysisStatus: "idle",
          analysisErrorMessage: "",
          analysisResult: null,
          selectedCategoryIds: [],
          selectedKeywords: [],
          sampleStatusByCategoryId: {},
          sampleResultsByCategoryId: {},
        });
        renderKeywordInsightState();
        persistCurrentBatchDraft();
        showMessage(
          `配额不足：不影响采集扩展词，但智能分析需 ${requiredCreditsLabel} 配额。获取更多配额后可继续完整分析。`,
          "warning",
        );
        void refreshVerifiedAuthSnapshot();
        return;
      }
      const formattedError = formatKeywordStrategyAccessError(
        error,
        getKeywordInsightAuthRequiredMessage(),
      );
      const rawErrorMessage =
        formattedError.message || "智能分析暂时不可用，已保留扩展词，可稍后重试";
      const isTimeoutError =
        formattedError.kind === "generic" &&
        /timeout/i.test(String(rawErrorMessage));
      const displayMessage = isTimeoutError
        ? "请求超时（模型响应较慢或服务繁忙），可稍后重试"
        : rawErrorMessage;
      updateKeywordInsightState({
        analysisStatus: "error",
        analysisErrorMessage: displayMessage,
        analysisResult: null,
        selectedCategoryIds: [],
        sampleStatusByCategoryId: {},
        sampleResultsByCategoryId: {},
      });
      renderKeywordInsightState();
      persistCurrentBatchDraft();
      showMessage(`智能分析不可用：${displayMessage}`, "warning");
    } finally {
      if (runToken === controllerState.keywordInsightRunToken) {
        releaseKeywordAnalysisLock();
        renderKeywordInsightState();
      }
    }
  }
  async function retryKeywordAnalysis() {
    if (controllerState.keywordAnalysisInFlight && !isKeywordAnalysisLockStale()) {
      showMessage("智能分析进行中，请稍候", "warning");
      return;
    }
    if (controllerState.keywordAnalysisInFlight && isKeywordAnalysisLockStale()) {
      releaseKeywordAnalysisLock();
    }
    await startKeywordAnalysis({force: true});
  }
  async function handleExpandKeywords() {
    if (controllerState.keywordExpandInFlight) {
      await requestKeywordExpandCancel();
      return;
    }

    const runtime = getCurrentRuntime();
    const seedKeyword = getKeywordInsightSeedKeyword({runtime});
    if (!seedKeyword) {
      showMessage(
        "仅支持分析当前页面回填的关键词，请先进入搜索结果页",
        "warning",
      );
      return;
    }

    if (runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS) {
      showMessage("请先切换到搜索页", "error");
      return;
    }

    controllerState.keywordExpandInFlight = true;
    controllerState.keywordExpandCancelRequested = false;
    updateExpandKeywordsButtonState();

    // 扩词期间暂停排序检测轮询，避免频繁消息影响搜索框状态。
    stopKeywordSortSyncTimer();

    try {
      showProgress(`正在扩展关键词「${seedKeyword}」...`);

      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (!tab?.id) {
        showMessage("未找到当前活动标签页", "error");
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE.RELAY_TO_CONTENT,
        tabId: tab.id,
        payload: {
          action: "expandKeywordSuggestions",
          seedKeyword,
          platform: detectPlatformFromUrl(tab.url || ""),
        },
      });

      const expandResult =
        response?.data &&
        typeof response.data === "object" &&
        "ok" in response.data
          ? response.data
          : response;

      if (!response?.ok || !expandResult?.ok) {
        throw new Error(
          expandResult?.error?.message ||
            response?.error?.message ||
            response?.data?.error?.message ||
            "扩词失败，请确认当前页面是搜索页",
        );
      }

      const data = expandResult?.data || {};
      controllerState.expandedKeywordsBuffer = Array.isArray(data.expandedKeywords)
        ? data.expandedKeywords
        : [];
      controllerPorts.taskView.setExpandedKeywordsVisible(false);
      invalidateKeywordInsightDraft();
      console.info("[Sidebar] Expand keyword result received", {
        totalFound: data?.stats?.totalFound ?? 0,
        uniqueCount: controllerState.expandedKeywordsBuffer.length,
      });

      await persistBatchDraftForPlatform();

      const stats = data?.stats || {totalFound: 0, duplicatesRemoved: 0};
      renderExpandedKeywords();
      showMessage(
        `扩词完成：共发现 ${stats.totalFound} 个联想词，去重后 ${controllerState.expandedKeywordsBuffer.length} 个`,
        "success",
      );
      void startKeywordAnalysis({force: true});
    } catch (error) {
      console.error("[Sidebar] Expand keywords failed:", error);
      if (String(error?.message || "") === "扩词已取消") {
        showMessage("扩词已取消", "warning");
      } else {
        showMessage("扩词失败: " + error.message, "error");
      }
    } finally {
      hideProgress();
      controllerState.keywordExpandInFlight = false;
      controllerState.keywordExpandCancelRequested = false;
      updateExpandKeywordsButtonState();
      syncKeywordSortDimensionByRuntime(getCurrentRuntime()).catch((error) => {
        console.warn("[Sidebar] Resume keyword sort sync failed:", error);
      });
    }
  }
  async function requestKeywordExpandCancel() {
    if (controllerState.keywordExpandCancelRequested) {
      return;
    }

    controllerState.keywordExpandCancelRequested = true;
    updateExpandKeywordsButtonState();

    try {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (tab?.id) {
        await chrome.runtime.sendMessage({
          type: MESSAGE_TYPE.RELAY_TO_CONTENT,
          tabId: tab.id,
          payload: {action: "cancelCapture"},
        });
      }
    } catch (error) {
      console.warn("[Sidebar] Expand keyword cancel failed:", error);
    }

    showMessage("正在停止扩词...", "warning");
  }

  return Object.freeze({
    getSelectedRecommendedKeywords,
    invalidateKeywordInsightDraft,
    clearKeywordInsightResult,
    isKeywordAnalysisLockStale,
    releaseKeywordAnalysisLock,
    updateCategorySampleResult,
    runKeywordInsightSampling,
    startKeywordAnalysis,
    retryKeywordAnalysis,
    handleExpandKeywords,
    requestKeywordExpandCancel,
  });
}
