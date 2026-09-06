// L2 batch: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createBatchStage({state, ports, operations}) {
  const {
    ERROR_REASON,
    MAX_SYNC_RECORDS_PER_BATCH,
    RECORD_STATUS,
    SYNC_STATUS,
    SYNC_TYPE,
    addSyncHistoryEntry,
    buildSyncHistoryTarget,
    getActiveTaskContext,
    getCaptureSettings,
    getRecord,
    getRecords,
    getTarget,
    markRecordSynced,
    recordDiagnosticError,
    resolveActiveCloudCaptureTaskId,
    sync,
    trackSyncSuccess,
    updateRecord,
    updateSync,
  } = ports;
  const applyCommentLeadsSyncState = (...args) => operations.applyCommentLeadsSyncState(...args);
  const applySyncPreferencesToPayload = (...args) => operations.applySyncPreferencesToPayload(...args);
  const buildCanceledBatchSyncResult = (...args) => operations.buildCanceledBatchSyncResult(...args);
  const buildCommentLeadsPayloadForRecord = (...args) => operations.buildCommentLeadsPayloadForRecord(...args);
  const buildSyncTargetPayload = (...args) => operations.buildSyncTargetPayload(...args);
  const buildWorkflowSyncGroups = (...args) => operations.buildWorkflowSyncGroups(...args);
  const extendSyncPausedMetadata = (...args) => operations.extendSyncPausedMetadata(...args);
  const extractDebugUrl = (...args) => operations.extractDebugUrl(...args);
  const getSingleNoteType = (...args) => operations.getSingleNoteType(...args);
  const hasStoredCommentLeadsPayload = (...args) => operations.hasStoredCommentLeadsPayload(...args);
  const isCommentLeadsEligibleSyncType = (...args) => operations.isCommentLeadsEligibleSyncType(...args);
  const isSyncCancellationRequested = (...args) => operations.isSyncCancellationRequested(...args);
  const mergeSyncPausedMetadata = (...args) => operations.mergeSyncPausedMetadata(...args);
  const normalizeCommentLeadsConfig = (...args) => operations.normalizeCommentLeadsConfig(...args);
  const normalizeDebugUrl = (...args) => operations.normalizeDebugUrl(...args);
  const pickBatchDebugUrl = (...args) => operations.pickBatchDebugUrl(...args);
  const resetCanceledSyncState = (...args) => operations.resetCanceledSyncState(...args);
  const resolveSyncInputForRecord = (...args) => operations.resolveSyncInputForRecord(...args);
  const syncGroupRecordsWithRetry = (...args) => operations.syncGroupRecordsWithRetry(...args);


  async function syncRecordBatch(recordIds, onProgress = null, options = {}) {
    try {
      return await runSyncRecordBatch(recordIds, onProgress, options);
    } catch (error) {
      await updateSync({
        status: SYNC_STATUS.FAILED,
        error: {
          code: 'BATCH_SYNC_ERROR',
          message: error?.message || '批量同步失败',
        },
      }).catch(() => null);

      void recordDiagnosticError({
        taskContext: getActiveTaskContext(),
        source: 'capture-sync',
        action: 'syncRecordBatch',
        status: 'failed',
        error: {
          code: 'BATCH_SYNC_ERROR',
          message: error?.message || '批量同步失败',
        },
        metadata: {
          requestedCount: Array.isArray(recordIds) ? recordIds.length : 0,
          trigger: options?.trigger || 'manual',
        },
      }).catch(() => null);

      if (onProgress) {
        onProgress({
          phase: 'sync_failed',
          message: `批量同步失败: ${error?.message || '未知错误'}`,
        });
      }

      throw error;
    }
  }

  async function runSyncRecordBatch(recordIds, onProgress = null, options = {}) {
    const startedAt = Date.now();
    const captureTaskId =
      resolveActiveCloudCaptureTaskId({
        taskId: String(options?.captureTaskId || '').trim(),
      }) || resolveActiveCloudCaptureTaskId();
    const shouldStop = options?.shouldStop;
    const signal = options?.signal || null;
    const requestedRecordIds = Array.isArray(recordIds)
      ? recordIds.filter((recordId) => typeof recordId === 'string' && recordId.trim())
      : [];
    const recordIdsToSync = requestedRecordIds.slice(0, MAX_SYNC_RECORDS_PER_BATCH);
    const skippedRecordIds = requestedRecordIds.slice(MAX_SYNC_RECORDS_PER_BATCH);
    if (isSyncCancellationRequested(shouldStop, signal)) {
      await resetCanceledSyncState();
      return buildCanceledBatchSyncResult({
        requestedRecordIds,
        recordIdsToSync,
        skippedRecordIds,
      });
    }
    const target = await getTarget();
    if (isSyncCancellationRequested(shouldStop, signal)) {
      await resetCanceledSyncState();
      return buildCanceledBatchSyncResult({
        requestedRecordIds,
        recordIdsToSync,
        skippedRecordIds,
      });
    }
    const requestTarget = buildSyncTargetPayload(target);
    const captureSettings = options?.captureSettings || await getCaptureSettings();
    const commentLeadsConfig = normalizeCommentLeadsConfig(
      options?.commentLeadsConfig || {},
    );
    const batchMonitorExecutionId =
      typeof options?.monitorExecutionId === 'string' &&
      options.monitorExecutionId.trim()
        ? options.monitorExecutionId.trim()
        : '';
    const batchCaptureTaskItemAttemptId = String(
      options?.captureTaskItemAttemptId || '',
    ).trim();
    const batchCaptureTaskItemRequestHash = String(
      options?.captureTaskItemRequestHash || '',
    ).trim();
    const sourceRecords = await getRecords(recordIdsToSync);
    const recordMap = new Map(sourceRecords.map((record) => [record.id, record]));
    const recordsToSync = recordIdsToSync
      .map((recordId) => recordMap.get(recordId))
      .filter(Boolean);
    const preparedRecordsToSync = recordsToSync.map((record) => {
      const syncInput = resolveSyncInputForRecord(record, requestTarget);
      const monitorExecutionId =
        batchMonitorExecutionId ||
        String(record?.monitorExecutionId || record?.payload?.monitorExecutionId || '')
          .trim();
      return {
        ...record,
        platform: syncInput.platform,
        syncType: syncInput.syncType,
        syncPayload: applySyncPreferencesToPayload(
          syncInput.payload,
          captureSettings,
        ),
        workflow: syncInput.workflow,
        sourceType: record.type,
        monitorExecutionId,
        captureTaskId,
        captureTaskItemAttemptId:
          batchCaptureTaskItemAttemptId ||
          String(record?.captureTaskItemAttemptId || '').trim(),
        captureTaskItemRequestHash:
          batchCaptureTaskItemRequestHash ||
          String(record?.captureTaskItemRequestHash || '').trim(),
        retryCommentLeadsOnly:
          commentLeadsConfig.enabled &&
          isCommentLeadsEligibleSyncType(syncInput.syncType) &&
          [
            'COMMENT_LEADS_SYNC_FAILED',
            'COMMENT_LEADS_SYNC_CANCELED',
          ].includes(String(record?.lastSyncReason || '').trim().toUpperCase()),
      };
    });
    const results = [];
    const contentRecordsToSync = preparedRecordsToSync.filter(
      (record) => !record.retryCommentLeadsOnly,
    );
    const leadsRetryRecords = preparedRecordsToSync.filter(
      (record) => record.retryCommentLeadsOnly,
    );
    const syncGroups = buildWorkflowSyncGroups(contentRecordsToSync);
    let processedCount = 0;
    let syncPaused = null;
    let syncCanceled = false;

    await updateSync({
      status: SYNC_STATUS.SYNCING,
      lastAttemptedAt: new Date().toISOString(),
    });

    if (onProgress) {
      onProgress({
        phase: 'batch_prepare',
        current: 0,
        total: recordIdsToSync.length,
        message: `正在准备批量同步 ${recordIdsToSync.length} 条记录...`,
      });
    }

    // 先将所有待同步记录标记为草稿态，避免遗留失败态影响 UI
    for (const record of preparedRecordsToSync) {
      await updateRecord(record.id, {
        status: RECORD_STATUS.DRAFT,
      });
    }

    if (onProgress) {
      onProgress({
        phase: 'batch_sync',
        current: 0,
        total: recordIdsToSync.length,
        message: `正在批量同步 ${recordIdsToSync.length} 条记录...`,
      });
    }

    // 处理找不到记录的情况
    recordIdsToSync.forEach((recordId) => {
      if (recordMap.has(recordId)) return;
      results.push({
        recordId,
        platform: 'unknown',
        type: null,
        workflow: '',
        noteType: null,
        success: false,
        reason: 'RECORD_NOT_FOUND',
        message: '记录不存在',
        debugUrl: null,
        rawResponse: null,
        error: { code: 'RECORD_NOT_FOUND', message: '记录不存在' },
      });
    });
    processedCount = results.length;

    for (let groupIndex = 0; groupIndex < syncGroups.length; groupIndex += 1) {
      if (isSyncCancellationRequested(shouldStop, signal)) {
        syncCanceled = true;
        break;
      }
      const group = syncGroups[groupIndex];
      if (!Array.isArray(group.records) || group.records.length === 0) {
        continue;
      }

      const groupStartedAt = Date.now();
      const groupResults = await syncGroupRecordsWithRetry({
        group,
        requestTarget,
        onProgress,
        completedOffset: processedCount,
        totalCount: recordIdsToSync.length,
        requestSpacingMs: options?.requestSpacingMs,
        rateLimitBaseDelayMs: options?.rateLimitBaseDelayMs,
        rateLimitMaxDelayMs: options?.rateLimitMaxDelayMs,
        rateLimitRetryAttempts: options?.rateLimitRetryAttempts,
        shouldStop,
        signal,
      });
      const groupSyncDiagnostics =
        groupResults?.syncDiagnostics && typeof groupResults.syncDiagnostics === 'object'
          ? groupResults.syncDiagnostics
          : null;
      let groupPaused =
        groupResults?.syncPaused && typeof groupResults.syncPaused === 'object'
          ? groupResults.syncPaused
          : null;

      results.push(...groupResults);
      processedCount += groupResults.length;
      if (groupResults?.syncCanceled === true) {
        syncCanceled = true;
      }
      if (groupPaused) {
        const shouldBlockRemainingGroups = groupPaused.blocking !== false;
        groupPaused = extendSyncPausedMetadata(
          groupPaused,
          shouldBlockRemainingGroups
            ? syncGroups
                .slice(groupIndex + 1)
                .flatMap((nextGroup) =>
                  Array.isArray(nextGroup?.records) ? nextGroup.records : [],
                )
            : [],
          {
            confirmedSuccessCount: results.filter((result) => result.success).length,
          },
        );
      }

      await addSyncHistoryEntry({
        trigger: options.trigger || 'manual',
        syncScope: options.syncScope || 'pending',
        startedAt: groupStartedAt,
        finishedAt: Date.now(),
        totalCount: group.records.length,
        requestedTotalCount: group.records.length,
        skippedCount: 0,
        successCount: groupResults.filter((result) => result.success).length,
        failedCount: groupResults.filter((result) => !result.success).length,
        debugUrl: pickBatchDebugUrl(groupResults) || null,
        platform: group.platform || 'unknown',
        syncType: group.syncType || '',
        workflow: group.workflow || '',
        target: buildSyncHistoryTarget(requestTarget, {
          platform: group.platform || 'unknown',
          syncType: group.syncType || '',
          workflow: group.workflow || '',
        }),
        recordIds: group.records.map((record) => record.id),
        skippedRecordIds: [],
        items: groupResults,
        syncRequest: groupSyncDiagnostics,
        syncPaused: groupPaused,
        batchStartedAt: startedAt,
        batchRequestedTotalCount: requestedRecordIds.length,
        batchSyncedCount: recordIdsToSync.length,
        batchSkippedCount: skippedRecordIds.length,
      });

      if (syncCanceled) {
        break;
      }

      if (groupPaused) {
        syncPaused = mergeSyncPausedMetadata(syncPaused, groupPaused, {
          confirmedSuccessCount: results.filter((result) => result.success).length,
        });
        if (groupPaused.blocking !== false) {
          break;
        }
      }
    }

    let commentLeadsSyncedCount = 0;
    let commentLeadsSkippedCount = 0;
    let commentLeadsFailedCount = 0;
    const commentLeadsCanceledRecordIds = [];
    const commentLeadHistoryItems = [];
    const hasAnyStoredCommentLeads = preparedRecordsToSync.some((record) =>
      hasStoredCommentLeadsPayload(record.syncType, record.syncPayload),
    );

    if (commentLeadsConfig.enabled && leadsRetryRecords.length > 0) {
      for (const record of leadsRetryRecords) {
        if (isSyncCancellationRequested(shouldStop, signal)) {
          syncCanceled = true;
          break;
        }
        const debugUrl = normalizeDebugUrl(record?.lastSyncDebugUrl || '');
        results.push({
          recordId: record.id,
          platform: record.platform || 'unknown',
          type: record.syncType || record.type,
          sourceType: record.sourceType || record.type,
          workflow: record.workflow || '',
          noteType: getSingleNoteType(record.syncPayload || record.payload),
          success: true,
          reason: 'COMMENT_LEADS_RETRY_ONLY',
          message: '内容已同步，重试客资同步',
          debugUrl: debugUrl || null,
          rawResponse: null,
          error: null,
        });
        processedCount += 1;
        if (onProgress) {
          onProgress({
            phase: 'batch_sync',
            current: processedCount,
            total: recordIdsToSync.length,
            message: `正在处理第 ${processedCount}/${recordIdsToSync.length} 条记录...`,
            recordId: record.id,
          });
        }
      }
    }

    if (
      !syncCanceled &&
      !syncPaused &&
      (commentLeadsConfig.enabled || hasAnyStoredCommentLeads)
    ) {
      const resultByRecordId = new Map(
        results.map((item) => [String(item?.recordId || ''), item]),
      );
      const eligibleRecords = preparedRecordsToSync.filter((record) => {
        if (!isCommentLeadsEligibleSyncType(record.syncType)) return false;
        const current = resultByRecordId.get(record.id);
        if (!current?.success) return false;
        return (
          commentLeadsConfig.enabled ||
          hasStoredCommentLeadsPayload(record.syncType, record.syncPayload)
        );
      });

      const markCommentLeadsCanceled = async (records = []) => {
        for (const pendingRecord of records) {
          if (!pendingRecord?.id) continue;
          if (!commentLeadsCanceledRecordIds.includes(pendingRecord.id)) {
            commentLeadsCanceledRecordIds.push(pendingRecord.id);
          }
          await updateRecord(pendingRecord.id, {
            status: RECORD_STATUS.FAILED,
            lastSyncedAt: Date.now(),
            lastSyncReason: 'COMMENT_LEADS_SYNC_CANCELED',
          });
        }
      };

      for (let eligibleIndex = 0; eligibleIndex < eligibleRecords.length; eligibleIndex += 1) {
        const record = eligibleRecords[eligibleIndex];
        if (isSyncCancellationRequested(shouldStop, signal)) {
          syncCanceled = true;
          await markCommentLeadsCanceled(eligibleRecords.slice(eligibleIndex));
          break;
        }
        const existingResult = resultByRecordId.get(record.id);
        const leadResult = buildCommentLeadsPayloadForRecord(
          {
            type: record.syncType,
            payload: record.syncPayload,
          },
          commentLeadsConfig,
          { preferStored: true },
        );
        const latestRecord = (await getRecord(record.id)) || record;
        const basePayload =
          latestRecord?.payload && typeof latestRecord.payload === 'object'
            ? latestRecord.payload
            : {};
        const canSyncStoredLeads = leadResult.source === 'stored' && Boolean(leadResult.payload);

        if (leadResult.skipReason || !leadResult.payload) {
          commentLeadsSkippedCount += 1;
          const nextPayload = applyCommentLeadsSyncState(basePayload, {
            config: commentLeadsConfig,
            leadResult,
            syncStatus:
              leadResult.skipReason === 'disabled' ? 'not_started' : 'skipped',
            syncError: '',
          });
          await updateRecord(record.id, {
            payload: nextPayload,
          });
          if (record.retryCommentLeadsOnly) {
            await markRecordSynced(record.id, existingResult?.debugUrl || null);
            if (existingResult) {
              existingResult.reason = ERROR_REASON.NONE;
              existingResult.message = `客资已跳过（${leadResult.skipReason || 'skip'}）`;
            }
          }
          commentLeadHistoryItems.push({
            recordId: record.id,
            type: SYNC_TYPE.COMMENT_LEADS,
            platform: record.platform || 'unknown',
            sourceType: record.sourceType || record.type,
            workflow: 'shared_comment_leads',
            noteType: null,
            success: true,
            reason:
              leadResult.skipReason === 'disabled'
                ? 'COMMENT_LEADS_NOT_STARTED'
                : 'COMMENT_LEADS_SKIPPED',
            message:
              leadResult.skipReason === 'disabled'
                ? '客资同步未开启'
                : `客资已跳过（${leadResult.skipReason || 'skip'}）`,
            debugUrl: null,
            rawResponse: null,
            error: null,
          });
          continue;
        }

        const leadSyncResult = await sync(
          {
            syncType: SYNC_TYPE.COMMENT_LEADS,
            target: requestTarget,
            payload: leadResult.payload,
          },
          {shouldStop, signal},
        );
        if (leadSyncResult?.canceled) {
          syncCanceled = true;
          await markCommentLeadsCanceled(eligibleRecords.slice(eligibleIndex));
          break;
        }
        const leadsDebugUrl = extractDebugUrl(leadSyncResult);
        if (leadSyncResult.ok) {
          commentLeadsSyncedCount += 1;
          const nextPayload = applyCommentLeadsSyncState(basePayload, {
            config: commentLeadsConfig,
            leadResult,
            syncStatus: 'done',
            syncError: '',
          });
          await updateRecord(record.id, {
            payload: nextPayload,
          });
          if (record.retryCommentLeadsOnly) {
            await markRecordSynced(
              record.id,
              leadsDebugUrl || existingResult?.debugUrl || null,
            );
            if (existingResult) {
              existingResult.reason = ERROR_REASON.NONE;
              existingResult.message = '客资同步成功';
              existingResult.debugUrl =
                leadsDebugUrl || existingResult.debugUrl || null;
              existingResult.rawResponse = {
                content: existingResult.rawResponse,
                commentLeads: leadSyncResult,
              };
            }
          }
          commentLeadHistoryItems.push({
            recordId: record.id,
            type: SYNC_TYPE.COMMENT_LEADS,
            platform: record.platform || 'unknown',
            sourceType: record.sourceType || record.type,
            workflow: 'shared_comment_leads',
            noteType: null,
            success: true,
            reason: ERROR_REASON.NONE,
            message: canSyncStoredLeads ? '客资同步成功（使用已命中结果）' : '客资同步成功',
            debugUrl: leadsDebugUrl || null,
            rawResponse: leadSyncResult,
            error: null,
          });
          continue;
        }

        commentLeadsFailedCount += 1;
        const failedMessage =
          leadSyncResult.error?.message ||
          leadSyncResult.message ||
          '客资同步失败';
        const nextPayload = applyCommentLeadsSyncState(basePayload, {
          config: commentLeadsConfig,
          leadResult,
          syncStatus: 'failed',
          syncError: failedMessage,
        });
        await updateRecord(record.id, {
          status: RECORD_STATUS.FAILED,
          lastSyncedAt: Date.now(),
          lastSyncReason: 'COMMENT_LEADS_SYNC_FAILED',
          lastSyncDebugUrl: leadsDebugUrl || null,
          payload: nextPayload,
        });
        if (existingResult) {
          existingResult.success = false;
          existingResult.reason = 'COMMENT_LEADS_SYNC_FAILED';
          existingResult.message = '内容表已同步，客资表同步失败';
          existingResult.debugUrl = leadsDebugUrl || existingResult.debugUrl || null;
          existingResult.error = {
            code: 'COMMENT_LEADS_SYNC_FAILED',
            message: failedMessage,
          };
          existingResult.rawResponse = {
            content: existingResult.rawResponse,
            commentLeads: leadSyncResult,
          };
        }
        commentLeadHistoryItems.push({
          recordId: record.id,
          type: SYNC_TYPE.COMMENT_LEADS,
          platform: record.platform || 'unknown',
          sourceType: record.sourceType || record.type,
          workflow: 'shared_comment_leads',
          noteType: null,
          success: false,
          reason: 'COMMENT_LEADS_SYNC_FAILED',
          message: failedMessage,
          debugUrl: leadsDebugUrl || null,
          rawResponse: leadSyncResult,
          error: {
            code: 'COMMENT_LEADS_SYNC_FAILED',
            message: failedMessage,
          },
        });
      }

      if (commentLeadHistoryItems.length > 0) {
        const commentLeadPlatforms = [
          ...new Set(commentLeadHistoryItems.map((item) => item.platform || 'unknown')),
        ];
        await addSyncHistoryEntry({
          trigger: options.trigger || 'manual',
          syncScope: options.syncScope || 'pending',
          startedAt,
          finishedAt: Date.now(),
          totalCount: commentLeadHistoryItems.length,
          requestedTotalCount: requestedRecordIds.length,
          skippedCount: commentLeadsSkippedCount,
          successCount: commentLeadHistoryItems.filter((item) => item.success).length,
          failedCount: commentLeadHistoryItems.filter((item) => !item.success).length,
          debugUrl: pickBatchDebugUrl(commentLeadHistoryItems) || null,
          platform:
            commentLeadPlatforms.length === 1
              ? commentLeadPlatforms[0]
              : 'mixed',
          syncType: SYNC_TYPE.COMMENT_LEADS,
          workflow: 'shared_comment_leads',
          target: buildSyncHistoryTarget(requestTarget, {
            platform:
              commentLeadPlatforms.length === 1
                ? commentLeadPlatforms[0]
                : 'mixed',
            syncType: SYNC_TYPE.COMMENT_LEADS,
            workflow: 'shared_comment_leads',
          }),
          recordIds: commentLeadHistoryItems.map((item) => item.recordId),
          skippedRecordIds: [],
          items: commentLeadHistoryItems,
          batchStartedAt: startedAt,
          batchRequestedTotalCount: requestedRecordIds.length,
          batchSyncedCount: recordIdsToSync.length,
          batchSkippedCount: skippedRecordIds.length,
        });
      }
    }

    if (syncCanceled || isSyncCancellationRequested(shouldStop, signal)) {
      await resetCanceledSyncState();
      if (onProgress) {
        onProgress({
          phase: 'sync_canceled',
          message: '任务已取消，未继续同步',
        });
      }
      return buildCanceledBatchSyncResult({
        requestedRecordIds,
        recordIdsToSync,
        skippedRecordIds,
        results,
        commentLeadsSyncedCount,
        commentLeadsSkippedCount,
        commentLeadsFailedCount,
        commentLeadsCanceledRecordIds,
      });
    }

    // 统计结果
    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.filter(
      (r) => r.success !== true && r.reason !== 'SYNC_BATCH_PAUSED',
    ).length;
    const pausedCount = Number(syncPaused?.pausedCount || 0);

    if (failedCount === 0 && pausedCount === 0) {
      await updateSync({
        status: SYNC_STATUS.SUCCESS,
        lastSyncedAt: new Date().toISOString(),
        error: null,
      });
    } else if (pausedCount > 0) {
      await updateSync({
        status: SYNC_STATUS.FAILED,
        error: {
          code: 'BATCH_SYNC_PAUSED',
          message:
            syncPaused?.message ||
            `同步已暂停：已确认成功 ${successCount} 条，剩余 ${pausedCount} 条待继续`,
        },
      });
    } else {
      await updateSync({
        status: SYNC_STATUS.FAILED,
        error: {
          code: 'BATCH_SYNC_PARTIAL_FAILURE',
          message: `${failedCount} 条记录同步失败`,
        },
      });
    }

    if (onProgress) {
      onProgress({
        phase: 'batch_done',
        message:
          pausedCount > 0
            ? `批量同步已暂停：成功 ${successCount}，待继续 ${pausedCount}`
            : `批量同步完成：成功 ${successCount}，失败 ${failedCount}`,
        successCount,
        failedCount,
        pausedCount,
      });
    }

    if (syncGroups.length === 0 && results.length > 0) {
      await addSyncHistoryEntry({
        trigger: options.trigger || 'manual',
        syncScope: options.syncScope || 'pending',
        startedAt,
        finishedAt: Date.now(),
        totalCount: results.length,
        requestedTotalCount: requestedRecordIds.length,
        skippedCount: skippedRecordIds.length,
        successCount,
        failedCount,
        debugUrl: pickBatchDebugUrl(results) || null,
        platform: 'unknown',
        syncType: '',
        workflow: 'shared_unknown',
        target: buildSyncHistoryTarget(requestTarget, {
          platform: 'unknown',
          syncType: '',
          workflow: 'shared_unknown',
        }),
        recordIds: [...recordIdsToSync],
        skippedRecordIds: [...skippedRecordIds],
        items: results,
      });
    }

    trackSyncSuccess(successCount, {
      source: 'batch_record_sync',
      requestedCount: requestedRecordIds.length,
      failedCount,
    });

    return {
      ok: failedCount === 0 && pausedCount === 0,
      results,
      successCount,
      failedCount,
      pausedCount,
      pausedRecordIds: Array.isArray(syncPaused?.pausedRecordIds)
        ? syncPaused.pausedRecordIds
        : [],
      pausedReason: syncPaused?.reason || '',
      pausedMessage: syncPaused?.message || '',
      requestedCount: requestedRecordIds.length,
      syncedCount: recordIdsToSync.length,
      skippedCount: skippedRecordIds.length,
      commentLeadsSyncedCount,
      commentLeadsSkippedCount,
      commentLeadsFailedCount,
    };
  }

  return Object.freeze({
    syncRecordBatch,
    runSyncRecordBatch,
  });
}
