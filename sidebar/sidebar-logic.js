import {KEYWORD_SORT_DIMENSION} from './task-controller/keyword-state.js';
import {createLegacyKeywordView} from './legacy-view/coordinator.js';
import {createLegacyCaptureInputsView} from './legacy-view/capture-inputs.js';
import {createLegacyKeywordInputsView} from './legacy-view/keyword-inputs.js';
import {createLegacyCaptureProgressView} from './legacy-view/capture-progress.js';
import {createLegacyProgressVisibilityView} from './legacy-view/progress-visibility.js';
import {createSidebarTaskController} from './task-controller/coordinator.js';

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

import "../utils/cloud-targeted-post.js";

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
  refreshTaskLedger,
} from "./state.js";

import {
  captureAndSync,
  captureNoteWithOptionalComments,
  retryCommentsForRecord,
  batchCaptureDetailsForRecords,
  repairInterruptedDetailCaptureRecords,
  repairInterruptedCommentCaptureRecords,
  resolveSyncInputForRecord,
  syncRecordBatch,
  checkBeforeSync,
  buildCommentLeadsConfigFromSettings,
  buildCommentLeadsPayloadForRecord,
  batchCaptureByKeywords,
  batchCaptureByUrls,
  lightSampleByKeywords,
  captureTabContent,
  beginDouyinSearchResultTransitionInTab,
  readDouyinSearchDocumentGenerationInTab,
  beginCaptureTaskSession,
  updateCaptureTaskSession,
  endCaptureTaskSession,
} from "../utils/capture-sync.js";
import {
  getCaptureSettings,
  saveCaptureSettings,
  DEFAULT_CAPTURE_SETTINGS,
} from "../utils/capture-settings.js";
import {createRecordSyncQueue} from "../utils/record-sync-queue.js";
import {
  isStreamingSyncReconciliationRequired,
  formatStreamingSyncSummary,
  buildStreamingSyncTaskIssue,
  buildStreamingSyncTaskMetadata,
  buildStreamingSyncCompletionNotice,
} from "../utils/capture/streaming-sync-presentation.js";
import {
  hasSyncReconciliationSignal,
  buildSyncReconciliationError,
} from "../utils/capture/sync-reconciliation-state.js";
import {
  discardUnattendedCheckpointReports,
  enqueueUnattendedCheckpointReport,
  flushUnattendedCheckpointReportOutbox,
} from "../utils/unattended-report-outbox.js";
import {runEnhancementWithSingleRetry} from "../utils/capture/enhancement-retry.js";
import {
  addSyncHistoryEntry,
  ensureControlStorageReserve,
  getAuth,
  getRecords,
  isStorageQuotaError,
  releaseControlStorageReserve,
} from "../utils/storage.js";

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
import {repairInterruptedCommentPayload} from "../utils/capture-recovery.js";
import {
  buildDiagnosticsText,
  recordDiagnosticAction,
  recordDiagnosticError,
  recordDiagnosticTask,
} from "../utils/diagnostics.js";
import {
  beginTaskContext,
  completeTaskContext,
  getActiveTaskContext,
} from "../utils/task-context.js";
import {
  advanceUnattendedCheckpointRound,
  findUnattendedResumeKeyword,
  isUnattendedSafetyBlock,
  normalizeUnattendedKeywordCheckpoint,
  resolveCompletedCheckpointKeywords,
  runUnattendedKeywordAttempts,
  settleUnattendedKeywordCheckpoint,
  summarizeUnattendedKeywordCheckpoint,
} from "../utils/unattended-keyword-run.js";
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
  buildCaptureRecoveryAnnouncementKey,
  resolveCaptureRecoveryView,
} from "../utils/capture-recovery-ui.js";
import {
  getPlatformCapabilities,
  getPlatformCopy,
  getRecordTypesForTab,
  resolveRecordPlatform,
} from "./platform-registry.js";

const DEFAULT_BLOGGER_PROFILE_TABLE_NAME = "博主信息表";
const DEFAULT_BLOGGER_NOTES_TABLE_NAME = "博主笔记采集";
const DEFAULT_KEYWORD_NOTES_TABLE_NAME = "关键词笔记采集";
const DEFAULT_COMMENT_LEADS_TABLE_NAME = "评论区客资采集";
const DEFAULT_MONITOR_TABLE_NAME = "监控内容表";
const DEFAULT_SINGLE_NOTE_TABLE_NAME = "单笔记采集";
const NOTE_DETAIL_LOADING_TEXT = "正在等待笔记内容加载完成，请等页面不再显示“加载中”后再采集";
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

// Browser Debug is an optional accelerator for focus emulation and task
// tracing. The page/content-script capture pipeline remains authoritative and
// must continue when Debug is occupied, unavailable, or still cleaning up a
// previous task. The execution lock below still prevents two real capture
// pipelines from running concurrently in the same Extension profile.
const OPTIONAL_CAPTURE_ASSIST_SESSION_CODES = new Set([
  "runtime_unavailable",
  "task_session_unavailable",
  "capture_task_group_create_failed",
  "capture_task_group_busy",
  "capture_task_cleanup_pending",
  "capture_task_not_found",
  "capture_task_owner_disconnected",
  "capture_task_debug_busy",
  "capture_task_debug_preflight_unavailable",
  "capture_task_debug_preflight_failed",
  "capture_task_debug_starvoice_active",
  "capture_task_external_debugger_busy",
  "capture_task_debug_ownership_unknown",
  "debug_session_attach_failed",
  "debug_session_command_failed",
  "debug_session_detached_during_start",
  "debug_session_busy",
  "debug_session_tab_busy",
]);

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
const MONITOR_DETAIL_DATE_DISCOVERY_MIN = 20;
const MONITOR_DETAIL_DATE_DISCOVERY_MAX = 60;
const MONITOR_DETAIL_DATE_DISCOVERY_MULTIPLIER = 3;
const MONITOR_LATEST_POSTS_LIMIT_MAX = 100;
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
const MONITOR_SUBJECT_TYPE = Object.freeze({
  CREATOR: "creator",
  OFFICIAL: "official",
});

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
const TERMINAL_SUMMARY_ACK_STORAGE_KEY =
  "onstarvoice.terminalSummaryAcknowledgements";
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
let authCodePersistPromise = Promise.resolve();
let authCodeRenderToken = 0;
let authCodeRevision = 0;
let authVerifyInFlight = false;
let authVerifyQueue = Promise.resolve();
let authVerifyPromise = null;
let authRefreshPromise = null;
let contactModalListenersBound = false;
let memberGroupModalListenersBound = false;
let riskModalListenersBound = false;
let debugSessionPanelMinimized = false;
let debugSessionPanelListenersBound = false;
let debugSessionDismissedUnattendedTerminalRunAt = "";
let debugSessionDismissedTargetedTerminalRunAt = "";

let debugSessionClockTimer = null;
let debugSessionClockSnapshot = null;
let debugSessionActivityTaskId = "";
let debugSessionActivityEvents = [];
let debugSessionLastActivitySignature = "";
let debugSessionTerminalizedActivityId = "";
let updateModalListenersBound = false;
let updateGuideModalListenersBound = false;

const CAPTURE_TASK_OWNER_PORT_NAME = "osv.capture.sidebar-owner.v1";

let manualSelectedPlatform = "";
let lastKnownPagePlatform = "unknown";
let currentUpdateNoticeState = null;

const CAPTURE_EXECUTION_LOCK_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const TARGETED_POST_RUN_HEARTBEAT_INTERVAL_MS = 20 * 1000;
const CAPTURE_EXECUTION_LOCK_HOLDER_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `sidebar-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
const UNATTENDED_RUN_QUERY_KEY = "unattendedRun";
const UNATTENDED_RUN_ATTEMPT_QUERY_KEY = "unattendedAttempt";
const TARGETED_POST_RUN_QUERY_KEY = "targetedPostRun";
const TARGETED_POST_RUN_ATTEMPT_QUERY_KEY = "targetedPostAttempt";
const TARGETED_POST_RUN_REQUEST_STORAGE_KEY =
  "onstarvoice.targetedPostRunRequest";
const cloudTargetedPostApi = globalThis.OnStarvoiceCloudTargetedPost;
const KEYWORD_PLAN_STORAGE_KEY = "onstarvoice.unattendedKeywordPlan";
const KEYWORD_RUN_REQUEST_STORAGE_KEY = "onstarvoice.unattendedKeywordRunRequest";
const KEYWORD_PLAN_RECONCILE_INTERVAL_MS = 5 * 1000;
const UNATTENDED_RUN_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const UNATTENDED_PROTECTED_WAIT_TICK_MS = 30 * 1000;
const UNATTENDED_CONTENT_PROGRESS_MIN_INTERVAL_MS = 1500;
const UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS = [0, 500, 1500];
const UNATTENDED_INITIAL_REPORT_RETRY_DELAYS_MS = [0, 500, 1500];
const UNATTENDED_FINAL_FLUSH_RETRY_DELAYS_MS = Object.freeze([
  0,
  250,
  1000,
  5000,
  15000,
]);
const UNATTENDED_LOCAL_CLOSURE_READY_STORAGE_PREFIX =
  "onstarvoice.unattendedLocalClosureReady.v1.";
const UNATTENDED_FINAL_FLUSH_INTENT_STORAGE_PREFIX =
  "onstarvoice.unattendedFinalFlushIntent.v1.";
const UNATTENDED_LOCAL_CLOSURE_READY_VERSION = 1;
const UNATTENDED_FINAL_FLUSH_INTENT_VERSION = 1;
const UNATTENDED_FINAL_FLUSH_RETRY_DELAY_MS = 30 * 1000;
const UNATTENDED_TERMINAL_CONFIRM_RETRY_MAX_MS = 30 * 1000;
const UNATTENDED_RUNTIME_MESSAGE_TIMEOUT_MS = 10 * 1000;
const UNATTENDED_KEYWORD_MAX_ATTEMPTS = 4;
const UNATTENDED_KEYWORD_RETRY_DELAYS_MS = Object.freeze([
  30 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
]);
const UNATTENDED_ELASTIC_RELEASE_MIN_DELAY_MS = 2 * 60 * 1000;
const UNATTENDED_KEYWORD_RETRY_MIN_MS = 8 * 1000;
const UNATTENDED_KEYWORD_RETRY_MAX_MS = 18 * 1000;
// 首次把平台页切到关键词时，弱网、平台改写页面或标签替换都可能让短时
// 就绪检查错过目标页。优先给当前 Agent 足够时间等待同一页面完成加载；
// 只有绑定页始终无法就绪才交给其它 Agent，避免多台设备反复搜索同一词。
const UNATTENDED_SEARCH_BOOTSTRAP_MAX_ATTEMPTS = 4;
const UNATTENDED_SEARCH_BOOTSTRAP_RETRY_DELAYS_MS = Object.freeze([
  20 * 1000,
  60 * 1000,
  3 * 60 * 1000,
]);
const UNATTENDED_BOOTSTRAP_GATE_MAX_WAIT_MS = 60 * 1000;
const UNATTENDED_CAPTURE_SESSION_MAX_ATTEMPTS = 4;
const UNATTENDED_CAPTURE_SESSION_RETRY_DELAYS_MS = Object.freeze([
  15 * 1000,
  45 * 1000,
  2 * 60 * 1000,
]);
const UNATTENDED_CAPTURE_SESSION_RETRYABLE_CODES = new Set([
  "capture_task_group_busy",
  "capture_task_cleanup_pending",
]);

const KEYWORD_PLAN_MODES = new Set([
  "daily",
  "custom_dates",
]);
const KEYWORD_PLAN_MODE_LABELS = {
  daily: "每天",
  custom_dates: "指定日期清单",
};
const KEYWORD_PLAN_STATUS_LABELS = {
  started: "已启动",
  running: "运行中",
  recovering: "自动恢复中",
  completed: "已完成",
  completed_with_failures: "部分完成",
  needs_action: "需要处理",
  failed: "失败",
  canceled: "已取消",
  skipped: "已跳过",
  deferred: "等待重试",
};
const KEYWORD_PLAN_TERMINAL_STATUSES = new Set([
  "completed",
  "completed_with_warnings",
  "completed_with_failures",
  "needs_action",
  "failed",
  "canceled",
  "skipped",
]);
const KEYWORD_PLAN_CONTROL_IDS = {
  modal: {
    enabled: "chkKeywordPlanEnabled",
    mode: "selectKeywordPlanMode",
    startTime: "inputKeywordPlanStartTime",
    jitter: "inputKeywordPlanJitterMin",
    customDates: "textareaKeywordPlanCustomDates",
    customGroup: "keywordPlanCustomDatesGroup",
    status: "keywordPlanStatus",
    sort: "selectBatchSort",
    publishTime: "selectBatchPublishTime",
    contentType: "selectBatchContentType",
    searchScope: "selectBatchScope",
    distance: "selectBatchDistance",
    videoDuration: "selectBatchVideoDuration",
    autoLoop: "chkAutoLoop",
    roundGap: "inputLoopGapMin",
    maxRounds: "inputLoopRounds",
    keywords: "textareaBatchKeywords",
  },
  search: {
    enabled: "chkSearchKeywordPlanEnabled",
    mode: "selectSearchKeywordPlanMode",
    startTime: "inputSearchKeywordPlanStartTime",
    jitter: "inputSearchKeywordPlanJitterMin",
    customDates: "textareaSearchKeywordPlanCustomDates",
    customGroup: "searchKeywordPlanCustomDatesGroup",
    status: "searchKeywordPlanStatus",
    sort: "selectSearchSort",
    publishTime: "selectSearchPublishTime",
    contentType: "selectSearchContentType",
    searchScope: "selectSearchScope",
    distance: "selectSearchDistance",
    videoDuration: "selectSearchVideoDuration",
    autoLoop: "chkSearchAutoLoop",
    roundGap: "inputSearchLoopGapMin",
    maxRounds: "inputSearchLoopRounds",
    keywords: "textareaSearchBatchKeywords",
  },
};
const SEARCH_FILTER_FIELD_META = {
  sort: {
    defaultValue: "comprehensive",
    storageDefault: "",
  },
  publishTime: {
    defaultValue: "all",
    storageDefault: "",
  },
  contentType: {
    defaultValue: "all",
    storageDefault: "",
  },
  searchScope: {
    defaultValue: "all",
    storageDefault: "",
  },
  distance: {
    defaultValue: "all",
    storageDefault: "",
  },
  videoDuration: {
    defaultValue: "all",
    storageDefault: "",
  },
};
const SEARCH_FILTER_SCOPE_META = {
  search: {
    hint: "searchFilterPlatformHint",
    contentTypeField: "searchContentTypeField",
    contentTypeLabel: "searchContentTypeLabel",
    searchScopeField: "searchScopeField",
    distanceField: "searchDistanceField",
    videoDurationField: "searchVideoDurationField",
  },
  modal: {
    hint: "batchFilterPlatformHint",
    contentTypeField: "batchContentTypeField",
    contentTypeLabel: "batchContentTypeLabel",
    searchScopeField: "batchScopeField",
    distanceField: "batchDistanceField",
    videoDurationField: "batchVideoDurationField",
  },
};
const PLATFORM_SEARCH_FILTER_OPTIONS = {
  xiaohongshu: {
    platformLabel: "小红书",
    contentTypeLabel: "笔记类型",
    sort: [
      {value: "comprehensive", label: "综合(默认)"},
      {value: "latest", label: "最新"},
      {value: "likes", label: "最多点赞"},
      {value: "comments", label: "最多评论"},
      {value: "collects", label: "最多收藏"},
    ],
    publishTime: [
      {value: "all", label: "不限(默认)"},
      {value: "day", label: "一天内"},
      {value: "week", label: "一周内"},
      {value: "halfyear", label: "半年内"},
    ],
    contentType: [
      {value: "all", label: "不限(默认)"},
      {value: "video", label: "视频"},
      {value: "image", label: "图文"},
    ],
    searchScope: [
      {value: "all", label: "不限(默认)"},
      {value: "viewed", label: "已看过"},
      {value: "unviewed", label: "未看过"},
      {value: "followed", label: "已关注"},
    ],
    distance: [
      {value: "all", label: "不限(默认)"},
      {value: "city", label: "同城"},
      {value: "nearby", label: "附近"},
    ],
    videoDuration: [],
  },
  douyin: {
    platformLabel: "抖音",
    contentTypeLabel: "内容形式",
    sort: [
      {value: "comprehensive", label: "综合排序(默认)"},
      {value: "latest", label: "最新发布"},
      {value: "likes", label: "最多点赞"},
    ],
    publishTime: [
      {value: "all", label: "不限(默认)"},
      {value: "day", label: "一天内"},
      {value: "week", label: "一周内"},
      {value: "halfyear", label: "半年内"},
    ],
    contentType: [
      {value: "all", label: "不限(默认)"},
      {value: "video", label: "视频"},
      {value: "image", label: "图文"},
    ],
    searchScope: [
      {value: "all", label: "不限(默认)"},
      {value: "followed", label: "关注的人"},
      {value: "viewed", label: "最近看过"},
      {value: "unviewed", label: "还未看过"},
    ],
    distance: [],
    videoDuration: [
      {value: "all", label: "不限(默认)"},
      {value: "under_1m", label: "1分钟以下"},
      {value: "1_5m", label: "1-5分钟"},
      {value: "over_5m", label: "5分钟以上"},
    ],
  },
};

function updateBatchKeywordInputState() {
  const hintEl = document.getElementById("batchKeywordLimitHint");
  const btn = document.getElementById("btnRunBatchKeywords");
  const keywords = getBatchKeywordsFromTextarea();
  const overLimit = keywords.length > MAX_BATCH_KEYWORDS;

  if (hintEl) {
    hintEl.textContent = `${keywords.length} / ${MAX_BATCH_KEYWORDS}`;
    hintEl.classList.toggle("is-over", overLimit);
  }

  if (btn && !sidebarTaskController.readBatchKeywordCaptureInFlight()) {
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

  // 先恢复用户已经确认关闭的终态摘要，避免 initAllStates 首屏短暂复活旧任务。
  await loadTerminalCaptureSummaryAcknowledgements();
  // 在任务状态开始写入前建立控制面保留区；建立失败不会阻断启动，但后续
  // quota 路径仍会明确失败而不是把控制写入误报为成功。
  await ensureControlStorageReserve();
  // 初始化所有状态
  await initAllStates();
  void flushPendingUnattendedCheckpointReports({quiet: true});
  void reconcilePendingUnattendedFinalFlushIntents().catch((error) => {
    console.warn(
      "[Sidebar] Restore unattended final checkpoint flush failed:",
      error,
    );
  });
  connectCaptureTaskOwnerPort();
  syncCaptureTaskOwnerFromRuntime(getCurrentRuntime() || {});

  let repairedDetailCapture = {count: 0, recordIds: []};
  let repairedCommentCapture = {count: 0, recordIds: []};
  let canRepairInterruptedCapture = false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:get-capture-lock",
    });
    // 另一个仍存活的侧栏/标签页持有任务锁时，不能把它正在跑的记录误判中断。
    canRepairInterruptedCapture = Boolean(response?.ok && !response?.data);
  } catch (error) {
    console.warn("[Sidebar] inspect capture lock before repair failed:", error);
  }
  if (canRepairInterruptedCapture) {
    try {
      repairedDetailCapture = await repairInterruptedDetailCaptureRecords();
    } catch (error) {
      console.warn(
        "[Sidebar] repair interrupted detail capture records failed:",
        error,
      );
    }
    try {
      repairedCommentCapture = await repairInterruptedCommentCaptureRecords();
    } catch (error) {
      console.warn(
        "[Sidebar] repair interrupted comment capture records failed:",
        error,
      );
    }
    if (
      repairedDetailCapture.count > 0 ||
      repairedCommentCapture.count > 0
    ) {
      await refreshDataPool();
    }
  }

  // 订阅状态变化
  setupStateSubscriptions();

  // 绑定 UI 事件
  setupUIEventListeners();
  setupDebugSessionPanelControls();
  setupKeywordPlanStorageListener();

  await showRiskNoticeIfNeeded();

  // 初始化采集偏好设置 UI
  await initCaptureSettingsUI();

  try {
    await loadBatchDraftStore();
  } catch (error) {
    console.warn("[Sidebar] Load batch drafts failed:", error);
    sidebarTaskController.replaceBatchDraftByPlatform({});
  }

  // 更新 UI
  updateUI();
  syncRuntimeCaptureProgress(getCurrentRuntime());
  await syncRuntimeCommentProgress(getCurrentRuntime());
  syncSearchFilterControlsForPlatform(getViewPlatform(getCurrentRuntime()));
  await Promise.all([
    loadKeywordPlanUI(),
    loadActiveKeywordRunState(),
    loadTargetedPostRunStateForDisplay(),
  ]);
  startKeywordPlanReconcileTimer();
  if (repairedDetailCapture.count > 0) {
    showMessage(
      `${repairedDetailCapture.count} 条采集增强任务因页面或插件中断已标记为失败，可点击 ↻ 重试`,
      "warning",
    );
  }
  if (repairedCommentCapture.count > 0) {
    showMessage(
      `${repairedCommentCapture.count} 条评论采集因断网、休眠或页面中断已停止等待；可在提示或记录卡片中继续，已落盘数据不会丢失`,
      "warning",
    );
    renderCaptureRecoveryUI({
      phase: "interrupted_repaired",
      recordId: String(repairedCommentCapture.recordIds?.[0] || ""),
      interruptedCount: repairedCommentCapture.count,
      captureAction: "captureComments",
      updatedAt: Date.now(),
    });
  }
  checkExtensionUpdate({trigger: "auto"}).catch((error) => {
    console.warn("[Sidebar] Initial update check failed:", error);
  });

  updateExpandKeywordsButtonState();

  const runtime = getCurrentRuntime();
  sidebarTaskController.replaceLastRuntimePageTypeForKeywordSort(runtime?.pageType || PAGE_TYPE.UNKNOWN);
  sidebarTaskController.replaceLastRuntimePageUrlForKeywordSort(String(runtime?.lastPageUrl || ""));
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

  void maybeClaimAndRunUnattendedKeywordPlan({allowPending: true}).catch((error) => {
    console.error("[Sidebar] Initial unattended keyword plan failed:", error);
  });
  void maybeClaimAndRunTargetedPostWorkflow().catch((error) => {
    console.error("[Sidebar] Initial targeted post workflow failed:", error);
  });

  console.log("[Sidebar] Initialized");
}

// ==================== 状态订阅 ====================

function buildPublicSidebarAuthState(auth) {
  const source = auth && typeof auth === "object" ? auth : {};
  const credential =
    source.credential && typeof source.credential === "object"
      ? source.credential
      : null;
  return {
    verified: source.verified === true,
    status: String(source.status || ""),
    reason: String(source.reason || ""),
    message: String(source.message || ""),
    user: source.user
      ? {name: String(source.user.name || ""), email: String(source.user.email || "")}
      : null,
    tenant: source.tenant
      ? {id: String(source.tenant.id || ""), name: String(source.tenant.name || "")}
      : null,
    credential: credential
      ? {
          type: String(credential.type || ""),
          status: String(credential.status || ""),
          expiresAt: credential.expiresAt || null,
          daysRemaining: credential.daysRemaining ?? null,
          maxBindings: credential.maxBindings ?? null,
          currentBindings: credential.currentBindings ?? null,
        }
      : null,
  };
}

/**
 * 设置状态订阅
 */
function setupStateSubscriptions() {
  // 订阅运行时状态变化
  subscribe("runtime", (runtime) => {
    console.log("[Sidebar] Runtime updated:", runtime);
    window.getSidebarRuntimeState = () => runtime;
    updatePlatformUI(runtime);
    syncSearchFilterControlsForPlatform(getViewPlatform(runtime));
    updatePageTypeUI(runtime?.pageType || PAGE_TYPE.UNKNOWN);
    const currentPageType = runtime?.pageType || PAGE_TYPE.UNKNOWN;
    const currentPageUrl = String(runtime?.lastPageUrl || "");
    const shouldSyncKeywordSort =
      currentPageType !== sidebarTaskController.readLastRuntimePageTypeForKeywordSort() ||
      currentPageUrl !== sidebarTaskController.readLastRuntimePageUrlForKeywordSort();
    sidebarTaskController.replaceLastRuntimePageTypeForKeywordSort(currentPageType);
    sidebarTaskController.replaceLastRuntimePageUrlForKeywordSort(currentPageUrl);
    if (shouldSyncKeywordSort) {
      syncKeywordSortDimensionByRuntime(runtime).catch((error) => {
        console.warn("[Sidebar] Failed to sync keyword sort dimension:", error);
      });
    }
    syncRuntimeCaptureProgress(runtime);
    renderCaptureDebugSession(runtime);
    syncCaptureTaskOwnerFromRuntime(runtime);
    syncRuntimeCommentProgress(runtime).catch((error) => {
      console.warn("[Sidebar] Failed to sync runtime comment progress:", error);
    });
  });

  // 订阅鉴权状态变化
  subscribe("auth", (auth) => {
    console.log("[Sidebar] Auth updated:", {
      status: auth?.status,
      verified: auth?.verified === true,
      tenantId: auth?.tenant?.id || "",
      cloudAgentReady: Boolean(auth?.captureAgent?.id && auth?.captureAgent?.token),
    });
    const publicAuth = buildPublicSidebarAuthState(auth);
    window.getSidebarAuthState = () => publicAuth;
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

function resolveCaptureTaskStep(progress = {}) {
  const phase = String(progress?.phase || "debug_session_attached").toLowerCase();
  if (
    /^(?:unattended|targeted)_/.test(phase) &&
    /completed|failed|canceled|skipped|needs_action/.test(phase)
  ) {
    return 5;
  }
  if (progress?.targetedPost === true) {
    return phase.includes("settled") || phase.includes("unavailable") ? 2 : 1;
  }
  if (isCaptureTaskWaitPhase(phase)) {
    return 1;
  }
  if (
    phase.includes("sync") ||
    phase.includes("upload") ||
    phase.includes("check_before")
  ) {
    return 4;
  }
  if (phase.startsWith("detail_") || phase.includes("enhanc")) {
    return 3;
  }
  if (
    phase.includes("saving") ||
    phase === "saved" ||
    phase.includes("marked") ||
    phase.includes("binding") ||
    phase === "completed"
  ) {
    return 2;
  }
  if (
    phase === "debug_session_attached" ||
    phase.includes("initial") ||
    phase.includes("analy")
  ) {
    return 0;
  }
  return 1;
}

function resolveCaptureTaskPercent(progress = {}) {
  const explicit = Number(progress?.progressPercent);
  if (!Number.isFinite(explicit)) return null;
  return Math.max(0, Math.min(100, Math.round(explicit)));
}

function isTerminalCaptureTaskView(progress = {}, session = {}) {
  if (session?.terminal === true) return true;
  const phase = String(progress?.phase || "").trim().toLowerCase();
  return Boolean(
    /^(?:unattended|targeted)_/.test(phase) &&
      /(?:completed(?:_with_(?:failures|warnings))?|failed|canceled|cancelled|needs_action)$/.test(
        phase,
      ),
  );
}

function buildCaptureTaskStats(progress = {}) {
  const parts = [];
  if (progress?.targetedPost === true) {
    const completed = Math.max(
      0,
      Number(progress?.completedTargetCount) || 0,
    );
    const unavailable = Math.max(
      0,
      Number(progress?.unavailableTargetCount) || 0,
    );
    const deleted = Math.max(
      0,
      Number(progress?.deletedTargetCount) || 0,
    );
    const pageUnavailable = Math.max(
      0,
      Number(progress?.pageUnavailableTargetCount) || 0,
    );
    const failed = Math.max(0, Number(progress?.failedTargetCount) || 0);
    const current = Math.max(
      0,
      Number(progress?.itemCurrent ?? progress?.current) || 0,
    );
    const total = Math.max(
      0,
      Number(progress?.itemTotal ?? progress?.total) || 0,
    );
    if (completed > 0) parts.push(`已采集 ${completed} 条`);
    if (deleted > 0) parts.push(`已删除 ${deleted} 条`);
    if (pageUnavailable > 0) {
      parts.push(`暂不可用 ${pageUnavailable} 条`);
    }
    if (
      unavailable > 0 &&
      deleted === 0 &&
      pageUnavailable === 0
    ) {
      parts.push(`已删除或不可用 ${unavailable} 条`);
    }
    if (failed > 0) parts.push(`失败 ${failed} 条`);
    if (parts.length === 0 && total > 0) {
      parts.push(`巡查进度 ${Math.min(current, total)}/${total}`);
    }
    return parts.join(" · ");
  }
  const keyword = String(progress?.keyword || "").trim();
  const detectedCount = Number(progress?.detectedCount);
  const markedCount = Number(progress?.markedCount ?? progress?.filteredCount);
  const itemCurrent = Number(progress?.itemCurrent);
  const itemTotal = Number(progress?.itemTotal);
  const keywordCurrent = Number(progress?.keywordCurrent);
  const keywordTotal = Number(progress?.keywordTotal);
  const roundCurrent = Number(progress?.roundCurrent ?? progress?.round);
  const roundTotal = Number(progress?.roundTotal);
  if (isTerminalCaptureTaskView(progress)) {
    const completed = Math.max(
      0,
      Number(progress?.keywordCompletedCount) || 0,
    );
    const partial = Math.max(
      0,
      Number(progress?.keywordPartialCount) || 0,
    );
    const failed = Math.max(
      0,
      Number(progress?.keywordFailedCount) || 0,
    );
    const skipped = Math.max(
      0,
      Number(progress?.keywordSkippedCount) || 0,
    );
    const detailFailed = Math.max(
      0,
      Number(progress?.detailFailedCount) || 0,
    );
    const aiFiltered = Math.max(
      0,
      Number(progress?.aiFilteredCount) || 0,
    );
    const noEnhancement = Math.max(
      0,
      Number(progress?.noEnhancementCount) || 0,
    );
    const syncSuccess = Math.max(
      0,
      Number(progress?.syncSuccessCount) || 0,
    );
    const syncFailed = Math.max(
      0,
      Number(progress?.syncFailedCount) || 0,
    );
    const syncSkipped = Math.max(
      0,
      Number(progress?.syncSkippedCount) || 0,
    );
    const syncRemaining = Math.max(
      0,
      Number(progress?.syncRemainingCount) || 0,
    );
    if (completed > 0) parts.push(`完整完成 ${completed} 个词`);
    if (partial > 0) parts.push(`部分完成 ${partial} 个词`);
    if (failed > 0) parts.push(`失败 ${failed} 个词`);
    if (skipped > 0) parts.push(`跳过 ${skipped} 个词`);
    if (
      completed + partial + failed + skipped === 0 &&
      Number.isFinite(keywordCurrent) &&
      Number.isFinite(keywordTotal) &&
      keywordTotal > 0
    ) {
      parts.push(
        `关键词 ${Math.min(Math.floor(keywordCurrent), Math.floor(keywordTotal))}/${Math.floor(keywordTotal)}`,
      );
    }
    if (detailFailed > 0) parts.push(`作品失败 ${detailFailed} 条`);
    if (aiFiltered > 0) parts.push(`AI 跳过 ${aiFiltered} 条`);
    if (noEnhancement > 0) parts.push(`无需增强 ${noEnhancement} 条`);
    const syncTotal =
      syncSuccess + syncFailed + syncSkipped + syncRemaining;
    if (syncTotal > 0) {
      parts.push(`最终同步 ${syncSuccess}/${syncTotal} 条`);
      if (syncFailed > 0) parts.push(`同步失败 ${syncFailed} 条`);
      if (syncRemaining > 0) parts.push(`待上传 ${syncRemaining} 条`);
    }
    return parts.join(" · ");
  }
  if (
    Number.isFinite(roundCurrent) &&
    Number.isFinite(roundTotal) &&
    roundCurrent > 0 &&
    roundTotal > 1
  ) {
    parts.push(
      `第 ${Math.min(Math.floor(roundCurrent), Math.floor(roundTotal))}/${Math.floor(roundTotal)} 轮`,
    );
  }
  if (Number.isFinite(detectedCount) && detectedCount > 0) {
    parts.push(`已读取 ${Math.floor(detectedCount)} 条`);
  }
  if (Number.isFinite(markedCount) && markedCount > 0) {
    parts.push(`已标记 ${Math.floor(markedCount)} 条`);
  }
  if (
    Number.isFinite(keywordCurrent) &&
    Number.isFinite(keywordTotal) &&
    keywordTotal > 0 &&
    keywordCurrent >= 0
  ) {
    parts.push(
      `关键词 ${Math.min(Math.floor(keywordCurrent), Math.floor(keywordTotal))}/${Math.floor(keywordTotal)}${keyword ? `：${keyword}` : ""}`,
    );
  }
  if (
    Number.isFinite(itemCurrent) &&
    Number.isFinite(itemTotal) &&
    itemTotal > 0 &&
    itemCurrent >= 0
  ) {
    parts.push(
      `当前词内作品 ${Math.min(Math.floor(itemCurrent), Math.floor(itemTotal))}/${Math.floor(itemTotal)}`,
    );
  }
  return parts.join(" · ");
}

function parseCaptureTaskTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed =
    typeof value === "number" ? Number(value) : Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatCaptureTaskDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(durationMs) / 1000) || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function formatCaptureTaskRelativeTime(timestamp, now = Date.now()) {
  const parsed = parseCaptureTaskTime(timestamp);
  if (!parsed) return "刚刚";
  const elapsedSeconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (elapsedSeconds < 5) return "刚刚";
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒前`;
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

function resolveCaptureTaskWaitDeadline(progress = {}) {
  const explicit = parseCaptureTaskTime(progress?.waitUntil);
  if (explicit) return explicit;
  const remainingMs = Number(progress?.remainingMs);
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return null;
  const reportedAt =
    parseCaptureTaskTime(progress?.updatedAt) || Date.now();
  return reportedAt + remainingMs;
}

function resolveCaptureTaskHealth(progress = {}, session = {}, now = Date.now()) {
  const phase = String(progress?.phase || "").trim().toLowerCase();
  if (isTerminalCaptureTaskView(progress, session)) {
    const terminalState = String(
      session?.state || phase.replace(/^(?:unattended|targeted)_/, ""),
    )
      .trim()
      .toLowerCase();
    if (/cancel|stop/.test(terminalState)) {
      return {key: "stopped", label: "已停止"};
    }
    if (/completed/.test(terminalState)) {
      return {key: "completed", label: "已完成"};
    }
    return {key: "ended", label: "已结束"};
  }
  const waitDeadline = resolveCaptureTaskWaitDeadline(progress);
  if (
    isCaptureTaskWaitPhase(phase) &&
    (!waitDeadline || waitDeadline > now)
  ) {
    return {key: "waiting", label: "安全等待"};
  }
  const lastProgressAt =
    parseCaptureTaskTime(progress?.updatedAt) ||
    parseCaptureTaskTime(session?.startedAt) ||
    now;
  const idleMs = Math.max(0, now - lastProgressAt);
  const slowAfterMs = phase.startsWith("comments_")
    ? 90_000
    : isCaptureTaskDetailPhase(phase)
      ? 60_000
      : 35_000;
  if (idleMs >= slowAfterMs) {
    return {key: "slow", label: "页面响应较慢"};
  }
  return {key: "active", label: "运行正常"};
}

function resolveCaptureTaskActionCopy(progress = {}) {
  const phase = String(progress?.phase || "").trim().toLowerCase();
  const profileDiscovery =
    progress?.targetedPost === true &&
    isTargetedProfileDiscoveryWorkflow(
      progress?.workflow,
      progress?.targetMode || progress?.taskMeta?.targetMode,
    );
  const itemCurrent = Math.max(
    0,
    Number(progress?.itemCurrent ?? progress?.current) || 0,
  );
  const itemTotal = Math.max(
    0,
    Number(progress?.itemTotal ?? progress?.total) || 0,
  );
  const itemLabel =
    itemCurrent > 0
      ? `第 ${itemCurrent}${itemTotal > 0 ? `/${itemTotal}` : ""} ${profileDiscovery ? "个账号" : "条作品"}`
      : profileDiscovery
        ? "当前账号"
        : "当前作品";
  const taskMeta =
    progress?.taskMeta && typeof progress.taskMeta === "object"
      ? progress.taskMeta
      : {};
  const executionCopy = getKeywordExecutionCopy({
    executionMode:
      progress?.executionMode || taskMeta.executionMode || "unattended_plan",
  });
  const detailFields = ["正文、作者、发布时间和互动数据"];
  if (taskMeta.commentsEnabled) detailFields.push("评论");
  if (taskMeta.bloggerMetricsEnabled) detailFields.push("作者粉丝等账号信息");

  if (progress?.targetedPost === true) {
    const workflowLabel = getTargetedWorkflowLabel(progress?.workflow);
    const currentTitle = readProgressText(
      progress?.currentTargetTitle,
      progress?.title,
    );
    if (phase === "target_unavailable") {
      return {
        title: "帖子已删除或当前不可用",
        explanation:
          readProgressText(progress?.message) ||
          "平台已明确返回帖子不可访问，系统已记录状态",
        nextAction: "该结果不会重试，将自动继续下一条帖子",
      };
    }
    if (phase.startsWith("targeted_completed")) {
      return {
        title: `${workflowLabel}已完成`,
        explanation:
          readProgressText(progress?.message) ||
          (profileDiscovery
            ? "全部账号已完成扫描并记录结果"
            : "全部目标帖子已完成巡查并记录结果"),
        nextAction: profileDiscovery
          ? "可在关注账号页面和调度中心查看结果"
          : "可在负面帖子列表和调度中心查看结果",
      };
    }
    if (phase.startsWith("targeted_canceled")) {
      return {
        title: `${workflowLabel}已停止`,
        explanation:
          readProgressText(progress?.message) || "已停止并保留现有巡查结果",
        nextAction: `可在调度中心继续处理剩余${profileDiscovery ? "账号" : "帖子"}`,
      };
    }
    if (phase.startsWith("targeted_")) {
      return {
        title: `${workflowLabel}已结束`,
        explanation:
          readProgressText(progress?.message) || "本次巡查已经结束",
        nextAction: "可在调度中心查看结果和需要处理的原因",
      };
    }
    if (phase.includes("opening") || phase.includes("navigating")) {
      return {
        title: `正在打开${itemLabel}`,
        explanation: currentTitle
          ? `正在检查「${currentTitle}」${profileDiscovery ? "主页" : ""}是否仍可访问`
          : profileDiscovery
            ? "正在检查目标账号主页是否仍可访问"
            : "正在检查目标帖子是否仍可访问",
        nextAction: profileDiscovery
          ? "主页就绪后会扫描发布时间范围内的作品"
          : "页面就绪后会采集内容，已删除帖子将直接标记",
      };
    }
    if (phase.includes("settled")) {
      return {
        title: `${itemLabel}巡查完成`,
        explanation:
          readProgressText(progress?.message) ||
          `当前${profileDiscovery ? "账号扫描" : "帖子"}结果已保存`,
        nextAction:
          itemTotal > itemCurrent
            ? `继续${profileDiscovery ? "扫描" : "巡查"}第 ${itemCurrent + 1}/${itemTotal} ${profileDiscovery ? "个账号" : "条帖子"}`
            : "正在汇总本次巡查结果",
      };
    }
    return {
      title: `正在巡查${itemLabel}`,
      explanation: currentTitle
        ? `正在采集「${currentTitle}」`
        : `正在执行${workflowLabel}`,
      nextAction: `当前${profileDiscovery ? "账号" : "帖子"}完成后会自动继续下一个`,
    };
  }

  if (phase.startsWith("unattended_completed")) {
    return {
      title: phase.includes("with_failures") ? "任务已完成，部分作品需处理" : "任务已完成",
      explanation:
        readProgressText(progress?.message) ||
        `本次${executionCopy.captureLabel}已经收口`,
      nextAction: "结果已保留，可在列表和任务中心查看",
    };
  }
  if (phase.startsWith("unattended_canceled")) {
    return {
      title: "任务已停止",
      explanation: readProgressText(progress?.message) || "本次采集已停止并保留现有结果",
      nextAction: "可在任务中心查看停止原因和已保存数据",
    };
  }
  if (phase.startsWith("unattended_")) {
    return {
      title: "任务已结束",
      explanation:
        readProgressText(progress?.message) ||
        `本次${executionCopy.captureLabel}已经结束`,
      nextAction: "可在任务中心查看结果与需要处理的原因",
    };
  }

  if (phase.includes("initial")) {
    return {
      title: "正在准备采集页面",
      explanation: "确认平台页面、登录状态和搜索环境",
      nextAction: "页面准备完成后会自动开始当前关键词",
    };
  }
  if (
    phase === "navigating" ||
    phase === "submitting_search" ||
    phase === "waiting_results"
  ) {
    return {
      title: "正在打开当前关键词的搜索结果",
      explanation: "等待页面内容和筛选条件稳定",
      nextAction: "页面就绪后会自动读取搜索结果",
    };
  }
  if (phase === "filtering" || phase === "capturing") {
    return {
      title: "正在读取并筛选搜索结果",
      explanation: "识别符合关键词、发布时间和内容条件的作品",
      nextAction: taskMeta.enhancementEnabled
        ? "列表完成后会逐条完善作品详情"
        : "列表完成后会安全保存采集结果",
    };
  }
  if (phase === "detail_ai_prefilter_start") {
    const candidateCount = Math.max(
      0,
      Number(progress?.candidateCount ?? progress?.total) || 0,
    );
    return {
      title: "AI 正在判断搜索结果相关性",
      explanation:
        candidateCount > 0
          ? `正在根据当前关键词预判 ${candidateCount} 条列表结果`
          : "正在根据当前关键词预判列表结果",
      nextAction: "证据不足时先读最小详情二判，再决定是否抓评论和博主数据",
    };
  }
  if (phase === "detail_ai_prefilter_done") {
    const filteredCount = Math.max(
      0,
      Number(progress?.aiFilteredCount ?? progress?.filteredCount) || 0,
    );
    const failedOpenCount = Math.max(
      0,
      Number(progress?.failedOpenCount) || 0,
    );
    const retryCount = Math.max(0, Number(progress?.retryCount) || 0);
    return {
      title:
        failedOpenCount > 0
          ? `AI 筛选完成 · ${failedOpenCount} 条超时或异常已抽样或延迟增强`
          : filteredCount > 0
          ? `AI 筛选完成 · 已跳过 ${filteredCount} 条无关结果`
          : retryCount > 0
            ? `AI 筛选完成 · 拆批重试 ${retryCount} 次`
          : "AI 筛选完成 · 本批全部继续采集",
      explanation:
        readProgressText(progress?.message) || "相关性判断已经完成",
      nextAction:
        failedOpenCount > 0
          ? "少量抽样项继续完整采集，其余条目延迟增强并保留审计"
          : "接下来只为需要保留的结果采集详情、评论和博主信息",
    };
  }
  if (
    phase === "detail_ai_second_stage_start" ||
    phase === "detail_ai_second_stage_done"
  ) {
    return {
      title:
        phase === "detail_ai_second_stage_start"
          ? "AI 正在用最小详情二判"
          : "AI 二判完成 · 继续完整增强",
      explanation:
        readProgressText(progress?.message) ||
        "仅使用正文、标签和已有画面或口播文字判断相关性",
      nextAction:
        phase === "detail_ai_second_stage_start"
          ? "确认相关后才会读取评论和博主数据"
          : "开始读取评论和博主数据",
    };
  }
  if (phase === "detail_item_deferred") {
    return {
      title: `AI 已延迟${itemLabel}增强`,
      explanation:
        readProgressText(progress?.message) ||
        "最小数据已保留，本轮不继续抓取评论和博主信息",
      nextAction: "下一轮或手动重试可继续增强",
    };
  }
  if (phase === "detail_item_filtered") {
    const confidenceValue = Number(progress?.aiRelevanceConfidence);
    const confidence = Number.isFinite(confidenceValue)
      ? `${Math.round(Math.min(1, Math.max(0, confidenceValue)) * 100)}%`
      : "";
    const reason = readProgressText(progress?.aiRelevanceReason);
    const isAiFiltered = Boolean(
      reason || confidence || /AI/.test(progress?.message || ""),
    );
    return {
      title: isAiFiltered
        ? `AI 已跳过${itemLabel}无关结果`
        : `${itemLabel}不符合条件，已跳过增强`,
      explanation:
        [confidence ? `置信度 ${confidence}` : "", reason]
          .filter(Boolean)
          .join(" · ") ||
        readProgressText(progress?.message) ||
        "该条已保留列表信息，不再进入详情增强",
      nextAction:
        itemCurrent > 0 && itemTotal > itemCurrent
          ? `继续处理第 ${itemCurrent + 1}/${itemTotal} 条作品`
          : "本词处理完成后会进入同步或下一个关键词",
    };
  }
  if (
    phase.includes("item_open") ||
    phase.includes("opening") ||
    phase.includes("navigation")
  ) {
    return {
      title: `正在打开${itemLabel}`,
      explanation: "确认作品可访问并等待详情内容加载",
      nextAction: `页面就绪后读取${detailFields.join("、")}`,
    };
  }
  if (phase.includes("blogger") || phase.includes("profile")) {
    return {
      title: "正在补充作者信息",
      explanation: "读取作者名称、粉丝数和账号指标",
      nextAction: "完成后继续处理当前作品的其余数据",
    };
  }
  if (phase.startsWith("comments_") || phase.includes("comments")) {
    const commentsCount = Math.max(
      0,
      Number(progress?.commentsCount ?? progress?.collectedCount) || 0,
    );
    return {
      title:
        commentsCount > 0
          ? `正在采集评论 · 已读取 ${commentsCount} 条`
          : "正在采集评论",
      explanation: "滚动读取评论，并按设置识别可用客资信息",
      nextAction: "评论完成后会合并保存到当前作品",
    };
  }
  if (isCaptureTaskDetailPhase(phase)) {
    return {
      title: `正在完善${itemLabel}详情`,
      explanation: `读取${detailFields.join("、")}`,
      nextAction:
        itemCurrent > 0 && itemTotal > itemCurrent
          ? `完成后继续第 ${itemCurrent + 1}/${itemTotal} 条作品`
          : "本词详情完成后会进入同步或下一个关键词",
    };
  }
  if (isCaptureTaskSyncPhase(phase)) {
    return {
      title: "正在同步已完成的数据",
      explanation: "采集结果正在分批安全保存",
      nextAction: "同步完成后会继续剩余任务",
    };
  }
  if (isCaptureTaskWaitPhase(phase)) {
    return {
      title:
        phase === "waiting_next_round"
          ? "本轮已完成，正在等待下一轮"
          : phase === "keyword_retry_wait"
            ? "失败关键词即将自动重试"
            : "正在进行防风控安全等待",
      explanation: "这是计划内等待，不是卡住",
      nextAction: progress?.nextKeyword
        ? `接下来处理「${progress.nextKeyword}」`
        : "倒计时结束后系统会自动继续",
    };
  }
  return {
    title:
      readProgressText(progress?.message) || "采集任务持续运行中",
    explanation: "系统正在处理当前页面返回的数据",
    nextAction: "完成当前步骤后会自动继续",
  };
}

function resolveSearchFilterDisplayLabel(platform, field, value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return "";
  const options =
    PLATFORM_SEARCH_FILTER_OPTIONS[
      String(platform || "").trim().toLowerCase()
    ]?.[field];
  if (!Array.isArray(options)) return normalizedValue;
  return (
    options.find((option) => option.value === normalizedValue)?.label ||
    normalizedValue
  );
}

function buildCaptureTaskMetaChips(progress = {}, platform = "") {
  const taskMeta =
    progress?.taskMeta && typeof progress.taskMeta === "object"
      ? progress.taskMeta
      : {};
  const chips = [];
  if (progress?.targetedPost === true) {
    const total = Math.max(
      0,
      Number(progress?.itemTotal ?? progress?.total) || 0,
    );
    const profileDiscovery =
      isTargetedProfileDiscoveryWorkflow(
        progress?.workflow,
        progress?.targetMode || progress?.taskMeta?.targetMode,
      );
    if (total > 0) {
      chips.push(`${total} ${profileDiscovery ? "个账号" : "条帖子"}`);
    }
    chips.push(getTargetedWorkflowLabel(progress?.workflow));
    if (taskMeta.commentsEnabled) chips.push("附加评论");
    if (taskMeta.bloggerMetricsEnabled) chips.push("作者指标");
    return chips;
  }
  const keywordList = Array.isArray(taskMeta.keywordList)
    ? taskMeta.keywordList.filter(Boolean)
    : [];
  if (keywordList.length > 0) chips.push(`${keywordList.length} 个关键词`);
  const roundTotal = Math.max(0, Number(progress?.roundTotal) || 0);
  if (roundTotal > 1) chips.push(`${roundTotal} 轮`);
  const searchFilters =
    taskMeta.searchFilters && typeof taskMeta.searchFilters === "object"
      ? taskMeta.searchFilters
      : {};
  [
    ["sort", "排序"],
    ["publishTime", "发布"],
    ["contentType", "内容"],
    ["searchScope", "范围"],
    ["distance", "距离"],
    ["videoDuration", "时长"],
  ].forEach(([field, prefix]) => {
    const label = resolveSearchFilterDisplayLabel(
      platform,
      field,
      searchFilters[field],
    );
    if (label && !/默认|不限/.test(label)) {
      chips.push(`${prefix}：${label}`);
    }
  });
  if (taskMeta.enhancementEnabled) chips.push("增强采集");
  if (taskMeta.aiRelevancePrefilterEnabled) chips.push("AI 精准筛选");
  if (taskMeta.commentsEnabled) chips.push("附加评论");
  if (taskMeta.bloggerMetricsEnabled) chips.push("作者指标");
  return chips.slice(0, 8);
}

function buildCaptureTaskScopeMeta(progress = {}) {
  const parts = [];
  const keyword = String(progress?.keyword || "").trim();
  const roundCurrent = Math.max(
    0,
    Number(progress?.roundCurrent ?? progress?.round) || 0,
  );
  const roundTotal = Math.max(0, Number(progress?.roundTotal) || 0);
  const keywordCurrent = Math.max(0, Number(progress?.keywordCurrent) || 0);
  const keywordTotal = Math.max(0, Number(progress?.keywordTotal) || 0);
  const itemCurrent = Math.max(0, Number(progress?.itemCurrent) || 0);
  const itemTotal = Math.max(0, Number(progress?.itemTotal) || 0);
  if (progress?.targetedPost === true) {
    const current = Math.max(
      0,
      Number(progress?.itemCurrent ?? progress?.current) || 0,
    );
    const total = Math.max(
      0,
      Number(progress?.itemTotal ?? progress?.total) || 0,
    );
    if (current > 0 && total > 0) {
      parts.push(
        `${isTargetedProfileDiscoveryWorkflow(
          progress?.workflow,
          progress?.targetMode || progress?.taskMeta?.targetMode,
        ) ? "账号" : "帖子"} ${Math.min(current, total)}/${total}`,
      );
    }
    return parts;
  }
  if (roundCurrent > 0 && roundTotal > 1) {
    parts.push(`第 ${Math.min(roundCurrent, roundTotal)}/${roundTotal} 轮`);
  }
  if (keywordCurrent > 0 && keywordTotal > 0) {
    parts.push(
      `关键词 ${Math.min(keywordCurrent, keywordTotal)}/${keywordTotal}${keyword ? `：${keyword}` : ""}`,
    );
  }
  if (itemCurrent > 0 && itemTotal > 0) {
    parts.push(
      `当前词内作品 ${Math.min(itemCurrent, itemTotal)}/${itemTotal}`,
    );
  }
  const attemptCurrent = Math.max(
    0,
    Number(progress?.attemptCurrent ?? progress?.attempt) || 0,
  );
  const attemptTotal = Math.max(
    0,
    Number(progress?.attemptTotal ?? progress?.maxAttempts) || 0,
  );
  if (attemptCurrent > 1 && attemptTotal > 1) {
    parts.push(`重试 ${Math.min(attemptCurrent, attemptTotal)}/${attemptTotal}`);
  }
  return parts;
}

function buildCaptureTaskActivityMessage(progress = {}, actionCopy = {}) {
  const phase = String(progress?.phase || "").trim().toLowerCase();
  const itemCurrent = Math.max(0, Number(progress?.itemCurrent) || 0);
  const commentsCount = Math.max(
    0,
    Number(progress?.commentsCount ?? progress?.collectedCount) || 0,
  );
  const followersCount = Math.max(
    0,
    Number(
      progress?.bloggerFollowersCount ?? progress?.followersCount,
    ) || 0,
  );
  const savedCount = Math.max(0, Number(progress?.savedCount) || 0);
  if (progress?.targetedPost === true && phase === "target_unavailable") {
    return "当前帖子已标记为删除或不可用";
  }
  if (phase.includes("item_done") || phase.includes("item_complete")) {
    return itemCurrent > 0
      ? `第 ${itemCurrent} 条作品详情已完成`
      : "一条作品详情已完成";
  }
  if (phase.startsWith("comments_") && commentsCount > 0) {
    return `已读取评论 ${commentsCount} 条`;
  }
  if (
    (phase.includes("blogger") || phase.includes("profile")) &&
    followersCount > 0
  ) {
    return `作者粉丝数 ${followersCount.toLocaleString("zh-CN")} 已回填`;
  }
  if (savedCount > 0) return `已安全保存 ${savedCount} 条数据`;
  return readProgressText(actionCopy.title, progress?.message);
}

function recordCaptureTaskActivity(taskId, progress = {}, actionCopy = {}) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return;
  if (debugSessionActivityTaskId !== normalizedTaskId) {
    debugSessionActivityTaskId = normalizedTaskId;
    debugSessionActivityEvents = [];
    debugSessionLastActivitySignature = "";
    debugSessionTerminalizedActivityId = "";
  }
  const message = buildCaptureTaskActivityMessage(progress, actionCopy);
  if (!message) return;
  const signature = JSON.stringify({
    phase: progress?.phase,
    keyword: progress?.keyword,
    itemCurrent: progress?.itemCurrent,
    commentsCount:
      progress?.commentsCount ?? progress?.collectedCount ?? null,
    followersCount:
      progress?.bloggerFollowersCount ?? progress?.followersCount ?? null,
    savedCount: progress?.savedCount ?? null,
    message,
  });
  if (signature === debugSessionLastActivitySignature) return;
  debugSessionLastActivitySignature = signature;
  debugSessionActivityEvents.unshift({
    message,
    at: parseCaptureTaskTime(progress?.updatedAt) || Date.now(),
  });
  debugSessionActivityEvents = debugSessionActivityEvents.slice(0, 4);
}

function terminalizeCaptureTaskActivityMessage(message = "") {
  const text = String(message || "").trim();
  if (!text) return "";
  if (/正在同步/.test(text)) return text.replace(/正在同步[^：·]*/u, "数据同步已完成");
  if (/正在(?:完善|补采).*(?:详情|作品)/.test(text)) {
    return text.replace(/^正在/u, "已结束").replace(/采集$/u, "采集步骤");
  }
  if (/正在采集评论/.test(text)) return text.replace("正在采集评论", "评论采集步骤已结束");
  if (/正在补充作者信息/.test(text)) return "作者信息采集步骤已结束";
  if (/正在|等待/.test(text)) {
    return `${text.replace(/^正在/u, "").replace(/^等待/u, "")} · 步骤已结束`;
  }
  return text;
}

function finalizeCaptureTaskActivityEvents(taskId, progress = {}, session = {}) {
  if (!isTerminalCaptureTaskView(progress, session)) return;
  const finishedAt =
    parseCaptureTaskTime(progress?.finishedAt) ||
    parseCaptureTaskTime(session?.finishedAt) ||
    parseCaptureTaskTime(session?.terminalRunAt) ||
    Date.now();
  const terminalId = `${String(taskId || "")}:${finishedAt}:${String(progress?.phase || "")}`;
  if (debugSessionTerminalizedActivityId === terminalId) return;
  debugSessionTerminalizedActivityId = terminalId;
  const terminalMessages = [];
  const syncSuccess = Math.max(0, Number(progress?.syncSuccessCount) || 0);
  const syncFailed = Math.max(0, Number(progress?.syncFailedCount) || 0);
  const syncRemaining = Math.max(0, Number(progress?.syncRemainingCount) || 0);
  if (syncSuccess + syncFailed + syncRemaining > 0) {
    terminalMessages.push(
      `最终同步已结算：成功 ${syncSuccess}，失败 ${syncFailed}，待上传 ${syncRemaining}`,
    );
  }
  const aiFiltered = Math.max(0, Number(progress?.aiFilteredCount) || 0);
  const noEnhancement = Math.max(0, Number(progress?.noEnhancementCount) || 0);
  if (aiFiltered > 0 || noEnhancement > 0) {
    terminalMessages.push(
      `增强筛选已结算：AI 跳过 ${aiFiltered}，无需增强 ${noEnhancement}`,
    );
  }
  const targetedPost = progress?.targetedPost === true;
  terminalMessages.push(
    session?.state === "canceled"
      ? targetedPost
        ? "帖子巡查任务已停止"
        : "无人值守任务已停止"
      : targetedPost
        ? "帖子巡查任务已结算"
        : "无人值守任务已结算",
  );
  const historical = debugSessionActivityEvents.map((event) => ({
    ...event,
    message: terminalizeCaptureTaskActivityMessage(event.message),
  }));
  const merged = [
    ...terminalMessages.map((message) => ({message, at: finishedAt})),
    ...historical,
  ].filter(
    (event, index, events) =>
      event.message &&
      events.findIndex((candidate) => candidate.message === event.message) === index,
  );
  debugSessionActivityEvents = merged.slice(0, 4);
  debugSessionLastActivitySignature = "";
}

function renderCaptureTaskActivityEvents(now = Date.now()) {
  const panel = document.getElementById("debugSessionActivity");
  const list = document.getElementById("debugSessionActivityList");
  if (!panel || !list) return;
  panel.hidden = debugSessionActivityEvents.length === 0;
  list.replaceChildren();
  debugSessionActivityEvents.forEach((event) => {
    const item = document.createElement("li");
    item.className = "debug-session-activity-item";
    const message = document.createElement("span");
    message.textContent = event.message;
    const time = document.createElement("time");
    time.setAttribute("aria-live", "off");
    time.textContent = formatCaptureTaskRelativeTime(event.at, now);
    item.append(message, time);
    list.appendChild(item);
  });
}

function updateDebugSessionClock() {
  const snapshot = debugSessionClockSnapshot;
  if (!snapshot) return;
  const now = Date.now();
  const progress = snapshot.progress || {};
  const session = snapshot.session || {};
  const terminal = isTerminalCaptureTaskView(progress, session);
  const finishedAt =
    parseCaptureTaskTime(progress.finishedAt) ||
    parseCaptureTaskTime(session.finishedAt) ||
    parseCaptureTaskTime(session.terminalRunAt);
  const clockNow = terminal
    ? finishedAt || parseCaptureTaskTime(progress.updatedAt) || now
    : now;
  const runStartedAt =
    parseCaptureTaskTime(progress.runStartedAt) ||
    parseCaptureTaskTime(session.startedAt) ||
    now;
  const phaseStartedAt =
    parseCaptureTaskTime(progress.phaseStartedAt) ||
    parseCaptureTaskTime(progress.updatedAt) ||
    runStartedAt;
  const lastProgressAt =
    parseCaptureTaskTime(progress.updatedAt) || phaseStartedAt;
  const elapsed = document.getElementById("debugSessionElapsed");
  const stepElapsed = document.getElementById("debugSessionStepElapsed");
  const progressAge = document.getElementById("debugSessionLastProgressAge");
  if (elapsed) {
    elapsed.textContent = `${terminal ? "总耗时" : "已运行"} ${formatCaptureTaskDuration(clockNow - runStartedAt)}`;
  }
  if (stepElapsed) {
    stepElapsed.textContent = `本步骤 ${formatCaptureTaskDuration(clockNow - phaseStartedAt)}`;
  }
  if (progressAge) {
    progressAge.textContent = formatCaptureTaskRelativeTime(lastProgressAt, now);
  }

  const health = resolveCaptureTaskHealth(progress, session, now);
  const healthEl = document.getElementById("debugSessionHealth");
  const healthLabel = document.getElementById("debugSessionStateLabel");
  if (healthEl) healthEl.dataset.health = health.key;
  if (healthLabel) healthLabel.textContent = health.label;

  const waitCard = document.getElementById("debugSessionWaitCard");
  const waitCountdown = document.getElementById("debugSessionWaitCountdown");
  const waitDeadline = resolveCaptureTaskWaitDeadline(progress);
  const waiting =
    !terminal &&
    isCaptureTaskWaitPhase(progress?.phase) &&
    Number.isFinite(waitDeadline) &&
    waitDeadline > now;
  if (waitCard) waitCard.hidden = !waiting;
  if (waitCountdown && waiting) {
    waitCountdown.textContent = formatCaptureTaskDuration(waitDeadline - now);
  }

  const dockStatus = document.getElementById("debugSessionDockStatus");
  if (dockStatus) {
    const keyword = String(progress?.keyword || "").trim();
    const itemCurrent = Math.max(0, Number(progress?.itemCurrent) || 0);
    const itemTotal = Math.max(0, Number(progress?.itemTotal) || 0);
    dockStatus.textContent = [
      health.label,
      keyword ? `「${keyword}」` : "",
      itemCurrent > 0 && itemTotal > 0
        ? `${itemCurrent}/${itemTotal}`
        : "",
      formatCaptureTaskDuration(clockNow - runStartedAt),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  renderCaptureTaskActivityEvents(now);
}

function startDebugSessionClock(session, progress) {
  debugSessionClockSnapshot = {session, progress};
  updateDebugSessionClock();
  if (isTerminalCaptureTaskView(progress, session)) {
    if (debugSessionClockTimer) {
      clearInterval(debugSessionClockTimer);
      debugSessionClockTimer = null;
    }
    return;
  }
  if (debugSessionClockTimer) return;
  debugSessionClockTimer = setInterval(updateDebugSessionClock, 1000);
}

function stopDebugSessionClock() {
  if (debugSessionClockTimer) {
    clearInterval(debugSessionClockTimer);
    debugSessionClockTimer = null;
  }
  debugSessionClockSnapshot = null;
}

async function setCaptureTaskPanelMinimized(minimized) {
  debugSessionPanelMinimized = Boolean(minimized);
  renderCaptureDebugSession(getCurrentRuntime() || {});
  const session = getCurrentRuntime()?.captureDebugSession;
  const taskId = String(session?.taskId || session?.runId || "").trim();
  if (!taskId) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:set-capture-task-minimized",
      taskId,
      minimized: Boolean(minimized),
    });
    if (response?.ok === false) {
      throw new Error(response?.error?.message || "更新任务状态页失败");
    }
  } catch (error) {
    console.warn("[Sidebar] Persist task surface visibility failed:", error);
  }
}

function renderCaptureTaskWorkers(progress = {}) {
  const panel = document.getElementById("debugSessionWorkers");
  const modeLabel = document.getElementById("debugSessionWorkerMode");
  if (!panel) return;
  const workerStates = Array.isArray(progress?.workerStates)
    ? progress.workerStates.slice(0, 2)
    : [];
  panel.hidden = workerStates.length === 0;
  if (workerStates.length === 0) return;

  if (modeLabel) {
    modeLabel.textContent =
      progress?.workerMode === "double_buffer" && workerStates.length > 1
        ? "双页面加速"
        : "单页面采集";
  }

  const current = Math.max(0, Number(progress?.itemCurrent) || 0);
  const total = Math.max(0, Number(progress?.itemTotal) || 0);
  panel.querySelectorAll("[data-worker-index]").forEach((row) => {
    const index = Number(row.getAttribute("data-worker-index"));
    const worker = workerStates[index];
    row.hidden = !worker;
    if (!worker) return;
    const state = String(worker.state || "idle").trim().toLowerCase();
    const safeState = [
      "idle",
      "queued",
      "loading",
      "ready",
      "collecting",
      "failed",
    ].includes(state)
      ? state
      : "idle";
    row.setAttribute("data-state", safeState);
    const title = row.querySelector(".debug-session-worker-copy strong");
    const detail = row.querySelector(".debug-session-worker-copy small");
    const hasCollectingPeer = workerStates.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index &&
        String(candidate?.state || "").trim().toLowerCase() === "collecting",
    );
    if (title) title.textContent = worker.label || `工作页 ${index + 1}`;
    if (detail) {
      const statusText = {
        idle: "等待下一条",
        queued:
          worker.mode === "prefetch" ? "已排队，等待安全导航间隔" : "准备打开当前详情",
        loading:
          worker.mode === "prefetch" ? "正在预加载下一条" : "正在打开当前详情",
        ready: hasCollectingPeer
          ? "下一条已加载，等待当前条完成"
          : "下一条已加载，等待安全切换",
        collecting:
          total > 0
            ? `正在读取第 ${Math.min(current, total)}/${total} 条`
            : "正在读取作品详情",
        failed: "页面加载失败，任务正在停止",
      }[safeState];
      detail.textContent = statusText;
    }
    row.setAttribute(
      "aria-label",
      `${worker.label || `工作页 ${index + 1}`}：${detail?.textContent || "等待任务"}`,
    );
  });
}

function buildUnattendedSyntheticDebugSession(
  runtime = {},
  plan = buildKeywordRunDisplayPlan(sidebarTaskController.readKeywordPlanState()),
) {
  const status = String(plan?.lastRunStatus || "").trim().toLowerCase();
  const running = isKeywordPlanRunning(plan);
  const terminal = KEYWORD_PLAN_TERMINAL_STATUSES.has(status);
  const terminalRunAt = String(plan?.lastRunAt || "").trim();
  const terminalSummaryId =
    terminalRunAt ||
    String(plan?.lastRunProgress?.updatedAt || "").trim() ||
    `${status}:${String(plan?.lastRunMessage || "").trim()}`;
  // 终态摘要不能依赖一个很短的时间窗。原生 Debug 的释放本身可能超过
  // 20 秒，旧逻辑会让用户在摘要第一次可见前就失去整个状态页。
  // 现在由用户显式点击“关闭”后，才按本次终态标识隐藏。
  const visibleTerminal = Boolean(
    terminal &&
      terminalSummaryId &&
      terminalSummaryId !==
        debugSessionDismissedUnattendedTerminalRunAt,
  );
  if (!plan?.enabled || (!running && !visibleTerminal)) {
    return null;
  }
  const platform = String(plan?.platform || getPagePlatform(runtime) || "")
    .trim()
    .toLowerCase();
  if (!supportsPersistentCaptureTaskPlatform(platform)) {
    return null;
  }
  const keywords = Array.isArray(plan?.keywords)
    ? plan.keywords.map((keyword) => String(keyword || "").trim()).filter(Boolean)
    : [];
  const storedProgress =
    plan?.lastRunProgress && typeof plan.lastRunProgress === "object"
      ? plan.lastRunProgress
      : {};
  const storedRequestId = String(
    storedProgress.unattendedRequestId || plan?.lastRunRequestId || "",
  ).trim();
  const captureTaskId =
    String(storedProgress.captureTaskId || "").trim() ||
    (storedRequestId ? `unattended-capture:${storedRequestId}` : "");
  const startedAt = String(storedProgress.runStartedAt || "").trim();
  const finishedAt = visibleTerminal
    ? String(storedProgress.finishedAt || terminalRunAt || "").trim()
    : "";
  const keywordTotal = Math.max(
    0,
    Number(storedProgress.keywordTotal) || keywords.length,
  );
  const sourceTabId = Number(
    storedProgress.runnerTabId ?? runtime?.lastActiveTabId,
  );
  const executionMode =
    String(plan?.executionMode || "").trim() === "one_time"
      ? "one_time"
      : "unattended_plan";
  const taskLabel =
    executionMode === "one_time" ? "一次性采集" : "无人值守采集";
  const message =
    String(
      visibleTerminal
        ? plan?.lastRunMessage || storedProgress.message || ""
        : storedProgress.message || plan?.lastRunMessage || "",
    ).trim() ||
    (visibleTerminal ? `${taskLabel}已结束` : `正在启动${taskLabel}…`);
  const terminalLabel =
    status === "completed"
      ? `${taskLabel}已完成`
      : status === "completed_with_failures"
        ? `${taskLabel}部分完成`
        : status === "canceled"
          ? `${taskLabel}已停止`
          : `${taskLabel}已结束`;
  return {
    synthetic: true,
    unattended: true,
    terminal: visibleTerminal,
    taskId: captureTaskId,
    runId: captureTaskId,
    startedAt,
    finishedAt,
    terminalRunAt: visibleTerminal ? terminalSummaryId : "",
    state: visibleTerminal ? status : "starting",
    platform,
    label: visibleTerminal
      ? terminalLabel
      : `${taskLabel} · ${keywords.length} 个关键词`,
    pageTitle: visibleTerminal
      ? terminalLabel
      : `${taskLabel} · ${keywords.length} 个关键词`,
    pageUrl: String(runtime?.lastPageUrl || ""),
    sourceTabId:
      Number.isSafeInteger(sourceTabId) && sourceTabId > 0
        ? sourceTabId
        : null,
    progress: {
      ...storedProgress,
      current: visibleTerminal
        ? Math.max(
            0,
            Number(storedProgress.keywordCurrent) || keywordTotal,
          )
        : Math.max(0, Number(storedProgress.current) || 0),
      total: visibleTerminal
        ? keywordTotal
        : Math.max(0, Number(storedProgress.total) || keywordTotal),
      phase: visibleTerminal
        ? `unattended_${status}`
        : String(storedProgress.phase || "initializing_unattended"),
      finishedAt,
      itemCurrent: visibleTerminal ? null : storedProgress.itemCurrent,
      itemTotal: visibleTerminal ? null : storedProgress.itemTotal,
      nextKeyword: visibleTerminal ? "" : storedProgress.nextKeyword,
      progressPercent: visibleTerminal ? 100 : storedProgress.progressPercent,
      message,
      executionMode,
    },
  };
}

function buildTargetedPostSyntheticDebugSession(
  runtime = {},
  request = sidebarTaskController.readTargetedPostRunState(),
) {
  const queryRequestId = getTargetedPostRunRequestIdFromUrl();
  const sharedRequestId = String(request?.id || "").trim();
  const requestId = queryRequestId || sharedRequestId;
  if (
    !requestId ||
    !request ||
    typeof request !== "object" ||
    !sharedRequestId ||
    (queryRequestId && sharedRequestId !== queryRequestId)
  ) {
    return null;
  }
  const status = String(request.status || "pending").trim().toLowerCase();
  const terminal = Boolean(
    cloudTargetedPostApi?.isTerminalRunStatus?.(status),
  );
  const terminalSummaryId =
    String(request.finishedAt || request.updatedAt || "").trim() ||
    `${requestId}:${status}:${String(request.message || "").trim()}`;
  if (
    terminal &&
    terminalSummaryId === debugSessionDismissedTargetedTerminalRunAt
  ) {
    return null;
  }

  const targets = Array.isArray(request.targets) ? request.targets : [];
  const targetResults = Array.isArray(request.targetResults)
    ? request.targetResults
    : [];
  const storedProgress =
    request.progress && typeof request.progress === "object"
      ? request.progress
      : {};
  const checkpoint =
    request.checkpoint && typeof request.checkpoint === "object"
      ? request.checkpoint
      : {};
  const workflow = String(
    request.workflow || "negative_post_patrol",
  ).trim();
  const targetMode = String(request.targetMode || "").trim().toLowerCase();
  const workflowLabel = getTargetedWorkflowLabel(workflow);
  const unavailableResults = targetResults.filter(
    (result) =>
      result?.businessOutcome === "post_unavailable" ||
      result?.availability?.status === "unavailable",
  );
  const completedTargetCount = targetResults.filter((result) =>
    ["completed", "completed_with_warnings"].includes(
      String(result?.status || ""),
    ),
  ).length;
  const failedTargetCount = targetResults.filter(
    (result) => String(result?.status || "") === "failed",
  ).length;
  const deletedTargetCount = unavailableResults.filter(
    (result) =>
      String(
        result?.availabilityStatus ||
          result?.availability?.availabilityStatus ||
          "",
      ) === "deleted",
  ).length;
  const pageUnavailableTargetCount =
    unavailableResults.length - deletedTargetCount;
  const processedCount = Math.max(
    targetResults.length,
    Number(checkpoint.processedCount) || 0,
  );
  const total = Math.max(targets.length, Number(storedProgress.total) || 0);
  const current = terminal
    ? processedCount
    : Math.max(
        1,
        Number(storedProgress.current) ||
          Math.min(processedCount + 1, Math.max(total, 1)),
      );
  const currentTarget =
    targets.find(
      (target) =>
        String(target?.itemId || "") ===
        String(storedProgress.itemId || ""),
    ) ||
    targets[Math.max(0, Math.min(current - 1, targets.length - 1))] ||
    {};
  const sourceTabId = Number(
    storedProgress.targetTabId ??
      sidebarTaskController.readActiveBatchRunnerTabId() ??
      runtime?.lastActiveTabId,
  );
  const message =
    String(request.message || storedProgress.message || "").trim() ||
    (terminal ? `${workflowLabel}已结束` : `正在启动${workflowLabel}`);
  const captureSettings =
    request.captureSettings && typeof request.captureSettings === "object"
      ? request.captureSettings
      : {};

  return {
    synthetic: true,
    targetedPost: true,
    terminal,
    taskId: `targeted-post:${requestId}`,
    runId: `targeted-post:${requestId}`,
    startedAt: String(request.startedAt || request.createdAt || ""),
    finishedAt: terminal ? String(request.finishedAt || "") : "",
    terminalRunAt: terminal ? terminalSummaryId : "",
    state: status,
    platform: String(request.platform || getPagePlatform(runtime) || ""),
    label: workflowLabel,
    pageTitle: currentTarget.title
      ? `${workflowLabel} · ${currentTarget.title}`
      : workflowLabel,
    pageUrl: String(currentTarget.url || runtime?.lastPageUrl || ""),
    sourceTabId:
      Number.isSafeInteger(sourceTabId) && sourceTabId > 0
        ? sourceTabId
        : null,
    progress: {
      ...storedProgress,
      current,
      total,
      itemCurrent: current,
      itemTotal: total,
      progressPercent: terminal
        ? 100
        : total > 0
          ? Math.round((Math.min(processedCount, total) / total) * 100)
          : null,
      phase: terminal
        ? `targeted_${status}`
        : String(storedProgress.phase || "target_initializing"),
      message,
      targetedPost: true,
      workflow,
      targetMode,
      currentTargetTitle: String(
        storedProgress.title || currentTarget.title || "",
      ),
      completedTargetCount,
      unavailableTargetCount: unavailableResults.length,
      deletedTargetCount,
      pageUnavailableTargetCount,
      failedTargetCount,
      runStartedAt: String(
        storedProgress.runStartedAt ||
          request.startedAt ||
          request.createdAt ||
          "",
      ),
      taskMeta: {
        targetedPost: true,
        workflow,
        targetMode,
        commentsEnabled: captureSettings.includeComments === true,
        bloggerMetricsEnabled:
          captureSettings.includeBloggerMetrics === true,
      },
    },
  };
}

function isTargetedProfileDiscoveryWorkflow(workflow = "", targetMode = "") {
  const normalizedWorkflow = String(workflow || "").trim();
  return (
    [
      "followed_creator_post_patrol",
      "official_account_post_discovery",
    ].includes(normalizedWorkflow) ||
    (normalizedWorkflow === "official_account_comment_patrol" &&
      String(targetMode || "").trim().toLowerCase() === "profile")
  );
}

function getTargetedWorkflowLabel(workflow = "") {
  const normalized = String(workflow || "").trim();
  if (normalized === "watched_content_patrol") {
    return "关注内容巡查";
  }
  if (normalized === "official_account_comment_patrol") {
    return "官方账号评论巡查";
  }
  if (normalized === "followed_creator_post_patrol") {
    return "关注博主作品扫描";
  }
  if (normalized === "official_account_post_discovery") {
    return "官方账号作品发现";
  }
  return "负面帖子巡查";
}

function resolveDisplayedUnattendedSessionBinding({
  usingSyntheticSession = false,
  session = null,
  nativeSession = null,
  displayPlan = null,
} = {}) {
  const selectedSession =
    session && typeof session === "object" ? session : {};
  if (usingSyntheticSession) {
    const syntheticTaskId = String(
      selectedSession.taskId || selectedSession.runId || "",
    ).trim();
    const syntheticTaskRequestId = syntheticTaskId.startsWith(
      "unattended-capture:",
    )
      ? syntheticTaskId.slice("unattended-capture:".length)
      : "";
    return {
      unattended: true,
      requestId: String(
        selectedSession.progress?.unattendedRequestId ||
          syntheticTaskRequestId ||
          displayPlan?.lastRunRequestId ||
          "",
      ).trim(),
    };
  }

  const selectedNative =
    nativeSession && typeof nativeSession === "object"
      ? nativeSession
      : selectedSession;
  const nativeTaskId = String(
    selectedNative.taskId || selectedNative.runId || "",
  ).trim();
  const nativeTaskRequestId = nativeTaskId.startsWith("unattended-capture:")
    ? nativeTaskId.slice("unattended-capture:".length)
    : "";
  const nativeProgressRequestId = String(
    selectedNative.progress?.unattendedRequestId || "",
  ).trim();
  return {
    unattended: Boolean(nativeTaskRequestId || nativeProgressRequestId),
    // The native task identity is authoritative. A newer active cloud request
    // may already be visible in displayPlan while this older Debug session is
    // still detaching, and must never become the target of this panel's Stop.
    requestId: nativeTaskRequestId || nativeProgressRequestId,
  };
}

function renderCaptureDebugSession(runtime = {}) {
  const panel = document.getElementById("debugSessionPanel");
  const dock = document.getElementById("debugSessionDock");
  if (!panel) return;
  const nativeSession = runtime?.captureDebugSession;
  const nativeSessionTabId = Number(
    nativeSession?.sourceTabId ?? nativeSession?.tabId,
  );
  const nativeActive =
    nativeSession?.state === "attached" &&
    Number.isSafeInteger(nativeSessionTabId) &&
    nativeSessionTabId > 0;
  const displayPlan = buildKeywordRunDisplayPlan(sidebarTaskController.readKeywordPlanState());
  const planStatus = String(
    displayPlan?.lastRunStatus || "",
  ).trim().toLowerCase();
  const planTerminalSummaryId =
    String(displayPlan?.lastRunAt || "").trim() ||
    String(displayPlan?.lastRunProgress?.updatedAt || "").trim() ||
    `${planStatus}:${String(displayPlan?.lastRunMessage || "").trim()}`;
  const dismissedUnattendedNative = Boolean(
    nativeActive &&
      KEYWORD_PLAN_TERMINAL_STATUSES.has(planStatus) &&
      planTerminalSummaryId &&
      planTerminalSummaryId ===
        debugSessionDismissedUnattendedTerminalRunAt &&
      String(nativeSession?.taskId || "").startsWith("unattended-capture:"),
  );
  const targetedStatus = String(
    sidebarTaskController.readTargetedPostRunState()?.status || "",
  ).trim().toLowerCase();
  const targetedTerminalSummaryId =
    String(
      sidebarTaskController.readTargetedPostRunState()?.finishedAt ||
        sidebarTaskController.readTargetedPostRunState()?.updatedAt ||
        "",
    ).trim() ||
    `${String(sidebarTaskController.readTargetedPostRunState()?.id || "")}:${targetedStatus}:${String(sidebarTaskController.readTargetedPostRunState()?.message || "").trim()}`;
  const dismissedTargetedNative = Boolean(
    nativeActive &&
      getTargetedPostRunRequestIdFromUrl() &&
      cloudTargetedPostApi?.isTerminalRunStatus?.(targetedStatus) &&
      targetedTerminalSummaryId &&
      targetedTerminalSummaryId ===
        debugSessionDismissedTargetedTerminalRunAt,
  );
  const nativeVisible =
    nativeActive &&
    !dismissedUnattendedNative &&
    !dismissedTargetedNative;
  const targetedSyntheticSession =
    buildTargetedPostSyntheticDebugSession(runtime);
  const unattendedSyntheticSession = buildUnattendedSyntheticDebugSession(
    runtime,
    displayPlan,
  );
  // 计划已经结算时，终态摘要优先于仍处于异步 detach/清理中的 native
  // Debug。运行态仍由 native 数据覆盖合成启动态。
  const usingTargetedSyntheticSession = Boolean(targetedSyntheticSession);
  const usingUnattendedSyntheticSession = Boolean(
    !usingTargetedSyntheticSession &&
      unattendedSyntheticSession &&
      (!nativeVisible || unattendedSyntheticSession.terminal),
  );
  const usingSyntheticSession =
    usingTargetedSyntheticSession || usingUnattendedSyntheticSession;
  const session = usingTargetedSyntheticSession
    ? targetedSyntheticSession
    : usingUnattendedSyntheticSession
      ? unattendedSyntheticSession
      : nativeSession;
  const sessionTabId = Number(session?.sourceTabId ?? session?.tabId);
  const active =
    nativeVisible ||
    Boolean(targetedSyntheticSession) ||
    Boolean(unattendedSyntheticSession);
  if (!active) debugSessionPanelMinimized = false;
  if (usingSyntheticSession && session?.terminal) {
    debugSessionPanelMinimized = false;
  }
  if (!usingSyntheticSession && typeof session?.minimized === "boolean") {
    debugSessionPanelMinimized = session.minimized;
  }
  panel.hidden = !active || debugSessionPanelMinimized;
  panel.setAttribute(
    "data-minimized",
    String(active && debugSessionPanelMinimized),
  );
  if (dock) {
    dock.hidden = !active || !debugSessionPanelMinimized;
    dock.setAttribute(
      "data-tab-id",
      active && Number.isSafeInteger(sessionTabId) && sessionTabId > 0
        ? String(sessionTabId)
        : "",
    );
  }
  if (!active) {
    stopDebugSessionClock();
    debugSessionActivityTaskId = "";
    debugSessionActivityEvents = [];
    debugSessionLastActivitySignature = "";
    debugSessionTerminalizedActivityId = "";
    panel.removeAttribute("data-run-id");
    panel.removeAttribute("data-task-id");
    panel.removeAttribute("data-tab-id");
    panel.removeAttribute("data-active-step");
    panel.removeAttribute("data-session-source");
    panel.removeAttribute("data-targeted-post");
    panel.removeAttribute("data-targeted-post-request-id");
    panel.removeAttribute("data-unattended");
    panel.removeAttribute("data-unattended-request-id");
    panel.removeAttribute("data-terminal");
    panel.removeAttribute("data-terminal-run-at");
    return;
  }
  panel.setAttribute("data-run-id", String(session.runId || ""));
  panel.setAttribute("data-task-id", String(session.taskId || session.runId || ""));
  panel.setAttribute(
    "data-tab-id",
    Number.isSafeInteger(sessionTabId) && sessionTabId > 0
      ? String(sessionTabId)
      : "",
  );
  panel.setAttribute(
    "data-session-source",
    usingTargetedSyntheticSession
      ? "targeted-post-synthetic"
      : usingUnattendedSyntheticSession
        ? "unattended-synthetic"
        : "native-debug",
  );
  const unattendedBinding = resolveDisplayedUnattendedSessionBinding({
    usingSyntheticSession: usingUnattendedSyntheticSession,
    session,
    nativeSession,
    displayPlan,
  });
  panel.setAttribute(
    "data-targeted-post",
    String(usingTargetedSyntheticSession),
  );
  panel.setAttribute(
    "data-targeted-post-request-id",
    usingTargetedSyntheticSession
      ? String(sidebarTaskController.readTargetedPostRunState()?.id || "")
      : "",
  );
  panel.setAttribute(
    "data-unattended",
    String(unattendedBinding.unattended),
  );
  panel.setAttribute(
    "data-unattended-request-id",
    unattendedBinding.requestId,
  );
  panel.setAttribute("data-terminal", String(Boolean(session?.terminal)));
  panel.setAttribute(
    "data-terminal-run-at",
    session?.terminal ? String(session?.terminalRunAt || "") : "",
  );
  const stopButton = document.getElementById("btnDebugSessionStop");
  const minimizeButton = document.getElementById("btnDebugSessionMinimize");
  if (stopButton) {
    stopButton.hidden = Boolean(session?.terminal);
    stopButton.style.display = session?.terminal ? "none" : "";
    stopButton.disabled = Boolean(session?.terminal);
  }
  if (minimizeButton) {
    minimizeButton.textContent = session?.terminal ? "关闭" : "隐藏";
  }

  const platform = String(
    session.platform || detectPlatformFromUrl(session.pageUrl || runtime.lastPageUrl || ""),
  ).trim() || "xiaohongshu";
  const sessionProgress =
    session?.progress && typeof session.progress === "object"
      ? session.progress
      : {};
  const runtimeProgress =
    runtime?.lastCaptureProgress &&
    typeof runtime.lastCaptureProgress === "object"
      ? runtime.lastCaptureProgress
      : {};
  const activeListRunId = String(session?.activeListRunId || "").trim();
  const runtimeListRunId = String(runtimeProgress.listCaptureRunId || "").trim();
  const sessionProgressAt = parseCaptureTaskTime(sessionProgress.updatedAt);
  const runtimeProgressAt = parseCaptureTaskTime(runtimeProgress.updatedAt);
  const canUseLiveListProgress = Boolean(
    activeListRunId &&
      runtimeListRunId === activeListRunId &&
      runtimeProgressAt > sessionProgressAt,
  );
  // Content keeps reporting scrolling/marked counts while the debug session is
  // waiting for the relay response. Merge only the exact active list run and
  // only when it is newer, so stale progress from a previous keyword cannot
  // overwrite the current task.
  const progress = projectCaptureTaskProgress(
    canUseLiveListProgress
      ? {...sessionProgress, ...runtimeProgress}
      : Object.keys(sessionProgress).length > 0
        ? sessionProgress
        : runtimeProgress,
  );
  const logo = document.getElementById("debugSessionLogo");
  if (logo) {
    logo.className = `debug-session-logo platform-logo ${getPlatformLogoClass(platform)}`;
    logo.innerHTML = getPlatformLogoInnerMarkup(platform);
  }
  const title = document.getElementById("debugSessionPageTitle");
  const url = document.getElementById("debugSessionPageUrl");
  const currentKeyword = String(progress?.keyword || "").trim();
  const platformLabel =
    PLATFORM_SEARCH_FILTER_OPTIONS[platform]?.platformLabel ||
    (platform === "douyin" ? "抖音" : "小红书");
  if (title) {
    title.textContent = currentKeyword
      ? `${currentKeyword} · ${platformLabel}采集`
      : String(session.pageTitle || session.label || "当前采集页面");
  }
  if (url) url.textContent = String(session.pageUrl || runtime.lastPageUrl || "");

  const markedCount = Math.max(
    0,
    Number(progress.markedCount ?? progress.filteredCount) || 0,
  );
  const activeStep = resolveCaptureTaskStep(progress);
  const percent = resolveCaptureTaskPercent(progress);
  const actionCopy = resolveCaptureTaskActionCopy(progress);
  const taskId = String(session.taskId || session.runId || "").trim();
  recordCaptureTaskActivity(taskId, progress, actionCopy);
  finalizeCaptureTaskActivityEvents(taskId, progress, session);
  panel.setAttribute("data-active-step", String(activeStep));

  const progressTrack = panel.querySelector(".debug-session-progress-track");
  const progressBar = document.getElementById("debugSessionProgressBar");
  const progressPercent = document.getElementById("debugSessionProgressPercent");
  const currentMessage = document.getElementById("debugSessionCurrentMessage");
  const actionExplanation = document.getElementById(
    "debugSessionActionExplanation",
  );
  const nextAction = document.getElementById("debugSessionNextAction");
  const stats = document.getElementById("debugSessionStats");
  const message = actionCopy.title;
  if (progressTrack) {
    progressTrack.classList.toggle("is-indeterminate", percent === null);
    if (percent === null) {
      progressTrack.removeAttribute("aria-valuenow");
      progressTrack.setAttribute("aria-valuetext", message || "任务进行中");
    } else {
      progressTrack.setAttribute("aria-valuenow", String(percent));
      progressTrack.setAttribute("aria-valuetext", `${percent}%`);
    }
  }
  if (progressBar) {
    progressBar.style.width = percent === null ? "" : `${percent}%`;
  }
  if (progressPercent) {
    progressPercent.hidden = percent === null;
    progressPercent.textContent = percent === null ? "—" : `${percent}%`;
  }
  if (currentMessage) currentMessage.textContent = message;
  if (actionExplanation) {
    actionExplanation.textContent = actionCopy.explanation;
  }
  if (nextAction) nextAction.textContent = actionCopy.nextAction;
  if (stats) {
    const statsText = buildCaptureTaskStats(progress);
    stats.textContent = statsText;
    stats.hidden = !statsText;
  }

  const scopeLabel = document.querySelector(".debug-session-scope-label");
  const keywordEl = document.getElementById("debugSessionKeyword");
  const scopeMeta = document.getElementById("debugSessionScopeMeta");
  if (scopeLabel) {
    const profileDiscovery =
      progress?.targetedPost === true &&
      isTargetedProfileDiscoveryWorkflow(
        progress?.workflow,
        progress?.targetMode || progress?.taskMeta?.targetMode,
      );
    scopeLabel.textContent =
      progress?.targetedPost === true
        ? profileDiscovery
          ? "当前账号"
          : "当前帖子"
        : currentKeyword
          ? "当前关键词"
          : "当前任务";
  }
  if (keywordEl) {
    keywordEl.textContent =
      currentKeyword ||
      String(
        progress?.targetedPost === true
          ? progress?.currentTargetTitle || session.label
          : session.label || "正在准备采集任务",
      );
  }
  if (scopeMeta) {
    scopeMeta.replaceChildren();
    buildCaptureTaskScopeMeta(progress).forEach((part) => {
      const item = document.createElement("span");
      item.textContent = part;
      scopeMeta.appendChild(item);
    });
  }

  const waitReason = document.getElementById("debugSessionWaitReason");
  const waitNext = document.getElementById("debugSessionWaitNext");
  const waitPhase = String(progress?.phase || "").trim().toLowerCase();
  if (waitReason) {
    waitReason.textContent =
      waitPhase === "waiting_next_round"
        ? "轮次间隔"
        : waitPhase === "keyword_retry_wait"
          ? "自动重试等待"
          : waitPhase === "scheduled-waiting"
            ? "等待计划开始"
            : waitPhase === "detail_item_delay"
              ? "下一条安全间隔"
              : "防风控随机间隔";
  }
  if (waitNext) waitNext.textContent = actionCopy.nextAction;

  const meta = document.getElementById("debugSessionMeta");
  const metaChips = document.getElementById("debugSessionMetaChips");
  const chips = buildCaptureTaskMetaChips(progress, platform);
  if (meta) meta.hidden = chips.length === 0;
  if (metaChips) {
    metaChips.replaceChildren();
    chips.forEach((chip) => {
      const item = document.createElement("span");
      item.className = "debug-session-meta-chip";
      item.textContent = chip;
      metaChips.appendChild(item);
    });
  }

  const recentMessage = document.getElementById("debugSessionRecentMessage");
  if (recentMessage) {
    recentMessage.textContent =
      debugSessionActivityEvents[0]?.message || actionCopy.title;
  }
  startDebugSessionClock(session, progress);
  renderCaptureTaskWorkers(progress);

  const numberingLabel = document.getElementById("debugSessionNumberingLabel");
  if (numberingLabel) {
    const profileDiscovery =
      progress?.targetedPost === true &&
      isTargetedProfileDiscoveryWorkflow(
        progress?.workflow,
        progress?.targetMode || progress?.taskMeta?.targetMode,
      );
    numberingLabel.textContent =
      progress?.targetedPost === true
        ? profileDiscovery
          ? "记录账号扫描结果"
          : "记录帖子巡查结果"
        : markedCount > 0
          ? `正在标记采集结果 · ${markedCount} 条`
          : "正在标记采集结果";
  }
  const detailLabel = document.getElementById("debugSessionDetailLabel");
  if (detailLabel) {
    const current = Math.max(0, Number(progress?.itemCurrent) || 0);
    const total = Math.max(0, Number(progress?.itemTotal) || 0);
    const keyword = String(progress?.keyword || "").trim();
    const keywordLabel = keyword
      ? keyword.length > 14
        ? `${keyword.slice(0, 14)}…`
        : keyword
      : "";
    const profileDiscovery =
      progress?.targetedPost === true &&
      isTargetedProfileDiscoveryWorkflow(
        progress?.workflow,
        progress?.targetMode || progress?.taskMeta?.targetMode,
      );
    const detailStepText =
      progress?.targetedPost === true
        ? profileDiscovery
          ? "扫描当前账号作品"
          : "采集当前帖子详情"
        : keywordLabel
          ? `完善「${keywordLabel}」作品详情`
          : "完善作品详情";
    detailLabel.textContent =
      activeStep === 3 && total > 0
        ? `${detailStepText} · ${Math.min(current, total)}/${total}`
        : detailStepText;
  }
  panel.querySelectorAll("[data-debug-step]").forEach((step) => {
    const index = Number(step.getAttribute("data-debug-step"));
    step.classList.toggle("is-complete", index < activeStep);
    step.classList.toggle("is-active", index === activeStep);
    step.classList.toggle("is-pending", index > activeStep);
  });
}

async function loadTerminalCaptureSummaryAcknowledgements() {
  try {
    const stored = await chrome.storage.local.get(
      TERMINAL_SUMMARY_ACK_STORAGE_KEY,
    );
    const acknowledgements =
      stored?.[TERMINAL_SUMMARY_ACK_STORAGE_KEY] &&
      typeof stored[TERMINAL_SUMMARY_ACK_STORAGE_KEY] === "object"
        ? stored[TERMINAL_SUMMARY_ACK_STORAGE_KEY]
        : {};
    debugSessionDismissedUnattendedTerminalRunAt = String(
      acknowledgements.unattendedTerminalSummaryId || "",
    ).trim();
    debugSessionDismissedTargetedTerminalRunAt = String(
      acknowledgements.targetedTerminalSummaryId || "",
    ).trim();
    return true;
  } catch (error) {
    console.warn("[Sidebar] Load terminal summary acknowledgements failed:", error);
    return false;
  }
}

async function persistTerminalCaptureSummaryAcknowledgements() {
  const acknowledgements = {
    schemaVersion: 1,
    unattendedTerminalSummaryId:
      debugSessionDismissedUnattendedTerminalRunAt,
    targetedTerminalSummaryId:
      debugSessionDismissedTargetedTerminalRunAt,
    updatedAt: new Date().toISOString(),
  };
  try {
    await chrome.storage.local.set({
      [TERMINAL_SUMMARY_ACK_STORAGE_KEY]: acknowledgements,
    });
    return true;
  } catch (error) {
    if (isStorageQuotaError(error)) {
      await releaseControlStorageReserve();
      try {
        await chrome.storage.local.set({
          [TERMINAL_SUMMARY_ACK_STORAGE_KEY]: acknowledgements,
        });
        void ensureControlStorageReserve();
        return true;
      } catch (retryError) {
        console.warn(
          "[Sidebar] Persist terminal acknowledgement after reserve release failed:",
          retryError,
        );
      }
    }
    console.warn(
      "[Sidebar] Persist terminal summary acknowledgements failed:",
      error,
    );
    return false;
  }
}

async function dismissAllTerminalCaptureSummaries() {
  const displayPlan = buildKeywordRunDisplayPlan(sidebarTaskController.readKeywordPlanState());
  const planStatus = String(
    displayPlan?.lastRunStatus || "",
  ).trim().toLowerCase();
  if (KEYWORD_PLAN_TERMINAL_STATUSES.has(planStatus)) {
    debugSessionDismissedUnattendedTerminalRunAt =
      String(displayPlan?.lastRunAt || "").trim() ||
      String(displayPlan?.lastRunProgress?.updatedAt || "").trim() ||
      `${planStatus}:${String(displayPlan?.lastRunMessage || "").trim()}`;
  }

  const targetedStatus = String(
    sidebarTaskController.readTargetedPostRunState()?.status || "",
  ).trim().toLowerCase();
  if (
    cloudTargetedPostApi?.isTerminalRunStatus?.(targetedStatus)
  ) {
    debugSessionDismissedTargetedTerminalRunAt =
      String(
        sidebarTaskController.readTargetedPostRunState()?.finishedAt ||
          sidebarTaskController.readTargetedPostRunState()?.updatedAt ||
          "",
      ).trim() ||
      `${String(sidebarTaskController.readTargetedPostRunState()?.id || "")}:${targetedStatus}:${String(sidebarTaskController.readTargetedPostRunState()?.message || "").trim()}`;
  }
  return await persistTerminalCaptureSummaryAcknowledgements();
}

function setupDebugSessionPanelControls() {
  if (debugSessionPanelListenersBound) return;
  const minimize = document.getElementById("btnDebugSessionMinimize");
  const dock = document.getElementById("debugSessionDock");
  const focus = document.getElementById("btnDebugSessionFocusTab");
  const stop = document.getElementById("btnDebugSessionStop");
  if (!minimize || !dock || !focus || !stop) return;

  minimize.addEventListener("click", async () => {
    const panel = document.getElementById("debugSessionPanel");
    if (panel?.dataset?.terminal === "true") {
      // 一个页面可能同时保留“一次性/无人值守”和“定向巡查”的终态。
      // 关闭应退出任务状态视图，而不是只隐藏当前一张卡后露出另一张。
      await dismissAllTerminalCaptureSummaries();
      debugSessionPanelMinimized = false;
      renderCaptureDebugSession(getCurrentRuntime() || {});
      return;
    }
    await setCaptureTaskPanelMinimized(true);
  });
  dock.addEventListener("click", async () => {
    await setCaptureTaskPanelMinimized(false);
  });
  focus.addEventListener("click", async () => {
    const session = getCurrentRuntime()?.captureDebugSession;
    const panelTabId = Number(
      document.getElementById("debugSessionPanel")?.dataset?.tabId,
    );
    const workerTabIds = Array.isArray(session?.workerTabIds)
      ? session.workerTabIds
      : [];
    const tabId = Number(
      workerTabIds[workerTabIds.length - 1] ??
        session?.sourceTabId ??
        session?.tabId ??
        panelTabId,
    );
    if (!Number.isSafeInteger(tabId) || tabId <= 0) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, {active: true});
      if (Number.isSafeInteger(Number(tab.windowId))) {
        await chrome.windows.update(Number(tab.windowId), {focused: true});
      }
    } catch (error) {
      showMessage(`无法定位采集页：${error?.message || error}`, "error");
    }
  });
  stop.addEventListener("click", async () => {
    if (stop.disabled) return;
    if (
      document.getElementById("debugSessionPanel")?.dataset?.terminal === "true"
    ) {
      stop.hidden = true;
      stop.style.display = "none";
      return;
    }
    stop.disabled = true;
    stop.textContent = "正在停止…";
    try {
      const panel = document.getElementById("debugSessionPanel");
      if (panel?.dataset?.targetedPost === "true") {
        await cancelTargetedPostRunFromSidebar(
          panel?.dataset?.targetedPostRequestId || "",
        );
        return;
      }
      const stoppingUnattended =
        panel?.dataset?.unattended === "true" ||
        isKeywordPlanRunning(buildKeywordRunDisplayPlan(sidebarTaskController.readKeywordPlanState()));
      if (stoppingUnattended) {
        await cancelUnattendedKeywordPlanFromSidebar(
          panel?.dataset?.unattendedRequestId || "",
        );
      } else {
        await handleCancel();
      }
    } finally {
      setTimeout(() => {
        stop.disabled = false;
        stop.textContent = "停止";
      }, 1200);
    }
  });
  debugSessionPanelListenersBound = true;
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

  // 二维码图加载失败时隐藏整个二维码框。原来用内联 onerror= 会违反扩展 CSP(script-src 'self')
  // 被拦下并刷错,改成 JS 绑定既消错又能真正生效。
  const qrImage = overlay.querySelector(".contact-qr-image");
  if (qrImage) {
    qrImage.addEventListener("error", () => {
      const frame = qrImage.closest(".contact-qr-frame");
      if (frame) frame.style.display = "none";
    });
  }

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

function createAuthMutationId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `auth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function persistAuthCodeFromInput() {
  const operation = () => persistAuthCodeFromInputNow();
  const pending = authCodePersistPromise.then(operation, operation);
  authCodePersistPromise = pending.catch(() => null);
  return pending;
}

async function persistAuthCodeFromInputNow() {
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
      authCodeRevision += 1;
      await setCurrentAuth({
        code: "",
        verified: false,
        status: AUTH_STATUS.IDLE,
        reason: "none",
        message: "",
        user: null,
        credentialCredit: null,
        captureAgent: null,
        credential: null,
        binding: null,
        authMutationId: createAuthMutationId(),
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
  const needsMutationId = !String(currentAuth.authMutationId || "").trim();
  if (!codeChanged && !needsMutationId && isEncryptedAuthCode(previousCode)) {
    return;
  }

  const updates = {code: encryptedCode};

  if (codeChanged || needsMutationId) {
    updates.authMutationId = createAuthMutationId();
  }

  if (codeChanged) {
    authCodeRevision += 1;
    Object.assign(updates, {
      verified: false,
      status: AUTH_STATUS.IDLE,
      reason: "none",
      message: "",
      user: null,
      credentialCredit: null,
      captureAgent: null,
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
    await setCurrentAuth(
      {code: encryptedCode},
      {expectedMutationId: auth?.authMutationId},
    );
    if (currentToken !== authCodeRenderToken) return;
  }

  if (inputCode.value !== plainCode) {
    inputCode.value = plainCode;
  }
}

// ==================== UI 事件监听 ====================

async function handleTaskCenterAction(event) {
  const detail = event?.detail && typeof event.detail === "object"
    ? event.detail
    : {};
  const rawAction = String(detail.action || "").trim();
  const action =
    rawAction === "stop_keep"
      ? "stop"
      : rawAction === "resume_remaining"
        ? "continue_remaining"
        : rawAction;
  const taskId = String(detail.taskId || detail.id || "").trim();
  if (!action) return;

  if (action === "view_results") {
    window.activateSidebarTab?.("searchTab");
    return;
  }

  if (action === "keep_results") {
    if (!taskId) {
      showMessage("未找到要保留的任务，请刷新任务中心后重试", "warning");
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:cancel-unattended-keyword-run",
        requestId: taskId,
        message: "用户选择保留已有结果，不再自动恢复",
      });
      if (!response?.ok) {
        throw new Error(response?.reason || response?.error?.message || "任务状态更新失败");
      }
      showMessage("已保留当前结果，任务不会自动重试", "success");
    } catch (error) {
      showMessage("保留结果失败: " + error.message, "error");
    }
    return;
  }

  if (action === "stop") {
    if (taskId) {
      try {
        const unattendedResponse = await chrome.runtime.sendMessage({
          type: "onstarvoice:cancel-unattended-keyword-run",
          requestId: taskId,
          message: "用户从任务中心停止任务并保留已有结果",
        });
        if (unattendedResponse?.ok) {
          showMessage("正在停止任务并保留已有结果...", "warning");
          return;
        }
      } catch (error) {
        console.warn("[Sidebar] Cancel task center unattended run failed:", error);
      }
    }
    const activeTask = getActiveTaskContext();
    if (!taskId || activeTask?.taskId === taskId) {
      await handleCancel();
      showMessage("正在停止任务并保留已有结果...", "warning");
      return;
    }
    showMessage("这条任务已不在当前页面执行，已刷新任务状态", "warning");
    return;
  }

  const recoveryModeByAction = {
    continue_remaining: "remaining",
    retry_failed: "failed",
    skip_current: "skip_current",
  };
  const mode = recoveryModeByAction[action];
  if (!mode || !taskId) return;
  if (
    action === "continue_remaining" &&
    isUnattendedSafetyBlock(detail.task || {}) &&
    !window.confirm(
      "请先在抖音页面人工完成安全验证。确认页面已经恢复正常后，再继续剩余关键词。",
    )
  ) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:recover-unattended-keyword-run",
      requestId: taskId,
      mode,
    });
    if (!response?.ok) {
      throw new Error(response?.reason || response?.error?.message || "无法恢复任务");
    }
    showMessage(
      mode === "failed"
        ? "已安排仅重试失败关键词"
        : mode === "skip_current"
          ? "已跳过当前项并继续剩余任务"
          : "已从检查点继续剩余任务",
      "success",
    );
    await loadKeywordPlanUI();
  } catch (error) {
    showMessage("恢复任务失败: " + error.message, "error");
  }
}

/**
 * 设置 UI 事件监听
 */
function setupUIEventListeners() {
  document.addEventListener(
    "onstarvoice:task-center-action",
    handleTaskCenterAction,
  );
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
    .querySelectorAll('[data-detail-setting="auto-sync"]')
    .forEach((input) => {
      input.addEventListener("change", handleDetailCaptureAutoSyncToggleChange);
    });
  document
    .querySelectorAll('[data-detail-setting="ai-relevance-prefilter"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureAiRelevancePrefilterToggleChange,
      );
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
    .querySelectorAll("[data-search-execution-mode]")
    .forEach((tab) => {
      tab.addEventListener("click", () =>
        setSearchExecutionMode(tab.getAttribute("data-search-execution-mode")),
      );
    });
  setSearchExecutionMode("manual");
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
  document
    .getElementById("btnSaveKeywordPlan")
    ?.addEventListener("click", () => handleSaveKeywordPlan("modal"));
  document
    .getElementById("btnSaveSearchKeywordPlan")
    ?.addEventListener("click", () => handleSaveKeywordPlan("search"));
  document
    .getElementById("btnAddSearchKeywordPlanDate")
    ?.addEventListener("click", addSearchKeywordPlanDateFromPicker);
  document
    .getElementById("inputSearchKeywordPlanDatePicker")
    ?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      addSearchKeywordPlanDateFromPicker();
    });
  document
    .getElementById("searchKeywordPlanDateChips")
    ?.addEventListener("click", handleSearchKeywordPlanDateChipClick);
  document
    .getElementById("selectKeywordPlanMode")
    ?.addEventListener("change", () => syncKeywordPlanDateFields("modal"));
  document
    .getElementById("selectSearchKeywordPlanMode")
    ?.addEventListener("change", () => syncKeywordPlanDateFields("search"));
  document
    .getElementById("chkKeywordPlanEnabled")
    ?.addEventListener("change", () =>
      renderKeywordPlanStatus(sidebarTaskController.readKeywordPlanState(), "modal"),
    );
  document
    .getElementById("chkSearchKeywordPlanEnabled")
    ?.addEventListener("change", () =>
      renderKeywordPlanStatus(sidebarTaskController.readKeywordPlanState(), "search"),
    );
  // 轮次设置已合并进「无人值守计划」:执行轮数 > 1 即循环,不再单独暴露第二个开关。
  const bindAutoLoopFields = (chkId, fieldsId) => {
    const chk = document.getElementById(chkId);
    const sync = () =>
      document
        .getElementById(fieldsId)
        ?.classList.toggle("is-disabled", chk && !chk.checked && !chk.hidden);
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
    if (capBtn) capBtn.textContent = on ? "开始批量采集" : "采集当前搜索结果";
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
      sidebarTaskController.replaceExpandedKeywordsBuffer(parseKeywordsFromMultilineInput(
        document.getElementById("textareaExpandedKeywords")?.value || "",
      ));
      updateExpandedKeywordsSummary();
      invalidateKeywordInsightDraft();
      renderKeywordInsightState();
      persistCurrentBatchDraft();
    });

  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel) {
    btnCancel.addEventListener("click", handleCancel);
  }
  document
    .getElementById("btnRetryRecovery")
    ?.addEventListener("click", handleRetryRecovery);
  document
    .getElementById("btnDismissRecovery")
    ?.addEventListener("click", handleDismissRecovery);

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
  const getMoreMenuItems = () =>
    dropdownMoreMenu
      ? Array.from(dropdownMoreMenu.querySelectorAll(".dropdown-item"))
      : [];
  const setMoreMenuOpen = (
    open,
    {restoreFocus = false, focusEdge = ""} = {},
  ) => {
    if (!btnMoreMenu || !dropdownMoreMenu) return;
    const nextOpen = Boolean(open);
    dropdownMoreMenu.classList.toggle("is-active", nextOpen);
    btnMoreMenu.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    if (restoreFocus) {
      btnMoreMenu.focus();
    } else if (nextOpen && focusEdge) {
      requestAnimationFrame(() => {
        const items = getMoreMenuItems();
        const target = focusEdge === "last" ? items.at(-1) : items[0];
        target?.focus();
      });
    }
  };
  if (btnMoreMenu && dropdownMoreMenu) {
    dropdownMoreMenu
      .querySelectorAll(".dropdown-item")
      .forEach((item) => item.setAttribute("role", "menuitem"));
    btnMoreMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      const nextOpen = !dropdownMoreMenu.classList.contains("is-active");
      setMoreMenuOpen(nextOpen, {focusEdge: nextOpen ? "first" : ""});
    });
    dropdownMoreMenu.addEventListener("click", (event) => {
      if (event.target.closest(".dropdown-item")) {
        setMoreMenuOpen(false, {restoreFocus: true});
      }
    });
    dropdownMoreMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMoreMenuOpen(false, {restoreFocus: true});
        return;
      }
      if (!new Set(["ArrowDown", "ArrowUp", "Home", "End"]).has(event.key)) {
        return;
      }
      const items = getMoreMenuItems();
      if (items.length === 0) return;
      event.preventDefault();
      const activeIndex = items.indexOf(document.activeElement);
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowUp"
              ? (activeIndex <= 0 ? items.length : activeIndex) - 1
              : (activeIndex + 1) % items.length;
      items[nextIndex]?.focus();
    });
    btnMoreMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMoreMenuOpen(false, {restoreFocus: true});
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMoreMenuOpen(true, {
          focusEdge: event.key === "ArrowUp" ? "last" : "first",
        });
      }
    });
    document.addEventListener("click", (e) => {
      if (
        !dropdownMoreMenu.contains(e.target) &&
        !btnMoreMenu.contains(e.target)
      ) {
        setMoreMenuOpen(false);
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
      setMoreMenuOpen(false);
    });
  }

  const menuBtnHistory = document.getElementById("menuBtnHistory");
  if (menuBtnHistory) {
    menuBtnHistory.addEventListener("click", () => {
      window.activateSidebarTab("historyTab");
      setMoreMenuOpen(false);
    });
  }

  const menuBtnCheckUpdate = document.getElementById("menuBtnCheckUpdate");
  if (menuBtnCheckUpdate) {
    menuBtnCheckUpdate.addEventListener("click", () => {
      void checkExtensionUpdate({
        trigger: "manual",
        openModalWhenLatest: true,
      });
      setMoreMenuOpen(false);
    });
  }

  const menuBtnContact = document.getElementById("menuBtnContact");
  if (menuBtnContact) {
    menuBtnContact.addEventListener("click", () => {
      openContactModal();
      setMoreMenuOpen(false);
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

  document.querySelectorAll(".monitor-subject-option").forEach((button) => {
    button.addEventListener("click", () => {
      setMonitorSubjectType(button.dataset.subjectType);
    });
  });
  setMonitorSubjectType(getMonitorSubjectType());

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
      syncSearchFilterControlsForPlatform(getViewPlatform(runtime));
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

// 搜索页:在当前激活 tab 应用排序/范围筛选(复用 content 的 applyBatchSearchFilters,失败不阻断采集)

// ==================== 关键词裂变 ====================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 可中断睡眠:每秒检查 shouldStop,用于循环采集的轮次间隔

/**
 * 处理取消操作
 */

/**
 * 处理鉴权
 */
function queueAuthVerification(operation) {
  const run = () => operation();
  const pending = authVerifyQueue.then(run, run);
  authVerifyQueue = pending.catch(() => null);
  return pending;
}

async function isAuthVerificationRequestCurrent({
  plainCode,
  revision,
  mutationId,
  input = null,
}) {
  const expectedCode = normalizeAuthCodeInput(plainCode);
  const expectedMutationId = String(mutationId || "");
  const inputMatches = () =>
    !input || normalizeAuthCodeInput(input.value) === expectedCode;
  if (!expectedCode || revision !== authCodeRevision || !inputMatches()) return false;

  const currentAuth = getCurrentAuth() || {};
  const currentCode = normalizeAuthCodeInput(currentAuth.code);
  if (!currentCode) return false;
  try {
    const storedAuth = await getAuth();
    const storedCode = normalizeAuthCodeInput(storedAuth?.code);
    const [currentPlainCode, storedPlainCode] = await Promise.all([
      ensurePlainAuthCode(currentCode),
      ensurePlainAuthCode(storedCode),
    ]);
    if (revision !== authCodeRevision || !inputMatches()) return false;
    const latestAuth = getCurrentAuth() || {};
    return (
      normalizeAuthCodeInput(latestAuth.code) === currentCode &&
      String(latestAuth.authMutationId || "") === expectedMutationId &&
      String(storedAuth?.authMutationId || "") === expectedMutationId &&
      normalizeAuthCodeInput(currentPlainCode) === expectedCode &&
      normalizeAuthCodeInput(storedPlainCode) === expectedCode
    );
  } catch {
    return false;
  }
}

function handleVerify() {
  if (authVerifyPromise) return authVerifyPromise;
  const pending = queueAuthVerification(handleVerifyImpl);
  const tracked = pending.finally(() => {
    if (authVerifyPromise === tracked) authVerifyPromise = null;
  });
  authVerifyPromise = tracked;
  return tracked;
}

async function handleVerifyImpl() {
  if (authVerifyInFlight) {
    showMessage("正在验证中，请稍候...", "info");
    return;
  }

  const input = document.getElementById("inputCode");
  if (!input) return;

  if (authCodeEncryptTimer) {
    clearTimeout(authCodeEncryptTimer);
    authCodeEncryptTimer = null;
  }
  await persistAuthCodeFromInput();

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
  const requestRevision = authCodeRevision;

  const currentAuth = getCurrentAuth() || {};
  const requestMutationId = String(currentAuth.authMutationId || "");
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
    if (!(await isAuthVerificationRequestCurrent({
      plainCode,
      revision: requestRevision,
      mutationId: requestMutationId,
      input,
    }))) {
      showMessage("激活码已更改，未发送旧验证请求", "info");
      return {ok: false, skipped: true, reason: "auth_changed"};
    }
    const verifyingWrite = await setCurrentAuth(
      {
        status: AUTH_STATUS.VERIFYING,
        code: encryptedCode,
        message: "",
        reason: "none",
      },
      {expectedMutationId: requestMutationId},
    );
    if (!verifyingWrite?.accepted) {
      showMessage("激活码已更改，未发送旧验证请求", "info");
      return {ok: false, skipped: true, reason: "auth_changed"};
    }

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
        if (!(await isAuthVerificationRequestCurrent({
          plainCode,
          revision: requestRevision,
          mutationId: requestMutationId,
          input,
        }))) {
          return {ok: false, skipped: true, reason: "auth_changed"};
        }
        result = await verify(plainCode, {
          replaceBindingId: selectedBindingId,
        });
      }
    }

    if (!(await isAuthVerificationRequestCurrent({
      plainCode,
      revision: requestRevision,
      mutationId: requestMutationId,
      input,
    }))) {
      showMessage("激活码已更改，旧验证结果已忽略", "info");
      return {ok: false, skipped: true, reason: "auth_changed"};
    }

    if (result.ok) {
      const authSnapshot = authSnapshotFromVerifyResult(result);
      const verifiedWrite = await setCurrentAuth(
        {
          verified: true,
          status: AUTH_STATUS.VERIFIED,
          code: encryptedCode,
          lastVerifiedAt: new Date().toISOString(),
          message: result.message,
          reason: "none",
          ...authSnapshot,
        },
        {expectedMutationId: requestMutationId},
      );
      if (!verifiedWrite?.accepted) {
        return {ok: false, skipped: true, reason: "auth_changed"};
      }

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
      const failedWrite = await setCurrentAuth(
        {
          verified: false,
          status: AUTH_STATUS.FAILED,
          code: encryptedCode,
          message: result.message,
          reason: result.reason,
          user: null,
          credentialCredit: null,
          captureAgent: null,
        },
        {expectedMutationId: requestMutationId},
      );
      if (!failedWrite?.accepted) {
        return {ok: false, skipped: true, reason: "auth_changed"};
      }
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
    if (await isAuthVerificationRequestCurrent({
      plainCode,
      revision: requestRevision,
      mutationId: requestMutationId,
      input,
    })) {
      await resetCurrentMonitor();
      showMessage("验证失败: " + error.message, "error");
    }
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

function refreshVerifiedAuthSnapshot(options = {}) {
  if (authRefreshPromise) return authRefreshPromise;
  const pending = queueAuthVerification(() => refreshVerifiedAuthSnapshotImpl(options));
  const tracked = pending.finally(() => {
    if (authRefreshPromise === tracked) authRefreshPromise = null;
  });
  authRefreshPromise = tracked;
  return tracked;
}

async function refreshVerifiedAuthSnapshotImpl({showFeedback = false} = {}) {
  const auth = getCurrentAuth() || {};
  if (!isAuthVerified(auth) || !auth.code) {
    return {ok: false, skipped: true};
  }

  let plainCode = "";
  try {
    plainCode = normalizeAuthCodeInput(await ensurePlainAuthCode(auth.code));
  } catch {
    return {ok: false, skipped: true, reason: "invalid_auth_code"};
  }
  const requestRevision = authCodeRevision;
  const requestMutationId = String(auth.authMutationId || "");
  const input = document.getElementById("inputCode");
  if (!(await isAuthVerificationRequestCurrent({
    plainCode,
    revision: requestRevision,
    mutationId: requestMutationId,
    input,
  }))) {
    return {ok: false, skipped: true, reason: "auth_changed"};
  }

  try {
    const result = await verify(auth.code);
    if (!(await isAuthVerificationRequestCurrent({
      plainCode,
      revision: requestRevision,
      mutationId: requestMutationId,
      input,
    }))) {
      return {ok: false, skipped: true, reason: "auth_changed"};
    }
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
    const refreshedWrite = await setCurrentAuth(
      {
        verified: true,
        status: AUTH_STATUS.VERIFIED,
        code: auth.code,
        lastVerifiedAt: new Date().toISOString(),
        message: result.message || auth.message || "",
        reason: "none",
        ...authSnapshot,
      },
      {expectedMutationId: requestMutationId},
    );
    if (!refreshedWrite?.accepted) {
      return {ok: false, skipped: true, reason: "auth_changed"};
    }

    if (showFeedback) {
      showMessage("授权信息已刷新", "success");
    }

    return {ok: true, data: result.data || null};
  } catch (error) {
    console.error("[Sidebar] Refresh auth snapshot failed:", error);
    if (showFeedback && await isAuthVerificationRequestCurrent({
      plainCode,
      revision: requestRevision,
      mutationId: requestMutationId,
      input,
    })) {
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
    captureAgent: authResponseValue(result, "captureAgent", currentAuth.captureAgent ?? null),
  };
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
    const enableAiRelevancePrefilter =
      authVerified && Boolean(settings.enableAiRelevancePrefilter);
    const autoSyncAfterDetailCapture =
      authVerified && Boolean(settings.autoSyncAfterDetailCapture);
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
        settings.enableAiRelevancePrefilter ||
        settings.autoSyncAfterDetailCapture ||
        settings.includeCommentsOnDetailCapture ||
        settings.enableCommentLeadsFilterOnDetailCapture ||
        settings.includeBloggerMetricsOnDetailCapture)
    ) {
      await saveCaptureSettings({
        autoDetailCaptureAfterListCapture: false,
        enableAiRelevancePrefilter: false,
        autoSyncAfterDetailCapture: false,
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
      enableAiRelevancePrefilter,
      autoSync: autoSyncAfterDetailCapture,
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
    applyKeywordSortDimensionToUI(sidebarTaskController.readKeywordSortDimension());

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
        autoSync: false,
      });
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    syncAutoDetailCaptureControls({
      autoDetailCapture: checked,
      autoSync: checked ? null : false,
    });
    updateBloggerKeywordFilterHint();
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save auto detail capture toggle failed:", error);
  }
}

async function handleDetailCaptureAutoSyncToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({autoSync: false});
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    if (checked) {
      syncAutoDetailCaptureControls({
        autoDetailCapture: true,
        autoSync: true,
      });
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save detail auto sync toggle failed:", error);
  }
}

async function handleDetailCaptureAiRelevancePrefilterToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({enableAiRelevancePrefilter: false});
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    if (checked) {
      syncAutoDetailCaptureControls({
        autoDetailCapture: true,
        enableAiRelevancePrefilter: true,
      });
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save AI relevance prefilter toggle failed:", error);
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
    const enableAiRelevancePrefilter =
      getDetailCaptureAiRelevancePrefilterChecked(current);
    const autoSyncAfterDetailCapture =
      autoDetailCaptureAfterListCapture &&
      getDetailCaptureAutoSyncChecked(current);
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
      enableAiRelevancePrefilter,
      autoSyncAfterDetailCapture,
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

const DETAIL_ITEM_SETTLED_PHASES = new Set([
  "detail_item_done",
  "detail_item_failed",
  "detail_item_skipped",
  "detail_item_filtered",
]);

/**
 * 处理导出
 */
async function handleExport() {
  if (sidebarTaskController.readDetailBatchCaptureInFlight()) {
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
  if (sidebarTaskController.readDetailBatchCaptureInFlight()) {
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
  if (
    !confirm(
      "确定要清空任务中心记录吗？真实仍在运行的任务会保留，历史、已结束和陈旧任务记录会被清除。",
    )
  ) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.CLEAR_TASK_CENTER,
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "后台未能清空任务中心");
    }
    await Promise.all([refreshSyncHistory(), refreshTaskLedger()]);
    const preservedActiveCount = Number(
      response?.data?.preservedActiveCount || 0,
    );
    showMessage(
      preservedActiveCount > 0
        ? `任务中心已清理，保留 ${preservedActiveCount} 个真实运行中的任务`
        : "任务中心已清空",
      "success",
    );
  } catch (error) {
    console.error("[Sidebar] Clear task center failed:", error);
    showMessage("清空任务中心失败: " + error.message, "error");
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

const CAPTURE_RECOVERY_PHASES = new Set([
  "network_paused",
  "network_resumed",
  "network_timeout",
  "system_resumed",
  "capture_recovering",
  "capture_canceling",
  "capture_stalled",
  "comments_partial",
  "comments_failed",
  "interrupted_repaired",
]);
const CAPTURE_RECOVERY_UI_STALE_MS = 5 * 60 * 1000;
const ACTIVE_COMMENT_PROGRESS_PHASES = new Set([
  "comments_opening",
  "comments_collecting",
  "comments_capturing",
  "detail_comments_capturing",
  "network_paused",
  "network_resumed",
  "system_resumed",
  "capture_recovering",
  "capture_canceling",
]);

/**
 * 处理进度回调
 */

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

function getDetailCaptureAutoSyncChecked(settings) {
  const input = getActiveDetailCaptureInput("auto-sync");
  if (!input) {
    return Boolean(settings?.autoSyncAfterDetailCapture);
  }
  return Boolean(input.checked);
}

function getDetailCaptureAiRelevancePrefilterChecked(settings) {
  const input = getActiveDetailCaptureInput("ai-relevance-prefilter");
  if (!input) {
    return Boolean(settings?.enableAiRelevancePrefilter);
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
  enableAiRelevancePrefilter = null,
  autoSync = null,
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
    const autoSyncInput = panel.querySelector(
      '[data-detail-setting="auto-sync"]',
    );
    const aiRelevancePrefilterInput = panel.querySelector(
      '[data-detail-setting="ai-relevance-prefilter"]',
    );
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
    if (autoSyncInput && autoSync !== null) {
      autoSyncInput.checked = Boolean(autoSync);
    }
    if (
      aiRelevancePrefilterInput &&
      enableAiRelevancePrefilter !== null
    ) {
      aiRelevancePrefilterInput.checked = Boolean(
        enableAiRelevancePrefilter,
      );
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
    if (autoSyncInput) {
      autoSyncInput.disabled =
        forceDisabled || !autoChecked || !capabilities.batchDetailCapture;
    }
    if (aiRelevancePrefilterInput) {
      aiRelevancePrefilterInput.disabled =
        forceDisabled || !autoChecked || !capabilities.batchDetailCapture;
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

  document
    .querySelectorAll('[data-detail-setting="skip-captured"]')
    .forEach((input) => {
      if (skipAlreadyCaptured !== null) {
        input.checked = Boolean(skipAlreadyCaptured);
      }
      input.disabled = forceDisabled || !detailCaptureSupported;
    });

}

function syncDetailCaptureControlsFromStoredSettings(settings = {}, {platform = ""} = {}) {
  const autoDetailCapture = Boolean(settings?.autoDetailCaptureAfterListCapture);
  const defaultCommentsMaxDetectedItems = Number(
    DEFAULT_CAPTURE_SETTINGS.detailCommentsMaxDetectedItems ||
      DEFAULT_CAPTURE_SETTINGS.commentsMaxDetectedItems ||
      100,
  );
  const defaultLowFollowerHitThreshold = Number(
    DEFAULT_CAPTURE_SETTINGS.lowFollowerHitThreshold || 10000,
  );

  syncAutoDetailCaptureControls({
    autoDetailCapture,
    enableAiRelevancePrefilter: Boolean(
      settings?.enableAiRelevancePrefilter,
    ),
    autoSync:
      autoDetailCapture && Boolean(settings?.autoSyncAfterDetailCapture),
    includeComments: Boolean(settings?.includeCommentsOnDetailCapture),
    commentsMaxDetectedItems: readPositiveIntegerFromRawValue(
      settings?.detailCommentsMaxDetectedItems ??
        settings?.commentsMaxDetectedItems,
      defaultCommentsMaxDetectedItems,
    ),
    enableCommentLeadsFilter: Boolean(
      settings?.enableCommentLeadsFilterOnDetailCapture,
    ),
    includeBloggerMetrics: Boolean(
      settings?.includeBloggerMetricsOnDetailCapture,
    ),
    skipAlreadyCaptured: settings?.skipAlreadyCapturedOnDetailCapture !== false,
    enableLowFollowerHitFilter: Boolean(
      settings?.enableLowFollowerHitFilterOnDetailCapture,
    ),
    lowFollowerHitThreshold: readNonNegativeIntegerFromRawValue(
      settings?.lowFollowerHitThresholdOnDetailCapture ??
        settings?.lowFollowerHitThreshold,
      defaultLowFollowerHitThreshold,
    ),
    platform,
  });
}

async function persistDetailCaptureSettingsFromInputs() {
  const current = await getCaptureSettings();
  const autoDetailCaptureAfterListCapture =
    getAutoDetailCaptureChecked(current);
  const enableAiRelevancePrefilter =
    getDetailCaptureAiRelevancePrefilterChecked(current);
  const autoSyncAfterDetailCapture =
    autoDetailCaptureAfterListCapture &&
    getDetailCaptureAutoSyncChecked(current);
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
    enableAiRelevancePrefilter,
    autoSync: autoSyncAfterDetailCapture,
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
    enableAiRelevancePrefilter,
    autoSyncAfterDetailCapture,
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

function resolveTaskCaptureSettingsOverrides(baseSettings = {}, input = {}) {
  const base =
    baseSettings && typeof baseSettings === "object" ? baseSettings : {};
  const source = input && typeof input === "object" ? input : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(source, key);
  const booleanValue = (key, fallback = false) => {
    if (!has(key)) return Boolean(fallback);
    if (source[key] === true || source[key] === "true") return true;
    if (source[key] === false || source[key] === "false") return false;
    return Boolean(fallback);
  };
  const boundedIntegerValue = (key, fallback, minimum, maximum) => {
    const parsed = Math.floor(Number(has(key) ? source[key] : fallback));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
  };
  const enhancementEnabled = booleanValue(
    "autoDetailCaptureAfterListCapture",
    base.autoDetailCaptureAfterListCapture,
  );
  const includeComments =
    enhancementEnabled &&
    booleanValue(
      "includeCommentsOnDetailCapture",
      base.includeCommentsOnDetailCapture,
    );
  const includeBloggerMetrics =
    enhancementEnabled &&
    booleanValue(
      "includeBloggerMetricsOnDetailCapture",
      base.includeBloggerMetricsOnDetailCapture,
    );
  return {
    ...base,
    autoDetailCaptureAfterListCapture: enhancementEnabled,
    autoSyncAfterDetailCapture:
      enhancementEnabled &&
      booleanValue(
        "autoSyncAfterDetailCapture",
        base.autoSyncAfterDetailCapture,
      ),
    enableAiRelevancePrefilter:
      enhancementEnabled &&
      booleanValue(
        "enableAiRelevancePrefilter",
        base.enableAiRelevancePrefilter,
      ),
    includeBloggerMetricsOnDetailCapture: includeBloggerMetrics,
    enableLowFollowerHitFilterOnDetailCapture:
      includeBloggerMetrics &&
      booleanValue(
        "enableLowFollowerHitFilterOnDetailCapture",
        base.enableLowFollowerHitFilterOnDetailCapture,
      ),
    lowFollowerHitThresholdOnDetailCapture: boundedIntegerValue(
      "lowFollowerHitThresholdOnDetailCapture",
      Number(base.lowFollowerHitThresholdOnDetailCapture) || 10000,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    includeCommentsOnDetailCapture: includeComments,
    detailCommentsMaxDetectedItems: boundedIntegerValue(
      "detailCommentsMaxDetectedItems",
      Number(base.detailCommentsMaxDetectedItems) || 50,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    enableCommentLeadsFilterOnDetailCapture:
      includeComments &&
      booleanValue(
        "enableCommentLeadsFilterOnDetailCapture",
        base.enableCommentLeadsFilterOnDetailCapture,
      ),
    skipAlreadyCapturedOnDetailCapture:
      enhancementEnabled &&
      booleanValue(
        "skipAlreadyCapturedOnDetailCapture",
        base.skipAlreadyCapturedOnDetailCapture !== false,
      ),
  };
}

function resolveTaskKeywordMaxDetectedItems(
  localValue = DEFAULT_CAPTURE_SETTINGS.keywordMaxDetectedItems,
  taskValue = null,
) {
  const localParsed = Math.floor(Number(localValue));
  const fallback =
    Number.isSafeInteger(localParsed) && localParsed > 0
      ? localParsed
      : DEFAULT_CAPTURE_SETTINGS.keywordMaxDetectedItems;
  if (taskValue === null || taskValue === undefined || taskValue === "") {
    return fallback;
  }
  const taskParsed = Number(taskValue);
  return Number.isSafeInteger(taskParsed) && taskParsed > 0
    ? taskParsed
    : fallback;
}

function resolveCurrentDetailCaptureSettings(settings = {}) {
  const autoDetailCaptureAfterListCapture =
    getAutoDetailCaptureChecked(settings);
  const aiRelevancePrefilterInput = getActiveDetailCaptureInput(
    "ai-relevance-prefilter",
  );
  const relevancePrefilterSupported =
    getCurrentRuntime()?.pageType === PAGE_TYPE.SEARCH_RESULTS;
  return {
    ...settings,
    autoDetailCaptureAfterListCapture,
    // 该能力只属于搜索页采集增强。博主页没有这个控件，即使保留了
    // 搜索页偏好，也不能把 AI 预筛带入博主笔记增强流程。
    enableAiRelevancePrefilter:
      autoDetailCaptureAfterListCapture &&
      relevancePrefilterSupported &&
      Boolean(
        aiRelevancePrefilterInput
          ? aiRelevancePrefilterInput.checked
          : settings?.enableAiRelevancePrefilter,
      ),
    autoSyncAfterDetailCapture:
      autoDetailCaptureAfterListCapture &&
      getDetailCaptureAutoSyncChecked(settings),
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
        resolveNotePublishCsvValue(p),
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

function resolveNotePublishCsvValue(payload = {}) {
  const rawPublishText = pickFirstLeadString([
    payload.publishTime,
    payload.publishDateRaw,
  ]);
  if (rawPublishText) return rawPublishText;

  const lastEditedAt = firstDefinedMetricValue(payload.lastEditedAt);
  if (
    lastEditedAt &&
    !isLikelyCaptureDateFallback(lastEditedAt, payload.captureTimestamp)
  ) {
    return formatDateTime(lastEditedAt);
  }

  return pickFirstLeadString([payload.publishDate]);
}

function isLikelyCaptureDateFallback(timestamp, captureTimestamp) {
  if (!timestamp || !captureTimestamp) return false;
  const edited = new Date(timestamp);
  const captured = new Date(captureTimestamp);
  if (
    Number.isNaN(edited.getTime()) ||
    Number.isNaN(captured.getTime())
  ) {
    return false;
  }
  return (
    edited.getFullYear() === captured.getFullYear() &&
    edited.getMonth() === captured.getMonth() &&
    edited.getDate() === captured.getDate() &&
    edited.getHours() === 0 &&
    edited.getMinutes() === 0 &&
    edited.getSeconds() === 0
  );
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

  const publicAuth = buildPublicSidebarAuthState(auth);
  window.getSidebarAuthState = () => publicAuth;
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

function isNoteDetailPending(runtime) {
  return (
    runtime?.pageType === PAGE_TYPE.NOTE_DETAIL &&
    runtime?.detailReady === false
  );
}

function resolveNoteDetailPendingText(runtime = {}) {
  const reason = String(runtime.detailReadyReason || "").trim();
  if (reason === "loading") {
    return NOTE_DETAIL_LOADING_TEXT;
  }
  return "正在等待笔记标题、正文或素材加载完成，加载完成后即可采集";
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
  const inDetailBatch = sidebarTaskController.readDetailBatchCaptureInFlight();
  const noteDetailPending = isPlatformMatched && isNote && isNoteDetailPending(runtime);
  const allowCommentsToggle =
    !noteDetailPending && !inDetailBatch && selectedCapabilities.captureComments;
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
    !isNote || noteDetailPending || inDetailBatch || !isPlatformMatched,
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
    const isSearchBatchMode = Boolean(
      document.getElementById("chkSearchBatchMode")?.checked,
    );
    btnCaptureSearch.textContent = isSearchBatchMode
      ? "开始批量采集"
      : platformCopy.captureSearchButtonText;
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
    applyKeywordSortDimensionToUI(sidebarTaskController.readKeywordSortDimension());
    startKeywordSortSyncTimer();
  } else {
    stopKeywordSortSyncTimer();
    sidebarTaskController.replaceKeywordSortDimension(KEYWORD_SORT_DIMENSION.LIKES);
    applyKeywordSortDimensionToUI(sidebarTaskController.readKeywordSortDimension());
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

  if (btnExport) btnExport.disabled = !hasRecords || sidebarTaskController.readDetailBatchCaptureInFlight();
  if (btnSyncAll)
    btnSyncAll.disabled = !hasRecords || sidebarTaskController.readDetailBatchCaptureInFlight();
  if (btnClearPool)
    btnClearPool.disabled = !hasRecords || sidebarTaskController.readDetailBatchCaptureInFlight();
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

function isAiRelevanceFilteredPayload(payload = {}) {
  const audit =
    payload.aiRelevancePrefilter &&
    typeof payload.aiRelevancePrefilter === "object"
      ? payload.aiRelevancePrefilter
      : {};
  const executionDisposition = String(audit.executionDisposition || "")
    .trim()
    .toLowerCase();
  const modelDecision = String(audit.modelDecision || audit.decision || "")
    .trim()
    .toLowerCase();
  const traceState = String(payload?.captureTrace?.state || "")
    .trim()
    .toLowerCase();

  return (
    executionDisposition === "skip_expensive" ||
    (traceState === "filtered" && modelDecision === "skip")
  );
}

function isDetailCaptureFiltered(record) {
  const payload = record?.payload || {};
  const detailStatus = String(payload.detailCaptureStatus || "")
    .trim()
    .toLowerCase();
  const traceState = String(payload?.captureTrace?.state || "")
    .trim()
    .toLowerCase();
  return (
    detailStatus === "filtered" ||
    isAiRelevanceFilteredPayload(payload) ||
    traceState === "filtered"
  );
}

function isDetailCaptureDone(record) {
  const payload = record?.payload || {};
  const detailStatus = String(payload.detailCaptureStatus || "")
    .trim()
    .toLowerCase();
  return (
    isDetailCaptureFiltered(record) ||
    detailStatus === "deferred" ||
    (detailStatus === "done" &&
      payload.detailPayload &&
      typeof payload.detailPayload === "object")
  );
}

function isDetailCaptureRetryable(record) {
  if (!isDetailCaptureRecord(record)) {
    return false;
  }
  const payload = record?.payload || {};
  const status = String(payload.detailCaptureStatus || "not_started")
    .trim()
    .toLowerCase();
  if (status === "deferred") return true;
  if (isDetailCaptureDone(record)) return false;
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
  const expectedNoteId = resolveRecordDetailNoteId(record);
  const candidates = [
    buildDouyinRecordSearchModalUrl(record, expectedNoteId),
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
      const candidateNoteId = extractNoteId(normalized);
      if (
        expectedNoteId &&
        candidateNoteId &&
        candidateNoteId !== expectedNoteId
      ) {
        continue;
      }
      return normalizeDouyinDetailUrlAgainstRecord(record, normalized);
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
    const contextualUrl = buildDouyinRecordSearchModalUrl(record, noteId);
    if (contextualUrl) return contextualUrl;
    return `https://www.douyin.com/${resolveRecordDetailNotePath(record)}/${noteId}`;
  }

  return `https://www.xiaohongshu.com/explore/${noteId}`;
}

function buildDouyinRecordSearchModalUrl(record, noteId) {
  if (!/^\d{8,}$/.test(String(noteId || ""))) {
    return "";
  }
  const payload = record?.payload || {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === "object"
      ? payload.items[0]
      : {};
  const candidates = [
    firstItem.searchUrl,
    payload.searchUrl,
    record?.meta?.sourceUrl,
    record?.sourceUrl,
  ];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(String(candidate || ""));
      const hostname = parsed.hostname.toLowerCase();
      if (
        (hostname !== "douyin.com" && !hostname.endsWith(".douyin.com")) ||
        !/\/search\//i.test(parsed.pathname)
      ) {
        continue;
      }
      parsed.searchParams.set("modal_id", String(noteId));
      return parsed.toString();
    } catch {
      // Try the next captured search context.
    }
  }
  return "";
}

function resolveRecordDetailNoteId(record) {
  const payload = record?.payload || {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === "object"
      ? payload.items[0]
      : {};
  const urlCandidates = [
    firstItem.url,
    firstItem.noteUrl,
    payload.detailCaptureNoteUrl,
    payload.url,
    payload.noteUrl,
  ];
  const isDouyinRecord =
    resolveRecordPlatform(record) === "douyin" ||
    urlCandidates.some((value) => {
      try {
        const parsed = new URL(String(value || ""));
        return (
          parsed.hostname === "douyin.com" ||
          parsed.hostname.endsWith(".douyin.com")
        );
      } catch {
        return false;
      }
    });
  const candidates = [
    firstItem.noteId,
    payload.noteId,
    firstItem.id,
    payload.id,
    ...urlCandidates.map(extractNoteId),
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || normalized.startsWith("synthetic_")) {
      continue;
    }
    if (isDouyinRecord && !/^\d{8,}$/.test(normalized)) {
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
  const duration = String(
    firstItem.duration ||
      firstItem.videoDuration ||
      payload.duration ||
      payload.videoDuration ||
      "",
  ).trim();
  if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(duration)) {
    return "video";
  }
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

function normalizeDouyinDetailUrlAgainstRecord(record, url) {
  const normalized = String(url || "").trim();
  if (
    resolveRecordPlatform(record) !== "douyin" ||
    resolveRecordDetailNotePath(record) !== "video"
  ) {
    return normalized;
  }

  try {
    const parsed = new URL(normalized);
    const match = parsed.pathname.match(/^\/note\/([^/?#]+)/i);
    if (!match?.[1]) return normalized;
    parsed.pathname = `/video/${match[1]}`;
    return parsed.toString();
  } catch {
    return normalized.replace(
      /^(https?:\/\/(?:www\.)?douyin\.com)\/note\//i,
      "$1/video/",
    );
  }
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
    normalized === "detail_batch_interrupted" ||
    normalized === "blogger_metrics_done" ||
    normalized === "blogger_metrics_failed" ||
    normalized === "batch_done" ||
    normalized === "streaming_sync_done" ||
    normalized === "sync_failed" ||
    normalized === "synced"
  );
}

function isUnattendedTerminalProgressPhase(phase) {
  const normalized = String(phase || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  // Generic done/error/failed events can belong to the current keyword,
  // detail worker or comment step.  Only the final streaming drain and phases
  // explicitly emitted by the unattended root are allowed to close the plan.
  if (normalized === "streaming_sync_done") {
    return true;
  }

  return (
    normalized.startsWith("unattended_") &&
    /(?:completed(?:_with_failures)?|failed|canceled|cancelled|needs_action)$/.test(
      normalized,
    )
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

/* ==================== 批量采集操作执行 ==================== */

let batchProgressCountdownTimer = null;
let batchProgressCountdownToken = 0;

function clearBatchProgressCountdown() {
  batchProgressCountdownToken += 1;
  if (batchProgressCountdownTimer) {
    clearInterval(batchProgressCountdownTimer);
    batchProgressCountdownTimer = null;
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
  if (!visible) {
    clearBatchProgressCountdown();
  }
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
  clearBatchProgressCountdown();

  if (container) {
    container.hidden = false;
  }

  if (fillEl && progress.total > 0) {
    const pct = Math.round((progress.current / progress.total) * 100);
    fillEl.style.width = `${pct}%`;
  }

  if (textEl) {
    const message = String(progress.message || "执行中...");
    const remainingMs = Number(progress.remainingMs);
    const canLocalCountdown =
      Number.isFinite(remainingMs) &&
      remainingMs > 0 &&
      /秒后/.test(message);
    if (!canLocalCountdown) {
      textEl.textContent = message;
      return;
    }

    const token = batchProgressCountdownToken;
    const deadline = Date.now() + remainingMs;
    const render = () => {
      if (token !== batchProgressCountdownToken) {
        return;
      }
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      textEl.textContent = message.replace(/\d+\s*秒后/g, `${seconds} 秒后`);
      if (seconds <= 0) {
        clearBatchProgressCountdown();
      }
    };
    render();
    batchProgressCountdownTimer = setInterval(render, 1000);
  }
}

// Assemble after all original constants/inputs initialize, before either startup
// path can invoke a command. No task is started by controller construction.
const legacyKeywordView = createLegacyKeywordView({
  ports: {
    createClipboardItem: items => new ClipboardItem(items),
    DEFAULT_MONITOR_SETTINGS,
    HTMLElement,
    createImage: () => new Image(),
    KEYWORD_PLAN_CONTROL_IDS,
    KEYWORD_PLAN_MODE_LABELS,
    KEYWORD_PLAN_STATUS_LABELS,
    KEYWORD_PLAN_TERMINAL_STATUSES,
    KEYWORD_SORT_DIMENSION_LABEL,
    MAX_BATCH_KEYWORDS,
    MONITOR_REQUIRED_MESSAGE,
    MONITOR_SUBJECT_TYPE,
    PAGE_TYPE,
    SEARCH_FILTER_FIELD_META,
    SEARCH_FILTER_SCOPE_META,
    chrome,
    clearInterval,
    console,
    document,
    escapeHtml,
    getCurrentRuntime,
    getPagePlatform,
    getPlatformCapabilities,
    getViewPlatform,
    isUnsupportedPlatformCoverVisible,
    navigator,
    renderCaptureDebugSession,
    setInterval,
    setTimeout,
    showMessage,
    window,
  },
  application: Object.freeze({
    selectKeywordStrategyTab: (...args) => sidebarTaskController.selectKeywordStrategyTab(...args),
    openKeywordLongtail: (...args) => sidebarTaskController.openKeywordLongtail(...args),
    renderKeywordPlanStatus: (...args) => sidebarTaskController.renderKeywordPlanStatus(...args),
    handleLegacyMonitorAction: (...args) => sidebarTaskController.handleLegacyMonitorAction(...args),
    monitorLegacyBenchmarkCandidate: (...args) => sidebarTaskController.monitorLegacyBenchmarkCandidate(...args),
    addMonitorSubscriptionByCandidate: (...args) => sidebarTaskController.addMonitorSubscriptionByCandidate(...args),
    buildBenchmarkDiscoveryDecisionAngle: (...args) => sidebarTaskController.buildBenchmarkDiscoveryDecisionAngle(...args),
    buildBenchmarkDiscoveryFallbackAnalysis: (...args) => sidebarTaskController.buildBenchmarkDiscoveryFallbackAnalysis(...args),
    buildBenchmarkDiscoveryRuleReason: (...args) => sidebarTaskController.buildBenchmarkDiscoveryRuleReason(...args),
    buildKeywordRunDisplayPlan: (...args) => sidebarTaskController.buildKeywordRunDisplayPlan(...args),
    dedupeKeywords: (...args) => sidebarTaskController.dedupeKeywords(...args),
    extractPlatformMonitorBloggerId: (...args) => sidebarTaskController.extractPlatformMonitorBloggerId(...args),
    getBatchDraftForPlatform: (...args) => sidebarTaskController.getBatchDraftForPlatform(...args),
    getCurrentSearchKeyword: (...args) => sidebarTaskController.getCurrentSearchKeyword(...args),
    getDateListFromText: (...args) => sidebarTaskController.getDateListFromText(...args),
    getKeywordInsightSeedKeyword: (...args) => sidebarTaskController.getKeywordInsightSeedKeyword(...args),
    getKeywordInsightState: (...args) => sidebarTaskController.getKeywordInsightState(...args),
    getKeywordOpportunityKeyword: (...args) => sidebarTaskController.getKeywordOpportunityKeyword(...args),
    getSearchBatchKeywordsFromTextarea: (...args) => sidebarTaskController.getSearchBatchKeywordsFromTextarea(...args),
    getSearchFilterConfig: (...args) => sidebarTaskController.getSearchFilterConfig(...args),
    getSelectedRecommendedKeywords: (...args) => sidebarTaskController.getSelectedRecommendedKeywords(...args),
    getUnattendedRunRequestIdFromUrl: (...args) => sidebarTaskController.getUnattendedRunRequestIdFromUrl(...args),
    hasVisibleLocalCaptureProgress: (...args) => sidebarTaskController.hasVisibleLocalCaptureProgress(...args),
    isExplicitUserUnattendedCancellationMessage: (...args) => sidebarTaskController.isExplicitUserUnattendedCancellationMessage(...args),
    isKeywordAnalysisLockStale: (...args) => sidebarTaskController.isKeywordAnalysisLockStale(...args),
    isKeywordPlanRunning: (...args) => sidebarTaskController.isKeywordPlanRunning(...args),
    isMonitorAuthReady: (...args) => sidebarTaskController.isMonitorAuthReady(...args),
    normalizeDateListText: (...args) => sidebarTaskController.normalizeDateListText(...args),
    normalizeKeywordPlanMode: (...args) => sidebarTaskController.normalizeKeywordPlanMode(...args),
    normalizeKeywordSortDimension: (...args) => sidebarTaskController.normalizeKeywordSortDimension(...args),
    normalizeMonitorSettingsInput: (...args) => sidebarTaskController.normalizeMonitorSettingsInput(...args),
    normalizeMonitorSubjectType: (...args) => sidebarTaskController.normalizeMonitorSubjectType(...args),
    normalizeSearchFilterPlatform: (...args) => sidebarTaskController.normalizeSearchFilterPlatform(...args),
    normalizeSearchFilterValueForStorage: (...args) => sidebarTaskController.normalizeSearchFilterValueForStorage(...args),
    parseKeywordsFromMultilineInput: (...args) => sidebarTaskController.parseKeywordsFromMultilineInput(...args),
    resetCaptureRecoveryUI: (...args) => sidebarTaskController.resetCaptureRecoveryUI(...args),
    syncSeedKeywordFromCurrentSearch: (...args) => sidebarTaskController.syncSeedKeywordFromCurrentSearch(...args),
  }),
  keywordModel: Object.freeze({
    activeUnattendedRunRequestId: () => sidebarTaskController.readActiveUnattendedRunRequestId(),
    expandedKeywordsBuffer: () => sidebarTaskController.readExpandedKeywordsBuffer(),
    keywordAnalysisInFlight: () => sidebarTaskController.readKeywordAnalysisInFlight(),
    keywordBenchmarkAnalysisStatus: () => sidebarTaskController.readKeywordBenchmarkAnalysisStatus(),
    keywordBenchmarkErrorMessage: () => sidebarTaskController.readKeywordBenchmarkErrorMessage(),
    keywordBenchmarkInFlight: () => sidebarTaskController.readKeywordBenchmarkInFlight(),
    keywordBenchmarkLoadingMeta: () => sidebarTaskController.readKeywordBenchmarkLoadingMeta(),
    keywordBenchmarkLoadingTitle: () => sidebarTaskController.readKeywordBenchmarkLoadingTitle(),
    keywordBenchmarkResult: () => sidebarTaskController.readKeywordBenchmarkResult(),
    keywordExpandCancelRequested: () => sidebarTaskController.readKeywordExpandCancelRequested(),
    keywordExpandInFlight: () => sidebarTaskController.readKeywordExpandInFlight(),
    keywordOpportunityErrorMessage: () => sidebarTaskController.readKeywordOpportunityErrorMessage(),
    keywordOpportunityInFlight: () => sidebarTaskController.readKeywordOpportunityInFlight(),
    keywordOpportunityResult: () => sidebarTaskController.readKeywordOpportunityResult(),
    keywordPlanState: () => sidebarTaskController.readKeywordPlanState(),
    keywordSortDimension: () => sidebarTaskController.readKeywordSortDimension(),
    lastRuntimePageTypeForKeywordSort: () => sidebarTaskController.readLastRuntimePageTypeForKeywordSort(),
    lastRuntimePageUrlForKeywordSort: () => sidebarTaskController.readLastRuntimePageUrlForKeywordSort(),
  }),
});
const {
  addSearchKeywordPlanDateFromPicker,
  applyKeywordSortDimensionToUI,
  buildBenchmarkDiscoveryCandidateEvidence,
  buildBenchmarkDiscoveryRepresentativeWorks,
  buildBenchmarkDiscoveryShareData,
  buildBenchmarkDiscoveryShareText,
  buildInsightShareData,
  buildKeywordOpportunityShareData,
  buildKeywordOpportunityShareText,
  buildKeywordOpportunityTitleCandidates,
  buildKeywordPlanProgressText,
  clearKeywordPlanProgressCountdown,
  collectKeywordPlanFromInputs,
  collectSearchFiltersFromControls,
  forEachKeywordPlanScope,
  formatKeywordPlanRunTime,
  formatOpportunityMetric,
  getBatchKeywordsFromTextarea,
  getKeywordExecutionCopy,
  getKeywordPlanControl,
  getKeywordSortDimensionLabel,
  getMonitorSettingsElements,
  getMonitorSubjectLabel,
  getMonitorSubjectType,
  getSearchFilterSelectValue,
  handleBenchmarkDiscoveryResultActions,
  handleCopyBenchmarkDiscovery,
  handleCopyInsight,
  handleCopyKeywordOpportunity,
  handleKeywordInsightCategoryActions,
  handleKeywordInsightSummaryActions,
  handleKeywordOpportunityResultActions,
  handleOpenKeywordLongtail,
  handleMonitorListClick,
  handleSearchKeywordPlanDateChipClick,
  handleShareAsImage,
  handleShareBenchmarkDiscoveryAsImage,
  handleShareKeywordOpportunityAsImage,
  hideKeywordPlanProgressPanelIfOwned,
  normalizeKeywordOpportunityTitleForMatch,
  normalizeKeywordPlanScope,
  populateMonitorSettingsForm,
  populateSearchFilterControlsFromFilters,
  readMonitorSettingsForm,
  readNonNegativeNumberInput,
  readPositiveNumberInput,
  renderBenchmarkDiscoveryCardToImage,
  renderBenchmarkDiscoveryResult,
  renderExpandedKeywords,
  renderInsightCardToImage,
  renderInsightCategories,
  renderInsightLoadingState,
  renderInsightSampleBlock,
  renderInsightSummaryCard,
  renderKeywordInsightState,
  renderKeywordOpportunityCardToImage,
  renderKeywordOpportunityResult,
  renderKeywordPlanProgressText,
  renderKeywordStrategyLoadingState,
  renderKeywordStrategyPanel,
  renderSearchFilterSelectOptions,
  renderSearchKeywordPlanDateChips,
  resolveKeywordOpportunityTitleUrl,
  resolveMonitorDisplayName,
  roundRect,
  roundRectTop,
  setKeywordStrategyTab,
  setMonitorSubjectType,
  setSearchExecutionMode,
  setSearchKeywordPlanDateList,
  showInsightImagePreview,
  syncKeywordPlanDateFields,
  syncSearchFilterControlsForPlatform,
  toggleExpandedKeywordsVisibility,
  toggleKeywordStrategyPanel,
  unattendedSearchPassLabel,
  updateExpandKeywordsButtonState,
  updateExpandedKeywordsSummary,
} = legacyKeywordView;
const legacyTaskViewCapabilities = Object.freeze({
  ...legacyKeywordView,
  ...createLegacyCaptureInputsView({document, window, updateBatchKeywordInputState}),
  ...createLegacyKeywordInputsView({document}),
  ...createLegacyProgressVisibilityView({document, clearKeywordPlanProgressCountdown, setCaptureButtonsDisabled}),
  ...createLegacyCaptureProgressView({
    document, buildCaptureRecoveryAnnouncementKey, getKeywordSortDimensionLabel,
    normalizeKeywordSortDimension: (...args) => sidebarTaskController.normalizeKeywordSortDimension(...args),
    ERROR_MESSAGE_MAP, showMessage,
  }),
  isUnsupportedPlatformCoverVisible,
});
// Only semantic task capabilities cross this boundary. Node-returning legacy
// helpers remain host/view-only, and are not new-UI authorization capabilities.
const taskView = Object.freeze({
  clearKeywordPlanCountdownForCaptureProgress: legacyTaskViewCapabilities.clearKeywordPlanCountdownForCaptureProgress,
  showCaptureProgressPresentation: legacyTaskViewCapabilities.showCaptureProgressPresentation,
  hideCaptureProgressPresentation: legacyTaskViewCapabilities.hideCaptureProgressPresentation,
  applyKeywordSortDimensionToUI: legacyTaskViewCapabilities.applyKeywordSortDimensionToUI,
  applyUnattendedKeywords: legacyTaskViewCapabilities.applyUnattendedKeywords,
  applyUnattendedLoopSettings: legacyTaskViewCapabilities.applyUnattendedLoopSettings,
  beginUnattendedCancelPresentation: legacyTaskViewCapabilities.beginUnattendedCancelPresentation,
  buildCaptureProgressText: legacyTaskViewCapabilities.buildCaptureProgressText,
  collectKeywordPlanFromInputs: legacyTaskViewCapabilities.collectKeywordPlanFromInputs,
  confirmMonitorRemoval: legacyTaskViewCapabilities.confirmMonitorRemoval,
  getMonitorSubjectLabel: legacyTaskViewCapabilities.getMonitorSubjectLabel,
  getMonitorSubjectType: legacyTaskViewCapabilities.getMonitorSubjectType,
  hideKeywordPlanProgressPanelIfOwned: legacyTaskViewCapabilities.hideKeywordPlanProgressPanelIfOwned,
  isUnsupportedPlatformCoverVisible: legacyTaskViewCapabilities.isUnsupportedPlatformCoverVisible,
  normalizeProgressCount: legacyTaskViewCapabilities.normalizeProgressCount,
  openBatchDraftInputs: legacyTaskViewCapabilities.openBatchDraftInputs,
  openCaptureProgressPresentation: legacyTaskViewCapabilities.openCaptureProgressPresentation,
  openCaptureRecoveryPresentation: legacyTaskViewCapabilities.openCaptureRecoveryPresentation,
  openKeywordPlanProgress: legacyTaskViewCapabilities.openKeywordPlanProgress,
  openUrlBatchControls: legacyTaskViewCapabilities.openUrlBatchControls,
  populateKeywordPlanKeywords: legacyTaskViewCapabilities.populateKeywordPlanKeywords,
  populateKeywordPlanSchedule: legacyTaskViewCapabilities.populateKeywordPlanSchedule,
  populateMonitorSettingsForm: legacyTaskViewCapabilities.populateMonitorSettingsForm,
  readBatchLoopGapMinutesInput: legacyTaskViewCapabilities.readBatchLoopGapMinutesInput,
  readBatchLoopRoundsInput: legacyTaskViewCapabilities.readBatchLoopRoundsInput,
  readBatchScheduledStart: legacyTaskViewCapabilities.readBatchScheduledStart,
  readCaptureCancelingMessage: legacyTaskViewCapabilities.readCaptureCancelingMessage,
  readExpandedKeywordsInput: legacyTaskViewCapabilities.readExpandedKeywordsInput,
  readMonitorSelectedPlatform: legacyTaskViewCapabilities.readMonitorSelectedPlatform,
  readMonitorSettingsForm: legacyTaskViewCapabilities.readMonitorSettingsForm,
  readRunnerLocationSearch: legacyTaskViewCapabilities.readRunnerLocationSearch,
  readSearchBatchKeywordsText: legacyTaskViewCapabilities.readSearchBatchKeywordsText,
  readSearchBatchMode: legacyTaskViewCapabilities.readSearchBatchMode,
  readSearchScheduledStart: legacyTaskViewCapabilities.readSearchScheduledStart,
  renderExpandedKeywords: legacyTaskViewCapabilities.renderExpandedKeywords,
  renderKeywordInsightState: legacyTaskViewCapabilities.renderKeywordInsightState,
  renderKeywordPlanStatusLabels: legacyTaskViewCapabilities.renderKeywordPlanStatusLabels,
  renderKeywordStrategyPanel: legacyTaskViewCapabilities.renderKeywordStrategyPanel,
  resetCaptureRecoveryPresentation: legacyTaskViewCapabilities.resetCaptureRecoveryPresentation,
  setExpandedKeywordsVisible: legacyTaskViewCapabilities.setExpandedKeywordsVisible,
  setStrategyActiveTab: legacyTaskViewCapabilities.setStrategyActiveTab,
  setStrategyPanelVisible: legacyTaskViewCapabilities.setStrategyPanelVisible,
  showBatchKeywordIdle: legacyTaskViewCapabilities.showBatchKeywordIdle,
  showBatchKeywordRunning: legacyTaskViewCapabilities.showBatchKeywordRunning,
  showBatchKeywordStopping: legacyTaskViewCapabilities.showBatchKeywordStopping,
  showCaptureActionError: legacyTaskViewCapabilities.showCaptureActionError,
  showCaptureActionException: legacyTaskViewCapabilities.showCaptureActionException,
  showCaptureCancelPending: legacyTaskViewCapabilities.showCaptureCancelPending,
  showCaptureCancelSignalFailure: legacyTaskViewCapabilities.showCaptureCancelSignalFailure,
  showCaptureSuccess: legacyTaskViewCapabilities.showCaptureSuccess,
  showEmptyCaptureResult: legacyTaskViewCapabilities.showEmptyCaptureResult,
  showMissingRecoveryRecordNotice: legacyTaskViewCapabilities.showMissingRecoveryRecordNotice,
  showPersistentCaptureReleaseWarning: legacyTaskViewCapabilities.showPersistentCaptureReleaseWarning,
  syncKeywordPlanDateFields: legacyTaskViewCapabilities.syncKeywordPlanDateFields,
  updateExpandKeywordsButtonState: legacyTaskViewCapabilities.updateExpandKeywordsButtonState,
});
const sidebarTaskController = createSidebarTaskController({
  ACTIVE_COMMENT_PROGRESS_PHASES,
  AUTH_STATUS,
  BATCH_DRAFT_LEGACY_KEYS,
  BATCH_DRAFT_PLATFORMS,
  BATCH_DRAFT_SESSION_KEY,
  BENCHMARK_DISCOVERY_PROFILE_LIMIT,
  BENCHMARK_DISCOVERY_RESULT_LIMIT,
  CAPTURE_EXECUTION_LOCK_HEARTBEAT_INTERVAL_MS,
  CAPTURE_EXECUTION_LOCK_HOLDER_ID,
  CAPTURE_RECOVERY_PHASES,
  CAPTURE_RECOVERY_UI_STALE_MS,
  CAPTURE_TASK_OWNER_PORT_NAME,
  COMMENT_PHASE_TO_TERMINAL_STATUS,
  DEFAULT_CAPTURE_SETTINGS,
  DEFAULT_MONITOR_SETTINGS,
  DETAIL_CAPTURE_SCOPE_ALL,
  DETAIL_ITEM_SETTLED_PHASES,
  ERROR_MESSAGE_MAP,
  ERROR_REASON,
  KEYWORD_ANALYSIS_STALE_LOCK_MS,
  KEYWORD_INSIGHT_ANALYSIS_COST_CREDITS,
  KEYWORD_OPPORTUNITY_ANALYSIS_COST_CREDITS,
  KEYWORD_PLAN_MODES,
  KEYWORD_PLAN_RECONCILE_INTERVAL_MS,
  KEYWORD_PLAN_STORAGE_KEY,
  KEYWORD_PLAN_TERMINAL_STATUSES,
  KEYWORD_RUN_REQUEST_STORAGE_KEY,
  KEYWORD_SORT_DIMENSION,
  KEYWORD_SORT_SYNC_INTERVAL_MS,
  MAX_BATCH_KEYWORDS,
  MAX_SYNC_RECORDS_PER_BATCH,
  MESSAGE_TYPE,
  MONITOR_DAY_MS,
  MONITOR_DETAIL_DATE_DISCOVERY_MAX,
  MONITOR_DETAIL_DATE_DISCOVERY_MIN,
  MONITOR_DETAIL_DATE_DISCOVERY_MULTIPLIER,
  MONITOR_LATEST_POSTS_LIMIT_MAX,
  MONITOR_OBSERVE_WINDOW_OPTIONS,
  MONITOR_PUBLISH_WINDOW,
  MONITOR_PUBLISH_WINDOW_OPTIONS,
  MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW,
  MONITOR_REQUIRED_MESSAGE,
  MONITOR_RUN_TIME_OPTIONS,
  MONITOR_SHANGHAI_OFFSET_MS,
  MONITOR_STATUS,
  MONITOR_SUBJECT_TYPE,
  OPTIONAL_CAPTURE_ASSIST_SESSION_CODES,
  PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
  PAGE_TYPE,
  PLATFORM_SEARCH_FILTER_OPTIONS,
  SEARCH_FILTER_FIELD_META,
  SYNC_BATCH_LIMIT_MESSAGE,
  SYNC_SCOPE_ALL,
  SYNC_SCOPE_PENDING,
  SYNC_TYPE,
  TARGETED_POST_RUN_ATTEMPT_QUERY_KEY,
  TARGETED_POST_RUN_HEARTBEAT_INTERVAL_MS,
  TARGETED_POST_RUN_QUERY_KEY,
  TARGETED_POST_RUN_REQUEST_STORAGE_KEY,
  UNATTENDED_BOOTSTRAP_GATE_MAX_WAIT_MS,
  UNATTENDED_CAPTURE_SESSION_MAX_ATTEMPTS,
  UNATTENDED_CAPTURE_SESSION_RETRYABLE_CODES,
  UNATTENDED_CAPTURE_SESSION_RETRY_DELAYS_MS,
  UNATTENDED_CONTENT_PROGRESS_MIN_INTERVAL_MS,
  UNATTENDED_ELASTIC_RELEASE_MIN_DELAY_MS,
  UNATTENDED_FINAL_FLUSH_INTENT_STORAGE_PREFIX,
  UNATTENDED_FINAL_FLUSH_INTENT_VERSION,
  UNATTENDED_FINAL_FLUSH_RETRY_DELAYS_MS,
  UNATTENDED_FINAL_FLUSH_RETRY_DELAY_MS,
  UNATTENDED_INITIAL_REPORT_RETRY_DELAYS_MS,
  UNATTENDED_KEYWORD_MAX_ATTEMPTS,
  UNATTENDED_KEYWORD_RETRY_DELAYS_MS,
  UNATTENDED_KEYWORD_RETRY_MAX_MS,
  UNATTENDED_KEYWORD_RETRY_MIN_MS,
  UNATTENDED_LOCAL_CLOSURE_READY_STORAGE_PREFIX,
  UNATTENDED_LOCAL_CLOSURE_READY_VERSION,
  UNATTENDED_PROTECTED_WAIT_TICK_MS,
  UNATTENDED_RUNTIME_MESSAGE_TIMEOUT_MS,
  UNATTENDED_RUN_ATTEMPT_QUERY_KEY,
  UNATTENDED_RUN_HEARTBEAT_INTERVAL_MS,
  UNATTENDED_RUN_QUERY_KEY,
  UNATTENDED_SEARCH_BOOTSTRAP_MAX_ATTEMPTS,
  UNATTENDED_SEARCH_BOOTSTRAP_RETRY_DELAYS_MS,
  UNATTENDED_TERMINAL_CONFIRM_RETRY_MAX_MS,
  UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS,
  addSyncHistoryEntry,
  advanceUnattendedCheckpointRound,
  analyzeBenchmarkDiscovery,
  analyzeKeywordOpportunity,
  analyzeKeywords,
  batchCaptureByKeywords,
  batchCaptureByUrls,
  batchCaptureDetailsForRecords,
  beginCaptureTaskSession,
  beginDouyinSearchResultTransitionInTab,
  beginTaskContext,
  buildCaptureRecoveryAnnouncementKey,
  buildCommentLeadsConfigFromSettings,
  buildDetailCaptureBlockerMessage,
  buildDetailCaptureFailureSummaryText,
  buildDetailCaptureSyncWarningMessage,
  buildStreamingSyncCompletionNotice,
  buildStreamingSyncTaskIssue,
  buildStreamingSyncTaskMetadata,
  buildSyncReconciliationError,
  captureAndSync,
  captureNoteWithOptionalComments,
  captureTabContent,
  checkBeforeSync,
  chrome,
  clearInterval,
  clearTimeout,
  closeBatchModal,
  cloudTargetedPostApi,
  collectBatchRecordIds,
  completeTaskContext,
  confirm,
  console,
  createMonitorSubscription,
  createRecordSyncQueue,
  detectPlatformFromUrl,
  discardUnattendedCheckpointReports,
  endCaptureTaskSession,
  enqueueUnattendedCheckpointReport,
  ensureAuthVerifiedOrWarn,
  ensureControlStorageReserve,
  extractKeywordFromUrl,
  findUnattendedResumeKeyword,
  finishMonitorExecution,
  flushUnattendedCheckpointReportOutbox,
  formatKeywordStrategyAccessError,
  formatStreamingSyncSummary,
  getActiveTaskContext,
  getAuthRequiredMessage,
  getBatchRetryDetailRecordIds,
  getBenchmarkDiscoveryAuthRequiredMessage,
  getCaptureBloggerMetricsChecked,
  getCaptureCommentsChecked,
  getCaptureSettings,
  getCommentLeadsFilterChecked,
  getCurrentAuth,
  getCurrentDataPool,
  getCurrentMonitor,
  getCurrentPageRecords,
  getCurrentRuntime,
  getCurrentTarget,
  getDetailCaptureTargetRecords,
  getKeywordInsightAuthRequiredMessage,
  getKeywordOpportunityAuthRequiredMessage,
  getMonitorSettings,
  getPagePlatform,
  getPlatformCapabilities,
  getPlatformCopy,
  getRecordPrimaryNoteUrl,
  getRecords,
  getTargetedWorkflowLabel,
  getViewPlatform,
  hasSyncReconciliationSignal,
  hideProgress,
  hideProgressPanelOnly: (...args) => sidebarTaskController.hideProgressPanelOnly(...args),
  isAuthVerified,
  isDetailCaptureDone,
  isDetailCaptureRecord,
  isNoteDetailPending,
  isStorageQuotaError,
  isStreamingSyncReconciliationRequired,
  isTargetedProfileDiscoveryWorkflow,
  isTerminalProgressPhase,
  isUnattendedSafetyBlock,
  isUnattendedTerminalProgressPhase,
  isUnsupportedPlatformCoverVisible,
  lightSampleByKeywords,
  listMonitorExecutions,
  listMonitorSubscriptions,
  loadStorageModule: () => import("../utils/storage.js"),
  normalizeUnattendedKeywordCheckpoint,
  readBloggerKeywordFilterFromInput,
  readBloggerMaxDetectedItemsFromInput,
  readBloggerMinLikesFromInput,
  readCommentsMaxDetectedItemsFromInput,
  readDetailCaptureScopeFromInput,
  readDouyinSearchDocumentGenerationInTab,
  readKeywordMaxDetectedItemsFromInput,
  readKeywordMinLikesFromInput,
  readRequiredCommentsMaxDetectedItemsFromInput,
  readSyncScopeFromInput,
  recordDiagnosticAction,
  recordDiagnosticError,
  recordDiagnosticTask,
  refreshDataPool,
  refreshSyncHistory,
  refreshVerifiedAuthSnapshot,
  releaseControlStorageReserve,
  renderCaptureDebugSession,
  repairInterruptedCommentPayload,
  repairInterruptedDetailCaptureRecords,
  resetCurrentMonitor,
  resolveCaptureRecoveryView,
  resolveCompletedCheckpointKeywords,
  resolveCurrentDetailCaptureSettings,
  resolveNoteBatchCaptureSettings,
  resolveNoteDetailPendingText,
  resolveRecordPlatform,
  resolveSyncInputForRecord,
  resolveTaskCaptureSettingsOverrides,
  resolveTaskKeywordMaxDetectedItems,
  retryCommentsForRecord,
  runEnhancementWithSingleRetry,
  runMonitorNow,
  runUnattendedKeywordAttempts,
  saveMonitorSettings,
  setBatchProgressDetail,
  setBatchProgressVisible,
  setCancelFlag,
  setCurrentMonitor,
  setInterval,
  setTimeout,
  settleUnattendedKeywordCheckpoint,
  shouldHideNoteBloggerMetricsToggle,
  showMessage,
  showProgress: (...args) => sidebarTaskController.showProgress(...args),
  sleep,
  startMonitorExecution,
  summarizeDetailCaptureBlockers,
  summarizeUnattendedKeywordCheckpoint,
  syncDetailCaptureControlsFromStoredSettings,
  syncRecordBatch,
  updateBatchKeywordInputState,
  updateBatchProgress,
  updateCaptureTaskSession,
  updateDataPoolUI,
  updateMonitorSubscription,
  updatePageTypeUI,
  wait,
  buildKeywordRunDisplayPlan: (...args) => sidebarTaskController.buildKeywordRunDisplayPlan(...args),
  isExplicitUserUnattendedCancellationMessage: (...args) => sidebarTaskController.isExplicitUserUnattendedCancellationMessage(...args),
  isMonitorAuthReady: (...args) => sidebarTaskController.isMonitorAuthReady(...args),
  isMonitorPublishMomentInWindow: (...args) => sidebarTaskController.isMonitorPublishMomentInWindow(...args),
  loadActiveKeywordRunState: (...args) => sidebarTaskController.loadActiveKeywordRunState(...args),
  loadKeywordPlanUI: (...args) => sidebarTaskController.loadKeywordPlanUI(...args),
  loadMonitorSubscriptions: (...args) => sidebarTaskController.loadMonitorSubscriptions(...args),
  normalizeKeywordSortDimension: (...args) => sidebarTaskController.normalizeKeywordSortDimension(...args),
  normalizeMonitorRunnerPlatform: (...args) => sidebarTaskController.normalizeMonitorRunnerPlatform(...args),
  normalizeMonitorSettingsInput: (...args) => sidebarTaskController.normalizeMonitorSettingsInput(...args),
  normalizeMonitorSubjectType: (...args) => sidebarTaskController.normalizeMonitorSubjectType(...args),
  normalizeUnattendedSearchPasses: (...args) => sidebarTaskController.normalizeUnattendedSearchPasses(...args),
  parseSearchManualScheduledStart: (...args) => sidebarTaskController.parseSearchManualScheduledStart(...args),
  persistCurrentBatchDraft: (...args) => sidebarTaskController.persistCurrentBatchDraft(...args),
  resolveMonitorPublishWindowBounds: (...args) => sidebarTaskController.resolveMonitorPublishWindowBounds(...args),
  resolveMonitorRecordPublishMoment: (...args) => sidebarTaskController.resolveMonitorRecordPublishMoment(...args),
  resolveMonitorRunHistoryState: (...args) => sidebarTaskController.resolveMonitorRunHistoryState(...args),
  resolveMonitorRunnerAccountUrl: (...args) => sidebarTaskController.resolveMonitorRunnerAccountUrl(...args),
  resolveMonitorRunnerCaptureParams: (...args) => sidebarTaskController.resolveMonitorRunnerCaptureParams(...args),
  resolveMonitorRunnerName: (...args) => sidebarTaskController.resolveMonitorRunnerName(...args),
  summarizeMonitorSyncResult: (...args) => sidebarTaskController.summarizeMonitorSyncResult(...args),
  syncKeywordSortDimensionFromPage: (...args) => sidebarTaskController.syncKeywordSortDimensionFromPage(...args),
  clearKeywordPlanProgressCountdown,
  collectSearchFiltersFromControls,
  getBatchKeywordsFromTextarea,
  getKeywordExecutionCopy,
  getKeywordSortDimensionLabel,
  syncSearchFilterControlsForPlatform,
  unattendedSearchPassLabel,
  taskView,
});
const {
  acquireCaptureExecutionLock,
  activateTargetedPostInvocation,
  activateUnattendedRunRequest,
  addMonitorSubscriptionByCandidate,
  adoptUnattendedCaptureExecutionLock,
  analyzeKeywordOpportunityRules,
  appendStreamingSyncSummary,
  applyBatchDraftToInputs,
  applyCaptureTaskCancellation,
  applySearchFiltersOnActiveTab,
  averageBenchmarkValues,
  beginSidebarTask,
  bindCaptureTaskOwner,
  buildBenchmarkDiscoveryAiCandidates,
  buildBenchmarkDiscoveryCandidates,
  buildBenchmarkDiscoveryDecisionAngle,
  buildBenchmarkDiscoveryFallbackAnalysis,
  buildBenchmarkDiscoveryFocusAssessment,
  buildBenchmarkDiscoveryRuleReason,
  buildCaptureProgressText,
  buildCaptureRecoverySuppressionKey,
  buildKeywordOpportunityInputItems,
  buildKeywordRunDisplayPlan,
  buildMonitorCandidateFromRecord,
  buildMonitorSubjectCandidate,
  buildShanghaiTimestamp,
  buildSidebarKeywordSearchUrl,
  buildSidebarTaskRun,
  buildTargetedProfileCaptureTaskContext,
  buildUnattendedFinalFlushIntentStorageKey,
  buildUnattendedLocalClosureReadyStorageKey,
  buildUnattendedTaskCounts,
  buildUnattendedTerminalProgress,
  calculateBenchmarkEngagement,
  cancelTargetedPostRunFromSidebar,
  cancelUnattendedKeywordPlanFromSidebar,
  captureBenchmarkCandidateProfiles,
  captureCurrentMonitorCandidate,
  captureKeywordOpportunitySamples,
  cleanMonitorPublishText,
  clearActiveUnattendedRunRequest,
  clearBenchmarkDiscoveryResult,
  clearBenchmarkDiscoveryState,
  clearCaptureTaskProgressContext,
  clearCommentCaptureTerminalStatus,
  clearKeywordInsightResult,
  clearKeywordOpportunityDraft,
  clearKeywordOpportunityResult,
  clearKeywordOpportunityState,
  clearSuppressedCaptureRecoveryForRecord,
  clearUnattendedFinalFlushRetryTimer,
  collectMonitorPublishCandidates,
  collectTargetedPostRecordIds,
  confirmTargetedPostInvocationBinding,
  connectCaptureTaskOwnerPort,
  createEmptyBatchDraft,
  createEmptyKeywordInsightState,
  createEmptyKeywordOpportunityDraft,
  createMonitorPublishMoment,
  createStreamingDetailAutoSyncQueue,
  createTargetedPostInvocationError,
  createTargetedPostInvocationToken,
  createUnattendedKeywordCheckpointReporter,
  createUnattendedKeywordProgressReporter,
  dedupeKeywords,
  detectKeywordSortDimensionFromActiveTab,
  drainStreamingDetailSyncQueue,
  enrichBenchmarkDiscoveryWithAi,
  ensureUnattendedFinalFlushIntent,
  executeMonitorRunItem,
  extractPlatformMonitorBloggerId,
  finalizeInterruptedDetailCaptureAfterCancel,
  finalizeUnattendedLocalClosureAfterFlush,
  finishMonitorExecutionSafely,
  finishSidebarTask,
  flushPendingUnattendedCheckpointReports,
  getBatchDraftForPlatform,
  getCurrentBatchDraftPlatform,
  getCurrentSearchKeyword,
  getDateListFromText,
  getExpandedKeywordsFromTextarea,
  getKeywordInsightSeedKeyword,
  getKeywordInsightState,
  getKeywordOpportunityDraft,
  getKeywordOpportunityKeyword,
  getKnownDetailRunnerTabIds,
  getSearchBatchKeywordsFromTextarea,
  getSearchFilterConfig,
  getSelectedRecommendedKeywords,
  getShanghaiDateParts,
  getShanghaiDayStartMs,
  getStoredKeywordInsightSeedKeyword,
  getTargetedPostInvocationOwnership,
  getTargetedPostInvocationTokenFromRequest,
  getTargetedPostRunAttemptIdFromUrl,
  getTargetedPostRunRequestIdFromUrl,
  getUnattendedRunAttemptIdFromUrl,
  getUnattendedRunRequestIdFromUrl,
  handleAddCurrentMonitor,
  handleAddMonitorFromRecord,
  handleBatchKeywordCapture,
  handleCancel,
  handleCancelBenchmarkDiscovery,
  handleCancelKeywordOpportunity,
  handleCaptureBloggerData,
  handleCaptureExecutionLockLost,
  handleCaptureNoteData,
  handleCaptureSearchData,
  handleDismissRecovery,
  handleExpandKeywords,
  handleProgress,
  handleRetryCommentsCapture,
  handleRetryDetailCapture,
  handleRetryRecovery,
  handleRunBatchBloggers,
  handleRunBatchLinks,
  handleRunBenchmarkDiscovery,
  handleRunKeywordOpportunity,
  handleRunMonitorNow,
  handleSaveKeywordPlan,
  showProgress,
  hideProgressPanelOnly,
  syncKeywordPlanProgressPanel,
  renderKeywordPlanStatus,
  handleSaveMonitorSettings,
  handleStopCommentsCapture,
  handleSyncAll,
  handleTargetedPostRunRequestStorageChange,
  handleUnattendedRunRequestStorageChange,
  hasActiveSearchFilters,
  hasVisibleLocalCaptureProgress,
  invalidateKeywordInsightDraft,
  isActiveTargetedPostInvocation,
  isCaptureRecoveryPhase,
  isCaptureTaskDetailPhase,
  isCaptureTaskSyncPhase,
  isCaptureTaskWaitPhase,
  isCommentCaptureTerminal,
  isDefaultSearchFilterValue,
  isExplicitUserUnattendedCancellationMessage,
  isKeywordAnalysisLockStale,
  isKeywordPlanRunning,
  isLikelyFallbackCaptureTime,
  isMonitorAuthReady,
  isMonitorPublishMomentInWindow,
  isSameTargetedPostInvocationToken,
  isTransientStreamingSyncFailure,
  loadActiveKeywordRunState,
  loadBatchDraftStore,
  loadExecutionDetails,
  loadKeywordPlanUI,
  loadMonitorExecutions,
  loadMonitorSettings,
  loadMonitorSubscriptions,
  loadTargetedPostRunStateForDisplay,
  markCommentCaptureTerminalStatus,
  maybeClaimAndRunTargetedPostWorkflow,
  maybeClaimAndRunUnattendedKeywordPlan,
  maybeResetKeywordOpportunityForCurrentSearch,
  maybeRunAutoDetailCaptureAfterListCapture,
  maybeRunAutoSyncAfterDetailCapture,
  mergeBenchmarkAiAnalysisIntoResult,
  mergeBenchmarkProfilesIntoResult,
  navigateActiveTabToKeywordSearchForPlan,
  normalizeBatchDraftEntry,
  normalizeBatchDraftPlatform,
  normalizeBatchDraftStore,
  normalizeBenchmarkDiscoveryItems,
  normalizeBenchmarkProfilePayload,
  normalizeCalendarDate,
  normalizeDateListText,
  normalizeKeywordOpportunityDraft,
  normalizeKeywordOpportunitySampleItems,
  normalizeKeywordPlanMode,
  normalizeKeywordSortDimension,
  normalizeMonitorRunnerPlatform,
  normalizeMonitorSettingsInput,
  normalizeMonitorSubjectType,
  normalizeProgressCount,
  normalizeRepresentativeSampleItems,
  normalizeSearchFilterPlatform,
  normalizeSearchFilterValueForStorage,
  normalizeTaskCenterStatus,
  normalizeUnattendedSearchPasses,
  parseKeywordsFromMultilineInput,
  parseMonitorCalendarDateStartMs,
  parseMonitorNumericPublishMoment,
  parseMonitorPublishMoment,
  parseSearchManualScheduledStart,
  persistBatchDraftForPlatform,
  persistBatchDraftStore,
  persistCurrentBatchDraft,
  persistUnattendedLocalClosureReadyMarker,
  populateKeywordPlanUI,
  postCaptureTaskOwnerMessage,
  prepareKeywordStrategyCapture,
  prioritizeRecordsForSync,
  projectCaptureTaskProgress,
  publishCommentProgressToRuntime,
  readFiniteProgressNumber,
  readProgressText,
  rebuildCaptureTaskSessionForEnhancementRetry,
  reconcileCommentCaptureTerminalState,
  reconcileKeywordPlanFromSidebar,
  reconcilePendingUnattendedFinalFlushIntents,
  recordUnattendedFinalFlushFailure,
  refreshDataPoolThrottled,
  releaseCaptureExecutionLock,
  releaseCaptureTaskOwner,
  releaseKeywordAnalysisLock,
  rememberCaptureTaskProgressContext,
  renderActiveKeywordRunState,
  renderCaptureRecoveryUI,
  renewCaptureExecutionLock,
  repairInterruptedDetailCaptureRecordsBeforeSync,
  repairStaleCommentCaptureCard,
  reportActiveSidebarTaskProgress,
  reportActiveUnattendedContentProgress,
  reportInitialUnattendedKeywordRun,
  reportMonitorRunProgress,
  reportSidebarTaskRun,
  reportUnattendedKeywordRun,
  reportUnattendedProtectedWaitState,
  reportUnattendedTerminalRun,
  requestCaptureCancelSignal,
  requestDetailRunnerCancelSignals,
  requestKeywordExpandCancel,
  resetCaptureRecoveryUI,
  resolveBatchDraftPlatform,
  resolveCaptureExecutionLockRunnerTabId,
  resolveCaptureTaskSourceTabId,
  resolveCaptureTaskTerminalStatus,
  resolveCommentTerminalStatusFromPhase,
  resolveMonitorAccountNo,
  resolveMonitorPublishWindowBounds,
  resolveMonitorRecordIdsForPublishWindow,
  resolveMonitorRecordPublishMoment,
  resolveMonitorRunHistoryState,
  resolveMonitorRunnerAccountUrl,
  resolveMonitorRunnerCaptureParams,
  resolveMonitorRunnerName,
  resolveMonitorSettingsSaveErrorMessage,
  resolveTargetedPostRunBinding,
  resolveTaskCenterTitle,
  resolveUnattendedBootstrapStartGate,
  resolveUnattendedCancellationTerminal,
  resolveUnattendedEnhanceCancellation,
  resolveUnattendedProtectedWaitUntilMs,
  resolveYearForMonthDay,
  retryKeywordAnalysis,
  routeDetailItemToStreamingSync,
  runCaptureAction,
  runDetailCaptureForRecordIds,
  runKeywordInsightSampling,
  runMonitorCommentPatrolWithCaptureTaskSession,
  runUnattendedKeywordPlanRequest,
  scheduleUnattendedFinalFlushRetry,
  selectKeywordOpportunitySamples,
  sendUnattendedRuntimeMessage,
  setKeywordBenchmarkLoading,
  setUnattendedLocalClosureControlState,
  settleKeywordRecordsForStreamingSync,
  settleTargetedPostRunnerTab,
  setupKeywordPlanStorageListener,
  shouldRefreshDataPoolForKeywordPlan,
  sleepWithStop,
  startCaptureAssistSessionStrict,
  startCaptureExecutionLockHeartbeat,
  startKeywordAnalysis,
  startKeywordPlanReconcileTimer,
  startKeywordSortSyncTimer,
  startOptionalCaptureAssistSession,
  startTargetedPostRunHeartbeat,
  startUnattendedKeywordRunHeartbeat,
  stopCaptureExecutionLockHeartbeat,
  stopDetailCaptureAndReleaseForSync,
  stopKeywordPlanReconcileTimer,
  stopKeywordSortSyncTimer,
  stopRejectedUnattendedAttempt,
  stopTargetedPostRunnerForInvalidBinding,
  summarizeMonitorSyncResult,
  supportsPersistentCaptureTaskPlatform,
  syncBatchDraftForPlatform,
  syncCaptureTaskOwnerFromRuntime,
  syncCommentProgressToRecord,
  syncKeywordSortDimensionByRuntime,
  syncKeywordSortDimensionFromPage,
  syncRuntimeCaptureProgress,
  syncRuntimeCommentProgress,
  syncSeedKeywordFromCurrentSearch,
  unattendedFinalFlushIdentity,
  updateActiveCommentCaptureIdentity,
  updateCategorySampleResult,
  updateKeywordInsightState,
  updateKeywordOpportunityDraft,
  updateTargetedPostRun,
  validateAdoptedUnattendedCaptureExecutionLock,
  waitForActiveTabReady,
  waitForRuntimeSearchPage,
  waitForTabComplete,
  waitForTargetedPostRunnerTab,
  waitForUnattendedProtectedStart,
} = sidebarTaskController;

// Keep exactly the original bootstrap and listener registration order.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSidebar);
} else {
  initSidebar();
}

window.addEventListener("beforeunload", () => {
  sidebarTaskController.shutdownCaptureTaskOwner();
  stopKeywordSortSyncTimer();
  stopKeywordPlanReconcileTimer();
  stopCaptureExecutionLockHeartbeat();
});

window.addEventListener("pagehide", () => {
  stopCaptureExecutionLockHeartbeat();
});
