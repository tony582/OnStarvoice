(function attachCloudTargetedPost(root) {
  "use strict";

  const PROTOCOL_VERSION = 1;
  // Keep the original export for callers that were written before targeted
  // capture became a shared protocol. New callers must validate against the
  // explicit allow-list instead of treating arbitrary workflow strings as
  // executable browser work.
  const WORKFLOW = "negative_post_patrol";
  const OFFICIAL_ACCOUNT_COMMENT_WORKFLOW = "official_account_comment_patrol";
  const SUPPORTED_WORKFLOWS = new Set([
    WORKFLOW,
    OFFICIAL_ACCOUNT_COMMENT_WORKFLOW,
  ]);
  const MAX_TARGETS = 100;
  const TERMINAL_STATUSES = new Set([
    "completed",
    "completed_with_warnings",
    "failed",
    "canceled",
    "needs_action",
  ]);
  const SETTLED_TARGET_STATUSES = new Set([
    "completed",
    "completed_with_warnings",
    "failed",
    "skipped",
    "canceled",
  ]);
  const ALLOWED_RUN_STATUSES = new Set([
    "pending",
    "running",
    "cancel_requested",
    ...TERMINAL_STATUSES,
  ]);

  function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function text(value, limit = 1000) {
    const normalized = String(value == null ? "" : value).trim();
    return normalized.length > limit ? normalized.slice(0, limit) : normalized;
  }

  function normalizePlatform(value) {
    const normalized = text(value, 40).toLowerCase();
    if (["xiaohongshu", "xhs", "小红书"].includes(normalized)) {
      return "xiaohongshu";
    }
    if (["douyin", "dy", "抖音"].includes(normalized)) {
      return "douyin";
    }
    return "";
  }

  function isAllowedHostname(hostname, platform) {
    const host = text(hostname, 253).toLowerCase().replace(/\.$/, "");
    const base =
      platform === "xiaohongshu"
        ? "xiaohongshu.com"
        : platform === "douyin"
          ? "douyin.com"
          : "";
    return Boolean(base && (host === base || host.endsWith(`.${base}`)));
  }

  function normalizeExternalId(value) {
    const normalized = text(value, 160);
    return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : "";
  }

  function readTargetIdentity(parsed, platform) {
    const pathname = String(parsed.pathname || "");
    if (platform === "xiaohongshu") {
      const match = pathname.match(
        /^\/(?:explore|discovery\/item|search_result|note|video)\/([A-Za-z0-9_-]+)\/?$/i,
      );
      return match
        ? {externalId: normalizeExternalId(match[1]), routeKind: "detail"}
        : null;
    }

    if (platform === "douyin") {
      const directMatch = pathname.match(
        /^\/(video|note)\/([A-Za-z0-9_-]+)\/?$/i,
      );
      if (directMatch) {
        return {
          externalId: normalizeExternalId(directMatch[2]),
          routeKind: directMatch[1].toLowerCase(),
        };
      }
      const modalId = normalizeExternalId(parsed.searchParams.get("modal_id"));
      const isSearchModal =
        /^\/(?:search|jingxuan\/search)\/[^/]+\/?$/i.test(pathname);
      if (modalId && isSearchModal) {
        return {externalId: modalId, routeKind: "search_modal"};
      }
    }
    return null;
  }

  function canonicalizeTargetUrl(
    rawUrl,
    platform,
    expectedExternalId = "",
    {allowDouyinSearchModal = true} = {},
  ) {
    const normalizedPlatform = normalizePlatform(platform);
    if (!normalizedPlatform) {
      throw Object.assign(new Error("不支持的目标平台"), {
        code: "TARGET_PLATFORM_UNSUPPORTED",
      });
    }

    let parsed;
    try {
      parsed = new URL(text(rawUrl, 3000));
    } catch {
      throw Object.assign(new Error("目标链接格式错误"), {
        code: "TARGET_URL_INVALID",
      });
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      (parsed.port && parsed.port !== "443") ||
      !isAllowedHostname(parsed.hostname, normalizedPlatform)
    ) {
      throw Object.assign(new Error("目标链接不在允许的平台范围内"), {
        code: "TARGET_URL_NOT_ALLOWED",
      });
    }

    const identity = readTargetIdentity(parsed, normalizedPlatform);
    if (!identity?.externalId) {
      throw Object.assign(new Error("只允许平台作品详情链接"), {
        code: "TARGET_DETAIL_URL_REQUIRED",
      });
    }
    if (
      normalizedPlatform === "douyin" &&
      identity.routeKind === "search_modal" &&
      allowDouyinSearchModal !== true
    ) {
      throw Object.assign(new Error("官方评论巡查只允许抖音作品详情直链"), {
        code: "TARGET_DIRECT_DETAIL_URL_REQUIRED",
      });
    }
    const expected = normalizeExternalId(expectedExternalId);
    if (expected && identity.externalId !== expected) {
      throw Object.assign(new Error("目标链接与作品标识不一致"), {
        code: "TARGET_IDENTITY_MISMATCH",
      });
    }

    const allowedQueryKeys =
      normalizedPlatform === "xiaohongshu"
        ? new Set(["xsec_token", "xsec_source"])
        : identity.routeKind === "search_modal"
          ? new Set(["modal_id", "type"])
          : new Set();
    for (const key of [...parsed.searchParams.keys()]) {
      if (!allowedQueryKeys.has(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();

    return {
      url: parsed.toString(),
      platform: normalizedPlatform,
      externalId: identity.externalId,
      routeKind: identity.routeKind,
    };
  }

  function normalizeCaptureSettings(value) {
    const source = objectValue(value);
    const commentLimit = Math.floor(
      Number(
        source.commentsMaxDetectedItems ??
          source.detailCommentsMaxDetectedItems ??
          50,
      ),
    );
    return {
      autoSyncAfterDetailCapture:
        !Object.prototype.hasOwnProperty.call(
          source,
          "autoSyncAfterDetailCapture",
        ) || source.autoSyncAfterDetailCapture === true,
      includeComments:
        source.includeComments === true ||
        source.includeCommentsOnDetailCapture === true,
      includeBloggerMetrics:
        source.includeBloggerMetrics === true ||
        source.includeBloggerMetricsOnDetailCapture === true,
      enableCommentLeadsFilter:
        source.enableCommentLeadsFilter === true ||
        source.enableCommentLeadsFilterOnDetailCapture === true,
      commentsMaxDetectedItems:
        Number.isFinite(commentLimit) && commentLimit > 0
          ? Math.min(commentLimit, 500)
          : 50,
    };
  }

  function isSupportedWorkflow(value) {
    return SUPPORTED_WORKFLOWS.has(text(value, 80));
  }

  function requireOfficialCommentPatrolSettings(captureSettings) {
    if (captureSettings.includeComments !== true) {
      throw Object.assign(new Error("官方评论巡查必须启用评论采集"), {
        code: "TARGET_COMMENTS_REQUIRED",
      });
    }
    if (captureSettings.autoSyncAfterDetailCapture !== true) {
      throw Object.assign(new Error("官方评论巡查必须启用后台同步"), {
        code: "TARGET_AUTO_SYNC_REQUIRED",
      });
    }
  }

  function normalizeCommandPayload(payload = {}, fallback = {}) {
    const source = objectValue(payload);
    const plan = objectValue(source.planSnapshot);
    const workflow = text(source.workflow || plan.workflow, 80);
    const protocolVersion = Number(
      source.protocolVersion ?? plan.protocolVersion,
    );
    if (!isSupportedWorkflow(workflow) || protocolVersion !== PROTOCOL_VERSION) {
      throw Object.assign(new Error("定向采集协议版本不受支持"), {
        code: "TARGET_PROTOCOL_UNSUPPORTED",
      });
    }

    const platform = normalizePlatform(
      source.platform || plan.platform || fallback.platform,
    );
    if (!platform) {
      throw Object.assign(new Error("定向采集缺少有效平台"), {
        code: "TARGET_PLATFORM_UNSUPPORTED",
      });
    }
    const taskId = text(
      source.taskId ||
        source.clientTaskId ||
        fallback.taskId ||
        fallback.clientTaskId,
      240,
    );
    if (!taskId) {
      throw Object.assign(new Error("定向采集缺少任务标识"), {
        code: "TARGET_TASK_ID_REQUIRED",
      });
    }

    const rawTargets = Array.isArray(plan.targets)
      ? plan.targets
      : Array.isArray(source.targets)
        ? source.targets
        : [];
    if (rawTargets.length === 0 || rawTargets.length > MAX_TARGETS) {
      throw Object.assign(new Error("定向采集目标数量无效"), {
        code: "TARGET_COUNT_INVALID",
      });
    }

    const isOfficialCommentPatrol = workflow === OFFICIAL_ACCOUNT_COMMENT_WORKFLOW;
    const captureSettings = normalizeCaptureSettings(
      plan.captureSettings || source.captureSettings,
    );
    if (isOfficialCommentPatrol) {
      requireOfficialCommentPatrolSettings(captureSettings);
    }

    const seenItems = new Set();
    const seenRecords = new Set();
    const targets = rawTargets.map((rawTarget, index) => {
      const target = objectValue(rawTarget);
      const recordId = text(target.recordId, 240);
      const itemId = text(target.itemId || recordId, 240);
      if (!recordId || !itemId) {
        throw Object.assign(new Error(`第 ${index + 1} 个目标缺少记录标识`), {
          code: "TARGET_RECORD_ID_REQUIRED",
        });
      }
      if (seenItems.has(itemId) || seenRecords.has(recordId)) {
        throw Object.assign(new Error("定向采集目标重复"), {
          code: "TARGET_DUPLICATED",
        });
      }
      const canonical = canonicalizeTargetUrl(
        target.url,
        platform,
        target.externalId,
        {allowDouyinSearchModal: !isOfficialCommentPatrol},
      );
      const publishedAt = text(target.publishedAt, 80);
      if (isOfficialCommentPatrol && !publishedAt) {
        throw Object.assign(new Error(`第 ${index + 1} 个目标缺少发布时间`), {
          code: "TARGET_PUBLISHED_AT_REQUIRED",
        });
      }
      seenItems.add(itemId);
      seenRecords.add(recordId);
      return {
        workflow,
        itemId,
        recordId,
        externalId: canonical.externalId,
        url: canonical.url,
        routeKind: canonical.routeKind,
        title: text(target.title, 500),
        publishedAt,
        ordinal: index + 1,
      };
    });

    return {
      protocolVersion: PROTOCOL_VERSION,
      workflow,
      taskId,
      clientTaskId: text(
        source.clientTaskId || fallback.clientTaskId || taskId,
        240,
      ),
      attemptId: text(source.attemptId || fallback.attemptId, 240),
      fenceToken: text(source.fenceToken || fallback.fenceToken, 500),
      platform,
      targets,
      captureSettings,
    };
  }

  function collectRecordExternalIds(record) {
    const source = objectValue(record);
    const data = objectValue(source.data);
    const ids = new Set();
    for (const candidate of [
      source.externalId,
      source.external_id,
      source.noteId,
      source.note_id,
      source.awemeId,
      source.aweme_id,
      data.externalId,
      data.external_id,
      data.noteId,
      data.note_id,
      data.awemeId,
      data.aweme_id,
      data.id,
    ]) {
      const normalized = normalizeExternalId(candidate);
      if (normalized) ids.add(normalized);
    }
    for (const candidate of [
      source.url,
      source.noteUrl,
      data.url,
      data.noteUrl,
      data.shareUrl,
    ]) {
      try {
        const parsed = new URL(text(candidate, 3000));
        const platform =
          normalizePlatform(source.platform || data.platform) ||
          (isAllowedHostname(parsed.hostname, "xiaohongshu")
            ? "xiaohongshu"
            : isAllowedHostname(parsed.hostname, "douyin")
              ? "douyin"
              : "");
        const identity = readTargetIdentity(parsed, platform);
        if (identity?.externalId) ids.add(identity.externalId);
      } catch {
        // Ignore non-URL record fields.
      }
    }
    return [...ids];
  }

  function buildTargetResult({
    target,
    batchResult = {},
    records = [],
    startedAt = "",
    finishedAt = "",
  } = {}) {
    const normalizedTarget = objectValue(target);
    const itemResult = Array.isArray(batchResult?.results)
      ? batchResult.results[0] || null
      : null;
    const recordIds = Array.isArray(itemResult?.recordIds)
      ? [...new Set(itemResult.recordIds.map((value) => text(value, 240)).filter(Boolean))]
      : [];
    const base = {
      workflow: text(normalizedTarget.workflow, 80) || WORKFLOW,
      itemId: text(normalizedTarget.itemId, 240),
      recordId: text(normalizedTarget.recordId, 240),
      externalId: text(normalizedTarget.externalId, 160),
      ordinal: Number(normalizedTarget.ordinal) || 0,
      startedAt: text(startedAt, 80),
      finishedAt: text(finishedAt, 80) || new Date().toISOString(),
    };
    if (batchResult?.canceled || itemResult?.canceled) {
      return {
        ...base,
        status: "canceled",
        recordIds,
        error: {
          code: "TARGET_CAPTURE_CANCELED",
          stage: "capture",
          message: "定向作品采集已停止",
          retryable: true,
        },
      };
    }
    if (!itemResult?.ok) {
      return {
        ...base,
        status: "failed",
        recordIds,
        error: {
          code: "TARGET_CAPTURE_FAILED",
          stage: "capture",
          message: text(itemResult?.error || "作品采集失败", 1000),
          retryable: true,
        },
      };
    }

    const recordById = new Map(
      (Array.isArray(records) ? records : [])
        .filter((record) => record && typeof record === "object")
        .map((record) => [text(record.id, 240), record]),
    );
    const capturedExternalIds = [
      ...new Set(
        recordIds.flatMap((recordId) =>
          collectRecordExternalIds(recordById.get(recordId)),
        ),
      ),
    ];
    if (!capturedExternalIds.includes(base.externalId)) {
      return {
        ...base,
        status: "failed",
        recordIds,
        capturedExternalIds,
        error: {
          code: "TARGET_IDENTITY_MISMATCH",
          stage: "identity_check",
          message: "采集结果与目标作品标识不一致，已阻止云端写回",
          retryable: false,
        },
      };
    }

    return {
      ...base,
      status: itemResult.partial
        ? "completed_with_warnings"
        : "completed",
      capturedExternalId: base.externalId,
      recordIds,
      warning: text(itemResult.warning, 1000),
      commentsResult: objectValue(itemResult.commentsResult),
      commentObservation: buildCommentObservation({
        commentsResult: itemResult.commentsResult,
        record: recordById.get(recordIds[0]),
        observedAt: base.finishedAt,
      }),
      bloggerMetricsResult: objectValue(itemResult.bloggerMetricsResult),
    };
  }

  function nonNegativeInteger(value) {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized >= 0
      ? Math.floor(normalized)
      : null;
  }

  function commentCountEvidence(record) {
    const source = objectValue(record);
    const payload = objectValue(source.payload);
    const detailPayload = objectValue(payload.detailPayload);
    const data = objectValue(source.data);
    for (const candidate of [data, payload, detailPayload]) {
      const count = nonNegativeInteger(candidate.comments ?? candidate.commentsCount);
      const known = candidate.commentsCountKnown === true;
      if (known && count !== null) {
        return {pageTotalCount: count, pageTotalKnown: true};
      }
    }
    return {pageTotalCount: null, pageTotalKnown: false};
  }

  // This is deliberately an observation of the current run, not a claim that
  // every historical comment has been fetched. The backend can use stable IDs
  // from the bounded sample to calculate newly-seen comments.
  function buildCommentObservation({commentsResult, record, observedAt = ""} = {}) {
    const result = objectValue(commentsResult);
    if (Object.keys(result).length === 0) return {};
    const samples = Array.isArray(result.currentObservedItems)
      ? result.currentObservedItems.slice(0, 20)
      : [];
    const observedCount = nonNegativeInteger(
      result.currentObservedCount ?? result.commentsCount ?? result.collectedCount,
    );
    const evidence = commentCountEvidence(record);
    return {
      observedAt: text(observedAt, 80),
      captureStatus: text(result.phase || result.status, 80),
      observedCount: observedCount === null ? 0 : observedCount,
      pageTotalCount: evidence.pageTotalCount,
      pageTotalKnown: evidence.pageTotalKnown,
      partial: result.partial === true,
      stoppedByUser: result.stoppedByUser === true,
      stoppedByStall: result.stoppedByStall === true,
      stoppedByNetwork: result.stoppedByNetwork === true,
      stopReason: text(result.stopReason, 160),
      sampleAvailable: samples.length > 0,
      samples,
      scope: "visible_comments_bounded",
    };
  }

  function applySyncResult(targetResult, syncResult = null, syncError = null) {
    const source = objectValue(targetResult);
    if (!["completed", "completed_with_warnings"].includes(source.status)) {
      return source;
    }
    const result = objectValue(syncResult);
    const successCount = Math.max(0, Number(result.successCount) || 0);
    const failedCount = Math.max(0, Number(result.failedCount) || 0);
    const pausedCount = Math.max(0, Number(result.pausedCount) || 0);
    const expectedCount = Array.isArray(source.recordIds)
      ? source.recordIds.length
      : 0;
    const fullySynced =
      !syncError &&
      result.ok === true &&
      expectedCount > 0 &&
      successCount >= expectedCount &&
      failedCount === 0 &&
      pausedCount === 0;
    if (fullySynced) {
      return {
        ...source,
        backendSynced: true,
        sync: {
          status: "completed",
          successCount,
          failedCount: 0,
          pausedCount: 0,
        },
      };
    }
    const partiallySynced = successCount > 0;
    const message = text(
      syncError?.message ||
        result.pausedMessage ||
        result.message ||
        result.error?.message ||
        "作品已在本地采集，但同步后台失败",
      1000,
    );
    return {
      ...source,
      status: partiallySynced ? "completed_with_warnings" : "failed",
      localCaptureCompleted: true,
      backendSynced: false,
      sync: {
        status: partiallySynced ? "partial" : "failed",
        successCount,
        failedCount,
        pausedCount,
      },
      error: {
        code: text(
          syncError?.code ||
            result.pausedReason ||
            result.error?.code ||
            "TARGET_SYNC_FAILED",
          120,
        ),
        stage: "sync",
        message,
        retryable: true,
      },
    };
  }

  function normalizeTargetResults(value, targets = []) {
    const allowedItems = new Set(
      targets.map((target) => text(target.itemId, 240)).filter(Boolean),
    );
    const results = [];
    const seen = new Set();
    for (const rawResult of Array.isArray(value) ? value : []) {
      const result = objectValue(rawResult);
      const itemId = text(result.itemId, 240);
      const status = text(result.status, 80);
      if (
        !itemId ||
        seen.has(itemId) ||
        !allowedItems.has(itemId) ||
        !SETTLED_TARGET_STATUSES.has(status)
      ) {
        continue;
      }
      seen.add(itemId);
      results.push({
        ...result,
        itemId,
        recordId: text(result.recordId, 240),
        externalId: text(result.externalId, 160),
        status,
      });
    }
    return results.sort(
      (left, right) =>
        (Number(left.ordinal) || 0) - (Number(right.ordinal) || 0),
    );
  }

  function buildCheckpoint(targets = [], targetResults = []) {
    const normalizedResults = normalizeTargetResults(targetResults, targets);
    const settledItemIds = new Set(
      normalizedResults.map((result) => result.itemId),
    );
    const firstPendingIndex = targets.findIndex(
      (target) => !settledItemIds.has(text(target.itemId, 240)),
    );
    const successCount = normalizedResults.filter((result) =>
      ["completed", "completed_with_warnings"].includes(result.status),
    ).length;
    const warningCount = normalizedResults.filter(
      (result) => result.status === "completed_with_warnings",
    ).length;
    const failedCount = normalizedResults.filter(
      (result) => result.status === "failed",
    ).length;
    return {
      workflow:
        text(targets[0]?.workflow, 80) ||
        text(normalizedResults[0]?.workflow, 80) ||
        WORKFLOW,
      nextOrdinal:
        firstPendingIndex >= 0 ? firstPendingIndex + 1 : targets.length + 1,
      processedCount: normalizedResults.length,
      successCount,
      warningCount,
      failedCount,
      canceledCount: normalizedResults.filter(
        (result) => result.status === "canceled",
      ).length,
      completedItemIds: normalizedResults.map((result) => result.itemId),
      total: targets.length,
    };
  }

  function createRunRequest(
    normalizedPayload,
    {commandId = "", requestId = "", attemptId = "", now = ""} = {},
  ) {
    const source = objectValue(normalizedPayload);
    const createdAt = text(now, 80) || new Date().toISOString();
    const id = text(requestId || source.clientTaskId || source.taskId, 240);
    return {
      schemaVersion: PROTOCOL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      workflow: text(source.workflow, 80) || WORKFLOW,
      id,
      taskId: text(source.taskId, 240),
      attemptId: text(source.attemptId || attemptId, 240),
      fenceToken: text(source.fenceToken, 500),
      cloudCommandId: text(commandId, 240),
      platform: normalizePlatform(source.platform),
      status: "pending",
      cancelRequested: false,
      createdAt,
      updatedAt: createdAt,
      heartbeatAt: createdAt,
      captureSettings: normalizeCaptureSettings(source.captureSettings),
      targets: Array.isArray(source.targets) ? source.targets : [],
      targetResults: [],
      checkpoint: buildCheckpoint(source.targets, []),
      message: "定向作品任务已创建，等待运行页领取",
      error: null,
    };
  }

  function mergeRunPatch(current, patch = {}) {
    const source = objectValue(current);
    const update = objectValue(patch);
    const requestedStatus = text(update.status, 80);
    const status = ALLOWED_RUN_STATUSES.has(requestedStatus)
      ? requestedStatus
      : text(source.status, 80) || "pending";
    const targetResults = Object.prototype.hasOwnProperty.call(
      update,
      "targetResults",
    )
      ? normalizeTargetResults(update.targetResults, source.targets)
      : normalizeTargetResults(source.targetResults, source.targets);
    const checkpoint = buildCheckpoint(source.targets, targetResults);
    const updatedAt = new Date().toISOString();
    return {
      ...source,
      status,
      cancelRequested:
        update.cancelRequested === true || source.cancelRequested === true,
      runnerTabId:
        Number.isFinite(Number(update.runnerTabId)) &&
        Number(update.runnerTabId) > 0
          ? Number(update.runnerTabId)
          : source.runnerTabId,
      heartbeatAt: text(update.heartbeatAt, 80) || source.heartbeatAt,
      startedAt: text(update.startedAt, 80) || source.startedAt,
      finishedAt: text(update.finishedAt, 80) || source.finishedAt,
      message: text(update.message, 1000) || source.message,
      error:
        update.error && typeof update.error === "object"
          ? update.error
          : update.error === null
            ? null
            : source.error,
      progress:
        update.progress && typeof update.progress === "object"
          ? update.progress
          : source.progress,
      targetResults,
      checkpoint,
      updatedAt,
    };
  }

  function isTerminalRunStatus(value) {
    return TERMINAL_STATUSES.has(text(value, 80));
  }

  root.OnStarvoiceCloudTargetedPost = Object.freeze({
    PROTOCOL_VERSION,
    WORKFLOW,
    OFFICIAL_ACCOUNT_COMMENT_WORKFLOW,
    MAX_TARGETS,
    isSupportedWorkflow,
    normalizePlatform,
    canonicalizeTargetUrl,
    normalizeCommandPayload,
    normalizeCaptureSettings,
    collectRecordExternalIds,
    buildTargetResult,
    buildCommentObservation,
    applySyncResult,
    normalizeTargetResults,
    buildCheckpoint,
    createRunRequest,
    mergeRunPatch,
    isTerminalRunStatus,
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
