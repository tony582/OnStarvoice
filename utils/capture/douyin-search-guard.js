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
  'a[data-href*="modal_id="]',
  'a[data-url*="/video/"]',
  'a[data-url*="/note/"]',
  'a[data-url*="modal_id="]',
].join(",");

const DOUYIN_SEARCH_DEDICATED_IDENTITY_SELECTOR = [
  '[id^="waterfall_item_"]',
  "[data-e2e-aweme-id]",
  "[data-aweme-id]",
  "[data-awemeid]",
  "[data-modal-id]",
].join(",");

const DOUYIN_SEARCH_GENERIC_CARD_SELECTOR =
  ".search-result-card, [data-id], [data-item-id]";

const DOUYIN_SEARCH_STRONG_CARD_SELECTOR = ".search-result-card";

const DOUYIN_SEARCH_SERVICE_ABNORMAL_STABLE_POLLS = 2;
const DOUYIN_SEARCH_SERVICE_ABNORMAL_MIN_STABLE_MS = 1500;

const serviceAbnormalAssertionStateByRoot = new WeakMap();

const DOUYIN_SERVICE_ABNORMAL_CANDIDATE_SELECTOR =
  "h1, h2, h3, h4, p, span, div";

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/gu, "");
}

function readClock(now = Date.now) {
  const value = typeof now === "function" ? Number(now()) : Number(now);
  return Number.isFinite(value) ? value : Date.now();
}

function extractTrustedDouyinWorkIdFromLinkValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const candidates = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded && decoded !== raw) candidates.push(decoded);
  } catch {
    // A malformed encoded attribute is not trusted result identity.
  }

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, "https://www.douyin.com");
      const hostname = String(url.hostname || "").toLowerCase();
      if (
        hostname !== "douyin.com" &&
        !hostname.endsWith(".douyin.com")
      ) {
        continue;
      }
      const pathname = String(url.pathname || "");
      const pathMatch = pathname.match(
        /^\/(?:video|note)\/(\d{8,})(?:[/?#]|$)/iu,
      );
      if (pathMatch?.[1]) return pathMatch[1];
      const modalId = String(url.searchParams.get("modal_id") || "").trim();
      if (/^\d{8,}$/u.test(modalId)) return modalId;
    } catch {
      // Ignore non-URL attribute values.
    }
  }
  return "";
}

function getTrustedDouyinResultIdentity(node) {
  if (!node || typeof node.getAttribute !== "function") return "";

  const waterfallId = String(node.id || node.getAttribute("id") || "").match(
    /^waterfall_item_(\d{8,})(?:$|[_:-])/u,
  )?.[1];
  if (waterfallId) return waterfallId;

  for (const attribute of [
    "data-e2e-aweme-id",
    "data-aweme-id",
    "data-awemeid",
    "data-modal-id",
  ]) {
    const workId = String(node.getAttribute(attribute) || "").trim();
    if (/^\d{8,}$/u.test(workId)) return workId;
  }

  for (const attribute of ["href", "data-href", "data-url"]) {
    const workId = extractTrustedDouyinWorkIdFromLinkValue(
      node.getAttribute(attribute),
    );
    if (workId) return workId;
  }
  return "";
}

function closestTrustedDouyinResultIdentity(node) {
  if (!node || typeof node.closest !== "function") return null;
  for (const selector of [
    DOUYIN_SEARCH_DEDICATED_IDENTITY_SELECTOR,
    DOUYIN_SEARCH_RESULT_LINK_SELECTOR,
  ]) {
    let candidate = null;
    try {
      candidate = node.closest(selector);
    } catch {
      candidate = null;
    }
    if (candidate && getTrustedDouyinResultIdentity(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findTrustedDouyinResultIdentityWithin(container) {
  if (!container || typeof container.querySelectorAll !== "function") {
    return null;
  }
  let candidates = [];
  try {
    candidates = container.querySelectorAll(
      `${DOUYIN_SEARCH_DEDICATED_IDENTITY_SELECTOR},${DOUYIN_SEARCH_RESULT_LINK_SELECTOR}`,
    );
  } catch {
    return null;
  }
  let inspected = 0;
  let isStrongCardContainer = false;
  try {
    isStrongCardContainer =
      container.closest(DOUYIN_SEARCH_STRONG_CARD_SELECTOR) === container;
  } catch {
    isStrongCardContainer = false;
  }
  for (const candidate of candidates) {
    if (inspected >= 24) break;
    inspected += 1;
    if (!getTrustedDouyinResultIdentity(candidate)) continue;
    if (!isStrongCardContainer) {
      try {
        if (
          candidate.closest(DOUYIN_SEARCH_GENERIC_CARD_SELECTOR) !== container
        ) {
          continue;
        }
      } catch {
        continue;
      }
    }
    return candidate;
  }
  return null;
}

function containsTrustedDouyinResultIdentity(container) {
  if (!container || typeof container.querySelectorAll !== "function") {
    return false;
  }
  let candidates = [];
  try {
    candidates = container.querySelectorAll(
      `${DOUYIN_SEARCH_DEDICATED_IDENTITY_SELECTOR},${DOUYIN_SEARCH_RESULT_LINK_SELECTOR}`,
    );
  } catch {
    return false;
  }
  let inspected = 0;
  for (const candidate of candidates) {
    if (inspected >= 48) break;
    inspected += 1;
    if (getTrustedDouyinResultIdentity(candidate)) return true;
  }
  return false;
}

function createServiceAbnormalSignature(node, pageUrl) {
  if (!node) return "";
  const text = normalizeText(node?.innerText || node?.textContent || "");
  return text ? `${String(pageUrl || "").trim()}|${text}` : "";
}

function advanceServiceAbnormalState(
  state,
  {node, pageUrl, observedAt},
) {
  const signature = createServiceAbnormalSignature(node, pageUrl);
  if (!signature) {
    state.signature = "";
    state.node = null;
    state.firstObservedAt = null;
    state.pollCount = 0;
    return false;
  }

  if (state.signature !== signature) {
    state.signature = signature;
    state.node = node;
    state.firstObservedAt = observedAt;
    state.pollCount = 1;
    return false;
  }

  state.node = node;
  state.pollCount += 1;
  return Boolean(
    state.pollCount >= DOUYIN_SEARCH_SERVICE_ABNORMAL_STABLE_POLLS &&
      Number.isFinite(state.firstObservedAt) &&
      observedAt - state.firstObservedAt >=
        DOUYIN_SEARCH_SERVICE_ABNORMAL_MIN_STABLE_MS,
  );
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
  if (/^(?:验证码中间页|抖音验证码中间页)$/iu.test(normalizedTitle)) {
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
  containsResultCard = false,
  structuredContainerRequired = false,
  structuredContainer = false,
} = {}) {
  return Boolean(
    isDouyinSecurityChallengePageUrl(pageUrl) &&
      visible &&
      !insideResultCard &&
      !containsResultCard &&
      (!structuredContainerRequired || structuredContainer) &&
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
  if (closestTrustedDouyinResultIdentity(node)) return true;
  if (!node || typeof node.closest !== "function") return false;
  try {
    const cardContainer = node.closest(DOUYIN_SEARCH_GENERIC_CARD_SELECTOR);
    return Boolean(findTrustedDouyinResultIdentityWithin(cardContainer));
  } catch {
    return false;
  }
}

function isStructuredDouyinChallengeContainer(node) {
  if (!node) return false;
  const tagName = String(node.tagName || "").trim().toLowerCase();
  const role = String(node.getAttribute?.("role") || "")
    .trim()
    .toLowerCase();
  if (tagName === "dialog" || role === "dialog" || role === "alertdialog") {
    return true;
  }
  const identity = normalizeText(
    [
      node.id,
      node.className,
      node.getAttribute?.("data-e2e"),
      node.getAttribute?.("data-testid"),
      node.getAttribute?.("aria-label"),
    ].join(" "),
  ).toLowerCase();
  if (/captcha|verify|verification|challenge|验证码|安全验证/iu.test(identity)) {
    return true;
  }
  try {
    return Boolean(
      node.querySelector?.(
        'iframe[src*="captcha" i], iframe[src*="verify" i], canvas, [class*="captcha" i], [class*="verify" i], [class*="challenge" i], [data-e2e*="captcha" i], [data-testid*="captcha" i]',
      ),
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
  requireStructuredContainer = false,
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
        // A page/list wrapper inherits all descendant card copy through
        // innerText. Treating that aggregate text as a challenge would stop the
        // whole batch when an ordinary post merely quotes the verification
        // wording. The actual dialog remains discoverable as its own child.
        containsResultCard: containsTrustedDouyinResultIdentity(node),
        structuredContainerRequired: requireStructuredContainer,
        structuredContainer: isStructuredDouyinChallengeContainer(node),
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
  const root = options?.root || globalThis.document;
  const node = findDouyinSearchServiceAbnormalNode({...options, root, pageUrl});
  if (!root || (typeof root !== "object" && typeof root !== "function")) {
    return;
  }
  if (!node) {
    serviceAbnormalAssertionStateByRoot.delete(root);
    return;
  }
  const state = serviceAbnormalAssertionStateByRoot.get(root) || {
    signature: "",
    node: null,
    firstObservedAt: null,
    pollCount: 0,
  };
  serviceAbnormalAssertionStateByRoot.set(root, state);
  if (
    advanceServiceAbnormalState(state, {
      node,
      pageUrl,
      observedAt: readClock(options?.now),
    })
  ) {
    serviceAbnormalAssertionStateByRoot.delete(root);
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
  now = Date.now,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  const MutationObserverCtor = globalThis.MutationObserver;
  if (!root || typeof MutationObserverCtor !== "function") {
    return null;
  }

  let settled = false;
  let confirmationTimer = null;
  const state = {
    signature: "",
    node: null,
    firstObservedAt: null,
    pollCount: 0,
  };
  const cancelConfirmationTimer = () => {
    if (confirmationTimer !== null && typeof clearTimer === "function") {
      clearTimer(confirmationTimer);
    }
    confirmationTimer = null;
  };
  const resetPendingState = () => {
    cancelConfirmationTimer();
    advanceServiceAbnormalState(state, {
      node: null,
      pageUrl: "",
      observedAt: readClock(now),
    });
  };
  let inspect = null;
  const scheduleConfirmation = () => {
    if (
      settled ||
      confirmationTimer !== null ||
      !state.node ||
      typeof setTimer !== "function"
    ) {
      return;
    }
    const elapsed = Math.max(0, readClock(now) - state.firstObservedAt);
    const remaining = Math.max(
      0,
      DOUYIN_SEARCH_SERVICE_ABNORMAL_MIN_STABLE_MS - elapsed,
    );
    confirmationTimer = setTimer(() => {
      confirmationTimer = null;
      inspect(state.node, {authoritative: true});
    }, remaining);
  };
  inspect = (candidateRoot, {authoritative = false} = {}) => {
    if (settled || !candidateRoot) return false;
    const currentUrl =
      typeof pageUrl === "function" ? pageUrl() : String(pageUrl || "");
    if (candidateRoot?.isConnected === false) {
      resetPendingState();
      return false;
    }
    const node = findDouyinSearchServiceAbnormalNode({
      root: candidateRoot,
      pageUrl: currentUrl,
    });
    if (!node) {
      if (authoritative) resetPendingState();
      return false;
    }
    const confirmed = advanceServiceAbnormalState(state, {
      node,
      pageUrl: currentUrl,
      observedAt: readClock(now),
    });
    if (!confirmed) {
      scheduleConfirmation();
      return false;
    }
    settled = true;
    cancelConfirmationTimer();
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
    if (state.node?.isConnected === false) {
      resetPendingState();
    }
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
  const originalDisconnect = observer.disconnect.bind(observer);
  observer.disconnect = () => {
    settled = true;
    cancelConfirmationTimer();
    originalDisconnect();
  };
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
