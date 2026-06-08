/**
 * OnStarVoice V1.0 Content Script
 * 在小红书/抖音页面上运行的内容脚本
 *
 * 职责：
 * 1. 监听来自 sidebar/background 的消息
 * 2. 调用新的采集模块
 * 3. 返回采集结果
 */

import {
  smartCapture,
  captureSingleNote,
  captureBloggerProfile,
  captureBloggerNotes,
  captureKeywordNotes,
  detectKeywordSortDimension,
  captureComments,
} from "./utils/capture/index.js";

import {expandKeywordViaSuggestions} from "./utils/capture/keyword-expansion.js";

import {detectPageType} from "./utils/helpers.js";
import {setCancelFlag, resetCancelFlag} from "./utils/scroll.js";

console.log("[OnStarVoice V1.0] Content script loaded");

function safeRuntimeSendMessage(message) {
  try {
    if (
      typeof chrome === "undefined" ||
      !chrome?.runtime?.id ||
      typeof chrome.runtime.sendMessage !== "function"
    ) {
      return false;
    }

    chrome.runtime.sendMessage(message, () => {
      // Swallow disconnected/invalidated runtime errors in content world.
      void chrome.runtime?.lastError;
    });
    return true;
  } catch (error) {
    const text = String(error?.message || error || "");
    if (/extension context invalidated/i.test(text)) {
      return false;
    }
    console.warn("[Content] sendMessage failed:", error);
    return false;
  }
}

// ==================== 消息监听器 ====================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action !== "detectSearchSortDimension") {
    console.log("[Content] Received message:", request.action);
  }

  switch (request.action) {
    case "detectPageType":
      handleDetectPageType(sendResponse);
      return true;

    case "smartCapture":
      handleSmartCapture(request, sendResponse);
      return true;

    case "captureSingleNote":
      handleCaptureSingleNote(request, sendResponse);
      return true;

    case "captureBloggerProfile":
      handleCaptureBloggerProfile(request, sendResponse);
      return true;

    case "captureBloggerNotes":
      handleCaptureBloggerNotes(request, sendResponse);
      return true;

    case "captureKeywordNotes":
      handleCaptureKeywordNotes(request, sendResponse);
      return true;

    case "prepareKeywordStrategyCapture":
      handlePrepareKeywordStrategyCapture(sendResponse);
      return true;

    case "expandKeywordSuggestions":
      handleExpandKeywordSuggestions(request, sendResponse);
      return true;

    case "detectSearchSortDimension":
      handleDetectSearchSortDimension(sendResponse);
      return true;

    case "captureComments":
      handleCaptureComments(request, sendResponse);
      return true;

    case "cancelCapture":
      handleCancelCapture(sendResponse);
      return true;

    default:
      console.warn("[Content] Unknown action:", request.action);
      sendResponse({
        ok: false,
        error: {code: "UNKNOWN_ACTION", message: "未知操作"},
      });
      return false;
  }
});

// ==================== 消息处理函数 ====================

/**
 * 处理页面类型检测
 */
function handleDetectPageType(sendResponse) {
  try {
    const pageType = detectPageType(window.location.href);
    sendResponse({ok: true, pageType});
  } catch (error) {
    console.error("[Content] Detect page type failed:", error);
    sendResponse({
      ok: false,
      error: {code: "DETECT_FAILED", message: error.message},
    });
  }
}

/**
 * 处理智能采集
 */
async function handleSmartCapture(request, sendResponse) {
  try {
    resetCancelFlag();

    const result = await smartCapture({
      mode: request.mode || "auto",
      onProgress: (progress) => {
        // 发送进度更新到 background
        safeRuntimeSendMessage({
          action: "captureProgress",
          progress,
        });
      },
    });

    sendResponse(result);
  } catch (error) {
    console.error("[Content] Smart capture failed:", error);
    sendResponse({
      ok: false,
      type: null,
      data: null,
      meta: {
        pageType: detectPageType(window.location.href),
        captureStartedAt: new Date().toISOString(),
        captureFinishedAt: new Date().toISOString(),
      },
      error: {
        code: "CAPTURE_FAILED",
        message: error.message,
      },
    });
  }
}

/**
 * 处理单篇笔记采集
 */
async function handleCaptureSingleNote(request, sendResponse) {
  try {
    resetCancelFlag();

    const result = await captureSingleNote({
      includeBloggerMetrics: Boolean(request.includeBloggerMetrics),
      preferWorksTabForBloggerMetrics: Boolean(
        request.preferWorksTabForBloggerMetrics,
      ),
    });
    sendResponse(result);
  } catch (error) {
    console.error("[Content] Capture single note failed:", error);
    sendResponse({
      ok: false,
      type: "single_note",
      data: null,
      error: {code: "CAPTURE_FAILED", message: error.message},
    });
  }
}

/**
 * 处理博主信息采集
 */
async function handleCaptureBloggerProfile(request, sendResponse) {
  try {
    resetCancelFlag();

    const result = await captureBloggerProfile();
    sendResponse(result);
  } catch (error) {
    console.error("[Content] Capture blogger profile failed:", error);
    sendResponse({
      ok: false,
      type: "blogger_profile",
      data: null,
      error: {code: "CAPTURE_FAILED", message: error.message},
    });
  }
}

/**
 * 处理博主笔记列表采集
 */
async function handleCaptureBloggerNotes(request, sendResponse) {
  try {
    resetCancelFlag();

    const result = await captureBloggerNotes({
      onProgress: (progress) => {
        safeRuntimeSendMessage({
          action: "captureProgress",
          progress,
        });
      },
      profileMetrics: request.profileMetrics,
      minLikes: request.minLikes,
      maxDetectedItems: request.maxDetectedItems ?? request.maxItems,
      keywordFilter: request.keywordFilter || "",
      waitMinMs: request.waitMinMs,
      waitMaxMs: request.waitMaxMs,
      stallTimeoutMs: request.stallTimeoutMs,
      maxDurationMs: request.maxDurationMs,
      maxScrollTimes: request.maxScrollTimes || 50,
    });

    sendResponse(result);
  } catch (error) {
    console.error("[Content] Capture blogger notes failed:", error);
    sendResponse({
      ok: false,
      type: "blogger_notes",
      data: null,
      error: {code: "CAPTURE_FAILED", message: error.message},
    });
  }
}

/**
 * 处理关键词搜索结果采集
 */
async function handleCaptureKeywordNotes(request, sendResponse) {
  try {
    resetCancelFlag();

    const result = await captureKeywordNotes({
      keyword: request.keyword,
      onProgress: (progress) => {
        safeRuntimeSendMessage({
          action: "captureProgress",
          progress,
        });
      },
      minLikes: request.minLikes,
      sortDimension: request.sortDimension,
      maxDetectedItems: request.maxDetectedItems ?? request.maxItems,
      maxDurationMs: request.maxDurationMs,
      waitMinMs: request.waitMinMs,
      waitMaxMs: request.waitMaxMs,
      stallTimeoutMs: request.stallTimeoutMs,
      maxScrollTimes: request.maxScrollTimes || 50,
    });

    sendResponse(result);
  } catch (error) {
    console.error("[Content] Capture keyword notes failed:", error);
    sendResponse({
      ok: false,
      type: "keyword_notes",
      data: null,
      error: {code: "CAPTURE_FAILED", message: error.message},
    });
  }
}

/**
 * 处理关键词裂变扩词
 */
async function handleExpandKeywordSuggestions(request, sendResponse) {
  try {
    resetCancelFlag();
    const result = await expandKeywordViaSuggestions({
      seedKeyword: request.seedKeyword,
      platform: request.platform,
      onProgress: (progress) => {
        safeRuntimeSendMessage({
          action: "expandKeywordProgress",
          progress,
        });
      },
      delayBetweenMs: request.delayBetweenMs,
    });

    sendResponse({ok: true, data: result});
  } catch (error) {
    console.error("[Content] Expand keyword suggestions failed:", error);
    const isCanceledByUser =
      String(error?.message || "") === "EXPAND_KEYWORD_CANCELED";
    sendResponse({
      ok: false,
      data: null,
      error: {
        code: isCanceledByUser
          ? "EXPAND_KEYWORD_CANCELED"
          : "EXPAND_KEYWORD_FAILED",
        message: isCanceledByUser ? "扩词已取消" : error.message,
      },
    });
  }
}

function handleDetectSearchSortDimension(sendResponse) {
  try {
    const result = detectKeywordSortDimension();
    sendResponse({
      ok: true,
      data: result,
    });
  } catch (error) {
    console.error("[Content] Detect search sort dimension failed:", error);
    sendResponse({
      ok: false,
      error: {code: "DETECT_SORT_FAILED", message: error.message},
    });
  }
}

async function handlePrepareKeywordStrategyCapture(sendResponse) {
  try {
    const result = await prepareKeywordStrategyCapture();
    sendResponse({
      ok: true,
      data: result,
    });
  } catch (error) {
    console.error("[Content] Prepare keyword strategy capture failed:", error);
    sendResponse({
      ok: false,
      error: {
        code: "PREPARE_KEYWORD_STRATEGY_FAILED",
        message: error.message,
      },
    });
  }
}

async function prepareKeywordStrategyCapture() {
  const pageType = detectPageType(window.location.href);
  if (pageType !== "search_results") {
    throw new Error("当前页面不是搜索页，无法切换策略筛选条件");
  }

  const notes = [];
  const platform = /douyin\.com/i.test(window.location.href)
    ? "douyin"
    : /xiaohongshu\.com/i.test(window.location.href)
      ? "xiaohongshu"
      : "unknown";

  // Step 1: Open filter panel
  const panelOpened = await ensureKeywordStrategyFilterPanelOpen(notes);
  if (!panelOpened) {
    return {
      ok: true,
      data: {
        appliedSort: false,
        appliedRecency: false,
        appliedNoteType: false,
        notes,
      },
    };
  }

  // Step 2: Apply sort -- "最多点赞"
  const appliedSort = await applyStrategyFilterInSection(
    ["排序依据", "排序"],
    ["最多点赞", "点赞最多", "按点赞"],
    notes,
    "排序",
  );

  if (appliedSort) {
    // XHS refreshes results after sort change; wait and re-open the panel
    await waitForKeywordStrategyUi(2000);
    await ensureKeywordStrategyFilterPanelOpen(notes);
    await waitForKeywordStrategyUi(600);
  }

  // Step 3: Apply time filter -- "半年内"
  const appliedRecency = await applyStrategyFilterInSection(
    ["发布时间", "时间"],
    ["半年内", "最近半年", "近半年"],
    notes,
    "时间",
  );

  if (appliedRecency) {
    await waitForKeywordStrategyUi(1200);
    await ensureKeywordStrategyFilterPanelOpen(notes);
    await waitForKeywordStrategyUi(500);
  }

  // Step 4: Apply note type -- "不限"
  const appliedNoteType = await applyStrategyFilterInSection(
    platform === "douyin"
      ? ["内容形式", "作品类型", "类型", "内容类型", "笔记类型"]
      : ["笔记类型", "内容类型", "类型"],
    ["不限", "全部"],
    notes,
    "类型",
  );

  // Final wait for results to settle
  await waitForKeywordStrategyUi(
    appliedSort || appliedRecency || appliedNoteType ? 2000 : 900,
  );

  return {
    ok: true,
    data: {
      appliedSort,
      appliedRecency,
      appliedNoteType,
      notes,
    },
  };
}

async function ensureKeywordStrategyFilterPanelOpen(notes = []) {
  if (findStrategyFilterPanel()) {
    return true;
  }
  if (findStrategyClickableByText(["最多点赞", "点赞最多", "半年内"])) {
    return true;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const filterTrigger =
      findStrategyFilterTrigger() ||
      findStrategyClickableByText([
        "筛选",
        "已筛选",
        "时间",
        "发布时间",
        "排序",
      ]);
    if (!filterTrigger) {
      await waitForKeywordStrategyUi(500);
      continue;
    }
    clickStrategyElement(filterTrigger);
    await waitForKeywordStrategyUi(1200);
    if (findStrategyFilterPanel()) {
      return true;
    }
    if (
      findStrategyClickableByText(["最多点赞", "点赞最多", "半年内", "综合排序"])
    ) {
      return true;
    }
    await waitForKeywordStrategyUi(400);
  }

  notes.push("未找到筛选面板入口");
  return false;
}

function findStrategyFilterPanel() {
  const sectionTexts = [
    "排序依据",
    "排序",
    "笔记类型",
    "作品类型",
    "内容类型",
    "内容形式",
    "发布时间",
    "时间",
    "视频时长",
    "搜索范围",
  ];
  const normalized = sectionTexts.map((t) => normalizeStrategyText(t));

  const containers = document.querySelectorAll(
    '[class*="filter"], [class*="panel"], [class*="dropdown"], [class*="popup"], [class*="overlay"], [class*="screen"], section, aside',
  );
  for (const el of containers) {
    if (!(el instanceof HTMLElement) || !isStrategyNodeVisible(el)) continue;
    const text = normalizeStrategyText(el.innerText || "");
    if (normalized.filter((s) => text.includes(s)).length >= 2) return el;
  }
  const allDivs = document.querySelectorAll("div");
  for (const div of allDivs) {
    if (!(div instanceof HTMLElement) || !isStrategyNodeVisible(div)) continue;
    const text = normalizeStrategyText(div.innerText || "");
    if (text.length > 1200) continue;
    if (normalized.filter((s) => text.includes(s)).length >= 2) return div;
  }
  return null;
}

function findStrategyFilterTrigger() {
  const triggerHints = [
    "筛选",
    "已筛选",
    "时间",
    "发布时间",
    "排序",
    "综合筛选",
  ];
  const nodes = Array.from(
    document.querySelectorAll(
      [
        '[class*="filter"]',
        '[class*="filter"] > span',
        '[class*="filter-icon"]',
        '[class*="screen"]',
        "button",
        '[role="button"]',
        "a",
        "li",
        "span",
        "div",
      ].join(", "),
    ),
  );

  let bestNode = null;
  let bestScore = -1;
  for (const node of nodes) {
    if (!(node instanceof HTMLElement) || !isStrategyNodeVisible(node))
      continue;
    const clickable =
      node.closest(
        '[class*="filter"], [class*="screen"], button, [role="button"], a, li',
      ) || node;
    if (
      !(clickable instanceof HTMLElement) ||
      !isStrategyNodeVisible(clickable)
    )
      continue;
    const text = normalizeStrategyText(
      clickable.innerText || clickable.textContent || "",
    );
    if (text.length > 20) continue;
    const className = String(clickable.className || "").toLowerCase();
    let score = 0;

    if (text === normalizeStrategyText("筛选") || text === normalizeStrategyText("已筛选")) {
      score += 10;
    } else if (
      triggerHints.some((hint) => text.includes(normalizeStrategyText(hint)))
    ) {
      score += 6;
    }
    if (/filter|screen/.test(className)) {
      score += 4;
    }
    if (clickable.querySelector?.('[class*="filter-icon"], [class*="icon"], svg')) {
      score += 2;
    }
    if (/\bactive\b/.test(className)) {
      score += 1;
    }
    if (text.length <= 4) {
      score += 1;
    }

    if (score > bestScore) {
      bestNode = clickable;
      bestScore = score;
    }
  }

  return bestScore >= 4 ? bestNode : null;
}

function findOptionInFilterSection(panel, sectionLabel, optionTexts) {
  const candidates = findOptionCandidatesInFilterSection(
    panel,
    sectionLabel,
    optionTexts,
  );
  return candidates[0] || null;
}

function findOptionCandidatesInFilterSection(panel, sectionLabel, optionTexts) {
  const sectionLabels = Array.isArray(sectionLabel)
    ? sectionLabel
    : [sectionLabel];
  const normalizedSections = sectionLabels
    .map((item) => normalizeStrategyText(item))
    .filter(Boolean);
  const normalizedOptions = optionTexts.map((t) => normalizeStrategyText(t));
  const searchRoot = panel || document.body;

  let sectionEl = null;
  for (const el of searchRoot.querySelectorAll("*")) {
    if (!(el instanceof HTMLElement)) continue;
    const raw = (el.textContent || "").replace(/\s+/g, "").trim();
    if (
      normalizedSections.some(
        (section) => raw === section && raw.length <= section.length + 2,
      )
    ) {
      sectionEl = el;
      break;
    }
  }
  if (!sectionEl) return null;

  let container = sectionEl.parentElement;
  if (!container) return null;
  const containerText = normalizeStrategyText(container.innerText || "");
  if (!normalizedOptions.some((opt) => containerText.includes(opt))) {
    container = container.parentElement;
    if (!container) return null;
  }

  let bestNode = null;
  let bestScore = -1;
  const matches = [];
  for (const node of container.querySelectorAll(
    'span, div, button, a, li, [role="button"]',
  )) {
    if (!(node instanceof HTMLElement) || !isStrategyNodeVisible(node))
      continue;
    const text = normalizeStrategyText(
      node.innerText || node.textContent || "",
    );
    if (!text || text.length > 12) continue;
    for (const opt of normalizedOptions) {
      if (text !== opt) continue;
      let score = 10 - estimateStrategyNodeArea(node) / 100000;
      if (node.closest('button, [role="button"], a, li')) score += 2;
      if (isLeafStrategyNode(node)) score += 1;
      matches.push({node, score});
      if (score > bestScore) {
        bestNode = node;
        bestScore = score;
      }
    }
  }
  return matches
    .sort((left, right) => right.score - left.score)
    .map((item) => item.node);
}

async function applyStrategyFilterInSection(
  sectionLabel,
  optionTexts,
  notes = [],
  label = "",
) {
  const targetLabel = label || optionTexts[0];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const panel = findStrategyFilterPanel();
    const panelTargets = panel
      ? findOptionCandidatesInFilterSection(panel, sectionLabel, optionTexts)
      : [];
    const targets =
      panelTargets.length > 0
        ? panelTargets
        : findStrategyClickableCandidatesByText(optionTexts);

    if (targets.some((node) => isStrategyControlActive(node))) {
      return true;
    }

    if (targets.length === 0) {
      await ensureKeywordStrategyFilterPanelOpen(notes);
      await waitForKeywordStrategyUi(300);
      continue;
    }

    for (const target of targets.slice(0, 3)) {
      clickStrategyElement(target);
      if (await waitForStrategyOptionActive(sectionLabel, optionTexts, 1200)) {
        return true;
      }
      await waitForKeywordStrategyUi(250);
    }

    await ensureKeywordStrategyFilterPanelOpen(notes);
    await waitForKeywordStrategyUi(400);
  }

  notes.push(`未成功切换到"${targetLabel}"`);
  return false;
}

function findStrategyClickableByText(candidates = []) {
  const matches = findStrategyClickableCandidatesByText(candidates);
  return matches[0] || null;
}

function findStrategyClickableCandidatesByText(candidates = []) {
  const normalizedCandidates = candidates
    .map((item) => normalizeStrategyText(item))
    .filter(Boolean);
  if (normalizedCandidates.length === 0) {
    return [];
  }

  const nodes = Array.from(
    document.querySelectorAll('button, [role="button"], a, li, span, div'),
  );

  const matches = [];
  nodes.forEach((node) => {
    if (!(node instanceof HTMLElement) || !isStrategyNodeVisible(node)) {
      return;
    }
    const text = normalizeStrategyText(
      node.innerText || node.textContent || "",
    );
    if (!text || text.length > 24) {
      return;
    }

    normalizedCandidates.forEach((candidate) => {
      if (!text.includes(candidate)) {
        return;
      }
      let score = text === candidate ? 10 : 6;
      if (node.closest('button, [role="button"], a, li')) {
        score += 2;
      }
      if (isLeafStrategyNode(node)) {
        score += 1;
      }
      if (isStrategyControlActive(node)) {
        score += 1;
      }
      score -= estimateStrategyNodeArea(node) / 100000;
      matches.push({node, score});
    });
  });

  return matches
    .sort((left, right) => right.score - left.score)
    .map((item) => item.node);
}

function normalizeStrategyText(text = "") {
  return String(text || "")
    .replace(/\s+/g, "")
    .trim();
}

function isStrategyNodeVisible(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isStrategyControlActive(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  const attrs = [
    node.getAttribute("aria-selected"),
    node.getAttribute("aria-pressed"),
    node.getAttribute("data-state"),
    node.getAttribute("data-active"),
    node.getAttribute("data-selected"),
  ]
    .map((item) => String(item || "").toLowerCase())
    .join(" ");
  const className = String(node.className || "").toLowerCase();
  if (
    /\btrue\b|\bactive\b|\bselected\b|\bchecked\b|\bcurrent\b|\bon\b/.test(
      attrs,
    )
  ) {
    return true;
  }
  if (
    /\b(is-active|active|selected|current|checked|chosen)\b/.test(className)
  ) {
    return true;
  }
  try {
    const style = window.getComputedStyle(node);
    const color = String(style?.color || "")
      .trim()
      .toLowerCase();
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const r = Number.parseInt(match[1], 10);
      const g = Number.parseInt(match[2], 10);
      const b = Number.parseInt(match[3], 10);
      if (r >= 200 && g <= 120 && b <= 120) return true;
    }
  } catch {
    // ignore computed style errors
  }
  return false;
}

function isLeafStrategyNode(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  const childElementCount = node.children?.length || 0;
  return childElementCount === 0 || childElementCount <= 1;
}

function estimateStrategyNodeArea(node) {
  if (!(node instanceof HTMLElement)) {
    return Number.POSITIVE_INFINITY;
  }
  const rect = node.getBoundingClientRect();
  return rect.width * rect.height;
}

async function waitForStrategyOptionActive(
  sectionLabel,
  optionTexts,
  timeoutMs = 1200,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const panel = findStrategyFilterPanel();
    const targets = panel
      ? findOptionCandidatesInFilterSection(panel, sectionLabel, optionTexts)
      : findStrategyClickableCandidatesByText(optionTexts);
    if (targets.some((node) => isStrategyControlActive(node))) {
      return true;
    }
    await waitForKeywordStrategyUi(120);
  }
  return false;
}

function clickStrategyElement(node) {
  const clickable =
    node.closest(
      'button, [role="button"], [role="tab"], [role="option"], a, li',
    ) || node;
  if (!(clickable instanceof HTMLElement)) {
    return;
  }
  clickable.scrollIntoView({
    block: "center",
    inline: "center",
    behavior: "auto",
  });
  const rect = clickable.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const pointerOpts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: cx,
    clientY: cy,
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
  };
  const mouseOpts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: cx,
    clientY: cy,
  };
  const touchList =
    typeof Touch === "function"
      ? [
          new Touch({
            identifier: Date.now(),
            target: clickable,
            clientX: cx,
            clientY: cy,
            pageX: window.scrollX + cx,
            pageY: window.scrollY + cy,
            radiusX: 10,
            radiusY: 10,
            force: 0.5,
          }),
        ]
      : [];
  const touchOpts = {
    bubbles: true,
    cancelable: true,
    view: window,
    touches: touchList,
    targetTouches: touchList,
    changedTouches: touchList,
  };

  clickable.dispatchEvent(new PointerEvent("pointerover", pointerOpts));
  clickable.dispatchEvent(new PointerEvent("pointerenter", pointerOpts));
  clickable.dispatchEvent(new MouseEvent("mouseover", mouseOpts));
  clickable.dispatchEvent(new MouseEvent("mouseenter", mouseOpts));
  if (typeof TouchEvent === "function" && touchList.length > 0) {
    clickable.dispatchEvent(new TouchEvent("touchstart", touchOpts));
  }
  clickable.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  clickable.dispatchEvent(new MouseEvent("mousedown", mouseOpts));
  if (typeof TouchEvent === "function" && touchList.length > 0) {
    clickable.dispatchEvent(
      new TouchEvent("touchend", {
        ...touchOpts,
        touches: [],
        targetTouches: [],
      }),
    );
  }
  clickable.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
  clickable.dispatchEvent(new MouseEvent("mouseup", mouseOpts));
  clickable.dispatchEvent(new MouseEvent("click", mouseOpts));
  clickable.click();
}

async function waitForKeywordStrategyUi(ms = 300) {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * 处理评论采集
 */
async function handleCaptureComments(request, sendResponse) {
  try {
    resetCancelFlag();

    const result = await captureComments({
      onProgress: (progress) => {
        safeRuntimeSendMessage({
          action: "captureProgress",
          progress,
        });
      },
      onlyLevel1: Boolean(request.onlyLevel1),
      maxDetectedItems: request.maxDetectedItems ?? request.maxItems,
      maxDurationMs: request.maxDurationMs,
      noNewContentThreshold: request.noNewContentThreshold,
      waitMinMs: request.waitMinMs,
      waitMaxMs: request.waitMaxMs,
      stallTimeoutMs: request.stallTimeoutMs,
      maxScrollTimes: request.maxScrollTimes || 50, // 兼容旧请求参数
      expandReplies: request.expandReplies || false, // 兼容旧请求参数
    });

    sendResponse(result);
  } catch (error) {
    console.error("[Content] Capture comments failed:", error);
    sendResponse({
      ok: false,
      type: "comments",
      data: null,
      error: {code: "CAPTURE_FAILED", message: error.message},
    });
  }
}

/**
 * 处理取消采集
 */
function handleCancelCapture(sendResponse) {
  try {
    setCancelFlag(true);
    sendResponse({ok: true, message: "取消信号已发送"});
  } catch (error) {
    console.error("[Content] Cancel capture failed:", error);
    sendResponse({
      ok: false,
      error: {code: "CANCEL_FAILED", message: error.message},
    });
  }
}

// ==================== 页面生命周期 ====================

/**
 * 上报当前页面状态到 background
 */
function reportPageState(action) {
  const url = window.location.href;
  const platform = /xiaohongshu\.com/i.test(url)
    ? "xiaohongshu"
    : /douyin\.com/i.test(url)
      ? "douyin"
      : "unknown";
  safeRuntimeSendMessage({
    action,
    url,
    platform,
    pageType: detectPageType(url),
  });
}

function createUrlChangeReporter() {
  let lastUrl = window.location.href;
  let pendingTimer = null;

  const flush = () => {
    pendingTimer = null;
    const url = window.location.href;
    if (url === lastUrl) {
      return;
    }

    lastUrl = url;
    reportPageState("pageChanged");
  };

  return () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
    }
    pendingTimer = setTimeout(flush, 80);
  };
}

const notifyUrlChanged = createUrlChangeReporter();

/**
 * 首次注入时立即上报一次，避免错过 window.load
 */
reportPageState("pageLoaded");

window.addEventListener(
  "load",
  () => {
    reportPageState("pageLoaded");
  },
  {once: true},
);

/**
 * URL 变化时通知 background (SPA 页面)
 */
new MutationObserver(() => {
  notifyUrlChanged();
}).observe(document, {subtree: true, childList: true});

window.addEventListener("popstate", notifyUrlChanged);
window.addEventListener("hashchange", notifyUrlChanged);

const rawPushState = history.pushState;
history.pushState = function patchedPushState(...args) {
  const result = rawPushState.apply(this, args);
  notifyUrlChanged();
  return result;
};

const rawReplaceState = history.replaceState;
history.replaceState = function patchedReplaceState(...args) {
  const result = rawReplaceState.apply(this, args);
  notifyUrlChanged();
  return result;
};
