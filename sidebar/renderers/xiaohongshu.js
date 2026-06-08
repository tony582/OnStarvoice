import {
  buildSingleNoteCardData,
  buildDetailListCardData,
  buildBloggerProfileCardData,
  buildCommentsCardData,
  buildUnknownCardData,
} from "./common.js";

export function buildXiaohongshuCardData(record, payload, hydratedSinglePayload) {
  if (hydratedSinglePayload) {
    return buildSingleNoteCardData(hydratedSinglePayload, "xiaohongshu");
  }

  if (record.type === "single_note") {
    return buildSingleNoteCardData(payload, "xiaohongshu");
  }

  if (record.type === "blogger_notes" || record.type === "keyword_notes") {
    return buildDetailListCardData(record, payload);
  }

  if (record.type === "blogger_profile") {
    return buildBloggerProfileCardData(payload);
  }

  if (record.type === "comments") {
    return buildCommentsCardData(payload);
  }

  return buildUnknownCardData(record);
}
