/**
 * Douyin Single Note Capture Module
 * Detail-first DOM capture for /video, /note and modal_id detail states.
 *
 * 采集策略：
 *   1. 以 DOM 解析为主，避免改写页面网络原语带来的风控风险
 *   2. 如历史版本残留 sessionStorage 缓存，则只做即时读取，不主动等待
 */

import { PAGE_TYPE, SYNC_TYPE } from "../constants.js";
import {
  parseInteractionCount,
  normalizeDate,
  cleanText,
  extractBloggerId,
  extractNoteId,
} from "../helpers.js";
import { wait, waitUntil } from "../scroll.js";
import { getDomProfile } from "../platform/dom-profiles/index.js";
import {
  ensureDetailPageReady,
  getAllMatches,
  getAllTexts,
  getAttribute,
  getFirstMatch,
  getText,
  resolveDetailRoot,
} from "./shared/detail-dom.js";

const DOUYIN_DOM_PROFILE = getDomProfile("douyin");
const DOUYIN_INLINE_BLOGGER_METRICS_SELECTORS = Object.freeze([
  '[data-e2e="user-info"] .ttf3L0K8',
  '[data-e2e="user-info"] p.ttf3L0K8',
  '.author-card-user-stats',
  '.wRhsTKHs.author-card-user-stats',
]);

const DOUYIN_DETAIL_TAB_CANDIDATE_SELECTORS = Object.freeze([
  '[role="tab"]',
  '[role="button"]',
  "button",
  "a",
  "span",
  "div",
]);

const DOUYIN_AUTHOR_ENTRY_SELECTORS = Object.freeze([
  'img.fiWP27dC',
  '[data-click-from="click_icon"] img[src*="aweme-avatar"]',
  '[data-e2e="feed-video-nickname"]',
  '[data-e2e="feed-video-nickname"] a[href*="/user/"]',
  '[data-e2e="video-info"] a[href*="/user/"]',
  '.video-info-detail a[href*="/user/"]',
  '[data-click-from="click_icon"]',
  '[data-click-from="click_icon"] [data-e2e="video-avatar"]',
  '[data-click-from="click_icon"] [data-e2e="live-avatar"]',
  '[data-e2e="feed-avatar"]',
  '[data-e2e="video-avatar"]',
  '[data-e2e="user-avatar"]',
  '[data-e2e="live-avatar"]',
  'a[href*="/user/"] img',
  'div[class*="avatar"] img',
  'div[class*="Avatar"] img',
]);

const STRICT_DOUYIN_AVATAR_SELECTORS = Object.freeze([
  '[data-e2e="live-avatar"]',
  '[data-e2e="video-avatar"]',
  '[data-e2e="feed-avatar"]',
  '[data-e2e="user-avatar"]',
  '[data-e2e="live-avatar"] img',
  '[data-e2e="video-avatar"] img',
  '[data-e2e="feed-avatar"] img',
  '[data-e2e="user-avatar"] img',
]);

function safeReadGlobal(key) {
  if (!key) return undefined;
  try {
    return globalThis[key];
  } catch {
    return undefined;
  }
}

function safeGet(object, key) {
  if (!object || !key) return undefined;
  try {
    return object[key];
  } catch {
    return undefined;
  }
}

function isUnsafeStateObject(value) {
  if (!value || typeof value !== "object") return false;

  try {
    if (value === globalThis) return true;
  } catch {}

  try {
    const tag = Object.prototype.toString.call(value);
    if (
      /\[object (Window|Location|Document|Navigator|MediaSource|SourceBuffer|SourceBufferList|MediaKeySession|MediaKeys|MediaKeyStatusMap|TextTrack|TextTrackList|AudioTrack|AudioTrackList|VideoTrack|VideoTrackList|EventTarget)\]/.test(
        tag,
      )
    ) {
      return true;
    }
  } catch {}

  const nodeType = safeGet(value, "nodeType");
  if (typeof nodeType === "number") {
    return true;
  }

  const selfRef = safeGet(value, "self");
  const windowRef = safeGet(value, "window");
  if (selfRef === value || windowRef === value) {
    return true;
  }

  const documentRef = safeGet(value, "document");
  if (documentRef && typeof documentRef === "object") {
    return true;
  }

  return false;
}

function safeObjectValues(object) {
  if (!object || typeof object !== "object" || isUnsafeStateObject(object)) {
    return [];
  }

  try {
    return Object.values(object);
  } catch {
    return [];
  }
}

function safeOwnPropertyNames(object) {
  if (!object || (typeof object !== "object" && typeof object !== "function")) {
    return [];
  }

  try {
    return Object.getOwnPropertyNames(object);
  } catch {
    return [];
  }
}

// ── API 缓存读取（由 douyin-interceptor.js 写入 sessionStorage）──────────

const _CACHE_KEY_PREFIX = "__mc_dy_detail_";
const _MEDIA_CACHE_KEY = "__mc_dy_media_requests__";
const _DETAIL_REQUEST_EVENT = "__mc_dy_request_detail__";
const _CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟
const DOUYIN_MEDIA_REQUEST_WINDOW_MS = 12000;
const DOUYIN_PERFORMANCE_WINDOW_MS = 12000;

const VIDEO_SOURCE_PRIORITY = {
  apiDetail: 260,
  state: 220,
  react: 200,
  playerRuntime: 180,
  documentVideo: 150,
  videoElement: 140,
  mediaRequests: 100,
  performance: 80,
  inline: 40,
};

/**
 * 从 sessionStorage 读取拦截到的抖音 API 响应数据。
 * @param {string} awemeId
 * @returns {object|null} aweme_detail 对象，或 null
 */
function readDouyinApiCache(awemeId) {
  if (!awemeId) return null;
  const cacheKey = _CACHE_KEY_PREFIX + awemeId;
  try {
    const raw =
      sessionStorage.getItem(cacheKey) ||
      localStorage.getItem(cacheKey);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== "object") return null;
    if (Date.now() - (entry.ts || 0) > _CACHE_TTL_MS) {
      sessionStorage.removeItem(cacheKey);
      localStorage.removeItem(cacheKey);
      return null;
    }
    return entry.detail || null;
  } catch (_) {
    return null;
  }
}

function listDouyinApiCacheKeys() {
  try {
    const keys = new Set();
    [sessionStorage, localStorage].forEach((storage) => {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (typeof key === "string" && key.startsWith(_CACHE_KEY_PREFIX)) {
          keys.add(key.replace(_CACHE_KEY_PREFIX, ""));
        }
      }
    });
    return Array.from(keys);
  } catch {
    return [];
  }
}

async function waitForDouyinApiCache(awemeId, { timeoutMs = 2000, intervalMs = 120 } = {}) {
  const normalizedId = String(awemeId || "").trim();
  if (!normalizedId) {
    return null;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const cached = readDouyinApiCache(normalizedId);
    if (cached) {
      return cached;
    }
    await wait(intervalMs);
  }

  return null;
}

async function requestDouyinApiDetailFromMainWorld(
  awemeId,
  { timeoutMs = 2200, intervalMs = 120 } = {},
) {
  const normalizedId = String(awemeId || "").trim();
  if (!normalizedId) {
    return null;
  }

  const cached = readDouyinApiCache(normalizedId);
  if (cached) {
    return cached;
  }

  try {
    window.dispatchEvent(
      new CustomEvent(_DETAIL_REQUEST_EVENT, {
        detail: {
          awemeId: normalizedId,
          requestedAt: Date.now(),
        },
      }),
    );
  } catch (error) {
    console.warn("[Douyin][SingleNote] detail request dispatch failed:", normalizedId, error);
    return null;
  }

  return waitForDouyinApiCache(normalizedId, { timeoutMs, intervalMs });
}

function readInterceptedMediaRequests() {
  try {
    const raw = sessionStorage.getItem(_MEDIA_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        url: normalizeUrl(item?.url || ""),
        ts: Number(item?.ts || 0),
      }))
      .filter((item) => item.url);
  } catch {
    return [];
  }
}

function buildUrlSourceMap(mediaUrlCollection = {}) {
  const map = new Map();

  Object.entries(mediaUrlCollection || {}).forEach(([source, urls]) => {
    if (source === "allUrls" || !Array.isArray(urls)) {
      return;
    }

    urls.forEach((rawUrl) => {
      const url = normalizeUrl(rawUrl);
      if (!url) return;
      const bucket = map.get(url) || new Set();
      bucket.add(source);
      map.set(url, bucket);
    });
  });

  return map;
}

function collectExpectedVideoIdentityTokens(detail) {
  if (!detail || typeof detail !== "object") {
    return [];
  }

  const tokens = new Set();
  const pushToken = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized || normalized.length < 6) {
      return;
    }
    if (/^https?:\/\//i.test(normalized)) {
      try {
        const parsed = new URL(normalized);
        const videoId = parsed.searchParams.get("video_id");
        if (videoId && videoId.length >= 6) {
          tokens.add(videoId);
        }
      } catch {}
    }
    if (/^[a-z0-9_-]{6,}$/i.test(normalized)) {
      tokens.add(normalized);
    }
  };

  const video = safeGet(detail, "video");
  const bitRates = Array.isArray(safeGet(video, "bit_rate"))
    ? safeGet(video, "bit_rate")
    : Array.isArray(safeGet(video, "bitRate"))
      ? safeGet(video, "bitRate")
      : [];

  [
    detail,
    video,
    safeGet(video, "play_addr"),
    safeGet(video, "playAddr"),
    safeGet(video, "download_addr"),
    safeGet(video, "downloadAddr"),
    safeGet(video, "play_addr_h264"),
    safeGet(video, "playAddrH264"),
    ...bitRates,
  ].forEach((node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    [
      safeGet(node, "uri"),
      safeGet(node, "video_id"),
      safeGet(node, "videoId"),
      safeGet(node, "play_api"),
      safeGet(node, "playApi"),
    ].forEach(pushToken);

    extractUrlsFromPlayAddress(node).forEach(pushToken);
  });

  return Array.from(tokens);
}

function buildVideoSelectionContext({
  noteId = "",
  detailRoot = null,
  mediaUrlCollection = {},
  apiDetail = null,
} = {}) {
  const sourceMap = buildUrlSourceMap(mediaUrlCollection);
  const expectedTokens = new Set();

  const normalizedNoteId = String(noteId || "").trim();
  if (normalizedNoteId) {
    expectedTokens.add(normalizedNoteId);
  }

  const cachedDetail =
    apiDetail ||
    (normalizedNoteId ? readDouyinApiCache(normalizedNoteId) : null);
  collectExpectedVideoIdentityTokens(cachedDetail).forEach((token) => expectedTokens.add(token));

  const scopedVideo = detailRoot?.querySelector?.("video");
  const scopedPoster = normalizeUrl(
    scopedVideo?.getAttribute?.("poster") || scopedVideo?.poster || "",
  );
  if (scopedPoster) {
    const basename = scopedPoster.split("?")[0].split("/").pop();
    if (basename && basename.length >= 6) {
      expectedTokens.add(basename);
    }
  }

  return {
    noteId: normalizedNoteId,
    expectedTokens: Array.from(expectedTokens),
    urlSourceMap: sourceMap,
  };
}

/**
 * 从抖音 API 的 aweme_detail 对象直接映射采集 payload。
 * 字段来源：/aweme/v1/aweme/detail/ 或 /aweme/v1/feed/ 响应体。
 * @param {object} detail
 * @param {string} noteId
 * @returns {object} payload
 */
function buildPayloadFromApiDetail(detail, noteId) {
  const stats = (detail.statistics && typeof detail.statistics === "object")
    ? detail.statistics : {};
  const video = (detail.video && typeof detail.video === "object")
    ? detail.video : {};
  const author = (detail.author && typeof detail.author === "object")
    ? detail.author : {};
  const music = (detail.music && typeof detail.music === "object")
    ? detail.music : {};

  // 话题标签
  const tags = [];
  if (Array.isArray(detail.text_extra)) {
    detail.text_extra.forEach((item) => {
      if (item && item.hashtag_name) tags.push("#" + item.hashtag_name);
    });
  }

  const coverUrls = uniqueNormalized([
    ...extractCoverUrlsFromStateNode(detail),
    ...extractCoverUrlsFromStateNode(video),
  ]).filter((url) => isPossibleDouyinImageUrl(url));
  const imageUrls = extractDouyinImageUrlsFromApiDetail(detail);
  const coverImageUrl = pickPreferredCoverUrl(coverUrls) || null;

  // 作者主页 URL（用 sec_uid 构造）
  const secUid = author.sec_uid || "";
  const authorUrl = secUid
    ? `https://www.douyin.com/user/${secUid}` : null;

  // 发布时间：create_time 是 Unix 秒级时间戳
  const publishTimestamp = detail.create_time ? detail.create_time * 1000 : null;
  const lastEditedAt = publishTimestamp
    ? new Date(publishTimestamp).toISOString() : null;

  const title = detail.desc || "";
  const inferredPath = inferDouyinNotePath(noteId, detail);
  const noteType = inferredPath === "note" ? "image" : "video";
  const mediaUrlCollection = {
    apiDetail: uniqueNormalized(extractMediaUrlsFromStateNode(detail)),
  };
  const videoSelectionContext = buildVideoSelectionContext({
    noteId,
    mediaUrlCollection,
    apiDetail: detail,
  });
  const mediaCandidates = mediaUrlCollection.apiDetail || [];
  const videoUrls = uniqueNormalized(
    mediaCandidates.filter((url) => isLikelyDouyinVideoUrl(url)),
  );
  const audioUrls = uniqueNormalized(
    mediaCandidates.filter((url) => isLikelyDownloadableDouyinAudioUrl(url)),
  );
  const selectedVideoUrl = pickPreferredVideoUrl(videoUrls, videoSelectionContext);
  const selectedAudioUrl = pickPreferredAudioUrl(audioUrls);
  const bloggerMetrics = resolveDouyinNoteBloggerMetrics({
    apiDetail: detail,
    detailRoot: resolvePotentialDouyinMetricsScope(),
  });

  return {
    noteId: String(noteId),
    url: buildDouyinCanonicalNoteUrl(noteId, noteType, detail),
    title,
    author: author.nickname || "",
    authorId: secUid || author.uid || "",
    authorUsername: author.unique_id || "",
    authorUrl,
    content: title,
    tags,
    likes: stats.digg_count ?? null,
    collects: stats.collect_count ?? null,
    comments: stats.comment_count ?? null,
    shares: stats.share_count ?? null,
    publishTimestamp,
    publishTime: lastEditedAt || "",
    publishDateRaw: lastEditedAt || "",
    lastEditedAt,
    noteType,
    coverImageUrl,
    imageUrls: noteType === "image" ? imageUrls : [],
    videoUrl: selectedVideoUrl,
    videoUrls,
    audioUrl: selectedAudioUrl,
    audioUrls,
    audioAvailability: selectedAudioUrl ? "collected" : "not_collected",
    videoDuration: noteType === "video" ? video.duration || null : null,
    followersCount: bloggerMetrics.followersCount,
    likedAndCollectedCount: bloggerMetrics.likedAndCollectedCount,
    bloggerFollowersCount: bloggerMetrics.followersCount,
    bloggerLikedAndCollectedCount: bloggerMetrics.likedAndCollectedCount,
    bloggerProfileUrl: authorUrl || "",
    bloggerMetricsCaptureStatus: "not_started",
    bloggerMetricsCaptureError: "",
    bloggerAccountType: bloggerMetrics.accountType,
    captureTimestamp: Date.now(),
    _source: "api_cache",
  };
}

function isLikelyVideoContext(noteUrl = "") {
  const normalized = String(noteUrl || window.location.href || "");
  return /\/video\//i.test(normalized) || /modal_id=/i.test(normalized);
}

function isUsableApiPayload(payload, detail, options = {}) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const expectVideo = Boolean(options?.expectVideo);
  const awemeType = Number(detail?.aweme_type || 0);
  const isVideoLike =
    expectVideo ||
    payload.noteType === "video" ||
    awemeType === 4 ||
    awemeType === 68 ||
    Boolean(detail?.video?.duration);

  if (isVideoLike) {
    return Boolean(payload.coverImageUrl || payload.title || payload.author);
  }

  return Boolean(
    Array.isArray(payload.imageUrls) && payload.imageUrls.length > 0,
  );
}

function hasRequiredDouyinBloggerMetrics(payload) {
  const followersCount = normalizeNonNegativeInteger(
    payload?.bloggerFollowersCount ?? payload?.followersCount,
  );
  const likedAndCollectedCount = normalizeNonNegativeInteger(
    payload?.bloggerLikedAndCollectedCount ?? payload?.likedAndCollectedCount,
  );

  return followersCount > 0 && likedAndCollectedCount > 0;
}

// ── 主采集函数 ────────────────────────────────────────────────────────────

export async function captureDouyinSingleNote({
  includeBloggerMetrics = false,
  preferWorksTabForBloggerMetrics = false,
} = {}) {
  const captureStartedAt = new Date().toISOString();

  try {
    // 1. 从 URL 提取 aweme_id
    const urlNoteId =
      extractNoteId(window.location.href) ||
      new URL(window.location.href).searchParams.get("modal_id");
    const videoContext = isLikelyVideoContext(window.location.href);

    // 2. 优先尝试命中当前作品的详情缓存，短等待一次接口结果
    if (urlNoteId) {
      let cachedDetail = readDouyinApiCache(urlNoteId);
      if (!cachedDetail) {
        cachedDetail = await waitForDouyinApiCache(urlNoteId, {
          timeoutMs: videoContext ? 480 : 320,
          intervalMs: 80,
        });
      }
      if (cachedDetail) {
        console.log("[Douyin][SingleNote] API cache hit:", urlNoteId, {
          hasVideo: Boolean(
            cachedDetail?.video?.play_addr ||
              cachedDetail?.video?.playAddr ||
              cachedDetail?.video?.bit_rate ||
              cachedDetail?.video?.bitRate,
          ),
        });
        const basePayload = supplementDouyinImageNotePayload(
          buildPayloadFromApiDetail(cachedDetail, urlNoteId),
          urlNoteId,
          cachedDetail,
        );
        const payload = includeBloggerMetrics
          ? await enrichDouyinPayloadWithBloggerMetrics(basePayload, {
              noteId: urlNoteId,
              apiDetail: cachedDetail,
              preferWorksTabForBloggerMetrics,
            })
          : basePayload;
        if (
          isUsableApiPayload(payload, cachedDetail, {expectVideo: videoContext}) &&
          (!includeBloggerMetrics || hasRequiredDouyinBloggerMetrics(payload))
        ) {
          return {
            ok: true,
            type: SYNC_TYPE.SINGLE_NOTE,
            data: payload,
            meta: {
              pageType: PAGE_TYPE.NOTE_DETAIL,
              captureStartedAt,
              captureFinishedAt: new Date().toISOString(),
              source: "api_cache",
            },
            error: null,
          };
        }
        if (includeBloggerMetrics) {
          console.log(
            "[Douyin][SingleNote] API payload missing blogger metrics, continue DOM workflow:",
            urlNoteId,
            {
              followersCount:
                payload?.bloggerFollowersCount ?? payload?.followersCount ?? 0,
              likedAndCollectedCount:
                payload?.bloggerLikedAndCollectedCount ??
                payload?.likedAndCollectedCount ??
                0,
            },
          );
        }
        console.warn(
          "[Douyin][SingleNote] API cache incomplete, fallback to DOM:",
          urlNoteId,
          payload,
        );
        cachedDetail = await requestDouyinApiDetailFromMainWorld(urlNoteId, {
          timeoutMs: videoContext ? 2600 : 1800,
          intervalMs: 120,
        });
        if (cachedDetail) {
          const refreshedBasePayload = supplementDouyinImageNotePayload(
            buildPayloadFromApiDetail(cachedDetail, urlNoteId),
            urlNoteId,
            cachedDetail,
          );
          const refreshedPayload = includeBloggerMetrics
            ? await enrichDouyinPayloadWithBloggerMetrics(
                refreshedBasePayload,
                {
                  noteId: urlNoteId,
                  apiDetail: cachedDetail,
                  preferWorksTabForBloggerMetrics,
                },
              )
            : refreshedBasePayload;
          if (
            isUsableApiPayload(refreshedPayload, cachedDetail, {
              expectVideo: videoContext,
            }) &&
            (!includeBloggerMetrics ||
              hasRequiredDouyinBloggerMetrics(refreshedPayload))
          ) {
            return {
              ok: true,
              type: SYNC_TYPE.SINGLE_NOTE,
              data: refreshedPayload,
              meta: {
                pageType: PAGE_TYPE.NOTE_DETAIL,
                captureStartedAt,
                captureFinishedAt: new Date().toISOString(),
                source: "api_request",
              },
              error: null,
            };
          }
          if (includeBloggerMetrics) {
            console.log(
              "[Douyin][SingleNote] API request payload still missing blogger metrics, continue DOM workflow:",
              urlNoteId,
              {
                followersCount:
                  refreshedPayload?.bloggerFollowersCount ??
                  refreshedPayload?.followersCount ??
                  0,
                likedAndCollectedCount:
                  refreshedPayload?.bloggerLikedAndCollectedCount ??
                  refreshedPayload?.likedAndCollectedCount ??
                  0,
              },
            );
          }
        }
      } else {
        console.log("[Douyin][SingleNote] API cache miss, request main-world detail:", urlNoteId);
        cachedDetail = await requestDouyinApiDetailFromMainWorld(urlNoteId, {
          timeoutMs: videoContext ? 2600 : 1800,
          intervalMs: 120,
        });
        if (cachedDetail) {
          console.log("[Douyin][SingleNote] API request hit:", urlNoteId, {
            hasVideo: Boolean(
              cachedDetail?.video?.play_addr ||
                cachedDetail?.video?.playAddr ||
                cachedDetail?.video?.bit_rate ||
                cachedDetail?.video?.bitRate,
            ),
          });
          const basePayload = supplementDouyinImageNotePayload(
            buildPayloadFromApiDetail(cachedDetail, urlNoteId),
            urlNoteId,
            cachedDetail,
          );
          const payload = includeBloggerMetrics
            ? await enrichDouyinPayloadWithBloggerMetrics(basePayload, {
                noteId: urlNoteId,
                apiDetail: cachedDetail,
                preferWorksTabForBloggerMetrics,
              })
            : basePayload;
          if (
            isUsableApiPayload(payload, cachedDetail, { expectVideo: videoContext }) &&
            (!includeBloggerMetrics || hasRequiredDouyinBloggerMetrics(payload))
          ) {
            return {
              ok: true,
              type: SYNC_TYPE.SINGLE_NOTE,
              data: payload,
              meta: {
                pageType: PAGE_TYPE.NOTE_DETAIL,
                captureStartedAt,
                captureFinishedAt: new Date().toISOString(),
                source: "api_request",
              },
              error: null,
            };
          }
          if (includeBloggerMetrics) {
            console.log(
              "[Douyin][SingleNote] Requested API payload missing blogger metrics, continue DOM workflow:",
              urlNoteId,
              {
                followersCount:
                  payload?.bloggerFollowersCount ?? payload?.followersCount ?? 0,
                likedAndCollectedCount:
                  payload?.bloggerLikedAndCollectedCount ??
                  payload?.likedAndCollectedCount ??
                  0,
              },
            );
          }
        }
      }
      console.log("[Douyin][SingleNote] API cache miss:", urlNoteId, {
        knownCacheIds: listDouyinApiCacheKeys().slice(0, 12),
      });
    }

    // 3. 纯 DOM 解析
    await wait(1200);
    assertNoCaptchaPage();
    await ensureDetailPageReady(DOUYIN_DOM_PROFILE, { timeout: 10000 });

    const detailRoot = resolveActiveDouyinDetailRoot();
    const noteId = resolveDouyinNoteId(detailRoot);
    if (!noteId) {
      throw new Error("无法识别当前抖音作品 ID");
    }
    const noteUrl = resolveDouyinNoteUrl(detailRoot, noteId);
    await waitForDouyinMediaBootstrap(noteId, noteUrl);

    const authorInfo = extractDouyinAuthorInfo(detailRoot);
    const title = extractDouyinTitle(detailRoot);
    const tags = extractDouyinTags(detailRoot, title);
    const interactions = extractDouyinInteractions(detailRoot);
    let bloggerMetrics = normalizeDouyinBloggerMetrics({});
    if (includeBloggerMetrics) {
      bloggerMetrics = resolveDouyinNoteBloggerMetrics({
        detailRoot,
        apiDetail: readDouyinApiCache(noteId),
      });
      bloggerMetrics = await waitForDouyinBloggerMetrics(bloggerMetrics, {
        noteId,
        apiDetail: readDouyinApiCache(noteId),
        detailRoot,
        preferWorksTabForBloggerMetrics,
      });
    }
    const publishText = extractDouyinPublishText(detailRoot);
    // 优先用拦截到的 API create_time(最可靠的发布时间戳),DOM 文本兜底。本 fork 自加。
    const apiCreateTime = readDouyinApiCache(noteId)?.create_time;
    const resolvedPublishText = apiCreateTime
      ? new Date(Number(apiCreateTime) * 1000).toISOString()
      : publishText;
    let media = await observeStableDouyinMedia(noteId, noteUrl);
    printDouyinMediaDiagnostics(media?.diagnostics);
    const expectsVideo =
      isLikelyVideoContext(noteUrl) ||
      Boolean(new URL(window.location.href).searchParams.get("modal_id")) ||
      media.hasVideo;
    console.log("[Douyin][SingleNote][Attempt 0]", {
      noteId,
      noteUrl,
      hasVideo: media.hasVideo,
      coverImage: media.coverImage,
      videoDuration: media.videoDuration,
    });
    if (expectsVideo && !media.coverImage) {
      const retryApiDetail = readDouyinApiCache(noteId);
      for (
        let attempt = 0;
        attempt < 8 && !media.coverImage;
        attempt += 1
      ) {
        await wait(400);
        const refreshedRoot = resolveActiveDouyinDetailRoot();
        media = extractDouyinMedia(refreshedRoot, noteId, {
          apiDetail: retryApiDetail,
        });
        console.log("[Douyin][SingleNote][RetryAttempt]", {
          noteId,
          noteUrl,
          attempt: attempt + 1,
          hasVideo: media.hasVideo,
          coverImage: media.coverImage,
          videoDuration: media.videoDuration,
        });
      }
    }

    const contextualNoteType = resolveDouyinContextualNoteType({
      noteId,
      noteUrl,
      payload: {
        noteType: media.hasVideo ? "video" : "image",
        imageUrls: media.images,
      },
      apiDetail: readDouyinApiCache(noteId),
      media,
    });

    const payload = {
      noteId,
      url: noteUrl,
      title,
      author: authorInfo.name,
      authorId: authorInfo.userId,
      authorUrl: authorInfo.url,
      content: title,
      tags,
      likes: interactions.likes,
      collects: interactions.collects,
      comments: interactions.comments,
      shares: interactions.shares,
      publishTime: resolvedPublishText,
      publishDateRaw: resolvedPublishText,
      lastEditedAt: normalizeDouyinPublishDate(resolvedPublishText),
      noteType: contextualNoteType,
      type: contextualNoteType,
      coverImageUrl: media.coverImage,
      imageUrls: contextualNoteType === "image" ? media.images : [],
      videoUrl: contextualNoteType === "video" ? media.videoUrl : "",
      videoUrls: contextualNoteType === "video" ? media.videoUrls : [],
      audioUrl: contextualNoteType === "video" ? media.audioUrl : "",
      audioUrls: contextualNoteType === "video" ? media.audioUrls : [],
      audioAvailability:
        contextualNoteType === "video" && media.audioUrl ? "collected" : "not_collected",
      videoDuration: contextualNoteType === "video" ? media.videoDuration : null,
      followersCount: bloggerMetrics.followersCount,
      likedAndCollectedCount: bloggerMetrics.likedAndCollectedCount,
      bloggerFollowersCount: bloggerMetrics.followersCount,
      bloggerLikedAndCollectedCount: bloggerMetrics.likedAndCollectedCount,
      bloggerProfileUrl: authorInfo.url || "",
      bloggerMetricsCaptureStatus: "not_started",
      bloggerMetricsCaptureError: "",
      bloggerAccountType: bloggerMetrics.accountType,
      captureTimestamp: Date.now(),
    };

    const finalizedPayload =
      contextualNoteType === "image"
        ? supplementDouyinImageNotePayload(payload, noteId, readDouyinApiCache(noteId))
        : payload;

    validateDouyinMediaPayload(finalizedPayload, media);

    return {
      ok: true,
      type: SYNC_TYPE.SINGLE_NOTE,
      data: finalizedPayload,
      meta: {
        pageType: PAGE_TYPE.NOTE_DETAIL,
        captureStartedAt,
        captureFinishedAt: new Date().toISOString(),
      },
      error: null,
    };
  } catch (error) {
    console.error("[Douyin][SingleNote] Capture failed:", error);
    return {
      ok: false,
      type: SYNC_TYPE.SINGLE_NOTE,
      data: null,
      meta: {
        pageType: PAGE_TYPE.NOTE_DETAIL,
        captureStartedAt,
        captureFinishedAt: new Date().toISOString(),
      },
      error: {
        code: "CAPTURE_FAILED",
        message: error.message,
      },
    };
  }
}

function assertNoCaptchaPage() {
  const title = cleanText(document.title || "");
  const bodyText = cleanText(document.body?.innerText || "");
  if (/验证码中间页/i.test(title) || /请完成下列验证后继续:/i.test(bodyText)) {
    throw new Error("当前页面触发抖音验证码或风险中间页");
  }
}

function resolveDouyinNoteId(detailRoot) {
  // 1. 最高优先级：从当前 URL 强行提取（包括 modal_id）
  const fromUrl = extractNoteId(window.location.href);
  if (fromUrl) return fromUrl;

  const modalId = new URL(window.location.href).searchParams.get("modal_id");
  if (modalId) return modalId;

  // 2. 其次：尝试从传递进来的 detailRoot 取（前提是 root 找得对）
  const rootAwemeId = String(detailRoot?.getAttribute?.("data-e2e-aweme-id") || "").trim();
  if (rootAwemeId) return rootAwemeId;

  const awemeId = getAttribute(
    DOUYIN_DOM_PROFILE.noteDetail.fields.noteId,
    "data-e2e-aweme-id",
    detailRoot,
  );
  if (awemeId) return awemeId;

  const detailHref = getAttribute(
    ['a[href*="/video/"]', 'a[href*="/note/"]'],
    "href",
    detailRoot,
  );
  const fromHref = extractNoteId(normalizeUrl(detailHref));
  if (fromHref) return fromHref;

  const video = getFirstMatch(DOUYIN_DOM_PROFILE.noteDetail.fields.video, detailRoot);
  const sourceUrl =
    video?.getAttribute("src") ||
    video?.currentSrc ||
    video?.querySelector("source[src]")?.getAttribute("src") ||
    "";
  const fromVideoUrl = extractNoteId(String(sourceUrl || ""));
  if (fromVideoUrl) return fromVideoUrl;

  return "";
}

function resolveDouyinNoteUrl(detailRoot, noteId) {
  const currentUrl = String(window.location.href || "").trim();
  if (extractNoteId(currentUrl) === String(noteId || "")) {
    return currentUrl;
  }

  const scopedHref = getAttribute(
    ['a[href*="/video/"]', 'a[href*="/note/"]'],
    "href",
    detailRoot,
  );
  const normalizedScopedHref = normalizeUrl(scopedHref);
  if (extractNoteId(normalizedScopedHref) === String(noteId || "")) {
    return normalizedScopedHref;
  }

  const notePath = inferDouyinNotePath(noteId);
  return `https://www.douyin.com/${notePath}/${noteId}`;
}

function buildDouyinCanonicalNoteUrl(noteId, noteType = "", detail = null) {
  const normalizedNoteId = String(noteId || "").trim();
  if (!normalizedNoteId) {
    return "";
  }

  const normalizedType = String(noteType || "").toLowerCase();
  if (normalizedType === "video") {
    return `https://www.douyin.com/video/${normalizedNoteId}`;
  }
  if (normalizedType === "image" || normalizedType === "note") {
    return `https://www.douyin.com/note/${normalizedNoteId}`;
  }

  const inferredPath = inferDouyinNotePath(normalizedNoteId, detail);
  return `https://www.douyin.com/${inferredPath}/${normalizedNoteId}`;
}

function inferDouyinNotePath(noteId = "", detail = null) {
  const currentUrl = String(window.location.href || "");
  if (extractNoteId(currentUrl) === String(noteId || "")) {
    if (/\/note\//i.test(currentUrl)) return "note";
    if (/\/video\//i.test(currentUrl)) return "video";
  }

  const awemeType = Number(detail?.aweme_type || 0);
  if (
    detail &&
    !detail?.video?.duration &&
    ![4, 68].includes(awemeType) &&
    extractDouyinImageUrlsFromApiDetail(detail).length > 0
  ) {
    return "note";
  }

  return "video";
}

async function waitForDouyinMediaBootstrap(noteId = "", noteUrl = "") {
  if (!isLikelyVideoContext(noteUrl)) {
    return;
  }

  const timeoutMs = 3200;
  const pollMs = 200;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (hasReadyVideoElement(noteId)) {
      return;
    }
    await wait(pollMs);
  }
}

function hasReadyVideoElement(noteId = "") {
  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) {
    return false;
  }

  for (const video of videos) {
    const current = normalizeUrl(video?.currentSrc || video?.src || "");
    const poster = normalizeUrl(video?.poster || video?.getAttribute?.("poster") || "");
    const hasVideoUrl = current && isLikelyDouyinVideoUrl(current);
    const hasPosterUrl = poster && isPossibleDouyinImageUrl(poster);
    if (!hasVideoUrl && !hasPosterUrl) {
      continue;
    }

    if (!noteId) {
      return true;
    }

    if (hasVideoUrl && String(current).includes(String(noteId))) {
      return true;
    }

    const scopedRoot =
      video.closest?.("[data-e2e-aweme-id]") ||
      video.closest?.(".swiper-slide") ||
      video.closest?.('[role="dialog"]');
    const scopedId = String(scopedRoot?.getAttribute?.("data-e2e-aweme-id") || "").trim();
    if (scopedId && scopedId === String(noteId)) {
      return true;
    }
  }

  return false;
}

function resolveActiveDouyinDetailRoot() {
  const fallbackRoot = resolveDetailRoot(DOUYIN_DOM_PROFILE);
  
  // 1. 最高优先级：如果出现弹窗，且弹窗里有活跃视频，那绝对是当前观看的实体
  const activeVideo = pickActiveDouyinVideoElement();
  if (activeVideo) {
     const modalRoot = activeVideo.closest('[role="dialog"]') || activeVideo.closest('[class*="Modal"]') || activeVideo.closest('[class*="modal"]');
     if (modalRoot && isMeaningfulDouyinDetailRoot(modalRoot)) {
       return modalRoot;
     }
     
     const swiperRoot = activeVideo.closest('.swiper-slide-active');
     if (swiperRoot && isMeaningfulDouyinDetailRoot(swiperRoot)) {
       return swiperRoot;
     }
  }

  // 2. 其次锚点：从 URL 获取明确的视频 ID 并去匹配
  const realNoteId = extractNoteId(window.location.href) || new URL(window.location.href).searchParams.get("modal_id");
  let anchorNode = null;
  
  if (realNoteId) {
    const perfectMatches = Array.from(document.querySelectorAll(`[data-e2e-aweme-id="${realNoteId}"]`));
    if (perfectMatches.length > 0) {
      anchorNode = perfectMatches.find(n => n.closest('[role="dialog"]') || n.closest('[class*="Modal"]') || n.closest('[class*="modal"]')) 
                || perfectMatches.find(n => n.closest('.swiper-slide-active')) 
                || perfectMatches[0];
    }
  }

  if (anchorNode) {
     let expandedRoot = anchorNode.closest('.swiper-slide-active') || anchorNode.closest('.swiper-slide');
     
     if (!expandedRoot) {
       expandedRoot = anchorNode.closest('[role="dialog"]') || anchorNode.closest('[class*="Modal"]') || anchorNode.closest('[class*="modal"]');
     }
     
     if (!expandedRoot) {
       expandedRoot = anchorNode.parentElement?.parentElement || anchorNode;
     }

     return expandedRoot;
  }

  // 3. 回退方案
  const candidateRoots = getAllMatches(
    DOUYIN_DOM_PROFILE.noteDetail.rootSelectors,
    document,
  ).filter((node) => isMeaningfulDouyinDetailRoot(node));

  if (candidateRoots.length === 0) {
    return fallbackRoot;
  }

  if (activeVideo) {
    const matchedRoot = pickClosestContainingRoot(candidateRoots, activeVideo);
    if (matchedRoot) {
      return matchedRoot;
    }
  }

  const bestVisibleRoot = pickMostVisibleDouyinRoot(candidateRoots);
  return bestVisibleRoot || fallbackRoot;
}

function isMeaningfulDouyinDetailRoot(node) {
  if (!node || node === document.body || node === document.documentElement) {
    return false;
  }

  if (!(node instanceof Element)) {
    return false;
  }
  
  // 排除掉明确隐藏的滑块（swiper 中的上一个/下一个没有轮到的对象）
  if (node.hasAttribute("aria-hidden") && node.getAttribute("aria-hidden") === "true") {
     return false;
  }
  
  if (node.closest(".swiper-slide") && !node.closest(".swiper-slide-active")) {
     return false;
  }

  return Boolean(
    node.matches?.("[data-e2e-aweme-id]") ||
      node.querySelector?.("[data-e2e-aweme-id]") ||
      node.querySelector?.("[data-e2e=\"video-desc\"]") ||
      node.querySelector?.("[data-e2e=\"feed-video-nickname\"]") ||
      node.querySelector?.("video"),
  );
}

function pickActiveDouyinVideoElement() {
  const videos = collectMediaElements(document);
  if (videos.length === 0) {
    return null;
  }

  const ranked = videos
    .map((video) => ({
      video,
      score: scoreDouyinVideoElement(video),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.video || null;
}

function scoreDouyinVideoElement(video) {
  if (!(video instanceof Element)) {
    return 0;
  }

  const rect = video.getBoundingClientRect();
  const visibleWidth = Math.max(
    0,
    Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
  );
  const visibleHeight = Math.max(
    0,
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
  );
  const visibleArea = visibleWidth * visibleHeight;
  if (visibleArea <= 0) {
    return 0;
  }

  const totalArea = Math.max(rect.width * rect.height, 1);
  const visibleRatio = visibleArea / totalArea;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const viewportCenterX = window.innerWidth / 2;
  const viewportCenterY = window.innerHeight / 2;
  const centerDistance = Math.hypot(centerX - viewportCenterX, centerY - viewportCenterY);

  let score = visibleRatio * 1000;
  score += visibleArea / 1000;
  score -= centerDistance / 10;

  if ("paused" in video && video.paused === false) {
    score += 200;
  }
  if ("currentTime" in video && Number(video.currentTime || 0) > 0) {
    score += 40;
  }
  if ("readyState" in video && Number(video.readyState || 0) >= 2) {
    score += 20;
  }

  return score;
}

function pickClosestContainingRoot(candidates, targetNode) {
  const containingRoots = candidates
    .filter((candidate) => candidate.contains(targetNode))
    .sort((left, right) => {
      const depthDiff = getNodeDepth(right) - getNodeDepth(left);
      if (depthDiff !== 0) return depthDiff;

      return getNodeArea(left) - getNodeArea(right);
    });

  return containingRoots[0] || null;
}

function pickMostVisibleDouyinRoot(candidates) {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      visibleRatio: getElementVisibleRatio(candidate),
      area: getNodeArea(candidate),
      depth: getNodeDepth(candidate),
    }))
    .filter((item) => item.visibleRatio > 0)
    .sort((left, right) => {
      if (right.visibleRatio !== left.visibleRatio) {
        return right.visibleRatio - left.visibleRatio;
      }
      if (left.area !== right.area) {
        return left.area - right.area;
      }
      return right.depth - left.depth;
    });

  return ranked[0]?.candidate || null;
}

function getElementVisibleRatio(element) {
  if (!(element instanceof Element)) {
    return 0;
  }

  const rect = element.getBoundingClientRect();
  const visibleWidth = Math.max(
    0,
    Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
  );
  const visibleHeight = Math.max(
    0,
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
  );
  const visibleArea = visibleWidth * visibleHeight;
  const totalArea = Math.max(rect.width * rect.height, 1);
  return visibleArea / totalArea;
}

function getNodeDepth(node) {
  let depth = 0;
  let current = node;

  while (current?.parentElement) {
    depth += 1;
    current = current.parentElement;
  }

  return depth;
}

function getNodeArea(node) {
  if (!(node instanceof Element)) {
    return Number.POSITIVE_INFINITY;
  }

  const rect = node.getBoundingClientRect();
  return Math.max(rect.width * rect.height, 1);
}

function extractDouyinAuthorInfo(detailRoot) {
  const authorCardScope = findDouyinAuthorCardScope(detailRoot);
  const linkElement =
    findPreferredDouyinAuthorLink(authorCardScope || detailRoot) ||
    findPreferredDouyinAuthorLink(detailRoot) ||
    getFirstMatch(
      DOUYIN_DOM_PROFILE.noteDetail.fields.authorLink,
      authorCardScope || detailRoot,
    ) ||
    null;

  let nameText =
    findPreferredDouyinAuthorName(authorCardScope || detailRoot) ||
    getText(
      DOUYIN_DOM_PROFILE.noteDetail.fields.authorName,
      authorCardScope || detailRoot,
    ) ||
    cleanText(linkElement?.textContent || "");

  const url = normalizeUrl(linkElement?.getAttribute("href") || linkElement?.href || "");
  if (!cleanText(nameText)) {
    nameText = findDouyinAuthorNameByUrl(url, authorCardScope || detailRoot);
  }

  const name = cleanText(nameText).replace(/^@/, "");
  const userId = extractBloggerId(url) || "";

  return {
    name,
    userId,
    url,
  };
}

function findDouyinAuthorCardScope(detailRoot = null) {
  const scopes = [
    detailRoot,
    resolvePotentialDouyinMetricsScope(detailRoot),
    document,
  ].filter((node) => node instanceof Element || node === document);

  const candidates = [];

  scopes.forEach((scope) => {
    try {
      scope.querySelectorAll('a[href*="/user/"]').forEach((link) => {
        if (!(link instanceof Element) || !isElementVisible(link)) return;
        const rect = link.getBoundingClientRect();
        if (rect.left < window.innerWidth * 0.5) return;
        if (rect.top < 0 || rect.top > window.innerHeight * 0.45) return;

        let current = link.parentElement;
        for (let depth = 0; current && depth < 5; depth += 1) {
          const text = cleanText(current.innerText || current.textContent || "");
          const currentRect = current.getBoundingClientRect();
          if (
            text &&
            text.length <= 200 &&
            /粉丝/.test(text) &&
            /获赞/.test(text) &&
            currentRect.width > 120 &&
            currentRect.width < 420 &&
            currentRect.height > 40 &&
            currentRect.height < 220
          ) {
            candidates.push(current);
            break;
          }
          current = current.parentElement;
        }
      });
    } catch {}
  });

  const ranked = Array.from(new Set(candidates))
    .map((node) => ({
      node,
      area: Math.max(node.getBoundingClientRect().width * node.getBoundingClientRect().height, 1),
      top: node.getBoundingClientRect().top,
    }))
    .sort((left, right) => {
      if (left.top !== right.top) {
        return left.top - right.top;
      }
      return left.area - right.area;
    });

  return ranked[0]?.node || null;
}

function findPreferredDouyinAuthorLink(detailRoot) {
  const scope = resolvePotentialDouyinMetricsScope(detailRoot);
  const candidates = [];
  [scope, detailRoot, document].forEach((context) => {
    if (!(context instanceof Element || context === document)) {
      return;
    }
    try {
      context.querySelectorAll('a[href*="/user/"]').forEach((node) => {
        if (!(node instanceof Element) || !isElementVisible(node)) return;
        if (!isLikelyDouyinUserEntry(node)) return;
        const actionable =
          node.closest?.('a[href*="/user/"]') ||
          node.closest?.('[role="button"], button, [tabindex]') ||
          node;
        if (actionable instanceof Element && isElementVisible(actionable)) {
          candidates.push(actionable);
        }
      });
    } catch {}
  });

  const ranked = Array.from(new Set(candidates))
    .map((node) => ({
      node,
      score: scoreDouyinAuthorEntryCandidate(node),
    }))
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.node || null;
}

function findPreferredDouyinAuthorName(detailRoot) {
  const preferredLink = findPreferredDouyinAuthorLink(detailRoot);
  if (!preferredLink) {
    return "";
  }

  const textCandidates = [
    cleanText(preferredLink.textContent || ""),
    cleanText(
      preferredLink.querySelector?.('[data-e2e="feed-video-nickname"]')?.textContent || "",
    ),
  ].filter(Boolean);

  return textCandidates[0] || "";
}

function findDouyinAuthorNameByUrl(authorUrl = "", detailRoot = null) {
  const normalizedUrl = normalizeUrl(authorUrl);
  if (!normalizedUrl) {
    return "";
  }

  const urlCandidates = new Set([normalizedUrl]);
  try {
    const parsed = new URL(normalizedUrl);
    urlCandidates.add(parsed.pathname);
  } catch {}

  const scopes = [detailRoot, document].filter(
    (node) => node instanceof Element || node === document,
  );

  for (const scope of scopes) {
    for (const candidate of urlCandidates) {
      if (!candidate) continue;
      let matchedLinks = [];
      try {
        matchedLinks = Array.from(scope.querySelectorAll('a[href*="/user/"]')).filter(
          (node) => {
            if (!(node instanceof Element) || !isElementVisible(node)) return false;
            const href = normalizeUrl(node.getAttribute("href") || node.href || "");
            return href === normalizedUrl || href.includes(candidate);
          },
        );
      } catch {}

      for (const link of matchedLinks) {
        const directText = cleanText(link.textContent || "").replace(/^@/, "");
        if (directText) {
          return directText;
        }

        let current = link.parentElement;
        for (let depth = 0; current && depth < 4; depth += 1) {
          const textCandidates = Array.from(
            current.querySelectorAll('a[href*="/user/"], span, div, p, h1, h2, h3'),
          )
            .map((node) => cleanText(node.textContent || "").replace(/^@/, ""))
            .filter((text) => {
              if (!text) return false;
              if (text.length > 32) return false;
              if (/(粉丝|获赞|关注|相关推荐|评论|\d{2}:\d{2})/.test(text)) return false;
              return true;
            });

          if (textCandidates[0]) {
            return textCandidates[0];
          }
          current = current.parentElement;
        }
      }
    }
  }

  return "";
}

function resolveDouyinNoteBloggerMetrics({
  detailRoot = null,
  apiDetail = null,
} = {}) {
  const apiMetrics = extractDouyinBloggerMetricsFromApiDetail(apiDetail);
  const domMetrics = extractDouyinInlineBloggerMetrics(detailRoot);

  return {
    followersCount:
      domMetrics.followersCount || apiMetrics.followersCount || 0,
    likedAndCollectedCount:
      domMetrics.likedAndCollectedCount ||
      apiMetrics.likedAndCollectedCount ||
      0,
    accountType: domMetrics.accountType || apiMetrics.accountType || "",
  };
}

function extractDouyinBloggerMetricsFromApiDetail(detail) {
  const safeDetail = detail && typeof detail === "object" ? detail : {};
  const author =
    safeDetail.author && typeof safeDetail.author === "object"
      ? safeDetail.author
      : {};
  const authorUserInfo =
    safeDetail.author_user_info &&
    typeof safeDetail.author_user_info === "object"
      ? safeDetail.author_user_info
      : safeDetail.authorUserInfo && typeof safeDetail.authorUserInfo === "object"
        ? safeDetail.authorUserInfo
        : {};

  const followersCount = normalizeNonNegativeInteger(
    authorUserInfo.follower_count ??
      author.follower_count ??
      author.mplatform_followers_count,
  );
  const likedAndCollectedCount = normalizeNonNegativeInteger(
    author.total_favorited ??
      author.totalFavorited ??
      author.aweme_count_liked,
  );

  return {
    followersCount,
    likedAndCollectedCount,
    accountType: resolveDouyinAccountTypeFromApiAuthor(author),
  };
}

function extractDouyinInlineBloggerMetrics(detailRoot) {
  const directMetrics = extractDouyinInlineBloggerMetricsBySelectors(detailRoot);
  if (directMetrics.followersCount > 0 && directMetrics.likedAndCollectedCount > 0) {
    return directMetrics;
  }

  const candidates = collectDouyinInlineMetricsTexts(detailRoot);
  let best = directMetrics;

  candidates.forEach((text) => {
    const next = {
      followersCount: extractDouyinMetricByLabels(text, ["粉丝"]),
      likedAndCollectedCount: extractDouyinMetricByLabels(text, [
        "获赞与收藏",
        "点赞与收藏",
        "获赞",
      ]),
      accountType: resolveDouyinAccountTypeFromText(text),
    };

    if (
      next.followersCount > best.followersCount ||
      (next.followersCount === best.followersCount &&
        next.likedAndCollectedCount > best.likedAndCollectedCount)
    ) {
      best = next;
    }
  });

  return best;
}

function extractDouyinInlineBloggerMetricsBySelectors(detailRoot) {
  const texts = getAllTexts(
    DOUYIN_INLINE_BLOGGER_METRICS_SELECTORS,
    detailRoot || document,
  );
  const fallbackTexts =
    detailRoot && detailRoot !== document
      ? getAllTexts(DOUYIN_INLINE_BLOGGER_METRICS_SELECTORS, document)
      : [];
  const candidates = Array.from(new Set([...texts, ...fallbackTexts]))
    .map((text) => cleanText(text))
    .filter(Boolean);

  let best = {
    followersCount: 0,
    likedAndCollectedCount: 0,
    accountType: "",
  };

  candidates.forEach((text) => {
    const next = {
      followersCount: extractDouyinMetricByLabels(text, ["粉丝"]),
      likedAndCollectedCount: extractDouyinMetricByLabels(text, [
        "获赞与收藏",
        "点赞与收藏",
        "获赞",
      ]),
      accountType: resolveDouyinAccountTypeFromText(text),
    };

    if (
      next.followersCount > best.followersCount ||
      (next.followersCount === best.followersCount &&
        next.likedAndCollectedCount > best.likedAndCollectedCount)
    ) {
      best = next;
    }
  });

  return best;
}

function collectDouyinInlineMetricsTexts(detailRoot) {
  const scopes = new Set();
  const textSet = new Set();

  const pushScope = (node) => {
    if (!(node instanceof Element) || scopes.has(node)) {
      return;
    }
    scopes.add(node);
    const text = cleanText(node.innerText || node.textContent || "");
    if (!text) return;
    if (text.length > 800) return;
    textSet.add(text);
  };

  const pushText = (text) => {
    const normalized = cleanText(text || "");
    if (!normalized || normalized.length > 800) {
      return;
    }
    textSet.add(normalized);
  };

  if (detailRoot instanceof Element) {
    pushScope(detailRoot);
  }

  const anchorNodes = [
    getFirstMatch(DOUYIN_DOM_PROFILE.noteDetail.fields.authorName, detailRoot || document),
    getFirstMatch(DOUYIN_DOM_PROFILE.noteDetail.fields.authorLink, detailRoot || document),
    getFirstMatch(
      [
        '[data-e2e="video-info"]',
        ".video-info-detail",
        ".OMAnlCHg",
      ],
      detailRoot || document,
    ),
  ].filter(Boolean);

  anchorNodes.forEach((node) => {
    let current = node;
    for (let depth = 0; current && depth < 4; depth += 1) {
      pushScope(current);
      current = current.parentElement;
    }
  });

  const metricScope =
    detailRoot instanceof Element ? detailRoot : resolvePotentialDouyinMetricsScope();
  const metricNodes = Array.from(
    (metricScope || document).querySelectorAll("div, span, p, a"),
  )
    .filter((node) => {
      const text = cleanText(node.textContent || "");
      if (!text || text.length > 200) {
        return false;
      }
      return /粉丝|获赞|获赞与收藏|点赞与收藏/.test(text);
    })
    .slice(0, 160);

  metricNodes.forEach((node) => {
    pushScope(node);
    pushScope(node.parentElement);
    pushScope(node.parentElement?.parentElement || null);
    pushText(
      Array.from(node.parentElement?.children || [])
        .map((child) => cleanText(child.textContent || ""))
        .filter(Boolean)
        .join(" "),
    );
  });

  if (textSet.size === 0) {
    const fallbackText = cleanText(
      (detailRoot instanceof Element ? detailRoot.innerText : document.body?.innerText) ||
        "",
    );
    if (fallbackText) {
      textSet.add(fallbackText);
    }
  }

  return Array.from(textSet);
}

function extractDouyinMetricByLabels(text, labels = []) {
  const normalized = cleanText(text || "");
  if (!normalized) return 0;

  const countPattern = "(\\d+(?:\\.\\d+)?(?:亿|万|[kK])?)";
  for (const label of labels) {
    const after = normalized.match(
      new RegExp(`${label}\\s*[:：]?\\s*${countPattern}`),
    );
    if (after?.[1]) {
      return parseDouyinMetricCount(after[1]);
    }

    const before = normalized.match(
      new RegExp(`(?:^|[\\s|｜])${countPattern}\\s*${label}(?=$|[\\s|｜])`),
    );
    if (before?.[1]) {
      return parseDouyinMetricCount(before[1]);
    }
  }

  return 0;
}

function parseDouyinMetricCount(value) {
  const normalized = String(value || "").replace(/[,，\s]/g, "");
  if (!normalized) return 0;

  const match = normalized.match(/(\d+(?:\.\d+)?)(亿|万|[kK])?/);
  if (!match?.[1]) return 0;

  const num = Number(match[1]);
  if (!Number.isFinite(num)) return 0;

  if (match[2] === "亿") return Math.round(num * 100000000);
  if (match[2] === "万") return Math.round(num * 10000);
  if (/^[kK]$/.test(match[2] || "")) return Math.round(num * 1000);
  return parseInteractionCount(match[1]);
}

function normalizeNonNegativeInteger(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

function resolvePotentialDouyinMetricsScope(detailRoot = null) {
  if (detailRoot instanceof Element) {
    const scoped =
      detailRoot.closest?.(".swiper-slide-active") ||
      detailRoot.closest?.(".swiper-slide") ||
      detailRoot.closest?.('[role="dialog"]') ||
      detailRoot.closest?.('[class*="Modal"]') ||
      detailRoot.closest?.('[class*="modal"]');
    if (scoped instanceof Element) {
      return scoped;
    }
    return detailRoot;
  }

  try {
    return resolveActiveDouyinDetailRoot();
  } catch {
    return document.body;
  }
}

function resolveDouyinAccountTypeFromApiAuthor(author) {
  const safeAuthor = author && typeof author === "object" ? author : {};
  const hintText = cleanText(
    [
      safeAuthor.custom_verify,
      safeAuthor.enterprise_verify_reason,
      safeAuthor.account_cert_info,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return resolveDouyinAccountTypeFromText(hintText);
}

function resolveDouyinAccountTypeFromText(text) {
  const normalized = cleanText(text || "");
  if (/商家|企业|品牌|机构/i.test(normalized)) return "company";
  if (/认证|达人|红v/i.test(normalized)) return "famous";
  return "";
}

async function enrichDouyinPayloadWithBloggerMetrics(
  payload,
  {
    noteId = "",
    apiDetail = null,
    detailRoot = null,
    preferWorksTabForBloggerMetrics = false,
  } = {},
) {
  const resolved = await waitForDouyinBloggerMetrics(
    {
      followersCount: payload?.followersCount ?? payload?.bloggerFollowersCount ?? 0,
      likedAndCollectedCount:
        payload?.likedAndCollectedCount ??
        payload?.bloggerLikedAndCollectedCount ??
        0,
      accountType: payload?.bloggerAccountType || "",
    },
    {
      noteId,
      apiDetail,
      detailRoot,
      preferWorksTabForBloggerMetrics,
    },
  );

  return {
    ...payload,
    followersCount: resolved.followersCount,
    likedAndCollectedCount: resolved.likedAndCollectedCount,
    bloggerFollowersCount: resolved.followersCount,
    bloggerLikedAndCollectedCount: resolved.likedAndCollectedCount,
    bloggerAccountType: resolved.accountType || payload?.bloggerAccountType || "",
  };
}

async function waitForDouyinBloggerMetrics(
  initialMetrics = {},
  {
    noteId = "",
    apiDetail = null,
    detailRoot = null,
    attempts = 10,
    waitMs: retryWaitMs = 320,
    preferWorksTabForBloggerMetrics = false,
  } = {},
) {
  let best = normalizeDouyinBloggerMetrics(initialMetrics);

  if (
    preferWorksTabForBloggerMetrics &&
    isDouyinContentFlowPage(detailRoot) &&
    !(best.followersCount > 0 && best.likedAndCollectedCount > 0)
  ) {
    await ensureDouyinWorksTabActiveForMetrics(detailRoot);
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const next = normalizeDouyinBloggerMetrics(
      resolveDouyinNoteBloggerMetrics({
        detailRoot:
          detailRoot instanceof Element ? detailRoot : resolvePotentialDouyinMetricsScope(),
        apiDetail: apiDetail || (noteId ? readDouyinApiCache(noteId) : null),
      }),
    );
    best = pickBetterDouyinBloggerMetrics(best, next);

    if (best.followersCount > 0 && best.likedAndCollectedCount > 0) {
      break;
    }

    if (attempt < attempts - 1) {
      await wait(retryWaitMs);
    }
  }

  return best;
}

function pickBetterDouyinBloggerMetrics(current, next) {
  const safeCurrent = normalizeDouyinBloggerMetrics(current);
  const safeNext = normalizeDouyinBloggerMetrics(next);

  return {
    followersCount:
      safeNext.followersCount > safeCurrent.followersCount
        ? safeNext.followersCount
        : safeCurrent.followersCount,
    likedAndCollectedCount:
      safeNext.likedAndCollectedCount > safeCurrent.likedAndCollectedCount
        ? safeNext.likedAndCollectedCount
        : safeCurrent.likedAndCollectedCount,
    accountType: safeCurrent.accountType || safeNext.accountType || "",
  };
}

function normalizeDouyinBloggerMetrics(metrics = {}) {
  const safeMetrics = metrics && typeof metrics === "object" ? metrics : {};
  return {
    followersCount: normalizeNonNegativeInteger(safeMetrics.followersCount),
    likedAndCollectedCount: normalizeNonNegativeInteger(
      safeMetrics.likedAndCollectedCount,
    ),
    accountType: String(safeMetrics.accountType || "").trim(),
  };
}

async function ensureDouyinWorksTabActiveForMetrics(detailRoot = null) {
  let scope = resolvePotentialDouyinMetricsScope(detailRoot);
  if (!(scope instanceof Element)) {
    return false;
  }

  if (!isDouyinTabbedContentFlow(scope)) {
    await ensureDouyinAuthorPanelOpenForMetrics(scope);
    scope = resolvePotentialDouyinMetricsScope(detailRoot);
  }

  const worksTab = findDouyinWorksTabTrigger(scope) || findDouyinWorksTabTrigger(document);
  if (!worksTab) {
    return false;
  }

  if (isDouyinTabActive(worksTab) && hasVisibleDouyinMetricsContainer(scope)) {
    return true;
  }

  safeClick(worksTab);

  await waitUntil(
    () => hasVisibleDouyinMetricsContainer(scope) || isDouyinTabActive(worksTab),
    {
      timeout: 4500,
      interval: 120,
    },
  ).catch(() => false);

  return hasVisibleDouyinMetricsContainer(scope);
}

function isDouyinTabbedContentFlow(detailRoot = null) {
  const scope = resolvePotentialDouyinMetricsScope(detailRoot);
  const scopes = [scope, document].filter(
    (node) => node instanceof Element || node === document,
  );

  return scopes.some((node) => {
    const tabTexts = Array.from(
      node.querySelectorAll(DOUYIN_DETAIL_TAB_CANDIDATE_SELECTORS.join(", ")),
    )
      .map((item) => cleanText(item.textContent || ""))
      .filter(Boolean);

    return (
      hasDouyinTabLabel(tabTexts, "TA的作品") &&
      hasDouyinTabLabel(tabTexts, "评论") &&
      !hasDouyinTabLabel(tabTexts, "搜索页")
    );
  });
}

function normalizeDouyinTabText(text) {
  return cleanText(text || "")
    .replace(/[（(][^()（）]*[)）]/g, "")
    .replace(/\s+/g, "");
}

function hasDouyinTabLabel(texts = [], expectedLabel = "") {
  const target = normalizeDouyinTabText(expectedLabel);
  if (!target) return false;
  return texts.some((text) => normalizeDouyinTabText(text) === target);
}

function isDouyinContentFlowPage(detailRoot = null) {
  try {
    const parsed = new URL(window.location.href);
    const pathname = String(parsed.pathname || "").toLowerCase();
    if (parsed.searchParams.get("modal_id")) {
      return true;
    }
    if (
      pathname.startsWith("/search/") ||
      pathname.startsWith("/jingxuan/search")
    ) {
      return true;
    }
  } catch {}

  return false;
}

async function ensureDouyinAuthorPanelOpenForMetrics(detailRoot = null) {
  if (isDouyinTabbedContentFlow(detailRoot)) {
    return true;
  }

  const strictMode = isDouyinContentFlowPage(detailRoot);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const scope = resolvePotentialDouyinMetricsScope(detailRoot);
    const clickable = strictMode
      ? findStrictDouyinAvatarTrigger(scope) ||
        findStrictDouyinAvatarTrigger(document) ||
        findDouyinAuthorEntryTrigger(scope) ||
        findDouyinAuthorEntryTrigger(document)
      : findDouyinAuthorEntryTrigger(scope) || findDouyinAuthorEntryTrigger(document);
    if (!clickable) {
      await wait(140);
      continue;
    }

    safeClick(clickable);
    await wait(220 + attempt * 120);

    const opened = await waitUntil(
      () =>
        isDouyinTabbedContentFlow(detailRoot) ||
        isDouyinTabbedContentFlow(scope) ||
        hasVisibleDouyinMetricsContainer(scope),
      {
        timeout: 1800 + attempt * 1100,
        interval: 120,
      },
    ).catch(() => false);

    if (opened || isDouyinTabbedContentFlow(detailRoot)) {
      return true;
    }
  }

  return isDouyinTabbedContentFlow(detailRoot);
}

function findDouyinAuthorEntryTrigger(scope = null) {
  const strict = findStrictDouyinAvatarTrigger(scope);
  if (strict) {
    return strict;
  }

  const contexts = [scope, document].filter(
    (node) => node instanceof Element || node === document,
  );
  const candidates = [];

  contexts.forEach((context) => {
    DOUYIN_AUTHOR_ENTRY_SELECTORS.forEach((selector) => {
      try {
        context.querySelectorAll(selector).forEach((node) => {
          if (!(node instanceof Element) || !isElementVisible(node)) return;
          const actionable =
            node.closest?.('a[href*="/user/"]') ||
            node.closest?.('[data-click-from="click_icon"]') ||
            node.closest?.('[role="button"], button, [tabindex]') ||
            node;
          if (
            actionable instanceof Element &&
            isElementVisible(actionable) &&
            isLikelyDouyinUserEntry(actionable, node) &&
            isLikelyRightRailTarget(actionable)
          ) {
            candidates.push(actionable);
          }
        });
      } catch {}
    });
  });

  const deduped = Array.from(new Set(candidates));
  const ranked = deduped
    .map((node) => ({
      node,
      score: scoreDouyinAuthorEntryCandidate(node),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.node || null;
}

function findStrictDouyinAvatarTrigger(scope = null) {
  const contexts = [scope, document].filter(
    (node) => node instanceof Element || node === document,
  );

  for (const context of contexts) {
    const strictCandidates = [];

    STRICT_DOUYIN_AVATAR_SELECTORS.forEach((selector) => {
      try {
        context.querySelectorAll(selector).forEach((node) => {
          if (!(node instanceof Element) || !isElementVisible(node)) return;
          const clickable =
            node.closest?.('[data-e2e="live-avatar"], [data-e2e="video-avatar"], [data-e2e="feed-avatar"], [data-e2e="user-avatar"]') ||
            node.closest?.('[data-click-from="click_icon"]') ||
            node.closest?.('[role="button"], button, [tabindex], a[href*="/user/"], a') ||
            node;

          if (
            clickable instanceof Element &&
            isElementVisible(clickable) &&
            isLikelyRightRailTarget(clickable)
          ) {
            strictCandidates.push(clickable);
          }
        });
      } catch {}
    });

    const strictRanked = Array.from(new Set(strictCandidates))
      .map((node) => ({
        node,
        score: scoreStrictDouyinAvatarCandidate(node) + 80,
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);

    if (strictRanked[0]?.node) {
      return strictRanked[0].node;
    }

    const avatarSelectors = [
      'img.fiWP27dC',
      '[data-click-from="click_icon"] img[src*="aweme-avatar"]',
      '[data-e2e="video-avatar"] img',
      '[data-e2e="video-avatar"]',
      '[data-e2e="feed-avatar"]',
      '[data-e2e="live-avatar"]',
      'a[href*="/user/"] img',
    ];
    const clickableCandidates = [];

    avatarSelectors.forEach((selector) => {
      try {
        context.querySelectorAll(selector).forEach((node) => {
          if (!(node instanceof Element) || !isElementVisible(node)) return;
          const clickable =
            node.closest?.('[data-click-from="click_icon"]') ||
            node.closest?.('[role="button"], button, [tabindex], a[href*="/user/"], a') ||
            node;

          if (
            clickable instanceof Element &&
            isElementVisible(clickable) &&
            isLikelyRightRailTarget(clickable)
          ) {
            clickableCandidates.push(clickable);
          }
        });
      } catch {}
    });

    const ranked = Array.from(new Set(clickableCandidates))
      .map((node) => ({
        node,
        score: scoreStrictDouyinAvatarCandidate(node),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);

    if (ranked[0]?.node) {
      return ranked[0].node;
    }
  }

  return null;
}

function scoreDouyinAuthorEntryCandidate(node) {
  if (!(node instanceof Element)) return 0;
  const rect = node.getBoundingClientRect();
  const text = cleanText(node.textContent || "");
  const attrText = [
    node.getAttribute("data-click-from") || "",
    node.getAttribute("data-e2e") || "",
    node.getAttribute("href") || "",
    typeof node.className === "string" ? node.className : "",
  ].join(" ");

  let score = 1;
  if (node.matches?.('[data-click-from="click_icon"]')) score += 45;
  if (/video-avatar|live-avatar/i.test(attrText)) score += 30;
  if (/feed-avatar/i.test(attrText)) score += 18;
  if (/click_icon/i.test(attrText)) score += 12;
  if (/\/user\//i.test(attrText)) score += 38;
  if (/feed-video-nickname/i.test(attrText)) score += 32;
  if (/nickname|account-name|user-name/i.test(attrText)) score += 18;
  if (/^@/.test(text)) score += 14;
  if (/评论|点赞|收藏|转发|分享/.test(text)) score -= 36;
  if (/comment|digg|like|collect|share/i.test(attrText)) score -= 42;
  if (rect.left >= window.innerWidth * 0.62) score += 18;
  if (rect.left <= window.innerWidth * 0.5) score -= 18;
  if (rect.top > window.innerHeight * 0.18 && rect.top <= window.innerHeight * 0.95) score += 6;
  if (rect.top <= window.innerHeight * 0.12) score -= 24;
  if (rect.width >= 20 && rect.height >= 20 && rect.width <= 140) score += 2;
  if (rect.width > 180 || rect.height > 180) score -= 20;

  return score;
}

function isLikelyDouyinUserEntry(actionable, sourceNode = null) {
  const nodes = [actionable, sourceNode].filter((node) => node instanceof Element);
  if (nodes.length === 0) return false;

  return nodes.some((node) => {
    const text = cleanText(node.textContent || "");
    const attrText = [
      node.getAttribute("data-e2e") || "",
      node.getAttribute("data-click-from") || "",
      node.getAttribute("href") || "",
      typeof node.className === "string" ? node.className : "",
    ].join(" ");

    return (
      /\/user\//i.test(attrText) ||
      /feed-video-nickname|video-avatar|feed-avatar|live-avatar|user-avatar/i.test(attrText) ||
      /nickname|account-name|user-name/i.test(attrText) ||
      /^@/.test(text)
    );
  });
}

function isLikelyRightRailTarget(node) {
  if (!(node instanceof Element)) return false;
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.width > 220 || rect.height > 220) return false;
  // 侧边栏打开后内容区会左移，右侧操作列不再总是位于 55% 之后。
  if (rect.left < window.innerWidth * 0.32) return false;
  if (rect.top < 0 || rect.top > window.innerHeight * 0.98) return false;
  return true;
}

function scoreStrictDouyinAvatarCandidate(node) {
  if (!(node instanceof Element)) return 0;
  const rect = node.getBoundingClientRect();
  const attrText = [
    node.getAttribute("data-e2e") || "",
    node.getAttribute("data-click-from") || "",
    node.getAttribute("href") || "",
    typeof node.className === "string" ? node.className : "",
  ].join(" ");

  let score = 1;
  if (/video-avatar|feed-avatar|live-avatar|user-avatar/i.test(attrText)) score += 42;
  if (/\/user\//i.test(attrText)) score += 26;
  if (/click_icon/i.test(attrText)) score += 18;
  if (rect.left >= window.innerWidth * 0.74) score += 28;
  else if (rect.left >= window.innerWidth * 0.62) score += 18;
  if (rect.width >= 28 && rect.height >= 28 && rect.width <= 96 && rect.height <= 96) score += 16;
  if (rect.width > 120 || rect.height > 120) score -= 24;
  if (rect.top > window.innerHeight * 0.2 && rect.top < window.innerHeight * 0.7) score += 10;
  return score;
}

function findDouyinWorksTabTrigger(scope) {
  const candidates = Array.from(
    (scope || document).querySelectorAll(
      DOUYIN_DETAIL_TAB_CANDIDATE_SELECTORS.join(", "),
    ),
  )
    .filter(isElementVisible)
    .filter((node) => cleanText(node.textContent || "") === "TA的作品");

  const actionable = Array.from(
    new Set(candidates.map((node) => node.closest?.('[role="tab"], [role="button"], button, a') || node)),
  ).filter(isElementVisible);

  const ranked = actionable
    .map((node) => ({
      node,
      score: scoreDouyinWorksTabCandidate(node),
    }))
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.node || null;
}

function scoreDouyinWorksTabCandidate(node) {
  if (!(node instanceof Element)) {
    return 0;
  }

  const rect = node.getBoundingClientRect();
  let score = 1;
  const attrText = [
    node.getAttribute("role") || "",
    node.getAttribute("aria-selected") || "",
    node.getAttribute("aria-current") || "",
    typeof node.className === "string" ? node.className : "",
  ].join(" ");

  if (node.getAttribute("role") === "tab") score += 10;
  if (node.closest('[role="tablist"]')) score += 10;
  if (/tab|active|current|selected/i.test(attrText)) score += 6;
  if (rect.top >= 0 && rect.top <= window.innerHeight * 0.35) score += 4;
  if (rect.width >= 30 && rect.width <= 180) score += 2;
  return score;
}

function isDouyinTabActive(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  const attrText = [
    node.getAttribute("aria-selected") || "",
    node.getAttribute("aria-current") || "",
    typeof node.className === "string" ? node.className : "",
  ].join(" ");

  if (
    node.getAttribute("aria-selected") === "true" ||
    node.getAttribute("aria-current") === "page"
  ) {
    return true;
  }

  return /active|current|selected/i.test(attrText);
}

function hasVisibleDouyinMetricsContainer(scope) {
  const contexts = [scope, document].filter(Boolean);
  for (const context of contexts) {
    const nodes = Array.from(
      context.querySelectorAll(DOUYIN_INLINE_BLOGGER_METRICS_SELECTORS.join(", ")),
    ).filter(isElementVisible);
    if (nodes.length > 0) {
      return true;
    }
  }
  return false;
}

function isElementVisible(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const style = window.getComputedStyle(node);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0"
  );
}

function safeClick(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  try {
    node.click();
    return true;
  } catch {}

  try {
    node.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    return true;
  } catch {}

  return false;
}

function extractDouyinTitle(detailRoot) {
  const title = cleanText(getText(DOUYIN_DOM_PROFILE.noteDetail.fields.title, detailRoot));
  if (title) return title;

  return cleanText(document.title.replace(/\s*-\s*抖音.*$/i, ""));
}

function extractDouyinTags(detailRoot, title = "") {
  const tags = getAllTexts(DOUYIN_DOM_PROFILE.noteDetail.fields.tags, detailRoot)
    .map((text) => cleanText(text))
    .filter((text) => text.startsWith("#") && text.length > 1);

  if (tags.length === 0 && title) {
    const matches = title.match(/#[^#\s]+/g) || [];
    matches.forEach((item) => {
      const text = cleanText(item);
      if (text.length > 1) {
        tags.push(text);
      }
    });
  }

  return Array.from(new Set(tags));
}

function extractDouyinInteractions(detailRoot) {
  const likes = extractCountFromNode(
    getFirstMatch(DOUYIN_DOM_PROFILE.noteDetail.fields.interactions.likes, detailRoot),
  );
  const comments = extractCountFromNode(
    getFirstMatch(DOUYIN_DOM_PROFILE.noteDetail.fields.interactions.comments, detailRoot),
  );
  const collects = extractCountFromNode(
    getFirstMatch(DOUYIN_DOM_PROFILE.noteDetail.fields.interactions.collects, detailRoot),
  );
  const shares = extractCountFromNode(
    getFirstMatch(DOUYIN_DOM_PROFILE.noteDetail.fields.interactions.shares, detailRoot),
  );

  if (likes || comments || collects || shares) {
    return { likes, comments, collects, shares };
  }

  const fromBar = extractInteractionsFromHorizontalBar(detailRoot);
  if (fromBar.likes || fromBar.comments || fromBar.collects || fromBar.shares) {
    return fromBar;
  }

  // Fallback: interaction buttons are often outside detailRoot on feed/profile pages
  // 但不能是整个 document，否则有可能会取到背景里搜索列表的第一个结果
  const docScope = detailRoot?.closest?.('.swiper-slide') 
                || detailRoot?.closest?.('[role="dialog"]') 
                || detailRoot?.closest?.('[class*="Modal"]') 
                || detailRoot?.closest?.('[class*="modal"]') 
                || detailRoot || document;
                
  const docLikes = extractCountFromNode(
    getFirstMatch(DOUYIN_DOM_PROFILE.noteDetail.fields.interactions.likes, docScope),
  );
  const docComments = extractCountFromNode(
    getFirstMatch(DOUYIN_DOM_PROFILE.noteDetail.fields.interactions.comments, docScope),
  );
  const docCollects = extractCountFromNode(
    getFirstMatch(DOUYIN_DOM_PROFILE.noteDetail.fields.interactions.collects, docScope),
  );
  const docShares = extractCountFromNode(
    getFirstMatch(DOUYIN_DOM_PROFILE.noteDetail.fields.interactions.shares, docScope),
  );
  return { likes: docLikes, comments: docComments, collects: docCollects, shares: docShares };
}

function extractInteractionsFromHorizontalBar(detailRoot) {
  const items = Array.from(
    (detailRoot || document).querySelectorAll(".fN2jqmuV .fcEX2ARL"),
  );
  if (items.length < 3) {
    return { likes: 0, comments: 0, collects: 0, shares: 0 };
  }

  const counts = items.map((item) => extractCountFromNode(item));
  return {
    likes: counts[0] || 0,
    comments: counts[1] || 0,
    collects: counts[2] || 0,
    shares: counts[3] || 0,
  };
}

function extractCountFromNode(node) {
  if (!node) return 0;

  const valueNodes = node.querySelectorAll("span, p, div");
  for (const candidate of valueNodes) {
    const text = cleanText(candidate.textContent || "");
    if (!text) continue;
    if (!/[0-9]/.test(text)) continue;
    const parsed = parseDouyinCount(text);
    if (parsed > 0) {
      return parsed;
    }
  }

  return parseDouyinCount(cleanText(node.textContent || ""));
}

function parseDouyinCount(text) {
  const normalized = String(text || "").replace(/[,，\s]/g, "");
  if (!normalized) return 0;

  const hit = normalized.match(/(\d+(?:\.\d+)?)(亿|万|[kK])?/);
  if (!hit) return 0;

  const value = Number(hit[1]);
  if (!Number.isFinite(value)) return 0;

  const unit = hit[2] || "";
  if (unit === "亿") return Math.round(value * 100000000);
  if (unit === "万") return Math.round(value * 10000);
  if (/^[kK]$/.test(unit)) return Math.round(value * 1000);

  return parseInteractionCount(hit[1]);
}

function extractDouyinPublishText(detailRoot) {
  const direct = cleanText(getText(DOUYIN_DOM_PROFILE.noteDetail.fields.publishTime, detailRoot));
  if (direct) return direct;
  // 兜底(本 fork 自加;MediaClaw 合并上游时保留):抖音常改混淆类名 / 换 data-e2e,
  // 这里按文本正则在详情根(退而 document)里找"发布时间:YYYY-MM-DD ...",不依赖易变的选择器。
  const re = /发布时间[:：]\s*(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}[日]?(?:\s*\d{1,2}[:：]\d{2}(?::\d{2})?)?)/;
  for (const scope of [detailRoot, document]) {
    if (!scope) continue;
    const txt = String(scope.innerText || scope.textContent || "");
    const m = txt.match(re);
    if (m && m[1]) return cleanText(m[1]);
  }
  return "";
}

function normalizeDouyinPublishDate(text) {
  const normalized = cleanText(text)
    .replace(/^发布时间[:：]?/i, "")
    .replace(/^发布于[:：]?/i, "")
    .replace(/^·\s*/, "")
    .trim();

  if (!normalized) {
    return normalizeDate("");
  }

  const fullDate = normalized.match(/(\d{4}-\d{1,2}-\d{1,2})/);
  if (fullDate?.[1]) {
    return normalizeDate(fullDate[1]);
  }

  const mdMatch = normalized.match(/(\d{1,2})月(\d{1,2})日/);
  if (mdMatch?.[1] && mdMatch?.[2]) {
    const now = new Date();
    const month = String(mdMatch[1]).padStart(2, "0");
    const day = String(mdMatch[2]).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  }

  return normalizeDate(normalized);
}

function extractDouyinMedia(detailRoot, noteId = "", options = {}) {
  const { silent = false, apiDetail = null } = options || {};
  const videoElements = collectMediaElements(detailRoot);
  const hasVideo =
    videoElements.length > 0 ||
    Boolean(apiDetail?.video?.duration) ||
    Number(apiDetail?.aweme_type || 0) === 4 ||
    Number(apiDetail?.aweme_type || 0) === 68;

  const imageScope = resolveDouyinImageScope(detailRoot);
  const contentImages = getAllMatches(DOUYIN_DOM_PROFILE.noteDetail.fields.images, imageScope)
    .filter((img) => isLikelyContentImage(img))
    .filter((img) => isOwnedDouyinContentImage(img, detailRoot, imageScope))
    .map((img) => normalizeUrl(img.getAttribute("src") || img.src || ""))
    .filter(Boolean);

  const apiImages = extractDouyinImageUrlsFromApiDetail(apiDetail);
  const images = uniqueDouyinImageUrls(
    apiImages.length > 0 ? apiImages : contentImages,
  );
  const coverCandidates = collectDouyinCoverCandidates(
    detailRoot,
    videoElements,
    images,
    noteId,
    apiDetail,
  );
  const coverImage = pickPreferredCoverUrl(coverCandidates);
  const duration = extractDouyinVideoDuration(videoElements);
  const mediaUrlCollection = collectMediaUrls(
    detailRoot,
    videoElements,
    noteId,
    apiDetail,
  );
  const videoSelectionContext = buildVideoSelectionContext({
    noteId,
    detailRoot,
    mediaUrlCollection,
    apiDetail,
  });
  const videoUrls = uniqueNormalized(
    (mediaUrlCollection.allUrls || []).filter((url) => isLikelyDouyinVideoUrl(url)),
  );
  const audioUrls = uniqueNormalized(
    (mediaUrlCollection.allUrls || []).filter((url) => isLikelyDownloadableDouyinAudioUrl(url)),
  );
  const selectedVideoUrl = pickPreferredVideoUrl(videoUrls, videoSelectionContext);
  const selectedAudioUrl = pickPreferredAudioUrl(audioUrls);
  const diagnostics = buildDouyinMediaDiagnostics({
    noteId,
    detailRoot,
    videoElements,
    mediaUrlCollection,
    videoUrls,
    audioUrls,
    coverCandidates,
    videoSelectionContext,
    selectedVideoUrl,
    selectedAudioUrl,
    selectedCoverImageUrl: coverImage,
  });

  if (!silent) {
    printDouyinMediaDiagnostics(diagnostics);
  }

  return {
    hasVideo,
    videoUrl: selectedVideoUrl,
    videoUrls,
    audioUrl: selectedAudioUrl,
    audioUrls,
    images: hasVideo ? images.filter((url) => url !== coverImage) : images,
    coverImage,
    videoDuration: duration,
    diagnostics,
  };
}

function resolveDouyinImageScope(detailRoot = null) {
  if (!(detailRoot instanceof Element)) {
    return document;
  }

  const carouselScope =
    findDouyinImageCarouselScope(detailRoot) ||
    detailRoot.querySelector?.(".swiper-slide-active")?.closest?.('[class*="swiper"]') ||
    detailRoot.closest?.(".focusPanel");
  if (carouselScope instanceof Element) {
    return carouselScope;
  }

  const dialogScope =
    detailRoot.closest?.('[role="dialog"]') ||
    detailRoot.closest?.('[class*="Modal"]') ||
    detailRoot.closest?.('[class*="modal"]');
  if (dialogScope instanceof Element) {
    return dialogScope;
  }

  return detailRoot;
}

function findDouyinImageCarouselScope(detailRoot) {
  if (!(detailRoot instanceof Element)) {
    return null;
  }

  const slideSelectors = [".dySwiperSlide", '[class*="SwiperSlide"]', ".swiper-slide"];
  let current = detailRoot;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const slideCount = slideSelectors.reduce((count, selector) => {
      try {
        return Math.max(count, current.querySelectorAll(selector).length);
      } catch {
        return count;
      }
    }, 0);
    if (slideCount >= 2) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function extractDouyinImageUrlsFromApiDetail(detail) {
  if (!detail || typeof detail !== "object") {
    return [];
  }

  const imageNodes = [
    safeGet(detail, "images"),
    safeGet(detail, "image_infos"),
    safeGet(detail, "imageInfos"),
    safeGet(detail, "photo_infos"),
    safeGet(detail, "photoInfos"),
    safeGet(detail, "images_info"),
    safeGet(detail, "imagesInfo"),
    safeGet(detail, "image_post_info"),
    safeGet(detail, "imagePostInfo"),
    safeGet(detail, "album_info"),
    safeGet(detail, "albumInfo"),
  ];

  const matches = [];
  imageNodes.forEach((node) => {
    extractDouyinImageUrlsFromStateNode(node).forEach((url) => matches.push(url));
  });

  return uniqueDouyinImageUrls(matches).filter((url) => isPossibleDouyinImageUrl(url));
}

function supplementDouyinImageNotePayload(payload, noteId = "", apiDetail = null) {
  const normalizedPayload =
    payload && typeof payload === "object" ? {...payload} : {};
  const noteType = resolveDouyinContextualNoteType({
    payload: normalizedPayload,
    noteId,
    apiDetail,
  });
  if (noteType !== "image") {
    return normalizedPayload;
  }

  let detailRoot = null;
  try {
    detailRoot = resolveActiveDouyinDetailRoot();
  } catch {}

  const authorInfo = detailRoot ? extractDouyinAuthorInfo(detailRoot) : {name: "", userId: "", url: ""};

  const domImages = detailRoot
    ? extractDouyinImageUrlsFromDomScope(detailRoot)
    : [];
  const apiImages = extractDouyinImageUrlsFromApiDetail(apiDetail);
  const mergedImages = uniqueDouyinImageUrls([
    ...(Array.isArray(normalizedPayload.imageUrls) ? normalizedPayload.imageUrls : []),
    ...(apiImages.length > 0 ? apiImages : domImages),
  ])
    .filter((url) => isPossibleDouyinImageUrl(url))
    .slice(0, apiImages.length > 0 ? Math.max(apiImages.length, 20) : 20);

  const mergedCover = pickPreferredCoverUrl([
    normalizedPayload.coverImageUrl,
    ...mergedImages,
  ]);

  return {
    ...normalizedPayload,
    noteType: "image",
    type: "image",
    url: buildDouyinCanonicalNoteUrl(noteId, "image", apiDetail),
    author: normalizedPayload.author || authorInfo.name || "",
    authorId: normalizedPayload.authorId || authorInfo.userId || "",
    authorUsername: normalizedPayload.authorUsername || "",
    authorUrl: normalizedPayload.authorUrl || authorInfo.url || "",
    bloggerProfileUrl:
      normalizedPayload.bloggerProfileUrl || authorInfo.url || "",
    imageUrls: mergedImages,
    coverImageUrl: mergedCover || normalizedPayload.coverImageUrl || "",
    videoUrl: "",
    videoUrls: [],
    audioUrl: "",
    audioUrls: [],
    audioAvailability: "not_collected",
  };
}

function extractDouyinImageUrlsFromDomScope(detailRoot = null) {
  const imageScope = resolveDouyinImageScope(detailRoot);
  const strictSelectors = [
    ".swiper-slide-active img[src*='douyinpic.com']",
    ".swiper-slide-active img[src*='byteimg.com']",
    "[class*='SwiperSlide'][class*='active'] img[src*='douyinpic.com']",
    "[class*='SwiperSlide'][class*='active'] img[src*='byteimg.com']",
    ".dySwiperSlide img[src*='douyinpic.com']",
    ".dySwiperSlide img[src*='byteimg.com']",
  ];
  const selectorPool = hasStrictScopedImageCandidates(imageScope, strictSelectors)
    ? strictSelectors
    : DOUYIN_DOM_PROFILE.noteDetail.fields.images;
  const candidates = getAllMatches(selectorPool, imageScope)
    .filter((img) => isLikelyContentImage(img))
    .filter((img) => isOwnedDouyinContentImage(img, detailRoot, imageScope))
    .map((img) => normalizeUrl(img.getAttribute("src") || img.src || ""))
    .filter(Boolean);

  return uniqueDouyinImageUrls(candidates)
    .filter((url) => isPossibleDouyinImageUrl(url))
    .slice(0, 20);
}

function hasStrictScopedImageCandidates(scope, selectors = []) {
  if (!(scope instanceof Element) || !Array.isArray(selectors) || selectors.length === 0) {
    return false;
  }

  return selectors.some((selector) => {
    try {
      return scope.querySelectorAll(selector).length > 0;
    } catch {
      return false;
    }
  });
}

function resolveDouyinContextualNoteType({
  payload = null,
  noteId = "",
  apiDetail = null,
  noteUrl = "",
  media = null,
} = {}) {
  const normalizedPayload =
    payload && typeof payload === "object" ? payload : {};
  const normalizedUrl = String(
    noteUrl ||
      normalizedPayload.url ||
      normalizedPayload.noteUrl ||
      window.location.href ||
      "",
  ).trim();
  const currentPath = inferDouyinNotePath(noteId, apiDetail);
  const images = uniqueNormalized([
    ...(Array.isArray(normalizedPayload.imageUrls) ? normalizedPayload.imageUrls : []),
    ...extractDouyinImageUrlsFromApiDetail(apiDetail),
    ...(Array.isArray(media?.images) ? media.images : []),
  ]).filter((url) => isPossibleDouyinImageUrl(url));
  const hasImageCounter = hasDouyinImagePager();

  if (
    /\/note\//i.test(normalizedUrl) ||
    currentPath === "note" ||
    images.length >= 2 ||
    hasImageCounter
  ) {
    return "image";
  }

  const explicitType = String(
    normalizedPayload.noteType || normalizedPayload.type || "",
  )
    .trim()
    .toLowerCase();
  if (explicitType === "image" || explicitType === "img" || explicitType === "图文") {
    return "image";
  }

  return "video";
}

function hasDouyinImagePager() {
  const texts = Array.from(document.querySelectorAll("div, span, p"))
    .filter((node) => isElementVisible(node))
    .map((node) => cleanText(node.textContent || ""))
    .filter(Boolean);
  return texts.some((text) => /^\d+\s*\/\s*\d+$/.test(text));
}

function hasStrongVideoIdentityMatch(media) {
  const reasons = Array.isArray(media?.diagnostics?.selected?.videoReasons)
    ? media.diagnostics.selected.videoReasons
    : [];
  return reasons.some((reason) => String(reason).startsWith("identity:"));
}

function getSelectedVideoScore(media) {
  const ranked = Array.isArray(media?.diagnostics?.ranked?.video)
    ? media.diagnostics.ranked.video
    : [];
  const selected = ranked.find((item) => item?.selected);
  return Number(selected?.score || 0);
}

async function observeStableDouyinMedia(noteId = "", noteUrl = "") {
  const timeoutMs = isLikelyVideoContext(noteUrl) ? 1600 : 900;
  const intervalMs = 250;
  const startedAt = Date.now();
  let bestSnapshot = null;
  let previousStableKey = "";
  let stableHits = 0;
  const apiDetail = noteId ? readDouyinApiCache(noteId) : null;

  while (Date.now() - startedAt <= timeoutMs) {
    const refreshedRoot = resolveActiveDouyinDetailRoot();
    const snapshot = extractDouyinMedia(refreshedRoot, noteId, {
      silent: true,
      apiDetail,
    });
    const currentStableKey = normalizeUrl(snapshot?.coverImage || "") || (snapshot?.hasVideo ? "__video__" : "__image__");
    const currentScore = getSelectedVideoScore(snapshot);
    const bestScore = getSelectedVideoScore(bestSnapshot);
    const currentHasIdentity = hasStrongVideoIdentityMatch(snapshot);
    const bestHasIdentity = hasStrongVideoIdentityMatch(bestSnapshot);

    if (
      !bestSnapshot ||
      currentHasIdentity && !bestHasIdentity ||
      currentHasIdentity === bestHasIdentity && currentScore > bestScore
    ) {
      bestSnapshot = snapshot;
    }

    if (currentStableKey && currentStableKey === previousStableKey) {
      stableHits += 1;
    } else {
      stableHits = currentStableKey ? 1 : 0;
      previousStableKey = currentStableKey;
    }

    if (
      currentStableKey &&
      stableHits >= 2 &&
      (snapshot?.coverImage || currentHasIdentity || currentScore >= 260)
    ) {
      bestSnapshot = snapshot;
      break;
    }

    await wait(intervalMs);
  }

  if (!bestSnapshot) {
    const fallbackRoot = resolveActiveDouyinDetailRoot();
    return extractDouyinMedia(fallbackRoot, noteId, {
      silent: true,
      apiDetail,
    });
  }

  return bestSnapshot;
}

function validateDouyinMediaPayload(payload, media) {
  if (!media?.hasVideo) {
    return;
  }

  const missing = [];
  if (!payload.coverImageUrl) missing.push("封面");

  if (missing.length > 0) {
    console.warn(`[Douyin][SingleNote] 媒体信息不完整，缺少 ${missing.join("、")}，已忽略继续采集`);
  }
}

function collectMediaElements(detailRoot) {
  let videos = getAllMatches(DOUYIN_DOM_PROFILE.noteDetail.fields.video, detailRoot);

  if (videos.length === 0) {
    const activeScope = detailRoot?.closest?.('.swiper-slide') 
                     || detailRoot?.closest?.('[role="dialog"]') 
                     || detailRoot?.closest?.('[class*="Modal"]') 
                     || detailRoot?.closest?.('[class*="modal"]') 
                     || detailRoot || document;
                     
    videos = getAllMatches(DOUYIN_DOM_PROFILE.noteDetail.fields.video, activeScope);
  }

  if (videos.length > 1) {
    const ranked = videos
      .map((video) => ({
        video,
        score: scoreDouyinVideoElement(video),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);

    if (ranked.length > 0) {
      return [ranked[0].video];
    }
  }
  
  if (videos.length === 0) {
    const fallback = pickActiveDouyinVideoElement();
    if (fallback) return [fallback];
  }

  return videos;
}

function collectMediaUrls(detailRoot, videoElements = [], noteId = "", apiDetail = null) {
  const bySource = {
    apiDetail: [],
    videoElement: [],
    inline: [],
    state: [],
    react: [],
    playerRuntime: [],
    documentVideo: [],
    performance: [],
    mediaRequests: [],
  };

  videoElements.forEach((video) => {
    bySource.videoElement.push(
      video?.currentSrc,
      video?.src,
      video?.getAttribute?.("src"),
      video?.getAttribute?.("data-src"),
      video?.getAttribute?.("data-url"),
    );

    getAllMatches(DOUYIN_DOM_PROFILE.noteDetail.fields.videoSources, video).forEach((source) => {
      bySource.videoElement.push(
        source?.currentSrc,
        source?.src,
        source?.getAttribute?.("src"),
        source?.getAttribute?.("data-src"),
      );
    });
  });

  if (apiDetail && typeof apiDetail === "object") {
    extractMediaUrlsFromStateNode(apiDetail).forEach((url) => bySource.apiDetail.push(url));
  }

  const scopedInlineUrls = collectInlineMediaUrls(detailRoot);
  scopedInlineUrls.forEach((url) => bySource.inline.push(url));

  const scopedStateUrls = collectStateMediaUrls(noteId);
  scopedStateUrls.forEach((url) => bySource.state.push(url));

  const scopedReactUrls = collectReactMediaUrls(noteId);
  scopedReactUrls.forEach((url) => bySource.react.push(url));

  const playerRuntimeUrls = collectPlayerRuntimeMediaUrls(detailRoot, videoElements, noteId);
  playerRuntimeUrls.forEach((url) => bySource.playerRuntime.push(url));

  collectDocumentVideoUrls(detailRoot, noteId).forEach((url) => bySource.documentVideo.push(url));

  const nonPerformanceCandidates = Object.values(bySource)
    .flat()
    .some(
    (c) => c && isLikelyDouyinVideoUrl(String(c)),
  );
  if (!nonPerformanceCandidates) {
    collectPerformanceMediaUrls(detailRoot, noteId).forEach((url) => bySource.performance.push(url));
  }

  collectInterceptedMediaUrls(noteId).forEach((url) => bySource.mediaRequests.push(url));

  const normalizedBySource = Object.fromEntries(
    Object.entries(bySource).map(([key, values]) => [key, uniqueNormalized(values)]),
  );

  return {
    ...normalizedBySource,
    allUrls: uniqueNormalized(Object.values(normalizedBySource).flat()),
  };
}

function collectInterceptedMediaUrls(noteId = "") {
  const requests = readInterceptedMediaRequests();
  if (requests.length === 0) {
    return [];
  }

  const normalizedNoteId = String(noteId || "").trim();
  const now = Date.now();
  const inWindow = requests.filter((item) => now - Number(item?.ts || 0) <= DOUYIN_MEDIA_REQUEST_WINDOW_MS);
  const candidateRequests = inWindow.length > 0 ? inWindow : requests;
  const recent = candidateRequests
    .sort((left, right) => right.ts - left.ts)
    .slice(0, 24);
  const scoped = normalizedNoteId
    ? recent.filter((item) => item.url.includes(normalizedNoteId))
    : [];
  const selected = scoped.length > 0 ? scoped : recent;
  return uniqueNormalized(selected.map((item) => item.url));
}

function collectDocumentVideoUrls(detailRoot, noteId = "") {
  const scopedRoot = resolveMediaScopeRoot(detailRoot, noteId);
  const scopedVideos = Array.from(scopedRoot.querySelectorAll?.("video") || []);
  const fallbackVideos = scopedRoot === document
    ? []
    : Array.from(document.querySelectorAll("video"));
  const videos = scopedVideos.length > 0 ? scopedVideos : fallbackVideos;
  if (videos.length === 0) {
    return [];
  }

  const ranked = videos
    .map((video) => ({
      video,
      score: scoreDouyinVideoElement(video),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return Number(right.video?.currentTime || 0) - Number(left.video?.currentTime || 0);
    });

  const prioritized = [];
  const fallback = [];

  ranked.forEach(({ video }) => {
    const urls = extractUrlsFromVideoElement(video);
    if (urls.length === 0) {
      return;
    }

    const matchedNoteUrls =
      noteId
        ? urls.filter((url) => String(url).includes(String(noteId)))
        : [];

    if (matchedNoteUrls.length > 0) {
      prioritized.push(...matchedNoteUrls);
      return;
    }

    const belongsToCurrentScope = scopedRoot.contains(video);
    if (!noteId && (Number(video?.currentTime || 0) > 0 || video?.paused === false)) {
      prioritized.push(...urls);
      return;
    }

    if (belongsToCurrentScope && !noteId) {
      fallback.push(...urls);
    }
  });

  return uniqueNormalized([...prioritized, ...fallback]);
}

function extractUrlsFromVideoElement(video) {
  if (!(video instanceof Element)) {
    return [];
  }

  const candidates = [
    video.currentSrc,
    video.src,
    video.getAttribute("src"),
    video.getAttribute("data-src"),
    video.getAttribute("data-url"),
    video.getAttribute("data-play-url"),
  ];

  getAllMatches(DOUYIN_DOM_PROFILE.noteDetail.fields.videoSources, video).forEach((source) => {
    candidates.push(
      source?.currentSrc,
      source?.src,
      source?.getAttribute?.("src"),
      source?.getAttribute?.("data-src"),
      source?.getAttribute?.("data-url"),
    );
  });

  return uniqueNormalized(
    candidates.filter((url) => isLikelyDouyinVideoUrl(String(url || ""))),
  );
}

function collectPerformanceMediaUrls(detailRoot, noteId = "") {
  try {
    const entries = performance.getEntriesByType("resource") || [];
    const now = Number(performance.now() || 0);
    const recentEntries = entries.filter((entry) => {
      const startTime = Number(entry?.startTime || 0);
      return now - startTime <= DOUYIN_PERFORMANCE_WINDOW_MS;
    });
    const candidateEntries = recentEntries.length > 0 ? recentEntries : entries;
    const sorted = candidateEntries
      .sort((left, right) => Number(right?.startTime || 0) - Number(left?.startTime || 0))
      .slice(0, 100)
      .map((entry) => normalizeUrl(entry?.name || ""))
      .filter((url) => isLikelyDouyinVideoUrl(url) || isLikelyDouyinAudioUrl(url));

    if (noteId) {
      // 抖音的部分视频链接可能会以别的标识位包含id，如果缓存中真的有我们需要的资源
      const scoped = sorted.filter((url) => url.includes(String(noteId)));
      if (scoped.length > 0) return scoped;

      // blob 播放模式下，真实媒体请求常常不带 noteId。
      // 这时如果当前页面已经有激活的视频元素，就允许退回最近的强特征媒体请求。
      const activeBlobVideo = Array.from(document.querySelectorAll("video")).some((video) => {
        const current = String(video?.currentSrc || video?.src || "").trim().toLowerCase();
        return current.startsWith("blob:");
      });
      if (activeBlobVideo && hasReadyVideoElement(noteId)) {
        return sorted.slice(0, 12);
      }

      // noteId 已知但资源列表里没有可归属当前作品的 URL 时，默认不回退到全局强特征候选。
      // 否则很容易复用前一条或其他滑块的视频链接。
      return [];
    }

    const scopedRoot = resolveMediaScopeRoot(detailRoot, noteId);
    const scopedHtml = String(scopedRoot?.outerHTML || "");
    const scopedCandidates = sorted.filter((url) => {
      const basename = String(url || "").split("?")[0].split("/").pop();
      return basename && scopedHtml.includes(basename);
    });

    return (scopedCandidates.length > 0 ? scopedCandidates : sorted).slice(0, 30);
  } catch {
    return [];
  }
}

function resolveMediaScopeRoot(detailRoot, noteId = "") {
  const normalizedNoteId = String(noteId || "").trim();
  if (normalizedNoteId) {
    const directScope =
      detailRoot?.closest?.(`[data-e2e-aweme-id="${normalizedNoteId}"]`) ||
      document.querySelector?.(`[data-e2e-aweme-id="${normalizedNoteId}"]`);
    if (directScope) {
      return directScope;
    }
  }

  return (
    detailRoot?.closest?.(".swiper-slide-active") ||
    detailRoot?.closest?.(".swiper-slide") ||
    detailRoot?.closest?.('[role="dialog"]') ||
    detailRoot ||
    document
  );
}

function collectInlineMediaUrls(detailRoot) {
  const buckets = [detailRoot?.outerHTML || ""];
  const matches = [];

  buckets.forEach((html) => {
    if (!html || html.length < 50) return;
    const hitList = html.match(/https?:[^"'\\s>]+/gi) || [];
    hitList.forEach((item) => matches.push(item));
  });

  return matches;
}

function collectStateMediaUrls(noteId = "") {
  const candidates = [];

  const stateCandidates = [
    safeReadGlobal("__INITIAL_STATE__"),
    safeReadGlobal("__INIT_STATE__"),
    safeReadGlobal("__REDUX_STATE__"),
    safeReadGlobal("__NEXT_DATA__"),
    safeReadGlobal("SIGI_STATE"),
    safeReadGlobal("_ROUTER_DATA"),
    safeReadGlobal("SSR_DATA"),
  ];

  try {
    const scripts = Array.from(document.querySelectorAll('script[type="application/json"], script[id*="INIT"], script[id*="STATE"], script[id*="DATA"]'));
    scripts.forEach(script => {
      const text = script.textContent || "";
      if (text.includes(String(noteId))) {
        try {
          let jsonText = text.trim();
          if (jsonText.startsWith('%7B')) jsonText = decodeURIComponent(jsonText);
          const parsed = JSON.parse(jsonText);
          if (parsed && typeof parsed === 'object') {
            stateCandidates.push(parsed);
          }
        } catch (e) {}
      }
    });
  } catch (e) {}

  stateCandidates.forEach((state) => {
    extractMediaUrlsFromStateTree(state, noteId).forEach((url) => candidates.push(url));
  });

  return uniqueNormalized(candidates);
}

function extractMediaUrlsFromStateTree(rootState, noteId = "") {
  if (!rootState || typeof rootState !== "object") {
    return [];
  }

  const scopedRoots = findNoteScopedStateRoots(rootState, noteId);
  const queue = scopedRoots.length > 0 ? [...scopedRoots] : [];
  const seen = new Set();
  const matches = [];
  let scanned = 0;

  if (queue.length === 0) {
    return [];
  }

  while (queue.length > 0 && scanned < 30000) {
    scanned += 1;
    const current = queue.shift();
    if (!current) continue;
    if (isUnsafeStateObject(current)) continue;

    if (typeof current === "object") {
      if (seen.has(current)) continue;
      seen.add(current);
    }

    extractMediaUrlsFromStateNode(current).forEach((url) => matches.push(url));

    if (Array.isArray(current)) {
      current.forEach((item) => queue.push(item));
      continue;
    }

    if (typeof current === "object") {
      safeObjectValues(current).forEach((value) => queue.push(value));
    }
  }

  return uniqueNormalized(matches);
}

function extractMediaUrlsFromStateNode(node) {
  if (!node || typeof node !== "object") {
    return [];
  }
  if (isUnsafeStateObject(node)) {
    return [];
  }

  const matches = [];
  const videoNode = safeGet(node, "video");
  const videoInfoNode = safeGet(node, "video_info");
  const videoInfoCamelNode = safeGet(node, "videoInfo");
  const addressCandidates = [
    node,
    videoNode,
    videoInfoNode,
    videoInfoCamelNode,
    safeGet(node, "play_addr"),
    safeGet(node, "playAddr"),
    safeGet(node, "play_url"),
    safeGet(node, "playUrl"),
    safeGet(node, "download_addr"),
    safeGet(node, "downloadAddr"),
    safeGet(node, "play_api"),
    safeGet(node, "playApi"),
    safeGet(node, "play_addr_h264"),
    safeGet(node, "playAddrH264"),
    safeGet(node, "play_info"),
    safeGet(node, "playInfo"),
    safeGet(videoNode, "play_addr"),
    safeGet(videoNode, "playAddr"),
    safeGet(videoNode, "play_url"),
    safeGet(videoNode, "playUrl"),
    safeGet(videoNode, "download_addr"),
    safeGet(videoNode, "downloadAddr"),
    safeGet(videoNode, "play_api"),
    safeGet(videoNode, "playApi"),
    safeGet(videoNode, "play_addr_h264"),
    safeGet(videoNode, "playAddrH264"),
    safeGet(videoNode, "play_info"),
    safeGet(videoNode, "playInfo"),
    safeGet(videoInfoNode, "play_addr"),
    safeGet(videoInfoNode, "playAddr"),
    safeGet(videoInfoNode, "download_addr"),
    safeGet(videoInfoNode, "downloadAddr"),
    safeGet(videoInfoNode, "play_api"),
    safeGet(videoInfoNode, "playApi"),
    safeGet(videoInfoCamelNode, "play_addr"),
    safeGet(videoInfoCamelNode, "playAddr"),
    safeGet(videoInfoCamelNode, "download_addr"),
    safeGet(videoInfoCamelNode, "downloadAddr"),
    safeGet(videoInfoCamelNode, "play_api"),
    safeGet(videoInfoCamelNode, "playApi"),
  ];

  const musicNode = safeGet(node, "music");
  const musicInfoNode = safeGet(node, "music_info");
  const musicInfoCamelNode = safeGet(node, "musicInfo");
  const audioCandidates = [
    safeGet(node, "audio_url"),
    safeGet(node, "audioUrl"),
    safeGet(node, "audio_play_url"),
    safeGet(node, "audioPlayUrl"),
    safeGet(musicNode, "play_url"),
    safeGet(musicNode, "playUrl"),
    safeGet(musicNode, "audition_url"),
    safeGet(musicNode, "auditionUrl"),
    safeGet(musicInfoNode, "play_url"),
    safeGet(musicInfoNode, "playUrl"),
    safeGet(musicInfoCamelNode, "play_url"),
    safeGet(musicInfoCamelNode, "playUrl"),
  ];

  addressCandidates.forEach((address) => {
    extractUrlsFromPlayAddress(address).forEach((url) => matches.push(url));
  });

  audioCandidates.forEach((address) => {
    extractUrlsFromPlayAddress(address).forEach((url) => {
      matches.push(url.includes('?') ? url + '&xtag=audio' : url + '?xtag=audio');
    });
  });

  const nodeBitRate = safeGet(node, "bit_rate");
  const nodeBitRateCamel = safeGet(node, "bitRate");
  const videoBitRate = safeGet(videoNode, "bit_rate");
  const videoBitRateCamel = safeGet(videoNode, "bitRate");
  const bitRates = Array.isArray(nodeBitRate)
    ? nodeBitRate
    : Array.isArray(nodeBitRateCamel)
      ? nodeBitRateCamel
      : Array.isArray(videoBitRate)
        ? videoBitRate
        : Array.isArray(videoBitRateCamel)
          ? videoBitRateCamel
      : [];
  bitRates.forEach((item) => {
    extractUrlsFromPlayAddress(safeGet(item, "play_addr") || safeGet(item, "playAddr")).forEach((url) =>
      matches.push(url),
    );
  });

  const musicNodes = [
    musicNode,
    musicInfoNode,
    musicInfoCamelNode,
    safeGet(node, "matched_song"),
    safeGet(node, "matchedSong"),
  ];
  musicNodes.forEach((musicNode) => {
    extractUrlsFromMusicNode(musicNode).forEach((url) => {
      matches.push(url.includes('?') ? url + '&xtag=audio' : url + '?xtag=audio');
    });
  });

  return matches;
}

function extractUrlsFromPlayAddress(address) {
  if (!address) {
    return [];
  }

  if (typeof address === "string" && address.trim()) {
    return [address];
  }

  const matches = [];

  if (Array.isArray(address)) {
    address.forEach((item) => {
      if (typeof item === "string" && item.trim()) {
        matches.push(item);
      } else if (item && typeof item === "object") {
        const itemSrc = safeGet(item, "src");
        const itemUrl = safeGet(item, "url");
        if (typeof itemSrc === "string" && itemSrc.trim()) matches.push(itemSrc);
        if (typeof itemUrl === "string" && itemUrl.trim()) matches.push(itemUrl);
      }
    });
  }

  if (typeof address !== "object" || Array.isArray(address)) {
    return matches;
  }
  if (isUnsafeStateObject(address)) {
    return matches;
  }

  const rawUrlList = safeGet(address, "url_list");
  const rawUrlListCamel = safeGet(address, "urlList");
  const urlList = Array.isArray(rawUrlList)
    ? rawUrlList
    : Array.isArray(rawUrlListCamel)
      ? rawUrlListCamel
      : [];

  urlList.forEach((url) => {
    if (typeof url === "string" && url.trim()) {
      matches.push(url);
    } else if (url && typeof url === "object") {
      const urlSrc = safeGet(url, "src");
      const urlValue = safeGet(url, "url");
      if (typeof urlSrc === "string" && urlSrc.trim()) matches.push(urlSrc);
      if (typeof urlValue === "string" && urlValue.trim()) matches.push(urlValue);
    }
  });

  const addressUrl = safeGet(address, "url");
  const addressSrc = safeGet(address, "src");
  if (typeof addressUrl === "string" && addressUrl.trim()) {
    matches.push(addressUrl);
  } else if (typeof addressSrc === "string" && addressSrc.trim()) {
    matches.push(addressSrc);
  }

  const uri = safeGet(address, "uri");
  if (typeof uri === "string" && uri.trim()) {
    matches.push(buildDouyinPlayUrlFromUri(uri));
  }

  const playApi = safeGet(address, "playApi");
  if (typeof playApi === "string" && playApi.trim()) {
    matches.push(playApi);
  }
  
  const playApiSnake = safeGet(address, "play_api");
  if (typeof playApiSnake === "string" && playApiSnake.trim()) {
    matches.push(playApiSnake);
  }

  return matches;
}

function extractUrlsFromMusicNode(musicNode) {
  if (!musicNode || typeof musicNode !== "object") {
    return [];
  }
  if (isUnsafeStateObject(musicNode)) {
    return [];
  }

  const matches = [];
  const candidates = [
    safeGet(musicNode, "play_url"),
    safeGet(musicNode, "playUrl"),
    safeGet(musicNode, "audition_url"),
    safeGet(musicNode, "auditionUrl"),
    safeGet(musicNode, "url"),
    safeGet(musicNode, "url_list"),
    safeGet(musicNode, "urlList"),
  ];

  candidates.forEach((candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach((url) => {
        if (typeof url === "string" && url.trim()) {
          matches.push(url);
        }
      });
      return;
    }

    extractUrlsFromPlayAddress(candidate).forEach((url) => matches.push(url));
    if (typeof candidate === "string" && candidate.trim()) {
      matches.push(candidate);
    }
  });

  return matches;
}

function collectReactMediaUrls(noteId = "") {
  const matches = [];
  getNoteScopedReactNodes(noteId).forEach(node => {
     extractMediaUrlsFromStateNode(node).forEach(url => matches.push(url));
  });
  return uniqueNormalized(matches);
}

function collectReactCoverUrls(noteId = "") {
  const matches = [];
  getNoteScopedReactNodes(noteId).forEach(node => {
     extractCoverUrlsFromStateNode(node).forEach(url => matches.push(url));
  });
  return uniqueNormalized(matches).filter(url => isPossibleDouyinImageUrl(url));
}

function collectPlayerRuntimeMediaUrls(detailRoot, videoElements = [], noteId = "") {
  const scopeRoot = resolveMediaScopeRoot(detailRoot, noteId);
  const seedNodes = [
    detailRoot,
    scopeRoot,
    ...videoElements,
    ...videoElements.map((video) => video?.parentElement),
    ...videoElements.map((video) => video?.closest?.(".xgplayer")),
    ...videoElements.map((video) => video?.closest?.("[class*='player']")),
    ...videoElements.map((video) => video?.closest?.("[class*='Player']")),
  ].filter(Boolean);

  const matches = [];
  const seenObjects = new Set();

  seedNodes.forEach((node) => {
    collectRuntimeObjectsFromElement(node).forEach((runtimeObject) => {
      extractMediaUrlsFromRuntimeTree(runtimeObject, noteId, seenObjects).forEach((url) => matches.push(url));
    });
  });

  collectGlobalRuntimeObjects(scopeRoot, noteId).forEach((runtimeObject) => {
    extractMediaUrlsFromRuntimeTree(runtimeObject, noteId, seenObjects).forEach((url) => matches.push(url));
  });

  return uniqueNormalized(matches);
}

function collectRuntimeObjectsFromElement(element) {
  if (!(element instanceof Element)) {
    return [];
  }

  const results = [];
  const candidateElements = [
    element,
    element.parentElement,
    element.closest?.(".xgplayer"),
    ...Array.from(element.querySelectorAll?.("[class*='player'], [class*='Player'], video, xg-video-container, xgplayer") || []).slice(0, 20),
  ].filter(Boolean);

  candidateElements.forEach((candidateElement) => {
    const keys = safeOwnPropertyNames(candidateElement);
    keys.forEach((key) => {
      if (!key) return;
      if (
        key.startsWith("__reactFiber$") ||
        key.startsWith("__reactProps$") ||
        key.startsWith("__reactEventHandlers$")
      ) {
        const value = safeGet(candidateElement, key);
        if (value && typeof value === "object") {
          results.push(value);
        }
        return;
      }

      if (
        /^_?xg/i.test(key) ||
        /player/i.test(key) ||
        /media/i.test(key) ||
        /source/i.test(key) ||
        /dash/i.test(key) ||
        /hls/i.test(key)
      ) {
        const value = safeGet(candidateElement, key);
        if (value && (typeof value === "object" || typeof value === "function")) {
          results.push(value);
        }
      }
    });

    const prototype = Object.getPrototypeOf(candidateElement);
    safeOwnPropertyNames(prototype).forEach((key) => {
      if (!key || key === "constructor") return;
      if (!/player|media|source|dash|hls|config|plugin|core/i.test(key)) return;
      const value = safeGet(candidateElement, key);
      if (value && (typeof value === "object" || typeof value === "function")) {
        results.push(value);
      }
    });
  });

  return results;
}

function collectGlobalRuntimeObjects(scopeRoot, noteId = "") {
  const results = [];
  const globalCandidates = [
    globalThis,
    safeReadGlobal("__PLAYER__"),
    safeReadGlobal("__PLAYERS__"),
    safeReadGlobal("__xgplayer__"),
    safeReadGlobal("xgplayer"),
    safeReadGlobal("XGPlayer"),
    safeReadGlobal("player"),
    safeReadGlobal("players"),
  ].filter(Boolean);

  globalCandidates.forEach((candidate) => {
    if (candidate && (typeof candidate === "object" || typeof candidate === "function")) {
      results.push(candidate);
    }
  });

  try {
    Object.getOwnPropertyNames(globalThis).forEach((key) => {
      if (!key) return;
      if (
        /^_?xg/i.test(key) ||
        /player/i.test(key) ||
        /media/i.test(key) ||
        /source/i.test(key) ||
        /dash/i.test(key) ||
        /hls/i.test(key)
      ) {
        const value = safeReadGlobal(key);
        if (value && (typeof value === "object" || typeof value === "function")) {
          results.push(value);
        }
      }
    });
  } catch {}

  if (scopeRoot instanceof Element) {
    const textSnippet = cleanText(scopeRoot.textContent || "").slice(0, 80);
    if (textSnippet) {
      try {
        Object.getOwnPropertyNames(globalThis).forEach((key) => {
          if (!key) return;
          if (!/store|state|manager|context|runtime|container/i.test(key)) return;
          const value = safeReadGlobal(key);
          if (!value || typeof value !== "object") return;
          const serialized = safePreviewObject(value);
          if (serialized.includes(String(noteId)) || serialized.includes(textSnippet)) {
            results.push(value);
          }
        });
      } catch {}
    }
  }

  return results;
}

function safePreviewObject(value) {
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
}

function extractMediaUrlsFromRuntimeTree(root, noteId = "", seenObjects = new Set()) {
  if (!root || (typeof root !== "object" && typeof root !== "function")) {
    return [];
  }

  const queue = [root];
  const matches = [];
  let scanned = 0;

  while (queue.length > 0 && scanned < 20000) {
    scanned += 1;
    const current = queue.shift();
    if (!current || (typeof current !== "object" && typeof current !== "function")) continue;
    if (isUnsafeStateObject(current)) continue;
    if (seenObjects.has(current)) continue;
    seenObjects.add(current);

    extractMediaUrlsFromStateNode(current).forEach((url) => matches.push(url));

    const textCandidates = [
      safeGet(current, "src"),
      safeGet(current, "url"),
      safeGet(current, "playUrl"),
      safeGet(current, "play_url"),
      safeGet(current, "currentSrc"),
      safeGet(current, "poster"),
      safeGet(current, "manifestUrl"),
      safeGet(current, "manifest_url"),
      safeGet(current, "mediaUrl"),
      safeGet(current, "media_url"),
      safeGet(current, "file"),
      safeGet(current, "fileUrl"),
      safeGet(current, "file_url"),
      safeGet(current, "main_url"),
      safeGet(current, "mainUrl"),
      safeGet(current, "backup_url"),
      safeGet(current, "backupUrl"),
      safeGet(current, "manifest"),
      safeGet(current, "manifestUrl"),
      safeGet(current, "manifest_url"),
      safeGet(current, "playlist"),
      safeGet(current, "playList"),
      safeGet(current, "definition"),
      safeGet(current, "definitions"),
      safeGet(current, "stream"),
      safeGet(current, "streams"),
      safeGet(current, "resource"),
      safeGet(current, "resources"),
      safeGet(current, "qualityList"),
      safeGet(current, "urlMap"),
      safeGet(current, "videoModel"),
      safeGet(current, "_videoModel"),
      safeGet(current, "mediaInfo"),
      safeGet(current, "dash"),
      safeGet(current, "hls"),
    ];
    textCandidates.forEach((value) => {
      if (typeof value === "string" && value.trim()) matches.push(value);
      else if (value && typeof value === "object") {
        extractUrlsFromPlayAddress(value).forEach((url) => matches.push(url));
      } else if (Array.isArray(value)) {
        value.forEach((item) => {
          extractUrlsFromPlayAddress(item).forEach((url) => matches.push(url));
          if (typeof item === "string" && item.trim()) matches.push(item);
        });
      }
    });

    if (Array.isArray(current)) {
      current.forEach((item) => queue.push(item));
      continue;
    }

    const nextValues = [];
    try {
      safeOwnPropertyNames(current).forEach((key) => {
        if (!key) return;
        if (/^(children|parent|return|sibling|ownerDocument|documentElement|window)$/i.test(key)) return;
        const value = safeGet(current, key);
        if (value && (typeof value === "object" || typeof value === "function")) {
          nextValues.push(value);
        }
      });

      const prototype = Object.getPrototypeOf(current);
      safeOwnPropertyNames(prototype).forEach((key) => {
        if (!key || key === "constructor") return;
        if (!/config|plugin|player|media|source|stream|resource|quality|definition|manifest|playlist|dash|hls/i.test(key)) {
          return;
        }
        const value = safeGet(current, key);
        if (value && (typeof value === "object" || typeof value === "function")) {
          nextValues.push(value);
        }
      });
    } catch {}

    nextValues.forEach((value) => queue.push(value));
  }

  const normalized = uniqueNormalized(matches);
  if (!noteId) {
    return normalized;
  }

  const scoped = normalized.filter((url) => String(url).includes(String(noteId)));
  return scoped.length > 0 ? scoped : normalized;
}

function getNoteScopedReactNodes(noteId = "") {
  if (!noteId) return [];
  const targetId = String(noteId).trim();
  const roots = Array.from(document.querySelectorAll(`[data-e2e-aweme-id="${targetId}"]`));
  const activeVideo = document.querySelector('.swiper-slide-active');
  if (activeVideo && !roots.includes(activeVideo)) roots.push(activeVideo);

  const modalRoot = document.querySelector('[role="dialog"]') || document.querySelector('[class*="Modal"]') || document.querySelector('[class*="modal"]');
  if (modalRoot && !roots.includes(modalRoot)) roots.push(modalRoot);
  
  const playingVideo = document.querySelector('video:not([paused])') || document.querySelector('video');
  if (playingVideo && playingVideo.parentElement && !roots.includes(playingVideo.parentElement)) {
      roots.push(playingVideo.parentElement);
  }

  const matchedNodes = [];
  const seenNodes = new Set();

  for (const root of roots) {
      if (!root) continue;
      const fiberKey = Object.keys(root).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
      if (!fiberKey) continue;
      const fiber = root[fiberKey];
      if (!fiber) continue;

      const queue = [fiber];
      const seen = new Set();
      let steps = 0;

      while(queue.length > 0 && steps < 20000) {
          steps++;
          const current = queue.shift();
          if (!current || typeof current !== 'object') continue;
          if (seen.has(current)) continue;
          seen.add(current);

          const currentId = resolveStateNodeNoteId(current);
          if (currentId && String(currentId) === targetId) {
              if (!seenNodes.has(current)) {
                  seenNodes.add(current);
                  matchedNodes.push(current);
              }
              continue;
          }

          const memoizedProps = safeGet(current, "memoizedProps");
          const pendingProps = safeGet(current, "pendingProps");
          const memoizedState = safeGet(current, "memoizedState");
          const returnNode = safeGet(current, "return");
          const childNode = safeGet(current, "child");
          const siblingNode = safeGet(current, "sibling");

          if (memoizedProps) queue.push(memoizedProps);
          if (pendingProps) queue.push(pendingProps);
          if (memoizedState) queue.push(memoizedState);
          if (returnNode) queue.push(returnNode);
          if (childNode) queue.push(childNode);
          if (siblingNode) queue.push(siblingNode);

          if (!returnNode && !childNode) {
              if (Array.isArray(current)) {
                  current.forEach(i => queue.push(i));
              } else {
                  safeObjectValues(current).forEach(v => queue.push(v));
              }
          }
      }
  }
  return matchedNodes;
}

function buildDouyinPlayUrlFromUri(uri) {
  const normalized = String(uri || "").trim();
  if (!normalized) return "";

  return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(
    normalized,
  )}&ratio=1080p&line=0`;
}

function collectDouyinCoverCandidates(
  detailRoot,
  videoElements = [],
  imageUrls = [],
  noteId = "",
  apiDetail = null,
) {
  const statePreferredCandidates = [];
  const apiPreferredCandidates = [];
  if (apiDetail && typeof apiDetail === "object") {
    apiPreferredCandidates.push(
      ...extractCoverUrlsFromStateNode(apiDetail),
      ...extractCoverUrlsFromStateNode(safeGet(apiDetail, "video")),
    );
  }
  if (noteId) {
    const stateCovers = collectStateCoverUrls(noteId);
    const reactCovers = collectReactCoverUrls(noteId);

    statePreferredCandidates.push(...stateCovers, ...reactCovers);
  }

  const scopedCandidates = [];

  videoElements.forEach((video) => {
    scopedCandidates.push(video?.poster, video?.getAttribute?.("poster"));
  });

  const scopedPosterElements = getAllMatches(
    ["xg-poster", ".xgplayer-poster", ".slider-video-poster", '[data-e2e="feed-active-video"] img', '[style*="background-image"]'],
    detailRoot,
  );
  scopedPosterElements.forEach((element) => {
    scopedCandidates.push(extractBackgroundImageUrl(element));
    const posterImg = element.querySelector?.("img[src]");
    if (posterImg) {
      scopedCandidates.push(posterImg.getAttribute("src") || posterImg.src || "");
    }
  });

  const xgPlayerImgs = getAllMatches(
    ["xg-poster img", ".xgplayer-poster img", ".xg-poster img"],
    detailRoot,
  );
  xgPlayerImgs.forEach((img) => {
    scopedCandidates.push(img.getAttribute?.("src") || img.src || "");
  });

  scopedCandidates.push(
    getAttribute(["video[poster]"], "poster", detailRoot),
  );

  imageUrls.forEach((url) => scopedCandidates.push(url));
  apiPreferredCandidates.forEach((url) => scopedCandidates.push(url));

  if (!noteId) {
    collectDocumentPosterUrls(noteId).forEach((url) => scopedCandidates.push(url));
    collectInlineCoverUrls(detailRoot).forEach((url) => scopedCandidates.push(url));
  }

  const normalizedScoped = uniqueNormalized(scopedCandidates);
  const preferredScoped = normalizedScoped.filter((url) => isLikelyDouyinCoverUrl(url));
  if (preferredScoped.length > 0) {
    return preferredScoped;
  }
  if (normalizedScoped.length > 0) {
    const normalizedState = uniqueNormalized([
      ...apiPreferredCandidates,
      ...statePreferredCandidates,
    ]);
    return uniqueNormalized([
      ...normalizedScoped.filter((url) => isPossibleDouyinImageUrl(url)),
      ...normalizedState.filter((url) => isPossibleDouyinImageUrl(url)),
    ]);
  }

  const fallbackCandidates = [
    getAttribute(['meta[property="og:image"]'], "content", document),
    getAttribute(['meta[name="og:image"]'], "content", document),
  ];
  apiPreferredCandidates.forEach((url) => fallbackCandidates.push(url));
  statePreferredCandidates.forEach((url) => fallbackCandidates.push(url));
  if (!noteId) {
    collectPerformanceCoverUrls(noteId).forEach((url) => fallbackCandidates.push(url));
  }

  const normalizedFallback = uniqueNormalized(fallbackCandidates);
  const preferredFallback = normalizedFallback.filter((url) => isLikelyDouyinCoverUrl(url));
  return preferredFallback.length > 0
    ? preferredFallback
    : normalizedFallback.filter((url) => isPossibleDouyinImageUrl(url));
}

function collectDocumentPosterUrls(noteId = "") {
  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) {
    return [];
  }

  const ranked = videos
    .map((video) => ({
      video,
      score: scoreDouyinVideoElement(video),
    }))
    .sort((left, right) => right.score - left.score);

  const prioritized = [];
  const fallback = [];

  ranked.forEach(({ video }) => {
    const poster = normalizeUrl(video?.poster || video?.getAttribute?.("poster") || "");
    if (!poster || !isPossibleDouyinImageUrl(poster)) {
      return;
    }

    const scopedRoot =
      video.closest?.("[data-e2e-aweme-id]") ||
      video.closest?.(".swiper-slide") ||
      video.closest?.('[role="dialog"]');
    const scopedId = String(scopedRoot?.getAttribute?.("data-e2e-aweme-id") || "").trim();

    if (noteId && scopedId && scopedId === String(noteId)) {
      prioritized.push(poster);
      return;
    }

    if (!noteId && scoreDouyinVideoElement(video) > 0) {
      prioritized.push(poster);
      return;
    }

    fallback.push(poster);
  });

  return uniqueNormalized([...prioritized, ...fallback]);
}

function collectPerformanceCoverUrls(noteId = "") {
  try {
    const entries = performance.getEntriesByType("resource") || [];
    const sorted = entries
      .sort((left, right) => Number(right?.startTime || 0) - Number(left?.startTime || 0))
      .slice(0, 100)
      .map((entry) => normalizeUrl(entry?.name || ""))
      .filter((url) => isLikelyDouyinCoverUrl(url));

    if (noteId) {
      const scoped = sorted.filter((url) => url.includes(String(noteId)));
      if (scoped.length > 0) return scoped;
    }

    return sorted.slice(0, 30);
  } catch {
    return [];
  }
}

function collectInlineCoverUrls(detailRoot) {
  const buckets = [detailRoot?.outerHTML || ""];
  const matches = [];

  buckets.forEach((html) => {
    if (!html || html.length < 50) return;
    const hitList =
      html.match(/https?:[^"'\\s>]+(?:douyinpic|byteimg)[^"'\\s>]*/gi) || [];
    hitList.forEach((item) => matches.push(item));
  });

  return matches;
}

function collectStateCoverUrls(noteId = "") {
  const candidates = [];
  const stateCandidates = [
    safeReadGlobal("__INITIAL_STATE__"),
    safeReadGlobal("__INIT_STATE__"),
    safeReadGlobal("__REDUX_STATE__"),
    safeReadGlobal("__NEXT_DATA__"),
    safeReadGlobal("SIGI_STATE"),
  ];

  stateCandidates.forEach((state) => {
    extractCoverUrlsFromStateTree(state, noteId).forEach((url) => candidates.push(url));
  });

  return uniqueNormalized(candidates).filter((url) => isPossibleDouyinImageUrl(url));
}

function extractCoverUrlsFromStateTree(rootState, noteId = "") {
  if (!rootState || typeof rootState !== "object") {
    return [];
  }

  const scopedRoots = findNoteScopedStateRoots(rootState, noteId);
  const queue = scopedRoots.length > 0 ? [...scopedRoots] : [];
  const seen = new Set();
  const matches = [];
  let scanned = 0;

  if (queue.length === 0) {
    return [];
  }

  while (queue.length > 0 && scanned < 30000) {
    scanned += 1;
    const current = queue.shift();
    if (!current) continue;
    if (isUnsafeStateObject(current)) continue;

    if (typeof current === "object") {
      if (seen.has(current)) continue;
      seen.add(current);
    }

    extractCoverUrlsFromStateNode(current).forEach((url) => matches.push(url));

    if (Array.isArray(current)) {
      current.forEach((item) => queue.push(item));
      continue;
    }

    if (typeof current === "object") {
      safeObjectValues(current).forEach((value) => queue.push(value));
    }
  }

  return uniqueNormalized(matches);
}

function extractCoverUrlsFromStateNode(node) {
  if (!node || typeof node !== "object") {
    return [];
  }
  if (isUnsafeStateObject(node)) {
    return [];
  }

  const matches = [];
  const coverCandidates = [
    safeGet(node, "cover"),
    safeGet(node, "origin_cover"),
    safeGet(node, "originCover"),
    safeGet(node, "raw_cover"),
    safeGet(node, "rawCover"),
    safeGet(node, "dynamic_cover"),
    safeGet(node, "dynamicCover"),
    safeGet(node, "cover_original_scale"),
    safeGet(node, "coverOriginalScale"),
    safeGet(node, "poster"),
    safeGet(node, "poster_url"),
    safeGet(node, "posterUrl"),
  ];

  coverCandidates.forEach((cover) => {
    extractUrlsFromCoverAddress(cover).forEach((url) => matches.push(url));
  });

  return matches;
}

function extractDouyinImageUrlsFromStateNode(node) {
  if (!node) {
    return [];
  }

  if (typeof node === "string") {
    return isPossibleDouyinImageUrl(node) ? [node] : [];
  }

  if (typeof node !== "object" || isUnsafeStateObject(node)) {
    return [];
  }

  const matches = [];

  const directCandidates = [
    node,
    safeGet(node, "image"),
    safeGet(node, "image_info"),
    safeGet(node, "imageInfo"),
    safeGet(node, "display_image"),
    safeGet(node, "displayImage"),
    safeGet(node, "origin_image"),
    safeGet(node, "originImage"),
    safeGet(node, "large_image"),
    safeGet(node, "largeImage"),
    safeGet(node, "thumbnail"),
  ];

  if (Array.isArray(node)) {
    node.forEach((item) => {
      extractDouyinImageUrlsFromStateNode(item).forEach((url) => matches.push(url));
    });
    return uniqueDouyinImageUrls(matches).filter((url) => isPossibleDouyinImageUrl(url));
  }

  const preferredUrl = pickPreferredImageUrl([
    ...directCandidates.flatMap((candidate) => extractUrlsFromCoverAddress(candidate)),
    ...collectPreferredUrlsFromStateNodeKeys(node, [
      "download_url_list",
      "downloadUrlList",
      "origin_url_list",
      "originUrlList",
      "url_list",
      "urlList",
    ]),
  ]);
  if (preferredUrl) {
    matches.push(preferredUrl);
  }

  const nestedKeys = [
    "images",
    "image_infos",
    "imageInfos",
    "photo_infos",
    "photoInfos",
    "image_list",
    "imageList",
  ];
  nestedKeys.forEach((key) => {
    const nested = safeGet(node, key);
    if (nested) {
      extractDouyinImageUrlsFromStateNode(nested).forEach((url) => matches.push(url));
    }
  });

  return uniqueDouyinImageUrls(matches).filter((url) => isPossibleDouyinImageUrl(url));
}

function collectPreferredUrlsFromStateNodeKeys(node, keys = []) {
  if (!node || typeof node !== "object" || !Array.isArray(keys)) {
    return [];
  }

  const matches = [];
  keys.forEach((key) => {
    const value = safeGet(node, key);
    if (!Array.isArray(value)) {
      return;
    }
    const preferred = pickPreferredImageUrl(
      value.flatMap((item) => {
        if (typeof item === "string") {
          return [item];
        }
        return extractUrlsFromCoverAddress(item);
      }),
    );
    if (preferred) {
      matches.push(preferred);
    }
  });

  return matches;
}

function findNoteScopedStateRoots(rootState, noteId = "") {
  if (!rootState || typeof rootState !== "object" || !noteId) {
    return [];
  }

  const queue = [rootState];
  const seen = new Set();
  const matches = [];
  let scanned = 0;
  const targetId = String(noteId || "").trim();

  while (queue.length > 0 && scanned < 50000) {
    scanned += 1;
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (isUnsafeStateObject(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);

    const currentId = resolveStateNodeNoteId(current);
    if (currentId && currentId === targetId) {
      matches.push(current);
      continue;
    }

    if (Array.isArray(current)) {
      current.forEach((item) => queue.push(item));
      continue;
    }

    safeObjectValues(current).forEach((value) => queue.push(value));
  }

  return matches;
}

function resolveStateNodeNoteId(node) {
  if (!node || typeof node !== "object") {
    return "";
  }

  const candidates = [
    safeGet(node, "aweme_id"),
    safeGet(node, "awemeId"),
    safeGet(node, "group_id"),
    safeGet(node, "groupId"),
    safeGet(node, "item_id"),
    safeGet(node, "itemId"),
    safeGet(node, "id"),
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function extractUrlsFromCoverAddress(address) {
  if (!address) {
    return [];
  }

  if (typeof address === "string") {
    return [address];
  }

  if (typeof address !== "object") {
    return [];
  }
  if (isUnsafeStateObject(address)) {
    return [];
  }

  const matches = [];
  const rawUrlList = safeGet(address, "url_list");
  const rawUrlListCamel = safeGet(address, "urlList");
  const urlList = Array.isArray(rawUrlList)
    ? rawUrlList
    : Array.isArray(rawUrlListCamel)
      ? rawUrlListCamel
      : [];

  urlList.forEach((url) => {
    if (typeof url === "string" && url.trim()) {
      matches.push(url);
    }
  });

  const addressUrl = safeGet(address, "url");
  if (typeof addressUrl === "string" && addressUrl.trim()) {
    matches.push(addressUrl);
  }

  return matches;
}

function pickPreferredVideoUrl(urls = [], context = null) {
  if (!Array.isArray(urls) || urls.length === 0) return "";

  const sorted = [...urls].sort(
    (a, b) => scoreVideoUrl(b, context) - scoreVideoUrl(a, context),
  );
  return sorted[0] || "";
}

function pickPreferredAudioUrl(urls = []) {
  if (!Array.isArray(urls) || urls.length === 0) return "";

  const filtered = urls.filter((url) => isLikelyDownloadableDouyinAudioUrl(url));
  if (filtered.length === 0) return "";

  const sorted = [...filtered].sort((a, b) => scoreAudioUrl(b) - scoreAudioUrl(a));
  return sorted[0] || "";
}

function pickPreferredCoverUrl(urls = []) {
  if (!Array.isArray(urls) || urls.length === 0) return "";

  const sorted = [...urls].sort((a, b) => scoreCoverUrl(b) - scoreCoverUrl(a));
  return sorted[0] || "";
}

function pickPreferredImageUrl(urls = []) {
  if (!Array.isArray(urls) || urls.length === 0) return "";

  const filtered = uniqueDouyinImageUrls(urls).filter((url) => isPossibleDouyinImageUrl(url));
  if (filtered.length === 0) {
    return "";
  }

  const sorted = [...filtered].sort((a, b) => scoreImageUrl(b) - scoreImageUrl(a));
  return sorted[0] || "";
}

function scoreVideoUrl(url, context = null) {
  const text = String(url || "").toLowerCase();
  if (!text) return 0;

  let score = 0;
  if (text.includes("/aweme/v1/play/")) score += 50;
  if (text.includes("video_id=")) score += 50;
  if (text.includes("source=packsourceenum_aweme_detail")) score += 80;
  if (text.includes("is_play_url=1")) score += 30;
  if (text.includes("file_id=")) score += 25;
  if (text.includes("sign=")) score += 20;
  if (text.includes("mime_type=video_mp4")) score += 30;
  if (text.includes("line=0")) score += 10;
  if (text.includes("video/tos/")) score += 8;
  if (context && typeof context === "object") {
    const normalizedUrl = normalizeUrl(url);
    const sourceSet = context.urlSourceMap?.get?.(normalizedUrl) || new Set();
    const sourceWeights = Array.from(sourceSet).map(
      (source) => VIDEO_SOURCE_PRIORITY[source] || 0,
    );
    if (sourceWeights.length > 0) {
      score += Math.max(...sourceWeights);
    }
    if (sourceSet.size > 1) {
      score += (sourceSet.size - 1) * 35;
    }

    const expectedTokens = Array.isArray(context.expectedTokens)
      ? context.expectedTokens
      : [];
    const matchedTokens = expectedTokens.filter((token) => token && text.includes(String(token).toLowerCase()));
    if (matchedTokens.length > 0) {
      score += 120 + (matchedTokens.length - 1) * 20;
    }

    if (context.noteId && text.includes(String(context.noteId).toLowerCase())) {
      score += 160;
    } else if (
      context.noteId &&
      sourceSet.size > 0 &&
      Array.from(sourceSet).every((source) => source === "performance" || source === "mediaRequests")
    ) {
      score -= 70;
    }
  }
  return score;
}

function scoreAudioUrl(url) {
  const text = String(url || "").toLowerCase();
  if (!text) return 0;
  if (!isLikelyDownloadableDouyinAudioUrl(text)) return -1000;

  let score = 0;
  if (text.includes("ies-music")) score += 40;
  if (text.includes("music-east")) score += 30;
  if (/\.(mp3|m4a|aac)(\?|$)/i.test(text)) score += 20;
  if (text.includes("is_ssr=1")) score += 8;
  return score;
}

function scoreCoverUrl(url) {
  const text = String(url || "").toLowerCase();
  if (!text) return 0;

  let score = 0;
  if (text.includes("packsourceenum_aweme_detail")) score += 50;
  if (text.includes("biz_tag=pcweb_cover")) score += 30;
  if (text.includes("sc=cover")) score += 20;
  if (text.includes("aweme_video")) score += 12;
  if (text.includes("origin_cover")) score += 10;
  if (text.includes("raw_cover")) score += 10;
  if (text.includes("dynamic_cover")) score += 8;
  if (/\.webp(\?|$)/i.test(text)) score += 4;
  return score;
}

function scoreImageUrl(url) {
  const text = String(url || "").toLowerCase();
  if (!text) return 0;

  let score = 0;
  if (text.includes("packsourceenum_aweme_detail")) score += 40;
  if (text.includes("image-cut-tos")) score += 24;
  if (text.includes("x-expires=")) score += 10;
  if (text.includes("x-signature=") || text.includes("sign=")) score += 8;
  if (text.includes("download")) score += 20;
  if (text.includes("origin")) score += 16;
  if (text.includes("large")) score += 8;
  if (/tplv-|tos-cn-/i.test(text)) score += 6;
  if (/\.webp(\?|$)/i.test(text)) score += 4;
  score += Math.min(text.length / 100, 6);
  return score;
}

function explainVideoUrlScore(url, context = null) {
  const text = String(url || "").toLowerCase();
  const reasons = [];
  if (text.includes("/aweme/v1/play/")) reasons.push("/aweme/v1/play/");
  if (text.includes("video_id=")) reasons.push("video_id=");
  if (text.includes("source=packsourceenum_aweme_detail")) reasons.push("source=PackSourceEnum_AWEME_DETAIL");
  if (text.includes("is_play_url=1")) reasons.push("is_play_url=1");
  if (text.includes("file_id=")) reasons.push("file_id=");
  if (text.includes("sign=")) reasons.push("sign=");
  if (text.includes("mime_type=video_mp4")) reasons.push("mime_type=video_mp4");
  if (text.includes("line=0")) reasons.push("line=0");
  if (text.includes("video/tos/")) reasons.push("video/tos/");
  if (context && typeof context === "object") {
    const normalizedUrl = normalizeUrl(url);
    const sources = Array.from(context.urlSourceMap?.get?.(normalizedUrl) || []);
    if (sources.length > 0) {
      reasons.push(`sources:${sources.join("+")}`);
    }

    const expectedTokens = Array.isArray(context.expectedTokens)
      ? context.expectedTokens
      : [];
    const matchedTokens = expectedTokens.filter((token) => token && text.includes(String(token).toLowerCase()));
    if (matchedTokens.length > 0) {
      reasons.push(`identity:${matchedTokens.slice(0, 3).join(",")}`);
    }
  }
  return reasons;
}

function explainAudioUrlScore(url) {
  const text = String(url || "").toLowerCase();
  const reasons = [];
  if (text.includes("ies-music")) reasons.push("ies-music");
  if (text.includes("music-east")) reasons.push("music-east");
  if (/\.(mp3|m4a|aac)(\?|$)/i.test(text)) reasons.push("audio extension");
  if (text.includes("is_ssr=1")) reasons.push("is_ssr=1");
  return reasons;
}

function explainCoverUrlScore(url) {
  const text = String(url || "").toLowerCase();
  const reasons = [];
  if (text.includes("packsourceenum_aweme_detail")) reasons.push("packsourceenum_aweme_detail");
  if (text.includes("biz_tag=pcweb_cover")) reasons.push("biz_tag=pcweb_cover");
  if (text.includes("sc=cover")) reasons.push("sc=cover");
  if (text.includes("aweme_video")) reasons.push("aweme_video");
  if (text.includes("origin_cover")) reasons.push("origin_cover");
  if (text.includes("raw_cover")) reasons.push("raw_cover");
  if (text.includes("dynamic_cover")) reasons.push("dynamic_cover");
  if (/\.webp(\?|$)/i.test(text)) reasons.push(".webp");
  return reasons;
}

function describeDomNodeForDiagnostics(node) {
  if (!(node instanceof Element)) {
    return null;
  }

  return {
    tagName: String(node.tagName || "").toLowerCase(),
    id: String(node.id || "").trim(),
    className: cleanText(node.className || "").slice(0, 120),
    dataE2e: cleanText(node.getAttribute("data-e2e") || ""),
    dataAwemeId: cleanText(node.getAttribute("data-e2e-aweme-id") || node.getAttribute("data-aweme-id") || ""),
    textSnippet: cleanText(node.innerText || "").slice(0, 120),
  };
}

function describeVideoElementForDiagnostics(video) {
  if (!(video instanceof Element)) {
    return null;
  }

  const nearbyRuntimeKeys = new Set();
  [video, video.parentElement, video.closest?.(".xgplayer"), video.closest?.("[class*='player']")]
    .filter(Boolean)
    .forEach((element) => {
      safeOwnPropertyNames(element).forEach((key) => {
        if (/player|media|source|dash|hls|config|plugin|xg/i.test(key)) {
          nearbyRuntimeKeys.add(key);
        }
      });
    });

  return {
    ...describeDomNodeForDiagnostics(video),
    currentSrc: normalizeUrl(video.currentSrc || ""),
    src: normalizeUrl(video.getAttribute("src") || video.src || ""),
    poster: normalizeUrl(video.getAttribute("poster") || video.poster || ""),
    currentTime: Number(video.currentTime || 0),
    paused: Boolean(video.paused),
    readyState: Number(video.readyState || 0),
    sourceUrls: getAllMatches(DOUYIN_DOM_PROFILE.noteDetail.fields.videoSources, video)
      .map((source) => normalizeUrl(source?.getAttribute?.("src") || source?.src || source?.currentSrc || ""))
      .filter(Boolean),
    nearbyRuntimeKeys: Array.from(nearbyRuntimeKeys).slice(0, 40),
  };
}

function buildRankedUrlDiagnostics(urls = [], scorer, explainer, selectedUrl = "") {
  return (Array.isArray(urls) ? urls : [])
    .map((url) => {
      const normalized = normalizeUrl(url);
      return {
        url: normalized,
        score: scorer(normalized),
        reasons: explainer(normalized),
        selected: normalized === normalizeUrl(selectedUrl),
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 20);
}

function buildDouyinMediaDiagnostics({
  noteId = "",
  detailRoot = null,
  videoElements = [],
  mediaUrlCollection = {},
  videoUrls = [],
  audioUrls = [],
  coverCandidates = [],
  videoSelectionContext = null,
  selectedVideoUrl = "",
  selectedAudioUrl = "",
  selectedCoverImageUrl = "",
} = {}) {
  return {
    noteId: String(noteId || "").trim(),
    pageUrl: String(window.location.href || ""),
    detailRoot: describeDomNodeForDiagnostics(detailRoot),
    videoElements: (Array.isArray(videoElements) ? videoElements : [])
      .map((video) => describeVideoElementForDiagnostics(video))
      .filter(Boolean),
    candidateSources: {
      apiDetail: buildRankedUrlDiagnostics(
        mediaUrlCollection.apiDetail || [],
        (url) => isLikelyDouyinAudioUrl(url) ? scoreAudioUrl(url) : scoreVideoUrl(url, videoSelectionContext),
        (url) => isLikelyDouyinAudioUrl(url) ? explainAudioUrlScore(url) : explainVideoUrlScore(url, videoSelectionContext),
        selectedVideoUrl || selectedAudioUrl,
      ),
      videoElement: buildRankedUrlDiagnostics(
        mediaUrlCollection.videoElement || [],
        (url) => scoreVideoUrl(url, videoSelectionContext),
        (url) => explainVideoUrlScore(url, videoSelectionContext),
        selectedVideoUrl,
      ),
      inline: buildRankedUrlDiagnostics(
        mediaUrlCollection.inline || [],
        (url) => scoreVideoUrl(url, videoSelectionContext),
        (url) => explainVideoUrlScore(url, videoSelectionContext),
        selectedVideoUrl,
      ),
      state: buildRankedUrlDiagnostics(
        mediaUrlCollection.state || [],
        (url) => isLikelyDouyinAudioUrl(url) ? scoreAudioUrl(url) : scoreVideoUrl(url, videoSelectionContext),
        (url) => isLikelyDouyinAudioUrl(url) ? explainAudioUrlScore(url) : explainVideoUrlScore(url, videoSelectionContext),
        selectedVideoUrl || selectedAudioUrl,
      ),
      react: buildRankedUrlDiagnostics(
        mediaUrlCollection.react || [],
        (url) => isLikelyDouyinAudioUrl(url) ? scoreAudioUrl(url) : scoreVideoUrl(url, videoSelectionContext),
        (url) => isLikelyDouyinAudioUrl(url) ? explainAudioUrlScore(url) : explainVideoUrlScore(url, videoSelectionContext),
        selectedVideoUrl || selectedAudioUrl,
      ),
      playerRuntime: buildRankedUrlDiagnostics(
        mediaUrlCollection.playerRuntime || [],
        (url) => isLikelyDouyinAudioUrl(url) ? scoreAudioUrl(url) : scoreVideoUrl(url, videoSelectionContext),
        (url) => isLikelyDouyinAudioUrl(url) ? explainAudioUrlScore(url) : explainVideoUrlScore(url, videoSelectionContext),
        selectedVideoUrl || selectedAudioUrl,
      ),
      documentVideo: buildRankedUrlDiagnostics(
        mediaUrlCollection.documentVideo || [],
        (url) => scoreVideoUrl(url, videoSelectionContext),
        (url) => explainVideoUrlScore(url, videoSelectionContext),
        selectedVideoUrl,
      ),
      performance: buildRankedUrlDiagnostics(
        mediaUrlCollection.performance || [],
        (url) => isLikelyDouyinAudioUrl(url) ? scoreAudioUrl(url) : scoreVideoUrl(url, videoSelectionContext),
        (url) => isLikelyDouyinAudioUrl(url) ? explainAudioUrlScore(url) : explainVideoUrlScore(url, videoSelectionContext),
        selectedVideoUrl || selectedAudioUrl,
      ),
      mediaRequests: buildRankedUrlDiagnostics(
        mediaUrlCollection.mediaRequests || [],
        (url) => isLikelyDouyinAudioUrl(url) ? scoreAudioUrl(url) : scoreVideoUrl(url, videoSelectionContext),
        (url) => isLikelyDouyinAudioUrl(url) ? explainAudioUrlScore(url) : explainVideoUrlScore(url, videoSelectionContext),
        selectedVideoUrl || selectedAudioUrl,
      ),
    },
    ranked: {
      video: buildRankedUrlDiagnostics(
        videoUrls,
        (url) => scoreVideoUrl(url, videoSelectionContext),
        (url) => explainVideoUrlScore(url, videoSelectionContext),
        selectedVideoUrl,
      ),
      audio: buildRankedUrlDiagnostics(audioUrls, scoreAudioUrl, explainAudioUrlScore, selectedAudioUrl),
      cover: buildRankedUrlDiagnostics(coverCandidates, scoreCoverUrl, explainCoverUrlScore, selectedCoverImageUrl),
    },
    selected: {
      videoUrl: normalizeUrl(selectedVideoUrl),
      videoSource: findSelectedSource(mediaUrlCollection, selectedVideoUrl),
      videoReasons: explainVideoUrlScore(selectedVideoUrl, videoSelectionContext),
      audioUrl: normalizeUrl(selectedAudioUrl),
      audioSource: findSelectedSource(mediaUrlCollection, selectedAudioUrl),
      audioReasons: explainAudioUrlScore(selectedAudioUrl),
      coverImageUrl: normalizeUrl(selectedCoverImageUrl),
      coverReasons: explainCoverUrlScore(selectedCoverImageUrl),
    },
  };
}

function findSelectedSource(mediaUrlCollection = {}, selectedUrl = "") {
  const normalizedSelected = normalizeUrl(selectedUrl);
  if (!normalizedSelected) return "";

  for (const [source, urls] of Object.entries(mediaUrlCollection || {})) {
    if (source === "allUrls") continue;
    const normalizedUrls = Array.isArray(urls) ? urls.map((url) => normalizeUrl(url)) : [];
    if (normalizedUrls.includes(normalizedSelected)) {
      return source;
    }
  }

  return "";
}

function printDouyinMediaDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") {
    return;
  }

  console.log("[Douyin][MediaDiagnostics]", diagnostics);
}

function extractBackgroundImageUrl(element) {
  if (!element) return "";

  const directStyle =
    typeof element.getAttribute === "function" ? element.getAttribute("style") || "" : "";
  const directMatch = directStyle.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
  if (directMatch?.[2]) {
    return directMatch[2];
  }

  const holder = element.querySelector?.('[style*="background-image"]');
  if (!holder) return "";
  const style = holder.getAttribute("style") || "";
  const match = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
  return match ? match[2] : "";
}

function extractDouyinVideoDuration(videoElements = []) {
  const durations = videoElements
    .map((video) => Number(video?.duration || 0))
    .filter((duration) => Number.isFinite(duration) && duration > 0);

  if (durations.length === 0) {
    return 0;
  }

  return Math.round(Math.max(...durations));
}

function isLikelyContentImage(img) {
  if (!img) return false;

  const src = String(img.getAttribute("src") || img.src || "").trim();
  if (!src) return false;

  const lower = src.toLowerCase();
  if (
    lower.includes("twemoji") ||
    lower.includes("/emoji/") ||
    lower.includes("/obj/tos-cn-i-") ||
    lower.includes("aweme-avatar") ||
    lower.includes("/avatar/")
  ) {
    return false;
  }

  const className = String(img.className || "").toLowerCase();
  if (className.includes("avatar")) return false;

  const width = Number(img.naturalWidth || img.width || 0);
  const height = Number(img.naturalHeight || img.height || 0);
  if (width > 0 && height > 0 && (width < 80 || height < 80)) {
    return false;
  }

  return /douyinpic\.com|byteimg\.com|zijieapi\.com/i.test(lower);
}

function isOwnedDouyinContentImage(
  img,
  detailRoot = null,
  imageScope = null,
) {
  if (!(img instanceof Element)) {
    return false;
  }

  const excludedAncestors = [
    '[data-e2e="comment-list"]',
    '[data-e2e*="comment-list"]',
    '[data-e2e*="comment"]',
    '[class*="comment"]',
    '[class*="Comment"]',
    '[class*="recommend"]',
    '[class*="Recommend"]',
    '[class*="related"]',
    '[class*="Related"]',
    "footer",
  ];
  for (const selector of excludedAncestors) {
    try {
      if (img.closest?.(selector)) {
        return false;
      }
    } catch {}
  }

  const root = imageScope instanceof Element
    ? imageScope
    : detailRoot instanceof Element
      ? detailRoot
      : null;
  if (!(root instanceof Element)) {
    return true;
  }

  if (!root.contains(img)) {
    return false;
  }

  const rect = img.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const activeSlide = img.closest?.(".swiper-slide-active, [class*='SwiperSlide'][class*='active']");
  if (activeSlide instanceof Element) {
    return true;
  }

  const slide = img.closest?.(".swiper-slide, [class*='SwiperSlide'], .dySwiperSlide");
  if (slide instanceof Element) {
    try {
      const ariaHidden = slide.getAttribute("aria-hidden");
      if (ariaHidden === "true") {
        return false;
      }
    } catch {}
  }

  const nearbyText = cleanText(
    img.closest?.("figure, li, article, section, div")?.textContent || "",
  );
  if (/^(相关推荐|大家都在搜|暂无评论|全部评论|评论区)/.test(nearbyText)) {
    return false;
  }

  return true;
}

function isLikelyDouyinVideoUrl(url) {
  const text = String(url || "").trim();
  if (!text) return false;

  const lower = text.toLowerCase();
  if (!/^https?:\/\//i.test(lower)) return false;
  if (/^blob:|^data:/i.test(lower)) return false;
  if (isLikelyDouyinAudioUrl(lower)) return false;
  
  // 拦截伪装成mp4的 DASH audio轨
  if (lower.includes("media-audio")) return false;

  if (/\.(mp4|m3u8|webm)(\?|$)/i.test(lower)) {
    return true;
  }

  if (lower.includes("/aweme/v1/play/")) {
    return true;
  }

  if (lower.includes("video/tos/")) {
    return true;
  }
  
  if (lower.includes("douyinvod.com") || lower.includes("bytevod.com") || lower.includes("zjcdn.com") || lower.includes("douyinpic.com/video")) {
    return true;
  }

  return lower.includes("mime_type=video_mp4") || lower.includes("video_id=");
}

function isLikelyDouyinAudioUrl(url) {
  const text = String(url || "").trim();
  if (!text) return false;

  const lower = text.toLowerCase();
  if (!/^https?:\/\//i.test(lower)) return false;
  if (/^blob:|^data:/i.test(lower)) return false;
  if (isBlockedDouyinPageLikeUrl(lower)) return false;
  
  if (lower.includes("xtag=audio")) {
    return true;
  }
  
  // 拦截抖音 DASH 资源的纯音乐轨道
  if (lower.includes("media-audio")) {
    return true;
  }
  
  if (lower.includes("mime_type=audio_mp4") || lower.includes("mime_type=audio_aac") || lower.includes("mime_type=audio_")) {
    return true;
  }

  if (/\.(mp4|m3u8|webm)(\?|$)/i.test(lower) && !lower.includes("audio")) return false;

  return (
    /\.(mp3|m4a|aac|wav)(\?|$)/i.test(lower) ||
    lower.includes("ies-music") ||
    lower.includes("music-east") ||
    lower.includes("/obj/ies-music-") ||
    lower.includes("/audio/")
  );
}

function isLikelyDownloadableDouyinAudioUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  if (!isLikelyDouyinAudioUrl(normalized)) return false;
  return !isBlockedDouyinPageLikeUrl(normalized);
}

function isBlockedDouyinPageLikeUrl(url) {
  const lower = String(url || "").trim().toLowerCase();
  if (!lower) return true;
  if (/^blob:|^data:/i.test(lower)) return true;
  if (/^https?:\/\/v\.douyin\.com\//i.test(lower)) return true;
  if (lower.endsWith(".html")) return true;
  if (
    /^https?:\/\/(?:www\.)?douyin\.com\/(?:user|video|note|search|jingxuan(?:\/search)?)(?:[/?#]|$)/i.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}

function isLikelyDouyinCoverUrl(url) {
  const text = String(url || "").trim();
  if (!text) return false;

  const lower = text.toLowerCase();
  if (!isPossibleDouyinImageUrl(lower)) return false;
  if (
    lower.includes("get_app") ||
    lower.includes("fold_get_app") ||
    lower.includes("twemoji") ||
    lower.includes("avatar") ||
    lower.includes("emoji")
  ) {
    return false;
  }

  return (
    lower.includes("pcweb_cover") ||
    lower.includes("aweme_detail") ||
    lower.includes("aweme_video") ||
    lower.includes("origin_cover") ||
    lower.includes("raw_cover") ||
    lower.includes("dynamic_cover") ||
    lower.includes("sc=cover") ||
    lower.includes("biz_tag=pcweb_cover")
  );
}

function isPossibleDouyinImageUrl(url) {
  const text = String(url || "").trim();
  if (!text) return false;

  const lower = text.toLowerCase();
  if (!/^https?:\/\//i.test(lower)) return false;
  if (!/\.(jpg|jpeg|png|webp|avif)(\?|$)|image-cut-tos|tplv-/i.test(lower)) return false;
  if (!/douyinpic\.com|byteimg\.com|zijieapi\.com/i.test(lower)) return false;
  if (
    lower.includes("get_app") ||
    lower.includes("fold_get_app") ||
    lower.includes("twemoji") ||
    lower.includes("avatar") ||
    lower.includes("emoji")
  ) {
    return false;
  }

  return true;
}

function uniqueNormalized(values = []) {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeUrl(value))
        .filter((value) => value && !value.startsWith("blob:")),
    ),
  );
}

function uniqueDouyinImageUrls(values = []) {
  const seen = new Set();
  const result = [];

  values.forEach((value) => {
    const normalized = normalizeUrl(value);
    if (!normalized || normalized.startsWith("blob:")) {
      return;
    }

    const identity = canonicalizeDouyinImageUrl(normalized);
    if (seen.has(identity)) {
      return;
    }
    seen.add(identity);
    result.push(normalized);
  });

  return result;
}

function canonicalizeDouyinImageUrl(raw) {
  const normalized = normalizeUrl(raw);
  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname || "";
    const fileName = pathname.split("/").filter(Boolean).pop() || pathname;
    const withoutExt = fileName.replace(/\.(jpg|jpeg|png|webp|avif)$/i, "");
    const normalizedHost = parsed.hostname.replace(/^p\d+(?:-[^.]+)?\./i, "");
    const stableFileKey = withoutExt.split("~")[0];
    return `${normalizedHost}${stableFileKey}`;
  } catch {
    return normalized.split("?")[0];
  }
}

function normalizeUrl(raw) {
  const text = String(raw || "").replace(/&amp;/g, "&").trim();
  if (!text) return "";

  if (text.startsWith("//")) {
    return `https:${text}`;
  }

  try {
    return new URL(text, "https://www.douyin.com").toString();
  } catch {
    return text;
  }
}
