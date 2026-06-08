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
  const cleaned = text.replace(/[^\d]/g, '');
  return parseInt(cleaned, 10) || 0;
}

/**
 * 找到所有微博卡片
 */
function findAllCards() {
  // 优先精确匹配
  let cards = document.querySelectorAll('.card-wrap[mid]');
  if (cards.length > 0) {
    console.log(`[Weibo] Found ${cards.length} cards with .card-wrap[mid]`);
    return Array.from(cards);
  }

  cards = document.querySelectorAll('.card-wrap');
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
function extractCardData(cardWrap, idx) {
  try {
    const mid = cardWrap.getAttribute('mid') || '';

    // ---- 博主信息 ----
    // <a class="name" href="//weibo.com/u/xxx">博主名</a>
    const nameEl = cardWrap.querySelector('a.name') ||
                   cardWrap.querySelector('.info a') ||
                   cardWrap.querySelector('.head-info a');
    const authorName = nameEl ? nameEl.textContent.trim() : '';
    const authorLink = nameEl?.href || '';
    const bloggerProfileUrl = authorLink
      ? (authorLink.startsWith('//') ? 'https:' + authorLink : authorLink)
      : '';

    // 头像
    const avatarImg = cardWrap.querySelector('.avator img') ||
                      cardWrap.querySelector('.head img') ||
                      cardWrap.querySelector('img[alt]');
    const authorAvatar = avatarImg?.src || '';

    // ---- 正文内容 ----
    // 优先取展开版
    const fullTextEl = cardWrap.querySelector('p[node-type="feed_list_content_full"]');
    const shortTextEl = cardWrap.querySelector('p[node-type="feed_list_content"]') ||
                        cardWrap.querySelector('p.txt') ||
                        cardWrap.querySelector('.txt');

    let contentText = '';
    if (fullTextEl && fullTextEl.style.display !== 'none') {
      contentText = fullTextEl.textContent.trim();
    } else if (shortTextEl) {
      contentText = shortTextEl.textContent.trim();
    }
    // 清理多余空白
    contentText = contentText.replace(/\s+/g, ' ').trim();

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
      const repostMatch = allText.match(/转发\s*(\d+)/);
      shares = repostMatch ? parseInt(repostMatch[1], 10) : 0;
      if (!repostMatch) {
        // 经典版：纯数字在 li 或 a 里
        const repostEl = cardWrap.querySelector('[action-type="feed_list_forward"]');
        if (repostEl) shares = parseCount(repostEl.textContent);
      }

      // 评论数
      const commentMatch = allText.match(/评论\s*(\d+)/);
      commentsCount = commentMatch ? parseInt(commentMatch[1], 10) : 0;
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
        const likeMatch = allText.match(/赞\s*(\d+)/);
        likes = likeMatch ? parseInt(likeMatch[1], 10) : 0;
      }
    }

    // ---- 图片 ----
    const mediaDiv = cardWrap.querySelector('[node-type="feed_list_media_prev"]');
    const imageEls = mediaDiv
      ? mediaDiv.querySelectorAll('img')
      : cardWrap.querySelectorAll('.media img, .card-feed img:not(.head img):not(.avator img)');
    const imageUrls = Array.from(imageEls)
      .map(img => {
        let src = img.src || '';
        src = src.replace(/\/thumb\d+\//, '/large/')
                 .replace(/\/orj\d+\//, '/large/')
                 .replace(/\/mw\d+\//, '/large/');
        return src;
      })
      .filter(url => url && !url.includes('data:image') && !url.includes('/avatar/'));

    // ---- 话题标签 ----
    const topicEls = cardWrap.querySelectorAll('a[href*="topic"], .a_topic');
    const tags = Array.from(topicEls)
      .map(a => a.textContent.replace(/#/g, '').trim())
      .filter(Boolean);

    // ---- 转发微博判断 ----
    const isRetweet = !!cardWrap.querySelector('[node-type="feed_list_forwardContent"]');

    // ---- 微博链接 ----
    const fromLink = fromEl?.querySelector('a:first-child');
    let weiboUrl = fromLink?.href || '';
    if (weiboUrl.startsWith('//')) weiboUrl = 'https:' + weiboUrl;
    if (!weiboUrl && mid) weiboUrl = `https://weibo.com/detail/${mid}`;

    return {
      platform: 'weibo',
      noteId: mid || `weibo_${Date.now()}_${idx}`,
      noteType: 'normal',
      title: contentText.slice(0, 30), // 微博无标题，取正文前30字
      content: contentText,
      url: weiboUrl,
      coverUrl: imageUrls[0] || '',
      imageUrls,
      videoUrl: '',
      videoDuration: '',
      publishTime,
      tags,
      likes,
      commentsCount,
      collects: 0,
      shares,
      authorId: '',
      authorName,
      authorAvatar,
      authorFans: 0,
      authorFollowing: 0,
      bloggerLikedCollected: 0,
      bloggerProfileUrl,
      bloggerAccountType: 'personal',
      source,
      region: '',
      isRetweet,
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

/**
 * 主采集函数
 */
export async function captureWeiboKeywordNotes(options = {}) {
  const { onProgress = null, maxScrolls = 3 } = options;
  const captureStartedAt = new Date().toISOString();

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
    onProgress({ phase: 'start', message: `开始采集微博搜索「${keyword}」...` });
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

  const cards = findAllCards();
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

  const allPosts = [];
  cards.forEach((card, idx) => {
    const post = extractCardData(card, idx);
    if (post) {
      allPosts.push(post);
    }
  });

  const captureFinishedAt = new Date().toISOString();

  // 去重
  const seen = new Set();
  const uniquePosts = allPosts.filter(p => {
    const key = p.noteId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (uniquePosts.length === 0) {
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
      totalCount: uniquePosts.length,
      notes: uniquePosts,
    },
    meta: {
      pageType: 'search_results',
      captureStartedAt,
      captureFinishedAt,
      sourceUrl: window.location.href,
      cardsFound: cards.length,
    },
  };
}
