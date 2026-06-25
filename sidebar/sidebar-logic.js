/**
 * onstarvoice V2.0 Sidebar Business Logic
 * 侧边栏业务逻辑层
 *
 * 本模块负责：
 * 1. 连接 UI 层（Gemini 的新 sidebar）和数据层（采集模块、存储层）
 * 2. 处理用户交互事件
 * 3. 更新 UI 状态
 * 4. 调用采集和同步功能
 */

import {
  initAllStates,
  subscribe,
  getCurrentRuntime,
  getCurrentAuth,
  getCurrentTarget,
  getCurrentCapture,
  getCurrentSync,
  getCurrentMonitor,
  getCurrentDataPool,
  setCurrentAuth,
  setCurrentMonitor,
  resetCurrentMonitor,
  setCurrentTarget,
  refreshDataPool,
  refreshSyncHistory,
} from "./state.js";

import {
  captureAndSync,
  captureNoteWithOptionalComments,
  retryCommentsForRecord,
  batchCaptureDetailsForRecords,
  repairInterruptedDetailCaptureRecords,
  resolveSyncInputForRecord,
  syncRecordBatch,
  checkBeforeSync,
  buildCommentLeadsConfigFromSettings,
  buildCommentLeadsPayloadForRecord,
  batchCaptureByKeywords,
  batchCaptureByUrls,
  lightSampleByKeywords,
  captureTabContent,
} from "../utils/capture-sync.js";
import {
  getCaptureSettings,
  saveCaptureSettings,
  DEFAULT_CAPTURE_SETTINGS,
} from "../utils/capture-settings.js";
import {addSyncHistoryEntry, getRecords} from "../utils/storage.js";

import {
  verify,
  getTargetConfig,
  saveTargetConfig,
  getUpdateManifest,
  analyzeKeywords,
  analyzeKeywordOpportunity,
  analyzeBenchmarkDiscovery,
  listMonitorSubscriptions,
  listMonitorExecutions,
  startMonitorExecution,
  finishMonitorExecution,
  getMonitorSettings,
  saveMonitorSettings,
  createMonitorSubscription,
  updateMonitorSubscription,
  runMonitorNow,
} from "../utils/api.js";
import {
  PAGE_TYPE,
  ERROR_REASON,
  ERROR_MESSAGE_MAP,
  AUTH_STATUS,
  SYNC_TYPE,
  MESSAGE_TYPE,
  DEFAULT_CONFIG,
  UNCLAIMED_CREDENTIAL_OWNER_EMAIL,
  UNCLAIMED_CREDENTIAL_OWNER_NAME,
  CREDENTIAL_CLAIM_PAGE_URL,
} from "../utils/constants.js";
import {setCancelFlag, wait} from "../utils/scroll.js";
import {
  buildDiagnosticsText,
  recordDiagnosticAction,
  recordDiagnosticError,
  recordDiagnosticTask,
} from "../utils/diagnostics.js";
import {
  beginTaskContext,
  completeTaskContext,
} from "../utils/task-context.js";
import {
  AUTH_CODE_VIEW_MODE,
  ensureEncryptedAuthCode,
  ensurePlainAuthCode,
  isEncryptedAuthCode,
  normalizeAuthCodeInput,
} from "../utils/auth-code.js";
import {extractNoteId} from "../utils/helpers.js";
import {detectPlatformFromUrl} from "../utils/platform/page-routing.js";
import {
  getPlatformCapabilities,
  getPlatformCopy,
  getRecordTypesForTab,
  resolveRecordPlatform,
} from "./platform-registry.js";

let activeCommentsCaptureRecordId = "";
const commentCaptureTerminalStatusByRecordId = new Map();
let detailBatchCaptureInFlight = false;
let detailBatchCancelRequested = false;
let detailBatchRunnerTabId = null;
let lastProgressSyncAt = 0;
let lastPoolRefreshAt = 0;
const DEFAULT_BLOGGER_PROFILE_TABLE_NAME = "博主信息表";
const DEFAULT_BLOGGER_NOTES_TABLE_NAME = "博主笔记采集";
const DEFAULT_KEYWORD_NOTES_TABLE_NAME = "关键词笔记采集";
const DEFAULT_COMMENT_LEADS_TABLE_NAME = "评论区客资采集";
const DEFAULT_MONITOR_TABLE_NAME = "监控内容表";
const DEFAULT_SINGLE_NOTE_TABLE_NAME = "单笔记采集";
const MAX_SYNC_RECORDS_PER_BATCH = 500;
const SYNC_SCOPE_PENDING = "pending";
const SYNC_SCOPE_ALL = "all";
const DETAIL_CAPTURE_SCOPE_PENDING = "pending";
const DETAIL_CAPTURE_SCOPE_ALL = "all";
const SYNC_BATCH_LIMIT_MESSAGE =
  "单次同步上限为 500 条，请分批操作，本次同步前 500 条数据";
const AUTH_CODE_AUTO_ENCRYPT_DELAY = 600;
const AUTH_REQUIRED_MESSAGE =
  "当前功能需要激活码授权，已有激活码请在设置中完成验证；还没有可联系管理员获取。";
const MONITOR_REQUIRED_MESSAGE = AUTH_REQUIRED_MESSAGE;
const PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE = AUTH_REQUIRED_MESSAGE;
const MONITOR_PUBLISH_WINDOW = Object.freeze({
  LAST_24H: "last_24h",
  PREVIOUS_DAY: "previous_day",
});
const MONITOR_PUBLISH_WINDOW_OPTIONS = new Set(
  Object.values(MONITOR_PUBLISH_WINDOW),
);
const MONITOR_DAY_MS = 24 * 60 * 60 * 1000;
const MONITOR_SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function beginSidebarTask({
  taskType = "task",
  featureKey = "unknown",
  metadata = {},
} = {}) {
  const taskContext = beginTaskContext({
    taskType,
    featureKey,
    source: "sidebar",
    metadata,
  });

  void recordDiagnosticTask({
    taskContext,
    source: "sidebar",
    action: "task_start",
    status: "started",
    metadata,
  }).catch(() => null);

  return taskContext;
}

function finishSidebarTask(
  taskContext,
  {status = "completed", error = null, metadata = {}} = {},
) {
  if (!taskContext) return;
  const completedContext =
    completeTaskContext({
      taskType: taskContext.taskType,
      featureKey: taskContext.featureKey,
    }) || taskContext;

  void recordDiagnosticTask({
    taskContext: completedContext,
    source: "sidebar",
    action: "task_finish",
    status,
    metadata,
  }).catch(() => null);

  if (error) {
    void recordDiagnosticError({
      taskContext: completedContext,
      source: "sidebar",
      action: "task_finish",
      status: "failed",
      error,
      metadata,
    }).catch(() => null);
  }
}

const DEFAULT_MONITOR_SETTINGS = Object.freeze({
  publishWindow: MONITOR_PUBLISH_WINDOW.LAST_24H,
  likeThreshold: 0,
  runTimes: ["10:00"],
  observeWindowHours: 48,
  timezone: "Asia/Shanghai",
});
const MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW = Object.freeze({
  24: 20,
  48: 30,
  72: 40,
});
const MONITOR_UNKNOWN_PUBLISH_DETAIL_LIMIT = 8;
const MONITOR_OBSERVE_WINDOW_OPTIONS = Object.freeze([24, 48, 72]);
const MONITOR_RUN_TIME_OPTIONS = Object.freeze(
  Array.from({length: 24}, (_, hour) => `${String(hour).padStart(2, "0")}:00`),
);
const KEYWORD_INSIGHT_ANALYSIS_COST_CREDITS = 3;
const KEYWORD_OPPORTUNITY_ANALYSIS_COST_CREDITS = 3;
const BENCHMARK_DISCOVERY_ANALYSIS_COST_CREDITS = 3;
const BENCHMARK_DISCOVERY_PROFILE_LIMIT = 8;
const BENCHMARK_DISCOVERY_RESULT_LIMIT = 12;
const MONITOR_STATUS = Object.freeze({
  ALL: "all",
  ACTIVE: "active",
  PAUSED: "paused",
  PAUSED_INSUFFICIENT_BALANCE: "paused_insufficient_balance",
  DELETED: "deleted",
});
const KEYWORD_SORT_DIMENSION = {
  LIKES: "likes",
  COLLECTS: "collects",
  COMMENTS: "comments",
};
const KEYWORD_SORT_DIMENSION_LABEL = {
  [KEYWORD_SORT_DIMENSION.LIKES]: "点赞",
  [KEYWORD_SORT_DIMENSION.COLLECTS]: "收藏",
  [KEYWORD_SORT_DIMENSION.COMMENTS]: "评论",
};
const SEARCH_KEYWORD_QUERY_KEYS = new Set([
  "keyword",
  "query",
  "q",
  "search_keyword",
  "searchkey",
  "search_word",
]);
const COMMENT_PHASE_TO_TERMINAL_STATUS = Object.freeze({
  comments_done: "done",
  comments_partial: "partial",
  comments_failed: "failed",
});
const KEYWORD_SORT_SYNC_INTERVAL_MS = 1800;
const EXTENSION_UPDATE_MODAL_STATE_KEY = "onstarvoice.updateModalState";
const RISK_NOTICE_ACKNOWLEDGED_KEY = "onstarvoice.riskNoticeAcknowledged";
const MEMBER_GROUP_PROMPT_STATE_KEY = "onstarvoice.memberGroupPromptState";
const DEFAULT_UPDATE_DOWNLOAD_URL = "https://voice.minilife.online/about";
const DEFAULT_UPDATE_CHANGELOG_URL = "https://voice.minilife.online/about#changelog";
const EXTENSION_MANAGEMENT_URL = `chrome://extensions/?id=${chrome.runtime.id}`;
const EXTENSION_INSTALL_TYPE = Object.freeze({
  NORMAL: "normal",
  DEVELOPMENT: "development",
  SIDELOAD: "sideload",
  ADMIN: "admin",
  OTHER: "other",
});
const UPDATE_ACTION_MODE = Object.freeze({
  USE_NOW: "use_now",
  OPEN_EXTENSION_MANAGER: "open_extension_manager",
  OPEN_DOWNLOAD_PAGE: "open_download_page",
});

let authCodeViewMode = AUTH_CODE_VIEW_MODE.ENCRYPTED;
let authCodeEncryptTimer = null;
let authCodeRenderToken = 0;
let authVerifyInFlight = false;
let contactModalListenersBound = false;
let memberGroupModalListenersBound = false;
let riskModalListenersBound = false;
let updateModalListenersBound = false;
let updateGuideModalListenersBound = false;
let keywordSortDimension = KEYWORD_SORT_DIMENSION.LIKES;
let keywordSortSyncTimer = null;
let lastRuntimePageUrlForKeywordSort = "";
let expandedKeywordsBuffer = [];
let keywordExpandInFlight = false;
let keywordExpandCancelRequested = false;
let batchUrlCaptureInFlight = false;
let batchUrlCancelRequested = false;
let batchUrlCaptureMode = "";
let batchKeywordCaptureInFlight = false;
let batchKeywordCancelRequested = false;
let searchCaptureCancelRequested = false;
let activeBatchRunnerTabId = null;
let monitorRunInFlight = false;
let monitorRunCancelRequested = false;
let keywordAnalysisInFlight = false;
let keywordInsightSampleInFlight = false;
let keywordInsightRunToken = 0;
let keywordAnalysisStartedAt = 0;
let keywordStrategyPanelVisible = false;
let keywordStrategyActiveTab = "opportunity";
let keywordBenchmarkInFlight = false;
let keywordBenchmarkCancelRequested = false;
let keywordBenchmarkStartedAt = 0;
let keywordBenchmarkResult = null;
let keywordBenchmarkErrorMessage = "";
let keywordBenchmarkAnalysisStatus = "idle";
let keywordBenchmarkLoadingTitle = "";
let keywordBenchmarkLoadingMeta = "";
let keywordOpportunityInFlight = false;
let keywordOpportunityCancelRequested = false;
let keywordOpportunityStartedAt = 0;
let keywordOpportunityResult = null;
let keywordOpportunityErrorMessage = "";
let expandedKeywordsPanelVisible = false;
const expandedKeywordInsightCategoryIds = new Set();
let lastRuntimePageTypeForKeywordSort = PAGE_TYPE.UNKNOWN;
let manualSelectedPlatform = "";
let lastKnownPagePlatform = "unknown";
let currentUpdateNoticeState = null;
const KEYWORD_ANALYSIS_STALE_LOCK_MS =
  DEFAULT_CONFIG.KEYWORD_ANALYSIS_TIMEOUT + 5000;
const MAX_BATCH_KEYWORDS = 30;
const EYE_ICON = `
<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
  <circle cx="12" cy="12" r="3"></circle>
</svg>
`;
const EYE_OFF_ICON = `
<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
  <circle cx="12" cy="12" r="3"></circle>
  <path d="M3 3l18 18"></path>
</svg>
`;

// ==================== 批量操作弹窗逻辑 ====================

const BATCH_MODE_META = {
  links: {title: "批量采集作品"},
  bloggers: {title: "批量采集博主"},
  keywords: {title: "批量关键词操作"},
};
const BATCH_DRAFT_SESSION_KEY = "onstarvoice.batchDraftByPlatform";
const BATCH_DRAFT_LEGACY_KEYS = ["expandedKeywords", "expandedSeedKeyword"];
const BATCH_DRAFT_PLATFORMS = new Set(["xiaohongshu", "douyin", "unknown"]);
let batchDraftByPlatform = {};
let activeBatchDraftPlatform = "";

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
  const current = batchDraftByPlatform[normalizedPlatform];
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
  batchDraftByPlatform[normalizedPlatform] = normalizeBatchDraftEntry({
    ...currentDraft,
    ...updates,
  });
  return batchDraftByPlatform[normalizedPlatform];
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
  batchDraftByPlatform[normalizedPlatform] = normalizeBatchDraftEntry({
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
    [BATCH_DRAFT_SESSION_KEY]: batchDraftByPlatform,
  });
}

async function loadBatchDraftStore() {
  const session = await chrome.storage.session.get([
    BATCH_DRAFT_SESSION_KEY,
    ...BATCH_DRAFT_LEGACY_KEYS,
  ]);

  batchDraftByPlatform = normalizeBatchDraftStore(
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

  batchDraftByPlatform[currentPlatform] = normalizeBatchDraftEntry({
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
  const textareaLinks = document.getElementById("textareaBatchLinks");
  const textareaBloggers = document.getElementById("textareaBatchBloggers");
  const textareaBatchKeywords = document.getElementById(
    "textareaBatchKeywords",
  );
  const currentDraft = getBatchDraftForPlatform(normalizedPlatform);
  const runtime = getCurrentRuntime();
  const seedKeyword = getKeywordInsightSeedKeyword({
    runtime,
    preferStored: true,
    platform: normalizedPlatform,
  });

  const nextDraft = normalizeBatchDraftEntry({
    links: textareaLinks?.value || "",
    bloggers: textareaBloggers?.value || "",
    batchKeywordsText: textareaBatchKeywords?.value || "",
    seedKeyword,
    expandedKeywords: [...expandedKeywordsBuffer],
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

  batchDraftByPlatform[normalizedPlatform] = nextDraft;
  await persistBatchDraftStore();
}

function applyBatchDraftToInputs(platform = "", {force = false} = {}) {
  const normalizedPlatform = resolveBatchDraftPlatform(platform);
  if (!force && normalizedPlatform === activeBatchDraftPlatform) {
    return;
  }

  const draft = getBatchDraftForPlatform(normalizedPlatform);
  const textareaLinks = document.getElementById("textareaBatchLinks");
  const textareaBloggers = document.getElementById("textareaBatchBloggers");
  const textareaBatchKeywords = document.getElementById(
    "textareaBatchKeywords",
  );

  if (textareaLinks && textareaLinks.value !== draft.links) {
    textareaLinks.value = draft.links;
  }
  if (textareaBloggers && textareaBloggers.value !== draft.bloggers) {
    textareaBloggers.value = draft.bloggers;
  }
  if (
    textareaBatchKeywords &&
    textareaBatchKeywords.value !== draft.batchKeywordsText
  ) {
    textareaBatchKeywords.value = draft.batchKeywordsText;
  }

  expandedKeywordsBuffer = [...draft.expandedKeywords];
  renderExpandedKeywords();
  renderKeywordInsightState();
  updateBatchKeywordInputState();
  updateExpandKeywordsButtonState();
  activeBatchDraftPlatform = normalizedPlatform;
}

function syncBatchDraftForPlatform(platform = "") {
  const nextPlatform = resolveBatchDraftPlatform(platform);
  const previousPlatform = activeBatchDraftPlatform;

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
  const platform = activeBatchDraftPlatform || getCurrentBatchDraftPlatform();
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
  keywordOpportunityInFlight = false;
  keywordOpportunityStartedAt = 0;
  keywordOpportunityResult = null;
  keywordOpportunityErrorMessage = "";
  if (!preserveDraft) {
    clearKeywordOpportunityDraft();
    persistCurrentBatchDraft();
  }
  if (!preservePanel) {
    keywordStrategyPanelVisible = false;
  }
}

function getKeywordOpportunityKeyword() {
  return String(keywordOpportunityResult?.keyword || "").trim();
}

function clearBenchmarkDiscoveryState({preservePanel = false} = {}) {
  keywordBenchmarkInFlight = false;
  keywordBenchmarkStartedAt = 0;
  keywordBenchmarkResult = null;
  keywordBenchmarkErrorMessage = "";
  keywordBenchmarkAnalysisStatus = "idle";
  keywordBenchmarkLoadingTitle = "";
  keywordBenchmarkLoadingMeta = "";
  if (!preservePanel) {
    keywordStrategyPanelVisible = false;
  }
}

function clearBenchmarkDiscoveryResult({showFeedback = true} = {}) {
  const hasAnything =
    !!keywordBenchmarkResult ||
    !!String(keywordBenchmarkErrorMessage || "").trim() ||
    keywordBenchmarkAnalysisStatus === "loading";
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
    !!keywordOpportunityResult ||
    !!String(keywordOpportunityErrorMessage || "").trim();
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
  if (keywordOpportunityResult) {
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
    expandedKeywordsBuffer = [];
    expandedKeywordsPanelVisible = false;
    invalidateKeywordInsightDraft();
  }

  updateExpandKeywordsButtonState();
  renderKeywordInsightState();
  persistCurrentBatchDraft();

  return {seedKeyword: nextKeyword, changed};
}

function getBatchKeywordsFromTextarea() {
  const textarea = document.getElementById("textareaBatchKeywords");
  return parseKeywordsFromMultilineInput(textarea?.value || "");
}

function updateBatchKeywordInputState() {
  const hintEl = document.getElementById("batchKeywordLimitHint");
  const btn = document.getElementById("btnRunBatchKeywords");
  const keywords = getBatchKeywordsFromTextarea();
  const overLimit = keywords.length > MAX_BATCH_KEYWORDS;

  if (hintEl) {
    hintEl.textContent = `${keywords.length} / ${MAX_BATCH_KEYWORDS}`;
    hintEl.classList.toggle("is-over", overLimit);
  }

  if (btn && !batchKeywordCaptureInFlight) {
    const shouldDisable = keywords.length === 0 || overLimit;
    btn.disabled = shouldDisable;
    btn.classList.toggle("is-disabled", shouldDisable);
  }
}

function openBatchModal(mode = "links") {
  const overlay = document.getElementById("batchModalOverlay");
  if (!overlay) return;

  syncBatchDraftForPlatform(getCurrentBatchDraftPlatform());

  // Set title
  const titleEl = document.getElementById("batchModalTitle");
  if (titleEl) titleEl.textContent = BATCH_MODE_META[mode]?.title ?? "批量采集";

  // Show only the relevant pane
  document.getElementById("batchPaneLinks").hidden = mode !== "links";
  document.getElementById("batchPaneBloggers").hidden = mode !== "bloggers";
  document.getElementById("batchPaneKeywords").hidden = mode !== "keywords";
  overlay
    .querySelector(".batch-modal-card")
    ?.classList.toggle("is-keyword-mode", mode === "keywords");

  overlay.classList.add("is-active");
  overlay.ariaHidden = "false";
}

function closeBatchModal() {
  const overlay = document.getElementById("batchModalOverlay");
  if (!overlay) return;

  persistCurrentBatchDraft();
  overlay.classList.remove("is-active");
  overlay.ariaHidden = "true";
}

async function writeTextToClipboard(text) {
  if (
    navigator?.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function handleCopyDiagnostics() {
  try {
    const text = await buildDiagnosticsText({
      trigger: "execution_details",
    });
    await writeTextToClipboard(text);
    void recordDiagnosticAction({
      featureKey: "diagnostics.copy",
      source: "execution_details",
      action: "copy_diagnostics",
      status: "completed",
    }).catch(() => null);
    showMessage("诊断信息已复制，可直接贴给协作者排查", "success");
  } catch (error) {
    console.error("[Sidebar] Copy diagnostics failed:", error);
    showMessage("复制诊断信息失败: " + error.message, "error");
  }
}

// ==================== 初始化 ====================

/**
 * 初始化侧边栏
 */
export async function initSidebar() {
  console.log("[Sidebar] Initializing...");

  // 初始化所有状态
  await initAllStates();

  let repairedDetailCapture = {count: 0, recordIds: []};
  try {
    repairedDetailCapture = await repairInterruptedDetailCaptureRecords();
    if (repairedDetailCapture.count > 0) {
      await refreshDataPool();
    }
  } catch (error) {
    console.warn(
      "[Sidebar] repairInterruptedDetailCaptureRecords failed:",
      error,
    );
  }

  // 订阅状态变化
  setupStateSubscriptions();

  // 绑定 UI 事件
  setupUIEventListeners();

  await showRiskNoticeIfNeeded();

  // 初始化采集偏好设置 UI
  await initCaptureSettingsUI();

  try {
    await loadBatchDraftStore();
  } catch (error) {
    console.warn("[Sidebar] Load batch drafts failed:", error);
    batchDraftByPlatform = {};
  }

  // 更新 UI
  updateUI();
  if (repairedDetailCapture.count > 0) {
    showMessage(
      `${repairedDetailCapture.count} 条采集增强任务因页面或插件中断已标记为失败，可点击 ↻ 重试`,
      "warning",
    );
  }
  checkExtensionUpdate({trigger: "auto"}).catch((error) => {
    console.warn("[Sidebar] Initial update check failed:", error);
  });

  updateExpandKeywordsButtonState();

  const runtime = getCurrentRuntime();
  lastRuntimePageTypeForKeywordSort = runtime?.pageType || PAGE_TYPE.UNKNOWN;
  lastRuntimePageUrlForKeywordSort = String(runtime?.lastPageUrl || "");
  syncKeywordSortDimensionByRuntime(runtime).catch((error) => {
    console.warn("[Sidebar] Initial keyword sort sync failed:", error);
  });

  const auth = getCurrentAuth() || {};
  if (auth.verified) {
    syncTargetConfigAfterVerify().catch((error) => {
      console.warn("[Sidebar] Initial target sync failed:", error);
    });
    loadMonitorSettings().catch((error) => {
      console.warn("[Sidebar] Initial monitor settings sync failed:", error);
    });
  }

  if (isMonitorAuthReady()) {
    Promise.all([loadMonitorSubscriptions()]).catch((error) => {
      console.warn("[Sidebar] Initial monitor refresh failed:", error);
    });
  } else {
    populateMonitorSettingsForm(DEFAULT_MONITOR_SETTINGS);
  }

  console.log("[Sidebar] Initialized");
}

// ==================== 状态订阅 ====================

/**
 * 设置状态订阅
 */
function setupStateSubscriptions() {
  // 订阅运行时状态变化
  subscribe("runtime", (runtime) => {
    console.log("[Sidebar] Runtime updated:", runtime);
    window.getSidebarRuntimeState = () => runtime;
    updatePlatformUI(runtime);
    updatePageTypeUI(runtime?.pageType || PAGE_TYPE.UNKNOWN);
    const currentPageType = runtime?.pageType || PAGE_TYPE.UNKNOWN;
    const currentPageUrl = String(runtime?.lastPageUrl || "");
    const shouldSyncKeywordSort =
      currentPageType !== lastRuntimePageTypeForKeywordSort ||
      currentPageUrl !== lastRuntimePageUrlForKeywordSort;
    lastRuntimePageTypeForKeywordSort = currentPageType;
    lastRuntimePageUrlForKeywordSort = currentPageUrl;
    if (shouldSyncKeywordSort) {
      syncKeywordSortDimensionByRuntime(runtime).catch((error) => {
        console.warn("[Sidebar] Failed to sync keyword sort dimension:", error);
      });
    }
    syncRuntimeCaptureProgress(runtime);
    syncRuntimeCommentProgress(runtime).catch((error) => {
      console.warn("[Sidebar] Failed to sync runtime comment progress:", error);
    });
  });

  // 订阅鉴权状态变化
  subscribe("auth", (auth) => {
    console.log("[Sidebar] Auth updated:", auth);
    window.getSidebarAuthState = () => auth;
    updateAuthUI(auth);
    updateDataPoolUI(getCurrentDataPool());
  });

  // 订阅目标配置变化
  subscribe("target", (target) => {
    console.log("[Sidebar] Target updated:", target);
    updateTargetUI(target);
  });

  // 订阅采集状态变化
  subscribe("capture", (capture) => {
    console.log("[Sidebar] Capture updated:", capture);
    updateCaptureUI(capture);
  });

  // 订阅同步状态变化
  subscribe("sync", (sync) => {
    console.log("[Sidebar] Sync updated:", sync);
    updateSyncUI(sync);
  });

  // 订阅数据池变化
  subscribe("dataPool", (dataPool) => {
    console.log(
      "[Sidebar] DataPool updated:",
      dataPool.records.length,
      "records",
    );
    updateDataPoolUI(dataPool);
  });

  subscribe("monitor", (monitor) => {
    console.log(
      "[Sidebar] Monitor updated:",
      Array.isArray(monitor?.items) ? monitor.items.length : 0,
      "subscriptions",
    );
    window.getSidebarMonitorState = () => monitor;
    updateDataPoolUI(getCurrentDataPool());
  });
}

function setupAuthCodeInputListeners() {
  updateAuthCodeVisibilityButton();

  const btnCodeVisibility = document.getElementById("btnCodeVisibility");
  if (btnCodeVisibility) {
    btnCodeVisibility.addEventListener("click", handleToggleCodeVisibility);
  }

  const inputCode = document.getElementById("inputCode");
  if (!inputCode) return;

  inputCode.addEventListener("input", () => {
    scheduleAuthCodeAutoEncrypt();
  });

  inputCode.addEventListener("blur", () => {
    scheduleAuthCodeAutoEncrypt({immediate: true});
  });
}

function handleToggleCodeVisibility() {
  authCodeViewMode =
    authCodeViewMode === AUTH_CODE_VIEW_MODE.ENCRYPTED
      ? AUTH_CODE_VIEW_MODE.PLAINTEXT
      : AUTH_CODE_VIEW_MODE.ENCRYPTED;
  updateAuthCodeVisibilityButton();
  void renderAuthCodeInput(getCurrentAuth());
}

function updateAuthCodeVisibilityButton() {
  const btn = document.getElementById("btnCodeVisibility");
  const input = document.getElementById("inputCode");
  const encryptedView = authCodeViewMode === AUTH_CODE_VIEW_MODE.ENCRYPTED;

  if (input) {
    input.type = encryptedView ? "password" : "text";
  }

  if (!btn) return;

  if (encryptedView) {
    btn.innerHTML = EYE_OFF_ICON;
    btn.setAttribute("aria-label", "显示明文");
    btn.setAttribute("title", "显示明文");
  } else {
    btn.innerHTML = EYE_ICON;
    btn.setAttribute("aria-label", "切换到密文");
    btn.setAttribute("title", "切换到密文");
  }
}

function getContactModalElements() {
  const overlay = document.getElementById("contactModal");
  const card = overlay?.querySelector(".contact-modal-card");
  const btnClose = document.getElementById("btnContactModalClose");

  if (!overlay || !card || !btnClose) {
    return null;
  }

  return {
    overlay,
    card,
    btnClose,
  };
}

function normalizeMemberGroupPromptCode(value) {
  return String(value || "").trim();
}

async function getMemberGroupPromptState() {
  try {
    const stored = await chrome.storage.local.get(
      MEMBER_GROUP_PROMPT_STATE_KEY,
    );
    const state = stored?.[MEMBER_GROUP_PROMPT_STATE_KEY];
    return state && typeof state === "object" ? state : {};
  } catch (error) {
    console.warn("[Sidebar] Failed to load member group prompt state:", error);
    return {};
  }
}

async function saveMemberGroupPromptState(state) {
  await chrome.storage.local.set({
    [MEMBER_GROUP_PROMPT_STATE_KEY]: state,
  });
}

async function hasAcknowledgedMemberGroupPrompt(auth = getCurrentAuth()) {
  const authCode = normalizeMemberGroupPromptCode(auth?.code);
  if (!authCode) {
    return false;
  }

  const state = await getMemberGroupPromptState();
  return normalizeMemberGroupPromptCode(state?.acknowledgedCode) === authCode;
}

async function updateMemberGroupEntryVisibility(auth = getCurrentAuth()) {
  const entry = document.getElementById("btnMemberGroupEntry");
  if (!entry) {
    return;
  }

  // The group QR prompt is no longer part of the activation success flow.
  // Keep this entry hidden so activation finishes as a clean success notice.
  entry.hidden = true;
}

function getMemberGroupModalElements() {
  const overlay = document.getElementById("memberGroupModal");
  const card = overlay?.querySelector(".member-group-modal-card");
  const checkbox = document.getElementById("checkboxMemberGroupAdded");
  const btnLater = document.getElementById("btnMemberGroupLater");
  const btnConfirm = document.getElementById("btnMemberGroupConfirm");

  if (!overlay || !card || !checkbox || !btnLater || !btnConfirm) {
    return null;
  }

  return {
    overlay,
    card,
    checkbox,
    btnLater,
    btnConfirm,
  };
}

function openMemberGroupModal() {
  const elements = getMemberGroupModalElements();
  if (!elements) {
    console.error("[Sidebar] Member group modal elements not found");
    return;
  }

  const {overlay, checkbox, btnConfirm} = elements;
  checkbox.checked = false;
  overlay.classList.add("is-active");
  overlay.setAttribute("aria-hidden", "false");
  btnConfirm.focus();
}

function closeMemberGroupModal() {
  const elements = getMemberGroupModalElements();
  if (!elements) {
    return;
  }

  const {overlay, checkbox} = elements;
  checkbox.checked = false;
  overlay.classList.remove("is-active");
  overlay.setAttribute("aria-hidden", "true");
}

async function handleConfirmMemberGroupAdded() {
  const elements = getMemberGroupModalElements();
  if (!elements) {
    return;
  }

  const {checkbox} = elements;
  if (!checkbox.checked) {
    showMessage("勾选“我已添加”后，这个提醒才会收起", "info");
    return;
  }

  const auth = getCurrentAuth() || {};
  const authCode = normalizeMemberGroupPromptCode(auth.code);
  if (!authCode) {
    closeMemberGroupModal();
    return;
  }

  await saveMemberGroupPromptState({
    acknowledgedCode: authCode,
    acknowledgedAt: new Date().toISOString(),
  });
  closeMemberGroupModal();
  await updateMemberGroupEntryVisibility(auth);
  showMessage("已收起交流群提醒入口", "success");
}

async function maybeOpenMemberGroupModalAfterVerify(auth = getCurrentAuth()) {
  if (!isAuthVerified(auth)) {
    return;
  }

  const authCode = normalizeMemberGroupPromptCode(auth?.code);
  if (authCode && !(await hasAcknowledgedMemberGroupPrompt(auth))) {
    await saveMemberGroupPromptState({
      acknowledgedCode: authCode,
      acknowledgedAt: new Date().toISOString(),
      suppressed: true,
    });
  }

  await updateMemberGroupEntryVisibility(auth);
  closeMemberGroupModal();
}

function setupMemberGroupModalListeners() {
  if (memberGroupModalListenersBound) {
    return;
  }

  const entry = document.getElementById("btnMemberGroupEntry");
  if (entry) {
    entry.addEventListener("click", () => {
      openMemberGroupModal();
    });
  }

  const elements = getMemberGroupModalElements();
  if (!elements) {
    return;
  }

  const {overlay, btnLater, btnConfirm} = elements;
  btnLater.addEventListener("click", () => {
    closeMemberGroupModal();
  });
  btnConfirm.addEventListener("click", () => {
    void handleConfirmMemberGroupAdded();
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeMemberGroupModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !overlay.classList.contains("is-active")) {
      return;
    }
    event.preventDefault();
    closeMemberGroupModal();
  });

  memberGroupModalListenersBound = true;
}

function openContactModal() {
  const elements = getContactModalElements();
  if (!elements) {
    console.error("[Sidebar] Contact modal elements not found");
    showMessage("无法打开联系我们窗口，请刷新后重试", "error");
    return;
  }

  const {overlay, btnClose} = elements;
  overlay.classList.add("is-active");
  overlay.setAttribute("aria-hidden", "false");
  btnClose.focus();
}

function closeContactModal() {
  const elements = getContactModalElements();
  if (!elements) {
    return;
  }

  const {overlay} = elements;
  overlay.classList.remove("is-active");
  overlay.setAttribute("aria-hidden", "true");
}

function setupContactModalListeners() {
  if (contactModalListenersBound) {
    return;
  }

  const elements = getContactModalElements();
  if (!elements) {
    return;
  }

  const {overlay, btnClose} = elements;

  btnClose.addEventListener("click", () => {
    closeContactModal();
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeContactModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !overlay.classList.contains("is-active")) {
      return;
    }
    event.preventDefault();
    closeContactModal();
  });

  contactModalListenersBound = true;
}

function getRiskModalElements() {
  const overlay = document.getElementById("riskNoticeModal");
  const card = overlay?.querySelector(".risk-modal-card");
  const btnClose = document.getElementById("btnRiskModalClose");

  if (!overlay || !card || !btnClose) {
    return null;
  }

  return {
    overlay,
    card,
    btnClose,
  };
}

function openRiskModal() {
  const elements = getRiskModalElements();
  if (!elements) {
    console.error("[Sidebar] Risk modal elements not found");
    showMessage("无法打开风险提示，请刷新后重试", "error");
    return;
  }

  const {overlay, btnClose} = elements;
  overlay.classList.add("is-active");
  overlay.setAttribute("aria-hidden", "false");
  btnClose.focus();
}

function closeRiskModal() {
  const elements = getRiskModalElements();
  if (!elements) {
    return;
  }

  const {overlay, btnClose} = elements;
  overlay.classList.remove("is-active");
  overlay.setAttribute("aria-hidden", "true");

  if (riskNoticeForceOpen) {
    riskNoticeForceOpen = false;
    markRiskNoticeAcknowledged();
    const checkboxLabel = document.getElementById("riskNoticeCheckboxLabel");
    if (checkboxLabel) checkboxLabel.hidden = true;
  }
  btnClose.textContent = "关闭";
  btnClose.disabled = false;
}

function setupRiskModalListeners() {
  if (riskModalListenersBound) {
    return;
  }

  const elements = getRiskModalElements();
  if (!elements) {
    return;
  }

  const {overlay, btnClose} = elements;

  btnClose.addEventListener("click", () => {
    closeRiskModal();
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !riskNoticeForceOpen) {
      closeRiskModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !overlay.classList.contains("is-active")) {
      return;
    }
    if (riskNoticeForceOpen) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closeRiskModal();
  });

  riskModalListenersBound = true;
}

async function hasAcknowledgedRiskNotice() {
  try {
    const stored = await chrome.storage.local.get(RISK_NOTICE_ACKNOWLEDGED_KEY);
    return Boolean(stored?.[RISK_NOTICE_ACKNOWLEDGED_KEY]);
  } catch (error) {
    console.warn("[Sidebar] Failed to read risk notice state:", error);
    return false;
  }
}

async function markRiskNoticeAcknowledged() {
  try {
    await chrome.storage.local.set({[RISK_NOTICE_ACKNOWLEDGED_KEY]: true});
  } catch (error) {
    console.warn("[Sidebar] Failed to save risk notice state:", error);
  }
}

let riskNoticeForceOpen = false;

async function showRiskNoticeIfNeeded() {
  const acknowledged = await hasAcknowledgedRiskNotice();
  if (acknowledged) {
    return;
  }

  const elements = getRiskModalElements();
  if (!elements) {
    return;
  }

  const {btnClose} = elements;
  const checkboxLabel = document.getElementById("riskNoticeCheckboxLabel");
  const checkbox = document.getElementById("riskNoticeCheckbox");

  btnClose.textContent = "我已知晓";
  btnClose.disabled = true;
  if (checkboxLabel) checkboxLabel.hidden = false;
  if (checkbox) {
    checkbox.checked = false;
    checkbox.addEventListener("change", () => {
      btnClose.disabled = !checkbox.checked;
    });
  }
  riskNoticeForceOpen = true;

  openRiskModal();
}

function parseVersionString(version) {
  return String(version || "")
    .trim()
    .split(".")
    .map((segment) => Number.parseInt(segment, 10))
    .map((value) => (Number.isFinite(value) && value >= 0 ? value : 0));
}

function compareVersion(left, right) {
  const leftParts = parseVersionString(left);
  const rightParts = parseVersionString(right);
  const maxLength = Math.max(leftParts.length, rightParts.length, 3);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  return 0;
}

function getLocalExtensionVersion() {
  return String(chrome.runtime.getManifest()?.version || "").trim();
}

async function getExtensionInstallType() {
  try {
    if (!chrome.management?.getSelf) {
      return EXTENSION_INSTALL_TYPE.OTHER;
    }

    const info = await chrome.management.getSelf();
    const installType = String(info?.installType || "")
      .trim()
      .toLowerCase();
    if (
      installType === EXTENSION_INSTALL_TYPE.NORMAL ||
      installType === EXTENSION_INSTALL_TYPE.DEVELOPMENT ||
      installType === EXTENSION_INSTALL_TYPE.SIDELOAD ||
      installType === EXTENSION_INSTALL_TYPE.ADMIN
    ) {
      return installType;
    }
  } catch (error) {
    console.warn("[Sidebar] Failed to read install type:", error);
  }

  return EXTENSION_INSTALL_TYPE.OTHER;
}

async function readUpdateModalState() {
  try {
    const stored = await chrome.storage.local.get(
      EXTENSION_UPDATE_MODAL_STATE_KEY,
    );
    const value = stored?.[EXTENSION_UPDATE_MODAL_STATE_KEY];
    if (!value || typeof value !== "object") {
      return {
        dismissedVersion: "",
        skipExtensionUpdateGuide: false,
      };
    }
    return {
      dismissedVersion: String(value.dismissedVersion || "").trim(),
      skipExtensionUpdateGuide: Boolean(value.skipExtensionUpdateGuide),
    };
  } catch (error) {
    console.warn("[Sidebar] Failed to read update modal state:", error);
    return {
      dismissedVersion: "",
      skipExtensionUpdateGuide: false,
    };
  }
}

async function writeUpdateModalState(nextState = {}) {
  try {
    const currentState = await readUpdateModalState();
    const mergedState = {
      ...currentState,
      ...nextState,
    };
    await chrome.storage.local.set({
      [EXTENSION_UPDATE_MODAL_STATE_KEY]: {
        dismissedVersion: String(mergedState.dismissedVersion || "").trim(),
        skipExtensionUpdateGuide: Boolean(mergedState.skipExtensionUpdateGuide),
      },
    });
  } catch (error) {
    console.warn("[Sidebar] Failed to save update modal state:", error);
  }
}

function normalizeUpdateManifestResult(result) {
  const rawManifest =
    result?.data?.updateManifest &&
    typeof result.data.updateManifest === "object"
      ? result.data.updateManifest
      : {};

  const latestVersion = String(rawManifest.latestVersion || "").trim();
  const minSupportedVersion = String(
    rawManifest.minSupportedVersion || "",
  ).trim();
  const downloadUrl =
    String(rawManifest.downloadUrl || "").trim() || DEFAULT_UPDATE_DOWNLOAD_URL;
  const changelogUrl =
    String(rawManifest.changelogUrl || "").trim() ||
    DEFAULT_UPDATE_CHANGELOG_URL;
  const releases = normalizeReleaseEntries(rawManifest);
  const latestRelease =
    releases.find((release) => release.version === latestVersion) ||
    releases[0] ||
    null;
  const releaseDate = String(latestRelease?.releaseDate || "").trim();

  return {
    latestVersion,
    minSupportedVersion,
    downloadUrl,
    changelogUrl,
    releaseDate,
    releases,
  };
}

function normalizeReleaseNoteTag(tag) {
  const normalized = String(tag || "").trim();
  if (normalized === "新增") return "新增";
  if (normalized === "修复") return "修复";
  if (normalized === "优化") return "优化";
  return "其他";
}

function getReleaseGroupTagClass(tag) {
  const normalized = normalizeReleaseNoteTag(tag);
  if (normalized === "新增") return "update-group-tag is-add";
  if (normalized === "优化") return "update-group-tag is-opt";
  if (normalized === "修复") return "update-group-tag is-fix";
  return "update-group-tag";
}

function normalizeReleaseNoteGroups(rawReleaseNotes) {
  if (!Array.isArray(rawReleaseNotes)) {
    return [];
  }

  const hasGroupedShape = rawReleaseNotes.some((item) => {
    if (!item || typeof item !== "object") return false;
    return Array.isArray(item.notes) || Array.isArray(item.items);
  });

  if (hasGroupedShape) {
    return rawReleaseNotes
      .map((group) => {
        if (!group || typeof group !== "object") return null;
        const tag = normalizeReleaseNoteTag(group.tag || "优化");
        const rawNotes = Array.isArray(group.notes)
          ? group.notes
          : Array.isArray(group.items)
            ? group.items
            : [];
        const notes = rawNotes
          .map((note) => {
            const title = String(note?.title || "").trim();
            const desc = String(note?.desc || "").trim();
            if (!title || !desc) return null;
            return {title, desc};
          })
          .filter(Boolean);
        if (notes.length === 0) return null;
        return {tag, notes};
      })
      .filter(Boolean);
  }

  const buckets = new Map();
  rawReleaseNotes.forEach((note) => {
    const title = String(note?.title || "").trim();
    const desc = String(note?.desc || "").trim();
    if (!title || !desc) return;
    const tag = normalizeReleaseNoteTag(note?.tag || "优化");
    if (!buckets.has(tag)) buckets.set(tag, []);
    buckets.get(tag).push({title, desc});
  });

  return Array.from(buckets.entries()).map(([tag, notes]) => ({tag, notes}));
}

function normalizeReleaseEntries(rawManifest) {
  const rawReleases = Array.isArray(rawManifest?.releases)
    ? rawManifest.releases
    : [];

  const normalizedFromReleases = rawReleases
    .map((release) => {
      if (!release || typeof release !== "object") return null;
      const version = String(release.version || "").trim();
      const releaseDate = String(release.releaseDate || "").trim();
      const releaseNotes = normalizeReleaseNoteGroups(release.releaseNotes);
      if (!version || !releaseDate || releaseNotes.length === 0) {
        return null;
      }
      return {
        version,
        releaseDate,
        releaseNotes,
      };
    })
    .filter(Boolean);

  if (normalizedFromReleases.length > 0) {
    return normalizedFromReleases;
  }

  // Backward compatibility with single-release format
  const legacyVersion = String(rawManifest?.latestVersion || "").trim();
  const legacyReleaseDate = String(rawManifest?.releaseDate || "").trim();
  const legacyReleaseNotes = normalizeReleaseNoteGroups(
    rawManifest?.releaseNotes,
  );
  if (!legacyVersion || !legacyReleaseDate || legacyReleaseNotes.length === 0) {
    return [];
  }
  return [
    {
      version: legacyVersion,
      releaseDate: legacyReleaseDate,
      releaseNotes: legacyReleaseNotes,
    },
  ];
}

function getUpdateModalElements() {
  const overlay = document.getElementById("updateNoticeModal");
  const subtitle = document.getElementById("updateNoticeSubtitle");
  const currentVersion = document.getElementById("updateNoticeCurrentVersion");
  const latestVersion = document.getElementById("updateNoticeLatestVersion");
  const summary = document.getElementById("updateNoticeSummary");
  const releaseNotes = document.getElementById("updateNoticeReleaseNotes");
  const changelogLink = document.getElementById("updateNoticeChangelog");
  const btnClose = document.getElementById("btnUpdateNoticeClose");
  const btnAction = document.getElementById("btnUpdateNoticeAction");

  if (
    !overlay ||
    !subtitle ||
    !currentVersion ||
    !latestVersion ||
    !summary ||
    !releaseNotes ||
    !changelogLink ||
    !btnClose ||
    !btnAction
  ) {
    return null;
  }

  return {
    overlay,
    subtitle,
    currentVersion,
    latestVersion,
    summary,
    releaseNotes,
    changelogLink,
    btnClose,
    btnAction,
  };
}

function renderUpdateNoticeReleaseNotes(releaseNotes = []) {
  if (!Array.isArray(releaseNotes) || releaseNotes.length === 0) {
    return `<div class="update-notice-release-item"><p class="update-notice-release-title">版本说明</p><p class="update-notice-release-desc">本次主要包含稳定性优化和体验改进。</p></div>`;
  }

  const groupOrder = ["新增", "优化", "修复"];
  const withOrder = [...releaseNotes].sort((left, right) => {
    const leftTag = normalizeReleaseNoteTag(left?.tag || "其他");
    const rightTag = normalizeReleaseNoteTag(right?.tag || "其他");
    const leftIndex = groupOrder.indexOf(leftTag);
    const rightIndex = groupOrder.indexOf(rightTag);
    const normalizedLeftIndex = leftIndex === -1 ? 999 : leftIndex;
    const normalizedRightIndex = rightIndex === -1 ? 999 : rightIndex;
    return normalizedLeftIndex - normalizedRightIndex;
  });

  return withOrder
    .map((group) => {
      const groupTag = escapeHtml(
        normalizeReleaseNoteTag(group?.tag || "其他"),
      );
      const notes = Array.isArray(group?.notes) ? group.notes : [];
      if (notes.length === 0) {
        return "";
      }
      const items = notes
        .map((note) => {
          const title = escapeHtml(note?.title || "版本说明");
          const desc = escapeHtml(note?.desc || "");
          return `<div class="update-notice-release-item"><p class="update-notice-release-title">${title}</p><p class="update-notice-release-desc">${desc}</p></div>`;
        })
        .join("");
      const groupTagClass = getReleaseGroupTagClass(groupTag);
      return `<div class="update-notice-release-group"><p class="update-notice-release-group-title"><span class="${groupTagClass}">${groupTag}</span></p>${items}</div>`;
    })
    .filter(Boolean)
    .join("");
}

function renderVersionReleaseEntries(releases = []) {
  if (!Array.isArray(releases) || releases.length === 0) {
    return `<div class="update-notice-release-item"><p class="update-notice-release-title">版本说明</p><p class="update-notice-release-desc">本次主要包含稳定性优化和体验改进。</p></div>`;
  }

  return releases
    .map((release) => {
      const version = escapeHtml(String(release?.version || "-"));
      const releaseDate = escapeHtml(String(release?.releaseDate || ""));
      const notes = renderUpdateNoticeReleaseNotes(release?.releaseNotes || []);
      return `<div class="update-release-version-block"><p class="update-release-version-heading">v${version}${releaseDate ? ` · ${releaseDate}` : ""}</p>${notes}</div>`;
    })
    .join("");
}

function resolveUpdateActionConfig({installType, isLatest}) {
  const normalizedInstallType = String(installType || "")
    .trim()
    .toLowerCase();
  const devLike =
    normalizedInstallType === EXTENSION_INSTALL_TYPE.DEVELOPMENT ||
    normalizedInstallType === EXTENSION_INSTALL_TYPE.SIDELOAD;

  if (devLike) {
    return {
      label: "立即更新",
      mode: UPDATE_ACTION_MODE.OPEN_DOWNLOAD_PAGE,
    };
  }

  if (isLatest) {
    return {
      label: "立即使用",
      mode: UPDATE_ACTION_MODE.USE_NOW,
    };
  }

  return {
    label: "去扩展页检查更新",
    mode: UPDATE_ACTION_MODE.OPEN_EXTENSION_MANAGER,
  };
}

function openUpdateNoticeModal() {
  const elements = getUpdateModalElements();
  if (!elements) return;
  elements.overlay.classList.add("is-active");
  elements.overlay.setAttribute("aria-hidden", "false");
}

function closeUpdateNoticeModal() {
  const elements = getUpdateModalElements();
  if (!elements) return;
  elements.overlay.classList.remove("is-active");
  elements.overlay.setAttribute("aria-hidden", "true");
}

function getUpdateGuideModalElements() {
  const overlay = document.getElementById("updateGuideModal");
  const checkboxSkip = document.getElementById("checkboxUpdateGuideSkip");
  const btnCancel = document.getElementById("btnUpdateGuideCancel");
  const btnConfirm = document.getElementById("btnUpdateGuideConfirm");

  if (!overlay || !checkboxSkip || !btnCancel || !btnConfirm) {
    return null;
  }

  return {
    overlay,
    checkboxSkip,
    btnCancel,
    btnConfirm,
  };
}

function openUpdateGuideModal() {
  const elements = getUpdateGuideModalElements();
  if (!elements) return;
  elements.checkboxSkip.checked = false;
  elements.overlay.classList.add("is-active");
  elements.overlay.setAttribute("aria-hidden", "false");
}

function closeUpdateGuideModal() {
  const elements = getUpdateGuideModalElements();
  if (!elements) return;
  elements.overlay.classList.remove("is-active");
  elements.overlay.setAttribute("aria-hidden", "true");
}

async function openExtensionManagerWithFallback() {
  try {
    await chrome.tabs.create({url: EXTENSION_MANAGEMENT_URL});
    return true;
  } catch (error) {
    console.warn("[Sidebar] Failed to open extension manager:", error);
    showMessage("请手动打开 chrome://extensions 并点击“更新”", "warning");
    return false;
  }
}

async function handleUpdateGuideConfirmClick() {
  const elements = getUpdateGuideModalElements();
  const skipNextTime = Boolean(elements?.checkboxSkip?.checked);
  if (skipNextTime) {
    await writeUpdateModalState({skipExtensionUpdateGuide: true});
  }

  if (currentUpdateNoticeState?.latestVersion) {
    await writeUpdateModalState({
      dismissedVersion: currentUpdateNoticeState.latestVersion,
    });
  }

  const opened = await openExtensionManagerWithFallback();
  if (!opened) {
    return;
  }

  closeUpdateGuideModal();
  closeUpdateNoticeModal();
}

function handleUpdateGuideCancelClick() {
  closeUpdateGuideModal();
  openUpdateNoticeModal();
}

function setupUpdateGuideModalListeners() {
  if (updateGuideModalListenersBound) {
    return;
  }

  const elements = getUpdateGuideModalElements();
  if (!elements) {
    return;
  }

  elements.btnConfirm.addEventListener("click", () => {
    void handleUpdateGuideConfirmClick();
  });
  elements.btnCancel.addEventListener("click", () => {
    handleUpdateGuideCancelClick();
  });
  elements.overlay.addEventListener("click", (event) => {
    if (event.target === elements.overlay) {
      handleUpdateGuideCancelClick();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      !elements.overlay.classList.contains("is-active")
    ) {
      return;
    }
    event.preventDefault();
    handleUpdateGuideCancelClick();
  });

  updateGuideModalListenersBound = true;
}

function renderUpdateNoticeModal(state) {
  const elements = getUpdateModalElements();
  if (!elements) return;

  const {
    localVersion,
    latestVersion,
    minSupportedVersion,
    releaseDate,
    releases,
    changelogUrl,
    installType,
    isLatest,
    isForceUpdate,
    actionConfig,
  } = state;

  elements.currentVersion.textContent = `v${localVersion || "-"}`;
  elements.latestVersion.textContent = `v${latestVersion || "-"}`;

  const releaseDateText = releaseDate ? `（${releaseDate}）` : "";
  if (isLatest) {
    elements.subtitle.textContent = `当前已是最新版本${releaseDateText}`;
    elements.summary.textContent = "版本状态正常，可立即继续使用。";
    elements.btnClose.textContent = "关闭";
  } else if (isForceUpdate) {
    elements.subtitle.textContent = `检测到关键更新${releaseDateText}`;
    elements.summary.textContent =
      minSupportedVersion &&
      compareVersion(localVersion, minSupportedVersion) < 0
        ? `当前版本过低（最低支持 v${minSupportedVersion}），请立即升级后继续使用。`
        : "当前版本已落后，建议立即升级。";
    elements.btnClose.textContent = "稍后";
  } else {
    elements.subtitle.textContent = `发现新版本${releaseDateText}`;
    elements.summary.textContent = "可升级到最新版本，获取新功能和稳定性优化。";
    elements.btnClose.textContent = "稍后";
  }

  elements.releaseNotes.innerHTML = renderVersionReleaseEntries(releases);
  elements.changelogLink.setAttribute(
    "href",
    changelogUrl || DEFAULT_UPDATE_CHANGELOG_URL,
  );
  elements.changelogLink.style.display = "inline-flex";

  elements.btnAction.textContent = actionConfig.label;
  elements.btnAction.dataset.actionMode = actionConfig.mode;
  elements.btnAction.dataset.installType = installType;
}

async function handleUpdateNoticeActionClick() {
  if (!currentUpdateNoticeState) {
    closeUpdateNoticeModal();
    return;
  }

  const {actionConfig, latestVersion, downloadUrl} = currentUpdateNoticeState;
  const actionMode = actionConfig?.mode;

  if (actionMode === UPDATE_ACTION_MODE.OPEN_EXTENSION_MANAGER) {
    if (!currentUpdateNoticeState?.skipExtensionUpdateGuide) {
      closeUpdateNoticeModal();
      openUpdateGuideModal();
      return;
    }

    const opened = await openExtensionManagerWithFallback();
    if (!opened) {
      return;
    }
    await writeUpdateModalState({dismissedVersion: latestVersion});
    closeUpdateNoticeModal();
    return;
  }

  if (actionMode === UPDATE_ACTION_MODE.OPEN_DOWNLOAD_PAGE) {
    try {
      await chrome.tabs.create({
        url: downloadUrl || DEFAULT_UPDATE_DOWNLOAD_URL,
      });
      await writeUpdateModalState({dismissedVersion: latestVersion});
      closeUpdateNoticeModal();
      return;
    } catch (error) {
      console.warn("[Sidebar] Failed to open download page:", error);
      showMessage("打开下载页失败，请稍后重试", "error");
      return;
    }
  }

  closeUpdateNoticeModal();
}

async function handleUpdateNoticeCloseClick() {
  if (currentUpdateNoticeState && !currentUpdateNoticeState.isLatest) {
    await writeUpdateModalState({
      dismissedVersion: currentUpdateNoticeState.latestVersion,
    });
  }
  closeUpdateNoticeModal();
}

function setupUpdateModalListeners() {
  if (updateModalListenersBound) {
    return;
  }

  const elements = getUpdateModalElements();
  if (!elements) {
    return;
  }

  elements.btnAction.addEventListener("click", () => {
    void handleUpdateNoticeActionClick();
  });
  elements.btnClose.addEventListener("click", () => {
    void handleUpdateNoticeCloseClick();
  });
  elements.overlay.addEventListener("click", (event) => {
    if (event.target === elements.overlay) {
      void handleUpdateNoticeCloseClick();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      !elements.overlay.classList.contains("is-active")
    ) {
      return;
    }
    event.preventDefault();
    void handleUpdateNoticeCloseClick();
  });

  updateModalListenersBound = true;
}

async function checkExtensionUpdate({
  trigger = "auto",
  openModalWhenLatest = false,
} = {}) {
  const localVersion = getLocalExtensionVersion();
  const [manifestResult, installType, modalState] = await Promise.all([
    getUpdateManifest(),
    getExtensionInstallType(),
    readUpdateModalState(),
  ]);

  if (!manifestResult?.ok) {
    if (trigger !== "auto") {
      showMessage(
        manifestResult?.message || "检查更新失败，请稍后重试",
        "error",
      );
    }
    return null;
  }

  const normalized = normalizeUpdateManifestResult(manifestResult);
  if (!normalized.latestVersion) {
    if (trigger !== "auto") {
      showMessage("更新配置缺少 latestVersion", "error");
    }
    return null;
  }

  const compareToLatest = compareVersion(
    localVersion,
    normalized.latestVersion,
  );
  const isLatest = compareToLatest >= 0;
  const isOutdated = compareToLatest < 0;
  const isForceUpdate =
    normalized.minSupportedVersion &&
    compareVersion(localVersion, normalized.minSupportedVersion) < 0;

  const actionConfig = resolveUpdateActionConfig({
    installType,
    isLatest,
  });

  const nextState = {
    localVersion,
    latestVersion: normalized.latestVersion,
    minSupportedVersion: normalized.minSupportedVersion,
    downloadUrl: normalized.downloadUrl,
    changelogUrl: normalized.changelogUrl,
    releaseDate: normalized.releaseDate,
    releases: normalized.releases,
    installType,
    isLatest,
    isOutdated,
    isForceUpdate,
    actionConfig,
    dismissedVersion: modalState.dismissedVersion,
    skipExtensionUpdateGuide: modalState.skipExtensionUpdateGuide,
  };

  const dismissedSameVersion =
    nextState.dismissedVersion &&
    nextState.dismissedVersion === nextState.latestVersion;
  const shouldShowAutomatically = isOutdated && !dismissedSameVersion;

  const releasesInRange = (normalized.releases || []).filter((release) => {
    const releaseVersion = String(release?.version || "").trim();
    if (!releaseVersion) return false;
    return (
      compareVersion(releaseVersion, localVersion) > 0 &&
      compareVersion(releaseVersion, normalized.latestVersion) <= 0
    );
  });
  releasesInRange.sort((left, right) =>
    compareVersion(String(right?.version || ""), String(left?.version || "")),
  );
  nextState.releases =
    releasesInRange.length > 0
      ? releasesInRange
      : (normalized.releases || []).slice(0, 1);
  const shouldOpenModal =
    trigger !== "auto"
      ? isOutdated || openModalWhenLatest
      : shouldShowAutomatically;

  if (!shouldOpenModal) {
    if (trigger !== "auto") {
      showMessage("当前已是最新版本", "success");
    }
    return nextState;
  }

  currentUpdateNoticeState = nextState;
  renderUpdateNoticeModal(nextState);
  openUpdateNoticeModal();
  return nextState;
}

function scheduleAuthCodeAutoEncrypt({immediate = false} = {}) {
  if (authCodeEncryptTimer) {
    clearTimeout(authCodeEncryptTimer);
    authCodeEncryptTimer = null;
  }

  if (immediate) {
    void persistAuthCodeFromInput();
    return;
  }

  authCodeEncryptTimer = setTimeout(() => {
    authCodeEncryptTimer = null;
    void persistAuthCodeFromInput();
  }, AUTH_CODE_AUTO_ENCRYPT_DELAY);
}

async function persistAuthCodeFromInput() {
  const inputCode = document.getElementById("inputCode");
  if (!inputCode) return;

  const rawCode = normalizeAuthCodeInput(inputCode.value);
  const currentAuth = getCurrentAuth() || {};
  const previousCode = normalizeAuthCodeInput(currentAuth.code);
  let previousPlainCode = "";

  if (previousCode) {
    try {
      previousPlainCode = normalizeAuthCodeInput(
        await ensurePlainAuthCode(previousCode),
      );
    } catch (error) {
      console.warn("[Sidebar] Failed to decode previous auth code:", error);
      previousPlainCode = previousCode;
    }
  }

  if (!rawCode) {
    if (previousPlainCode) {
      await setCurrentAuth({
        code: "",
        verified: false,
        status: AUTH_STATUS.IDLE,
        reason: "none",
        message: "",
        user: null,
        credentialCredit: null,
        credential: null,
        binding: null,
      });
      await resetCurrentMonitor();
    } else if (inputCode.value) {
      inputCode.value = "";
    }
    return;
  }

  let encryptedCode = "";
  try {
    encryptedCode = await ensureEncryptedAuthCode(rawCode);
  } catch (error) {
    console.error("[Sidebar] Failed to encrypt auth code:", error);
    window.showMessage?.("激活码加密失败，请重试", "error");
    return;
  }

  const codeChanged = rawCode !== previousPlainCode;
  if (!codeChanged && isEncryptedAuthCode(previousCode)) {
    return;
  }

  const updates = {code: encryptedCode};

  if (codeChanged) {
    Object.assign(updates, {
      verified: false,
      status: AUTH_STATUS.IDLE,
      reason: "none",
      message: "",
      user: null,
      credentialCredit: null,
      credential: null,
      binding: null,
    });
  }

  await setCurrentAuth(updates);
  if (codeChanged) {
    await resetCurrentMonitor();
  }
}

async function renderAuthCodeInput(auth = getCurrentAuth()) {
  const inputCode = document.getElementById("inputCode");
  if (!inputCode) return;

  const currentToken = ++authCodeRenderToken;
  const rawCode = normalizeAuthCodeInput(auth?.code);
  if (!rawCode) {
    if (inputCode.value) inputCode.value = "";
    return;
  }

  let encryptedCode = rawCode;
  let plainCode = rawCode;

  if (!isEncryptedAuthCode(rawCode)) {
    try {
      encryptedCode = await ensureEncryptedAuthCode(rawCode);
    } catch (error) {
      console.error(
        "[Sidebar] Failed to migrate auth code to encrypted value:",
        error,
      );
      encryptedCode = rawCode;
    }
  } else {
    try {
      plainCode = await ensurePlainAuthCode(rawCode);
    } catch (error) {
      console.error("[Sidebar] Failed to decode auth code:", error);
      plainCode = "";
    }
  }

  if (currentToken !== authCodeRenderToken) return;

  if (encryptedCode !== rawCode) {
    await setCurrentAuth({code: encryptedCode});
    if (currentToken !== authCodeRenderToken) return;
  }

  if (inputCode.value !== plainCode) {
    inputCode.value = plainCode;
  }
}

// ==================== UI 事件监听 ====================

/**
 * 设置 UI 事件监听
 */
function setupUIEventListeners() {
  const btnCaptureNote = document.getElementById("btnCaptureNote");
  if (btnCaptureNote) {
    btnCaptureNote.addEventListener("click", handleCaptureNoteData);
  }

  const checkboxCaptureComments = document.getElementById(
    "checkboxCaptureComments",
  );
  if (checkboxCaptureComments) {
    checkboxCaptureComments.addEventListener(
      "change",
      handleCaptureCommentsToggleChange,
    );
  }
  const checkboxCaptureBloggerMetrics = document.getElementById(
    "checkboxCaptureBloggerMetrics",
  );
  if (checkboxCaptureBloggerMetrics) {
    checkboxCaptureBloggerMetrics.addEventListener(
      "change",
      handleCaptureBloggerMetricsToggleChange,
    );
  }
  const checkboxEnableCommentLeadsFilter = document.getElementById(
    "checkboxEnableCommentLeadsFilter",
  );
  if (checkboxEnableCommentLeadsFilter) {
    checkboxEnableCommentLeadsFilter.addEventListener(
      "change",
      handleCommentLeadsFilterToggleChange,
    );
  }

  const commentsToggleWrap = document.querySelector(
    'label[for="checkboxCaptureComments"]',
  );
  if (commentsToggleWrap) {
    commentsToggleWrap.addEventListener(
      "click",
      handleCaptureCommentsToggleGuardClick,
    );
  }
  const bloggerMetricsToggleWrap = document.querySelector(
    'label[for="checkboxCaptureBloggerMetrics"]',
  );
  if (bloggerMetricsToggleWrap) {
    bloggerMetricsToggleWrap.addEventListener(
      "click",
      handleCaptureBloggerMetricsToggleGuardClick,
    );
  }
  document.querySelectorAll('[data-detail-setting="auto"]').forEach((input) => {
    input.addEventListener("change", handleAutoDetailCaptureToggleChange);
  });
  document
    .querySelectorAll('[data-detail-setting="comments"]')
    .forEach((input) => {
      input.addEventListener("change", handleDetailCaptureCommentsToggleChange);
    });
  document
    .querySelectorAll('[data-detail-setting="metrics"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureBloggerMetricsToggleChange,
      );
    });
  document
    .querySelectorAll('[data-detail-setting="skip-captured"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureSkipCapturedToggleChange,
      );
    });
  document
    .querySelectorAll('[data-detail-setting="comment-leads"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureCommentLeadsToggleChange,
      );
    });
  document
    .querySelectorAll('[data-detail-setting="comments-max-detected-items"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureCommentsMaxDetectedItemsChange,
      );
      input.addEventListener(
        "blur",
        handleDetailCaptureCommentsMaxDetectedItemsChange,
      );
    });
  document
    .querySelectorAll('[data-detail-setting="low-follower-hit"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureLowFollowerHitToggleChange,
      );
    });
  document
    .querySelectorAll('[data-detail-setting="low-follower-hit-threshold"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureLowFollowerHitThresholdChange,
      );
      input.addEventListener(
        "blur",
        handleDetailCaptureLowFollowerHitThresholdChange,
      );
    });

  const btnCaptureBlogger = document.getElementById("btnCaptureBlogger");
  if (btnCaptureBlogger) {
    btnCaptureBlogger.addEventListener("click", handleCaptureBloggerData);
  }

  const btnCaptureSearch = document.getElementById("btnCaptureSearch");
  if (btnCaptureSearch) {
    btnCaptureSearch.addEventListener("click", handleCaptureSearchData);
  }
  document
    .getElementById("btnToggleKeywordStrategy")
    ?.addEventListener("click", () => toggleKeywordStrategyPanel());
  document
    .getElementById("btnKeywordStrategyTabBenchmark")
    ?.addEventListener("click", () => setKeywordStrategyTab("benchmark"));
  document
    .getElementById("btnKeywordStrategyTabOpportunity")
    ?.addEventListener("click", () => setKeywordStrategyTab("opportunity"));
  document
    .getElementById("btnKeywordStrategyTabLongtail")
    ?.addEventListener("click", () => setKeywordStrategyTab("longtail"));
  document
    .getElementById("btnRunKeywordOpportunity")
    ?.addEventListener("click", () => void handleRunKeywordOpportunity());
  document
    .getElementById("btnCancelKeywordOpportunity")
    ?.addEventListener("click", () => void handleCancelKeywordOpportunity());
  document
    .getElementById("btnClearKeywordOpportunityResult")
    ?.addEventListener("click", () => clearKeywordOpportunityResult());
  document
    .getElementById("keywordOpportunityResult")
    ?.addEventListener("click", handleKeywordOpportunityResultActions);
  document
    .getElementById("btnRunBenchmarkDiscovery")
    ?.addEventListener("click", () => void handleRunBenchmarkDiscovery());
  document
    .getElementById("btnCancelBenchmarkDiscovery")
    ?.addEventListener("click", () => void handleCancelBenchmarkDiscovery());
  document
    .getElementById("btnClearBenchmarkDiscoveryResult")
    ?.addEventListener("click", () => clearBenchmarkDiscoveryResult());
  document
    .getElementById("keywordBenchmarkResult")
    ?.addEventListener("click", handleBenchmarkDiscoveryResultActions);
  document
    .getElementById("btnKeywordStrategyModalClose")
    ?.addEventListener("click", () => toggleKeywordStrategyPanel(false));
  document
    .getElementById("keywordStrategyModalOverlay")
    ?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        toggleKeywordStrategyPanel(false);
      }
    });

  // ---- 批量操作弹窗唤起 ----
  document
    .getElementById("btnOpenBatchNote")
    ?.addEventListener("click", () => openBatchModal("links"));
  document
    .getElementById("btnOpenBatchBlogger")
    ?.addEventListener("click", () => openBatchModal("bloggers"));
  document
    .getElementById("btnOpenBatchSearch")
    ?.addEventListener("click", () => openBatchModal("keywords"));

  document
    .getElementById("btnBatchModalClose")
    ?.addEventListener("click", closeBatchModal);
  document
    .getElementById("batchModalOverlay")
    ?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeBatchModal();
    });

  // ---- 批量采集执行 ----
  document
    .getElementById("btnRunBatchLinks")
    ?.addEventListener("click", handleRunBatchLinks);
  document
    .getElementById("btnRunBatchBloggers")
    ?.addEventListener("click", handleRunBatchBloggers);

  document
    .getElementById("textareaBatchLinks")
    ?.addEventListener("input", persistCurrentBatchDraft);
  document
    .getElementById("textareaBatchBloggers")
    ?.addEventListener("input", persistCurrentBatchDraft);
  document
    .getElementById("textareaBatchKeywords")
    ?.addEventListener("input", () => {
      updateBatchKeywordInputState();
      persistCurrentBatchDraft();
    });

  // ---- 关键词裂变内部逻辑 ----
  document
    .getElementById("btnExpandKeywords")
    ?.addEventListener("click", handleExpandKeywords);
  document
    .getElementById("btnRunKeywordInsight")
    ?.addEventListener("click", handleExpandKeywords);

  document
    .getElementById("btnRunBatchKeywords")
    ?.addEventListener("click", handleBatchKeywordCapture);
  // 无人值守循环:勾选才点亮「每轮间隔 / 循环轮数」输入
  // 勾选「无人值守循环」才点亮对应的「每轮间隔 / 循环轮数」(批量 + 搜索页各一组,按 id 精确定位,避免互相串)
  const bindAutoLoopFields = (chkId, fieldsId) => {
    const chk = document.getElementById(chkId);
    const sync = () =>
      document.getElementById(fieldsId)?.classList.toggle("is-disabled", !chk?.checked);
    chk?.addEventListener("change", sync);
    sync();
  };
  bindAutoLoopFields("chkAutoLoop", "batchLoopFields");
  bindAutoLoopFields("chkSearchAutoLoop", "searchLoopFields");
  // 搜索页「批量多个关键词」开关:切换 单词自动读取 / 多词文本框 + 按钮文案
  const chkSearchBatchEl = document.getElementById("chkSearchBatchMode");
  const syncSearchBatchMode = () => {
    const on = !!chkSearchBatchEl?.checked;
    document.getElementById("searchSingleKeywordGroup")?.toggleAttribute("hidden", on);
    document.getElementById("searchBatchKeywordGroup")?.toggleAttribute("hidden", !on);
    const capBtn = document.getElementById("btnCaptureSearch");
    if (capBtn) capBtn.textContent = on ? "批量采集" : "采集当前搜索结果";
  };
  chkSearchBatchEl?.addEventListener("change", syncSearchBatchMode);
  syncSearchBatchMode();
  document
    .getElementById("keywordInsightError")
    ?.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (!target.closest("#btnRetryKeywordAnalysis")) {
        return;
      }
      event.preventDefault();
      void retryKeywordAnalysis();
    });
  document
    .getElementById("btnViewExpandedKeywords")
    ?.addEventListener("click", toggleExpandedKeywordsVisibility);
  document
    .getElementById("btnClearKeywordInsightResult")
    ?.addEventListener("click", () => clearKeywordInsightResult());
  document
    .getElementById("keywordInsightCategories")
    ?.addEventListener("click", handleKeywordInsightCategoryActions);
  document
    .getElementById("keywordInsightCategories")
    ?.addEventListener("change", handleKeywordInsightCategoryActions);
  document
    .getElementById("keywordInsightSummary")
    ?.addEventListener("click", handleKeywordInsightSummaryActions);

  document
    .getElementById("textareaExpandedKeywords")
    ?.addEventListener("input", () => {
      expandedKeywordsBuffer = parseKeywordsFromMultilineInput(
        document.getElementById("textareaExpandedKeywords")?.value || "",
      );
      updateExpandedKeywordsSummary();
      invalidateKeywordInsightDraft();
      renderKeywordInsightState();
      persistCurrentBatchDraft();
    });

  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel) {
    btnCancel.addEventListener("click", handleCancel);
  }

  const btnVerify = document.getElementById("btnVerify");
  if (btnVerify) {
    btnVerify.addEventListener("click", handleVerify);
  }

  for (const id of ["btnGoClaim", "btnGoClaimConfig"]) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        void handleGoClaim();
      });
    }
  }

  setupAuthCodeInputListeners();
  setupMemberGroupModalListeners();

  const targetInputs = [
    "inputFeishuAppToken",
    "inputTableId",
    "inputKeywordNotesTableName",
    "inputBloggerProfileTableName",
    "inputBloggerNotesTableName",
    "inputCommentLeadsTableName",
    "inputMonitorTableName",
    "inputReportWebhookUrl",
  ];
  targetInputs.forEach((id) => {
    const el = document.getElementById(id);
    // Listen to changes for auto-save
    if (el) {
      el.addEventListener("change", handleSaveTarget);
      el.addEventListener("blur", handleSaveTarget);
    }
  });

  const prefInputs = [
    "inputSyncScope",
    "inputDetailCaptureScope",
    "checkboxSkipOfficialAccounts",
    "inputCommentsMaxDetectedItems",
    "inputCommentLeadsKeywords",
    "inputCommentLeadsIps",
    "inputSharedWaitMinSec",
    "inputSharedWaitMaxSec",
    "inputSharedStallTimeoutSec",
    "inputSharedMaxDurationSec",
    "inputDetailNavTimeoutMs",
    "inputDetailAfterNavWaitMs",
    "inputProfileAfterNavWaitMs",
    "inputBloggerMinLikes",
    "inputBloggerMaxDetectedItems",
    "inputBloggerKeywordFilter",
    "inputKeywordMinLikes",
    "inputKeywordMaxDetectedItems",
  ];
  prefInputs.forEach((id) => {
    const el = document.getElementById(id);
    // Listen to changes for auto-save
    if (el) {
      el.addEventListener("change", handleSaveCaptureSettings);
      el.addEventListener("blur", handleSaveCaptureSettings);
    }
  });

  // Init More Menu Dropdown
  const btnMoreMenu = document.getElementById("btnMoreMenu");
  const dropdownMoreMenu = document.getElementById("dropdownMoreMenu");
  if (btnMoreMenu && dropdownMoreMenu) {
    btnMoreMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdownMoreMenu.classList.toggle("is-active");
    });
    document.addEventListener("click", (e) => {
      if (
        !dropdownMoreMenu.contains(e.target) &&
        !btnMoreMenu.contains(e.target)
      ) {
        dropdownMoreMenu.classList.remove("is-active");
      }
    });
  }

  const btnPlatformMenu = document.getElementById("btnPlatformMenu");
  const dropdownPlatformMenu = document.getElementById("dropdownPlatformMenu");
  if (btnPlatformMenu && dropdownPlatformMenu) {
    btnPlatformMenu.addEventListener("click", (event) => {
      event.stopPropagation();
      const nextOpenState =
        !dropdownPlatformMenu.classList.contains("is-active");
      setPlatformMenuOpen(nextOpenState);
    });

    dropdownPlatformMenu
      .querySelectorAll(".platform-menu-item[data-platform]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const targetPlatform = String(button.dataset.platform || "").trim();
          void handlePlatformMenuSwitch(targetPlatform);
        });
      });

    document.addEventListener("click", (event) => {
      if (
        !dropdownPlatformMenu.contains(event.target) &&
        !btnPlatformMenu.contains(event.target)
      ) {
        setPlatformMenuOpen(false);
      }
    });
  }

  const menuBtnSettings = document.getElementById("menuBtnSettings");
  if (menuBtnSettings) {
    menuBtnSettings.addEventListener("click", () => {
      window.activateSidebarTab("settingsTab");
      if (dropdownMoreMenu) dropdownMoreMenu.classList.remove("is-active");
    });
  }

  const menuBtnHistory = document.getElementById("menuBtnHistory");
  if (menuBtnHistory) {
    menuBtnHistory.addEventListener("click", () => {
      window.activateSidebarTab("historyTab");
      if (dropdownMoreMenu) dropdownMoreMenu.classList.remove("is-active");
    });
  }

  const menuBtnCheckUpdate = document.getElementById("menuBtnCheckUpdate");
  if (menuBtnCheckUpdate) {
    menuBtnCheckUpdate.addEventListener("click", () => {
      void checkExtensionUpdate({
        trigger: "manual",
        openModalWhenLatest: true,
      });
      if (dropdownMoreMenu) dropdownMoreMenu.classList.remove("is-active");
    });
  }

  const menuBtnContact = document.getElementById("menuBtnContact");
  if (menuBtnContact) {
    menuBtnContact.addEventListener("click", () => {
      openContactModal();
      if (dropdownMoreMenu) dropdownMoreMenu.classList.remove("is-active");
    });
  }
  setupContactModalListeners();

  const btnOpenRiskModal = document.getElementById("btnOpenRiskModal");
  if (btnOpenRiskModal) {
    btnOpenRiskModal.addEventListener("click", () => {
      openRiskModal();
    });
  }
  setupRiskModalListeners();
  setupUpdateModalListeners();
  setupUpdateGuideModalListeners();

  const btnMonitorAddCurrent = document.getElementById("btnMonitorAddCurrent");
  if (btnMonitorAddCurrent) {
    btnMonitorAddCurrent.addEventListener("click", () => {
      void handleAddCurrentMonitor();
    });
  }
  const btnMonitorRunNow = document.getElementById("btnMonitorRunNow");
  if (btnMonitorRunNow) {
    btnMonitorRunNow.addEventListener("click", () => {
      void handleRunMonitorNow();
    });
  }

  const monitorStatusFilter = document.getElementById("monitorStatusFilter");
  if (monitorStatusFilter) {
    monitorStatusFilter.addEventListener("change", (event) => {
      const nextStatus = String(
        event.target?.value || MONITOR_STATUS.ALL,
      ).trim();
      void setCurrentMonitor({
        filters: {
          ...(getCurrentMonitor()?.filters || {}),
          status: nextStatus || MONITOR_STATUS.ALL,
        },
      }).then(() => loadMonitorSubscriptions({force: true}));
    });
  }

  const monitorSubscriptionList = document.getElementById(
    "monitorSubscriptionList",
  );
  if (monitorSubscriptionList) {
    monitorSubscriptionList.addEventListener("click", handleMonitorListClick);
  }

  [
    "inputMonitorPublishWindow",
    "inputMonitorLikeThreshold",
    "inputMonitorRunTimes",
    "inputMonitorObserveWindowHours",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      void handleSaveMonitorSettings();
    });
    el.addEventListener("blur", () => {
      void handleSaveMonitorSettings();
    });
  });

  const btnSyncAll = document.getElementById("btnSyncAll");
  if (btnSyncAll) {
    btnSyncAll.addEventListener("click", handleSyncAll);
  }

  const btnExport = document.getElementById("btnExport");
  if (btnExport) {
    btnExport.addEventListener("click", handleExport);
  }

  const btnClearPool = document.getElementById("btnClearPool");
  if (btnClearPool) {
    btnClearPool.addEventListener("click", handleClearPool);
  }

  const btnClearSyncHistory = document.getElementById("btnClearSyncHistory");
  if (btnClearSyncHistory) {
    btnClearSyncHistory.addEventListener("click", handleClearSyncHistory);
  }

  const btnCopyDiagnostics = document.getElementById("btnCopyDiagnostics");
  if (btnCopyDiagnostics) {
    btnCopyDiagnostics.addEventListener("click", () => {
      void handleCopyDiagnostics();
    });
  }

  const recordList = document.getElementById("recordList");
  if (recordList) {
    recordList.addEventListener("click", handleRecordListClick);
  }

  window.requestMonitorRefresh = () => {
    void Promise.all([loadMonitorSettings(), loadMonitorSubscriptions()]);
  };

  window.requestExecutionDetailRefresh = () => {
    void loadExecutionDetails({force: true});
  };

  window.requestAuthRefresh = (options = {}) => {
    void refreshVerifiedAuthSnapshot({
      showFeedback: Boolean(options?.showFeedback),
    });
  };
}

async function handlePlatformMenuSwitch(targetPlatform) {
  const normalizedTargetPlatform = String(targetPlatform || "").trim();
  if (!normalizedTargetPlatform) {
    setPlatformMenuOpen(false);
    return;
  }

  const runtime = getCurrentRuntime();
  const pagePlatform = getPagePlatform(runtime);
  const selectedPlatform = resolveSelectedPlatform(runtime, pagePlatform);

  if (normalizedTargetPlatform === pagePlatform) {
    if (manualSelectedPlatform || selectedPlatform !== pagePlatform) {
      manualSelectedPlatform = "";
      updatePlatformUI(runtime);
      updatePageTypeUI(runtime?.pageType || PAGE_TYPE.UNKNOWN);
      await refreshDataPool();
    }
    setPlatformMenuOpen(false);
    return;
  }

  const platformCopy = getPlatformCopy(normalizedTargetPlatform);
  setPlatformMenuOpen(false);
  showMessage(`正在打开${platformCopy.label}主页...`, "info");

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.SWITCH_PLATFORM_TAB,
      platform: normalizedTargetPlatform,
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "打开平台页面失败");
    }
    manualSelectedPlatform = "";
  } catch (error) {
    console.error("[Sidebar] Platform switch failed:", error);
    showMessage(`打开${platformCopy.label}主页失败: ${error.message}`, "error");
  }
}

// ==================== 事件处理器 ====================

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
      activeCommentsCaptureRecordId = result.recordId;
    }

    if (result.ok) {
      if (result.phase === "note_ready") {
        showMessage("笔记采集成功，已加入缓存池", "success");
      } else if (result.phase === "comments_partial") {
        taskStatus = "partial";
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
      if (commentsFailed && metricsFailed) {
        showMessage(
          "笔记已入池，评论与博主指标采集失败（评论可点击 ↻ 重试）",
          "warning",
        );
      } else if (commentsFailed) {
        showMessage("笔记已入池，评论采集失败，可点击 ↻ 仅重试评论", "warning");
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
    activeCommentsCaptureRecordId = "";
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
  showProgress("正在采集博主信息...");

  try {
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
    await maybeRunAutoDetailCaptureAfterListCapture(
      resolveCurrentDetailCaptureSettings(await getCaptureSettings()),
      {
        sourceLabel: "博主笔记",
        recordIds: notesResult.recordIds,
      },
    );
  } catch (error) {
    console.error("[Sidebar] Capture blogger failed:", error);
    taskStatus = "failed";
    taskError = error;
    showMessage("操作失败: " + error.message, "error");
  } finally {
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

// 搜索页:在当前激活 tab 应用排序/发布时间筛选(复用 content 的 applyBatchSearchFilters,失败不阻断采集)
async function applySearchFiltersOnActiveTab(tabId, { sort = "", publishTime = "" } = {}) {
  if ((!sort && !publishTime) || !Number.isFinite(Number(tabId))) return;
  try {
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: Number(tabId),
      payload: { action: "applyBatchSearchFilters", sort, publishTime },
    });
  } catch (error) {
    console.warn("[Sidebar] 搜索页筛选切换失败(不影响采集):", error);
  }
}

function getSearchBatchKeywordsFromTextarea() {
  return String(document.getElementById("textareaSearchBatchKeywords")?.value || "")
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
  const searchBatchMode = !!document.getElementById("chkSearchBatchMode")?.checked;
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

  try {
    const settings = resolveCurrentDetailCaptureSettings(
      await getCaptureSettings(),
    );
    if (
      settings.autoDetailCaptureAfterListCapture &&
      !ensureAuthVerifiedOrWarn({
        message: PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
      })
    ) {
      taskStatus = "skipped";
      return;
    }
    const sortContext = await syncKeywordSortDimensionFromPage({
      force: true,
      fallbackDimension: keywordSortDimension,
    });
    const sortLabel = getKeywordSortDimensionLabel(sortContext.dimension);
    const keywordMinLikes = readKeywordMinLikesFromInput(
      settings.keywordMinLikes,
    );
    const keywordMaxDetectedItems = readKeywordMaxDetectedItemsFromInput(
      settings.keywordMaxDetectedItems,
    );

    // 搜索页:排序/发布时间筛选 + 循环轮数 + 定时启动(复用批量那套能力)
    searchCaptureCancelRequested = false;
    const rawSearchSort = document.getElementById("selectSearchSort")?.value || "";
    const rawSearchTime = document.getElementById("selectSearchPublishTime")?.value || "";
    const searchFilters = {
      sort: rawSearchSort === "comprehensive" ? "" : rawSearchSort,
      publishTime: rawSearchTime === "all" ? "" : rawSearchTime,
    };
    const searchAutoLoop = !!document.getElementById("chkSearchAutoLoop")?.checked;
    const searchGapMin = Math.max(0, Number(document.getElementById("inputSearchLoopGapMin")?.value) || 0);
    const searchMaxRounds = Math.max(1, Math.floor(Number(document.getElementById("inputSearchLoopRounds")?.value)) || 1);
    const searchGapMs = searchGapMin * 60 * 1000;

    // 定时启动:等到指定时刻再开跑(可中断,显倒计时)
    const searchScheduledStr = document.getElementById("inputSearchScheduledStart")?.value || "";
    if (searchScheduledStr) {
      const targetMs = new Date(searchScheduledStr).getTime();
      if (Number.isFinite(targetMs) && targetMs > Date.now()) {
        const targetLabel = new Date(searchScheduledStr).toLocaleString("zh-CN");
        let lastSec = -1;
        await sleepWithStop(targetMs - Date.now(), () => {
          if (searchCaptureCancelRequested) return true;
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
        if (searchCaptureCancelRequested) {
          taskStatus = "skipped";
          showMessage("已取消定时采集", "warning");
          return;
        }
      }
    }

    let searchRound = 0;
    do {
      searchRound += 1;
      if (searchBatchMode) {
        // 批量多词:逐词在 runner tab(=当前 tab)采,排序/发布时间由 batchCaptureByKeywords 内部逐词应用
        activeBatchRunnerTabId = searchActiveTabId ? Number(searchActiveTabId) : null;
        const batchResult = await batchCaptureByKeywords({
          keywords: [...searchKeywords],
          platform: pagePlatform,
          baseSearchUrl: activeTabUrl,
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
          onProgress: (p) =>
            showProgress(
              searchAutoLoop
                ? `第 ${searchRound} 轮 · ${p?.message || ""}`
                : p?.message || "正在批量采集...",
              "info",
            ),
          shouldStop: () => searchCaptureCancelRequested,
        });
        await refreshDataPool();
        if (batchResult?.canceled) {
          taskStatus = "partial";
          searchCaptureCancelRequested = true;
        } else {
          const enhanceResult = await maybeRunAutoDetailCaptureAfterListCapture(
            resolveCurrentDetailCaptureSettings(await getCaptureSettings()),
            { sourceLabel: "批量搜索结果", recordIds: collectBatchRecordIds(batchResult) },
          );
          if (enhanceResult?.securityBlocked) {
            // 撞小红书风控:停掉整轮无人值守,别再往下跑(越跑越死)
            searchCaptureCancelRequested = true;
            taskStatus = "partial";
            showMessage("⚠️ 触发小红书安全限制(访问频繁),已停止无人值守。建议隔较长时间(数小时)再跑。", "warning");
          } else if ((batchResult?.stats?.failed || 0) > 0) taskStatus = "completed_with_failures";
        }
      } else {
        // 单词:在当前页切筛选 + 单次采集
        if (searchFilters.sort || searchFilters.publishTime) {
          await applySearchFiltersOnActiveTab(searchActiveTabId, searchFilters);
          await sleepWithStop(1500, () => searchCaptureCancelRequested);
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
          const enhanceResult = await maybeRunAutoDetailCaptureAfterListCapture(
            resolveCurrentDetailCaptureSettings(await getCaptureSettings()),
            { sourceLabel: "搜索结果", recordIds: actionResult.recordIds },
          );
          if (enhanceResult?.securityBlocked) {
            searchCaptureCancelRequested = true;
            taskStatus = "partial";
            showMessage("⚠️ 触发小红书安全限制(访问频繁),已停止无人值守。建议隔较长时间(数小时)再跑。", "warning");
          } else if (enhanceResult?.canceled) {
            taskStatus = "partial";
            searchCaptureCancelRequested = true;
          } else if (enhanceResult && enhanceResult.ok === false) {
            taskStatus = "completed_with_failures";
          }
        } else if (searchCaptureCancelRequested) {
          taskStatus = "partial";
        } else {
          taskStatus = "failed";
        }
      }

      // 终止:取消 / 没开循环 / 到轮数(单轮失败不停,继续按计划跑)
      if (searchCaptureCancelRequested || !searchAutoLoop || searchRound >= searchMaxRounds) {
        break;
      }
      if (searchGapMs > 0) {
        showProgress(`第 ${searchRound} 轮完成,${searchGapMin} 分钟后开始第 ${searchRound + 1} 轮…`, "info");
        await sleepWithStop(searchGapMs, () => searchCaptureCancelRequested);
      }
    } while (!searchCaptureCancelRequested);

    if (searchAutoLoop) {
      showMessage(
        `无人值守搜索采集${searchCaptureCancelRequested ? "已停止" : "结束"}:共跑 ${searchRound} 轮`,
        searchCaptureCancelRequested ? "warning" : "success",
      );
    }
  } catch (error) {
    console.error("[Sidebar] Capture search failed:", error);
    taskStatus = "failed";
    taskError = error;
    showMessage("操作失败: " + error.message, "error");
  } finally {
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        platform: pagePlatform,
        keyword,
      },
    });
    hideProgress();
    searchCaptureCancelRequested = false;
  }
}

function setKeywordStrategyTab(tab = "opportunity") {
  keywordStrategyActiveTab =
    tab === "longtail" || tab === "benchmark" ? tab : "opportunity";
  if (keywordStrategyActiveTab === "longtail") {
    const runtime = getCurrentRuntime();
    const pagePlatform = getPagePlatform(runtime);
    const selectedPlatform = getViewPlatform(runtime);
    if (
      runtime?.pageType === PAGE_TYPE.SEARCH_RESULTS &&
      selectedPlatform === pagePlatform &&
      getPlatformCapabilities(pagePlatform).captureSearch
    ) {
      syncSeedKeywordFromCurrentSearch(getCurrentSearchKeyword(runtime));
    } else {
      updateExpandKeywordsButtonState();
    }
    renderKeywordInsightState();
  }
  renderKeywordStrategyPanel();
}

function toggleKeywordStrategyPanel(forceVisible) {
  keywordStrategyPanelVisible =
    typeof forceVisible === "boolean"
      ? forceVisible
      : !keywordStrategyPanelVisible;
  renderKeywordStrategyPanel();
}

function formatOpportunityMetric(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0";
  }
  if (numeric >= 10000) {
    return `${(numeric / 10000).toFixed(numeric >= 100000 ? 0 : 1)}w`;
  }
  return `${Math.round(numeric)}`;
}

function normalizeKeywordOpportunityTitleForMatch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[【】\[\]()（）"'“”‘’`]/g, "")
    .replace(/[，。！？、；：,.!?;:|｜/\\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildKeywordOpportunityTitleCandidates(result) {
  const candidates = [];
  const append = (title, url) => {
    const normalizedTitle = normalizeKeywordOpportunityTitleForMatch(title);
    const normalizedUrl = String(url || "").trim();
    if (!normalizedTitle || !normalizedUrl) {
      return;
    }
    candidates.push({
      title: String(title || "").trim(),
      normalizedTitle,
      url: normalizedUrl,
    });
  };

  const storedListItems = Array.isArray(result?._listItems) ? result._listItems : [];
  storedListItems.forEach((item) => {
    append(item?.title, item?.url || item?.detailPageUrl || item?.noteUrl);
  });

  const representativeSamples = Array.isArray(result?._representativeSamples)
    ? result._representativeSamples
    : [];
  representativeSamples.forEach((item) => {
    append(item?.title, item?.url || item?.detailPageUrl || item?.noteUrl);
  });

  return candidates;
}

function resolveKeywordOpportunityTitleUrl(result, title) {
  const normalizedTitle = normalizeKeywordOpportunityTitleForMatch(title);
  if (!normalizedTitle) {
    return "";
  }

  const candidates = buildKeywordOpportunityTitleCandidates(result);
  const exactMatch = candidates.find(
    (item) => item.normalizedTitle === normalizedTitle,
  );
  if (exactMatch?.url) {
    return exactMatch.url;
  }

  const inclusiveMatch = candidates.find(
    (item) =>
      item.normalizedTitle.includes(normalizedTitle) ||
      normalizedTitle.includes(item.normalizedTitle),
  );
  return inclusiveMatch?.url || "";
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

function renderKeywordStrategyLoadingState({
  title = "正在分析",
  meta = "正在整理数据并生成判断，请稍候",
} = {}) {
  return `
    <div class="keyword-insight-summary-card keyword-strategy-loading-card is-loading">
      <div class="keyword-insight-summary-title">
        <span class="keyword-insight-loading-spinner" aria-hidden="true"></span>
        ${escapeHtml(title)}
      </div>
      <div class="keyword-insight-summary-meta">${escapeHtml(meta)}</div>
    </div>
  `;
}

function setKeywordBenchmarkLoading(title, meta) {
  keywordBenchmarkAnalysisStatus = "loading";
  keywordBenchmarkLoadingTitle = title;
  keywordBenchmarkLoadingMeta = meta;
  renderKeywordStrategyPanel();
}

function renderBenchmarkDiscoveryResult() {
  if (keywordBenchmarkAnalysisStatus === "loading") {
    return renderKeywordStrategyLoadingState({
      title: keywordBenchmarkLoadingTitle || "正在找对标账号",
      meta:
        keywordBenchmarkLoadingMeta ||
        "正在采集样本、补采账号主页并生成推荐判断",
    });
  }

  const result = keywordBenchmarkResult;
  if (!result) {
    return "";
  }
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const potentialLabels = {
    high: "优先对标",
    medium: "可观察",
    low: "先复核",
  };
  const candidateHtml =
    candidates.length > 0
      ? candidates
          .map((candidate, index) => {
            const profile = candidate.profile || null;
            const analysis = candidate.analysis || buildBenchmarkDiscoveryFallbackAnalysis(candidate);
            const recommendationReason =
              analysis.recommendationReason ||
              buildBenchmarkDiscoveryRuleReason(candidate);
            const decisionAngle = buildBenchmarkDiscoveryDecisionAngle(
              candidate,
              analysis,
            );
            const evidenceItems = buildBenchmarkDiscoveryCandidateEvidence(
              candidate,
            );
            const representativeWorks =
              buildBenchmarkDiscoveryRepresentativeWorks(candidate, 3);
            return `
              <div class="keyword-benchmark-card">
                <div class="keyword-benchmark-card-head">
                  <div class="keyword-benchmark-rank">#${index + 1}</div>
                  <div class="keyword-benchmark-account">
                    <div class="keyword-benchmark-name">${escapeHtml(profile?.bloggerName || candidate.authorName || "未知账号")}</div>
                    <div class="keyword-benchmark-conclusion">${escapeHtml(recommendationReason)}</div>
                    <div class="keyword-benchmark-angle">${escapeHtml(decisionAngle)}</div>
                  </div>
                </div>
                <div class="keyword-benchmark-tags">
                  <span class="keyword-benchmark-potential keyword-benchmark-potential-${escapeHtml(analysis.growthPotential || "medium")}">${escapeHtml(potentialLabels[analysis.growthPotential] || "观察")}</span>
                  ${(Array.isArray(analysis.tags) ? analysis.tags : [])
                    .map((tag) => `<span>${escapeHtml(tag)}</span>`)
                    .join("")}
                </div>
                <div class="keyword-benchmark-evidence">
                  <div class="keyword-benchmark-section-title">判断依据</div>
                  ${analysis.focusAssessment ? `<p>${escapeHtml(analysis.focusAssessment)}</p>` : ""}
                  <ul>
                    ${evidenceItems
                      .map((item) => `<li>${escapeHtml(item)}</li>`)
                      .join("")}
                  </ul>
                </div>
                ${
                  representativeWorks.length > 0
                    ? `<div class="keyword-benchmark-work-list">
                        <div class="keyword-benchmark-section-title">代表作品</div>
                        <ul>
                          ${representativeWorks
                            .map(
                              (item) => `
                                <li>
                                  ${
                                    item.url
                                      ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>`
                                      : `<span>${escapeHtml(item.title)}</span>`
                                  }
                                  <em>赞 ${escapeHtml(formatOpportunityMetric(item.likes))}${item.collects ? ` · 藏 ${escapeHtml(formatOpportunityMetric(item.collects))}` : ""}</em>
                                </li>
                              `,
                            )
                            .join("")}
                        </ul>
                      </div>`
                    : ""
                }
                <div class="keyword-benchmark-actions">
                  ${
                    candidate.authorProfileUrl
                      ? `<button type="button" class="keyword-benchmark-action keyword-benchmark-action-primary" data-action="monitor-benchmark-account" data-url="${escapeHtml(candidate.authorProfileUrl)}" data-name="${escapeHtml(profile?.bloggerName || candidate.authorName || "")}">纳入监控</button>`
                      : ""
                  }
                  ${
                    candidate.authorProfileUrl
                      ? `<button type="button" class="keyword-benchmark-action" data-action="open-benchmark-profile" data-url="${escapeHtml(candidate.authorProfileUrl)}">打开主页</button>`
                      : ""
                  }
                </div>
              </div>
            `;
          })
          .join("")
      : `<div class="keyword-benchmark-empty">当前样本里还没有出现 ${Number(result.minOccurrence) || 2} 次以上的账号。可以换一个更明确的主词，或扩大采样后再试。</div>`;

  return `
    <section class="keyword-benchmark-summary">
      <div class="keyword-benchmark-summary-head">
        <div>
          <div class="keyword-opportunity-keyword">${escapeHtml(result.keyword || "")}</div>
          <div class="keyword-benchmark-summary-text">
            已从 ${Number(result.sampleCount) || 0} 条搜索结果中筛出 ${Number(result.candidateCount) || 0} 个候选账号；当前入围门槛为样本出现 ${Number(result.minOccurrence) || 2} 次，优先结合账号主页、粉丝量级和代表内容判断是否值得对标。
          </div>
        </div>
        <div class="keyword-insight-share-wrap">
          <button type="button" class="keyword-insight-share-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
            去分享
          </button>
          <div class="keyword-insight-share-menu">
            <div class="keyword-insight-share-menu-inner">
              <button type="button" class="keyword-insight-share-menu-item" data-action="copy-benchmark">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                复制文本
              </button>
              <button type="button" class="keyword-insight-share-menu-item" data-action="share-benchmark-as-image">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                分享图片
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">候选账号</div>
      <div class="keyword-benchmark-list">${candidateHtml}</div>
    </section>
  `;
}

function renderKeywordOpportunityResult() {
  const result = keywordOpportunityResult;
  if (!result) {
    return "";
  }

  const ruleMetrics = result.ruleMetrics || {};
  const topicDirections = Array.isArray(result.hotTopicDirections)
    ? result.hotTopicDirections
    : [];
  const recommendedAngles = Array.isArray(result.recommendedAngles)
    ? result.recommendedAngles
    : [];
  const subtopics = Array.isArray(result.coreWinningSubtopics)
    ? result.coreWinningSubtopics
    : [];

  const metrics = [
    {
      label: "热度",
      value:
        ruleMetrics.heatLevel === "high"
          ? "高"
          : ruleMetrics.heatLevel === "medium"
            ? "中"
            : "低",
      desc:
        "看这个词里最能打的一批内容，整体大概能冲到多高。越高，说明这个词更容易出大爆款。",
    },
    {
      label: "高位区间",
      value:
        ruleMetrics.highBandEnd > 0
          ? `${ruleMetrics.highBandStart}-${ruleMetrics.highBandEnd}`
          : "未识别",
      desc:
        "表示前几名内容明显更强，通常是第几名到第几名。比如 1-6，就是前 6 条表现特别突出。",
    },
    {
      label: "断层跌幅",
      value:
        ruleMetrics.cliffDropRatio > 0
          ? `${Math.round(ruleMetrics.cliffDropRatio * 100)}%`
          : "不明显",
      desc:
        "看前排内容和后面内容差得有多大。越大，说明流量越集中在少数几条爆款上。",
    },
    {
      label: "高位均赞",
      value: formatOpportunityMetric(ruleMetrics.highBandAvgLikes),
      desc:
        "前排爆款内容的平均点赞数，可以理解为这个词做得好的内容，通常能拿到多少赞。",
    },
    {
      label: "中位赞",
      value: formatOpportunityMetric(ruleMetrics.medianLikes),
      desc:
        "把所有内容按点赞从高到低排，取中间那条的点赞数。可以理解为普通内容大概是什么水平。",
    },
  ];

  const bandPresenceLabels = {
    high: "高赞区",
    mid: "中赞区",
    low: "低赞区",
    high_mid: "高赞区+中赞区",
    mid_low: "中赞区+低赞区",
    all: "高赞区+中赞区+低赞区",
  };

  const organicViabilityLabels = {
    high: "自然流可行性高",
    medium: "自然流可行性中",
    low: "自然流可行性低",
  };

  const topicHtml =
    topicDirections.length > 0
      ? topicDirections
          .map((direction) => {
            const titles = Array.isArray(direction.representativeTitles)
              ? direction.representativeTitles
              : [];
            const bandLabel = bandPresenceLabels[direction.bandPresence] || "";
            const viability = direction.organicViability || "medium";
            const viabilityLabel = organicViabilityLabels[viability] || "";
            const avgLikesValue = Number(direction.avgLikes) || 0;
            return `
              <div class="keyword-opportunity-topic-card">
                <div class="keyword-opportunity-topic-name">${escapeHtml(direction.name || "未命名类目")}</div>
                <div class="keyword-opportunity-topic-meta">
                  ${bandLabel ? `<span class="keyword-opportunity-band-tag keyword-opportunity-band-${escapeHtml(direction.bandPresence || "all")}">${escapeHtml(bandLabel)}</span>` : ""}
                  <span class="keyword-opportunity-organic-tag keyword-opportunity-organic-${escapeHtml(viability)}">${escapeHtml(viabilityLabel)}</span>
                  <span class="keyword-opportunity-topic-stats">${Number(direction.sampleCount) || 0} 篇 · ${Math.round((Number(direction.shareRatio) || 0) * 100)}%${avgLikesValue > 0 ? ` · 均赞 ${formatOpportunityMetric(avgLikesValue)}` : ""}</span>
                </div>
                ${direction.userIntent ? `<div class="keyword-opportunity-topic-intent"><span class="keyword-opportunity-topic-intent-label">用户意图</span>${escapeHtml(direction.userIntent)}</div>` : ""}
                <div class="keyword-opportunity-topic-reason">${escapeHtml(direction.whyItWorks || "")}</div>
                ${direction.organicNote ? `<div class="keyword-opportunity-topic-organic-note">${escapeHtml(direction.organicNote)}</div>` : ""}
                ${
                  titles.length > 0
                    ? `<div class="keyword-opportunity-topic-titles">
                        <div class="keyword-opportunity-topic-titles-label">代表标题</div>
                        <ul class="keyword-opportunity-topic-title-list">
                          ${titles
                            .map((t) => {
                              const matchUrl = resolveKeywordOpportunityTitleUrl(
                                result,
                                t,
                              );
                              return matchUrl
                                ? `<li><a href="${escapeHtml(matchUrl)}" class="keyword-opportunity-title-link" target="_blank" rel="noopener">${escapeHtml(t)}</a></li>`
                                : `<li>${escapeHtml(t)}</li>`;
                            })
                            .join("")}
                        </ul>
                      </div>`
                    : ""
                }
              </div>
            `;
          })
          .join("")
      : `<div class="keyword-opportunity-topic-card"><div class="keyword-opportunity-topic-reason">当前样本中还没有稳定聚合出足够清晰的内容类目，建议结合长尾词继续下钻。</div></div>`;

  const angleHtml =
    recommendedAngles.length > 0
      ? recommendedAngles
          .map(
            (angle) => `
              <div class="keyword-opportunity-angle-card">
                <div class="keyword-opportunity-angle-head">
                  <div class="keyword-opportunity-angle-title">${escapeHtml(angle.title || "未命名选题")}</div>
                </div>
                <div class="keyword-opportunity-angle-body">
                  ${angle.audiencePainPoint ? `<div class="keyword-opportunity-angle-field">${escapeHtml(angle.audiencePainPoint)}</div>` : ""}
                  ${angle.formatSuggestion ? `<div class="keyword-opportunity-angle-field"><span class="keyword-opportunity-angle-field-label">形式建议</span>${escapeHtml(angle.formatSuggestion)}</div>` : ""}
                  ${angle.executionHint ? `<div class="keyword-opportunity-angle-field"><span class="keyword-opportunity-angle-field-label">执行提示</span>${escapeHtml(angle.executionHint)}</div>` : ""}
                </div>
              </div>
            `,
          )
          .join("")
      : `<div class="keyword-opportunity-angle-card"><div class="keyword-opportunity-angle-body">当前还没有生成可执行选题，建议先用分析长尾需求验证更具体的切口。</div></div>`;

  const subtopicHtml =
    subtopics.length > 0
      ? subtopics
          .map(
            (item) =>
              `<span class="keyword-opportunity-chip">${escapeHtml(item)}</span>`,
          )
          .join("")
      : `<span class="keyword-opportunity-chip">暂无明确细分切口</span>`;

  return `
    <section class="keyword-opportunity-summary">
      <div class="keyword-opportunity-summary-head">
        <div class="keyword-opportunity-summary-head-left">
          <div class="keyword-opportunity-keyword">${escapeHtml(result.keyword || "")}</div>
        </div>
        <div class="keyword-insight-share-wrap">
          <button type="button" class="keyword-insight-share-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
            去分享
          </button>
          <div class="keyword-insight-share-menu">
            <div class="keyword-insight-share-menu-inner">
              <button type="button" class="keyword-insight-share-menu-item" data-action="copy-opportunity">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                复制文本
              </button>
              <button type="button" class="keyword-insight-share-menu-item" data-action="share-opportunity-as-image">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                分享图片
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="keyword-opportunity-summary-distribution">${escapeHtml(result.distributionSummary || "")}</div>
      <div class="keyword-opportunity-metrics">
        ${metrics
          .map(
            (metric) => `
              <div class="keyword-opportunity-metric">
                <div class="keyword-opportunity-metric-label-row">
                  <div class="keyword-opportunity-metric-label">${escapeHtml(metric.label)}</div>
                  <span class="auth-help-popover-wrap keyword-opportunity-help-wrap">
                    <button
                      type="button"
                      class="auth-help-trigger keyword-opportunity-help-trigger"
                      aria-label="查看${escapeHtml(metric.label)}说明">
                      ?
                    </button>
                    <span
                      class="auth-help-popover keyword-opportunity-help-popover"
                      role="tooltip">
                      ${escapeHtml(metric.desc)}
                    </span>
                  </span>
                </div>
                <div class="keyword-opportunity-metric-value">${escapeHtml(metric.value)}</div>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">内容分布全景</div>
      <div class="keyword-opportunity-topic-list">${topicHtml}</div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">核心爆款细分词</div>
      <div class="keyword-opportunity-chip-list">${subtopicHtml}</div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">新号优先选题</div>
      <div class="keyword-opportunity-angle-list">${angleHtml}</div>
    </section>
  `;
}

function renderKeywordStrategyPanel() {
  const overlay = document.getElementById("keywordStrategyModalOverlay");
  const btnToggle = document.getElementById("btnToggleKeywordStrategy");
  const btnRun = document.getElementById("btnRunKeywordOpportunity");
  const btnBenchmarkRun = document.getElementById("btnRunBenchmarkDiscovery");
  const btnBenchmarkTab = document.getElementById(
    "btnKeywordStrategyTabBenchmark",
  );
  const btnOpportunityTab = document.getElementById(
    "btnKeywordStrategyTabOpportunity",
  );
  const btnLongtailTab = document.getElementById(
    "btnKeywordStrategyTabLongtail",
  );
  const opportunityPane = document.getElementById(
    "keywordStrategyOpportunityPane",
  );
  const benchmarkPane = document.getElementById("keywordStrategyBenchmarkPane");
  const longtailPane = document.getElementById("keywordStrategyLongtailPane");
  const longtailHint = document.getElementById("keywordStrategyLongtailHint");
  const benchmarkErrorEl = document.getElementById("keywordBenchmarkError");
  const benchmarkResultEl = document.getElementById("keywordBenchmarkResult");
  const errorEl = document.getElementById("keywordOpportunityError");
  const resultEl = document.getElementById("keywordOpportunityResult");
  if (!overlay) {
    return;
  }

  const runtime = getCurrentRuntime();
  const currentKeyword = getCurrentSearchKeyword(runtime);
  const pagePlatform = getPagePlatform(runtime);
  const selectedPlatform = getViewPlatform(runtime);
  const visible =
    keywordStrategyPanelVisible &&
    runtime?.pageType === PAGE_TYPE.SEARCH_RESULTS &&
    selectedPlatform === pagePlatform &&
    getPlatformCapabilities(pagePlatform).captureSearch;
  overlay.classList.toggle("is-active", visible);
  overlay.ariaHidden = visible ? "false" : "true";

  if (btnToggle) {
    btnToggle.disabled =
      runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS ||
      selectedPlatform !== pagePlatform ||
      !getPlatformCapabilities(pagePlatform).captureSearch;
    btnToggle.classList.toggle("is-disabled", btnToggle.disabled);
    btnToggle.title = "赛道策略";
  }

  if (!visible) {
    return;
  }

  const isBenchmark = keywordStrategyActiveTab === "benchmark";
  const isOpportunity = keywordStrategyActiveTab === "opportunity";
  const isLongtail = keywordStrategyActiveTab === "longtail";
  if (btnBenchmarkTab) {
    btnBenchmarkTab.classList.toggle("is-active", isBenchmark);
    btnBenchmarkTab.setAttribute(
      "aria-selected",
      isBenchmark ? "true" : "false",
    );
  }
  if (btnOpportunityTab) {
    btnOpportunityTab.classList.toggle("is-active", isOpportunity);
    btnOpportunityTab.setAttribute(
      "aria-selected",
      isOpportunity ? "true" : "false",
    );
  }
  if (btnLongtailTab) {
    btnLongtailTab.classList.toggle("is-active", isLongtail);
    btnLongtailTab.setAttribute(
      "aria-selected",
      isLongtail ? "true" : "false",
    );
  }
  if (benchmarkPane) {
    benchmarkPane.hidden = !isBenchmark;
  }
  if (opportunityPane) {
    opportunityPane.hidden = !isOpportunity;
  }
  if (longtailPane) {
    longtailPane.hidden = !isLongtail;
  }

  if (longtailHint) {
    const resultKeyword = getKeywordOpportunityKeyword();
    if (currentKeyword && resultKeyword && currentKeyword !== resultKeyword) {
      longtailHint.textContent = `当前搜索词是「${currentKeyword}」，当前判断结果保留自「${resultKeyword}」。`;
    } else if (isBenchmark && currentKeyword) {
      longtailHint.textContent = `当前搜索词「${currentKeyword}」可用来找对标账号，也可以继续判断赛道机会和分析长尾需求。`;
    } else if (currentKeyword) {
      longtailHint.textContent = `当前搜索词「${currentKeyword}」可以判断赛道机会、找对标账号和分析长尾需求。`;
    } else if (resultKeyword) {
      longtailHint.textContent = `当前判断结果保留自「${resultKeyword}」，切回搜索页后可重新分析。`;
    } else {
      longtailHint.textContent = "先判断赛道机会，再找对标账号和分析长尾需求。";
    }
  }
  const btnBenchmarkCancel = document.getElementById("btnCancelBenchmarkDiscovery");
  const btnBenchmarkClear = document.getElementById(
    "btnClearBenchmarkDiscoveryResult",
  );
  if (btnBenchmarkRun) {
    btnBenchmarkRun.disabled =
      keywordBenchmarkInFlight || keywordOpportunityInFlight || !currentKeyword;
    btnBenchmarkRun.classList.toggle("is-disabled", btnBenchmarkRun.disabled);
    btnBenchmarkRun.textContent = keywordBenchmarkInFlight
      ? "查找中..."
      : "开始找对标账号";
    btnBenchmarkRun.style.display = keywordBenchmarkInFlight
      ? "none"
      : "inline-flex";
  }
  if (btnBenchmarkCancel) {
    btnBenchmarkCancel.style.display = keywordBenchmarkInFlight
      ? "inline-flex"
      : "none";
  }
  if (btnBenchmarkClear) {
    btnBenchmarkClear.hidden =
      (!keywordBenchmarkResult &&
        !String(keywordBenchmarkErrorMessage || "").trim() &&
        keywordBenchmarkAnalysisStatus !== "loading") ||
      keywordBenchmarkInFlight;
  }
  if (benchmarkErrorEl) {
    benchmarkErrorEl.hidden = !keywordBenchmarkErrorMessage;
    benchmarkErrorEl.textContent = keywordBenchmarkErrorMessage;
  }
  const benchmarkIntroTextEl = document.getElementById(
    "keywordBenchmarkIntroText",
  );
  if (benchmarkIntroTextEl) {
    benchmarkIntroTextEl.hidden =
      !!keywordBenchmarkResult || keywordBenchmarkAnalysisStatus === "loading";
  }
  if (benchmarkResultEl) {
    benchmarkResultEl.innerHTML = renderBenchmarkDiscoveryResult();
  }
  const btnCancel = document.getElementById("btnCancelKeywordOpportunity");
  const btnClear = document.getElementById("btnClearKeywordOpportunityResult");
  if (btnRun) {
    btnRun.disabled = keywordOpportunityInFlight || !currentKeyword;
    btnRun.classList.toggle("is-disabled", btnRun.disabled);
    btnRun.textContent = keywordOpportunityInFlight
      ? "分析中..."
      : "开始判断赛道机会";
    btnRun.style.display = keywordOpportunityInFlight ? "none" : "inline-flex";
  }
  if (btnCancel) {
    btnCancel.style.display = keywordOpportunityInFlight
      ? "inline-flex"
      : "none";
  }
  if (btnClear) {
    btnClear.hidden =
      (!keywordOpportunityResult &&
        !String(keywordOpportunityErrorMessage || "").trim()) ||
      keywordOpportunityInFlight;
  }
  if (errorEl) {
    errorEl.hidden = !keywordOpportunityErrorMessage;
    errorEl.textContent = keywordOpportunityErrorMessage;
  }
  const introTextEl = document.getElementById("keywordOpportunityIntroText");
  if (introTextEl) {
    introTextEl.hidden = !!keywordOpportunityResult || keywordOpportunityInFlight;
  }
  if (resultEl) {
    resultEl.innerHTML =
      keywordOpportunityInFlight && !keywordOpportunityResult
        ? renderKeywordStrategyLoadingState({
            title: "正在判断赛道机会",
            meta:
              "正在采集主词样本并生成内容机会判断，通常需要 1-2 分钟",
          })
        : renderKeywordOpportunityResult();
  }
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
        onSampleCaptured([...samples], normalizedSample);
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
  if (!keywordOpportunityInFlight) {
    return;
  }
  keywordOpportunityCancelRequested = true;
  await requestCaptureCancelSignal();
  showProgress("正在停止判断赛道机会...", "warning");
}

async function handleCancelBenchmarkDiscovery() {
  if (!keywordBenchmarkInFlight) {
    return;
  }
  keywordBenchmarkCancelRequested = true;
  await requestCaptureCancelSignal();
  showProgress("正在停止找对标账号...", "warning");
}

async function captureBenchmarkCandidateProfiles({
  sourceTabId,
  sourceTabUrl,
  candidates = [],
  shouldStop = null,
}) {
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
  if (keywordBenchmarkInFlight || keywordOpportunityInFlight) {
    showMessage("赛道策略分析进行中，请稍候", "warning");
    return;
  }

  keywordStrategyPanelVisible = true;
  keywordStrategyActiveTab = "benchmark";
  keywordBenchmarkInFlight = true;
  keywordBenchmarkCancelRequested = false;
  keywordBenchmarkStartedAt = Date.now();
  keywordBenchmarkErrorMessage = "";
  keywordBenchmarkResult = null;
  keywordBenchmarkAnalysisStatus = "loading";
  keywordBenchmarkLoadingTitle = "正在查找候选账号";
  keywordBenchmarkLoadingMeta =
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
    if (keywordBenchmarkCancelRequested) {
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
    if (keywordBenchmarkCancelRequested) {
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
      keywordBenchmarkResult = result;
      keywordBenchmarkErrorMessage = "";
      keywordBenchmarkAnalysisStatus = "success";
      keywordBenchmarkLoadingTitle = "";
      keywordBenchmarkLoadingMeta = "";
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
      shouldStop: () => keywordBenchmarkCancelRequested,
    });
    if (keywordBenchmarkCancelRequested) {
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
    keywordBenchmarkResult = result;
    keywordBenchmarkErrorMessage = "";
    keywordBenchmarkAnalysisStatus = "success";
    keywordBenchmarkLoadingTitle = "";
    keywordBenchmarkLoadingMeta = "";
    renderKeywordStrategyPanel();

    showMessage(`已发现 ${result.candidateCount} 个候选对标账号`, "success");
  } catch (error) {
    const message =
      error?.message || "找对标账号失败，请稍后重试";
    keywordBenchmarkErrorMessage = message;
    keywordBenchmarkAnalysisStatus = "error";
    keywordBenchmarkLoadingTitle = "";
    keywordBenchmarkLoadingMeta = "";
    taskStatus = "failed";
    taskError = error;
    showMessage(message, "warning");
    renderKeywordStrategyPanel();
  } finally {
    keywordBenchmarkInFlight = false;
    keywordBenchmarkStartedAt = 0;
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        platform: pagePlatform,
        keyword,
        candidateCount: keywordBenchmarkResult?.candidateCount || 0,
        aiStatus: keywordBenchmarkResult?.aiStatus || "unknown",
        aiError: keywordBenchmarkResult?.aiError || "",
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
  if (keywordOpportunityInFlight) {
    showMessage("赛道策略分析进行中，请稍候", "warning");
    return;
  }

  keywordStrategyPanelVisible = true;
  keywordStrategyActiveTab = "opportunity";
  keywordOpportunityInFlight = true;
  keywordOpportunityCancelRequested = false;
  keywordOpportunityStartedAt = Date.now();
  keywordOpportunityErrorMessage = "";
  keywordOpportunityResult = null;
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
      shouldStop: () => keywordOpportunityCancelRequested,
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

    keywordOpportunityResult = response.data;
    keywordOpportunityResult._listItems = listItems;
    keywordOpportunityResult._representativeSamples = representativeSamples;
    keywordOpportunityErrorMessage = "";
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
      keywordOpportunityErrorMessage = "";
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
      keywordOpportunityErrorMessage = message;
      showMessage(message, "warning");
    }
    renderKeywordStrategyPanel();
  } finally {
    keywordOpportunityInFlight = false;
    keywordOpportunityStartedAt = 0;
    hideProgress();
    renderKeywordStrategyPanel();
  }
}

function handleOpenKeywordLongtail() {
  const currentKeyword = getCurrentSearchKeyword(getCurrentRuntime());
  syncSeedKeywordFromCurrentSearch(currentKeyword, {autoFillOnly: true});
  keywordStrategyPanelVisible = true;
  setKeywordStrategyTab("longtail");
}

function handleBenchmarkDiscoveryResultActions(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const actionTarget = target.closest("[data-action]");
  const action = actionTarget?.dataset?.action || "";
  const url = String(actionTarget?.dataset?.url || "").trim();

  if (action === "copy-benchmark") {
    handleCopyBenchmarkDiscovery(actionTarget);
    return;
  }

  if (action === "share-benchmark-as-image") {
    handleShareBenchmarkDiscoveryAsImage();
    return;
  }

  if (action === "open-benchmark-profile") {
    if (!url) {
      showMessage("暂未找到可打开的链接", "warning");
      return;
    }
    chrome.tabs.create({url}).catch((error) => {
      console.warn("[Sidebar] Open benchmark url failed:", error);
      showMessage("打开链接失败，请稍后重试", "warning");
    });
    return;
  }

  if (action === "monitor-benchmark-account") {
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
      bloggerNameSnapshot: String(actionTarget?.dataset?.name || "").trim(),
      bloggerUrl: url,
      bloggerAvatarSnapshot: "",
    }).catch((error) => {
      showMessage(`纳入监控失败：${error.message}`, "error");
    });
  }
}

function buildBenchmarkDiscoveryCandidateEvidence(candidate) {
  const profile = candidate?.profile || null;
  const followersCount = Number(profile?.followersCount) || 0;
  const maxLikes = Number(candidate?.maxLikes) || 0;
  const likeFollowerRatio =
    followersCount > 0 && maxLikes > 0 ? maxLikes / followersCount : 0;
  const evidenceItems = [
    `样本出现 ${Number(candidate?.occurrenceCount) || 0} 次，最高赞 ${formatOpportunityMetric(maxLikes)}，均赞 ${formatOpportunityMetric(candidate?.averageLikes)}`,
  ];
  if (followersCount > 0) {
    evidenceItems.push(
      likeFollowerRatio >= 0.1
        ? `粉丝 ${formatOpportunityMetric(followersCount)}，最高赞约为粉丝数 ${Math.max(1, Math.round(likeFollowerRatio * 10) / 10)} 倍，有低粉高表现信号`
        : `粉丝 ${formatOpportunityMetric(followersCount)}，可结合代表内容判断是否适合普通账号学习`,
    );
  }
  if (Number(profile?.likedAndCollectedCount) > 0) {
    evidenceItems.push(
      `主页累计赞藏 ${formatOpportunityMetric(profile.likedAndCollectedCount)}`,
    );
  }
  return evidenceItems;
}

function buildBenchmarkDiscoveryRepresentativeWorks(candidate, limit = 3) {
  return (Array.isArray(candidate?.topItems) ? candidate.topItems : [])
    .map((item) => ({
      title: String(item?.title || "").trim(),
      url: String(item?.url || "").trim(),
      likes: Number(item?.likes) || 0,
      collects: Number(item?.collects) || 0,
    }))
    .filter((item) => item.title)
    .slice(0, limit);
}

function buildBenchmarkDiscoveryShareText() {
  const result = keywordBenchmarkResult;
  if (!result) {
    return "";
  }
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const lines = [
    `【找对标账号】${String(result.keyword || "").trim()}`,
    `从 ${Number(result.sampleCount) || 0} 条搜索结果中筛出 ${Number(result.candidateCount) || 0} 个候选账号，入围门槛为样本出现 ${Number(result.minOccurrence) || 2} 次。`,
  ];

  candidates.slice(0, 5).forEach((candidate, index) => {
    const profile = candidate.profile || null;
    const analysis =
      candidate.analysis || buildBenchmarkDiscoveryFallbackAnalysis(candidate);
    const name =
      String(profile?.bloggerName || candidate.authorName || "").trim() ||
      `候选账号 ${index + 1}`;
    const works = buildBenchmarkDiscoveryRepresentativeWorks(candidate, 3);
    lines.push("");
    lines.push(`${index + 1}. ${name}`);
    if (analysis.recommendationReason) {
      lines.push(String(analysis.recommendationReason).trim());
    }
    if (analysis.focusAssessment) {
      lines.push(`判断依据：${String(analysis.focusAssessment).trim()}`);
    }
    buildBenchmarkDiscoveryCandidateEvidence(candidate).forEach((item) => {
      lines.push(`- ${item}`);
    });
    if (works.length > 0) {
      lines.push("代表作品：");
      works.forEach((work) => {
        lines.push(
          `- ${work.title}（赞 ${formatOpportunityMetric(work.likes)}）${work.url ? ` ${work.url}` : ""}`,
        );
      });
    }
    if (candidate.authorProfileUrl) {
      lines.push(`主页：${candidate.authorProfileUrl}`);
    }
  });

  return lines.join("\n").trim();
}

function handleCopyBenchmarkDiscovery(btn) {
  const text = buildBenchmarkDiscoveryShareText();
  if (!text || !btn) {
    showMessage("暂无对标账号结果可复制", "warning");
    return;
  }

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const original = btn.innerHTML;
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
      setTimeout(() => {
        btn.innerHTML = original;
      }, 1500);
    })
    .catch(() => {
      showMessage("复制失败，请稍后重试", "error");
    });
}

function buildBenchmarkDiscoveryShareData() {
  const result = keywordBenchmarkResult;
  if (!result) {
    return null;
  }
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  return {
    keyword: String(result.keyword || "").trim(),
    sampleCount: Number(result.sampleCount) || 0,
    candidateCount: Number(result.candidateCount) || 0,
    minOccurrence: Number(result.minOccurrence) || 2,
    candidates: candidates.slice(0, 4).map((candidate, index) => {
      const profile = candidate.profile || null;
      const analysis =
        candidate.analysis || buildBenchmarkDiscoveryFallbackAnalysis(candidate);
      return {
        rank: index + 1,
        name:
          String(profile?.bloggerName || candidate.authorName || "").trim() ||
          `候选账号 ${index + 1}`,
        recommendationReason: String(
          analysis.recommendationReason || "",
        ).trim(),
        focusAssessment: String(analysis.focusAssessment || "").trim(),
        growthPotential: String(analysis.growthPotential || "medium").trim(),
        tags: Array.isArray(analysis.tags)
          ? analysis.tags.filter(Boolean).slice(0, 4).map((item) => String(item))
          : [],
        evidence: buildBenchmarkDiscoveryCandidateEvidence(candidate),
        works: buildBenchmarkDiscoveryRepresentativeWorks(candidate, 2),
      };
    }),
    ts: Date.now(),
  };
}

function handleShareBenchmarkDiscoveryAsImage() {
  const data = buildBenchmarkDiscoveryShareData();
  if (!data) {
    showMessage("暂无对标账号结果可分享", "warning");
    return;
  }
  renderBenchmarkDiscoveryCardToImage(data);
}

function handleKeywordOpportunityResultActions(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const action =
    target.dataset?.action ||
    target.closest("[data-action]")?.dataset?.action ||
    "";

  if (action === "copy-opportunity") {
    handleCopyKeywordOpportunity(target.closest("[data-action]"));
    return;
  }
  if (action === "share-opportunity-as-image") {
    handleShareKeywordOpportunityAsImage();
    return;
  }
}

function handleCopyKeywordOpportunity(btn) {
  const text = buildKeywordOpportunityShareText();
  if (!text || !btn) {
    return;
  }

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const original = btn.innerHTML;
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
      setTimeout(() => {
        btn.innerHTML = original;
      }, 1500);
    })
    .catch(() => {});
}

function buildKeywordOpportunityShareText() {
  const result = keywordOpportunityResult;
  if (!result) {
    return "";
  }

  const topicDirections = Array.isArray(result.hotTopicDirections)
    ? result.hotTopicDirections
    : [];
  const recommendedAngles = Array.isArray(result.recommendedAngles)
    ? result.recommendedAngles
    : [];
  const subtopics = Array.isArray(result.coreWinningSubtopics)
    ? result.coreWinningSubtopics
    : [];
  const ruleMetrics = result.ruleMetrics || {};
  const metrics = [
    `热度：${ruleMetrics.heatLevel === "high" ? "高" : ruleMetrics.heatLevel === "medium" ? "中" : "低"}`,
    `高位区间：${
      ruleMetrics.highBandEnd > 0
        ? `${ruleMetrics.highBandStart}-${ruleMetrics.highBandEnd}`
        : "未识别"
    }`,
    `断层跌幅：${
      ruleMetrics.cliffDropRatio > 0
        ? `${Math.round(ruleMetrics.cliffDropRatio * 100)}%`
        : "不明显"
    }`,
    `高位均赞：${formatOpportunityMetric(ruleMetrics.highBandAvgLikes)}`,
    `中位赞：${formatOpportunityMetric(ruleMetrics.medianLikes)}`,
  ];

  const lines = [
    `【判断赛道机会】${String(result.keyword || "").trim()}`,
  ];
  if (result.distributionSummary) {
    lines.push(`分布：${String(result.distributionSummary).trim()}`);
  }
  lines.push(`指标：${metrics.join("｜")}`);

  if (subtopics.length > 0) {
    lines.push("");
    lines.push("【核心爆款细分词】");
    lines.push(subtopics.join("、"));
  }

  if (topicDirections.length > 0) {
    lines.push("");
    lines.push("【爆款主题方向】");
    const bandLabels = {
      high: "高赞区",
      mid: "中赞区",
      low: "低赞区",
      high_mid: "高赞区+中赞区",
      mid_low: "中赞区+低赞区",
      all: "高赞区+中赞区+低赞区",
    };
    topicDirections.forEach((direction, index) => {
      const name = String(direction?.name || "").trim() || `方向 ${index + 1}`;
      const sampleCount = Number(direction?.sampleCount) || 0;
      const shareRatio = `${Math.round((Number(direction?.shareRatio) || 0) * 100)}%`;
      const bandLabel = bandLabels[direction?.bandPresence] || "";
      const titles = Array.isArray(direction?.representativeTitles)
        ? direction.representativeTitles.filter(Boolean)
        : [];
      lines.push(
        `${index + 1}. ${name}${bandLabel ? `【${bandLabel}】` : ""}｜${sampleCount} 篇｜占比 ${shareRatio}`,
      );
      if (direction?.whyItWorks) {
        lines.push(String(direction.whyItWorks).trim());
      }
      if (titles.length > 0) {
        titles.forEach((t) => lines.push(`  · ${String(t).trim()}`));
      }
    });
  }

  if (recommendedAngles.length > 0) {
    lines.push("");
    lines.push("【新号优先选题】");
    recommendedAngles.forEach((angle, index) => {
      lines.push(
        `${index + 1}. ${String(angle?.title || "").trim() || `选题 ${index + 1}`}`,
      );
      if (angle?.audiencePainPoint) {
        lines.push(`  ${String(angle.audiencePainPoint).trim()}`);
      }
      if (angle?.formatSuggestion) {
        lines.push(`  形式建议：${String(angle.formatSuggestion).trim()}`);
      }
      if (angle?.executionHint) {
        lines.push(`  执行提示：${String(angle.executionHint).trim()}`);
      }
    });
  }

  return lines.join("\n").trim();
}

function buildKeywordOpportunityShareData() {
  const result = keywordOpportunityResult;
  if (!result) {
    return null;
  }

  const ruleMetrics = result.ruleMetrics || {};
  return {
    keyword: String(result.keyword || "").trim(),
    distributionSummary: String(result.distributionSummary || "").trim(),
    metrics: [
      {
        label: "热度",
        value:
          ruleMetrics.heatLevel === "high"
            ? "高"
            : ruleMetrics.heatLevel === "medium"
              ? "中"
              : "低",
      },
      {
        label: "高位区间",
        value:
          ruleMetrics.highBandEnd > 0
            ? `${ruleMetrics.highBandStart}-${ruleMetrics.highBandEnd}`
            : "未识别",
      },
      {
        label: "断层跌幅",
        value:
          ruleMetrics.cliffDropRatio > 0
            ? `${Math.round(ruleMetrics.cliffDropRatio * 100)}%`
            : "不明显",
      },
      {
        label: "高位均赞",
        value: formatOpportunityMetric(ruleMetrics.highBandAvgLikes),
      },
      {
        label: "中位赞",
        value: formatOpportunityMetric(ruleMetrics.medianLikes),
      },
    ],
    subtopics: Array.isArray(result.coreWinningSubtopics)
      ? result.coreWinningSubtopics.filter(Boolean).map((item) => String(item))
      : [],
    directions: Array.isArray(result.hotTopicDirections)
      ? result.hotTopicDirections.map((direction) => ({
          name: String(direction?.name || "").trim(),
          shareRatio: Math.round((Number(direction?.shareRatio) || 0) * 100),
          sampleCount: Number(direction?.sampleCount) || 0,
          whyItWorks: String(direction?.whyItWorks || "").trim(),
          bandPresence: String(direction?.bandPresence || "all").trim(),
        }))
      : [],
    angles: Array.isArray(result.recommendedAngles)
      ? result.recommendedAngles.map((angle) => ({
          title: String(angle?.title || "").trim(),
          audiencePainPoint: String(angle?.audiencePainPoint || "").trim(),
          formatSuggestion: String(angle?.formatSuggestion || "").trim(),
          executionHint: String(angle?.executionHint || "").trim(),
        }))
      : [],
    ts: Date.now(),
  };
}

function handleShareKeywordOpportunityAsImage() {
  const data = buildKeywordOpportunityShareData();
  if (!data) {
    showMessage("暂无判断赛道机会结果可分享", "warning");
    return;
  }
  renderKeywordOpportunityCardToImage(data);
}

// ==================== 关键词裂变 ====================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSelectedRecommendedKeywords(draft = getKeywordInsightState()) {
  return Array.isArray(draft.selectedKeywords)
    ? [...draft.selectedKeywords]
    : [];
}

function invalidateKeywordInsightDraft(platform = "") {
  keywordInsightRunToken += 1;
  keywordAnalysisInFlight = false;
  keywordAnalysisStartedAt = 0;
  keywordInsightSampleInFlight = false;
  const currentDraft = getBatchDraftForPlatform(platform);
  updateKeywordInsightState(
    {
      ...createEmptyKeywordInsightState(),
      analysisVersion: (currentDraft.analysisVersion || 0) + 1,
    },
    platform,
  );
}

function toggleExpandedKeywordsVisibility() {
  expandedKeywordsPanelVisible = !expandedKeywordsPanelVisible;
  renderExpandedKeywords();
  if (expandedKeywordsPanelVisible) {
    document
      .getElementById("expandedKeywordsPanel")
      ?.scrollIntoView({behavior: "smooth", block: "nearest"});
  }
}

function renderExpandedKeywords() {
  const panel = document.getElementById("expandedKeywordsPanel");
  const countEl = document.getElementById("expandedKeywordsCount");
  const textarea = document.getElementById("textareaExpandedKeywords");
  const btnView = document.getElementById("btnViewExpandedKeywords");
  const btnClear = document.getElementById("btnClearKeywordInsightResult");
  const introEl = document.getElementById("keywordInsightIntro");
  const btnHeaderRun = document.getElementById("btnExpandKeywords");
  const btnIntroRun = document.getElementById("btnRunKeywordInsight");
  const actionRowEl = document.getElementById("keywordInsightActionRow");

  if (!panel) return;

  const hasKeywords = expandedKeywordsBuffer.length > 0;
  panel.hidden = !hasKeywords || !expandedKeywordsPanelVisible;
  if (introEl) {
    introEl.hidden = hasKeywords;
  }

  if (countEl) {
    countEl.textContent = `扩展词: ${expandedKeywordsBuffer.length} 词`;
  }

  if (btnView) {
    btnView.hidden = !hasKeywords;
    btnView.textContent = expandedKeywordsPanelVisible
      ? "收起扩展词"
      : `查看全部扩展词 (${expandedKeywordsBuffer.length})`;
  }
  if (btnClear) {
    btnClear.hidden = !hasKeywords;
  }
  if (btnHeaderRun) {
    btnHeaderRun.hidden = !hasKeywords;
  }
  if (btnIntroRun) {
    btnIntroRun.hidden = hasKeywords;
  }
  if (actionRowEl) {
    actionRowEl.classList.toggle("is-result-mode", hasKeywords);
  }

  if (textarea) {
    const nextValue = expandedKeywordsBuffer.join("\n");
    if (textarea.value !== nextValue) {
      textarea.value = nextValue;
    }
  }
}

function updateExpandedKeywordsSummary() {
  renderExpandedKeywords();
}

function clearKeywordInsightResult({showFeedback = true} = {}) {
  const hasAnything = expandedKeywordsBuffer.length > 0;
  if (!hasAnything) {
    return;
  }

  expandedKeywordsBuffer = [];
  expandedKeywordsPanelVisible = false;
  invalidateKeywordInsightDraft();
  renderKeywordInsightState();
  persistCurrentBatchDraft();
  updateExpandKeywordsButtonState();
  if (showFeedback) {
    showMessage("已清空扩展词和分析结果", "success");
  }
}

function renderInsightLoadingState() {
  return `
    <div class="keyword-insight-summary-card is-loading">
      <div class="keyword-insight-summary-title">
        <span class="keyword-insight-loading-spinner" aria-hidden="true"></span>
        正在分析需求方向
      </div>
      <div class="keyword-insight-summary-meta">已扩展 ${expandedKeywordsBuffer.length} 个关键词，通常需要 1-2 分钟</div>
    </div>
  `;
}

function renderInsightSummaryCard(draft) {
  const analysis = draft.analysisResult;
  if (!analysis) {
    return "";
  }

  const categoryCount = Array.isArray(analysis.categories)
    ? analysis.categories.length
    : 0;
  const selectedKeywords = getSelectedRecommendedKeywords(draft);
  return `
    <div class="keyword-insight-summary-card">
      <div class="keyword-insight-summary-header">
        <div class="keyword-insight-summary-title">需求洞察</div>
        <div class="keyword-insight-share-wrap">
          <button type="button" class="keyword-insight-share-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
            去分享
          </button>
          <div class="keyword-insight-share-menu">
            <div class="keyword-insight-share-menu-inner">
              <button type="button" class="keyword-insight-share-menu-item" data-action="copy-insight">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                复制文本
              </button>
              <button type="button" class="keyword-insight-share-menu-item" data-action="share-as-image">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                分享图片
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="keyword-insight-summary-meta">共 ${expandedKeywordsBuffer.length} 词 · ${categoryCount} 个方向 · 已选 ${selectedKeywords.length}/10 个词采集</div>
      <div class="keyword-insight-summary-text">${escapeHtml(analysis.summary || "")}</div>
    </div>
  `;
}

function renderInsightSampleBlock(sampleStatus, sampleResult) {
  if (sampleStatus === "loading") {
    return `<div class="keyword-insight-sample-hint">正在抓取该方向样本...</div>`;
  }
  if (sampleStatus === "error") {
    return `<div class="keyword-insight-sample-hint is-error">${escapeHtml(sampleResult?.errorMessage || "样本获取失败，可重试分析后再次查看")}</div>`;
  }
  const samples = Array.isArray(sampleResult?.samples)
    ? sampleResult.samples
    : [];
  if (samples.length === 0) {
    return `<div class="keyword-insight-sample-hint">暂无样本</div>`;
  }

  const sourceLabel = sampleResult?.usedKeyword
    ? `<div class="keyword-insight-sample-source">样本来自：${escapeHtml(sampleResult.usedKeyword)}</div>`
    : "";
  const itemsHtml = samples
    .map((sample) => {
      const title = escapeHtml(sample?.title || "未命名样本");
      const author = escapeHtml(sample?.author || "未知作者");
      const likes = Number(sample?.likes) || 0;
      const titleHtml = sample?.url
        ? `<a href="${escapeHtml(sample.url)}" target="_blank" style="color: inherit; text-decoration: underline;">${title}</a>`
        : `<span class="sample-title">${title}</span>`;
      return `<li>${titleHtml}<span class="sample-meta">${author} · ❤️ ${likes}</span></li>`;
    })
    .join("");
  return `${sourceLabel}<ul class="keyword-insight-sample-list">${itemsHtml}</ul>`;
}

function renderInsightCategories(draft) {
  const analysis = draft.analysisResult;
  const categories = Array.isArray(analysis?.categories)
    ? analysis.categories
    : [];
  const selectedKeywordSet = new Set(draft.selectedKeywords || []);

  if (categories.length === 0) {
    return "";
  }

  const totalKeywords = expandedKeywordsBuffer.length || 1;

  return categories
    .map((category) => {
      const categoryId = String(category?.id || "").trim();
      const isExpanded = expandedKeywordInsightCategoryIds.has(categoryId);
      const sampleStatus =
        draft.sampleStatusByCategoryId?.[categoryId] || "idle";
      const sampleResult =
        draft.sampleResultsByCategoryId?.[categoryId] || null;
      const keywordList = Array.isArray(category?.keywords)
        ? category.keywords
        : [];
      const pct = Math.round((keywordList.length / totalKeywords) * 100);

      return `
        <article class="keyword-insight-category-card">
          <div class="keyword-insight-category-head">
            <span class="keyword-insight-category-title">${escapeHtml(category?.icon || "📌")} ${escapeHtml(category?.name || "未命名方向")}</span>
            <button type="button" class="btn-text" data-action="toggle-expand-category" data-category-id="${escapeHtml(categoryId)}">
              ${isExpanded ? "收起" : "展开"}
            </button>
          </div>
          <div class="keyword-insight-category-meta">
            <span>${keywordList.length} 词</span>
            <span class="keyword-density-pct">${pct}%</span>
            <span class="keyword-density-bar-wrap"><span class="keyword-density-bar-fill" style="width:${Math.min(pct, 100)}%"></span></span>
          </div>
          <div class="keyword-insight-category-insight">${escapeHtml(category?.insight || "")}</div>
          <div class="keyword-insight-category-samples">
            ${renderInsightSampleBlock(sampleStatus, sampleResult)}
          </div>
          ${
            isExpanded
              ? `<div class="keyword-insight-keywords">${keywordList
                  .map((keyword) => {
                    return `<span class="keyword-chip" data-action="toggle-keyword" data-keyword="${escapeHtml(keyword)}" title="点击复制">${escapeHtml(keyword)}</span>`;
                  })
                  .join("")}</div>`
              : ""
          }
        </article>
      `;
    })
    .join("");
}

function renderKeywordInsightState() {
  const draft = getKeywordInsightState();
  const insightContainer = document.getElementById("keywordInsightContainer");
  const summaryEl = document.getElementById("keywordInsightSummary");
  const categoriesEl = document.getElementById("keywordInsightCategories");
  const errorEl = document.getElementById("keywordInsightError");
  const errorMessageEl = document.getElementById("keywordInsightErrorMessage");
  const btnRetry = document.getElementById("btnRetryKeywordAnalysis");
  const btnCapture = document.getElementById("btnInsightBatchCapture");
  const introEl = document.getElementById("keywordInsightIntro");

  renderExpandedKeywords();

  if (
    !insightContainer ||
    !summaryEl ||
    !categoriesEl ||
    !errorEl
  ) {
    return;
  }

  const hasKeywords = expandedKeywordsBuffer.length > 0;
  const analysisStatus = draft.analysisStatus || "idle";
  insightContainer.hidden = !hasKeywords;
  if (introEl) {
    introEl.hidden = hasKeywords;
  }

  if (!hasKeywords) {
    summaryEl.innerHTML = "";
    categoriesEl.innerHTML = "";
    errorEl.hidden = true;
    return;
  }

  if (analysisStatus === "loading") {
    summaryEl.innerHTML = renderInsightLoadingState();
    categoriesEl.innerHTML = "";
    errorEl.hidden = true;
    if (btnRetry) {
      btnRetry.disabled = true;
    }
    return;
  }

  if (analysisStatus === "error") {
    summaryEl.innerHTML = "";
    categoriesEl.innerHTML = "";
    errorEl.hidden = false;
    if (errorMessageEl) {
      errorMessageEl.textContent =
        draft.analysisErrorMessage ||
        "当前智能分析暂时不可用，已保留扩展词，可稍后重试或先查看扩展词。";
    }
    if (btnRetry) {
      btnRetry.disabled =
        keywordAnalysisInFlight && !isKeywordAnalysisLockStale();
    }
    return;
  }

  if (analysisStatus === "success" && draft.analysisResult) {
    summaryEl.innerHTML = renderInsightSummaryCard(draft);
    categoriesEl.innerHTML = renderInsightCategories(draft);
    errorEl.hidden = true;
    return;
  }

  summaryEl.innerHTML = "";
  categoriesEl.innerHTML = "";
  errorEl.hidden = true;
  btnCapture.hidden = true;
}

function isKeywordAnalysisLockStale() {
  if (!keywordAnalysisInFlight || keywordAnalysisStartedAt <= 0) {
    return false;
  }
  return Date.now() - keywordAnalysisStartedAt > KEYWORD_ANALYSIS_STALE_LOCK_MS;
}

function releaseKeywordAnalysisLock() {
  keywordAnalysisInFlight = false;
  keywordAnalysisStartedAt = 0;
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

  keywordInsightSampleInFlight = true;
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
        if (runToken !== keywordInsightRunToken) {
          return;
        }
        if (progress?.phase === "category_done" && progress?.result) {
          updateCategorySampleResult(progress.categoryId, progress.result);
        }
      },
      shouldStop: () => runToken !== keywordInsightRunToken,
    });
  } catch (error) {
    console.warn("[Sidebar] Keyword insight sampling failed:", error);
  } finally {
    if (runToken === keywordInsightRunToken) {
      keywordInsightSampleInFlight = false;
      renderKeywordInsightState();
    }
  }
}

async function startKeywordAnalysis({force = false} = {}) {
  if (keywordAnalysisInFlight) {
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
  if (expandedKeywordsBuffer.length === 0) {
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

  keywordAnalysisInFlight = true;
  keywordAnalysisStartedAt = Date.now();
  keywordInsightRunToken += 1;
  const runToken = keywordInsightRunToken;

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
      expandedKeywordsBuffer
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    );
    const dedupedCount =
      expandedKeywordsBuffer.length - analysisKeywords.length;
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
    if (runToken !== keywordInsightRunToken) {
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

    if (runToken === keywordInsightRunToken) {
      await runKeywordInsightSampling({
        analysisResult,
        baseSearchUrl,
        runToken,
      });
    }
  } catch (error) {
    if (runToken !== keywordInsightRunToken) {
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
    if (runToken === keywordInsightRunToken) {
      releaseKeywordAnalysisLock();
      renderKeywordInsightState();
    }
  }
}

async function retryKeywordAnalysis() {
  if (keywordAnalysisInFlight && !isKeywordAnalysisLockStale()) {
    showMessage("智能分析进行中，请稍候", "warning");
    return;
  }
  if (keywordAnalysisInFlight && isKeywordAnalysisLockStale()) {
    releaseKeywordAnalysisLock();
  }
  await startKeywordAnalysis({force: true});
}

function handleKeywordInsightSummaryActions(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const actionEl = target.closest("[data-action]");
  const action = actionEl?.dataset?.action || "";

  if (action === "copy-insight") {
    handleCopyInsight(actionEl);
    return;
  }
  if (action === "share-as-image") {
    handleShareAsImage();
    return;
  }
}

function handleCopyInsight(btn) {
  const draft = getKeywordInsightState();
  const analysis = draft.analysisResult;
  if (!analysis || !btn) return;

  const lines = [];
  const summary = String(analysis.summary || "").trim();
  if (summary) {
    lines.push("【需求洞察】");
    lines.push(summary);
  }
  const categories = Array.isArray(analysis.categories)
    ? analysis.categories
    : [];
  for (const category of categories) {
    const name = String(category?.name || "").trim();
    const icon = String(category?.icon || "").trim();
    const insight = String(category?.insight || "").trim();
    const keywords = Array.isArray(category?.keywords) ? category.keywords : [];
    lines.push("");
    lines.push(`${icon} ${name}`.trim());
    if (insight) lines.push(insight);
    if (keywords.length > 0) lines.push(keywords.join("、"));
  }

  const text = lines.join("\n").trim();
  if (!text) return;

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const original = btn.innerHTML;
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
      setTimeout(() => {
        btn.innerHTML = original;
      }, 1500);
    })
    .catch(() => {});
}

function buildInsightShareData() {
  const draft = getKeywordInsightState();
  const batchDraft = getBatchDraftForPlatform();
  const analysis = draft.analysisResult;
  if (!analysis) return null;
  const categories = Array.isArray(analysis.categories)
    ? analysis.categories
    : [];
  return {
    seedKeyword: batchDraft.seedKeyword || "",
    totalKeywords: expandedKeywordsBuffer.length,
    summary: analysis.summary || "",
    categories: categories.map((cat) => {
      const result = {
        id: cat.id || "",
        icon: cat.icon || "",
        name: cat.name || "",
        insight: cat.insight || "",
        keywords: Array.isArray(cat.keywords) ? cat.keywords : [],
      };
      const sampleResult = draft.sampleResultsByCategoryId?.[cat.id];
      if (sampleResult?.samples?.length) {
        result.sampleKeyword = sampleResult.usedKeyword || "";
        result.samples = sampleResult.samples.map((s) => ({
          title: s.title || "",
          author: s.author || "",
          likes: s.likes || 0,
        }));
      }
      return result;
    }),
    ts: Date.now(),
  };
}

function handleShareAsImage() {
  const data = buildInsightShareData();
  if (!data) {
    showMessage("暂无洞察结果可分享", "warning");
    return;
  }

  renderInsightCardToImage(data);
}

function renderInsightCardToImage(data) {
  const dpr = window.devicePixelRatio || 2;
  const W = 640;
  const PAD = 32;
  const CONTENT_W = W - PAD * 2;

  const catColors = [
    {
      accent: "#4F8BF5",
      light: "#eef3ff",
      chip: "#dbeafe",
      chipText: "#2563eb",
      bar: ["#4F8BF5", "#93bbfd"],
    },
    {
      accent: "#8B5CF6",
      light: "#f0eeff",
      chip: "#ede9fe",
      chipText: "#6d28d9",
      bar: ["#8B5CF6", "#c4b5fd"],
    },
    {
      accent: "#EC4899",
      light: "#fdf2f8",
      chip: "#fce7f3",
      chipText: "#be185d",
      bar: ["#EC4899", "#f9a8d4"],
    },
    {
      accent: "#F97316",
      light: "#fff7ed",
      chip: "#ffedd5",
      chipText: "#c2410c",
      bar: ["#F97316", "#fdba74"],
    },
  ];

  const logoImg = new Image();
  logoImg.src = chrome.runtime.getURL("images/icon128.png");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.textBaseline = "top";

  function measureLines(text, fontSize, maxWidth) {
    ctx.font = `${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const words = text.split("");
    const lines = [];
    let currentLine = "";
    for (const char of words) {
      const test = currentLine + char;
      if (ctx.measureText(test).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }

  function preCalcHeight() {
    let h = 0;
    h += 100;
    const summaryLines = measureLines(data.summary || "", 14, CONTENT_W);
    h += 30 + summaryLines.length * 22 + 20;
    h += 24;
    for (const cat of data.categories) {
      h += 44;
      const insightLines = measureLines(cat.insight || "", 13, CONTENT_W - 24);
      h += insightLines.length * 20 + 8;
      const keywords = cat.keywords || [];
      if (keywords.length > 0) {
        let rowW = 0;
        let rows = 1;
        ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
        for (const kw of keywords) {
          const chipW = ctx.measureText(kw).width + 22;
          if (rowW + chipW + 6 > CONTENT_W - 24 && rowW > 0) {
            rows++;
            rowW = chipW + 6;
          } else {
            rowW += chipW + 6;
          }
        }
        h += rows * 28 + 10;
      }
      h += 16;
    }
    h += 36;
    return h;
  }

  function drawCard() {
    const H = preCalcHeight();
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.textBaseline = "top";

    const gradient = ctx.createLinearGradient(0, 0, W, H);
    gradient.addColorStop(0, "#f8f6ff");
    gradient.addColorStop(0.4, "#fdf2f8");
    gradient.addColorStop(0.7, "#eef3ff");
    gradient.addColorStop(1, "#fff7ed");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#ffffff";
    roundRect(ctx, 16, 16, W - 32, H - 32, 16);
    ctx.fill();
    ctx.save();
    ctx.shadowColor = "rgba(99,102,241,0.08)";
    ctx.shadowBlur = 24;
    ctx.restore();

    let y = 16;

    const headerH = 88;
    const hGrad = ctx.createLinearGradient(16, y, W - 16, y);
    hGrad.addColorStop(0, "#4F8BF5");
    hGrad.addColorStop(0.4, "#8B5CF6");
    hGrad.addColorStop(0.75, "#EC4899");
    hGrad.addColorStop(1, "#F43F5E");
    ctx.fillStyle = hGrad;
    roundRectTop(ctx, 16, y, W - 32, headerH, 16);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.2)";
    const seedText = `🔍 ${data.seedKeyword}`;
    ctx.font = `500 14px -apple-system, "PingFang SC", sans-serif`;
    const seedW = ctx.measureText(seedText).width + 24;
    roundRect(ctx, PAD, y + 16, seedW, 28, 14);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(seedText, PAD + 12, y + 22);

    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 20px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("关键词需求洞察", PAD, y + 56);

    const totalKw = data.categories.reduce(
      (s, c) => s + (c.keywords?.length || 0),
      0,
    );
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = `500 12px -apple-system, "PingFang SC", sans-serif`;
    const statsText = `${totalKw} 个关联词 · ${data.categories.length} 个需求方向`;
    const statsW = ctx.measureText(statsText).width;
    ctx.fillText(statsText, W - PAD - 16 - statsW, y + 60);

    y += headerH + 20;

    ctx.fillStyle = "#8B5CF6";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("洞察摘要", PAD, y);
    y += 20;

    ctx.fillStyle = "#374151";
    ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
    const summaryLines = measureLines(data.summary || "", 14, CONTENT_W);
    for (const line of summaryLines) {
      ctx.fillText(line, PAD, y);
      y += 22;
    }
    y += 16;

    ctx.fillStyle = "#EC4899";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("需求方向", PAD, y);
    y += 24;

    for (let ci = 0; ci < data.categories.length; ci++) {
      const cat = data.categories[ci];
      const cc = catColors[ci % catColors.length];
      const keywords = cat.keywords || [];
      const pct =
        totalKw > 0 ? Math.round((keywords.length / totalKw) * 100) : 0;

      ctx.fillStyle = "#1a1a2e";
      ctx.font = `600 14px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(`${cat.icon || "📌"} ${cat.name}`, PAD + 4, y);

      ctx.fillStyle = cc.accent;
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      const pctText = `${keywords.length} 词 · ${pct}%`;
      const pctW = ctx.measureText(pctText).width;
      ctx.fillText(pctText, W - PAD - 16 - pctW, y + 2);
      y += 22;

      ctx.fillStyle = "#f3f4f6";
      roundRect(ctx, PAD + 4, y, CONTENT_W - 8, 4, 2);
      ctx.fill();
      const barGrad = ctx.createLinearGradient(
        PAD + 4,
        y,
        PAD + 4 + (CONTENT_W - 8),
        y,
      );
      barGrad.addColorStop(0, cc.bar[0]);
      barGrad.addColorStop(1, cc.bar[1]);
      ctx.fillStyle = barGrad;
      roundRect(
        ctx,
        PAD + 4,
        y,
        Math.max(((CONTENT_W - 8) * pct) / 100, 2),
        4,
        2,
      );
      ctx.fill();
      y += 12;

      if (cat.insight) {
        ctx.fillStyle = "#6b7280";
        ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
        const insightLines = measureLines(cat.insight, 13, CONTENT_W - 24);
        for (const line of insightLines) {
          ctx.fillText(line, PAD + 12, y);
          y += 20;
        }
        y += 4;
      }

      if (keywords.length > 0) {
        let rowX = PAD + 12;
        ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
        for (const kw of keywords) {
          const chipW = ctx.measureText(kw).width + 22;
          if (rowX + chipW > W - PAD - 12 && rowX > PAD + 12) {
            rowX = PAD + 12;
            y += 28;
          }
          ctx.fillStyle = cc.chip;
          roundRect(ctx, rowX, y, chipW, 24, 12);
          ctx.fill();
          ctx.fillStyle = cc.chipText;
          ctx.fillText(kw, rowX + 11, y + 6);
          rowX += chipW + 6;
        }
        y += 34;
      }

      y += 8;
    }

    y += 8;
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(PAD, y, CONTENT_W, 0.5);
    y += 36;

    const logoSize = 16;
    const gap = 6;
    const brandText = "StarVoice 星语";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    const brandTW = ctx.measureText(brandText).width;
    const urlText = "https://voice.minilife.online";
    ctx.font = `500 10px -apple-system, "PingFang SC", sans-serif`;
    const urlTW = ctx.measureText(urlText).width;
    const pillPadX = 8;
    const pillPadY = 3;
    const pillW = urlTW + pillPadX * 2;
    const pillH = 16;
    const urlGap = 10;
    const line1W = logoSize + gap + brandTW + urlGap + pillW;
    const line1X = (W - line1W) / 2;

    ctx.globalAlpha = 0.8;
    if (logoImg.complete && logoImg.naturalWidth > 0) {
      ctx.save();
      roundRect(ctx, line1X, y - 1, logoSize, logoSize, 3);
      ctx.clip();
      ctx.drawImage(logoImg, line1X, y - 1, logoSize, logoSize);
      ctx.restore();
    }

    ctx.fillStyle = "#9ca3af";
    ctx.font = `500 11px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(brandText, line1X + logoSize + gap, y);

    const pillX = line1X + logoSize + gap + brandTW + urlGap;
    const pillY = y - 1;
    ctx.fillStyle = "#f5f3ff";
    roundRect(ctx, pillX, pillY, pillW, pillH, 8);
    ctx.fill();
    ctx.fillStyle = "#a78bfa";
    ctx.font = `400 10px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(urlText, pillX + pillPadX, pillY + pillPadY);

    y += 20;
    const features =
      "账号监控｜低粉爆款筛选｜搜索词洞察｜数据采集｜评论分析｜客资线索";
    ctx.fillStyle = "#c0c0c0";
    ctx.font = `400 9px -apple-system, "PingFang SC", sans-serif`;
    ctx.globalAlpha = 1.0;
    const featW = ctx.measureText(features).width;
    ctx.fillText(features, (W - featW) / 2, y);

    canvas.toBlob((blob) => {
      if (!blob) {
        showMessage("图片生成失败", "error");
        return;
      }
      showInsightImagePreview(blob, data.seedKeyword || "share");
    }, "image/png");
  }

  if (logoImg.complete) {
    drawCard();
  } else {
    logoImg.onload = drawCard;
    logoImg.onerror = drawCard;
  }
}

function renderKeywordOpportunityCardToImage(data) {
  const dpr = window.devicePixelRatio || 2;
  const W = 640;
  const PAD = 32;
  const CONTENT_W = W - PAD * 2;
  const logoImg = new Image();
  logoImg.src = chrome.runtime.getURL("images/icon128.png");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.textBaseline = "top";

  function measureLines(text, fontSize, maxWidth) {
    ctx.font = `${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const chars = String(text || "").split("");
    const lines = [];
    let currentLine = "";
    for (const char of chars) {
      const test = currentLine + char;
      if (ctx.measureText(test).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines;
  }

  function calcChipRows(items, maxWidth, baseX, gap = 6) {
    if (!Array.isArray(items) || items.length === 0) {
      return 0;
    }
    let rows = 1;
    let rowX = baseX;
    ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
    for (const item of items) {
      const text = String(item || "").trim();
      if (!text) continue;
      const chipW = ctx.measureText(text).width + 22;
      if (rowX + chipW > W - PAD - 12 && rowX > baseX) {
        rows += 1;
        rowX = baseX + chipW + gap;
      } else {
        rowX += chipW + gap;
      }
    }
    return rows;
  }

  function preCalcHeight() {
    let h = 0;
    h += 122;
    const distributionLines = measureLines(
      data.distributionSummary || "",
      14,
      CONTENT_W,
    );
    h += distributionLines.length * 22 + 30;
    h += Math.ceil((data.metrics.length || 0) / 2) * 82 + 22;
    h += 28;
    const subtopicRows = calcChipRows(data.subtopics || [], CONTENT_W, PAD);
    h += Math.max(subtopicRows, 1) * 30 + 24;
    h += 24;
    if (Array.isArray(data.directions) && data.directions.length > 0) {
      for (const direction of data.directions || []) {
        h += 52;
        const whyLines = measureLines(
          direction.whyItWorks || "",
          13,
          CONTENT_W - 24,
        );
        h += whyLines.length * 20 + 14;
      }
    } else {
      h += 34;
    }
    h += 24;
    if (Array.isArray(data.angles) && data.angles.length > 0) {
      for (const angle of data.angles || []) {
        const body = [
          directionSafeText(angle.audiencePainPoint),
          angle.formatSuggestion
            ? `形式建议：${directionSafeText(angle.formatSuggestion)}`
            : "",
          angle.executionHint
            ? `执行提示：${directionSafeText(angle.executionHint)}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const titleLines = measureLines(angle.title || "", 14, CONTENT_W - 24);
        const bodyLines = measureLines(body, 13, CONTENT_W - 24);
        h += 34 + titleLines.length * 20 + bodyLines.length * 19 + 18;
      }
    } else {
      h += 34;
    }
    h += 68;
    return h;
  }

  function directionSafeText(value) {
    return String(value || "").trim();
  }

  function drawCard() {
    const H = preCalcHeight();
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.textBaseline = "top";

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#fff8ef");
    bg.addColorStop(0.4, "#fffdf7");
    bg.addColorStop(0.75, "#f4f7ff");
    bg.addColorStop(1, "#eef9ff");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#ffffff";
    roundRect(ctx, 16, 16, W - 32, H - 32, 18);
    ctx.fill();

    let y = 16;
    const headerH = 104;
    const headerGrad = ctx.createLinearGradient(16, y, W - 16, y);
    headerGrad.addColorStop(0, "#F97316");
    headerGrad.addColorStop(0.55, "#F59E0B");
    headerGrad.addColorStop(1, "#FB7185");
    ctx.fillStyle = headerGrad;
    roundRectTop(ctx, 16, y, W - 32, headerH, 18);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.font = `500 14px -apple-system, "PingFang SC", sans-serif`;
    const keywordText = `主词 ${data.keyword || "未命名"}`;
    const keywordW = ctx.measureText(keywordText).width + 24;
    roundRect(ctx, PAD, y + 18, keywordW, 28, 14);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(keywordText, PAD + 12, y + 24);

    ctx.font = `bold 22px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("判断赛道机会", PAD, y + 58);

    y += headerH + 24;

    if (data.distributionSummary) {
      ctx.fillStyle = "#6b7280";
      ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
      const summaryLines = measureLines(
        data.distributionSummary,
        14,
        CONTENT_W,
      );
      for (const line of summaryLines) {
        ctx.fillText(line, PAD, y);
        y += 22;
      }
      y += 16;
    }

    const metricCols = 2;
    const metricGap = 12;
    const metricW = (CONTENT_W - metricGap) / metricCols;
    const metricH = 70;
    (data.metrics || []).forEach((metric, index) => {
      const col = index % metricCols;
      const row = Math.floor(index / metricCols);
      const x = PAD + col * (metricW + metricGap);
      const my = y + row * (metricH + 12);
      ctx.fillStyle = "#fff7ed";
      roundRect(ctx, x, my, metricW, metricH, 16);
      ctx.fill();
      ctx.fillStyle = "#9a3412";
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(metric.label || "", x + 16, my + 14);
      ctx.fillStyle = "#111827";
      ctx.font = `bold 18px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(metric.value || "-", x + 16, my + 34);
    });
    y +=
      Math.ceil((data.metrics.length || 0) / metricCols) * (metricH + 12) + 8;

    ctx.fillStyle = "#f59e0b";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("核心爆款细分词", PAD, y);
    y += 22;

    if (Array.isArray(data.subtopics) && data.subtopics.length > 0) {
      let rowX = PAD;
      ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
      for (const item of data.subtopics) {
        const text = String(item || "").trim();
        if (!text) continue;
        const chipW = ctx.measureText(text).width + 22;
        if (rowX + chipW > W - PAD && rowX > PAD) {
          rowX = PAD;
          y += 30;
        }
        ctx.fillStyle = "#ffedd5";
        roundRect(ctx, rowX, y, chipW, 24, 12);
        ctx.fill();
        ctx.fillStyle = "#c2410c";
        ctx.fillText(text, rowX + 11, y + 6);
        rowX += chipW + 6;
      }
      y += 34;
    } else {
      ctx.fillStyle = "#9ca3af";
      ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("暂无明确细分切口", PAD, y);
      y += 26;
    }

    ctx.fillStyle = "#ef4444";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("爆款主题方向", PAD, y);
    y += 24;

    if (Array.isArray(data.directions) && data.directions.length > 0) {
      for (const direction of data.directions || []) {
        ctx.fillStyle = "#fffaf5";
        roundRect(ctx, PAD, y, CONTENT_W, 72, 16);
        ctx.fill();
        ctx.fillStyle = "#111827";
        ctx.font = `600 14px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText(direction.name || "未命名方向", PAD + 14, y + 14);
        const metaText = `${direction.sampleCount || 0} 篇 · ${direction.shareRatio || 0}%`;
        ctx.fillStyle = "#f97316";
        ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
        const metaW = ctx.measureText(metaText).width;
        ctx.fillText(metaText, PAD + CONTENT_W - 14 - metaW, y + 16);
        const whyLines = measureLines(
          direction.whyItWorks || "",
          13,
          CONTENT_W - 28,
        );
        ctx.fillStyle = "#6b7280";
        ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
        let innerY = y + 38;
        for (const line of whyLines) {
          ctx.fillText(line, PAD + 14, innerY);
          innerY += 20;
        }
        y = Math.max(y + 72, innerY + 12);
      }
    } else {
      ctx.fillStyle = "#9ca3af";
      ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("当前样本中还没有稳定聚合出足够清晰的主题方向", PAD, y);
      y += 26;
    }

    y += 8;
    ctx.fillStyle = "#6366f1";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("新号优先选题", PAD, y);
    y += 24;

    if (Array.isArray(data.angles) && data.angles.length > 0) {
      for (const angle of data.angles || []) {
        const body = [
          directionSafeText(angle.audiencePainPoint),
          angle.formatSuggestion
            ? `形式建议：${directionSafeText(angle.formatSuggestion)}`
            : "",
          angle.executionHint
            ? `执行提示：${directionSafeText(angle.executionHint)}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const titleLines = measureLines(angle.title || "", 14, CONTENT_W - 28);
        const bodyLines = measureLines(body, 13, CONTENT_W - 28);
        const cardH =
          18 + titleLines.length * 20 + 8 + bodyLines.length * 19 + 16;
        ctx.fillStyle = "#f5f3ff";
        roundRect(ctx, PAD, y, CONTENT_W, cardH, 16);
        ctx.fill();
        ctx.fillStyle = "#312e81";
        ctx.font = `600 14px -apple-system, "PingFang SC", sans-serif`;
        let innerY = y + 14;
        for (const line of titleLines) {
          ctx.fillText(line, PAD + 14, innerY);
          innerY += 20;
        }
        ctx.fillStyle = "#5b5f97";
        ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
        innerY += 4;
        for (const line of bodyLines) {
          ctx.fillText(line, PAD + 14, innerY);
          innerY += 19;
        }
        y += cardH + 10;
      }
    } else {
      ctx.fillStyle = "#9ca3af";
      ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("当前还没有生成可直接执行的主词选题", PAD, y);
      y += 26;
    }

    y += 8;
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(PAD, y, CONTENT_W, 0.5);
    y += 18;

    const brandText = "StarVoice 星语";
    const urlText = "https://voice.minilife.online";
    const logoSize = 16;
    const gap = 6;
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    const brandW = ctx.measureText(brandText).width;
    ctx.font = `500 10px -apple-system, "PingFang SC", sans-serif`;
    const urlW = ctx.measureText(urlText).width;
    const pillW = urlW + 16;
    const lineW = logoSize + gap + brandW + 10 + pillW;
    const startX = (W - lineW) / 2;

    if (logoImg.complete && logoImg.naturalWidth > 0) {
      ctx.save();
      roundRect(ctx, startX, y - 1, logoSize, logoSize, 3);
      ctx.clip();
      ctx.drawImage(logoImg, startX, y - 1, logoSize, logoSize);
      ctx.restore();
    }
    ctx.fillStyle = "#9ca3af";
    ctx.font = `500 11px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(brandText, startX + logoSize + gap, y);
    const pillX = startX + logoSize + gap + brandW + 10;
    ctx.fillStyle = "#eef2ff";
    roundRect(ctx, pillX, y - 1, pillW, 16, 8);
    ctx.fill();
    ctx.fillStyle = "#818cf8";
    ctx.font = `400 10px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(urlText, pillX + 8, y + 2);

    canvas.toBlob((blob) => {
      if (!blob) {
        showMessage("图片生成失败", "error");
        return;
      }
      showInsightImagePreview(blob, data.keyword || "opportunity");
    }, "image/png");
  }

  if (logoImg.complete) {
    drawCard();
  } else {
    logoImg.onload = drawCard;
    logoImg.onerror = drawCard;
  }
}

function renderBenchmarkDiscoveryCardToImage(data) {
  const dpr = window.devicePixelRatio || 2;
  const W = 640;
  const PAD = 32;
  const CONTENT_W = W - PAD * 2;
  const logoImg = new Image();
  logoImg.src = chrome.runtime.getURL("images/icon128.png");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.textBaseline = "top";

  function measureLines(text, fontSize, maxWidth) {
    ctx.font = `${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const chars = String(text || "").split("");
    const lines = [];
    let currentLine = "";
    for (const char of chars) {
      const test = currentLine + char;
      if (ctx.measureText(test).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines;
  }

  function measureChipRows(tags, maxWidth) {
    if (!Array.isArray(tags) || tags.length === 0) {
      return 0;
    }
    let rows = 1;
    let rowW = 0;
    ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
    tags.forEach((tag) => {
      const text = String(tag || "").trim();
      if (!text) return;
      const chipW = ctx.measureText(text).width + 22;
      if (rowW + chipW + 6 > maxWidth && rowW > 0) {
        rows += 1;
        rowW = chipW + 6;
      } else {
        rowW += chipW + 6;
      }
    });
    return rows;
  }

  function candidateHeight(candidate) {
    const innerW = CONTENT_W - 28;
    const reasonLines = measureLines(
      candidate.recommendationReason || "",
      14,
      innerW,
    );
    const focusLines = measureLines(candidate.focusAssessment || "", 12, innerW);
    const tagRows = measureChipRows(candidate.tags || [], innerW);
    const evidenceLines = (candidate.evidence || [])
      .slice(0, 3)
      .flatMap((item) => measureLines(item, 12, innerW - 12));
    const workLines = (candidate.works || [])
      .slice(0, 2)
      .flatMap((item) =>
        measureLines(
          `${item.title}  赞 ${formatOpportunityMetric(item.likes)}`,
          12,
          innerW - 12,
        ),
      );
    return (
      52 +
      reasonLines.length * 21 +
      focusLines.length * 19 +
      Math.max(tagRows, 1) * 25 +
      28 +
      evidenceLines.length * 18 +
      (workLines.length > 0 ? 28 + workLines.length * 18 : 0) +
      24
    );
  }

  function preCalcHeight() {
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    let h = 0;
    h += 122;
    const summaryLines = measureLines(
      `从 ${data.sampleCount || 0} 条搜索结果中筛出 ${data.candidateCount || 0} 个候选账号，入围门槛为样本出现 ${data.minOccurrence || 2} 次。`,
      14,
      CONTENT_W,
    );
    h += summaryLines.length * 22 + 28;
    candidates.forEach((candidate) => {
      h += candidateHeight(candidate) + 12;
    });
    h += 68;
    return h;
  }

  function drawPill(text, x, y, color, bg) {
    const safeText = String(text || "").trim();
    if (!safeText) return 0;
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    const w = ctx.measureText(safeText).width + 22;
    ctx.fillStyle = bg;
    roundRect(ctx, x, y, w, 23, 12);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(safeText, x + 11, y + 6);
    return w;
  }

  function drawCard() {
    const H = preCalcHeight();
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.textBaseline = "top";

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#f0fdfa");
    bg.addColorStop(0.46, "#ffffff");
    bg.addColorStop(1, "#eef2ff");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#ffffff";
    roundRect(ctx, 16, 16, W - 32, H - 32, 18);
    ctx.fill();

    let y = 16;
    const headerH = 104;
    const headerGrad = ctx.createLinearGradient(16, y, W - 16, y);
    headerGrad.addColorStop(0, "#0F766E");
    headerGrad.addColorStop(0.58, "#14B8A6");
    headerGrad.addColorStop(1, "#6366F1");
    ctx.fillStyle = headerGrad;
    roundRectTop(ctx, 16, y, W - 32, headerH, 18);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.font = `500 14px -apple-system, "PingFang SC", sans-serif`;
    const keywordText = `关键词 ${data.keyword || "未命名"}`;
    const keywordW = ctx.measureText(keywordText).width + 24;
    roundRect(ctx, PAD, y + 18, keywordW, 28, 14);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(keywordText, PAD + 12, y + 24);

    ctx.font = `bold 22px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("对标账号推荐", PAD, y + 58);
    y += headerH + 24;

    const summary = `从 ${data.sampleCount || 0} 条搜索结果中筛出 ${data.candidateCount || 0} 个候选账号，入围门槛为样本出现 ${data.minOccurrence || 2} 次。`;
    ctx.fillStyle = "#4b5563";
    ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
    measureLines(summary, 14, CONTENT_W).forEach((line) => {
      ctx.fillText(line, PAD, y);
      y += 22;
    });
    y += 18;

    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    candidates.forEach((candidate) => {
      const cardH = candidateHeight(candidate);
      ctx.fillStyle = "#f8fafc";
      roundRect(ctx, PAD, y, CONTENT_W, cardH, 16);
      ctx.fill();

      let innerY = y + 16;
      const rankBg =
        candidate.growthPotential === "high"
          ? "#dcfce7"
          : candidate.growthPotential === "low"
            ? "#e5e7eb"
            : "#fef3c7";
      const rankColor =
        candidate.growthPotential === "high"
          ? "#047857"
          : candidate.growthPotential === "low"
            ? "#475569"
            : "#92400e";
      ctx.fillStyle = rankBg;
      roundRect(ctx, PAD + 14, innerY, 34, 34, 10);
      ctx.fill();
      ctx.fillStyle = rankColor;
      ctx.font = `bold 15px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(`#${candidate.rank || ""}`, PAD + 21, innerY + 8);

      ctx.fillStyle = "#111827";
      ctx.font = `700 17px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(candidate.name || "未知账号", PAD + 58, innerY + 3);
      innerY += 46;

      ctx.fillStyle = "#111827";
      ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
      measureLines(
        candidate.recommendationReason || "",
        14,
        CONTENT_W - 28,
      ).forEach((line) => {
        ctx.fillText(line, PAD + 14, innerY);
        innerY += 21;
      });

      if (candidate.focusAssessment) {
        ctx.fillStyle = "#6b7280";
        ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
        measureLines(candidate.focusAssessment, 12, CONTENT_W - 28).forEach(
          (line) => {
            ctx.fillText(line, PAD + 14, innerY + 2);
            innerY += 19;
          },
        );
      }

      innerY += 8;
      let chipX = PAD + 14;
      (candidate.tags || []).forEach((tag) => {
        const text = String(tag || "").trim();
        if (!text) return;
        ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
        const w = ctx.measureText(text).width + 22;
        if (chipX + w > W - PAD - 14) {
          chipX = PAD + 14;
          innerY += 25;
        }
        drawPill(text, chipX, innerY, "#0f766e", "#ccfbf1");
        chipX += w + 6;
      });
      innerY += 32;

      ctx.fillStyle = "#0f766e";
      ctx.font = `700 12px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("判断依据", PAD + 14, innerY);
      innerY += 20;
      ctx.fillStyle = "#4b5563";
      ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
      (candidate.evidence || []).slice(0, 3).forEach((item) => {
        measureLines(item, 12, CONTENT_W - 40).forEach((line, index) => {
          ctx.fillText(index === 0 ? `- ${line}` : `  ${line}`, PAD + 18, innerY);
          innerY += 18;
        });
      });

      const works = Array.isArray(candidate.works) ? candidate.works : [];
      if (works.length > 0) {
        innerY += 8;
        ctx.fillStyle = "#6366f1";
        ctx.font = `700 12px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText("代表作品", PAD + 14, innerY);
        innerY += 20;
        ctx.fillStyle = "#4b5563";
        ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
        works.slice(0, 2).forEach((work) => {
          const text = `${work.title}  赞 ${formatOpportunityMetric(work.likes)}`;
          measureLines(text, 12, CONTENT_W - 40).forEach((line, index) => {
            ctx.fillText(index === 0 ? `- ${line}` : `  ${line}`, PAD + 18, innerY);
            innerY += 18;
          });
        });
      }

      y += cardH + 12;
    });

    y += 6;
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(PAD, y, CONTENT_W, 0.5);
    y += 18;

    const brandText = "StarVoice（社媒虾）";
    const urlText = "https://voice.minilife.online";
    const logoSize = 16;
    const gap = 6;
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    const brandW = ctx.measureText(brandText).width;
    ctx.font = `500 10px -apple-system, "PingFang SC", sans-serif`;
    const urlW = ctx.measureText(urlText).width;
    const pillW = urlW + 16;
    const lineW = logoSize + gap + brandW + 10 + pillW;
    const startX = (W - lineW) / 2;

    if (logoImg.complete && logoImg.naturalWidth > 0) {
      ctx.save();
      roundRect(ctx, startX, y - 1, logoSize, logoSize, 3);
      ctx.clip();
      ctx.drawImage(logoImg, startX, y - 1, logoSize, logoSize);
      ctx.restore();
    }
    ctx.fillStyle = "#9ca3af";
    ctx.font = `500 11px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(brandText, startX + logoSize + gap, y);
    const pillX = startX + logoSize + gap + brandW + 10;
    ctx.fillStyle = "#ecfeff";
    roundRect(ctx, pillX, y - 1, pillW, 16, 8);
    ctx.fill();
    ctx.fillStyle = "#14b8a6";
    ctx.font = `400 10px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(urlText, pillX + 8, y + 2);

    canvas.toBlob((blob) => {
      if (!blob) {
        showMessage("图片生成失败", "error");
        return;
      }
      showInsightImagePreview(blob, data.keyword || "benchmark");
    }, "image/png");
  }

  if (logoImg.complete) {
    drawCard();
  } else {
    logoImg.onload = drawCard;
    logoImg.onerror = drawCard;
  }
}

function showInsightImagePreview(blob, seedKeyword) {
  const existing = document.getElementById("insightImagePreviewOverlay");
  if (existing) existing.remove();

  const blobUrl = URL.createObjectURL(blob);

  const overlay = document.createElement("div");
  overlay.id = "insightImagePreviewOverlay";
  overlay.className = "insight-preview-overlay";
  overlay.innerHTML = `
    <div class="insight-preview-dialog">
      <div class="insight-preview-header">
        <span class="insight-preview-title">图片预览</span>
        <button type="button" class="insight-preview-close" id="insightPreviewClose" title="关闭">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
        </button>
      </div>
      <div class="insight-preview-body" id="insightPreviewBody">
        <img src="${blobUrl}" class="insight-preview-img" id="insightPreviewImg" alt="洞察分享图片" />
      </div>
      <div class="insight-preview-footer">
        <span class="insight-preview-zoom-hint">滚轮缩放 · 双击还原</span>
        <div class="insight-preview-actions">
          <button type="button" class="btn btn-secondary" id="insightPreviewCopy">复制</button>
          <button type="button" class="btn btn-secondary" id="insightPreviewDownload">下载</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const body = overlay.querySelector("#insightPreviewBody");
  const img = overlay.querySelector("#insightPreviewImg");
  let scale = 1;
  let tx = 0,
    ty = 0;
  let dragging = false,
    startX = 0,
    startY = 0,
    startTx = 0,
    startTy = 0;

  const applyTransform = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const resetZoom = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    applyTransform();
  };

  body.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      scale = Math.min(5, Math.max(0.5, scale + delta));
      if (scale <= 1) {
        tx = 0;
        ty = 0;
      }
      applyTransform();
    },
    {passive: false},
  );

  body.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (scale !== 1) {
      resetZoom();
    } else {
      scale = 2.5;
      applyTransform();
    }
  });

  body.addEventListener("mousedown", (e) => {
    if (scale <= 1) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startTx = tx;
    startTy = ty;
    body.classList.add("is-dragging");
    e.preventDefault();
  });

  const onMouseMove = (e) => {
    if (!dragging) return;
    tx = startTx + (e.clientX - startX);
    ty = startTy + (e.clientY - startY);
    applyTransform();
  };

  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    body.classList.remove("is-dragging");
  };

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);

  const close = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    overlay.remove();
    URL.revokeObjectURL(blobUrl);
  };

  overlay
    .querySelector("#insightPreviewClose")
    .addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  overlay
    .querySelector("#insightPreviewDownload")
    .addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `onstarvoice-insight-${seedKeyword}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showMessage("图片已保存", "success");
    });

  overlay
    .querySelector("#insightPreviewCopy")
    .addEventListener("click", async () => {
      if (
        typeof navigator === "undefined" ||
        !navigator.clipboard ||
        typeof navigator.clipboard.write !== "function" ||
        typeof window.ClipboardItem !== "function"
      ) {
        showMessage("当前环境暂不支持复制图片，请使用下载", "warning");
        return;
      }

      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            [blob.type || "image/png"]: blob,
          }),
        ]);
        showMessage("图片已复制到剪贴板", "success");
      } catch (error) {
        console.warn("[Sidebar] Failed to copy image", error);
        showMessage("复制图片失败，请尝试下载", "error");
      }
    });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function roundRectTop(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function handleKeywordInsightCategoryActions(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action =
    target.dataset?.action ||
    target.closest("[data-action]")?.dataset?.action ||
    "";

  if (action === "toggle-expand-category") {
    const categoryId = String(
      target.dataset?.categoryId ||
        target.closest("[data-category-id]")?.dataset?.categoryId ||
        "",
    ).trim();
    if (!categoryId) return;
    if (expandedKeywordInsightCategoryIds.has(categoryId)) {
      expandedKeywordInsightCategoryIds.delete(categoryId);
    } else {
      expandedKeywordInsightCategoryIds.add(categoryId);
    }
    renderKeywordInsightState();
    return;
  }

  if (action === "toggle-keyword") {
    const chip = target.closest("[data-keyword]");
    const keyword = String(
      chip?.dataset?.keyword || target.dataset?.keyword || "",
    ).trim();
    if (!keyword) return;

    navigator.clipboard.writeText(keyword).then(() => {
      showMessage(`已复制: ${keyword}`, "success");
    }).catch((err) => {
      console.error("[Sidebar] copy failed:", err);
      showMessage("复制失败", "error");
    });
  }
}



async function handleExpandKeywords() {
  if (keywordExpandInFlight) {
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

  keywordExpandInFlight = true;
  keywordExpandCancelRequested = false;
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
    expandedKeywordsBuffer = Array.isArray(data.expandedKeywords)
      ? data.expandedKeywords
      : [];
    expandedKeywordsPanelVisible = false;
    invalidateKeywordInsightDraft();
    console.info("[Sidebar] Expand keyword result received", {
      totalFound: data?.stats?.totalFound ?? 0,
      uniqueCount: expandedKeywordsBuffer.length,
    });

    await persistBatchDraftForPlatform();

    const stats = data?.stats || {totalFound: 0, duplicatesRemoved: 0};
    renderExpandedKeywords();
    showMessage(
      `扩词完成：共发现 ${stats.totalFound} 个联想词，去重后 ${expandedKeywordsBuffer.length} 个`,
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
    keywordExpandInFlight = false;
    keywordExpandCancelRequested = false;
    updateExpandKeywordsButtonState();
    syncKeywordSortDimensionByRuntime(getCurrentRuntime()).catch((error) => {
      console.warn("[Sidebar] Resume keyword sort sync failed:", error);
    });
  }
}

function updateExpandKeywordsButtonState() {
  const btnExpand = document.getElementById("btnExpandKeywords");
  const btnIntroRun = document.getElementById("btnRunKeywordInsight");
  const currentKeyword = getKeywordInsightSeedKeyword();
  const hasResult = expandedKeywordsBuffer.length > 0;
  if (!btnExpand) {
    return;
  }

  if (keywordExpandInFlight) {
    btnExpand.disabled = false;
    btnExpand.textContent = keywordExpandCancelRequested
      ? "停止中..."
      : "停止分析";
    btnExpand.classList.remove("btn-secondary");
    btnExpand.classList.add("btn-danger");
    if (btnIntroRun) {
      btnIntroRun.disabled = false;
      btnIntroRun.textContent = keywordExpandCancelRequested
        ? "停止中..."
        : "停止分析";
      btnIntroRun.classList.remove("btn-primary");
      btnIntroRun.classList.add("btn-danger");
    }
    return;
  }

  btnExpand.disabled = !currentKeyword;
  btnExpand.textContent = hasResult ? "重新分析" : "开始分析长尾需求";
  btnExpand.classList.add("btn-secondary");
  btnExpand.classList.remove("btn-danger");
  if (btnIntroRun) {
    btnIntroRun.disabled = !currentKeyword;
    btnIntroRun.textContent = "开始分析长尾需求";
    btnIntroRun.classList.add("btn-primary");
    btnIntroRun.classList.remove("btn-danger");
  }
}

async function requestKeywordExpandCancel() {
  if (keywordExpandCancelRequested) {
    return;
  }

  keywordExpandCancelRequested = true;
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

async function requestCaptureCancelSignal(preferTabId = null) {
  let relayTabId = Number(preferTabId);
  if (!Number.isFinite(relayTabId) || relayTabId <= 0) {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    relayTabId = Number(tab?.id);
  }

  if (!Number.isFinite(relayTabId) || relayTabId <= 0) {
    return false;
  }

  await chrome.runtime.sendMessage({
    type: MESSAGE_TYPE.RELAY_TO_CONTENT,
    tabId: relayTabId,
    payload: {action: "cancelCapture"},
  });
  return true;
}

function parseKeywordsFromMultilineInput(rawText = "") {
  return String(rawText || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function dedupeKeywords(keywords = []) {
  const seen = new Set();
  const unique = [];
  for (const keyword of keywords) {
    if (seen.has(keyword)) {
      continue;
    }
    seen.add(keyword);
    unique.push(keyword);
  }
  return unique;
}

function getExpandedKeywordsFromTextarea({dedupe = false} = {}) {
  const textarea = document.getElementById("textareaExpandedKeywords");
  const keywords = textarea
    ? parseKeywordsFromMultilineInput(textarea.value)
    : [...expandedKeywordsBuffer];
  return dedupe ? dedupeKeywords(keywords) : keywords;
}

// 可中断睡眠:每秒检查 shouldStop,用于无人值守循环的轮次间隔
function sleepWithStop(ms, shouldStop) {
  return new Promise((resolve) => {
    const start = Date.now();
    const id = setInterval(() => {
      if ((shouldStop && shouldStop()) || Date.now() - start >= ms) {
        clearInterval(id);
        resolve();
      }
    }, 1000);
  });
}

async function handleBatchKeywordCapture() {
  if (batchKeywordCaptureInFlight) {
    if (batchKeywordCancelRequested) {
      showMessage("正在取消批量采集...", "warning");
      return;
    }
    batchKeywordCancelRequested = true;
    // 取消时若正在「采集增强」逐条補采(用 detailBatch 标志 + 独立 runner tab),也要一并停,
    // 否则在增强阶段点终止会继续補采、停不下来。
    if (detailBatchCaptureInFlight) {
      detailBatchCancelRequested = true;
    }
    const btnBatch = document.getElementById("btnRunBatchKeywords");
    if (btnBatch) {
      btnBatch.textContent = "停止中...";
    }
    const batchCancelTabId =
      detailBatchCaptureInFlight && Number.isFinite(Number(detailBatchRunnerTabId))
        ? Number(detailBatchRunnerTabId)
        : activeBatchRunnerTabId;
    try {
      await requestCaptureCancelSignal(batchCancelTabId);
    } catch (error) {
      console.warn("[Sidebar] Batch keyword cancel failed:", error);
    }
    showMessage("正在取消批量采集...", "warning");
    return;
  }

  if (batchUrlCaptureInFlight) {
    showMessage("已有批量任务执行中，请先停止当前任务", "warning");
    return;
  }

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
  if (!getPlatformCapabilities(pagePlatform).captureSearch) {
    showMessage("当前平台暂不支持搜索结果采集", "warning");
    return;
  }

  const rawKeywords = getBatchKeywordsFromTextarea();
  if (rawKeywords.length === 0) {
    showMessage("请输入至少一个关键词（每行一个）", "warning");
    return;
  }
  if (rawKeywords.length > MAX_BATCH_KEYWORDS) {
    showMessage(`单次最多批量采集 ${MAX_BATCH_KEYWORDS} 个关键词`, "warning");
    return;
  }

  const keywords = dedupeKeywords(rawKeywords);
  updateBatchKeywordInputState();
  persistCurrentBatchDraft();

  try {
    const settings = resolveCurrentDetailCaptureSettings(
      await getCaptureSettings(),
    );
    if (
      settings.autoDetailCaptureAfterListCapture &&
      !ensureAuthVerifiedOrWarn({
        message: PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
      })
    ) {
      return;
    }

    const sortContext = await syncKeywordSortDimensionFromPage({
      force: true,
      fallbackDimension: keywordSortDimension,
    });
    const keywordMinLikes = readKeywordMinLikesFromInput(
      settings.keywordMinLikes,
    );
    const keywordMaxDetectedItems = readKeywordMaxDetectedItemsFromInput(
      settings.keywordMaxDetectedItems,
    );

    let baseSearchUrl = runtime?.lastPageUrl || "";
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.url) {
        baseSearchUrl = tab.url;
      }
      activeBatchRunnerTabId = tab?.id ? Number(tab.id) : null;
    } catch {
      // ignore
      activeBatchRunnerTabId = null;
    }

    batchKeywordCaptureInFlight = true;
    batchKeywordCancelRequested = false;

    const btnBatch = document.getElementById("btnRunBatchKeywords");
    if (btnBatch) {
      btnBatch.textContent = "取消批量采集";
      btnBatch.classList.remove("btn-primary");
      btnBatch.classList.add("btn-danger");
      btnBatch.disabled = false;
      btnBatch.classList.remove("is-disabled");
    }

    setBatchProgressVisible("modal", true);

    // 无人值守循环:跑完一轮(所有关键词)→自动再跑下一轮,轮次间隔可设;
    // 留空轮数 = 一直跑(夜间专机用)。全程可中断(再点按钮即停)。
    const autoLoop = !!document.getElementById("chkAutoLoop")?.checked;
    const roundGapMin = Math.max(0, Number(document.getElementById("inputLoopGapMin")?.value) || 0);
    const maxRounds = Math.max(1, Math.floor(Number(document.getElementById("inputLoopRounds")?.value)) || 1); // 留空/0 = 1 轮(不做无限,防风控)
    const roundGapMs = roundGapMin * 60 * 1000;
    // 采集排序 / 发布时间(默认「综合 + 不限」归一为空 → 不触发筛选点击);复用「找对标账号」的筛选点击能力
    const rawSort = document.getElementById("selectBatchSort")?.value || "";
    const rawPublishTime = document.getElementById("selectBatchPublishTime")?.value || "";
    const searchFilters = {
      sort: rawSort === "comprehensive" ? "" : rawSort,
      publishTime: rawPublishTime === "all" ? "" : rawPublishTime,
    };

    let result;
    let round = 0;
    let totalSuccess = 0;
    let totalFailed = 0;

    // 定时启动:指定了开始时刻则等到那一刻再开跑(可中断),等待期间显示倒计时
    const scheduledStartStr = document.getElementById("inputBatchScheduledStart")?.value || "";
    if (scheduledStartStr) {
      const targetMs = new Date(scheduledStartStr).getTime();
      if (Number.isFinite(targetMs) && targetMs > Date.now()) {
        const targetLabel = new Date(scheduledStartStr).toLocaleString("zh-CN");
        setBatchProgressVisible("modal", true);
        let lastShownSec = -1;
        await sleepWithStop(targetMs - Date.now(), () => {
          if (batchKeywordCancelRequested) return true;
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
                phase: "scheduled-waiting",
                message: `⏰ 定时采集:将于 ${targetLabel} 开始(还剩 ${h > 0 ? h + "时" : ""}${m}分${s}秒)`,
              },
              "modal",
            );
          }
          return false;
        });
        if (batchKeywordCancelRequested) {
          showMessage("已取消定时采集", "warning");
          return; // finally 会复位状态/按钮
        }
      }
    }

    do {
      round += 1;
      result = await batchCaptureByKeywords({
        keywords: [...keywords],
        platform: pagePlatform,
        baseSearchUrl,
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
        onProgress: (progress) => {
          // 进入「导航 / 切筛选 / 等待」阶段时清掉上一条采集明细,等本条列表采集再刷新
          if (progress.phase && progress.phase !== "capturing") {
            setBatchProgressDetail("");
          }
          updateBatchProgress(
            autoLoop
              ? { ...progress, message: `第 ${round} 轮 · ${progress.message || ""}` }
              : progress,
            "modal",
          );
        },
        shouldStop: () => batchKeywordCancelRequested,
      });

      await refreshDataPool();
      totalSuccess += result.stats.success;
      totalFailed += result.stats.failed;

      if (!result.canceled) {
        await maybeRunAutoDetailCaptureAfterListCapture(settings, {
          sourceLabel: "批量关键词搜索结果",
          recordIds: collectBatchRecordIds(result),
        });
      }

      // 终止:被取消 / 没开循环 / 已到指定轮数
      if (result.canceled || !autoLoop || round >= maxRounds) {
        break;
      }

      // 轮次间隔:歇 roundGapMin 分钟再跑下一轮(睡眠中可中断)
      if (roundGapMs > 0) {
        updateBatchProgress(
          {
            current: 0,
            total: keywords.length,
            phase: "waiting",
            message: `第 ${round} 轮完成（累计成功 ${totalSuccess}），${roundGapMin} 分钟后开始第 ${round + 1} 轮…`,
            round,
          },
          "modal",
        );
        await sleepWithStop(roundGapMs, () => batchKeywordCancelRequested);
      }
    } while (!batchKeywordCancelRequested);

    const stats = result.stats;
    if (autoLoop) {
      const stopped = result.canceled || batchKeywordCancelRequested;
      showMessage(
        `无人值守采集${stopped ? "已停止" : "结束"}：共跑 ${round} 轮，累计成功 ${totalSuccess}，失败 ${totalFailed}`,
        stopped ? "warning" : "success",
      );
    } else if (result.canceled) {
      showMessage(
        `批量采集已停止：已处理 ${stats.processed}/${stats.total} 个关键词，成功 ${stats.success}，失败 ${stats.failed}`,
        "warning",
      );
    } else {
      showMessage(
        `批量采集完成：共 ${stats.total} 个关键词，成功 ${stats.success}，失败 ${stats.failed}`,
        stats.failed > 0 ? "warning" : "success",
      );
    }
  } catch (error) {
    console.error("[Sidebar] Batch keyword capture failed:", error);
    showMessage("批量采集失败: " + error.message, "error");
  } finally {
    batchKeywordCaptureInFlight = false;
    batchKeywordCancelRequested = false;
    activeBatchRunnerTabId = null;
    setBatchProgressDetail("");

    const btnBatch = document.getElementById("btnRunBatchKeywords");
    if (btnBatch) {
      btnBatch.textContent = "开始批量采集";
      btnBatch.classList.add("btn-primary");
      btnBatch.classList.remove("btn-danger");
    }
    updateBatchKeywordInputState();
  }
}

async function runCaptureAction({
  mode,
  progressMessage,
  successMessage,
  captureParams = {},
  keepProgressOpen = false,
}) {
  showProgress(progressMessage);

  try {
    const result = await captureAndSync({
      mode,
      onProgress: handleProgress,
      autoSync: false,
      captureParams,
    });

    if (result.ok) {
      const savedCount = Array.isArray(result.recordIds)
        ? result.recordIds.length
        : result.recordId
          ? 1
          : 0;
      if (savedCount === 0) {
        const payload = result.captureResult?.data || {};
        const detectedCount = Number(payload.rawTotalCount || 0);
        const filteredBeforeLimitCount = Number(
          payload.filteredBeforeLimitCount || 0,
        );
        const minLikes = Number(payload.minLikes || 0);
        const sortDimension = normalizeKeywordSortDimension(
          payload.sortDimension,
        );
        const sortLabel = getKeywordSortDimensionLabel(sortDimension);
        if (detectedCount > 0 && filteredBeforeLimitCount <= 0) {
          showMessage(
            `已探测 ${detectedCount} 条，但按${sortLabel}阈值（≥${minLikes}）筛选后为 0 条，请降低筛选阈值后重试`,
            "warning",
          );
        } else {
          showMessage(
            "采集完成，但未获取到可入池数据（可能因筛选条件过高或当前页暂无结果）",
            "warning",
          );
        }
      } else {
        showMessage(successMessage, "success");
      }
      await refreshDataPool();
      return {
        ok: true,
        result,
        savedCount,
        recordIds: Array.isArray(result.recordIds) ? result.recordIds : [],
      };
    } else {
      const errorMsg =
        ERROR_MESSAGE_MAP[result.error?.code] ||
        result.error?.message ||
        "采集失败";
      showMessage(errorMsg, "error");
      return {
        ok: false,
        result,
        savedCount: 0,
      };
    }
  } catch (error) {
    console.error("[Sidebar] Capture action failed:", error);
    showMessage("操作失败: " + error.message, "error");
    return {
      ok: false,
      result: null,
      savedCount: 0,
      error,
    };
  } finally {
    if (!keepProgressOpen) {
      hideProgress();
    }
  }
}

/**
 * 处理取消操作
 */
async function handleCancel() {
  console.log("[Sidebar] Cancel clicked");
  setCancelFlag(true);
  searchCaptureCancelRequested = true;
  hideProgressPanelOnly();
  let relayTabId = null;
  if (detailBatchCaptureInFlight) {
    detailBatchCancelRequested = true;
    if (Number.isFinite(Number(detailBatchRunnerTabId))) {
      relayTabId = Number(detailBatchRunnerTabId);
    }
  }
  if (batchUrlCaptureInFlight) {
    batchUrlCancelRequested = true;
    relayTabId = relayTabId || activeBatchRunnerTabId;
  }
  if (batchKeywordCaptureInFlight) {
    batchKeywordCancelRequested = true;
    relayTabId = relayTabId || activeBatchRunnerTabId;
  }
  if (monitorRunInFlight) {
    monitorRunCancelRequested = true;
    relayTabId = relayTabId || activeBatchRunnerTabId;
  }

  try {
    if (relayTabId) {
      await requestCaptureCancelSignal(relayTabId);
    } else {
      await requestCaptureCancelSignal();
    }
  } catch (error) {
    console.warn("[Sidebar] Cancel relay failed:", error);
  }

  showMessage("正在取消...", "info");
}

/**
 * 处理鉴权
 */
async function handleVerify() {
  if (authVerifyInFlight) {
    showMessage("正在验证中，请稍候...", "info");
    return;
  }

  const input = document.getElementById("inputCode");
  if (!input) return;

  const rawCode = normalizeAuthCodeInput(input.value);

  if (!rawCode) {
    showMessage("请输入激活码或订单号", "error");
    return;
  }

  let encryptedCode = "";
  let plainCode = "";
  try {
    encryptedCode = await ensureEncryptedAuthCode(rawCode);
    plainCode = await ensurePlainAuthCode(encryptedCode);
  } catch (error) {
    console.error("[Sidebar] Prepare verify code failed:", error);
    showMessage("激活码加密失败，请重试", "error");
    return;
  }

  if (!plainCode) {
    showMessage("激活码格式无效，请重新输入", "error");
    return;
  }

  const currentAuth = getCurrentAuth() || {};
  const previousStoredCode = normalizeAuthCodeInput(currentAuth.code);
  if (isEncryptedAuthCode(previousStoredCode)) {
    try {
      const previousPlainCode = normalizeAuthCodeInput(
        await ensurePlainAuthCode(previousStoredCode),
      );
      if (previousPlainCode === plainCode) {
        encryptedCode = previousStoredCode;
      }
    } catch (error) {
      console.warn(
        "[Sidebar] Failed to decode previous auth code before verify:",
        error,
      );
    }
  }

  authVerifyInFlight = true;
  showProgress("正在验证凭证...");

  try {
    await setCurrentAuth({
      status: AUTH_STATUS.VERIFYING,
      code: encryptedCode,
      message: "",
      reason: "none",
    });

    let result = await verify(plainCode);

    if (!result.ok && result.reason === ERROR_REASON.BINDING_LIMIT_REACHED) {
      hideProgress();
      const candidates = Array.isArray(result.data?.replaceCandidates)
        ? result.data.replaceCandidates
        : [];
      const selectedBindingId = await pickBindingForReplacement(candidates);

      if (!selectedBindingId) {
        result = {
          ok: false,
          reason: ERROR_REASON.BINDING_LIMIT_REACHED,
          message: "已取消环境替换",
          data: result.data || null,
        };
      } else {
        showProgress("正在替换旧环境...");
        result = await verify(plainCode, {
          replaceBindingId: selectedBindingId,
        });
      }
    }

    if (result.ok) {
      const authSnapshot = authSnapshotFromVerifyResult(result);
      await setCurrentAuth({
        verified: true,
        status: AUTH_STATUS.VERIFIED,
        code: encryptedCode,
        lastVerifiedAt: new Date().toISOString(),
        message: result.message,
        reason: "none",
        ...authSnapshot,
      });

      try {
        await syncTargetConfigAfterVerify();
      } catch (error) {
        console.warn("[Sidebar] Target sync after verify failed:", error);
      }

      try {
        await loadMonitorSettings();
      } catch (error) {
        console.warn(
          "[Sidebar] Monitor settings sync after verify failed:",
          error,
        );
      }

      if (
        document
          .querySelector("#mainTabNav .tab-btn.is-active")
          ?.getAttribute("data-target") === "monitorTab"
      ) {
        await loadMonitorSubscriptions({force: true});
      }

      if (
        document
          .querySelector("#mainTabNav .tab-btn.is-active")
          ?.getAttribute("data-target") === "historyTab"
      ) {
        await loadExecutionDetails({force: true});
      }

      if (result.data?.replacedBinding) {
        showMessage("激活成功，已替换旧环境并完成后台绑定", "success");
      } else {
        showMessage("激活成功，已完成后台绑定", "success");
      }
      await maybeOpenMemberGroupModalAfterVerify(getCurrentAuth());
    } else {
      await setCurrentAuth({
        verified: false,
        status: AUTH_STATUS.FAILED,
        code: encryptedCode,
        message: result.message,
        reason: result.reason,
        user: null,
        credentialCredit: null,
      });
      await resetCurrentMonitor();

      const isReplaceCanceled = result.message === "已取消环境替换";
      const errorMsg =
        (isReplaceCanceled ? result.message : null) ||
        result.message ||
        ERROR_MESSAGE_MAP[result.reason || result.error?.reason] ||
        "激活失败";
      showMessage(errorMsg, isReplaceCanceled ? "warning" : "error");
    }
  } catch (error) {
    console.error("[Sidebar] Verify failed:", error);
    await resetCurrentMonitor();
    showMessage("验证失败: " + error.message, "error");
  } finally {
    authVerifyInFlight = false;
    hideProgress();
  }
}

function formatBindingTime(value) {
  if (!value) return "未知";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "未知" : parsed.toLocaleString();
}

function escapeHtmlText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getBindingReplaceModalElements() {
  const overlay = document.getElementById("bindingReplaceModal");
  const subtitle = document.getElementById("bindingReplaceSubtitle");
  const list = document.getElementById("bindingReplaceList");
  const btnCancel = document.getElementById("btnBindingReplaceCancel");
  const btnConfirm = document.getElementById("btnBindingReplaceConfirm");

  if (!overlay || !subtitle || !list || !btnCancel || !btnConfirm) {
    return null;
  }

  return {
    overlay,
    subtitle,
    list,
    btnCancel,
    btnConfirm,
  };
}

function renderBindingReplaceCandidates(
  listElement,
  candidates,
  selectedBindingId,
) {
  listElement.innerHTML = candidates
    .map((candidate, index) => {
      const bindingId = String(candidate.id || "");
      const label = escapeHtmlText(
        candidate.clientLabel || candidate.clientUuid || "未知环境",
      );
      const firstBoundAt = formatBindingTime(candidate.firstBoundAt);
      const lastVerifiedAt = formatBindingTime(candidate.lastVerifiedAt);
      const checked = bindingId === selectedBindingId ? "checked" : "";

      return `
        <label class="binding-replace-item" for="bindingReplaceOption${index}">
          <input
            type="radio"
            name="bindingReplaceOption"
            id="bindingReplaceOption${index}"
            value="${escapeHtmlText(bindingId)}"
            ${checked}
          />
          <span class="binding-replace-item-main">
            <div class="binding-replace-item-label">${label}</div>
            <div class="binding-replace-item-meta">首次绑定：${escapeHtmlText(firstBoundAt)}</div>
            <div class="binding-replace-item-meta">最近验证：${escapeHtmlText(lastVerifiedAt)}</div>
          </span>
        </label>
      `;
    })
    .join("");
}

async function pickBindingForReplacement(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    showMessage("当前没有可替换的环境，请联系运营处理", "warning");
    return null;
  }

  const elements = getBindingReplaceModalElements();
  if (!elements) {
    console.error("[Sidebar] Binding replace modal elements not found");
    showMessage("无法打开环境替换窗口，请刷新后重试", "error");
    return null;
  }

  const {overlay, subtitle, list, btnCancel, btnConfirm} = elements;
  let selectedBindingId = "";

  subtitle.textContent = `当前激活码已占满 ${candidates.length}/${candidates.length} 个环境，被替换环境将立即失效。`;
  renderBindingReplaceCandidates(list, candidates, selectedBindingId);
  btnConfirm.disabled = !selectedBindingId;

  overlay.classList.add("is-active");
  overlay.setAttribute("aria-hidden", "false");

  const firstInput = list.querySelector('input[name="bindingReplaceOption"]');
  if (firstInput) {
    firstInput.focus();
  } else {
    btnCancel.focus();
  }

  return await new Promise((resolve) => {
    const cleanup = () => {
      overlay.classList.remove("is-active");
      overlay.setAttribute("aria-hidden", "true");
      btnCancel.removeEventListener("click", onCancel);
      btnConfirm.removeEventListener("click", onConfirm);
      list.removeEventListener("change", onChange);
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKeyDown);
      list.innerHTML = "";
    };

    const done = (bindingId) => {
      cleanup();
      resolve(bindingId);
    };

    const onCancel = () => done(null);

    const onConfirm = () => {
      if (!selectedBindingId) {
        showMessage("请选择一个要替换的环境", "warning");
        return;
      }
      done(selectedBindingId);
    };

    const onChange = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.name !== "bindingReplaceOption") return;
      selectedBindingId = target.value;
      btnConfirm.disabled = !selectedBindingId;
    };

    const onOverlayClick = (event) => {
      if (event.target === overlay) {
        done(null);
      }
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        done(null);
      }
    };

    btnCancel.addEventListener("click", onCancel);
    btnConfirm.addEventListener("click", onConfirm);
    list.addEventListener("change", onChange);
    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKeyDown);
  });
}

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
  const datasetSelectedPlatform = document.body.dataset.selectedPlatform;
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

  const items = Array.isArray(result.data?.items) ? result.data.items : [];
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

function getMonitorSettingsElements() {
  const publishWindow = document.getElementById("inputMonitorPublishWindow");
  const likeThreshold = document.getElementById("inputMonitorLikeThreshold");
  const runTimes = document.getElementById("inputMonitorRunTimes");
  const observeWindowHours = document.getElementById(
    "inputMonitorObserveWindowHours",
  );

  if (!publishWindow || !likeThreshold || !runTimes || !observeWindowHours) {
    return null;
  }

  return {
    publishWindow,
    likeThreshold,
    runTimes,
    observeWindowHours,
  };
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

function populateMonitorSettingsForm(settings = {}) {
  const elements = getMonitorSettingsElements();
  if (!elements) {
    return;
  }

  const normalized = normalizeMonitorSettingsInput(settings);
  elements.publishWindow.value = normalized.publishWindow;
  elements.likeThreshold.value = String(normalized.likeThreshold);
  elements.runTimes.value =
    normalized.runTimes[0] || DEFAULT_MONITOR_SETTINGS.runTimes[0];
  elements.observeWindowHours.value = String(normalized.observeWindowHours);
}

function readMonitorSettingsForm() {
  const elements = getMonitorSettingsElements();
  if (!elements) {
    return {...DEFAULT_MONITOR_SETTINGS};
  }

  return normalizeMonitorSettingsInput({
    publishWindow: elements.publishWindow.value,
    likeThreshold: elements.likeThreshold.value,
    runTimes: elements.runTimes.value,
    observeWindowHours: elements.observeWindowHours.value,
  });
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

function resolveMonitorDisplayName(item) {
  return (
    String(item?.bloggerNameSnapshot || "").trim() ||
    String(item?.platformBloggerId || "").trim() ||
    "未命名博主"
  );
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

  return String(fallbackId || "").trim();
}

function buildMonitorCandidateFromRecord(record) {
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
  const bloggerUrl = String(payload.bloggerUrl || "").trim();
  const platformBloggerId = extractPlatformMonitorBloggerId(
    platform,
    bloggerUrl,
    payload.bloggerId,
  );
  const bloggerNameSnapshot = String(payload.bloggerName || "").trim();
  const bloggerAvatarSnapshot = String(payload.avatarUrl || "").trim();

  if (!platformBloggerId) {
    return null;
  }

  return {
    platform,
    platformBloggerId,
    bloggerNameSnapshot,
    bloggerUrl,
    bloggerAvatarSnapshot,
  };
}

async function addMonitorSubscriptionByCandidate(candidate) {
  const result = await createMonitorSubscription(candidate);

  if (!result?.ok) {
    throw new Error(result?.message || "纳入监控失败");
  }

  await loadMonitorSubscriptions({force: true});

  if (result.data?.created) {
    showMessage("已将当前账号纳入监控", "success");
  } else if (result.data?.restored) {
    showMessage("当前账号已恢复到监控列表", "success");
  } else {
    showMessage("当前账号已在监控列表中", "info");
  }
}

async function captureCurrentMonitorCandidate() {
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
  const bloggerNameSnapshot = String(profile.bloggerName || "").trim();
  const bloggerUrl = String(profile.bloggerUrl || pageUrl).trim();
  const bloggerAvatarSnapshot = String(profile.avatarUrl || "").trim();
  const platformBloggerId = extractPlatformMonitorBloggerId(
    pagePlatform,
    bloggerUrl,
    profile.bloggerId,
  );

  if (!platformBloggerId) {
    throw new Error("未识别到账号唯一 ID");
  }

  return {
    platform: pagePlatform,
    platformBloggerId,
    bloggerNameSnapshot,
    bloggerUrl,
    bloggerAvatarSnapshot,
  };
}

async function handleAddCurrentMonitor() {
  if (!isMonitorAuthReady()) {
    showMessage(MONITOR_REQUIRED_MESSAGE, "warning");
    return;
  }

  showProgress("正在识别当前账号并纳入监控...");

  try {
    const candidate = await captureCurrentMonitorCandidate();
    await addMonitorSubscriptionByCandidate(candidate);
  } catch (error) {
    console.error("[Sidebar] Add current monitor failed:", error);
    showMessage(`纳入监控失败: ${error.message}`, "error");
  } finally {
    hideProgress();
  }
}

function resolveMonitorRunHistoryState(item) {
  const status = String(item?.status || "")
    .trim()
    .toLowerCase();
  const hitCount = Math.max(0, Number(item?.hitCount || 0));
  const scannedCount = Math.max(0, Number(item?.scannedCount || 0));
  const errorCode = String(item?.errorCode || "").trim();
  const errorMessage = String(item?.errorMessage || "").trim();

  if (status === "skipped_no_balance") {
    return {
      monitorStatus: "credit_insufficient",
      monitorStatusLabel: "配额不足",
      monitorSyncLabel: "",
      monitorSummary: "未执行扫描（配额不足）",
      isSuccess: false,
      reason: errorCode || "insufficient_balance",
      message: errorMessage || "insufficient credential credits",
    };
  }

  if (status === "queued" || status === "pending" || status === "running") {
    return {
      monitorStatus: "queued",
      monitorStatusLabel: "已排队",
      monitorSyncLabel: "",
      monitorSummary: status === "running" ? "扫描任务执行中" : "扫描任务已排队",
      isSuccess: true,
      reason: ERROR_REASON.NONE,
      message: status === "running" ? "监控任务执行中" : "已创建监控执行任务",
    };
  }

  if (status === "no_hit") {
    return {
      monitorStatus: "no_hit",
      monitorStatusLabel: "未命中",
      monitorSyncLabel: "",
      monitorSummary: `已扫描 ${scannedCount} / 命中 0`,
      isSuccess: true,
      reason: ERROR_REASON.NONE,
      message: "监控执行完成",
    };
  }

  if (status === "success") {
    return {
      monitorStatus: "hit_synced",
      monitorStatusLabel: "已命中",
      monitorSyncLabel: "已同步",
      monitorSummary: `命中 ${hitCount} / 已同步`,
      isSuccess: true,
      reason: ERROR_REASON.NONE,
      message: "监控执行完成",
    };
  }

  if (status === "failed" && hitCount > 0) {
    return {
      monitorStatus: "hit_sync_failed",
      monitorStatusLabel: "已命中",
      monitorSyncLabel: "同步失败",
      monitorSummary: `命中 ${hitCount} / 同步失败`,
      isSuccess: false,
      reason: errorCode || "sync_failed",
      message: errorMessage || "监控同步失败",
    };
  }

  return {
    monitorStatus: "execution_failed",
    monitorStatusLabel: "执行失败",
    monitorSyncLabel: "",
    monitorSummary: errorMessage || "扫描失败",
    isSuccess: false,
    reason: errorCode || "provider_request_failed",
    message: errorMessage || "监控执行失败",
  };
}

function normalizeMonitorRunnerPlatform(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "douyin" ||
    normalized === "xiaohongshu" ||
    normalized === "weibo"
    ? normalized
    : "unknown";
}

function resolveMonitorRunnerAccountUrl(runItem = {}, monitorItem = {}) {
  return String(
    runItem.bloggerUrl ||
      runItem.monitorBloggerUrl ||
      runItem.accountUrl ||
      monitorItem.bloggerUrl ||
      monitorItem.monitorBloggerUrl ||
      monitorItem.accountUrl ||
      "",
  ).trim();
}

function resolveMonitorRunnerName(runItem = {}, monitorItem = {}) {
  return (
    String(
      runItem.monitorBloggerName ||
        runItem.bloggerNameSnapshot ||
        runItem.bloggerName ||
        monitorItem.bloggerNameSnapshot ||
        monitorItem.bloggerName ||
        monitorItem.platformBloggerId ||
        "",
    ).trim() || "未命名博主"
  );
}

function resolveMonitorRunnerCaptureParams(
  monitorSettings = {},
  captureSettings = {},
) {
  const observeWindowHours =
    MONITOR_OBSERVE_WINDOW_OPTIONS.includes(
      Number(monitorSettings.observeWindowHours),
    )
      ? Number(monitorSettings.observeWindowHours)
      : DEFAULT_MONITOR_SETTINGS.observeWindowHours;
  const maxDetectedItems =
    MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW[observeWindowHours] ||
    MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW[
      DEFAULT_MONITOR_SETTINGS.observeWindowHours
    ];
  const publishWindow =
    monitorSettings.publishWindow || DEFAULT_MONITOR_SETTINGS.publishWindow;
  const isStrictPublishWindow =
    publishWindow === MONITOR_PUBLISH_WINDOW.LAST_24H ||
    publishWindow === MONITOR_PUBLISH_WINDOW.PREVIOUS_DAY;
  const monitorScanLimit = isStrictPublishWindow
    ? Math.min(
        maxDetectedItems,
        publishWindow === MONITOR_PUBLISH_WINDOW.PREVIOUS_DAY ? 20 : 12,
      )
    : maxDetectedItems;
  const likeThreshold = Math.max(
    0,
    Number(monitorSettings.likeThreshold) ||
      DEFAULT_MONITOR_SETTINGS.likeThreshold,
  );

  return {
    includeBloggerProfileRecord: false,
    // 监控先纳入最近动态；点赞阈值用于后续判断，不在采集阶段过滤。
    minLikes: 0,
    maxDetectedItems: Math.floor(monitorScanLimit),
    monitorLikeThreshold: Math.floor(likeThreshold),
    monitorPublishWindow: publishWindow,
    monitorObserveWindowHours: observeWindowHours,
    waitMinMs:
      Number(captureSettings.sharedWaitMinMs) ||
      DEFAULT_CAPTURE_SETTINGS.sharedWaitMinMs,
    waitMaxMs:
      Number(captureSettings.sharedWaitMaxMs) ||
      DEFAULT_CAPTURE_SETTINGS.sharedWaitMaxMs,
    stallTimeoutMs:
      Number(captureSettings.sharedStallTimeoutMs) ||
      DEFAULT_CAPTURE_SETTINGS.sharedStallTimeoutMs,
    maxDurationMs:
      Number(captureSettings.sharedMaxDurationMs) ||
      DEFAULT_CAPTURE_SETTINGS.sharedMaxDurationMs,
    maxScrollTimes: isStrictPublishWindow ? 6 : 20,
  };
}

function summarizeMonitorSyncResult(syncResult = {}) {
  const results = Array.isArray(syncResult.results) ? syncResult.results : [];
  const successCount = results.filter((item) => item?.success).length;
  const failedCount = results.length - successCount;
  const actionCounts = results.reduce(
    (acc, item) => {
      const raw = item?.rawResponse || {};
      const action = String(raw.action || item?.action || "")
        .trim()
        .toLowerCase();
      if (action === "inserted") {
        acc.inserted += 1;
      } else if (action === "updated") {
        acc.updated += 1;
      }
      const negative = Number(raw?.commentStats?.negative || 0);
      if (Number.isFinite(negative) && negative > 0) {
        acc.negative += negative;
      }
      return acc;
    },
    {inserted: 0, updated: 0, negative: 0},
  );

  return {
    successCount,
    failedCount,
    insertedCount: actionCounts.inserted,
    updatedCount: actionCounts.updated,
    negativeCount: actionCounts.negative,
  };
}

function getShanghaiDayStartMs(timestamp = Date.now()) {
  const normalized = Number(timestamp);
  const safeTimestamp = Number.isFinite(normalized) ? normalized : Date.now();
  return (
    Math.floor((safeTimestamp + MONITOR_SHANGHAI_OFFSET_MS) / MONITOR_DAY_MS) *
      MONITOR_DAY_MS -
    MONITOR_SHANGHAI_OFFSET_MS
  );
}

function getShanghaiDateParts(timestamp = Date.now()) {
  const date = new Date(Number(timestamp) + MONITOR_SHANGHAI_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function buildShanghaiTimestamp({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
}) {
  const timestamp =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(millisecond),
    ) - MONITOR_SHANGHAI_OFFSET_MS;
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function resolveMonitorPublishWindowBounds(publishWindow, nowMs = Date.now()) {
  const normalized = MONITOR_PUBLISH_WINDOW_OPTIONS.has(publishWindow)
    ? publishWindow
    : DEFAULT_MONITOR_SETTINGS.publishWindow;

  if (normalized === MONITOR_PUBLISH_WINDOW.PREVIOUS_DAY) {
    const todayStartMs = getShanghaiDayStartMs(nowMs);
    return {
      key: normalized,
      label: "昨天发布",
      strict: true,
      startMs: todayStartMs - MONITOR_DAY_MS,
      endMs: todayStartMs,
    };
  }

  if (normalized === MONITOR_PUBLISH_WINDOW.LAST_24H) {
    return {
      key: normalized,
      label: "最近 24 小时发布",
      strict: true,
      startMs: nowMs - MONITOR_DAY_MS,
      endMs: nowMs,
    };
  }

  return resolveMonitorPublishWindowBounds(DEFAULT_MONITOR_SETTINGS.publishWindow, nowMs);
}

function cleanMonitorPublishText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^发布时间[:：]?\s*/i, "")
    .replace(/^发布于[:：]?\s*/i, "")
    .replace(/^编辑于\s*/i, "")
    .replace(/^·\s*/, "")
    .trim();
}

function createMonitorPublishMoment(
  timestamp,
  {precision = "exact", raw = ""} = {},
) {
  const normalized = Number(timestamp);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }
  if (precision === "date") {
    const startMs = getShanghaiDayStartMs(normalized);
    return {
      ok: true,
      raw,
      precision: "date",
      timestampMs: startMs,
      startMs,
      endMs: startMs + MONITOR_DAY_MS,
    };
  }
  return {
    ok: true,
    raw,
    precision: "exact",
    timestampMs: normalized,
    startMs: normalized,
    endMs: normalized,
  };
}

function parseMonitorNumericPublishMoment(value, raw = "") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  const timestampMs = numeric < 100000000000 ? numeric * 1000 : numeric;
  return createMonitorPublishMoment(timestampMs, {raw});
}

function resolveYearForMonthDay(month, day, nowMs, hour = 0, minute = 0) {
  const {year} = getShanghaiDateParts(nowMs);
  const timestamp = buildShanghaiTimestamp({year, month, day, hour, minute});
  if (Number.isFinite(timestamp) && timestamp > nowMs + MONITOR_DAY_MS) {
    return year - 1;
  }
  return year;
}

function parseMonitorPublishMoment(value, nowMs = Date.now()) {
  if (value instanceof Date) {
    return createMonitorPublishMoment(value.getTime(), {
      raw: value.toISOString(),
    });
  }
  if (typeof value === "number") {
    return parseMonitorNumericPublishMoment(value, String(value));
  }

  const text = cleanMonitorPublishText(value);
  if (!text) {
    return null;
  }

  if (/^\d{10,13}$/.test(text)) {
    return parseMonitorNumericPublishMoment(text, text);
  }

  if (/^\d{4}-\d{2}-\d{2}T/i.test(text)) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return createMonitorPublishMoment(parsed, {raw: text});
    }
  }

  let match = text.match(
    /(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?(?:\s+|T)?(\d{1,2})[:：](\d{2})/,
  );
  if (match) {
    const [, year, month, day, hour, minute] = match;
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day, hour, minute}),
      {raw: text},
    );
  }

  match = text.match(/(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?/);
  if (match) {
    const [, year, month, day] = match;
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day}),
      {precision: "date", raw: text},
    );
  }

  match = text.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[:：](\d{2})/);
  if (match) {
    const [, month, day, hour, minute] = match;
    const year = resolveYearForMonthDay(month, day, nowMs, hour, minute);
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day, hour, minute}),
      {raw: text},
    );
  }

  match = text.match(/(\d{1,2})[-/.](\d{1,2})\s*(\d{1,2})[:：](\d{2})/);
  if (match) {
    const [, month, day, hour, minute] = match;
    const year = resolveYearForMonthDay(month, day, nowMs, hour, minute);
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day, hour, minute}),
      {raw: text},
    );
  }

  match = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (match) {
    const [, month, day] = match;
    const year = resolveYearForMonthDay(month, day, nowMs);
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day}),
      {precision: "date", raw: text},
    );
  }

  match = text.match(/(\d{1,2})[-/.](\d{1,2})/);
  if (match) {
    const [, month, day] = match;
    const year = resolveYearForMonthDay(month, day, nowMs);
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day}),
      {precision: "date", raw: text},
    );
  }

  match = text.match(/今天\s*(\d{1,2})[:：](\d{2})/);
  if (match) {
    const [, hour, minute] = match;
    const {year, month, day} = getShanghaiDateParts(nowMs);
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day, hour, minute}),
      {raw: text},
    );
  }

  match = text.match(/昨天\s*(?:(\d{1,2})[:：](\d{2}))?/);
  if (match) {
    const {year, month, day} = getShanghaiDateParts(nowMs);
    const hour = match[1] || 0;
    const minute = match[2] || 0;
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day: day - 1, hour, minute}),
      {precision: match[1] ? "exact" : "date", raw: text},
    );
  }

  match = text.match(/前天\s*(?:(\d{1,2})[:：](\d{2}))?/);
  if (match) {
    const {year, month, day} = getShanghaiDateParts(nowMs);
    const hour = match[1] || 0;
    const minute = match[2] || 0;
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day: day - 2, hour, minute}),
      {precision: match[1] ? "exact" : "date", raw: text},
    );
  }

  match = text.match(/(\d+)\s*分钟前/);
  if (match) {
    return createMonitorPublishMoment(nowMs - Number(match[1]) * 60 * 1000, {
      raw: text,
    });
  }

  match = text.match(/(\d+)\s*小时前/);
  if (match) {
    return createMonitorPublishMoment(nowMs - Number(match[1]) * 60 * 60 * 1000, {
      raw: text,
    });
  }

  match = text.match(/(\d+)\s*天前\s*(?:(\d{1,2})[:：](\d{2}))?/);
  if (match) {
    const days = Number(match[1]) || 0;
    if (match[2]) {
      const {year, month, day} = getShanghaiDateParts(nowMs);
      return createMonitorPublishMoment(
        buildShanghaiTimestamp({
          year,
          month,
          day: day - days,
          hour: match[2],
          minute: match[3] || 0,
        }),
        {raw: text},
      );
    }
    const dayStartMs = getShanghaiDayStartMs(nowMs - days * MONITOR_DAY_MS);
    return createMonitorPublishMoment(dayStartMs, {
      precision: "date",
      raw: text,
    });
  }

  if (/刚刚|刚才|现在/.test(text)) {
    return createMonitorPublishMoment(nowMs, {raw: text});
  }

  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    return createMonitorPublishMoment(parsed, {raw: text});
  }

  return null;
}

function collectMonitorPublishCandidates(record = {}) {
  const payload =
    record?.payload && typeof record.payload === "object" ? record.payload : {};
  const item =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === "object"
      ? payload.items[0]
      : {};
  const detail =
    payload.detailPayload && typeof payload.detailPayload === "object"
      ? payload.detailPayload
      : {};

  return [
    {value: detail.publishTimestamp, source: "detail.publishTimestamp"},
    {value: detail.publishTime, source: "detail.publishTime"},
    {value: detail.publishDateRaw, source: "detail.publishDateRaw"},
    {value: detail.lastEditedAt, source: "detail.lastEditedAt"},
    {value: detail.publishDate, source: "detail.publishDate"},
    {value: item.publishTimestamp, source: "item.publishTimestamp"},
    {value: item.publishTime, source: "item.publishTime"},
    {value: item.publishDateRaw, source: "item.publishDateRaw"},
    {value: item.lastEditedAt, source: "item.lastEditedAt"},
    {value: item.publishDate, source: "item.publishDate"},
    {value: payload.publishTimestamp, source: "payload.publishTimestamp"},
    {value: payload.publishTime, source: "payload.publishTime"},
    {value: payload.publishDateRaw, source: "payload.publishDateRaw"},
    {value: payload.lastEditedAt, source: "payload.lastEditedAt"},
    {value: payload.publishDate, source: "payload.publishDate"},
  ];
}

function isLikelyFallbackCaptureTime(record, candidate, moment) {
  const source = String(candidate?.source || "");
  if (!/lastEditedAt/i.test(source) || !moment?.timestampMs) {
    return false;
  }

  const rawDateSignals = collectMonitorPublishCandidates(record).some((item) => {
    const candidateSource = String(item.source || "");
    return (
      !/lastEditedAt/i.test(candidateSource) &&
      cleanMonitorPublishText(item.value)
    );
  });
  if (rawDateSignals) {
    return false;
  }

  const payload =
    record?.payload && typeof record.payload === "object" ? record.payload : {};
  const detail =
    payload.detailPayload && typeof payload.detailPayload === "object"
      ? payload.detailPayload
      : {};
  const captureTimestamp = Number(
    detail.captureTimestamp ||
      payload.detailCaptureFinishedAt ||
      payload.captureTimestamp ||
      record.updatedAt ||
      0,
  );
  return (
    Number.isFinite(captureTimestamp) &&
    captureTimestamp > 0 &&
    Math.abs(moment.timestampMs - captureTimestamp) <= 2 * 60 * 1000
  );
}

function resolveMonitorRecordPublishMoment(record, nowMs = Date.now()) {
  const candidates = collectMonitorPublishCandidates(record);
  for (const candidate of candidates) {
    const moment = parseMonitorPublishMoment(candidate.value, nowMs);
    if (!moment) {
      continue;
    }
    if (isLikelyFallbackCaptureTime(record, candidate, moment)) {
      continue;
    }
    return {
      ...moment,
      source: candidate.source,
    };
  }
  return null;
}

function isMonitorPublishMomentInWindow(moment, bounds) {
  if (!bounds?.strict) {
    return true;
  }
  if (!moment?.ok) {
    return false;
  }
  if (moment.precision === "date") {
    return moment.startMs >= bounds.startMs && moment.endMs <= bounds.endMs;
  }
  return moment.timestampMs >= bounds.startMs && moment.timestampMs < bounds.endMs;
}

async function resolveMonitorRecordIdsForPublishWindow({
  recordIds = [],
  monitorSettings = {},
  captureSettings = {},
  displayName = "",
  index = 0,
  total = 1,
  shouldStop = null,
} = {}) {
  const uniqueRecordIds = [...new Set(recordIds.filter(Boolean))];
  const bounds = resolveMonitorPublishWindowBounds(
    monitorSettings.publishWindow || DEFAULT_MONITOR_SETTINGS.publishWindow,
  );

  if (!bounds.strict || uniqueRecordIds.length === 0) {
    return {
      recordIds: uniqueRecordIds,
      scannedCount: uniqueRecordIds.length,
      filteredCount: 0,
      unknownCount: 0,
      windowLabel: bounds.label,
      detailResult: null,
    };
  }

  const preRecords = await getRecords(uniqueRecordIds);
  const preRecordById = new Map(preRecords.map((record) => [record.id, record]));
  const prefilterNowMs = Date.now();
  let unknownCandidateCount = 0;
  const detailCandidateIds = uniqueRecordIds.filter((recordId) => {
    const moment = resolveMonitorRecordPublishMoment(
      preRecordById.get(recordId),
      prefilterNowMs,
    );
    if (!moment) {
      unknownCandidateCount += 1;
      return unknownCandidateCount <= MONITOR_UNKNOWN_PUBLISH_DETAIL_LIMIT;
    }
    return isMonitorPublishMomentInWindow(moment, bounds);
  });

  if (detailCandidateIds.length === 0) {
    return {
      recordIds: [],
      scannedCount: uniqueRecordIds.length,
      filteredCount: uniqueRecordIds.length,
      unknownCount: 0,
      windowLabel: bounds.label,
      detailResult: null,
    };
  }

  if (typeof shouldStop === "function" && shouldStop()) {
    return {
      recordIds: [],
      scannedCount: uniqueRecordIds.length,
      filteredCount: uniqueRecordIds.length,
      unknownCount: 0,
      windowLabel: bounds.label,
      detailResult: {canceled: true},
      canceled: true,
    };
  }

  showProgress(
    `正在读取发布时间 (${index + 1}/${total})：${displayName} · ${bounds.label}`,
  );
  const detailResult = await batchCaptureDetailsForRecords(detailCandidateIds, {
    shouldStop,
    onProgress: (progress = {}) => {
      const message =
        String(progress.message || "").trim() || "正在补采作品详情...";
      showProgress(
        `正在读取发布时间 (${index + 1}/${total})：${displayName} · ${message}`,
      );
    },
    includeComments: false,
    includeBloggerMetrics: false,
    detailNavTimeoutMs: captureSettings.detailNavTimeoutMs,
    detailAfterNavWaitMs: captureSettings.detailAfterNavWaitMs,
    profileAfterNavWaitMs: captureSettings.profileAfterNavWaitMs,
  });

  const records = await getRecords(detailCandidateIds);
  if (
    detailResult?.canceled ||
    (typeof shouldStop === "function" && shouldStop())
  ) {
    return {
      recordIds: [],
      scannedCount: uniqueRecordIds.length,
      filteredCount: uniqueRecordIds.length,
      unknownCount: 0,
      windowLabel: bounds.label,
      detailResult,
      canceled: true,
    };
  }

  const recordById = new Map(records.map((record) => [record.id, record]));
  const selectedIds = [];
  let unknownCount = 0;
  const nowMs = Date.now();

  detailCandidateIds.forEach((recordId) => {
    const record = recordById.get(recordId);
    const moment = resolveMonitorRecordPublishMoment(record, nowMs);
    if (!moment) {
      unknownCount += 1;
      return;
    }
    if (isMonitorPublishMomentInWindow(moment, bounds)) {
      selectedIds.push(recordId);
    }
  });

  return {
    recordIds: selectedIds,
    scannedCount: uniqueRecordIds.length,
    filteredCount: Math.max(0, uniqueRecordIds.length - selectedIds.length),
    unknownCount,
    windowLabel: bounds.label,
    detailResult,
  };
}

async function finishMonitorExecutionSafely(executionId, result = {}) {
  if (!executionId) {
    return {ok: false, message: "missing execution id"};
  }

  try {
    return await finishMonitorExecution(executionId, result);
  } catch (error) {
    console.warn("[Sidebar] Finish monitor execution failed:", error);
    return {
      ok: false,
      message: error?.message || "finish monitor execution failed",
    };
  }
}

async function executeMonitorRunItem({
  runItem = {},
  monitorItem = {},
  index = 0,
  total = 1,
  monitorSettings = {},
  captureSettings = {},
  shouldStop = null,
} = {}) {
  const subscriptionId = String(
    runItem.subscriptionId || monitorItem.id || "",
  ).trim();
  const executionId = String(runItem.executionId || "").trim();
  const platform = normalizeMonitorRunnerPlatform(
    runItem.platform || monitorItem.platform,
  );
  const accountUrl = resolveMonitorRunnerAccountUrl(runItem, monitorItem);
  const displayName = resolveMonitorRunnerName(runItem, monitorItem);
  const baseResult = {
    ...runItem,
    subscriptionId,
    executionId,
    platform,
    monitorBloggerName: displayName,
    monitorBloggerUrl: accountUrl,
    bloggerUrl: accountUrl,
    scannedCount: 0,
    hitCount: 0,
  };

  if (!executionId) {
    return {
      ...baseResult,
      status: "failed",
      errorCode: "missing_execution_id",
      errorMessage: "缺少监控执行任务 ID",
    };
  }

  if (!accountUrl) {
    await finishMonitorExecutionSafely(executionId, {
      status: "failed",
      errorMessage: "监控账号主页链接为空",
    });
    return {
      ...baseResult,
      status: "failed",
      errorCode: "missing_account_url",
      errorMessage: "监控账号主页链接为空",
    };
  }

  if (typeof shouldStop === "function" && shouldStop()) {
    await finishMonitorExecutionSafely(executionId, {
      status: "failed",
      errorMessage: "采集已取消",
    });
    return {
      ...baseResult,
      status: "failed",
      errorCode: "capture_canceled",
      errorMessage: "采集已取消",
    };
  }

  try {
    showProgress(
      `正在扫描监控账号 (${index + 1}/${total})：${displayName}`,
    );

    const startResult = await startMonitorExecution(executionId);
    if (!startResult?.ok && !runItem.existing) {
      console.warn("[Sidebar] Start monitor execution returned false:", startResult);
    }

    const captureResult = await batchCaptureByUrls({
      urls: [accountUrl],
      mode: "blogger_notes",
      captureParams: resolveMonitorRunnerCaptureParams(
        monitorSettings,
        captureSettings,
      ),
      onProgress: (progress = {}) => {
        const message =
          String(progress.message || "").trim() || "正在采集账号作品...";
        showProgress(
          `正在扫描监控账号 (${index + 1}/${total})：${displayName} · ${message}`,
        );
      },
      shouldStop,
    });
    const recordIds = collectBatchRecordIds(captureResult);

    if (captureResult?.canceled) {
      await finishMonitorExecutionSafely(executionId, {
        status: "failed",
        recordsFound: recordIds.length,
        errorMessage: "采集已取消",
      });
      return {
        ...baseResult,
        status: "failed",
        scannedCount: recordIds.length,
        hitCount: 0,
        errorCode: "capture_canceled",
        errorMessage: "采集已取消",
      };
    }

    if (!captureResult?.ok && recordIds.length === 0) {
      const errorMessage =
        captureResult?.results?.find((item) => item?.error)?.error ||
        "采集账号作品失败";
      await finishMonitorExecutionSafely(executionId, {
        status: "failed",
        errorMessage,
      });
      return {
        ...baseResult,
        status: "failed",
        errorCode: "capture_failed",
        errorMessage,
      };
    }

    if (recordIds.length === 0) {
      await finishMonitorExecutionSafely(executionId, {
        status: "succeeded",
        recordsFound: 0,
        newRecords: 0,
        updatedRecords: 0,
        negativeCount: 0,
      });
      return {
        ...baseResult,
        status: "no_hit",
        scannedCount: 0,
        hitCount: 0,
      };
    }

    const publishFilterResult = await resolveMonitorRecordIdsForPublishWindow({
      recordIds,
      monitorSettings,
      captureSettings,
      displayName,
      index,
      total,
      shouldStop,
    });

    if (publishFilterResult.canceled) {
      await finishMonitorExecutionSafely(executionId, {
        status: "failed",
        recordsFound: recordIds.length,
        errorMessage: "采集已取消",
      });
      return {
        ...baseResult,
        status: "failed",
        scannedCount: publishFilterResult.scannedCount,
        hitCount: 0,
        errorCode: "capture_canceled",
        errorMessage: "采集已取消",
        captureResult,
        detailResult: publishFilterResult.detailResult,
      };
    }
    const hitRecordIds = publishFilterResult.recordIds;

    if (hitRecordIds.length === 0) {
      await finishMonitorExecutionSafely(executionId, {
        status: "succeeded",
        recordsFound: 0,
        newRecords: 0,
        updatedRecords: 0,
        negativeCount: 0,
      });
      return {
        ...baseResult,
        status: "no_hit",
        scannedCount: publishFilterResult.scannedCount,
        hitCount: 0,
        filteredCount: publishFilterResult.filteredCount,
        unknownPublishTimeCount: publishFilterResult.unknownCount,
        publishWindowLabel: publishFilterResult.windowLabel,
        captureResult,
        detailResult: publishFilterResult.detailResult,
      };
    }

    showProgress(
      `正在同步监控命中 (${index + 1}/${total})：${displayName} · ${hitRecordIds.length}/${publishFilterResult.scannedCount} 条符合${publishFilterResult.windowLabel}`,
    );
    const syncResult = await syncRecordBatch(
      hitRecordIds,
      (progress = {}) => {
        const message =
          String(progress.message || "").trim() || "正在同步监控命中...";
        showProgress(
          `正在同步监控命中 (${index + 1}/${total})：${displayName} · ${message}`,
        );
      },
      {
        trigger: "monitor_run_now",
        syncScope: "all",
        monitorExecutionId: executionId,
        captureSettings,
        commentLeadsConfig: buildCommentLeadsConfigFromSettings(captureSettings),
      },
    );
    const syncStats = summarizeMonitorSyncResult(syncResult);
    const hasSyncFailure =
      !syncResult?.ok || syncStats.failedCount > 0 || syncStats.successCount === 0;
    const errorMessage = hasSyncFailure
      ? syncResult?.message ||
        syncResult?.error?.message ||
        `监控命中同步失败 ${syncStats.failedCount} 条`
      : "";

    await finishMonitorExecutionSafely(executionId, {
      status: hasSyncFailure ? "failed" : "succeeded",
      recordsFound: hitRecordIds.length,
      newRecords: syncStats.insertedCount,
      updatedRecords: syncStats.updatedCount,
      negativeCount: syncStats.negativeCount,
      errorMessage,
    });

    return {
      ...baseResult,
      status: hasSyncFailure ? "failed" : "success",
      scannedCount: publishFilterResult.scannedCount,
      hitCount: syncStats.successCount,
      filteredCount: publishFilterResult.filteredCount,
      unknownPublishTimeCount: publishFilterResult.unknownCount,
      publishWindowLabel: publishFilterResult.windowLabel,
      errorCode: hasSyncFailure ? "sync_failed" : "",
      errorMessage,
      syncResult,
      captureResult,
      detailResult: publishFilterResult.detailResult,
    };
  } catch (error) {
    const errorMessage = error?.message || "监控执行失败";
    await finishMonitorExecutionSafely(executionId, {
      status: "failed",
      errorMessage,
    });
    return {
      ...baseResult,
      status: "failed",
      errorCode: "runner_failed",
      errorMessage,
    };
  }
}

async function handleRunMonitorNow() {
  if (!isMonitorAuthReady()) {
    showMessage(MONITOR_REQUIRED_MESSAGE, "warning");
    return;
  }

  if (batchUrlCaptureInFlight || batchKeywordCaptureInFlight || monitorRunInFlight) {
    showMessage("已有采集任务执行中，请完成后再执行监控扫描", "warning");
    return;
  }

  const monitor = getCurrentMonitor() || {};
  const activeItems = Array.isArray(monitor.items)
    ? monitor.items.filter(
        (item) => String(item?.status || "").trim() === MONITOR_STATUS.ACTIVE,
      )
    : [];

  if (activeItems.length === 0) {
    showMessage("暂无启用中的监控项可执行", "info");
    return;
  }

  const startedAt = Date.now();
  monitorRunInFlight = true;
  monitorRunCancelRequested = false;
  showProgress(`正在立即执行 ${activeItems.length} 个监控账号...`);
  try {
    const runtime = getCurrentRuntime() || {};
    let activeTabUrl = "";
    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      activeTabUrl = String(activeTab?.url || "").trim();
    } catch {
      activeTabUrl = "";
    }
    const pageUrl = activeTabUrl || String(runtime?.lastPageUrl || "").trim();
    const pagePlatform = detectPlatformFromUrl(pageUrl);
    const filterPlatform = String(monitor?.filters?.platform || "")
      .trim()
      .toLowerCase();
    const currentPlatform =
      pagePlatform === "douyin" ||
      pagePlatform === "xiaohongshu" ||
      pagePlatform === "weibo"
        ? pagePlatform
        : filterPlatform;
    const result = await runMonitorNow({
      platform:
        currentPlatform === "douyin" ||
        currentPlatform === "xiaohongshu" ||
        currentPlatform === "weibo"
          ? currentPlatform
          : "",
    });
    if (!result?.ok) {
      throw new Error(result?.message || "立即执行失败");
    }

    const data = result.data || {};
    await loadMonitorSubscriptions({force: true});
    const latestMonitor = getCurrentMonitor() || monitor;
    const monitorById = new Map(
      (Array.isArray(latestMonitor.items) ? latestMonitor.items : []).map(
        (item) => [String(item?.id || "").trim(), item],
      ),
    );
    const queuedItems = Array.isArray(data.items) ? data.items : [];
    const captureSettings = await getCaptureSettings();
    const monitorSettings = normalizeMonitorSettingsInput(
      latestMonitor.settings || monitor.settings || DEFAULT_MONITOR_SETTINGS,
    );
    const runItems = [];

    for (let i = 0; i < queuedItems.length; i += 1) {
      if (monitorRunCancelRequested) {
        break;
      }
      const queuedItem = queuedItems[i];
      const subscriptionId = String(queuedItem?.subscriptionId || "").trim();
      const monitorItem = monitorById.get(subscriptionId) || {};
      const runResult = await executeMonitorRunItem({
        runItem: queuedItem,
        monitorItem,
        index: i,
        total: queuedItems.length,
        monitorSettings,
        captureSettings,
        shouldStop: () => monitorRunCancelRequested,
      });
      runItems.push(runResult);
      if (monitorRunCancelRequested) {
        break;
      }
    }

    const finishedAt = Date.now();
    await loadMonitorSubscriptions({force: true});
    const targetTableName = String(
      getCurrentTarget()?.monitorTableName || "",
    ).trim();
    const normalizedRuns = runItems.map((item) => {
      const subscriptionId = String(item?.subscriptionId || "").trim();
      const monitorItem = monitorById.get(subscriptionId) || {};
      const normalizedPlatform = String(
        item?.platform || monitorItem?.platform || "",
      )
        .trim()
        .toLowerCase();
      const state = resolveMonitorRunHistoryState(item);
      const executionId = String(item?.executionId || "").trim();
      const debugUrl = String(item?.debugUrl || "").trim();

      return {
        item,
        state,
        subscriptionId,
        executionId,
        debugUrl,
        platform:
          normalizedPlatform === "douyin" ||
          normalizedPlatform === "xiaohongshu" ||
          normalizedPlatform === "weibo"
            ? normalizedPlatform
            : "unknown",
        monitorBloggerName: String(
          item?.monitorBloggerName ||
            monitorItem?.bloggerNameSnapshot ||
            monitorItem?.bloggerName ||
            "",
        ).trim(),
        monitorBloggerUrl: String(
          item?.monitorBloggerUrl || monitorItem?.bloggerUrl || "",
        ).trim(),
      };
    });

    const counts = normalizedRuns.reduce(
      (acc, current) => {
        if (current.state.monitorStatus === "queued") {
          acc.queued += 1;
        } else if (current.state.monitorStatus === "hit_synced") {
          acc.hitSynced += 1;
        } else if (current.state.monitorStatus === "hit_sync_failed") {
          acc.hitSyncFailed += 1;
        } else if (current.state.monitorStatus === "no_hit") {
          acc.noHit += 1;
        } else if (current.state.monitorStatus === "credit_insufficient") {
          acc.creditInsufficient += 1;
        } else {
          acc.executionFailed += 1;
        }
        return acc;
      },
      {
        queued: 0,
        hitSynced: 0,
        hitSyncFailed: 0,
        noHit: 0,
        creditInsufficient: 0,
        executionFailed: 0,
      },
    );
    const monitorStatus =
      counts.executionFailed > 0
        ? "execution_failed"
        : counts.hitSyncFailed > 0
          ? "hit_sync_failed"
          : counts.hitSynced > 0
            ? "hit_synced"
            : counts.noHit > 0
              ? "no_hit"
              : counts.queued > 0
                ? "queued"
                : counts.creditInsufficient > 0
                  ? "credit_insufficient"
                  : "no_hit";
    const monitorStatusLabel =
      monitorStatus === "execution_failed"
        ? "执行失败"
        : monitorStatus === "hit_sync_failed"
          ? "已命中"
          : monitorStatus === "hit_synced"
            ? "已命中"
            : monitorStatus === "credit_insufficient"
              ? "配额不足"
              : monitorStatus === "queued"
                ? "已排队"
                : "未命中";
    const monitorSyncLabel =
      monitorStatus === "hit_sync_failed"
        ? "同步失败"
        : monitorStatus === "hit_synced"
          ? "已同步"
          : "";
    const monitorSummaryParts = [];
    if (counts.hitSynced > 0) {
      monitorSummaryParts.push(`已命中并同步 ${counts.hitSynced}`);
    }
    if (counts.hitSyncFailed > 0) {
      monitorSummaryParts.push(`已命中但同步失败 ${counts.hitSyncFailed}`);
    }
    if (counts.noHit > 0) {
      monitorSummaryParts.push(`未命中 ${counts.noHit}`);
    }
    if (counts.creditInsufficient > 0) {
      monitorSummaryParts.push(`配额不足 ${counts.creditInsufficient}`);
    }
    if (counts.queued > 0) {
      monitorSummaryParts.push(`已排队 ${counts.queued}`);
    }
    if (counts.executionFailed > 0) {
      monitorSummaryParts.push(`执行失败 ${counts.executionFailed}`);
    }
    const monitorSummary =
      monitorSummaryParts.join(" / ") ||
      (runItems.length === 0 ? "无可执行监控项" : "监控执行完成");
    const platforms = Array.from(
      new Set(normalizedRuns.map((item) => item.platform)),
    );
    const historyPlatform =
      platforms.length === 1 &&
      (platforms[0] === "douyin" ||
        platforms[0] === "xiaohongshu" ||
        platforms[0] === "weibo")
        ? platforms[0]
        : "unknown";

    await addSyncHistoryEntry({
      trigger: "monitor_run_now",
      syncScope: "all",
      startedAt,
      finishedAt,
      totalCount: runItems.length,
      requestedTotalCount: runItems.length,
      noHitCount: counts.noHit,
      skippedCount: counts.creditInsufficient,
      successCount: counts.hitSynced + counts.noHit + counts.queued,
      failedCount: counts.hitSyncFailed + counts.executionFailed,
      debugUrl:
        normalizedRuns.find((item) => Boolean(item.debugUrl))?.debugUrl || null,
      platform: historyPlatform,
      syncType: "monitor_hits",
      workflow: "monitor_runner",
      target: {
        tableName: targetTableName,
      },
      recordIds: normalizedRuns.map((item) => item.executionId).filter(Boolean),
      skippedRecordIds: [],
      monitorStatus,
      monitorStatusLabel,
      monitorSyncLabel,
      monitorSummary,
      monitorSubscriptionId: "",
      monitorBloggerName: "",
      monitorBloggerUrl: "",
      items: normalizedRuns.map((item) => ({
        recordId: item.executionId,
        platform: item.platform,
        type: "monitor_hits",
        workflow: "monitor_runner",
        success: item.state.isSuccess,
        reason: item.state.reason,
        message: item.state.message,
        debugUrl: item.debugUrl || null,
        rawResponse: {
          ...item.item,
          monitorBloggerName: item.monitorBloggerName,
          monitorBloggerUrl: item.monitorBloggerUrl,
        },
        error:
          item.state.reason !== ERROR_REASON.NONE
            ? {
                code: item.state.reason,
                message: item.state.message,
              }
            : null,
      })),
    });

    await refreshSyncHistory();
    await refreshVerifiedAuthSnapshot();

    if (runItems.length === 0) {
      showMessage(
        monitorRunCancelRequested
          ? "已取消本次监控扫描"
          : "立即执行完成：无可执行监控项",
        "info",
      );
    } else {
      const hasWarning = runItems.some((item) => {
        const state = resolveMonitorRunHistoryState(item);
        return (
          state.monitorStatus === "credit_insufficient" ||
          state.monitorStatus === "execution_failed" ||
          state.monitorStatus === "hit_sync_failed"
        );
      });
      if (counts.creditInsufficient > 0) {
        showMessage(
          `本次有 ${counts.creditInsufficient} 个监控项因配额不足未执行。获取更多配额后可立即重试。`,
          "warning",
        );
      } else {
        const hitRecords = runItems.reduce(
          (sum, item) => sum + Math.max(0, Number(item?.hitCount || 0)),
          0,
        );
        showMessage(
          `立即执行完成：扫描 ${runItems.length} 个监控项，采集并同步 ${hitRecords} 条内容`,
          hasWarning ? "warning" : "success",
        );
      }
    }
  } catch (error) {
    console.error("[Sidebar] Run monitor now failed:", error);
    showMessage(`立即执行失败: ${error.message}`, "error");
  } finally {
    monitorRunInFlight = false;
    monitorRunCancelRequested = false;
    hideProgress();
  }
}

async function refreshVerifiedAuthSnapshot({showFeedback = false} = {}) {
  const auth = getCurrentAuth() || {};
  if (!isAuthVerified(auth) || !auth.code) {
    return {ok: false, skipped: true};
  }

  try {
    const result = await verify(auth.code);
    if (!result?.ok) {
      if (showFeedback) {
        showMessage(result?.message || "刷新授权信息失败", "warning");
      }
      return {
        ok: false,
        error: result?.error || {
          message: result?.message || "refresh auth failed",
        },
      };
    }

    const authSnapshot = authSnapshotFromVerifyResult(result, auth);
    await setCurrentAuth({
      verified: true,
      status: AUTH_STATUS.VERIFIED,
      code: auth.code,
      lastVerifiedAt: new Date().toISOString(),
      message: result.message || auth.message || "",
      reason: "none",
      ...authSnapshot,
    });

    if (showFeedback) {
      showMessage("授权信息已刷新", "success");
    }

    return {ok: true, data: result.data || null};
  } catch (error) {
    console.error("[Sidebar] Refresh auth snapshot failed:", error);
    if (showFeedback) {
      showMessage(`刷新授权信息失败: ${error.message}`, "error");
    }
    return {
      ok: false,
      error: {
        message: error?.message || "refresh auth snapshot failed",
      },
    };
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

function authResponseValue(result, key, fallback = null) {
  if (result?.data && Object.prototype.hasOwnProperty.call(result.data, key)) {
    return result.data[key];
  }
  if (result && Object.prototype.hasOwnProperty.call(result, key)) {
    return result[key];
  }
  return fallback;
}

function authSnapshotFromVerifyResult(result, currentAuth = {}) {
  return {
    user: authResponseValue(result, "user", currentAuth.user ?? null),
    tenant: authResponseValue(result, "tenant", currentAuth.tenant ?? null),
    credentialCredit: authResponseValue(result, "credentialCredit", null),
    credential: authResponseValue(result, "credential", currentAuth.credential ?? null),
    binding: authResponseValue(result, "binding", currentAuth.binding ?? null),
  };
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

async function handleMonitorListClick(event) {
  const actionButton = event.target.closest(
    ".btn-monitor-toggle, .btn-monitor-delete",
  );
  if (!actionButton) {
    return;
  }

  const subscriptionId = String(actionButton.dataset.id || "").trim();
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

  if (actionButton.classList.contains("btn-monitor-toggle")) {
    const nextStatus = String(
      actionButton.dataset.nextStatus || MONITOR_STATUS.PAUSED,
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

  if (actionButton.classList.contains("btn-monitor-delete")) {
    const confirmed = window.confirm?.(
      "删除后该监控项将从当前列表移除，是否继续？",
    );
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

/**
 * 处理保存目标配置
 */
async function handleSaveTarget() {
  const feishuAppToken = document
    .getElementById("inputFeishuAppToken")
    ?.value.trim();
  const tableId =
    document.getElementById("inputTableId")?.value.trim() ||
    DEFAULT_SINGLE_NOTE_TABLE_NAME;
  const keywordNotesTableName =
    document.getElementById("inputKeywordNotesTableName")?.value.trim() ||
    DEFAULT_KEYWORD_NOTES_TABLE_NAME;
  const bloggerProfileTableName =
    document.getElementById("inputBloggerProfileTableName")?.value.trim() ||
    DEFAULT_BLOGGER_PROFILE_TABLE_NAME;
  const bloggerNotesTableName =
    document.getElementById("inputBloggerNotesTableName")?.value.trim() ||
    DEFAULT_BLOGGER_NOTES_TABLE_NAME;
  const commentLeadsTableName =
    document.getElementById("inputCommentLeadsTableName")?.value.trim() ||
    DEFAULT_COMMENT_LEADS_TABLE_NAME;
  const monitorTableName =
    document.getElementById("inputMonitorTableName")?.value.trim() ||
    DEFAULT_MONITOR_TABLE_NAME;
  const reportWebhookUrl =
    document.getElementById("inputReportWebhookUrl")?.value.trim() || "";

  if (!feishuAppToken) {
    showMessage("请填写 App Token", "error");
    return;
  }

  try {
    const nextTarget = {
      feishuAppToken,
      tableId,
      keywordNotesTableName,
      bloggerProfileTableName,
      bloggerNotesTableName,
      commentLeadsTableName,
      monitorTableName,
      reportWebhookUrl,
    };
    await setCurrentTarget(nextTarget);

    const auth = getCurrentAuth() || {};
    if (auth.verified) {
      const saveResult = await saveTargetConfig({
        ...nextTarget,
        isConfigured: true,
      });
      if (!saveResult?.ok) {
        throw new Error(saveResult?.message || "后端保存失败");
      }
      if (saveResult.data?.target) {
        await setCurrentTarget(saveResult.data.target);
      }
    }

    showMessage("配置保存成功！", "success");
  } catch (error) {
    console.error("[Sidebar] Save target failed:", error);
    showMessage("保存失败: " + error.message, "error");
  }
}

async function syncTargetConfigAfterVerify() {
  const localTarget = getCurrentTarget() || {};
  const hasLocalTarget =
    localTarget &&
    typeof localTarget === "object" &&
    Boolean(localTarget.feishuAppToken);

  const remoteTarget = await getTargetConfig();
  if (remoteTarget?.ok && remoteTarget.data?.target) {
    const remoteConfig = remoteTarget.data.target;
    const hasRemoteTarget =
      remoteConfig &&
      typeof remoteConfig === "object" &&
      Boolean(remoteConfig.feishuAppToken);

    if (hasRemoteTarget || !hasLocalTarget) {
      await setCurrentTarget(remoteConfig);
      return;
    }
  }

  if (hasLocalTarget) {
    const saveResult = await saveTargetConfig({
      ...localTarget,
      isConfigured: true,
    });
    if (saveResult?.ok && saveResult.data?.target) {
      await setCurrentTarget(saveResult.data.target);
    }
  }
}

async function initCaptureSettingsUI() {
  try {
    const settings = await getCaptureSettings();
    const auth = getCurrentAuth() || {};
    const authVerified = isAuthVerified(auth);
    const includeComments = Boolean(settings.includeCommentsOnNoteCapture);
    const includeBloggerMetrics = Boolean(
      settings.includeBloggerMetricsOnNoteCapture,
    );
    const autoDetailCaptureAfterListCapture =
      authVerified && Boolean(settings.autoDetailCaptureAfterListCapture);
    const includeCommentsOnDetailCapture =
      authVerified && Boolean(settings.includeCommentsOnDetailCapture);
    const detailCommentsMaxDetectedItems = Number(
      settings.detailCommentsMaxDetectedItems ||
        settings.commentsMaxDetectedItems,
    );
    const enableCommentLeadsFilterOnDetailCapture =
      authVerified && Boolean(settings.enableCommentLeadsFilterOnDetailCapture);
    const includeBloggerMetricsOnDetailCapture =
      authVerified && Boolean(settings.includeBloggerMetricsOnDetailCapture);

    if (
      !authVerified &&
      (settings.autoDetailCaptureAfterListCapture ||
        settings.includeCommentsOnDetailCapture ||
        settings.enableCommentLeadsFilterOnDetailCapture ||
        settings.includeBloggerMetricsOnDetailCapture)
    ) {
      await saveCaptureSettings({
        autoDetailCaptureAfterListCapture: false,
        includeCommentsOnDetailCapture: false,
        enableCommentLeadsFilterOnDetailCapture: false,
        includeBloggerMetricsOnDetailCapture: false,
      });
    }

    const inputSyncScope = document.getElementById("inputSyncScope");
    if (inputSyncScope) {
      inputSyncScope.value = readSyncScopeFromInput(settings.syncScope);
    }
    const inputDetailCaptureScope = document.getElementById(
      "inputDetailCaptureScope",
    );
    if (inputDetailCaptureScope) {
      inputDetailCaptureScope.value = readDetailCaptureScopeFromInput(
        settings.detailCaptureScope,
      );
    }
    const checkboxSkipOfficialAccounts = document.getElementById(
      "checkboxSkipOfficialAccounts",
    );
    if (checkboxSkipOfficialAccounts) {
      checkboxSkipOfficialAccounts.checked =
        settings.skipOfficialAccounts !== false;
    }

    const checkbox = document.getElementById("checkboxCaptureComments");
    if (checkbox) {
      checkbox.checked = includeComments;
    }
    const checkboxEnableCommentLeadsFilter = document.getElementById(
      "checkboxEnableCommentLeadsFilter",
    );
    if (checkboxEnableCommentLeadsFilter) {
      checkboxEnableCommentLeadsFilter.checked = Boolean(
        includeComments && settings.enableCommentLeadsFilter,
      );
    }
    syncBloggerMetricsCaptureControls({
      includeBloggerMetrics,
    });
    syncAutoDetailCaptureControls({
      autoDetailCapture: autoDetailCaptureAfterListCapture,
      includeComments: includeCommentsOnDetailCapture,
      commentsMaxDetectedItems: detailCommentsMaxDetectedItems,
      enableCommentLeadsFilter: enableCommentLeadsFilterOnDetailCapture,
      includeBloggerMetrics: includeBloggerMetricsOnDetailCapture,
    });
    // 「增量采集」勾选已挪到「点赞数」下面,不在 detail 面板内,单独按 settings 回填(document 级)
    document
      .querySelectorAll('[data-detail-setting="skip-captured"]')
      .forEach((el) => {
        el.checked = settings.skipAlreadyCapturedOnDetailCapture !== false;
      });

    const inputCommentsMaxDetectedItems = document.getElementById(
      "inputCommentsMaxDetectedItems",
    );
    if (inputCommentsMaxDetectedItems) {
      inputCommentsMaxDetectedItems.value = String(
        settings.commentsMaxDetectedItems,
      );
    }
    const inputCommentLeadsKeywords = document.getElementById(
      "inputCommentLeadsKeywords",
    );
    if (inputCommentLeadsKeywords) {
      inputCommentLeadsKeywords.value = String(
        settings.commentLeadsKeywords || "",
      );
    }
    const inputCommentLeadsIps = document.getElementById(
      "inputCommentLeadsIps",
    );
    if (inputCommentLeadsIps) {
      inputCommentLeadsIps.value = String(settings.commentLeadsIps || "");
    }
    syncCommentsCaptureControls({
      includeComments,
      forceDisabled: false,
    });

    const inputSharedWaitMinSec = document.getElementById(
      "inputSharedWaitMinSec",
    );
    if (inputSharedWaitMinSec) {
      inputSharedWaitMinSec.value = String(
        Math.floor(settings.sharedWaitMinMs / 1000),
      );
    }

    const inputSharedWaitMaxSec = document.getElementById(
      "inputSharedWaitMaxSec",
    );
    if (inputSharedWaitMaxSec) {
      inputSharedWaitMaxSec.value = String(
        Math.floor(settings.sharedWaitMaxMs / 1000),
      );
    }

    const inputSharedStallTimeoutSec = document.getElementById(
      "inputSharedStallTimeoutSec",
    );
    if (inputSharedStallTimeoutSec) {
      inputSharedStallTimeoutSec.value = String(
        Math.floor(settings.sharedStallTimeoutMs / 1000),
      );
    }

    const inputSharedMaxDurationSec = document.getElementById(
      "inputSharedMaxDurationSec",
    );
    if (inputSharedMaxDurationSec) {
      inputSharedMaxDurationSec.value = String(
        Math.floor(settings.sharedMaxDurationMs / 1000),
      );
    }

    const inputDetailAfterNavWaitMs = document.getElementById(
      "inputDetailAfterNavWaitMs",
    );
    if (inputDetailAfterNavWaitMs) {
      inputDetailAfterNavWaitMs.value = formatMillisecondsAsSeconds(
        settings.detailAfterNavWaitMs,
      );
    }
    const inputDetailNavTimeoutMs = document.getElementById(
      "inputDetailNavTimeoutMs",
    );
    if (inputDetailNavTimeoutMs) {
      inputDetailNavTimeoutMs.value = formatMillisecondsAsSeconds(
        settings.detailNavTimeoutMs,
      );
    }
    const inputProfileAfterNavWaitMs = document.getElementById(
      "inputProfileAfterNavWaitMs",
    );
    if (inputProfileAfterNavWaitMs) {
      inputProfileAfterNavWaitMs.value = formatMillisecondsAsSeconds(
        settings.profileAfterNavWaitMs,
      );
    }

    const inputBloggerMinLikes = document.getElementById(
      "inputBloggerMinLikes",
    );
    if (inputBloggerMinLikes) {
      inputBloggerMinLikes.value = String(settings.bloggerMinLikes);
    }

    const inputBloggerMaxDetectedItems = document.getElementById(
      "inputBloggerMaxDetectedItems",
    );
    if (inputBloggerMaxDetectedItems) {
      inputBloggerMaxDetectedItems.value = String(
        settings.bloggerMaxDetectedItems,
      );
    }

    const inputBloggerKeywordFilter = document.getElementById(
      "inputBloggerKeywordFilter",
    );
    if (inputBloggerKeywordFilter) {
      inputBloggerKeywordFilter.value = settings.bloggerKeywordFilter || "";
    }
    updateBloggerKeywordFilterHint();

    const inputKeywordMinLikes = document.getElementById(
      "inputKeywordMinLikes",
    );
    if (inputKeywordMinLikes) {
      inputKeywordMinLikes.value = String(settings.keywordMinLikes);
    }
    applyKeywordSortDimensionToUI(keywordSortDimension);

    const inputKeywordMaxDetectedItems = document.getElementById(
      "inputKeywordMaxDetectedItems",
    );
    if (inputKeywordMaxDetectedItems) {
      inputKeywordMaxDetectedItems.value = String(
        settings.keywordMaxDetectedItems,
      );
    }
  } catch (error) {
    console.warn("[Sidebar] Init capture settings UI failed:", error);
  }
}

async function handleCaptureCommentsToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    syncCommentsCaptureControls({includeComments: checked});
    if (checked && !readRequiredCommentsMaxDetectedItemsFromInput()) {
      showMessage("请填写评论探测上限（正整数）", "warning");
      document.getElementById("inputCommentsMaxDetectedItems")?.focus();
    }
    const updates = {
      includeCommentsOnNoteCapture: checked,
    };
    if (!checked) {
      const leadsCheckbox = document.getElementById(
        "checkboxEnableCommentLeadsFilter",
      );
      if (leadsCheckbox?.checked) {
        leadsCheckbox.checked = false;
      }
      updates.enableCommentLeadsFilter = false;
    }
    await saveCaptureSettings(updates);
  } catch (error) {
    console.warn("[Sidebar] Save capture toggle failed:", error);
  }
}

async function handleCommentLeadsFilterToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    const commentsCheckbox = document.getElementById("checkboxCaptureComments");
    const updates = {
      enableCommentLeadsFilter: checked,
    };
    if (checked && commentsCheckbox && !commentsCheckbox.checked) {
      commentsCheckbox.checked = true;
      updates.includeCommentsOnNoteCapture = true;
      syncCommentsCaptureControls({includeComments: true});
    }

    await saveCaptureSettings(updates);
  } catch (error) {
    console.warn("[Sidebar] Save comment leads toggle failed:", error);
  }
}

async function handleCaptureBloggerMetricsToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    syncBloggerMetricsCaptureControls({includeBloggerMetrics: checked});
    await saveCaptureSettings({
      includeBloggerMetricsOnNoteCapture: checked,
    });
  } catch (error) {
    console.warn("[Sidebar] Save blogger metrics toggle failed:", error);
  }
}

async function handleAutoDetailCaptureToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({
        autoDetailCapture: false,
      });
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    syncAutoDetailCaptureControls({autoDetailCapture: checked});
    updateBloggerKeywordFilterHint();
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save auto detail capture toggle failed:", error);
  }
}

async function handleDetailCaptureCommentsToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({includeComments: false});
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    if (checked) {
      syncAutoDetailCaptureControls({autoDetailCapture: true});
      if (!readRequiredDetailCaptureCommentsMaxDetectedItemsFromInput()) {
        showMessage("请填写评论探测上限（正整数）", "warning");
        getActiveDetailCaptureCommentsMaxDetectedItemsInput()?.focus();
      }
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save detail comments toggle failed:", error);
  }
}

async function handleDetailCaptureBloggerMetricsToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({includeBloggerMetrics: false});
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    if (checked) {
      syncAutoDetailCaptureControls({autoDetailCapture: true});
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save detail blogger metrics toggle failed:", error);
  }
}

async function handleDetailCaptureSkipCapturedToggleChange() {
  try {
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save skip-captured toggle failed:", error);
  }
}

async function handleDetailCaptureLowFollowerHitToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked) {
      syncAutoDetailCaptureControls({
        autoDetailCapture: true,
        includeBloggerMetrics: true,
      });
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn(
      "[Sidebar] Save detail low follower hit toggle failed:",
      error,
    );
  }
}

async function handleDetailCaptureLowFollowerHitThresholdChange(event) {
  try {
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn(
      "[Sidebar] Save detail low follower hit threshold failed:",
      error,
    );
  }
}

async function handleDetailCaptureCommentLeadsToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({
        enableCommentLeadsFilter: false,
      });
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    if (checked) {
      syncAutoDetailCaptureControls({
        autoDetailCapture: true,
        includeComments: true,
      });
      if (!readRequiredDetailCaptureCommentsMaxDetectedItemsFromInput()) {
        showMessage("请填写评论探测上限（正整数）", "warning");
        getActiveDetailCaptureCommentsMaxDetectedItemsInput()?.focus();
      }
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save detail comment leads toggle failed:", error);
  }
}

async function handleDetailCaptureCommentsMaxDetectedItemsChange() {
  try {
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn(
      "[Sidebar] Save detail comments max detected items failed:",
      error,
    );
  }
}

function handleCaptureCommentsToggleGuardClick(event) {
  const runtime = getCurrentRuntime();
  if (runtime?.pageType !== PAGE_TYPE.NOTE_DETAIL) {
    return;
  }
}

function handleCaptureBloggerMetricsToggleGuardClick() {
  // 单笔记采集条件开关不再受激活码鉴权限制。
  return;
}

async function handleSaveCaptureSettings() {
  try {
    const current = await getCaptureSettings();
    const commentsMaxDetectedItems = readCommentsMaxDetectedItemsFromInput(
      current.commentsMaxDetectedItems,
    );
    const syncScope = readSyncScopeFromInput(current.syncScope);
    const detailCaptureScope = readDetailCaptureScopeFromInput(
      current.detailCaptureScope,
    );
    const autoDetailCaptureAfterListCapture =
      getAutoDetailCaptureChecked(current);
    const includeCommentsOnNoteCapture = getCaptureCommentsChecked(current);
    const includeCommentsOnDetailCapture =
      getDetailCaptureCommentsChecked(current);
    const detailCommentsMaxDetectedItems =
      getDetailCaptureCommentsMaxDetectedItems(current);
    const enableCommentLeadsFilter = getCommentLeadsFilterChecked(current);
    const enableCommentLeadsFilterOnDetailCapture =
      getDetailCaptureCommentLeadsFilterChecked(current);
    const normalizedEnableCommentLeadsFilter =
      includeCommentsOnNoteCapture && enableCommentLeadsFilter;
    const normalizedEnableCommentLeadsFilterOnDetailCapture =
      includeCommentsOnDetailCapture && enableCommentLeadsFilterOnDetailCapture;
    const skipOfficialAccounts = getSkipOfficialAccountsChecked(current);
    const commentLeadsKeywords = readCommaSeparatedRulesFromInput(
      "inputCommentLeadsKeywords",
      current.commentLeadsKeywords,
    );
    const commentLeadsIps = readCommaSeparatedRulesFromInput(
      "inputCommentLeadsIps",
      current.commentLeadsIps,
    );
    const includeBloggerMetricsOnNoteCapture =
      getCaptureBloggerMetricsChecked(current);
    const includeBloggerMetricsOnDetailCapture =
      getDetailCaptureBloggerMetricsChecked(current);
    const sharedWaitMinMs =
      readSecondsInput(
        "inputSharedWaitMinSec",
        current.sharedWaitMinMs / 1000,
      ) * 1000;
    const sharedWaitMaxMs =
      readSecondsInput(
        "inputSharedWaitMaxSec",
        current.sharedWaitMaxMs / 1000,
      ) * 1000;
    const sharedStallTimeoutMs =
      readSecondsInput(
        "inputSharedStallTimeoutSec",
        current.sharedStallTimeoutMs / 1000,
      ) * 1000;
    const sharedMaxDurationMs =
      readSecondsInput(
        "inputSharedMaxDurationSec",
        current.sharedMaxDurationMs / 1000,
      ) * 1000;
    const detailAfterNavWaitMs = readSecondsAsMillisecondsInput(
      "inputDetailAfterNavWaitMs",
      current.detailAfterNavWaitMs,
      0.1,
    );
    const detailNavTimeoutMs = readSecondsAsMillisecondsInput(
      "inputDetailNavTimeoutMs",
      current.detailNavTimeoutMs,
      1,
    );
    const profileAfterNavWaitMs = readSecondsAsMillisecondsInput(
      "inputProfileAfterNavWaitMs",
      current.profileAfterNavWaitMs,
      0.1,
    );
    const bloggerMinLikes = readBloggerMinLikesFromInput(
      current.bloggerMinLikes,
    );
    const bloggerMaxDetectedItems = readBloggerMaxDetectedItemsFromInput(
      current.bloggerMaxDetectedItems,
    );
    const bloggerKeywordFilter = readBloggerKeywordFilterFromInput();
    const keywordMinLikes = readKeywordMinLikesFromInput(
      current.keywordMinLikes,
    );
    const keywordMaxDetectedItems = readKeywordMaxDetectedItemsFromInput(
      current.keywordMaxDetectedItems,
    );

    await saveCaptureSettings({
      autoDetailCaptureAfterListCapture,
      commentsMaxDetectedItems,
      syncScope,
      detailCaptureScope,
      includeCommentsOnNoteCapture,
      includeCommentsOnDetailCapture,
      detailCommentsMaxDetectedItems,
      enableCommentLeadsFilter: normalizedEnableCommentLeadsFilter,
      enableCommentLeadsFilterOnDetailCapture:
        normalizedEnableCommentLeadsFilterOnDetailCapture,
      skipOfficialAccounts,
      commentLeadsKeywords,
      commentLeadsIps,
      includeBloggerMetricsOnNoteCapture,
      includeBloggerMetricsOnDetailCapture,
      sharedWaitMinMs,
      sharedWaitMaxMs,
      sharedStallTimeoutMs,
      sharedMaxDurationMs,
      detailNavTimeoutMs,
      detailAfterNavWaitMs,
      profileAfterNavWaitMs,
      bloggerMinLikes,
      bloggerMaxDetectedItems,
      bloggerKeywordFilter,
      keywordMinLikes,
      keywordMaxDetectedItems,
    });

    showMessage("采集配置已保存", "success");
  } catch (error) {
    console.error("[Sidebar] Save capture settings failed:", error);
    showMessage("保存采集配置失败: " + error.message, "error");
  }
}

/**
 * 处理同步全部记录
 */
async function handleSyncAll() {
  if (detailBatchCaptureInFlight) {
    showMessage("正在执行采集增强，请等待完成后再同步", "warning");
    return;
  }

  const settings = await getCaptureSettings();
  const syncScope = readSyncScopeFromInput(settings.syncScope);
  const commentLeadsConfig = buildCommentLeadsConfigFromSettings(settings);
  const commentLeadsEnabled = Boolean(commentLeadsConfig.enabled);
  const pageRecords = getCurrentPageRecords();
  const orderedAllRecords = prioritizeRecordsForSync(pageRecords);
  const pendingRecords = pageRecords.filter(
    (record) => record.status !== "synced",
  );
  const orderedPendingRecords = prioritizeRecordsForSync(pendingRecords);
  const targetRecords =
    syncScope === SYNC_SCOPE_ALL ? orderedAllRecords : orderedPendingRecords;
  const targetIds = targetRecords.map((record) => record.id);
  const limitedTargetIds = targetIds.slice(0, MAX_SYNC_RECORDS_PER_BATCH);
  const limitedTargetRecords = targetRecords.slice(
    0,
    MAX_SYNC_RECORDS_PER_BATCH,
  );
  const remainingCount = targetIds.length - limitedTargetIds.length;

  if (targetIds.length === 0) {
    if (syncScope === SYNC_SCOPE_ALL) {
      showMessage("当前页面暂无可同步数据", "info");
    } else {
      showMessage("当前页面没有未同步数据", "info");
    }
    return;
  }

  const detailCaptureBlockers = summarizeDetailCaptureBlockers(targetRecords);
  if (detailCaptureBlockers.capturing > 0) {
    showMessage(
      buildDetailCaptureBlockerMessage(detailCaptureBlockers),
      "warning",
    );
    return;
  }

  // 确认
  const scopeText = syncScope === SYNC_SCOPE_ALL ? "全部数据" : "未同步数据";
  let confirmMessage =
    targetIds.length > MAX_SYNC_RECORDS_PER_BATCH
      ? `确定要同步当前页面的${scopeText} ${targetIds.length} 条吗？\n${SYNC_BATCH_LIMIT_MESSAGE}`
      : `确定要同步当前页面的${scopeText} ${targetIds.length} 条吗？`;
  if (detailCaptureBlockers.total > 0) {
    confirmMessage = `${buildDetailCaptureSyncWarningMessage(
      detailCaptureBlockers,
    )}\n\n${confirmMessage}`;
  }
  if (!confirm(confirmMessage)) {
    return;
  }

  if (targetIds.length > MAX_SYNC_RECORDS_PER_BATCH) {
    showMessage(SYNC_BATCH_LIMIT_MESSAGE, "warning");
  }

  const taskContext = beginSidebarTask({
    taskType: "sync",
    featureKey: "sync.lark",
    metadata: {
      syncScope,
      targetCount: limitedTargetIds.length,
      requestedCount: targetIds.length,
      commentLeadsEnabled,
    },
  });
  let taskStatus = "completed";
  let taskError = null;

  showProgress("正在校验授权与同步配置...");
  try {
    // 同步前检查
    const requiredTypes = limitedTargetRecords.map(
      (record) => resolveSyncInputForRecord(record)?.syncType || record.type,
    );
    if (
      commentLeadsEnabled &&
      requiredTypes.some(
        (syncType) =>
          syncType === SYNC_TYPE.SINGLE_NOTE ||
          syncType === SYNC_TYPE.COMMENTS ||
          syncType === SYNC_TYPE.BLOGGER_NOTES ||
          syncType === SYNC_TYPE.KEYWORD_NOTES,
      )
    ) {
      requiredTypes.push(SYNC_TYPE.COMMENT_LEADS);
    }
    const checkResult = await checkBeforeSync(requiredTypes, {
      onProgress: handleProgress,
    });
    if (!checkResult.ok) {
      const errorMsg =
        ERROR_MESSAGE_MAP[checkResult.error?.code] ||
        checkResult.error?.message;
      showMessage(errorMsg, "error");
      taskStatus = "failed";
      return;
    }

    showProgress(`正在同步 ${limitedTargetIds.length} 条记录...`);

    const result = await syncRecordBatch(limitedTargetIds, handleProgress, {
      trigger: "current_page",
      syncScope,
      captureSettings: settings,
      commentLeadsConfig,
    });

    const leadsSyncedCount = Number(result.commentLeadsSyncedCount || 0);
    const leadsSkippedCount = Number(result.commentLeadsSkippedCount || 0);
    const leadsFailedCount = Number(result.commentLeadsFailedCount || 0);
    const hasLeadsActivity =
      leadsSyncedCount > 0 || leadsSkippedCount > 0 || leadsFailedCount > 0;
    const hasLeadsSkippedOnly =
      hasLeadsActivity &&
      leadsSyncedCount === 0 &&
      leadsFailedCount === 0 &&
      leadsSkippedCount > 0;
    const hasLeadsFailure = hasLeadsActivity && leadsFailedCount > 0;
    const contentSuccessCount =
      Number(result.successCount || 0) +
      (hasLeadsFailure ? leadsFailedCount : 0);
    const leadsSummary = hasLeadsActivity
      ? `（客资：成功 ${leadsSyncedCount} / 跳过 ${leadsSkippedCount} / 失败 ${leadsFailedCount}）`
      : "";

    if (result.ok && remainingCount <= 0) {
      const successMessage = hasLeadsSkippedOnly
        ? `全部同步成功！共 ${result.successCount} 条。客资 0 条，已跳过${leadsSummary}`
        : `全部同步成功！共 ${result.successCount} 条${leadsSummary}`;
      showMessage(successMessage, "success");
    } else if (result.ok && remainingCount > 0) {
      showMessage(
        `本次已同步 ${result.successCount} 条，剩余 ${remainingCount} 条，请再次点击“同步后台”继续同步${
          hasLeadsSkippedOnly ? "（客资 0 条，已跳过）" : leadsSummary
        }`,
        "warning",
      );
    } else {
      const baseFailureMessage = `部分同步失败：成功 ${result.successCount}，失败 ${result.failedCount}${
        remainingCount > 0 ? `，剩余 ${remainingCount} 条待执行` : ""
      }`;
      const partialLeadsMessage = hasLeadsFailure
        ? `部分成功：内容表已成功 ${contentSuccessCount} 条，客资失败 ${leadsFailedCount} 条，可再次点击“同步后台”仅重试失败记录`
        : "";
      showMessage(partialLeadsMessage || baseFailureMessage, "warning");
      taskStatus = "completed_with_failures";
    }

    await Promise.all([refreshDataPool(), refreshSyncHistory()]);
  } catch (error) {
    console.error("[Sidebar] Sync all failed:", error);
    taskStatus = "failed";
    taskError = error;
    showMessage("同步失败: " + error.message, "error");
  } finally {
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        syncScope,
        targetCount: limitedTargetIds.length,
        requestedCount: targetIds.length,
      },
    });
    hideProgress();
  }
}

function prioritizeRecordsForSync(records = []) {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  const bloggerProfiles = [];
  const others = [];

  records.forEach((record) => {
    if (record?.type === "blogger_profile") {
      bloggerProfiles.push(record);
      return;
    }
    others.push(record);
  });

  return [...bloggerProfiles, ...others];
}

async function maybeRunAutoDetailCaptureAfterListCapture(
  settings,
  {sourceLabel = "当前列表", recordIds = null} = {},
) {
  if (!Boolean(settings?.autoDetailCaptureAfterListCapture)) {
    return {
      skipped: true,
      reason: "disabled",
    };
  }

  const auth = getCurrentAuth() || {};
  if (!isAuthVerified(auth)) {
    showMessage(
      `${sourceLabel}已入池，当前功能需要激活码授权，已有激活码请在设置中完成验证；还没有可联系管理员获取。`,
      "warning",
    );
    return {
      skipped: true,
      reason: "auth_required",
    };
  }

  const runtime = getCurrentRuntime();
  const platform = getViewPlatform(runtime);
  if (!getPlatformCapabilities(platform).batchDetailCapture) {
    return {
      skipped: true,
      reason: "unsupported_platform",
    };
  }

  const detailCaptureScope = readDetailCaptureScopeFromInput(
    settings?.detailCaptureScope,
  );

  // 如果提供了明确的 recordIds，则优先使用这些 ID（主要针对刚采集完的场景，防止由于切表导致的 records 过滤失效）
  let pageRecords = [];
  if (Array.isArray(recordIds) && recordIds.length > 0) {
    const pool = getCurrentDataPool()?.records || [];
    pageRecords = pool.filter((r) => recordIds.includes(r.id));
  } else {
    pageRecords = getCurrentPageRecords();
  }

  const targetRecords = getDetailCaptureTargetRecords(pageRecords, {
    scope: detailCaptureScope,
  });

  if (targetRecords.length === 0) {
    return {
      skipped: true,
      reason: "no_target_records",
    };
  }

  const targetRecordIds = targetRecords
    .filter((record) => Boolean(getRecordPrimaryNoteUrl(record)))
    .map((record) => record.id);

  if (targetRecordIds.length === 0) {
    showMessage("当前记录缺少可访问的笔记链接，无法执行采集增强", "warning");
    return {
      skipped: true,
      reason: "missing_note_url",
    };
  }

  const result = await runDetailCaptureForRecordIds(targetRecordIds, settings, {
    progressMessage: `正在执行采集增强（0/${targetRecordIds.length}）...`,
  });

  if (result.canceled) {
    const filterMsg =
      result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
    const failureSummary = buildDetailCaptureFailureSummaryText(result);
    showMessage(
      `采集增强已中止：成功 ${result.successCount}，失败 ${result.failedCount}${filterMsg}${failureSummary}`,
      "warning",
    );
  } else if (result.ok) {
    const filterMsg =
      result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
    showMessage(
      `采集增强完成：成功 ${result.successCount} 条${filterMsg}`,
      "success",
    );
  } else {
    const filterMsg =
      result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
    const failureSummary = buildDetailCaptureFailureSummaryText(result);
    showMessage(
      `采集增强完成：成功 ${result.successCount}，失败 ${result.failedCount}${filterMsg}${failureSummary}`,
      "warning",
    );
  }

  return result;
}

async function runDetailCaptureForRecordIds(
  recordIds,
  settings,
  {progressMessage = ""} = {},
) {
  const normalizedRecordIds = Array.isArray(recordIds)
    ? [
        ...new Set(
          recordIds.filter(
            (recordId) => typeof recordId === "string" && recordId.trim(),
          ),
        ),
      ]
    : [];

  if (normalizedRecordIds.length === 0) {
    return {
      ok: false,
      canceled: false,
      successCount: 0,
      failedCount: 0,
      results: [],
    };
  }

  detailBatchCaptureInFlight = true;
  detailBatchCancelRequested = false;
  detailBatchRunnerTabId = null;
  updateDataPoolUI(getCurrentDataPool());
  updatePageTypeUI(getCurrentRuntime()?.pageType || PAGE_TYPE.UNKNOWN);
  showProgress(
    progressMessage || `正在执行采集增强（0/${normalizedRecordIds.length}）...`,
  );

  try {
    const result = await batchCaptureDetailsForRecords(normalizedRecordIds, {
      onProgress: handleProgress,
      shouldStop: () => detailBatchCancelRequested,
      includeComments: Boolean(settings?.includeCommentsOnDetailCapture),
      includeBloggerMetrics: Boolean(
        settings?.includeBloggerMetricsOnDetailCapture,
      ),
      skipAlreadyCaptured:
        settings?.skipAlreadyCapturedOnDetailCapture !== false,
      enableCommentLeadsFilter: Boolean(
        settings?.enableCommentLeadsFilterOnDetailCapture,
      ),
      enableLowFollowerHitFilter: Boolean(
        settings?.enableLowFollowerHitFilterOnDetailCapture,
      ),
      lowFollowerHitThreshold: settings?.lowFollowerHitThresholdOnDetailCapture,
      commentsMaxDetectedItems:
        settings?.detailCommentsMaxDetectedItems ??
        settings?.commentsMaxDetectedItems,
      detailNavTimeoutMs: settings?.detailNavTimeoutMs,
      detailAfterNavWaitMs: settings?.detailAfterNavWaitMs,
      profileAfterNavWaitMs: settings?.profileAfterNavWaitMs,
    });

    await refreshDataPool();
    return result;
  } finally {
    detailBatchCaptureInFlight = false;
    detailBatchCancelRequested = false;
    detailBatchRunnerTabId = null;
    updateDataPoolUI(getCurrentDataPool());
    updatePageTypeUI(getCurrentRuntime()?.pageType || PAGE_TYPE.UNKNOWN);
  }
}

/**
 * 处理导出
 */
async function handleExport() {
  if (detailBatchCaptureInFlight) {
    showMessage("正在执行采集增强，请等待完成后再导出", "warning");
    return;
  }

  const records = getCurrentPageRecords();

  if (records.length === 0) {
    showMessage("当前页面没有可导出的数据", "info");
    return;
  }

  try {
    const settings = await getCaptureSettings();
    const commentLeadsConfig = buildCommentLeadsConfigFromSettings(settings);
    const dateTag = new Date().toISOString().split("T")[0];
    const contentFilename = `onstarvoice-content-${dateTag}.csv`;
    const rows = buildCurrentPageCsvRows(records);
    await downloadCsvRowsByChrome(rows, contentFilename);

    let exportedLeadsCount = 0;
    if (commentLeadsConfig.enabled) {
      const normalizedRecords = normalizeRecordsToSingleNoteCsv(records);
      const leadsRows = buildCommentLeadsCsvRows(normalizedRecords, settings);
      exportedLeadsCount = Math.max(0, leadsRows.length - 1);
      if (exportedLeadsCount > 0) {
        await sleep(120);
        await downloadCsvRowsByChrome(
          leadsRows,
          `onstarvoice-comment-leads-${dateTag}.csv`,
        );
      }
    }

    if (commentLeadsConfig.enabled && exportedLeadsCount === 0) {
      showMessage(
        `已导出 ${records.length} 条记录，客资 0 条，已跳过`,
        "success",
      );
      return;
    }
    if (commentLeadsConfig.enabled && exportedLeadsCount > 0) {
      showMessage(
        `已导出 ${records.length} 条记录，客资 ${exportedLeadsCount} 条`,
        "success",
      );
      return;
    }
    showMessage(`已导出 ${records.length} 条记录`, "success");
  } catch (error) {
    console.error("[Sidebar] Export failed:", error);
    showMessage("导出失败: " + error.message, "error");
  }
}

/**
 * 处理清空数据池
 */
async function handleClearPool() {
  if (detailBatchCaptureInFlight) {
    showMessage("正在执行采集增强，请先停止或等待任务完成", "warning");
    return;
  }

  const records = getCurrentPageRecords();
  if (records.length === 0) {
    showMessage("当前页面缓存为空", "info");
    return;
  }

  if (!confirm("确定要清空当前页面缓存吗？此操作不可恢复！")) {
    return;
  }

  try {
    const {deleteRecords} = await import("../utils/storage.js");
    await deleteRecords(records.map((record) => record.id));
    await refreshDataPool();

    showMessage("当前页面缓存已清空", "success");
  } catch (error) {
    console.error("[Sidebar] Clear pool failed:", error);
    showMessage("清空失败: " + error.message, "error");
  }
}

async function handleClearSyncHistory() {
  if (!confirm("确定要清空本地同步记录吗？监控执行记录不会被删除。")) {
    return;
  }

  try {
    const {clearSyncHistory} = await import("../utils/storage.js");
    await clearSyncHistory();
    await refreshSyncHistory();
    showMessage("本地同步记录已清空", "success");
  } catch (error) {
    console.error("[Sidebar] Clear sync history failed:", error);
    showMessage("清空本地同步记录失败: " + error.message, "error");
  }
}

async function handleRecordListClick(event) {
  const monitorButton = event.target.closest(".btn-monitor-record");
  if (monitorButton) {
    const recordId = monitorButton.dataset.recordId;
    if (recordId) {
      await handleAddMonitorFromRecord(recordId);
    }
    return;
  }

  const stopButton = event.target.closest(".btn-stop-comments");
  if (stopButton) {
    const recordId = stopButton.dataset.id;
    if (recordId) {
      await handleStopCommentsCapture(recordId);
    }
    return;
  }

  const retryButton = event.target.closest(".btn-retry-comments");
  if (retryButton) {
    const recordId = retryButton.dataset.id;
    if (recordId) {
      await handleRetryCommentsCapture(recordId);
    }
    return;
  }

  const retryDetailButton = event.target.closest(".btn-retry-detail");
  if (retryDetailButton) {
    const recordId = retryDetailButton.dataset.id;
    if (recordId) {
      await handleRetryDetailCapture(recordId);
    }
    return;
  }

  const deleteButton = event.target.closest(".btn-del-record");
  if (deleteButton) {
    const recordId = deleteButton.dataset.id;
    if (recordId) {
      await handleDeleteRecord(recordId);
    }
    return;
  }

  const downloadButton = event.target.closest(".btn-download-record-media");
  if (downloadButton) {
    const recordId = downloadButton.dataset.id;
    if (recordId) {
      await handleDownloadRecordMedia(recordId);
    }
  }
}

async function handleStopCommentsCapture(recordId) {
  activeCommentsCaptureRecordId = recordId;
  await handleCancel();
}

async function handleRetryCommentsCapture(recordId) {
  const runtime = getCurrentRuntime();
  if (runtime?.pageType !== PAGE_TYPE.NOTE_DETAIL) {
    showMessage("请先切换到对应笔记详情页，再重试评论采集", "error");
    return;
  }

  const settings = await getCaptureSettings();
  const commentsMaxDetectedItems = readCommentsMaxDetectedItemsFromInput(
    settings.commentsMaxDetectedItems,
  );

  const taskContext = beginSidebarTask({
    taskType: "capture",
    featureKey: "capture.comments",
    metadata: {
      recordId,
      commentsMaxDetectedItems,
      retry: true,
    },
  });
  let taskStatus = "completed";
  let taskError = null;

  showProgress("正在重试评论采集...", false);
  activeCommentsCaptureRecordId = recordId;

  try {
    const result = await retryCommentsForRecord(recordId, {
      commentsMaxDetectedItems,
      onProgress: handleProgress,
    });

    if (result.ok) {
      if (result.phase === "comments_partial") {
        taskStatus = "partial";
        showMessage("评论采集已手动停止并合并", "warning");
      } else {
        showMessage("评论采集已完成并合并", "success");
      }
    } else {
      const errorMsg =
        ERROR_MESSAGE_MAP[result.error?.code] ||
        result.error?.message ||
        "评论采集失败";
      showMessage(errorMsg, "error");
      taskStatus = "failed";
    }

    await refreshDataPool();
  } catch (error) {
    console.error("[Sidebar] Retry comments failed:", error);
    taskStatus = "failed";
    taskError = error;
    showMessage("重试评论失败: " + error.message, "error");
  } finally {
    activeCommentsCaptureRecordId = "";
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        recordId,
        retry: true,
      },
    });
    hideProgress();
  }
}

async function handleRetryDetailCapture(recordId) {
  if (detailBatchCaptureInFlight) {
    showMessage("采集增强任务进行中，请稍候...", "info");
    return;
  }

  const auth = getCurrentAuth() || {};
  if (!isAuthVerified(auth)) {
    showMessage(getAuthRequiredMessage(), "warning");
    return;
  }

  const settings = await getCaptureSettings();
  const batchRetryRecordIds = getBatchRetryDetailRecordIds(recordId);
  const shouldOfferBatchRetry = batchRetryRecordIds.length > 1;
  const targetRecordIds =
    shouldOfferBatchRetry &&
    confirm(
      `检测到当前页面还有 ${batchRetryRecordIds.length - 1} 条未完成采集增强，是否改为批量重试这 ${batchRetryRecordIds.length} 条？`,
    )
      ? batchRetryRecordIds
      : [recordId];
  const isBatchRetry = targetRecordIds.length > 1;
  const taskContext = beginSidebarTask({
    taskType: "capture",
    featureKey: "capture.enhancement",
    metadata: {
      recordId,
      targetCount: targetRecordIds.length,
      retry: true,
    },
  });
  let taskStatus = "completed";
  let taskError = null;

  try {
    const result = await runDetailCaptureForRecordIds(
      targetRecordIds,
      settings,
      {
        progressMessage: isBatchRetry
          ? `正在批量重试采集增强（0/${targetRecordIds.length}）...`
          : "正在重试采集增强（0/1）...",
      },
    );

    if (result.canceled) {
      taskStatus = "partial";
      const filterMsg =
        result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
      const failureSummary = buildDetailCaptureFailureSummaryText(result);
      showMessage(
        `采集增强已中止：成功 ${result.successCount}，失败 ${result.failedCount}${filterMsg}${failureSummary}`,
        "warning",
      );
    } else if (result.ok) {
      const filterMsg =
        result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
      showMessage(
        `采集增强完成：成功 ${result.successCount} 条${filterMsg}`,
        "success",
      );
    } else {
      const filterMsg =
        result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
      const failureSummary = buildDetailCaptureFailureSummaryText(result);
      taskStatus = "completed_with_failures";
      showMessage(
        `采集增强完成：成功 ${result.successCount}，失败 ${result.failedCount}${filterMsg}${failureSummary}`,
        "warning",
      );
    }
  } catch (error) {
    console.error("[Sidebar] Retry detail capture failed:", error);
    taskStatus = "failed";
    taskError = error;
    showMessage("采集增强失败: " + error.message, "error");
  } finally {
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        recordId,
        targetCount: targetRecordIds.length,
        retry: true,
      },
    });
    hideProgress();
  }
}

async function handleDeleteRecord(recordId) {
  try {
    const {deleteRecord} = await import("../utils/storage.js");
    await deleteRecord(recordId);
    await refreshDataPool();
    showMessage("记录已移除", "success");
  } catch (error) {
    console.error("[Sidebar] Delete record failed:", error);
    showMessage("移除失败: " + error.message, "error");
  }
}

async function handleDownloadRecordMedia(recordId) {
  const dataPool = getCurrentDataPool();
  const records = dataPool?.records || [];
  const record = records.find((item) => item.id === recordId);
  if (!record) {
    showMessage("记录不存在", "error");
    return;
  }

  const mediaTasks = buildMediaDownloadTasks([record]);
  if (mediaTasks.length === 0) {
    showMessage("该记录没有可下载附件", "info");
    return;
  }

  const expectsVideo =
    record.type === "single_note" && isVideoNotePayload(record?.payload || {});
  const hasVideoTask = mediaTasks.some((task) => task.kind === "video");

  showProgress(`准备下载 ${mediaTasks.length} 个附件...`);
  try {
    let successCount = 0;
    let failedCount = 0;

    for (const task of mediaTasks) {
      try {
        await downloadByChrome(task.url, task.filename);
        successCount += 1;
      } catch (error) {
        console.warn("[Sidebar] Download media failed:", task.url, error);
        failedCount += 1;
      }
    }

    if (expectsVideo && !hasVideoTask) {
      showMessage(
        `附件下载完成，共 ${successCount} 个文件（未找到视频直链，仅下载封面/图片）`,
        "warning",
      );
    } else if (failedCount === 0) {
      showMessage(`附件下载完成，共 ${successCount} 个文件`, "success");
    } else {
      showMessage(
        `附件下载完成：成功 ${successCount}，失败 ${failedCount}`,
        "warning",
      );
    }
  } finally {
    hideProgress();
  }
}

/**
 * 处理进度回调
 */
function handleProgress(progress) {
  console.log("[Sidebar] Progress:", progress);

  // 如果进入了单项的评论采集阶段，全局进度条无需显示，因为卡片上已有进度和停止按钮
  const phase = String(progress?.phase || "");
  const progressRecordId =
    typeof progress?.recordId === "string" ? progress.recordId.trim() : "";
  const progressContainer = document.getElementById("progressContainer");
  if (isTerminalProgressPhase(phase)) {
    hideProgressPanelOnly();
  }

  if (phase.startsWith("detail_")) {
    if (Number.isFinite(Number(progress?.runnerTabId))) {
      detailBatchRunnerTabId = Number(progress.runnerTabId);
    }
  }

  if (phase.startsWith("comments_")) {
    if (progressContainer) {
      progressContainer.style.display = "none";
    }
  } else {
    if (progressContainer && !isUnsupportedPlatformCoverVisible()) {
      progressContainer.style.display = "block";
    }
    // 否则正常更新全局进度消息
    const progressText = document.getElementById("progressText");
    const progressBar = document.getElementById("progressBar");
    const nextMessage = buildCaptureProgressText(progress);
    if (progressText && nextMessage) {
      progressText.textContent = nextMessage;
      if (progressBar) {
        progressBar.className = "status-bar is-info";
      }
    }
  }

  if (progressRecordId) {
    activeCommentsCaptureRecordId = progressRecordId;
  }

  if (phase === "comments_capturing" && progressRecordId) {
    clearCommentCaptureTerminalStatus(progressRecordId);
  }

  const terminalCommentStatus = resolveCommentTerminalStatusFromPhase(phase);
  if (terminalCommentStatus && progressRecordId) {
    markCommentCaptureTerminalStatus(progressRecordId, terminalCommentStatus);
    reconcileCommentCaptureTerminalState(progressRecordId, {
      status: terminalCommentStatus,
      collectedCount: progress?.collectedCount,
      errorMessage:
        terminalCommentStatus === "failed"
          ? String(progress?.error?.message || progress?.message || "")
          : "",
    }).catch((error) => {
      console.warn(
        "[Sidebar] Failed to reconcile terminal comment status:",
        error,
      );
    });
  }

  if (
    activeCommentsCaptureRecordId &&
    Number.isFinite(Number(progress?.collectedCount))
  ) {
    const nextCount = Number(progress.collectedCount);
    if (!isCommentCaptureTerminal(activeCommentsCaptureRecordId)) {
      syncCommentProgressToRecord(
        activeCommentsCaptureRecordId,
        nextCount,
      ).catch((error) => {
        console.warn("[Sidebar] Failed to sync comment progress:", error);
      });
    }
  }

  if (phase.startsWith("comments_")) {
    refreshDataPoolThrottled().catch((error) => {
      console.warn(
        "[Sidebar] Failed to refresh pool during comments capture:",
        error,
      );
    });
  } else if (phase.startsWith("detail_")) {
    refreshDataPoolThrottled().catch((error) => {
      console.warn(
        "[Sidebar] Failed to refresh pool during detail capture:",
        error,
      );
    });
  }
}

async function syncRuntimeCommentProgress(runtime) {
  if (!activeCommentsCaptureRecordId) {
    return;
  }

  const progress = runtime?.lastCaptureProgress;
  if (!progress) {
    return;
  }
  const phase = String(progress.phase || "");
  if (!phase.startsWith("comments_")) {
    return;
  }
  if (phase === "comments_capturing") {
    clearCommentCaptureTerminalStatus(activeCommentsCaptureRecordId);
  }
  const terminalCommentStatus = resolveCommentTerminalStatusFromPhase(phase);
  if (terminalCommentStatus) {
    markCommentCaptureTerminalStatus(
      activeCommentsCaptureRecordId,
      terminalCommentStatus,
    );
    await reconcileCommentCaptureTerminalState(activeCommentsCaptureRecordId, {
      status: terminalCommentStatus,
      collectedCount: progress?.collectedCount,
      errorMessage:
        terminalCommentStatus === "failed"
          ? String(progress?.error?.message || progress?.message || "")
          : "",
    });
    return;
  }
  if (!Number.isFinite(Number(progress.collectedCount))) {
    return;
  }
  if (isCommentCaptureTerminal(activeCommentsCaptureRecordId)) {
    return;
  }

  await syncCommentProgressToRecord(
    activeCommentsCaptureRecordId,
    Number(progress.collectedCount),
  );
}

function syncRuntimeCaptureProgress(runtime) {
  if (detailBatchCaptureInFlight) {
    return;
  }

  const progress = runtime?.lastCaptureProgress;
  if (!progress) {
    return;
  }

  const phase = String(progress.phase || "");
  if (!phase || phase.startsWith("comments_")) {
    return;
  }
  if (isTerminalProgressPhase(phase)) {
    hideProgressPanelOnly();
    if (batchKeywordCaptureInFlight) {
      setBatchProgressDetail("");
    }
    return;
  }

  // 批量关键词采集进行中:把底层细粒度进度(探测/筛选/防反爬等待)镜像到弹窗明细行,
  // 并收起外部蓝色进度条 + 中止按钮(统一并入弹窗,避免重复)
  if (batchKeywordCaptureInFlight) {
    setBatchProgressDetail(buildCaptureProgressText(progress));
    hideProgressPanelOnly();
    return;
  }

  const progressContainer = document.getElementById("progressContainer");
  const progressText = document.getElementById("progressText");
  if (!progressContainer || !progressText) {
    return;
  }

  if (isUnsupportedPlatformCoverVisible()) {
    hideProgressPanelOnly();
    return;
  }

  // 仅在本次会话已经主动展示进度面板时，才继续用 runtime 进度刷新。
  // 避免旧任务遗留的 progress 在空闲状态下重新弹出。
  if (progressContainer.style.display === "none") {
    return;
  }

  const nextMessage = buildCaptureProgressText(progress);
  if (!nextMessage) {
    return;
  }

  progressContainer.style.display = "block";
  progressText.textContent = nextMessage;
  const progressBar = document.getElementById("progressBar");
  if (progressBar) {
    progressBar.className = "status-bar is-info";
  }
}

function buildCaptureProgressText(progress) {
  const message = String(progress?.message || "").trim();
  const detectedCount = normalizeProgressCount(progress?.detectedCount);
  const filteredCount = normalizeProgressCount(progress?.filteredCount);
  const minLikes = normalizeProgressCount(progress?.minLikes);
  const sortDimension = normalizeKeywordSortDimension(progress?.sortDimension);
  const sortLabel = getKeywordSortDimensionLabel(sortDimension);
  const maxDetectedItems = normalizeProgressCount(
    progress?.maxDetectedItems ?? progress?.maxItems,
  );

  if (detectedCount === null || filteredCount === null) {
    return message;
  }

  const detailParts = [];
  if (minLikes !== null) {
    detailParts.push(`${sortLabel}≥${minLikes}`);
  }
  if (maxDetectedItems !== null) {
    detailParts.push(`探测上限 ${maxDetectedItems}`);
  }

  const statsText = `已探测 ${detectedCount} 条，已筛选 ${filteredCount} 条${
    detailParts.length > 0 ? `（${detailParts.join("，")}）` : ""
  }`;

  if (!message) {
    return statsText;
  }
  return `${message} · ${statsText}`;
}

function normalizeProgressCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.max(0, Math.floor(num));
}

async function syncCommentProgressToRecord(recordId, collectedCount) {
  if (isCommentCaptureTerminal(recordId)) {
    return;
  }

  const now = Date.now();
  if (now - lastProgressSyncAt < 800) {
    return;
  }
  lastProgressSyncAt = now;

  const {getRecord, updateRecord} = await import("../utils/storage.js");
  const record = await getRecord(recordId);
  if (!record || record.type !== "single_note") {
    return;
  }

  const payload = record.payload || {};
  const currentStatus = String(payload.commentsCaptureStatus || "");
  const currentCount = Number(payload.commentsTotalCaptured || 0);
  if (currentStatus !== "capturing" || collectedCount <= currentCount) {
    return;
  }
  if (isCommentCaptureTerminal(recordId)) {
    return;
  }

  // 避免并发覆盖终态：在落盘前再次读取最新记录，防止旧快照把 done/partial/failed 回写成 capturing
  const latestRecord = await getRecord(recordId);
  if (!latestRecord || latestRecord.type !== "single_note") {
    return;
  }
  const latestPayload = latestRecord.payload || {};
  const latestStatus = String(latestPayload.commentsCaptureStatus || "");
  const latestCount = Number(latestPayload.commentsTotalCaptured || 0);
  if (latestStatus !== "capturing" || collectedCount <= latestCount) {
    return;
  }
  if (isCommentCaptureTerminal(recordId)) {
    return;
  }

  await updateRecord(recordId, {
    payload: {
      ...latestPayload,
      commentsTotalCaptured: collectedCount,
    },
  });

  await refreshDataPoolThrottled();
}

function resolveCommentTerminalStatusFromPhase(phase) {
  const normalized = String(phase || "")
    .trim()
    .toLowerCase();
  return COMMENT_PHASE_TO_TERMINAL_STATUS[normalized] || "";
}

function markCommentCaptureTerminalStatus(recordId, status) {
  if (!recordId || !status) {
    return;
  }
  commentCaptureTerminalStatusByRecordId.set(recordId, status);
}

function clearCommentCaptureTerminalStatus(recordId) {
  if (!recordId) {
    return;
  }
  commentCaptureTerminalStatusByRecordId.delete(recordId);
}

function isCommentCaptureTerminal(recordId) {
  if (!recordId) {
    return false;
  }
  return commentCaptureTerminalStatusByRecordId.has(recordId);
}

async function reconcileCommentCaptureTerminalState(
  recordId,
  {status, collectedCount = null, errorMessage = ""} = {},
) {
  if (!recordId || !status) {
    return;
  }

  const normalizedStatus = String(status).trim().toLowerCase();
  if (!["done", "partial", "failed"].includes(normalizedStatus)) {
    return;
  }

  const normalizedCount = Number(collectedCount);
  const hasCount = Number.isFinite(normalizedCount);
  const nextCollectedCount = hasCount
    ? Math.max(0, Math.floor(normalizedCount))
    : 0;
  const nextError =
    normalizedStatus === "failed" ? String(errorMessage || "").trim() : "";

  const {getRecord, updateRecord} = await import("../utils/storage.js");
  const record = await getRecord(recordId);
  if (!record || record.type !== "single_note") {
    return;
  }

  const payload = record.payload || {};
  const currentStatus = String(payload.commentsCaptureStatus || "")
    .trim()
    .toLowerCase();
  const currentCount = Number(payload.commentsTotalCaptured || 0);
  const finalCount = hasCount
    ? Math.max(currentCount, nextCollectedCount)
    : currentCount;
  const currentError = String(payload.commentsCaptureError || "").trim();

  if (
    currentStatus === normalizedStatus &&
    currentCount === finalCount &&
    currentError === nextError
  ) {
    return;
  }

  await updateRecord(recordId, {
    payload: {
      ...payload,
      commentsCaptureStatus: normalizedStatus,
      commentsTotalCaptured: finalCount,
      commentsCaptureError: nextError,
    },
  });

  await refreshDataPoolThrottled();
}

async function refreshDataPoolThrottled() {
  const now = Date.now();
  if (now - lastPoolRefreshAt < 500) {
    return;
  }
  lastPoolRefreshAt = now;
  await refreshDataPool();
}

function isAuthVerified(auth) {
  return Boolean(auth?.status === AUTH_STATUS.VERIFIED || auth?.verified);
}

function isUnclaimedCredentialOwner(auth) {
  if (!isAuthVerified(auth)) {
    return false;
  }

  const ownerEmail = String(auth?.user?.email || "")
    .trim()
    .toLowerCase();
  const ownerName = String(auth?.user?.name || "")
    .trim()
    .toLowerCase();

  return (
    ownerEmail === UNCLAIMED_CREDENTIAL_OWNER_EMAIL.toLowerCase() ||
    ownerName === UNCLAIMED_CREDENTIAL_OWNER_NAME.toLowerCase()
  );
}

async function openCredentialClaimPage() {
  try {
    await chrome.tabs.create({url: CREDENTIAL_CLAIM_PAGE_URL});
    return true;
  } catch (error) {
    console.warn("[Sidebar] Open claim page in tab failed:", error);
  }

  try {
    window.open(CREDENTIAL_CLAIM_PAGE_URL, "_blank", "noopener,noreferrer");
    return true;
  } catch (error) {
    console.error("[Sidebar] Open claim page fallback failed:", error);
    return false;
  }
}

async function handleGoClaim() {
  const opened = await openCredentialClaimPage();
  if (!opened) {
    showMessage("打开绑定页失败，请稍后重试", "error");
    return;
  }

  showMessage("已打开绑定页，绑定完成后请回到插件重新验证。", "info");
}

function getAuthRequiredMessage() {
  return AUTH_REQUIRED_MESSAGE;
}

function formatCreditsLabel(credits) {
  return Number.isInteger(credits) && credits > 0 ? `${credits} 配额` : "配额";
}

function getKeywordOpportunityAuthRequiredMessage() {
  return `当前功能需要先验证激活码，判断赛道机会将消耗 ${formatCreditsLabel(
    KEYWORD_OPPORTUNITY_ANALYSIS_COST_CREDITS,
  )}。已有激活码请先在设置中完成验证；还没有请联系管理员获取。`;
}

function getBenchmarkDiscoveryAuthRequiredMessage() {
  return `当前功能需要先验证激活码，找对标账号将消耗 ${formatCreditsLabel(
    BENCHMARK_DISCOVERY_ANALYSIS_COST_CREDITS,
  )}。已有激活码请先在设置中完成验证；还没有请点击购买。`;
}

function getKeywordInsightAuthRequiredMessage() {
  return `当前功能需要先验证激活码。长尾扩词可先免费使用，继续生成分析长尾需求结果将消耗 ${formatCreditsLabel(
    KEYWORD_INSIGHT_ANALYSIS_COST_CREDITS,
  )}。已有激活码请先在设置中完成验证；还没有请联系管理员获取。`;
}

function formatKeywordStrategyAccessError(error, fallbackMessage) {
  const errorReason = String(
    error?.reason || error?.error?.reason || "",
  )
    .trim()
    .toLowerCase();
  const rawMessage = String(
    error?.message || error?.error?.message || "",
  ).trim();
  const normalizedMessage = rawMessage.toLowerCase();

  if (
    errorReason === ERROR_REASON.VERIFY_FAILED ||
    /no auth code found/i.test(rawMessage)
  ) {
    return {
      kind: "auth_required",
      message: fallbackMessage,
    };
  }

  if (errorReason === ERROR_REASON.EXPIRED) {
    return {
      kind: "auth_expired",
      message:
        "当前激活码已过期，请先续费或获取新激活码，并在设置中重新验证后再使用此功能。",
    };
  }

  if (errorReason === ERROR_REASON.FROZEN) {
    return {
      kind: "auth_frozen",
      message:
        "当前激活码已被冻结，请联系管理员处理。",
    };
  }

  if (errorReason === ERROR_REASON.BINDING_LIMIT_REACHED) {
    return {
      kind: "binding_limit",
      message:
        "当前激活码绑定环境已满，请先在设置中替换旧环境，或联系管理员获取新激活码。",
    };
  }

  if (
    normalizedMessage.includes("receiving end does not exist") ||
    normalizedMessage.includes("message port closed") ||
    normalizedMessage.includes("message channel closed before a response was received") ||
    normalizedMessage.includes("extension context invalidated") ||
    normalizedMessage.includes("frame with id 0 was removed")
  ) {
    return {
      kind: "page_connection_interrupted",
      message:
        "页面刚刚发生刷新或切换，导致分析连接中断。请留在当前搜索页后重试一次。",
    };
  }

  return {
    kind: "generic",
    message: rawMessage || fallbackMessage,
  };
}

function ensureAuthVerifiedOrWarn({message = AUTH_REQUIRED_MESSAGE} = {}) {
  const auth = getCurrentAuth() || {};
  if (isAuthVerified(auth)) {
    return true;
  }
  showMessage(message, "warning");
  return false;
}

function getCaptureCommentsChecked(settings) {
  const checkbox = document.getElementById("checkboxCaptureComments");
  if (!checkbox) {
    return settings?.includeCommentsOnNoteCapture || false;
  }
  return Boolean(checkbox.checked);
}

function getCommentLeadsFilterChecked(settings) {
  const checkbox = document.getElementById("checkboxEnableCommentLeadsFilter");
  if (!checkbox) {
    return Boolean(settings?.enableCommentLeadsFilter);
  }
  return Boolean(checkbox.checked);
}

function getSkipOfficialAccountsChecked(settings) {
  const checkbox = document.getElementById("checkboxSkipOfficialAccounts");
  if (!checkbox) {
    return settings?.skipOfficialAccounts !== false;
  }
  return Boolean(checkbox.checked);
}

function getCaptureBloggerMetricsChecked(settings) {
  const noteTabCheckbox = document.getElementById(
    "checkboxCaptureBloggerMetrics",
  );
  if (noteTabCheckbox) {
    return Boolean(noteTabCheckbox.checked);
  }
  return Boolean(settings?.includeBloggerMetricsOnNoteCapture);
}

async function resolveNoteBatchCaptureSettings() {
  const settings = await getCaptureSettings();
  const runtime = getCurrentRuntime();
  const platform = getViewPlatform(runtime);
  const capabilities = getPlatformCapabilities(platform);
  const hideBloggerMetricsToggle = shouldHideNoteBloggerMetricsToggle(platform);
  const includeComments = capabilities.captureComments
    ? getCaptureCommentsChecked(settings)
    : false;
  const includeBloggerMetrics =
    !hideBloggerMetricsToggle && capabilities.bloggerMetrics
      ? getCaptureBloggerMetricsChecked(settings)
      : false;

  let commentsMaxDetectedItems = settings.commentsMaxDetectedItems;
  if (includeComments) {
    commentsMaxDetectedItems = readRequiredCommentsMaxDetectedItemsFromInput();
    if (!commentsMaxDetectedItems) {
      throw new Error("开启评论采集时，请填写评论探测上限（正整数）");
    }
  }

  return {
    settings,
    includeComments,
    includeBloggerMetrics,
    commentsMaxDetectedItems,
    enableCommentLeadsFilter:
      includeComments && getCommentLeadsFilterChecked(settings),
  };
}

function collectBatchRecordIds(batchResult = {}) {
  if (!Array.isArray(batchResult?.results)) {
    return [];
  }

  return [
    ...new Set(
      batchResult.results
        .flatMap((entry) =>
          Array.isArray(entry?.recordIds) ? entry.recordIds : [],
        )
        .filter((recordId) => typeof recordId === "string" && recordId.trim()),
    ),
  ];
}

function shouldHideNoteBloggerMetricsToggle(platform) {
  return (
    String(platform || "")
      .trim()
      .toLowerCase() === "douyin"
  );
}

function syncBloggerMetricsCaptureControls({
  includeBloggerMetrics = false,
} = {}) {
  const noteTabCheckbox = document.getElementById(
    "checkboxCaptureBloggerMetrics",
  );
  if (noteTabCheckbox) {
    noteTabCheckbox.checked = Boolean(includeBloggerMetrics);
  }
}

/* first definition removed — consolidated into the panel-based version below */

function getActiveDetailCaptureInput(setting) {
  return document.querySelector(
    `#mainTabContent .tab-pane.is-active [data-detail-setting="${setting}"]`,
  );
}

function getActiveDetailCaptureCommentsMaxDetectedItemsInput() {
  return getActiveDetailCaptureInput("comments-max-detected-items");
}

function readPositiveIntegerFromRawValue(rawValue, fallback) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function readRequiredPositiveIntegerFromRawValue(rawValue) {
  const normalized = String(rawValue ?? "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function getAutoDetailCaptureChecked(settings) {
  const input = getActiveDetailCaptureInput("auto");
  if (!input) {
    return Boolean(settings?.autoDetailCaptureAfterListCapture);
  }
  return Boolean(input.checked);
}

function getDetailCaptureCommentsChecked(settings) {
  const input = getActiveDetailCaptureInput("comments");
  if (!input) {
    return Boolean(settings?.includeCommentsOnDetailCapture);
  }
  return Boolean(input.checked);
}

function getDetailCaptureCommentsMaxDetectedItems(settings) {
  const defaultValue = Number(
    DEFAULT_CAPTURE_SETTINGS.detailCommentsMaxDetectedItems ||
      DEFAULT_CAPTURE_SETTINGS.commentsMaxDetectedItems ||
      100,
  );
  const fallback = readPositiveIntegerFromRawValue(
    settings?.detailCommentsMaxDetectedItems ??
      settings?.commentsMaxDetectedItems,
    defaultValue,
  );
  const input = getActiveDetailCaptureCommentsMaxDetectedItemsInput();
  if (!input) {
    return fallback;
  }
  return readPositiveIntegerFromRawValue(input.value?.trim(), fallback);
}

function readRequiredDetailCaptureCommentsMaxDetectedItemsFromInput() {
  const input = getActiveDetailCaptureCommentsMaxDetectedItemsInput();
  if (!input) {
    return null;
  }
  return readRequiredPositiveIntegerFromRawValue(input.value?.trim());
}

function getDetailCaptureCommentLeadsFilterChecked(settings) {
  const input = getActiveDetailCaptureInput("comment-leads");
  if (!input) {
    return Boolean(settings?.enableCommentLeadsFilterOnDetailCapture);
  }
  return Boolean(input.checked);
}

function getDetailCaptureBloggerMetricsChecked(settings) {
  const input = getActiveDetailCaptureInput("metrics");
  if (!input) {
    return Boolean(settings?.includeBloggerMetricsOnDetailCapture);
  }
  return Boolean(input.checked);
}

// 增量采集(跳过已采过的)。无勾选输入时回落 settings,默认 true。
function getDetailCaptureSkipCapturedChecked(settings) {
  const input = getActiveDetailCaptureInput("skip-captured");
  if (!input) {
    return settings?.skipAlreadyCapturedOnDetailCapture !== false;
  }
  return Boolean(input.checked);
}

function getDetailCaptureLowFollowerHitFilterChecked(settings) {
  const input = getActiveDetailCaptureInput("low-follower-hit");
  if (!input) {
    return Boolean(settings?.enableLowFollowerHitFilterOnDetailCapture);
  }
  return Boolean(input.checked);
}

function getDetailCaptureLowFollowerHitThreshold(settings) {
  const defaultValue = Number(
    DEFAULT_CAPTURE_SETTINGS.lowFollowerHitThreshold || 10000,
  );
  const fallback = readNonNegativeIntegerFromRawValue(
    settings?.lowFollowerHitThresholdOnDetailCapture ??
      settings?.lowFollowerHitThreshold,
    defaultValue,
  );
  const input = getActiveDetailCaptureInput("low-follower-hit-threshold");
  if (!input) {
    return fallback;
  }
  return readNonNegativeIntegerFromRawValue(input.value?.trim(), fallback);
}

function readNonNegativeIntegerFromRawValue(rawValue, fallback) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function syncAutoDetailCaptureControls({
  autoDetailCapture = null,
  includeComments = null,
  commentsMaxDetectedItems = null,
  enableCommentLeadsFilter = null,
  includeBloggerMetrics = null,
  skipAlreadyCaptured = null,
  enableLowFollowerHitFilter = null,
  lowFollowerHitThreshold = null,
  forceDisabled = false,
  platform = "",
} = {}) {
  const runtime = getCurrentRuntime();
  const resolvedPlatform = platform || getViewPlatform(runtime);
  const capabilities = getPlatformCapabilities(resolvedPlatform);
  const detailCaptureSupported = Boolean(capabilities.batchDetailCapture);

  document.querySelectorAll("[data-auto-detail-panel]").forEach((panel) => {
    panel.hidden = !detailCaptureSupported;

    const autoInput = panel.querySelector('[data-detail-setting="auto"]');
    const commentsInput = panel.querySelector(
      '[data-detail-setting="comments"]',
    );
    const commentsMaxInput = panel.querySelector(
      '[data-detail-setting="comments-max-detected-items"]',
    );
    const commentLeadsInput = panel.querySelector(
      '[data-detail-setting="comment-leads"]',
    );
    const metricsInput = panel.querySelector('[data-detail-setting="metrics"]');
    const skipCapturedInput = panel.querySelector(
      '[data-detail-setting="skip-captured"]',
    );
    const lowFollowerHitInput = panel.querySelector(
      '[data-detail-setting="low-follower-hit"]',
    );
    const lowFollowerHitThresholdInput = panel.querySelector(
      '[data-detail-setting="low-follower-hit-threshold"]',
    );
    const options = panel.querySelector(
      '[data-detail-setting-group="options"]',
    );
    const commentSettings = panel.querySelector(
      '[data-detail-setting-group="comments-options"]',
    );
    const metricsOptions = panel.querySelector(
      '[data-detail-setting-group="metrics-options"]',
    );
    const lowFollowerHitThresholdGroup = panel.querySelector(
      '[data-detail-setting-group="low-follower-hit-threshold-group"]',
    );

    if (!detailCaptureSupported) {
      if (options) options.hidden = true;
      if (commentSettings) commentSettings.hidden = true;
      if (metricsOptions) metricsOptions.hidden = true;
      if (lowFollowerHitThresholdGroup) {
        lowFollowerHitThresholdGroup.hidden = true;
      }
      return;
    }

    if (autoInput && autoDetailCapture !== null) {
      autoInput.checked = Boolean(autoDetailCapture);
    }
    if (commentsInput && includeComments !== null) {
      commentsInput.checked = Boolean(includeComments);
    }
    if (commentsMaxInput && commentsMaxDetectedItems !== null) {
      commentsMaxInput.value = String(commentsMaxDetectedItems);
    }
    if (commentLeadsInput && enableCommentLeadsFilter !== null) {
      commentLeadsInput.checked = Boolean(enableCommentLeadsFilter);
    }
    if (metricsInput && includeBloggerMetrics !== null) {
      metricsInput.checked = Boolean(includeBloggerMetrics);
    }
    if (skipCapturedInput && skipAlreadyCaptured !== null) {
      skipCapturedInput.checked = Boolean(skipAlreadyCaptured);
    }
    if (lowFollowerHitInput && enableLowFollowerHitFilter !== null) {
      lowFollowerHitInput.checked = Boolean(enableLowFollowerHitFilter);
    }
    if (lowFollowerHitThresholdInput && lowFollowerHitThreshold !== null) {
      lowFollowerHitThresholdInput.value = String(lowFollowerHitThreshold);
    }
    if (lowFollowerHitThresholdGroup) {
      lowFollowerHitThresholdGroup.hidden = !Boolean(
        lowFollowerHitInput?.checked,
      );
    }

    const autoChecked = Boolean(autoInput?.checked);
    const commentsChecked = Boolean(commentsInput?.checked);
    const metricsChecked = Boolean(metricsInput?.checked);
    const commentsSupported =
      capabilities.batchDetailCapture && capabilities.captureComments;
    const metricsSupported =
      capabilities.batchDetailCapture && capabilities.bloggerMetrics;

    if (options) {
      options.hidden = !autoChecked;
    }
    if (commentSettings) {
      commentSettings.hidden =
        !autoChecked || !commentsChecked || !commentsSupported;
    }
    if (metricsOptions) {
      metricsOptions.hidden =
        !autoChecked || !metricsChecked || !metricsSupported;
    }

    if (autoInput) {
      autoInput.disabled = forceDisabled || !capabilities.batchDetailCapture;
    }
    const commentsControlDisabled =
      forceDisabled ||
      !autoChecked ||
      !capabilities.batchDetailCapture ||
      !capabilities.captureComments;
    if (commentsInput) {
      commentsInput.disabled = commentsControlDisabled;
    }
    const commentSettingsDisabled = commentsControlDisabled || !commentsChecked;
    if (commentsMaxInput) {
      commentsMaxInput.disabled = commentSettingsDisabled;
    }
    if (commentLeadsInput) {
      commentLeadsInput.disabled = commentSettingsDisabled;
    }
    if (commentSettings) {
      commentSettings.classList.toggle("is-disabled", commentSettingsDisabled);
    }
    if (metricsInput) {
      metricsInput.disabled =
        forceDisabled ||
        !autoChecked ||
        !capabilities.batchDetailCapture ||
        !capabilities.bloggerMetrics;
    }
  });
}

async function persistDetailCaptureSettingsFromInputs() {
  const current = await getCaptureSettings();
  const autoDetailCaptureAfterListCapture =
    getAutoDetailCaptureChecked(current);
  const includeCommentsOnDetailCapture =
    getDetailCaptureCommentsChecked(current);
  const detailCommentsMaxDetectedItems =
    getDetailCaptureCommentsMaxDetectedItems(current);
  const enableCommentLeadsFilterOnDetailCapture =
    getDetailCaptureCommentLeadsFilterChecked(current);
  const normalizedEnableCommentLeadsFilterOnDetailCapture =
    includeCommentsOnDetailCapture && enableCommentLeadsFilterOnDetailCapture;
  const includeBloggerMetricsOnDetailCapture =
    getDetailCaptureBloggerMetricsChecked(current);
  const skipAlreadyCapturedOnDetailCapture =
    getDetailCaptureSkipCapturedChecked(current);
  const enableLowFollowerHitFilterOnDetailCapture =
    getDetailCaptureLowFollowerHitFilterChecked(current);
  const lowFollowerHitThresholdOnDetailCapture =
    getDetailCaptureLowFollowerHitThreshold(current);

  syncAutoDetailCaptureControls({
    autoDetailCapture: autoDetailCaptureAfterListCapture,
    includeComments: includeCommentsOnDetailCapture,
    commentsMaxDetectedItems: detailCommentsMaxDetectedItems,
    enableCommentLeadsFilter: normalizedEnableCommentLeadsFilterOnDetailCapture,
    includeBloggerMetrics: includeBloggerMetricsOnDetailCapture,
    skipAlreadyCaptured: skipAlreadyCapturedOnDetailCapture,
    enableLowFollowerHitFilter: enableLowFollowerHitFilterOnDetailCapture,
    lowFollowerHitThreshold: lowFollowerHitThresholdOnDetailCapture,
  });

  await saveCaptureSettings({
    autoDetailCaptureAfterListCapture,
    includeCommentsOnDetailCapture,
    detailCommentsMaxDetectedItems,
    enableCommentLeadsFilterOnDetailCapture:
      normalizedEnableCommentLeadsFilterOnDetailCapture,
    includeBloggerMetricsOnDetailCapture,
    skipAlreadyCapturedOnDetailCapture,
    enableLowFollowerHitFilterOnDetailCapture,
    lowFollowerHitThresholdOnDetailCapture,
  });
}

function resolveCurrentDetailCaptureSettings(settings = {}) {
  return {
    ...settings,
    autoDetailCaptureAfterListCapture: getAutoDetailCaptureChecked(settings),
    includeCommentsOnDetailCapture: getDetailCaptureCommentsChecked(settings),
    detailCommentsMaxDetectedItems:
      getDetailCaptureCommentsMaxDetectedItems(settings),
    enableCommentLeadsFilterOnDetailCapture:
      getDetailCaptureCommentLeadsFilterChecked(settings),
    includeBloggerMetricsOnDetailCapture:
      getDetailCaptureBloggerMetricsChecked(settings),
    skipAlreadyCapturedOnDetailCapture:
      getDetailCaptureSkipCapturedChecked(settings),
    enableLowFollowerHitFilterOnDetailCapture:
      getDetailCaptureLowFollowerHitFilterChecked(settings),
    lowFollowerHitThresholdOnDetailCapture:
      getDetailCaptureLowFollowerHitThreshold(settings),
  };
}

function readSyncScopeFromInput(fallback = DEFAULT_CAPTURE_SETTINGS.syncScope) {
  const input = document.getElementById("inputSyncScope");
  const rawValue = String(input?.value || fallback || "")
    .trim()
    .toLowerCase();
  if (rawValue === SYNC_SCOPE_ALL || rawValue === SYNC_SCOPE_PENDING) {
    return rawValue;
  }
  return SYNC_SCOPE_PENDING;
}

function readDetailCaptureScopeFromInput(
  fallback = DEFAULT_CAPTURE_SETTINGS.detailCaptureScope,
) {
  const input = document.getElementById("inputDetailCaptureScope");
  const rawValue = String(input?.value || fallback || "")
    .trim()
    .toLowerCase();
  if (
    rawValue === DETAIL_CAPTURE_SCOPE_ALL ||
    rawValue === DETAIL_CAPTURE_SCOPE_PENDING
  ) {
    return rawValue;
  }
  return DETAIL_CAPTURE_SCOPE_PENDING;
}

function readCommentsMaxDetectedItemsFromInput(
  fallback = DEFAULT_CAPTURE_SETTINGS.commentsMaxDetectedItems,
) {
  const input = document.getElementById("inputCommentsMaxDetectedItems");
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function readRequiredCommentsMaxDetectedItemsFromInput() {
  const input = document.getElementById("inputCommentsMaxDetectedItems");
  const rawValue = input?.value?.trim();
  if (!rawValue) {
    return null;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function normalizeCommaSeparatedRules(value, fallback = "") {
  const source = String(value ?? fallback ?? "");
  const normalized = source
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(normalized)).join(",");
}

function readCommaSeparatedRulesFromInput(inputId, fallback = "") {
  const input = document.getElementById(inputId);
  const normalized = normalizeCommaSeparatedRules(input?.value, fallback);
  if (input) {
    input.value = normalized;
  }
  return normalized;
}

function syncCommentsCaptureControls({
  includeComments = null,
  forceDisabled = false,
} = {}) {
  const checkbox = document.getElementById("checkboxCaptureComments");
  const leadsCheckbox = document.getElementById(
    "checkboxEnableCommentLeadsFilter",
  );
  const input = document.getElementById("inputCommentsMaxDetectedItems");
  const group = document.getElementById("commentsMaxDetectedItemsGroup");
  const leadsGroup = document.getElementById("commentLeadsFilterGroup");
  const checked =
    includeComments === null
      ? Boolean(checkbox?.checked)
      : Boolean(includeComments);

  if (checkbox && includeComments !== null) {
    checkbox.checked = checked;
  }

  const shouldDisableLeads = forceDisabled || !checked;
  if (leadsCheckbox) {
    leadsCheckbox.disabled = shouldDisableLeads;
    if (!checked) {
      leadsCheckbox.checked = false;
    }
  }
  if (leadsGroup) {
    leadsGroup.hidden = !checked;
    leadsGroup.classList.toggle("is-disabled", shouldDisableLeads);
  }

  const shouldDisableInput = forceDisabled || !checked;
  if (input) {
    input.disabled = shouldDisableInput;
  }
  if (group) {
    group.hidden = !checked;
    group.classList.toggle("is-disabled", shouldDisableInput);
  }
}

function readSecondsInput(inputId, fallbackSeconds) {
  const input = document.getElementById(inputId);
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(1, Math.floor(Number(fallbackSeconds) || 1));
  }
  return Math.max(1, Math.floor(parsed));
}

function readSecondsAsMillisecondsInput(inputId, fallbackMs, minSeconds = 0.1) {
  const input = document.getElementById(inputId);
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  const normalizedMinSeconds = Math.max(0.1, Number(minSeconds) || 0.1);
  const normalizedMinMs = Math.max(
    100,
    Math.round(normalizedMinSeconds * 1000),
  );
  if (!Number.isFinite(parsed) || parsed < normalizedMinSeconds) {
    const fallback = Math.round(Number(fallbackMs) || normalizedMinMs);
    return Math.max(normalizedMinMs, fallback);
  }
  return Math.max(normalizedMinMs, Math.round(parsed * 1000));
}

function formatMillisecondsAsSeconds(milliseconds) {
  const parsed = Number(milliseconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "1";
  }

  const seconds = parsed / 1000;
  if (Number.isInteger(seconds)) {
    return String(seconds);
  }

  return String(Number(seconds.toFixed(2)));
}

function readBloggerMinLikesFromInput(fallback = 0) {
  const input = document.getElementById("inputBloggerMinLikes");
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }
  return Math.floor(parsed);
}

function readBloggerMaxDetectedItemsFromInput(
  fallback = DEFAULT_CAPTURE_SETTINGS.bloggerMaxDetectedItems,
) {
  const input = document.getElementById("inputBloggerMaxDetectedItems");
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function readBloggerKeywordFilterFromInput() {
  const input = document.getElementById("inputBloggerKeywordFilter");
  return (input?.value || "").trim();
}

function updateBloggerKeywordFilterHint() {
  const hintEl = document.getElementById("bloggerKeywordFilterHint");
  if (!hintEl) return;
  const bloggerPanel = document.getElementById("bloggerTab");
  const autoToggle = bloggerPanel?.querySelector(
    '[data-detail-setting="auto"]',
  );
  const isEnhanceOn = autoToggle?.checked ?? false;
  hintEl.textContent = isEnhanceOn
    ? "将匹配标题、正文和标签，留空不过滤"
    : "仅匹配标题，留空不过滤。开启采集增强可同时匹配正文和标签";
}

function readKeywordMinLikesFromInput(
  fallback = DEFAULT_CAPTURE_SETTINGS.keywordMinLikes,
) {
  const input = document.getElementById("inputKeywordMinLikes");
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }
  return Math.floor(parsed);
}

function readKeywordMaxDetectedItemsFromInput(
  fallback = DEFAULT_CAPTURE_SETTINGS.keywordMaxDetectedItems,
) {
  const input = document.getElementById("inputKeywordMaxDetectedItems");
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

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

async function syncKeywordSortDimensionByRuntime(runtime = null) {
  const pageType = runtime?.pageType || getCurrentRuntime()?.pageType;
  const pageUrl =
    runtime?.lastPageUrl || getCurrentRuntime()?.lastPageUrl || "";
  const pagePlatform = detectPlatformFromUrl(pageUrl);
  if (
    pageType !== PAGE_TYPE.SEARCH_RESULTS ||
    !getPlatformCapabilities(pagePlatform).captureSearch
  ) {
    keywordSortDimension = KEYWORD_SORT_DIMENSION.LIKES;
    applyKeywordSortDimensionToUI(keywordSortDimension);
    stopKeywordSortSyncTimer();
    return {
      dimension: keywordSortDimension,
      source: "default",
    };
  }

  startKeywordSortSyncTimer();
  return await syncKeywordSortDimensionFromPage({
    fallbackDimension: keywordSortDimension,
  });
}

function startKeywordSortSyncTimer() {
  if (keywordSortSyncTimer) {
    return;
  }

  keywordSortSyncTimer = setInterval(() => {
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
      fallbackDimension: keywordSortDimension,
    }).catch((error) => {
      console.warn("[Sidebar] Keyword sort sync tick failed:", error);
    });
  }, KEYWORD_SORT_SYNC_INTERVAL_MS);
}

function stopKeywordSortSyncTimer() {
  if (!keywordSortSyncTimer) {
    return;
  }
  clearInterval(keywordSortSyncTimer);
  keywordSortSyncTimer = null;
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
    keywordSortDimension = fallback;
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
    if (force || normalized !== keywordSortDimension) {
      keywordSortDimension = normalized;
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
      keywordSortDimension = fallback;
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

function extractKeywordFromUrl(url) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) return "";

  try {
    const parsed = new URL(normalizedUrl);
    const keyword = extractKeywordFromSearchParams(parsed.searchParams);
    if (keyword) return keyword;

    const pathname = decodeURIComponentSafe(parsed.pathname || "");
    const douyinPathMatch = pathname.match(
      /\/(?:jingxuan\/search|search)\/([^/?#]+)/i,
    );
    if (douyinPathMatch?.[1]) {
      return decodeURIComponentSafe(douyinPathMatch[1]).trim();
    }

    const hashMatch = String(parsed.hash || "").match(
      /(?:^#|#\/).*search_result\?[^#]*\bkeyword=([^&]+)/i,
    );
    if (hashMatch) {
      return decodeURIComponentSafe(hashMatch[1]).trim();
    }
  } catch {
    // ignore
  }

  const exactMatch = normalizedUrl.match(
    /[?&](?:keyword|search_keyword|searchkey|search_word)=([^&]+)/i,
  );
  if (exactMatch) {
    return decodeURIComponentSafe(exactMatch[1]).trim();
  }

  const qMatch = normalizedUrl.match(/[?&](?:query|q)=([^&]+)/i);
  if (qMatch) {
    return decodeURIComponentSafe(qMatch[1]).trim();
  }

  const douyinFallbackMatch = normalizedUrl.match(
    /\/(?:jingxuan\/search|search)\/([^/?#]+)/i,
  );
  if (douyinFallbackMatch?.[1]) {
    return decodeURIComponentSafe(douyinFallbackMatch[1]).trim();
  }

  return "";
}

function extractKeywordFromSearchParams(searchParams) {
  if (!searchParams || typeof searchParams.entries !== "function") {
    return "";
  }

  const priorityKeys = ["keyword", "search_keyword", "searchkey", "search_word", "query", "q"];
  for (const key of priorityKeys) {
    const value = searchParams.get(key);
    if (value) {
      const decoded = decodeURIComponentSafe(value).trim();
      if (decoded) {
        return decoded;
      }
    }
  }

  for (const [key, value] of searchParams.entries()) {
    const normalizedKey = String(key || "")
      .trim()
      .toLowerCase();
    if (!SEARCH_KEYWORD_QUERY_KEYS.has(normalizedKey)) {
      continue;
    }

    const decoded = decodeURIComponentSafe(value).trim();
    if (decoded) {
      return decoded;
    }
  }

  return "";
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
  } catch {
    return String(value || "");
  }
}

function buildMediaDownloadTasks(records) {
  const tasks = [];
  const seenUrls = new Set();

  records.forEach((record) => {
    const payload = record?.payload || {};
    const prefix = sanitizeFilename(record.title || "record");
    const primaryVideoOnly = shouldDownloadPrimaryVideoOnly(record, payload);

    if (record.type === "single_note") {
      appendTask(
        tasks,
        seenUrls,
        payload.coverImageUrl,
        `${prefix}_cover.jpg`,
        "image",
      );
      if (!primaryVideoOnly) {
        (payload.imageUrls || []).forEach((url, index) => {
          appendTask(
            tasks,
            seenUrls,
            url,
            `${prefix}_image_${index + 1}${getUrlExtension(url, ".jpg")}`,
            "image",
          );
        });
      }
      collectDownloadVideoUrls(record, payload).forEach((url, index) => {
        const suffix = index === 0 ? "" : `_${index + 1}`;
        appendTask(
          tasks,
          seenUrls,
          url,
          `${prefix}_video${suffix}${getUrlExtension(url, ".mp4")}`,
          "video",
        );
      });
      collectDownloadAudioUrls(record, payload).forEach((url, index) => {
        const suffix = index === 0 ? "" : `_${index + 1}`;
        appendTask(
          tasks,
          seenUrls,
          url,
          `${prefix}_audio${suffix}${getUrlExtension(url, ".m4a")}`,
          "audio",
        );
      });
      return;
    }

    if (record.type === "blogger_notes" || record.type === "keyword_notes") {
      const detailPayload = getHydratedDetailPayload(record);
      if (detailPayload) {
        const detailPrimaryVideoOnly = shouldDownloadPrimaryVideoOnly(
          record,
          detailPayload,
        );
        appendTask(
          tasks,
          seenUrls,
          detailPayload.coverImageUrl,
          `${prefix}_cover${getUrlExtension(detailPayload.coverImageUrl, ".jpg")}`,
          "image",
        );
        if (!detailPrimaryVideoOnly) {
          (detailPayload.imageUrls || []).forEach((url, index) => {
            appendTask(
              tasks,
              seenUrls,
              url,
              `${prefix}_image_${index + 1}${getUrlExtension(url, ".jpg")}`,
              "image",
            );
          });
        }
        collectDownloadVideoUrls(record, detailPayload).forEach(
          (url, index) => {
            const suffix = index === 0 ? "" : `_${index + 1}`;
            appendTask(
              tasks,
              seenUrls,
              url,
              `${prefix}_video${suffix}${getUrlExtension(url, ".mp4")}`,
              "video",
            );
          },
        );
        collectDownloadAudioUrls(record, detailPayload).forEach(
          (url, index) => {
            const suffix = index === 0 ? "" : `_${index + 1}`;
            appendTask(
              tasks,
              seenUrls,
              url,
              `${prefix}_audio${suffix}${getUrlExtension(url, ".m4a")}`,
              "audio",
            );
          },
        );
        return;
      }

      (payload.items || []).forEach((item, index) => {
        appendTask(
          tasks,
          seenUrls,
          item.coverImageUrl,
          `${prefix}_note_${index + 1}${getUrlExtension(item.coverImageUrl, ".jpg")}`,
          "image",
        );
      });
      return;
    }

    if (record.type === "blogger_profile") {
      appendTask(
        tasks,
        seenUrls,
        payload.avatarUrl,
        `${prefix}_avatar${getUrlExtension(payload.avatarUrl, ".jpg")}`,
        "image",
      );
    }
  });

  return tasks;
}

function getHydratedDetailPayload(record) {
  if (
    !record ||
    (record.type !== "blogger_notes" && record.type !== "keyword_notes")
  ) {
    return null;
  }
  const payload = record.payload || {};
  const detailStatus = String(payload.detailCaptureStatus || "")
    .trim()
    .toLowerCase();
  if (detailStatus !== "done") return null;
  if (!payload.detailPayload || typeof payload.detailPayload !== "object") {
    return null;
  }
  return payload.detailPayload;
}

function appendTask(tasks, seenUrls, url, filename, kind = "media") {
  const normalizedUrl = normalizeDownloadUrl(url);
  if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
    return;
  }
  seenUrls.add(normalizedUrl);
  tasks.push({url: normalizedUrl, filename, kind});
}

function normalizeDownloadUrl(url) {
  if (!url || typeof url !== "string") {
    return "";
  }
  let normalized = url.trim();
  if (!normalized) {
    return "";
  }

  normalized = normalized.replace(/^url\((['"]?)(.*?)\1\)$/i, "$2").trim();
  if (normalized.startsWith("//")) {
    normalized = `https:${normalized}`;
  } else if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:\/\//i, "https://");
  }

  if (!/^https?:\/\//i.test(normalized)) {
    return "";
  }

  return normalized;
}

function getUrlExtension(url, fallback = ".jpg") {
  if (!url || typeof url !== "string") {
    return fallback;
  }
  try {
    const cleanUrl = url.split("?")[0].split("#")[0];
    const match = cleanUrl.match(/\.([a-zA-Z0-9]{2,5})$/);
    return match ? `.${match[1].toLowerCase()}` : fallback;
  } catch {
    return fallback;
  }
}

function sanitizeFilename(name) {
  const safe = String(name || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .trim();
  return safe.slice(0, 60) || `record_${Date.now()}`;
}

function downloadByChrome(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename: `onstarvoice/${filename}`,
        conflictAction: "uniquify",
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          reject(
            new Error(chrome.runtime.lastError?.message || "download failed"),
          );
          return;
        }
        resolve(downloadId);
      },
    );
  });
}

async function downloadCsvRowsByChrome(rows, filename) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const csv = safeRows.map((row) => row.join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], {
    type: "text/csv;charset=utf-8;",
  });
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await downloadByChrome(objectUrl, filename);
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
  }
}

function sleep(ms = 0) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function buildCurrentPageCsvRows(records) {
  const tab = getActiveCaptureTab();

  if (tab === "noteTab") {
    return buildNotePageCsvRows(records);
  }
  if (tab === "bloggerTab") {
    const normalized = normalizeRecordsToSingleNoteCsv(records);
    if (normalized.length > 0) {
      return buildNotePageCsvRows(normalized);
    }
    return buildBloggerPageCsvRows(records);
  }
  if (tab === "searchTab") {
    const normalized = normalizeRecordsToSingleNoteCsv(records);
    if (normalized.length > 0) {
      return buildNotePageCsvRows(normalized);
    }
    return buildSearchPageCsvRows(records);
  }

  return [["类型"].map(csvCell)];
}

function buildCommentLeadsCsvRows(records, configInput = {}) {
  const config = buildCommentLeadsConfigFromSettings(configInput);
  const header = [
    "platform",
    "noteUrl",
    "noteTitle",
    "content",
    "userName",
    "ipLocation",
    "likes",
    "userUrl",
    "userId",
    "matchedKeywords",
  ];

  if (!config.enabled || !Array.isArray(records) || records.length === 0) {
    return [header.map(csvCell)];
  }

  const rows = [];
  records.forEach((record) => {
    if (record?.type !== "single_note") {
      return;
    }
    const result = buildCommentLeadsPayloadForRecord(record, config);
    const payload = result?.payload;
    if (
      !payload ||
      !Array.isArray(payload.items) ||
      payload.items.length === 0
    ) {
      return;
    }
    const noteUrl = String(
      payload.noteUrl || record?.payload?.url || record?.payload?.noteUrl || "",
    ).trim();
    const platformLabel = getCsvPlatformLabel(record);
    const noteTitle = String(
      payload.noteTitle ||
        record?.payload?.title ||
        record?.payload?.noteTitle ||
        "",
    ).trim();
    payload.items.forEach((item) => {
      const hasLikes = item?.likes !== undefined && item?.likes !== null;
      const userName = pickFirstLeadString([
        item?.userName,
        item?.nickname,
        item?.name,
        item?.authorName,
      ]);
      const ipLocation = pickFirstLeadString([
        item?.ipLocation,
        item?.ip,
        item?.location,
        item?.region,
        item?.["ip属地"],
      ]);
      rows.push([
        platformLabel,
        noteUrl,
        noteTitle,
        String(item?.content || ""),
        userName,
        ipLocation,
        formatCsvMetricValue(item?.likes, {captured: hasLikes}),
        String(item?.userUrl || ""),
        String(item?.userId || ""),
        Array.isArray(item?.matchedKeywords)
          ? item.matchedKeywords.join(",")
          : "",
      ]);
    });
  });

  return [header.map(csvCell), ...rows.map((row) => row.map(csvCell))];
}

function buildNotePageCsvRows(records) {
  const header = [
    "采集平台",
    "博主",
    "博主主页",
    "封面链接",
    "标题",
    "笔记链接",
    "正文",
    "话题标签",
    "图片链接",
    "评论内容",
    "笔记类型",
    "采集时间",
    "笔记最近编辑时间",
    "点赞数",
    "收藏数",
    "评论数",
    "转发数",
    "粉丝数",
    "点赞与收藏数",
    "账号属性",
    "视频链接",
    "音频链接",
    "视频时长",
    "评论采集状态",
    "评论采集条数",
  ];

  const rows = [];
  records.forEach((record) => {
    if (record.type === "single_note") {
      const p = record.payload || {};
      const platform = resolveRecordPlatform(record);
      const bloggerMetricsCaptured = isCaptureStatusDone(
        p.bloggerMetricsCaptureStatus,
      );
      const hasLikes = p.likes !== undefined && p.likes !== null;
      const hasCollects = p.collects !== undefined && p.collects !== null;
      const hasComments = p.comments !== undefined && p.comments !== null;
      const hasShares = p.shares !== undefined && p.shares !== null;
      const commentsCaptureDone =
        isCaptureStatusDone(p.commentsCaptureStatus) ||
        String(p.commentsCaptureStatus || "")
          .trim()
          .toLowerCase() === "partial";
      const tags = Array.isArray(p.tags)
        ? p.tags
        : Array.isArray(p.noteTags)
          ? p.noteTags
          : [];

      rows.push([
        getCsvPlatformLabel(record),
        p.author || "",
        p.bloggerProfileUrl || p.authorUrl || "",
        p.coverImageUrl || (p.imageUrls || [])[0] || "",
        p.title || p.noteTitle || "",
        p.url || p.noteUrl || "",
        p.content || p.noteContent || "",
        formatCsvTagList(tags),
        formatCsvUrlList(p.imageUrls || []),
        p.commentsMergedText || "",
        isVideoNotePayload(p) ? "视频" : "图文",
        formatDateTime(p.captureTimestamp || record.createdAt),
        formatDateTime(firstDefinedMetricValue(p.lastEditedAt, p.publishDate)),
        formatCsvMetricValue(p.likes, {captured: hasLikes}),
        formatCsvMetricValue(p.collects, {captured: hasCollects}),
        formatCsvMetricValue(p.comments, {captured: hasComments}),
        platform === "douyin"
          ? formatCsvMetricValue(p.shares, {captured: hasShares})
          : "",
        formatCsvMetricValue(p.bloggerFollowersCount, {
          captured: bloggerMetricsCaptured,
        }),
        formatCsvMetricValue(p.bloggerLikedAndCollectedCount, {
          captured: bloggerMetricsCaptured,
        }),
        mapBloggerAccountTypeLabel(p.bloggerAccountType || p.accountType || ""),
        p.videoUrl || p.videoLink || p.video_url || "",
        getPrimaryAudioUrl(p),
        formatCsvVideoDuration(
          firstDefinedMetricValue(p.videoDuration, p.videoTime, p.duration),
        ),
        p.commentsCaptureStatus || "",
        formatCsvMetricValue(p.commentsTotalCaptured, {
          captured: commentsCaptureDone,
        }),
      ]);
      return;
    }

    if (record.type === "comments") {
      const p = record.payload || {};
      const hasTotalCount = p.totalCount !== undefined && p.totalCount !== null;
      rows.push([
        getCsvPlatformLabel(record),
        "",
        "",
        "",
        p.noteTitle || "",
        p.noteUrl || "",
        "",
        "",
        "",
        (p.items || [])
          .map(
            (item, index) =>
              `${index + 1}：${item.content || ""}（${formatCsvMetricValue(item?.likes, {captured: item?.likes !== undefined && item?.likes !== null})}个赞）`,
          )
          .join("\n"),
        "",
        formatDateTime(p.captureTimestamp || record.createdAt),
        "",
        "未采集",
        "未采集",
        formatCsvMetricValue(p.totalCount, {captured: hasTotalCount}),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        p.captureStatus || "",
        formatCsvMetricValue(p.totalCount, {captured: hasTotalCount}),
      ]);
    }
  });

  return [header.map(csvCell), ...rows.map((row) => row.map(csvCell))];
}

function normalizeRecordsToSingleNoteCsv(records = []) {
  const normalized = [];
  records.forEach((record) => {
    if (record?.type === "single_note") {
      normalized.push(record);
      return;
    }
    if (record?.type !== "blogger_notes" && record?.type !== "keyword_notes") {
      return;
    }

    const payload = record?.payload || {};
    const detailStatus = String(payload.detailCaptureStatus || "")
      .trim()
      .toLowerCase();
    const detailPayload =
      detailStatus === "done" &&
      payload.detailPayload &&
      typeof payload.detailPayload === "object"
        ? payload.detailPayload
        : null;

    if (detailPayload) {
      normalized.push({
        ...record,
        type: "single_note",
        payload: detailPayload,
      });
      return;
    }

    const item = (payload.items || [])[0] || {};
    const fallbackImageUrls = collectRecordItemImageUrls(item);
    const fallbackCoverImageUrl =
      String(item.coverImageUrl || fallbackImageUrls[0] || "").trim();
    const fallbackPayload = {
      noteType: item.noteType || item.type || "image",
      title: item.title || record.title || "",
      url: item.url || item.noteUrl || payload.detailCaptureNoteUrl || "",
      author: item.author || payload.bloggerName || "",
      content: item.content || item.noteContent || item.fullContent || item.body || "",
      likes: firstDefinedMetricValue(item.likes, item.likeCount),
      collects: firstDefinedMetricValue(item.collects, item.collectCount),
      comments: firstDefinedMetricValue(item.comments, item.commentCount),
      shares: firstDefinedMetricValue(item.shares, item.shareCount),
      bloggerFollowersCount: firstDefinedMetricValue(
        item.bloggerFollowersCount,
        payload.bloggerFollowersCount,
        payload.followersCount,
      ),
      bloggerLikedAndCollectedCount: firstDefinedMetricValue(
        item.bloggerLikedAndCollectedCount,
        payload.bloggerLikedAndCollectedCount,
        payload.likedAndCollectedCount,
      ),
      bloggerProfileUrl:
        item.bloggerProfileUrl || item.authorUrl || payload.bloggerUrl || "",
      bloggerMetricsCaptureStatus:
        item.bloggerMetricsCaptureStatus ||
        payload.bloggerMetricsCaptureStatus ||
        "not_started",
      bloggerMetricsCaptureError:
        item.bloggerMetricsCaptureError ||
        payload.bloggerMetricsCaptureError ||
        "",
      bloggerAccountType:
        item.bloggerAccountType || payload.bloggerAccountType || "",
      commentsCaptureStatus: "not_started",
      commentsTotalCaptured: null,
      commentsMergedText: "",
      coverImageUrl: fallbackCoverImageUrl,
      imageUrls: fallbackImageUrls,
      videoUrl: item.videoUrl || "",
      audioUrl:
        item.audioUrl ||
        item.musicUrl ||
        item.audio_url ||
        item.music_url ||
        "",
      videoDuration: firstDefinedMetricValue(
        item.videoDuration,
        item.videoTime,
        item.duration,
      ),
      captureTimestamp:
        payload.captureTimestamp || record.createdAt || Date.now(),
    };

    normalized.push({
      ...record,
      type: "single_note",
      payload: fallbackPayload,
    });
  });

  return normalized;
}

function collectRecordItemImageUrls(item = {}) {
  if (!item || typeof item !== "object") {
    return [];
  }

  const candidates = [];
  const append = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized) {
        candidates.push(normalized);
      }
      return;
    }
    if (typeof value === "object") {
      append(
        value.url ||
          value.src ||
          value.imageUrl ||
          value.image_url ||
          value.coverImageUrl ||
          value.cover_image_url ||
          "",
      );
    }
  };

  append(item.imageUrls);
  append(item.images);
  append(item.imageList);
  append(item.image_list);
  append(item.photoUrls);
  append(item.photo_urls);
  append(item.photos);
  append(item.media?.images);
  append(item.media?.imageUrls);
  append(item.media?.photos);
  append(item.coverImageUrl);

  return Array.from(
    new Set(
      candidates
        .map((url) => String(url || "").trim())
        .filter(Boolean),
    ),
  );
}

function isVideoNotePayload(payload) {
  const noteType = String(payload?.noteType || payload?.type || "")
    .trim()
    .toLowerCase();
  if (noteType === "video" || noteType === "视频") {
    return true;
  }
  if (
    noteType === "image" ||
    noteType === "img" ||
    noteType === "图文" ||
    noteType === "normal"
  ) {
    return false;
  }

  return Boolean(payload?.videoUrl || payload?.videoLink || payload?.video_url);
}

function shouldDownloadPrimaryVideoOnly(record, payload) {
  return (
    resolveRecordPlatform(record) === "douyin" && isVideoNotePayload(payload)
  );
}

function shouldDownloadDouyinAudio(record, payload) {
  if (resolveRecordPlatform(record) !== "douyin") {
    return true;
  }
  return isVideoNotePayload(payload);
}

function collectDownloadVideoUrls(record, payload) {
  if (!shouldDownloadPrimaryVideoOnly(record, payload)) {
    return collectVideoUrls(payload);
  }

  const primaryVideoUrl = getPrimaryVideoUrl(payload);
  return primaryVideoUrl ? [primaryVideoUrl] : [];
}

function collectDownloadAudioUrls(record, payload) {
  if (!shouldDownloadDouyinAudio(record, payload)) {
    return [];
  }

  if (!shouldDownloadPrimaryVideoOnly(record, payload)) {
    return collectAudioUrls(payload);
  }

  const primaryAudioUrl = getPrimaryAudioUrl(payload);
  return primaryAudioUrl ? [primaryAudioUrl] : [];
}

function getPrimaryVideoUrl(payload) {
  const candidates = [
    payload?.videoUrl,
    payload?.videoURL,
    payload?.video_url,
    payload?.videoLink,
    payload?.video_link,
    payload?.playUrl,
    payload?.play_url,
    payload?.media?.videoUrl,
    payload?.media?.playUrl,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeDownloadUrl(
      typeof candidate === "string" ? candidate : "",
    );
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function getPrimaryAudioUrl(payload) {
  const candidates = [
    payload?.audioUrl,
    payload?.audioURL,
    payload?.audio_url,
    payload?.musicUrl,
    payload?.musicURL,
    payload?.music_url,
    payload?.bgmUrl,
    payload?.bgmURL,
    payload?.bgm_url,
    payload?.music?.playUrl,
    payload?.music?.play_url,
    payload?.media?.audioUrl,
    payload?.media?.musicUrl,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeDownloadUrl(
      typeof candidate === "string" ? candidate : "",
    );
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function collectVideoUrls(payload) {
  const candidates = [
    payload?.videoUrl,
    payload?.videoURL,
    payload?.video_url,
    payload?.videoLink,
    payload?.video_link,
    payload?.playUrl,
    payload?.play_url,
    payload?.media?.videoUrl,
    payload?.media?.playUrl,
  ];

  const arrays = [payload?.videoUrls, payload?.videoList, payload?.videos];
  arrays.forEach((list) => {
    if (Array.isArray(list)) {
      list.forEach((item) => candidates.push(item));
    }
  });

  const seen = new Set();
  const results = [];
  candidates.forEach((item) => {
    const normalized = normalizeDownloadUrl(
      typeof item === "string" ? item : "",
    );
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    results.push(normalized);
  });

  return results;
}

function collectAudioUrls(payload) {
  const candidates = [
    payload?.audioUrl,
    payload?.audioURL,
    payload?.audio_url,
    payload?.musicUrl,
    payload?.musicURL,
    payload?.music_url,
    payload?.bgmUrl,
    payload?.bgmURL,
    payload?.bgm_url,
    payload?.music?.playUrl,
    payload?.music?.play_url,
    payload?.media?.audioUrl,
    payload?.media?.musicUrl,
  ];

  const arrays = [
    payload?.audioUrls,
    payload?.musicUrls,
    payload?.bgmUrls,
    payload?.audios,
  ];
  arrays.forEach((list) => {
    if (Array.isArray(list)) {
      list.forEach((item) => candidates.push(item));
    }
  });

  const seen = new Set();
  const results = [];
  candidates.forEach((item) => {
    const normalized = normalizeDownloadUrl(
      typeof item === "string" ? item : "",
    );
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    results.push(normalized);
  });

  return results;
}

function buildBloggerPageCsvRows(records) {
  const header = [
    "采集平台",
    "博主名称",
    "头像链接",
    "博主ID",
    "简介",
    "IP属地",
    "主页链接",
    "采集时间",
    "关注数",
    "粉丝数",
    "点赞与收藏数",
    "账号属性",
  ];

  const rows = [];
  records.forEach((record) => {
    const p = record.payload || {};
    if (record.type === "blogger_profile") {
      const profileMetricsCaptured = isCaptureStatusDone(
        p.bloggerMetricsCaptureStatus,
      );
      rows.push([
        getCsvPlatformLabel(record),
        p.bloggerName || "",
        p.avatarUrl || "",
        p.bloggerId || p.douyinId || "",
        p.description || "",
        p.ipLocation || "",
        p.bloggerUrl || "",
        formatDateTime(p.captureTimestamp || record.createdAt),
        formatCsvMetricValue(p.followingCount, {
          captured: profileMetricsCaptured,
        }),
        formatCsvMetricValue(p.followersCount, {
          captured: profileMetricsCaptured,
        }),
        formatCsvMetricValue(p.likedAndCollectedCount, {
          captured: profileMetricsCaptured,
        }),
        mapBloggerAccountTypeLabel(p.bloggerAccountType || p.accountType || ""),
      ]);
    }
  });

  return [header.map(csvCell), ...rows.map((row) => row.map(csvCell))];
}

function buildSearchPageCsvRows(records) {
  const header = [
    "平台",
    "关键词",
    "标题",
    "正文",
    "链接",
    "作者",
    "笔记最近编辑时间",
    "点赞数",
    "收藏数",
    "评论数",
    "转发数",
    "粉丝数",
    "点赞与收藏数",
    "账号属性",
    "封面",
    "音频链接",
    "视频时长",
    "采集时间",
  ];

  const rows = [];
  records.forEach((record) => {
    const p = record.payload || {};
    if (record.type !== "keyword_notes") return;
    const item = (p.items || [])[0] || {};
    const platform = resolveRecordPlatform(record);
    const itemMetricsCaptured = isCaptureStatusDone(
      item.bloggerMetricsCaptureStatus || p.bloggerMetricsCaptureStatus,
    );
    const hasLikes = item.likes !== undefined && item.likes !== null;
    const hasCollects = item.collects !== undefined && item.collects !== null;
    const hasComments = item.comments !== undefined && item.comments !== null;
    const hasShares = item.shares !== undefined && item.shares !== null;
    rows.push([
      getCsvPlatformLabel(record),
      p.keyword || "",
      item.title || "",
      item.content || item.noteContent || item.fullContent || item.body || "",
      item.url || "",
      item.author || "",
      item.publishDate || item.publishDateRaw || "",
      formatCsvMetricValue(item.likes, {captured: hasLikes}),
      formatCsvMetricValue(item.collects, {captured: hasCollects}),
      formatCsvMetricValue(item.comments, {captured: hasComments}),
      platform === "douyin" || platform === "weibo"
        ? formatCsvMetricValue(item.shares, {captured: hasShares})
        : "",
      formatCsvMetricValue(item.bloggerFollowersCount, {
        captured: itemMetricsCaptured,
      }),
      formatCsvMetricValue(item.bloggerLikedAndCollectedCount, {
        captured: itemMetricsCaptured,
      }),
      mapBloggerAccountTypeLabel(item.bloggerAccountType || ""),
      item.coverImageUrl || "",
      getPrimaryAudioUrl(item),
      formatCsvVideoDuration(
        firstDefinedMetricValue(
          item.videoDuration,
          item.videoTime,
          item.duration,
        ),
      ),
      formatDateTime(p.captureTimestamp || record.createdAt),
    ]);
  });

  return [header.map(csvCell), ...rows.map((row) => row.map(csvCell))];
}

function formatDateTime(timestamp) {
  if (!timestamp) return "";
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

function getCsvPlatformLabel(record) {
  return getPlatformCopy(resolveRecordPlatform(record)).label;
}

function normalizeMetricNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

function pickFirstLeadString(candidates = []) {
  for (const candidate of candidates) {
    const text = String(candidate || "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function firstDefinedMetricValue(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") {
      continue;
    }
    return candidate;
  }
  return null;
}

function formatCsvTagList(tags = []) {
  if (!Array.isArray(tags)) {
    return "";
  }
  const normalized = tags
    .map((tag) => String(tag || "").trim())
    .filter(Boolean);
  return Array.from(new Set(normalized)).join(",");
}

function formatCsvUrlList(urls = []) {
  if (!Array.isArray(urls)) {
    return "";
  }
  const normalized = urls
    .map((url) => String(url || "").trim())
    .filter(Boolean);
  return Array.from(new Set(normalized)).join(" | ");
}

function formatCsvVideoDuration(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      return trimmed;
    }
    value = numeric;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "";
  }

  const totalSeconds = Math.max(
    0,
    Math.floor(value >= 1000 ? value / 1000 : value),
  );
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
  }

  return `${mm}:${ss}`;
}

function formatCsvMetricValue(value, {captured = true} = {}) {
  if (!captured) {
    return "未采集";
  }
  const normalized = normalizeMetricNumber(value);
  if (normalized === null) {
    return "未采集";
  }
  return normalized;
}

function isCaptureStatusDone(status) {
  return (
    String(status || "")
      .trim()
      .toLowerCase() === "done"
  );
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function resolveBloggerNoteTypeLabel(item) {
  const raw = String(item?.noteType || item?.type || "")
    .trim()
    .toLowerCase();
  return raw === "video" || raw === "视频" ? "视频" : "图文";
}

function mapBloggerAccountTypeLabel(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "famous" || normalized === "红v") return "红V";
  if (normalized === "company" || normalized === "蓝v") return "蓝V";
  return "普通";
}

// ==================== UI 更新函数 ====================

/**
 * 更新整体 UI
 */
function updateUI() {
  const runtime = getCurrentRuntime();
  const auth = getCurrentAuth();
  const target = getCurrentTarget();
  const capture = getCurrentCapture();
  const sync = getCurrentSync();
  const dataPool = getCurrentDataPool();

  window.getSidebarAuthState = () => auth;
  window.getSidebarRuntimeState = () => runtime;
  updatePlatformUI(runtime);
  updatePageTypeUI(runtime?.pageType || PAGE_TYPE.UNKNOWN);
  updateAuthUI(auth);
  updateTargetUI(target);
  updateCaptureUI(capture);
  updateSyncUI(sync);
  updateDataPoolUI(dataPool);
}

function updatePlatformUI(runtimeOrUrl) {
  const runtime =
    runtimeOrUrl && typeof runtimeOrUrl === "object"
      ? runtimeOrUrl
      : getCurrentRuntime();
  const runtimeUrl =
    typeof runtimeOrUrl === "string"
      ? runtimeOrUrl
      : runtime?.lastPageUrl || "";
  const urlPlatform = detectPlatformFromUrl(runtimeUrl);
  const runtimePlatform = String(runtime?.platform || "").trim();
  const normalizedPagePlatform =
    urlPlatform && urlPlatform !== "unknown"
      ? urlPlatform
      : runtimePlatform && runtimePlatform !== "unknown"
        ? runtimePlatform
        : "unknown";
  if (
    normalizedPagePlatform &&
    normalizedPagePlatform !== "unknown" &&
    normalizedPagePlatform !== lastKnownPagePlatform
  ) {
    lastKnownPagePlatform = normalizedPagePlatform;
    manualSelectedPlatform = "";
  } else if (!lastKnownPagePlatform || lastKnownPagePlatform === "unknown") {
    lastKnownPagePlatform = normalizedPagePlatform || "unknown";
  }
  const selectedPlatform = resolveSelectedPlatform(
    runtime,
    normalizedPagePlatform,
  );
  syncBatchDraftForPlatform(selectedPlatform);

  document.body.dataset.pagePlatform = normalizedPagePlatform || "unknown";
  document.body.dataset.selectedPlatform = selectedPlatform;
  document.body.dataset.activePlatform = selectedPlatform;
  window.renderPlatformCaptureTabs?.(selectedPlatform);

  syncPlatformMenuUI({
    selectedPlatform,
    pagePlatform: normalizedPagePlatform || "unknown",
  });
  syncPlatformSettingsCapabilityUI(selectedPlatform);
}

function setPrimaryCaptureButtonDisabled(button, disabled) {
  if (!button) {
    return;
  }
  const nextDisabled = Boolean(disabled);
  button.disabled = nextDisabled;
  button.classList.toggle("is-disabled", nextDisabled);
}

/**
 * 更新页面类型 UI
 */
function updatePageTypeUI(pageType) {
  const isNote = pageType === PAGE_TYPE.NOTE_DETAIL;
  const isBlogger = pageType === PAGE_TYPE.BLOGGER_PROFILE;
  const isSearch = pageType === PAGE_TYPE.SEARCH_RESULTS;
  const runtime = getCurrentRuntime();
  const pagePlatform = getPagePlatform(runtime);
  const selectedPlatform = getViewPlatform(runtime);
  const selectedCapabilities = getPlatformCapabilities(selectedPlatform);
  const isPlatformMatched = selectedPlatform === pagePlatform;
  const inDetailBatch = detailBatchCaptureInFlight;
  const allowCommentsToggle =
    !inDetailBatch && selectedCapabilities.captureComments;
  const platformCopy = getPlatformCopy(selectedPlatform);

  const btnCaptureNote = document.getElementById("btnCaptureNote");
  const checkboxCaptureBloggerMetrics = document.getElementById(
    "checkboxCaptureBloggerMetrics",
  );
  const captureBloggerMetricsSwitchWrap = document.getElementById(
    "captureBloggerMetricsSwitchWrap",
  );
  const checkboxCaptureComments = document.getElementById(
    "checkboxCaptureComments",
  );
  const inputCommentsMaxDetectedItems = document.getElementById(
    "inputCommentsMaxDetectedItems",
  );
  const btnCaptureBlogger = document.getElementById("btnCaptureBlogger");
  const inputBloggerMinLikes = document.getElementById("inputBloggerMinLikes");
  const inputBloggerMaxDetectedItems = document.getElementById(
    "inputBloggerMaxDetectedItems",
  );
  const btnCaptureSearch = document.getElementById("btnCaptureSearch");
  const btnToggleKeywordStrategy = document.getElementById(
    "btnToggleKeywordStrategy",
  );
  const currentSearchKeywordText = document.getElementById(
    "currentSearchKeywordText",
  );
  const inputKeywordMinLikes = document.getElementById("inputKeywordMinLikes");
  const inputKeywordMaxDetectedItems = document.getElementById(
    "inputKeywordMaxDetectedItems",
  );
  const labelKeywordMinThreshold = document.getElementById(
    "labelKeywordMinThreshold",
  );

  setPrimaryCaptureButtonDisabled(
    btnCaptureNote,
    !isNote || inDetailBatch || !isPlatformMatched,
  );
  if (checkboxCaptureBloggerMetrics) {
    checkboxCaptureBloggerMetrics.disabled =
      inDetailBatch || !selectedCapabilities.bloggerMetrics;
  }
  if (captureBloggerMetricsSwitchWrap) {
    captureBloggerMetricsSwitchWrap.hidden =
      shouldHideNoteBloggerMetricsToggle(selectedPlatform);
  }
  if (checkboxCaptureComments)
    checkboxCaptureComments.disabled = !allowCommentsToggle;
  if (inputCommentsMaxDetectedItems) {
    syncCommentsCaptureControls({forceDisabled: !allowCommentsToggle});
  }
  setPrimaryCaptureButtonDisabled(
    btnCaptureBlogger,
    !isBlogger || inDetailBatch || !isPlatformMatched,
  );
  if (inputBloggerMinLikes) inputBloggerMinLikes.disabled = inDetailBatch;
  if (inputBloggerMaxDetectedItems)
    inputBloggerMaxDetectedItems.disabled = inDetailBatch;
  const inputBloggerKeywordFilter = document.getElementById(
    "inputBloggerKeywordFilter",
  );
  if (inputBloggerKeywordFilter)
    inputBloggerKeywordFilter.disabled = inDetailBatch;
  setPrimaryCaptureButtonDisabled(
    btnCaptureSearch,
    !isSearch ||
      inDetailBatch ||
      !isPlatformMatched ||
      !selectedCapabilities.captureSearch,
  );
  if (btnToggleKeywordStrategy) {
    btnToggleKeywordStrategy.disabled =
      !isSearch ||
      inDetailBatch ||
      !isPlatformMatched ||
      !selectedCapabilities.captureSearch;
    btnToggleKeywordStrategy.classList.toggle(
      "is-disabled",
      btnToggleKeywordStrategy.disabled,
    );
  }
  const currentSearchKeyword = getCurrentSearchKeyword(runtime);
  if (inputKeywordMinLikes)
    inputKeywordMinLikes.disabled =
      inDetailBatch || !selectedCapabilities.captureSearch;
  if (inputKeywordMaxDetectedItems)
    inputKeywordMaxDetectedItems.disabled =
      inDetailBatch || !selectedCapabilities.captureSearch;
  if (btnCaptureNote) {
    btnCaptureNote.textContent = platformCopy.captureNoteButtonText;
  }
  if (btnCaptureBlogger) {
    btnCaptureBlogger.textContent = platformCopy.captureBloggerButtonText;
  }
  if (btnCaptureSearch) {
    btnCaptureSearch.textContent = platformCopy.captureSearchButtonText;
  }
  if (currentSearchKeywordText) {
    if (currentSearchKeyword) {
      currentSearchKeywordText.textContent = currentSearchKeyword;
      currentSearchKeywordText.classList.remove("is-empty");
    } else {
      currentSearchKeywordText.textContent = "未检测到关键词";
      currentSearchKeywordText.classList.add("is-empty");
    }
  }
  if (labelKeywordMinThreshold && !selectedCapabilities.captureSearch) {
    labelKeywordMinThreshold.textContent = "当前平台搜索采集将在后续版本开放";
  } else if (labelKeywordMinThreshold) {
    labelKeywordMinThreshold.textContent = "高于以下点赞数才会被采集";
  }
  syncAutoDetailCaptureControls({
    forceDisabled: inDetailBatch,
    platform: selectedPlatform,
  });

  if (isSearch && selectedCapabilities.captureSearch) {
    applyKeywordSortDimensionToUI(keywordSortDimension);
    startKeywordSortSyncTimer();
  } else {
    stopKeywordSortSyncTimer();
    keywordSortDimension = KEYWORD_SORT_DIMENSION.LIKES;
    applyKeywordSortDimensionToUI(keywordSortDimension);
  }
  maybeResetKeywordOpportunityForCurrentSearch(runtime);
  renderKeywordStrategyPanel();
}

/**
 * 更新鉴权 UI
 */
function updateAuthUI(auth) {
  const status = auth?.status;
  const isVerified = isAuthVerified(auth);
  const isUnclaimedOwner = isUnclaimedCredentialOwner(auth);

  // 更新鉴权状态指示器
  const authStatus = document.getElementById("authStatus");
  if (authStatus) {
    if (status === AUTH_STATUS.VERIFYING) {
      authStatus.textContent = "验证中";
      authStatus.style.color = "var(--status-info)";
    } else if (isVerified && isUnclaimedOwner) {
      authStatus.textContent = "未绑定";
      authStatus.style.color = "var(--status-warning)";
    } else if (isVerified) {
      authStatus.textContent = "已激活";
      authStatus.style.color = "var(--status-success)";
    } else {
      authStatus.textContent = "未激活";
      authStatus.style.color = "var(--status-warning)";
    }
  }

  const runtime = getCurrentRuntime();
  updatePageTypeUI(runtime?.pageType || PAGE_TYPE.UNKNOWN);

  updateAuthCodeVisibilityButton();
  void renderAuthCodeInput(auth);
  void updateMemberGroupEntryVisibility(auth);
}

/**
 * 更新目标配置 UI
 */
function updateTargetUI(target) {
  const inputFeishuAppToken = document.getElementById("inputFeishuAppToken");
  const inputTableId = document.getElementById("inputTableId");
  const inputKeywordNotesTableName = document.getElementById(
    "inputKeywordNotesTableName",
  );
  const inputBloggerProfileTableName = document.getElementById(
    "inputBloggerProfileTableName",
  );
  const inputBloggerNotesTableName = document.getElementById(
    "inputBloggerNotesTableName",
  );
  const inputCommentLeadsTableName = document.getElementById(
    "inputCommentLeadsTableName",
  );
  const inputMonitorTableName = document.getElementById(
    "inputMonitorTableName",
  );
  const inputReportWebhookUrl = document.getElementById(
    "inputReportWebhookUrl",
  );

  if (inputFeishuAppToken) {
    inputFeishuAppToken.value = target.feishuAppToken || "";
  }

  if (inputTableId) {
    inputTableId.value = target.tableId || DEFAULT_SINGLE_NOTE_TABLE_NAME;
  }

  if (inputKeywordNotesTableName) {
    inputKeywordNotesTableName.value =
      target.keywordNotesTableName || DEFAULT_KEYWORD_NOTES_TABLE_NAME;
  }

  if (inputBloggerProfileTableName) {
    inputBloggerProfileTableName.value =
      target.bloggerProfileTableName || DEFAULT_BLOGGER_PROFILE_TABLE_NAME;
  }

  if (inputBloggerNotesTableName) {
    inputBloggerNotesTableName.value =
      target.bloggerNotesTableName || DEFAULT_BLOGGER_NOTES_TABLE_NAME;
  }

  if (inputCommentLeadsTableName) {
    inputCommentLeadsTableName.value =
      target.commentLeadsTableName || DEFAULT_COMMENT_LEADS_TABLE_NAME;
  }

  if (inputMonitorTableName) {
    inputMonitorTableName.value =
      target.monitorTableName || DEFAULT_MONITOR_TABLE_NAME;
  }

  if (inputReportWebhookUrl) {
    inputReportWebhookUrl.value = target.reportWebhookUrl || "";
  }
}

/**
 * 更新采集状态 UI
 */
function updateCaptureUI(capture) {
  // 根据 Gemini 的新 UI 结构更新
  // TODO: 根据实际 HTML 结构调整
}

/**
 * 更新同步状态 UI
 */
function updateSyncUI(sync) {
  // 根据 Gemini 的新 UI 结构更新
  // TODO: 根据实际 HTML 结构调整
}

/**
 * 更新数据池 UI
 */
function updateDataPoolUI(dataPool) {
  const records = getCurrentPageRecords(dataPool?.records || []);
  const statsText = document.getElementById("poolStatsText");
  if (statsText) {
    statsText.textContent = `共 ${records.length} 条数据`;
  }

  const btnExport = document.getElementById("btnExport");
  const btnSyncAll = document.getElementById("btnSyncAll");
  const btnClearPool = document.getElementById("btnClearPool");

  const hasRecords = records.length > 0;

  if (btnExport) btnExport.disabled = !hasRecords || detailBatchCaptureInFlight;
  if (btnSyncAll)
    btnSyncAll.disabled = !hasRecords || detailBatchCaptureInFlight;
  if (btnClearPool)
    btnClearPool.disabled = !hasRecords || detailBatchCaptureInFlight;
}

// ==================== 辅助函数 ====================

function getActiveCaptureTab() {
  const activeMainTab = document.querySelector(
    "#mainTabNav .tab-btn.is-active",
  );
  return activeMainTab?.dataset?.target || "noteTab";
}

function getCurrentPageRecordTypes() {
  const tab = getActiveCaptureTab();
  const activePlatform =
    document.body.dataset.selectedPlatform ||
    getViewPlatform(getCurrentRuntime());
  return getRecordTypesForTab(activePlatform, tab);
}

function getCurrentPageRecords(inputRecords = null) {
  const records = inputRecords || getCurrentDataPool()?.records || [];
  const currentTypes = new Set(getCurrentPageRecordTypes());
  const activePlatform =
    document.body.dataset.selectedPlatform ||
    getViewPlatform(getCurrentRuntime());
  return records.filter((record) => {
    const recordType = String(record?.type || record?.recordType || "").trim();
    if (!currentTypes.has(recordType)) {
      return false;
    }
    if (activePlatform === "unknown") {
      return true;
    }
    const recordPlatform = resolveRecordPlatform(record);
    return recordPlatform === activePlatform || recordPlatform === "unknown";
  });
}

function getPagePlatform(runtime = null) {
  const nextRuntime = runtime || getCurrentRuntime() || {};
  const urlPlatform = detectPlatformFromUrl(nextRuntime?.lastPageUrl || "");
  if (urlPlatform && urlPlatform !== "unknown") {
    return urlPlatform;
  }
  const directPlatform = String(nextRuntime?.platform || "").trim();
  if (directPlatform && directPlatform !== "unknown") {
    return directPlatform;
  }
  return "unknown";
}

function getViewPlatform(runtime = null) {
  return resolveSelectedPlatform(runtime);
}

function resolveSelectedPlatform(runtime = null, pagePlatform = "") {
  const nextRuntime = runtime || getCurrentRuntime() || {};
  const resolvedPagePlatform = pagePlatform || getPagePlatform(nextRuntime);
  if (manualSelectedPlatform && manualSelectedPlatform !== "unknown") {
    return manualSelectedPlatform;
  }
  if (resolvedPagePlatform && resolvedPagePlatform !== "unknown") {
    return resolvedPagePlatform;
  }
  return "unknown";
}

function setPlatformMenuOpen(isOpen) {
  const dropdownPlatformMenu = document.getElementById("dropdownPlatformMenu");
  const btnPlatformMenu = document.getElementById("btnPlatformMenu");
  if (dropdownPlatformMenu) {
    dropdownPlatformMenu.classList.toggle("is-active", Boolean(isOpen));
  }
  if (btnPlatformMenu) {
    btnPlatformMenu.classList.toggle("is-active", Boolean(isOpen));
    btnPlatformMenu.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }
}

function syncPlatformMenuUI({
  selectedPlatform = "unknown",
  pagePlatform = "unknown",
}) {
  const displayPlatform =
    pagePlatform && pagePlatform !== "unknown"
      ? pagePlatform
      : selectedPlatform || "unknown";
  const currentPlatformCopy = getPlatformCopy(displayPlatform);
  const pagePlatformCopy = getPlatformCopy(pagePlatform || "unknown");
  const selectedPlatformCopy = getPlatformCopy(selectedPlatform || "unknown");
  const currentPlatformName = document.getElementById("currentPlatformName");
  const currentPlatformLogo = document.getElementById("currentPlatformLogo");
  const btnPlatformMenu = document.getElementById("btnPlatformMenu");

  if (currentPlatformName) {
    currentPlatformName.textContent = currentPlatformCopy.label;
  }
  if (currentPlatformLogo) {
    currentPlatformLogo.className = `platform-trigger-logo platform-logo ${getPlatformLogoClass(displayPlatform)}`;
    currentPlatformLogo.innerHTML = getPlatformLogoInnerMarkup(displayPlatform);
  }
  if (btnPlatformMenu) {
    btnPlatformMenu.title =
      selectedPlatform === pagePlatform ||
      !selectedPlatform ||
      selectedPlatform === "unknown"
        ? `当前页面平台：${pagePlatformCopy.label}`
        : `当前页面平台：${pagePlatformCopy.label}；当前视图：${selectedPlatformCopy.label}`;
  }

  document
    .querySelectorAll(".platform-menu-item[data-platform]")
    .forEach((button) => {
      const buttonPlatform = String(button.dataset.platform || "").trim();
      const isSelected = buttonPlatform === selectedPlatform;
      const isPagePlatform = buttonPlatform === pagePlatform;
      button.classList.toggle("is-active", isSelected);
      button.classList.toggle("is-page-platform", isPagePlatform);
      button.setAttribute("aria-pressed", isSelected ? "true" : "false");
    });
}

function syncPlatformSettingsCapabilityUI(platform = "unknown") {
  const capabilities = getPlatformCapabilities(platform);
  const platformCopy = getPlatformCopy(platform);

  const commentRelatedControls = [
    document.getElementById("checkboxEnableCommentLeadsFilter"),
    document.getElementById("inputCommentLeadsKeywords"),
    document.getElementById("inputCommentLeadsIps"),
    document.getElementById("inputCommentLeadsTableName"),
    ...Array.from(
      document.querySelectorAll(
        '[data-detail-setting="comments-max-detected-items"], [data-detail-setting="comment-leads"]',
      ),
    ),
    document.getElementById("batchDetailIncludeComments"),
    document.getElementById("batchDetailCommentsLimit"),
    document.getElementById("batchDetailEnableCommentLeadsFilter"),
  ];
  const searchRelatedControls = [
    document.getElementById("inputKeywordNotesTableName"),
  ];

  const commentDisabledReason = capabilities.captureComments
    ? ""
    : `${platformCopy.label}当前版本暂不支持评论采集`;
  const bloggerMetricsDisabledReason = capabilities.bloggerMetrics
    ? ""
    : `${platformCopy.label}当前版本暂不支持单作品博主指标增强`;
  const searchDisabledReason = capabilities.captureSearch
    ? ""
    : `${platformCopy.label}当前版本暂不支持搜索采集`;

  commentRelatedControls.forEach((control) => {
    if (!control) return;
    control.disabled = !capabilities.captureComments;
    control.title = commentDisabledReason;
  });

  searchRelatedControls.forEach((control) => {
    if (!control) return;
    control.disabled = !capabilities.captureSearch;
    control.title = searchDisabledReason;
  });
}

function getPlatformLogoClass(platform) {
  if (platform === "unknown") {
    return "platform-logo-unknown";
  }
  if (platform === "xiaohongshu") {
    return "platform-logo-xiaohongshu";
  }
  if (platform === "weibo") {
    return "platform-logo-weibo";
  }
  return "platform-logo-douyin";
}

function getPlatformLogoInnerMarkup(platform) {
  if (platform === "unknown") {
    return "?";
  }
  if (platform === "xiaohongshu") {
    return '<span class="platform-logo-xiaohongshu-inner">小红书</span>';
  }
  if (platform === "weibo") {
    return '<span class="platform-logo-weibo-inner">W</span>';
  }
  return '<span class="platform-logo-douyin-inner">♪</span>';
}

function getDetailCaptureTargetRecords(records = [], options = {}) {
  const scope =
    options?.scope === DETAIL_CAPTURE_SCOPE_ALL
      ? DETAIL_CAPTURE_SCOPE_ALL
      : DETAIL_CAPTURE_SCOPE_PENDING;
  return records.filter((record) => {
    if (!isDetailCaptureRecord(record)) {
      return false;
    }
    if (scope === DETAIL_CAPTURE_SCOPE_ALL) {
      return true;
    }
    return !isDetailCaptureDone(record);
  });
}

function isDetailCaptureRecord(record) {
  return Boolean(
    record &&
    (record.type === "blogger_notes" || record.type === "keyword_notes"),
  );
}

function isDetailCaptureDone(record) {
  const payload = record?.payload || {};
  const detailStatus = String(payload.detailCaptureStatus || "")
    .trim()
    .toLowerCase();
  return (
    detailStatus === "done" &&
    payload.detailPayload &&
    typeof payload.detailPayload === "object"
  );
}

function isDetailCaptureRetryable(record) {
  if (!isDetailCaptureRecord(record) || isDetailCaptureDone(record)) {
    return false;
  }
  const payload = record?.payload || {};
  const status = String(payload.detailCaptureStatus || "not_started")
    .trim()
    .toLowerCase();
  return status !== "capturing";
}

function getBatchRetryDetailRecordIds(triggerRecordId = "") {
  const pageRecords = getCurrentPageRecords();
  const retryableRecords = pageRecords.filter((record) =>
    isDetailCaptureRetryable(record),
  );
  if (retryableRecords.length === 0) {
    return [];
  }

  const ids = retryableRecords.map((record) => record.id);
  if (!triggerRecordId || !ids.includes(triggerRecordId)) {
    return ids;
  }

  return [
    triggerRecordId,
    ...ids.filter((recordId) => recordId !== triggerRecordId),
  ];
}

function summarizeDetailCaptureBlockers(records = []) {
  const summary = {
    total: 0,
    notStarted: 0,
    capturing: 0,
    failed: 0,
    linkMissing: 0,
    pageFailed: 0,
    contextInterrupted: 0,
  };

  records.forEach((record) => {
    if (!isDetailCaptureRecord(record) || isDetailCaptureDone(record)) {
      return;
    }

    summary.total += 1;
    const payload = record?.payload || {};
    const status = String(payload.detailCaptureStatus || "not_started")
      .trim()
      .toLowerCase();
    const category = String(payload.detailCaptureFailureCategory || "")
      .trim()
      .toLowerCase();

    if (status === "capturing") {
      summary.capturing += 1;
      return;
    }
    if (status === "failed") {
      summary.failed += 1;
      if (category === "link_missing") {
        summary.linkMissing += 1;
      } else if (category === "context_interrupted") {
        summary.contextInterrupted += 1;
      } else {
        summary.pageFailed += 1;
      }
      return;
    }

    summary.notStarted += 1;
  });

  return summary;
}

function buildDetailCaptureBlockerMessage(summary) {
  const parts = [];
  if (summary.capturing > 0) {
    parts.push(`进行中 ${summary.capturing} 条`);
  }

  const reasonParts = [];
  if (summary.contextInterrupted > 0) {
    reasonParts.push(`任务中断 ${summary.contextInterrupted} 条`);
  }
  if (summary.pageFailed > 0) {
    reasonParts.push(`页面失败 ${summary.pageFailed} 条`);
  }
  if (summary.linkMissing > 0) {
    reasonParts.push(`链接缺失 ${summary.linkMissing} 条`);
  }

  return `当前有 ${summary.capturing} 条记录正在执行采集增强（${parts.join("，")}），暂不允许同步后台，避免同步过程中数据被覆盖${
    reasonParts.length > 0 ? `。原因分布：${reasonParts.join("，")}` : ""
  }。请等待采集增强完成后再同步。`;
}

function buildDetailCaptureSyncWarningMessage(summary) {
  const parts = [];
  if (summary.notStarted > 0) {
    parts.push(`未执行 ${summary.notStarted} 条`);
  }
  if (summary.failed > 0) {
    parts.push(`失败 ${summary.failed} 条`);
  }

  const reasonParts = [];
  if (summary.linkMissing > 0) {
    reasonParts.push(`链接缺失 ${summary.linkMissing} 条`);
  }
  if (summary.pageFailed > 0) {
    reasonParts.push(`页面失败 ${summary.pageFailed} 条`);
  }
  if (summary.contextInterrupted > 0) {
    reasonParts.push(`任务中断 ${summary.contextInterrupted} 条`);
  }

  return `当前有 ${summary.total} 条记录未完成采集增强（${parts.join("，")}）。继续同步将只同步当前已采集到的基础字段，正文、标签、评论、图片/视频链接等增强字段可能为空，后续完成采集增强后可再次同步补齐${
    reasonParts.length > 0 ? `。原因分布：${reasonParts.join("，")}` : ""
  }。`;
}

function summarizeDetailCaptureFailures(results = []) {
  const summary = {
    linkMissing: 0,
    pageFailed: 0,
    contextInterrupted: 0,
    otherFailed: 0,
  };

  results.forEach((item) => {
    if (!item || item.ok) {
      return;
    }
    const category = String(item.category || "")
      .trim()
      .toLowerCase();
    if (category === "link_missing") {
      summary.linkMissing += 1;
    } else if (category === "page_failed") {
      summary.pageFailed += 1;
    } else if (
      category === "context_interrupted" ||
      category === "user_canceled"
    ) {
      summary.contextInterrupted += 1;
    } else {
      summary.otherFailed += 1;
    }
  });

  return summary;
}

function buildDetailCaptureFailureSummaryText(result) {
  const summary = summarizeDetailCaptureFailures(result?.results || []);
  const parts = [];
  if (summary.linkMissing > 0) {
    parts.push(`链接缺失 ${summary.linkMissing}`);
  }
  if (summary.pageFailed > 0) {
    parts.push(`页面失败 ${summary.pageFailed}`);
  }
  if (summary.contextInterrupted > 0) {
    parts.push(`任务中断 ${summary.contextInterrupted}`);
  }
  if (summary.otherFailed > 0) {
    parts.push(`其他失败 ${summary.otherFailed}`);
  }
  return parts.length > 0 ? `（${parts.join("，")}）` : "";
}

function getRecordPrimaryNoteUrl(record) {
  if (!record || typeof record !== "object") {
    return "";
  }
  const payload = record.payload || {};
  const firstItem = Array.isArray(payload.items) ? payload.items[0] : null;
  const candidates = [
    firstItem?.url,
    firstItem?.noteUrl,
    payload?.detailCaptureNoteUrl,
    payload?.url,
    payload?.noteUrl,
    buildFallbackDetailNoteUrl(record),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeNoteUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function buildFallbackDetailNoteUrl(record) {
  const noteId = resolveRecordDetailNoteId(record);
  if (!noteId) {
    return "";
  }

  const platform = resolveRecordPlatform(record);
  if (platform === "douyin") {
    return `https://www.douyin.com/${resolveRecordDetailNotePath(record)}/${noteId}`;
  }

  return `https://www.xiaohongshu.com/explore/${noteId}`;
}

function resolveRecordDetailNoteId(record) {
  const payload = record?.payload || {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === "object"
      ? payload.items[0]
      : {};
  const candidates = [
    firstItem.noteId,
    payload.noteId,
    firstItem.id,
    payload.id,
    extractNoteId(firstItem.url),
    extractNoteId(firstItem.noteUrl),
    extractNoteId(payload.detailCaptureNoteUrl),
    extractNoteId(payload.url),
    extractNoteId(payload.noteUrl),
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || normalized.startsWith("synthetic_")) {
      continue;
    }
    if (/^[a-zA-Z0-9_-]{6,}$/.test(normalized)) {
      return normalized;
    }
  }

  return "";
}

function resolveRecordDetailNotePath(record) {
  const payload = record?.payload || {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === "object"
      ? payload.items[0]
      : {};
  const rawType = String(
    firstItem.noteType ||
      firstItem.type ||
      payload.noteType ||
      payload.type ||
      "",
  )
    .trim()
    .toLowerCase();

  if (rawType === "image" || rawType === "图文") {
    return "note";
  }

  return "video";
}

function normalizeNoteUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  let normalized = raw;
  if (normalized.startsWith("//")) {
    normalized = `https:${normalized}`;
  }
  if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:\/\//i, "https://");
  }

  try {
    const parsed = new URL(normalized);
    const hostname = String(parsed.hostname || "").toLowerCase();
    const supportedHost =
      hostname === "xiaohongshu.com" ||
      hostname.endsWith(".xiaohongshu.com") ||
      hostname === "douyin.com" ||
      hostname.endsWith(".douyin.com");
    if (!supportedHost) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

/**
 * 显示消息
 */
function showMessage(message, type = "info") {
  console.log(`[Sidebar] Message (${type}):`, message);

  if (
    typeof window.showMessage === "function" &&
    window.showMessage !== showMessage
  ) {
    window.showMessage(message, type);
    return;
  }

  alert(message);
}

function isUnsupportedPlatformCoverVisible() {
  return document.body.classList.contains(
    "is-unsupported-platform-cover-visible",
  );
}

/**
 * 显示进度
 */
function showProgress(message, showUI = true) {
  const showPanel = Boolean(showUI) && !isUnsupportedPlatformCoverVisible();
  const progressContainer = document.getElementById("progressContainer");
  if (progressContainer) {
    progressContainer.style.display = showPanel ? "block" : "none";
  }

  const progressText = document.getElementById("progressText");
  const progressBar = document.getElementById("progressBar");
  if (progressText && showPanel) {
    progressText.textContent = message;
    if (progressBar) {
      progressBar.className = "status-bar is-info";
    }
  }

  setCaptureButtonsDisabled(true);

  // 显示取消按钮
  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel && showPanel) {
    btnCancel.style.display = "inline-block";
  } else if (btnCancel) {
    btnCancel.style.display = "none";
  }
}

function hideProgressPanelOnly() {
  const progressContainer = document.getElementById("progressContainer");
  if (progressContainer) {
    progressContainer.style.display = "none";
  }

  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel) {
    btnCancel.style.display = "none";
  }
}

function isTerminalProgressPhase(phase) {
  const normalized = String(phase || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized === "canceled" ||
    normalized === "cancelled" ||
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "done" ||
    normalized === "completed" ||
    normalized === "detail_batch_done" ||
    normalized === "detail_batch_canceled" ||
    normalized === "blogger_metrics_done" ||
    normalized === "blogger_metrics_failed" ||
    normalized === "batch_done" ||
    normalized === "sync_failed" ||
    normalized === "synced"
  );
}

/**
 * 隐藏进度
 */
function hideProgress() {
  hideProgressPanelOnly();

  const runtime = getCurrentRuntime();
  updatePageTypeUI(runtime?.pageType || PAGE_TYPE.UNKNOWN);
}

function setCaptureButtonsDisabled(disabled) {
  const buttonIds = ["btnCaptureNote", "btnCaptureBlogger", "btnCaptureSearch"];

  buttonIds.forEach((id) => {
    const button = document.getElementById(id);
    setPrimaryCaptureButtonDisabled(button, disabled);
  });

  const checkboxCaptureComments = document.getElementById(
    "checkboxCaptureComments",
  );
  if (checkboxCaptureComments) {
    checkboxCaptureComments.disabled = disabled;
  }
  syncCommentsCaptureControls({forceDisabled: disabled});

  const inputBloggerMinLikes = document.getElementById("inputBloggerMinLikes");
  if (inputBloggerMinLikes) {
    inputBloggerMinLikes.disabled = disabled;
  }

  const inputBloggerMaxDetectedItems = document.getElementById(
    "inputBloggerMaxDetectedItems",
  );
  if (inputBloggerMaxDetectedItems) {
    inputBloggerMaxDetectedItems.disabled = disabled;
  }

  const inputKeywordMinLikes = document.getElementById("inputKeywordMinLikes");
  if (inputKeywordMinLikes) {
    inputKeywordMinLikes.disabled = disabled;
  }

  const inputKeywordMaxDetectedItems = document.getElementById(
    "inputKeywordMaxDetectedItems",
  );
  if (inputKeywordMaxDetectedItems) {
    inputKeywordMaxDetectedItems.disabled = disabled;
  }
}

// ==================== 导出 ====================

// 自动初始化
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSidebar);
} else {
  initSidebar();
}

window.addEventListener("beforeunload", () => {
  stopKeywordSortSyncTimer();
});

/* ==================== 批量采集操作执行 ==================== */

async function handleRunBatchLinks() {
  const textarea = document.getElementById("textareaBatchLinks");
  if (!textarea) return;

  const btn = document.getElementById("btnRunBatchLinks");
  if (!btn) return;
  if (batchUrlCaptureInFlight) {
    if (batchUrlCaptureMode !== "links") {
      showMessage("已有批量任务执行中，请先停止当前任务", "warning");
      return;
    }
    if (batchUrlCancelRequested) {
      showMessage("正在取消批量采集...", "warning");
      return;
    }
    batchUrlCancelRequested = true;
    btn.textContent = "停止中...";
    try {
      await requestCaptureCancelSignal(activeBatchRunnerTabId);
    } catch (error) {
      console.warn("[Sidebar] Batch links cancel failed:", error);
    }
    showMessage("正在取消批量采集...", "warning");
    return;
  }

  if (batchKeywordCaptureInFlight) {
    showMessage("已有批量任务执行中，请先停止当前任务", "warning");
    return;
  }

  const urls = textarea.value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    showMessage("请输入至少一个作品链接（每行一个）", "warning");
    return;
  }

  try {
    const noteBatchSettings = await resolveNoteBatchCaptureSettings();
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    activeBatchRunnerTabId = tab?.id ? Number(tab.id) : null;
    batchUrlCaptureInFlight = true;
    batchUrlCancelRequested = false;
    batchUrlCaptureMode = "links";
    btn.textContent = "停止批量采集";
    btn.classList.remove("btn-primary");
    btn.classList.add("btn-danger");
    setBatchProgressVisible("modal", true);

    const res = await batchCaptureByUrls({
      urls,
      mode: "single",
      captureParams: {
        includeComments: noteBatchSettings.includeComments,
        includeBloggerMetrics: noteBatchSettings.includeBloggerMetrics,
        enableCommentLeadsFilter: noteBatchSettings.enableCommentLeadsFilter,
        commentsMaxDetectedItems: noteBatchSettings.commentsMaxDetectedItems,
        detailNavTimeoutMs: noteBatchSettings.settings.detailNavTimeoutMs,
        profileAfterNavWaitMs: noteBatchSettings.settings.profileAfterNavWaitMs,
      },
      onProgress: (p) => updateBatchProgress(p, "modal"),
      shouldStop: () => batchUrlCancelRequested,
    });

    await refreshDataPool();
    if (res.canceled) {
      showMessage(
        `批量采集已停止：已处理 ${res.stats.processed}/${res.stats.total} 条，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
        "warning",
      );
    } else {
      showMessage(
        `批量采集完成：共 ${res.stats.total} 条，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
        res.stats.failed > 0 ? "warning" : "success",
      );
    }
  } catch (error) {
    console.error("[Batch] Links failed:", error);
    showMessage("批量采集失败: " + error.message, "error");
  } finally {
    batchUrlCaptureInFlight = false;
    batchUrlCancelRequested = false;
    batchUrlCaptureMode = "";
    activeBatchRunnerTabId = null;
    btn.textContent = "启动批量采集";
    btn.classList.add("btn-primary");
    btn.classList.remove("btn-danger");
  }
}

async function handleRunBatchBloggers() {
  const textarea = document.getElementById("textareaBatchBloggers");
  if (!textarea) return;

  const btn = document.getElementById("btnRunBatchBloggers");
  if (!btn) return;
  if (batchUrlCaptureInFlight) {
    if (batchUrlCaptureMode !== "bloggers") {
      showMessage("已有批量任务执行中，请先停止当前任务", "warning");
      return;
    }
    if (batchUrlCancelRequested) {
      showMessage("正在取消批量采集...", "warning");
      return;
    }
    batchUrlCancelRequested = true;
    btn.textContent = "停止中...";
    try {
      await requestCaptureCancelSignal(activeBatchRunnerTabId);
    } catch (error) {
      console.warn("[Sidebar] Batch bloggers cancel failed:", error);
    }
    showMessage("正在取消批量采集...", "warning");
    return;
  }

  if (batchKeywordCaptureInFlight) {
    showMessage("已有批量任务执行中，请先停止当前任务", "warning");
    return;
  }

  const urls = textarea.value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    showMessage("请输入至少一个博主 ID 或主页链接（每行一个）", "warning");
    return;
  }

  try {
    const settings = resolveCurrentDetailCaptureSettings(
      await getCaptureSettings(),
    );
    if (
      settings.autoDetailCaptureAfterListCapture &&
      !ensureAuthVerifiedOrWarn({
        message: PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
      })
    ) {
      return;
    }
    const bloggerMinLikes = readBloggerMinLikesFromInput(
      settings.bloggerMinLikes,
    );
    const bloggerMaxDetectedItems = readBloggerMaxDetectedItemsFromInput(
      settings.bloggerMaxDetectedItems,
    );
    const bloggerKeywordFilter = readBloggerKeywordFilterFromInput();
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    activeBatchRunnerTabId = tab?.id ? Number(tab.id) : null;
    batchUrlCaptureInFlight = true;
    batchUrlCancelRequested = false;
    batchUrlCaptureMode = "bloggers";
    btn.textContent = "停止批量采集";
    btn.classList.remove("btn-primary");
    btn.classList.add("btn-danger");
    setBatchProgressVisible("modal", true);

    const res = await batchCaptureByUrls({
      urls,
      mode: "blogger_notes",
      captureParams: {
        includeBloggerProfileRecord: true,
        minLikes: bloggerMinLikes,
        maxDetectedItems: bloggerMaxDetectedItems,
        keywordFilter: bloggerKeywordFilter,
        waitMinMs: settings.sharedWaitMinMs,
        waitMaxMs: settings.sharedWaitMaxMs,
        stallTimeoutMs: settings.sharedStallTimeoutMs,
        maxDurationMs: settings.sharedMaxDurationMs,
      },
      onProgress: (p) => updateBatchProgress(p, "modal"),
      shouldStop: () => batchUrlCancelRequested,
    });

    await refreshDataPool();
    if (res.canceled) {
      showMessage(
        `批量采集已停止：已处理 ${res.stats.processed}/${res.stats.total} 个博主，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
        "warning",
      );
    } else {
      showMessage(
        `批量采集完成：共 ${res.stats.total} 个博主，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
        res.stats.failed > 0 ? "warning" : "success",
      );
      await maybeRunAutoDetailCaptureAfterListCapture(settings, {
        sourceLabel: "批量博主笔记",
        recordIds: collectBatchRecordIds(res),
      });
    }
  } catch (error) {
    console.error("[Batch] Bloggers failed:", error);
    showMessage("批量采集失败: " + error.message, "error");
  } finally {
    batchUrlCaptureInFlight = false;
    batchUrlCancelRequested = false;
    batchUrlCaptureMode = "";
    activeBatchRunnerTabId = null;
    btn.textContent = "启动批量采集";
    btn.classList.add("btn-primary");
    btn.classList.remove("btn-danger");
  }
}

function getBatchProgressElements(scope = "modal") {
  return {
    container: document.getElementById("batchProgressContainer"),
    fillEl: document.getElementById("batchProgressFill"),
    textEl: document.getElementById("batchProgressText"),
  };
}

// 弹窗内细粒度采集明细行:空则隐藏
function setBatchProgressDetail(text) {
  const el = document.getElementById("batchProgressDetail");
  if (!el) {
    return;
  }
  const t = String(text || "").trim();
  el.textContent = t;
  el.hidden = !t;
}

function setBatchProgressVisible(scope = "modal", visible = true) {
  const {container, fillEl, textEl} = getBatchProgressElements(scope);
  if (container) {
    container.hidden = !visible;
  }
  if (visible && fillEl) {
    fillEl.style.width = "0%";
  }
  if (visible && textEl) {
    textEl.textContent = "准备就绪";
  }
}

function updateBatchProgress(progress, scope = "modal") {
  const {container, fillEl, textEl} = getBatchProgressElements(scope);

  if (container) {
    container.hidden = false;
  }

  if (fillEl && progress.total > 0) {
    const pct = Math.round((progress.current / progress.total) * 100);
    fillEl.style.width = `${pct}%`;
  }

  if (textEl) {
    textEl.textContent = progress.message || "执行中...";
  }
}
