/**
 * 微博搜索页采集 — DOM 解析方案
 *
 * 微博搜索页 (s.weibo.com) 的 DOM 结构（已验证）：
 * - .card-wrap[action-type="feed_list_item"][mid="xxx"] — 卡片容器
 * - .card-wrap .card .card-feed .avator img — 博主头像
 * - .card-wrap .card .card-feed .content .info a.name[nick-name] — 博主名
 * - .card-wrap .card .card-feed .content .from a:first-child — 时间
 * - .card-wrap .card .card-feed .content .from a:nth-child(2) — 来源
 * - .card-wrap .card .card-feed .content p.txt[node-type="feed_list_content"] — 正文
 * - .card-wrap .card .card-feed .content p.txt[node-type="feed_list_content_full"] — 展开全文
 * - .card-wrap .card .card-act ul li — 转发/评论/赞
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
 * "转发 123" → 123, "评论" → 0, "赞" → 0
 */
function parseInteractionCount(text) {
  if (!text) return 0;
  const cleaned = text.replace(/[^\d]/g, '');
  return parseInt(cleaned, 10) || 0;
}

/**
 * 找到所有微博卡片
 */
function findAllCards() {
  // 精确选择器：card-wrap + action-type + mid
  let cards = document.querySelectorAll('.card-wrap[action-type="feed_list_item"][mid]');
  if (cards.length > 0) {
    console.log(`[Weibo] Found ${cards.length} cards with precise selector`);
    return Array.from(cards);
  }

  // 宽松选择器：card-wrap + mid
  cards = document.querySelectorAll('.card-wrap[mid]');
  if (cards.length > 0) {
    console.log(`[Weibo] Found ${cards.length} cards with .card-wrap[mid]`);
    return Array.from(cards);
  }

  // 再宽松：所有 card-wrap
  cards = document.querySelectorAll('.card-wrap');
  const validCards = Array.from(cards).filter(card => {
    // 过滤掉没有内容的卡片（如广告/导航）
    return card.querySelector('.txt') || card.querySelector('.content');
  });
  if (validCards.length > 0) {
    console.log(`[Weibo] Found ${validCards.length} cards with .card-wrap (filtered)`);
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
    // <a class="name" nick-name="xxx" href="//weibo.com/xxx">xxx</a>
    const nameEl = cardWrap.querySelector('a.name[nick-name]') ||
                   cardWrap.querySelector('.info a.name') ||
                   cardWrap.querySelector('a.name');
    const authorName = nameEl
      ? (nameEl.getAttribute('nick-name') || nameEl.textContent.trim())
      : '';
    const authorLink = nameEl?.href || '';
    // 把 //weibo.com/xxx 转为完整 URL
    const bloggerProfileUrl = authorLink
      ? (authorLink.startsWith('//') ? 'https:' + authorLink : authorLink)
      : '';

    // 头像
    const avatarImg = cardWrap.querySelector('.avator img') ||
                      cardWrap.querySelector('.card-feed img');
    const authorAvatar = avatarImg?.src || '';

    // ---- 正文内容 ----
    // 优先取展开全文版本
    const fullTextEl = cardWrap.querySelector('p.txt[node-type="feed_list_content_full"]');
    const shortTextEl = cardWrap.querySelector('p.txt[node-type="feed_list_content"]');

    let contentText = '';
    if (fullTextEl && fullTextEl.style.display !== 'none') {
      contentText = fullTextEl.textContent.trim();
    } else if (shortTextEl) {
      contentText = shortTextEl.textContent.trim();
    }

    // 清理内容中的多余空白
    contentText = contentText.replace(/\s+/g, ' ').trim();

    if (!contentText && !authorName) return null;

    // ---- 时间和来源 ----
    // <div class="from">
    //   <a>2025年08月18日 10:43</a>
    //   &nbsp;来自
    //   <a rel="nofollow">iPhone 15 Pro Max</a>
    // </div>
    const fromEl = cardWrap.querySelector('.from');
    let publishTime = '';
    let source = '';
    if (fromEl) {
      const timeLink = fromEl.querySelector('a:first-child');
      publishTime = timeLink?.textContent?.trim() || '';

      const sourceLink = fromEl.querySelector('a[rel="nofollow"]');
      source = sourceLink?.textContent?.trim() || '';
    }

    // ---- 互动数据 ----
    // <div class="card-act"><ul>
    //   <li><a>转发</a></li>    或  <li><a>转发 123</a></li>
    //   <li><a>评论</a></li>    或  <li><a>评论 45</a></li>
    //   <li><a title="赞">赞</a></li>   或  <li><a>赞 678</a></li>
    // </ul></div>
    const actItems = cardWrap.querySelectorAll('.card-act ul li');
    let shares = 0, commentsCount = 0, likes = 0;

    if (actItems.length >= 3) {
      // 按顺序：转发 / 评论 / 赞
      shares = parseInteractionCount(actItems[0]?.textContent || '');
      commentsCount = parseInteractionCount(actItems[1]?.textContent || '');
      likes = parseInteractionCount(actItems[2]?.textContent || '');
    } else if (actItems.length > 0) {
      // 尝试按文本匹配
      actItems.forEach(li => {
        const text = li.textContent.trim();
        if (text.includes('转发')) shares = parseInteractionCount(text);
        else if (text.includes('评论')) commentsCount = parseInteractionCount(text);
        else if (text.includes('赞')) likes = parseInteractionCount(text);
      });
    }

    // ---- 图片 ----
    const mediaDiv = cardWrap.querySelector('[node-type="feed_list_media_prev"]');
    const imageEls = mediaDiv
      ? mediaDiv.querySelectorAll('img')
      : cardWrap.querySelectorAll('.media img');
    const imageUrls = Array.from(imageEls)
      .map(img => {
        let src = img.src || '';
        // 转换缩略图到大图
        src = src.replace(/\/thumb\d+\//, '/large/')
                 .replace(/\/orj\d+\//, '/large/')
                 .replace(/\/mw\d+\//, '/large/');
        return src;
      })
      .filter(url => url && !url.includes('data:image'));

    // ---- 话题标签 ----
    const topicEls = cardWrap.querySelectorAll('a[href*="topic"], .a_topic');
    const tags = Array.from(topicEls)
      .map(a => a.textContent.replace(/#/g, '').trim())
      .filter(Boolean);

    // ---- 转发微博判断 ----
    const isRetweet = !!cardWrap.querySelector('[node-type="feed_list_forwardContent"]');

    // ---- 微博链接 ----
    const weiboLink = fromEl?.querySelector('a:first-child')?.href || '';
    const fullUrl = weiboLink
      ? (weiboLink.startsWith('//') ? 'https:' + weiboLink : weiboLink)
      : (mid ? `https://weibo.com/detail/${mid}` : '');

    return {
      platform: 'weibo',
      noteId: mid || `weibo_${Date.now()}_${idx}`,
      noteType: 'normal',
      title: '',
      content: contentText,
      url: fullUrl,
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
    if (newHeight === previousHeight) {
      console.log(`[Weibo] No more content after scroll ${i + 1}`);
      break;
    }
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
      try {
        btn.click();
        clicked++;
      } catch (e) { /* ignore */ }
    }
  });
  if (clicked > 0) {
    console.log(`[Weibo] Expanded ${clicked} full texts`);
  }
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
      error: {
        code: 'NO_KEYWORD',
        message: '无法从 URL 中提取搜索关键词',
      },
    };
  }

  if (onProgress) {
    onProgress({ phase: 'start', message: `开始采集微博搜索「${keyword}」...` });
  }

  // 1. 先展开所有全文
  expandAllFullTexts();
  await new Promise(r => setTimeout(r, 300));

  // 2. 滚动加载更多
  await scrollToLoadMore(maxScrolls, onProgress);

  // 3. 再次展开（滚动加载后可能有新的长文）
  expandAllFullTexts();
  await new Promise(r => setTimeout(r, 300));

  // 4. 提取所有卡片
  if (onProgress) {
    onProgress({ phase: 'extracting', message: '正在提取微博数据...' });
  }

  const cards = findAllCards();
  console.log(`[Weibo] Total cards found: ${cards.length}`);

  const allPosts = [];
  cards.forEach((card, idx) => {
    const post = extractCardData(card, idx);
    if (post && post.content) {
      allPosts.push(post);
    }
  });

  const captureFinishedAt = new Date().toISOString();

  // 去重（按 mid）
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
      error: {
        code: 'NO_RESULTS',
        message: '未采集到搜索结果。请确认：1. 已登录微博 2. 页面有搜索结果显示',
      },
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
