import { getSingleNoteMetricDefinitions } from "../platform-registry.js";

function normalizeNoteUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  let normalized = raw;
  if (normalized.startsWith("//")) {
    normalized = `https:${normalized}`;
  }
  if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:\/\//i, "https://");
  }

  try {
    const parsed = new URL(normalized);
    const hostname = String(parsed.hostname || "").toLowerCase();
    const supportedHost =
      hostname === "xiaohongshu.com" ||
      hostname.endsWith(".xiaohongshu.com") ||
      hostname === "douyin.com" ||
      hostname.endsWith(".douyin.com");
    if (!supportedHost) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeDisplayMetricNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

export function formatMetricDisplay(value, { captured = true } = {}) {
  if (!captured) {
    return "未采集";
  }
  const normalized = normalizeDisplayMetricNumber(value);
  if (normalized === null) {
    return "未采集";
  }
  return String(normalized);
}

export function isVideoNotePayload(payload) {
  const noteType = String(payload?.noteType || payload?.type || "")
    .trim()
    .toLowerCase();
  if (noteType === "video" || noteType === "视频") {
    return true;
  }
  if (
    noteType === "image" ||
    noteType === "img" ||
    noteType === "图文" ||
    noteType === "normal"
  ) {
    return false;
  }

  return Boolean(payload?.videoUrl || payload?.videoLink || payload?.video_url);
}

export function normalizeBloggerNoteType(item) {
  const raw = String(item?.noteType || item?.type || "")
    .trim()
    .toLowerCase();
  if (raw === "video" || raw === "视频") {
    return "video";
  }
  if (raw === "image" || raw === "img" || raw === "图文" || raw === "normal") {
    return "image";
  }

  if (
    item?.videoUrl ||
    item?.videoLink ||
    item?.video_url ||
    (Array.isArray(item?.videoUrls) && item.videoUrls.length > 0)
  ) {
    return "video";
  }

  return "image";
}

export function buildSingleNoteCardData(payload = {}, platform = "unknown") {
  const hasDownloadableAsset = !!(
    payload.coverImageUrl ||
    (Array.isArray(payload.imageUrls) && payload.imageUrls.length > 0) ||
    payload.videoUrl ||
    payload.videoLink ||
    payload.video_url
  );

  const metricsLine = getSingleNoteMetricDefinitions(platform)
    .map(({ key, label }) => {
      const captured = payload[key] !== undefined && payload[key] !== null;
      return `${label}: ${formatMetricDisplay(payload[key], { captured })}`;
    })
    .join("　");

  return {
    typeLabel: isVideoNotePayload(payload) ? "视频" : "图文",
    cover: payload.coverImageUrl || (payload.imageUrls || [])[0] || "",
    title: payload.title || "无标题",
    titleUrl: normalizeNoteUrl(payload.url || payload.noteUrl || ""),
    author: payload.author || "作者未知",
    likes: payload.likes ?? null,
    collects: payload.collects ?? null,
    comments: payload.comments ?? null,
    shares: payload.shares ?? null,
    metricsLine,
    hasMedia: !!(
      payload.videoUrl ||
      payload.videoLink ||
      payload.video_url ||
      payload.coverImageUrl ||
      (payload.imageUrls || []).length > 0
    ),
    allowDownload: hasDownloadableAsset,
  };
}

export function buildDetailListCardData(record, payload = {}) {
  const item = (payload.items || [])[0] || {};
  const isBloggerNote = record.type === "blogger_notes";
  const hasLikes = item.likes !== undefined && item.likes !== null;
  const hasCollects = item.collects !== undefined && item.collects !== null;
  const hasComments = item.comments !== undefined && item.comments !== null;
  const bloggerNoteType = normalizeBloggerNoteType(item);
  const publishDateText = String(item.publishDate || item.publishDateRaw || "").trim();
  const sortDimension = String(payload.sortDimension || "")
    .trim()
    .toLowerCase();
  const keywordMetricLabel =
    sortDimension === "collects"
      ? "收藏数"
      : sortDimension === "comments"
        ? "评论数"
        : "点赞数";
  const keywordMetricValue =
    sortDimension === "collects"
      ? item.collects
      : sortDimension === "comments"
        ? item.comments
        : item.likes;
  const keywordMetricCaptured =
    sortDimension === "collects"
      ? hasCollects
      : sortDimension === "comments"
        ? hasComments
        : hasLikes;

  return {
    typeLabel: bloggerNoteType === "video" ? "视频" : "图文",
    cover: item.coverImageUrl || "",
    title: item.title || "无标题",
    titleUrl: normalizeNoteUrl(item.url || item.noteUrl || payload.url || payload.noteUrl || ""),
    author: item.author || payload.bloggerName || "作者未知",
    likes: hasLikes ? item.likes : null,
    collects: hasCollects ? item.collects : null,
    comments: hasComments ? item.comments : null,
    metricsLine: isBloggerNote
      ? `点赞数: ${formatMetricDisplay(item.likes, { captured: hasLikes })}`
      : `${keywordMetricLabel}: ${formatMetricDisplay(keywordMetricValue, { captured: keywordMetricCaptured })}`,
    metaLine: !isBloggerNote && publishDateText ? `笔记最近编辑时间：${publishDateText}` : "",
    hasMedia: !!item.coverImageUrl,
    allowDownload: false,
    useSideActionsLayout: true,
  };
}

export function buildBloggerProfileCardData(payload = {}) {
  const profileMetricsStatus = String(payload.bloggerMetricsCaptureStatus || "")
    .trim()
    .toLowerCase();
  const profileMetricsCaptured = profileMetricsStatus === "done";
  const hasFollowingCount =
    payload.followingCount !== undefined && payload.followingCount !== null;
  const hasFollowersCount =
    payload.followersCount !== undefined && payload.followersCount !== null;
  const hasLikedAndCollectedCount =
    payload.likedAndCollectedCount !== undefined &&
    payload.likedAndCollectedCount !== null;

  return {
    typeLabel: "博主信息",
    cover: payload.avatarUrl || "",
    title: payload.bloggerName || "博主信息",
    author: payload.douyinId || payload.bloggerId || "ID未知",
    likes: profileMetricsCaptured && hasFollowersCount ? payload.followersCount : null,
    collects: null,
    comments: null,
    metricsLine: "",
    hasMedia: !!payload.avatarUrl,
    allowDownload: false,
    profile: {
      bloggerName: payload.bloggerName || "",
      description: payload.description || "",
      bloggerUrl: payload.bloggerUrl || "",
      metricsCaptured: profileMetricsCaptured,
      followingCount:
        profileMetricsCaptured && hasFollowingCount ? payload.followingCount : null,
      followersCount:
        profileMetricsCaptured && hasFollowersCount ? payload.followersCount : null,
      likedAndCollectedCount:
        profileMetricsCaptured && hasLikedAndCollectedCount
          ? payload.likedAndCollectedCount
          : null,
      ipLocation: payload.ipLocation || "",
    },
  };
}

export function buildCommentsCardData(payload = {}) {
  const hasComments =
    payload.totalCount !== undefined && payload.totalCount !== null;
  return {
    typeLabel: "评论",
    cover: "",
    title: payload.noteTitle || "评论数据",
    titleUrl: normalizeNoteUrl(payload.noteUrl || payload.url || ""),
    author: "评论采集",
    likes: null,
    collects: null,
    comments: hasComments ? payload.totalCount : null,
    metricsLine: `评论数: ${formatMetricDisplay(payload.totalCount, { captured: hasComments })}`,
    hasMedia: false,
    allowDownload: false,
  };
}

export function buildUnknownCardData(record = {}) {
  return {
    typeLabel: "未知类型",
    cover: "",
    title: record.title || "无标题",
    titleUrl: "",
    author: "作者未知",
    likes: null,
    collects: null,
    comments: null,
    metricsLine: "点赞数: 未采集　收藏数: 未采集　评论数: 未采集",
    metaLine: "",
    hasMedia: false,
    allowDownload: false,
    useSideActionsLayout: false,
  };
}
