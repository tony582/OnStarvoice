import {
  buildDetailListCardData,
  buildUnknownCardData,
} from "./common.js";

export function buildWeiboCardData(record, payload) {
  if (record.type === "keyword_notes") {
    return buildDetailListCardData(record, payload);
  }

  return buildUnknownCardData(record);
}
