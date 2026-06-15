/**
 * 微博博主主页采集(资料 + 微博列表)
 * 资料头部为 best-effort(文本扫描兜底,微博 DOM 改版可能要微调);
 * 列表复用 weibo-keyword-search 的卡片提取内核。
 */
import { SYNC_TYPE, PAGE_TYPE } from "../constants.js";
import {
  collectPostsFromRoot,
  hydrateWeiboStatusDetails,
  scrollToLoadMore,
  expandAllFullTexts,
  dedupePosts,
  wait,
} from "./weibo-keyword-search.js";

const CN_REGIONS = [
  "北京", "天津", "上海", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江",
  "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南",
  "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "台湾",
  "内蒙古", "广西", "西藏", "宁夏", "新疆", "香港", "澳门",
];

function cleanText(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

// "1.2万" / "1234" / "1,234" / "1亿" → number
function parseCount(text) {
  const t = cleanText(text).replace(/,/g, "");
  const m = t.match(/([\d.]+)\s*(亿|万|w|k)?/i);
  if (!m) return 0;
  let n = parseFloat(m[1]) || 0;
  const unit = (m[2] || "").toLowerCase();
  if (unit === "亿") n *= 1e8;
  else if (unit === "万" || unit === "w") n *= 1e4;
  else if (unit === "k") n *= 1e3;
  return Math.round(n);
}

function extractBloggerId(url = window.location.href) {
  const m = String(url || "").match(/weibo\.com\/u\/(\d+)/i) || String(url || "").match(/weibo\.com\/(\d+)(?:[/?#]|$)/i);
  return m ? m[1] : "";
}

// 在整页文本里按"<数字> 关注/粉丝/微博"或反序匹配
function scanMetric(bodyText, labels) {
  for (const label of labels) {
    let m = bodyText.match(new RegExp("([\\d.,]+\\s*[万亿wk]?)\\s*" + label, "i"));
    if (m) return parseCount(m[1]);
    m = bodyText.match(new RegExp(label + "\\s*([\\d.,]+\\s*[万亿wk]?)", "i"));
    if (m) return parseCount(m[1]);
  }
  return 0;
}

function extractBloggerProfileData() {
  const bodyText = cleanText(document.body?.innerText || "");
  const bloggerId = extractBloggerId();

  // 名称:优先头部标题元素,兜底用页面 title("XXX的微博_微博")
  const nameEl =
    document.querySelector('[class*="ProfileHeader_name"]') ||
    document.querySelector("h1") ||
    document.querySelector('[class*="username"], .username, .name');
  let name = nameEl ? cleanText(nameEl.textContent) : "";
  if (!name) {
    const t = cleanText(document.title).replace(/[_\-—]\s*微博.*$/u, "").replace(/的微博$/u, "");
    name = t;
  }

  const avatarEl =
    document.querySelector('[class*="ProfileHeader"] img, [class*="Avatar"] img, .photo img, img.W_face_radius') ||
    document.querySelector("img");
  const avatarUrl = avatarEl ? (avatarEl.src || "") : "";

  const bioEl = document.querySelector('[class*="ProfileHeader_con"], [class*="description"], .pf_intro, [node-type="profile_re_intro"]');
  const description = bioEl ? cleanText(bioEl.textContent) : "";

  let ipLocation = "";
  const ipMatch = bodyText.match(/IP属地[:：]?\s*([^\s|｜]+)/i);
  if (ipMatch && ipMatch[1]) ipLocation = ipMatch[1];

  return {
    bloggerName: name || "微博用户",
    bloggerId,
    bloggerUrl: window.location.href,
    bloggerProfileUrl: window.location.href,
    avatarUrl,
    description,
    followingCount: scanMetric(bodyText, ["关注"]),
    followersCount: scanMetric(bodyText, ["粉丝"]),
    bloggerFollowersCount: scanMetric(bodyText, ["粉丝"]),
    likedAndCollectedCount: 0,
    bloggerAccountType: "personal",
    ipLocation,
    captureTimestamp: Date.now(),
  };
}

export async function captureWeiboBloggerProfile() {
  const captureStartedAt = new Date().toISOString();
  const meta = () => ({ pageType: PAGE_TYPE.BLOGGER_PROFILE, captureStartedAt, captureFinishedAt: new Date().toISOString(), sourceUrl: window.location.href });
  try {
    await wait(500);
    const payload = extractBloggerProfileData();
    if (!payload.bloggerId && !payload.bloggerName) {
      return { ok: false, platform: "weibo", type: SYNC_TYPE.BLOGGER_PROFILE, data: null, meta: meta(), error: { code: "NOT_FOUND", message: "未识别到微博用户资料,请确认在用户主页且已登录" } };
    }
    return { ok: true, platform: "weibo", type: SYNC_TYPE.BLOGGER_PROFILE, data: payload, meta: meta(), error: null };
  } catch (error) {
    return { ok: false, platform: "weibo", type: SYNC_TYPE.BLOGGER_PROFILE, data: null, meta: meta(), error: { code: "CAPTURE_FAILED", message: error?.message || String(error) } };
  }
}

export async function captureWeiboBloggerNotes(options = {}) {
  const { onProgress = null, maxScrolls = 8, maxDetectedItems = 100, minLikes = 0 } = options;
  const captureStartedAt = new Date().toISOString();
  const meta = () => ({ pageType: PAGE_TYPE.BLOGGER_PROFILE, captureStartedAt, captureFinishedAt: new Date().toISOString(), sourceUrl: window.location.href });
  try {
    const profile = extractBloggerProfileData();
    const bloggerIpLocation = profile.ipLocation || "";

    if (onProgress) onProgress({ phase: "start", message: `开始采集「${profile.bloggerName}」的微博...` });
    expandAllFullTexts();
    await wait(300);
    await scrollToLoadMore(maxScrolls, onProgress);
    expandAllFullTexts();
    await wait(300);

    const { posts } = collectPostsFromRoot(document, window.location.href, 1);
    posts.forEach((p) => {
      if (bloggerIpLocation && !p.region) p.region = bloggerIpLocation;
      if (bloggerIpLocation && !p.publishLocation) p.publishLocation = bloggerIpLocation;
      p.authorName = p.authorName || profile.bloggerName;
      p.bloggerProfileUrl = p.bloggerProfileUrl || profile.bloggerUrl;
    });

    await hydrateWeiboStatusDetails(posts, { onProgress, limit: maxDetectedItems });

    const unique = dedupePosts(posts).filter((p) => Number(p.likes || 0) >= minLikes).slice(0, maxDetectedItems);
    if (unique.length === 0) {
      return { ok: false, platform: "weibo", type: SYNC_TYPE.BLOGGER_NOTES, data: null, meta: meta(), error: { code: "NO_RESULTS", message: "未采到该博主的微博,请确认已登录且主页有内容" } };
    }
    if (onProgress) onProgress({ phase: "done", count: unique.length, message: `采集完成,共 ${unique.length} 条微博` });

    return {
      ok: true, platform: "weibo", type: SYNC_TYPE.BLOGGER_NOTES, meta: meta(), error: null,
      data: { ...profile, totalCount: unique.length, items: unique, notes: unique },
    };
  } catch (error) {
    return { ok: false, platform: "weibo", type: SYNC_TYPE.BLOGGER_NOTES, data: null, meta: meta(), error: { code: "CAPTURE_FAILED", message: error?.message || String(error) } };
  }
}
