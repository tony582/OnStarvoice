// L3-B keyword-plan: explicit legacy-view responsibility.
export function createKeywordPlanView({legacyViewState, ports, application, keywordModel, viewOperations}) {
  const {
    HTMLElement,
    KEYWORD_PLAN_CONTROL_IDS,
    KEYWORD_PLAN_MODE_LABELS,
    KEYWORD_PLAN_STATUS_LABELS,
    KEYWORD_PLAN_TERMINAL_STATUSES,
    KEYWORD_SORT_DIMENSION_LABEL,
    MAX_BATCH_KEYWORDS,
    SEARCH_FILTER_FIELD_META,
    SEARCH_FILTER_SCOPE_META,
    clearInterval,
    document,
    getCurrentRuntime,
    getViewPlatform,
    setInterval,
    showMessage,
  } = ports;
  const dedupeKeywords = (...args) => application.dedupeKeywords(...args);
  const getDateListFromText = (...args) => application.getDateListFromText(...args);
  const getSearchBatchKeywordsFromTextarea = (...args) => application.getSearchBatchKeywordsFromTextarea(...args);
  const getSearchFilterConfig = (...args) => application.getSearchFilterConfig(...args);
  const isExplicitUserUnattendedCancellationMessage = (...args) => application.isExplicitUserUnattendedCancellationMessage(...args);
  const normalizeDateListText = (...args) => application.normalizeDateListText(...args);
  const normalizeKeywordPlanMode = (...args) => application.normalizeKeywordPlanMode(...args);
  const normalizeKeywordSortDimension = (...args) => application.normalizeKeywordSortDimension(...args);
  const normalizeSearchFilterPlatform = (...args) => application.normalizeSearchFilterPlatform(...args);
  const normalizeSearchFilterValueForStorage = (...args) => application.normalizeSearchFilterValueForStorage(...args);
  const parseKeywordsFromMultilineInput = (...args) => application.parseKeywordsFromMultilineInput(...args);
  const renderKeywordPlanStatus = (...args) => application.renderKeywordPlanStatus(...args);

  function populateKeywordPlanSchedule(plan) {
    forEachKeywordPlanScope((scope) => {
      const enabledInput = getKeywordPlanControl(scope, "enabled");
      if (enabledInput) {
        enabledInput.checked = Boolean(plan?.enabled);
      }
      const modeInput = getKeywordPlanControl(scope, "mode");
      if (modeInput) {
        modeInput.value = normalizeKeywordPlanMode(plan?.mode);
      }
      const startInput = getKeywordPlanControl(scope, "startTime");
      if (startInput) {
        startInput.value = String(plan?.startTime || "09:00");
      }
      const jitterInput = getKeywordPlanControl(scope, "jitter");
      if (jitterInput) {
        jitterInput.value = String(Number(plan?.randomOffsetMin) || 0);
      }
      const autoLoopInput = getKeywordPlanControl(scope, "autoLoop");
      if (autoLoopInput) {
        autoLoopInput.checked = true;
      }
      const roundGapInput = getKeywordPlanControl(scope, "roundGap");
      if (roundGapInput) {
        roundGapInput.value = String(Math.max(0, Number(plan?.roundGapMin) || 10));
      }
      const maxRoundsInput = getKeywordPlanControl(scope, "maxRounds");
      if (maxRoundsInput) {
        maxRoundsInput.value = String(Math.max(1, Number(plan?.maxRounds) || 1));
      }
      const customTextarea = getKeywordPlanControl(scope, "customDates");
      if (customTextarea) {
        customTextarea.value = normalizeDateListText(
          plan?.customDates || plan?.holidayDates,
        );
      }
    });
  }
  function populateKeywordPlanKeywords(keywords, readFilters, planPlatform) {
    forEachKeywordPlanScope((scope) => {
      const textarea = getKeywordPlanControl(scope, "keywords");
      if (textarea && !textarea.value.trim() && keywords.length > 0) {
        textarea.value = keywords.join("\n");
      }
      populateSearchFilterControlsFromFilters(
        scope,
        readFilters(),
        planPlatform,
      );
    });
  }
  function getBatchKeywordsFromTextarea() {
    const textarea = document.getElementById("textareaBatchKeywords");
    return parseKeywordsFromMultilineInput(textarea?.value || "");
  }
  function normalizeKeywordPlanScope(scope = "modal") {
    return scope === "search" ? "search" : "modal";
  }
  function getKeywordPlanControl(scope, name) {
    const normalizedScope = normalizeKeywordPlanScope(scope);
    const id = KEYWORD_PLAN_CONTROL_IDS[normalizedScope]?.[name];
    return id ? document.getElementById(id) : null;
  }
  function renderSearchFilterSelectOptions(select, options = [], preferredValue = "") {
    if (!select) {
      return "";
    }
    const safeOptions = Array.isArray(options) ? options : [];
    const fallbackValue = safeOptions[0]?.value || "";
    const preferred = String(preferredValue || "").trim();
    const hasPreferred = safeOptions.some((option) => option.value === preferred);
    const nextValue = hasPreferred ? preferred : fallbackValue;

    select.textContent = "";
    safeOptions.forEach((option) => {
      const optionEl = document.createElement("option");
      optionEl.value = option.value;
      optionEl.textContent = option.label;
      select.appendChild(optionEl);
    });
    select.value = nextValue;
    return nextValue;
  }
  function getSearchFilterSelectValue(scope, field) {
    const control = getKeywordPlanControl(scope, field);
    const meta = SEARCH_FILTER_FIELD_META[field] || {};
    return String(control?.value || meta.defaultValue || "").trim();
  }
  function collectSearchFiltersFromControls(scope = "modal") {
    const normalizedScope = normalizeKeywordPlanScope(scope);
    return Object.keys(SEARCH_FILTER_FIELD_META).reduce((filters, field) => {
      const value = normalizeSearchFilterValueForStorage(
        field,
        getSearchFilterSelectValue(normalizedScope, field),
      );
      if (value) {
        filters[field] = value;
      }
      return filters;
    }, {});
  }
  function populateSearchFilterControlsFromFilters(
    scope = "modal",
    filters = {},
    platform = "",
  ) {
    syncSearchFilterControlsForPlatform(platform, {
      scope,
      values: filters,
    });
  }
  function syncSearchFilterControlsForPlatform(
    platform = "",
    {scope = null, values = null} = {},
  ) {
    const runtime = getCurrentRuntime();
    const normalizedPlatform = normalizeSearchFilterPlatform(
      platform || getViewPlatform(runtime),
    );
    const config = getSearchFilterConfig(normalizedPlatform);
    const scopes = typeof scope === "string" ? [normalizeKeywordPlanScope(scope)] : ["search", "modal"];

    scopes.forEach((itemScope) => {
      const currentValues = values || {};
      Object.keys(SEARCH_FILTER_FIELD_META).forEach((field) => {
        const options = config[field] || [];
        const control = getKeywordPlanControl(itemScope, field);
        const preferred =
          currentValues[field] ||
          control?.value ||
          SEARCH_FILTER_FIELD_META[field]?.defaultValue ||
          "";
        renderSearchFilterSelectOptions(control, options, preferred);
      });

      const meta = SEARCH_FILTER_SCOPE_META[itemScope] || {};
      const hintEl = meta.hint ? document.getElementById(meta.hint) : null;
      if (hintEl) {
        hintEl.textContent = `${config.platformLabel}筛选项 · 采集前自动切换`;
      }
      const contentTypeLabel = meta.contentTypeLabel
        ? document.getElementById(meta.contentTypeLabel)
        : null;
      if (contentTypeLabel) {
        contentTypeLabel.textContent = config.contentTypeLabel || "内容类型";
      }

      [
        ["contentTypeField", config.contentType],
        ["searchScopeField", config.searchScope],
        ["distanceField", config.distance],
        ["videoDurationField", config.videoDuration],
      ].forEach(([metaKey, options]) => {
        const fieldEl = meta[metaKey] ? document.getElementById(meta[metaKey]) : null;
        if (fieldEl) {
          fieldEl.hidden = !Array.isArray(options) || options.length === 0;
        }
      });
    });
  }
  function forEachKeywordPlanScope(callback) {
    ["search", "modal"].forEach((scope) => callback(scope));
  }
  function renderSearchKeywordPlanDateChips() {
    const chipsEl = document.getElementById("searchKeywordPlanDateChips");
    const textarea = getKeywordPlanControl("search", "customDates");
    if (!chipsEl || !textarea) {
      return;
    }
    const dates = getDateListFromText(textarea.value);
    chipsEl.textContent = "";
    if (dates.length === 0) {
      const empty = document.createElement("span");
      empty.className = "keyword-plan-date-empty";
      empty.textContent = "暂无指定日期";
      chipsEl.appendChild(empty);
      return;
    }
    dates.forEach((date) => {
      const chip = document.createElement("span");
      chip.className = "keyword-plan-date-chip";
      chip.textContent = date;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.dataset.keywordPlanDateRemove = date;
      removeButton.setAttribute("aria-label", `移除 ${date}`);
      removeButton.textContent = "×";
      chip.appendChild(removeButton);
      chipsEl.appendChild(chip);
    });
  }
  function setSearchKeywordPlanDateList(dates = []) {
    const textarea = getKeywordPlanControl("search", "customDates");
    if (!textarea) {
      return;
    }
    textarea.value = normalizeDateListText(dates.join("\n"));
    renderSearchKeywordPlanDateChips();
    renderKeywordPlanStatus(keywordModel.keywordPlanState(), "search");
  }
  function addSearchKeywordPlanDateFromPicker() {
    const input = document.getElementById("inputSearchKeywordPlanDatePicker");
    const value = String(input?.value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      showMessage("请选择要加入无人值守计划的运行日期", "warning");
      return;
    }
    const textarea = getKeywordPlanControl("search", "customDates");
    const dates = getDateListFromText(textarea?.value || "");
    setSearchKeywordPlanDateList([...dates, value]);
    if (input) {
      input.value = "";
    }
  }
  function handleSearchKeywordPlanDateChipClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest("[data-keyword-plan-date-remove]");
    if (!(button instanceof HTMLElement)) {
      return;
    }
    const removeDate = String(button.dataset.keywordPlanDateRemove || "").trim();
    const textarea = getKeywordPlanControl("search", "customDates");
    const dates = getDateListFromText(textarea?.value || "").filter(
      (date) => date !== removeDate,
    );
    setSearchKeywordPlanDateList(dates);
  }
  function setSearchExecutionMode(mode = "manual") {
    const normalizedMode = mode === "plan" ? "plan" : "manual";
    document
      .querySelectorAll("[data-search-execution-mode]")
      .forEach((tab) => {
        const isActive = tab.getAttribute("data-search-execution-mode") === normalizedMode;
        tab.classList.toggle("is-active", isActive);
        tab.setAttribute("aria-selected", isActive ? "true" : "false");
      });
    const manualPane = document.getElementById("searchManualExecutionPane");
    const planPane = document.getElementById("searchPlanExecutionPane");
    const manualActionRow = document.getElementById("searchManualActionRow");
    if (manualPane) {
      manualPane.hidden = normalizedMode !== "manual";
    }
    if (planPane) {
      planPane.hidden = normalizedMode !== "plan";
    }
    if (manualActionRow) {
      manualActionRow.hidden = normalizedMode !== "manual";
    }
  }
  function readNonNegativeNumberInput(inputId, fallback = 0) {
    const raw = document.getElementById(inputId)?.value;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return fallback;
    }
    return Math.floor(parsed);
  }
  function readPositiveNumberInput(inputId, fallback = 1) {
    const raw = document.getElementById(inputId)?.value;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.floor(parsed);
  }
  function collectKeywordPlanFromInputs(scope = "modal") {
    const normalizedScope = normalizeKeywordPlanScope(scope);
    const runtime = getCurrentRuntime();
    const selectedPlatform = getViewPlatform(runtime);
    const roundGapMin = readNonNegativeNumberInput(
      KEYWORD_PLAN_CONTROL_IDS[normalizedScope].roundGap,
      10,
    );
    const maxRounds = readPositiveNumberInput(
      KEYWORD_PLAN_CONTROL_IDS[normalizedScope].maxRounds,
      1,
    );
    const keywords =
      normalizedScope === "search"
        ? dedupeKeywords(getSearchBatchKeywordsFromTextarea())
        : dedupeKeywords(getBatchKeywordsFromTextarea());
    return {
      enabled: Boolean(
        getKeywordPlanControl(normalizedScope, "enabled")?.checked,
      ),
      platform:
        selectedPlatform && selectedPlatform !== "unknown"
          ? selectedPlatform
          : "xiaohongshu",
      mode: normalizeKeywordPlanMode(
        getKeywordPlanControl(normalizedScope, "mode")?.value,
      ),
      startTime:
        getKeywordPlanControl(normalizedScope, "startTime")?.value || "09:00",
      randomOffsetMin: readNonNegativeNumberInput(
        KEYWORD_PLAN_CONTROL_IDS[normalizedScope].jitter,
        20,
      ),
      keywords: keywords.slice(0, MAX_BATCH_KEYWORDS),
      searchFilters: collectSearchFiltersFromControls(normalizedScope),
      autoLoop: maxRounds > 1,
      roundGapMin,
      maxRounds,
      holidayDates: "",
      customDates: normalizeDateListText(
        getKeywordPlanControl(normalizedScope, "customDates")?.value,
      ),
    };
  }
  function syncKeywordPlanDateFields(scope = null) {
    const scopes = typeof scope === "string" ? [scope] : ["search", "modal"];
    scopes.forEach((itemScope) => {
      const normalizedScope = normalizeKeywordPlanScope(itemScope);
      const mode = normalizeKeywordPlanMode(
        getKeywordPlanControl(normalizedScope, "mode")?.value,
      );
      const customGroup = getKeywordPlanControl(normalizedScope, "customGroup");
      if (customGroup) {
        customGroup.hidden = mode !== "custom_dates";
      }
      if (normalizedScope === "search") {
        renderSearchKeywordPlanDateChips();
      }
    });
  }
  function formatKeywordPlanRunTime(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) {
      return "";
    }
    return new Date(timestamp).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  function renderKeywordPlanStatusLabels(plan = keywordModel.keywordPlanState(), scope = null) {
    const scopes = typeof scope === "string" ? [scope] : ["search", "modal"];
    scopes.forEach((itemScope) => {
      const normalizedScope = normalizeKeywordPlanScope(itemScope);
      const statusEl = getKeywordPlanControl(normalizedScope, "status");
      if (!statusEl) {
        return;
      }
      const checked = Boolean(
        getKeywordPlanControl(normalizedScope, "enabled")?.checked,
      );
      if (checked !== Boolean(plan?.enabled)) {
        statusEl.textContent = checked ? "保存后启用计划" : "保存后关闭计划";
        return;
      }
      if (!plan?.enabled) {
        statusEl.textContent = "计划未启用";
        return;
      }
      const keywordCount = Array.isArray(plan.keywords) ? plan.keywords.length : 0;
      const modeLabel =
        KEYWORD_PLAN_MODE_LABELS[normalizeKeywordPlanMode(plan.mode)] || "每天";
      const lastRunStatus = String(plan.lastRunStatus || "");
      const isRunningPlan = ["started", "running", "recovering"].includes(
        lastRunStatus,
      );
      const nextRunText = isRunningPlan
        ? ""
        : formatKeywordPlanRunTime(plan.nextRunAt);
      const nextPart = isRunningPlan
        ? "当前运行中"
        : nextRunText
          ? `下次 ${nextRunText}`
          : "暂无可运行日期";
      const ambiguousCanceled =
        lastRunStatus === "canceled" &&
        !isExplicitUserUnattendedCancellationMessage(plan.lastRunMessage);
      const lastRunStatusLabel = ambiguousCanceled
        ? "异常中断"
        : KEYWORD_PLAN_STATUS_LABELS[lastRunStatus] || lastRunStatus;
      const lastRunMessage = ambiguousCanceled
        ? "运行状态异常中断（非用户操作）"
        : String(plan.lastRunMessage || "");
      const lastPart = plan.lastRunStatus
        ? `；${isRunningPlan ? "当前" : "上次"} ${lastRunStatusLabel}${lastRunMessage ? `：${lastRunMessage}` : ""}`
        : "";
      statusEl.textContent = `已启用 · ${modeLabel} · ${keywordCount} 个关键词 · ${nextPart}${lastPart}`;
    });
  }
  function getKeywordExecutionCopy(source = {}) {
    const executionMode =
      String(source?.executionMode || "").trim() === "one_time"
        ? "one_time"
        : "unattended_plan";
    const oneTime = executionMode === "one_time";
    return {
      executionMode,
      taskLabel: oneTime ? "一次性采集任务" : "无人值守计划",
      captureLabel: oneTime ? "一次性采集" : "无人值守采集",
    };
  }
  function unattendedSearchPassLabel(value = "") {
    return {
      all: "综合巡检",
      image: "图文巡检",
      video: "视频巡检",
    }[String(value || "").trim()] || "巡检";
  }
  function clearKeywordPlanProgressCountdown() {
    legacyViewState.keywordPlanProgressCountdownToken += 1;
    if (legacyViewState.keywordPlanProgressCountdownTimer) {
      clearInterval(legacyViewState.keywordPlanProgressCountdownTimer);
      legacyViewState.keywordPlanProgressCountdownTimer = null;
    }
  }
  function buildKeywordPlanProgressText(plan = {}) {
    const progress =
      plan?.lastRunProgress && typeof plan.lastRunProgress === "object"
        ? plan.lastRunProgress
        : {};
    const executionCopy = getKeywordExecutionCopy(plan);
    const message =
      String(progress.message || plan?.lastRunMessage || "").trim() ||
      `${executionCopy.taskLabel}运行中`;
    const round = Number(progress.round);
    const maxRounds = Number(plan?.maxRounds);
    const keyword = String(progress.keyword || "").trim();
    const keywords = Array.isArray(plan?.keywords)
      ? plan.keywords.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const explicitKeywordCurrent = Number(progress.keywordCurrent);
    const explicitKeywordTotal = Number(progress.keywordTotal);
    const keywordIndex = keyword ? keywords.indexOf(keyword) : -1;
    const keywordTotal =
      Number.isFinite(explicitKeywordTotal) && explicitKeywordTotal > 0
        ? Math.floor(explicitKeywordTotal)
        : keywords.length;
    const keywordCurrent =
      Number.isFinite(explicitKeywordCurrent) && explicitKeywordCurrent > 0
        ? Math.floor(explicitKeywordCurrent)
        : keywordIndex >= 0
          ? keywordIndex + 1
          : 0;
    const itemCurrent = Number(progress.itemCurrent);
    const itemTotal = Number(progress.itemTotal);
    const parts = [executionCopy.captureLabel];
    const shouldShowRound =
      Number.isFinite(round) &&
      round > 0 &&
      ((Number.isFinite(maxRounds) && maxRounds > 1) || round > 1);

    if (shouldShowRound) {
      parts.push(`第 ${round} 轮`);
    }
    if (keywordTotal > 0) {
      parts.push(
        `关键词 ${Math.min(Math.max(0, keywordCurrent), keywordTotal)}/${keywordTotal}`,
      );
    }
    if (keyword) {
      parts.push(`「${keyword}」`);
    }
    if (Number.isFinite(itemTotal) && itemTotal > 0) {
      const normalizedItemCurrent =
        Number.isFinite(itemCurrent) && itemCurrent > 0
          ? Math.min(Math.floor(itemCurrent), Math.floor(itemTotal))
          : 0;
      parts.push(
        `当前词内作品 ${normalizedItemCurrent}/${Math.floor(itemTotal)}`,
      );
    }

    return `${parts.join(" · ")}：${message}`;
  }
  function renderKeywordPlanProgressText(progressText, plan = {}) {
    const text = buildKeywordPlanProgressText(plan);
    const progress =
      plan?.lastRunProgress && typeof plan.lastRunProgress === "object"
        ? plan.lastRunProgress
        : {};
    const remainingMs = Number(progress.remainingMs);
    const canCountdown =
      Number.isFinite(remainingMs) &&
      remainingMs > 0 &&
      /秒后/.test(text);

    clearKeywordPlanProgressCountdown();
    if (!canCountdown) {
      progressText.textContent = text;
      return;
    }

    const token = legacyViewState.keywordPlanProgressCountdownToken;
    // 以「上报时刻」为锚(updatedAt 是测得 remainingMs 的时刻),得到绝对截止时刻;
    // 这样即便 5 秒一次的 reconcile / storage 用陈旧的相对 remainingMs 反复重调,
    // deadline 也恒指向同一真实时刻——底部条平滑走到 0、不再循环(词2也不再"假卡")。
    // updatedAt 缺失/非法时回退旧行为,绝不更差。
    const reportedAt = Date.parse(progress.updatedAt);
    const deadline =
      (Number.isFinite(reportedAt) ? reportedAt : Date.now()) + remainingMs;
    const render = () => {
      if (token !== legacyViewState.keywordPlanProgressCountdownToken) {
        return;
      }
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (seconds > 0) {
        progressText.textContent = text.replace(/\d+\s*秒后/g, `${seconds} 秒后`);
        return;
      }
      progressText.textContent = text.replace(
        /\d+\s*秒后再搜下一个关键词\(防风控·随机间隔\)[…\.]*/g,
        "正在切换到下一个关键词...",
      );
      clearKeywordPlanProgressCountdown();
    };
    render();
    legacyViewState.keywordPlanProgressCountdownTimer = setInterval(render, 1000);
  }
  function hideKeywordPlanProgressPanelIfOwned(plan = keywordModel.keywordPlanState()) {
    const progressContainer = document.getElementById("progressContainer");
    if (!progressContainer) {
      return;
    }
    const status = String(plan?.lastRunStatus || "").trim().toLowerCase();
    const terminal = KEYWORD_PLAN_TERMINAL_STATUSES.has(status);
    const progressSource = String(
      progressContainer.dataset.progressSource || "",
    );
    const unattendedState = String(
      progressContainer.dataset.unattendedProgressState || "",
    );
    const ownedByKeywordPlan =
      progressSource === "keyword-plan" ||
      unattendedState === "running" ||
      unattendedState === "terminal" ||
      (terminal && Boolean(keywordModel.activeUnattendedRunRequestId()));
    if (!ownedByKeywordPlan) {
      return;
    }
    clearKeywordPlanProgressCountdown();
    progressContainer.style.display = "none";
    delete progressContainer.dataset.progressSource;
    if (terminal) {
      progressContainer.dataset.unattendedProgressState = "terminal";
    } else {
      delete progressContainer.dataset.unattendedProgressState;
    }
    const btnCancel = document.getElementById("btnCancel");
    if (btnCancel) {
      btnCancel.textContent = "中止任务";
      btnCancel.hidden = true;
      btnCancel.disabled = true;
      btnCancel.style.display = "none";
    }
  }
  function openKeywordPlanProgress() {
    const progressContainer = document.getElementById("progressContainer");
    const progressText = document.getElementById("progressText");
    if (!progressContainer || !progressText) return null;
    return Object.freeze({render(plan) {
    progressContainer.dataset.progressSource = "keyword-plan";
    progressContainer.dataset.unattendedProgressState = "running";
    progressContainer.style.display = "block";
    renderKeywordPlanProgressText(progressText, plan);
    const progressBar = document.getElementById("progressBar");
    if (progressBar) {
      progressBar.className = "status-bar is-info";
    }
    const btnCancel = document.getElementById("btnCancel");
    if (btnCancel) {
      btnCancel.textContent = "中止任务";
      btnCancel.hidden = false;
      btnCancel.disabled = false;
      btnCancel.style.display = "inline-block";
    }
    }});
  }
  function getKeywordSortDimensionLabel(dimension) {
    const normalized = normalizeKeywordSortDimension(dimension);
    return KEYWORD_SORT_DIMENSION_LABEL[normalized] || "点赞";
  }
  function applyKeywordSortDimensionToUI(dimension) {
    const normalized = normalizeKeywordSortDimension(dimension);
    const label = getKeywordSortDimensionLabel(normalized);
    const labelNode = document.getElementById("labelKeywordMinThreshold");
    if (labelNode) {
      labelNode.textContent = `达到以下${label}数才会被采集`;
    }

    const inputNode = document.getElementById("inputKeywordMinLikes");
    if (inputNode && !String(inputNode.placeholder || "").trim()) {
      inputNode.placeholder = "例如 0";
    }
  }

  return Object.freeze({
    populateKeywordPlanSchedule,
    populateKeywordPlanKeywords,
    getBatchKeywordsFromTextarea,
    normalizeKeywordPlanScope,
    getKeywordPlanControl,
    renderSearchFilterSelectOptions,
    getSearchFilterSelectValue,
    collectSearchFiltersFromControls,
    populateSearchFilterControlsFromFilters,
    syncSearchFilterControlsForPlatform,
    forEachKeywordPlanScope,
    renderSearchKeywordPlanDateChips,
    setSearchKeywordPlanDateList,
    addSearchKeywordPlanDateFromPicker,
    handleSearchKeywordPlanDateChipClick,
    setSearchExecutionMode,
    readNonNegativeNumberInput,
    readPositiveNumberInput,
    collectKeywordPlanFromInputs,
    syncKeywordPlanDateFields,
    formatKeywordPlanRunTime,
    renderKeywordPlanStatusLabels,
    getKeywordExecutionCopy,
    unattendedSearchPassLabel,
    clearKeywordPlanProgressCountdown,
    buildKeywordPlanProgressText,
    renderKeywordPlanProgressText,
    hideKeywordPlanProgressPanelIfOwned,
    openKeywordPlanProgress,
    getKeywordSortDimensionLabel,
    applyKeywordSortDimensionToUI,
  });
}
