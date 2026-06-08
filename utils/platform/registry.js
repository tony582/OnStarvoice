import {PAGE_TYPE} from "../constants.js";

export const FALLBACK_PLATFORM = "unknown";

const DEFAULT_SINGLE_NOTE_METRICS = Object.freeze([
  {key: "likes", label: "点赞"},
  {key: "collects", label: "收藏"},
  {key: "comments", label: "评论"},
]);

const DOUYIN_SINGLE_NOTE_METRICS = Object.freeze([
  {key: "likes", label: "点赞"},
  {key: "comments", label: "评论"},
  {key: "collects", label: "收藏"},
  {key: "shares", label: "转发"},
]);

export const PLATFORM_REGISTRY = Object.freeze({
  unknown: Object.freeze({
    id: "unknown",
    label: "未识别平台",
    icon: "unknown",
    matchers: {
      hosts: [],
    },
    pageTypes: [
      PAGE_TYPE.NOTE_DETAIL,
      PAGE_TYPE.BLOGGER_PROFILE,
      PAGE_TYPE.SEARCH_RESULTS,
    ],
    pageTypeRouting: {
      [PAGE_TYPE.NOTE_DETAIL]: "noteTab",
      [PAGE_TYPE.BLOGGER_PROFILE]: "bloggerTab",
      [PAGE_TYPE.SEARCH_RESULTS]: "searchTab",
    },
    tabs: Object.freeze([
      Object.freeze({
        id: "noteTab",
        label: "内容页",
        recordTypes: Object.freeze(["single_note", "comments"]),
        disabled: false,
        disabledReason: "",
        pageTypes: Object.freeze([PAGE_TYPE.NOTE_DETAIL]),
      }),
      Object.freeze({
        id: "bloggerTab",
        label: "主页",
        recordTypes: Object.freeze(["blogger_profile", "blogger_notes"]),
        disabled: false,
        disabledReason: "",
        pageTypes: Object.freeze([PAGE_TYPE.BLOGGER_PROFILE]),
      }),
      Object.freeze({
        id: "searchTab",
        label: "搜索页",
        recordTypes: Object.freeze(["keyword_notes"]),
        disabled: false,
        disabledReason: "",
        pageTypes: Object.freeze([PAGE_TYPE.SEARCH_RESULTS]),
      }),
    ]),
    capabilities: Object.freeze({
      captureNote: true,
      captureComments: true,
      captureBlogger: true,
      captureSearch: true,
      batchDetailCapture: false,
      bloggerMetrics: false,
    }),
    ui: Object.freeze({
      copy: Object.freeze({
        label: "未识别平台",
        notePageLabel: "内容详情页",
        bloggerPageLabel: "主页",
        searchPageLabel: "搜索页",
        noteReadyText: "已就绪：当前是内容详情页，可开始采集",
        noteWrongText: "请前往当前平台的内容详情页以开始采集",
        bloggerReadyText: "已就绪：当前是主页，可开始采集主页数据",
        bloggerWrongText: "请前往当前平台的主页以开始采集",
        searchReadyText: "已就绪：当前是搜索页，可开始采集搜索结果",
        searchWrongText: "请前往当前平台的搜索页以开始采集",
        captureNoteButtonText: "采集内容数据",
        captureBloggerButtonText: "采集主页数据",
        captureSearchButtonText: "采集搜索结果",
      }),
      metricDefinitions: Object.freeze({
        singleNote: DEFAULT_SINGLE_NOTE_METRICS,
      }),
      emptyStates: Object.freeze({}),
    }),
    sync: Object.freeze({
      strategy: "shared",
      workflowMap: Object.freeze({}),
    }),
  }),
  xiaohongshu: Object.freeze({
    id: "xiaohongshu",
    label: "小红书",
    icon: "xhs",
    matchers: {
      hosts: Object.freeze(["xiaohongshu.com"]),
    },
    pageTypes: Object.freeze([
      PAGE_TYPE.NOTE_DETAIL,
      PAGE_TYPE.BLOGGER_PROFILE,
      PAGE_TYPE.SEARCH_RESULTS,
    ]),
    pageTypeRouting: Object.freeze({
      [PAGE_TYPE.NOTE_DETAIL]: "noteTab",
      [PAGE_TYPE.BLOGGER_PROFILE]: "bloggerTab",
      [PAGE_TYPE.SEARCH_RESULTS]: "searchTab",
    }),
    tabs: Object.freeze([
      Object.freeze({
        id: "noteTab",
        label: "笔记页",
        recordTypes: Object.freeze(["single_note", "comments"]),
        disabled: false,
        disabledReason: "",
        pageTypes: Object.freeze([PAGE_TYPE.NOTE_DETAIL]),
      }),
      Object.freeze({
        id: "bloggerTab",
        label: "博主页",
        recordTypes: Object.freeze(["blogger_profile", "blogger_notes"]),
        disabled: false,
        disabledReason: "",
        pageTypes: Object.freeze([PAGE_TYPE.BLOGGER_PROFILE]),
      }),
      Object.freeze({
        id: "searchTab",
        label: "搜索页",
        recordTypes: Object.freeze(["keyword_notes"]),
        disabled: false,
        disabledReason: "",
        pageTypes: Object.freeze([PAGE_TYPE.SEARCH_RESULTS]),
      }),
      Object.freeze({
        id: "monitorTab",
        label: "对标监控",
        recordTypes: Object.freeze([]),
        disabled: false,
        disabledReason: "",
        pageTypes: Object.freeze([]),
      }),
    ]),
    capabilities: Object.freeze({
      captureNote: true,
      captureComments: true,
      captureBlogger: true,
      captureSearch: true,
      batchDetailCapture: true,
      bloggerMetrics: true,
    }),
    ui: Object.freeze({
      copy: Object.freeze({
        label: "小红书",
        notePageLabel: "笔记详情页",
        bloggerPageLabel: "博主主页",
        searchPageLabel: "搜索页",
        noteReadyText: "已就绪：当前是笔记详情页，可直接采集笔记和评论",
        noteWrongText: "请前往小红书笔记详情页以开始采集",
        bloggerReadyText: "已就绪：当前是博主页，可采集博主信息和笔记",
        bloggerWrongText: "请前往小红书博主主页以开始采集",
        searchReadyText: "已就绪：当前是搜索页，可采集搜索结果",
        searchWrongText: "请前往小红书搜索页以开始采集",
        captureNoteButtonText: "采集笔记数据",
        captureBloggerButtonText: "采集博主信息&笔记",
        captureSearchButtonText: "采集搜索结果",
      }),
      metricDefinitions: Object.freeze({
        singleNote: DEFAULT_SINGLE_NOTE_METRICS,
      }),
      emptyStates: Object.freeze({}),
    }),
    sync: Object.freeze({
      strategy: "shared",
      workflowMap: Object.freeze({
        single_note: "shared_single_note",
        blogger_profile: "shared_blogger_profile",
      }),
    }),
  }),
  douyin: Object.freeze({
    id: "douyin",
    label: "抖音",
    icon: "douyin",
    matchers: {
      hosts: Object.freeze(["douyin.com"]),
    },
    pageTypes: Object.freeze([
      PAGE_TYPE.NOTE_DETAIL,
      PAGE_TYPE.BLOGGER_PROFILE,
      PAGE_TYPE.SEARCH_RESULTS,
    ]),
    pageTypeRouting: Object.freeze({
      [PAGE_TYPE.NOTE_DETAIL]: "noteTab",
      [PAGE_TYPE.BLOGGER_PROFILE]: "bloggerTab",
      [PAGE_TYPE.SEARCH_RESULTS]: "searchTab",
    }),
    tabs: Object.freeze([
      Object.freeze({
        id: "noteTab",
        label: "作品页",
        recordTypes: Object.freeze(["single_note", "comments"]),
        disabled: false,
        disabledReason: "",
        pageTypes: Object.freeze([PAGE_TYPE.NOTE_DETAIL]),
      }),
      Object.freeze({
        id: "bloggerTab",
        label: "账号页",
        recordTypes: Object.freeze(["blogger_profile", "blogger_notes"]),
        disabled: false,
        disabledReason: "",
        pageTypes: Object.freeze([PAGE_TYPE.BLOGGER_PROFILE]),
      }),
      Object.freeze({
        id: "searchTab",
        label: "搜索页",
        recordTypes: Object.freeze(["keyword_notes"]),
        disabled: false,
        disabledReason: "",
        pageTypes: Object.freeze([PAGE_TYPE.SEARCH_RESULTS]),
      }),
      Object.freeze({
        id: "monitorTab",
        label: "对标监控",
        recordTypes: Object.freeze([]),
        disabled: false,
        disabledReason: "",
        pageTypes: Object.freeze([]),
      }),
    ]),
    capabilities: Object.freeze({
      captureNote: true,
      captureComments: true,
      captureBlogger: true,
      captureSearch: true,
      batchDetailCapture: true,
      bloggerMetrics: true,
    }),
    ui: Object.freeze({
      copy: Object.freeze({
        label: "抖音",
        notePageLabel: "作品详情页",
        bloggerPageLabel: "账号主页",
        searchPageLabel: "搜索页",
        noteReadyText: "已就绪：当前是作品详情态，可直接采集作品数据",
        noteWrongText: "请前往抖音作品详情页面后再采集",
        bloggerReadyText: "已就绪：当前是账号主页，可采集账号信息和作品",
        bloggerWrongText: "请前往抖音账号主页以开始采集",
        searchReadyText: "已就绪：当前是抖音精选/搜索结果页，可采集作品列表",
        searchWrongText: "请前往抖音精选搜索页或搜索结果页以开始采集",
        captureNoteButtonText: "采集作品数据",
        captureBloggerButtonText: "采集账号信息&作品",
        captureSearchButtonText: "采集搜索结果",
      }),
      metricDefinitions: Object.freeze({
        singleNote: DOUYIN_SINGLE_NOTE_METRICS,
      }),
      emptyStates: Object.freeze({}),
    }),
    sync: Object.freeze({
      strategy: "shared_or_platform_specific",
      workflowMap: Object.freeze({
        single_note: "shared_single_note",
        blogger_profile: "shared_blogger_profile",
      }),
    }),
  }),
});

function cloneTab(tab) {
  return {
    ...tab,
    recordTypes: Array.isArray(tab.recordTypes) ? [...tab.recordTypes] : [],
    pageTypes: Array.isArray(tab.pageTypes) ? [...tab.pageTypes] : [],
  };
}

function cloneMetricDefinitions(definitions = []) {
  return definitions.map((definition) => ({...definition}));
}

export function normalizePlatformId(platform) {
  const normalized = String(platform || "")
    .trim()
    .toLowerCase();
  if (normalized && PLATFORM_REGISTRY[normalized]) {
    return normalized;
  }
  return FALLBACK_PLATFORM;
}

export function getPlatformConfig(platform) {
  return (
    PLATFORM_REGISTRY[normalizePlatformId(platform)] ||
    PLATFORM_REGISTRY.unknown
  );
}

export function getPlatformCaptureTabs(platform) {
  return getPlatformConfig(platform).tabs.map(cloneTab);
}

export function getPlatformCopy(platform) {
  return {...getPlatformConfig(platform).ui.copy};
}

export function getPlatformCapabilities(platform) {
  return {...getPlatformConfig(platform).capabilities};
}

export function getPreferredTabForPageType(platform, pageType) {
  const config = getPlatformConfig(platform);
  return config.pageTypeRouting[pageType] || config.tabs[0]?.id || "noteTab";
}

export function getRecordTypesForTab(platform, tabId) {
  const match = getPlatformConfig(platform).tabs.find(
    (tab) => tab.id === tabId,
  );
  return Array.isArray(match?.recordTypes) ? [...match.recordTypes] : [];
}

export function getSingleNoteMetricDefinitions(platform) {
  const metrics =
    getPlatformConfig(platform).ui.metricDefinitions?.singleNote ||
    DEFAULT_SINGLE_NOTE_METRICS;
  return cloneMetricDefinitions(metrics);
}
