// L3-B keyword-sort: explicit application responsibility.
export function createKeywordSortController({controllerState, controllerPorts, controllerOperations}) {
  const {
    KEYWORD_SORT_DIMENSION,
    KEYWORD_SORT_SYNC_INTERVAL_MS,
    MESSAGE_TYPE,
    PAGE_TYPE,
    chrome,
    clearInterval,
    console,
    detectPlatformFromUrl,
    getCurrentRuntime,
    getPlatformCapabilities,
    setInterval,
  } = controllerPorts;
  const applyKeywordSortDimensionToUI = (...args) => controllerPorts.taskView.applyKeywordSortDimensionToUI(...args);

  function normalizeKeywordSortDimension(value) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (normalized === KEYWORD_SORT_DIMENSION.COLLECTS) {
      return KEYWORD_SORT_DIMENSION.COLLECTS;
    }
    if (normalized === KEYWORD_SORT_DIMENSION.COMMENTS) {
      return KEYWORD_SORT_DIMENSION.COMMENTS;
    }
    return KEYWORD_SORT_DIMENSION.LIKES;
  }
  async function syncKeywordSortDimensionByRuntime(runtime = null) {
    const pageType = runtime?.pageType || getCurrentRuntime()?.pageType;
    const pageUrl =
      runtime?.lastPageUrl || getCurrentRuntime()?.lastPageUrl || "";
    const pagePlatform = detectPlatformFromUrl(pageUrl);
    if (
      pageType !== PAGE_TYPE.SEARCH_RESULTS ||
      !getPlatformCapabilities(pagePlatform).captureSearch
    ) {
      controllerState.keywordSortDimension = KEYWORD_SORT_DIMENSION.LIKES;
      applyKeywordSortDimensionToUI(controllerState.keywordSortDimension);
      stopKeywordSortSyncTimer();
      return {
        dimension: controllerState.keywordSortDimension,
        source: "default",
      };
    }

    startKeywordSortSyncTimer();
    return await syncKeywordSortDimensionFromPage({
      fallbackDimension: controllerState.keywordSortDimension,
    });
  }
  function startKeywordSortSyncTimer() {
    if (controllerState.keywordSortSyncTimer) {
      return;
    }

    controllerState.keywordSortSyncTimer = setInterval(() => {
      const runtime = getCurrentRuntime();
      const pagePlatform = detectPlatformFromUrl(runtime?.lastPageUrl || "");
      if (
        runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS ||
        !getPlatformCapabilities(pagePlatform).captureSearch
      ) {
        stopKeywordSortSyncTimer();
        return;
      }

      syncKeywordSortDimensionFromPage({
        fallbackDimension: controllerState.keywordSortDimension,
      }).catch((error) => {
        console.warn("[Sidebar] Keyword sort sync tick failed:", error);
      });
    }, KEYWORD_SORT_SYNC_INTERVAL_MS);
  }
  function stopKeywordSortSyncTimer() {
    if (!controllerState.keywordSortSyncTimer) {
      return;
    }
    clearInterval(controllerState.keywordSortSyncTimer);
    controllerState.keywordSortSyncTimer = null;
  }
  async function syncKeywordSortDimensionFromPage({
    force = false,
    fallbackDimension = KEYWORD_SORT_DIMENSION.LIKES,
  } = {}) {
    const runtime = getCurrentRuntime();
    const pagePlatform = detectPlatformFromUrl(runtime?.lastPageUrl || "");
    if (
      runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS ||
      !getPlatformCapabilities(pagePlatform).captureSearch
    ) {
      const fallback = normalizeKeywordSortDimension(fallbackDimension);
      controllerState.keywordSortDimension = fallback;
      applyKeywordSortDimensionToUI(fallback);
      return {
        dimension: fallback,
        source: "default",
      };
    }

    try {
      const detected = await detectKeywordSortDimensionFromActiveTab();
      const normalized = normalizeKeywordSortDimension(
        detected?.dimension || fallbackDimension,
      );
      if (force || normalized !== controllerState.keywordSortDimension) {
        controllerState.keywordSortDimension = normalized;
        applyKeywordSortDimensionToUI(normalized);
      }
      return {
        dimension: normalized,
        source: detected?.source || "default",
      };
    } catch (error) {
      console.warn("[Sidebar] Detect keyword sort dimension failed:", error);
      const fallback = normalizeKeywordSortDimension(fallbackDimension);
      if (force) {
        controllerState.keywordSortDimension = fallback;
        applyKeywordSortDimensionToUI(fallback);
      }
      return {
        dimension: fallback,
        source: "fallback",
      };
    }
  }
  async function detectKeywordSortDimensionFromActiveTab() {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id) {
      return {
        dimension: KEYWORD_SORT_DIMENSION.LIKES,
        source: "default",
      };
    }

    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: tab.id,
      payload: {
        action: "detectSearchSortDimension",
      },
    });

    if (!response?.ok || !response?.data?.ok) {
      return {
        dimension: KEYWORD_SORT_DIMENSION.LIKES,
        source: "default",
      };
    }

    return (
      response.data.data || {
        dimension: KEYWORD_SORT_DIMENSION.LIKES,
        source: "default",
      }
    );
  }

  return Object.freeze({
    normalizeKeywordSortDimension,
    syncKeywordSortDimensionByRuntime,
    startKeywordSortSyncTimer,
    stopKeywordSortSyncTimer,
    syncKeywordSortDimensionFromPage,
    detectKeywordSortDimensionFromActiveTab,
  });
}
