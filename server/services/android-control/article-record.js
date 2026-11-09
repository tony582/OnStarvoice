const object = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
};

/** Preserve a complete article and previously observed metrics when a later visit only reads part of it. */
export function mergeArticleRecord(record, existing = {}) {
  if (record.platform !== 'wechat_articles') return record;
  const incoming = object(record.payload), previous = object(existing.payload);
  const article = object(incoming.wechatArticle), old = object(previous.wechatArticle);
  if (!article.title) return record;
  const metrics = Object.fromEntries(['read', 'like', 'share', 'recommend'].map(key => {
    const current = article.metrics?.[key], known = old.metrics?.[key];
    return [key, current?.value == null && known?.value != null ? known : current];
  }));
  const hasOldBody = Boolean(old.content) || old.images?.some(image => image.url);
  const preserveBody = hasOldBody && ((old.source === 'page_dom' && old.bodyStatus === 'complete' && article.source !== 'page_dom')
    || (article.bodyStatus !== 'complete' && (old.bodyStatus === 'complete' || (old.content?.length ?? 0) > article.content.length)));
  const stored = {...article, metrics, latestCapture: {at: incoming.captureTimestamp, source: article.source, capturedAt: article.capturedAt,
    timeSource: article.timeSource, bodyStatus: article.bodyStatus,
    bodyReason: article.bodyReason, metrics: article.metrics, comments: article.comments, evidence: article.evidence,
    title: article.title, account: article.account, author: article.author, publishedAt: article.publishedAt, timePrecision: article.timePrecision}};
  if (preserveBody) {
    for (const key of ['content', 'bodyStatus', 'bodyReason', 'bodyBlocks', 'images', 'contentType', 'evidence',
      'source', 'capturedAt', 'timeSource', 'title', 'account', 'author', 'publishedAt', 'timeLabel', 'timePrecision', 'location']) {
      if (old[key] !== undefined) stored[key] = old[key];
    }
  }
  const imageUrls = (stored.images || []).map(image => image.url).filter(Boolean);
  const payload = {...incoming, imageUrls, title: stored.title, author: stored.account, publishTime: stored.publishedAt,
    content: stored.content, wechatArticle: stored, detailPayload: {...incoming.detailPayload, publishTime: stored.publishedAt},
    detailCaptureStatus: stored.bodyStatus === 'complete' ? 'done' : stored.bodyStatus};
  return {...record, title: stored.title, author_name: stored.account, publish_time: stored.publishedAt,
    publish_location: stored.location, content: stored.content, image_urls: JSON.stringify(imageUrls), payload: JSON.stringify(payload)};
}
