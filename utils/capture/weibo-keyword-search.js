/**
 * 微博搜索页采集 — DOM 解析方案
 *
 * 已验证的微博搜索页 DOM 结构 (2025年):
 *
 * .card-wrap[mid="xxx"]
 *   └─ .card .card-feed
 *       ├─ .avator > a > img                          — 头像
 *       ├─ .content
 *       │   ├─ .info > a.name                          — 博主名 (textContent)
 *       │   ├─ .from > a:first-child                   — 时间
 *       │   ├─ .from > a (来自xxx)                      — 来源
 *       │   └─ p.txt[node-type="feed_list_content"]    — 正文
 *       └─ .card-act (或 toolbar)
 *           ├─ 转发: <a> / <li> 内含数字
 *           ├─ 评论: <a> / <li> 内含数字
 *           └─ 赞: <button class="woo-like-main"><span>32</span></button>
 *
 * 支持：s.weibo.com/weibo?q=xxx, s.weibo.com/realtime?q=xxx
 */

import { SYNC_TYPE } from '../constants.js';

/**
 * 从微博搜索页 URL 提取搜索关键词
 */
function extractKeyword(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('q') || u.searchParams.get('keyword') || '';
  } catch {
    return '';
  }
}

/**
 * 解析互动数字
 */
function parseCount(text) {
  if (!text) return 0;
  const normalized = String(text || '').replace(/,/g, '').trim();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(万|w|W|千|k|K)?/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = match[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(value * 10000);
  if (unit === '千' || unit === 'k' || unit === 'K') return Math.round(value * 1000);
  return Math.round(value);
}

function normalizeUrl(url, baseUrl = window.location.href) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function decodeHtmlEntities(value) {
  const raw = String(value || '').trim();
  if (!raw || !raw.includes('&')) return raw;
  const textarea = document.createElement('textarea');
  textarea.innerHTML = raw;
  return textarea.value.trim();
}

function safeDecodeURIComponent(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function unescapeUrlLikeText(value) {
  return String(value || '')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .trim();
}

function normalizeWeiboContentText(value) {
  const raw = decodeHtmlEntities(String(value || ''));
  if (!raw.trim()) return '';
  const container = document.createElement('div');
  container.innerHTML = raw;
  const text = (container.textContent || raw)
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function pickLongestText(values = []) {
  return values
    .map((value) => normalizeWeiboContentText(value))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || '';
}

function readUrlFromSrcset(srcset) {
  const candidates = String(srcset || '')
    .split(',')
    .map(part => part.trim().split(/\s+/)[0])
    .filter(Boolean);
  return candidates[candidates.length - 1] || '';
}

function readUrlFromCssImage(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/url\((['"]?)(.*?)\1\)/i);
  return match ? match[2] : '';
}

function isWeiboImageHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'sinaimg.cn' ||
    host.endsWith('.sinaimg.cn') ||
    host === 'sinaimg.com' ||
    host.endsWith('.sinaimg.com') ||
    host === 'weiboimg.cn' ||
    host.endsWith('.weiboimg.cn') ||
    host === 'weiboimg.com' ||
    host.endsWith('.weiboimg.com')
  );
}

function normalizeWeiboImageUrl(url, baseUrl = window.location.href) {
  const decoded = unescapeUrlLikeText(
    safeDecodeURIComponent(decodeHtmlEntities(url)),
  );
  let normalized = normalizeUrl(decoded, baseUrl);
  if (!normalized) return '';
  if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:\/\//i, 'https://');
  }

  const lowered = normalized.toLowerCase();
  if (
    lowered.startsWith('data:') ||
    lowered === 'about:blank' ||
    lowered.includes('/avatar/') ||
    /(?:blank|transparent|loading|placeholder|spacer|grey|gray)/.test(lowered)
  ) {
    return '';
  }

  try {
    const parsed = new URL(normalized);
    if (!isWeiboImageHost(parsed.hostname)) {
      return '';
    }
  } catch {
    return '';
  }

  return normalized.replace(
    /\/(?:thumb\d+|orj\d+|mw\d+|wap\d+|small|bmiddle|thumbnail|square)\//i,
    '/large/',
  );
}

function extractWeiboImageUrlsFromText(text, baseUrl = window.location.href) {
  const raw = unescapeUrlLikeText(decodeHtmlEntities(text));
  const decoded = unescapeUrlLikeText(safeDecodeURIComponent(raw));
  const sources = [raw, decoded].filter(Boolean);
  const candidates = [];

  sources.forEach((source) => {
    source.replace(
      /(?:https?:)?\/\/[^"'<>\s),\\]+?(?:sinaimg|weibo)[^"'<>\s),\\]*/gi,
      (match) => {
        candidates.push(match);
        return match;
      },
    );

    source.replace(
      /(?:pic_src|pic_url|url|src|image|image_url)=([^&"'<>\\\s]+)/gi,
      (match, value) => {
        candidates.push(safeDecodeURIComponent(value));
        return match;
      },
    );

    source.replace(/pic_ids?=([^&"'<>\\\s]+)/gi, (match, value) => {
      safeDecodeURIComponent(value)
        .split(/[,|]/)
        .map((picId) => picId.trim())
        .filter((picId) => /^[a-z0-9]{8,}$/i.test(picId))
        .forEach((picId) => {
          candidates.push(`https://wx1.sinaimg.cn/large/${picId}.jpg`);
        });
      return match;
    });
  });

  return Array.from(
    new Set(
      candidates
        .map((candidate) => normalizeWeiboImageUrl(candidate, baseUrl))
        .filter(Boolean),
    ),
  );
}

function readImageUrlFromElement(img, baseUrl) {
  const candidates = [
    img.getAttribute?.('data-src'),
    img.getAttribute?.('data-original'),
    img.getAttribute?.('data-lazy-src'),
    img.getAttribute?.('data-url'),
    img.getAttribute?.('data-bmiddle'),
    img.getAttribute?.('src'),
    img.currentSrc,
    img.src,
    readUrlFromSrcset(img.getAttribute?.('srcset')),
    readUrlFromCssImage(img.getAttribute?.('style')),
    readUrlFromCssImage(img.style?.backgroundImage),
    img.closest?.('a')?.getAttribute?.('href'),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeWeiboImageUrl(candidate, baseUrl);
    if (normalized) return normalized;
  }
  const attributeText = Array.from(img.attributes || [])
    .map((attr) => `${attr.name}=${attr.value}`)
    .join('&');
  return extractWeiboImageUrlsFromText(attributeText, baseUrl)[0] || '';
}

function collectImageUrlsFromElementAttributes(root, baseUrl) {
  const candidates = [];
  root.querySelectorAll?.('*').forEach((el) => {
    Array.from(el.attributes || []).forEach((attr) => {
      const value = String(attr.value || '').trim();
      if (!value) return;
      candidates.push(normalizeWeiboImageUrl(value, baseUrl));
      if (
        /(?:src|href|style|action-data|data|pic|image|url)/i.test(attr.name) ||
        /(?:sinaimg|pic_id|pic_src|pic_url|background|url\()/i.test(value)
      ) {
        candidates.push(...extractWeiboImageUrlsFromText(value, baseUrl));
        if (attr.name === 'style') {
          candidates.push(normalizeWeiboImageUrl(readUrlFromCssImage(value), baseUrl));
        }
      }
    });
  });
  return candidates.filter(Boolean);
}

function collectWeiboImageUrls(cardWrap, pageUrl) {
  const mediaRoots = [
    cardWrap.querySelector('[node-type="feed_list_media_prev"]'),
    cardWrap.querySelector('[node-type="feed_list_media_disp"]'),
    cardWrap.querySelector('.media'),
    cardWrap.querySelector('.media-piclist'),
    cardWrap,
  ].filter(Boolean);
  const candidates = [];

  mediaRoots.forEach((root) => {
    root
      .querySelectorAll?.(
        'img, [style*="background"], a[href], [action-data], [data-src], [data-original], [data-lazy-src], [data-url]',
      )
      .forEach((el) => {
        if (el.tagName?.toLowerCase() === 'img') {
          candidates.push(readImageUrlFromElement(el, pageUrl));
        }
        candidates.push(
          normalizeWeiboImageUrl(el.getAttribute?.('href'), pageUrl),
          normalizeWeiboImageUrl(el.getAttribute?.('src'), pageUrl),
          normalizeWeiboImageUrl(el.getAttribute?.('data-src'), pageUrl),
          normalizeWeiboImageUrl(el.getAttribute?.('data-original'), pageUrl),
          normalizeWeiboImageUrl(el.getAttribute?.('data-lazy-src'), pageUrl),
          normalizeWeiboImageUrl(el.getAttribute?.('data-url'), pageUrl),
          normalizeWeiboImageUrl(readUrlFromCssImage(el.getAttribute?.('style')), pageUrl),
          normalizeWeiboImageUrl(readUrlFromCssImage(el.style?.backgroundImage), pageUrl),
        );
      });
    candidates.push(...collectImageUrlsFromElementAttributes(root, pageUrl));
  });

  candidates.push(...extractWeiboImageUrlsFromText(cardWrap.innerHTML || '', pageUrl));

  return Array.from(new Set(candidates.filter(Boolean)));
}

function hasWeiboMediaHint(cardWrap) {
  return Boolean(
    cardWrap.querySelector(
      [
        '[node-type*="media"]',
        '.media',
        '.media-piclist',
        '[action-type*="pic"]',
        '[action-data*="pic"]',
        'img[src*="sinaimg"]',
        'img[data-src*="sinaimg"]',
        'a[href*="sinaimg"]',
      ].join(', '),
    ),
  );
}

function collectImageUrlsFromObject(value, baseUrl, depth = 0, keyHint = '') {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const directUrls = extractWeiboImageUrlsFromText(value, baseUrl);
    const normalized = normalizeWeiboImageUrl(value, baseUrl);
    const picIdUrls =
      /pic/i.test(keyHint)
        ? value
            .split(/[,|]/)
            .map((picId) => picId.trim())
            .filter((picId) => /^[a-z0-9]{8,}$/i.test(picId))
            .map((picId) => `https://wx1.sinaimg.cn/large/${picId}.jpg`)
        : [];
    return Array.from(
      new Set(
        [normalized, ...directUrls, ...picIdUrls]
          .map((candidate) => normalizeWeiboImageUrl(candidate, baseUrl))
          .filter(Boolean),
      ),
    );
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectImageUrlsFromObject(item, baseUrl, depth + 1, keyHint));
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) =>
      collectImageUrlsFromObject(child, baseUrl, depth + 1, key),
    );
  }
  return [];
}

function unwrapWeiboApiPayload(json) {
  if (!json || typeof json !== 'object') return {};
  if (json.data && typeof json.data === 'object') return json.data;
  return json;
}

function extractWeiboStatusContent(status) {
  if (!status || typeof status !== 'object') return '';
  return pickLongestText([
    status.longText?.longTextContent,
    status.longTextContent,
    status.text_raw,
    status.textRaw,
    status.text,
    status.status_title,
    status.title?.text,
  ]);
}

function shouldFetchLongText(status, content = '') {
  if (!status || typeof status !== 'object') return false;
  if (status.isLongText || status.is_long_text || status.longText) return true;
  const normalizedContent = String(content || '').trim();
  return /展开全文|全文|…|\.{3}$/.test(normalizedContent);
}

function readWeiboMetric(status, keys = []) {
  if (!status || typeof status !== 'object') return null;
  for (const key of keys) {
    const value = status[key];
    if (value === undefined || value === null || value === '') continue;
    const normalized = parseCount(value);
    if (Number.isFinite(normalized)) return normalized;
  }
  return null;
}

async function fetchWeiboJson(url) {
  const response = await fetch(url, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchWeiboLongTextContent(mid) {
  const normalizedMid = String(mid || '').trim();
  if (!normalizedMid) return '';

  const urls = [
    `https://weibo.com/ajax/statuses/longtext?id=${encodeURIComponent(normalizedMid)}`,
    `https://weibo.com/ajax/statuses/longtext?mid=${encodeURIComponent(normalizedMid)}`,
  ];

  for (const url of urls) {
    try {
      const json = unwrapWeiboApiPayload(await fetchWeiboJson(url));
      const content = extractWeiboStatusContent(json);
      if (content) return content;
    } catch (error) {
      console.debug('[Weibo] Long text lookup failed:', error);
    }
  }

  return '';
}

async function fetchWeiboStatusDetails(mid, baseUrl = window.location.href) {
  const normalizedMid = String(mid || '').trim();
  if (!normalizedMid) {
    return { content: '', imageUrls: [] };
  }

  const urls = [
    `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(normalizedMid)}&locale=zh-CN`,
    `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(normalizedMid)}`,
  ];

  for (const url of urls) {
    try {
      const json = unwrapWeiboApiPayload(await fetchWeiboJson(url));
      const imageUrls = Array.from(new Set(collectImageUrlsFromObject(json, baseUrl)));
      const statusContent = extractWeiboStatusContent(json);
      const longTextContent = shouldFetchLongText(json, statusContent)
        ? await fetchWeiboLongTextContent(normalizedMid)
        : '';
      const content = pickLongestText([
        longTextContent,
        statusContent,
      ]);
      return {
        content,
        imageUrls,
        metrics: {
          shares: readWeiboMetric(json, ['reposts_count', 'repostsCount', 'repost_count', 'repostCount', 'shares', 'shareCount']),
          comments: readWeiboMetric(json, ['comments_count', 'commentsCount', 'comment_count', 'commentCount', 'comments']),
          likes: readWeiboMetric(json, ['attitudes_count', 'attitudesCount', 'like_count', 'likeCount', 'likes']),
        },
      };
    } catch (error) {
      console.debug('[Weibo] Detail lookup failed:', error);
    }
  }

  return {
    content: await fetchWeiboLongTextContent(normalizedMid),
    imageUrls: [],
    metrics: {},
  };
}

async function hydrateWeiboStatusDetails(posts, { onProgress = null, limit = 20 } = {}) {
  const candidates = posts
    .filter((post) => {
      return post && post.noteId;
    })
    .slice(0, Math.max(0, limit));

  for (let index = 0; index < candidates.length; index += 1) {
    const post = candidates[index];
    if (onProgress) {
      onProgress({
        phase: 'detail_hydration',
        message: `正在补充微博正文和图片 (${index + 1}/${candidates.length})...`,
        current: index + 1,
        total: candidates.length,
      });
    }
    const detail = await fetchWeiboStatusDetails(post.noteId, post.url || window.location.href);
    const metrics = detail.metrics && typeof detail.metrics === 'object' ? detail.metrics : {};
    if (metrics.shares !== null && metrics.shares !== undefined) {
      post.shares = metrics.shares;
      post.shareCount = metrics.shares;
      post.reposts = metrics.shares;
      post.repostsCount = metrics.shares;
    }
    if (metrics.comments !== null && metrics.comments !== undefined) {
      post.comments = metrics.comments;
      post.commentsCount = metrics.comments;
      post.commentCount = metrics.comments;
    }
    if (metrics.likes !== null && metrics.likes !== undefined) {
      post.likes = metrics.likes;
      post.likeCount = metrics.likes;
    }

    const fullContent = normalizeWeiboContentText(detail.content || '');
    if (fullContent && fullContent.length >= String(post.content || '').length) {
      post.content = fullContent;
      post.noteContent = fullContent;
      post.fullContent = fullContent;
      post.body = fullContent;
      post.title = fullContent.slice(0, 30) || post.title;
      post.noteTitle = post.title;
    }

    const imageUrls =
      detail.imageUrls.length > 0
        ? detail.imageUrls
        : post.mediaHint === true && (!Array.isArray(post.imageUrls) || post.imageUrls.length === 0)
          ? []
          : post.imageUrls || [];
    if (imageUrls.length > 0) {
      post.imageUrls = Array.from(new Set([...(post.imageUrls || []), ...imageUrls]));
      post.coverUrl = imageUrls[0];
      post.coverImageUrl = imageUrls[0];
      post.noteType = 'image';
      post.type = 'image';
    }
    await wait(120 + Math.random() * 180);
  }

  return posts;
}

/**
 * 找到所有微博卡片
 */
function findAllCards(root = document) {
  // 优先精确匹配
  let cards = root.querySelectorAll('.card-wrap[mid]');
  if (cards.length > 0) {
    console.log(`[Weibo] Found ${cards.length} cards with .card-wrap[mid]`);
    return Array.from(cards);
  }

  cards = root.querySelectorAll('.card-wrap');
  const validCards = Array.from(cards).filter(card => {
    return card.querySelector('.txt') || card.querySelector('.content') || card.querySelector('a.name');
  });
  if (validCards.length > 0) {
    console.log(`[Weibo] Found ${validCards.length} filtered .card-wrap`);
    return validCards;
  }

  console.warn('[Weibo] No cards found');
  return [];
}

/**
 * 从单个 .card-wrap 元素提取微博数据
 */
function extractCardData(cardWrap, idx, pageUrl = window.location.href) {
  try {
    const mid = cardWrap.getAttribute('mid') || '';

    // ---- 博主信息 ----
    // <a class="name" href="//weibo.com/u/xxx">博主名</a>
    const nameEl = cardWrap.querySelector('a.name') ||
                   cardWrap.querySelector('.info a') ||
                   cardWrap.querySelector('.head-info a');
    const authorName = nameEl ? nameEl.textContent.trim() : '';
    const authorLink = nameEl?.getAttribute?.('href') || nameEl?.href || '';
    const bloggerProfileUrl = normalizeUrl(authorLink, pageUrl);

    // 头像
    const avatarImg = cardWrap.querySelector('.avator img') ||
                      cardWrap.querySelector('.head img') ||
                      cardWrap.querySelector('img[alt]');
    const authorAvatar = normalizeUrl(
      avatarImg?.getAttribute?.('src') || avatarImg?.src || '',
      pageUrl,
    );

    // ---- 正文内容 ----
    // 优先取展开版
    const fullTextEl = cardWrap.querySelector('p[node-type="feed_list_content_full"]');
    const shortTextEl = cardWrap.querySelector('p[node-type="feed_list_content"]') ||
                        cardWrap.querySelector('p.txt') ||
                        cardWrap.querySelector('.txt');

    let contentText = '';
    if (fullTextEl && fullTextEl.textContent.trim()) {
      contentText = fullTextEl.textContent.trim();
    } else if (shortTextEl) {
      contentText = shortTextEl.textContent.trim();
    }
    // 清理多余空白
    contentText = normalizeWeiboContentText(contentText);

    if (!contentText && !authorName) return null;

    // ---- 时间和来源 ----
    const fromEl = cardWrap.querySelector('.from');
    let publishTime = '';
    let source = '';
    if (fromEl) {
      const timeLink = fromEl.querySelector('a:first-child');
      publishTime = timeLink?.textContent?.trim() || '';
      // 来源可能是第二个 <a> 或者 <a rel="nofollow">
      const allLinks = fromEl.querySelectorAll('a');
      if (allLinks.length >= 2) {
        source = allLinks[1]?.textContent?.trim() || '';
      }
    }

    // ---- IP 属地 ----
    // 微博属地常在 .from 区域末尾的文本节点(如「2小时前 来自 微博 广东」),用省级白名单匹配
    let region = '';
    if (fromEl) {
      const REGIONS = [
        '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江',
        '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南',
        '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾',
        '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
      ];
      const fromText = (fromEl.textContent || '').replace(/\s+/g, ' ');
      for (const r of REGIONS) {
        if (fromText.includes(r)) { region = r; break; }
      }
    }

    // ---- 互动数据 ----
    // 微博新版本可能用多种结构：
    // 方案A: .card-act ul li（经典版）
    // 方案B: toolbar 里 button.woo-like-main（新版）
    // 方案C: 直接文本匹配
    let shares = 0, commentsCount = 0, likes = 0;

    // 先尝试 .card-act ul li（经典版）
    const actItems = cardWrap.querySelectorAll('.card-act ul li');
    if (actItems.length >= 3) {
      shares = parseCount(actItems[0]?.textContent || '');
      commentsCount = parseCount(actItems[1]?.textContent || '');
      likes = parseCount(actItems[2]?.textContent || '');
    } else {
      // 新版：找所有可能的互动容器
      const allText = (cardWrap.querySelector('.card-act') || cardWrap).textContent || '';

      // 转发数
      const repostMatch = allText.match(/转发\s*([0-9.,]+(?:\s*[万wW千kK])?)/);
      shares = repostMatch ? parseCount(repostMatch[1]) : 0;
      if (!repostMatch) {
        // 经典版：纯数字在 li 或 a 里
        const repostEl = cardWrap.querySelector('[action-type="feed_list_forward"]');
        if (repostEl) shares = parseCount(repostEl.textContent);
      }

      // 评论数
      const commentMatch = allText.match(/评论\s*([0-9.,]+(?:\s*[万wW千kK])?)/);
      commentsCount = commentMatch ? parseCount(commentMatch[1]) : 0;
      if (!commentMatch) {
        const commentEl = cardWrap.querySelector('[action-type="feed_list_comment"]');
        if (commentEl) commentsCount = parseCount(commentEl.textContent);
      }

      // 点赞数 — 新版用 button.woo-like-main
      const likeBtn = cardWrap.querySelector('button.woo-like-main, .woo-like-main');
      if (likeBtn) {
        const likeSpan = likeBtn.querySelector('span');
        likes = likeSpan ? parseCount(likeSpan.textContent) : parseCount(likeBtn.textContent);
      } else {
        const likeMatch = allText.match(/赞\s*([0-9.,]+(?:\s*[万wW千kK])?)/);
        likes = likeMatch ? parseCount(likeMatch[1]) : 0;
      }
    }

    // ---- 图片 ----
    const mediaHint = hasWeiboMediaHint(cardWrap);
    const imageUrls = collectWeiboImageUrls(cardWrap, pageUrl);

    // ---- 话题标签 ----
    const topicEls = cardWrap.querySelectorAll('a[href*="topic"], .a_topic');
    const tags = Array.from(topicEls)
      .map(a => a.textContent.replace(/#/g, '').trim())
      .filter(Boolean);

    // ---- 转发微博判断 ----
    const isRetweet = !!cardWrap.querySelector('[node-type="feed_list_forwardContent"]');

    // ---- 微博链接 ----
    const fromLink = fromEl?.querySelector('a:first-child');
    let weiboUrl = normalizeUrl(
      fromLink?.getAttribute?.('href') || fromLink?.href || '',
      pageUrl,
    );
    if (!weiboUrl && mid) weiboUrl = `https://weibo.com/detail/${mid}`;
    const title = contentText.slice(0, 30) || `微博 ${mid || idx + 1}`;

    return {
      platform: 'weibo',
      noteId: mid || `weibo_${Date.now()}_${idx}`,
      noteType: imageUrls.length ? 'image' : 'text',
      type: imageUrls.length ? 'image' : 'text',
      title,
      noteTitle: title,
      content: contentText,
      noteContent: contentText,
      fullContent: contentText,
      body: contentText,
      url: weiboUrl,
      noteUrl: weiboUrl,
      detailPageUrl: weiboUrl,
      coverUrl: imageUrls[0] || '',
      coverImageUrl: imageUrls[0] || '',
      imageUrls,
      videoUrl: '',
      videoUrls: [],
      videoDuration: '',
      publishTime,
      publishDate: publishTime,
      publishDateRaw: publishTime,
      tags,
      likes,
      comments: commentsCount,
      commentsCount,
      collects: 0,
      shares,
      authorId: '',
      author: authorName || '作者未知',
      authorName,
      authorAvatar,
      avatarUrl: authorAvatar,
      authorFans: 0,
      authorFollowing: 0,
      bloggerLikedCollected: 0,
      bloggerProfileUrl,
      authorUrl: bloggerProfileUrl,
      bloggerAccountType: 'personal',
      source,
      region,
      isRetweet,
      mediaHint,
      captureTimestamp: Date.now(),
    };
  } catch (err) {
    console.warn(`[Weibo] Error extracting card ${idx}:`, err);
    return null;
  }
}

/**
 * 滚动页面加载更多内容
 */
async function scrollToLoadMore(maxScrolls = 3, onProgress = null) {
  let previousHeight = document.body.scrollHeight;
  for (let i = 0; i < maxScrolls; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
    const newHeight = document.body.scrollHeight;
    if (newHeight === previousHeight) break;
    previousHeight = newHeight;
    if (onProgress) {
      onProgress({ phase: 'scrolling', message: `滚动加载中 (${i + 1}/${maxScrolls})...` });
    }
  }
}

/**
 * 点击所有「展开全文」按钮
 */
function expandAllFullTexts() {
  const expandButtons = document.querySelectorAll('a[action-type="fl_unfold"]');
  let clicked = 0;
  expandButtons.forEach(btn => {
    if (btn.textContent.includes('展开')) {
      try { btn.click(); clicked++; } catch (e) { /* ignore */ }
    }
  });
  if (clicked > 0) console.log(`[Weibo] Expanded ${clicked} full texts`);
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  return rounded > 0 ? rounded : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  return rounded >= 0 ? rounded : fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCurrentPageNumber(url) {
  try {
    const parsed = new URL(url);
    return normalizePositiveInteger(parsed.searchParams.get('page'), 1);
  } catch {
    return 1;
  }
}

function buildWeiboPageUrl(baseUrl, pageNumber) {
  try {
    const parsed = new URL(baseUrl);
    parsed.searchParams.set('page', String(pageNumber));
    return parsed.toString();
  } catch {
    const separator = String(baseUrl || '').includes('?') ? '&' : '?';
    return `${baseUrl}${separator}page=${pageNumber}`;
  }
}

async function fetchPageDocument(pageUrl) {
  const response = await fetch(pageUrl, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`微博第 ${getCurrentPageNumber(pageUrl)} 页请求失败：HTTP ${response.status}`);
  }
  const html = await response.text();
  if (/请完成验证|验证码|访问频繁|login|登录/.test(html) && !/card-wrap/.test(html)) {
    throw new Error('微博返回登录、验证或风控页面，已停止翻页');
  }
  return new DOMParser().parseFromString(html, 'text/html');
}

function collectPostsFromRoot(root, pageUrl, pageIndex = 1) {
  const cards = findAllCards(root);
  const posts = [];
  cards.forEach((card, idx) => {
    const post = extractCardData(card, idx + pageIndex * 1000, pageUrl);
    if (post) posts.push(post);
  });
  return {
    cardsFound: cards.length,
    posts,
  };
}

function dedupePosts(posts = []) {
  const seen = new Set();
  return posts.filter((post) => {
    const key = String(post.noteId || post.url || `${post.author}:${post.content}`).trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 主采集函数
 */
export async function captureWeiboKeywordNotes(options = {}) {
  const {
    onProgress = null,
    maxScrolls = 1,
    maxDetectedItems = null,
    maxItems = null,
    minLikes = 0,
    maxPages = null,
  } = options;
  const captureStartedAt = new Date().toISOString();
  const normalizedMaxDetectedItems = normalizePositiveInteger(
    maxDetectedItems ?? maxItems,
    100,
  );
  const normalizedMinLikes = normalizeNonNegativeInteger(minLikes, 0);
  const normalizedMaxPages = Math.min(
    normalizePositiveInteger(
      maxPages,
      Math.max(1, Math.ceil(normalizedMaxDetectedItems / 10)),
    ),
    20,
  );

  const keyword = extractKeyword(window.location.href);
  if (!keyword) {
    return {
      ok: false,
      platform: 'weibo',
      type: SYNC_TYPE.KEYWORD_NOTES,
      data: null,
      meta: {
        pageType: 'search_results',
        captureStartedAt,
        captureFinishedAt: new Date().toISOString(),
        sourceUrl: window.location.href,
      },
      error: { code: 'NO_KEYWORD', message: '无法从 URL 中提取搜索关键词' },
    };
  }

  if (onProgress) {
    onProgress({
      phase: 'start',
      message: `开始采集微博搜索「${keyword}」...`,
      keyword,
      maxDetectedItems: normalizedMaxDetectedItems,
      minLikes: normalizedMinLikes,
      maxPages: normalizedMaxPages,
    });
  }

  // 1. 先展开全文
  expandAllFullTexts();
  await new Promise(r => setTimeout(r, 300));

  // 2. 滚动加载更多
  await scrollToLoadMore(maxScrolls, onProgress);

  // 3. 再次展开
  expandAllFullTexts();
  await new Promise(r => setTimeout(r, 300));

  // 4. 提取数据
  if (onProgress) {
    onProgress({ phase: 'extracting', message: '正在提取微博数据...' });
  }

  const cards = findAllCards(document);
  console.log(`[Weibo] Total cards: ${cards.length}`);

  // 调试：输出第一个卡片的关键信息
  if (cards.length > 0) {
    const firstCard = cards[0];
    console.log('[Weibo] First card mid:', firstCard.getAttribute('mid'));
    console.log('[Weibo] First card a.name:', firstCard.querySelector('a.name')?.textContent);
    console.log('[Weibo] First card p.txt:', firstCard.querySelector('p.txt')?.textContent?.slice(0, 50));
    console.log('[Weibo] First card .card-act:', firstCard.querySelector('.card-act')?.textContent?.trim()?.slice(0, 80));
    console.log('[Weibo] First card woo-like:', firstCard.querySelector('.woo-like-main')?.textContent);
  }

  const firstPage = collectPostsFromRoot(document, window.location.href, 1);
  const allPosts = [...firstPage.posts];
  let totalCardsFound = firstPage.cardsFound;
  let pagesFetched = 1;
  const startPageNumber = getCurrentPageNumber(window.location.href);

  for (let offset = 1; offset < normalizedMaxPages; offset += 1) {
    const currentUniqueCount = dedupePosts(allPosts)
      .filter((post) => Number(post.likes || 0) >= normalizedMinLikes)
      .length;
    if (currentUniqueCount >= normalizedMaxDetectedItems) break;

    const pageNumber = startPageNumber + offset;
    const pageUrl = buildWeiboPageUrl(window.location.href, pageNumber);
    if (onProgress) {
      onProgress({
        phase: 'paging',
        message: `正在采集微博第 ${pageNumber} 页...`,
        keyword,
        pageNumber,
        detectedCount: currentUniqueCount,
        maxDetectedItems: normalizedMaxDetectedItems,
      });
    }

    try {
      await wait(600 + Math.random() * 500);
      const pageDocument = await fetchPageDocument(pageUrl);
      const pageResult = collectPostsFromRoot(pageDocument, pageUrl, pageNumber);
      pagesFetched += 1;
      totalCardsFound += pageResult.cardsFound;
      if (pageResult.posts.length === 0) break;
      allPosts.push(...pageResult.posts);
    } catch (error) {
      console.warn('[Weibo] Stop paging:', error);
      break;
    }
  }

  await hydrateWeiboStatusDetails(allPosts, {
    onProgress,
    limit: normalizedMaxDetectedItems,
  });

  const captureFinishedAt = new Date().toISOString();

  const allUniquePosts = dedupePosts(allPosts);
  const filteredPosts = allUniquePosts.filter(
    (post) => Number(post.likes || 0) >= normalizedMinLikes,
  );
  const uniquePosts = filteredPosts.slice(0, normalizedMaxDetectedItems);

  if (allUniquePosts.length === 0) {
    return {
      ok: false,
      platform: 'weibo',
      type: SYNC_TYPE.KEYWORD_NOTES,
      data: null,
      meta: { pageType: 'search_results', captureStartedAt, captureFinishedAt, sourceUrl: window.location.href },
      error: { code: 'NO_RESULTS', message: '未采集到搜索结果。请确认已登录微博且页面有搜索结果。' },
    };
  }

  if (onProgress) {
    onProgress({ phase: 'done', count: uniquePosts.length, message: `采集完成，共 ${uniquePosts.length} 条微博` });
  }

  return {
    ok: true,
    platform: 'weibo',
    type: SYNC_TYPE.KEYWORD_NOTES,
    data: {
      keyword,
      searchUrl: window.location.href,
      totalCount: uniquePosts.length,
      rawTotalCount: allUniquePosts.length,
      minLikes: normalizedMinLikes,
      minInteraction: normalizedMinLikes,
      filteredCount: uniquePosts.length,
      filteredBeforeLimitCount: filteredPosts.length,
      sortDimension: 'likes',
      sortDimensionLabel: '点赞',
      sortDimensionSource: 'weibo_default',
      maxDetectedItems: normalizedMaxDetectedItems,
      maxPages: normalizedMaxPages,
      items: uniquePosts,
      captureTimestamp: Date.now(),
    },
    meta: {
      pageType: 'search_results',
      captureStartedAt,
      captureFinishedAt,
      sourceUrl: window.location.href,
      cardsFound: totalCardsFound,
      pagesFetched,
    },
  };
}
