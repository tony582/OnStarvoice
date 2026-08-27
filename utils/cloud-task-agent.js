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
  const SENSITIVE_HEALTH_VALUE_PATTERN =
    /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|apikey|auth(?:entication)?[_-]?code|activation[_-]?code|credential|session|bearer)/iu;
  const JWT_LIKE_PATTERN =
    /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/u;
  const UUID_LIKE_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const LONG_OPAQUE_HEALTH_SEGMENT_PATTERN =
    /(?:^|[._:-])[A-Za-z0-9]{32,}(?:$|[._:-])/u;
  const AWS_ACCESS_KEY_ID_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u;

  function sanitizeText(value, limit = 1000) {
    return text(value, limit)
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[CREDENTIAL_REDACTED]")
      .replace(
        /\b(authorization|cookie|password|passwd|secret|token|api[_-]?key|auth(?:entication)?[_-]?code|activation[_-]?code|credential|session)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
        "$1=[REDACTED]",
      );
  }

  function sanitizeStructuredValue(value, key = "", depth = 0) {
    const normalizedKey = String(key || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
    // These are closure-state booleans, not session identifiers. Preserve the
    // exact false values so the server can fail-closed verify local teardown.
    const isLocalClosureSessionFlag =
      (normalizedKey === "debug_session_present" ||
        normalizedKey === "task_session_present") &&
      typeof value === "boolean";
    if (SENSITIVE_KEY_PATTERN.test(normalizedKey) && !isLocalClosureSessionFlag) {
      return "[REDACTED]";
    }
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

  const TASK_HEALTH_EVIDENCE_VERSION = 1;
  const MAX_HEALTH_LATENCY_MS = 2 * 60 * 1000;
  const MAX_HEALTH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_HEALTH_COUNTER = 1000000;
  const RUNTIME_HEALTH_SAMPLE_CACHE_MS = 10 * 1000;
  const RUNTIME_HEALTH_SAMPLE_COUNT = 2;
  const RUNTIME_HEALTH_SAMPLE_DELAY_MS = 8;
  const MAX_HEALTH_TAB_PROBES = 8;
  const cloudTaskAgentLoadedAt = Date.now();
  const taskHealthHints = new WeakMap();
  let lastCloudRequestObservation = null;
  let cachedRuntimeHealthSample = null;
  let runtimeHealthSampleInFlight = null;

  function boundedNumber(value, {
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER,
    decimals = 0,
  } = {}) {
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      typeof value === "boolean"
    ) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    const bounded = Math.min(maximum, Math.max(minimum, parsed));
    const factor = 10 ** Math.max(0, Math.min(3, decimals));
    return Math.round(bounded * factor) / factor;
  }

  function timestampValue(value) {
    if (Number.isFinite(Number(value)) && Number(value) > 1000000000000) {
      return Number(value);
    }
    return timestampMs(value);
  }

  function isoTimestamp(value) {
    const timestamp = timestampValue(value);
    return timestamp > 0 ? new Date(timestamp).toISOString() : "";
  }

  function ageMs(value, now = Date.now()) {
    const timestamp = timestampValue(value);
    if (timestamp <= 0) return null;
    return boundedNumber(now - timestamp, {
      minimum: 0,
      maximum: MAX_HEALTH_AGE_MS,
    });
  }

  // Health evidence accepts code-like values only. Human copy, URLs and page
  // text are deliberately excluded from this channel even when they exist in
  // the local task ledger.
  function looksSensitiveHealthValue(value) {
    const raw = String(value || "").trim();
    if (!raw) return false;
    if (
      SENSITIVE_HEALTH_VALUE_PATTERN.test(raw) ||
      JWT_LIKE_PATTERN.test(raw) ||
      UUID_LIKE_PATTERN.test(raw) ||
      LONG_OPAQUE_HEALTH_SEGMENT_PATTERN.test(raw) ||
      AWS_ACCESS_KEY_ID_PATTERN.test(raw)
    ) return true;
    const compact = raw.replace(/[._:-]/gu, "");
    return (
      compact.length >= 32 &&
      /^[A-Za-z0-9+/_-]+$/u.test(compact) &&
      /[a-z]/u.test(compact) &&
      /[A-Z]/u.test(compact) &&
      /\d/u.test(compact)
    );
  }

  function healthCode(value, limit = 80, fallback = "unknown") {
    const raw = text(value, Math.max(limit * 4, 320));
    if (!raw) return fallback;
    if (
      /(?:https?:\/\/|www\.|[/?#&=@])/iu.test(raw) ||
      looksSensitiveHealthValue(raw)
    ) return fallback;
    const normalized = raw.slice(0, limit);
    if (!/^[A-Za-z0-9_.:-]+$/u.test(normalized)) return fallback;
    return normalized.toLowerCase();
  }

  function optionalHealthCode(value, limit = 80) {
    const normalized = healthCode(value, limit, "");
    return normalized || "";
  }

  function healthVersion(value) {
    const raw = text(value, 80);
    if (!raw || looksSensitiveHealthValue(raw)) return "";
    return /^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]{1,32})?$/u.test(raw)
      ? raw
      : "";
  }

  function booleanOrNull(value) {
    return typeof value === "boolean" ? value : null;
  }

  function positiveTabId(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed));
  }

  function requestEndpointClass(endpoint = "") {
    const normalized = String(endpoint || "");
    if (normalized.endsWith("/heartbeat")) return "heartbeat";
    if (normalized.endsWith("/liveness")) return "liveness";
    if (normalized.includes("/commands/") && normalized.endsWith("/complete")) {
      return "command_complete";
    }
    return "cloud_api";
  }

  function rememberCloudRequestObservation({
    endpoint = "",
    startedAt = 0,
    outcome = "unknown",
    status = null,
  } = {}) {
    const completedAt = Date.now();
    lastCloudRequestObservation = {
      observedAt: new Date(completedAt).toISOString(),
      endpointClass: requestEndpointClass(endpoint),
      outcome: healthCode(outcome, 40),
      latencyMs: boundedNumber(completedAt - Number(startedAt || completedAt), {
        minimum: 0,
        maximum: MAX_HEALTH_LATENCY_MS,
      }),
      httpStatus: boundedNumber(status, {minimum: 100, maximum: 599}),
    };
    return lastCloudRequestObservation;
  }

  function buildProgressObservation(source = {}, now = Date.now()) {
    const run = objectValue(source);
    const progress = objectValue(run.progress);
    const current = boundedNumber(progress.current, {
      minimum: 0,
      maximum: MAX_HEALTH_COUNTER,
    });
    const total = boundedNumber(progress.total, {
      minimum: 0,
      maximum: MAX_HEALTH_COUNTER,
    });
    const sequence = boundedNumber(run.progressSeq, {
      minimum: 0,
      maximum: MAX_HEALTH_COUNTER,
    }) || 0;
    const observed = Boolean(
      run.businessProgressAt ||
        progress.updatedAt ||
        sequence > 0 ||
        (current !== null && current > 0),
    );
    const observedAt = observed
      ? isoTimestamp(run.businessProgressAt || progress.updatedAt)
      : "";
    return {
      observed,
      sequence,
      current: current ?? 0,
      total: total ?? 0,
      observedAt,
      ageMs: ageMs(observedAt, now),
    };
  }

  function healthSource(source = {}, runtime = {}) {
    const run = objectValue(source);
    const metadata = objectValue(run.metadata);
    const runtimeSource = objectValue(runtime);
    const runtimeHealth = objectValue(
      runtimeSource.healthEvidence ||
        runtimeSource.runtimeHealth ||
        runtimeSource.health,
    );
    const taskHealth = objectValue(
      run.healthEvidence || run.runtimeHealth || metadata.healthEvidence,
    );
    return {
      page: {
        ...objectValue(runtimeHealth.page),
        ...objectValue(taskHealth.page),
      },
      network: {
        ...objectValue(runtimeHealth.network),
        ...objectValue(taskHealth.network),
      },
      runtime: {
        ...objectValue(runtimeHealth.runtime),
        ...objectValue(taskHealth.runtime),
      },
    };
  }

  function buildTaskHealthEvidence(
    source = {},
    runtime = {},
    {now = Date.now(), networkObservation = lastCloudRequestObservation} = {},
  ) {
    const run = objectValue(source);
    const progress = objectValue(run.progress);
    const checkpoint = objectValue(run.checkpoint);
    const metadata = objectValue(run.metadata);
    const runtimeSource = objectValue(runtime);
    const supplied = healthSource(run, runtimeSource);
    const suppliedPage = objectValue(supplied.page);
    const suppliedNetwork = objectValue(supplied.network);
    const suppliedRuntime = objectValue(supplied.runtime);
    const observedNetwork = objectValue(networkObservation);
    const taskPlatform = healthCode(run.platform, 40);
    const runtimePlatform = healthCode(
      runtimeSource.platform || suppliedPage.platform,
      40,
    );
    const platformMatchesTask =
      taskPlatform === "unknown" || runtimePlatform === "unknown"
        ? null
        : taskPlatform === runtimePlatform;
    const tabStatus = optionalHealthCode(
      suppliedPage.tabStatus || suppliedPage.status,
      30,
    );
    const phase = healthCode(
      progress.phase || run.phase || checkpoint.phase || metadata.phase,
      80,
    );
    const stage = healthCode(
      run.stage || progress.stage || checkpoint.stage || metadata.stage || phase,
      80,
    );
    const requestLatency = boundedNumber(
      suppliedNetwork.lastRequestLatencyMs ??
        suppliedNetwork.apiRttMs ??
        suppliedNetwork.latencyMs ??
        observedNetwork.latencyMs,
      {minimum: 0, maximum: MAX_HEALTH_LATENCY_MS},
    );

    return {
      version: TASK_HEALTH_EVIDENCE_VERSION,
      stage,
      phase,
      progressObserved: buildProgressObservation(run, now),
      page: {
        platform: runtimePlatform,
        pageType: healthCode(
          runtimeSource.pageType || suppliedPage.pageType,
          60,
        ),
        platformMatchesTask,
        detailReady:
          platformMatchesTask === false
            ? null
            : booleanOrNull(
                typeof runtimeSource.detailReady === "boolean"
                  ? runtimeSource.detailReady
                  : suppliedPage.detailReady,
              ),
        detailReadyReason: optionalHealthCode(
          runtimeSource.detailReadyReason || suppliedPage.detailReadyReason,
          80,
        ),
        tabStatus: tabStatus || "unavailable",
        discarded: booleanOrNull(suppliedPage.discarded),
        frozen: booleanOrNull(suppliedPage.frozen),
      },
      network: {
        available: requestLatency !== null,
        status: healthCode(
          suppliedNetwork.status || observedNetwork.outcome,
          40,
          requestLatency === null ? "unavailable" : "unknown",
        ),
        lastRequestLatencyMs: requestLatency,
        lastRequestAt: isoTimestamp(
          suppliedNetwork.observedAt || observedNetwork.observedAt,
        ),
        endpointClass: optionalHealthCode(observedNetwork.endpointClass, 40),
        timeoutCount:
          boundedNumber(suppliedNetwork.timeoutCount, {
            minimum: 0,
            maximum: MAX_HEALTH_COUNTER,
          }) ?? 0,
      },
      runtime: {
        stateAgeMs: ageMs(runtimeSource.lastUpdatedAt, now),
        captureProgressAgeMs: ageMs(
          runtimeSource.lastCaptureProgressAt,
          now,
        ),
        eventLoopLagMs: boundedNumber(suppliedRuntime.eventLoopLagMs, {
          minimum: 0,
          maximum: MAX_HEALTH_LATENCY_MS,
          decimals: 1,
        }),
        heapUsedMb: boundedNumber(suppliedRuntime.heapUsedMb, {
          minimum: 0,
          maximum: 1024 * 1024,
          decimals: 1,
        }),
        heapLimitMb: boundedNumber(suppliedRuntime.heapLimitMb, {
          minimum: 0,
          maximum: 1024 * 1024,
          decimals: 1,
        }),
        serviceWorkerRestartCount:
          boundedNumber(suppliedRuntime.serviceWorkerRestartCount, {
            minimum: 0,
            maximum: MAX_HEALTH_COUNTER,
          }) ?? null,
      },
    };
  }

  function monotonicNow() {
    try {
      if (typeof root.performance?.now === "function") {
        return root.performance.now();
      }
    } catch {
      // Wall-clock fallback remains sufficient for a bounded lag proxy.
    }
    return Date.now();
  }

  function readHeapHealthSample() {
    try {
      const memory = root.performance?.memory;
      if (!memory || typeof memory !== "object") {
        return {
          available: false,
          usedMb: null,
          totalMb: null,
          limitMb: null,
        };
      }
      const bytesToMb = (value) => {
        const bytes = boundedNumber(value, {
          minimum: 0,
          maximum: 1024 * 1024 * 1024 * 1024,
        });
        return bytes === null
          ? null
          : boundedNumber(bytes / (1024 * 1024), {
              minimum: 0,
              maximum: 1024 * 1024,
              decimals: 1,
            });
      };
      const usedMb = bytesToMb(memory.usedJSHeapSize);
      const totalMb = bytesToMb(memory.totalJSHeapSize);
      const limitMb = bytesToMb(memory.jsHeapSizeLimit);
      return {
        available: usedMb !== null || totalMb !== null || limitMb !== null,
        usedMb,
        totalMb,
        limitMb,
      };
    } catch {
      return {
        available: false,
        usedMb: null,
        totalMb: null,
        limitMb: null,
      };
    }
  }

  async function sampleCloudRuntimeHealth() {
    const lags = [];
    if (typeof setTimeout === "function") {
      for (let index = 0; index < RUNTIME_HEALTH_SAMPLE_COUNT; index += 1) {
        const startedAt = monotonicNow();
        await new Promise((resolve) =>
          setTimeout(resolve, RUNTIME_HEALTH_SAMPLE_DELAY_MS),
        );
        lags.push(
          Math.max(
            0,
            monotonicNow() - startedAt - RUNTIME_HEALTH_SAMPLE_DELAY_MS,
          ),
        );
      }
    }
    const sampledAtMs = Date.now();
    const heap = readHeapHealthSample();
    return {
      sampledAtMs,
      sampledAt: new Date(sampledAtMs).toISOString(),
      cpuAvailable: false,
      eventLoopAvailable: lags.length > 0,
      eventLoopSampleCount: lags.length,
      eventLoopLagMs:
        lags.length > 0
          ? boundedNumber(Math.max(...lags), {
              minimum: 0,
              maximum: MAX_HEALTH_LATENCY_MS,
              decimals: 1,
            })
          : null,
      heapAvailable: heap.available,
      heapUsedMb: heap.usedMb,
      heapTotalMb: heap.totalMb,
      heapLimitMb: heap.limitMb,
      serviceWorkerAgeMs: boundedNumber(
        sampledAtMs - cloudTaskAgentLoadedAt,
        {minimum: 0, maximum: MAX_HEALTH_AGE_MS},
      ),
    };
  }

  async function cachedCloudRuntimeHealth() {
    const now = Date.now();
    if (
      cachedRuntimeHealthSample &&
      now - Number(cachedRuntimeHealthSample.sampledAtMs || 0) <
        RUNTIME_HEALTH_SAMPLE_CACHE_MS
    ) {
      return cachedRuntimeHealthSample;
    }
    if (runtimeHealthSampleInFlight) return await runtimeHealthSampleInFlight;
    runtimeHealthSampleInFlight = sampleCloudRuntimeHealth();
    try {
      cachedRuntimeHealthSample = await runtimeHealthSampleInFlight;
      return cachedRuntimeHealthSample;
    } finally {
      runtimeHealthSampleInFlight = null;
    }
  }

  async function readTaskTabHealth(tabId) {
    const normalizedTabId = positiveTabId(tabId);
    if (normalizedTabId === null) {
      return {
        status: "untracked",
        discarded: null,
        frozen: null,
      };
    }
    const tabsApi = root.chrome?.tabs;
    if (!tabsApi || typeof tabsApi.get !== "function") {
      return {
        status: "unavailable",
        discarded: null,
        frozen: null,
      };
    }
    try {
      const tab = await tabsApi.get(normalizedTabId);
      return {
        status: healthCode(tab?.status, 30, "unknown"),
        discarded: booleanOrNull(tab?.discarded),
        frozen: booleanOrNull(tab?.frozen),
      };
    } catch {
      return {status: "missing", discarded: null, frozen: null};
    }
  }

  async function enrichHeartbeatHealthEvidence(body = {}) {
    const payload = objectValue(body);
    const tasks = Array.isArray(payload.tasks) ? payload.tasks.slice(0, 50) : [];
    const liveTasks = tasks.filter(
      (task) => taskHealthHints.get(task)?.liveEvidence === true,
    );
    if (liveTasks.length === 0) return payload;

    const runtimeSample = await cachedCloudRuntimeHealth();
    const tabIds = [];
    for (const task of liveTasks) {
      const hint = taskHealthHints.get(task);
      const tabId = positiveTabId(hint?.tabId);
      if (
        tabId !== null &&
        !tabIds.includes(tabId) &&
        tabIds.length < MAX_HEALTH_TAB_PROBES
      ) {
        tabIds.push(tabId);
      }
    }
    const tabHealthById = new Map(
      await Promise.all(
        tabIds.map(async (tabId) => [tabId, await readTaskTabHealth(tabId)]),
      ),
    );

    for (const task of liveTasks) {
      if (!task || typeof task !== "object" || Array.isArray(task)) continue;
      const hint = taskHealthHints.get(task);
      const tabId = positiveTabId(hint?.tabId);
      const tabHealth =
        tabId === null
          ? {status: "untracked", discarded: null, frozen: null}
          : tabHealthById.get(tabId) || {
              status: "probe_limit",
              discarded: null,
              frozen: null,
            };
      const existing = objectValue(task.healthEvidence);
      task.healthEvidence = {
        ...existing,
        sampledAt: runtimeSample.sampledAt,
        page: {
          ...objectValue(existing.page),
          tabStatus: tabHealth.status,
          discarded: tabHealth.discarded,
          frozen: tabHealth.frozen,
        },
        runtime: {
          ...objectValue(existing.runtime),
          sampledAt: runtimeSample.sampledAt,
          cpuAvailable: runtimeSample.cpuAvailable,
          eventLoopAvailable: runtimeSample.eventLoopAvailable,
          eventLoopSampleCount: runtimeSample.eventLoopSampleCount,
          eventLoopLagMs: runtimeSample.eventLoopLagMs,
          heapAvailable: runtimeSample.heapAvailable,
          heapUsedMb: runtimeSample.heapUsedMb,
          heapTotalMb: runtimeSample.heapTotalMb,
          heapLimitMb: runtimeSample.heapLimitMb,
          serviceWorkerAgeMs: runtimeSample.serviceWorkerAgeMs,
        },
      };
    }
    return payload;
  }

  function timestampMs(value) {
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  const TARGETED_TASK_TYPES = new Set([
    "negative_post_patrol",
    "watched_content_patrol",
    "official_account_comment_patrol",
    "followed_creator_post_patrol",
    "official_account_post_discovery",
  ]);
  const LIVE_TASK_HEALTH_STATUSES = new Set([
    "pending",
    "waiting_device",
    "claimed",
    "running",
    "recovering",
    "resume_requested",
    "stop_requested",
  ]);

  // Targeted runs keep attempt-scoped physical IDs in the local task ledger.
  // Cloud reconciliation must use the original business request ID, otherwise
  // the ledger row is mirrored as a second task beside the cloud-created row.
  function taskSnapshotIdentity(run = {}) {
    const source = objectValue(run);
    const metadata = objectValue(source.metadata);
    const physicalId = text(source.id, 240);
    const taskType = text(
      source.workflow || metadata.workflow || source.taskType || source.type,
      120,
    );
    let attemptId = text(source.attemptId || metadata.attemptId, 240);
    let logicalRequestId = text(
      source.logicalRequestId || metadata.logicalRequestId,
      240,
    );

    if (TARGETED_TASK_TYPES.has(taskType)) {
      if (!attemptId && logicalRequestId) {
        const prefix = `${logicalRequestId}::`;
        if (physicalId.startsWith(prefix)) {
          attemptId = text(physicalId.slice(prefix.length), 240);
        }
      }
      if (!logicalRequestId && attemptId) {
        const suffix = `::${attemptId}`;
        if (physicalId.endsWith(suffix)) {
          logicalRequestId = text(
            physicalId.slice(0, physicalId.length - suffix.length),
            240,
          );
        }
      }
    }

    const canonicalId =
      TARGETED_TASK_TYPES.has(taskType) &&
      logicalRequestId &&
      attemptId &&
      physicalId === `${logicalRequestId}::${attemptId}`
        ? logicalRequestId
        : physicalId;
    return {id: canonicalId, attemptId};
  }

  function isSameTaskAttempt(left, right) {
    const leftId = text(left?.id, 240);
    const rightId = text(right?.id, 240);
    if (!leftId || leftId !== rightId) return false;
    const leftAttemptId = text(left?.attemptId, 240);
    const rightAttemptId = text(right?.attemptId, 240);
    // Legacy compact rows did not always retain an attempt ID. When one side is
    // the authoritative live request, the shared business ID is the only safe
    // reconciliation key; two explicit, different attempts remain distinct.
    return (
      !leftAttemptId ||
      !rightAttemptId ||
      leftAttemptId === rightAttemptId
    );
  }

  function targetedPostTaskDescriptor(request = {}) {
    const source = objectValue(request);
    const workflow = text(source.workflow, 80);
    if (workflow === "watched_content_patrol") {
      return {
        workflow,
        taskType: "watched_content_patrol",
        featureKey: "watched_content_patrol",
        title: text(source.title, 500) || "关注内容巡查",
      };
    }
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
    const searchPasses = (Array.isArray(source.searchPasses)
      ? source.searchPasses
      : [])
      .map((value) => text(value, 20).toLowerCase())
      .filter((value, index, values) =>
        ["all", "image", "video"].includes(value) &&
        values.indexOf(value) === index,
      )
      .slice(0, 2);
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
      ...(searchPasses.length > 1 ? {searchPasses} : {}),
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

  function buildTaskSnapshot(
    run,
    controlRequestId = "",
    runtime = {},
    healthOptions = {},
  ) {
    const source = objectValue(run);
    const identity = taskSnapshotIdentity(source);
    const id = identity.id;
    if (!id) return null;
    const metadata = objectValue(source.metadata);
    const safeRuntime = objectValue(runtime);
    const taskStatus = text(source.status || "pending", 40).toLowerCase();
    const canUseLiveHealth =
      LIVE_TASK_HEALTH_STATUSES.has(taskStatus) &&
      healthOptions.allowLiveHealth !== false;
    const attemptRuntime = canUseLiveHealth ? safeRuntime : {};
    const healthEvidence = buildTaskHealthEvidence(
      source,
      attemptRuntime,
      canUseLiveHealth
        ? healthOptions
        : {...objectValue(healthOptions), networkObservation: null},
    );
    const isCurrentControlRequest =
      controlRequestId &&
      (id === controlRequestId || text(metadata.controlTaskId, 240) === controlRequestId);
    const localClosure = objectValue(metadata.localClosure);
    const localClosures = (Array.isArray(metadata.localClosures)
      ? metadata.localClosures
      : [])
      .slice(0, 30)
      .map((entry) => sanitizeStructuredValue(objectValue(entry)));
    const snapshot = {
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
      targetMode: text(source.targetMode, 40),
      profileMode: source.profileMode === true,
      subjectType: text(source.subjectType, 40),
      targets: (Array.isArray(source.targets) ? source.targets : [])
        .slice(0, 100)
        .map((target) => sanitizeStructuredValue(objectValue(target))),
      monitorSettings: sanitizeStructuredValue(
        objectValue(source.monitorSettings),
      ),
      captureSettings: sanitizeStructuredValue(
        objectValue(source.captureSettings),
      ),
      targetResults: (Array.isArray(source.targetResults)
        ? source.targetResults
        : []
      )
        .slice(0, 100)
        .map((result) => sanitizeStructuredValue(objectValue(result))),
      counts: sanitizeStructuredValue(objectValue(source.counts)),
      metadata: sanitizeStructuredValue(metadata),
      ...(Object.keys(localClosure).length > 0
        ? {localClosure: sanitizeStructuredValue(localClosure)}
        : {}),
      ...(localClosures.length > 0 ? {localClosures} : {}),
      error: sanitizeStructuredValue(objectValue(source.error)),
      message: sanitizeText(source.message, 2000),
      appVersion: healthVersion(
        source.appVersion ||
          metadata.appVersion ||
          objectValue(metadata.structuredTaskHealth).appVersion ||
          (canUseLiveHealth ? safeRuntime.appVersion : ""),
      ),
      attemptId: identity.attemptId,
      attemptNumber: Math.max(0, Number(source.attemptNumber) || 0),
      progressSeq: Math.max(0, Number(source.progressSeq) || 0),
      stage: healthEvidence.stage,
      phase: healthEvidence.phase,
      progressObserved: healthEvidence.progressObserved,
      healthEvidence,
      heartbeatAt: text(source.heartbeatAt, 80),
      businessProgressAt: text(source.businessProgressAt, 80),
      startedAt: text(source.startedAt, 80),
      finishedAt: text(source.finishedAt, 80),
      createdAt: text(source.createdAt, 80),
      updatedAt: text(source.updatedAt, 80),
    };
    const progress = objectValue(source.progress);
    const canUseRuntimeTab =
      canUseLiveHealth &&
      (isCurrentControlRequest || LIVE_TASK_HEALTH_STATUSES.has(taskStatus));
    const healthTabId = positiveTabId(
      source.runnerTabId ??
        progress.runnerTabId ??
        (canUseRuntimeTab ? safeRuntime.lastActiveTabId : null),
    );
    taskHealthHints.set(snapshot, {
      tabId: healthTabId,
      liveEvidence: canUseLiveHealth,
    });
    return snapshot;
  }

  function buildTargetedPostTaskSnapshot(
    request = {},
    runtime = {},
    healthOptions = {},
  ) {
    const source = objectValue(request);
    const descriptor = targetedPostTaskDescriptor(source);
    const exactAttemptId = taskSnapshotIdentity(source).attemptId;
    return buildTaskSnapshot(
      {
        ...source,
        workflow: descriptor.workflow,
        taskType: descriptor.taskType,
        featureKey: descriptor.featureKey,
        title: descriptor.title,
        source: "cloud_assignment",
        trigger: "remote",
        metadata: {
          ...objectValue(source.metadata),
          taskId: text(source.taskId, 240),
          cloudCommandId: text(source.cloudCommandId, 240),
        },
      },
      text(source.id, 240),
      runtime,
      {
        ...objectValue(healthOptions),
        allowLiveHealth: Boolean(exactAttemptId),
      },
    );
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
      safetyVerification: source.safetyVerification === true,
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
    const controlAttemptId = text(request.attemptId, 240);
    const runs = Array.isArray(safeLedger.runs) ? safeLedger.runs : [];
    const heartbeatNow = Date.now();
    const healthOptions = {
      now: heartbeatNow,
      networkObservation: lastCloudRequestObservation,
    };
    const tasks = runs
      .slice()
      .sort((left, right) => {
        const leftTime = timestampMs(left?.updatedAt || left?.heartbeatAt || left?.createdAt);
        const rightTime = timestampMs(right?.updatedAt || right?.heartbeatAt || right?.createdAt);
        return rightTime - leftTime;
      })
      .slice(0, 50)
      .map((run) => {
        const identity = taskSnapshotIdentity(run);
        const metadata = objectValue(run?.metadata);
        const matchesControlRequest = Boolean(
          controlRequestId &&
            (
              identity.id === controlRequestId ||
              text(metadata.controlTaskId, 240) === controlRequestId
            ),
        );
        const matchesControlAttempt = Boolean(
          controlAttemptId &&
            identity.attemptId &&
            identity.attemptId === controlAttemptId,
        );
        return buildTaskSnapshot(
          run,
          controlRequestId,
          safeRuntime,
          {
            ...healthOptions,
            allowLiveHealth: matchesControlRequest && matchesControlAttempt,
          },
        );
      })
      .filter(Boolean)
      .filter(
        (task, index, snapshots) =>
          snapshots.findIndex((candidate) =>
            isSameTaskAttempt(candidate, task),
          ) === index,
      );
    const targetedSnapshot = buildTargetedPostTaskSnapshot(
      targetedPostRequest,
      safeRuntime,
      healthOptions,
    );
    if (targetedSnapshot) {
      const existingIndex = tasks.findIndex((task) =>
        isSameTaskAttempt(task, targetedSnapshot),
      );
      if (existingIndex >= 0) {
        // The local ledger intentionally stores a compact task-center record.
        // For cloud reconciliation, the live targeted request is authoritative
        // and must replace that compact row so item results/checkpoints survive.
        tasks.splice(existingIndex, 1);
      }
      tasks.unshift(targetedSnapshot);
    }

    return {
      agent: {
        clientUuid: text(safeRuntime.clientUuid, 240),
        clientLabel: text(safeRuntime.clientLabel, 240),
        appVersion: healthVersion(safeRuntime.appVersion),
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
          remoteSequentialSearchPassesV1: true,
          remoteOrchestrationRecoveryMergeV1: true,
          negativePostPatrol: true,
          watchedContentPatrol: true,
          officialAccountCommentPatrol: true,
          officialAccountCommentPatrolProfileV1: true,
          officialAccountDetailPublishDateV1: true,
          officialAccountLatestPostsByCountV1: true,
          followedCreatorPostPatrol: true,
          officialAccountPostDiscovery: true,
          remoteTargetedPostCaptureV1: true,
          unattendedPlanMirror: true,
          localExecutionLock: true,
          socialAccountIdentity: true,
          socialAccountDailyUsage: true,
          structuredTaskHealthV1: true,
          dutyRecoveryLineageV1: true,
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
      sentAt: new Date(heartbeatNow).toISOString(),
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
      const requestStartedAt = Date.now();
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
          rememberCloudRequestObservation({
            endpoint,
            startedAt: requestStartedAt,
            outcome: "endpoint_missing",
            status: response.status,
          });
          continue;
        }
        if (!response.ok || !data?.ok) {
          rememberCloudRequestObservation({
            endpoint,
            startedAt: requestStartedAt,
            outcome: response.ok ? "application_error" : "http_error",
            status: response.status,
          });
          return {
            ok: false,
            status: response.status,
            reason: data?.error || data?.reason || "request_failed",
            message: data?.message || "云端任务中心请求失败",
          };
        }
        rememberCloudRequestObservation({
          endpoint,
          startedAt: requestStartedAt,
          outcome: "success",
          status: response.status,
        });
        return data;
      } catch (error) {
        lastError = {
          ok: false,
          reason: error?.name === "AbortError" ? "timeout" : "network_error",
          message: error?.message || "network error",
        };
        rememberCloudRequestObservation({
          endpoint,
          startedAt: requestStartedAt,
          outcome: lastError.reason,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return lastError || {ok: false, reason: "cloud_unavailable"};
  }

  async function sendHeartbeat(options = {}) {
    const body = await enrichHeartbeatHealthEvidence(options.body);
    return await requestJson({
      ...options,
      body,
      endpoint: "/api/capture-cloud/agent/heartbeat",
    });
  }

  async function sendLiveness(options = {}) {
    return await requestJson({
      ...options,
      endpoint: "/api/capture-cloud/agent/liveness",
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
    buildTaskHealthEvidence,
    enrichHeartbeatHealthEvidence,
    buildTaskSnapshot,
    buildTargetedPostTaskSnapshot,
    buildUnattendedPlanSnapshot,
    buildObservedSocialAccountSnapshot,
    buildSocialUsageEventSnapshot,
    buildHeartbeatPayload,
    requestJson,
    sendLiveness,
    sendHeartbeat,
    completeCommand,
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
