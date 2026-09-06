// L3-A cancel-and-streaming-queue: original control flow, explicit state and compatibility ports.
export function createCancelAndStreamingQueueController({controllerState, controllerPorts, controllerOperations}) {
  const {
    MESSAGE_TYPE,
    chrome,
    clearInterval,
    console,
    createRecordSyncQueue,
    taskView,
    formatStreamingSyncSummary,
    refreshDataPool,
    refreshSyncHistory,
    setInterval,
    showMessage,
  } = controllerPorts;
  const maybeRunAutoSyncAfterDetailCapture = (...args) => controllerOperations.maybeRunAutoSyncAfterDetailCapture(...args);

  async function requestCaptureCancelSignal(
    preferTabId = null,
    captureRequestId = "",
  ) {
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

    const normalizedRequestId = String(captureRequestId || "").trim();
    const response = normalizedRequestId
      ? await chrome.runtime.sendMessage({
          type: MESSAGE_TYPE.CANCEL_CAPTURE,
          tabId: relayTabId,
          captureRequestId: normalizedRequestId,
        })
      : await chrome.runtime.sendMessage({
          type: MESSAGE_TYPE.RELAY_TO_CONTENT,
          tabId: relayTabId,
          payload: {action: "cancelCapture"},
        });
    if (response?.ok === false) {
      throw new Error(response?.error?.message || "取消请求发送失败");
    }
    return true;
  }

  function getKnownDetailRunnerTabIds(extraTabIds = []) {
    const tabIds = new Set(controllerState.detailBatchRunnerTabIds);
    const activeTabId = Number(controllerState.detailBatchRunnerTabId);
    if (Number.isSafeInteger(activeTabId) && activeTabId > 0) {
      tabIds.add(activeTabId);
    }
    for (const value of Array.isArray(extraTabIds) ? extraTabIds : []) {
      const tabId = Number(value);
      if (Number.isSafeInteger(tabId) && tabId > 0) tabIds.add(tabId);
    }
    return [...tabIds];
  }

  async function requestDetailRunnerCancelSignals({
    extraTabIds = [],
    fallbackTabId = null,
  } = {}) {
    const runnerTabIds = getKnownDetailRunnerTabIds(extraTabIds);
    if (runnerTabIds.length === 0) {
      return await requestCaptureCancelSignal(fallbackTabId);
    }
    const settled = await Promise.allSettled(
      runnerTabIds.map((tabId) => requestCaptureCancelSignal(tabId)),
    );
    return settled.some(
      (result) => result.status === "fulfilled" && result.value === true,
    );
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
    const input = taskView.readExpandedKeywordsInput();
    const keywords = input.present
      ? parseKeywordsFromMultilineInput(input.value)
      : [...controllerState.expandedKeywordsBuffer];
    return dedupe ? dedupeKeywords(keywords) : keywords;
  }

  function sleepWithStop(
    ms,
    shouldStop,
    {onTick = null, tickEveryMs = 30 * 1000} = {},
  ) {
    return new Promise((resolve) => {
      const start = Date.now();
      const finishAt = start + Math.max(0, Number(ms) || 0);
      let lastTickAt = 0;
      const id = setInterval(() => {
        const now = Date.now();
        if ((shouldStop && shouldStop()) || now >= finishAt) {
          clearInterval(id);
          resolve();
          return;
        }
        if (
          typeof onTick === "function" &&
          (lastTickAt === 0 || now - lastTickAt >= Math.max(1000, tickEveryMs))
        ) {
          lastTickAt = now;
          try {
            onTick(Math.max(0, finishAt - now));
          } catch (error) {
            console.warn("[Sidebar] Wait progress callback failed:", error);
          }
        }
      }, 1000);
    });
  }

  function createStreamingDetailAutoSyncQueue(
    settings,
    {
      shouldStop = null,
      signal = null,
      captureTaskId = "",
      resolveCaptureTaskItemAttempt = null,
    } = {},
  ) {
    return createRecordSyncQueue({
      enabled: Boolean(
        settings?.autoDetailCaptureAfterListCapture &&
          settings?.autoSyncAfterDetailCapture,
      ),
      shouldStop,
      signal,
      retryDelaysMs: [1000, 3000, 8000],
      shouldRetry: isTransientStreamingSyncFailure,
      processRecord: async ({recordId, meta = {}, signal: jobSignal = null}) => {
        const captureAttempt =
          typeof resolveCaptureTaskItemAttempt === "function"
            ? resolveCaptureTaskItemAttempt(meta)
            : null;
        const result = await maybeRunAutoSyncAfterDetailCapture(settings, {
          sourceLabel: String(meta?.sourceLabel || "当前笔记"),
          recordIds: [recordId],
          silent: true,
          refreshAfter: false,
          shouldStop,
          signal: jobSignal || signal,
          captureTaskId,
          captureTaskItemAttemptId: String(
            captureAttempt?.attemptId || "",
          ).trim(),
          captureTaskItemRequestHash: String(
            captureAttempt?.requestHash || "",
          ).trim(),
        });
        return {
          ...result,
          blocked: result?.phase === "check",
          skipped:
            Boolean(result?.skipped) ||
            (Number(result?.successCount || 0) === 0 &&
              Number(result?.skippedCount || 0) > 0),
        };
      },
    });
  }

  function isTransientStreamingSyncFailure(result = {}) {
    if (
      result?.ok !== false ||
      result?.blocked ||
      result?.skipped ||
      result?.canceled ||
      result?.phase === "check"
    ) {
      return false;
    }
    const fragments = [
      result?.phase,
      result?.reason,
      result?.message,
      result?.pausedReason,
      result?.pausedMessage,
      result?.error?.code,
      result?.error?.message,
      ...(Array.isArray(result?.results)
        ? result.results.flatMap((item) => [
            item?.reason,
            item?.message,
            item?.error?.code,
            item?.error?.message,
          ])
        : []),
    ]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    const failureText = fragments.join(" ");
    return /(?:timeout|timed out|network|fetch|offline|rate.?limit|too many requests|econn|enet|eai_again|socket|connection|http[_ ]?5\d\d|\b(?:429|500|502|503|504)\b|网络|超时|限流|请求失败|服务繁忙|连接(?:失败|中断|重置))/i.test(
      failureText,
    );
  }

  function routeDetailItemToStreamingSync(
    streamingSyncQueue,
    progress = {},
    {sourceLabel = "当前笔记", keyword = ""} = {},
  ) {
    if (!streamingSyncQueue?.enabled) {
      return;
    }
    const recordId = String(progress?.recordId || "").trim();
    if (!recordId) {
      return;
    }
    const phase = String(progress?.phase || "");
    if (
      phase === "detail_item_filtered" ||
      phase === "detail_item_skipped"
    ) {
      streamingSyncQueue.markExcluded(recordId);
      return;
    }
    // Failed detail items must wait until the whole enhancement result is known.
    // Non-terminal failures are picked up by enqueueMissing below; an identity
    // or safety stop returns before that point, so unverified data never starts
    // syncing while the terminal decision is still in flight.
    if (phase !== "detail_item_done") {
      return;
    }
    streamingSyncQueue.enqueue(recordId, {sourceLabel, keyword});
  }

  function settleKeywordRecordsForStreamingSync(
    streamingSyncQueue,
    settled = {},
    {ownerCurrent = true} = {},
  ) {
    if (!streamingSyncQueue?.enabled) {
      return;
    }
    const recordIds = Array.from(
      new Set(
        (Array.isArray(settled?.recordIds) ? settled.recordIds : [])
          .map((recordId) => String(recordId || "").trim())
          .filter(Boolean),
      ),
    );
    // List capture has already persisted these records locally. Register them
    // before the request/attempt ownership fence so a superseded runner can
    // still produce a complete, attempt-local closure ledger.
    streamingSyncQueue.registerCaptured(recordIds);
    if (recordIds.length === 0) {
      return;
    }

    const result =
      settled?.result && typeof settled.result === "object"
        ? settled.result
        : {};
    const mustExclude = Boolean(
      !ownerCurrent ||
        settled?.canceled ||
        settled?.securityBlocked ||
        result.canceled ||
        result.fatal ||
        result.securityBlocked ||
        result.platformSafetyBlocked ||
        result.requiresManualAction ||
        result.integrityBlocked ||
        result.enhanceResult?.integrityBlocked,
    );
    if (mustExclude) {
      recordIds.forEach((recordId) => streamingSyncQueue.markExcluded(recordId));
      return;
    }

    streamingSyncQueue.enqueueMissing(recordIds, {
      sourceLabel: `关键词「${String(settled?.keyword || "").trim()}」笔记`,
      keyword: String(settled?.keyword || "").trim(),
    });
    // A stop predicate can close the queue between registration and enqueue.
    // Explicitly classify anything that could not enter the queue so the local
    // closure proof never hangs on an unclassified saved record.
    recordIds.forEach((recordId) => {
      if (!streamingSyncQueue.hasSeen(recordId)) {
        streamingSyncQueue.markExcluded(recordId);
      }
    });
  }

  function appendStreamingSyncSummary(message, streamingSyncQueue) {
    const summary = formatStreamingSyncSummary(streamingSyncQueue?.getStats?.());
    return summary ? `${String(message || "").trim()} · ${summary}` : message;
  }

  async function drainStreamingDetailSyncQueue(
    streamingSyncQueue,
    {round = null, updateProgress = null, notifyProgress = null} = {},
  ) {
    if (!streamingSyncQueue?.enabled) {
      const disabledStats = streamingSyncQueue?.getStats?.();
      return disabledStats && typeof disabledStats === "object"
        ? {...disabledStats, drainCompleted: true}
        : null;
    }

    const before = streamingSyncQueue.getStats();
    if (Number(before.remainingCount || 0) > 0) {
      const waitingProgress = {
        current: Number(before.processedCount || 0),
        total: Number(before.enqueuedCount || 0),
        round,
        phase: before.reconciliationRequired === true
          ? "streaming_sync_reconciliation_required"
          : "streaming_sync_drain",
        message: before.reconciliationRequired === true
          ? `同步已挂起，${Number(before.remainingCount || 0)} 条数据待核对；不会自动重发`
          : `采集已结束，正在上传剩余 ${Number(before.remainingCount || 0)} 条数据...`,
      };
      updateProgress?.(waitingProgress);
      notifyProgress?.(waitingProgress);
    }

    const result = await streamingSyncQueue.drain();
    await Promise.all([refreshDataPool(), refreshSyncHistory()]).catch(
      () => null,
    );
    const reconciliationRequired = result.reconciliationRequired === true;
    const doneProgress = {
      current: Number(result.processedCount || 0),
      total: Number(result.enqueuedCount || 0),
      round,
      phase: reconciliationRequired
        ? "streaming_sync_reconciliation_required"
        : "streaming_sync_done",
      syncSuccessCount: Number(result.successCount || 0),
      syncFailedCount: Number(result.failedCount || 0),
      syncSkippedCount: Number(result.skippedCount || 0),
      syncRemainingCount: Number(result.remainingCount || 0),
      syncRetryCount: Number(result.retryCount || 0),
      message: reconciliationRequired
        ? `同步已挂起，${Number(result.remainingCount || 0)} 条数据待核对；不会自动重发`
        : `边采边同步完成：成功 ${Number(result.successCount || 0)}，失败 ${Number(result.failedCount || 0)}，跳过 ${Number(result.skippedCount || 0)}${Number(result.retryCount || 0) > 0 ? `，瞬时重试 ${Number(result.retryCount || 0)}` : ""}`,
    };
    updateProgress?.(doneProgress);
    notifyProgress?.(doneProgress);

    if (result.blocked) {
      showMessage(
        `边采边同步未执行：${result.error?.message || "同步前检查失败"}`,
        "warning",
      );
    } else if (Number(result.failedCount || 0) > 0) {
      showMessage(
        `边采边同步部分失败：成功 ${Number(result.successCount || 0)}，失败 ${Number(result.failedCount || 0)}`,
        "warning",
      );
    }
    return {
      ...result,
      // This bit is set only by the awaited terminal drain path. A bare queue
      // snapshot, a missing result, or a progress payload with defaulted zeroes
      // must never be treated as proof that task-owned uploads are gone.
      drainCompleted: !reconciliationRequired,
    };
  }

  return Object.freeze({
    requestCaptureCancelSignal,
    getKnownDetailRunnerTabIds,
    requestDetailRunnerCancelSignals,
    parseKeywordsFromMultilineInput,
    dedupeKeywords,
    getExpandedKeywordsFromTextarea,
    sleepWithStop,
    createStreamingDetailAutoSyncQueue,
    isTransientStreamingSyncFailure,
    routeDetailItemToStreamingSync,
    settleKeywordRecordsForStreamingSync,
    appendStreamingSyncSummary,
    drainStreamingDetailSyncQueue,
  });
}
