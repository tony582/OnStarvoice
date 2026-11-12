export const NON_MONITOR_SUGGESTION = 'non_monitor';
export const TRIAGE_SUGGESTION_RULE_VERSION = 'non_monitor_f_v1';
export const TRIAGE_SUGGESTION_SETTING = 'triage_non_monitor_suggestion_enabled';
export const DEFAULT_SUGGESTION_TENANT_ID = '457e5851-93eb-4446-84e5-eb6ddb871e65';

export const NON_MONITOR_REASON_PHRASES = Object.freeze(['未涉及', '未提及', '不匹配', '不符']);
export const NON_MONITOR_RISK_TERMS = Object.freeze([
  '投诉', '维权', '曝光', '退车', '黑猫', '12315', '质量问题', '故障', '坑', '骗', '差评', '避雷', '收费', '？', '?',
]);
// Matching is case-insensitive, so the listed English terms cover their case variants.
export const NON_MONITOR_SERVICE_TERMS = Object.freeze([
  '车机', '大屏', '屏幕', '中控', '芯片', '8155', '8295', 'OTA', '升级', '安吉星', 'OnStar', 'APP',
  '远程', '远控', '哨兵', '壁纸', 'CarPlay', 'Carlife', 'HiCar', '投屏', '语音', '导航', '客服', '救援',
  '续费', '流量', '车联网', '智舱', '座舱', '系统',
]);
export const NON_MONITOR_MIN_TEXT_LENGTH = 8;
export const NON_MONITOR_SERVICE_WINDOW = 800;
const SUMMARY = '主题为其它通用内容，与搜索词不匹配，无服务主题词';

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}

// This is rule F only. Admission, pending status and the tenant switch are database concerns.
export function evaluateNonMonitorSuggestion(record = {}) {
  const ai = object(record.ai_result);
  if (ai.contentTopic !== 'gm_other' || ai.relevance !== 'relevant' || ai.currentKeywordMatch !== 'irrelevant'
    || !['brand_image', 'other'].includes(ai.category)
    || typeof ai.sentiment !== 'string' || !ai.sentiment.trim() || ai.sentiment === 'negative') return null;
  const relevanceReason = typeof ai.relevanceReason === 'string' ? ai.relevanceReason : '';
  const reasonPhrase = NON_MONITOR_REASON_PHRASES.find(term => relevanceReason.includes(term));
  if (!reasonPhrase) return null;
  const text = [record.title, record.content].map(value => typeof value === 'string' ? value : '').join('\n');
  const clean = text.replace(/[#＃@＠][^\s#＃@＠]+/gu, '').replace(/\s/gu, '');
  const textLength = Array.from(clean).length;
  if (textLength < NON_MONITOR_MIN_TEXT_LENGTH || NON_MONITOR_RISK_TERMS.some(term => text.includes(term))) return null;
  const serviceText = Array.from(text).slice(0, NON_MONITOR_SERVICE_WINDOW).join('').toLowerCase();
  if (NON_MONITOR_SERVICE_TERMS.some(term => serviceText.includes(term.toLowerCase()))) return null;
  return {ruleVersion: TRIAGE_SUGGESTION_RULE_VERSION, summary: SUMMARY,
    checks: ['gm_other', 'relevant', 'keyword_irrelevant', 'brand_or_other', 'not_negative',
      'explicit_mismatch_reason', 'substantive_text', 'no_risk_terms', 'no_service_terms'],
    evidence: {reasonPhrase, relevanceReason, textLength, serviceWindow: NON_MONITOR_SERVICE_WINDOW}};
}

export function formatTriageSuggestionReason(reason) {
  const value = object(reason);
  return typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : SUMMARY;
}

export function triageSuggestionEnabled(setting, tenantId) {
  if (setting === undefined || setting === null) return tenantId === DEFAULT_SUGGESTION_TENANT_ID;
  return ['true', '1', 'yes', 'on'].includes(String(setting).trim().toLowerCase());
}
