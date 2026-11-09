/**
 * Selectors replayed against user-provided live DOM snapshots from 2026-11-09, without site access.
 * Snapshot acceptance does not establish end-to-end browser or image-download acceptance.
 * This function is self-contained so the existing preview browser can evaluate it in its page.
 * Reads rendered DOM only: no page globals, cookies, tokens, API calls or hidden script payloads.
 */
export function readArticleDocument(document, {expectedUrl, capturedAt = new Date().toISOString(), getStyle} = {}) {
  const failure = (reason, retryable = false) => ({ok: false, reason, retryable, readyState: document?.readyState ?? ''});
  const canonical = value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'mp.weixin.qq.com' && !url.username && !url.password && !url.port
        && /^\/s\/[A-Za-z0-9_-]{8,128}\/?$/u.test(url.pathname)
        ? `https://mp.weixin.qq.com${url.pathname.replace(/\/$/u, '')}` : '';
    } catch { return ''; }
  };
  const wanted = canonical(expectedUrl), actual = canonical(document?.URL);
  if (wanted && document?.URL === 'about:blank') return failure('article_preview_loading', true);
  if (!wanted || !actual || wanted !== actual) return failure('article_preview_identity_mismatch');
  const at = Date.parse(capturedAt);
  if (!Number.isFinite(at)) return failure('article_preview_invalid_time');
  capturedAt = new Date(at).toISOString();
  const styleOf = getStyle ?? (node => document.defaultView?.getComputedStyle?.(node));
  const hidden = node => {
    const element = node?.nodeType === 3 ? node.parentElement : node;
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute?.('aria-hidden') === 'true') return true;
      const style = styleOf(current);
      // Lazy images expose their public URL before scrolling reveals their bitmap. This exception is
      // only for the image itself: a hidden ancestor, display:none or visibility:hidden still hides it.
      const placeholder = current === element && current.tagName?.toUpperCase() === 'IMG'
        && (current.getAttribute?.('data-src') || String(current.getAttribute?.('class') ?? '').split(/\s+/u).includes('js_img_placeholder'));
      if (style?.display === 'none' || ['hidden', 'collapse'].includes(style?.visibility)
        || (style?.opacity === '0' && !placeholder)) return true;
    }
    return false;
  };
  const visible = node => !!node && !hidden(node) && (!node.getClientRects || node.getClientRects().length > 0);
  const clean = value => String(value ?? '').replace(/\u00a0/gu, ' ').replace(/[\t\r ]+/gu, ' ').trim();
  const first = selectors => [...document.querySelectorAll(selectors)].find(visible) ?? null;
  const nodeText = node => visible(node) ? clean(node.innerText ?? node.textContent) : '';
  const root = first('#js_content, .rich_media_content');
  const verification = [...document.querySelectorAll('[role="dialog"], #js_verify_container, #verify_container')]
    .some(node => visible(node) && /环境异常|访问过于频繁|完成验证|安全验证|请输入验证码|访问受限/u.test(nodeText(node)));
  if (verification) return failure('article_preview_verification_required');
  // Gates are outside article content; mentioning verification/deletion in a real article is harmless.
  if (!root) {
    const pageText = nodeText(document.body).slice(0, 3000);
    if (/环境异常|访问过于频繁|完成验证|安全验证|请输入验证码|访问受限/u.test(pageText)) return failure('article_preview_verification_required');
    if (/该内容已被发布者删除|此内容因违规无法查看|内容已被删除|该内容暂时无法查看|链接已过期/u.test(pageText)) return failure('article_preview_unavailable');
    return failure('article_preview_incomplete', true);
  }
  if (document.readyState !== 'complete') return failure('article_preview_loading', true);
  if ([...document.querySelectorAll('button, [role="button"]')].some(node => visible(node)
    && /^(?:阅读全文|展开全文|继续阅读)$/u.test(nodeText(node)))) return failure('article_preview_body_folded');
  const title = nodeText(first('#activity-name, .rich_media_title'));
  const account = nodeText(first('#js_name, .rich_media_meta_nickname'));
  if (!title || !account || title.length > 500 || account.length > 200) return failure('article_preview_header_incomplete', true);
  const author = nodeText(first('#js_author_name_text')) || nodeText(first('#js_author_name')) || account;
  const timeLabel = nodeText(first('#publish_time, #js_publish_time'));
  let date = timeLabel.match(/(20\d{2})[年/.-]\s*(\d{1,2})[月/.-]\s*(\d{1,2})日?(?:\s+(\d{1,2})[:：](\d{2}))?/u);
  const englishDate = timeLabel.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s*(20\d{2}),\s*(\d{1,2}):(\d{2})\s+(AM|PM)$/iu);
  if (!date && englishDate) {
    const [, month, day, year, hour, minute, period] = englishDate;
    if (+hour < 1 || +hour > 12) return failure('article_preview_invalid_time');
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    date = ['', year, String(months.indexOf(month.toLowerCase()) + 1), day, String(+hour % 12 + (period.toUpperCase() === 'PM' ? 12 : 0)), minute];
  }
  let publishedAt = null, timePrecision = 'unknown';
  if (date) {
    const [, y, m, d, h, minute] = date, utc = new Date(Date.UTC(+y, +m - 1, +d, +(h ?? 0), +(minute ?? 0)));
    if (utc.getUTCFullYear() !== +y || utc.getUTCMonth() + 1 !== +m || utc.getUTCDate() !== +d
      || +(h ?? 0) > 23 || +(minute ?? 0) > 59 || utc.getTime() - 8 * 3600_000 > at + 300_000) return failure('article_preview_invalid_time');
    const day = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    timePrecision = h === undefined ? 'date' : 'minute';
    publishedAt = h === undefined ? day : `${day}T${h.padStart(2, '0')}:${minute}:00+08:00`;
  }
  const bodyBlocks = [], images = [];
  const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TR']);
  const excluded = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT']);
  let buffer = '', characters = 0, truncated = false, unreadMedia = false, folded = false, imageMissing = false;
  const flush = () => {
    const value = clean(buffer); buffer = '';
    if (!value) return;
    if (characters + value.length > 100_000 || bodyBlocks.length >= 2000) { truncated = true; return; }
    characters += value.length;
    bodyBlocks.push({type: 'text', text: value});
  };
  const imageUrl = node => {
    for (const value of [node.getAttribute?.('data-src'), node.currentSrc, node.getAttribute?.('src')]) {
      if (!value) continue;
      try {
        const url = new URL(value, document.URL);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) { url.hash = ''; return url.href; }
      } catch { /* An unobserved/invalid image is never invented. */ }
    }
    return '';
  };
  const walk = node => {
    if (!node || hidden(node)) return;
    if (node.nodeType === 3) { buffer += node.textContent ?? ''; return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName?.toUpperCase();
    if ((tag === 'BUTTON' || node.getAttribute?.('role') === 'button') && /^(?:阅读全文|展开全文|继续阅读|展开更多)$/u.test(nodeText(node))) folded = true;
    if (excluded.has(tag)) return;
    if (['IFRAME', 'VIDEO', 'AUDIO', 'CANVAS', 'MP-COMMON', 'MPVOICE', 'MP-MINIPROGRAM'].includes(tag)
      || (tag === 'SECTION' && String(node.getAttribute?.('class') ?? '').split(/\s+/u).includes('channels_iframe_wrp'))) { unreadMedia = true; return; }
    if (tag === 'IMG') {
      flush();
      const url = imageUrl(node);
      if (!url) { imageMissing = true; return; }
      if (images.length >= 100 || bodyBlocks.length >= 2000) { truncated = true; return; }
      const alt = clean(node.getAttribute?.('alt')).slice(0, 1000);
      images.push({url, alt, order: images.length, source: 'page_dom', stored: false});
      bodyBlocks.push({type: 'image', url, alt}); return;
    }
    if (tag === 'BR' || blocks.has(tag)) flush();
    for (const child of node.childNodes ?? []) walk(child);
    if (blocks.has(tag)) flush();
  };
  walk(root); flush();
  const content = bodyBlocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
  if (!content && !images.length) return failure('article_preview_body_empty', true);
  if (folded) return failure('article_preview_body_folded');
  const statRoots = [...document.querySelectorAll('#js_read_area, #js_like_area, #js_share_area, #js_recommend_area, #js_article_bottom_bar, .rich_media_tool')]
    .filter(node => visible(node) && !root.contains?.(node));
  const statTexts = new Set();
  const collectStats = node => {
    if (!visible(node)) return;
    const value = nodeText(node);
    if (value.length <= 80) statTexts.add(value);
    for (const child of node.children ?? []) collectStats(child);
  };
  statRoots.forEach(collectStats);
  const metrics = Object.fromEntries(['read', 'like', 'share', 'recommend'].map(key => {
    const labels = {read: '阅读', like: '点赞|赞', share: '分享|转发', recommend: '推荐'}[key];
    const pattern = new RegExp(`^(?:${labels})\\s*(\\d+(?:\\.\\d+)?(?:万|亿)?\\+?)$`, 'u');
    const raw = [...statTexts].map(value => value.match(pattern)?.[1]).find(Boolean) ?? '';
    const count = raw.match(/^(\d+(?:\.\d+)?)(万|亿)?(\+)?$/u);
    const value = count ? Number(count[1]) * ({万: 10000, 亿: 100000000}[count[2]] ?? 1) : null;
    const known = Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
    return [key, {value: known ? value : null, raw, precision: !known ? 'unknown' : count[3] ? 'lower_bound' : count[2] ? 'rounded' : 'displayed_integer', source: 'page_dom', capturedAt}];
  }));
  const bodyReason = truncated ? 'content_limit' : imageMissing ? 'image_url_unavailable' : unreadMedia ? 'embedded_media_unread' : '';
  const locationNode = first('#js_ip_wording_wrp');
  const location = clean(locationNode?.getAttribute?.('aria-label')) || nodeText(locationNode) || null;
  return {ok: true, article: {url: wanted, source: 'page_dom', capturedAt, timeSource: 'page_dom', title, account, author,
    publishedAt, timeLabel, timePrecision, location,
    content, contentType: !content && images.length ? 'image' : 'article', bodyStatus: bodyReason ? 'partial' : 'complete', bodyReason,
    evidence: {bodyEndObserved: !bodyReason, originalImagesCaptured: false, domContentObserved: true,
      domReadyState: document.readyState, imageUrlsObserved: images.length, selectorAcceptance: 'live_dom_20261109'},
    images, bodyBlocks, metrics}};
}
