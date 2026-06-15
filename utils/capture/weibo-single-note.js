/**
 * 微博单条详情采集
 * 复用 weibo-keyword-search 的卡片提取内核;DOM 抠不全时用 mid 走 weibo API 兜底(尤其图片)。
 */
import { SYNC_TYPE, PAGE_TYPE } from "../constants.js";
import {
  extractCardData,
  findAllCards,
  fetchWeiboStatusDetails,
  expandAllFullTexts,
  wait,
} from "./weibo-keyword-search.js";

// 从详情页 URL 提取微博 id/bid:
//   m.weibo.cn/detail/4xxxxx  |  weibo.com/<uid>/<bid>  |  weibo.com/detail/<id>
function extractWeiboPostId(url = window.location.href) {
  const u = String(url || "");
  const patterns = [
    /\/detail\/(\w+)/i,
    /weibo\.com\/\d+\/(\w+)/i,
    /weibo\.com\/[^/]+\/(\w+)\/?(?:[?#]|$)/i,
  ];
  for (const re of patterns) {
    const m = u.match(re);
    if (m && m[1] && !/^(u|n|p|search|hot)$/i.test(m[1])) return m[1];
  }
  return "";
}

// 详情页主卡:优先带 mid 的卡片,其次页面里第一张卡
function resolveDetailCard() {
  const direct = document.querySelector(
    '.card-wrap[mid], div[mid], article[mid], [node-type="feed_list_item"]',
  );
  if (direct) return direct;
  const cards = findAllCards(document);
  return cards[0] || null;
}

export async function captureWeiboSingleNote(options = {}) {
  const captureStartedAt = new Date().toISOString();
  const meta = () => ({
    pageType: PAGE_TYPE.NOTE_DETAIL,
    captureStartedAt,
    captureFinishedAt: new Date().toISOString(),
    sourceUrl: window.location.href,
  });
  const fail = (code, message) => ({
    ok: false, platform: "weibo", type: SYNC_TYPE.SINGLE_NOTE, data: null, meta: meta(),
    error: { code, message },
  });

  try {
    expandAllFullTexts();
    await wait(400);

    const mid = extractWeiboPostId();
    const card = resolveDetailCard();
    let post = card ? extractCardData(card, 0, window.location.href) : null;

    const needApi =
      !post ||
      (!post.content && (!Array.isArray(post.imageUrls) || post.imageUrls.length === 0)) ||
      (post.mediaHint && (!Array.isArray(post.imageUrls) || post.imageUrls.length < 2));

    if (mid && needApi) {
      const detail = await fetchWeiboStatusDetails(mid);
      if (detail && (detail.content || (detail.imageUrls && detail.imageUrls.length))) {
        post = post || {
          platform: "weibo",
          noteId: mid,
          noteType: "text",
          url: window.location.href,
          noteUrl: window.location.href,
          detailPageUrl: window.location.href,
          captureTimestamp: Date.now(),
        };
        if (detail.content) { post.content = detail.content; post.noteContent = detail.content; post.fullContent = detail.content; }
        if (detail.imageUrls && detail.imageUrls.length) {
          post.imageUrls = Array.from(new Set([...(post.imageUrls || []), ...detail.imageUrls]));
          if (post.imageUrls.length) { post.coverUrl = post.coverUrl || post.imageUrls[0]; post.coverImageUrl = post.coverImageUrl || post.imageUrls[0]; }
          post.noteType = post.noteType === "video" ? "video" : "image";
        }
        const m = detail.metrics || {};
        if (m.likes != null) post.likes = m.likes;
        if (m.comments != null) { post.comments = m.comments; post.commentsCount = m.comments; }
        if (m.shares != null) post.shares = m.shares;
      }
    }

    if (!post) return fail("NOT_FOUND", "未找到微博内容,请确认已登录微博且停在微博详情页");

    return { ok: true, platform: "weibo", type: SYNC_TYPE.SINGLE_NOTE, data: post, meta: meta(), error: null };
  } catch (error) {
    return fail("CAPTURE_FAILED", error?.message || String(error));
  }
}
