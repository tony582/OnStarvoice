// L3-A monitor-execution: original control flow, explicit state and compatibility ports.
export function createMonitorExecutionController({controllerState, controllerBindings, controllerPorts, controllerOperations}) {
  const {
    DEFAULT_MONITOR_SETTINGS,
    ERROR_REASON,
    MONITOR_REQUIRED_MESSAGE,
    MONITOR_STATUS,
    MONITOR_SUBJECT_TYPE,
    addSyncHistoryEntry,
    batchCaptureByUrls,
    batchCaptureDetailsForRecords,
    buildCommentLeadsConfigFromSettings,
    chrome,
    cloudTargetedPostApi,
    collectBatchRecordIds,
    console,
    detectPlatformFromUrl,
    endCaptureTaskSession,
    finishMonitorExecution,
    getCaptureSettings,
    getCurrentMonitor,
    getCurrentRuntime,
    getCurrentTarget,
    getRecords,
    hideProgress,
    isMonitorAuthReady,
    isMonitorPublishMomentInWindow,
    loadMonitorSubscriptions,
    normalizeMonitorRunnerPlatform,
    normalizeMonitorSettingsInput,
    normalizeMonitorSubjectType,
    refreshSyncHistory,
    refreshVerifiedAuthSnapshot,
    resolveMonitorPublishWindowBounds,
    resolveMonitorRecordPublishMoment,
    resolveMonitorRunHistoryState,
    resolveMonitorRunnerAccountUrl,
    resolveMonitorRunnerCaptureParams,
    resolveMonitorRunnerName,
    runEnhancementWithSingleRetry,
    runMonitorNow,
    showMessage,
    showProgress,
    startMonitorExecution,
    summarizeMonitorSyncResult,
    syncRecordBatch,
  } = controllerPorts;
  const releaseCaptureTaskOwner = (...args) => controllerOperations.releaseCaptureTaskOwner(...args);
  const resolveCaptureTaskTerminalStatus = (...args) => controllerOperations.resolveCaptureTaskTerminalStatus(...args);
  const startOptionalCaptureAssistSession = (...args) => controllerOperations.startOptionalCaptureAssistSession(...args);
  const supportsPersistentCaptureTaskPlatform = (...args) => controllerOperations.supportsPersistentCaptureTaskPlatform(...args);

  function reportMonitorRunProgress(
    onProgress,
    progress = {},
    fallbackMessage = "",
  ) {
    const message =
      String(progress?.message || fallbackMessage || "").trim() ||
      "正在处理账号巡查...";
    showProgress(message);
    if (typeof onProgress === "function") {
      Promise.resolve(
        onProgress({
          ...progress,
          message,
          updatedAt: new Date().toISOString(),
        }),
      ).catch((error) => {
        console.warn("[Sidebar] Monitor progress callback failed:", error);
      });
    }
    return message;
  }

  async function resolveMonitorRecordIdsForPublishWindow({
    recordIds = [],
    monitorSettings = {},
    captureSettings = {},
    displayName = "",
    index = 0,
    total = 1,
    shouldStop = null,
    onProgress = null,
  } = {}) {
    const uniqueRecordIds = [...new Set(recordIds.filter(Boolean))];
    const verifyPublishDateFromDetail =
      captureSettings.verifyPublishDateFromDetail === true;
    const scanLatestPostsByCount =
      captureSettings.scanLatestPostsByCount === true;
    if (scanLatestPostsByCount) {
      const requestedPostsLimit = Number(monitorSettings.postsLimit);
      const selectedIds =
        Number.isSafeInteger(requestedPostsLimit) && requestedPostsLimit > 0
          ? uniqueRecordIds.slice(0, requestedPostsLimit)
          : uniqueRecordIds;
      return {
        recordIds: selectedIds,
        scannedCount: uniqueRecordIds.length,
        filteredCount: Math.max(0, uniqueRecordIds.length - selectedIds.length),
        unknownCount: 0,
        windowLabel: `最近 ${selectedIds.length} 篇`,
        detailResult: null,
      };
    }
    const bounds = resolveMonitorPublishWindowBounds(monitorSettings);

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

    let detailCandidateIds = uniqueRecordIds;
    if (!verifyPublishDateFromDetail) {
      const preRecords = await getRecords(uniqueRecordIds);
      const preRecordById = new Map(
        preRecords.map((record) => [record.id, record]),
      );
      const prefilterNowMs = Date.now();
      detailCandidateIds = uniqueRecordIds.filter((recordId) => {
        const moment = resolveMonitorRecordPublishMoment(
          preRecordById.get(recordId),
          prefilterNowMs,
        );
        return (
          !moment || isMonitorPublishMomentInWindow(moment, bounds)
        );
      });
    }

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

    reportMonitorRunProgress(
      onProgress,
      {
        phase: "profile_publish_date_verification",
        current: 0,
        total: detailCandidateIds.length,
      },
      `正在读取发布时间 (${index + 1}/${total})：${displayName} · ${bounds.label}`,
    );
    const detailResult = await runEnhancementWithSingleRetry({
      recordIds: detailCandidateIds,
      shouldStop,
      onRetryScheduled: ({recordIds: retryRecordIds, retryCount, maxRetries}) => {
        reportMonitorRunProgress(
          onProgress,
          {
            phase: "profile_publish_date_retry_waiting",
            current: 0,
            total: retryRecordIds.length,
            autoRetryCount: retryCount,
            autoRetryMaxRetries: maxRetries,
          },
          `发布时间读取工作页中断，正在续跑剩余 ${retryRecordIds.length} 条`,
        );
      },
      runAttempt: async (attemptRecordIds, attemptContext = {}) => {
        const isRetry = attemptContext.isRetry === true;
        const retryLabel = isRetry
          ? `${attemptContext.retryCount}/${attemptContext.maxRetries}`
          : "";
        return await batchCaptureDetailsForRecords(attemptRecordIds, {
          shouldStop,
          onProgress: (progress = {}) => {
            const detailMessage =
              String(progress.message || "").trim() || "正在补采作品详情...";
            reportMonitorRunProgress(
              onProgress,
              {
                ...progress,
                phase: isRetry
                  ? "profile_publish_date_retry"
                  : String(
                      progress.phase ||
                        "profile_publish_date_verification",
                    ),
                autoRetryCount: isRetry ? attemptContext.retryCount : 0,
                autoRetryMaxRetries: isRetry
                  ? attemptContext.maxRetries
                  : 0,
              },
              `正在读取发布时间 (${index + 1}/${total})：${displayName} · ${
                isRetry ? `续跑 ${retryLabel} · ` : ""
              }${detailMessage}`,
            );
          },
          includeComments: false,
          includeBloggerMetrics: false,
          // 发布时间必须来自本轮真实进入详情页后的结果。即使此前采过详情，
          // 也不能复用旧快照，否则会把旧日期误当作本轮巡查证据。
          skipAlreadyCaptured: false,
          detailNavTimeoutMs: captureSettings.detailNavTimeoutMs,
          detailAfterNavWaitMs: captureSettings.detailAfterNavWaitMs,
          profileAfterNavWaitMs: captureSettings.profileAfterNavWaitMs,
        });
      },
    });

    const stoppedByCaller =
      typeof shouldStop === "function" && shouldStop();
    const terminalError = detailResult?.canceled || stoppedByCaller
      ? {
          errorCode: "capture_canceled",
          errorMessage: "发布时间读取已取消",
          canceled: true,
        }
      : detailResult?.securityBlocked
        ? {
            errorCode: "capture_security_blocked",
            errorMessage: "发布时间读取遇到安全验证，已停止巡查",
          }
        : detailResult?.runnerInterrupted
          ? {
              errorCode: "capture_runner_interrupted",
              errorMessage: "发布时间读取工作页已关闭或中断",
            }
          : null;
    if (terminalError) {
      return {
        recordIds: [],
        scannedCount: uniqueRecordIds.length,
        filteredCount: uniqueRecordIds.length,
        unknownCount: 0,
        windowLabel: bounds.label,
        detailResult,
        failed: true,
        ...terminalError,
      };
    }

    const detailItems = Array.isArray(detailResult?.results)
      ? detailResult.results
      : [];
    const successfulDetailRecordIds = detailItems
      .filter(
        (item) =>
          item?.ok === true &&
          item?.filtered !== true &&
          item?.reason !== "already_captured",
      )
      .map((item) => item?.recordId)
      .filter((recordId) => detailCandidateIds.includes(recordId));
    const successfulDetailRecordIdSet = new Set(successfulDetailRecordIds);
    const failedDetailCount = detailCandidateIds.filter(
      (recordId) => !successfulDetailRecordIdSet.has(recordId),
    ).length;
    if (detailResult?.ok === false || failedDetailCount > 0) {
      const firstFailure = detailItems.find((item) => item?.ok === false);
      const failureMessage =
        String(
          firstFailure?.diagnosticMessage ||
            firstFailure?.message ||
            detailResult?.error?.message ||
            "",
        ).trim() || "部分作品未能完成发布时间读取";
      return {
        recordIds: [],
        scannedCount: uniqueRecordIds.length,
        filteredCount: uniqueRecordIds.length,
        unknownCount: 0,
        windowLabel: bounds.label,
        detailResult,
        failed: true,
        errorCode: "publish_date_capture_failed",
        errorMessage: failureMessage,
        successfulDetailCount: successfulDetailRecordIds.length,
        failedDetailCount,
      };
    }

    // 只读取本轮明确成功的详情记录；不得让失败项沿用数据库里的旧详情日期。
    const records = await getRecords(successfulDetailRecordIds);
    const recordById = new Map(records.map((record) => [record.id, record]));
    const selectedIds = [];
    let unknownCount = 0;
    const nowMs = Date.now();

    successfulDetailRecordIds.forEach((recordId) => {
      const record = recordById.get(recordId);
      const moment = resolveMonitorRecordPublishMoment(record, nowMs, {
        detailOnly: verifyPublishDateFromDetail,
      });
      if (!moment) {
        unknownCount += 1;
        return;
      }
      if (isMonitorPublishMomentInWindow(moment, bounds)) {
        selectedIds.push(recordId);
      }
    });

    if (unknownCount > 0) {
      return {
        recordIds: [],
        scannedCount: uniqueRecordIds.length,
        filteredCount: uniqueRecordIds.length,
        unknownCount,
        windowLabel: bounds.label,
        detailResult,
        failed: true,
        errorCode: "publish_date_unknown",
        errorMessage: `${unknownCount} 篇作品未能读取到可信的发布时间`,
        successfulDetailCount: successfulDetailRecordIds.length,
        failedDetailCount: 0,
      };
    }

    const requestedPostsLimit = Number(monitorSettings.postsLimit);
    const limitedSelectedIds =
      Number.isSafeInteger(requestedPostsLimit) && requestedPostsLimit > 0
        ? selectedIds.slice(0, requestedPostsLimit)
        : selectedIds;

    return {
      recordIds: limitedSelectedIds,
      scannedCount: uniqueRecordIds.length,
      filteredCount: Math.max(
        0,
        uniqueRecordIds.length - limitedSelectedIds.length,
      ),
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

  async function runMonitorCommentPatrolWithCaptureTaskSession({
    platform = "",
    runnerTabId = null,
    captureTaskContext = null,
    shouldStop = null,
    run = null,
  } = {}) {
    if (typeof run !== "function") {
      const error = new Error("评论巡查缺少详情采集执行器");
      error.code = "COMMENT_PATROL_RUNNER_REQUIRED";
      throw error;
    }

    const taskId = String(captureTaskContext?.taskId || "").trim();
    if (!taskId) {
      return await run();
    }

    const normalizedPlatform = String(platform || "")
      .trim()
      .toLowerCase();
    const normalizedRunnerTabId = Number(runnerTabId);
    if (!supportsPersistentCaptureTaskPlatform(normalizedPlatform)) {
      const error = new Error("官方账号评论巡查仅支持小红书和抖音");
      error.code = "capture_task_platform_unsupported";
      throw error;
    }
    if (
      !Number.isSafeInteger(normalizedRunnerTabId) ||
      normalizedRunnerTabId <= 0
    ) {
      const error = new Error("官方账号评论巡查缺少有效的账号页面");
      error.code = "invalid_capture_task_source_tab";
      throw error;
    }

    const assistSession = await startOptionalCaptureAssistSession({
      taskId,
      attemptId: String(captureTaskContext?.attemptId || "").trim(),
      tabId: normalizedRunnerTabId,
      label:
        String(captureTaskContext?.label || "").trim() ||
        "官方账号评论巡查",
      platform: normalizedPlatform,
      ownerRequired: captureTaskContext?.ownerRequired !== false,
    });

    let result = null;
    let runError = null;
    try {
      result = await run({
        captureAssistActive: assistSession?.active === true,
        captureTaskId: assistSession?.active === true ? taskId : "",
      });
    } catch (error) {
      runError = error;
    }

    let stopped = false;
    try {
      stopped = typeof shouldStop === "function" && shouldStop() === true;
    } catch {
      stopped = true;
    }
    const canceled = stopped || result?.canceled === true;
    const taskStatus = runError
      ? "failed"
      : canceled
        ? "canceled"
        : result?.ok === false || Number(result?.failedCount || 0) > 0
          ? "completed_with_failures"
          : "completed";
    const terminal = resolveCaptureTaskTerminalStatus({
      taskStatus,
      error: runError,
      canceled,
    });

    let captureTaskEnd = null;
    try {
      captureTaskEnd = await endCaptureTaskSession({
        taskId,
        ...terminal,
      });
    } catch (error) {
      captureTaskEnd = {ok: false, error};
    }
    const captureTaskEnded =
      captureTaskEnd?.ok === true ||
      captureTaskEnd?.reason === "capture_task_not_found" ||
      captureTaskEnd?.response?.error?.code === "capture_task_not_found";
    if (captureTaskEnded) {
      releaseCaptureTaskOwner(taskId);
    } else {
      const cleanupError = new Error(
        captureTaskEnd?.response?.error?.message ||
          captureTaskEnd?.error?.message ||
          "评论巡查结束后采集辅助未能安全释放",
      );
      cleanupError.code = String(
        captureTaskEnd?.response?.error?.code ||
          captureTaskEnd?.reason ||
          "CAPTURE_TASK_CLEANUP_FAILED",
      ).trim();
      if (runError) cleanupError.cause = runError;
      throw cleanupError;
    }

    if (runError) throw runError;
    return result;
  }

  async function executeMonitorRunItem({
    runItem = {},
    monitorItem = {},
    index = 0,
    total = 1,
    monitorSettings = {},
    captureSettings = {},
    runnerTabId = null,
    executionPreclaimed = false,
    captureTaskContext = null,
    shouldStop = null,
    onProgress = null,
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
      reportMonitorRunProgress(
        onProgress,
        {
          phase: "profile_scan_start",
          current: 0,
          total,
        },
        `正在扫描监控账号 (${index + 1}/${total})：${displayName}`,
      );

      if (!executionPreclaimed) {
        const startResult = await startMonitorExecution(executionId);
        if (!startResult?.ok) {
          const errorMessage =
            String(startResult?.message || "").trim() ||
            "该账号扫描已被其他执行端领取或已结束";
          console.warn(
            "[Sidebar] Monitor execution is no longer claimable:",
            startResult,
          );
          return {
            ...baseResult,
            status: "failed",
            errorCode: "monitor_execution_not_claimable",
            errorMessage,
          };
        }
      }

      const captureResult = await batchCaptureByUrls({
        urls: [accountUrl],
        mode: "blogger_notes",
        ...(Number.isSafeInteger(Number(runnerTabId)) &&
        Number(runnerTabId) > 0
          ? {runnerTabId: Number(runnerTabId)}
          : {}),
        captureParams: resolveMonitorRunnerCaptureParams(
          monitorSettings,
          captureSettings,
        ),
        onProgress: (progress = {}) => {
          const captureMessage =
            String(progress.message || "").trim() || "正在采集账号作品...";
          reportMonitorRunProgress(
            onProgress,
            {
              ...progress,
              phase: String(progress.phase || "profile_list_capture"),
            },
            `正在扫描监控账号 (${index + 1}/${total})：${displayName} · ${captureMessage}`,
          );
        },
        shouldStop,
      });
      const recordIds = collectBatchRecordIds(captureResult);
      const captureFailure = cloudTargetedPostApi.projectCaptureFailure(
        [
          captureResult,
          ...(Array.isArray(captureResult?.results)
            ? captureResult.results
            : []),
        ],
        {
          fallbackCode: "CAPTURE_FAILED",
          stage: "profile_scan",
          fallbackMessage: "采集账号作品失败",
        },
      );
      const incompleteCaptureEntries = Array.isArray(captureResult?.results)
        ? captureResult.results.filter(
            (entry) => entry?.partial === true || entry?.scanComplete === false,
          )
        : [];
      const profileScanComplete = Boolean(
        captureResult?.scanComplete === true &&
          captureResult?.partial !== true &&
          incompleteCaptureEntries.length === 0,
      );

      if (captureFailure.requiresManualAction === true) {
        await finishMonitorExecutionSafely(executionId, {
          status: "failed",
          recordsFound: recordIds.length,
          errorMessage: captureFailure.message,
        });
        return {
          ...baseResult,
          status: "failed",
          scannedCount: recordIds.length,
          hitCount: 0,
          errorCode: captureFailure.code,
          errorCategory: captureFailure.category || "platform_safety_block",
          errorMessage: captureFailure.message,
          securityBlocked: captureFailure.securityBlocked === true,
          platformSafetyBlocked:
            captureFailure.platformSafetyBlocked === true,
          requiresManualAction: true,
          retryable: false,
          securityEvidence: captureFailure.securityEvidence || null,
          error: captureFailure,
        };
      }

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

      if (!profileScanComplete) {
        const incompleteFailure = cloudTargetedPostApi.projectCaptureFailure(
          [
            ...incompleteCaptureEntries.map((entry) => entry?.error),
            ...incompleteCaptureEntries,
            captureResult?.error,
            captureResult,
          ],
          {
            fallbackCode: "PROFILE_SCAN_INCOMPLETE",
            stage: "profile_scan",
            fallbackMessage:
              "账号作品列表未完整采集，已保留本轮结果并等待重试",
          },
        );
        await finishMonitorExecutionSafely(executionId, {
          status: "failed",
          recordsFound: recordIds.length,
          errorMessage: incompleteFailure.message,
        });
        return {
          ...baseResult,
          status: "failed",
          partial: true,
          scanComplete: false,
          incompleteReason: String(
            captureResult?.incompleteReason || "partial_capture",
          ),
          scannedCount: recordIds.length,
          hitCount: 0,
          errorCode: incompleteFailure.code,
          errorCategory: incompleteFailure.category || "capture_incomplete",
          errorMessage: incompleteFailure.message,
          retryable: incompleteFailure.retryable !== false,
          error: incompleteFailure,
          captureResult,
        };
      }

      if (!captureResult?.ok && recordIds.length === 0) {
        await finishMonitorExecutionSafely(executionId, {
          status: "failed",
          errorMessage: captureFailure.message,
        });
        return {
          ...baseResult,
          status: "failed",
          errorCode: captureFailure.code,
          errorCategory: captureFailure.category || "",
          errorMessage: captureFailure.message,
          retryable: captureFailure.retryable,
          error: captureFailure,
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
          noResults: true,
          resultKind: "profile_scan_no_new_posts",
          businessOutcome: "profile_scan_no_new_posts",
          qualifyingCount: 0,
          scanComplete: true,
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
        onProgress,
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
      if (publishFilterResult.failed) {
        const errorCode =
          String(publishFilterResult.errorCode || "").trim() ||
          "publish_date_capture_failed";
        const errorMessage =
          String(publishFilterResult.errorMessage || "").trim() ||
          "作品发布时间核验失败";
        await finishMonitorExecutionSafely(executionId, {
          status: "failed",
          recordsFound: 0,
          errorMessage,
        });
        return {
          ...baseResult,
          status: "failed",
          scannedCount: publishFilterResult.scannedCount,
          hitCount: 0,
          filteredCount: publishFilterResult.filteredCount,
          unknownPublishTimeCount: publishFilterResult.unknownCount,
          publishWindowLabel: publishFilterResult.windowLabel,
          errorCode,
          errorMessage,
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
          noResults: true,
          resultKind: "profile_scan_no_new_posts",
          businessOutcome: "profile_scan_no_new_posts",
          qualifyingCount: 0,
          scanComplete: true,
          scannedCount: publishFilterResult.scannedCount,
          hitCount: 0,
          filteredCount: publishFilterResult.filteredCount,
          unknownPublishTimeCount: publishFilterResult.unknownCount,
          publishWindowLabel: publishFilterResult.windowLabel,
          captureResult,
          detailResult: publishFilterResult.detailResult,
        };
      }

      const shouldCaptureComments =
        captureSettings.includeComments === true ||
        captureSettings.includeCommentsOnDetailCapture === true;
      let commentDetailResult = null;
      if (shouldCaptureComments) {
        reportMonitorRunProgress(
          onProgress,
          {
            phase: "profile_comment_patrol",
            current: 0,
            total: hitRecordIds.length,
          },
          `正在巡查账号评论 (${index + 1}/${total})：${displayName} · ${hitRecordIds.length} 条作品`,
        );
        commentDetailResult =
          await runMonitorCommentPatrolWithCaptureTaskSession({
            platform,
            runnerTabId,
            captureTaskContext,
            shouldStop,
            run: async ({captureTaskId = ""} = {}) =>
              await runEnhancementWithSingleRetry({
                recordIds: hitRecordIds,
                shouldStop,
                onRetryScheduled: ({
                  recordIds: retryRecordIds,
                  retryCount,
                  maxRetries,
                }) => {
                  reportMonitorRunProgress(
                    onProgress,
                    {
                      phase: "profile_comment_retry_waiting",
                      current: 0,
                      total: retryRecordIds.length,
                      autoRetryCount: retryCount,
                      autoRetryMaxRetries: maxRetries,
                    },
                    `评论巡查工作页中断，正在续跑剩余 ${retryRecordIds.length} 条`,
                  );
                },
                runAttempt: async (attemptRecordIds, attemptContext = {}) => {
                  const isRetry = attemptContext.isRetry === true;
                  const retryLabel = isRetry
                    ? `${attemptContext.retryCount}/${attemptContext.maxRetries}`
                    : "";
                  return await batchCaptureDetailsForRecords(attemptRecordIds, {
                    shouldStop,
                    onProgress: (progress = {}) => {
                      const commentMessage =
                        String(progress.message || "").trim() ||
                        "正在采集作品评论...";
                      reportMonitorRunProgress(
                        onProgress,
                        {
                          ...progress,
                          phase: isRetry
                            ? "profile_comment_retry"
                            : String(
                                progress.phase || "profile_comment_patrol",
                              ),
                          autoRetryCount: isRetry
                            ? attemptContext.retryCount
                            : 0,
                          autoRetryMaxRetries: isRetry
                            ? attemptContext.maxRetries
                            : 0,
                        },
                        `正在巡查账号评论 (${index + 1}/${total})：${displayName} · ${
                          isRetry ? `续跑 ${retryLabel} · ` : ""
                        }${commentMessage}`,
                      );
                    },
                    includeComments: true,
                    includeBloggerMetrics: false,
                    // 官方账号评论巡查每次都要重新进入命中作品采评论，不能被
                    // “已采过详情”的增量规则跳过。
                    skipAlreadyCaptured: false,
                    enableAiRelevancePrefilter: false,
                    commentsMaxDetectedItems:
                      captureSettings.detailCommentsMaxDetectedItems ??
                      captureSettings.commentsMaxDetectedItems ??
                      50,
                    detailNavTimeoutMs: captureSettings.detailNavTimeoutMs,
                    detailAfterNavWaitMs: captureSettings.detailAfterNavWaitMs,
                    profileAfterNavWaitMs: captureSettings.profileAfterNavWaitMs,
                    waitForegroundTabId:
                      Number.isSafeInteger(Number(runnerTabId)) &&
                      Number(runnerTabId) > 0
                        ? Number(runnerTabId)
                        : null,
                    captureTaskId: String(captureTaskId || "").trim(),
                  });
                },
              }),
          });

        if (
          commentDetailResult?.canceled ||
          (typeof shouldStop === "function" && shouldStop())
        ) {
          await finishMonitorExecutionSafely(executionId, {
            status: "failed",
            recordsFound: hitRecordIds.length,
            errorMessage: "评论巡查已取消",
          });
          return {
            ...baseResult,
            status: "failed",
            scannedCount: publishFilterResult.scannedCount,
            hitCount: 0,
            filteredCount: publishFilterResult.filteredCount,
            unknownPublishTimeCount: publishFilterResult.unknownCount,
            publishWindowLabel: publishFilterResult.windowLabel,
            errorCode: "capture_canceled",
            errorMessage: "评论巡查已取消",
            captureResult,
            publishDetailResult: publishFilterResult.detailResult,
            detailResult: commentDetailResult,
          };
        }
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
          captureTaskId: String(
            captureTaskContext?.captureTaskId || "",
          ).trim(),
          captureTaskItemAttemptId: String(
            captureTaskContext?.captureTaskItemAttemptId || "",
          ).trim(),
          captureTaskItemRequestHash: String(
            captureTaskContext?.captureTaskItemRequestHash || "",
          ).trim(),
          captureSettings,
          commentLeadsConfig: buildCommentLeadsConfigFromSettings(captureSettings),
          shouldStop,
        },
      );
      const syncStats = summarizeMonitorSyncResult(syncResult);
      const hasSyncFailure =
        !syncResult?.ok || syncStats.failedCount > 0 || syncStats.successCount === 0;
      const hasCommentCaptureFailure =
        shouldCaptureComments &&
        (commentDetailResult?.ok === false ||
          Number(commentDetailResult?.failedCount || 0) > 0);
      const hasTaskFailure = hasSyncFailure || hasCommentCaptureFailure;
      const errorMessage = hasCommentCaptureFailure
        ? `评论巡查部分失败：成功 ${Math.max(
            0,
            Number(commentDetailResult?.successCount) || 0,
          )}，失败 ${Math.max(
            0,
            Number(commentDetailResult?.failedCount) || 0,
          )}`
        : hasSyncFailure
          ? syncResult?.message ||
          syncResult?.error?.message ||
          `监控命中同步失败 ${syncStats.failedCount} 条`
          : "";

      await finishMonitorExecutionSafely(executionId, {
        status: hasTaskFailure ? "failed" : "succeeded",
        recordsFound: hitRecordIds.length,
        newRecords: syncStats.insertedCount,
        updatedRecords: syncStats.updatedCount,
        negativeCount: syncStats.negativeCount,
        errorMessage,
      });

      return {
        ...baseResult,
        status: hasTaskFailure ? "failed" : "success",
        partial: hasTaskFailure,
        scanComplete: !hasTaskFailure,
        incompleteReason: hasTaskFailure
          ? "profile_postprocessing_failed"
          : "",
        scannedCount: publishFilterResult.scannedCount,
        hitCount: syncStats.successCount,
        filteredCount: publishFilterResult.filteredCount,
        unknownPublishTimeCount: publishFilterResult.unknownCount,
        publishWindowLabel: publishFilterResult.windowLabel,
        errorCode: hasCommentCaptureFailure
          ? "comment_capture_failed"
          : hasSyncFailure
            ? "sync_failed"
            : "",
        errorMessage,
        syncResult,
        captureResult,
        publishDetailResult: publishFilterResult.detailResult,
        detailResult: commentDetailResult || publishFilterResult.detailResult,
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

    if (controllerState.batchUrlCaptureInFlight || controllerState.batchKeywordCaptureInFlight || controllerState.monitorRunInFlight) {
      showMessage("已有采集任务执行中，请完成后再执行监控扫描", "warning");
      return;
    }

    const monitor = getCurrentMonitor() || {};
    const activeItems = Array.isArray(monitor.items)
      ? monitor.items.filter(
          (item) =>
            String(item?.status || "").trim() === MONITOR_STATUS.ACTIVE &&
            normalizeMonitorSubjectType(
              item?.subjectType || item?.subject_type,
            ) === MONITOR_SUBJECT_TYPE.CREATOR,
        )
      : [];

    if (activeItems.length === 0) {
      showMessage("暂无启用中的监控项可执行", "info");
      return;
    }

    const startedAt = Date.now();
    controllerState.monitorRunInFlight = true;
    controllerState.monitorRunCancelRequested = false;
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
        subjectType: MONITOR_SUBJECT_TYPE.CREATOR,
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
        if (controllerState.monitorRunCancelRequested) {
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
          shouldStop: () => controllerState.monitorRunCancelRequested,
        });
        runItems.push(runResult);
        if (controllerState.monitorRunCancelRequested) {
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
          controllerState.monitorRunCancelRequested
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
      controllerState.monitorRunInFlight = false;
      controllerState.monitorRunCancelRequested = false;
      hideProgress();
    }
  }

  return Object.freeze({
    reportMonitorRunProgress,
    resolveMonitorRecordIdsForPublishWindow,
    finishMonitorExecutionSafely,
    runMonitorCommentPatrolWithCaptureTaskSession,
    executeMonitorRunItem,
    handleRunMonitorNow,
  });
}
