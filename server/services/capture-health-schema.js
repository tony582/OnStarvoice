const PLATFORM_ALIASES = new Map([
  ['douyin', 'douyin'],
  ['tiktok_cn', 'douyin'],
  ['xiaohongshu', 'xiaohongshu'],
  ['xhs', 'xiaohongshu'],
  ['red', 'xiaohongshu'],
  ['weibo', 'weibo'],
  ['unknown', 'unknown'],
]);

const PAGE_TYPES = new Set([
  'note_detail',
  'blogger_profile',
  'search_results',
  'unsupported',
  'unknown',
]);

const DETAIL_READY_REASONS = new Set([
  'ready',
  'loading',
  'not_note_detail',
  'missing_detail_content',
  'dom_not_ready',
  'platform_mismatch',
  'page_type_mismatch',
  'tab_unavailable',
]);

const TAB_STATUSES = new Set([
  'complete',
  'loading',
  'unavailable',
  'unknown',
]);

const NETWORK_STATUS_ALIASES = new Map([
  ['ok', 'success'],
  ['healthy', 'success'],
  ['success', 'success'],
  ['degraded', 'degraded'],
  ['offline', 'offline'],
  ['timeout', 'timeout'],
  ['network_error', 'network_error'],
  ['http_error', 'http_error'],
  ['application_error', 'application_error'],
  ['endpoint_missing', 'endpoint_missing'],
  ['request_failed', 'request_failed'],
  ['cloud_unavailable', 'cloud_unavailable'],
  ['unavailable', 'unavailable'],
  ['unknown', 'unknown'],
]);

const ENDPOINT_CLASSES = new Set([
  'heartbeat',
  'liveness',
  'command_complete',
  'cloud_api',
]);

const STAGES = new Set([
  'unknown',
  'preflight',
  'search_nav',
  'search_ready',
  'list_capture',
  'detail_queue',
  'detail_capture',
  'comments',
  'local_durable_sync',
  'server_persisted',
  'ai_settled',
]);

// Keep the server-side recovery classifier and dispatcher on one explicit
// allowlist. Code-only legacy/edge snapshots must remain fail-closed even when
// richer security flags were lost before persistence.
export const CAPTURE_PLATFORM_SAFETY_CODES = Object.freeze([
  'AUTHENTICATION_REQUIRED',
  'AUTH_REQUIRED',
  'CAPTCHA_PAGE_DETECTED',
  'CAPTCHA_REQUIRED',
  'DOUYIN_CAPTCHA_REQUIRED',
  'DOUYIN_LOGIN_REQUIRED',
  'DOUYIN_SEARCH_CAPTCHA_REQUIRED',
  'DOUYIN_SEARCH_SECURITY_CHALLENGE',
  'HTTP_429',
  'LOGIN_REQUIRED',
  'PAGE_CHALLENGE_BLOCK',
  'PLATFORM_SAFETY_BLOCK',
  'RATE_LIMITED',
  'SECURITY_VERIFICATION_REQUIRED',
  'XHS_LOGIN_REQUIRED',
  'XHS_SECURITY_BLOCK',
]);

const RECOVERY_ERROR_CODES = new Set([
  ...CAPTURE_PLATFORM_SAFETY_CODES.map(code => code.toLowerCase()),
  'ai_prefilter_failed',
  'ai_prefilter_timeout',
  'auth_required',
  'authentication_required',
  'canceled',
  'captcha_page_detected',
  'captcha_required',
  'capture_canceled',
  'capture_cancelled',
  'capture_failed',
  'capture_lock_busy',
  'capture_lock_conflict',
  'capture_lock_lost',
  'capture_runtime_restore_failed',
  'capture_task_debug_not_released',
  'capture_task_not_found',
  'capture_task_owner_disconnected',
  'capture_task_platform_mismatch',
  'capture_task_platform_unsupported',
  'capture_task_rebind_failed',
  'capture_task_source_mismatch',
  'capture_task_source_tab_missing',
  'capture_task_source_tab_replaced',
  'capture_task_start_failed',
  'capture_task_unavailable',
  'capture_task_unexpected_cancellation',
  'capture_worker_close_failed',
  'checkpoint_write_failed',
  'content_unavailable',
  'content_relay_stalled',
  'content_relay_timeout',
  'dns_error',
  'dns_timeout',
  'douyin_blogger_notes_root_not_ready',
  'douyin_captcha_required',
  'douyin_comment_id_conflict',
  'douyin_comment_id_mismatch',
  'douyin_content_unavailable',
  'douyin_detail_id_mismatch',
  'douyin_detail_not_ready',
  'douyin_login_required',
  'douyin_search_captcha_required',
  'douyin_search_security_challenge',
  'douyin_search_service_abnormal',
  'douyin_target_not_found',
  'fence_changed',
  'frame_removed',
  'extension_runtime_restarted',
  'login_required',
  'network_error',
  'network_offline',
  'network_timeout',
  'network_unavailable',
  'no_tab_available',
  'no_tab_with_id',
  'persist_failed',
  'persist_timeout',
  'prefilter_failed',
  'prefilter_timeout',
  'receiving_end_missing',
  'receiving_end_timeout',
  'request_failed',
  'request_timeout',
  'runtime_error',
  'stack_overflow',
  'stale_task_heartbeat_timeout',
  'streaming_sync_blocked',
  'streaming_sync_incomplete',
  'sync_failed',
  'sync_timeout',
  'tab_not_found',
  'task_run_error',
  'timeout',
  'tls_error',
  'tls_timeout',
  'unattended_attempt_canceled',
  'unattended_attempt_replaced',
  'unattended_begin_fence_changed',
  'unattended_capture_lock_bind_failed',
  'unattended_capture_lock_missing',
  'unattended_checkpoint_write_failed',
  'unattended_ledger_rejected',
  'unattended_recovery_blocked',
  'unattended_recovery_exhausted',
  'unattended_recovery_launch_exhausted',
  'unattended_runtime_message_timeout',
  'unattended_search_bootstrap_canceled',
  'unattended_search_bootstrap_failed',
  'unattended_stale',
  'unattended_status_report_rejected',
  'unattended_status_report_timeout',
  'unattended_wait_state_write_failed',
  'user_canceled',
  'user_cancelled',
  'user_cancel_requested',
  'xhs_login_required',
  'xhs_page_not_available',
  'xhs_security_block',
]);

const RECOVERY_ERROR_CODE_CREDENTIAL_FAMILY_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:xox[baprs][_-][A-Za-z0-9_-]{10,}|glpat[_-][A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16})(?:$|[^A-Za-z0-9])/iu;
const RECOVERY_ERROR_CODE_OPAQUE_SEGMENT_PATTERN =
  /(?:^|[_:-])(?:[A-Za-z0-9]{16,}|\d{11,})(?:$|[_:-])/u;
const RECOVERY_ERROR_CODE_UUID_PATTERN =
  /(?:^|[^0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:$|[^0-9a-f])/iu;

function token(value, limit = 120) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > limit) return '';
  const normalized = raw.toLowerCase().replace(/-/gu, '_');
  return /^[a-z][a-z0-9_]*$/u.test(normalized) ? normalized : '';
}

function enumValue(value, allowed, fallback = 'unknown') {
  const normalized = token(value);
  return allowed.has(normalized) ? normalized : fallback;
}

export function normalizeCaptureHealthPlatform(value, fallback = 'unknown') {
  return PLATFORM_ALIASES.get(token(value, 40)) || fallback;
}

export function normalizeCaptureHealthPageType(value, fallback = 'unknown') {
  return enumValue(value, PAGE_TYPES, fallback);
}

export function normalizeCaptureHealthDetailReadyReason(value, fallback = '') {
  return enumValue(value, DETAIL_READY_REASONS, fallback);
}

export function normalizeCaptureHealthTabStatus(value, fallback = 'unavailable') {
  return enumValue(value, TAB_STATUSES, fallback);
}

export function normalizeCaptureHealthNetworkStatus(
  value,
  fallback = 'unavailable',
) {
  return NETWORK_STATUS_ALIASES.get(token(value, 40)) || fallback;
}

export function normalizeCaptureHealthEndpointClass(value, fallback = '') {
  return enumValue(value, ENDPOINT_CLASSES, fallback);
}

export function normalizeCaptureHealthStage(value, fallback = 'unknown') {
  const normalized = token(value, 80);
  if (!normalized) return fallback;
  if (STAGES.has(normalized)) return normalized;

  if (/^(?:detail_ai_|ai_|.*_prefilter_)/u.test(normalized)) {
    return 'ai_settled';
  }
  if (/^(?:detail_comments_|comments?_|profile_comment_)/u.test(normalized)) {
    return 'comments';
  }
  if (
    /^(?:detail_item_(?:opening|delay|prefetch)|detail_preparing|detail_batch_start|detail_queue)/u
      .test(normalized)
  ) {
    return 'detail_queue';
  }
  if (/^(?:detail_|blogger_metrics_|enhanc|note_)/u.test(normalized)) {
    return 'detail_capture';
  }
  if (
    /^(?:search|opening_search_|waiting_search_|waiting_results|keyword_|filter|navigating|inter_keyword_delay|no_matching_results|platform_service_abnormal|platform_safety_block)/u
      .test(normalized)
  ) {
    return normalized === 'search_ready' ? 'search_ready' : 'search_nav';
  }
  if (
    /^(?:list_|batch_|capture|scroll|paging|sampling|extracting|found_new|no_new|max_duration|max_reached)/u
      .test(normalized)
  ) {
    return 'list_capture';
  }
  if (/^(?:sync|saving|saved|synced|streaming_sync_)/u.test(normalized)) {
    return 'local_durable_sync';
  }
  if (
    /^(?:preflight|check|checking_page|preparing|initializing_unattended|waiting_bootstrap_slot|starting_capture_session|request_started)/u
      .test(normalized)
  ) {
    return 'preflight';
  }
  return fallback;
}

export function normalizeCaptureRecoveryErrorCode(
  value,
  fallback = 'UNKNOWN',
) {
  const raw = String(value ?? '').trim();
  if (
    RECOVERY_ERROR_CODE_CREDENTIAL_FAMILY_PATTERN.test(raw)
    || RECOVERY_ERROR_CODE_OPAQUE_SEGMENT_PATTERN.test(raw)
    || RECOVERY_ERROR_CODE_UUID_PATTERN.test(raw)
  ) return fallback;
  const normalized = token(value, 120);
  if (!normalized) return fallback;
  if (RECOVERY_ERROR_CODES.has(normalized)) {
    return normalized.toUpperCase();
  }
  return fallback;
}
