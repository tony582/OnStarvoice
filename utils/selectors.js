/**
 * onstarvoice V2.0 Selectors Configuration
 * 集中管理所有 DOM 选择器，便于维护和小红书页面改版后的快速修复
 *
 * 设计原则：
 * 1. 每个选择器提供多个候选，按优先级尝试
 * 2. 使用语义化的选择器名称
 * 3. 支持 CSS Selector 和 XPath 两种方式
 */

// ==================== 笔记详情页选择器 ====================

export const NOTE_DETAIL_SELECTORS = {
  // 容器
  container: [
    "#noteContainer",
    ".note-content",
    ".note-detail",
    ".content-container",
    "#detail-container",
    "[data-v-note]",
    "article",
    ".interaction-container",
  ],

  // 标题
  title: [
    "#detail-title", // 最稳定的ID选择器
    ".note-title",
    ".title",
    "h1.title",
    "[data-v-note] h1",
    ".note-content .title",
  ],

  // 作者信息
  author: {
    container: [
      ".author-wrapper",
      ".author-container",
      ".note-author",
      '[class*="author-"]', // 任何以 author- 开头的 class
      '[class*="user-info"]', // 用户信息容器
      "header", // 有些页面作者信息在 header 中
      ".user-container",
      "[data-v-author]", // Vue 组件的 data 属性
    ],
    name: [
      // 容器内相对选择器（优先，用于在 authorContainer 内查询）
      ".username", // 最直接的 username
      "a.name .username", // a.name 下的 username
      ".info a.name .username", // .info 下的 a.name 中的 username
      ".info .username", // .info 下的 username
      'a[href*="/user/profile/"] .username', // 用户链接下的 username
      'a[href*="/user/profile/"] span:first-of-type', // 用户链接的第一个 span
      ".avatar + div span", // 头像旁边的元素
      ".avatar + span",
      '[class*="avatar"] ~ [class*="name"]',
      'span[class*="name"]', // 任何包含 name 的 span
      'span[class*="user"]', // 任何包含 user 的 span

      // 全局绝对选择器（兜底，用于全局查询）
      ".author-wrapper .username",
      ".author-wrapper a.name .username",
      ".author-wrapper .info a.name .username",
      'header span[class*="name"]', // header区域
      'header span[class*="user"]',
      ".note-header span",
      ".author-name", // 原有选择器
      ".user-name",
      ".nickname",
      "[data-v-author] .name",
      ".note-content .author .name",
    ],
    link: [
      // 容器内相对选择器（优先）
      "a.name", // 直接的 a.name
      ".info a.name", // .info 下的 a.name
      'a[href*="/user/profile/"]', // 用户链接
      '.info a[href*="/user/profile/"]', // .info 下的用户链接
      "a.author-link",
      "a", // 任何 a 标签（最宽松的兜底）

      // 全局绝对选择器（兜底）
      ".author-wrapper a.name",
      '.author-wrapper a[href*="/user/profile/"]',
      ".author a",
      ".user-link",
    ],
    avatar: [
      ".author-avatar img",
      ".avatar img",
      ".user-avatar img",
      "[data-v-author] img",
    ],
  },

  // 正文内容
  content: [
    ".note-text",
    ".desc",
    ".content",
    "[data-v-note] .desc",
    ".note-content .desc",
    ".note-detail .content",
  ],

  // 标签
  tags: [
    ".tag",
    ".topic",
    ".note-tags .tag",
    "[data-v-note] .tag",
    'a[href*="/search_result?keyword="]',
  ],

  // 互动数据（传统选择器，兜底用）
  interactions: {
    likes: [
      ".like-count",
      ".likes",
      "[data-v-interaction] .like .count",
      ".interactions .like span",
    ],
    collects: [
      ".collect-count",
      ".collects",
      "[data-v-interaction] .collect .count",
      ".interactions .collect span",
    ],
    comments: [
      ".comment-count",
      ".comments",
      "[data-v-interaction] .comment .count",
      ".interactions .comment span",
    ],
  },

  // 互动数据（基于图标智能定位）
  interactionsByIcon: {
    likes: {
      button: [
        "button:has(.like-icon)",
        '[class*="like"] button',
        ".interact-bar > div:nth-child(1)",
      ],
      count: [
        ".buttons.engage-bar-style .left .like-wrapper .count",
        ".like-wrapper span",
        ".like-count",
        '[class*="like"] span[class*="count"]',
      ],
    },
    collects: {
      button: [
        "button:has(.star-icon)",
        '[class*="collect"] button',
        ".interact-bar > div:nth-child(2)",
      ],
      count: [
        ".buttons.engage-bar-style .left .collect-wrapper .count",
        ".collect-wrapper span",
        ".collect-count",
        '[class*="collect"] span[class*="count"]',
      ],
    },
    comments: {
      button: [
        "button:has(.comment-icon)",
        ".chat-wrapper",
        '[class*="comment"] button',
        ".interact-bar > div:nth-child(3)",
      ],
      count: [
        ".buttons.engage-bar-style .left .chat-wrapper .count",
        ".chat-wrapper .count",
        ".comment-wrapper span",
        ".comment-count",
        '[class*="comment"] span[class*="count"]',
      ],
    },
  },

  // 互动栏（直接结构定位）
  engageBar: {
    container: [".buttons.engage-bar-style", ".engage-bar-style", ".buttons"],
    likesCount: [
      ".left .like-wrapper .count",
      ".left .like-wrapper span.count",
    ],
    collectsCount: [
      ".left .collect-wrapper .count",
      ".left .collect-wrapper span.count",
    ],
    commentsCount: [
      ".left .chat-wrapper .count",
      ".left .comment-wrapper .count",
    ],
  },

  // 发布日期
  publishDate: [
    ".bottom-container .date",
    "time", // HTML5语义标签（最优先）
    "time[datetime]",
    ".date",
    ".publish-date",
    '[class*="time"]',
    '[class*="date"]',
    "[data-v-note] .date",
    ".note-content .date",
  ],

  // 图片
  images: [
    ".note-slider .swiper-slide img",
    ".note-slider img", // 用户提供的精准选择器
    ".image-list img",
    ".note-image img",
    ".carousel img",
    ".swiper-slide img",
    "[data-v-gallery] img",
    '.note-content img[src*="xhscdn"]',
  ],

  // 视频
  video: [
    "video",
    ".video-player video",
    ".note-video video",
    "[data-v-video] video",
    'video[src*="xhscdn"]',
  ],

  // 封面图
  coverImage: [
    "xg-poster",
    ".xgplayer-poster",
    ".note-slider img:first-child", // 轮播第一张
    ".image-list img:first-child",
    ".cover-img",
    ".poster",
    "video[poster]",
    "[data-v-video] [poster]",
  ],
};

// ==================== 博主主页选择器 ====================

export const BLOGGER_PROFILE_SELECTORS = {
  // 头像
  avatar: [
    ".avatar img",
    ".user-avatar img",
    ".avatar-wrapper img",
    ".user-image",
    'img[data-xhs-img=""]',
    '[data-v-86ee68bc=""] img',
  ],

  // 博主名称
  name: [
    ".user-name",
    ".nickname",
    ".name",
    ".user-nickname .user-name",
    '[data-v-1d90bc98=""] .user-name',
    '[data-v-6be60601=""] .user-name',
  ],

  // 简介
  bio: [
    ".bio",
    ".description",
    ".intro",
    ".user-bio",
    ".user-desc",
    '[data-v-4947d265=""]',
  ],

  // 小红书号
  userId: [
    ".id",
    ".user-id",
    ".account-info .id",
    ".user-redId",
    '[data-v-1d90bc98=""] .user-redId',
  ],

  // 粉丝数
  followersCount: [
    ".follower-count",
    ".fans-count",
    "[data-v-count] .follower",
    ".user-stats .follower span",
  ],

  // 笔记列表
  notesList: {
    container: [
      ".note-list",
      ".feeds-container",
      ".user-feeds",
      "[data-v-feed]",
    ],
    item: [
      ".note-item",
      ".feed-item",
      ".cover",
      'a[href*="/explore/"]',
      "[data-v-feed] a",
    ],
    title: [".title", ".note-title", ".desc", "img[alt]"],
    cover: [".cover img", ".note-cover img", 'img[src*="xhscdn"]'],
    author: [".author", ".user-name", ".nickname"],
    likes: [".like-count", ".likes", ".interaction .like", '[class*="like"]'],
  },
};

// ==================== 搜索/发现页选择器 ====================

export const SEARCH_RESULTS_SELECTORS = {
  // 结果列表容器
  container: [
    ".feeds-container",
    ".search-results",
    ".waterfall",
    "[data-v-feed]",
    "#search-result",
  ],

  // 笔记卡片
  noteCard: {
    item: [
      ".note-item",
      ".feed-item",
      ".cover",
      'a[href*="/explore/"]',
      "[data-v-feed] a",
      "section a",
    ],
    title: [".title", ".note-title", ".card-title", "[data-v-card] .title"],
    cover: [".cover img", ".note-cover img", 'img[src*="xhscdn"]'],
    author: [".author", ".user-name", ".nickname", "[data-v-card] .author"],
    publishDate: [
      "time[datetime]",
      "time",
      ".publish-date",
      ".publish-time",
      ".date",
      ".time",
      "[data-v-card] .date",
      "[data-v-card] .time",
      '[class*="publish"]',
      '[class*="date"]',
      '[class*="time"]',
    ],
    likes: [
      ".like-count",
      ".likes",
      "[data-v-card] .like",
      ".interaction .like",
    ],
  },

  // 加载更多触发器
  loadMore: [".load-more", "#load-more-trigger", "[data-v-load]"],
};

// ==================== 评论区选择器 ====================

export const COMMENTS_SELECTORS = {
  // 评论列表容器
  container: [
    ".note-comment-list",
    ".comments-el",
    ".comments-container",
    ".comments-wrapper",
    ".comment-list",
    '[class*="comment-list"]',
    "[data-v-comment]",
    "#comments",
  ],

  // 单条评论
  commentItem: {
    container: [
      ".comment-item",
      ".parent-comment-item",
      ".note-comment-item",
      '[class*="comment-item"]',
      ".comment",
      "[data-v-comment-item]",
    ],
    userName: [
      ".comment-user-info .name",
      ".comment-user .name",
      ".user-name",
      ".nickname",
      "[data-v-comment] .name",
    ],
    userLink: ['a[href*="/user/profile/"]', ".user-link", ".comment-user a"],
    ipLocation: [
      ".comment-ip",
      ".ip-location",
      ".ip",
      '[class*="ip"]',
      '[class*="location"]',
    ],
    content: [
      ".comment-content .text",
      ".content .text",
      ".comment-content",
      ".content",
      ".text",
      "[data-v-comment] .content",
    ],
    likes: [
      ".like-wrapper .count",
      '[class*="like"] .count',
      ".like-count",
      ".likes",
      ".like-wrapper",
      "[data-v-comment] .like",
    ],
  },

  // 查看更多评论
  loadMore: [
    ".show-more",
    ".load-more-comments",
    ".more-comments",
    "[data-v-comment] .load-more",
  ],
};

// ==================== 通用选择器 ====================

export const COMMON_SELECTORS = {
  // 加载中指示器
  loading: [".loading", ".spinner", "[data-v-loading]", ".loading-indicator"],

  // 无更多内容提示
  noMore: [".no-more", ".end-tip", "[data-v-end]", ".load-end"],

  // 错误提示
  error: [".error", ".error-msg", "[data-v-error]"],
};

// ==================== XPath 选择器 ====================

export const XPATH_SELECTORS = {
  // 包含特定文本的元素
  bloggerIdLabel: '//span[contains(text(), "小红书号")]',
  followersLabel: '//span[contains(text(), "粉丝")]',
  publishDateLabel:
    '//span[contains(text(), "发布于") or contains(text(), "天前") or contains(text(), "小时前")]',
};

// ==================== 选择器辅助函数 ====================

/**
 * 尝试使用多个选择器查找元素
 * @param {Array<string>} selectors - 选择器数组
 * @param {Element} context - 上下文元素
 * @returns {Element|null} 找到的元素
 */
export function querySelector(selectors, context = document) {
  if (!Array.isArray(selectors)) {
    selectors = [selectors];
  }

  for (const selector of selectors) {
    try {
      const element = context.querySelector(selector);
      if (element) {
        return element;
      }
    } catch (error) {
      console.warn(`[Selectors] Invalid selector: ${selector}`, error);
    }
  }

  return null;
}

/**
 * 尝试使用多个选择器查找所有元素
 * @param {Array<string>} selectors - 选择器数组
 * @param {Element} context - 上下文元素
 * @returns {Array<Element>} 找到的元素数组
 */
export function querySelectorAll(selectors, context = document) {
  if (!Array.isArray(selectors)) {
    selectors = [selectors];
  }

  let allElements = [];

  for (const selector of selectors) {
    try {
      const elements = context.querySelectorAll(selector);
      if (elements.length > 0) {
        allElements.push(...Array.from(elements));
      }
    } catch (error) {
      console.warn(`[Selectors] Invalid selector: ${selector}`, error);
    }
  }

  // 去重
  return Array.from(new Set(allElements));
}

/**
 * 使用 XPath 查找元素
 * @param {string} xpath - XPath 表达式
 * @param {Element} context - 上下文元素
 * @returns {Element|null} 找到的元素
 */
export function getElementByXPath(xpath, context = document) {
  try {
    const result = document.evaluate(
      xpath,
      context,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    );
    return result.singleNodeValue;
  } catch (error) {
    console.warn(`[Selectors] Invalid XPath: ${xpath}`, error);
    return null;
  }
}

/**
 * 使用 XPath 查找所有元素
 * @param {string} xpath - XPath 表达式
 * @param {Element} context - 上下文元素
 * @returns {Array<Element>} 找到的元素数组
 */
export function getElementsByXPath(xpath, context = document) {
  try {
    const result = document.evaluate(
      xpath,
      context,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );

    const elements = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      elements.push(result.snapshotItem(i));
    }
    return elements;
  } catch (error) {
    console.warn(`[Selectors] Invalid XPath: ${xpath}`, error);
    return [];
  }
}

/**
 * 等待元素出现
 * @param {Array<string>} selectors - 选择器数组
 * @param {number} timeout - 超时时间（毫秒）
 * @param {Element} context - 上下文元素
 * @returns {Promise<Element>} 找到的元素
 */
export function waitForElement(selectors, timeout = 5000, context = document) {
  return new Promise((resolve, reject) => {
    // 先尝试立即查找
    const element = querySelector(selectors, context);
    if (element) {
      resolve(element);
      return;
    }

    // 使用 MutationObserver 监听 DOM 变化
    const observer = new MutationObserver(() => {
      const element = querySelector(selectors, context);
      if (element) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(element);
      }
    });

    observer.observe(context === document ? document.body : context, {
      childList: true,
      subtree: true,
    });

    // 超时处理
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Element not found: ${selectors.join(", ")}`));
    }, timeout);
  });
}

/**
 * 检查元素是否存在
 * @param {Array<string>} selectors - 选择器数组
 * @param {Element} context - 上下文元素
 * @returns {boolean} 是否存在
 */
export function elementExists(selectors, context = document) {
  return querySelector(selectors, context) !== null;
}
