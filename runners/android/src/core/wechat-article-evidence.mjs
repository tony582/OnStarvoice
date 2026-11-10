import {createHash} from 'node:crypto';
import {eventIdFor} from './discovery-evidence.mjs';
import {requireEvidence} from './errors.mjs';
import {canonicalArticleUrl} from '../shared/wechat-article-identity.mjs';
export {canonicalArticleUrl} from '../shared/wechat-article-identity.mjs';

const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit).toWellFormed() : '';
const imageLayer = value => ['visible', 'interactive'].includes(value) ? {layer: value} : {};
export function articleWorkKey(value) {
  const url = canonicalArticleUrl(value);
  requireEvidence(!!url, 'article_link_invalid');
  return `wxa_${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
}
const captureTime = (value, fallback) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date(fallback).toISOString();
const metric = (value, source, capturedAt) => ({raw: text(value?.raw, 40),
  value: Number.isSafeInteger(value?.value) && value.value >= 0 ? value.value : null,
  precision: text(value?.precision, 80) || (Number.isSafeInteger(value?.value) ? 'displayed_integer' : 'unknown'),
  source: value?.source === 'page_dom' ? 'page_dom' : value?.source === 'screen_ocr' ? 'screen_ocr' : source,
  capturedAt: captureTime(value?.capturedAt, capturedAt)});

/** The canonical link has already been checked on both surfaces. Never merge phone OCR into DOM prose. */
export function mergeArticleCapture(page, phone, capturedAt) {
  const at = new Date(capturedAt).toISOString(), mobile = phone?.article ?? {};
  const comments = {...phone?.comments, source: 'screen_ocr', capturedAt: captureTime(phone?.comments?.capturedAt, capturedAt)};
  if (!page) return {...phone, article: {...mobile, source: 'screen_ocr', capturedAt: at}, comments};
  const metrics = Object.fromEntries(['read', 'like', 'share', 'recommend'].map(name => {
    const visible = mobile.metrics?.[name];
    return [name, Number.isSafeInteger(visible?.value) && visible.value >= 0
      ? {...visible, source: 'screen_ocr', capturedAt: captureTime(visible.capturedAt, capturedAt)}
      : {...page.metrics?.[name], source: 'page_dom', capturedAt: captureTime(page.metrics?.[name]?.capturedAt, page.capturedAt ?? capturedAt)}];
  }));
  return {article: {...page, source: 'page_dom', capturedAt: captureTime(page.capturedAt, capturedAt), metrics,
    evidence: {...page.evidence, originalImagesCaptured: false,
      commentScreens: Number.isSafeInteger(mobile.evidence?.screens) ? mobile.evidence.screens : null}}, comments};
}

/** Durable article identity comes from the copied URL, never OCR author/time or a result-card title. */
export function articleEvent({task, card, rank, shareUrl, article, comments, capturedAt}) {
  const url = canonicalArticleUrl(shareUrl), key = articleWorkKey(url);
  requireEvidence(article?.title?.trim() && article?.account?.trim(), 'article_header_unverified');
  const content = text(article.content, 100_000);
  const truncated = (article.content?.length ?? 0) > content.length;
  const source = article.source === 'page_dom' ? 'page_dom' : 'screen_ocr';
  const images = source === 'page_dom' ? (article.images ?? []).slice(0, 100).filter(item => /^https?:\/\//u.test(item?.url ?? ''))
    .map((item, order) => ({url: text(item.url, 2000), alt: text(item.alt, 1000), order, source, stored: false, ...imageLayer(item.layer)})) : [];
  const imageUrls = new Set(images.map(item => item.url));
  let remainingText = 100_000;
  const bodyBlocks = source === 'page_dom' ? (article.bodyBlocks ?? []).slice(0, 2000).flatMap(item => {
    if (item.type === 'text' && remainingText > 0) {
      const value = text(item.text, remainingText); remainingText -= value.length;
      return [{type: 'text', text: value}];
    }
    return item.type === 'image' && imageUrls.has(item.url) ? [{type: 'image', url: text(item.url, 2000), alt: text(item.alt, 1000), ...imageLayer(item.layer)}] : [];
  }) : [];
  return {eventKind: 'wechat_article', workKey: key, eventId: eventIdFor(task, {detailId: key}, key), ...task.identity,
    keyword: task.keyword, mode: task.mode === 'patrol' ? 'patrol' : 'keyword', rank,
    capturedAt: new Date(capturedAt).toISOString(), link: {shareUrl: url},
    card: {snippet: text(card?.snippet, 2000), author: text(card?.author, 200), timeLabel: text(card?.timeLabel, 80)},
    article: {title: text(article.title, 500), content, account: text(article.account, 200), author: text(article.author, 200),
      publishedAt: article.publishedAt ?? null, timeLabel: text(article.timeLabel, 100), timePrecision: article.timePrecision ?? 'unknown',
      location: text(article.location, 80), source, capturedAt: captureTime(article.capturedAt, capturedAt),
      timeSource: article.timeSource === 'page_dom' ? 'page_dom' : source, images, bodyBlocks,
      contentType: article.contentType === 'image' ? 'image' : 'article',
      bodyStatus: truncated ? 'partial' : article.bodyStatus ?? 'partial', bodyReason: truncated ? 'content_limit' : text(article.bodyReason, 160),
      evidence: {screens: Number.isSafeInteger(article.evidence?.screens) ? article.evidence.screens : null,
        bodyEndObserved: article.evidence?.bodyEndObserved === true, overlapVerified: source === 'page_dom' ? null : article.evidence?.overlapVerified === true,
        originalImagesCaptured: false, domContentObserved: source === 'page_dom' && article.evidence?.domContentObserved === true,
        domReadyState: source === 'page_dom' ? text(article.evidence?.domReadyState, 20) : '',
        selectorAcceptance: ['offline_fixtures_only', 'live_dom_20261109'].includes(article.evidence?.selectorAcceptance)
          ? article.evidence.selectorAcceptance : '',
        imageUrlsObserved: images.length, commentScreens: Number.isSafeInteger(article.evidence?.commentScreens) ? article.evidence.commentScreens : null},
      metrics: Object.fromEntries(['read', 'like', 'share', 'recommend'].map(name => [name, metric(article.metrics?.[name], source, capturedAt)]))},
    comments: {status: comments?.status ?? 'unknown', postingState: comments?.postingState ?? 'unknown',
      source: 'screen_ocr', capturedAt: captureTime(comments?.capturedAt, capturedAt),
      reason: text(comments?.reason, 160), headerCount: Number.isSafeInteger(comments?.headerCount) ? comments.headerCount : null,
      items: (comments?.items ?? []).slice(0, 500).map(item => ({author: item.authorUncertain === true ? '' : text(item.author, 120), content: text(item.content, 2000),
        ...(item.authorUncertain === true ? {authorUncertain: true} : {}),
        location: text(item.location, 40), timeLabel: text(item.timeLabel, 80),
        likeCount: Number.isSafeInteger(item.likeCount) ? item.likeCount : null, reply: item.reply === true,
        parentIndex: Number.isSafeInteger(item.parentIndex) ? item.parentIndex : null}))}};
}

/** A date alone spans the whole local day. Only exclude a post when the latest possible instant is old. */
export function articleOutsideWindow(article, capturedAt, hours) {
  if (hours === null || !article?.publishedAt || article.timePrecision === 'unknown') return false;
  let value = article.publishedAt.replace(' ', 'T');
  if (article.timePrecision === 'date') value = `${value.slice(0, 10)}T23:59:59.999+08:00`;
  else if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) value += '+08:00';
  const latest = Date.parse(value) + (article.timePrecision === 'minute' ? 59_999 : 0);
  return Number.isFinite(latest) && capturedAt - latest > hours * 3600_000;
}

export function articleWindowState(article, capturedAt, hours) {
  if (hours === null) return 'inside';
  if (!article?.publishedAt || article.timePrecision === 'unknown') return 'unknown';
  let start = article.publishedAt.replace(' ', 'T');
  if (article.timePrecision === 'date') start = `${start.slice(0, 10)}T00:00:00+08:00`;
  else if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(start)) start += '+08:00';
  const earliest = Date.parse(start);
  if (!Number.isFinite(earliest)) return 'unknown';
  const latest = earliest + (article.timePrecision === 'date' ? 86400_000 : 60_000) - 1;
  const cutoff = capturedAt - hours * 3600_000;
  return latest < cutoff ? 'outside' : earliest < cutoff || earliest > capturedAt ? 'unknown' : 'inside';
}
