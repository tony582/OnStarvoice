/**
 * 微博搜索页采集 — 通过 Ajax JSON 接口获取结构化数据
 *
 * 微博搜索页 (s.weibo.com) 使用 Ajax 加载数据，接口返回 JSON。
 * 作为 Chrome 扩展，我们在页面 context 中发起请求，复用用户已登录的 Cookie。
 *
 * 接口: https://s.weibo.com/ajax/statuses/search
 * 参数: keyword, page, search_type (1=综合, 61=实时)
 */

import { SYNC_TYPE } from '../constants.js';

/**
 * 从微博搜索页 URL 提取搜索关键词
 */
function extractKeyword(url) {
  try {
    const u = new URL(url);
    // s.weibo.com/weibo?q=xxx
    return u.searchParams.get('q') || u.searchParams.get('keyword') || '';
  } catch {
    return '';
  }
}

/**
 * 解析微博时间格式
 * 微博 API 返回类似 "Sun Jun 08 12:00:00 +0800 2025" 格式
 */
function parseWeiboTime(timeStr) {
  if (!timeStr) return '';
  try {
    const d = new Date(timeStr);
    if (isNaN(d.getTime())) return timeStr;
    return d.toISOString();
  } catch {
    return timeStr;
  }
}

/**
 * 清理微博 HTML 文本内容
 * 微博的 text 字段包含 HTML 标签（<a>、<span> 等）
 */
function cleanWeiboText(html) {
  if (!html) return '';
  // 移除 HTML 标签但保留文本
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

/**
 * 提取微博图片链接列表
 */
function extractImageUrls(picIds, picInfos) {
  if (!picIds || !Array.isArray(picIds) || picIds.length === 0) return [];

  if (picInfos && typeof picInfos === 'object') {
    return picIds.map(id => {
      const info = picInfos[id];
      if (!info) return null;
      // 优先大图
      return info.largest?.url || info.original?.url || info.large?.url || info.mw2000?.url || null;
    }).filter(Boolean);
  }

  // fallback: 用 picId 构造链接
  return picIds.map(id => `https://wx1.sinaimg.cn/large/${id}.jpg`);
}

/**
 * 将微博 API 返回的单条微博数据标准化为扩展内部格式
 */
function normalizeWeiboPost(post) {
  const user = post.user || {};
  const textRaw = post.text_raw || cleanWeiboText(post.text || '');
  const imageUrls = extractImageUrls(post.pic_ids, post.pic_infos);

  // 转发的微博
  const retweetText = post.retweeted_status
    ? cleanWeiboText(post.retweeted_status.text_raw || post.retweeted_status.text || '')
    : '';

  const fullContent = retweetText
    ? textRaw + '\n\n// 转发：' + retweetText
    : textRaw;

  return {
    platform: 'weibo',
    noteId: String(post.id || post.mid || ''),
    noteType: post.page_info?.type === 'video' ? 'video' : 'normal',
    title: '', // 微博没有标题概念，用正文前 30 字
    content: fullContent,
    url: post.id ? `https://weibo.com/${user.id}/${post.mblogid || post.id}` : '',
    coverUrl: imageUrls[0] || '',
    imageUrls: imageUrls,
    videoUrl: post.page_info?.type === 'video' ? (post.page_info.media_info?.stream_url_hd || post.page_info.media_info?.stream_url || '') : '',
    videoDuration: post.page_info?.type === 'video' ? (post.page_info.media_info?.duration || '') : '',
    publishTime: parseWeiboTime(post.created_at),
    tags: (post.topic_struct || []).map(t => t.topic_title || '').filter(Boolean),

    // 互动数据
    likes: post.attitudes_count || 0,
    commentsCount: post.comments_count || 0,
    collects: 0, // 微博没有收藏数据
    shares: post.reposts_count || 0,

    // 博主信息
    authorId: String(user.id || ''),
    authorName: user.screen_name || user.name || '',
    authorAvatar: user.profile_image_url || user.avatar_hd || '',
    authorFans: user.followers_count || 0,
    authorFollowing: user.friends_count || 0,
    bloggerLikedCollected: user.statuses_count || 0, // 微博总数
    bloggerProfileUrl: user.id ? `https://weibo.com/u/${user.id}` : '',
    bloggerAccountType: user.verified ? 'enterprise' : (user.mbrank > 0 ? 'professional' : 'personal'),

    // 来源
    source: post.source || '',
    region: post.region_name || '',
    isRetweet: !!post.retweeted_status,
  };
}

/**
 * 通过 Ajax 接口采集微博搜索结果
 */
export async function captureWeiboKeywordNotes(options = {}) {
  const { onProgress = null, maxPages = 5 } = options;
  const captureStartedAt = new Date().toISOString();

  // 提取关键词
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
    onProgress({
      phase: 'start',
      message: `开始采集微博搜索「${keyword}」...`,
    });
  }

  const allPosts = [];
  let currentPage = 1;
  let hasMore = true;

  while (hasMore && currentPage <= maxPages) {
    if (onProgress) {
      onProgress({
        phase: 'fetching',
        current: currentPage,
        total: maxPages,
        message: `正在获取第 ${currentPage} 页...`,
      });
    }

    try {
      // 尝试 Ajax 接口
      const apiUrl = `https://s.weibo.com/ajax/statuses/search?keyword=${encodeURIComponent(keyword)}&page=${currentPage}&search_type=1&xsrf=${getXsrfToken()}`;

      const resp = await fetch(apiUrl, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Xsrf-Token': getXsrfToken(),
        },
      });

      if (!resp.ok) {
        // 如果 Ajax 接口失败，尝试 DOM 解析
        console.warn(`[Weibo] Ajax API returned ${resp.status}, falling back to DOM scraping`);
        const domResults = await scrapeSearchPageDOM(keyword);
        if (domResults.length > 0) {
          allPosts.push(...domResults);
        }
        hasMore = false;
        break;
      }

      const json = await resp.json();

      // 解析 JSON 响应
      let posts = [];
      if (json.data && Array.isArray(json.data)) {
        posts = json.data;
      } else if (json.statuses && Array.isArray(json.statuses)) {
        posts = json.statuses;
      } else if (Array.isArray(json)) {
        posts = json;
      }

      if (posts.length === 0) {
        hasMore = false;
        break;
      }

      const normalized = posts.map(normalizeWeiboPost);
      allPosts.push(...normalized);

      if (onProgress) {
        onProgress({
          phase: 'progress',
          current: currentPage,
          total: maxPages,
          count: allPosts.length,
          message: `第 ${currentPage} 页完成，已采集 ${allPosts.length} 条`,
        });
      }

      currentPage++;

      // 随机延迟避免过快请求
      if (hasMore && currentPage <= maxPages) {
        await new Promise(r => setTimeout(r, 800 + Math.random() * 700));
      }
    } catch (err) {
      console.error(`[Weibo] Page ${currentPage} error:`, err);

      // 第一页失败就尝试 DOM 解析
      if (currentPage === 1 && allPosts.length === 0) {
        console.log('[Weibo] Falling back to DOM scraping...');
        const domResults = await scrapeSearchPageDOM(keyword);
        allPosts.push(...domResults);
      }

      hasMore = false;
    }
  }

  const captureFinishedAt = new Date().toISOString();

  if (allPosts.length === 0) {
    return {
      ok: false,
      platform: 'weibo',
      type: SYNC_TYPE.KEYWORD_NOTES,
      data: null,
      meta: { pageType: 'search_results', captureStartedAt, captureFinishedAt, sourceUrl: window.location.href },
      error: { code: 'NO_RESULTS', message: '未采集到搜索结果，请确认已登录微博' },
    };
  }

  // 去重
  const seen = new Set();
  const uniquePosts = allPosts.filter(p => {
    if (seen.has(p.noteId)) return false;
    seen.add(p.noteId);
    return true;
  });

  if (onProgress) {
    onProgress({
      phase: 'done',
      count: uniquePosts.length,
      message: `采集完成，共 ${uniquePosts.length} 条微博`,
    });
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
      pagesScraped: currentPage - 1,
    },
  };
}

/**
 * 获取 XSRF Token（从 cookie 中读取）
 */
function getXsrfToken() {
  try {
    const match = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

/**
 * DOM 降级方案：直接从页面 DOM 解析搜索结果
 * 当 Ajax 接口不可用时使用
 */
async function scrapeSearchPageDOM(keyword) {
  const results = [];

  // 微博搜索页的卡片容器
  const cards = document.querySelectorAll('.card-wrap[action-type="feed_list_item"], .card[action-type="feed_list_item"], div[class*="card-wrap"]');

  if (cards.length === 0) {
    // 尝试新版微博结构
    const feedItems = document.querySelectorAll('[class*="Feed_body"], [class*="woo-box-flex"][class*="card"]');
    feedItems.forEach((item, idx) => {
      const post = parseFeedItemDOM(item, idx, keyword);
      if (post) results.push(post);
    });
    return results;
  }

  cards.forEach((card, idx) => {
    try {
      const contentEl = card.querySelector('.txt, [class*="text"], p[node-type="feed_list_content"], [class*="content"]');
      const authorEl = card.querySelector('.name, [class*="name"], a[class*="W_texta"]');
      const timeEl = card.querySelector('.from a, [class*="time"], [class*="date"]');
      const repostEl = card.querySelector('[action-type="feed_list_forward"] em, [class*="repost"] em, .card-act li:nth-child(1) em');
      const commentEl = card.querySelector('[action-type="feed_list_comment"] em, [class*="comment"] em, .card-act li:nth-child(2) em');
      const likeEl = card.querySelector('[action-type="feed_list_like"] em, [class*="like"] em, .card-act li:nth-child(3) em');

      const content = contentEl ? contentEl.textContent.trim() : '';
      if (!content) return;

      const authorName = authorEl ? authorEl.textContent.trim() : '';
      const authorLink = authorEl ? (authorEl.href || '') : '';
      const timeText = timeEl ? timeEl.textContent.trim() : '';

      const parseNum = (el) => {
        if (!el) return 0;
        const t = el.textContent.trim().replace(/[^\d]/g, '');
        return parseInt(t, 10) || 0;
      };

      results.push({
        platform: 'weibo',
        noteId: `weibo_dom_${Date.now()}_${idx}`,
        noteType: 'normal',
        title: '',
        content,
        url: authorLink || '',
        coverUrl: '',
        imageUrls: [],
        videoUrl: '',
        videoDuration: '',
        publishTime: timeText,
        tags: [],
        likes: parseNum(likeEl),
        commentsCount: parseNum(commentEl),
        collects: 0,
        shares: parseNum(repostEl),
        authorId: '',
        authorName,
        authorAvatar: '',
        authorFans: 0,
        authorFollowing: 0,
        bloggerLikedCollected: 0,
        bloggerProfileUrl: authorLink,
        bloggerAccountType: 'personal',
        source: '',
        region: '',
        isRetweet: false,
      });
    } catch (err) {
      console.warn('[Weibo] DOM parse error for card', idx, err);
    }
  });

  return results;
}

function parseFeedItemDOM(item, idx, keyword) {
  try {
    const textEl = item.querySelector('[class*="text"], [class*="content"], p');
    const nameEl = item.querySelector('[class*="name"], [class*="screen_name"], a');
    const content = textEl ? textEl.textContent.trim() : '';
    if (!content) return null;

    return {
      platform: 'weibo',
      noteId: `weibo_feed_${Date.now()}_${idx}`,
      noteType: 'normal',
      title: '',
      content,
      url: '',
      coverUrl: '',
      imageUrls: [],
      videoUrl: '',
      videoDuration: '',
      publishTime: '',
      tags: [],
      likes: 0,
      commentsCount: 0,
      collects: 0,
      shares: 0,
      authorId: '',
      authorName: nameEl ? nameEl.textContent.trim() : '',
      authorAvatar: '',
      authorFans: 0,
      authorFollowing: 0,
      bloggerLikedCollected: 0,
      bloggerProfileUrl: '',
      bloggerAccountType: 'personal',
      source: '',
      region: '',
      isRetweet: false,
    };
  } catch {
    return null;
  }
}
