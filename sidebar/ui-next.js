import {icon} from "./ui-next-icons.js";

const CAPTURE_TABS = new Set(["noteTab", "bloggerTab", "searchTab"]);

/** Read existing state only. A green label is not a new heartbeat or health probe. */
export function presentationStatus(snapshot = {}) {
  const {runtime, capture, sync} = snapshot;
  if (!runtime) return {text: "连接中", state: "waiting"};
  if (runtime.captureDebugSession?.state === "attached" || capture?.status === "capturing") return {text: "采集中", state: "active"};
  if (sync?.status === "syncing") return {text: "同步中", state: "active"};
  return {text: "已就绪", state: "ready"};
}

/**
 * Reversible DOM presentation. Business controls are MOVED, never cloned or
 * re-created, so their values, listeners, dependencies and disabled state survive.
 * No API calls, no storage writes, no pollers, no capture action is invoked here.
 */
export function mountNextUI({document, window, state}) {
  const undo = [];
  let disposed = false;
  let lastCapture = "noteTab";
  const $ = (selector) => document.querySelector(selector);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const element = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const add = (parent, node, before = null) => {
    parent.insertBefore(node, before);
    undo.push(() => node.remove());
    return node;
  };
  const move = (node, parent, before = null) => {
    if (!node) throw new Error("Missing presentation control");
    const marker = document.createComment("sv-ui-position");
    node.before(marker);
    undo.push(() => marker.replaceWith(node));
    parent.insertBefore(node, before);
  };
  const attr = (node, name, value) => {
    const previous = node.getAttribute(name);
    undo.push(() => previous === null ? node.removeAttribute(name) : node.setAttribute(name, previous));
    if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
  };
  const copy = (node, text) => {
    const previous = node.textContent;
    undo.push(() => { node.textContent = previous; });
    node.textContent = text;
  };
  const listen = (node, event, callback, options) => {
    node.addEventListener(event, callback, options);
    undo.push(() => node.removeEventListener(event, callback, options));
  };
  function unmount() {
    if (disposed) return;
    disposed = true;
    document.documentElement.classList.remove("sv-next");
    document.body.classList.remove("sv-ideas-view", "sv-settings-view", "sv-tasks-view", "sv-no-action", "sv-search-ready");
    // Continue restoration even if an unrelated renderer removed one region.
    for (const restore of undo.reverse()) { try { restore(); } catch (error) { console.warn("[Sidebar presentation] Restore:", error); } }
  }
  const disclosure = (node, title, open = false) => {
    const wrapper = element("details", "sv-disclosure");
    wrapper.open = open;
    const summary = element("summary");
    summary.append(element("span", "sv-disclosure-title", title));
    const value = element("span", "sv-disclosure-value");
    summary.append(value, icon(document, "down"));
    wrapper.append(summary);
    add(node.parentNode, wrapper, node);
    move(node, wrapper);
    return {wrapper, value};
  };
  const selectedText = (id) => {
    const select = document.getElementById(id);
    return select?.selectedOptions?.[0]?.textContent?.replace(/\(默认\)/g, "").trim() || "";
  };
  try {
    for (const id of ["mainTabContent", "mainTabNav", "noteTab", "bloggerTab", "searchTab", "monitorTab", "mainPoolPanel", "settingsAccordion", "uiAuthCard", "btnMoreMenu", "dropdownMoreMenu", "btnPlatformMenu", "menuBtnCheckUpdate", "menuBtnInterfaceMode", "btnToggleKeywordStrategy", "keywordStrategyModalOverlay", "btnKeywordStrategyModalClose", "keywordStrategyModalTitle", "searchManualActionRow", "btnOpenBatchNote", "btnOpenBatchBlogger", "batchModalOverlay", "btnBatchModalClose", "textareaBatchLinks", "textareaBatchBloggers"]) {
      if (!document.getElementById(id)) throw new Error(`UI contract missing: ${id}`);
    }
    // Keep the original platform control and its event handlers. Its DOM order
    // matches the visual order; classic restores its original left position.
    const brand = element("div", "sv-brand");
    const logo = element("img");
    logo.src = "../images/icon128.png";
    logo.alt = "";
    logo.width = 32;
    logo.height = 32;
    brand.append(logo, element("span", "", "星语"));
    add($(".header-top"), brand, $(".header-top").firstChild);
    const welcomeLogo = $("#unsupportedPlatformCover .unsupported-platform-brand-icon");
    if (welcomeLogo) attr(welcomeLogo, "src", "../images/icon128.png");
    const status = add($(".header-top"), element("span", "sv-status"), $(".header-actions"));
    status.setAttribute("aria-live", "polite");
    move($(".platform-switcher"), $(".header-top"), $(".header-actions"));
    attr($(".header-actions"), "hidden", "");

    // Keep the original strategy trigger (including its disabled state and
    // handler) outside the platform renderer's replaceable tab children.
    const tabNav = $("#mainTabNav");
    const topNav = add(tabNav.parentNode, element("div", "sv-top-nav"), tabNav);
    move(tabNav, topNav);
    const strategy = $("#btnToggleKeywordStrategy");
    attr(strategy, "class", `${strategy.className} sv-nav-item sv-ideas-tab`);
    attr(strategy, "data-sv-view", "ideas");
    attr(strategy, "aria-current", null);
    attr(strategy, "aria-label", "创意");
    attr(strategy, "data-sv-tooltip", "创意");
    attr(strategy, "aria-controls", "keywordStrategyModalOverlay");
    add(strategy, element("span", "sv-strategy-label", "创意"));
    copy($("#keywordStrategyModalTitle"), "创意");
    const ideas = $("#keywordStrategyModalOverlay");
    move(ideas, $("#mainTabContent"));
    attr(ideas.querySelector("[role='dialog']"), "role", "region");
    attr(ideas.querySelector(".modal-card"), "aria-modal", null);
    attr(ideas.querySelector(".modal-card"), "aria-label", "创意");
    attr(ideas.querySelector(".keyword-strategy-tabs"), "aria-label", "创意功能");
    const closeIdeas = () => {
      if (ideas.classList.contains("is-active")) $("#btnKeywordStrategyModalClose").click();
    };
    listen(topNav, "click", event => {
      if (event.target.closest(".js-tab-trigger[data-target]")) closeIdeas();
    }, true);
    // Only presentation navigation uses the existing close handler; analysis,
    // cancel, results and current-page eligibility stay owned by the old engine.
    listen(document, "keydown", event => {
      if (event.key === "Escape" && ideas.classList.contains("is-active")) {
        closeIdeas();
        strategy.focus();
        updateNav();
      }
    }, true);

    const nav = add($(".container"), element("nav", "sv-bottom-nav"));
    nav.setAttribute("aria-label", "主要功能");
    const navButtons = new Map();
    for (const [key, label] of [["capture", "采集"], ["tasks", "任务"], ["ideas", "创意"], ["settings", "设置"]]) {
      const btn = key === "ideas" ? strategy : element("button", "sv-nav-item");
      if (key === "ideas") {
        // Move the original trigger, not a proxy that bypasses disabled state.
        move(strategy, nav);
      } else {
        btn.type = "button";
        btn.dataset.svView = key;
        btn.append(icon(document, key), element("span", "", label));
        nav.append(btn);
      }
      navButtons.set(key, btn);
    }
    listen(nav, "click", event => {
      // A selected navigation item stays open. Classic recovers its original
      // toggle behavior after this reversible listener is removed.
      if (strategy.contains(event.target) && ideas.classList.contains("is-active")) event.stopPropagation();
    }, true);
    const dataHeading = add($("#mainPoolPanel"), element("div", "sv-pool-heading", "采集内容"), $("#mainPoolPanel").firstChild);
    move($("#poolStatsText"), dataHeading);
    for (const [id, label] of [["btnClearPool", "清空记录"], ["btnExport", "导出 CSV"]]) {
      add($("#" + id), element("span", "sv-action-label", label));
      attr($("#" + id), "aria-label", label);
    }
    const monitorEntry = add($("#settingsTab"), element("button", "sv-settings-entry"));
    monitorEntry.type = "button";
    monitorEntry.setAttribute("aria-label", "对标监控");
    const monitorCopy = element("span", "sv-settings-entry-copy");
    monitorCopy.append(element("span", "sv-settings-entry-title", "对标监控"), element("span", "sv-settings-entry-note", "关注博主、官方账号与监控列表"));
    monitorEntry.append(monitorCopy, icon(document, "down"));
    listen(monitorEntry, "click", () => {
      window.activateSidebarTab?.("monitorTab");
      $("#mainTabContent").scrollTop = 0;
    });
    const monitorHeader = add($("#monitorTab"), element("div", "sv-monitor-header"), $("#monitorTab").firstChild);
    const monitorBack = element("button", "sv-monitor-back", "返回设置");
    monitorBack.type = "button";
    monitorBack.prepend(icon(document, "down"));
    monitorHeader.append(monitorBack, element("span", "", "对标监控"));
    listen(monitorBack, "click", () => {
      window.activateSidebarTab?.("settingsTab");
      monitorEntry.focus();
    });
    // Reuse the original menu links/actions, including the rollback button.
    // Settings and task-center destinations already exist in the bottom bar.
    // Their classic menu entries remain there, hidden, not duplicated here.
    const help = add($("#settingsTab"), element("div", "sv-settings-links"));
    help.setAttribute("role", "group");
    help.setAttribute("aria-label", "帮助与支持");
    for (const anchor of all("#dropdownMoreMenu > a.dropdown-item")) {
      const acquire = anchor.textContent.trim() === "获取授权";
      move(anchor, acquire ? $("#uiAuthCard") : help);
      attr(anchor, "role", null);
      if (acquire) attr(anchor, "class", `${anchor.className} sv-auth-acquire`);
    }
    const appOptions = add($("#settingsTab"), element("div", "sv-settings-links"));
    appOptions.setAttribute("role", "group");
    appOptions.setAttribute("aria-label", "应用与界面");
    for (const id of ["menuBtnCheckUpdate", "menuBtnInterfaceMode"]) {
      const button = $("#" + id);
      move(button, appOptions);
      attr(button, "role", null);
    }
    const version = add($("#settingsTab"), element("p", "sv-settings-footnote"));
    const manifest = window.chrome?.runtime?.getManifest?.();
    version.textContent = `StarVoice 星语${manifest?.version ? ` · ${manifest.version}` : ""}`;
    // Business settings remain in the DOM for the untouched legacy code. Only
    // their ordinary UI is removed; existing values/defaults are never reset.
    all("#settingsAccordion > .accordion-item").slice(1).forEach(node => attr(node, "hidden", ""));

    // Search: source -> limits -> start mode -> platform filters -> enhancement.
    const searchPanel = $("#searchTab .action-panel");
    const startCard = $("#searchTab .search-execution-card");
    const settings = $("#searchSettingsBody");
    move(startCard, settings, settings.children[2] || null);
    const start = disclosure(startCard, "开始方式");
    const filterCard = $("#searchSettingsBody > .batch-settings");
    const filters = disclosure(filterCard, "平台筛选");
    const enhancements = [];
    for (const pane of ["searchTab", "bloggerTab"]) {
      const card = $(`#${pane} > .action-panel > .detail-enhance-card`) || $(`#${pane} #searchSettingsBody > .detail-enhance-card`);
      if (!card) continue;
      const control = card.querySelector('[data-detail-setting="auto"]');
      const detail = disclosure(card, "采集增强", Boolean(control?.checked));
      enhancements.push({...detail, control});
      const skip = $(`#${pane} [data-detail-setting="skip-captured"]`)?.closest(".form-group");
      if (skip) move(skip, card);
    }
    const sourceControl = $("#chkSearchBatchMode");
    const sourceLabel = sourceControl.closest("label");
    const sourceGroup = element("fieldset", "sv-source-options");
    const legend = element("legend", "sr-only", "关键词来源");
    sourceGroup.append(legend);
    for (const [value, label] of [["current", "当前搜索页"], ["batch", "批量关键词"]]) {
      const item = element("label");
      const radio = element("input");
      radio.type = "radio";
      radio.name = "sv-search-source";
      radio.value = value;
      item.append(radio, document.createTextNode(label));
      sourceGroup.append(item);
      listen(radio, "change", () => {
        const batch = value === "batch";
        // Invoke the existing input's native event path exactly once, only on
        // a user action. Never set capture defaults during mount/navigation.
        if (radio.checked && sourceControl.checked !== batch) sourceControl.click();
      });
    }
    add(searchPanel, sourceGroup, sourceLabel);
    attr(sourceLabel, "hidden", "");
    move($("#searchSingleKeywordGroup"), searchPanel, sourceGroup);
    // Keep the current keyword above its mode, batch textarea immediately below.

    // Consolidate the two original URL workflows without creating a second
    // dispatcher. Each moved button retains its original open-modal handler.
    const batchEntry = add($("#searchManualActionRow"), element("details", "sv-batch-entry"));
    const batchSummary = element("summary", "sv-batch-summary");
    batchSummary.setAttribute("aria-controls", "svBatchOptions");
    batchSummary.append(element("span", "", "批量采集"), icon(document, "down"));
    const batchOptions = element("div", "sv-batch-options");
    batchOptions.id = "svBatchOptions";
    batchOptions.setAttribute("role", "group");
    batchOptions.setAttribute("aria-label", "批量采集方式");
    batchEntry.append(batchSummary, batchOptions);
    for (const [id, label] of [["btnOpenBatchNote", "批量采集作品"], ["btnOpenBatchBlogger", "批量采集博主"]]) {
      const button = $("#" + id);
      move(button, batchOptions);
      attr(button, "class", `${button.className.replace(/\bbtn-icon-only\b/g, "").trim()} sv-batch-option`);
      attr(button, "aria-label", label);
      add(button, element("span", "", label));
    }
    const batchModal = $("#batchModalOverlay");
    attr(batchModal.querySelector('[role="dialog"]'), "aria-labelledby", "batchModalTitle");
    const bloggerInput = $("#textareaBatchBloggers");
    const bloggerLabel = $("#batchPaneBloggers .form-label");
    const bloggerLabelText = [...bloggerLabel.childNodes].find(node => node.nodeType === 3 && node.textContent.includes("博主"));
    if (bloggerLabelText) copy(bloggerLabelText, "博主主页链接 ");
    attr(bloggerInput, "placeholder", "粘贴完整的博主主页链接，每行一个…");
    const bloggerHint = add(bloggerInput.parentNode, element("p", "sv-batch-input-hint", "不支持仅填写博主 ID。采集条件沿用博主页设置。"));
    bloggerHint.id = "svBatchBloggerHint";
    attr(bloggerInput, "aria-describedby", [bloggerInput.getAttribute("aria-describedby"), bloggerHint.id].filter(Boolean).join(" "));
    add($("#textareaBatchLinks").parentNode, element("p", "sv-batch-input-hint", "附加采集选项沿用笔记页设置。"));
    const closeBatchOptions = () => { batchEntry.open = false; };
    listen(batchOptions, "click", event => {
      const button = event.target.closest(".sv-batch-option");
      if (!button || button.disabled) return;
      // The original engine reads enhancement controls from the ACTIVE pane.
      // Restore the workflow's original page before its existing modal handler
      // runs. This also keeps collected results in their original result view.
      window.activateSidebarTab?.(button.id === "btnOpenBatchNote" ? "noteTab" : "bloggerTab");
    }, true);
    listen(batchOptions, "click", event => {
      const button = event.target.closest(".sv-batch-option");
      if (!button || button.disabled) return;
      closeBatchOptions();
      // Original handler has already selected its pane. Focus does not start
      // capture, alter a draft, copy search filters or bypass any disabled gate.
      if (batchModal.classList.contains("is-active")) {
        $(button.id === "btnOpenBatchNote" ? "#textareaBatchLinks" : "#textareaBatchBloggers").focus();
      }
    });
    listen(document, "click", event => { if (!batchEntry.contains(event.target)) closeBatchOptions(); });
    listen(document, "focusin", event => { if (!batchEntry.contains(event.target)) closeBatchOptions(); });
    listen(document, "starvoice:sidebar-tab", closeBatchOptions);
    listen(batchModal, "click", event => {
      if (event.target !== batchModal && !event.target.closest("#btnBatchModalClose")) return;
      const activePage = $("#mainTabContent > .tab-pane.is-active")?.id;
      // Do not jump back to search while an original async batch handler may
      // still be reading its form. Closing only restores focus on this page.
      if (activePage === "searchTab") batchSummary.focus();
      else $(`#mainTabNav [data-target="${activePage}"]`)?.focus();
    });
    listen(document, "keydown", event => {
      if (batchModal.classList.contains("is-active")) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          $("#btnBatchModalClose").click();
        } else if (event.key === "Tab") {
          const controls = [...batchModal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(node => node.getClientRects().length);
          const first = controls[0], last = controls.at(-1);
          if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        }
      } else if (event.key === "Escape" && batchEntry.open) {
        event.preventDefault();
        closeBatchOptions();
        batchSummary.focus();
      }
    }, true);

    // Connect labels that historically had no for/id without touching values.
    let labelCounter = 0;
    all(".form-group > .form-label, .detail-enhance-inline-field > .form-label").forEach(label => {
      if (label.hasAttribute("for")) return;
      const input = label.parentElement.querySelector("input:not([hidden]), select, textarea");
      if (!input) return;
      if (!input.id) attr(input, "id", `sv-field-${++labelCounter}`);
      attr(label, "for", input.id);
    });
    // State is derived, not polled. Text only changes when its value changes.
    const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
    function updateSummaries() {
      if (disposed) return;
      const plan = $("#btnSearchExecutionPlan")?.getAttribute("aria-selected") === "true";
      if (plan) closeBatchOptions();
      const time = $("#inputSearchScheduledStart")?.value;
      setText(start.value, plan ? "无人值守" : time ? `手动 · ${time}` : "手动 · 立即开始");
      const sortLabel = selectedText("selectSearchSort").replace(/排序$/, "");
      const timeLabel = selectedText("selectSearchPublishTime");
      setText(filters.value, [sortLabel, timeLabel === "不限" ? "不限时间" : timeLabel].filter(Boolean).join(" · "));
      for (const {value, control} of enhancements) setText(value, control?.checked ? "已开启" : "未开启");
      sourceGroup.querySelectorAll("input").forEach(radio => {
        radio.checked = (radio.value === "batch") === sourceControl.checked;
        radio.disabled = sourceControl.disabled;
      });
      const active = $("#mainTabContent > .tab-pane.is-active")?.id;
      const noAction = ideas.classList.contains("is-active") || active === "monitorTab" || (active === "searchTab" && plan);
      document.body.classList.toggle("sv-no-action", noAction);
    }
    function updateNav() {
      if (disposed) return;
      const active = $("#mainTabContent > .tab-pane.is-active")?.id || "noteTab";
      if (CAPTURE_TABS.has(active)) lastCapture = active;
      const view = ideas.classList.contains("is-active") ? "ideas" : active === "settingsTab" || active === "monitorTab" ? "settings" : active === "historyTab" ? "tasks" : "capture";
      for (const [key, btn] of navButtons) {
        btn.classList.toggle("is-selected", key === view);
        if (key === view) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
      }
      document.body.classList.toggle("sv-ideas-view", view === "ideas");
      document.body.classList.toggle("sv-settings-view", view === "settings");
      document.body.classList.toggle("sv-tasks-view", view === "tasks");
      updateSummaries();
    }
    listen(nav, "click", event => {
      const view = event.target.closest("[data-sv-view]")?.dataset.svView;
      if (!view) return;
      // The original idea-button handler has already opened its view. Other
      // destinations only close that view; they never start/cancel analysis.
      if (view !== "ideas") {
        closeIdeas();
        const target = view === "settings" ? "settingsTab" : view === "tasks" ? "historyTab" : lastCapture;
        window.activateSidebarTab?.(target);
      }
      updateNav();
      $("#mainTabContent").scrollTop = 0;
    });
    listen(document, "starvoice:sidebar-tab", () => { closeIdeas(); updateNav(); });
    listen(document, "change", updateSummaries);
    // Radio/checkbox native change fires after click. Do not overwrite their
    // checked state in the intervening bubbling click event.
    listen($("#searchTab"), "click", event => {
      if (event.target.closest("[data-search-execution-mode]")) updateSummaries();
    });
    const updateState = () => {
      const snapshot = state.getStateSnapshot();
      const view = presentationStatus(snapshot);
      setText(status, view.text);
      if (status.dataset.state !== view.state) status.dataset.state = view.state;
      // Suppress only redundant success guidance when the keyword identifies
      // an enabled search target. Wrong-page/disabled guidance stays visible.
      const readySearch = snapshot.runtime?.pageType === "search_results" &&
        !$("#btnCaptureSearch")?.disabled &&
        !$("#currentSearchKeywordText")?.classList.contains("is-empty");
      document.body.classList.toggle("sv-search-ready", Boolean(readySearch));
      updateNav();
    };
    for (const key of ["runtime", "capture", "sync"]) undo.push(state.subscribe(key, updateState));
    updateState();
    document.documentElement.classList.add("sv-next");
    undo.push(() => document.documentElement.classList.remove("sv-next"));
    return {unmount};
  } catch (error) {
    unmount();
    throw error;
  }
}
