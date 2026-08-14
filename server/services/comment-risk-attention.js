import { getSetting } from '../db/init.js';

export const COMMENT_RISK_ATTENTION_SETTING = 'comment_risk_attention_enabled';

export function normalizeCommentRiskAttentionSetting(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['true', 'false'].includes(normalized) ? normalized : null;
}

// 旧租户没有该配置时维持现有行为：只有明确关闭才不进入值守关注。
export function parseCommentRiskAttentionEnabled(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(normalized);
}

export function createCommentRiskAttentionPolicy(value) {
  return { enabled: parseCommentRiskAttentionEnabled(value) };
}

export async function getCommentRiskAttentionPolicy(tenantId, loadSetting = getSetting) {
  return createCommentRiskAttentionPolicy(
    await loadSetting(COMMENT_RISK_ATTENTION_SETTING, tenantId),
  );
}

export function exposeCommentAttentionCount(value, enabled) {
  return enabled ? Number(value || 0) : 0;
}
