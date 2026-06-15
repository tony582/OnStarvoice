/**
 * 微博平台采集适配器
 * Phase 1: 仅支持搜索页采集
 */
import { captureWeiboKeywordNotes } from "../../weibo-keyword-search.js";
import { captureWeiboSingleNote } from "../../weibo-single-note.js";
import { captureWeiboBloggerProfile, captureWeiboBloggerNotes } from "../../weibo-blogger.js";
import { detectPageType } from "../../../platform/page-routing.js";
import { SYNC_TYPE } from "../../../constants.js";

function normalizeCaptureResult(result, type) {
  const normalized = result && typeof result === "object" ? result : {};
  const meta = normalized.meta && typeof normalized.meta === "object" ? normalized.meta : {};

  return {
    ...normalized,
    platform: "weibo",
    type: normalized.type || type || null,
    meta: {
      ...meta,
      pageType: meta.pageType || detectPageType(window.location.href, "weibo"),
      sourceUrl: meta.sourceUrl || window.location.href,
    },
  };
}

function buildUnsupportedResult(type, message) {
  const now = new Date().toISOString();
  return {
    ok: false,
    platform: "weibo",
    type,
    data: null,
    meta: {
      pageType: detectPageType(window.location.href, "weibo"),
      captureStartedAt: now,
      captureFinishedAt: now,
      sourceUrl: window.location.href,
    },
    error: {
      code: "CAPTURE_UNSUPPORTED",
      message,
    },
  };
}

export const weiboAdapter = {
  platform: "weibo",

  detectPageType(url) {
    return detectPageType(url, "weibo");
  },

  async captureSingleNote(options = {}) {
    return normalizeCaptureResult(
      await captureWeiboSingleNote(options),
      SYNC_TYPE.SINGLE_NOTE,
    );
  },

  async captureBloggerProfile(options = {}) {
    return normalizeCaptureResult(
      await captureWeiboBloggerProfile(options),
      SYNC_TYPE.BLOGGER_PROFILE,
    );
  },

  async captureBloggerNotes(options = {}) {
    return normalizeCaptureResult(
      await captureWeiboBloggerNotes(options),
      SYNC_TYPE.BLOGGER_NOTES,
    );
  },

  async captureKeywordNotes(options = {}) {
    return normalizeCaptureResult(
      await captureWeiboKeywordNotes(options),
      SYNC_TYPE.KEYWORD_NOTES,
    );
  },

  async captureComments(options = {}) {
    return buildUnsupportedResult(
      SYNC_TYPE.COMMENTS,
      "微博评论采集功能开发中，敬请期待",
    );
  },

  detectKeywordSortDimension() {
    return { dimension: "likes", source: "weibo_default" };
  },
};
