export const XHS_SECURITY_BLOCK_CODE = "XHS_SECURITY_BLOCK";

// Keep these markers serializable: capture-sync passes them into the page
// execution context, where imported module functions are not available.
export const XHS_SECURITY_PAGE_MARKERS = Object.freeze({
  chineseTitle: "安全限制",
  chineseRateLimit: "访问频繁",
  chineseRetry: "稍后再试",
  chineseCode: "300013",
  chineseActions: Object.freeze(["我要反馈", "返回首页"]),
  englishQrLead: "scan with logged-in rednote app",
  englishQrReason: "for account security",
  englishRateLimit: "requests too frequent",
  englishRetry: "try again after 1 minute",
});

function normalizedText(value) {
  return String(value || "")
    .replace(/[\u2010-\u2015]/gu, "-")
    .replace(/[\u2018\u2019\u201c\u201d\u300c\u300d\u300e\u300f"']/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function buildEvidence({variant, language, reason, pageUrl}) {
  return {
    confirmed: true,
    platform: "xiaohongshu",
    variant,
    language,
    reason,
    pageUrl: String(pageUrl || "").slice(0, 2000),
  };
}

/**
 * Detect only the three actual REDNote/Xiaohongshu protection pages supplied
 * by the operator. Generic words such as "security", "challenge" or
 * "访问频繁" on their own are deliberately insufficient.
 */
export function detectXhsSecurityPage({title = "", text = "", url = ""} = {}) {
  const pageText = normalizedText(`${title} ${text}`);
  if (!pageText) return null;

  const chinesePage =
    pageText.includes(XHS_SECURITY_PAGE_MARKERS.chineseTitle) &&
    pageText.includes(XHS_SECURITY_PAGE_MARKERS.chineseRateLimit) &&
    pageText.includes(XHS_SECURITY_PAGE_MARKERS.chineseRetry) &&
    (
      pageText.includes(XHS_SECURITY_PAGE_MARKERS.chineseCode) ||
      XHS_SECURITY_PAGE_MARKERS.chineseActions.every((action) =>
        pageText.includes(action),
      )
    );
  if (chinesePage) {
    return buildEvidence({
      variant: "cn_rate_limit_300013",
      language: "zh-CN",
      reason: "rate_limit",
      pageUrl: url,
    });
  }

  const englishQrPage =
    pageText.includes(XHS_SECURITY_PAGE_MARKERS.englishQrLead) &&
    pageText.includes(XHS_SECURITY_PAGE_MARKERS.englishQrReason);
  if (englishQrPage) {
    return buildEvidence({
      variant: "en_account_security_qr",
      language: "en",
      reason: "account_security_qr",
      pageUrl: url,
    });
  }

  const englishRateLimitPage =
    pageText.includes(XHS_SECURITY_PAGE_MARKERS.englishRateLimit) &&
    pageText.includes(XHS_SECURITY_PAGE_MARKERS.englishRetry);
  if (englishRateLimitPage) {
    return buildEvidence({
      variant: "en_rate_limit",
      language: "en",
      reason: "rate_limit",
      pageUrl: url,
    });
  }

  return null;
}

export function xhsSecurityFailure(evidence = {}) {
  const normalizedEvidence = buildEvidence({
    variant: String(evidence.variant || "unknown"),
    language: String(evidence.language || "unknown"),
    reason: String(evidence.reason || "platform_security"),
    pageUrl: evidence.pageUrl,
  });
  const isQr = normalizedEvidence.reason === "account_security_qr";
  return {
    code: XHS_SECURITY_BLOCK_CODE,
    message: isQr
      ? "小红书要求扫码完成账号安全验证，已暂停采集"
      : "小红书提示访问频繁，已暂停采集",
    category: "platform_safety_block",
    securityBlocked: true,
    platformSafetyBlocked: true,
    requiresManualAction: true,
    retryable: false,
    securityEvidence: normalizedEvidence,
  };
}

export function createXhsSecurityBlockError(evidence = {}) {
  const failure = xhsSecurityFailure(evidence);
  const error = new Error(failure.message);
  Object.assign(error, failure);
  return error;
}
