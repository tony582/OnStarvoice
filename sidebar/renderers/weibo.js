import {
  buildSingleNoteCardData,
  buildDetailListCardData,
  buildBloggerProfileCardData,
  buildCommentsCardData,
  buildUnknownCardData,
} from "./common.js";

export function buildWeiboCardData(record, payload, hydratedSinglePayload) {
  if (hydratedSinglePayload) {
    return buildSingleNoteCardData(hydratedSinglePayload, "weibo");
  }

  if (record.type === "single_note") {
    return buildSingleNoteCardData(payload, "weibo");
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
