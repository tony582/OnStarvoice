// L3-A detail-sync: original control flow, explicit state and compatibility ports.
export function createDetailSyncController({controllerState, controllerPorts, controllerOperations}) {
  const {
    DETAIL_CAPTURE_SCOPE_ALL,
    DETAIL_ITEM_SETTLED_PHASES,
    ERROR_MESSAGE_MAP,
    MAX_SYNC_RECORDS_PER_BATCH,
    PAGE_TYPE,
    SYNC_BATCH_LIMIT_MESSAGE,
    SYNC_SCOPE_ALL,
    SYNC_SCOPE_PENDING,
    SYNC_TYPE,
    batchCaptureDetailsForRecords,
    buildCommentLeadsConfigFromSettings,
    buildDetailCaptureBlockerMessage,
    buildDetailCaptureFailureSummaryText,
    buildDetailCaptureSyncWarningMessage,
    buildSyncReconciliationError,
    checkBeforeSync,
    confirm,
    console,
    getCaptureSettings,
    getCurrentAuth,
    getCurrentDataPool,
    getCurrentPageRecords,
    getCurrentRuntime,
    getDetailCaptureTargetRecords,
    getPagePlatform,
    getPlatformCapabilities,
    getRecordPrimaryNoteUrl,
    getRecords,
    getViewPlatform,
    hasSyncReconciliationSignal,
    hideProgress,
    isAuthVerified,
    isDetailCaptureDone,
    isDetailCaptureRecord,
    loadStorageModule,
    readDetailCaptureScopeFromInput,
    readSyncScopeFromInput,
    refreshDataPool,
    refreshSyncHistory,
    repairInterruptedDetailCaptureRecords,
    resolveSyncInputForRecord,
    runEnhancementWithSingleRetry,
    showMessage,
    showProgress,
    sleep,
    summarizeDetailCaptureBlockers,
    syncRecordBatch,
    updateDataPoolUI,
    updatePageTypeUI,
  } = controllerPorts;
  const beginSidebarTask = (...args) => controllerOperations.beginSidebarTask(...args);
  const finishSidebarTask = (...args) => controllerOperations.finishSidebarTask(...args);
  const handleProgress = (...args) => controllerOperations.handleProgress(...args);
  const rebuildCaptureTaskSessionForEnhancementRetry = (...args) => controllerOperations.rebuildCaptureTaskSessionForEnhancementRetry(...args);
  const renewCaptureExecutionLock = (...args) => controllerOperations.renewCaptureExecutionLock(...args);
  const requestDetailRunnerCancelSignals = (...args) => controllerOperations.requestDetailRunnerCancelSignals(...args);
  const sleepWithStop = (...args) => controllerOperations.sleepWithStop(...args);

  async function handleSyncAll() {
    if (controllerState.detailBatchCaptureInFlight) {
      const shouldStopAndSync = confirm(
        "当前正在执行采集增强。是否立即中止采集增强，并同步已经采到的数据？\n\n未完成增强的记录会标记为“任务中断”，后续可再次重试增强。",
      );
      if (!shouldStopAndSync) {
        showMessage("正在执行采集增强，请等待完成后再同步", "warning");
        return;
      }
      await stopDetailCaptureAndReleaseForSync();
    }

    const settings = await getCaptureSettings();
    const syncScope = readSyncScopeFromInput(settings.syncScope);
    const commentLeadsConfig = buildCommentLeadsConfigFromSettings(settings);
    const commentLeadsEnabled = Boolean(commentLeadsConfig.enabled);
    let pageRecords = getCurrentPageRecords();
    const repairedInterruptedDetails =
      await repairInterruptedDetailCaptureRecordsBeforeSync(pageRecords);
    if (repairedInterruptedDetails.count > 0) {
      pageRecords = getCurrentPageRecords();
    }
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

      if (hasSyncReconciliationSignal(result)) {
        taskStatus = "needs_action";
        taskError = buildSyncReconciliationError();
        showMessage(taskError.message, "warning");
      } else if (result.ok && remainingCount <= 0) {
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
      if (hasSyncReconciliationSignal(error) || hasSyncReconciliationSignal(taskError)) {
        taskStatus = "needs_action";
        taskError = buildSyncReconciliationError();
        showMessage(taskError.message, "warning");
      } else {
        taskStatus = "failed";
        taskError = error;
        showMessage("同步失败: " + error.message, "error");
      }
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

  async function repairInterruptedDetailCaptureRecordsBeforeSync(records = []) {
    const hasCapturingRecord = (Array.isArray(records) ? records : []).some(
      (record) => {
        if (!isDetailCaptureRecord(record) || isDetailCaptureDone(record)) {
          return false;
        }
        const status = String(record?.payload?.detailCaptureStatus || "")
          .trim()
          .toLowerCase();
        return status === "capturing";
      },
    );
    if (!hasCapturingRecord) {
      return {count: 0, recordIds: []};
    }

    try {
      const result = await repairInterruptedDetailCaptureRecords();
      if (Number(result?.count || 0) > 0) {
        await refreshDataPool();
        showMessage(
          `已恢复 ${result.count} 条异常中断的采集增强记录，可继续同步`,
          "warning",
        );
      }
      return result || {count: 0, recordIds: []};
    } catch (error) {
      console.warn(
        "[Sidebar] Repair interrupted detail capture before sync failed:",
        error,
      );
      return {count: 0, recordIds: []};
    }
  }

  async function stopDetailCaptureAndReleaseForSync() {
    controllerState.detailBatchCancelRequested = true;

    try {
      await requestDetailRunnerCancelSignals({
        extraTabIds: getCurrentRuntime()?.captureDebugSession?.workerTabIds,
      });
    } catch (error) {
      console.warn("[Sidebar] Stop detail capture before sync failed:", error);
    }

    const startedAt = Date.now();
    while (controllerState.detailBatchCaptureInFlight && Date.now() - startedAt < 3000) {
      await sleep(200);
    }

    const result = await finalizeInterruptedDetailCaptureAfterCancel();
    controllerState.detailBatchCaptureInFlight = false;
    controllerState.detailBatchCancelRequested = false;
    controllerState.detailBatchRunnerTabId = null;
    controllerState.activeCommentsCaptureRecordId = "";
    controllerState.activeCommentsCaptureTabId = null;
    controllerState.activeCommentsCaptureRequestId = "";
    if (controllerState.activeCaptureExecutionLockId) {
      void renewCaptureExecutionLock(controllerState.activeCaptureExecutionLockId);
    }
    updateDataPoolUI(getCurrentDataPool());
    updatePageTypeUI(getCurrentRuntime()?.pageType || PAGE_TYPE.UNKNOWN);
    return result;
  }

  async function finalizeInterruptedDetailCaptureAfterCancel() {
    try {
      const result = await repairInterruptedDetailCaptureRecords();
      if (Number(result?.count || 0) > 0) {
        await refreshDataPool();
        showMessage(
          `已中止采集增强，并保留已采到的数据；${result.count} 条进行中记录已标记为中断，可继续同步`,
          "warning",
        );
        return result;
      }
    } catch (error) {
      console.warn(
        "[Sidebar] Finalize interrupted detail capture after cancel failed:",
        error,
      );
    }

    showMessage("正在取消...", "info");
    return {count: 0, recordIds: []};
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
    {
      sourceLabel = "当前列表",
      recordIds = null,
      onProgress = null,
      onItemSettled = null,
      waitForegroundTabId = null,
      captureTaskId = "",
      relevanceKeyword = "",
      unattendedRequestId = "",
      unattendedAttemptId = "",
    } = {},
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

    const skipAlreadyCaptured =
      settings?.skipAlreadyCapturedOnDetailCapture !== false;
    // “跳过已增强笔记”是用户可见的最终开关。关闭时必须让本轮明确
    // recordIds 中的已增强记录重新进入详情采集，不能再被旧的
    // detailCaptureScope=pending 预先过滤掉，否则会出现第一关键词只补少量、
    // 后续关键词完全不增强的假完成。
    const detailCaptureScope = skipAlreadyCaptured
      ? readDetailCaptureScopeFromInput(settings?.detailCaptureScope)
      : DETAIL_CAPTURE_SCOPE_ALL;

    const explicitRecordIds = Array.isArray(recordIds)
      ? [
          ...new Set(
            recordIds
              .filter((recordId) => typeof recordId === "string")
              .map((recordId) => recordId.trim())
              .filter(Boolean),
          ),
        ]
      : [];
    const createTargetResolutionFailure = ({
      code = "DETAIL_TARGETS_UNRESOLVED",
      reason = "record_ids_unresolved",
      message = "采集结果尚未写入本地数据池，无法启动采集增强",
      failedRecordIds = explicitRecordIds,
    } = {}) => {
      const normalizedFailedRecordIds = Array.isArray(failedRecordIds)
        ? [...new Set(failedRecordIds.filter(Boolean))]
        : [];
      const failureCount = Math.max(
        1,
        normalizedFailedRecordIds.length || explicitRecordIds.length,
      );
      return {
        ok: false,
        canceled: false,
        partial: true,
        recoverable: reason === "record_ids_unresolved",
        recoveryRequired: reason === "record_ids_unresolved",
        skipped: false,
        reason,
        total: Math.max(explicitRecordIds.length, failureCount),
        processedCount: failureCount,
        successCount: 0,
        failedCount: failureCount,
        filteredCount: 0,
        skippedCount: 0,
        unresolvedRecordIds: normalizedFailedRecordIds,
        results: normalizedFailedRecordIds.map((recordId) => ({
          recordId,
          ok: false,
          reason,
          code,
          message,
          recoveryRequired: reason === "record_ids_unresolved",
        })),
        error: {code, message},
      };
    };

    // 明确的 recordIds 是列表采集刚落盘的权威结果。这里必须直接读取
    // 持久化数据池，不能依赖可能被并发 refresh 覆盖的侧栏 UI 快照。
    // 否则最后一个关键词会被误判为 no_target_records，基础数据照常同步，
    // 但详情增强静默跳过。
    let pageRecords = [];
    let unresolvedRecordIds = [];
    if (explicitRecordIds.length > 0) {
      const persistedRecords = await getRecords(explicitRecordIds);
      const persistedRecordById = new Map(
        persistedRecords.map((record) => [record.id, record]),
      );
      pageRecords = explicitRecordIds
        .map((recordId) => persistedRecordById.get(recordId))
        .filter(Boolean);
      unresolvedRecordIds = explicitRecordIds.filter(
        (recordId) => !persistedRecordById.has(recordId),
      );
    } else {
      pageRecords = getCurrentPageRecords();
    }

    const targetRecords = getDetailCaptureTargetRecords(pageRecords, {
      scope: detailCaptureScope,
    });

    if (targetRecords.length === 0) {
      if (
        explicitRecordIds.length > 0 &&
        unresolvedRecordIds.length === 0 &&
        pageRecords.length === explicitRecordIds.length &&
        pageRecords.every((record) => isDetailCaptureDone(record))
      ) {
        return {
          ok: true,
          skipped: true,
          reason: "all_targets_settled",
          total: explicitRecordIds.length,
          processedCount: explicitRecordIds.length,
          successCount: 0,
          failedCount: 0,
          filteredCount: 0,
          skippedCount: explicitRecordIds.length,
          results: [],
        };
      }
      if (explicitRecordIds.length > 0) {
        return createTargetResolutionFailure({
          code:
            unresolvedRecordIds.length > 0
              ? "DETAIL_RECORD_IDS_UNRESOLVED"
              : "DETAIL_TARGETS_UNRESOLVED",
          reason:
            unresolvedRecordIds.length > 0
              ? "record_ids_unresolved"
              : "no_target_records",
          message:
            unresolvedRecordIds.length > 0
              ? `有 ${unresolvedRecordIds.length} 条采集结果尚未写入本地数据池，已保留为部分完成并等待恢复`
              : `已收到 ${explicitRecordIds.length} 条列表记录，但没有解析出可增强作品，任务不能按完整完成结算`,
          failedRecordIds:
            unresolvedRecordIds.length > 0
              ? unresolvedRecordIds
              : explicitRecordIds,
        });
      }
      return {
        skipped: true,
        reason: "no_target_records",
      };
    }

    const targetRecordIds = targetRecords
      .filter((record) => Boolean(getRecordPrimaryNoteUrl(record)))
      .map((record) => record.id);

    const targetRecordIdSet = new Set(targetRecordIds);
    const missingNoteUrlRecordIds = targetRecords
      .map((record) => record.id)
      .filter((recordId) => !targetRecordIdSet.has(recordId));
    if (missingNoteUrlRecordIds.length > 0) {
      showMessage("当前记录缺少可访问的笔记链接，无法执行采集增强", "warning");
    }

    const preflightFailureRecordIds = [
      ...new Set([...unresolvedRecordIds, ...missingNoteUrlRecordIds]),
    ];
    if (targetRecordIds.length === 0 && preflightFailureRecordIds.length > 0) {
      const onlyMissingUrls = unresolvedRecordIds.length === 0;
      return createTargetResolutionFailure({
        code: onlyMissingUrls
          ? "DETAIL_NOTE_URL_MISSING"
          : "DETAIL_RECORD_IDS_UNRESOLVED",
        reason: onlyMissingUrls ? "missing_note_url" : "record_ids_unresolved",
        message: onlyMissingUrls
          ? `有 ${missingNoteUrlRecordIds.length} 条记录缺少可访问的作品链接，未按完整增强结算`
          : `有 ${unresolvedRecordIds.length} 条采集结果尚未写入本地数据池，已保留为部分完成并等待恢复`,
        failedRecordIds: preflightFailureRecordIds,
      });
    }

    const detailResult = await runDetailCaptureForRecordIds(
      targetRecordIds,
      settings,
      {
        progressMessage: `正在执行采集增强（0/${targetRecordIds.length}）...`,
        onProgress,
        onItemSettled,
        waitForegroundTabId,
        captureTaskId,
        relevanceKeyword,
        unattendedRequestId,
        unattendedAttemptId,
      },
    );
    const preflightFailures = [];
    if (unresolvedRecordIds.length > 0) {
      preflightFailures.push(
        ...createTargetResolutionFailure({
          code: "DETAIL_RECORD_IDS_UNRESOLVED",
          reason: "record_ids_unresolved",
          message: "采集结果尚未写入本地数据池，无法启动采集增强",
          failedRecordIds: unresolvedRecordIds,
        }).results,
      );
    }
    if (missingNoteUrlRecordIds.length > 0) {
      preflightFailures.push(
        ...createTargetResolutionFailure({
          code: "DETAIL_NOTE_URL_MISSING",
          reason: "missing_note_url",
          message: "记录缺少可访问的作品链接，无法启动采集增强",
          failedRecordIds: missingNoteUrlRecordIds,
        }).results,
      );
    }
    const result =
      preflightFailures.length === 0
        ? detailResult
        : {
            ...detailResult,
            ok: false,
            partial: true,
            recoveryRequired:
              Boolean(detailResult?.recoveryRequired) ||
              unresolvedRecordIds.length > 0,
            total:
              Math.max(
                Number(detailResult?.total) || 0,
                targetRecordIds.length,
              ) + preflightFailures.length,
            processedCount:
              Math.max(
                Number(detailResult?.processedCount) || 0,
                targetRecordIds.length,
              ) + preflightFailures.length,
            failedCount:
              Math.max(0, Number(detailResult?.failedCount) || 0) +
              preflightFailures.length,
            results: [
              ...(Array.isArray(detailResult?.results)
                ? detailResult.results
                : []),
              ...preflightFailures,
            ],
            unresolvedRecordIds,
            error:
              detailResult?.error ||
              {
                code:
                  unresolvedRecordIds.length > 0
                    ? "DETAIL_RECORD_IDS_UNRESOLVED"
                    : "DETAIL_NOTE_URL_MISSING",
                message: `有 ${preflightFailures.length} 条记录未能进入采集增强`,
              },
          };

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

  async function maybeRunAutoSyncAfterDetailCapture(
    settings,
    {
      sourceLabel = "当前列表",
      recordIds = null,
      silent = false,
      refreshAfter = true,
      syncProgress = null,
      shouldStop = null,
      signal = null,
      captureTaskId = "",
      captureTaskItemAttemptId = "",
      captureTaskItemRequestHash = "",
    } = {},
  ) {
    const stopRequested = () => {
      if (signal?.aborted === true) return true;
      if (typeof shouldStop !== "function") return false;
      try {
        return shouldStop() === true;
      } catch {
        return true;
      }
    };
    const canceledResult = () => ({
      ok: false,
      canceled: true,
      skipped: true,
      reason: "capture_task_canceled",
      message: "任务已取消，未继续同步",
    });

    if (!Boolean(settings?.autoSyncAfterDetailCapture)) {
      return {
        skipped: true,
        reason: "disabled",
      };
    }

    const normalizedRecordIds = Array.isArray(recordIds)
      ? [
          ...new Set(
            recordIds
              .filter((recordId) => typeof recordId === "string")
              .map((recordId) => recordId.trim())
              .filter(Boolean),
          ),
        ]
      : [];

    if (normalizedRecordIds.length === 0) {
      return {
        skipped: true,
        reason: "no_records",
      };
    }

    const progressHandler =
      typeof syncProgress === "function"
        ? syncProgress
        : silent
          ? null
          : handleProgress;

    try {
      const records = await getRecords(normalizedRecordIds);
      if (stopRequested()) return canceledResult();
      const recordMap = new Map(records.map((record) => [record.id, record]));
      const targetRecordIds = normalizedRecordIds.filter((recordId) =>
        recordMap.has(recordId),
      );

      if (targetRecordIds.length === 0) {
        return {
          skipped: true,
          reason: "records_missing",
        };
      }

      const targetRecords = targetRecordIds.map((recordId) =>
        recordMap.get(recordId),
      );
      const commentLeadsConfig = buildCommentLeadsConfigFromSettings(settings);
      const requiredTypes = targetRecords
        .map(
          (record) =>
            resolveSyncInputForRecord(record)?.syncType ||
            record?.type ||
            record?.recordType,
        )
        .filter(Boolean);

      if (
        commentLeadsConfig.enabled &&
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

      if (!silent) {
        showProgress(`${sourceLabel}采集增强完成，正在自动同步后台...`);
      }
      const checkResult = await checkBeforeSync(requiredTypes, {
        onProgress: progressHandler,
      });
      if (stopRequested()) return canceledResult();
      if (!checkResult.ok) {
        const errorMsg =
          ERROR_MESSAGE_MAP[checkResult.error?.code] ||
          checkResult.error?.message ||
          "自动同步前检查失败";
        if (!silent) {
          showMessage(`${sourceLabel}自动同步未执行：${errorMsg}`, "warning");
        }
        return {
          ok: false,
          phase: "check",
          error: checkResult.error,
        };
      }

      const result = await syncRecordBatch(targetRecordIds, progressHandler, {
        trigger: "detail_auto",
        syncScope: SYNC_SCOPE_PENDING,
        captureSettings: settings,
        commentLeadsConfig,
        shouldStop: stopRequested,
        signal,
        captureTaskId,
        captureTaskItemAttemptId,
        captureTaskItemRequestHash,
      });

      // Preserve the received result before cancellation or refresh can erase
      // its confirmation signal. No retry or refresh is performed on this path.
      if (hasSyncReconciliationSignal(result)) {
        const error = buildSyncReconciliationError();
        if (!silent) showMessage(error.message, "warning");
        return {
          ...result,
          ok: false,
          reconciliationRequired: true,
          error: {...result.error, ...error},
        };
      }
      if (result?.canceled) return canceledResult();

      if (refreshAfter) {
        await Promise.all([refreshDataPool(), refreshSyncHistory()]);
      }

      const leadsSyncedCount = Number(result.commentLeadsSyncedCount || 0);
      const leadsSkippedCount = Number(result.commentLeadsSkippedCount || 0);
      const leadsFailedCount = Number(result.commentLeadsFailedCount || 0);
      const leadsSummary =
        leadsSyncedCount > 0 || leadsSkippedCount > 0 || leadsFailedCount > 0
          ? `（客资：成功 ${leadsSyncedCount} / 跳过 ${leadsSkippedCount} / 失败 ${leadsFailedCount}）`
          : "";
      const skippedMessage =
        Number(result.skippedCount || 0) > 0
          ? `，剩余 ${result.skippedCount} 条待再次同步`
          : "";

      if (!silent) {
        if (result.ok) {
          showMessage(
            `${sourceLabel}已自动同步后台：${result.successCount} 条${skippedMessage}${leadsSummary}`,
            "success",
          );
        } else {
          showMessage(
            `${sourceLabel}自动同步部分失败：成功 ${result.successCount}，失败 ${result.failedCount}${skippedMessage}${leadsSummary}`,
            "warning",
          );
        }
      }

      return result;
    } catch (error) {
      if (hasSyncReconciliationSignal(error)) {
        const reconciliationError = buildSyncReconciliationError();
        if (!silent) showMessage(reconciliationError.message, "warning");
        return {
          ok: false,
          reconciliationRequired: true,
          phase: "sync",
          error: {...error, ...reconciliationError},
        };
      }
      if (stopRequested()) return canceledResult();
      console.error("[Sidebar] Auto sync after detail capture failed:", error);
      if (!silent) {
        showMessage(`${sourceLabel}自动同步失败: ${error.message}`, "warning");
      }
      if (refreshAfter) {
        await Promise.all([refreshDataPool(), refreshSyncHistory()]).catch(
          () => null,
        );
      }
      return {
        ok: false,
        phase: "sync",
        error,
      };
    }
  }

  async function runDetailCaptureForRecordIds(
    recordIds,
    settings,
    {
      progressMessage = "",
      onProgress = null,
      onItemSettled = null,
      waitForegroundTabId = null,
      captureTaskId = "",
      relevanceKeyword = "",
      unattendedRequestId = "",
      unattendedAttemptId = "",
    } = {},
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

    const scopedUnattendedRequestId = String(
      unattendedRequestId || "",
    ).trim();
    const scopedUnattendedAttemptId = String(
      unattendedAttemptId || "",
    ).trim();
    const isCurrentDetailInvocation = () =>
      !scopedUnattendedRequestId ||
      (scopedUnattendedRequestId ===
        String(controllerState.activeUnattendedRunRequestId || "").trim() &&
        (!scopedUnattendedAttemptId ||
          scopedUnattendedAttemptId ===
            String(controllerState.activeUnattendedRunAttemptId || "").trim()));
    const detailInvocationToken = Symbol("detail-capture");
    controllerState.activeDetailCaptureInvocationToken = detailInvocationToken;
    const ownsDetailInvocation = () =>
      controllerState.activeDetailCaptureInvocationToken === detailInvocationToken;

    controllerState.detailBatchCaptureInFlight = true;
    controllerState.detailBatchCancelRequested = false;
    controllerState.detailBatchRunnerTabId = null;
    controllerState.detailBatchRunnerTabIds.clear();
    controllerState.detailBatchWorkerStates = [];
    controllerState.detailBatchWorkerMode = "";
    controllerState.detailBatchWorkerRevision = 0;
    updateDataPoolUI(getCurrentDataPool());
    updatePageTypeUI(getCurrentRuntime()?.pageType || PAGE_TYPE.UNKNOWN);
    showProgress(
      progressMessage || `正在执行采集增强（0/${normalizedRecordIds.length}）...`,
    );

    try {
      // 每次新的增强批次都从“尚未自动重试”开始，避免上一次任务留下的
      // 重试次数误导当前卡片。真正开始补偿尝试时再写入当前次数。
      try {
        const initialRecords = await getRecords(normalizedRecordIds);
        const {updateRecord} = await loadStorageModule();
        await Promise.all(
          initialRecords.map((record) =>
            updateRecord(record.id, {
              payload: {
                ...(record?.payload || {}),
                detailCaptureAutoRetryCount: 0,
                detailCaptureLastAutoRetryAt: "",
              },
            }),
          ),
        );
      } catch (error) {
        console.warn(
          "[Sidebar] Reset detail auto-retry metadata failed:",
          error,
        );
      }

      const deferredFirstFailureProgress = new Map();
      const settledOnRetryRecordIds = new Set();
      const handleDetailProgress = (
        progress = {},
        {attempt = 1, isRetry = false, retryCount = 0, maxRetries = 1} = {},
      ) => {
        const taskScopedProgress = {
          ...progress,
          ...(captureTaskId ? {captureTaskId} : {}),
          ...(scopedUnattendedRequestId
            ? {unattendedRequestId: scopedUnattendedRequestId}
            : {}),
          ...(scopedUnattendedAttemptId
            ? {unattendedAttemptId: scopedUnattendedAttemptId}
            : {}),
        };
        const normalizedProgress = isRetry
          ? {
              ...taskScopedProgress,
              captureTaskId: String(
                taskScopedProgress?.captureTaskId || captureTaskId || "",
              ).trim(),
              autoRetryAttempt: attempt,
              autoRetryCount: retryCount,
              autoRetryMaxRetries: maxRetries,
              message: `自动重试 ${retryCount}/${maxRetries}：${taskScopedProgress?.message || "正在重新采集增强"}`,
            }
          : {
              ...taskScopedProgress,
              captureTaskId: String(
                taskScopedProgress?.captureTaskId || captureTaskId || "",
              ).trim(),
            };
        if (!isCurrentDetailInvocation()) {
          return normalizedProgress;
        }
        const mergedProgress = handleProgress(normalizedProgress);
        if (typeof onProgress === "function") {
          onProgress(mergedProgress);
        }
        if (
          typeof onItemSettled === "function" &&
          DETAIL_ITEM_SETTLED_PHASES.has(
            String(mergedProgress?.phase || ""),
          ) &&
          String(mergedProgress?.recordId || "").trim()
        ) {
          const settledRecordId = String(mergedProgress.recordId).trim();
          if (
            !isRetry &&
            String(mergedProgress?.phase || "") === "detail_item_failed"
          ) {
            deferredFirstFailureProgress.set(settledRecordId, mergedProgress);
            return;
          }
          if (isRetry) {
            settledOnRetryRecordIds.add(settledRecordId);
          }
          Promise.resolve(onItemSettled(mergedProgress)).catch((error) => {
            console.warn("[Sidebar] Detail item settled callback failed:", error);
          });
        }
      };
      const result = await runEnhancementWithSingleRetry({
        recordIds: normalizedRecordIds,
        shouldStop: () =>
          controllerState.detailBatchCancelRequested ||
          !ownsDetailInvocation() ||
          !isCurrentDetailInvocation(),
        onRetryScheduled: async ({
          recordIds: retryRecordIds,
          retryCount,
          maxRetries,
        }) => {
          const retryProgress = {
            phase: "enhance_retry_waiting",
            current: 0,
            total: retryRecordIds.length,
            autoRetryAttempt: retryCount + 1,
            autoRetryCount: retryCount,
            autoRetryMaxRetries: maxRetries,
            message: `采集增强有 ${retryRecordIds.length} 条临时失败，3 秒后自动重试 ${retryCount}/${maxRetries}...`,
          };
          handleDetailProgress(retryProgress, {
            attempt: retryCount + 1,
            isRetry: false,
          });
          showProgress(retryProgress.message, "info");
        },
        onRetryStarted: async ({
          recordIds: retryRecordIds,
          requiresContextRebuild = false,
          retryCount,
          maxRetries,
        }) => {
          const retryProgress = {
            phase: requiresContextRebuild
              ? "enhance_retry_rebuilding"
              : "enhance_retry_starting",
            current: 0,
            total: retryRecordIds.length,
            autoRetryAttempt: retryCount + 1,
            autoRetryCount: retryCount,
            autoRetryMaxRetries: maxRetries,
            message: requiresContextRebuild
              ? `正在重建采集上下文 · ${retryCount}/${maxRetries}（${retryRecordIds.length} 条）...`
              : `正在自动重试当前作品 · ${retryCount}/${maxRetries}（${retryRecordIds.length} 条）...`,
          };
          handleDetailProgress(retryProgress, {
            attempt: retryCount + 1,
            isRetry: false,
          });
          showProgress(retryProgress.message, "info");
          try {
            const retryRecords = await getRecords(retryRecordIds);
            const {updateRecord} = await loadStorageModule();
            await Promise.all(
              retryRecords.map((record) =>
                updateRecord(record.id, {
                  payload: {
                    ...(record?.payload || {}),
                    detailCaptureAutoRetryCount: Math.max(
                      retryCount,
                      Number(record?.payload?.detailCaptureAutoRetryCount) || 0,
                    ),
                    detailCaptureLastAutoRetryAt: new Date().toISOString(),
                  },
                }),
              ),
            );
          } catch (error) {
            console.warn(
              "[Sidebar] Persist detail auto-retry metadata failed:",
              error,
            );
          }
        },
        prepareRetry: async ({
          requiresContextRebuild = false,
          retryCount,
          maxRetries,
        }) => {
          if (!requiresContextRebuild || !captureTaskId) {
            return;
          }
          if (!ownsDetailInvocation() || !isCurrentDetailInvocation()) {
            const error = new Error(
              "当前执行已被新的恢复任务接管，已停止旧上下文重建",
            );
            error.code = "STALE_UNATTENDED_ATTEMPT";
            throw error;
          }
          const runtime = getCurrentRuntime() || {};
          const preferredSourceTabId =
            Number(waitForegroundTabId) ||
            Number(runtime?.captureDebugSession?.sourceTabId) ||
            Number(runtime?.captureDebugSession?.tabId) ||
            Number(runtime?.lastActiveTabId) ||
            null;
          await rebuildCaptureTaskSessionForEnhancementRetry({
            taskId: captureTaskId,
            preferredTabId: preferredSourceTabId,
            platform: getPagePlatform(runtime) || getViewPlatform(runtime),
            label: `采集增强自动恢复 · ${retryCount}/${maxRetries}`,
            unattendedAttemptId: scopedUnattendedAttemptId,
          });
        },
        waitBeforeRetry: () =>
          sleepWithStop(3000, () => controllerState.detailBatchCancelRequested),
        runAttempt: async (attemptRecordIds, attemptContext = {}) => {
          const isRetry = attemptContext.isRetry === true;
          if (isRetry) {
            showProgress(
              `正在自动重试采集增强 ${attemptContext.retryCount}/${attemptContext.maxRetries}（0/${attemptRecordIds.length}）...`,
              "info",
            );
          }
          return await batchCaptureDetailsForRecords(attemptRecordIds, {
            onProgress: (progress) =>
              handleDetailProgress(progress, attemptContext),
            shouldStop: () =>
              controllerState.detailBatchCancelRequested ||
              !ownsDetailInvocation() ||
              !isCurrentDetailInvocation(),
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
            lowFollowerHitThreshold:
              settings?.lowFollowerHitThresholdOnDetailCapture,
            commentsMaxDetectedItems:
              settings?.detailCommentsMaxDetectedItems ??
              settings?.commentsMaxDetectedItems,
            detailNavTimeoutMs: settings?.detailNavTimeoutMs,
            detailAfterNavWaitMs: settings?.detailAfterNavWaitMs,
            profileAfterNavWaitMs: settings?.profileAfterNavWaitMs,
            waitForegroundTabId,
            captureTaskId,
            enableAiRelevancePrefilter: Boolean(
              settings?.enableAiRelevancePrefilter,
            ),
            relevanceKeyword: String(relevanceKeyword || "").trim(),
          });
        },
      });

      if (typeof onItemSettled === "function") {
        const retriedRecordIds = new Set(result?.autoRetryRecordIds || []);
        for (const [recordId, progress] of deferredFirstFailureProgress) {
          if (result?.autoRetryAttempted && retriedRecordIds.has(recordId)) {
            continue;
          }
          Promise.resolve(onItemSettled(progress)).catch((error) => {
            console.warn("[Sidebar] Deferred detail settlement failed:", error);
          });
        }
        if (result?.autoRetryAttempted) {
          for (const recordId of retriedRecordIds) {
            if (settledOnRetryRecordIds.has(recordId)) continue;
            const item = (result?.results || []).find(
              (candidate) => String(candidate?.recordId || "").trim() === recordId,
            );
            if (!item) continue;
            Promise.resolve(
              onItemSettled({
                ...item,
                phase: item.ok ? "detail_item_done" : "detail_item_failed",
                recordId,
                autoRetryAttempt: Number(result.autoRetryCount || 0) + 1,
                autoRetryCount: Number(result.autoRetryCount || 0),
                autoRetryMaxRetries: Number(result.autoRetryMaxRetries || 1),
                message: item.ok
                  ? `自动重试 ${result.autoRetryCount}/${result.autoRetryMaxRetries} 成功`
                  : `自动重试 ${result.autoRetryCount}/${result.autoRetryMaxRetries} 后仍失败`,
              }),
            ).catch((error) => {
              console.warn("[Sidebar] Retry detail settlement failed:", error);
            });
          }
        }
      }

      await refreshDataPool();
      return result;
    } finally {
      const ownsInvocation = ownsDetailInvocation();
      const ownsCurrentInvocation =
        ownsInvocation && isCurrentDetailInvocation();
      if (ownsInvocation) {
        controllerState.detailBatchCaptureInFlight = false;
        controllerState.detailBatchCancelRequested = false;
        controllerState.detailBatchRunnerTabId = null;
        controllerState.detailBatchRunnerTabIds.clear();
        controllerState.detailBatchWorkerStates = [];
        controllerState.detailBatchWorkerMode = "";
        controllerState.detailBatchWorkerRevision = 0;
        controllerState.activeCommentsCaptureRecordId = "";
        controllerState.activeCommentsCaptureTabId = null;
        controllerState.activeCommentsCaptureRequestId = "";
        controllerState.activeDetailCaptureInvocationToken = null;
      }
      if (ownsCurrentInvocation) {
        if (controllerState.activeCaptureExecutionLockId) {
          void renewCaptureExecutionLock(controllerState.activeCaptureExecutionLockId);
        }
        updateDataPoolUI(getCurrentDataPool());
        updatePageTypeUI(getCurrentRuntime()?.pageType || PAGE_TYPE.UNKNOWN);
      }
    }
  }

  return Object.freeze({
    handleSyncAll,
    repairInterruptedDetailCaptureRecordsBeforeSync,
    stopDetailCaptureAndReleaseForSync,
    finalizeInterruptedDetailCaptureAfterCancel,
    prioritizeRecordsForSync,
    maybeRunAutoDetailCaptureAfterListCapture,
    maybeRunAutoSyncAfterDetailCapture,
    runDetailCaptureForRecordIds,
  });
}
