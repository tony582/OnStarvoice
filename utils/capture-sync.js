/**
 * onstarvoice V2.0 Capture & Sync Integration Module
 * 采集与同步集成层 - M4 插件与后端接通
 *
 * 本模块负责：
 * 1. 调用采集模块获取数据
 * 2. 将采集结果入池（dataPool）
 * 3. 调用后端 API 同步数据
 * 4. 更新同步状态
 */

import { sync, syncBatch, verify } from './api.js';

import {
  addRecord,
  addRecords,
  addSyncHistoryEntry,
  getDataPool,
  getRecord,
  getRecords,
  updateRecord,
  markRecordSynced,
  getAuth,
  getTarget,
  updateCapture,
  updateRuntime,
  updateSync,
  resetCapture,
  resetSync,
  deleteRecord,
} from './storage.js';

import {
  SYNC_TYPE,
  CAPTURE_STATUS,
  SYNC_STATUS,
  RECORD_STATUS,
  ERROR_REASON,
  MESSAGE_TYPE,
  PAGE_TYPE,
} from './constants.js';
import { getCaptureSettings } from './capture-settings.js';
import { extractNoteId, detectPageType, detectPlatformFromUrl } from './helpers.js';
import { createRecordEnvelope } from './platform/record-envelope.js';
import {
  buildSyncHistoryTarget,
  buildSyncInput as buildPlatformSyncInput,
  resolveSyncTableName,
} from './platform/sync-router.js';
import { parseInteractionCount } from './helpers.js';

const COMMENT_CAPTURE_STATUS = {
  NOT_STARTED: 'not_started',
  CAPTURING: 'capturing',
  DONE: 'done',
  PARTIAL: 'partial',
  FAILED: 'failed',
};

const DETAIL_CAPTURE_STATUS = {
  NOT_STARTED: 'not_started',
  CAPTURING: 'capturing',
  DONE: 'done',
  FAILED: 'failed',
};

const DETAIL_CAPTURE_FAILURE_CODE = {
  NONE: 'NONE',
  LINK_MISSING: 'LINK_MISSING',
  PAGE_OPEN_TIMEOUT: 'PAGE_OPEN_TIMEOUT',
  PAGE_OPEN_FAILED: 'PAGE_OPEN_FAILED',
  NOTE_CAPTURE_FAILED: 'NOTE_CAPTURE_FAILED',
  COMMENTS_CAPTURE_FAILED: 'COMMENTS_CAPTURE_FAILED',
  BLOGGER_METRICS_FAILED: 'BLOGGER_METRICS_FAILED',
  CONTEXT_INTERRUPTED: 'CONTEXT_INTERRUPTED',
  CANCELED: 'CANCELED',
  INVALID_RECORD: 'INVALID_RECORD',
  UNKNOWN: 'UNKNOWN',
};

const DETAIL_CAPTURE_FAILURE_CATEGORY = {
  NONE: 'none',
  LINK_MISSING: 'link_missing',
  PAGE_FAILED: 'page_failed',
  CONTEXT_INTERRUPTED: 'context_interrupted',
  USER_CANCELED: 'user_canceled',
  INVALID_RECORD: 'invalid_record',
  UNKNOWN: 'unknown',
};

const BLOGGER_METRICS_CAPTURE_STATUS = {
  NOT_STARTED: 'not_started',
  DONE: 'done',
  FAILED: 'failed',
};

const COMMENT_CONTENT_MAX_LENGTH = 280;
const DETAIL_CAPTURE_NAV_TIMEOUT_MS = 90000;
const DETAIL_CAPTURE_NAV_POLL_MS = 280;
const DETAIL_CAPTURE_AFTER_NAV_WAIT_MS = 2000;
const PROFILE_AFTER_NAV_WAIT_MS = 2000;
const DEFAULT_BLOGGER_PROFILE_TABLE_NAME = '博主信息表';
const DEFAULT_BLOGGER_NOTES_TABLE_NAME = '博主笔记采集';
const DEFAULT_KEYWORD_NOTES_TABLE_NAME = '关键词笔记采集';
const DEFAULT_COMMENT_LEADS_TABLE_NAME = 'comment_leads';
const MAX_SYNC_RECORDS_PER_BATCH = 500;
const MAX_SYNC_RECORDS_PER_REQUEST = 10;
const MAX_SYNC_REQUEST_PAYLOAD_BYTES = 1_800_000;
const DEFAULT_CHECK_SYNC_TYPES = [
  SYNC_TYPE.SINGLE_NOTE,
  SYNC_TYPE.COMMENTS,
  SYNC_TYPE.KEYWORD_NOTES,
  SYNC_TYPE.BLOGGER_PROFILE,
  SYNC_TYPE.BLOGGER_NOTES,
];
const COMMENT_LEADS_ELIGIBLE_SYNC_TYPES = new Set([
  SYNC_TYPE.SINGLE_NOTE,
  SYNC_TYPE.COMMENTS,
  SYNC_TYPE.BLOGGER_NOTES,
  SYNC_TYPE.KEYWORD_NOTES,
]);

function isCommentLeadsEligibleSyncType(syncType) {
  return COMMENT_LEADS_ELIGIBLE_SYNC_TYPES.has(syncType);
}

function hasCommentLeadsEligibleType(syncTypes = []) {
  return Array.isArray(syncTypes)
    ? syncTypes.some((syncType) => isCommentLeadsEligibleSyncType(syncType))
    : false;
}

function applySyncPreferencesToPayload(payload = {}, captureSettings = {}) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  return {
    ...compactPayloadForBackendSync(safePayload),
    skipOfficialAccounts: captureSettings.skipOfficialAccounts !== false,
  };
}

function compactPayloadForBackendSync(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const next = {...source};
  const items = Array.isArray(source.items)
    ? source.items
        .filter((item) => item && typeof item === 'object')
        .map((item) => compactSyncItemForBackend(item))
    : [];

  if (items.length > 0) {
    next.items = items.slice(0, 1);
    delete next.detailPayload;
  }

  delete next.detailCaptureDiagnosticMessage;
  delete next.detailCaptureFailureStage;
  delete next.detailCaptureFailureCategory;
  delete next.cardImageCandidates;
  delete next.cardVideoCandidates;
  delete next.domLocator;
  delete next.domMatchHints;

  return compactSyncItemForBackend(next);
}

// 去重并限制媒体直链数量，避免 payload 膨胀；只保留 http(s) 直链。
function trimMediaUrlList(list, primary = '', max = 3) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const url = String(value || '').trim();
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };
  push(primary);
  (Array.isArray(list) ? list : []).forEach(push);
  return out.slice(0, max);
}

function compactSyncItemForBackend(item = {}) {
  const next = item && typeof item === 'object' ? {...item} : {};

  delete next.domLocator;
  delete next.domMatchHints;
  delete next.cardImageCandidates;
  delete next.cardVideoCandidates;
  delete next.mediaDiagnostics;
  delete next.detailDiagnostics;
  delete next.captureDiagnostics;

  // 保留媒体直链：后台「下载附件」依赖 videoUrl/audioUrl（封面+视频+音频）。
  // 之前这里整列清空导致采到的视频直链入库即丢，后台只能下封面。
  next.videoUrls = trimMediaUrlList(next.videoUrls, next.videoUrl);
  next.audioUrls = trimMediaUrlList(next.audioUrls, next.audioUrl);
  next.musicUrls = trimMediaUrlList(next.musicUrls, next.musicUrl);
  next.videoUrl = next.videoUrl || next.videoUrls[0] || '';
  next.audioUrl = next.audioUrl || next.audioUrls[0] || '';
  next.musicUrl = next.musicUrl || next.musicUrls[0] || '';

  return next;
}

// ==================== M4-03: 前端接入 sync 调用 ====================

/**
 * 采集并同步（完整流程）
 * @param {Object} options - 配置选项
 * @param {string} options.mode - 采集模式
 * @param {Function} options.onProgress - 进度回调
 * @param {boolean} options.autoSync - 是否自动同步（默认 true）
 * @param {Object} options.captureParams - 采集参数透传
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSync({
  mode = 'auto',
  onProgress = null,
  autoSync = true,
  captureParams = {},
} = {}) {
  try {
    // 步骤 1: 开始采集
    if (onProgress) {
      onProgress({
        phase: 'capture_start',
        message: '开始采集数据...',
      });
    }

    await updateCapture({
      status: CAPTURE_STATUS.CAPTURING,
      error: null,
    });

    // 步骤 2: 执行采集
    const captureResult = await captureInActiveTab({
      mode,
      onProgress,
      captureParams,
    });

    // 步骤 3: 检查采集是否成功
    if (!captureResult.ok) {
      await updateCapture({
        status: CAPTURE_STATUS.FAILED,
        error: captureResult.error,
      });

      return {
        ok: false,
        phase: 'capture',
        captureResult,
        syncResult: null,
        recordId: null,
        error: captureResult.error,
      };
    }

    // 步骤 4: 采集成功，将结果入池
    if (onProgress) {
      onProgress({
        phase: 'saving',
        message: '保存到本地数据池...',
      });
    }

    const recordsToSave = buildRecordsForStorage(captureResult);
    let savedRecords = [];
    let recordIds = [];
    let recordId = null;

    if (recordsToSave.length > 0) {
      savedRecords =
        recordsToSave.length === 1
          ? [await addRecord(recordsToSave[0])]
          : await addRecords(recordsToSave);
      recordIds = savedRecords.map((record) => record?.id).filter(Boolean);
      recordId = recordIds[0] || null;
    }

    await updateCapture({
      status: CAPTURE_STATUS.SUCCESS,
      lastCapturedAt: new Date().toISOString(),
      error: null,
    });

    if (onProgress) {
      onProgress({
        phase: 'saved',
        message: `已保存到本地（${recordIds.length} 条）`,
        recordId,
        recordIds,
      });
    }

    // 步骤 5: 如果不自动同步，到此结束
    if (!autoSync || recordIds.length === 0) {
      return {
        ok: true,
        phase: 'saved',
        captureResult,
        syncResult: null,
        recordId,
        recordIds,
        error: null,
      };
    }

    // 步骤 6: 执行同步前检查（M4-05）
    if (onProgress) {
      onProgress({
        phase: 'sync_check',
        message: '正在校验授权与同步配置...',
        recordId,
      });
    }
    const captureSettings = await getCaptureSettings();
    const commentLeadsConfig = buildCommentLeadsConfigFromSettings(captureSettings);
    const requiredSyncTypes = savedRecords.map((record) => record.type || record.recordType);
    if (
      commentLeadsConfig.enabled &&
      hasCommentLeadsEligibleType(requiredSyncTypes)
    ) {
      requiredSyncTypes.push(SYNC_TYPE.COMMENT_LEADS);
    }
    const checkResult = await checkBeforeSync(
      requiredSyncTypes,
      { onProgress },
    );
    if (!checkResult.ok) {
      return {
        ok: false,
        phase: 'check',
        captureResult,
        syncResult: null,
        recordId,
        error: checkResult.error,
      };
    }

    // 步骤 7: 执行同步
    if (onProgress) {
      onProgress({
        phase: 'sync_start',
        message: '开始同步到后台...',
        recordId,
      });
    }

    const syncResult =
      recordIds.length === 1
        ? await syncRecord(recordId, onProgress, {
            captureSettings,
            commentLeadsConfig,
          })
        : await syncRecordBatch(recordIds, onProgress, {
            trigger: 'capture_auto',
            captureSettings,
            commentLeadsConfig,
          });

    return {
      ok: syncResult.ok,
      phase: syncResult.ok ? 'synced' : 'sync_failed',
      captureResult,
      syncResult,
      recordId,
      recordIds,
      error: syncResult.error || null,
    };
  } catch (error) {
    console.error('[CaptureSync] Capture and sync failed:', error);

    await updateCapture({
      status: CAPTURE_STATUS.FAILED,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    });

    return {
      ok: false,
      phase: 'error',
      captureResult: null,
      syncResult: null,
      recordId: null,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    };
  }
}

/**
 * 单条笔记采集（可选评论），并将评论合并回同一条 single_note 记录
 */
export async function captureNoteWithOptionalComments({
  includeComments = false,
  includeBloggerMetrics = false,
  enableCommentLeadsFilter = null,
  commentsMaxDetectedItems = null,
  commentsMaxItems = null,
  detailNavTimeoutMs = null,
  profileAfterNavWaitMs = null,
  onProgress = null,
} = {}) {
  try {
    if (onProgress) {
      onProgress({
        phase: 'note_capturing',
        message: '正在采集笔记...',
      });
    }

    await updateCapture({
      status: CAPTURE_STATUS.CAPTURING,
      error: null,
    });

    const activeTab = await getCurrentActiveTab();
    const activePlatform = detectPlatformFromUrl(String(activeTab?.url || ''));
    let useWorksTabForDouyinMetrics =
      includeBloggerMetrics &&
      activePlatform === 'douyin' &&
      isDouyinContentFlowUrl(String(activeTab?.url || ''));
    const noteResult = await captureInActiveTab({
      mode: 'single',
      captureParams: {
        includeBloggerMetrics,
        preferWorksTabForBloggerMetrics: useWorksTabForDouyinMetrics,
      },
    });

    if (!noteResult.ok) {
      await updateCapture({
        status: CAPTURE_STATUS.FAILED,
        error: noteResult.error,
      });

      return {
        ok: false,
        phase: 'note_failed',
        recordId: null,
        error: noteResult.error,
      };
    }

    if (includeBloggerMetrics && activePlatform === 'douyin') {
      const sourceUrl = String(noteResult?.meta?.sourceUrl || '').trim();
      if (sourceUrl) {
        useWorksTabForDouyinMetrics = isDouyinContentFlowUrl(sourceUrl);
      }
    }

    const notePayloadWithCommentState = applyCommentStatusToPayload(
      noteResult.data,
      createCommentStatusPatch({
        status: COMMENT_CAPTURE_STATUS.NOT_STARTED,
        startedAt: 0,
        finishedAt: 0,
        stoppedByUser: false,
        error: '',
        cleanedItems: [],
      }),
    );
    const notePayloadWithEnhancementState = applyBloggerMetricsPatch(
      notePayloadWithCommentState,
      createBloggerMetricsPatch({
        status: BLOGGER_METRICS_CAPTURE_STATUS.NOT_STARTED,
        error: '',
        profileUrl: noteResult.data?.authorUrl || '',
      }),
    );

    const recordsToSave = buildRecordsForStorage({
      ...noteResult,
      data: notePayloadWithEnhancementState,
    });
    if (recordsToSave.length === 0) {
      throw new Error('笔记记录构建失败');
    }
    const saved = await addRecord(recordsToSave[0]);
    const recordId = saved?.id || null;

    await updateCapture({
      status: CAPTURE_STATUS.SUCCESS,
      lastCapturedAt: new Date().toISOString(),
      error: null,
    });

    if (!includeComments && !includeBloggerMetrics) {
      if (onProgress) {
        onProgress({
          phase: 'note_ready',
          message: '笔记采集完成，评论未启用',
          recordId,
        });
      }
      return {
        ok: true,
        phase: 'note_ready',
        recordId,
        commentsResult: null,
        bloggerMetricsResult: null,
        error: null,
      };
    }

    const settings = await getCaptureSettings();
    const normalizedDetailNavTimeoutMs = normalizePositiveInteger(
      detailNavTimeoutMs ?? settings.detailNavTimeoutMs,
      DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    );
    const normalizedProfileAfterNavWaitMs = normalizePositiveInteger(
      profileAfterNavWaitMs ?? settings.profileAfterNavWaitMs,
      PROFILE_AFTER_NAV_WAIT_MS,
    );

    let commentsResult = null;
    let bloggerMetricsResult = null;
    let optionalFailed = false;

    if (includeBloggerMetrics) {
      bloggerMetricsResult = await captureBloggerMetricsForSingleNoteRecord(
        recordId,
        {
          preferWorksTabForBloggerMetrics: useWorksTabForDouyinMetrics,
          detailNavTimeoutMs: normalizedDetailNavTimeoutMs,
          profileAfterNavWaitMs: normalizedProfileAfterNavWaitMs,
          onProgress,
        },
      );
      if (!bloggerMetricsResult.ok) {
        optionalFailed = true;
      }
    }

    if (includeComments) {
      commentsResult = await captureCommentsForSingleNoteRecord(recordId, {
        commentsMaxDetectedItems:
          commentsMaxDetectedItems ?? commentsMaxItems,
        enableCommentLeadsFilter,
        onProgress,
      });
      if (!commentsResult.ok) {
        optionalFailed = true;
      }
    }

    if (optionalFailed) {
      return {
        ok: false,
        noteReady: true,
        phase:
          (commentsResult && !commentsResult.ok && commentsResult.phase) ||
          (bloggerMetricsResult && !bloggerMetricsResult.ok
            ? 'blogger_metrics_failed'
            : 'partial_failed'),
        recordId,
        commentsResult,
        bloggerMetricsResult,
        error:
          commentsResult?.error ||
          bloggerMetricsResult?.error || {
            code: 'OPTIONAL_CAPTURE_FAILED',
            message: '可选增强采集失败',
          },
      };
    }

    return {
      ok: true,
      phase:
        commentsResult?.phase ||
        (includeBloggerMetrics ? 'blogger_metrics_done' : 'note_ready'),
      recordId,
      commentsResult,
      bloggerMetricsResult,
      error: null,
    };
  } catch (error) {
    console.error('[CaptureSync] captureNoteWithOptionalComments failed:', error);
    await updateCapture({
      status: CAPTURE_STATUS.FAILED,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    });
    return {
      ok: false,
      phase: 'error',
      recordId: null,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    };
  }
}

/**
 * 仅重试某条 single_note 记录的评论采集与合并
 */
export async function retryCommentsForRecord(
  recordId,
  {
    commentsMaxDetectedItems = null,
    commentsMaxItems = null,
    onProgress = null,
  } = {},
) {
  try {
    const record = await getRecord(recordId);
    if (!record || record.type !== SYNC_TYPE.SINGLE_NOTE) {
      return {
        ok: false,
        phase: 'invalid_record',
        recordId,
        error: {
          code: 'RECORD_NOT_FOUND',
          message: '记录不存在或不是单篇笔记记录',
        },
      };
    }

    const noteUrl = resolveRecordNoteUrl(record);
    if (!noteUrl) {
      return {
        ok: false,
        phase: 'note_url_missing',
        recordId,
        error: {
          code: 'NOTE_URL_MISSING',
          message: '未找到可访问的笔记链接',
        },
      };
    }

    if (onProgress) {
      onProgress({
        phase: 'comments_opening',
        message: '正在打开对应笔记详情页...',
        recordId,
        noteUrl,
      });
    }

    const activeTab = await getCurrentActiveTab();
    const activeTabId = Number(activeTab?.id);
    if (!Number.isFinite(activeTabId) || activeTabId <= 0) {
      throw new Error('未找到当前活动标签页');
    }

    const settings = await getCaptureSettings();
    const navTimeoutMs = normalizePositiveInteger(
      settings.detailNavTimeoutMs,
      DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    );
    const afterNavWaitMs = normalizePositiveInteger(
      settings.detailAfterNavWaitMs,
      DETAIL_CAPTURE_AFTER_NAV_WAIT_MS,
    );

    await openUrlInTab(activeTabId, noteUrl, {
      timeoutMs: navTimeoutMs,
      active: true,
    });
    await waitMs(afterNavWaitMs);

    return await captureCommentsForSingleNoteRecord(recordId, {
      commentsMaxDetectedItems:
        commentsMaxDetectedItems ?? commentsMaxItems,
      onProgress,
    });
  } catch (error) {
    console.error('[CaptureSync] retryCommentsForRecord failed:', error);
    return {
      ok: false,
      phase: 'error',
      recordId,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    };
  }
}

/**
 * 仅重试某条 blogger_notes / keyword_notes 记录的详情补采
 */
export async function retryDetailCaptureForRecord(
  recordId,
  {
    onProgress = null,
    shouldStop = null,
    detailNavTimeoutMs = null,
    detailAfterNavWaitMs = null,
    profileAfterNavWaitMs = null,
  } = {},
) {
  try {
    const record = await getRecord(recordId);
    if (!record || !isDetailCaptureRecordType(record.type)) {
      return {
        ok: false,
        canceled: false,
        total: 1,
        processedCount: 0,
        successCount: 0,
        failedCount: 0,
        results: [],
        error: {
          code: 'RECORD_NOT_FOUND',
          message: '记录不存在或类型不支持补采详情',
        },
      };
    }

    return await batchCaptureDetailsForRecords([recordId], {
      onProgress,
      shouldStop,
      includeComments: false,
      includeBloggerMetrics: false,
      detailNavTimeoutMs,
      detailAfterNavWaitMs,
      profileAfterNavWaitMs,
    });
  } catch (error) {
    console.error('[CaptureSync] retryDetailCaptureForRecord failed:', error);
    return {
      ok: false,
      canceled: false,
      total: 1,
      processedCount: 0,
      successCount: 0,
      failedCount: 0,
      results: [],
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    };
  }
}

/**
 * 批量补采博主/关键词记录的笔记详情，回填到原记录 payload
 */
export async function batchCaptureDetailsForRecords(
  recordIds,
  {
    onProgress = null,
    shouldStop = null,
    includeComments = false,
    includeBloggerMetrics = false,
    enableCommentLeadsFilter = null,
    commentsMaxDetectedItems = null,
    commentsMaxItems = null,
    enableLowFollowerHitFilter = null,
    lowFollowerHitThreshold = null,
    detailNavTimeoutMs = null,
    detailAfterNavWaitMs = null,
    profileAfterNavWaitMs = null,
  } = {},
) {
  const uniqueRecordIds = Array.isArray(recordIds)
    ? [...new Set(recordIds.filter((id) => typeof id === 'string' && id.trim()))]
    : [];

  if (uniqueRecordIds.length === 0) {
    return {
      ok: false,
      canceled: false,
      total: 0,
      processedCount: 0,
      successCount: 0,
      failedCount: 0,
      results: [],
      error: {
        code: 'NO_RECORDS',
        message: '没有可补采的记录',
      },
    };
  }

  let activeTab = null;
  try {
    activeTab = await getCurrentActiveTab();
  } catch (error) {
    return {
      ok: false,
      canceled: false,
      total: uniqueRecordIds.length,
      processedCount: 0,
      successCount: 0,
      failedCount: 0,
      results: [],
      error: {
        code: 'TAB_NOT_FOUND',
        message: error.message || '未找到当前活动标签页',
      },
    };
  }

  const settings = await getCaptureSettings();
  const commentLeadsConfig = buildCommentLeadsConfigFromSettings({
    ...settings,
    enableCommentLeadsFilter:
      enableCommentLeadsFilter ??
      settings.enableCommentLeadsFilterOnDetailCapture ??
      settings.enableCommentLeadsFilter,
  });
  const normalizedCommentsMaxDetectedItems = normalizeCommentsMaxDetectedItems(
    commentsMaxDetectedItems ?? commentsMaxItems,
    settings.detailCommentsMaxDetectedItems ?? settings.commentsMaxDetectedItems,
  );
  const normalizedDetailNavTimeoutMs = normalizePositiveInteger(
    detailNavTimeoutMs ?? settings.detailNavTimeoutMs,
    DETAIL_CAPTURE_NAV_TIMEOUT_MS,
  );
  const normalizedDetailAfterNavWaitMs = normalizePositiveInteger(
    detailAfterNavWaitMs ?? settings.detailAfterNavWaitMs,
    DETAIL_CAPTURE_AFTER_NAV_WAIT_MS,
  );
  const normalizedProfileAfterNavWaitMs = normalizePositiveInteger(
    profileAfterNavWaitMs ?? settings.profileAfterNavWaitMs,
    PROFILE_AFTER_NAV_WAIT_MS,
  );
  const results = [];
  const bloggerMetricsCache = new Map();
  let successCount = 0;
  let failedCount = 0;
  let filteredCount = 0;
  let canceled = false;
  let runnerContext = null;

  try {
    runnerContext = await prepareDetailBatchRunnerContext({
      sourceTab: activeTab,
    });
  } catch (error) {
    return {
      ok: false,
      canceled: false,
      total: uniqueRecordIds.length,
      processedCount: 0,
      successCount: 0,
      failedCount: 0,
      results: [],
      error: {
        code: 'RUNNER_TAB_UNAVAILABLE',
        message: error?.message || '初始化补采标签页失败',
      },
    };
  }

  if (onProgress) {
    onProgress({
      phase: 'detail_batch_start',
      message: `开始批量补采详情（前台模式，共 ${uniqueRecordIds.length} 条）`,
      current: 0,
      total: uniqueRecordIds.length,
      successCount,
      failedCount,
      runnerTabId: runnerContext.runnerTabId,
    });
  }

  try {
    for (let index = 0; index < uniqueRecordIds.length; index += 1) {
      if (typeof shouldStop === 'function' && shouldStop()) {
        canceled = true;
        break;
      }

      const recordId = uniqueRecordIds[index];
      const current = index + 1;
      const record = await getRecord(recordId);

      if (!record || !isDetailCaptureRecordType(record.type)) {
        const failure = buildDetailCaptureFailure(
          DETAIL_CAPTURE_FAILURE_CODE.INVALID_RECORD,
          'prepare',
          '记录不存在或类型不支持补采详情',
        );
        const result = {
          recordId,
          ok: false,
          reason: failure.code,
          category: failure.category,
          stage: failure.stage,
          message: failure.userMessage,
          diagnosticMessage: failure.diagnosticMessage,
        };
        results.push(result);
        failedCount += 1;

        if (onProgress) {
          onProgress({
            phase: 'detail_item_failed',
            message: `第 ${current}/${uniqueRecordIds.length} 条补采失败：记录无效`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            runnerTabId: runnerContext.runnerTabId,
          });
        }
        continue;
      }

      const noteUrl = resolveRecordNoteUrl(record);
      if (!noteUrl) {
        const latestRecord = (await getRecord(recordId)) || record;
        const failure = buildDetailCaptureFailure(
          DETAIL_CAPTURE_FAILURE_CODE.LINK_MISSING,
          'prepare',
          '未找到可访问的笔记链接',
        );
        const failedPayload = applyDetailCapturePatch(
          latestRecord.payload,
          createDetailCapturePatch({
            status: DETAIL_CAPTURE_STATUS.FAILED,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            error: failure.userMessage,
            failureCode: failure.code,
            failureStage: failure.stage,
            failureCategory: failure.category,
            diagnosticMessage: failure.diagnosticMessage,
            noteUrl: '',
          }),
        );
        await updateRecord(recordId, {
          status: RECORD_STATUS.DRAFT,
          payload: failedPayload,
        });

        const result = {
          recordId,
          ok: false,
          reason: failure.code,
          category: failure.category,
          stage: failure.stage,
          message: failure.userMessage,
          diagnosticMessage: failure.diagnosticMessage,
        };
        results.push(result);
        failedCount += 1;

        if (onProgress) {
          onProgress({
            phase: 'detail_item_failed',
            message: `第 ${current}/${uniqueRecordIds.length} 条补采失败：缺少笔记链接`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            runnerTabId: runnerContext.runnerTabId,
          });
        }
        continue;
      }

      const startedAt = Date.now();
      const capturingPayload = applyDetailCapturePatch(
        record.payload,
        createDetailCapturePatch({
          status: DETAIL_CAPTURE_STATUS.CAPTURING,
          startedAt,
          finishedAt: 0,
          error: '',
          failureCode: '',
          failureStage: '',
          failureCategory: '',
          diagnosticMessage: '',
          noteUrl,
        }),
      );

      await updateRecord(recordId, {
        status: RECORD_STATUS.DRAFT,
        payload: capturingPayload,
      });

      if (onProgress) {
        onProgress({
          phase: 'detail_item_capturing',
          message: `正在补采第 ${current}/${uniqueRecordIds.length} 条详情...`,
          recordId,
          current,
          total: uniqueRecordIds.length,
          noteUrl,
          successCount,
          failedCount,
          filteredCount,
          runnerTabId: runnerContext.runnerTabId,
        });
      }

      let activeStage = 'navigation';
      try {
        await openUrlInTab(runnerContext.runnerTabId, noteUrl, {
          timeoutMs: normalizedDetailNavTimeoutMs,
          shouldStop,
          active: runnerContext.openTabAsActive,
        });
        await waitMs(normalizedDetailAfterNavWaitMs);

        if (typeof shouldStop === 'function' && shouldStop()) {
          throw new Error('DETAIL_CAPTURE_CANCELED');
        }

        const recordPlatform = String(
          record?.platform || detectPlatformFromUrl(noteUrl),
        )
          .trim()
          .toLowerCase();
        const resolvedEnableLowFollowerHitFilter =
          enableLowFollowerHitFilter ??
          settings.enableLowFollowerHitFilterOnDetailCapture ??
          settings.enableLowFollowerHitFilter;
        const resolvedLowFollowerHitThreshold =
          lowFollowerHitThreshold ??
          settings.lowFollowerHitThresholdOnDetailCapture ??
          settings.lowFollowerHitThreshold;
        const shouldApplyLowFollowerHitFilter = Boolean(
          resolvedEnableLowFollowerHitFilter &&
            record.type === SYNC_TYPE.KEYWORD_NOTES,
        );
        const shouldCaptureBloggerMetricsForRecord =
          includeBloggerMetrics ||
          recordPlatform === 'douyin' ||
          shouldApplyLowFollowerHitFilter;

        activeStage = 'note_capture';
        const noteResult = await captureInTab(runnerContext.runnerTabId, {
          mode: 'single',
          captureParams: {
            includeBloggerMetrics: shouldCaptureBloggerMetricsForRecord,
            preferWorksTabForBloggerMetrics:
              recordPlatform === 'douyin' && isDouyinContentFlowUrl(noteUrl),
          },
        });

        if (!noteResult?.ok) {
          throw new Error(noteResult?.error?.message || '详情采集失败');
        }

        let detailPayload = applyCommentStatusToPayload(
          noteResult.data,
          createCommentStatusPatch({
            status: COMMENT_CAPTURE_STATUS.NOT_STARTED,
            startedAt: 0,
            finishedAt: 0,
            stoppedByUser: false,
            error: '',
            cleanedItems: [],
            mergedText: '',
          }),
        );
        detailPayload = ensureBloggerMetricsFields(detailPayload);

        let stopAfterCurrent = false;
        if (shouldCaptureBloggerMetricsForRecord) {
          activeStage = 'blogger_metrics_capture';
          if (onProgress) {
            onProgress({
              phase: 'detail_blogger_metrics_capturing',
              message: `第 ${current}/${uniqueRecordIds.length} 条正在采集博主指标...`,
              recordId,
              current,
              total: uniqueRecordIds.length,
              successCount,
              failedCount,
              filteredCount,
              includeBloggerMetrics: true,
              runnerTabId: runnerContext.runnerTabId,
            });
          }

          const metricsResult = await captureBloggerMetricsForDetailPayload(
            detailPayload,
            {
              tabId: runnerContext.runnerTabId,
              noteUrl,
              detailNavTimeoutMs: normalizedDetailNavTimeoutMs,
              profileAfterNavWaitMs: normalizedProfileAfterNavWaitMs,
              shouldStop,
              cache: bloggerMetricsCache,
              allowProfileNavigation: recordPlatform !== 'douyin',
            },
          );
          detailPayload = applyBloggerMetricsResultToPayload(
            detailPayload,
            metricsResult,
          );

          if (metricsResult.canceled) {
            stopAfterCurrent = true;
          }
        }

        if (shouldApplyLowFollowerHitFilter && !stopAfterCurrent) {
          const followerCount = parseInteractionCount(
            detailPayload.bloggerFollowersCount,
          );
          if (followerCount > Number(resolvedLowFollowerHitThreshold)) {
            const { deleteRecord } = await import('./storage.js');
            await deleteRecord(recordId);
            if (onProgress) {
              onProgress({
                phase: 'detail_item_filtered',
                message: `第 ${current}/${uniqueRecordIds.length} 条已过滤：粉丝数 ${followerCount} 超过阈值 ${resolvedLowFollowerHitThreshold}`,
                recordId,
                current,
                total: uniqueRecordIds.length,
                successCount,
                failedCount,
                filteredCount,
                runnerTabId: runnerContext.runnerTabId,
              });
            }
            filteredCount += 1;
            continue;
          }
        }

        if (includeComments && !stopAfterCurrent) {
          activeStage = 'comments_capture';
          if (onProgress) {
            onProgress({
              phase: 'detail_comments_capturing',
              message: `第 ${current}/${uniqueRecordIds.length} 条正在采集评论...`,
              recordId,
              current,
              total: uniqueRecordIds.length,
              successCount,
              failedCount,
              filteredCount,
              includeComments: true,
              commentsMaxDetectedItems: normalizedCommentsMaxDetectedItems,
              runnerTabId: runnerContext.runnerTabId,
            });
          }

          const commentsResult = await captureCommentsForCurrentNote({
            tabId: runnerContext.runnerTabId,
            maxDetectedItems: normalizedCommentsMaxDetectedItems,
            maxDurationMs: settings.sharedMaxDurationMs,
            waitMinMs: settings.sharedWaitMinMs,
            waitMaxMs: settings.sharedWaitMaxMs,
            stallTimeoutMs: settings.sharedStallTimeoutMs,
          });
          detailPayload = applyCommentResultToSingleNotePayload(
            detailPayload,
            commentsResult,
          );
          detailPayload = applyCommentLeadsToPayload({
            syncType: SYNC_TYPE.SINGLE_NOTE,
            payload: detailPayload,
            commentLeadsConfig,
            computedAt: Date.now(),
          }).payload;

          if (commentsResult.stoppedByUser) {
            stopAfterCurrent = true;
          }
        }

        detailPayload = sanitizeMediaFieldsForStorage(detailPayload);

        const latestRecord = (await getRecord(recordId)) || record;
        const mergedPayload = applyDetailCapturePatch(
          latestRecord.payload,
          createDetailCapturePatch({
            status: DETAIL_CAPTURE_STATUS.DONE,
            startedAt,
            finishedAt: Date.now(),
            error: '',
            failureCode: '',
            failureStage: '',
            failureCategory: '',
            diagnosticMessage: '',
            noteUrl,
            detailPayload,
          }),
        );

        const preview = buildDetailCapturePreview(record, detailPayload);
        await updateRecord(recordId, {
          status: RECORD_STATUS.DRAFT,
          payload: mergedPayload,
          title: preview.title,
          summary: preview.summary,
        });

        const result = {
          recordId,
          ok: true,
          reason: 'none',
          message: '详情补采成功',
        };
        results.push(result);
        successCount += 1;

        if (onProgress) {
          onProgress({
            phase: 'detail_item_done',
            message: `第 ${current}/${uniqueRecordIds.length} 条详情补采成功`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            runnerTabId: runnerContext.runnerTabId,
          });
        }

        if (stopAfterCurrent) {
          canceled = true;
          break;
        }
      } catch (error) {
        const canceledByUser = isDetailCaptureCanceledError(error);
        if (canceledByUser) {
          canceled = true;
        }
        const failure = classifyDetailCaptureFailure(error, {
          stage: activeStage,
        });

        const latestRecord = (await getRecord(recordId)) || record;
        const failedPayload = applyDetailCapturePatch(
          latestRecord.payload,
          createDetailCapturePatch({
            status: DETAIL_CAPTURE_STATUS.FAILED,
            startedAt,
            finishedAt: Date.now(),
            error: failure.userMessage,
            failureCode: failure.code,
            failureStage: failure.stage,
            failureCategory: failure.category,
            diagnosticMessage: failure.diagnosticMessage,
            noteUrl,
          }),
        );
        await updateRecord(recordId, {
          status: RECORD_STATUS.DRAFT,
          payload: failedPayload,
        });

        const result = {
          recordId,
          ok: false,
          reason: failure.code,
          category: failure.category,
          stage: failure.stage,
          message: failure.userMessage,
          diagnosticMessage: failure.diagnosticMessage,
        };
        results.push(result);
        failedCount += 1;

        if (onProgress) {
          onProgress({
            phase: 'detail_item_failed',
            message: canceledByUser
              ? `补采已中止（已处理 ${results.length}/${uniqueRecordIds.length} 条）`
              : `第 ${current}/${uniqueRecordIds.length} 条补采失败：${result.message}`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            runnerTabId: runnerContext.runnerTabId,
          });
        }

        if (canceledByUser) {
          break;
        }
      }
    }
  } finally {
    if (runnerContext.shouldRestoreSourcePage) {
      void restoreSourcePageIfNeeded(
        runnerContext.runnerTabId,
        runnerContext.sourcePageUrl,
        runnerContext.sourcePageScrollY,
        { timeoutMs: normalizedDetailNavTimeoutMs },
      ).catch((error) => {
        console.warn('[CaptureSync] restore source page failed:', error);
      });
    } else if (runnerContext.shouldRestoreRuntimeContext) {
      void restoreSourceRuntimeContextIfNeeded({
        tabId: runnerContext.runnerTabId,
        sourcePageUrl: runnerContext.sourcePageUrl,
        sourcePlatform: runnerContext.sourcePlatform,
        sourcePageType: runnerContext.sourcePageType,
      }).catch((error) => {
        console.warn('[CaptureSync] restore source runtime context failed:', error);
      });
    }
  }

  const processedCount = results.length;
  if (onProgress) {
    onProgress({
      phase: canceled ? 'detail_batch_canceled' : 'detail_batch_done',
      message: canceled
        ? `详情补采已中止：成功 ${successCount}，失败 ${failedCount}，过滤 ${filteredCount}`
        : `详情补采完成：成功 ${successCount}，失败 ${failedCount}，过滤 ${filteredCount}`,
      current: processedCount,
      total: uniqueRecordIds.length,
      successCount,
      failedCount,
      filteredCount,
      runnerTabId: runnerContext.runnerTabId,
    });
  }

  return {
    ok: !canceled && failedCount === 0,
    canceled,
    total: uniqueRecordIds.length,
    processedCount,
    successCount,
    failedCount,
    filteredCount,
    results,
    error: null,
  };
}

export function resolveSyncInputForRecord(record, target = {}) {
  if (!record || typeof record !== 'object') {
    return {
      platform: 'unknown',
      recordType: '',
      syncType: '',
      payload: {},
      workflow: 'shared_unknown',
      tableName: '',
    };
  }

  const recordType = String(record.type || record.recordType || '').trim();
  if (isRecordHydratedAsSingleNote(record)) {
    return buildPlatformSyncInput(record, target, {
      recordType,
      syncType: recordType,
      payload: mergeHydratedDetailIntoRecordPayload(record),
    });
  }

  return buildPlatformSyncInput(record, target, {
    recordType,
    syncType: recordType,
    payload:
      record.payload && typeof record.payload === 'object' ? record.payload : {},
  });
}

function isRecordHydratedAsSingleNote(record) {
  if (!record || typeof record !== 'object') return false;
  if (
    record.type !== SYNC_TYPE.BLOGGER_NOTES &&
    record.type !== SYNC_TYPE.KEYWORD_NOTES
  ) {
    return false;
  }

  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const status = String(payload.detailCaptureStatus || '').trim().toLowerCase();
  if (status !== DETAIL_CAPTURE_STATUS.DONE) {
    return false;
  }

  return Boolean(payload.detailPayload && typeof payload.detailPayload === 'object');
}

function normalizeSingleNotePayloadForSync(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const normalized = sanitizeMediaFieldsForStorage(ensureBloggerMetricsFields(
    applyCommentStatusToPayload(base, {}),
  ));
  return normalized;
}

function sanitizeMediaFieldsForStorage(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const platform = resolvePayloadPlatform(base);

  if (platform !== 'douyin') {
    return base;
  }

  const sanitizeList = (list, kind) => {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const next = [];
    list.forEach((item) => {
      const normalized = normalizeMediaUrlForStorage(item);
      if (!normalized || seen.has(normalized)) return;
      if (!isLikelyDownloadableDouyinMediaUrlForStorage(normalized, kind)) return;
      seen.add(normalized);
      next.push(normalized);
    });
    return next;
  };

  const videoUrls = sanitizeList(
    [base.videoUrl, ...(Array.isArray(base.videoUrls) ? base.videoUrls : [])],
    'video',
  );
  const audioUrls = sanitizeList(
    [
      base.audioUrl,
      base.musicUrl,
      ...(Array.isArray(base.audioUrls) ? base.audioUrls : []),
      ...(Array.isArray(base.musicUrls) ? base.musicUrls : []),
    ],
    'audio',
  );

  return {
    ...base,
    videoUrl: videoUrls[0] || '',
    videoUrls,
    audioUrl: audioUrls[0] || '',
    audioUrls,
    musicUrl: audioUrls[0] || '',
    musicUrls: audioUrls,
  };
}

function resolvePayloadPlatform(payload) {
  const explicit = String(payload?.platform || '').trim().toLowerCase();
  if (explicit && explicit !== 'unknown') {
    return explicit;
  }

  const candidates = [
    payload?.url,
    payload?.noteUrl,
    payload?.authorUrl,
  ];

  for (const candidate of candidates) {
    const detected = detectPlatformFromUrl(String(candidate || ''));
    if (detected && detected !== 'unknown') {
      return detected;
    }
  }

  return 'unknown';
}

function normalizeMediaUrlForStorage(value) {
  if (!value || typeof value !== 'string') return '';
  let normalized = value.trim();
  if (!normalized) return '';
  if (normalized.startsWith('//')) {
    normalized = `https:${normalized}`;
  } else if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:\/\//i, 'https://');
  }
  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function isLikelyDownloadableDouyinMediaUrlForStorage(url, kind = 'video') {
  const lower = normalizeMediaUrlForStorage(url).toLowerCase();
  if (!lower) return false;
  if (/^https?:\/\/v\.douyin\.com\//i.test(lower)) return false;
  if (lower.endsWith('.html')) return false;
  if (/^https?:\/\/(?:www\.)?douyin\.com\/(?!aweme\/v1\/play\/)/i.test(lower)) {
    return false;
  }

  if (kind === 'audio') {
    return Boolean(
      lower.includes('xtag=audio') ||
      lower.includes('media-audio') ||
      lower.includes('mime_type=audio_') ||
      lower.includes('ies-music') ||
      lower.includes('music-east') ||
      lower.includes('/obj/ies-music-') ||
      lower.includes('/audio/') ||
      /\.(mp3|m4a|aac|wav|ogg)(\?|$)/i.test(lower)
    );
  }

  return Boolean(
    !lower.includes('media-audio') &&
    !lower.includes('mime_type=audio_') &&
    (
      lower.includes('/aweme/v1/play/') ||
      lower.includes('mime_type=video_') ||
      lower.includes('/video/tos/') ||
      lower.includes('video_id=') ||
      lower.includes('douyinvod.com') ||
      lower.includes('bytevod.com') ||
      lower.includes('zjcdn.com') ||
      /\.(mp4|m3u8|mpd|webm)(\?|$)/i.test(lower)
    )
  );
}

function mergeHydratedDetailIntoRecordPayload(record) {
  const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
  const detail = normalizeSingleNotePayloadForSync(payload.detailPayload);
  if (!detail || typeof detail !== 'object') {
    return payload;
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const firstItem =
    items[0] && typeof items[0] === 'object' ? items[0] : {};
  const mergedItem = {
    ...firstItem,
    ...detail,
  };

  if (!mergedItem.url && mergedItem.noteUrl) mergedItem.url = mergedItem.noteUrl;
  if (!mergedItem.noteUrl && mergedItem.url) mergedItem.noteUrl = mergedItem.url;
  if (!mergedItem.title && mergedItem.noteTitle) mergedItem.title = mergedItem.noteTitle;
  if (!mergedItem.noteTitle && mergedItem.title) mergedItem.noteTitle = mergedItem.title;
  if (!mergedItem.author && mergedItem.authorName) mergedItem.author = mergedItem.authorName;
  if (!mergedItem.authorName && mergedItem.author) mergedItem.authorName = mergedItem.author;
  if ((mergedItem.likes == null || mergedItem.likes === '') && mergedItem.likeCount != null) {
    mergedItem.likes = mergedItem.likeCount;
  }
  if (
    (mergedItem.likeCount == null || mergedItem.likeCount === '') &&
    mergedItem.likes != null
  ) {
    mergedItem.likeCount = mergedItem.likes;
  }
  if (!mergedItem.noteType && mergedItem.type) mergedItem.noteType = mergedItem.type;
  if (!mergedItem.type && mergedItem.noteType) mergedItem.type = mergedItem.noteType;

  const mergedItems = items.length > 0 ? [mergedItem, ...items.slice(1)] : [mergedItem];
  return {
    ...payload,
    items: mergedItems,
    totalCount: payload.totalCount || mergedItems.length,
  };
}

/**
 * 同步单条记录
 * @param {string} recordId - 记录 ID
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 同步结果
 */
export async function syncRecord(recordId, onProgress = null, options = {}) {
  const startedAt = Date.now();
  try {
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
    const syncResult = await sync({
      syncType: syncInput.syncType,
      target: requestTarget,
      payload: syncInput.payload,
    });

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
          const leadsSyncResult = await sync({
            syncType: SYNC_TYPE.COMMENT_LEADS,
            target: requestTarget,
            payload: leadResult.payload,
          });
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
      await appendSingleSyncHistoryEntry({
        requestTarget,
        syncInput,
        recordId,
        result,
        startedAt,
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
    });
    return result;
  }
}

function extractDebugUrl(syncResult) {
  if (!syncResult || typeof syncResult !== 'object') {
    return '';
  }

  const topLevelDebugUrl = syncResult.data?.debugUrl;
  if (typeof topLevelDebugUrl === 'string' && topLevelDebugUrl.trim()) {
    return topLevelDebugUrl.trim();
  }

  const nestedDebugUrl = syncResult.data?.cozeResult?.debug_url;
  if (typeof nestedDebugUrl === 'string' && nestedDebugUrl.trim()) {
    return nestedDebugUrl.trim();
  }

  return '';
}

async function appendSingleSyncHistoryEntry({
  requestTarget,
  syncInput,
  recordId,
  result,
  startedAt,
  trigger = 'single',
} = {}) {
  const safeSyncInput =
    syncInput && typeof syncInput === 'object'
      ? syncInput
      : {
          platform: 'unknown',
          syncType: '',
          workflow: 'shared_unknown',
          payload: {},
        };
  const safeResult = result && typeof result === 'object' ? result : {};
  const success = Boolean(safeResult.ok);
  const payload = safeSyncInput.payload && typeof safeSyncInput.payload === 'object'
    ? safeSyncInput.payload
    : {};

  await addSyncHistoryEntry({
    trigger,
    syncScope: 'pending',
    startedAt,
    finishedAt: Date.now(),
    totalCount: 1,
    requestedTotalCount: 1,
    skippedCount: 0,
    successCount: success ? 1 : 0,
    failedCount: success ? 0 : 1,
    debugUrl: safeResult.debugUrl || null,
    platform: safeSyncInput.platform || 'unknown',
    syncType: safeSyncInput.syncType || '',
    workflow: safeSyncInput.workflow || 'shared_unknown',
    target: buildSyncHistoryTarget(requestTarget, safeSyncInput),
    recordIds: recordId ? [recordId] : [],
    skippedRecordIds: [],
    items: [
      {
        recordId,
        platform: safeSyncInput.platform || 'unknown',
        type: safeSyncInput.syncType || '',
        workflow: safeSyncInput.workflow || 'shared_unknown',
        noteType:
          safeSyncInput.syncType === SYNC_TYPE.SINGLE_NOTE
            ? getSingleNoteType(payload)
            : null,
        success,
        reason: safeResult.reason || (success ? ERROR_REASON.NONE : 'SYNC_ERROR'),
        message: safeResult.message || (success ? '同步成功' : '同步失败'),
        debugUrl: safeResult.debugUrl || null,
        rawResponse: safeResult.rawResponse || null,
        error: safeResult.error || null,
      },
    ],
  });
}

/**
 * 批量同步记录
 * @param {Array<string>} recordIds - 记录 ID 数组
 * @param {Function} onProgress - 进度回调
 * @param {Object} options - 批量同步选项
 * @param {string} options.trigger - 触发来源（selected / all / single）
 * @param {string} options.syncScope - 同步范围（pending / all）
 * @returns {Promise<Object>} 批量同步结果
 */
export async function syncRecordBatch(recordIds, onProgress = null, options = {}) {
  const startedAt = Date.now();
  const requestedRecordIds = Array.isArray(recordIds)
    ? recordIds.filter((recordId) => typeof recordId === 'string' && recordId.trim())
    : [];
  const recordIdsToSync = requestedRecordIds.slice(0, MAX_SYNC_RECORDS_PER_BATCH);
  const skippedRecordIds = requestedRecordIds.slice(MAX_SYNC_RECORDS_PER_BATCH);
  const target = await getTarget();
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
      retryCommentLeadsOnly:
        commentLeadsConfig.enabled &&
        isCommentLeadsEligibleSyncType(syncInput.syncType) &&
        String(record?.lastSyncReason || '').trim().toUpperCase() ===
          'COMMENT_LEADS_SYNC_FAILED',
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

  for (const group of syncGroups) {
    if (!Array.isArray(group.records) || group.records.length === 0) {
      continue;
    }

    const requestChunks = splitSyncGroupRecordsForRequests(group.records);
    for (const chunkRecords of requestChunks) {
      const groupStartedAt = Date.now();
      const batchResult = await syncBatch(
        chunkRecords.map((record) => buildSyncBatchRecord(record)),
        requestTarget,
      );

      const batchItems = Array.isArray(batchResult?.data?.items) ? batchResult.data.items : [];
      const batchItemMap = new Map(
        batchItems
          .filter((item) => item && typeof item === 'object' && item.recordId)
          .map((item) => [item.recordId, item]),
      );
      const groupResults = [];

      for (let i = 0; i < chunkRecords.length; i++) {
        const record = chunkRecords[i];
        const item = batchItemMap.get(record.id);
        const debugUrl =
          normalizeDebugUrl(item?.debugUrl) ||
          (batchResult.ok ? extractDebugUrl(batchResult) : '');
        const success = item?.ok === true;
        const reason =
          item?.reason ||
          item?.error?.reason ||
          (success
            ? ERROR_REASON.NONE
            : batchResult.reason || batchResult.error?.reason || 'SYNC_ERROR');
        const message =
          item?.message ||
          item?.error?.message ||
          (success ? '同步成功' : batchResult.message || batchResult.error?.message || '同步失败');
        const error = success
          ? null
          : {
              reason,
              message,
            };

        if (success) {
          await markRecordSynced(record.id, debugUrl || null);
        } else {
          await updateRecord(record.id, {
            status: RECORD_STATUS.FAILED,
            lastSyncedAt: Date.now(),
            lastSyncReason: reason,
            lastSyncDebugUrl: debugUrl || null,
          });
        }

        const syncResultItem = {
          recordId: record.id,
          platform: record.platform || 'unknown',
          type: record.syncType || record.type,
          sourceType: record.sourceType || record.type,
          workflow: record.workflow || '',
          noteType:
            (record.syncType || record.type) === 'single_note'
              ? getSingleNoteType(record.syncPayload || record.payload)
              : null,
          success,
          reason,
          message,
          debugUrl: debugUrl || null,
          rawResponse: item?.rawResponse || item || batchResult,
          error,
        };
        results.push(syncResultItem);
        groupResults.push(syncResultItem);
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

      await addSyncHistoryEntry({
        trigger: options.trigger || 'manual',
        syncScope: options.syncScope || 'pending',
        startedAt: groupStartedAt,
        finishedAt: Date.now(),
        totalCount: chunkRecords.length,
        requestedTotalCount: chunkRecords.length,
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
        recordIds: chunkRecords.map((record) => record.id),
        skippedRecordIds: [],
        items: groupResults,
        batchStartedAt: startedAt,
        batchRequestedTotalCount: requestedRecordIds.length,
        batchSyncedCount: recordIdsToSync.length,
        batchSkippedCount: skippedRecordIds.length,
      });
    }
  }

  let commentLeadsSyncedCount = 0;
  let commentLeadsSkippedCount = 0;
  let commentLeadsFailedCount = 0;
  const commentLeadHistoryItems = [];
  const hasAnyStoredCommentLeads = preparedRecordsToSync.some((record) =>
    hasStoredCommentLeadsPayload(record.syncType, record.syncPayload),
  );

  if (commentLeadsConfig.enabled && leadsRetryRecords.length > 0) {
    for (const record of leadsRetryRecords) {
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

  if (commentLeadsConfig.enabled || hasAnyStoredCommentLeads) {
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

    for (const record of eligibleRecords) {
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

      const leadSyncResult = await sync({
        syncType: SYNC_TYPE.COMMENT_LEADS,
        target: requestTarget,
        payload: leadResult.payload,
      });
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

  // 统计结果
  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.length - successCount;

  if (failedCount === 0) {
    await updateSync({
      status: SYNC_STATUS.SUCCESS,
      lastSyncedAt: new Date().toISOString(),
      error: null,
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
      message: `批量同步完成：成功 ${successCount}，失败 ${failedCount}`,
      successCount,
      failedCount,
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

  return {
    ok: failedCount === 0,
    results,
    successCount,
    failedCount,
    requestedCount: requestedRecordIds.length,
    syncedCount: recordIdsToSync.length,
    skippedCount: skippedRecordIds.length,
    commentLeadsSyncedCount,
    commentLeadsSkippedCount,
    commentLeadsFailedCount,
  };
}

function buildWorkflowSyncGroups(records = []) {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  const orderedTypes = new Map([
    [SYNC_TYPE.BLOGGER_PROFILE, 0],
    [SYNC_TYPE.BLOGGER_NOTES, 1],
    [SYNC_TYPE.KEYWORD_NOTES, 2],
    [SYNC_TYPE.SINGLE_NOTE, 3],
    [SYNC_TYPE.COMMENTS, 4],
    [SYNC_TYPE.COMMENT_LEADS, 5],
  ]);
  const groupsByKey = new Map();

  records.forEach((record) => {
    const syncType = String(record?.syncType || record?.type || '').trim();
    const platform = String(record?.platform || 'unknown').trim() || 'unknown';
    const workflow = String(record?.workflow || '').trim();
    // For keyword_notes, include keyword in group key so each keyword gets its own
    // syncBatch call. This prevents rapid sequential Coze calls within a single request
    // from causing silent failures where only the first keyword's data is written to Feishu.
    const keywordSuffix =
      syncType === SYNC_TYPE.KEYWORD_NOTES
        ? `::kw:${String(
            record?.syncPayload?.keyword || record?.payload?.keyword || '',
          ).trim()}`
        : '';
    const key = `${platform}::${syncType}::${workflow}${keywordSuffix}`;
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.records.push(record);
      return;
    }
    groupsByKey.set(key, {
      platform,
      syncType,
      workflow,
      records: [record],
    });
  });

  return Array.from(groupsByKey.values()).sort((left, right) => {
    const leftOrder = orderedTypes.has(left.syncType)
      ? orderedTypes.get(left.syncType)
      : Number.MAX_SAFE_INTEGER;
    const rightOrder = orderedTypes.has(right.syncType)
      ? orderedTypes.get(right.syncType)
      : Number.MAX_SAFE_INTEGER;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    if (left.platform !== right.platform) {
      return left.platform.localeCompare(right.platform);
    }
    return left.workflow.localeCompare(right.workflow);
  });
}

function buildSyncBatchRecord(record) {
  return {
    id: record.id,
    type: record.syncType || record.type,
    platform: record.platform,
    workflow: record.workflow,
    monitorExecutionId: record.monitorExecutionId || '',
    payload: record.syncPayload || record.payload,
  };
}

function estimateSyncBatchRecordBytes(record) {
  try {
    return JSON.stringify(buildSyncBatchRecord(record)).length;
  } catch {
    return MAX_SYNC_REQUEST_PAYLOAD_BYTES;
  }
}

function splitSyncGroupRecordsForRequests(records = []) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;

  records.forEach((record) => {
    const recordBytes = estimateSyncBatchRecordBytes(record);
    const shouldStartNext =
      current.length > 0 &&
      (current.length >= MAX_SYNC_RECORDS_PER_REQUEST ||
        currentBytes + recordBytes > MAX_SYNC_REQUEST_PAYLOAD_BYTES);

    if (shouldStartNext) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(record);
    currentBytes += recordBytes;
  });

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function getSingleNoteType(payload) {
  const normalized = String(payload?.noteType || payload?.type || '').trim().toLowerCase();
  if (normalized === 'video' || normalized === '视频') {
    return 'video';
  }
  if (
    normalized === 'image' ||
    normalized === 'img' ||
    normalized === '图文' ||
    normalized === 'normal'
  ) {
    return 'image';
  }

  if (payload?.videoUrl || payload?.videoLink || payload?.video_url) {
    return 'video';
  }

  return 'image';
}

function normalizeDebugUrl(url) {
  if (typeof url !== 'string') {
    return '';
  }

  const trimmed = url.trim();
  return trimmed || '';
}

function pickBatchDebugUrl(results) {
  const failedWithDebug = results.find(
    (result) => !result?.success && normalizeDebugUrl(result?.debugUrl)
  );
  if (failedWithDebug?.debugUrl) {
    return normalizeDebugUrl(failedWithDebug.debugUrl);
  }

  const firstWithDebug = results.find((result) =>
    normalizeDebugUrl(result?.debugUrl)
  );
  if (firstWithDebug?.debugUrl) {
    return normalizeDebugUrl(firstWithDebug.debugUrl);
  }

  return '';
}

// ==================== M4-05: 同步前统一检查 ====================

/**
 * 同步前检查
 * @returns {Promise<Object>} 检查结果
 */
export async function checkBeforeSync(requiredSyncTypes = [], options = {}) {
  const onProgress =
    options && typeof options.onProgress === 'function' ? options.onProgress : null;
  try {
    if (onProgress) {
      onProgress({
        phase: 'sync_check',
        message: '正在校验授权与同步配置...',
      });
    }

    // 检查 1: 是否已鉴权
    const auth = await getAuth();

    if (!auth.verified) {
      return {
        ok: false,
        error: {
          code: ERROR_REASON.NOT_VERIFIED,
          message:
            '当前功能需要激活码授权，已有激活码请在设置中完成验证；还没有可联系管理员获取。',
        },
      };
    }

    if (!auth.code) {
      return {
        ok: false,
        error: {
          code: ERROR_REASON.NOT_VERIFIED,
          message: '激活码缺失，请重新鉴权',
        },
      };
    }

    // 检查 2: 是否已配置目标
    const target = await getTarget();
    const requestTarget = buildSyncTargetPayload(target);

    // 使用 StarVoice 后台同步，不再强制要求 feishuAppToken
    // 如果配置了 feishuAppToken 则使用，否则使用激活码直连后端
    if (!requestTarget.feishuAppToken) {
      // 设置一个占位值，让后续逻辑不报错
      requestTarget.feishuAppToken = '__onstarvoice_backend__';
    }

    const syncTypesToCheck =
      Array.isArray(requiredSyncTypes) && requiredSyncTypes.length > 0
        ? [...new Set(requiredSyncTypes.filter(Boolean))]
        : DEFAULT_CHECK_SYNC_TYPES;

    const missingType = syncTypesToCheck.find(
      (syncType) => !resolveSyncTableName(requestTarget, syncType),
    );
    if (missingType) {
      const message =
        missingType === SYNC_TYPE.COMMENT_LEADS
          ? '请先配置评论客资同步表名'
          : missingType === SYNC_TYPE.SINGLE_NOTE ||
              missingType === SYNC_TYPE.COMMENTS ||
              missingType === SYNC_TYPE.KEYWORD_NOTES
          ? '请先配置单笔记/评论/关键词同步表名'
          : '请先配置博主页面同步的数据表名称';
      return {
        ok: false,
        error: {
          code: ERROR_REASON.INVALID_TARGET,
          message,
        },
      };
    }

    // 检查 3: 重新验证（同步前必须重新 verify）
    if (onProgress) {
      onProgress({
        phase: 'sync_verify',
        message: '正在校验激活状态...',
      });
    }
    const verifyResult = await verify(auth.code);

    if (!verifyResult.ok) {
      // 验证失败，清空鉴权状态
      const { clearAuth } = await import('./storage.js');
      await clearAuth();

      return {
        ok: false,
        error: verifyResult.error,
      };
    }

    // 所有检查通过
    return {
      ok: true,
      error: null,
    };
  } catch (error) {
    console.error('[CaptureSync] Check before sync failed:', error);

    return {
      ok: false,
      error: {
        code: 'CHECK_FAILED',
        message: error.message,
      },
    };
  }
}

function buildSyncTargetPayload(target = {}) {
  return {
    feishuAppToken: String(target?.feishuAppToken || '').trim(),
    tableId: String(target?.tableId || '').trim(),
    keywordNotesTableName:
      String(target?.keywordNotesTableName || '').trim() ||
      DEFAULT_KEYWORD_NOTES_TABLE_NAME,
    bloggerProfileTableName:
      String(target?.bloggerProfileTableName || '').trim() ||
      DEFAULT_BLOGGER_PROFILE_TABLE_NAME,
    bloggerNotesTableName:
      String(target?.bloggerNotesTableName || '').trim() ||
      DEFAULT_BLOGGER_NOTES_TABLE_NAME,
    commentLeadsTableName:
      String(target?.commentLeadsTableName || '').trim() ||
      DEFAULT_COMMENT_LEADS_TABLE_NAME,
  };
}

// ==================== M4-06: 统一 syncType 调用封装 ====================

/**
 * 采集并同步 - 单篇笔记
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSyncSingleNote(onProgress = null) {
  return await captureAndSync({
    mode: 'single',
    onProgress,
    autoSync: true,
  });
}

/**
 * 采集并同步 - 博主信息
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSyncBloggerProfile(onProgress = null) {
  return await captureAndSync({
    mode: 'blogger_profile',
    onProgress,
    autoSync: true,
  });
}

/**
 * 采集并同步 - 博主笔记列表
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSyncBloggerNotes(onProgress = null) {
  return await captureAndSync({
    mode: 'blogger_notes',
    onProgress,
    autoSync: true,
  });
}

/**
 * 采集并同步 - 关键词搜索结果
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSyncKeywordNotes(onProgress = null) {
  return await captureAndSync({
    mode: 'keyword',
    onProgress,
    autoSync: true,
  });
}

/**
 * 采集并同步 - 评论
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSyncComments(onProgress = null) {
  return await captureAndSync({
    mode: 'comments',
    onProgress,
    autoSync: true,
  });
}

// ==================== 便捷函数 ====================

/**
 * 仅采集（不同步）
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>} 结果
 */
export async function captureOnly(options = {}) {
  return await captureAndSync({
    ...options,
    autoSync: false,
  });
}

/**
 * 重置采集和同步状态
 */
export async function resetCaptureAndSyncState() {
  await resetCapture();
  await resetSync();
}

async function captureCommentsForSingleNoteRecord(
  recordId,
  {
    enableCommentLeadsFilter = null,
    commentsMaxDetectedItems = null,
    commentsMaxItems = null,
    onProgress = null,
  } = {},
) {
  const record = await getRecord(recordId);
  if (!record || record.type !== SYNC_TYPE.SINGLE_NOTE) {
    return {
      ok: false,
      phase: 'invalid_record',
      recordId,
      error: {
        code: 'RECORD_NOT_FOUND',
        message: '记录不存在或不是单篇笔记记录',
      },
    };
  }

  const settings = await getCaptureSettings();
  const commentLeadsConfig = buildCommentLeadsConfigFromSettings({
    ...settings,
    enableCommentLeadsFilter:
      enableCommentLeadsFilter ?? settings.enableCommentLeadsFilter,
  });
  const maxDetectedItems = normalizeCommentsMaxDetectedItems(
    commentsMaxDetectedItems ?? commentsMaxItems,
    settings.commentsMaxDetectedItems,
  );
  const startedAt = Date.now();

  await updateRecord(recordId, {
    status: RECORD_STATUS.DRAFT,
    payload: applyCommentStatusToPayload(
      record.payload,
      createCommentStatusPatch({
        status: COMMENT_CAPTURE_STATUS.CAPTURING,
        startedAt,
        finishedAt: 0,
        stoppedByUser: false,
        error: '',
      }),
    ),
  });

  if (onProgress) {
    onProgress({
      phase: 'comments_capturing',
      message: '评论采集中（0条）',
      recordId,
      collectedCount: 0,
    });
  }

  let commentsResult = null;
  try {
    commentsResult = await captureInActiveTab({
      mode: 'comments',
      captureParams: {
        onlyLevel1: false,
        maxDetectedItems,
        maxDurationMs: settings.sharedMaxDurationMs,
        waitMinMs: settings.sharedWaitMinMs,
        waitMaxMs: settings.sharedWaitMaxMs,
        stallTimeoutMs: settings.sharedStallTimeoutMs,
      },
    });
  } catch (error) {
    commentsResult = {
      ok: false,
      error: {
        code: 'CAPTURE_FAILED',
        message: error.message || '评论采集失败',
      },
    };
  }

  if (!commentsResult.ok) {
    const latestRecord = await getRecord(recordId);
    const basePayload = latestRecord?.payload || record.payload;
    const failedPayload = applyCommentStatusToPayload(
      basePayload,
      createCommentStatusPatch({
        status: COMMENT_CAPTURE_STATUS.FAILED,
        startedAt,
        finishedAt: Date.now(),
        stoppedByUser: false,
        error: commentsResult.error?.message || '评论采集失败',
      }),
    );
    await updateRecord(recordId, {
      status: RECORD_STATUS.DRAFT,
      payload: failedPayload,
    });

    if (onProgress) {
      onProgress({
        phase: 'comments_failed',
        message: '评论采集失败，可点击重试',
        recordId,
      });
    }

    return {
      ok: false,
      phase: 'comments_failed',
      recordId,
      error: commentsResult.error || { code: 'CAPTURE_FAILED', message: '评论采集失败' },
    };
  }

  const rawItems = Array.isArray(commentsResult.data?.items) ? commentsResult.data.items : [];
  const cleanedItems = cleanCommentsItems(rawItems);
  const isPartial =
    commentsResult.data?.captureStatus === COMMENT_CAPTURE_STATUS.PARTIAL ||
    commentsResult.meta?.captureStatus === COMMENT_CAPTURE_STATUS.PARTIAL;
  const finalStatus = isPartial ? COMMENT_CAPTURE_STATUS.PARTIAL : COMMENT_CAPTURE_STATUS.DONE;
  const finishedAt = Date.now();
  const mergedText = buildCommentsMergedText(cleanedItems);
  const latestRecord = await getRecord(recordId);
  const basePayload = latestRecord?.payload || record.payload;
  let mergedPayload = applyCommentStatusToPayload(
    basePayload,
    createCommentStatusPatch({
      status: finalStatus,
      startedAt,
      finishedAt,
      stoppedByUser: isPartial,
      error: '',
      cleanedItems,
      mergedText,
    }),
  );
  mergedPayload = applyCommentLeadsToPayload({
    syncType: SYNC_TYPE.SINGLE_NOTE,
    payload: mergedPayload,
    commentLeadsConfig,
    computedAt: finishedAt,
  }).payload;

  await updateRecord(recordId, {
    status: RECORD_STATUS.DRAFT,
    payload: mergedPayload,
  });

  if (onProgress) {
    onProgress({
      phase: isPartial ? 'comments_partial' : 'comments_done',
      message: isPartial
        ? `评论已手动停止并合并（${cleanedItems.length}条）`
        : `评论已合并（${cleanedItems.length}条）`,
      recordId,
      collectedCount: cleanedItems.length,
    });
  }

  return {
    ok: true,
    phase: isPartial ? 'comments_partial' : 'comments_done',
    recordId,
    commentsCount: cleanedItems.length,
    partial: isPartial,
    error: null,
  };
}

async function captureBloggerMetricsForSingleNoteRecord(
  recordId,
  {
    preferWorksTabForBloggerMetrics = null,
    detailNavTimeoutMs = DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    profileAfterNavWaitMs = PROFILE_AFTER_NAV_WAIT_MS,
    shouldStop = null,
    onProgress = null,
  } = {},
) {
  const record = await getRecord(recordId);
  if (!record || record.type !== SYNC_TYPE.SINGLE_NOTE) {
    return {
      ok: false,
      recordId,
      error: {
        code: 'RECORD_NOT_FOUND',
        message: '记录不存在或不是单篇笔记记录',
      },
    };
  }

  const basePayload = ensureBloggerMetricsFields(record.payload);
  const noteUrl = normalizeOpenUrl(basePayload.url || basePayload.noteUrl);
  const platform = detectPlatformFromUrl(
    noteUrl || basePayload.authorUrl || basePayload.bloggerProfileUrl || '',
  );
  const directPatch = resolveBloggerMetricsPatchFromCurrentPayload(basePayload, {
    requireBothMetrics: platform === 'douyin',
  });
  const profileUrl = resolveBloggerProfileUrlFromPayload(basePayload);

  if (onProgress) {
    onProgress({
      phase: 'blogger_metrics_capturing',
      message: '正在准备采集博主粉丝数与获赞收藏...',
      recordId,
    });
  }

  let tab = null;
  let latestPayload = basePayload;
  try {
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error('BATCH_CAPTURE_CANCELED');
    }

    tab = await getCurrentActiveTab();

    if (directPatch) {
      const donePayload = applyBloggerMetricsPatch(latestPayload, directPatch);
      await updateRecord(recordId, {
        status: RECORD_STATUS.DRAFT,
        payload: donePayload,
      });
      if (onProgress) {
        onProgress({
          phase: 'blogger_metrics_done',
          message: '已直接使用当前作品页的博主指标',
          recordId,
        });
      }
      return {
        ok: true,
        recordId,
        patch: directPatch,
        error: null,
      };
    }

    if (platform === 'douyin') {
      const shouldUseWorksTabForDouyinMetrics =
        typeof preferWorksTabForBloggerMetrics === 'boolean'
          ? preferWorksTabForBloggerMetrics
          : isDouyinContentFlowUrl(String(tab?.url || noteUrl || ''));

      if (!shouldUseWorksTabForDouyinMetrics) {
        throw new Error(
          '当前页面非内容流详情，按规则不切换TA的作品页，未能提取博主粉丝数与获赞收藏',
        );
      }

      if (onProgress) {
        onProgress({
          phase: 'blogger_metrics_extract_note',
          message: '正在进入TA的作品并提取博主粉丝数与获赞收藏...',
          recordId,
        });
      }

      const douyinMetricsResult = await captureDouyinBloggerMetricsFromNoteDetail({
        tabId: tab?.id,
        preferWorksTabForBloggerMetrics: shouldUseWorksTabForDouyinMetrics,
      });
      if (!douyinMetricsResult?.ok || !douyinMetricsResult.patch) {
        throw new Error(
          douyinMetricsResult?.error || '未能从TA的作品页解析博主粉丝数与获赞收藏',
        );
      }

      latestPayload = applyBloggerMetricsPatch(
        latestPayload,
        douyinMetricsResult.patch,
      );
      await updateRecord(recordId, {
        status: RECORD_STATUS.DRAFT,
        payload: latestPayload,
      });

      if (onProgress) {
        onProgress({
          phase: 'blogger_metrics_done',
          message: '博主指标采集完成',
          recordId,
        });
      }

      return {
        ok: true,
        recordId,
        patch: douyinMetricsResult.patch,
        error: null,
      };
    }

    if (!profileUrl) {
      throw new Error('未找到可访问的博主主页链接');
    }

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_open_profile',
        message: '正在跳转至博主主页...',
        recordId,
      });
    }
    await openUrlInTab(tab.id, profileUrl, {
      timeoutMs: detailNavTimeoutMs,
      shouldStop,
      active: true,
    });

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_wait_profile',
        message: '博主主页已打开，正在等待页面稳定...',
        recordId,
      });
    }
    await waitMsWithStop(
      profileAfterNavWaitMs,
      shouldStop,
      'BATCH_CAPTURE_CANCELED',
    );

    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error('BATCH_CAPTURE_CANCELED');
    }

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_extract_profile',
        message: '正在抓取博主主页信息...',
        recordId,
      });
    }
    const profileResult = await captureInTab(tab.id, {
      mode: 'blogger_profile',
      captureParams: {},
    });
    if (!profileResult?.ok) {
      throw new Error(profileResult?.error?.message || '博主主页采集失败');
    }

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_merging',
        message: '正在回填粉丝数、获赞收藏与账号属性...',
        recordId,
      });
    }
    const patch = resolveBloggerMetricsFromProfilePayload(
      profileResult.data,
      profileUrl,
    );
    latestPayload = applyBloggerMetricsPatch(latestPayload, patch);
    await updateRecord(recordId, {
      status: RECORD_STATUS.DRAFT,
      payload: latestPayload,
    });

    if (noteUrl && tab?.id) {
      if (onProgress) {
        onProgress({
          phase: 'blogger_metrics_restoring_note',
          message: '正在返回原笔记页面...',
          recordId,
        });
      }
      try {
        await openUrlInTab(tab.id, noteUrl, {
          timeoutMs: detailNavTimeoutMs,
          active: true,
        });
      } catch (restoreError) {
        console.warn('[CaptureSync] restore note page failed:', restoreError);
      }
    }

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_done',
        message: '博主指标采集完成',
        recordId,
      });
    }

    return {
      ok: true,
      recordId,
      patch,
      error: null,
    };
  } catch (error) {
    if (platform !== 'douyin' && noteUrl && tab?.id) {
      if (onProgress) {
        onProgress({
          phase: 'blogger_metrics_restoring_note',
          message: '采集异常，正在返回原笔记页面...',
          recordId,
        });
      }
      try {
        await openUrlInTab(tab.id, noteUrl, {
          timeoutMs: detailNavTimeoutMs,
          active: true,
        });
      } catch (restoreError) {
        console.warn('[CaptureSync] restore note page failed:', restoreError);
      }
    }

    latestPayload = applyBloggerMetricsPatch(
      latestPayload,
      createBloggerMetricsPatch({
        status: BLOGGER_METRICS_CAPTURE_STATUS.FAILED,
        error: error?.message || '博主指标采集失败',
        profileUrl,
      }),
    );
    await updateRecord(recordId, {
      status: RECORD_STATUS.DRAFT,
      payload: latestPayload,
    });

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_failed',
        message: error?.message || '博主指标采集失败',
        recordId,
      });
    }

    return {
      ok: false,
      recordId,
      error: {
        code: 'BLOGGER_METRICS_CAPTURE_FAILED',
        message: error?.message || '博主指标采集失败',
      },
    };
  }
}

async function captureDouyinBloggerMetricsFromNoteDetail({
  tabId,
  preferWorksTabForBloggerMetrics = true,
} = {}) {
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return {
      ok: false,
      patch: null,
      error: '未找到可用标签页',
    };
  }

  let singleResult = null;
  try {
    singleResult = await captureInTab(normalizedTabId, {
      mode: 'single',
      captureParams: {
        includeBloggerMetrics: true,
        preferWorksTabForBloggerMetrics: Boolean(
          preferWorksTabForBloggerMetrics,
        ),
      },
    });
  } catch (error) {
    return {
      ok: false,
      patch: null,
      error: error?.message || '抖音作品页补采失败',
    };
  }

  if (!singleResult?.ok) {
    return {
      ok: false,
      patch: null,
      error: singleResult?.error?.message || '抖音作品页补采失败',
    };
  }

  const patch = resolveBloggerMetricsPatchFromCurrentPayload(
    singleResult?.data,
    { requireBothMetrics: true },
  );
  if (!patch) {
    return {
      ok: false,
      patch: null,
      error: '未能从TA的作品页解析博主粉丝数与获赞收藏',
    };
  }

  return {
    ok: true,
    patch,
    error: null,
  };
}

async function captureBloggerMetricsForDetailPayload(
  detailPayload,
  {
    tabId,
    noteUrl,
    detailNavTimeoutMs = DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    profileAfterNavWaitMs = PROFILE_AFTER_NAV_WAIT_MS,
    shouldStop = null,
    cache = null,
    allowProfileNavigation = true,
  } = {},
) {
  const normalizedPayload = ensureBloggerMetricsFields(detailPayload);
  const platform = detectPlatformFromUrl(
    noteUrl ||
      normalizedPayload.url ||
      normalizedPayload.noteUrl ||
      normalizedPayload.authorUrl ||
      normalizedPayload.bloggerProfileUrl ||
      '',
  );
  const directPatch = resolveBloggerMetricsPatchFromCurrentPayload(
    normalizedPayload,
    { requireBothMetrics: platform === 'douyin' },
  );
  if (directPatch) {
    return {
      ok: true,
      canceled: false,
      profileUrl:
        directPatch.bloggerProfileUrl ||
        normalizedPayload.bloggerProfileUrl ||
        '',
      patch: directPatch,
      error: '',
    };
  }

  if (!allowProfileNavigation || platform === 'douyin') {
    return {
      ok: false,
      canceled: false,
      profileUrl: '',
      error: '未能从作品详情页直接解析博主指标',
    };
  }

  const profileUrl = resolveBloggerProfileUrlFromPayload(normalizedPayload);
  if (!profileUrl) {
    return {
      ok: false,
      canceled: false,
      profileUrl: '',
      error: '未找到可访问的博主主页链接',
    };
  }

  const cacheKey = profileUrl;
  if (cache instanceof Map && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  if (typeof shouldStop === 'function' && shouldStop()) {
    return {
      ok: false,
      canceled: true,
      profileUrl,
      error: 'DETAIL_CAPTURE_CANCELED',
    };
  }

  try {
    await openUrlInTab(tabId, profileUrl, {
      timeoutMs: detailNavTimeoutMs,
      shouldStop,
      active: true,
    });
    await waitMs(profileAfterNavWaitMs);

    if (typeof shouldStop === 'function' && shouldStop()) {
      return {
        ok: false,
        canceled: true,
        profileUrl,
        error: 'DETAIL_CAPTURE_CANCELED',
      };
    }

    const profileResult = await captureInTab(tabId, {
      mode: 'blogger_profile',
      captureParams: {},
    });
    if (!profileResult?.ok) {
      throw new Error(profileResult?.error?.message || '博主主页采集失败');
    }

    if (noteUrl) {
      try {
        await openUrlInTab(tabId, noteUrl, {
          timeoutMs: detailNavTimeoutMs,
          shouldStop,
          active: true,
        });
      } catch (restoreError) {
        console.warn('[CaptureSync] restore note page failed:', restoreError);
      }
    }

    const result = {
      ok: true,
      canceled: false,
      profileUrl,
      patch: resolveBloggerMetricsFromProfilePayload(
        profileResult.data,
        profileUrl,
      ),
      error: '',
    };
    if (cache instanceof Map) {
      cache.set(cacheKey, result);
    }
    return result;
  } catch (error) {
    const canceled = isBatchCaptureCanceledError(error);
    const failedResult = {
      ok: false,
      canceled,
      profileUrl,
      error: canceled
        ? 'BATCH_CAPTURE_CANCELED'
        : error?.message || '博主指标采集失败',
    };
    if (cache instanceof Map && !canceled) {
      cache.set(cacheKey, failedResult);
    }
    if (noteUrl) {
      try {
        await openUrlInTab(tabId, noteUrl, {
          timeoutMs: detailNavTimeoutMs,
          active: true,
        });
      } catch (restoreError) {
        console.warn('[CaptureSync] restore note page failed:', restoreError);
      }
    }
    return failedResult;
  }
}

function normalizeCommentsMaxDetectedItems(maxDetectedItems, fallback) {
  const num = Number(maxDetectedItems);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return Math.floor(num);
}

function normalizePositiveInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return Math.max(1, Math.floor(Number(fallback) || 1));
  }
  return Math.max(1, Math.floor(num));
}

function sanitizeCommentLeadItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const normalized = normalizeCommentItemForLead(item);
      if (!normalized.content) return null;
      return {
        ...normalized,
        matchedKeywords: splitCommentLeadRules(item?.matchedKeywords),
      };
    })
    .filter(Boolean);
}

function normalizeCommentLeadSyncStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'not_started' ||
    normalized === 'done' ||
    normalized === 'failed' ||
    normalized === 'skipped'
  ) {
    return normalized;
  }
  return 'not_started';
}

function applyCommentStatusToPayload(payload, patch) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const baseLeadItems = sanitizeCommentLeadItems(base.commentLeadsItems);
  const patchLeadItems = sanitizeCommentLeadItems(patch.commentLeadsItems);
  return {
    ...base,
    commentsTotalCaptured: patch.commentsTotalCaptured ?? base.commentsTotalCaptured ?? 0,
    commentsCleanedItems: Array.isArray(patch.commentsCleanedItems)
      ? patch.commentsCleanedItems
      : Array.isArray(base.commentsCleanedItems)
        ? base.commentsCleanedItems
        : [],
    commentsMergedText: patch.commentsMergedText ?? base.commentsMergedText ?? '',
    commentsCaptureStatus:
      patch.commentsCaptureStatus ?? base.commentsCaptureStatus ?? COMMENT_CAPTURE_STATUS.NOT_STARTED,
    commentsCaptureStoppedByUser:
      patch.commentsCaptureStoppedByUser ?? base.commentsCaptureStoppedByUser ?? false,
    commentsCaptureStartedAt: patch.commentsCaptureStartedAt ?? base.commentsCaptureStartedAt ?? 0,
    commentsCaptureFinishedAt:
      patch.commentsCaptureFinishedAt ?? base.commentsCaptureFinishedAt ?? 0,
    commentsCaptureError: patch.commentsCaptureError ?? base.commentsCaptureError ?? '',
    commentLeadsEnabled: Boolean(
      patch.commentLeadsEnabled ?? base.commentLeadsEnabled ?? false,
    ),
    commentLeadsKeywords:
      patch.commentLeadsKeywords !== undefined
        ? splitCommentLeadRules(patch.commentLeadsKeywords)
        : splitCommentLeadRules(base.commentLeadsKeywords),
    commentLeadsIps:
      patch.commentLeadsIps !== undefined
        ? splitCommentLeadRules(patch.commentLeadsIps)
        : splitCommentLeadRules(base.commentLeadsIps),
    commentLeadsItems: patchLeadItems.length > 0 || patch.commentLeadsItems !== undefined
      ? patchLeadItems
      : baseLeadItems,
    commentLeadsTotal:
      patch.commentLeadsTotal ??
      (patchLeadItems.length > 0 || patch.commentLeadsItems !== undefined
        ? patchLeadItems.length
        : base.commentLeadsTotal ?? baseLeadItems.length),
    commentLeadsLastComputedAt:
      patch.commentLeadsLastComputedAt ?? base.commentLeadsLastComputedAt ?? 0,
    commentLeadsSyncStatus: normalizeCommentLeadSyncStatus(
      patch.commentLeadsSyncStatus ?? base.commentLeadsSyncStatus ?? 'not_started',
    ),
    commentLeadsSyncError: String(
      patch.commentLeadsSyncError ?? base.commentLeadsSyncError ?? '',
    ),
  };
}

function createCommentStatusPatch({
  status,
  startedAt,
  finishedAt,
  stoppedByUser,
  error,
  cleanedItems = null,
  mergedText = null,
  commentLeadsEnabled = undefined,
  commentLeadsKeywords = undefined,
  commentLeadsIps = undefined,
  commentLeadsItems = undefined,
  commentLeadsTotal = undefined,
  commentLeadsLastComputedAt = undefined,
  commentLeadsSyncStatus = undefined,
  commentLeadsSyncError = undefined,
}) {
  const patch = {
    commentsCaptureStatus: status,
    commentsCaptureStartedAt: startedAt,
    commentsCaptureFinishedAt: finishedAt,
    commentsCaptureStoppedByUser: stoppedByUser,
    commentsCaptureError: error,
  };

  if (Array.isArray(cleanedItems)) {
    patch.commentsCleanedItems = cleanedItems;
    patch.commentsTotalCaptured = cleanedItems.length;
  }

  if (typeof mergedText === 'string') {
    patch.commentsMergedText = mergedText;
  }

  if (commentLeadsEnabled !== undefined) {
    patch.commentLeadsEnabled = Boolean(commentLeadsEnabled);
  }
  if (commentLeadsKeywords !== undefined) {
    patch.commentLeadsKeywords = splitCommentLeadRules(commentLeadsKeywords);
  }
  if (commentLeadsIps !== undefined) {
    patch.commentLeadsIps = splitCommentLeadRules(commentLeadsIps);
  }
  if (commentLeadsItems !== undefined) {
    patch.commentLeadsItems = sanitizeCommentLeadItems(commentLeadsItems);
  }
  if (commentLeadsTotal !== undefined) {
    patch.commentLeadsTotal = normalizeNonNegativeNumber(commentLeadsTotal);
  }
  if (commentLeadsLastComputedAt !== undefined) {
    patch.commentLeadsLastComputedAt = normalizeNonNegativeNumber(commentLeadsLastComputedAt);
  }
  if (commentLeadsSyncStatus !== undefined) {
    patch.commentLeadsSyncStatus = normalizeCommentLeadSyncStatus(commentLeadsSyncStatus);
  }
  if (commentLeadsSyncError !== undefined) {
    patch.commentLeadsSyncError = String(commentLeadsSyncError || '');
  }

  return patch;
}

function cleanCommentsItems(items) {
  const dedupe = new Set();
  const cleaned = [];

  items.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const content = String(item.content || item.commentContent || '').replace(/\s+/g, ' ').trim();
    if (!content) return;
    const normalizedContent =
      content.length > COMMENT_CONTENT_MAX_LENGTH
        ? `${content.slice(0, COMMENT_CONTENT_MAX_LENGTH)}...`
        : content;
    const likesNum = Number(item.likes ?? item.likeCount);
    const likes = Number.isFinite(likesNum) && likesNum >= 0 ? Math.floor(likesNum) : 0;
    const userId = resolveCommentUserId(item);
    const userName = resolveCommentUserName(item);
    const userUrl = resolveCommentUserUrl(item);
    const ipLocation = resolveCommentIpLocation(item);
    const preferredId = String(item.commentId || item.id || '').trim();
    const key =
      preferredId ||
      `${userId || 'anonymous'}|${normalizedContent.toLowerCase()}|${likes}`;

    if (!key || dedupe.has(key)) return;
    dedupe.add(key);
    cleaned.push({
      content: normalizedContent,
      likes,
      ...(userName ? { userName } : {}),
      ...(userId ? { userId } : {}),
      ...(userUrl ? { userUrl } : {}),
      ...(ipLocation ? { ipLocation } : {}),
    });
  });

  return cleaned;
}

function buildCommentsMergedText(items) {
  return items
    .map((item, index) => {
      const name = String(item?.userName || '匿名用户').trim() || '匿名用户';
      const ip = String(item?.ipLocation || '未知IP').trim() || '未知IP';
      const content = String(item?.content || '').trim();
      const likes = Number(item?.likes || 0);
      return `${index + 1}、${name}（${ip}）：${content}（${Number.isFinite(likes) ? Math.max(0, Math.floor(likes)) : 0} 个赞）`;
    })
    .join('\n');
}

function splitCommentLeadRules(rawValue) {
  if (Array.isArray(rawValue)) {
    return Array.from(
      new Set(
        rawValue
          .map((item) => String(item || '').trim())
          .filter(Boolean),
      ),
    );
  }

  return Array.from(
    new Set(
      String(rawValue || '')
        .split(/[，,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function buildCommentLeadsConfigFromSettings(settings = {}) {
  return normalizeCommentLeadsConfig({
    enabled:
      settings.enableCommentLeadsFilter ??
      settings.commentLeadsEnabled ??
      false,
    keywords:
      settings.commentLeadsKeywords ??
      settings.keywords ??
      '',
    ips:
      settings.commentLeadsIps ??
      settings.ips ??
      '',
  });
}

function normalizeCommentLeadsConfig(input = {}) {
  const safe = input && typeof input === 'object' ? input : {};
  const enabled = Boolean(safe.enabled);
  const keywords = splitCommentLeadRules(safe.keywords);
  const ips = splitCommentLeadRules(safe.ips);
  return {
    enabled,
    keywords,
    ips,
    hasKeywordRules: keywords.length > 0,
    hasIpRules: ips.length > 0,
    hasRules: keywords.length > 0 || ips.length > 0,
  };
}

function normalizeCommentItemForLead(item) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const likesNum = Number(safeItem.likes ?? safeItem.likeCount);
  const likes = Number.isFinite(likesNum) && likesNum >= 0 ? Math.floor(likesNum) : 0;
  return {
    content: String(safeItem.content || safeItem.commentContent || '').replace(/\s+/g, ' ').trim(),
    userName: resolveCommentUserName(safeItem),
    ipLocation: resolveCommentIpLocation(safeItem),
    likes,
    userUrl: resolveCommentUserUrl(safeItem),
    userId: resolveCommentUserId(safeItem),
  };
}

function pickFirstNonEmptyString(candidates = []) {
  if (!Array.isArray(candidates)) return '';
  for (const candidate of candidates) {
    const text = String(candidate || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return text;
  }
  return '';
}

function extractUserIdFromProfileUrl(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  const match = text.match(/\/user\/profile\/([a-zA-Z0-9_-]+)/i);
  return match?.[1] || '';
}

function resolveCommentUserName(item) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
  return pickFirstNonEmptyString([
    safeItem.userName,
    safeItem.nickname,
    safeItem.user_name,
    safeItem.authorName,
    safeItem.author,
    safeItem.name,
    user.userName,
    user.nickname,
    user.name,
    safeItem['user-name'],
    safeItem['user_name'],
  ]);
}

function resolveCommentIpLocation(item) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
  return pickFirstNonEmptyString([
    safeItem.ipLocation,
    safeItem.ip,
    safeItem.location,
    safeItem.region,
    safeItem.ip_location,
    safeItem.userIpLocation,
    safeItem['ip属地'],
    user.ipLocation,
    user.location,
    user.region,
  ]);
}

function resolveCommentUserUrl(item) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
  return pickFirstNonEmptyString([
    safeItem.userUrl,
    safeItem.userURL,
    safeItem.profileUrl,
    safeItem.homeUrl,
    user.userUrl,
    user.profileUrl,
  ]);
}

function resolveCommentUserId(item) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
  return pickFirstNonEmptyString([
    safeItem.userId,
    safeItem.uid,
    safeItem.user_id,
    user.userId,
    user.uid,
    user.id,
    extractUserIdFromProfileUrl(resolveCommentUserUrl(safeItem)),
  ]);
}

function getLeadSourceFromSyncPayload(syncType, payload) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};

  if (syncType === SYNC_TYPE.SINGLE_NOTE) {
    const fallbackComments =
      Array.isArray(safePayload.commentsCleanedItems)
        ? safePayload.commentsCleanedItems
        : Array.isArray(safePayload.commentItems)
          ? safePayload.commentItems
          : Array.isArray(safePayload.commentsItems)
            ? safePayload.commentsItems
            : Array.isArray(safePayload.comments)
              ? safePayload.comments
              : Array.isArray(safePayload.items)
                ? safePayload.items
                : [];
    return {
      noteUrl: String(safePayload.url || safePayload.noteUrl || '').trim(),
      noteTitle: String(safePayload.title || safePayload.noteTitle || '').trim(),
      comments: fallbackComments,
    };
  }

  if (syncType === SYNC_TYPE.COMMENTS) {
    return {
      noteUrl: String(safePayload.noteUrl || '').trim(),
      noteTitle: String(safePayload.noteTitle || '').trim(),
      comments: Array.isArray(safePayload.items) ? safePayload.items : [],
    };
  }

  if (syncType === SYNC_TYPE.BLOGGER_NOTES || syncType === SYNC_TYPE.KEYWORD_NOTES) {
    const firstItem =
      Array.isArray(safePayload.items) && safePayload.items[0] && typeof safePayload.items[0] === 'object'
        ? safePayload.items[0]
        : {};
    const fallbackComments =
      Array.isArray(firstItem.commentsCleanedItems)
        ? firstItem.commentsCleanedItems
        : Array.isArray(firstItem.commentItems)
          ? firstItem.commentItems
          : Array.isArray(firstItem.commentsItems)
            ? firstItem.commentsItems
            : Array.isArray(firstItem.comments)
              ? firstItem.comments
              : Array.isArray(safePayload.commentsCleanedItems)
                ? safePayload.commentsCleanedItems
                : Array.isArray(safePayload.comments)
                  ? safePayload.comments
                  : [];
    return {
      noteUrl: String(firstItem.url || firstItem.noteUrl || safePayload.detailCaptureNoteUrl || '').trim(),
      noteTitle: String(firstItem.title || firstItem.noteTitle || '').trim(),
      comments: fallbackComments,
    };
  }

  return {
    noteUrl: '',
    noteTitle: '',
    comments: [],
  };
}

function evaluateCommentLeadItem(item, config) {
  const normalizedItem = normalizeCommentItemForLead(item);
  if (!normalizedItem.content) {
    return null;
  }

  const contentLower = normalizedItem.content.toLowerCase();
  const matchedKeywords = config.keywords.filter((keyword) =>
    contentLower.includes(keyword.toLowerCase()),
  );
  const keywordMatched = !config.hasKeywordRules || matchedKeywords.length > 0;
  const ipMatched = !config.hasIpRules || config.ips.includes(normalizedItem.ipLocation);
  if (!keywordMatched || !ipMatched) {
    return null;
  }

  return {
    ...normalizedItem,
    matchedKeywords,
  };
}

function getStoredCommentLeadsState(syncType, payload) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const source = getLeadSourceFromSyncPayload(syncType, safePayload);
  const firstItem =
    Array.isArray(safePayload.items) && safePayload.items[0] && typeof safePayload.items[0] === 'object'
      ? safePayload.items[0]
      : {};

  const rawItems =
    Array.isArray(firstItem.commentLeadsItems)
      ? firstItem.commentLeadsItems
      : Array.isArray(safePayload.commentLeadsItems)
        ? safePayload.commentLeadsItems
        : [];
  const items = sanitizeCommentLeadItems(rawItems);
  const totalRaw =
    firstItem.commentLeadsTotal ??
    safePayload.commentLeadsTotal ??
    items.length;
  const matchedCount = normalizeNonNegativeNumber(totalRaw);

  if (!source.noteUrl || items.length === 0 || matchedCount <= 0) {
    return {
      matchedCount: 0,
      payload: null,
    };
  }

  return {
    matchedCount: Math.max(matchedCount, items.length),
    payload: {
      noteUrl: source.noteUrl,
      noteTitle: source.noteTitle,
      captureTimestamp:
        Number(safePayload.commentLeadsLastComputedAt || firstItem.commentLeadsLastComputedAt || 0) ||
        Date.now(),
      filterConfigSnapshot: {
        keywords: splitCommentLeadRules(
          safePayload.commentLeadsKeywords ?? firstItem.commentLeadsKeywords,
        ),
        ips: splitCommentLeadRules(
          safePayload.commentLeadsIps ?? firstItem.commentLeadsIps,
        ),
      },
      items,
    },
  };
}

function hasStoredCommentLeadsPayload(syncType, payload) {
  return Boolean(getStoredCommentLeadsState(syncType, payload)?.payload);
}

export function buildCommentLeadsPayloadForRecord(record, configInput = {}, options = {}) {
  const syncInput = resolveSyncInputForRecord(record);
  const config = normalizeCommentLeadsConfig(configInput);
  const source = getLeadSourceFromSyncPayload(syncInput.syncType, syncInput.payload);
  const preferStored = Boolean(options?.preferStored);
  const storedLeadState = getStoredCommentLeadsState(
    syncInput.syncType,
    syncInput.payload,
  );
  const normalizedComments = source.comments
    .map((item) => normalizeCommentItemForLead(item))
    .filter((item) => item.content);
  const result = {
    enabled: config.enabled,
    hasRules: config.hasRules,
    totalComments: normalizedComments.length,
    matchedCount: 0,
    skipReason: '',
    payload: null,
    source: '',
  };

  if (preferStored && storedLeadState.payload) {
    result.matchedCount = storedLeadState.matchedCount;
    result.payload = storedLeadState.payload;
    result.source = 'stored';
    return result;
  }

  if (!config.enabled) {
    result.skipReason = 'disabled';
    return result;
  }

  if (!config.hasRules) {
    result.skipReason = 'no_rules';
    return result;
  }

  if (!source.noteUrl) {
    result.skipReason = 'missing_note_url';
    return result;
  }

  if (normalizedComments.length === 0) {
    result.skipReason = 'no_comments';
    return result;
  }

  const matchedItems = source.comments
    .map((item) => evaluateCommentLeadItem(item, config))
    .filter(Boolean);
  result.matchedCount = matchedItems.length;

  if (matchedItems.length === 0) {
    result.skipReason = 'zero_matched';
    return result;
  }

  result.payload = {
    noteUrl: source.noteUrl,
    noteTitle: source.noteTitle,
    captureTimestamp: Date.now(),
    filterConfigSnapshot: {
      keywords: config.keywords,
      ips: config.ips,
    },
    items: matchedItems,
  };
  result.source = 'computed';

  return result;
}

function applyCommentLeadsSyncState(payload, {
  config,
  leadResult,
  syncStatus = 'not_started',
  syncError = '',
} = {}) {
  const safeConfig = normalizeCommentLeadsConfig(config);
  const safeLeadResult =
    leadResult && typeof leadResult === 'object'
      ? leadResult
      : { matchedCount: 0, payload: null };
  return applyCommentStatusToPayload(
    payload,
    createCommentStatusPatch({
      status: String(payload?.commentsCaptureStatus || COMMENT_CAPTURE_STATUS.NOT_STARTED),
      startedAt: Number(payload?.commentsCaptureStartedAt || 0),
      finishedAt: Number(payload?.commentsCaptureFinishedAt || 0),
      stoppedByUser: Boolean(payload?.commentsCaptureStoppedByUser),
      error: String(payload?.commentsCaptureError || ''),
      cleanedItems: Array.isArray(payload?.commentsCleanedItems)
        ? payload.commentsCleanedItems
        : [],
      mergedText: String(payload?.commentsMergedText || ''),
      commentLeadsEnabled: safeConfig.enabled,
      commentLeadsKeywords: safeConfig.keywords,
      commentLeadsIps: safeConfig.ips,
      commentLeadsItems: safeLeadResult?.payload?.items || [],
      commentLeadsTotal: Number(safeLeadResult?.matchedCount || 0),
      commentLeadsLastComputedAt: Date.now(),
      commentLeadsSyncStatus: syncStatus,
      commentLeadsSyncError: syncError,
    }),
  );
}

function normalizeBloggerAccountType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'famous') return 'famous';
  if (normalized === 'company') return 'company';
  return '';
}

function normalizeNonNegativeNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }
  return Math.floor(num);
}

function isValidBloggerMetricsStatus(status) {
  return (
    status === BLOGGER_METRICS_CAPTURE_STATUS.NOT_STARTED ||
    status === BLOGGER_METRICS_CAPTURE_STATUS.DONE ||
    status === BLOGGER_METRICS_CAPTURE_STATUS.FAILED
  );
}

function isFiniteNonNegativeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0;
}

function ensureBloggerMetricsFields(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const rawStatus = String(base.bloggerMetricsCaptureStatus || '')
    .trim()
    .toLowerCase();
  const status = isValidBloggerMetricsStatus(rawStatus)
    ? rawStatus
    : BLOGGER_METRICS_CAPTURE_STATUS.NOT_STARTED;

  return {
    ...base,
    bloggerFollowersCount: normalizeNonNegativeNumber(
      base.bloggerFollowersCount ?? base.followersCount,
    ),
    bloggerLikedAndCollectedCount: normalizeNonNegativeNumber(
      base.bloggerLikedAndCollectedCount ?? base.likedAndCollectedCount,
    ),
    bloggerProfileUrl: String(base.bloggerProfileUrl || base.authorUrl || ''),
    bloggerMetricsCaptureStatus: status,
    bloggerMetricsCaptureError: String(base.bloggerMetricsCaptureError || ''),
    bloggerAccountType: normalizeBloggerAccountType(base.bloggerAccountType),
  };
}

function applyBloggerMetricsPatch(payload, patch) {
  const base = ensureBloggerMetricsFields(payload);
  return {
    ...base,
    bloggerFollowersCount:
      patch.bloggerFollowersCount ?? base.bloggerFollowersCount,
    bloggerLikedAndCollectedCount:
      patch.bloggerLikedAndCollectedCount ?? base.bloggerLikedAndCollectedCount,
    bloggerProfileUrl: patch.bloggerProfileUrl ?? base.bloggerProfileUrl,
    bloggerMetricsCaptureStatus:
      patch.bloggerMetricsCaptureStatus ?? base.bloggerMetricsCaptureStatus,
    bloggerMetricsCaptureError:
      patch.bloggerMetricsCaptureError ?? base.bloggerMetricsCaptureError,
    bloggerAccountType: patch.bloggerAccountType ?? base.bloggerAccountType,
  };
}

function createBloggerMetricsPatch({
  status,
  followersCount,
  likedAndCollectedCount,
  profileUrl,
  error,
  accountType,
}) {
  const patch = {
    bloggerMetricsCaptureStatus: status,
    bloggerMetricsCaptureError: String(error || ''),
  };

  if (followersCount !== undefined) {
    patch.bloggerFollowersCount = normalizeNonNegativeNumber(followersCount);
  }
  if (likedAndCollectedCount !== undefined) {
    patch.bloggerLikedAndCollectedCount = normalizeNonNegativeNumber(
      likedAndCollectedCount,
    );
  }
  if (profileUrl !== undefined) {
    patch.bloggerProfileUrl = String(profileUrl || '');
  }
  if (accountType !== undefined) {
    patch.bloggerAccountType = normalizeBloggerAccountType(accountType);
  }

  return patch;
}

function resolveBloggerMetricsFromProfilePayload(
  profilePayload = {},
  fallbackProfileUrl = '',
) {
  const safePayload =
    profilePayload && typeof profilePayload === 'object' ? profilePayload : {};

  return createBloggerMetricsPatch({
    status: BLOGGER_METRICS_CAPTURE_STATUS.DONE,
    followersCount:
      safePayload.bloggerFollowersCount ?? safePayload.followersCount,
    likedAndCollectedCount:
      safePayload.bloggerLikedAndCollectedCount ??
      safePayload.likedAndCollectedCount,
    profileUrl:
      safePayload.bloggerProfileUrl ||
      safePayload.authorUrl ||
      safePayload.bloggerUrl ||
      fallbackProfileUrl,
    error: '',
    accountType: safePayload.bloggerAccountType || safePayload.accountType,
  });
}

function resolveBloggerMetricsPatchFromCurrentPayload(
  payload = {},
  { requireBothMetrics = false } = {},
) {
  const normalizedPayload = ensureBloggerMetricsFields(payload);
  const followersCount = normalizeNonNegativeNumber(
    normalizedPayload.bloggerFollowersCount ?? normalizedPayload.followersCount,
  );
  const likedAndCollectedCount = normalizeNonNegativeNumber(
    normalizedPayload.bloggerLikedAndCollectedCount ??
      normalizedPayload.likedAndCollectedCount,
  );

  if (requireBothMetrics) {
    if (!(followersCount > 0 && likedAndCollectedCount > 0)) {
      return null;
    }
  } else if (!(followersCount > 0 || likedAndCollectedCount > 0)) {
    return null;
  }

  return createBloggerMetricsPatch({
    status: BLOGGER_METRICS_CAPTURE_STATUS.DONE,
    followersCount,
    likedAndCollectedCount,
    profileUrl:
      normalizedPayload.bloggerProfileUrl ||
      resolveBloggerProfileUrlFromPayload(normalizedPayload),
    error: '',
    accountType:
      normalizedPayload.bloggerAccountType || normalizedPayload.accountType,
  });
}

function applyBloggerMetricsResultToPayload(payload, result) {
  if (result?.ok) {
    const patch =
      result.patch ||
      createBloggerMetricsPatch({
        status: BLOGGER_METRICS_CAPTURE_STATUS.DONE,
        error: '',
      });
    return applyBloggerMetricsPatch(payload, patch);
  }

  return applyBloggerMetricsPatch(
    payload,
    createBloggerMetricsPatch({
      status: BLOGGER_METRICS_CAPTURE_STATUS.FAILED,
      error: result?.error || '博主指标采集失败',
      profileUrl: result?.profileUrl,
    }),
  );
}

function resolveBloggerProfileUrlFromPayload(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const candidates = [base.authorUrl, base.bloggerProfileUrl, base.bloggerUrl];

  for (const candidate of candidates) {
    const normalized = normalizeOpenUrl(candidate);
    if (normalized) return normalized;
  }

  return '';
}

function resolveDetailRecordItemMetricsStatus(item, payload) {
  const itemStatus = String(item?.bloggerMetricsCaptureStatus || '')
    .trim()
    .toLowerCase();
  if (isValidBloggerMetricsStatus(itemStatus)) return itemStatus;

  const payloadStatus = String(payload?.bloggerMetricsCaptureStatus || '')
    .trim()
    .toLowerCase();
  if (isValidBloggerMetricsStatus(payloadStatus)) return payloadStatus;

  const hasMetricsData =
    isFiniteNonNegativeNumber(item?.bloggerFollowersCount) ||
    isFiniteNonNegativeNumber(item?.bloggerLikedAndCollectedCount) ||
    isFiniteNonNegativeNumber(payload?.bloggerFollowersCount) ||
    isFiniteNonNegativeNumber(payload?.bloggerLikedAndCollectedCount) ||
    Boolean(
      normalizeBloggerAccountType(
        item?.bloggerAccountType || payload?.bloggerAccountType,
      ),
    );

  if (hasMetricsData) {
    return BLOGGER_METRICS_CAPTURE_STATUS.DONE;
  }

  return BLOGGER_METRICS_CAPTURE_STATUS.NOT_STARTED;
}

function normalizeDetailRecordItem(item, payload) {
  const rawItem = item && typeof item === 'object' ? item : {};
  const rawPayload = payload && typeof payload === 'object' ? payload : {};

  return ensureBloggerMetricsFields(sanitizeListItemForStorage({
    ...rawItem,
    bloggerFollowersCount:
      rawItem.bloggerFollowersCount ??
      rawPayload.bloggerFollowersCount ??
      rawPayload.followersCount,
    bloggerLikedAndCollectedCount:
      rawItem.bloggerLikedAndCollectedCount ??
      rawPayload.bloggerLikedAndCollectedCount ??
      rawPayload.likedAndCollectedCount,
    bloggerProfileUrl:
      rawItem.bloggerProfileUrl || rawItem.authorUrl || rawPayload.bloggerUrl || '',
    bloggerMetricsCaptureStatus: resolveDetailRecordItemMetricsStatus(
      rawItem,
      rawPayload,
    ),
    bloggerMetricsCaptureError:
      String(rawItem.bloggerMetricsCaptureError || rawPayload.bloggerMetricsCaptureError || ''),
    bloggerAccountType: normalizeBloggerAccountType(
      rawItem.bloggerAccountType || rawPayload.bloggerAccountType,
    ),
  }));
}

function truncateStorageString(value, maxLength = 240) {
  const text = String(value || '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function trimStorageStringList(value, maxItems = 3, maxLength = 360) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => truncateStorageString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeDomLocatorForStorage(locator) {
  if (!locator || typeof locator !== 'object') {
    return locator || null;
  }

  return {
    ...locator,
    className: truncateStorageString(locator.className, 160),
    textSnippet: truncateStorageString(locator.textSnippet, 100),
    cssPath: truncateStorageString(locator.cssPath, 240),
    parentCssPath: truncateStorageString(locator.parentCssPath, 240),
    imageFingerprints: trimStorageStringList(locator.imageFingerprints, 3, 220),
    videoFingerprints: trimStorageStringList(locator.videoFingerprints, 2, 220),
  };
}

function sanitizeDomMatchHintsForStorage(hints) {
  if (!hints || typeof hints !== 'object') {
    return hints || null;
  }

  return {
    ...hints,
    noteUrl: truncateStorageString(hints.noteUrl, 360),
    noteUrlFingerprint: truncateStorageString(hints.noteUrlFingerprint, 220),
    coverImageUrl: truncateStorageString(hints.coverImageUrl, 360),
    coverImageFingerprint: truncateStorageString(
      hints.coverImageFingerprint,
      220,
    ),
    videoUrl: '',
    videoUrlFingerprint: '',
    titleSnippet: truncateStorageString(hints.titleSnippet, 80),
    authorSnippet: truncateStorageString(hints.authorSnippet, 80),
  };
}

function sanitizeListItemForStorage(item) {
  if (!item || typeof item !== 'object') {
    return item || {};
  }

  return {
    ...item,
    videoUrl: '',
    videoUrls: [],
    audioUrl: '',
    audioUrls: [],
    cardImageCandidates: trimStorageStringList(item.cardImageCandidates, 2, 360),
    cardVideoCandidates: [],
    domLocator: sanitizeDomLocatorForStorage(item.domLocator),
    domMatchHints: sanitizeDomMatchHintsForStorage(item.domMatchHints),
  };
}

function isDetailCaptureRecordType(type) {
  return type === SYNC_TYPE.BLOGGER_NOTES || type === SYNC_TYPE.KEYWORD_NOTES;
}

function ensureDetailCaptureFields(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  return {
    ...base,
    detailCaptureStatus:
      base.detailCaptureStatus || DETAIL_CAPTURE_STATUS.NOT_STARTED,
    detailCaptureError: String(base.detailCaptureError || ''),
    detailCaptureFailureCode: String(base.detailCaptureFailureCode || ''),
    detailCaptureFailureStage: String(base.detailCaptureFailureStage || ''),
    detailCaptureFailureCategory: String(base.detailCaptureFailureCategory || ''),
    detailCaptureDiagnosticMessage: String(base.detailCaptureDiagnosticMessage || ''),
    detailCaptureStartedAt: Number(base.detailCaptureStartedAt || 0),
    detailCaptureFinishedAt: Number(base.detailCaptureFinishedAt || 0),
    detailCaptureNoteUrl: String(base.detailCaptureNoteUrl || ''),
    detailPayload:
      base.detailPayload && typeof base.detailPayload === 'object'
        ? ensureBloggerMetricsFields(
            applyCommentStatusToPayload(base.detailPayload, {}),
          )
        : null,
  };
}

function applyDetailCapturePatch(payload, patch) {
  const base = ensureDetailCaptureFields(payload);
  return {
    ...base,
    detailCaptureStatus: patch.detailCaptureStatus ?? base.detailCaptureStatus,
    detailCaptureError: patch.detailCaptureError ?? base.detailCaptureError,
    detailCaptureFailureCode:
      patch.detailCaptureFailureCode ?? base.detailCaptureFailureCode,
    detailCaptureFailureStage:
      patch.detailCaptureFailureStage ?? base.detailCaptureFailureStage,
    detailCaptureFailureCategory:
      patch.detailCaptureFailureCategory ?? base.detailCaptureFailureCategory,
    detailCaptureDiagnosticMessage:
      patch.detailCaptureDiagnosticMessage ?? base.detailCaptureDiagnosticMessage,
    detailCaptureStartedAt:
      patch.detailCaptureStartedAt ?? base.detailCaptureStartedAt,
    detailCaptureFinishedAt:
      patch.detailCaptureFinishedAt ?? base.detailCaptureFinishedAt,
    detailCaptureNoteUrl:
      patch.detailCaptureNoteUrl ?? base.detailCaptureNoteUrl,
    detailPayload:
      patch.detailPayload !== undefined ? patch.detailPayload : base.detailPayload,
  };
}

function createDetailCapturePatch({
  status,
  startedAt = 0,
  finishedAt = 0,
  error = '',
  failureCode = '',
  failureStage = '',
  failureCategory = '',
  diagnosticMessage = '',
  noteUrl = '',
  detailPayload = undefined,
}) {
  return {
    detailCaptureStatus: status,
    detailCaptureError: error,
    detailCaptureFailureCode: failureCode,
    detailCaptureFailureStage: failureStage,
    detailCaptureFailureCategory: failureCategory,
    detailCaptureDiagnosticMessage: diagnosticMessage,
    detailCaptureStartedAt: startedAt,
    detailCaptureFinishedAt: finishedAt,
    detailCaptureNoteUrl: noteUrl,
    detailPayload,
  };
}

function buildDetailCaptureFailure(code, stage, diagnosticMessage = '') {
  const normalizedCode = String(code || DETAIL_CAPTURE_FAILURE_CODE.UNKNOWN)
    .trim()
    .toUpperCase();
  const normalizedStage =
    String(stage || 'unknown').trim().toLowerCase() || 'unknown';
  const normalizedDiagnostic = String(diagnosticMessage || '').trim();

  switch (normalizedCode) {
    case DETAIL_CAPTURE_FAILURE_CODE.LINK_MISSING:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.LINK_MISSING,
        userMessage: '缺少可访问的笔记链接',
        diagnosticMessage: normalizedDiagnostic || '未找到可访问的笔记链接',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.PAGE_OPEN_TIMEOUT:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.PAGE_FAILED,
        userMessage: '打开详情页超时，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '打开页面超时，请稍后重试',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.PAGE_OPEN_FAILED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.PAGE_FAILED,
        userMessage: '打开详情页失败，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '打开详情页失败',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.NOTE_CAPTURE_FAILED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.PAGE_FAILED,
        userMessage: '详情页采集失败，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '详情采集失败',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.COMMENTS_CAPTURE_FAILED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.PAGE_FAILED,
        userMessage: '评论采集失败，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '评论采集失败',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.BLOGGER_METRICS_FAILED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.PAGE_FAILED,
        userMessage: '博主指标采集失败，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '博主指标采集失败',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.CONTEXT_INTERRUPTED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.CONTEXT_INTERRUPTED,
        userMessage: '插件窗口或页面已中断，请重新执行采集增强',
        diagnosticMessage: normalizedDiagnostic || '插件上下文或标签页已中断',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.CANCELED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.USER_CANCELED,
        userMessage: '采集增强已取消',
        diagnosticMessage: normalizedDiagnostic || '采集增强已取消',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.INVALID_RECORD:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.INVALID_RECORD,
        userMessage: '记录无效，无法执行采集增强',
        diagnosticMessage: normalizedDiagnostic || '记录不存在或类型不支持补采详情',
      };
    default:
      return {
        code: normalizedCode || DETAIL_CAPTURE_FAILURE_CODE.UNKNOWN,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.UNKNOWN,
        userMessage: '采集增强失败，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '详情补采失败',
      };
  }
}

function isLikelyContextInterruptedMessage(message = '') {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return [
    'detail_capture_canceled',
    'extension context invalidated',
    'receiving end does not exist',
    'message port closed',
    'the tab was closed',
    'no tab with id',
    'tabs cannot be edited right now',
    'cannot access a chrome://',
    'frame with id 0 was removed',
  ].some((token) => normalized.includes(token));
}

function classifyDetailCaptureFailure(error, { stage = 'unknown' } = {}) {
  const rawMessage = String(error?.message || '').trim();
  const normalizedStage =
    String(stage || 'unknown').trim().toLowerCase() || 'unknown';

  if (isLikelyContextInterruptedMessage(rawMessage)) {
    const interruptedCode =
      rawMessage === 'DETAIL_CAPTURE_CANCELED'
        ? DETAIL_CAPTURE_FAILURE_CODE.CANCELED
        : DETAIL_CAPTURE_FAILURE_CODE.CONTEXT_INTERRUPTED;
    return buildDetailCaptureFailure(
      interruptedCode,
      normalizedStage,
      rawMessage || '插件上下文或标签页已中断',
    );
  }

  if (normalizedStage === 'navigation') {
    if (rawMessage.includes('超时')) {
      return buildDetailCaptureFailure(
        DETAIL_CAPTURE_FAILURE_CODE.PAGE_OPEN_TIMEOUT,
        normalizedStage,
        rawMessage,
      );
    }
    return buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.PAGE_OPEN_FAILED,
      normalizedStage,
      rawMessage,
    );
  }

  if (normalizedStage === 'note_capture') {
    return buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.NOTE_CAPTURE_FAILED,
      normalizedStage,
      rawMessage,
    );
  }

  if (normalizedStage === 'comments_capture') {
    return buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.COMMENTS_CAPTURE_FAILED,
      normalizedStage,
      rawMessage,
    );
  }

  if (normalizedStage === 'blogger_metrics_capture') {
    return buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.BLOGGER_METRICS_FAILED,
      normalizedStage,
      rawMessage,
    );
  }

  return buildDetailCaptureFailure(
    DETAIL_CAPTURE_FAILURE_CODE.UNKNOWN,
    normalizedStage,
    rawMessage,
  );
}

export async function repairInterruptedDetailCaptureRecords() {
  const dataPool = await getDataPool();
  const records = Array.isArray(dataPool?.records) ? dataPool.records : [];
  const repairedRecordIds = [];

  for (const record of records) {
    if (!record || !isDetailCaptureRecordType(record.type)) {
      continue;
    }

    const payload =
      record.payload && typeof record.payload === 'object' ? record.payload : {};
    const status = String(payload.detailCaptureStatus || '').trim().toLowerCase();
    if (status !== DETAIL_CAPTURE_STATUS.CAPTURING) {
      continue;
    }

    const failure = buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.CONTEXT_INTERRUPTED,
      'interrupted',
      '侧栏已关闭、页面已刷新或标签页已切换，导致任务中断',
    );
    const nextPayload = applyDetailCapturePatch(
      payload,
      createDetailCapturePatch({
        status: DETAIL_CAPTURE_STATUS.FAILED,
        startedAt: Number(payload.detailCaptureStartedAt || 0),
        finishedAt: Date.now(),
        error: failure.userMessage,
        failureCode: failure.code,
        failureStage: failure.stage,
        failureCategory: failure.category,
        diagnosticMessage: failure.diagnosticMessage,
        noteUrl: String(payload.detailCaptureNoteUrl || ''),
      }),
    );

    await updateRecord(record.id, {
      status: RECORD_STATUS.DRAFT,
      payload: nextPayload,
    });
    repairedRecordIds.push(record.id);
  }

  return {
    count: repairedRecordIds.length,
    recordIds: repairedRecordIds,
  };
}

function resolveRecordNoteUrl(record) {
  if (!record || !record.payload || typeof record.payload !== 'object') {
    return '';
  }

  const payload = record.payload;
  const firstItem = Array.isArray(payload.items) ? payload.items[0] : null;
  const candidates = [
    firstItem?.url,
    firstItem?.noteUrl,
    firstItem?.detailPageUrl,
    payload.detailCaptureNoteUrl,
    payload.url,
    payload.noteUrl,
    payload.detailPageUrl,
    buildFallbackDetailNoteUrl(record),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeOpenUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function buildFallbackDetailNoteUrl(record) {
  const noteId = resolveRecordDetailNoteId(record);
  if (!noteId) {
    return '';
  }

  const platform = String(record?.platform || '').trim().toLowerCase();
  if (platform === 'douyin') {
    return `https://www.douyin.com/${resolveRecordDetailNotePath(record)}/${noteId}`;
  }

  return `https://www.xiaohongshu.com/explore/${noteId}`;
}

function resolveRecordDetailNoteId(record) {
  const payload =
    record?.payload && typeof record.payload === 'object'
      ? record.payload
      : {};
  const firstItem =
    Array.isArray(payload.items) && payload.items[0] && typeof payload.items[0] === 'object'
      ? payload.items[0]
      : {};
  const candidates = [
    firstItem.noteId,
    payload.noteId,
    firstItem.id,
    payload.id,
    extractNoteId(firstItem.url),
    extractNoteId(firstItem.noteUrl),
    extractNoteId(firstItem.detailPageUrl),
    extractNoteId(payload.detailCaptureNoteUrl),
    extractNoteId(payload.url),
    extractNoteId(payload.noteUrl),
    extractNoteId(payload.detailPageUrl),
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (!normalized || normalized.startsWith('synthetic_')) {
      continue;
    }
    if (/^[a-zA-Z0-9_-]{6,}$/.test(normalized)) {
      return normalized;
    }
  }

  return '';
}

function resolveRecordDetailNotePath(record) {
  const payload =
    record?.payload && typeof record.payload === 'object'
      ? record.payload
      : {};
  const firstItem =
    Array.isArray(payload.items) && payload.items[0] && typeof payload.items[0] === 'object'
      ? payload.items[0]
      : {};
  const rawType = String(
    firstItem.noteType ||
      firstItem.type ||
      payload.noteType ||
      payload.type ||
      '',
  )
    .trim()
    .toLowerCase();

  if (
    rawType === 'image' ||
    rawType === '图文'
  ) {
    return 'note';
  }

  return 'video';
}

function normalizeOpenUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';

  let normalized = raw;
  if (normalized.startsWith('//')) {
    normalized = `https:${normalized}`;
  }
  if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:\/\//i, 'https://');
  }

  try {
    const parsed = new URL(normalized, 'https://www.xiaohongshu.com');
    if (!isSupportedCaptureHostname(parsed.hostname)) {
      return '';
    }
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function isSupportedCaptureHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  if (!normalized) return false;

  return (
    normalized === 'xiaohongshu.com' ||
    normalized.endsWith('.xiaohongshu.com') ||
    normalized === 'douyin.com' ||
    normalized.endsWith('.douyin.com')
  );
}

function buildDetailCapturePreview(record, detailPayload) {
  const baseTitle = String(record?.title || '').trim();
  const title =
    String(detailPayload?.title || '').trim() ||
    baseTitle ||
    '笔记详情';
  const author = String(detailPayload?.author || '').trim();
  const likes = Number(detailPayload?.likes || 0);
  const summary = author ? `${author} · 点赞 ${likes}` : `点赞 ${likes}`;

  return {
    title,
    summary,
  };
}

async function getCurrentActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('未找到当前活动标签页');
  }
  return tab;
}

async function prepareDetailBatchRunnerContext({
  sourceTab,
} = {}) {
  const sourceTabId = Number(sourceTab?.id);
  if (!Number.isFinite(sourceTabId) || sourceTabId <= 0) {
    throw new Error('未找到可用的来源标签页');
  }

  const sourcePageUrl = String(sourceTab?.url || '');
  const sourcePageScrollY = await getTabScrollY(sourceTabId);
  const sourcePlatform = detectPlatformFromUrl(sourcePageUrl);
  const sourcePageType = detectPageType(sourcePageUrl);
  const shouldKeepLastDetailPageOpen =
    sourcePlatform === 'douyin' &&
    sourcePageType === PAGE_TYPE.BLOGGER_PROFILE;

  return {
    sourceTabId,
    sourcePageUrl,
    sourcePageScrollY,
    sourcePlatform,
    sourcePageType,
    runnerTabId: sourceTabId,
    openTabAsActive: true,
    shouldRestoreSourcePage: !shouldKeepLastDetailPageOpen,
    shouldRestoreRuntimeContext: shouldKeepLastDetailPageOpen,
  };
}

async function openUrlInTab(
  tabId,
  targetUrl,
  {
    timeoutMs = DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    shouldStop = null,
    active = true,
  } = {},
) {
  const targetNoteId = extractNoteId(targetUrl);

  await chrome.tabs.update(tabId, {
    url: targetUrl,
    active: Boolean(active),
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error('DETAIL_CAPTURE_CANCELED');
    }

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw new Error(error?.message || '读取标签页状态失败');
    }

    const currentUrl = String(tab?.url || '');
    const status = String(tab?.status || '');
    const noteMatched = isTargetNoteOpened(currentUrl, targetUrl, targetNoteId);
    if (status === 'complete' && noteMatched) {
      return;
    }

    await waitMs(DETAIL_CAPTURE_NAV_POLL_MS);
  }

  throw new Error('打开页面超时，请稍后重试');
}

function isTargetNoteOpened(currentUrl, targetUrl, targetNoteId = '') {
  const normalizedCurrent = String(currentUrl || '').trim();
  const normalizedTarget = String(targetUrl || '').trim();
  if (!normalizedCurrent) return false;
  if (!normalizedTarget) return false;

  if (targetNoteId) {
    const currentNoteId = extractNoteId(normalizedCurrent);
    if (currentNoteId && currentNoteId === targetNoteId) {
      return true;
    }
  }

  if (isSameSearchOrDiscoveryRoute(normalizedCurrent, normalizedTarget)) {
    return true;
  }

  if (isSameOriginAndPathname(normalizedCurrent, normalizedTarget)) {
    return true;
  }

  return normalizeUrlWithoutHash(normalizedCurrent) === normalizeUrlWithoutHash(normalizedTarget);
}

function normalizeUrlWithoutHash(url) {
  const normalized = String(url || '').trim();
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return normalized.split('#')[0];
  }
}

function isSameSearchOrDiscoveryRoute(urlA, urlB) {
  try {
    const parsedA = new URL(String(urlA || '').trim());
    const parsedB = new URL(String(urlB || '').trim());
    if (parsedA.origin !== parsedB.origin) {
      return false;
    }

    return (
      isSearchOrDiscoveryPath(parsedA.pathname) &&
      isSearchOrDiscoveryPath(parsedB.pathname)
    );
  } catch {
    return false;
  }
}

function isSearchOrDiscoveryPath(pathname) {
  const normalized = String(pathname || '').toLowerCase();
  if (!normalized) return false;

  return (
    normalized.includes('/search_result') ||
    normalized.includes('/web/search_result') ||
    normalized.includes('/search/result') ||
    /^\/(?:explore|discovery)\/?$/.test(normalized)
  );
}

function isSameOriginAndPathname(urlA, urlB) {
  try {
    const parsedA = new URL(String(urlA || '').trim());
    const parsedB = new URL(String(urlB || '').trim());

    const pathnameA = parsedA.pathname.replace(/\/+$/, '') || '/';
    const pathnameB = parsedB.pathname.replace(/\/+$/, '') || '/';

    return parsedA.origin === parsedB.origin && pathnameA === pathnameB;
  } catch {
    return false;
  }
}

function isDetailCaptureCanceledError(error) {
  const message = String(error?.message || '');
  return message === 'DETAIL_CAPTURE_CANCELED';
}

function isBatchCaptureCanceledError(error) {
  const message = String(error?.message || '');
  return (
    message === 'BATCH_CAPTURE_CANCELED' ||
    message === 'DETAIL_CAPTURE_CANCELED'
  );
}

function isCaptureCanceledResult(result) {
  const errorCode = String(result?.error?.code || '').trim().toUpperCase();
  const errorMessage = String(result?.error?.message || '').trim();
  return (
    errorCode === 'CAPTURE_CANCELED' ||
    errorCode === 'BATCH_CAPTURE_CANCELED' ||
    errorMessage === 'BATCH_CAPTURE_CANCELED' ||
    errorMessage === 'DETAIL_CAPTURE_CANCELED'
  );
}

function waitMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

async function waitMsWithStop(ms, shouldStop, errorMessage = 'BATCH_CAPTURE_CANCELED') {
  const total = Math.max(0, Number(ms) || 0);
  if (total <= 0) {
    return;
  }

  const step = 100;
  let elapsed = 0;
  while (elapsed < total) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error(errorMessage);
    }
    const remaining = Math.min(step, total - elapsed);
    await waitMs(remaining);
    elapsed += remaining;
  }
}

async function captureCommentsForCurrentNote({
  tabId,
  maxDetectedItems,
  maxDurationMs,
  waitMinMs,
  waitMaxMs,
  stallTimeoutMs,
}) {
  const result = await captureInTab(tabId, {
    mode: 'comments',
    captureParams: {
      onlyLevel1: false,
      maxDetectedItems,
      maxDurationMs,
      waitMinMs,
      waitMaxMs,
      stallTimeoutMs,
    },
  });

  if (!result?.ok) {
    return {
      status: COMMENT_CAPTURE_STATUS.FAILED,
      stoppedByUser: false,
      cleanedItems: [],
      mergedText: '',
      error: result?.error?.message || '评论采集失败',
    };
  }

  const rawItems = Array.isArray(result.data?.items) ? result.data.items : [];
  const cleanedItems = cleanCommentsItems(rawItems);
  const captureStatus = String(
    result.data?.captureStatus || result.meta?.captureStatus || '',
  )
    .trim()
    .toLowerCase();
  const partial = captureStatus === COMMENT_CAPTURE_STATUS.PARTIAL;

  return {
    status: partial ? COMMENT_CAPTURE_STATUS.PARTIAL : COMMENT_CAPTURE_STATUS.DONE,
    stoppedByUser: partial,
    cleanedItems,
    mergedText: buildCommentsMergedText(cleanedItems),
    error: '',
  };
}

function applyCommentResultToSingleNotePayload(payload, result) {
  const now = Date.now();

  if (result.status === COMMENT_CAPTURE_STATUS.FAILED) {
    return applyCommentStatusToPayload(
      payload,
      createCommentStatusPatch({
        status: COMMENT_CAPTURE_STATUS.FAILED,
        startedAt: now,
        finishedAt: now,
        stoppedByUser: false,
        error: result.error || '评论采集失败',
      }),
    );
  }

  return applyCommentStatusToPayload(
    payload,
    createCommentStatusPatch({
      status: result.status,
      startedAt: now,
      finishedAt: now,
      stoppedByUser: Boolean(result.stoppedByUser),
      error: '',
      cleanedItems: Array.isArray(result.cleanedItems) ? result.cleanedItems : [],
      mergedText: String(result.mergedText || ''),
    }),
  );
}

function applyCommentLeadsToPayload({
  syncType,
  payload,
  commentLeadsConfig,
  computedAt = Date.now(),
}) {
  const normalizedPayload = applyCommentStatusToPayload(payload, {});
  const normalizedConfig = normalizeCommentLeadsConfig(commentLeadsConfig);
  const leadResult = buildCommentLeadsPayloadForRecord(
    {
      type: syncType,
      payload: normalizedPayload,
    },
    normalizedConfig,
  );

  const nextPayload = applyCommentStatusToPayload(
    normalizedPayload,
    createCommentStatusPatch({
      status:
        normalizedPayload.commentsCaptureStatus || COMMENT_CAPTURE_STATUS.NOT_STARTED,
      startedAt: normalizedPayload.commentsCaptureStartedAt || 0,
      finishedAt: normalizedPayload.commentsCaptureFinishedAt || 0,
      stoppedByUser: Boolean(normalizedPayload.commentsCaptureStoppedByUser),
      error: normalizedPayload.commentsCaptureError || '',
      cleanedItems: normalizedPayload.commentsCleanedItems || [],
      mergedText: normalizedPayload.commentsMergedText || '',
      commentLeadsEnabled: normalizedConfig.enabled,
      commentLeadsKeywords: normalizedConfig.keywords,
      commentLeadsIps: normalizedConfig.ips,
      commentLeadsItems: leadResult.payload?.items || [],
      commentLeadsTotal: leadResult.matchedCount,
      commentLeadsLastComputedAt: computedAt,
    }),
  );

  return {
    payload: nextPayload,
    leadResult,
  };
}

async function getTabScrollY(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return Number(window.scrollY || 0);
      },
    });
    const value = Number(result?.result);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

async function restoreSourcePageIfNeeded(
  tabId,
  sourcePageUrl,
  sourcePageScrollY = 0,
  { timeoutMs = DETAIL_CAPTURE_NAV_TIMEOUT_MS } = {},
) {
  const normalizedSource = normalizeOpenUrl(sourcePageUrl);
  if (!normalizedSource) {
    return;
  }

  let currentUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    currentUrl = String(tab?.url || '');
  } catch {
    return;
  }

  if (!isTargetNoteOpened(currentUrl, normalizedSource, extractNoteId(normalizedSource))) {
    try {
      await openUrlInTab(tabId, normalizedSource, { timeoutMs, active: true });
    } catch (error) {
      console.warn('[CaptureSync] restore source page failed:', error);
      return;
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (scrollY) => {
        window.scrollTo({
          top: Number(scrollY) || 0,
          left: 0,
          behavior: 'auto',
        });
      },
      args: [Math.max(0, Number(sourcePageScrollY) || 0)],
    });
  } catch (error) {
    console.warn('[CaptureSync] restore source scroll failed:', error);
  }
}

async function restoreSourceRuntimeContextIfNeeded({
  tabId,
  sourcePageUrl,
  sourcePlatform = 'unknown',
  sourcePageType = PAGE_TYPE.UNKNOWN,
} = {}) {
  const normalizedSource = normalizeOpenUrl(sourcePageUrl);
  if (!normalizedSource) {
    return;
  }

  await updateRuntime({
    lastActiveTabId: Number.isFinite(Number(tabId)) ? Number(tabId) : null,
    lastPageUrl: normalizedSource,
    platform: sourcePlatform || detectPlatformFromUrl(normalizedSource),
    pageType: sourcePageType || detectPageType(normalizedSource),
  });
}

function buildRecordsForStorage(captureResult) {
  const type = captureResult?.type || '';
  const payload =
    captureResult?.data && typeof captureResult.data === 'object'
      ? captureResult.data
      : null;
  const meta =
    captureResult?.meta && typeof captureResult.meta === 'object'
      ? captureResult.meta
      : {};
  const platform = captureResult?.platform || '';

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  // 将博主笔记/搜索笔记按“单条笔记”拆分缓存，便于页面逐条展示和操作
  if ((type === 'blogger_notes' || type === 'keyword_notes') && Array.isArray(payload.items)) {
    if (payload.items.length === 0) return [];

    return payload.items.map((item) => {
      const normalizedItem = normalizeDetailRecordItem(item, payload);
      const nextPayload = ensureDetailCaptureFields({
        ...payload,
        totalCount: 1,
        items: [normalizedItem],
      });
      const preview = buildRecordPreview(type, nextPayload);
      return {
        ...createRecordEnvelope({
          platform,
          type,
          data: nextPayload,
          meta,
        }),
        title: preview.title,
        summary: preview.summary,
      };
    });
  }

  const preview = buildRecordPreview(type, payload);
  return [
    {
      ...createRecordEnvelope({
        platform,
        type,
        data: payload,
        meta,
      }),
      title: preview.title,
      summary: preview.summary,
    },
  ];
}

function buildRecordPreview(type, payload) {
  if (!payload || typeof payload !== 'object') {
    return { title: '无标题数据', summary: '无内容摘要...' };
  }

  if (type === 'single_note') {
    return {
      title: payload.title || payload.noteId || '单篇笔记',
      summary: payload.content || payload.url || '单篇笔记采集数据',
    };
  }

  if (type === 'blogger_profile') {
    return {
      title: payload.bloggerName || payload.bloggerId || '博主信息',
      summary: payload.description || payload.bloggerUrl || '博主主页信息采集数据',
    };
  }

  if (type === 'blogger_notes') {
    const firstItem = (payload.items || [])[0] || {};
    return {
      title: firstItem.title || '博主笔记',
      summary: `${firstItem.author || payload.bloggerName || '作者未知'} · 点赞 ${firstItem.likes || 0}`,
    };
  }

  if (type === 'keyword_notes') {
    const firstItem = (payload.items || [])[0] || {};
    const sortDimension = String(payload.sortDimension || '').trim().toLowerCase();
    const metricLabel =
      sortDimension === 'collects'
        ? '收藏'
        : sortDimension === 'comments'
          ? '评论'
          : '点赞';
    const metricValue =
      sortDimension === 'collects'
        ? firstItem.collects || 0
        : sortDimension === 'comments'
          ? firstItem.comments || 0
          : firstItem.likes || 0;
    return {
      title: firstItem.title || (payload.keyword ? `关键词：${payload.keyword}` : '搜索结果笔记'),
      summary: `${firstItem.author || '作者未知'} · ${metricLabel} ${metricValue}`,
    };
  }

  if (type === 'comments') {
    return {
      title: payload.noteTitle || payload.noteId || '评论采集',
      summary: `共 ${payload.totalCount || 0} 条评论`,
    };
  }

  return { title: '无标题数据', summary: '无内容摘要...' };
}

function isDouyinContentFlowUrl(url = '') {
  const normalized = String(url || '').trim();
  if (!normalized) {
    return false;
  }

  if (!/douyin\.com/i.test(normalized)) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    const pathname = String(parsed.pathname || '').toLowerCase();

    if (parsed.searchParams.get('modal_id')) {
      return true;
    }

    if (pathname.startsWith('/search/') || pathname.startsWith('/jingxuan/search')) {
      return true;
    }
  } catch {
    return /[?&]modal_id=/i.test(normalized);
  }

  return false;
}

// ==================== 关键词裂变批量采集 ====================

const BATCH_KEYWORD_DELAY_MIN_MS = 3000;
const BATCH_KEYWORD_DELAY_MAX_MS = 5000;
const BATCH_KEYWORD_NAV_TIMEOUT_MS = 15000;
const BATCH_KEYWORD_NAV_POLL_MS = 300;
const BATCH_KEYWORD_AFTER_NAV_WAIT_MS = 2000;

async function runBatchSingleNoteEnhancements(
  recordId,
  {
    url = "",
    current = 0,
    total = 0,
    includeComments = false,
    includeBloggerMetrics = false,
    enableCommentLeadsFilter = null,
    commentsMaxDetectedItems = null,
    detailNavTimeoutMs = null,
    profileAfterNavWaitMs = null,
    preferWorksTabForBloggerMetrics = null,
    shouldStop = null,
    onProgress = null,
  } = {},
) {
  if (!recordId || (!includeComments && !includeBloggerMetrics)) {
    return {
      ok: true,
      commentsResult: null,
      bloggerMetricsResult: null,
      error: null,
    };
  }

  const emitProgress = (progress = {}) => {
    if (typeof onProgress !== "function") {
      return;
    }
    onProgress({
      current,
      total,
      url,
      phase: progress.phase || "capturing",
      message: progress.message || `正在采集第 ${current}/${total} 个...`,
      recordId,
    });
  };

  let commentsResult = null;
  let bloggerMetricsResult = null;
  let optionalFailed = false;

  try {
    if (typeof shouldStop === 'function' && shouldStop()) {
      return {
        ok: false,
        canceled: true,
        commentsResult,
        bloggerMetricsResult,
        error: {
          code: 'BATCH_CAPTURE_CANCELED',
          message: 'BATCH_CAPTURE_CANCELED',
        },
      };
    }

    if (includeBloggerMetrics) {
      bloggerMetricsResult = await captureBloggerMetricsForSingleNoteRecord(
        recordId,
        {
          preferWorksTabForBloggerMetrics,
          detailNavTimeoutMs,
          profileAfterNavWaitMs,
          shouldStop,
          onProgress: emitProgress,
        },
      );
      if (!bloggerMetricsResult?.ok) {
        optionalFailed = true;
      }
    }

    if (typeof shouldStop === 'function' && shouldStop()) {
      return {
        ok: false,
        canceled: true,
        commentsResult,
        bloggerMetricsResult,
        error: {
          code: 'BATCH_CAPTURE_CANCELED',
          message: 'BATCH_CAPTURE_CANCELED',
        },
      };
    }

    if (includeComments) {
      commentsResult = await captureCommentsForSingleNoteRecord(recordId, {
        commentsMaxDetectedItems,
        enableCommentLeadsFilter,
        onProgress: emitProgress,
      });
      if (!commentsResult?.ok) {
        optionalFailed = true;
      }
    }
  } catch (error) {
    optionalFailed = true;
    return {
      ok: false,
      commentsResult,
      bloggerMetricsResult,
      error: {
        code: "OPTIONAL_CAPTURE_FAILED",
        message: error?.message || "可选增强采集失败",
      },
    };
  }

  return {
    ok: !optionalFailed,
    canceled: false,
    commentsResult,
    bloggerMetricsResult,
    error:
      commentsResult?.error ||
      bloggerMetricsResult?.error ||
      (optionalFailed
        ? {
            code: "OPTIONAL_CAPTURE_FAILED",
            message: "可选增强采集失败",
          }
        : null),
  };
}

/**
 * 批量链接采集 — 在 runner tab 中逐个导航到 URL 并采集
 *
 * @param {Object} options
 * @param {string[]} options.urls - 链接列表
 * @param {string} options.mode - 'single' | 'blogger_notes'
 * @param {Object} options.captureParams - 传给 capture 脚本的参数
 * @param {boolean} [options.captureParams.includeBloggerProfileRecord] - 当 mode=blogger_notes 时是否先采集博主信息并入池
 * @param {Function} [options.onProgress] - 进度回调 ({ current, total, url, phase })
 * @param {Function} [options.shouldStop] - 取消检测函数
 * @returns {Promise<{ ok: boolean, results: Array, stats: Object }>}
 */
export async function batchCaptureByUrls({
  urls = [],
  mode = "single",
  captureParams = {},
  onProgress = null,
  shouldStop = null,
} = {}) {
  if (!urls.length) {
    return { ok: true, results: [], stats: { total: 0, success: 0, failed: 0 } };
  }

  const sourceTab = await getCurrentActiveTab();
  const runnerCtx = await prepareDetailBatchRunnerContext({
    sourceTab,
  });
  const { runnerTabId } = runnerCtx;

  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let canceled = false;

  for (let i = 0; i < urls.length; i++) {
    if (typeof shouldStop === "function" && shouldStop()) {
      canceled = true;
      break;
    }

    const url = urls[i];

    if (onProgress) {
      onProgress({
        current: i + 1,
        total: urls.length,
        url,
        phase: "navigating",
        message: `正在导航到 (${i + 1}/${urls.length})...`,
      });
    }

    try {
      // 检查链接是否合法
      try {
        new URL(url);
      } catch (e) {
        throw new Error("链接格式错误");
      }

      // 导航
      await chrome.tabs.update(runnerTabId, { url });

      // 等待导航完成
      let navStartedAt = Date.now();
      let loaded = false;
      while (Date.now() - navStartedAt < BATCH_KEYWORD_NAV_TIMEOUT_MS) {
        if (typeof shouldStop === "function" && shouldStop()) {
          throw new Error("BATCH_CAPTURE_CANCELED");
        }
        let tab = await chrome.tabs.get(runnerTabId);
        if (String(tab?.status || "") === "complete") {
          loaded = true;
          break;
        }
        await waitMs(BATCH_KEYWORD_NAV_POLL_MS);
      }
      if (!loaded) throw new Error("导航超时");

      // 等待页面渲染
      await waitMsWithStop(
        BATCH_KEYWORD_AFTER_NAV_WAIT_MS,
        shouldStop,
        "BATCH_CAPTURE_CANCELED",
      );

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: urls.length,
          url,
          phase: "capturing",
          message: `正在采集第 ${i + 1}/${urls.length} 个...`,
        });
      }

      let profileRecordIds = [];
      let resolvedProfileMetrics = captureParams.profileMetrics;
      const shouldCaptureBloggerProfileFirst =
        mode === "blogger_notes" &&
        Boolean(captureParams.includeBloggerProfileRecord);
      if (shouldCaptureBloggerProfileFirst) {
        const profileCaptureResult = await captureInTab(runnerTabId, {
          mode: "blogger_profile",
        });
        if (isCaptureCanceledResult(profileCaptureResult)) {
          canceled = true;
          break;
        }
        if (!profileCaptureResult?.ok) {
          throw new Error(profileCaptureResult?.error?.message || "博主信息采集失败");
        }

        const profilePayload =
          profileCaptureResult?.data &&
          typeof profileCaptureResult.data === "object"
            ? profileCaptureResult.data
            : null;
        if (profilePayload) {
          resolvedProfileMetrics = profilePayload;
        }

        const profileRecordsToSave = buildRecordsForStorage(profileCaptureResult);
        if (profileRecordsToSave.length > 0) {
          const savedProfiles =
            profileRecordsToSave.length === 1
              ? [await addRecord(profileRecordsToSave[0])]
              : await addRecords(profileRecordsToSave);
          profileRecordIds = savedProfiles
            .map((record) => record?.id)
            .filter(Boolean);
        }
      }

      // 采集（注：这里重用 captureInTab）
      const singleNoteEnhancementOptions =
        mode === "single"
          ? {
              includeComments: Boolean(captureParams.includeComments),
              includeBloggerMetrics: Boolean(captureParams.includeBloggerMetrics),
              enableCommentLeadsFilter: captureParams.enableCommentLeadsFilter,
              commentsMaxDetectedItems:
                captureParams.commentsMaxDetectedItems ?? captureParams.commentsMaxItems,
              detailNavTimeoutMs: captureParams.detailNavTimeoutMs,
              profileAfterNavWaitMs: captureParams.profileAfterNavWaitMs,
              preferWorksTabForBloggerMetrics:
                typeof captureParams.preferWorksTabForBloggerMetrics === "boolean"
                  ? captureParams.preferWorksTabForBloggerMetrics
                  : Boolean(captureParams.includeBloggerMetrics) &&
                    detectPlatformFromUrl(url) === "douyin" &&
                    isDouyinContentFlowUrl(url),
            }
          : null;
      const effectiveCaptureParams =
        mode === "single" && singleNoteEnhancementOptions
          ? {
              ...captureParams,
              preferWorksTabForBloggerMetrics:
                singleNoteEnhancementOptions.preferWorksTabForBloggerMetrics,
            }
          : mode === "blogger_notes" &&
              resolvedProfileMetrics &&
              typeof resolvedProfileMetrics === "object"
            ? {
                ...captureParams,
                profileMetrics: resolvedProfileMetrics,
              }
            : captureParams;
      const captureResult = await captureInTab(runnerTabId, {
        mode,
        captureParams: effectiveCaptureParams,
      });

      if (isCaptureCanceledResult(captureResult)) {
        canceled = true;
        break;
      }
      if (typeof shouldStop === "function" && shouldStop()) {
        canceled = true;
        break;
      }

      // 入池
      if (captureResult?.ok) {
        const recordsToSave = buildRecordsForStorage(captureResult);
        if (recordsToSave.length > 0) {
          const savedRecords =
            recordsToSave.length === 1
              ? [await addRecord(recordsToSave[0])]
              : await addRecords(recordsToSave);
          const noteRecordIds = savedRecords.map((r) => r?.id).filter(Boolean);
          const recordIds = [...profileRecordIds, ...noteRecordIds];
          const enhancementResult =
            mode === "single" && noteRecordIds.length === 1
              ? await runBatchSingleNoteEnhancements(noteRecordIds[0], {
                  url,
                  current: i + 1,
                  total: urls.length,
                  shouldStop,
                  onProgress,
                  ...singleNoteEnhancementOptions,
                })
              : null;
          const canceledDuringEnhancement = Boolean(
            enhancementResult?.canceled ||
              isBatchCaptureCanceledError(enhancementResult?.error) ||
              (typeof shouldStop === "function" && shouldStop()),
          );
          results.push({
            url,
            ok: true,
            recordIds,
            partial: Boolean(enhancementResult && !enhancementResult.ok),
            canceled: canceledDuringEnhancement,
            commentsResult: enhancementResult?.commentsResult || null,
            bloggerMetricsResult: enhancementResult?.bloggerMetricsResult || null,
            warning:
              enhancementResult && !enhancementResult.ok
                ? enhancementResult.error?.message || "可选增强采集失败"
                : "",
          });
          successCount++;
          if (canceledDuringEnhancement) {
            canceled = true;
            break;
          }
        } else {
          results.push({ url, ok: true, recordIds: profileRecordIds });
          successCount++;
        }
      } else {
        results.push({
          url,
          ok: false,
          error: captureResult?.error?.message || "采集失败",
        });
        failedCount++;
      }
    } catch (error) {
      if (isBatchCaptureCanceledError(error)) {
        canceled = true;
        break;
      }
      results.push({
        url,
        ok: false,
        error: error.message,
      });
      failedCount++;
    }

    // 随机延迟
    if (i < urls.length - 1) {
      const delay =
        BATCH_KEYWORD_DELAY_MIN_MS +
        Math.random() *
          (BATCH_KEYWORD_DELAY_MAX_MS - BATCH_KEYWORD_DELAY_MIN_MS);
      try {
        await waitMsWithStop(delay, shouldStop, "BATCH_CAPTURE_CANCELED");
      } catch (error) {
        if (isBatchCaptureCanceledError(error)) {
          canceled = true;
          break;
        }
        throw error;
      }
    }
  }

  // 恢复原始页面
  if (runnerCtx.shouldRestoreSourcePage && runnerCtx.sourcePageUrl) {
    try {
      await chrome.tabs.update(runnerTabId, { url: runnerCtx.sourcePageUrl });
    } catch {
      // ignore
    }
  }

  if (onProgress) {
    onProgress({
      current: successCount + failedCount,
      total: urls.length,
      url: "",
      phase: canceled ? "canceled" : "done",
      message: canceled
        ? `批量采集已停止：已处理 ${successCount + failedCount}/${urls.length}，成功 ${successCount}，失败 ${failedCount}`
        : `批量采集完成：成功 ${successCount}，失败 ${failedCount}`,
    });
  }

  return {
    ok: !canceled && failedCount === 0,
    canceled,
    results,
    stats: {
      total: urls.length,
      processed: successCount + failedCount,
      success: successCount,
      failed: failedCount,
    },
  };
}

/**
 * 批量关键词采集 — 在 runner tab 中逐个导航到关键词搜索 URL 并采集
 *
 * @param {Object} options
 * @param {string[]} options.keywords - 关键词列表
 * @param {string} options.platform - 平台标识 ('xiaohongshu' | 'douyin')
 * @param {string} options.baseSearchUrl - 当前搜索页 URL（用于构建同平台搜索 URL）
 * @param {Object} options.captureParams - 传给 captureKeywordNotes 的参数
 * @param {Function} [options.onProgress] - 进度回调 ({ current, total, keyword, phase })
 * @param {Function} [options.shouldStop] - 取消检测函数
 * @returns {Promise<{ ok: boolean, results: Array, stats: Object }>}
 */
export async function batchCaptureByKeywords({
  keywords = [],
  platform = '',
  baseSearchUrl = '',
  captureParams = {},
  onProgress = null,
  shouldStop = null,
} = {}) {
  if (!keywords.length) {
    return { ok: true, results: [], stats: { total: 0, success: 0, failed: 0 } };
  }

  const sourceTab = await getCurrentActiveTab();
  const runnerCtx = await prepareDetailBatchRunnerContext({ sourceTab });
  const { runnerTabId } = runnerCtx;

  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let canceled = false;

  for (let i = 0; i < keywords.length; i++) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      canceled = true;
      break;
    }

    const keyword = keywords[i];

    if (onProgress) {
      onProgress({
        current: i + 1,
        total: keywords.length,
        keyword,
        phase: 'navigating',
        message: `正在导航到关键词「${keyword}」(${i + 1}/${keywords.length})...`,
      });
    }

    try {
      // 构建搜索 URL
      const searchUrl = buildKeywordSearchUrl(keyword, platform, baseSearchUrl);

      // 导航到搜索页
      await navigateToSearchUrl(runnerTabId, searchUrl, shouldStop);

      // 等待页面渲染
      await waitMsWithStop(
        BATCH_KEYWORD_AFTER_NAV_WAIT_MS,
        shouldStop,
        'BATCH_CAPTURE_CANCELED',
      );

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: keywords.length,
          keyword,
          phase: 'capturing',
          message: `正在采集「${keyword}」(${i + 1}/${keywords.length})...`,
        });
      }

      // 在 runner tab 中执行采集
      const captureResult = await captureInTab(runnerTabId, {
        mode: 'keyword',
        captureParams: {
          ...captureParams,
          keyword,
        },
      });

      if (isCaptureCanceledResult(captureResult)) {
        canceled = true;
        break;
      }
      if (typeof shouldStop === 'function' && shouldStop()) {
        canceled = true;
        break;
      }

      // 入池
      if (captureResult?.ok) {
        const recordsToSave = buildRecordsForStorage(captureResult);
        if (recordsToSave.length > 0) {
          const savedRecords =
            recordsToSave.length === 1
              ? [await addRecord(recordsToSave[0])]
              : await addRecords(recordsToSave);
          results.push({
            keyword,
            ok: true,
            recordIds: savedRecords.map((r) => r?.id).filter(Boolean),
          });
          successCount++;
        } else {
          results.push({ keyword, ok: true, recordIds: [] });
          successCount++;
        }
      } else {
        results.push({
          keyword,
          ok: false,
          error: captureResult?.error?.message || '采集失败',
        });
        failedCount++;
      }
    } catch (error) {
      if (isBatchCaptureCanceledError(error)) {
        canceled = true;
        break;
      }
      results.push({
        keyword,
        ok: false,
        error: error.message,
      });
      failedCount++;
    }

    // 关键词间随机延迟（最后一个不延迟）
    if (i < keywords.length - 1) {
      const delay =
        BATCH_KEYWORD_DELAY_MIN_MS +
        Math.random() * (BATCH_KEYWORD_DELAY_MAX_MS - BATCH_KEYWORD_DELAY_MIN_MS);
      try {
        await waitMsWithStop(delay, shouldStop, 'BATCH_CAPTURE_CANCELED');
      } catch (error) {
        if (isBatchCaptureCanceledError(error)) {
          canceled = true;
          break;
        }
        throw error;
      }
    }
  }

  // 恢复原始页面
  if (runnerCtx.shouldRestoreSourcePage && runnerCtx.sourcePageUrl) {
    try {
      await chrome.tabs.update(runnerTabId, { url: runnerCtx.sourcePageUrl });
    } catch {
      // ignore restore failure
    }
  }

  if (onProgress) {
    onProgress({
      current: successCount + failedCount,
      total: keywords.length,
      keyword: '',
      phase: canceled ? 'canceled' : 'done',
      message: canceled
        ? `批量采集已停止：已处理 ${successCount + failedCount}/${keywords.length}，成功 ${successCount}，失败 ${failedCount}`
        : `批量采集完成：成功 ${successCount}，失败 ${failedCount}`,
    });
  }

  return {
    ok: !canceled && failedCount === 0,
    canceled,
    results,
    stats: {
      total: keywords.length,
      processed: successCount + failedCount,
      success: successCount,
      failed: failedCount,
    },
  };
}

export async function lightSampleByKeywords({
  categorySamples = [],
  platform = '',
  baseSearchUrl = '',
  onProgress = null,
  shouldStop = null,
} = {}) {
  if (!Array.isArray(categorySamples) || categorySamples.length === 0) {
    return {
      ok: true,
      canceled: false,
      results: {},
      stats: { total: 0, success: 0, failed: 0 },
    };
  }

  const sourceTab = await getCurrentActiveTab();
  const runnerCtx = await prepareDetailBatchRunnerContext({ sourceTab });
  const { runnerTabId } = runnerCtx;

  const results = {};
  let successCount = 0;
  let failedCount = 0;
  let canceled = false;

  for (let i = 0; i < categorySamples.length; i++) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      canceled = true;
      break;
    }

    const item = categorySamples[i] && typeof categorySamples[i] === 'object'
      ? categorySamples[i]
      : {};
    const categoryId = String(item.categoryId || '').trim();
    const candidateKeywords = Array.isArray(item.candidateKeywords)
      ? item.candidateKeywords
          .map((keyword) => String(keyword || '').trim())
          .filter(Boolean)
      : [];

    if (!categoryId || candidateKeywords.length === 0) {
      failedCount++;
      continue;
    }

    let categoryResult = {
      categoryId,
      usedKeyword: null,
      status: 'error',
      errorMessage: '未找到可用采样关键词',
      samples: [],
    };

    for (let j = 0; j < candidateKeywords.length; j++) {
      if (typeof shouldStop === 'function' && shouldStop()) {
        canceled = true;
        break;
      }

      const keyword = candidateKeywords[j];
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: categorySamples.length,
          categoryId,
          keyword,
          phase: 'sampling',
          message: `正在采样方向词「${keyword}」(${i + 1}/${categorySamples.length})...`,
        });
      }

      try {
        const searchUrl = buildKeywordSearchUrl(keyword, platform, baseSearchUrl);
        await navigateToSearchUrl(runnerTabId, searchUrl, shouldStop);
        await waitMsWithStop(
          BATCH_KEYWORD_AFTER_NAV_WAIT_MS,
          shouldStop,
          'BATCH_CAPTURE_CANCELED',
        );

        const captureResult = await captureInTab(runnerTabId, {
          mode: 'keyword',
          captureParams: {
            keyword,
            minLikes: 0,
            maxDetectedItems: 3,
            maxScrollTimes: 3,
            waitMinMs: 800,
            waitMaxMs: 1500,
            stallTimeoutMs: 2000,
            maxDurationMs: 20_000,
          },
        });

        if (isCaptureCanceledResult(captureResult)) {
          canceled = true;
          break;
        }

        const payload =
          captureResult?.data && typeof captureResult.data === 'object'
            ? captureResult.data
            : null;
        const items = Array.isArray(payload?.items) ? payload.items : [];
        if (items.length === 0) {
          categoryResult = {
            categoryId,
            usedKeyword: keyword,
            status: 'error',
            errorMessage: '未获取到样本数据',
            samples: [],
          };
          continue;
        }

        categoryResult = {
          categoryId,
          usedKeyword: keyword,
          status: 'success',
          errorMessage: '',
          samples: items.slice(0, 3).map((sample) => ({
            title: String(sample?.title || '').trim(),
            author: String(sample?.author || '').trim(),
            likes: Number(sample?.likes) || 0,
            comments: Number(sample?.comments) || 0,
            coverImageUrl: String(sample?.coverImageUrl || '').trim(),
            url: String(sample?.url || '').trim(),
          })),
        };
        break;
      } catch (error) {
        if (isBatchCaptureCanceledError(error)) {
          canceled = true;
          break;
        }
        categoryResult = {
          categoryId,
          usedKeyword: keyword,
          status: 'error',
          errorMessage: error?.message || '轻采样失败',
          samples: [],
        };
      }
    }

    if (canceled) {
      break;
    }

    results[categoryId] = categoryResult;
    if (categoryResult.status === 'success') {
      successCount++;
    } else {
      failedCount++;
    }

    if (onProgress) {
      onProgress({
        current: i + 1,
        total: categorySamples.length,
        categoryId,
        keyword: categoryResult.usedKeyword || '',
        phase: 'category_done',
        message:
          categoryResult.status === 'success'
            ? `方向样本已更新（${i + 1}/${categorySamples.length}）`
            : `方向样本获取失败（${i + 1}/${categorySamples.length}）`,
        result: categoryResult,
      });
    }

    if (i < categorySamples.length - 1) {
      const delay =
        BATCH_KEYWORD_DELAY_MIN_MS +
        Math.random() * (BATCH_KEYWORD_DELAY_MAX_MS - BATCH_KEYWORD_DELAY_MIN_MS);
      try {
        await waitMsWithStop(delay, shouldStop, 'BATCH_CAPTURE_CANCELED');
      } catch (error) {
        if (isBatchCaptureCanceledError(error)) {
          canceled = true;
          break;
        }
        throw error;
      }
    }
  }

  if (runnerCtx.shouldRestoreSourcePage && runnerCtx.sourcePageUrl) {
    try {
      await chrome.tabs.update(runnerTabId, { url: runnerCtx.sourcePageUrl });
    } catch {
      // ignore restore failure
    }
  }

  return {
    ok: !canceled && failedCount === 0,
    canceled,
    results,
    stats: {
      total: categorySamples.length,
      processed: successCount + failedCount,
      success: successCount,
      failed: failedCount,
    },
  };
}

export async function captureTabContent(
  tabId,
  {
    mode = 'auto',
    captureParams = {},
  } = {},
) {
  return captureInTab(tabId, {
    mode,
    captureParams,
  });
}

/**
 * 根据平台构建关键词搜索 URL
 */
function buildKeywordSearchUrl(keyword, platform, baseSearchUrl) {
  const encodedKeyword = encodeURIComponent(keyword);

  if (platform === 'douyin') {
    return `https://www.douyin.com/search/${encodedKeyword}?type=video`;
  }

  if (platform === 'weibo') {
    return `https://s.weibo.com/weibo?q=${encodedKeyword}`;
  }

  // 小红书：统一构造到搜索结果路由，避免把关键词拼到 explore/discovery 等无效路径上
  const xhsDefaultSearchUrl = new URL('https://www.xiaohongshu.com/search_result');
  xhsDefaultSearchUrl.searchParams.set('source', 'web_explore_feed');
  xhsDefaultSearchUrl.searchParams.set('type', '51');

  if (baseSearchUrl) {
    try {
      const parsed = new URL(baseSearchUrl);
      const pathname = String(parsed.pathname || '').toLowerCase();
      const isXhsSearchPath =
        pathname.includes('/search_result') ||
        pathname.includes('/web/search_result') ||
        pathname.includes('/search/result');

      // 已在搜索结果页：复用该 URL 的搜索参数，避免丢失可用上下文
      if (isXhsSearchPath) {
        parsed.searchParams.set('keyword', keyword);
        return parsed.toString();
      }

      // 非搜索结果页（例如 explore）：切到标准搜索路由，只拷贝与搜索相关的参数
      const nextSearchUrl = new URL(xhsDefaultSearchUrl.toString());
      const source = String(parsed.searchParams.get('source') || '').trim();
      const type = String(parsed.searchParams.get('type') || '').trim();
      if (source) {
        nextSearchUrl.searchParams.set('source', source);
      }
      if (type) {
        nextSearchUrl.searchParams.set('type', type);
      }
      nextSearchUrl.searchParams.set('keyword', keyword);
      return nextSearchUrl.toString();
    } catch {
      // fallback
    }
  }

  xhsDefaultSearchUrl.searchParams.set('keyword', keyword);
  return xhsDefaultSearchUrl.toString();
}

/**
 * 导航到搜索 URL 并等待页面加载完成
 */
async function navigateToSearchUrl(tabId, targetUrl, shouldStop) {
  await chrome.tabs.update(tabId, {
    url: targetUrl,
    active: true,
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < BATCH_KEYWORD_NAV_TIMEOUT_MS) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error('BATCH_CAPTURE_CANCELED');
    }

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw new Error(error?.message || '读取标签页状态失败');
    }

    if (String(tab?.status || '') === 'complete') {
      return;
    }

    await waitMs(BATCH_KEYWORD_NAV_POLL_MS);
  }

  throw new Error('搜索页导航超时');
}

async function captureInActiveTab({
  mode = 'auto',
  onProgress = null,
  captureParams = {},
} = {}) {
  if (onProgress) {
    onProgress({
      phase: 'checking_page',
      message: '正在连接当前页面...',
    });
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('未找到当前活动标签页');
  }

  return captureInTab(tab.id, {
    mode,
    captureParams,
  });
}

async function captureInTab(
  tabId,
  {
    mode = 'auto',
    captureParams = {},
  } = {},
) {
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    throw new Error('未找到可用标签页');
  }

  const payload = buildContentRequest(mode, captureParams);
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPE.RELAY_TO_CONTENT,
    tabId: normalizedTabId,
    payload,
  });

  if (!response?.ok) {
    const message =
      response?.error?.message ||
      '无法连接到页面采集脚本，请刷新当前页面后重试';
    throw new Error(message);
  }

  return response.data;
}

function buildContentRequest(mode, captureParams = {}) {
  switch (mode) {
    case 'auto':
      return { action: 'smartCapture', mode: 'auto' };
    case 'single':
      return {
        action: 'captureSingleNote',
        includeBloggerMetrics: Boolean(captureParams.includeBloggerMetrics),
        preferWorksTabForBloggerMetrics: Boolean(
          captureParams.preferWorksTabForBloggerMetrics,
        ),
      };
    case 'blogger_profile':
      return { action: 'captureBloggerProfile' };
    case 'blogger_notes':
      return {
        action: 'captureBloggerNotes',
        minLikes: captureParams.minLikes,
        maxDetectedItems:
          captureParams.maxDetectedItems ?? captureParams.maxItems,
        keywordFilter: captureParams.keywordFilter || '',
        profileMetrics: captureParams.profileMetrics,
        monitorPublishWindow: captureParams.monitorPublishWindow || '',
        monitorObserveWindowHours: captureParams.monitorObserveWindowHours,
        monitorLikeThreshold: captureParams.monitorLikeThreshold,
        waitMinMs: captureParams.waitMinMs,
        waitMaxMs: captureParams.waitMaxMs,
        stallTimeoutMs: captureParams.stallTimeoutMs,
        maxDurationMs: captureParams.maxDurationMs,
        maxScrollTimes: captureParams.maxScrollTimes,
      };
    case 'keyword':
      return {
        action: 'captureKeywordNotes',
        keyword: captureParams.keyword || '',
        minLikes: captureParams.minLikes,
        sortDimension: captureParams.sortDimension,
        maxDetectedItems:
          captureParams.maxDetectedItems ?? captureParams.maxItems,
        maxDurationMs: captureParams.maxDurationMs,
        waitMinMs: captureParams.waitMinMs,
        waitMaxMs: captureParams.waitMaxMs,
        stallTimeoutMs: captureParams.stallTimeoutMs,
        maxScrollTimes: captureParams.maxScrollTimes,
      };
    case 'comments':
      return {
        action: 'captureComments',
        onlyLevel1: Boolean(captureParams.onlyLevel1),
        maxDetectedItems:
          captureParams.maxDetectedItems ?? captureParams.maxItems,
        maxDurationMs: captureParams.maxDurationMs,
        noNewContentThreshold: captureParams.noNewContentThreshold,
        waitMinMs: captureParams.waitMinMs,
        waitMaxMs: captureParams.waitMaxMs,
        stallTimeoutMs: captureParams.stallTimeoutMs,
      };
    default:
      throw new Error(`未知的采集模式: ${mode}`);
  }
}
