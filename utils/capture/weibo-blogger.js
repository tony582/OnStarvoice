/**
 * 微博博主主页采集(资料 + 微博列表)
 *
 * weibo.com 博主页是 React SPA,优先走 AJAX 接口(/ajax/profile/* + /ajax/statuses/mymblog),
 * 数据结构化、稳定且能拿到 IP属地/转评赞/九宫格大图;
 * 接口失败时再回退到 DOM 抓取(s.weibo.com 风格的 .card-wrap,仅作兜底)。
 */
import { SYNC_TYPE, PAGE_TYPE } from "../constants.js";
import {
  extractWeiboUid,
  fetchWeiboUserProfile,
  fetchWeiboUserPosts,
} from "./weibo-api.js";
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

function scanMetric(bodyText, labels) {
  for (const label of labels) {
    let m = bodyText.match(new RegExp("([\\d.,]+\\s*[万亿wk]?)\\s*" + label, "i"));
    if (m) return parseCount(m[1]);
    m = bodyText.match(new RegExp(label + "\\s*([\\d.,]+\\s*[万亿wk]?)", "i"));
    if (m) return parseCount(m[1]);
  }
  return 0;
}

// 仅作兜底:接口拿不到时从 DOM 文本里尽力抠资料
function extractBloggerProfileDataFromDom() {
  const bodyText = cleanText(document.body?.innerText || "");
  const bloggerId = extractWeiboUid();

  const nameEl =
    document.querySelector('[class*="ProfileHeader_name"]') ||
    document.querySelector("h1") ||
    document.querySelector('[class*="username"], .username, .name');
  let name = nameEl ? cleanText(nameEl.textContent) : "";
  if (!name) {
    name = cleanText(document.title)
      .replace(/[_\-—]\s*微博.*$/u, "")
      .replace(/的微博$/u, "");
  }

  const avatarEl =
    document.querySelector(
      '[class*="ProfileHeader"] img, [class*="Avatar"] img, img.woo-avatar-img, .photo img',
    ) || document.querySelector("img");
  const avatarUrl = avatarEl ? avatarEl.src || "" : "";

  const bioEl = document.querySelector(
    '[class*="ProfileHeader_con"], [class*="description"], .pf_intro',
  );
  const description = bioEl ? cleanText(bioEl.textContent) : "";

  let ipLocation = "";
  const ipMatch = bodyText.match(/IP属地[:：]?\s*([^\s|｜]+)/i);
  if (ipMatch && ipMatch[1] && CN_REGIONS.includes(ipMatch[1])) ipLocation = ipMatch[1];

  return {
    platform: "weibo",
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

async function resolveBloggerProfile() {
  const uid = extractWeiboUid();
  if (uid) {
    try {
      const api = await fetchWeiboUserProfile(uid);
      if (api && api.bloggerName) return api;
    } catch {
      /* 落到 DOM 兜底 */
    }
  }
  return extractBloggerProfileDataFromDom();
}

export async function captureWeiboBloggerProfile() {
  const captureStartedAt = new Date().toISOString();
  const meta = () => ({
    pageType: PAGE_TYPE.BLOGGER_PROFILE,
    captureStartedAt,
    captureFinishedAt: new Date().toISOString(),
    sourceUrl: window.location.href,
  });
  try {
    const payload = await resolveBloggerProfile();
    if (!payload.bloggerId && !payload.bloggerName) {
      return {
        ok: false, platform: "weibo", type: SYNC_TYPE.BLOGGER_PROFILE, data: null, meta: meta(),
        error: { code: "NOT_FOUND", message: "未识别到微博用户资料,请确认在用户主页且已登录" },
      };
    }
    return { ok: true, platform: "weibo", type: SYNC_TYPE.BLOGGER_PROFILE, data: payload, meta: meta(), error: null };
  } catch (error) {
    return {
      ok: false, platform: "weibo", type: SYNC_TYPE.BLOGGER_PROFILE, data: null, meta: meta(),
      error: { code: "CAPTURE_FAILED", message: error?.message || String(error) },
    };
  }
}

export async function captureWeiboBloggerNotes(options = {}) {
  const { onProgress = null, maxScrolls = 8, maxDetectedItems = 50, minLikes = 0 } = options;
  const captureStartedAt = new Date().toISOString();
  const meta = () => ({
    pageType: PAGE_TYPE.BLOGGER_PROFILE,
    captureStartedAt,
    captureFinishedAt: new Date().toISOString(),
    sourceUrl: window.location.href,
  });

  try {
    const uid = extractWeiboUid();
    const profile = await resolveBloggerProfile();
    const bloggerIpLocation = profile.ipLocation || "";

    if (onProgress) {
      onProgress({ phase: "start", message: `开始采集「${profile.bloggerName}」的微博...` });
    }

    // ---- 主路径:AJAX 接口 ----
    let posts = [];
    if (uid) {
      try {
        posts = await fetchWeiboUserPosts(uid, {
          maxItems: maxDetectedItems,
          minLikes,
          onProgress,
          authorName: profile.bloggerName,
          followersCount: profile.followersCount || 0,
        });
      } catch (e) {
        if (onProgress) onProgress({ phase: "fallback", message: "接口受限,改用页面抓取..." });
      }
    }

    // ---- 兜底:DOM 抓取 ----
    if (!posts.length) {
      expandAllFullTexts();
      await wait(300);
      await scrollToLoadMore(maxScrolls, onProgress);
      expandAllFullTexts();
      await wait(300);
      const collected = collectPostsFromRoot(document, window.location.href, 1).posts;
      await hydrateWeiboStatusDetails(collected, { onProgress, limit: maxDetectedItems });
      posts = dedupePosts(collected)
        .filter((p) => Number(p.likes || 0) >= minLikes)
        .slice(0, maxDetectedItems);
    }

    // 统一补齐博主信息 + IP属地(单条没带属地时用博主属地兜底)
    posts.forEach((p) => {
      if (bloggerIpLocation && !p.region) p.region = bloggerIpLocation;
      if (bloggerIpLocation && !p.publishLocation) p.publishLocation = bloggerIpLocation;
      p.authorName = p.authorName || profile.bloggerName;
      p.authorFans = p.authorFans || profile.followersCount || 0;
      p.bloggerProfileUrl = p.bloggerProfileUrl || profile.bloggerUrl;
    });

    if (posts.length === 0) {
      return {
        ok: false, platform: "weibo", type: SYNC_TYPE.BLOGGER_NOTES, data: null, meta: meta(),
        error: { code: "NO_RESULTS", message: "未采到该博主的微博,请确认已登录且主页有内容" },
      };
    }

    if (onProgress) {
      onProgress({ phase: "done", count: posts.length, message: `采集完成,共 ${posts.length} 条微博` });
    }

    return {
      ok: true, platform: "weibo", type: SYNC_TYPE.BLOGGER_NOTES, meta: meta(), error: null,
      data: { ...profile, totalCount: posts.length, items: posts, notes: posts },
    };
  } catch (error) {
    return {
      ok: false, platform: "weibo", type: SYNC_TYPE.BLOGGER_NOTES, data: null, meta: meta(),
      error: { code: "CAPTURE_FAILED", message: error?.message || String(error) },
    };
  }
}
