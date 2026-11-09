import {createHash} from 'node:crypto';
import {requireUuid} from '../capture-discovery/validation.js';
import {truncateWellFormed} from '../../utils/well-formed-text.js';
import {digest, fail} from './validation.js';
import {isAllowedMediaHost} from '../media-proxy.js';

export const ARTICLE_PLATFORM = 'wechat_articles';
export const ARTICLE_EVENT_KIND = 'wechat_article';
export const ARTICLE_CONTENT_MAX = 100_000;
const SKEW_MS = 5 * 60_000;
const ARTICLE_SOURCES = new Set(['screen_ocr', 'page_dom']);
function evidenceSource(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (ARTICLE_SOURCES.has(value) || value === 'unknown') return value;
  fail('INVALID_ARTICLE_EVIDENCE_SOURCE', 422);
}
const str = (value, max) => typeof value === 'string' ? truncateWellFormed(value.normalize('NFC'), max) : '';
const sha = value => createHash('sha256').update(value).digest('hex');
const COMMENT_STATUSES = new Set(['captured', 'partial', 'disabled', 'empty', 'not_relocated', 'closed', 'unavailable', 'unknown']);

export function articleFilterBlockReason(filters = {}) {
  for (const key of ['searchScope', 'videoDuration', 'contentType', 'distance']) {
    if (filters[key] !== undefined && filters[key] !== 'all') return 'article_filter_unsupported';
  }
  if (filters.sort !== undefined && !['comprehensive', 'latest', 'likes'].includes(filters.sort)) return 'article_sort_unsupported';
  return '';
}
export function validateArticleFilters(filters = {}) {
  const reason = articleFilterBlockReason(filters);
  if (reason) fail(reason, 422);
}

/** Only the public short article URLs actually verified on the phone. Tracking query/hash are not identity. */
export function canonicalArticleUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.username || url.password || url.port
    || !/^\/s\/[A-Za-z0-9_-]{8,128}\/?$/u.test(url.pathname)) return '';
  return `https://mp.weixin.qq.com${url.pathname.replace(/\/$/u, '')}`;
}
export function articleExternalId(value) {
  const canonical = canonicalArticleUrl(value);
  if (!canonical) fail('INVALID_ARTICLE_LINK', 422);
  return `wxa_${sha(canonical).slice(0, 24)}`;
}

function observedAt(value, fallback) {
  if (value === undefined || value === null || value === '') return new Date(fallback).toISOString();
  const at = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(at) || at < 946684800000 || at > fallback + SKEW_MS) fail('INVALID_ARTICLE_OBSERVED_AT', 422);
  return new Date(at).toISOString();
}
function metric(input, source, capturedAt) {
  const raw = str(input?.raw, 40);
  const value = typeof input?.value === 'number' && Number.isSafeInteger(input.value) && input.value >= 0 && input.value <= 2_147_483_647
    ? input.value : null;
  return {raw, value, precision: str(input?.precision, 80) || (value === null ? 'unknown' : 'displayed_integer'),
    source: evidenceSource(input?.source, source), capturedAt: observedAt(input?.capturedAt, capturedAt)};
}

// Preserve minute/day precision, never append fabricated seconds. All zone-free values are Beijing time.
export function articlePublishTime(value, precision, capturedAt) {
  if (precision === 'unknown') return '';
  const text = str(value, 50).trim();
  const match = text.match(/^(20\d{2})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::00)?(?:\+08:00)?)?$/u);
  if (!match || (precision === 'minute') !== (match[4] !== undefined)) fail('INVALID_ARTICLE_PUBLISH_TIME', 422);
  const [, y, mo, d, h = '00', mi = '00'] = match;
  const local = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  if (local.getUTCFullYear() !== +y || local.getUTCMonth() + 1 !== +mo || local.getUTCDate() !== +d
    || +h > 23 || +mi > 59 || local.getTime() - 8 * 3600_000 > capturedAt + SKEW_MS) fail('INVALID_ARTICLE_PUBLISH_TIME', 422);
  return `${y}-${mo}-${d}${precision === 'minute' ? ` ${h}:${mi}` : ''}`;
}

function mediaUrl(value) {
  const text = str(value, 2048);
  try { const url = new URL(text); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? text : ''; }
  catch { return ''; }
}
function normalizeBody(article) {
  const source = article.source;
  const images = (Array.isArray(article.images) ? article.images : []).slice(0, 100).map((item, index) => {
    const url = mediaUrl(item?.url);
    return {index, order: index, url, alt: str(item?.alt, 1000), caption: str(item?.caption, 1000), ocrText: str(item?.ocrText, 20_000),
      // URL extraction is not image download. Only media-store's local file mapping proves storage.
      stored: false, downloadEligible: Boolean(url && isAllowedMediaHost(url)), source: evidenceSource(item?.source, source)};
  });
  const bodyBlocks = (Array.isArray(article.bodyBlocks) ? article.bodyBlocks : []).slice(0, 2000)
    .filter(item => item && ['text', 'image', 'video', 'audio', 'card'].includes(item.type))
    .map(item => {
      const url = mediaUrl(item.url);
      const matched = url ? images.findIndex(image => image.url === url) : -1;
      return {type: item.type, text: str(item.text, ARTICLE_CONTENT_MAX), url, alt: str(item.alt, 1000),
        imageIndex: Number.isSafeInteger(item.imageIndex) && item.imageIndex >= 0 && item.imageIndex < images.length ? item.imageIndex : matched >= 0 ? matched : null,
        source: evidenceSource(item.source, source)};
    });
  if (JSON.stringify({images, bodyBlocks}).length > 500_000) fail('ARTICLE_BODY_TOO_LARGE', 413);
  return {images, bodyBlocks};
}

export function normalizeArticleEvent(input, principal) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.eventKind !== ARTICLE_EVENT_KIND) fail('INVALID_POST_EVENT', 422);
  const event = {};
  for (const key of ['eventId', 'discoveryRunId', 'taskId', 'itemId', 'attemptId', 'agentId']) event[key] = requireUuid(input[key], key);
  if (event.agentId !== principal.agentId) fail('AGENT_ID_MISMATCH', 403);
  if (event.taskId !== event.discoveryRunId) fail('RUN_TASK_MISMATCH', 422);
  if (!/^[a-f0-9]{64}$/u.test(input.requestHash) || !Number.isSafeInteger(input.assignmentRevision) || input.assignmentRevision < 1) fail('INVALID_ATTEMPT', 422);
  const capturedAt = Date.parse(input.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt > Date.now() + SKEW_MS) fail('INVALID_CAPTURED_AT', 422);
  const shareUrl = canonicalArticleUrl(input.link?.shareUrl);
  if (!shareUrl) fail('INVALID_ARTICLE_LINK', 422);
  const source = input.article;
  if (!source || typeof source !== 'object' || Array.isArray(source) || !str(source.title, 500).trim()
    || !str(source.account, 200).trim() || typeof source.content !== 'string' || !ARTICLE_SOURCES.has(source.source)
    || !['complete', 'partial', 'unavailable'].includes(source.bodyStatus)
    || !['minute', 'date', 'unknown'].includes(source.timePrecision)) fail('INVALID_ARTICLE', 422);
  if (source.content.length > ARTICLE_CONTENT_MAX) fail('ARTICLE_CONTENT_TOO_LARGE', 413);
  const body = normalizeBody(source);
  if (source.bodyStatus === 'complete' && !source.content.trim()
    && !(source.source === 'page_dom' && body.images.some(image => image.url))) fail('EMPTY_COMPLETE_ARTICLE', 422);
  const articleCapturedAt = observedAt(source.capturedAt, capturedAt);
  const comments = input.comments ?? {};
  if (!COMMENT_STATUSES.has(comments.status)) fail('INVALID_ARTICLE_COMMENT_STATUS', 422);
  // This endpoint currently receives phone-read comments only. Never relabel a supplied DOM source as OCR.
  if (comments.source != null && comments.source !== 'screen_ocr') fail('INVALID_ARTICLE_COMMENT_SOURCE', 422);
  const rawItems = Array.isArray(comments.items) ? comments.items.slice(0, 500) : [];
  // Refuse malformed items instead of dropping them and shifting the parent's array index.
  const items = rawItems.map((item, index) => {
    if (!item || !str(item.author, 120).trim() || !str(item.content, 2000).trim()) fail('INVALID_ARTICLE_COMMENT', 422);
    const parentIndex = item.reply === true && Number.isSafeInteger(item.parentIndex) && item.parentIndex >= 0 && item.parentIndex < index
      ? item.parentIndex : null;
    return {author: str(item.author, 120).trim(), content: str(item.content, 2000).trim(), location: str(item.location, 40),
      timeLabel: str(item.timeLabel, 80), likeCount: Number.isSafeInteger(item.likeCount) && item.likeCount >= 0 ? item.likeCount : null,
      reply: item.reply === true, parentIndex};
  });
  const headerCount = Number.isSafeInteger(comments.headerCount) && comments.headerCount >= 0 ? comments.headerCount : null;
  if (comments.status === 'empty' && (items.length || headerCount !== 0)) fail('INVALID_EMPTY_ARTICLE_COMMENTS', 422);
  if (comments.status === 'disabled' && items.length) fail('INVALID_DISABLED_ARTICLE_COMMENTS', 422);
  return {...event, eventKind: ARTICLE_EVENT_KIND, platform: ARTICLE_PLATFORM, capturedAt,
    requestHash: input.requestHash, assignmentRevision: input.assignmentRevision,
    mode: input.mode === 'patrol' ? 'patrol' : 'keyword', rank: Number.isSafeInteger(input.rank) && input.rank > 0 ? input.rank : null,
    shareUrl, rawShareUrl: str(input.link.shareUrl, 2048),
    card: {snippet: str(input.card?.snippet, 2000), author: str(input.card?.author, 200), timeLabel: str(input.card?.timeLabel, 80)},
    article: {title: str(source.title, 500).trim(), content: str(source.content, ARTICLE_CONTENT_MAX), account: str(source.account, 200).trim(),
      author: str(source.author, 200), publishedAt: articlePublishTime(source.publishedAt, source.timePrecision, capturedAt),
      timeLabel: str(source.timeLabel, 100), timePrecision: source.timePrecision, location: str(source.location, 80),
      bodyStatus: source.bodyStatus, bodyReason: str(source.bodyReason, 160), source: source.source,
      capturedAt: articleCapturedAt, timeSource: evidenceSource(source.timeSource, source.source),
      contentType: source.contentType === 'image' ? 'image' : 'article', coverUrl: mediaUrl(source.coverUrl),
      evidence: {screens: Number.isSafeInteger(source.evidence?.screens) && source.evidence.screens >= 0 && source.evidence.screens <= 10_000
        ? source.evidence.screens : null, bodyEndObserved: source.evidence?.bodyEndObserved === true,
        overlapVerified: source.evidence?.overlapVerified == null ? null : source.evidence.overlapVerified === true,
        originalImagesCaptured: false, domContentObserved: source.evidence?.domContentObserved === true,
        domReadyState: ['complete', 'interactive', 'loading'].includes(source.evidence?.domReadyState) ? source.evidence.domReadyState : '',
        imageUrlsObserved: Number.isSafeInteger(source.evidence?.imageUrlsObserved) && source.evidence.imageUrlsObserved >= 0
          && source.evidence.imageUrlsObserved <= 100 ? source.evidence.imageUrlsObserved : null,
        commentScreens: Number.isSafeInteger(source.evidence?.commentScreens) && source.evidence.commentScreens >= 0
          && source.evidence.commentScreens <= 10_000 ? source.evidence.commentScreens : null,
        selectorAcceptance: source.evidence?.selectorAcceptance === 'offline_fixtures_only' ? 'offline_fixtures_only' : ''},
      metrics: Object.fromEntries(['read', 'like', 'share', 'recommend'].map(key => [key, metric(source.metrics?.[key], source.source, capturedAt)])),
      ...body},
    comments: {status: comments.status, headerCount, items, source: 'screen_ocr', capturedAt: observedAt(comments.capturedAt, capturedAt),
      postingState: ['open', 'followers_only', 'closed', 'unknown'].includes(comments.postingState) ? comments.postingState : 'unknown',
      reason: str(comments.reason, 160)}, payloadHash: digest(input)};
}

export function articleSyncBody(event, {keyword, taskId, attemptId, requestHash}, convertComments) {
  const externalId = articleExternalId(event.shareUrl), {article, comments} = event;
  const detail = {likes: article.metrics.like.value, collects: article.metrics.recommend.value, shares: article.metrics.share.value,
    comments: comments.headerCount, publishTime: article.publishedAt,
    metricKnown: {likes: article.metrics.like.value !== null, collects: article.metrics.recommend.value !== null,
      shares: article.metrics.share.value !== null, comments: comments.headerCount !== null}, commentsCountSource: 'article_visible_header'};
  const commentItems = convertComments(externalId, comments, Date.parse(comments.capturedAt)).map((item, index) => ({...item,
    likes: comments.items[index].likeCount, source: comments.source, capturedAt: comments.capturedAt}));
  return {externalId, body: {syncType: 'keyword_notes', captureTaskId: taskId, captureTaskItemAttemptId: attemptId,
    captureTaskItemRequestHash: requestHash,
    payload: {noteId: externalId, platform: ARTICLE_PLATFORM, title: article.title, content: article.content,
      author: article.account, url: event.shareUrl, canonicalUrl: event.shareUrl, publishTime: article.publishedAt,
      publishLocation: article.location, coverImageUrl: article.coverUrl, noteType: article.contentType, keyword,
      rankPosition: event.rank ?? undefined, detailCaptureStatus: article.bodyStatus === 'complete' ? 'done' : article.bodyStatus,
      detailPayload: detail, ...detail, commentsCleanedItems: commentItems, commentsCaptureStatus: comments.status,
      commentsTotalCaptured: comments.items.length, captureTimestamp: event.capturedAt,
      imageUrls: article.images.map(image => image.url).filter(Boolean),
      wechatArticle: {...article, rawShareUrl: event.rawShareUrl, identityBasis: 'canonical_short_link',
        card: event.card, comments: {status: comments.status, postingState: comments.postingState, source: comments.source, capturedAt: comments.capturedAt,
          reason: comments.reason, headerCount: comments.headerCount}}}}};
}
