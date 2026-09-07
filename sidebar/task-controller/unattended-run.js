// L3-A unattended-run: original control flow, explicit state and compatibility ports.
export function createUnattendedRunController({controllerState, controllerPorts, controllerOperations}) {
  const {
    CAPTURE_EXECUTION_LOCK_HOLDER_ID,
    MAX_BATCH_KEYWORDS,
    PAGE_TYPE,
    UNATTENDED_BOOTSTRAP_GATE_MAX_WAIT_MS,
    UNATTENDED_CAPTURE_SESSION_MAX_ATTEMPTS,
    UNATTENDED_CAPTURE_SESSION_RETRYABLE_CODES,
    UNATTENDED_CAPTURE_SESSION_RETRY_DELAYS_MS,
    UNATTENDED_KEYWORD_MAX_ATTEMPTS,
    UNATTENDED_SEARCH_BOOTSTRAP_MAX_ATTEMPTS,
    UNATTENDED_SEARCH_BOOTSTRAP_RETRY_DELAYS_MS,
    advanceUnattendedCheckpointRound,
    beginDouyinSearchResultTransitionInTab,
    beginTaskContext,
    buildSyncReconciliationError,
    chrome,
    closeBatchModal,
    completeTaskContext,
    console,
    detectPlatformFromUrl,
    taskView,
    endCaptureTaskSession,
    findUnattendedResumeKeyword,
    getCaptureSettings,
    getCurrentRuntime,
    getKeywordExecutionCopy,
    getPagePlatform,
    hasSyncReconciliationSignal,
    isUnattendedSafetyBlock,
    loadKeywordPlanUI,
    normalizeUnattendedKeywordCheckpoint,
    normalizeUnattendedSearchPasses,
    readDouyinSearchDocumentGenerationInTab,
    renderCaptureDebugSession,
    setTimeout,
    settleUnattendedKeywordCheckpoint,
    showMessage,
    sleep,
    summarizeUnattendedKeywordCheckpoint,
    syncDetailCaptureControlsFromStoredSettings,
    syncSearchFilterControlsForPlatform,
    unattendedSearchPassLabel,
    updateCaptureTaskSession,
  } = controllerPorts;
  const activateUnattendedRunRequest = (...args) => controllerOperations.activateUnattendedRunRequest(...args);
  const adoptUnattendedCaptureExecutionLock = (...args) => controllerOperations.adoptUnattendedCaptureExecutionLock(...args);
  const clearActiveUnattendedRunRequest = (...args) => controllerOperations.clearActiveUnattendedRunRequest(...args);
  const createUnattendedKeywordProgressReporter = (...args) => controllerOperations.createUnattendedKeywordProgressReporter(...args);
  const dedupeKeywords = (...args) => controllerOperations.dedupeKeywords(...args);
  const finalizeUnattendedLocalClosureAfterFlush = (...args) => controllerOperations.finalizeUnattendedLocalClosureAfterFlush(...args);
  const getTargetedPostRunRequestIdFromUrl = (...args) => controllerOperations.getTargetedPostRunRequestIdFromUrl(...args);
  const getUnattendedRunAttemptIdFromUrl = (...args) => controllerOperations.getUnattendedRunAttemptIdFromUrl(...args);
  const getUnattendedRunRequestIdFromUrl = (...args) => controllerOperations.getUnattendedRunRequestIdFromUrl(...args);
  const handleBatchKeywordCapture = (...args) => controllerOperations.handleBatchKeywordCapture(...args);
  const releaseCaptureExecutionLock = (...args) => controllerOperations.releaseCaptureExecutionLock(...args);
  const releaseCaptureTaskOwner = (...args) => controllerOperations.releaseCaptureTaskOwner(...args);
  const rememberCaptureTaskProgressContext = (...args) => controllerOperations.rememberCaptureTaskProgressContext(...args);
  const reportInitialUnattendedKeywordRun = (...args) => controllerOperations.reportInitialUnattendedKeywordRun(...args);
  const reportUnattendedKeywordRun = (...args) => controllerOperations.reportUnattendedKeywordRun(...args);
  const reportUnattendedTerminalRun = (...args) => controllerOperations.reportUnattendedTerminalRun(...args);
  const resolveCaptureTaskSourceTabId = (...args) => controllerOperations.resolveCaptureTaskSourceTabId(...args);
  const resolveCaptureTaskTerminalStatus = (...args) => controllerOperations.resolveCaptureTaskTerminalStatus(...args);
  const resolveUnattendedCancellationTerminal = (...args) => controllerOperations.resolveUnattendedCancellationTerminal(...args);
  const sleepWithStop = (...args) => controllerOperations.sleepWithStop(...args);
  const startOptionalCaptureAssistSession = (...args) => controllerOperations.startOptionalCaptureAssistSession(...args);
  const startUnattendedKeywordRunHeartbeat = (...args) => controllerOperations.startUnattendedKeywordRunHeartbeat(...args);
  const supportsPersistentCaptureTaskPlatform = (...args) => controllerOperations.supportsPersistentCaptureTaskPlatform(...args);
  const waitForUnattendedProtectedStart = (...args) => controllerOperations.waitForUnattendedProtectedStart(...args);

  async function maybeClaimAndRunUnattendedKeywordPlan({allowPending = false} = {}) {
    const isLocalRecoveryRunner = controllerPorts.localRecoveryRunnerGate?.isRecoveryRunner === true;
    if (isLocalRecoveryRunner && !controllerPorts.strictCaptureClient) {
      return controllerOperations.runLocalRecoveryClaimedProducer(scope =>
        scope.operations.maybeClaimAndRunUnattendedKeywordPlan({allowPending}));
    }
    if (getTargetedPostRunRequestIdFromUrl()) {
      return;
    }
    const requestId = getUnattendedRunRequestIdFromUrl();
    const requestAttemptId = getUnattendedRunAttemptIdFromUrl();
    if (!requestId && !allowPending) {
      return;
    }
    if (!requestId && (controllerState.batchKeywordCaptureInFlight || controllerState.batchUrlCaptureInFlight)) {
      return;
    }

    let stopHeartbeat = () => {};
    let claimedRequestId = requestId;
    let claimedAttemptId = "";
    let claimedAdoptedLockId = "";
    let claimedRunAccepted = false;
    let claimedExecutionCopy = getKeywordExecutionCopy();
    try {
      const response = isLocalRecoveryRunner
        ? controllerOperations.takeLocalRecoveryRunnerClaim({
          requestId, attemptId: requestAttemptId, holderId: CAPTURE_EXECUTION_LOCK_HOLDER_ID,
        })
        : await chrome.runtime.sendMessage({
        type: "onstarvoice:claim-unattended-keyword-run",
        requestId,
        attemptId: requestAttemptId,
        holderId: CAPTURE_EXECUTION_LOCK_HOLDER_ID,
      });
      if (
        response?.accepted === false &&
        response?.reason === "previous_capture_stop_unconfirmed"
      ) {
        if (response.lock) {
          adoptUnattendedCaptureExecutionLock(response.lock);
        }
        showMessage(
          "旧采集页面未能安全停止，已阻止自动继续；请在任务中心取消任务或检查页面后重试",
          "error",
        );
        return;
      }
      if (
        response?.accepted === false &&
        response?.reason === "capture_lock_conflict"
      ) {
        claimedExecutionCopy = getKeywordExecutionCopy(response?.data || {});
        showMessage(
          `其他采集任务已占用执行锁，${claimedExecutionCopy.taskLabel}恢复已暂停；请等待当前任务结束后从任务中心重试`,
          "warning",
        );
        return;
      }
      if (!response?.ok || response?.accepted === false || !response.data) {
        if (requestId) {
          showMessage("未找到可执行的采集任务", "warning");
        }
        return;
      }
      claimedExecutionCopy = getKeywordExecutionCopy(response.data);
      claimedRequestId = String(response.data.id || requestId || "").trim();
      claimedAttemptId = String(response.data?.attemptId || "").trim();
      claimedRunAccepted = Boolean(claimedRequestId && claimedAttemptId);
      activateUnattendedRunRequest(response.data);
      if (response.lock && adoptUnattendedCaptureExecutionLock(response.lock)) {
        claimedAdoptedLockId = String(response.lock.id || "").trim();
      }
      stopHeartbeat = startUnattendedKeywordRunHeartbeat(
        claimedRequestId,
        claimedAttemptId,
      );
      const ready = await waitForUnattendedProtectedStart(response.data, {
        round: response.data?.checkpoint?.round,
      });
      if (!ready) {
        return;
      }
      await runUnattendedKeywordPlanRequest(response.data);
    } catch (error) {
      console.error("[Sidebar] Claim unattended keyword run failed:", error);
      if (
        !controllerState.activeUnattendedAttemptRejected &&
        !error?.unattendedTerminalReported
      ) {
        showMessage(
          `启动${claimedExecutionCopy.taskLabel}失败: ${error.message}`,
          "error",
        );
        await reportUnattendedTerminalRun(
          claimedRequestId,
          {
            status: "failed",
            finishedAt: new Date().toISOString(),
            message: error.message,
            error: {
              message: error.message,
            },
          },
          {attemptId: claimedAttemptId},
        );
      }
    } finally {
      stopHeartbeat();
      clearActiveUnattendedRunRequest(claimedRequestId, claimedAttemptId);
      if (
        claimedAdoptedLockId &&
        controllerState.activeCaptureExecutionLockId === claimedAdoptedLockId
      ) {
        await releaseCaptureExecutionLock(claimedAdoptedLockId);
      }
      // The exact attempt first drains every durable checkpoint and then writes
      // a storage-backed flush-ready marker. Background may close only this
      // runner after seeing that marker; cloud-fenced runs additionally persist
      // proof, while local schedules stop after safe runner cleanup.
      if (claimedRunAccepted) {
        await finalizeUnattendedLocalClosureAfterFlush(
          claimedRequestId,
          claimedAttemptId,
        ).catch((error) => {
          console.warn(
            "[Sidebar] Final unattended checkpoint closure remains pending:",
            error,
          );
        });
      }
    }
  }

  function buildSidebarKeywordSearchUrl(keyword, platform, baseSearchUrl = "") {
    const encodedKeyword = encodeURIComponent(keyword);
    if (platform === "douyin") {
      return `https://www.douyin.com/search/${encodedKeyword}?type=general`;
    }
    if (platform === "weibo") {
      return `https://s.weibo.com/weibo?q=${encodedKeyword}`;
    }

    const xhsDefaultSearchUrl = new URL("https://www.xiaohongshu.com/search_result");
    xhsDefaultSearchUrl.searchParams.set("source", "web_explore_feed");
    xhsDefaultSearchUrl.searchParams.set("type", "51");
    if (baseSearchUrl) {
      try {
        const parsed = new URL(baseSearchUrl);
        const pathname = String(parsed.pathname || "").toLowerCase();
        const isXhsSearchPath =
          pathname.includes("/search_result") ||
          pathname.includes("/web/search_result") ||
          pathname.includes("/search/result");
        if (isXhsSearchPath) {
          parsed.searchParams.set("keyword", keyword);
          return parsed.toString();
        }
        const nextSearchUrl = new URL(xhsDefaultSearchUrl.toString());
        const source = String(parsed.searchParams.get("source") || "").trim();
        const type = String(parsed.searchParams.get("type") || "").trim();
        if (source) nextSearchUrl.searchParams.set("source", source);
        if (type) nextSearchUrl.searchParams.set("type", type);
        nextSearchUrl.searchParams.set("keyword", keyword);
        return nextSearchUrl.toString();
      } catch {
        // fallback below
      }
    }
    xhsDefaultSearchUrl.searchParams.set("keyword", keyword);
    return xhsDefaultSearchUrl.toString();
  }

  async function waitForActiveTabReady(
    tabId,
    timeoutMs = 15000,
    {
      windowId = null,
      platform = "",
      expectedUrl = "",
      expectedKeyword = "",
      shouldStop = null,
    } = {},
  ) {
    const startedAt = Date.now();
    let currentTabId = Number(tabId);
    const normalizedExpectedUrl = String(expectedUrl || "").trim();
    const expectedPlatform = String(
      platform || detectPlatformFromUrl(normalizedExpectedUrl) || "",
    )
      .trim()
      .toLowerCase();
    const normalizedExpectedKeyword = String(expectedKeyword || "").trim();
    const normalizeSearchKeyword = (value) =>
      String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/gu, "");
    const readSearchKeywordFromUrl = (value) => {
      try {
        const parsed = new URL(String(value || ""));
        if (expectedPlatform === "xiaohongshu") {
          return parsed.searchParams.get("keyword") ||
            parsed.searchParams.get("q") || "";
        }
        if (expectedPlatform === "douyin") {
          return decodeURIComponent(
            String(parsed.pathname || "").split("/search/")[1]?.split("/")[0] ||
              "",
          );
        }
        if (expectedPlatform === "weibo") {
          return parsed.searchParams.get("q") || "";
        }
      } catch {
        return "";
      }
      return "";
    };
    const matchesExpectedSearch = (tab) => {
      const tabUrl = String(tab?.url || "").trim();
      if (!tabUrl) return false;
      if (
        expectedPlatform &&
        detectPlatformFromUrl(tabUrl) !== expectedPlatform
      ) {
        return false;
      }
      if (!normalizedExpectedKeyword) {
        return !normalizedExpectedUrl || tabUrl === normalizedExpectedUrl;
      }
      return normalizeSearchKeyword(readSearchKeywordFromUrl(tabUrl)) ===
        normalizeSearchKeyword(normalizedExpectedKeyword);
    };
    while (Date.now() - startedAt < timeoutMs) {
      if (typeof shouldStop === "function" && shouldStop()) {
        const error = new Error("无人值守搜索页恢复已取消");
        error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
        throw error;
      }
      try {
        const tab = await chrome.tabs.get(currentTabId);
        if (
          String(tab?.status || "") === "complete" &&
          matchesExpectedSearch(tab)
        ) {
          if (typeof shouldStop === "function" && shouldStop()) {
            const error = new Error("无人值守搜索页恢复已取消");
            error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
            throw error;
          }
          return {ready: true, tabId: Number(tab.id), tab};
        }
      } catch (error) {
        if (error?.code === "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED") {
          throw error;
        }
        const query = {active: true};
        if (Number.isFinite(Number(windowId)) && Number(windowId) >= 0) {
          query.windowId = Number(windowId);
        } else {
          query.currentWindow = true;
        }
        const candidates = await chrome.tabs.query(query).catch(() => []);
        const replacement = candidates.find(
          (tab) =>
            tab?.id &&
            (!expectedPlatform ||
              detectPlatformFromUrl(tab?.url || "") === expectedPlatform),
        );
        if (
          replacement?.id &&
          String(replacement.status || "") === "complete" &&
          matchesExpectedSearch(replacement)
        ) {
          const replacementTabId = Number(replacement.id);
          if (typeof shouldStop === "function" && shouldStop()) {
            const error = new Error("无人值守搜索页恢复已取消");
            error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
            throw error;
          }
          return {
            ready: true,
            tabId: replacementTabId,
            tab: replacement,
            replaced: replacementTabId !== Number(tabId),
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return {ready: false, tabId: currentTabId, tab: null};
  }

  async function waitForRuntimeSearchPage({
    platform = "",
    tabId = null,
    expectedUrl = "",
    expectedKeyword = "",
    timeoutMs = 8000,
    shouldStop = null,
  } = {}) {
    const startedAt = Date.now();
    const expectedTabId = Number(tabId);
    const normalizedExpectedKeyword = String(expectedKeyword || "").trim();
    const normalizedExpectedUrl = String(expectedUrl || "").trim();
    const normalizeSearchKeyword = (value) =>
      String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/gu, "");
    const readSearchKeywordFromUrl = (value) => {
      try {
        const parsed = new URL(String(value || ""));
        if (platform === "xiaohongshu") {
          return parsed.searchParams.get("keyword") ||
            parsed.searchParams.get("q") || "";
        }
        if (platform === "douyin") {
          return decodeURIComponent(
            String(parsed.pathname || "").split("/search/")[1]?.split("/")[0] ||
              "",
          );
        }
        if (platform === "weibo") {
          return parsed.searchParams.get("q") || "";
        }
      } catch {
        return "";
      }
      return "";
    };
    while (Date.now() - startedAt < timeoutMs) {
      if (typeof shouldStop === "function" && shouldStop()) {
        const error = new Error("无人值守搜索页恢复已取消");
        error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
        throw error;
      }
      const runtime = getCurrentRuntime();
      const runtimeUrl = String(runtime?.lastPageUrl || "");
      let keywordMatches = !normalizedExpectedKeyword;
      if (!keywordMatches) {
        keywordMatches = normalizeSearchKeyword(
          readSearchKeywordFromUrl(runtimeUrl),
        ) === normalizeSearchKeyword(normalizedExpectedKeyword);
      } else if (normalizedExpectedUrl) {
        keywordMatches = runtimeUrl === normalizedExpectedUrl;
      }
      if (
        getPagePlatform(runtime) === platform &&
        runtime?.pageType === PAGE_TYPE.SEARCH_RESULTS &&
        (!Number.isFinite(expectedTabId) ||
          expectedTabId <= 0 ||
          Number(runtime?.lastActiveTabId) === expectedTabId) &&
        keywordMatches
      ) {
        if (typeof shouldStop === "function" && shouldStop()) {
          const error = new Error("无人值守搜索页恢复已取消");
          error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
          throw error;
        }
        return true;
      }
      // 平台页面在慢加载时，全局 runtime 可能晚于已绑定标签页更新。
      // 直接核验任务绑定的 tab，只接受“正确搜索词 + 搜索页骨架已出现”；
      // 结果卡片由后续的长等待检查负责，这里不因结果还在加载而刷新页面。
      if (
        (platform === "douyin" || platform === "xiaohongshu") &&
        Number.isFinite(expectedTabId) &&
        expectedTabId > 0
      ) {
        const boundTabReady = await chrome.scripting
          .executeScript({
            target: {tabId: expectedTabId},
            args: [normalizedExpectedKeyword, platform],
            func: (expectedKeywordValue, expectedPlatform) => {
              const normalize = (value) =>
                String(value || "")
                  .trim()
                  .toLowerCase()
                  .replace(/\s+/gu, "");
              const decode = (value) => {
                try {
                  return decodeURIComponent(String(value || ""));
                } catch {
                  return String(value || "");
                }
              };
              const expected = normalize(expectedKeywordValue);
              const url = new URL(window.location.href);
              const hostname = String(url.hostname || "").toLowerCase();
              const pathname = String(url.pathname || "");
              if (expectedPlatform === "xiaohongshu") {
                const queryKeyword = decode(
                  url.searchParams.get("keyword") ||
                    url.searchParams.get("q") ||
                    "",
                );
                const inputKeyword =
                  Array.from(
                    document.querySelectorAll(
                      'input[type="search"], input[placeholder*="搜索"], input.search-input',
                    ),
                  )
                    .map((node) => node.value || node.textContent || "")
                    .map((value) => String(value || "").trim())
                    .find(Boolean) || "";
                const keywordMatched =
                  Boolean(expected) &&
                  (normalize(queryKeyword) === expected ||
                    normalize(inputKeyword) === expected);
                const bodyText = String(document.body?.innerText || "");
                const hasSearchShell = Boolean(
                  document.querySelector(
                    '.feeds-container, section.note-item, .note-item, [class*="feeds"]',
                  ) ||
                    (/全部/u.test(bodyText) &&
                      /图文/u.test(bodyText) &&
                      /视频/u.test(bodyText)),
                );
                return Boolean(
                  (hostname === "xiaohongshu.com" ||
                    hostname.endsWith(".xiaohongshu.com")) &&
                    (pathname === "/search_result" ||
                      pathname === "/web/search_result") &&
                    document.readyState !== "loading" &&
                    keywordMatched &&
                    hasSearchShell,
                );
              }
              const urlKeyword = decode(
                pathname.split("/search/")[1]?.split("/")[0] || "",
              );
              const inputKeyword =
                Array.from(
                  document.querySelectorAll(
                    '[data-e2e="searchbar-input"], input[type="search"], input[placeholder*="搜索"]',
                  ),
                )
                  .map((node) => node.value || node.textContent || "")
                  .map((value) => String(value || "").trim())
                  .find(Boolean) || "";
              const keywordMatched =
                Boolean(expected) &&
                (normalize(urlKeyword) === expected ||
                  normalize(inputKeyword) === expected);
              const bodyText = String(document.body?.innerText || "");
              const hasSearchShell = Boolean(
                document.querySelector(
                  '[data-e2e="searchbar-input"], #search-result-container, #waterFallScrollContainer, [data-e2e="scroll-list"]',
                ) || (/综合/u.test(bodyText) && /视频|用户|直播/u.test(bodyText)),
              );
              return Boolean(
                (hostname === "douyin.com" ||
                  hostname.endsWith(".douyin.com")) &&
                  pathname.startsWith("/search/") &&
                  document.readyState !== "loading" &&
                  keywordMatched &&
                  hasSearchShell,
              );
            },
          })
          .then(([result]) => Boolean(result?.result))
          .catch(() => false);
        if (boundTabReady) {
          if (typeof shouldStop === "function" && shouldStop()) {
            const error = new Error("无人值守搜索页恢复已取消");
            error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
            throw error;
          }
          return true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }

  function resolveUnattendedBootstrapStartGate(request = {}, now = Date.now()) {
    const orchestrationContext =
      request?.orchestrationContext &&
      typeof request.orchestrationContext === "object"
        ? request.orchestrationContext
        : {};
    if (orchestrationContext.distributionMode !== "elastic_pool") {
      return {delayed: false, waitMs: 0, waitUntil: "", reason: ""};
    }
    const notBeforeMs = Date.parse(
      String(orchestrationContext.bootstrapStartNotBefore || ""),
    );
    if (!Number.isFinite(notBeforeMs)) {
      return {delayed: false, waitMs: 0, waitUntil: "", reason: ""};
    }
    const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const waitMs = Math.min(
      UNATTENDED_BOOTSTRAP_GATE_MAX_WAIT_MS,
      Math.max(0, notBeforeMs - nowMs),
    );
    return {
      delayed: waitMs > 0,
      waitMs,
      waitUntil: new Date(nowMs + waitMs).toISOString(),
      reason: String(
        orchestrationContext.bootstrapPacingReason || "staggered_start",
      ).trim(),
    };
  }

  async function navigateActiveTabToKeywordSearchForPlan({
    keyword = "",
    platform = "xiaohongshu",
    baseSearchUrl = "",
    tabId = null,
    maxAttempts = UNATTENDED_SEARCH_BOOTSTRAP_MAX_ATTEMPTS,
    retryDelaysMs = UNATTENDED_SEARCH_BOOTSTRAP_RETRY_DELAYS_MS,
    retryDelayMs = null,
    shouldStop = null,
    onAttempt = null,
    onRetry = null,
  } = {}) {
    const searchUrl = buildSidebarKeywordSearchUrl(keyword, platform, baseSearchUrl);
    const boundedMaxAttempts = Math.max(
      1,
      Math.min(4, Math.floor(Number(maxAttempts) || 1)),
    );
    const resolveRetryDelayMs = (attempt) => {
      if (retryDelayMs !== null && retryDelayMs !== undefined) {
        return Math.max(0, Number(retryDelayMs) || 0);
      }
      const schedule = Array.isArray(retryDelaysMs)
        ? retryDelaysMs
        : UNATTENDED_SEARCH_BOOTSTRAP_RETRY_DELAYS_MS;
      return Math.max(
        0,
        Number(schedule[Math.max(0, attempt - 1)] ?? schedule.at(-1)) || 0,
      );
    };
    let preferredTabId =
      Number.isFinite(Number(tabId)) && Number(tabId) > 0
        ? Number(tabId)
        : null;
    const hasExplicitSourceTab = preferredTabId !== null;
    let preferredWindowId = null;
    let lastError = null;

    for (let attempt = 1; attempt <= boundedMaxAttempts; attempt += 1) {
      if (typeof shouldStop === "function" && shouldStop()) {
        const stoppedError = new Error("无人值守搜索页恢复已取消");
        stoppedError.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
        throw stoppedError;
      }
      if (typeof onAttempt === "function") {
        await onAttempt({
          attempt,
          maxAttempts: boundedMaxAttempts,
          keyword,
          platform,
          tabId: preferredTabId,
        });
      }

      let targetTab = null;
      if (preferredTabId) {
        try {
          targetTab = await chrome.tabs.get(preferredTabId);
          if (Number.isFinite(Number(targetTab?.windowId))) {
            preferredWindowId = Number(targetTab.windowId);
          }
        } catch {
          targetTab = null;
        }
      }
      if (!targetTab?.id) {
        if (!hasExplicitSourceTab) {
          const [activeTab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          targetTab =
            activeTab &&
            (!platform || detectPlatformFromUrl(activeTab.url || "") === platform)
              ? activeTab
              : null;
        } else {
          const query = Number.isFinite(preferredWindowId)
            ? {windowId: preferredWindowId}
            : {currentWindow: true};
          const candidates = await chrome.tabs.query(query).catch(() => []);
          const platformCandidates = candidates.filter(
            (candidate) =>
              candidate?.id &&
              (!platform ||
                detectPlatformFromUrl(candidate.url || "") === platform),
          );
          const identityCandidate = platformCandidates.find((candidate) => {
            const candidateUrl = String(candidate?.url || "");
            if (!keyword) return candidateUrl === searchUrl;
            try {
              return decodeURIComponent(candidateUrl.replace(/\+/gu, "%20")).includes(
                keyword,
              );
            } catch {
              return candidateUrl.includes(encodeURIComponent(keyword));
            }
          });
          // 已绑定来源页时绝不能退回任意 active tab；即使同窗口里只剩一个
          // 同平台页，也必须先确认它就是当前任务的搜索页。
          targetTab = identityCandidate || null;
        }
      }

      if (!targetTab?.id) {
        lastError = new Error("未找到可用于无人值守采集的标签页");
      } else {
        const originalTargetTabId = Number(targetTab.id);
        preferredTabId = originalTargetTabId;
        if (Number.isFinite(Number(targetTab.windowId))) {
          preferredWindowId = Number(targetTab.windowId);
        }
        try {
          const [previousDocumentGeneration, douyinSearchTransition] =
            platform === "douyin"
              ? await Promise.all([
                  readDouyinSearchDocumentGenerationInTab(originalTargetTabId),
                  beginDouyinSearchResultTransitionInTab(
                    originalTargetTabId,
                    keyword,
                  ),
                ])
              : [null, null];
          if (
            !controllerPorts.strictCaptureClient &&
            Number.isFinite(Number(targetTab.windowId)) &&
            Number(targetTab.windowId) >= 0
          ) {
            await chrome.windows.update(Number(targetTab.windowId), {
              focused: true,
            });
          }
          const updatedTab = await chrome.tabs.update(originalTargetTabId, {
            url: searchUrl,
            active: true,
          });
          if (updatedTab?.id) {
            targetTab = updatedTab;
            preferredTabId = Number(updatedTab.id);
          }
          const readyState = await waitForActiveTabReady(
            preferredTabId,
            platform === "douyin" ? 45000 : 15000,
            {
              windowId: targetTab.windowId,
              platform,
              expectedUrl: searchUrl,
              expectedKeyword: keyword,
              shouldStop,
            },
          );
          if (Number.isFinite(Number(readyState.tabId)) && Number(readyState.tabId) > 0) {
            preferredTabId = Number(readyState.tabId);
          }
          if (typeof shouldStop === "function" && shouldStop()) {
            const stoppedError = new Error("无人值守搜索页恢复已取消");
            stoppedError.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
            throw stoppedError;
          }
          // Tab identity 都没通过时不再白等额外 8 秒；下一轮会强制重开同一搜索词。
          const isSearchRuntimeReady = readyState.ready
            ? await waitForRuntimeSearchPage({
                platform,
                tabId: preferredTabId,
                expectedUrl: searchUrl,
                expectedKeyword: keyword,
                timeoutMs: platform === "douyin" ? 15000 : 8000,
                shouldStop,
              })
            : false;
          if (readyState.ready && isSearchRuntimeReady) {
            if (typeof shouldStop === "function" && shouldStop()) {
              const stoppedError = new Error("无人值守搜索页恢复已取消");
              stoppedError.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
              throw stoppedError;
            }
            const currentDocumentGeneration =
              platform === "douyin"
                ? await readDouyinSearchDocumentGenerationInTab(preferredTabId)
                : null;
            const navigationTransitionAccepted = Boolean(
              platform === "douyin" &&
                Number(previousDocumentGeneration?.timeOrigin) > 0 &&
                Number(currentDocumentGeneration?.timeOrigin) > 0 &&
                Number(previousDocumentGeneration.timeOrigin) !==
                  Number(currentDocumentGeneration.timeOrigin) &&
                currentDocumentGeneration?.readyState === "complete",
            );
            const submitAccepted = Boolean(
              platform === "douyin" &&
                String(douyinSearchTransition?.submissionNonce || "").trim(),
            );
            if (
              platform === "douyin" &&
              !navigationTransitionAccepted &&
              !submitAccepted
            ) {
              const proofError = new Error(
                "抖音搜索页已打开，但无法确认这次搜索操作，已停止以免重复搜索或误采旧结果",
              );
              proofError.code = "UNATTENDED_SEARCH_BOOTSTRAP_PROOF_MISSING";
              throw proofError;
            }
            return {
              tabId: preferredTabId,
              tab: readyState.tab,
              replaced: preferredTabId !== originalTargetTabId,
              url: String(readyState.tab?.url || searchUrl),
              attemptCount: attempt,
              recovered: attempt > 1,
              initialSearchEvidence: {
                ready: true,
                keyword: String(keyword || "").trim(),
                platform,
                tabId: preferredTabId,
                pageUrl: String(readyState.tab?.url || searchUrl),
                baselineCaptured:
                  douyinSearchTransition?.baselineCaptured === true,
                previousWorkIds: Array.isArray(
                  douyinSearchTransition?.previousWorkIds,
                )
                  ? douyinSearchTransition.previousWorkIds
                  : [],
                submissionNonce: String(
                  douyinSearchTransition?.submissionNonce || "",
                ).trim(),
                submitAccepted,
                navigationTransitionAccepted,
              },
            };
          }
          lastError = new Error("搜索结果页尚未就绪，无法启动无人值守采集");
        } catch (error) {
          if (
            error?.code === "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED" ||
            error?.code === "UNATTENDED_ATTEMPT_REPLACED"
          ) {
            throw error;
          }
          lastError = error;
        }
      }

      if (attempt >= boundedMaxAttempts) {
        break;
      }
      const nextRetryDelayMs = resolveRetryDelayMs(attempt);
      const waitUntil = new Date(Date.now() + nextRetryDelayMs).toISOString();
      if (typeof onRetry === "function") {
        await onRetry({
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: boundedMaxAttempts,
          retryDelayMs: nextRetryDelayMs,
          waitUntil,
          keyword,
          platform,
          tabId: preferredTabId,
          error: lastError,
        });
      }
      if (typeof shouldStop === "function" && shouldStop()) {
        const stoppedError = new Error("无人值守搜索页恢复已取消");
        stoppedError.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
        throw stoppedError;
      }
      await sleepWithStop(nextRetryDelayMs, shouldStop);
    }

    const error = new Error(
      lastError?.message || "搜索结果页尚未就绪，无法启动无人值守采集",
    );
    error.code = "UNATTENDED_SEARCH_BOOTSTRAP_FAILED";
    error.cause = lastError;
    error.attempts = boundedMaxAttempts;
    throw error;
  }

  function buildUnattendedTaskCounts(
    checkpoint = {},
    summary = summarizeUnattendedKeywordCheckpoint(checkpoint),
    overrides = {},
  ) {
    const settledCount = Array.isArray(checkpoint?.keywordResults)
      ? checkpoint.keywordResults.length
      : 0;
    const overrideTotal = Number(overrides.total);
    const total = Math.max(
      settledCount,
      Number.isFinite(overrideTotal) ? Math.floor(overrideTotal) : 0,
    );
    const overrideProcessed = Number(overrides.processed);
    const processed = Math.min(
      total,
      Math.max(
        0,
        Number.isFinite(overrideProcessed)
          ? Math.floor(overrideProcessed)
          : settledCount,
      ),
    );
    return {
      total,
      processed,
      saved: Math.max(0, Number(overrides.saved ?? summary.saved) || 0),
      success: Math.max(
        0,
        Number(overrides.success ?? summary.completed) || 0,
      ),
      failed: Math.max(0, Number(overrides.failed ?? summary.failed) || 0),
      skipped: Math.max(0, Number(overrides.skipped ?? summary.skipped) || 0),
      retried: Math.max(0, Number(overrides.retried ?? summary.retries) || 0),
      warnings: Math.max(0, Number(overrides.warnings ?? summary.partial) || 0),
    };
  }

  function buildUnattendedTerminalProgress({
    previousProgress = null,
    status = "completed",
    finishedAt = new Date().toISOString(),
    message = "无人值守采集已结束",
    summary = {},
    taskTotal = 0,
    keyword = "",
    keywords = [],
    roundTotal = 1,
    streamingSync = null,
    captureTaskId = "",
    requestId = "",
    attemptId = "",
    runStartedAt = "",
  } = {}) {
    const previous =
      previousProgress && typeof previousProgress === "object"
        ? previousProgress
        : {};
    const completed = Math.max(0, Number(summary?.completed) || 0);
    const partial = Math.max(0, Number(summary?.partial) || 0);
    const failed = Math.max(0, Number(summary?.failed) || 0);
    const skipped = Math.max(0, Number(summary?.skipped) || 0);
    const processed = Math.min(
      Math.max(0, Number(taskTotal) || 0),
      completed + partial + failed + skipped,
    );
    const sync =
      streamingSync && typeof streamingSync === "object" ? streamingSync : {};
    const syncInteger = (value) =>
      Number.isSafeInteger(Number(value)) && Number(value) >= 0
        ? Number(value)
        : null;
    const capturedRecordCount = Math.max(0, Number(summary?.saved) || 0);
    const streamingSyncEvidenceKnown = Boolean(
      streamingSync &&
        typeof streamingSync === "object" &&
        !hasSyncReconciliationSignal(sync) &&
        typeof sync.enabled === "boolean" &&
        sync.drainCompleted === true &&
        syncInteger(sync.enqueuedCount) !== null &&
        syncInteger(sync.processedCount) !== null &&
        syncInteger(sync.successCount) !== null &&
        syncInteger(sync.failedCount) !== null &&
        syncInteger(sync.skippedCount) !== null &&
        syncInteger(sync.pendingCount) !== null &&
        syncInteger(sync.activeCount) !== null &&
        syncInteger(sync.remainingCount) !== null &&
        syncInteger(sync.capturedUniqueCount) !== null &&
        syncInteger(sync.enqueuedUniqueCount) !== null &&
        syncInteger(sync.excludedUniqueCount) !== null &&
        syncInteger(sync.succeededUniqueCount) !== null &&
        (capturedRecordCount === 0 ||
          syncInteger(sync.capturedUniqueCount) > 0) &&
        typeof sync.blocked === "boolean" &&
        typeof sync.canceled === "boolean"
    );
    return {
      ...previous,
      captureTaskId:
        String(captureTaskId || previous.captureTaskId || "").trim() ||
        (requestId ? `unattended-capture:${requestId}` : ""),
      unattendedRequestId: String(
        requestId || previous.unattendedRequestId || "",
      ),
      unattendedAttemptId: String(
        attemptId || previous.unattendedAttemptId || "",
      ),
      current: processed,
      total: Math.max(0, Number(taskTotal) || 0),
      keyword: String(keyword || previous.keyword || ""),
      keywordCurrent: processed,
      keywordTotal: Math.max(0, Number(taskTotal) || 0),
      itemCurrent: null,
      itemTotal: null,
      nextKeyword: "",
      progressScope: "terminal",
      phase: `unattended_${String(status || "completed").trim()}`,
      lastBusinessPhase: "streaming_sync_done",
      progressPercent: 100,
      remainingMs: 0,
      waitUntil: "",
      round: Math.max(1, Number(roundTotal) || 1),
      roundCurrent: Math.max(1, Number(roundTotal) || 1),
      roundTotal: Math.max(1, Number(roundTotal) || 1),
      runStartedAt: String(runStartedAt || previous.runStartedAt || ""),
      finishedAt: String(finishedAt || ""),
      message: String(message || "无人值守采集已结束"),
      keywordCompletedCount: completed,
      keywordPartialCount: partial,
      keywordFailedCount: failed,
      keywordSkippedCount: skipped,
      detailSuccessCount: Math.max(
        0,
        Number(previous.detailSuccessCount) || 0,
      ),
      detailFailedCount: Math.max(
        0,
        Number(previous.detailFailedCount) || 0,
      ),
      aiFilteredCount: Math.max(0, Number(previous.aiFilteredCount) || 0),
      noEnhancementCount: Math.max(
        0,
        Number(previous.noEnhancementCount) || 0,
      ),
      syncSuccessCount: Math.max(
        0,
        Number(sync.successCount ?? previous.syncSuccessCount) || 0,
      ),
      syncFailedCount: Math.max(
        0,
        Number(sync.failedCount ?? previous.syncFailedCount) || 0,
      ),
      syncSkippedCount: Math.max(
        0,
        Number(sync.skippedCount ?? previous.syncSkippedCount) || 0,
      ),
      syncRemainingCount: Math.max(
        0,
        Number(sync.remainingCount ?? previous.syncRemainingCount) || 0,
      ),
      // Closure evidence consumes only these explicit attempt-local fields. The
      // legacy sync* values above remain UI counters and may be defaulted for
      // backwards compatibility; they are intentionally not authoritative.
      streamingSyncEvidenceKnown,
      ...(hasSyncReconciliationSignal(sync)
        ? {syncReconciliationRequired: true, syncDrainCompleted: false}
        : {}),
      streamingSyncDrainCompleted:
        streamingSyncEvidenceKnown && sync.drainCompleted === true,
      streamingSyncEnabled:
        streamingSyncEvidenceKnown ? sync.enabled === true : null,
      streamingSyncEnqueuedCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.enqueuedCount) : null,
      streamingSyncProcessedCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.processedCount) : null,
      streamingSyncSuccessCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.successCount) : null,
      streamingSyncFailedCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.failedCount) : null,
      streamingSyncSkippedCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.skippedCount) : null,
      streamingSyncPendingCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.pendingCount) : null,
      streamingSyncActiveCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.activeCount) : null,
      streamingSyncRemainingCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.remainingCount) : null,
      streamingSyncCapturedUniqueCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.capturedUniqueCount) : null,
      streamingSyncEnqueuedUniqueCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.enqueuedUniqueCount) : null,
      streamingSyncExcludedUniqueCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.excludedUniqueCount) : null,
      streamingSyncSucceededUniqueCount:
        streamingSyncEvidenceKnown ? syncInteger(sync.succeededUniqueCount) : null,
      streamingSyncBlocked:
        streamingSyncEvidenceKnown ? sync.blocked === true : null,
      streamingSyncCanceled:
        streamingSyncEvidenceKnown ? sync.canceled === true : null,
      capturedRecordCount,
      updatedAt: String(finishedAt || new Date().toISOString()),
    };
  }

  function createUnattendedKeywordCheckpointReporter({
    requestId,
    attemptId = controllerState.activeUnattendedRunAttemptId,
    checkpoint,
    keywords,
    taskTotal = 0,
  } = {}) {
    const persist = async ({
      summary = null,
      message = "",
      waitUntil,
    } = {}) => {
      const checkpointSummary =
        summary || summarizeUnattendedKeywordCheckpoint(checkpoint);
      // Checkpoints participate in the same monotonic task fence as visible
      // progress. If this report is queued locally and a newer direct report is
      // accepted first, background will reject the old replay as stale_progress
      // instead of letting it roll the durable checkpoint backwards.
      controllerState.activeUnattendedProgressSeq += 1;
      const checkpointProgressSeq = controllerState.activeUnattendedProgressSeq;
      let reportResult = null;
      for (const delayMs of [0, 300, 900]) {
        if (delayMs > 0) await sleep(delayMs);
        const reportPatch = {
          checkpoint: {
            ...checkpoint,
            keywordResults: checkpoint.keywordResults.map((entry) => ({...entry})),
          },
          summary: checkpointSummary,
          counts: buildUnattendedTaskCounts(checkpoint, checkpointSummary, {
            total: taskTotal,
          }),
          message,
          progressSeq: checkpointProgressSeq,
          businessProgressAt: checkpoint.updatedAt,
        };
        if (waitUntil !== undefined) {
          reportPatch.waitUntil = String(waitUntil || "");
        }
        reportResult = await reportUnattendedKeywordRun(
          requestId,
          reportPatch,
          {attemptId, durableCheckpoint: true},
        );
        if (
          reportResult?.accepted ||
          reportResult?.reason === "attempt_mismatch" ||
          reportResult?.reason === "terminal"
        ) {
          break;
        }
      }
      if (!reportResult?.accepted) {
        const error = new Error(
          reportResult?.reason === "attempt_mismatch"
            ? "当前执行已被新的恢复任务接管"
            : "无法保存无人值守检查点，已停止继续执行",
        );
        error.code =
          reportResult?.reason === "attempt_mismatch"
            ? "UNATTENDED_ATTEMPT_REPLACED"
            : "UNATTENDED_CHECKPOINT_WRITE_FAILED";
        throw error;
      }
      return reportResult;
    };

    const reportSettled = async ({
      round = 1,
      originalIndex = 0,
      keyword = "",
      result = {},
      recordIds = [],
      attempt = 1,
      maxAttempts = UNATTENDED_KEYWORD_MAX_ATTEMPTS,
      securityBlocked = false,
      canceled = false,
    } = {}) => {
      const normalizedKeyword = String(keyword || "").trim();
      if (!normalizedKeyword) {
        return;
      }
      const settled = settleUnattendedKeywordCheckpoint({
        checkpoint,
        keywords,
        round,
        originalIndex,
        keyword: normalizedKeyword,
        result,
        recordIds,
        attempt,
        maxAttempts,
        securityBlocked,
        canceled,
      });
      Object.assign(checkpoint, settled.checkpoint);
      const status = settled.entry?.status || "failed";
      const summary = settled.summary;
      await persist({
        summary,
        message:
          status === "completed"
            ? `已保存关键词「${normalizedKeyword}」的任务检查点`
            : status === "retrying"
              ? `关键词「${normalizedKeyword}」暂时失败，准备有界重试`
              : `关键词「${normalizedKeyword}」已收口为${status === "partial" ? "部分完成" : "失败"}`,
      });
    };
    reportSettled.persist = persist;
    return reportSettled;
  }

  async function runUnattendedKeywordPlanRequest(request) {
    const strictClient = controllerPorts.strictCaptureClient;
    const requestId = String(request?.id || "").trim();
    const requestAttemptId = String(request?.attemptId || "").trim();
    if (strictClient && (strictClient.strictControl.requestId !== requestId ||
        strictClient.strictControl.attemptId !== requestAttemptId)) {
      const error = new Error('strict_producer_identity_mismatch');
      error.code = 'strict_producer_identity_mismatch';
      throw error;
    }
    const executionCopy = getKeywordExecutionCopy(request);
    const executionMode = executionCopy.executionMode;
    const isCurrentRequestAttempt = () =>
      requestId === String(controllerState.activeUnattendedRunRequestId || "").trim() &&
      (!requestAttemptId ||
        requestAttemptId ===
          String(controllerState.activeUnattendedRunAttemptId || "").trim());
    const plan = request?.planSnapshot || {};
    // The single-relay contract limits complete business runs, not technical
    // page/session recovery inside one run. Under shared-machine or weak-network
    // load those bounded recoveries remain necessary and do not duplicate the
    // keyword capture.
    const singleRelayMode =
      request?.cloudAssigned === true &&
      request?.orchestrationContext?.distributionMode === "elastic_pool" &&
      plan.recoveryPolicy?.singleRelayV1 === true &&
      plan.recoveryPolicy?.disableAutomaticSearchRetry === true;
    const localKeywordMaxAttempts = singleRelayMode
      ? 1
      : UNATTENDED_KEYWORD_MAX_ATTEMPTS;
    const localBootstrapMaxAttempts = UNATTENDED_SEARCH_BOOTSTRAP_MAX_ATTEMPTS;
    const localCaptureSessionMaxAttempts =
      UNATTENDED_CAPTURE_SESSION_MAX_ATTEMPTS;
    const keywords = dedupeKeywords(
      Array.isArray(plan.keywords) ? plan.keywords : [],
    ).slice(0, MAX_BATCH_KEYWORDS);
    const platform = String(plan.platform || "xiaohongshu").trim();
    const searchPasses = normalizeUnattendedSearchPasses(plan);
    const sequentialSearchEnabled =
      platform === "douyin" && searchPasses.length > 1;
    const captureTaskDebugSupported =
      supportsPersistentCaptureTaskPlatform(platform);
    const plannedRounds = sequentialSearchEnabled
      ? searchPasses.length
      : Math.max(1, Number(plan.maxRounds) || 1);
    const plannedTaskTotal = keywords.length * plannedRounds;
    const checkpoint = normalizeUnattendedKeywordCheckpoint(request, keywords, {
      maxRounds: plannedRounds,
    });
    let resumeKeyword = findUnattendedResumeKeyword(checkpoint, keywords);
    let unattendedCaptureTaskContext = null;
    let unattendedCaptureTaskSessionStarted = false;
    let unattendedCaptureTaskStatus = "failed";
    let unattendedCaptureTaskError = null;
    let reportKeywordProgress = null;
    let batchRunResult = null;
    let capturePipelineStarted = false;
    let unattendedCaptureTaskTerminalProgress = null;
    let unattendedSourceTabId = null;

    if (keywords.length === 0) {
      throw new Error(`${executionCopy.taskLabel}没有可执行关键词`);
    }
    if (!resumeKeyword && Math.max(1, Number(checkpoint.round) || 1) < plannedRounds) {
      // 兼容旧版本在「本轮完成、下一轮尚未落盘」窗口留下的检查点。
      // 以检查点/业务时钟中的较晚者作为保守间隔起点，避免崩溃窗口直接跳过
      // 防风控 roundGap；若已有显式 waitUntil，则沿用更晚的那个边界。
      const roundGapMs = Math.max(0, Number(plan.roundGapMin) || 0) * 60 * 1000;
      const checkpointUpdatedAt = Date.parse(String(checkpoint.updatedAt || ""));
      const businessProgressAt = Date.parse(String(request?.businessProgressAt || ""));
      const legacyWaitBase = Math.max(
        Number.isFinite(checkpointUpdatedAt) ? checkpointUpdatedAt : 0,
        Number.isFinite(businessProgressAt) ? businessProgressAt : 0,
      );
      const ready = await waitForUnattendedProtectedStart(request, {
        fallbackNotBeforeMs:
          legacyWaitBase > 0 && roundGapMs > 0
            ? legacyWaitBase + roundGapMs
            : 0,
        round: checkpoint.round,
      });
      if (!ready) return;
      // 等待边界确认后再推进恢复边界，避免恢复后重复上一轮或再次导航旧轮次。
      Object.assign(
        checkpoint,
        advanceUnattendedCheckpointRound({
          checkpoint,
          keywords,
          completedRound: checkpoint.round,
          maxRounds: plannedRounds,
        }),
      );
      resumeKeyword = findUnattendedResumeKeyword(checkpoint, keywords);
    }
    if (!resumeKeyword) {
      const summary = summarizeUnattendedKeywordCheckpoint(checkpoint);
      const status =
        summary.failed > 0 || summary.partial > 0
          ? "completed_with_failures"
          : "completed";
      const finishedAt = new Date().toISOString();
      const message =
        status === "completed"
          ? "检查点显示全部关键词均已完成，无需重复采集"
          : "检查点显示剩余关键词均已达到重试上限，已保留现有结果";
      await reportUnattendedTerminalRun(
        requestId,
        {
          status,
          finishedAt,
          checkpoint,
          summary,
          counts: buildUnattendedTaskCounts(checkpoint, summary, {
            total: plannedTaskTotal,
          }),
          message,
          progress: buildUnattendedTerminalProgress({
            previousProgress: request?.progress,
            status,
            finishedAt,
            message,
            summary,
            taskTotal: plannedTaskTotal,
            keyword: checkpoint.activeKeyword || "",
            keywords,
            roundTotal: plannedRounds,
            requestId,
            attemptId: requestAttemptId,
            runStartedAt: request?.startedAt || "",
          }),
        },
        {attemptId: requestAttemptId},
      );
      return;
    }
    if (controllerState.batchKeywordCaptureInFlight || controllerState.batchUrlCaptureInFlight) {
      throw new Error(
        `已有批量任务执行中，无法启动${executionCopy.taskLabel}`,
      );
    }

    const startingMessage =
      checkpoint.keywordResults.length > 0
        ? `${executionCopy.taskLabel}正在从关键词「${resumeKeyword}」恢复`
        : `${executionCopy.taskLabel}已触发，正在启动采集辅助`;
    const startingKeywordIndex = Math.max(0, keywords.indexOf(resumeKeyword));
    const startingProgress = {
      unattendedRequestId: requestId,
      unattendedAttemptId: requestAttemptId,
      current: startingKeywordIndex + 1,
      total: keywords.length,
      keyword: resumeKeyword,
      keywordCurrent: startingKeywordIndex + 1,
      keywordTotal: keywords.length,
      itemCurrent: null,
      itemTotal: null,
      nextKeyword: keywords[startingKeywordIndex + 1] || "",
      progressScope: "keyword",
      round: Math.max(1, Number(checkpoint.round) || 1),
      roundCurrent: Math.max(1, Number(checkpoint.round) || 1),
      roundTotal: plannedRounds,
      phase: "initializing_unattended",
      message: startingMessage,
      executionMode,
      taskMeta: {
        keywordList: [...keywords],
        searchFilters: {...(plan.searchFilters || {})},
        ...(sequentialSearchEnabled ? {searchPasses: [...searchPasses]} : {}),
        executionMode,
        ...(Object.prototype.hasOwnProperty.call(
          plan,
          "keywordMaxDetectedItems",
        )
          ? {keywordMaxDetectedItems: plan.keywordMaxDetectedItems}
          : {}),
      },
    };
    const strictContinuation = strictClient &&
      controllerPorts.strictCaptureContinuation?.requestId === requestId &&
      controllerPorts.strictCaptureContinuation?.attemptId === requestAttemptId
      ? controllerPorts.strictCaptureContinuation : null;
    const runStartedAt = strictContinuation?.runStartedAt || new Date().toISOString();
    startingProgress.runStartedAt = runStartedAt;
    const createTerminalProgress = ({
      status,
      finishedAt,
      message,
      summary,
      streamingSync = null,
    }) => {
      unattendedCaptureTaskTerminalProgress = buildUnattendedTerminalProgress({
        previousProgress:
          reportKeywordProgress?.getSnapshot?.() || startingProgress,
        status,
        finishedAt,
        message,
        summary,
        taskTotal: plannedTaskTotal,
        keyword: checkpoint.activeKeyword || startingProgress.keyword,
        keywords,
        roundTotal: plannedRounds,
        streamingSync:
          hasSyncReconciliationSignal(batchRunResult) ||
          hasSyncReconciliationSignal(unattendedCaptureTaskError)
            ? {...streamingSync, reconciliationRequired: true, drainCompleted: false}
            : streamingSync,
        captureTaskId: unattendedCaptureTaskContext?.taskId || "",
        requestId,
        attemptId: requestAttemptId,
        runStartedAt,
      });
      return unattendedCaptureTaskTerminalProgress;
    };
    if (!isCurrentRequestAttempt()) {
      const error = new Error("当前执行已被新的恢复任务接管");
      error.code = "UNATTENDED_ATTEMPT_REPLACED";
      throw error;
    }
    rememberCaptureTaskProgressContext(startingProgress);
    const startReport = strictContinuation?.startReport || await reportInitialUnattendedKeywordRun(
      requestId,
      {
        status: "running",
        startedAt: runStartedAt,
        checkpoint,
        counts: buildUnattendedTaskCounts(
          checkpoint,
          summarizeUnattendedKeywordCheckpoint(checkpoint),
          {total: plannedTaskTotal},
        ),
        message: startingMessage,
        progress: startingProgress,
      },
      {attemptId: requestAttemptId},
    );
    const startReportAlreadyApplied = Boolean(
      startReport?.reason === "stale_progress" &&
        String(startReport?.data?.id || "") === requestId &&
        String(startReport?.data?.attemptId || "") === requestAttemptId &&
        ["started", "running"].includes(
          String(startReport?.data?.status || ""),
        ),
    );
    if (!startReport?.accepted && !startReportAlreadyApplied) {
      const rejectionReason = String(startReport?.reason || "unknown");
      const replaced = ["attempt_mismatch", "terminal"].includes(
        rejectionReason,
      );
      const transportFailure = rejectionReason === "transport_error";
      const error = new Error(
        replaced
          ? `${executionCopy.taskLabel}已被新的恢复尝试接管`
          : transportFailure
            ? `${executionCopy.taskLabel}状态上报连续超时，尚未开始平台搜索`
            : `${executionCopy.taskLabel}状态上报被拒绝（${rejectionReason}）`,
      );
      error.code = replaced
        ? "UNATTENDED_ATTEMPT_REPLACED"
        : transportFailure
          ? "UNATTENDED_STATUS_REPORT_TIMEOUT"
          : rejectionReason === "not_found"
            ? "UNATTENDED_REQUEST_NOT_FOUND"
            : "UNATTENDED_STATUS_REPORT_REJECTED";
      error.details = {
        reportReason: rejectionReason,
        requestId,
        attemptId: requestAttemptId,
        platformSearchStarted: false,
      };
      throw error;
    }
    if (request?.strictControlCandidate === true && !strictClient) {
      // Admission follows the existing accepted running checkpoint, but occurs
      // before platform switching, native assist setup or any page producer.
      // Continue through the same function with private ports; preserve this
      // accepted report and start clock instead of submitting either twice.
      return controllerOperations.runStrictCaptureProducer(request,
        (scope) => scope.operations.runUnattendedKeywordPlanRequest(request),
        'unattended-keyword-producer', Object.freeze({
          requestId, attemptId: requestAttemptId, runStartedAt, startReport,
        }));
    }
    controllerState.keywordPlanState = {
      ...(controllerState.keywordPlanState && typeof controllerState.keywordPlanState === "object"
        ? controllerState.keywordPlanState
        : {}),
      ...plan,
      executionMode,
      enabled: true,
      lastRunStatus: "running",
      lastRunMessage: startingMessage,
      lastRunProgress: {
        ...startingProgress,
        updatedAt: new Date().toISOString(),
      },
    };
    renderCaptureDebugSession(getCurrentRuntime() || {});

    const reportAutomaticRecoveryStage = async ({
      phase,
      message,
      attemptCurrent = null,
      attemptTotal = null,
      waitUntil = "",
      remainingMs = null,
      retried = 0,
    }) => {
      const recoveryProgress = {
        ...startingProgress,
        phase,
        message,
        attempt: attemptCurrent,
        attemptCurrent,
        attemptTotal,
        maxAttempts: attemptTotal,
        waitUntil,
        remainingMs,
        phaseStartedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      rememberCaptureTaskProgressContext(recoveryProgress);
      showMessage(message, waitUntil ? "warning" : "info");
      return await reportUnattendedKeywordRun(
        requestId,
        {
          status: "running",
          waitUntil,
          checkpoint,
          counts: buildUnattendedTaskCounts(
            checkpoint,
            summarizeUnattendedKeywordCheckpoint(checkpoint),
            {
              total: plannedTaskTotal,
              retried,
            },
          ),
          message,
          progress: recoveryProgress,
        },
        {attemptId: requestAttemptId},
      );
    };

    try {
      const bootstrapGate = resolveUnattendedBootstrapStartGate(request);
      if (bootstrapGate.delayed) {
        const waitSeconds = Math.max(
          1,
          Math.ceil(bootstrapGate.waitMs / 1000),
        );
        await reportAutomaticRecoveryStage({
          phase: "waiting_bootstrap_slot",
          message:
            bootstrapGate.reason === "recent_technical_congestion"
              ? `检测到多个节点刚发生技术卡顿，${waitSeconds} 秒后错峰打开搜索页`
              : `正在错峰启动，${waitSeconds} 秒后打开搜索页`,
          waitUntil: bootstrapGate.waitUntil,
          remainingMs: bootstrapGate.waitMs,
        });
        await sleepWithStop(bootstrapGate.waitMs, () =>
          strictClient?.shouldStop() ||
          controllerState.activeUnattendedAttemptRejected ||
          !isCurrentRequestAttempt() ||
          controllerState.batchKeywordCancelRequested ||
          Boolean(controllerState.activeCaptureTaskCancellationReason),
        );
        if (
          strictClient?.shouldStop() ||
          controllerState.activeUnattendedAttemptRejected ||
          !isCurrentRequestAttempt() ||
          controllerState.batchKeywordCancelRequested ||
          Boolean(controllerState.activeCaptureTaskCancellationReason)
        ) {
          const canceledError = new Error("无人值守错峰启动已取消");
          canceledError.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
          throw canceledError;
        }
      }

      let switchResult = null;
      try {
        switchResult = await chrome.runtime.sendMessage({
          type: "onstarvoice:switch-platform-tab",
          platform,
        });
        if (!switchResult?.ok) {
          throw new Error(
            switchResult?.error?.message || "打开平台页面失败，无法执行计划",
          );
        }
      } catch (error) {
        throw new Error(`打开平台页面失败：${error.message}`);
      }

      unattendedSourceTabId = await resolveCaptureTaskSourceTabId({
        preferredTabId: switchResult?.data?.tabId,
        platform,
      });
      unattendedCaptureTaskContext = beginTaskContext({
        taskType: "capture",
        featureKey: "capture.unattended_keyword",
        source: "unattended",
        metadata: {
          requestId,
          platform,
          keywordCount: keywords.length,
          executionMode,
        },
      });
      // 同一无人值守 request 跨 runner reload / recovery attempt 复用稳定的
      // Debug taskId。控制页只是观察与编排 UI，不再拥有任务生命周期。
      unattendedCaptureTaskContext.taskId = `unattended-capture:${requestId}`;
      const startUnattendedCaptureTaskSession = async (sourceTabId) => {
        let lastError = null;
        for (
          let attempt = 1;
          attempt <= localCaptureSessionMaxAttempts;
          attempt += 1
        ) {
          const attemptMessage =
            attempt === 1
              ? "正在启动浏览器采集辅助"
              : `正在第 ${attempt}/${localCaptureSessionMaxAttempts} 次启动浏览器采集辅助`;
          await reportAutomaticRecoveryStage({
            phase: "starting_capture_session",
            message: attemptMessage,
            attemptCurrent: attempt,
            attemptTotal: localCaptureSessionMaxAttempts,
            retried: Math.max(0, attempt - 1),
          });
          try {
            const assistSession = await startOptionalCaptureAssistSession({
              taskId: unattendedCaptureTaskContext.taskId,
              tabId: sourceTabId,
              label: `${executionCopy.captureLabel} · ${keywords.length} 个关键词`,
              platform,
              ownerRequired: false,
              attemptId: requestAttemptId,
            });
            unattendedCaptureTaskSessionStarted =
              assistSession?.active === true;
            if (assistSession?.degraded === true) {
              await reportAutomaticRecoveryStage({
                phase: "capture_assist_degraded",
                message: "浏览器采集辅助不可用，已继续执行采集",
                attemptCurrent: attempt,
                attemptTotal: localCaptureSessionMaxAttempts,
                retried: Math.max(0, attempt - 1),
              }).catch((error) => {
                console.warn(
                  "[Sidebar] Capture assist degraded status report failed (ignored):",
                  error,
                );
              });
            }
            return assistSession;
          } catch (error) {
            lastError = error;
            const code = String(error?.code || "").trim();
            const retryable = UNATTENDED_CAPTURE_SESSION_RETRYABLE_CODES.has(code);
            if (
              !retryable ||
              attempt >= localCaptureSessionMaxAttempts
            ) {
              break;
            }
            const delayMs = Math.max(
              0,
              Number(
                UNATTENDED_CAPTURE_SESSION_RETRY_DELAYS_MS[attempt - 1] ??
                  UNATTENDED_CAPTURE_SESSION_RETRY_DELAYS_MS.at(-1),
              ) || 0,
            );
            const waitUntil = new Date(Date.now() + delayMs).toISOString();
            const nextAttempt = attempt + 1;
            const waitMessage = `浏览器采集辅助暂时不可用，第 ${nextAttempt}/${localCaptureSessionMaxAttempts} 次尝试将在等待结束后开始`;
            await reportAutomaticRecoveryStage({
              phase: "waiting_capture_session_retry",
              message: waitMessage,
              attemptCurrent: nextAttempt,
              attemptTotal: localCaptureSessionMaxAttempts,
              waitUntil,
              remainingMs: delayMs,
              retried: attempt,
            });
            await sleepWithStop(delayMs, () =>
              strictClient?.shouldStop() ||
              controllerState.activeUnattendedAttemptRejected ||
              !isCurrentRequestAttempt() ||
              controllerState.batchKeywordCancelRequested ||
              Boolean(controllerState.activeCaptureTaskCancellationReason),
            );
            if (
              strictClient?.shouldStop() ||
              controllerState.activeUnattendedAttemptRejected ||
              !isCurrentRequestAttempt() ||
              controllerState.batchKeywordCancelRequested ||
              Boolean(controllerState.activeCaptureTaskCancellationReason)
            ) {
              const canceledError = new Error("无人值守采集辅助恢复已取消");
              canceledError.code = "UNATTENDED_ATTEMPT_CANCELED";
              throw canceledError;
            }
          }
        }
        const code =
          String(lastError?.code || "").trim() ||
          "CAPTURE_TASK_START_FAILED";
        const message = String(
          lastError?.message || "无法启动浏览器采集辅助",
        ).trim();
        const startError = new Error(
          `采集辅助启动失败（${code}）：${message}`,
        );
        startError.code = code;
        startError.cause = lastError;
        if (
          lastError?.details &&
          typeof lastError.details === "object" &&
          !Array.isArray(lastError.details)
        ) {
          startError.details = {...lastError.details};
        }
        throw startError;
      };
      // 抖音首个 /jingxuan -> /search 导航可能触发 Chrome Tab replacement。
      // 先让合成状态页保持可见，等拿到 replacement 后的最终 Tab id 再建立
      // 原生 Debug；小红书仍保留原来的“导航前接管”时机。
      if (captureTaskDebugSupported && platform !== "douyin") {
        await startUnattendedCaptureTaskSession(unattendedSourceTabId);
      }

      await sleepWithStop(1200, () => false);
      closeBatchModal();

      taskView.applyUnattendedKeywords(keywords);
      syncSearchFilterControlsForPlatform(platform, {
        scope: "modal",
        values: plan.searchFilters || {},
      });
      syncDetailCaptureControlsFromStoredSettings(await getCaptureSettings(), {
        platform,
      });

      taskView.applyUnattendedLoopSettings({
        plannedRounds,
        readGapMinutes: () =>
          sequentialSearchEnabled ? 0 : Math.max(0, Number(plan.roundGapMin) || 0),
      });

      const navigationResult = await navigateActiveTabToKeywordSearchForPlan({
        keyword: resumeKeyword,
        platform,
        tabId: switchResult?.data?.tabId,
        baseSearchUrl: String(
          switchResult?.data?.url || getCurrentRuntime()?.lastPageUrl || "",
        ).trim(),
        maxAttempts: localBootstrapMaxAttempts,
        shouldStop: () =>
          strictClient?.shouldStop() ||
          controllerState.activeUnattendedAttemptRejected ||
          !isCurrentRequestAttempt() ||
          controllerState.batchKeywordCancelRequested ||
          Boolean(controllerState.activeCaptureTaskCancellationReason),
        onAttempt: async ({attempt, maxAttempts}) => {
          await reportAutomaticRecoveryStage({
            phase: "opening_search_page",
            message:
              attempt === 1
                ? `正在打开关键词「${resumeKeyword}」的搜索页`
                : `正在第 ${attempt}/${maxAttempts} 次打开关键词「${resumeKeyword}」的搜索页`,
            attemptCurrent: attempt,
            attemptTotal: maxAttempts,
            retried: Math.max(0, Number(attempt) - 1),
          });
        },
        onRetry: async ({nextAttempt, maxAttempts, retryDelayMs, waitUntil}) => {
          await reportAutomaticRecoveryStage({
            phase: "waiting_search_page_retry",
            message: `搜索页被切走或尚未就绪，第 ${nextAttempt}/${maxAttempts} 次打开将在倒计时结束后开始`,
            attemptCurrent: nextAttempt,
            attemptTotal: maxAttempts,
            waitUntil,
            remainingMs: retryDelayMs,
            retried: Math.max(0, Number(nextAttempt) - 1),
          });
        },
      });
      const finalSourceTabId = Number(navigationResult?.tabId);
      const sourceTabWasReplaced =
        Number.isSafeInteger(finalSourceTabId) &&
        finalSourceTabId > 0 &&
        finalSourceTabId !== unattendedSourceTabId;
      if (Number.isSafeInteger(finalSourceTabId) && finalSourceTabId > 0) {
        unattendedSourceTabId = finalSourceTabId;
      }
      if (
        strictClient?.shouldStop() ||
        controllerState.activeUnattendedAttemptRejected ||
        !isCurrentRequestAttempt() ||
        controllerState.batchKeywordCancelRequested ||
        controllerState.detailBatchCancelRequested ||
        Boolean(controllerState.activeCaptureTaskCancellationReason)
      ) {
        const canceledError = new Error(
          `${executionCopy.taskLabel}已停止，未启动采集辅助`,
        );
        canceledError.code = "UNATTENDED_ATTEMPT_CANCELED";
        throw canceledError;
      }
      if (captureTaskDebugSupported && !unattendedCaptureTaskSessionStarted) {
        await startUnattendedCaptureTaskSession(unattendedSourceTabId);
      } else if (unattendedCaptureTaskSessionStarted && sourceTabWasReplaced) {
        const rebound = await startOptionalCaptureAssistSession({
          taskId: unattendedCaptureTaskContext.taskId,
          tabId: unattendedSourceTabId,
          label: `${executionCopy.captureLabel} · ${keywords.length} 个关键词`,
          platform,
          ownerRequired: false,
          attemptId: requestAttemptId,
        });
        if (rebound?.active !== true) {
          await reportAutomaticRecoveryStage({
            phase: "capture_assist_degraded",
            message: "浏览器页面已切换；采集辅助未恢复，但采集继续执行",
          }).catch((error) => {
            console.warn(
              "[Sidebar] Capture assist rebound report failed (ignored):",
              error,
            );
          });
        }
      }

      const delegatedReport = await reportUnattendedKeywordRun(
        requestId,
        {
          status: "running",
          message:
            sequentialSearchEnabled
              ? `已交给同一 Agent 串行执行：${searchPasses.map(unattendedSearchPassLabel).join(" → ")}`
              : plannedRounds > 1
                ? "已交给多轮采集流程执行"
              : "已交给采集流程执行",
          checkpoint,
          counts: buildUnattendedTaskCounts(
            checkpoint,
            summarizeUnattendedKeywordCheckpoint(checkpoint),
            {total: plannedTaskTotal},
          ),
          progress: {
            current: startingKeywordIndex + 1,
            total: keywords.length,
            keyword: resumeKeyword,
            keywordCurrent: startingKeywordIndex + 1,
            keywordTotal: keywords.length,
            itemCurrent: null,
            itemTotal: null,
            nextKeyword: keywords[startingKeywordIndex + 1] || "",
            progressScope: "keyword",
            round: Math.max(1, Number(checkpoint.round) || 1),
            roundCurrent: Math.max(1, Number(checkpoint.round) || 1),
            roundTotal: plannedRounds,
            phase: "delegated_to_batch_loop",
          },
        },
        {attemptId: requestAttemptId},
      );
      if (!delegatedReport?.accepted) {
        const error = new Error("当前执行已被新的恢复任务接管");
        error.code = "UNATTENDED_ATTEMPT_REPLACED";
        throw error;
      }

      reportKeywordProgress = createUnattendedKeywordProgressReporter(
        requestId,
        {
          checkpoint,
          taskTotal: plannedTaskTotal,
          attemptId: requestAttemptId,
          executionMode,
        },
      );
      const reportKeywordCheckpoint =
        createUnattendedKeywordCheckpointReporter({
          requestId,
          attemptId: requestAttemptId,
          checkpoint,
          keywords,
          taskTotal: plannedTaskTotal,
        });
      capturePipelineStarted = true;
      batchRunResult = await handleBatchKeywordCapture({
        onProgress: reportKeywordProgress,
        onKeywordSettled: reportKeywordCheckpoint,
        initialSearchEvidence: navigationResult?.initialSearchEvidence || null,
        resumeCheckpoint: checkpoint,
        maxKeywordAttempts: localKeywordMaxAttempts,
        waitForegroundTabId: null,
        sourceTabId: unattendedSourceTabId,
        executionLockOwner: "unattended_keyword_plan",
        executionLockLabel: executionCopy.taskLabel,
        captureExecutionLabel: executionCopy.captureLabel,
        executionMode,
        unattendedRequestId: requestId,
        unattendedAttemptId: requestAttemptId,
        captureTaskItemAttempts: Array.isArray(
          request?.orchestrationContext?.itemAttempts,
        )
          ? request.orchestrationContext.itemAttempts
          : [],
        searchPasses: sequentialSearchEnabled ? searchPasses : null,
        searchFilters: plan.searchFilters || {},
        disableAutomaticSearchRetry:
          plan.recoveryPolicy?.disableAutomaticSearchRetry === true,
        requireVerifiedFilters:
          plan.recoveryPolicy?.requireVerifiedFilters === true,
        keywordMaxDetectedItems:
          Object.prototype.hasOwnProperty.call(
            plan,
            "keywordMaxDetectedItems",
          )
            ? plan.keywordMaxDetectedItems
            : null,
        captureSettings:
          plan.captureSettings && typeof plan.captureSettings === "object"
            ? plan.captureSettings
            : null,
        captureTaskContext: unattendedCaptureTaskContext,
        captureTaskSessionStarted: unattendedCaptureTaskSessionStarted,
        captureTaskLifecycleOwnedByCaller:
          unattendedCaptureTaskSessionStarted,
        releaseElasticItemOnLongRetry: Boolean(
          request?.cloudAssigned === true &&
            request?.orchestrationContext?.distributionMode === "elastic_pool",
        ),
      });
      if (!batchRunResult?.started) {
        throw new Error(batchRunResult?.reason || "采集流程未启动");
      }
      if (
        batchRunResult?.ok === false && batchRunResult?.error &&
        !hasSyncReconciliationSignal(batchRunResult)
      ) {
        throw new Error(batchRunResult.error);
      }
      if (batchRunResult?.securityBlocked) {
        unattendedCaptureTaskStatus = "completed_with_failures";
        const blockingError =
          batchRunResult?.blockingError &&
          typeof batchRunResult.blockingError === "object"
            ? batchRunResult.blockingError
            : {};
        const blockingCode =
          String(blockingError?.code || "").trim().toUpperCase() ||
          "PLATFORM_SAFETY_BLOCK";
        const safetyMessage =
          String(blockingError?.message || "").trim() ||
          "检测到验证码、登录失效或平台安全限制，已暂停整批任务且不会自动连续重试";
        const safetySummary = summarizeUnattendedKeywordCheckpoint(checkpoint);
        const finishedAt = new Date().toISOString();
        await reportUnattendedTerminalRun(
          requestId,
          {
            status: "needs_action",
            finishedAt,
            checkpoint,
            summary: safetySummary,
            counts: buildUnattendedTaskCounts(checkpoint, safetySummary, {
              total: plannedTaskTotal,
            }),
            message: safetyMessage,
            progress: createTerminalProgress({
              status: "needs_action",
              finishedAt,
              message: safetyMessage,
              summary: safetySummary,
              streamingSync: batchRunResult?.streamingSync,
            }),
            error: {
              code: blockingCode,
              message: safetyMessage,
              category: String(blockingError?.category || ""),
              securityBlocked: true,
              platformSafetyBlocked: Boolean(
                blockingError?.platformSafetyBlocked,
              ),
              requiresManualAction: true,
              retryable: false,
            },
          },
          {attemptId: requestAttemptId},
        );
        return;
      }
      if (batchRunResult?.canceled) {
        const cancellation = resolveUnattendedCancellationTerminal(
          controllerState.activeCaptureTaskCancellationReason,
          batchRunResult.reason || `${executionCopy.taskLabel}已取消`,
        );
        unattendedCaptureTaskStatus = cancellation.status;
        const canceledSummary = summarizeUnattendedKeywordCheckpoint(checkpoint);
        const finishedAt = new Date().toISOString();
        await reportUnattendedTerminalRun(
          requestId,
          {
            status: cancellation.status,
            finishedAt,
            checkpoint,
            summary: canceledSummary,
            counts: buildUnattendedTaskCounts(checkpoint, canceledSummary, {
              total: plannedTaskTotal,
            }),
            message: cancellation.message,
            progress: createTerminalProgress({
              status: cancellation.status,
              finishedAt,
              message: cancellation.message,
              summary: canceledSummary,
              streamingSync: batchRunResult?.streamingSync,
            }),
            error: cancellation.error,
          },
          {attemptId: requestAttemptId},
        );
        return;
      }

      if (hasSyncReconciliationSignal(batchRunResult)) {
        const reconciliationError = buildSyncReconciliationError();
        unattendedCaptureTaskStatus = "needs_action";
        unattendedCaptureTaskError = reconciliationError;
        const summary = summarizeUnattendedKeywordCheckpoint(checkpoint);
        const finishedAt = new Date().toISOString();
        await reportUnattendedTerminalRun(
          requestId,
          {
            status: "needs_action",
            finishedAt,
            checkpoint,
            summary,
            counts: buildUnattendedTaskCounts(checkpoint, summary, {
              total: plannedTaskTotal,
            }),
            message: reconciliationError.message,
            progress: createTerminalProgress({
              status: "needs_action",
              finishedAt,
              message: reconciliationError.message,
              summary,
              streamingSync: batchRunResult.streamingSync,
            }),
            error: reconciliationError,
          },
          {attemptId: requestAttemptId},
        );
        return;
      }

      const checkpointSummary = summarizeUnattendedKeywordCheckpoint(checkpoint);
      const checkpointProcessed =
        Math.max(0, Number(checkpointSummary.completed) || 0) +
        Math.max(0, Number(checkpointSummary.failed) || 0) +
        Math.max(0, Number(checkpointSummary.partial) || 0) +
        Math.max(0, Number(checkpointSummary.skipped) || 0);
      const stats = {
        total: plannedTaskTotal,
        success:
          checkpointProcessed > 0
            ? Math.max(0, Number(checkpointSummary.completed) || 0)
            : Math.max(0, Number(batchRunResult?.totalSuccess) || 0),
        failed:
          checkpointProcessed > 0
            ? Math.max(0, Number(checkpointSummary.failed) || 0)
            : Math.max(0, Number(batchRunResult?.totalFailed) || 0),
        partial:
          checkpointProcessed > 0
            ? Math.max(0, Number(checkpointSummary.partial) || 0)
            : 0,
        skipped:
          checkpointProcessed > 0
            ? Math.max(0, Number(checkpointSummary.skipped) || 0)
            : 0,
      };
      const summary = {
        ...checkpointSummary,
        total: stats.total,
        success: stats.success,
        failed: stats.failed,
      };
      const status =
        stats.failed > 0 || stats.partial > 0
          ? "completed_with_failures"
          : "completed";
      unattendedCaptureTaskStatus = status;
      const message = `${executionCopy.taskLabel}${status === "completed_with_failures" ? "部分" : ""}完成：共 ${stats.total} 个${sequentialSearchEnabled ? "巡检步骤" : "关键词次"}，完整完成 ${stats.success}，部分完成 ${stats.partial}，失败 ${stats.failed}`;
      const finishedAt = new Date().toISOString();
      await reportUnattendedTerminalRun(
        requestId,
        {
          status,
          finishedAt,
          checkpoint,
          summary,
          counts: buildUnattendedTaskCounts(checkpoint, summary, {
            total: stats.total,
            processed:
              stats.success + stats.partial + stats.failed + stats.skipped,
            success: stats.success,
            failed: stats.failed,
            skipped: stats.skipped,
            warnings: stats.partial,
          }),
          message,
          progress: createTerminalProgress({
            status,
            finishedAt,
            message,
            summary,
            streamingSync: batchRunResult?.streamingSync,
          }),
        },
        {attemptId: requestAttemptId},
      );
    } catch (error) {
      console.error("[Sidebar] Unattended keyword plan failed:", error);
      unattendedCaptureTaskError = error;
      if (!controllerState.activeUnattendedAttemptRejected) {
        const safetyBlocked = isUnattendedSafetyBlock(error);
        const reconciliationRequired =
          hasSyncReconciliationSignal(error) ||
          hasSyncReconciliationSignal(batchRunResult);
        const elasticItemReleased =
          error?.code === "UNATTENDED_ELASTIC_ITEM_RELEASED";
        const bootstrapFailed =
          error?.code === "UNATTENDED_SEARCH_BOOTSTRAP_FAILED";
        const bootstrapCanceled =
          error?.code === "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
        const cancellation = bootstrapCanceled
          ? resolveUnattendedCancellationTerminal(
              controllerState.activeCaptureTaskCancellationReason,
              `${executionCopy.taskLabel}已取消`,
            )
          : null;
        const elasticQueueAssigned = Boolean(
          request?.cloudAssigned === true &&
            request?.orchestrationContext?.distributionMode === "elastic_pool",
        );
        const elasticTechnicalRelease = Boolean(
          !reconciliationRequired &&
          elasticQueueAssigned && (elasticItemReleased || bootstrapFailed),
        );
        if (elasticTechnicalRelease) {
          if (
            unattendedCaptureTaskSessionStarted &&
            unattendedCaptureTaskContext
          ) {
            const captureTaskEnd = await endCaptureTaskSession({
              taskId: unattendedCaptureTaskContext.taskId,
              status: "failed",
              reason: "elastic_item_released_for_handoff",
            }).catch(() => null);
            const captureTaskEnded =
              captureTaskEnd?.ok === true ||
              captureTaskEnd?.reason === "capture_task_not_found" ||
              captureTaskEnd?.response?.error?.code ===
                "capture_task_not_found";
            if (captureTaskEnded) {
              releaseCaptureTaskOwner(unattendedCaptureTaskContext.taskId);
              unattendedCaptureTaskSessionStarted = false;
            }
          }
          const releasedKeyword = String(
            error?.keyword || resumeKeyword || "",
          ).trim();
          const releasedEntry = (
            Array.isArray(checkpoint?.keywordResults)
              ? checkpoint.keywordResults
              : []
          ).find(
            (entry) => String(entry?.keyword || "").trim() === releasedKeyword,
          );
          if (releasedEntry) {
            Object.assign(releasedEntry, {
              itemLockReleased: true,
              sourceAgentCooling: false,
            });
          }
        }
        const cloudTechnicalRecovery = Boolean(
          !reconciliationRequired && request?.cloudAssigned === true &&
            (bootstrapFailed || elasticItemReleased),
        );
        const needsAction =
          reconciliationRequired || safetyBlocked ||
          (bootstrapFailed && !cloudTechnicalRecovery);
        const terminalStatus = cancellation?.status ||
          (needsAction ? "needs_action" : "failed");
        unattendedCaptureTaskStatus =
          terminalStatus === "canceled"
            ? "canceled"
            : terminalStatus === "needs_action"
              ? reconciliationRequired ? "needs_action" : "completed_with_failures"
              : "failed";
        const failureSummary = summarizeUnattendedKeywordCheckpoint(checkpoint);
        const bootstrapAttemptCount = Math.max(1, Number(error?.attempts) || 1);
        const bootstrapRecoveryCount = Math.max(0, bootstrapAttemptCount - 1);
        const bootstrapFailureCopy = bootstrapRecoveryCount > 0
          ? `搜索页首次打开并经过 ${bootstrapRecoveryCount} 次恢复仍未就绪`
          : "搜索页首次打开仍未就绪";
        const noCaptureBootstrapSync =
          bootstrapFailed &&
          capturePipelineStarted === false &&
          Math.max(0, Number(failureSummary?.saved) || 0) === 0
            ? {
                enabled: false,
                enqueuedCount: 0,
                processedCount: 0,
                successCount: 0,
                failedCount: 0,
                skippedCount: 0,
                pendingCount: 0,
                activeCount: 0,
                remainingCount: 0,
                capturedUniqueCount: 0,
                enqueuedUniqueCount: 0,
                excludedUniqueCount: 0,
                succeededUniqueCount: 0,
                blocked: false,
                canceled: false,
                drainCompleted: true,
              }
            : null;
        const terminalStreamingSync =
          error?.streamingSync ??
          batchRunResult?.streamingSync ??
          noCaptureBootstrapSync;
        const terminalMessage = reconciliationRequired && !safetyBlocked && !cancellation
          ? buildSyncReconciliationError().message
          : elasticItemReleased && !reconciliationRequired
          ? `关键词「${String(error?.keyword || resumeKeyword || "").trim()}」已解除当前 Agent 锁定并交回云端；其它空闲 Agent 可立即接力，当前 Agent 可立即领取其它任务`
          : cloudTechnicalRecovery
          ? `${bootstrapFailureCopy}，当前关键词已交回云端等待其它 Agent 接力；当前 Agent 可立即领取其它任务`
          : bootstrapFailed
            ? `${bootstrapFailureCopy}，请检查设备网络后继续`
          : cancellation?.message || error.message;
        showMessage(
          terminalStatus === "canceled"
            ? `${executionCopy.taskLabel}已取消`
            : `${executionCopy.taskLabel}${needsAction ? "需要处理" : "失败"}: ${terminalMessage}`,
          terminalStatus === "canceled" || needsAction ? "warning" : "error",
        );
        const finishedAt = new Date().toISOString();
        await reportUnattendedTerminalRun(
          requestId,
          {
            status: terminalStatus,
            finishedAt,
            checkpoint,
            summary: failureSummary,
            counts: buildUnattendedTaskCounts(checkpoint, failureSummary, {
              total: plannedTaskTotal,
            }),
            message: terminalMessage,
            progress: createTerminalProgress({
              status: terminalStatus,
              finishedAt,
              message: terminalMessage,
              summary: failureSummary,
              streamingSync: terminalStreamingSync,
            }),
            error:
              terminalStatus === "canceled"
                ? cancellation?.error || null
                : reconciliationRequired && !safetyBlocked
                  ? buildSyncReconciliationError()
                : {
                    code: safetyBlocked
                      ? "PLATFORM_SAFETY_BLOCK"
                      : error?.code || "",
                    message: terminalMessage,
                    ...(cloudTechnicalRecovery
                      ? {
                          retryable: true,
                          requiresManualAction: false,
                          category: elasticItemReleased
                            ? "elastic_item_handoff"
                            : "temporary_page_readiness",
                          ...(elasticTechnicalRelease
                            ? {
                                itemLockReleased: true,
                                sourceAgentCooling: false,
                                retryAfterMs: Math.max(
                                  0,
                                  Number(error?.retryAfterMs) || 0,
                                ),
                                retryAt: String(error?.retryAt || ""),
                              }
                            : {}),
                        }
                      : {}),
                  },
          },
          {attemptId: requestAttemptId},
        );
        error.unattendedTerminalReported = true;
      }
      throw error;
    } finally {
      const stillOwnsRequestAttempt = isCurrentRequestAttempt();
      if (
        stillOwnsRequestAttempt &&
        unattendedCaptureTaskSessionStarted &&
        unattendedCaptureTaskContext
      ) {
        if (unattendedCaptureTaskTerminalProgress) {
          await updateCaptureTaskSession({
            taskId: unattendedCaptureTaskContext.taskId,
            progress: unattendedCaptureTaskTerminalProgress,
          }).catch(() => null);
        }
        const terminal = resolveCaptureTaskTerminalStatus({
          taskStatus: unattendedCaptureTaskStatus,
          error: unattendedCaptureTaskError,
          canceled:
            unattendedCaptureTaskStatus === "canceled" ||
            controllerState.activeUnattendedAttemptRejected,
        });
        const captureTaskEnd = await endCaptureTaskSession({
          taskId: unattendedCaptureTaskContext.taskId,
          ...terminal,
        });
        const captureTaskEnded =
          captureTaskEnd?.ok === true ||
          captureTaskEnd?.reason === "capture_task_not_found" ||
          captureTaskEnd?.response?.error?.code === "capture_task_not_found";
        if (captureTaskEnded) {
          releaseCaptureTaskOwner(unattendedCaptureTaskContext.taskId);
        }
      }
      if (stillOwnsRequestAttempt && unattendedCaptureTaskContext) {
        completeTaskContext({
          taskType: unattendedCaptureTaskContext.taskType,
          featureKey: unattendedCaptureTaskContext.featureKey,
        });
      }
      closeBatchModal();
      await loadKeywordPlanUI();
    }
  }

  return Object.freeze({
    maybeClaimAndRunUnattendedKeywordPlan,
    buildSidebarKeywordSearchUrl,
    waitForActiveTabReady,
    waitForRuntimeSearchPage,
    resolveUnattendedBootstrapStartGate,
    navigateActiveTabToKeywordSearchForPlan,
    buildUnattendedTaskCounts,
    buildUnattendedTerminalProgress,
    createUnattendedKeywordCheckpointReporter,
    runUnattendedKeywordPlanRequest,
  });
}
