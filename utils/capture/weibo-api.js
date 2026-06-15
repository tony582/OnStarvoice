/**
 * 微博 weibo.com 接口采集（博主主页 / 单条详情）
 *
 * weibo.com 的博主页、单条详情是 React SPA(woo-panel / wbpro-feed-content 结构,
 * 没有 s.weibo.com 的 .card-wrap[mid]),DOM 抓取既脆又抓不全。
 * 这里改用微博自身的 AJAX 接口取结构化数据(需已登录,同源 fetch 自动带 cookie):
 *   - 博主资料: /ajax/profile/info + /ajax/profile/detail
 *   - 博主微博列表: /ajax/statuses/mymblog?uid=&page=
 *   - 单条详情: /ajax/statuses/show?id=<mblogid>
 *
 * 返回的 post 结构对齐 weibo-keyword-search.js extractCardData 的字段。
 */

import { SYNC_TYPE, PAGE_TYPE } from "../constants.js";

const REGION_PREFIX = /^(?:发布于|来自)\s*/;

export function extractWeiboUid(url = window.location.href) {
  const s = String(url || "");
  let m = s.match(/weibo\.com\/u\/(\d{5,})/i);
  if (m) return m[1];
  m = s.match(/weibo\.com\/(\d{5,})(?:[/?#]|$)/i);
  if (m) return m[1];
  return "";
}

export function extractWeiboMblogid(url = window.location.href) {
  const s = String(url || "");
  let m = s.match(/weibo\.com\/\d{5,}\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  m = s.match(/weibo\.com\/(?:detail|status)\/([A-Za-z0-9]+)/i);
  if (m) return m[1];
  return "";
}

function jsonFetch(url) {
  return fetch(url, {
    credentials: "include",
    headers: {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
    },
  }).then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))));
}

function cleanRegion(regionName) {
  if (!regionName) return "";
  return String(regionName)
    .replace(REGION_PREFIX, "")
    .replace(/^IP属地[:：]\s*/u, "")
    .trim();
}

function formatWeiboTime(created) {
  if (!created) return "";
  const d = new Date(created);
  if (Number.isNaN(d.getTime())) return String(created);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stripHtml(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = String(html);
  return (div.textContent || "").replace(/\s+/g, " ").trim();
}

function extractTopics(text) {
  const tags = [];
  String(text || "").replace(/#([^#\n]{1,30})#/g, (m, t) => {
    tags.push(t.trim());
    return m;
  });
  return Array.from(new Set(tags));
}

// "1,234" / "25.7万" → number
function parseCounterNum(s) {
  const t = String(s == null ? "" : s).replace(/[,，\s]/g, "");
  const m = t.match(/([\d.]+)\s*(亿|万|w|k)?/i);
  if (!m) return 0;
  let n = parseFloat(m[1]) || 0;
  const unit = (m[2] || "").toLowerCase();
  if (unit === "亿") n *= 1e8;
  else if (unit === "万" || unit === "w") n *= 1e4;
  else if (unit === "k") n *= 1e3;
  return Math.round(n);
}

// 账号属性:对齐后台标签 personal/professional/enterprise
function accountTypeFromUser(user) {
  if (!user || !user.verified) return "personal";
  // verified_type 0 = 个人认证(黄V/金V);>0 多为机构蓝V
  return Number(user.verified_type) > 0 ? "enterprise" : "professional";
}

// post 的 user 对象不带粉丝数/获赞,只有 profile/info 有 → 按 uid 缓存补拉
const weiboProfileMetricsCache = new Map();
export async function fetchWeiboProfileMetrics(uid) {
  if (!uid) return null;
  if (weiboProfileMetricsCache.has(uid)) return weiboProfileMetricsCache.get(uid);
  let metrics = null;
  try {
    const info = await jsonFetch(`/ajax/profile/info?uid=${uid}`);
    const u = info?.data?.user || {};
    const counter = u.status_total_counter || {};
    metrics = {
      followersCount: Number(u.followers_count || 0),
      followingCount: Number(u.friends_count || 0),
      statusesCount: Number(u.statuses_count || 0),
      likedCollected: parseCounterNum(counter.like_cnt), // 获赞总数(最接近"点赞与收藏")
      accountType: accountTypeFromUser(u),
      bloggerName: u.screen_name || "",
      avatarUrl: u.avatar_hd || u.avatar_large || u.profile_image_url || "",
      verified: !!u.verified,
    };
  } catch {
    metrics = null;
  }
  weiboProfileMetricsCache.set(uid, metrics);
  return metrics;
}

function applyMetricsToPost(post, m) {
  if (!post || !m) return post;
  post.authorFans = m.followersCount || post.authorFans || 0;
  post.bloggerFollowersCount = m.followersCount || 0;
  post.authorFollowing = m.followingCount || post.authorFollowing || 0;
  post.bloggerLikedCollected = m.likedCollected || 0;
  post.bloggerLikedAndCollectedCount = m.likedCollected || 0;
  post.likedAndCollectedCount = m.likedCollected || 0;
  if (m.accountType) post.bloggerAccountType = m.accountType;
  return post;
}

function imageUrlsFromApiPost(p) {
  const urls = [];
  const infos = p?.pic_infos || {};
  const ids =
    Array.isArray(p?.pic_ids) && p.pic_ids.length ? p.pic_ids : Object.keys(infos);
  ids.forEach((id) => {
    const info = infos[id];
    const u =
      info?.largest?.url ||
      info?.large?.url ||
      info?.original?.url ||
      info?.mw2000?.url ||
      info?.bmiddle?.url ||
      info?.thumbnail?.url;
    if (u) urls.push(u);
  });
  // 视频 / 文章 封面兜底
  if (!urls.length && p?.page_info) {
    const pic = p.page_info.page_pic;
    const u =
      (typeof pic === "string" ? pic : pic?.url || pic?.pic_big) ||
      p.page_info.pic_url ||
      p.page_info.pic_big;
    if (u) urls.push(u);
  }
  return Array.from(
    new Set(urls.filter(Boolean).map((u) => String(u).replace(/^http:\/\//i, "https://"))),
  );
}

export function normalizeWeiboApiPost(p, ctx = {}) {
  if (!p || typeof p !== "object") return null;
  const user = p.user || {};
  const uid = String(ctx.uid || user.idstr || user.id || "");
  const mblogid = p.mblogid || p.bid || "";
  const text = (p.text_raw || stripHtml(p.text) || "").trim();
  const imageUrls = imageUrlsFromApiPost(p);
  const isVideo = !!(
    p.page_info && /video/i.test(p.page_info.type || p.page_info.object_type || "")
  );
  let url = "";
  if (mblogid && uid) url = `https://weibo.com/${uid}/${mblogid}`;
  else if (p.id || p.mid) url = `https://weibo.com/detail/${p.id || p.mid}`;
  const region = cleanRegion(p.region_name);
  const authorName = user.screen_name || ctx.authorName || "";
  const avatar = user.avatar_hd || user.avatar_large || user.profile_image_url || "";
  const title = text.slice(0, 30) || `微博 ${mblogid || ""}`.trim();
  const noteType = isVideo ? "video" : imageUrls.length ? "image" : "text";

  return {
    platform: "weibo",
    noteId: String(p.mid || p.id || mblogid || ""),
    mblogid,
    noteType,
    type: noteType,
    title,
    noteTitle: title,
    content: text,
    noteContent: text,
    fullContent: text,
    body: text,
    url,
    noteUrl: url,
    detailPageUrl: url,
    coverUrl: imageUrls[0] || "",
    coverImageUrl: imageUrls[0] || "",
    imageUrls,
    videoUrl: "",
    videoUrls: [],
    videoDuration: "",
    publishTime: formatWeiboTime(p.created_at),
    publishDate: formatWeiboTime(p.created_at),
    publishDateRaw: p.created_at || "",
    tags: extractTopics(text),
    likes: Number(p.attitudes_count || 0),
    comments: Number(p.comments_count || 0),
    commentsCount: Number(p.comments_count || 0),
    collects: 0,
    shares: Number(p.reposts_count || 0),
    authorId: uid,
    author: authorName || "作者未知",
    authorName,
    authorAvatar: avatar,
    avatarUrl: avatar,
    authorFans: Number(ctx.followersCount || user.followers_count || 0),
    bloggerFollowersCount: Number(ctx.followersCount || user.followers_count || 0),
    authorFollowing: Number(ctx.followingCount || user.friends_count || 0),
    bloggerLikedCollected: Number(ctx.likedCollected || 0),
    bloggerLikedAndCollectedCount: Number(ctx.likedCollected || 0),
    likedAndCollectedCount: Number(ctx.likedCollected || 0),
    bloggerProfileUrl: uid ? `https://weibo.com/u/${uid}` : "",
    authorUrl: uid ? `https://weibo.com/u/${uid}` : "",
    bloggerAccountType: ctx.accountType || accountTypeFromUser(user),
    source: stripHtml(p.source) || "",
    region,
    publishLocation: region,
    isRetweet: !!p.retweeted_status,
    mediaHint: imageUrls.length > 0,
    captureTimestamp: Date.now(),
  };
}

export async function fetchWeiboUserProfile(uid) {
  const result = { bloggerId: uid, platform: "weibo" };
  try {
    const info = await jsonFetch(`/ajax/profile/info?uid=${uid}`);
    const u = info?.data?.user || {};
    const counter = u.status_total_counter || {};
    const likedCollected = parseCounterNum(counter.like_cnt); // 获赞总数
    result.bloggerName = u.screen_name || "";
    result.avatarUrl = u.avatar_hd || u.avatar_large || u.profile_image_url || "";
    result.description = u.description || "";
    result.followingCount = Number(u.friends_count || 0);
    result.followersCount = Number(u.followers_count || 0);
    result.bloggerFollowersCount = Number(u.followers_count || 0);
    result.statusesCount = Number(u.statuses_count || 0);
    result.likedAndCollectedCount = likedCollected;
    result.bloggerLikedAndCollectedCount = likedCollected;
    result.bloggerLikedCollected = likedCollected;
    result.verified = !!u.verified;
    result.bloggerAccountType = accountTypeFromUser(u);
  } catch (e) {
    result.infoError = String(e?.message || e);
  }
  try {
    const detail = await jsonFetch(`/ajax/profile/detail?uid=${uid}`);
    const d = detail?.data || {};
    result.ipLocation = cleanRegion(d.ip_location);
    if (!result.description && d.description) result.description = d.description;
  } catch (e) {
    result.detailError = String(e?.message || e);
  }
  result.bloggerId = uid;
  result.bloggerUrl = `https://weibo.com/u/${uid}`;
  result.bloggerProfileUrl = `https://weibo.com/u/${uid}`;
  result.captureTimestamp = Date.now();
  return result;
}

export async function fetchWeiboUserPosts(uid, options = {}) {
  const {
    maxItems = 50,
    maxPages = 12,
    minLikes = 0,
    onProgress = null,
    authorName = "",
  } = options;
  const posts = [];
  const seen = new Set();

  // 一次性拉博主指标(粉丝/获赞/账号属性),下发给每条 post(post 自身不带粉丝数)
  const metrics = await fetchWeiboProfileMetrics(uid);
  const ctx = {
    uid,
    authorName: authorName || metrics?.bloggerName || "",
    followersCount: metrics?.followersCount || options.followersCount || 0,
    followingCount: metrics?.followingCount || 0,
    likedCollected: metrics?.likedCollected || 0,
    accountType: metrics?.accountType || "",
  };

  for (let page = 1; page <= maxPages && posts.length < maxItems; page += 1) {
    let json;
    try {
      json = await jsonFetch(`/ajax/statuses/mymblog?uid=${uid}&page=${page}&feature=0`);
    } catch (e) {
      if (page === 1) throw e;
      break;
    }
    const list = json?.data?.list || [];
    if (!list.length) break;

    list.forEach((p) => {
      const norm = normalizeWeiboApiPost(p, ctx);
      if (!norm) return;
      const key = norm.noteId || norm.url;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      if (Number(norm.likes || 0) < minLikes) return;
      posts.push(norm);
    });

    if (onProgress) {
      onProgress({
        phase: "loading",
        message: `已加载 ${posts.length} 条微博(第 ${page} 页)...`,
        count: posts.length,
      });
    }
    await new Promise((r) => setTimeout(r, 350)); // 轻微限速,降低风控概率
  }

  return posts.slice(0, maxItems);
}

export async function fetchWeiboStatusByUrl(url = window.location.href) {
  const mblogid = extractWeiboMblogid(url);
  if (!mblogid) return null;
  let json;
  try {
    json = await jsonFetch(`/ajax/statuses/show?id=${mblogid}`);
  } catch {
    return null;
  }
  const p = json?.data && typeof json.data === "object" ? json.data : json;
  if (!p || (!p.text_raw && !p.text && !p.mblogid)) return null;
  const uid = String(p?.user?.idstr || p?.user?.id || extractWeiboUid(url) || "");
  const post = normalizeWeiboApiPost(p, {
    uid,
    accountType: accountTypeFromUser(p?.user),
  });
  // post 的 user 不带粉丝数/获赞 → 按 uid 补拉 profile 指标(缓存)
  if (post && uid) {
    const metrics = await fetchWeiboProfileMetrics(uid);
    if (metrics) applyMetricsToPost(post, metrics);
  }
  return post;
}

// ---- 评论采集(/ajax/statuses/buildComments)----

function normalizeWeiboComment(c) {
  const user = c.user || {};
  const content = stripHtml(c.text || c.text_raw || "").trim();
  const region = String(c.source || "").replace(/^来自\s*/u, "").trim();
  const userId = String(user.idstr || user.id || "");
  return {
    commentId: String(c.idstr || c.id || c.rootidstr || ""),
    content,
    userName: user.screen_name || "",
    userId,
    userUrl: userId ? `https://weibo.com/u/${userId}` : "",
    ipLocation: region,
    likes: Number(c.like_counts ?? c.like_count ?? 0),
  };
}

// 翻页拉评论。需要数字 mid(非 mblogid);buildComments 用 max_id 游标翻页。
export async function fetchWeiboComments(mid, uid, options = {}) {
  const { maxItems = 50, onProgress = null, shouldStop = null } = options;
  const items = [];
  const seen = new Set();
  let maxId = 0;

  for (let guard = 0; guard < 50 && items.length < maxItems; guard += 1) {
    if (typeof shouldStop === "function" && shouldStop()) break;
    const params = new URLSearchParams({
      is_reload: "1",
      id: String(mid),
      is_show_bulletin: "2",
      is_mix: "0",
      count: "20",
      uid: String(uid || ""),
      fetch_level: "0",
      locale: "zh-CN",
    });
    if (maxId) {
      params.set("max_id", String(maxId));
      params.set("flow", "0");
    }

    let cj;
    try {
      cj = await jsonFetch(`/ajax/statuses/buildComments?${params.toString()}`);
    } catch {
      break;
    }
    const list = Array.isArray(cj?.data) ? cj.data : [];
    if (!list.length) break;

    list.forEach((c) => {
      const n = normalizeWeiboComment(c);
      if (!n.content) return;
      const key = n.commentId || `${n.userId}|${n.content}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push(n);
    });

    if (onProgress) onProgress({ phase: "comments_loading", count: items.length });

    maxId = Number(cj.max_id || 0);
    if (!maxId) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  return items.slice(0, maxItems);
}

export async function captureWeiboComments(options = {}) {
  const {
    maxDetectedItems = null,
    maxItems = null,
    onProgress = null,
    shouldStop = null,
  } = options;
  const captureStartedAt = new Date().toISOString();
  const meta = (extra = {}) => ({
    pageType: PAGE_TYPE.NOTE_DETAIL,
    captureStartedAt,
    captureFinishedAt: new Date().toISOString(),
    sourceUrl: window.location.href,
    ...extra,
  });
  const fail = (code, message) => ({
    ok: false,
    type: SYNC_TYPE.COMMENTS,
    data: null,
    meta: meta(),
    error: { code, message },
  });

  try {
    const mblogid = extractWeiboMblogid(window.location.href);
    if (!mblogid) {
      return fail("LINK_MISSING", "未识别到微博 ID,请停在微博详情页");
    }

    // buildComments 需要数字 mid + uid,用 show 解析
    let mid = "";
    let uid = extractWeiboUid();
    let noteTitle = "";
    try {
      const show = await jsonFetch(`/ajax/statuses/show?id=${mblogid}`);
      const p = show?.data && typeof show.data === "object" ? show.data : show;
      mid = String(p?.mid || p?.id || "");
      uid = String(p?.user?.idstr || p?.user?.id || uid || "");
      noteTitle = String(p?.text_raw || "").replace(/\s+/g, " ").trim().slice(0, 30);
    } catch {
      /* 下面统一报错 */
    }
    if (!mid) {
      return fail("CAPTURE_FAILED", "无法解析微博数字 ID(可能未登录或被限流)");
    }

    const limit = Number(maxDetectedItems ?? maxItems ?? 50) || 50;
    const items = await fetchWeiboComments(mid, uid, {
      maxItems: limit,
      onProgress,
      shouldStop,
    });
    const stoppedByUser = typeof shouldStop === "function" && shouldStop();

    return {
      ok: true,
      type: SYNC_TYPE.COMMENTS,
      data: {
        noteId: mid,
        noteUrl: window.location.href,
        noteTitle,
        totalCount: items.length,
        items,
        captureTimestamp: Date.now(),
        captureStatus: stoppedByUser ? "stopped" : "completed",
        stoppedByUser,
        stopReason: stoppedByUser ? "canceled" : "",
      },
      meta: meta({ captureStatus: stoppedByUser ? "stopped" : "completed", stoppedByUser }),
      error: null,
    };
  } catch (error) {
    return fail("CAPTURE_FAILED", error?.message || String(error));
  }
}
