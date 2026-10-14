/* UI-only harness. The production sidebar-logic.js is explicitly NOT loaded. */
import * as state from "/sidebar/state.js";
import {mountNextUI} from "/sidebar/ui-next.js";
import {getPlatformCapabilities} from "/sidebar/platform-registry.js";
import {installLifecycleFixture} from "./creative-lifecycle.js";
import {installCreativeResultsFixture} from "./creative-results-fixture.js";
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "search";
const platform = params.get("platform") || "xiaohongshu";
const $ = id => document.getElementById(id);
const errorLog = [];
const batchOpenHistory = [];
window.addEventListener("error", e => errorLog.push(e.message));
window.addEventListener("unhandledrejection", e => errorLog.push(String(e.reason)));
const fixtureRecords = () => {
  const type = scenario === "note" ? "single_note" : scenario === "blogger" ? "blogger_notes" : "keyword_notes";
  const records = [
    {id: "fixture-note-1", type, platform, status: "synced", createdAt: new Date().toISOString(), payload: {keyword: "新能源汽车", platform, title: "新能源汽车，一个月真实花费", author: "小林的用车日记", likes: 128, collects: 42, comments: 16, detailCaptureStatus: "done", detailPayload: {title: "新能源汽车，一个月真实花费", author: "小林的用车日记", likes: 128, collects: 42, comments: 16}, items: [{title: "新能源汽车，一个月真实花费", author: "小林的用车日记", likes: 128, publishDate: "今天 09:12"}]}},
    {id: "fixture-note-2", type, platform, status: "draft", createdAt: new Date().toISOString(), payload: {keyword: "新能源汽车", platform, title: "周末自驾，电车续航实测", author: "辰辰出发啦", likes: 86, items: [{title: "周末自驾，电车续航实测", author: "辰辰出发啦", likes: 86}]}},
  ];
  if (scenario === "keywords") {
    for (const [index, keyword, title] of [[3, "纯电 SUV", "三款家用纯电 SUV，空间和续航怎么选"], [4, "家用新能源 SUV 选购与长途续航实测", "周末跑了 500 公里，充电花费记在这里"]]) {
      records.push({id: `fixture-note-${index}`, type, platform, status: "synced", createdAt: new Date().toISOString(), payload: {keyword, platform, title, author: "小周的试驾记录", likes: 64, items: [{title, author: "小周的试驾记录", likes: 64}]}});
    }
  }
  return records;
};
const report = text => parent.postMessage({type: "sv-ui-report", report: text}, location.origin);
const openModal = id => { $(id).classList.add("is-active"); $(id).setAttribute("aria-hidden", "false"); };

// Use load: async fixture initialization must not emit state before the real
// sidebar-ui DOMContentLoaded listener has installed its subscribers.
window.addEventListener("load", async () => {
  document.body.dataset.selectedPlatform = platform;
  document.body.dataset.pagePlatform = platform;
  $("currentPlatformName").textContent = {xiaohongshu: "小红书", douyin: "抖音", weibo: "微博"}[platform];
  $("currentPlatformLogo").className = `platform-trigger-logo platform-logo platform-logo-${platform}`;
  $("currentPlatformLogo").innerHTML = `<span class="platform-logo-${platform}-inner">${platform === "xiaohongshu" ? "小红书" : platform === "weibo" ? "W" : "♪"}</span>`;
  for (const [id, value] of Object.entries({inputKeywordMaxDetectedItems: "50", inputKeywordMinLikes: "0", inputBloggerMaxDetectedItems: "50", inputBloggerMinLikes: "0", inputCommentsMaxDetectedItems: "50"})) $(id).value = value;
  const options = {
    selectSearchSort: platform === "douyin" ? [["comprehensive", "综合排序(默认)"], ["latest", "最新发布"], ["likes", "最多点赞"]] : [["comprehensive", "综合(默认)"], ["latest", "最新"], ["likes", "最多点赞"], ["comments", "最多评论"], ["collects", "最多收藏"]],
    selectSearchPublishTime: [["all", "不限(默认)"], ["day", "一天内"], ["week", "一周内"], ["halfyear", "半年内"]],
    selectSearchContentType: [["all", "不限(默认)"], ["video", "视频"], ["image", "图文"]],
    selectSearchScope: platform === "douyin" ? [["all", "不限(默认)"], ["followed", "关注的人"], ["viewed", "最近看过"], ["unviewed", "还未看过"]] : [["all", "不限(默认)"], ["viewed", "已看过"], ["unviewed", "未看过"], ["followed", "已关注"]],
    selectSearchDistance: [["all", "不限(默认)"], ["city", "同城"], ["nearby", "附近"]],
    selectSearchVideoDuration: [["all", "不限(默认)"], ["under_1m", "1分钟以下"], ["1_5m", "1-5分钟"], ["over_5m", "5分钟以上"]],
  };
  for (const [id, values] of Object.entries(options)) {
    $(id).replaceChildren(...values.map(([value, text]) => new Option(text, value)));
  }
  $("searchVideoDurationField").hidden = platform !== "douyin";
  $("searchDistanceField").hidden = platform === "douyin";
  $("searchContentTypeLabel").textContent = platform === "douyin" ? "内容形式" : "笔记类型";
  const mode = plan => {
    for (const [id, selected] of [["btnSearchExecutionManual", !plan], ["btnSearchExecutionPlan", plan]]) {
      $(id).setAttribute("aria-selected", String(selected)); $(id).classList.toggle("is-active", selected);
    }
    $("searchManualExecutionPane").hidden = plan;
    $("searchPlanExecutionPane").hidden = !plan;
    $("searchManualActionRow").hidden = plan;
  };
  $("btnSearchExecutionManual").onclick = () => mode(false);
  $("btnSearchExecutionPlan").onclick = () => mode(true);
  $("chkSearchBatchMode").onchange = e => {
    $("searchBatchKeywordGroup").hidden = !e.target.checked;
    $("searchSingleKeywordGroup").hidden = e.target.checked;
  };
  const dependencies = () => {
    document.querySelectorAll("[data-auto-detail-panel]").forEach(panel => {
      panel.hidden = !getPlatformCapabilities(platform).batchDetailCapture;
      for (const [setting, group] of [["auto", "options"], ["metrics", "metrics-options"], ["comments", "comments-options"], ["low-follower-hit", "low-follower-hit-threshold-group"]]) {
        const control = panel.querySelector(`[data-detail-setting="${setting}"]`);
        const target = panel.querySelector(`[data-detail-setting-group="${group}"]`);
        if (control && target) target.hidden = !control.checked;
      }
    });
    $("commentsMaxDetectedItemsGroup").hidden = !$("checkboxCaptureComments").checked;
    $("commentLeadsFilterGroup").hidden = !$("checkboxCaptureComments").checked;
    $("searchKeywordPlanCustomDatesGroup").hidden = $("selectSearchKeywordPlanMode").value !== "custom_dates";
  };
  document.addEventListener("change", dependencies);
  document.querySelectorAll('[data-detail-setting="comments-max-detected-items"]').forEach(el => el.value = "50");
  document.querySelectorAll('[data-detail-setting="low-follower-hit-threshold"]').forEach(el => el.value = "10000");
  $("btnMoreMenu").onclick = () => {
    const open = $("dropdownMoreMenu").classList.toggle("is-active");
    $("btnMoreMenu").setAttribute("aria-expanded", String(open));
  };
  $("btnPlatformMenu").onclick = () => {
    const open = $("dropdownPlatformMenu").classList.toggle("is-active");
    $("btnPlatformMenu").setAttribute("aria-expanded", String(open));
  };
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { $("dropdownMoreMenu").classList.remove("is-active"); $("dropdownPlatformMenu").classList.remove("is-active"); $("btnPlatformMenu").setAttribute("aria-expanded", "false"); document.querySelectorAll(".modal-overlay.is-active").forEach(el => {el.classList.remove("is-active");el.setAttribute("aria-hidden", "true");}); }
  });
  $("menuBtnSettings").onclick = () => { window.activateSidebarTab("settingsTab"); $("dropdownMoreMenu").classList.remove("is-active"); };
  $("menuBtnHistory").onclick = () => { window.activateSidebarTab("historyTab"); $("dropdownMoreMenu").classList.remove("is-active"); };
  $("btnCodeVisibility").onclick = () => $("inputCode").type = $("inputCode").type === "password" ? "text" : "password";
  $("btnToggleKeywordStrategy").onclick = () => {
    const overlay = $("keywordStrategyModalOverlay");
    const visible = overlay.classList.toggle("is-active");
    overlay.setAttribute("aria-hidden", String(!visible));
  };
  const strategyPanes = {opportunity: "keywordStrategyOpportunityPane", benchmark: "keywordStrategyBenchmarkPane", longtail: "keywordStrategyLongtailPane"};
  document.querySelectorAll("[data-strategy-tab]").forEach(button => {
    button.onclick = () => {
      document.querySelectorAll("[data-strategy-tab]").forEach(tab => {
        const selected = tab === button;
        tab.classList.toggle("is-active", selected);
        tab.setAttribute("aria-selected", String(selected));
        $(strategyPanes[tab.dataset.strategyTab]).hidden = !selected;
      });
    };
  });
  const openBatch = (kind) => {
    batchOpenHistory.push({kind, page: document.querySelector("#mainTabContent > .tab-pane.is-active")?.id});
    $("batchPaneLinks").hidden = kind !== "links";
    $("batchPaneBloggers").hidden = kind !== "bloggers";
    $("batchPaneKeywords").hidden = true;
    $("batchModalTitle").textContent = kind === "links" ? "批量采集作品" : "批量采集博主";
    openModal("batchModalOverlay");
  };
  $("btnOpenBatchNote").onclick = () => openBatch("links");
  $("btnOpenBatchBlogger").onclick = () => openBatch("bloggers");
  document.querySelectorAll('.modal-overlay [id*="Close"], .modal-overlay [id*="Cancel"]').forEach(btn => btn.onclick = () => { const modal = btn.closest(".modal-overlay"); modal.classList.remove("is-active"); modal.setAttribute("aria-hidden", "true"); });
  ["btnVerify", "btnCaptureNote", "btnCaptureBlogger", "btnCaptureSearch", "btnSyncAll", "btnExport", "btnClearPool", "btnSaveSearchKeywordPlan", "btnRunBatchLinks", "btnRunBatchBloggers", "btnRunKeywordOpportunity", "btnRunBenchmarkDiscovery", "btnExpandKeywords", "menuBtnCheckUpdate"].forEach(id => { $(id).addEventListener("click", () => window.showMessage?.("隔离验收：操作入口正常，未执行真实采集或后台请求。", "info")); });
  const auth = scenario === "unauthorized" ? {status: "idle"} : scenario === "expired" ? {status: "failed", reason: "expired", message: "授权已到期，请联系管理员续期"} : {status: "verified", verified: true, code: "DEMO-NOT-A-CREDENTIAL", user: {name: "演示账号"}, tenant: {name: "演示企业"}, credential: {status: "active", expiresAt: "2027-07-28T00:00:00Z", maxBindings: 20, currentBindings: 7}};
  const now = new Date().toISOString();
  await chrome.storage.local.set({
    "onstarvoice.auth": auth,
    "onstarvoice.data_pool": {records: scenario === "empty" ? [] : fixtureRecords()},
    "onstarvoice.monitor": {items: [
      {id: "fixture-monitor-1", displayName: "上海安吉星信息服务有限公司", platform, subjectType: "official", status: "active", lastHitAt: null, lastRunAt: "2026-10-14T02:00:00Z", nextRunAt: "2026-10-14T03:00:00Z", createdAt: "2026-10-10T01:00:00Z"},
      {id: "fixture-monitor-2", displayName: "智驾观察站", platform, subjectType: "creator", status: "paused_insufficient_balance", lastHitAt: "2026-10-13T01:12:00Z", lastRunAt: "2026-10-13T02:00:00Z", nextRunAt: null, createdAt: "2026-10-09T01:00:00Z"},
    ], executions: []},
    "onstarvoice.taskLedger": {version: 1, runs: [
      {id: "preview-task-1", title: "新能源汽车 · 关键词采集", taskType: "keyword_capture", status: "running", platform, createdAt: now, updatedAt: now, progress: {percent: 61, message: "正在完善作品详情"}},
      {id: "preview-task-2", title: "智驾观察站 · 博主页采集", taskType: "capture", status: "failed", platform, createdAt: now, updatedAt: now, error: {message: "页面校验未通过，请定位到对应标签页后继续。"}},
      {id: "preview-task-3", title: "品牌官方账号 · 对标监控", taskType: "monitor", status: "completed", platform, createdAt: now, finishedAt: now},
    ]},
  });
  await state.initAllStates();
  window.renderPlatformCaptureTabs(platform);
  window.getSidebarRuntimeState = state.getCurrentRuntime;
  window.getSidebarAuthState = state.getCurrentAuth;
  const typeMap = {note: "note_detail", blogger: "blogger_profile", monitor: "blogger_profile", "wrong-page": "unknown", unsupported: "unknown"};
  if (scenario === "unsupported") {
    document.body.dataset.pagePlatform = "unknown";
    document.body.dataset.selectedPlatform = "unknown";
    $("currentPlatformName").textContent = "未识别平台";
  }
  if (typeMap[scenario]) await state.setCurrentRuntime({...state.getCurrentRuntime(), pageType: typeMap[scenario], ...(scenario === "unsupported" ? {platform: "unknown", selectedPlatform: "unknown", lastPageUrl: "about:blank"} : {})});
  // Match the existing engine's page/capability boundary; moving an entry
  // must not enable analysis on an ineligible page in the isolated preview.
  const currentRuntime = state.getCurrentRuntime();
  $("btnToggleKeywordStrategy").disabled = currentRuntime.pageType !== "search_results" || !getPlatformCapabilities(platform).captureSearch || currentRuntime.platform !== currentRuntime.selectedPlatform;
  window.activateSidebarTab({note: "noteTab", blogger: "bloggerTab", monitor: "monitorTab", tasks: "historyTab", settings: "settingsTab", unauthorized: "settingsTab", expired: "settingsTab"}[scenario] || "searchTab");
  // Real sidebar-ui renders records/auth/task center from the synthetic state.
  dependencies();
  document.dispatchEvent(new Event("change"));
  if (scenario === "empty") ["btnClearPool", "btnExport", "btnSyncAll"].forEach(id => $(id).disabled = true);
  if (["running", "waiting"].includes(scenario)) {
    // Static render rehearsal only; the actual running renderer/engine is not
    // loaded. Use the unchanged production markup to check layering and color.
    await state.setCurrentRuntime({...state.getCurrentRuntime(), captureDebugSession: {state: "attached"}});
    $("debugSessionPanel").hidden = false;
    $("debugSessionPageTitle").textContent = "新能源汽车 · 搜索页";
    $("debugSessionPageUrl").textContent = "小红书 / 演示数据，不执行真实采集";
    $("debugSessionKeyword").textContent = "新能源汽车";
    $("debugSessionProgressBar").style.width = "61%";
    $("debugSessionElapsed").textContent = "已运行 03:35";
    $("debugSessionProgressPercent").hidden = false;
    $("debugSessionProgressPercent").textContent = "61%";
    $("debugSessionCurrentMessage").textContent = "正在完善作品详情";
    $("debugSessionRecentMessage").textContent = "已保存第 8 条作品详情";
    document.querySelectorAll("#debugSessionSteps li").forEach((item, i) => item.classList.add(i < 3 ? "is-complete" : i === 3 ? "is-active" : "is-pending"));
    $("debugSessionWaitCard").hidden = scenario !== "waiting";
    $("debugSessionWaitCountdown").textContent = "00:12";
    $("btnDebugSessionMinimize").onclick = () => { $("debugSessionPanel").hidden = true; $("debugSessionDock").hidden = false; };
    $("debugSessionDock").onclick = () => { $("debugSessionPanel").hidden = false; $("debugSessionDock").hidden = true; };
    $("btnDebugSessionStop").onclick = () => window.showMessage?.("隔离演练：未停止任何真实任务。", "info");
  }
  installLifecycleFixture({document, window, state, platform, report, errorLog});
  const creativePreview = installCreativeResultsFixture({document, window, scenario, platform, report});
  if (creativePreview) await creativePreview.ready;
  report("隔离界面已就绪。经典版右上角可试用新版；新版在设置内切回经典界面。");
});

window.addEventListener("message", async event => {
  if (event.origin !== location.origin || event.source !== parent || event.data?.type !== "sv-ui-test") return;
  const results = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); results.push("通过 · " + message); };
  try {
    if (document.documentElement.classList.contains("sv-next")) {
      $("menuBtnInterfaceMode").click();
    }
    const originals = [...document.querySelectorAll("input, select, textarea, button[id], #dropdownMoreMenu > a")];
    const initial = originals.map(el => ({el, parent: el.parentNode, value: el.value, checked: el.checked, disabled: el.disabled}));
    const menuItems = [...$("dropdownMoreMenu").children];
    const menuSnapshot = menuItems.map(el => ({el, role: el.getAttribute("role"), href: el.getAttribute("href"), className: el.className}));
    const headerChildren = [...document.querySelector(".header-top").children];
    const batchOriginals = ["btnOpenBatchNote", "btnOpenBatchBlogger"].map(id => ({el: $(id), parent: $(id).parentNode, className: $(id).className, text: $(id).textContent}));
    const bloggerLabelText = document.querySelector("#batchPaneBloggers .form-label").textContent;
    const bloggerPlaceholder = $("textareaBatchBloggers").getAttribute("placeholder");
    const bloggerDescription = $("textareaBatchBloggers").getAttribute("aria-describedby");
    const listeners = new Map();
    const testState = {getStateSnapshot: () => state.getStateSnapshot(), subscribe: (key, fn) => {const token = Symbol(key); listeners.set(token, fn); return () => listeners.delete(token);}};
    let inputEvents = 0;
    const count = () => inputEvents++;
    document.addEventListener("change", count);
    let adapter = mountNextUI({document, window, state: testState});
    assert(listeners.size === 3, "新版仅订阅现有三种状态，不增加轮询");
    assert(inputEvents === 0, "进入新版不修改字段、不触发业务 change");
    assert(initial.every(x => x.el.isConnected && x.el.value === x.value && x.el.checked === x.checked && x.el.disabled === x.disabled), "所有原始控件保持同一节点、值与禁用状态");
    assert(new Set([...document.querySelectorAll("[id]")].map(el => el.id)).size === document.querySelectorAll("[id]").length, "没有重复 DOM ID");
    assert(document.querySelectorAll(".sv-bottom-nav").length === 1 && [...document.querySelectorAll(".sv-bottom-nav > button")].map(btn => btn.textContent.trim()).join("/") === "采集/任务/创意/设置", "底部为采集、任务、创意、设置四个入口，没有重复数据入口");
    assert(document.querySelector(".header-actions").hidden && [...document.querySelector(".header-top").children].filter(el => !el.hidden).at(-1).classList.contains("platform-switcher"), "更多菜单收起，原平台切换控件位于顶栏最右侧");
    assert(menuSnapshot.filter(x => x.el.tagName === "A").every(x => $("settingsTab").contains(x.el) && x.el.getAttribute("href") === x.href && !x.el.hasAttribute("role")), "四个原帮助与授权链接移入设置，链接不变且恢复原生语义");
    assert($("menuBtnCheckUpdate").closest(".sv-settings-links") && $("menuBtnInterfaceMode").closest(".sv-settings-links") && !$("menuBtnInterfaceMode").hasAttribute("role"), "原检查更新与经典回退按钮移入设置，仍为同一按钮");
    assert($("uiAuthCard").querySelectorAll("a.sv-auth-acquire").length === 1 && document.querySelectorAll(".sv-settings-links a").length === 3 && !$("settingsTab").contains($("menuBtnSettings")) && !$("settingsTab").contains($("menuBtnHistory")), "授权链接仅一处，帮助不重复，已有设置和任务入口不重复添加");
    const strategy = $("btnToggleKeywordStrategy");
    const strategyTitle = $("keywordStrategyModalTitle");
    assert(document.querySelector(".sv-bottom-nav").children[2] === strategy && !document.querySelector(".sv-top-nav").contains(strategy) && strategy.getAttribute("aria-label") === "创意" && strategyTitle.textContent === "创意", "创意复用原按钮位于底栏第三项，顶部及搜索区不重复放入口");
    assert($("keywordStrategyModalOverlay").parentNode === $("mainTabContent") && $("keywordStrategyModalOverlay").querySelector("[role=region]") && document.querySelectorAll("[data-strategy-tab]").length === 3, "三个原创意功能作为页内区域保留，不创建第二份业务控件");
    const originalNav = $("mainTabNav");
    window.renderPlatformCaptureTabs(platform);
    assert(strategy.isConnected && strategy.closest(".sv-bottom-nav") && $("mainTabNav") === originalNav && document.querySelectorAll(".sv-ideas-tab").length === 1 && $("mainTabNav").querySelectorAll('[data-target]:not([data-target="monitorTab"])').length === 3, "平台重绘保留三个采集标签及唯一底部创意入口");
    window.activateSidebarTab("searchTab");
    const batchEntry = document.querySelector(".sv-batch-entry");
    const batchSummary = batchEntry.querySelector("summary");
    assert(batchEntry.parentNode === $("searchManualActionRow") && batchOriginals.every(x => batchEntry.contains(x.el)) && !document.querySelector("#noteTab .btn-batch-trigger, #bloggerTab .btn-batch-trigger"), "批量统一位于搜索主按钮旁，笔记和博主页不再有批量入口");
    assert(document.querySelector("#batchPaneBloggers .form-label").textContent.trim() === "博主主页链接 每行一个" && $("textareaBatchBloggers").placeholder === "粘贴完整的博主主页链接，每行一个…" && $("textareaBatchBloggers").getAttribute("aria-describedby").includes("svBatchBloggerHint"), "博主文案明确要求完整主页链接，并保留可访问说明");
    let captureClicks = 0;
    const countCapture = () => captureClicks++;
    const runButtons = [$("btnRunBatchLinks"), $("btnRunBatchBloggers"), $("btnCaptureSearch")];
    runButtons.forEach(button => button.addEventListener("click", countCapture));
    for (const [id, kind, pane, input] of [["btnOpenBatchNote", "links", "batchPaneLinks", "textareaBatchLinks"], ["btnOpenBatchBlogger", "bloggers", "batchPaneBloggers", "textareaBatchBloggers"]]) {
      window.activateSidebarTab("searchTab");
      const draft = $(input).value;
      const calls = batchOpenHistory.length;
      batchSummary.click();
      $(id).click();
      const ownerPage = kind === "links" ? "noteTab" : "bloggerTab";
      assert(batchOpenHistory.length === calls + 1 && batchOpenHistory.at(-1).kind === kind && batchOpenHistory.at(-1).page === ownerPage && !$(pane).hidden && $("batchModalOverlay").classList.contains("is-active") && !batchEntry.open && document.activeElement === $(input), `${kind === "links" ? "作品" : "博主"}先恢复原页面上下文，再触发一次原弹窗事件，焦点进入原输入框`);
      $(input).value = "https://example.org/ui-only-draft";
      $("btnBatchModalClose").click();
      assert(!$("batchModalOverlay").classList.contains("is-active") && $(ownerPage).classList.contains("is-active") && document.activeElement?.dataset.target === ownerPage && $(input).value === "https://example.org/ui-only-draft", "关闭弹窗保留原采集页面和草稿，不在异步执行期间切走参数上下文");
      $(input).value = draft;
    }
    window.activateSidebarTab("searchTab");
    batchSummary.click();
    batchSummary.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    assert(!batchEntry.open && document.activeElement === batchSummary, "Escape 可关闭批量选项并回到入口");
    batchSummary.click();
    $("btnOpenBatchBlogger").click();
    $("textareaBatchBloggers").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    assert(!$("batchModalOverlay").classList.contains("is-active") && document.activeElement?.dataset.target === "bloggerTab", "批量弹窗 Escape 复用原关闭动作并保留博主页，不启动或停止任务");
    window.activateSidebarTab("searchTab");
    batchSummary.click();
    window.activateSidebarTab("noteTab");
    assert(!batchEntry.open && !$("noteTab").contains($("btnOpenBatchNote")), "切换采集页自动收起选项，不残留浮层");
    window.activateSidebarTab("searchTab");
    batchSummary.click();
    document.querySelector(".sv-brand").click();
    assert(!batchEntry.open, "点击外部关闭批量选项");
    const wasBatchDisabled = $("btnOpenBatchBlogger").disabled;
    const openCount = batchOpenHistory.length;
    $("btnOpenBatchBlogger").disabled = true;
    batchSummary.click();
    $("btnOpenBatchBlogger").click();
    assert(batchOpenHistory.length === openCount && !$("batchModalOverlay").classList.contains("is-active"), "统一入口不会绕过原批量按钮禁用态");
    $("btnOpenBatchBlogger").disabled = wasBatchDisabled;
    $("btnSearchExecutionPlan").click();
    assert($("searchManualActionRow").hidden && !batchEntry.open, "无人值守仍沿用原操作区显隐，不夹带手动批量入口");
    $("btnSearchExecutionManual").click();
    const originalBloggerDraft = $("textareaBatchBloggers").value;
    $("textareaBatchBloggers").value = "https://example.org/preserved-ui-draft";
    assert(captureClicks === 0, "打开、选择、关闭和导航均未触发任何采集按钮");
    runButtons.forEach(button => button.removeEventListener("click", countCapture));
    if (!strategy.disabled) {
      strategy.click();
      assert($("keywordStrategyModalOverlay").classList.contains("is-active") && strategy.getAttribute("aria-current") === "page" && document.body.classList.contains("sv-ideas-view"), "底部创意沿用原打开事件，选中状态同步");
      strategy.click();
      assert($("keywordStrategyModalOverlay").classList.contains("is-active"), "重复选择当前创意标签不意外退出");
      document.querySelector('.sv-nav-item[data-sv-view="capture"]').click();
      assert(!$("keywordStrategyModalOverlay").classList.contains("is-active") && $("searchTab").classList.contains("is-active") && !document.body.classList.contains("sv-ideas-view"), "返回采集关闭创意展示，原搜索表单和结果仍在同页");
      for (const destination of ["settings", "tasks"]) {
        document.querySelector(`.sv-nav-item[data-sv-view="${destination}"]`).click();
        strategy.click();
        assert($("keywordStrategyModalOverlay").classList.contains("is-active") && strategy.getAttribute("aria-current") === "page", `从${destination === "settings" ? "设置" : "任务"}可进入创意，不改变原页面可用性限制`);
        document.querySelector(`.sv-nav-item[data-sv-view="${destination}"]`).click();
        assert(!$("keywordStrategyModalOverlay").classList.contains("is-active") && document.querySelector(`[data-sv-view="${destination}"]`).getAttribute("aria-current") === "page", `创意可返回${destination === "settings" ? "设置" : "任务"}，导航状态不残留`);
      }
      document.querySelector('.sv-nav-item[data-sv-view="capture"]').click();
    } else {
      strategy.click();
      assert(!$("keywordStrategyModalOverlay").classList.contains("is-active"), "不可用页面上的创意仍由原按钮禁用，不绕过平台限制");
    }
    document.querySelector('.sv-nav-item[data-sv-view="settings"]').click();
    document.querySelector(".sv-settings-entry").click();
    assert($("monitorTab").classList.contains("is-active") && document.querySelector('[data-sv-view="settings"]').getAttribute("aria-current") === "page", "设置入口打开原监控页，设置导航保持选中");
    document.querySelector(".sv-monitor-back").click();
    assert($("settingsTab").classList.contains("is-active"), "监控可返回设置主页");
    document.querySelector('.sv-nav-item[data-sv-view="capture"]').click();
    assert($("searchTab").classList.contains("is-active"), "离开监控后采集返回原搜索页，不误回监控");
    const checkbox = $("chkSearchBatchMode");
    const previous = checkbox.checked;
    document.querySelector(`input[name="sv-search-source"][value="${previous ? "current" : "batch"}"]`).click();
    assert(checkbox.checked !== previous, "单选来源调用原有批量开关");
    checkbox.click();
    const valueInput = $("inputKeywordMaxDetectedItems");
    const previousValue = valueInput.value;
    valueInput.value = "73";
    // Navigation refreshes the pool asynchronously even in the real renderer.
    // Await the fixture's in-memory refresh before reading the new group DOM.
    await state.refreshDataPool();
    const keywordGroups = [...document.querySelectorAll('[data-pool-group^="keyword:"]')];
    if (scenario === "keywords") {
      assert(keywordGroups.length === 3 && keywordGroups.map(group => group.querySelectorAll(".data-item").length).join(",") === "2,1,1", "三个关键词分组及各组逐条内容完整保留");
      keywordGroups[0].querySelector(".btn-pool-group-toggle").click();
      assert(keywordGroups[0].classList.contains("is-collapsed") && keywordGroups[0].querySelector("button").getAttribute("aria-expanded") === "false" && keywordGroups.slice(1).every(group => !group.classList.contains("is-collapsed")), "单组收起沿用原事件，不影响其他关键词组");
    }
    adapter.unmount();
    assert(valueInput.value === "73", "切回经典界面保留编辑中的输入");
    assert($("textareaBatchBloggers").value === "https://example.org/preserved-ui-draft", "切回经典界面保留原批量博主草稿");
    $("textareaBatchBloggers").value = originalBloggerDraft;
    valueInput.value = previousValue;
    assert(initial.every(x => x.el.parentNode === x.parent && x.el.isConnected), "卸载后原控件父节点完整恢复");
    assert(batchOriginals.every(x => x.el.parentNode === x.parent && x.el.className === x.className && x.el.textContent === x.text) && !document.querySelector(".sv-batch-entry, .sv-batch-input-hint") && document.querySelector("#batchPaneBloggers .form-label").textContent === bloggerLabelText && $("textareaBatchBloggers").getAttribute("placeholder") === bloggerPlaceholder && $("textareaBatchBloggers").getAttribute("aria-describedby") === bloggerDescription, "经典版恢复两个原批量入口、按钮样式及文案，不残留新版辅助节点");
    assert(menuSnapshot.every((x, index) => $("dropdownMoreMenu").children[index] === x.el && x.el.getAttribute("role") === x.role && x.el.getAttribute("href") === x.href && x.el.className === x.className) && !document.querySelector(".header-actions").hidden && headerChildren.every((el, index) => document.querySelector(".header-top").children[index] === el), "经典菜单条目、链接、角色、顺序及平台原位置完整恢复");
    if (scenario === "keywords") {
      assert(keywordGroups[0].classList.contains("is-collapsed") && keywordGroups.every(group => group.isConnected), "新旧界面切换保留关键词折叠状态和原结果节点");
      keywordGroups[0].querySelector(".btn-pool-group-toggle").click();
    }
    assert(!document.querySelector(".sv-bottom-nav") && !document.querySelector(".sv-disclosure"), "新版增加的界面节点全部撤回");
    assert(!document.querySelector(".sv-top-nav, .sv-settings-entry, .sv-monitor-header, .sv-settings-links, .sv-auth-acquire") && $("searchSingleKeywordGroup").contains(strategy) && !strategy.hasAttribute("data-sv-view") && !strategy.hasAttribute("aria-current") && strategyTitle.textContent.trim() === "赛道策略" && $("keywordStrategyModalOverlay").parentNode === document.body && $("keywordStrategyModalOverlay").querySelector('[role="dialog"][aria-modal="true"]'), "经典版完整恢复原策略入口、标题、弹窗及监控布局，不遗留新版导航属性");
    assert(listeners.size === 0, "切回后没有遗留状态订阅");
    for (let index = 0; index < 5; index++) { adapter = mountNextUI({document, window, state: testState}); adapter.unmount(); }
    assert(listeners.size === 0 && document.querySelectorAll(".sv-bottom-nav").length === 0, "连续切换五次没有重复导航或订阅");
    const brokenDocument = new Proxy(document, {get(target, prop) {if (prop === "getElementById") return id => id === "mainPoolPanel" ? null : target.getElementById(id); const value = target[prop]; return typeof value === "function" ? value.bind(target) : value;}});
    let failed = false;
    try { mountNextUI({document: brokenDocument, window, state: testState}); } catch { failed = true; }
    assert(failed && !document.documentElement.classList.contains("sv-next"), "缺少必要结构时安全回退");
    document.removeEventListener("change", count);
    assert(errorLog.length === 0, `无浏览器运行错误（${errorLog.length}）`);
    report(results.join("\n") + "\n\n检查完成；当前为经典界面。真实采集需在空闲测试节点验收。");
  } catch (error) { report(results.join("\n") + "\n失败 · " + error.message); }
});
