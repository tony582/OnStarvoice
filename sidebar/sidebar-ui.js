/**
 * onstarvoice V2.0 侧边栏 UI 与交互逻辑
 * 使用 ES Module，监听 state.js 并负责纯展示层逻辑
 */

import {
  subscribe,
  refreshAuth,
  refreshMonitor,
  refreshDataPool,
  refreshSyncHistory,
} from "./state.js";
import {
  ERROR_MESSAGE_MAP,
  MESSAGE_TYPE,
  PAGE_TYPE,
  AUTH_STATUS,
  RECORD_STATUS,
  CAPTURE_PHASE,
  UNCLAIMED_CREDENTIAL_OWNER_EMAIL,
  UNCLAIMED_CREDENTIAL_OWNER_NAME,
  UNCLAIMED_CREDENTIAL_OWNER_LABEL,
} from "../utils/constants.js";
import {
  getPlatformCaptureTabs,
  getPlatformCopy,
  getPlatformCapabilities,
  getPreferredTabForPageType,
  getRecordTypesForTab,
  resolveRecordPlatform,
} from "./platform-registry.js";
import {detectPlatformFromUrl} from "../utils/platform/page-routing.js";
import {buildXiaohongshuCardData} from "./renderers/xiaohongshu.js";
import {buildDouyinCardData} from "./renderers/douyin.js";
import {buildWeiboCardData} from "./renderers/weibo.js";

const INSTANT_TOOLTIP_TEXT_ATTR = "data-instant-tooltip";
const SYNC_HISTORY_FILTER_OPTIONS = Object.freeze([
  {value: "all", label: "全部平台", title: "查看全部平台的执行明细"},
  {value: "xiaohongshu", label: "小红书", title: "仅查看小红书执行明细"},
  {value: "douyin", label: "抖音", title: "仅查看抖音执行明细"},
]);
const CAPTURE_TAB_IDS = new Set(["noteTab", "bloggerTab", "searchTab", "monitorTab"]);
const syncHistoryErrorDetailCache = new Map();
const executionSectionCollapsedState = {
  sync: false,
  monitor: false,
};
const dataPoolGroupCollapsedState = new Map();
const PRICING_PAGE_URL = "https://onstarvoice.app/#pricing";
const PURCHASE_LINK_PHRASES = Object.freeze([
  "续费激活码",
  "获取新激活码",
  "联系管理员",
  "获取授权",
]);
const TOAST_DEFAULT_DURATION_MS = 7000;
const TOAST_FADE_OUT_DURATION_MS = 300;

function isUnclaimedCredentialOwner(authConfig) {
  if (authConfig?.status !== AUTH_STATUS.VERIFIED) {
    return false;
  }

  const ownerEmail = String(authConfig?.user?.email || "")
    .trim()
    .toLowerCase();
  const ownerName = String(authConfig?.user?.name || "")
    .trim()
    .toLowerCase();

  return (
    ownerEmail === UNCLAIMED_CREDENTIAL_OWNER_EMAIL.toLowerCase() ||
    ownerName === UNCLAIMED_CREDENTIAL_OWNER_NAME.toLowerCase()
  );
}

function initInstantTooltips() {
  const tooltipEl = document.createElement("div");
  tooltipEl.className = "instant-tooltip";
  tooltipEl.setAttribute("role", "tooltip");
  document.body.appendChild(tooltipEl);

  let activeTarget = null;
  let rafId = 0;

  const resolveTooltipTarget = (source) => {
    if (!(source instanceof Element)) return null;
    return source.closest(`[${INSTANT_TOOLTIP_TEXT_ATTR}]`);
  };

  const getTooltipText = (target) =>
    String(target?.getAttribute(INSTANT_TOOLTIP_TEXT_ATTR) || "").trim();

  const migrateTitleForElement = (element) => {
    if (!(element instanceof Element) || element === tooltipEl) return;
    if (!element.hasAttribute("title")) return;

    const tooltipText = String(element.getAttribute("title") || "").trim();
    element.removeAttribute("title");

    if (!tooltipText) {
      element.removeAttribute(INSTANT_TOOLTIP_TEXT_ATTR);
      return;
    }

    element.setAttribute(INSTANT_TOOLTIP_TEXT_ATTR, tooltipText);
  };

  const migrateTitleAttrs = (root) => {
    if (!(root instanceof Element)) return;
    if (root.hasAttribute("title")) {
      migrateTitleForElement(root);
    }
    root.querySelectorAll("[title]").forEach(migrateTitleForElement);
  };

  const hideTooltip = () => {
    activeTarget = null;
    tooltipEl.classList.remove("is-visible");
  };

  const updateTooltipPosition = (clientX, clientY) => {
    if (!activeTarget) return;
    if (!tooltipEl.classList.contains("is-visible")) return;

    if (rafId) {
      cancelAnimationFrame(rafId);
    }

    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const offset = 12;
      const margin = 8;
      const viewportWidth =
        document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight =
        document.documentElement.clientHeight || window.innerHeight;

      let left = clientX + offset;
      let top = clientY + offset;

      const rect = tooltipEl.getBoundingClientRect();
      if (left + rect.width + margin > viewportWidth) {
        left = Math.max(margin, clientX - rect.width - offset);
      }
      if (top + rect.height + margin > viewportHeight) {
        top = Math.max(margin, clientY - rect.height - offset);
      }

      tooltipEl.style.left = `${Math.round(left)}px`;
      tooltipEl.style.top = `${Math.round(top)}px`;
    });
  };

  const showTooltip = (target, clientX, clientY) => {
    const text = getTooltipText(target);
    if (!text) {
      hideTooltip();
      return;
    }

    activeTarget = target;
    tooltipEl.textContent = text;
    tooltipEl.classList.add("is-visible");
    updateTooltipPosition(clientX, clientY);
  };

  const showTooltipForFocusedTarget = (target) => {
    const rect = target.getBoundingClientRect();
    showTooltip(target, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  document.addEventListener("pointerover", (event) => {
    const target = resolveTooltipTarget(event.target);
    if (!target) {
      hideTooltip();
      return;
    }
    showTooltip(target, event.clientX, event.clientY);
  });

  document.addEventListener("pointermove", (event) => {
    if (!activeTarget) return;
    if (!(event.target instanceof Node)) return;
    if (event.target !== activeTarget && !activeTarget.contains(event.target))
      return;
    updateTooltipPosition(event.clientX, event.clientY);
  });

  document.addEventListener("pointerout", (event) => {
    if (!activeTarget) return;
    if (!(event.target instanceof Node)) return;
    if (event.target !== activeTarget && !activeTarget.contains(event.target))
      return;
    if (
      event.relatedTarget instanceof Node &&
      activeTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    hideTooltip();
  });

  document.addEventListener("focusin", (event) => {
    const target = resolveTooltipTarget(event.target);
    if (!target) {
      hideTooltip();
      return;
    }
    showTooltipForFocusedTarget(target);
  });

  document.addEventListener("focusout", (event) => {
    if (!activeTarget) return;
    if (!(event.target instanceof Node)) return;
    if (event.target !== activeTarget && !activeTarget.contains(event.target))
      return;
    hideTooltip();
  });

  document.addEventListener("scroll", hideTooltip, true);
  window.addEventListener("blur", hideTooltip);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hideTooltip();
  });

  const titleObserver = new MutationObserver((mutationList) => {
    mutationList.forEach((mutation) => {
      if (
        mutation.type === "attributes" &&
        mutation.target instanceof Element
      ) {
        migrateTitleForElement(mutation.target);
        return;
      }

      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) {
          migrateTitleAttrs(node);
        }
      });
    });
  });

  migrateTitleAttrs(document.body);
  titleObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["title"],
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initInstantTooltips();

  const tabPanes = Array.from(
    document.querySelectorAll("#mainTabContent .tab-pane"),
  );
  const mainTabNav = document.getElementById("mainTabNav");
  let latestRuntimePagePlatform = String(
    document.body.dataset.pagePlatform || "unknown",
  )
    .trim()
    .toLowerCase();
  let latestRuntimePageType = PAGE_TYPE.UNKNOWN;
  let tabTriggers = [];

  const renderUnsupportedPlatformCards = () => {
    const unsupportedPlatformGrid = document.getElementById(
      "unsupportedPlatformGrid",
    );
    if (!unsupportedPlatformGrid) return;

    const platformItems = Array.from(
      document.querySelectorAll(".platform-menu-item[data-platform]"),
    );
    const seen = new Set();
    const cards = platformItems
      .map((item) => {
        const platform = String(item.dataset.platform || "")
          .trim()
          .toLowerCase();
        if (!platform || platform === "unknown" || seen.has(platform)) {
          return "";
        }
        seen.add(platform);
        const logoMarkup =
          item.querySelector(".platform-logo")?.outerHTML ||
          '<span class="platform-logo platform-logo-unknown">?</span>';
        const label =
          item.querySelector(".platform-option-name")?.textContent?.trim() ||
          getPlatformCopy(platform).label;
        return `
          <article class="unsupported-platform-card" data-platform="${escapeHtml(platform)}" role="button" tabindex="0" title="前往${escapeHtml(label)}">
            <div class="unsupported-platform-card-logo">${logoMarkup}</div>
            <div class="unsupported-platform-card-name">${escapeHtml(label)}</div>
          </article>
        `;
      })
      .filter(Boolean)
      .join("");

    unsupportedPlatformGrid.innerHTML = cards;

    if (!unsupportedPlatformGrid.dataset.clickBound) {
      unsupportedPlatformGrid.dataset.clickBound = "1";
      unsupportedPlatformGrid.addEventListener("click", (e) => {
        const card = e.target.closest(".unsupported-platform-card[data-platform]");
        if (!card) return;
        const targetPlatform = String(card.dataset.platform || "").trim();
        if (!targetPlatform) return;
        const platformCopy = getPlatformCopy(targetPlatform);
        window.showMessage?.(`正在打开${platformCopy.label}主页...`, "info");
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPE.SWITCH_PLATFORM_TAB,
          platform: targetPlatform,
        }).catch((err) => {
          window.showMessage?.(`打开${platformCopy.label}主页失败: ${err.message}`, "error");
        });
      });
    }
  };

  const syncUnsupportedPlatformCover = (activeTabId = "") => {
    const cover = document.getElementById("unsupportedPlatformCover");
    if (!cover) return;

    const datasetPagePlatform = String(
      document.body.dataset.pagePlatform || "unknown",
    )
      .trim()
      .toLowerCase();
    const pagePlatform =
      datasetPagePlatform && datasetPagePlatform !== "unknown"
        ? datasetPagePlatform
        : latestRuntimePagePlatform;
    const resolvedActiveTab =
      activeTabId ||
      document.querySelector("#mainTabContent .tab-pane.is-active")?.id ||
      "noteTab";
    const shouldShow =
      pagePlatform === "unknown" && CAPTURE_TAB_IDS.has(resolvedActiveTab);

    cover.hidden = !shouldShow;
    document.body.classList.toggle(
      "is-unsupported-platform-cover-visible",
      shouldShow,
    );
  };

  const activateTab = (targetId) => {
    if (!targetId) return;

    tabPanes.forEach((pane) => pane.classList.remove("is-active"));
    tabTriggers.forEach((trigger) => trigger.classList.remove("is-active"));

    const targetPane = document.getElementById(targetId);
    if (!targetPane) return;

    targetPane.classList.add("is-active");
    tabTriggers
      .filter((trigger) => trigger.dataset.target === targetId)
      .forEach((trigger) => trigger.classList.add("is-active"));

    const mainPoolPanel = document.getElementById("mainPoolPanel");
    const isCapturePanel =
      targetId !== "settingsTab" &&
      targetId !== "historyTab" &&
      targetId !== "monitorTab";
    if (mainPoolPanel) {
      mainPoolPanel.style.display = isCapturePanel ? "block" : "none";
    }
    syncUnsupportedPlatformCover(targetId);

    void refreshDataPool();
    if (targetId === "settingsTab") {
      void refreshAuth();
      window.requestAuthRefresh?.();
    } else if (targetId === "historyTab") {
      void refreshSyncHistory();
      window.requestExecutionDetailRefresh?.();
    } else if (targetId === "monitorTab") {
      void refreshMonitor();
      window.requestMonitorRefresh?.();
    }
  };

  const bindTabTriggers = () => {
    tabTriggers = Array.from(
      document.querySelectorAll("#mainTabNav .js-tab-trigger[data-target]"),
    );
    tabTriggers.forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.target));
    });
  };

  const renderCaptureTabs = (platform = "unknown") => {
    if (!mainTabNav) return;

    const availablePaneIds = new Set(tabPanes.map((pane) => pane.id));
    const tabs = getPlatformCaptureTabs(platform).filter((tab) =>
      availablePaneIds.has(tab.id),
    );
    const currentActivePane = document.querySelector(
      "#mainTabContent .tab-pane.is-active",
    );
    const currentActiveTabId = currentActivePane?.id || "";

    mainTabNav.dataset.platform = platform;
    mainTabNav.innerHTML = tabs
      .map((tab, index) => {
        const shouldBeActive =
          currentActiveTabId && currentActiveTabId === tab.id
            ? true
            : !currentActiveTabId && index === 0;
        const classes = ["tab-btn", "js-tab-trigger"];
        if (shouldBeActive) classes.push("is-active");
        if (tab.disabled) classes.push("is-disabled");

        return `
          <button
            class="${classes.join(" ")}"
            data-target="${escapeHtml(tab.id)}"
            type="button"
            ${tab.disabled ? "disabled" : ""}
            ${tab.disabledReason ? `title="${escapeHtml(tab.disabledReason)}"` : ""}>
            <span>${escapeHtml(tab.label)}</span>
          </button>
        `;
      })
      .join("");

    bindTabTriggers();
    syncUnsupportedPlatformCover(currentActiveTabId);

    const activeTabStillExists = tabs.some(
      (tab) => tab.id === currentActiveTabId,
    );
    if (currentActiveTabId && activeTabStillExists) {
      activateTab(currentActiveTabId);
      return;
    }

    if (
      currentActiveTabId === "settingsTab" ||
      currentActiveTabId === "historyTab"
    ) {
      if (currentActiveTabId === "historyTab") {
        activateTab(currentActiveTabId);
      }
      return;
    }

    if (tabs[0]?.id) {
      activateTab(tabs[0].id);
    }
  };

  renderUnsupportedPlatformCards();
  window.renderPlatformCaptureTabs = renderCaptureTabs;
  window.activateSidebarTab = activateTab;
  renderCaptureTabs(document.body.dataset.selectedPlatform || "unknown");

  // Initialize Accordion
  const accordionHeaders = document.querySelectorAll(".accordion-header");
  accordionHeaders.forEach((header) => {
    header.addEventListener("click", () => {
      const item = header.closest(".accordion-item");
      if (!item) return;

      const isActive = item.classList.contains("is-active");
      document
        .querySelectorAll(".accordion-item")
        .forEach((i) => i.classList.remove("is-active"));
      if (!isActive) {
        item.classList.add("is-active");
      }
    });
  });

  const statusFeedbackTimers = new Map();
  const STATUS_FEEDBACK_CLASSES = [
    "is-info",
    "is-success",
    "is-error",
    "is-warning",
  ];

  const clearStatusFeedback = (elementId) => {
    const timerId = statusFeedbackTimers.get(elementId);
    if (timerId) {
      clearTimeout(timerId);
      statusFeedbackTimers.delete(elementId);
    }

    const el = document.getElementById(elementId);
    if (!el) return;

    el.style.display = "none";
    el.classList.remove(...STATUS_FEEDBACK_CLASSES);
    el.textContent = "";
  };

  window.clearStatusFeedback = clearStatusFeedback;

  window.showStatusFeedback = (
    elementId,
    message,
    type = "is-info",
    options = {},
  ) => {
    const el = document.getElementById(elementId);
    if (!el) return;

    clearStatusFeedback(elementId);

    el.style.display = "flex";
    el.classList.remove(...STATUS_FEEDBACK_CLASSES);
    el.classList.add(type);
    el.innerHTML = formatRichMessageHtml(message);

    const defaultAutoHideMs =
      type === "is-error" ? 5000 : type === "is-warning" ? 4200 : 3000;
    const timeoutMs = Number.isFinite(options.autoHideMs)
      ? options.autoHideMs
      : defaultAutoHideMs;

    if (timeoutMs > 0) {
      const timerId = setTimeout(() => {
        clearStatusFeedback(elementId);
      }, timeoutMs);
      statusFeedbackTimers.set(elementId, timerId);
    }
  };

  window.showMessage = (msg, type = "info") => {
    const toast = document.createElement("div");
    toast.className = `toast is-${type}`;

    let iconSvg = "";
    if (type === "success") {
      iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-circle"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>`;
    } else if (type === "error") {
      iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-circle"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`;
    } else if (type === "warning") {
      iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-alert-circle"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`;
    } else {
      iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
    }

    toast.innerHTML = `
      <div class="toast-icon" style="display:flex;align-items:center;">${iconSvg}</div>
      <div class="toast-content">${formatRichMessageHtml(msg)}</div>
      <button class="toast-close" type="button" aria-label="关闭提示">×</button>
    `;
    document.body.appendChild(toast);

    let remainingMs = TOAST_DEFAULT_DURATION_MS;
    let timerId = null;
    let timerStartedAt = 0;
    let isClosing = false;

    const closeToast = () => {
      if (isClosing) return;
      isClosing = true;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      toast.classList.remove("is-visible");
      setTimeout(() => {
        toast.remove();
      }, TOAST_FADE_OUT_DURATION_MS);
    };

    const startDismissTimer = () => {
      if (isClosing) return;
      if (timerId) {
        clearTimeout(timerId);
      }
      timerStartedAt = Date.now();
      timerId = setTimeout(closeToast, Math.max(0, remainingMs));
    };

    const pauseDismissTimer = () => {
      if (isClosing || !timerId) return;
      clearTimeout(timerId);
      timerId = null;
      const elapsed = Date.now() - timerStartedAt;
      remainingMs = Math.max(0, remainingMs - elapsed);
    };

    const resumeDismissTimer = () => {
      if (isClosing) return;
      if (remainingMs <= 0) {
        closeToast();
        return;
      }
      startDismissTimer();
    };

    toast.addEventListener("mouseenter", pauseDismissTimer);
    toast.addEventListener("mouseleave", resumeDismissTimer);
    toast
      .querySelector(".toast-close")
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeToast();
      });

    // Trigger reflow to apply transition
    void toast.offsetWidth;
    toast.classList.add("is-visible");
    startDismissTimer();
  };

  const historyErrorDetailModal = document.getElementById("historyErrorDetailModal");
  const historyErrorDetailText = document.getElementById("historyErrorDetailText");
  const btnCloseHistoryErrorDetail = document.getElementById(
    "btnCloseHistoryErrorDetail",
  );
  const btnCopyHistoryErrorDetail = document.getElementById(
    "btnCopyHistoryErrorDetail",
  );
  let activeHistoryErrorDetail = "";

  const closeHistoryErrorDetailModal = () => {
    if (!historyErrorDetailModal) return;
    historyErrorDetailModal.classList.remove("is-active");
    historyErrorDetailModal.setAttribute("aria-hidden", "true");
    if (historyErrorDetailText) {
      historyErrorDetailText.textContent = "";
    }
    activeHistoryErrorDetail = "";
  };

  const openHistoryErrorDetailModal = (detail) => {
    if (!historyErrorDetailModal || !historyErrorDetailText) {
      return;
    }
    const normalized = String(detail || "").trim();
    if (!normalized) {
      window.showMessage("暂无错误详情", "info");
      return;
    }
    activeHistoryErrorDetail = normalized;
    historyErrorDetailText.textContent = normalized;
    historyErrorDetailModal.classList.add("is-active");
    historyErrorDetailModal.setAttribute("aria-hidden", "false");
  };

  btnCloseHistoryErrorDetail?.addEventListener("click", closeHistoryErrorDetailModal);
  historyErrorDetailModal?.addEventListener("click", (event) => {
    if (event.target === historyErrorDetailModal) {
      closeHistoryErrorDetailModal();
    }
  });
  btnCopyHistoryErrorDetail?.addEventListener("click", async () => {
    if (!activeHistoryErrorDetail) {
      window.showMessage("暂无可复制内容", "info");
      return;
    }
    try {
      await navigator.clipboard.writeText(activeHistoryErrorDetail);
      window.showMessage("错误详情已复制", "success");
    } catch {
      window.showMessage("复制失败，请手动复制", "error");
    }
  });

  const syncHistoryList = document.getElementById("syncHistoryList");
  syncHistoryList?.addEventListener("click", async (event) => {
    const sectionToggle = event.target.closest("[data-toggle-section]");
    if (sectionToggle) {
      const sectionKey = String(sectionToggle.dataset.toggleSection || "").trim();
      if (
        sectionKey &&
        Object.prototype.hasOwnProperty.call(executionSectionCollapsedState, sectionKey)
      ) {
        executionSectionCollapsedState[sectionKey] =
          !executionSectionCollapsedState[sectionKey];
        await refreshSyncHistory();
      }
      return;
    }

    const debugButton = event.target.closest(".btn-copy-history-debug-url");
    if (debugButton) {
      const debugUrl = debugButton.dataset.debugUrl || "";
      if (!debugUrl) return;

      try {
        await navigator.clipboard.writeText(debugUrl);
        window.showMessage("调试链接已复制", "success");
      } catch {
        window.showMessage("复制失败，请手动复制", "error");
      }
      return;
    }

    const detailButton = event.target.closest(".btn-show-history-error-detail");
    if (detailButton) {
      const detailKey = String(detailButton.dataset.detailKey || "").trim();
      const detail = syncHistoryErrorDetailCache.get(detailKey) || "";
      openHistoryErrorDetailModal(detail);
    }
  });

  const recordList = document.getElementById("recordList");
  recordList?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    const toggleBtn = event.target.closest(".btn-pool-group-toggle");
    if (!toggleBtn) {
      return;
    }
    const groupKey = String(toggleBtn.dataset.poolGroupKey || "").trim();
    if (!groupKey) {
      return;
    }

    const nextCollapsed = !Boolean(dataPoolGroupCollapsedState.get(groupKey));
    dataPoolGroupCollapsedState.set(groupKey, nextCollapsed);
    toggleBtn.setAttribute("aria-expanded", nextCollapsed ? "false" : "true");
    toggleBtn.setAttribute("title", nextCollapsed ? "展开" : "收起");

    const groupContainer = toggleBtn.closest("[data-pool-group]");
    if (groupContainer) {
      groupContainer.classList.toggle("is-collapsed", nextCollapsed);
    }
  });

  const syncHistoryPlatformFilter = document.getElementById(
    "syncHistoryPlatformFilter",
  );
  const btnSyncHistoryPlatformFilter = document.getElementById(
    "btnSyncHistoryPlatformFilter",
  );
  const dropdownSyncHistoryPlatformFilter = document.getElementById(
    "dropdownSyncHistoryPlatformFilter",
  );
  const syncHistoryPlatformFilterLabel = document.getElementById(
    "syncHistoryPlatformFilterLabel",
  );

  const setSyncHistoryPlatformFilterOpen = (isOpen) => {
    if (dropdownSyncHistoryPlatformFilter) {
      dropdownSyncHistoryPlatformFilter.classList.toggle(
        "is-active",
        Boolean(isOpen),
      );
    }
    if (btnSyncHistoryPlatformFilter) {
      btnSyncHistoryPlatformFilter.classList.toggle(
        "is-active",
        Boolean(isOpen),
      );
      btnSyncHistoryPlatformFilter.setAttribute(
        "aria-expanded",
        isOpen ? "true" : "false",
      );
    }
  };

  const syncSyncHistoryPlatformFilterUI = (platform) => {
    const nextPlatform = String(platform || "all").trim() || "all";
    const option =
      SYNC_HISTORY_FILTER_OPTIONS.find((item) => item.value === nextPlatform) ||
      SYNC_HISTORY_FILTER_OPTIONS[0];

    if (syncHistoryPlatformFilter) {
      syncHistoryPlatformFilter.dataset.value = option.value;
    }
    if (syncHistoryPlatformFilterLabel) {
      syncHistoryPlatformFilterLabel.textContent = option.label;
    }
    if (btnSyncHistoryPlatformFilter) {
      btnSyncHistoryPlatformFilter.title = option.title;
    }

    document
      .querySelectorAll(".sync-history-filter-item[data-platform-filter]")
      .forEach((button) => {
        const isActive = button.dataset.platformFilter === option.value;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
  };

  const getSelectedSyncHistoryPlatform = () =>
    String(syncHistoryPlatformFilter?.dataset.value || "all").trim() || "all";

  syncSyncHistoryPlatformFilterUI(getSelectedSyncHistoryPlatform());

  if (btnSyncHistoryPlatformFilter && dropdownSyncHistoryPlatformFilter) {
    btnSyncHistoryPlatformFilter.addEventListener("click", (event) => {
      event.stopPropagation();
      const nextOpenState =
        !dropdownSyncHistoryPlatformFilter.classList.contains("is-active");
      setSyncHistoryPlatformFilterOpen(nextOpenState);
    });

    dropdownSyncHistoryPlatformFilter
      .querySelectorAll(".sync-history-filter-item[data-platform-filter]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const nextPlatform = String(
            button.dataset.platformFilter || "all",
          ).trim();
          syncSyncHistoryPlatformFilterUI(nextPlatform);
          setSyncHistoryPlatformFilterOpen(false);
          void refreshSyncHistory();
        });
      });

    document.addEventListener("click", (event) => {
      if (
        !dropdownSyncHistoryPlatformFilter.contains(event.target) &&
        !btnSyncHistoryPlatformFilter.contains(event.target)
      ) {
        setSyncHistoryPlatformFilterOpen(false);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }
      if (!dropdownSyncHistoryPlatformFilter.classList.contains("is-active")) {
        return;
      }
      event.preventDefault();
      setSyncHistoryPlatformFilterOpen(false);
    });
  }

  subscribe("runtime", (runtimeConfig) => {
    if (!runtimeConfig) return;
    const derivedPagePlatform = detectPlatformFromUrl(
      runtimeConfig.lastPageUrl || "",
    );
    const runtimePagePlatform =
      derivedPagePlatform && derivedPagePlatform !== "unknown"
        ? derivedPagePlatform
        : runtimeConfig.platform || "unknown";
    const datasetPagePlatform = String(
      document.body.dataset.pagePlatform || "",
    ).trim();
    const datasetSelectedPlatform = String(
      document.body.dataset.selectedPlatform || "",
    ).trim();
    const pagePlatform = runtimePagePlatform;
    latestRuntimePagePlatform = pagePlatform || "unknown";
    latestRuntimePageType = runtimeConfig.pageType || PAGE_TYPE.UNKNOWN;
    if (pagePlatform && pagePlatform !== "unknown") {
      document.body.dataset.pagePlatform = pagePlatform;
      if (
        !datasetSelectedPlatform ||
        datasetSelectedPlatform === "unknown"
      ) {
        document.body.dataset.selectedPlatform = pagePlatform;
      }
    }
    const runtimePlatform =
      datasetPagePlatform === runtimePagePlatform &&
      datasetSelectedPlatform &&
      datasetSelectedPlatform !== "unknown"
        ? datasetSelectedPlatform
        : runtimePagePlatform;
    const pagePlatformCopy = getPlatformCopy(pagePlatform);

    const noteHintEl = document.querySelector("#noteTabHint .guidance-content");
    const bloggerHintEl = document.querySelector(
      "#bloggerTabHint .guidance-content",
    );
    const searchHintEl = document.querySelector(
      "#searchTabHint .guidance-content",
    );
    const monitorHintEl = document.querySelector(
      "#monitorTabHint .guidance-content",
    );

    const btnCaptureNote = document.getElementById("btnCaptureNote");
    const btnCaptureBlogger = document.getElementById("btnCaptureBlogger");
    const btnCaptureSearch = document.getElementById("btnCaptureSearch");
    const btnMonitorAddCurrent = document.getElementById(
      "btnMonitorAddCurrent",
    );
    const currentSearchKeywordText = document.getElementById(
      "currentSearchKeywordText",
    );

    // Helper function to update guidance UI
    const updateGuidance = (
      hintEl,
      btnEl,
      pageType,
      currentPagePlatform,
      expectedPlatform,
      expectedPageType,
      readyText,
      wrongPageText,
    ) => {
      if (!hintEl || !btnEl) return;

      const guidanceCallout = hintEl.closest(".guidance-callout");
      const guidanceIcon = guidanceCallout?.querySelector(".guidance-icon");
      const guidanceContent =
        guidanceCallout?.querySelector(".guidance-content");

      if (!guidanceCallout || !guidanceIcon || !guidanceContent) return;

      if (
        pageType === expectedPageType &&
        currentPagePlatform === expectedPlatform
      ) {
        guidanceContent.textContent = readyText;
        guidanceCallout.style.color = "var(--status-success)";
        guidanceCallout.style.background = "rgba(0, 185, 107, 0.08)";
        guidanceCallout.style.borderColor = "rgba(0, 185, 107, 0.2)";
        guidanceIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-circle"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>`;
        btnEl.disabled = false;
        btnEl.classList.remove("is-disabled");
      } else {
        btnEl.disabled = true;
        btnEl.classList.add("is-disabled");

        guidanceCallout.style.background = "rgba(245, 158, 11, 0.1)";
        guidanceCallout.style.borderColor = "rgba(245, 158, 11, 0.2)";
        guidanceCallout.style.color = "var(--status-warning)";
        guidanceIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
        guidanceContent.innerHTML = wrongPageText;
      }
    };

    updateGuidance(
      noteHintEl,
      btnCaptureNote,
      runtimeConfig.pageType,
      pagePlatform,
      pagePlatform,
      PAGE_TYPE.NOTE_DETAIL,
      pagePlatformCopy.noteReadyText,
      pagePlatformCopy.noteWrongText,
    );

    updateGuidance(
      bloggerHintEl,
      btnCaptureBlogger,
      runtimeConfig.pageType,
      pagePlatform,
      pagePlatform,
      PAGE_TYPE.BLOGGER_PROFILE,
      pagePlatformCopy.bloggerReadyText,
      pagePlatformCopy.bloggerWrongText,
    );

    updateGuidance(
      searchHintEl,
      btnCaptureSearch,
      runtimeConfig.pageType,
      pagePlatform,
      pagePlatform,
      PAGE_TYPE.SEARCH_RESULTS,
      pagePlatformCopy.searchReadyText,
      pagePlatformCopy.searchWrongText,
    );

    updateGuidance(
      monitorHintEl,
      btnMonitorAddCurrent,
      runtimeConfig.pageType,
      pagePlatform,
      pagePlatform,
      PAGE_TYPE.BLOGGER_PROFILE,
      pagePlatform === "xiaohongshu"
        ? "已就绪：当前是小红书账号主页，可一键纳入监控"
        : "已就绪：当前是抖音账号主页，可一键纳入监控",
      "请前往抖音或小红书账号主页后，再将当前账号纳入监控",
    );

    const keywordFromUrl = extractKeywordFromUrl(
      runtimeConfig.lastPageUrl || "",
    );
    if (
      runtimeConfig.pageType === PAGE_TYPE.SEARCH_RESULTS &&
      btnCaptureSearch
    ) {
      const hasKeyword = Boolean(keywordFromUrl);
      const canCaptureSearch =
        hasKeyword &&
        pagePlatform === runtimePlatform &&
        getPlatformCapabilities(pagePlatform).captureSearch;
      btnCaptureSearch.disabled = !canCaptureSearch;
      btnCaptureSearch.classList.toggle("is-disabled", !canCaptureSearch);
    }
    if (currentSearchKeywordText) {
      if (
        runtimeConfig.pageType === PAGE_TYPE.SEARCH_RESULTS &&
        keywordFromUrl
      ) {
        currentSearchKeywordText.textContent = keywordFromUrl;
        currentSearchKeywordText.classList.remove("is-empty");
      } else {
        currentSearchKeywordText.textContent = "未检测到关键词";
        currentSearchKeywordText.classList.add("is-empty");
      }
    }

    if (
      runtimeConfig.pageType === PAGE_TYPE.SEARCH_RESULTS &&
      !keywordFromUrl &&
      searchHintEl
    ) {
      const callout = searchHintEl.closest(".guidance-callout");
      const icon = callout?.querySelector(".guidance-icon");
      const content = callout?.querySelector(".guidance-content");
      if (callout && icon && content) {
        callout.style.background = "rgba(245, 158, 11, 0.1)";
        callout.style.borderColor = "rgba(245, 158, 11, 0.2)";
        callout.style.color = "var(--status-warning)";
        icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
        content.textContent = `${
          !getPlatformCapabilities(pagePlatform).captureSearch
            ? "抖音搜索入口已识别，但当前版本暂不支持搜索采集"
            : pagePlatform === "douyin"
              ? "当前未检测到抖音搜索关键词；请先在抖音精选搜索页或搜索结果页输入关键词后再采集"
              : "当前在探索流，未检测到关键词；请先在小红书搜索页输入关键词并点击搜索"
        }`;
      }
    }

    const targetTab = getPreferredTabForPageType(
      pagePlatform,
      runtimeConfig.pageType,
    );
    const activePane = document.querySelector(
      "#mainTabContent .tab-pane.is-active",
    );
    const keepManualTab =
      activePane?.id === "settingsTab" || activePane?.id === "historyTab";

    if (targetTab && !keepManualTab) {
      activateTab(targetTab);
      syncUnsupportedPlatformCover(targetTab);
    } else {
      syncUnsupportedPlatformCover(activePane?.id || "");
    }
  });

  subscribe("auth", (authConfig) => {
    if (!authConfig) return;

    const authCard = document.getElementById("uiAuthCard");
    const badge = document.getElementById("authStatus");
    const bindings = document.getElementById("uiAuthBindings");
    const expire = document.getElementById("uiAuthExpire");
    const userName = document.getElementById("uiAuthUserName");
    const credits = document.getElementById("uiAuthCredits");
    const inputCode = document.getElementById("inputCode");
    const claimHint = document.getElementById("uiAuthClaimHint");
    const claimConfigHint = document.getElementById("uiClaimConfigHint");

    if (
      !authCard ||
      !badge ||
      !bindings ||
      !expire ||
      !userName ||
      !credits ||
      !inputCode
    ) {
      return;
    }

    const pendingClaim = isUnclaimedCredentialOwner(authConfig);

    authCard.classList.remove("is-verified", "is-failed", "is-unclaimed");
    if (claimHint) claimHint.hidden = true;
    if (claimConfigHint) claimConfigHint.hidden = true;

    switch (authConfig.status) {
      case AUTH_STATUS.VERIFIED:
        window.clearStatusFeedback?.("uiAuthFeedback");
        if (pendingClaim) {
          authCard.classList.add("is-unclaimed");
          badge.textContent = "未绑定";
          badge.style.color = "var(--status-warning)";
          if (claimHint) claimHint.hidden = false;
          if (claimConfigHint) claimConfigHint.hidden = false;
        } else {
          authCard.classList.add("is-verified");
          badge.textContent = "已授权";
          badge.style.color = "var(--status-success)";
        }

        if (authConfig.credential) {
          const c = authConfig.credential;
          bindings.textContent = `${c.currentBindings || 0} / ${c.maxBindings || 2}`;
          expire.textContent = c.expiresAt
            ? new Date(c.expiresAt).toLocaleDateString()
            : "永久";
        } else {
          bindings.textContent = "- / 2";
          expire.textContent = "-";
        }
        userName.textContent = pendingClaim
          ? UNCLAIMED_CREDENTIAL_OWNER_LABEL
          : authConfig.user?.name || "-";
        credits.textContent = authConfig.credentialCredit
          ? `${authConfig.credentialCredit.remainingCredits ?? 0} / ${authConfig.credentialCredit.totalCredits ?? 0}`
          : "暂无";
        break;

      case AUTH_STATUS.FAILED:
        authCard.classList.add("is-failed");
        badge.textContent = "授权失效";
        badge.style.color = "var(--status-error)";
        window.showStatusFeedback(
          "uiAuthFeedback",
          ERROR_MESSAGE_MAP[authConfig.reason] || "验证未通过，请重试",
          "is-error",
          {autoHideMs: 5000},
        );
        bindings.textContent = "- / 2";
        expire.textContent = "-";
        userName.textContent = "-";
        credits.textContent = "-";
        break;

      case AUTH_STATUS.VERIFYING:
        window.clearStatusFeedback?.("uiAuthFeedback");
        badge.textContent = "验证中...";
        badge.style.color = "var(--status-info)";
        userName.textContent = authConfig.user?.name || "-";
        credits.textContent = authConfig.credentialCredit
          ? `${authConfig.credentialCredit.remainingCredits ?? 0} / ${authConfig.credentialCredit.totalCredits ?? 0}`
          : "-";
        break;

      case AUTH_STATUS.IDLE:
      default:
        window.clearStatusFeedback?.("uiAuthFeedback");
        badge.textContent = "未验证";
        badge.style.color = "var(--status-warning)";
        bindings.textContent = "- / 2";
        expire.textContent = "-";
        userName.textContent = "-";
        credits.textContent = "-";
        break;
    }
  });

  subscribe("capture", (capConfig) => {
    if (!capConfig) return;

    const capUI = document.getElementById("progressContainer");
    const bar = document.getElementById("progressBar");
    const msg = document.getElementById("progressText");

    if (!capUI || !bar || !msg) return;

    if (capConfig.status === "idle") {
      capUI.style.display = "none";
      return;
    }

    capUI.style.display = "block";

    if (capConfig.status === "capturing") {
      bar.className = "status-bar is-info";
      switch (capConfig.progress?.phase) {
        case CAPTURE_PHASE.CHECKING_PAGE:
          msg.textContent = "检查页面中...";
          break;
        case CAPTURE_PHASE.SCROLLING:
          msg.textContent = `向下滚读中 (${capConfig.progress.percent}%)...`;
          break;
        case CAPTURE_PHASE.EXTRACTING:
          msg.textContent = "正在提取并清洗数据...";
          break;
        default:
          msg.textContent = "采集进行中...";
          break;
      }
    } else if (capConfig.status === "failed") {
      bar.className = "status-bar is-error";
      const errorText = ERROR_MESSAGE_MAP[capConfig.error?.code] || "未知错误";
      msg.textContent = `采集失败：${errorText}`;
      const canceledLike =
        String(capConfig.error?.code || "")
          .toLowerCase()
          .includes("cancel") || String(errorText).includes("取消");
      if (canceledLike) {
        setTimeout(() => {
          capUI.style.display = "none";
        }, 300);
      }
    } else if (capConfig.status === "success") {
      bar.className = "status-bar is-success";
      msg.textContent = "采集成功！(数据已入池)";
      setTimeout(() => {
        capUI.style.display = "none";
      }, 2000);
    } else if (capConfig.status === "canceled") {
      bar.className = "status-bar is-warning";
      msg.textContent = "采集已取消";
      setTimeout(() => {
        capUI.style.display = "none";
      }, 2000);
    }
  });

  subscribe("dataPool", (poolConfig) => {
    if (!poolConfig) return;

    const listContainer = document.getElementById("recordList");
    const emptyState = document.getElementById("uiDataPoolEmpty");
    const statsText = document.getElementById("poolStatsText");

    if (!listContainer || !emptyState || !statsText) {
      return;
    }

    const allRecords = poolConfig.records || [];
    const pageRecords = getCurrentPageRecords(allRecords);

    statsText.textContent = `共 ${pageRecords.length} 条数据`;

    if (pageRecords.length === 0) {
      emptyState.style.display = "block";
      listContainer.style.display = "none";
      listContainer.innerHTML = "";
      return;
    }

    emptyState.style.display = "none";
    listContainer.style.display = "block";

    const activeCaptureTab = getActiveCaptureTab();
    listContainer.innerHTML =
      activeCaptureTab === "bloggerTab"
        ? renderBloggerTabCards(pageRecords)
        : activeCaptureTab === "searchTab"
          ? renderKeywordTabCards(pageRecords)
          : pageRecords.map((record) => renderRecordCard(record)).join("");
    bindDataItemThumbFallbacks(listContainer);
  });

  const renderExecutionDetailsPanel = () => {
    const historyStats = document.getElementById("syncHistoryStatsText");
    const historyEmpty = document.getElementById("syncHistoryEmpty");
    const historyList = document.getElementById("syncHistoryList");
    const selectedPlatform = getSelectedSyncHistoryPlatform();
    const historyConfig = window.getSidebarSyncHistoryState?.() || {entries: []};
    const monitorConfig = window.getSidebarMonitorState?.() || {};

    if (!historyStats || !historyEmpty || !historyList) {
      return;
    }

    const syncEntries = (Array.isArray(historyConfig.entries) ? historyConfig.entries : [])
      .filter((entry) => String(entry?.trigger || "").trim() !== "monitor_run_now");
    const localMonitorEntries = (Array.isArray(historyConfig.entries)
      ? historyConfig.entries
      : []
    ).filter((entry) => String(entry?.trigger || "").trim() === "monitor_run_now");
    const remoteMonitorEntries = Array.isArray(monitorConfig.executions)
      ? monitorConfig.executions
      : [];
    const monitorById = new Map(
      (Array.isArray(monitorConfig.items) ? monitorConfig.items : []).map((item) => [
        String(item?.id || "").trim(),
        item,
      ]),
    );

    const filterByPlatform = (entry) => {
      if (selectedPlatform === "all") {
        return true;
      }
      return String(entry?.platform || "unknown").trim().toLowerCase() === selectedPlatform;
    };

    const filterRemoteMonitorByPlatform = (entry) => {
      if (selectedPlatform === "all") {
        return true;
      }
      const monitorItem = monitorById.get(String(entry?.subscriptionId || "").trim()) || {};
      const platform = String(entry?.platform || monitorItem?.platform || "unknown")
        .trim()
        .toLowerCase();
      return platform === selectedPlatform;
    };

    const filteredSyncEntries = syncEntries.filter(filterByPlatform);
    const filteredLocalMonitorEntries = localMonitorEntries.filter(filterByPlatform);
    const filteredRemoteMonitorEntries = remoteMonitorEntries.filter(
      filterRemoteMonitorByPlatform,
    );
    const filteredMonitorCount =
      filteredLocalMonitorEntries.length + filteredRemoteMonitorEntries.length;
    const totalCount = filteredSyncEntries.length + filteredMonitorCount;

    historyStats.textContent =
      selectedPlatform === "all"
        ? `共 ${totalCount} 条执行记录`
        : `显示 ${totalCount} 条 · 同步 ${filteredSyncEntries.length} / 监控 ${filteredMonitorCount}`;
    syncHistoryErrorDetailCache.clear();

    const syncSectionHtml = renderExecutionSection({
      key: "sync",
      title: "同步记录",
      subtitle: "数据同步记录，包括笔记、博主信息、评论等同步任务；可手动清空本地缓存",
      emptyText: "暂无同步记录",
      content:
        filteredSyncEntries.length > 0
          ? filteredSyncEntries
              .map((entry, index) =>
                renderSyncExecutionHistoryCard(entry, `sync-${index}`),
              )
              .join("")
          : "",
    });

    const monitorSectionHtml = renderExecutionSection({
      key: "monitor",
      title: "监控记录",
      subtitle: "包含本地触发监控批次，以及后端监控执行明细；自动保留最近 7 天，不支持手动清空",
      emptyText: resolveMonitorExecutionEmptyText(monitorConfig),
      content: [
        ...filteredLocalMonitorEntries.map((entry, index) =>
          renderLocalMonitorExecutionCard(entry, `monitor-local-${index}`),
        ),
        ...groupRemoteExecutionsByBatch(filteredRemoteMonitorEntries).map(
          (batch, index) => renderBatchExecutionCard(batch, monitorConfig, `monitor-batch-${index}`),
        ),
      ].join(""),
    });

    historyEmpty.style.display = "none";
    historyList.style.display = "block";
    historyList.innerHTML = `${syncSectionHtml}${monitorSectionHtml}`;
  };

  subscribe("syncHistory", (historyConfig) => {
    if (!historyConfig) return;
    window.getSidebarSyncHistoryState = () => historyConfig;
    renderExecutionDetailsPanel();
  });

  subscribe("monitor", (monitorConfig) => {
    if (!monitorConfig) return;
    window.getSidebarMonitorState = () => monitorConfig;
    renderExecutionDetailsPanel();

    const authConfig = window.getSidebarAuthState?.() || null;
    const monitorStatsText = document.getElementById("monitorStatsText");
    const monitorSubscriptionEmpty = document.getElementById(
      "monitorSubscriptionEmpty",
    );
    const monitorSubscriptionList = document.getElementById(
      "monitorSubscriptionList",
    );
    const btnMonitorAddCurrent = document.getElementById(
      "btnMonitorAddCurrent",
    );
    const btnMonitorRunNow = document.getElementById("btnMonitorRunNow");

    if (btnMonitorAddCurrent) {
      const runtime = window.getSidebarRuntimeState?.() || null;
      const pageUrl = String(runtime?.lastPageUrl || "").trim();
      const currentMonitorId = extractBloggerIdFromMonitorUrl(pageUrl);
      const currentPlatform = detectPlatformFromUrl(pageUrl);
      const exists = Array.isArray(monitorConfig.items)
        ? monitorConfig.items.some(
            (item) =>
              String(item?.platform || "").trim() === currentPlatform &&
              String(item?.platformBloggerId || "").trim() ===
                currentMonitorId &&
              String(item?.status || "").trim() !== "deleted",
          )
        : false;
      const isReady =
        authConfig?.status === AUTH_STATUS.VERIFIED &&
        runtime?.pageType === PAGE_TYPE.BLOGGER_PROFILE &&
        (currentPlatform === "douyin" || currentPlatform === "xiaohongshu");
      btnMonitorAddCurrent.disabled = !isReady || exists;
      btnMonitorAddCurrent.classList.toggle("is-disabled", !isReady || exists);
      btnMonitorAddCurrent.textContent = exists ? "已在监控中" : "纳入监控";
    }

    const activeMonitorCount = Array.isArray(monitorConfig.items)
      ? monitorConfig.items.filter(
          (item) => String(item?.status || "").trim() === "active",
        ).length
      : 0;
    if (btnMonitorRunNow) {
      const canRunNow =
        authConfig?.status === AUTH_STATUS.VERIFIED && activeMonitorCount > 0;
      btnMonitorRunNow.disabled = !canRunNow;
      btnMonitorRunNow.classList.toggle("is-disabled", !canRunNow);
      btnMonitorRunNow.textContent =
        activeMonitorCount > 0
          ? `立即执行扫描（${activeMonitorCount}）`
          : "立即执行扫描";
    }

    if (
      !monitorStatsText ||
      !monitorSubscriptionEmpty ||
      !monitorSubscriptionList
    ) {
      return;
    }

    const items = Array.isArray(monitorConfig.items)
      ? monitorConfig.items.filter(
          (item) => String(item?.status || "").trim() !== "deleted",
        )
      : [];
    monitorStatsText.textContent = `共 ${items.length} 项`;

    if (items.length === 0) {
      monitorSubscriptionEmpty.style.display = "block";
      monitorSubscriptionList.style.display = "none";
      monitorSubscriptionList.innerHTML = "";
    } else {
      monitorSubscriptionEmpty.style.display = "none";
      monitorSubscriptionList.style.display = "flex";
      monitorSubscriptionList.innerHTML = items
        .map((item) => renderMonitorSubscriptionCard(item, monitorConfig))
        .join("");
    }
  });

  void refreshAuth();
  void refreshMonitor();
  void refreshDataPool();
  void refreshSyncHistory();
});

function getCurrentPageRecords(records) {
  const activeCaptureTab = getActiveCaptureTab();
  const activePlatform = document.body.dataset.selectedPlatform || "unknown";
  const types = getRecordTypesForTab(activePlatform, activeCaptureTab);
  return records.filter((record) => {
    if (!types.includes(record.type)) {
      return false;
    }
    if (activePlatform === "unknown") {
      return true;
    }
    return resolveRecordPlatform(record) === activePlatform;
  });
}

function formatHistoryTargetTable(target) {
  if (!target || typeof target !== "object") {
    return "-";
  }

  const explicitTableName = String(target.tableName || "").trim();
  if (explicitTableName) {
    return explicitTableName;
  }

  const tableNames = [
    String(target.tableId || "").trim(),
    String(target.monitorTableName || "").trim(),
    String(target.keywordNotesTableName || "").trim(),
    String(target.bloggerProfileTableName || "").trim(),
    String(target.bloggerNotesTableName || "").trim(),
    String(target.commentLeadsTableName || "").trim(),
  ].filter(Boolean);

  if (tableNames.length === 0) {
    return "-";
  }

  return [...new Set(tableNames)].join(" / ");
}

function renderExecutionSection({
  key,
  title,
  subtitle = "",
  emptyText,
  content = "",
}) {
  const isCollapsed = Boolean(executionSectionCollapsedState[key]);
  return `
    <section class="execution-history-section ${isCollapsed ? "is-collapsed" : ""}" data-section-key="${escapeHtml(key)}">
      <div class="execution-history-section-header">
        <div class="execution-history-section-heading">
          <div class="execution-history-section-title">${escapeHtml(title)}</div>
          ${
            subtitle
              ? `<div class="execution-history-section-subtitle">${escapeHtml(subtitle)}</div>`
              : ""
          }
        </div>
        <button
          class="execution-history-section-toggle"
          type="button"
          data-toggle-section="${escapeHtml(key)}"
          aria-expanded="${isCollapsed ? "false" : "true"}"
          title="${isCollapsed ? "展开" : "折叠"}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="execution-history-section-caret">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
      <div class="execution-history-section-body">
        ${
          content
            ? `<div class="execution-history-section-list">${content}</div>`
            : `<div class="execution-history-section-empty">${escapeHtml(emptyText)}</div>`
        }
      </div>
    </section>
  `;
}

function formatHistoryPlatform(platform) {
  const normalized = String(platform || "")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "unknown") {
    return "未知";
  }
  if (normalized === "mixed") {
    return "多平台";
  }
  return getPlatformCopy(normalized).label;
}

function formatMonitorDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString();
}

function buildHistoryDetailCacheKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createDebugButton(debugUrl) {
  const normalized = String(debugUrl || "").trim();
  if (!normalized) {
    return "";
  }

  return `<button class="action-icon-btn btn-copy-history-debug-url" type="button" title="复制调试链接" data-debug-url="${escapeHtml(normalized)}" style="width: 20px; height: 20px; padding: 0;">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
    </button>`;
}

function createDetailButton(detail, prefix) {
  const normalized = String(detail || "").trim();
  if (!normalized) {
    return "";
  }

  const cacheKey = buildHistoryDetailCacheKey(prefix);
  syncHistoryErrorDetailCache.set(cacheKey, normalized);
  return `<button
      class="action-icon-btn btn-show-history-error-detail"
      type="button"
      title="查看错误详情"
      data-detail-key="${escapeHtml(cacheKey)}"
      style="height: 20px; padding: 0 6px; font-size: 11px; width: auto;">详情</button>`;
}

function renderExecutionHistoryCard({
  title,
  titleUrl = "",
  titleTooltip = "",
  finishedAt = "-",
  statusLabel,
  statusColor,
  summary,
  meta,
  debugUrl = "",
  detailText = "",
  titleClassName = "",
}) {
  const detailButton = createDetailButton(detailText, "history-detail");
  const debugButton = createDebugButton(debugUrl);
  const titleHtml =
    titleUrl && title
      ? `<a class="sync-history-row-text ${titleClassName}" href="${escapeHtml(titleUrl)}" target="_blank" rel="noreferrer noopener" title="${escapeHtml(titleTooltip || title)}">${escapeHtml(title)}</a>`
      : `<span class="sync-history-row-text ${titleClassName}" title="${escapeHtml(titleTooltip || title)}">${escapeHtml(title)}</span>`;

  return `
    <div class="history-item" style="border: 1px solid var(--border-light); border-radius: var(--radius-sm); padding: var(--spacing-sm) var(--spacing-md); margin-bottom: var(--spacing-sm); background: var(--bg-panel); box-shadow: var(--shadow-sm);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
        <div style="font-weight: var(--font-weight-medium); font-size: var(--font-size-sm); color: var(--text-primary); display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; padding-right: 8px;">
          <span style="color: ${statusColor}; font-size: 11px; flex-shrink: 0;">${escapeHtml(statusLabel)}</span>
          ${titleHtml}
        </div>
        <div style="font-size: var(--font-size-xs); color: ${statusColor}; display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
          <span>${escapeHtml(summary)}</span>
          ${detailButton}
          ${debugButton}
        </div>
      </div>
      <div style="font-size: 10px; color: var(--text-tertiary); display: flex; justify-content: space-between;">
        <span>${escapeHtml(finishedAt)}${meta ? ` · ${escapeHtml(meta)}` : ""}</span>
      </div>
    </div>
  `;
}

function resolveSyncHistoryPresentation(entry) {
  const successCount = Number(entry?.successCount || 0);
  const failedCount = Number(entry?.failedCount || 0);
  const skippedCount = Number(entry?.skippedCount || 0);
  const statusLabel =
    failedCount > 0
      ? "失败"
      : skippedCount > 0
        ? "跳过"
        : "成功";
  const statusColor =
    failedCount > 0
      ? "var(--status-error)"
      : skippedCount > 0
        ? "var(--status-warning)"
        : "var(--status-success)";
  const summary =
    skippedCount > 0
      ? `成功 ${Math.max(0, successCount - skippedCount)} / 跳过 ${skippedCount} / 失败 ${failedCount}`
      : `成功 ${successCount} / 失败 ${failedCount}`;

  return {
    statusLabel,
    statusColor,
    summary,
  };
}

function getSyncTriggerText(entry) {
  const trigger = String(entry?.trigger || "").trim();
  if (trigger === "current_page") {
    return "当前页面批量同步";
  }
  if (trigger === "single") {
    return "单条同步";
  }
  return "批量同步";
}

function renderSyncExecutionHistoryCard(entry) {
  const finishedAt = entry.finishedAt
    ? new Date(entry.finishedAt).toLocaleString()
    : "-";
  const scopeText = entry.syncScope === "all" ? "全部" : "仅未同步";
  const presentation = resolveSyncHistoryPresentation(entry);
  const title = `${getSyncTriggerText(entry)}（${scopeText}）`;
  const platformText = formatHistoryPlatform(entry.platform);

  return renderExecutionHistoryCard({
    title,
    titleTooltip: title,
    finishedAt,
    statusLabel: presentation.statusLabel,
    statusColor: presentation.statusColor,
    summary: presentation.summary,
    meta: `平台: ${platformText} · 目标表: ${formatHistoryTargetTable(entry.target)}`,
    debugUrl: resolveEntryDebugUrl(entry),
  });
}

function renderLocalMonitorExecutionCard(entry) {
  const finishedAt = entry.finishedAt
    ? new Date(entry.finishedAt).toLocaleString()
    : "-";
  const monitorDisplay = resolveMonitorHistoryPresentation(entry);
  const monitorName = String(entry?.monitorBloggerName || "").trim();
  const monitorUrl = String(entry?.monitorBloggerUrl || "").trim();
  const scopeText = entry.syncScope === "all" ? "全部" : "仅未同步";
  const title = monitorName || `监控立即执行（${scopeText}）`;

  return renderExecutionHistoryCard({
    title,
    titleUrl: monitorName ? monitorUrl : "",
    titleTooltip: `监控立即执行（${scopeText}）`,
    finishedAt,
    statusLabel: monitorDisplay.statusLabel,
    statusColor: monitorDisplay.statusColor,
    summary: monitorDisplay.summary,
    meta: `来源: 本地触发 · 平台: ${formatHistoryPlatform(entry.platform)} · 目标表: ${formatHistoryTargetTable(entry.target)}`,
    debugUrl: resolveEntryDebugUrl(entry),
    detailText: resolveMonitorHistoryErrorDetail(entry),
  });
}

function resolveMonitorExecutionEmptyText(monitorConfig) {
  if (monitorConfig?.isLoadingExecutions) {
    return "正在加载监控记录...";
  }
  if (monitorConfig?.executionsError) {
    return `加载失败：${monitorConfig.executionsError}`;
  }
  return "暂无监控记录";
}

function resolveRemoteExecutionDisplayName(entry, monitorItem) {
  return (
    String(entry?.bloggerName || "").trim() ||
    resolveMonitorSubscriptionDisplayName(monitorItem) ||
    ""
  );
}

function resolveRemoteExecutionBloggerUrl(entry, monitorItem) {
  return (
    String(entry?.bloggerUrl || "").trim() ||
    String(monitorItem?.bloggerUrl || "").trim()
  );
}

function groupRemoteExecutionsByBatch(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry?.batchId || `_time_${String(entry?.startedAt || "").slice(0, 16)}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(entry);
  }
  return Array.from(groups.values());
}

function resolveBatchExecutionPresentation(batchEntries) {
  let totalHits = 0;
  let totalScanned = 0;
  let totalAccounts = batchEntries.length;
  let hasHit = false;
  let hasFailed = false;
  let hasRunning = false;
  let allFailed = true;

  for (const entry of batchEntries) {
    const status = String(entry?.status || "").trim();
    totalHits += Number(entry?.hitCount || 0);
    totalScanned += Number(entry?.scannedCount || 0);
    if (status === "success") {
      hasHit = true;
      allFailed = false;
    } else if (status === "no_hit") {
      allFailed = false;
    } else if (status === "running") {
      hasRunning = true;
      allFailed = false;
    } else if (status === "skipped_no_balance") {
      allFailed = false;
    } else {
      hasFailed = true;
    }
  }

  if (hasRunning) {
    return {
      statusLabel: "执行中",
      statusColor: "var(--status-info)",
      summary: `执行中 / 账号 ${totalAccounts}`,
    };
  }
  if (allFailed) {
    return {
      statusLabel: "执行失败",
      statusColor: "var(--status-error)",
      summary: `全部失败 / 账号 ${totalAccounts}`,
    };
  }
  if (hasHit) {
    const failedSuffix = hasFailed ? " · 部分失败" : "";
    return {
      statusLabel: "已命中",
      statusColor: "var(--status-success)",
      summary: `命中 ${totalHits} / 扫描 ${totalScanned} / 账号 ${totalAccounts}${failedSuffix}`,
    };
  }
  if (hasFailed) {
    return {
      statusLabel: "部分失败",
      statusColor: "var(--status-warning)",
      summary: `未命中 / 扫描 ${totalScanned} / 账号 ${totalAccounts}`,
    };
  }
  return {
    statusLabel: "未命中",
    statusColor: "var(--text-tertiary)",
    summary: `未命中 / 扫描 ${totalScanned} / 账号 ${totalAccounts}`,
  };
}

function buildBatchExecutionDetail(batchEntries, monitorById) {
  const lines = [];
  for (const entry of batchEntries) {
    const monitorItem = monitorById.get(String(entry?.subscriptionId || "").trim()) || {};
    const displayName = resolveRemoteExecutionDisplayName(entry, monitorItem);
    const platform = entry?.platform || monitorItem?.platform;
    const platformLabel = formatHistoryPlatform(platform);
    const status = String(entry?.status || "").trim();
    const scanned = Number(entry?.scannedCount || 0);
    const hits = Number(entry?.hitCount || 0);
    const credits = Number(entry?.costCredits || 0);

    let statusIcon;
    if (status === "success") {
      statusIcon = "✅";
    } else if (status === "no_hit") {
      statusIcon = "⚪";
    } else if (status === "skipped_no_balance") {
      statusIcon = "⏸️";
    } else if (status === "running") {
      statusIcon = "🔄";
    } else {
      statusIcon = "❌";
    }

    const name = displayName || "未知账号";
    let line = `${statusIcon} ${name}（${platformLabel}）`;

    if (status === "success" || status === "no_hit") {
      line += `  扫描 ${scanned} · 命中 ${hits} · 消耗 ${credits}`;
    } else if (status === "skipped_no_balance") {
      line += `  配额不足跳过`;
    } else if (status === "running") {
      line += `  执行中`;
    } else {
      const errorMsg = String(entry?.errorMessage || "").trim() || "执行失败";
      line += `  ${errorMsg}`;
    }

    const bloggerUrl = resolveRemoteExecutionBloggerUrl(entry, monitorItem);
    if (bloggerUrl) {
      line += `\n   主页：${bloggerUrl}`;
    }

    lines.push(line);
  }

  const totalCredits = batchEntries.reduce((sum, e) => sum + Number(e?.costCredits || 0), 0);
  lines.push("");
  lines.push(`总消耗额度：${totalCredits}`);
  lines.push(`开始时间：${formatMonitorDateTime(batchEntries[0]?.startedAt)}`);
  const lastFinished = batchEntries.reduce((latest, e) => {
    const t = e?.finishedAt || e?.startedAt;
    return t && (!latest || t > latest) ? t : latest;
  }, null);
  lines.push(`结束时间：${formatMonitorDateTime(lastFinished)}`);

  return lines.join("\n");
}

function renderBatchExecutionCard(batchEntries, monitorConfig) {
  const monitorById = new Map(
    (Array.isArray(monitorConfig?.items) ? monitorConfig.items : []).map((item) => [
      String(item?.id || "").trim(),
      item,
    ]),
  );

  const presentation = resolveBatchExecutionPresentation(batchEntries);

  const platforms = new Set();
  for (const entry of batchEntries) {
    const monitorItem = monitorById.get(String(entry?.subscriptionId || "").trim()) || {};
    const platform = String(entry?.platform || monitorItem?.platform || "").trim().toLowerCase();
    if (platform && platform !== "unknown") {
      platforms.add(platform);
    }
  }
  const platformLabel = platforms.size > 0
    ? Array.from(platforms).map((p) => formatHistoryPlatform(p)).join("+")
    : "未知";

  const firstEntry = batchEntries[0];
  const finishedAt = formatMonitorDateTime(firstEntry?.finishedAt || firstEntry?.startedAt);

  return renderExecutionHistoryCard({
    title: `监控批次`,
    titleUrl: "",
    titleTooltip: "后端监控执行批次",
    finishedAt,
    statusLabel: presentation.statusLabel,
    statusColor: presentation.statusColor,
    summary: presentation.summary,
    meta: `来源: 后端执行 · 平台: ${platformLabel}`,
    detailText: buildBatchExecutionDetail(batchEntries, monitorById),
  });
}

function getMonitorStatusLabel(status) {
  switch (String(status || "").trim()) {
    case "active":
      return "启用中";
    case "paused":
      return "已暂停";
    case "paused_insufficient_balance":
      return "配额不足";
    case "deleted":
      return "已删除";
    case "success":
      return "执行成功";
    case "no_hit":
      return "无命中";
    case "failed":
      return "执行失败";
    case "skipped_no_balance":
      return "配额不足跳过";
    case "running":
      return "执行中";
    default:
      return "未知状态";
  }
}

function getMonitorStatusClass(status) {
  switch (String(status || "").trim()) {
    case "active":
      return "is-active";
    case "paused":
      return "is-paused";
    case "paused_insufficient_balance":
      return "is-insufficient";
    case "deleted":
      return "is-deleted";
    default:
      return "";
  }
}

function resolveMonitorSubscriptionDisplayName(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  return (
    String(item.bloggerNameSnapshot || "").trim() ||
    String(item.platformBloggerId || "").trim() ||
    "未命名博主"
  );
}

function extractBloggerIdFromMonitorUrl(url) {
  const normalized = String(url || "").trim();
  const xiaohongshuMatch = normalized.match(/\/user\/profile\/([a-zA-Z0-9_-]+)/i);
  if (xiaohongshuMatch?.[1]) {
    return xiaohongshuMatch[1];
  }
  const douyinMatch = normalized.match(/\/user\/([a-zA-Z0-9._-]+)/i);
  return douyinMatch?.[1] || "";
}

function getMonitorRecordButtonState(record, recordPlatform) {
  if (
    record?.type !== "blogger_profile" ||
    (recordPlatform !== "douyin" && recordPlatform !== "xiaohongshu")
  ) {
    return null;
  }

  const payload = record?.payload || {};
  const authConfig = window.getSidebarAuthState?.() || null;
  const monitorConfig = window.getSidebarMonitorState?.() || null;
  const platformBloggerId =
    recordPlatform === "xiaohongshu"
      ? extractBloggerIdFromMonitorUrl(payload.bloggerUrl || "")
      : String(payload.bloggerId || "").trim();

  if (!platformBloggerId) {
    return {
      label: "纳入监控",
      disabled: true,
      tooltip: "当前博主卡缺少账号 ID，暂时无法纳入监控",
    };
  }

  const exists = Array.isArray(monitorConfig?.items)
    ? monitorConfig.items.some(
        (item) =>
          String(item?.platform || "").trim() === recordPlatform &&
          String(item?.platformBloggerId || "").trim() === platformBloggerId &&
          String(item?.status || "").trim() !== "deleted",
      )
    : false;

  if (exists) {
    return {
      label: "已在监控中",
      disabled: true,
      tooltip: "该账号已纳入监控",
    };
  }

  if (authConfig?.status !== AUTH_STATUS.VERIFIED) {
    return {
      label: "纳入监控",
      disabled: true,
      tooltip:
        "当前功能需要激活码授权，已有激活码请在设置中完成验证；还没有可联系管理员获取。",
    };
  }

  return {
    label: "纳入监控",
    disabled: false,
    tooltip: "将当前博主卡直接纳入监控",
  };
}

function renderMonitorRecordButton(record, recordPlatform) {
  const buttonState = getMonitorRecordButtonState(record, recordPlatform);
  if (!buttonState) {
    return "";
  }

  return `
    <button
      class="action-icon-btn btn-monitor-record"
      type="button"
      data-record-id="${escapeHtml(record.id || "")}"
      title="${escapeHtml(buttonState.tooltip)}"
      style="width: 24px; height: 24px; padding: 0;"
      ${buttonState.disabled ? "disabled" : ""}>
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
    </button>
  `;
}

function renderMonitorSubscriptionCard(item, monitorConfig) {
  const status = String(item?.status || "").trim();
  const statusClass = getMonitorStatusClass(status);
  const statusLabel = getMonitorStatusLabel(status);
  const displayName = resolveMonitorSubscriptionDisplayName(item);
  const platformLabel = formatHistoryPlatform(item?.platform);
  const actionLabel = status === "active" ? "暂停" : "恢复";
  const nextStatus = status === "active" ? "paused" : "active";
  const insufficientHint =
    status === "paused_insufficient_balance"
      ? `<div class="monitor-item-hint">${formatRichMessageHtml("该监控项已因配额不足暂停。获取更多配额后点击“恢复”即可继续执行。")}</div>`
      : "";

  return `
    <div class="monitor-item">
      <div class="monitor-item-header">
        <div style="flex: 1; min-width: 0;">
          <div class="monitor-item-title">
            <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(displayName)}</span>
            ${
              item?.bloggerUrl
                ? `<a class="monitor-item-title-link" href="${escapeHtml(item.bloggerUrl)}" target="_blank" rel="noreferrer noopener" title="访问主页">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                  </a>`
                : ""
            }
          </div>
          <div class="monitor-item-platform-label">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5 5.9 6.5 22 4z"></path></svg>
            ${escapeHtml(platformLabel)}
          </div>
        </div>
        <span class="monitor-status-badge ${statusClass}">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="monitor-item-grid">
        <div class="monitor-item-stat">
          <span class="monitor-item-stat-label">近期命中</span>
          <span class="monitor-item-stat-value">${escapeHtml(formatMonitorDateTime(item?.lastHitAt))}</span>
        </div>
        <div class="monitor-item-stat">
          <span class="monitor-item-stat-label">近期执行</span>
          <span class="monitor-item-stat-value">${escapeHtml(formatMonitorDateTime(item?.lastRunAt))}</span>
        </div>
        <div class="monitor-item-stat">
          <span class="monitor-item-stat-label">下次执行</span>
          <span class="monitor-item-stat-value">${escapeHtml(formatMonitorDateTime(item?.nextRunAt))}</span>
        </div>
        <div class="monitor-item-stat">
          <span class="monitor-item-stat-label">创建时间</span>
          <span class="monitor-item-stat-value">${escapeHtml(formatMonitorDateTime(item?.createdAt))}</span>
        </div>
      </div>
      ${insufficientHint}
      <div class="monitor-item-actions">
        <button class="icon-btn btn-monitor-toggle" type="button" data-id="${escapeHtml(item?.id || "")}" data-next-status="${escapeHtml(nextStatus)}" title="${escapeHtml(actionLabel)}" style="width: 24px; height: 24px;">
          ${
            status === "active"
              ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`
              : `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`
          }
        </button>
        <button class="icon-btn btn-monitor-delete" type="button" data-id="${escapeHtml(item?.id || "")}" title="删除" style="width: 24px; height: 24px; color: var(--status-error); border-color: rgba(245, 74, 69, 0.3);">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      </div>
    </div>
  `;
}

function formatMonitorFrequency(frequency) {
  switch (String(frequency || "").trim()) {
    case "daily":
      return "每天";
    case "every_3_days":
      return "每 3 天";
    case "weekly":
      return "每周";
    default:
      return String(frequency || "-");
  }
}

function getActiveCaptureTab() {
  const activeMainTab = document.querySelector(
    "#mainTabNav .tab-btn.is-active",
  );
  return activeMainTab?.dataset?.target || "noteTab";
}

function buildRecordCardData(record) {
  const recordPlatform = resolveRecordPlatform(record);
  const payload = record?.payload || {};
  const hydratedSinglePayload = getHydratedSingleNotePayload(record);
  if (recordPlatform === "douyin") {
    return buildDouyinCardData(record, payload, hydratedSinglePayload);
  }
  if (recordPlatform === "weibo") {
    return buildWeiboCardData(record, payload, hydratedSinglePayload);
  }
  return buildXiaohongshuCardData(record, payload, hydratedSinglePayload);
}

function getHydratedSingleNotePayload(record) {
  if (record?.type !== "blogger_notes" && record?.type !== "keyword_notes") {
    return null;
  }
  const payload = record?.payload || {};
  const status = String(payload.detailCaptureStatus || "")
    .trim()
    .toLowerCase();
  if (status !== "done") return null;
  if (!payload.detailPayload || typeof payload.detailPayload !== "object") {
    return null;
  }
  return payload.detailPayload;
}

function formatMetricDisplay(value, {captured = true} = {}) {
  if (!captured) {
    return "未采集";
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "未采集";
  }
  return String(Math.floor(parsed));
}

function normalizeGroupIdentityValue(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return `${parsed.hostname}${parsed.pathname}`
        .replace(/\/+$/, "")
        .toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  }

  return raw.toLowerCase();
}

function normalizeGroupNameKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function resolveBloggerGroupDescriptor(record) {
  const payload = record?.payload || {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === "object"
      ? payload.items[0]
      : {};
  const card = buildRecordCardData(record);

  const keyCandidates =
    record?.type === "blogger_profile"
      ? [
          payload.bloggerId,
          payload.douyinId,
          payload.bloggerUrl,
          payload.profileUrl,
          payload.authorUrl,
          payload.bloggerName,
        ]
      : [
          payload.bloggerId,
          payload.douyinId,
          payload.bloggerUrl,
          payload.bloggerName,
          firstItem.bloggerId,
          firstItem.authorId,
          firstItem.douyinId,
          firstItem.bloggerProfileUrl,
          firstItem.authorUrl,
          card.author,
          firstItem.author,
        ];
  const labelCandidates =
    record?.type === "blogger_profile"
      ? [payload.bloggerName, card.profile?.bloggerName, card.title, card.author]
      : [payload.bloggerName, card.profile?.bloggerName, card.title, card.author, firstItem.author];

  const groupLabel =
    labelCandidates.map((item) => String(item || "").trim()).find(Boolean) ||
    "未知博主";
  const normalizedKey =
    keyCandidates.map(normalizeGroupIdentityValue).find(Boolean) ||
    normalizeGroupNameKey(groupLabel);

  return {
    key: normalizedKey || `blogger:${record?.id || "unknown"}`,
    label: groupLabel,
  };
}

function resolveKeywordGroupDescriptor(record) {
  const payload = record?.payload || {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === "object"
      ? payload.items[0]
      : {};
  const keyword =
    [
      payload.keyword,
      payload.searchKeyword,
      firstItem.keyword,
      firstItem.searchKeyword,
    ]
      .map((item) => String(item || "").trim())
      .find(Boolean) || "未识别关键词";
  const key = normalizeGroupNameKey(keyword) || `keyword:${record?.id || "unknown"}`;

  return {
    key,
    label: keyword,
  };
}

function buildGroupedRecords(records, descriptorResolver, groupType = "group") {
  const groups = [];
  const recordsByIdentity = new Map();
  const groupsByName = new Map();
  const otherRecords = [];

  records.forEach((record) => {
    const type = String(record?.type || "").trim();
    if (
      (groupType === "blogger" &&
        type !== "blogger_profile" &&
        type !== "blogger_notes") ||
      (groupType === "keyword" && type !== "keyword_notes")
    ) {
      otherRecords.push(record);
      return;
    }

    const descriptor = descriptorResolver(record);
    const normalizedName = normalizeGroupNameKey(descriptor.label);
    let group = recordsByIdentity.get(descriptor.key);
    if (!group && normalizedName) {
      group = groupsByName.get(normalizedName);
    }

    if (!group) {
      group = {
        identity: descriptor.key || `${groupType}:${record?.id || groups.length}`,
        label: descriptor.label || "未命名分组",
        profileRecords: [],
        noteRecords: [],
      };
      groups.push(group);
      recordsByIdentity.set(group.identity, group);
      if (normalizedName) {
        groupsByName.set(normalizedName, group);
      }
    } else {
      if (
        String(group.label || "").trim() === "未知博主" &&
        String(descriptor.label || "").trim()
      ) {
        group.label = descriptor.label;
      }
      if (descriptor.key && !recordsByIdentity.has(descriptor.key)) {
        recordsByIdentity.set(descriptor.key, group);
      }
      if (normalizedName && !groupsByName.has(normalizedName)) {
        groupsByName.set(normalizedName, group);
      }
    }

    if (type === "blogger_profile") {
      group.profileRecords.push(record);
      return;
    }
    group.noteRecords.push(record);
  });

  return {groups, otherRecords};
}

function renderPoolGroupToggle({
  groupKey = "",
  label = "",
  count = 0,
  collapsed = false,
  prefix = "",
}) {
  const prefixText = prefix ? `${prefix}：` : "";
  return `
    <button
      class="pool-aggregate-toggle btn-pool-group-toggle"
      type="button"
      data-pool-group-key="${escapeHtml(groupKey)}"
      aria-expanded="${collapsed ? "false" : "true"}"
      title="${collapsed ? "展开" : "收起"}">
      <span class="pool-aggregate-caret">▾</span>
      <span class="pool-aggregate-label">${escapeHtml(prefixText)}${escapeHtml(label || "未命名分组")}</span>
      <span class="pool-aggregate-count">${escapeHtml(String(count))} 条笔记</span>
    </button>
  `;
}

function renderDataItemThumb(cover, altText = "cover", emptyText = "无图") {
  if (!cover) {
    return `<div class="data-item-thumb-empty">${escapeHtml(emptyText)}</div>`;
  }
  return `<img class="data-item-thumb" src="${escapeHtml(cover)}" alt="${escapeHtml(altText)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
}

function bindDataItemThumbFallbacks(root = document) {
  root.querySelectorAll?.("img.data-item-thumb").forEach((img) => {
    if (img.dataset.thumbFallbackBound === "1") return;
    img.dataset.thumbFallbackBound = "1";
    img.addEventListener(
      "error",
      () => {
        const fallback = document.createElement("div");
        fallback.className = "data-item-thumb-empty";
        fallback.textContent = img.getAttribute("alt") === "avatar" ? "无头像" : "无图";
        img.replaceWith(fallback);
      },
      {once: true},
    );
  });
}

function renderBloggerTabCards(records) {
  const {groups, otherRecords} = buildGroupedRecords(
    records,
    resolveBloggerGroupDescriptor,
    "blogger",
  );
  const htmlChunks = [];
  const groupsWithProfiles = groups.filter(
    (group) => Array.isArray(group.profileRecords) && group.profileRecords.length > 0,
  );
  const groupsWithoutProfiles = groups.filter(
    (group) => !Array.isArray(group.profileRecords) || group.profileRecords.length === 0,
  );

  if (groupsWithProfiles.length > 0) {
    htmlChunks.push(`<div class="pool-section-title">博主信息卡</div>`);
  }

  groupsWithProfiles.forEach((group, index) => {
    const noteCount = group.noteRecords.length;
    const stateKey = `blogger:${group.identity || index}`;
    const collapsed = noteCount > 0 && Boolean(dataPoolGroupCollapsedState.get(stateKey));
    const profileHtml = group.profileRecords
      .map((record) => renderRecordCard(record, {inBloggerTab: true}))
      .join("");
    const notesHtml = group.noteRecords
      .map((record) => renderRecordCard(record, {inBloggerTab: true}))
      .join("");

    htmlChunks.push(
      `<section class="pool-aggregate-group ${collapsed ? "is-collapsed" : ""}" data-pool-group="${escapeHtml(stateKey)}">`,
    );
    if (profileHtml) {
      htmlChunks.push(profileHtml);
    }
    if (noteCount > 0) {
      htmlChunks.push(
        renderPoolGroupToggle({
          groupKey: stateKey,
          label: group.label || `分组 ${index + 1}`,
          count: noteCount,
          collapsed,
        }),
      );
      htmlChunks.push(`<div class="pool-aggregate-body">${notesHtml}</div>`);
    }
    htmlChunks.push("</section>");
  });

  if (groupsWithoutProfiles.length > 0) {
    htmlChunks.push(
      `<div class="pool-section-title">未匹配博主信息卡的笔记（${groupsWithoutProfiles.reduce((sum, group) => sum + Number(group.noteRecords?.length || 0), 0)} 条）</div>`,
    );
  }

  groupsWithoutProfiles.forEach((group, index) => {
    const noteCount = group.noteRecords.length;
    const stateKey = `blogger:orphan:${group.identity || index}`;
    const collapsed = noteCount > 0 && Boolean(dataPoolGroupCollapsedState.get(stateKey));
    const notesHtml = group.noteRecords
      .map((record) => renderRecordCard(record, {inBloggerTab: true}))
      .join("");

    htmlChunks.push(
      `<section class="pool-aggregate-group ${collapsed ? "is-collapsed" : ""}" data-pool-group="${escapeHtml(stateKey)}">`,
    );
    if (noteCount > 0) {
      htmlChunks.push(
        renderPoolGroupToggle({
          groupKey: stateKey,
          label: group.label || `分组 ${index + 1}`,
          count: noteCount,
          collapsed,
        }),
      );
      htmlChunks.push(`<div class="pool-aggregate-body">${notesHtml}</div>`);
    }
    htmlChunks.push("</section>");
  });

  if (otherRecords.length > 0) {
    htmlChunks.push(
      otherRecords
        .map((record) => renderRecordCard(record, {inBloggerTab: true}))
        .join(""),
    );
  }

  return htmlChunks.join("");
}

function renderKeywordTabCards(records) {
  const {groups, otherRecords} = buildGroupedRecords(
    records,
    resolveKeywordGroupDescriptor,
    "keyword",
  );
  const htmlChunks = [];

  groups.forEach((group, index) => {
    const noteCount = group.noteRecords.length;
    const stateKey = `keyword:${group.identity || index}`;
    const collapsed = noteCount > 0 && Boolean(dataPoolGroupCollapsedState.get(stateKey));
    const notesHtml = group.noteRecords
      .map((record) => renderRecordCard(record))
      .join("");

    htmlChunks.push(
      `<section class="pool-aggregate-group ${collapsed ? "is-collapsed" : ""}" data-pool-group="${escapeHtml(stateKey)}">`,
    );
    htmlChunks.push(
      renderPoolGroupToggle({
        groupKey: stateKey,
        label: group.label || `关键词 ${index + 1}`,
        count: noteCount,
        collapsed,
        prefix: "关键词",
      }),
    );
    htmlChunks.push(`<div class="pool-aggregate-body">${notesHtml}</div>`);
    htmlChunks.push("</section>");
  });

  if (otherRecords.length > 0) {
    htmlChunks.push(otherRecords.map((record) => renderRecordCard(record)).join(""));
  }

  return htmlChunks.join("");
}

function renderRecordCard(record, options = {}) {
  const card = buildRecordCardData(record);
  const recordPlatform = resolveRecordPlatform(record);
  const inBloggerTab = Boolean(options.inBloggerTab);
  const statusClass =
    record.status === RECORD_STATUS.SYNCED
      ? "is-synced"
      : record.status === RECORD_STATUS.FAILED
        ? "is-failed"
        : "is-draft";
  const statusText =
    record.status === RECORD_STATUS.SYNCED
      ? "已同步"
      : record.status === RECORD_STATUS.FAILED
        ? "失败"
        : "未同步";

  if (record.type === "blogger_profile") {
    const monitorRecordButton = renderMonitorRecordButton(
      record,
      recordPlatform,
    );

    return `
      <div class="data-item data-item-profile">
        <div class="data-item-header data-item-header-status-only">
          <span class="data-status-badge ${statusClass}">${statusText}</span>
        </div>
        <div class="data-item-body data-item-body-with-side-actions">
          <div class="data-item-thumb-wrap">
            ${renderDataItemThumb(card.cover, "avatar", "无头像")}
          </div>
          <div class="data-item-main">
            <div class="data-item-title">${escapeHtml(card.profile?.bloggerName || card.title)}</div>
            <div class="data-item-author">
              id：${escapeHtml(card.author)} | ip：${escapeHtml(card.profile?.ipLocation || "未知")}
            </div>
            <div class="blogger-profile-desc">${escapeHtml(card.profile?.description || "暂无简介")}</div>
            <div class="blogger-profile-grid">
              <div>主页：${
                card.profile?.bloggerUrl
                  ? `<a href="${escapeHtml(card.profile.bloggerUrl)}" target="_blank" rel="noreferrer noopener" class="data-item-link">打开主页</a>`
                  : "无"
              }</div>
              <div>关注：${escapeHtml(formatMetricDisplay(card.profile?.followingCount, {captured: Boolean(card.profile?.metricsCaptured)}))}</div>
              <div>粉丝：${escapeHtml(formatMetricDisplay(card.profile?.followersCount, {captured: Boolean(card.profile?.metricsCaptured)}))}</div>
              <div>点赞与收藏：${escapeHtml(formatMetricDisplay(card.profile?.likedAndCollectedCount, {captured: Boolean(card.profile?.metricsCaptured)}))}</div>
            </div>
          </div>
          <div class="data-item-side-actions">
            ${monitorRecordButton}
            ${renderDeleteButton(record.id)}
          </div>
        </div>
      </div>
    `;
  }

  const shouldShowDownload = Boolean(card.allowDownload);
  const useSideActions = Boolean(card.useSideActionsLayout);
  if (useSideActions) {
    return `
      <div class="data-item">
        <div class="data-item-header">
          <span class="data-type-badge">${escapeHtml(card.typeLabel)}</span>
          <span class="data-status-badge ${statusClass}">${statusText}</span>
        </div>
        <div class="data-item-body data-item-body-with-side-actions">
          <div class="data-item-thumb-wrap">
            ${renderDataItemThumb(card.cover)}
          </div>
          <div class="data-item-main">
            ${renderRecordTitle(card)}
            <div class="data-item-author">${escapeHtml(card.author)}</div>
            ${
              card.metaLine
                ? `<div class="data-item-meta">${escapeHtml(card.metaLine)}</div>`
                : ""
            }
            <div class="data-item-metrics">${escapeHtml(card.metricsLine || "")}</div>
          </div>
          <div class="data-item-side-actions">
            ${renderDeleteButton(record.id)}
            ${shouldShowDownload ? renderDownloadButton(record.id, card.hasMedia) : ""}
          </div>
        </div>
        ${buildRecordStatusRows(record)}
      </div>
    `;
  }

  return `
    <div class="data-item">
      <div class="data-item-header">
        <span class="data-type-badge">${escapeHtml(card.typeLabel)}</span>
        <span class="data-status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="data-item-body">
        <div class="data-item-thumb-wrap">
          ${renderDataItemThumb(card.cover)}
        </div>
        <div class="data-item-main">
          ${renderRecordTitle(card)}
          <div class="data-item-author">${escapeHtml(card.author)}</div>
          <div class="data-item-metrics">${escapeHtml(card.metricsLine || "")}</div>
          <div class="data-item-inline-actions">
            ${renderDeleteButton(record.id)}
            ${
              shouldShowDownload
                ? renderDownloadButton(record.id, card.hasMedia)
                : ""
            }
          </div>
        </div>
      </div>
      ${buildRecordStatusRows(record)}
    </div>
  `;
}

function renderDeleteButton(recordId) {
  return `
    <button class="action-icon-btn btn-del-record" data-id="${escapeHtml(recordId)}" title="移除" style="width: 24px; height: 24px; padding: 0;">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
    </button>
  `;
}

function renderRecordTitle(card) {
  const title = String(card?.title || "").trim() || "无标题";
  const titleUrl = String(card?.titleUrl || "").trim();

  if (!titleUrl) {
    return `<div class="data-item-title">${escapeHtml(title)}</div>`;
  }

  return `
    <div class="data-item-title">
      <a class="data-item-title-link" href="${escapeHtml(titleUrl)}" target="_blank" rel="noreferrer noopener" title="${escapeHtml(title)}">${escapeHtml(title)}</a>
    </div>
  `;
}

function renderDownloadButton(recordId, hasMedia) {
  return `
    <button class="action-icon-btn btn-download-record-media" data-id="${escapeHtml(recordId)}" title="导出附件" style="width: 24px; height: 24px; padding: 0;" ${hasMedia ? "" : "disabled"}>
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-paperclip"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
    </button>
  `;
}

function buildRecordStatusRows(record) {
  const detailStatus = resolveDetailCaptureStatusRow(record);
  const commentStatus = resolveCommentStatusRow(record);
  const rows = [detailStatus, commentStatus].filter(Boolean);

  if (rows.length === 0) {
    return "";
  }

  return rows
    .map((statusRow) => {
      const mainText = statusRow?.text || "";
      const mainTextClass = statusRow?.textClass || "";
      const actions = statusRow?.actions || "";

      return `
        <div class="comment-status-row">
          <div class="comment-status-text ${mainTextClass}">${escapeHtml(mainText)}</div>
          <div class="comment-status-actions">${actions}</div>
        </div>
      `;
    })
    .join("");
}

function resolveCommentStatusRow(record) {
  const platform = resolveRecordPlatform(record);
  if (!getPlatformCapabilities(platform).captureComments) {
    return null;
  }

  const effectivePayload =
    record.type === "single_note"
      ? record?.payload || {}
      : getHydratedSingleNotePayload(record);
  if (!effectivePayload) {
    return null;
  }

  const payload = effectivePayload;
  const status = String(payload.commentsCaptureStatus || "not_started");
  const total = Number(payload.commentsTotalCaptured || 0);
  const errorText = String(payload.commentsCaptureError || "").trim();
  const leadsEnabled = Boolean(payload.commentLeadsEnabled);
  const leadsItems = Array.isArray(payload.commentLeadsItems)
    ? payload.commentLeadsItems
    : [];
  const leadsTotal = normalizeDisplayMetricNumber(payload.commentLeadsTotal);
  const resolvedLeadsTotal = leadsTotal ?? leadsItems.length;
  const leadsSyncStatus = String(payload.commentLeadsSyncStatus || "")
    .trim()
    .toLowerCase();
  const leadsSyncError = String(payload.commentLeadsSyncError || "").trim();
  const hasLeadsSignal =
    leadsEnabled ||
    leadsItems.length > 0 ||
    leadsTotal !== null ||
    Boolean(leadsSyncStatus);

  let text = "评论未采集";
  let textClass = "";
  let actions = "";

  if (status === "capturing") {
    text = `评论采集中（${total}条）`;
    textClass = "is-capturing";
    actions = `
      <button
        class="icon-btn is-stop btn-stop-comments"
        type="button"
        title="停止评论采集"
        data-id="${escapeHtml(record.id)}">■</button>
    `;
  } else if (status === "done") {
    text = `评论已合并（${total}条）`;
    textClass = "is-done";
  } else if (status === "partial") {
    text = `已手动停止（${total}条）`;
    textClass = "is-partial";
    actions = `
      <button
        class="icon-btn is-retry btn-retry-comments"
        type="button"
        title="仅重试评论采集"
        data-id="${escapeHtml(record.id)}">↻</button>
    `;
  } else if (status === "failed") {
    text = `评论采集失败${errorText ? `：${errorText}` : ""}`;
    textClass = "is-failed";
    actions = `
      <button
        class="icon-btn is-retry btn-retry-comments"
        type="button"
        title="仅重试评论采集"
        data-id="${escapeHtml(record.id)}">↻</button>
    `;
  }

  if (hasLeadsSignal && (status === "done" || status === "partial")) {
    text += ` · 客资命中（${resolvedLeadsTotal}条）`;
  }
  if (hasLeadsSignal && leadsSyncStatus === "failed") {
    text += leadsSyncError
      ? ` · 客资同步失败：${leadsSyncError}`
      : " · 客资同步失败";
    textClass = "is-failed";
  } else if (hasLeadsSignal && leadsSyncStatus === "skipped") {
    text += " · 客资 0 条，已跳过";
    if (textClass === "is-done") {
      textClass = "is-partial";
    }
  }

  return {text, textClass, actions};
}

function resolveDetailCaptureStatusRow(record) {
  if (record.type !== "blogger_notes" && record.type !== "keyword_notes") {
    return null;
  }

  const payload = record?.payload || {};
  const status = String(payload.detailCaptureStatus || "not_started")
    .trim()
    .toLowerCase();
  const errorText = resolveDetailCaptureErrorText(payload);

  if (
    status === "done" &&
    payload.detailPayload &&
    typeof payload.detailPayload === "object"
  ) {
    // 成功态由评论/客资状态行承载，避免重复提示“详情已补采”
    return null;
  }

  if (status === "capturing") {
    return {
      text: "采集增强中",
      textClass: "is-capturing",
      actions: "",
    };
  }

  if (status === "failed") {
    return {
      text: `采集增强失败${errorText ? `：${errorText}` : ""}`,
      textClass: "is-failed",
      actions: `
        <button
          class="icon-btn is-retry btn-retry-detail"
          type="button"
          title="重试采集增强"
          data-id="${escapeHtml(record.id)}">↻</button>
      `,
    };
  }

  return {
    text: "未执行采集增强",
    textClass: "is-partial",
    actions: `
      <button
        class="icon-btn is-retry btn-retry-detail"
        type="button"
        title="立即执行采集增强"
        data-id="${escapeHtml(record.id)}">↻</button>
    `,
  };
}

function resolveDetailCaptureErrorText(payload = {}) {
  const category = String(payload.detailCaptureFailureCategory || "")
    .trim()
    .toLowerCase();
  const errorText = String(payload.detailCaptureError || "").trim();

  if (category === "link_missing") {
    return "缺少可访问的笔记链接";
  }
  if (category === "context_interrupted") {
    return "插件窗口或页面已中断，请重新执行";
  }
  if (category === "page_failed") {
    return errorText || "页面采集失败，请稍后重试";
  }

  return errorText;
}

function normalizeDisplayMetricNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

function resolveEntryDebugUrl(entry) {
  const topLevel = String(entry?.debugUrl || "").trim();
  if (topLevel) {
    return topLevel;
  }

  const items = Array.isArray(entry?.items) ? entry.items : [];
  for (const item of items) {
    const debugUrl = String(item?.debugUrl || "").trim();
    if (debugUrl) {
      return debugUrl;
    }
  }

  return "";
}

function resolveMonitorHistoryPresentation(entry) {
  const firstItem = Array.isArray(entry?.items) ? entry.items[0] || {} : {};
  const fallbackMessage = String(firstItem?.message || "").trim();
  const fallbackSummary = String(entry?.monitorSummary || "").trim();

  const explicitStatus = String(entry?.monitorStatus || "").trim().toLowerCase();
  const status = explicitStatus || (() => {
    const skippedCount = Number(entry?.skippedCount || 0);
    const noHitCount = Number(entry?.noHitCount || 0);
    const successCount = Number(entry?.successCount || 0);
    const failedCount = Number(entry?.failedCount || 0);

    if (skippedCount > 0) {
      return "credit_insufficient";
    }
    if (noHitCount > 0 && failedCount === 0) {
      return "no_hit";
    }
    if (successCount > 0 && failedCount > 0) {
      return "hit_sync_failed";
    }
    if (successCount > 0) {
      return "hit_synced";
    }
    if (failedCount > 0) {
      return "execution_failed";
    }
    return "no_hit";
  })();

  if (status === "credit_insufficient") {
    return {
      statusLabel: "配额不足",
      statusColor: "var(--status-warning)",
      summary: fallbackSummary || "未执行扫描（配额不足）",
    };
  }

  if (status === "no_hit") {
    return {
      statusLabel: "未命中",
      statusColor: "var(--status-warning)",
      summary: fallbackSummary || "已扫描，未命中",
    };
  }

  if (status === "hit_sync_failed") {
    return {
      statusLabel: "已命中",
      statusColor: "var(--status-error)",
      summary: fallbackSummary || "命中后同步失败",
    };
  }

  if (status === "execution_failed") {
    return {
      statusLabel: "执行失败",
      statusColor: "var(--status-error)",
      summary: fallbackSummary || fallbackMessage || "扫描失败",
    };
  }

  return {
    statusLabel: "已命中",
    statusColor: "var(--status-success)",
    summary: fallbackSummary || "命中后已同步",
  };
}

function resolveMonitorHistoryErrorDetail(entry) {
  const items = Array.isArray(entry?.items) ? entry.items : [];
  const details = [];

  for (const item of items) {
    const rawResponse =
      item?.rawResponse && typeof item.rawResponse === "object"
        ? item.rawResponse
        : {};
    const scannedVideos = Array.isArray(rawResponse?.scannedVideos)
      ? rawResponse.scannedVideos
      : [];
    const threshold = Number(rawResponse?.likeThreshold || 0);
    const publishWindow = String(rawResponse?.publishWindow || "").trim();
    const timezone = String(rawResponse?.timezone || "").trim();
    const monitorBloggerName = String(rawResponse?.monitorBloggerName || "").trim();
    const monitorBloggerUrl = String(rawResponse?.monitorBloggerUrl || "").trim();
    const platform = String(rawResponse?.platform || item?.platform || "").trim();
    const titleParts = [];
    if (monitorBloggerName) {
      titleParts.push(`账号：${monitorBloggerName}`);
    }
    if (platform) {
      titleParts.push(`平台：${platform}`);
    }
    if (monitorBloggerUrl) {
      titleParts.push(`主页：${monitorBloggerUrl}`);
    }
    if (publishWindow) {
      titleParts.push(`发布时间窗口：${publishWindow}`);
    }
    if (timezone) {
      titleParts.push(`时区：${timezone}`);
    }
    if (threshold > 0) {
      titleParts.push(`点赞阈值：${threshold}`);
    }
    if (scannedVideos.length > 0) {
      const scannedLines = scannedVideos.map((video, index) => {
        const contentUrl = String(video?.contentUrl || "").trim();
        const publishedAt = String(video?.publishedAt || "").trim() || "-";
        const likes = Number(video?.likes || 0);
        const inPublishWindow = video?.inPublishWindow === true;
        const observedStatus = String(video?.observedStatus || "").trim().toLowerCase();
        const observeUntil = String(video?.observeUntil || "").trim();
        let decision = "未进入观察池";

        if (!inPublishWindow) {
          decision = "过滤：发布时间不在昨天窗口内";
        } else if (observedStatus === "reported") {
          decision = "已命中并已同步过，本次不重复计入";
        } else if (threshold > 0 && likes >= threshold) {
          decision = `命中：点赞 ${likes} 已达到阈值 ${threshold}`;
        } else if (observedStatus === "closed") {
          decision =
            threshold > 0
              ? `未命中：观察期结束，点赞 ${likes} 仍低于阈值 ${threshold}`
              : "未命中：观察期结束";
        } else if (observedStatus === "pending") {
          decision =
            threshold > 0
              ? `待观察：已进入观察池，但点赞 ${likes} 低于阈值 ${threshold}`
              : "待观察：已进入观察池";
        }

        const extraParts = [
          `发布时间：${publishedAt}`,
          `点赞：${likes}`,
          `是否在发布时间窗口内：${inPublishWindow ? "是" : "否"}`,
          `观察状态：${observedStatus || "out_of_scope"}`,
        ];
        if (observeUntil) {
          extraParts.push(`观察截止：${observeUntil}`);
        }
        if (contentUrl) {
          extraParts.push(`链接：${contentUrl}`);
        }

        return [`作品 ${index + 1}`, ...extraParts, `判定：${decision}`].join("\n");
      });

      details.push([...titleParts, scannedLines.join("\n\n")].filter(Boolean).join("\n"));
      continue;
    }

    const message = String(item?.message || "").trim();
    const reason = String(item?.reason || "").trim().toLowerCase();
    const success = item?.success === true;
    if (!message) {
      continue;
    }
    if (!success || (reason && reason !== "none")) {
      details.push(message);
    }
  }

  if (details.length === 0) {
    const fallback = String(entry?.monitorSummary || "").trim();
    return fallback;
  }

  return Array.from(new Set(details)).join("\n\n");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatRichMessageHtml(message) {
  const escapedMessage = escapeHtml(message);
  return attachPurchaseLinksToEscapedMessage(escapedMessage);
}

function attachPurchaseLinksToEscapedMessage(escapedMessage) {
  const html = String(escapedMessage ?? "");
  if (!html) {
    return "";
  }
  const pattern = new RegExp(
    PURCHASE_LINK_PHRASES.map((phrase) => escapeRegExp(phrase)).join("|"),
    "g",
  );
  return html.replace(pattern, (matchedPhrase) => {
    return `<a href="${PRICING_PAGE_URL}" target="_blank" rel="noopener noreferrer">${matchedPhrase}</a>`;
  });
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEARCH_KEYWORD_QUERY_KEYS = new Set([
  "keyword",
  "query",
  "q",
  "search_keyword",
  "searchkey",
  "search_word",
]);

function extractKeywordFromUrl(url) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) return "";

  try {
    const parsed = new URL(normalizedUrl);
    const keyword = extractKeywordFromSearchParams(parsed.searchParams);
    if (keyword) return keyword;

    const pathname = decodeURIComponentSafe(parsed.pathname || "");
    const douyinPathMatch = pathname.match(
      /\/(?:jingxuan\/search|search)\/([^/?#]+)/i,
    );
    if (douyinPathMatch?.[1]) {
      return decodeURIComponentSafe(douyinPathMatch[1]).trim();
    }

    const hashMatch = String(parsed.hash || "").match(
      /(?:^#|#\/).*search_result\?[^#]*\bkeyword=([^&]+)/i,
    );
    if (hashMatch) {
      return decodeURIComponentSafe(hashMatch[1]).trim();
    }
  } catch {
    // ignore
  }

  const fallbackMatch = normalizedUrl.match(
    /[?&](?:keyword|query|q|search_keyword|searchkey|search_word)=([^&]+)/i,
  );
  if (fallbackMatch) {
    return decodeURIComponentSafe(fallbackMatch[1]).trim();
  }

  const douyinFallbackMatch = normalizedUrl.match(
    /\/(?:jingxuan\/search|search)\/([^/?#]+)/i,
  );
  if (douyinFallbackMatch?.[1]) {
    return decodeURIComponentSafe(douyinFallbackMatch[1]).trim();
  }

  return "";
}

function extractKeywordFromSearchParams(searchParams) {
  if (!searchParams || typeof searchParams.entries !== "function") {
    return "";
  }

  for (const [key, value] of searchParams.entries()) {
    const normalizedKey = String(key || "")
      .trim()
      .toLowerCase();
    if (!SEARCH_KEYWORD_QUERY_KEYS.has(normalizedKey)) {
      continue;
    }

    const decoded = decodeURIComponentSafe(value).trim();
    if (decoded) {
      return decoded;
    }
  }

  return "";
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
  } catch {
    return String(value || "");
  }
}
