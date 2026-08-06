(function attachTargetPageAvailability(root) {
  "use strict";

  const UNAVAILABLE_CODE = "TARGET_POST_UNAVAILABLE";
  const UNAVAILABLE_OUTCOME = "post_unavailable";
  const UNAVAILABLE_REASON = "post_deleted_or_unavailable";

  function text(value, limit = 20000) {
    const normalized = String(value == null ? "" : value)
      .replace(/\s+/gu, " ")
      .trim();
    return normalized.length > limit ? normalized.slice(0, limit) : normalized;
  }

  function normalizePlatform(value) {
    const normalized = text(value, 40).toLowerCase();
    if (["xiaohongshu", "xhs", "小红书"].includes(normalized)) {
      return "xiaohongshu";
    }
    if (["douyin", "dy", "抖音"].includes(normalized)) {
      return "douyin";
    }
    return "";
  }

  function classifySnapshot(snapshot = {}) {
    const platform = normalizePlatform(snapshot.platform);
    const bodyText = text(snapshot.bodyText);
    const title = text(snapshot.title, 500);
    const combined = `${title} ${bodyText}`;

    if (platform === "douyin") {
      const directUnavailableCopy =
        /你要观看的(?:图文|视频|作品|内容)不存在/u.test(combined);
      const directDeletedCopy =
        /(?:图文|视频|作品|内容)(?:已被作者)?(?:删除|下架)|该作品不可用/u.test(
          combined,
        );
      const autoPlayOrExitAction =
        /接下来播放|去精选页查看更多(?:视频|内容)|返回精选/u.test(combined);
      const exactUnavailableCopy =
        /^你要观看的(?:图文|视频|作品|内容)不存在[。！？]?$/u.test(
          bodyText,
        );
      const highConfidenceUnavailable =
        directUnavailableCopy &&
        (exactUnavailableCopy || autoPlayOrExitAction);
      const highConfidenceDeleted =
        directDeletedCopy &&
        autoPlayOrExitAction;

      if (!highConfidenceUnavailable && !highConfidenceDeleted) {
        return null;
      }

      return {
        detected: true,
        unavailable: true,
        code: UNAVAILABLE_CODE,
        businessOutcome: UNAVAILABLE_OUTCOME,
        status: "unavailable",
        availabilityStatus: "deleted",
        reason: UNAVAILABLE_REASON,
        message: "平台提示该帖子已删除",
        retryable: false,
        platform,
        url: text(snapshot.url, 3000),
        evidence: [
          directUnavailableCopy
            ? "douyin_target_not_found"
            : "douyin_deleted_copy",
          ...(autoPlayOrExitAction ? ["douyin_autoplay_countdown"] : []),
        ],
      };
    }

    if (platform !== "xiaohongshu") return null;

    const evidence = [];
    const bodyLength = bodyText.length;
    const shortErrorPage = bodyLength > 0 && bodyLength <= 1200;
    const compactErrorPage = bodyLength > 0 && bodyLength <= 320;
    const hasErrorPageAction =
      /问题反馈|返回首页|重新加载|返回上一页/u.test(bodyText);
    const englishUnavailable =
      /Sorry,\s*This Page Isn['’]t Available Right Now\.?/iu.test(combined);
    const currentUnavailableModalCopy =
      /当前笔记暂时无法浏览|该内容暂时无法查看/u.test(combined);
    const vanishedPageCopy = /你访问的页面不见了/u.test(combined);
    const vanishedPageCountdown =
      /\d+\s*秒后将自动返回首页/u.test(combined);
    const directDeletedCopy =
      /(?:^|[，,。！？；;\s])(?:该|此)(?:篇)?笔记已(?:被作者)?删除(?:[，,。！？；;\s]|$)/u.test(
        bodyText,
      ) ||
      /(?:^|[，,。！？；;\s])作者已删除(?:该|此)(?:篇)?笔记(?:[，,。！？；;\s]|$)/u.test(
        bodyText,
      );
    const exactDeletedErrorCopy =
      /^(?:(?:该|此)(?:篇)?笔记已(?:被作者)?删除|作者已删除(?:该|此)(?:篇)?笔记)(?:，?暂时无法查看)?[。！？]?$/u.test(
        bodyText,
      );
    const exactUnavailableErrorCopy =
      /^(?:该|此)?(?:笔记|内容|页面)(?:不存在|不可用|无法查看)[。！？]?$/u.test(
        bodyText,
      );

    const qrUnavailableLayout =
      (englishUnavailable || currentUnavailableModalCopy) &&
      /请打开小红书\s*App\s*扫码查看/iu.test(combined) &&
      /问题反馈/u.test(combined) &&
      /返回首页|关闭/u.test(combined);
    const vanishedPageLayout =
      shortErrorPage &&
      vanishedPageCopy &&
      vanishedPageCountdown &&
      /返回首页/u.test(bodyText);

    const highConfidenceUnavailable =
      qrUnavailableLayout ||
      (shortErrorPage && englishUnavailable && hasErrorPageAction) ||
      exactUnavailableErrorCopy;
    const highConfidenceDeleted =
      exactDeletedErrorCopy ||
      (compactErrorPage && directDeletedCopy && hasErrorPageAction) ||
      vanishedPageLayout;

    if (englishUnavailable && highConfidenceUnavailable) {
      evidence.push("xhs_page_not_available");
    }
    if (highConfidenceDeleted) {
      evidence.push(
        vanishedPageLayout ? "xhs_page_gone_countdown" : "xhs_deleted_copy",
      );
    }
    if (qrUnavailableLayout) {
      evidence.push("xhs_unavailable_qr_layout");
    }
    if (
      highConfidenceUnavailable &&
      evidence.length === 0
    ) {
      evidence.push("xhs_unavailable_error_copy");
    }

    if (evidence.length === 0) return null;
    // 小红书详情页出现固定的“不可浏览 + 扫码查看 + 问题反馈 +
    // 返回首页/关闭”布局时，目标作品已经不能再从 Web 端访问。按删帖结算，
    // 避免负面巡查把它留成模糊的“暂不可用”或继续重试。
    const availabilityStatus =
      evidence.includes("xhs_deleted_copy") ||
      evidence.includes("xhs_page_gone_countdown") ||
      evidence.includes("xhs_unavailable_qr_layout")
        ? "deleted"
        : "page_unavailable";
    return {
      detected: true,
      unavailable: true,
      code: UNAVAILABLE_CODE,
      businessOutcome: UNAVAILABLE_OUTCOME,
      status: "unavailable",
      availabilityStatus,
      reason: UNAVAILABLE_REASON,
      message:
        availabilityStatus === "deleted"
          ? "平台提示该帖子已删除"
          : "平台提示该帖子当前不可用",
      retryable: false,
      platform,
      url: text(snapshot.url, 3000),
      evidence: [...new Set(evidence)].slice(0, 4),
    };
  }

  root.OnStarvoiceTargetPageAvailability = Object.freeze({
    UNAVAILABLE_CODE,
    UNAVAILABLE_OUTCOME,
    UNAVAILABLE_REASON,
    classifySnapshot,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
