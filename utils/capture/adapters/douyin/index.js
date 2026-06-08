import { captureDouyinSingleNote } from "../../douyin-single-note.js";
import { captureDouyinComments } from "../../douyin-comments.js";
import {
  captureDouyinBloggerProfile,
  captureDouyinBloggerNotes,
} from "../../douyin-blogger.js";
import { captureDouyinKeywordNotes } from "../../douyin-keyword-search.js";
import { detectPageType } from "../../../platform/page-routing.js";

function normalizeCaptureResult(result, type) {
  const normalized = result && typeof result === "object" ? result : {};
  const meta = normalized.meta && typeof normalized.meta === "object" ? normalized.meta : {};

  return {
    ...normalized,
    platform: "douyin",
    type: normalized.type || type || null,
    meta: {
      ...meta,
      pageType: meta.pageType || detectPageType(window.location.href, "douyin"),
      sourceUrl: meta.sourceUrl || window.location.href,
    },
  };
}

export const douyinAdapter = {
  platform: "douyin",

  runtime: {
    requiresMainWorldInjection: true,
    mainWorldScript: "utils/capture/douyin-interceptor.js",
  },

  detectPageType(url) {
    return detectPageType(url, "douyin");
  },
  detectKeywordSortDimension() {
    return {
      dimension: "likes",
      source: "douyin_default",
    };
  },
  async captureComments(options = {}) {
    return normalizeCaptureResult(await captureDouyinComments(options), "comments");
  },
  async captureSingleNote(options = {}) {
    return normalizeCaptureResult(
      await captureDouyinSingleNote(options),
      "single_note",
    );
  },
  async captureBloggerProfile() {
    return normalizeCaptureResult(
      await captureDouyinBloggerProfile(),
      "blogger_profile",
    );
  },
  async captureBloggerNotes(options = {}) {
    return normalizeCaptureResult(
      await captureDouyinBloggerNotes(options),
      "blogger_notes",
    );
  },
  async captureKeywordNotes(options = {}) {
    return normalizeCaptureResult(
      await captureDouyinKeywordNotes(options),
      "keyword_notes",
    );
  },
};
