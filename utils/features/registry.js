const FEATURE_REGISTRY_VERSION = "0.1.5";

const FEATURE_KEYS = Object.freeze({
  CAPTURE_SINGLE_NOTE: "capture.single_note",
  CAPTURE_BLOGGER: "capture.blogger",
  CAPTURE_SEARCH: "capture.search",
  CAPTURE_COMMENTS: "capture.comments",
  CAPTURE_ENHANCEMENT: "capture.enhancement",
  CAPTURE_SHARED_POLICY: "capture.shared_policy",
  KEYWORD_LONGTAIL: "keyword.longtail_expansion",
  KEYWORD_OPPORTUNITY: "keyword.opportunity",
  BENCHMARK_ACCOUNT_DISCOVERY: "benchmark.account_discovery",
  SYNC_LARK: "sync.lark",
  EXPORT_CSV: "export.csv",
  MONITOR_ACCOUNT: "monitor.account",
  DIAGNOSTICS_COPY: "diagnostics.copy",
});

const FEATURE_LAYERS = Object.freeze({
  PRIMARY_CAPTURE: "primary_capture",
  SHARED_CAPABILITY: "shared_capability",
  ENHANCEMENT_ORCHESTRATOR: "enhancement_orchestrator",
  ANALYSIS: "analysis",
  SYNC: "sync",
  EXPORT: "export",
  MONITOR: "monitor",
  AI: "ai",
  DIAGNOSTICS: "diagnostics",
});

const CAPTURE_STAGE_KEYS = Object.freeze({
  PAGE_DETECT: "capture.page_detect",
  DETAIL_CAPTURE: "capture.detail_capture",
  SCROLL_LOAD: "capture.scroll_load",
  LIST_PARSE: "capture.list_parse",
  FILTER_APPLY: "capture.filter_apply",
  COMMENT_LOAD: "capture.comment_load",
  DETAIL_ENHANCE: "capture.detail_enhance",
  BLOGGER_METRICS: "capture.blogger_metrics",
  LOW_FOLLOWER_FILTER: "capture.low_follower_filter",
  COMMENT_LEADS_FILTER: "capture.comment_leads_filter",
  RECORD_WRITE: "capture.record_write",
});

const COMMON_CAPTURE_STORAGE_KEYS = Object.freeze([
  "RUNTIME",
  "CAPTURE",
  "DATA_POOL",
]);

const COMMON_CAPTURE_SETTINGS_KEYS = Object.freeze([
  "SHARED_WAIT_MIN_MS",
  "SHARED_WAIT_MAX_MS",
  "SHARED_STALL_TIMEOUT_MS",
  "SHARED_MAX_DURATION_MS",
]);

const COMMON_CAPTURE_TESTS = Object.freeze([
  "tests/e2e/smoke/extension-runtime.spec.ts",
]);

const PLATFORM_CAPTURE_ADAPTERS = Object.freeze([
  {
    platform: "xiaohongshu",
    module: "utils/capture/adapters/xiaohongshu/index.js",
  },
  {
    platform: "douyin",
    module: "utils/capture/adapters/douyin/index.js",
  },
]);

const SHARED_POLICY_SETTINGS_KEYS = Object.freeze([
  ...COMMON_CAPTURE_SETTINGS_KEYS,
  "DETAIL_NAV_TIMEOUT_MS",
  "DETAIL_AFTER_NAV_WAIT_MS",
  "PROFILE_AFTER_NAV_WAIT_MS",
]);

const SCROLL_STAGE_CONTRACT = Object.freeze([
  "requestedMaxDetectedItems",
  "finalContentCount",
  "scrollCount",
  "maxScrollTimes",
  "noNewContentCount",
  "stopReason",
  "elapsedMs",
]);

const FILTER_STAGE_CONTRACT = Object.freeze([
  "rawTotalCount",
  "filteredBeforeLimitCount",
  "filteredCount",
  "minLikes",
  "sortDimension",
  "missingMetricCount",
  "minMetricCount",
  "maxMetricCount",
  "zeroMetricCount",
  "metricExtractionSuspicious",
]);

function stage(stageKey, label, options = {}) {
  return Object.freeze({
    stageKey,
    label,
    ...options,
  });
}

const FEATURE_REGISTRY = Object.freeze([
  Object.freeze({
    featureKey: FEATURE_KEYS.CAPTURE_SINGLE_NOTE,
    title: "单篇采集",
    layer: FEATURE_LAYERS.PRIMARY_CAPTURE,
    priority: "P0",
    status: "mapped",
    summary: "在笔记/作品详情页采集单篇内容，可选附加评论和博主指标。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "noteTab",
      selectors: Object.freeze(["#btnCaptureNote"]),
      handler: "handleCaptureNoteData",
    }),
    pages: Object.freeze(["NOTE_DETAIL"]),
    messageTypes: Object.freeze(["RELAY_TO_CONTENT", "CAPTURE_PROGRESS"]),
    contentActions: Object.freeze([
      "captureSingleNote",
      "captureComments",
      "cancelCapture",
    ]),
    subflows: Object.freeze([
      stage(CAPTURE_STAGE_KEYS.PAGE_DETECT, "页面识别"),
      stage(CAPTURE_STAGE_KEYS.DETAIL_CAPTURE, "详情字段采集", {
        contentActions: Object.freeze(["captureSingleNote"]),
      }),
      stage(CAPTURE_STAGE_KEYS.BLOGGER_METRICS, "可选账号指标补采", {
        optional: true,
      }),
      stage(CAPTURE_STAGE_KEYS.COMMENT_LOAD, "可选评论采集", {
        optional: true,
        referencedFeatureKey: FEATURE_KEYS.CAPTURE_COMMENTS,
      }),
      stage(CAPTURE_STAGE_KEYS.RECORD_WRITE, "入池"),
    ]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        exports: Object.freeze([]),
        functions: Object.freeze([
          "handleCaptureNoteData",
          "captureNoteWithOptionalComments",
        ]),
      }),
      Object.freeze({
        path: "utils/capture-sync.js",
        exports: Object.freeze([
          "captureNoteWithOptionalComments",
          "captureTabContent",
        ]),
      }),
      Object.freeze({
        path: "utils/capture/index.js",
        exports: Object.freeze(["captureSingleNote", "captureComments"]),
      }),
    ]),
    adapters: Object.freeze(
      PLATFORM_CAPTURE_ADAPTERS.map((adapter) =>
        Object.freeze({
          ...adapter,
          methods: Object.freeze(["captureSingleNote", "captureComments"]),
        }),
      ),
    ),
    backendApis: Object.freeze([]),
    storageKeys: Object.freeze([...COMMON_CAPTURE_STORAGE_KEYS]),
    captureSettingsKeys: Object.freeze([
      "INCLUDE_COMMENTS_ON_NOTE_CAPTURE",
      "INCLUDE_BLOGGER_METRICS_ON_NOTE_CAPTURE",
      "COMMENTS_MAX_DETECTED_ITEMS",
      "ENABLE_COMMENT_LEADS_FILTER",
      "DETAIL_NAV_TIMEOUT_MS",
      "PROFILE_AFTER_NAV_WAIT_MS",
    ]),
    analytics: Object.freeze({
      taskType: "capture",
      legacyFeatureKeys: Object.freeze([
        "xhs_single_note_capture",
        "douyin_video_capture",
      ]),
    }),
    diagnosticContract: Object.freeze({
      stageKeys: Object.freeze([
        CAPTURE_STAGE_KEYS.DETAIL_CAPTURE,
        CAPTURE_STAGE_KEYS.BLOGGER_METRICS,
        CAPTURE_STAGE_KEYS.COMMENT_LOAD,
      ]),
      requiredFields: Object.freeze([
        "captureStatus",
        "includeBloggerMetrics",
        "includeComments",
      ]),
    }),
    tests: Object.freeze([
      ...COMMON_CAPTURE_TESTS,
      "tests/e2e/capture/capture-single-note.spec.ts",
      "tests/e2e/capture/data-pool-envelope.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.CAPTURE_BLOGGER,
    title: "博主采集",
    layer: FEATURE_LAYERS.PRIMARY_CAPTURE,
    priority: "P0",
    status: "mapped",
    summary: "在博主/账号主页采集主页信息和内容列表，基础采集后可进入采集增强。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "bloggerTab",
      selectors: Object.freeze(["#btnCaptureBlogger"]),
      handler: "handleCaptureBloggerData",
    }),
    pages: Object.freeze(["BLOGGER_PROFILE"]),
    messageTypes: Object.freeze(["RELAY_TO_CONTENT", "CAPTURE_PROGRESS"]),
    contentActions: Object.freeze([
      "captureBloggerProfile",
      "captureBloggerNotes",
      "captureSingleNote",
      "captureComments",
      "cancelCapture",
    ]),
    referencedCapabilities: Object.freeze([
      FEATURE_KEYS.CAPTURE_SHARED_POLICY,
      FEATURE_KEYS.CAPTURE_ENHANCEMENT,
    ]),
    subflows: Object.freeze([
      stage(CAPTURE_STAGE_KEYS.PAGE_DETECT, "页面识别"),
      stage(CAPTURE_STAGE_KEYS.DETAIL_CAPTURE, "主页信息采集", {
        contentActions: Object.freeze(["captureBloggerProfile"]),
      }),
      stage(CAPTURE_STAGE_KEYS.SCROLL_LOAD, "作品列表滚动加载", {
        referencedFeatureKey: FEATURE_KEYS.CAPTURE_SHARED_POLICY,
      }),
      stage(CAPTURE_STAGE_KEYS.LIST_PARSE, "作品列表解析"),
      stage(CAPTURE_STAGE_KEYS.FILTER_APPLY, "点赞/主题筛选"),
      stage(CAPTURE_STAGE_KEYS.RECORD_WRITE, "入池"),
      stage(CAPTURE_STAGE_KEYS.DETAIL_ENHANCE, "可选采集增强", {
        optional: true,
        referencedFeatureKey: FEATURE_KEYS.CAPTURE_ENHANCEMENT,
      }),
    ]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze([
          "handleCaptureBloggerData",
          "maybeRunAutoDetailCaptureAfterListCapture",
        ]),
      }),
      Object.freeze({
        path: "utils/capture-sync.js",
        exports: Object.freeze([
          "captureAndSync",
          "batchCaptureDetailsForRecords",
          "captureTabContent",
        ]),
      }),
      Object.freeze({
        path: "utils/capture/index.js",
        exports: Object.freeze([
          "captureBloggerProfile",
          "captureBloggerNotes",
        ]),
      }),
    ]),
    adapters: Object.freeze(
      PLATFORM_CAPTURE_ADAPTERS.map((adapter) =>
        Object.freeze({
          ...adapter,
          methods: Object.freeze([
            "captureBloggerProfile",
            "captureBloggerNotes",
            "captureSingleNote",
            "captureComments",
          ]),
        }),
      ),
    ),
    backendApis: Object.freeze([]),
    storageKeys: Object.freeze([...COMMON_CAPTURE_STORAGE_KEYS]),
    captureSettingsKeys: Object.freeze([
      ...COMMON_CAPTURE_SETTINGS_KEYS,
      "BLOGGER_MAX_DETECTED_ITEMS",
      "BLOGGER_MIN_LIKES",
      "BLOGGER_KEYWORD_FILTER",
      "AUTO_DETAIL_CAPTURE_AFTER_LIST_CAPTURE",
    ]),
    analytics: Object.freeze({
      taskType: "capture",
      legacyFeatureKeys: Object.freeze([
        "xhs_blogger_notes_capture",
        "douyin_profile_capture",
      ]),
    }),
    diagnosticContract: Object.freeze({
      stageKeys: Object.freeze([
        CAPTURE_STAGE_KEYS.SCROLL_LOAD,
        CAPTURE_STAGE_KEYS.LIST_PARSE,
        CAPTURE_STAGE_KEYS.FILTER_APPLY,
        CAPTURE_STAGE_KEYS.DETAIL_ENHANCE,
      ]),
      requiredFields: Object.freeze([
        ...SCROLL_STAGE_CONTRACT,
        ...FILTER_STAGE_CONTRACT,
        "keywordFilter",
      ]),
    }),
    tests: Object.freeze([
      ...COMMON_CAPTURE_TESTS,
      "tests/e2e/capture/capture-blogger-notes.spec.ts",
      "tests/e2e/capture/capture-stage-diagnostics.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.CAPTURE_SEARCH,
    title: "搜索采集",
    layer: FEATURE_LAYERS.PRIMARY_CAPTURE,
    priority: "P0",
    status: "mapped",
    summary: "在搜索结果页采集关键词内容列表，基础采集后可进入采集增强。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "searchTab",
      selectors: Object.freeze(["#btnCaptureSearch", "#btnOpenBatchSearch"]),
      handler: "handleCaptureSearchData",
    }),
    pages: Object.freeze(["SEARCH_RESULTS"]),
    messageTypes: Object.freeze(["RELAY_TO_CONTENT", "CAPTURE_PROGRESS"]),
    contentActions: Object.freeze([
      "detectSearchSortDimension",
      "captureKeywordNotes",
      "captureSingleNote",
      "captureComments",
      "cancelCapture",
    ]),
    referencedCapabilities: Object.freeze([
      FEATURE_KEYS.CAPTURE_SHARED_POLICY,
      FEATURE_KEYS.CAPTURE_ENHANCEMENT,
    ]),
    subflows: Object.freeze([
      stage(CAPTURE_STAGE_KEYS.PAGE_DETECT, "页面识别"),
      stage(CAPTURE_STAGE_KEYS.DETAIL_CAPTURE, "关键词/排序维度识别", {
        contentActions: Object.freeze(["detectSearchSortDimension"]),
      }),
      stage(CAPTURE_STAGE_KEYS.SCROLL_LOAD, "搜索结果滚动加载", {
        referencedFeatureKey: FEATURE_KEYS.CAPTURE_SHARED_POLICY,
      }),
      stage(CAPTURE_STAGE_KEYS.LIST_PARSE, "搜索结果解析"),
      stage(CAPTURE_STAGE_KEYS.FILTER_APPLY, "互动阈值筛选"),
      stage(CAPTURE_STAGE_KEYS.RECORD_WRITE, "入池"),
      stage(CAPTURE_STAGE_KEYS.DETAIL_ENHANCE, "可选采集增强", {
        optional: true,
        referencedFeatureKey: FEATURE_KEYS.CAPTURE_ENHANCEMENT,
      }),
    ]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze([
          "handleCaptureSearchData",
          "handleBatchKeywordCapture",
        ]),
      }),
      Object.freeze({
        path: "utils/capture-sync.js",
        exports: Object.freeze([
          "captureAndSync",
          "batchCaptureByKeywords",
          "captureTabContent",
        ]),
      }),
      Object.freeze({
        path: "utils/capture/index.js",
        exports: Object.freeze([
          "captureKeywordNotes",
          "detectKeywordSortDimension",
        ]),
      }),
    ]),
    adapters: Object.freeze(
      PLATFORM_CAPTURE_ADAPTERS.map((adapter) =>
        Object.freeze({
          ...adapter,
          methods: Object.freeze([
            "captureKeywordNotes",
            "detectKeywordSortDimension",
          ]),
        }),
      ),
    ),
    backendApis: Object.freeze([]),
    storageKeys: Object.freeze([...COMMON_CAPTURE_STORAGE_KEYS]),
    captureSettingsKeys: Object.freeze([
      ...COMMON_CAPTURE_SETTINGS_KEYS,
      "KEYWORD_MAX_DETECTED_ITEMS",
      "KEYWORD_MIN_LIKES",
      "AUTO_DETAIL_CAPTURE_AFTER_LIST_CAPTURE",
    ]),
    analytics: Object.freeze({
      taskType: "capture",
      legacyFeatureKeys: Object.freeze([
        "xhs_keyword_notes_capture",
        "douyin_keyword_notes_capture",
      ]),
    }),
    diagnosticContract: Object.freeze({
      stageKeys: Object.freeze([
        CAPTURE_STAGE_KEYS.SCROLL_LOAD,
        CAPTURE_STAGE_KEYS.LIST_PARSE,
        CAPTURE_STAGE_KEYS.FILTER_APPLY,
        CAPTURE_STAGE_KEYS.DETAIL_ENHANCE,
      ]),
      requiredFields: Object.freeze([
        ...SCROLL_STAGE_CONTRACT,
        ...FILTER_STAGE_CONTRACT,
      ]),
    }),
    tests: Object.freeze([
      ...COMMON_CAPTURE_TESTS,
      "tests/e2e/capture/capture-stage-diagnostics.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.CAPTURE_COMMENTS,
    title: "评论采集",
    layer: FEATURE_LAYERS.PRIMARY_CAPTURE,
    priority: "P0",
    status: "mapped",
    summary: "在详情页采集评论并合并到单篇记录，可选评论客资筛选。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "noteTab",
      selectors: Object.freeze([
        "#checkboxCaptureComments",
        "#inputCommentsMaxDetectedItems",
        "#checkboxEnableCommentLeadsFilter",
      ]),
      handler: "handleCaptureCommentsToggleChange",
    }),
    pages: Object.freeze(["NOTE_DETAIL"]),
    messageTypes: Object.freeze(["RELAY_TO_CONTENT", "CAPTURE_PROGRESS"]),
    contentActions: Object.freeze(["captureComments", "cancelCapture"]),
    referencedCapabilities: Object.freeze([FEATURE_KEYS.CAPTURE_SHARED_POLICY]),
    referencedBy: Object.freeze([
      FEATURE_KEYS.CAPTURE_SINGLE_NOTE,
      FEATURE_KEYS.CAPTURE_ENHANCEMENT,
    ]),
    subflows: Object.freeze([
      stage(CAPTURE_STAGE_KEYS.PAGE_DETECT, "页面识别"),
      stage(CAPTURE_STAGE_KEYS.COMMENT_LOAD, "评论区定位与滚动加载", {
        referencedFeatureKey: FEATURE_KEYS.CAPTURE_SHARED_POLICY,
      }),
      stage(CAPTURE_STAGE_KEYS.COMMENT_LEADS_FILTER, "可选评论客资筛选", {
        optional: true,
      }),
      stage(CAPTURE_STAGE_KEYS.RECORD_WRITE, "合并记录"),
    ]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze([
          "handleCaptureCommentsToggleChange",
          "handleRetryCommentsCapture",
        ]),
      }),
      Object.freeze({
        path: "utils/capture-sync.js",
        exports: Object.freeze([
          "retryCommentsForRecord",
          "buildCommentLeadsPayloadForRecord",
        ]),
      }),
      Object.freeze({
        path: "utils/capture/index.js",
        exports: Object.freeze(["captureComments"]),
      }),
    ]),
    adapters: Object.freeze(
      PLATFORM_CAPTURE_ADAPTERS.map((adapter) =>
        Object.freeze({
          ...adapter,
          methods: Object.freeze(["captureComments"]),
        }),
      ),
    ),
    backendApis: Object.freeze(["SYNC", "SYNC_BATCH"]),
    storageKeys: Object.freeze([
      ...COMMON_CAPTURE_STORAGE_KEYS,
      "SYNC_HISTORY",
    ]),
    captureSettingsKeys: Object.freeze([
      "COMMENTS_MAX_DETECTED_ITEMS",
      "ENABLE_COMMENT_LEADS_FILTER",
      "COMMENT_LEADS_KEYWORDS",
      "COMMENT_LEADS_IPS",
    ]),
    analytics: Object.freeze({
      taskType: "capture",
      legacyFeatureKeys: Object.freeze([
        "xhs_comments_capture",
        "douyin_video_capture",
      ]),
    }),
    diagnosticContract: Object.freeze({
      stageKeys: Object.freeze([
        CAPTURE_STAGE_KEYS.COMMENT_LOAD,
        CAPTURE_STAGE_KEYS.COMMENT_LEADS_FILTER,
      ]),
      requiredFields: Object.freeze([
        "commentsMaxDetectedItems",
        "collectedCount",
        "uniqueCount",
        "commentContainerFound",
        "scrollCount",
        "stopReason",
      ]),
    }),
    tests: Object.freeze([
      "tests/e2e/capture/capture-single-note.spec.ts",
      "tests/e2e/capture/capture-stage-diagnostics.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.CAPTURE_ENHANCEMENT,
    title: "采集增强",
    layer: FEATURE_LAYERS.ENHANCEMENT_ORCHESTRATOR,
    priority: "P0",
    status: "mapped",
    summary: "基础列表采集后的外层补采编排，逐条打开详情页回填正文、账号指标、评论和客资等。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "bloggerTab/searchTab",
      selectors: Object.freeze(['data-detail-setting="auto"']),
      handler: "maybeRunAutoDetailCaptureAfterListCapture",
    }),
    pages: Object.freeze(["BLOGGER_PROFILE", "SEARCH_RESULTS"]),
    messageTypes: Object.freeze(["RELAY_TO_CONTENT", "CAPTURE_PROGRESS"]),
    contentActions: Object.freeze([
      "captureSingleNote",
      "captureComments",
      "cancelCapture",
    ]),
    referencedCapabilities: Object.freeze([
      FEATURE_KEYS.CAPTURE_SHARED_POLICY,
      FEATURE_KEYS.CAPTURE_COMMENTS,
    ]),
    referencedBy: Object.freeze([
      FEATURE_KEYS.CAPTURE_BLOGGER,
      FEATURE_KEYS.CAPTURE_SEARCH,
    ]),
    subflows: Object.freeze([
      stage(CAPTURE_STAGE_KEYS.DETAIL_ENHANCE, "增强编排与记录选择"),
      stage(CAPTURE_STAGE_KEYS.DETAIL_CAPTURE, "详情回填", {
        contentActions: Object.freeze(["captureSingleNote"]),
      }),
      stage(CAPTURE_STAGE_KEYS.BLOGGER_METRICS, "账号粉丝/获赞补采", {
        optional: true,
      }),
      stage(CAPTURE_STAGE_KEYS.LOW_FOLLOWER_FILTER, "低粉爆款筛选", {
        optional: true,
      }),
      stage(CAPTURE_STAGE_KEYS.COMMENT_LOAD, "附加评论采集", {
        optional: true,
        referencedFeatureKey: FEATURE_KEYS.CAPTURE_COMMENTS,
      }),
      stage(CAPTURE_STAGE_KEYS.COMMENT_LEADS_FILTER, "评论客资筛选", {
        optional: true,
      }),
      stage(CAPTURE_STAGE_KEYS.RECORD_WRITE, "回写记录"),
    ]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze([
          "maybeRunAutoDetailCaptureAfterListCapture",
          "runDetailCaptureForRecordIds",
        ]),
      }),
      Object.freeze({
        path: "utils/capture-sync.js",
        exports: Object.freeze([
          "batchCaptureDetailsForRecords",
          "captureTabContent",
        ]),
      }),
    ]),
    adapters: Object.freeze(
      PLATFORM_CAPTURE_ADAPTERS.map((adapter) =>
        Object.freeze({
          ...adapter,
          methods: Object.freeze(["captureSingleNote", "captureComments"]),
        }),
      ),
    ),
    backendApis: Object.freeze([]),
    storageKeys: Object.freeze([...COMMON_CAPTURE_STORAGE_KEYS]),
    captureSettingsKeys: Object.freeze([
      ...SHARED_POLICY_SETTINGS_KEYS,
      "AUTO_DETAIL_CAPTURE_AFTER_LIST_CAPTURE",
      "DETAIL_CAPTURE_SCOPE",
      "INCLUDE_COMMENTS_ON_DETAIL_CAPTURE",
      "INCLUDE_BLOGGER_METRICS_ON_DETAIL_CAPTURE",
      "DETAIL_COMMENTS_MAX_DETECTED_ITEMS",
      "ENABLE_COMMENT_LEADS_FILTER_ON_DETAIL_CAPTURE",
      "ENABLE_LOW_FOLLOWER_HIT_FILTER_ON_DETAIL_CAPTURE",
      "LOW_FOLLOWER_HIT_THRESHOLD_ON_DETAIL_CAPTURE",
    ]),
    analytics: Object.freeze({
      taskType: "capture",
      legacyFeatureKeys: Object.freeze(["detail_capture_enhancement"]),
    }),
    diagnosticContract: Object.freeze({
      stageKeys: Object.freeze([
        CAPTURE_STAGE_KEYS.DETAIL_ENHANCE,
        CAPTURE_STAGE_KEYS.DETAIL_CAPTURE,
        CAPTURE_STAGE_KEYS.BLOGGER_METRICS,
        CAPTURE_STAGE_KEYS.LOW_FOLLOWER_FILTER,
        CAPTURE_STAGE_KEYS.COMMENT_LOAD,
        CAPTURE_STAGE_KEYS.COMMENT_LEADS_FILTER,
      ]),
      requiredFields: Object.freeze([
        "targetCount",
        "processedCount",
        "successCount",
        "failedCount",
        "filteredCount",
        "failureStageSummary",
      ]),
    }),
    tests: Object.freeze([
      ...COMMON_CAPTURE_TESTS,
      "tests/e2e/capture/capture-stage-diagnostics.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.CAPTURE_SHARED_POLICY,
    title: "采集共享策略",
    layer: FEATURE_LAYERS.SHARED_CAPABILITY,
    priority: "P0",
    status: "mapped",
    summary: "为搜索、博主、评论和详情补采提供统一滚动、等待、无新增超时和打开详情页策略。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "settings",
      selectors: Object.freeze([
        "#inputSharedWaitMinSec",
        "#inputSharedWaitMaxSec",
        "#inputSharedStallTimeoutSec",
        "#inputSharedMaxDurationSec",
        "#inputDetailNavTimeoutMs",
        "#inputDetailAfterNavWaitMs",
      ]),
      handler: "handleCaptureSettingsInputChange",
    }),
    pages: Object.freeze([
      "NOTE_DETAIL",
      "BLOGGER_PROFILE",
      "SEARCH_RESULTS",
      "UNKNOWN",
    ]),
    messageTypes: Object.freeze(["CAPTURE_PROGRESS"]),
    contentActions: Object.freeze([]),
    referencedBy: Object.freeze([
      FEATURE_KEYS.CAPTURE_BLOGGER,
      FEATURE_KEYS.CAPTURE_SEARCH,
      FEATURE_KEYS.CAPTURE_COMMENTS,
      FEATURE_KEYS.CAPTURE_ENHANCEMENT,
    ]),
    subflows: Object.freeze([
      stage(CAPTURE_STAGE_KEYS.SCROLL_LOAD, "滚动加载"),
      stage(CAPTURE_STAGE_KEYS.DETAIL_ENHANCE, "详情打开/等待策略"),
    ]),
    modules: Object.freeze([
      Object.freeze({
        path: "utils/scroll.js",
        exports: Object.freeze(["autoScrollLoad"]),
      }),
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze(["handleSaveCaptureSettings"]),
      }),
    ]),
    adapters: Object.freeze([]),
    backendApis: Object.freeze([]),
    storageKeys: Object.freeze(["CAPTURE"]),
    captureSettingsKeys: Object.freeze([...SHARED_POLICY_SETTINGS_KEYS]),
    analytics: Object.freeze({
      taskType: "capture",
      legacyFeatureKeys: Object.freeze([]),
    }),
    diagnosticContract: Object.freeze({
      stageKeys: Object.freeze([
        CAPTURE_STAGE_KEYS.SCROLL_LOAD,
        CAPTURE_STAGE_KEYS.DETAIL_ENHANCE,
      ]),
      requiredFields: Object.freeze([
        ...SCROLL_STAGE_CONTRACT,
        "waitMinMs",
        "waitMaxMs",
        "stallTimeoutMs",
        "maxDurationMs",
      ]),
    }),
    tests: Object.freeze([
      ...COMMON_CAPTURE_TESTS,
      "tests/e2e/capture/capture-stage-diagnostics.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.KEYWORD_LONGTAIL,
    title: "长尾扩词",
    layer: FEATURE_LAYERS.ANALYSIS,
    priority: "P0",
    status: "mapped",
    summary: "从当前搜索词拉取平台联想词，并在授权后生成长尾需求分析。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "keywordStrategyLongtailPane",
      selectors: Object.freeze([
        "#btnToggleKeywordStrategy",
        "#btnKeywordStrategyTabLongtail",
        "#btnExpandKeywords",
        "#btnRunKeywordInsight",
      ]),
      handler: "handleExpandKeywords",
    }),
    pages: Object.freeze(["SEARCH_RESULTS"]),
    messageTypes: Object.freeze(["RELAY_TO_CONTENT"]),
    contentActions: Object.freeze(["expandKeywordSuggestions", "cancelCapture"]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze([
          "handleExpandKeywords",
          "startKeywordAnalysis",
        ]),
      }),
      Object.freeze({
        path: "utils/capture/keyword-expansion.js",
        exports: Object.freeze(["expandKeywordViaSuggestions"]),
      }),
      Object.freeze({
        path: "utils/api.js",
        exports: Object.freeze(["analyzeKeywords"]),
      }),
    ]),
    adapters: Object.freeze([
      Object.freeze({
        platform: "xiaohongshu",
        module: "utils/capture/keyword-expansion.js",
        methods: Object.freeze(["expandKeywordViaSuggestions"]),
      }),
      Object.freeze({
        platform: "douyin",
        module: "utils/capture/keyword-expansion.js",
        methods: Object.freeze(["expandKeywordViaSuggestions"]),
      }),
    ]),
    backendApis: Object.freeze(["KEYWORD_ANALYSIS"]),
    storageKeys: Object.freeze(["RUNTIME", "AUTH"]),
    captureSettingsKeys: Object.freeze([
      "KEYWORD_MAX_DETECTED_ITEMS",
      "KEYWORD_MIN_LIKES",
    ]),
    analytics: Object.freeze({
      taskType: "analysis",
      legacyFeatureKeys: Object.freeze(["keyword_longtail_insight"]),
    }),
    tests: Object.freeze([
      "tests/e2e/capture/keyword-expansion.spec.ts",
      "tests/e2e/smoke/extension-runtime.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.KEYWORD_OPPORTUNITY,
    title: "判断赛道机会",
    layer: FEATURE_LAYERS.ANALYSIS,
    priority: "P0",
    status: "mapped",
    summary: "采集当前搜索词样本和代表爆款详情，调用后端生成赛道机会判断。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "keywordStrategyOpportunityPane",
      selectors: Object.freeze([
        "#btnToggleKeywordStrategy",
        "#btnKeywordStrategyTabOpportunity",
        "#btnRunKeywordOpportunity",
      ]),
      handler: "handleRunKeywordOpportunity",
    }),
    pages: Object.freeze(["SEARCH_RESULTS"]),
    messageTypes: Object.freeze(["RELAY_TO_CONTENT", "CAPTURE_PROGRESS"]),
    contentActions: Object.freeze([
      "prepareKeywordStrategyCapture",
      "captureKeywordNotes",
      "captureSingleNote",
      "cancelCapture",
    ]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze([
          "handleRunKeywordOpportunity",
          "captureKeywordOpportunitySamples",
          "prepareKeywordStrategyCapture",
        ]),
      }),
      Object.freeze({
        path: "utils/capture-sync.js",
        exports: Object.freeze(["captureTabContent"]),
      }),
      Object.freeze({
        path: "utils/api.js",
        exports: Object.freeze(["analyzeKeywordOpportunity"]),
      }),
    ]),
    adapters: Object.freeze(
      PLATFORM_CAPTURE_ADAPTERS.map((adapter) =>
        Object.freeze({
          ...adapter,
          methods: Object.freeze(["captureKeywordNotes", "captureSingleNote"]),
        }),
      ),
    ),
    backendApis: Object.freeze(["KEYWORD_OPPORTUNITY"]),
    storageKeys: Object.freeze(["RUNTIME", "AUTH"]),
    captureSettingsKeys: Object.freeze([...COMMON_CAPTURE_SETTINGS_KEYS]),
    analytics: Object.freeze({
      taskType: "analysis",
      legacyFeatureKeys: Object.freeze(["keyword_opportunity"]),
    }),
    tests: Object.freeze([
      "tests/e2e/smoke/extension-runtime.spec.ts",
      "tests/e2e/capture/capture-stage-diagnostics.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.BENCHMARK_ACCOUNT_DISCOVERY,
    title: "找对标账号",
    layer: FEATURE_LAYERS.ANALYSIS,
    priority: "P0",
    status: "mapped",
    summary:
      "从当前主词搜索样本中聚合入围账号，补采账号主页资料，并调用 AI 生成轻量账号画像推荐理由。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "keywordStrategyBenchmarkPane",
      selectors: Object.freeze([
        "#btnToggleKeywordStrategy",
        "#btnKeywordStrategyTabBenchmark",
        "#btnRunBenchmarkDiscovery",
      ]),
      handler: "handleRunBenchmarkDiscovery",
    }),
    pages: Object.freeze(["SEARCH_RESULTS"]),
    messageTypes: Object.freeze(["RELAY_TO_CONTENT", "CAPTURE_PROGRESS"]),
    contentActions: Object.freeze([
      "prepareKeywordStrategyCapture",
      "captureKeywordNotes",
      "captureBloggerProfile",
      "cancelCapture",
    ]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze([
          "handleRunBenchmarkDiscovery",
          "buildBenchmarkDiscoveryCandidates",
          "captureBenchmarkCandidateProfiles",
          "enrichBenchmarkDiscoveryWithAi",
        ]),
      }),
      Object.freeze({
        path: "utils/capture-sync.js",
        exports: Object.freeze(["captureTabContent"]),
      }),
      Object.freeze({
        path: "utils/api.js",
        exports: Object.freeze(["analyzeBenchmarkDiscovery"]),
      }),
    ]),
    adapters: Object.freeze(
      PLATFORM_CAPTURE_ADAPTERS.map((adapter) =>
        Object.freeze({
          ...adapter,
          methods: Object.freeze(["captureKeywordNotes", "captureBloggerProfile"]),
        }),
      ),
    ),
    backendApis: Object.freeze(["BENCHMARK_DISCOVERY"]),
    storageKeys: Object.freeze(["RUNTIME", "AUTH", "MONITOR"]),
    captureSettingsKeys: Object.freeze([...COMMON_CAPTURE_SETTINGS_KEYS]),
    analytics: Object.freeze({
      taskType: "analysis",
      legacyFeatureKeys: Object.freeze(["benchmark_account_discovery"]),
    }),
    tests: Object.freeze([
      "tests/e2e/smoke/extension-runtime.spec.ts",
      "tests/e2e/capture/capture-stage-diagnostics.spec.ts",
      "tests/e2e/capture/benchmark-discovery.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.SYNC_LARK,
    title: "同步飞书",
    layer: FEATURE_LAYERS.SYNC,
    priority: "P0",
    status: "mapped",
    summary: "将数据池记录同步到飞书多维表，并记录同步历史和调试链接。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "mainPoolPanel",
      selectors: Object.freeze(["#btnSyncAll"]),
      handler: "handleSyncAll",
    }),
    pages: Object.freeze([
      "NOTE_DETAIL",
      "BLOGGER_PROFILE",
      "SEARCH_RESULTS",
      "UNKNOWN",
    ]),
    messageTypes: Object.freeze([]),
    contentActions: Object.freeze([]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze(["handleSyncAll"]),
      }),
      Object.freeze({
        path: "utils/capture-sync.js",
        exports: Object.freeze([
          "checkBeforeSync",
          "syncRecord",
          "syncRecordBatch",
          "appendFrontendSyncFailureHistory",
        ]),
      }),
      Object.freeze({
        path: "utils/api.js",
        exports: Object.freeze(["sync", "syncBatch", "verify"]),
      }),
    ]),
    adapters: Object.freeze([]),
    backendApis: Object.freeze(["VERIFY", "TARGET", "SYNC", "SYNC_BATCH"]),
    storageKeys: Object.freeze([
      "AUTH",
      "TARGET",
      "DATA_POOL",
      "SYNC",
      "SYNC_HISTORY",
    ]),
    captureSettingsKeys: Object.freeze([
      "SYNC_SCOPE",
      "COMMENT_LEADS_KEYWORDS",
      "COMMENT_LEADS_IPS",
    ]),
    analytics: Object.freeze({
      taskType: "sync",
      legacyFeatureKeys: Object.freeze(["sync_to_lark"]),
    }),
    tests: Object.freeze([
      "tests/e2e/smoke/extension-runtime.spec.ts",
      "tests/e2e/sync/sync-record-batch.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.EXPORT_CSV,
    title: "导出",
    layer: FEATURE_LAYERS.EXPORT,
    priority: "P0",
    status: "mapped",
    summary: "将当前数据池视图导出为内容 CSV，可选导出评论客资 CSV。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "mainPoolPanel",
      selectors: Object.freeze(["#btnExport"]),
      handler: "handleExport",
    }),
    pages: Object.freeze([
      "NOTE_DETAIL",
      "BLOGGER_PROFILE",
      "SEARCH_RESULTS",
      "UNKNOWN",
    ]),
    messageTypes: Object.freeze([]),
    contentActions: Object.freeze([]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze([
          "handleExport",
          "downloadCsvRowsByChrome",
          "buildCurrentPageCsvRows",
        ]),
      }),
    ]),
    adapters: Object.freeze([]),
    backendApis: Object.freeze([]),
    storageKeys: Object.freeze(["DATA_POOL"]),
    captureSettingsKeys: Object.freeze([
      "COMMENT_LEADS_KEYWORDS",
      "COMMENT_LEADS_IPS",
    ]),
    analytics: Object.freeze({
      taskType: "export",
      legacyFeatureKeys: Object.freeze(["export_csv"]),
    }),
    tests: Object.freeze([
      "tests/e2e/smoke/extension-runtime.spec.ts",
      "tests/e2e/smoke/export-csv.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.MONITOR_ACCOUNT,
    title: "账号监控",
    layer: FEATURE_LAYERS.MONITOR,
    priority: "P0",
    status: "mapped",
    summary: "把当前账号纳入监控、读取监控列表，并支持立即执行扫描。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "monitorTab",
      selectors: Object.freeze(["#btnMonitorAddCurrent", "#btnMonitorRunNow"]),
      handler: "handleAddCurrentMonitor",
    }),
    pages: Object.freeze(["BLOGGER_PROFILE", "UNKNOWN"]),
    messageTypes: Object.freeze(["RELAY_TO_CONTENT"]),
    contentActions: Object.freeze(["captureBloggerProfile"]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze([
          "handleAddCurrentMonitor",
          "handleRunMonitorNow",
          "loadMonitorSubscriptions",
          "captureCurrentMonitorCandidate",
        ]),
      }),
      Object.freeze({
        path: "utils/api.js",
        exports: Object.freeze([
          "createMonitorSubscription",
          "listMonitorSubscriptions",
          "runMonitorNow",
          "listMonitorExecutions",
          "listMonitorHits",
          "getMonitorSettings",
          "saveMonitorSettings",
          "updateMonitorSubscription",
        ]),
      }),
    ]),
    adapters: Object.freeze(
      PLATFORM_CAPTURE_ADAPTERS.map((adapter) =>
        Object.freeze({
          ...adapter,
          methods: Object.freeze(["captureBloggerProfile"]),
        }),
      ),
    ),
    backendApis: Object.freeze([
      "MONITOR_SUBSCRIPTIONS",
      "MONITOR_EXECUTIONS",
      "MONITOR_SETTINGS",
      "MONITOR_HITS",
      "MONITOR_RUN_NOW",
    ]),
    storageKeys: Object.freeze(["AUTH", "MONITOR", "TARGET"]),
    analytics: Object.freeze({
      taskType: "monitor",
      legacyFeatureKeys: Object.freeze(["account_monitor"]),
    }),
    tests: Object.freeze([
      "tests/e2e/smoke/extension-runtime.spec.ts",
      "tests/e2e/monitor/monitor-shell.spec.ts",
    ]),
  }),
  Object.freeze({
    featureKey: FEATURE_KEYS.DIAGNOSTICS_COPY,
    title: "复制诊断信息",
    layer: FEATURE_LAYERS.DIAGNOSTICS,
    priority: "P0",
    status: "mapped",
    summary: "从 sidebar 复制脱敏诊断信息，用于排查最近操作、错误和任务上下文。",
    entry: Object.freeze({
      surface: "sidebar",
      tab: "historyTab",
      selectors: Object.freeze(["#btnCopyDiagnostics"]),
      handler: "handleCopyDiagnostics",
    }),
    pages: Object.freeze([
      "NOTE_DETAIL",
      "BLOGGER_PROFILE",
      "SEARCH_RESULTS",
      "UNKNOWN",
    ]),
    messageTypes: Object.freeze([]),
    contentActions: Object.freeze([]),
    modules: Object.freeze([
      Object.freeze({
        path: "sidebar/sidebar-logic.js",
        functions: Object.freeze(["handleCopyDiagnostics"]),
      }),
      Object.freeze({
        path: "utils/diagnostics.js",
        exports: Object.freeze([
          "buildDiagnosticsText",
          "buildDiagnosticsReport",
          "recordDiagnosticAction",
          "recordDiagnosticError",
          "recordDiagnosticStage",
          "recordDiagnosticTask",
        ]),
      }),
      Object.freeze({
        path: "utils/task-context.js",
        exports: Object.freeze([
          "beginTaskContext",
          "serializeTaskContext",
          "appendTaskContext",
        ]),
      }),
    ]),
    adapters: Object.freeze([]),
    backendApis: Object.freeze([]),
    storageKeys: Object.freeze([
      "RUNTIME",
      "AUTH",
      "CAPTURE",
      "SYNC",
      "MONITOR",
      "DATA_POOL",
      "DIAGNOSTICS",
    ]),
    analytics: Object.freeze({
      taskType: "diagnostics",
      legacyFeatureKeys: Object.freeze(["diagnostics.copy"]),
    }),
    tests: Object.freeze([
      "tests/e2e/smoke/extension-runtime.spec.ts",
      "tests/e2e/smoke/diagnostics-copy.spec.ts",
      "tests/e2e/capture/capture-stage-diagnostics.spec.ts",
    ]),
  }),
]);

function listFeatureDefinitions() {
  return FEATURE_REGISTRY;
}

function getFeatureDefinition(featureKey) {
  return FEATURE_REGISTRY.find((feature) => feature.featureKey === featureKey) || null;
}

function resolveCanonicalFeatureKey(featureKey) {
  const normalized = String(featureKey || "").trim();
  if (!normalized) return "";
  const direct = getFeatureDefinition(normalized);
  if (direct) return direct.featureKey;

  const matched = FEATURE_REGISTRY.find((feature) =>
    Array.isArray(feature.analytics?.legacyFeatureKeys) &&
    feature.analytics.legacyFeatureKeys.includes(normalized),
  );
  return matched?.featureKey || normalized;
}

export {
  CAPTURE_STAGE_KEYS,
  FEATURE_KEYS,
  FEATURE_LAYERS,
  FEATURE_REGISTRY,
  FEATURE_REGISTRY_VERSION,
  getFeatureDefinition,
  listFeatureDefinitions,
  resolveCanonicalFeatureKey,
};
