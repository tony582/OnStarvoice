import { captureSingleNote as captureLegacySingleNote } from "../../single-note.js";
import {
  captureBloggerProfile as captureLegacyBloggerProfile,
  captureBloggerNotes as captureLegacyBloggerNotes,
} from "../../blogger.js";
import {
  captureKeywordNotes as captureLegacyKeywordNotes,
  detectKeywordSortDimension,
} from "../../keyword-search.js";
import { captureComments as captureLegacyComments } from "../../comments.js";
import { detectPageType } from "../../../platform/page-routing.js";

function normalizeCaptureResult(result, type) {
  const normalized = result && typeof result === "object" ? result : {};
  const meta = normalized.meta && typeof normalized.meta === "object" ? normalized.meta : {};

  return {
    ...normalized,
    platform: "xiaohongshu",
    type: normalized.type || type || null,
    meta: {
      ...meta,
      pageType: meta.pageType || detectPageType(window.location.href, "xiaohongshu"),
      sourceUrl: meta.sourceUrl || window.location.href,
    },
  };
}

export const xiaohongshuAdapter = {
  platform: "xiaohongshu",
  detectPageType(url) {
    return detectPageType(url, "xiaohongshu");
  },
  async captureSingleNote() {
    return normalizeCaptureResult(await captureLegacySingleNote(), "single_note");
  },
  async captureBloggerProfile() {
    return normalizeCaptureResult(
      await captureLegacyBloggerProfile(),
      "blogger_profile",
    );
  },
  async captureBloggerNotes(options = {}) {
    return normalizeCaptureResult(
      await captureLegacyBloggerNotes(options),
      "blogger_notes",
    );
  },
  async captureKeywordNotes(options = {}) {
    return normalizeCaptureResult(
      await captureLegacyKeywordNotes(options),
      "keyword_notes",
    );
  },
  async captureComments(options = {}) {
    return normalizeCaptureResult(await captureLegacyComments(options), "comments");
  },
  detectKeywordSortDimension,
};
