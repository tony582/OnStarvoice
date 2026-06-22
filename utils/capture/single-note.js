/**
 * onstarvoice V2.0 Single Note Capture Module
 * 采集单篇笔记数据
 */

import {
  COMMENTS_SELECTORS,
  NOTE_DETAIL_SELECTORS,
  querySelector,
  querySelectorAll,
} from "../selectors.js";
import {
  parseInteractionCount,
  normalizeDate,
  cleanText,
  extractUserId,
} from "../helpers.js";
import {PAGE_TYPE, SYNC_TYPE} from "../constants.js";
import {wait} from "../scroll.js";

/**
 * 采集单篇笔记数据
 * @returns {Promise<Object>} 采集结果
 */
export async function captureSingleNote() {
  const captureStartedAt = new Date().toISOString();

  // 阶段 1：增加初始等待时间（从 800ms 增加到 1500ms）
  console.log("[SingleNote] Phase 1: Initial wait and scroll to top...");
  await wait(800); // 从 500ms 增加到 800ms
  window.scrollTo(0, 0);
  await wait(700); // 从 300ms 增加到 700ms

  try {
    // 阶段 2：等待页面 hydration 完成
    console.log("[SingleNote] Phase 2: Waiting for page hydration...");
    await waitForPageHydration();

    // 阶段 3：等待关键区块（互动区/媒体区/视频元素）加载
    console.log("[SingleNote] Phase 3: Waiting for critical blocks...");
    await waitForCriticalBlocks();

    // 阶段 4：提取笔记 ID
    const noteId = extractNoteIdFromUrl();
    if (!noteId) {
      throw new Error("无法从 URL 提取笔记 ID");
    }

    // 阶段 5：识别正确的单笔记容器（带验证和重试）
    console.log("[SingleNote] Phase 4: Resolving note container...");
    const titleElement = querySelector(NOTE_DETAIL_SELECTORS.title);
    const noteContext = await resolvePrimaryNoteContextWithRetry(
      titleElement,
      noteId,
    );

    // 阶段 6：从容器内提取所有数据
    console.log("[SingleNote] Phase 5: Extracting data from container...");

    // 提取标题（从容器内）
    const titleInContainer = querySelector(
      NOTE_DETAIL_SELECTORS.title,
      noteContext,
    );
    const title = titleInContainer
      ? cleanText(titleInContainer.textContent)
      : "";

    // 提取作者信息（严格容器隔离）
    const authorInfo = extractAuthorInfo(noteContext);

    // 提取正文内容（从容器内）
    const contentElement = querySelector(
      NOTE_DETAIL_SELECTORS.content,
      noteContext,
    );
    const content = contentElement ? cleanText(contentElement.textContent) : "";

    // 提取标签
    const tags = extractTags(noteContext);

    // 提取互动数据
    const interactions = extractInteractions(noteContext);

    // 提取发布时间
    const publishDateRaw = extractPublishDateRaw(noteContext);

    // 提取最近编辑时间
    const lastEditedAt = extractLastEditedAt(noteContext);

    // 提取媒体（图片/视频，传入容器）
    const media = extractMedia(noteContext, noteId);

    // 构建 payload（统一命名：对齐 payload-contract）
    const captureTimestamp = Date.now();
    const noteType = resolveNoteType(noteContext, media);
    const payload = {
      noteId,
      url: window.location.href,
      title,
      author: authorInfo.name,
      authorId: authorInfo.userId,
      authorUrl: authorInfo.url,
      content,
      tags,
      likes: interactions.likes,
      collects: interactions.collects,
      comments: interactions.comments,
      publishTime: publishDateRaw,
      publishDateRaw,
      lastEditedAt,
      publishLocation: extractPublishLocation(noteContext),
      noteType,
      coverImageUrl: media.coverImage,
      imageUrls: media.images,
      videoUrl: media.videoUrl,
      videoUrls: media.videoUrls,
      videoDuration: media.videoDuration,
      captureTimestamp,
    };

    // 详细日志输出
    console.group("[SingleNote] Capture Summary");
    console.log("Note ID:", noteId);
    console.log("Title:", title || "(empty)");
    console.log("Author:", authorInfo.name || "(empty)");
    console.log("Author URL:", authorInfo.url || "(empty)");
    console.log("Last Edited At:", lastEditedAt || "(empty)");
    console.log("Interactions:", interactions);
    console.log("Media:", {
      type: noteType,
      coverImage: media.coverImage ? "YES" : "NO",
      imageCount: media.images.length,
      videoDuration: media.videoDuration || "(empty)",
    });
    console.log("Tags:", tags.length);
    console.groupEnd();

    // 阶段 7：数据验证（在返回前）
    console.log("[SingleNote] Phase 6: Validating captured data...");
    try {
      validateCapturedData(payload);
    } catch (validationError) {
      console.error("[SingleNote] Data validation failed, returning error");
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
          code: "VALIDATION_FAILED",
          message: validationError.message,
          debugInfo: {
            url: window.location.href,
            noteId: payload.noteId,
            issues: validationError.message,
          },
        },
      };
    }

    // 验证通过，返回成功结果
    console.log("[SingleNote] Capture completed successfully");
    return {
      ok: true,
      type: SYNC_TYPE.SINGLE_NOTE,
      data: payload,
      meta: {
        pageType: PAGE_TYPE.NOTE_DETAIL,
        captureStartedAt,
        captureFinishedAt: new Date().toISOString(),
      },
      error: null,
    };
  } catch (error) {
    console.error("[SingleNote] Capture failed with error:", error);

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
        debugInfo: {
          url: window.location.href,
          errorStack: error.stack,
        },
      },
    };
  }
}

// ==================== 辅助函数 ====================

/**
 * 从 URL 提取笔记 ID
 */
function extractNoteIdFromUrl() {
  const url = window.location.href;
  const match = url.match(
    /\/(?:explore|discovery\/item|note|video|search_result)\/([a-zA-Z0-9_-]+)|\/user\/profile\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)/i,
  );
  if (match?.[1]) {
    return match[1];
  }
  if (match?.[2]) {
    return match[2];
  }
  return null;
}

/**
 * 验证采集到的数据完整性
 * @param {Object} payload - 采集的数据
 * @throws {Error} 如果验证失败
 * @returns {boolean} 验证通过返回 true
 */
function validateCapturedData(payload) {
  const fatalIssues = [];
  const warnings = [];

  // 必需字段检查 (标题和正文可以为空)
  if (!payload.author || payload.author.length === 0) {
    fatalIssues.push("作者名为空");
  }

  // 作者名格式检查（不应该是时间文本）
  if (payload.author) {
    const timePatterns = [
      /^\d+[分秒小时天月年]/,
      /^[0-9]+\s*(分钟|小时|天|月|年)前?/,
      /刚刚|昨天|前天|编辑于/,
    ];
    for (const pattern of timePatterns) {
      if (pattern.test(payload.author)) {
        fatalIssues.push(`作者名疑似时间文本: ${payload.author}`);
        break;
      }
    }
  }

  // 媒体缺失降级为告警，不阻断整条记录
  if (payload.noteType === "video" && !payload.videoUrl) {
    warnings.push("视频笔记缺少视频链接");
  }

  // 图文笔记允许仅封面场景
  if (
    payload.noteType === "image" &&
    (!payload.imageUrls || payload.imageUrls.length === 0) &&
    !payload.coverImageUrl
  ) {
    warnings.push("图文笔记缺少图片");
  }

  if (fatalIssues.length > 0) {
    console.error("[SingleNote] Data validation failed:", fatalIssues);
    throw new Error(`数据采集不完整: ${fatalIssues.join(", ")}`);
  }

  if (warnings.length > 0) {
    console.warn("[SingleNote] Data validation warnings:", warnings);
  }

  console.log("[SingleNote] Data validation passed");
  return true;
}

/**
 * 提取作者信息（多策略+验证，严格容器隔离）
 */
function extractAuthorInfo(noteContext = document) {
  console.log("[SingleNote] Extracting author info from container...", {
    containerClass:
      noteContext.className ||
      (noteContext === document ? "document" : "unnamed"),
  });

  // 首先尝试找到作者容器
  const authorContainer = querySelector(
    NOTE_DETAIL_SELECTORS.author.container,
    noteContext,
  );

  let nameElement, linkElement;

  if (authorContainer) {
    // 在作者容器内查询（优先）
    nameElement = querySelector(
      NOTE_DETAIL_SELECTORS.author.name,
      authorContainer,
    );
    linkElement = querySelector(
      NOTE_DETAIL_SELECTORS.author.link,
      authorContainer,
    );
    console.log("[SingleNote] Found author container:", {
      containerClass: authorContainer.className,
      nameFound: Boolean(nameElement),
      nameText: nameElement
        ? cleanText(nameElement.textContent)
        : "(not found)",
      linkFound: Boolean(linkElement),
      linkHref: linkElement ? linkElement.href : "(not found)",
    });
  } else {
    // 降级策略：如果找不到标准的 authorContainer，直接在 noteContext 中查找
    console.warn(
      "[SingleNote] Author container not found, trying direct search in noteContext...",
    );
    nameElement = querySelector(NOTE_DETAIL_SELECTORS.author.name, noteContext);
    linkElement = querySelector(NOTE_DETAIL_SELECTORS.author.link, noteContext);

    if (!nameElement) {
      console.warn(
        "[SingleNote] Author name element not found even with direct search, returning empty",
      );
      return {name: "", userId: "", url: ""};
    }
  }

  let name = nameElement ? cleanText(nameElement.textContent) : "";
  let url = linkElement ? linkElement.href : "";

  if (!url && nameElement) {
    const wrappedLink = nameElement.closest('a[href*="/user/profile/"]');
    if (wrappedLink?.href) {
      url = wrappedLink.href;
    }
  }

  const userId = url ? extractUserId(url) : "";

  // 验证作者名称有效性
  if (!validateAuthorName(name)) {
    console.warn(
      "[SingleNote] Author name validation failed:",
      name,
      ", trying fallback...",
    );
    // 尝试备用策略（仅在 noteContext 内）
    name = extractAuthorNameFallback(noteContext);
  }

  // 移除全局回退逻辑 - 如果容器内找不到有效作者名，就返回空值
  // 这样可以在后续的数据验证中被捕获，而不是返回错误的数据

  console.log("[SingleNote] Author extracted:", {
    name: name || "(empty)",
    url: url || "(empty)",
    userId: userId || "(empty)",
    authorContainerFound: Boolean(authorContainer),
    nameElementFound: Boolean(nameElement),
  });

  const nextUserId = url ? extractUserId(url) : "";
  return {name, url, userId: nextUserId || userId};
}

/**
 * 验证作者名称（增强版，更严格的时间文本过滤）
 */
function validateAuthorName(name) {
  if (!name || typeof name !== "string") return false;

  // 长度检查（从 2-20 扩展到 1-50）
  if (name.length < 1 || name.length > 50) return false;

  // 排除无效文本
  const invalidTexts = [
    "关注",
    "token",
    "http",
    "www",
    "加载",
    "点击",
    "编辑于",
    "分钟前",
    "小时前",
    "天前",
    "昨天",
    "前天",
    "刚刚",
  ];
  if (invalidTexts.some((text) => name.includes(text))) return false;

  // 增强的时间文本黑名单模式
  const timePatterns = [
    /^\d+[分秒小时天月年]/, // "4天前"、"2小时前"
    /^[0-9]+\s*(分钟|小时|天|月|年)前?/, // "4 天前"、"2 小时"
    /刚刚|昨天|前天|编辑于/, // 相对时间文本
    /\d{4}-\d{2}-\d{2}/, // 日期格式 "2024-03-05"
    /\d{4}\/\d{1,2}\/\d{1,2}/, // 日期格式 "2024/3/5"
    /\d{1,2}:\d{2}/, // 时间格式 "14:30"
    /\d{1,2}月\d{1,2}日/, // 中文日期 "3月5日"
    /^\d+秒$/, // "30秒"
  ];

  for (const pattern of timePatterns) {
    if (pattern.test(name)) {
      return false;
    }
  }

  // 排除纯数字或纯符号
  if (/^[\d\s]+$/.test(name) || /^[^\w\u4e00-\u9fa5]+$/.test(name)) {
    return false;
  }

  return true;
}

/**
 * 作者名称提取备用策略（仅在容器内查找）
 */
function extractAuthorNameFallback(noteContext = document) {
  console.log(
    "[SingleNote] Using fallback strategy for author name (container only)...",
  );

  // 策略A: 通过用户链接定位（优先）
  const linkElements = noteContext.querySelectorAll(
    'a[href*="/user/profile/"]',
  );
  for (const link of linkElements) {
    // 跳过评论区、推荐流中的链接
    if (isIgnoredAuthorNode(link)) continue;

    const span = link.querySelector("span:first-of-type");
    if (span) {
      const text = cleanText(span.textContent);
      if (validateAuthorName(text)) {
        console.log("[SingleNote] Found author by link strategy:", text);
        return text;
      }
    }
  }

  // 策略B: 通过头像相邻元素定位
  const avatarStrategies = [
    ".avatar + div span",
    ".avatar + span",
    '[class*="avatar"] ~ [class*="name"]',
  ];

  for (const selector of avatarStrategies) {
    const elements = noteContext.querySelectorAll(selector);
    for (const el of elements) {
      const text = cleanText(el.textContent);
      if (validateAuthorName(text)) {
        console.log("[SingleNote] Found author by avatar strategy:", text);
        return text;
      }
    }
  }

  console.warn(
    "[SingleNote] All author extraction strategies failed within container, returning empty",
  );
  return ""; // 返回空字符串，而不是"未知作者"，让后续验证处理
}

function extractAuthorInfoGlobalFallback() {
  // 优先作者容器，避免误采评论区/推荐流
  const authorContainer = querySelector(NOTE_DETAIL_SELECTORS.author.container);
  if (authorContainer) {
    const nameElement = querySelector(
      NOTE_DETAIL_SELECTORS.author.name,
      authorContainer,
    );
    const linkElement = querySelector(
      NOTE_DETAIL_SELECTORS.author.link,
      authorContainer,
    );
    const name = cleanText(nameElement?.textContent || "");
    const url = String(linkElement?.href || "").trim();
    if (validateAuthorName(name)) {
      return {name, url};
    }
  }

  // 兜底：从全局作者链接中筛选“非评论区/非列表卡片”的候选
  const links = Array.from(
    document.querySelectorAll('a[href*="/user/profile/"]'),
  );
  for (const link of links) {
    if (isIgnoredAuthorNode(link)) continue;
    const text = cleanText(
      link.querySelector(".username, .name, .user-name, .nickname, span")
        ?.textContent ||
        link.textContent ||
        "",
    );
    if (validateAuthorName(text)) {
      return {name: text, url: String(link.href || "").trim()};
    }
  }

  return {name: "", url: ""};
}

function isIgnoredAuthorNode(node) {
  if (!node || typeof node.closest !== "function") {
    return false;
  }

  const ignoredSelectors = [
    ".comment-item",
    ".comments-container",
    ".comment",
    ".feed-item",
    ".note-item",
    ".recommend",
    ".related",
  ];

  return ignoredSelectors.some((selector) => {
    try {
      return Boolean(node.closest(selector));
    } catch {
      return false;
    }
  });
}

function resolvePrimaryNoteContext(titleElement = null) {
  const anchors = [
    titleElement,
    querySelector(NOTE_DETAIL_SELECTORS.content),
    querySelector(NOTE_DETAIL_SELECTORS.author.container),
  ].filter(Boolean);

  for (const element of anchors) {
    const container = findClosestBySelectors(
      element,
      NOTE_DETAIL_SELECTORS.container,
    );
    if (container) {
      return container;
    }
  }

  const containers = querySelectorAll(NOTE_DETAIL_SELECTORS.container);
  if (containers.length === 1) {
    return containers[0];
  }

  if (containers.length > 1) {
    // 弹窗经常是在 DOM 树后方挂载的，所以倒序查找，优先匹配后面的容器
    const withAuthor = [...containers]
      .reverse()
      .find((container) =>
        querySelector(NOTE_DETAIL_SELECTORS.author.container, container),
      );
    if (withAuthor) {
      return withAuthor;
    }
    return containers[containers.length - 1];
  }

  return document;
}

function findClosestBySelectors(element, selectors) {
  if (!element || typeof element.closest !== "function") {
    return null;
  }

  const candidateSelectors = Array.isArray(selectors) ? selectors : [selectors];
  for (const selector of candidateSelectors) {
    try {
      const matched = element.closest(selector);
      if (matched) {
        return matched;
      }
    } catch {
      // ignore invalid selector
    }
  }

  return null;
}

/**
 * 验证容器是否是当前笔记的正确容器
 * @param {HTMLElement} container - 待验证的容器元素
 * @param {string} noteId - 当前笔记的 ID
 * @returns {boolean} 是否通过验证
 */
function validateContainer(container, noteId) {
  if (!container || container === document) {
    console.warn("[SingleNote] Container validation failed: invalid container");
    return false;
  }

  // 验证 1：标题匹配
  const titleInContainer = querySelector(
    NOTE_DETAIL_SELECTORS.title,
    container,
  );
  const titleText = cleanText(titleInContainer?.textContent || "");
  const pageTitle = cleanText(document.title.replace(/\s*-\s*小红书.*$/, ""));
  const titleMatches = titleText && titleText === pageTitle;

  // 验证 2：笔记 ID 匹配
  const idMatches = containerMatchesNoteId(container, noteId);

  // 验证 3：作者元素有效
  const authorName = querySelector(
    NOTE_DETAIL_SELECTORS.author.name,
    container,
  );
  const authorText = cleanText(authorName?.textContent || "");
  const authorValid =
    authorText && authorText.length > 0 && validateAuthorName(authorText);

  // 验证 4：内容区存在
  const content = querySelector(NOTE_DETAIL_SELECTORS.content, container);
  const contentValid = Boolean(content);

  console.log("[SingleNote] Container validation:", {
    titleMatches,
    idMatches,
    authorValid,
    contentValid,
    containerClass: container.className || "unnamed",
  });

  // 只要满足至少两项即可。弹窗模式下 title 和 ID 验证通常会失效
  // 但只要容器内有合规的内容(content)和作者(author)，通常就是准确的详情容器。
  const validCount = [
    titleMatches,
    idMatches,
    authorValid,
    contentValid,
  ].filter(Boolean).length;

  // 额外放行条件：如果是通过明确的锚点类名找到的（例如 .note-content），只要里面包含作者或任何媒体元素也可以放行
  const hasMediaContent = Boolean(
    container.querySelector("img, video, .swiper-wrapper"),
  );
  const isInteractionOnlyContainer = Boolean(
    container.className &&
      container.className.includes("interaction-container") &&
      !hasMediaContent,
  );
  if (isInteractionOnlyContainer) {
    return false;
  }

  const isStrongContainerClass =
    container.className &&
    (container.className.includes("note-content") ||
      container.className.includes("note-detail") ||
      container.id === "noteContainer");

  return (
    validCount >= 2 ||
    (isStrongContainerClass && (authorValid || hasMediaContent))
  );
}

/**
 * 检查容器是否包含指定的笔记 ID
 * @param {HTMLElement} container - 待检查的容器元素
 * @param {string} noteId - 笔记 ID
 * @returns {boolean} 是否匹配
 */
function containerMatchesNoteId(container, noteId) {
  if (!container || !noteId) return false;

  // 检查 data-note-id, data-id 等属性
  const dataId =
    container.getAttribute("data-note-id") ||
    container.getAttribute("data-id") ||
    container.getAttribute("data-item-id");

  if (dataId === noteId) {
    console.log("[SingleNote] Container matches noteId via data attribute");
    return true;
  }

  // 检查容器内的链接是否包含该 noteId
  try {
    const links = container.querySelectorAll(`a[href*="${noteId}"]`);
    if (links.length > 0) {
      console.log("[SingleNote] Container matches noteId via internal links");
      return true;
    }
  } catch (error) {
    console.warn("[SingleNote] Error checking links for noteId:", error);
  }

  return false;
}

/**
 * 识别单笔记容器（带重试机制）
 * @param {HTMLElement} titleElement - 标题元素（可选）
 * @param {string} noteId - 笔记 ID
 * @returns {Promise<HTMLElement>} 容器元素
 */
async function resolvePrimaryNoteContextWithRetry(titleElement, noteId) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(
      `[SingleNote] Attempting to resolve container (attempt ${attempt}/${maxAttempts})...`,
    );

    const container = resolvePrimaryNoteContext(titleElement);

    if (container && validateContainer(container, noteId)) {
      console.log(`[SingleNote] Valid container found on attempt ${attempt}`);
      return container;
    }

    if (attempt < maxAttempts) {
      console.warn(
        `[SingleNote] Container validation failed on attempt ${attempt}, retrying after 500ms...`,
      );
      await wait(500);
    }
  }

  console.error("[SingleNote] Failed to find valid container after 3 attempts");
  throw new Error("未识别到准确的笔记内容区域，请确保页面已完全加载");
}

/**
 * 提取标签
 */
function extractTags(noteContext = document) {
  const tagElements = querySelectorAll(NOTE_DETAIL_SELECTORS.tags, noteContext);
  return tagElements
    .map((el) => cleanText(el.textContent))
    .filter((tag) => tag.length > 0 && tag.startsWith("#"))
    .map((tag) => tag.substring(1)); // 去掉 # 号
}

/**
 * 提取互动数据（基于图标智能定位）
 */
function extractInteractions(noteContext = document) {
  console.log("[SingleNote] Extracting interactions...");

  const direct = extractInteractionsFromEngageBar(noteContext);
  const byUse = extractInteractionsBySvgUse(noteContext);

  const likes =
    direct.likes > 0
      ? direct.likes
      : byUse.likes > 0
        ? byUse.likes
        : extractInteractionByIcon("like", noteContext);
  const collects =
    direct.collects > 0
      ? direct.collects
      : byUse.collects > 0
        ? byUse.collects
        : extractInteractionByIcon("collect", noteContext);
  const comments =
    direct.comments > 0
      ? direct.comments
      : byUse.comments > 0
        ? byUse.comments
        : extractInteractionByIcon("comment", noteContext);

  console.log("[SingleNote] Interactions extracted:", {
    likes,
    collects,
    comments,
  });

  return {likes, collects, comments};
}

function extractInteractionsBySvgUse(noteContext = document) {
  const map = {
    likes: ["#like", "like"],
    collects: ["#collect", "collect", "star"],
    comments: ["#chat", "#comment", "chat", "comment"],
  };

  const result = {
    likes: 0,
    collects: 0,
    comments: 0,
  };

  const useElements = noteContext.querySelectorAll("svg use");
  if (useElements.length === 0) {
    return result;
  }

  for (const [key, tokens] of Object.entries(map)) {
    for (const use of useElements) {
      const href =
        use.getAttribute("xlink:href") || use.getAttribute("href") || "";
      if (!href) continue;
      if (!tokens.some((token) => href.toLowerCase().includes(token))) continue;

      const iconRoot =
        use.closest(".like-wrapper, .collect-wrapper, .chat-wrapper") ||
        use.closest("span,button,div");
      if (!iconRoot) continue;

      const countCandidate =
        iconRoot.querySelector(".count") ||
        iconRoot.parentElement?.querySelector(".count") ||
        iconRoot.nextElementSibling;

      const text = cleanText(
        countCandidate?.textContent || iconRoot.textContent,
      );
      const numberMatch = text.match(/(\d+(?:\.\d+)?[wW万kK]?)/);
      if (!numberMatch) continue;

      const value = parseInteractionCount(numberMatch[1]);
      if (value > 0) {
        result[key] = value;
        break;
      }
    }
  }

  if (result.likes > 0 || result.collects > 0 || result.comments > 0) {
    console.log("[SingleNote] Interactions from svg use:", result);
  }

  return result;
}

function extractInteractionsFromEngageBar(noteContext = document) {
  const engageBar = querySelector(
    NOTE_DETAIL_SELECTORS.engageBar.container,
    noteContext,
  );
  if (!engageBar) {
    return {likes: 0, collects: 0, comments: 0};
  }

  const likesElement = querySelector(
    NOTE_DETAIL_SELECTORS.engageBar.likesCount,
    engageBar,
  );
  const collectsElement = querySelector(
    NOTE_DETAIL_SELECTORS.engageBar.collectsCount,
    engageBar,
  );
  const commentsElement = querySelector(
    NOTE_DETAIL_SELECTORS.engageBar.commentsCount,
    engageBar,
  );

  const likes = likesElement
    ? parseInteractionCount(cleanText(likesElement.textContent))
    : 0;
  const collects = collectsElement
    ? parseInteractionCount(cleanText(collectsElement.textContent))
    : 0;
  const comments = commentsElement
    ? parseInteractionCount(cleanText(commentsElement.textContent))
    : 0;

  if (likes > 0 || collects > 0 || comments > 0) {
    console.log("[SingleNote] Interactions from engage bar:", {
      likes,
      collects,
      comments,
    });
  }

  return {likes, collects, comments};
}

/**
 * 通过图标类型提取互动数字
 */
function extractInteractionByIcon(type, noteContext = document) {
  const iconKeywords = {
    like: ["heart", "like", "赞", "zan"],
    collect: ["star", "collect", "收藏", "shoucang"],
    comment: ["comment", "message", "chat", "评论", "pinglun"],
  };

  const keywords = iconKeywords[type];
  if (!keywords) return 0;

  // 策略1: 使用新的基于图标的选择器
  if (NOTE_DETAIL_SELECTORS.interactionsByIcon) {
    const config = NOTE_DETAIL_SELECTORS.interactionsByIcon[`${type}s`];
    if (config) {
      const engageBar = querySelector(
        NOTE_DETAIL_SELECTORS.engageBar.container,
        noteContext,
      );
      const countElement = engageBar
        ? querySelector(config.count, engageBar)
        : querySelector(config.count, noteContext);
      if (countElement) {
        const count = parseInteractionCount(
          cleanText(countElement.textContent),
        );
        if (count > 0) {
          console.log(`[SingleNote] ${type} count found by selector:`, count);
          return count;
        }
      }
    }
  }

  // 策略2: 通过图标HTML定位
  const engageBar = querySelector(
    NOTE_DETAIL_SELECTORS.engageBar.container,
    noteContext,
  );
  const buttonRoot = engageBar || noteContext;
  const buttons = buttonRoot.querySelectorAll(
    'button, div[role="button"], .left > span, .interact-bar > div',
  );
  for (const btn of buttons) {
    const html = btn.innerHTML.toLowerCase();
    const text = btn.textContent.trim();

    // 检查是否包含对应图标关键词
    const hasIcon = keywords.some((k) => html.includes(k.toLowerCase()));
    if (!hasIcon) continue;

    // 提取纯数字
    const numberMatch = text.match(/(\d+(?:\.\d+)?[wW万kK]?)/);
    if (numberMatch) {
      const count = parseInteractionCount(numberMatch[1]);
      console.log(`[SingleNote] ${type} count found by icon:`, count);
      return count;
    }
  }

  // 策略3: 通过位置兜底（按顺序：赞、藏、评）
  const positionIndex = {like: 0, collect: 1, comment: 2};
  const numbers = [
    ...buttonRoot.querySelectorAll(
      ".left > span .count, .interact-bar span, .action-bar span",
    ),
  ]
    .map((el) => cleanText(el.textContent))
    .filter((text) => /^\d+/.test(text))
    .map((text) => parseInteractionCount(text));

  const index = positionIndex[type];
  if (numbers[index] !== undefined) {
    console.log(
      `[SingleNote] ${type} count found by position:`,
      numbers[index],
    );
    return numbers[index];
  }

  console.warn(`[SingleNote] Failed to extract ${type} count`);
  return 0;
}

/**
 * 提取发布日期（增强版）
 */
function extractPublishDateRaw(noteContext = document) {
  const timeElement = noteContext.querySelector("time[datetime]");
  if (timeElement) {
    const datetime = timeElement.getAttribute("datetime");
    if (datetime) {
      return cleanText(datetime);
    }
  }

  const dateElement = querySelector(
    NOTE_DETAIL_SELECTORS.publishDate,
    noteContext,
  );
  return dateElement ? cleanText(dateElement.textContent) : "";
}

const CN_REGIONS = [
  "北京", "天津", "上海", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江",
  "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南",
  "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "台湾",
  "内蒙古", "广西", "西藏", "宁夏", "新疆", "香港", "澳门",
];

// 小红书 IP 属地常贴在发布日期同一元素尾部,如「编辑于 01-01 山东」。
// 用省级地区白名单兜底,避免把日期/其它文字误当属地。
function extractPublishLocation(noteContext = document) {
  try {
    const dateElement = querySelector(NOTE_DETAIL_SELECTORS.publishDate, noteContext);
    const text = dateElement ? cleanText(dateElement.textContent) : "";
    if (!text) return "";
    const tokens = text.split(/\s+/).filter(Boolean);
    const last = tokens[tokens.length - 1] || "";
    if (CN_REGIONS.includes(last)) return last;
    for (const region of CN_REGIONS) {
      if (text.includes(region)) return region;
    }
    // 境外:小红书会显示国家名,宽松取末尾纯中文 2-6 字且非日期词
    if (/^[一-龥]{2,6}$/.test(last) && !/(编辑|发布|今天|昨天|周|月|日|前|刚刚)/.test(last)) {
      return last;
    }
    return "";
  } catch (_) {
    return "";
  }
}

function extractLastEditedAt(noteContext = document) {
  console.log("[SingleNote] Extracting last edited time...");

  // 策略1: 尝试 time 标签的 datetime 属性
  const timeElement = noteContext.querySelector("time[datetime]");
  if (timeElement) {
    const datetime = timeElement.getAttribute("datetime");
    if (datetime) {
      const timestamp = new Date(datetime).getTime();
      if (Number.isFinite(timestamp)) {
        console.log("[SingleNote] Last edited from time[datetime]:", timestamp);
        return timestamp;
      }
    }
  }

  // 策略2: 使用选择器查找日期文本
  const dateElement = querySelector(
    NOTE_DETAIL_SELECTORS.publishDate,
    noteContext,
  );
  if (!dateElement) {
    console.warn("[SingleNote] Publish date element not found");
    return Date.now(); // 使用当前时间作为兜底
  }

  const dateText = cleanText(dateElement.textContent);
  console.log("[SingleNote] Date text found:", dateText);

  const timestamp = parseLastEditedTimestamp(dateText);
  if (!Number.isFinite(timestamp)) {
    console.warn("[SingleNote] Last edited parse failed, using current time");
    return Date.now();
  }

  console.log("[SingleNote] Final last edited timestamp:", timestamp);
  return timestamp;
}

function parseLastEditedTimestamp(rawText) {
  if (!rawText) return NaN;

  const text = cleanText(rawText)
    .replace(/^编辑于\s*/i, "")
    .trim();
  const now = new Date();

  // 昨天 17:46
  let match = text.match(/昨天\s*(\d{1,2})[:：](\d{2})/);
  if (match) {
    const [, hh, mm] = match;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      Number.parseInt(hh, 10),
      Number.parseInt(mm, 10),
      0,
      0,
    ).getTime();
  }

  // N天前 17:46
  match = text.match(/(\d+)\s*天前\s*(\d{1,2})[:：](\d{2})/);
  if (match) {
    const [, days, hh, mm] = match;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - Number.parseInt(days, 10),
      Number.parseInt(hh, 10),
      Number.parseInt(mm, 10),
      0,
      0,
    ).getTime();
  }

  // YYYY-MM-DD HH:mm / YYYY年MM月DD日 HH:mm
  match = text.match(
    /(\d{4})[年\-/\.](\d{1,2})[月\-/\.](\d{1,2})日?\s*(\d{1,2})[:：](\d{2})/,
  );
  if (match) {
    const [, y, m, d, hh, mm] = match;
    return new Date(
      Number.parseInt(y, 10),
      Number.parseInt(m, 10) - 1,
      Number.parseInt(d, 10),
      Number.parseInt(hh, 10),
      Number.parseInt(mm, 10),
      0,
      0,
    ).getTime();
  }

  // MM-DD HH:mm
  match = text.match(/(\d{1,2})-(\d{1,2})\s*(\d{1,2})[:：](\d{2})/);
  if (match) {
    const [, m, d, hh, mm] = match;
    return new Date(
      now.getFullYear(),
      Number.parseInt(m, 10) - 1,
      Number.parseInt(d, 10),
      Number.parseInt(hh, 10),
      Number.parseInt(mm, 10),
      0,
      0,
    ).getTime();
  }

  // 兜底：沿用旧逻辑，至少保留日期（分钟置 00）
  const normalizedDate = normalizeDate(text);
  if (normalizedDate) {
    return new Date(`${normalizedDate}T00:00:00`).getTime();
  }

  return NaN;
}

/**
 * 判断是否是视频笔记页面
 * @returns {boolean} 是否是视频笔记
 */
function isVideoNotePage(noteContext = document) {
  // 1. URL 级别标记
  const hasVideoInUrl = window.location.href.includes("/video/");

  // 2. 容器内是否有明显的视频播放器特有类名
  const hasPlayerWrapper = Boolean(
    noteContext.querySelector(".video-player, .xgplayer, xg-video-container"),
  );

  return hasVideoInUrl || hasPlayerWrapper;
}

function resolveNoteType(noteContext = document, media = {}) {
  if (isVideoNotePage(noteContext)) {
    return "video";
  }

  // 小红书图文笔记里可能带有 Live Photo/实况资源，不能仅凭 videoUrl 改判成视频。
  if (
    (Array.isArray(media?.images) && media.images.length > 0) ||
    media?.coverImage
  ) {
    return "image";
  }

  return media?.hasVideo ? "video" : "image";
}

/**
 * 提取媒体（区分封面图和正文图片）
 * @param {HTMLElement} noteContext - 笔记容器元素
 * @returns {Object} 媒体信息
 */
function extractMedia(noteContext = document, noteId = "") {
  console.log("[SingleNote] Extracting media from container...");
  const commentContainers = resolveCommentContainers(noteContext);
  const isVideoPage = isVideoNotePage(noteContext);

  // 在容器内查询视频元素
  let videoElement = isVideoPage
    ? querySelector(NOTE_DETAIL_SELECTORS.video, noteContext)
    : null;
  let hasVideo = Boolean(videoElement || isVideoPage);

  // 提取视频 URL（优先可外链 URL，避免 blob:）
  let videoUrlCandidates = isVideoPage
    ? collectPlayableVideoUrls(videoElement)
    : [];
  let videoUrl = videoUrlCandidates[0] || "";

  // 严格限定 hasVideo：不仅要有元素，要么有有效的长链接，要么带有特定的播放器外壳
  if (hasVideo && !videoUrl && !isVideoPage) {
    // 这可能是一个用来占位或隐藏的 video，过滤掉
    hasVideo = false;
    videoElement = null;
  }

  // 去除高风险的全局 video 查询，严格限制在容器内以防止误採背景视频
  if (!videoUrl && isVideoPage) {
    console.warn(
      "[SingleNote] Video element not found in container for a video note.",
    );
  }

  if (isVideoPage && !videoUrl) {
    videoUrl = extractVideoUrlFromMeta();
  }
  if (isVideoPage && !videoUrl) {
    videoUrl = extractVideoUrlFromPerformance();
  }
  if (isVideoPage && !videoUrl) {
    videoUrl = extractVideoUrlFromPageState();
  }
  if (videoUrl) {
    hasVideo = true;
  }
  const videoDuration = hasVideo ? extractVideoDuration(videoElement) : "";

  // 提取封面图
  let coverImage = "";
  let images = [];
  if (hasVideo) {
    coverImage = extractVideoCoverImage(videoElement, noteContext, noteId);
  } else {
    // 图文优先按 swiper 索引排序并去重（data-swiper-slide-index = 0 即封面）
    const orderedSwiperImages = extractOrderedSwiperImages(noteContext);
    if (orderedSwiperImages.length > 0) {
      images = orderedSwiperImages;
      coverImage = orderedSwiperImages[0];
    }
  }

  // 非轮播兜底提图（在容器内查询）
  if (!hasVideo && images.length === 0) {
    const imageElements = querySelectorAll(
      NOTE_DETAIL_SELECTORS.images,
      noteContext,
    ).filter((img) => !isInsideCommentContainer(img, commentContainers));
    images = imageElements
      .flatMap((img) => extractImageCandidateUrls(img))
      .map((url) => cleanImageUrl(url))
      .filter((url) => isLikelyContentImageUrl(url));
  }

  // 去重（保持顺序）
  let uniqueImages = [...new Set(images)];

  if (!hasVideo && uniqueImages.length === 0 && coverImage) {
    uniqueImages = [coverImage];
  }

  if (!coverImage && uniqueImages.length > 0) {
    coverImage = uniqueImages[0];
  }

  console.log("[SingleNote] Media extracted:", {
    hasVideo,
    videoUrl,
    videoUrlCandidates,
    coverImage,
    imageCount: uniqueImages.length,
  });

  const finalVideoUrls = isVideoPage
    ? [
        ...new Set(
          [
            videoUrl,
            ...videoUrlCandidates,
            extractVideoUrlFromMeta(),
            extractVideoUrlFromPerformance(),
            extractVideoUrlFromPageState(),
          ]
            .map((url) => normalizeMediaUrl(url))
            .filter((url) => isValidExternalVideoUrl(url)),
        ),
      ]
    : [];
  const browserPlayableVideoUrls =
    buildPreferredXiaohongshuVideoUrls(finalVideoUrls);

  return {
    hasVideo,
    videoUrl: browserPlayableVideoUrls[0] || "",
    videoUrls: browserPlayableVideoUrls,
    videoDuration,
    coverImage,
    images: uniqueImages,
  };
}

function buildPreferredXiaohongshuVideoUrls(urls = []) {
  const preferred = [];
  const seen = new Set();

  const push = (url) => {
    const normalized = normalizeMediaUrl(url);
    if (!isValidExternalVideoUrl(normalized) || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    preferred.push(normalized);
  };

  (Array.isArray(urls) ? urls : []).forEach((url) => {
    const normalized = normalizeMediaUrl(url);
    if (!normalized) {
      return;
    }

    // 小红书的 v3 链接在部分设备上会黑屏，优先尝试同路径 v6 版本做浏览器预览。
    if (/https?:\/\/sns-video-v3\.xhscdn\.com\//i.test(normalized)) {
      push(normalized.replace(/\/\/sns-video-v3\.xhscdn\.com\//i, "//sns-video-v6.xhscdn.com/"));
    }

    push(normalized);
  });

  return preferred;
}

function collectPlayableVideoUrls(videoElement) {
  const candidates = [];

  if (videoElement) {
    candidates.push(
      videoElement.currentSrc,
      videoElement.src,
      videoElement.getAttribute("src"),
      videoElement.getAttribute("data-src"),
      videoElement.getAttribute("data-url"),
    );

    const sourceElements = videoElement.querySelectorAll("source");
    sourceElements.forEach((source) => {
      candidates.push(
        source.src,
        source.getAttribute("src"),
        source.getAttribute("data-src"),
      );
    });
  }

  const rootVideo = document.querySelector(".player-el video, .xgplayer video");
  if (rootVideo && rootVideo !== videoElement) {
    candidates.push(
      rootVideo.currentSrc,
      rootVideo.src,
      rootVideo.getAttribute("src"),
      rootVideo.getAttribute("data-src"),
    );
  }

  const normalizedList = [
    ...new Set(
      candidates
        .map((candidate) => normalizeMediaUrl(candidate))
        .filter((url) => isValidExternalVideoUrl(url)),
    ),
  ];

  return normalizedList;
}

function extractVideoUrlFromMeta() {
  const metaSelectors = [
    'meta[property="og:video"]',
    'meta[name="og:video"]',
    'meta[property="og:video:url"]',
    'meta[name="twitter:player:stream"]',
  ];

  for (const selector of metaSelectors) {
    const meta = document.querySelector(selector);
    const content = meta?.getAttribute("content") || "";
    const normalized = normalizeMediaUrl(content);
    if (isValidExternalVideoUrl(normalized)) {
      return normalized;
    }
  }

  return "";
}

function extractVideoUrlFromPerformance() {
  try {
    const entries = performance.getEntriesByType("resource") || [];
    const candidates = entries
      .filter((entry) => {
        const url = String(entry?.name || "");
        const type = String(entry?.initiatorType || "");
        if (type === "img" || type === "css" || type === "script") return false;

        return (
          type === "video" ||
          type === "media" ||
          /(\.mp4|\.m3u8|\.webm)/i.test(url) ||
          (/(xhscdn|xiaohongshu)/i.test(url) &&
            /(video|stream|play|master|playlist|hls|dash|media|vod|origin|transcode)/i.test(
              url,
            ))
        );
      })
      .sort((a, b) => Number(b.startTime || 0) - Number(a.startTime || 0))
      .map((entry) => normalizeMediaUrl(String(entry?.name || "")))
      .filter((url) => isValidExternalVideoUrl(url));

    return candidates[0] || "";
  } catch {
    return "";
  }
}

function extractVideoUrlFromPageState() {
  // 1) 尝试常见全局状态对象
  const stateCandidates = [
    globalThis.__INITIAL_STATE__,
    globalThis.__INIT_STATE__,
    globalThis.__REDUX_STATE__,
  ];

  for (const state of stateCandidates) {
    const url = extractVideoUrlFromUnknownState(state);
    if (url) return url;
  }

  // 2) 兜底：扫描内联脚本中的视频链接
  const scripts = Array.from(document.querySelectorAll("script"));
  for (const script of scripts) {
    const text = script?.textContent || "";
    if (!text || text.length < 20) continue;
    const matched = text.match(/https?:\/\/[^"'\s\\]+/gi);
    if (!matched || matched.length === 0) continue;
    const found = matched
      .map((url) => normalizeMediaUrl(url))
      .find((url) => isValidExternalVideoUrl(url));
    if (found) return found;
  }

  return "";
}

function extractVideoUrlFromUnknownState(state) {
  if (!state) return "";

  const queue = [state];
  const seen = new Set();
  let scanned = 0;

  while (queue.length > 0 && scanned < 2000) {
    scanned += 1;
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    if (typeof current === "object") {
      seen.add(current);
    }

    if (typeof current === "string") {
      const normalized = normalizeMediaUrl(current);
      if (isValidExternalVideoUrl(normalized)) {
        return normalized;
      }
      continue;
    }

    if (Array.isArray(current)) {
      current.forEach((item) => queue.push(item));
      continue;
    }

    if (current && typeof current === "object") {
      Object.entries(current).forEach(([key, value]) => {
        if (typeof value === "string") {
          const normalized = normalizeMediaUrl(value);
          if (
            isValidExternalVideoUrl(normalized) &&
            /(video|media|play|stream|url|master|origin|h264)/i.test(key)
          ) {
            queue.unshift(value);
          } else {
            queue.push(value);
          }
        } else {
          queue.push(value);
        }
      });
    }
  }

  return "";
}

function extractVideoCoverImage(videoElement, noteContext = document, noteId = "") {
  const candidates = [];

  if (videoElement) {
    candidates.push(...extractCoverImageCandidatesFromElement(videoElement));
  }

  // 在容器内查询封面元素
  const coverElement = querySelector(
    NOTE_DETAIL_SELECTORS.coverImage,
    noteContext,
  );
  if (coverElement) {
    candidates.push(...extractCoverImageCandidatesFromElement(coverElement));
  }

  // 在容器内查询 xg-poster
  const xgPoster = noteContext.querySelector("xg-poster, .xgplayer-poster");
  if (xgPoster) {
    candidates.push(...extractCoverImageCandidatesFromElement(xgPoster));
  }

  if (noteId) {
    resolveNoteScopedMediaRoots(noteId).forEach((root) => {
      candidates.push(...extractCoverImageCandidatesFromElement(root));
    });

    candidates.push(...extractImageCandidatesFromScriptsByNoteId(noteId));
  }

  // 如果容器内/当前 noteId 找不到，仅在全局 poster 唯一时回退，避免 SPA 旧播放器污染封面。
  if (candidates.filter(Boolean).length === 0) {
    const globalPosters = collectGlobalPosterFallbackElements();
    if (globalPosters.length === 1) {
      candidates.push(
        ...extractCoverImageCandidatesFromElement(globalPosters[0]),
      );
    } else if (globalPosters.length > 1) {
      console.warn(
        "[SingleNote] Multiple global video posters found; skipping ambiguous cover fallback.",
      );
    }
  }

  const usableCandidates = candidates
    .map((candidate) => cleanImageUrl(candidate))
    .filter((url) => isLikelyContentImageUrl(url));
  if (usableCandidates.length > 0) {
    return usableCandidates[0];
  }

  // og:image 保留为最后兜底；在小红书 SPA 中它可能是上一条笔记的旧值。
  const metaCover = document.querySelector(
    'meta[property="og:image"], meta[name="og:image"]',
  );
  const normalizedMetaCover = cleanImageUrl(
    metaCover?.getAttribute("content") || "",
  );
  if (normalizedMetaCover && isLikelyContentImageUrl(normalizedMetaCover)) {
    console.warn(
      "[SingleNote] Falling back to og:image for video cover; it may be stale on SPA pages.",
    );
    return normalizedMetaCover;
  }

  return "";
}

function extractCoverImageCandidatesFromElement(element) {
  if (!(element instanceof Element)) {
    return [];
  }

  const candidates = [
    extractBackgroundImageUrl(element),
    element.currentSrc,
    element.src,
    element.poster,
    element.getAttribute?.("poster"),
    element.getAttribute?.("src"),
    element.getAttribute?.("data-src"),
    element.getAttribute?.("data-lazy-src"),
    element.getAttribute?.("data-origin"),
    element.getAttribute?.("data-original"),
    element.dataset?.src,
    element.dataset?.lazySrc,
    element.dataset?.origin,
  ];

  if (element.matches?.("img")) {
    candidates.push(...extractImageCandidateUrls(element));
  }

  element
    .querySelectorAll?.(
      "img, video[poster], xg-poster, .xgplayer-poster, [style*='background-image']",
    )
    .forEach((child) => {
      if (child.matches?.("img")) {
        candidates.push(...extractImageCandidateUrls(child));
      } else {
        candidates.push(
          extractBackgroundImageUrl(child),
          child.poster,
          child.getAttribute?.("poster"),
          child.getAttribute?.("src"),
          child.getAttribute?.("data-src"),
        );
      }
    });

  return [
    ...new Set(candidates.map((url) => normalizeMediaUrl(url)).filter(Boolean)),
  ];
}

function resolveNoteScopedMediaRoots(noteId) {
  const normalizedNoteId = String(noteId || "").trim();
  if (!normalizedNoteId) {
    return [];
  }

  const escapedNoteId = escapeCssString(normalizedNoteId);
  const selectors = [
    `[data-note-id="${escapedNoteId}"]`,
    `[data-id="${escapedNoteId}"]`,
    `[data-item-id="${escapedNoteId}"]`,
    `a[href*="/explore/${escapedNoteId}"]`,
    `a[href*="/video/${escapedNoteId}"]`,
    `a[href*="/discovery/item/${escapedNoteId}"]`,
    `a[href*="${escapedNoteId}"]`,
    `[data-href*="${escapedNoteId}"]`,
    `[data-url*="${escapedNoteId}"]`,
  ];

  const roots = [];
  const seen = new Set();
  queryElementsBySelectors(selectors).forEach((element) => {
    const root = resolveNoteScopedMediaRoot(element, normalizedNoteId);
    if (!root || seen.has(root)) {
      return;
    }
    seen.add(root);
    roots.push(root);
  });

  return roots;
}

function resolveNoteScopedMediaRoot(element, noteId) {
  if (!(element instanceof Element)) {
    return null;
  }

  if (elementMatchesNoteId(element, noteId)) {
    return element;
  }

  const cardRoot = element.closest?.(
    [
      ".note-item",
      ".feed-item",
      ".explore-item",
      ".cover",
      "[data-note-id]",
      "[data-id]",
      "[data-item-id]",
      "article",
      "li",
    ].join(","),
  );

  if (cardRoot && elementMatchesNoteId(cardRoot, noteId)) {
    return cardRoot;
  }

  return element;
}

function elementMatchesNoteId(element, noteId) {
  if (!(element instanceof Element) || !noteId) {
    return false;
  }

  const directValues = [
    element.getAttribute?.("data-note-id"),
    element.getAttribute?.("data-id"),
    element.getAttribute?.("data-item-id"),
    element.getAttribute?.("href"),
    element.getAttribute?.("data-href"),
    element.getAttribute?.("data-url"),
  ];
  if (directValues.some((value) => String(value || "").includes(noteId))) {
    return true;
  }

  return Boolean(
    element.querySelector?.(
      [
        `a[href*="${escapeCssString(noteId)}"]`,
        `[data-href*="${escapeCssString(noteId)}"]`,
        `[data-url*="${escapeCssString(noteId)}"]`,
      ].join(","),
    ),
  );
}

function queryElementsBySelectors(selectors, root = document) {
  const elements = [];
  const seen = new Set();

  selectors.forEach((selector) => {
    try {
      root.querySelectorAll?.(selector).forEach((element) => {
        if (!seen.has(element)) {
          seen.add(element);
          elements.push(element);
        }
      });
    } catch {
      // ignore invalid selector
    }
  });

  return elements;
}

function collectGlobalPosterFallbackElements() {
  return queryElementsBySelectors([
    "xg-poster",
    ".xgplayer-poster",
    "video[poster]",
  ]).filter((element) => {
    const coverCandidates = extractCoverImageCandidatesFromElement(element)
      .map((url) => cleanImageUrl(url))
      .filter((url) => isLikelyContentImageUrl(url));
    return coverCandidates.length > 0 && isElementVisibleEnough(element);
  });
}

function extractImageCandidatesFromScriptsByNoteId(noteId) {
  const normalizedNoteId = String(noteId || "").trim();
  if (!normalizedNoteId) {
    return [];
  }

  const candidates = [];
  Array.from(document.querySelectorAll("script")).forEach((script) => {
    const text = script?.textContent || "";
    if (!text || !text.includes(normalizedNoteId)) {
      return;
    }

    let startIndex = 0;
    while (startIndex >= 0) {
      const matchIndex = text.indexOf(normalizedNoteId, startIndex);
      if (matchIndex < 0) {
        break;
      }
      const windowText = text.slice(
        Math.max(0, matchIndex - 4000),
        Math.min(text.length, matchIndex + 4000),
      );
      const matches = windowText.match(/https?:\\?\/\\?\/[^"'\s\\]+/gi) || [];
      matches.forEach((url) => candidates.push(decodeScriptUrlCandidate(url)));
      startIndex = matchIndex + normalizedNoteId.length;
    }
  });

  return candidates
    .map((url) => cleanImageUrl(url))
    .filter((url) => isLikelyContentImageUrl(url));
}

function decodeScriptUrlCandidate(url) {
  return String(url || "")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function escapeCssString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isElementVisibleEnough(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  const rect = element.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const style = window.getComputedStyle?.(element);
  if (!style) {
    return true;
  }

  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number.parseFloat(style.opacity || "1") > 0
  );
}

function extractVideoDuration(videoElement) {
  const durationCandidates = [];

  if (
    videoElement &&
    Number.isFinite(videoElement.duration) &&
    videoElement.duration > 0
  ) {
    durationCandidates.push(secondsToDurationText(videoElement.duration));
  }

  const rootVideo = document.querySelector(".player-el video, .xgplayer video");
  if (
    rootVideo &&
    Number.isFinite(rootVideo.duration) &&
    rootVideo.duration > 0
  ) {
    durationCandidates.push(secondsToDurationText(rootVideo.duration));
  }

  const playerDurationText = document.querySelector(
    ".xgplayer-time span:last-child",
  )?.textContent;
  if (playerDurationText) {
    durationCandidates.push(playerDurationText);
  }

  const metaDuration = document
    .querySelector('meta[property="og:videotime"]')
    ?.getAttribute("content");
  if (metaDuration) {
    durationCandidates.push(metaDuration);
  }

  for (const candidate of durationCandidates) {
    const normalized = normalizeDurationText(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function extractOrderedSwiperImages(noteContext = document) {
  const commentContainers = resolveCommentContainers(noteContext);
  const slideElements = noteContext.querySelectorAll(
    ".note-slider .swiper-slide[data-swiper-slide-index], .swiper .swiper-slide[data-swiper-slide-index]",
  );
  if (slideElements.length === 0) {
    return [];
  }

  const imagesByIndex = new Map();
  slideElements.forEach((slide) => {
    if (isInsideCommentContainer(slide, commentContainers)) {
      return;
    }
    const indexRaw =
      slide.getAttribute("data-swiper-slide-index") ||
      slide.getAttribute("data-index");
    const index = Number.parseInt(indexRaw || "", 10);
    if (!Number.isFinite(index)) {
      return;
    }

    const imageElement = slide.querySelector("img");
    const rawUrl =
      imageElement?.getAttribute("src") ||
      imageElement?.getAttribute("data-src") ||
      imageElement?.getAttribute("data-lazy-src") ||
      imageElement?.getAttribute("data-origin") ||
      imageElement?.currentSrc ||
      imageElement?.dataset?.src ||
      extractBackgroundImageUrl(slide) ||
      "";
    const url = cleanImageUrl(rawUrl);

    if (!url || !isLikelyContentImageUrl(url)) {
      return;
    }

    if (!imagesByIndex.has(index)) {
      imagesByIndex.set(index, url);
    }
  });

  return [...imagesByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);
}

function resolveCommentContainers(noteContext = document) {
  return querySelectorAll(COMMENTS_SELECTORS.container, noteContext).filter(
    (node) => node && typeof node.contains === "function",
  );
}

function isInsideCommentContainer(node, commentContainers = []) {
  if (!node || !Array.isArray(commentContainers) || commentContainers.length === 0) {
    return false;
  }
  return commentContainers.some((container) => container !== node && container.contains(node));
}

function extractBackgroundImageUrl(element) {
  if (!element) return "";
  const holders = [
    element,
    ...Array.from(
      element.querySelectorAll?.('[style*="background-image"]') || [],
    ),
  ];
  for (const holder of holders) {
    const style = holder.getAttribute?.("style") || "";
    const match = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
    if (match?.[2]) {
      return match[2];
    }
  }
  return "";
}

function extractImageCandidateUrls(imageElement) {
  if (!imageElement) return [];

  const candidates = [
    imageElement.currentSrc,
    imageElement.src,
    imageElement.getAttribute("src"),
    imageElement.getAttribute("data-src"),
    imageElement.getAttribute("data-lazy-src"),
    imageElement.getAttribute("data-origin"),
    imageElement.getAttribute("data-original"),
    imageElement.dataset?.src,
    imageElement.dataset?.lazySrc,
    imageElement.dataset?.origin,
  ];

  const srcset = imageElement.getAttribute("srcset") || "";
  if (srcset) {
    srcset
      .split(",")
      .map((item) => item.trim().split(/\s+/)[0])
      .filter(Boolean)
      .forEach((url) => candidates.push(url));
  }

  return [...new Set(candidates.map((url) => normalizeMediaUrl(url)).filter(Boolean))];
}

/**
 * 等待页面 Hydration 完成
 * @returns {Promise<boolean>} 是否在超时前完成 hydration
 */
async function waitForPageHydration() {
  const maxAttempts = 10;
  const interval = 300;

  console.log("[SingleNote] Waiting for page hydration...");

  for (let i = 0; i < maxAttempts; i++) {
    // 检查标题已加载且非空
    const title = querySelector(NOTE_DETAIL_SELECTORS.title);
    const hasValidTitle = title && cleanText(title.textContent).length > 0;

    // 检查作者容器已渲染（有子元素）
    const authorContainer = querySelector(
      NOTE_DETAIL_SELECTORS.author.container,
    );
    const hasAuthor = authorContainer && authorContainer.children.length > 0;

    // 检查内容区已加载
    const content = querySelector(NOTE_DETAIL_SELECTORS.content);
    const hasContent = Boolean(content);

    // 可选：检查视频播放器（如果可能是视频笔记）
    const videoPlayer = document.querySelector(
      "video, .xgplayer, .video-player",
    );
    const hasVideoPlayerIfNeeded = !isVideoNotePage() || Boolean(videoPlayer);

    if (hasValidTitle && hasAuthor && hasContent && hasVideoPlayerIfNeeded) {
      console.log(
        `[SingleNote] Page hydration complete after ${(i + 1) * interval}ms`,
      );
      return true;
    }

    await wait(interval);
  }

  console.warn(
    "[SingleNote] Page hydration timeout after 3s, proceeding with caution",
  );
  return false;
}

/**
 * 等待关键区块（互动区、媒体区、视频元素）加载
 * @returns {Promise<void>}
 */
async function waitForCriticalBlocks() {
  const maxAttempts = 8; // 从 6 增加到 8，最大等待 2.8 秒
  console.log("[SingleNote] Waiting for critical blocks...");

  for (let i = 0; i < maxAttempts; i++) {
    // 原有检查：互动区 SVG 图标
    const useElements = document.querySelectorAll("svg use");
    const hasLikeUse = [...useElements].some((use) => {
      const href =
        use.getAttribute("xlink:href") || use.getAttribute("href") || "";
      return href.toLowerCase().includes("like");
    });

    // 原有检查：互动数据
    const hasCounts = Boolean(
      querySelector(NOTE_DETAIL_SELECTORS.engageBar.likesCount) ||
      querySelector(NOTE_DETAIL_SELECTORS.engageBar.collectsCount) ||
      querySelector(NOTE_DETAIL_SELECTORS.engageBar.commentsCount) ||
      hasLikeUse,
    );

    // 原有检查：图片轮播
    const hasMedia = Boolean(
      document.querySelector(
        ".note-slider .swiper-slide[data-swiper-slide-index], .swiper .swiper-slide[data-swiper-slide-index], .note-slider img",
      ),
    );

    // 新增检查：视频播放器元素
    const videoPlayer = document.querySelector(
      "video, .xgplayer, .video-player",
    );
    const hasVideoPlayer = Boolean(videoPlayer);

    // 新增检查：视频源已加载
    let hasVideoSource = false;
    if (videoPlayer && videoPlayer.tagName === "VIDEO") {
      // 只要 video 元素有 src 哪怕是 blob: 也是加载完成的标识
      const hasSrc = Boolean(videoPlayer.src || videoPlayer.currentSrc);
      const hasSourceElement = videoPlayer.querySelector("source[src]");
      hasVideoSource = hasSrc || Boolean(hasSourceElement);
    } else if (hasVideoPlayer) {
      // 对于自定义播放器（如 xgplayer），检查内部是否有 video 元素
      const innerVideo = document.querySelector(
        ".xgplayer video, .video-player video",
      );
      hasVideoSource = Boolean(innerVideo);
    }

    // 判断条件：有互动数据 OR 有图片 OR (有视频播放器 AND 有视频源)
    if (hasCounts || hasMedia || (hasVideoPlayer && hasVideoSource)) {
      console.log(
        `[SingleNote] Critical blocks loaded after ${(i + 1) * 350}ms:`,
        {
          hasCounts,
          hasMedia,
          hasVideoPlayer,
          hasVideoSource,
        },
      );
      return;
    }

    await wait(350);
  }

  console.warn("[SingleNote] Critical blocks wait timeout after 2.8s");
}

/**
 * 清理图片URL（规范化并保留查询参数）
 */
function cleanImageUrl(url) {
  if (!url) return "";
  const normalized = normalizeMediaUrl(url);
  if (!normalized || normalized.startsWith("blob:")) {
    return "";
  }
  // 保留查询参数，避免签名链路被破坏
  return normalized;
}

function secondsToDurationText(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;

  if (hh > 0) {
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function normalizeDurationText(text) {
  if (!text) return "";
  const raw = cleanText(String(text));
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return "";

  if (match[3] !== undefined) {
    const hh = String(Number.parseInt(match[1], 10)).padStart(2, "0");
    const mm = String(Number.parseInt(match[2], 10)).padStart(2, "0");
    const ss = String(Number.parseInt(match[3], 10)).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  const mm = String(Number.parseInt(match[1], 10)).padStart(2, "0");
  const ss = String(Number.parseInt(match[2], 10)).padStart(2, "0");
  return `${mm}:${ss}`;
}

function normalizeMediaUrl(url) {
  if (!url || typeof url !== "string") return "";
  let normalized = url.trim();
  if (!normalized) return "";
  normalized = normalized.replace(/^url\((['"]?)(.*?)\1\)$/i, "$2").trim();
  if (normalized.startsWith("//")) {
    normalized = `https:${normalized}`;
  } else if (normalized.startsWith("http://")) {
    normalized = normalized.replace(/^http:\/\//i, "https://");
  }
  return normalized;
}

function isValidExternalVideoUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/^blob:/i.test(url) || /^data:/i.test(url)) return false;

  const lower = url.toLowerCase();
  if (isLikelyContentImageUrl(lower)) return false;
  if (/\.(json|js|css|svg|ico)(\?|$)/i.test(lower)) return false;
  if (/avatar|emoji|icon|favicon|logo|thumbnail|cover/i.test(lower)) {
    return false;
  }

  if (/\.(mp4|m3u8|webm)(\?|$)/i.test(lower)) {
    return true;
  }

  const hasVideoKeyword =
    /(video|stream|play|master|playlist|hls|dash|media|vod|origin|transcode)/i.test(
      lower,
    );
  const hasTrustedHost = /(xhscdn|xiaohongshu|xiaohongshu\.com)/i.test(lower);

  return hasVideoKeyword && hasTrustedHost;
}

function isLikelyContentImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  const lower = url.toLowerCase();
  if (!/^https?:\/\//i.test(lower)) return false;
  if (/^blob:/i.test(lower) || /^data:/i.test(lower)) return false;
  if (/\.(mp4|m3u8|webm)(\?|$)/i.test(lower)) return false;
  if (/avatar|emoji|icon|favicon|logo|sprite|badge/i.test(lower)) return false;

  if (/\.(jpg|jpeg|png|webp|avif|heic|gif)(\?|$)/i.test(lower)) return true;

  return /(xhscdn|xiaohongshu|image|img|photo|pic|cover)/i.test(lower);
}
