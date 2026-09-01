const SEARCH_CHALLENGE_ALLOWLIST = new Set([
  'DOUYIN_SEARCH_CAPTCHA_REQUIRED',
  'DOUYIN_SEARCH_SECURITY_CHALLENGE',
]);

const ELIGIBLE_BUSINESS_TASK_TYPES = new Set([
  'unattended_keyword_capture',
]);

function text(value, limit = 200) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function accountIdentity(value) {
  return text(value, 320).toLowerCase();
}

function humanRequired(reason, details = {}) {
  return Object.freeze({
    applicable: true,
    automaticEligible: false,
    decision: 'human_required',
    reason,
    sourceLineageSilent: false,
    sourceLineageSilenceRequired: false,
    safetyHandoffCount: integer(details.safetyHandoffCount),
    challengeCode: text(details.challengeCode, 100).toUpperCase(),
  });
}

/**
 * Fail-closed policy for a single cross-account handoff after a known search
 * challenge. This policy never attempts to solve or interact with a captcha;
 * it only decides whether the untouched keyword may be handed to a different,
 * already-authenticated account once.
 *
 * Omitting targetPlatformAccountId performs the source-side preflight used by
 * recovery-intent ingestion. Supplying a target performs the final account
 * boundary check that the dispatcher must repeat under its transaction lock.
 */
export function evaluateCaptureSafetyHandoff({
  faultClass = '',
  challengeCode = '',
  platform = '',
  businessTaskType = '',
  itemType = '',
  safetyHandoffCount = 0,
  sourcePlatformAccountId = '',
  sourceLoginState = '',
  sourceLocalClosureProven = false,
  targetPlatformAccountId,
  targetLoginState = '',
} = {}) {
  const normalizedFaultClass = text(faultClass, 80).toLowerCase();
  if (normalizedFaultClass !== 'platform_safety') {
    return Object.freeze({
      applicable: false,
      automaticEligible: false,
      decision: 'not_applicable',
      reason: 'not_platform_safety',
      sourceLineageSilent: false,
      sourceLineageSilenceRequired: false,
      safetyHandoffCount: integer(safetyHandoffCount),
      challengeCode: text(challengeCode, 100).toUpperCase(),
    });
  }

  const normalizedCode = text(challengeCode, 100).toUpperCase();
  const normalizedCount = integer(safetyHandoffCount);
  const details = {
    safetyHandoffCount: normalizedCount,
    challengeCode: normalizedCode,
  };
  if (!SEARCH_CHALLENGE_ALLOWLIST.has(normalizedCode)) {
    return humanRequired('challenge_not_allowlisted', details);
  }
  if (text(platform, 80).toLowerCase() !== 'douyin') {
    return humanRequired('platform_not_allowlisted', details);
  }
  if (!ELIGIBLE_BUSINESS_TASK_TYPES.has(
    text(businessTaskType, 80).toLowerCase(),
  )) {
    return humanRequired('task_type_not_allowlisted', details);
  }
  if (text(itemType, 80).toLowerCase() !== 'keyword') {
    return humanRequired('item_type_not_allowlisted', details);
  }
  if (normalizedCount > 0) {
    return humanRequired('safety_handoff_already_used', details);
  }

  const sourceAccountId = accountIdentity(sourcePlatformAccountId);
  if (!sourceAccountId) {
    return humanRequired('source_platform_account_unknown', details);
  }
  if (text(sourceLoginState, 40).toLowerCase() !== 'authenticated') {
    return humanRequired('source_login_not_authenticated', details);
  }
  if (sourceLocalClosureProven !== true) {
    return humanRequired('source_local_closure_proof_unavailable', details);
  }

  const targetProvided = targetPlatformAccountId !== undefined;
  if (targetProvided) {
    const targetAccountId = accountIdentity(targetPlatformAccountId);
    if (!targetAccountId) {
      return humanRequired('target_platform_account_unknown', details);
    }
    if (text(targetLoginState, 40).toLowerCase() !== 'authenticated') {
      return humanRequired('target_login_not_authenticated', details);
    }
    if (targetAccountId === sourceAccountId) {
      return humanRequired('target_platform_account_not_distinct', details);
    }
  }

  return Object.freeze({
    applicable: true,
    automaticEligible: true,
    decision: 'cross_account_handoff',
    reason: targetProvided
      ? 'first_allowlisted_search_challenge_distinct_account'
      : 'first_allowlisted_search_challenge_requires_distinct_account',
    sourceLineageSilent: false,
    sourceLineageSilenceRequired: true,
    safetyHandoffCount: normalizedCount,
    nextSafetyHandoffCount: 1,
    challengeCode: normalizedCode,
    targetAccountRequired: true,
  });
}

export const CAPTURE_SAFETY_HANDOFF_SEARCH_CODES = Object.freeze(
  [...SEARCH_CHALLENGE_ALLOWLIST],
);
