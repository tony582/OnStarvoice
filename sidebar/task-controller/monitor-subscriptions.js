// L3-B monitor-subscriptions: explicit application responsibility.
export function createMonitorSubscriptionsController({controllerState, controllerPorts, controllerOperations}) {
  const {
    AUTH_STATUS,
    DEFAULT_MONITOR_SETTINGS,
    ERROR_MESSAGE_MAP,
    MESSAGE_TYPE,
    MONITOR_OBSERVE_WINDOW_OPTIONS,
    MONITOR_PUBLISH_WINDOW_OPTIONS,
    MONITOR_REQUIRED_MESSAGE,
    MONITOR_RUN_TIME_OPTIONS,
    MONITOR_STATUS,
    MONITOR_SUBJECT_TYPE,
    PAGE_TYPE,
    chrome,
    console,
    createMonitorSubscription,
    detectPlatformFromUrl,
    getCurrentAuth,
    getCurrentDataPool,
    getCurrentMonitor,
    getCurrentRuntime,
    getPagePlatform,
    getMonitorSettings,
    hideProgress,
    listMonitorExecutions,
    listMonitorSubscriptions,
    resetCurrentMonitor,
    resolveRecordPlatform,
    saveMonitorSettings,
    setCurrentMonitor,
    showMessage,
    showProgress,
    updateMonitorSubscription,
  } = controllerPorts;
  const getMonitorSubjectLabel = (...args) => controllerPorts.taskView.getMonitorSubjectLabel(...args);
  const getMonitorSubjectType = (...args) => controllerPorts.taskView.getMonitorSubjectType(...args);
  const populateMonitorSettingsForm = (...args) => controllerPorts.taskView.populateMonitorSettingsForm(...args);
  const readMonitorSettingsForm = (...args) => controllerPorts.taskView.readMonitorSettingsForm(...args);

  function isMonitorAuthReady() {
    const auth = getCurrentAuth() || {};
    return auth.status === AUTH_STATUS.VERIFIED && Boolean(auth.credential?.code);
  }
  async function loadMonitorSubscriptions({force = false} = {}) {
    const currentMonitor = getCurrentMonitor() || {};
    if (currentMonitor.isLoading && !force) {
      return currentMonitor.items || [];
    }

    if (!isMonitorAuthReady()) {
      await resetCurrentMonitor();
      return [];
    }

    const runtime = getCurrentRuntime();
    const runtimePlatform = runtime?.platform || "douyin";
    const datasetSelectedPlatform = controllerPorts.taskView.readMonitorSelectedPlatform();
    const platform =
      datasetSelectedPlatform && datasetSelectedPlatform !== "unknown"
        ? datasetSelectedPlatform
        : runtimePlatform;

    const status = MONITOR_STATUS.ALL;
    await setCurrentMonitor({
      isLoading: true,
      error: null,
      filters: {
        ...(currentMonitor.filters || {}),
        status,
        platform,
      },
    });

    const result = await listMonitorSubscriptions({status, platform});
    if (!result?.ok) {
      const monitorErrorMsg =
        ERROR_MESSAGE_MAP[result?.reason] ||
        result?.message ||
        "加载监控列表失败";
      await setCurrentMonitor({
        items: [],
        isLoading: false,
        error: monitorErrorMsg,
      });
      showMessage(monitorErrorMsg, "error");
      return [];
    }

    const items = Array.isArray(result.data?.items) ? result.data.items : [];

    await setCurrentMonitor({
      items,
      isLoading: false,
      error: null,
      lastFetchedAt: Date.now(),
      filters: {
        ...(currentMonitor.filters || {}),
        status,
        platform,
      },
    });

    return items;
  }
  async function loadMonitorExecutions({force = false, limit = 50} = {}) {
    const currentMonitor = getCurrentMonitor() || {};
    if (currentMonitor.isLoadingExecutions && !force) {
      return currentMonitor.executions || [];
    }

    if (!isMonitorAuthReady()) {
      await setCurrentMonitor({
        executions: [],
        isLoadingExecutions: false,
        executionsError: null,
        executionsLastFetchedAt: null,
      });
      return [];
    }

    await setCurrentMonitor({
      isLoadingExecutions: true,
      executionsError: null,
    });

    const result = await listMonitorExecutions({limit});
    if (!result?.ok) {
      const monitorErrorMsg =
        ERROR_MESSAGE_MAP[result?.reason] ||
        result?.message ||
        "加载监控执行记录失败";
      await setCurrentMonitor({
        executions: [],
        isLoadingExecutions: false,
        executionsError: monitorErrorMsg,
      });
      return [];
    }

    const items = Array.isArray(result.data?.items)
      ? result.data.items
      : Array.isArray(result.data?.executions)
        ? result.data.executions
        : Array.isArray(result.executions)
          ? result.executions
          : Array.isArray(result.items)
            ? result.items
            : [];
    await setCurrentMonitor({
      executions: items,
      isLoadingExecutions: false,
      executionsError: null,
      executionsLastFetchedAt: Date.now(),
    });

    return items;
  }
  async function loadExecutionDetails({force = false} = {}) {
    if (!isMonitorAuthReady()) {
      await setCurrentMonitor({
        executions: [],
        isLoadingExecutions: false,
        executionsError: null,
        executionsLastFetchedAt: null,
      });
      return [];
    }

    await Promise.all([
      loadMonitorSubscriptions({force}),
      loadMonitorExecutions({force}),
    ]);
    return getCurrentMonitor()?.executions || [];
  }
  function normalizeMonitorSettingsInput(input = {}) {
    const likeThreshold = Number(
      input.likeThreshold ?? DEFAULT_MONITOR_SETTINGS.likeThreshold,
    );
    const observeWindowHours = Number(
      input.observeWindowHours ?? DEFAULT_MONITOR_SETTINGS.observeWindowHours,
    );
    const rawPublishWindow = String(
      input.publishWindow || DEFAULT_MONITOR_SETTINGS.publishWindow,
    ).trim();
    const normalizedPublishWindow =
      rawPublishWindow === "recent_activity"
        ? DEFAULT_MONITOR_SETTINGS.publishWindow
        : rawPublishWindow;
    const publishWindow = MONITOR_PUBLISH_WINDOW_OPTIONS.has(normalizedPublishWindow)
      ? normalizedPublishWindow
      : DEFAULT_MONITOR_SETTINGS.publishWindow;
    const runTimes = (
      Array.isArray(input.runTimes)
        ? input.runTimes
        : String(input.runTimes || "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
    ).filter((item) => MONITOR_RUN_TIME_OPTIONS.includes(item));

    const normalizedObserveWindowHours =
      Number.isFinite(observeWindowHours) && observeWindowHours > 0
        ? Math.trunc(observeWindowHours)
        : DEFAULT_MONITOR_SETTINGS.observeWindowHours;
    const safeObserveWindowHours = MONITOR_OBSERVE_WINDOW_OPTIONS.includes(
      normalizedObserveWindowHours,
    )
      ? normalizedObserveWindowHours
      : DEFAULT_MONITOR_SETTINGS.observeWindowHours;

    return {
      publishWindow,
      likeThreshold:
        Number.isFinite(likeThreshold) && likeThreshold >= 0
          ? Math.trunc(likeThreshold)
          : DEFAULT_MONITOR_SETTINGS.likeThreshold,
      runTimes:
        runTimes.length > 0 ? runTimes : [...DEFAULT_MONITOR_SETTINGS.runTimes],
      observeWindowHours: safeObserveWindowHours,
      timezone: DEFAULT_MONITOR_SETTINGS.timezone,
    };
  }
  async function loadMonitorSettings() {
    if (!isMonitorAuthReady()) {
      await setCurrentMonitor({
        settings: {...DEFAULT_MONITOR_SETTINGS},
      });
      populateMonitorSettingsForm(DEFAULT_MONITOR_SETTINGS);
      return DEFAULT_MONITOR_SETTINGS;
    }

    const result = await getMonitorSettings();
    if (!result?.ok) {
      populateMonitorSettingsForm(DEFAULT_MONITOR_SETTINGS);
      await setCurrentMonitor({
        settings: {...DEFAULT_MONITOR_SETTINGS},
      });
      return DEFAULT_MONITOR_SETTINGS;
    }

    const settings = normalizeMonitorSettingsInput(result.data?.settings || {});
    await setCurrentMonitor({
      settings,
    });
    populateMonitorSettingsForm(settings);
    return settings;
  }
  function normalizeMonitorSubjectType(value) {
    return String(value || "")
      .trim()
      .toLowerCase() === MONITOR_SUBJECT_TYPE.OFFICIAL
      ? MONITOR_SUBJECT_TYPE.OFFICIAL
      : MONITOR_SUBJECT_TYPE.CREATOR;
  }
  function extractPlatformMonitorBloggerId(platform, url, fallbackId = "") {
    const normalizedPlatform = String(platform || "")
      .trim()
      .toLowerCase();
    const normalizedUrl = String(url || "").trim();

    if (normalizedPlatform === "xiaohongshu" && normalizedUrl) {
      const profileMatch = normalizedUrl.match(
        /\/user\/profile\/([a-zA-Z0-9_-]+)/i,
      );
      if (profileMatch?.[1]) {
        return profileMatch[1];
      }
    }

    if (normalizedPlatform === "weibo" && normalizedUrl) {
      const weiboMatch =
        normalizedUrl.match(/weibo\.com\/u\/(\d+)/i) ||
        normalizedUrl.match(/weibo\.com\/(\d{5,})(?:[/?#]|$)/i);
      if (weiboMatch?.[1]) {
        return weiboMatch[1];
      }
    }

    if (normalizedPlatform === "douyin" && normalizedUrl) {
      const douyinMatch = normalizedUrl.match(
        /\/user\/([a-zA-Z0-9._-]+)(?:[/?#]|$)/i,
      );
      if (douyinMatch?.[1]) {
        return douyinMatch[1];
      }
    }

    return String(fallbackId || "").trim();
  }
  function resolveMonitorAccountNo(platform, payload = {}, profileInternalId = "") {
    const normalizedPlatform = String(platform || "")
      .trim()
      .toLowerCase();
    const candidates =
      normalizedPlatform === "xiaohongshu"
        ? [
            payload.accountNo,
            payload.account_no,
            payload.bloggerUserId,
            payload.redId,
            payload.xiaohongshuId,
            payload.bloggerId,
          ]
        : normalizedPlatform === "douyin"
          ? [
              payload.accountNo,
              payload.account_no,
              payload.douyinId,
              payload.uniqueId,
              payload.authorUsername,
            ]
          : normalizedPlatform === "weibo"
            ? [
                payload.accountNo,
                payload.account_no,
                payload.weiboId,
                payload.bloggerId,
              ]
            : [payload.accountNo, payload.account_no, payload.bloggerId];

    for (const candidate of candidates) {
      const normalized = String(candidate || "").trim();
      if (!normalized) continue;
      if (
        normalizedPlatform !== "weibo" &&
        normalized === String(profileInternalId || "").trim()
      ) {
        continue;
      }
      return normalized;
    }
    return "";
  }
  function buildMonitorSubjectCandidate({
    platform,
    subjectType = MONITOR_SUBJECT_TYPE.CREATOR,
    profileInternalId = "",
    accountNo = "",
    displayName = "",
    profileUrl = "",
    avatarUrl = "",
    assignedAgentId = "",
  } = {}) {
    const normalizedSubjectType = normalizeMonitorSubjectType(subjectType);
    const normalizedProfileInternalId = String(profileInternalId || "").trim();
    const normalizedAccountNo = String(accountNo || "").trim();
    const normalizedDisplayName = String(displayName || "").trim();
    const normalizedProfileUrl = String(profileUrl || "").trim();
    const normalizedAvatarUrl = String(avatarUrl || "").trim();
    const normalizedAssignedAgentId = String(assignedAgentId || "").trim();
    const platformBloggerId =
      normalizedProfileInternalId || normalizedAccountNo;

    if (!platformBloggerId) {
      return null;
    }

    return {
      platform: String(platform || "")
        .trim()
        .toLowerCase(),
      subjectType: normalizedSubjectType,
      profileInternalId: normalizedProfileInternalId,
      accountNo: normalizedAccountNo,
      displayName: normalizedDisplayName,
      profileUrl: normalizedProfileUrl,
      avatarUrl: normalizedAvatarUrl,
      assignedAgentId: normalizedAssignedAgentId,
      // Backward-compatible fields consumed by the existing monitor API.
      platformBloggerId,
      bloggerNameSnapshot: normalizedDisplayName,
      bloggerUrl: normalizedProfileUrl,
      bloggerAvatarSnapshot: normalizedAvatarUrl,
    };
  }
  function buildMonitorCandidateFromRecord(
    record,
    subjectType = MONITOR_SUBJECT_TYPE.CREATOR,
  ) {
    if (!record || record.type !== "blogger_profile") {
      return null;
    }

    const platform = resolveRecordPlatform(record);
    if (
      platform !== "douyin" &&
      platform !== "xiaohongshu" &&
      platform !== "weibo"
    ) {
      return null;
    }

    const payload = record.payload || {};
    const profileUrl = String(
      payload.profileUrl ||
        payload.bloggerUrl ||
        payload.bloggerProfileUrl ||
        "",
    ).trim();
    const profileInternalId = extractPlatformMonitorBloggerId(
      platform,
      profileUrl,
      payload.profileInternalId || payload.bloggerId,
    );
    const accountNo = resolveMonitorAccountNo(
      platform,
      payload,
      profileInternalId,
    );
    return buildMonitorSubjectCandidate({
      platform,
      subjectType,
      profileInternalId,
      accountNo,
      displayName: payload.displayName || payload.bloggerName,
      profileUrl,
      avatarUrl: payload.avatarUrl || payload.bloggerAvatarSnapshot,
      assignedAgentId: getCurrentAuth()?.captureAgent?.id || "",
    });
  }
  async function addMonitorSubscriptionByCandidate(candidate) {
    const result = await createMonitorSubscription(candidate);

    if (!result?.ok) {
      throw new Error(result?.message || "纳入监控失败");
    }

    await loadMonitorSubscriptions({force: true});

    const subjectType = normalizeMonitorSubjectType(candidate?.subjectType);
    const isOfficial = subjectType === MONITOR_SUBJECT_TYPE.OFFICIAL;
    if (result.data?.created) {
      showMessage(
        isOfficial ? "已登记为官方账号" : "已将当前账号加入关注博主",
        "success",
      );
    } else if (result.data?.restored) {
      showMessage(
        isOfficial ? "已恢复官方账号登记" : "当前账号已恢复到关注博主",
        "success",
      );
    } else {
      showMessage(
        isOfficial ? "该官方账号已登记" : "当前账号已在关注博主中",
        "info",
      );
    }
  }
  async function captureCurrentMonitorCandidate(
    subjectType = getMonitorSubjectType(),
  ) {
    const runtime = getCurrentRuntime();
    const pageUrl = String(runtime?.lastPageUrl || "").trim();
    const pagePlatform = detectPlatformFromUrl(pageUrl);

    if (
      (pagePlatform !== "douyin" &&
        pagePlatform !== "xiaohongshu" &&
        pagePlatform !== "weibo") ||
      runtime?.pageType !== PAGE_TYPE.BLOGGER_PROFILE
    ) {
      throw new Error("请先切换到抖音、小红书或微博账号主页");
    }

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.id) {
      throw new Error("未找到当前活动页");
    }

    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: tab.id,
      payload: {
        action: "captureBloggerProfile",
      },
    });

    const captureResult = response?.data;
    if (!response?.ok || !captureResult?.ok || !captureResult?.data) {
      const errorText =
        captureResult?.error?.message ||
        response?.error?.message ||
        "账号主页识别失败";
      throw new Error(errorText);
    }

    const profile = captureResult.data || {};
    const profileUrl = String(
      profile.profileUrl ||
        profile.bloggerUrl ||
        profile.bloggerProfileUrl ||
        pageUrl,
    ).trim();
    const profileInternalId = extractPlatformMonitorBloggerId(
      pagePlatform,
      profileUrl,
      profile.profileInternalId || profile.bloggerId,
    );
    const accountNo = resolveMonitorAccountNo(
      pagePlatform,
      profile,
      profileInternalId,
    );
    const candidate = buildMonitorSubjectCandidate({
      platform: pagePlatform,
      subjectType,
      profileInternalId,
      accountNo,
      displayName: profile.displayName || profile.bloggerName,
      profileUrl,
      avatarUrl: profile.avatarUrl || profile.bloggerAvatarSnapshot,
      assignedAgentId: getCurrentAuth()?.captureAgent?.id || "",
    });

    if (!candidate) {
      throw new Error("未识别到账号唯一 ID");
    }

    return candidate;
  }
  async function handleAddCurrentMonitor() {
    if (!isMonitorAuthReady()) {
      showMessage(MONITOR_REQUIRED_MESSAGE, "warning");
      return;
    }

    const subjectType = getMonitorSubjectType();
    const subjectLabel = getMonitorSubjectLabel(subjectType);
    showProgress(`正在识别并登记${subjectLabel}...`);

    try {
      const candidate = await captureCurrentMonitorCandidate(subjectType);
      await addMonitorSubscriptionByCandidate(candidate);
    } catch (error) {
      console.error("[Sidebar] Add current monitor failed:", error);
      showMessage(`${subjectLabel}登记失败: ${error.message}`, "error");
    } finally {
      hideProgress();
    }
  }
  async function handleAddMonitorFromRecord(recordId) {
    if (!isMonitorAuthReady()) {
      showMessage(MONITOR_REQUIRED_MESSAGE, "warning");
      return;
    }

    const dataPool = getCurrentDataPool();
    const records = Array.isArray(dataPool?.records) ? dataPool.records : [];
    const record = records.find((item) => item?.id === recordId) || null;
    const candidate = buildMonitorCandidateFromRecord(record);

    if (!candidate) {
      showMessage("当前博主卡缺少可用信息，无法纳入监控", "error");
      return;
    }

    showProgress("正在将博主卡纳入监控...");

    try {
      await addMonitorSubscriptionByCandidate(candidate);
    } catch (error) {
      console.error("[Sidebar] Add monitor from record failed:", error);
      showMessage(`纳入监控失败: ${error.message}`, "error");
    } finally {
      hideProgress();
    }
  }
  function resolveMonitorSettingsSaveErrorMessage(message) {
    const raw = String(message || "").trim();
    if (!raw) {
      return "保存监控规则失败";
    }

    if (raw.includes("monitor tables are missing in database")) {
      return "保存失败：本地数据库缺少监控相关表，请先执行数据库迁移。";
    }

    if (raw.includes("monitor table columns are out of date")) {
      return "保存失败：本地数据库表结构版本过旧，请执行最新数据库迁移。";
    }

    if (raw.includes("credential owner user is missing in database")) {
      return "保存失败：当前激活码关联用户不存在，请重新验证激活码。";
    }

    if (raw.includes("failed to save monitor settings")) {
      return "保存失败：后端未能写入监控设置，请检查本地后端日志。";
    }

    return raw;
  }
  async function handleSaveMonitorSettings() {
    const settings = readMonitorSettingsForm();
    if (!isMonitorAuthReady()) {
      await setCurrentMonitor({
        settings,
      });
      return;
    }

    await setCurrentMonitor({isSavingSettings: true});
    const result = await saveMonitorSettings(settings);
    await setCurrentMonitor({isSavingSettings: false});

    if (!result?.ok) {
      showMessage(
        resolveMonitorSettingsSaveErrorMessage(result?.message),
        "error",
      );
      return;
    }

    const savedSettings = normalizeMonitorSettingsInput(
      result.data?.settings || settings,
    );
    await setCurrentMonitor({
      settings: savedSettings,
    });
    populateMonitorSettingsForm(savedSettings);
    await loadMonitorSubscriptions({force: true});
    showMessage("监控规则已保存", "success");
  }
  async function handleLegacyMonitorAction(intent) {
    if (!intent) return;
    const subscriptionId = intent.readSubscriptionId();
    if (!subscriptionId) {
      return;
    }

    const monitor = getCurrentMonitor() || {};
    const subscription = Array.isArray(monitor.items)
      ? monitor.items.find((item) => item.id === subscriptionId)
      : null;

    if (!subscription) {
      showMessage("监控项不存在，请刷新后重试", "error");
      return;
    }

    if (intent.isToggle()) {
      const nextStatus = String(
        intent.readNextStatus() || MONITOR_STATUS.PAUSED,
      ).trim();
      const result = await updateMonitorSubscription(subscription.id, {
        status: nextStatus,
      });
      if (!result?.ok) {
        showMessage(result?.message || "更新监控状态失败", "error");
        return;
      }
      await loadMonitorSubscriptions({force: true});
      showMessage(
        nextStatus === MONITOR_STATUS.ACTIVE ? "监控已恢复" : "监控已暂停",
        "success",
      );
      return;
    }

    if (intent.isDelete()) {
      const confirmed = controllerPorts.taskView.confirmMonitorRemoval();
      if (!confirmed) {
        return;
      }

      const result = await updateMonitorSubscription(subscription.id, {
        status: MONITOR_STATUS.DELETED,
      });
      if (!result?.ok) {
        showMessage(result?.message || "删除监控失败", "error");
        return;
      }

      await loadMonitorSubscriptions({force: true});
      showMessage("监控已删除", "success");
    }
  }

  // Compatibility-only action; a rendered candidate is not a trusted new-UI command.
  function monitorLegacyBenchmarkCandidate(url, readName) {
    if (!isMonitorAuthReady()) {
      showMessage(MONITOR_REQUIRED_MESSAGE, "warning");
      return;
    }
    if (!url) {
      showMessage("候选账号缺少主页链接，暂时无法纳入监控", "warning");
      return;
    }
    const platform = getPagePlatform(getCurrentRuntime());
    const platformBloggerId = extractPlatformMonitorBloggerId(platform, url, "");
    if (!platformBloggerId) {
      showMessage("候选账号缺少主页 ID，暂时无法纳入监控", "warning");
      return;
    }
    addMonitorSubscriptionByCandidate({
      platform,
      platformBloggerId,
      bloggerNameSnapshot: readName(),
      bloggerUrl: url,
      bloggerAvatarSnapshot: "",
    }).catch((error) => {
      showMessage(`纳入监控失败：${error.message}`, "error");
    });
  }

  return Object.freeze({
    isMonitorAuthReady,
    loadMonitorSubscriptions,
    loadMonitorExecutions,
    loadExecutionDetails,
    normalizeMonitorSettingsInput,
    loadMonitorSettings,
    normalizeMonitorSubjectType,
    extractPlatformMonitorBloggerId,
    resolveMonitorAccountNo,
    buildMonitorSubjectCandidate,
    buildMonitorCandidateFromRecord,
    addMonitorSubscriptionByCandidate,
    captureCurrentMonitorCandidate,
    handleAddCurrentMonitor,
    handleAddMonitorFromRecord,
    resolveMonitorSettingsSaveErrorMessage,
    handleSaveMonitorSettings,
    handleLegacyMonitorAction,
    monitorLegacyBenchmarkCandidate,
  });
}
