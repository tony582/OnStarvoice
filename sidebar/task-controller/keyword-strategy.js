// L3-B keyword-strategy: explicit application responsibility.
export function createKeywordStrategyController({controllerState, controllerPorts, controllerOperations}) {
  const {
    BENCHMARK_DISCOVERY_PROFILE_LIMIT,
    BENCHMARK_DISCOVERY_RESULT_LIMIT,
    KEYWORD_OPPORTUNITY_ANALYSIS_COST_CREDITS,
    MESSAGE_TYPE,
    PAGE_TYPE,
    analyzeBenchmarkDiscovery,
    analyzeKeywordOpportunity,
    captureTabContent,
    chrome,
    console,
    ensureAuthVerifiedOrWarn,
    formatKeywordStrategyAccessError,
    getBenchmarkDiscoveryAuthRequiredMessage,
    getCaptureSettings,
    getCurrentAuth,
    getCurrentRuntime,
    getKeywordOpportunityAuthRequiredMessage,
    getPagePlatform,
    getPlatformCapabilities,
    getPlatformCopy,
    getViewPlatform,
    hideProgress,
    isAuthVerified,
    recordDiagnosticAction,
    recordDiagnosticError,
    refreshVerifiedAuthSnapshot,
    showMessage,
    showProgress,
    wait,
  } = controllerPorts;
  const beginSidebarTask = (...args) => controllerOperations.beginSidebarTask(...args);
  const clearKeywordOpportunityDraft = (...args) => controllerOperations.clearKeywordOpportunityDraft(...args);
  const finishSidebarTask = (...args) => controllerOperations.finishSidebarTask(...args);
  const getCurrentSearchKeyword = (...args) => controllerOperations.getCurrentSearchKeyword(...args);
  const getKeywordOpportunityDraft = (...args) => controllerOperations.getKeywordOpportunityDraft(...args);
  const normalizeRepresentativeSampleItems = (...args) => controllerOperations.normalizeRepresentativeSampleItems(...args);
  const persistCurrentBatchDraft = (...args) => controllerOperations.persistCurrentBatchDraft(...args);
  const requestCaptureCancelSignal = (...args) => controllerOperations.requestCaptureCancelSignal(...args);
  const updateKeywordOpportunityDraft = (...args) => controllerOperations.updateKeywordOpportunityDraft(...args);
  const renderKeywordStrategyPanel = (...args) => controllerPorts.taskView.renderKeywordStrategyPanel(...args);

  function selectKeywordStrategyTab(tab = "opportunity") {
    const selectedTab = tab === "longtail" || tab === "benchmark" ? tab : "opportunity";
    controllerPorts.taskView.setStrategyActiveTab(selectedTab);
    if (selectedTab === "longtail") {
      const runtime = getCurrentRuntime();
      const pagePlatform = getPagePlatform(runtime);
      const selectedPlatform = getViewPlatform(runtime);
      if (
        runtime?.pageType === PAGE_TYPE.SEARCH_RESULTS &&
        selectedPlatform === pagePlatform &&
        getPlatformCapabilities(pagePlatform).captureSearch
      ) {
        controllerOperations.syncSeedKeywordFromCurrentSearch(getCurrentSearchKeyword(runtime));
      } else {
        controllerPorts.taskView.updateExpandKeywordsButtonState();
      }
      controllerPorts.taskView.renderKeywordInsightState();
    }
    renderKeywordStrategyPanel();
  }
  function openKeywordLongtail() {
    const currentKeyword = getCurrentSearchKeyword(getCurrentRuntime());
    controllerOperations.syncSeedKeywordFromCurrentSearch(currentKeyword, {autoFillOnly: true});
    controllerPorts.taskView.setStrategyPanelVisible(true);
    selectKeywordStrategyTab("longtail");
  }

  function normalizeBenchmarkDiscoveryItems(items = []) {
    return items
      .map((item) => {
        const authorName = String(
          item?.authorName || item?.author || item?.nickname || "",
        ).trim();
        return {
          noteId: String(item?.noteId || "").trim(),
          url: String(item?.url || item?.noteUrl || item?.detailPageUrl || "").trim(),
          title: String(item?.title || "").trim(),
          summary: String(
            item?.summary ||
              item?.desc ||
              item?.description ||
              item?.content ||
              item?.text ||
              "",
          )
            .trim()
            .slice(0, 240),
          authorName,
          authorProfileUrl: String(
            item?.authorProfileUrl ||
              item?.profileUrl ||
              item?.authorUrl ||
              item?.bloggerUrl ||
              "",
          ).trim(),
          publishTime: String(
            item?.publishTime || item?.publishDate || item?.lastEditedAt || "",
          ).trim(),
          likes: Number(item?.likes) || 0,
          comments: Number(item?.comments) || 0,
          collects: Number(item?.collects) || 0,
          noteType: String(item?.noteType || "").trim(),
          cover: String(item?.cover || item?.coverImageUrl || "").trim(),
        };
      })
      .filter((item) => item.url && item.authorName);
  }
  function calculateBenchmarkEngagement(item) {
    return (
      (Number(item?.likes) || 0) +
      (Number(item?.comments) || 0) +
      (Number(item?.collects) || 0)
    );
  }
  function averageBenchmarkValues(values = []) {
    return values.length === 0
      ? 0
      : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  function normalizeBenchmarkProfilePayload(profile) {
    if (!profile || typeof profile !== "object") {
      return null;
    }
    const followersCount =
      Number(profile.followersCount ?? profile.bloggerFollowersCount) || 0;
    const likedAndCollectedCount =
      Number(
        profile.likedAndCollectedCount ??
          profile.bloggerLikedAndCollectedCount,
      ) || 0;
    const normalized = {
      bloggerName: String(profile.bloggerName || "").trim(),
      bloggerId: String(profile.bloggerId || "").trim(),
      bloggerUrl: String(
        profile.bloggerUrl || profile.bloggerProfileUrl || "",
      ).trim(),
      avatarUrl: String(profile.avatarUrl || "").trim(),
      description: String(profile.description || "").trim(),
      followersCount,
      likedAndCollectedCount,
      bloggerAccountType: String(profile.bloggerAccountType || "").trim(),
      captureStatus: String(profile.bloggerMetricsCaptureStatus || "").trim(),
      captureError: String(profile.bloggerMetricsCaptureError || "").trim(),
    };

    if (
      !normalized.description &&
      !normalized.followersCount &&
      !normalized.likedAndCollectedCount &&
      !normalized.bloggerName
    ) {
      return null;
    }
    return normalized;
  }
  function buildBenchmarkDiscoveryRuleReason(candidate) {
    const followersCount = Number(candidate.profile?.followersCount) || 0;
    const isLowFollower = followersCount > 0 && followersCount <= 50000;
    const hasHighPerformance =
      candidate.maxLikes >= 5000 || candidate.averageLikes >= 800;
    const likeFollowerRatio =
      followersCount > 0 ? candidate.maxLikes / followersCount : 0;
    const isLowFollowerBreakout =
      isLowFollower && (hasHighPerformance || likeFollowerRatio >= 0.1);
    let judgment = "可作为观察对象";
    if (isLowFollowerBreakout) {
      judgment = "有低粉爆款信号，适合优先对标它的选题切口";
    } else if (candidate.performanceDensity === "stable") {
      judgment = "多篇内容表现稳定，适合看它如何持续切同一类需求";
    } else if (candidate.performanceDensity === "spike") {
      judgment = "有明显爆款样本，适合拆解单篇选题为什么成立";
    } else {
      judgment = "在当前搜索词下重复露出，可以先作为备选对标";
    }

    return `${judgment}。`;
  }
  function buildBenchmarkDiscoveryFocusAssessment(candidate) {
    const description = String(candidate.profile?.description || "").trim();
    const titles = Array.isArray(candidate.topItems)
      ? candidate.topItems.map((item) => item.title).filter(Boolean)
      : [];
    if (!description) {
      return titles.length > 1
        ? "当前先按代表内容判断方向关联，主页资料不足时需要打开主页复核。"
        : "当前只能按搜索样本判断，方向关联需要打开主页复核。";
    }
    if (titles.length > 1) {
      return "已结合主页定位和代表内容判断账号是否围绕同一类需求持续产出。";
    }
    return "已结合主页定位判断账号是否适合作为这个方向的对标。";
  }
  function buildBenchmarkDiscoveryDecisionAngle(candidate, analysis = {}) {
    const followersCount = Number(candidate.profile?.followersCount) || 0;
    const likeFollowerRatio =
      followersCount > 0 && Number(candidate.maxLikes) > 0
        ? candidate.maxLikes / followersCount
        : 0;
    const isLowFollowerBreakout =
      followersCount > 0 &&
      followersCount <= 50000 &&
      (candidate.maxLikes >= 5000 ||
        candidate.averageLikes >= 800 ||
        likeFollowerRatio >= 0.1);
    if (analysis.growthPotential === "high" || isLowFollowerBreakout) {
      return "判断角度：低粉爆款信号、普通账号可复制性";
    }
    if (candidate.performanceDensity === "stable") {
      return "判断角度：持续产出能力、赛道聚焦度";
    }
    if (candidate.performanceDensity === "spike") {
      return "判断角度：单篇爆款选题、内容切口可拆解性";
    }
    return "判断角度：方向相关性、是否值得持续观察";
  }
  function buildBenchmarkDiscoveryFallbackAnalysis(candidate) {
    return {
      key: candidate.key,
      recommendationReason: buildBenchmarkDiscoveryRuleReason(candidate),
      focusAssessment: buildBenchmarkDiscoveryFocusAssessment(candidate),
      growthPotential:
        (Number(candidate.profile?.followersCount) || 0) > 0 &&
        (Number(candidate.profile?.followersCount) || 0) <= 50000 &&
        candidate.averageLikes >= 800
          ? "high"
          : candidate.performanceDensity === "stable"
            ? "medium"
            : "low",
      tags: [
        candidate.performanceDensity === "stable" ? "多篇稳定" : "样本重复",
        (Number(candidate.profile?.followersCount) || 0) > 0 &&
        (Number(candidate.profile?.followersCount) || 0) <= 50000
          ? "低粉爆款观察"
          : "方向相关",
      ],
    };
  }
  function buildBenchmarkDiscoveryCandidates(
    items = [],
    {keyword = "", platform = ""} = {},
  ) {
    const normalizedItems = normalizeBenchmarkDiscoveryItems(items);
    const groups = new Map();

    normalizedItems.forEach((item) => {
      const key = String(item.authorProfileUrl || item.authorName).trim();
      if (!key) {
        return;
      }
      const previous = groups.get(key) || {
        key,
        authorName: item.authorName,
        authorProfileUrl: item.authorProfileUrl,
        items: [],
      };
      if (!previous.authorProfileUrl && item.authorProfileUrl) {
        previous.authorProfileUrl = item.authorProfileUrl;
      }
      previous.items.push(item);
      groups.set(key, previous);
    });

    const grouped = Array.from(groups.values());
    const twoPlusCount = grouped.filter((group) => group.items.length >= 2).length;
    let minOccurrence = twoPlusCount > BENCHMARK_DISCOVERY_RESULT_LIMIT ? 3 : 2;
    if (!grouped.some((group) => group.items.length >= minOccurrence)) {
      minOccurrence = 2;
    }

    const candidates = grouped
      .filter((group) => group.items.length >= minOccurrence)
      .map((group) => {
        const sortedItems = [...group.items].sort(
          (left, right) =>
            calculateBenchmarkEngagement(right) -
            calculateBenchmarkEngagement(left),
        );
        const likes = sortedItems.map((item) => Number(item.likes) || 0);
        const comments = sortedItems.map((item) => Number(item.comments) || 0);
        const collects = sortedItems.map((item) => Number(item.collects) || 0);
        const totalEngagement = sortedItems.reduce(
          (sum, item) => sum + calculateBenchmarkEngagement(item),
          0,
        );
        const avgEngagement = Math.round(totalEngagement / sortedItems.length);
        const maxLikes = Math.max(...likes, 0);
        const averageLikes = averageBenchmarkValues(likes);
        const averageComments = averageBenchmarkValues(comments);
        const averageCollects = averageBenchmarkValues(collects);
        const performanceDensity =
          sortedItems.length >= 3 && averageLikes >= 100
            ? "stable"
            : maxLikes >= Math.max(averageLikes * 2, 200)
              ? "spike"
              : "observed";
        const score =
          sortedItems.length * 1000000 +
          Math.min(maxLikes, 999999) +
          avgEngagement * 0.2 +
          (performanceDensity === "stable" ? 50000 : 0);
        const candidate = {
          key: group.key,
          keyword,
          platform,
          authorName: group.authorName,
          authorProfileUrl: group.authorProfileUrl,
          occurrenceCount: sortedItems.length,
          minOccurrence,
          maxLikes,
          averageLikes,
          averageComments,
          averageCollects,
          avgEngagement,
          totalEngagement,
          performanceDensity,
          profile: null,
          profileCaptureStatus: group.authorProfileUrl ? "pending" : "missing_url",
          profileCaptureError: "",
          topItems: sortedItems.slice(0, 4),
          score,
        };
        return {
          ...candidate,
          analysis: buildBenchmarkDiscoveryFallbackAnalysis(candidate),
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, BENCHMARK_DISCOVERY_RESULT_LIMIT);

    return {
      keyword,
      platform,
      sampleCount: normalizedItems.length,
      candidateCount: candidates.length,
      minOccurrence,
      profileLimit: BENCHMARK_DISCOVERY_PROFILE_LIMIT,
      generatedAt: Date.now(),
      aiStatus: "not_run",
      aiError: "",
      candidates,
    };
  }
  function mergeBenchmarkProfilesIntoResult(result, profileByKey) {
    const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
    return {
      ...result,
      candidates: candidates.map((candidate) => {
        const patch = profileByKey.get(candidate.key);
        const next = patch
          ? {
              ...candidate,
              ...patch,
            }
          : candidate;
        return {
          ...next,
          analysis: buildBenchmarkDiscoveryFallbackAnalysis(next),
        };
      }),
    };
  }
  function mergeBenchmarkAiAnalysisIntoResult(result, aiData) {
    const analyses = Array.isArray(aiData?.candidateAnalyses)
      ? aiData.candidateAnalyses
      : [];
    const analysisByKey = new Map(
      analyses
        .filter((item) => item?.key)
        .map((item) => [String(item.key), item]),
    );

    return {
      ...result,
      aiStatus: analyses.length > 0 ? "done" : "empty",
      aiError: "",
      candidates: (Array.isArray(result?.candidates) ? result.candidates : []).map(
        (candidate) => {
          const ai = analysisByKey.get(candidate.key);
          if (!ai) {
            return candidate;
          }
          return {
            ...candidate,
            analysis: {
              ...candidate.analysis,
              recommendationReason:
                String(ai.recommendationReason || "").trim() ||
                candidate.analysis?.recommendationReason ||
                buildBenchmarkDiscoveryRuleReason(candidate),
              focusAssessment:
                String(ai.focusAssessment || "").trim() ||
                candidate.analysis?.focusAssessment ||
                buildBenchmarkDiscoveryFocusAssessment(candidate),
              growthPotential:
                ai.growthPotential === "high" ||
                ai.growthPotential === "medium" ||
                ai.growthPotential === "low"
                  ? ai.growthPotential
                  : candidate.analysis?.growthPotential || "medium",
              tags: Array.isArray(ai.tags) && ai.tags.length > 0
                ? ai.tags.slice(0, 4)
                : candidate.analysis?.tags || [],
            },
          };
        },
      ),
    };
  }
  function setKeywordBenchmarkLoading(title, meta) {
    controllerState.keywordBenchmarkAnalysisStatus = "loading";
    controllerState.keywordBenchmarkLoadingTitle = title;
    controllerState.keywordBenchmarkLoadingMeta = meta;
    renderKeywordStrategyPanel();
  }
  function buildKeywordOpportunityInputItems(items = []) {
    return items
      .map((item) => ({
        noteId: String(item?.noteId || "").trim(),
        url: String(item?.url || "").trim(),
        title: String(item?.title || "").trim(),
        authorName: String(
          item?.authorName || item?.author || item?.nickname || "",
        ).trim(),
        publishTime: String(
          item?.publishTime || item?.publishDate || item?.lastEditedAt || "",
        ).trim(),
        likes: Number(item?.likes) || 0,
        comments: Number(item?.comments) || 0,
        collects: Number(item?.collects) || 0,
        noteType: String(item?.noteType || "").trim(),
        cover: String(item?.cover || item?.coverImageUrl || "").trim(),
      }))
      .filter((item) => item.url);
  }
  function analyzeKeywordOpportunityRules(items = []) {
    const normalizedItems = buildKeywordOpportunityInputItems(items).sort(
      (left, right) => right.likes - left.likes,
    );
    const likes = normalizedItems.map((item) =>
      Math.max(0, Number(item.likes) || 0),
    );
    const average = (values) =>
      values.length === 0
        ? 0
        : Math.round(
            values.reduce((sum, value) => sum + value, 0) / values.length,
          );
    const percentile = (values, p) => {
      if (values.length === 0) {
        return 0;
      }
      const sorted = [...values].sort((left, right) => left - right);
      const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * p) - 1),
      );
      return sorted[index] || 0;
    };

    const maxLikes = likes[0] || 0;
    const top5AvgLikes = average(likes.slice(0, 5));
    const top10AvgLikes = average(likes.slice(0, 10));
    const medianLikes = percentile(likes, 0.5);
    const p80Likes = percentile(likes, 0.8);
    const p90Likes = percentile(likes, 0.9);

    let cliffIndex = 0;
    let cliffDropRatio = 0;
    likes.slice(0, Math.min(20, likes.length) - 1).forEach((current, index) => {
      const next = likes[index + 1] || 0;
      if (current <= 0) {
        return;
      }
      const dropRatio = (current - next) / current;
      const prefixCount = index + 1;
      const prefixAvg = average(likes.slice(0, prefixCount));
      if (prefixCount < 3) {
        return;
      }
      if (prefixAvg < Math.max(medianLikes * 1.5, 200)) {
        return;
      }
      if (dropRatio >= 0.25 && dropRatio > cliffDropRatio) {
        cliffDropRatio = dropRatio;
        cliffIndex = prefixCount;
      }
    });

    const fallbackHighBandCount = Math.min(
      12,
      Math.max(5, Math.ceil(normalizedItems.length * 0.1)),
    );
    const highBandCount =
      cliffIndex > 0
        ? cliffIndex
        : Math.min(normalizedItems.length, fallbackHighBandCount);

    return {
      sortedItems: normalizedItems,
      highBandCount,
      cliffIndex,
      cliffDropRatio,
      maxLikes,
      top5AvgLikes,
      top10AvgLikes,
      medianLikes,
      p80Likes,
      p90Likes,
      highBandAvgLikes: average(likes.slice(0, highBandCount)),
      midBandAvgLikes: average(
        likes.slice(
          highBandCount,
          Math.min(normalizedItems.length, highBandCount * 2),
        ),
      ),
    };
  }
  function selectKeywordOpportunitySamples(items = []) {
    const analysis = analyzeKeywordOpportunityRules(items);
    const all = analysis.sortedItems;
    const highEnd = analysis.highBandCount;
    const midEnd = Math.max(highEnd, Math.ceil(all.length / 2));

    const highBand = all.slice(0, highEnd);
    const midBand = all.slice(highEnd, midEnd);
    const lowBand = all.slice(midEnd);

    const selectedIndexes = new Set();
    const selected = [];
    const pick = (item) => {
      const key = item?.noteId || item?.url || "";
      if (!key || selectedIndexes.has(key)) {
        return;
      }
      selectedIndexes.add(key);
      selected.push(item);
    };

    for (let i = 0; i < Math.min(5, highBand.length); i += 1) {
      pick(highBand[i]);
    }
    if (highBand.length > 6) {
      pick(highBand[Math.floor(highBand.length / 2)]);
      pick(highBand[highBand.length - 1]);
    }

    for (let i = 0; i < Math.min(3, midBand.length); i += 1) {
      pick(midBand[i]);
    }
    if (midBand.length > 4) {
      pick(midBand[Math.floor(midBand.length / 2)]);
    }

    for (let i = 0; i < Math.min(2, lowBand.length); i += 1) {
      pick(lowBand[i]);
    }
    if (lowBand.length > 3) {
      pick(lowBand[Math.floor(lowBand.length / 2)]);
    }

    return selected.slice(0, 15);
  }
  async function waitForTabComplete(
    tabId,
    {timeoutMs = 15000, settleMs = 1200} = {},
  ) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (controllerPorts.strictCaptureClient?.shouldStop()) {
        const error = new Error('capture_strict_stopped');
        error.code = 'capture_strict_stopped';
        throw error;
      }
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === "complete") {
        if (settleMs > 0) {
          await wait(settleMs);
        }
        return tab;
      }
      await wait(250);
    }
    throw new Error("页面加载超时，请稍后重试");
  }
  async function prepareKeywordStrategyCapture(tabId) {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId,
      payload: {
        action: "prepareKeywordStrategyCapture",
      },
    });

    const result =
      response?.data && typeof response.data === "object" && "ok" in response.data
        ? response.data
        : response;

    if (!response?.ok || !result?.ok) {
      throw new Error(
        result?.error?.message ||
          response?.error?.message ||
          "页面筛选条件切换失败",
      );
    }

    return result?.data || {};
  }
  async function captureKeywordOpportunitySamples({
    sourceTabId,
    sourceTabUrl,
    sampleItems,
    initialSamples = [],
    onSampleCaptured = null,
    shouldStop = null,
  }) {
    if (controllerPorts.strictCaptureClient) {
      const originalShouldStop = shouldStop;
      shouldStop = () => controllerPorts.strictCaptureClient.shouldStop() ||
        Boolean(originalShouldStop?.());
    }
    if (!sourceTabUrl) {
      throw new Error("未找到当前搜索页链接");
    }
    if (!Number.isFinite(Number(sourceTabId)) || Number(sourceTabId) <= 0) {
      throw new Error("未找到当前搜索页标签");
    }

    const sampleKeyFor = (item) => String(item?.noteId || item?.url || "").trim();
    const samples = normalizeRepresentativeSampleItems(initialSamples);
    const completedSampleKeys = new Set(samples.map((item) => sampleKeyFor(item)));
    try {
      for (let index = 0; index < sampleItems.length; index += 1) {
        const item = sampleItems[index];
        if (typeof shouldStop === "function" && shouldStop()) {
          throw new Error("已取消判断赛道机会");
        }
        const sampleKey = sampleKeyFor(item);
        if (sampleKey && completedSampleKeys.has(sampleKey)) {
          continue;
        }
        const completedCount = completedSampleKeys.size;
        showProgress(
          `正在当前页面采集代表爆款详情（${completedCount + 1}/${sampleItems.length}）...`,
        );
        await chrome.tabs.update(sourceTabId, {
          url: item.url,
          active: true,
        });
        await waitForTabComplete(sourceTabId, {
          timeoutMs: 20000,
          settleMs: 1800,
        });
        const result = await captureTabContent(sourceTabId, {
          mode: "single",
          captureParams: {},
        });
        const detail =
          result?.data && typeof result.data === "object" ? result.data : null;
        if (!detail) {
          continue;
        }
        const normalizedSample = {
          noteId: String(detail.noteId || item.noteId || "").trim(),
          url: String(detail.url || item.url || "").trim(),
          title: String(detail.title || item.title || "").trim(),
          authorName: String(detail.author || item.authorName || "").trim(),
          publishTime: String(
            detail.lastEditedAt || detail.publishDate || item.publishTime || "",
          ).trim(),
          likes: Number(detail.likes ?? item.likes) || 0,
          comments: Number(detail.comments ?? item.comments) || 0,
          collects: Number(detail.collects ?? item.collects) || 0,
          noteType: String(detail.noteType || item.noteType || "").trim(),
          cover: String(detail.coverImageUrl || item.cover || "").trim(),
          content: String(detail.content || "").trim(),
          tags: Array.isArray(detail.tags)
            ? detail.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
            : [],
          authorFollowerCount:
            Number(detail.bloggerFollowersCount || detail.authorFollowerCount) ||
            0,
        };
        samples.push(normalizedSample);
        if (sampleKey) {
          completedSampleKeys.add(sampleKey);
        }
        if (typeof onSampleCaptured === "function") {
          const checkpoint = onSampleCaptured([...samples], normalizedSample);
          if (controllerPorts.strictCaptureClient) await checkpoint;
        }
        await wait(500);
      }
    } finally {
      try {
        await chrome.tabs.update(sourceTabId, {
          url: sourceTabUrl,
          active: true,
        });
        await waitForTabComplete(sourceTabId, {
          timeoutMs: 20000,
          settleMs: 1500,
        });
      } catch (error) {
        console.warn(
          "[Sidebar] Restore keyword strategy search page failed:",
          error,
        );
      }
    }

    return samples;
  }
  async function handleCancelKeywordOpportunity() {
    if (!controllerState.keywordOpportunityInFlight) {
      return;
    }
    controllerState.keywordOpportunityCancelRequested = true;
    await requestCaptureCancelSignal();
    showProgress("正在停止判断赛道机会...", "warning");
  }
  async function handleCancelBenchmarkDiscovery() {
    if (!controllerState.keywordBenchmarkInFlight) {
      return;
    }
    controllerState.keywordBenchmarkCancelRequested = true;
    await requestCaptureCancelSignal();
    showProgress("正在停止找对标账号...", "warning");
  }
  async function captureBenchmarkCandidateProfiles({
    sourceTabId,
    sourceTabUrl,
    candidates = [],
    shouldStop = null,
  }) {
    if (controllerPorts.strictCaptureClient) {
      const originalShouldStop = shouldStop;
      shouldStop = () => controllerPorts.strictCaptureClient.shouldStop() ||
        Boolean(originalShouldStop?.());
    }
    const profileTargets = candidates
      .filter((candidate) => candidate.authorProfileUrl)
      .slice(0, BENCHMARK_DISCOVERY_PROFILE_LIMIT);
    const profileByKey = new Map();

    if (!profileTargets.length) {
      return profileByKey;
    }

    try {
      for (let index = 0; index < profileTargets.length; index += 1) {
        if (typeof shouldStop === "function" && shouldStop()) {
          throw new Error("已取消找对标账号");
        }
        const candidate = profileTargets[index];
        showProgress(
          `正在补采候选账号主页（${index + 1}/${profileTargets.length}）...`,
        );
        try {
          await chrome.tabs.update(sourceTabId, {
            url: candidate.authorProfileUrl,
            active: true,
          });
          await waitForTabComplete(sourceTabId, {
            timeoutMs: 20000,
            settleMs: 1600,
          });
          const result = await captureTabContent(sourceTabId, {
            mode: "blogger_profile",
            captureParams: {},
          });
          const profile = normalizeBenchmarkProfilePayload(result?.data);
          if (!result?.ok || !profile) {
            throw new Error(
              result?.error?.message || "账号主页资料采集失败",
            );
          }
          profileByKey.set(candidate.key, {
            profile,
            profileCaptureStatus: "done",
            profileCaptureError: "",
            authorProfileUrl:
              profile.bloggerUrl || candidate.authorProfileUrl || "",
            authorName:
              profile.bloggerName || candidate.authorName || "",
          });
        } catch (error) {
          profileByKey.set(candidate.key, {
            profile: null,
            profileCaptureStatus: "failed",
            profileCaptureError:
              error?.message || "账号主页资料采集失败",
          });
        }
        await wait(400);
      }
    } finally {
      try {
        await chrome.tabs.update(sourceTabId, {
          url: sourceTabUrl,
          active: true,
        });
        await waitForTabComplete(sourceTabId, {
          timeoutMs: 20000,
          settleMs: 1200,
        });
      } catch (error) {
        console.warn("[Sidebar] Restore benchmark search page failed:", error);
      }
    }

    return profileByKey;
  }
  function buildBenchmarkDiscoveryAiCandidates(result) {
    const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
    return candidates.slice(0, BENCHMARK_DISCOVERY_PROFILE_LIMIT).map((candidate) => ({
      key: candidate.key,
      authorName: candidate.profile?.bloggerName || candidate.authorName || "",
      authorProfileUrl: candidate.authorProfileUrl || "",
      occurrenceCount: Number(candidate.occurrenceCount) || 0,
      maxLikes: Number(candidate.maxLikes) || 0,
      averageLikes: Number(candidate.averageLikes) || 0,
      averageComments: Number(candidate.averageComments) || 0,
      averageCollects: Number(candidate.averageCollects) || 0,
      avgEngagement: Number(candidate.avgEngagement) || 0,
      totalEngagement: Number(candidate.totalEngagement) || 0,
      performanceDensity: candidate.performanceDensity || "",
      ruleReason:
        candidate.analysis?.recommendationReason ||
        buildBenchmarkDiscoveryRuleReason(candidate),
      profile: candidate.profile
        ? {
            bloggerName: candidate.profile.bloggerName || "",
            description: candidate.profile.description || "",
            followersCount: Number(candidate.profile.followersCount) || 0,
            likedAndCollectedCount:
              Number(candidate.profile.likedAndCollectedCount) || 0,
            bloggerAccountType: candidate.profile.bloggerAccountType || "",
          }
        : null,
      topItems: (Array.isArray(candidate.topItems) ? candidate.topItems : [])
        .slice(0, 4)
        .map((item) => ({
          title: item.title || "",
          summary: item.summary || "",
          url: item.url || "",
          likes: Number(item.likes) || 0,
          comments: Number(item.comments) || 0,
          collects: Number(item.collects) || 0,
        })),
    }));
  }
  async function enrichBenchmarkDiscoveryWithAi({
    keyword,
    platform,
    result,
    taskContext = null,
  }) {
    if (!isAuthVerified(getCurrentAuth())) {
      void recordDiagnosticAction({
        taskContext,
        source: "sidebar",
        action: "benchmark_ai_skipped",
        status: "skipped",
        metadata: {
          reason: "auth_not_verified",
          keyword,
          platform,
        },
      }).catch(() => null);
      return {
        ...result,
        aiStatus: "skipped",
        aiError: "auth_not_verified",
      };
    }

    const candidates = buildBenchmarkDiscoveryAiCandidates(result);
    if (!candidates.length) {
      void recordDiagnosticAction({
        taskContext,
        source: "sidebar",
        action: "benchmark_ai_skipped",
        status: "skipped",
        metadata: {
          reason: "empty_candidates",
          keyword,
          platform,
        },
      }).catch(() => null);
      return {
        ...result,
        aiStatus: "empty",
        aiError: "",
      };
    }

    try {
      showProgress("正在判断账号对标价值...");
      void recordDiagnosticAction({
        taskContext,
        source: "sidebar",
        action: "benchmark_ai_start",
        status: "started",
        metadata: {
          keyword,
          platform,
          candidateCount: candidates.length,
        },
      }).catch(() => null);
      const response = await analyzeBenchmarkDiscovery({
        keyword,
        platform,
        candidates,
      });
      if (!response?.ok || !response?.data) {
        const error = new Error(
          response?.error?.message ||
            response?.message ||
            "对标账号判断暂时不可用",
        );
        error.reason = response?.error?.reason || response?.reason || "";
        error.data = response?.error?.data || response?.data || null;
        throw error;
      }
      void recordDiagnosticAction({
        taskContext,
        source: "sidebar",
        action: "benchmark_ai_finish",
        status: "completed",
        metadata: {
          keyword,
          platform,
          candidateCount: candidates.length,
          analysisCount: Array.isArray(response.data?.candidateAnalyses)
            ? response.data.candidateAnalyses.length
            : 0,
        },
      }).catch(() => null);
      return mergeBenchmarkAiAnalysisIntoResult(result, response.data);
    } catch (error) {
      const reason = String(
        error?.reason || error?.error?.reason || "",
      ).toLowerCase();
      if (reason === "insufficient_balance") {
        void refreshVerifiedAuthSnapshot();
      }
      void recordDiagnosticError({
        taskContext,
        source: "sidebar",
        action: "benchmark_ai_finish",
        status: "failed",
        error: {
          reason: reason || "benchmark_ai_failed",
          message: error?.message || "benchmark ai analysis failed",
        },
        metadata: {
          keyword,
          platform,
          candidateCount: candidates.length,
        },
      }).catch(() => null);
      return {
        ...result,
        aiStatus: "failed",
        aiError: error?.message || reason || "benchmark_ai_failed",
      };
    }
  }
  async function handleRunBenchmarkDiscovery() {
    const runtime = getCurrentRuntime();
    const selectedPlatform = getViewPlatform(runtime);
    const pagePlatform = getPagePlatform(runtime);
    if (selectedPlatform !== pagePlatform) {
      const platformCopy = getPlatformCopy(selectedPlatform);
      showMessage(
        `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再发现`,
        "error",
      );
      return;
    }
    if (runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS) {
      showMessage("请先切换到搜索页", "error");
      return;
    }
    if (
      !ensureAuthVerifiedOrWarn({
        message: getBenchmarkDiscoveryAuthRequiredMessage(),
      })
    ) {
      return;
    }

    const keyword = getCurrentSearchKeyword(runtime);
    if (!keyword) {
      showMessage("未检测到当前搜索词，请先完成搜索后再发现", "warning");
      return;
    }
    if (controllerState.keywordBenchmarkInFlight || controllerState.keywordOpportunityInFlight) {
      showMessage("赛道策略分析进行中，请稍候", "warning");
      return;
    }

    controllerPorts.taskView.setStrategyPanelVisible(true);
    controllerPorts.taskView.setStrategyActiveTab("benchmark");
    controllerState.keywordBenchmarkInFlight = true;
    controllerState.keywordBenchmarkCancelRequested = false;
    controllerState.keywordBenchmarkStartedAt = Date.now();
    controllerState.keywordBenchmarkErrorMessage = "";
    controllerState.keywordBenchmarkResult = null;
    controllerState.keywordBenchmarkAnalysisStatus = "loading";
    controllerState.keywordBenchmarkLoadingTitle = "正在查找候选账号";
    controllerState.keywordBenchmarkLoadingMeta =
      "会先采集前 80 条搜索结果，再补采入围账号主页";
    renderKeywordStrategyPanel();

    const taskContext = beginSidebarTask({
      taskType: "analysis",
      featureKey: "benchmark.account_discovery",
      metadata: {
        platform: pagePlatform,
        pageType: runtime?.pageType || "",
        keyword,
      },
    });
    let taskStatus = "completed";
    let taskError = null;

    try {
      const [sourceTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!sourceTab?.id || !sourceTab.url) {
        throw new Error("未找到当前搜索页标签");
      }

      const settings = await getCaptureSettings();
      setKeywordBenchmarkLoading(
        "正在整理搜索样本",
        "正在切换到最近半年和最多点赞，准备采集高表现内容",
      );
      showProgress("正在切换到最近半年 + 最多点赞...");
      await prepareKeywordStrategyCapture(sourceTab.id);
      if (controllerState.keywordBenchmarkCancelRequested) {
        throw new Error("已取消找对标账号");
      }

      const refreshedSourceTab = await chrome.tabs.get(sourceTab.id);
      const sourceTabUrl = String(
        refreshedSourceTab?.url || sourceTab.url || "",
      ).trim();
      setKeywordBenchmarkLoading(
        "正在筛选候选账号",
        "正在采集主词前 80 条高表现搜索结果",
      );
      showProgress("正在采集主词前 80 条搜索结果...");
      const captureResult = await captureTabContent(sourceTab.id, {
        mode: "keyword",
        captureParams: {
          keyword,
          minLikes: 0,
          sortDimension: "likes",
          maxDetectedItems: 80,
          maxScrollTimes: 40,
          waitMinMs: settings.sharedWaitMinMs,
          waitMaxMs: settings.sharedWaitMaxMs,
          stallTimeoutMs: settings.sharedStallTimeoutMs,
          maxDurationMs: settings.sharedMaxDurationMs,
        },
      });
      if (controllerState.keywordBenchmarkCancelRequested) {
        throw new Error("已取消找对标账号");
      }

      const payload =
        captureResult?.data && typeof captureResult.data === "object"
          ? captureResult.data
          : null;
      const listItems = normalizeBenchmarkDiscoveryItems(payload?.items || []);
      if (listItems.length < 5) {
        throw new Error("有效搜索结果不足，暂时无法找对标账号");
      }

      let result = buildBenchmarkDiscoveryCandidates(listItems, {
        keyword,
        platform: pagePlatform,
      });
      if (result.candidateCount === 0) {
        controllerState.keywordBenchmarkResult = result;
        controllerState.keywordBenchmarkErrorMessage = "";
        controllerState.keywordBenchmarkAnalysisStatus = "success";
        controllerState.keywordBenchmarkLoadingTitle = "";
        controllerState.keywordBenchmarkLoadingMeta = "";
        renderKeywordStrategyPanel();
        showMessage("当前样本暂未发现重复出现的候选账号", "warning");
        return;
      }

      setKeywordBenchmarkLoading(
        "正在补采账号主页",
        `已筛出 ${result.candidateCount} 个候选账号，正在补充简介、粉丝数和赞藏数据`,
      );
      const profileByKey = await captureBenchmarkCandidateProfiles({
        sourceTabId: sourceTab.id,
        sourceTabUrl,
        candidates: result.candidates,
        shouldStop: () => controllerState.keywordBenchmarkCancelRequested,
      });
      if (controllerState.keywordBenchmarkCancelRequested) {
        throw new Error("已取消找对标账号");
      }
      result = mergeBenchmarkProfilesIntoResult(result, profileByKey);

      setKeywordBenchmarkLoading(
        "正在生成对标账号判断",
        "正在结合账号主页、粉丝量级和代表作品生成推荐理由",
      );
      result = await enrichBenchmarkDiscoveryWithAi({
        keyword,
        platform: pagePlatform,
        result,
        taskContext,
      });
      controllerState.keywordBenchmarkResult = result;
      controllerState.keywordBenchmarkErrorMessage = "";
      controllerState.keywordBenchmarkAnalysisStatus = "success";
      controllerState.keywordBenchmarkLoadingTitle = "";
      controllerState.keywordBenchmarkLoadingMeta = "";
      renderKeywordStrategyPanel();

      showMessage(`已发现 ${result.candidateCount} 个候选对标账号`, "success");
    } catch (error) {
      const message =
        error?.message || "找对标账号失败，请稍后重试";
      controllerState.keywordBenchmarkErrorMessage = message;
      controllerState.keywordBenchmarkAnalysisStatus = "error";
      controllerState.keywordBenchmarkLoadingTitle = "";
      controllerState.keywordBenchmarkLoadingMeta = "";
      taskStatus = "failed";
      taskError = error;
      showMessage(message, "warning");
      renderKeywordStrategyPanel();
    } finally {
      controllerState.keywordBenchmarkInFlight = false;
      controllerState.keywordBenchmarkStartedAt = 0;
      finishSidebarTask(taskContext, {
        status: taskStatus,
        error: taskError,
        metadata: {
          platform: pagePlatform,
          keyword,
          candidateCount: controllerState.keywordBenchmarkResult?.candidateCount || 0,
          aiStatus: controllerState.keywordBenchmarkResult?.aiStatus || "unknown",
          aiError: controllerState.keywordBenchmarkResult?.aiError || "",
        },
      });
      hideProgress();
      renderKeywordStrategyPanel();
    }
  }
  async function handleRunKeywordOpportunity() {
    const runtime = getCurrentRuntime();
    const selectedPlatform = getViewPlatform(runtime);
    const pagePlatform = getPagePlatform(runtime);
    if (selectedPlatform !== pagePlatform) {
      const platformCopy = getPlatformCopy(selectedPlatform);
      showMessage(
        `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再分析`,
        "error",
      );
      return;
    }
    if (runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS) {
      showMessage("请先切换到搜索页", "error");
      return;
    }
    if (
      !ensureAuthVerifiedOrWarn({
        message: getKeywordOpportunityAuthRequiredMessage(),
      })
    ) {
      return;
    }

    const keyword = getCurrentSearchKeyword(runtime);
    if (!keyword) {
      showMessage("未检测到当前搜索词，请先完成搜索后再分析", "warning");
      return;
    }
    if (controllerState.keywordOpportunityInFlight) {
      showMessage("赛道策略分析进行中，请稍候", "warning");
      return;
    }

    controllerPorts.taskView.setStrategyPanelVisible(true);
    controllerPorts.taskView.setStrategyActiveTab("opportunity");
    controllerState.keywordOpportunityInFlight = true;
    controllerState.keywordOpportunityCancelRequested = false;
    controllerState.keywordOpportunityStartedAt = Date.now();
    controllerState.keywordOpportunityErrorMessage = "";
    controllerState.keywordOpportunityResult = null;
    renderKeywordStrategyPanel();

    try {
      const existingDraft = getKeywordOpportunityDraft();
      const canResumeDraft =
        existingDraft.keyword === keyword &&
        existingDraft.listItems.length >= 10 &&
        existingDraft.sampleItems.length > 0 &&
        existingDraft.representativeSamples.length <=
          existingDraft.sampleItems.length;

      const [sourceTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!sourceTab?.id || !sourceTab.url) {
        throw new Error("未找到当前搜索页标签");
      }

      const settings = await getCaptureSettings();
      let sourceTabUrl = String(sourceTab.url || "").trim();
      let listItems = [];
      let sampleItems = [];
      let representativeSamples = [];

      if (canResumeDraft) {
        sourceTabUrl = existingDraft.sourceTabUrl || sourceTabUrl;
        listItems = [...existingDraft.listItems];
        sampleItems = [...existingDraft.sampleItems];
        representativeSamples = [...existingDraft.representativeSamples];
        const remainingSampleCount = Math.max(
          0,
          sampleItems.length - representativeSamples.length,
        );
        showMessage(
          remainingSampleCount > 0
            ? `已恢复上次进度，继续采集剩余 ${remainingSampleCount} 条代表爆款`
            : "已恢复上次进度，直接继续生成赛道机会建议",
          "success",
        );
      } else {
        clearKeywordOpportunityDraft();
        persistCurrentBatchDraft();
        showProgress("正在切换到最近半年 + 最多点赞...");
        await prepareKeywordStrategyCapture(sourceTab.id);
        const refreshedSourceTab = await chrome.tabs.get(sourceTab.id);
        sourceTabUrl = String(refreshedSourceTab?.url || sourceTab.url || "").trim();
        showProgress("正在采集主词前 80 条搜索结果...");
        const captureResult = await captureTabContent(sourceTab.id, {
          mode: "keyword",
          captureParams: {
            keyword,
            minLikes: 0,
            sortDimension: "likes",
            maxDetectedItems: 80,
            maxScrollTimes: 40,
            waitMinMs: settings.sharedWaitMinMs,
            waitMaxMs: settings.sharedWaitMaxMs,
            stallTimeoutMs: settings.sharedStallTimeoutMs,
            maxDurationMs: settings.sharedMaxDurationMs,
          },
        });
        const payload =
          captureResult?.data && typeof captureResult.data === "object"
            ? captureResult.data
            : null;
        listItems = buildKeywordOpportunityInputItems(payload?.items || []);
        if (listItems.length < 10) {
          throw new Error("有效搜索结果不足，暂时无法判断赛道机会");
        }

        sampleItems = selectKeywordOpportunitySamples(listItems);
        if (sampleItems.length === 0) {
          throw new Error("未找到可用于详情采样的代表爆款");
        }
        updateKeywordOpportunityDraft({
          keyword,
          sourceTabUrl,
          listItems,
          sampleItems,
          representativeSamples: [],
        });
        persistCurrentBatchDraft();
      }

      showProgress("正在采集代表爆款详情...");
      representativeSamples = await captureKeywordOpportunitySamples({
        sourceTabId: sourceTab.id,
        sourceTabUrl,
        sampleItems,
        initialSamples: representativeSamples,
        onSampleCaptured: (nextSamples) => {
          updateKeywordOpportunityDraft({
            keyword,
            sourceTabUrl,
            listItems,
            sampleItems,
            representativeSamples: nextSamples,
          });
          persistCurrentBatchDraft();
        },
        shouldStop: () => controllerState.keywordOpportunityCancelRequested,
      });
      if (representativeSamples.length === 0) {
        throw new Error("代表爆款详情采集失败，请稍后重试");
      }
      updateKeywordOpportunityDraft({
        keyword,
        sourceTabUrl,
        listItems,
        sampleItems,
        representativeSamples,
      });
      persistCurrentBatchDraft();

      showProgress("正在生成赛道机会建议...");
      const response = await analyzeKeywordOpportunity({
        keyword,
        listItems,
        representativeSamples,
        platform: pagePlatform,
      });
      if (!response?.ok || !response?.data) {
        const requestError = new Error(
          response?.error?.message ||
            response?.message ||
            "判断赛道机会暂时不可用",
        );
        requestError.reason =
          response?.error?.reason || response?.reason || "server_error";
        requestError.data = response?.error?.data || response?.data || null;
        throw requestError;
      }

      controllerState.keywordOpportunityResult = response.data;
      controllerState.keywordOpportunityResult._listItems = listItems;
      controllerState.keywordOpportunityResult._representativeSamples = representativeSamples;
      controllerState.keywordOpportunityErrorMessage = "";
      clearKeywordOpportunityDraft();
      persistCurrentBatchDraft();
      renderKeywordStrategyPanel();
      showMessage("判断赛道机会已完成", "success");
    } catch (error) {
      const errorReason = String(
        error?.reason || error?.error?.reason || "",
      )
        .trim()
        .toLowerCase();
      if (errorReason === "insufficient_balance") {
        const requiredCredits = Number(error?.data?.requiredCredits);
        const requiredCreditsLabel =
          Number.isInteger(requiredCredits) && requiredCredits > 0
            ? requiredCredits
            : KEYWORD_OPPORTUNITY_ANALYSIS_COST_CREDITS;
        controllerState.keywordOpportunityErrorMessage = "";
        showMessage(
          `配额不足：关键词策略完整分析需 ${requiredCreditsLabel} 配额。获取更多配额后可继续分析。`,
          "warning",
        );
        void refreshVerifiedAuthSnapshot();
      } else {
        const formattedError = formatKeywordStrategyAccessError(
          error,
          getKeywordOpportunityAuthRequiredMessage(),
        );
        const message =
          formattedError.message || "判断赛道机会失败，请稍后重试";
        controllerState.keywordOpportunityErrorMessage = message;
        showMessage(message, "warning");
      }
      renderKeywordStrategyPanel();
    } finally {
      controllerState.keywordOpportunityInFlight = false;
      controllerState.keywordOpportunityStartedAt = 0;
      hideProgress();
      renderKeywordStrategyPanel();
    }
  }

  return Object.freeze({
    selectKeywordStrategyTab,
    openKeywordLongtail,
    normalizeBenchmarkDiscoveryItems,
    calculateBenchmarkEngagement,
    averageBenchmarkValues,
    normalizeBenchmarkProfilePayload,
    buildBenchmarkDiscoveryRuleReason,
    buildBenchmarkDiscoveryFocusAssessment,
    buildBenchmarkDiscoveryDecisionAngle,
    buildBenchmarkDiscoveryFallbackAnalysis,
    buildBenchmarkDiscoveryCandidates,
    mergeBenchmarkProfilesIntoResult,
    mergeBenchmarkAiAnalysisIntoResult,
    setKeywordBenchmarkLoading,
    buildKeywordOpportunityInputItems,
    analyzeKeywordOpportunityRules,
    selectKeywordOpportunitySamples,
    waitForTabComplete,
    prepareKeywordStrategyCapture,
    captureKeywordOpportunitySamples,
    handleCancelKeywordOpportunity,
    handleCancelBenchmarkDiscovery,
    captureBenchmarkCandidateProfiles,
    buildBenchmarkDiscoveryAiCandidates,
    enrichBenchmarkDiscoveryWithAi,
    handleRunBenchmarkDiscovery,
    handleRunKeywordOpportunity,
  });
}
