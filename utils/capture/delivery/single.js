// L2 single: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createSingleStage({state, ports, operations}) {
  const {
    ERROR_REASON,
    RECORD_STATUS,
    SYNC_STATUS,
    SYNC_TYPE,
    console,
    getCaptureSettings,
    getRecord,
    getTarget,
    markRecordSynced,
    resolveActiveCloudCaptureTaskId,
    resolveSyncTableName,
    sync,
    trackSyncSuccess,
    updateRecord,
    updateSync,
  } = ports;
  const appendSingleSyncHistoryEntry = (...args) => operations.appendSingleSyncHistoryEntry(...args);
  const applyCommentLeadsSyncState = (...args) => operations.applyCommentLeadsSyncState(...args);
  const applySyncPreferencesToPayload = (...args) => operations.applySyncPreferencesToPayload(...args);
  const buildCanceledSyncResult = (...args) => operations.buildCanceledSyncResult(...args);
  const buildCommentLeadsPayloadForRecord = (...args) => operations.buildCommentLeadsPayloadForRecord(...args);
  const buildSyncTargetPayload = (...args) => operations.buildSyncTargetPayload(...args);
  const extractDebugUrl = (...args) => operations.extractDebugUrl(...args);
  const isCommentLeadsEligibleSyncType = (...args) => operations.isCommentLeadsEligibleSyncType(...args);
  const isSyncCancellationRequested = (...args) => operations.isSyncCancellationRequested(...args);
  const normalizeCommentLeadsConfig = (...args) => operations.normalizeCommentLeadsConfig(...args);
  const resetCanceledSyncState = (...args) => operations.resetCanceledSyncState(...args);
  const resolveSyncInputForRecord = (...args) => operations.resolveSyncInputForRecord(...args);


  async function syncRecord(recordId, onProgress = null, options = {}) {
    const startedAt = Date.now();
    const shouldStop = options?.shouldStop;
    const signal = options?.signal || null;
    const historyTrigger = String(options?.trigger || 'single').trim() || 'single';
    try {
      if (isSyncCancellationRequested(shouldStop, signal)) {
        await resetCanceledSyncState();
        return buildCanceledSyncResult({recordId});
      }
      if (onProgress) {
        onProgress({
          phase: 'sync_start',
          message: '正在同步到后台...',
          recordId,
        });
      }

      // 更新同步状态
      await updateSync({
        status: SYNC_STATUS.SYNCING,
        lastAttemptedAt: new Date().toISOString(),
        error: null,
      });

      // 更新记录状态
      await updateRecord(recordId, {
        status: RECORD_STATUS.DRAFT,
      });

      // 获取目标配置
      const target = await getTarget();

      // 从数据池获取记录
      const record = await getRecord(recordId);

      if (!record) {
        throw new Error('记录不存在');
      }

      const requestTarget = buildSyncTargetPayload(target);
      const captureSettings = options?.captureSettings || await getCaptureSettings();
      const commentLeadsConfig = normalizeCommentLeadsConfig(
        options?.commentLeadsConfig || {},
      );
      const syncInput = resolveSyncInputForRecord(record, requestTarget);
      syncInput.payload = applySyncPreferencesToPayload(
        syncInput.payload,
        captureSettings,
      );
      const resolvedTableName = syncInput.tableName || resolveSyncTableName(requestTarget, syncInput.syncType);

      console.log('[CaptureSync] Sync request target:', {
        feishuAppToken: requestTarget.feishuAppToken,
        tableId: resolvedTableName,
        recordId,
        platform: syncInput.platform,
        syncType: syncInput.syncType,
        workflow: syncInput.workflow,
      });

      // 调用后端 sync API
      const syncResult = await sync(
        {
          syncType: syncInput.syncType,
          target: requestTarget,
          payload: syncInput.payload,
          captureTaskId:
            String(options?.captureTaskId || '').trim() ||
            resolveActiveCloudCaptureTaskId(),
          captureTaskItemAttemptId: String(
            options?.captureTaskItemAttemptId || '',
          ).trim(),
          captureTaskItemRequestHash: String(
            options?.captureTaskItemRequestHash || '',
          ).trim(),
        },
        {shouldStop, signal},
      );

      if (syncResult?.canceled) {
        await resetCanceledSyncState();
        return buildCanceledSyncResult({recordId, rawResponse: syncResult});
      }

      const debugUrl = extractDebugUrl(syncResult);

      // 检查同步是否成功
      if (syncResult.ok) {
        // 同步成功
        await markRecordSynced(recordId, debugUrl);
        let commentLeadsOutcome = {
          enabled: commentLeadsConfig.enabled,
          skipped: true,
          skipReason: 'disabled',
          matchedCount: 0,
        };

        if (isCommentLeadsEligibleSyncType(syncInput.syncType)) {
          const leadResult = buildCommentLeadsPayloadForRecord(
            {
              type: syncInput.syncType,
              payload: syncInput.payload,
            },
            commentLeadsConfig,
            { preferStored: true },
          );
          const latestRecord = (await getRecord(recordId)) || record;
          const basePayload =
            latestRecord?.payload && typeof latestRecord.payload === 'object'
              ? latestRecord.payload
              : {};
          const canSyncStoredLeads = leadResult.source === 'stored' && Boolean(leadResult.payload);

          if (!commentLeadsConfig.enabled && !canSyncStoredLeads) {
            const nextPayload = applyCommentLeadsSyncState(basePayload, {
              config: commentLeadsConfig,
              leadResult,
              syncStatus: 'not_started',
              syncError: '',
            });
            await updateRecord(recordId, { payload: nextPayload });
          } else if (leadResult.skipReason) {
            const nextPayload = applyCommentLeadsSyncState(basePayload, {
              config: commentLeadsConfig,
              leadResult,
              syncStatus: 'skipped',
              syncError: '',
            });
            await updateRecord(recordId, { payload: nextPayload });
            commentLeadsOutcome = {
              enabled: commentLeadsConfig.enabled || canSyncStoredLeads,
              skipped: true,
              skipReason: leadResult.skipReason,
              matchedCount: leadResult.matchedCount,
            };
          } else if (leadResult.payload) {
            if (isSyncCancellationRequested(shouldStop, signal)) {
              await updateRecord(recordId, {
                status: RECORD_STATUS.FAILED,
                lastSyncedAt: Date.now(),
                lastSyncReason: 'COMMENT_LEADS_SYNC_CANCELED',
              });
              await resetCanceledSyncState();
              return buildCanceledSyncResult({
                recordId,
                partialContentSuccess: true,
              });
            }
            const leadsSyncResult = await sync(
              {
                syncType: SYNC_TYPE.COMMENT_LEADS,
                target: requestTarget,
                payload: leadResult.payload,
              },
              {shouldStop, signal},
            );
            if (leadsSyncResult?.canceled) {
              await updateRecord(recordId, {
                status: RECORD_STATUS.FAILED,
                lastSyncedAt: Date.now(),
                lastSyncReason: 'COMMENT_LEADS_SYNC_CANCELED',
              });
              await resetCanceledSyncState();
              return buildCanceledSyncResult({
                recordId,
                partialContentSuccess: true,
                rawResponse: {
                  content: syncResult,
                  commentLeads: leadsSyncResult,
                },
              });
            }
            const leadsDebugUrl = extractDebugUrl(leadsSyncResult);
            if (!leadsSyncResult.ok) {
              const syncErrorMessage =
                leadsSyncResult.error?.message ||
                leadsSyncResult.message ||
                '客资同步失败';
              const nextPayload = applyCommentLeadsSyncState(basePayload, {
                config: commentLeadsConfig,
                leadResult,
                syncStatus: 'failed',
                syncError: syncErrorMessage,
              });
              await updateRecord(recordId, {
                status: RECORD_STATUS.FAILED,
                lastSyncedAt: Date.now(),
                lastSyncReason: 'COMMENT_LEADS_SYNC_FAILED',
                lastSyncDebugUrl: leadsDebugUrl || null,
                payload: nextPayload,
              });
              await updateSync({
                status: SYNC_STATUS.FAILED,
                error: {
                  ...(leadsSyncResult.error || {}),
                  code: 'COMMENT_LEADS_SYNC_FAILED',
                  message: syncErrorMessage,
                  debugUrl: leadsDebugUrl || null,
                },
              });
              if (onProgress) {
                onProgress({
                  phase: 'sync_failed',
                  message: '内容表已同步，客资表同步失败',
                  recordId,
                });
              }
              const result = {
                ok: false,
                recordId,
                platform: syncInput.platform,
                type: syncInput.syncType,
                workflow: syncInput.workflow,
                debugUrl: leadsDebugUrl || debugUrl,
                reason: 'COMMENT_LEADS_SYNC_FAILED',
                message: '内容表已同步，客资表同步失败',
                rawResponse: {
                  content: syncResult,
                  commentLeads: leadsSyncResult,
                },
                partialContentSuccess: true,
                commentLeads: {
                  enabled: true,
                  skipped: false,
                  matchedCount: leadResult.matchedCount,
                  ok: false,
                },
                error: {
                  code: 'COMMENT_LEADS_SYNC_FAILED',
                  message: syncErrorMessage,
                },
              };
              await appendSingleSyncHistoryEntry({
                requestTarget,
                syncInput,
                recordId,
                result,
                startedAt,
                trigger: historyTrigger,
              });
              return result;
            }

            const nextPayload = applyCommentLeadsSyncState(basePayload, {
              config: commentLeadsConfig,
              leadResult,
              syncStatus: 'done',
              syncError: '',
            });
            await updateRecord(recordId, { payload: nextPayload });
            commentLeadsOutcome = {
              enabled: commentLeadsConfig.enabled || canSyncStoredLeads,
              skipped: false,
              skipReason: '',
              matchedCount: leadResult.matchedCount,
              ok: true,
            };
          }
        }

        await updateSync({
          status: SYNC_STATUS.SUCCESS,
          lastSyncedAt: new Date().toISOString(),
          error: null,
        });

        if (onProgress) {
          onProgress({
            phase: 'synced',
            message: '同步成功！',
            recordId,
          });
        }

        const result = {
          ok: true,
          recordId,
          platform: syncInput.platform,
          type: syncInput.syncType,
          workflow: syncInput.workflow,
          debugUrl,
          reason: ERROR_REASON.NONE,
          message: '同步成功',
          rawResponse: syncResult,
          commentLeads: isCommentLeadsEligibleSyncType(syncInput.syncType)
            ? commentLeadsOutcome
            : null,
          error: null,
        };
        trackSyncSuccess(1, {
          syncType: syncInput.syncType,
          workflow: syncInput.workflow,
          source: 'single_record_sync',
        });
        await appendSingleSyncHistoryEntry({
          requestTarget,
          syncInput,
          recordId,
          result,
          startedAt,
          trigger: historyTrigger,
        });
        return result;
      } else {
        // 同步失败
        await updateRecord(recordId, {
          status: RECORD_STATUS.FAILED,
          lastSyncedAt: Date.now(),
          lastSyncReason: syncResult.error?.reason || syncResult.reason || 'SYNC_ERROR',
          lastSyncDebugUrl: debugUrl || null,
        });

        await updateSync({
          status: SYNC_STATUS.FAILED,
          error: {
            ...(syncResult.error || {}),
            debugUrl,
          },
        });

        if (onProgress) {
          onProgress({
            phase: 'sync_failed',
            message: `同步失败: ${syncResult.error?.message || '未知错误'}`,
            recordId,
          });
        }

        const result = {
          ok: false,
          recordId,
          platform: syncInput.platform,
          type: syncInput.syncType,
          workflow: syncInput.workflow,
          debugUrl,
          reason: syncResult.error?.reason || syncResult.reason || 'SYNC_ERROR',
          message: syncResult.error?.message || syncResult.message || '同步失败',
          rawResponse: syncResult,
          error: syncResult.error,
        };
        await appendSingleSyncHistoryEntry({
          requestTarget,
          syncInput,
          recordId,
          result,
          startedAt,
          trigger: historyTrigger,
        });
        return result;
      }
    } catch (error) {
      console.error('[CaptureSync] Sync record failed:', error);

      await updateRecord(recordId, {
        status: RECORD_STATUS.FAILED,
        lastSyncedAt: Date.now(),
        lastSyncReason: 'SYNC_ERROR',
        lastSyncDebugUrl: null,
      });

      await updateSync({
        status: SYNC_STATUS.FAILED,
        error: {
          code: 'SYNC_ERROR',
          message: error.message,
        },
      });

      const result = {
        ok: false,
        recordId,
        platform: 'unknown',
        type: null,
        workflow: 'shared_unknown',
        debugUrl: null,
        reason: 'SYNC_ERROR',
        message: error.message,
        rawResponse: null,
        error: {
          code: 'SYNC_ERROR',
          message: error.message,
        },
      };
      await appendSingleSyncHistoryEntry({
        requestTarget: null,
        syncInput: {
          platform: 'unknown',
          syncType: '',
          workflow: 'shared_unknown',
          payload: {},
        },
        recordId,
        result,
        startedAt,
        trigger: historyTrigger,
      });
      return result;
    }
  }

  return Object.freeze({
    syncRecord,
  });
}
