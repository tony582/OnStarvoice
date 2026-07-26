export const DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE =
  "DOUYIN_SEARCH_SERVICE_ABNORMAL";

export const DOUYIN_SEARCH_SERVICE_ABNORMAL_MESSAGE =
  "抖音当前关键词搜索暂时不可用，已结束本词并继续下一个关键词";

export const DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE =
  "DOUYIN_SEARCH_SECURITY_CHALLENGE";

export const DOUYIN_SEARCH_SECURITY_CHALLENGE_MESSAGE =
  "检测到抖音图片安全验证，已停止后续搜索并保留已发现结果，请人工完成验证后继续或转派剩余关键词";

const DOUYIN_SEARCH_RESULT_LINK_SELECTOR = [
  'a[href*="/video/"]',
  'a[href*="/note/"]',
  'a[href*="modal_id="]',
  'a[data-href*="/video/"]',
  'a[data-href*="/note/"]',
  'a[data-url*="/video/"]',
  'a[data-url*="/note/"]',
].join(",");

const DOUYIN_SEARCH_RESULT_CARD_SELECTOR = [
  ".search-result-card",
  '[id^="waterfall_item_"]',
  "[data-e2e-aweme-id]",
  "[data-aweme-id]",
  "[data-awemeid]",
  "[data-modal-id]",
  DOUYIN_SEARCH_RESULT_LINK_SELECTOR,
].join(",");

const DOUYIN_SERVICE_ABNORMAL_CANDIDATE_SELECTOR =
  "h1, h2, h3, h4, p, span, div";

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/gu, "");
}

export function isDouyinSearchPageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const hostname = String(url.hostname || "").toLowerCase();
    const pathname = String(url.pathname || "").toLowerCase();
    return (
      (hostname === "douyin.com" || hostname.endsWith(".douyin.com")) &&
      (pathname.startsWith("/search/") ||
        pathname === "/search" ||
        pathname.startsWith("/jingxuan/search"))
    );
  } catch {
    return false;
  }
}

export function isDouyinSecurityChallengePageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const hostname = String(url.hostname || "").toLowerCase();
    return hostname === "douyin.com" || hostname.endsWith(".douyin.com");
  } catch {
    return false;
  }
}

export function isDouyinSearchServiceAbnormalText(value) {
  const normalized = normalizeText(value);
  return (
    normalized === "服务出现异常" ||
    /^(?:服务出现异常)(?:，|,)?(?:请稍后重试)[。！!]?$/u.test(normalized)
  );
}

export function isDouyinSearchSecurityChallengeText({
  title = "",
  text = "",
} = {}) {
  const normalizedTitle = normalizeText(title);
  const normalizedText = normalizeText(text);
  if (/验证码中间页/iu.test(normalizedTitle)) {
    return true;
  }
  if (/请完成下列验证后继续[:：]?/iu.test(normalizedText)) {
    return true;
  }
  const hasSemanticImageInstruction =
    /请选择所有符合(?:上文|上述|下列)?描述的图片/iu.test(normalizedText);
  const hasSemanticImageTarget =
    /(?:并)?拖拽到(?:下方|这里)/iu.test(normalizedText);
  return hasSemanticImageInstruction && hasSemanticImageTarget;
}

export function isDouyinSearchSecurityChallengeCandidate({
  pageUrl = "",
  title = "",
  text = "",
  visible = false,
  insideResultCard = false,
} = {}) {
  return Boolean(
    isDouyinSecurityChallengePageUrl(pageUrl) &&
      visible &&
      !insideResultCard &&
      isDouyinSearchSecurityChallengeText({title, text}),
  );
}

export function isDouyinSearchServiceAbnormalCandidate({
  pageUrl = "",
  text = "",
  visible = false,
  insideResultCard = false,
} = {}) {
  return Boolean(
    isDouyinSearchPageUrl(pageUrl) &&
      visible &&
      !insideResultCard &&
      isDouyinSearchServiceAbnormalText(text),
  );
}

function isVisibleElement(node) {
  if (!node || typeof node.getBoundingClientRect !== "function") {
    return false;
  }
  const rect = node.getBoundingClientRect();
  const view = node.ownerDocument?.defaultView || globalThis.window;
  if (Number(rect?.width || 0) <= 4 || Number(rect?.height || 0) <= 4) {
    return false;
  }

  let current = node;
  while (current && current?.nodeType !== 9) {
    if (
      current.hidden === true ||
      String(current.getAttribute?.("aria-hidden") || "").toLowerCase() ===
        "true"
    ) {
      return false;
    }
    const style =
      view && typeof view.getComputedStyle === "function"
        ? view.getComputedStyle(current)
        : null;
    if (
      style &&
      (style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) <= 0.01)
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function isInsideDouyinSearchResultCard(node) {
  if (!node || typeof node.closest !== "function") {
    return false;
  }
  try {
    if (node.closest(DOUYIN_SEARCH_RESULT_CARD_SELECTOR)) {
      return true;
    }
    const idContainer = node.closest("[data-id], [data-item-id]");
    if (!idContainer) {
      return false;
    }
    const itemId = String(
      idContainer.getAttribute?.("data-id") ||
        idContainer.getAttribute?.("data-item-id") ||
        "",
    ).trim();
    return Boolean(
      /^\d{8,}$/u.test(itemId) ||
        idContainer.querySelector?.(DOUYIN_SEARCH_RESULT_LINK_SELECTOR),
    );
  } catch {
    return false;
  }
}

function collectCandidateElements(root) {
  const candidates = [];
  if (
    root &&
    typeof root.matches === "function" &&
    root.matches(DOUYIN_SERVICE_ABNORMAL_CANDIDATE_SELECTOR)
  ) {
    candidates.push(root);
  }
  if (root && typeof root.querySelectorAll === "function") {
    candidates.push(
      ...root.querySelectorAll(DOUYIN_SERVICE_ABNORMAL_CANDIDATE_SELECTOR),
    );
  }
  return candidates;
}

export function findDouyinSearchServiceAbnormalNode({
  root = globalThis.document,
  pageUrl = globalThis.window?.location?.href || "",
} = {}) {
  if (!root || !isDouyinSearchPageUrl(pageUrl)) {
    return null;
  }
  for (const node of collectCandidateElements(root)) {
    if (
      isDouyinSearchServiceAbnormalCandidate({
        pageUrl,
        text: node?.innerText || node?.textContent || "",
        visible: isVisibleElement(node),
        insideResultCard: isInsideDouyinSearchResultCard(node),
      })
    ) {
      return node;
    }
  }
  return null;
}

export function hasDouyinSearchServiceAbnormalState(options = {}) {
  return Boolean(findDouyinSearchServiceAbnormalNode(options));
}

export function findDouyinSearchSecurityChallengeNode({
  root = globalThis.document,
  pageUrl = globalThis.window?.location?.href || "",
  title = globalThis.document?.title || "",
} = {}) {
  if (!root || !isDouyinSecurityChallengePageUrl(pageUrl)) {
    return null;
  }
  if (isDouyinSearchSecurityChallengeText({title, text: ""})) {
    return root?.documentElement || root?.body || root;
  }
  for (const node of collectCandidateElements(root)) {
    if (
      isDouyinSearchSecurityChallengeCandidate({
        pageUrl,
        title,
        text: node?.innerText || node?.textContent || "",
        visible: isVisibleElement(node),
        insideResultCard: isInsideDouyinSearchResultCard(node),
      })
    ) {
      return node;
    }
  }
  if (typeof root?.querySelectorAll === "function") {
    for (const frame of root.querySelectorAll("iframe")) {
      if (
        !isVisibleElement(frame) ||
        isInsideDouyinSearchResultCard(frame)
      ) {
        continue;
      }
      const frameEvidence = normalizeText(
        [
          frame.getAttribute?.("src"),
          frame.getAttribute?.("title"),
          frame.getAttribute?.("name"),
          frame.id,
          frame.className,
        ].join(" "),
      ).toLowerCase();
      if (/captcha|verify|verification|challenge/iu.test(frameEvidence)) {
        return frame;
      }
    }
  }
  return null;
}

export function hasDouyinSearchSecurityChallengeState(options = {}) {
  return Boolean(findDouyinSearchSecurityChallengeNode(options));
}

export function createDouyinSearchServiceAbnormalError({
  message = DOUYIN_SEARCH_SERVICE_ABNORMAL_MESSAGE,
  pageUrl = globalThis.window?.location?.href || "",
} = {}) {
  const error = new Error(
    String(message || "").trim() ||
      DOUYIN_SEARCH_SERVICE_ABNORMAL_MESSAGE,
  );
  error.code = DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE;
  error.category = "platform_service_abnormal";
  error.pageUrl = String(pageUrl || "");
  // “服务出现异常”也会出现在正常的手动搜索中。它只说明当前搜索请求
  // 没有得到可采结果，不足以证明验证码、登录失效或账号风控。
  error.securityBlocked = false;
  error.platformSafetyBlocked = false;
  error.requiresManualAction = false;
  error.stopBatch = false;
  error.fatal = false;
  error.retryable = true;
  error.keywordScoped = true;
  return error;
}

export function isDouyinSearchServiceAbnormalError(value) {
  const code = String(
    value?.code || value?.errorCode || value?.error?.code || "",
  )
    .trim()
    .toUpperCase();
  return code === DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE;
}

export function createDouyinSearchSecurityChallengeError({
  message = DOUYIN_SEARCH_SECURITY_CHALLENGE_MESSAGE,
  pageUrl = globalThis.window?.location?.href || "",
} = {}) {
  const error = new Error(
    String(message || "").trim() ||
      DOUYIN_SEARCH_SECURITY_CHALLENGE_MESSAGE,
  );
  error.code = DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE;
  error.category = "platform_safety_block";
  error.pageUrl = String(pageUrl || "");
  error.securityBlocked = true;
  error.platformSafetyBlocked = true;
  error.requiresManualAction = true;
  error.stopBatch = true;
  error.fatal = true;
  error.retryable = false;
  error.keywordScoped = false;
  return error;
}

export function isDouyinSearchSecurityChallengeError(value) {
  const code = String(
    value?.code || value?.errorCode || value?.error?.code || "",
  )
    .trim()
    .toUpperCase();
  return code === DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE;
}

export function assertNoDouyinSearchServiceAbnormalPage(options = {}) {
  const pageUrl =
    options?.pageUrl || globalThis.window?.location?.href || "";
  if (hasDouyinSearchServiceAbnormalState({...options, pageUrl})) {
    throw createDouyinSearchServiceAbnormalError({pageUrl});
  }
}

export function assertNoDouyinSearchSecurityChallengePage(options = {}) {
  const pageUrl =
    options?.pageUrl || globalThis.window?.location?.href || "";
  if (hasDouyinSearchSecurityChallengeState({...options, pageUrl})) {
    throw createDouyinSearchSecurityChallengeError({pageUrl});
  }
}

export function observeDouyinSearchServiceAbnormalPage({
  root = globalThis.document?.documentElement || globalThis.document?.body,
  pageUrl = () => globalThis.window?.location?.href || "",
  onDetected = null,
} = {}) {
  const MutationObserverCtor = globalThis.MutationObserver;
  if (!root || typeof MutationObserverCtor !== "function") {
    return null;
  }

  let settled = false;
  const inspect = (candidateRoot) => {
    if (settled || !candidateRoot) return false;
    const currentUrl =
      typeof pageUrl === "function" ? pageUrl() : String(pageUrl || "");
    const node = findDouyinSearchServiceAbnormalNode({
      root: candidateRoot,
      pageUrl: currentUrl,
    });
    if (!node) return false;
    settled = true;
    observer.disconnect();
    if (typeof onDetected === "function") {
      onDetected(
        createDouyinSearchServiceAbnormalError({pageUrl: currentUrl}),
        node,
      );
    }
    return true;
  };

  const observer = new MutationObserverCtor((mutations = []) => {
    for (const mutation of mutations) {
      if (mutation?.type === "characterData") {
        if (inspect(mutation.target?.parentElement)) return;
        continue;
      }
      if (mutation?.type === "attributes") {
        const targetText = normalizeText(
          mutation.target?.innerText || mutation.target?.textContent || "",
        );
        if (
          targetText.includes("服务出现异常") &&
          inspect(mutation.target)
        ) {
          return;
        }
        continue;
      }
      for (const node of mutation?.addedNodes || []) {
        const candidateRoot =
          node?.nodeType === 3 ? node.parentElement : node;
        if (inspect(candidateRoot)) return;
      }
    }
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden"],
  });
  inspect(root);
  return observer;
}

export function observeDouyinSearchSecurityChallengePage({
  root = globalThis.document?.documentElement || globalThis.document?.body,
  pageUrl = () => globalThis.window?.location?.href || "",
  title = () => globalThis.document?.title || "",
  onDetected = null,
} = {}) {
  const MutationObserverCtor = globalThis.MutationObserver;
  if (!root || typeof MutationObserverCtor !== "function") {
    return null;
  }

  let settled = false;
  const inspect = (candidateRoot) => {
    if (settled || !candidateRoot) return false;
    const currentUrl =
      typeof pageUrl === "function" ? pageUrl() : String(pageUrl || "");
    const currentTitle =
      typeof title === "function" ? title() : String(title || "");
    const node = findDouyinSearchSecurityChallengeNode({
      root: candidateRoot,
      pageUrl: currentUrl,
      title: currentTitle,
    });
    if (!node) return false;
    settled = true;
    observer.disconnect();
    if (typeof onDetected === "function") {
      onDetected(
        createDouyinSearchSecurityChallengeError({pageUrl: currentUrl}),
        node,
      );
    }
    return true;
  };

  const observer = new MutationObserverCtor((mutations = []) => {
    for (const mutation of mutations) {
      if (mutation?.type === "characterData") {
        if (inspect(mutation.target?.parentElement)) return;
        continue;
      }
      if (mutation?.type === "attributes") {
        if (inspect(mutation.target)) return;
        continue;
      }
      for (const node of mutation?.addedNodes || []) {
        const candidateRoot =
          node?.nodeType === 3 ? node.parentElement : node;
        if (inspect(candidateRoot)) return;
      }
      // The instruction and the drop target are often rendered as separate
      // sibling mutations. Inspect their shared container after processing the
      // added nodes so the semantic pair is still detected.
      if (inspect(mutation?.target)) return;
    }
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "open"],
  });
  inspect(root);
  return observer;
}
