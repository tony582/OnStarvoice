(function attachCloudTaskAgent(root) {
  "use strict";

  // A node bearer token must never be replayed across trust origins. Local
  // development can opt in by setting __ONSTARVOICE_API_BASE_URL__; production
  // uses only the production origin and does not fall back to localhost.
  const DEFAULT_API_BASE_URLS = [
    root.__ONSTARVOICE_API_BASE_URL__ || "https://voice.minilife.online",
  ]
    .map((value) => String(value || "").trim().replace(/\/$/, ""))
    .filter((value, index, values) => value && values.indexOf(value) === index);

  function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function text(value, limit = 1000) {
    const normalized = String(value == null ? "" : value).trim();
    return normalized.length > limit ? normalized.slice(0, limit) : normalized;
  }

  const SENSITIVE_KEY_PATTERN =
    /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|auth(?:entication)?[_-]?code|activation[_-]?code|credential|session)/i;

  function sanitizeText(value, limit = 1000) {
    return text(value, limit)
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
      .replace(
        /\b(authorization|cookie|password|passwd|secret|token|api[_-]?key|auth(?:entication)?[_-]?code|activation[_-]?code|credential|session)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
        "$1=[REDACTED]",
      );
  }

  function sanitizeStructuredValue(value, key = "", depth = 0) {
    const normalizedKey = String(key || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2");
    if (SENSITIVE_KEY_PATTERN.test(normalizedKey)) return "[REDACTED]";
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") return sanitizeText(value);
    if (depth >= 4) return sanitizeText(value);
    if (Array.isArray(value)) {
      return value
        .slice(0, 200)
        .map((item) => sanitizeStructuredValue(item, "", depth + 1));
    }
    if (!value || typeof value !== "object") return sanitizeText(value);
    const safe = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 80)) {
      const safeKey = text(childKey, 80);
      if (!safeKey) continue;
      safe[safeKey] = sanitizeStructuredValue(childValue, safeKey, depth + 1);
    }
    return safe;
  }

  function timestampMs(value) {
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function targetedPostTaskDescriptor(request = {}) {
    const source = objectValue(request);
    const workflow = text(source.workflow, 80);
    if (workflow === "official_account_comment_patrol") {
      return {
        workflow,
        taskType: "official_account_comment_patrol",
        featureKey: "official_account_comment_patrol",
        title: text(source.title, 500) || "官方账号评论巡查",
      };
    }
    if (workflow === "followed_creator_post_patrol") {
      return {
        workflow,
        taskType: "followed_creator_post_patrol",
        featureKey: "followed_creator_post_patrol",
        title: text(source.title, 500) || "关注博主作品扫描",
      };
    }
    if (workflow === "official_account_post_discovery") {
      return {
        workflow,
        taskType: "official_account_post_discovery",
        featureKey: "official_account_post_discovery",
        title: text(source.title, 500) || "官方账号作品发现",
      };
    }
    return {
      workflow: "negative_post_patrol",
      taskType: "negative_post_patrol",
      featureKey: "negative_post_patrol",
      title: text(source.title, 500) || "负面帖子定向巡查",
    };
  }

  function buildCaptureSettingsSnapshot(value) {
    const source = objectValue(value);
    if (Object.keys(source).length === 0) return {};
    const enhancementEnabled = source.autoDetailCaptureAfterListCapture === true;
    const includeComments =
      enhancementEnabled && source.includeCommentsOnDetailCapture === true;
    const includeBloggerMetrics =
      enhancementEnabled && source.includeBloggerMetricsOnDetailCapture === true;
    const commentLimit = Math.floor(Number(source.detailCommentsMaxDetectedItems));
    const lowFollowerThreshold = Math.floor(
      Number(source.lowFollowerHitThresholdOnDetailCapture),
    );
    return {
      autoDetailCaptureAfterListCapture: enhancementEnabled,
      autoSyncAfterDetailCapture:
        enhancementEnabled && source.autoSyncAfterDetailCapture === true,
      enableAiRelevancePrefilter:
        enhancementEnabled && source.enableAiRelevancePrefilter === true,
      includeBloggerMetricsOnDetailCapture: includeBloggerMetrics,
      enableLowFollowerHitFilterOnDetailCapture:
        includeBloggerMetrics &&
        source.enableLowFollowerHitFilterOnDetailCapture === true,
      lowFollowerHitThresholdOnDetailCapture:
        Number.isFinite(lowFollowerThreshold) && lowFollowerThreshold >= 0
          ? lowFollowerThreshold
          : 10000,
      includeCommentsOnDetailCapture: includeComments,
      detailCommentsMaxDetectedItems:
        Number.isFinite(commentLimit) && commentLimit > 0 ? commentLimit : 50,
      enableCommentLeadsFilterOnDetailCapture:
        includeComments &&
        source.enableCommentLeadsFilterOnDetailCapture === true,
      skipAlreadyCapturedOnDetailCapture:
        enhancementEnabled &&
        source.skipAlreadyCapturedOnDetailCapture !== false,
    };
  }

  function buildUnattendedPlanSnapshot(plan = {}) {
    const source = objectValue(plan);
    const keywords = (Array.isArray(source.keywords) ? source.keywords : [])
      .map((keyword) => text(keyword, 120))
      .filter(Boolean)
      .slice(0, 30);
    const searchFilters = objectValue(source.searchFilters);
    const rawCaptureSettings = source.captureSettings;
    const hasCaptureSettings =
      rawCaptureSettings &&
      typeof rawCaptureSettings === "object" &&
      !Array.isArray(rawCaptureSettings) &&
      Object.keys(rawCaptureSettings).length > 0;
    const updatedAt = text(source.updatedAt, 80);
    const rawKeywordMaxDetectedItems = Number(
      source.keywordMaxDetectedItems,
    );
    const hasKeywordMaxDetectedItems =
      Object.prototype.hasOwnProperty.call(
        source,
        "keywordMaxDetectedItems",
      ) &&
      Number.isSafeInteger(rawKeywordMaxDetectedItems) &&
      rawKeywordMaxDetectedItems > 0;
    return {
      configured: Boolean(updatedAt || source.enabled || keywords.length > 0),
      enabled: source.enabled === true,
      platform: text(source.platform || "xiaohongshu", 60),
      mode: text(source.mode || "daily", 40),
      startTime: text(source.startTime || "09:00", 20),
      randomOffsetMin: Math.max(0, Number(source.randomOffsetMin) || 0),
      keywords,
      searchFilters: sanitizeStructuredValue(searchFilters),
      ...(hasKeywordMaxDetectedItems
        ? {keywordMaxDetectedItems: rawKeywordMaxDetectedItems}
        : {}),
      ...(hasCaptureSettings
        ? {captureSettings: buildCaptureSettingsSnapshot(rawCaptureSettings)}
        : {}),
      autoLoop: source.autoLoop === true,
      roundGapMin: Math.max(0, Number(source.roundGapMin) || 0),
      maxRounds: Math.max(1, Number(source.maxRounds) || 1),
      customDates: sanitizeText(source.customDates, 2000),
      nextRunAt: text(source.nextRunAt, 80),
      lastRunAt: text(source.lastRunAt, 80),
      lastRunStatus: text(source.lastRunStatus, 80),
      lastRunMessage: sanitizeText(source.lastRunMessage, 1000),
      updatedAt,
    };
  }

  function buildTaskSnapshot(run, controlRequestId = "") {
    const source = objectValue(run);
    const id = text(source.id, 240);
    if (!id) return null;
    const metadata = objectValue(source.metadata);
    const isCurrentControlRequest =
      controlRequestId &&
      (id === controlRequestId || text(metadata.controlTaskId, 240) === controlRequestId);
    return {
      id,
      controlTaskId: isCurrentControlRequest
        ? controlRequestId
        : text(metadata.controlTaskId || source.controlTaskId || source.actionTaskId, 240),
      taskType: text(source.taskType || source.type || "capture", 120),
      featureKey: text(source.featureKey, 120),
      title: text(source.title || source.name || "采集任务", 240),
      platform: text(source.platform || "unknown", 60),
      source: text(source.source || "extension", 80),
      trigger: text(source.trigger, 80),
      status: text(source.status || "pending", 80),
      progress: sanitizeStructuredValue(objectValue(source.progress)),
      checkpoint: sanitizeStructuredValue(objectValue(source.checkpoint)),
      workflow: text(source.workflow, 80),
      protocolVersion: Math.max(0, Number(source.protocolVersion) || 0),
      targetResults: (Array.isArray(source.targetResults)
        ? source.targetResults
        : []
      )
        .slice(0, 100)
        .map((result) => sanitizeStructuredValue(objectValue(result))),
      counts: sanitizeStructuredValue(objectValue(source.counts)),
      metadata: sanitizeStructuredValue(metadata),
      error: sanitizeStructuredValue(objectValue(source.error)),
      message: sanitizeText(source.message, 2000),
      attemptId: text(source.attemptId, 240),
      attemptNumber: Math.max(0, Number(source.attemptNumber) || 0),
      progressSeq: Math.max(0, Number(source.progressSeq) || 0),
      heartbeatAt: text(source.heartbeatAt, 80),
      businessProgressAt: text(source.businessProgressAt, 80),
      startedAt: text(source.startedAt, 80),
      finishedAt: text(source.finishedAt, 80),
      createdAt: text(source.createdAt, 80),
      updatedAt: text(source.updatedAt, 80),
    };
  }

  function buildObservedSocialAccountSnapshot(value) {
    const source = objectValue(value);
    const platform = text(source.platform, 40).toLowerCase();
    if (!["xiaohongshu", "douyin", "weibo"].includes(platform)) return null;
    const loginState = text(source.loginState, 40);
    return {
      platform,
      platformAccountId: text(source.platformAccountId, 240),
      accountHandle: text(source.accountHandle, 160),
      displayName: text(source.displayName, 160),
      avatarUrl: text(source.avatarUrl, 1000),
      loginState: ["authenticated", "logged_out", "unknown"].includes(loginState)
        ? loginState
        : "unknown",
      confidence: text(source.confidence || "unknown", 40),
      sourceUrl: text(source.sourceUrl, 1000),
      observedAt: text(source.observedAt, 80),
    };
  }

  function buildSocialUsageEventSnapshot(value) {
    const source = objectValue(value);
    const eventId = text(source.eventId || source.id, 240);
    const platform = text(source.platform, 40).toLowerCase();
    if (
      !eventId ||
      !["xiaohongshu", "douyin", "weibo"].includes(platform)
    ) {
      return null;
    }
    const count = (candidate, maximum = 100000) => {
      const parsed = Math.floor(Number(candidate));
      if (!Number.isFinite(parsed) || parsed <= 0) return 0;
      return Math.min(maximum, parsed);
    };
    const identity = objectValue(source.accountIdentity);
    const reservedIdentityTokens = new Set([
      "self",
      "me",
      "my",
      "profile",
      "home",
      "login",
      "undefined",
      "null",
    ]);
    const identityToken = (candidate, limit) => {
      const normalized = text(candidate, limit);
      return reservedIdentityTokens.has(
        normalized.toLowerCase().replace(/^@/u, ""),
      )
        ? ""
        : normalized;
    };
    const platformAccountId = identityToken(
      identity.platformAccountId,
      240,
    );
    const accountHandle = identityToken(identity.accountHandle, 160);
    const accountIdentity = platformAccountId || accountHandle
      ? {
          platformAccountId,
          accountHandle,
          displayName: text(identity.displayName, 160),
          confidence: text(identity.confidence, 40) || "unknown",
          observedAt: text(identity.observedAt, 80),
        }
      : null;
    const snapshot = {
      eventId,
      platform,
      searches: count(source.searches, 10000),
      enhancements: count(source.enhancements, 10000),
      captureRuns: count(source.captureRuns, 10000),
      capturedItems: count(source.capturedItems),
      succeeded: source.succeeded !== false,
      occurredAt: text(source.occurredAt, 80),
      accountIdentity,
      metadata: sanitizeStructuredValue(objectValue(source.metadata)),
    };
    if (
      snapshot.searches +
        snapshot.enhancements +
        snapshot.captureRuns +
        snapshot.capturedItems ===
      0
    ) {
      return null;
    }
    return snapshot;
  }

  function buildHeartbeatPayload({
    runtime = {},
    ledger = {},
    unattendedRequest = null,
    targetedPostRequest = null,
    unattendedPlan = null,
    observedSocialAccounts = [],
    socialUsageEvents = [],
    reason = "heartbeat",
    lastError = "",
  } = {}) {
    const safeRuntime = objectValue(runtime);
    const safeLedger = objectValue(ledger);
    const request = objectValue(unattendedRequest);
    const controlRequestId = text(request.id || request.requestId, 240);
    const runs = Array.isArray(safeLedger.runs) ? safeLedger.runs : [];
    const tasks = runs
      .slice()
      .sort((left, right) => {
        const leftTime = timestampMs(left?.updatedAt || left?.heartbeatAt || left?.createdAt);
        const rightTime = timestampMs(right?.updatedAt || right?.heartbeatAt || right?.createdAt);
        return rightTime - leftTime;
      })
      .slice(0, 50)
      .map((run) => buildTaskSnapshot(run, controlRequestId))
      .filter(Boolean);
    const targetedRequest = objectValue(targetedPostRequest);
    const targetedDescriptor = targetedPostTaskDescriptor(targetedRequest);
    const targetedSnapshot = buildTaskSnapshot(
      {
        ...targetedRequest,
        workflow: targetedDescriptor.workflow,
        taskType: targetedDescriptor.taskType,
        featureKey: targetedDescriptor.featureKey,
        title: targetedDescriptor.title,
        source: "cloud_assignment",
        trigger: "remote",
        metadata: {
          ...objectValue(targetedRequest.metadata),
          taskId: text(targetedRequest.taskId, 240),
          cloudCommandId: text(targetedRequest.cloudCommandId, 240),
        },
      },
      text(targetedRequest.id, 240),
    );
    if (
      targetedSnapshot &&
      !tasks.some((task) => task.id === targetedSnapshot.id)
    ) {
      tasks.unshift(targetedSnapshot);
    }

    return {
      agent: {
        clientUuid: text(safeRuntime.clientUuid, 240),
        clientLabel: text(safeRuntime.clientLabel, 240),
        appVersion: text(safeRuntime.appVersion, 80),
        capabilities: {
          parallelSlots: 1,
          supportedPlatforms: ["xiaohongshu", "douyin", "weibo"],
          remoteResume: true,
          remoteTaskCreate: true,
          remoteStop: true,
          remoteUnattendedPlanWrite: true,
          remoteUnattendedPlanDelete: true,
          remoteTaskEnhancementOptions: true,
          remoteTaskKeywordPostLimit: true,
          negativePostPatrol: true,
          officialAccountCommentPatrol: true,
          followedCreatorPostPatrol: true,
          officialAccountPostDiscovery: true,
          remoteTargetedPostCaptureV1: true,
          unattendedPlanMirror: true,
          localExecutionLock: true,
          socialAccountIdentity: true,
          socialAccountDailyUsage: true,
          taskLedgerVersion: Number(safeLedger.version || 1) || 1,
        },
        lastError: sanitizeText(lastError, 1000),
      },
      unattendedPlan: buildUnattendedPlanSnapshot(unattendedPlan),
      tasks,
      observedSocialAccounts: (
        Array.isArray(observedSocialAccounts) ? observedSocialAccounts : []
      )
        .slice(0, 10)
        .map(buildObservedSocialAccountSnapshot)
        .filter(Boolean),
      socialUsageEvents: (
        Array.isArray(socialUsageEvents) ? socialUsageEvents : []
      )
        .slice(0, 200)
        .map(buildSocialUsageEventSnapshot)
        .filter(Boolean),
      reason: text(reason, 120),
      sentAt: new Date().toISOString(),
    };
  }

  async function requestJson({
    token,
    endpoint,
    body,
    fetchImpl = root.fetch,
    baseUrls = DEFAULT_API_BASE_URLS,
    timeoutMs = 15000,
  }) {
    const agentToken = text(token, 512);
    if (!agentToken) return {ok: false, skipped: true, reason: "missing_agent_token"};
    if (typeof fetchImpl !== "function") {
      return {ok: false, skipped: true, reason: "fetch_unavailable"};
    }

    const candidates = (Array.isArray(baseUrls) ? baseUrls : [])
      .map((value) => text(value, 1000).replace(/\/$/, ""))
      .filter(Boolean);
    let trustedOrigin = "";
    try {
      trustedOrigin = new URL(candidates[0]).origin;
    } catch {
      return {ok: false, skipped: true, reason: "invalid_api_origin"};
    }
    const trustedBaseUrls = candidates.filter((baseUrl) => {
      try {
        return new URL(baseUrl).origin === trustedOrigin;
      } catch {
        return false;
      }
    });

    let lastError = null;
    for (const baseUrl of trustedBaseUrls) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}${endpoint}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${agentToken}`,
          },
          body: JSON.stringify(body || {}),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        if (response.status === 404) {
          lastError = {ok: false, reason: "endpoint_missing", status: 404};
          continue;
        }
        if (!response.ok || !data?.ok) {
          return {
            ok: false,
            status: response.status,
            reason: data?.error || data?.reason || "request_failed",
            message: data?.message || "云端任务中心请求失败",
          };
        }
        return data;
      } catch (error) {
        lastError = {
          ok: false,
          reason: error?.name === "AbortError" ? "timeout" : "network_error",
          message: error?.message || "network error",
        };
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return lastError || {ok: false, reason: "cloud_unavailable"};
  }

  async function sendHeartbeat(options = {}) {
    return await requestJson({
      ...options,
      endpoint: "/api/capture-cloud/agent/heartbeat",
    });
  }

  async function completeCommand({commandId, success, result = {}, ...options}) {
    const normalizedCommandId = text(commandId, 240);
    if (!normalizedCommandId) {
      return {ok: false, skipped: true, reason: "missing_command_id"};
    }
    return await requestJson({
      ...options,
      endpoint: `/api/capture-cloud/agent/commands/${encodeURIComponent(normalizedCommandId)}/complete`,
      body: {success: success === true, result: objectValue(result)},
    });
  }

  root.OnStarvoiceCloudTaskAgent = Object.freeze({
    buildTaskSnapshot,
    buildUnattendedPlanSnapshot,
    buildObservedSocialAccountSnapshot,
    buildSocialUsageEventSnapshot,
    buildHeartbeatPayload,
    requestJson,
    sendHeartbeat,
    completeCommand,
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
