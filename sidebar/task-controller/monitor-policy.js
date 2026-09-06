// L3-B monitor-policy: explicit application responsibility.
export function createMonitorPolicyController({controllerState, controllerPorts, controllerOperations}) {
  const {
    DEFAULT_CAPTURE_SETTINGS,
    DEFAULT_MONITOR_SETTINGS,
    ERROR_REASON,
    MONITOR_DAY_MS,
    MONITOR_DETAIL_DATE_DISCOVERY_MAX,
    MONITOR_DETAIL_DATE_DISCOVERY_MIN,
    MONITOR_DETAIL_DATE_DISCOVERY_MULTIPLIER,
    MONITOR_LATEST_POSTS_LIMIT_MAX,
    MONITOR_OBSERVE_WINDOW_OPTIONS,
    MONITOR_PUBLISH_WINDOW,
    MONITOR_PUBLISH_WINDOW_OPTIONS,
    MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW,
    MONITOR_SHANGHAI_OFFSET_MS,
  } = controllerPorts;

  function resolveMonitorRunHistoryState(item) {
    const status = String(item?.status || "")
      .trim()
      .toLowerCase();
    const hitCount = Math.max(0, Number(item?.hitCount || 0));
    const scannedCount = Math.max(0, Number(item?.scannedCount || 0));
    const errorCode = String(item?.errorCode || "").trim();
    const errorMessage = String(item?.errorMessage || "").trim();

    if (status === "skipped_no_balance") {
      return {
        monitorStatus: "credit_insufficient",
        monitorStatusLabel: "配额不足",
        monitorSyncLabel: "",
        monitorSummary: "未执行扫描（配额不足）",
        isSuccess: false,
        reason: errorCode || "insufficient_balance",
        message: errorMessage || "insufficient credential credits",
      };
    }

    if (status === "queued" || status === "pending" || status === "running") {
      return {
        monitorStatus: "queued",
        monitorStatusLabel: "已排队",
        monitorSyncLabel: "",
        monitorSummary: status === "running" ? "扫描任务执行中" : "扫描任务已排队",
        isSuccess: true,
        reason: ERROR_REASON.NONE,
        message: status === "running" ? "监控任务执行中" : "已创建监控执行任务",
      };
    }

    if (status === "no_hit") {
      return {
        monitorStatus: "no_hit",
        monitorStatusLabel: "未命中",
        monitorSyncLabel: "",
        monitorSummary: `已扫描 ${scannedCount} / 命中 0`,
        isSuccess: true,
        reason: ERROR_REASON.NONE,
        message: "监控执行完成",
      };
    }

    if (status === "success") {
      return {
        monitorStatus: "hit_synced",
        monitorStatusLabel: "已命中",
        monitorSyncLabel: "已同步",
        monitorSummary: `命中 ${hitCount} / 已同步`,
        isSuccess: true,
        reason: ERROR_REASON.NONE,
        message: "监控执行完成",
      };
    }

    if (status === "failed" && hitCount > 0) {
      return {
        monitorStatus: "hit_sync_failed",
        monitorStatusLabel: "已命中",
        monitorSyncLabel: "同步失败",
        monitorSummary: `命中 ${hitCount} / 同步失败`,
        isSuccess: false,
        reason: errorCode || "sync_failed",
        message: errorMessage || "监控同步失败",
      };
    }

    return {
      monitorStatus: "execution_failed",
      monitorStatusLabel: "执行失败",
      monitorSyncLabel: "",
      monitorSummary: errorMessage || "扫描失败",
      isSuccess: false,
      reason: errorCode || "provider_request_failed",
      message: errorMessage || "监控执行失败",
    };
  }
  function normalizeMonitorRunnerPlatform(value = "") {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    return normalized === "douyin" ||
      normalized === "xiaohongshu" ||
      normalized === "weibo"
      ? normalized
      : "unknown";
  }
  function resolveMonitorRunnerAccountUrl(runItem = {}, monitorItem = {}) {
    return String(
      runItem.bloggerUrl ||
        runItem.monitorBloggerUrl ||
        runItem.accountUrl ||
        monitorItem.bloggerUrl ||
        monitorItem.monitorBloggerUrl ||
        monitorItem.accountUrl ||
        "",
    ).trim();
  }
  function resolveMonitorRunnerName(runItem = {}, monitorItem = {}) {
    return (
      String(
        runItem.monitorBloggerName ||
          runItem.bloggerNameSnapshot ||
          runItem.bloggerName ||
          monitorItem.bloggerNameSnapshot ||
          monitorItem.bloggerName ||
          monitorItem.platformBloggerId ||
          "",
      ).trim() || "未命名博主"
    );
  }
  function resolveMonitorRunnerCaptureParams(
    monitorSettings = {},
    captureSettings = {},
  ) {
    const observeWindowHours =
      MONITOR_OBSERVE_WINDOW_OPTIONS.includes(
        Number(monitorSettings.observeWindowHours),
      )
        ? Number(monitorSettings.observeWindowHours)
        : DEFAULT_MONITOR_SETTINGS.observeWindowHours;
    const defaultMaxDetectedItems =
      MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW[observeWindowHours] ||
      MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW[
        DEFAULT_MONITOR_SETTINGS.observeWindowHours
      ];
    const requestedPostsLimit = Number(monitorSettings.postsLimit);
    const normalizedPostsLimit =
      Number.isSafeInteger(requestedPostsLimit) && requestedPostsLimit > 0
        ? requestedPostsLimit
        : defaultMaxDetectedItems;
    const verifyPublishDateFromDetail =
      captureSettings.verifyPublishDateFromDetail === true;
    const scanLatestPostsByCount =
      captureSettings.scanLatestPostsByCount === true;
    const maxDetectedItems =
      scanLatestPostsByCount
        ? Math.min(MONITOR_LATEST_POSTS_LIMIT_MAX, normalizedPostsLimit)
        : verifyPublishDateFromDetail
        ? Math.min(
            MONITOR_DETAIL_DATE_DISCOVERY_MAX,
            Math.max(
              MONITOR_DETAIL_DATE_DISCOVERY_MIN,
              normalizedPostsLimit * MONITOR_DETAIL_DATE_DISCOVERY_MULTIPLIER,
            ),
          )
        : Math.min(defaultMaxDetectedItems, normalizedPostsLimit);
    const publishBounds = resolveMonitorPublishWindowBounds(monitorSettings);
    const publishWindow = publishBounds.key;
    const isStrictPublishWindow = publishBounds.strict === true;
    const monitorScanLimit = scanLatestPostsByCount
      ? maxDetectedItems
      : verifyPublishDateFromDetail
      ? maxDetectedItems
      : isStrictPublishWindow
        ? Math.min(
            maxDetectedItems,
            publishWindow === MONITOR_PUBLISH_WINDOW.PREVIOUS_DAY ? 20 : 12,
          )
        : maxDetectedItems;
    const likeThreshold = Math.max(
      0,
      Number(monitorSettings.likeThreshold) ||
        DEFAULT_MONITOR_SETTINGS.likeThreshold,
    );

    return {
      includeBloggerProfileRecord: false,
      // 监控先纳入最近动态；点赞阈值用于后续判断，不在采集阶段过滤。
      minLikes: 0,
      maxDetectedItems: Math.floor(monitorScanLimit),
      monitorLikeThreshold: Math.floor(likeThreshold),
      // 账号作品列表不一定提供可信发布时间。官方账号评论巡查先把列表当作
      // 候选来源，进入详情页核实日期后再筛选，避免在列表阶段误判。
      monitorPublishWindow:
        verifyPublishDateFromDetail || scanLatestPostsByCount
          ? ""
          : publishWindow,
      monitorObserveWindowHours: observeWindowHours,
      waitMinMs:
        Number(captureSettings.sharedWaitMinMs) ||
        DEFAULT_CAPTURE_SETTINGS.sharedWaitMinMs,
      waitMaxMs:
        Number(captureSettings.sharedWaitMaxMs) ||
        DEFAULT_CAPTURE_SETTINGS.sharedWaitMaxMs,
      stallTimeoutMs:
        Number(captureSettings.sharedStallTimeoutMs) ||
        DEFAULT_CAPTURE_SETTINGS.sharedStallTimeoutMs,
      maxDurationMs:
        Number(captureSettings.sharedMaxDurationMs) ||
        DEFAULT_CAPTURE_SETTINGS.sharedMaxDurationMs,
      maxScrollTimes:
        scanLatestPostsByCount
          ? Math.max(
              20,
              Math.min(60, Math.ceil(Math.floor(monitorScanLimit) / 2)),
            )
          : verifyPublishDateFromDetail || !isStrictPublishWindow
            ? 20
            : 6,
    };
  }
  function summarizeMonitorSyncResult(syncResult = {}) {
    const results = Array.isArray(syncResult.results) ? syncResult.results : [];
    const successCount = results.filter((item) => item?.success).length;
    const failedCount = results.length - successCount;
    const actionCounts = results.reduce(
      (acc, item) => {
        const raw = item?.rawResponse || {};
        const action = String(raw.action || item?.action || "")
          .trim()
          .toLowerCase();
        if (action === "inserted") {
          acc.inserted += 1;
        } else if (action === "updated") {
          acc.updated += 1;
        }
        const negative = Number(raw?.commentStats?.negative || 0);
        if (Number.isFinite(negative) && negative > 0) {
          acc.negative += negative;
        }
        return acc;
      },
      {inserted: 0, updated: 0, negative: 0},
    );

    return {
      successCount,
      failedCount,
      insertedCount: actionCounts.inserted,
      updatedCount: actionCounts.updated,
      negativeCount: actionCounts.negative,
    };
  }
  function getShanghaiDayStartMs(timestamp = Date.now()) {
    const normalized = Number(timestamp);
    const safeTimestamp = Number.isFinite(normalized) ? normalized : Date.now();
    return (
      Math.floor((safeTimestamp + MONITOR_SHANGHAI_OFFSET_MS) / MONITOR_DAY_MS) *
        MONITOR_DAY_MS -
      MONITOR_SHANGHAI_OFFSET_MS
    );
  }
  function getShanghaiDateParts(timestamp = Date.now()) {
    const date = new Date(Number(timestamp) + MONITOR_SHANGHAI_OFFSET_MS);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }
  function buildShanghaiTimestamp({
    year,
    month,
    day,
    hour = 0,
    minute = 0,
    second = 0,
    millisecond = 0,
  }) {
    const timestamp =
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(millisecond),
      ) - MONITOR_SHANGHAI_OFFSET_MS;
    return Number.isFinite(timestamp) ? timestamp : NaN;
  }
  function parseMonitorCalendarDateStartMs(value) {
    const match = String(value || "")
      .trim()
      .match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return NaN;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const timestamp = buildShanghaiTimestamp({year, month, day});
    if (!Number.isFinite(timestamp)) {
      return NaN;
    }
    const parts = getShanghaiDateParts(timestamp);
    return parts.year === year && parts.month === month && parts.day === day
      ? timestamp
      : NaN;
  }
  function resolveMonitorPublishWindowBounds(
    publishWindowOrSettings,
    nowMs = Date.now(),
  ) {
    const settings =
      publishWindowOrSettings &&
      typeof publishWindowOrSettings === "object" &&
      !Array.isArray(publishWindowOrSettings)
        ? publishWindowOrSettings
        : {publishWindow: publishWindowOrSettings};
    const publishDateFrom = String(settings.publishDateFrom || "").trim();
    const publishDateTo = String(settings.publishDateTo || "").trim();
    const customStartMs = parseMonitorCalendarDateStartMs(publishDateFrom);
    const customEndStartMs = parseMonitorCalendarDateStartMs(publishDateTo);
    if (
      Number.isFinite(customStartMs) &&
      Number.isFinite(customEndStartMs) &&
      customStartMs <= customEndStartMs
    ) {
      return {
        key: "custom",
        label:
          publishDateFrom === publishDateTo
            ? `${publishDateFrom} 发布`
            : `${publishDateFrom} 至 ${publishDateTo} 发布`,
        strict: true,
        startMs: customStartMs,
        endMs: customEndStartMs + MONITOR_DAY_MS,
      };
    }

    const normalized = MONITOR_PUBLISH_WINDOW_OPTIONS.has(settings.publishWindow)
      ? settings.publishWindow
      : DEFAULT_MONITOR_SETTINGS.publishWindow;

    if (normalized === MONITOR_PUBLISH_WINDOW.PREVIOUS_DAY) {
      const todayStartMs = getShanghaiDayStartMs(nowMs);
      return {
        key: normalized,
        label: "昨天发布",
        strict: true,
        startMs: todayStartMs - MONITOR_DAY_MS,
        endMs: todayStartMs,
      };
    }

    if (normalized === MONITOR_PUBLISH_WINDOW.LAST_24H) {
      return {
        key: normalized,
        label: "最近 24 小时发布",
        strict: true,
        startMs: nowMs - MONITOR_DAY_MS,
        endMs: nowMs,
      };
    }

    return resolveMonitorPublishWindowBounds(
      DEFAULT_MONITOR_SETTINGS.publishWindow,
      nowMs,
    );
  }
  function cleanMonitorPublishText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/^发布时间[:：]?\s*/i, "")
      .replace(/^发布于[:：]?\s*/i, "")
      .replace(/^编辑于\s*/i, "")
      .replace(/^·\s*/, "")
      .trim();
  }
  function createMonitorPublishMoment(
    timestamp,
    {precision = "exact", raw = ""} = {},
  ) {
    const normalized = Number(timestamp);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      return null;
    }
    if (precision === "date") {
      const startMs = getShanghaiDayStartMs(normalized);
      return {
        ok: true,
        raw,
        precision: "date",
        timestampMs: startMs,
        startMs,
        endMs: startMs + MONITOR_DAY_MS,
      };
    }
    return {
      ok: true,
      raw,
      precision: "exact",
      timestampMs: normalized,
      startMs: normalized,
      endMs: normalized,
    };
  }
  function parseMonitorNumericPublishMoment(value, raw = "") {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    const timestampMs = numeric < 100000000000 ? numeric * 1000 : numeric;
    return createMonitorPublishMoment(timestampMs, {raw});
  }
  function resolveYearForMonthDay(month, day, nowMs, hour = 0, minute = 0) {
    const {year} = getShanghaiDateParts(nowMs);
    const timestamp = buildShanghaiTimestamp({year, month, day, hour, minute});
    if (Number.isFinite(timestamp) && timestamp > nowMs + MONITOR_DAY_MS) {
      return year - 1;
    }
    return year;
  }
  function parseMonitorPublishMoment(value, nowMs = Date.now()) {
    if (value instanceof Date) {
      return createMonitorPublishMoment(value.getTime(), {
        raw: value.toISOString(),
      });
    }
    if (typeof value === "number") {
      return parseMonitorNumericPublishMoment(value, String(value));
    }

    const text = cleanMonitorPublishText(value);
    if (!text) {
      return null;
    }

    if (/^\d{10,13}$/.test(text)) {
      return parseMonitorNumericPublishMoment(text, text);
    }

    if (/^\d{4}-\d{2}-\d{2}T/i.test(text)) {
      const parsed = Date.parse(text);
      if (Number.isFinite(parsed)) {
        return createMonitorPublishMoment(parsed, {raw: text});
      }
    }

    let match = text.match(
      /(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?(?:\s+|T)?(\d{1,2})[:：](\d{2})/,
    );
    if (match) {
      const [, year, month, day, hour, minute] = match;
      return createMonitorPublishMoment(
        buildShanghaiTimestamp({year, month, day, hour, minute}),
        {raw: text},
      );
    }

    match = text.match(/(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?/);
    if (match) {
      const [, year, month, day] = match;
      return createMonitorPublishMoment(
        buildShanghaiTimestamp({year, month, day}),
        {precision: "date", raw: text},
      );
    }

    match = text.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[:：](\d{2})/);
    if (match) {
      const [, month, day, hour, minute] = match;
      const year = resolveYearForMonthDay(month, day, nowMs, hour, minute);
      return createMonitorPublishMoment(
        buildShanghaiTimestamp({year, month, day, hour, minute}),
        {raw: text},
      );
    }

    match = text.match(/(\d{1,2})[-/.](\d{1,2})\s*(\d{1,2})[:：](\d{2})/);
    if (match) {
      const [, month, day, hour, minute] = match;
      const year = resolveYearForMonthDay(month, day, nowMs, hour, minute);
      return createMonitorPublishMoment(
        buildShanghaiTimestamp({year, month, day, hour, minute}),
        {raw: text},
      );
    }

    match = text.match(/(\d{1,2})月(\d{1,2})日/);
    if (match) {
      const [, month, day] = match;
      const year = resolveYearForMonthDay(month, day, nowMs);
      return createMonitorPublishMoment(
        buildShanghaiTimestamp({year, month, day}),
        {precision: "date", raw: text},
      );
    }

    match = text.match(/(\d{1,2})[-/.](\d{1,2})/);
    if (match) {
      const [, month, day] = match;
      const year = resolveYearForMonthDay(month, day, nowMs);
      return createMonitorPublishMoment(
        buildShanghaiTimestamp({year, month, day}),
        {precision: "date", raw: text},
      );
    }

    match = text.match(/今天\s*(\d{1,2})[:：](\d{2})/);
    if (match) {
      const [, hour, minute] = match;
      const {year, month, day} = getShanghaiDateParts(nowMs);
      return createMonitorPublishMoment(
        buildShanghaiTimestamp({year, month, day, hour, minute}),
        {raw: text},
      );
    }

    match = text.match(/昨天\s*(?:(\d{1,2})[:：](\d{2}))?/);
    if (match) {
      const {year, month, day} = getShanghaiDateParts(nowMs);
      const hour = match[1] || 0;
      const minute = match[2] || 0;
      return createMonitorPublishMoment(
        buildShanghaiTimestamp({year, month, day: day - 1, hour, minute}),
        {precision: match[1] ? "exact" : "date", raw: text},
      );
    }

    match = text.match(/前天\s*(?:(\d{1,2})[:：](\d{2}))?/);
    if (match) {
      const {year, month, day} = getShanghaiDateParts(nowMs);
      const hour = match[1] || 0;
      const minute = match[2] || 0;
      return createMonitorPublishMoment(
        buildShanghaiTimestamp({year, month, day: day - 2, hour, minute}),
        {precision: match[1] ? "exact" : "date", raw: text},
      );
    }

    match = text.match(/(\d+)\s*分钟前/);
    if (match) {
      return createMonitorPublishMoment(nowMs - Number(match[1]) * 60 * 1000, {
        raw: text,
      });
    }

    match = text.match(/(\d+)\s*小时前/);
    if (match) {
      return createMonitorPublishMoment(nowMs - Number(match[1]) * 60 * 60 * 1000, {
        raw: text,
      });
    }

    match = text.match(/(\d+)\s*天前\s*(?:(\d{1,2})[:：](\d{2}))?/);
    if (match) {
      const days = Number(match[1]) || 0;
      if (match[2]) {
        const {year, month, day} = getShanghaiDateParts(nowMs);
        return createMonitorPublishMoment(
          buildShanghaiTimestamp({
            year,
            month,
            day: day - days,
            hour: match[2],
            minute: match[3] || 0,
          }),
          {raw: text},
        );
      }
      const dayStartMs = getShanghaiDayStartMs(nowMs - days * MONITOR_DAY_MS);
      return createMonitorPublishMoment(dayStartMs, {
        precision: "date",
        raw: text,
      });
    }

    if (/刚刚|刚才|现在/.test(text)) {
      return createMonitorPublishMoment(nowMs, {raw: text});
    }

    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return createMonitorPublishMoment(parsed, {raw: text});
    }

    return null;
  }
  function collectMonitorPublishCandidates(
    record = {},
    {detailOnly = false} = {},
  ) {
    const payload =
      record?.payload && typeof record.payload === "object" ? record.payload : {};
    const item =
      Array.isArray(payload.items) &&
      payload.items[0] &&
      typeof payload.items[0] === "object"
        ? payload.items[0]
        : {};
    const detail =
      payload.detailPayload && typeof payload.detailPayload === "object"
        ? payload.detailPayload
        : {};

    const detailCandidates = [
      {value: detail.publishTimestamp, source: "detail.publishTimestamp"},
      {value: detail.publishTime, source: "detail.publishTime"},
      {value: detail.publishDateRaw, source: "detail.publishDateRaw"},
      {value: detail.lastEditedAt, source: "detail.lastEditedAt"},
      {value: detail.publishDate, source: "detail.publishDate"},
    ];
    if (detailOnly) {
      return detailCandidates;
    }

    return [
      ...detailCandidates,
      {value: item.publishTimestamp, source: "item.publishTimestamp"},
      {value: item.publishTime, source: "item.publishTime"},
      {value: item.publishDateRaw, source: "item.publishDateRaw"},
      {value: item.lastEditedAt, source: "item.lastEditedAt"},
      {value: item.publishDate, source: "item.publishDate"},
      {value: payload.publishTimestamp, source: "payload.publishTimestamp"},
      {value: payload.publishTime, source: "payload.publishTime"},
      {value: payload.publishDateRaw, source: "payload.publishDateRaw"},
      {value: payload.lastEditedAt, source: "payload.lastEditedAt"},
      {value: payload.publishDate, source: "payload.publishDate"},
    ];
  }
  function isLikelyFallbackCaptureTime(
    record,
    candidate,
    moment,
    {detailOnly = false} = {},
  ) {
    const source = String(candidate?.source || "");
    if (!/lastEditedAt/i.test(source) || !moment?.timestampMs) {
      return false;
    }

    const rawDateSignals = collectMonitorPublishCandidates(record, {
      detailOnly,
    }).some((item) => {
      const candidateSource = String(item.source || "");
      return (
        !/lastEditedAt/i.test(candidateSource) &&
        cleanMonitorPublishText(item.value)
      );
    });
    if (rawDateSignals) {
      return false;
    }

    const payload =
      record?.payload && typeof record.payload === "object" ? record.payload : {};
    const detail =
      payload.detailPayload && typeof payload.detailPayload === "object"
        ? payload.detailPayload
        : {};
    const captureTimestamp = Number(
      detail.captureTimestamp ||
        payload.detailCaptureFinishedAt ||
        payload.captureTimestamp ||
        record.updatedAt ||
        0,
    );
    return (
      Number.isFinite(captureTimestamp) &&
      captureTimestamp > 0 &&
      Math.abs(moment.timestampMs - captureTimestamp) <= 2 * 60 * 1000
    );
  }
  function resolveMonitorRecordPublishMoment(
    record,
    nowMs = Date.now(),
    {detailOnly = false} = {},
  ) {
    const candidates = collectMonitorPublishCandidates(record, {detailOnly});
    for (const candidate of candidates) {
      const moment = parseMonitorPublishMoment(candidate.value, nowMs);
      if (!moment) {
        continue;
      }
      if (
        isLikelyFallbackCaptureTime(record, candidate, moment, {detailOnly})
      ) {
        continue;
      }
      return {
        ...moment,
        source: candidate.source,
      };
    }
    return null;
  }
  function isMonitorPublishMomentInWindow(moment, bounds) {
    if (!bounds?.strict) {
      return true;
    }
    if (!moment?.ok) {
      return false;
    }
    if (moment.precision === "date") {
      return moment.startMs >= bounds.startMs && moment.endMs <= bounds.endMs;
    }
    return moment.timestampMs >= bounds.startMs && moment.timestampMs < bounds.endMs;
  }

  return Object.freeze({
    resolveMonitorRunHistoryState,
    normalizeMonitorRunnerPlatform,
    resolveMonitorRunnerAccountUrl,
    resolveMonitorRunnerName,
    resolveMonitorRunnerCaptureParams,
    summarizeMonitorSyncResult,
    getShanghaiDayStartMs,
    getShanghaiDateParts,
    buildShanghaiTimestamp,
    parseMonitorCalendarDateStartMs,
    resolveMonitorPublishWindowBounds,
    cleanMonitorPublishText,
    createMonitorPublishMoment,
    parseMonitorNumericPublishMoment,
    resolveYearForMonthDay,
    parseMonitorPublishMoment,
    collectMonitorPublishCandidates,
    isLikelyFallbackCaptureTime,
    resolveMonitorRecordPublishMoment,
    isMonitorPublishMomentInWindow,
  });
}
