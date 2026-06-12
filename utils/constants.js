/**
 * OnStarVoice V1.0 Constants
 * 统一常量定义，避免魔法字符串
 */

// ==================== 页面类型 ====================
export const PAGE_TYPE = {
  NOTE_DETAIL: "note_detail",
  BLOGGER_PROFILE: "blogger_profile",
  SEARCH_RESULTS: "search_results",
  UNSUPPORTED: "unsupported",
  UNKNOWN: "unknown",
};

// ==================== 同步类型 ====================
export const SYNC_TYPE = {
  SINGLE_NOTE: "single_note",
  BLOGGER_PROFILE: "blogger_profile",
  BLOGGER_NOTES: "blogger_notes",
  KEYWORD_NOTES: "keyword_notes",
  COMMENTS: "comments",
  COMMENT_LEADS: "comment_leads",
};

// ==================== 鉴权状态 ====================
export const AUTH_STATUS = {
  IDLE: "idle",
  VERIFYING: "verifying",
  VERIFIED: "verified",
  FAILED: "failed",
};

// ==================== 采集状态 ====================
export const CAPTURE_STATUS = {
  IDLE: "idle",
  CAPTURING: "capturing",
  SUCCESS: "success",
  FAILED: "failed",
  CANCELED: "canceled",
};

// ==================== 采集进度阶段 ====================
export const CAPTURE_PHASE = {
  IDLE: "idle",
  CHECKING_PAGE: "checking_page",
  PREPARING: "preparing",
  SCROLLING: "scrolling",
  WAITING: "waiting",
  EXTRACTING: "extracting",
  NORMALIZING: "normalizing",
  DONE: "done",
};

// ==================== 同步状态 ====================
export const SYNC_STATUS = {
  IDLE: "idle",
  VERIFYING: "verifying",
  SYNCING: "syncing",
  SUCCESS: "success",
  FAILED: "failed",
};

// ==================== 数据池记录状态 ====================
export const RECORD_STATUS = {
  DRAFT: "draft",
  SYNCED: "synced",
  FAILED: "failed",
};

// ==================== 错误码 ====================
export const ERROR_REASON = {
  // 通用错误码
  NONE: "none",
  INVALID_REQUEST: "invalid_request",
  SERVER_ERROR: "server_error",
  NETWORK_ERROR: "network_error",
  NOT_FOUND: "not_found",
  FORBIDDEN: "forbidden",
  TIMEOUT: "timeout",

  // 鉴权错误码
  EXPIRED: "expired",
  FROZEN: "frozen",
  BINDING_LIMIT_REACHED: "binding_limit_reached",

  // 同步错误码
  VERIFY_FAILED: "verify_failed",
  INVALID_PAYLOAD: "invalid_payload",
  COZE_FAILED: "coze_failed",

  // 采集错误码
  SELECTOR_NOT_FOUND: "selector_not_found",
  PAGE_TYPE_MISMATCH: "page_type_mismatch",
  DATA_EXTRACTION_FAILED: "data_extraction_failed",
};

// ==================== 存储 Key ====================
export const STORAGE_KEY = {
  RUNTIME: "onstarvoice.runtime",
  AUTH: "onstarvoice.auth",
  TARGET: "onstarvoice.target",
  CAPTURE: "onstarvoice.capture",
  SYNC: "onstarvoice.sync",
  MONITOR: "onstarvoice.monitor",
  DATA_POOL: "onstarvoice.data_pool",
  SYNC_HISTORY: "onstarvoice.sync_history",
  DIAGNOSTICS: "onstarvoice.diagnostics",
};

// ==================== 消息类型 ====================
export const MESSAGE_TYPE = {
  // 侧边栏相关
  OPEN_SIDE_PANEL: "onstarvoice:open-side-panel",
  SWITCH_PLATFORM_TAB: "onstarvoice:switch-platform-tab",

  // 运行时信息
  GET_CLIENT_ENV: "onstarvoice:get-client-env",
  GET_EXTENSION_STATE: "onstarvoice:get-extension-state",

  // 内容脚本通信
  RELAY_TO_CONTENT: "onstarvoice:relay-to-content",
  CAPTURE_PROGRESS: "onstarvoice:capture-progress",

  // 采集指令
  CAPTURE_SINGLE_NOTE: "onstarvoice:capture-single-note",
  CAPTURE_BLOGGER_PROFILE: "onstarvoice:capture-blogger-profile",
  CAPTURE_BLOGGER_NOTES: "onstarvoice:capture-blogger-notes",
  CAPTURE_KEYWORD_NOTES: "onstarvoice:capture-keyword-notes",
  CAPTURE_COMMENTS: "onstarvoice:capture-comments",
  CANCEL_CAPTURE: "onstarvoice:cancel-capture",

  // 错误上报
  RUNTIME_ERROR: "onstarvoice:runtime-error",
};

// ==================== API 端点 ====================
export const API_ENDPOINT = {
  VERIFY: "/api/verify",
  SYNC: "/api/sync",
  SYNC_BATCH: "/api/sync/batch",
  TARGET: "/api/target",
  UPDATE_MANIFEST: "/api/update-manifest",
  KEYWORD_ANALYSIS: "/api/keyword-analysis",
  KEYWORD_OPPORTUNITY: "/api/keyword-opportunity",
  BENCHMARK_DISCOVERY: "/api/benchmark-discovery",
  MONITOR_SUBSCRIPTIONS: "/api/monitor/subscriptions",
  MONITOR_EXECUTIONS: "/api/monitor/executions",
  MONITOR_SETTINGS: "/api/monitor/settings",
  MONITOR_HITS: "/api/monitor/hits",
  MONITOR_RUN_NOW: "/api/monitor/run-now",
};

// ==================== 激活码绑定相关 ====================
export const UNCLAIMED_CREDENTIAL_OWNER_EMAIL =
  "system+unclaimed-credential@onstarvoice.local";
export const UNCLAIMED_CREDENTIAL_OWNER_NAME = "Unclaimed Credential Owner";
export const UNCLAIMED_CREDENTIAL_OWNER_LABEL = "系统未绑定账号";
export const CREDENTIAL_CLAIM_PAGE_URL =
  "https://onstarvoice.local/account/credentials";

// ==================== 默认配置 ====================
export const DEFAULT_CONFIG = {
  APP_VERSION: "2.0.0",
  MAX_RETRY: 3,
  REQUEST_TIMEOUT: 30000, // 30秒
  KEYWORD_ANALYSIS_TIMEOUT: 240000, // 4分钟，给慢模型和网络波动留出缓冲
  KEYWORD_OPPORTUNITY_TIMEOUT: 240000, // 4分钟，覆盖主词机会判断
  BENCHMARK_DISCOVERY_TIMEOUT: 180000, // 3分钟，覆盖赛道策略账号推荐理由
  MONITOR_RUN_NOW_TIMEOUT: 180000, // 3分钟，覆盖监控立即执行场景

  // 采集配置
  SCROLL_DELAY_MIN: 1000,
  SCROLL_DELAY_MAX: 3000,
  MAX_SCROLL_TIMES: 50,
  NO_NEW_CONTENT_THRESHOLD: 3,
  MAX_CAPTURE_DURATION_MS: 10 * 60 * 1000,
};

// ==================== URL 匹配规则 ====================
export const URL_PATTERN = {
  NOTE_DETAIL:
    /xiaohongshu\.com\/(?:explore|discovery\/item|note|video|search_result)\/[a-zA-Z0-9_-]+(?:[/?#]|$)|xiaohongshu\.com\/user\/profile\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+(?:[/?#]|$)/i,
  BLOGGER_PROFILE: /xiaohongshu\.com\/user\/profile\//,
  SEARCH_RESULTS:
    /xiaohongshu\.com\/(?:search_result|web\/search_result|search\/result)(?:[/?#]|$)|xiaohongshu\.com\/[^\s]*[?#][^\s]*\bkeyword=/i,
  DISCOVERY: /xiaohongshu\.com\/(?:explore|discovery)(?:[/?#]|$)/i,
};

// ==================== 笔记类型 ====================
export const NOTE_TYPE = {
  IMAGE: "image",
  VIDEO: "video",
};

// ==================== 错误提示映射 ====================
export const ERROR_MESSAGE_MAP = {
  // 通用错误
  [ERROR_REASON.NONE]: "操作成功",
  [ERROR_REASON.INVALID_REQUEST]: "请求参数无效，请检查输入",
  [ERROR_REASON.SERVER_ERROR]: "服务器错误，请稍后重试",
  [ERROR_REASON.NETWORK_ERROR]: "网络连接失败，请检查网络连接后重试",
  [ERROR_REASON.NOT_FOUND]: "资源不存在",
  [ERROR_REASON.FORBIDDEN]: "无权限访问",
  [ERROR_REASON.TIMEOUT]: "请求超时，请稍后重试",

  // 鉴权相关错误
  [ERROR_REASON.EXPIRED]:
    "激活码已过期，请续费或联系管理员获取新激活码。",
  [ERROR_REASON.FROZEN]:
    "激活码已被冻结，请联系管理员处理。",
  [ERROR_REASON.BINDING_LIMIT_REACHED]:
    "当前激活码绑定环境已满。可替换旧环境，或联系管理员获取新激活码。",
  [ERROR_REASON.VERIFY_FAILED]: "激活码验证失败，请检查激活码是否正确",
  "NOT_VERIFIED":
    "当前功能需要激活码授权，已有激活码请在设置中完成验证；还没有可联系管理员获取。",
  "INVALID_CODE": "激活码格式不正确，请重新输入",

  // 配置相关错误
  [ERROR_REASON.INVALID_PAYLOAD]: "数据格式错误，请检查配置",
  "INVALID_TARGET": "请先配置数据同步目标信息",
  "MISSING_CONFIG": "配置信息不完整，请检查所有必填项",

  // 采集相关错误
  [ERROR_REASON.SELECTOR_NOT_FOUND]:
    "页面元素未找到，可能是平台页面改版，请联系开发者更新",
  [ERROR_REASON.PAGE_TYPE_MISMATCH]:
    "当前页面类型不支持此操作，请切换到正确的页面",
  [ERROR_REASON.DATA_EXTRACTION_FAILED]: "数据提取失败，请刷新页面后重试",
  "CAPTURE_FAILED": "采集失败，请确保页面完全加载后重试",
  "CAPTURE_CANCELED": "采集已取消",
  "UNSUPPORTED_PAGE":
    "当前页面不支持采集，请在笔记/作品详情页、博主主页或搜索结果页使用",
  "ELEMENT_NOT_FOUND": "未找到目标元素，请确保页面完全加载",
  "NO_CONTENT": "未检测到可采集的内容",

  // 同步相关错误
  [ERROR_REASON.COZE_FAILED]: "同步服务异常，请稍后重试",
  "SYNC_ERROR": "同步失败，请检查网络连接和配置",
  "SYNC_TIMEOUT": "同步超时，请稍后重试",
  "BATCH_SYNC_PARTIAL_FAILURE": "部分记录同步失败，请查看详情",
  "COMMENT_LEADS_SYNC_FAILED": "内容表已同步，客资表同步失败",
  "NO_RECORDS_TO_SYNC": "没有可同步的记录",

  // 数据池相关错误
  "RECORD_NOT_FOUND": "记录不存在",
  "POOL_EMPTY": "数据池为空",
  "DUPLICATE_RECORD": "记录已存在",

  // 其他错误
  "UNEXPECTED_ERROR": "请刷新当前网页后重试",
  "CHECK_FAILED": "检查失败",
  "UNKNOWN_ACTION": "未知操作",
};
