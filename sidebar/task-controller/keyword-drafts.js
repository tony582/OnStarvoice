// L3-B keyword-drafts: explicit application responsibility.
export function createKeywordDraftsController({controllerState, controllerPorts, controllerOperations}) {
  const {
    BATCH_DRAFT_LEGACY_KEYS,
    BATCH_DRAFT_PLATFORMS,
    BATCH_DRAFT_SESSION_KEY,
    PAGE_TYPE,
    chrome,
    console,
    extractKeywordFromUrl,
    getCurrentRuntime,
    getViewPlatform,
    showMessage,
    updateBatchKeywordInputState,
  } = controllerPorts;
  const buildKeywordOpportunityInputItems = (...args) => controllerOperations.buildKeywordOpportunityInputItems(...args);
  const invalidateKeywordInsightDraft = (...args) => controllerOperations.invalidateKeywordInsightDraft(...args);
  const renderExpandedKeywords = (...args) => controllerPorts.taskView.renderExpandedKeywords(...args);
  const renderKeywordInsightState = (...args) => controllerPorts.taskView.renderKeywordInsightState(...args);
  const renderKeywordStrategyPanel = (...args) => controllerPorts.taskView.renderKeywordStrategyPanel(...args);
  const updateExpandKeywordsButtonState = (...args) => controllerPorts.taskView.updateExpandKeywordsButtonState(...args);

  function createEmptyKeywordInsightState() {
    return {
      analysisVersion: 0,
      analysisStatus: "idle",
      analysisErrorMessage: "",
      analysisResult: null,
      selectedCategoryIds: [],
      selectedKeywords: [],
      sampleStatusByCategoryId: {},
      sampleResultsByCategoryId: {},
    };
  }
  function createEmptyKeywordOpportunityDraft() {
    return {
      keyword: "",
      sourceTabUrl: "",
      listItems: [],
      sampleItems: [],
      representativeSamples: [],
    };
  }
  function normalizeKeywordOpportunitySampleItems(items = []) {
    return buildKeywordOpportunityInputItems(items);
  }
  function normalizeRepresentativeSampleItems(items = []) {
    if (!Array.isArray(items)) {
      return [];
    }
    return items
      .map((item) => ({
        noteId: String(item?.noteId || "").trim(),
        url: String(item?.url || "").trim(),
        title: String(item?.title || "").trim(),
        authorName: String(item?.authorName || item?.author || "").trim(),
        publishTime: String(
          item?.publishTime || item?.publishDate || item?.lastEditedAt || "",
        ).trim(),
        likes: Number(item?.likes) || 0,
        comments: Number(item?.comments) || 0,
        collects: Number(item?.collects) || 0,
        noteType: String(item?.noteType || "").trim(),
        cover: String(item?.cover || item?.coverImageUrl || "").trim(),
        content: String(item?.content || "").trim(),
        tags: Array.isArray(item?.tags)
          ? item.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
          : [],
        authorFollowerCount: Number(item?.authorFollowerCount) || 0,
      }))
      .filter((item) => item.url);
  }
  function normalizeKeywordOpportunityDraft(entry = {}) {
    const safeEntry = entry && typeof entry === "object" ? entry : {};
    return {
      keyword: String(safeEntry.keyword || "").trim(),
      sourceTabUrl: String(safeEntry.sourceTabUrl || "").trim(),
      listItems: normalizeKeywordOpportunitySampleItems(safeEntry.listItems),
      sampleItems: normalizeKeywordOpportunitySampleItems(safeEntry.sampleItems),
      representativeSamples: normalizeRepresentativeSampleItems(
        safeEntry.representativeSamples,
      ),
    };
  }
  function normalizeBatchDraftPlatform(platform) {
    const normalized = String(platform || "")
      .trim()
      .toLowerCase();
    return BATCH_DRAFT_PLATFORMS.has(normalized) ? normalized : "unknown";
  }
  function createEmptyBatchDraft() {
    return {
      links: "",
      bloggers: "",
      batchKeywordsText: "",
      seedKeyword: "",
      expandedKeywords: [],
      keywordOpportunityDraft: createEmptyKeywordOpportunityDraft(),
      ...createEmptyKeywordInsightState(),
    };
  }
  function normalizeBatchDraftEntry(entry = {}) {
    const safeEntry = entry && typeof entry === "object" ? entry : {};
    const links = String(safeEntry.links || "");
    const bloggers = String(safeEntry.bloggers || "");
    const batchKeywordsText = String(safeEntry.batchKeywordsText || "");
    const seedKeyword = String(safeEntry.seedKeyword || "");
    const expandedKeywords = Array.isArray(safeEntry.expandedKeywords)
      ? safeEntry.expandedKeywords
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      : [];
    const defaultInsightState = createEmptyKeywordInsightState();
    const rawAnalysisResult =
      safeEntry.analysisResult && typeof safeEntry.analysisResult === "object"
        ? safeEntry.analysisResult
        : null;
    const selectedCategoryIds = Array.isArray(safeEntry.selectedCategoryIds)
      ? safeEntry.selectedCategoryIds
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      : [];
    const selectedKeywords = Array.isArray(safeEntry.selectedKeywords)
      ? safeEntry.selectedKeywords
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      : [];
    const sampleStatusByCategoryId =
      safeEntry.sampleStatusByCategoryId &&
      typeof safeEntry.sampleStatusByCategoryId === "object"
        ? Object.fromEntries(
            Object.entries(safeEntry.sampleStatusByCategoryId).map(
              ([key, value]) => [
                String(key || "").trim(),
                String(value || "").trim() || "idle",
              ],
            ),
          )
        : {};
    const sampleResultsByCategoryId =
      safeEntry.sampleResultsByCategoryId &&
      typeof safeEntry.sampleResultsByCategoryId === "object"
        ? safeEntry.sampleResultsByCategoryId
        : {};
    const keywordOpportunityDraft = normalizeKeywordOpportunityDraft(
      safeEntry.keywordOpportunityDraft,
    );

    return {
      links,
      bloggers,
      batchKeywordsText,
      seedKeyword,
      expandedKeywords,
      analysisVersion:
        Number.isInteger(safeEntry.analysisVersion) &&
        safeEntry.analysisVersion >= 0
          ? safeEntry.analysisVersion
          : defaultInsightState.analysisVersion,
      analysisStatus:
        typeof safeEntry.analysisStatus === "string" && safeEntry.analysisStatus
          ? safeEntry.analysisStatus
          : defaultInsightState.analysisStatus,
      analysisErrorMessage: String(safeEntry.analysisErrorMessage || ""),
      analysisResult: rawAnalysisResult,
      selectedCategoryIds,
      selectedKeywords,
      sampleStatusByCategoryId,
      sampleResultsByCategoryId,
      keywordOpportunityDraft,
    };
  }
  function normalizeBatchDraftStore(rawStore = {}) {
    const safeStore = rawStore && typeof rawStore === "object" ? rawStore : {};
    const normalizedStore = {};
    Object.entries(safeStore).forEach(([platform, entry]) => {
      const normalizedPlatform = normalizeBatchDraftPlatform(platform);
      normalizedStore[normalizedPlatform] = normalizeBatchDraftEntry(entry);
    });
    return normalizedStore;
  }
  function getCurrentBatchDraftPlatform() {
    const runtime = getCurrentRuntime();
    return normalizeBatchDraftPlatform(getViewPlatform(runtime));
  }
  function resolveBatchDraftPlatform(platform = "") {
    const raw = String(platform || "").trim();
    if (!raw) {
      return getCurrentBatchDraftPlatform();
    }
    return normalizeBatchDraftPlatform(raw);
  }
  function getBatchDraftForPlatform(platform = "") {
    const normalizedPlatform = resolveBatchDraftPlatform(platform);
    const current = controllerState.batchDraftByPlatform[normalizedPlatform];
    if (current) {
      return normalizeBatchDraftEntry(current);
    }
    return createEmptyBatchDraft();
  }
  function getKeywordInsightState(platform = "") {
    const draft = getBatchDraftForPlatform(platform);
    return {
      analysisVersion: draft.analysisVersion,
      analysisStatus: draft.analysisStatus,
      analysisErrorMessage: draft.analysisErrorMessage,
      analysisResult: draft.analysisResult,
      selectedCategoryIds: [...draft.selectedCategoryIds],
      selectedKeywords: [...(draft.selectedKeywords || [])],
      sampleStatusByCategoryId: {
        ...(draft.sampleStatusByCategoryId || {}),
      },
      sampleResultsByCategoryId: {
        ...(draft.sampleResultsByCategoryId || {}),
      },
    };
  }
  function updateKeywordInsightState(updates = {}, platform = "") {
    const normalizedPlatform = resolveBatchDraftPlatform(platform);
    const currentDraft = getBatchDraftForPlatform(normalizedPlatform);
    controllerState.batchDraftByPlatform[normalizedPlatform] = normalizeBatchDraftEntry({
      ...currentDraft,
      ...updates,
    });
    return controllerState.batchDraftByPlatform[normalizedPlatform];
  }
  function getKeywordOpportunityDraft(platform = "") {
    const draft = getBatchDraftForPlatform(platform);
    return normalizeKeywordOpportunityDraft(draft.keywordOpportunityDraft);
  }
  function updateKeywordOpportunityDraft(updates = {}, platform = "") {
    const normalizedPlatform = resolveBatchDraftPlatform(platform);
    const currentDraft = getBatchDraftForPlatform(normalizedPlatform);
    const nextOpportunityDraft = normalizeKeywordOpportunityDraft({
      ...currentDraft.keywordOpportunityDraft,
      ...updates,
    });
    controllerState.batchDraftByPlatform[normalizedPlatform] = normalizeBatchDraftEntry({
      ...currentDraft,
      keywordOpportunityDraft: nextOpportunityDraft,
    });
    return nextOpportunityDraft;
  }
  function clearKeywordOpportunityDraft(platform = "") {
    return updateKeywordOpportunityDraft(
      createEmptyKeywordOpportunityDraft(),
      platform,
    );
  }
  async function persistBatchDraftStore() {
    await chrome.storage.session.set({
      [BATCH_DRAFT_SESSION_KEY]: controllerState.batchDraftByPlatform,
    });
  }
  async function loadBatchDraftStore() {
    const session = await chrome.storage.session.get([
      BATCH_DRAFT_SESSION_KEY,
      ...BATCH_DRAFT_LEGACY_KEYS,
    ]);

    controllerState.batchDraftByPlatform = normalizeBatchDraftStore(
      session[BATCH_DRAFT_SESSION_KEY],
    );

    const legacyExpandedKeywords = Array.isArray(session.expandedKeywords)
      ? session.expandedKeywords
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      : [];
    const legacySeedKeyword = String(session.expandedSeedKeyword || "").trim();
    const hasLegacyDraft = legacyExpandedKeywords.length > 0 || legacySeedKeyword;

    if (!hasLegacyDraft) {
      return;
    }

    const currentPlatform = getCurrentBatchDraftPlatform();
    const currentDraft = getBatchDraftForPlatform(currentPlatform);
    const shouldMigrate =
      currentDraft.expandedKeywords.length === 0 && !currentDraft.seedKeyword;
    if (!shouldMigrate) {
      return;
    }

    controllerState.batchDraftByPlatform[currentPlatform] = normalizeBatchDraftEntry({
      ...currentDraft,
      seedKeyword: legacySeedKeyword || currentDraft.seedKeyword,
      expandedKeywords:
        legacyExpandedKeywords.length > 0
          ? legacyExpandedKeywords
          : currentDraft.expandedKeywords,
    });

    await persistBatchDraftStore();
    await chrome.storage.session.remove(BATCH_DRAFT_LEGACY_KEYS);
  }
  async function persistBatchDraftForPlatform(platform = "") {
    const normalizedPlatform = resolveBatchDraftPlatform(platform);
    const inputs = controllerPorts.taskView.openBatchDraftInputs();
    const currentDraft = getBatchDraftForPlatform(normalizedPlatform);
    const runtime = getCurrentRuntime();
    const seedKeyword = getKeywordInsightSeedKeyword({
      runtime,
      preferStored: true,
      platform: normalizedPlatform,
    });

    const nextDraft = normalizeBatchDraftEntry({
      ...inputs.read(),
      seedKeyword,
      expandedKeywords: [...controllerState.expandedKeywordsBuffer],
      analysisVersion: currentDraft.analysisVersion,
      analysisStatus: currentDraft.analysisStatus,
      analysisErrorMessage: currentDraft.analysisErrorMessage,
      analysisResult: currentDraft.analysisResult,
      selectedCategoryIds: currentDraft.selectedCategoryIds,
      selectedKeywords: currentDraft.selectedKeywords,
      sampleStatusByCategoryId: currentDraft.sampleStatusByCategoryId,
      sampleResultsByCategoryId: currentDraft.sampleResultsByCategoryId,
      keywordOpportunityDraft: currentDraft.keywordOpportunityDraft,
    });
    const prevDraft = currentDraft;

    if (JSON.stringify(prevDraft) === JSON.stringify(nextDraft)) {
      return;
    }

    controllerState.batchDraftByPlatform[normalizedPlatform] = nextDraft;
    await persistBatchDraftStore();
  }
  function applyBatchDraftToInputs(platform = "", {force = false} = {}) {
    const normalizedPlatform = resolveBatchDraftPlatform(platform);
    if (!force && normalizedPlatform === controllerState.activeBatchDraftPlatform) {
      return;
    }

    const draft = getBatchDraftForPlatform(normalizedPlatform);
    controllerPorts.taskView.openBatchDraftInputs().apply(draft);

    controllerState.expandedKeywordsBuffer = [...draft.expandedKeywords];
    renderExpandedKeywords();
    renderKeywordInsightState();
    updateBatchKeywordInputState();
    updateExpandKeywordsButtonState();
    controllerState.activeBatchDraftPlatform = normalizedPlatform;
  }
  function syncBatchDraftForPlatform(platform = "") {
    const nextPlatform = resolveBatchDraftPlatform(platform);
    const previousPlatform = controllerState.activeBatchDraftPlatform;

    if (previousPlatform && previousPlatform !== nextPlatform) {
      void persistBatchDraftForPlatform(previousPlatform).catch((error) => {
        console.warn(
          "[Sidebar] Persist batch draft before platform switch failed:",
          error,
        );
      });
    }

    applyBatchDraftToInputs(nextPlatform, {
      force: previousPlatform !== nextPlatform,
    });
  }
  function persistCurrentBatchDraft() {
    const platform = controllerState.activeBatchDraftPlatform || getCurrentBatchDraftPlatform();
    void persistBatchDraftForPlatform(platform).catch((error) => {
      console.warn("[Sidebar] Persist batch draft failed:", error);
    });
  }
  function getCurrentSearchKeyword(runtime = getCurrentRuntime()) {
    if (runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS) {
      return "";
    }
    return extractKeywordFromUrl(runtime?.lastPageUrl || "");
  }
  function getStoredKeywordInsightSeedKeyword(platform = "") {
    return String(
      getBatchDraftForPlatform(resolveBatchDraftPlatform(platform)).seedKeyword ||
        "",
    ).trim();
  }
  function getKeywordInsightSeedKeyword({
    runtime = getCurrentRuntime(),
    preferStored = false,
    platform = "",
  } = {}) {
    const currentKeyword = getCurrentSearchKeyword(runtime);
    if (currentKeyword) {
      return currentKeyword;
    }
    return preferStored ? getStoredKeywordInsightSeedKeyword(platform) : "";
  }
  function clearKeywordOpportunityState(
    {preservePanel = false, preserveDraft = false} = {},
  ) {
    controllerState.keywordOpportunityInFlight = false;
    controllerState.keywordOpportunityStartedAt = 0;
    controllerState.keywordOpportunityResult = null;
    controllerState.keywordOpportunityErrorMessage = "";
    if (!preserveDraft) {
      clearKeywordOpportunityDraft();
      persistCurrentBatchDraft();
    }
    if (!preservePanel) {
      controllerPorts.taskView.setStrategyPanelVisible(false);
    }
  }
  function getKeywordOpportunityKeyword() {
    return String(controllerState.keywordOpportunityResult?.keyword || "").trim();
  }
  function clearBenchmarkDiscoveryState({preservePanel = false} = {}) {
    controllerState.keywordBenchmarkInFlight = false;
    controllerState.keywordBenchmarkStartedAt = 0;
    controllerState.keywordBenchmarkResult = null;
    controllerState.keywordBenchmarkErrorMessage = "";
    controllerState.keywordBenchmarkAnalysisStatus = "idle";
    controllerState.keywordBenchmarkLoadingTitle = "";
    controllerState.keywordBenchmarkLoadingMeta = "";
    if (!preservePanel) {
      controllerPorts.taskView.setStrategyPanelVisible(false);
    }
  }
  function clearBenchmarkDiscoveryResult({showFeedback = true} = {}) {
    const hasAnything =
      !!controllerState.keywordBenchmarkResult ||
      !!String(controllerState.keywordBenchmarkErrorMessage || "").trim() ||
      controllerState.keywordBenchmarkAnalysisStatus === "loading";
    if (!hasAnything) {
      return;
    }

    clearBenchmarkDiscoveryState({preservePanel: true});
    renderKeywordStrategyPanel();
    if (showFeedback) {
      showMessage("已清空找对标账号结果", "success");
    }
  }
  function clearKeywordOpportunityResult({showFeedback = true} = {}) {
    const hasAnything =
      !!controllerState.keywordOpportunityResult ||
      !!String(controllerState.keywordOpportunityErrorMessage || "").trim();
    if (!hasAnything) {
      return;
    }

    clearKeywordOpportunityState({preservePanel: true});
    renderKeywordStrategyPanel();
    if (showFeedback) {
      showMessage("已清空判断赛道机会结果", "success");
    }
  }
  function maybeResetKeywordOpportunityForCurrentSearch(
    runtime = getCurrentRuntime(),
  ) {
    const currentKeyword = getCurrentSearchKeyword(runtime);
    const draftKeyword = String(getKeywordOpportunityDraft().keyword || "").trim();
    if (draftKeyword && currentKeyword && draftKeyword !== currentKeyword) {
      clearKeywordOpportunityDraft();
      persistCurrentBatchDraft();
    }
    if (controllerState.keywordOpportunityResult) {
      renderKeywordStrategyPanel();
    }
  }
  function syncSeedKeywordFromCurrentSearch(
    keyword = "",
    {autoFillOnly = true} = {},
  ) {
    const nextKeyword = String(keyword || "").trim();
    if (!nextKeyword) {
      updateExpandKeywordsButtonState();
      return {seedKeyword: "", changed: false};
    }
    const currentDraft = getBatchDraftForPlatform();
    const prevKeyword = String(currentDraft.seedKeyword || "").trim();
    const hasStoredResults =
      currentDraft.expandedKeywords.length > 0 ||
      Boolean(currentDraft.analysisResult) ||
      currentDraft.analysisStatus === "loading" ||
      currentDraft.analysisStatus === "success";
    if (autoFillOnly && prevKeyword && hasStoredResults) {
      updateExpandKeywordsButtonState();
      return {seedKeyword: prevKeyword, changed: false, skipped: true};
    }
    const changed = prevKeyword !== nextKeyword;

    if (changed) {
      controllerState.expandedKeywordsBuffer = [];
      controllerPorts.taskView.setExpandedKeywordsVisible(false);
      invalidateKeywordInsightDraft();
    }

    updateExpandKeywordsButtonState();
    renderKeywordInsightState();
    persistCurrentBatchDraft();

    return {seedKeyword: nextKeyword, changed};
  }

  return Object.freeze({
    createEmptyKeywordInsightState,
    createEmptyKeywordOpportunityDraft,
    normalizeKeywordOpportunitySampleItems,
    normalizeRepresentativeSampleItems,
    normalizeKeywordOpportunityDraft,
    normalizeBatchDraftPlatform,
    createEmptyBatchDraft,
    normalizeBatchDraftEntry,
    normalizeBatchDraftStore,
    getCurrentBatchDraftPlatform,
    resolveBatchDraftPlatform,
    getBatchDraftForPlatform,
    getKeywordInsightState,
    updateKeywordInsightState,
    getKeywordOpportunityDraft,
    updateKeywordOpportunityDraft,
    clearKeywordOpportunityDraft,
    persistBatchDraftStore,
    loadBatchDraftStore,
    persistBatchDraftForPlatform,
    applyBatchDraftToInputs,
    syncBatchDraftForPlatform,
    persistCurrentBatchDraft,
    getCurrentSearchKeyword,
    getStoredKeywordInsightSeedKeyword,
    getKeywordInsightSeedKeyword,
    clearKeywordOpportunityState,
    getKeywordOpportunityKeyword,
    clearBenchmarkDiscoveryState,
    clearBenchmarkDiscoveryResult,
    clearKeywordOpportunityResult,
    maybeResetKeywordOpportunityForCurrentSearch,
    syncSeedKeywordFromCurrentSearch,
  });
}
