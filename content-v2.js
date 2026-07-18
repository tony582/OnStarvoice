/**
 * StarVoice V1.0 Content Script
 * 在小红书/抖音页面上运行的内容脚本
 *
 * 职责：
 * 1. 监听来自 sidebar/background 的消息
 * 2. 调用新的采集模块
 * 3. 返回采集结果
 */

import {
  smartCapture,
  captureSingleNote,
  captureBloggerProfile,
  captureBloggerNotes,
  captureKeywordNotes,
  detectKeywordSortDimension,
  captureComments,
} from "./utils/capture/index.js";

import {expandKeywordViaSuggestions} from "./utils/capture/keyword-expansion.js";

import {detectPageType, detectPlatformFromUrl} from "./utils/helpers.js";
import {setCancelFlag, resetCancelFlag} from "./utils/scroll.js";
import {normalizeTaskContext} from "./utils/task-context.js";
import {buildContentDiagnostics} from "./utils/diagnostics.js";
import {startContentPageStateReporting} from "./utils/content-page-state.js";
import {
  createListCaptureOverlayRunScope,
  getListCaptureDebugOverlay,
} from "./utils/capture/list-capture-debug-overlay.js";
import {
  createListCaptureAcceptanceLedger,
  decorateListCheckpointProgress,
} from "./utils/capture/list-capture-trace.js";

console.log("[StarVoice V1.0] Content script loaded");

let activeCommentsCaptureRequestId = "";
const activeCaptureRequestIds = new Set();
let listCaptureInvocationSequence = 0;
let activeListCaptureDebugOverlay = null;
const pendingListCaptureCancellations = new Map();

function normalizeListCaptureRunId(value) {
  const runId = String(value || "").trim();
  return runId && runId.length <= 320 ? runId : "";
}

function rememberListCaptureCancellation(runId) {
  const normalizedRunId = normalizeListCaptureRunId(runId);
  if (!normalizedRunId) return false;
  const now = Date.now();
  pendingListCaptureCancellations.set(normalizedRunId, now);
  for (const [candidateRunId, canceledAt] of pendingListCaptureCancellations) {
    if (
      now - canceledAt > 10 * 60 * 1000 ||
      pendingListCaptureCancellations.size > 64
    ) {
      pendingListCaptureCancellations.delete(candidateRunId);
    }
  }
  return true;
}

function consumeListCaptureCancellation(runId) {
  const normalizedRunId = normalizeListCaptureRunId(runId);
  if (!normalizedRunId || !pendingListCaptureCancellations.has(normalizedRunId)) {
    return false;
  }
  pendingListCaptureCancellations.delete(normalizedRunId);
  return true;
}

function createCanceledListCaptureResult(type) {
  return {
    ok: false,
    type,
    data: null,
    error: {
      code: "CAPTURE_CANCELED",
      message: "AI Debug Session 已由用户停止",
    },
  };
}

function safeRuntimeSendMessage(message) {
  try {
    if (
      typeof chrome === "undefined" ||
      !chrome?.runtime?.id ||
      typeof chrome.runtime.sendMessage !== "function"
    ) {
      return false;
    }

    chrome.runtime.sendMessage(message, () => {
      // Swallow disconnected/invalidated runtime errors in content world.
      void chrome.runtime?.lastError;
    });
    return true;
  } catch (error) {
    const text = String(error?.message || error || "");
    if (/extension context invalidated/i.test(text)) {
      return false;
    }
    console.warn("[Content] sendMessage failed:", error);
    return false;
  }
}

function createListCaptureRunId(request, captureKind) {
  const requestedRunId = String(request?.listCaptureRunId || "").trim();
  if (requestedRunId && requestedRunId.length <= 320) {
    return requestedRunId;
  }
  listCaptureInvocationSequence += 1;
  const taskId = normalizeTaskContext(request)?.taskId || "local";
  const randomId = globalThis.crypto?.randomUUID?.() || "";
  return [
    taskId,
    captureKind,
    Date.now(),
    listCaptureInvocationSequence,
    randomId,
  ]
    .filter(Boolean)
    .join(":");
}

function beginListCaptureFeedback(request, {captureKind, label}) {
  let overlay = null;
  let overlayRunScope = null;
  let latestProgress = {};
  const runId = createListCaptureRunId(request, captureKind);
  const acceptanceLedger = createListCaptureAcceptanceLedger({runId});
  const platform = detectPlatformFromUrl(window.location.href);
  const feedbackEnabled =
    platform === "xiaohongshu" || platform === "douyin";
  try {
    if (feedbackEnabled) {
      overlay = getListCaptureDebugOverlay();
      overlay.startSession({
        sessionId: runId,
        platform,
        label,
        message: "正在识别页面中的有效笔记卡片",
      });
      if (
        String(request?.taskId || request?.taskContext?.taskId || "").trim()
      ) {
        overlay.setTaskTakeover({
          active: true,
          label: "AI 正在接管",
        });
      }
      overlayRunScope = createListCaptureOverlayRunScope(overlay, runId);
      activeListCaptureDebugOverlay = overlay;
    }
  } catch (error) {
    console.warn("[Content] List capture feedback failed to start:", error);
  }

  const isSupersededRun = () =>
    Boolean(overlayRunScope && !overlayRunScope.isCurrent());

  const readFeedbackState = () => {
    try {
      const state = overlayRunScope?.getState() || {};
      return {
        markedCount: acceptanceLedger.getAcceptedCount(),
        detectedCount: Number(state.detectedCount) || 0,
      };
    } catch {
      return {
        markedCount: acceptanceLedger.getAcceptedCount(),
        detectedCount: 0,
      };
    }
  };

  const resolveProgressCount = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) {
        return Math.floor(number);
      }
    }
    return 0;
  };

  const sendTerminalProgress = ({
    phase,
    message,
    result = null,
    finalItems = [],
  }) => {
    if (isSupersededRun()) return false;
    const feedbackState = readFeedbackState();
    const detectedCount = resolveProgressCount(
      result?.data?.rawTotalCount,
      result?.data?.totalCount,
      latestProgress?.detectedCount,
      latestProgress?.currentContentCount,
      feedbackState.detectedCount,
    );
    const filteredCount = resolveProgressCount(
      result?.data?.filteredCount,
      Array.isArray(result?.data?.items) ? finalItems.length : undefined,
      feedbackState.markedCount,
      latestProgress?.filteredCount,
    );
    reportCaptureProgress(request, {
      phase,
      message:
        phase === "completed"
          ? `${message}，页面已标记 ${feedbackState.markedCount} 条`
          : message,
      listCaptureRunId: runId,
      detectedCount,
      filteredCount,
      markedCount: feedbackState.markedCount,
      maxDetectedItems:
        result?.data?.maxDetectedItems ?? latestProgress?.maxDetectedItems,
      minLikes: result?.data?.minLikes ?? latestProgress?.minLikes,
      sortDimension:
        result?.data?.sortDimension ?? latestProgress?.sortDimension,
    });
    return true;
  };

  return Object.freeze({
    runId,
    report(progress = {}) {
      if (!feedbackEnabled) {
        reportCaptureProgress(request, progress);
        return 0;
      }
      if (isSupersededRun()) return 0;
      const tracedProgress = decorateListCheckpointProgress(
        progress,
        acceptanceLedger,
      );
      latestProgress = {...tracedProgress};
      try {
        overlayRunScope?.handleProgress(tracedProgress);
      } catch (error) {
        console.warn("[Content] List capture feedback update failed:", error);
      }
      const {markedCount} = readFeedbackState();
      reportCaptureProgress(request, {
        ...tracedProgress,
        listCaptureRunId: runId,
        markedCount,
      });
      return markedCount;
    },
    finish(result) {
      if (!feedbackEnabled) {
        return;
      }
      const finalItems = Array.isArray(result?.data?.items)
        ? result.data.items
        : [];
      const tracedFinalItems = acceptanceLedger.acceptItems(finalItems, {
        fallbackOutcome: "accepted",
      });
      if (result?.data && typeof result.data === "object") {
        result.data.items = tracedFinalItems;
      }
      if (isSupersededRun()) return;
      let terminalPhase = "completed";
      let terminalMessage = "列表采集完成";
      try {
        if (tracedFinalItems.length > 0) {
          overlayRunScope?.recordItems(tracedFinalItems, {
            outcome: "accepted",
            detectedCount:
              result?.data?.rawTotalCount ?? result?.data?.totalCount ?? 0,
          });
        }
        if (result?.ok === false) {
          const errorCode = String(result?.error?.code || "").toUpperCase();
          if (errorCode === "CAPTURE_CANCELED") {
            terminalPhase = "canceled";
            terminalMessage = result?.error?.message || "列表采集已停止";
            overlayRunScope?.cancel(terminalMessage);
          } else {
            terminalPhase = "failed";
            terminalMessage = result?.error?.message || "列表采集中断";
            overlayRunScope?.fail(terminalMessage);
          }
        } else {
          overlayRunScope?.complete();
        }
      } catch (error) {
        console.warn("[Content] List capture feedback finish failed:", error);
      }
      sendTerminalProgress({
        phase: terminalPhase,
        message: terminalMessage,
        result,
        finalItems: tracedFinalItems,
      });
    },
    fail(error) {
      if (!feedbackEnabled || isSupersededRun()) {
        return;
      }
      try {
        overlayRunScope?.fail(error);
      } catch (overlayError) {
        console.warn("[Content] List capture feedback failure UI failed:", overlayError);
      }
      sendTerminalProgress({
        phase: "failed",
        message: String(error?.message || error || "列表采集中断"),
      });
    },
  });
}

// ==================== 消息监听器 ====================

function attachContentResponseDiagnostics(request, response) {
  const taskContext = normalizeTaskContext(request);
  const normalized =
    response && typeof response === "object"
      ? response
      : {ok: false, data: response};
  const action = String(request?.action || "");
  if (
    !taskContext &&
    normalized?.ok === true &&
    (action === "detectPageType" || action === "detectSearchSortDimension")
  ) {
    return normalized;
  }
  const diagnostics = buildContentDiagnostics({
    action,
    taskContext,
    response: normalized,
    error: normalized?.error || null,
  });

  return {
    ...normalized,
    taskId: normalized.taskId || taskContext?.taskId || "",
    correlationId:
      normalized.correlationId || taskContext?.correlationId || "",
    featureKey: normalized.featureKey || taskContext?.featureKey || "",
    diagnostics: {
      ...(normalized.diagnostics && typeof normalized.diagnostics === "object"
        ? normalized.diagnostics
        : {}),
      ...diagnostics,
    },
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action !== "detectSearchSortDimension") {
    console.log("[Content] Received message:", request.action);
  }

  const sendResponseWithDiagnostics = (response) => {
    sendResponse(attachContentResponseDiagnostics(request, response));
  };

  switch (request.action) {
    case "ping":
      sendResponseWithDiagnostics({ok: true, ready: true});
      return false;

    case "detectPageType":
      handleDetectPageType(sendResponseWithDiagnostics);
      return true;

    case "smartCapture":
      runTrackedCaptureRequest(request, () =>
        handleSmartCapture(request, sendResponseWithDiagnostics),
      );
      return true;

    case "captureSingleNote":
      runTrackedCaptureRequest(request, () =>
        handleCaptureSingleNote(request, sendResponseWithDiagnostics),
      );
      return true;

    case "captureBloggerProfile":
      runTrackedCaptureRequest(request, () =>
        handleCaptureBloggerProfile(request, sendResponseWithDiagnostics),
      );
      return true;

    case "captureBloggerNotes":
      runTrackedCaptureRequest(request, () =>
        handleCaptureBloggerNotes(request, sendResponseWithDiagnostics),
      );
      return true;

    case "captureKeywordNotes":
      runTrackedCaptureRequest(request, () =>
        handleCaptureKeywordNotes(request, sendResponseWithDiagnostics),
      );
      return true;

    case "updateListCaptureTraceBindings":
      handleUpdateListCaptureTraceBindings(request, sendResponseWithDiagnostics);
      return true;

    case "restoreListCaptureTraceOverlay":
      handleRestoreListCaptureTraceOverlay(
        request,
        sendResponseWithDiagnostics,
      );
      return true;

    case "setCaptureTaskTakeover":
      handleSetCaptureTaskTakeover(request, sendResponseWithDiagnostics);
      return true;

    case "prepareKeywordStrategyCapture":
      handlePrepareKeywordStrategyCapture(sendResponseWithDiagnostics);
      return true;

    case "applyBatchSearchFilters":
      handleApplyBatchSearchFilters(request, sendResponseWithDiagnostics);
      return true;

    case "expandKeywordSuggestions":
      runTrackedCaptureRequest(request, () =>
        handleExpandKeywordSuggestions(request, sendResponseWithDiagnostics),
      );
      return true;

    case "detectSearchSortDimension":
      handleDetectSearchSortDimension(sendResponseWithDiagnostics);
      return true;

    case "captureComments":
      runTrackedCaptureRequest(request, () =>
        handleCaptureComments(request, sendResponseWithDiagnostics),
      );
      return true;

    case "cancelCapture":
      handleCancelCapture(request, sendResponseWithDiagnostics);
      return true;

    default:
      console.warn("[Content] Unknown action:", request.action);
      sendResponseWithDiagnostics({
        ok: false,
        error: {code: "UNKNOWN_ACTION", message: "未知操作"},
      });
      return false;
  }
});

// ==================== 消息处理函数 ====================

function runTrackedCaptureRequest(request, handler) {
  const requestId = String(request?.captureRequestId || "").trim();
  if (requestId) {
    activeCaptureRequestIds.add(requestId);
  }

  let result;
  try {
    // Invoke synchronously so each handler resets its cancellation flag before a
    // matching cancel message can interleave with the request startup.
    result = handler();
  } catch (error) {
    if (requestId) {
      activeCaptureRequestIds.delete(requestId);
    }
    throw error;
  }

  void Promise.resolve(result)
    .catch((error) => {
      console.error("[Content] Tracked capture handler failed:", error);
    })
    .finally(() => {
      if (requestId) {
        activeCaptureRequestIds.delete(requestId);
      }
    });
}

function reportCaptureProgress(request, progress = {}) {
  const source = progress && typeof progress === "object" ? progress : {};
  const normalizedProgress = {
    ...source,
    captureRequestId: String(request?.captureRequestId || ""),
    recordId: String(request?.recordId || source.recordId || ""),
    current: Number(request?.current) || source.current,
    total: Number(request?.total) || source.total,
    runnerTabId: Number(request?.runnerTabId) || source.runnerTabId || null,
    captureAction: String(request?.action || source.captureAction || ""),
    recoveryMaxAttempts: 1,
    updatedAt: source.updatedAt || Date.now(),
  };
  const taskId = String(
    request?.taskId || request?.taskContext?.taskId || "",
  ).trim();
  if (taskId) {
    try {
      const overlay =
        activeListCaptureDebugOverlay || getListCaptureDebugOverlay();
      overlay.setTaskTakeover({
        active: true,
        label: "AI 正在接管",
        progress: normalizedProgress,
      });
      activeListCaptureDebugOverlay = overlay;
    } catch (error) {
      console.debug(
        "[Content] Capture task page progress unavailable (ignored):",
        error?.message || error,
      );
    }
  }
  safeRuntimeSendMessage({
    action: "captureProgress",
    progress: normalizedProgress,
  });
}

/**
 * 处理页面类型检测
 */
function handleDetectPageType(sendResponse) {
  try {
    const pageType = detectPageType(window.location.href);
    sendResponse({ok: true, pageType});
  } catch (error) {
    console.error("[Content] Detect page type failed:", error);
    sendResponse({
      ok: false,
      error: {code: "DETECT_FAILED", message: error.message},
    });
  }
}

function handleUpdateListCaptureTraceBindings(request, sendResponse) {
  try {
    if (!activeListCaptureDebugOverlay) {
      sendResponse({
        ok: true,
        data: {
          runId: String(request?.runId || request?.payload?.runId || ""),
          updatedCount: 0,
          ignoredCount: Array.isArray(
            request?.bindings || request?.payload?.bindings,
          )
            ? (request.bindings || request.payload.bindings).length
            : 0,
          reason: "no_active_list_capture_trace",
        },
      });
      return;
    }

    const defaultRunId = String(
      request?.runId || request?.payload?.runId || "",
    ).trim();
    const bindings = Array.isArray(request?.bindings)
      ? request.bindings
      : Array.isArray(request?.payload?.bindings)
        ? request.payload.bindings
        : [];
    const normalizedBindings = bindings.map((binding) => ({
      ...(binding && typeof binding === "object" ? binding : {}),
      runId:
        binding?.runId || binding?.captureTrace?.runId || defaultRunId,
    }));
    const result = activeListCaptureDebugOverlay.updateTraceBindings(
      normalizedBindings,
    );
    sendResponse({ok: true, data: result});
  } catch (error) {
    console.warn("[Content] Update list capture trace bindings failed:", error);
    sendResponse({
      ok: false,
      error: {
        code: "TRACE_BINDING_UPDATE_FAILED",
        message: error?.message || "更新列表采集标记失败",
      },
    });
  }
}

function handleRestoreListCaptureTraceOverlay(request, sendResponse) {
  try {
    const payload =
      request?.payload && typeof request.payload === "object"
        ? request.payload
        : request;
    const runId = normalizeListCaptureRunId(payload?.runId);
    const items = Array.isArray(payload?.items)
      ? payload.items.filter((item) => item && typeof item === "object")
      : [];
    if (!runId || items.length === 0) {
      sendResponse({
        ok: true,
        data: {
          runId,
          restoredCount: 0,
          reason: "missing_trace_snapshot",
        },
      });
      return;
    }

    const overlay = getListCaptureDebugOverlay();
    overlay.startSession({
      sessionId: runId,
      platform:
        String(payload?.platform || detectPlatformFromUrl(window.location.href))
          .trim()
          .toLowerCase(),
      label: String(payload?.label || "采集结果").trim(),
      message: "已恢复本轮采集编号",
    });
    overlay.recordItems(items, {
      outcome: "accepted",
      detectedCount: items.length,
      message: "已恢复本轮采集编号",
    });
    overlay.complete("已恢复本轮采集编号");
    activeListCaptureDebugOverlay = overlay;
    const snapshot = overlay.getRenderSnapshot?.() || {};
    sendResponse({
      ok: true,
      data: {
        runId,
        restoredCount: items.length,
        visibleMarkerCount: Number(snapshot.visibleMarkerCount) || 0,
        unresolvedCount: Number(snapshot.unresolvedCount) || 0,
      },
    });
  } catch (error) {
    console.warn("[Content] Restore list capture trace overlay failed:", error);
    sendResponse({
      ok: false,
      error: {
        code: "TRACE_OVERLAY_RESTORE_FAILED",
        message: error?.message || "恢复列表采集标记失败",
      },
    });
  }
}

function handleSetCaptureTaskTakeover(request, sendResponse) {
  try {
    const active = Boolean(request?.active);
    if (!active && request?.clearTrace === true) {
      const result =
        activeListCaptureDebugOverlay?.clearTaskTrace?.() || {
          cleared: false,
          runId: "",
          clearedAttributeCount: 0,
        };
      activeListCaptureDebugOverlay = null;
      sendResponse({
        ok: true,
        data: {
          taskId: String(request?.taskId || "").trim(),
          active: false,
          label: String(request?.label || "AI 正在接管").trim(),
          ...result,
        },
      });
      return;
    }
    const overlay = getListCaptureDebugOverlay();
    const takeoverOptions = {
      active,
      label: String(request?.label || "AI 正在接管").trim(),
    };
    if (Object.prototype.hasOwnProperty.call(request || {}, "progress")) {
      takeoverOptions.progress =
        request?.progress && typeof request.progress === "object"
          ? request.progress
          : null;
    }
    const result = overlay.setTaskTakeover(takeoverOptions);
    activeListCaptureDebugOverlay = overlay;
    sendResponse({
      ok: true,
      data: {
        taskId: String(request?.taskId || "").trim(),
        ...result,
      },
    });
  } catch (error) {
    console.warn("[Content] Set capture task takeover failed:", error);
    sendResponse({
      ok: false,
      error: {
        code: "TASK_TAKEOVER_UPDATE_FAILED",
        message: error?.message || "更新页面接管状态失败",
      },
    });
  }
}

/**
 * 处理智能采集
 */
async function handleSmartCapture(request, sendResponse) {
  try {
    resetCancelFlag();

    const result = await smartCapture({
      mode: request.mode || "auto",
      onProgress: (progress) => {
        reportCaptureProgress(request, progress);
      },
    });

    sendResponse(result);
  } catch (error) {
    console.error("[Content] Smart capture failed:", error);
    sendResponse({
      ok: false,
      type: null,
      data: null,
      meta: {
        pageType: detectPageType(window.location.href),
        captureStartedAt: new Date().toISOString(),
        captureFinishedAt: new Date().toISOString(),
      },
      error: {
        code: "CAPTURE_FAILED",
        message: error.message,
      },
    });
  }
}

/**
 * 处理单篇笔记采集
 */
async function handleCaptureSingleNote(request, sendResponse) {
  try {
    resetCancelFlag();

    const result = await captureSingleNote({
      includeBloggerMetrics: Boolean(request.includeBloggerMetrics),
      preferWorksTabForBloggerMetrics: Boolean(
        request.preferWorksTabForBloggerMetrics,
      ),
    });
    sendResponse(result);
  } catch (error) {
    console.error("[Content] Capture single note failed:", error);
    sendResponse({
      ok: false,
      type: "single_note",
      data: null,
      error: {code: "CAPTURE_FAILED", message: error.message},
    });
  }
}

/**
 * 处理博主信息采集
 */
async function handleCaptureBloggerProfile(request, sendResponse) {
  try {
    resetCancelFlag();

    const result = await captureBloggerProfile();
    sendResponse(result);
  } catch (error) {
    console.error("[Content] Capture blogger profile failed:", error);
    sendResponse({
      ok: false,
      type: "blogger_profile",
      data: null,
      error: {code: "CAPTURE_FAILED", message: error.message},
    });
  }
}

/**
 * 处理博主笔记列表采集
 */
async function handleCaptureBloggerNotes(request, sendResponse) {
  const captureFeedback = beginListCaptureFeedback(request, {
    captureKind: "blogger-notes",
    label: "博主作品列表",
  });
  if (consumeListCaptureCancellation(captureFeedback.runId)) {
    const canceledResult = createCanceledListCaptureResult("blogger_notes");
    captureFeedback.finish(canceledResult);
    sendResponse(canceledResult);
    return;
  }
  try {
    resetCancelFlag();

    const result = await captureBloggerNotes({
      onProgress: (progress) => {
        captureFeedback.report(progress);
      },
      profileMetrics: request.profileMetrics,
      minLikes: request.minLikes,
      maxDetectedItems: request.maxDetectedItems ?? request.maxItems,
      keywordFilter: request.keywordFilter || "",
      monitorPublishWindow: request.monitorPublishWindow || "",
      monitorObserveWindowHours: request.monitorObserveWindowHours,
      monitorLikeThreshold: request.monitorLikeThreshold,
      waitMinMs: request.waitMinMs,
      waitMaxMs: request.waitMaxMs,
      stallTimeoutMs: request.stallTimeoutMs,
      maxDurationMs: request.maxDurationMs,
      maxScrollTimes: request.maxScrollTimes,
    });

    captureFeedback.finish(result);
    sendResponse(result);
  } catch (error) {
    captureFeedback.fail(error);
    console.error("[Content] Capture blogger notes failed:", error);
    sendResponse({
      ok: false,
      type: "blogger_notes",
      data: null,
      error: {code: "CAPTURE_FAILED", message: error.message},
    });
  } finally {
    pendingListCaptureCancellations.delete(captureFeedback.runId);
  }
}

/**
 * 处理关键词搜索结果采集
 */
async function handleCaptureKeywordNotes(request, sendResponse) {
  const captureFeedback = beginListCaptureFeedback(request, {
    captureKind: "keyword-notes",
    label: request.keyword ? `搜索：${request.keyword}` : "关键词搜索列表",
  });
  if (consumeListCaptureCancellation(captureFeedback.runId)) {
    const canceledResult = createCanceledListCaptureResult("keyword_notes");
    captureFeedback.finish(canceledResult);
    sendResponse(canceledResult);
    return;
  }
  try {
    resetCancelFlag();

    const result = await captureKeywordNotes({
      keyword: request.keyword,
      onProgress: (progress) => {
        captureFeedback.report(progress);
      },
      minLikes: request.minLikes,
      sortDimension: request.sortDimension,
      maxDetectedItems: request.maxDetectedItems ?? request.maxItems,
      maxDurationMs: request.maxDurationMs,
      waitMinMs: request.waitMinMs,
      waitMaxMs: request.waitMaxMs,
      stallTimeoutMs: request.stallTimeoutMs,
      maxScrollTimes: request.maxScrollTimes || 50,
    });

    captureFeedback.finish(result);
    sendResponse(result);
  } catch (error) {
    captureFeedback.fail(error);
    console.error("[Content] Capture keyword notes failed:", error);
    sendResponse({
      ok: false,
      type: "keyword_notes",
      data: null,
      error: {code: "CAPTURE_FAILED", message: error.message},
    });
  } finally {
    pendingListCaptureCancellations.delete(captureFeedback.runId);
  }
}

/**
 * 处理关键词裂变扩词
 */
async function handleExpandKeywordSuggestions(request, sendResponse) {
  try {
    resetCancelFlag();
    const result = await expandKeywordViaSuggestions({
      seedKeyword: request.seedKeyword,
      platform: request.platform,
      onProgress: (progress) => {
        safeRuntimeSendMessage({
          action: "expandKeywordProgress",
          progress,
        });
      },
      delayBetweenMs: request.delayBetweenMs,
      suffixLetters: request.suffixLetters,
    });

    sendResponse({ok: true, data: result});
  } catch (error) {
    console.error("[Content] Expand keyword suggestions failed:", error);
    const isCanceledByUser =
      String(error?.message || "") === "EXPAND_KEYWORD_CANCELED";
    sendResponse({
      ok: false,
      data: null,
      error: {
        code: isCanceledByUser
          ? "EXPAND_KEYWORD_CANCELED"
          : "EXPAND_KEYWORD_FAILED",
        message: isCanceledByUser ? "扩词已取消" : error.message,
      },
    });
  }
}

function handleDetectSearchSortDimension(sendResponse) {
  try {
    const result = detectKeywordSortDimension();
    sendResponse({
      ok: true,
      data: result,
    });
  } catch (error) {
    console.error("[Content] Detect search sort dimension failed:", error);
    sendResponse({
      ok: false,
      error: {code: "DETECT_SORT_FAILED", message: error.message},
    });
  }
}

async function handlePrepareKeywordStrategyCapture(sendResponse) {
  try {
    const result = await prepareKeywordStrategyCapture();
    sendResponse({
      ok: true,
      data: result,
    });
  } catch (error) {
    console.error("[Content] Prepare keyword strategy capture failed:", error);
    sendResponse({
      ok: false,
      error: {
        code: "PREPARE_KEYWORD_STRATEGY_FAILED",
        message: error.message,
      },
    });
  }
}

// 批量采集的「排序 / 范围」筛选标签(各平台文案兜底多写几个,点中即用)
const BATCH_SORT_LABELS = {
  comprehensive: ["综合", "综合排序"],
  latest: ["最新", "最新发布", "最新内容", "时间排序", "按时间"],
  likes: ["最多点赞", "点赞最多", "按点赞"],
  comments: ["最多评论", "评论最多", "按评论"],
  collects: ["最多收藏", "收藏最多", "按收藏"],
};
const BATCH_TIME_LABELS = {
  all: ["不限", "全部"],
  day: ["一天内", "24小时", "近一天", "最近一天"],
  week: ["一周内", "近一周", "7天内", "最近一周"],
  month: ["一月内", "近一月", "30天内", "最近一月"],
  halfyear: ["半年内", "最近半年", "近半年"],
};
const BATCH_CONTENT_TYPE_LABELS = {
  all: ["不限", "全部"],
  video: ["视频"],
  image: ["图文", "图文笔记"],
};
const BATCH_SEARCH_SCOPE_LABELS = {
  all: ["不限", "全部"],
  followed: ["已关注", "关注的人", "关注"],
  viewed: ["已看过", "最近看过", "看过"],
  unviewed: ["未看过", "还未看过", "未看"],
};
const BATCH_DISTANCE_LABELS = {
  all: ["不限", "全部"],
  city: ["同城"],
  nearby: ["附近"],
};
const BATCH_VIDEO_DURATION_LABELS = {
  all: ["不限", "全部"],
  under_1m: ["1分钟以下", "一分钟以下"],
  "1_5m": ["1-5分钟", "1～5分钟", "1至5分钟"],
  over_5m: ["5分钟以上", "五分钟以上"],
};

async function handleApplyBatchSearchFilters(request, sendResponse) {
  try {
    const result = await applyBatchSearchFilters({
      sort: request?.sort || "",
      publishTime: request?.publishTime || "",
      contentType: request?.contentType || "",
      searchScope: request?.searchScope || "",
      distance: request?.distance || "",
      videoDuration: request?.videoDuration || "",
    });
    sendResponse({ ok: true, data: result });
  } catch (error) {
    console.error("[Content] Apply batch search filters failed:", error);
    sendResponse({ ok: false, error: { code: "APPLY_FILTER_FAILED", message: error.message } });
  }
}

function shouldApplyBatchFilter(value = "", defaultValue = "") {
  const normalized = String(value || "").trim();
  return Boolean(normalized && normalized !== defaultValue && normalized !== "all");
}

function getBatchFilterSectionCandidates(field, platform) {
  if (field === "contentType") {
    return platform === "douyin"
      ? ["内容形式", "作品类型", "类型", "内容类型", "笔记类型"]
      : ["笔记类型", "内容类型", "类型"];
  }
  const sections = {
    sort: ["排序依据", "排序"],
    publishTime: ["发布时间", "时间"],
    searchScope: ["搜索范围", "范围"],
    distance: ["位置距离", "距离"],
    videoDuration: ["视频时长", "时长"],
  };
  return sections[field] || [];
}

async function applyBatchFilterOption({
  field,
  value,
  labels,
  notes,
  platform,
  displayLabel,
} = {}) {
  if (!labels) {
    return false;
  }
  const ok = await applyStrategyFilterInSection(
    getBatchFilterSectionCandidates(field, platform),
    labels,
    notes,
    displayLabel,
  );
  if (ok) {
    await waitForKeywordStrategyUi(
      platform === "douyin" ? randomStrategyDelay(1800, 2800) : 1000,
    );
    await ensureKeywordStrategyFilterPanelOpen(notes);
    await waitForKeywordStrategyUi(
      platform === "douyin" ? randomStrategyDelay(500, 900) : 300,
    );
  }
  return ok;
}

// 复用「找对标账号」的筛选点击能力(ensureKeywordStrategyFilterPanelOpen + applyStrategyFilterInSection),
// 给批量采集在采集前按需切「排序 / 范围」。默认值则不改,直接返回。
async function applyBatchSearchFilters({
  sort = "",
  publishTime = "",
  contentType = "",
  searchScope = "",
  distance = "",
  videoDuration = "",
} = {}) {
  const pageType = detectPageType(window.location.href);
  if (pageType !== "search_results") {
    return { applied: false, reason: "not_search_page" };
  }
  const platform = /douyin\.com/i.test(window.location.href)
    ? "douyin"
    : /xiaohongshu\.com/i.test(window.location.href)
      ? "xiaohongshu"
      : "unknown";
  const filterRequests = [
    {
      field: "sort",
      value: sort,
      defaultValue: "comprehensive",
      labels: BATCH_SORT_LABELS[sort],
      displayLabel: "排序",
    },
    {
      field: "publishTime",
      value: publishTime,
      defaultValue: "all",
      labels: BATCH_TIME_LABELS[publishTime],
      displayLabel: "时间",
    },
    {
      field: "contentType",
      value: contentType,
      defaultValue: "all",
      labels: BATCH_CONTENT_TYPE_LABELS[contentType],
      displayLabel: "内容类型",
    },
    {
      field: "searchScope",
      value: searchScope,
      defaultValue: "all",
      labels: BATCH_SEARCH_SCOPE_LABELS[searchScope],
      displayLabel: "搜索范围",
    },
    {
      field: "distance",
      value: distance,
      defaultValue: "all",
      labels: BATCH_DISTANCE_LABELS[distance],
      displayLabel: "位置距离",
    },
    {
      field: "videoDuration",
      value: videoDuration,
      defaultValue: "all",
      labels: BATCH_VIDEO_DURATION_LABELS[videoDuration],
      displayLabel: "视频时长",
    },
  ].filter((item) => shouldApplyBatchFilter(item.value, item.defaultValue));
  if (filterRequests.length === 0) {
    return { applied: false, reason: "no_filter" };
  }
  const notes = [];
  const opened = await ensureKeywordStrategyFilterPanelOpen(notes);
  if (!opened) {
    return { applied: false, reason: "panel_not_opened", notes };
  }
  let applied = false;
  for (const request of filterRequests) {
    const ok = await applyBatchFilterOption({
      ...request,
      notes,
      platform,
    });
    if (ok) {
      applied = true;
    }
  }
  await closeKeywordStrategyFilterPanel(notes);
  return { applied, notes };
}

async function prepareKeywordStrategyCapture() {
  const pageType = detectPageType(window.location.href);
  if (pageType !== "search_results") {
    throw new Error("当前页面不是搜索页，无法切换策略筛选条件");
  }

  const notes = [];
  const platform = /douyin\.com/i.test(window.location.href)
    ? "douyin"
    : /xiaohongshu\.com/i.test(window.location.href)
      ? "xiaohongshu"
      : "unknown";

  // Step 1: Open filter panel
  const panelOpened = await ensureKeywordStrategyFilterPanelOpen(notes);
  if (!panelOpened) {
    return {
      ok: true,
      data: {
        appliedSort: false,
        appliedRecency: false,
        appliedNoteType: false,
        notes,
      },
    };
  }

  // Step 2: Apply sort -- "最多点赞"
  const appliedSort = await applyStrategyFilterInSection(
    ["排序依据", "排序"],
    ["最多点赞", "点赞最多", "按点赞"],
    notes,
    "排序",
  );

  if (appliedSort) {
    // XHS refreshes results after sort change; wait and re-open the panel
    await waitForKeywordStrategyUi(2000);
    await ensureKeywordStrategyFilterPanelOpen(notes);
    await waitForKeywordStrategyUi(600);
  }

  // Step 3: Apply time filter -- "半年内"
  const appliedRecency = await applyStrategyFilterInSection(
    ["发布时间", "时间"],
    ["半年内", "最近半年", "近半年"],
    notes,
    "时间",
  );

  if (appliedRecency) {
    await waitForKeywordStrategyUi(1200);
    await ensureKeywordStrategyFilterPanelOpen(notes);
    await waitForKeywordStrategyUi(500);
  }

  // Step 4: Apply note type -- "不限"
  const appliedNoteType = await applyStrategyFilterInSection(
    platform === "douyin"
      ? ["内容形式", "作品类型", "类型", "内容类型", "笔记类型"]
      : ["笔记类型", "内容类型", "类型"],
    ["不限", "全部"],
    notes,
    "类型",
  );

  // Final wait for results to settle
  await waitForKeywordStrategyUi(
    appliedSort || appliedRecency || appliedNoteType ? 2000 : 900,
  );

  return {
    ok: true,
    data: {
      appliedSort,
      appliedRecency,
      appliedNoteType,
      notes,
    },
  };
}

async function ensureKeywordStrategyFilterPanelOpen(notes = []) {
  if (findStrategyFilterPanel()) {
    return true;
  }
  // 只认「筛选」下拉展开后才可见的文案。"最多点赞/点赞最多"在小红书搜索页的常驻
  // 排序条上也有,会把"面板已打开"判错——后果是从不去点开「筛选」下拉,发布时间/
  // 笔记类型等下拉内选项被静默跳过(批量采集"筛选没生效"的根因之一)。
  if (findStrategyClickableByText(["半年内", "综合排序", "笔记类型"])) {
    return true;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const filterTrigger =
      findStrategyFilterTrigger() ||
      findStrategyClickableByText([
        "筛选",
        "已筛选",
        "时间",
        "发布时间",
        "排序",
      ]);
    if (!filterTrigger) {
      await waitForKeywordStrategyUi(500);
      continue;
    }
    clickStrategyElement(filterTrigger);
    await waitForKeywordStrategyUi(1200);
    if (findStrategyFilterPanel()) {
      return true;
    }
    if (
      // 同上:只认下拉展开后才可见的文案,防止常驻排序条造成"已打开"误判
      findStrategyClickableByText(["半年内", "综合排序", "笔记类型"])
    ) {
      return true;
    }
    await waitForKeywordStrategyUi(400);
  }

  notes.push("未找到筛选面板入口");
  return false;
}

function findStrategyFilterPanel() {
  const sectionTexts = [
    "排序依据",
    "排序",
    "笔记类型",
    "作品类型",
    "内容类型",
    "内容形式",
    "发布时间",
    "时间",
    "视频时长",
    "搜索范围",
    "位置距离",
    "距离",
  ];
  const normalized = sectionTexts.map((t) => normalizeStrategyText(t));

  const containers = document.querySelectorAll(
    '[class*="filter"], [class*="panel"], [class*="dropdown"], [class*="popup"], [class*="overlay"], [class*="screen"], section, aside',
  );
  for (const el of containers) {
    if (!(el instanceof HTMLElement) || !isStrategyNodeVisible(el)) continue;
    const text = normalizeStrategyText(el.innerText || "");
    if (normalized.filter((s) => text.includes(s)).length >= 2) return el;
  }
  const allDivs = document.querySelectorAll("div");
  for (const div of allDivs) {
    if (!(div instanceof HTMLElement) || !isStrategyNodeVisible(div)) continue;
    const text = normalizeStrategyText(div.innerText || "");
    if (text.length > 1200) continue;
    if (normalized.filter((s) => text.includes(s)).length >= 2) return div;
  }
  return null;
}

async function closeKeywordStrategyFilterPanel(notes = []) {
  const panel = findStrategyFilterPanel();
  if (!panel) {
    return true;
  }

  const closeCandidates = [
    ...(findOptionCandidatesInFilterSection(
      panel,
      ["收起", "关闭"],
      ["收起", "完成", "确定"],
    ) || []),
    ...findStrategyClickableCandidatesByText(["收起", "完成", "确定", "关闭"]),
  ];
  for (const candidate of closeCandidates.slice(0, 4)) {
    if (!(candidate instanceof HTMLElement) || !isStrategyNodeVisible(candidate)) {
      continue;
    }
    clickStrategyElement(candidate);
    await waitForKeywordStrategyUi(500);
    if (!findStrategyFilterPanel()) {
      return true;
    }
  }

  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitForKeywordStrategyUi(500);
  if (!findStrategyFilterPanel()) {
    return true;
  }

  notes.push("筛选面板未自动收起");
  return false;
}

function findStrategyFilterTrigger() {
  const triggerHints = [
    "筛选",
    "已筛选",
    "时间",
    "发布时间",
    "排序",
    "综合筛选",
  ];
  const nodes = Array.from(
    document.querySelectorAll(
      [
        '[class*="filter"]',
        '[class*="filter"] > span',
        '[class*="filter-icon"]',
        '[class*="screen"]',
        "button",
        '[role="button"]',
        "a",
        "li",
        "span",
        "div",
      ].join(", "),
    ),
  );

  let bestNode = null;
  let bestScore = -1;
  for (const node of nodes) {
    if (!(node instanceof HTMLElement) || !isStrategyNodeVisible(node))
      continue;
    const clickable =
      node.closest(
        '[class*="filter"], [class*="screen"], button, [role="button"], a, li',
      ) || node;
    if (
      !(clickable instanceof HTMLElement) ||
      !isStrategyNodeVisible(clickable)
    )
      continue;
    const text = normalizeStrategyText(
      clickable.innerText || clickable.textContent || "",
    );
    if (text.length > 20) continue;
    const className = String(clickable.className || "").toLowerCase();
    let score = 0;

    if (text === normalizeStrategyText("筛选") || text === normalizeStrategyText("已筛选")) {
      score += 10;
    } else if (
      triggerHints.some((hint) => text.includes(normalizeStrategyText(hint)))
    ) {
      score += 6;
    }
    if (/filter|screen/.test(className)) {
      score += 4;
    }
    if (clickable.querySelector?.('[class*="filter-icon"], [class*="icon"], svg')) {
      score += 2;
    }
    if (/\bactive\b/.test(className)) {
      score += 1;
    }
    if (text.length <= 4) {
      score += 1;
    }

    if (score > bestScore) {
      bestNode = clickable;
      bestScore = score;
    }
  }

  return bestScore >= 4 ? bestNode : null;
}

function findOptionInFilterSection(panel, sectionLabel, optionTexts) {
  const candidates = findOptionCandidatesInFilterSection(
    panel,
    sectionLabel,
    optionTexts,
  );
  return candidates[0] || null;
}

function findOptionCandidatesInFilterSection(panel, sectionLabel, optionTexts) {
  const sectionLabels = Array.isArray(sectionLabel)
    ? sectionLabel
    : [sectionLabel];
  const normalizedSections = sectionLabels
    .map((item) => normalizeStrategyText(item))
    .filter(Boolean);
  const normalizedOptions = optionTexts.map((t) => normalizeStrategyText(t));
  const searchRoot = panel || document.body;
  const matches = [];

  findStrategySectionLabelNodes(searchRoot, normalizedSections).forEach(
    (sectionEl) => {
      findStrategySectionOptionContainers(sectionEl, normalizedOptions).forEach(
        ({container, containerScore}) => {
          container
            .querySelectorAll('span, div, button, a, li, [role="button"]')
            .forEach((node) => {
              if (!(node instanceof HTMLElement) || !isStrategyNodeVisible(node))
                return;
              const text = normalizeStrategyText(
                node.innerText || node.textContent || "",
              );
              if (!text || text.length > 16) return;
              for (const opt of normalizedOptions) {
                if (text !== opt) continue;
                let score =
                  20 + containerScore - estimateStrategyNodeArea(node) / 100000;
                if (node.closest('button, [role="button"], a, li')) score += 2;
                if (isLeafStrategyNode(node)) score += 1;
                if (isStrategyControlActive(node)) score += 1;
                matches.push({node, score});
              }
            });
        },
      );
    },
  );

  const seen = new Set();
  return matches
    .sort((left, right) => right.score - left.score)
    .map((item) => item.node)
    .filter((node) => {
      if (seen.has(node)) return false;
      seen.add(node);
      return true;
    });
}

function findStrategySectionLabelNodes(searchRoot, normalizedSections = []) {
  if (!searchRoot || normalizedSections.length === 0) {
    return [];
  }

  const matches = [];
  for (const el of searchRoot.querySelectorAll("*")) {
    if (!(el instanceof HTMLElement) || !isStrategyNodeVisible(el)) {
      continue;
    }
    const raw = normalizeStrategyText(el.textContent || "");
    if (
      normalizedSections.some(
        (section) => raw === section && raw.length <= section.length + 2,
      )
    ) {
      matches.push(el);
    }
  }

  return matches.sort(
    (left, right) => estimateStrategyNodeArea(left) - estimateStrategyNodeArea(right),
  );
}

function findStrategySectionOptionContainers(sectionEl, normalizedOptions = []) {
  const containers = [];
  let container = sectionEl?.parentElement || null;

  for (let depth = 0; container && depth < 5; depth += 1) {
    if (container instanceof HTMLElement && isStrategyNodeVisible(container)) {
      const text = normalizeStrategyText(container.innerText || container.textContent || "");
      const hasOption = normalizedOptions.some((opt) => text.includes(opt));
      if (hasOption && text.length <= 800) {
        containers.push({
          container,
          containerScore: 10 - depth * 2 - estimateStrategyNodeArea(container) / 100000,
        });
      }
    }
    container = container.parentElement;
  }

  return containers;
}

async function applyStrategyFilterInSection(
  sectionLabel,
  optionTexts,
  notes = [],
  label = "",
) {
  const targetLabel = label || optionTexts[0];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const panel = findStrategyFilterPanel();
    const panelTargets = panel
      ? findOptionCandidatesInFilterSection(panel, sectionLabel, optionTexts)
      : [];
    const targets =
      panelTargets.length > 0 || panel
        ? panelTargets
        : findStrategyClickableCandidatesByText(optionTexts);

    if (targets.some((node) => isStrategyControlActive(node))) {
      return true;
    }

    if (targets.length === 0) {
      await ensureKeywordStrategyFilterPanelOpen(notes);
      await waitForKeywordStrategyUi(300);
      continue;
    }

    for (const target of targets.slice(0, 3)) {
      clickStrategyElement(target);
      if (await waitForStrategyOptionActive(sectionLabel, optionTexts, 1200)) {
        return true;
      }
      await waitForKeywordStrategyUi(250);
    }

    await ensureKeywordStrategyFilterPanelOpen(notes);
    await waitForKeywordStrategyUi(400);
  }

  notes.push(`未成功切换到"${targetLabel}"`);
  return false;
}

function findStrategyClickableByText(candidates = []) {
  const matches = findStrategyClickableCandidatesByText(candidates);
  return matches[0] || null;
}

function findStrategyClickableCandidatesByText(candidates = []) {
  const normalizedCandidates = candidates
    .map((item) => normalizeStrategyText(item))
    .filter(Boolean);
  if (normalizedCandidates.length === 0) {
    return [];
  }

  const nodes = Array.from(
    document.querySelectorAll('button, [role="button"], a, li, span, div'),
  );

  const matches = [];
  nodes.forEach((node) => {
    if (!(node instanceof HTMLElement) || !isStrategyNodeVisible(node)) {
      return;
    }
    const text = normalizeStrategyText(
      node.innerText || node.textContent || "",
    );
    if (!text || text.length > 24) {
      return;
    }

    normalizedCandidates.forEach((candidate) => {
      if (!text.includes(candidate)) {
        return;
      }
      let score = text === candidate ? 10 : 6;
      if (node.closest('button, [role="button"], a, li')) {
        score += 2;
      }
      if (isLeafStrategyNode(node)) {
        score += 1;
      }
      if (isStrategyControlActive(node)) {
        score += 1;
      }
      score -= estimateStrategyNodeArea(node) / 100000;
      matches.push({node, score});
    });
  });

  return matches
    .sort((left, right) => right.score - left.score)
    .map((item) => item.node);
}

function normalizeStrategyText(text = "") {
  return String(text || "")
    .replace(/\s+/g, "")
    .trim();
}

function isStrategyNodeVisible(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isStrategyControlActive(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  const attrs = [
    node.getAttribute("aria-selected"),
    node.getAttribute("aria-pressed"),
    node.getAttribute("data-state"),
    node.getAttribute("data-active"),
    node.getAttribute("data-selected"),
  ]
    .map((item) => String(item || "").toLowerCase())
    .join(" ");
  const className = String(node.className || "").toLowerCase();
  if (
    /\btrue\b|\bactive\b|\bselected\b|\bchecked\b|\bcurrent\b|\bon\b/.test(
      attrs,
    )
  ) {
    return true;
  }
  if (
    /\b(is-active|active|selected|current|checked|chosen)\b/.test(className)
  ) {
    return true;
  }
  try {
    const style = window.getComputedStyle(node);
    const color = String(style?.color || "")
      .trim()
      .toLowerCase();
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const r = Number.parseInt(match[1], 10);
      const g = Number.parseInt(match[2], 10);
      const b = Number.parseInt(match[3], 10);
      if (r >= 200 && g <= 120 && b <= 120) return true;
    }
  } catch {
    // ignore computed style errors
  }
  return false;
}

function isLeafStrategyNode(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  const childElementCount = node.children?.length || 0;
  return childElementCount === 0 || childElementCount <= 1;
}

function estimateStrategyNodeArea(node) {
  if (!(node instanceof HTMLElement)) {
    return Number.POSITIVE_INFINITY;
  }
  const rect = node.getBoundingClientRect();
  return rect.width * rect.height;
}

async function waitForStrategyOptionActive(
  sectionLabel,
  optionTexts,
  timeoutMs = 1200,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const panel = findStrategyFilterPanel();
    const targets = panel
      ? findOptionCandidatesInFilterSection(panel, sectionLabel, optionTexts)
      : findStrategyClickableCandidatesByText(optionTexts);
    if (targets.some((node) => isStrategyControlActive(node))) {
      return true;
    }
    await waitForKeywordStrategyUi(120);
  }
  return false;
}

function clickStrategyElement(node) {
  const clickable =
    node.closest(
      'button, [role="button"], [role="tab"], [role="option"], a, li',
    ) || node;
  if (!(clickable instanceof HTMLElement)) {
    return;
  }
  clickable.scrollIntoView({
    block: "center",
    inline: "center",
    behavior: "auto",
  });
  const rect = clickable.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const pointerOpts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: cx,
    clientY: cy,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  const mouseOpts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: cx,
    clientY: cy,
    button: 0,
  };

  clickable.dispatchEvent(new MouseEvent("mousemove", mouseOpts));
  clickable.dispatchEvent(new MouseEvent("mouseover", mouseOpts));
  if (typeof PointerEvent === "function") {
    clickable.dispatchEvent(new PointerEvent("pointerover", pointerOpts));
    clickable.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...pointerOpts,
        buttons: 1,
      }),
    );
  }
  clickable.dispatchEvent(
    new MouseEvent("mousedown", {
      ...mouseOpts,
      buttons: 1,
    }),
  );
  if (typeof PointerEvent === "function") {
    clickable.dispatchEvent(
      new PointerEvent("pointerup", {
        ...pointerOpts,
        buttons: 0,
      }),
    );
  }
  clickable.dispatchEvent(new MouseEvent("mouseup", mouseOpts));
  clickable.dispatchEvent(new MouseEvent("click", mouseOpts));
}

async function waitForKeywordStrategyUi(ms = 300) {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

function randomStrategyDelay(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || min);
  return Math.round(min + Math.random() * (max - min));
}

/**
 * 处理评论采集
 */
async function handleCaptureComments(request, sendResponse) {
  const requestId =
    String(request?.captureRequestId || "").trim() ||
    `comments_${Date.now().toString(36)}`;
  if (activeCommentsCaptureRequestId) {
    sendResponse({
      ok: false,
      type: "comments",
      data: null,
      error: {
        code: "COMMENTS_CAPTURE_ALREADY_RUNNING",
        message: "当前页面已有评论采集在运行，请先停止或等待其结束",
      },
    });
    return;
  }

  activeCommentsCaptureRequestId = requestId;
  try {
    resetCancelFlag();

    const result = await captureComments({
      onProgress: (progress) => {
        reportCaptureProgress(request, progress);
      },
      expectedNoteId: String(request.expectedNoteId || ""),
      onlyLevel1: Boolean(request.onlyLevel1),
      maxDetectedItems: request.maxDetectedItems ?? request.maxItems,
      maxDurationMs: request.maxDurationMs,
      noNewContentThreshold: request.noNewContentThreshold,
      waitMinMs: request.waitMinMs,
      waitMaxMs: request.waitMaxMs,
      stallTimeoutMs: request.stallTimeoutMs,
      maxScrollTimes: request.maxScrollTimes || 50, // 兼容旧请求参数
      expandReplies: request.expandReplies || false, // 兼容旧请求参数
    });

    sendResponse(result);
  } catch (error) {
    console.error("[Content] Capture comments failed:", error);
    sendResponse({
      ok: false,
      type: "comments",
      data: null,
      error: {code: "CAPTURE_FAILED", message: error.message},
    });
  } finally {
    if (activeCommentsCaptureRequestId === requestId) {
      activeCommentsCaptureRequestId = "";
    }
  }
}

/**
 * 处理取消采集
 */
function handleCancelCapture(request, sendResponse) {
  try {
    const targetRequestId = String(request?.captureRequestId || "").trim();
    const listCaptureRunId = normalizeListCaptureRunId(
      request?.listCaptureRunId,
    );
    const matched =
      !targetRequestId || activeCaptureRequestIds.has(targetRequestId);
    const listCaptureMatched = rememberListCaptureCancellation(listCaptureRunId);
    if (matched || listCaptureMatched) {
      setCancelFlag(true);
    }
    try {
      const activeOverlayRunId = normalizeListCaptureRunId(
        activeListCaptureDebugOverlay?.getState?.()?.sessionId,
      );
      if (
        activeListCaptureDebugOverlay &&
        (!listCaptureRunId || activeOverlayRunId === listCaptureRunId)
      ) {
        activeListCaptureDebugOverlay.cancel("用户已请求停止采集");
      }
    } catch (error) {
      console.warn("[Content] List capture feedback cancel failed:", error);
    }
    const accepted = matched || listCaptureMatched;
    sendResponse({
      ok: true,
      message: accepted ? "取消信号已发送" : "目标采集已不在当前页面运行",
      captureRequestId: targetRequestId,
      listCaptureRunId,
      matched: accepted,
    });
  } catch (error) {
    console.error("[Content] Cancel capture failed:", error);
    sendResponse({
      ok: false,
      error: {code: "CANCEL_FAILED", message: error.message},
    });
  }
}

// ==================== 页面生命周期 ====================

startContentPageStateReporting({
  sendMessage: safeRuntimeSendMessage,
});
